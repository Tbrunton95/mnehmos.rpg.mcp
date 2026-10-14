/**
 * Saving throws inside an encounter.
 *
 * One composition for every save the combat handlers roll (spell saves, lair
 * saves, concentration): ability modifier + save proficiency by level, rolled
 * on the encounter's seeded stream so the die reaches roll_log.
 *
 * Sheets key abilities short (stats.dex); tokens key them long
 * (abilityScores.dexterity). The spell loop used to look up the short key on
 * the long-keyed map, so every spell save modifier came out 0. Both styles
 * are read here.
 */
import type Database from 'better-sqlite3';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import type { CombatEngine, CombatParticipant, SaverSidesProvider } from './engine.js';
import { resolveWorldId } from '../table-rules.js';
import { worldProgression } from '../progression.js';
import { loggedD20 } from '../../math/logged-d20.js';
import { loadEffectDeclarations, conditionSaveDisadvantage, tokenSaveConditions } from '../advantage-sources.js';
import { declaredOnRoll, purposeWithSources, rollSidesNote } from '../attack-advantage.js';

export type AbilityLong = 'strength' | 'dexterity' | 'constitution' | 'intelligence' | 'wisdom' | 'charisma';
export type AbilityShort = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

const LONG: Record<AbilityShort, AbilityLong> = {
    str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma'
};
const SHORT = Object.fromEntries(Object.entries(LONG).map(([s, l]) => [l, s])) as Record<AbilityLong, AbilityShort>;

/** 'DEX', 'dex', 'Dexterity' -> 'dexterity'; unknown -> undefined. */
export function toLongAbility(ability: string): AbilityLong | undefined {
    const a = ability.trim().toLowerCase();
    if (a in SHORT) return a as AbilityLong;
    return LONG[a as AbilityShort];
}

export type AbilityScoresLong = Record<AbilityLong, number>;

/** The six, long, in sheet order. */
export const ABILITY_LONG_KEYS: AbilityLong[] = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const VALID_ABILITY_KEYS = 'str, dex, con, int, wis, cha (or strength, dexterity, constitution, intelligence, wisdom, charisma)';

/**
 * Play report 7 #2: a token's ability scores from what the caller sent:
 * stats (short keys) and/or abilityScores (long or short, any case). Every
 * key goes through toLongAbility. A key naming no ability is a problem, and
 * so is one ability given two different values (across the maps or inside
 * one). Missing abilities come from base (a creature's statline), else 10.
 * Nothing given: {}.
 */
export function tokenAbilityScores(
    input: { stats?: Record<string, number> | null; abilityScores?: Record<string, number> | null },
    base?: Partial<AbilityScoresLong> | null
): { scores?: AbilityScoresLong; given?: Partial<AbilityScoresLong>; problem?: string } {
    const given: Partial<AbilityScoresLong> = {};
    const seen: Partial<Record<AbilityLong, string>> = {};
    for (const [field, map] of [['stats', input.stats], ['abilityScores', input.abilityScores]] as const) {
        if (!map) continue;
        const unknown = Object.keys(map).filter(k => !toLongAbility(k));
        if (unknown.length) return { problem: `unknown ability key${unknown.length > 1 ? 's' : ''} ${unknown.map(k => `'${k}'`).join(', ')} in ${field}: use ${VALID_ABILITY_KEYS}` };
        for (const [k, v] of Object.entries(map)) {
            const long = toLongAbility(k)!;
            const prior = given[long];
            if (prior !== undefined && prior !== v) {
                return { problem: `${long} is given twice with different values (${seen[long]} ${prior} vs ${field}.${k} ${v}): send one value` };
            }
            given[long] = v;
            seen[long] = `${field}.${k}`;
        }
    }
    if (!Object.keys(given).length) return {};
    const scores = Object.fromEntries(ABILITY_LONG_KEYS.map(l => [l, given[l] ?? base?.[l] ?? 10])) as AbilityScoresLong;
    return { scores, given };
}

/** 'STR 16, DEX 12, …' for a reply line. */
export function abilityScoresLine(scores: Partial<Record<string, number>>): string {
    return ABILITY_LONG_KEYS.map(l => `${SHORT[l].toUpperCase()} ${scores[l] ?? scores[SHORT[l]] ?? 10}`).join(', ');
}

/** Proficiency bonus by character level (or CR for a sheetless monster). */
export function proficiencyByLevel(level: number): number {
    return Math.floor((Math.max(1, level) - 1) / 4) + 2;
}

