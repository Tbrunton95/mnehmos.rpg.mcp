/**
 * Favour families: pools that rise and fall together (the four gods). A gain
 * in one member makes each jealous rival lose round(gain × fraction); a loss
 * moves no one else. The family's floor (which may be negative) and max
 * clamp every member it moves, and every moved pool gets a history entry.
 */
import type { RuleSpec } from './table-rules.js';
import { findPool } from './table-rules.js';
import { pushPoolHistory } from './scheduled-ops.js';

export type PoolFamilySpec = RuleSpec<'pool_family'>;
export interface PoolFamily { name: string; spec: PoolFamilySpec }

type Pool = { current: number; max: number; history?: unknown[]; [k: string]: unknown };

export interface FamilyMove { pool: string; from: number; to: number; delta: number; rival?: true }

/** The family's spelling of a member name (any case), or undefined. */
export function familyMember(spec: PoolFamilySpec, pool: string): string | undefined {
    return spec.pools.find(p => p.toLowerCase() === pool.toLowerCase());
}

/** The fraction a rival loses when `gainer` gains, read in any case. */
function jealousyOf(spec: PoolFamilySpec, gainer: string): Array<{ rival: string; fraction: number }> {
    const key = Object.keys(spec.jealousy).find(k => k.toLowerCase() === gainer.toLowerCase());
    if (!key) return [];
    return Object.entries(spec.jealousy[key]).map(([rival, fraction]) => ({ rival, fraction }));
}

/**
 * Move `pool` by `delta` inside its family. Pools are the character's
 * resource pools (keys in any case); the result is a new object. A member
 * the character lacks is created at 0 with the family max (default 100).
 */
export function applyFamilyDelta(
    pools: Record<string, Pool>,
    family: PoolFamily,
    pool: string,
    delta: number,
    reason: string,
    opts: { witnesses?: string[] } = {}
): { pools: Record<string, Pool>; moves: FamilyMove[] } {
    const out: Record<string, Pool> = { ...pools };
    const floor = family.spec.floor ?? 0;
    const moves: FamilyMove[] = [];

    const move = (name: string, d: number, why: string, rival: boolean, extra: Record<string, unknown> = {}): FamilyMove | undefined => {
        const found = findPool(out, name);
        const key = found?.key ?? (familyMember(family.spec, name) ?? name);
        const existing: Pool = found ? { ...found.pool } : { current: 0, max: family.spec.max ?? 100 };
        const max = family.spec.max ?? existing.max;
        const from = existing.current;
        const to = Math.min(max, Math.max(floor, from + d));
        if (rival && to === from) return undefined;
        const next: Pool = { ...existing, current: to, max };
        pushPoolHistory(next, { from, to, delta: d, reason: why, ...extra });
        out[key] = next;
        const m: FamilyMove = { pool: key, from, to, delta: to - from, ...(rival ? { rival: true as const } : {}) };
        moves.push(m);
        return m;
    };

    const main = move(pool, delta, reason, false, opts.witnesses?.length ? { witnesses: opts.witnesses } : {})!;
    const gain = main.to - main.from;
    if (gain > 0) {
        for (const { rival, fraction } of jealousyOf(family.spec, familyMember(family.spec, pool) ?? pool)) {
            const loss = Math.round(gain * fraction);
            if (loss <= 0) continue;
            move(rival, -loss, `jealous of ${main.pool} (+${gain})${reason ? `: ${reason}` : ''}`, true);
        }
    }
    return { pools: out, moves };
}
