/**
 * Consolidated Combat Management Tool
 * Replaces 7 separate tools for encounter lifecycle management:
 * create_encounter, get_encounter_state, end_encounter, load_encounter,
 * advance_turn, roll_death_save, execute_lair_action
 */

import { PartSchema, UnitSchema, readiedInputSchema, readiedAttackInputSchema, PART_STATES, PART_KINDS, ParticipantExtrasShape, tokenAbilityScoresShape, abilityScoresInputSchema, SizeCategorySchema, FightingStyleSchema, nearbyMatchSchema, mobRuleSchema, sensesSchema, type Buff } from '../../schema/token-extras.js';
import { modelsInAreaSchema, unitSavesSchema, MODELS_IN_AREA_DESCRIBE, AREA_DESCRIBE, UNIT_SAVES_DESCRIBE, unitWoundedSchema, UNIT_WOUNDED_DESCRIBE } from '../../schema/token-extras.js';
import { unitsNeedingCount, areaCountMessage, modelsKilledBetween, unitSummaryLine, modelsInAreaFor, type ModelsInArea } from '../../engine/combat/unit-area.js';
import { hydrateExtras, type ExtrasRow } from '../../engine/combat/participant-extras.js';
import { applyDyingConditions, wakeFromDying, tracksDeathSaves, dyingLabel, rowTracksDeathSaves, withDyingRowConditions, DEATH_SAVE_OUTCOMES, type RowCondition } from '../../engine/combat/dying.js';
import { environmentGlyph } from '../../render/pda.js';
import { setPartOn, removePartFrom } from '../../engine/combat/parts.js';
import { patchRowAbility, perRestSpentNote } from '../../engine/combat/abilities.js';
import { volleyTier, describeUnit, breakTestDue, moraleModifiers, liveModels, woundLine, setUnitHp, setWounded, settleWounds, woundedFitProblem } from '../../engine/combat/units.js';
import { sheetSpecies } from '../handlers/world-spell.js';
import { nearbyAllies } from '../../engine/combat/nearby.js';
import type { CombatParticipant } from '../../engine/combat/engine.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createActionRouter, ActionDefinition, McpResponse, describeNestedIgnored } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import {
    handleCreateEncounter,
    handleGetEncounterState,
    handleEndEncounter,
    handleLoadEncounter,
    handleAdvanceTurn,
    handleRollDeathSave,
    settleAreaDeaths, killedLines, markRowDying, clearDyingOnRow, settleAttackDying,
    handleExecuteLairAction,
    initiativeRows,
    getOrLoadEngine,
    liveEncounterFor,
    syncParticipantHpFromDb,
    saveEncounterState,
    mirrorConditionToRow,
    clearNonlethalOnRow,
    resolveReadiedAttack,
    reactionAttackData,
    resolveAreaSave,
    areaSaveRiderSchema
} from '../handlers/combat-handlers.js';
import { settleKnockout, readiedSubdueRefusal, readiedNeedsOnSubdue, readiedRangedNote, readiedRangedFor, readiedOverrideTail, readiedAttackPaste, splitReadiedAttack, withReadiedIgnored } from '../handlers/combat-handlers.js';
import { initiativeDeclarations } from '../handlers/combat-handlers.js';
import { saveSourcesOf, saveLabelsOf } from '../handlers/combat-handlers.js';
import { tagsField } from '../../engine/advantage-sources.js';
import { INITIATIVE_CONTEXT_DESCRIBE, type InitiativeDeclared } from '../../engine/attack-advantage.js';
import { heldReadied, onSubdueAnswer, onSubdueAnswerText, ON_SUBDUE } from '../../engine/combat/subdue.js';
import { rolledReactionLine, heldFireLine, notStruckDownLine, readiedFiredNoAttackLine } from '../../engine/combat/reaction-lines.js';
import { MountSchema, DismountSchema, handleMount, handleDismount, settleMountsAfter, foldSettleIntoReply } from '../handlers/mounts.js';
import { settleDeath, settleTurnDamage, type KilledRecord } from '../handlers/combat-handlers.js';
import { readWorldEnvironment } from '../../engine/world-clock.js';
import { isDying, counters as deathCounters, deathSaveCall, type DeathSaveMode } from '../../engine/combat/dying.js';
import { controlledMountActionRefusal } from '../../engine/combat/mounts.js';
import { budgetEncounter, describeParty, type BudgetMonster } from '../../engine/encounter-budget.js';
import { toLongAbility, rollCharacterSave, tokenAbilityScores, abilityScoresLine, ABILITY_LONG_KEYS, type AbilityScoresLong } from '../../engine/combat/saves.js';
import { saveSidesNote, ENGINE_SAVE_DESCRIBE } from '../../engine/combat/saves.js';
import { sheetConcentrationDie, concentrationLine, engineSaverSides } from '../../engine/combat/saves.js';
import { mirrorLegendaryToSheet } from '../../engine/combat/saves.js';
import { answerLegendaryOffer, legendaryOfferProblem, offerSaveLabel } from '../../engine/combat/legendary-resistance.js';
import { concentrationLegendaryHook, concentrationRestoreCall, concentrationRestoreProblem, restoreConcentrationRow, type LegendaryReplyRow } from '../handlers/legendary-saves.js';
import { damageWithModifiers, type DamageDefences } from '../../engine/combat/damage-modifiers.js';
import { concentrationAfterDamage } from '../../engine/magic/concentration.js';
import { ConcentrationRepository } from '../../storage/repos/concentration.repo.js';
import { loggedRoll } from '../../math/logged-d20.js';
import { parseDiceTerms } from '../../engine/combat/rng.js';
import { listAllTemplates } from '../../data/creature-presets.js';
import { resolveCreature, creatureToParticipant, resolveWorldId, loadRules, bandRuleFor, bandDamageMultiplier, bandOrderFor } from '../../engine/table-rules.js';
import { worldBandDefault, assignAssumedBands, unbandedAdHoc, knownBands, bandAssignmentWarnings, requireBandRefusal, type BandAssignment, type WorldBandDefault } from '../../engine/combat/band-default.js';
import { getDomainServices } from '../domain-services.js';
import { getDb } from '../../storage/index.js';
import { EncounterRepository } from '../../storage/repos/encounter.repo.js';
import { CorpseRepository } from '../../storage/repos/corpse.repo.js';
import { CombatEngine } from '../../engine/combat/engine.js';
import { ConditionInputSchema, SIZE_TABLE, EnvironmentSchema } from '../../schema/encounter.js';
import { coverEnum, coverByTargetSchema, standingAgainstSchema, ignoreCoverSchema, normalizeCover, COVER_BY_TARGET_DESCRIBE, IGNORE_COVER_DESCRIBE, type CoverKind, type StandingCover } from '../../schema/cover.js';
import { saveArithmetic, coverBonus, type CoverResolution } from '../../engine/combat/cover.js';
import { normalizeCondition, normalizeConditions, sourceNamesHolder, grappleSource, stampOngoingShape, ongoingSummary } from '../../engine/combat/conditions.js';
import { getCombatManager } from '../state/combat-manager.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { recordAward } from '../../storage/xp-awards.js';
import { creditKill, growthLine, growthConditionsOnToken, type GrowthCredit } from '../growth.js';
import { getAgentRuntime, buildAgentRuntime } from '../../agent/runtime/deps.js';
import { invokeAgent } from '../../agent/runtime/invoke.js';
import { ProviderFactory } from '../../agent/provider/factory.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['create', 'get', 'end', 'load', 'advance', 'death_save', 'lair_action', 'spawn_quick_enemy', 'add_participant', 'remove_participant', 'adjust_hp', 'add_condition', 'remove_condition', 'set_part', 'remove_part', 'set_unit', 'set_environment', 'set_intent', 'trigger_readied', 'legendary_action', 'legendary_resistance', 'use_ability', 'apply_damage', 'battle_cry', 'set_surprised', 'budget', 'get_history', 'list', 'board', 'set_cover', 'clear_cover', 'set_band', 'set_subdue', 'mount', 'dismount'] as const;
type CombatManageAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const ParticipantSchema = z.object({
    id: z.string(),
    name: z.string(),
    initiativeBonus: z.number().int().optional().describe('FINDINGS #103: optional. Default: the DEX modifier of stats/abilityScores when given (play report 7 #2), else 0'),
    initiative: z.number().int().optional().describe('Optional pre-rolled initiative; otherwise the engine rolls it'),
    // Play report 7 #7 (lane F): read for this token's initiative at create, never stored.
    context: tagsField(INITIATIVE_CONTEXT_DESCRIBE),
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
    ...ParticipantExtrasShape,
    ...tokenAbilityScoresShape()
// Play report 7 #2: passthrough so create can name a participant key it does
// not take (participants[1].str) in ignoredParams; the handler drops them.
}).passthrough();

/**
 * Coerce a participant's `side` into an `isEnemy` boolean.
 * Explicit `isEnemy` wins; otherwise derived from `side`.
 */
function deriveIsEnemy(p: { isEnemy?: boolean; side?: string }): boolean | undefined {
    if (typeof p.isEnemy === 'boolean') return p.isEnemy;
    if (!p.side) return undefined;
    return p.side === 'enemy' || p.side === 'hostile';
}

/**
 * Play report 7 #3: band the tokens about to join a fight. Nothing happens in
 * a world without a band rule (or with no world). Under requireBand an
 * unbanded ad-hoc token is a refusal; otherwise it takes the lowest band,
 * assumed. Mutates the tokens; the caller writes them. With several band
 * ladders, the lowest band comes from the ladder that holds every band the
 * fight already carries (fightBands: the tokens already in it) and these
 * tokens bring (their own or their sheet's), so an orruk fight assumes Grot.
 */
function bandNewTokens(worldId: string | null, tokens: Array<Record<string, unknown>>, what: string, fightBands: Array<string | null | undefined> = []): { refusal?: string; def?: WorldBandDefault; assignment?: BandAssignment } {
    const db = getDb();
    const repo = new CharacterRepository(db);
    const sheetOf = (id: string) => repo.findById(id) as { name?: string; band?: string | null } | null;
    const def = worldBandDefault(db, worldId, [...fightBands, ...knownBands(tokens, sheetOf)]);
    if (!def) return {};
    if (def.requireBand) {
        const unbanded = unbandedAdHoc(tokens, sheetOf);
        if (unbanded.length) return { refusal: requireBandRefusal(unbanded, def, what) };
    }
    return { def, assignment: assignAssumedBands(tokens, def, sheetOf) };
}

