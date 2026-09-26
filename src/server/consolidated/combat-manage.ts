/**
 * Consolidated Combat Management Tool
 * Replaces 7 separate tools for encounter lifecycle management:
 * create_encounter, get_encounter_state, end_encounter, load_encounter,
 * advance_turn, roll_death_save, execute_lair_action
 */

import { PartSchema, UnitSchema, ReadiedSchema, ReadiedAttackSchema, PART_STATES, PART_KINDS, ParticipantExtrasShape, SizeCategorySchema, nearbyMatchSchema, mobRuleSchema, type Buff } from '../../schema/token-extras.js';
import { hydrateExtras, type ExtrasRow } from '../../engine/combat/participant-extras.js';
import { upsertPart } from '../../engine/combat/parts.js';
import { volleyTier, describeUnit, breakTestDue, moraleModifiers } from '../../engine/combat/units.js';
import { sheetSpecies } from '../handlers/world-spell.js';
import { nearbyAllies } from '../../engine/combat/nearby.js';
import type { CombatParticipant } from '../../engine/combat/engine.js';
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
    handleExecuteLairAction,
    getOrLoadEngine,
    syncParticipantHpFromDb,
    saveEncounterState,
    mirrorConditionToRow,
    resolveReadiedAttack,
    reactionAttackData,
    resolveAreaSave
} from '../handlers/combat-handlers.js';
import { budgetEncounter, describeParty, type BudgetMonster } from '../../engine/encounter-budget.js';
import { toLongAbility } from '../../engine/combat/saves.js';
import { listAllTemplates } from '../../data/creature-presets.js';
import { resolveCreature, creatureToParticipant, resolveWorldId, loadRules } from '../../engine/table-rules.js';
import { getDomainServices } from '../domain-services.js';
import { getDb } from '../../storage/index.js';
import { EncounterRepository } from '../../storage/repos/encounter.repo.js';
import { CombatEngine } from '../../engine/combat/engine.js';
import { ConditionInputSchema, SIZE_TABLE } from '../../schema/encounter.js';
import { normalizeCondition, normalizeConditions } from '../../engine/combat/conditions.js';
import { getCombatManager } from '../state/combat-manager.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { getAgentRuntime, buildAgentRuntime } from '../../agent/runtime/deps.js';
import { invokeAgent } from '../../agent/runtime/invoke.js';
import { ProviderFactory } from '../../agent/provider/factory.js';
import { freshSeed } from '../../math/seed.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['create', 'get', 'end', 'load', 'advance', 'death_save', 'lair_action', 'spawn_quick_enemy', 'add_participant', 'remove_participant', 'adjust_hp', 'add_condition', 'remove_condition', 'set_part', 'remove_part', 'set_unit', 'set_intent', 'trigger_readied', 'legendary_action', 'legendary_resistance', 'use_ability', 'battle_cry', 'budget', 'get_history', 'list'] as const;
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
    conditions: z.array(ConditionInputSchema).default([])
        .describe('Names ("prone") or {name|type, duration?, source?} objects — normalized by create'),
    position: z.object({
        x: z.number(),
        y: z.number(),
        z: z.number().optional()
    }).optional(),
    resistances: z.array(z.string()).optional(),
    vulnerabilities: z.array(z.string()).optional(),
    immunities: z.array(z.string()).optional(),
    band: z.string().optional(),
    regeneration: z.number().int().min(0).optional(),
    parts: z.array(PartSchema).optional(),
    unit: UnitSchema.optional(),
    intent: z.string().optional(),
    ...ParticipantExtrasShape
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
    seed: z.string().optional().describe('Seed for deterministic combat resolution (omit for a fresh one; the id echoes it)'),
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

const AdjustHpSchema = z.object({
    action: z.literal('adjust_hp'),
    encounterId: z.string(),
    participantId: z.string().describe('Participant/token id whose HP to correct'),
    value: z.number().int().min(0).optional().describe('Set HP to exactly this (clamped to maxHp)'),
    delta: z.number().int().optional().describe('Shift HP by this amount (negative lowers); clamped to 0..maxHp'),
    maxHp: z.number().int().min(1).optional().describe('Also set max HP (applied first)'),
    reason: z.string().min(1).describe('Why — recorded in the combat log and audit'),
    revive: z.boolean().optional().describe('Required to raise a participant marked dead above 0 HP')
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
    damage: z.union([z.number().int().min(0), z.string().min(1)]).optional().describe("A number or dice ('2d10'), rolled once"),
    damageType: z.string().optional(),
    savingThrow: z.object({
        ability: z.enum(['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']),
        dc: z.number().int().min(1).max(30)
    }).optional(),
    halfDamageOnSave: z.boolean().default(true)
});

const UseAbilitySchema = z.object({
    action: z.literal('use_ability'),
    encounterId: z.string(),
    participantId: z.string(),
    ability: z.string().min(1).describe("The ability's name on the token ('Fire Breath'), any case"),
    targetIds: z.array(z.string()).optional(),
    damage: z.union([z.number().int().min(0), z.string().min(1)]).optional().describe("A number or dice ('12d6'), rolled once for every target"),
    damageType: z.string().optional(),
    savingThrow: z.object({
        ability: z.string().describe("'dex', 'Dexterity' or 'dexterity'"),
        dc: z.number().int().min(1).max(30)
    }).optional(),
    halfDamageOnSave: z.boolean().default(true),
    reason: z.string().optional()
});

/** A dice notation ('1d4', '2d6+1') or a plain number for a buff's damage bonus. */
const BUFF_DICE = /^\s*\d*d\d+(\s*[+-]\s*\d+)?\s*$/i;

const BattleCrySchema = z.object({
    action: z.literal('battle_cry'),
    encounterId: z.string(),
    participantId: z.string().describe('Who calls it'),
    name: z.string().min(1).default('Waaagh!').describe("The buff's name (default 'Waaagh!')"),
    range: z.number().min(0).default(60).describe('Feet from the caller, edge to edge (default 60)'),
    match: nearbyMatchSchema().optional().describe('Which allies hear it: {band?, species?, tag?, nameIncludes?}; the caller always does'),
    rounds: z.number().int().min(1).default(1).describe("Rounds it lasts: it ends at the start of the caller's turn after that many (default 1: until the caller's next turn)"),
    attackAdvantage: z.boolean().optional().describe('Attacks roll with advantage'),
    damageBonus: z.union([z.number().int(), z.string().regex(BUFF_DICE, "dice like '1d4' or '2d6+1'")]).optional().describe("Added to damage on a hit: a number or dice ('1d4')"),
    speedBonus: z.number().int().optional().describe('Feet added to speed'),
    moraleBonus: z.number().int().optional().describe("Added to a unit's morale on a break test"),
    ability: z.string().optional().describe("An ability on the caller's token it spends ('Waaagh!'): must be ready; a recharge ability rolls to come back at the start of its turn"),
    actionCost: z.enum(['action', 'bonus', 'none']).default('none').describe("What it costs the caller's turn (default none: a free action, allowed out of turn; action or bonus only on the caller's turn)"),
    reason: z.string().optional()
});

const BudgetSchema = z.object({
    action: z.literal('budget'),
    encounterId: z.string().optional().describe("Rate a live encounter: its hostile tokens' cr, its allies' sheet levels"),
    partyId: z.string().optional().describe('Party whose member levels to rate against'),
    partyLevels: z.array(z.number().int().min(1).max(30)).optional().describe('Character levels, one per member'),
    creatures: z.array(z.object({
        creature: z.string().optional().describe('Bestiary creature or built-in preset name'),
        cr: z.number().min(0).optional(),
        xp: z.number().min(0).optional(),
        count: z.number().int().min(1).optional()
    })).optional().describe('Monsters to rate instead of an encounter: [{creature | cr | xp, count?}]'),
    worldId: z.string().optional().describe('World whose bestiary resolves creature names')
});

const SpawnQuickEnemySchema = z.object({
    action: z.literal('spawn_quick_enemy'),
    creature: z.string().describe('Creature name or template (e.g., "goblin", "orc:warrior")'),
    count: z.number().int().min(1).max(10).default(1).describe('Number of enemies to spawn'),
    position: z.object({ x: z.number(), y: z.number() }).optional().describe('Starting position (defaults to random)'),
    encounterId: z.string().optional().describe('Add to existing encounter (creates new if omitted)'),
    seed: z.string().optional().describe('Seed for deterministic combat (auto-generated if omitted)'),
    includeParty: z.boolean().optional().describe('T1.2 (Findings #34): include the active party as PC-side participants in the NEW encounter'),
    partyId: z.string().optional().describe('Party to include (defaults to the only party if exactly one exists)'),
    worldId: z.string().optional().describe("The world whose bestiary (table_rules kind creature) is searched before the built-in presets; defaults to the encounter's world. Stamped on a new encounter")
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
    isEnemy: z.boolean().optional().describe('Hostile flag (default false; true for a creature)'),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    creature: z.string().optional().describe("A bestiary creature (table_rules kind creature in the encounter's world) or built-in preset; explicit params override its statline"),
    count: z.number().int().min(1).max(10).optional().describe('creature: how many tokens (numbered names when more than one)'),
    importRowConditions: z.boolean().optional().describe('Copy the character sheet\'s conditions onto the new token (remove them later with remove_condition)'),
    band: z.string().optional().describe('Table rules: power band (defaults from the character row)'),
    regeneration: z.number().int().min(0).optional().describe('Table rules: HP healed at the start of each of its rounds (defaults from the character row)'),
    parts: z.array(PartSchema).optional().describe('Named parts with states (defaults from the character row)'),
    unit: UnitSchema.optional().describe('A mortal unit as one token'),
    ...ParticipantExtrasShape
});

