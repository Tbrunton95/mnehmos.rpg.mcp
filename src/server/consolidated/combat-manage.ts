/**
 * Consolidated Combat Management Tool
 * Replaces 7 separate tools for encounter lifecycle management:
 * create_encounter, get_encounter_state, end_encounter, load_encounter,
 * advance_turn, roll_death_save, execute_lair_action
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import {
    handleCreateEncounter,
    handleGetEncounterState,
    handleEndEncounter,
    handleLoadEncounter,
    handleAdvanceTurn,
    handleRollDeathSave,
    handleExecuteLairAction
} from '../handlers/combat-handlers.js';
import { expandCreatureTemplate, listAllTemplates } from '../../data/creature-presets.js';
import { getDomainServices } from '../domain-services.js';
import { getDb } from '../../storage/index.js';
import { EncounterRepository } from '../../storage/repos/encounter.repo.js';
import { CombatEngine } from '../../engine/combat/engine.js';
import { getCombatManager } from '../state/combat-manager.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { getAgentRuntime, buildAgentRuntime } from '../../agent/runtime/deps.js';
import { invokeAgent } from '../../agent/runtime/invoke.js';
import { ProviderFactory } from '../../agent/provider/factory.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['create', 'get', 'end', 'load', 'advance', 'death_save', 'lair_action', 'spawn_quick_enemy', 'add_participant', 'remove_participant', 'get_history', 'list'] as const;
type CombatManageAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const ParticipantSchema = z.object({
    id: z.string(),
    name: z.string(),
    initiativeBonus: z.number().int().default(0).describe('FINDINGS #103: DEFAULTS TO 0 — was silently mandatory and undocumented, costing every fresh client a refused round trip'),
    initiative: z.number().int().optional().describe('Optional pre-rolled initiative; otherwise the engine rolls it'),
    hp: z.number().int().nonnegative(), // Allow 0 HP for dying characters
    maxHp: z.number().int().positive(),
    ac: z.number().int().min(0).optional()
        .describe('Armor Class. If omitted, falls back to attacker-side derivation.'),
    isEnemy: z.boolean().optional(),
    /**
     * Convenience alias for `isEnemy`. Values "enemy" / "hostile" map to
     * isEnemy=true; "party" / "ally" / "friendly" / "neutral" map to false.
     * If both `side` and `isEnemy` are provided, `isEnemy` wins.
     */
    side: z.enum(['party', 'enemy', 'hostile', 'ally', 'friendly', 'neutral']).optional(),
    conditions: z.array(z.string()).default([]),
    position: z.object({
        x: z.number(),
        y: z.number(),
        z: z.number().optional()
    }).optional(),
    resistances: z.array(z.string()).optional(),
    vulnerabilities: z.array(z.string()).optional(),
    immunities: z.array(z.string()).optional()
});

/**
 * Coerce a participant's `side` into an `isEnemy` boolean.
 * Explicit `isEnemy` wins; otherwise derived from `side`.
 */
function deriveIsEnemy(p: { isEnemy?: boolean; side?: string }): boolean | undefined {
    if (typeof p.isEnemy === 'boolean') return p.isEnemy;
    if (!p.side) return undefined;
    return p.side === 'enemy' || p.side === 'hostile';
}

// Some MCP transports / hosts serialize nested object parameters as JSON strings.
// Preprocess so callers can pass either a literal object OR a JSON-stringified object
// and we end up with a real object before the inner schema validates.
const TerrainSchema = z.preprocess(
    (val) => {
        if (typeof val === 'string' && val.trim().startsWith('{')) {
            try { return JSON.parse(val); } catch { return val; }
        }
        return val;
    },
    z.object({
        obstacles: z.array(z.string()).default([]),
        difficultTerrain: z.array(z.string()).optional(),
        water: z.array(z.string()).optional()
    }).optional()
);

const CreateSchema = z.object({
    action: z.literal('create'),
    seed: z.string().default('combat').describe('Seed for deterministic combat resolution'),
    participants: z.array(ParticipantSchema).min(1),
    terrain: TerrainSchema,
    includeParty: z.boolean().optional().describe('T1.2 (Findings #34): prepend the active party as PC-side participants'),
    partyId: z.string().optional().describe('Party to include (defaults to the only active party)'),
    worldId: z.string().optional().describe('FINDINGS #105: stamp the encounter to this world; omitted → derived from the first participant whose character row is claimed')
});

const GetSchema = z.object({
    action: z.literal('get'),
    encounterId: z.string().describe('The ID of the encounter')
});

const EndSchema = z.object({
    action: z.literal('end'),
    encounterId: z.string().describe('The ID of the encounter'),
    xpAward: z.number().int().optional().describe('FINDINGS #34 T4.17: XP credited on end — split evenly among pc-type participants unless xpRecipients given'),
    xpRecipients: z.array(z.string()).optional().describe('Character IDs to receive xpAward (overrides the pc-participant default)')
});

const LoadSchema = z.object({
    action: z.literal('load'),
    encounterId: z.string().describe('The ID of the encounter to load')
});

const AdvanceSchema = z.object({
    action: z.literal('advance'),
    encounterId: z.string().describe('The ID of the encounter')
});

const DeathSaveSchema = z.object({
    action: z.literal('death_save'),
    encounterId: z.string().describe('The ID of the encounter'),
    characterId: z.string().describe('The ID of the character at 0 HP')
});

const LairActionSchema = z.object({
    action: z.literal('lair_action'),
    encounterId: z.string().describe('The ID of the encounter'),
    actionDescription: z.string().describe('Description of the lair action'),
    targetIds: z.array(z.string()).optional(),
    damage: z.number().int().min(0).optional(),
    damageType: z.string().optional(),
    savingThrow: z.object({
        ability: z.enum(['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']),
        dc: z.number().int().min(1).max(30)
    }).optional(),
    halfDamageOnSave: z.boolean().default(true)
});

const SpawnQuickEnemySchema = z.object({
    action: z.literal('spawn_quick_enemy'),
    creature: z.string().describe('Creature name or template (e.g., "goblin", "orc:warrior")'),
    count: z.number().int().min(1).max(10).default(1).describe('Number of enemies to spawn'),
    position: z.object({ x: z.number(), y: z.number() }).optional().describe('Starting position (defaults to random)'),
    encounterId: z.string().optional().describe('Add to existing encounter (creates new if omitted)'),
    seed: z.string().optional().describe('Seed for deterministic combat (auto-generated if omitted)'),
    includeParty: z.boolean().optional().describe('T1.2 (Findings #34): include the active party as PC-side participants in the NEW encounter'),
    partyId: z.string().optional().describe('Party to include (defaults to the only party if exactly one exists)')
});

