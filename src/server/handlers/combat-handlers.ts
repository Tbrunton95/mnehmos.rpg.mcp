import { z } from 'zod';
import { loadAutoMechanics, autoAttackBonus, autoAcBonus, autoDamageBonus, applyDeclaredEffects } from '../../engine/effects-resolver.js';
import * as pda from '../../render/pda.js';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { CombatEngine, CombatParticipant, CombatState, CombatActionResult, type TurnDamageEvent } from '../../engine/combat/engine.js';
import { normalizeConditions, normalizeCondition, ConditionType, DurationType, stampOngoingShape, type ConditionInput } from '../../engine/combat/conditions.js';
import { ConditionInputSchema, conditionInputSchema, footprintCells, EnvironmentSchema, sizeRank, edgeDistanceSquares, effectiveReachFt } from '../../schema/encounter.js';
import { resolveCover, totalCoverRefusal, ignoreCoverFor, coverArithmetic, saveArithmetic, ignoredCoverLine, canHideReport, coverEnum, coverByTargetSchema, COVER_BY_TARGET_DESCRIBE, type CoverResolution, type IgnoreCoverScopes } from '../../engine/combat/cover.js';
import { applyScheduledOps } from '../../engine/scheduled-ops.js';
import { MANEUVERS, maneuverProblem, maneuverSaveDC, maneuverAbilityMod, dieMax, findSuperiorityPool, menacingUntil, type ManeuverName, type ManeuverDef } from '../../engine/combat/maneuvers.js';
import { SpatialEngine } from '../../engine/spatial/engine.js';

import { PubSub } from '../../engine/pubsub.js';

import { getCombatManager } from '../state/combat-manager.js';
import { getDb } from '../../storage/index.js';
import { EncounterRepository } from '../../storage/repos/encounter.repo.js';
import { SessionContext } from '../types.js';

// CRIT-006: Import spellcasting validation and resolution
import { validateSpellCast, consumeSpellSlot, calculateSpellSaveDC } from '../../engine/magic/spell-validator.js';
import { resolveSpell } from '../../engine/magic/spell-resolver.js';
import { PartSchema, UnitSchema, ParticipantExtrasShape, attackRequiresSchema, type Part, type ReadiedAttack, type Ability } from '../../schema/token-extras.js';
import { READIED_ATTACK_KEYS } from '../../schema/token-extras.js';
import { describeNestedIgnored } from '../../utils/action-router.js';
import { modelsInAreaSchema, MODELS_IN_AREA_DESCRIBE, AREA_DESCRIBE } from '../../schema/token-extras.js';
import { evaluateAttackTrigger, type AttackTriggerFacts } from '../../engine/combat/attack-triggers.js';
import { isKnockedOut, nonlethalSource, stripNonlethalRowConditions, clearNonlethalUnconscious } from '../../engine/combat/nonlethal.js';
import { findActionGrantAcross, patchRowAbility, setAbilityReady } from '../../engine/combat/abilities.js';
import { worldProgression } from '../../engine/progression.js';
import { resolveWorldId, bandOrderFor, bandRuleFor, bandDamageMultiplier, loadRule, loadRules, castingClassFor, findWorldRule, type TableRule, type BandDamageScale } from '../../engine/table-rules.js';
import { castWorldSpell, sheetSpecies } from './world-spell.js';
import { creditKill, growthLine, growthConditionsOnToken } from '../growth.js';
import { peerConsequence, calledStrikeProblem, resolveCalledStrike, crippledPart, preparedOutcome } from '../../engine/combat/table-rules-combat.js';
import { volleyTier, describeUnit, breakTestDue, moraleModifiers, woundLine, setUnitHp, type BreakTest } from '../../engine/combat/units.js';
import { rollUnitArea, unitsNeedingCount, areaCountRefusal, unitCapFor, unitCapLine, unitSavesLine, unitSummaryLine, modelsKilledBetween, liveModels, type ModelsInArea, type UnitAreaReport } from '../../engine/combat/unit-area.js';
import { upsertPart, findPart, resolveAttackSource, holdingPart } from '../../engine/combat/parts.js';
import { compareBands } from '../../engine/table-rules.js';
import { bandAssumedTag, bandsUnranked, setBandCall } from '../../engine/combat/band-default.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { ConcentrationRepository } from '../../storage/repos/concentration.repo.js';
import { CombatActionLogRepository } from '../../storage/repos/combat-action-log.repo.js';
import { startConcentration, checkConcentration, breakConcentration, concentrationAfterDamage } from '../../engine/magic/concentration.js';
import { rollParticipantSave, toLongAbility, saveSidesNote, saveSourcesRow, ENGINE_SAVE_DESCRIBE, type ParticipantSaveResult, type SaveSourcesRow } from '../../engine/combat/saves.js';
import { fightConcentrationDie, concentrationLabelled, concentrationLine, concentrationOutcome, concentrationSourcesRow, engineSaverSides, saveDieLabels, type ConcentrationOutcome } from '../../engine/combat/saves.js';
import { fightConcentrationLegendary, concentrationLegendaryHook, type LegendaryReplyRow } from './legendary-saves.js';
import type { LegendaryOfferRow } from '../../engine/combat/legendary-resistance.js';
import type { Character } from '../../schema/character.js';
import { getPatternGenerator, PATTERN_DESCRIPTIONS } from '../terrain-patterns.js';
import { hydrateExtras, matchPreset, type ExtrasRow } from '../../engine/combat/participant-extras.js';
import { rowTracksDeathSaves, wakeFromDying, isDying, dyingLabel, dyingStatus, counters as deathCounters, deathSaveCall, normalizeDeathSaveOutcome, dyingTail, withDyingRowConditions, stripDyingRowConditions, tracksDeathSaves, applyDyingConditions, type DeathSaveMode, type DyingUpdate, type RowCondition } from '../../engine/combat/dying.js';
import { readWorldEnvironment } from '../../engine/world-clock.js';
import { turnUntouched, turnNotTakenMessage, turnPassedLine, confirmAdvanceCall, onActiveTurn } from '../../engine/combat/turn-guard.js';
import { AgentRepository } from '../../storage/repos/agent.repo.js';
import { readiedSubdueFor, heldReadiedError, heldReadied, onSubdueAnswer, onSubdueAnswerText, readiedSubdueTag, readiedRanged, readiedLaneTag, type ReadiedRangedOverride } from '../../engine/combat/subdue.js';
import { rolledReactionLine, heldFireLine, notStruckDownLine, offeredReactionLine, skippedReactionLine, readiedFlaggedLine, readiedProblemLine, type ReactionTarget } from '../../engine/combat/reaction-lines.js';
import { mountOf, riderOf, nearestMountCell, controlledMountActionRefusal } from '../../engine/combat/mounts.js';
import { resolveAdvantageSources, loadEffectDeclarations, sourcesField, situationalField, tagsField, type DeclaringOwner } from '../../engine/advantage-sources.js';
import { declaredOnRoll, mergeSides, hasSides, ATTACK_SOURCE_NOTE, ATTACK_CONTEXT_DESCRIBE, INITIATIVE_CONTEXT_DESCRIBE, type AttackLane, type DeclaredSides, type InitiativeDeclared, type RollDeclarations } from '../../engine/attack-advantage.js';
import { normTag } from '../../engine/senses.js';

// Global combat state (in-memory for MVP)
let pubsub: PubSub | null = null;

export function setCombatPubSub(instance: PubSub) {
    pubsub = instance;
}

// ============================================================
// HP SYNCHRONIZATION - Sync combat participants with character DB
// ============================================================

/**
 * Sync participant HP from character database.
 * Called before displaying combat state to ensure HP reflects any
 * changes made via character_manage during combat.
 *
 * This implements "database is source of truth" - if character_manage
 * updated HP, we show that value in combat display.
 */
export function syncParticipantHpFromDb(state: CombatState): CombatState {
    const db = getDb();
    const charRepo = new CharacterRepository(db);

    for (const participant of state.participants) {
        const character = charRepo.findById(participant.id);
        if (character) {
            // Play report 5 #5: who tracks death saves is read from the row
            // before every action and advance. An explicit combat_profile
            // flag wins; otherwise pc and npc rows track and the token keeps a
            // flag the GM set on it. The sheet's deathSaveMode comes along.
            const rowFlag = (character as { deathSaves?: boolean }).deathSaves;
            if (typeof rowFlag === 'boolean') participant.deathSaves = rowFlag;
            else if (participant.deathSaves === undefined) participant.deathSaves = rowTracksDeathSaves(character as { characterType?: string });
            const rowMode = (character as { deathSaveMode?: DeathSaveMode }).deathSaveMode;
            if (rowMode) participant.deathSaveMode = rowMode;
            // Sync HP if database value differs (character_manage was used)
            if (character.hp !== participant.hp) {
                // Play report 5 #5: a sheet healed above 0 between calls wakes
                // the dying token (counters and the dying Unconscious go); a
                // sheet put to 0 by hand (update {hp: 0}) drops a tracked token
                // like a blow would: unconscious, prone, counters fresh.
                const rose = participant.hp <= 0 && character.hp > 0;
                if (rose) wakeFromDying(participant);
                else if (participant.hp > 0 && character.hp <= 0 && tracksDeathSaves(participant) && !participant.isDead) {
                    participant.deathSaveSuccesses = 0;
                    participant.deathSaveFailures = 0;
                    participant.isStabilized = false;
                    applyDyingConditions(participant);
                }
                // Lane W: a unit token's pool moves through its models (a drop spreads, a rise heals).
                if (participant.unit) setUnitHp(participant, character.hp);
                else participant.hp = character.hp;
                // Play report 5 #4: a knockout's Unconscious leaves too, so it is no longer "stable at 0" (a sleep spell's stays).
                if (rose && clearNonlethalUnconscious(participant).length) participant.isStabilized = false;
            }
            if (character.maxHp !== participant.maxHp) {
                participant.maxHp = character.maxHp;
            }
            // FINDINGS #25/#26: an omitted participant `ac` silently defaulted
            // to 10 even when the id resolved to a real character — post-un-bake
            // that's a 4-point softness wearing correct-looking output (the
            // resolver's trait line still prints). Fill missing AC from the
            // character row; explicit ac always wins; ad-hoc tokens keep the
            // 10 + dex heuristic.
            if (participant.ac === undefined && character.ac !== undefined) {
                participant.ac = character.ac;
            }
            // Request 5: a vessel's shields are its `shields` pool on the sheet
            // (character_manage adjust_pool between calls is read here).
            const pool = (character as { resourcePools?: Record<string, { current: number; max: number }> }).resourcePools?.shields;
            if (participant.vessel && pool && (participant.shields?.current !== pool.current || participant.shields?.max !== pool.max)) {
                participant.shields = { current: pool.current, max: pool.max };
            }
        }
    }

    return state;
}

/**
 * Request 5: write a vessel token's shields back to its row's `shields`
 * pool. Only a token with shields that is backed by a characters row.
 */
export function persistShieldsToDb(participant: CombatParticipant): boolean {
    if (!participant.vessel || !participant.shields) return false;
    const charRepo = new CharacterRepository(getDb());
    const character = charRepo.findById(participant.id) as (Character & { resourcePools?: Record<string, { current: number; max: number }> }) | null;
    if (!character) return false;
    const pools = { ...(character.resourcePools ?? {}) };
    const prev = pools.shields;
    if (prev && prev.current === participant.shields.current && prev.max === participant.shields.max) return false;
    pools.shields = { ...(prev ?? {}), current: participant.shields.current, max: participant.shields.max };
    charRepo.update(participant.id, { resourcePools: pools } as Partial<Character>);
    return true;
}

/**
 * Write participant HP back to the character database (the reverse of
 * syncParticipantHpFromDb). Lair damage, damage-over-time, opportunity
 * attacks and death-save crits change HP only in the engine; without this
 * the next DB→memory sync reverted them and the characters row never saw
 * them. Only participants backed by a characters row are written.
 */
function persistParticipantHpToDb(state: CombatState): void {
    const charRepo = new CharacterRepository(getDb());
    for (const participant of state.participants) {
        const character = charRepo.findById(participant.id);
        if (character && (character.hp !== participant.hp || character.maxHp !== participant.maxHp)) {
            charRepo.update(participant.id, { hp: participant.hp, maxHp: participant.maxHp });
        }
        if (character) persistShieldsToDb(participant);
    }
}

/**
 * Save encounter state from a handler that can change HP. Such handlers must
 * call syncParticipantHpFromDb first, so an HP change made through
 * character_manage between calls is read before this writes memory back.
 */
export function saveEncounterState(repo: EncounterRepository, encounterId: string, state: CombatState): void {
    persistParticipantHpToDb(state);
    repo.saveState(encounterId, state);
}

/**
 * Play report 5 #5: a tracked token dropped to 0 marks its sheet dying
 * (Unconscious + Prone, source 'dying') so the status block, the next sync
 * and the next fight read it. False when the token has no character row.
 */
export function markRowDying(characterId: string): boolean {
    const repo = new CharacterRepository(getDb());
    const row = repo.findById(characterId);
    if (!row) return false;
    const next = withDyingRowConditions(row.conditions as RowCondition[] | undefined);
    if (next.added.length) repo.update(characterId, { conditions: next.conditions } as never);
    return true;
}

/** Play report 5 #5: healing above 0 takes the dying rules' conditions off the sheet; returns the names removed. */
export function clearDyingOnRow(characterId: string): string[] {
    const repo = new CharacterRepository(getDb());
    const row = repo.findById(characterId);
    if (!row) return [];
    const next = stripDyingRowConditions(row.conditions as RowCondition[] | undefined);
    if (next.removed.length) repo.update(characterId, { conditions: next.conditions } as never);
    return next.removed;
}

/** What settleDeath reports: the kill that ran on the sheet (or why it could not). */
export interface KilledRecord { participantId: string; name: string; cause: string; corpseId?: string; error?: string }

/**
 * Play report 5 #5: a tracked participant has died (third failed death save,
 * massive damage). Run the existing kill on its character row — HP 0,
 * concentration ended, a corpse — and report it plainly. A token with no
 * row has no sheet to kill: it is simply dead on the encounter.
 */
export async function settleDeath(p: { id: string; name: string }, cause: string, encounterId?: string): Promise<KilledRecord | undefined> {
    const row = new CharacterRepository(getDb()).findById(p.id);
    if (!row) return undefined;
    const { handleKill } = await import('../consolidated/character-manage.js');
    const k = await handleKill({ action: 'kill', characterId: p.id, cause, ...(encounterId ? { encounterId } : {}) }) as Record<string, unknown>;
    if (k.error) return { participantId: p.id, name: p.name, cause, error: String(k.message ?? 'kill failed') };
    return { participantId: p.id, name: p.name, cause, ...(typeof k.corpseId === 'string' ? { corpseId: k.corpseId } : {}) };
}

/** The deaths an area effect caused among tracked tokens, settled in order (resolveAreaSave is synchronous; the kill is not). */
export async function settleAreaDeaths(encounterId: string, state: CombatState, targets: AreaSaveTarget[], cause: string): Promise<KilledRecord[]> {
    const killed: KilledRecord[] = [];
    for (const t of targets) {
        if (!t.dying?.dead) continue;
        const p = state.participants.find(x => x.id === t.targetId);
        if (!p) continue;
        const k = await settleDeath(p, `${cause} (${t.dying.instantDeath ? 'massive damage' : 'third failed death save'})`, encounterId);
        if (k) killed.push(k);
    }
    return killed;
}

/**
 * Play report 7 follow-up (lane O): what the damage a turn's start or end
 * dealt by itself (water pressure, ongoing damage; engine.turnDamage) owes.
 * Call it in the same call as the engine's turn processing, on the same
 * state, before anything else writes HP: a unit's count before the ticks is
 * read back through this process's writes (lane W).
 *  - a break test for each unit the ticks carried through its breakAt, one
 *    per unit, from its HP before its first tick to now, with its morale terms;
 *  - unitLines (output_mode summary keeps them), the break test named;
 *  - a concentrating creature's CON save (a tick is damage; 0 HP ends it),
 *    on the fight's dice with its declared sides (lane H), on the row too;
 *  - a tracked creature a tick dropped is marked dying on its sheet; one it
 *    killed (massive damage, a third failure at 0) is killed with a corpse,
 *    as a death save's death is settled.
 * `lines` carries the concentration and break test lines (the caller prints
 * the killed with its own). Nothing when no tick landed.
 */
export async function settleTurnDamage(engine: CombatEngine, encounterId: string): Promise<{ turnDamage?: TurnDamageEvent[]; breakTests?: BreakTest[]; unitLines?: string[]; killed: KilledRecord[]; lines: string[] }> {
    const events = engine.turnDamage;
    const state = engine.getState();
    if (!events.length || !state) return { killed: [], lines: [] };
    const db = getDb();
    const breakTests: BreakTest[] = [];
    const lines: string[] = [];
    // A tick is damage: concentration holds or breaks on it, as on every road that deals damage.
    const concentrationRepo = new ConcentrationRepository(db);
    const charRepo = new CharacterRepository(db);
    for (const ev of events) {
        const dropped = ev.hpBefore > 0 && ev.hpAfter <= 0;
        if (ev.damage <= 0 && !dropped) continue;
        // Lane K's rule on this road too: a failed save spends a legendary resistance
        // (the spell holds) or offers one, reversible with saveRef; the offer joins
        // the engine's legendaryOffers, which every caller of this function replies.
        const rows: LegendaryReplyRow[] = [];
        const c = concentrationAfterDamage(ev.participantId, ev.damage, dropped, fightConcentrationDie(engine, db, ev.participantId), concentrationRepo, charRepo, 0,
            concentrationLegendaryHook(db, ev.participantId, rows, { engine, encounterId }));
        for (const row of rows) if (row.saveRef && row.kind !== 'aura') engine.legendaryOffers.push(row as LegendaryOfferRow);
        if (!c) continue;
        ev.concentration = c;
        ev.line += `\n   ${concentrationLine(c)}`;
        lines.push(`🧠 ${ev.name}: ${concentrationLine(c, '      ')}`);
    }
    // Lane O review: those CON saves rolled on the fight's dice after the
    // caller's getState(); take it again so the stored RNG position counts
    // them (the callers save this same state object). Without it the next
    // call, reloaded from the row, drew the concentration die a second time.
    engine.getState();
    const firstHp = new Map<string, number>();
    for (const ev of events) if (!firstHp.has(ev.participantId)) firstHp.set(ev.participantId, ev.hpBefore);
    const breakFor = new Map<string, BreakTest>();
    for (const [id, hpBefore] of firstHp) {
        const p = state.participants.find(x => x.id === id);
        if (!p?.unit || p.hp >= hpBefore) continue;
        const bt = breakTestDue(p, hpBefore, { moraleBonus: moraleModifiers(p, state.participants, sheetSpecies(db)) });
        if (bt) { breakTests.push(bt); breakFor.set(id, bt); lines.push(`⚠️ ${bt.line}`); }
    }
    // One line per unit tick; the unit's last tick names the break test it owes.
    const lastUnitTick = new Map<string, TurnDamageEvent>();
    for (const ev of events) if (ev.unitLine) lastUnitTick.set(ev.participantId, ev);
    const unitLines = events.filter(ev => ev.unitLine).map(ev => unitSummaryLine(ev.name, { line: ev.unitLine! }, lastUnitTick.get(ev.participantId) === ev ? breakFor.get(ev.participantId) : undefined));
    const killed: KilledRecord[] = [];
    for (const ev of events) {
        if (ev.dying?.dropped) markRowDying(ev.participantId);
        if (!ev.dying?.dead) continue;
        const cause = `${ev.source === 'pressure' ? `water pressure` : ev.condition ?? 'ongoing damage'} (${ev.dying.instantDeath ? 'massive damage' : 'third failed death save'})`;
        const k = await settleDeath({ id: ev.participantId, name: ev.name }, cause, encounterId);
        if (k) killed.push(k);
    }
    return {
        turnDamage: events,
        ...(breakTests.length ? { breakTests } : {}),
        ...(unitLines.length ? { unitLines } : {}),
        killed, lines
    };
}

/** One line per settled death for a banner. */
export function killedLines(killed: KilledRecord[]): string[] {
    return killed.map(k => k.error ? `☠ ${k.name} is dead (${k.cause}) — the sheet kill failed: ${k.error}` : `☠ ${k.name} is dead (${k.cause})${k.corpseId ? ` — corpse ${k.corpseId.slice(0, 8)}` : ''}`);
}

/**
 * Play report 5 #5: what an attack result's dying track owes the sheet. A
 * drop to 0 mirrors Unconscious + Prone (source dying) to the row; a death
 * runs the kill (cause, corpse). Shared by the attack handler, the readied
 * and opportunity attacks a move fires, and trigger_readied, so every blow
 * that reaches a tracked token through executeAttack follows through.
 * Returns the kill record when one ran and the lines to print.
 */
export async function settleAttackDying(result: Pick<CombatActionResult, 'dying'>, target: CombatParticipant, actorName: string, encounterId: string): Promise<{ killed?: KilledRecord; lines: string[] }> {
    const lines: string[] = [];
    const dying = result.dying;
    if (!dying) return { lines };
    if (dying.dropped) markRowDying(target.id);
    let killed: KilledRecord | undefined;
    if (dying.dead) {
        killed = await settleDeath(target, dying.instantDeath ? `massive damage from ${actorName}` : `hit while dying by ${actorName} (third failed death save)`, encounterId);
        if (killed) lines.push(...killedLines([killed]));
    } else if (dying.failuresAdded) {
        lines.push(`🩸 ${target.name} hit while down: +${dying.failuresAdded} failed death save${dying.failuresAdded > 1 ? 's' : ''} → ${dyingLabel(target)}`);
    } else if (dying.dropped) {
        lines.push(`🩸 ${target.name} drops: ${dyingLabel(target)} — unconscious and prone; death saves on its turns (or stabilize it: combat_action stabilize {actorId, targetId: '${target.id}'})`);
    }
    return { killed, lines };
}

/**
 * Play report 7 #5: what a knockout from an automatic swing (an opportunity
 * attack, a readied attack, trigger_readied) owes the sheet and the reply:
 * the knockout's Unconscious (sourced 'nonlethal: <actor>', the key every
 * wake-up lane reads) mirrored to the target's row, and the 💤 line. Nothing
 * when the blow did not knock out. No kill and no corpse follow a knockout.
 */
export function settleKnockout(result: Pick<CombatActionResult, 'knockedOut'>, target: { id: string; name: string }, actor: { id: string; name: string }): string[] {
    if (!result.knockedOut) return [];
    mirrorConditionToRow(target.id, 'add', 'Unconscious', undefined, nonlethalSource(actor.id));
    return [`💤 ${target.name} knocked out by ${actor.name} (stable; no death saves, no kill, no corpse). Healing above 0 wakes them`];
}

function unitView(p: CombatParticipant) {
    const t = volleyTier(p);
    return { liveModels: t?.models ?? 0, volley: t?.dice ?? null, volleyReason: t?.reason, wounds: woundLine(p) };
}

/** Lane W: the unit as the state view shows it: the wound line in place of the per-model list (a big unit stays short). */
function unitStateView(p: CombatParticipant) {
    const { wounded: _wounded, ...unit } = p.unit!;
    return { ...unit, ...unitView(p) };
}

/** True when the id is a character row (tokens without one have nothing to mirror). */
function charRepoFor(id: string): boolean {
    return !!new CharacterRepository(getDb()).findById(id);
}

/** Item 17: an equipped inventory row in the armor slot (a shield is not armour). */
function wearsArmour(db: Database.Database, characterId: string): boolean {
    try {
        return !!db.prepare("SELECT 1 FROM inventory_items ii JOIN items i ON i.id = ii.item_id WHERE ii.character_id = ? AND ii.equipped = 1 AND ii.slot = 'armor' AND ii.quantity > 0 LIMIT 1").get(characterId);
    } catch { return false; }
}

/** Item 17: an equipped weapon in the offhand slot (a shield is armour, not a weapon). */
function wieldsOffhandWeapon(db: Database.Database, characterId: string): boolean {
    try {
        return !!db.prepare("SELECT 1 FROM inventory_items ii JOIN items i ON i.id = ii.item_id WHERE ii.character_id = ? AND ii.equipped = 1 AND ii.slot = 'offhand' AND ii.quantity > 0 AND LOWER(i.type) = 'weapon' LIMIT 1").get(characterId);
    } catch { return false; }
}

/**
 * Item 16: what a failed manoeuvre save does to the target token. Prone and
 * frightened land on the token only (the spell-debuff precedent); the fright
 * carries metadata the engine sweeps at the end of the attacker's next turn.
 * Disarming empties the held item from the part's holds, drops it as a prop
 * at the target's feet and mirrors the parts to the sheet when there is one.
 */
function applyManeuverEffect(engine: CombatEngine, def: ManeuverDef, actor: CombatParticipant, target: CombatParticipant, item?: string): Record<string, unknown> {
    const state = engine.getState()!;
    switch (def.effect) {
        case 'prone':
            if (!target.conditions.some(c => c.type === ConditionType.PRONE)) {
                engine.applyCondition(target.id, { type: ConditionType.PRONE, durationType: DurationType.PERMANENT, sourceId: actor.id });
            }
            return { condition: 'prone' };
        case 'frightened': {
            // The same attacker's fright is replaced, never stacked.
            target.conditions = target.conditions.filter(c => !(c.type === ConditionType.FRIGHTENED && c.sourceId === actor.id));
            const afterRound = menacingUntil(state, actor.id);
            engine.applyCondition(target.id, { type: ConditionType.FRIGHTENED, durationType: DurationType.PERMANENT, sourceId: actor.id, metadata: { endsAtEndOfTurnOf: actor.id, afterRound } });
            return { condition: 'frightened', untilEndOfTurnOf: actor.id, afterRound };
        }
        case 'disarm': {
            const part = item ? holdingPart(target, item) : (target.parts ?? []).find(p => p.holds?.length);
            if (!part?.holds?.length) {
                const held = (target.parts ?? []).flatMap(p => p.holds ?? []);
                return { dropped: null, note: item && held.length ? `${target.name} holds no '${item}' (holds: ${held.join(', ')}); the GM names what falls` : `nothing recorded in ${target.name}'s holds; the GM names what falls` };
            }
            const key = (item ?? part.holds[0]).trim().toLowerCase();
            const dropped = part.holds.find(h => h.trim().toLowerCase() === key) ?? part.holds[0];
            target.parts = upsertPart(target.parts ?? [], { name: part.name, holds: part.holds.filter(h => h !== dropped) });
            const position = target.position ? `${target.position.x},${target.position.y}` : '0,0';
            state.props = [...(state.props ?? []), { id: `prop-${randomUUID().slice(0, 8)}`, position, label: dropped, propType: 'interactive', description: `dropped by ${target.name} (disarmed by ${actor.name})` }];
            if (charRepoFor(target.id)) new CharacterRepository(getDb()).update(target.id, { parts: target.parts } as never);
            const droppedKey = dropped.trim().toLowerCase();
            const profilesAffected = (target.attacks ?? []).filter(a => [a.item, a.name].some(x => x && x.trim().toLowerCase() === droppedKey)).map(a => a.name);
            return { dropped, part: part.name, profilesAffected, prop: position };
        }
        default:
            return {};
    }
}

/**
 * Play report 5, item 4: remove a knockout's Unconscious (source 'nonlethal: …')
 * from the character row, leaving every other condition. False when the row
 * is missing or carried none.
 */
export function clearNonlethalOnRow(characterId: string): boolean {
    const repo = new CharacterRepository(getDb());
    const row = repo.findById(characterId);
    if (!row) return false;
    const stripped = stripNonlethalRowConditions((row.conditions ?? []) as Array<{ name: string; source?: string }>);
    if (!stripped.removed.length) return false;
    repo.update(characterId, { conditions: stripped.conditions } as never);
    return true;
}

/** Play report 5: one line for the trigger a bonus attack met ('dashed, 25 ft after it'). */
function triggerText(t: AttackTriggerFacts): string {
    return [
        t.dashed !== undefined ? (t.dashed ? 'dashed' : 'no dash') : '',
        t.movedFt !== undefined ? `${t.movedFt} ft${t.dashed !== undefined ? ' after it' : ''}${t.movedSource === 'declared' ? ' (declared)' : ''}${t.declaredMovedFtIgnored !== undefined ? ` (grid; movedFt ${t.declaredMovedFtIgnored} declared not used)` : ''}` : '',
        t.hitThisTurn !== undefined ? (t.hitThisTurn ? 'after a melee hit' : 'no melee hit') : ''
    ].filter(Boolean).join(', ');
}

/**
 * Mirror a token condition onto the character row (add replaces any same-named
 * entry). False when the token has no character row.
 */
export function mirrorConditionToRow(characterId: string, op: 'add' | 'remove', name: string, duration?: number, source?: string): boolean {
    const repo = new CharacterRepository(getDb());
    const row = repo.findById(characterId);
    if (!row) return false;
    const key = name.toLowerCase();
    const others = (row.conditions ?? []).filter((c: { name: string }) => c.name.toLowerCase() !== key);
    const next = op === 'add'
        ? [...others, { name, ...(duration !== undefined ? { duration } : {}), ...(source !== undefined ? { source } : {}) }]
        : others;
    repo.update(characterId, { conditions: next } as never);
    return true;
}

/**
 * Patch a character's token in every active encounter: the stored rows and
 * any engine held in memory. The patcher returns whether it changed the
 * token; an encounter whose copies it left alone is reported in unpatched
 * (one patched copy is enough to count the encounter as patched).
 */
export function patchLiveTokens(characterId: string, patcher: (tok: Record<string, unknown>) => boolean): { patched: string[]; unpatched: string[] } {
    const patched = new Set<string>();
    const seen = new Set<string>();
    const db = getDb();
    try {
        const rows = db.prepare("SELECT id, tokens FROM encounters WHERE status = 'active' AND tokens LIKE ?").all(`%"${characterId}"%`) as Array<{ id: string; tokens: string }>;
        const upd = db.prepare('UPDATE encounters SET tokens = ?, updated_at = ? WHERE id = ?');
        for (const r of rows) {
            const tokens = JSON.parse(r.tokens) as Array<Record<string, unknown>>;
            const tok = tokens.find(t => t.id === characterId);
            if (!tok) continue;
            seen.add(r.id);
            if (!patcher(tok)) continue;
            upd.run(JSON.stringify(tokens), new Date().toISOString(), r.id);
            patched.add(r.id);
        }
    } catch { /* no encounters table */ }
    const manager = getCombatManager();
    for (const key of manager.list()) {
        const tok = manager.get(key)?.getState()?.participants.find(p => p.id === characterId) as unknown as Record<string, unknown> | undefined;
        if (!tok) continue;
        const id = key.slice(key.indexOf(':') + 1);
        seen.add(id);
        if (patcher(tok)) patched.add(id);
    }
    return { patched: [...patched], unpatched: [...seen].filter(id => !patched.has(id)) };
}

/**
 * Item 2: a sheet change that reshapes a creature (a form taken or put down)
 * reaches its tokens in every active encounter. A field given as undefined
 * is removed from the token. Returns the encounter ids patched.
 */
export function pushSheetToLiveTokens(characterId: string, tokenFields: Record<string, unknown>): string[] {
    return patchLiveTokens(characterId, tok => {
        for (const [k, v] of Object.entries(tokenFields)) {
            if (v === undefined) delete tok[k];
            else tok[k] = JSON.parse(JSON.stringify(v));
        }
        return true;
    }).patched;
}

/**
 * Play report 2 (item 15): one ability's ready flag, by name, onto the
 * character's live tokens. Token-only abilities are never touched; an
 * encounter whose token lacks every named ability is listed separately.
 */
export function pushAbilityStateToLiveTokens(characterId: string, states: Array<{ name: string; ready: boolean }>): { liveTokens: string[]; tokensWithoutAbility: string[] } {
    const result = patchLiveTokens(characterId, tok => {
        const abilities = Array.isArray(tok.abilities) ? tok.abilities as Ability[] : undefined;
        let changed = false;
        for (const s of states) if (setAbilityReady(abilities, s.name, s.ready)) changed = true;
        return changed;
    });
    return { liveTokens: result.patched, tokensWithoutAbility: result.unpatched };
}

/**
 * The encounter's live engine: from process memory, or rehydrated from the
 * database (after a restart or eviction) and registered. null when the
 * encounter exists in neither.
 */
export function getOrLoadEngine(ctx: SessionContext, encounterId: string): CombatEngine | null {
    const key = `${ctx.sessionId}:${encounterId}`;
    const live = getCombatManager().get(key);
    if (live) return live;
    const persisted = new EncounterRepository(getDb()).loadState(encounterId);
    if (!persisted) return null;
    const engine = new CombatEngine(encounterId, pubsub || undefined);
    engine.loadState(persisted);
    getCombatManager().create(key, engine);
    return engine;
}

/**
 * The active encounter holding a token with this exact id, if any. The
 * routing rule apply_damage and grapple share: a character with a live
 * token is acted on through its fight.
 */
export function liveEncounterFor(db: ReturnType<typeof getDb>, id: string): string | undefined {
    try {
        const rows = db.prepare("SELECT id, tokens FROM encounters WHERE status = 'active' AND tokens LIKE ?").all(`%"${id}"%`) as Array<{ id: string; tokens: string }>;
        return rows.find(r => (JSON.parse(r.tokens) as Array<{ id: string }>).some(t => t.id === id))?.id;
    } catch { return undefined; }
}

// ============================================================
// FORMATTING - Both human-readable AND machine-readable
// ============================================================

/**
 * Build a machine-readable state object for frontend sync
 */
export function buildStateJson(state: CombatState, encounterId: string, sessionId?: string) {
    const currentParticipant = state.participants.find(
        (p) => p.id === state.turnOrder[state.currentTurnIndex]
    );

    return {
        encounterId,
        sessionId, // Include sessionId in response
        round: state.round,
        currentTurnIndex: state.currentTurnIndex,
        currentTurn: currentParticipant ? {
            id: currentParticipant.id,
            name: currentParticipant.name,
            isEnemy: currentParticipant.isEnemy
        } : null,
        turnOrder: state.turnOrder.map(id => {
            const p = state.participants.find(part => part.id === id);
            return p?.name || id;
        }),
        participants: state.participants.map(p => ({
            id: p.id,
            name: p.name,
            hp: p.hp,
            maxHp: p.maxHp,
            initiative: p.initiative,
            isEnemy: p.isEnemy,
            conditions: p.conditions.map(c => c.type),
            isDefeated: p.hp <= 0,
            // Play report 5: down from a non-lethal blow — stable, no death saves, wakes on healing.
            ...(isKnockedOut(p) ? { knockedOut: true, stable: true } : {}),
            isCurrentTurn: p.id === currentParticipant?.id,
            // Spatial visualization data
            position: p.position ?? null,
            size: p.size ?? 'medium',
            movementSpeed: p.movementSpeed ?? 30,
            movementRemaining: p.movementRemaining ?? (p.movementSpeed ?? 30),
            // Combat stats for frontend/auto-calc
            ac: p.ac,
            attackDamage: p.attackDamage,
            attackBonus: p.attackBonus,
            ...(p.attacks?.length ? { attacks: p.attacks } : {}),
            ...(p.abilities?.length ? { abilities: p.abilities } : {}),
            ...((p.attacksPerAction ?? 1) > 1 ? { attacksPerAction: p.attacksPerAction, attacksMade: p.attacksMade ?? 0 } : {}),
            // Action economy the GM reads mid-turn: banked extra actions (Action Surge) and dashes taken.
            ...((p.extraActions ?? 0) > 0 ? { extraActions: p.extraActions } : {}),
            ...((p.dashes ?? 0) > 0 ? { dashes: p.dashes } : {}),
            ...(p.surprised ? { surprised: true } : {}),
            ...(p.legendaryActions ? { legendaryActions: p.legendaryActions, legendaryActionsRemaining: p.legendaryActionsRemaining ?? 0 } : {}),
            ...(p.legendaryResistances ? { legendaryResistances: p.legendaryResistances, legendaryResistancesRemaining: p.legendaryResistancesRemaining ?? 0 } : {}),
            // Table state the GM reads each round
            ...(p.band ? { band: p.band } : {}),
            ...(p.band && p.bandAssumed ? { bandAssumed: true } : {}),
            ...(p.regeneration ? { regeneration: p.regeneration } : {}),
            ...(p.cr !== undefined ? { cr: p.cr } : {}),
            ...(p.species ? { species: p.species } : {}),
            ...(p.senses ? { senses: p.senses } : {}),
            ...(p.buffs?.length ? { buffs: p.buffs } : {}),
            ...(p.parts?.length ? { parts: p.parts } : {}),
            ...(p.unit ? { unit: unitStateView(p) } : {}),
            ...(p.intent ? { intent: p.intent } : {}),
            ...(p.readied ? { readied: p.readied } : {}),
            // Play report 7 #5: the standing order 'take them alive'.
            ...(p.subdue ? { subdue: true } : {}),
            // Play report 7 #10: rider and mount.
            ...(p.mountedOn ? { mountedOn: p.mountedOn } : {}),
            ...(p.riderId ? { riderId: p.riderId, controlled: p.controlledBy === p.riderId } : {}),
            // Play report 5 #1: standing cover and who this token could hide from (a report, never a roll).
            ...(p.cover ? { cover: p.cover, ...(p.coverBrokenRound === state.round ? { coverBrokenRound: p.coverBrokenRound } : {}) } : {}),
            ...((hide => hide.length ? { canHide: hide } : {})(canHideReport(state, p))),
            // Play report 5 #5: the dying track of a tracked token (dying → stable → dead).
            ...(dyingStatus(p) ? { deathSaves: { ...deathCounters(p), status: dyingStatus(p), label: dyingLabel(p) } } : {}),
            ...(p.isDead ? { isDead: true } : {}),
            ...(p.isStabilized && p.hp <= 0 ? { isStabilized: true } : {}),
            ...(p.deathSaveDue ? { deathSaveDue: true } : {}),
            // A save made by hand before the slot: it is the slot's save, the engine rolls no second one.
            ...(p.deathSaveTaken ? { deathSaveTaken: true } : {})
        })),
        // HIGH-006: Lair action status
        isLairActionPending: state.turnOrder[state.currentTurnIndex] === 'LAIR',
        hasLairActions: state.hasLairActions ?? false,
        lairOwnerId: state.lairOwnerId,
        // Spatial visualization data
        terrain: state.terrain ?? { obstacles: [], difficultTerrain: [], water: [] },
        // The medium the fight happens in (only when set: air is the default)
        ...(state.environment ? { environment: state.environment } : {}),
        props: state.props ?? [],
        gridBounds: state.gridBounds ?? null
    };
}

/** Play report 7 #9: one turn-order slot as the create reply lists it. */
export interface InitiativeRow {
    id: string;
    name: string;
    roll: number;
    modifier?: number;
    /** The d20 (roll - modifier); absent when the initiative was given. */
    natural?: number;
    given?: true;
    surprised?: true;
    lair?: true;
    /** Play report 7 #7 (lane F): the declared sources this roll took, and both d20s when two were rolled (natural is the kept one). */
    advantage?: string[];
    disadvantage?: string[];
    rolls?: number[];
}

/**
 * Play report 7 #9: the order the fight runs in, one row per slot (LAIR at
 * 20). given marks a caller's pre-rolled initiative (no natural die); a
 * surprised slot is marked even after its first turn has passed.
 */
export function initiativeRows(state: CombatState, opts: { given?: Set<string>; surprised?: Set<string>; ids?: string[]; declared?: Map<string, InitiativeDeclared> } = {}): InitiativeRow[] {
    const slots = opts.ids ?? state.turnOrder;
    return slots.map(id => {
        if (id === 'LAIR') return { id: 'LAIR', name: 'LAIR', roll: 20, lair: true as const };
        const p = state.participants.find(x => x.id === id);
        const roll = p?.initiative ?? 0;
        const modifier = p?.initiativeBonus ?? 0;
        const given = opts.given?.has(id);
        const declared = given ? undefined : opts.declared?.get(id);
        return {
            id, name: p?.name ?? id, roll, modifier,
            ...(given ? { given: true as const } : { natural: roll - modifier }),
            ...(opts.surprised?.has(id) ? { surprised: true as const } : {}),
            ...(declared?.advantage?.length ? { advantage: declared.advantage } : {}),
            ...(declared?.disadvantage?.length ? { disadvantage: declared.disadvantage } : {}),
            ...(declared?.rolls?.length ? { rolls: declared.rolls } : {})
        };
    });
}

/** Play report 7 #9: who acts first, after any surprised skip. */
export function firstUpOf(state: CombatState): { id: string; name: string; roll: number } | null {
    const id = state.turnOrder[state.currentTurnIndex];
    if (!id) return null;
    if (id === 'LAIR') return { id: 'LAIR', name: 'LAIR', roll: 20 };
    const p = state.participants.find(x => x.id === id);
    return p ? { id: p.id, name: p.name, roll: p.initiative ?? 0 } : null;
}

/** Play report 7 #9: the banner line the GM reads the order from. */
export function initiativeBannerLine(rows: InitiativeRow[], firstUp: { name: string } | null): string {
    const tag = (r: InitiativeRow) => {
        // Play report 7 #7 (lane F): a declared source on the roll (the row names it).
        const declared = r.advantage?.length && r.disadvantage?.length ? 'advantage and disadvantage cancel' : r.advantage?.length ? 'advantage' : r.disadvantage?.length ? 'disadvantage' : '';
        const marks = [r.given ? 'given' : '', r.surprised ? 'surprised' : '', declared].filter(Boolean);
        return marks.length ? ` (${marks.join(', ')})` : '';
    };
    return `🎲 Initiative: ${rows.map(r => `${r.name} ${r.roll}${tag(r)}`).join(' · ')}${firstUp ? ` — FIRST UP: ${firstUp.name}` : ''}. Tell the table the order before resolving the first turn.`;
}

/**
 * Format combat state for human reading in chat
 */
function formatCombatStateText(state: CombatState, encounterId?: string): string {
    const currentParticipant = state.participants.find(
        (p) => p.id === state.turnOrder[state.currentTurnIndex]
    );

    const isEnemy = currentParticipant?.isEnemy ?? false;
    const lairUp = state.turnOrder[state.currentTurnIndex] === 'LAIR';
    const lairOwner = state.participants.find(p => p.id === state.lairOwnerId);

    // Header with round info
    const turnIcon = lairUp ? '🏰' : isEnemy ? '👹' : '⚔️';
    let output = `\n┌─────────────────────────────────────────┐\n`;
    output += `│ ${turnIcon} ROUND ${state.round} — ${lairUp ? 'LAIR (initiative 20)' : `${currentParticipant?.name}'s Turn`}\n`;
    // The medium, as the PDA glyph token: ⟨water · 40 ft⟩ (nothing for air).
    const medium = pda.environmentGlyph(state.environment);
    if (medium) output += `│ ${medium}\n`;
    output += `└─────────────────────────────────────────┘\n\n`;

    // Initiative order with clear formatting
    output += `📋 INITIATIVE ORDER\n`;
    output += `───────────────────────────────────────────\n`;
    
    state.turnOrder.forEach((id: string, index: number) => {
        if (id === 'LAIR') {
            const used = lairOwner?.lairUsedRound === state.round;
            output += `${index === state.currentTurnIndex ? '▶' : ' '} 🏰 ${'LAIR (init 20)'.padEnd(18)} ${lairOwner ? `owner: ${lairOwner.name}` : ''}${lairOwner && lairOwner.hp <= 0 ? ' (dead: skipped)' : used ? ' (used this round)' : ''}\n`;
            return;
        }
        const p = state.participants.find((part) => part.id === id);
        if (!p) return;

        const isCurrent = index === state.currentTurnIndex;
        const icon = p.isEnemy ? '👹' : '🧙';
        const hpPct = p.maxHp > 0 ? (p.hp / p.maxHp) * 100 : 0;
        const hpBar = createHpBar(hpPct);
        const marker = isCurrent ? '▶' : ' ';
        // Play report 5 #4/#5: a knockout reads as such; a tracked token at 0 shows its track; a mook is defeated.
        const dyingState = dyingStatus(p);
        const status = p.hp <= 0
            ? (isKnockedOut(p) ? '💤 KNOCKED OUT (stable)' : dyingState === 'dead' ? '☠ DEAD' : dyingState === 'stable' ? '💤 STABLE' : dyingState === 'dying' ? `🩸 ${dyingLabel(p)}${p.deathSaveDue ? ' — DEATH SAVE DUE' : ''}` : '💀 DEFEATED')
            : p.surprised ? '😲 surprised' : '';
        
        // Include ID for LLM targeting
        output += `${marker} ${icon} ${p.name.padEnd(18)} ${hpBar} ${p.hp}/${p.maxHp} HP  [Init: ${p.initiative}] ID: ${p.id} ${status}\n`;
        if (p.unit) output += `      🪖 ${describeUnit(p)}\n`;
        // Play report 7 #3: an assumed band shows until someone sets it.
        if (p.band && p.bandAssumed) output += `      🏷 band ${p.band} (assumed): combat_manage set_band if it is stronger\n`;
        const counters = [
            p.legendaryActions ? `LA ${p.legendaryActionsRemaining ?? 0}/${p.legendaryActions}` : '',
            p.legendaryResistances ? `LR ${p.legendaryResistancesRemaining ?? 0}/${p.legendaryResistances}` : '',
            (p.attacksPerAction ?? 1) > 1 ? `attacks ${p.attacksMade ?? 0}/${p.attacksPerAction}` : '',
            (p.extraActions ?? 0) > 0 ? `⚡ extra actions ${p.extraActions}` : '',
            (p.dashes ?? 0) > 1 ? `dashes ${p.dashes}` : ''
        ].filter(Boolean);
        if (counters.length) output += `      👑 ${counters.join(' · ')}\n`;
        if (p.abilities?.length) output += `      ✴ abilities: ${p.abilities.map(a => `${a.grantsAction ? '⚡ ' : ''}${a.name}${a.recharge ? ` (recharge ${a.recharge}${a.recharge < 6 ? '-6' : ''})` : ''}${a.actionCost === 'bonus' ? ' [bonus]' : a.actionCost === 'none' || (a.grantsAction && !a.actionCost) ? ' [free]' : a.actionCost === 'reaction' ? ' [reaction]' : ''}${a.perRest ? ` [${a.perRest} rest]` : ''}${a.ready === false ? ' SPENT' : ''}`).join(', ')}\n`;
        if (p.attacks?.length) output += `      🗡 attacks: ${p.attacks.map(a => `${a.name} ${a.attackBonus >= 0 ? '+' : ''}${a.attackBonus}`).join(', ')}\n`;
        // Hurt parts, and armoured ones (own ac, hp or breakAt) even when intact.
        const hurt = (p.parts ?? []).filter(pt => pt.state !== 'intact' || pt.ac !== undefined || pt.hp !== undefined || pt.breakAt !== undefined);
        const armour = (pt: Part) => `${pt.ac !== undefined ? ` AC ${pt.ac}` : ''}${pt.hp !== undefined ? ` ${pt.hp}/${pt.maxHp ?? pt.hp} HP` : ''}${pt.breakAt !== undefined ? ` breaks at ${pt.breakAt}` : ''}`;
        if (hurt.length) output += `      🦴 ${hurt.map(pt => `${pt.name}: ${pt.state}${pt.latchedTo ? `→${state.participants.find(o => o.id === pt.latchedTo!.participantId)?.name ?? pt.latchedTo.participantId}${pt.latchedTo.part ? ` ${pt.latchedTo.part}` : ''}` : ''}${armour(pt)}`).join(' · ')}\n`;
        if (p.intent) output += `      ⚑ intent: ${p.intent}\n`;
        // Play report 7 #5: the subdue order, and what it does to the readied attack.
        if (p.subdue) output += `      🤲 subdue (take alive): opportunity attacks and readied melee swings knock out; a readied ranged shot follows its onSubdue\n`;
        if (p.readied) output += `      ⏳ readied: ${p.readied.action} when ${p.readied.trigger}${readiedLaneTag(p)}${readiedSubdueTag(p)}\n`;
        // Play report 7 #10: rider and mount.
        if (p.mountedOn) {
            const steed = state.participants.find(o => o.id === p.mountedOn);
            output += `      🐎 riding ${steed?.name ?? p.mountedOn} (${steed?.controlledBy === p.id ? 'controlled' : 'independent'})${steed?.controlledBy === p.id ? ': its move moves the mount' : ': the mount moves itself'}\n`;
        }
        if (p.riderId) output += `      🐎 ridden by ${state.participants.find(o => o.id === p.riderId)?.name ?? p.riderId}${p.controlledBy === p.riderId ? ' (controlled: moves on its rider\'s turn; Dash, Disengage or Dodge only)' : ' (independent)'}\n`;
        if (p.cover) output += `      🛡 cover: ${p.cover.level}${Array.isArray(p.cover.against) && p.cover.against.length ? ` against ${p.cover.against.join(', ')}` : ''}${p.cover.direction ? ` to the ${p.cover.direction}` : ''}${p.cover.reason ? ` (${p.cover.reason})` : ''}${p.coverBrokenRound === state.round ? ' [broken this round]' : ''}\n`;
        const hide = canHideReport(state, p);
        if (hide.length) output += `      🫥 can hide from ${hide.map(h => `${h.from} (${h.reason})`).join(', ')}\n`;
    });
    
    output += `\n`;

    // Find valid targets for guidance
    const validPlayerTargets = state.participants
        .filter(p => !p.isEnemy && p.hp > 0)
        .map(p => `${p.name} (${p.id})`);
    
    const validEnemyTargets = state.participants
        .filter(p => p.isEnemy && p.hp > 0)
        .map(p => `${p.name} (${p.id})`);

    // Action guidance
    if (lairUp) {
        output += lairOwner?.lairUsedRound === state.round
            ? `🏰 LAIR ACTION USED this round → call advance_turn\n`
            : `🏰 LAIR ACTION PENDING → combat_manage lair_action {encounterId, actionDescription, targetIds?, damage?, savingThrow?}, then advance\n`;
    } else if (isEnemy && currentParticipant && currentParticipant.hp > 0) {
        output += `⚡ ENEMY TURN\n`;
        output += `   Available targets: ${validPlayerTargets.join(', ') || 'None'}\n`;
        output += `   → Execute attack, then call advance_turn\n`;
    } else if (currentParticipant && currentParticipant.hp > 0) {
        output += `🎮 PLAYER TURN\n`;
        output += `   Available targets: ${validEnemyTargets.join(', ') || 'None'}\n`;
        output += `   → Awaiting player action\n`;
    } else if (currentParticipant?.deathSaveDue) {
        const c = deathCounters(currentParticipant);
        output += `🩸 DEATH SAVE DUE: ${currentParticipant.name} (0 HP, ✓${c.successes} ✗${c.failures}) → ${deathSaveCall(encounterId ?? '<encounterId>', currentParticipant.id)} (or outcome: success | failure | nat20 | nat1), then advance\n`;
    } else {
        output += `⏭️ Current combatant is ${dyingStatus(currentParticipant ?? { hp: 0, conditions: [] } as unknown as CombatParticipant) === 'dead' ? 'dead' : 'defeated'} — call advance_turn\n`;
    }

    return output;
}

/**
 * Create a visual HP bar
 */
function createHpBar(percentage: number): string {
    const filled = Math.max(0, Math.min(10, Math.round(percentage / 10)));
    const empty = 10 - filled;
    
    // Simple ASCII bar for cleaner output
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `[${bar}]`;
}

/**
 * Format an attack result for display
 */
function formatAttackResult(result: CombatActionResult): string {
    // FINDINGS #63 (PDA Wave B): КОНТАКТ — rebuilt from the structured result,
    // not the engine's prose. The natural die always prints (jam law).
    const rr = result as CombatActionResult & { damageType?: string };
    const ar = result.attackRoll as (typeof result.attackRoll & { allRolls?: number[] }) | undefined;
    let output = '\n' + pda.renderContact({
        actorName: result.actor?.name,
        targetName: result.target?.name,
        die: ar?.roll,
        resolved: (ar as { resolved?: 'hit' | 'crit' | 'miss' } | undefined)?.resolved,
        allRolls: ar?.allRolls,
        bonus: ar?.modifier,
        total: ar?.total,
        targetAc: ar?.dc,
        hit: ar?.isHit,
        crit: ar?.isCrit,
        damageTotal: result.damage,
        damageType: rr.damageType,
        damageModifier: result.damageModifier,
        bandScale: result.bandScale,
        damageRolls: (result as CombatActionResult & { damageRolls?: number[] }).damageRolls,
        hpBefore: result.target?.hpBefore,
        hpAfter: result.target?.hpAfter,
        defeated: result.defeated,
        // Play report 5: a non-lethal knockout reads KNOCKED OUT, not DOWN.
        knockedOut: !!result.knockedOut,
        jamCheckOwed: (result as CombatActionResult & { jamCheckOwed?: { weapon?: string; condition?: number; jamsOn?: string } }).jamCheckOwed
    });
    output += `\n→ advance_turn to proceed`;
    return output;
}

/**
 * Format a heal result for display
 */
function formatHealResult(result: CombatActionResult): string {
    let output = `\n┌─────────────────────────────────────────┐\n`;
    output += `│ 💚 HEAL ACTION\n`;
    output += `└─────────────────────────────────────────┘\n\n`;

    output += `${result.actor.name} heals ${result.target.name}!\n\n`;
    output += result.detailedBreakdown;
    output += `\n\n→ Call advance_turn to proceed`;

    return output;
}

/**
 * CRIT-006: Format spell cast result for display
 */
function formatSpellCastResult(
    casterName: string,
    resolution: { 
        spellName: string; 
        damage?: number; 
        damageType?: string; 
        healing?: number; 
        diceRolled: string; 
        saveResult?: string; 
        saveDC?: number; 
        autoHit?: boolean; 
        dartCount?: number; 
        concentration?: boolean;
        attackRoll?: number;
        attackTotal?: number;
        hit?: boolean;
        critical?: boolean;
    },
    target: { name: string; hp: number; maxHp: number } | undefined,
    targetHpBefore: number,
    /** Play report 5 #5: the dying tail for a tracked target at 0 (' 🩸 DYING ✓0 ✗0', ' ☠ DEAD (massive damage)'); default DEFEATED!. */
    tail?: string
): string {
    let output = `\n┌─────────────────────────────────────────┐\n`;
    output += `│ ✨ SPELL CAST\n`;
    output += `└─────────────────────────────────────────┘\n\n`;
    output += `${casterName} casts ${resolution.spellName}!\n\n`;

    // Attack Roll details
    if (resolution.attackRoll !== undefined) {
        const hitStr = resolution.critical ? 'CRITICAL HIT' : resolution.hit ? 'HIT' : resolution.attackRoll === 1 ? 'MISS (natural 1)' : 'MISS';
        const bonus = (resolution.attackTotal || 0) - resolution.attackRoll;
        const sign = bonus >= 0 ? '+' : '';
        output += `⚔️ Attack Roll: ${resolution.attackRoll} (d20) ${sign}${bonus} = ${resolution.attackTotal} → ${hitStr}\n`;
    }

    // Dice & Damage
    if (resolution.diceRolled) {
        output += `🎲 Rolled: ${resolution.diceRolled}\n`;
    }

    // Special: Magic Missile darts
    if (resolution.dartCount) {
        output += `✨ Darts: ${resolution.dartCount}\n`;
    }

    // Save info (moved into damage block if applicable, or standalone if no damage)
    if (resolution.saveResult && resolution.saveDC && (!resolution.damage || resolution.damage <= 0)) {
        const saveIcon = resolution.saveResult === 'passed' ? '✓' : '✗';
        output += `🛡️ Save DC ${resolution.saveDC}: ${saveIcon} ${resolution.saveResult}\n`;
    }

    // Auto-hit
    if (resolution.autoHit) {
        output += `🎯 Auto-hit!\n`;
    }

    // Damage
    if (resolution.damage !== undefined && resolution.damage > 0) {
        const damageType = resolution.damageType || 'magical';
        output += `💥 Damage: ${resolution.damage} ${damageType}\n`;
        
        // Save details (if damage was dealt and there was a save)
        if (resolution.saveResult) {
            const saveEmoji = resolution.saveResult === 'passed' ? '✓' : '✗';
            output += `   (Save DC ${resolution.saveDC}: ${saveEmoji} ${resolution.saveResult.toUpperCase()})\n`;
        }

        if (target) {
            output += `\n${target.name}: ${targetHpBefore} → ${target.hp} HP`;
            if (target.hp <= 0) {
                output += tail ?? ` 💀 DEFEATED!`;
            }
        }
    } else if (resolution.hit === false) {
        output += `💨 The spell missed!\n`;
    }

    // Healing
    if (resolution.healing && resolution.healing > 0) {
        output += `💚 Healing: ${resolution.healing}\n`;

        if (target) {
            output += `\n${target.name}: ${targetHpBefore} → ${target.hp} HP`;
        }
    }

    // Concentration
    if (resolution.concentration) {
        output += `\n⚡ Concentration required`;
    }

    output += `\n\n→ Call advance_turn to proceed`;

    return output;
}

/**
 * HIGH-003: Format disengage result for display
 */
function formatDisengageResult(actorName: string): string {
    let output = `\n┌─────────────────────────────────────────┐\n`;
    output += `│ 🏃 DISENGAGE ACTION\n`;
    output += `└─────────────────────────────────────────┘\n\n`;
    output += `${actorName} takes the Disengage action.\n`;
    output += `Movement this turn will not provoke opportunity attacks.\n`;
    output += `\n→ Call advance_turn to proceed (or move first)`;
    return output;
}

/**
 * Item 11: a reactor the players run (on the heroes' side, with a PC
 * character row). Its opportunity attacks are offered, never rolled for it.
 */
function isPlayerReactor(p: CombatParticipant): boolean {
    if (p.isEnemy) return false;
    const row = new CharacterRepository(getDb()).findById(p.id);
    return !!row && (row.characterType ?? 'pc') === 'pc';
}

/** Play report 7 #6: an active agent with auto_on_turn plays this token's turns (agent_manage), not a player at the table. */
function agentDrivesTurn(id: string): boolean {
    try {
        const agent = new AgentRepository(getDb()).findByCharacterId(id);
        return !!agent && agent.autoOnTurn && agent.status === 'active';
    } catch {
        return false;
    }
}

/**
 * Play report 7 #6: the slot that is up belongs to a living player character
 * (a pc row on the heroes' side) who can act, whose turn is untouched, and
 * whose turns no agent plays. advance refuses to pass it unless the GM
 * confirms. LAIR, HP 0, incapacitated, surprised, enemies, npc rows and
 * sheetless tokens are never held.
 */
function pcTurnNotTaken(engine: CombatEngine, p: CombatParticipant): boolean {
    if (p.hp <= 0 || p.isDead || p.surprised) return false;
    if (!engine.canTakeActions(p.id)) return false;
    if (!turnUntouched(p)) return false;
    try { if (!isPlayerReactor(p)) return false; } catch { return false; }
    return !agentDrivesTurn(p.id);
}

/**
 * Play report 7 #7 (lane F): an attacker's declared advantage on attack rolls,
 * for each lane: untagged attack / attack:melee / attack:ranged mechanics on
 * its active effects, and tagged ones whose tag `context` asserts. Effects are
 * read by the token's id (a sheet-backed token's id is its character id;
 * custom_effects target_id). A fight with no store in scope reads none.
 */
export function attackDeclarations(attackerId: string, context: readonly string[] = []): Record<AttackLane, RollDeclarations> & { effects: ReturnType<typeof loadEffectDeclarations> } {
    let effects: ReturnType<typeof loadEffectDeclarations> = [];
    try { effects = loadEffectDeclarations(getDb(), attackerId); } catch { effects = []; }
    return {
        effects,
        melee: declaredOnRoll(effects, { kind: 'attack', range: 'melee' }, context),
        ranged: declaredOnRoll(effects, { kind: 'attack', range: 'ranged' }, context)
    };
}

/**
 * Lane F: the per-lane sides an automatic attack (an opportunity attack, a
 * readied attack, a volley's) passes to executeAttack: untagged mechanics
 * only, since no context is asserted. Undefined when nothing fires.
 */
export function automaticDeclared(attackerId: string): Partial<Record<AttackLane, DeclaredSides>> | undefined {
    const d = attackDeclarations(attackerId);
    const out: Partial<Record<AttackLane, DeclaredSides>> = {};
    if (hasSides(d.melee)) out.melee = mergeSides(d.melee);
    if (hasSides(d.ranged)) out.ranged = mergeSides(d.ranged);
    return out.melee || out.ranged ? out : undefined;
}

/** Lane F: an attack's lane as cover and fighting style read it — the ranged flag, else the grid distance against reach, else melee. */
export function attackLaneOf(actor: CombatParticipant, target: CombatParticipant, opts: { ranged?: boolean; reachFt?: number }): AttackLane {
    return (opts.ranged ?? (actor.position && target.position
        ? edgeDistanceSquares(actor, target) * 5 > effectiveReachFt(actor, opts.reachFt !== undefined ? { reachFt: opts.reachFt } : undefined)
        : false)) ? 'ranged' : 'melee';
}

/**
 * Lane F: the initiative sides of the tokens about to roll it (a given
 * initiative rolls nothing, so it reads nothing): untagged `initiative` and
 * `check:dex` mechanics, and tagged ones the token's context asserts. Each
 * context tag that fired nothing comes back as a warning naming the token.
 */
export function initiativeDeclarations(tokens: Array<{ id: string; name?: string; initiative?: number; context?: readonly string[] }>): { sources: Record<string, DeclaredSides>; warnings: string[] } {
    const sources: Record<string, DeclaredSides> = {};
    const warnings: string[] = [];
    let db: Database.Database | undefined;
    try { db = getDb(); } catch { db = undefined; }
    for (const t of tokens) {
        const context = (t.context ?? []).map(c => String(c).trim()).filter(Boolean);
        if (t.initiative !== undefined) {
            if (context.length) warnings.push(`${t.name ?? t.id}: context [${context.join(', ')}] ignored: its initiative was given, nothing was rolled`);
            continue;
        }
        const effects = db ? loadEffectDeclarations(db, t.id) : [];
        const d = declaredOnRoll(effects, { kind: 'initiative' }, context);
        if (hasSides(d)) sources[t.id] = mergeSides(d);
        const unfired = context.filter(c => !d.firedTags.includes(normTag(c)));
        if (unfired.length) warnings.push(`${t.name ?? t.id}: context [${unfired.join(', ')}] fired nothing on initiative: no tagged initiative or check:dex mechanic on ${t.name ?? t.id} declares it`);
    }
    return { sources, warnings };
}

/**
 * Item 11: resolve a stored attack spec (a readied action's attack) as a
 * reaction on the encounter's dice. Omitted fields come from the named
 * profile, then the token's default attack; the target's AC from its token,
 * then its sheet. Spends the reaction; the caller checks it was available
 * and saves the state.
 */
export function resolveReadiedAttack(engine: CombatEngine, reactor: CombatParticipant, target: CombatParticipant, spec: ReadiedAttack, opts: { cover?: unknown } = {}): CombatActionResult {
    const profiles = reactor.attacks?.length ? reactor.attacks : (new CharacterRepository(getDb()).findById(reactor.id)?.attacks ?? []);
    const source = resolveAttackSource({ parts: reactor.parts, attacks: profiles }, { using: spec.using, withPart: spec.withPart });
    const profile = source.profile;
    const attackBonus = spec.attackBonus ?? profile?.attackBonus ?? reactor.attackBonus ?? reactor.initiativeBonus + 2;
    const damage = spec.damage ?? profile?.damage ?? reactor.attackDamage ?? '1d6';
    const damageType = spec.damageType ?? profile?.damageType ?? reactor.attackDamageType;
    const ac = target.ac ?? new CharacterRepository(getDb()).findById(target.id)?.ac ?? 10;
    const withPart = spec.withPart && findPart(reactor, spec.withPart) ? spec.withPart : source.part?.name;
    // Play report 5 #1: a per-call cover wins; unset, the engine reads the
    // standing and map cover itself. Either way the profile's ignoreCover,
    // else the sheet's for this lane (Sharpshooter on the row rides onto the
    // token; the row itself for a fight created before it was set), lifts
    // what it names, as it does on an ordinary attack.
    // Lane G2: the readied attack's own ranged flag first, then the profile's, then the grid.
    const flagged = readiedRanged(spec, profile);
    const lane: 'ranged' | 'melee' = (flagged.ranged ?? (reactor.position && target.position
        ? edgeDistanceSquares(reactor, target) * 5 > effectiveReachFt(reactor, profile?.reachFt !== undefined ? { reachFt: profile.reachFt } : undefined)
        : false)) ? 'ranged' : 'melee';
    // The row is read only when the token carries no scope; a bare engine
    // with no store in scope (a unit test, a sheetless fight) has none to read.
    const sheetIgnore = reactor.ignoreCover ?? (() => {
        try { return (new CharacterRepository(getDb()).findById(reactor.id) as { ignoreCover?: IgnoreCoverScopes } | null)?.ignoreCover; } catch { return undefined; }
    })();
    const ignoreCover = profile?.ignoreCover ?? ignoreCoverFor(sheetIgnore, lane);
    // Play report 7 #5: a standing subdue order. A melee swing is non-lethal;
    // a ranged shot follows the onSubdue settled when it was readied ('hold'
    // or an unanswered order: no shot, nothing spent — thrown as a held
    // refusal the callers report); 'fire' shoots to kill and says so. A
    // target already down is not struck; a unit is not subdued.
    const subdue = readiedSubdueFor(reactor, target, spec, lane);
    if (subdue && (subdue.mode === 'hold' || subdue.mode === 'downed')) throw heldReadiedError(subdue);
    const cover = opts.cover !== undefined ? resolveCover(engine.getState()!, reactor, target, { explicit: opts.cover, ignoreCover }) : undefined;
    // Play report 7 #7 (lane F): the reactor's untagged attack mechanics fire;
    // a readied attack carries no context, so a tagged one never does.
    const declared = automaticDeclared(reactor.id);
    const result = engine.executeAttack(reactor.id, target.id, attackBonus, ac, damage, damageType,
        false, false, undefined, undefined, undefined, undefined, { withPart, ranged: flagged.ranged, twoHanded: spec.twoHanded ?? profile?.twoHanded, reachFt: profile?.reachFt, ...(cover ? { cover } : {}), ...(ignoreCover ? { ignoreCover } : {}), ...(subdue?.mode === 'non-lethal' ? { nonlethal: true } : {}), ...(declared ? { declared } : {}) });
    engine.commitAction(reactor.id, 'reaction');
    // Lane G2: a flag that disagrees with its profile wins, and the shot says so.
    if (flagged.override) {
        result.situational = [...(result.situational ?? []), flagged.override.note];
        result.detailedBreakdown = `(${flagged.override.note})\n${result.detailedBreakdown}`;
    }
    if (subdue) {
        result.subdue = subdue;
        result.situational = [...(result.situational ?? []), subdue.note];
        result.detailedBreakdown = `(${subdue.note})\n${result.detailedBreakdown}`;
    }
    return result;
}

/**
 * Play report 7 #5: the profile a readied attack would fire with, picked as
 * resolveReadiedAttack picks it (using / withPart over the token's profiles,
 * else the sheet's). Undefined when it names none or names one that does not
 * exist (the shot then fails, or reads its lane from the grid, when it fires).
 */
export function readiedShotProfile(reactor: CombatParticipant, spec: ReadiedAttack) {
    let profiles = reactor.attacks ?? [];
    if (!profiles.length) {
        try { profiles = new CharacterRepository(getDb()).findById(reactor.id)?.attacks ?? []; } catch { profiles = []; }
    }
    try { return resolveAttackSource({ parts: reactor.parts, attacks: profiles }, { using: spec.using, withPart: spec.withPart }).profile; } catch { return undefined; }
}

/**
 * Lane G2: whether a readied attack is ranged as the ready reads it (its own
 * `ranged` flag, else its named profile's), and the note when the flag
 * overrides the profile.
 */
export function readiedRangedFor(reactor: CombatParticipant, spec: ReadiedAttack | undefined): ReturnType<typeof readiedRanged> {
    return spec ? readiedRanged(spec, readiedShotProfile(reactor, spec)) : {};
}

/** Lane G2: the reply field and message tail for a readied attack whose ranged flag overrides its profile. */
export function readiedRangedNote(reactor: CombatParticipant, spec: ReadiedAttack | undefined): ReadiedRangedOverride | undefined {
    return spec?.ranged === undefined ? undefined : readiedRangedFor(reactor, spec).override;
}

/** Lane G2 review: the short form of a flag's override, for a reaction line. */
export function readiedOverrideTail(o: ReadiedRangedOverride | undefined): string | undefined {
    return o ? `attack.ranged: ${o.ranged} overrides the ${o.profile} profile` : undefined;
}

/**
 * Lane G2 review: a readied attack as the call that restates it, with the
 * onSubdue answer to choose — every key the call gave (its own ranged flag
 * and numbers included), so the pasted call readies the same shot.
 * 'attack: {onSubdue: …}' alone readied a bare swing that was no longer ranged.
 */
export function readiedAttackPaste(spec: Record<string, unknown> | undefined): string {
    const parts = Object.entries(spec ?? {})
        .filter(([k, v]) => k !== 'onSubdue' && v !== undefined)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v.replace(/'/g, "\\'")}'` : String(v)}`);
    return `{${[...parts, "onSubdue: 'hold' | 'fire'"].join(', ')}}`;
}

/**
 * Lane G2 review: a readied attack as a call passed it (readiedAttackInputSchema
 * keeps unknown keys) split into what it takes and the keys it does not,
 * each named at `path` ('attack.rnaged') for ignoredParams. Only the clean
 * attack is ever read or stored.
 */
export function splitReadiedAttack(attack: Record<string, unknown> | undefined, path: string): { attack: ReadiedAttack | undefined; ignored: Array<{ path: string; key: string }>; note?: string } {
    if (!attack) return { attack: undefined, ignored: [] };
    const clean: Record<string, unknown> = {};
    const ignored: Array<{ path: string; key: string }> = [];
    for (const [k, v] of Object.entries(attack)) {
        if (READIED_ATTACK_KEYS.includes(k)) clean[k] = v;
        else ignored.push({ path: `${path}.${k}`, key: k });
    }
    return { attack: clean as ReadiedAttack, ignored, ...(ignored.length ? { note: describeNestedIgnored('readied attack', ignored, READIED_ATTACK_KEYS) } : {}) };
}

/** Lane G2 review: a success reply naming the readied attack's keys it did not take (ignoredParams and a message line). */
export function withReadiedIgnored<T extends Record<string, unknown>>(reply: T, split: { ignored: Array<{ path: string }>; note?: string }): T {
    if (!split.ignored.length || !split.note) return reply;
    const prior = typeof reply.message === 'string' ? reply.message : '';
    return { ...reply, ignoredParams: split.ignored.map(e => e.path), message: prior ? `${prior.replace(/\.?\s*$/, '')}. ${split.note}` : split.note };
}

/**
 * Play report 7 #5 (owner's answer): readying a RANGED attack on a token
 * under a subdue order is refused unless the call says onSubdue. The text
 * names both values and why; `call` is the exact call to make instead.
 * Undefined when nothing needs settling (no order, no attack, onSubdue
 * given, or an attack that is not ranged). Lane G2: the readied attack's own
 * `ranged` flag counts first, then its profile's.
 */
export function readiedSubdueRefusal(reactor: CombatParticipant, spec: ReadiedAttack | undefined, call: string): string | undefined {
    if (!reactor.subdue || !spec || spec.onSubdue) return undefined;
    const lane = readiedRangedFor(reactor, spec);
    if (lane.ranged !== true) return undefined;
    return `${reactor.name} is under a subdue order (take them alive), and this readied attack is ranged (${lane.source}): a shot can't be non-lethal (5e: non-lethal blows are melee only). Settle it now, before anyone commits: say what ${reactor.name} does when the trigger comes up — attack.onSubdue: 'hold' (the order wins: ${reactor.name} holds fire; the reaction is not spent and the shot stays readied) or attack.onSubdue: 'fire' (the shot wins: it fires as an ordinary lethal attack, logged 'subdue order overridden'). For a player's token, the player chooses. ${call} Nothing was written.`;
}

/** Play report 7 #5: a token under the order holding a ranged readied shot whose onSubdue is unanswered (the order came after the ready). */
export function readiedNeedsOnSubdue(p: CombatParticipant): { profile: string } | undefined {
    const spec = p.readied?.attack;
    if (!p.subdue || !spec || spec.onSubdue) return undefined;
    const lane = readiedRangedFor(p, spec);
    return lane.ranged === true ? { profile: lane.source ?? 'attack.ranged: true' } : undefined;
}

/** The JSON for one rolled reaction attack: every number the prose shows. */
export function reactionAttackData(r: CombatActionResult) {
    return {
        roll: r.attackRoll?.roll,
        allRolls: (r.attackRoll as { allRolls?: number[] } | undefined)?.allRolls,
        total: r.attackRoll?.total,
        targetAc: r.attackRoll?.dc,
        hit: r.success,
        crit: !!r.attackRoll?.isCrit,
        damage: r.damage ?? 0,
        damageType: (r as { damageType?: string }).damageType,
        targetHpAfter: r.target?.hpAfter,
        // Play report 7 #5: a subdue order knocked the target out (no kill, no corpse), and how the order shaped the swing.
        ...(r.knockedOut ? { knockedOut: r.knockedOut } : {}),
        ...(r.subdue ? { subdue: r.subdue } : {}),
        ...(r.cover ? { cover: r.cover } : {}),
        // Play report 7 #7 (lane F): the declared sources this reaction's roll took.
        ...(r.advantageSources?.length ? { advantageSources: r.advantageSources } : {}),
        ...(r.disadvantageSources?.length ? { disadvantageSources: r.disadvantageSources } : {}),
        ...(r.situational?.length ? { situational: r.situational } : {})
    };
}

/**
 * HIGH-003: Format opportunity attack result for display
 */
function formatOpportunityAttackResult(result: CombatActionResult): string {
    let output = `\n┌─────────────────────────────────────────┐\n`;
    output += `│ ⚡ OPPORTUNITY ATTACK\n`;
    output += `└─────────────────────────────────────────┘\n\n`;
    output += result.detailedBreakdown;
    return output;
}

/**
 * CRIT-003: Format a move result for display
 */
function formatMoveResult(
    actorName: string,
    fromPos: { x: number; y: number } | undefined,
    toPos: { x: number; y: number },
    success: boolean,
    failReason: string | null,
    distance?: number
): string {
    let output = `\n┌─────────────────────────────────────────┐\n`;
    output += `│ 🚶 MOVE ACTION\n`;
    output += `└─────────────────────────────────────────┘\n\n`;

    if (success) {
        if (fromPos) {
            output += `${actorName} moved from (${fromPos.x}, ${fromPos.y}) to (${toPos.x}, ${toPos.y})`;
            if (distance !== undefined) {
                output += ` [${distance} tiles]`;
            }
            output += `\n`;
        } else {
            output += `${actorName} placed at (${toPos.x}, ${toPos.y})\n`;
        }
    } else {
        output += `${actorName} cannot move to (${toPos.x}, ${toPos.y})\n`;
        output += `Reason: ${failReason}\n`;
    }

    output += `\n→ Call advance_turn to proceed`;
    return output;
}

// ============================================================
// GRID VISUALIZATION - ASCII rendering for spatial combat
// ============================================================

/**
 * Render an ASCII grid map of the combat state
 * Shows participant positions, terrain, and coordinate labels
 */
function renderGrid(state: CombatState, options?: { width?: number; height?: number; showLegend?: boolean }): string {
    const width = options?.width ?? 20;
    const height = options?.height ?? 20;
    const showLegend = options?.showLegend ?? true;

    // Build grid with empty cells
    const grid: string[][] = [];
    for (let y = 0; y < height; y++) {
        grid[y] = [];
        for (let x = 0; x < width; x++) {
            grid[y][x] = '·';  // Empty tile
        }
    }

    // Place terrain obstacles
    const terrain = state.terrain ?? { obstacles: [] };
    for (const obs of terrain.obstacles) {
        const [x, y] = obs.split(',').map(Number);
        if (x >= 0 && x < width && y >= 0 && y < height) {
            grid[y][x] = '█';  // Solid obstacle
        }
    }

    // Place difficult terrain
    if (terrain.difficultTerrain) {
        for (const dt of terrain.difficultTerrain) {
            const [x, y] = dt.split(',').map(Number);
            if (x >= 0 && x < width && y >= 0 && y < height && grid[y][x] === '·') {
                grid[y][x] = '░';  // Difficult terrain
            }
        }
    }

    // Place participants
    const legend: string[] = [];
    let friendlyIndex = 1;
    let enemyIndex = 1;

    for (const p of state.participants) {
        if (!p.position) continue;
        const { x, y } = p.position;
        if (x >= 0 && x < width && y >= 0 && y < height) {
            let symbol: string;
            if (p.hp <= 0) {
                symbol = '☠';  // Defeated
            } else if (p.isEnemy) {
                symbol = String(enemyIndex);
                legend.push(`  ${symbol} = ${p.name} (Enemy, HP: ${p.hp}/${p.maxHp})`);
                enemyIndex = (enemyIndex % 9) + 1;
            } else {
                symbol = String.fromCharCode(64 + friendlyIndex);  // A, B, C...
                legend.push(`  ${symbol} = ${p.name} (HP: ${p.hp}/${p.maxHp})`);
                friendlyIndex++;
            }
            grid[y][x] = symbol;
        }
    }

    // Build output string
    let output = '\n┌─ COMBAT MAP ─────────────────────────────┐\n';

    // Column headers (x-axis)
    output += '    ';
    for (let x = 0; x < width; x++) {
        output += (x % 5 === 0) ? String(x).padStart(2, ' ').slice(-1) : ' ';
    }
    output += '\n';

    // Grid rows (with y-axis labels)
    for (let y = 0; y < height; y++) {
        const yLabel = (y % 5 === 0) ? String(y).padStart(2, ' ') : '  ';
        output += `${yLabel} │`;
        for (let x = 0; x < width; x++) {
            output += grid[y][x];
        }
        output += '│\n';
    }

    output += '└───────────────────────────────────────────┘\n';

    // Legend
    if (showLegend && legend.length > 0) {
        output += '\n📍 LEGEND:\n';
        output += legend.join('\n') + '\n';
        output += '\n  · = Empty   █ = Obstacle   ░ = Difficult Terrain   ☠ = Defeated\n';
    }

    return output;
}

/**
 * Calculate which tiles and participants are affected by an Area of Effect
 */
function calculateAoE(
    state: CombatState,
    shape: 'circle' | 'cone' | 'line',
    origin: { x: number; y: number },
    params: { radius?: number; direction?: { x: number; y: number }; length?: number; angle?: number; width?: number }
): { tiles: { x: number; y: number }[]; affectedParticipants: AoeParticipant[]; modelsInArea?: Record<string, number> } {
    const spatial = new SpatialEngine();
    let tiles: { x: number; y: number }[] = [];

    if (shape === 'circle' && params.radius !== undefined) {
        tiles = spatial.getCircleTiles(origin, params.radius);
    } else if (shape === 'cone' && params.direction && params.length !== undefined && params.angle !== undefined) {
        tiles = spatial.getConeTiles(origin, params.direction, params.length, params.angle);
    } else if (shape === 'line' && params.direction && params.length !== undefined) {
        // Line is a cone with 0 angle, or we use getLineTiles
        const endX = origin.x + params.direction.x * params.length;
        const endY = origin.y + params.direction.y * params.length;
        tiles = spatial.getLineTiles(origin, { x: endX, y: endY });
    }

    // Find participants in affected tiles. Play report 7 #1: every square of
    // a token's footprint counts (a large token was missed when the area
    // touched its side but not its top-left square), and a unit reports the
    // squares covered with a modelsInArea hint the GM can pass on.
    const tileSet = new Set(tiles.map(t => `${t.x},${t.y}`));
    const affectedParticipants: AoeParticipant[] = [];
    const modelsInArea: Record<string, number> = {};
    for (const p of state.participants) {
        if (!p.position || p.hp <= 0) continue;
        const cells = footprintCells(p);
        const cellsInside = cells.filter(c => tileSet.has(`${c.x},${c.y}`)).length;
        if (!cellsInside) continue;
        const entry: AoeParticipant = { id: p.id, name: p.name, position: p.position, cellsInside, footprint: cells.length };
        if (p.unit) {
            const live = liveModels(p);
            const hint = p.unit.packed ? live : Math.min(live, Math.max(1, Math.round(live * cellsInside / cells.length)));
            entry.unit = { packed: !!p.unit.packed, liveModels: live, modelsInArea: hint };
            modelsInArea[p.id] = hint;
        }
        affectedParticipants.push(entry);
    }

    return { tiles, affectedParticipants, ...(Object.keys(modelsInArea).length ? { modelsInArea } : {}) };
}

/** A token an area touches: the squares of its footprint inside, and for a unit the modelsInArea hint. */
interface AoeParticipant {
    id: string;
    name: string;
    position: { x: number; y: number };
    cellsInside: number;
    footprint: number;
    unit?: { packed: boolean; liveModels: number; modelsInArea: number };
}

// Tool definitions (internal schemas, not exported)
const CombatTools = {
    CREATE_ENCOUNTER: {
        name: 'create_encounter',
        description: `Create a combat encounter with positioned combatants and terrain.

⚠️ CRITICAL - PARTICIPANT IDs:
- For PLAYER CHARACTERS: Use the exact UUID from the ACTIVE CHARACTER REFERENCE in context
- For ENEMIES: Use descriptive slugs like "goblin-1", "orc-2" (will be auto-generated)
- NEVER use "pc-1", "hero-1" for player characters - always use real UUID

📋 WORKFLOW:
1. Generate terrain (obstacles, water, difficult)
2. Add props (buildings, trees, cover)
3. Place party (safe starting positions) - USE REAL UUIDs for PCs!
4. Place enemies (tactical positions)

⚠️ CRITICAL VERTICALITY RULES:
- z=0 means "standing on surface at (x,y)" - EVEN ON TOP OF OBSTACLES
- If obstacles exist at (15,3), placing a unit at {x:15,y:3,z:0} = STANDING ON the obstacle
- z>0 = FLYING/LEVITATING only. Creatures without flight condition WILL FALL!
- Do NOT use z values to represent "standing on high ground"

✅ CORRECT: Goblin on rock at (15,3) → position: {x:15, y:3, z:0}
❌ WRONG: Goblin on rock → position: {x:15, y:3, z:25} (will fall!)

🏔️ TERRAIN GENERATION RULES:
- Obstacles should CLUSTER to form hills/mountains/caverns
- Include SLOPES: Adjacent tiles stepping down to ground level
- Isolated cliffs only if intentionally inaccessible
- Water must CONNECT (rivers/streams/pools), never isolated tiles

📐 PATTERN TEMPLATES (USE THESE!):

RIVER VALLEY (cliffs on sides, river in middle):
obstacles: ["5,0","5,1","5,2",...,"5,19"] (west cliff),
           ["13,0","13,1","13,2",...,"13,19"] (east cliff)
water: ["8,0","9,0","10,0","8,1","9,1","10,1",...] (3-wide river at x=8,9,10)

CANYON (two parallel walls):
obstacles: ["0,5","1,5","2,5",...,"9,5"] (north wall),
           ["0,15","1,15","2,15",...,"9,15"] (south wall)

Example (use real UUID from context for player character!):
{
  "seed": "battle-1",
  "terrain": {
    "obstacles": ["10,5", "11,5", "10,6"],
    "water": ["5,10", "5,11", "6,11"]
  },
  "participants": [
    {"id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890", "name": "Pyrus", "hp": 40, "maxHp": 40, "initiativeBonus": 2, 
     "position": {"x": 15, "y": 15, "z": 0}, "isEnemy": false},
    {"id": "goblin-1", "name": "Goblin Archer", "hp": 7, "maxHp": 7, "initiativeBonus": 1,
     "position": {"x": 10, "y": 5, "z": 0}, "isEnemy": true}
  ]
}`,
        inputSchema: z.object({
            seed: z.string().optional().describe('Omit for crypto dice (the default; unreplayable, each roll keyed crypto:<nonce> in the roll log). Pass a seed for a deterministic, replayable stream; the id echoes it'),
            participants: z.array(z.object({
                id: z.string(),
                name: z.string(),
                initiativeBonus: z.number().int().default(0),
                initiative: z.number().int().optional().describe('Optional pre-rolled initiative; otherwise the engine rolls it'),
                // Play report 7 #7 (lane F): the tags this token's initiative asserts; read at create, never stored on the token.
                context: tagsField(INITIATIVE_CONTEXT_DESCRIBE),
                hp: z.number().int().nonnegative(), // Allow 0 HP for dying characters
                maxHp: z.number().int().positive(),
                isEnemy: z.boolean().optional().describe('Whether this is an enemy (auto-detected if not set)'),
                ...ParticipantExtrasShape,
                ac: z.number().int().min(0).optional()
                    .describe('Armor Class (used by attack resolution; defaults to attacker-side derivation if omitted)'),
                conditions: z.array(ConditionInputSchema).default([])
                    .describe('Names ("prone") or {name|type, duration?, source?} objects; unknown names are kept as custom conditions with no mechanical effect'),
                position: z.object({ x: z.number(), y: z.number(), z: z.number().optional() }).optional()
                    .describe('CRIT-003: Spatial position for movement (x, y coordinates)'),
                // HIGH-002: Damage modifiers
                resistances: z.array(z.string()).optional()
                    .describe('Damage types that deal half damage (e.g., ["fire", "cold"])'),
                vulnerabilities: z.array(z.string()).optional()
                    .describe('Damage types that deal double damage'),
                immunities: z.array(z.string()).optional()
                    .describe('Damage types that deal no damage'),
                band: z.string().optional().describe("Table rules: power band (defaults from the character row)"),
                bandAssumed: z.boolean().optional().describe("Play report 7 #3 (set by combat_manage create, not a caller): band is the world's lowest, assumed"),
                regeneration: z.number().int().min(0).optional().describe('Table rules: HP healed at the start of each of its rounds (defaults from the character row)'),
                parts: z.array(PartSchema).optional().describe('Named parts with states (defaults from the character row)'),
                unit: UnitSchema.optional().describe('A mortal unit as one token: models, hpPerModel, packed, attackBonus, tiers'),
                intent: z.string().optional().describe('Telegraphed intent (clears when its turn ends)'),
                abilityScores: z.object({
                    strength: z.number(), dexterity: z.number(), constitution: z.number(),
                    intelligence: z.number(), wisdom: z.number(), charisma: z.number()
                }).optional().describe('Ability scores, long keys (saves read them when the token has no character row)')
            })).min(1),
            terrain: z.object({
                obstacles: z.array(z.string()).default([]).describe('Array of "x,y" strings for blocking tiles'),
                difficultTerrain: z.array(z.string()).optional().describe('Array of "x,y" strings for difficult terrain'),
                water: z.array(z.string()).optional().describe('Array of "x,y" strings for water terrain (streams, rivers)')
            }).optional().describe('CRIT-003: Terrain configuration for collision'),
            environment: EnvironmentSchema.optional().describe("The medium of the fight: {medium: 'air'|'water'|'vacuum', depthFt?, pressure?: {startsAtFt, damagePerRound, unlessTag?, damageType?, save?: {ability, dc, half?}}, rangedAllowed?, meleeDisadvantageUnlessDamageType?, swimTag?}. Pressure is an area: every model of a unit takes it separately"),
            surprised: z.array(z.string()).optional().describe('Participant ids caught flat-footed: their round-1 turn passes and they cannot react, act or take legendary actions until it has')
        })
    },
    GET_ENCOUNTER_STATE: {
        name: 'get_encounter_state',
        description: 'Get the current state of the active combat encounter.',
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter')
        })
    },
    EXECUTE_COMBAT_ACTION: {
        name: 'execute_combat_action',
        description: `Execute a combat action (attack, heal, move, cast_spell, etc.).

IMPORTANT FOR AOE SPELLS: When casting AoE spells like Fireball, you MUST provide targetIds 
(array of IDs) for all creatures in the area. Use calculate_aoe first to get affected creatures.

Examples:
{
  "action": "attack",
  "actorId": "hero-1",
  "targetId": "goblin-1",
  "attackBonus": 5,
  "dc": 12,
  "damage": 6
}

{
  "action": "heal",
  "actorId": "cleric-1",
  "targetId": "hero-1",
  "amount": 8
}

{
  "action": "move",
  "actorId": "hero-1",
  "targetPosition": { "x": 5, "y": 3 }
}

{
  "action": "disengage",
  "actorId": "hero-1"
}

{
  "action": "cast_spell",
  "actorId": "wizard-1",
  "spellName": "Fireball",
  "targetIds": ["goblin-1", "goblin-2", "goblin-3"],
  "slotLevel": 3
}`,
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter'),
            action: z.enum(['attack', 'heal', 'move', 'disengage', 'cast_spell']),
            actorId: z.string(),
            targetId: z.string().optional().describe('Target ID for single-target attack/heal/cast_spell actions'),
            targetIds: z.array(z.string()).optional()
                .describe('Array of target IDs for AoE spells (e.g., Fireball). Use calculate_aoe to get affected targets first.'),
            attackBonus: z.number().int().optional(),
            dc: z.number().int().optional(),
            damage: z.union([z.number(), z.string()]).optional().describe('Damage amount (number) or dice expression (e.g., "1d6+2")'),
            outcome: z.enum(['hit', 'crit', 'miss']).optional().describe('A result the GM resolved at the table. The engine rolls no d20 (no nat 1/20 override) and applies damage exactly as posted: a number is never doubled; a dice string with crit doubles its dice only. Resistances, HP write-through and concentration still apply. hit/crit need damage.'),
            advantage: z.boolean().optional().describe('Roll 2d20 keep highest (Findings #31/#32)'),
            disadvantage: z.boolean().optional().describe('Roll 2d20 keep lowest'),
            calledStrike: z.string().optional().describe("Table rules (called_strike): 'leg', 'arm' or any named part of the target ('jaw', 'collar chain'). No roll penalty; a hit cripples that part (it keeps its kind). Needs a target of your band or greater"),
            preparedAsset: z.string().optional().describe('Table rules (prepared_asset): the rule name; reports miss / hit / catastrophic tier and the effect the GM names'),
            unaffectedLimb: z.boolean().optional().describe('The attacker uses a limb its crippling condition does not touch (skips that disadvantage)'),
            withPart: z.string().optional().describe("The attacker's named part used ('middle head'): crippled = disadvantage; dead or latched = refused"),
            using: z.string().optional().describe("Named attack profile on the token or sheet ('grown blade'; unique prefix ok): fills attackBonus, damage, damageType and the part when omitted"),
            weapon: z.string().optional().describe('Alias of using; also finds the part whose holds names this weapon'),
            hand: z.enum(['mainhand', 'offhand']).optional().describe('Which hand swings: finds the part whose holds names the slot'),
            atPart: z.string().optional().describe('The target part aimed at: breached = advantage; a called strike cripples this part'),
            ranged: z.boolean().optional().describe('A ranged attack (not within 5 ft): a prone target is disadvantage and paralysed/unconscious no auto-crit. Unset = from token positions, else melee'),
            twoHanded: z.boolean().optional().describe('Item 17: the swing is made with both hands (great weapon fighting applies, dueling does not); default from the profile'),
            maneuver: z.enum(['trip', 'precision', 'riposte', 'menacing', 'disarming']).optional().describe("Item 16: a Battle Master manoeuvre paid from the sheet's superiority pool"),
            maneuverItem: z.string().optional().describe('disarming: the held item the target drops'),
            ignoreConditions: z.boolean().optional().describe('Skip the automatic advantage/disadvantage/auto-crit from standard conditions (raw roll)'),
            cleave: z.boolean().optional().describe('Cleave through a packed unit of a lower band: damage flows through models instead of stopping at one'),
            legendaryCost: z.number().int().min(1).optional().describe("A legendary action: spends this many of the creature's legendary actions instead of its action (off its own turn only)"),
            reaction: z.boolean().optional().describe('An attack as a reaction (opportunity attack, readied swing): spends the reaction instead of the action'),
            actionSurge: z.union([z.boolean(), z.string()]).optional().describe("When the action is already spent: spend a ready action-granting ability (true = the first grantsAction ability; a string names it; token first, then the sheet) for an extra action and swing. A no-op while the action is free"),
            bonusAction: z.boolean().optional().describe("Play report 5: a bonus-action attack — spends the bonus action, not the Attack action; the actor's own turn only; never with reaction, legendaryCost or actionSurge. Default from the profile"),
            requires: attackRequiresSchema().optional().describe('Play report 5: the trigger the swing needs {dashed?, movedAtLeast?, hitThisTurn?}; refused naming what is missing. Default from the profile'),
            movedFt: z.number().int().min(0).optional().describe('Play report 5: feet moved this turn, declared for a token without a position'),
            nonlethal: z.boolean().optional().describe('Play report 5: a non-lethal blow (melee only): a target it drops is knocked out — 0 HP, Unconscious, stable — not killed'),
            // Play report 7 #7 (lane F): declared advantage on the attack roll.
            context: tagsField(ATTACK_CONTEXT_DESCRIBE),
            advantageSources: sourcesField('advantage', ATTACK_SOURCE_NOTE),
            disadvantageSources: sourcesField('disadvantage', ATTACK_SOURCE_NOTE),
            situationalAdvantage: situationalField('advantage'),
            situationalDisadvantage: situationalField('disadvantage'),
            volley: z.object({ dice: z.string(), reason: z.string() }).optional().describe('Internal: set by combat_action volley'),
            cover: coverEnum().optional().describe("Play report 5 #1: the target's cover as the GM states it: none | half (+2 AC) | three-quarters (+5) | total (refused, nothing spent). Unset: standing cover on the token (set_cover), else computed from the map (props with a cover rating, creatures on the line of fire). Printed as AC 12 +5 (three-quarters, boulder) = 17; never fold it into dc as well"),
            coverByTarget: coverByTargetSchema().optional().describe(`cast_spell (several targets): ${COVER_BY_TARGET_DESCRIBE}`),
            modelsInArea: modelsInAreaSchema().optional().describe(`cast_spell: ${MODELS_IN_AREA_DESCRIBE}`),
            breaksCover: z.boolean().optional().describe("The attacker leaves its own standing cover to swing: set_cover is off for it until the next round (a profile's breaksCover does the same)"),
            bandScale: z.boolean().optional().describe("Request 11: false skips the band rule's damageScale for this swing (execute sets it). Default: applied when the world's band rule has damageScale and both bands are set"),
            declaredModifiers: z.array(z.object({ label: z.string(), value: z.number() })).optional().describe('Register-B audit trail: printed in output, never re-applied'),
            declaredEffects: z.array(z.object({ name: z.string(), lane: z.string().optional() })).optional().describe('FINDINGS #60 RESOLVER v2: GM declares the conditional trait by name (+lane for multi-lane rows); engine computes the value (incl. valueFromPool) and APPLIES it to the attack bonus'),
            damageType: z.string().optional()
                .describe('HIGH-002: Damage type (e.g., "fire", "cold", "slashing") for resistance calculation'),
            amount: z.number().int().optional(),
            targetPosition: z.object({ x: z.number(), y: z.number() }).optional()
                .describe('CRIT-003: Target position for move action'),
            // CRIT-006: Spell casting fields
            spellName: z.string().optional()
                .describe('CRIT-006: Name of the spell to cast (must exist in spell database)'),
            slotLevel: z.number().int().min(1).max(9).optional()
                .describe('CRIT-006: Spell slot level to use (for upcasting)'),
            unbinderId: z.string().optional()
                .describe("Item 9: a participant who tries to unbind a world spell (table_rules spell with contestedBy: 'unbind'): rolls the casting dice, a higher total stops it"),
            boost: z.object({
                pool: z.string().min(1), delta: z.number(), modifier: z.number().int().optional(), extraDice: z.string().optional(),
                sideEffect: z.array(z.object({ pool: z.string().min(1), delta: z.number() })).optional()
            }).optional().describe('World spell: spend a pool for +modifier / extraDice on the casting roll; sideEffect pools move too (growth-checked)')
        })
    },
    ADVANCE_TURN: {
        name: 'advance_turn',
        description: 'Advance to the next combatant\'s turn.',
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter'),
            // Play report 7 #6: pass a player character's untouched turn (TURN NOT TAKEN).
            confirm: z.boolean().optional().describe("Pass the turn of a player character who has used no action, bonus action or movement (the player passes or holds); without it advance refuses with TURN NOT TAKEN"),
            skipTurn: z.boolean().optional().describe('Alias of confirm')
        })
    },
    END_ENCOUNTER: {
        name: 'end_encounter',
        description: 'End the current combat encounter.',
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter')
        })
    },
    LOAD_ENCOUNTER: {
        name: 'load_encounter',
        description: 'Load a combat encounter from the database.',
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter to load')
        })
    },
    ROLL_DEATH_SAVE: {
        name: 'roll_death_save',
        description: 'Roll a d20 death saving throw for a participant at 0 HP (or post the result the table rolled). 10+ success, nat 20 regains 1 HP, nat 1 counts as 2 failures; three successes stable, three failures dead (the sheet is killed).',
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter'),
            participantId: z.string().optional().describe('The participant/token id at 0 HP'),
            characterId: z.string().optional().describe('Alias of participantId (the character id is the token id for a sheet-backed token)'),
            outcome: z.string().optional().describe('A posted result: success | failure | nat20 | nat1 (or the natural die 1-20); no d20 is rolled')
        })
    },
    EXECUTE_LAIR_ACTION: {
        name: 'execute_lair_action',
        description: 'Execute a lair action at initiative 20 when isLairActionPending is true. Apply environmental effects to targets.',
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter'),
            actionDescription: z.string().describe('Description of the lair action'),
            targetIds: z.array(z.string()).optional().describe('IDs of affected participants (optional)'),
            damage: z.union([z.number().int().min(0), z.string().min(1)]).optional().describe("Damage dealt by the lair action: a number or dice ('2d10'), rolled once on the encounter's dice"),
            damageType: z.string().optional().describe('Type of damage (fire, cold, etc.)'),
            savingThrow: z.object({
                ability: z.enum(['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']),
                dc: z.number().int().min(1).max(30),
                onFail: areaSaveRiderSchema().optional().describe('Play report 5 #6: conditions for a target that fails'),
                onSuccess: areaSaveRiderSchema().optional().describe('Play report 5 #6: conditions for a target that saves')
            }).optional().describe(`Saving throw required to avoid/reduce effect. ${ENGINE_SAVE_DESCRIBE}`),
            halfDamageOnSave: z.boolean().default(true).describe('Whether successful save halves damage'),
            cover: coverByTargetSchema().optional().describe(COVER_BY_TARGET_DESCRIBE),
            area: z.boolean().optional().describe(`${AREA_DESCRIBE}. A lair action is an area unless area: false`),
            modelsInArea: modelsInAreaSchema().optional().describe(MODELS_IN_AREA_DESCRIBE)
        })
    },
    // ============================================================
    // VISUALIZATION TOOLS
    // ============================================================
    RENDER_MAP: {
        name: 'render_map',
        description: `Render an ASCII map of the current combat state showing participant positions, obstacles, and terrain.
Returns a text-based grid visualization with:
- A-Z for friendly participants
- 1-9 for enemies
- █ for obstacles
- ░ for difficult terrain
- ☠ for defeated combatants

Example:
{
  "encounterId": "encounter-battle-1-123456",
  "width": 15,
  "height": 15
}`,
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter'),
            width: z.number().int().min(5).max(50).default(20).describe('Grid width (default: 20)'),
            height: z.number().int().min(5).max(50).default(20).describe('Grid height (default: 20)'),
            showLegend: z.boolean().default(true).describe('Include legend explaining symbols')
        })
    },
    CALCULATE_AOE: {
        name: 'calculate_aoe',
        description: `Calculate which tiles and participants are affected by an Area of Effect spell or ability.
Supports circle (Fireball), cone (Burning Hands), and line (Lightning Bolt) shapes.

Example - Fireball (20ft radius circle):
{
  "encounterId": "encounter-1",
  "shape": "circle",
  "origin": { "x": 10, "y": 10 },
  "radius": 4
}

Example - Burning Hands (15ft cone):
{
  "encounterId": "encounter-1",
  "shape": "cone",
  "origin": { "x": 5, "y": 5 },
  "direction": { "x": 1, "y": 0 },
  "length": 3,
  "angle": 90
}

Example - Lightning Bolt (100ft line):
{
  "encounterId": "encounter-1",
  "shape": "line",
  "origin": { "x": 0, "y": 5 },
  "direction": { "x": 1, "y": 0 },
  "length": 20
}`,
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter'),
            shape: z.enum(['circle', 'cone', 'line']).describe('Shape of the AoE'),
            origin: z.object({
                x: z.number(),
                y: z.number()
            }).describe('Origin point of the AoE'),
            radius: z.number().optional().describe('Radius for circle shape (in tiles)'),
            direction: z.object({
                x: z.number(),
                y: z.number()
            }).optional().describe('Direction vector for cone/line (e.g., {x:1,y:0} = East)'),
            length: z.number().optional().describe('Length for cone/line shapes (in tiles)'),
            angle: z.number().optional().describe('Angle for cone shape (in degrees, e.g., 90 for quarter circle)')
        })
    },
    UPDATE_TERRAIN: {
        name: 'update_terrain',
        description: `Add, remove, or modify terrain in an active encounter. ALWAYS prefer ranges over tiles arrays for efficiency.

TERRAIN TYPES:
- obstacles: Blocking terrain (walls, rocks, fallen trees)
- difficultTerrain: Half-speed terrain (mud, rubble, underbrush)
- water: Watery terrain (streams, rivers, pools)

INPUT OPTIONS (use ranges for efficiency):
1. ranges: Array of range shortcuts (PREFERRED - saves tokens)
2. tiles: Array of "x,y" strings (only for specific scattered tiles)

RANGE SHORTCUTS (use these!):

LINES:
- "x=N" - vertical line at x=N (full height)
- "x=N:y1:y2" - vertical line segment
- "y=N" - horizontal line at y=N (full width)
- "y=N:x1:x2" - horizontal line segment
- "line:x1,y1,x2,y2" - diagonal/any line from point to point (Bresenham)
- "hline:y:x1:x2" - horizontal line
- "vline:x:y1:y2" - vertical line
- "row:N" / "col:N" - aliases for y=N / x=N

SHAPES:
- "rect:x,y,w,h" - filled rectangle
- "box:x,y,w,h" - hollow rectangle (border only)
- "border:margin" - outer border of grid (margin=0 for edge)
- "fill:x1,y1,x2,y2" - fill between two corners
- "circle:cx,cy,r" - filled circle
- "ring:cx,cy,r" - hollow circle

ALGEBRA (for curves, diagonals):
- "y=x:0:99" - diagonal line (y equals x)
- "y=2*x+5:0:50" - any linear equation
- "y=x/2:0:99" - half-speed diagonal
- "expr:EQUATION:xMin:xMax" - explicit expression format

EXAMPLES:

Maze outer walls (1 call vs 4):
{ "ranges": ["border:0"], "gridWidth": 100, "gridHeight": 100 }

Complex maze section:
{ "ranges": ["y=10:0:50", "x=25:10:40", "line:50,50,75,25", "box:60,60,15,15"] }

Diagonal river:
{ "terrainType": "water", "ranges": ["y=x:0:99"] }

Circular arena:
{ "ranges": ["ring:50,50,40", "border:0"] }`,
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter'),
            operation: z.enum(['add', 'remove']).describe('Add or remove terrain'),
            terrainType: z.enum(['obstacles', 'difficultTerrain', 'water']).describe('Type of terrain to modify'),
            tiles: z.array(z.string()).optional().describe('Array of "x,y" coordinate strings (use this OR ranges)'),
            ranges: z.array(z.string()).optional().describe('Array of range shortcuts like "row:5", "col:10", "rect:0,0,10,10", "border:0"'),
            gridWidth: z.number().int().min(1).max(500).default(100).describe('Grid width for range calculations'),
            gridHeight: z.number().int().min(1).max(500).default(100).describe('Grid height for range calculations')
        }).refine(data => data.tiles || data.ranges, {
            message: 'Either tiles or ranges must be provided'
        })
    },
    PLACE_PROP: {
        name: 'place_prop',
        description: `Place an improvised prop/object on the battlefield during combat.

Props are free-form terrain features with rich description that can be interacted with.
Think: ladders, wagons, trees, buildings, towers, cliffs, chandeliers, etc.

⚠️ HEIGHT SEMANTICS (CRITICAL):
- heightFeet describes the PROP'S visual/physical height, NOT entity position
- A 30ft cliff at (5,5) is visually tall 
- Entities standing ON such a prop use position (5,5, z=0), NOT z=30!
- The terrain height is implicit in the visualization

🏗️ PROP TYPES:
- cliff: Stacked rocky terrain with slopes
- wall: Stone/brick barriers  
- bridge: Spanning structures over gaps
- tree: Vegetation cover
- stairs: Stepped access to elevation
- pit: Below-ground areas (negative Y)

Cover Types (D&D 5e):
- half: +2 AC (waist-high wall, thick furniture)
- three_quarter: +5 AC (arrow slit, portcullis)
- full: Total cover (complete obstruction)

Example - Climbable cliff with slopes adjacent:
{
  "encounterId": "encounter-1",
  "position": "15,20",
  "label": "Rocky Cliff",
  "propType": "structure",
  "heightFeet": 25,
  "cover": "half",
  "climbable": true,
  "climbDC": 12,
  "description": "A 25ft rocky outcrop. Adjacent tiles (14,20), (16,20) slope down."
}`,
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter'),
            position: z.string().describe('Position as "x,y" coordinate string'),
            label: z.string().describe('Free-text label (e.g., "Burning Cart", "Watch Tower", "Rope Bridge")'),
            propType: z.enum(['structure', 'cover', 'climbable', 'hazard', 'interactive', 'decoration'])
                .describe('General category of prop'),
            heightFeet: z.number().int().min(0).optional().describe('Height in feet for elevated props'),
            cover: z.enum(['none', 'half', 'three_quarter', 'full']).optional().default('none')
                .describe('Cover provided by this prop'),
            climbable: z.boolean().optional().default(false).describe('Can this be climbed?'),
            climbDC: z.number().int().min(0).max(30).optional().describe('Athletics DC to climb (if climbable)'),
            breakable: z.boolean().optional().default(false).describe('Can this be destroyed?'),
            hp: z.number().int().min(1).optional().describe('Hit points (if breakable)'),
            description: z.string().optional().describe('Rich narrative description of the prop')
        })
    },
    MEASURE_DISTANCE: {
        name: 'measure_distance',
        description: `Calculate the distance between two points or entities on the battlefield.
Returns distance in feet (5ft per square, diagonal = 5ft using D&D simplified rules).

Example - Between two coordinates:
{
  "encounterId": "encounter-1",
  "from": { "type": "position", "value": "10,10" },
  "to": { "type": "position", "value": "15,18" }
}

Example - Between two entities:
{
  "encounterId": "encounter-1",
  "from": { "type": "entity", "value": "hero-1" },
  "to": { "type": "entity", "value": "goblin-3" }
}

Example - From entity to position:
{
  "encounterId": "encounter-1",
  "from": { "type": "entity", "value": "wizard-1" },
  "to": { "type": "position", "value": "25,30" }
}`,
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter'),
            from: z.object({
                type: z.enum(['position', 'entity']),
                value: z.string().describe('Either "x,y" coordinate or entity ID')
            }),
            to: z.object({
                type: z.enum(['position', 'entity']),
                value: z.string().describe('Either "x,y" coordinate or entity ID')
            })
        })
    },
    GENERATE_TERRAIN_PATCH: {
        name: 'generate_terrain_patch',
        description: `Generate a terrain patch using procedural noise or preset patterns.
Much easier than placing individual tiles - LLM describes the area and this tool generates it.

Biome Presets:
- forest: Trees (climbable props), undergrowth (difficult terrain), paths
- cave: Rocky walls (obstacles), stalactites (props), pools (water)  
- village: Buildings (obstacle clusters), roads (clear), market stalls (props)
- dungeon: Walls (obstacles), rubble (difficult), traps (hazards)
- swamp: Water, lily pads (props), dead trees, difficult terrain
- battlefield: Barricades, craters (difficult), debris (props)

Density: 0.1 (sparse) to 1.0 (dense)

Example - Generate a forest clearing:
{
  "encounterId": "encounter-1",
  "biome": "forest",
  "origin": { "x": 10, "y": 10 },
  "width": 20,
  "height": 20,
  "density": 0.4,
  "seed": "goblin-ambush",
  "clearCenter": true
}

Example - Dungeon room:
{
  "encounterId": "encounter-1",
  "biome": "dungeon",
  "origin": { "x": 0, "y": 0 },
  "width": 15,
  "height": 12,
  "density": 0.6,
  "seed": "throne-room"
}`,
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter'),
            biome: z.enum(['forest', 'cave', 'village', 'dungeon', 'swamp', 'battlefield'])
                .describe('Biome preset to use'),
            origin: z.object({
                x: z.number().int(),
                y: z.number().int()
            }).describe('Top-left corner of the patch'),
            width: z.number().int().min(5).max(100).describe('Width of the patch in tiles'),
            height: z.number().int().min(5).max(100).describe('Height of the patch in tiles'),
            density: z.number().min(0.1).max(1.0).default(0.5)
                .describe('How densely packed (0.1=sparse, 1.0=very dense)'),
            seed: z.string().optional().describe('Seed for reproducible generation'),
            clearCenter: z.boolean().optional().default(false)
                .describe('Keep the center area clear (for player spawn)'),
            pattern: z.enum(['river_valley', 'canyon', 'arena', 'mountain_pass']).optional()
                .describe('Use a terrain pattern template instead of biome generation')
        })
    },
    
    /**
     * Generate terrain with a specific geometric pattern
     */
    GENERATE_TERRAIN_PATTERN: {
        name: 'generate_terrain_pattern',
        description: `Generate terrain using a pattern template. ONE CALL generates entire layout.

PATTERNS:
- maze: Full procedural maze (corridors & walls) - USE THIS FOR MAZES
- maze_rooms: Maze with open chambers/rooms connected by corridors
- river_valley: Cliff walls on east/west with river in center
- canyon: Parallel walls east-west with pass between
- arena: Circular wall enclosing fighting area
- mountain_pass: Narrowing corridor toward center

MAZE EXAMPLE (100x100 in ONE call):
{
  "encounterId": "enc-1",
  "pattern": "maze",
  "origin": { "x": 0, "y": 0 },
  "width": 100,
  "height": 100,
  "seed": "maze-runner-001"
}

MAZE WITH ROOMS:
{
  "pattern": "maze_rooms",
  "width": 100,
  "height": 100,
  "roomCount": 8
}`,
        inputSchema: z.object({
            encounterId: z.string().describe('The ID of the encounter'),
            pattern: z.enum(['river_valley', 'canyon', 'arena', 'mountain_pass', 'maze', 'maze_rooms'])
                .describe('Terrain pattern to generate'),
            origin: z.object({
                x: z.number().int(),
                y: z.number().int()
            }).default({ x: 0, y: 0 }).describe('Top-left corner of the pattern'),
            width: z.number().int().min(10).max(500).default(100).describe('Width of the pattern area'),
            height: z.number().int().min(10).max(500).default(100).describe('Height of the pattern area'),
            seed: z.string().optional().describe('Seed for reproducible generation'),
            corridorWidth: z.number().int().min(1).max(5).default(1).describe('Width of corridors (maze patterns only)'),
            roomCount: z.number().int().min(0).max(20).default(5).describe('Number of rooms (maze_rooms pattern only)')
        })
    }
} as const;

// Tool handlers
export async function handleCreateEncounter(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.CREATE_ENCOUNTER.inputSchema.parse(args);
    // Crypto dice unless the caller seeds the fight: a seed makes the stream
    // replayable (tests, audits); without one every die is crypto.randomInt.
    const seed = parsed.seed;

    // Create combat engine
    const engine = seed ? new CombatEngine(seed, pubsub || undefined) : CombatEngine.crypto(pubsub || undefined);

    // Convert participants to proper format (preserve isEnemy, position, and resistances)
    const participants: CombatParticipant[] = parsed.participants.map(p => {
        // Auto-lookup monster stats from presets so AC and damage resolve even
        // when the LLM omits them. Only when the caller gave neither ac nor
        // attackDamage: a hand-built statline is never overridden by a namesake.
        const preset = p.ac === undefined && p.attackDamage === undefined ? matchPreset(p.name) : undefined;

        // FINDINGS #26: participants backed by a real character row inherit its
        // AC (and table-rules band, regeneration, parts, legendary counters,
        // lair) when the caller did not supply them — an omitted `ac` silently
        // defaulted to 10 at resolution while output looked correct (the
        // soft-AC trap). Caller beats row beats preset, field by field.
        const row = p.id ? new CharacterRepository(getDb()).findById(p.id) : null;
        const extras = hydrateExtras(p, row as ExtrasRow | null, preset);

        const id = p.id || randomUUID();
        const participant = {
            // CRITICAL FIX: Auto-generate ID if not provided to prevent React key collisions
            id,
            // The caller's name is kept ('Goblin 2' stays 'Goblin 2').
            name: p.name,
            hp: p.hp,
            maxHp: p.maxHp,
            ...(p.initiative !== undefined ? { initiative: p.initiative } : {}),
            initiativeBonus: p.initiativeBonus ?? 0,
            isEnemy: p.isEnemy ?? false,
            // Callers send names or character-row {name, ...} entries; the
            // engine and the encounter token schema need Condition objects.
            conditions: normalizeConditions(p.conditions, id),
            position: p.position,
            resistances: p.resistances,
            vulnerabilities: p.vulnerabilities,
            immunities: p.immunities,
            ...(p.unit ? { unit: p.unit } : {}),
            ...(p.intent ? { intent: p.intent } : {}),
            ...(p.abilityScores ? { abilityScores: p.abilityScores } : {}),
            ...extras,
            // Play report 7 #3: an assumed band stays marked until set_band.
            ...(p.bandAssumed && extras.band ? { bandAssumed: true } : {}),
            hasLairActions: extras.hasLairActions ?? false,
            // Size and speed live on the participant itself, not only on the token.
            size: extras.size ?? 'medium',
            movementSpeed: extras.movementSpeed ?? 30
        } as CombatParticipant;

        return participant;
    });

    // Surprise: the named participants lose their round-1 turn and cannot
    // react until it has passed. An id that names nobody is refused before
    // anything is written.
    if (parsed.surprised?.length) {
        const ids = new Set(participants.map(p => p.id));
        const unknown = parsed.surprised.filter(id => !ids.has(id));
        if (unknown.length) throw new Error(`surprised names no participant: ${unknown.join(', ')} (participants: ${[...ids].join(', ')})`);
        for (const p of participants) if (parsed.surprised.includes(p.id)) p.surprised = true;
    }

    // Play report 7 #7 (lane F): declared initiative. Untagged initiative /
    // check:dex mechanics on a token's effects (and tagged ones its
    // participants[].context asserts) roll two d20s; a given initiative rolls
    // nothing. Read here, never stored on the token.
    const declaredInit = initiativeDeclarations(parsed.participants.map((p, i) => ({ id: participants[i].id, name: p.name, initiative: p.initiative, context: p.context })));

    // Generate encounter ID
    // The random suffix keeps two creates with one seed in the same millisecond
    // (a batch) from colliding on id.
    const encounterId = `encounter-${seed ?? 'combat'}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    // Lane L: minted before the start, so a call the engine prints at create (a
    // surprised first slot's offered legendary resistance) names this fight.
    engine.encounterId = encounterId;

    // Start encounter
    // Lane O: the medium is known before the start, so a surprised first slot's turn start (and the next one) takes its pressure.
    const state = engine.startEncounter(participants, { initiativeSources: declaredInit.sources, saverSides: engineSaverSides(() => getDb()), ...(parsed.environment ? { environment: parsed.environment } : {}) });

    // CRIT-003: Add terrain to state if provided
    if (parsed.terrain && state) {
        (state as any).terrain = parsed.terrain;
    }
    // The medium the fight happens in; air when omitted. Water (or water
    // cells) changes the first turn's movement budget, set before either.
    if (parsed.environment && state) {
        state.environment = parsed.environment;
    }
    if (state && (parsed.environment?.medium === 'water' || parsed.terrain?.water?.length)) {
        for (const p of state.participants) p.movementRemaining = engine.effectiveSpeed(p);
    }

    // Store with session namespace
    getCombatManager().create(`${ctx.sessionId}:${encounterId}`, engine);

    // Persist initial state
    const db = getDb();
    const repo = new EncounterRepository(db);

    // Create the encounter record first (with initiative and isEnemy).
    // PR #57 follow-up: persist ac/attackDamage/attackBonus too — those drive
    // attack resolution, and omitting them on initial create made loadState()
    // (before any saveState) drop back to the default-AC-10 fallback.
    repo.create({
        id: encounterId,
        tokens: state.participants.map(p => ({
            id: p.id,
            name: p.name,
            initiativeBonus: p.initiativeBonus,
            initiative: p.initiative,    // Store rolled initiative
            isEnemy: p.isEnemy,          // Store enemy flag
            hasLairActions: p.hasLairActions,  // PR #59 follow-up: persist lair flag so loadState can rebuild the LAIR slot
            hp: p.hp,
            maxHp: p.maxHp,
            conditions: p.conditions,
            abilityScores: p.abilityScores,
            // Combat stats used by the attack resolver
            ac: p.ac,
            attackDamage: p.attackDamage,
            attackBonus: p.attackBonus,
            // Damage modifiers — drop them and post-load attacks lose half/2x/immune behavior
            resistances: p.resistances,
            vulnerabilities: p.vulnerabilities,
            immunities: p.immunities,
            // Spatial visualization data
            position: p.position,
            movementSpeed: p.movementSpeed ?? 30,
            size: p.size ?? 'medium',
            band: p.band,
            regeneration: p.regeneration,
            parts: p.parts,
            unit: p.unit,
            intent: p.intent,
            senses: p.senses
        })),
        round: state.round,
        activeTokenId: state.turnOrder[state.currentTurnIndex],
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    // Lane O: a surprised first slot passed at create ticked its turn start and end
    // (pressure, ongoing damage): owe what they owe, and write the HP they took
    // to the sheets they took it from (only those: a create never syncs a sheet).
    const ticks = await settleTurnDamage(engine, encounterId);
    for (const id of new Set((ticks.turnDamage ?? []).map(t => t.participantId))) {
        const p = state.participants.find(x => x.id === id);
        const charRepo = new CharacterRepository(db);
        if (p && charRepo.findById(id)?.id === id) charRepo.update(id, { hp: p.hp });
    }
    // F1: repo.create validates a hand-listed token map; save the whole engine
    // state straight after so every participant field and the RNG position
    // (rngState, refreshed by getState) are stored from the first write.
    repo.saveState(encounterId, engine.getState()!);

    // Build response with BOTH text and JSON
    // Include sessionId in state JSON so frontend knows which session to query
    // dice: 'crypto' or 'seeded:<seed>' — which dice this fight rolls.
    // Play report 7 #9: the order and who is first up, as fields and one line.
    const initiative = initiativeRows(state, {
        given: new Set(parsed.participants.filter(p => p.initiative !== undefined).map(p => p.id)),
        surprised: new Set(parsed.surprised ?? []),
        declared: engine.initiativeDeclared
    });
    const firstUp = firstUpOf(state);
    const stateJson = {
        ...buildStateJson(state, encounterId, ctx.sessionId), dice: engine.describeDice(), initiative, firstUp,
        // Play report 7 #7 (lane F): a context tag that fired nothing on a token's initiative.
        ...(declaredInit.warnings.length ? { warnings: declaredInit.warnings } : {}),
        // Lane H review: a surprised first slot's save_ends saves, as advance reports them (output_mode summary keeps them).
        ...(engine.endOfTurnSaves.length ? { endOfTurnSaves: engine.endOfTurnSaves } : {}),
        // Lane L: a legendary resistance those saves offered, with the call to paste (output_mode summary keeps it whole).
        ...(engine.legendaryOffers.length ? { legendaryOffers: engine.legendaryOffers } : {}),
        // Lane O: the ticks that slot's turn dealt, as advance reports them.
        ...(ticks.turnDamage ? { turnDamage: ticks.turnDamage } : {}),
        ...(ticks.breakTests ? { breakTests: ticks.breakTests } : {}),
        ...(ticks.unitLines ? { unitLines: ticks.unitLines } : {}),
        ...(ticks.killed.length ? { killed: ticks.killed } : {})
    };
    const formattedText = formatCombatStateText(state, encounterId);

    let output = `⚔️ COMBAT STARTED\n`;
    output += `Encounter ID: ${encounterId}\n`;
    output += `Dice: ${engine.describeDice()}\n`;
    output += `${initiativeBannerLine(initiative, firstUp)}\n`;
    // A surprised first actor's slot already passed (and ticked) at start.
    for (const note of engine.turnStartNotes) output += `${note}\n`;
    for (const line of [...ticks.lines, ...killedLines(ticks.killed)]) output += `${line}\n`;
    output += formattedText;
    
    // Append JSON for frontend parsing (marked clearly)
    output += `\n\n<!-- STATE_JSON\n${JSON.stringify(stateJson)}\nSTATE_JSON -->`;

    return {
        content: [
            {
                type: 'text' as const,
                text: output
            }
        ]
    };
}

export async function handleGetEncounterState(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.GET_ENCOUNTER_STATE.inputSchema.parse(args);
    let engine = getCombatManager().get(`${ctx.sessionId}:${parsed.encounterId}`);

    // Auto-load from database if not in memory
    if (!engine) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        const state = repo.loadState(parsed.encounterId);

        if (!state) {
            throw new Error(`Encounter ${parsed.encounterId} not found.`);
        }

        // Create engine and load state
        engine = new CombatEngine(parsed.encounterId, pubsub || undefined);
        engine.loadState(state);
        getCombatManager().create(`${ctx.sessionId}:${parsed.encounterId}`, engine);
    }

    // Get current state from engine
    const state = engine.getState();
    if (!state) {
        throw new Error('No active encounter');
    }

    // PLAYTEST-FIX: Sync HP from character database before display
    // This ensures character_manage updates are reflected in combat state
    syncParticipantHpFromDb(state);

    // CRITICAL: Match create_encounter's format exactly
    // Frontend uses extractEmbeddedStateJson which looks for <!-- STATE_JSON ... STATE_JSON -->
    // Include sessionId in state JSON so frontend knows which session to query
    const stateJson = buildStateJson(state, parsed.encounterId, ctx.sessionId);
    const formattedText = formatCombatStateText(state, parsed.encounterId);
    
    let output = `📋 ENCOUNTER STATE\n`;
    output += `Encounter ID: ${parsed.encounterId}\n`;
    output += formattedText;
    
    // Append JSON for frontend parsing (same format as create_encounter)
    output += `\n\n<!-- STATE_JSON\n${JSON.stringify(stateJson)}\nSTATE_JSON -->`;
    
    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}

export async function handleExecuteCombatAction(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.EXECUTE_COMBAT_ACTION.inputSchema.parse(args);
    let engine = getCombatManager().get(`${ctx.sessionId}:${parsed.encounterId}`);

    // Auto-load from database if not in memory
    if (!engine) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        const state = repo.loadState(parsed.encounterId);

        if (!state) {
            throw new Error(`Encounter ${parsed.encounterId} not found.`);
        }

        engine = new CombatEngine(parsed.encounterId, pubsub || undefined);
        engine.loadState(state);
        getCombatManager().create(`${ctx.sessionId}:${parsed.encounterId}`, engine);
    }

    // Read character_manage HP changes before this action writes HP back.
    const syncState = engine.getState();
    if (syncState) syncParticipantHpFromDb(syncState);

    // Turn-identity advisory (issue #49). Every action routed through this
    // handler (attack / cast_spell / move / dash / dodge / help / heal /
    // disengage / ready) is an on-turn action. If actorId doesn't match the
    // active participant, surface a warning so the caller can see the
    // misuse — we don't throw because reactions aren't modeled yet and
    // some legitimate flows could be disrupted. A stricter mode can be
    // layered on top later.
    let turnWarning: string | undefined;
    // Play report 7 #6: the same off-turn fact as data (the warning sits after
    // the STATE_JSON, and output_mode summary cuts it).
    let offTurn: { actorId: string; activeId: string; activeName: string } | undefined;
    {
        const liveState = engine.getState();
        if (liveState) {
            const activeId = liveState.turnOrder[liveState.currentTurnIndex];
            if (
                activeId &&
                parsed.actorId !== activeId &&
                // Play report 7 #10: a controlled mount acts on its rider's turn.
                !onActiveTurn(liveState, parsed.actorId) &&
                // Ignore if the supplied actorId isn't a real participant —
                // the action handler will produce a clearer error downstream.
                liveState.participants.some((p) => p.id === parsed.actorId)
            ) {
                // LAIR turns are still off-turn for participant actions: only
                // the lair_action tool may resolve during initiative-20 LAIR.
                const isLair = activeId === 'LAIR';
                const activeLabel = isLair
                    ? 'LAIR action'
                    : (liveState.participants.find((p) => p.id === activeId)?.name ?? activeId);
                turnWarning = `off_turn_action: ${parsed.actorId} acting during ${activeLabel}'s turn`;
                offTurn = { actorId: parsed.actorId, activeId, activeName: activeLabel };
            }
        }
    }

    // Play report 7 #10: a controlled mount may only Dash, Disengage or Dodge
    // (and move); attack, cast_spell, heal are refused before anything is spent.
    {
        const liveState = engine.getState();
        const steedRefusal = liveState ? controlledMountActionRefusal(liveState, parsed.actorId, parsed.action, { reaction: !!parsed.reaction }) : undefined;
        if (steedRefusal) {
            const refusal = new Error(steedRefusal) as Error & { writes?: string };
            refusal.writes = 'none';
            throw refusal;
        }
    }

    let result: CombatActionResult | undefined;
    let output = '';

    // Helper to determine action type from casting time
    const parseCastingTime = (castingTime: string): 'action' | 'bonus' | 'reaction' => {
        const lower = castingTime.toLowerCase();
        if (lower.includes('bonus')) return 'bonus';
        if (lower.includes('reaction')) return 'reaction';
        return 'action';
    };

    // Item 9: a world's own spell of this name casts on its rule, not the SRD.
    let worldSpell: { rule: TableRule<'spell'>; worldId: string } | undefined;
    if (parsed.action === 'cast_spell' && parsed.spellName) {
        const worldId = resolveWorldId(getDb(), { encounterId: parsed.encounterId, characterIds: [parsed.actorId] });
        const rule = findWorldRule(getDb(), worldId, 'spell', parsed.spellName);
        if (rule && worldId) worldSpell = { rule, worldId };
    }

    if (worldSpell) {
        const targetIds = parsed.targetIds?.length
            ? parsed.targetIds
            : parsed.targetId ? parsed.targetId.split(',').map(t => t.trim()).filter(Boolean) : [];
        const cast = await castWorldSpell({
            engine, db: getDb(), rule: worldSpell.rule, worldId: worldSpell.worldId,
            actorId: parsed.actorId, targetIds, unbinderId: parsed.unbinderId, damage: parsed.damage, boost: parsed.boost,
            // Play report 7 follow-up (lane S): an area world spell (its rule's area) on a unit goes model by model;
            // castWorldSpell refuses a spaced unit with no count and notes a count an unmarked spell does not use.
            modelsInArea: parsed.modelsInArea as ModelsInArea | undefined,
            // Lane K: a concentration save's legendary resistance offer names this fight.
            encounterId: parsed.encounterId
        });
        output = cast.output;
        result = cast.result;
        // Play report 5 #5: a world spell's damage follows the dying track to
        // the sheets: a drop mirrors Unconscious + Prone, a death runs the kill.
        const worldEffects = (cast.result as { worldSpell?: { effects?: Array<{ targetId: string; name: string; dying?: DyingUpdate }> } }).worldSpell?.effects ?? [];
        const worldKilled: KilledRecord[] = [];
        const worldCaster = engine.getState()?.participants.find(p => p.id === parsed.actorId)?.name ?? parsed.actorId;
        for (const ef of worldEffects) {
            if (!ef.dying) continue;
            if (ef.dying.dropped) markRowDying(ef.targetId);
            if (ef.dying.dead) {
                const k = await settleDeath({ id: ef.targetId, name: ef.name }, `${worldSpell.rule.name} cast by ${worldCaster}${ef.dying.instantDeath ? ' (massive damage)' : ' (third failed death save)'}`, parsed.encounterId);
                if (k) worldKilled.push(k);
            }
        }
        const firstWorldDying = worldEffects.find(ef => ef.dying)?.dying;
        if (firstWorldDying) result.dying = firstWorldDying;
        if (worldKilled.length) {
            output += `\n${killedLines(worldKilled).join('\n')}\n`;
            (result as { killed?: unknown }).killed = worldKilled;
        }
    } else if (parsed.action === 'attack') {
        // Validation & Auto-Calculation
        let attackBonus = parsed.attackBonus;
        let dc = parsed.dc;
        let damage: number | string | undefined = parsed.damage;
        let damageType = parsed.damageType;
        let ranged = parsed.ranged;
        const outcome = parsed.outcome;

        const currentState = engine.getState();
        const actor = currentState?.participants.find(p => p.id === parsed.actorId);
        const target = currentState?.participants.find(p => p.id === parsed.targetId);

        // Named attack profiles (token, else sheet) and the part that swings.
        // using/weapon picks a profile, which fills whatever the call omits;
        // with nothing named and no bonus, the default (or sole) profile
        // stands in for the STR/DEX guess below.
        // The actor's sheet, read once: profiles, fighting style and (item 16) the superiority pool.
        const actorRow = new CharacterRepository(getDb()).findById(parsed.actorId);
        const profiles = actor?.attacks?.length ? actor.attacks : (actorRow?.attacks ?? []);
        const named = parsed.using ?? parsed.weapon;
        const sourceOpts = { using: parsed.using, weapon: parsed.weapon, withPart: parsed.withPart, hand: parsed.hand };
        let source = actor ? resolveAttackSource({ parts: actor.parts, attacks: profiles }, sourceOpts) : { notes: [] as string[] };
        let defaulted = false;
        if (actor && !source.profile && !named && parsed.attackBonus === undefined && !outcome) {
            const fallback = profiles.find(a => a.default) ?? (profiles.length === 1 ? profiles[0] : undefined);
            if (fallback) {
                source = resolveAttackSource({ parts: actor.parts, attacks: profiles }, { ...sourceOpts, using: fallback.name });
                defaulted = true;
            }
        }
        const profile = source.profile;
        if (profile) {
            attackBonus ??= profile.attackBonus;
            damage ??= profile.damage;
            damageType ??= profile.damageType;
            ranged ??= profile.ranged;
        }
        // Play report 5, item 3: a bonus-action attack and the trigger it
        // needs, from the call or the profile (Goring Rush carries both).
        const bonusAction = parsed.bonusAction ?? profile?.bonusAction ?? false;
        const requires = parsed.requires ?? profile?.requires;
        // A refusal that lands before any roll or write says so (writes: none).
        const refuseNone = (message: string): never => {
            const refusal = new Error(message) as Error & { writes?: string };
            refusal.writes = 'none';
            throw refusal;
        };
        // The part the engine checks: a real withPart wins; a withPart that
        // named a profile gives way to the profile's part; an unknown one is
        // passed on so the engine refuses it, listing parts and profiles.
        const withPartIsPart = !!(parsed.withPart && actor && findPart(actor, parsed.withPart));
        const withPartWasProfile = !!(parsed.withPart && !withPartIsPart && !named && !defaulted && profile);
        const withPart = parsed.withPart && !withPartIsPart && !withPartWasProfile ? parsed.withPart : source.part?.name;

        // A GM-resolved attack (outcome) skips every auto-fill below: no d20 is
        // rolled, so attack bonus and AC are unused, and the posted damage is
        // the total (0 means 0; no trait damage lane is added on top).
        if (outcome && outcome !== 'miss' && damage === undefined) {
            throw new Error(`outcome '${outcome}' needs the damage you rolled (a number, or dice to roll)`);
        }
        if (outcome) {
            attackBonus = attackBonus ?? 0;
            dc = dc ?? 0;
            damage = damage ?? 0;
        }

        // 1. Attack Bonus - auto-calculate from multiple sources
        if (attackBonus === undefined) {
            // First: try preset on participant
            if (actor?.attackBonus !== undefined) {
                attackBonus = actor.attackBonus;
            }
            // Second: calculate from participant ability scores
            else if (actor?.abilityScores) {
                const strMod = Math.floor((actor.abilityScores.strength - 10) / 2);
                const dexMod = Math.floor((actor.abilityScores.dexterity - 10) / 2);
                // Use higher of STR/DEX (simple heuristic for melee vs ranged)
                const abilityMod = Math.max(strMod, dexMod);
                // Default proficiency +2 (participant doesn't track level)
                const proficiency = 2;
                attackBonus = abilityMod + proficiency;
            }
            // Third: try to load from character DB
            else {
                const attackDb = getDb();
                const charRepo = new CharacterRepository(attackDb);
                const character = charRepo.findById(parsed.actorId);
                if (character?.stats) {
                    const strMod = Math.floor((character.stats.str - 10) / 2);
                    const dexMod = Math.floor((character.stats.dex - 10) / 2);
                    const abilityMod = Math.max(strMod, dexMod);
                    const proficiency = Math.floor((character.level - 1) / 4) + 2;
                    attackBonus = abilityMod + proficiency;
                }
            }
        }
        if (attackBonus === undefined) {
            throw new Error('Attack action requires attackBonus (could not be auto-calculated from actor stats)');
        }

        // RESOLVER v1 (Findings #19): consume autoApply-flagged trait mechanics.
        // Bare/prose-conditional mechanics stay GM-declared by design.
        const resolverDb = getDb();
        const autoApplied: import('../../engine/effects-resolver.js').AutoApplication[] = [];
        const actorMechs = loadAutoMechanics(resolverDb, parsed.actorId);
        attackBonus += autoAttackBonus(actorMechs, autoApplied);
        // RESOLVER v2 (FINDINGS #60): declared-effects channel — GM names the
        // conditional trait; engine computes the value (fixed or pool-derived)
        // and applies it to the attack bonus. Problems report loudly, apply nothing.
        const declaredEffectRefs = (parsed as { declaredEffects?: Array<{ name: string; lane?: string }> }).declaredEffects ?? [];
        const resolverProblems: string[] = [];
        // FINDINGS #74: attack-lane problems are HELD until the damage lane has
        // run — a ref that applies on either lane gets its no-mechanic noise on
        // the other lane dropped (a damage-only trait is not an attack-lane
        // fault, and vice versa). A ref inert on BOTH lanes still shouts.
        let attackLaneProblems: string[] = [];
        if (declaredEffectRefs.length) {
            const dres = applyDeclaredEffects(resolverDb, parsed.actorId, declaredEffectRefs, 'attack_bonus', autoApplied);
            attackBonus += dres.total;
            attackLaneProblems = dres.problems;
        }

        // 2. Target AC (DC). Aiming at a part with its own AC (a chain, a
        // shield) rolls against the part, and body AC bonuses do not apply.
        const aimedArmour = parsed.atPart && target ? findPart(target, parsed.atPart) : undefined;
        const partAc = !outcome && (dc === undefined || dc === 0) && aimedArmour?.ac !== undefined ? aimedArmour.ac : undefined;
        if (partAc !== undefined) {
            dc = partAc;
        } else if (!outcome && (dc === undefined || dc === 0)) {
            if (target?.ac !== undefined) {
                dc = target.ac;
            } else {
                // FINDINGS #26: before the heuristic, honor the character row —
                // covers encounters created before create-time hydration existed.
                const rowChar = parsed.targetId ? new CharacterRepository(resolverDb).findById(parsed.targetId) : undefined;
                if (rowChar?.ac !== undefined) {
                    dc = rowChar.ac;
                } else {
                    // Heuristic: 10 + dex mod (if available) or just 10
                    const dex = target?.abilityScores?.dexterity ?? 10;
                    const dexMod = Math.floor((dex - 10) / 2);
                    dc = 10 + dexMod;
                }
            }
        }
        const targetMechs = parsed.targetId ? loadAutoMechanics(resolverDb, parsed.targetId) : [];
        dc = partAc !== undefined ? partAc : (dc ?? 0) + autoAcBonus(targetMechs, autoApplied);
        // Item 17: the target's defense style adds +1 to a derived AC (token or
        // sheet, never an aimed part or a dc the GM passed) while it wears
        // armour. A sheet whose ac already counts it should not set defense.
        let targetDefense: { style: 'defense'; acBonus: number; note: string } | undefined;
        if (!outcome && partAc === undefined && (parsed.dc === undefined || parsed.dc === 0) && parsed.targetId) {
            const targetStyle = target?.fightingStyle ?? new CharacterRepository(resolverDb).findById(parsed.targetId)?.fightingStyle;
            if (targetStyle === 'defense' && wearsArmour(resolverDb, parsed.targetId)) {
                dc += 1;
                targetDefense = { style: 'defense', acBonus: 1, note: 'derived AC + 1 (armour worn); pass dc if the sheet already counts it' };
            }
        }

        // Play report 5 #1: cover. The GM's value wins; else the target's
        // standing cover and the map (props, creatures on the line of fire),
        // the best single source; the profile's or the sheet's ignoreCover
        // lifts what it names. Total cover refuses here, before any Help,
        // surge, manoeuvre or ammo is spent (writes: none). The engine adds
        // the bonus to the AC and prints the arithmetic.
        let coverRes: CoverResolution | undefined;
        if (actor && target) {
            const lane: 'ranged' | 'melee' = (ranged ?? (actor.position && target.position
                ? edgeDistanceSquares(actor, target) * 5 > effectiveReachFt(actor, profile?.reachFt !== undefined ? { reachFt: profile.reachFt } : undefined)
                : false)) ? 'ranged' : 'melee';
            const ignore = profile?.ignoreCover ?? ignoreCoverFor(actor.ignoreCover ?? (actorRow as { ignoreCover?: IgnoreCoverScopes } | null)?.ignoreCover, lane);
            coverRes = resolveCover(currentState!, actor, target, { explicit: parsed.cover, ignoreCover: ignore });
            if (coverRes.kind === 'total') throw totalCoverRefusal(coverRes, actor.name, target.name);
        }

        // Play report 7 #7 (lane F): declared advantage on this attack, in its
        // own lane (the lane cover and fighting style read). Untagged attack /
        // attack:<lane> mechanics on the attacker's effects fire by themselves;
        // tagged ones on `context` or when named. A named source grants only
        // what declares it for this attack (lane E's resolver); anything else
        // refuses the attack here, before any roll or spend (writes: none,
        // sourceProblems). situationalAdvantage is the GM's one-off ('GM:
        // downhill'); advantage: true is 'GM'. A posted outcome rolls nothing,
        // so names are not checked (the engine notes the sources as ignored).
        const attackCtx = (parsed.context ?? []).map(t => t.trim()).filter(Boolean);
        const sitAdv = parsed.situationalAdvantage?.trim() || undefined;
        const sitDis = parsed.situationalDisadvantage?.trim() || undefined;
        // Lane F review: a volley is the unit's fire (it cannot be non-lethal,
        // and a unit in melee volleys a step down), so it reads the ranged side
        // whatever the grid says, theatre of mind included.
        const attackLane: AttackLane = parsed.volley ? 'ranged'
            : actor && target ? attackLaneOf(actor, target, { ranged, reachFt: profile?.reachFt }) : (ranged ? 'ranged' : 'melee');
        const attackDecl = attackDeclarations(parsed.actorId, attackCtx);
        const namedSides: DeclaredSides = { advantage: [], disadvantage: [] };
        const namedEffects = new Set<string>();
        const advTexts = parsed.advantageSources ?? [], disTexts = parsed.disadvantageSources ?? [];
        if (!outcome && (advTexts.length || disTexts.length)) {
            const sheetConditions = ((actorRow as { conditions?: Array<{ name?: unknown; source?: unknown }> } | null)?.conditions ?? [])
                .filter(c => c && typeof c.name === 'string')
                .map(c => ({ name: String(c.name), source: typeof c.source === 'string' ? c.source : undefined, on: 'sheet' as const }));
            const owner: DeclaringOwner = {
                ownerId: parsed.actorId, ownerName: actor?.name ?? actorRow?.name ?? parsed.actorId,
                effects: attackDecl.effects,
                traits: (actorRow as { skillAdvantage?: DeclaringOwner['traits'] } | null)?.skillAdvantage ?? [],
                conditions: [
                    ...(actor?.conditions ?? []).map(c => ({ name: String(c.type), source: c.sourceId, level: typeof c.metadata?.level === 'number' ? c.metadata.level : undefined, on: 'token' as const })),
                    ...sheetConditions
                ]
            };
            const roll = { kind: 'attack' as const, range: attackLane };
            const adv = resolveAdvantageSources(advTexts, 'advantage', owner, roll, attackCtx);
            const dis = resolveAdvantageSources(disTexts, 'disadvantage', owner, roll, attackCtx);
            const problems = [...adv.problems, ...dis.problems];
            if (problems.length) {
                const refusal = new Error(`${owner.ownerName} cannot attack with these sources: ${problems.join(' | ')} Name what declares it for this ${attackLane} attack (an effect with an advantage_on / disadvantage_on mechanic scoped attack or attack:${attackLane}, a standard condition's 5e rule), or pass situationalAdvantage: '<reason>' for your own ruling. Nothing was rolled or spent.`) as Error & { writes?: string; sourceProblems?: string[] };
                refusal.writes = 'none';
                refusal.sourceProblems = problems;
                throw refusal;
            }
            // A named untagged mechanic fires by itself anyway (labelled with its
            // scope); a tagged one named reads '(tag, named)', a condition its name.
            for (const g of [...adv.granted, ...dis.granted]) if (g.via === 'effect') namedEffects.add(g.name.toLowerCase());
            const added = (g: { via: string; lane: string }) => !(g.via === 'effect' && g.lane === 'ENGINE');
            namedSides.advantage.push(...adv.granted.filter(added).map(g => g.label));
            namedSides.disadvantage.push(...dis.granted.filter(added).map(g => g.label));
        }
        const gmSides: DeclaredSides = {
            advantage: [...(parsed.advantage ? ['GM'] : []), ...(sitAdv ? [`GM: ${sitAdv}`] : [])],
            disadvantage: [...(parsed.disadvantage ? ['GM'] : []), ...(sitDis ? [`GM: ${sitDis}`] : [])]
        };
        const attackDeclared: Partial<Record<AttackLane, DeclaredSides>> = {
            melee: mergeSides(gmSides, attackDecl[parsed.volley ? 'ranged' : 'melee'], namedSides),
            ranged: mergeSides(gmSides, attackDecl.ranged, namedSides)
        };
        // A tagged mechanic nobody asserted is told its tag and its name; a tag that fired nothing is said.
        const laneDecl = attackDecl[attackLane];
        const tagHint = (which: 'advantage' | 'disadvantage') => (g: { effect: string; tag: string }) => `${g.effect} (${g.tag}): pass context: ['${g.tag}'] or ${which}Sources: ['${g.effect}'] when it holds`;
        const conditionalAdvantage = attackCtx.length || outcome ? [] : laneDecl.gated.filter(g => g.which === 'advantage' && !namedEffects.has(g.effect.toLowerCase())).map(tagHint('advantage'));
        const conditionalDisadvantage = attackCtx.length || outcome ? [] : laneDecl.gated.filter(g => g.which === 'disadvantage' && !namedEffects.has(g.effect.toLowerCase())).map(tagHint('disadvantage'));
        const unfiredTags = attackCtx.filter(t => !laneDecl.firedTags.includes(normTag(t)));

        // 3. Damage - auto-calculate from multiple sources
        if (!outcome && (damage === undefined || damage === 0)) {
            // First: try preset on participant
            if (actor?.attackDamage) {
                damage = actor.attackDamage;
            }
            // Second: try to load from character DB
            else {
                const dmgDb = getDb();
                const dmgCharRepo = new CharacterRepository(dmgDb);
                const character = dmgCharRepo.findById(parsed.actorId);
                if (character?.stats) {
                    // Default damage: 1d8 + STR/DEX mod (simple weapon heuristic)
                    const strMod = Math.floor((character.stats.str - 10) / 2);
                    const dexMod = Math.floor((character.stats.dex - 10) / 2);
                    const abilityMod = Math.max(strMod, dexMod);
                    damage = abilityMod >= 0 ? `1d8+${abilityMod}` : `1d8${abilityMod}`;
                }
            }
            // Third: fallback to simple 1d6 damage
            if (!damage) {
                damage = '1d6';
            }
        }

        if (!parsed.targetId) {
            throw new Error('Attack action requires targetId');
        }

        // FINDINGS #70: THE DAMAGE LANE — flat trait damage, engine-computed.
        // autoApply damage_bonus mechanics fire themselves; declaredEffects rows
        // with a damage_bonus mechanic resolve here too (same refs the GM already
        // passed — one declaration can carry attack AND damage lanes of a trait).
        // Value sources: fixed, valueFromPool, valueFromProficiency (#70 —
        // Odinets scales with level; hard-coding +2 kills it silently at L5).
        // Applied AFTER crit doubling, BEFORE resistance, inside executeAttack.
        let damageLaneBonus = outcome ? 0 : autoDamageBonus(actorMechs, autoApplied);
        let damageLaneProblems: string[] = [];
        if (!outcome && declaredEffectRefs.length) {
            const ddres = applyDeclaredEffects(resolverDb, parsed.actorId, declaredEffectRefs, 'damage_bonus', autoApplied);
            damageLaneBonus += ddres.total;
            damageLaneProblems = ddres.problems;
        }
        // FINDINGS #74: cross-lane noise suppression — one declaration feeds
        // both lanes, so 'no X mechanic' is only a fault when the ref applied
        // on NEITHER lane. Real faults (missing row, malformed, ambiguous
        // lanes) always pass through.
        {
            const appliedRefNames = new Set(autoApplied.filter(a => a.declared).map(a => a.effect.toLowerCase()));
            const crossLaneNoise = (p: string) => {
                const m = p.match(/^declared effect "(.+?)": no (attack_bonus|damage_bonus) mechanic/);
                return !!m && appliedRefNames.has(m[1].toLowerCase());
            };
            resolverProblems.push(...attackLaneProblems.filter(p => !crossLaneNoise(p)));
            resolverProblems.push(...damageLaneProblems.filter(p => !crossLaneNoise(p)));
        }
        const damageLaneLabel = autoApplied.filter(a => a.type === 'damage_bonus').map(a => a.effect).join(' + ') || undefined;

        // Validate Action Economy. A legendary action spends legendary
        // actions and a reaction the reaction, so neither is off-turn misuse;
        // any other attack is one swing of the Attack action (multiattack
        // keeps the action open between swings).
        if (parsed.legendaryCost !== undefined && parsed.reaction) {
            throw new Error('An attack is a legendary action or a reaction, not both');
        }
        if (parsed.legendaryCost !== undefined && parsed.actionSurge) {
            throw new Error('An attack is a legendary action or an Action Surge, not both');
        }
        if (parsed.reaction && parsed.actionSurge) {
            throw new Error('An attack is a reaction or an Action Surge, not both');
        }
        if (bonusAction && (parsed.reaction || parsed.legendaryCost !== undefined || parsed.actionSurge)) {
            const other = parsed.reaction ? 'a reaction' : parsed.legendaryCost !== undefined ? 'a legendary action' : 'an Action Surge';
            refuseNone(`An attack is a bonus action or ${other}, not both`);
        }
        // Play report 5, item 4: non-lethal is melee only (5e), one blow on one
        // body. Refused before any spend; a shot the grid infers is refused by
        // the engine before Help is spent.
        const nonlethal = parsed.nonlethal === true;
        if (nonlethal) {
            const who = actor?.name ?? parsed.actorId, whom = target?.name ?? parsed.targetId;
            if (ranged === true) refuseNone(`${who} cannot knock ${whom} out with a ranged attack: non-lethal blows are melee only (5e)`);
            if (parsed.volley) refuseNone(`a volley cannot be non-lethal: melee only (5e)`);
            if (parsed.cleave) refuseNone(`a cleave cannot be non-lethal: melee only (5e), one blow on one body`);
            if (target?.unit) refuseNone(`${whom} is a unit: a non-lethal blow knocks out one creature, not a formation`);
        }
        // actionSurge: a spent action is reopened by a ready action-granting
        // ability (the token's, else the sheet's). Found here, spent right
        // before the roll so a table-rules refusal spends nothing.
        let surge: { ability: Ability; onToken: boolean } | undefined;
        let surgeNoop = false;
        if (parsed.legendaryCost !== undefined) {
            const problem = engine.legendaryActionProblem(parsed.actorId, parsed.legendaryCost)
                ?? (engine.canTakeActions(parsed.actorId) ? undefined : 'Participant is incapacitated');
            if (problem) throw new Error(problem);
            turnWarning = undefined;
        } else if (bonusAction) {
            // Play report 5: the bonus action is the actor's own turn's, and it
            // is refused here, before anything is spent (the plain attack lane
            // only warns off-turn; the bonus lane refuses).
            const live = engine.getState()!;
            const activeId = live.turnOrder[live.currentTurnIndex];
            if (activeId !== parsed.actorId) {
                const active = activeId === 'LAIR' ? 'the LAIR' : (live.participants.find(p => p.id === activeId)?.name ?? activeId);
                refuseNone(`${actor?.name ?? parsed.actorId} can make a bonus-action attack only on its own turn (it is ${active}'s turn)`);
            }
            if (!engine.canTakeActions(parsed.actorId)) refuseNone(`${actor?.name ?? parsed.actorId} is incapacitated`);
            const validation = engine.validateActionEconomy(parsed.actorId, 'bonus');
            if (!validation.valid) refuseNone(validation.error ?? 'Bonus action unavailable');
            turnWarning = undefined;
        } else {
            const validation = parsed.reaction
                ? engine.validateActionEconomy(parsed.actorId, 'reaction')
                : engine.validateAttackEconomy(parsed.actorId);
            if (!validation.valid) {
                if (parsed.actionSurge && !parsed.reaction) {
                    const want: true | string = parsed.actionSurge === true ? true : String(parsed.actionSurge);
                    const found = findActionGrantAcross(actor?.abilities, new CharacterRepository(getDb()).findById(parsed.actorId)?.abilities, want);
                    if ('problem' in found) throw new Error(`${validation.error}; ${found.problem}`);
                    surge = found;
                } else {
                    throw new Error(validation.error);
                }
            } else if (parsed.actionSurge && !parsed.reaction) {
                surgeNoop = true;
            }
            if (parsed.reaction) turnWarning = undefined;
        }

        // Play report 5: the trigger the swing needs (a Dash, feet after it, a
        // melee hit on the target), checked before any spend; the refusal
        // names exactly what is missing.
        let trigger: AttackTriggerFacts | undefined;
        if (requires && actor) {
            const evaluated = evaluateAttackTrigger(actor, requires, { label: profile?.name ?? 'this attack', targetId: parsed.targetId, movedFt: parsed.movedFt });
            if (evaluated.problem) refuseNone(evaluated.problem);
            trigger = evaluated.facts;
        }

        // Table rules: the world's called-strike and prepared-asset rules are
        // checked before the roll so a refused strike spends nothing.
        const rulesDb = getDb();
        const ruleWorld = resolveWorldId(rulesDb, { encounterId: parsed.encounterId, characterIds: [parsed.actorId, parsed.targetId ?? ''] });
        // The band ladder that holds both bands (a world may import several).
        const bandRule = bandRuleFor(rulesDb, ruleWorld, [actor?.band, target?.band]);
        const ruleBands = bandRule?.spec.order ?? bandOrderFor(rulesDb, ruleWorld, [actor?.band, target?.band]);
        // Request 11: the band gap's damage multiplier, when the rule opts in.
        const bandScale = parsed.bandScale === false ? null : bandDamageMultiplier(bandRule, actor?.band, target?.band);
        let strikeRule: TableRule<'called_strike'> | undefined;
        let preparedRule: TableRule<'prepared_asset'> | undefined;
        if (parsed.calledStrike && target?.unit) throw new Error(`Called strikes are against a single opponent; ${target.name} is a unit`);
        if (parsed.calledStrike) {
            strikeRule = loadRule(rulesDb, ruleWorld, 'called_strike');
            if (!strikeRule) throw new Error(`calledStrike needs an enabled called_strike rule in this encounter's world${ruleWorld ? '' : ' (the encounter has no world: create it with worldId)'}`);
            if (actor && target) {
                const problem = calledStrikeProblem(strikeRule, ruleBands, actor, target, parsed.calledStrike, parsed.atPart, {
                    // Play report 7 #3: the band refusal names the call that fixes it, and an assumed band says so.
                    // Review: across two ladders, the order shown is the other side's ladder.
                    fix: (move, other) => `Set it: ${setBandCall(parsed.encounterId, move.id)} (order: ${(other.band ? bandOrderFor(rulesDb, ruleWorld, [other.band]) : ruleBands).join(' < ')})`,
                    tag: bandAssumedTag(actor, target)
                });
                if (problem) throw new Error(problem);
            }
        }
        if (parsed.cleave) {
            if (!target?.unit) throw new Error(`Cleave goes through packed lower-band units; ${target?.name ?? parsed.targetId} is not a unit`);
            if (!target.unit.packed) throw new Error(`${target.name} is spaced: spacing prevents cleave`);
            const cmp = actor ? compareBands(ruleBands, actor.band, target.band) : null;
            if (cmp === null) {
                // Review of play report 7 #3: two bands on different ladders are
                // not "unset"; the fix names the ladder of the other side's band.
                const unranked = actor ? bandsUnranked('Cleave', actor, target) : undefined;
                const ladder = unranked?.other.band ? bandOrderFor(rulesDb, ruleWorld, [unranked.other.band]) : ruleBands;
                throw new Error(`${unranked?.problem ?? `Cleave needs both bands set (unset for ${parsed.actorId})`}. Set it: ${setBandCall(parsed.encounterId, unranked?.move.id ?? parsed.actorId)} (order: ${ladder.join(' < ')})`);
            }
            if (cmp <= 0) throw new Error(`Never cleave peers: ${target.name} (${target.band}) is not below ${actor!.name} (${actor!.band})${bandAssumedTag(actor, target)}`);
        }
        if (parsed.preparedAsset) {
            preparedRule = loadRule(rulesDb, ruleWorld, 'prepared_asset', parsed.preparedAsset);
            if (!preparedRule) throw new Error(`No enabled prepared_asset rule named '${parsed.preparedAsset}' in this encounter's world`);
        }

        // Item 16: a Battle Master manoeuvre. Refused before any roll or write
        // when the sheet cannot pay for it (writes: none); the engine rolls
        // the die into the attack (precision) or the damage (the rest).
        let plan: { name: ManeuverName; def: ManeuverDef; die: string; poolKey: string; poolBefore: number; dc?: number } | undefined;
        if (parsed.maneuver) {
            const found = findSuperiorityPool(actorRow?.resourcePools as Record<string, { current: number }> | undefined);
            const problem = maneuverProblem(parsed.maneuver, {
                outcome, volley: !!parsed.volley, cleave: !!parsed.cleave,
                sheet: actorRow ? { superiorityDie: actorRow.superiorityDie } : null,
                pool: found?.pool, reaction: !!parsed.reaction, ranged: ranged === true,
                lastMeleeMisses: actor?.lastMeleeMisses, round: currentState?.round,
                actorName: actor?.name ?? parsed.actorId, targetId: parsed.targetId, targetName: target?.name ?? parsed.targetId
            });
            if (problem) {
                const refusal = new Error(problem) as Error & { writes?: string };
                refusal.writes = 'none';
                throw refusal;
            }
            const def = MANEUVERS[parsed.maneuver];
            plan = {
                name: parsed.maneuver, def, die: actorRow!.superiorityDie!, poolKey: found!.key, poolBefore: found!.pool.current,
                ...(def.save ? { dc: maneuverSaveDC(worldProgression(rulesDb, ruleWorld).profBonus(actorRow!.level), maneuverAbilityMod(actorRow!.stats, actorRow!.maneuverAbility)) } : {})
            };
        }

        // Every refusal is behind us: spend the surge. The ability is marked
        // spent where it was found; a token grant with no recharge is mirrored
        // to the sheet so the next fight starts with it spent.
        let surgeInfo: { spent: true; ability: string; source: 'token' | 'sheet'; mirroredToCharacter: boolean } | undefined;
        if (surge) {
            const granted = engine.grantExtraAction(parsed.actorId);
            if (!granted.ok) throw new Error(granted.error);
            if (surge.onToken) surge.ability.ready = false;
            const mirroredToCharacter = (!surge.onToken || !surge.ability.recharge) ? patchRowAbility(getDb(), parsed.actorId, surge.ability.name, false).found : false;
            const again = engine.validateAttackEconomy(parsed.actorId);
            if (!again.valid) throw new Error(again.error);
            surgeInfo = { spent: true, ability: surge.ability.name, source: surge.onToken ? 'token' : 'sheet', mirroredToCharacter };
        }

        // Use the new detailed attack method with optional damageType for HIGH-002
        result = engine.executeAttack(
            parsed.actorId,
            parsed.targetId,
            attackBonus!,
            dc!,
            damage!,
            damageType,  // HIGH-002: Pass damage type for resistance calculation
            // Play report 4: an explicit false and an unset flag are the same
            // straight roll (volley passes its flags through here too).
            !!parsed.advantage,
            !!parsed.disadvantage,
            damageLaneBonus || undefined,  // FINDINGS #70: resolver damage lane
            damageLaneLabel,
            outcome,
            parsed.unaffectedLimb,
            {
                withPart, atPart: parsed.atPart, uncapped: !!(parsed.cleave || parsed.volley), ranged, ignoreConditions: parsed.ignoreConditions, ...(bandScale ? { bandScale } : {}),
                ...(nonlethal ? { nonlethal: true } : {}),
                // Item 17: the style on the token, else the sheet; how this swing is made.
                fightingStyle: actor?.fightingStyle ?? actorRow?.fightingStyle,
                twoHanded: parsed.twoHanded ?? profile?.twoHanded,
                offhand: parsed.hand === 'offhand',
                // Dueling wants no other weapon: an equipped off-hand weapon (not a shield) turns it off.
                dualWielding: (actor?.fightingStyle ?? actorRow?.fightingStyle) === 'dueling' ? wieldsOffhandWeapon(getDb(), parsed.actorId) : undefined,
                reachFt: profile?.reachFt,
                // Play report 5 #1: the cover resolved above (the engine resolves it itself when unset).
                ...(coverRes ? { cover: coverRes } : {}),
                // Play report 7 #7 (lane F): the declared sources per lane; the engine reads this attack's.
                declared: attackDeclared,
                // Item 16: the superiority die, into the damage or (precision) the attack.
                ...(plan && plan.def.dieTo === 'damage' ? { extraDamageDice: [{ dice: plan.die, label: `superiority die (${plan.name})` }] } : {}),
                ...(plan && plan.name === 'precision' ? { attackBonusDie: { dice: plan.die, label: 'superiority die (precision)', onlyIfMiss: true, maxMissBy: dieMax(plan.die) } } : {})
            }
        );

        // Sync HP to character database after attack
        if (result.success && result.damage && result.damage > 0) {
            const db = getDb();
            const charRepo = new CharacterRepository(db);

            // Get updated target HP from combat state and sync to character DB
            const updatedState = engine.getState();
            const targetParticipant = updatedState?.participants.find(p => p.id === parsed.targetId);
            if (targetParticipant) {
                const targetChar = charRepo.findById(parsed.targetId);
                if (targetChar) {
                    charRepo.update(parsed.targetId, { hp: targetParticipant.hp });
                }
            }
        }
        // Play report 5, item 4: the knockout reaches the sheet as Unconscious
        // sourced 'nonlethal: <actor>' — the key every heal lane reads to wake it.
        if (result.knockedOut) {
            mirrorConditionToRow(parsed.targetId, 'add', 'Unconscious', undefined, nonlethalSource(parsed.actorId));
        }
        // Request 5: shields drained by the hit go back to the row's pool.
        if (result.success && result.shieldsAbsorbed) {
            const shielded = engine.getState()?.participants.find(p => p.id === parsed.targetId);
            if (shielded) persistShieldsToDb(shielded);
        }

        // Play report 7 (lane H): the concentration save's sources, for the reply below (only when it took one).
        let attackConcentration: (ConcentrationOutcome & { targetId: string; name: string }) | undefined;
        // Lane K: a legendary resistance offered on that save, for the reply's top-level legendaryOffers.
        let attackLegendaryOffer: LegendaryReplyRow | undefined;
        // Check concentration if target took damage and is concentrating
        if (result.success && result.damage && result.damage > 0) {
            const db = getDb();
            const concentrationRepo = new ConcentrationRepository(db);
            const charRepo = new CharacterRepository(db);
            const targetChar = charRepo.findById(parsed.targetId);

            // Lane H review: a blow that drops the target to 0 HP ends its spell
            // outright (below), with no CON save: a save there printed '✓ held'
            // over a spell that had just ended.
            if (targetChar && concentrationRepo.isConcentrating(parsed.targetId) && !result.defeated) {
                // RESOLVER v1: autoApply saving_throw_bonus (con-filtered) feeds the hold.
                const conMechs = loadAutoMechanics(getDb(), parsed.targetId);
                const conBonus = conMechs.filter(m => m.type === 'saving_throw_bonus' && (!m.condition || 'constitution'.includes(m.condition.toLowerCase()) || m.condition.toLowerCase().includes('con'))).reduce((s, m) => s + m.value, 0);
                // Play report 7 (lane H): the target's declared save:con sides and conditions, on the fight's dice.
                const concentrationCheck = checkConcentration(targetChar, result.damage, concentrationRepo, conBonus,
                    fightConcentrationDie(engine, db, parsed.targetId));
                // Lane K: a failed save spends a legendary resistance (the spell holds) or offers one (reversible with saveRef).
                const held = concentrationCheck.broken ? concentrationRepo.findByCharacterId(parsed.targetId) : null;
                const legendary = held ? fightConcentrationLegendary(engine, db, parsed.targetId, parsed.encounterId, held) : undefined;
                if (legendary?.holds) { concentrationCheck.broken = false; concentrationCheck.reason = 'damage'; }
                attackLegendaryOffer = legendary?.row;
                if (concentrationLabelled(concentrationCheck) || legendary) {
                    attackConcentration = { targetId: parsed.targetId, name: targetChar.name, ...concentrationOutcome({ ...concentrationCheck, ...legendary?.fields }) };
                }
                if (concentrationCheck.broken) {
                    // Break concentration
                    breakConcentration(
                        { characterId: parsed.targetId, reason: 'damage', damageAmount: result.damage },
                        concentrationRepo,
                        charRepo
                    );
                }
            }

            // D&D 5e Rule: Dropping to 0 HP automatically breaks concentration
            if (result.defeated && parsed.targetId) {
                const concentrationRepo = new ConcentrationRepository(db);
                if (concentrationRepo.isConcentrating(parsed.targetId)) {
                    const targetChar = charRepo.findById(parsed.targetId);
                    if (targetChar) {
                        breakConcentration(
                            { characterId: parsed.targetId, reason: 'death' },
                            concentrationRepo,
                            charRepo
                        );
                    }
                }
            }
        }

        // #66: JAM CHECK OWED — the engine does not resolve the jam; it flags
        // that the natural die landed inside the equipped weapon's jam band
        // (01 §7: nat 1 under cond 75, nat 1-2 under 50, nat 1-3 under 25) so
        // the jam law is never quietly skipped. Reads the actor's mainhand
        // instance condition — same JOIN as the status block.
        try {
            const natDie = (result.attackRoll as { roll?: number } | undefined)?.roll;
            if (typeof natDie === 'number' && natDie <= 3) {
                const jamDb = getDb();
                const mh = jamDb.prepare(`
                    SELECT i.name AS name, i.id AS templateId FROM inventory_items inv
                    JOIN items i ON i.id = inv.item_id
                    WHERE inv.character_id = ? AND inv.equipped = 1 AND inv.slot = 'mainhand'
                `).get(parsed.actorId) as { name?: string; templateId?: string } | undefined;
                if (mh?.templateId) {
                    const inst = jamDb.prepare(`
                        SELECT condition, custom_name FROM item_instances
                        WHERE owner_character_id = ? AND template_id = ?
                    `).get(parsed.actorId, mh.templateId) as { condition?: number; custom_name?: string } | undefined;
                    if (inst && typeof inst.condition === 'number' && inst.condition < 75) {
                        const band = inst.condition >= 50 ? 1 : inst.condition >= 25 ? 2 : 3;
                        if (natDie <= band) {
                            (result as unknown as Record<string, unknown>).jamCheckOwed = {
                                weapon: inst.custom_name || mh.name,
                                condition: inst.condition,
                                jamsOn: band === 1 ? 'nat 1' : band === 2 ? 'nat 1-2' : 'nat 1-3'
                            };
                        }
                    }
                }
            }
        } catch { /* no instance row — template guns carry no jam band */ }

        // Table rules after the hit: called-strike cripples, peer
        // consequences due, prepared-asset tiers. The engine computes; the
        // GM names the flavour.
        const ruleLines: string[] = [];
        const resultRec = result as unknown as Record<string, unknown>;
        // Play report 7 #7 (lane F): the GM's one-offs and the tags as given, a
        // tag that fired nothing, and the tag a tagged mechanic waits for.
        if (sitAdv) resultRec.situationalAdvantage = sitAdv;
        if (sitDis) resultRec.situationalDisadvantage = sitDis;
        if (attackCtx.length) resultRec.context = attackCtx;
        if (unfiredTags.length && !outcome) result.situational = [...(result.situational ?? []), `context [${unfiredTags.join(', ')}] fired nothing on this ${attackLane} attack: no tagged attack or attack:${attackLane} mechanic on ${actor?.name ?? parsed.actorId} declares it`];
        // Lane F review: a posted outcome rolls nothing, so the names were not
        // checked; say which, rather than dropping them without a word.
        if (outcome && (advTexts.length || disTexts.length)) {
            const unchecked = [advTexts.length ? `adv: ${advTexts.join(', ')}` : '', disTexts.length ? `dis: ${disTexts.join(', ')}` : ''].filter(Boolean).join('; ');
            result.situational = [...(result.situational ?? []), `named sources not checked: posted outcome, no roll (${unchecked})`];
        }
        if (conditionalAdvantage.length) resultRec.conditionalAdvantage = conditionalAdvantage;
        if (conditionalDisadvantage.length) resultRec.conditionalDisadvantage = conditionalDisadvantage;
        for (const c of [...conditionalAdvantage, ...conditionalDisadvantage]) result.situational = [...(result.situational ?? []), `conditional: ${c}`];
        const afterState = engine.getState();
        const actorNow = afterState?.participants.find(p => p.id === parsed.actorId);
        const targetNow = afterState?.participants.find(p => p.id === parsed.targetId);
        // Play report 5 #5: the sheet follows the dying track. A drop to 0
        // mirrors Unconscious + Prone (source dying); death runs the kill.
        if (result.dying && targetNow) {
            const settled = await settleAttackDying(result, targetNow, actorNow?.name ?? parsed.actorId, parsed.encounterId);
            if (settled.killed) resultRec.killed = settled.killed;
            ruleLines.push(...settled.lines);
        }
        if (strikeRule && parsed.calledStrike && targetNow) {
            const limb = parsed.calledStrike.toLowerCase();
            const landing = resolveCalledStrike(strikeRule, targetNow, parsed.calledStrike, parsed.atPart);
            if (result.partHit?.broken) {
                // The aimed part was severed by the hit: nothing left to cripple.
                resultRec.calledStrike = { rule: strikeRule.name, limb, crippled: false, part: result.partHit.name, severed: true };
                ruleLines.push(`RULE ${strikeRule.name}: ${targetNow.name}'s ${result.partHit.name} severed`);
            } else if (result.success && !('problem' in landing)) {
                // The cripple lands on a named part (the target's own, the one
                // aimed at, or the limb), which the engine reads for speed and attacks.
                const part = crippledPart(strikeRule, landing);
                // Merged, not replaced: a latch, holds or ac on that part survive.
                targetNow.parts = upsertPart(targetNow.parts ?? [], part);
                engine.refreshVessel(targetNow);
                if (charRepoFor(targetNow.id)) new CharacterRepository(getDb()).update(targetNow.id, { parts: targetNow.parts } as never);
                resultRec.calledStrike = { rule: strikeRule.name, limb, crippled: true, part: part.name, notes: part.note };
                // Play report 7 #3: the peer check read an assumed band.
                const assumed = (strikeRule.spec as { requirePeer?: boolean }).requirePeer ? bandAssumedTag(actorNow, targetNow) : '';
                ruleLines.push(`RULE ${strikeRule.name}: ${targetNow.name}'s ${part.name} crippled until repaired${part.note ? ` (${part.note})` : ''}${assumed}`);
            } else {
                resultRec.calledStrike = { rule: strikeRule.name, limb, crippled: false };
                ruleLines.push(`RULE ${strikeRule.name}: called strike at the ${limb} missed`);
            }
        }
        // A hit on an armoured part never touched the body: no consequence.
        if (actorNow && targetNow && !result.partHit) {
            for (const peerRule of loadRules(rulesDb, ruleWorld, 'peer_consequence')) {
                const due = peerConsequence(peerRule, ruleBands, actorNow, targetNow, result);
                if (!due) continue;
                if ('skipped' in due) { ruleLines.push(`RULE skipped: ${due.skipped}`); continue; }
                const setPart = `combat_manage set_part {encounterId: '${parsed.encounterId}', participantId: '${targetNow.id}', part: '${parsed.atPart ?? '<part>'}', state: 'crippled' | 'dead' | 'breached'}`;
                resultRec.consequenceDue = { ...due, setPart };
                ruleLines.push(`CONSEQUENCE DUE (${due.rule}${due.direction === 'down' ? ', from above' : ''}): ${due.reason}${bandAssumedTag(actorNow, targetNow)}. GM names it: ${due.options.join(' / ')}; record it with ${setPart} (or add_condition)`);
            }
        }
        if (preparedRule) {
            const prepared = preparedOutcome(preparedRule, result);
            resultRec.preparedEffectDue = prepared;
            ruleLines.push(`RULE ${prepared.rule}: ${prepared.tier.toUpperCase()}${prepared.margin !== undefined ? ` (margin ${prepared.margin >= 0 ? '+' : ''}${prepared.margin})` : ''}, ${prepared.note}`);
        }

        if (targetDefense && targetNow) {
            resultRec.fightingStyle = { ...((result.fightingStyle ?? {}) as Record<string, unknown>), targetDefense };
            ruleLines.push(`⚖️ ${targetNow.name} defense +1 AC (armour worn)`);
        }
        // Play report 5 #1: cover a posted outcome could not use, and the
        // attacker leaving its own standing cover for the round.
        if (typeof result.cover?.ignored === 'string') {
            ruleLines.push(`🛡 ${targetNow?.name ?? parsed.targetId} has ${result.cover.kind} cover (${result.cover.source}): not applied, ${result.cover.ignored}`);
        }
        const breaks = parsed.breaksCover ? 'breaksCover' : profile?.breaksCover ? profile.name : undefined;
        if (breaks && actorNow && afterState) {
            actorNow.coverBrokenRound = afterState.round;
            resultRec.coverBroken = { round: afterState.round, by: breaks, ...(actorNow.cover ? { cover: actorNow.cover } : {}) };
            ruleLines.push(`🛡 ${actorNow.name} leaves cover to attack${actorNow.cover ? ` (${actorNow.cover.level}${actorNow.cover.reason ? `, ${actorNow.cover.reason}` : ''})` : ''}: standing cover off until round ${afterState.round + 1}`);
        }
        // Item 16: the manoeuvre's spend and effect. The die is spent only
        // when it was rolled; the pool debit carries the reason on its history.
        if (plan && actorNow && targetNow) {
            const used = plan.name === 'precision' ? !!result.attackBonusDie : result.success;
            const maneuver: Record<string, unknown> = {
                name: plan.name, die: plan.die, spent: used, addedTo: plan.def.dieTo,
                pool: { before: plan.poolBefore, after: used ? plan.poolBefore - 1 : plan.poolBefore }
            };
            if (plan.name === 'precision') {
                if (result.attackBonusDie) Object.assign(maneuver, { roll: result.attackBonusDie.roll, before: result.attackBonusDie.before, after: result.attackBonusDie.after, turnedHit: result.attackBonusDie.turnedHit });
                else if (result.attackBonusDieSkipped) maneuver.note = result.attackBonusDieSkipped;
            } else if (result.extraDamage?.[0]) {
                maneuver.roll = result.extraDamage[0].total;
                maneuver.rolls = result.extraDamage[0].rolls;
            }
            if (used) {
                const repo = new CharacterRepository(getDb());
                const fresh = repo.findById(parsed.actorId);
                if (fresh) {
                    const { updates } = applyScheduledOps(fresh, [{ op: 'adjust_pool', pool: plan.poolKey, delta: -1 }], { reason: `superiority die (${plan.name}) vs ${targetNow.name}` });
                    repo.update(parsed.actorId, updates as never);
                }
            }
            if (used && plan.def.save && plan.dc !== undefined) {
                if (targetNow.hp <= 0) {
                    // The blow dropped the target: a creature at 0 HP makes no
                    // save and is neither tripped, frightened nor disarmed by
                    // the engine (the GM narrates the body); the die still landed.
                    maneuver.applied = { note: `${targetNow.name} is down: no save, the blow dropped it (the die still landed)` };
                } else if (plan.def.maxTargetSize && sizeRank(targetNow.size) > sizeRank(plan.def.maxTargetSize)) {
                    maneuver.applied = { note: `${targetNow.name} is ${targetNow.size ?? 'medium'}: too large to trip (${plan.def.maxTargetSize} at most); the die still lands` };
                } else {
                    const save = rollParticipantSave(engine, getDb(), targetNow, plan.def.save, plan.dc, { purpose: `${plan.name} save vs ${actorNow.name}` });
                    maneuver.dc = plan.dc;
                    maneuver.save = {
                        ability: save.ability, dc: plan.dc, natural: save.natural, total: save.total, saved: save.saved, ...(save.legendaryResisted ? { legendaryResisted: true } : {}),
                        // Lane L review: a failed save's offer (a player character is asked, never spent for).
                        ...(save.legendaryResistanceAvailable ? { legendaryResistanceAvailable: save.legendaryResistanceAvailable } : {}),
                        ...(save.legendaryResistanceAskPlayer ? { legendaryResistanceAskPlayer: true } : {}),
                        // Play report 7 (lane G1): the target's declared save sides and conditions, both dice.
                        ...(save.rolls.length > 1 ? { rolls: save.rolls } : {}),
                        ...(save.advantageSources ? { advantageSources: save.advantageSources } : {}),
                        ...(save.disadvantageSources ? { disadvantageSources: save.disadvantageSources } : {}),
                        ...(save.conditionalAdvantage ? { conditionalAdvantage: save.conditionalAdvantage } : {}),
                        ...(save.conditionalDisadvantage ? { conditionalDisadvantage: save.conditionalDisadvantage } : {})
                    };
                    const row = saveSourcesRow({ id: targetNow.id, name: targetNow.name }, save);
                    if (row) resultRec.saveSources = [row];
                    if (!save.saved) maneuver.applied = applyManeuverEffect(engine, plan.def, actorNow, targetNow, parsed.maneuverItem);
                }
            }
            resultRec.maneuver = maneuver;
            const save = maneuver.save as { ability: string; natural: number; total: number; saved: boolean; rolls?: number[]; advantageSources?: string[]; disadvantageSources?: string[]; legendaryResisted?: boolean; legendaryResistanceAvailable?: number; legendaryResistanceAskPlayer?: boolean } | undefined;
            // Lane L review: a legendary resistance spent on the save, or offered after it failed.
            const legendaryNote = !save ? ''
                : save.legendaryResisted ? ' (legendary resistance)'
                : save.legendaryResistanceAvailable ? `; ⭐ ${save.legendaryResistanceAvailable} legendary resistance(s) left: ${save.legendaryResistanceAskPlayer ? 'ask the player' : 'the GM may spend one'}` : '';
            const applied = maneuver.applied as { condition?: string; dropped?: string | null; part?: string; note?: string } | undefined;
            const appliedLine = !applied ? ''
                : applied.condition === 'prone' ? `; ${targetNow.name} is prone`
                : applied.condition === 'frightened' ? `; ${targetNow.name} is frightened of ${actorNow.name} until the end of ${actorNow.name}'s next turn`
                : applied.dropped ? `; ${targetNow.name} drops ${applied.dropped} (${applied.part})`
                : `; ${applied.note}`;
            ruleLines.push(`RULE maneuver ${plan.name}: ${used
                ? `superiority die ${plan.die} = ${maneuver.roll} on the ${plan.def.dieTo} (${plan.poolBefore} → ${plan.poolBefore - 1} left)`
                : `not spent (${maneuver.note ?? 'the attack missed'}; ${plan.poolBefore} left)`}${save ? `; ${save.ability.slice(0, 3).toUpperCase()} save ${save.total} vs DC ${plan.dc} ${save.saved ? 'saved' : 'FAILED'}${saveSidesNote({ ...save, rolls: save.rolls ?? [save.natural] })}${legendaryNote}` : ''}${appliedLine}`);
        }
        for (const note of source.notes) ruleLines.push(`⚖️ ${note}`);
        for (const note of (result.situational ?? []).slice().reverse()) ruleLines.unshift(`⚖️ ${note}`);
        if (profile) {
            resultRec.attackProfile = { name: profile.name, attackBonus: profile.attackBonus, damage: profile.damage, ...(profile.damageType ? { damageType: profile.damageType } : {}), ...(source.part ? { part: source.part.name } : {}), ...(defaulted ? { default: true } : {}) };
            ruleLines.unshift(`🗡 using ${profile.name} (${profile.attackBonus >= 0 ? '+' : ''}${profile.attackBonus}, ${profile.damage}${profile.damageType ? ` ${profile.damageType}` : ''})${source.part ? ` with ${source.part.name}` : ''}${defaulted ? ' [default profile]' : ''}`);
        }
        if (parsed.volley) {
            resultRec.volley = parsed.volley;
            ruleLines.unshift(`VOLLEY ${parsed.volley.dice} (${parsed.volley.reason})`);
        }
        if (result.bandScale && bandRule) {
            const bs = result.bandScale;
            ruleLines.push(`RULE ${bandRule.name}: ${actorNow?.band ?? actor?.band} ${bs.steps > 0 ? `${bs.steps} above` : `${-bs.steps} below`} ${targetNow?.band ?? target?.band}: damage ×${bs.multiplier} (${bs.before} → ${bs.after})${bandAssumedTag(actorNow ?? actor, targetNow ?? target)}`);
        }
        // Play report 7 #3: a cleave goes through a lower band; an assumed one says so.
        if (parsed.cleave && targetNow?.unit && bandAssumedTag(actorNow ?? actor, targetNow)) {
            ruleLines.push(`RULE cleave: through ${targetNow.name} (${targetNow.band}) below ${(actorNow ?? actor)?.name} (${(actorNow ?? actor)?.band})${bandAssumedTag(actorNow ?? actor, targetNow)}`);
        }
        if (targetNow?.unit) {
            const t = volleyTier(targetNow);
            resultRec.targetUnit = { models: t?.models, maxModels: t?.maxModels, volley: t?.dice ?? null, wounds: woundLine(targetNow) };
            ruleLines.push(`UNIT ${targetNow.name}: ${describeUnit(targetNow)}`);
            // Item 12: a unit carried through its breakAt owes a break test.
            const due = result.target ? breakTestDue(targetNow, result.target.hpBefore, { moraleBonus: moraleModifiers(targetNow, afterState?.participants ?? [], sheetSpecies(getDb())) }) : null;
            if (due) {
                resultRec.breakTests = [due];
                ruleLines.push(due.line);
            }
        }

        // Play report 5: a knockout is not a kill — no growth credit, no corpse.
        if (result.knockedOut && targetNow && actorNow) {
            ruleLines.push(`💤 ${targetNow.name} knocked out by ${actorNow.name} (stable; no death saves, no kill, no corpse). Healing above 0 wakes them`);
        }
        // Growth tracks: a kill feeds the killer's growth pool (more for a
        // victim of its band or above). The next form is offered, never taken.
        // The same hook apply_damage and sheet execute use (creditKill).
        // Play report 7 #1: a unit credits each model the blow killed, wiped or not.
        const unitKills = targetNow?.unit && result.target ? modelsKilledBetween(targetNow.unit, result.target.hpBefore, targetNow.hp) : undefined;
        const killCredited = unitKills !== undefined ? unitKills > 0 : !!(result.target && result.target.hpBefore > 0 && targetNow && targetNow.hp <= 0);
        if (killCredited && targetNow && actorNow && !result.knockedOut) {
            const credit = await creditKill(rulesDb, ruleWorld, parsed.actorId, { id: targetNow.id, name: targetNow.name, band: targetNow.band, ...(targetNow.bandAssumed ? { bandAssumed: true } : {}) }, actorNow.band, unitKills ?? 1);
            if (credit) {
                resultRec.growth = credit;
                ruleLines.push(growthLine(credit));
                // A condition an auto step put on the sheet reaches the live token too.
                growthConditionsOnToken(engine, parsed.actorId, credit);
            }
        }

        // Commit Action Economy: legendary actions, the reaction, or one
        // attack of the Attack action.
        if (parsed.legendaryCost !== undefined) {
            const spent = engine.useLegendaryAction(parsed.actorId, parsed.legendaryCost);
            resultRec.legendary = { cost: parsed.legendaryCost, remaining: spent.remaining };
            ruleLines.push(`👑 legendary action (cost ${parsed.legendaryCost}): ${spent.remaining} left`);
        } else if (parsed.reaction) {
            engine.commitAction(parsed.actorId, 'reaction');
            resultRec.reaction = true;
            ruleLines.push('↩ reaction spent');
        } else if (bonusAction) {
            // Play report 5: the bonus action only — attacksMade and the Attack
            // action are untouched, so an open multiattack carries on.
            engine.commitAction(parsed.actorId, 'bonus');
            resultRec.bonusAction = { spent: true, ...(trigger ? { trigger } : {}) };
            ruleLines.push(`⚡ bonus action spent${profile ? ` (${profile.name}${trigger ? `: ${triggerText(trigger)}` : ''})` : ''}`);
        } else {
            if (trigger) {
                resultRec.trigger = trigger;
                ruleLines.push(`🎯 trigger met${profile ? ` (${profile.name})` : ''}: ${triggerText(trigger)}`);
            }
            const swing = engine.commitAttack(parsed.actorId);
            if (surgeInfo) {
                // Reported after the swing is counted: the extra it bought is spent.
                resultRec.actionSurge = { ...surgeInfo, extraActions: actorNow?.extraActions ?? 0 };
                ruleLines.push(`⚡ Action Surge spent${surgeInfo.ability.toLowerCase() !== 'action surge' ? ` (${surgeInfo.ability})` : ''}: a fresh Attack action${surgeInfo.mirroredToCharacter ? '; the sheet shows it spent' : ''}`);
            } else if (surgeNoop) {
                resultRec.actionSurge = { spent: false };
                ruleLines.push('⚡ action still free: Action Surge not spent');
            }
            if (swing && swing.of > 1) {
                resultRec.multiattack = swing;
                ruleLines.push(`⚔ attack ${swing.made}/${swing.of}${swing.made < swing.of ? '' : ' (Attack action spent)'}`);
            }
        }

        // Play report 7 (lane H): a concentration save that took a source (or
        // left a tagged one waiting) says so; with none the reply is as before.
        if (attackConcentration) {
            resultRec.concentrationSaves = [attackConcentration];
            const row = concentrationSourcesRow({ id: attackConcentration.targetId, name: attackConcentration.name }, attackConcentration);
            if (row) resultRec.saveSources = [...((resultRec.saveSources as SaveSourcesRow[] | undefined) ?? []), row];
            ruleLines.push(`🧠 ${attackConcentration.name}: ${concentrationLine(attackConcentration)}`);
        }
        // Lane K: the offer at the reply's top level, where output_mode summary keeps the call whole.
        if (attackLegendaryOffer) resultRec.legendaryOffers = [attackLegendaryOffer];

        output = formatAttackResult(result);
        // Rule and audit lines start on their own line under the contact block.
        if ((ruleLines.length || parsed.declaredModifiers?.length || autoApplied.length || resolverProblems.length) && !output.endsWith('\n')) output += '\n';
        for (const line of ruleLines) output += `▌ ${line}\n`;
        if (parsed.declaredModifiers?.length) {
            output += `▌ ⟨audit⟩ in-bonus: ${parsed.declaredModifiers.map(d => `${d.label} ${d.value >= 0 ? '+' : ''}${d.value}`).join(' · ')}\n`;
            // Findings #35: banner AND JSON, always — audit fields must be greppable in rawData.
            (result as unknown as Record<string, unknown>).declaredModifiers = parsed.declaredModifiers;
        }
        if (autoApplied.length > 0) {
            output += `▌ ─ ${autoApplied.map(a => `${a.effect} ${a.value >= 0 ? '+' : ''}${a.value}${a.declared ? ' ⟨declared⟩' : ''}`).join(' · ')}\n`;
            (result as unknown as Record<string, unknown>).autoApplied = autoApplied;
        }
        if (resolverProblems.length > 0) {
            output += `▌ ⚠ ${resolverProblems.join(' | ')}\n`;
            (result as unknown as Record<string, unknown>).resolverProblems = resolverProblems;
        }

    } else if (parsed.action === 'heal') {
        if (parsed.amount === undefined) {
            throw new Error('Heal action requires amount');
        }
        if (!parsed.targetId) {
            throw new Error('Heal action requires targetId');
        }

        // Validate Action Economy
        const validation = engine.validateActionEconomy(parsed.actorId, 'action');
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        result = engine.executeHeal(parsed.actorId, parsed.targetId, parsed.amount);
        output = formatHealResult(result);
        // Play report 5 #5: healing above 0 wakes the dying; the sheet's dying conditions go too.
        if (result.target.hpBefore <= 0 && result.target.hpAfter > 0) {
            const woke = clearDyingOnRow(parsed.targetId);
            if (woke.length) output += `\n${result.target.name} wakes: ${woke.join(', ')} cleared from the sheet`;
        }

        // Sync HP to character database after heal
        if (result.success && result.healAmount && result.healAmount > 0) {
            const db = getDb();
            const charRepo = new CharacterRepository(db);

            // Get updated target HP from combat state and sync to character DB
            const updatedState = engine.getState();
            const targetParticipant = updatedState?.participants.find(p => p.id === parsed.targetId);
            if (targetParticipant) {
                const targetChar = charRepo.findById(parsed.targetId);
                if (targetChar) {
                    charRepo.update(parsed.targetId, { hp: targetParticipant.hp });
                }
            }
        }
        // Play report 5: a knockout woken by the heal leaves the sheet too.
        if (result.woke?.conditionsRemoved.length) {
            const sheetUpdated = clearNonlethalOnRow(parsed.targetId);
            (result as unknown as Record<string, unknown>).woke = { ...result.woke, sheetUpdated };
        }

        // Commit Action Economy
        engine.commitAction(parsed.actorId, 'action');

    } else if (parsed.action === 'disengage') {
        // HIGH-003: Disengage action - prevents opportunity attacks
        const currentState = engine.getState();
        if (!currentState) {
            throw new Error('No combat state');
        }

        const actor = currentState.participants.find(p => p.id === parsed.actorId);
        if (!actor) {
            throw new Error(`Actor ${parsed.actorId} not found`);
        }

        // Validate Action Economy
        const validation = engine.validateActionEconomy(parsed.actorId, 'action');
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        // Mark as disengaged using engine method
        engine.disengage(parsed.actorId);
        
        // Commit Action Economy
        engine.commitAction(parsed.actorId, 'action');

        output = formatDisengageResult(actor.name);

        // Create result for consistency
        result = {
            type: 'attack', // Placeholder type
            success: true,
            actor: { id: actor.id, name: actor.name },
            target: { id: actor.id, name: actor.name, hpBefore: actor.hp, hpAfter: actor.hp, maxHp: actor.maxHp },
            defeated: false,
            message: `${actor.name} disengages`,
            detailedBreakdown: output
        };
    } else if (parsed.action === 'move') {
        // CRIT-003: Spatial movement with collision checking
        if (!parsed.targetPosition) {
            throw new Error('Move action requires targetPosition');
        }

        const currentState = engine.getState();
        if (!currentState) {
            throw new Error('No combat state');
        }

        const named = currentState.participants.find(p => p.id === parsed.actorId);
        if (!named) {
            throw new Error(`Actor ${parsed.actorId} not found`);
        }
        // Play report 7 #10: a rider on a controlled mount moves the MOUNT (the
        // mount's budget; the rider moves free and follows, credited the feet);
        // a rider on an independent mount cannot move it. A moving mount
        // carries its rider.
        const steed = mountOf(currentState, named);
        if (steed && steed.riderId === named.id && steed.controlledBy !== named.id) {
            const refusal = new Error(`${named.name} rides ${steed.name} (independent): it moves when ${steed.name} moves (move {actorId: '${steed.id}'}); dismount first (combat_manage dismount {encounterId: '${parsed.encounterId}', riderId: '${named.id}'}) to move on foot. Nothing was spent.`) as Error & { writes?: string };
            refusal.writes = 'none';
            throw refusal;
        }
        const actor = steed && steed.riderId === named.id ? steed : named;
        const carried = riderOf(currentState, actor);
        const rider = carried && carried.mountedOn === actor.id ? carried : undefined;

        // Get actor's current position
        const actorPos = (actor as any).position;
        if (!actorPos) {
            // No position set - just set the target position directly
            (actor as any).position = parsed.targetPosition;
            if (rider) rider.position = { x: parsed.targetPosition.x, y: parsed.targetPosition.y };
            output = formatMoveResult(actor.name, undefined, parsed.targetPosition, true, null);
        } else {
            // Item 11: the move is validated first (blocked destination, no
            // path, not enough movement), so a refused move provokes nothing.
            // Then the path is walked and each reaction resolves at the step
            // that set it off.
            const obstacles = new Set<string>();

            // Every square another participant fills is an obstacle (a
            // large token fills 2x2 from its position, item 6).
            for (const p of currentState.participants) {
                // Play report 7 #10: a mount's own rider shares its squares and never blocks it.
                if (p.id === actor.id || p.id === rider?.id) continue;
                for (const cell of footprintCells(p)) obstacles.add(`${cell.x},${cell.y}`);
            }

            // Add terrain obstacles if available
            const terrain = (currentState as any).terrain;
            if (terrain?.obstacles) {
                for (const obs of terrain.obstacles) {
                    obstacles.add(obs);
                }
            }

            const opportunityAttacks: Array<Record<string, unknown>> = [];
            const opportunityAttacksAvailable: Array<Record<string, unknown>> = [];
            // Play report 5 #5: a reaction that drops or kills the tracked mover follows through to its sheet.
            let reactionKilled: KilledRecord | undefined;
            // Play report 5 #1: reactors with no shot (total cover between them and the mover).
            const opportunityAttacksSkipped: Array<Record<string, unknown>> = [];
            const readiedTriggered: Array<Record<string, unknown>> = [];
            // Play report 7 (lane G2): one line per reaction, kept whole by output_mode 'summary'.
            const reactionLines: string[] = [];
            const lineTarget = (who: CombatParticipant): ReactionTarget => rider && who === rider ? { name: rider.name, riding: actor.name } : rider && who === actor ? { name: actor.name, carrying: rider.name } : { name: who.name };
            let moved = false;

            // The mover's whole footprint at the destination must be clear.
            // The path itself is found for the anchor square only.
            const destBlocked = footprintCells(actor, parsed.targetPosition)
                .some(cell => obstacles.has(`${cell.x},${cell.y}`));
            const path = destBlocked ? null : new SpatialEngine().findPath(
                { x: actorPos.x, y: actorPos.y },
                { x: parsed.targetPosition.x, y: parsed.targetPosition.y },
                obstacles
            );
            // Calculate movement cost (5ft per step); path includes the start node.
            const moveCost = path ? (path.length - 1) * 5 : 0;
            // A condition added mid-turn (grappled, exhaustion 2) caps what is
            // left; each Dash taken widens the budget by one speed allotment.
            const speedCap = engine.moveBudget(actor);
            const currentMovement = Math.min((actor as any).movementRemaining ?? 30, speedCap); // Default 30 if undefined

            if (destBlocked) {
                output = formatMoveResult(actor.name, actorPos, parsed.targetPosition, false, 'Destination is blocked');
            } else if (path === null) {
                output = formatMoveResult(actor.name, actorPos, parsed.targetPosition, false, 'No valid path - blocked by obstacles');
            } else if (currentMovement < moveCost) {
                output = formatMoveResult(actor.name, actorPos, parsed.targetPosition, false, `Insufficient movement (Cost: ${moveCost}ft, Remaining: ${currentMovement}ft)`);
            } else {
                // Reactions along the path, in step order. At one step a
                // readied action goes before the opportunity attack: the
                // reactor chose it, and it spends the same reaction.
                // Play report 7 #10: readied triggers are checked for the mount and
                // its rider (each strikes the one it watched; a reactor fires once);
                // opportunity attacks come from the mount's path, once per reactor.
                type Reaction =
                    | { kind: 'readied'; reactor: CombatParticipant; stepIndex: number; readied: NonNullable<CombatParticipant['readied']>; target: CombatParticipant }
                    | { kind: 'oa'; reactor: CombatParticipant; stepIndex: number };
                const readiedOnce = new Set<string>();
                const readiedHits = [
                    // The rider first: at one step an 'enemy' watch strikes the rider, as an opportunity attack does.
                    ...(rider ? engine.getReadiedTriggers(actor.id, path, { watched: rider.id }).map(t => ({ kind: 'readied' as const, ...t, target: rider })) : []),
                    ...engine.getReadiedTriggers(actor.id, path).map(t => ({ kind: 'readied' as const, ...t, target: actor }))
                ].sort((a, b) => a.stepIndex - b.stepIndex).filter(t => !readiedOnce.has(t.reactor.id) && !!readiedOnce.add(t.reactor.id));
                const reactions: Reaction[] = [
                    ...readiedHits,
                    ...engine.getOpportunityAttackers(actor.id, path).map(h => ({ kind: 'oa' as const, reactor: h.attacker, stepIndex: h.stepIndex }))
                ].sort((a, b) => a.stepIndex - b.stepIndex || (a.kind === b.kind ? 0 : a.kind === 'readied' ? -1 : 1));

                const hpBefore = actor.hp;
                let reactionOutput = '';
                let fellAt: number | undefined;
                for (const reaction of reactions) {
                    const { reactor, stepIndex } = reaction;
                    const at = { x: path[stepIndex].x, y: path[stepIndex].y };
                    // A reaction earlier on this path may have spent this one.
                    if (reactor.reactionUsed || !engine.canTakeReactions(reactor.id)) continue;
                    // The mover stands where the reaction happens (conditions
                    // within 5 ft and the grid read this square).
                    actor.position = at;
                    // Play report 7 #10: the rider shares the mount's space, so it is
                    // struck from the mount square nearest the reactor. An opportunity
                    // attack takes the rider by default (5e lets the attacker choose).
                    if (rider) rider.position = (reactor.position ? nearestMountCell(actor, reactor.position, at) : undefined) ?? at;
                    // Review: the rider when the reactor is hostile to it; a reactor hostile to the
                    // mount alone (a captured warhorse under a friend) strikes the mount.
                    const struck = reaction.kind === 'readied' ? reaction.target : (rider && !!reactor.isEnemy !== !!rider.isEnemy ? rider : actor);
                    const strikesRider = !!rider && struck === rider;
                    if (reaction.kind === 'readied') {
                        const { readied } = reaction;
                        if (!readied.attack) {
                            // Not an attack: the GM resolves it with trigger_readied.
                            readiedTriggered.push({ participantId: reactor.id, name: reactor.name, stepIndex, at, readied, fired: false });
                            reactionOutput += `\n⏳ READIED: ${reactor.name} — ${readied.action} (${readied.trigger}) at (${at.x}, ${at.y}): call combat_manage trigger_readied {encounterId: '${parsed.encounterId}', participantId: '${reactor.id}'}\n`;
                            reactionLines.push(readiedFlaggedLine(reactor.name, readied.action, `combat_manage trigger_readied {encounterId: '${parsed.encounterId}', participantId: '${reactor.id}'}`));
                            continue;
                        }
                        let fired: CombatActionResult;
                        try {
                            fired = resolveReadiedAttack(engine, reactor, struck, readied.attack);
                        } catch (err) {
                            // Play report 7 #5: held under a subdue order (a ranged shot, or a
                            // target already down): no shot, the reaction is not spent and the
                            // readied attack stays armed. An unanswered onSubdue names the answer.
                            const held = heldReadied(err);
                            if (held) {
                                const awaiting = held.mode === 'hold' && held.awaitingOnSubdue;
                                readiedTriggered.push({ participantId: reactor.id, name: reactor.name, stepIndex, at, readied, fired: false, held: true, reason: held.note, ...(awaiting ? { awaitingOnSubdue: true, answer: onSubdueAnswer(parsed.encounterId, reactor.id) } : {}) });
                                reactionOutput += `\n⏳ READIED: ${reactor.name} — ${readied.action} (${readied.trigger}) at (${at.x}, ${at.y}): ${held.note}. The reaction is not spent and the readied attack stays armed${awaiting ? `. Answer: ${onSubdueAnswerText(parsed.encounterId, reactor.id)}` : ''}\n`;
                                reactionLines.push(held.mode === 'downed' ? notStruckDownLine(reactor.name, lineTarget(struck)) : heldFireLine(reactor.name, awaiting ? onSubdueAnswerText(parsed.encounterId, reactor.id) : undefined));
                                continue;
                            }
                            // A dead part or unknown profile: flagged, nothing spent.
                            const problem = err instanceof Error ? err.message : String(err);
                            readiedTriggered.push({ participantId: reactor.id, name: reactor.name, stepIndex, at, readied, fired: false, problem });
                            reactionOutput += `\n⏳ READIED: ${reactor.name} — ${readied.action}: could not fire (${problem}); resolve with trigger_readied\n`;
                            reactionLines.push(readiedProblemLine(reactor.name, problem));
                            continue;
                        }
                        reactor.readied = undefined;
                        readiedTriggered.push({ participantId: reactor.id, name: reactor.name, stepIndex, at, readied, fired: true, ...(rider ? { targetId: struck.id } : {}), attack: reactionAttackData(fired) });
                        reactionOutput += `\n⏳ READIED fires: ${reactor.name} — ${readied.action} (${readied.trigger}) at (${at.x}, ${at.y})\n${fired.detailedBreakdown}\n↩ reaction spent\n`;
                        const readiedDying = await settleAttackDying(fired, struck, reactor.name, parsed.encounterId);
                        if (readiedDying.killed) reactionKilled = readiedDying.killed;
                        reactionLines.push(rolledReactionLine('readied', reactor.name, lineTarget(struck), reactionAttackData(fired), { killed: !!readiedDying.killed, override: readiedOverrideTail(readiedRangedFor(reactor, readied.attack).override) }));
                        if (readiedDying.lines.length) reactionOutput += `${readiedDying.lines.join('\n')}\n`;
                        // Play report 7 #5: a knockout under the subdue order reaches the sheet.
                        const readiedKo = settleKnockout(fired, struck, reactor);
                        if (readiedKo.length) reactionOutput += `${readiedKo.join('\n')}\n`;
                        new CombatActionLogRepository(getDb()).log({
                            encounterId: parsed.encounterId, round: currentState.round, turnIndex: currentState.currentTurnIndex,
                            actorId: reactor.id, actorName: reactor.name, actionType: 'trigger_readied', targetIds: [struck.id],
                            resultSummary: `${reactor.name}'s readied action fires: ${readied.action} (${readied.trigger}) — ${fired.message}${fired.subdue ? ` (${fired.subdue.note})` : ''}`,
                            resultDetail: fired.detailedBreakdown, damageDealt: fired.damage
                        });
                    } else if (reactor.subdue && struck.hp <= 0 && !struck.unit) {
                        // Play report 7 #5: under the subdue order a reactor does not strike a mover already down.
                        const reason = `subdue: ${struck.name} is already down; ${reactor.name} does not strike (reaction kept)`;
                        opportunityAttacksSkipped.push({ attackerId: reactor.id, attackerName: reactor.name, stepIndex, at, reason });
                        reactionOutput += `\n⚡ OPPORTUNITY ATTACK skipped: ${reason}\n`;
                        reactionLines.push(notStruckDownLine(reactor.name, lineTarget(struck)));
                        continue;
                    } else if (isPlayerReactor(reactor)) {
                        // A PC's reaction is the player's choice: offer the exact call.
                        // Play report 7 #5: under a subdue order the offered swing is non-lethal.
                        const takeAlive = !!reactor.subdue && !struck.unit;
                        // The swing happened in melee where the mover left reach (ranged: false), so the
                        // non-lethal call stays good after the mover has walked on.
                        const call = { tool: 'combat_action', action: 'attack', encounterId: parsed.encounterId, actorId: reactor.id, targetId: struck.id, reaction: true, ...(takeAlive ? { nonlethal: true, ranged: false } : {}) };
                        opportunityAttacksAvailable.push({ attackerId: reactor.id, attackerName: reactor.name, stepIndex, at, call, ...(strikesRider ? { couldTarget: actor.id } : {}) });
                        reactionOutput += `\n⚡ OPPORTUNITY ATTACK AVAILABLE: ${reactor.name} may strike ${struck.name} leaving reach at (${at.x}, ${at.y}); the player decides${takeAlive ? ' (subdue order: non-lethal, take them alive)' : ''}. combat_action attack {encounterId: '${parsed.encounterId}', actorId: '${reactor.id}', targetId: '${struck.id}', reaction: true${takeAlive ? ', nonlethal: true, ranged: false' : ''}}${strikesRider ? ` (or the mount: targetId '${actor.id}')` : ''}\n`;
                        reactionLines.push(offeredReactionLine(reactor.name, lineTarget(struck), `combat_action attack {encounterId: '${parsed.encounterId}', actorId: '${reactor.id}', targetId: '${struck.id}', reaction: true${takeAlive ? ', nonlethal: true, ranged: false' : ''}}`, { nonlethal: takeAlive, ...(strikesRider ? { orMount: actor.id } : {}) }));
                        continue;
                    } else {
                        let oaResult: CombatActionResult;
                        try {
                            // Play report 7 #7 (lane F): untagged attack mechanics fire on the swing (no context here).
                            const oaDeclared = automaticDeclared(reactor.id);
                            oaResult = engine.executeOpportunityAttack(reactor.id, struck.id, oaDeclared ? { declared: oaDeclared } : {});
                        } catch (err) {
                            // Play report 5 #1: total cover between them: no shot, no reaction spent, the move goes on.
                            if (!(err instanceof Error && (err as { writes?: string }).writes === 'none')) throw err;
                            opportunityAttacksSkipped.push({ attackerId: reactor.id, attackerName: reactor.name, stepIndex, at, reason: err.message });
                            reactionOutput += `\n⚡ OPPORTUNITY ATTACK skipped: ${reactor.name} has no shot at (${at.x}, ${at.y}) — ${err.message}\n`;
                            reactionLines.push(skippedReactionLine(reactor.name, lineTarget(struck), err.message));
                            continue;
                        }
                        opportunityAttacks.push({ attackerId: reactor.id, attackerName: reactor.name, stepIndex, at, ...(rider ? { targetId: struck.id, ...(strikesRider ? { couldTarget: actor.id } : {}) } : {}), ...reactionAttackData(oaResult) });
                        reactionOutput += formatOpportunityAttackResult(oaResult) + '\n';
                        if (strikesRider) reactionOutput += `🐎 ${reactor.name} struck ${rider.name}, the rider, by default: 5e lets an attacker provoked by a mount choose, and it could target the ${actor.name} instead (move the damage with adjust_hp if the table says so)\n`;
                        const oaDying = await settleAttackDying(oaResult, struck, reactor.name, parsed.encounterId);
                        if (oaDying.killed) reactionKilled = oaDying.killed;
                        reactionLines.push(rolledReactionLine('OA', reactor.name, { ...lineTarget(struck), ...(strikesRider ? { couldStrikeMount: true } : {}) }, reactionAttackData(oaResult), { killed: !!oaDying.killed }));
                        if (oaDying.lines.length) reactionOutput += `${oaDying.lines.join('\n')}\n`;
                        // Play report 7 #5: a knockout under the subdue order reaches the sheet.
                        const oaKo = settleKnockout(oaResult, struck, reactor);
                        if (oaKo.length) reactionOutput += `${oaKo.join('\n')}\n`;
                    }
                    // A mover who drops stops where it fell (a mount stops when its rider drops).
                    if (actor.hp <= 0 || (rider && rider.hp <= 0)) { fellAt = stepIndex; break; }
                }

                // Play report 5: the feet actually walked feed the trigger counters.
                // Play report 7 #10: a carried rider is credited the mount's feet
                // (mounted charges, trigger-tied attacks) without spending its own.
                const addMoved = (feet: number) => {
                    for (const who of rider ? [actor, rider] : [actor]) {
                        who.movedThisTurn = (who.movedThisTurn ?? 0) + feet;
                        who.movedSinceDash = (who.movedSinceDash ?? 0) + feet;
                    }
                };
                const rideLine = (feet: number) => rider ? `\n🐎 ${rider.name} rides ${actor.name}: it moves free, and the ${feet} ft count toward its own movement this turn (${rider.movedThisTurn ?? 0} ft, for mounted charges)` : '';
                if (fellAt !== undefined) {
                    const fell = { x: path[fellAt].x, y: path[fellAt].y };
                    actor.position = fell;
                    if (rider) rider.position = { ...fell };
                    (actor as any).movementRemaining = currentMovement - fellAt * 5;
                    addMoved(fellAt * 5);
                    const downed = actor.hp <= 0 || !rider ? actor : rider;
                    output = reactionOutput
                        + (fellAt > 0 ? formatMoveResult(actor.name, actorPos, fell, true, null, fellAt) : '')
                        + `\n${downed.name} ${isKnockedOut(downed) ? 'is knocked out' : dyingLabel(downed) ? `is ${dyingLabel(downed)}` : 'was defeated'} while ${downed === actor ? 'attempting to move' : `riding ${actor.name}`} and ${downed === actor ? 'cannot complete the movement' : `the ${actor.name} stops there`}!`;
                    result = {
                        type: 'attack',
                        success: false,
                        actor: { id: actor.id, name: actor.name },
                        target: { id: downed.id, name: downed.name, hpBefore: downed === actor ? hpBefore : downed.hp, hpAfter: downed.hp, maxHp: downed.maxHp },
                        defeated: true,
                        message: `${downed.name} ${isKnockedOut(downed) ? 'knocked out' : dyingLabel(downed) ?? 'defeated'} by a reaction while moving`,
                        detailedBreakdown: output
                    };
                } else {
                    // Move successful - update position and remaining movement
                    actor.position = parsed.targetPosition;
                    if (rider) rider.position = { x: parsed.targetPosition.x, y: parsed.targetPosition.y };
                    (actor as any).movementRemaining = currentMovement - moveCost;
                    addMoved(moveCost);
                    moved = true;
                    output = reactionOutput + formatMoveResult(actor.name, actorPos, parsed.targetPosition, true, null, path.length - 1) + rideLine(moveCost);
                }
            }

            // Create result for consistency
            result ??= {
                type: 'attack',
                success: moved,
                actor: { id: actor.id, name: actor.name },
                target: { id: actor.id, name: actor.name, hpBefore: actor.hp, hpAfter: actor.hp, maxHp: actor.maxHp },
                defeated: actor.hp <= 0,
                message: moved ? `${actor.name} moved` : `${actor.name} could not move`,
                detailedBreakdown: output
            };
            Object.assign(result as unknown as Record<string, unknown>, { opportunityAttacks, opportunityAttacksAvailable, readiedTriggered, ...(opportunityAttacksSkipped.length ? { opportunityAttacksSkipped } : {}), ...(reactionKilled ? { killed: reactionKilled } : {}),
                // Play report 7 (lane G2): one line per reaction; the embed lifts it to the top level.
                ...(reactionLines.length ? { reactionLines } : {}),
                // Play report 7 #10: who carried whom.
                ...(rider ? { mounted: { riderId: rider.id, mountId: actor.id, controlled: actor.controlledBy === rider.id, movedBy: 'mount', mountMovementRemaining: actor.movementRemaining ?? null, riderMovementRemaining: rider.movementRemaining ?? null } } : {}) });
        }

        // Create dummy result if not set (for the case where no position was set initially)
        if (!result) {
            result = {
                type: 'attack',
                success: output.includes('moved') || output.includes('placed'),
                actor: { id: actor.id, name: actor.name },
                target: { id: actor.id, name: actor.name, hpBefore: actor.hp, hpAfter: actor.hp, maxHp: actor.maxHp },
                defeated: false,
                message: `${actor.name} moved`,
                detailedBreakdown: output
            };
        }
    } else if (parsed.action === 'cast_spell') {
        // CRIT-006: Validated spell casting - prevents LLM hallucination
        if (!parsed.spellName) {
            throw new Error('cast_spell action requires spellName');
        }

        // CRIT-006: Block raw damage parameter for spell casting (allow 0 since LLMs often send it)
        // SECURITY: Prevent hallucination attacks where LLM specifies arbitrary damage values
        if (parsed.damage !== undefined && parsed.damage !== 0) {
            throw new Error('damage parameter not allowed for cast_spell - damage is calculated from spell');
        }

        const currentState = engine.getState();
        if (!currentState) {
            throw new Error('No combat state');
        }

        const actor = currentState.participants.find(p => p.id === parsed.actorId);
        if (!actor) {
            throw new Error(`Actor ${parsed.actorId} not found`);
        }

        // Load character data for spellcasting validation
        const db = getDb();
        const charRepo = new CharacterRepository(db);
        let casterChar: Character | null = null;

        try {
            casterChar = charRepo.findById(parsed.actorId);
        } catch {
            // Character might not exist in DB (e.g., test setup)
            // Create minimal character for validation
        }

        // If no character record, create minimal one from participant data
        if (!casterChar) {
            // This is a fallback - ideally all casters are in the character table
            throw new Error(`Character ${parsed.actorId} not found in database. Spellcasting requires a character record with class and spell slots.`);
        }

        // Item 8: a world class with casting.as casts SRD spells as that
        // caster (slots, ability, spell list); the sheet keeps its own class.
        const ownClass = casterChar.characterClass;
        const castingAs = castingClassFor(db, casterChar);
        if (castingAs && castingAs !== ownClass) casterChar = { ...casterChar, characterClass: castingAs };
        // Item 10: spell DC and attack read the caster's world proficiency curve.
        const casterProfBonus = worldProgression(db, resolveWorldId(db, { characterIds: [casterChar.id] })).profBonus(casterChar.level);

        // Get target (needed for validation of range)
        // Re-use logic: defined outside or define here once?
        // Note: variable 'target' is defined later in the file.
        // We will define it here as 'validationTarget' to avoid conflict, or check if we can hoist.
        const validationTarget = currentState.participants.find(p => p.id === parsed.targetId);

        // Validate spell cast (CRIT-006 core validation)
        const validation = validateSpellCast(casterChar, parsed.spellName, parsed.slotLevel, {
            casterPosition: actor.position || undefined,
            targetPosition: validationTarget ? (validationTarget.position || undefined) : (parsed.targetPosition || undefined),
            targetId: parsed.targetId
        });

        if (!validation.valid) {
            throw new Error(validation.error?.message || 'Invalid spell cast');
        }

        // Spell is valid - resolve effects
        const spell = validation.spell!;
        const effectiveSlotLevel = validation.effectiveSlotLevel || spell.level;
        // Play report 7 #1: an area spell (areaOfEffect) on a unit token goes
        // model by model; a spaced unit needs modelsInArea before the slot,
        // the action or any die is spent. Any other spell takes one model.
        const spellArea = !!spell.areaOfEffect;
        if (spellArea && spell.effects.some(e => e.type === 'damage')) {
            const named = parsed.targetIds?.length ? parsed.targetIds : parsed.targetId ? parsed.targetId.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
            const needs = unitsNeedingCount(currentState.participants, named, parsed.modelsInArea as ModelsInArea | undefined);
            if (needs.length) throw areaCountRefusal(needs);
        }

        // ACTION ECONOMY VALIDATION
        const actionType = parseCastingTime(spell.castingTime);
        // Is it a leveled spell? (Cantrips are level 0)
        // Bonus Action Rule applies to "casting a spell" (BA) and "casting a spell" (Action).
        // My engine logic handles the specific combinations (BA spell -> Action Cantrip Only).
        // I need to pass the spell level (effective slot level? No, base level usually? Rules say "Cantrip", which is level 0. Casting at higher level doesn't make it a leveled spell? Yes it does. "Level 1 or higher". )
        // "You can't cast another spell during the same turn, except for a cantrip with a casting time of 1 action."
        // So effectiveSlotLevel is what matters for consumption, but base level matters for "Cantrip"? A Level 1 spell cast with Level 2 slot is Level 2. A Cantrip cast with... cantrips don't use slots.
        // So I'll use `effectiveSlotLevel` (which is 0 for cantrips).
        
        const economyValidation = engine.validateActionEconomy(parsed.actorId, actionType, effectiveSlotLevel);
        if (!economyValidation.valid) {
            throw new Error(economyValidation.error);
        }
        
        // Commit Action Economy (do this BEFORE resolving just in case resolution fails? No, if resolution fails we shouldn't burn action? 
        // But throwing errors inside resolution is bad. 
        // However, I'll commit at end to be safe, or start? 
        // If I commit at end, and resolution crashes, action is saved? 
        // If logic throws, we don't save state. 
        // So better to commit at end of block.

        // Get target AC for spell attack resolution
        // For single target spells, use the specific target's AC
        // For AoE spells, we'll resolve per-target later, but need a representative AC for initial resolution
        let targetAC = 10; // Default fallback
        
        // First check if we have a specific targetId
        if (validationTarget?.ac !== undefined) {
            targetAC = validationTarget.ac;
        } else if (parsed.targetIds && parsed.targetIds.length > 0) {
            // For AoE, use first target's AC as representative
            const firstTarget = currentState.participants.find(p => p.id === parsed.targetIds![0]);
            if (firstTarget?.ac !== undefined) {
                targetAC = firstTarget.ac;
            } else {
                // Default monster AC if not specified
                targetAC = 12; // Reasonable default for monsters
            }
        }

        // Resolve spell effects (damage calculation) on the encounter's seeded,
        // logged dice. Each target rolls its own save below, so the resolver
        // rolls none (perTargetSaves) and leaves debuff conditions to us.
        const attackTargetId = validationTarget?.id ?? parsed.targetIds?.[0];
        let spellAttackSituational: string[] = [];

        // Play report 5 #1: cover on the spell. coverByTarget (or cover for
        // the one target) wins; else standing and map cover from the caster;
        // Spell Sniper (the sheet's ignoreCover.spells) lifts what it names.
        // A spell attack rolls against AC +2/+5; a DEX save takes the same
        // bonus; a targeted spell against total cover is refused before the
        // slot or the action is spent; an area target behind total cover is
        // unaffected unless the GM passes 'none' for it.
        const spellIgnore = ignoreCoverFor(actor.ignoreCover ?? (casterChar as { ignoreCover?: IgnoreCoverScopes }).ignoreCover, 'spells');
        const coverByTarget = (parsed.coverByTarget ?? {}) as Record<string, unknown>;
        const spellCoverFor = (tid: string): CoverResolution | undefined => {
            const tp = currentState.participants.find(p => p.id === tid);
            if (!tp || tp.id === actor.id) return undefined;
            // A bare `cover` is every named target's default (targetId or targetIds); coverByTarget overrides one.
            const explicit = coverByTarget[tid] ?? coverByTarget['*'] ?? parsed.cover;
            return resolveCover(currentState, actor, tp, { explicit, ignoreCover: spellIgnore });
        };
        const singleTarget = !parsed.targetIds?.length && !!parsed.targetId && !parsed.targetId.includes(',');
        const spellMakesAttack = !(spell as { autoHit?: boolean }).autoHit && spell.effects.some(e => e.type === 'damage' && (!e.saveType || e.saveType === 'none') && !(e as { autoHit?: boolean }).autoHit);
        let spellCover: CombatActionResult['cover'];
        const spellCoverLines: string[] = [];
        const coverSkipped: string[] = [];
        // A spell that chooses its creatures (targetType creature | creatures:
        // Fire Bolt, Hold Person, Bless) cannot pick one behind total cover,
        // whether it came through targetId or targetIds: refused before the
        // slot or the action is spent, naming the target. Area and point
        // spells skip that target below; the GM passes 'none' when the area
        // gets around the obstruction.
        const choosesCreatures = (spell as { targetType?: string }).targetType === 'creature' || (spell as { targetType?: string }).targetType === 'creatures';
        if (choosesCreatures) {
            const named = parsed.targetIds?.length ? parsed.targetIds : parsed.targetId ? parsed.targetId.split(',').map(t => t.trim()).filter(Boolean) : [];
            for (const tid of named) {
                const c = spellCoverFor(tid);
                if (c?.kind === 'total') throw totalCoverRefusal(c, actor.name, currentState.participants.find(p => p.id === tid)?.name ?? tid);
            }
        }
        if (attackTargetId) {
            const c = spellCoverFor(attackTargetId);
            if (c && (spellMakesAttack || singleTarget)) {
                if (c.kind === 'total') throw totalCoverRefusal(c, actor.name, currentState.participants.find(p => p.id === attackTargetId)?.name ?? attackTargetId);
                if (spellMakesAttack) {
                    const acBefore = targetAC;
                    if (c.acBonus) { targetAC += c.acBonus; spellCoverLines.push(`🛡 cover: ${coverArithmetic('AC', acBefore, c)}`); }
                    const lifted = ignoredCoverLine(c, actor.name);
                    if (lifted) spellCoverLines.push(`🛡 ${lifted}`);
                    spellCover = { ...c, acBefore, acAfter: targetAC };
                }
            }
        }
        // Play report 7 #7 (lane F): a spell attack reads the caster's untagged
        // attack / attack:<lane> mechanics. The spell's own kind decides the
        // lane when it states one (5e: Spiritual Weapon is a melee spell attack
        // at range 60); else a touch or self spell (or one that reaches only
        // 5 ft) makes a melee spell attack, any other a ranged one. A direct
        // handler caller's ranged: true | false decides it instead.
        const spellRange = (spell as { range?: unknown }).range;
        const spellKind = (spell as { spellAttack?: AttackLane }).spellAttack;
        const spellLane: AttackLane = parsed.ranged === true ? 'ranged' : parsed.ranged === false ? 'melee'
            : spellKind ? spellKind
            : spellRange === 'touch' || spellRange === 'self' || (typeof spellRange === 'number' && spellRange <= 5) ? 'melee' : 'ranged';
        const spellDeclared = spellMakesAttack ? automaticDeclared(parsed.actorId)?.[spellLane] : undefined;
        let spellAttackSources: { advantageSources?: string[]; disadvantageSources?: string[] } = {};
        const resolution = resolveSpell(spell, casterChar, effectiveSlotLevel, {
            targetAC,
            perTargetSaves: true,
            advantage: parsed.advantage,
            disadvantage: parsed.disadvantage,
            casterId: parsed.actorId,
            targetId: attackTargetId,
            profBonus: casterProfBonus,
            dice: {
                d20: (_tag, advantage, disadvantage) => {
                    if (!attackTargetId || !currentState.participants.some(p => p.id === attackTargetId)) {
                        const rolls = [engine.rollD20({ purpose: 'spell attack', forId: parsed.actorId })];
                        if (!!advantage !== !!disadvantage) rolls.push(engine.rollD20({ purpose: 'spell attack', forId: parsed.actorId }));
                        return { natural: advantage && !disadvantage ? Math.max(...rolls) : disadvantage && !advantage ? Math.min(...rolls) : rolls[0], rolls };
                    }
                    const r = engine.rollSpellAttackD20(parsed.actorId, attackTargetId, { ranged: parsed.ranged, advantage, disadvantage, ...(spellDeclared ? { declared: spellDeclared } : {}) });
                    spellAttackSituational = r.situational;
                    spellAttackSources = { ...(r.advantageSources ? { advantageSources: r.advantageSources } : {}), ...(r.disadvantageSources ? { disadvantageSources: r.disadvantageSources } : {}) };
                    return r;
                },
                roll: (notation, tag) => engine.rollDice(notation, { purpose: tag, forId: parsed.actorId, ...(attackTargetId ? { targetId: attackTargetId } : {}) })
            }
        });

        // Collect all targets (support both single targetId and multiple targetIds for AoE)
        // Also handle comma-separated targetId strings since LLMs often format this way
        const allTargetIds: string[] = [];
        if (parsed.targetIds && parsed.targetIds.length > 0) {
            allTargetIds.push(...parsed.targetIds);
        } else if (parsed.targetId) {
            // Parse comma-separated targetId string (e.g., "goblin-1,goblin-2,goblin-3")
            if (parsed.targetId.includes(',')) {
                allTargetIds.push(...parsed.targetId.split(',').map((id: string) => id.trim()));
            } else {
                allTargetIds.push(parsed.targetId);
            }
        }

        // Track results for each target
        const damageResults: { 
            id: string; 
            name: string; 
            hpBefore: number; 
            hpAfter: number; 
            defeated: boolean;
            /** Play report 5 #5: what this damage did to a tracked target at or into 0 HP. */
            dying?: DyingUpdate;
            saveRoll?: number;
            saveTotal?: number;
            saved?: boolean;
            damageDealt?: number;
            damageModifier?: 'immune' | 'resistant' | 'vulnerable' | 'normal';
            save?: ParticipantSaveResult;
            cover?: { kind: string; source: string; via: string; saveBonus: number };
            /** Play report 7 #1: an area spell on a unit, model by model. */
            unitArea?: UnitAreaReport;
            /** Play report 7 #1: a spell that is not an area took one model at most. */
            unitCap?: { before: number; after: number };
            /** Lane W: a unit target's models after the spell, compactly. */
            wounds?: string;
        }[] = [];
        const damageType = resolution.damageType || 'force';
        // Play report 7 (lane G1): what each target's save took (declared mechanics, conditions), for saveSources.
        const spellSaveSources: SaveSourcesRow[] = [];
        // Play report 7 (lane H): concentration saves that took a declared source or left a tagged one waiting.
        const spellConcentration: Array<ConcentrationOutcome & { targetId: string; name: string }> = [];
        // Lane K: the legendary resistances offered on those saves, for the reply's top-level legendaryOffers.
        const spellLegendaryOffers: LegendaryReplyRow[] = [];

        // Get spell's save info
        const damageEffect = spell.effects.find(e => e.type === 'damage');
        const saveType = damageEffect?.saveType;
        const saveEffect = damageEffect?.saveEffect;
        const requiresSave = saveType && saveType !== 'none';
        const spellSaveDC = casterChar.spellSaveDC || calculateSpellSaveDC(casterChar, casterProfBonus);
        // Each target rolls its own save below, so a save spell starts from the
        // full roll. resolution.damage already carries the resolver's single
        // unmodified save; using it would halve (or zero) the damage twice.
        const baseDamage = requiresSave
            ? (resolution.damageRolled ?? resolution.damage ?? 0)
            : (resolution.damage ?? 0);

        // Item 12: units the spell carried through their breakAt.
        const breakTests: BreakTest[] = [];

        // Apply damage/healing to ALL targets
        if (baseDamage > 0 && allTargetIds.length > 0) {
            const db = getDb();
            const concentrationRepo = new ConcentrationRepository(db);

            for (const tid of allTargetIds) {
                const targetParticipant = currentState.participants.find(p => p.id === tid);
                if (!targetParticipant) continue;
                // Play report 5 #1: a target behind total cover is unaffected; a DEX save takes the cover bonus.
                const tc = spellCoverFor(tid);
                if (tc?.kind === 'total') {
                    coverSkipped.push(tid);
                    spellCoverLines.push(`🛡 ${targetParticipant.name}: unaffected: total cover (${tc.source})${tc.via !== 'call' ? ` [pass coverByTarget: {${tid}: 'none'} if the spell gets around it]` : ''}`);
                    continue;
                }
                const tcDex = !!requiresSave && (toLongAbility(saveType!) ?? 'dexterity') === 'dexterity';
                const tcBonus = tc && tcDex ? tc.acBonus : 0;

                const hpBefore = targetParticipant.hp;
                let damageDealt = baseDamage;
                let saveRoll: number | undefined;
                let saveTotal: number | undefined;
                let saved = false;
                let targetSave: ParticipantSaveResult | undefined;
                // Play report 7 #1: an area spell on a unit: one save per model inside.
                const unitRoll = targetParticipant.unit && spellArea
                    ? rollUnitArea(engine, db, targetParticipant, {
                        damage: baseDamage, halfOnSave: saveEffect === 'half',
                        savingThrow: requiresSave ? { ability: saveType!, dc: spellSaveDC } : undefined,
                        damageType, coverBonus: tcBonus, purpose: spell.name,
                        modelsInArea: parsed.modelsInArea as ModelsInArea | undefined, shape: spell.areaOfEffect!.shape
                    })
                    : undefined;
                if (unitRoll) saved = unitRoll.majoritySaved;

                // Roll saving throw if spell requires it: the sheet's ability
                // modifier and save proficiency, on the encounter's seeded stream.
                if (requiresSave && !unitRoll) {
                    targetSave = rollParticipantSave(engine, db, targetParticipant, saveType!, spellSaveDC, {
                        purpose: `${toLongAbility(saveType!) ?? 'dexterity'} save vs ${spell.name}${tcBonus ? ` (cover +${tcBonus})` : ''}`,
                        ...(tcBonus ? { extraBonus: tcBonus } : {})
                    });
                    saveRoll = targetSave.natural;
                    saveTotal = targetSave.total;
                    saved = targetSave.saved;
                    if (tcBonus && tc) spellCoverLines.push(`🛡 ${targetParticipant.name}: ${saveArithmetic(targetSave.ability, targetSave.natural, targetSave.modifier - tcBonus, tc, targetSave.total, spellSaveDC)}`);

                    if (saved) {
                        if (saveEffect === 'half') {
                            damageDealt = Math.floor(baseDamage / 2);
                        } else {
                            damageDealt = 0; // No damage on successful save (saveEffect: 'none')
                        }
                    }
                }

                // Resistance, immunity and vulnerability apply after the save
                // (per model for a unit in an area: rollUnitArea did it).
                const typed = unitRoll ? undefined : engine.calculateDamageWithModifiers(damageDealt, damageType, targetParticipant);
                damageDealt = unitRoll ? unitRoll.hpLost : typed!.finalDamage;
                const damageModifier = unitRoll ? unitRoll.damageModifier : typed!.modifier;
                // Play report 7 #1: a spell that is not an area takes one model of a unit at most.
                const spellCap = targetParticipant.unit && !unitRoll ? unitCapFor(targetParticipant, damageDealt) : undefined;
                if (spellCap) damageDealt = spellCap.damage;

                // Apply damage via engine's applyDamage (direct HP reduction).
                // Play report 5 #5: a tracked target dropped to 0 is dying (its
                // sheet mirrors Unconscious + Prone); one already down takes a
                // failed save; massive damage kills (settled after the loop).
                // Lane W: an area on a unit lands model by model, each keeping its wound.
                const dying = damageDealt > 0 ? engine.applyDamage(tid, damageDealt, unitRoll ? { models: unitRoll.modelDamage } : {}) : undefined;
                if (dying?.dropped) markRowDying(tid);

                // CRITICAL FIX: Get fresh state AFTER damage was applied
                const freshState = engine.getState();
                const updatedTarget = freshState?.participants.find(p => p.id === tid);
                const hpAfter = updatedTarget?.hp ?? 0;
                const defeated = hpAfter <= 0;
                if (updatedTarget?.unit) {
                    const due = breakTestDue(updatedTarget, hpBefore, { moraleBonus: moraleModifiers(updatedTarget, freshState?.participants ?? [], sheetSpecies(getDb())) });
                    if (due) breakTests.push(due);
                }

                // Sync HP to character database after spell damage
                if (damageDealt > 0 && updatedTarget) {
                    const targetCharForSync = charRepo.findById(tid);
                    if (targetCharForSync) {
                        charRepo.update(tid, { hp: hpAfter });
                    }
                }

                damageResults.push({
                    id: tid,
                    name: targetParticipant.name,
                    hpBefore,
                    hpAfter,
                    defeated,
                    saveRoll,
                    saveTotal,
                    saved,
                    damageDealt,
                    damageModifier,
                    save: targetSave,
                    ...(tc && (tc.kind !== 'none' || tc.ignored) ? { cover: { kind: tc.kind, source: tc.source, via: tc.via, saveBonus: tcBonus } } : {}),
                    ...(unitRoll ? { unitArea: unitRoll.report } : {}),
                    ...(spellCap?.cap ? { unitCap: spellCap.cap } : {}),
                    // Lane W: the unit's models after the spell, compactly.
                    ...(updatedTarget?.unit ? { wounds: woundLine(updatedTarget) } : {}),
                    ...(dying ? { dying } : {})
                });
                {
                    const row = targetSave
                        ? saveSourcesRow({ id: tid, name: targetParticipant.name }, targetSave)
                        : unitRoll?.report.saveBonus ? saveSourcesRow({ id: tid, name: targetParticipant.name }, { ability: unitRoll.report.saveBonus.ability, ...unitRoll.report }, { models: unitRoll.report.saves?.length ?? 0 }) : undefined;
                    if (row) spellSaveSources.push(row);
                }

                // Check concentration if target is concentrating
                const targetChar = charRepo.findById(tid);
                // Lane H review: 0 HP ends the spell outright (below), with no CON save.
                if (targetChar && concentrationRepo.isConcentrating(tid) && damageDealt > 0 && !defeated) {
                    // Play report 7 (lane H): the target's declared save:con sides and conditions, on the fight's dice.
                    const concentrationCheck = checkConcentration(targetChar, damageDealt, concentrationRepo, 0,
                        fightConcentrationDie(engine, db, tid));
                    // Lane K: a failed save spends a legendary resistance (the spell holds) or offers one (reversible with saveRef).
                    const held = concentrationCheck.broken ? concentrationRepo.findByCharacterId(tid) : null;
                    const legendary = held ? fightConcentrationLegendary(engine, db, tid, parsed.encounterId, held) : undefined;
                    if (legendary?.holds) { concentrationCheck.broken = false; concentrationCheck.reason = 'damage'; }
                    if (legendary?.row) spellLegendaryOffers.push(legendary.row);
                    if (concentrationLabelled(concentrationCheck) || legendary) {
                        const c = concentrationOutcome({ ...concentrationCheck, ...legendary?.fields });
                        spellConcentration.push({ targetId: tid, name: targetParticipant.name, ...c });
                        const row = concentrationSourcesRow({ id: tid, name: targetParticipant.name }, c);
                        if (row) spellSaveSources.push(row);
                    }
                    if (concentrationCheck.broken) {
                        breakConcentration(
                            { characterId: tid, reason: 'damage', damageAmount: damageDealt },
                            concentrationRepo,
                            charRepo
                        );
                    }
                }

                // D&D 5e Rule: Dropping to 0 HP automatically breaks concentration
                if (defeated && targetChar && concentrationRepo.isConcentrating(tid)) {
                    breakConcentration(
                        { characterId: tid, reason: 'death' },
                        concentrationRepo,
                        charRepo
                    );
                }
            }
        }

        // Play report 5 #5: the deaths this spell caused among tracked targets
        // run the kill on the sheet (cause, corpse) and are printed plainly.
        const spellKilled: KilledRecord[] = [];
        for (const dr of damageResults) {
            if (!dr.dying?.dead) continue;
            const k = await settleDeath({ id: dr.id, name: dr.name }, `${spell.name} cast by ${actor.name}${dr.dying.instantDeath ? ' (massive damage)' : ' (third failed death save)'}`, parsed.encounterId);
            if (k) spellKilled.push(k);
        }

        // Debuff spells: each target rolls its own save (when the spell has
        // one) on the encounter's dice; a failure, or no save, applies the
        // spell's conditions to the token.
        const conditionsApplied: Array<{ id: string; name: string; condition: string; save?: ParticipantSaveResult }> = [];
        const conditionLines: string[] = [];
        for (const effect of spell.effects.filter(e => e.type === 'debuff' && e.conditions?.length)) {
            const hasSave = !!effect.saveType && effect.saveType !== 'none';
            for (const tid of allTargetIds) {
                const tp = engine.getState()?.participants.find(p => p.id === tid);
                if (!tp) continue;
                // Play report 5 #1: total cover shields the target from the debuff too; a DEX save takes the bonus.
                const dcv = spellCoverFor(tid);
                if (dcv?.kind === 'total') {
                    if (!coverSkipped.includes(tid)) { coverSkipped.push(tid); spellCoverLines.push(`🛡 ${tp.name}: unaffected: total cover (${dcv.source})`); }
                    continue;
                }
                const dBonus = dcv && hasSave && (toLongAbility(effect.saveType!) ?? 'dexterity') === 'dexterity' ? dcv.acBonus : 0;
                let save: ParticipantSaveResult | undefined;
                if (hasSave) {
                    save = rollParticipantSave(engine, getDb(), tp, effect.saveType!, spellSaveDC, {
                        purpose: `${toLongAbility(effect.saveType!) ?? effect.saveType} save vs ${spell.name}${dBonus ? ` (cover +${dBonus})` : ''}`,
                        ...(dBonus ? { extraBonus: dBonus } : {})
                    });
                    const line = `🎲 ${tp.name} ${save.ability.toUpperCase()} save: d20(${save.rolls.join(',')}) ${save.modifier >= 0 ? '+' : '-'} ${Math.abs(save.modifier)} = ${save.total} vs DC ${spellSaveDC} [${save.saved ? 'PASS' : 'FAIL'}]${saveSidesNote(save)}`;
                    conditionLines.push(line);
                    // Play report 7 (lane G1): a tagged mechanic the save did not fire, and the row for saveSources.
                    for (const c of [...(save.conditionalAdvantage ?? []), ...(save.conditionalDisadvantage ?? [])]) conditionLines.push(`   conditional: ${c}`);
                    const row = saveSourcesRow({ id: tp.id, name: tp.name }, save);
                    if (row) spellSaveSources.push(row);
                    if (save.legendaryResisted) conditionLines.push(`⭐ Legendary resistance spent: the failed save becomes a success`);
                    // Lane L review: the offer, as the damage roads print it (a player character is asked, never spent for).
                    else if (save.legendaryResistanceAvailable) conditionLines.push(`⭐ Failed with ${save.legendaryResistanceAvailable} legendary resistance(s) left: ${save.legendaryResistanceAskPlayer ? 'ask the player' : 'the GM may spend one'}`);
                    if (save.saved) continue;
                }
                for (const name of effect.conditions!) {
                    const norm = normalizeCondition({ name, sourceId: parsed.actorId, ...(hasSave ? { saveDC: spellSaveDC, saveAbility: effect.saveType } : {}) } as never, tid);
                    if (!norm) continue;
                    const { id: _drop, ...rest } = norm;
                    const applied = engine.applyCondition(tid, rest);
                    conditionsApplied.push({ id: tid, name: tp.name, condition: applied.type, ...(save ? { save } : {}) });
                    conditionLines.push(`🔗 ${tp.name} is ${applied.type} (${spell.name})`);
                }
            }
        }

        // Handle healing (single target only for now)
        let primaryTarget = currentState.participants.find(p => p.id === parsed.targetId);
        const targetHpBefore = primaryTarget?.hp || 0;
        
        // Play report 5: a healing spell that lifts a knocked-out target above
        // 0 wakes it like the heal action does — the knockout's Unconscious
        // leaves the token (engine.heal) and the sheet (here), and the result
        // says so. Other Unconscious sources are left alone.
        let spellWoke: { conditionsRemoved: string[]; sheetUpdated: boolean } | undefined;
        if (resolution.healing && resolution.healing > 0 && primaryTarget) {
            const healed = engine.executeHeal(parsed.actorId, parsed.targetId!, resolution.healing);
            primaryTarget = currentState.participants.find(p => p.id === parsed.targetId);
            if (healed.woke?.conditionsRemoved.length) {
                spellWoke = { ...healed.woke, sheetUpdated: clearNonlethalOnRow(parsed.targetId!) };
            }
        }

        // Consume spell slot (if not cantrip)
        if (effectiveSlotLevel > 0) {
            const updatedChar = consumeSpellSlot(casterChar, effectiveSlotLevel);
            charRepo.update(casterChar.id, { ...updatedChar, characterClass: ownClass });
        }

        // Handle concentration
        if (spell.concentration) {
            const db = getDb();
            const concentrationRepo = new ConcentrationRepository(db);
            const currentState = engine.getState();

            // Parse duration from spell (e.g., "Concentration, up to 1 minute")
            let maxDuration: number | undefined;
            const durationMatch = spell.duration.match(/(\d+)\s+(minute|hour)/i);
            if (durationMatch) {
                const value = parseInt(durationMatch[1]);
                const unit = durationMatch[2].toLowerCase();
                // Convert to rounds (1 round = 6 seconds)
                if (unit === 'minute') {
                    maxDuration = value * 10; // 1 minute = 10 rounds
                } else if (unit === 'hour') {
                    maxDuration = value * 600; // 1 hour = 600 rounds
                }
            }

            // Start concentration
            startConcentration(
                casterChar.id,
                spell.name,
                effectiveSlotLevel,
                currentState?.round || 1,
                maxDuration,
                allTargetIds.length > 0 ? allTargetIds : undefined,
                concentrationRepo,
                charRepo
            );
        }

        const modTag = (m?: string) => (m && m !== 'normal' ? ` (${m})` : '');
        // Format output - now includes all targets hit
        if (damageResults.length > 1) {
            // AoE spell output
            output = `\n┌─────────────────────────────────────────┐\n`;
            output += `│ ✨ ${spell.name.toUpperCase()} (AoE)\n`;
            output += `└─────────────────────────────────────────┘\n\n`;
            output += `${actor.name} casts ${spell.name}!\n\n`;
            output += `💥 Base Damage: ${baseDamage} ${damageType}\n`;
            if (requiresSave) {
                output += `🎯 Save: ${saveType!.toUpperCase()} DC ${spellSaveDC}\n`;
            }
            output += `\n📍 TARGETS (${damageResults.length}):\n`;
            for (const dr of damageResults) {
                const drAfter = dr.dying ? engine.getState()?.participants.find(p => p.id === dr.id) : undefined;
                const defeatIcon = dr.defeated ? (dr.dying && drAfter ? dyingTail(drAfter, dr.dying) : ' 💀 DEFEATED') : '';
                if (dr.saveRoll !== undefined) {
                    const saveResult = dr.saved ? '✓ PASS' : '✗ FAIL';
                    output += `  • ${dr.name}: d20(${dr.saveRoll}) + ${(dr.saveTotal || 0) - dr.saveRoll} = ${dr.saveTotal} [${saveResult}]${dr.save ? saveSidesNote(dr.save) : ''}\n`;
                    for (const c of [...(dr.save?.conditionalAdvantage ?? []), ...(dr.save?.conditionalDisadvantage ?? [])]) output += `    conditional: ${c}\n`;
                    if (dr.save?.legendaryResisted) output += `    ⭐ Legendary resistance spent: the failed save becomes a success\n`;
                    else if (dr.save?.legendaryResistanceAvailable) output += `    ⭐ Failed with ${dr.save.legendaryResistanceAvailable} legendary resistance(s) left: ${dr.save.legendaryResistanceAskPlayer ? 'ask the player' : 'the GM may spend one'}\n`;
                    output += `    → ${dr.damageDealt} dmg${modTag(dr.damageModifier)} | ${dr.hpBefore} → ${dr.hpAfter} HP${defeatIcon}\n`;
                } else {
                    output += `  • ${dr.name}: ${dr.damageDealt} dmg${modTag(dr.damageModifier)} | ${dr.hpBefore} → ${dr.hpAfter} HP${defeatIcon}\n`;
                }
            }
        } else if (damageResults.length === 1) {
            // Show the target's own save and the damage it actually took,
            // not the resolver's single unmodified save.
            const only = damageResults[0];
            // Play report 7 #1: a unit in an area shows the roll; its per-model line follows.
            const shown = only.unitArea
                ? { ...resolution, damage: baseDamage, saveResult: undefined }
                : requiresSave
                ? { ...resolution, damage: only.damageDealt ?? baseDamage, saveResult: (only.saved ? 'passed' : 'failed') as 'passed' | 'failed', saveDC: spellSaveDC }
                : { ...resolution, damage: only.damageDealt ?? resolution.damage };
            const onlyAfter = only.dying ? engine.getState()?.participants.find(p => p.id === only.id) : undefined;
            const onlyTail = only.dying && onlyAfter
                ? `${dyingTail(onlyAfter, only.dying)}${only.dying.failuresAdded ? ` — hit while down: +${only.dying.failuresAdded} failed death save${only.dying.failuresAdded > 1 ? 's' : ''}` : ''}`
                : undefined;
            output = formatSpellCastResult(actor.name, shown, primaryTarget, targetHpBefore, onlyTail);
            if (onlyTail && !primaryTarget) output += `\n${only.name}: ${only.hpBefore} → ${only.hpAfter} HP${onlyTail}`;
            if (only.dying?.dropped && !only.dying.dead) output += `\n🩸 ${only.name} drops: unconscious and prone; death saves on its turns (or stabilize it: combat_action stabilize {actorId, targetId: '${only.id}'})\n`;
            if (only.damageModifier && only.damageModifier !== 'normal') {
                output += `\n🛡️ ${only.name} is ${only.damageModifier} to ${damageType}\n`;
            }
            if (only.save) {
                output += `\n🎲 ${only.name} ${only.save.ability.toUpperCase()} save: d20(${only.save.rolls.join(',')}) ${only.save.modifier >= 0 ? '+' : '-'} ${Math.abs(only.save.modifier)} = ${only.save.total} vs DC ${spellSaveDC} [${only.save.parts.join(', ')}]${saveSidesNote(only.save)}\n`;
                for (const c of [...(only.save.conditionalAdvantage ?? []), ...(only.save.conditionalDisadvantage ?? [])]) output += `   conditional: ${c}\n`;
                if (only.save.legendaryResisted) output += `⭐ Legendary resistance spent: the failed save becomes a success\n`;
                else if (only.save.legendaryResistanceAvailable) output += `⭐ Failed with ${only.save.legendaryResistanceAvailable} legendary resistance(s) left: ${only.save.legendaryResistanceAskPlayer ? 'ask the player' : 'the GM may spend one'}\n`;
            }
        } else {
            output = `\n✨ ${actor.name} casts ${spell.name}!\n`;
            if (resolution.healing && resolution.healing > 0) {
                output += `💚 Healing: ${resolution.healing}\n`;
            }
            if (spellWoke) {
                output += `💤→👁 ${primaryTarget?.name ?? parsed.targetId} comes round (${spellWoke.conditionsRemoved.join(', ')} cleared${spellWoke.sheetUpdated ? '; sheet too' : ''})\n`;
            }
        }
        // Save spells report what targets took; with no participant targets
        // (a point-targeted AoE) the full roll is the spell's damage.
        const reportedDamage = damageResults.length > 0
            ? damageResults.reduce((sum, dr) => sum + (dr.damageDealt ?? 0), 0)
            : (requiresSave ? baseDamage : (resolution.damage || 0));
        if (spellAttackSituational.length) output += `\n(${spellAttackSituational.join('; ')})\n`;
        if (spellCoverLines.length) output += `\n${spellCoverLines.join('\n')}\n`;
        // Play report 7 #1: what the spell did to each unit, model by model (or the one-model cap).
        for (const dr of damageResults) {
            if (dr.unitArea) {
                const sl = unitSavesLine(dr.unitArea);
                output += `\n🎯 ${dr.name} — ${dr.unitArea.line}${sl ? `\n   ${sl}` : ''}\n`;
            } else if (dr.unitCap) output += `\n🎯 ${dr.name}: ${unitCapLine(dr.unitCap)}${dr.wounds ? `; ${dr.wounds}` : ''}\n`;
            else if (dr.wounds && (dr.damageDealt ?? 0) > 0) output += `\n🎯 ${dr.name}: ${dr.wounds}\n`;
        }
        if (!spellArea && parsed.modelsInArea !== undefined) output += `\n(modelsInArea ignored: ${spell.name} is not an area spell)\n`;
        if (conditionLines.length) output += `\n${conditionLines.join('\n')}\n`;
        // Play report 7 (lane H): a concentration save that took a source (or left a tagged one waiting).
        for (const c of spellConcentration) output += `\n🧠 ${c.name}: ${concentrationLine(c)}\n`;
        if (spellKilled.length) output += `\n${killedLines(spellKilled).join('\n')}\n`;
        for (const due of breakTests) output += `\n▌ ${due.line}\n`;
        output += `\n[SPELL: ${spell.name}, SLOT: ${effectiveSlotLevel > 0 ? effectiveSlotLevel : 'cantrip'}, DMG: ${reportedDamage}, HEAL: ${resolution.healing || 0}]`;

        // Commit Action Economy
        engine.commitAction(parsed.actorId, actionType, effectiveSlotLevel);

        // Create result (report first target for compatibility)
        const firstTargetResult = damageResults[0];
        result = {
            type: 'attack',
            success: resolution.success,
            actor: { id: actor.id, name: actor.name },
            target: firstTargetResult ? {
                id: firstTargetResult.id,
                name: firstTargetResult.name,
                hpBefore: firstTargetResult.hpBefore,
                hpAfter: firstTargetResult.hpAfter,
                maxHp: currentState.participants.find(p => p.id === firstTargetResult.id)?.maxHp || 0
            } : { id: 'none', name: 'none', hpBefore: 0, hpAfter: 0, maxHp: 0 },
            defeated: firstTargetResult?.defeated || false,
            message: `${actor.name} cast ${spell.name}`,
            // CRIT-006: Include spell damage/healing in result for testing and frontend
            damage: requiresSave ? (firstTargetResult?.damageDealt ?? baseDamage) : resolution.damage,
            healAmount: resolution.healing,
            detailedBreakdown: output
        };
        // Per-target saves ride the action JSON so the client sees each die and modifier.
        const saves = damageResults.filter(dr => dr.save).map(dr => ({ id: dr.id, name: dr.name, ...dr.save!, ...(dr.cover ? { cover: dr.cover } : {}) }));
        if (saves.length) (result as { saves?: unknown }).saves = saves;
        if (spellCover) result.cover = spellCover;
        if (coverSkipped.length) (result as { coverSkipped?: unknown }).coverSkipped = coverSkipped;
        if (conditionsApplied.length) (result as { conditionsApplied?: unknown }).conditionsApplied = conditionsApplied;
        if (breakTests.length) (result as { breakTests?: unknown }).breakTests = breakTests;
        // Play report 7 #1: per-unit area reports and one-model caps.
        const unitAreas = damageResults.filter(dr => dr.unitArea).map(dr => ({ targetId: dr.id, name: dr.name, ...dr.unitArea! }));
        if (unitAreas.length) (result as { unitAreas?: unknown }).unitAreas = unitAreas;
        // The owner's line per unit, lifted to the reply's top level so output_mode 'summary' keeps it.
        if (unitAreas.length) (result as { unitLines?: string[] }).unitLines = unitAreas.map(u => unitSummaryLine(u.name, u, breakTests.find(b => b.participantId === u.targetId)));
        const unitCaps = damageResults.filter(dr => dr.unitCap).map(dr => ({ targetId: dr.id, name: dr.name, ...dr.unitCap! }));
        if (unitCaps.length) (result as { unitCaps?: unknown }).unitCaps = unitCaps;
        // Play report 7 (lane G1): what each save took, lifted to the reply's top level below so output_mode 'summary' keeps it.
        if (spellSaveSources.length) (result as { saveSources?: SaveSourcesRow[] }).saveSources = spellSaveSources;
        if (spellConcentration.length) (result as { concentrationSaves?: unknown }).concentrationSaves = spellConcentration;
        if (spellLegendaryOffers.length) (result as { legendaryOffers?: unknown }).legendaryOffers = spellLegendaryOffers;
        if (spellAttackSituational.length) result.situational = spellAttackSituational;
        // Play report 7 #7 (lane F): the declared sources the spell attack roll took.
        if (spellAttackSources.advantageSources) result.advantageSources = spellAttackSources.advantageSources;
        if (spellAttackSources.disadvantageSources) result.disadvantageSources = spellAttackSources.disadvantageSources;
        // Play report 5: the knockout a healing spell woke (token and sheet).
        if (spellWoke) (result as unknown as Record<string, unknown>).woke = spellWoke;
        // Play report 5 #5: the first target's dying track and the kills this spell ran (a list, as the area paths report).
        if (firstTargetResult?.dying) result.dying = firstTargetResult.dying;
        if (spellKilled.length) (result as { killed?: unknown }).killed = spellKilled;
    } else {
        throw new Error(`Unknown action: ${parsed.action}`);
    }

    // Play report 7 #6: the actor took a combat action this turn (a move that
    // only placed it, a heal, a spell: the PC turn guard reads it). A move
    // refused before a step (blocked, no path, not enough movement) is not one.
    if (!(parsed.action === 'move' && result?.success === false)) engine.markActed(parsed.actorId);

    // Save state
    const state = engine.getState();
    if (state) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        saveEncounterState(repo, parsed.encounterId, state);

        // PLAYTEST-FIX: Log action to combat history for context compaction resilience
        if (result) {
            const actionLogRepo = new CombatActionLogRepository(db);
            const actor = state.participants.find(p => p.id === parsed.actorId);
            const target = parsed.targetId ? state.participants.find(p => p.id === parsed.targetId) : undefined;

            // Build HP changes record
            const hpChanges: Record<string, { before: number; after: number }> = {};
            if (result.target && result.target.hpBefore !== result.target.hpAfter) {
                hpChanges[result.target.id] = {
                    before: result.target.hpBefore,
                    after: result.target.hpAfter
                };
            }

            // Build concise summary for context reconstruction
            let summary = '';
            if (parsed.action === 'attack') {
                if (result.success && result.damage) {
                    summary = `${actor?.name || parsed.actorId} hit ${target?.name || parsed.targetId} for ${result.damage} damage`;
                    if (result.defeated) summary += result.knockedOut ? ' (KNOCKED OUT)' : ' (DEFEATED)';
                } else {
                    summary = `${actor?.name || parsed.actorId} missed ${target?.name || parsed.targetId}`;
                }
            } else if (parsed.action === 'heal') {
                summary = `${actor?.name || parsed.actorId} healed ${target?.name || parsed.targetId} for ${result.healAmount || 0} HP`;
            } else if (parsed.action === 'cast_spell') {
                summary = `${actor?.name || parsed.actorId} cast ${parsed.spellName || 'a spell'}`;
                if (result.damage) summary += ` (${result.damage} damage)`;
                if (result.healAmount) summary += ` (${result.healAmount} healing)`;
            } else {
                summary = `${actor?.name || parsed.actorId} performed ${parsed.action}`;
            }

            actionLogRepo.log({
                encounterId: parsed.encounterId,
                round: state.round,
                turnIndex: state.currentTurnIndex,
                actorId: parsed.actorId,
                actorName: actor?.name || parsed.actorId,
                actionType: parsed.action,
                targetIds: parsed.targetId ? [parsed.targetId] : undefined,
                resultSummary: summary,
                resultDetail: result.detailedBreakdown,
                damageDealt: result.damage,
                healingDone: result.healAmount,
                hpChanges: Object.keys(hpChanges).length > 0 ? hpChanges : undefined
            });
        }

        // Append current state JSON for frontend.
        // Findings #38: THE IRON LAW ENVELOPE — the action's structured result
        // rides the same JSON the client parses. Prose is for eyes; this block
        // is for audit. Every number the table narrates exists here as data.
        const stateJson = buildStateJson(state, parsed.encounterId);
        const r = result as unknown as (CombatActionResult & { declaredModifiers?: unknown; autoApplied?: unknown }) | undefined;
        const actionResult = r ? {
            type: r.type,
            actor: r.actor,
            target: r.target,   // hpBefore / hpAfter / maxHp
            roll: r.attackRoll ? {
                die: r.attackRoll.roll,
                allRolls: (r.attackRoll as { allRolls?: number[] }).allRolls,
                bonus: r.attackRoll.modifier,
                total: r.attackRoll.total,
                targetAc: r.attackRoll.dc,
                hit: r.attackRoll.isHit,
                crit: r.attackRoll.isCrit
            } : undefined,
            // HIGH-002: modifier rides with the total the banner explains.
            damage: r.damage !== undefined ? { total: r.damage, rolls: r.damageRolls, type: (r as { damageType?: string }).damageType, modifier: r.damageModifier } : undefined,
            healAmount: r.healAmount,
            success: r.success,
            defeated: r.defeated,
            declaredModifiers: r.declaredModifiers,
            autoApplied: r.autoApplied,
            // #66: banner and JSON carry the jam flag together — parity law.
            jamCheckOwed: (r as CombatActionResult & { jamCheckOwed?: unknown }).jamCheckOwed,
            // Table rules: what the engine computed and the GM still names.
            consequenceDue: (r as { consequenceDue?: unknown }).consequenceDue,
            calledStrike: (r as { calledStrike?: unknown }).calledStrike,
            partHit: r.partHit,
            attackProfile: (r as { attackProfile?: unknown }).attackProfile,
            volley: (r as { volley?: unknown }).volley,
            bandScale: r.bandScale,
            // Request 5: what the target's shields took, and what is left.
            shieldsAbsorbed: r.shieldsAbsorbed,
            shields: r.shields,
            situational: r.situational,
            // Play report 7 #7 (lane F): the declared sources the attack roll took, the GM's
            // one-offs and tags as given, and the tag a tagged mechanic waits for.
            advantageSources: r.advantageSources,
            disadvantageSources: r.disadvantageSources,
            situationalAdvantage: (r as { situationalAdvantage?: unknown }).situationalAdvantage,
            situationalDisadvantage: (r as { situationalDisadvantage?: unknown }).situationalDisadvantage,
            context: (r as { context?: unknown }).context,
            conditionalAdvantage: (r as { conditionalAdvantage?: unknown }).conditionalAdvantage,
            conditionalDisadvantage: (r as { conditionalDisadvantage?: unknown }).conditionalDisadvantage,
            targetUnit: (r as { targetUnit?: unknown }).targetUnit,
            preparedEffectDue: (r as { preparedEffectDue?: unknown }).preparedEffectDue,
            multiattack: (r as { multiattack?: unknown }).multiattack,
            legendary: (r as { legendary?: unknown }).legendary,
            reaction: (r as { reaction?: unknown }).reaction,
            // Play report 5: the bonus action an attack spent and the trigger it met.
            bonusAction: (r as { bonusAction?: unknown }).bonusAction,
            trigger: (r as { trigger?: unknown }).trigger,
            // Play report 5: a non-lethal knockout, and a heal that woke one.
            knockedOut: r.knockedOut,
            woke: (r as { woke?: unknown }).woke,
            // Play report 2: the Action Surge an attack spent (or did not need).
            actionSurge: (r as { actionSurge?: unknown }).actionSurge,
            // Item 17: the fighting style on this swing (and the target's defense).
            fightingStyle: (r as { fightingStyle?: unknown }).fightingStyle,
            // Play report 5 #1: the cover on this attack and the standing cover the attacker dropped.
            cover: r.cover,
            coverBroken: (r as { coverBroken?: unknown }).coverBroken,
            // cast_spell: the targets an area spell left unaffected behind total cover.
            coverSkipped: (r as { coverSkipped?: unknown }).coverSkipped,
            // Item 16: the manoeuvre on this swing: die, spend, save and effect.
            maneuver: (r as { maneuver?: unknown }).maneuver,
            saves: (r as { saves?: unknown }).saves,
            // Play report 7 (lane G1): what each save the engine rolled took (declared mechanics, conditions) or waits for.
            saveSources: (r as { saveSources?: unknown }).saveSources,
            // Play report 7 (lane H): concentration saves that took a declared source (Steady Mind, exhaustion 3) or a tagged one's hint.
            concentrationSaves: (r as { concentrationSaves?: unknown }).concentrationSaves,
            conditionsApplied: (r as { conditionsApplied?: unknown }).conditionsApplied,
            worldSpell: (r as { worldSpell?: unknown }).worldSpell,
            breakTests: (r as { breakTests?: unknown }).breakTests,
            // Play report 7 #1: an area spell on units, model by model; a single-target spell's one-model cap.
            unitAreas: (r as { unitAreas?: unknown }).unitAreas,
            unitCaps: (r as { unitCaps?: unknown }).unitCaps,
            growth: (r as { growth?: unknown }).growth,
            // Item 11: reactions a move set off, each at the step it happened.
            opportunityAttacks: (r as { opportunityAttacks?: unknown }).opportunityAttacks,
            opportunityAttacksAvailable: (r as { opportunityAttacksAvailable?: unknown }).opportunityAttacksAvailable,
            readiedTriggered: (r as { readiedTriggered?: unknown }).readiedTriggered,
            // Play report 7 #5: reactors that held their swing (total cover, or a subdue order at a mover already down).
            opportunityAttacksSkipped: (r as { opportunityAttacksSkipped?: unknown }).opportunityAttacksSkipped,
            // Play report 7 #10: a mount that carried its rider on this move.
            mounted: (r as { mounted?: unknown }).mounted,
            // Play report 5 #5: the target's dying track after this blow, and the kill it ran.
            dying: r.dying,
            killed: (r as { killed?: unknown }).killed
        } : undefined;
        // Play report 7 #1: each unit's area line at the top level, where output_mode 'summary' keeps it whole.
        const unitLines = (r as { unitLines?: string[] } | undefined)?.unitLines;
        // Play report 7 (lane G1): what each save took, at the top level too, for the same reason.
        const saveSources = (r as { saveSources?: unknown[] } | undefined)?.saveSources;
        // Play report 7 (lane G2): each reaction's line (a move's opportunity and readied attacks), kept whole the same way.
        const reactionLines = (r as { reactionLines?: string[] } | undefined)?.reactionLines;
        // Lane K: a legendary resistance a concentration save offered (saveRef and the call), kept whole the same way.
        const legendaryOffers = (r as { legendaryOffers?: unknown[] } | undefined)?.legendaryOffers;
        output += `\n\n<!-- STATE_JSON\n${JSON.stringify({ ...stateJson, actionResult, ...(turnWarning && offTurn ? { offTurn } : {}), ...(unitLines?.length ? { unitLines } : {}), ...(saveSources?.length ? { saveSources } : {}), ...(reactionLines?.length ? { reactionLines } : {}), ...(legendaryOffers?.length ? { legendaryOffers } : {}) })}\nSTATE_JSON -->`;
    }

    if (turnWarning) {
        output += `\n\n⚠️  ${turnWarning}\n`;
    }

    return {
        content: [
            {
                type: 'text' as const,
                text: output
            }
        ]
    };
}

export async function handleAdvanceTurn(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.ADVANCE_TURN.inputSchema.parse(args);
    let engine = getCombatManager().get(`${ctx.sessionId}:${parsed.encounterId}`);

    // Auto-load from database if not in memory
    if (!engine) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        const state = repo.loadState(parsed.encounterId);

        if (!state) {
            throw new Error(`Encounter ${parsed.encounterId} not found.`);
        }

        engine = new CombatEngine(parsed.encounterId, pubsub || undefined);
        engine.loadState(state);
        getCombatManager().create(`${ctx.sessionId}:${parsed.encounterId}`, engine);
    }

    const previousParticipant = engine.getCurrentParticipant();
    // Read character_manage HP changes before this turn writes HP back.
    const preTurnState = engine.getState();
    if (preTurnState) syncParticipantHpFromDb(preTurnState);
    // Play report 5 #5, prompt mode: the slot that is up owes a death save.
    // advance is refused until death_save rolls or posts it; nothing is written.
    if (previousParticipant?.deathSaveDue && isDying(previousParticipant)) {
        const c = deathCounters(previousParticipant);
        const refusal = new Error(`DEATH SAVE DUE: ${previousParticipant.name} (0 HP, ✓${c.successes} ✗${c.failures}) has not rolled this turn's death save — ${deathSaveCall(parsed.encounterId, previousParticipant.id)} (or post it with outcome: success | failure | nat20 | nat1). advance refused; nothing was written.`) as Error & { writes?: string };
        refusal.writes = 'none';
        throw refusal;
    }
    const worldEnv = readWorldEnvironment(getDb(), resolveWorldId(getDb(), { encounterId: parsed.encounterId }));
    // Play report 7 #6: the PC turn guard. A living player character whose
    // turn is untouched is not passed silently: TURN NOT TAKEN, nothing
    // written, unless the GM confirms (confirm / skipTurn). A world opts out
    // with environment.pcTurnGuard: 'off'.
    let skippedTurn: { participantId: string; name: string; round: number } | undefined;
    const skippedAt = preTurnState ? { round: preTurnState.round, turnIndex: preTurnState.currentTurnIndex } : undefined;
    if (previousParticipant && worldEnv?.pcTurnGuard !== 'off' && pcTurnNotTaken(engine, previousParticipant)) {
        if (!parsed.confirm && !parsed.skipTurn) {
            const refusal = new Error(turnNotTakenMessage(previousParticipant.name, parsed.encounterId)) as Error & { writes?: string; turnNotTaken?: unknown; confirmCall?: string };
            refusal.writes = 'none';
            // As data too: output_mode summary cuts a long message, and the call must survive it.
            refusal.turnNotTaken = { participantId: previousParticipant.id, name: previousParticipant.name, round: skippedAt?.round ?? 1 };
            refusal.confirmCall = confirmAdvanceCall(parsed.encounterId);
            throw refusal;
        }
        skippedTurn = { participantId: previousParticipant.id, name: previousParticipant.name, round: skippedAt?.round ?? 1 };
    }
    // The world's default death-save mode; a token's own deathSaveMode wins.
    const worldMode = worldEnv?.deathSaveMode as DeathSaveMode | undefined;
    // Play report 7 (lane H): the end-of-turn save of a save_ends condition reads the
    // saver's declared sides and sheet modifier through this provider (passed on every
    // advance, so a fight rehydrated in a new process reads it too).
    engine.nextTurnWithConditions({ deathSaveMode: worldMode, encounterId: parsed.encounterId, saverSides: engineSaverSides(() => getDb()) });
    const state = engine.getState();
    if (skippedTurn) {
        new CombatActionLogRepository(getDb()).log({
            encounterId: parsed.encounterId, round: skippedTurn.round, turnIndex: skippedAt?.turnIndex ?? 0,
            actorId: 'GM', actorName: 'GM', actionType: 'skip_turn', targetIds: [skippedTurn.participantId],
            resultSummary: `${skippedTurn.name}'s turn passed untaken (GM confirmed)`
        });
    }

    // Play report 5 #5: a third failed death save on the way in runs the kill
    // on the sheet (cause, corpse) and is printed plainly.
    const killed: KilledRecord[] = [];
    for (const ev of engine.deathSaveEvents) {
        // A natural 20 wakes the sheet too: the dying Unconscious + Prone and a
        // knockout's Unconscious come off the row (HP 1 is written below).
        if (ev.regainedHp) { clearDyingOnRow(ev.participantId); clearNonlethalOnRow(ev.participantId); }
        if (!ev.isDead) continue;
        const k = await settleDeath({ id: ev.participantId, name: ev.name }, `third failed death save (round ${ev.round})`, parsed.encounterId);
        if (k) killed.push(k);
    }
    // Play report 7 follow-up (lane O): what the turn's pressure and ongoing
    // ticks owe (break tests, unit lines, the sheet of a creature they dropped
    // or killed), read in this call on this state.
    const ticks = await settleTurnDamage(engine, parsed.encounterId);
    killed.push(...ticks.killed);

    // Save state
    if (state) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        saveEncounterState(repo, parsed.encounterId, state);
    }

    // PLAYTEST-FIX: Sync HP from character database before display
    if (state) {
        syncParticipantHpFromDb(state);
    }

    let output = `\n⏭️ TURN ENDED: ${previousParticipant?.name}\n`;
    if (skippedTurn) output += `${turnPassedLine(skippedTurn.name)}\n`;
    for (const note of engine.turnStartNotes) output += `♻️ ${note}\n`;
    for (const line of ticks.lines) output += `${line}\n`;
    for (const line of killedLines(killed)) output += `${line}\n`;
    output += state ? formatCombatStateText(state, parsed.encounterId) : 'No combat state';
    
    // Append JSON for frontend
    if (state) {
        const now = engine.getCurrentParticipant();
        const due = now?.deathSaveDue && isDying(now)
            ? { participantId: now.id, name: now.name, ...deathCounters(now), call: deathSaveCall(parsed.encounterId, now.id) }
            : undefined;
        const stateJson = {
            ...buildStateJson(state, parsed.encounterId),
            turnStartNotes: engine.turnStartNotes,
            // Play report 7 (lane H): each save_ends end-of-turn save (output_mode summary keeps the rows whole).
            ...(engine.endOfTurnSaves.length ? { endOfTurnSaves: engine.endOfTurnSaves } : {}),
            // Lane L: each legendary resistance offered on those saves: saveRef and the call to paste.
            ...(engine.legendaryOffers.length ? { legendaryOffers: engine.legendaryOffers } : {}),
            // Lane O: each pressure or ongoing tick, the break tests they owe, each unit's line (summary keeps them).
            ...(ticks.turnDamage ? { turnDamage: ticks.turnDamage } : {}),
            ...(ticks.breakTests ? { breakTests: ticks.breakTests } : {}),
            ...(ticks.unitLines ? { unitLines: ticks.unitLines } : {}),
            ...(engine.deathSaveEvents.length ? { deathSaves: engine.deathSaveEvents } : {}),
            ...(killed.length ? { killed } : {}),
            ...(due ? { deathSaveDue: due } : {}),
            ...(skippedTurn ? { skippedTurn } : {})
        };
        output += `\n\n<!-- STATE_JSON\n${JSON.stringify(stateJson)}\nSTATE_JSON -->`;
    }

    return {
        content: [
            {
                type: 'text' as const,
                text: output
            }
        ]
    };
}

export async function handleEndEncounter(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.END_ENCOUNTER.inputSchema.parse(args);
    const namespacedId = `${ctx.sessionId}:${parsed.encounterId}`;

    // Every call reads the encounter fresh (operation-guard), so memory is
    // empty here for a live fight too: the row's status decides.
    const row = (() => {
        try { return getDb().prepare('SELECT status FROM encounters WHERE id = ?').get(parsed.encounterId) as { status?: string } | undefined; }
        catch { return undefined; }
    })();
    if (row && row.status !== 'active') {
        return { content: [{ type: 'text' as const, text: `\n🏁 ENCOUNTER ALREADY ENDED\nEncounter ID: ${parsed.encounterId}\n\nThe row is '${row.status}'. Nothing was written.` }] };
    }
    let engine: CombatEngine | null = null;
    try { engine = getOrLoadEngine(ctx, parsed.encounterId); } catch { engine = null; }

    if (!engine) {
        // FINDINGS #79: no engine in memory — but the DB row may be a ghost
        // (status='active' with nothing running: a pre-#79 bench residue or a
        // crash-survivor the GM wants closed, not resumed). Close the row
        // directly instead of demanding a load-resurrect dance to bury a
        // corpse. The store's answer drives the report: changes=0 means there
        // was nothing to close, and THAT stays a loud not-found.
        try {
            const ghostDb = getDb();
            const r = ghostDb.prepare(`UPDATE encounters SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'active'`)
                .run(new Date().toISOString(), parsed.encounterId);
            if (r.changes > 0) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `\n🏁 UNREADABLE ENCOUNTER CLOSED\nEncounter ID: ${parsed.encounterId}\n\nThe row was status='active' but its saved state could not be read. Row marked completed; it will no longer report as active combat at boot. Nothing was resumed, no state was replayed.`
                    }]
                };
            }
        } catch { /* encounters table absent — fall through to not-found */ }
        throw new Error(`Encounter ${parsed.encounterId} not found.`);
    }

    const finalState = engine.getState();

    // PLAYTEST-FIX: Report final HP from database (source of truth)
    // We NO LONGER sync participant.hp → DB because:
    // 1. combat_action already syncs HP to DB after each action
    // 2. character_manage updates go directly to DB
    // 3. Database is the source of truth, not in-memory combat state
    const syncResults: { id: string; name: string; hp: number; synced: boolean }[] = [];

    if (finalState) {
        const db = getDb();
        const { CharacterRepository } = await import('../../storage/repos/character.repo.js');
        const charRepo = new CharacterRepository(db);

        for (const participant of finalState.participants) {
            // Report HP from database (the source of truth)
            const character = charRepo.findById(participant.id);

            if (character) {
                // Report the DB HP value (no write needed - DB is already correct)
                syncResults.push({
                    id: participant.id,
                    name: participant.name,
                    hp: character.hp, // Use DB value, not stale participant.hp
                    synced: true
                });
            } else {
                // Ad-hoc participant (not in DB) - report combat state HP
                syncResults.push({
                    id: participant.id,
                    name: participant.name,
                    hp: participant.hp,
                    synced: false
                });
            }
        }
    }

    // Preserve the terminal state after the in-memory encounter is removed.
    new EncounterRepository(getDb()).end(parsed.encounterId);

    // Now delete the encounter from memory
    getCombatManager().delete(namespacedId);

    // FINDINGS #79: end MARKS THE ROW — the encounters table row previously
    // stayed status='active' forever (end only cleared memory), so
    // session_manage get_context reported a ghost combat at every boot: the
    // 03 §9 "cosmetic" pointer was a banner-lie (#67-A class) with a documented
    // excuse. The store now agrees with the message.
    try {
        const endDb = getDb();
        endDb.prepare(`UPDATE encounters SET status = 'completed', updated_at = ? WHERE id = ?`)
            .run(new Date().toISOString(), parsed.encounterId);
    } catch { /* encounters table absent (tests) — memory delete already done */ }

    // STALE COMBAT FIX: Also clear any other encounters containing these participants
    // This handles cases where multiple test encounters left stale state
    let staleCleared = 0;
    if (finalState) {
        for (const participant of finalState.participants) {
            staleCleared += getCombatManager().deleteEncountersForCharacter(participant.id, ctx.sessionId);
        }
    }

    // Build response with sync information
    let output = `\n🏁 COMBAT ENDED\nEncounter ID: ${parsed.encounterId}\n\n`;

    const syncedChars = syncResults.filter(r => r.synced);
    if (syncedChars.length > 0) {
        output += `📊 Character HP Synced:\n`;
        for (const char of syncedChars) {
            output += `   • ${char.name}: ${char.hp} HP\n`;
        }
    }

    if (staleCleared > 0) {
        output += `\n🧹 Cleared ${staleCleared} stale encounter(s) for participants.\n`;
    }

    output += `\nAll combatants have been removed from the battlefield.`;

    return {
        content: [
            {
                type: 'text' as const,
                text: output
            }
        ]
    };
}

export async function handleLoadEncounter(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.LOAD_ENCOUNTER.inputSchema.parse(args);
    const db = getDb();
    const repo = new EncounterRepository(db);

    const state = repo.loadState(parsed.encounterId);
    if (!state) {
        throw new Error(`Encounter ${parsed.encounterId} not found in database.`);
    }

    // Create engine and load state
    const engine = new CombatEngine(parsed.encounterId, pubsub || undefined);
    engine.loadState(state);

    getCombatManager().create(`${ctx.sessionId}:${parsed.encounterId}`, engine);

    const stateJson = buildStateJson(state, parsed.encounterId);
    let output = `📥 ENCOUNTER LOADED\nEncounter ID: ${parsed.encounterId}\n`;
    output += formatCombatStateText(state, parsed.encounterId);
    output += `\n\n<!-- STATE_JSON\n${JSON.stringify(stateJson)}\nSTATE_JSON -->`;

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}

/**
 * MED-003: Roll a death saving throw for a character at 0 HP
 */
export async function handleRollDeathSave(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.ROLL_DEATH_SAVE.inputSchema.parse(args);
    const refuse = (message: string) => {
        const err = new Error(message) as Error & { writes?: string };
        err.writes = 'none';
        return err;
    };
    // Play report 5 #5: participantId is the convention; characterId stays as
    // the alias the first version took. Both given and different is refused.
    if (parsed.participantId && parsed.characterId && parsed.participantId !== parsed.characterId) {
        throw refuse(`death_save: participantId '${parsed.participantId}' and characterId '${parsed.characterId}' name different participants; pass one. Nothing was written.`);
    }
    const id = parsed.participantId ?? parsed.characterId;
    if (!id) throw refuse('death_save needs participantId (the token at 0 HP). Nothing was written.');
    const posted = parsed.outcome !== undefined ? normalizeDeathSaveOutcome(parsed.outcome) : undefined;
    if (parsed.outcome !== undefined && !posted) {
        throw refuse(`death_save: outcome '${parsed.outcome}' is not a death save result; use success | failure | nat20 | nat1 (or the natural die, 1-20). Nothing was written.`);
    }
    const engine = getOrLoadEngine(ctx, parsed.encounterId);

    if (!engine) {
        throw refuse(`No active encounter with ID ${parsed.encounterId}`);
    }

    const state = engine.getState();
    if (!state) {
        throw refuse('Encounter has no active state');
    }
    // Read character_manage HP changes before the save writes HP back.
    syncParticipantHpFromDb(state);

    const participant = state.participants.find(p => p.id === id);
    if (!participant) {
        throw refuse(`Participant ${id} not found in encounter`);
    }

    // Validate state
    if (participant.hp > 0) {
        throw refuse(`${participant.name} is not at 0 HP and cannot make death saving throws`);
    }

    if (participant.isDead) {
        throw refuse(`${participant.name} is already dead`);
    }

    if (participant.isStabilized) {
        return {
            content: [{
                type: 'text' as const,
                text: `${participant.name} is already stabilized and does not need to make death saving throws.`
            }]
        };
    }

    // Roll the death save, or apply the posted result.
    const answersDue = !!participant.deathSaveDue;
    const result = posted ? engine.postDeathSave(id, posted) : engine.rollDeathSave(id);

    if (!result) {
        throw new Error('Failed to roll death save');
    }
    // Play report 7 #6: a natural 20 answering DEATH SAVE DUE means the slot
    // that is up takes its turn. The advance stopped on it at 0 HP and ran no
    // turn start, so the economy left from the turn it dropped would refuse
    // its first swing: start the turn now (action, movement, reaction reset).
    const turnStarted = result.regainedHp && answersDue && state.turnOrder[state.currentTurnIndex] === id;
    // Lane O: the turn start's ticks (pressure, ongoing damage) and their saves read the provider here too.
    const turnStartNotes = turnStarted ? engine.beginTurn(id, { encounterId: parsed.encounterId, saverSides: engineSaverSides(() => getDb()) }) : [];
    // Play report 5 #5: the sheet follows. A natural 20 writes 1 HP (the next
    // sync used to revert it) and wakes the row; three failures run the kill.
    const charRepo = new CharacterRepository(getDb());
    const row = charRepo.findById(id);
    let killed: KilledRecord | undefined;
    if (row && result.regainedHp) {
        charRepo.update(id, { hp: participant.hp });
        clearDyingOnRow(id);
        clearNonlethalOnRow(id);
    }
    if (result.isDead) killed = await settleDeath(participant, `third failed death save (round ${state.round})`, parsed.encounterId);
    // Lane O: after the wake-up, so a tick that drops the creature again marks its sheet dying again.
    const ticks = turnStarted ? await settleTurnDamage(engine, parsed.encounterId) : undefined;

    // FINDINGS #63 (PDA Wave B): СМЕРТЬ — rail render, and the death save
    // gains a JSON embed for the first time (it was banner-only: a #38
    // violation on the highest-stakes roll in the game, caught this wave).
    let output = pda.renderDeath({
        characterName: participant.name,
        natural: result.roll,
        isNat20: result.isNat20,
        isNat1: result.isNat1,
        successes: result.successes,
        failures: result.failures,
        stabilized: result.isStabilized,
        dead: result.isDead
    } as Parameters<typeof pda.renderDeath>[0]);
    if (posted) output += `\n(posted: ${posted} — no die rolled)`;
    if (result.regainedHp) output += `\n${participant.name} is back at 1 HP, conscious (the sheet says so too)${participant.conditions.some(c => String(c.type) === 'prone') ? '; prone until they stand' : ''}.`;
    if (turnStarted) output += `\n${participant.name} takes this turn: action, bonus action, movement and reaction are fresh.${turnStartNotes.map(n => `\n♻️ ${n}`).join('')}${[...(ticks?.lines ?? []), ...killedLines(ticks?.killed ?? [])].map(l => `\n${l}`).join('')}`;
    if (result.isStabilized) output += `\n${participant.name} is STABLE: unconscious, no more saves; 1 HP returns after 1d4 hours, or any healing wakes them.`;
    if (killed) output += `\n${killedLines([killed]).join('\n')}`;
    else if (result.isDead) output += `\n☠ ${participant.name} is dead (third failed death save).`;

    // Save state
    const db = getDb();
    const repo = new EncounterRepository(db);
    saveEncounterState(repo, parsed.encounterId, engine.getState()!);

    output += `\n<!-- STATE_JSON\n${JSON.stringify({ deathSave: { participantId: id, characterId: id, characterName: participant.name, ...(result.roll !== undefined ? { roll: result.roll } : {}), ...(posted ? { posted } : {}), isNat20: result.isNat20, isNat1: result.isNat1, success: result.success, successes: result.successes, failures: result.failures, stabilized: result.isStabilized, isStabilized: result.isStabilized, dead: result.isDead, isDead: result.isDead, regainedHp: result.regainedHp, hp: participant.hp, sheetHp: row ? participant.hp : undefined, ...(turnStarted ? { turnStarted: true } : {}) }, ...(killed ? { killed } : {}), ...(turnStartNotes.length ? { turnStartNotes } : {}),
        // Lane O: the ticks of the turn the natural 20 started, as advance reports them.
        ...(ticks?.turnDamage ? { turnDamage: ticks.turnDamage } : {}),
        ...(ticks?.breakTests ? { breakTests: ticks.breakTests } : {}),
        ...(ticks?.unitLines ? { unitLines: ticks.unitLines } : {}),
        ...(turnStarted && engine.legendaryOffers.length ? { legendaryOffers: engine.legendaryOffers } : {}),
        ...(ticks?.killed.length ? { turnDamageKilled: ticks.killed } : {}) })}\nSTATE_JSON -->`;

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}

/** Play report 5 #6: conditions an area save applies to a target that failed (onFail) or passed (onSuccess). */
export function areaSaveRiderSchema() {
    return z.object({
        conditions: z.array(conditionInputSchema()).min(1).describe("Conditions applied to each target with that result: 'prone' or {name, duration?, durationType?, source?, saveDC?, saveAbility?, level?, ongoing?}. ongoing: {damage, damageType?, when: start | end, save?} ticks on the target's turns: from an area on a unit it ticks per model on the models still standing inside, otherwise on one model (docs/table-rules/ongoing-damage.md). Unknown names are kept as custom conditions with no mechanics (pair 'Buried' with 'restrained' for the mechanics). A same-type condition is replaced, never stacked; the source defaults to '<effect> (failed save)' / '(saved)'"),
        mirrorToCharacter: z.boolean().optional().describe('Also write them to the character sheet (default: the token only)')
    }).strict();
}
export type AreaSaveRider = { conditions: ConditionInput[]; mirrorToCharacter?: boolean };

export interface AreaSaveOptions {
    targetIds?: string[];
    /** Play report 5 #1: the token the effect comes from (a breath weapon's user, apply_damage's actor): map cover is read from it to each target. */
    originId?: string;
    /** Play report 5 #1: cover per target as the GM states it ({'*': kind} for all); wins over the map. */
    cover?: Record<string, unknown>;
    /** Play report 5 #6: conditions for targets that fail / pass the save. */
    onFail?: AreaSaveRider;
    onSuccess?: AreaSaveRider;
    /** Flat damage, or dice ('8d6') rolled once for every target on the encounter stream. */
    damage?: number | string;
    damageType?: string;
    savingThrow?: { ability: string; dc: number };
    halfDamageOnSave?: boolean;
    /** roll_log purpose for the damage dice (default '<purpose> damage'). */
    damagePurpose?: string;
    /** Request 11: the band rule's multiplier for this target (apply_damage with an actor). */
    bandScaleFor?: (target: CombatParticipant) => BandDamageScale | null;
    /** Play report 7 #1: the effect is an area: a unit target resolves model by model. Unset: a unit takes one model at most. */
    area?: boolean;
    /** Play report 7 #1: models of a unit inside the area ({targetId: n}, '*' for all); required for a spaced unit. */
    modelsInArea?: ModelsInArea | number;
    /** Play report 7 #1: the template's shape for the unit line ('cone'); default 'area'. */
    areaShape?: string;
    /** Lane K: the encounter the calls in a legendary resistance offer name (default: the engine's own id). */
    encounterId?: string;
}

export interface AreaSaveTarget {
    targetId: string;
    targetName: string;
    saveRoll?: number;
    saveTotal?: number;
    saved: boolean;
    damageTaken: number;
    hpAfter?: number;
    defeated?: boolean;
    legendaryResisted?: boolean;
    legendaryResistanceAvailable?: number;
    /** Lane L: a player-controlled creature: the resistance is the player's to spend, never spent for them. */
    legendaryResistanceAskPlayer?: boolean;
    hpBefore?: number;
    /** Set when a resistance, immunity or vulnerability changed the damage. */
    damageModifier?: 'immune' | 'resistant' | 'vulnerable';
    /** A concentrating sheet's CON save (or 0 HP) after the damage; play report 7 (lane H): with the sources it took. */
    concentration?: ConcentrationOutcome;
    /** Request 5: a vessel's shields soaked this much before the hull. */
    shieldsAbsorbed?: number;
    /** Request 5: the vessel's shields after the hit. */
    shields?: { current: number; max: number };
    /** A unit carried through its breakAt owes a break test. */
    breakTest?: BreakTest;
    /** Request 11: the band gap scaled the damage. */
    bandScale?: { steps: number; multiplier: number; before: number; after: number };
    /** Play report 5 #1: the cover that applied to this target's save (unaffected: total cover, nothing rolled). */
    cover?: { kind: string; source: string; via: string; saveBonus: number; unaffected?: true; note?: string };
    /** Play report 5 #6: the rider conditions this target received, as the GM named them. */
    conditionsApplied?: string[];
    /** Play report 5 #5: what this damage did to a tracked target at or into 0 HP. */
    dying?: DyingUpdate;
    /** Play report 7 #1: an area on a unit token, model by model (damageTaken is the HP off the pool). */
    unitArea?: UnitAreaReport;
    /** Play report 7 #1: damage that is not an area took one model of a unit at most. */
    unitCap?: { before: number; after: number };
    /** Lane W: a unit target's models after the damage: "4 alive: 2 unhurt, 1 at 5/9, 1 at 2/9". */
    wounds?: string;
    /**
     * Play report 7 (lane G1): what put the save at advantage or disadvantage
     * (the target's untagged save:<ability> mechanics, its standard
     * conditions' 5e rules; a unit's, once for every model), both dice when
     * two were rolled, and the tag a tagged mechanic waits for.
     */
    advantageSources?: string[];
    disadvantageSources?: string[];
    saveRolls?: number[];
    conditionalAdvantage?: string[];
    conditionalDisadvantage?: string[];
}

/** Play report 7 (lane G1): a save's labels as a target record carries them (a unit report's too). */
export function saveLabelsOf(s: Pick<ParticipantSaveResult, 'advantageSources' | 'disadvantageSources' | 'conditionalAdvantage' | 'conditionalDisadvantage'> & { rolls?: number[] }): Pick<AreaSaveTarget, 'advantageSources' | 'disadvantageSources' | 'saveRolls' | 'conditionalAdvantage' | 'conditionalDisadvantage'> {
    return saveDieLabels(s);
}

/**
 * Play report 7 (lane G1): the reply's top-level saveSources, one row per
 * target whose save took a source or left a tagged mechanic unfired (a unit:
 * its models count), which output_mode 'summary' keeps whole. Empty: none.
 */
export function saveSourcesOf(targets: ReadonlyArray<{ targetId: string; targetName: string; unitArea?: UnitAreaReport } & Pick<AreaSaveTarget, 'advantageSources' | 'disadvantageSources' | 'saveRolls' | 'saveRoll' | 'conditionalAdvantage' | 'conditionalDisadvantage' | 'concentration'>>, ability?: string): { saveSources?: SaveSourcesRow[] } {
    const rows: SaveSourcesRow[] = [];
    for (const t of targets) {
        const row = saveSourcesRow({ id: t.targetId, name: t.targetName }, {
            ability: t.unitArea?.saveBonus?.ability ?? toLongAbility(ability ?? '') ?? 'dexterity',
            rolls: t.saveRolls ?? (t.saveRoll !== undefined ? [t.saveRoll] : undefined),
            advantageSources: t.advantageSources, disadvantageSources: t.disadvantageSources,
            conditionalAdvantage: t.conditionalAdvantage, conditionalDisadvantage: t.conditionalDisadvantage
        }, t.unitArea ? { models: t.unitArea.saves?.length ?? 0 } : {});
        if (row) rows.push(row);
        // Play report 7 (lane H): the target's concentration save, a row of its own when it took a source.
        const conc = t.concentration ? concentrationSourcesRow({ id: t.targetId, name: t.targetName }, t.concentration) : undefined;
        if (conc) rows.push(conc);
    }
    return rows.length ? { saveSources: rows } : {};
}

/**
 * One effect on many targets, each with its own save: lair actions and
 * limited abilities (a breath weapon) share it. Dice damage is rolled once,
 * as 5e rolls a breath weapon once; every die and save goes through the
 * engine so it is seeded and reaches roll_log. The caller saves the state.
 */
export function resolveAreaSave(engine: CombatEngine, opts: AreaSaveOptions, purpose: string): { targets: AreaSaveTarget[]; damageRolled?: number; damageRolls?: number[]; lines: string[]; missing: string[]; breakTests: BreakTest[]; legendaryOffers: LegendaryReplyRow[] } {
    const state = engine.getState()!;
    const targets: AreaSaveTarget[] = [];
    const breakTests: BreakTest[] = [];
    const lines: string[] = [];
    const missing: string[] = [];
    // Lane K: legendary resistances the targets' concentration saves offered, for the reply's top-level legendaryOffers.
    const legendaryOffers: LegendaryReplyRow[] = [];
    let damageRolled: number | undefined;
    let damageRolls: number[] | undefined;
    // Play report 7 #1: a spaced unit in an area needs its count before any
    // die is rolled (the handlers ask first; this is the backstop).
    if (opts.area && (opts.damage !== undefined || opts.savingThrow)) {
        const needs = unitsNeedingCount(state.participants, opts.targetIds, opts.modelsInArea);
        if (needs.length) throw areaCountRefusal(needs);
    }
    if (typeof opts.damage === 'string') {
        const rolled = engine.rollDice(opts.damage, { purpose: opts.damagePurpose ?? `${purpose} damage` });
        damageRolled = Math.max(0, rolled.total);
        damageRolls = rolled.rolls;
    } else if (typeof opts.damage === 'number') {
        damageRolled = opts.damage;
    }
    if (!opts.targetIds?.length || (damageRolled === undefined && !opts.savingThrow)) {
        return { targets, damageRolled, damageRolls, lines, missing, breakTests, legendaryOffers };
    }
    const halfOnSave = opts.halfDamageOnSave ?? true;
    const db = getDb();
    const concentrationRepo = new ConcentrationRepository(db);
    const charRepo = new CharacterRepository(db);
    const origin = opts.originId ? state.participants.find(p => p.id === opts.originId) : undefined;
    for (const targetId of opts.targetIds) {
        const target = state.participants.find(p => p.id === targetId);
        if (!target) { missing.push(targetId); lines.push(`⚠️ Target ${targetId} not found in encounter`); continue; }
        let damageTaken = damageRolled ?? 0;
        const hpBefore = target.hp;
        // Play report 5 #1: cover against an effect from the far side of it.
        // An explicit per-target value wins; else standing and map cover from
        // the origin when it has a token. Total cover leaves the target
        // untouched unless the GM passes 'none' for it (the area got around it).
        const explicitCover = opts.cover?.[targetId] ?? opts.cover?.['*'];
        const cover: CoverResolution | undefined = explicitCover !== undefined
            ? resolveCover(state, origin ?? target, target, { explicit: explicitCover })
            : origin && origin.id !== target.id ? resolveCover(state, origin, target, {}) : undefined;
        if (cover?.kind === 'total') {
            targets.push({ targetId, targetName: target.name, saved: false, damageTaken: 0, hpBefore, hpAfter: target.hp, defeated: target.hp <= 0, cover: { kind: 'total', source: cover.source, via: cover.via, saveBonus: 0, unaffected: true } });
            lines.push(`🎯 ${target.name} — unaffected: total cover (${cover.source})${cover.via !== 'call' ? ` [pass cover: {${targetId}: 'none'} if the effect gets around it]` : ''}`);
            continue;
        }
        const dexSave = !!opts.savingThrow && (toLongAbility(opts.savingThrow.ability) ?? 'dexterity') === 'dexterity';
        const saveBonus = cover && dexSave ? cover.acBonus : 0;
        // Play report 7 #1: an area on a unit token goes model by model.
        if (target.unit && opts.area) {
            const u = resolveUnitAreaTarget(engine, target, opts, purpose, { damage: damageRolled ?? 0, halfOnSave, coverBonus: saveBonus, cover, dexSave });
            targets.push(u.target);
            lines.push(u.line);
            if (u.breakTest) breakTests.push(u.breakTest);
            continue;
        }
        let saved = false;
        let save: ParticipantSaveResult | undefined;
        if (opts.savingThrow) {
            // The sheet's modifier and save proficiency, on the seeded stream.
            save = rollParticipantSave(engine, getDb(), target, opts.savingThrow.ability, opts.savingThrow.dc, {
                purpose: `${purpose} save (${toLongAbility(opts.savingThrow.ability) ?? opts.savingThrow.ability})${saveBonus ? ` (cover +${saveBonus})` : ''}`,
                ...(saveBonus ? { extraBonus: saveBonus } : {})
            });
            saved = save.saved;
            if (saved) damageTaken = halfOnSave ? Math.floor(damageTaken / 2) : 0;
        }
        // The one resistance rule (engine.calculateDamageWithModifiers).
        const mod = engine.calculateDamageWithModifiers(damageTaken, opts.damageType, target);
        damageTaken = mod.finalDamage;
        let bandScale: AreaSaveTarget['bandScale'];
        const scale = damageTaken > 0 ? opts.bandScaleFor?.(target) : null;
        if (scale) {
            const scaled = Math.max(1, Math.floor(damageTaken * scale.multiplier));
            bandScale = { ...scale, before: damageTaken, after: scaled };
            damageTaken = scaled;
        }
        // Play report 7 #1: damage that is not an area takes one model of a unit at most.
        const capped = target.unit && !opts.area ? unitCapFor(target, damageTaken) : undefined;
        const unitCap = capped?.cap;
        if (capped) damageTaken = capped.damage;
        const shieldsBefore = (target as { shields?: { current: number; max: number } }).shields?.current;
        // Play report 5 #5: a tracked target dropped to 0 goes unconscious and
        // prone (mirrored to its sheet); one already down takes a failed save.
        const dying = damageTaken > 0 ? engine.applyDamage(targetId, damageTaken) : undefined;
        if (dying?.dropped) markRowDying(targetId);
        const after = engine.getState()!.participants.find(p => p.id === targetId) as (CombatParticipant & { shields?: { current: number; max: number } }) | undefined;
        const defeated = after ? after.hp <= 0 : false;
        // Request 5: what the shields took before the hull.
        const shieldsAbsorbed = shieldsBefore !== undefined && after?.shields ? Math.max(0, shieldsBefore - after.shields.current) : 0;
        // Concentration on the encounter's d20; 0 HP ends it outright. Play
        // report 7 (lane H): the target's declared save:con sides and conditions.
        // Lane K: a failed save spends a legendary resistance (the spell holds) or offers one (reversible with saveRef).
        const concentration = damageTaken > 0
            ? concentrationAfterDamage(targetId, damageTaken, defeated && hpBefore > 0, fightConcentrationDie(engine, db, targetId), concentrationRepo, charRepo, 0,
                concentrationLegendaryHook(db, targetId, legendaryOffers, { engine, encounterId: opts.encounterId }))
            : undefined;
        // Item 12: a unit carried through its breakAt owes a break test.
        const breakTest = after?.unit && damageTaken > 0
            ? breakTestDue(after, hpBefore, { moraleBonus: moraleModifiers(after, engine.getState()!.participants, sheetSpecies(db)) })
            : null;
        if (breakTest) breakTests.push(breakTest);
        // Play report 5 #6: riders. The save's result picks the rider; each
        // entry lands on the token (a same-type condition replaced, never
        // stacked), sourced to the effect unless the entry names its own;
        // mirrorToCharacter writes the sheet too.
        const rider = save ? (saved ? opts.onSuccess : opts.onFail) : undefined;
        const conditionsApplied: string[] = [];
        if (rider?.conditions?.length) {
            for (const entry of rider.conditions) {
                const label = typeof entry === 'string' ? entry : String(entry.type || entry.name || '');
                const norm = normalizeCondition(entry, targetId);
                if (!norm) continue;
                const { id: _riderId, ...rest } = norm;
                if (rest.sourceId === undefined) rest.sourceId = `${purpose} (${saved ? 'saved' : 'failed save'})`;
                engine.removeConditionsByType(targetId, rest.type);
                engine.applyCondition(targetId, rest);
                conditionsApplied.push(label);
                if (rider.mirrorToCharacter) mirrorConditionToRow(targetId, 'add', label, rest.duration, rest.sourceId);
            }
        }
        targets.push({
            targetId, targetName: target.name,
            saveRoll: save?.natural, saveTotal: save?.total, saved, damageTaken,
            hpBefore, hpAfter: after?.hp, defeated: after ? defeated : undefined,
            ...(cover && (cover.kind !== 'none' || cover.ignored) ? { cover: { kind: cover.kind, source: cover.source, via: cover.via, saveBonus, ...(opts.savingThrow && !dexSave && cover.kind !== 'none' ? { note: 'cover adds to DEX saves only' } : {}) } } : {}),
            ...(conditionsApplied.length ? { conditionsApplied } : {}),
            ...(mod.modifier !== 'normal' ? { damageModifier: mod.modifier } : {}),
            ...(bandScale ? { bandScale } : {}),
            ...(unitCap ? { unitCap } : {}),
            // Lane W: the unit's models after the blow, compactly.
            ...(after?.unit ? { wounds: woundLine(after) } : {}),
            ...(shieldsAbsorbed ? { shieldsAbsorbed } : {}),
            ...(after?.shields ? { shields: { current: after.shields.current, max: after.shields.max } } : {}),
            ...(save?.legendaryResisted ? { legendaryResisted: true } : {}),
            ...(save?.legendaryResistanceAvailable ? { legendaryResistanceAvailable: save.legendaryResistanceAvailable } : {}),
            ...(save?.legendaryResistanceAskPlayer ? { legendaryResistanceAskPlayer: true } : {}),
            // Play report 7 (lane G1): the sources the save took, both dice, a tagged mechanic's hint.
            ...(save ? saveLabelsOf(save) : {}),
            ...(concentration ? { concentration } : {}),
            ...(breakTest ? { breakTest } : {}),
            ...(dying ? { dying } : {})
        });
        let line = `🎯 ${target.name}`;
        if (opts.savingThrow && save) {
            const ability = save.ability.charAt(0).toUpperCase() + save.ability.slice(1);
            line += saveBonus && cover
                ? ` - ${saveArithmetic(save.ability, save.natural, save.modifier - saveBonus, cover, save.total, opts.savingThrow.dc)}`
                : ` - ${ability} Save: ${save.natural} + ${save.total - save.natural} = ${save.total} vs DC ${opts.savingThrow.dc}`;
            line += saved ? ' ✓ SAVED' : ' ✗ FAILED';
            line += save.legendaryResisted ? ' (legendary resistance)'
                : save.legendaryResistanceAvailable ? ` (${save.legendaryResistanceAvailable} legendary resistance(s) left${save.legendaryResistanceAskPlayer ? ': ask the player' : ''})` : '';
            line += saveSidesNote(save);
            for (const c of [...(save.conditionalAdvantage ?? []), ...(save.conditionalDisadvantage ?? [])]) line += `\n   conditional: ${c}`;
        }
        line += `\n   Damage: ${damageTaken}${opts.damageType ? ` ${opts.damageType}` : ''}${mod.modifier !== 'normal' ? ` (${mod.modifier})` : ''}${bandScale ? ` ×${bandScale.multiplier} band (${bandScale.before} → ${bandScale.after})${bandAssumedTag(target, state.participants.find(o => o.id === opts.originId))}` : ''}`;
        if (unitCap) line += `\n   ${unitCapLine(unitCap)}`;
        if (shieldsAbsorbed && after?.shields) line += `\n   Shields: −${shieldsAbsorbed}, ${after.shields.current}/${after.shields.max} left`;
        if (after) line += `\n   HP: ${after.hp}/${after.maxHp}${after.hp <= 0 ? dyingTail(after, dying) : ''}${after.unit && after.hp > 0 ? ` (${woundLine(after)})` : ''}`;
        if (dying?.failuresAdded) line += `\n   🩸 hit while down: +${dying.failuresAdded} failed death save${dying.failuresAdded > 1 ? 's' : ''}`;
        if (concentration) line += `\n   ${concentrationLine(concentration)}`;
        if (breakTest) line += `\n   ${breakTest.line}`;
        if (conditionsApplied.length) line += `\n   Conditions: ${conditionsApplied.join(', ')}`;
        lines.push(line);
    }
    return { targets, damageRolled, damageRolls, lines, missing, breakTests, legendaryOffers };
}

/**
 * Play report 7 #1: one unit target of an area, model by model. Each model
 * inside saves on the fight's dice (rollUnitArea); the pool loses the dead
 * models' HP; the break test reads the new count. The save's riders follow
 * the result most of the models still standing inside got (ties: failed),
 * since a unit is one token; an area that left none of them standing lays none.
 */
function resolveUnitAreaTarget(
    engine: CombatEngine, target: CombatParticipant, opts: AreaSaveOptions, purpose: string,
    ctx: { damage: number; halfOnSave: boolean; coverBonus: number; cover?: CoverResolution; dexSave: boolean }
): { target: AreaSaveTarget; line: string; breakTest: BreakTest | null } {
    const db = getDb();
    const hpBefore = target.hp;
    const roll = rollUnitArea(engine, db, target, {
        damage: ctx.damage, halfOnSave: ctx.halfOnSave, savingThrow: opts.savingThrow, damageType: opts.damageType,
        coverBonus: ctx.coverBonus, purpose, modelsInArea: opts.modelsInArea, shape: opts.areaShape, bandScaleFor: opts.bandScaleFor
    });
    // Lane W: each model inside keeps its own wound (or dies).
    const dying = roll.hpLost > 0 ? engine.applyDamage(target.id, roll.hpLost, { models: roll.modelDamage }) : undefined;
    if (dying?.dropped) markRowDying(target.id);
    const after = engine.getState()!.participants.find(p => p.id === target.id);
    const breakTest = after?.unit && roll.hpLost > 0
        ? breakTestDue(after, hpBefore, { moraleBonus: moraleModifiers(after, engine.getState()!.participants, sheetSpecies(db)) })
        : null;
    const conditionsApplied: string[] = [];
    const rider = opts.savingThrow && roll.riderResult ? (roll.riderResult === 'saved' ? opts.onSuccess : opts.onFail) : undefined;
    for (const entry of rider?.conditions ?? []) {
        const label = typeof entry === 'string' ? entry : String(entry.type || entry.name || '');
        const norm = normalizeCondition(entry, target.id);
        if (!norm) continue;
        const { id: _riderId, ...rest } = norm;
        if (rest.sourceId === undefined) rest.sourceId = `${purpose} (${roll.riderResult === 'saved' ? 'saved' : 'failed save'})`;
        // Lane O: ongoing damage from an area follows its shape: it ticks per
        // model on the models of this area still standing inside.
        const standingInside = roll.report.standing.failed + roll.report.standing.saved;
        if (standingInside > 0) stampOngoingShape(rest, { kind: 'area', models: standingInside });
        engine.removeConditionsByType(target.id, rest.type);
        engine.applyCondition(target.id, rest);
        conditionsApplied.push(label);
        if (rider!.mirrorToCharacter) mirrorConditionToRow(target.id, 'add', label, rest.duration, rest.sourceId);
    }
    const cover = ctx.cover;
    const rec: AreaSaveTarget = {
        targetId: target.id, targetName: target.name,
        saved: roll.majoritySaved, damageTaken: roll.hpLost,
        hpBefore, hpAfter: after?.hp, defeated: after ? after.hp <= 0 : undefined,
        unitArea: roll.report,
        ...(after?.unit ? { wounds: woundLine(after) } : {}),
        // Play report 7 (lane G1): the sources every model's save took, as on any target.
        ...saveLabelsOf(roll.report),
        ...(cover && (cover.kind !== 'none' || cover.ignored) ? { cover: { kind: cover.kind, source: cover.source, via: cover.via, saveBonus: ctx.coverBonus, ...(opts.savingThrow && !ctx.dexSave && cover.kind !== 'none' ? { note: 'cover adds to DEX saves only' } : {}) } } : {}),
        ...(conditionsApplied.length ? { conditionsApplied } : {}),
        ...(roll.damageModifier !== 'normal' ? { damageModifier: roll.damageModifier } : {}),
        ...(roll.bandScale ? { bandScale: roll.bandScale } : {}),
        ...(breakTest ? { breakTest } : {}),
        ...(dying ? { dying } : {})
    };
    let line = `🎯 ${target.name} — ${roll.report.line}`;
    const savesLine = unitSavesLine(roll.report);
    if (savesLine) line += `\n   ${savesLine}`;
    // Play report 7 #3: a band-scaled area on a unit whose band was assumed says so.
    const bandTag = roll.bandScale ? bandAssumedTag(target, engine.getState()!.participants.find(o => o.id === opts.originId)) : '';
    line += `\n   Damage: ${roll.hpLost}${opts.damageType ? ` ${opts.damageType}` : ''} off the pool (${roll.report.modelsKilled} model${roll.report.modelsKilled === 1 ? '' : 's'} dead)${roll.damageModifier !== 'normal' ? ` (${roll.damageModifier})` : ''}${roll.bandScale ? ` ×${roll.bandScale.multiplier} band per model (${roll.bandScale.before} → ${roll.bandScale.after})${bandTag}` : ''}`;
    if (after) line += `\n   HP: ${after.hp}/${after.maxHp}${after.unit && after.hp > 0 ? ` (${woundLine(after)})` : ''}`;
    if (breakTest) line += `\n   ${breakTest.line}`;
    if (conditionsApplied.length) line += `\n   Conditions (${roll.riderResult === 'saved' ? 'most still standing saved' : 'most still standing failed'}): ${conditionsApplied.join(', ')}`;
    return { target: rec, line, breakTest };
}

/**
 * HIGH-006: Execute a lair action on initiative 20
 */
export async function handleExecuteLairAction(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.EXECUTE_LAIR_ACTION.inputSchema.parse(args);
    const engine = getOrLoadEngine(ctx, parsed.encounterId);

    if (!engine) {
        throw new Error(`No active encounter with ID ${parsed.encounterId}`);
    }

    const state = engine.getState();
    if (!state) {
        throw new Error('Encounter has no active state');
    }
    // Read character_manage HP changes before the lair damage writes HP back.
    syncParticipantHpFromDb(state);

    // Validate it's the lair's turn
    if (!engine.isLairActionPending()) {
        throw new Error('Cannot execute lair action: it is not the lair\'s turn (initiative 20)');
    }
    // One lair action per round, recorded on the lair owner's token.
    const owner = state.participants.find(p => p.id === state.lairOwnerId);
    if (owner && owner.lairUsedRound === state.round) {
        throw new Error(`Cannot execute lair action: the lair already used its action this round (round ${state.round}); advance_turn`);
    }

    let output = `\n┌─────────────────────────────────────────┐\n`;
    output += `│ 🏰 LAIR ACTION (Initiative 20)\n`;
    output += `└─────────────────────────────────────────┘\n\n`;
    output += `${parsed.actionDescription}\n\n`;

    // Play report 7 #1: a lair action is an area unless area: false; a spaced
    // unit in it needs its count before anything is rolled.
    const lairArea = parsed.area ?? true;
    const lairHarms = (parsed.damage !== undefined && parsed.damage !== 0) || !!parsed.savingThrow;
    if (lairArea && lairHarms && parsed.targetIds?.length) {
        const needs = unitsNeedingCount(state.participants, parsed.targetIds, parsed.modelsInArea);
        if (needs.length) throw areaCountRefusal(needs);
    }

    // Play report 7 #1: each unit's area line, for the reply's unitLines (output_mode summary keeps it whole).
    const unitLines: string[] = [];
    // Play report 7 (lane G1): what each save took, for the reply's saveSources (summary keeps it whole too).
    let saveSources: SaveSourcesRow[] | undefined;
    // Lane K: legendary resistances a concentration save offered, for the reply's legendaryOffers (summary keeps them whole).
    let legendaryOffers: LegendaryReplyRow[] = [];
    // Apply damage to targets if specified
    if (parsed.targetIds && parsed.targetIds.length > 0 && ((parsed.damage !== undefined && parsed.damage !== 0) || parsed.savingThrow)) {
        const area = resolveAreaSave(engine, {
            targetIds: parsed.targetIds, damage: parsed.damage, damageType: parsed.damageType,
            savingThrow: parsed.savingThrow, halfDamageOnSave: parsed.halfDamageOnSave,
            // Play report 5: cover per target (no origin token for a lair), riders on the save.
            cover: parsed.cover as Record<string, unknown> | undefined, onFail: parsed.savingThrow?.onFail, onSuccess: parsed.savingThrow?.onSuccess,
            area: lairArea, modelsInArea: parsed.modelsInArea, encounterId: parsed.encounterId
        }, 'lair');
        if (typeof parsed.damage === 'string') output += `🎲 ${parsed.damage}: ${area.damageRolled}\n`;
        output += area.lines.join('\n') + '\n';
        for (const t of area.targets) if (t.unitArea) unitLines.push(unitSummaryLine(t.targetName, t.unitArea, t.breakTest));
        saveSources = saveSourcesOf(area.targets, parsed.savingThrow?.ability).saveSources;
        legendaryOffers = area.legendaryOffers;
        // Play report 5 #5: a tracked token the lair killed is killed on its sheet too.
        const killed = await settleAreaDeaths(parsed.encounterId, state, area.targets, 'lair action');
        for (const line of killedLines(killed)) output += `${line}\n`;
    } else {
        output += `(No mechanical effect - narrative only)\n`;
    }
    if (owner) owner.lairUsedRound = state.round;

    output += `\n→ Call advance_turn to proceed to the next combatant`;

    // Save state
    const db = getDb();
    const repo = new EncounterRepository(db);
    saveEncounterState(repo, parsed.encounterId, engine.getState()!);

    return {
        content: [{
            type: 'text' as const,
            text: output
        }],
        ...(unitLines.length ? { unitLines } : {}),
        ...(saveSources ? { saveSources } : {}),
        ...(legendaryOffers.length ? { legendaryOffers } : {})
    };
}

// Helper for tests
export function clearCombatState() {
    // CombatManager is a process-wide singleton, so leaving this as a no-op
    // lets encounters leak between tests (and between concurrent test files).
    getCombatManager().clear();
}

// ============================================================
// VISUALIZATION TOOL HANDLERS
// ============================================================

export async function handleRenderMap(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.RENDER_MAP.inputSchema.parse(args);
    let engine = getCombatManager().get(`${ctx.sessionId}:${parsed.encounterId}`);

    // Auto-load from database if not in memory
    if (!engine) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        const state = repo.loadState(parsed.encounterId);

        if (!state) {
            throw new Error(`Encounter ${parsed.encounterId} not found.`);
        }

        engine = new CombatEngine(parsed.encounterId, pubsub || undefined);
        engine.loadState(state);
        getCombatManager().create(`${ctx.sessionId}:${parsed.encounterId}`, engine);
    }

    const state = engine.getState();
    if (!state) {
        throw new Error('No active encounter');
    }

    const map = renderGrid(state, {
        width: parsed.width,
        height: parsed.height,
        showLegend: parsed.showLegend
    });

    return {
        content: [{
            type: 'text' as const,
            text: map
        }]
    };
}

export async function handleCalculateAoe(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.CALCULATE_AOE.inputSchema.parse(args);
    let engine = getCombatManager().get(`${ctx.sessionId}:${parsed.encounterId}`);

    // Auto-load from database if not in memory
    if (!engine) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        const state = repo.loadState(parsed.encounterId);

        if (!state) {
            throw new Error(`Encounter ${parsed.encounterId} not found.`);
        }

        engine = new CombatEngine(parsed.encounterId, pubsub || undefined);
        engine.loadState(state);
        getCombatManager().create(`${ctx.sessionId}:${parsed.encounterId}`, engine);
    }

    const state = engine.getState();
    if (!state) {
        throw new Error('No active encounter');
    }

    const result = calculateAoE(state, parsed.shape, parsed.origin, {
        radius: parsed.radius,
        direction: parsed.direction,
        length: parsed.length,
        angle: parsed.angle
    });

    // Format output
    let output = `\n┌─ AREA OF EFFECT ────────────────────────┐\n`;
    output += `│ Shape: ${parsed.shape.toUpperCase()}\n`;
    output += `│ Origin: (${parsed.origin.x}, ${parsed.origin.y})\n`;
    if (parsed.radius) output += `│ Radius: ${parsed.radius} tiles\n`;
    if (parsed.length) output += `│ Length: ${parsed.length} tiles\n`;
    if (parsed.angle) output += `│ Angle: ${parsed.angle}°\n`;
    output += `└─────────────────────────────────────────┘\n\n`;

    output += `📍 Affected Tiles: ${result.tiles.length}\n`;

    if (result.affectedParticipants.length > 0) {
        output += `\n⚠️ AFFECTED CREATURES:\n`;
        for (const p of result.affectedParticipants) {
            output += `  • ${p.name} at (${p.position.x}, ${p.position.y})${p.footprint > 1 ? ` — ${p.cellsInside}/${p.footprint} squares` : ''}`
                + `${p.unit ? `; unit ${p.unit.packed ? 'packed: every live model' : 'spaced'}, ${p.unit.modelsInArea} of ${p.unit.liveModels} models inside` : ''}\n`;
        }
        // Play report 7 #1: the count to pass to the damage call (a hint from the squares; the GM decides).
        if (result.modelsInArea) {
            output += `\nmodelsInArea: {${Object.entries(result.modelsInArea).map(([id, n]) => `'${id}': ${n}`).join(', ')}} (pass it on apply_damage / use_ability / lair_action / cast_spell; a hint from the squares covered, the GM decides)\n`;
        }
    } else {
        output += `\n✓ No creatures in area of effect\n`;
    }

    // Also return JSON for programmatic use
    output += `\n<!-- AOE_JSON\n${JSON.stringify(result)}\nAOE_JSON -->`;

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}

/**
 * Bresenham's line algorithm - draws a line from (x1,y1) to (x2,y2)
 */
function bresenhamLine(x1: number, y1: number, x2: number, y2: number): string[] {
    const tiles: string[] = [];
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;

    let x = x1;
    let y = y1;

    while (true) {
        tiles.push(`${x},${y}`);
        if (x === x2 && y === y2) break;
        const e2 = 2 * err;
        if (e2 > -dy) {
            err -= dy;
            x += sx;
        }
        if (e2 < dx) {
            err += dx;
            y += sy;
        }
    }
    return tiles;
}

/**
 * Evaluate a simple algebraic expression for y given x
 * Supports: constants, x, +, -, *, /, parentheses
 * Examples: "2*x+3", "x/2", "10", "x", "(x+5)/2"
 */
function evaluateExpression(expr: string, x: number): number {
    if (expr.length > 100) {
        throw new Error('Expression is too long');
    }

    let index = 0;

    const skipWhitespace = () => {
        while (/\s/.test(expr[index] || '')) index++;
    };

    const parseNumber = (): number => {
        skipWhitespace();
        const start = index;
        while (/[0-9.]/.test(expr[index] || '')) index++;
        const raw = expr.slice(start, index);
        if (!raw || raw.split('.').length > 2) {
            throw new Error(`Invalid number at position ${start}`);
        }
        return Number(raw);
    };

    const parseFactor = (): number => {
        skipWhitespace();
        const char = expr[index];

        if (char === '+') {
            index++;
            return parseFactor();
        }
        if (char === '-') {
            index++;
            return -parseFactor();
        }
        if (char === '(') {
            index++;
            const value = parseExpression();
            skipWhitespace();
            if (expr[index] !== ')') {
                throw new Error(`Missing closing parenthesis at position ${index}`);
            }
            index++;
            return value;
        }
        if (char?.toLowerCase() === 'x') {
            index++;
            return x;
        }
        return parseNumber();
    };

    const parseTerm = (): number => {
        let value = parseFactor();
        while (true) {
            skipWhitespace();
            const op = expr[index];
            if (op !== '*' && op !== '/') break;
            index++;
            const right = parseFactor();
            if (op === '*') {
                value *= right;
            } else {
                if (right === 0) throw new Error('Division by zero');
                value /= right;
            }
        }
        return value;
    };

    function parseExpression(): number {
        let value = parseTerm();
        while (true) {
            skipWhitespace();
            const op = expr[index];
            if (op !== '+' && op !== '-') break;
            index++;
            const right = parseTerm();
            value = op === '+' ? value + right : value - right;
        }
        return value;
    }

    const result = parseExpression();
    skipWhitespace();
    if (index !== expr.length || !Number.isFinite(result)) {
        throw new Error(`Invalid expression: ${expr}`);
    }

    return Math.round(result);
}

/**
 * Parse range shortcut into array of "x,y" coordinate strings
 *
 * FORMATS:
 * - row:N or row:N:x1:x2 - horizontal line at y=N
 * - col:N or col:N:y1:y2 - vertical line at x=N
 * - hline:y:x1:x2 - horizontal line
 * - vline:x:y1:y2 - vertical line
 * - line:x1,y1,x2,y2 - point-to-point line (Bresenham)
 * - rect:x,y,w,h - filled rectangle
 * - border:margin - outer border
 * - fill:x1,y1,x2,y2 - fill rectangle by corners
 * - expr:EQUATION:xMin:xMax - algebraic expression (e.g., "expr:2*x+5:0:50")
 * - x=N or x=N:y1:y2 - vertical line shorthand
 * - y=N or y=N:x1:x2 - horizontal line shorthand
 * - y=EXPR:xMin:xMax - algebraic y as function of x (e.g., "y=2*x+3:0:20")
 */
function parseRangeShortcut(range: string, gridWidth: number, gridHeight: number): string[] {
    const tiles: string[] = [];

    // Check for algebraic shorthand first: x=N, y=N, y=expr
    if (range.startsWith('x=')) {
        // x=N or x=N:y1:y2 - vertical line
        const afterEquals = range.substring(2);
        const colonParts = afterEquals.split(':');
        const x = parseInt(colonParts[0], 10);
        const y1 = colonParts[1] ? parseInt(colonParts[1], 10) : 0;
        const y2 = colonParts[2] ? parseInt(colonParts[2], 10) : gridHeight - 1;
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
            tiles.push(`${x},${y}`);
        }
        return tiles;
    }

    if (range.startsWith('y=')) {
        // y=N or y=N:x1:x2 - horizontal line OR y=expr:x1:x2 - algebraic
        const afterEquals = range.substring(2);
        const colonParts = afterEquals.split(':');
        const firstPart = colonParts[0];

        // Check if it's a simple number or an expression
        const isSimpleNumber = /^-?\d+$/.test(firstPart);

        if (isSimpleNumber) {
            // y=N:x1:x2 - simple horizontal line
            const y = parseInt(firstPart, 10);
            const x1 = colonParts[1] ? parseInt(colonParts[1], 10) : 0;
            const x2 = colonParts[2] ? parseInt(colonParts[2], 10) : gridWidth - 1;
            for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
                tiles.push(`${x},${y}`);
            }
        } else {
            // y=expr:x1:x2 - algebraic expression
            const expr = firstPart;
            const xMin = colonParts[1] ? parseInt(colonParts[1], 10) : 0;
            const xMax = colonParts[2] ? parseInt(colonParts[2], 10) : gridWidth - 1;
            for (let x = xMin; x <= xMax; x++) {
                const y = evaluateExpression(expr, x);
                if (y >= 0 && y < gridHeight) {
                    tiles.push(`${x},${y}`);
                }
            }
        }
        return tiles;
    }

    const parts = range.split(':');
    const command = parts[0].toLowerCase();

    switch (command) {
        case 'row': {
            // row:N or row:N:x1:x2
            const y = parseInt(parts[1], 10);
            const x1 = parts[2] ? parseInt(parts[2], 10) : 0;
            const x2 = parts[3] ? parseInt(parts[3], 10) : gridWidth - 1;
            for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
                tiles.push(`${x},${y}`);
            }
            break;
        }
        case 'col': {
            // col:N or col:N:y1:y2
            const x = parseInt(parts[1], 10);
            const y1 = parts[2] ? parseInt(parts[2], 10) : 0;
            const y2 = parts[3] ? parseInt(parts[3], 10) : gridHeight - 1;
            for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
                tiles.push(`${x},${y}`);
            }
            break;
        }
        case 'hline': {
            // hline:y:x1:x2 - horizontal line
            const y = parseInt(parts[1], 10);
            const x1 = parseInt(parts[2], 10);
            const x2 = parseInt(parts[3], 10);
            for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
                tiles.push(`${x},${y}`);
            }
            break;
        }
        case 'vline': {
            // vline:x:y1:y2 - vertical line
            const x = parseInt(parts[1], 10);
            const y1 = parseInt(parts[2], 10);
            const y2 = parseInt(parts[3], 10);
            for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
                tiles.push(`${x},${y}`);
            }
            break;
        }
        case 'line': {
            // line:x1,y1,x2,y2 - point-to-point line using Bresenham
            const lineParts = parts[1].split(',');
            const x1 = parseInt(lineParts[0], 10);
            const y1 = parseInt(lineParts[1], 10);
            const x2 = parseInt(lineParts[2], 10);
            const y2 = parseInt(lineParts[3], 10);
            tiles.push(...bresenhamLine(x1, y1, x2, y2));
            break;
        }
        case 'rect': {
            // rect:x,y,w,h - filled rectangle
            const rectParts = parts[1].split(',');
            const rx = parseInt(rectParts[0], 10);
            const ry = parseInt(rectParts[1], 10);
            const rw = parseInt(rectParts[2], 10);
            const rh = parseInt(rectParts[3], 10);
            for (let y = ry; y < ry + rh; y++) {
                for (let x = rx; x < rx + rw; x++) {
                    tiles.push(`${x},${y}`);
                }
            }
            break;
        }
        case 'box': {
            // box:x,y,w,h - hollow rectangle (just the border)
            const boxParts = parts[1].split(',');
            const bx = parseInt(boxParts[0], 10);
            const by = parseInt(boxParts[1], 10);
            const bw = parseInt(boxParts[2], 10);
            const bh = parseInt(boxParts[3], 10);
            // Top and bottom edges
            for (let x = bx; x < bx + bw; x++) {
                tiles.push(`${x},${by}`);
                tiles.push(`${x},${by + bh - 1}`);
            }
            // Left and right edges (excluding corners)
            for (let y = by + 1; y < by + bh - 1; y++) {
                tiles.push(`${bx},${y}`);
                tiles.push(`${bx + bw - 1},${y}`);
            }
            break;
        }
        case 'border': {
            // border:margin - outer border with margin inward
            const margin = parseInt(parts[1], 10);
            // Top edge
            for (let x = margin; x < gridWidth - margin; x++) {
                tiles.push(`${x},${margin}`);
            }
            // Bottom edge
            for (let x = margin; x < gridWidth - margin; x++) {
                tiles.push(`${x},${gridHeight - 1 - margin}`);
            }
            // Left edge (excluding corners already added)
            for (let y = margin + 1; y < gridHeight - margin - 1; y++) {
                tiles.push(`${margin},${y}`);
            }
            // Right edge (excluding corners already added)
            for (let y = margin + 1; y < gridHeight - margin - 1; y++) {
                tiles.push(`${gridWidth - 1 - margin},${y}`);
            }
            break;
        }
        case 'fill': {
            // fill:x1,y1,x2,y2 - fill from corner to corner
            const fillParts = parts[1].split(',');
            const fx1 = parseInt(fillParts[0], 10);
            const fy1 = parseInt(fillParts[1], 10);
            const fx2 = parseInt(fillParts[2], 10);
            const fy2 = parseInt(fillParts[3], 10);
            for (let y = Math.min(fy1, fy2); y <= Math.max(fy1, fy2); y++) {
                for (let x = Math.min(fx1, fx2); x <= Math.max(fx1, fx2); x++) {
                    tiles.push(`${x},${y}`);
                }
            }
            break;
        }
        case 'circle': {
            // circle:cx,cy,r - filled circle at center (cx,cy) with radius r
            const circleParts = parts[1].split(',');
            const cx = parseInt(circleParts[0], 10);
            const cy = parseInt(circleParts[1], 10);
            const r = parseInt(circleParts[2], 10);
            for (let y = cy - r; y <= cy + r; y++) {
                for (let x = cx - r; x <= cx + r; x++) {
                    if ((x - cx) ** 2 + (y - cy) ** 2 <= r ** 2) {
                        if (x >= 0 && x < gridWidth && y >= 0 && y < gridHeight) {
                            tiles.push(`${x},${y}`);
                        }
                    }
                }
            }
            break;
        }
        case 'ring': {
            // ring:cx,cy,r - hollow circle (just the perimeter)
            const ringParts = parts[1].split(',');
            const rcx = parseInt(ringParts[0], 10);
            const rcy = parseInt(ringParts[1], 10);
            const rr = parseInt(ringParts[2], 10);
            // Use parametric circle
            for (let angle = 0; angle < 360; angle += 1) {
                const rad = (angle * Math.PI) / 180;
                const x = Math.round(rcx + rr * Math.cos(rad));
                const y = Math.round(rcy + rr * Math.sin(rad));
                const key = `${x},${y}`;
                if (x >= 0 && x < gridWidth && y >= 0 && y < gridHeight && !tiles.includes(key)) {
                    tiles.push(key);
                }
            }
            break;
        }
        case 'expr': {
            // expr:EQUATION:xMin:xMax - explicit algebraic expression
            const expr = parts[1];
            const xMin = parts[2] ? parseInt(parts[2], 10) : 0;
            const xMax = parts[3] ? parseInt(parts[3], 10) : gridWidth - 1;
            for (let x = xMin; x <= xMax; x++) {
                const y = evaluateExpression(expr, x);
                if (y >= 0 && y < gridHeight) {
                    tiles.push(`${x},${y}`);
                }
            }
            break;
        }
        default:
            throw new Error(`Unknown range command: ${command}. Valid: row, col, hline, vline, line, rect, box, border, fill, circle, ring, expr, x=, y=`);
    }

    return tiles;
}

/**
 * Handle updating terrain during an active encounter
 */
export async function handleUpdateTerrain(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.UPDATE_TERRAIN.inputSchema.parse(args);
    let engine = getCombatManager().get(`${ctx.sessionId}:${parsed.encounterId}`);

    // Auto-load from database if not in memory
    if (!engine) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        const state = repo.loadState(parsed.encounterId);

        if (!state) {
            throw new Error(`Encounter ${parsed.encounterId} not found.`);
        }

        engine = new CombatEngine(parsed.encounterId, pubsub || undefined);
        engine.loadState(state);
        getCombatManager().create(`${ctx.sessionId}:${parsed.encounterId}`, engine);
    }

    const state = engine.getState();
    if (!state) {
        throw new Error('No active encounter');
    }

    // Initialize terrain if it doesn't exist
    if (!state.terrain) {
        state.terrain = { obstacles: [], difficultTerrain: [], water: [] };
    }

    // Get or create the appropriate terrain array
    const terrainKey = parsed.terrainType as 'obstacles' | 'difficultTerrain' | 'water';
    if (!state.terrain[terrainKey]) {
        state.terrain[terrainKey] = [];
    }

    const terrainArray = state.terrain[terrainKey] as string[];
    let modified = 0;

    // Expand ranges into tiles if provided
    const gridWidth = parsed.gridWidth ?? 100;
    const gridHeight = parsed.gridHeight ?? 100;
    let allTiles: string[] = parsed.tiles ? [...parsed.tiles] : [];

    if (parsed.ranges) {
        for (const range of parsed.ranges) {
            const expanded = parseRangeShortcut(range, gridWidth, gridHeight);
            allTiles.push(...expanded);
        }
    }

    if (parsed.operation === 'add') {
        // Add tiles that don't already exist (use Set for efficiency with large arrays)
        const existingSet = new Set(terrainArray);
        for (const tile of allTiles) {
            if (!existingSet.has(tile)) {
                terrainArray.push(tile);
                existingSet.add(tile);
                modified++;
            }
        }
    } else {
        // Remove tiles
        const tileSet = new Set(allTiles);
        const originalLength = terrainArray.length;
        state.terrain[terrainKey] = terrainArray.filter(t => !tileSet.has(t));
        modified = originalLength - (state.terrain[terrainKey] as string[]).length;
    }

    // Save updated state to database
    const db = getDb();
    const repo = new EncounterRepository(db);
    repo.saveState(parsed.encounterId, state);

    // Build response
    const stateJson = buildStateJson(state, parsed.encounterId);
    let output = `\n⛏️ TERRAIN UPDATED\n`;
    output += `├─ Operation: ${parsed.operation.toUpperCase()}\n`;
    output += `├─ Type: ${parsed.terrainType}\n`;
    output += `├─ Tiles modified: ${modified}\n`;
    output += `└─ Total ${parsed.terrainType}: ${(state.terrain[terrainKey] as string[]).length}\n`;

    // Append JSON for frontend parsing
    output += `\n\n<!-- STATE_JSON\n${JSON.stringify(stateJson)}\nSTATE_JSON -->`;

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}

/**
 * Handle placing an improvised prop on the battlefield
 */
export async function handlePlaceProp(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.PLACE_PROP.inputSchema.parse(args);
    let engine = getCombatManager().get(`${ctx.sessionId}:${parsed.encounterId}`);

    // Auto-load from database if not in memory
    if (!engine) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        const state = repo.loadState(parsed.encounterId);

        if (!state) {
            throw new Error(`Encounter ${parsed.encounterId} not found.`);
        }

        engine = new CombatEngine(parsed.encounterId, pubsub || undefined);
        engine.loadState(state);
        getCombatManager().create(`${ctx.sessionId}:${parsed.encounterId}`, engine);
    }

    const state = engine.getState();
    if (!state) {
        throw new Error('No active encounter');
    }

    // Initialize props array if it doesn't exist
    if (!state.props) {
        state.props = [];
    }

    // Generate a unique ID for the prop
    const propId = `prop-${parsed.label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;

    // Create the prop object
    const prop = {
        id: propId,
        position: parsed.position,
        label: parsed.label,
        propType: parsed.propType,
        heightFeet: parsed.heightFeet,
        cover: parsed.cover || 'none',
        climbable: parsed.climbable || false,
        climbDC: parsed.climbDC,
        breakable: parsed.breakable || false,
        hp: parsed.hp,
        currentHp: parsed.hp,
        description: parsed.description
    };

    state.props.push(prop);

    // Save updated state to database
    const db = getDb();
    const repo = new EncounterRepository(db);
    repo.saveState(parsed.encounterId, state);

    // Build response
    const stateJson = buildStateJson(state, parsed.encounterId);
    
    const coverIcon = {
        'none': '○',
        'half': '◐',
        'three_quarter': '◕',
        'full': '●'
    }[prop.cover || 'none'];

    let output = `\\n🏗️ PROP PLACED\\n`;
    output += `┌─────────────────────────────────────────┐\\n`;
    output += `│ ${parsed.label}\\n`;
    output += `└─────────────────────────────────────────┘\\n\\n`;
    output += `📍 Position: (${parsed.position})\\n`;
    output += `📦 Type: ${parsed.propType}\\n`;
    if (parsed.heightFeet) output += `📏 Height: ${parsed.heightFeet} ft\\n`;
    output += `🛡️ Cover: ${coverIcon} ${parsed.cover || 'none'}\\n`;
    if (parsed.climbable) output += `🧗 Climbable: DC ${parsed.climbDC || 10}\\n`;
    if (parsed.breakable && parsed.hp) output += `💔 Breakable: ${parsed.hp} HP\\n`;
    if (parsed.description) output += `\\n📜 ${parsed.description}\\n`;

    // Append JSON for frontend parsing
    output += `\\n\\n<!-- STATE_JSON\\n${JSON.stringify(stateJson)}\\nSTATE_JSON -->`;

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}

/**
 * Handle measuring distance between two points or entities
 */
export async function handleMeasureDistance(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.MEASURE_DISTANCE.inputSchema.parse(args);
    let engine = getCombatManager().get(`${ctx.sessionId}:${parsed.encounterId}`);

    // Auto-load from database if not in memory
    if (!engine) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        const state = repo.loadState(parsed.encounterId);

        if (!state) {
            throw new Error(`Encounter ${parsed.encounterId} not found.`);
        }

        engine = new CombatEngine(parsed.encounterId, pubsub || undefined);
        engine.loadState(state);
        getCombatManager().create(`${ctx.sessionId}:${parsed.encounterId}`, engine);
    }

    const state = engine.getState();
    if (!state) {
        throw new Error('No active encounter');
    }

    // Helper to parse position or get entity position
    const getPosition = (ref: { type: 'position' | 'entity'; value: string }): { x: number; y: number; name: string } => {
        if (ref.type === 'position') {
            const [x, y] = ref.value.split(',').map(Number);
            return { x, y, name: `(${ref.value})` };
        } else {
            const participant = state.participants.find(p => p.id === ref.value);
            if (!participant) {
                throw new Error(`Entity ${ref.value} not found in encounter`);
            }
            const pos = participant.position || { x: 0, y: 0 };
            return { x: pos.x, y: pos.y, name: participant.name };
        }
    };

    const fromPos = getPosition(parsed.from);
    const toPos = getPosition(parsed.to);

    // Calculate distance using D&D Chebyshev distance (diagonal = 5ft)
    const dx = Math.abs(toPos.x - fromPos.x);
    const dy = Math.abs(toPos.y - fromPos.y);
    const distanceSquares = Math.max(dx, dy);
    const distanceFeet = distanceSquares * 5;

    // Also calculate Euclidean for reference
    const euclideanSquares = Math.sqrt(dx * dx + dy * dy);
    const euclideanFeet = Math.round(euclideanSquares * 5);

    let output = `\\n📏 DISTANCE MEASURED\\n`;
    output += `┌─────────────────────────────────────────┐\\n`;
    output += `│ ${fromPos.name} → ${toPos.name}\\n`;
    output += `└─────────────────────────────────────────┘\\n\\n`;
    output += `🎯 Distance: ${distanceFeet} ft (${distanceSquares} squares)\\n`;
    output += `   (Using D&D 5e diagonal = 5ft rule)\\n\\n`;
    output += `📐 Euclidean: ~${euclideanFeet} ft\\n`;
    output += `   (Δx: ${dx} squares, Δy: ${dy} squares)\\n`;

    // Add range category for quick reference
    let rangeCategory = '';
    if (distanceFeet <= 5) rangeCategory = '⚔️ Melee range';
    else if (distanceFeet <= 30) rangeCategory = '🏃 Normal movement';
    else if (distanceFeet <= 60) rangeCategory = '🏹 Short bow range';
    else if (distanceFeet <= 120) rangeCategory = '🎯 Longbow short range';
    else if (distanceFeet <= 150) rangeCategory = '🔮 Most spell range';
    else rangeCategory = '🌍 Long range';

    output += `\\n${rangeCategory}\\n`;

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}

/**
 * Handle generating a terrain patch with procedural noise
 */
export async function handleGenerateTerrainPatch(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.GENERATE_TERRAIN_PATCH.inputSchema.parse(args);
    let engine = getCombatManager().get(`${ctx.sessionId}:${parsed.encounterId}`);

    // Auto-load from database if not in memory
    if (!engine) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        const state = repo.loadState(parsed.encounterId);

        if (!state) {
            throw new Error(`Encounter ${parsed.encounterId} not found.`);
        }

        engine = new CombatEngine(parsed.encounterId, pubsub || undefined);
        engine.loadState(state);
        getCombatManager().create(`${ctx.sessionId}:${parsed.encounterId}`, engine);
    }

    const state = engine.getState();
    if (!state) {
        throw new Error('No active encounter');
    }

    // Initialize terrain and props if needed
    if (!state.terrain) {
        state.terrain = { obstacles: [], difficultTerrain: [], water: [] };
    }
    if (!state.props) {
        state.props = [];
    }

    // If pattern is specified, use pattern generator instead of biome
    if (parsed.pattern) {
        const patternGen = getPatternGenerator(parsed.pattern);
        const result = patternGen(parsed.origin.x, parsed.origin.y, parsed.width, parsed.height);
        
        // Add generated terrain to state
        state.terrain!.obstacles.push(...result.obstacles);
        if (!state.terrain!.water) state.terrain!.water = [];
        state.terrain!.water.push(...result.water);
        state.terrain!.difficultTerrain!.push(...result.difficultTerrain);
        
        // Add props
        for (const prop of result.props) {
            state.props!.push({
                id: `prop-${Date.now()}-${randomUUID().slice(0, 8)}`,
                label: prop.label,
                position: prop.position,
                heightFeet: prop.heightFeet,
                propType: prop.propType as any,
                cover: prop.cover as any,
                description: PATTERN_DESCRIPTIONS[parsed.pattern]
            });
        }
        
        // Persist state
        const db = getDb();
        const repo = new EncounterRepository(db);
        repo.saveState(parsed.encounterId, state);
        
        const stateJson = buildStateJson(state, parsed.encounterId);
        const output = `🏔️ TERRAIN PATTERN GENERATED: ${parsed.pattern.toUpperCase()}\n` +
            `📐 Area: (${parsed.origin.x},${parsed.origin.y}) to (${parsed.origin.x + parsed.width},${parsed.origin.y + parsed.height})\n` +
            `🧱 Obstacles: ${result.obstacles.length}\n` +
            `💧 Water: ${result.water.length}\n` +
            `🌿 Difficult terrain: ${result.difficultTerrain.length}\n` +
            `🏗️ Props: ${result.props.length}\n\n` +
            `<!-- STATE_JSON\n${JSON.stringify(stateJson)}\nSTATE_JSON -->`;
        
        return {
            content: [{ type: 'text' as const, text: output }]
        };
    }

    // Simple noise function (seeded)
    const seedStr = parsed.seed || `${parsed.biome}-${Date.now()}`;
    let seedNum = 0;
    for (let i = 0; i < seedStr.length; i++) {
        seedNum = ((seedNum << 5) - seedNum) + seedStr.charCodeAt(i);
        seedNum = seedNum & seedNum;
    }
    const random = () => {
        seedNum = (seedNum * 1103515245 + 12345) & 0x7fffffff;
        return seedNum / 0x7fffffff;
    };

    // Calculate center for optional clearing
    const centerX = parsed.origin.x + Math.floor(parsed.width / 2);
    const centerY = parsed.origin.y + Math.floor(parsed.height / 2);
    const clearRadius = Math.min(parsed.width, parsed.height) / 4;

    const isClear = (x: number, y: number) => {
        if (!parsed.clearCenter) return false;
        const dx = x - centerX;
        const dy = y - centerY;
        return Math.sqrt(dx * dx + dy * dy) < clearRadius;
    };

    // Biome generation configurations
    const biomeConfigs: Record<string, {
        obstacles: { chance: number; pattern: 'scatter' | 'cluster' | 'edge' };
        difficult: { chance: number; pattern: 'scatter' | 'cluster' };
        water: { chance: number; pattern: 'pools' | 'river' | 'none' };
        props: Array<{ label: string; propType: string; chance: number; heightFeet?: number; cover?: string; climbable?: boolean }>;
    }> = {
        forest: {
            obstacles: { chance: 0.05, pattern: 'scatter' },
            difficult: { chance: 0.2, pattern: 'scatter' },
            water: { chance: 0.02, pattern: 'pools' },
            props: [
                { label: 'Oak Tree', propType: 'climbable', chance: 0.15, heightFeet: 25, cover: 'half', climbable: true },
                { label: 'Pine Tree', propType: 'climbable', chance: 0.1, heightFeet: 30, cover: 'half', climbable: true },
                { label: 'Fallen Log', propType: 'cover', chance: 0.03, heightFeet: 3, cover: 'half' },
                { label: 'Boulder', propType: 'cover', chance: 0.02, heightFeet: 5, cover: 'three_quarter' }
            ]
        },
        cave: {
            obstacles: { chance: 0.2, pattern: 'edge' },
            difficult: { chance: 0.15, pattern: 'scatter' },
            water: { chance: 0.1, pattern: 'pools' },
            props: [
                { label: 'Stalactite', propType: 'hazard', chance: 0.05, heightFeet: 15 },
                { label: 'Rock Pillar', propType: 'structure', chance: 0.04, heightFeet: 20, cover: 'full' },
                { label: 'Glowing Mushroom', propType: 'decoration', chance: 0.08, heightFeet: 2 }
            ]
        },
        village: {
            obstacles: { chance: 0.25, pattern: 'cluster' },
            difficult: { chance: 0.05, pattern: 'scatter' },
            water: { chance: 0.01, pattern: 'pools' },
            props: [
                { label: 'Market Stall', propType: 'cover', chance: 0.04, heightFeet: 8, cover: 'half' },
                { label: 'Wagon', propType: 'cover', chance: 0.02, heightFeet: 6, cover: 'three_quarter' },
                { label: 'Barrel', propType: 'cover', chance: 0.06, heightFeet: 4, cover: 'half' },
                { label: 'Well', propType: 'structure', chance: 0.01, heightFeet: 4, cover: 'half' }
            ]
        },
        dungeon: {
            obstacles: { chance: 0.15, pattern: 'edge' },
            difficult: { chance: 0.1, pattern: 'scatter' },
            water: { chance: 0.02, pattern: 'pools' },
            props: [
                { label: 'Stone Pillar', propType: 'structure', chance: 0.03, heightFeet: 15, cover: 'half' },
                { label: 'Rubble Pile', propType: 'cover', chance: 0.05, heightFeet: 3, cover: 'half' },
                { label: 'Brazier', propType: 'interactive', chance: 0.02, heightFeet: 5 },
                { label: 'Spike Trap', propType: 'hazard', chance: 0.02, heightFeet: 0 }
            ]
        },
        swamp: {
            obstacles: { chance: 0.1, pattern: 'scatter' },
            difficult: { chance: 0.4, pattern: 'cluster' },
            water: { chance: 0.35, pattern: 'pools' },
            props: [
                { label: 'Dead Tree', propType: 'structure', chance: 0.08, heightFeet: 15, cover: 'half' },
                { label: 'Lily Pad', propType: 'decoration', chance: 0.1, heightFeet: 0 },
                { label: 'Hollow Log', propType: 'cover', chance: 0.02, heightFeet: 4, cover: 'three_quarter' }
            ]
        },
        battlefield: {
            obstacles: { chance: 0.1, pattern: 'scatter' },
            difficult: { chance: 0.25, pattern: 'scatter' },
            water: { chance: 0.0, pattern: 'none' },
            props: [
                { label: 'Barricade', propType: 'cover', chance: 0.08, heightFeet: 4, cover: 'three_quarter' },
                { label: 'Overturned Cart', propType: 'cover', chance: 0.03, heightFeet: 5, cover: 'three_quarter' },
                { label: 'Broken Siege Engine', propType: 'cover', chance: 0.01, heightFeet: 10, cover: 'full' },
                { label: 'Debris Pile', propType: 'cover', chance: 0.05, heightFeet: 3, cover: 'half' }
            ]
        }
    };

    const config = biomeConfigs[parsed.biome];
    let obstaclesAdded = 0;
    let difficultAdded = 0;
    let waterAdded = 0;
    let propsAdded = 0;

    // Generate terrain
    for (let y = parsed.origin.y; y < parsed.origin.y + parsed.height; y++) {
        for (let x = parsed.origin.x; x < parsed.origin.x + parsed.width; x++) {
            if (isClear(x, y)) continue;

            const adjustedDensity = parsed.density || 0.5;
            const tileKey = `${x},${y}`;

            // Edge pattern modifier
            const edgeDist = Math.min(
                x - parsed.origin.x,
                parsed.origin.x + parsed.width - 1 - x,
                y - parsed.origin.y,
                parsed.origin.y + parsed.height - 1 - y
            );
            const isEdge = edgeDist < 2;

            // Obstacles
            let obstacleChance = config.obstacles.chance * adjustedDensity;
            if (config.obstacles.pattern === 'edge' && isEdge) obstacleChance *= 3;
            if (random() < obstacleChance) {
                state.terrain.obstacles.push(tileKey);
                obstaclesAdded++;
                continue; // Don't place other things on obstacles
            }

            // Water
            if (config.water.pattern !== 'none' && random() < config.water.chance * adjustedDensity) {
                if (!state.terrain.water) state.terrain.water = [];
                state.terrain.water.push(tileKey);
                waterAdded++;
                continue;
            }

            // Difficult terrain
            if (random() < config.difficult.chance * adjustedDensity) {
                if (!state.terrain.difficultTerrain) state.terrain.difficultTerrain = [];
                state.terrain.difficultTerrain.push(tileKey);
                difficultAdded++;
            }

            // Props
            for (const propDef of config.props) {
                if (random() < propDef.chance * adjustedDensity) {
                    const propId = `prop-${parsed.biome}-${propsAdded}-${Date.now()}`;
                    state.props.push({
                        id: propId,
                        position: tileKey,
                        label: propDef.label,
                        propType: propDef.propType as any,
                        heightFeet: propDef.heightFeet,
                        cover: (propDef.cover || 'none') as any,
                        climbable: propDef.climbable,
                        climbDC: propDef.climbable ? 10 : undefined
                    });
                    propsAdded++;
                    break; // Only one prop per tile
                }
            }
        }
    }

    // Save updated state
    const db = getDb();
    const repo = new EncounterRepository(db);
    repo.saveState(parsed.encounterId, state);

    // Build response
    const stateJson = buildStateJson(state, parsed.encounterId);
    
    let output = `\\n🌍 TERRAIN PATCH GENERATED\\n`;
    output += `┌─────────────────────────────────────────┐\\n`;
    output += `│ Biome: ${parsed.biome.toUpperCase()}\\n`;
    output += `│ Area: ${parsed.width}×${parsed.height} (${parsed.origin.x},${parsed.origin.y})\\n`;
    output += `│ Density: ${(parsed.density || 0.5) * 100}%\\n`;
    output += `└─────────────────────────────────────────┘\\n\\n`;
    output += `📊 Generated:\\n`;
    output += `   🧱 Obstacles: ${obstaclesAdded}\\n`;
    output += `   🌿 Difficult terrain: ${difficultAdded}\\n`;
    output += `   💧 Water: ${waterAdded}\\n`;
    output += `   🏗️ Props: ${propsAdded}\\n`;
    
    if (parsed.clearCenter) {
        output += `\\n✨ Center area kept clear for party placement\\n`;
    }

    // Append JSON for frontend
    output += `\\n\\n<!-- STATE_JSON\\n${JSON.stringify(stateJson)}\\nSTATE_JSON -->`;

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}

/**
 * Handle generating terrain with a specific pattern template
 */
export async function handleGenerateTerrainPattern(args: unknown, ctx: SessionContext) {
    const parsed = CombatTools.GENERATE_TERRAIN_PATTERN.inputSchema.parse(args);
    let engine = getCombatManager().get(`${ctx.sessionId}:${parsed.encounterId}`);

    // Auto-load from database if not in memory
    if (!engine) {
        const db = getDb();
        const repo = new EncounterRepository(db);
        const state = repo.loadState(parsed.encounterId);

        if (!state) {
            throw new Error(`Encounter ${parsed.encounterId} not found.`);
        }

        engine = new CombatEngine(parsed.encounterId, pubsub || undefined);
        engine.loadState(state);
        getCombatManager().create(`${ctx.sessionId}:${parsed.encounterId}`, engine);
    }

    const state = engine.getState();
    if (!state) {
        throw new Error('No active encounter');
    }

    // Initialize terrain and props if needed
    if (!state.terrain) {
        state.terrain = { obstacles: [], difficultTerrain: [], water: [] };
    }
    if (!state.props) {
        state.props = [];
    }

    // Generate pattern - handle maze-specific options
    type PatternResult = { obstacles: string[]; water: string[]; difficultTerrain: string[]; props: Array<{position: string; label: string; heightFeet: number; propType: string; cover: string}> };
    let result: PatternResult;
    if (parsed.pattern === 'maze') {
        // Import maze generator with corridor width support
        const { generateMaze } = await import('../terrain-patterns.js');
        result = generateMaze(
            parsed.origin.x,
            parsed.origin.y,
            parsed.width,
            parsed.height,
            parsed.seed,
            parsed.corridorWidth ?? 1
        );
    } else if (parsed.pattern === 'maze_rooms') {
        const { generateMazeWithRooms } = await import('../terrain-patterns.js');
        result = generateMazeWithRooms(
            parsed.origin.x,
            parsed.origin.y,
            parsed.width,
            parsed.height,
            parsed.seed,
            parsed.roomCount ?? 5
        );
    } else {
        const patternGen = getPatternGenerator(parsed.pattern as any);
        result = patternGen(parsed.origin.x, parsed.origin.y, parsed.width, parsed.height, parsed.seed);
    }
    
    // Add generated terrain to state
    state.terrain.obstacles.push(...result.obstacles);
    if (!state.terrain.water) state.terrain.water = [];
    state.terrain.water.push(...result.water);
    if (!state.terrain.difficultTerrain) state.terrain.difficultTerrain = [];
    state.terrain.difficultTerrain.push(...result.difficultTerrain);
    
    // Add props
    for (const prop of result.props) {
        state.props.push({
            id: `prop-${Date.now()}-${randomUUID().slice(0, 8)}`,
            label: prop.label,
            position: prop.position,
            heightFeet: prop.heightFeet,
            propType: prop.propType as any,
            cover: prop.cover as any,
            description: PATTERN_DESCRIPTIONS[parsed.pattern]
        });
    }
    
    // Persist state
    const db = getDb();
    const repo = new EncounterRepository(db);
    repo.saveState(parsed.encounterId, state);
    
    const stateJson = buildStateJson(state, parsed.encounterId);
    const output = `🏔️ TERRAIN PATTERN GENERATED: ${parsed.pattern.toUpperCase()}\n` +
        `📐 Area: (${parsed.origin.x},${parsed.origin.y}) to (${parsed.origin.x + parsed.width},${parsed.origin.y + parsed.height})\n` +
        `🧱 Obstacles: ${result.obstacles.length}\n` +
        `💧 Water: ${result.water.length}\n` +
        `🌿 Difficult terrain: ${result.difficultTerrain.length}\n` +
        `🏗️ Props: ${result.props.length}\n\n` +
        PATTERN_DESCRIPTIONS[parsed.pattern] + `\n\n` +
        `<!-- STATE_JSON\n${JSON.stringify(stateJson)}\nSTATE_JSON -->`;
    
    return {
        content: [{ type: 'text' as const, text: output }]
    };
}