const AddConditionSchema = z.object({
    action: z.literal('add_condition'),
    encounterId: z.string(),
    participantId: z.string().describe('Participant/token id'),
    condition: ConditionInputSchema.optional().describe('A name ("prone") or {name|type, duration?, durationType?, source?, saveDC?, saveAbility?, level?}; unknown names are kept as custom conditions'),
    name: z.string().optional().describe('Shorthand for condition: a bare condition name'),
    replace: z.boolean().optional().describe('Drop existing conditions of the same type first'),
    mirrorToCharacter: z.boolean().optional().describe('Also add it to the character sheet (upsert by name)'),
    reason: z.string().optional().describe('Why — recorded in the combat log')
}).refine(p => Boolean(p.condition || p.name), { message: 'Pass condition or name', path: ['condition'] });

const RemoveConditionSchema = z.object({
    action: z.literal('remove_condition'),
    encounterId: z.string(),
    participantId: z.string().describe('Participant/token id'),
    conditionId: z.string().optional().describe('Remove this one condition instance'),
    name: z.string().optional().describe('Remove every condition of this name/type (case-insensitive)'),
    // Removal needs only identity, so this is lenient: the condition object
    // add_condition or get echoes (durationType, metadata...) goes straight back.
    condition: z.union([z.string(), z.object({ id: z.string().optional(), type: z.string().optional(), name: z.string().optional() }).passthrough()]).optional()
        .describe('A name, or the condition object add_condition returned (matched by id, else by name/type)'),
    mirrorToCharacter: z.boolean().optional().describe('Also remove it from the character sheet'),
    reason: z.string().optional().describe('Why — recorded in the combat log')
}).refine(p => Boolean(p.conditionId || p.name || p.condition), { message: 'Pass conditionId, name or condition', path: ['name'] });

const GetHistorySchema = z.object({
    action: z.literal('get_history'),
    encounterId: z.string().describe('The ID of the encounter'),
    round: z.number().int().optional().describe('Get actions from a specific round (omit for all)'),
    limit: z.number().int().min(1).max(100).default(20).describe('Max actions to return (default 20)')
});

const SetPartSchema = z.object({
    action: z.literal('set_part'),
    encounterId: z.string(),
    participantId: z.string(),
    part: z.string().min(1).describe("Part name ('middle head', 'left elbow'); upserts by name, case-insensitive"),
    state: z.enum(PART_STATES).describe('intact | crippled | dead | latched | breached'),
    kind: z.enum(PART_KINDS).optional().describe('head | arm | leg | wing | torso | system | other (a crippled leg or wing halves speed)'),
    latchedTo: z.object({ participantId: z.string(), part: z.string().optional() }).optional().describe('latched: who this part holds'),
    holds: z.array(z.string()).optional().describe("Weapons or slots this part wields ('axe', 'mainhand'); attack {weapon} or a profile uses it. Omit to keep"),
    ac: z.number().int().min(0).optional().describe('AC to hit this part when aimed at (atPart); used when the attack gives no dc. Omit to keep'),
    hp: z.number().int().min(0).optional().describe('The part\'s own HP: aimed damage lands here instead of the body; 0 breaks it. Omit to keep'),
    maxHp: z.number().int().min(1).optional().describe('Defaults to hp when first set'),
    breakAt: z.number().int().min(1).optional().describe("One aimed hit dealing at least this much severs the part (state dead, latches released). Omit to keep"),
    note: z.string().optional(),
    mirrorToCharacter: z.boolean().optional().describe('Also write the part onto the character sheet (a lasting injury)'),
    reason: z.string().optional()
});

const RemovePartSchema = z.object({
    action: z.literal('remove_part'),
    encounterId: z.string(),
    participantId: z.string(),
    part: z.string().min(1),
    mirrorToCharacter: z.boolean().optional(),
    reason: z.string().optional()
});

const SetUnitSchema = z.object({
    action: z.literal('set_unit'),
    encounterId: z.string(),
    participantId: z.string(),
    suppressed: z.boolean().optional(),
    inMelee: z.boolean().optional(),
    brokenFormation: z.boolean().optional(),
    packed: z.boolean().optional(),
    routed: z.boolean().optional().describe('Routed after a failed break test: no volleys, no further break tests. false rallies it'),
    morale: z.number().int().optional().describe('The morale shown on BREAK TEST DUE'),
    breakAt: z.number().gt(0).lt(1).optional().describe('Fraction of models whose crossing owes a break test (default 0.5)'),
    mobRule: mobRuleSchema().nullable().optional().describe('{per, maxBonus?, attackBonusPer?, nearby?: {range, match}}: morale and to-hit grow with live models; null clears'),
    reason: z.string().optional()
});

const SetIntentSchema = z.object({
    action: z.literal('set_intent'),
    encounterId: z.string(),
    participantId: z.string(),
    intent: z.string().nullable().optional().describe('Telegraphed intent; clears when its turn ends. null clears now'),
    readied: ReadiedSchema.nullable().optional().describe('{action, trigger, on?, watch?, attack?}: stays across turns until it fires (on + attack: on a move, as a reaction) or trigger_readied. null clears')
});

const TriggerReadiedSchema = z.object({
    action: z.literal('trigger_readied'),
    encounterId: z.string(),
    participantId: z.string(),
    note: z.string().optional().describe('What happened when it fired'),
    targetId: z.string().optional().describe("Who the readied attack strikes (default: the readied action's watch, when it names a participant)"),
    attack: ReadiedAttackSchema.optional().describe('{using?, attackBonus?, damage?, damageType?, withPart?}: the attack to roll, over the stored one')
});

const LegendaryActionSchema = z.object({
    action: z.literal('legendary_action'),
    encounterId: z.string(),
    participantId: z.string(),
    cost: z.number().int().min(1).default(1).describe('Legendary actions this costs (default 1)'),
    description: z.string().describe("What the creature does ('wing attack', 'moves 40 ft')"),
    reason: z.string().optional()
});

const LegendaryResistanceSchema = z.object({
    action: z.literal('legendary_resistance'),
    encounterId: z.string(),
    participantId: z.string(),
    reason: z.string().describe('The save it turns into a success')
});

