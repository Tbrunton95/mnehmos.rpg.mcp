/**
 * Exposure timers (Deep One audit request 10): a pool that climbs with the
 * world clock. "Brine-bound: dry_hours +1 per hour, at 12 → a condition" is
 * one entry on characters.exposure; world_manage advance (and traverse
 * {advanceClock}) tick every exposed character in the world by
 * perHour × elapsedHours, clamp to the pool's cap, and add the threshold
 * conditions as each `at` is crossed. A clock correction never ticks: no
 * time passed. Pure arithmetic lives here; the handlers read and write the
 * rows.
 */
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { pushPoolHistory } from './scheduled-ops.js';

/** A fresh schema each call: no outer tool schema may hold one zod instance twice. */
export function exposureThresholdSchema() {
    return z.object({
        at: z.number().describe('Pool value that, once reached or crossed, adds the condition'),
        condition: z.object({
            name: z.string().min(1),
            effect: z.string().optional().describe('What it does, stored as the condition source'),
            duration: z.number().int().optional().describe('Duration in rounds; omit for until-removed')
        }),
        once: z.boolean().optional().describe('Fire once per threshold (default true); false re-adds the condition on every crossing')
    });
}

export function exposureEntrySchema() {
    return z.object({
        name: z.string().min(1).describe("The timer's name ('brine-bound'); set_exposure upserts by it"),
        pool: z.string().min(1).describe('Pool the hours land in (created at 0/cap when missing)'),
        perHour: z.number().describe('Pool change per elapsed hour (negative drains)'),
        cap: z.number().optional().describe("The pool's max; default the existing pool max, else the highest threshold, else 100"),
        thresholds: z.array(exposureThresholdSchema()).optional(),
        note: z.string().optional()
    });
}

export type ExposureThreshold = z.infer<ReturnType<typeof exposureThresholdSchema>>;
export type ExposureEntry = z.infer<ReturnType<typeof exposureEntrySchema>> & { fired?: string[] };

type Pool = { current: number; max: number; [k: string]: unknown };
type Condition = { name: string; duration?: number; source?: string; [k: string]: unknown };

export interface ExposureTickLine {
    characterId: string;
    name: string;
    pool: string;
    from: number;
    to: number;
    conditionsAdded: string[];
}

/** Parse the stored column; malformed or missing JSON reads as no timers. */
export function parseExposure(raw: string | null | undefined): ExposureEntry[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? (v as ExposureEntry[]).filter(e => e && typeof e.name === 'string' && typeof e.pool === 'string' && typeof e.perHour === 'number') : [];
    } catch { return []; }
}

/** The identity of a threshold inside an entry's fired list. */
export function thresholdKey(t: ExposureThreshold): string {
    return `${t.at}:${t.condition.name}`;
}

/** The cap an entry clamps to: its own, else the pool's, else the highest threshold, else 100. */
export function exposureCap(entry: ExposureEntry, existing?: Pool): number {
    if (entry.cap !== undefined) return entry.cap;
    if (existing) return existing.max;
    const tops = (entry.thresholds ?? []).map(t => t.at);
    return tops.length ? Math.max(...tops) : 100;
}

/** Rounded for display and storage: hours accumulate as floats, but never as 7.000000001. */
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Tick every entry by `hours`. Returns the new pools and conditions (only
 * when something moved), the entries with their fired lists updated, and
 * one report line per entry. Pure: the caller persists.
 */
export function tickExposure(
    characterId: string,
    entries: ExposureEntry[],
    pools: Record<string, Pool>,
    conditions: Condition[],
    hours: number
): { pools: Record<string, Pool>; conditions: Condition[]; entries: ExposureEntry[]; lines: ExposureTickLine[]; poolsTouched: boolean; condsTouched: boolean } {
    const nextPools: Record<string, Pool> = { ...pools };
    let nextConds = [...conditions];
    const lines: ExposureTickLine[] = [];
    let poolsTouched = false, condsTouched = false;
    const nextEntries = entries.map(entry => {
        const existing = nextPools[entry.pool];
        const max = exposureCap(entry, existing);
        const from = existing?.current ?? 0;
        const to = r4(Math.min(max, Math.max(0, from + entry.perHour * hours)));
        const pool: Pool = { ...(existing ?? { current: 0, max }), current: to, max };
        if (!existing || to !== from || existing.max !== max) {
            pushPoolHistory(pool as Parameters<typeof pushPoolHistory>[0], { from, to, delta: r4(to - from), reason: `exposure ${entry.name}: ${hours}h` });
            nextPools[entry.pool] = pool;
            poolsTouched = true;
        }
        const fired = [...(entry.fired ?? [])];
        const conditionsAdded: string[] = [];
        for (const t of entry.thresholds ?? []) {
            const crossed = (from < t.at && to >= t.at) || (from > t.at && to <= t.at);
            if (!crossed) continue;
            const key = thresholdKey(t);
            if (t.once !== false && fired.includes(key)) continue;
            if (t.once !== false) fired.push(key);
            if (nextConds.some(c => c.name === t.condition.name)) continue;
            nextConds.push({
                name: t.condition.name,
                ...(t.condition.duration !== undefined ? { duration: t.condition.duration } : {}),
                source: t.condition.effect ?? `exposure ${entry.name} at ${t.at}`
            });
            condsTouched = true;
            conditionsAdded.push(t.condition.name);
        }
        lines.push({ characterId, name: entry.name, pool: entry.pool, from, to, conditionsAdded });
        return { ...entry, ...(fired.length ? { fired } : {}) };
    });
    return { pools: nextPools, conditions: nextConds, entries: nextEntries, lines, poolsTouched, condsTouched };
}

/** `dry_hours 7/12` — one footer segment per timer. */
export function exposureSummary(entries: ExposureEntry[], pools: Record<string, Pool>): string[] {
    return entries.map(e => {
        const p = pools[e.pool];
        return `${e.pool} ${p ? r4(p.current) : 0}/${exposureCap(e, p)}`;
    });
}

/** Belt-and-braces: the migration carries the column, but a handler never assumes it ran. */
export function ensureExposureColumn(db: Database.Database): void {
    try { db.exec('ALTER TABLE characters ADD COLUMN exposure TEXT'); } catch { /* column exists */ }
}

export function readExposure(db: Database.Database, characterId: string): ExposureEntry[] {
    try {
        const row = db.prepare('SELECT exposure FROM characters WHERE id = ?').get(characterId) as { exposure?: string | null } | undefined;
        return parseExposure(row?.exposure);
    } catch { return []; }
}

export function writeExposure(db: Database.Database, characterId: string, entries: ExposureEntry[]): void {
    db.prepare('UPDATE characters SET exposure = ?, updated_at = ? WHERE id = ?').run(entries.length ? JSON.stringify(entries) : null, new Date().toISOString(), characterId);
}
