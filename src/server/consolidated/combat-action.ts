/**
 * Consolidated Combat Action Tool
 * Wraps execute_combat_action with action-router pattern for consistent API.
 * Actions: attack, heal, move, disengage, cast_spell, dash, dodge, help, ready
 */

import { z } from 'zod';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import * as pda from '../../render/pda.js';
import { handleExecuteCombatAction, getOrLoadEngine } from '../handlers/combat-handlers.js';
import { normalizeCondition } from '../../engine/combat/conditions.js';
import { EncounterRepository } from '../../storage/repos/encounter.repo.js';
import { getCombatManager } from '../state/combat-manager.js';
import { getDomainServices } from '../domain-services.js';
import { getDb } from '../../storage/index.js';
import { CombatEngine } from '../../engine/combat/engine.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

// FINDINGS #103b/c: TWO literal tuples — the capabilities scanner text-matches
// the first ACTIONS constant declaration in the file for QUOTED strings. A
// spread (ENGINE_ACTIONS plus the grapple literal) advertised exactly one
// action; then a comment spelling the pattern verbatim advertised ZERO,
// because comments survive into dist and the scanner reads text, not syntax
// — which is why THIS comment is worded to dodge its own regex. ACTIONS goes
// first below and spells all ten; ENGINE_ACTIONS owns the router + the
// definition type and deliberately excludes grapple (intercept-before-router,
// #103). Keep the two lists in step by hand — duplication is the scanner's price.
const ACTIONS = ['attack', 'heal', 'move', 'disengage', 'cast_spell', 'dash', 'dodge', 'help', 'ready', 'grapple'] as const;
const ENGINE_ACTIONS = ['attack', 'heal', 'move', 'disengage', 'cast_spell', 'dash', 'dodge', 'help', 'ready'] as const;
type CombatAction = typeof ENGINE_ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const AttackSchema = z.object({
    action: z.literal('attack'),
    encounterId: z.string(),
    actorId: z.string(),
    targetId: z.string(),
    attackBonus: z.number().int().optional(),
    dc: z.number().int().optional(),
    damage: z.union([z.number(), z.string()]).optional(),
    damageType: z.string().optional(),
    outcome: z.enum(['hit', 'crit', 'miss']).optional().describe('A result the GM resolved at the table. The engine rolls no d20 (no nat 1/20 override) and applies damage exactly as posted: a number is never doubled; a dice string with crit doubles its dice only. Resistances, HP write-through and concentration still apply. hit/crit need damage.'),
    calledStrike: z.string().optional().describe("Table rules (called_strike): 'leg' or 'arm'. No roll penalty; a hit cripples that limb. Needs a target of your band or greater"),
    preparedAsset: z.string().optional().describe('Table rules (prepared_asset): the rule name; reports miss / hit / catastrophic tier and the effect the GM names'),
    unaffectedLimb: z.boolean().optional().describe('The attacker uses a limb its crippling condition does not touch (skips that disadvantage)'),
    advantage: z.boolean().optional(),
    disadvantage: z.boolean().optional(),
    declaredModifiers: z.array(z.object({ label: z.string(), value: z.number() })).optional().describe('FINDINGS #34 T4.18: Register-B audit trail — declared conditional traits/cover. Values are ALREADY included in attackBonus by the GM; this array only prints them in the breakdown'),
    declaredEffects: z.array(z.object({ name: z.string(), lane: z.string().optional() })).optional().describe('FINDINGS #60 RESOLVER v2: GM declares the conditional trait by name (+lane for multi-lane rows); the ENGINE computes the value from the effect row (incl. valueFromPool) and APPLIES it — unlike declaredModifiers, do NOT also fold it into attackBonus'),
    ammoItemId: z.string().optional().describe('FINDINGS #58: magazine/ammo template id in the actor inventory. When present: quantity 0 or absent REFUSES the shot (dry gun is canon); otherwise decrements ammoCount after the engine resolves — no shot without a decrement, welded'),
    ammoCount: z.number().int().min(1).optional().describe('FINDINGS #58: magazines expended this call (default 1). Exchange semantics per 01 §7 stay GM-judged; the count is the declaration'),
    hand: z.enum(['mainhand', 'offhand']).optional().describe('FINDINGS #96-C: which equipped weapon this attack resolves with (default mainhand) — decides whose COATING surfaces and debits. The two-blades law: steel main, silver off, the oil follows the hand')
});

const HealSchema = z.object({
    action: z.literal('heal'),
    encounterId: z.string(),
    actorId: z.string(),
    targetId: z.string(),
    amount: z.number().int().positive()
});

const MoveSchema = z.object({
    action: z.literal('move'),
    encounterId: z.string(),
    actorId: z.string(),
    targetPosition: z.object({ x: z.number(), y: z.number() })
});

const DisengageSchema = z.object({
    action: z.literal('disengage'),
    encounterId: z.string(),
    actorId: z.string()
});