const AddParticipantSchema = z.object({
    action: z.literal('add_participant'),
    encounterId: z.string().describe('Encounter to add to'),
    characterId: z.string().optional().describe('Character row to hydrate from (name/hp/ac/initiative from the sheet)'),
    name: z.string().optional().describe('Name (required for ad-hoc tokens without characterId)'),
    hp: z.number().int().optional(),
    maxHp: z.number().int().optional(),
    ac: z.number().int().optional(),
    initiativeBonus: z.number().int().optional(),
    isEnemy: z.boolean().optional().default(false),
    position: z.object({ x: z.number(), y: z.number() }).optional()
});

const GetHistorySchema = z.object({
    action: z.literal('get_history'),
    encounterId: z.string().describe('The ID of the encounter'),
    round: z.number().int().optional().describe('Get actions from a specific round (omit for all)'),
    limit: z.number().int().min(1).max(100).default(20).describe('Max actions to return (default 20)')
});

// FINDINGS #80: the ghost hunt gets a verb — encounters could previously only
// be found one at a time through get_context's LIMIT 1. list shows every row
// by status with a liveness column, so a persisted corpse never masquerades
// as a running fight and multiple ghosts surface in one call.
const ListEncountersSchema = z.object({
    action: z.literal('list'),
    status: z.enum(['active', 'completed', 'all']).default('active').describe('Row status filter — default active (the ghost hunt)'),
    limit: z.number().int().min(1).max(50).default(20),
    buryGhosts: z.boolean().optional().describe('FINDINGS #80-B: mark every listed ghost (active row, no engine) completed IN THIS CALL — the bulk burial. Count reported from the store\'s changes. #102 GUARD: on a fresh process EVERY active row looks like a ghost (memory is empty) — burial refuses then unless confirmBury:true'),
    confirmBury: z.boolean().optional().describe('FINDINGS #102: override the cold-boot guard — confirms burial when NO encounter is in memory (fresh process), where live cross-campaign fights are indistinguishable from ghosts'),
    worldId: z.string().optional().describe('FINDINGS #105: STRICT filter — only encounters stamped to this world; untagged legacy rows are counted and EXCLUDED (claim by re-creating or direct update). Scopes the ghost sweep')
});

// ═══════════════════════════════════════════════════════════════════════════
// FINDINGS #34 HELPERS — party inclusion, threat readout, participant append

function fetchPartyParticipants(partyId?: string): { participants: Record<string, unknown>[]; partyName?: string; error?: string } {
    const db = getDb();
    let pid = partyId;
    if (!pid) {
        const parties = db.prepare(`SELECT id, name FROM parties WHERE status = 'active'`).all() as Array<{ id: string; name: string }>;
        if (parties.length !== 1) {
            return { participants: [], error: `includeParty needs a partyId when ${parties.length} active parties exist` };
        }
        pid = parties[0].id;
    }
    const rows = db.prepare(
        `SELECT pm.role, ch.id, ch.name, ch.hp, ch.max_hp AS maxHp, ch.ac, ch.stats
         FROM party_members pm JOIN characters ch ON ch.id = pm.character_id
         WHERE pm.party_id = ?`
    ).all(pid) as Array<{ role: string; id: string; name: string; hp: number; maxHp: number; ac: number; stats: string }>;
    const partyName = (db.prepare('SELECT name FROM parties WHERE id = ?').get(pid) as { name: string } | undefined)?.name;
    const participants = rows.filter(r => r.role !== 'prisoner').map((r, i) => {
        let dexMod = 0;
        try { dexMod = Math.floor(((JSON.parse(r.stats || '{}').dex ?? 10) - 10) / 2); } catch { /* default 0 */ }
        return {
            id: r.id, name: r.name, hp: r.hp, maxHp: r.maxHp, ac: r.ac,
            initiativeBonus: dexMod, isEnemy: false, conditions: [],
            position: { x: (i % 3), y: Math.floor(i / 3) },
            resistances: [], vulnerabilities: [], immunities: []
        };
    });
    return { participants, partyName };
}

function avgDice(expr?: string | number): number {
    if (expr === undefined) return 0;
    if (typeof expr === 'number') return expr;
    let total = 0;
    for (const m of expr.matchAll(/(\d+)d(\d+)/g)) total += parseInt(m[1]) * (parseInt(m[2]) + 1) / 2;
    for (const m of expr.matchAll(/(?<![d\d])([+-]\d+)(?!d)/g)) total += parseInt(m[1]);
    return Math.round(total * 10) / 10;
}

/** T1.3 (Findings #34): surface the wall before the party hits it. */
function threatReadout(participants: Array<Record<string, unknown>>, presetCr?: number, enemyCount?: number): string {
    const enemies = participants.filter(p => p.isEnemy);
    const allies = participants.filter(p => !p.isEnemy);
    const dpr = enemies.reduce((s, e) => s + avgDice(e.attackDamage as string | number | undefined), 0);
    const crTotal = presetCr !== undefined && enemyCount !== undefined ? presetCr * enemyCount : undefined;
    const db = getDb();
    let levelSum = 0, levelKnown = 0;
    for (const a of allies) {
        const row = db.prepare('SELECT level FROM characters WHERE id = ?').get(a.id as string) as { level: number } | undefined;
        if (row) { levelSum += row.level; levelKnown++; }
    }
    const allyHp = allies.reduce((s, a) => s + ((a.maxHp as number) || 0), 0);
    let line = `⚔️ THREAT: ${enemies.length} hostile${enemies.length === 1 ? '' : 's'}`;
    if (crTotal !== undefined) line += ` (~CR ${crTotal} total)`;
    if (dpr > 0) line += ` — est ${dpr} dmg/round`;
    line += ` vs ${allies.length} allied (${allyHp} HP pooled${levelKnown ? `, levels ${levelSum}` : ''})`;
    if ((crTotal !== undefined && levelKnown && crTotal > levelSum * 0.75) || (dpr > 0 && allyHp > 0 && dpr * 3 >= allyHp)) {
        line += `\n   ⚠️ HEAVY: this can drop the allied side in ~${dpr > 0 ? Math.max(1, Math.ceil(allyHp / dpr)) : '?'} rounds of average dice.`;
    }
    return line;
}