export interface SaveSource {
    /** Sheet stats, short keys. */
    stats?: Partial<Record<string, number>>;
    /** Token ability scores, long keys. */
    abilityScores?: Partial<Record<string, number>>;
    saveProficiencies?: string[];
    level?: number;
    cr?: number;
    /** Item 10: the proficiency bonus from the world's curve, when the source has a sheet. */
    profBonus?: number;
}

export interface SaveModifier {
    mod: number;
    prof: number;
    total: number;
    parts: string[];
}

export function saveModifier(src: SaveSource, ability: string): SaveModifier {
    const long = toLongAbility(ability) ?? 'dexterity';
    const short = SHORT[long];
    const score = src.stats?.[short] ?? src.abilityScores?.[long] ?? src.abilityScores?.[short] ?? src.stats?.[long] ?? 10;
    const mod = Math.floor((score - 10) / 2);
    const parts = [`${short.toUpperCase()} ${mod >= 0 ? '+' : ''}${mod}`];
    const proficient = (src.saveProficiencies ?? []).some(s => toLongAbility(s) === long);
    let prof = 0;
    if (proficient) {
        prof = src.profBonus ?? proficiencyByLevel(src.level ?? (src.cr !== undefined ? Math.max(1, src.cr) : 1));
        parts.push(`save proficiency +${prof}`);
    }
    return { mod, prof, total: mod + prof, parts };
}

export interface ParticipantSaveResult {
    ability: AbilityLong;
    dc: number;
    rolls: number[];
    natural: number;
    modifier: number;
    total: number;
    saved: boolean;
    parts: string[];
    /** A legendary resistance turned this failed save into a success. */
    legendaryResisted?: boolean;
    /** Failed, and this many legendary resistances are left for the GM to spend. */
    legendaryResistanceAvailable?: number;
    /**
     * Play report 7 (lane G1): what put this save at advantage or
     * disadvantage: the caller's own sources, the saver's untagged
     * save:<ability> mechanics ('Danger Sense (save:dex)') and the standard
     * conditions' 5e rules ('restrained', 'exhaustion 3'). Both sides set:
     * they cancelled, and one die was rolled.
     */
    advantageSources?: string[];
    disadvantageSources?: string[];
    /** A tagged save:<ability> mechanic in scope that did not fire: a save the engine rolls asserts no tag. */
    conditionalAdvantage?: string[];
    conditionalDisadvantage?: string[];
}

/**
 * Play report 7 (lane G1): what a save the engine rolls by itself reads off
 * the saver's active effects (by its id: a sheet-backed token's id is its
 * character id), through lane F's declaredOnRoll. Untagged save:<ability>
 * mechanics fire ('Danger Sense (save:dex)'); a tagged one never does, since
 * no call carries a tag for each target (as lane F treats opportunity and
 * readied attacks), and is `gated` for the hint. The older form (a number in
 * value, save / autoApply keys) never touched an engine save and still does not.
 */
export interface EngineSaveDeclarations {
    advantage: string[];
    disadvantage: string[];
    gated: Array<{ which: 'advantage' | 'disadvantage'; effect: string; tag: string; scope: string }>;
}

export function engineSaveDeclarations(db: Database.Database | undefined, saverId: string, ability: string): EngineSaveDeclarations {
    const long = toLongAbility(ability) ?? 'dexterity';
    let effects: ReturnType<typeof loadEffectDeclarations> = [];
    if (db) { try { effects = loadEffectDeclarations(db, saverId); } catch { effects = []; } }
    const d = declaredOnRoll(effects, { kind: 'save', ability: SHORT[long] });
    return { advantage: d.advantage, disadvantage: d.disadvantage, gated: d.gated };
}

/** Play report 7 (lane G1): what a save param says about the target's own declared sides (combat_manage apply_damage / use_ability / lair_action). */
export const ENGINE_SAVE_DESCRIBE = "Play report 7: each target's own declared save sides fire by themselves: an untagged effect mechanic {type: 'advantage_on' | 'disadvantage_on', value: 'save:<ability>'} on the target (Danger Sense: save:dex rolls two d20s, keeps the higher), restrained on a DEX save, exhaustion 3+; they cancel as usual. A tagged one never fires here (no call carries a tag per target) and is named in conditionalAdvantage. targets[] (advantageSources, disadvantageSources, saveRolls), saveSources and the roll log name every source. A concentrating target's CON save after the damage reads its save:con sides and exhaustion 3+ the same way (lane H: targets[].concentration, a saveSources row with save: 'concentration on <spell>')";