const CastSpellSchema = z.object({
    action: z.literal('cast_spell'),
    encounterId: z.string(),
    actorId: z.string(),
    spellName: z.string(),
    targetId: z.string().optional(),
    targetIds: z.array(z.string()).optional(),
    slotLevel: z.number().int().min(1).max(9).optional()
});

const DashSchema = z.object({
    action: z.literal('dash'),
    encounterId: z.string(),
    actorId: z.string(),
    targetPosition: z.object({ x: z.number(), y: z.number() }).optional()
});

const DodgeSchema = z.object({
    action: z.literal('dodge'),
    encounterId: z.string(),
    actorId: z.string()
});

const HelpSchema = z.object({
    action: z.literal('help'),
    encounterId: z.string(),
    actorId: z.string(),
    targetId: z.string().describe('Ally to help')
});

const ReadySchema = z.object({
    action: z.literal('ready'),
    encounterId: z.string(),
    actorId: z.string(),
    readiedAction: z.string().describe('Description of the readied action'),
    trigger: z.string().describe('Trigger condition for the readied action')
});

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT HOLDER
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ACTION DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<CombatAction, ActionDefinition> = {
    attack: {
        schema: AttackSchema,
        handler: async (params: z.infer<typeof AttackSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            // ─── FINDINGS #58: THE AMMO LAW — no shot without a decrement ───
            // Order matters: dry-check BEFORE the roll (an empty gun never rolls),
            // decrement AFTER the engine resolves (a refused action isn't a shot —
            // the economy or a validation refusal must not eat the magazine).
            let adb: import('better-sqlite3').Database | undefined;
            let ammoRow: { quantity: number; name: string } | undefined;
            const ammoCount = params.ammoCount ?? 1;
            if (params.ammoItemId) {
                const { getDb } = await import('../../storage/index.js');
                adb = getDb();
                ammoRow = adb.prepare('SELECT ii.quantity, i.name FROM inventory_items ii JOIN items i ON i.id = ii.item_id WHERE ii.character_id = ? AND ii.item_id = ?').get(params.actorId, params.ammoItemId) as { quantity: number; name: string } | undefined;
                if (!ammoRow || ammoRow.quantity < ammoCount) {
                    return {
                        error: true,
                        actionType: 'attack',
                        refused: 'dry',
                        message: `DRY: ${ammoRow ? `${ammoRow.name} — ${ammoRow.quantity} left, ${ammoCount} needed` : 'no such ammo in the actor inventory'}. The hammer falls on nothing. No roll.`,
                        ammoItemId: params.ammoItemId
                    };
                }
            }
            // FINDINGS #96 (COATINGS — auto-surface): the actor's equipped mainhand
            // instance carries _coating in its attachments JSON (inventory 'coat').
            // It surfaces here as a declaredModifier (audit lane — printed, never
            // double-applied; the GM folds the bonus per Register B or into damage)
            // and debits ONE hit automatically when the attack CONNECTS.
            let coatingRead: { instanceId: string; label: string; bonus: number; remainingHits: number; name: string } | null = null;
            let coatDb: ReturnType<typeof getDb> | null = null;
            try {
                coatDb = adb ?? getDb();
                const mh = coatDb.prepare('SELECT item_id FROM inventory_items WHERE character_id = ? AND equipped = 1 AND slot = ?').get(params.actorId, params.hand ?? 'mainhand') as { item_id: string } | undefined;
                if (mh) {
                    const inst = coatDb.prepare('SELECT id, attachments FROM item_instances WHERE owner_character_id = ? AND (template_id = ? OR id = ?)').get(params.actorId, mh.item_id, mh.item_id) as { id: string; attachments: string } | undefined;
                    if (inst) {
                        const att = JSON.parse(inst.attachments || '{}') as Record<string, unknown>;
                        const c = att._coating as { label?: string; name?: string; bonus?: number; remainingHits?: number } | undefined;
                        if (c && typeof c.bonus === 'number' && (c.remainingHits ?? 0) > 0) {
                            coatingRead = { instanceId: inst.id, label: String(c.label ?? c.name ?? 'coating'), bonus: c.bonus, remainingHits: c.remainingHits ?? 0, name: String(c.name ?? 'coating') };
                        }
                    }
                }
            } catch { /* no instance layer or shape drift — attack proceeds uncoated */ }
            const declaredModifiers = coatingRead
                ? [...(params.declaredModifiers ?? []), { label: `🧪 ${coatingRead.label} (coating, ${coatingRead.remainingHits} left)`, value: coatingRead.bonus }]
                : params.declaredModifiers;
            const result = await handleExecuteCombatAction({
                encounterId: params.encounterId,
                action: 'attack',
                actorId: params.actorId,
                targetId: params.targetId,
                attackBonus: params.attackBonus,
                dc: params.dc,
                damage: params.damage,
                damageType: params.damageType,
                outcome: params.outcome,
                calledStrike: params.calledStrike,
                preparedAsset: params.preparedAsset,
                unaffectedLimb: params.unaffectedLimb,
                advantage: params.advantage,
                disadvantage: params.disadvantage,
                declaredModifiers,
                declaredEffects: params.declaredEffects
            }, ctx);
            const data = extractResultData(result, 'attack');
            // FINDINGS #96-C (BUG A, second pass — fixed against the OBSERVED payload):
            // the attack result nests everything under actionResult — the flag lives
            // at actionResult.roll.hit and damage there is an OBJECT {total, rolls}.
            // Resolve against both the top level and the actionResult core.
            const dRec = (data && typeof data === 'object') ? data as Record<string, unknown> : null;
            const arCore = (dRec?.actionResult && typeof dRec.actionResult === 'object') ? dRec.actionResult as Record<string, unknown> : null;
            const readHit = (o: Record<string, unknown> | null): boolean | undefined => {
                if (!o) return undefined;
                if (o.hit === true || o.hit === false) return o.hit as boolean;
                const r = o.roll as { hit?: boolean } | undefined;
                if (r?.hit === true || r?.hit === false) return r.hit;
                return undefined;
            };
            const dmgTotal = (o: Record<string, unknown> | null): number => {
                if (!o) return 0;
                if (typeof o.damage === 'number') return o.damage;
                const d = o.damage as { total?: number } | undefined;
                return typeof d?.total === 'number' ? d.total : 0;
            };
            const explicit = readHit(arCore) ?? readHit(dRec);
            const hitFlag = explicit !== undefined ? explicit : (dmgTotal(arCore) > 0 || dmgTotal(dRec) > 0);
            if (coatingRead && coatDb && dRec && !dRec.error && hitFlag) {
                // The edge did its work — one hit off the coating, auto-wipe at 0.
                try {
                    const inst = coatDb.prepare('SELECT attachments FROM item_instances WHERE id = ?').get(coatingRead.instanceId) as { attachments: string } | undefined;
                    if (inst) {
                        const att = JSON.parse(inst.attachments || '{}') as Record<string, unknown>;
                        const c = att._coating as { remainingHits: number } | undefined;
                        if (c) {
                            c.remainingHits -= 1;
                            const expired = c.remainingHits <= 0;
                            if (expired) delete att._coating; else att._coating = c;
                            coatDb.prepare('UPDATE item_instances SET attachments = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(att), new Date().toISOString(), coatingRead.instanceId);
                            (data as Record<string, unknown>).coating = { name: coatingRead.name, bonus: coatingRead.bonus, remainingHits: Math.max(0, c.remainingHits), expired, note: expired ? 'SPENT — the edge runs dry' : undefined };
                        }
                    }
                } catch { /* debit failed — coating state unchanged, attack result stands */ }
            } else if (coatingRead && dRec && !dRec.error) {
                dRec.coating = { name: coatingRead.name, bonus: coatingRead.bonus, remainingHits: coatingRead.remainingHits, note: 'miss — no hit debited' };
            }
            if (params.ammoItemId && adb && ammoRow && data && typeof data === 'object' && !(data as Record<string, unknown>).error) {
                adb.prepare('UPDATE inventory_items SET quantity = quantity - ? WHERE character_id = ? AND item_id = ?').run(ammoCount, params.actorId, params.ammoItemId);
                (data as Record<string, unknown>).ammo = { itemName: ammoRow.name, spent: ammoCount, remaining: ammoRow.quantity - ammoCount };
            }
            return data;
        },
        aliases: ['hit', 'strike', 'swing', 'shoot']
    },

    heal: {
        schema: HealSchema,
        handler: async (params: z.infer<typeof HealSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const result = await handleExecuteCombatAction({
                encounterId: params.encounterId,
                action: 'heal',
                actorId: params.actorId,
                targetId: params.targetId,
                amount: params.amount
            }, ctx);
            return extractResultData(result, 'heal');
        },
        aliases: ['cure', 'restore', 'mend']
    },

    move: {
        schema: MoveSchema,
        handler: async (params: z.infer<typeof MoveSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const result = await handleExecuteCombatAction({
                encounterId: params.encounterId,
                action: 'move',
                actorId: params.actorId,
                targetPosition: params.targetPosition
            }, ctx);
            return extractResultData(result, 'move');
        },
        aliases: ['walk', 'run', 'go', 'position']
    },

    disengage: {
        schema: DisengageSchema,
        handler: async (params: z.infer<typeof DisengageSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const result = await handleExecuteCombatAction({
                encounterId: params.encounterId,
                action: 'disengage',
                actorId: params.actorId
            }, ctx);
            return extractResultData(result, 'disengage');
        },
        aliases: ['retreat', 'withdraw', 'back_off']
    },

    cast_spell: {
        schema: CastSpellSchema,
        handler: async (params: z.infer<typeof CastSpellSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const result = await handleExecuteCombatAction({
                encounterId: params.encounterId,
                action: 'cast_spell',
                actorId: params.actorId,
                spellName: params.spellName,
                targetId: params.targetId,
                targetIds: params.targetIds,
                slotLevel: params.slotLevel
            }, ctx);
            return extractResultData(result, 'cast_spell');
        },
        aliases: ['cast', 'spell', 'magic', 'invoke']
    },

    dash: {
        schema: DashSchema,
        handler: async (params: z.infer<typeof DashSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');

            const sessionKey = `${ctx.sessionId}:${params.encounterId}`;
            let engine = getCombatManager().get(sessionKey);

            // Auto-load from DB if the engine isn't in memory (matches the
            // pattern in handleExecuteCombatAction). Without this, dash
            // returned "not found" after a process restart even when the
            // encounter still existed and other actions worked.
            //
            // Race-safe restore (PR #60 reviewer ask): two concurrent
            // requests can both find the engine missing and both load from
            // DB. CombatManager.create throws if the key already exists, so
            // wrap the create in a try/get fallback — the loser of the race
            // adopts the winner's engine.
            if (!engine) {
                const persisted = getDomainServices().encounter.loadState(params.encounterId);
                if (persisted) {
                    // Re-check in case another concurrent request restored it
                    // between our initial get() and now.
                    engine = getCombatManager().get(sessionKey);
                    if (!engine) {
                        const candidate = new CombatEngine(params.encounterId);
                        candidate.loadState(persisted);
                        try {
                            getCombatManager().create(sessionKey, candidate);
                            engine = candidate;
                        } catch {
                            // Lost the race — adopt the engine the winner created.
                            engine = getCombatManager().get(sessionKey);
                        }
                    }
                }
            }

            if (!engine) {
                return {
                    error: true,
                    actionType: 'dash',
                    message: `Encounter ${params.encounterId} not found.`
                };
            }
            const result = engine.applyDash(params.actorId);
            if (!result.ok) {
                return {
                    error: true,
                    actionType: 'dash',
                    actorId: params.actorId,
                    message: result.error
                };
            }
            // Save it: a reload used to lose the doubled movement and the spent action.
            const dashState = engine.getState();
            if (dashState) getDomainServices().encounter.saveState(params.encounterId, dashState);
            return {
                success: true,
                actionType: 'dash',
                actorId: params.actorId,
                movementRemaining: result.movementRemaining,
                effect: `Movement speed doubled for this turn (budget now ${result.movementRemaining}ft)`,
                message: `${params.actorId} takes the Dash action. Movement doubled; ${result.movementRemaining}ft remaining.`
            };
        },
        aliases: ['sprint', 'run', 'hustle']
    },

    dodge: {
        schema: DodgeSchema,
        handler: async (params: z.infer<typeof DodgeSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const engine = getOrLoadEngine(ctx, params.encounterId);
            if (!engine) return { error: true, actionType: 'dodge', message: `Encounter ${params.encounterId} not found.` };
            const applied = engine.applyDodge(params.actorId);
            if (!applied.ok) return { error: true, actionType: 'dodge', actorId: params.actorId, message: applied.error };
            const dodgeState = engine.getState();
            if (dodgeState) new EncounterRepository(getDb()).saveState(params.encounterId, dodgeState);
            // Attack disadvantage is applied by the engine; the DEX-save
            // advantage is on the GM, since saves are rolled outside it.
            return {
                success: true,
                actionType: 'dodge',
                actorId: params.actorId,
                effect: 'Attacks against you have disadvantage. Advantage on DEX saves until your next turn.',
                message: `${params.actorId} takes the Dodge action.`
            };
        },
        aliases: ['evade', 'defensive']
    },

    help: {
        schema: HelpSchema,
        handler: async (params: z.infer<typeof HelpSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const engine = getOrLoadEngine(ctx, params.encounterId);
            if (!engine) return { error: true, actionType: 'help', message: `Encounter ${params.encounterId} not found.` };
            const applied = engine.applyHelp(params.actorId, params.targetId);
            if (!applied.ok) return { error: true, actionType: 'help', actorId: params.actorId, message: applied.error };
            const helpState = engine.getState();
            if (helpState) new EncounterRepository(getDb()).saveState(params.encounterId, helpState);
            // The engine applies the advantage to the ally's next attack; an
            // ability check it helps is on the GM.
            return {
                success: true,
                actionType: 'help',
                actorId: params.actorId,
                targetId: params.targetId,
                effect: `${params.targetId} gains advantage on its next attack roll before ${params.actorId}'s next turn (applied by the engine), or on one ability check (GM).`,
                message: `${params.actorId} helps ${params.targetId}.`
            };
        },
        aliases: ['assist', 'aid']
    },

    ready: {
        schema: ReadySchema,
        handler: async (params: z.infer<typeof ReadySchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            // Ready holds an action for a trigger
            return {
                success: true,
                actionType: 'ready',
                actorId: params.actorId,
                readiedAction: params.readiedAction,
                trigger: params.trigger,
                effect: `Readied action: "${params.readiedAction}" when "${params.trigger}"`,
                message: `${params.actorId} readies an action.`
            };
        },
        aliases: ['prepare', 'hold', 'wait']
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
            // Fall through
        }
    }

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
    actions: ENGINE_ACTIONS,
    definitions,
    threshold: 0.6
});

