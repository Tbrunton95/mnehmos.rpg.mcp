/**
 * Encounter budgeting: the 5e DMG's XP thresholds and group multiplier.
 *
 * Pure and advisory. It reports how hard a fight reads on paper; it never
 * blocks one and never awards XP (the Day 366 table runs milestones).
 */

/** XP by challenge rating (DMG "Experience Points by Challenge Rating"). */
export const XP_BY_CR: ReadonlyArray<readonly [number, number]> = [
    [0, 10], [0.125, 25], [0.25, 50], [0.5, 100],
    [1, 200], [2, 450], [3, 700], [4, 1100], [5, 1800], [6, 2300], [7, 2900], [8, 3900], [9, 5000], [10, 5900],
    [11, 7200], [12, 8400], [13, 10000], [14, 11500], [15, 13000], [16, 15000], [17, 18000], [18, 20000], [19, 22000], [20, 25000],
    [21, 33000], [22, 41000], [23, 50000], [24, 62000], [25, 75000], [26, 90000], [27, 105000], [28, 120000], [29, 135000], [30, 155000]
];

export interface Thresholds { easy: number; medium: number; hard: number; deadly: number }

/** Per-character thresholds by level, 1-20 (DMG "XP Thresholds by Character Level"). */
export const XP_THRESHOLDS: Readonly<Record<number, readonly [number, number, number, number]>> = {
    1: [25, 50, 75, 100], 2: [50, 100, 150, 200], 3: [75, 150, 225, 400], 4: [125, 250, 375, 500],
    5: [250, 500, 750, 1100], 6: [300, 600, 900, 1400], 7: [350, 750, 1100, 1700], 8: [450, 900, 1400, 2100],
    9: [550, 1100, 1600, 2400], 10: [600, 1200, 1900, 2800], 11: [800, 1600, 2400, 3600], 12: [1000, 2000, 3000, 4500],
    13: [1100, 2200, 3400, 5100], 14: [1250, 2500, 3800, 5700], 15: [1400, 2800, 4300, 6400], 16: [1600, 3200, 4800, 7200],
    17: [2000, 3900, 5900, 8800], 18: [2100, 4200, 6300, 9500], 19: [2400, 4900, 7300, 10900], 20: [2800, 5700, 8500, 12700]
};

/** The multiplier ladder; the middle six are the DMG's, the ends are the party-size shifts. */
const LADDER = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5];

export type Difficulty = 'trivial' | 'easy' | 'medium' | 'hard' | 'deadly';

/** XP for a CR: the highest table row at or below it (CR 1.5 reads as 1); above 30 reads as 30. */
export function xpForCr(cr: number): number {
    let xp = XP_BY_CR[0][1];
    for (const [c, v] of XP_BY_CR) if (cr >= c) xp = v;
    return xp;
}

/** Summed thresholds for a party; levels clamp to 1-20. */
export function partyThresholds(levels: number[]): Thresholds {
    const t: Thresholds = { easy: 0, medium: 0, hard: 0, deadly: 0 };
    for (const raw of levels) {
        const row = XP_THRESHOLDS[Math.min(20, Math.max(1, Math.floor(raw)))];
        t.easy += row[0]; t.medium += row[1]; t.hard += row[2]; t.deadly += row[3];
    }
    return t;
}

/**
 * The group multiplier: x1 for one monster up to x4 for fifteen or more,
 * one step up for a party under three and one step down for six or more.
 */
export function encounterMultiplier(monsterCount: number, partySize: number): number {
    if (monsterCount <= 0) return 1;
    let idx = monsterCount === 1 ? 1 : monsterCount === 2 ? 2 : monsterCount <= 6 ? 3 : monsterCount <= 10 ? 4 : monsterCount <= 14 ? 5 : 6;
    if (partySize < 3) idx += 1;
    else if (partySize >= 6) idx -= 1;
    return LADDER[Math.max(0, Math.min(LADDER.length - 1, idx))];
}

export interface BudgetMonster { name?: string; cr?: number; xp?: number; count?: number }

export interface BudgetResult {
    partyLevels: number[];
    partySize: number;
    monsterCount: number;
    rawXp: number;
    multiplier: number;
    adjustedXp: number;
    thresholds: Thresholds;
    difficulty: Difficulty;
    /** Monsters with neither cr nor xp: counted for the multiplier, worth nothing. */
    unrated: string[];
}

/** Rate one encounter for one party. */
export function budgetEncounter(input: { partyLevels: number[]; monsters: BudgetMonster[] }): BudgetResult {
    let rawXp = 0, monsterCount = 0;
    const unrated: string[] = [];
    for (const m of input.monsters) {
        const n = Math.max(1, m.count ?? 1);
        monsterCount += n;
        const each = m.xp ?? (m.cr !== undefined ? xpForCr(m.cr) : undefined);
        if (each === undefined) { unrated.push(m.name ?? 'unnamed'); continue; }
        rawXp += each * n;
    }
    const partySize = input.partyLevels.length;
    const multiplier = encounterMultiplier(monsterCount, partySize);
    const adjustedXp = Math.round(rawXp * multiplier);
    const thresholds = partyThresholds(input.partyLevels);
    const difficulty: Difficulty = adjustedXp >= thresholds.deadly ? 'deadly'
        : adjustedXp >= thresholds.hard ? 'hard'
            : adjustedXp >= thresholds.medium ? 'medium'
                : adjustedXp >= thresholds.easy ? 'easy' : 'trivial';
    return { partyLevels: input.partyLevels, partySize, monsterCount, rawXp, multiplier, adjustedXp, thresholds, difficulty, unrated };
}

/** '4×L3' for an even party, 'L3/L5/L2' otherwise. */
export function describeParty(levels: number[]): string {
    if (!levels.length) return 'no party';
    return levels.every(l => l === levels[0]) ? `${levels.length > 1 ? `${levels.length}×` : ''}L${levels[0]}` : levels.map(l => `L${l}`).join('/');
}