/** The hint for a tagged mechanic an engine save did not fire. */
function engineSaveHint(g: EngineSaveDeclarations['gated'][number], long: AbilityLong): string {
    return `${g.effect} (${g.tag}): a save the engine rolls asserts no tag, so it did not fire; write the mechanic without condition: '${g.tag}' if it holds on every ${SHORT[long].toUpperCase()} save`;
}

type SaveLabels = Pick<ParticipantSaveResult, 'advantageSources' | 'disadvantageSources' | 'conditionalAdvantage' | 'conditionalDisadvantage'>;

/**
 * Both sides of one engine save: the caller's sources first, then the
 * declared mechanics, then the standard conditions' 5e rules. Each label
 * counts once. `conditions` are the saver's ({name: a token's type or a
 * sheet's text, level}).
 */
function engineSaveSides(
    long: AbilityLong,
    declared: EngineSaveDeclarations,
    conditions: ReadonlyArray<{ name: string; level?: number }>,
    opts: { advSources?: string[]; disSources?: string[] }
): { adv: string[]; dis: string[]; labels: SaveLabels } {
    const once = (list: string[]) => list.filter((x, i) => list.findIndex(y => y.toLowerCase() === x.toLowerCase()) === i);
    const adv = once([...(opts.advSources ?? []), ...declared.advantage]);
    const dis = once([...(opts.disSources ?? []), ...declared.disadvantage, ...conditionSaveDisadvantage(conditions, SHORT[long])]);
    const hints = (which: 'advantage' | 'disadvantage') => declared.gated.filter(g => g.which === which).map(g => engineSaveHint(g, long));
    const ca = hints('advantage'), cd = hints('disadvantage');
    return {
        adv, dis,
        labels: {
            ...(adv.length ? { advantageSources: adv } : {}),
            ...(dis.length ? { disadvantageSources: dis } : {}),
            ...(ca.length ? { conditionalAdvantage: ca } : {}),
            ...(cd.length ? { conditionalDisadvantage: cd } : {})
        }
    };
}

/**
 * Play report 7 (lane G1): the sources a save took, for a reply line:
 * ' [d20 4, 17; adv: Danger Sense (save:dex)]', '' when it took none. Both
 * sides on one die say they cancelled.
 */
export function saveSidesNote(s: Pick<ParticipantSaveResult, 'rolls' | 'advantageSources' | 'disadvantageSources'>): string {
    return rollSidesNote(s.rolls, { advantage: s.advantageSources, disadvantage: s.disadvantageSources });
}

/**
 * Play report 7 (lane G1): one row of a reply's top-level saveSources (kept
 * whole by output_mode 'summary'): who saved, the dice (a unit: how many
 * models rolled), and what put the save at advantage or disadvantage, or the
 * tag a tagged mechanic waited for. Undefined for a save with none of these.
 */
export interface SaveSourcesRow {
    targetId: string;
    name: string;
    ability: string;
    /** Play report 7 (lane H): which save, when it is not the effect's own ('concentration on Bless'). */
    save?: string;
    /** Lane H review: a concentration row's outcome (true: the spell ended), so a summary reply says whether it held. */
    broken?: boolean;
    rolls?: number[];
    models?: number;
    advantage?: string[];
    disadvantage?: string[];
    conditional?: string[];
}
export function saveSourcesRow(
    target: { id: string; name: string },
    s: SaveLabels & { ability: string; rolls?: number[] },
    opts: { models?: number; save?: string } = {}
): SaveSourcesRow | undefined {
    const conditional = [...(s.conditionalAdvantage ?? []), ...(s.conditionalDisadvantage ?? [])];
    if (!s.advantageSources?.length && !s.disadvantageSources?.length && !conditional.length) return undefined;
    return {
        targetId: target.id, name: target.name, ability: s.ability,
        ...(opts.save ? { save: opts.save } : {}),
        ...(opts.models !== undefined ? { models: opts.models } : s.rolls ? { rolls: s.rolls } : {}),
        ...(s.advantageSources?.length ? { advantage: s.advantageSources } : {}),
        ...(s.disadvantageSources?.length ? { disadvantage: s.disadvantageSources } : {}),
        ...(conditional.length ? { conditional } : {})
    };
}

