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
