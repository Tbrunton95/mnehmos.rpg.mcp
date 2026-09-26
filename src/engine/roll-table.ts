/**
 * Pure roll_table mechanics: turn a table's entries into ranges on a die,
 * pick the entry a total lands on, and roll one on any DiceRoller.
 *
 * Weighted entries become cumulative ranges from 1 (weights 2, 1, 1 read
 * 1-2, 3, 4 on a 1d4). Ranged entries keep their numbers. A modifier shifts
 * the total, which is clamped to the table's span, so a big favour bonus
 * reads the top entry instead of falling off the table.
 */
import type { RuleSpec } from './table-rules.js';
import type { DiceRoller } from '../math/logged-d20.js';

export type RollTableSpec = RuleSpec<'roll_table'>;
export type RollTableEntry = RollTableSpec['entries'][number];

export interface TableRange { lo: number; hi: number; index: number; entry: RollTableEntry }

export function tableRanges(spec: RollTableSpec): TableRange[] {
    const ranged = spec.entries.some(e => e.min !== undefined);
    if (ranged) return spec.entries.map((entry, index) => ({ lo: entry.min!, hi: entry.max ?? entry.min!, index, entry }));
    let next = 1;
    return spec.entries.map((entry, index) => {
        const w = entry.weight ?? 1;
        const r = { lo: next, hi: next + w - 1, index, entry };
        next += w;
        return r;
    });
}

/** The table's own dice, or 1d<total weight> / 1d<highest max>. */
export function defaultDice(spec: RollTableSpec): string {
    if (spec.dice) return spec.dice;
    const ranges = tableRanges(spec);
    return `1d${Math.max(...ranges.map(r => r.hi))}`;
}

/**
 * The entry a total lands on, clamped to the span. A total in a gap between
 * ranged entries reads the nearest entry below it.
 */
export function pickEntry(spec: RollTableSpec, total: number): { total: number; clamped: boolean; range: TableRange } {
    const ranges = tableRanges(spec);
    const lo = Math.min(...ranges.map(r => r.lo));
    const hi = Math.max(...ranges.map(r => r.hi));
    const t = Math.max(lo, Math.min(hi, total));
    const hit = ranges.find(r => t >= r.lo && t <= r.hi)
        ?? [...ranges].sort((a, b) => b.hi - a.hi).find(r => r.hi < t)
        ?? ranges[0];
    return { total: t, clamped: t !== total, range: hit };
}

export interface TableRoll {
    dice: string;
    rolls: number[];
    /** The dice alone. */
    natural: number;
    modifier: number;
    /** natural + modifier, clamped to the table's span. */
    total: number;
    clamped?: boolean;
    index: number;
    entry: RollTableEntry;
    rollId?: string;
    seed?: string;
}

export function rollTable(spec: RollTableSpec, roller: DiceRoller, opts: { modifier?: number; tag: string }): TableRoll {
    const dice = defaultDice(spec);
    const modifier = opts.modifier ?? 0;
    const r = roller(dice, opts.tag);
    const picked = pickEntry(spec, r.total + modifier);
    return {
        dice, rolls: r.rolls, natural: r.total, modifier, total: picked.total,
        ...(picked.clamped ? { clamped: true } : {}),
        index: picked.range.index, entry: picked.range.entry,
        ...(r.rollId ? { rollId: r.rollId } : {}), ...(r.seed ? { seed: r.seed } : {})
    };
}