/** The saver's conditions as the 5e save rules read them (a token's type or a sheet's name, an exhaustion level). */
export type SaveConditions = ReadonlyArray<{ name: string; level?: number }>;

/**
 * Play report 7 (lane H): where a save's d20 comes from. One die, or two
 * keep one, all under one purpose: the fight's seeded stream
 * (engineSaveStream: two dice under one tag are one roll record) or a logged
 * d20 outside a fight (loggedSaveStream: one roll_log row holding both dice,
 * crypto unless seeded). Either way a seed replays both dice.
 */
export type SaveDieStream = (purpose: string, mode: { advantage: boolean; disadvantage: boolean }) => { rolls: number[]; natural: number };

export function engineSaveStream(engine: Pick<CombatEngine, 'rollD20'>, forId: string): SaveDieStream {
    return (purpose, mode) => {
        const tag = { purpose, forId };
        const rolls = [engine.rollD20(tag)];
        if (mode.advantage !== mode.disadvantage) rolls.push(engine.rollD20(tag));
        const natural = mode.advantage && !mode.disadvantage ? Math.max(...rolls) : mode.disadvantage && !mode.advantage ? Math.min(...rolls) : rolls[0];
        return { rolls, natural };
    };
}

export function loggedSaveStream(db: Database.Database, forId: string, tool?: string): SaveDieStream {
    return (purpose, mode) => {
        const die = loggedD20(db, { purpose, forId }, { advantage: mode.advantage, disadvantage: mode.disadvantage, tool });
        return { rolls: die.rolls, natural: die.natural };
    };
}

/** A save's d20 and what put it at advantage or disadvantage (or a tagged mechanic's hint). */
export interface SaveDie extends SaveLabels {
    rolls: number[];
    /** The kept die. */
    natural: number;
    /** The roll log purpose, naming each source. */
    purpose: string;
}

/**
 * Play report 7 (lanes G1, H): the one d20 every save the engine rolls by
 * itself goes through: both sides (the caller's, the saver's untagged
 * save:<ability> mechanics, the standard conditions' 5e rules), the purpose
 * labelled with them, one die or two on the given stream. rollParticipantSave
 * and rollCharacterSave add their modifier to it; a concentration save
 * (concentrationDie) hands it to checkConcentration.
 */
export function rollSaveDie(
    stream: SaveDieStream,
    ability: string,
    declared: EngineSaveDeclarations,
    conditions: SaveConditions,
    opts: { purpose: string; advantage?: boolean; disadvantage?: boolean; advSources?: string[]; disSources?: string[] }
): SaveDie {
    const long = toLongAbility(ability) ?? 'dexterity';
    const sides = engineSaveSides(long, declared, conditions, opts);
    const purpose = purposeWithSources(opts.purpose, { advantage: sides.adv, disadvantage: sides.dis });
    const die = stream(purpose, { advantage: !!opts.advantage || sides.adv.length > 0, disadvantage: !!opts.disadvantage || sides.dis.length > 0 });
    return { rolls: die.rolls, natural: die.natural, purpose, ...sides.labels };
}

/**
 * Play report 7 (lane H): a save's labels as a result record carries them:
 * the sources, both dice (saveRolls) when two were rolled, a tagged
 * mechanic's hint. Nothing at all for a save that took none.
 */
export interface SaveDieLabels {
    advantageSources?: string[];
    disadvantageSources?: string[];
    saveRolls?: number[];
    conditionalAdvantage?: string[];
    conditionalDisadvantage?: string[];
}
export function saveDieLabels(s: SaveLabels & { rolls?: number[] }): SaveDieLabels {
    return {
        ...(s.advantageSources?.length ? { advantageSources: s.advantageSources } : {}),
        ...(s.disadvantageSources?.length ? { disadvantageSources: s.disadvantageSources } : {}),
        ...(s.rolls && s.rolls.length > 1 ? { saveRolls: s.rolls } : {}),
        ...(s.conditionalAdvantage?.length ? { conditionalAdvantage: s.conditionalAdvantage } : {}),
        ...(s.conditionalDisadvantage?.length ? { conditionalDisadvantage: s.conditionalDisadvantage } : {})
    };
}

// ─── Play report 7 (lane H): the concentration CON save ───

