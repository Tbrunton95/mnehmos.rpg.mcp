/**
 * Item 10: how characters advance in a world. A table_rules `progression`
 * rule sets the mode, the level cap, the XP table and the proficiency curve;
 * without one the SRD holds (XP, level 20, 2 + floor((L-1)/4)).
 */
import type Database from 'better-sqlite3';
import { loadRule } from './table-rules.js';

/** SRD 5e XP to reach each level. */
export const XP_TABLE: Record<number, number> = {
    1: 0, 2: 300, 3: 900, 4: 2700, 5: 6500, 6: 14000, 7: 23000, 8: 34000,
    9: 48000, 10: 64000, 11: 85000, 12: 100000, 13: 120000, 14: 140000,
    15: 165000, 16: 195000, 17: 225000, 18: 265000, 19: 305000, 20: 355000
};
const SRD_XP = Array.from({ length: 20 }, (_, i) => XP_TABLE[i + 1]);

export const SRD_MAX_LEVEL = 20;

export interface WorldProgression {
    mode: 'milestone' | 'xp' | 'none';
    /** null = no cap. */
    maxLevel: number | null;
    /** XP needed to reach a level (1-based). */
    xpFor(level: number): number;
    /** Proficiency bonus at a level. */
    profBonus(level: number): number;
    /** The progression rule's name, when the world has one. */
    rule?: string;
}

/** SRD proficiency bonus by level. */
export function srdProfBonus(level: number): number {
    return Math.floor((Math.max(1, level) - 1) / 4) + 2;
}

/** thresholds[level-1]; past the end the last step repeats. */
function xpFromThresholds(thresholds: number[], level: number): number {
    const l = Math.max(1, Math.floor(level));
    if (l <= thresholds.length) return thresholds[l - 1];
    const last = thresholds[thresholds.length - 1];
    const step = last - thresholds[thresholds.length - 2];
    return last + step * (l - thresholds.length);
}

export function worldProgression(db: Database.Database, worldId: string | null | undefined): WorldProgression {
    const rule = worldId ? loadRule(db, worldId, 'progression') : undefined;
    const spec = rule?.spec;
    const thresholds = spec?.xpThresholds ?? SRD_XP;
    const curve = spec?.profBonus;
    return {
        mode: spec?.mode ?? 'xp',
        maxLevel: spec?.maxLevel === undefined ? SRD_MAX_LEVEL : spec.maxLevel,
        xpFor: (level) => xpFromThresholds(thresholds, level),
        profBonus: (level) => curve
            ? curve[Math.min(Math.max(1, Math.floor(level)), curve.length) - 1]
            : srdProfBonus(level),
        ...(rule ? { rule: rule.name } : {})
    };
}

/** Refuse a level above the world's cap, naming the rule that sets it. */
export function levelCapProblem(p: WorldProgression, level: number): string | undefined {
    if (p.maxLevel === null || level <= p.maxLevel) return undefined;
    const source = p.rule
        ? `table_rules progression '${p.rule}' maxLevel`
        : `the default; a table_rules progression rule with maxLevel (null = no cap) raises it`;
    return `Level ${level} is above this world's max level ${p.maxLevel} (${source}). Nothing was written.`;
}