export const CombatActionTool = {
    name: 'combat_action',
    description: `Execute combat actions during an encounter. Actions: ${ACTIONS.join(', ')}.

🎯 SELF-CONTAINED - This tool handles EVERYTHING for combat:
- Rolls dice internally (d20 for attacks, damage dice, saves)
- Auto-calculates attack bonus from character stats if not provided
- Auto-calculates damage from character stats if not provided
- Applies damage/healing and syncs HP to character database
- Tracks action economy (action/bonus/reaction)

DO NOT use math_manage for combat rolls - use this tool instead!

⚔️ ATTACK (minimal call):
{ action: "attack", encounterId, actorId, targetId }
Everything else auto-calculated. Returns: roll result, damage dealt, HP change.

🔮 CAST_SPELL (minimal call):
{ action: "cast_spell", encounterId, actorId, spellName, targetId }
Validates spell, rolls damage, applies effects, handles saves - all automatic.

💚 SUPPORT:
- heal - Restore HP to a target
- help - The ally's next attack before your next turn rolls with advantage (engine-applied)

🏃 MOVEMENT:
- move - Move to a position (use available movement)
- dash - Double movement speed for the turn
- disengage - Move without provoking opportunity attacks

🛡️ DEFENSIVE:
- dodge - Attacks against you roll at disadvantage until your next turn (engine-applied; DEX-save advantage is on the GM)
- ready - Prepare an action with a trigger

Aliases: hit/strike→attack, cast/spell→cast_spell, sprint→dash, evade→dodge.

🤼 GRAPPLE (FINDINGS #99 — unarmed vocabulary):
{ action: "grapple", encounterId, actorId, targetId, move: clinch|takedown|throw|slam|control|break, surface? }
Internal opposed check (Athletics vs better of Athletics/Acrobatics). Win writes conditions to the character row, and to the live encounter tokens when encounterId is given (clinch→Clinched, takedown/slam→Prone+Grappled, throw→Prone, control→Restrained, break→clears holds on the ACTOR). throw/slam ROLL surface damage (earth d4 / concrete-wall-table d6 / edge-glass d8, margin ≥5 adds a die) and RETURN it — apply via your damage lane; the encounter sheet owns mid-combat HP.`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        encounterId: z.string().describe('Encounter ID'),
        actorId: z.string().describe('ID of the acting character'),
        targetId: z.string().optional().describe('Target ID (attack, heal, help)'),
        targetIds: z.array(z.string()).optional().describe('Multiple targets (AoE spells)'),
        targetPosition: z.object({ x: z.number(), y: z.number() }).optional().describe('Target position (move, dash)'),
        attackBonus: z.number().optional().describe('Attack bonus modifier'),
        outcome: z.enum(['hit', 'crit', 'miss']).optional().describe('attack (mirror): A result the GM resolved at the table. The engine rolls no d20 (no nat 1/20 override) and applies damage exactly as posted: a number is never doubled; a dice string with crit doubles its dice only. Resistances, HP write-through and concentration still apply. hit/crit need damage.'),
        calledStrike: z.string().optional().describe("attack (mirror): Table rules (called_strike): 'leg' or 'arm'. No roll penalty; a hit cripples that limb. Needs a target of your band or greater"),
        preparedAsset: z.string().optional().describe('attack (mirror): Table rules (prepared_asset): the rule name; reports miss / hit / catastrophic tier and the effect the GM names'),
        unaffectedLimb: z.boolean().optional().describe('attack (mirror): The attacker uses a limb its crippling condition does not touch (skips that disadvantage)'),
        ammoItemId: z.string().optional().describe('FINDINGS #58 (mirror): ammo template id — dry refuses the shot; decrements after the engine resolves'),
        hand: z.enum(['mainhand', 'offhand']).optional().describe('FINDINGS #96-C (mirror): which weapon the attack resolves with — its coating surfaces and debits (default mainhand)'),
        ammoCount: z.number().optional().describe('FINDINGS #58 (mirror): magazines expended (default 1)'),
        advantage: z.boolean().optional().describe('Attack with advantage — 2d20 keep highest (mirror of inner schema, Findings #32)'),
        declaredModifiers: z.array(z.object({ label: z.string(), value: z.number() })).optional().describe('Register-B audit: declared modifiers already in attackBonus, printed in the breakdown'),
        // FINDINGS #60 (mirror law): declaredEffects — GM names the conditional
        // trait; engine computes and APPLIES the value (incl. valueFromPool).
        declaredEffects: z.array(z.object({ name: z.string(), lane: z.string().optional() })).optional().describe('RESOLVER v2: [{name, lane?}] — engine-computed conditional trait values; do NOT also fold into attackBonus'),
        disadvantage: z.boolean().optional().describe('Attack with disadvantage — 2d20 keep lowest'),
        dc: z.number().optional().describe('DC for the attack'),
        damage: z.union([z.number(), z.string()]).optional().describe('Damage amount or dice'),
        damageType: z.string().optional().describe('Damage type (fire, slashing, etc.)'),
        amount: z.number().optional().describe('Healing amount'),
        spellName: z.string().optional().describe('Spell name'),
        slotLevel: z.number().optional().describe('Spell slot level'),
        readiedAction: z.string().optional().describe('Description of readied action'),
        trigger: z.string().optional().describe('Trigger for readied action'),
        move: z.enum(['clinch', 'takedown', 'throw', 'slam', 'control', 'break']).optional().describe('FINDINGS #99 grapple: the move. clinch→Clinched · takedown/slam→Prone+Grappled · throw→Prone · control→Restrained · break→clears holds on the ACTOR'),
        surface: z.string().optional().describe("FINDINGS #99 grapple throw/slam: what they land on — earth/floor d4, concrete/wall/table d6, edge/glass/rebar d8. Free text, pattern-matched"),
        modifier: z.number().optional().describe('FINDINGS #99 grapple: situational bonus to the attacker (footing, size, surprise) — summed into the opposed roll')
    })
};