/**
 * The concentration save's die, one roll for every road that checks
 * concentration (an attack, cast_spell, an area through resolveAreaSave, a
 * world spell, apply_damage on the sheets, an execute on the sheets,
 * concentration_manage check_save). It reads the concentrating creature's
 * untagged save:con mechanics and its conditions' 5e save rules (exhaustion
 * 3+) through lane G1's reading, rolls two dice on advantage or disadvantage
 * on the road's stream, and labels the purpose ('concentration (adv: Steady
 * Mind (save:con))'; plain 'concentration' with no source). A tagged
 * mechanic never fires (no call asserts a tag) and comes back as a hint.
 * Lazy: nothing is read or rolled until checkConcentration finds an active
 * concentration and draws.
 */
export function concentrationDie(db: Database.Database | undefined, saverId: string, stream: SaveDieStream, conditions: () => SaveConditions): () => SaveDie {
    return () => rollSaveDie(stream, 'constitution', engineSaveDeclarations(db, saverId, 'constitution'), conditions(), { purpose: 'concentration' });
}

/** In a fight: the encounter's seeded stream, and the token's own conditions. */
export function fightConcentrationDie(engine: CombatEngine, db: Database.Database | undefined, saverId: string): () => SaveDie {
    return concentrationDie(db, saverId, engineSaveStream(engine, saverId),
        () => tokenSaveConditions(engine.getState()?.participants.find(p => p.id === saverId)?.conditions));
}

/** On the sheets: a logged d20 (crypto unless seeded), and the sheet's conditions. */
export function sheetConcentrationDie(db: Database.Database, saverId: string, tool?: string): () => SaveDie {
    return concentrationDie(db, saverId, loggedSaveStream(db, saverId, tool), () => {
        const row = new CharacterRepository(db).findById(saverId);
        return row && row.id === saverId ? sheetSaveConditions(db, row) : [];
    });
}

/** What a concentration result carries on a reply: concentrationAfterDamage's shape and the save's labels. */
export type ConcentrationOutcome = { spell: string; broken: boolean; reason: string; saveRoll?: number; saveTotal?: number; saveDC?: number } & SaveDieLabels;

/** A concentration check as a reply carries it: the fields it always had and, only when the save took any, its labels. */
export function concentrationOutcome(check: { spell: string; broken: boolean; reason: string; saveRoll?: number; saveTotal?: number; saveDC?: number } & SaveDieLabels): ConcentrationOutcome {
    return {
        spell: check.spell, broken: check.broken, reason: check.reason, saveRoll: check.saveRoll, saveTotal: check.saveTotal, saveDC: check.saveDC,
        ...saveDieLabels({ ...check, rolls: check.saveRolls })
    };
}

/** Whether a concentration save took a source or left a tagged one waiting (only then does a reply change). */
export function concentrationLabelled(c: SaveDieLabels | undefined): boolean {
    return !!(c && (c.advantageSources?.length || c.disadvantageSources?.length || c.conditionalAdvantage?.length || c.conditionalDisadvantage?.length));
}

/**
 * The tail a concentration line takes: ' [d20 4, 17; adv: Steady Mind
 * (save:con)]' and each hint on its own line ('conditional: …'); '' for a
 * save that took no source.
 */
export function concentrationSidesNote(c: SaveDieLabels & { saveRoll?: number }, indent = '   '): string {
    const rolls = c.saveRolls ?? (c.saveRoll !== undefined ? [c.saveRoll] : []);
    let note = rollSidesNote(rolls, { advantage: c.advantageSources, disadvantage: c.disadvantageSources });
    for (const h of [...(c.conditionalAdvantage ?? []), ...(c.conditionalDisadvantage ?? [])]) note += `\n${indent}conditional: ${h}`;
    return note;
}

/**
 * A concentration result's line, as every road prints it: 'Concentration on
 * Bless: CON save 15 vs DC 10 ✓ held' (or 'ends at 0 HP'), with the sources'
 * tail when the save took any.
 */
export function concentrationLine(c: ConcentrationOutcome, indent = '   '): string {
    if (c.reason === 'death') return `Concentration on ${c.spell}: ends at 0 HP`;
    return `Concentration on ${c.spell}: CON save ${c.saveTotal} vs DC ${c.saveDC} ${c.broken ? '✗ BROKEN' : '✓ held'}${concentrationSidesNote(c, indent)}`;
}

