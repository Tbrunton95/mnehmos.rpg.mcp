/**
 * Consolidated Combat Action Tool
 * Wraps execute_combat_action with action-router pattern for consistent API.
 * Actions: attack, heal, move, disengage, cast_spell, dash, dodge, help, ready
 */

import { z } from 'zod';
import { createActionRouter, ActionDefinition, McpResponse, ignoredParamsOf, describeIgnoredParams } from '../../utils/action-router.js';
import { MANEUVER_NAMES } from '../../engine/combat/maneuvers.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import * as pda from '../../render/pda.js';
import { handleExecuteCombatAction, getOrLoadEngine, liveEncounterFor } from '../handlers/combat-handlers.js';
import { worldProgression } from '../../engine/progression.js';
import { damageWithModifiers, type DamageDefences, type DamageModifier } from '../../engine/combat/damage-modifiers.js';
import { concentrationAfterDamage } from '../../engine/magic/concentration.js';
import { ConcentrationRepository } from '../../storage/repos/concentration.repo.js';
import { creditKill, growthLine } from '../growth.js';
import { volleyTier } from '../../engine/combat/units.js';
import { normalizeCondition, holderMatch, sourceNamesHolder, helplessReason, HOLD_CONDITIONS, PIN_CONDITIONS } from '../../engine/combat/conditions.js';
import { parseDiceTerms } from '../../engine/combat/rng.js';
import { EncounterRepository } from '../../storage/repos/encounter.repo.js';
import { getCombatManager } from '../state/combat-manager.js';
import { getDomainServices } from '../domain-services.js';
import { getDb } from '../../storage/index.js';
import { CombatEngine } from '../../engine/combat/engine.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import type { CombatParticipant } from '../../engine/combat/engine.js';
import { bandOrderFor, bandRuleFor, bandDamageMultiplier, compareBands, resolveWorldId, type TableRule } from '../../engine/table-rules.js';
import { sizeRank } from '../../schema/encounter.js';
import { READIED_TRIGGERS, ReadiedAttackSchema, type Ability } from '../../schema/token-extras.js';
import { findActionGrantAcross, patchRowAbility } from '../../engine/combat/abilities.js';
import { loggedD20, loggedDice, loggedRoll } from '../../math/logged-d20.js';
import { resolveNamedSources, loadEffectNames, jsonIfString, sourcesField } from '../../engine/advantage-sources.js';

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
const ACTIONS = ['attack', 'heal', 'move', 'disengage', 'cast_spell', 'dash', 'dodge', 'help', 'ready', 'volley', 'grapple'] as const;
const ENGINE_ACTIONS = ['attack', 'heal', 'move', 'disengage', 'cast_spell', 'dash', 'dodge', 'help', 'ready', 'volley'] as const;
type CombatAction = typeof ENGINE_ACTIONS[number];
const GRAPPLE_MOVES = ['clinch', 'takedown', 'throw', 'slam', 'control', 'break', 'execute'] as const;
type GrappleMove = typeof GRAPPLE_MOVES[number];

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
    calledStrike: z.string().optional().describe("Table rules (called_strike): 'leg', 'arm' or any named part of the target ('jaw', 'collar chain'). No roll penalty; a hit cripples that part (it keeps its kind). Needs a target of your band or greater"),
    preparedAsset: z.string().optional().describe('Table rules (prepared_asset): the rule name; reports miss / hit / catastrophic tier and the effect the GM names'),
    unaffectedLimb: z.boolean().optional().describe('The attacker uses a limb its crippling condition does not touch (skips that disadvantage)'),
    withPart: z.string().optional().describe("The attacker's named part used: crippled = disadvantage; dead or latched = refused"),
    using: z.string().optional().describe("Named attack profile on the token or sheet ('grown blade'; unique prefix ok): fills attackBonus, damage, damageType and the part when omitted"),
    weapon: z.string().optional().describe("Alias of using; also finds the part whose holds names this weapon (its crippled state applies)"),
    atPart: z.string().optional().describe('The target part aimed at: breached = advantage; a called strike cripples this part'),
    ranged: z.boolean().optional().describe('A ranged attack (not within 5 ft): a prone target is disadvantage and paralysed/unconscious no auto-crit. Unset = from token positions, else melee'),
    twoHanded: z.boolean().optional().describe('Item 17: this swing is made with both hands (a versatile weapon): great weapon fighting applies, dueling does not. Default from the profile'),
    maneuver: z.enum(MANEUVER_NAMES).optional().describe("Item 16: a Battle Master manoeuvre on this swing, paid from the sheet's superiority pool (refused before any roll when it cannot be). trip / menacing / disarming: the superiority die joins the damage on a hit and the target saves (STR / WIS / STR) at 8 + proficiency + STR or DEX; precision: the die is added to a miss it could turn; riposte: a reaction (reaction: true) against a creature that missed you in melee this round"),
    maneuverItem: z.string().optional().describe("disarming: what the target drops (one of its part's holds; default the first held item)"),
    ignoreConditions: z.boolean().optional().describe('Skip the automatic advantage/disadvantage/auto-crit from standard conditions (raw roll)'),
    cleave: z.boolean().optional().describe('Cleave a packed unit of a lower band: damage flows through models'),
    bandScale: z.boolean().optional().describe("false skips the band rule's damageScale for this swing. Default: applied when the world's band rule has damageScale and both bands are set (result bandScale {steps, multiplier, before, after})"),
    legendaryCost: z.number().int().min(1).optional().describe("A legendary action: spends this many of the creature's legendary actions instead of its action (off its own turn only)"),
    reaction: z.boolean().optional().describe('An attack as a reaction (opportunity attack, readied swing): spends the reaction instead of the action'),
    actionSurge: z.union([z.boolean(), z.string()]).optional().describe("When the action is already spent: spend a ready action-granting ability (true = the first one with grantsAction; a string names it; token first, then the sheet) for an extra action and swing. A no-op while the action is still free (result actionSurge.spent: false)"),
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

/** A fresh instance each call: the outer mirror must not hold one zod object twice. */
const spellBoostSchema = () => z.object({
    pool: z.string().min(1).describe("The pool spent ('warpstone')"),
    delta: z.number().describe('Signed; a spend is negative (-1)'),
    modifier: z.number().int().optional().describe('Flat bonus on the casting roll'),
    extraDice: z.string().optional().describe("Extra dice added to the casting roll ('1d6')"),
    sideEffect: z.array(z.object({ pool: z.string().min(1), delta: z.number() })).optional().describe("Pools that move with the spend ([{pool: 'warpstone_taint', delta: 1}]); each runs the growth check")
});

const CastSpellSchema = z.object({
    action: z.literal('cast_spell'),
    encounterId: z.string(),
    actorId: z.string(),
    spellName: z.string(),
    targetId: z.string().optional(),
    targetIds: z.array(z.string()).optional(),
    slotLevel: z.number().int().min(1).max(9).optional(),
    unbinderId: z.string().optional().describe("A world spell with contestedBy: 'unbind': this participant rolls the casting dice; a higher total stops it"),
    boost: spellBoostSchema().optional().describe('World spell: spend a pool for +modifier and/or extraDice on the casting roll; sideEffect pools move too (growth-checked). Refused if the pool cannot pay')
});

const VolleySchema = z.object({
    action: z.literal('volley'),
    encounterId: z.string(),
    actorId: z.string().describe('The unit token firing'),
    targetId: z.string(),
    outcome: z.enum(['hit', 'crit', 'miss']).optional().describe('GM-posted result: no engine d20; damage is still the tier dice unless damage is given'),
    damage: z.union([z.number(), z.string()]).optional().describe('GM-posted damage (with outcome)'),
    damageType: z.string().optional(),
    atPart: z.string().optional(),
    advantage: z.boolean().optional(),
    disadvantage: z.boolean().optional()
});

const GRAPPLE_SOURCE_NOTE = "grapple: a miss or an ambiguous name REFUSES the move before any roll or spend (writes: none) — a grapple spends the attack and writes conditions, so nothing is guessed. Logged in the roll's purpose.";

/**
 * FINDINGS #99 / play report 4: grapple is intercepted before the router (it
 * is not an engine action, see handleCombatAction), so this schema never
 * parses a call. It is the action's contract for the mirror audit and
 * search_tools, and the shape the grapple branch checks ignored params
 * against. Keep it a plain z.object: ignoredParamsOf reads .shape.
 */