/** The reply fields for a band assignment: bandAssumed rows and the warning lines. */
function bandReply(b: { def?: WorldBandDefault; assignment?: BandAssignment }, encounterId: string, warnings: string[] = []): { bandAssumed?: BandAssignment['assumed']; warnings?: string[] } {
    const lines = b.def && b.assignment ? bandAssignmentWarnings(b.assignment, b.def, encounterId) : [];
    const all = [...warnings, ...lines];
    return {
        ...(b.assignment?.assumed.length ? { bandAssumed: b.assignment.assumed } : {}),
        ...(all.length ? { warnings: all } : {})
    };
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
function ordinal(n: number): string {
    const teen = n % 100 >= 11 && n % 100 <= 13;
    return `${n}${teen ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * Play report 7 #9: where each joiner falls in the order: its roll, modifier
 * and d20, and its slot (1-based, LAIR counted) of the whole order.
 */
function joinerInitiative(state: Parameters<typeof initiativeRows>[0], ids: string[], declared?: Map<string, InitiativeDeclared>): Array<ReturnType<typeof initiativeRows>[number] & { position: number; of: number; firstRound: number }> {
    // Review: the order keeps the current turn anchored, so a joiner whose
    // slot sits before the current actor's first acts next round.
    return initiativeRows(state, { ids, declared }).map(r => {
        const at = state.turnOrder.indexOf(r.id);
        return { ...r, position: at + 1, of: state.turnOrder.length, firstRound: at > state.currentTurnIndex ? state.round : state.round + 1 };
    });
}

/** 'initiative 14 (d20 13 +1), 2nd of 3 in the order, acts this round' for one joiner. */
function joinerLine(r: ReturnType<typeof joinerInitiative>[number], round: number): string {
    const mod = r.modifier ?? 0;
    // Play report 7 #7 (lane F): the declared sources on the roll, and both dice when two were rolled.
    const declared = [
        r.rolls?.length ? `rolled ${r.rolls.join(' and ')}` : '',
        r.advantage?.length ? `advantage ← ${r.advantage.join(', ')}` : '',
        r.disadvantage?.length ? `disadvantage ← ${r.disadvantage.join(', ')}` : '',
        r.advantage?.length && r.disadvantage?.length ? 'they cancel: one die' : ''
    ].filter(Boolean).join('; ');
    const when = r.firstRound > round ? `first turn in round ${r.firstRound} (its slot has passed this round)` : 'acts this round';
    return `initiative ${r.roll} (d20 ${r.natural} ${mod >= 0 ? '+' : '-'}${Math.abs(mod)}${declared ? `; ${declared}` : ''}), ${ordinal(r.position)} of ${r.of} in the order, ${when}`;
}

/** Play report 7 #2: the hint for a participant key create does not take. */
function participantKeyHint(key: string): string | undefined {
    if (toLongAbility(key)) return `an ability score: pass stats: {${key.trim().slice(0, 3).toLowerCase()}: …}`;
    if (key === 'speed') return "nearest valid key 'movementSpeed'";
    return undefined;
}

/**
 * Review of play report 7 #2: add_participant names a top-level ability key
 * (str: 15, Dexterity: 14) the way create names a nested one, instead of
 * "no close match". The router's hints are exact keys: each spelling is listed.
 */
const ADD_PARTICIPANT_KEY_HINTS: Record<string, string> = Object.fromEntries([
    ...ABILITY_LONG_KEYS.flatMap(l => [l.slice(0, 3), l])
        .flatMap(k => [k, k.toUpperCase(), `${k[0].toUpperCase()}${k.slice(1)}`])
        .map(k => [k, participantKeyHint(k)!]),
    ['speed', participantKeyHint('speed')!]
]);

/** Play report 7 #2: a sheet-backed token keeps its sheet's scores; say so and name the fix. */
function sheetScoresWarning(name: string, row: { id: string; stats?: unknown }): string {
    return `${name} is sheet-backed: the sheet's ability scores win (${abilityScoresLine((row.stats ?? {}) as Record<string, number>)}); the scores sent were not written. Change them with character_manage update {characterId: '${row.id}', stats: {…}}`;
}

/**
 * Play report 7 #2: the ability scores a caller gave a new token. A
 * sheet-backed token (row) keeps its sheet: nothing is set and a warning
 * says so. Otherwise the token gets the full set (missing ones from base,
 * else 10), and initiativeBonus from DEX when the caller gave none.
 */
function applyTokenScores(
    p: { name?: unknown; stats?: Record<string, number>; abilityScores?: Record<string, number>; initiativeBonus?: number },
    row: { id: string; name?: string; stats?: unknown } | null | undefined,
    base?: Partial<AbilityScoresLong> | null
): { problem: string } | { scores?: AbilityScoresLong; initiativeBonus?: number; warning?: string } {
    const r = tokenAbilityScores({ stats: p.stats, abilityScores: p.abilityScores }, base);
    if (r.problem) return { problem: r.problem };
    if (!r.scores) return {};
    if (row) return { warning: sheetScoresWarning(String(p.name ?? row.name ?? row.id), row) };
    const dexGiven = r.given?.dexterity !== undefined;
    return {
        scores: r.scores,
        ...(p.initiativeBonus === undefined && (dexGiven || !base) ? { initiativeBonus: Math.floor((r.scores.dexterity - 10) / 2) } : {})
    };
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

/** Hosts that stringify nested objects: accept the JSON text too. */
const environmentField = () => z.preprocess(
    (val) => {
        if (typeof val === 'string' && val.trim().startsWith('{')) {
            try { return JSON.parse(val); } catch { return val; }
        }
        return val;
    },
    EnvironmentSchema
);

const CreateSchema = z.object({
    action: z.literal('create'),
    seed: z.string().optional().describe('Omit for crypto dice (default). A seed makes the fight a deterministic, replayable stream; the id echoes it'),
    participants: z.array(ParticipantSchema).min(1),
    terrain: TerrainSchema,
    environment: environmentField().optional().describe("The medium and light of the fight: {medium: 'air'|'water'|'vacuum', depthFt?, pressure?: {startsAtFt, damagePerRound: number | dice, unlessTag?, damageType?, save?: {ability, dc, half? (default true)}} (an area: every model of a unit takes it separately, each with its own save; any other token one save, legendary resistance offered), rangedAllowed? (default false in water), meleeDisadvantageUnlessDamageType? (default ['piercing']), swimTag? (default 'aquatic'), light?: 'bright' | 'dim' | 'darkness' (darkness: tokens can attempt a Hide from foes without darkvision; get shows canHide)}"),
    includeParty: z.boolean().optional().describe('T1.2 (Findings #34): prepend the active party as PC-side participants'),
    partyId: z.string().optional().describe('Party to include (defaults to the only active party)'),
    worldId: z.string().optional().describe('FINDINGS #105: stamp the encounter to this world; omitted → derived from the first participant whose character row is claimed'),
    surprised: z.array(z.string()).optional().describe('Participant ids caught flat-footed: their round-1 turn passes and they cannot react, act or take legendary actions until it has')
});

const GetSchema = z.object({
    action: z.literal('get'),
    encounterId: z.string().describe('The ID of the encounter')
});

const EndSchema = z.object({
    action: z.literal('end'),
    encounterId: z.string().describe('The ID of the encounter'),
    xpAward: z.number().int().optional().describe('FINDINGS #34 T4.17: XP credited on end — split evenly among pc-type participants unless xpRecipients given; each share lands in the award ledger (reason: encounter <id>)'),
    xpRecipients: z.array(z.string()).optional().describe('Character IDs to receive xpAward (overrides the pc-participant default)'),
    winner: z.string().optional().describe("Request 5: on a boarding encounter, who won ('attackers' | 'defenders' | a participant id or name); reported to the parent fight"),
    summary: z.string().optional().describe('Request 5: on a boarding encounter, one line for the parent fight (default: the survivors)')
});

/**
 * Request 5: a boarding action. Both tokens must be vessels in the fight;
 * a NEW encounter is created for the boarding party, linked to this one by
 * encounters.parent_id, with the target's rooms noted. The void fight goes
 * on; end on the boarding reports back to it.
 */
const BoardSchema = z.object({
    action: z.literal('board'),
    encounterId: z.string().describe('The void fight'),
    attackerId: z.string().describe('The boarding vessel (a vessel token in this encounter)'),
    targetId: z.string().describe('The vessel being boarded (a vessel token in this encounter)'),
    rooms: z.array(z.string()).optional().describe("The target's rooms the boarders fight through (default: the spatial rooms of the target's deck plan, when its network exists)"),
    name: z.string().optional().describe("A label for the boarding ('Gloriana boards the Murder-class')"),
    seed: z.string().optional().describe('Seed the boarding encounter (default crypto dice)')
});

const LoadSchema = z.object({
    action: z.literal('load'),
    encounterId: z.string().describe('The ID of the encounter to load')
});

const AdvanceSchema = z.object({
    action: z.literal('advance'),
    encounterId: z.string().describe('The ID of the encounter'),
    // Play report 7 #6: the PC turn guard.
    confirm: z.boolean().optional().describe("Pass the turn of a player character (pc row, heroes' side) who has used no action, bonus action, movement or other combat action this turn: the player passes or holds. Without it advance refuses with TURN NOT TAKEN (writes: none); with it the reply carries skippedTurn {participantId, name, round} and the pass is logged"),
    skipTurn: z.boolean().optional().describe('Alias of confirm')
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

// Play report 5 #5: participantId is the convention every other combat_manage
// action uses; characterId stays as the alias the first version took. A
// posted outcome applies the table's roll without a die.
const DeathSaveSchema = z.object({
    action: z.literal('death_save'),
    encounterId: z.string().describe('The ID of the encounter'),
    participantId: z.string().optional().describe('The participant/token id at 0 HP'),
    characterId: z.string().optional().describe('Alias of participantId (a sheet-backed token has its character id)'),
    outcome: z.union([z.enum(DEATH_SAVE_OUTCOMES), z.string(), z.number()]).optional().describe("A result the table rolled: success | failure | nat20 | nat1 (also pass/fail, 'natural 20', or the natural die 1-20). No d20 is rolled; the counters move as posted and the sheet follows")
}).refine(p => !!(p.participantId || p.characterId), { message: 'death_save needs participantId (the token at 0 HP)', path: ['participantId'] });

const LairActionSchema = z.object({
    action: z.literal('lair_action'),
    encounterId: z.string().describe('The ID of the encounter'),
    actionDescription: z.string().describe('Description of the lair action'),
    targetIds: z.array(z.string()).optional(),
    damage: z.union([z.number().int().min(0), z.string().min(1)]).optional().describe("A number or dice ('2d10'), rolled once"),
    damageType: z.string().optional(),
    savingThrow: z.object({
        ability: z.enum(['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']),
        dc: z.number().int().min(1).max(30),
        onFail: areaSaveRiderSchema().optional().describe("Play report 5 #6: conditions for a target that fails ({conditions: ['prone', {name, duration?, source?}], mirrorToCharacter?})"),
        onSuccess: areaSaveRiderSchema().optional().describe('Play report 5 #6: conditions for a target that saves')
    }).optional().describe(`Each target saves on its own die. ${ENGINE_SAVE_DESCRIBE}`),
    halfDamageOnSave: z.boolean().default(true),
    cover: coverByTargetSchema().optional().describe(COVER_BY_TARGET_DESCRIBE),
    area: z.boolean().optional().describe(`${AREA_DESCRIBE}. A lair action is an area unless area: false`),
    modelsInArea: modelsInAreaSchema().optional().describe(MODELS_IN_AREA_DESCRIBE)
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
        dc: z.number().int().min(1).max(30),
        onFail: areaSaveRiderSchema().optional().describe("Play report 5 #6: conditions for a target that fails ({conditions: ['prone', {name, duration?, source?}], mirrorToCharacter?})"),
        onSuccess: areaSaveRiderSchema().optional().describe('Play report 5 #6: conditions for a target that saves')
    }).optional().describe(`Each target saves on its own die. ${ENGINE_SAVE_DESCRIBE}`),
    halfDamageOnSave: z.boolean().default(true),
    cover: coverByTargetSchema().optional().describe(`${COVER_BY_TARGET_DESCRIBE}. Unset: computed from the user's token to each target`),
    area: z.boolean().optional().describe(`${AREA_DESCRIBE} (a breath weapon, a cone). Unset: an area when modelsInArea is given`),
    modelsInArea: modelsInAreaSchema().optional().describe(MODELS_IN_AREA_DESCRIBE),
    reason: z.string().optional()
});

const ApplyDamageSchema = z.object({
    action: z.literal('apply_damage'),
    encounterId: z.string().optional().describe('The fight whose dice, tokens and log take it; omit for damage outside a fight (a character with a live token is routed through its encounter)'),
    targetIds: z.array(z.string()).min(1).describe('Token ids in the encounter, or character ids without one'),
    actorId: z.string().optional().describe("Who deals it (a token or character id), when something does: the band rule's damageScale then scales each target's damage by the band gap, and every target it drops to 0 is a kill on the actor's growth track (perKill, perBandAbove; growth[] and a GROWTH line). Omit for environmental damage (never band-scaled, never credited)"),
    dice: z.union([z.number().int().min(0), z.string().min(1)]).describe("Dice ('6d10', '2d6+3') rolled once for every target, or a number"),
    damageType: z.string().optional().describe('Resistances, immunities and vulnerabilities read it'),
    source: z.string().min(1).describe("What deals it ('falling rubble', \"An'ggrath's bite\"): the roll is logged as 'damage: <source>'"),
    save: z.object({
        ability: z.string().describe("'dex', 'Dexterity' or 'dexterity'"),
        dc: z.number().int().min(1).max(30),
        half: z.boolean().default(true).describe('A save halves the damage (false: a save takes none)'),
        onFail: areaSaveRiderSchema().optional().describe("Play report 5 #6: conditions applied to each target that FAILS: {conditions: ['prone', {name: 'Buried', source: 'rockslide'}], mirrorToCharacter?}. Token only by default; the sheet path writes the row"),
        onSuccess: areaSaveRiderSchema().optional().describe('Play report 5 #6: conditions applied to each target that SAVES')
    }).optional().describe(`Each target saves on its own die; onFail / onSuccess carry riders. ${ENGINE_SAVE_DESCRIBE} (on the sheets too: a sheet's Restrained or Exhaustion 3 condition counts)`),
    cover: coverByTargetSchema().optional().describe(`${COVER_BY_TARGET_DESCRIBE}. Unset in an encounter with actorId: computed from the actor's token to each target. The sheet path takes the stated value only`),
    area: z.boolean().optional().describe(`${AREA_DESCRIBE} (rubble, a blast). Unset: an area when modelsInArea is given`),
    modelsInArea: modelsInAreaSchema().optional().describe(MODELS_IN_AREA_DESCRIBE)
});

const SetCoverSchema = z.object({
    action: z.literal('set_cover'),
    encounterId: z.string(),
    participantId: z.string().describe('The token taking cover'),
    level: coverEnum().describe("half (+2 AC and DEX saves) | three-quarters (+5) | total (cannot be targeted directly) | none (same as clear_cover)"),
    against: standingAgainstSchema().optional().describe("Who it protects against: ['fg-handguns', 'fg-crossbows'] (participant ids or names), or {direction: 'west'} (attackers to the west of the token, read from both positions). Unset: everyone"),
    reason: z.string().optional().describe("What gives it ('rubble crest'): printed in every arithmetic line and refusal")
});

const ClearCoverSchema = z.object({
    action: z.literal('clear_cover'),
    encounterId: z.string(),
    participantId: z.string()
});

// Play report 7 #3: a token's band, changed mid-fight. Applies from the next
// roll, never to one already made; clears an assumed band's mark.
const SetBandSchema = z.object({
    action: z.literal('set_band'),
    encounterId: z.string(),
    participantId: z.string().describe('The token whose band changes'),
    band: z.string().min(1).describe("A band in the world's order (any case: 'elite mortal'); refused, naming the order, when it is not one"),
    reason: z.string().optional().describe('Why: logged')
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
    seed: z.string().optional().describe('Omit for crypto dice (default); a seed makes a deterministic, replayable stream'),
    includeParty: z.boolean().optional().describe('T1.2 (Findings #34): include the active party as PC-side participants in the NEW encounter'),
    partyId: z.string().optional().describe('Party to include (defaults to the only party if exactly one exists)'),
    worldId: z.string().optional().describe("The world whose bestiary (table_rules kind creature) is searched before the built-in presets; defaults to the encounter's world. Stamped on a new encounter")
});

/** Play report 7 #4: a caller's token id: letters, digits, _ . : - (64 at most). */
const CALLER_TOKEN_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

const AddParticipantSchema = z.object({
    action: z.literal('add_participant'),
    encounterId: z.string().describe('Encounter to add to'),
    id: z.string().regex(CALLER_TOKEN_ID, "letters, digits, _ . : - (1-64 characters), e.g. 'hound-1'").optional().describe("Play report 7 #4: the token id later calls use ('hound-1'; default token-xxxxxxxx). Refused, with nothing written, when it is already in this encounter, is LAIR, or is a character row's id without that characterId (a sheet-backed token's id is its characterId). A creature count numbers it: id-1 … id-n"),
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
    // Play report 7 #7 (lane F): the tags the joiners' initiative asserts (every token this call adds).
    context: tagsField(INITIATIVE_CONTEXT_DESCRIBE),
    band: z.string().optional().describe('Table rules: power band (defaults from the character row)'),
    regeneration: z.number().int().min(0).optional().describe('Table rules: HP healed at the start of each of its rounds (defaults from the character row)'),
    parts: z.array(PartSchema).optional().describe('Named parts with states (defaults from the character row)'),
    unit: UnitSchema.optional().describe('A mortal unit as one token'),
    ...ParticipantExtrasShape,
    ...tokenAbilityScoresShape()
});

const AddConditionSchema = z.object({
    action: z.literal('add_condition'),
    encounterId: z.string(),
    participantId: z.string().describe('Participant/token id'),
    condition: ConditionInputSchema.optional().describe("A name (\"prone\") or {name|type, duration?, durationType?, source?, saveDC?, saveAbility?, level?, ongoing?}; unknown names are kept as custom conditions. ongoing: {damage: number | dice, damageType?, when: start | end, save?: {ability, dc, onSuccess?: none | half | end}} ticks on the bearer's turn"),
    name: z.string().optional().describe('Shorthand for condition: a bare condition name'),
    // Play report 7 follow-up (lane O): ongoing damage follows its source's shape.
    area: z.boolean().optional().describe("Play report 7 follow-up: the condition's ongoing damage comes from an area (a lingering cloud, a burning field): on a unit token it ticks per model inside, each with its own save, the count dropping as they die. A packed unit: every live model; a spaced one needs modelsInArea. Unset: single target (the most wounded model takes each tick, capped at it; the condition ends when that model dies)"),
    modelsInArea: modelsInAreaSchema().optional().describe('Play report 7 follow-up: models of the unit inside the area that left the ongoing damage (a bare number, or {participantId: n}); giving it makes the ongoing damage an area'),
    replace: z.boolean().optional().describe('Drop existing conditions of the same type first'),
    mirrorToCharacter: z.boolean().optional().describe('Also add it to the character sheet (upsert by name)'),
    fromGrapple: z.string().optional().describe("Holder (participant id or name): writes source 'grapple: <holder id>' so grapple execute and break recognise the hold; refused when ambiguous or when condition.source names someone else"),
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

const SetEnvironmentSchema = z.object({
    action: z.literal('set_environment'),
    encounterId: z.string(),
    environment: environmentField().describe("{medium: 'air'|'water'|'vacuum', depthFt?, pressure?: {startsAtFt, damagePerRound: number | dice, unlessTag?, damageType?, save?: {ability, dc, half? (default true)}} (an area: every model of a unit takes it separately, each with its own save; any other token one save, legendary resistance offered), rangedAllowed?, meleeDisadvantageUnlessDamageType?, swimTag?, light?: 'bright' | 'dim' | 'darkness'} — replaces the whole environment (medium defaults to air: pass it again when setting light in a water fight). Darkness lets tokens attempt a Hide from foes without darkvision (get shows canHide)"),
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
    models: z.number().int().min(1).optional().describe('Reinforce or reduce: the new full strength. Raising it adds the new models × hpPerModel to HP; lowering it clamps HP to the new maximum'),
    hpPerModel: z.number().int().min(1).optional().describe('New HP per model; the maximum follows (models × hpPerModel) and HP is clamped'),
    saves: unitSavesSchema().nullable().optional().describe(`${UNIT_SAVES_DESCRIBE}. Replaces the block; null clears`),
    wounded: unitWoundedSchema().nullable().optional().describe(`${UNIT_WOUNDED_DESCRIBE}. set_unit {wounded: [5, 2]} sets the wounded models' HP, the live count kept: HP moves to match (unhurt × hpPerModel + the list); [] heals every wound; null drops the list (the pool reads the old way, a remainder below hpPerModel one wounded model). A new hpPerModel, or fewer models than stand, resets it; reinforcing keeps it (new models arrive unhurt)`),
    reason: z.string().optional()
});

const SetIntentSchema = z.object({
    action: z.literal('set_intent'),
    encounterId: z.string(),
    participantId: z.string(),
    intent: z.string().nullable().optional().describe('Telegraphed intent; clears when its turn ends. null clears now'),
    // Lane G2 review: unknown keys inside readied.attack are kept so the handler names them (ignoredParams), never stored.
    readied: readiedInputSchema().nullable().optional().describe('{action, trigger, on?, watch?, attack?}: stays across turns until it fires (on + attack: on a move, as a reaction) or trigger_readied. null clears')
});

const TriggerReadiedSchema = z.object({
    action: z.literal('trigger_readied'),
    encounterId: z.string(),
    participantId: z.string(),
    cover: coverByTargetSchema().optional().describe("Play report 5 #1: the target's cover as the GM states it ('half', or {targetId: kind}); unset: standing cover, else the map"),
    note: z.string().optional().describe('What happened when it fired'),
    targetId: z.string().optional().describe("Who the readied attack strikes (default: the readied action's watch, when it names a participant)"),
    attack: readiedAttackInputSchema().optional().describe("{using?, attackBonus?, damage?, damageType?, withPart?, twoHanded?, ranged?, onSubdue?}: the attack to roll, over the stored one (twoHanded: great weapon fighting applies, dueling does not). An attack carrying only onSubdue and/or ranged amends the stored one (its weapon kept). A key it does not take comes back in ignoredParams (attack.<key>)")
});

const SetSubdueSchema = z.object({
    action: z.literal('set_subdue'),
    encounterId: z.string(),
    participantId: z.string(),
    subdue: z.boolean().optional().describe("Play report 7 #5: true puts a standing 'take them alive' order on the token (its opportunity attacks and readied melee swings knock out instead of killing); false lifts it. Omit to keep the current order while answering onSubdue"),
    onSubdue: z.enum(ON_SUBDUE).optional().describe("The answer for the token's readied attack: 'hold' (a ranged shot holds fire; reaction and shot kept) or 'fire' (it fires lethally, 'subdue order overridden'). Written onto the readied attack"),
    reason: z.string().optional().describe('Why — logged')
});

const SetSurprisedSchema = z.object({
    action: z.literal('set_surprised'),
    encounterId: z.string(),
    participantIds: z.array(z.string()).min(1).describe('Who is caught flat-footed (or, with surprised: false, who no longer is)'),
    surprised: z.boolean().default(true).describe('true (default) flags them; false clears a flag set by mistake'),
    reason: z.string().optional().describe('Why — logged')
});

// Play report 7 follow-up (lane L): an offered failed save the engine rolled, answered after the fact.
const LEGENDARY_SAVE_REF_DESCRIBE = "legendary_resistance: the offer to answer ('eot-2-boss-1'), from an offered save (endOfTurnSaves[].legendaryOffer, concentrationSaves[].legendaryOffer, a stunt target's legendaryOffer, legendaryOffers[]): the spend turns that failed save into a success. A save_ends condition ends; a concentration save ('con-…') puts the spell back as it stood (refused if the creature has started concentrating on something else since, or is at 0 HP); a stunt's save ('stu-…') heals back the damage a success would have avoided, on the token and its sheet. Offers lapse when the creature's next turn starts; an unknown, lapsed or already-answered ref, or a condition already gone, is refused with nothing spent. An ongoing tick's or a creature's pressure save ('ong-…', turnDamage[].legendaryOffer) heals back the damage the success would have avoided, and ends the condition when its save ends it on a success. Without it the spend only lowers the count, as before";

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
    reason: z.string().describe('The save it turns into a success'),
    saveRef: z.string().optional().describe(LEGENDARY_SAVE_REF_DESCRIBE)
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
async function appendToEncounter(ctx: SessionContext, encounterId: string, newParticipants: Record<string, unknown>[], opts: { duplicateHint?: string; initiativeContext?: string[] } = {}): Promise<{ ok: boolean; message: string; state?: ReturnType<CombatEngine['addParticipants']>; writes?: 'none'; initiativeDeclared?: Map<string, InitiativeDeclared>; initiativeWarnings?: string[] }> {
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
    // Play report 7 #4: one id, one token. A caller id already in the fight,
    // or a characterId added twice, is refused before anything moves.
    const seen = new Set<string>();
    for (const np of newParticipants) {
        const id = String(np.id);
        const holder = engine.getState()?.participants.find(p => p.id === id);
        if (holder || seen.has(id)) {
            return { ok: false, writes: 'none', message: `id '${id}' is already in this encounter (${holder?.name ?? String(np.name)})${opts.duplicateHint ? `: ${opts.duplicateHint}` : ''}. Nothing was written.` };
        }
        seen.add(id);
        // Lane W review: a wound list that cannot stand beside the HP is refused, not silently read as the pool.
        const woundProblem = np.unit && typeof np.hp === 'number' ? woundedFitProblem({ hp: np.hp, unit: np.unit as CombatParticipant['unit'] }) : null;
        if (woundProblem) return { ok: false, writes: 'none', message: `${String(np.name ?? id)}: ${woundProblem}. Nothing was written.` };
    }
    // Play report 7 #7 (lane F): declared initiative for each joiner (untagged
    // initiative / check:dex mechanics on its effects; tagged ones the call's
    // context asserts).
    const declaredInit = initiativeDeclarations(newParticipants.map(np => ({ id: String(np.id), name: typeof np.name === 'string' ? np.name : undefined, context: opts.initiativeContext })));
    const state = engine.addParticipants(newParticipants as unknown as Parameters<typeof engine.addParticipants>[0], { initiativeSources: declaredInit.sources });
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
    return { ok: true, message: 'appended', state, initiativeDeclared: engine.initiativeDeclared, initiativeWarnings: declaredInit.warnings };
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
            // Play report 7 #2: a participant key create does not take is named
            // (participants[1].str) and dropped; stats / abilityScores become the
            // token's scores, refused before anything is written when a key
            // names no ability or one ability is given two values.
            const validParticipantKeys = Object.keys(ParticipantSchema.shape);
            const nestedIgnored: Array<{ path: string; key: string; hint?: string }> = [];
            const createWarnings: string[] = [];
            const givenScores = new Map<string, AbilityScoresLong>();
            const charRepo = new CharacterRepository(getDb());
            const cleaned: typeof params.participants = [];
            for (const [i, raw] of params.participants.entries()) {
                const p = { ...raw } as Record<string, unknown>;
                for (const k of Object.keys(p)) {
                    if (validParticipantKeys.includes(k) || p[k] === undefined) continue;
                    nestedIgnored.push({ path: `participants[${i}].${k}`, key: k, hint: participantKeyHint(k) });
                    delete p[k];
                }
                const row = typeof p.id === 'string' ? charRepo.findById(p.id) : null;
                const scored = applyTokenScores(p as Parameters<typeof applyTokenScores>[0], row);
                if ('problem' in scored) {
                    return { error: true, actionType: 'create', writes: 'none', message: `participants[${i}] (${String(p.name ?? p.id)}): ${scored.problem}. Encounter NOT created; nothing was written.` };
                }
                delete p.stats; delete p.abilityScores;
                if (scored.scores) { p.abilityScores = scored.scores; givenScores.set(String(p.id), scored.scores); }
                if (scored.initiativeBonus !== undefined) p.initiativeBonus = scored.initiativeBonus;
                if (scored.warning) createWarnings.push(scored.warning);
                // Play report 7 #4: one id, one token; LAIR is the lair's slot.
                if (String(p.id).toUpperCase() === 'LAIR') {
                    return { error: true, actionType: 'create', writes: 'none', message: `participants[${i}] (${String(p.name)}): id 'LAIR' is the lair's turn-order slot (initiative 20); pick another id. Encounter NOT created; nothing was written.` };
                }
                const twin = cleaned.findIndex(c => c.id === p.id);
                if (twin >= 0) {
                    return { error: true, actionType: 'create', writes: 'none', message: `participants[${twin}] and participants[${i}] share id '${String(p.id)}' (${cleaned[twin].name}, ${String(p.name)}): one id, one token. Encounter NOT created; nothing was written.` };
                }
                // Lane W review: a wound list that cannot stand beside the HP is refused, not silently read as the pool.
                const unitGiven = p.unit as CombatParticipant['unit'];
                const hpGiven = typeof p.hp === 'number' ? p.hp : row?.hp;
                const woundProblem = unitGiven && hpGiven !== undefined ? woundedFitProblem({ hp: hpGiven, unit: unitGiven }) : null;
                if (woundProblem) {
                    return { error: true, actionType: 'create', writes: 'none', message: `participants[${i}] (${String(p.name ?? p.id)}): ${woundProblem}. Encounter NOT created; nothing was written.` };
                }
                cleaned.push(p as typeof params.participants[number]);
            }
            // Map convenience `side` field down to canonical `isEnemy` and drop `side`
            // before forwarding to handleCreateEncounter (which doesn't accept it).
            const normalizedParticipants = cleaned.map((p) => {
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
                terrain: params.terrain,
                ...(params.environment ? { environment: params.environment } : {}),
                ...(params.surprised?.length ? { surprised: params.surprised } : {})
            };
            // Surprise names participants of this fight (the party included).
            if (params.surprised?.length) {
                const ids = new Set(originalParams.participants.map(p => p.id as string));
                const unknown = params.surprised.filter(id => !ids.has(id));
                if (unknown.length) {
                    return { error: true, actionType: 'create', message: `surprised names no participant: ${unknown.join(', ')} (participants: ${[...ids].join(', ')}). Nothing was written.`, writes: 'none' };
                }
            }
            // Play report 7 #3: every token gets its band at create: explicit,
            // the sheet's, else the world's lowest (assumed). Under requireBand
            // an unbanded ad-hoc token is refused before anything is written.
            const banded = bandNewTokens(
                (params as { worldId?: string }).worldId ?? resolveWorldId(getDb(), { characterIds: originalParams.participants.map(p => String(p.id ?? '')) }),
                originalParams.participants, 'Encounter NOT created; nothing was written.'
            );
            if (banded.refusal) return { error: true, actionType: 'create', writes: 'none', message: banded.refusal };
            const result = await handleCreateEncounter(originalParams, ctx);
            const data = extractResultData(result, 'create') as Record<string, unknown>;
            // T1.3 (Findings #34): print the wall before the party hits it.
            if (!data.error) data.threat = threatReadout(originalParams.participants);
            if (!data.error && gateSkipped.length) data.stageGateSkipped = gateSkipped;
            // Play report 7 #2: the scores each token was given, the sheet-wins
            // warnings, and the participant keys that did nothing.
            if (!data.error) {
                if (givenScores.size && Array.isArray(data.participants)) {
                    for (const row of data.participants as Array<Record<string, unknown>>) {
                        const s = givenScores.get(String(row.id));
                        if (s) row.abilityScores = s;
                    }
                }
                Object.assign(data, bandReply(banded, String(data.encounterId), [...((data.warnings as string[] | undefined) ?? []), ...createWarnings]));
                if (nestedIgnored.length) {
                    data.ignoredParams = nestedIgnored.map(e => e.path);
                    data.message = describeNestedIgnored('participant', nestedIgnored, validParticipantKeys);
                }
            }
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
            const data = extractResultData(result, 'get') as Record<string, unknown>;
            // Request 5: linked boardings (parent) or the fight this boarding came from (child).
            try {
                const repo = new EncounterRepository(getDb());
                const notes = repo.getNotes(params.encounterId);
                const parentId = repo.parentOf(params.encounterId);
                if (parentId) { data.parentEncounterId = parentId; if (notes.boardingFrom) data.boardingFrom = notes.boardingFrom; }
                const children = repo.childrenOf(params.encounterId);
                if (children.length) {
                    const boardings = (notes.boardings as Array<Record<string, unknown>> | undefined) ?? [];
                    data.boardings = children.map(c => ({ ...(boardings.find(b => b.childEncounterId === c.id) ?? {}), encounterId: c.id, status: c.status }));
                    if (notes.boardingResults) data.boardingResults = notes.boardingResults;
                }
            } catch { /* no notes column (old db) — the state is the answer */ }
            return data;
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
            // Request 5: a boarding reports to its parent fight when it ends.
            let parentId: string | null = null;
            let survivors: string[] = [];
            try {
                const repo = new EncounterRepository(getDb());
                parentId = repo.parentOf(params.encounterId);
                if (parentId) {
                    const persisted = repo.loadState(params.encounterId) ?? getCombatManager().get(`${ctx.sessionId}:${params.encounterId}`)?.getState();
                    survivors = (persisted?.participants ?? []).filter((p: { hp: number }) => p.hp > 0).map((p: { name: string }) => p.name);
                }
            } catch { /* no parent link */ }
            const result = await handleEndEncounter({ encounterId: params.encounterId }, ctx);
            const data = extractResultData(result, 'end') as Record<string, unknown>;
            if (parentId && !data.error) {
                try {
                    const repo = new EncounterRepository(getDb());
                    const summary = params.summary ?? (survivors.length ? `survivors: ${survivors.join(', ')}` : 'no one left standing');
                    const boardingResult = { child: params.encounterId, ...(params.winner ? { winner: params.winner } : {}), summary, endedAt: new Date().toISOString() };
                    const parentNotes = repo.getNotes(parentId);
                    const results = [...((parentNotes.boardingResults as unknown[] | undefined) ?? []), boardingResult];
                    const boardings = ((parentNotes.boardings as Array<Record<string, unknown>> | undefined) ?? []).map(b => b.childEncounterId === params.encounterId ? { ...b, status: 'ended' } : b);
                    repo.mergeNotes(parentId, { boardingResults: results, boardings });
                    data.parentEncounterId = parentId;
                    data.boardingResult = boardingResult;
                    data.message = `${data.message ?? 'Boarding ended.'} Reported to the void fight ${parentId}: ${params.winner ? `${params.winner} win — ` : ''}${summary}.`;
                } catch { /* parent gone: the boarding still ended */ }
            }
            if (params.xpAward && xpTargets.length > 0 && !data.error) {
                const db = getDb();
                const charRepo = new CharacterRepository(db);
                const each = Math.floor(params.xpAward / xpTargets.length);
                const credited: Array<{ id: string; name: string; xp: number }> = [];
                // Request 3: every XP write leaves a posted ledger row.
                let encWorld: string | null = null;
                try { encWorld = resolveWorldId(db, { encounterId: params.encounterId }); } catch { encWorld = null; }
                for (const id of xpTargets) {
                    const row = charRepo.findById(id);
                    if (!row) continue;
                    charRepo.update(id, { xp: ((row as { xp?: number }).xp ?? 0) + each } as Partial<import('../../schema/character.js').Character>);
                    credited.push({ id, name: row.name, xp: each });
                    try {
                        recordAward(db, { worldId: encWorld ?? resolveWorldId(db, { characterIds: [id] }), characterId: id, amount: each, reason: `encounter ${params.encounterId}`, source: 'combat_manage end' });
                    } catch { /* the ledger never blocks the award */ }
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
            let result: Awaited<ReturnType<typeof handleAdvanceTurn>>;
            try {
                result = await handleAdvanceTurn({ encounterId: params.encounterId, confirm: params.confirm, skipTurn: params.skipTurn }, ctx);
            } catch (err) {
                // Play report 7 #6: TURN NOT TAKEN comes back as data (who, and the
                // exact call that passes the turn), so a summary reply keeps it.
                const held = err as Error & { turnNotTaken?: unknown; confirmCall?: string };
                if (held?.turnNotTaken) return { error: true, actionType: 'advance', writes: 'none', message: held.message, turnNotTaken: held.turnNotTaken, confirmCall: held.confirmCall };
                throw err;
            }
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
            if (params.participantId && params.characterId && params.participantId !== params.characterId) {
                return { error: true, actionType: 'death_save', writes: 'none', message: `death_save: participantId '${params.participantId}' and characterId '${params.characterId}' name different participants; pass one. Nothing was written.` };
            }
            const result = await handleRollDeathSave({
                encounterId: params.encounterId,
                participantId: params.participantId ?? params.characterId,
                ...(params.outcome !== undefined ? { outcome: String(params.outcome) } : {})
            }, ctx);
            return extractResultData(result, 'death_save');
        },
        aliases: ['death_saving_throw', 'save_death', 'dying'],
        description: "Play report 5 #5: roll a death save for a participant at 0 HP on the fight's dice (10+ success, 9- failure, nat 1 two failures, nat 20 back to 1 HP and the sheet says so), or post the table's result with outcome. Three successes: stable; three failures: dead — the sheet is killed with a corpse. In prompt mode this clears DEATH SAVE DUE so advance may proceed; a natural 20 that answers it starts the creature's turn there (fresh action, movement and reaction)"
    },

    lair_action: {
        schema: LairActionSchema,
        handler: async (params: z.infer<typeof LairActionSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const { action, ...lairParams } = params;
            const result = await handleExecuteLairAction(lairParams, ctx);
            // Play report 7 #1: each unit's area line at the top level, where output_mode summary keeps it.
            const unitLines = (result as { unitLines?: string[] }).unitLines;
            // Play report 7 (lane G1): what each save took (summary keeps it whole too).
            const saveSources = (result as { saveSources?: unknown[] }).saveSources;
            // Lane K: a legendary resistance a concentration save offered (saveRef and the call; summary keeps it whole).
            const legendaryOffers = (result as { legendaryOffers?: unknown[] }).legendaryOffers;
            return { ...extractResultData(result, 'lair_action'), ...(unitLines?.length ? { unitLines } : {}), ...(saveSources?.length ? { saveSources } : {}), ...(legendaryOffers?.length ? { legendaryOffers } : {}) };
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
                    // Play report 7 #3: band the spawn (a preset carries none: assumed lowest).
                    const bandedSpawn = bandNewTokens(worldId, participants, 'Nothing was spawned.', engine.getState()?.participants.map(p => p.band));
                    if (bandedSpawn.refusal) return { error: true, actionType: 'spawn_quick_enemy', writes: 'none', message: bandedSpawn.refusal };
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
                        // Play report 7 #9: each spawn's roll and place in the order.
                        initiative: joinerInitiative(state, participants.map(p => String(p.id))),
                        // currentTurnIndex indexes turnOrder, NOT participants —
                        // those arrays can diverge when LAIR is in the order.
                        currentTurn: state.turnOrder[state.currentTurnIndex],
                        readyForCombat: true,
                        ...bandReply(bandedSpawn, params.encounterId),
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
            // Play report 7 #3: band the new fight's tokens (refused under requireBand).
            const bandedNew = bandNewTokens(worldId, participants, 'Nothing was spawned.');
            if (bandedNew.refusal) return { error: true, actionType: 'spawn_quick_enemy', writes: 'none', message: bandedNew.refusal };
            // Crypto dice unless the caller seeds the fight.
            const createParams = {
                ...(params.seed ? { seed: params.seed } : {}),
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
                ...bandReply(bandedNew, String(resultData.encounterId)),
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
            const warnings: string[] = [];
            // Play report 7 #4: the caller's id, checked before any write. A
            // token id doubles as the character-row key (HP sync, saves, death),
            // so a row's id is only taken with that row as characterId.
            const refuseId = (message: string) => ({ error: true, actionType: 'add_participant', writes: 'none', message: `${message}. Nothing was written.` });
            // Review of #3: the bands already in the fight pick the ladder an assumed band joins.
            const fightBands = () => getOrLoadEngine(ctx, params.encounterId)?.getState()?.participants.map(p => p.band) ?? [];
            const callerIds = params.id === undefined ? [] : params.creature && (params.count ?? 1) > 1
                ? Array.from({ length: params.count ?? 1 }, (_, i) => `${params.id}-${i + 1}`)
                : [params.id];
            if (params.id !== undefined) {
                if (params.id.toUpperCase() === 'LAIR') return refuseId(`id 'LAIR' is the lair's turn-order slot (initiative 20); pick another id`);
                if (params.characterId && params.id !== params.characterId) {
                    return refuseId(`id '${params.id}' differs from characterId '${params.characterId}': a sheet-backed token's id is its character id. Drop id, or pass id: '${params.characterId}'`);
                }
                if (!params.characterId) {
                    const repo = new CharacterRepository(getDb());
                    for (const cid of callerIds) {
                        const row = repo.findById(cid);
                        if (row) return refuseId(`id '${cid}' is a character row (${row.name}): its sheet would sync to this token. Pass characterId: '${cid}' to bring the sheet into the fight, or pick another id`);
                    }
                }
            }
            if (params.characterId) {
                // FINDINGS #92: the stage gate — first door.
                const gated = stageGateCheck(params.characterId);
                if (gated) {
                    return { error: true, actionType: 'add_participant', message: `STAGE GATE: character ${params.characterId} carries ${gated} — a specimen at this stage cannot act in an encounter. It can be a TARGET (attack it, move it, sample it), but it takes no turns. NOT added.` };
                }
                const db = getDb();
                const row = new CharacterRepository(db).findById(params.characterId);
                if (!row) return { error: true, actionType: 'add_participant', message: `Character ${params.characterId} not found` };
                // Play report 7 #2: the sheet's scores win over any sent.
                const scored = applyTokenScores(params, row);
                if ('problem' in scored) return { error: true, actionType: 'add_participant', writes: 'none', message: `${scored.problem}. Nothing was written.` };
                if (scored.warning) warnings.push(scored.warning);
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
                // Play report 7 #2: scores sent override the statline's, one by one.
                const specStats = (creature.spec.stats ?? {}) as Record<string, number | undefined>;
                const scored = applyTokenScores(params, null, Object.fromEntries(ABILITY_LONG_KEYS.map(l => [l, specStats[l.slice(0, 3)] ?? 10])));
                if ('problem' in scored) return { error: true, actionType: 'add_participant', writes: 'none', message: `${scored.problem}. Nothing was written.` };
                const initiativeBonus = params.initiativeBonus ?? scored.initiativeBonus;
                const overrides = {
                    ...(params.hp !== undefined ? { hp: params.hp } : {}),
                    ...(params.maxHp !== undefined ? { maxHp: params.maxHp } : {}),
                    ...(initiativeBonus !== undefined ? { initiativeBonus } : {}),
                    ...(scored.scores ? { abilityScores: scored.scores } : {}),
                    ...(params.unit ? { unit: params.unit } : {}),
                    ...hydrateExtras(params)
                };
                const made: Array<Record<string, unknown>> = Array.from({ length: count }, (_, i) => ({
                    ...creatureToParticipant(creature.spec, {
                        id: callerIds[i] ?? `token-${randomUUID().slice(0, 8)}`,
                        name: count > 1 ? `${base} ${i + 1}` : base,
                        position: params.position ? { x: params.position.x + i * 2, y: params.position.y } : undefined,
                        isEnemy: params.isEnemy ?? true
                    }),
                    ...overrides
                }));
                const bandedMade = bandNewTokens(resolveWorldId(db, { encounterId: params.encounterId }), made, 'NOT added; nothing was written.', fightBands());
                if (bandedMade.refusal) return { error: true, actionType: 'add_participant', writes: 'none', message: bandedMade.refusal };
                const res = await appendToEncounter(ctx, params.encounterId, made, { duplicateHint: 'pick another id', initiativeContext: params.context });
                if (!res.ok) return { error: true, actionType: 'add_participant', message: res.message, ...(res.writes ? { writes: res.writes } : {}) };
                const view = (p: Record<string, unknown>) => ({ id: p.id, name: p.name, hp: p.hp, ac: p.ac, isEnemy: p.isEnemy, ...(scored.scores ? { abilityScores: p.abilityScores } : {}) });
                // Play report 7 #9: each joiner's roll and place in the order.
                const joined = res.state ? joinerInitiative(res.state, made.map(p => String(p.id)), res.initiativeDeclared) : [];
                return {
                    success: true, actionType: 'add_participant', encounterId: params.encounterId,
                    creature: creature.name, source: creature.source,
                    participant: view(made[0]), participants: made.map(view),
                    ...(joined.length ? { initiative: joined } : {}),
                    ...bandReply(bandedMade, params.encounterId, res.initiativeWarnings ?? []),
                    message: `${made.map(p => p.name).join(', ')} join${count === 1 ? 's' : ''} the encounter (${made[0].isEnemy ? 'HOSTILE' : 'allied'}, ${creature.source === 'world' ? 'bestiary' : 'preset'} ${creature.name}) — ${joined.length ? joined.map(r => `${count > 1 ? `${r.name}: ` : ''}${joinerLine(r, res.state!.round)}`).join('; ') : 'initiative rolled'}, state persisted.`
                };
            } else {
                if (!params.name || params.hp === undefined || params.maxHp === undefined) {
                    return { error: true, actionType: 'add_participant', message: 'Ad-hoc participant needs name, hp, maxHp (or pass characterId)' };
                }
                // Play report 7 #2: stats / abilityScores, missing ones 10, DEX initiative.
                const scored = applyTokenScores(params, null);
                if ('problem' in scored) return { error: true, actionType: 'add_participant', writes: 'none', message: `${scored.problem}. Nothing was written.` };
                participant = {
                    id: params.id ?? `token-${randomUUID().slice(0, 8)}`, name: params.name,
                    hp: params.hp, maxHp: params.maxHp,
                    initiativeBonus: params.initiativeBonus ?? scored.initiativeBonus ?? 0,
                    ...(scored.scores ? { abilityScores: scored.scores } : {}),
                    isEnemy: params.isEnemy ?? false, conditions: [],
                    position: params.position ?? { x: 0, y: 0 },
                    resistances: [], vulnerabilities: [], immunities: [],
                    ...hydrateExtras(params),
                    ac: params.ac ?? 10,
                    unit: params.unit
                };
            }
            const bandedOne = bandNewTokens(resolveWorldId(getDb(), { encounterId: params.encounterId, ...(params.characterId ? { characterIds: [params.characterId] } : {}) }), [participant], 'NOT added; nothing was written.', fightBands());
            if (bandedOne.refusal) return { error: true, actionType: 'add_participant', writes: 'none', message: bandedOne.refusal };
            const res = await appendToEncounter(ctx, params.encounterId, [participant], {
                duplicateHint: params.characterId ? 'a character joins a fight once (remove_participant first to bring it back)' : 'pick another id',
                initiativeContext: params.context
            });
            if (!res.ok) return { error: true, actionType: 'add_participant', message: res.message, ...(res.writes ? { writes: res.writes } : {}) };
            // Play report 7 #9: the joiner's roll and place in the order.
            const joined = res.state ? joinerInitiative(res.state, [String(participant.id)], res.initiativeDeclared) : [];
            return {
                success: true, actionType: 'add_participant', encounterId: params.encounterId,
                ...(joined.length ? { initiative: joined } : {}),
                participant: { id: participant.id, name: participant.name, hp: participant.hp, ac: participant.ac, isEnemy: participant.isEnemy, ...(participant.abilityScores ? { abilityScores: participant.abilityScores } : {}), ...(participant.band ? { band: participant.band } : {}), ...(participant.bandAssumed ? { bandAssumed: true } : {}) },
                ...bandReply(bandedOne, params.encounterId, [...warnings, ...(res.initiativeWarnings ?? [])]),
                message: `${participant.name} joins the encounter (${participant.isEnemy ? 'HOSTILE' : 'allied'}) — ${joined.length ? joinerLine(joined[0], res.state!.round) : 'initiative rolled'}, state persisted.`
            };
        },
        aliases: ['reinforce', 'join_combat'],
        unknownKeyHints: ADD_PARTICIPANT_KEY_HINTS,
        description: 'Add a character or ad-hoc token to a RUNNING encounter — reinforcements, late arrivals, the PC joining a quick-spawned fight'
    },
    board: {
        schema: BoardSchema,
        handler: async (params: z.infer<typeof BoardSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'board', message: `${message} Nothing was written.`, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB).`);
            const attacker = state.participants.find(p => p.id === params.attackerId);
            const target = state.participants.find(p => p.id === params.targetId);
            if (!attacker) return refuse(`attackerId ${params.attackerId} is not in this encounter.`);
            if (!target) return refuse(`targetId ${params.targetId} is not in this encounter.`);
            if (attacker.id === target.id) return refuse(`A vessel cannot board itself.`);
            const notVessel = [attacker, target].filter(p => !p.vessel).map(p => p.name);
            if (notVessel.length) return refuse(`Boarding is between vessels; not a vessel: ${notVessel.join(', ')} (lay ships down with character_manage create_vessel and add them with add_participant).`);
            if (target.hp <= 0) return refuse(`${target.name} is destroyed; there is nothing to board.`);
            const db = getDb();
            const repo = new EncounterRepository(db);
            // The target's deck plan: the rooms given, else the spatial rooms of
            // its network (room_nodes.network_id = vessel.networkId ?? the character id).
            let rooms: string[] = params.rooms ?? [];
            let roomsSource: 'given' | 'spatial' | 'none' = params.rooms ? 'given' : 'none';
            if (!params.rooms) {
                try {
                    const networkId = target.vessel?.networkId ?? target.id;
                    const rows = db.prepare('SELECT name FROM room_nodes WHERE network_id = ? ORDER BY created_at, rowid').all(networkId) as Array<{ name: string }>;
                    if (rows.length) { rooms = rows.map(r => r.name); roomsSource = 'spatial'; }
                } catch { /* no network_id column */ }
            }
            const label = params.name ?? `${attacker.name} boards ${target.name}`;
            // The boarding encounter starts empty (the GM adds boarders and
            // defenders), so it is laid down here rather than through create,
            // which needs a participant. Crypto dice unless seeded, like create.
            const childEngine = params.seed ? new CombatEngine(params.seed) : CombatEngine.crypto();
            const childState = childEngine.startEncounter([]);
            const childId = `encounter-${params.seed ?? 'boarding'}-${Date.now()}-${randomUUID().slice(0, 8)}`;
            const now = new Date().toISOString();
            repo.create({ id: childId, tokens: [], round: childState.round, activeTokenId: undefined, status: 'active', createdAt: now, updatedAt: now });
            repo.saveState(childId, childEngine.getState()!);
            getCombatManager().create(`${ctx.sessionId}:${childId}`, childEngine);
            const child = { dice: childEngine.describeDice() };
            const boardingFrom = { encounterId: params.encounterId, attackerId: attacker.id, attackerName: attacker.name, targetId: target.id, targetName: target.name };
            repo.setParent(childId, params.encounterId);
            repo.mergeNotes(childId, { boarding: label, boardingFrom, rooms, roomsSource });
            try {
                const parentWorld = (db.prepare('SELECT world_id FROM encounters WHERE id = ?').get(params.encounterId) as { world_id?: string | null } | undefined)?.world_id;
                if (parentWorld) db.prepare('UPDATE encounters SET world_id = ? WHERE id = ?').run(parentWorld, childId);
            } catch { /* no world column */ }
            const parentNotes = repo.getNotes(params.encounterId);
            const entry = { childEncounterId: childId, name: label, attackerId: attacker.id, targetId: target.id, rooms, status: 'active', createdAt: new Date().toISOString() };
            repo.mergeNotes(params.encounterId, { boardings: [...((parentNotes.boardings as unknown[] | undefined) ?? []), entry] });
            logConditionChange(params.encounterId, state, 'board', target.id, `${label} → boarding encounter ${childId}${rooms.length ? ` (${rooms.join(' → ')})` : ''}`);
            return {
                success: true, actionType: 'board', encounterId: params.encounterId, parentEncounterId: params.encounterId,
                childEncounterId: childId, boardingEncounterId: childId, name: label, boardingFrom, rooms, roomsSource,
                dice: child.dice,
                message: `${label}: boarding encounter ${childId} opened (linked to ${params.encounterId}). ${rooms.length ? `Rooms: ${rooms.join(' → ')}.` : 'No deck plan on record: pass rooms, or build one with spatial_manage.'} Add boarders and defenders with combat_manage add_participant {encounterId: '${childId}', characterId | creature}; the void fight continues in ${params.encounterId}. combat_manage end {encounterId: '${childId}', winner?, summary?} reports the result back to it.`
            };
        },
        aliases: ['boarding', 'board_vessel', 'boarding_action'],
        description: 'Request 5: open a linked boarding encounter between two vessel tokens (encounters.parent_id); the void fight goes on, end on the boarding reports back'
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
            if (state.turnOrder.every((id) => id === params.participantId)) return { error: true, actionType: 'remove_participant', message: 'Refused: removal would empty the encounter — use end instead', writes: 'none' };
            const wasUp = currentActorId === params.participantId;
            const removedIndex = state.currentTurnIndex;
            const roundBefore = state.round;
            // Read character_manage HP edits before a death save or a turn start writes HP back.
            if (wasUp) syncParticipantHpFromDb(state);
            state.participants = state.participants.filter((p) => p.id !== params.participantId);
            state.turnOrder = state.turnOrder.filter((id) => id !== params.participantId);
            // Play report 7 #6: the actor that was up left, so the next slot comes
            // up exactly as an advance brings it up (a surprised slot passes, a
            // dying slot rolls its death save or owes DEATH SAVE DUE, a controlled
            // mount's slot passes; past the last slot the next round opens) and
            // its turn starts (fresh action, movement and reaction).
            const killed: KilledRecord[] = [];
            let upNow: CombatParticipant | null | undefined;
            if (wasUp) {
                const worldMode = readWorldEnvironment(getDb(), resolveWorldId(getDb(), { encounterId: params.encounterId }))?.deathSaveMode as DeathSaveMode | undefined;
                // Play report 7 (lane H): a surprised slot passed here rolls its save_ends saves through the provider.
                upNow = engine.startNextAfterRemoval(removedIndex, { deathSaveMode: worldMode, encounterId: params.encounterId, saverSides: engineSaverSides(() => getDb()) });
                for (const ev of engine.deathSaveEvents) {
                    if (ev.regainedHp) { clearDyingOnRow(ev.participantId); clearNonlethalOnRow(ev.participantId); }
                    if (!ev.isDead) continue;
                    const k = await settleDeath({ id: ev.participantId, name: ev.name }, `third failed death save (round ${ev.round})`, params.encounterId);
                    if (k) killed.push(k);
                }
            } else {
                state.currentTurnIndex = state.turnOrder.indexOf(currentActorId);
            }
            // Play report 7 follow-up (lane O): the turn that came up ticked
            // (pressure, ongoing damage): what it owes, as after an advance.
            const ticks: Awaited<ReturnType<typeof settleTurnDamage>> = wasUp ? await settleTurnDamage(engine, params.encounterId) : { killed: [], lines: [] };
            killed.push(...ticks.killed);
            const startNotes = wasUp ? [...engine.turnStartNotes] : [];
            const deathSaves = wasUp ? [...engine.deathSaveEvents] : [];
            const endOfTurnSaves = wasUp ? [...engine.endOfTurnSaves] : [];
            const legendaryOffers = wasUp ? [...engine.legendaryOffers] : [];
            const due = upNow?.deathSaveDue && isDying(upNow)
                ? { participantId: upNow.id, name: upNow.name, ...deathCounters(upNow), call: deathSaveCall(params.encounterId, upNow.id) }
                : undefined;
            const db = getDb();
            if (wasUp) saveEncounterState(new EncounterRepository(db), params.encounterId, state);
            else new EncounterRepository(db).saveState(params.encounterId, state);
            const upId = state.turnOrder[state.currentTurnIndex];
            const upName = upNow?.name ?? upId;
            return {
                success: true, actionType: 'remove_participant', encounterId: params.encounterId,
                removed: { id: gone.id, name: gone.name },
                remaining: state.participants.length,
                currentTurn: upId,
                round: state.round,
                ...(startNotes.length ? { turnStartNotes: startNotes } : {}),
                ...(endOfTurnSaves.length ? { endOfTurnSaves } : {}),
                ...(legendaryOffers.length ? { legendaryOffers } : {}),
                ...(ticks.turnDamage ? { turnDamage: ticks.turnDamage } : {}),
                ...(ticks.breakTests ? { breakTests: ticks.breakTests } : {}),
                ...(ticks.unitLines ? { unitLines: ticks.unitLines } : {}),
                ...(deathSaves.length ? { deathSaves } : {}),
                ...(killed.length ? { killed } : {}),
                ...(due ? { deathSaveDue: due } : {}),
                message: `${gone.name} is out of the fight — removed from initiative. ${state.participants.length} remain.${wasUp ? ` ${upName} is up${state.round !== roundBefore ? ` (round ${state.round})` : ''}.` : ''}${startNotes.length ? `\n${startNotes.join('\n')}` : ''}${ticks.lines.length ? `\n${ticks.lines.join('\n')}` : ''}${killed.length ? `\n${killedLines(killed).join('\n')}` : ''}`
            };
        },
        aliases: ['flee', 'banish', 'despawn'],
        description: '#67-D: Remove a participant from a running encounter (fled/banished/despawned) — turn pointer re-anchored, state persisted. Removing the actor that is up brings the next slot up as an advance does (a surprised slot passes, a dying one rolls its death save or owes DEATH SAVE DUE, a controlled mount\'s slot passes; past the last slot, the next round) and starts its turn (fresh action, movement and reaction). The dead don\'t use this; they drop at 0 HP'
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
            // death-save track fresh; it never adds failures. Play report 5 #5:
            // a correction above 0 wakes the dying (the dying Unconscious goes,
            // on the token and the sheet); one down to 0 on a tracked token
            // puts it unconscious and prone like a real drop.
            let woke: string[] = [];
            if ((before <= 0) !== (after <= 0)) {
                p.deathSaveSuccesses = 0;
                p.deathSaveFailures = 0;
                p.isStabilized = false;
                if (after > 0) {
                    wakeFromDying(p);
                    woke = clearDyingOnRow(p.id);
                } else if (tracksDeathSaves(p)) {
                    applyDyingConditions(p);
                    markRowDying(p.id);
                }
            }
            if (params.revive && after > 0) p.isDead = false;
            // Lane W: a unit's correction moves through its models: a loss
            // spreads most wounded first, a gain heals the most wounded first.
            if (p.unit) setUnitHp(p, after);
            else p.hp = after;
            // Play report 5: a correction that lifts a knocked-out token above 0
            // wakes it — the knockout's Unconscious leaves the token and the sheet.
            const wokeFrom = before <= 0 && after > 0 ? engine.wakeFromNonlethal(p.id) : [];
            const wokeKo = wokeFrom.length ? { conditionsRemoved: wokeFrom, sheetUpdated: clearNonlethalOnRow(p.id) } : undefined;
            // One woke for the reply: the knockout's Unconscious (token + sheet) and the dying conditions cleared on the row.
            const wokeAll = (wokeKo || woke.length) ? { conditionsRemoved: [...(wokeKo?.conditionsRemoved ?? []), ...woke], sheetUpdated: Boolean(wokeKo?.sheetUpdated) || woke.length > 0 } : undefined;

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
                ...(after <= 0 && dyingLabel(p) ? { dying: dyingLabel(p) } : {}),
                reason: params.reason,
                ...(p.unit ? { wounds: woundLine(p) } : {}),
                ...(breakTest ? { breakTest } : {}),
                ...(wokeAll ? { woke: wokeAll } : {}),
                message: `${p.name}: HP ${before} → ${after}/${p.maxHp} (GM correction: ${params.reason})${p.unit && after > 0 ? ` · ${woundLine(p)}` : ''}${after <= 0 && dyingLabel(p) ? ` — ${dyingLabel(p)}` : ''}${wokeAll ? ` — comes round (${wokeAll.conditionsRemoved.join(', ')} cleared)` : ''}${breakTest ? `\n${breakTest.line}` : ''}`
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
            // Play report 7 follow-up (lane O): ongoing damage follows its source's
            // shape. Single unless the GM says it came from an area; an area on a
            // unit records the models inside (every live one of a packed unit; a
            // spaced unit needs the count, refused before anything is written).
            const wantsArea = params.area ?? params.modelsInArea !== undefined;
            const ticks = (normalized.ongoingEffects ?? []).some(e => e.type === 'damage');
            const shapeNotes: string[] = [];
            if (wantsArea && ticks && p.unit) {
                const live = liveModels(p);
                const given = modelsInAreaFor(params.modelsInArea as ModelsInArea | undefined, p.id);
                if (given === undefined && !p.unit.packed) {
                    const needs = [{ targetId: p.id, name: p.name, liveModels: live }];
                    return { ...refuse(areaCountMessage(needs)), modelsInAreaNeeded: needs };
                }
                const models = Math.min(live, given ?? live);
                if (models <= 0) return refuse(`modelsInArea: no model of ${p.name} is inside (${given ?? 0} given, ${live} standing), so the ongoing damage would never tick`);
                stampOngoingShape(normalized, { kind: 'area', models });
            } else if (wantsArea && ticks) {
                shapeNotes.push(`${p.name} is not a unit: one creature, so the area changes nothing (it ticks on ${p.name})`);
            } else if (wantsArea) {
                shapeNotes.push('area / modelsInArea shape ongoing damage only; this condition has none');
            }
            // Play report 2, item 2: fromGrapple names the holder; the source
            // becomes the canonical 'grapple: <holder id>' that execute and
            // break read. A participant by id, else by name (one match only),
            // else a character row.
            let heldBy: { id: string; name: string } | undefined;
            if (params.fromGrapple) {
                const want = params.fromGrapple.trim();
                const byId = state.participants.find(x => x.id === want);
                const byName = byId ? [] : state.participants.filter(x => x.name.trim().toLowerCase() === want.toLowerCase());
                if (byName.length > 1) return refuse(`fromGrapple '${want}' is ambiguous: ${byName.map(x => `${x.name} (${x.id})`).join(', ')} — use the id`);
                const row = byId || byName.length ? null : new CharacterRepository(getDb()).findById(want);
                const holder = byId ?? byName[0] ?? (row ? { id: row.id, name: row.name } : undefined);
                if (!holder) return refuse(`fromGrapple: no participant or character '${want}'`);
                const given = typeof params.condition === 'object' && params.condition ? (params.condition.sourceId ?? params.condition.source) : undefined;
                // A blank source is no source; only one that names someone else is refused.
                if (given !== undefined && String(given).trim() && !sourceNamesHolder(given, holder)) {
                    return refuse(`condition.source '${given}' does not name the holder ${holder.name} (${holder.id}); drop it, or write the holder's id or name`);
                }
                normalized.sourceId = grappleSource(holder.id);
                heldBy = { id: holder.id, name: holder.name };
            }
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
            const held = heldBy ? ` (held by ${heldBy.name})` : '';
            logConditionChange(params.encounterId, state, 'add_condition', p.id, `${p.name} gains ${applied.type}${held}${params.reason ? ` — ${params.reason}` : ''}`, params.reason);
            // Lane O: what the condition ticks, a line each.
            const ongoing = (applied.ongoingEffects ?? []).filter(e => e.type === 'damage').map(ongoingSummary);
            return {
                success: true, actionType: 'add_condition', encounterId: params.encounterId,
                participantId: p.id, condition: applied, replaced, mirroredToCharacter: mirrored,
                ...(heldBy ? { heldBy } : {}),
                ...(ongoing.length ? { ongoing } : {}),
                ...(shapeNotes.length ? { notes: shapeNotes } : {}),
                conditions: p.conditions.map(c => c.type),
                message: `${p.name}: +${applied.type}${held}${replaced ? ` (replaced ${replaced})` : ''}${ongoing.length ? ` — ongoing: ${ongoing.join('; ')}` : ''}${shapeNotes.length ? ` (${shapeNotes.join('; ')})` : ''}`
            };
        },
        aliases: ['apply_condition', 'inflict', 'condition'],
        description: "Add a condition to a live encounter participant (condition: name or {name, duration, durationType, save..., level}; or top-level name); optional mirror to the character sheet. fromGrapple: <holder id or name> writes the source 'grapple: <holder id>' that grapple execute and break read"
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
            // Merge, never replace: holds, ac, hp and any later part field
            // survive a state change. Leaving 'latched' releases the hold.
            // Play report 6 #3: the merge rules live in setPartOn, shared with
            // the scheduled set_part op; pure, so the refusals below cost nothing.
            const write = setPartOn(p.parts ?? [], {
                part: params.part,
                state: params.state,
                ...(params.kind !== undefined ? { kind: params.kind } : {}),
                ...(params.latchedTo !== undefined ? { latchedTo: params.latchedTo } : {}),
                ...(params.note !== undefined ? { note: params.note } : {}),
                ...(params.holds !== undefined ? { holds: params.holds } : {}),
                ...(params.ac !== undefined ? { ac: params.ac } : {}),
                ...(params.hp !== undefined ? { hp: params.hp } : {}),
                ...(params.maxHp !== undefined ? { maxHp: params.maxHp } : {}),
                ...(params.breakAt !== undefined ? { breakAt: params.breakAt } : {})
            });
            const prev = write.prev;
            if (params.state === 'latched') {
                // A part already latched keeps its hold when only the note or kind changes.
                if (!params.latchedTo && !(prev?.state === 'latched' && prev.latchedTo)) return refuse('latched needs latchedTo {participantId, part?}');
                if (params.latchedTo && !state.participants.some(x => x.id === params.latchedTo!.participantId)) return refuse(`latchedTo ${params.latchedTo.participantId} is not in this encounter`);
            }
            const { parts, next } = write;
            p.parts = parts;
            engine.refreshVessel(p);
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
            const { parts: after, removed } = removePartFrom(before, params.part);
            if (!removed) return refuse(`${p.name} has no part '${params.part}' (parts: ${before.map(x => x.name).join(', ') || 'none'})`);
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
            // Review of play report 7 #3: the owner offered set_unit {band}; set_band is the road.
            if (!p.unit) return refuse(`${p.name} is not a unit token (create it with unit: {models, hpPerModel, ...}); a token's band is changed with combat_manage set_band {encounterId, participantId, band}`);
            // Reinforce: new models arrive at full HP each; a smaller unit
            // (or thinner models) clamps HP to the new maximum. Lane W: a new
            // hpPerModel resets the wound list; so does a cut that leaves it
            // out of step with the pool; reinforcing keeps it.
            const strength = (t: { hp: number; maxHp: number; unit?: CombatParticipant['unit'] }) => {
                const u = t.unit!;
                const modelsBefore = u.models, hpPerBefore = u.hpPerModel, hpBefore = t.hp, maxBefore = t.maxHp;
                const models = params.models ?? modelsBefore;
                const hpPerModel = params.hpPerModel ?? hpPerBefore;
                const added = Math.max(0, models - modelsBefore);
                if (hpPerModel !== hpPerBefore) delete (u as { wounded?: number[] }).wounded;
                u.models = models;
                u.hpPerModel = hpPerModel;
                t.maxHp = models * hpPerModel;
                t.hp = Math.max(0, Math.min(t.maxHp, hpBefore + added * hpPerModel));
                settleWounds(t);
                return { modelsBefore, models, added, lost: Math.max(0, modelsBefore - models), hpPerModel, hpBefore, hp: t.hp, maxHpBefore: maxBefore, maxHp: t.maxHp, liveModels: liveModels(t) };
            };
            const reinforcing = params.models !== undefined || params.hpPerModel !== undefined;
            // Lane W: a wound list is checked on a copy first (after any new
            // strength), so a refusal writes nothing.
            if (params.wounded) {
                const dry = { hp: p.hp, maxHp: p.maxHp, unit: JSON.parse(JSON.stringify(p.unit)) as NonNullable<CombatParticipant['unit']> };
                if (reinforcing) strength(dry);
                const check = setWounded(dry, params.wounded);
                if (!check.ok) return refuse(`${p.name}: ${check.message}. Nothing was written`);
            }
            for (const k of ['suppressed', 'inMelee', 'brokenFormation', 'packed', 'routed', 'morale', 'breakAt'] as const) {
                if (params[k] !== undefined) (p.unit as Record<string, unknown>)[k] = params[k];
            }
            if (params.mobRule === null) delete (p.unit as Record<string, unknown>).mobRule;
            else if (params.mobRule !== undefined) p.unit.mobRule = params.mobRule;
            // Play report 7 #1: the drilled save bonus each model adds against an area.
            if (params.saves === null) delete (p.unit as Record<string, unknown>).saves;
            else if (params.saves !== undefined) p.unit.saves = params.saves;
            let reinforced: Record<string, unknown> | undefined;
            if (reinforcing) reinforced = strength(p);
            // Lane W: the wounded models, the live count kept; HP moves to match.
            let woundsSet: { hpBefore: number; hp: number } | undefined;
            if (params.wounded !== undefined) {
                const hpBefore = p.hp;
                const set = setWounded(p, params.wounded);
                if (set.ok) woundsSet = { hpBefore, hp: p.hp };
            }
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            const tier = volleyTier(p);
            const woundsNote = woundsSet && woundsSet.hp !== woundsSet.hpBefore ? ` · wounds set, HP ${woundsSet.hpBefore} → ${woundsSet.hp}/${p.maxHp}` : '';
            logConditionChange(params.encounterId, state, 'set_unit', p.id, `${p.name}: ${describeUnit(p)}${reinforced ? ` (models ${String(reinforced.modelsBefore)} → ${String(reinforced.models)}, HP ${String(reinforced.hpBefore)} → ${String(reinforced.hp)}/${String(reinforced.maxHp)})` : ''}${woundsNote}${params.reason ? ` — ${params.reason}` : ''}`, params.reason);
            // Lane W review: the wounds as the line, not one entry per model (the state view drops the list too).
            const { wounded: _list, ...unitShown } = p.unit;
            return { success: true, actionType: 'set_unit', encounterId: params.encounterId, participantId: p.id, unit: unitShown, volley: tier, wounds: woundLine(p), ...(reinforced ? { reinforced } : {}), ...(woundsSet ? { woundsSet } : {}), message: `${p.name}: ${describeUnit(p)}${reinforced ? ` · models ${String(reinforced.modelsBefore)} → ${String(reinforced.models)}, HP ${String(reinforced.hpBefore)} → ${String(reinforced.hp)}/${String(reinforced.maxHp)}` : ''}${woundsNote}` };
        },
        aliases: ['unit', 'suppress', 'formation'],
        unknownKeyHints: { band: 'set_unit does not set bands: combat_manage set_band {encounterId, participantId, band} changes any token\'s band (and clears an assumed one)' },
        description: 'Set a unit token\'s suppressed / inMelee / brokenFormation / packed flags, routed / morale / breakAt for break tests, mobRule, saves (the drilled save bonus each model adds against an area; null clears) and wounded (each wounded model\'s current HP, the live count kept and HP moved to match; [] heals every wound, null drops the list); reports the volley tier and the wound line (wounds: \'4 alive: 2 unhurt, 1 at 5/9, 1 at 2/9\')'
    },
    set_environment: {
        schema: SetEnvironmentSchema,
        handler: async (params: z.infer<typeof SetEnvironmentSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return { error: true, actionType: 'set_environment', message: `Encounter ${params.encounterId} not found (memory or DB)`, writes: 'none' };
            const before = state.environment?.medium ?? 'air';
            state.environment = params.environment;
            // The medium changes this turn's movement budget for everyone
            // still to move: a token that has not spent movement gets the
            // new budget; one mid-move keeps what it has, capped at it.
            for (const p of state.participants) {
                const budget = engine.moveBudget(p);
                p.movementRemaining = Math.min(p.movementRemaining ?? budget, budget);
            }
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            const glyph = environmentGlyph(state.environment) || 'air';
            logConditionChange(params.encounterId, state, 'set_environment', 'GM', `environment: ${before} → ${state.environment.medium}${params.reason ? ` — ${params.reason}` : ''}`, params.reason);
            return {
                success: true,
                actionType: 'set_environment',
                encounterId: params.encounterId,
                environment: state.environment,
                message: `Environment: ${glyph}${state.environment.medium === 'water' ? ` — swim speed or half speed; ranged ${state.environment.rangedAllowed ? 'allowed' : 'refused'}; melee at disadvantage unless ${(state.environment.meleeDisadvantageUnlessDamageType ?? ['piercing']).join('/')} or tagged '${state.environment.swimTag ?? 'aquatic'}'${state.environment.pressure ? `; pressure ${state.environment.pressure.damagePerRound}/round at ${state.environment.pressure.startsAtFt} ft+` : ''}` : ''}`
            };
        },
        aliases: ['environment', 'medium'],
        description: "Set the encounter's environment {medium: air | water | vacuum, depthFt?, pressure?, rangedAllowed?, meleeDisadvantageUnlessDamageType?, swimTag?, light?: bright | dim | darkness}: water runs the underwater rules (swim speed or half speed, no ranged attacks, melee at disadvantage unless piercing or a swimmer, pressure damage at turn start: per model of a unit, with pressure.save a save each); darkness lets tokens attempt a Hide from foes without darkvision (get shows canHide). Replaces the whole object: pass medium again when setting light in a water fight"
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
            // Play report 7 #5: a ranged shot under a subdue order is settled now (onSubdue), never when the trigger fires.
            // Lane G2 review: a key readied.attack does not take is named, never stored.
            const split = splitReadiedAttack(params.readied?.attack, 'readied.attack');
            const readied = params.readied ? (() => { const { attack: _given, ...rest } = params.readied; return { ...rest, ...(split.attack ? { attack: split.attack } : {}) }; })() : params.readied;
            // Lane G2 review: the call to paste restates the whole attack (its own ranged flag included).
            const subdueRefusal = readied?.attack ? readiedSubdueRefusal(p, readied.attack, `Set it again with the answer: combat_manage set_intent {encounterId: '${params.encounterId}', participantId: '${p.id}', readied: {action, trigger, …, attack: ${readiedAttackPaste(readied.attack)}}}.`) : undefined;
            if (subdueRefusal) return { ...refuse(subdueRefusal), onSubdue: [...ON_SUBDUE] };
            if (params.intent !== undefined) p.intent = params.intent ?? undefined;
            if (readied !== undefined) p.readied = readied ?? undefined;
            // Play report 7 #6: a readied action set now is the token acting this turn.
            if (readied) engine.markActed(p.id);
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            // Lane G2: an explicit ranged flag that disagrees with the named profile wins; say so.
            const rangedOverride = readied ? readiedRangedNote(p, readied.attack) : undefined;
            return withReadiedIgnored({
                success: true, actionType: 'set_intent', encounterId: params.encounterId, participantId: p.id,
                intent: p.intent ?? null, readied: p.readied ?? null,
                ...(rangedOverride ? { rangedOverride } : {}),
                message: `${p.name}${p.intent ? ` ⚑ ${p.intent}` : ''}${p.readied ? ` ⏳ ${p.readied.action} when ${p.readied.trigger}` : ''}${!p.intent && !p.readied ? ': intent cleared' : ''}${rangedOverride ? `. ${rangedOverride.note}` : ''}`
            }, split);
        },
        aliases: ['intent', 'telegraph', 'ready_action'],
        description: 'Telegraph a token\'s intent (clears when its turn ends) and/or a readied action {action, trigger} (stays until triggered)'
    },
    set_cover: {
        schema: SetCoverSchema,
        handler: async (params: z.infer<typeof SetCoverSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'set_cover', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            const level = normalizeCover(params.level) as CoverKind;
            if (level === 'none') {
                p.cover = undefined;
                new EncounterRepository(getDb()).saveState(params.encounterId, state);
                return { success: true, actionType: 'set_cover', encounterId: params.encounterId, participantId: p.id, cover: null, message: `${p.name}: cover cleared` };
            }
            const against = params.against as { ids?: string[]; direction?: StandingCover['direction'] } | undefined;
            if (against?.ids?.length && against.direction) return refuse('against takes ids OR a direction, not both');
            const unknown = (against?.ids ?? []).filter(id => !state.participants.some(x => x.id.toLowerCase() === id.toLowerCase() || x.name.toLowerCase() === id.toLowerCase()));
            const cover: StandingCover = {
                level,
                ...(against?.ids?.length ? { against: against.ids } : {}),
                ...(against?.direction ? { direction: against.direction } : {}),
                ...(params.reason ? { reason: params.reason } : {})
            };
            p.cover = cover;
            p.coverBrokenRound = undefined;
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            logConditionChange(params.encounterId, state, 'set_cover', p.id, `${p.name} takes ${level} cover${cover.reason ? ` (${cover.reason})` : ''}`, params.reason);
            const bonus = coverBonus(level);
            const scope = Array.isArray(cover.against) ? ` against ${cover.against.join(', ')}` : cover.direction ? ` to the ${cover.direction}` : '';
            return {
                success: true, actionType: 'set_cover', encounterId: params.encounterId, participantId: p.id, cover,
                ...(unknown.length ? { warnings: [`not in this encounter: ${unknown.join(', ')} (kept; matched by id or name when they join)`] } : {}),
                message: `🛡 ${p.name}: ${level} cover${scope}${cover.reason ? ` (${cover.reason})` : ''}${level === 'total' ? ' — cannot be targeted directly by those attackers' : ` — +${bonus} AC and +${bonus} on DEX saves against them`}. Stays until clear_cover; an attack with breaksCover drops it for the round${unknown.length ? `. Not in this encounter: ${unknown.join(', ')}` : ''}`
            };
        },
        aliases: ['take_cover', 'cover'],
        description: "Play report 5 #1: standing cover on a token: level half | three-quarters | total, against named attackers or a direction, with a reason that every arithmetic line prints. Stays until clear_cover; attack {breaksCover} drops it for the round"
    },
    clear_cover: {
        schema: ClearCoverSchema,
        handler: async (params: z.infer<typeof ClearCoverSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'clear_cover', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            const had = p.cover ?? null;
            p.cover = undefined;
            p.coverBrokenRound = undefined;
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            if (had) logConditionChange(params.encounterId, state, 'clear_cover', p.id, `${p.name} leaves cover (${had.level}${had.reason ? `, ${had.reason}` : ''})`);
            return { success: true, actionType: 'clear_cover', encounterId: params.encounterId, participantId: p.id, cleared: had, message: had ? `${p.name} leaves ${had.level} cover${had.reason ? ` (${had.reason})` : ''}` : `${p.name} had no standing cover` };
        },
        aliases: ['leave_cover'],
        description: 'Play report 5 #1: remove a token\'s standing cover'
    },
    set_band: {
        schema: SetBandSchema,
        handler: async (params: z.infer<typeof SetBandSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'set_band', message: `${message} Nothing was written.`, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB).`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} is not in this encounter.`);
            // The order the band checks will read for this band (a world may hold several ladders).
            const db = getDb();
            const world = resolveWorldId(db, { encounterId: params.encounterId, characterIds: state.participants.map(x => x.id) });
            const order = bandOrderFor(db, world, [params.band]);
            const band = order.find(b => b.toLowerCase() === params.band.trim().toLowerCase());
            if (!band) {
                // Review of #3: a world with several ladders names each one.
                const ladders = loadRules(db, world, 'band');
                const known = ladders.length > 1 ? `this world's ladders: ${ladders.map(r => `${r.name}: ${r.spec.order.join(' < ')}`).join('; ')}` : `this world's order: ${order.join(' < ')}`;
                return refuse(`'${params.band}' is not a band in ${known}.`);
            }
            const previous = { band: p.band ?? null, ...(p.bandAssumed ? { assumed: true } : {}) };
            p.band = band;
            delete p.bandAssumed;
            new EncounterRepository(db).saveState(params.encounterId, state);
            const was = previous.band ? `${previous.band}${previous.assumed ? ' (assumed)' : ''}` : 'unset';
            logConditionChange(params.encounterId, state, 'set_band', p.id, `${p.name}: band ${was} → ${band}`, params.reason);
            return {
                success: true, actionType: 'set_band', encounterId: params.encounterId, participantId: p.id, band, previous,
                message: `🏷 ${p.name}: band ${was} → ${band}${params.reason ? ` (${params.reason})` : ''}. Applies from the next roll; nothing already rolled changes.`
            };
        },
        aliases: ['band', 'set_token_band'],
        description: "Play report 7 #3: change a token's band mid-fight (an assumed band, a wrong one): from the next roll on, never retroactively; clears the assumed mark; logged. The band must be in the world's order"
    },
    trigger_readied: {
        schema: TriggerReadiedSchema,
        handler: async (params: z.infer<typeof TriggerReadiedSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'trigger_readied', message, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
            // Read the sheets first: HP corrections made between calls, and who
            // tracks death saves (play report 5 #5) — a readied blow on a named
            // character must find the flag hydrated like any attack would.
            syncParticipantHpFromDb(state);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter`);
            if (!p.readied) return refuse(`${p.name} has no readied action`);
            // A readied action is the reactor's reaction (item 11).
            if (!engine.canTakeReactions(p.id)) return refuse(`${p.name} cannot take reactions (down, surprised, or a condition such as stunned or incapacitated)`);
            if (p.reactionUsed) return refuse(`${p.name} has already used its reaction this round`);
            const fired = p.readied;
            // Play report 7 #5: an onSubdue settled at ready time rides along when the GM restates the attack.
            // Review: an attack that carries only onSubdue is the answer for the stored shot, so the
            // stored weapon fires (or holds); it used to replace the stored attack with a bare default.
            // Lane G2: so does an attack carrying only ranged (and onSubdue): it amends the stored shot's lane.
            // Lane G2 review: a key the attack does not take is named (ignoredParams), never read.
            const split = splitReadiedAttack(params.attack, 'attack');
            const callAttack = split.attack;
            const answerOnly = !!callAttack && Object.entries(callAttack).every(([k, v]) => k === 'onSubdue' || k === 'ranged' || v === undefined);
            const spec = callAttack
                ? (answerOnly && fired.attack
                    ? { ...fired.attack, ...(callAttack.onSubdue !== undefined ? { onSubdue: callAttack.onSubdue } : {}), ...(callAttack.ranged !== undefined ? { ranged: callAttack.ranged } : {}) }
                    : { ...callAttack, ...(callAttack.onSubdue === undefined && fired.attack?.onSubdue ? { onSubdue: fired.attack.onSubdue } : {}) })
                : fired.attack;
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
                    const stated = (params.cover as Record<string, unknown> | undefined);
                    attack = resolveReadiedAttack(engine, p, target, spec, { cover: stated?.[targetId] ?? stated?.['*'] });
                } catch (err) {
                    // Play report 7 #5: held under the subdue order (a ranged shot, or a
                    // target already down): no shot, nothing spent, the readied stays.
                    const held = heldReadied(err);
                    if (held) {
                        const awaiting = held.mode === 'hold' && held.awaitingOnSubdue;
                        // Lane G2 review: a shot this call passed (restated, or made ranged by its flag) is
                        // answered by passing it again with onSubdue: set_subdue writes onto the STORED shot
                        // only (which may not be ranged), and refuses when none is stored.
                        const callAnswer = awaiting && callAttack && Object.values(callAttack).some(v => v !== undefined)
                            ? `combat_manage trigger_readied {encounterId: '${params.encounterId}', participantId: '${p.id}', targetId: '${target.id}', attack: ${readiedAttackPaste(callAttack)}}`
                            : undefined;
                        return withReadiedIgnored({
                            success: true, actionType: 'trigger_readied', encounterId: params.encounterId, participantId: p.id, readied: fired,
                            held: true, reaction: false, writes: 'none', reason: held.note,
                            ...(awaiting ? { awaitingOnSubdue: true, answer: callAnswer ? { tool: 'combat_manage', action: 'trigger_readied', encounterId: params.encounterId, participantId: p.id, targetId: target.id, attack: { ...callAttack, onSubdue: "'hold' | 'fire'" } } : onSubdueAnswer(params.encounterId, p.id) } : {}),
                            // Play report 7 (lane G2): the held shot as one line, kept whole by output_mode 'summary'.
                            reactionLines: [held.mode === 'downed' ? notStruckDownLine(p.name, { name: target.name }) : heldFireLine(p.name, awaiting ? (callAnswer ?? onSubdueAnswerText(params.encounterId, p.id)) : undefined)],
                            message: `${p.name}: ${fired.action} (${fired.trigger}) — ${held.note}. The reaction is not spent and the readied attack stays armed.${awaiting ? ` Answer: ${callAnswer && callAttack ? `pass attack: ${readiedAttackPaste(callAttack)} on this call (this call's attack again, with the answer): ${callAnswer}.` : fired.attack ? `${onSubdueAnswerText(params.encounterId, p.id)} (written onto the stored shot), then trigger it again; or pass attack: {onSubdue: 'hold' | 'fire'} on this call (the stored shot keeps its weapon).` : `pass attack: {…, onSubdue: 'hold' | 'fire'} on this call.`}` : ''} Nothing was written.`
                        }, split);
                    }
                    return refuse(err instanceof Error ? err.message : String(err));
                }
            } else {
                engine.commitAction(p.id, 'reaction');
            }
            p.readied = undefined;
            // Play report 5 #5: a readied blow that drops or kills a tracked target follows through to its sheet.
            const struck = attack ? state.participants.find(x => x.id === attack!.target?.id) : undefined;
            const settled = attack && struck ? await settleAttackDying(attack, struck, p.name, params.encounterId) : { lines: [] as string[] };
            // Play report 7 #5: a knockout under the subdue order reaches the sheet.
            if (attack && struck) settled.lines.push(...settleKnockout(attack, struck, p));
            saveEncounterState(new EncounterRepository(getDb()), params.encounterId, state);
            logConditionChange(params.encounterId, state, 'trigger_readied', p.id, `${p.name}'s readied action fires: ${fired.action} (${fired.trigger})${attack ? ` — ${attack.message}` : ''}${attack?.subdue ? ` (${attack.subdue.note})` : ''}${params.note ? ` — ${params.note}` : ''}`, params.note);
            const attackData = attack ? { targetId: attack.target?.id, ...reactionAttackData(attack) } : undefined;
            // Lane G2 review: the flag that overrode its profile, on the reply and on the line (summary keeps the line).
            const rangedOverride = attack && spec ? readiedRangedFor(p, spec).override : undefined;
            // Play report 7 (lane G2): the reaction as one line, kept whole by output_mode 'summary'.
            const reactionLine = attack
                ? rolledReactionLine('readied', p.name, { name: struck?.name ?? attack.target?.name ?? String(attack.target?.id ?? '?'), riding: struck?.mountedOn ? state.participants.find(x => x.id === struck.mountedOn)?.name : undefined }, reactionAttackData(attack), { killed: !!settled.killed, override: readiedOverrideTail(rangedOverride) })
                : readiedFiredNoAttackLine(p.name, fired.action);
            return withReadiedIgnored({
                success: true, actionType: 'trigger_readied', encounterId: params.encounterId, participantId: p.id, fired, reaction: true,
                ...(attackData ? { attack: attackData } : {}),
                ...(rangedOverride ? { rangedOverride } : {}),
                reactionLines: [reactionLine],
                ...(attack?.dying ? { dying: attack.dying } : {}),
                ...(settled.killed ? { killed: settled.killed } : {}),
                message: attack
                    ? `${p.name}: ${fired.action} fires (${fired.trigger}); reaction spent.\n${attack.detailedBreakdown}${settled.lines.length ? `\n${settled.lines.join('\n')}` : ''}`
                    : `${p.name}: ${fired.action} fires (${fired.trigger}); reaction spent. Resolve its effect now (an attack: pass attack {…} and targetId here next time to roll it in one call).`
            }, split);
        },
        aliases: ['fire_readied', 'readied_fires'],
        description: 'A readied action\'s trigger happened: spends the reaction, rolls its stored attack (targetId) in the same call, clears and logs it'
    },
    set_subdue: {
        schema: SetSubdueSchema,
        handler: async (params: z.infer<typeof SetSubdueSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'set_subdue', message: `${message} Nothing was written.`, writes: 'none' });
            if (params.subdue === undefined && params.onSubdue === undefined) return refuse("set_subdue needs subdue (true: take them alive; false: lift the order) and/or onSubdue ('hold' | 'fire') for the token's readied shot.");
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB).`);
            const p = state.participants.find(x => x.id === params.participantId);
            if (!p) return refuse(`Participant ${params.participantId} not in this encounter.`);
            // Review: an answer with no shot to land on and no order to change wrote
            // nothing but a log row under a success banner; refuse it instead.
            if (params.subdue === undefined && params.onSubdue && !p.readied?.attack) {
                return refuse(`${p.name} holds no readied attack, so onSubdue has no shot to answer (it is answered per readied shot: combat_action ready {…, attack: {…, onSubdue}}, or trigger_readied {attack: {…, onSubdue}} for a readied action stored without an attack).`);
            }
            const warnings: string[] = [];
            if (params.subdue !== undefined) p.subdue = params.subdue ? true : undefined;
            // The answer rides on the readied attack, where ready would have put it.
            if (params.onSubdue) {
                if (p.readied?.attack) p.readied = { ...p.readied, attack: { ...p.readied.attack, onSubdue: params.onSubdue } };
                else warnings.push(`${p.name} holds no readied attack: onSubdue was not stored (it is answered per readied shot: combat_action ready {…, attack: {…, onSubdue}})`);
            }
            // Owner's answer: an order on a token already holding a ranged shot is
            // flagged and asks for onSubdue; until it is answered the shot holds.
            const pending = readiedNeedsOnSubdue(p);
            if (pending) warnings.push(`${p.name} already holds a readied ranged shot (${pending.profile}), and a shot can't be non-lethal. Until you answer, the trigger holds fire (holding can't kill anyone by accident). Answer: ${onSubdueAnswerText(params.encounterId, p.id)} — 'hold' keeps the order, 'fire' shoots to kill (subdue order overridden). For a player's token, the player chooses`);
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            const onSubdue = p.readied?.attack?.onSubdue;
            const summary = p.subdue
                ? `${p.name}: subdue order (take them alive) — opportunity attacks and readied melee swings knock out${onSubdue ? `; readied shot onSubdue '${onSubdue}'` : ''}`
                : `${p.name}: no subdue order — its swings are lethal${onSubdue ? `; readied shot onSubdue '${onSubdue}'` : ''}`;
            logConditionChange(params.encounterId, state, 'set_subdue', p.id, summary, params.reason);
            return {
                success: true, actionType: 'set_subdue', encounterId: params.encounterId, participantId: p.id,
                subdue: !!p.subdue,
                ...(onSubdue ? { onSubdue } : {}),
                ...(pending ? { readiedNeedsOnSubdue: { participantId: p.id, readied: p.readied, profile: pending.profile, answer: onSubdueAnswer(params.encounterId, p.id) } } : {}),
                ...(warnings.length ? { warnings } : {}),
                message: `${p.subdue ? '🤲 ' : ''}${summary}${params.reason ? ` (${params.reason})` : ''}${warnings.length ? `\n⚠ ${warnings.join('\n⚠ ')}` : ''}`
            };
        },
        aliases: ['subdue', 'take_alive'],
        description: "Play report 7 #5: a standing order 'take them alive' on a token (subdue: true / false): its opportunity attacks and readied melee swings knock out instead of killing; a unit is never subdued; a target already down is not struck. onSubdue 'hold' | 'fire' answers a readied ranged shot (a shot can't be non-lethal). Logged"
    },
    mount: {
        schema: MountSchema,
        handler: async (params: z.infer<typeof MountSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            return handleMount(params, ctx);
        },
        aliases: ['ride', 'mount_up'],
        description: "Play report 7 #10: put a rider on a mount at least one size larger within 5 ft. controlled (default): the mount moves on the rider's turn (move {actorId: rider} spends the mount's movement; the rider moves free), its own slot passes, it may only Dash, Disengage or Dodge. controlled: false: an independent mount keeps its turn and carries the rider. Mid-fight it costs half the rider's speed on its own turn; free: true sets the scene"
    },
    dismount: {
        schema: DismountSchema,
        handler: async (params: z.infer<typeof DismountSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            return handleDismount(params, ctx);
        },
        aliases: ['get_off', 'unmount'],
        description: "Play report 7 #10: the rider steps down to a free square within 5 ft of the mount (position, else the nearest) for half its speed on its own turn; free: true for a GM correction"
    },
    set_surprised: {
        schema: SetSurprisedSchema,
        handler: async (params: z.infer<typeof SetSurprisedSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            const refuse = (message: string) => ({ error: true, actionType: 'set_surprised', message: `${message} Nothing was written.`, writes: 'none' });
            const engine = getOrLoadEngine(ctx, params.encounterId);
            const state = engine?.getState();
            if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB).`);
            const targets: CombatParticipant[] = [];
            for (const id of params.participantIds) {
                const p = state.participants.find(x => x.id === id);
                if (!p) return refuse(`Participant ${id} not in this encounter.`);
                targets.push(p);
            }
            // Surprise is a round-1 state set before the creature's first turn;
            // clearing a flag set by mistake is allowed at any time.
            if (params.surprised) {
                if (state.round !== 1) return refuse(`Round ${state.round}: surprise is a round-1 state, set before the creature's first turn (create {surprised: [ids]} or set_surprised before it acts).`);
                for (const p of targets) {
                    if (state.turnOrder.indexOf(p.id) <= state.currentTurnIndex) return refuse(`${p.name}'s turn has started: surprise is set before it.`);
                }
            }
            for (const p of targets) p.surprised = params.surprised;
            new EncounterRepository(getDb()).saveState(params.encounterId, state);
            const names = targets.map(p => p.name).join(', ');
            const summary = params.surprised
                ? `${names} surprised: the round-1 turn passes, no reactions or actions until then${params.reason ? ` — ${params.reason}` : ''}`
                : `${names} no longer surprised${params.reason ? ` — ${params.reason}` : ''}`;
            for (const p of targets) logConditionChange(params.encounterId, state, 'set_surprised', p.id, summary, params.reason);
            return {
                success: true, actionType: 'set_surprised', encounterId: params.encounterId,
                participantIds: targets.map(p => p.id), surprised: params.surprised,
                message: `😲 ${summary}`
            };
        },
        aliases: ['surprise', 'surprised'],
        description: "Catch participants flat-footed after create (round 1, before their first turn): their turn passes on advance and they cannot react, act or take legendary actions until it has; surprised: false clears it. Logged"
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
            // Lane L: an offered save is answered by its saveRef; everything is checked before the spend.
            if (params.saveRef) {
                const problem = legendaryOfferProblem(p, params.saveRef);
                if (problem) return refuse(problem);
                // Lane K: a concentration offer puts the spell back; refused if it cannot come back (a new spell since, 0 HP, no sheet).
                const offer = (p.pendingLegendaryOffers ?? []).find(o => o.ref === params.saveRef);
                if (offer?.kind === 'concentration') {
                    const blocked = concentrationRestoreProblem(getDb(), p.id, offer.concentration, { hp: p.hp });
                    if (blocked) return refuse(`${blocked} (offer ${offer.ref}). Nothing spent.`);
                }
            }
            // Lanes O and K: an ongoing tick's or a stunt's answer heals HP back: read the sheet's HP first
            // (a character_manage edit between calls), and write the refund through after.
            const heals = !!params.saveRef && (p.pendingLegendaryOffers ?? []).some(o => o.ref === params.saveRef && (o.kind === 'ongoing' || o.kind === 'stunt'));
            if (heals) syncParticipantHpFromDb(state);
            const hpBefore = p.hp;
            const spent = engine.useLegendaryResistance(p.id);
            if (!spent.success) return refuse(`${p.name}: ${spent.error ?? 'legendary resistance refused'}`);
            // Lane K: the handler's reversal writes the concentration row back (the engine never touches the database).
            const answer = params.saveRef ? answerLegendaryOffer({
                removeCondition: (id, conditionId) => engine.removeCondition(id, conditionId),
                heal: (id, amount) => engine.heal(id, amount),
                restoreConcentration: (id, snap) => restoreConcentrationRow(getDb(), id, snap)
            }, p, params.saveRef) : undefined;
            if (heals) {
                // A refund that lifts the creature off 0 wakes its sheet too (the dying Unconscious and Prone go).
                if (hpBefore <= 0 && p.hp > 0) clearDyingOnRow(p.id);
                saveEncounterState(new EncounterRepository(getDb()), params.encounterId, state);
            } else new EncounterRepository(getDb()).saveState(params.encounterId, state);
            // Legendary resistances last the day, so the sheet keeps the count (exact id: a prefix match is another creature's sheet).
            const mirrored = mirrorLegendaryToSheet(getDb(), p.id, spent.remaining);
            // Lane K: HP healed back reaches the sheet too (exact id), or the next action's sync would undo it.
            if (answer?.refunded) {
                const repo = new CharacterRepository(getDb());
                if (repo.findById(p.id)?.id === p.id) repo.update(p.id, { hp: p.hp });
            }
            const undone = answer?.conditionEnded ? `: ${answer.conditionEnded.name} ends`
                : answer?.concentrationRestored ? `: concentration on ${answer.concentrationRestored.spell} holds`
                : answer?.refunded ? `: ${answer.refunded} HP back` : '';
            logConditionChange(params.encounterId, state, 'legendary_resistance', p.id, `${p.name} uses a legendary resistance: ${params.reason}${answer ? ` (${answer.offer.ref}, ${offerSaveLabel(answer.offer)}${undone})` : ''}`, params.reason);
            const lr = `LR ${spent.remaining}/${p.legendaryResistances} left`;
            // Without saveRef the spend undoes nothing: name the offers it could have answered.
            const open = answer ? [] : (p.pendingLegendaryOffers ?? []);
            const openOffers = open.map(o => ({ saveRef: o.ref, kind: o.kind, condition: o.condition, ...(o.conditionId !== undefined ? { conditionId: o.conditionId } : {}), ...(o.refund !== undefined ? { refund: o.refund } : {}) }));
            // Lane K: how to undo each kind by hand, the resistance being already spent.
            const byHand = (o: (typeof open)[number]) => o.kind === 'concentration' && o.concentration
                ? `restore the spell with ${concentrationRestoreCall(p.id, o.concentration, false)}`
                : o.kind === 'stunt' || o.kind === 'ongoing'
                    ? `heal the ${o.refund ?? 0} HP back with adjust_hp {encounterId, participantId: '${p.id}', delta: ${o.refund ?? 0}, reason}`
                    : `end the condition with remove_condition {encounterId, participantId: '${p.id}', conditionId}`;
            const openNote = open.length
                ? ` This spend answered no offer, so nothing was undone. Open: ${open.map(o => `saveRef '${o.ref}' (${offerSaveLabel(o)}${(o.kind === 'ongoing' || o.kind === 'stunt') && o.refund ? `, refund ${o.refund}` : ''})`).join(', ')}. If it was for one of those, ${open.every(o => o.kind === 'save_ends') ? byHand(open[0]) : open.map(o => `${o.ref}: ${byHand(o)}`).join('; ')} (the resistance is already spent); next time pass saveRef to spend and undo in one call.`
                : '';
            return {
                success: true, actionType: 'legendary_resistance', encounterId: params.encounterId, participantId: p.id,
                remaining: spent.remaining, of: p.legendaryResistances, mirroredToCharacter: mirrored,
                ...(answer ? { saveRef: answer.offer.ref } : {}),
                ...(answer?.conditionEnded ? { conditionEnded: answer.conditionEnded } : {}),
                ...(answer?.concentrationRestored ? { concentrationRestored: answer.concentrationRestored } : {}),
                ...(answer?.refunded ? { refunded: answer.refunded, hp: p.hp } : {}),
                ...(openOffers.length ? { openOffers } : {}),
                message: answer
                    ? `👑 ${p.name} turns the failed ${offerSaveLabel(answer.offer)} into a success (${params.reason})${undone}; ${lr}`
                    : `👑 ${p.name} turns a failed save into a success (${params.reason}); ${lr}${openNote}`
            };
        },
        aliases: ['use_legendary_resistance', 'legendary_save'],
        description: 'Spend a legendary resistance to turn a failed save into a success; mirrors the count to the sheet (exact id) and logs. saveRef answers an offered save: the failed save becomes a success, so its save_ends condition ends, a broken concentration is restored, or a stunt\'s damage is healed back; an offered ongoing or pressure save (ong-…): the damage the success would have avoided is healed back, on the sheet too'
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
            // Caught flat-footed: nothing, not even a free ability, until its first turn has passed.
            if (p.surprised) return refuse(`${p.name} is surprised: no action until its first turn passes`);
            const ability = (p.abilities ?? []).find(a => a.name.toLowerCase() === params.ability.trim().toLowerCase());
            if (!ability) {
                const known = (p.abilities ?? []).map(a => a.name);
                return refuse(`${p.name} has no ability '${params.ability}'${known.length ? `; it has ${known.join(', ')}` : ' (give it abilities: [{name, recharge?}])'}`);
            }
            if (ability.ready === false) {
                return refuse(ability.recharge
                    ? `${p.name}'s ${ability.name} is spent and not recharged (recharge ${ability.recharge}+ on a d6 at the start of its turn)`
                    : ability.perRest
                        ? `${p.name}'s ${perRestSpentNote(ability)}`
                        : `${p.name}'s ${ability.name} is spent (character_manage restore_ability or a rest readies it)`);
            }
            // What the use costs: nothing when it grants an action (Action
            // Surge), else its actionCost (the action by default). An action
            // or bonus action is spent on the user's own turn: off it, the
            // flag would be reset at its turn start, a free use in disguise.
            // A reaction or a free ability may happen off-turn.
            const grants = ability.grantsAction === true;
            const cost: 'action' | 'bonus' | 'reaction' | 'none' = grants ? 'none' : (ability.actionCost ?? 'action');
            // Play report 7 #10 (review): a controlled mount may only Dash, Disengage or
            // Dodge, and its own slot never comes (it passes), so say that, not "its own turn".
            if (grants || cost === 'action' || cost === 'bonus') {
                const steedRefusal = controlledMountActionRefusal(state, p.id, 'use_ability');
                if (steedRefusal) return refuse(steedRefusal);
            }
            const activeId = state.turnOrder[state.currentTurnIndex];
            const offTurn = !!activeId && activeId !== p.id;
            if (offTurn && (grants || cost === 'action' || cost === 'bonus')) {
                const active = activeId === 'LAIR' ? 'the lair' : state.participants.find(x => x.id === activeId)?.name ?? activeId;
                return refuse(`It is not ${p.name}'s turn (${active} is acting): ${ability.name} ${grants ? 'grants an action on its own turn' : `costs the ${cost === 'bonus' ? 'bonus action' : 'action'}, spent on its own turn`}.`);
            }
            if (grants) {
                if (!engine.canTakeActions(p.id)) return refuse(`${p.name} is incapacitated`);
            } else if (cost !== 'none') {
                const economy = engine.validateActionEconomy(p.id, cost);
                if (!economy.valid) return refuse(`${p.name}: ${economy.error ?? `${cost} unavailable`}`);
            }
            if (params.savingThrow && !toLongAbility(params.savingThrow.ability)) return refuse(`Unknown save ability '${params.savingThrow.ability}'`);
            // Play report 7 #1: an area on a unit goes model by model; a spaced
            // unit needs its count before anything is rolled or spent.
            const isArea = params.area ?? params.modelsInArea !== undefined;
            if (isArea && (params.damage !== undefined || params.savingThrow)) {
                const needs = unitsNeedingCount(state.participants, params.targetIds, params.modelsInArea as ModelsInArea | undefined);
                if (needs.length) return { ...refuse(areaCountMessage(needs)), modelsInAreaNeeded: needs };
            }

            if (grants) {
                const granted = engine.grantExtraAction(p.id);
                if (!granted.ok) return refuse(granted.error);
            } else if (cost !== 'none') {
                engine.commitAction(p.id, cost);
            }
            // Play report 7 #6: a free use is still the token acting this turn.
            engine.markActed(p.id);
            // A recharge ability rolls to come back; a granted action is a
            // one-shot resource (two surges a turn would be two extra actions);
            // a perRest ability (item 18) waits for a rest.
            const perRest = !!ability.perRest;
            if (ability.recharge || grants || perRest) ability.ready = false;
            // A spend the fight cannot bring back reaches the sheet, so the next
            // fight does not start with it ready; recharge spends stay on the token.
            const mirroredToCharacter = (grants || perRest) && !ability.recharge ? patchRowAbility(getDb(), p.id, ability.name, false).found : false;
            const area = resolveAreaSave(engine, {
                targetIds: params.targetIds, damage: params.damage, damageType: params.damageType,
                savingThrow: params.savingThrow, halfDamageOnSave: params.halfDamageOnSave,
                // Play report 5: cover from the user to each target (stated per target wins), riders on the save.
                originId: p.id, cover: params.cover as Record<string, unknown> | undefined,
                onFail: params.savingThrow?.onFail, onSuccess: params.savingThrow?.onSuccess,
                area: isArea, modelsInArea: params.modelsInArea as ModelsInArea | undefined, encounterId: params.encounterId
            }, ability.name);
            // Play report 5 #5: a tracked token the ability killed is killed on its sheet.
            const killed = await settleAreaDeaths(params.encounterId, state, area.targets, ability.name);
            saveEncounterState(new EncounterRepository(getDb()), params.encounterId, state);
            const summary = `${p.name} uses ${ability.name}${grants ? ' (one extra action this turn)' : ''}${area.targets.length ? ` on ${area.targets.map(t => t.unitArea ? `${t.targetName} (${t.unitArea.modelsKilled}/${t.unitArea.modelsInArea} models dead, ${t.damageTaken})` : `${t.targetName} (${t.saved ? 'saved, ' : ''}${t.damageTaken})`).join(', ')}` : ''}${params.reason ? ` — ${params.reason}` : ''}`;
            logConditionChange(params.encounterId, state, 'use_ability', p.id, summary, params.reason);
            let message = grants
                ? `⚡ ${p.name} uses ${ability.name}: one extra action this turn (extra actions: ${p.extraActions ?? 0})`
                : `✴ ${p.name} uses ${ability.name}${cost === 'none' ? ' (free)' : cost !== 'action' ? ` (${cost})` : ''}`;
            if (typeof params.damage === 'string') message += ` (${params.damage}: ${area.damageRolled})`;
            if (area.lines.length) message += '\n' + area.lines.join('\n');
            if (killed.length) message += '\n' + killedLines(killed).join('\n');
            if (ability.recharge) message += `\n${ability.name} is spent; it recharges on a d6 of ${ability.recharge}+ at the start of ${p.name}'s turn.`;
            else if (perRest) message += `\n${perRestSpentNote(ability)}${mirroredToCharacter ? '; the sheet shows it spent too' : ''}.`;
            else if (grants) message += `\n${ability.name} is spent (character_manage restore_ability or a rest readies it)${mirroredToCharacter ? '; the sheet shows it spent too' : ''}.`;
            return {
                success: true, actionType: 'use_ability', encounterId: params.encounterId, participantId: p.id,
                ability: ability.name, ready: ability.ready !== false,
                actionCost: cost, grantsAction: grants,
                ...(grants ? { extraActions: p.extraActions ?? 0 } : {}),
                ...(grants || perRest ? { mirroredToCharacter } : {}),
                ...(area.damageRolled !== undefined ? { damageRolled: area.damageRolled } : {}),
                ...(area.damageRolls ? { damageRolls: area.damageRolls } : {}),
                targets: area.targets,
                ...unitLinesOf(area.targets),
                ...saveSourcesOf(area.targets, params.savingThrow?.ability),
                // Lane K: a legendary resistance a concentration save offered (summary keeps it whole).
                ...(area.legendaryOffers.length ? { legendaryOffers: area.legendaryOffers } : {}),
                ...(area.missing.length ? { missingTargets: area.missing } : {}),
                ...(killed.length ? { killed } : {}),
                message
            };
        },
        aliases: ['ability', 'breath_weapon', 'recharge_ability'],
        description: "Use a limited ability (a breath weapon): spends its actionCost (the action by default; action|bonus on its own turn only), marks a recharge, perRest or action-granting ability spent, and resolves damage and a save per target on the fight's dice (area: true: a unit token saves model by model; otherwise it loses one model at most). grantsAction (Action Surge) costs nothing and banks one extra action this turn; grantsAction and perRest spends are mirrored to the sheet (a rest readies perRest ones)"
    },
    apply_damage: {
        schema: ApplyDamageSchema,
        handler: async (params: z.infer<typeof ApplyDamageSchema>, ctx?: SessionContext) => {
            if (!ctx) throw new Error('No session context');
            return applyDamage(params, ctx);
        },
        aliases: ['damage', 'deal_damage', 'environment_damage', 'hazard'],
        description: "Damage with no actor (a hazard, a trap, a bite rolled off-turn): rolls once on logged dice, each target saves, resistances and concentration apply, units owe break tests. area: true (or modelsInArea) resolves a unit token model by model, each model saving on its own die; without it a unit loses one model at most. Never touches the action economy. Works in an encounter or on character sheets with none. A concentrating target's failed CON save asks legendary resistance: autoLegendaryResistance spends one (the spell holds); otherwise it is offered (in a fight with a saveRef that restores the spell; on the sheets with the concentration_manage restore call to paste), in legendaryOffers"
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
            if (p.surprised) return refuse(`${p.name} is surprised: no action, not even a free cry, until its first turn passes.`);
            let ability: NonNullable<typeof p.abilities>[number] | undefined;
            if (params.ability) {
                ability = (p.abilities ?? []).find(a => a.name.toLowerCase() === params.ability!.trim().toLowerCase());
                if (!ability) {
                    const known = (p.abilities ?? []).map(a => a.name);
                    return refuse(`${p.name} has no ability '${params.ability}'${known.length ? `; it has ${known.join(', ')}` : ''}.`);
                }
                if (ability.ready === false) {
                    return refuse(ability.perRest && !ability.recharge
                        ? `${p.name}'s ${perRestSpentNote(ability)}.`
                        : `${p.name}'s ${ability.name} is spent and not recharged (recharge ${ability.recharge ?? '?'}+ on a d6 at the start of its turn).`);
                }
            }
            // A cry that costs an action or bonus action is made on the
            // caller's own turn: off it, those flags would be spent and then
            // reset at its turn start, a free cry in disguise. actionCost
            // 'none' (the default) is a free action and may ring out of turn.
            // Play report 7 #10 (review): a controlled mount may only Dash, Disengage or
            // Dodge, and its own slot never comes (it passes), so say that, not "its own turn".
            if (params.actionCost !== 'none') {
                const steedRefusal = controlledMountActionRefusal(state, p.id, 'battle_cry');
                if (steedRefusal) return refuse(steedRefusal);
            }
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
            // Play report 7 #6: a free cry is still the caller acting this turn.
            engine.markActed(p.id);
            // A recharge cry rolls to come back; a perRest cry (item 18) waits
            // for a rest, and the sheet shows it spent so the next fight does too.
            if (ability?.recharge || ability?.perRest) ability.ready = false;
            const cryMirrored = ability?.perRest && !ability.recharge ? patchRowAbility(getDb(), p.id, ability.name, false).found : false;
            saveEncounterState(new EncounterRepository(getDb()), params.encounterId, state);
            const effects = [buff.attackAdvantage && 'advantage on attacks', buff.damageBonus !== undefined && `+${buff.damageBonus} damage on a hit`, buff.speedBonus && `+${buff.speedBonus} ft speed`, buff.moraleBonus && `+${buff.moraleBonus} morale`].filter(Boolean).join(', ');
            const summary = `${p.name} calls ${buff.name}: ${recipients.map(r => r.name).join(', ')} (${effects}) until the start of ${p.name}'s turn in round ${buff.untilRound + 1}${params.reason ? ` — ${params.reason}` : ''}`;
            logConditionChange(params.encounterId, state, 'battle_cry', p.id, summary, params.reason);
            return {
                success: true, actionType: 'battle_cry', encounterId: params.encounterId, participantId: p.id,
                buff, recipients: recipients.map(r => ({ id: r.id, name: r.name })),
                ...(offTurn ? { offTurn: true, note: `called off ${p.name}'s turn as a free action (actionCost none)` } : {}),
                ...(ability ? { ability: { name: ability.name, ready: ability.ready !== false, ...(ability.perRest ? { mirroredToCharacter: cryMirrored } : {}) } } : {}),
                message: `📣 ${summary}${ability?.recharge ? `\n${ability.name} is spent; it recharges on a d6 of ${ability.recharge}+ at the start of ${p.name}'s turn.` : ability?.perRest ? `\n${perRestSpentNote(ability)}${cryMirrored ? '; the sheet shows it spent too' : ''}.` : ''}`
            };
        },
        aliases: ['waaagh', 'warcry', 'war_cry', 'rally_cry'],
        description: "A battle cry (the Waaagh!): buffs the caller and every matching ally in range (advantage, damage, speed, morale) until the start of the caller's next turn; can spend a recharging or perRest ability"
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
// APPLY_DAMAGE — the no-actor damage lane
// ═══════════════════════════════════════════════════════════════════════════