/** The reply's saveSources row for a concentration save, with whether the spell ended (undefined when the save took no source). */
export function concentrationSourcesRow(target: { id: string; name: string }, c: ConcentrationOutcome): SaveSourcesRow | undefined {
    const rolls = c.saveRolls ?? (c.saveRoll !== undefined ? [c.saveRoll] : undefined);
    const row = saveSourcesRow(target, { ...c, ability: 'constitution', rolls }, { save: `concentration on ${c.spell}` });
    if (!row) return undefined;
    // Lane H review: the outcome rides the row (output_mode summary keeps saveSources whole, not the target rows).
    const { targetId, name, ability, save, ...rest } = row;
    return { targetId, name, ability, save, broken: c.broken, ...rest };
}

/**
 * Where a participant's save numbers come from: its character row when one
 * exists (exact id only; a prefix match must never lend a token a sheet),
 * otherwise the token's own ability scores.
 */
export function saveSourceFor(db: Database.Database | undefined, p: CombatParticipant): SaveSource {
    const tokenProfs = (p as { saveProficiencies?: string[] }).saveProficiencies;
    if (db) {
        const row = new CharacterRepository(db).findById(p.id);
        if (row && row.id === p.id) return sheetSaveSource(db, row, tokenProfs);
    }
    return { abilityScores: p.abilityScores as Record<string, number> | undefined, saveProficiencies: tokenProfs, cr: p.cr };
}

type SheetLike = { id: string; stats?: unknown; level: number; saveProficiencies?: string[]; conditions?: unknown };

/** A character sheet's save numbers: its stats, proficiencies and the world's proficiency curve. */
export function sheetSaveSource(db: Database.Database, row: SheetLike, fallbackProfs?: string[]): SaveSource {
    return {
        stats: row.stats as Record<string, number>,
        saveProficiencies: row.saveProficiencies?.length ? row.saveProficiencies : fallbackProfs,
        level: row.level,
        profBonus: worldProgression(db, resolveWorldId(db, { characterIds: [row.id] })).profBonus(row.level)
    };
}

/** Play report 7 (lane H): a sheet's conditions for a save, by name ('Restrained: pinned', 'Exhaustion 3'). */
export function sheetSaveConditions(db: Database.Database, row: SheetLike): SaveConditions {
    const rowConditions = (Array.isArray(row.conditions) ? row.conditions : new CharacterRepository(db).findById(row.id)?.conditions ?? []) as unknown[];
    return rowConditions.filter((c): c is { name: string } => !!c && typeof (c as { name?: unknown }).name === 'string').map(c => ({ name: c.name }));
}

/**
 * Play report 7 (lane H): the provider the handler layer gives the pure
 * engine for the save it rolls by itself (a save_ends condition's end-of-turn
 * save): the saver's declared sides through lane G1's reading (untagged
 * save:<ability> mechanics; a tagged one as a hint) and its save modifier as
 * every other engine save composes it (saveModifier on saveSourceFor: the
 * sheet's ability and save proficiency on the world's curve, else the token's
 * own scores). The engine applies the token's conditions itself. `db` is read
 * at each save, so a provider outlives a reopened database.
 */
export function engineSaverSides(db: () => Database.Database | undefined): SaverSidesProvider {
    return (participant, ability) => {
        const handle = db();
        const long = toLongAbility(ability) ?? 'dexterity';
        const sides = engineSaveSides(long, engineSaveDeclarations(handle, participant.id, long), [], {});
        const m = saveModifier(saveSourceFor(handle, participant), long);
        return {
            advantage: sides.adv, disadvantage: sides.dis,
            ...(sides.labels.conditionalAdvantage ? { conditionalAdvantage: sides.labels.conditionalAdvantage } : {}),
            ...(sides.labels.conditionalDisadvantage ? { conditionalDisadvantage: sides.labels.conditionalDisadvantage } : {}),
            modifier: { total: m.total, parts: m.parts }
        };
    };
}

/**
 * A character's save outside an encounter: the sheet's modifier and save
 * proficiency on a seeded, logged d20 (roll_log purpose as given, forId the
 * character). Advantage and disadvantage cancel. Play report 7 (lane G1):
 * the character's untagged save:<ability> mechanics and its sheet
 * conditions' 5e save rules (Restrained, Exhaustion 3) fire by themselves,
 * named in the purpose and the result, as on a token's save.
 */
