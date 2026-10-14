/**
 * Play report 7, item 6: the PC turn guard and the stale economy.
 *
 * Blackcrown, Day 89: the GM advanced past Kael's slot before the player had
 * done anything, then ran the late swing during the next creature's turn,
 * and the engine said 'Action already used this turn' with nothing saying
 * the turn had ended. Now:
 *  - combat_manage advance refuses to pass a living player character whose
 *    turn is untouched (no action, bonus action, movement or other combat
 *    action this turn): TURN NOT TAKEN, writes: 'none', with the call that
 *    passes it (confirm: true, alias skipTurn: true). A confirmed skip says so
 *    (skippedTurn, a ⏭ line) and is logged.
 *  - Free passes: LAIR, HP 0 (DEATH SAVE DUE keeps precedence), incapacitated,
 *    enemies, npc rows, sheetless tokens, agent-driven tokens, surprised slots;
 *    a world opts out with environment.pcTurnGuard: 'off'.
 *  - Stale economy: a prompt-mode natural 20 on the slot that is up, and
 *    remove_participant of the current actor, run the new actor's turn start.
 *  - Off-turn clarity: offTurn in the action JSON, and the off-turn economy
 *    refusal says the actor's turn has ended.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { schemaShape } from '../../src/server/schema-shape.js';
import { withSession } from '../../src/server/types.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { turnUntouched } from '../../src/engine/combat/turn-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { shapeReply } from '../../src/server/output-mode.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { AgentRepository } from '../../src/storage/repos/agent.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

process.env.NODE_ENV = 'test';

type P = CombatParticipant & Record<string, unknown>;
const ctx = { sessionId: 'pc-turn-guard' };
const W = 'blackcrown';
const now = () => new Date().toISOString();
const embedded = (res: any, tag: string) => {
    const text = res.content[0].text as string;
    const m = text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? { ...JSON.parse(m[1]), text } : { rawText: text, text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction({ encounterId: enc, ...args }, ctx as any), 'COMBAT_ACTION');

let enc: string;
const repo = () => new CharacterRepository(getDb());
const mk = (id: string, extra: Record<string, unknown> = {}) => repo().create({
    id, name: id[0].toUpperCase() + id.slice(1), stats: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
    hp: 20, maxHp: 20, ac: 12, level: 3, createdAt: now(), updatedAt: now(), ...extra
} as any);
const stored = () => new EncounterRepository(getDb()).loadState(enc)!;
const tok = (id: string) => stored().participants.find((p: P) => p.id === id)! as P;
const currentId = () => { const s = stored(); return s.turnOrder[s.currentTurnIndex]; };
const setToken = (id: string, patch: Record<string, unknown>) => {
    const r = new EncounterRepository(getDb());
    const st = r.loadState(enc)!;
    Object.assign(st.participants.find((p: P) => p.id === id)!, patch);
    r.saveState(enc, st);
    clearCombatState();
};
const skipLog = () => getDb().prepare("SELECT * FROM combat_action_log WHERE encounter_id = ? AND action_type = 'skip_turn'").all(enc) as any[];

/** Kael (pc row, init 20) is up first; Gor (sheetless enemy, init 10) stands next to him. */
const start = async (kael: Record<string, unknown> = {}, more: Array<Record<string, unknown>> = [], opts: Record<string, unknown> = {}) => {
    const created = await manage({ action: 'create', seed: 'pc-turn-guard', worldId: W, participants: [
        { id: 'kael', name: 'Kael', hp: 20, maxHp: 20, ac: 12, initiative: 20, position: { x: 0, y: 0 }, ...kael },
        { id: 'gor', name: 'Gor', hp: 30, maxHp: 30, ac: 10, initiative: 10, isEnemy: true, position: { x: 1, y: 0 } },
        ...more
    ], ...opts });
    enc = created.encounterId;
    return created;
};