type ApplyDamageParams = z.infer<typeof ApplyDamageSchema>;

/**
 * Play report: there was no damage lane without an actor. In a fight the
 * roll, saves, resistances, concentration and break tests go through
 * resolveAreaSave on the encounter's stream (lair_action and use_ability
 * share it); with no fight, sheets take it on logged dice. Refusals write
 * nothing.
 */
async function applyDamage(params: ApplyDamageParams, ctx: SessionContext): Promise<Record<string, unknown>> {
    const refuse = (message: string) => ({ error: true, actionType: 'apply_damage', message: `${message} Nothing was written.`, writes: 'none' });
    if (params.save && !toLongAbility(params.save.ability)) return refuse(`Unknown save ability '${params.save.ability}'.`);
    if (typeof params.dice === 'string') {
        try { parseDiceTerms(params.dice); } catch { return refuse(`Invalid dice '${params.dice}': use notation like '6d10', '2d6+3' or '6d10+3d10', or a number.`); }
    }
    const db = getDb();
    let encounterId = params.encounterId;
    let routed = false;
    if (!encounterId) {
        // A character with a live token takes it through that fight.
        const homes = new Map<string, string>();
        for (const id of params.targetIds) {
            const enc = liveEncounterFor(db, id);
            if (enc) homes.set(id, enc);
        }
        const encs = [...new Set(homes.values())];
        if (encs.length > 1 || (encs.length === 1 && homes.size !== params.targetIds.length)) {
            const where = params.targetIds.map(id => `${id}: ${homes.get(id) ?? 'no fight'}`).join(', ');
            return refuse(`These targets are not all in one place (${where}). Call apply_damage once per encounter, and once for the targets outside any fight.`);
        }
        if (encs.length === 1) { encounterId = encs[0]; routed = true; }
    }
    return encounterId ? applyDamageInEncounter(params, ctx, encounterId, routed, refuse) : applyDamageToSheets(params, refuse);
}

