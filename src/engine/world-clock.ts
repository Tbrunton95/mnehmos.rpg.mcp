/**
 * The world clock: one reader for the day and time a world stores in its
 * environment. Every clock-driven verb (process_scheduled, firesInHours,
 * ledger process_due, the knowledge/precedent/narrative day stamps) falls
 * back to it when the caller names no day, and the boot packet, get_context
 * and the status block read it here instead of each parsing the JSON inline.
 * An explicit parameter always wins; callers echo clockSource so the GM can
 * see which clock was used.
 */
import type Database from 'better-sqlite3';
import { normalizeWorldEnvironment } from '../schema/world.js';

export interface WorldClock {
    /** Campaign day as stored (usually a whole number). */
    day: number;
    /** 'HH:MM' when the world stores a time. */
    time?: string;
    /** day plus the time as a fraction of a day: Day 47 06:00 is 47.25. */
    at: number;
    /** Stored weather, for the readers that print it beside the clock. */
    weather?: string;
}

/** Day + 'HH:MM' as a fractional day, or null without a numeric day. */
export function clockAt(env: { day?: unknown; time?: unknown } | undefined | null): number | null {
    if (!env || typeof env.day !== 'number') return null;
    let frac = 0;
    if (typeof env.time === 'string') {
        const m = env.time.match(/^(\d{1,2}):(\d{2})$/);
        if (m) frac = (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) / 1440;
    }
    return env.day + frac;
}

/** The stored clock of a world, or null when the world or its day is missing. */
export function readWorldClock(db: Database.Database, worldId: string | null | undefined): WorldClock | null {
    if (!worldId) return null;
    try {
        const row = db.prepare('SELECT environment FROM worlds WHERE id = ?').get(worldId) as { environment?: string | null } | undefined;
        if (!row) return null;
        let raw: unknown = {};
        try { raw = JSON.parse(row.environment || '{}'); } catch { return null; }
        let env: ReturnType<typeof normalizeWorldEnvironment>;
        try { env = normalizeWorldEnvironment(raw); } catch { return null; }
        const at = clockAt(env);
        if (at === null || env.day === undefined) return null;
        return {
            day: env.day,
            ...(typeof env.time === 'string' ? { time: env.time } : {}),
            at,
            ...(env.weatherConditions ? { weather: env.weatherConditions } : {})
        };
    } catch {
        return null;
    }
}