// FINDINGS #80: the ghost hunt gets a verb — encounters could previously only
// be found one at a time through get_context's LIMIT 1. list shows every row
// by status with a liveness column, so a persisted corpse never masquerades
// as a running fight and multiple ghosts surface in one call.
const ListEncountersSchema = z.object({
    action: z.literal('list'),
    status: z.enum(['active', 'completed', 'all']).default('active').describe('Row status filter — default active (the ghost hunt)'),
    limit: z.number().int().min(1).max(50).default(20),
    buryGhosts: z.boolean().optional().describe('Close every listed active encounter in this call (narrow with worldId). Refused unless confirmBury:true: an active row is a running fight as far as the engine can tell'),
    confirmBury: z.boolean().optional().describe('Confirms buryGhosts: close every listed active encounter'),
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

/** Levels of the allies that have character sheets (tokens without one are skipped). */
function allyLevels(allies: Array<{ id?: unknown }>): number[] {
    const db = getDb();
    const levels: number[] = [];
    for (const a of allies) {
        if (typeof a.id !== 'string') continue;
        const row = db.prepare('SELECT level FROM characters WHERE id = ?').get(a.id) as { level: number } | undefined;
        if (row) levels.push(row.level);
    }
    return levels;
}

/** Levels of a party's members (prisoners excluded). */
function partyLevels(partyId: string): number[] {
    const rows = getDb().prepare(
        `SELECT pm.role, ch.level FROM party_members pm JOIN characters ch ON ch.id = pm.character_id WHERE pm.party_id = ?`
    ).all(partyId) as Array<{ role: string; level: number }>;
    return rows.filter(r => r.role !== 'prisoner').map(r => r.level);
}

/** T1.3 (Findings #34): surface the wall before the party hits it. */
function threatReadout(participants: Array<Record<string, unknown>>, presetCr?: number, enemyCount?: number): string {
    const enemies = participants.filter(p => p.isEnemy);
    const allies = participants.filter(p => !p.isEnemy);
    const dpr = enemies.reduce((s, e) => s + avgDice(e.attackDamage as string | number | undefined), 0);
    const crTotal = presetCr !== undefined && enemyCount !== undefined ? presetCr * enemyCount : undefined;
    const levels = allyLevels(allies);
    const levelSum = levels.reduce((a, b) => a + b, 0);
    const allyHp = allies.reduce((s, a) => s + ((a.maxHp as number) || 0), 0);
    // The DMG budget, when every hostile has a CR and some ally a level.
    const crs = enemies.map(e => (typeof e.cr === 'number' ? e.cr : presetCr));
    const budget = levels.length && enemies.length && crs.every(c => c !== undefined)
        ? budgetEncounter({ partyLevels: levels, monsters: crs.map(cr => ({ cr })) })
        : undefined;
    let line = `⚔️ THREAT: ${enemies.length} hostile${enemies.length === 1 ? '' : 's'}`;
    if (crTotal !== undefined) line += ` (~CR ${crTotal} total)`;
    if (dpr > 0) line += ` — est ${dpr} dmg/round`;
    line += ` vs ${allies.length} allied (${allyHp} HP pooled${levels.length ? `, levels ${levelSum}` : ''})`;
    if (budget) line += ` — ${budget.adjustedXp} XP adjusted: ${budget.difficulty.toUpperCase()} for ${describeParty(levels)}`;
    const heavyByCr = budget ? budget.difficulty === 'deadly' : (crTotal !== undefined && levels.length > 0 && crTotal > levelSum * 0.75);
    if (heavyByCr || (dpr > 0 && allyHp > 0 && dpr * 3 >= allyHp)) {
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

/**
 * One-way, explicit mirror of an encounter condition change onto the character
 * sheet ({name, duration?, source?}; names match case-insensitively). Returns
 * false when the participant has no character row.
 */
function mirrorPartsToRow(characterId: string, parts: NonNullable<CombatParticipant['parts']>): boolean {
    const repo = new CharacterRepository(getDb());
    if (!repo.findById(characterId)) return false;
    repo.update(characterId, { parts } as never);
    return true;
}

function logConditionChange(encounterId: string, state: { round: number; currentTurnIndex: number }, actionType: string, targetId: string, summary: string, reason?: string): void {
    getDomainServices().combatActionLog.log({
        encounterId, round: state.round, turnIndex: state.currentTurnIndex,
        actorId: 'GM', actorName: 'GM', actionType,
        targetIds: [targetId], resultSummary: summary, resultDetail: reason
    });
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
            // Ending twice writes nothing and pays no XP twice.
            try {
                const row = getDb().prepare('SELECT status FROM encounters WHERE id = ?').get(params.encounterId) as { status?: string } | undefined;
                if (row && row.status !== 'active') {
                    return { success: true, actionType: 'end', alreadyEnded: true, encounterId: params.encounterId, message: `Encounter already ended (status '${row.status}'). Nothing was written; no XP was awarded.` };
                }
            } catch { /* no encounters table: fall through */ }
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
        aliases: ['lair', 'boss_action']
    },

    spawn_quick_enemy: {
        schema: SpawnQuickEnemySchema,
        handler: async (params: z.infer<typeof SpawnQuickEnemySchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');

            // The world's bestiary first, then the built-in presets.
            const db = getDb();
            const worldId = params.worldId ?? resolveWorldId(db, { encounterId: params.encounterId });
            const creature = resolveCreature(db, worldId, params.creature);
            if (!creature) {
                const available = [...loadRules(db, worldId, 'creature').map(r => r.name), ...listAllTemplates()];
                return {
                    error: true,
                    actionType: 'spawn_quick_enemy',
                    message: `Unknown creature: "${params.creature}"`,
                    availableCreatures: available.slice(0, 20),
                    hint: `Try one of: ${available.slice(0, 5).join(', ')}...`
                };
            }
            const spec = creature.spec;

            // Build participants from the statblock
            const count = params.count || 1;
            const participants: Array<Record<string, any>> = [];
            // Spread a group so footprints never overlap (a huge creature fills 3x3).
            const step = Math.max(2, SIZE_TABLE[spec.size ?? 'medium'].squares + 1);

            for (let i = 0; i < count; i++) {
                const basePos = params.position || { x: 10, y: 10 };
                const pos = count > 1
                    ? { x: basePos.x + (i % 3) * step, y: basePos.y + Math.floor(i / 3) * step }
                    : basePos;
                participants.push(creatureToParticipant(spec, {
                    id: `enemy-${randomUUID().slice(0, 8)}`,
                    name: count > 1 ? `${creature.name} ${i + 1}` : creature.name,
                    position: pos,
                    isEnemy: true
                }));
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
                            ac: spec.ac,
                            position: p.position,
                            attack: creature.defaultAttack
                        })),
                        turnOrder: state.turnOrder,
                        // currentTurnIndex indexes turnOrder, NOT participants —
                        // those arrays can diverge when LAIR is in the order.
                        currentTurn: state.turnOrder[state.currentTurnIndex],
                        readyForCombat: true,
                        hint: `Added ${count} ${creature.name}(s) to existing encounter. Initiative re-sorted.`
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
            const seed = params.seed || freshSeed('quick');
            const createParams = {
                seed,
                participants,
                terrain: { obstacles: [], difficultTerrain: [], water: [] }
            };

            const result = await handleCreateEncounter(createParams, ctx);
            const resultData = extractResultData(result, 'spawn_quick_enemy') as Record<string, unknown>;
            // Stamp the world the way create does: the named world, or the one
            // whose bestiary the creature came from.
            const stampedWorld = params.worldId ?? (creature.source === 'world' ? worldId : null);
            if (stampedWorld && typeof resultData.encounterId === 'string') {
                try {
                    try { db.exec('ALTER TABLE encounters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
                    db.prepare('UPDATE encounters SET world_id = ? WHERE id = ?').run(stampedWorld, resultData.encounterId);
                } catch { /* stamping is best-effort */ }
            }

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
                    ac: spec.ac,
                    position: p.position,
                    attack: creature.defaultAttack
                })),
                creatureStats: {
                    name: creature.name,
                    hp: spec.maxHp ?? spec.hp,
                    ac: spec.ac,
                    cr: spec.cr,
                    traits: spec.traits,
                    source: creature.source
                },
                ...(stampedWorld ? { worldId: stampedWorld } : {}),
                threat: threatReadout(participants as unknown as Array<Record<string, unknown>>, spec.cr, count),
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
                    initiativeBonus: params.initiativeBonus ?? Math.floor(((stats?.dex ?? 10) - 10) / 2),
                    isEnemy: params.isEnemy ?? false,
                    // Sheet conditions join only on request: rows and tokens are
                    // not synced (engine conditions expire by turn and save; row
                    // durations never tick). Imported ones come off with
                    // remove_condition like any other.
                    conditions: params.importRowConditions ? normalizeConditions(row.conditions, row.id) : [],
                    position: params.position ?? { x: 0, y: 0 },
                    resistances: (row as { resistances?: string[] }).resistances || [],
                    vulnerabilities: (row as { vulnerabilities?: string[] }).vulnerabilities || [],
                    immunities: (row as { immunities?: string[] }).immunities || [],
                    // Table rules, size, attack profiles, legendary counters and
                    // lair: the caller's value, else the sheet's.
                    ...hydrateExtras(params, row as ExtrasRow),
                    ac: params.ac ?? row.ac,
                    unit: params.unit
                };
            } else if (params.creature) {
                // A bestiary statblock, with any explicit param over it.
                const db = getDb();
                const creature = resolveCreature(db, resolveWorldId(db, { encounterId: params.encounterId }), params.creature);
                if (!creature) {
                    return { error: true, actionType: 'add_participant', message: `Unknown creature "${params.creature}": not in this world's bestiary (table_rules kind creature) or the built-in presets`, writes: 'none' };
                }
                const count = params.count ?? 1;
                const base = params.name ?? creature.name;
                const overrides = {
                    ...(params.hp !== undefined ? { hp: params.hp } : {}),
                    ...(params.maxHp !== undefined ? { maxHp: params.maxHp } : {}),
                    ...(params.initiativeBonus !== undefined ? { initiativeBonus: params.initiativeBonus } : {}),
                    ...(params.unit ? { unit: params.unit } : {}),
                    ...hydrateExtras(params)
                };
                const made: Array<Record<string, unknown>> = Array.from({ length: count }, (_, i) => ({
                    ...creatureToParticipant(creature.spec, {
                        id: `token-${randomUUID().slice(0, 8)}`,
                        name: count > 1 ? `${base} ${i + 1}` : base,
                        position: params.position ? { x: params.position.x + i * 2, y: params.position.y } : undefined,
                        isEnemy: params.isEnemy ?? true
                    }),
                    ...overrides
                }));
                const res = await appendToEncounter(ctx, params.encounterId, made);
                if (!res.ok) return { error: true, actionType: 'add_participant', message: res.message };
                const view = (p: Record<string, unknown>) => ({ id: p.id, name: p.name, hp: p.hp, ac: p.ac, isEnemy: p.isEnemy });
                return {
                    success: true, actionType: 'add_participant', encounterId: params.encounterId,
                    creature: creature.name, source: creature.source,
                    participant: view(made[0]), participants: made.map(view),
                    message: `${made.map(p => p.name).join(', ')} join${count === 1 ? 's' : ''} the encounter (${made[0].isEnemy ? 'HOSTILE' : 'allied'}, ${creature.source === 'world' ? 'bestiary' : 'preset'} ${creature.name}) — initiative rolled, state persisted.`
                };
            } else {
                if (!params.name || params.hp === undefined || params.maxHp === undefined) {
                    return { error: true, actionType: 'add_participant', message: 'Ad-hoc participant needs name, hp, maxHp (or pass characterId)' };
                }
                participant = {
                    id: `token-${randomUUID().slice(0, 8)}`, name: params.name,
                    hp: params.hp, maxHp: params.maxHp,
                    initiativeBonus: params.initiativeBonus ?? 0,
                    isEnemy: params.isEnemy ?? false, conditions: [],
                    position: params.position ?? { x: 0, y: 0 },
                    resistances: [], vulnerabilities: [], immunities: [],
                    ...hydrateExtras(params),
                    ac: params.ac ?? 10,
                    unit: params.unit
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
    adjust_hp: {
        schema: AdjustHpSchema,
        handler: async (params: z.infer<typeof AdjustHpSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'adjust_hp', message, writes: 'none' });
            if (params.value !== undefined && params.delta !== undefined) return refuse('Pass value (set) or delta (shift), not both');
            if (params.value === undefined && params.delta === undefined && params.maxHp === undefined) return refuse('Pass value, delta or maxHp');
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            // Read character_manage edits first so this write can't clobber them.
            syncParticipantHpFromDb(state);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);

            const before = p.hp;
            const maxBefore = p.maxHp;
            if (params.maxHp !== undefined) p.maxHp = params.maxHp;
            const wanted = params.value ?? (params.delta !== undefined ? before + params.delta : before);
            const after = Math.max(0, Math.min(p.maxHp, wanted));
            if (p.isDead && after > 0 && !params.revive) {
                p.maxHp = maxBefore;
                return refuse(`${p.name} is dead — pass revive: true to bring them back`);
            }
            // Bookkeeping, not damage: crossing 0 in either direction starts the
            // death-save track fresh; it never adds failures.
            if ((before <= 0) !== (after <= 0)) {
                p.deathSaveSuccesses = 0;
                p.deathSaveFailures = 0;
                p.isStabilized = false;
            }
            if (params.revive && after > 0) p.isDead = false;
            p.hp = after;

            // Item 12: a unit carried through its breakAt owes a break test.
            const breakTest = p.unit ? breakTestDue(p, before, { moraleBonus: moraleModifiers(p, state.participants, sheetSpecies(getDb())) }) : null;
            saveEncounterState(new EncounterRepository(getDb()), params.encounterId, state);
            getDomainServices().combatActionLog.log({
                encounterId: params.encounterId,
                round: state.round,
                turnIndex: state.currentTurnIndex,
                actorId: 'GM',
                actorName: 'GM',
                actionType: 'adjust_hp',
                targetIds: [p.id],
                resultSummary: `GM correction: ${p.name} HP ${before} → ${after}${p.maxHp !== maxBefore ? ` (max ${maxBefore} → ${p.maxHp})` : ''} — ${params.reason}`,
                resultDetail: params.reason,
                hpChanges: { [p.id]: { before, after } }
            });
            return {
                success: true, actionType: 'adjust_hp', encounterId: params.encounterId,
                participantId: p.id, name: p.name,
                before, after, maxHp: p.maxHp,
                mode: params.value !== undefined ? 'set' : params.delta !== undefined ? 'delta' : 'max_only',
                clamped: after !== wanted,
                defeated: after <= 0,
                deathSaves: { successes: p.deathSaveSuccesses ?? 0, failures: p.deathSaveFailures ?? 0 },
                reason: params.reason,
                ...(breakTest ? { breakTest } : {}),
                message: `${p.name}: HP ${before} → ${after}/${p.maxHp} (GM correction: ${params.reason})${breakTest ? `\n${breakTest.line}` : ''}`
            };
        },
        aliases: ['set_hp', 'fix_hp', 'correct_hp', 'hp_correction'],
        description: 'GM HP correction on the encounter sheet — set (value) or shift (delta), required reason, logged as a correction (no damage/healing totals). Writes through to the character row; crossing 0 resets death saves; the dead need revive:true'
    },
    add_condition: {
        schema: AddConditionSchema,
        handler: async (params: z.infer<typeof AddConditionSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'add_condition', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            const normalized = normalizeCondition(params.condition ?? params.name!, p.id);
            if (!normalized) return refuse('Condition needs a name');
            let replaced = 0;
            if (params.replace) {
                const before = p.conditions.length;
                p.conditions = p.conditions.filter(c => c.type.toLowerCase() !== normalized.type.toLowerCase());
                replaced = before - p.conditions.length;
            }
            const { id: _drop, ...rest } = normalized;
            void _drop;
            const applied = engine.applyCondition(p.id, rest);
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            const mirrored = params.mirrorToCharacter ? mirrorConditionToRow(p.id, 'add', applied.type, normalized.duration, normalized.sourceId) : false;
            logConditionChange(params.encounterId, state, 'add_condition', p.id, `${p.name} gains ${applied.type}${params.reason ? ` — ${params.reason}` : ''}`, params.reason);
            return {
                success: true, actionType: 'add_condition', encounterId: params.encounterId,
                participantId: p.id, condition: applied, replaced, mirroredToCharacter: mirrored,
                conditions: p.conditions.map(c => c.type),
                message: `${p.name}: +${applied.type}${replaced ? ` (replaced ${replaced})` : ''}`
            };
        },
        aliases: ['apply_condition', 'inflict', 'condition'],
        description: 'Add a condition to a live encounter participant (condition: name or {name, duration, durationType, save..., level}; or top-level name); optional mirror to the character sheet'
    },
    remove_condition: {
        schema: RemoveConditionSchema,
        handler: async (params: z.infer<typeof RemoveConditionSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'remove_condition', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            // An id that names a live instance wins; otherwise match by name/type.
            const obj = typeof params.condition === 'string' ? { name: params.condition } : params.condition;
            const id = params.conditionId ?? obj?.id;
            const label = (params.name ?? obj?.type ?? obj?.name)?.trim();
            const wanted = label?.toLowerCase();
            const byId = id ? p.conditions.filter(c => c.id === id) : [];
            const gone = byId.length ? byId : wanted ? p.conditions.filter(c => c.type.toLowerCase() === wanted) : [];
            if (gone.length === 0) {
                const searched = [id ? `condition ${id}` : '', label ? `"${label}"` : ''].filter(Boolean).join(' or ');
                return refuse(`${p.name} has no ${searched} — current: ${p.conditions.map(c => c.type).join(', ') || 'none'}`);
            }
            p.conditions = p.conditions.filter(c => !gone.includes(c));
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            const mirrored = params.mirrorToCharacter ? mirrorConditionToRow(p.id, 'remove', gone[0].type) : false;
            logConditionChange(params.encounterId, state, 'remove_condition', p.id, `${p.name} loses ${gone.map(c => c.type).join(', ')}${params.reason ? ` — ${params.reason}` : ''}`, params.reason);
            return {
                success: true, actionType: 'remove_condition', encounterId: params.encounterId,
                participantId: p.id, removed: gone.length, removedConditions: gone, mirroredToCharacter: mirrored,
                conditions: p.conditions.map(c => c.type),
                message: `${p.name}: -${gone.map(c => c.type).join(', ')}`
            };
        },
        aliases: ['clear_condition', 'cure', 'end_condition'],
        description: 'Remove a condition from a live encounter participant by conditionId, name (case-insensitive), or condition (a name or the object add_condition returned); optional mirror to the character sheet'
    },
    set_part: {
        schema: SetPartSchema,
        handler: async (params: z.infer<typeof SetPartSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'set_part', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            if (params.state === 'latched') {
                const held = (p.parts ?? []).find(x => x.name.toLowerCase() === params.part.toLowerCase());
                // A part already latched keeps its hold when only the note or kind changes.
                if (!params.latchedTo && !(held?.state === 'latched' && held.latchedTo)) return refuse('latched needs latchedTo {participantId, part?}');
                if (params.latchedTo && !state.participants.some(x => x.id === params.latchedTo!.participantId)) return refuse(`latchedTo ${params.latchedTo.participantId} is not in this encounter`);
            }
            const prev = (p.parts ?? []).find(x => x.name.toLowerCase() === params.part.toLowerCase());
            // Merge, never replace: holds, ac, hp and any later part field
            // survive a state change. Leaving 'latched' releases the hold.
            const parts = upsertPart(p.parts ?? [], {
                name: params.part,
                kind: params.kind ?? prev?.kind ?? 'other',
                state: params.state,
                latchedTo: params.state === 'latched' ? (params.latchedTo ?? prev?.latchedTo) : undefined,
                ...(params.note !== undefined ? { note: params.note } : {}),
                ...(params.holds !== undefined ? { holds: params.holds } : {}),
                ...(params.ac !== undefined ? { ac: params.ac } : {}),
                ...(params.hp !== undefined ? { hp: params.hp } : {}),
                ...(params.maxHp !== undefined ? { maxHp: params.maxHp }
                    : params.hp !== undefined && prev?.maxHp === undefined ? { maxHp: Math.max(1, params.hp) } : {}),
                ...(params.breakAt !== undefined ? { breakAt: params.breakAt } : {})
            });
            const next = parts.find(x => x.name.toLowerCase() === params.part.toLowerCase())!;
            p.parts = parts;
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            const mirrored = params.mirrorToCharacter ? mirrorPartsToRow(p.id, parts) : false;
            const summary = `${p.name}: ${next.name} ${prev ? `${prev.state} → ` : ''}${next.state}${next.latchedTo ? ` → ${next.latchedTo.participantId}${next.latchedTo.part ? ` ${next.latchedTo.part}` : ''}` : ''}`;
            logConditionChange(params.encounterId, state, 'set_part', p.id, `${summary}${params.reason ? ` — ${params.reason}` : ''}`, params.reason);
            return { success: true, actionType: 'set_part', encounterId: params.encounterId, participantId: p.id, part: next, previous: prev?.state, mirroredToCharacter: mirrored, message: summary };
        },
        aliases: ['part', 'wound_part', 'cripple'],
        description: 'Set a named part on a token (intact, crippled, dead, latched, breached); upserts by name; ac, hp/maxHp and breakAt armour a part so aimed hits land on it'
    },
    remove_part: {
        schema: RemovePartSchema,
        handler: async (params: z.infer<typeof RemovePartSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'remove_part', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            const before = p.parts ?? [];
            const after = before.filter(x => x.name.toLowerCase() !== params.part.toLowerCase());
            if (after.length === before.length) return refuse(`${p.name} has no part '${params.part}' (parts: ${before.map(x => x.name).join(', ') || 'none'})`);
            p.parts = after;
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            const mirrored = params.mirrorToCharacter ? mirrorPartsToRow(p.id, after) : false;
            logConditionChange(params.encounterId, state, 'remove_part', p.id, `${p.name}: ${params.part} removed${params.reason ? ` — ${params.reason}` : ''}`, params.reason);
            return { success: true, actionType: 'remove_part', encounterId: params.encounterId, participantId: p.id, removed: params.part, mirroredToCharacter: mirrored, message: `${p.name}: ${params.part} removed` };
        },
        aliases: ['clear_part', 'repair_part'],
        description: 'Remove a named part from a token (repaired, or no longer tracked)'
    },
    set_unit: {
        schema: SetUnitSchema,
        handler: async (params: z.infer<typeof SetUnitSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'set_unit', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            if (!p.unit) return refuse(`${p.name} is not a unit token (create it with unit: {models, hpPerModel, ...})`);
            for (const k of ['suppressed', 'inMelee', 'brokenFormation', 'packed', 'routed', 'morale', 'breakAt'] as const) {
                if (params[k] !== undefined) (p.unit as Record<string, unknown>)[k] = params[k];
            }
            if (params.mobRule === null) delete (p.unit as Record<string, unknown>).mobRule;
            else if (params.mobRule !== undefined) p.unit.mobRule = params.mobRule;
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            const tier = volleyTier(p);
            logConditionChange(params.encounterId, state, 'set_unit', p.id, `${p.name}: ${describeUnit(p)}${params.reason ? ` — ${params.reason}` : ''}`, params.reason);
            return { success: true, actionType: 'set_unit', encounterId: params.encounterId, participantId: p.id, unit: p.unit, volley: tier, message: `${p.name}: ${describeUnit(p)}` };
        },
        aliases: ['unit', 'suppress', 'formation'],
        description: 'Set a unit token\'s suppressed / inMelee / brokenFormation / packed flags, routed / morale / breakAt for break tests, and mobRule; reports the volley tier'
    },
    set_intent: {
        schema: SetIntentSchema,
        handler: async (params: z.infer<typeof SetIntentSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'set_intent', message, writes: 'none' });
            if (params.intent === undefined && params.readied === undefined) return refuse('set_intent needs intent and/or readied (null clears)');
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            if (params.intent !== undefined) p.intent = params.intent ?? undefined;
            if (params.readied !== undefined) p.readied = params.readied ?? undefined;
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            return {
                success: true, actionType: 'set_intent', encounterId: params.encounterId, participantId: p.id,
                intent: p.intent ?? null, readied: p.readied ?? null,
                message: `${p.name}${p.intent ? ` ⚑ ${p.intent}` : ''}${p.readied ? ` ⏳ ${p.readied.action} when ${p.readied.trigger}` : ''}${!p.intent && !p.readied ? ': intent cleared' : ''}`
            };
        },
        aliases: ['intent', 'telegraph', 'ready_action'],
        description: 'Telegraph a token\'s intent (clears when its turn ends) and/or a readied action {action, trigger} (stays until triggered)'
    },
    trigger_readied: {
        schema: TriggerReadiedSchema,
        handler: async (params: z.infer<typeof TriggerReadiedSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'trigger_readied', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            if (!p.readied) return refuse(`${p.name} has no readied action`);
            // A readied action is the reactor's reaction (item 11).
            if (!engine.canTakeReactions(p.id)) return refuse(`${p.name} cannot take reactions (down, or a condition such as stunned or incapacitated)`);
            if (p.reactionUsed) return refuse(`${p.name} has already used its reaction this round`);
            const fired = p.readied;
            const spec = params.attack ?? fired.attack;
            let attack: ReturnType<typeof resolveReadiedAttack> | undefined;
            if (spec) {
                // The stored attack rolls in this call, on the encounter's dice.
                const lc = (s: string) => s.trim().toLowerCase();
                const watched = fired.watch ? state.participants.find(x => x.id !== p.id && (lc(x.id) === lc(fired.watch!) || lc(x.name) === lc(fired.watch!))) : undefined;
                const targetId = params.targetId ?? watched?.id;
                if (!targetId) return refuse(`${p.name}'s readied attack needs targetId (who it strikes)`);
                const target = state.participants.find(x => x.id === targetId);
                if (!target) return refuse(`Target ${targetId} not in this encounter`);
                try {
                    attack = resolveReadiedAttack(engine, p, target, spec);
                } catch (err) {
                    return refuse(err instanceof Error ? err.message : String(err));
                }
            } else {
                engine.commitAction(p.id, 'reaction');
            }
            p.readied = undefined;
            saveEncounterState(new EncounterRepository(getDb()), params.encounterId, state);
            logConditionChange(params.encounterId, state, 'trigger_readied', p.id, `${p.name}'s readied action fires: ${fired.action} (${fired.trigger})${attack ? ` — ${attack.message}` : ''}${params.note ? ` — ${params.note}` : ''}`, params.note);
            const attackData = attack ? { targetId: attack.target?.id, ...reactionAttackData(attack) } : undefined;
            return {
                success: true, actionType: 'trigger_readied', encounterId: params.encounterId, participantId: p.id, fired, reaction: true,
                ...(attackData ? { attack: attackData } : {}),
                message: attack
                    ? `${p.name}: ${fired.action} fires (${fired.trigger}); reaction spent.\n${attack.detailedBreakdown}`
                    : `${p.name}: ${fired.action} fires (${fired.trigger}); reaction spent. Resolve its effect now (an attack: pass attack {…} and targetId here next time to roll it in one call).`
            };
        },
        aliases: ['fire_readied', 'readied_fires'],
        description: 'A readied action\'s trigger happened: spends the reaction, rolls its stored attack (targetId) in the same call, clears and logs it'
    },
    legendary_action: {
        schema: LegendaryActionSchema,
        handler: async (params: z.infer<typeof LegendaryActionSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'legendary_action', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            const problem = engine.legendaryActionProblem(p.id, params.cost)
                ?? (engine.canTakeActions(p.id) ? undefined : `${p.name} is incapacitated`);
            if (problem) return refuse(problem);
            const spent = engine.useLegendaryAction(p.id, params.cost);
            if (!spent.success) return refuse(spent.error ?? 'Legendary action refused');
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            logConditionChange(params.encounterId, state, 'legendary_action', p.id, `${p.name} legendary action (cost ${params.cost}): ${params.description}${params.reason ? ` — ${params.reason}` : ''}`, params.reason);
            return {
                success: true, actionType: 'legendary_action', encounterId: params.encounterId, participantId: p.id,
                cost: params.cost, remaining: spent.remaining, of: p.legendaryActions,
                message: `👑 ${p.name}: ${params.description} (cost ${params.cost}; LA ${spent.remaining}/${p.legendaryActions} left). For an attack, use combat_action attack with legendaryCost instead.`
            };
        },
        aliases: ['legendary', 'use_legendary_action'],
        description: 'Spend legendary actions on a non-attack legendary action (move, wing buffet) at the end of another creature\'s turn; logged'
    },
    legendary_resistance: {
        schema: LegendaryResistanceSchema,
        handler: async (params: z.infer<typeof LegendaryResistanceSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'legendary_resistance', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            const spent = engine.useLegendaryResistance(p.id);
            if (!spent.success) return refuse(`${p.name}: ${spent.error ?? 'legendary resistance refused'}`);
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            // Legendary resistances last the day, so the sheet keeps the count.
            const charRepo = new CharacterRepository(getDb());
            const mirrored = !!charRepo.findById(p.id);
            if (mirrored) charRepo.update(p.id, { legendaryResistancesRemaining: spent.remaining });
            logConditionChange(params.encounterId, state, 'legendary_resistance', p.id, `${p.name} uses a legendary resistance: ${params.reason}`, params.reason);
            return {
                success: true, actionType: 'legendary_resistance', encounterId: params.encounterId, participantId: p.id,
                remaining: spent.remaining, of: p.legendaryResistances, mirroredToCharacter: mirrored,
                message: `👑 ${p.name} turns a failed save into a success (${params.reason}); LR ${spent.remaining}/${p.legendaryResistances} left`
            };
        },
        aliases: ['use_legendary_resistance', 'legendary_save'],
        description: 'Spend a legendary resistance to turn a failed save into a success; mirrors the count to the sheet and logs'
    },
    use_ability: {
        schema: UseAbilitySchema,
        handler: async (params: z.infer<typeof UseAbilitySchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'use_ability', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            // Read character_manage HP changes before the damage writes HP back.
            syncParticipantHpFromDb(state);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            const ability = (p.abilities ?? []).find(a => a.name.toLowerCase() === params.ability.trim().toLowerCase());
            if (!ability) {
                const known = (p.abilities ?? []).map(a => a.name);
                return refuse(`${p.name} has no ability '${params.ability}'${known.length ? `; it has ${known.join(', ')}` : ' (give it abilities: [{name, recharge?}])'}`);
            }
            if (ability.ready === false) {
                return refuse(`${p.name}'s ${ability.name} is spent and not recharged (recharge ${ability.recharge ?? '?'}+ on a d6 at the start of its turn)`);
            }
            const economy = engine.validateActionEconomy(p.id, 'action');
            if (!economy.valid) return refuse(`${p.name}: ${economy.error ?? 'action unavailable'}`);
            if (params.savingThrow && !toLongAbility(params.savingThrow.ability)) return refuse(`Unknown save ability '${params.savingThrow.ability}'`);

            engine.commitAction(p.id, 'action');
            if (ability.recharge) ability.ready = false;
            const area = resolveAreaSave(engine, {
                targetIds: params.targetIds, damage: params.damage, damageType: params.damageType,
                savingThrow: params.savingThrow, halfDamageOnSave: params.halfDamageOnSave
            }, ability.name);
            saveEncounterState(new EncounterRepository(getDb()), params.encounterId, state);
            const summary = `${p.name} uses ${ability.name}${area.targets.length ? ` on ${area.targets.map(t => `${t.targetName} (${t.saved ? 'saved, ' : ''}${t.damageTaken})`).join(', ')}` : ''}${params.reason ? ` — ${params.reason}` : ''}`;
            logConditionChange(params.encounterId, state, 'use_ability', p.id, summary, params.reason);
            let message = `✴ ${p.name} uses ${ability.name}`;
            if (typeof params.damage === 'string') message += ` (${params.damage}: ${area.damageRolled})`;
            if (area.lines.length) message += '\n' + area.lines.join('\n');
            if (ability.recharge) message += `\n${ability.name} is spent; it recharges on a d6 of ${ability.recharge}+ at the start of ${p.name}'s turn.`;
            return {
                success: true, actionType: 'use_ability', encounterId: params.encounterId, participantId: p.id,
                ability: ability.name, ready: ability.ready !== false,
                ...(area.damageRolled !== undefined ? { damageRolled: area.damageRolled } : {}),
                ...(area.damageRolls ? { damageRolls: area.damageRolls } : {}),
                targets: area.targets,
                ...(area.missing.length ? { missingTargets: area.missing } : {}),
                message
            };
        },
        aliases: ['ability', 'breath_weapon', 'recharge_ability'],
        description: "Use a limited ability (a breath weapon): spends the action, marks a recharge ability spent, and resolves damage and a save per target on the fight's dice"
    },
    battle_cry: {
        schema: BattleCrySchema,
        handler: async (params: z.infer<typeof BattleCrySchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'battle_cry', message: `${message} Nothing was written.`, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB).`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter.`);
            if (params.attackAdvantage !== true && !params.damageBonus && !params.speedBonus && !params.moraleBonus) {
                return refuse('A battle cry needs something in it: attackAdvantage, damageBonus, speedBonus or moraleBonus.');
            }
            if (!engine.canTakeActions(p.id)) return refuse(`${p.name} is down or incapacitated and cannot call ${params.name}.`);
            let ability: NonNullable<typeof p.abilities>[number] | undefined;
            if (params.ability) {
                ability = (p.abilities ?? []).find(a => a.name.toLowerCase() === params.ability!.trim().toLowerCase());
                if (!ability) {
                    const known = (p.abilities ?? []).map(a => a.name);
                    return refuse(`${p.name} has no ability '${params.ability}'${known.length ? `; it has ${known.join(', ')}` : ''}.`);
                }
                if (ability.ready === false) return refuse(`${p.name}'s ${ability.name} is spent and not recharged (recharge ${ability.recharge ?? '?'}+ on a d6 at the start of its turn).`);
            }
            // A cry that costs an action or bonus action is made on the
            // caller's own turn: off it, those flags would be spent and then
            // reset at its turn start, a free cry in disguise. actionCost
            // 'none' (the default) is a free action and may ring out of turn.
            const activeId = state.turnOrder[state.currentTurnIndex];
            const offTurn = !!activeId && activeId !== p.id;
            if (offTurn && params.actionCost !== 'none') {
                const active = activeId === 'LAIR' ? 'the lair' : state.participants.find(x => x.id === activeId)?.name ?? activeId;
                return refuse(`It is not ${p.name}'s turn (${active} is acting): a battle cry with actionCost '${params.actionCost}' is made on the caller's turn. Use actionCost 'none' for a free cry.`);
            }
            if (params.actionCost !== 'none') {
                const economy = engine.validateActionEconomy(p.id, params.actionCost);
                if (!economy.valid) return refuse(`${p.name}: ${economy.error ?? `${params.actionCost} unavailable`}.`);
            }

            const buff: Buff = {
                name: params.name, source: p.name, sourceId: p.id,
                untilRound: state.round + params.rounds - 1,
                ...(params.attackAdvantage ? { attackAdvantage: true } : {}),
                ...(params.damageBonus !== undefined ? { damageBonus: params.damageBonus } : {}),
                ...(params.speedBonus ? { speedBonus: params.speedBonus } : {}),
                ...(params.moraleBonus ? { moraleBonus: params.moraleBonus } : {})
            };
            const heard = nearbyAllies(state.participants, p, { range: params.range, match: params.match }, sheetSpecies(getDb())).participants;
            const recipients = [p, ...heard];
            for (const r of recipients) {
                // The same cry again replaces the old one; it never stacks.
                const had = r.buffs?.find(b => b.name.toLowerCase() === buff.name.toLowerCase());
                r.buffs = [...(r.buffs ?? []).filter(b => b !== had), { ...buff }];
                // Speed on the caller's own turn reaches the movement it has left.
                if (r.id === p.id && !offTurn && buff.speedBonus && r.movementRemaining !== undefined) {
                    r.movementRemaining += buff.speedBonus - (had?.speedBonus ?? 0);
                }
            }
            if (params.actionCost !== 'none') engine.commitAction(p.id, params.actionCost);
            if (ability?.recharge) ability.ready = false;
            saveEncounterState(new EncounterRepository(getDb()), params.encounterId, state);
            const effects = [buff.attackAdvantage && 'advantage on attacks', buff.damageBonus !== undefined && `+${buff.damageBonus} damage on a hit`, buff.speedBonus && `+${buff.speedBonus} ft speed`, buff.moraleBonus && `+${buff.moraleBonus} morale`].filter(Boolean).join(', ');
            const summary = `${p.name} calls ${buff.name}: ${recipients.map(r => r.name).join(', ')} (${effects}) until the start of ${p.name}'s turn in round ${buff.untilRound + 1}${params.reason ? ` — ${params.reason}` : ''}`;
            logConditionChange(params.encounterId, state, 'battle_cry', p.id, summary, params.reason);
            return {
                success: true, actionType: 'battle_cry', encounterId: params.encounterId, participantId: p.id,
                buff, recipients: recipients.map(r => ({ id: r.id, name: r.name })),
                ...(offTurn ? { offTurn: true, note: `called off ${p.name}'s turn as a free action (actionCost none)` } : {}),
                ...(ability ? { ability: { name: ability.name, ready: ability.ready !== false } } : {}),
                message: `📣 ${summary}${ability?.recharge ? `\n${ability.name} is spent; it recharges on a d6 of ${ability.recharge}+ at the start of ${p.name}'s turn.` : ''}`
            };
        },
        aliases: ['waaagh', 'warcry', 'war_cry', 'rally_cry'],
        description: "A battle cry (the Waaagh!): buffs the caller and every matching ally in range (advantage, damage, speed, morale) until the start of the caller's next turn; can spend a recharging ability"
    },
    budget: {
        schema: BudgetSchema,
        handler: async (params: z.infer<typeof BudgetSchema>) => {
            const refuse = (message: string) => ({ error: true, actionType: 'budget', message, writes: 'none' });
            const db = getDb();
            let levels = params.partyLevels;
            const monsters: BudgetMonster[] = [];
            if (params.creatures?.length) {
                const world = params.worldId ?? resolveWorldId(db, { encounterId: params.encounterId });
                for (const c of params.creatures) {
                    if (c.cr !== undefined || c.xp !== undefined) {
                        monsters.push({ name: c.creature, cr: c.cr, xp: c.xp, count: c.count });
                        continue;
                    }
                    if (!c.creature) return refuse('Each creature needs a name, cr or xp');
                    const found = resolveCreature(db, world, c.creature);
                    if (!found) return refuse(`Unknown creature "${c.creature}"`);
                    monsters.push({ name: found.name, cr: found.spec.cr, xp: found.spec.xpValue, count: c.count });
                }
            }
            if (params.encounterId && (!params.creatures?.length || !levels)) {
                const state = new EncounterRepository(db).loadState(params.encounterId) as { participants: CombatParticipant[] } | null;
                if (!state) return refuse(`Encounter ${params.encounterId} not found`);
                const alive = state.participants.filter(p => p.hp > 0);
                if (!params.creatures?.length) {
                    for (const e of alive.filter(p => p.isEnemy)) monsters.push({ name: e.name, cr: e.cr, count: 1 });
                }
                if (!levels && !params.partyId) levels = allyLevels(alive.filter(p => !p.isEnemy));
            }
            if (!levels && params.partyId) levels = partyLevels(params.partyId);
            if (!levels?.length) return refuse('budget needs partyLevels, a partyId, or an encounterId whose allies have character sheets with levels');
            if (!monsters.length) return refuse('budget needs creatures [{creature | cr | xp, count?}] or an encounterId with hostile tokens');
            const r = budgetEncounter({ partyLevels: levels, monsters });
            return {
                success: true, actionType: 'budget', writes: 'none', ...r,
                message: `${r.monsterCount} monster(s), ${r.rawXp} XP × ${r.multiplier} = ${r.adjustedXp} XP adjusted: ${r.difficulty.toUpperCase()} for ${describeParty(levels)} (easy ${r.thresholds.easy}, medium ${r.thresholds.medium}, hard ${r.thresholds.hard}, deadly ${r.thresholds.deadly})${r.unrated.length ? `; no CR for ${r.unrated.join(', ')}` : ''}. Advisory only.`
            };
        },
        aliases: ['difficulty', 'rate_encounter', 'xp_budget'],
        description: 'Read-only: rate a fight by the 5e XP budget (CR to XP, group multiplier, party thresholds) for given levels, a party or a live encounter'
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
                    hpChanges: a.hpChanges,
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
                // The database is the running state: every call reads the
                // encounter fresh, so an active row IS a running fight.
                // inMemory stays for clients and now means the same.
                running: r.status === 'active',
                inMemory: r.status === 'active'
            }));
            // No memory test can tell a stale row from a live fight any more.
            // Closing active rows in bulk is a deliberate act: confirmBury.
            const ghosts = params.buryGhosts ? encounters.filter(e => e.status === 'active') : [];
            // FINDINGS #80-B: bulk burial — the census found 58+ ghosts spanning
            // the campaign's whole life; one-per-call burial doesn't scale.
            // Buried count comes from the store's changes, never the input.
            let buried = 0;
            // FINDINGS #102-B: the cold-boot nuke. Liveness is "in THIS session's
            // memory" — on a fresh process memory is empty, so every campaign's
            // genuinely-active fight reads as a ghost and buryGhosts would
            // force-complete them all. When NOTHING is in memory, burial needs
            // explicit confirmation.
            if (params.buryGhosts && ghosts.length && !params.confirmBury) {
                return {
                success: true, actionType: 'list', count: encounters.length, encounters,
                ...(params.worldId !== undefined ? { worldId: params.worldId, untaggedOrOtherWorldExcluded: untaggedExcluded } : {}),
                    ghosts: ghosts.map(g => g.encounterId), buried: 0,
                    guardRefused: true,
                    summary: `⚠ GUARD: ${ghosts.length} active encounter(s) listed, and each is a running fight as far as the engine can tell. Nothing was closed. Pass confirmBury:true to close every listed one (narrow it with worldId first), or combat_manage end one at a time.`
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
                summary: encounters.length === 0 ? `No ${params.status === 'all' ? '' : params.status + ' '}encounters.` : `${encounters.length} encounter(s)${params.buryGhosts ? ` — ${buried} closed` : ''}`
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
Aliases: start/begin→create, state/status→get, finish/stop→end, restore/resume→load, next→advance, quick/spawn→spawn_quick_enemy, legendary→legendary_action.

⚔️ QUICK START:
- spawn_quick_enemy: Instantly create combat with preset creatures (goblin, orc, skeleton, etc.)
  Example: { action: "spawn_quick_enemy", creature: "goblin", count: 3 }
  The world's bestiary (table_rules kind creature) comes first: { action: "spawn_quick_enemy", creature: "Chaos Spawn", count: 2, worldId }. add_participant {encounterId, creature, count} adds from it mid-fight.

⚔️ FULL WORKFLOW:
1. create - Start encounter with custom participants and terrain
2. get - View current state
3. advance - Move to next turn
4. death_save - Roll death save for downed character
5. lair_action - Execute boss lair action (LAIR turn only; once per round; damage takes dice; a creature that rolled 20 acts first)
   legendary_action {participantId, cost?, description} - a non-attack legendary action off its turn (attacks: combat_action attack with legendaryCost)
   legendary_resistance {participantId, reason} - turn a failed save into a success
   use_ability {participantId, ability, targetIds?, damage?: number | dice, damageType?, savingThrow?: {ability, dc}} - a limited ability (breath weapon): spends the action, marks a recharge ability spent (it rolls a d6 at the start of its turn), saves per target
   battle_cry {participantId, name?: 'Waaagh!', range?: 60, match?: {species?, band?, tag?, nameIncludes?}, rounds?: 1, attackAdvantage?, damageBonus?: number | dice, speedBonus?, moraleBonus?, ability?, actionCost?} - buffs the caller and matching allies in range until the start of the caller's next turn; actionCost action|bonus only on the caller's turn, none (default) is free and may be called out of turn
   budget {partyLevels | partyId, creatures: [{creature | cr | xp, count?}] | encounterId} - read-only 5e XP budget: TRIVIAL/EASY/MEDIUM/HARD/DEADLY
6. end - Finish combat

For combat ACTIONS (attack, move, cast), use combat_action tool instead.
For MAP operations (render, aoe, terrain), use combat_map tool instead.
For CORPSES after combat, use corpse_manage tool.`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        encounterId: z.string().optional().describe('Encounter ID (required for most actions)'),
        seed: z.string().optional().describe('Seed for new encounter (create only)'),
        participants: z.array(z.any()).optional().describe("Array of participants (create only). Shape per entry: { id: <character UUID — always the UUID>, name, hp, maxHp, initiativeBonus?: number (default 0, #103), ac?: number (falls back to attacker-side derivation), isEnemy?: boolean, position?: {x,y}, plus optional statline: size, reach, movementSpeed, attackBonus, attackDamage, attackDamageType, attacksPerAction, attacks [{name, attackBonus, damage, damageType?, part?, reachFt?, default?}], abilities [{name, recharge?}], legendaryActions, legendaryResistances, legendaryResistancesRemaining, autoLegendaryResistance, hasLairActions, cr, band, regeneration, parts, unit, intent, species, tags }"),
        terrain: z.any().optional().describe('Terrain configuration (create only)'),
        characterId: z.string().optional().describe('Character ID (death_save, add_participant)'),
        // FINDINGS #34 mirror block — add_participant + includeParty params
        includeParty: z.boolean().optional().describe('Include the active party in the new encounter (create / spawn_quick_enemy)'),
        partyId: z.string().optional().describe('Party to include (defaults to the only active party)'),
        name: z.string().optional().describe('add_participant: ad-hoc participant name; add_condition / remove_condition: condition name'),
        hp: z.number().optional().describe('Participant HP (add_participant); set_part: the part\'s own HP'),
        maxHp: z.number().optional().describe('Participant max HP (add_participant); set_part: the part\'s max HP'),
        ac: z.number().optional().describe('Participant AC (add_participant); set_part: AC to hit the part when aimed at'),
        initiativeBonus: z.number().optional().describe('Initiative bonus (add_participant)'),
        participantId: z.string().optional().describe('remove_participant / adjust_hp: participant/token id'),
        value: z.number().optional().describe('adjust_hp: set HP to exactly this'),
        delta: z.number().optional().describe('adjust_hp: shift HP by this amount'),
        reason: z.string().optional().describe('adjust_hp / legendary_resistance (required) / add_condition / remove_condition / legendary_action / use_ability: why — logged'),
        condition: z.any().optional().describe('add_condition / remove_condition: a name ("prone") or {name|type, duration?, durationType?, source?, saveDC?, saveAbility?, level?}; remove also takes the object add_condition returned'),
        conditionId: z.string().optional().describe('remove_condition: one condition instance id'),
        replace: z.boolean().optional().describe('add_condition: drop existing conditions of the same type first'),
        mirrorToCharacter: z.boolean().optional().describe('add_condition / remove_condition: also edit the character sheet'),
        importRowConditions: z.boolean().optional().describe('add_participant: copy the sheet\'s conditions onto the new token'),
        band: z.string().optional().describe('add_participant: table-rules power band (defaults from the character row)'),
        regeneration: z.number().int().min(0).optional().describe('add_participant: HP healed at the start of each of its rounds (defaults from the character row)'),
        revive: z.boolean().optional().describe('adjust_hp: allow raising a dead participant'),
        parts: z.array(PartSchema).optional().describe('add_participant: named parts (defaults from the character row)'),
        // Participant extras (add_participant; create takes them per participant)
        size: SizeCategorySchema.optional().describe('add_participant: tiny | small | medium | large | huge | gargantuan'),
        reach: z.number().optional().describe('add_participant: melee reach in feet'),
        movementSpeed: z.number().optional().describe('add_participant: speed in feet (default 30)'),
        attackBonus: z.number().optional().describe('add_participant: default attack bonus'),
        attackDamage: z.string().optional().describe("add_participant: default attack damage ('1d6+2')"),
        attackDamageType: z.string().optional().describe('add_participant: damage type of the default attack'),
        attacksPerAction: z.number().optional().describe('add_participant: multiattack, attacks per Attack action'),
        attacks: z.array(z.any()).optional().describe('add_participant: named attack profiles [{name, attackBonus, damage, damageType?, part?, reachFt?, default?}]'),
        abilities: z.array(z.any()).optional().describe('add_participant: limited abilities [{name, recharge?, ready?}]'),
        legendaryActions: z.number().optional().describe('add_participant: legendary actions per round'),
        legendaryResistances: z.number().optional().describe('add_participant: legendary resistances per day'),
        legendaryResistancesRemaining: z.number().optional().describe('add_participant: legendary resistances left'),
        autoLegendaryResistance: z.boolean().optional().describe('add_participant: spend a legendary resistance on a failed save automatically'),
        hasLairActions: z.boolean().optional().describe('add_participant: adds a LAIR slot at initiative 20'),
        cr: z.number().optional().describe('add_participant: challenge rating'),
        unit: UnitSchema.optional().describe('add_participant: a mortal unit {models, hpPerModel, packed, attackBonus, tiers}'),
        part: z.string().optional().describe('set_part / remove_part: part name'),
        state: z.enum(PART_STATES).optional().describe('set_part: intact | crippled | dead | latched | breached'),
        kind: z.enum(PART_KINDS).optional().describe('set_part: head | arm | leg | wing | torso | system | other'),
        latchedTo: z.object({ participantId: z.string(), part: z.string().optional() }).optional().describe('set_part latched: who it holds'),
        holds: z.array(z.string()).optional().describe("set_part: weapons or slots the part wields ('axe', 'mainhand')"),
        breakAt: z.number().optional().describe('set_part: one aimed hit dealing at least this much severs the part (integer). set_unit: fraction of models (0-1, exclusive) whose crossing owes a break test (default 0.5)'),
        note: z.string().optional().describe('set_part / trigger_readied: note'),
        targetId: z.string().optional().describe("trigger_readied: who the readied attack strikes (default: its watch, when that names a participant)"),
        attack: z.any().optional().describe('trigger_readied: {using?, attackBonus?, damage?, damageType?, withPart?}, the attack to roll over the stored one'),
        cost: z.number().optional().describe('legendary_action: legendary actions it costs (default 1)'),
        description: z.string().optional().describe("legendary_action: what the creature does ('wing attack')"),
        suppressed: z.boolean().optional().describe('set_unit'),
        inMelee: z.boolean().optional().describe('set_unit'),
        brokenFormation: z.boolean().optional().describe('set_unit'),
        packed: z.boolean().optional().describe('set_unit'),
        routed: z.boolean().optional().describe('set_unit: routed after a failed break test (no volleys); false rallies'),
        morale: z.number().int().optional().describe('set_unit: the morale shown on BREAK TEST DUE'),
        intent: z.string().nullable().optional().describe('set_intent: telegraphed intent (null clears); clears when its turn ends'),
        readied: ReadiedSchema.nullable().optional().describe("set_intent: {action, trigger, on?: enters_reach | leaves_reach, watch?: id | name | 'enemy' | 'any', attack?: {using?, attackBonus?, damage?, damageType?, withPart?}}; stays until it fires or trigger_readied (null clears). With on and attack it fires itself on a move"),
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
        targetIds: z.array(z.string()).optional().describe('lair_action / use_ability: target IDs'),
        damage: z.union([z.number(), z.string()]).optional().describe("lair_action / use_ability: damage, a number or dice ('8d6') rolled once for every target"),
        ability: z.string().optional().describe("use_ability: the ability's name on the token ('Fire Breath'); battle_cry: an ability it spends ('Waaagh!')"),
        range: z.number().optional().describe('battle_cry: feet from the caller (default 60)'),
        match: nearbyMatchSchema().optional().describe('battle_cry: which allies hear it {band?, species?, tag?, nameIncludes?}'),
        rounds: z.number().int().optional().describe("battle_cry: rounds it lasts (default 1: until the caller's next turn)"),
        attackAdvantage: z.boolean().optional().describe('battle_cry: attacks roll with advantage'),
        damageBonus: z.union([z.number(), z.string()]).optional().describe("battle_cry: added to damage on a hit, a number or dice ('1d4')"),
        speedBonus: z.number().optional().describe('battle_cry: feet added to speed'),
        moraleBonus: z.number().optional().describe("battle_cry: added to a unit's morale on a break test"),
        actionCost: z.enum(['action', 'bonus', 'none']).optional().describe("battle_cry: what it costs the caller's turn (default none)"),
        mobRule: mobRuleSchema().nullable().optional().describe('set_unit: {per, maxBonus?, attackBonusPer?, nearby?: {range, match}}; null clears'),
        species: z.string().optional().describe("add_participant: species ('Orruk') that nearby counts and battle cries match"),
        tags: z.array(z.string()).optional().describe('add_participant: free tags nearby matches read'),
        partyLevels: z.array(z.number()).optional().describe('budget: character levels, one per member'),
        creatures: z.array(z.any()).optional().describe('budget: monsters to rate [{creature | cr | xp, count?}]'),
        damageType: z.string().optional().describe('Damage type'),
        savingThrow: z.any().optional().describe('lair_action / use_ability: {ability, dc}'),
        halfDamageOnSave: z.boolean().optional().describe('Half damage on save'),
        // spawn_quick_enemy fields
        creature: z.string().optional().describe('spawn_quick_enemy / add_participant: a world bestiary creature (table_rules kind creature) or built-in template ("goblin", "orc:warrior")'),
        count: z.number().optional().describe('spawn_quick_enemy / add_participant creature: how many (1-10)'),
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
                    output = RichFormatter.header(parsed.alreadyEnded ? 'Already Ended' : 'Combat Ended', '🏁');
                    if (parsed.xpNote) output += `\n⭐ ${parsed.xpNote}\n`;
                    break;
                case 'list':
                    output = RichFormatter.header('Encounters', '📋');
                    if (parsed.encounters?.length > 0) {
                        const rows = parsed.encounters.map((e: { encounterId: string; status: string; round: number; inMemory: boolean; updatedAt: string }) =>
                            [e.encounterId, e.status, String(e.round), e.status === 'active' ? 'running' : 'closed', e.updatedAt]
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
                case 'adjust_hp':
                    output = RichFormatter.header('HP Correction', '🩹');
                    break;
                case 'add_condition':
                case 'remove_condition':
                    output = RichFormatter.header('Condition', '🩸');
                    break;
                case 'set_part':
                case 'remove_part':
                    output = RichFormatter.header('Part', '🦴');
                    break;
                case 'set_unit':
                    output = RichFormatter.header('Unit', '🪖');
                    break;
                case 'set_intent':
                case 'trigger_readied':
                    output = RichFormatter.header('Intent', '⚑');
                    break;
                case 'legendary_action':
                case 'legendary_resistance':
                    output = RichFormatter.header('Legendary', '👑');
                    break;
                case 'use_ability':
                    output = RichFormatter.header('Ability', '✴');
                    break;
                case 'budget':
                    output = RichFormatter.header('Encounter Budget', '⚖️');
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