/** Play report 2, item 6: the kill credits apply_damage hands out, one per victim dropped to 0 (play report 7 #1: per model of a unit). */
type KillCredit = GrowthCredit & { victimId: string; modelsKilled?: number };

async function applyDamageInEncounter(params: ApplyDamageParams, ctx: SessionContext, encounterId: string, routed: boolean, refuse: (m: string) => Record<string, unknown>): Promise<Record<string, unknown>> {
    const engine = getOrLoadEngine(ctx, encounterId);
    const state = engine?.getState();
    if (!engine || !state) return refuse(`Encounter ${encounterId} not found (memory or DB).`);
    // Read character_manage HP changes before this writes HP back.
    syncParticipantHpFromDb(state);
    const missing = params.targetIds.filter(id => !state.participants.some(p => p.id === id));
    if (missing.length) return refuse(`Not in encounter ${encounterId}: ${missing.join(', ')}.`);
    // Play report 7 #1: an area on a unit goes model by model; a spaced unit
    // needs its count before anything is rolled.
    const isArea = params.area ?? params.modelsInArea !== undefined;
    if (isArea) {
        const needs = unitsNeedingCount(state.participants, params.targetIds, params.modelsInArea as ModelsInArea | undefined);
        if (needs.length) return { error: true, actionType: 'apply_damage', message: areaCountMessage(needs), writes: 'none', modelsInAreaNeeded: needs };
    }
    // Request 11: with an actor, the band rule's damageScale reads its band.
    const actorBand = params.actorId
        ? state.participants.find(p => p.id === params.actorId)?.band ?? (new CharacterRepository(getDb()).findById(params.actorId) as { band?: string } | null)?.band
        : undefined;
    const ruleWorld = params.actorId ? resolveWorldId(getDb(), { encounterId, characterIds: [params.actorId] }) : null;
    const bandRule = params.actorId ? bandRuleFor(getDb(), ruleWorld, [actorBand]) : undefined;
    const area = resolveAreaSave(engine, {
        targetIds: params.targetIds, damage: params.dice, damageType: params.damageType,
        savingThrow: params.save ? { ability: params.save.ability, dc: params.save.dc } : undefined,
        halfDamageOnSave: params.save?.half ?? true,
        damagePurpose: `damage: ${params.source}`,
        // Play report 5: cover (stated per target, else from the actor's token), riders on the save.
        ...(params.actorId && state.participants.some(p => p.id === params.actorId) ? { originId: params.actorId } : {}),
        cover: params.cover as Record<string, unknown> | undefined,
        onFail: params.save?.onFail, onSuccess: params.save?.onSuccess,
        ...(bandRule && actorBand ? { bandScaleFor: (t: { band?: string }) => bandDamageMultiplier(bandRule, actorBand, t.band) } : {}),
        area: isArea, modelsInArea: params.modelsInArea as ModelsInArea | undefined, encounterId
    }, params.source);
    // Play report 2, item 6: with an actor, every target it dropped to 0 is a
    // kill on its growth track (perKill, perBandAbove), in order; an auto
    // rung's condition lands on the actor's token before the state is saved.
    const growth: KillCredit[] = [];
    if (params.actorId) {
        for (const t of area.targets) {
            const victim = state.participants.find(p => p.id === t.targetId);
            // Play report 7 #1: a unit credits each model the damage killed, wiped or not.
            const modelsKilled = victim?.unit && t.hpBefore !== undefined && t.hpAfter !== undefined ? modelsKilledBetween(victim.unit, t.hpBefore, t.hpAfter) : undefined;
            if (modelsKilled !== undefined ? modelsKilled <= 0 : !((t.hpBefore ?? 0) > 0 && (t.hpAfter ?? 1) <= 0)) continue;
            const credit = await creditKill(getDb(), ruleWorld, params.actorId, { id: t.targetId, name: t.targetName, band: victim?.band, ...(victim?.bandAssumed ? { bandAssumed: true } : {}) }, actorBand, modelsKilled ?? 1);
            if (!credit) continue;
            growth.push({ victimId: t.targetId, ...(modelsKilled !== undefined ? { modelsKilled } : {}), ...credit });
            if (state.participants.some(p => p.id === params.actorId)) growthConditionsOnToken(engine, params.actorId, credit);
        }
    }
    // Play report 5 #5: a tracked token the damage killed is killed on its sheet.
    const killed = await settleAreaDeaths(encounterId, state, area.targets, params.source);
    saveEncounterState(new EncounterRepository(getDb()), encounterId, state);
    const hpChanges: Record<string, { before: number; after: number }> = {};
    for (const t of area.targets) if (t.hpBefore !== undefined && t.hpAfter !== undefined) hpChanges[t.targetId] = { before: t.hpBefore, after: t.hpAfter };
    const summary = `${params.source}: ${area.targets.map(t => `${t.targetName} ${t.cover?.unaffected ? 'unaffected (total cover)' : `${t.unitArea ? `${t.unitArea.modelsKilled}/${t.unitArea.modelsInArea} models dead, ` : t.saved ? 'saved, ' : ''}${t.damageTaken}${params.damageType ? ` ${params.damageType}` : ''}${t.conditionsApplied?.length ? ` +${t.conditionsApplied.join(',')}` : ''}`}`).join(', ')}`;
    getDomainServices().combatActionLog.log({
        encounterId, round: state.round, turnIndex: state.currentTurnIndex,
        actorId: params.actorId ?? 'environment', actorName: params.source, actionType: 'apply_damage',
        targetIds: params.targetIds, resultSummary: summary,
        damageDealt: area.targets.reduce((a, t) => a + t.damageTaken, 0), hpChanges
    });
    let message = `💥 ${params.source}${typeof params.dice === 'string' ? ` (${params.dice}: ${area.damageRolled})` : ` (${area.damageRolled})`}`;
    if (area.lines.length) message += '\n' + area.lines.join('\n');
    if (killed.length) message += '\n' + killedLines(killed).join('\n');
    if (growth.length) message += '\n' + growth.map(g => `⬆ ${growthLine(g)}`).join('\n');
    return {
        success: true, actionType: 'apply_damage', encounterId, ...(routed ? { routedToEncounter: true } : {}),
        source: params.source, damageRolled: area.damageRolled,
        ...(area.damageRolls ? { damageRolls: area.damageRolls } : {}),
        ...(params.damageType ? { damageType: params.damageType } : {}),
        targets: area.targets,
        ...unitLinesOf(area.targets),
        // Play report 7 (lane G1): what each save took, where output_mode 'summary' keeps it whole.
        ...saveSourcesOf(area.targets, params.save?.ability),
        // Lane K: a legendary resistance a concentration save offered (saveRef and the call), kept whole the same way.
        ...(area.legendaryOffers.length ? { legendaryOffers: area.legendaryOffers } : {}),
        ...(area.breakTests.length ? { breakTests: area.breakTests } : {}),
        ...(killed.length ? { killed } : {}),
        ...(growth.length ? { growth } : {}),
        message
    };
}