export function rollCharacterSave(
    db: Database.Database,
    row: SheetLike,
    ability: string,
    dc: number,
    opts: { purpose?: string; advantage?: boolean; disadvantage?: boolean; tool?: string; extraBonus?: number } = {}
): ParticipantSaveResult {
    const long = toLongAbility(ability) ?? 'dexterity';
    const m = saveModifier(sheetSaveSource(db, row), long);
    const { rolls, natural, purpose: _purpose, ...labels } = rollSaveDie(loggedSaveStream(db, row.id, opts.tool), long, engineSaveDeclarations(db, row.id, long), sheetSaveConditions(db, row), {
        purpose: opts.purpose ?? `${long} save`, advantage: opts.advantage, disadvantage: opts.disadvantage
    });
    // Play report 5 #1: a situational bonus (cover on a DEX save) rides the modifier.
    const extra = opts.extraBonus ?? 0;
    const parts = [...m.parts];
    if (extra) parts.push(`bonus ${extra >= 0 ? '+' : ''}${extra}`);
    const modifier = m.total + extra;
    const total = natural + modifier;
    return { ability: long, dc, rolls, natural, modifier, total, saved: total >= dc, parts, ...labels };
}

/**
 * Roll one participant's save on the encounter stream. Advantage and
 * disadvantage roll two dice and cancel when both are set; named sources go
 * into the roll's purpose. Exhaustion 3 or more adds its own disadvantage. On a failed save a creature set to
 * autoLegendaryResistance spends one and succeeds; otherwise the remaining
 * count is reported so the GM can choose.
 *
 * Play report 7 (lane G1): every save the engine rolls by itself comes here,
 * so the saver's declared sides fire here: untagged save:<ability> mechanics
 * on its active effects (engineSaveDeclarations, or `declared` when the
 * caller read them once, as a unit does for its models) and the standard
 * conditions' 5e save rules (restrained: DEX). Everything cancels with the
 * caller's sides and exhaustion; the second die comes off the same seeded
 * stream; the purpose and the result name each source.
 */
export function rollParticipantSave(
    engine: CombatEngine,
    db: Database.Database | undefined,
    participant: CombatParticipant,
    ability: string,
    dc: number,
    opts: {
        advantage?: boolean; disadvantage?: boolean; advSources?: string[]; disSources?: string[]; purpose?: string; extraBonus?: number;
        /** Play report 7 #1: one model of a unit saving; legendary resistance belongs to one creature and is neither spent nor offered. */
        noLegendaryResistance?: boolean;
        /** Play report 7 (lane G1): the saver's declared sides, read once by the caller (engineSaveDeclarations); unset: read here. */
        declared?: EngineSaveDeclarations;
    } = {}
): ParticipantSaveResult {
    const long = toLongAbility(ability) ?? 'dexterity';
    const m = saveModifier(saveSourceFor(db, participant), long);
    // Exhaustion 3 or more hampers saves as it does attacks, restrained DEX
    // saves (conditions.ts); untagged save mechanics fire by themselves.
    const { rolls, natural, purpose: _purpose, ...labels } = rollSaveDie(engineSaveStream(engine, participant.id), long,
        opts.declared ?? engineSaveDeclarations(db, participant.id, long), tokenSaveConditions(participant.conditions), {
            ...opts, purpose: opts.purpose ?? `${long} save`
        });

    const extra = opts.extraBonus ?? 0;
    const parts = [...m.parts];
    if (extra) parts.push(`bonus ${extra >= 0 ? '+' : ''}${extra}`);
    const modifier = m.total + extra;
    const total = natural + modifier;
    const result: ParticipantSaveResult = { ability: long, dc, rolls, natural, modifier, total, saved: total >= dc, parts, ...labels };

    if (!result.saved && !opts.noLegendaryResistance) {
        const remaining = participant.legendaryResistancesRemaining ?? 0;
        if (remaining > 0 && participant.autoLegendaryResistance) {
            const spent = engine.useLegendaryResistance(participant.id);
            if (spent.success) {
                result.saved = true;
                result.legendaryResisted = true;
                parts.push(`legendary resistance (${spent.remaining} left)`);
                // Resistances last the day, so the sheet keeps the count (as
                // the legendary_resistance verb does); the next fight hydrates from it.
                if (db) {
                    const repo = new CharacterRepository(db);
                    if (repo.findById(participant.id)?.id === participant.id) {
                        repo.update(participant.id, { legendaryResistancesRemaining: spent.remaining });
                    }
                }
            }
        } else if (remaining > 0) {
            result.legendaryResistanceAvailable = remaining;
        }
    }
    return result;
}