beforeEach(() => {
    closeDb(); getDb(':memory:'); clearCombatState();
    new WorldRepository(getDb()).create({ id: W, name: 'Blackcrown', seed: 's', width: 10, height: 10, createdAt: now(), updatedAt: now(), environment: { day: 89, time: '06:00' } } as any);
    mk('kael');
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('turnUntouched', () => {
    const p = (over: Partial<P> = {}) => ({ id: 'k', name: 'K', initiativeBonus: 0, hp: 10, maxHp: 10, conditions: [], ...over }) as P;
    it('a fresh token is untouched; any spend or logged action touches it; a readied action alone does not', () => {
        expect(turnUntouched(p())).toBe(true);
        expect(turnUntouched(p({ readied: { action: 'attack', trigger: 'an orc comes close' } } as any))).toBe(true);
        for (const over of [{ actionUsed: true }, { bonusActionUsed: true }, { attacksMade: 1 }, { movedThisTurn: 5 }, { dashes: 1 }, { hasDisengaged: true }, { extraActions: 1 }, { spellsCast: { bonus: 0 } }, { actedThisTurn: true }] as Array<Partial<P>>) {
            expect(turnUntouched(p(over))).toBe(false);
        }
    });

    it('the turn start clears actedThisTurn with the rest of the economy', () => {
        const e = new CombatEngine('touched');
        e.startEncounter([p({ id: 'a', name: 'A', initiative: 20 }), p({ id: 'b', name: 'B', initiative: 10 })]);
        e.markActed('a');
        expect(e.getState()!.participants.find(x => x.id === 'a')!.actedThisTurn).toBe(true);
        e.nextTurnWithConditions();
        e.nextTurnWithConditions();
        expect(e.getState()!.participants.find(x => x.id === 'a')!.actedThisTurn).toBe(false);
    });
});

describe('TURN NOT TAKEN', () => {
    it('an untouched player character refuses advance; nothing is written', async () => {
        await start();
        const r = await manage({ action: 'advance', encounterId: enc });
        expect(r.error).toBe(true);
        expect(r.writes).toBe('none');
        expect(r.message).toMatch(/TURN NOT TAKEN: Kael \(player character\) has used no action, bonus action or movement this turn\. advance refused; nothing was written\./);
        expect(r.message).toContain(`combat_manage advance {encounterId: '${enc}', confirm: true}`);
        expect(r.turnNotTaken).toEqual({ participantId: 'kael', name: 'Kael', round: 1 });
        expect(r.confirmCall).toBe(`combat_manage advance {encounterId: '${enc}', confirm: true}`);
        expect(currentId()).toBe('kael');
        expect(stored().round).toBe(1);
        expect(skipLog()).toHaveLength(0);
    });

    it('output_mode summary keeps the refusal, who it holds and the exact call that passes the turn', async () => {
        await start();
        const res = shapeReply(await handleCombatManage({ action: 'advance', encounterId: enc }, ctx as any), { mode: 'summary' });
        const summary = JSON.parse(res.content[0].text);
        expect(summary.error).toBe(true);
        expect(summary.writes).toBe('none');
        expect(summary.turnNotTaken).toMatchObject({ participantId: 'kael', name: 'Kael' });
        expect(summary.confirmCall).toBe(`combat_manage advance {encounterId: '${enc}', confirm: true}`);
    });

    it('confirm: true passes the turn: skippedTurn, a ⏭ line and a log row', async () => {
        await start();
        const r = await manage({ action: 'advance', encounterId: enc, confirm: true });
        expect(r.error).toBeUndefined();
        expect(r.currentTurn.id).toBe('gor');
        expect(r.skippedTurn).toEqual({ participantId: 'kael', name: 'Kael', round: 1 });
        expect(r.rawText).toMatch(/⏭ TURN PASSED: Kael \(player character\) took no action, bonus action or movement/);
        expect(skipLog()).toHaveLength(1);
        expect(skipLog()[0]).toMatchObject({ actor_id: 'GM', round: 1 });
        expect(JSON.parse(skipLog()[0].target_ids)).toEqual(['kael']);
    });

    it('skipTurn: true is the same call', async () => {
        await start();
        const r = await manage({ action: 'advance', encounterId: enc, skipTurn: true });
        expect(r.error).toBeUndefined();
        expect(r.skippedTurn).toMatchObject({ participantId: 'kael' });
        expect(currentId()).toBe('gor');
    });

    it('confirm on a turn that was taken passes it without a skip', async () => {
        await start();
        await act({ action: 'move', actorId: 'kael', targetPosition: { x: 0, y: 1 } });
        const r = await manage({ action: 'advance', encounterId: enc, confirm: true });
        expect(r.error).toBeUndefined();
        expect(r.skippedTurn).toBeUndefined();
        expect(skipLog()).toHaveLength(0);
    });

    const touches: Array<[string, Record<string, unknown>, 'action' | 'manage']> = [
        ['a move', { action: 'move', actorId: 'kael', targetPosition: { x: 0, y: 1 } }, 'action'],
        ['an attack', { action: 'attack', actorId: 'kael', targetId: 'gor', outcome: 'miss' }, 'action'],
        ['a bonus-action attack', { action: 'attack', actorId: 'kael', targetId: 'gor', outcome: 'miss', bonusAction: true }, 'action'],
        ['a dash', { action: 'dash', actorId: 'kael' }, 'action'],
        ['a disengage', { action: 'disengage', actorId: 'kael' }, 'action'],
        ['a dodge', { action: 'dodge', actorId: 'kael' }, 'action'],
        ['a ready', { action: 'ready', actorId: 'kael', readiedAction: 'attack', trigger: 'Gor moves' }, 'action'],
        ['a free battle cry', { action: 'battle_cry', participantId: 'kael', name: 'For Blackcrown!', attackAdvantage: true, actionCost: 'none' }, 'manage']
    ];
    it.each(touches)('after %s, advance passes without confirm', async (_label, call, tool) => {
        await start();
        const done = tool === 'action' ? await act(call) : await manage({ encounterId: enc, ...call });
        expect(done.error).toBeUndefined();
        const r = await manage({ action: 'advance', encounterId: enc });
        expect(r.error).toBeUndefined();
        expect(r.currentTurn.id).toBe('gor');
        expect(r.skippedTurn).toBeUndefined();
    });

    it('a free ability (actionCost none) counts as acting', async () => {
        await start({ abilities: [{ name: 'Battle Focus', actionCost: 'none' }] });
        const used = await manage({ action: 'use_ability', encounterId: enc, participantId: 'kael', ability: 'Battle Focus' });
        expect(used.error).toBeUndefined();
        expect((await manage({ action: 'advance', encounterId: enc })).currentTurn.id).toBe('gor');
    });

    it('a theatre-of-mind placement counts as movement', async () => {
        await start({ position: undefined });
        expect(tok('kael').position).toBeUndefined();
        const placed = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 3, y: 3 } });
        expect(placed.error).toBeUndefined();
        expect((await manage({ action: 'advance', encounterId: enc })).currentTurn.id).toBe('gor');
    });

    it('a move refused before a step (destination blocked) does not count', async () => {
        await start();
        const blocked = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 1, y: 0 } });
        expect(blocked.actionResult?.success).toBe(false);
        expect(tok('kael').position).toMatchObject({ x: 0, y: 0 });
        const r = await manage({ action: 'advance', encounterId: enc });
        expect(r.error).toBe(true);
        expect(r.message).toMatch(/TURN NOT TAKEN: Kael/);
    });

    it('a readied action from an earlier turn does not count', async () => {
        await start();
        await act({ action: 'ready', actorId: 'kael', readiedAction: 'attack', trigger: 'Gor moves' });
        await manage({ action: 'advance', encounterId: enc });
        const back = await manage({ action: 'advance', encounterId: enc });
        expect(back.currentTurn.id).toBe('kael');
        expect(back.round).toBe(2);
        expect(tok('kael').readied).toBeDefined();
        const r = await manage({ action: 'advance', encounterId: enc });
        expect(r.error).toBe(true);
        expect(r.message).toMatch(/TURN NOT TAKEN: Kael/);
    });
});