const GrappleSchema = z.object({
    action: z.literal('grapple'),
    encounterId: z.string().optional().describe('Optional: two live tokens in one fight are routed there; none runs on the character sheets'),
    actorId: z.string(),
    targetId: z.string(),
    move: z.enum(GRAPPLE_MOVES).optional().describe('clinch | takedown | throw | slam | control | break | execute — required with action: grapple; the aliases clinch, takedown, slam and break_grapple name it themselves'),
    surface: z.string().optional().describe('throw/slam: what they land on (earth d4, concrete/wall/table d6, edge/glass d8)'),
    control: z.boolean().optional().describe('Pin instead of hurt: Grappled + Restrained, no surface damage'),
    outcome: z.enum(['win', 'lose']).optional().describe('A result the table already resolved: no d20, the attack is still spent'),
    damage: z.union([z.number(), z.string()]).optional().describe('With a posted win: the throw/slam surface damage (number as posted, dice rolled); execute: the posted crit'),
    damageType: z.string().optional().describe('execute: the damage type (resistances apply)'),
    modifier: z.number().optional().describe('Situational bonus to the actor (footing, surprise), summed into the opposed roll'),
    actionSurge: z.union([z.boolean(), z.string()]).optional().describe('When the action is spent: spend a ready grantsAction ability for an extra action'),
    advantage: z.boolean().optional().describe('The actor rolls 2d20 keep highest (the GM\'s ruling; cancels against any disadvantage to one die)'),
    disadvantage: z.boolean().optional().describe('The actor rolls 2d20 keep lowest; the lower band or smaller size is automatic and never stacks'),
    advantageSources: sourcesField('advantage', GRAPPLE_SOURCE_NOTE),
    disadvantageSources: sourcesField('disadvantage', GRAPPLE_SOURCE_NOTE)
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
    trigger: z.string().describe('Trigger condition for the readied action'),
    on: z.enum(READIED_TRIGGERS).optional().describe('enters_reach | leaves_reach: the engine watches moves and fires it. Unset = fired by hand with combat_manage trigger_readied'),
    watch: z.string().optional().describe("Who sets it off: a participant id or name, 'enemy' (default) or 'any'"),
    attack: ReadiedAttackSchema.optional().describe('{using?, attackBonus?, damage?, damageType?, withPart?}: the attack it makes; with on set it fires itself as a reaction')
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
                withPart: params.withPart,
                using: params.using,
                weapon: params.weapon,
                hand: params.hand,
                atPart: params.atPart,
                ranged: params.ranged,
                twoHanded: params.twoHanded,
                maneuver: params.maneuver,
                maneuverItem: params.maneuverItem,
                ignoreConditions: params.ignoreConditions,
                cleave: params.cleave,
                bandScale: params.bandScale,
                legendaryCost: params.legendaryCost,
                reaction: params.reaction,
                actionSurge: params.actionSurge,
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
                slotLevel: params.slotLevel,
                unbinderId: params.unbinderId,
                boost: params.boost
            }, ctx);
            return extractResultData(result, 'cast_spell');
        },
        aliases: ['cast', 'spell', 'magic', 'invoke']
    },

    volley: {
        schema: VolleySchema,
        handler: async (params: z.infer<typeof VolleySchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const unitTok = engine?.getState()?.participants.find(p => p.id === params.actorId);
            if (!engine || !unitTok) return { error: true, actionType: 'volley', message: `Encounter ${params.encounterId} or unit ${params.actorId} not found` };
            if (!unitTok.unit) return { error: true, actionType: 'volley', message: `${unitTok.name} is not a unit token (add unit: {models, hpPerModel, ...})` };
            if (unitTok.unit.routed) return { error: true, writes: 'none', actionType: 'volley', message: `${unitTok.name} is routed and cannot volley (rally it with combat_manage set_unit {routed: false})` };
            const tier = volleyTier(unitTok)!;
            if (!tier.dice) return { error: true, actionType: 'volley', message: `${unitTok.name} has no models left to fire` };
            // One d20 against AC with the unit's attack bonus; on a hit the
            // tier's dice land through the normal attack path.
            const result = await handleExecuteCombatAction({
                encounterId: params.encounterId,
                action: 'attack',
                actorId: params.actorId,
                targetId: params.targetId,
                attackBonus: unitTok.unit.attackBonus,
                damage: params.damage ?? tier.dice,
                damageType: params.damageType,
                outcome: params.outcome,
                atPart: params.atPart,
                advantage: params.advantage,
                disadvantage: params.disadvantage,
                volley: { dice: tier.dice, reason: tier.reason }
            }, ctx);
            return extractResultData(result, 'volley');
        },
        aliases: ['fire', 'salvo', 'unit_attack']
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
            const dasher = engine.getState()?.participants.find(p => p.id === params.actorId);
            // A banked extra action (Action Surge) pays for a second Dash; say so.
            const extrasBefore = dasher?.extraActions ?? 0;
            const result = engine.applyDash(params.actorId);
            if (!result.ok) {
                return {
                    error: true,
                    actionType: 'dash',
                    actorId: params.actorId,
                    message: result.error
                };
            }
            const dashes = dasher?.dashes ?? 1;
            const extraActionSpent = extrasBefore > 0 && (dasher?.extraActions ?? 0) < extrasBefore;
            // Save it: a reload used to lose the doubled movement and the spent action.
            const dashState = engine.getState();
            if (dashState) getDomainServices().encounter.saveState(params.encounterId, dashState);
            return {
                success: true,
                actionType: 'dash',
                actorId: params.actorId,
                movementRemaining: result.movementRemaining,
                dashes,
                ...(extraActionSpent ? { extraActionSpent: true } : {}),
                effect: dashes > 1
                    ? `Dash ${dashes}: one more speed allotment this turn (budget now ${result.movementRemaining}ft)`
                    : `Movement speed doubled for this turn (budget now ${result.movementRemaining}ft)`,
                message: `${params.actorId} takes the Dash action${dashes > 1 ? ` again (dash ${dashes})` : ''}. Movement ${dashes > 1 ? 'extended' : 'doubled'}; ${result.movementRemaining}ft remaining.${extraActionSpent ? ` ⚡ The extra action (Action Surge) paid for it; ${dasher?.extraActions ?? 0} left.` : ''}`
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
            // Ready holds an action for a trigger: it is written on the token
            // (so a move can set it off) and spends the action. An action
            // already spent warns rather than refuses (item 11, one release).
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return { error: true, actionType: 'ready', message: `Encounter ${params.encounterId} not found.` };
            const p = state.participants.find(x => x.id === params.actorId);
            if (!p) return { error: true, actionType: 'ready', actorId: params.actorId, message: `Participant ${params.actorId} not in this encounter` };
            const economy = engine.validateActionEconomy(p.id, 'action');
            // A banked extra action (Action Surge) pays for the Ready; say so.
            const extrasBefore = p.extraActions ?? 0;
            engine.commitAction(p.id, 'action');
            const extraActionSpent = extrasBefore > 0 && (p.extraActions ?? 0) < extrasBefore;
            p.readied = {
                action: params.readiedAction,
                trigger: params.trigger,
                ...(params.on ? { on: params.on } : {}),
                ...(params.watch ? { watch: params.watch } : {}),
                ...(params.attack ? { attack: params.attack } : {})
            };
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            const fires = params.on
                ? ` It fires itself when ${params.watch ?? 'an enemy'} ${params.on === 'enters_reach' ? 'enters' : 'leaves'} ${p.name}'s reach${params.attack ? ' (attack rolled as a reaction)' : ' (flagged for trigger_readied)'}.`
                : ' Fire it with combat_manage trigger_readied.';
            return {
                success: true,
                actionType: 'ready',
                actorId: params.actorId,
                readiedAction: params.readiedAction,
                trigger: params.trigger,
                readied: p.readied,
                ...(economy.valid ? {} : { warning: `${economy.error}; readied anyway` }),
                ...(extraActionSpent ? { extraActionSpent: true } : {}),
                effect: `Readied action: "${params.readiedAction}" when "${params.trigger}".${fires}`,
                message: `${p.name} readies an action.${extraActionSpent ? ` ⚡ The extra action (Action Surge) paid for it; ${p.extraActions ?? 0} left.` : ''}`
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
Everything else auto-calculated. Returns: roll result, damage dealt, HP change. When the world's band rule carries damageScale and both bands are set, damage is scaled by the band gap (result bandScale {steps, multiplier, before, after}; bandScale: false skips it for one swing). Spells, heals and execute are never band-scaled.
⚡ actionSurge: true | 'Action Surge' (attack and grapple): when the action is already spent, spends a ready ability with grantsAction (token first, then the sheet) for one extra action and swings; the spend is mirrored to the sheet. While the action is still free it is a no-op (actionSurge.spent: false). To bank the action without swinging, combat_manage use_ability.
🗡 FIGHTING STYLES (sheet fightingStyle; token inherits): archery +2 to hit when ranged; great_weapon rerolls weapon dice of 1-2 once on a two-handed melee hit (twoHanded on the profile or the call; crit dice too, never added dice); dueling +2 damage on a one-handed melee hit; defense +1 to the target's derived AC while it wears equipped armour (pass dc, or leave defense unset, if the sheet's ac already counts it). Result fightingStyle {style, applied, ...}. A posted outcome takes none.
🎲 MANOEUVRES (maneuver: trip | precision | riposte | menacing | disarming): the sheet needs superiorityDie ('1d8') and a superiority pool (character_manage adjust_pool {pool: 'superiority', value: 4, max: 4, refresh: 'short'}); a missing die or pool, a posted outcome, a volley or cleave are refused before any roll (writes: none). trip / menacing / disarming add the die to a hit's damage (doubled on a crit, never rerolled) and the target saves STR / WIS / STR against 8 + proficiency + STR or DEX (maneuverAbility): a failed save means prone (not above Large) / frightened of you until the end of your next turn / the held item (maneuverItem, else the first in the part's holds) falls as a prop. precision rolls the die only on a miss it could make up (never a natural 1) and folds it into roll.bonus / roll.total. riposte needs reaction: true and a melee miss by the target against you this round. The die is spent only when it was rolled (result maneuver {name, die, roll, spent, pool: {before, after}, dc?, save?, applied?, turnedHit?}); the pool's history carries the reason.

🔮 CAST_SPELL (minimal call):
{ action: "cast_spell", encounterId, actorId, spellName, targetId }
Validates spell, rolls damage, applies effects, handles saves - all automatic. A world spell (table_rules kind spell) takes boost {pool, delta, modifier?, extraDice?, sideEffect?: [{pool, delta}]}: spend a pool (warpstone -1) for +modifier / +extraDice on the casting roll, with side-effect pools (taint +1); refused if the pool cannot pay. Spell costs, boosts and side effects all run the growth check (growth_track rungs fire or are offered; result worldSpell.boost / growthApplied / growthReady).

💚 SUPPORT:
- heal - Restore HP to a target
- help - The ally's next attack before your next turn rolls with advantage (engine-applied)

🏃 MOVEMENT:
- move - Move to a position (use available movement)
- dash - Double movement speed for the turn
- disengage - Move without provoking opportunity attacks
  (a move provokes along its whole path, after it is validated; NPC reactors roll, a PC reactor is offered in opportunityAttacksAvailable with the exact attack {reaction: true} call)

🛡️ DEFENSIVE:
- dodge - Attacks against you roll at disadvantage until your next turn (engine-applied; DEX-save advantage is on the GM)
- ready - Prepare an action with a trigger (spends the action). on: enters_reach | leaves_reach + watch + attack {…} makes the engine fire it as a reaction during a move; without attack it is flagged for combat_manage trigger_readied

Aliases: hit/strike→attack, cast/spell→cast_spell, sprint→dash, evade→dodge.

🤼 GRAPPLE (FINDINGS #99 — unarmed vocabulary):
{ action: "grapple", encounterId?, actorId, targetId, move: clinch|takedown|throw|slam|control|break|execute, surface?, control?, outcome?: win|lose, damage?, modifier?, advantage?, disadvantage?, advantageSources?, disadvantageSources? }
Internal opposed check (Athletics vs better of Athletics/Acrobatics) on the fight's logged dice; with encounterId it spends one attack (break spends the action; actionSurge: true reopens a spent action from a grantsAction ability), and tokens without a sheet can grapple. Grapple is the ONE action that works without encounterId: two live tokens in one fight are routed there (routedToEncounter); one side in a fight, or two fights, is refused; neither in a fight runs on the character sheets with logged dice, the world's proficiency curve and expertise. execute on sheets kills through character_manage kill (HP 0, concentration ended, a corpse row; writesTo 'sheet'); in a fight it only drops the token to 0 HP. An execute with no damage is a coup de grâce (its HP, defences bypassed); posted or dice damage respects resistances. The lower band or smaller size rolls at disadvantage automatically (reasons in situational). ADVANTAGE (play report 4): the ACTOR's roll mode is the GM's advantage/disadvantage flag plus named sources — advantageSources / disadvantageSources name what is on the actor (its token conditions, sheet conditions or active effects; math_manage's rule: exact beats prefix beats substring, one hit) — plus the automatic band/size rule; advantage and disadvantage together cancel to one die (rollMode {actor, defender}; situational prints 'Marine: advantage (GM; Bulwark)' or the cancel line; the roll_log purpose reads 'grapple (adv: GM, Bulwark; dis: lower band)' and stays 'grapple' with no reasons). The defender keeps only its automatic disadvantage. A source that matches nothing or two things is REFUSED before any roll or spend (writes: none) — a grapple writes, so nothing is guessed; posted outcomes and helpless targets roll no contest, so flags and sources are noted as ignored there. Keys grapple does not use come back in ignoredParams. A target more than one size larger is refused, and throw/slam of anything larger. A helpless target — unconscious, asleep, incapacitated, paralysed, stunned, petrified or at 0 HP, read from its token when it has one, else its sheet — is held without a contest (house ruling; autoWin.reason says why; a break against a helpless holder succeeds the same way); a helpless ACTOR is refused on the sheets as the engine refuses it in a fight. outcome: win|lose posts a result the table already resolved: no d20, the attack is still spent (lose writes nothing); with a win, damage is the throw/slam surface damage (a number as posted, dice rolled on the fight's dice), still band-scaled. Win writes conditions to the character row, and to the live encounter tokens when encounterId is given (clinch→Clinched, takedown/slam→Prone+Grappled, throw→Prone, control→Restrained, break→clears the ACTOR's holds from targetId: holds sourced 'grapple: <holder>' or 'pinned by <holder>' go with their extras; holds sourced to the holder's bare id or name clear only Clinched/Grappled/Restrained/Pinned). control: true pins (Grappled + Restrained, no damage). execute: a pinned lower-band foe takes a posted crit of damage (default its HP); pinned = Restrained or Pinned, or Grappled + Prone, sourced to this actor by id, name, or any 'grapple:'/'pinned by' form — read from the token first, then the sheet (pinFrom); combat_manage add_condition {fromGrapple} writes that source. throw/slam ROLL surface damage (earth d4 / concrete-wall-table d6 / edge-glass d8, margin ≥5 adds a die) and RETURN it — apply via your damage lane; the encounter sheet owns mid-combat HP.`,
    // Grapple is intercepted before the router: its contract joins the router's
    // here so the mirror audit, search_tools and ignored-param checks see it.
    actionSchemas: {
        ...router.actionSchemas,
        grapple: { schema: GrappleSchema, aliases: ['clinch', 'takedown', 'slam', 'break_grapple'], description: 'Opposed grapple check on the fight\'s dice (or the sheets); honours advantage/disadvantage and named sources' }
    },
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        encounterId: z.string().optional().describe('Encounter ID; required for every action except grapple, which works on character sheets without one (two live tokens in one fight are routed there; placeholders like "none" mean no encounter)'),
        actorId: z.string().describe('ID of the acting character'),
        targetId: z.string().optional().describe('Target ID (attack, heal, help)'),
        targetIds: z.array(z.string()).optional().describe('Multiple targets (AoE spells)'),
        targetPosition: z.object({ x: z.number(), y: z.number() }).optional().describe('Target position (move, dash)'),
        attackBonus: z.number().optional().describe('Attack bonus modifier'),
        outcome: z.enum(['hit', 'crit', 'miss', 'win', 'lose']).optional().describe('attack (mirror): hit|crit|miss — a result the GM resolved at the table. The engine rolls no d20 (no nat 1/20 override) and applies damage exactly as posted: a number is never doubled; a dice string with crit doubles its dice only. Resistances, HP write-through and concentration still apply. hit/crit need damage. grapple: win|lose — the posted contest result; no d20 is rolled, the attack is still spent; with a win, damage (number or dice) is the surface damage of a throw/slam'),
        calledStrike: z.string().optional().describe("attack (mirror): Table rules (called_strike): 'leg', 'arm' or any named part of the target ('jaw', 'collar chain'). No roll penalty; a hit cripples that part (it keeps its kind). Needs a target of your band or greater"),
        preparedAsset: z.string().optional().describe('attack (mirror): Table rules (prepared_asset): the rule name; reports miss / hit / catastrophic tier and the effect the GM names'),
        unaffectedLimb: z.boolean().optional().describe('attack (mirror): The attacker uses a limb its crippling condition does not touch (skips that disadvantage)'),
        withPart: z.string().optional().describe("attack (mirror): the attacker's named part used"),
        using: z.string().optional().describe('attack (mirror): named attack profile; fills bonus, damage, type and part when omitted'),
        weapon: z.string().optional().describe('attack (mirror): alias of using; also finds the part that holds it'),
        atPart: z.string().optional().describe('attack (mirror): the target part aimed at'),
        cleave: z.boolean().optional().describe('attack (mirror): cleave a packed lower-band unit'),
        bandScale: z.boolean().optional().describe("attack (mirror): false skips the band rule's damageScale for this swing"),
        legendaryCost: z.number().optional().describe("attack (mirror): a legendary action costing this many of the creature's legendary actions, not its action"),
        reaction: z.boolean().optional().describe('attack (mirror): spends the reaction instead of the action (opportunity attack, readied swing)'),
        actionSurge: z.union([z.boolean(), z.string()]).optional().describe("attack / grapple (mirror): when the action is spent, spend a ready action-granting ability (true = the first grantsAction ability, a string names it) for an extra action and swing; a no-op while the action is free"),
        ranged: z.boolean().optional().describe('attack (mirror): a ranged attack, not within 5 ft (prone target = disadvantage; no auto-crit)'),
        twoHanded: z.boolean().optional().describe('attack (mirror): the swing is made with both hands (great weapon fighting applies, dueling does not); default from the profile'),
        maneuver: z.enum(MANEUVER_NAMES).optional().describe('attack (mirror): trip | precision | riposte | menacing | disarming, paid from the superiority pool'),
        maneuverItem: z.string().optional().describe('attack (mirror): disarming — the held item the target drops'),
        ignoreConditions: z.boolean().optional().describe('attack (mirror): skip automatic advantage/disadvantage/auto-crit from standard conditions'),
        ammoItemId: z.string().optional().describe('FINDINGS #58 (mirror): ammo template id — dry refuses the shot; decrements after the engine resolves'),
        hand: z.enum(['mainhand', 'offhand']).optional().describe('FINDINGS #96-C (mirror): which weapon the attack resolves with — its coating surfaces and debits (default mainhand)'),
        ammoCount: z.number().optional().describe('FINDINGS #58 (mirror): magazines expended (default 1)'),
        advantage: z.boolean().optional().describe('attack / volley / grapple: 2d20 keep highest (mirror of inner schema, Findings #32). On a grapple it is the actor\'s roll and cancels against any disadvantage'),
        declaredModifiers: z.array(z.object({ label: z.string(), value: z.number() })).optional().describe('Register-B audit: declared modifiers already in attackBonus, printed in the breakdown'),
        // FINDINGS #60 (mirror law): declaredEffects — GM names the conditional
        // trait; engine computes and APPLIES the value (incl. valueFromPool).
        declaredEffects: z.array(z.object({ name: z.string(), lane: z.string().optional() })).optional().describe('RESOLVER v2: [{name, lane?}] — engine-computed conditional trait values; do NOT also fold into attackBonus'),
        disadvantage: z.boolean().optional().describe('attack / volley / grapple: 2d20 keep lowest. On a grapple the lower band or smaller size is automatic and never stacks'),
        advantageSources: sourcesField('advantage', GRAPPLE_SOURCE_NOTE),
        disadvantageSources: sourcesField('disadvantage', GRAPPLE_SOURCE_NOTE),
        dc: z.number().optional().describe('DC for the attack'),
        damage: z.union([z.number(), z.string()]).optional().describe('Damage amount or dice'),
        damageType: z.string().optional().describe('Damage type (fire, slashing, etc.)'),
        amount: z.number().optional().describe('Healing amount'),
        spellName: z.string().optional().describe('Spell name'),
        slotLevel: z.number().optional().describe('Spell slot level'),
        unbinderId: z.string().optional().describe("cast_spell (mirror): a participant who tries to unbind a world spell (contestedBy: 'unbind')"),
        boost: spellBoostSchema().optional().describe("cast_spell (mirror): {pool, delta, modifier?, extraDice?, sideEffect?: [{pool, delta}]} spends a pool for a bonus on a world spell's casting roll"),
        readiedAction: z.string().optional().describe('Description of readied action'),
        trigger: z.string().optional().describe('Trigger for readied action'),
        on: z.enum(['enters_reach', 'leaves_reach']).optional().describe('ready (mirror): enters_reach | leaves_reach, the engine fires it on a move'),
        watch: z.string().optional().describe("ready (mirror): who sets it off: participant id or name, 'enemy' (default) or 'any'"),
        attack: z.any().optional().describe('ready (mirror): {using?, attackBonus?, damage?, damageType?, withPart?}, the attack it makes as a reaction'),
        move: z.enum(['clinch', 'takedown', 'throw', 'slam', 'control', 'break', 'execute']).optional().describe("FINDINGS #99 grapple: the move. clinch→Clinched · takedown/slam→Prone+Grappled · throw→Prone · control→Restrained · break→clears the ACTOR's holds from targetId · execute→a posted crit on a lower-band foe this actor pinned: damage as given (defences apply), else a coup de grâce taking its HP (defences bypassed); without an encounter the sheet is written and the kill makes a corpse"),
        control: z.boolean().optional().describe('grapple: pin instead of hurt — a win leaves the target Grappled + Restrained and throw/slam roll no surface damage'),
        surface: z.string().optional().describe("FINDINGS #99 grapple throw/slam: what they land on — earth/floor d4, concrete/wall/table d6, edge/glass/rebar d8. Free text, pattern-matched"),
        modifier: z.number().optional().describe('FINDINGS #99 grapple: situational bonus to the attacker (footing, surprise) — summed into the opposed roll; band and size disadvantage are automatic')
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

const GRAPPLE_CONDITIONS = ['Clinched', 'Grappled', 'Restrained', 'Pinned'];

function surfaceDie(surface?: string): { die: number; label: string } {
    const s = (surface ?? '').toLowerCase();
    if (/edge|corner|glass|rebar|spike|kerb|curb/.test(s)) return { die: 8, label: surface ?? 'hard edge' };
    if (/concrete|stone|wall|asphalt|table|furniture|bar|metal|steel|brick|tile/.test(s)) return { die: 6, label: surface ?? 'hard surface' };
    return { die: 4, label: surface ?? 'the ground' };
}

type GrappleRow = {
    id: string; name: string; level?: number; band?: string | null; size?: string | null; hp?: number; maxHp?: number;
    characterType?: string;
    stats?: { str?: number; dex?: number }; skillProficiencies?: string[]; expertise?: string[];
    resistances?: string[] | null; immunities?: string[] | null; vulnerabilities?: string[] | null;
    conditions?: Array<{ name: string; duration?: number; source?: string }>;
    abilities?: Ability[];
};

/** How one side's d20 is rolled: two keep high, two keep low, one, or one because both applied. */
type GrappleRollMode = 'advantage' | 'disadvantage' | 'normal' | 'cancelled';

/**
 * advantageSources / disadvantageSources as the grapple branch sees them: the
 * outer schema has already turned a JSON string into an array, but batch and
 * direct callers hand the raw value over, so a JSON string or a bare name is
 * read here too.
 */
function sourceTexts(v: unknown): string[] {
    const parsed = jsonIfString(v);
    if (Array.isArray(parsed)) return parsed.map(x => String(x ?? ''));
    if (typeof parsed === 'string' && parsed.trim()) return [parsed];
    return [];
}

/** A GM-posted grapple result: win (hit/crit) or lose (miss); undefined when the contest is rolled. */
function postedGrappleOutcome(v: unknown): 'win' | 'lose' | undefined {
    const s = String(v ?? '').trim().toLowerCase();
    if (s === 'win' || s === 'hit' || s === 'crit') return 'win';
    if (s === 'lose' || s === 'miss') return 'lose';
    return undefined;
}

/** One side of a grapple: the live token when there is a fight, the sheet for proficiency. */
interface GrappleSide {
    id: string;
    name: string;
    row?: GrappleRow;
    tok?: CombatParticipant;
    band?: string | null;
    size: string;
    str: number;
    dex: number;
}

function grappleSide(id: string, row: GrappleRow | null, tok: CombatParticipant | undefined): GrappleSide {
    return {
        id,
        name: tok?.name ?? row?.name ?? id,
        row: row ?? undefined,
        tok,
        band: tok?.band ?? row?.band,
        size: tok?.size ?? row?.size ?? 'medium',
        str: row?.stats?.str ?? tok?.abilityScores?.strength ?? 10,
        dex: row?.stats?.dex ?? tok?.abilityScores?.dexterity ?? 10
    };
}

/**
 * A condition a break against this holder clears. Play report: the break
 * matched only Clinched/Grappled/Restrained by name and treated ANY other
 * source as fair game, so a spell's Restrained went with the hold. Play
 * report 2: it then read only the exact 'grapple: <id>' source, so a hold
 * the GM wrote as 'Marine' never cleared. On the shared holder matcher:
 *  - unsourced Clinched/Grappled/Restrained/Pinned (legacy rows): cleared;
 *  - a prefixed source naming the holder ('grapple: marine', 'pinned by
 *    Marine'): cleared whatever its name, except Prone (5e: escaping a
 *    grapple doesn't stand you up) — the hold's own extras go with it;
 *  - the holder's bare id or name as source: only the hold names clear;
 *    Frightened (or anything else) sourced to the holder is never touched;
 *  - any other source (a spell, a net, another holder): never touched.
 */
function heldBy(name: string, source: string | undefined, holder: GrappleSide): boolean {
    const n = name.trim().toLowerCase();
    const holdName = (HOLD_CONDITIONS as readonly string[]).includes(n);
    const s = (source ?? '').trim();
    if (!s) return holdName;
    const match = holderMatch(s, holder);
    if (!match || n === 'prone') return false;
    return match === 'prefixed' || holdName;
}

type NamedCondition = { name: string; source?: string };
const tokConditions = (tok: CombatParticipant | undefined): NamedCondition[] => (tok?.conditions ?? []).map(c => ({ name: String(c.type), source: c.sourceId }));
const rowConditions = (row: GrappleRow | undefined): NamedCondition[] => (row?.conditions ?? []).map(c => ({ name: c.name, source: c.source }));

/**
 * Whether these conditions pin the wearer for this actor: Restrained or
 * Pinned sourced to the actor (id or name, any accepted prefix), or
 * Grappled sourced to the actor plus Prone from anyone. `found` lists what
 * was there, for the refusal.
 */
function pinBy(conds: NamedCondition[], actor: GrappleSide): { pinned: boolean; found: string[] } {
    const lower = (c: NamedCondition) => c.name.trim().toLowerCase();
    const byActor = (c: NamedCondition) => sourceNamesHolder(c.source, actor);
    const pinned = conds.some(c => (PIN_CONDITIONS as readonly string[]).includes(lower(c)) && byActor(c))
        || (conds.some(c => lower(c) === 'grappled' && byActor(c)) && conds.some(c => lower(c) === 'prone'));
    return { pinned, found: conds.map(c => `${c.name}${c.source ? ` (source '${c.source}')` : ''}`) };
}

type GrappleContext = {
    db: ReturnType<typeof getDb>;
    engine: CombatEngine | null;
    /** The fight the grapple runs in: as given, or the one both live tokens share. */
    encounterId?: string;
    /** No encounterId was given and both tokens were found in one live fight. */
    routed: boolean;
    worldId: string | null;
    actor: GrappleSide;
    target: GrappleSide;
    order: string[];
    bandRule?: TableRule<'band'>;
};

/** Callers used to fill the once-required encounterId with these; they mean "no encounter". */
const ENCOUNTER_PLACEHOLDER = /^(none|null|undefined|n\/?a|-)$/i;

/**
 * Load both sides. With encounterId, the tokens come first (a token without
 * a sheet can grapple). Without one (play report 2, item 4): two live
 * tokens in one fight are routed there, apply_damage's rule; one side in a
 * fight, or two fights, is refused; neither in a fight runs on the sheets.
 */
function grappleContext(args: Record<string, unknown>, ctx: SessionContext): GrappleContext | { error: true; writes: 'none'; message: string } {
    const actorId = String(args.actorId ?? '');
    const targetId = String(args.targetId ?? '');
    const db = getDb();
    const raw = String(args.encounterId ?? '').trim();
    let encounterId = raw && !ENCOUNTER_PLACEHOLDER.test(raw) ? raw : undefined;
    let routed = false;
    if (!encounterId) {
        const encA = liveEncounterFor(db, actorId), encT = liveEncounterFor(db, targetId);
        if (encA || encT) {
            if (encA !== encT) {
                const where = (id: string, enc?: string) => `${id} is in ${enc ? `encounter ${enc}` : 'no fight'}`;
                return { error: true, writes: 'none', message: `grapple without encounterId needs both in one place: ${where(actorId, encA)}, ${where(targetId, encT)}. Pass encounterId, or add the other to the fight. Nothing was written.` };
            }
            encounterId = encA; routed = true;
        }
    }
    const repo = new CharacterRepository(db);
    const engine = encounterId ? getOrLoadEngine(ctx, encounterId) : null;
    if (encounterId && !engine) return { error: true, writes: 'none', message: `Encounter ${encounterId} not found` };
    const state = engine?.getState();
    const tokOf = (id: string) => state?.participants.find(p => p.id === id);
    const actorRow = repo.findById(actorId) as unknown as GrappleRow | null;
    const targetRow = repo.findById(targetId) as unknown as GrappleRow | null;
    const actorTok = tokOf(actorId), targetTok = tokOf(targetId);
    if (!actorRow && !actorTok) return { error: true, writes: 'none', message: engine ? `No participant or character ${actorId}` : `No character ${actorId}` };
    if (!targetRow && !targetTok) return { error: true, writes: 'none', message: engine ? `No participant or character ${targetId}` : `No character ${targetId}` };
    const actor = grappleSide(actorId, actorRow, actorTok), target = grappleSide(targetId, targetRow, targetTok);
    // The band ladder that holds both bands (a world may import several).
    const worldId = resolveWorldId(db, { encounterId, characterIds: [actorId, targetId] });
    const bandRule = bandRuleFor(db, worldId, [actor.band, target.band]);
    const order = bandRule?.spec.order ?? bandOrderFor(db, worldId, [actor.band, target.band]);
    return { db, engine, encounterId, routed, worldId, actor, target, order, bandRule };
}

/**
 * Item 5: execute a pinned foe. The target must be restrained (or grappled
 * and prone) by this actor, not a unit, and of a lower band. Returns the
 * refusal, or the damage the posted crit carries (default: its HP).
 */
type ExecuteCheck = {
    damage: number | string;
    note: string;
    pinFrom: 'token' | 'sheet';
    /** No damage was given: the execute takes its HP outright, defences bypassed. */
    coupDeGrace: boolean;
};

/**
 * Item 5 / play report 2 item 4: execute a pinned foe. The target must be
 * pinned by this actor (Restrained/Pinned, or Grappled + Prone, sourced to
 * the actor in any accepted form), not a unit, above 0 HP and of a lower
 * band. In a fight both tokens are read (the sheet as a fallback for the
 * pin); with no encounter both sheets are. Returns the refusal, or the
 * damage the posted crit carries: as given, else its HP as a coup de grâce.
 */
function executeCheck(args: Record<string, unknown>, g: GrappleContext): { problem: string } | ExecuteCheck {
    const given = typeof args.damage === 'number' || typeof args.damage === 'string' ? args.damage : undefined;
    if (typeof given === 'string') {
        try { parseDiceTerms(given); } catch { return { problem: `Invalid dice '${given}' for damage: use notation like '2d6' or '1d8+2', or a number` }; }
    }
    const needPin = (found: string[]) => `execute needs ${g.target.name} pinned by ${g.actor.name}: found ${found.length ? found.join(', ') : 'nothing'}; needs Restrained/Pinned, or Grappled + Prone, sourced to ${g.actor.name} (id or name, or 'grapple: ${g.actor.id}')`;
    const bandProblem = (): string | undefined => {
        const cmp = compareBands(g.order, g.actor.band, g.target.band);
        if (cmp === null) return `execute needs both bands set (unset for ${!g.actor.band ? g.actor.name : g.target.name})`;
        if (cmp !== 1) return `execute is against a pinned foe of a lower band; ${g.target.name} (${g.target.band}) is not below ${g.actor.name} (${g.actor.band})`;
        return undefined;
    };
    const note = `${g.actor.name} executes ${g.target.name} (pinned; ${g.actor.band} over ${g.target.band})`;

    if (!g.engine) {
        // No encounter: both sheets, the pin read from the target's sheet.
        const row = g.target.row;
        if (!g.actor.row || !row) return { problem: `execute without an encounter needs both character sheets (missing ${!g.actor.row ? g.actor.id : g.target.id})` };
        // The engine refuses an incapacitated attacker in a fight; the sheet path does the same.
        const down = helplessReason({ name: g.actor.name, hp: g.actor.row.hp, conditions: g.actor.row.conditions });
        if (down) return { problem: `${g.actor.name} cannot execute anyone: ${down}` };
        const onSheet = pinBy(rowConditions(row), g.actor);
        if (!onSheet.pinned) return { problem: needPin(onSheet.found) };
        const hp = row.hp ?? 0;
        if (hp <= 0) return { problem: `${g.target.name} is already down` };
        const band = bandProblem();
        if (band) return { problem: band };
        return { damage: given ?? hp, pinFrom: 'sheet', coupDeGrace: given === undefined, note };
    }

    const tok = g.target.tok;
    if (!tok || !g.actor.tok) return { problem: 'execute needs both combatants in the fight (or neither: with no encounterId it runs on the character sheets)' };
    // The token first; a pin written on the sheet alone still counts (sheet
    // conditions are deliberately not synced to tokens, so say where it came from).
    const onToken = pinBy(tokConditions(tok), g.actor);
    const onSheet = onToken.pinned ? undefined : pinBy(rowConditions(g.target.row), g.actor);
    const pinFrom: ExecuteCheck['pinFrom'] | undefined = onToken.pinned ? 'token' : onSheet?.pinned ? 'sheet' : undefined;
    if (!pinFrom) return { problem: needPin([...onToken.found, ...(onSheet?.found ?? []).map(f => `${f} [sheet]`)]) };
    if (tok.unit) return { problem: `${g.target.name} is a unit; execute is against a single foe` };
    if (tok.hp <= 0) return { problem: `${g.target.name} is already down` };
    const band = bandProblem();
    if (band) return { problem: band };
    return { damage: given ?? tok.hp, pinFrom, coupDeGrace: given === undefined, note };
}

/** A crit doubles the dice of a notation, never its flat part: '2d6+3' → '4d6+3'. */
function critNotation(notation: string): string {
    return parseDiceTerms(notation).map((t, i) => {
        const sign = t.sign < 0 ? '-' : i === 0 ? '' : '+';
        return t.kind === 'dice' ? `${sign}${t.count * 2}d${t.sides}` : `${sign}${t.value}`;
    }).join('');
}

/**
 * Play report 2, item 4: execute with no encounter. The damage lands on the
 * target's sheet: a number as posted, dice as a crit (doubled) on a logged
 * roll ('execute damage'); a coup de grâce (no damage given) takes its HP
 * outright, defences bypassed, while posted or rolled damage respects
 * resistances. Above 0 HP the row is updated and concentration checked; at
 * 0 the kill goes through character_manage kill (HP 0, concentration ended,
 * a corpse row stamped with the fight's world), unlike the encounter path,
 * which only drops the token to 0 HP.
 */
async function executeOnSheets(args: Record<string, unknown>, g: GrappleContext, check: ExecuteCheck): Promise<Record<string, unknown>> {
    const { db, actor, target } = g;
    const row = target.row!;
    const repo = new CharacterRepository(db);
    const hpBefore = row.hp ?? 0;
    const damageType = typeof args.damageType === 'string' ? args.damageType : undefined;
    let rolled: number; let detail: string; let rollId: string | undefined;
    if (typeof check.damage === 'number') {
        rolled = Math.max(0, Math.floor(check.damage));
        detail = check.coupDeGrace ? `coup de grâce: ${rolled} (its HP; defences bypassed)` : `${rolled} posted`;
    } else {
        const notation = critNotation(check.damage);
        const r = loggedRoll(db, { purpose: 'execute damage', forId: actor.id, targetId: target.id }, notation, { tool: 'combat_action' });
        rolled = Math.max(0, r.total); rollId = r.rollId;
        detail = `${notation} [${r.rolls.join(',')}] (crit: dice doubled from ${check.damage})`;
    }
    let damage = rolled; let modifier: DamageModifier = 'normal';
    if (!check.coupDeGrace) {
        const mod = damageWithModifiers(rolled, damageType, row as DamageDefences);
        damage = mod.finalDamage; modifier = mod.modifier;
        if (modifier !== 'normal') detail += ` (${modifier})`;
    }
    const hpAfter = Math.max(0, hpBefore - damage);
    const defeated = hpAfter <= 0;
    let killed = false; let corpseId: string | undefined;
    let concentration: Record<string, unknown> | undefined;
    if (defeated) {
        // The same death as character_manage kill: one verb for 'this thing is dead'.
        const spell = new ConcentrationRepository(db).findByCharacterId(target.id)?.activeSpell;
        const { handleKill } = await import('./character-manage.js');
        const k = await handleKill({ action: 'kill', characterId: target.id, cause: `executed by ${actor.name}`, worldId: g.worldId ?? undefined }) as Record<string, unknown>;
        if (k.error) return { error: true, writes: 'none', actionType: 'grapple', message: String(k.message) };
        killed = true;
        corpseId = typeof k.corpseId === 'string' ? k.corpseId : undefined;
        if (k.concentrationBroken) concentration = { spell: spell ?? k.concentrationBroken, broken: true, reason: 'death' };
    } else {
        repo.update(target.id, { hp: hpAfter });
        if (damage > 0) {
            const c = concentrationAfterDamage(target.id, damage, false, () => loggedD20(db, { purpose: 'concentration', forId: target.id }, { tool: 'combat_action' }).natural, new ConcentrationRepository(db), repo);
            if (c) concentration = { ...c };
        }
    }
    // Play report 2, item 6: the kill feeds the executioner's growth track.
    const growth = killed ? await creditKill(db, g.worldId, actor.id, { id: target.id, name: target.name, band: target.band }, actor.band) : undefined;
    let message = `${check.note}: ${damage}${damageType ? ` ${damageType}` : ''} damage (${detail}) — HP ${hpBefore} → ${hpAfter}`;
    if (killed) message += `. ${target.name} is dead${corpseId ? `; corpse ${corpseId.slice(0, 8)} on the ground` : ''}`;
    if (concentration) message += `. Concentration on ${String(concentration.spell)}: ${concentration.reason === 'death' ? 'ends at 0 HP' : concentration.broken ? 'BROKEN' : 'held'}`;
    message += `. No encounter: written to the sheet${killed ? ' and the corpse ledger' : ''}.`;
    if (growth) message += `\n⬆ ${growthLine(growth)}`;
    return {
        success: true, actionType: 'grapple', move: 'execute', grappleMove: 'execute', execute: check.note, pinFrom: check.pinFrom,
        damage, damageDetail: detail,
        ...(damageType ? { damageType } : {}),
        ...(modifier !== 'normal' ? { damageModifier: modifier } : {}),
        ...(rollId ? { rollId } : {}),
        hpBefore, hpAfter, defeated, killed,
        ...(corpseId ? { corpseId } : {}),
        ...(concentration ? { concentration } : {}),
        ...(growth ? { growth } : {}),
        writesTo: 'sheet', message
    };
}

function grappleResolve(args: Record<string, unknown>, g: GrappleContext, move: Exclude<GrappleMove, 'execute'>): Record<string, unknown> {
    const { db, engine, actor, target } = g;
    const isBreak = move === 'break';
    const control = args.control === true && !isBreak;

    // Size limits (5e): hold at most one size larger; throw or slam nothing larger.
    if (!isBreak && sizeRank(target.size) > sizeRank(actor.size) + 1) {
        return { error: true, writes: 'none', message: `${target.name} (${target.size}) is more than one size larger than ${actor.name} (${actor.size}); too large to grapple` };
    }
    if ((move === 'throw' || move === 'slam') && sizeRank(target.size) > sizeRank(actor.size)) {
        return { error: true, writes: 'none', message: `${actor.name} (${actor.size}) cannot ${move} ${target.name} (${target.size}): the target is larger` };
    }

    // Play report 4: the flags are booleans. Over MCP the outer schema says
    // so; batch_manage and direct callers hand the raw value over, and a
    // 'true' string must be refused, never read as "no advantage".
    for (const key of ['advantage', 'disadvantage'] as const) {
        const v = args[key];
        if (v !== undefined && v !== null && typeof v !== 'boolean') {
            return { error: true, writes: 'none', actionType: 'grapple', message: `${key} must be true or false, not ${JSON.stringify(v)} — nothing was rolled or spent` };
        }
    }

    // What a side is judged by: the token when there is one (its conditions
    // and hp), else the sheet — a stale sheet condition never decides a live fight.
    const seen = (s: GrappleSide) => s.tok
        ? { name: s.name, hp: s.tok.hp, conditions: s.tok.conditions }
        : { name: s.name, hp: s.row?.hp, conditions: s.row?.conditions };

    // A helpless actor is refused before anything is spent. In a fight the
    // engine refuses an incapacitated actor (the standard conditions, 0 HP);
    // the same helpless list the target is judged by then covers the actor on
    // both paths — a custom 'Asleep' token, or a sheet at 0 HP with no fight —
    // so no path is the way round that rule. Play report 4: this used to sit
    // below the surge spend, which had already marked the ability spent (and
    // mirrored it to the sheet) under a reply that claimed writes: 'none'.
    const down = helplessReason(seen(actor));
    if (down) return { error: true, writes: 'none', message: `${actor.name} cannot grapple now: ${down}` };

    // Play report 2, item 3: no contest when the GM posts the result
    // (outcome win|lose), nor against a helpless target — unconscious,
    // asleep, incapacitated, paralysed, stunned, petrified or at 0 HP (a
    // house ruling; 5e RAW lets an incapacitated creature still roll). For a
    // break the "target" is the holder: a stunned grappler loses the hold.
    const posted = postedGrappleOutcome(args.outcome);
    const auto = posted ? undefined : helplessReason(seen(target));
    const contested = !posted && !auto;
    // A posted win may carry the surface damage the GM rolled (a number) or wants rolled (dice).
    if (posted && typeof args.damage === 'string') {
        try { parseDiceTerms(args.damage); } catch { return { error: true, writes: 'none', message: `Invalid dice '${args.damage}' for damage: use notation like '2d6' or '1d8+2', or a number` }; }
    }

    // Play report 4: the GM's advantage/disadvantage and named sources. The
    // sources are matched against the actor's token conditions, sheet
    // conditions and active effects (math_manage's resolver). A miss or an
    // ambiguous name is REFUSED here, before anything is spent — a grapple
    // spends the attack and writes conditions, where math_manage only warns
    // and rolls. With no contest nothing would be rolled, so nothing is checked.
    const gmAdv = args.advantage === true, gmDis = args.disadvantage === true;
    const advTexts = sourceTexts(args.advantageSources), disTexts = sourceTexts(args.disadvantageSources);
    let advLabels: string[] = [], disLabels: string[] = [];
    if (contested && (advTexts.length || disTexts.length)) {
        const owner = { ownerName: actor.name, conditions: [...tokConditions(actor.tok), ...rowConditions(actor.row)], effectNames: loadEffectNames(db, actor.id) };
        const adv = resolveNamedSources(advTexts, 'advantage', owner);
        const dis = resolveNamedSources(disTexts, 'disadvantage', owner);
        const problems = [...adv.problems, ...dis.problems];
        if (problems.length) {
            return { error: true, writes: 'none', actionType: 'grapple', sourceProblems: problems, message: `${actor.name} cannot grapple with these sources: ${problems.join('; ')}. Name what is on ${actor.name}'s token, sheet or active effects (a condition's name or source, an effect's name). Nothing was rolled or spent.` };
        }
        advLabels = adv.labels; disLabels = dis.labels;
    }

    // Economy: a grapple replaces one attack of the Attack action; escaping is
    // the action.
    let surge: { ability: Ability; onToken: boolean } | undefined;
    if (engine) {
        const economy = isBreak ? engine.validateActionEconomy(actor.id, 'action') : engine.validateAttackEconomy(actor.id);
        if (!economy.valid) {
            const want: true | string | undefined = args.actionSurge === true ? true : (typeof args.actionSurge === 'string' && args.actionSurge.trim() ? args.actionSurge : undefined);
            if (want === undefined) return { error: true, writes: 'none', message: `${actor.name} cannot grapple now: ${economy.error}` };
            const found = findActionGrantAcross(actor.tok?.abilities, actor.row?.abilities, want);
            if ('problem' in found) return { error: true, writes: 'none', message: `${actor.name} cannot grapple now: ${economy.error}; ${found.problem}` };
            surge = found;
        }
    }
    let surgeInfo: { spent: true; ability: string; source: 'token' | 'sheet'; mirroredToCharacter: boolean } | undefined;
    if (engine && surge) {
        const granted = engine.grantExtraAction(actor.id);
        if (!granted.ok) return { error: true, writes: 'none', message: `${actor.name} cannot grapple now: ${granted.error}` };
        if (surge.onToken) surge.ability.ready = false;
        // A sheet-only grant is spent where it was found; a token grant with
        // no recharge is mirrored so the next fight starts with it spent.
        const mirroredToCharacter = (!surge.onToken || !surge.ability.recharge) ? patchRowAbility(db, actor.id, surge.ability.name, false).found : false;
        surgeInfo = { spent: true, ability: surge.ability.name, source: surge.onToken ? 'token' : 'sheet', mirroredToCharacter };
    }

    // The lower band or the smaller size rolls at disadvantage, once (5e: never
    // stacks). Short labels go in the roll_log purpose, the detail in the line.
    const cmp = compareBands(g.order, actor.band, target.band);
    const autoReasons = (me: GrappleSide, them: GrappleSide, lowerBand: boolean): Array<{ label: string; detail: string }> => [
        ...(lowerBand ? [{ label: 'lower band', detail: `${me.band} vs ${them.band}` }] : []),
        ...(sizeRank(me.size) < sizeRank(them.size) ? [{ label: 'smaller', detail: `${me.size} vs ${them.size}` }] : [])
    ];
    const detailed = (r: { label: string; detail: string }) => `${r.label} (${r.detail})`;
    const actorAuto = contested ? autoReasons(actor, target, cmp === -1) : [];
    const defAuto = contested ? autoReasons(target, actor, cmp === 1) : [];
    // The actor's reasons in order: the GM's flag, the automatic rule, the
    // named sources. The defender has only the automatic rule.
    const actorAdv = [...(gmAdv ? ['GM'] : []), ...advLabels];
    const actorDis = { short: [...(gmDis ? ['GM'] : []), ...actorAuto.map(r => r.label), ...disLabels], long: [...(gmDis ? ['GM'] : []), ...actorAuto.map(detailed), ...disLabels] };
    const defDis = { short: defAuto.map(r => r.label), long: defAuto.map(detailed) };
    const modeOf = (adv: number, dis: number): GrappleRollMode => adv && dis ? 'cancelled' : adv ? 'advantage' : dis ? 'disadvantage' : 'normal';
    const actorMode = modeOf(actorAdv.length, actorDis.short.length);
    const defMode = modeOf(0, defDis.short.length);
    const sideLine = (name: string, mode: GrappleRollMode, adv: string[], dis: string[]): string | undefined =>
        mode === 'cancelled' ? `${name}: advantage and disadvantage cancel — one die (adv: ${adv.join('; ')}; dis: ${dis.join('; ')})`
        : mode === 'advantage' ? `${name}: advantage (${adv.join('; ')})`
        : mode === 'disadvantage' ? `${name}: disadvantage (${dis.join('; ')})`
        : undefined;
    const situational = contested
        ? [sideLine(actor.name, actorMode, actorAdv, actorDis.long), sideLine(target.name, defMode, [], defDis.long)].filter((l): l is string => !!l)
        : [
            ...(gmAdv || advTexts.length ? ['advantage ignored: no contest rolled'] : []),
            ...(gmDis || disTexts.length ? ['disadvantage ignored: no contest rolled'] : [])
        ];
    // The purpose stays exactly 'grapple' with no reasons (roll counts query it).
    const purposeOf = (adv: string[], dis: string[]) => {
        const why = [adv.length ? `adv: ${adv.join(', ')}` : '', dis.length ? `dis: ${dis.join(', ')}` : ''].filter(Boolean).join('; ');
        return why ? `grapple (${why})` : 'grapple';
    };

    const roll = (me: GrappleSide, them: GrappleSide, mode: GrappleRollMode, purpose: string): { rolls: number[]; kept: number } => {
        const tag = { purpose, forId: me.id, targetId: them.id };
        const adv = mode === 'advantage', dis = mode === 'disadvantage';
        if (engine) {
            const first = engine.rollD20(tag);
            if (!adv && !dis) return { rolls: [first], kept: first };
            const second = engine.rollD20(tag);
            return { rolls: [first, second], kept: adv ? Math.max(first, second) : Math.min(first, second) };
        }
        const r = loggedD20(db, tag, { advantage: adv, disadvantage: dis, tool: 'combat_action' });
        return { rolls: r.rolls, kept: r.natural };
    };

    const mod = (v?: number) => Math.floor(((v ?? 10) - 10) / 2);
    // Play report 2, item 4: the sheet's proficiency is the world's curve
    // (table_rules progression), doubled by expertise; skills match ignoring
    // case, spaces and underscores (math_manage's rule).
    const progression = worldProgression(db, g.worldId);
    const profOf = (s: GrappleSide) => progression.profBonus((s.row?.level ?? 1) as number);
    const normOne = (x: string) => x.toLowerCase().replace(/[ _]/g, '');
    const listed = (list: string[] | undefined | null, skills: string[]) => (list ?? []).some(k => skills.includes(normOne(String(k))));
    const skillProf = (s: GrappleSide, skills: string[]): { bonus: number; expertise: boolean } => {
        if (!s.row) return { bonus: 0, expertise: false };
        if (listed(s.row.expertise, skills)) return { bonus: profOf(s) * 2, expertise: true };
        return { bonus: listed(s.row.skillProficiencies, skills) ? profOf(s) : 0, expertise: false };
    };

    // The escaper (break) or the defender (every other move) uses the better of Athletics/Acrobatics.
    const atkStat = Math.max(mod(actor.str), mod(actor.dex));
    const atkSkill = skillProf(actor, isBreak ? ['athletics', 'acrobatics'] : ['athletics']);
    const atkProf = atkSkill.bonus;
    const bonus = typeof args.modifier === 'number' ? args.modifier : 0;
    const defStat = Math.max(mod(target.str), mod(target.dex));
    const defSkill = skillProf(target, isBreak ? ['athletics'] : ['athletics', 'acrobatics']);
    const defProf = defSkill.bonus;

    const atk = contested ? roll(actor, target, actorMode, purposeOf(actorAdv, actorDis.short)) : undefined;
    const def = contested ? roll(target, actor, defMode, purposeOf([], defDis.short)) : undefined;
    const atkRolls = atk?.rolls ?? [];
    const defRolls = def?.rolls ?? [];
    const atkTotal = atk ? atk.kept + atkStat + atkProf + bonus : undefined;
    const defTotal = def ? def.kept + defStat + defProf : undefined;
    const margin = atkTotal !== undefined && defTotal !== undefined ? atkTotal - defTotal : undefined;
    const win = margin !== undefined ? margin > 0 : posted ? posted === 'win' : true; // tie holds with the defender

    const shown = (r: { rolls: number[]; kept: number }, mode: GrappleRollMode) => r.rolls.length > 1 ? `d20(${r.rolls.join(',')} ${mode === 'advantage' ? 'adv' : 'dis'} → ${r.kept})` : `d20(${r.rolls[0]})`;
    const breakdown = atk && def
        ? `${actor.name} ${shown(atk, actorMode)}+${atkStat}stat+${atkProf}prof${atkSkill.expertise ? ' (expertise)' : ''}${bonus ? `+${bonus}situational` : ''} = ${atkTotal}  vs  ${target.name} ${shown(def, defMode)}+${defStat}stat+${defProf}prof${defSkill.expertise ? ' (expertise)' : ''} = ${defTotal}`
        : posted ? `posted by the GM: ${posted.toUpperCase()} — no contest rolled` : `auto-win: ${auto} — no contest rolled`;

    let actionSpent: string | undefined;
    if (engine) {
        if (isBreak) { engine.commitAction(actor.id, 'action'); actionSpent = 'action'; }
        else {
            const n = engine.commitAttack(actor.id);
            actionSpent = n && n.of > 1 ? `attack ${n.made}/${n.of}` : 'action';
        }
    }
    const common = {
        success: true, actionType: 'grapple', move, breakdown,
        ...(g.encounterId ? { encounterId: g.encounterId } : {}),
        ...(g.routed ? { routedToEncounter: true } : {}),
        ...(contested ? { margin, rolls: { actor: atkRolls, defender: defRolls }, rollMode: { actor: actorMode, defender: defMode } } : {}),
        ...(advLabels.length ? { advantageSources: advLabels } : {}),
        ...(disLabels.length ? { disadvantageSources: disLabels } : {}),
        ...(auto ? { autoWin: { reason: auto } } : {}),
        ...(posted ? { outcome: posted, posted: true } : {}),
        ...(situational.length ? { situational } : {}),
        ...(actionSpent ? { actionSpent } : {}),
        ...(surgeInfo ? { actionSurge: surgeInfo } : {})
    };
    const surgeLine = surgeInfo ? `⚡ Action Surge spent${surgeInfo.ability.toLowerCase() !== 'action surge' ? ` (${surgeInfo.ability})` : ''} — ` : '';
    const save = () => {
        if (engine && g.encounterId) new EncounterRepository(db).saveState(g.encounterId, engine.getState()!);
    };

    if (!win) {
        save();
        return {
            ...common, hit: false,
            ...(engine ? {} : { writes: 'none' }),
            message: surgeLine + (isBreak
                ? `${actor.name} fights the hold and loses it — still held. ${breakdown}`
                : `${target.name} shrugs the ${move} off — no change. ${breakdown}`)
        };
    }

    const src = `grapple: ${actor.id}`;
    let applied: string[] = [];
    let surfaceDamage: number | undefined; let damageDetail: string | undefined;
    let surfaceBandScale: { steps: number; multiplier: number; before: number; after: number } | undefined;

    switch (move) {
        case 'clinch': applied = ['Clinched']; break;
        case 'takedown': case 'slam': applied = ['Prone', 'Grappled']; break;
        case 'throw': applied = ['Prone']; break;
        case 'control': applied = ['Restrained']; break;
    }
    // control: true pins instead of hurting — Grappled + Restrained, no surface damage.
    if (control) for (const c of ['Grappled', 'Restrained']) if (!applied.includes(c)) applied.push(c);
    if ((move === 'throw' || move === 'slam') && !control) {
        const tag = { purpose: `grapple ${move} surface`, forId: actor.id, targetId: target.id };
        if (posted && typeof args.damage === 'number') {
            surfaceDamage = Math.max(0, Math.floor(args.damage));
            damageDetail = `${surfaceDamage} posted by the GM`;
        } else if (posted && typeof args.damage === 'string') {
            const r = engine ? engine.rollDice(args.damage, tag) : loggedRoll(db, tag, args.damage, { tool: 'combat_action' });
            surfaceDamage = Math.max(0, r.total);
            damageDetail = `${args.damage} [${r.rolls.join(',')}] posted dice`;
        } else {
            const surf = surfaceDie(typeof args.surface === 'string' ? args.surface : undefined);
            const extraDie = margin !== undefined && margin >= 5;
            const count = extraDie ? 2 : 1;
            const rolls = engine
                ? engine.rollDice(`${count}d${surf.die}`, tag).rolls
                : loggedDice(db, tag, count, surf.die, 'combat_action').rolls;
            surfaceDamage = rolls.reduce((a, b) => a + b, 0);
            damageDetail = `${count}d${surf.die} [${rolls.join(',')}] into ${surf.label}${extraDie ? ' (margin ≥5: extra die)' : ''}`;
        }
        // Request 11: the thrower's band gap scales what the surface deals.
        const scale = bandDamageMultiplier(g.bandRule, actor.band, target.band);
        if (scale && surfaceDamage > 0) {
            const scaled = Math.max(1, Math.floor(surfaceDamage * scale.multiplier));
            surfaceBandScale = { ...scale, before: surfaceDamage, after: scaled };
            surfaceDamage = scaled;
            damageDetail += ` ×${scale.multiplier} band (${surfaceBandScale.before} → ${scaled})`;
        }
    }

    // Sheets first (when there is one), then the live tokens.
    const repo = new CharacterRepository(db);
    let removed: string[] = [];
    if (isBreak) {
        const rowHolds = (actor.row?.conditions ?? []).filter(c => heldBy(c.name, c.source, target));
        const tokHolds = (actor.tok?.conditions ?? []).filter(c => heldBy(String(c.type), c.sourceId, target));
        if (actor.row && rowHolds.length) repo.update(actor.id, { conditions: (actor.row.conditions ?? []).filter(c => !rowHolds.includes(c)) } as never);
        if (actor.tok && tokHolds.length) actor.tok.conditions = actor.tok.conditions.filter(c => !tokHolds.includes(c));
        removed = [...new Set([...rowHolds.map(c => c.name), ...tokHolds.map(c => String(c.type))].map(n => GRAPPLE_CONDITIONS.find(g => g.toLowerCase() === n.toLowerCase()) ?? n))];
    } else {
        if (target.row) {
            const list = (target.row.conditions ?? []).slice();
            for (const name of applied) {
                const i = list.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
                if (i >= 0) list[i] = { ...list[i], name, source: src }; else list.push({ name, source: src });
            }
            repo.update(target.id, { conditions: list } as never);
        }
        if (engine && target.tok) {
            for (const name of applied) {
                const c = normalizeCondition({ name, source: src }, target.id);
                if (!c) continue;
                target.tok.conditions = target.tok.conditions.filter(x => x.type.toLowerCase() !== c.type.toLowerCase());
                const { id: _id, ...rest } = c; void _id;
                engine.applyCondition(target.id, rest);
            }
        }
    }
    save();
    const tokensTouched = !!engine && (isBreak ? !!actor.tok && removed.length > 0 : !!target.tok && applied.length > 0);

    return {
        ...common, hit: true,
        ...(control ? { controlled: true } : {}),
        ...(applied.length ? { conditionsApplied: applied, onto: target.name } : {}),
        ...(isBreak ? { conditionsRemoved: removed, from: actor.name } : {}),
        ...(tokensTouched ? { encounterTokensUpdated: true } : {}),
        ...(surfaceBandScale ? { bandScale: surfaceBandScale } : {}),
        ...(surfaceDamage !== undefined ? { surfaceDamage, damageDetail, applyNote: 'surface damage is ROLLED, not applied — post it with attack {outcome: \"hit\", damage: N} on the target (no engine d20, no crit doubling), or combat_manage adjust_hp. The encounter sheet owns mid-combat HP.' } : {}),
        message: surgeLine + (isBreak
            ? `${actor.name} breaks ${target.name}'s hold — ${removed.length ? removed.join('/') : 'nothing'} cleared. ${breakdown}`
            : `${actor.name} lands the ${move} on ${target.name}${applied.length ? ` — ${applied.join(' + ')}` : ''}${control ? ' (pinned, no damage)' : ''}${surfaceDamage !== undefined ? `, ${surfaceDamage} surface damage (${damageDetail})` : ''}. ${breakdown}`)
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export async function handleCombatAction(args: unknown, ctx: SessionContext): Promise<McpResponse> {
    // FINDINGS #99: grapple intercepts before the inner engine — it is not an
    // engine action; it resolves here and returns. Item 5: execute resolves as
    // a posted crit through the attack path below.
    const a = args as Record<string, unknown>;
    const actName = String(a?.action ?? '').toLowerCase();
    let execute: { note: string; pinFrom: 'token' | 'sheet'; encounterId?: string; routed: boolean; ignored?: string[]; ignoredNote?: string } | undefined;
    if (actName === 'grapple' || actName === 'clinch' || actName === 'takedown' || actName === 'slam' || actName === 'break_grapple') {
        const moveRaw = String(a.move ?? a.action ?? 'clinch').toLowerCase().replace('break_grapple', 'break');
        const move = (GRAPPLE_MOVES as readonly string[]).includes(moveRaw) ? moveRaw as GrappleMove : null;
        const refuse = (message: string) => {
            const payload = { error: true, writes: 'none', actionType: 'grapple', message };
            return { content: [{ type: 'text' as const, text: RichFormatter.error(message) + RichFormatter.embedJson(payload, 'COMBAT_ACTION') }] };
        };
        if (!move) return refuse(`grapple needs move: ${GRAPPLE_MOVES.join(' | ')}`);
        if (!a.actorId || !a.targetId) return refuse('grapple needs actorId + targetId');
        // Play report 4: grapple never meets the router, so it checks its own
        // ignored keys against GrappleSchema (the router's rule: a success
        // reply names each key and its nearest valid key; a refusal does not).
        const ignored = ignoredParamsOf(GrappleSchema, a);
        const ignoredNote = ignored.length ? describeIgnoredParams('grapple', ignored, GrappleSchema) : undefined;
        const withIgnored = <T extends Record<string, unknown>>(result: T): T => {
            if (!ignoredNote || result.error) return result;
            const prior = result.message;
            return { ...result, ignoredParams: ignored, message: typeof prior === 'string' && prior ? `${prior.replace(/\.?\s*$/, '')}. ${ignoredNote}` : ignoredNote };
        };
        const g = grappleContext(a, ctx);
        if ('error' in g) return refuse(g.message);
        if (move === 'execute') {
            if (postedGrappleOutcome(a.outcome) === 'lose') return refuse(`execute is not contested: outcome '${String(a.outcome)}' has no meaning here (drop it; the posted crit lands)`);
            const check = executeCheck(a, g);
            if ('problem' in check) return refuse(check.problem);
            if (!g.engine) {
                // No encounter: the sheets take it (and the kill makes a corpse).
                const result = withIgnored(await executeOnSheets(a, g, check));
                const out = (result.error ? RichFormatter.error(String(result.message)) : RichFormatter.header('Grapple — execute', '🤼') + RichFormatter.alert(String(result.message), 'info'))
                    + RichFormatter.embedJson(result, 'COMBAT_ACTION');
                return { content: [{ type: 'text', text: out }] };
            }
            execute = { note: check.note, pinFrom: check.pinFrom, encounterId: g.encounterId, routed: g.routed, ...(ignoredNote ? { ignored, ignoredNote } : {}) };
            // Request 11: an execute already gates on band; its posted crit is never
            // band-scaled. A coup de grâce (no damage given) bypasses defences: no
            // damageType reaches the engine, so no resistance halves its HP.
            args = { action: 'attack', encounterId: g.encounterId, actorId: a.actorId, targetId: a.targetId, outcome: 'crit', damage: check.damage, bandScale: false,
                ...(!check.coupDeGrace && typeof a.damageType === 'string' ? { damageType: a.damageType } : {}) };
        } else {
            const result = withIgnored(grappleResolve(a, g, move));
            let out = result.error ? RichFormatter.error(String(result.message)) : RichFormatter.header(`Grapple — ${String(result.move)}`, '🤼') + RichFormatter.alert(String(result.message), 'info');
            if (Array.isArray(result.situational)) out += (result.situational as string[]).map(s => `  ${s}\n`).join('');
            out += RichFormatter.embedJson(result, 'COMBAT_ACTION');
            return { content: [{ type: 'text', text: out }] };
        }
    }
    const response = await router(args as Record<string, unknown>, ctx);

    // Wrap response with ASCII formatting
    try {
        const parsed = JSON.parse(response.content[0].text);
        let output = '';
        if (execute && !parsed.error) {
            parsed.execute = execute.note; parsed.grappleMove = 'execute'; parsed.pinFrom = execute.pinFrom;
            if (execute.routed) { parsed.routedToEncounter = true; parsed.encounterId = execute.encounterId; }
            if (execute.ignored) { parsed.ignoredParams = execute.ignored; parsed.message = typeof parsed.message === 'string' && parsed.message ? `${parsed.message.replace(/\.?\s*$/, '')}. ${execute.ignoredNote}` : execute.ignoredNote; }
        }

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
                case 'volley':
                case 'attack':
                    output = RichFormatter.header(parsed.actionType === 'volley' ? 'Volley' : 'Attack', parsed.actionType === 'volley' ? '🪖' : '⚔️');
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
                    if (parsed.warning) output += `⚠️ ${parsed.warning}\n`;
                    break;
                default:
                    output = RichFormatter.header('Combat Action', '⚔️');
            }

            if (parsed.execute) output += RichFormatter.alert(`🤼 EXECUTE — ${parsed.execute}`, 'info');
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