/** Shared append-with-persist (extracted from the spawn_quick_enemy append branch pattern). */
async function appendToEncounter(ctx: SessionContext, encounterId: string, newParticipants: Record<string, unknown>[]): Promise<{ ok: boolean; message: string; state?: unknown }> {
    const sessionKey = `${ctx.sessionId}:${encounterId}`;
    let engine = getCombatManager().get(sessionKey);
    if (!engine) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        const persisted = repo.loadState(encounterId);
        if (!persisted) return { ok: false, message: `Encounter ${encounterId} not found (memory or DB)` };
        engine = new CombatEngine(encounterId);
        engine.loadState(persisted);
        getCombatManager().create(sessionKey, engine);
    }
    const beforeIds = new Set(engine.getState()?.participants.map((p) => p.id) ?? []);
    const state = engine.addParticipants(newParticipants as unknown as Parameters<typeof engine.addParticipants>[0]);
    try {
        const db = getDb();
        new EncounterRepository(db).saveState(encounterId, state);
    } catch (err) {
        const live = engine.getState();
        if (live) {
            live.participants = live.participants.filter((p) => beforeIds.has(p.id));
            live.turnOrder = live.turnOrder.filter((id) => id === 'LAIR' || beforeIds.has(id));
        }
        return { ok: false, message: `Persist failed, in-memory append rolled back: ${(err as Error).message}` };
    }
    return { ok: true, message: 'appended', state };
}

// CONTEXT HOLDER (for passing session context to handlers)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ACTION DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

// FINDINGS #92: THE STAGE GATE — KEEPER spec §3.2. A specimen at a
// non-actionable stage (egg, dormant hugger, implanted, gestating) can be a
// TARGET, moved, sampled, sold or destroyed — it cannot take a turn. The
// gate is a wall, not a discipline (#58 reasoning). PSAR impact: zero — no
// STALKER character carries a stage: condition.
const NON_ACTIONABLE_STAGES = new Set(['stage:ovomorph', 'stage:facehugger_dormant', 'stage:implanted', 'stage:gestating']);
function stageGateCheck(characterId: string): string | null {
    try {
        const db = getDb();
        const row = new CharacterRepository(db).findById(characterId);
        const conds = ((row as { conditions?: Array<{ name?: string }> } | null)?.conditions ?? []);
        for (const c of conds) {
            const n = (c?.name ?? '').toLowerCase();
            if (NON_ACTIONABLE_STAGES.has(n)) return n;
        }
    } catch { /* character unreadable — no gate, downstream lookup will refuse */ }
    return null;
}