describe('free passes', () => {
    it('an enemy, an npc row and a sheetless ally pass untouched; the pc after them does not', async () => {
        mk('turncoat');
        mk('aide', { characterType: 'npc' });
        await start({ initiative: 5 }, [
            { id: 'turncoat', name: 'Turncoat', hp: 20, maxHp: 20, initiative: 19, isEnemy: true, position: { x: 4, y: 4 } },
            { id: 'aide', name: 'Aide', hp: 20, maxHp: 20, initiative: 18, position: { x: 5, y: 4 } },
            { id: 'merc', name: 'Merc', hp: 20, maxHp: 20, initiative: 17, position: { x: 6, y: 4 } }
        ]);
        expect(currentId()).toBe('turncoat');
        for (const next of ['aide', 'merc', 'gor', 'kael']) {
            const r = await manage({ action: 'advance', encounterId: enc });
            expect(r.error).toBeUndefined();
            expect(r.currentTurn.id).toBe(next);
        }
        expect((await manage({ action: 'advance', encounterId: enc })).message).toMatch(/TURN NOT TAKEN: Kael/);
    });

    it('an agent-driven player character (auto_on_turn) passes; an agent without it does not', async () => {
        const agents = new AgentRepository(getDb());
        const agent = agents.create({ characterId: 'kael', provider: 'openai', model: 'test-model', autoOnTurn: true });
        await start();
        expect((await manage({ action: 'advance', encounterId: enc })).currentTurn.id).toBe('gor');
        agents.update(agent.id, { autoOnTurn: false });
        await start();
        expect((await manage({ action: 'advance', encounterId: enc })).message).toMatch(/TURN NOT TAKEN/);
    });

    it('an incapacitated player character passes', async () => {
        await start();
        await manage({ action: 'add_condition', encounterId: enc, participantId: 'kael', condition: 'stunned' });
        const r = await manage({ action: 'advance', encounterId: enc });
        expect(r.error).toBeUndefined();
        expect(r.currentTurn.id).toBe('gor');
    });

    it('a player character dropped to 0 HP on its own turn passes', async () => {
        await start();
        await manage({ action: 'adjust_hp', encounterId: enc, participantId: 'kael', value: 0, reason: 'a crossbow bolt from the reeds' });
        const r = await manage({ action: 'advance', encounterId: enc });
        expect(r.error).toBeUndefined();
        expect(r.currentTurn.id).toBe('gor');
    });

    it('prompt mode: DEATH SAVE DUE keeps precedence over the turn guard', async () => {
        new WorldRepository(getDb()).updateEnvironment(W, { deathSaveMode: 'prompt' });
        repo().update('kael', { hp: 0 } as any);
        await start({ hp: 0, initiative: 5 });
        const due = await manage({ action: 'advance', encounterId: enc });
        expect(due.deathSaveDue).toMatchObject({ participantId: 'kael' });
        const refused = await manage({ action: 'advance', encounterId: enc });
        expect(refused.error).toBe(true);
        expect(refused.message).toMatch(/DEATH SAVE DUE/);
        expect(refused.message).not.toMatch(/TURN NOT TAKEN/);
    });

    it('a surprised player character’s slot passes inside the advance without a refusal', async () => {
        mk('mira');
        await start({ initiative: 15 }, [{ id: 'mira', name: 'Mira', hp: 20, maxHp: 20, initiative: 25, position: { x: 0, y: 2 } }], { surprised: ['kael'] });
        expect(currentId()).toBe('mira');
        await act({ action: 'move', actorId: 'mira', targetPosition: { x: 0, y: 3 } });
        const r = await manage({ action: 'advance', encounterId: enc });
        expect(r.error).toBeUndefined();
        expect(r.currentTurn.id).toBe('gor');
    });

    it('the LAIR slot passes', async () => {
        await start({ initiative: 25 }, [{ id: 'wyrm', name: 'Wyrm', hp: 50, maxHp: 50, initiative: 15, isEnemy: true, hasLairActions: true, position: { x: 8, y: 8 } }]);
        await act({ action: 'move', actorId: 'kael', targetPosition: { x: 0, y: 1 } });
        expect((await manage({ action: 'advance', encounterId: enc })).error).toBeUndefined();
        expect(currentId()).toBe('LAIR');
        const r = await manage({ action: 'advance', encounterId: enc });
        expect(r.error).toBeUndefined();
        expect(currentId()).toBe('wyrm');
    });

    it("a world opts out with environment.pcTurnGuard: 'off'", async () => {
        new WorldRepository(getDb()).updateEnvironment(W, { pcTurnGuard: 'off' });
        await start();
        const r = await manage({ action: 'advance', encounterId: enc });
        expect(r.error).toBeUndefined();
        expect(r.currentTurn.id).toBe('gor');
        expect(r.skippedTurn).toBeUndefined();
    });
});