// ═══════════════════════════════════════════════════════════════════════════
// FINDINGS #99: GRAPPLE — the unarmed vocabulary. clinch / takedown / throw /
// slam / control / break as an internal opposed check (Athletics vs the
// defender's better of Athletics/Acrobatics), conditions written to the
// character rows, surface damage ROLLED and RETURNED (not applied — the
// encounter sheet owns mid-combat HP and combat_manage end overwrites
// character hp; apply the number via your damage lane).
// ═══════════════════════════════════════════════════════════════════════════

const GRAPPLE_MOVES = ['clinch', 'takedown', 'throw', 'slam', 'control', 'break'] as const;
type GrappleMove = typeof GRAPPLE_MOVES[number];
const GRAPPLE_CONDITIONS = ['Clinched', 'Grappled', 'Restrained'];

function surfaceDie(surface?: string): { die: number; label: string } {
    const s = (surface ?? '').toLowerCase();
    if (/edge|corner|glass|rebar|spike|kerb|curb/.test(s)) return { die: 8, label: surface ?? 'hard edge' };
    if (/concrete|stone|wall|asphalt|table|furniture|bar|metal|steel|brick|tile/.test(s)) return { die: 6, label: surface ?? 'hard surface' };
    return { die: 4, label: surface ?? 'the ground' };
}