/** The clock `hours` after a fractional day, midnight rollover included. */
export function clockAfter(at: number, hours: number): { day: number; time: string } {
    // Whole minutes, so 0.1h steps never drift into 05:59.
    const total = Math.round((at * 1440) + hours * 60);
    const day = Math.floor(total / 1440);
    const mins = total - day * 1440;
    return { day, time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` };
}

// FINDINGS #89: fractional days print as a clock — 47.5993 is "Day 47, 14:23",
// not "Day 47". The banner truncation hid the very hours #88 added.
export function dayClock(d: number): string {
    const frac = d - Math.floor(d);
    if (frac < 1 / 1440) return `Day ${Math.floor(d)}`;
    const mins = Math.round(frac * 1440);
    return `Day ${Math.floor(d)}, ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/** 'Day 47, 06:00', or 'Day 47' when the world keeps no time. */
export function clockLabel(clock: WorldClock): string {
    return clock.time ? `Day ${clock.day}, ${clock.time}` : `Day ${clock.day}`;
}

/** The hint every refusal carries when neither a parameter nor a clock gave a day. */
export const SET_CLOCK_HINT = "or set the world clock once with world_manage update {worldId, environment: {day, time: 'HH:MM'}}";

/** A record stamped with an in-fiction day later than the world clock. */
export interface ClockRecord {
    source: 'scheduled' | 'precedent' | 'knowledge' | 'narrative';
    day: number;
    what: string;
    id?: string;
}

// '── [Day 58] ──' and '── [Day 58, 14:00] ──', the section stamps
// narrative_manage append writes.
const NARRATIVE_STAMP = /── \[Day (\d+(?:\.\d+)?)(?:, (\d{1,2}):(\d{2}))?\] ──/g;

/**
 * Items 14/15: records dated after the world clock — the sign of a clock
 * that went backwards (a reset epoch, a restored save, a typo). Reads fired
 * scheduled rows, precedents, knowledge roads and narrative day stamps.
 * Debts are left out: a due day in the future is normal. Advisory only;
 * every source degrades to nothing when its table is missing. `at` defaults
 * to the stored clock; no clock means nothing to compare against.
 */
export function recordsAfterClock(db: Database.Database, worldId: string, at?: number): ClockRecord[] {
    const now = at ?? readWorldClock(db, worldId)?.at;
    if (now === undefined || now === null) return [];
    const eps = 1e-6;
    const out: ClockRecord[] = [];
    const tryRows = <T>(fn: () => T[]): T[] => { try { return fn(); } catch { return []; } };
    for (const r of tryRows(() => db.prepare(`SELECT s.id, s.fires_at_day AS day, s.note FROM scheduled_state_changes s
                                                WHERE s.fired = 1 AND s.fires_at_day > ?
                                                AND (s.world_id = ? OR (s.world_id IS NULL AND s.character_id IN (SELECT id FROM characters WHERE world_id = ?)))`).all(now + eps, worldId, worldId) as Array<{ id: number; day: number; note: string | null }>)) {
        out.push({ source: 'scheduled', day: r.day, what: `fired schedule #${r.id}${r.note ? `: ${r.note}` : ''}`, id: String(r.id) });
    }
    for (const r of tryRows(() => db.prepare('SELECT id, day, statement FROM precedents WHERE world_id = ? AND day IS NOT NULL AND day > ?').all(worldId, now + eps) as Array<{ id: string; day: number; statement: string }>)) {
        out.push({ source: 'precedent', day: r.day, what: r.statement.slice(0, 120), id: r.id });
    }
    for (const r of tryRows(() => db.prepare(`SELECT f.key, h.knower_id AS knower, COALESCE(h.knower_name, h.knower_id) AS who, h.day FROM knowledge_holders h
                                                JOIN knowledge_facts f ON f.id = h.fact_id WHERE f.world_id = ? AND h.day IS NOT NULL AND h.day > ?`).all(worldId, now + eps) as Array<{ key: string; knower: string; who: string; day: number }>)) {
        out.push({ source: 'knowledge', day: r.day, what: `${r.who} learned '${r.key}'`, id: `${r.key}:${r.knower}` });
    }
    for (const r of tryRows(() => db.prepare("SELECT id, content FROM narrative_notes WHERE world_id = ? AND content LIKE '%── [Day %'").all(worldId) as Array<{ id: string; content: string }>)) {
        let latest: number | null = null;
        for (const m of r.content.matchAll(NARRATIVE_STAMP)) {
            const d = parseFloat(m[1]) + (m[2] ? (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) / 1440 : 0);
            if (d > now + eps && (latest === null || d > latest)) latest = d;
        }
        if (latest !== null) out.push({ source: 'narrative', day: latest, what: `note ${r.id} has a section stamped ${dayClock(latest)}`, id: r.id });
    }
    return out.sort((a, b) => b.day - a.day);
}

/** One line for boot and get_context, or undefined when nothing is ahead of the clock. */
export function clockWarning(db: Database.Database, worldId: string): string | undefined {
    const clock = readWorldClock(db, worldId);
    if (!clock) return undefined;
    const recs = recordsAfterClock(db, worldId, clock.at);
    if (!recs.length) return undefined;
    const bySource = [...new Set(recs.map(r => r.source))].join(', ');
    return `${recs.length} record(s) dated after the world clock (${clockLabel(clock)}): latest ${dayClock(recs[0].day)} (${recs[0].source}: ${recs[0].what.slice(0, 80)}); sources: ${bySource}. `
        + `The clock may have gone backwards: if so, set it right with world_manage update {worldId, correction: true, environment: {day, time}} (no regeneration, no time_passed). world_manage audit lists every row.`;
}