describe('stale economy', () => {
    it("prompt mode: a natural 20 on the slot that is up starts its turn, so the revived PC's first swing is not refused", async () => {
        new WorldRepository(getDb()).updateEnvironment(W, { deathSaveMode: 'prompt' });
        repo().update('kael', { hp: 0 } as any);
        await start({ hp: 0, initiative: 5 });
        // What the turn he dropped left behind.
        setToken('kael', { actionUsed: true, attacksMade: 1, movementRemaining: 0, reactionUsed: true, movedThisTurn: 30 });
        const due = await manage({ action: 'advance', encounterId: enc });
        expect(due.deathSaveDue).toMatchObject({ participantId: 'kael' });
        const save = await manage({ action: 'death_save', encounterId: enc, participantId: 'kael', outcome: 'nat20' });
        expect(save.deathSave).toMatchObject({ regainedHp: true, hp: 1 });
        expect(tok('kael')).toMatchObject({ hp: 1, actionUsed: false, attacksMade: 0, reactionUsed: false, movedThisTurn: 0, movementRemaining: 30 });
        const swing = await act({ action: 'attack', actorId: 'kael', targetId: 'gor', outcome: 'miss' });
        expect(swing.error).toBeUndefined();
        expect(swing.text).not.toMatch(/already used/);
    });

    it('a natural 20 rolled off the slot (banked before it comes up) does not reset the economy', async () => {
        repo().update('kael', { hp: 0 } as any);
        await start({ hp: 0, initiative: 5 });
        setToken('kael', { actionUsed: true });
        const save = await manage({ action: 'death_save', encounterId: enc, participantId: 'kael', outcome: 'nat20' });
        expect(save.deathSave).toMatchObject({ regainedHp: true });
        expect(currentId()).toBe('gor');
        expect(tok('kael').actionUsed).toBe(true);
    });

    it("remove_participant of the current actor runs the next actor's turn start", async () => {
        await start({ initiative: 5 }, [{ id: 'scout', name: 'Scout', hp: 10, maxHp: 10, initiative: 20, position: { x: 7, y: 7 } }]);
        expect(currentId()).toBe('scout');
        setToken('gor', { actionUsed: true, attacksMade: 1, movementRemaining: 0, reactionUsed: true });
        const gone = await manage({ action: 'remove_participant', encounterId: enc, participantId: 'scout' });
        expect(gone.error).toBeUndefined();
        expect(gone.currentTurn).toBe('gor');
        expect(tok('gor')).toMatchObject({ actionUsed: false, attacksMade: 0, reactionUsed: false, movementRemaining: 30 });
        const swing = await act({ action: 'attack', actorId: 'gor', targetId: 'kael', outcome: 'miss' });
        expect(swing.error).toBeUndefined();
        expect(swing.text).not.toMatch(/already used/);
    });

    it('removing the last slot while it is up wraps into the next round', async () => {
        await start();
        await act({ action: 'move', actorId: 'kael', targetPosition: { x: 0, y: 1 } });
        await manage({ action: 'advance', encounterId: enc });
        expect(currentId()).toBe('gor');
        const gone = await manage({ action: 'remove_participant', encounterId: enc, participantId: 'gor' });
        expect(gone.currentTurn).toBe('kael');
        expect(gone.round).toBe(2);
        expect(stored().round).toBe(2);
        expect(tok('kael')).toMatchObject({ movedThisTurn: 0, actedThisTurn: false });
    });

    it('removing a slot that is not up leaves the current actor alone', async () => {
        await start({}, [{ id: 'scout', name: 'Scout', hp: 10, maxHp: 10, initiative: 5, position: { x: 7, y: 7 } }]);
        await act({ action: 'move', actorId: 'kael', targetPosition: { x: 0, y: 1 } });
        await manage({ action: 'remove_participant', encounterId: enc, participantId: 'scout' });
        expect(currentId()).toBe('kael');
        expect(tok('kael').movedThisTurn).toBe(5);
    });
});