function grappleResolve(args: Record<string, unknown>): Record<string, unknown> {
    const actorId = String(args.actorId ?? '');
    const targetId = String(args.targetId ?? '');
    const moveRaw = String(args.move ?? args.action ?? 'clinch').toLowerCase().replace('break_grapple', 'break');
    const move = (GRAPPLE_MOVES as readonly string[]).includes(moveRaw) ? moveRaw as GrappleMove : null;
    if (!move) return { error: true, writes: 'none', message: `grapple needs move: ${GRAPPLE_MOVES.join(' | ')}` };
    if (!actorId || !targetId) return { error: true, writes: 'none', message: 'grapple needs actorId + targetId' };

    const db = getDb();
    const repo = new CharacterRepository(db);
    type CRow = { id: string; name: string; level?: number; stats?: { str?: number; dex?: number }; skillProficiencies?: string[]; conditions?: Array<{ name: string; duration?: number; source?: string }> };
    const actor = repo.findById(actorId) as unknown as CRow | null;
    const target = repo.findById(targetId) as unknown as CRow | null;
    if (!actor) return { error: true, writes: 'none', message: `No character ${actorId}` };
    if (!target) return { error: true, writes: 'none', message: `No character ${targetId}` };

    const mod = (v?: number) => Math.floor(((v ?? 10) - 10) / 2);
    const prof = (c: CRow) => 2 + Math.floor((((c.level ?? 1) as number) - 1) / 4);
    const hasProf = (c: CRow, skills: string[]) => (c.skillProficiencies ?? []).some(s => skills.includes(String(s).toLowerCase()));
    const d = (sides: number) => Math.floor(Math.random() * sides) + 1;

    const atkStat = Math.max(mod(actor.stats?.str), mod(actor.stats?.dex));
    const atkProf = hasProf(actor, ['athletics']) ? prof(actor) : 0;
    const situational = typeof args.modifier === 'number' ? args.modifier : 0;
    const defStat = Math.max(mod(target.stats?.str), mod(target.stats?.dex));
    const defProf = hasProf(target, ['athletics', 'acrobatics']) ? prof(target) : 0;

    const atkRoll = d(20); const defRoll = d(20);
    const atkTotal = atkRoll + atkStat + atkProf + situational;
    const defTotal = defRoll + defStat + defProf;
    const margin = atkTotal - defTotal;
    const win = margin > 0; // tie holds with the defender

    const breakdown = `${actor.name} d20(${atkRoll})+${atkStat}stat+${atkProf}prof${situational ? `+${situational}situational` : ''} = ${atkTotal}  vs  ${target.name} d20(${defRoll})+${defStat}stat+${defProf}prof = ${defTotal}`;

    const mergeConditions = (c: CRow, add: Array<{ name: string; source: string }>, remove: string[] = []) => {
        let list = (c.conditions ?? []).slice();
        const rm = new Set(remove.map(n => n.toLowerCase()));
        if (rm.size) list = list.filter(x => !rm.has(x.name.toLowerCase()));
        for (const a of add) {
            const i = list.findIndex(x => x.name.toLowerCase() === a.name.toLowerCase());
            if (i >= 0) list[i] = { ...list[i], ...a }; else list.push(a);
        }
        repo.update(c.id, { conditions: list } as never);
        return list;
    };

    if (!win) {
        return {
            success: true, actionType: 'grapple', move, hit: false, breakdown, margin,
            writes: 'none',
            message: move === 'break'
                ? `${actor.name} fights the hold and loses it — still held. ${breakdown}`
                : `${target.name} shrugs the ${move} off — no change. ${breakdown}`
        };
    }

    const src = `grapple: ${actor.name}`;
    let applied: string[] = []; let removed: string[] = [];
    let surfaceDamage: number | undefined; let damageDetail: string | undefined;

    switch (move) {
        case 'clinch':
            mergeConditions(target, [{ name: 'Clinched', source: src }]); applied = ['Clinched']; break;
        case 'takedown':
            mergeConditions(target, [{ name: 'Prone', source: src }, { name: 'Grappled', source: src }]); applied = ['Prone', 'Grappled']; break;
        case 'control':
            mergeConditions(target, [{ name: 'Restrained', source: src }]); applied = ['Restrained']; break;
        case 'throw': case 'slam': {
            const surf = surfaceDie(typeof args.surface === 'string' ? args.surface : undefined);
            const dice = margin >= 5 ? 2 : 1;
            const rolls = Array.from({ length: dice }, () => d(surf.die));
            surfaceDamage = rolls.reduce((a, b) => a + b, 0);
            damageDetail = `${dice}d${surf.die} [${rolls.join(',')}] into ${surf.label}${margin >= 5 ? ' (margin ≥5: extra die)' : ''}`;
            if (move === 'throw') { mergeConditions(target, [{ name: 'Prone', source: src }]); applied = ['Prone']; }
            else { mergeConditions(target, [{ name: 'Prone', source: src }, { name: 'Grappled', source: src }]); applied = ['Prone', 'Grappled']; }
            break;
        }
        case 'break':
            mergeConditions(actor, [], GRAPPLE_CONDITIONS); removed = GRAPPLE_CONDITIONS; break;
    }

    return {
        success: true, actionType: 'grapple', move, hit: true, breakdown, margin,
        ...(applied.length ? { conditionsApplied: applied, onto: target.name } : {}),
        ...(removed.length ? { conditionsRemoved: removed, from: actor.name } : {}),
        ...(surfaceDamage !== undefined ? { surfaceDamage, damageDetail, applyNote: 'surface damage is ROLLED, not applied — post it with attack {outcome: \"hit\", damage: N} on the target (no engine d20, no crit doubling), or combat_manage adjust_hp. The encounter sheet owns mid-combat HP.' } : {}),
        message: move === 'break'
            ? `${actor.name} breaks the hold — ${GRAPPLE_CONDITIONS.join('/')} cleared. ${breakdown}`
            : `${actor.name} lands the ${move} on ${target.name}${applied.length ? ` — ${applied.join(' + ')}` : ''}${surfaceDamage !== undefined ? `, ${surfaceDamage} surface damage (${damageDetail})` : ''}. ${breakdown}`
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export async function handleCombatAction(args: unknown, ctx: SessionContext): Promise<McpResponse> {
    // FINDINGS #99: grapple intercepts before the inner engine — it is not an
    // engine action; it resolves here and returns.
    const a = args as Record<string, unknown>;
    const actName = String(a?.action ?? '').toLowerCase();
    if (actName === 'grapple' || actName === 'clinch' || actName === 'takedown' || actName === 'slam' || actName === 'break_grapple') {
        const result = grappleResolve(a);
        // With an encounterId the hold lands on the live tokens too, not only
        // the character sheets, so the engine's mechanics see Prone/Grappled.
        if (!result.error && typeof a.encounterId === 'string' && a.encounterId && (result.conditionsApplied || result.conditionsRemoved)) {
            const engine = getOrLoadEngine(ctx, a.encounterId);
            const state = engine?.getState();
            if (engine && state) {
                const onto = String(a.targetId ?? ''), from = String(a.actorId ?? '');
                const src = `grapple: ${String(a.actorId ?? '')}`;
                for (const name of (result.conditionsApplied as string[] | undefined) ?? []) {
                    const tok = state.participants.find(p => p.id === onto);
                    const c = tok && normalizeCondition({ name, source: src }, tok.id);
                    if (tok && c) {
                        tok.conditions = tok.conditions.filter(x => x.type.toLowerCase() !== c.type.toLowerCase());
                        const { id: _id, ...rest } = c; void _id;
                        engine.applyCondition(tok.id, rest);
                    }
                }
                const drop = new Set(((result.conditionsRemoved as string[] | undefined) ?? []).map(n => n.toLowerCase()));
                const actorTok = state.participants.find(p => p.id === from);
                if (actorTok && drop.size) actorTok.conditions = actorTok.conditions.filter(x => !drop.has(x.type.toLowerCase()));
                new EncounterRepository(getDb()).saveState(a.encounterId, state);
                result.encounterTokensUpdated = true;
            }
        }
        let out = result.error ? RichFormatter.error(String(result.message)) : RichFormatter.header(`Grapple — ${String(result.move)}`, '🤼') + RichFormatter.alert(String(result.message), 'info');
        out += RichFormatter.embedJson(result, 'COMBAT_ACTION');
        return { content: [{ type: 'text', text: out }] };
    }

    const response = await router(args as Record<string, unknown>, ctx);

    // Wrap response with ASCII formatting
    try {
        const parsed = JSON.parse(response.content[0].text);
        let output = '';

        if (parsed.error) {
            // FINDINGS #64: refusals via the payload-gated renderer — NO WRITE
            // prints iff the throw site asserted writes:'none'.
            output = pda.refuseFromPayload(parsed);
            if (parsed.validActions) {
                output += RichFormatter.section('Valid Actions');
                output += RichFormatter.list(parsed.validActions);
            }
        } else {
            // Format based on action type
            switch (parsed.actionType) {
                case 'attack':
                    output = RichFormatter.header('Attack', '⚔️');
                    if (parsed.hit !== undefined) {
                        output += RichFormatter.keyValue({
                            'Result': parsed.hit ? '🎯 HIT' : '💨 MISS',
                            'Roll': parsed.roll || 'N/A',
                            'vs AC': parsed.targetAC || 'N/A',
                            'Damage': parsed.hit ? (parsed.damage || 0) : '-'
                        });
                        if (parsed.damageType) {
                            output += `Damage type: ${parsed.damageType}\n`;
                        }
                    }
                    break;
                case 'heal':
                    output = RichFormatter.header('Healing', '💚');
                    output += RichFormatter.keyValue({
                        'Target': parsed.targetId || 'Unknown',
                        'HP Restored': parsed.amount || 0
                    });
                    break;
                case 'move':
                    output = RichFormatter.header('Movement', '🏃');
                    output += RichFormatter.keyValue({
                        'Actor': parsed.actorId,
                        'Position': parsed.targetPosition ? `(${parsed.targetPosition.x}, ${parsed.targetPosition.y})` : 'N/A'
                    });
                    break;
                case 'cast_spell':
                    output = RichFormatter.header('Spell Cast', '✨');
                    output += RichFormatter.keyValue({
                        'Spell': parsed.spellName || 'Unknown',
                        'Caster': parsed.actorId,
                        'Target': parsed.targetId || parsed.targetIds?.join(', ') || 'N/A'
                    });
                    break;
                case 'disengage':
                    output = RichFormatter.header('Disengage', '🔙');
                    output += `${parsed.actorId} disengages, avoiding opportunity attacks.\n`;
                    break;
                case 'dash':
                    output = RichFormatter.header('Dash', '💨');
                    output += `${parsed.actorId} dashes, doubling movement speed.\n`;
                    break;
                case 'dodge':
                    output = RichFormatter.header('Dodge', '🛡️');
                    output += `${parsed.actorId} takes the Dodge action.\n`;
                    break;
                case 'help':
                    output = RichFormatter.header('Help', '🤝');
                    output += `${parsed.actorId} helps ${parsed.targetId}.\n`;
                    break;
                case 'ready':
                    output = RichFormatter.header('Ready Action', '⏳');
                    output += RichFormatter.keyValue({
                        'Action': parsed.readiedAction,
                        'Trigger': parsed.trigger
                    });
                    break;
                default:
                    output = RichFormatter.header('Combat Action', '⚔️');
            }

            // Add effect/message
            if (parsed.effect) {
                output += RichFormatter.alert(parsed.effect, 'info');
            }
            if (parsed.rawText) {
                output += '\n' + parsed.rawText + '\n';
            } else if (parsed.message && !parsed.effect) {
                output += parsed.message + '\n';
            }
            // FINDINGS #59: formatter parity (#35) — the ammo decrement prints in
            // the banner, not only the JSON. A tool that mutates persistent state
            // says so out loud (#38/#50/#51 triptych law).
            if (parsed.ammo) {
                output += `\n▣ mag ${parsed.ammo.itemName} — spent ${parsed.ammo.spent}, ${parsed.ammo.remaining} left\n`;
            }
        }

        // Embed JSON for programmatic access
        output += RichFormatter.embedJson(parsed, 'COMBAT_ACTION');

        return { content: [{ type: 'text', text: output }] };
    } catch {
        // If JSON parsing fails, return original response
        return response;
    }
}
