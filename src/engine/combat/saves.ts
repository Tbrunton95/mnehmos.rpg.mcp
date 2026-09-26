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
import type { CombatEngine, CombatParticipant } from './engine.js';

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
        prof = proficiencyByLevel(src.level ?? (src.cr !== undefined ? Math.max(1, src.cr) : 1));
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
        if (row && row.id === p.id) {
            return {
                stats: row.stats as Record<string, number>,
                saveProficiencies: (row as { saveProficiencies?: string[] }).saveProficiencies?.length ? (row as { saveProficiencies?: string[] }).saveProficiencies : tokenProfs,
                level: row.level
            };
        }
    }
    return { abilityScores: p.abilityScores as Record<string, number> | undefined, saveProficiencies: tokenProfs, cr: p.cr };
}

/**
 * Roll one participant's save on the encounter stream. Advantage and
 * disadvantage roll two dice and cancel when both are set; named sources go
 * into the roll's purpose. On a failed save a creature set to
 * autoLegendaryResistance spends one and succeeds; otherwise the remaining
 * count is reported so the GM can choose.
 */
export function rollParticipantSave(
    engine: CombatEngine,
    db: Database.Database | undefined,
    participant: CombatParticipant,
    ability: string,
    dc: number,
    opts: { advantage?: boolean; disadvantage?: boolean; advSources?: string[]; disSources?: string[]; purpose?: string; extraBonus?: number } = {}
): ParticipantSaveResult {
    const long = toLongAbility(ability) ?? 'dexterity';
    const m = saveModifier(saveSourceFor(db, participant), long);
    const advSources = opts.advSources ?? [];
    const disSources = opts.disSources ?? [];
    const adv = !!opts.advantage || advSources.length > 0;
    const dis = !!opts.disadvantage || disSources.length > 0;
    const tags: string[] = [];
    if (advSources.length) tags.push(`adv: ${advSources.join(', ')}`);
    if (disSources.length) tags.push(`dis: ${disSources.join(', ')}`);
    const purpose = `${opts.purpose ?? `${long} save`}${tags.length ? ` (${tags.join('; ')})` : ''}`;
    const tag = { purpose, forId: participant.id };

    const rolls = [engine.rollD20(tag)];
    if (adv !== dis) rolls.push(engine.rollD20(tag));
    const natural = adv && !dis ? Math.max(...rolls) : dis && !adv ? Math.min(...rolls) : rolls[0];

    const extra = opts.extraBonus ?? 0;
    const parts = [...m.parts];
    if (extra) parts.push(`bonus ${extra >= 0 ? '+' : ''}${extra}`);
    const modifier = m.total + extra;
    const total = natural + modifier;
    const result: ParticipantSaveResult = { ability: long, dc, rolls, natural, modifier, total, saved: total >= dc, parts };

    if (!result.saved) {
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