describe('off-turn clarity', () => {
    it('an off-turn attack carries offTurn in the JSON', async () => {
        await start();
        await act({ action: 'move', actorId: 'kael', targetPosition: { x: 0, y: 1 } });
        await manage({ action: 'advance', encounterId: enc });
        const late = await act({ action: 'attack', actorId: 'kael', targetId: 'gor', outcome: 'miss' });
        expect(late.error).toBeUndefined();
        expect(late.offTurn).toEqual({ actorId: 'kael', activeId: 'gor', activeName: 'Gor' });
    });

    it('an on-turn attack carries no offTurn', async () => {
        await start();
        const swing = await act({ action: 'attack', actorId: 'kael', targetId: 'gor', outcome: 'miss' });
        expect(swing.offTurn).toBeUndefined();
    });

    it("the off-turn economy refusal says the actor's turn has ended", async () => {
        await start();
        await act({ action: 'attack', actorId: 'kael', targetId: 'gor', outcome: 'miss' });
        await manage({ action: 'advance', encounterId: enc });
        const late = await act({ action: 'attack', actorId: 'kael', targetId: 'gor', outcome: 'miss' });
        expect(late.error).toBe(true);
        expect(late.text).toMatch(/Action already used this turn/);
        expect(late.text).toMatch(/it is Gor's turn: Kael's turn has ended \(advance passed it\); its action and attacks come back at the start of its next turn/);
    });

    it('on its own turn the refusal is unchanged', async () => {
        await start();
        await act({ action: 'attack', actorId: 'kael', targetId: 'gor', outcome: 'miss' });
        const again = await act({ action: 'dodge', actorId: 'kael' });
        expect(again.text).toMatch(/Action already used this turn/);
        expect(again.text).not.toMatch(/turn has ended/);
    });
});

