import * as fs from 'fs';
import { initDB } from '../../../src/storage/db';
import { migrate } from '../../../src/storage/migrations';
import { CharacterRepository } from '../../../src/storage/repos/character.repo';
import { ProviderFactory } from '../../../src/agent/provider/factory';
import { OpenAIProvider, REASONING_COMPLETION_FLOOR } from '../../../src/agent/provider/openai';
import { LLMProvider, ProviderCallResult, ProviderError } from '../../../src/agent/provider/types';
import { invokeAgent } from '../../../src/agent/runtime/invoke';
import { buildAgentRuntime } from '../../../src/agent/runtime/deps';
import { Character } from '../../../src/schema/character';
import { FIXED_TIMESTAMP } from '../../fixtures.js';

const TEST_DB = 'test-invoke.db';

function cleanup() {
    for (const s of ['', '-wal', '-shm']) {
        const p = TEST_DB + s;
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
}

function char(id: string, overrides: Partial<Character> = {}): Character {
    return {
        id,
        name: 'Kara',
        stats: { str: 12, dex: 17, con: 14, int: 10, wis: 14, cha: 12 },
        hp: 30,
        maxHp: 45,
        ac: 16,
        level: 5,
        characterType: 'pc',
        characterClass: 'ranger',
        race: 'Half-Elf',
        createdAt: FIXED_TIMESTAMP,
        updatedAt: FIXED_TIMESTAMP,
        ...overrides
    } as Character;
}

/** Provider mock that lets each test script the response. */
function fakeProvider(impl: (opts: { model: string; messages: unknown[]; reasoningEffort?: unknown }) => Promise<ProviderCallResult>): LLMProvider {
    return {
        name: 'openai',
        call: async (opts) => impl({
            model: opts.model,
            messages: opts.messages,
            reasoningEffort: (opts as any).reasoningEffort
        })
    };
}

describe('invokeAgent', () => {
    let db: ReturnType<typeof initDB>;
    let factory: ProviderFactory;
    let deps: ReturnType<typeof buildAgentRuntime>;

    beforeEach(() => {
        cleanup();
        db = initDB(TEST_DB);
        migrate(db);
        factory = new ProviderFactory();
        deps = buildAgentRuntime(db, factory);
    });

    afterEach(() => {
        db.close();
        cleanup();
    });

    function setupAgent(opts: Partial<{
        budgetTokens: number | null;
        status: 'active' | 'paused';
        circuitState: 'closed' | 'open' | 'half_open';
        consecutiveFailures: number;
        characterInt: number;
        competencyOverride: { model?: string; reasoningEffort?: string | null };
        provider: 'openai' | 'openrouter';
    }> = {}) {
        const chars = new CharacterRepository(db);
        chars.create(char('char-1', opts.characterInt === undefined ? {} : {
            stats: { str: 12, dex: 17, con: 14, int: opts.characterInt, wis: 14, cha: 12 }
        }));
        const createInput = {
            characterId: 'char-1',
            provider: opts.provider ?? 'openai',
            model: 'gpt-4o-mini',
            budgetTokens: opts.budgetTokens ?? null,
            competencyOverride: opts.competencyOverride
        };
        const agent = deps.agentRepo.create(createInput as any);
        if (opts.status || opts.circuitState || opts.consecutiveFailures !== undefined) {
            deps.agentRepo.update(agent.id, {
                status: opts.status,
                circuitState: opts.circuitState,
                consecutiveFailures: opts.consecutiveFailures
            });
        }
        return deps.agentRepo.findById(agent.id)!;
    }

    // ───────── happy path ─────────

    it('returns the provider text on success and records a call', async () => {
        const agent = setupAgent();
        factory.register('openai', fakeProvider(async () => ({
            text: 'Kara nocks an arrow. I attack the orc with my longbow.',
            promptTokens: 100,
            completionTokens: 20,
            raw: '{"choices":[{"message":{"content":"x"}}]}',
            durationMs: 250,
            finishReason: 'stop'
        })));

        const result = await invokeAgent({ agentId: agent.id, situation: "It's your turn." }, deps);

        expect(result.status).toBe('ok');
        expect(result.response).toContain('Kara nocks an arrow');
        expect(result.promptTokens).toBe(100);
        expect(result.completionTokens).toBe(20);
        expect(result.characterName).toBe('Kara');
        expect(result.callId).toBeTruthy();
    });

    it('derives provider model and reasoning effort from character INT', async () => {
        const agent = setupAgent({ characterInt: 18 });
        let observedModel = '';
        let observedReasoningEffort: unknown;
        factory.register('openai', fakeProvider(async ({ model, reasoningEffort }) => {
            observedModel = model;
            observedReasoningEffort = reasoningEffort;
            return { text: 'I reason through the pressure points.', raw: '{}', durationMs: 1 };
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('ok');
        expect(observedModel).toBe('gpt-5.5');
        expect(observedReasoningEffort).toBe('high');
        const call = deps.agentRepo.findCallById(result.callId!) as any;
        expect(call.model).toBe('gpt-5.5');
        expect(call.reasoningEffort).toBe('high');
        expect(call.competencySource).toBe('stat_derived');
    });

    it('sends effort "none" at INT 1–6 and audits it; no reasoning floor gates a small budget', async () => {
        const agent = setupAgent({ characterInt: 4, budgetTokens: 1000 });
        let observedReasoningEffort: unknown;
        factory.register('openai', fakeProvider(async ({ reasoningEffort }) => {
            observedReasoningEffort = reasoningEffort;
            return { text: 'Grug see door.', raw: '{}', durationMs: 1 };
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('ok');
        expect(observedReasoningEffort).toBe('none');
        expect(result.reasoningEffort).toBe('none');
        const call = deps.agentRepo.findCallById(result.callId!) as any;
        expect(call.model).toBe('gpt-5.5');
        expect(call.reasoningEffort).toBe('none');
    });

    // A model-only override inherits the ladder's effort. The active ladder's
    // 'none' (INT 1–6) and 'xhigh' (INT 19–20) must not reach an older
    // reasoning model that rejects them: HTTP 400 on every invoke, then an open
    // circuit. Asserted on the real OpenAI request body.
    describe('model-only override on an older reasoning model (OpenAI request body)', () => {
        function captureOpenAIBodies(): Record<string, unknown>[] {
            const bodies: Record<string, unknown>[] = [];
            factory.register('openai', new OpenAIProvider({
                apiKey: 'sk-test',
                fetchImpl: async (_url, init) => {
                    bodies.push(JSON.parse(init!.body as string));
                    return new Response(JSON.stringify({ choices: [{ message: { content: 'Grug see door.' } }] }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            }));
            return bodies;
        }

        it.each(['gpt-5-nano', 'gpt-5-mini', 'o3'])(
            'INT 4 + {model: "%s"} sends no "none" and keeps the default completion floor',
            async (model) => {
                const agent = setupAgent({ characterInt: 4, competencyOverride: { model } });
                const bodies = captureOpenAIBodies();

                const result = await invokeAgent({ agentId: agent.id }, deps);

                expect(result.status).toBe('ok');
                expect(bodies[0].model).toBe(model);
                expect(bodies[0]).not.toHaveProperty('reasoning_effort');
                expect(bodies[0].max_completion_tokens).toBeGreaterThanOrEqual(REASONING_COMPLETION_FLOOR.medium);
                expect(result.reasoningEffort).toBeNull();
                expect(deps.agentRepo.findCallById(result.callId!)!.reasoningEffort).toBeNull();
            }
        );

        it.each(['o3', 'gpt-5-mini'])('INT 19 + {model: "%s"} sends "high", not "xhigh"', async (model) => {
            const agent = setupAgent({ characterInt: 19, competencyOverride: { model } });
            const bodies = captureOpenAIBodies();

            const result = await invokeAgent({ agentId: agent.id }, deps);

            expect(result.status).toBe('ok');
            expect(bodies[0].reasoning_effort).toBe('high');
            expect(deps.agentRepo.findCallById(result.callId!)!.reasoningEffort).toBe('high');
        });

        it('still sends "none" to an override model that accepts it', async () => {
            const agent = setupAgent({ characterInt: 4, competencyOverride: { model: 'gpt-5.1' } });
            const bodies = captureOpenAIBodies();

            const result = await invokeAgent({ agentId: agent.id }, deps);

            expect(result.status).toBe('ok');
            expect(bodies[0].reasoning_effort).toBe('none');
        });
    });

    it('uses per-agent competency override and audits the override source', async () => {
        const agent = setupAgent({
            characterInt: 10,
            competencyOverride: { model: 'gpt-5.5', reasoningEffort: 'xhigh' }
        });
        let observedModel = '';
        let observedReasoningEffort: unknown;
        factory.register('openai', fakeProvider(async ({ model, reasoningEffort }) => {
            observedModel = model;
            observedReasoningEffort = reasoningEffort;
            return { text: 'override active', raw: '{}', durationMs: 1 };
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('ok');
        expect(observedModel).toBe('gpt-5.5');
        expect(observedReasoningEffort).toBe('xhigh');
        const call = deps.agentRepo.findCallById(result.callId!) as any;
        expect(call.competencySource).toBe('override');
    });

    it('namespaces a bare ladder id for OpenRouter and audits the id actually requested', async () => {
        const agent = setupAgent({ provider: 'openrouter', characterInt: 12 });
        let observedModel = '';
        factory.register('openrouter', fakeProvider(async ({ model }) => {
            observedModel = model;
            return { text: 'routed', raw: '{}', durationMs: 1, model: 'openai/gpt-5.5' };
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('ok');
        expect(observedModel).toBe('openai/gpt-5.5');
        expect(result.requestedModel).toBe('openai/gpt-5.5');
        const call = deps.agentRepo.findCallById(result.callId!)!;
        expect(call.provider).toBe('openrouter');
        expect(call.model).toBe('openai/gpt-5.5');
        expect(call.reasoningEffort).toBe('medium');
    });

    it('does not double-prefix an OpenRouter id that is already namespaced', async () => {
        const agent = setupAgent({
            provider: 'openrouter',
            competencyOverride: { model: 'openai/gpt-5.6-luna', reasoningEffort: 'medium' }
        });
        let observedModel = '';
        factory.register('openrouter', fakeProvider(async ({ model }) => {
            observedModel = model;
            return { text: 'routed', raw: '{}', durationMs: 1 };
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('ok');
        expect(observedModel).toBe('openai/gpt-5.6-luna');
        expect(deps.agentRepo.findCallById(result.callId!)!.model).toBe('openai/gpt-5.6-luna');
    });

    it('sends bare ladder ids to OpenAI unchanged', async () => {
        const agent = setupAgent({ characterInt: 12 });
        let observedModel = '';
        factory.register('openai', fakeProvider(async ({ model }) => {
            observedModel = model;
            return { text: 'direct', raw: '{}', durationMs: 1 };
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(observedModel).toBe('gpt-5.5');
        expect(deps.agentRepo.findCallById(result.callId!)!.model).toBe('gpt-5.5');
    });

    // ───────── requested vs served model (FINDINGS #69) ─────────

    it('reports the served model from the provider response alongside the requested one', async () => {
        const agent = setupAgent({ characterInt: 12 });
        factory.register('openai', fakeProvider(async () => ({
            text: 'served', raw: '{}', durationMs: 1, model: 'gpt-5.5-2026-04-23'
        })));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('ok');
        expect(result.requestedModel).toBe('gpt-5.5');
        expect(result.servedModel).toBe('gpt-5.5-2026-04-23');
    });

    it('leaves servedModel null when the provider does not report one (never assumes the request)', async () => {
        const agent = setupAgent({ characterInt: 12 });
        factory.register('openai', fakeProvider(async () => ({ text: 'quiet gateway', raw: '{}', durationMs: 1 })));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('ok');
        expect(result.requestedModel).toBe('gpt-5.5');
        expect(result.servedModel).toBeNull();
    });

    it('keeps requested/served model and competency on a response that crossed the budget', async () => {
        const agent = setupAgent({ budgetTokens: 1000, competencyOverride: { model: 'gpt-4.1' } });
        factory.register('openai', fakeProvider(async () => ({
            text: 'too expensive', promptTokens: 800, completionTokens: 250, raw: '{}', durationMs: 1, model: 'gpt-4.1-2025-04-14'
        })));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('budget_exhausted');
        expect(result.requestedModel).toBe('gpt-4.1');
        expect(result.servedModel).toBe('gpt-4.1-2025-04-14');
        expect(result.competencySource).toBe('override');
        expect(result.reasoningEffort).toBe('low');
    });

    it('reports the requested model on provider failure, and the served one when the error body names it', async () => {
        const agent = setupAgent({ characterInt: 12 });
        factory.register('openai', fakeProvider(async () => {
            throw new ProviderError('empty content', 'malformed', 200, JSON.stringify({
                model: 'gpt-5.5-2026-04-23',
                choices: [{ message: { content: '' }, finish_reason: 'length' }]
            }));
        }));

        const withBody = await invokeAgent({ agentId: agent.id }, deps);
        expect(withBody.status).toBe('error');
        expect(withBody.requestedModel).toBe('gpt-5.5');
        expect(withBody.servedModel).toBe('gpt-5.5-2026-04-23');

        factory.register('openai', fakeProvider(async () => {
            throw new ProviderError('timed out', 'timeout');
        }));
        const noBody = await invokeAgent({ agentId: agent.id }, deps);
        expect(noBody.status).toBe('timeout');
        expect(noBody.requestedModel).toBe('gpt-5.5');
        expect(noBody.servedModel).toBeNull();
    });

    it('increments tokens_used after a successful call', async () => {
        const agent = setupAgent();
        factory.register('openai', fakeProvider(async () => ({
            text: 'ok', promptTokens: 100, completionTokens: 50, raw: '{}', durationMs: 1
        })));

        await invokeAgent({ agentId: agent.id }, deps);

        const updated = deps.agentRepo.findById(agent.id)!;
        expect(updated.tokensUsed).toBe(150);
    });

    // The two post-hoc budget tests pin a non-reasoning model so the preflight
    // reasoning-floor gate (covered separately below) cannot pre-empt the call.
    it('does not report a provider response as successful when it crosses a hard budget', async () => {
        const agent = setupAgent({ budgetTokens: 1000, competencyOverride: { model: 'gpt-4.1' } });
        factory.register('openai', fakeProvider(async () => ({
            text: 'too expensive', promptTokens: 800, completionTokens: 250, raw: '{}', durationMs: 1
        })));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('budget_exhausted');
        expect(result.response).toBe('');
        expect(deps.agentRepo.findById(agent.id)!.tokensUsed).toBe(1050);
        expect(deps.agentRepo.findCallById(result.callId!)!.status).toBe('budget_exhausted');
        expect(deps.agentRepo.listJournal(agent.id)).toHaveLength(0);
    });

    it('treats exact budget consumption as exhausted and clears stale circuit failures', async () => {
        const agent = setupAgent({
            budgetTokens: 1000,
            circuitState: 'half_open',
            consecutiveFailures: 2,
            competencyOverride: { model: 'gpt-4.1' }
        });
        factory.register('openai', fakeProvider(async () => ({
            text: 'exactly at the limit', promptTokens: 400, completionTokens: 600, raw: '{}', durationMs: 1
        })));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('budget_exhausted');
        expect(deps.agentRepo.findCallById(result.callId!)!.status).toBe('budget_exhausted');
        expect(deps.agentRepo.findById(agent.id)!.consecutiveFailures).toBe(0);
        expect(deps.agentRepo.findById(agent.id)!.circuitState).toBe('closed');
    });

    it('does not call a reasoning provider when the remaining budget cannot fund its floor', async () => {
        const agent = setupAgent({
            budgetTokens: 5000,
            competencyOverride: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' }
        });
        let called = false;
        factory.register('openai', fakeProvider(async () => {
            called = true;
            return { text: 'should not run', raw: '{}', durationMs: 1 };
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(called).toBe(false);
        expect(result.status).toBe('budget_exhausted');
        expect(result.reason).toContain('cannot fund the reasoning completion floor');
        expect(deps.agentRepo.findCallById(result.callId!)!.status).toBe('budget_exhausted');
    });
    it('appends a journal entry of kind=response on success', async () => {
        const agent = setupAgent();
        factory.register('openai', fakeProvider(async () => ({
            text: "I attack the orc.", raw: '{}', durationMs: 1
        })));

        await invokeAgent({
            agentId: agent.id,
            situation: 'go',
            encounterId: 'enc-1',
            round: 3
        }, deps);

        const journal = deps.agentRepo.listJournal(agent.id);
        expect(journal.length).toBe(1);
        expect(journal[0].kind).toBe('response');
        expect(journal[0].content).toBe('I attack the orc.');
        expect(journal[0].encounterId).toBe('enc-1');
        expect(journal[0].round).toBe(3);
    });

    it('looks up agent by characterId when agentId not given', async () => {
        setupAgent();
        factory.register('openai', fakeProvider(async () => ({
            text: 'fine', raw: '{}', durationMs: 1
        })));

        const result = await invokeAgent({ characterId: 'char-1' }, deps);
        expect(result.status).toBe('ok');
    });

    // ───────── preflight skip paths ─────────

    it('returns paused status without calling the provider when agent is paused', async () => {
        const agent = setupAgent({ status: 'paused' });
        let called = false;
        factory.register('openai', fakeProvider(async () => {
            called = true;
            return { text: 'should not run', raw: '{}', durationMs: 1 };
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(called).toBe(false);
        expect(result.status).toBe('paused');
        expect(result.reason).toBe('agent_paused');
        expect(result.callId).toBeTruthy(); // call row still recorded for audit
    });

    it('returns circuit_open status without calling the provider', async () => {
        const agent = setupAgent({ circuitState: 'open', consecutiveFailures: 3 });
        let called = false;
        factory.register('openai', fakeProvider(async () => {
            called = true;
            return { text: '', raw: '{}', durationMs: 1 };
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(called).toBe(false);
        expect(result.status).toBe('circuit_open');
    });

    it('returns budget_exhausted status without calling the provider', async () => {
        const agent = setupAgent({ budgetTokens: 100 });
        deps.agentRepo.incrementTokensUsed(agent.id, 100);

        let called = false;
        factory.register('openai', fakeProvider(async () => {
            called = true;
            return { text: '', raw: '{}', durationMs: 1 };
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(called).toBe(false);
        expect(result.status).toBe('budget_exhausted');
    });

    it('returns incapable status when character HP is 0', async () => {
        const agent = setupAgent();
        // Drop character to 0 HP via repo
        const chars = new CharacterRepository(db);
        chars.update('char-1', { hp: 0 });

        let called = false;
        factory.register('openai', fakeProvider(async () => {
            called = true;
            return { text: '', raw: '{}', durationMs: 1 };
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(called).toBe(false);
        expect(result.status).toBe('incapable');
        expect(result.reason).toContain('hp_zero');
    });

    it('returns error when agent not found', async () => {
        const result = await invokeAgent({ agentId: 'nope' }, deps);
        expect(result.status).toBe('error');
        expect(result.reason).toBe('agent_not_found');
    });

    it('returns error when provider has no credentials', async () => {
        const agent = setupAgent();
        // Don't register a provider.

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('error');
        expect(result.reason).toContain('OPENAI_API_KEY');
    });

    // ───────── failure paths + circuit ─────────

    it('records timeout status when provider throws timeout', async () => {
        const agent = setupAgent();
        factory.register('openai', fakeProvider(async () => {
            throw new ProviderError('timed out', 'timeout');
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);

        expect(result.status).toBe('timeout');
        const updated = deps.agentRepo.findById(agent.id)!;
        expect(updated.consecutiveFailures).toBe(1);
    });

    it('records rate_limited status', async () => {
        const agent = setupAgent();
        factory.register('openai', fakeProvider(async () => {
            throw new ProviderError('429', 'rate_limited');
        }));

        const result = await invokeAgent({ agentId: agent.id }, deps);
        expect(result.status).toBe('rate_limited');
    });

    it('opens circuit after 3 consecutive failures', async () => {
        const agent = setupAgent();
        factory.register('openai', fakeProvider(async () => {
            throw new ProviderError('timeout', 'timeout');
        }));

        await invokeAgent({ agentId: agent.id }, deps);
        await invokeAgent({ agentId: agent.id }, deps);
        await invokeAgent({ agentId: agent.id }, deps);

        const updated = deps.agentRepo.findById(agent.id)!;
        expect(updated.consecutiveFailures).toBe(3);
        expect(updated.circuitState).toBe('open');

        // 4th invoke is short-circuited
        const next = await invokeAgent({ agentId: agent.id }, deps);
        expect(next.status).toBe('circuit_open');
    });

    it('does NOT trip circuit on auth errors', async () => {
        const agent = setupAgent();
        factory.register('openai', fakeProvider(async () => {
            throw new ProviderError('401', 'auth');
        }));

        await invokeAgent({ agentId: agent.id }, deps);
        await invokeAgent({ agentId: agent.id }, deps);

        const updated = deps.agentRepo.findById(agent.id)!;
        expect(updated.consecutiveFailures).toBe(0);
        expect(updated.circuitState).toBe('closed');
    });

    it('closes circuit on success after prior failures', async () => {
        const agent = setupAgent();
        let calls = 0;
        factory.register('openai', fakeProvider(async () => {
            calls++;
            if (calls < 2) throw new ProviderError('timeout', 'timeout');
            return { text: 'recovered', raw: '{}', durationMs: 1 };
        }));

        await invokeAgent({ agentId: agent.id }, deps);
        const after1 = deps.agentRepo.findById(agent.id)!;
        expect(after1.consecutiveFailures).toBe(1);

        await invokeAgent({ agentId: agent.id }, deps);
        const after2 = deps.agentRepo.findById(agent.id)!;
        expect(after2.consecutiveFailures).toBe(0);
        expect(after2.circuitState).toBe('closed');
    });

    // ───────── overrides ─────────

    it('passes systemOverride through to the provider', async () => {
        const agent = setupAgent();
        let captured: unknown[] = [];
        factory.register('openai', fakeProvider(async ({ messages }) => {
            captured = messages;
            return { text: 'ok', raw: '{}', durationMs: 1 };
        }));

        await invokeAgent({
            agentId: agent.id,
            situation: 'GO',
            systemOverride: 'CUSTOM_SYSTEM_FROM_DM'
        }, deps);

        const sysMsg = captured.find((m): m is { role: string; content: string } => (m as { role: string }).role === 'system');
        expect(sysMsg!.content).toContain('CUSTOM_SYSTEM_FROM_DM');
    });

    it('passes messagesOverride through to the provider', async () => {
        const agent = setupAgent();
        let captured: unknown[] = [];
        factory.register('openai', fakeProvider(async ({ messages }) => {
            captured = messages;
            return { text: 'ok', raw: '{}', durationMs: 1 };
        }));

        await invokeAgent({
            agentId: agent.id,
            messagesOverride: [
                { role: 'system', content: 'SYS_OVERRIDE' },
                { role: 'user', content: 'USR_OVERRIDE' }
            ]
        }, deps);

        expect(captured.length).toBe(2);
        expect((captured[0] as { content: string }).content).toBe('SYS_OVERRIDE');
        expect((captured[1] as { content: string }).content).toBe('USR_OVERRIDE');
    });
});