/**
 * Play report 7 #1: each unit an area resolved model by model, as the
 * owner's line ("Militia — 6 in the area: 4 failed, 2 saved; 31 / 15 vs 9 HP
 * each: 6 dead, 0/6 left"), at the reply's top level where output_mode
 * 'summary' keeps it whole.
 */
function unitLinesOf(targets: Array<{ targetName: string; unitArea?: { line: string }; breakTest?: { moraleTotal?: number } }>): { unitLines?: string[] } {
    const lines = targets.filter(t => t.unitArea).map(t => unitSummaryLine(t.targetName, t.unitArea!, t.breakTest));
    return lines.length ? { unitLines: lines } : {};
}

async function applyDamageToSheets(params: ApplyDamageParams, refuse: (m: string) => Record<string, unknown>): Promise<Record<string, unknown>> {
    const db = getDb();
    const charRepo = new CharacterRepository(db);
    const rows = params.targetIds.map(id => ({ id, row: charRepo.findById(id) }));
    const missing = rows.filter(r => !r.row || r.row.id !== r.id).map(r => r.id);
    if (missing.length) return refuse(`No character ${missing.join(', ')} (without encounterId, targets are character ids).`);
    let damageRolled: number; let damageRolls: number[] | undefined;
    if (typeof params.dice === 'string') {
        const r = loggedRoll(db, { purpose: `damage: ${params.source}` }, params.dice, { tool: 'combat_manage' });
        damageRolled = Math.max(0, r.total); damageRolls = r.rolls;
    } else damageRolled = params.dice;
    const concentrationRepo = new ConcentrationRepository(db);
    const lines: string[] = [];
    // Request 11: with an actor, the band rule's damageScale reads its band.
    const actorBand = params.actorId ? (charRepo.findById(params.actorId) as { band?: string } | null)?.band : undefined;
    const ruleWorld = params.actorId ? resolveWorldId(db, { characterIds: [params.actorId, ...params.targetIds] }) : null;
    const bandRule = params.actorId ? bandRuleFor(db, ruleWorld, [actorBand]) : undefined;
    const statedCover = params.cover as Record<string, unknown> | undefined;
    const sheetKills: Array<{ id: string; name: string; cause: string }> = [];
    // Lane K: a failed concentration save off a fight: the sheet's autoLegendaryResistance spends, else the repair is reported.
    const legendaryOffers: LegendaryReplyRow[] = [];
    const targets = rows.map(({ id, row }) => {
        const sheet = row!;
        let damageTaken = damageRolled;
        let save: ReturnType<typeof rollCharacterSave> | undefined;
        // Play report 5 #1: no map here, so only the stated cover applies; total leaves the sheet untouched.
        const coverKind = normalizeCover(statedCover?.[id] ?? statedCover?.['*']);
        const cover: CoverResolution | undefined = coverKind && coverKind !== 'none' ? { kind: coverKind, acBonus: coverBonus(coverKind), source: 'declared', via: 'call' } : undefined;
        if (cover?.kind === 'total') {
            lines.push(`🎯 ${sheet.name} — unaffected: total cover (declared)`);
            return { targetId: id, targetName: sheet.name, saved: false, damageTaken: 0, hpBefore: sheet.hp, hpAfter: sheet.hp, defeated: sheet.hp <= 0, cover: { kind: 'total', source: 'declared', via: 'call', saveBonus: 0, unaffected: true as const } };
        }
        const dexSave = !!params.save && (toLongAbility(params.save.ability) ?? 'dexterity') === 'dexterity';
        const saveBonus = cover && dexSave ? cover.acBonus : 0;
        if (params.save) {
            save = rollCharacterSave(db, sheet, params.save.ability, params.save.dc, { purpose: `${params.source} save (${toLongAbility(params.save.ability)})${saveBonus ? ` (cover +${saveBonus})` : ''}`, tool: 'combat_manage', ...(saveBonus ? { extraBonus: saveBonus } : {}) });
            if (save.saved) damageTaken = (params.save.half ?? true) ? Math.floor(damageTaken / 2) : 0;
        }
        // Play report 5 #6: riders on the sheet: upsert by name, sourced to the effect unless the entry names its own.
        const rider = save ? (save.saved ? params.save?.onSuccess : params.save?.onFail) : undefined;
        const conditionsApplied: string[] = [];
        for (const entry of rider?.conditions ?? []) {
            const label = typeof entry === 'string' ? entry : String(entry.type || entry.name || '');
            if (!label.trim()) continue;
            const norm = normalizeCondition(entry, id);
            mirrorConditionToRow(id, 'add', label, norm?.duration, norm?.sourceId ?? `${params.source} (${save!.saved ? 'saved' : 'failed save'})`);
            conditionsApplied.push(label);
            // Lane O: ongoing damage ticks on a token's turns, and a sheet outside a fight has none: say so, never drop it silently.
            if (norm?.ongoingEffects?.length) lines.push(`⚠️ ${sheet.name} — ${label}: its ongoing damage ticks on a token in a fight; outside one the sheet keeps the condition's name only`);
        }
        const mod = damageWithModifiers(damageTaken, params.damageType, sheet as DamageDefences);
        damageTaken = mod.finalDamage;
        let bandScale: { steps: number; multiplier: number; before: number; after: number } | undefined;
        const scale = damageTaken > 0 && actorBand ? bandDamageMultiplier(bandRule, actorBand, (sheet as { band?: string }).band) : null;
        if (scale) {
            const scaled = Math.max(1, Math.floor(damageTaken * scale.multiplier));
            bandScale = { ...scale, before: damageTaken, after: scaled };
            damageTaken = scaled;
        }
        const hpBefore = sheet.hp;
        const hpAfter = Math.max(0, hpBefore - damageTaken);
        if (hpAfter !== hpBefore) charRepo.update(id, { hp: hpAfter });
        const defeated = hpAfter <= 0;
        // Play report 7 (lane H): the sheet's declared save:con sides and conditions, on a logged d20.
        const concentration = damageTaken > 0
            ? concentrationAfterDamage(id, damageTaken, defeated && hpBefore > 0, sheetConcentrationDie(db, id, 'combat_manage'), concentrationRepo, charRepo, 0,
                concentrationLegendaryHook(db, id, legendaryOffers))
            : undefined;
        // Play report 5 #5, outside a fight: a tracked sheet dropped to 0 is
        // DYING (unconscious, prone; no saves are rolled round by round — the
        // reply offers the stabilise call); massive damage kills it outright.
        const tracked = rowTracksDeathSaves(sheet as { characterType?: string; deathSaves?: boolean }) === true;
        let dying = false; let dead = false; let deadNote = ''; let noLongerStable = false;
        // A sheet that already has a corpse is dead, not dying: nothing to track.
        const alreadyDead = tracked && defeated && (() => { try { return !!new CorpseRepository(db).findByCharacterId(id); } catch { return false; } })();
        if (tracked && defeated && damageTaken > 0 && !alreadyDead) {
            // The leftover past 0: the whole blow when already down.
            const overflow = hpBefore > 0 ? damageTaken - hpBefore : damageTaken;
            if (overflow >= sheet.maxHp && sheet.maxHp > 0) {
                dead = true;
                deadNote = `${params.source} (massive damage)`;
                sheetKills.push({ id, name: sheet.name, cause: deadNote });
            } else {
                // Dropped now, or hit while already down: dying either way (no
                // counters outside a fight; the table stabilises or heals). A
                // Stable marker comes off: damage to a stable creature makes it dying again.
                dying = true;
                const own = (sheet as { conditions?: RowCondition[] }).conditions ?? [];
                noLongerStable = own.some(c => c.name.toLowerCase() === 'stable');
                const next = withDyingRowConditions(noLongerStable ? own.filter(c => c.name.toLowerCase() !== 'stable') : own);
                if (next.added.length || noLongerStable) charRepo.update(id, { conditions: next.conditions } as never);
            }
        }
        let line = `🎯 ${sheet.name}`;
        if (save && params.save) {
            line += saveBonus && cover
                ? ` - ${saveArithmetic(save.ability, save.natural, save.modifier - saveBonus, cover, save.total, params.save.dc)} ${save.saved ? '✓ SAVED' : '✗ FAILED'}`
                : ` - ${save.ability} save: ${save.natural} + ${save.modifier} = ${save.total} vs DC ${params.save.dc} ${save.saved ? '✓ SAVED' : '✗ FAILED'}`;
            // Play report 7 (lane G1): the sources the sheet's save took, and a tagged mechanic's hint.
            line += saveSidesNote(save);
            for (const c of [...(save.conditionalAdvantage ?? []), ...(save.conditionalDisadvantage ?? [])]) line += `\n   conditional: ${c}`;
        }
        line += `\n   Damage: ${damageTaken}${params.damageType ? ` ${params.damageType}` : ''}${mod.modifier !== 'normal' ? ` (${mod.modifier})` : ''}${bandScale ? ` ×${bandScale.multiplier} band (${bandScale.before} → ${bandScale.after})` : ''}`;
        line += `\n   HP: ${hpAfter}/${sheet.maxHp}${dead ? ' ☠ DEAD (massive damage)' : dying ? ' 🩸 DYING' : alreadyDead ? ' ☠ DEAD' : defeated ? ' 💀 DOWN' : ''}`;
        if (noLongerStable) line += `\n   💤→🩸 ${sheet.name} was stable: the blow makes it dying again (no longer stable)`;
        if (dying) line += `\n   🩸 ${sheet.name} is dying: unconscious and prone. No death saves outside a fight — stabilise: combat_action stabilize {actorId: '<healer>', targetId: '${id}'} (Medicine DC 10; a healer's kit or Spare the Dying is automatic), or heal above 0`;
        if (concentration) line += `\n   ${concentrationLine(concentration)}`;
        if (conditionsApplied.length) line += `\n   Conditions: ${conditionsApplied.join(', ')}`;
        lines.push(line);
        return {
            targetId: id, targetName: sheet.name,
            ...(save ? { saveRoll: save.natural, saveTotal: save.total, ...saveLabelsOf(save) } : {}),
            saved: !!save?.saved, damageTaken, hpBefore, hpAfter, defeated,
            ...(cover ? { cover: { kind: cover.kind, source: cover.source, via: cover.via, saveBonus, ...(params.save && !dexSave ? { note: 'cover adds to DEX saves only' } : {}) } } : {}),
            ...(conditionsApplied.length ? { conditionsApplied } : {}),
            ...(dying ? { dying: true, stabilize: { tool: 'combat_action', args: { action: 'stabilize', actorId: '<healer>', targetId: id } } } : {}),
            ...(noLongerStable ? { wasStable: true } : {}),
            ...(dead ? { dead: true, massiveDamage: true } : {}),
            ...(mod.modifier !== 'normal' ? { damageModifier: mod.modifier } : {}),
            ...(bandScale ? { bandScale } : {}),
            ...(concentration ? { concentration } : {})
        };
    });
    // Play report 5 #5: the kills, through character_manage kill (HP 0, concentration, a corpse).
    const killed: Array<{ characterId: string; name: string; cause: string; corpseId?: string }> = [];
    if (sheetKills.length) {
        const { handleKill } = await import('./character-manage.js');
        for (const k of sheetKills) {
            const r = await handleKill({ action: 'kill', characterId: k.id, cause: k.cause }) as Record<string, unknown>;
            killed.push({ characterId: k.id, name: k.name, cause: k.cause, ...(typeof r.corpseId === 'string' ? { corpseId: r.corpseId } : {}) });
        }
    }
    // Play report 2, item 6: the same kill credit as the encounter path; an
    // auto rung's condition already reaches the sheet through applyGrowth.
    const growth: KillCredit[] = [];
    if (params.actorId) {
        for (const t of targets) {
            if (!(t.hpBefore > 0 && t.defeated)) continue;
            const victim = rows.find(r => r.id === t.targetId)?.row as { band?: string } | null | undefined;
            const credit = await creditKill(db, ruleWorld, params.actorId, { id: t.targetId, name: t.targetName, band: victim?.band }, actorBand);
            if (credit) growth.push({ victimId: t.targetId, ...credit });
        }
    }
    let message = `💥 ${params.source}${typeof params.dice === 'string' ? ` (${params.dice}: ${damageRolled})` : ` (${damageRolled})`} — no encounter, written to the sheet${targets.length === 1 ? '' : 's'}`;
    if (lines.length) message += '\n' + lines.join('\n');
    if (killed.length) message += '\n' + killed.map(k => `☠ ${k.name} is dead (${k.cause})${k.corpseId ? ` — corpse ${k.corpseId.slice(0, 8)}` : ''}`).join('\n');
    if (growth.length) message += '\n' + growth.map(g => `⬆ ${growthLine(g)}`).join('\n');
    return {
        success: true, actionType: 'apply_damage', source: params.source, damageRolled,
        ...(damageRolls ? { damageRolls } : {}),
        ...(params.damageType ? { damageType: params.damageType } : {}),
        targets,
        ...saveSourcesOf(targets, params.save?.ability),
        // Lane K: off a fight no encounter row holds an offer: the repair call, kept whole by output_mode summary.
        ...(legendaryOffers.length ? { legendaryOffers } : {}),
        ...(killed.length ? { killed } : {}),
        ...(growth.length ? { growth } : {}),
        message
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
   🎯 Declared initiative (play report 7): an effect mechanic {type: 'advantage_on' | 'disadvantage_on', value: 'initiative' (or 'check:dex': initiative is a DEX check), condition?: '<tag>'} on a token (effects read by its id; a sheet-backed token's id is its character id) rolls its initiative twice at create and add_participant and keeps the higher (disadvantage the lower; both cancel to one die). Untagged it fires by itself; tagged it fires on participants[].context (create) or context (add_participant, every joiner) — a tag that fires nothing is warned. The row gains advantage / disadvantage: ['Alert (initiative)'] and rolls: [a, b]; the second die is on the fight's logged dice (purpose 'initiative (adv: …)'). A given initiative rolls nothing and ignores it.
   🎲 create replies initiative: [{id, name, roll, modifier, natural?, given?, surprised?, advantage?, disadvantage?, rolls?}] in turn order and firstUp {id, name, roll} (output_mode summary keeps both): tell the table the order before the first turn. Ad-hoc tokens take stats {str: 15} or abilityScores (missing scores 10; a sheet keeps its own). add_participant {encounterId, id?: 'hound-1', name, hp, maxHp, stats?, context?} | characterId | creature (count numbers id-1 … id-n) reports the joiner's roll, place in the order and first round (next round when its slot has passed); an id already in the fight, LAIR or a character row's id is refused.
   🏷 BANDS: in a banded world a token with no band of its own (explicit, sheet, creature or preset) takes the world's lowest band (of the ladder the fight's bands sit on, when the world has several), assumed: the reply lists bandAssumed and a warning, get shows (assumed), and execute, called strikes, CONSEQUENCE DUE, cleave and the other band lines print (band assumed). A band on none of the world's ladders is named in warnings at create. band spec requireBand: true refuses such a token instead. set_band {encounterId, participantId, band, reason?} changes a token's band from the next roll (never retroactively) and clears the mark. See docs/table-rules/ad-hoc-tokens.md
2. get - View current state
3. advance {confirm?} - Move to next turn. A living player character (pc row, heroes' side) whose turn is untouched (no action, bonus action, movement or other combat action) is not passed: TURN NOT TAKEN, writes: none. If the player passes or holds, advance {encounterId, confirm: true} (alias skipTurn: true) passes it (skippedTurn in the reply, logged). Never held: LAIR, HP 0, incapacitated, surprised, enemies, npc rows, sheetless tokens, agent-driven tokens (auto_on_turn); a world opts out with world_manage update {environment: {pcTurnGuard: 'off'}}. See docs/table-rules/turns.md
   🎲 A save_ends condition's end-of-turn save is a 5e saving throw (play report 7): the sheet's ability and save proficiency (a unit token's drilled unit.saves too), the creature's untagged {advantage_on | disadvantage_on, value: 'save:<ability>'} mechanics, restrained on a DEX save and exhaustion 3+; two d20s on advantage or disadvantage, both cancel. Plain 5e: the total against the DC; a natural 1 or 20 means nothing. A failed save by a creature with legendary resistance left spends one by itself (autoLegendaryResistance; the condition ends) or is offered: 'LR 2/3 left, spend one?' with the call to paste, legendary_resistance {…, saveRef}; a player character is asked, never spent for. The reply's endOfTurnSaves rows and legendaryOffers (both kept whole by output_mode summary) and turnStartNotes say the dice, the sources and whether it ended. See docs/table-rules/legendary-resistance.md
   🔥 ONGOING DAMAGE (play report 7 follow-up): add_condition {participantId, condition: {name, ongoing: {damage: number | dice, damageType?, when: start | end, save?: {ability, dc, onSuccess?: none | half | end}}}, area?, modelsInArea?} (create's conditions and save riders take ongoing too) ticks on the bearer's turn: rolled once on the fight's dice, logged and printed (turnDamage in the reply). On a unit it follows its source's shape: single target lands on the most wounded model, capped at it, and ends when that model dies; an area (add_condition area / modelsInArea, or a rider from an area on a unit) ticks per model inside, each with its own save. A creature's failed tick save offers legendary resistance (saveRef 'ong-…' heals the tick back). Water pressure is an area too. A unit a tick carries through its break point owes BREAK TEST DUE; a concentrating creature saves. See docs/table-rules/ongoing-damage.md
4. death_save {participantId, outcome?} - roll (or post) a death save for a downed tracked character; advance rolls them itself on the creature's turn unless deathSaveMode is prompt (DEATH SAVE DUE); stabilise with combat_action stabilize. See docs/table-rules/dying.md
5. lair_action - Execute boss lair action (LAIR turn only; once per round; damage takes dice; a creature that rolled 20 acts first). An area: a unit token in it saves model by model (a spaced unit needs modelsInArea: {id: n}); area: false makes it one target (a unit loses one model at most)
   legendary_action {participantId, cost?, description} - a non-attack legendary action off its turn (attacks: combat_action attack with legendaryCost)
   legendary_resistance {participantId, reason, saveRef?} - turn a failed save into a success (mirrored to the sheet). saveRef ('eot-2-boss-1', from an offered end-of-turn save) undoes that save: its save_ends condition ends; offers lapse when the creature's next turn starts. Engine saves spend one by themselves only with autoLegendaryResistance, never for a player character (asked instead)
   use_ability {participantId, ability, targetIds?, damage?: number | dice, damageType?, savingThrow?: {ability, dc}} - a limited ability (breath weapon): spends its actionCost (action by default; action|bonus on its own turn only, reaction|none off-turn too), marks a recharge ability spent (it rolls a d6 at the start of its turn) or a perRest ability spent until rest_manage short/long (mirrored to the sheet), saves per target. area: true (a breath, a cone) makes a unit token in it save model by model (modelsInArea: {id: n} for a spaced unit); without it a unit takes one model at most. An ability with grantsAction (Action Surge) costs nothing, banks one extra action this turn and is spent until restore_ability or a rest (mirrored to the sheet). get shows ⚡ extra actions N
   apply_damage {encounterId?, targetIds, dice: number | dice, source, actorId?, damageType?, save?: {ability, dc, half?}} - damage with no actor (a hazard, a trap, an off-turn bite): one logged roll, a save per target, resistances, concentration and break tests; no action spent. Without encounterId it writes to the sheets. With actorId, the band rule's damageScale scales each target by the band gap (bandScale per target), and a target it drops to 0 credits the kill to the actor's growth track: perKill, perBandAbove (growth: [{victimId, track, pool, delta, from, to, growthReady?, growthApplied?}] and a ⬆ GROWTH line). area: true (rubble, a blast) or modelsInArea makes a unit token save model by model (unitArea per target, and unitLines, one line per unit, which output_mode summary keeps; a spaced unit needs modelsInArea: {id: n}; each model killed is a kill credited); without it a unit takes one model at most, the most wounded first (unitCap). A unit's models keep their wounds: repeated damage adds up, and each unit target reports wounds ('4 alive: 2 unhurt, 1 at 5/9, 1 at 2/9'). Guide: docs/table-rules/units.md
   battle_cry {participantId, name?: 'Waaagh!', range?: 60, match?: {species?, band?, tag?, nameIncludes?}, rounds?: 1, attackAdvantage?, damageBonus?: number | dice, speedBonus?, moraleBonus?, ability?, actionCost?} - buffs the caller and matching allies in range until the start of the caller's next turn; actionCost action|bonus only on the caller's turn, none (default) is free and may be called out of turn
   😲 SURPRISE: create {…, surprised: ['gob-1']} or set_surprised {encounterId, participantIds, surprised?: true, reason?} (round 1, before their first turn) - the flagged creatures' round-1 turn passes on advance (noted), and until then they cannot react (no opportunity attacks, readied triggers or reaction attacks), act or take legendary actions. get shows 😲 surprised; STATE_JSON surprised: true. surprised: false clears a flag set by mistake
   🤲 SUBDUE (play report 7): create participants [{…, subdue: true}], add_participant {subdue: true} or set_subdue {encounterId, participantId, subdue, onSubdue?, reason?} - a standing order 'take them alive': the token's opportunity attacks and readied melee swings are non-lethal (a target they drop is knocked out: stable, no kill, no corpse; a PC reactor is offered attack {reaction, nonlethal: true}). A ranged shot can't be non-lethal, so it is settled when readied: combat_action ready / set_intent readied with a ranged attack (attack.ranged: true, or a profile with ranged: true) under the order is refused (writes: none) unless attack.onSubdue is 'hold' (the trigger holds fire; reaction and shot kept) or 'fire' (lethal, 'subdue order overridden'). An order put on a token already holding a ranged shot is flagged (readiedNeedsOnSubdue) and the shot holds until set_subdue {onSubdue} answers. No swing at a target already at 0 HP; a unit is never subdued. trigger_readied (like a move) carries reactionLines, one line per reaction (a knockout, a held shot, an override), which output_mode 'summary' keeps whole. See docs/table-rules/subdue-and-mounts.md
   🐎 MOUNTS (play report 7): mount {encounterId, riderId, mountId, controlled?: true, free?: true} / dismount {encounterId, riderId, position?, free?} - mounting and dismounting cost half the rider's speed on its own turn (free: true sets the scene). A controlled mount moves on its rider's turn: combat_action move {actorId: rider} spends the MOUNT's movement (dash {actorId: mount} widens it), the rider moves free and is credited the feet; its own slot passes on advance; it may only Dash, Disengage or Dodge. An independent mount (controlled: false) keeps its turn and carries the rider (the rider's own move is refused: dismount first). Opportunity attacks on the pair come once per reactor and strike the rider by default. Falls: a shoved mount or a rider knocked prone rolls the rider's DC 10 DEX save on the fight's dice (fail: dismounted, prone within 5 ft); a mount at 0 HP, prone or removed drops its rider prone. Replies carry mounts[] when a rider falls
   budget {partyLevels | partyId, creatures: [{creature | cr | xp, count?}] | encounterId} - read-only 5e XP budget: TRIVIAL/EASY/MEDIUM/HARD/DEADLY
   set_environment {encounterId, environment: {medium: air | water | vacuum, depthFt?, pressure?: {startsAtFt, damagePerRound, unlessTag?, damageType?, save?: {ability, dc, half?}}, rangedAllowed?, meleeDisadvantageUnlessDamageType?, swimTag?}} - the medium of the fight (create takes environment too). Water: movement budget is swimSpeed else half speed; ranged attacks refused unless rangedAllowed; melee at disadvantage unless the damage type is listed (piercing) or the attacker carries the swim tag ('aquatic'); pressure damage at the start of each turn at depthFt >= startsAtFt unless tagged: an area, so every model of a unit takes it separately (each with its own save when pressure.save is set; wounds add up), and any other token makes one plain-5e save (legendary resistance offered, saveRef refunds). Each tick prints a line and a turnDamage row; a unit it carries through its break point owes BREAK TEST DUE. See docs/table-rules/ongoing-damage.md. A token on a terrain.water cell swims the same way in an air fight. get shows ⟨water · 40 ft⟩
6. end - Finish combat
   board {encounterId, attackerId, targetId, rooms?, name?} (request 5) - both must be vessel tokens (character_manage create_vessel rows): opens a NEW boarding encounter linked by parent_id, notes the target's rooms (given, or its spatial deck plan), and leaves the void fight running. Add boarders with add_participant on the child; end {winner?, summary?} on the child writes boardingResult to the parent; get on the parent lists boardings. Vessel tokens: shields absorb before the hull (shieldsAbsorbed), regen at turn start; sections are system parts with roles — drive crippled = speed 0, guns crippled = that weapon refused, bridge crippled = disadvantage, reactor dead = reactor breach d6 each turn (1 destroys). Aim at a section with combat_action attack atPart.

For combat ACTIONS (attack, move, cast), use combat_action tool instead.
For MAP operations (render, aoe, terrain), use combat_map tool instead.
For CORPSES after combat, use corpse_manage tool.`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        encounterId: z.string().optional().describe('Encounter ID (required for most actions)'),
        seed: z.string().optional().describe('Seed for a replayable new encounter (create only; omit for crypto dice)'),
        participants: z.array(z.any()).optional().describe("Array of participants (create only). Shape per entry: { id: <character UUID — always the UUID>, name, hp, maxHp, initiativeBonus?: number (default 0, #103), ac?: number (falls back to attacker-side derivation), isEnemy?: boolean, position?: {x,y}, plus optional statline: size, reach, movementSpeed, attackBonus, attackDamage, attackDamageType, attacksPerAction, attacks [{name, attackBonus, damage, damageType?, part?, item?, reachFt?, ranged?, twoHanded?, default?}], abilities [{name, recharge?, perRest?, grantsAction?, ready?}], fightingStyle, legendaryActions, legendaryResistances, legendaryResistancesRemaining, autoLegendaryResistance, hasLairActions, cr, band, regeneration, parts, unit, intent, species, tags, stats: {str, dex, con, int, wis, cha} (or abilityScores, long or short keys; missing ones 10; initiativeBonus defaults to the DEX modifier), context?: ['ambush'] (play report 7: tags its initiative roll asserts; an effect mechanic {type: 'advantage_on' | 'disadvantage_on', value: 'initiative' | 'check:dex', condition?: '<tag>'} on the token rolls initiative twice, keeping the higher or lower; untagged ones fire without context; the initiative row names the source and both dice) }. A key a participant does not take is named in ignoredParams as participants[i].key"),
        terrain: z.any().optional().describe('Terrain configuration (create only); water: ["x,y"] cells run the underwater rules for a token standing there'),
        environment: z.any().optional().describe("create / set_environment: {medium: 'air'|'water'|'vacuum', depthFt?, pressure?: {startsAtFt, damagePerRound: number | dice, unlessTag?, damageType?, save?: {ability, dc, half? (default true)}} (an area: every model of a unit takes it separately, each with its own save; any other token one save, legendary resistance offered), rangedAllowed? (default false in water), meleeDisadvantageUnlessDamageType? (default ['piercing']), swimTag? (default 'aquatic'), light?: 'bright' | 'dim' | 'darkness'}. set_environment replaces the whole object (medium defaults to air). light: 'darkness' lets tokens attempt a Hide from foes without darkvision (get shows canHide)"),
        characterId: z.string().optional().describe('Character ID (death_save, add_participant)'),
        // FINDINGS #34 mirror block — add_participant + includeParty params
        includeParty: z.boolean().optional().describe('Include the active party in the new encounter (create / spawn_quick_enemy)'),
        partyId: z.string().optional().describe('Party to include (defaults to the only active party)'),
        name: z.string().optional().describe('add_participant: ad-hoc participant name; add_condition / remove_condition: condition name'),
        hp: z.number().optional().describe('Participant HP (add_participant); set_part: the part\'s own HP'),
        maxHp: z.number().optional().describe('Participant max HP (add_participant); set_part: the part\'s max HP'),
        ac: z.number().optional().describe('Participant AC (add_participant); set_part: AC to hit the part when aimed at'),
        initiativeBonus: z.number().optional().describe('Initiative bonus (add_participant); default the DEX modifier of stats/abilityScores when given, else 0'),
        stats: abilityScoresInputSchema().optional().describe("add_participant (create takes it per participant): ability scores, short keys {str: 15, dex: 14}; missing ones are 10 (a creature keeps its own). Unknown keys refused with the six; a characterId keeps its sheet's scores (warning)"),
        abilityScores: abilityScoresInputSchema().optional().describe('add_participant (create takes it per participant): ability scores, long or short keys ({strength: 15}); same as stats, and the two disagreeing is refused'),
        participantId: z.string().optional().describe('remove_participant / adjust_hp / death_save / add_condition / set_part / use_ability …: participant/token id (death_save takes participantId or characterId)'),
        id: z.string().optional().describe("add_participant only (create takes id per participant): the new token's id ('hound-1'; letters, digits, _ . : -, 64 at most). Refused when already in the fight, LAIR, or a character row's id without that characterId; a creature count numbers it id-1 … id-n"),
        outcome: z.union([z.string(), z.number()]).optional().describe("death_save (mirror): a result the table rolled — success | failure | nat20 | nat1 (also pass/fail, 'natural 20', or the natural die 1-20). No d20 is rolled; the counters move as posted"),
        deathSaves: z.boolean().optional().describe('add_participant (mirror; create takes it per participant): the token tracks death saves at 0 HP (default from its row: pc/npc yes, enemy no; a token with no row dies at 0). true opts a sheetless villain in, false a named character out'),
        deathSaveMode: z.enum(['auto', 'prompt']).optional().describe("add_participant (mirror; create takes it per participant): auto rolls the death save on advance; prompt prints DEATH SAVE DUE and refuses advance until death_save. Default from the sheet, else the world's environment.deathSaveMode"),
        participantIds: z.array(z.string()).optional().describe('set_surprised: the participants caught flat-footed'),
        surprised: z.union([z.array(z.string()), z.boolean()]).optional().describe("create: participant ids caught flat-footed (their round-1 turn passes; no reactions until it has). set_surprised: true (default) flags participantIds, false clears"),
        value: z.number().optional().describe('adjust_hp: set HP to exactly this'),
        delta: z.number().optional().describe('adjust_hp: shift HP by this amount'),
        reason: z.string().optional().describe('adjust_hp / legendary_resistance (required) / add_condition / remove_condition / legendary_action / use_ability: why — logged'),
        condition: z.any().optional().describe('add_condition / remove_condition: a name ("prone") or {name|type, duration?, durationType?, source?, saveDC?, saveAbility?, level?, ongoing?: {damage: number | dice, damageType?, when: start | end, save?: {ability, dc, onSuccess?: none | half | end}}}; remove also takes the object add_condition returned. For a hold, pass fromGrapple instead of hand-writing the source. ongoing ticks on the bearer\'s turn by its source\'s shape (docs/table-rules/ongoing-damage.md)'),
        conditionId: z.string().optional().describe('remove_condition: one condition instance id'),
        saveRef: z.string().optional().describe(`(mirror) ${LEGENDARY_SAVE_REF_DESCRIBE}`),
        replace: z.boolean().optional().describe('add_condition: drop existing conditions of the same type first'),
        mirrorToCharacter: z.boolean().optional().describe('add_condition / remove_condition: also edit the character sheet'),
        fromGrapple: z.string().optional().describe("add_condition: the holder (participant id or name) — writes source 'grapple: <holder id>' so grapple execute and break recognise the hold"),
        importRowConditions: z.boolean().optional().describe('add_participant: copy the sheet\'s conditions onto the new token'),
        context: tagsField(`add_participant (mirror; on create it is participants[].context): ${INITIATIVE_CONTEXT_DESCRIBE}`),
        band: z.string().optional().describe("add_participant: table-rules power band (defaults from the character row, the creature, else the world's lowest, assumed). set_band: the token's new band, in the world's order"),
        regeneration: z.number().int().min(0).optional().describe('add_participant: HP healed at the start of each of its rounds (defaults from the character row)'),
        revive: z.boolean().optional().describe('adjust_hp: allow raising a dead participant'),
        parts: z.array(PartSchema).optional().describe('add_participant: named parts (defaults from the character row)'),
        // Participant extras (add_participant; create takes them per participant)
        size: SizeCategorySchema.optional().describe('add_participant: tiny | small | medium | large | huge | gargantuan'),
        reach: z.number().optional().describe('add_participant: melee reach in feet'),
        movementSpeed: z.number().optional().describe('add_participant: speed in feet (default 30; defaults from the character row\'s speed)'),
        swimSpeed: z.number().optional().describe('add_participant: swim speed in feet, the movement budget underwater (else half speed)'),
        flySpeed: z.number().optional().describe('add_participant: fly speed in feet'),
        senses: sensesSchema().optional().describe('add_participant: senses in feet {darkvisionFt, blindsightFt, tremorsenseFt, truesightFt} (defaults from the character row); carried on the token and shown in get'),
        attackBonus: z.number().optional().describe('add_participant: default attack bonus'),
        attackDamage: z.string().optional().describe("add_participant: default attack damage ('1d6+2')"),
        attackDamageType: z.string().optional().describe('add_participant: damage type of the default attack'),
        attacksPerAction: z.number().optional().describe('add_participant: multiattack, attacks per Attack action'),
        attacks: z.array(z.any()).optional().describe('add_participant: named attack profiles [{name, attackBonus, damage, damageType?, part?, reachFt?, ranged?, twoHanded?, default?}]'),
        abilities: z.array(z.any()).optional().describe('add_participant: limited abilities [{name, recharge?, perRest?: short | long, grantsAction?, actionCost?, ready?}]; ready unset lets a spent sheet ability stay spent'),
        fightingStyle: FightingStyleSchema.optional().describe('add_participant: great_weapon | dueling | archery | defense (default from the sheet); attacks [{twoHanded?, ranged?}] decide when it applies'),
        ignoreCover: ignoreCoverSchema().optional().describe(`add_participant: ${IGNORE_COVER_DESCRIBE} (default from the sheet)`),
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
        attack: z.any().optional().describe("trigger_readied: {using?, attackBonus?, damage?, damageType?, withPart?, twoHanded?, ranged?: boolean, onSubdue?: 'hold' | 'fire'}, the attack to roll over the stored one (only ranged / onSubdue: amends the stored one)"),
        cost: z.number().optional().describe('legendary_action: legendary actions it costs (default 1)'),
        description: z.string().optional().describe("legendary_action: what the creature does ('wing attack')"),
        suppressed: z.boolean().optional().describe('set_unit'),
        inMelee: z.boolean().optional().describe('set_unit'),
        brokenFormation: z.boolean().optional().describe('set_unit'),
        packed: z.boolean().optional().describe('set_unit'),
        routed: z.boolean().optional().describe('set_unit: routed after a failed break test (no volleys); false rallies'),
        morale: z.number().int().optional().describe('set_unit: the morale shown on BREAK TEST DUE'),
        models: z.number().int().optional().describe('set_unit: reinforce or reduce the unit to this many models (new models add hpPerModel each to HP; fewer clamps HP); result reinforced {modelsBefore, models, added, hp, maxHp}'),
        hpPerModel: z.number().int().optional().describe('set_unit: new HP per model (maximum follows, HP clamped)'),
        intent: z.string().nullable().optional().describe('set_intent: telegraphed intent (null clears); clears when its turn ends'),
        // Lane G2 review: the nested mirror keeps unknown attack keys too, or the SDK strips them before set_intent can name them.
        readied: readiedInputSchema().nullable().optional().describe("set_intent: {action, trigger, on?: enters_reach | leaves_reach, watch?: id | name | 'enemy' | 'any', attack?: {using?, attackBonus?, damage?, damageType?, withPart?, ranged?: boolean, onSubdue?: 'hold' | 'fire'}}; stays until it fires or trigger_readied (null clears). With on and attack it fires itself on a move. ranged is the attack's own lane, over the profile's flag and the grid. Under a subdue order a ranged attack needs onSubdue"),
        isEnemy: z.boolean().optional().describe('Hostile flag (add_participant)'),
        xpAward: z.number().optional().describe('XP credited on end'),
        xpRecipients: z.array(z.string()).optional().describe('XP recipient character IDs'),
        winner: z.string().optional().describe("end (mirror): on a boarding encounter, who won — reported to the parent fight"),
        summary: z.string().optional().describe('end (mirror): on a boarding encounter, one line for the parent fight'),
        attackerId: z.string().optional().describe('board (mirror): the boarding vessel token'),
        rooms: z.array(z.string()).optional().describe("board (mirror): the target's rooms the boarders fight through"),
        round: z.number().optional().describe('Round filter (get_history)'),
        limit: z.number().optional().describe('Max actions returned (get_history) / max rows (list)'),
        status: z.string().optional().describe('FINDINGS #80 (mirror): list filter — active | completed | all (default active, the ghost hunt)'),
        buryGhosts: z.boolean().optional().describe('FINDINGS #80-B (mirror): list — mark every listed ghost completed in this call'),
        confirmBury: z.boolean().optional().describe('FINDINGS #102 (mirror): override the cold-boot guard — required to bury when nothing is in process memory'),
        confirm: z.boolean().optional().describe("advance (mirror): pass the turn of a player character who has used no action, bonus action or movement this turn; without it advance refuses with TURN NOT TAKEN (writes: none)"),
        skipTurn: z.boolean().optional().describe('advance (mirror): alias of confirm'),
        worldId: z.string().optional().describe('FINDINGS #105 (mirror): create — stamp the encounter to a world (else derived from first claimed participant); list — STRICT world filter, scopes the ghost sweep'),
        actionDescription: z.string().optional().describe('Lair action description'),
        targetIds: z.array(z.string()).optional().describe('lair_action / use_ability / apply_damage: target IDs'),
        actorId: z.string().optional().describe("apply_damage: who deals it (token or character id); the band rule's damageScale then applies, and a target it drops to 0 credits the kill to the actor's growth track. Omit for environmental damage"),
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
        damageType: z.string().optional().describe('Damage type (lair_action / use_ability / apply_damage)'),
        savingThrow: z.any().optional().describe(`lair_action / use_ability: {ability, dc}. ${ENGINE_SAVE_DESCRIBE}`),
        halfDamageOnSave: z.boolean().optional().describe('Half damage on save'),
        dice: z.union([z.number(), z.string()]).optional().describe("apply_damage: dice ('6d10') rolled once for every target, or a number"),
        source: z.string().optional().describe("apply_damage: what deals it; logged as 'damage: <source>'"),
        save: z.object({
            ability: z.string(),
            dc: z.number(),
            half: z.boolean().optional(),
            onFail: areaSaveRiderSchema().optional(),
            onSuccess: areaSaveRiderSchema().optional()
        }).optional().describe(`apply_damage: {ability, dc, half? (default true), onFail?: {conditions: ['prone', {name, duration?, source?}], mirrorToCharacter?}, onSuccess?} each target saves; riders land on the targets with that result. ${ENGINE_SAVE_DESCRIBE}`),
        cover: coverByTargetSchema().optional().describe(`apply_damage / use_ability / lair_action / trigger_readied (mirror): ${COVER_BY_TARGET_DESCRIBE}`),
        area: z.boolean().optional().describe(`apply_damage / use_ability / lair_action / add_condition (mirror): ${AREA_DESCRIBE}. A lair action is an area unless area: false; apply_damage and use_ability are when modelsInArea is given. add_condition: the condition's ongoing damage came from an area, so on a unit it ticks per model inside (unset: single target, the most wounded model)`),
        modelsInArea: modelsInAreaSchema().optional().describe(`apply_damage / use_ability / lair_action / add_condition (mirror): ${MODELS_IN_AREA_DESCRIBE}. add_condition: the models inside the area that left the ongoing damage`),
        saves: unitSavesSchema().nullable().optional().describe(`set_unit (mirror): ${UNIT_SAVES_DESCRIBE}. Replaces the block; null clears`),
        wounded: unitWoundedSchema().nullable().optional().describe(`set_unit (mirror): ${UNIT_WOUNDED_DESCRIBE}. [5, 2] sets them (HP moves, the live count kept); [] heals every wound; null drops the list`),
        level: coverEnum().optional().describe('set_cover: half | three-quarters | total | none'),
        subdue: z.boolean().optional().describe("add_participant / set_subdue (mirror; create takes it per participant): play report 7 #5, a standing order 'take them alive' — the token's opportunity attacks and readied melee swings knock out instead of killing. set_subdue: false lifts it"),
        riderId: z.string().optional().describe('mount / dismount (mirror): play report 7 #10, the rider token'),
        mountId: z.string().optional().describe('mount (mirror): the creature ridden — at least one size larger than the rider, within 5 ft'),
        controlled: z.boolean().optional().describe("mount (mirror): true (default) the rider controls it — it moves on the rider's turn with its own speed, its own slot passes, it may only Dash, Disengage or Dodge; false: an independent mount keeps its own turn"),
        free: z.boolean().optional().describe("mount / dismount (mirror): no movement spent and any turn (setting the scene, a GM correction); mid-fight both cost half the rider's speed on its own turn"),
        onSubdue: z.enum(ON_SUBDUE).optional().describe("set_subdue (mirror): the answer for the token's readied ranged shot under the order — 'hold' (no shot; reaction and shot kept) or 'fire' (lethal, 'subdue order overridden')"),
        against: z.any().optional().describe("set_cover: ['id', 'name'] (attackers it protects against) or {direction: 'west'} (attackers in that direction); unset: everyone"),
        // spawn_quick_enemy fields
        creature: z.string().optional().describe('spawn_quick_enemy / add_participant: a world bestiary creature (table_rules kind creature) or built-in template ("goblin", "orc:warrior")'),
        count: z.number().optional().describe('spawn_quick_enemy / add_participant creature: how many (1-10)'),
        position: z.object({ x: z.number(), y: z.number() }).optional().describe('Starting position (add_participant, spawn_quick_enemy); dismount: the free square within 5 ft of the mount the rider steps to')
    })
};

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export async function handleCombatManage(args: unknown, ctx: SessionContext): Promise<McpResponse> {
    try {
        const result = await router(args as Record<string, unknown>, ctx);
        const parsed = JSON.parse(result.content[0].text);

        // Play report 7 #10: after any write, a rider whose mount went down,
        // left, or was knocked prone — or who was knocked prone itself — is
        // settled here (the DEX save to stay mounted rolls on the fight's dice).
        if (!parsed.error && parsed.writes !== 'none' && !['get', 'list', 'budget', 'get_history', 'end'].includes(String(parsed.actionType))) {
            foldSettleIntoReply(parsed, settleMountsAfter(ctx, typeof parsed.encounterId === 'string' ? parsed.encounterId : (args as { encounterId?: string })?.encounterId));
        }

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
                case 'set_cover':
                case 'clear_cover':
                    output = RichFormatter.header('Cover', '🛡');
                    break;
                case 'set_band':
                    output = RichFormatter.header('Band', '🏷');
                    break;
                case 'legendary_action':
                case 'legendary_resistance':
                    output = RichFormatter.header('Legendary', '👑');
                    break;
                case 'use_ability':
                    output = RichFormatter.header('Ability', '✴');
                    break;
                case 'set_surprised':
                    output = RichFormatter.header('Surprise', '😲');
                    break;
                case 'set_subdue':
                    output = RichFormatter.header('Subdue Order', '🤲');
                    break;
                case 'mount':
                case 'dismount':
                    output = RichFormatter.header(parsed.actionType === 'mount' ? 'Mounted' : 'Dismounted', '🐎');
                    break;
                case 'budget':
                    output = RichFormatter.header('Encounter Budget', '⚖️');
                    break;
                case 'board':
                    output = RichFormatter.header('Boarding Action', '🚀');
                    if (parsed.childEncounterId) output += RichFormatter.keyValue({ 'Boarding encounter': `\`${parsed.childEncounterId}\``, 'Void fight': `\`${parsed.parentEncounterId}\`` });
                    break;
                default:
                    output = RichFormatter.header('Combat', '⚔️');
            }

            // Add raw text if present
            if (parsed.rawText) {
                output += '\n' + parsed.rawText + '\n';
                // Play report 7 #2: a banner that prints rawText still shows the
                // keys create dropped (the note rides in message).
                const at = typeof parsed.message === 'string' ? parsed.message.indexOf('Ignored params') : -1;
                if (at >= 0) output += RichFormatter.alert(parsed.message.slice(at), 'warning');
            } else if (parsed.message) {
                output += '\n' + parsed.message + '\n';
            }
            // Play report 7: warnings (a sheet's scores kept, bands assumed) are printed, not only embedded;
            // once: a warning the message already printed (set_subdue's) is not repeated.
            if (Array.isArray(parsed.warnings)) {
                for (const w of parsed.warnings) if (typeof w === 'string' && !output.includes(w)) output += RichFormatter.alert(w, 'warning');
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