describe('over the MCP boundary', () => {
    let client: Client;
    let server: McpServer;
    type ToolResult = { content?: Array<{ type: string; text?: string }> };
    const payload = (result: unknown): Record<string, any> => {
        const text = (result as ToolResult).content?.[0]?.text ?? '';
        const m = text.match(/<!-- ([A-Z_]+_JSON)\n([\s\S]*?)\n\1 -->/);
        if (!m) throw new Error(`no embedded JSON in reply:\n${text}`);
        return JSON.parse(m[2]);
    };
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));

    beforeEach(async () => {
        server = new McpServer({ name: 'rpg-mcp-test', version: '0.0.0' });
        const registry = buildConsolidatedRegistry();
        const envelopeShape = {
            sessionId: z.string().optional(),
            output_mode: z.enum(['json', 'banner', 'summary']).optional(),
            opId: z.string().optional(),
            fields: z.array(z.string()).optional(),
        };
        for (const toolName of ['world_manage', 'combat_manage', 'combat_action']) {
            const entry = registry[toolName];
            const extended = entry.schema.extend(envelopeShape);
            server.tool(toolName, entry.metadata.description, schemaShape(extended),
                withOperation(toolName, withSession(entry.schema, entry.handler as any) as any) as any);
        }
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'test-client', version: '0.0.0' });
        await client.connect(clientTransport);
    });
    afterEach(async () => {
        await client?.close();
        await server?.close();
    });

    const create = async () => (await call('combat_manage', { action: 'create', seed: 'mcp-guard', worldId: W, participants: [
        { id: 'kael', name: 'Kael', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
        { id: 'gor', name: 'Gor', hp: 30, maxHp: 30, initiative: 10, isEnemy: true, position: { x: 1, y: 0 } }
    ] })).encounterId as string;

    it('tools/list advertises confirm and skipTurn', async () => {
        const { tools } = await client.listTools();
        const props = tools.find(t => t.name === 'combat_manage')!.inputSchema.properties as Record<string, any>;
        expect(props.confirm).toBeDefined();
        expect(props.skipTurn).toBeDefined();
    });

    it('advance refuses, then {confirm: true} and {skipTurn: true} cross the boundary', async () => {
        const e1 = await create();
        const refused = await call('combat_manage', { action: 'advance', encounterId: e1 });
        expect(refused.error).toBe(true);
        expect(refused.writes).toBe('none');
        const passed = await call('combat_manage', { action: 'advance', encounterId: e1, confirm: true });
        expect(passed.skippedTurn).toMatchObject({ participantId: 'kael' });
        const e2 = await create();
        const skipped = await call('combat_manage', { action: 'advance', encounterId: e2, skipTurn: true });
        expect(skipped.skippedTurn).toMatchObject({ participantId: 'kael' });
    });

    it("world_manage update {environment: {pcTurnGuard: 'off'}} persists and turns the guard off", async () => {
        const upd = await call('world_manage', { action: 'update', worldId: W, environment: { pcTurnGuard: 'off' } });
        expect(upd.error).toBeUndefined();
        expect(new WorldRepository(getDb()).findById(W)!.environment.pcTurnGuard).toBe('off');
        const e1 = await create();
        const passed = await call('combat_manage', { action: 'advance', encounterId: e1 });
        expect(passed.error).toBeUndefined();
        expect(passed.skippedTurn).toBeUndefined();
    });
});