const definitions: Record<CombatManageAction, ActionDefinition> = {
    create: {
        schema: CreateSchema,
        handler: async (params: z.infer<typeof CreateSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            // Map convenience `side` field down to canonical `isEnemy` and drop `side`
            // before forwarding to handleCreateEncounter (which doesn't accept it).
            const normalizedParticipants = params.participants.map((p) => {
                const { side: _side, ...rest } = p;
                const derived = deriveIsEnemy(p);
                return derived === undefined ? rest : { ...rest, isEnemy: derived };
            });
            // T1.2 (Findings #34): includeParty pulls the active party in.
            let finalParticipants = normalizedParticipants as Array<Record<string, unknown>>;
            const gateSkipped: string[] = [];
            // FINDINGS #92: the stage gate — second door. participants[] with a
            // character UUID id get the same wall as add_participant; gate one
            // door and the fence has a hole.
            for (const p of finalParticipants) {
                const pid = typeof p.id === 'string' ? p.id : undefined;
                if (pid && pid.length >= 32) {
                    const gated = stageGateCheck(pid);
                    if (gated) {
                        return { error: true, actionType: 'create', message: `STAGE GATE: participant ${p.name ?? pid} carries ${gated} — a specimen at this stage cannot act in an encounter. Remove it from participants[]; it can still be attacked as a target. Encounter NOT created.` };
                    }
                }
            }
            if (params.includeParty) {
                const party = fetchPartyParticipants(params.partyId);
                if (party.error) return { error: true, actionType: 'create', message: party.error };
                const existing = new Set(finalParticipants.map(p => p.id as string));
                finalParticipants = [
                    ...party.participants.filter(pp => !existing.has(pp.id as string)),
                    ...finalParticipants
                ];
            }
            const originalParams = {
                seed: params.seed,
                participants: finalParticipants.filter(p => {
                    // FINDINGS #92: third path — party-pulled members (includeParty)
                    // arrive automatically, so a gated one is SKIPPED with a note
                    // rather than refusing the whole encounter (an implanted
                    // prisoner in the party must not veto the fight).
                    const pid = typeof p.id === 'string' && p.id.length >= 32 ? p.id : undefined;
                    if (!pid) return true;
                    const gated = stageGateCheck(pid);
                    if (gated) { gateSkipped.push(`${p.name ?? pid} (${gated})`); return false; }
                    return true;
                }),
                terrain: params.terrain
            };
            const result = await handleCreateEncounter(originalParams, ctx);
            const data = extractResultData(result, 'create') as Record<string, unknown>;
            // T1.3 (Findings #34): print the wall before the party hits it.
            if (!data.error) data.threat = threatReadout(originalParams.participants);
            if (!data.error && gateSkipped.length) data.stageGateSkipped = gateSkipped;
            // FINDINGS #105: stamp the encounter's world — explicit worldId, else
            // derived from the first participant whose character row is claimed.
            // Fully unclaimed → row stays NULL and shows as untagged in list.
            if (!data.error && data.encounterId) {
                try {
                    const db = getDb();
                    try { db.exec('ALTER TABLE encounters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
                    let w: string | null = (params as { worldId?: string }).worldId ?? null;
                    if (!w) {
                        for (const p of originalParams.participants as Array<{ id?: string }>) {
                            if (!p.id) continue;
                            try {
                                const r = db.prepare('SELECT world_id FROM characters WHERE id = ?').get(p.id) as { world_id?: string | null } | undefined;
                                if (r?.world_id) { w = r.world_id; break; }
                            } catch { break; }
                        }
                    }
                    if (w) { db.prepare('UPDATE encounters SET world_id = ? WHERE id = ?').run(w, data.encounterId); data.worldId = w; }
                } catch { /* stamping is best-effort — the fight matters more */ }
            }
            return data;
        },
        aliases: ['start', 'new', 'begin', 'init']
    },

    get: {
        schema: GetSchema,
        handler: async (params: z.infer<typeof GetSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const result = await handleGetEncounterState({ encounterId: params.encounterId }, ctx);
            return extractResultData(result, 'get');
        },
        aliases: ['state', 'status', 'show']
    },

    end: {
        schema: EndSchema,
        handler: async (params: z.infer<typeof EndSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            // T4.17: capture pc participants BEFORE ending (state clears after)
            let xpTargets: string[] = params.xpRecipients ?? [];
            if (params.xpAward && xpTargets.length === 0) {
                const db = getDb();
                try {
                    const persisted = new EncounterRepository(db).loadState(params.encounterId)
                        ?? getCombatManager().get(`${ctx.sessionId}:${params.encounterId}`)?.getState();
                    const charRepo = new CharacterRepository(db);
                    for (const p of persisted?.participants ?? []) {
                        const row = charRepo.findById(p.id);
                        if (row && (row as { characterType?: string }).characterType === 'pc') xpTargets.push(p.id);
                    }
                } catch { /* fall through — no targets, no award */ }
            }
            const result = await handleEndEncounter({ encounterId: params.encounterId }, ctx);
            const data = extractResultData(result, 'end') as Record<string, unknown>;
            if (params.xpAward && xpTargets.length > 0 && !data.error) {
                const db = getDb();
                const charRepo = new CharacterRepository(db);
                const each = Math.floor(params.xpAward / xpTargets.length);
                const credited: Array<{ id: string; name: string; xp: number }> = [];
                for (const id of xpTargets) {
                    const row = charRepo.findById(id);
                    if (!row) continue;
                    charRepo.update(id, { xp: ((row as { xp?: number }).xp ?? 0) + each } as Partial<import('../../schema/character.js').Character>);
                    credited.push({ id, name: row.name, xp: each });
                }
                data.xpAwarded = credited;
                data.xpNote = `${params.xpAward} XP split ${each} each among ${credited.map(cr => cr.name).join(', ')}`;
            }
            return data;
        },
        aliases: ['finish', 'complete', 'stop', 'close']
    },

    load: {
        schema: LoadSchema,
        handler: async (params: z.infer<typeof LoadSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const result = await handleLoadEncounter({ encounterId: params.encounterId }, ctx);
            return extractResultData(result, 'load');
        },
        aliases: ['restore', 'resume', 'continue']
    },

    advance: {
        schema: AdvanceSchema,
        handler: async (params: z.infer<typeof AdvanceSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const result = await handleAdvanceTurn({ encounterId: params.encounterId }, ctx);
            const data = extractResultData(result, 'advance');

            // ──────────────────────────────────────────────────────────────────
            // Agent auto-invoke hook: after initiative advances, if the new
            // current actor has an active agent with auto_on_turn=true, fire a
            // synchronous invoke and embed the response in this payload.
            // Errors here NEVER block the turn — the turn already advanced.
            // ──────────────────────────────────────────────────────────────────
            try {
                const currentTurn = (data as { currentTurn?: { id?: string; name?: string } }).currentTurn;
                const currentActorId = currentTurn?.id;
                if (currentActorId) {
                    const runtime = getAgentRuntime() ?? (() => {
                        const factory = new ProviderFactory();
                        factory.initialize();
                        return buildAgentRuntime(getDomainServices().db, factory);
                    })();

                    const agent = runtime.agentRepo.findByCharacterId(currentActorId);
                    if (agent && agent.autoOnTurn && agent.status === 'active') {
                        const round = (data as { round?: number }).round;
                        const situation = `It's your turn in encounter ${params.encounterId}` +
                            (round !== undefined ? `, round ${round}.` : '.');
                        const agentResult = await invokeAgent(
                            {
                                agentId: agent.id,
                                situation,
                                encounterId: params.encounterId,
                                round,
                                requestId: ctx.sessionId
                            },
                            runtime
                        );
                        (data as Record<string, unknown>).agentResponse = {
                            status: agentResult.status,
                            reason: agentResult.reason,
                            characterName: agentResult.characterName,
                            response: agentResult.response,
                            callId: agentResult.callId,
                            promptTokens: agentResult.promptTokens,
                            completionTokens: agentResult.completionTokens,
                            durationMs: agentResult.durationMs
                        };
                    }
                }
            } catch (err) {
                // Auto-invoke must NEVER break turn advance. Surface the failure
                // in the payload so the DM can investigate, but the turn stands.
                (data as Record<string, unknown>).agentResponse = {
                    status: 'error',
                    reason: `auto_invoke_threw: ${err instanceof Error ? err.message : String(err)}`
                };
            }

            return data;
        },
        aliases: ['next', 'next_turn', 'advance_turn']
    },

    death_save: {
        schema: DeathSaveSchema,
        handler: async (params: z.infer<typeof DeathSaveSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const result = await handleRollDeathSave({
                encounterId: params.encounterId,
                characterId: params.characterId
            }, ctx);
            return extractResultData(result, 'death_save');
        },
        aliases: ['death_saving_throw', 'save_death', 'dying']
    },

    lair_action: {
        schema: LairActionSchema,
        handler: async (params: z.infer<typeof LairActionSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const { action, ...lairParams } = params;
            const result = await handleExecuteLairAction(lairParams, ctx);
            return extractResultData(result, 'lair_action');
        },
        aliases: ['lair', 'legendary', 'boss_action']
    },

    spawn_quick_enemy: {
        schema: SpawnQuickEnemySchema,
        handler: async (params: z.infer<typeof SpawnQuickEnemySchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');

            // Expand creature template
            const preset = expandCreatureTemplate(params.creature);
            if (!preset) {
                const available = listAllTemplates();
                return {
                    error: true,
                    actionType: 'spawn_quick_enemy',
                    message: `Unknown creature: "${params.creature}"`,
                    availableCreatures: available.slice(0, 20),
                    hint: `Try one of: ${available.slice(0, 5).join(', ')}...`
                };
            }

            // Build participants from preset
            const count = params.count || 1;
            const participants = [];

            for (let i = 0; i < count; i++) {
                const id = `enemy-${randomUUID().slice(0, 8)}`;
                const basePos = params.position || { x: 10, y: 10 };
                const pos = count > 1
                    ? { x: basePos.x + (i % 3) * 2, y: basePos.y + Math.floor(i / 3) * 2 }
                    : basePos;

                participants.push({
                    id,
                    name: count > 1 ? `${preset.name} ${i + 1}` : preset.name,
                    initiativeBonus: Math.floor((preset.stats.dex - 10) / 2),
                    hp: preset.hp,
                    maxHp: preset.maxHp,
                    ac: preset.ac,
                    attackDamage: preset.defaultAttack?.damage,
                    attackBonus: preset.defaultAttack?.toHit,
                    isEnemy: true,
                    conditions: [],
                    position: pos,
                    resistances: preset.resistances || [],
                    vulnerabilities: preset.vulnerabilities || [],
                    immunities: preset.immunities || []
                });
            }

            // If encounterId is supplied, append the new enemies to that
            // encounter. Auto-loads from the database when the engine isn't
            // in memory (mirroring handleGetEncounterState / handleExecute*),
            // and persists the new state back so a subsequent restart still
            // sees the spawned enemies. Only falls back to creating a fresh
            // encounter when the id genuinely doesn't exist anywhere.
            if (params.encounterId) {
                const sessionKey = `${ctx.sessionId}:${params.encounterId}`;
                let engine = getCombatManager().get(sessionKey);
                let loadedFromDb = false;

                if (!engine) {
                    const persisted = getDomainServices().encounter.loadState(params.encounterId);
                    if (persisted) {
                        engine = new CombatEngine(params.encounterId);
                        engine.loadState(persisted);
                        getCombatManager().create(sessionKey, engine);
                        loadedFromDb = true;
                    }
                }

                if (engine) {
                    // Snapshot for rollback before mutating in-memory state.
                    const beforeIds = new Set(engine.getState()?.participants.map((p) => p.id) ?? []);
                    const state = engine.addParticipants(
                        participants as unknown as Parameters<typeof engine.addParticipants>[0]
                    );

                    // Persist the appended state so a restart doesn't lose the
                    // newly spawned enemies. PR #58 reviewer ask: don't return
                    // success if persistence fails — that splits in-memory and
                    // DB state. Roll back the in-memory addParticipants and
                    // surface an explicit error.
                    try {
                        getDomainServices().encounter.saveState(params.encounterId, state);
                    } catch (err) {
                        // Roll back: drop the just-added participants so memory
                        // matches DB. Use the engine's state directly since we
                        // know the schema.
                        const live = engine.getState();
                        if (live) {
                            live.participants = live.participants.filter((p) => beforeIds.has(p.id));
                            live.turnOrder = live.turnOrder.filter((id) => id === 'LAIR' || beforeIds.has(id));
                        }
                        return {
                            error: true,
                            actionType: 'spawn_quick_enemy',
                            encounterId: params.encounterId,
                            message: `Failed to persist appended encounter state: ${(err as Error).message}. In-memory append rolled back.`,
                            rolledBack: true
                        };
                    }

                    return {
                        success: true,
                        actionType: 'spawn_quick_enemy',
                        encounterId: params.encounterId,
                        creature: params.creature,
                        spawnedCount: count,
                        appendedToExisting: true,
                        loadedFromDb,
                        enemies: participants.map(p => ({
                            id: p.id,
                            name: p.name,
                            hp: p.hp,
                            maxHp: p.maxHp,
                            ac: preset.ac,
                            position: p.position,
                            attack: preset.defaultAttack
                        })),
                        turnOrder: state.turnOrder,
                        // currentTurnIndex indexes turnOrder, NOT participants —
                        // those arrays can diverge when LAIR is in the order.
                        currentTurn: state.turnOrder[state.currentTurnIndex],
                        readyForCombat: true,
                        hint: `Added ${count} ${preset.name}(s) to existing encounter. Initiative re-sorted.`
                    };
                }
                // encounterId given but neither in memory nor in DB — return
                // an explicit error rather than silently creating a new
                // encounter with the spawned enemies. Silent fallback hides
                // typos and stale ids from the caller (PR #58 reviewer ask).
                return {
                    error: true,
                    actionType: 'spawn_quick_enemy',
                    message: `Encounter ${params.encounterId} not found in memory or DB. Omit encounterId to create a new encounter.`,
                    requestedEncounterId: params.encounterId
                };
            }

            // Create encounter with these participants
            // Findings #35: freeze the spawned-enemy list BEFORE includeParty
            // mutates participants — the banner listed a party member under
            // Enemies Spawned wearing the creature's AC and Bite.
            const spawnedEnemies = [...participants];
            // T1.2 (Findings #34): includeParty pulls the active party in as
            // PC-side participants — quick spawns stop excluding the table.
            if (params.includeParty) {
                const party = fetchPartyParticipants(params.partyId);
                if (party.error) {
                    return { error: true, actionType: 'spawn_quick_enemy', message: party.error };
                }
                const existing = new Set(participants.map(p => p.id));
                for (const pp of party.participants) {
                    if (!existing.has(pp.id as string)) participants.unshift(pp as typeof participants[number]);
                }
            }
            const seed = params.seed || `quick-${Date.now()}`;
            const createParams = {
                seed,
                participants,
                terrain: { obstacles: [], difficultTerrain: [], water: [] }
            };

            const result = await handleCreateEncounter(createParams, ctx);
            const resultData = extractResultData(result, 'spawn_quick_enemy');

            // Enhance with spawn info
            return {
                ...resultData,
                actionType: 'spawn_quick_enemy',
                creature: params.creature,
                spawnedCount: count,
                enemies: spawnedEnemies.map(p => ({
                    id: p.id,
                    name: p.name,
                    hp: p.hp,
                    maxHp: p.maxHp,
                    ac: preset.ac,
                    position: p.position,
                    attack: preset.defaultAttack
                })),
                creatureStats: {
                    name: preset.name,
                    hp: preset.hp,
                    ac: preset.ac,
                    cr: preset.cr,
                    traits: preset.traits
                },
                threat: threatReadout(participants as unknown as Array<Record<string, unknown>>, preset.cr, count),
                readyForCombat: true,
                hint: 'Use combat_action to attack, combat_map to render grid'
            };
        },
        aliases: ['quick', 'spawn', 'summon', 'add_enemy']
    },

    add_participant: {
        schema: AddParticipantSchema,
        handler: async (params: z.infer<typeof AddParticipantSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            let participant: Record<string, unknown>;
            if (params.characterId) {
                // FINDINGS #92: the stage gate — first door.
                const gated = stageGateCheck(params.characterId);
                if (gated) {
                    return { error: true, actionType: 'add_participant', message: `STAGE GATE: character ${params.characterId} carries ${gated} — a specimen at this stage cannot act in an encounter. It can be a TARGET (attack it, move it, sample it), but it takes no turns. NOT added.` };
                }
                const db = getDb();
                const row = new CharacterRepository(db).findById(params.characterId);
                if (!row) return { error: true, actionType: 'add_participant', message: `Character ${params.characterId} not found` };
                const stats = row.stats as Record<string, number>;
                participant = {
                    id: row.id, name: params.name ?? row.name,
                    hp: params.hp ?? row.hp, maxHp: params.maxHp ?? row.maxHp,
                    ac: params.ac ?? row.ac,
                    initiativeBonus: params.initiativeBonus ?? Math.floor(((stats?.dex ?? 10) - 10) / 2),
                    isEnemy: params.isEnemy ?? false, conditions: [],
                    position: params.position ?? { x: 0, y: 0 },
                    resistances: (row as { resistances?: string[] }).resistances || [],
                    vulnerabilities: (row as { vulnerabilities?: string[] }).vulnerabilities || [],
                    immunities: (row as { immunities?: string[] }).immunities || []
                };
            } else {
                if (!params.name || params.hp === undefined || params.maxHp === undefined) {
                    return { error: true, actionType: 'add_participant', message: 'Ad-hoc participant needs name, hp, maxHp (or pass characterId)' };
                }
                participant = {
                    id: `token-${randomUUID().slice(0, 8)}`, name: params.name,
                    hp: params.hp, maxHp: params.maxHp, ac: params.ac ?? 10,
                    initiativeBonus: params.initiativeBonus ?? 0,
                    isEnemy: params.isEnemy ?? false, conditions: [],
                    position: params.position ?? { x: 0, y: 0 },
                    resistances: [], vulnerabilities: [], immunities: []
                };
            }
            const res = await appendToEncounter(ctx, params.encounterId, [participant]);
            if (!res.ok) return { error: true, actionType: 'add_participant', message: res.message };
            return {
                success: true, actionType: 'add_participant', encounterId: params.encounterId,
                participant: { id: participant.id, name: participant.name, hp: participant.hp, ac: participant.ac, isEnemy: participant.isEnemy },
                message: `${participant.name} joins the encounter (${participant.isEnemy ? 'HOSTILE' : 'allied'}) — initiative rolled, state persisted.`
            };
        },
        aliases: ['reinforce', 'join_combat'],
        description: 'Add a character or ad-hoc token to a RUNNING encounter — reinforcements, late arrivals, the PC joining a quick-spawned fight'
    },
    remove_participant: {
        schema: z.object({
            action: z.literal('remove_participant'),
            encounterId: z.string(),
            participantId: z.string().describe('Participant/token id to remove (fled, banished, despawned — NOT killed; the dead use character_manage kill or drop at 0 HP)')
        }),
        handler: async (params: { encounterId: string; participantId: string }, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            // #67-D: the inverse of add_participant — same engine access pattern.
            const sessionKey = `${ctx.sessionId}:${params.encounterId}`;
            let engine = getCombatManager().get(sessionKey);
            if (!engine) {
                const db = getDb();
                const persisted = new EncounterRepository(db).loadState(params.encounterId);
                if (!persisted) return { error: true, actionType: 'remove_participant', message: `Encounter ${params.encounterId} not found (memory or DB)`, writes: 'none' };
                engine = new CombatEngine(params.encounterId);
                engine.loadState(persisted);
                getCombatManager().create(sessionKey, engine);
            }
            const state = engine.getState();
            if (!state) return { error: true, actionType: 'remove_participant', message: 'No live state', writes: 'none' };
            const gone = state.participants.find((p) => p.id === params.participantId);
            if (!gone) return { error: true, actionType: 'remove_participant', message: `Participant ${params.participantId} not in this encounter`, writes: 'none' };
            // Turn-pointer safety: currentTurnIndex indexes turnOrder — re-anchor
            // on the current actor's id after the filter so removal of an
            // earlier slot never skips or repeats a turn.
            const currentActorId = state.turnOrder[state.currentTurnIndex];
            state.participants = state.participants.filter((p) => p.id !== params.participantId);
            state.turnOrder = state.turnOrder.filter((id) => id !== params.participantId);
            if (state.turnOrder.length === 0) return { error: true, actionType: 'remove_participant', message: 'Refused: removal would empty the encounter — use end instead', writes: 'none' };
            const reIdx = state.turnOrder.indexOf(currentActorId);
            state.currentTurnIndex = reIdx >= 0 ? reIdx : state.currentTurnIndex % state.turnOrder.length;
            const db = getDb();
            new EncounterRepository(db).saveState(params.encounterId, state);
            return {
                success: true, actionType: 'remove_participant', encounterId: params.encounterId,
                removed: { id: gone.id, name: gone.name },
                remaining: state.participants.length,
                currentTurn: state.turnOrder[state.currentTurnIndex],
                message: `${gone.name} is out of the fight — removed from initiative. ${state.participants.length} remain.`
            };
        },
        aliases: ['flee', 'banish', 'despawn'],
        description: '#67-D: Remove a participant from a running encounter (fled/banished/despawned) — turn pointer re-anchored, state persisted. The dead don\'t use this; they drop at 0 HP'
    },
    get_history: {
        schema: GetHistorySchema,
        handler: async (params: z.infer<typeof GetHistorySchema>) => {
            const actionLogRepo = getDomainServices().combatActionLog;

            let actions;
            if (params.round !== undefined) {
                actions = actionLogRepo.getByRound(params.encounterId, params.round);
            } else {
                actions = actionLogRepo.getRecent(params.encounterId, params.limit);
            }

            if (actions.length === 0) {
                return {
                    success: true,
                    actionType: 'get_history',
                    encounterId: params.encounterId,
                    actions: [],
                    summary: 'No combat actions recorded for this encounter.',
                    hint: 'Actions are logged automatically when using combat_action.'
                };
            }

            // Build summary for context reconstruction
            const summary = actionLogRepo.getSummary(params.encounterId);

            return {
                success: true,
                actionType: 'get_history',
                encounterId: params.encounterId,
                totalActions: actions.length,
                actions: actions.map(a => ({
                    round: a.round,
                    actor: a.actorName,
                    action: a.actionType,
                    summary: a.resultSummary,
                    damage: a.damageDealt,
                    healing: a.healingDone,
                    timestamp: a.timestamp
                })),
                summary,
                hint: 'Use this to reconstruct combat state after context compaction.'
            };
        },
        aliases: ['history', 'log', 'replay', 'actions']
    },
    list: {
        schema: ListEncountersSchema,
        handler: async (params: z.infer<typeof ListEncountersSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const db = getDb();
            let rows: Array<{ id: string; status: string; round: number; updated_at: string; world_id?: string | null }> = [];
            let untaggedExcluded = 0;
            try {
                const whereClause = params.status === 'all' ? '' : (params.status === 'active' ? `WHERE status = 'active'` : `WHERE status = 'completed'`);
                rows = db.prepare(`SELECT id, status, round, updated_at FROM encounters ${whereClause} ORDER BY updated_at DESC LIMIT ?`)
                    .all(params.limit) as typeof rows;
                // FINDINGS #105: STRICT world filter (the #94 semantics — nulls are
                // legacy, not wildcards). Untagged rows counted and excluded.
                if (params.worldId !== undefined) {
                    try {
                        // FINDINGS #105b: the list lane ensures the column too — before
                        // the first post-migration create, a missing column made the
                        // filter silently pass EVERYTHING with excluded:0 (a lie of the
                        // #103 class). With the column ensured, legacy rows read NULL
                        // and the strict filter excludes them honestly.
                        try { db.exec('ALTER TABLE encounters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
                        const tagged = new Map((db.prepare('SELECT id, world_id FROM encounters').all() as Array<{ id: string; world_id: string | null }>).map(r => [r.id, r.world_id]));
                        const before = rows.length;
                        rows = rows.filter(r => tagged.get(r.id) === params.worldId);
                        untaggedExcluded = before - rows.length;
                    } catch { /* pre-migration db — no column, no filter */ }
                }
            } catch {
                return { success: true, actionType: 'list', count: 0, encounters: [], summary: 'No encounters table — nothing has ever fought here.' };
            }
            const encounters = rows.map(r => ({
                encounterId: r.id,
                status: r.status,
                round: r.round,
                updatedAt: r.updated_at,
                // FINDINGS #80 liveness: an 'active' row with no engine in memory
                // is a ghost (pre-#79 residue) or a crash-survivor — named either way.
                inMemory: getCombatManager().get(`${ctx.sessionId}:${r.id}`) !== null
            }));
            const ghosts = encounters.filter(e => e.status === 'active' && !e.inMemory);
            // FINDINGS #80-B: bulk burial — the census found 58+ ghosts spanning
            // the campaign's whole life; one-per-call burial doesn't scale.
            // Buried count comes from the store's changes, never the input.
            let buried = 0;
            // FINDINGS #102-B: the cold-boot nuke. Liveness is "in THIS session's
            // memory" — on a fresh process memory is empty, so every campaign's
            // genuinely-active fight reads as a ghost and buryGhosts would
            // force-complete them all. When NOTHING is in memory, burial needs
            // explicit confirmation.
            const anyInMemory = encounters.some(e => e.inMemory);
            if (params.buryGhosts && ghosts.length && !anyInMemory && !params.confirmBury) {
                return {
                success: true, actionType: 'list', count: encounters.length, encounters,
                ...(params.worldId !== undefined ? { worldId: params.worldId, untaggedOrOtherWorldExcluded: untaggedExcluded } : {}),
                    ghosts: ghosts.map(g => g.encounterId), buried: 0,
                    guardRefused: true,
                    summary: `⚠ COLD-BOOT GUARD (#102): ${ghosts.length} active row(s) look like ghosts, but ZERO encounters are in this process's memory — a fresh process cannot tell a ghost from another campaign's live fight. Re-open yours with 'load' first, or pass confirmBury:true to bury all listed anyway.`
                };
            }
            if (params.buryGhosts && ghosts.length) {
                const mark = db.prepare(`UPDATE encounters SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'active'`);
                const nowIso = new Date().toISOString();
                for (const g of ghosts) buried += mark.run(nowIso, g.encounterId).changes;
                for (const e of encounters) { if (ghosts.includes(e)) e.status = 'completed'; }
            }
            return {
                success: true,
                actionType: 'list',
                count: encounters.length,
                encounters,
                ...(params.worldId !== undefined ? { worldId: params.worldId, untaggedOrOtherWorldExcluded: untaggedExcluded } : {}),
                ...(params.buryGhosts ? { buried } : {}),
                ...(ghosts.length && !params.buryGhosts ? { ghosts: ghosts.map(g => g.encounterId), hint: `${ghosts.length} active row(s) with no running engine — combat_manage end closes each, or list with buryGhosts:true closes all (#80-B)` } : {}),
                summary: encounters.length === 0 ? `No ${params.status === 'all' ? '' : params.status + ' '}encounters.` : `${encounters.length} encounter(s)${params.buryGhosts ? ` — ${buried} ghost(s) BURIED` : (ghosts.length ? ` — ${ghosts.length} GHOST(s) needing burial` : '')}`
            };
        },
        aliases: ['encounters', 'ls', 'ghosts']
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function extractResultData(result: McpResponse, actionType: string): Record<string, unknown> {
    const text = result.content[0].text;

    // Try to extract STATE_JSON
    const stateMatch = text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/);
    if (stateMatch) {
        try {
            const stateData = JSON.parse(stateMatch[1]);
            return {
                success: true,
                actionType,
                ...stateData,
                rawText: text.replace(/<!-- STATE_JSON[\s\S]*?STATE_JSON -->/, '').trim()
            };
        } catch {
            // Fall through to text parsing
        }
    }

    // Return as raw text
    return {
        success: true,
        actionType,
        message: text
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTER & TOOL DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

const router = createActionRouter({
    actions: ACTIONS,
    definitions,
    threshold: 0.6
});

export const CombatManageTool = {
    name: 'combat_manage',
    description: `Unified combat encounter management. Actions: ${ACTIONS.join(', ')}.
Aliases: start/begin→create, state/status→get, finish/stop→end, restore/resume→load, next→advance, quick/spawn→spawn_quick_enemy.

⚔️ QUICK START:
- spawn_quick_enemy: Instantly create combat with preset creatures (goblin, orc, skeleton, etc.)
  Example: { action: "spawn_quick_enemy", creature: "goblin", count: 3 }

⚔️ FULL WORKFLOW:
1. create - Start encounter with custom participants and terrain
2. get - View current state
3. advance - Move to next turn
4. death_save - Roll death save for downed character
5. lair_action - Execute boss lair action
6. end - Finish combat

For combat ACTIONS (attack, move, cast), use combat_action tool instead.
For MAP operations (render, aoe, terrain), use combat_map tool instead.
For CORPSES after combat, use corpse_manage tool.`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        encounterId: z.string().optional().describe('Encounter ID (required for most actions)'),
        seed: z.string().optional().describe('Seed for new encounter (create only)'),
        participants: z.array(z.any()).optional().describe("Array of participants (create only). Shape per entry: { id: <character UUID — always the UUID>, name, hp, maxHp, initiativeBonus?: number (default 0, #103), ac?: number (falls back to attacker-side derivation), isEnemy?: boolean, position?: {x,y} }"),
        terrain: z.any().optional().describe('Terrain configuration (create only)'),
        characterId: z.string().optional().describe('Character ID (death_save, add_participant)'),
        // FINDINGS #34 mirror block — add_participant + includeParty params
        includeParty: z.boolean().optional().describe('Include the active party in the new encounter (create / spawn_quick_enemy)'),
        partyId: z.string().optional().describe('Party to include (defaults to the only active party)'),
        name: z.string().optional().describe('Ad-hoc participant name (add_participant)'),
        hp: z.number().optional().describe('Participant HP (add_participant)'),
        maxHp: z.number().optional().describe('Participant max HP (add_participant)'),
        ac: z.number().optional().describe('Participant AC (add_participant)'),
        initiativeBonus: z.number().optional().describe('Initiative bonus (add_participant)'),
        participantId: z.string().optional().describe('#67-D remove_participant: participant/token id to remove'),
        isEnemy: z.boolean().optional().describe('Hostile flag (add_participant)'),
        xpAward: z.number().optional().describe('XP credited on end'),
        xpRecipients: z.array(z.string()).optional().describe('XP recipient character IDs'),
        round: z.number().optional().describe('Round filter (get_history)'),
        limit: z.number().optional().describe('Max actions returned (get_history) / max rows (list)'),
        status: z.string().optional().describe('FINDINGS #80 (mirror): list filter — active | completed | all (default active, the ghost hunt)'),
        buryGhosts: z.boolean().optional().describe('FINDINGS #80-B (mirror): list — mark every listed ghost completed in this call'),
        confirmBury: z.boolean().optional().describe('FINDINGS #102 (mirror): override the cold-boot guard — required to bury when nothing is in process memory'),
        worldId: z.string().optional().describe('FINDINGS #105 (mirror): create — stamp the encounter to a world (else derived from first claimed participant); list — STRICT world filter, scopes the ghost sweep'),
        actionDescription: z.string().optional().describe('Lair action description'),
        targetIds: z.array(z.string()).optional().describe('Target IDs for lair action'),
        damage: z.number().optional().describe('Lair action damage'),
        damageType: z.string().optional().describe('Damage type'),
        savingThrow: z.any().optional().describe('Saving throw for lair action'),
        halfDamageOnSave: z.boolean().optional().describe('Half damage on save'),
        // spawn_quick_enemy fields
        creature: z.string().optional().describe('Creature template (e.g., "goblin", "orc:warrior")'),
        count: z.number().optional().describe('Number of enemies to spawn (1-10)'),
        position: z.object({ x: z.number(), y: z.number() }).optional().describe('Starting position')
    })
};

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export async function handleCombatManage(args: unknown, ctx: SessionContext): Promise<McpResponse> {
    try {
        const result = await router(args as Record<string, unknown>, ctx);
        const parsed = JSON.parse(result.content[0].text);

        let output = '';

        if (parsed.error) {
            output = RichFormatter.header('Error', '❌');
            output += RichFormatter.alert(parsed.message || 'Unknown error', 'error');
            if (parsed.suggestions) {
                output += '\n**Did you mean:**\n';
                parsed.suggestions.forEach((s: { value: string; similarity: number }) => {
                    output += `  • ${s.value} (${s.similarity}% match)\n`;
                });
            }
        } else {
            // Format based on action type
            switch (parsed.actionType) {
                case 'create':
                    output = RichFormatter.header('Combat Started', '⚔️');
                    if (parsed.encounterId) {
                        output += RichFormatter.keyValue({ 'Encounter ID': `\`${parsed.encounterId}\`` });
                    }
                    break;
                case 'spawn_quick_enemy':
                    output = RichFormatter.header('Quick Combat Ready', '👹');
                    if (parsed.encounterId) {
                        output += RichFormatter.keyValue({
                            'Encounter ID': `\`${parsed.encounterId}\``,
                            'Creature': parsed.creature,
                            'Count': parsed.spawnedCount
                        });
                    }
                    if (parsed.creatureStats) {
                        output += '\n**Creature Stats:**\n';
                        output += RichFormatter.keyValue({
                            'HP': parsed.creatureStats.hp,
                            'AC': parsed.creatureStats.ac,
                            'CR': parsed.creatureStats.cr || 'N/A'
                        });
                        if (parsed.creatureStats.traits?.length > 0) {
                            output += '\n**Traits:** ' + parsed.creatureStats.traits.join(', ') + '\n';
                        }
                    }
                    if (parsed.enemies?.length > 0) {
                        output += '\n**Enemies Spawned:**\n';
                        const rows = parsed.enemies.map((e: { name: string; hp: number; position: { x: number; y: number }; attack?: { name: string; damage: string } }) =>
                            [e.name, `${e.hp} HP`, `(${e.position.x}, ${e.position.y})`, e.attack?.damage || '-']
                        );
                        output += RichFormatter.table(['Name', 'HP', 'Position', 'Attack'], rows);
                    }
                    output += '\n' + RichFormatter.alert('Combat ready! Use combat_action to attack.', 'success');
                    break;
                case 'get':
                    output = RichFormatter.header('Encounter State', '📋');
                    break;
                case 'end':
                    output = RichFormatter.header('Combat Ended', '🏁');
                    if (parsed.xpNote) output += `\n⭐ ${parsed.xpNote}\n`;
                    break;
                case 'list':
                    output = RichFormatter.header('Encounters', '📋');
                    if (parsed.encounters?.length > 0) {
                        const rows = parsed.encounters.map((e: { encounterId: string; status: string; round: number; inMemory: boolean; updatedAt: string }) =>
                            [e.encounterId, e.status + (e.status === 'active' && !e.inMemory ? ' 👻 GHOST' : ''), String(e.round), e.inMemory ? 'running' : 'persisted', e.updatedAt]
                        );
                        output += RichFormatter.table(['Encounter', 'Status', 'Round', 'Engine', 'Updated'], rows);
                    }
                    break;
                case 'load':
                    output = RichFormatter.header('Encounter Loaded', '📂');
                    break;
                case 'advance':
                    output = RichFormatter.header('Turn Advanced', '⏭️');
                    break;
                case 'death_save':
                    output = RichFormatter.header('Death Save', '💀');
                    break;
                case 'lair_action':
                    output = RichFormatter.header('Lair Action', '🏰');
                    break;
                default:
                    output = RichFormatter.header('Combat', '⚔️');
            }

            // Add raw text if present
            if (parsed.rawText) {
                output += '\n' + parsed.rawText + '\n';
            } else if (parsed.message) {
                output += '\n' + parsed.message + '\n';
            }

            // Add state info if present
            if (parsed.round !== undefined) {
                output += RichFormatter.keyValue({
                    'Round': parsed.round,
                    'Active': parsed.activeParticipant || 'N/A'
                });
            }
        }

        output += RichFormatter.embedJson(parsed, 'COMBAT_MANAGE');

        return {
            content: [{
                type: 'text' as const,
                text: output
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: RichFormatter.header('Error', '') +
                    RichFormatter.alert(error instanceof Error ? error.message : String(error), 'error')
            }]
        };
    }
}
