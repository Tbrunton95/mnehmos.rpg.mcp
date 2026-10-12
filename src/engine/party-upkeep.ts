/**
 * Party upkeep (play report 3): a warband eats. Stores are MOUTH-DAYS and
 * live in one linked character pool, never on the party; a day consumes
 * `mouths` of them (whole numbers, nothing to convert). The party row keeps
 * only the link, the mouth pools read live (captives, Turnings), the roles
 * counted, the starvation rule and the day it was last charged. world_manage
 * advance charges every whole day since lastDay through the one write path
 * (the pool's history records each charge); a day the stores cannot cover is
 * a starving day — stores to 0 — and docks loyalty from every member except
 * the leader and the mounts. A clock correction never charges: it moves the
 * anchor with the clock. Pure arithmetic lives here; the handlers read and
 * write the rows.
 */
import { z } from 'zod';
import type Database from 'better-sqlite3';

export const MEMBER_ROLES = ['leader', 'member', 'companion', 'hireling', 'prisoner', 'mount'] as const;
export type UpkeepRole = typeof MEMBER_ROLES[number];

/** Fresh schemas each call: no outer tool schema may hold one zod instance twice. */
export function linkPoolSchema() {
    return z.object({
        characterId: z.string().min(1).describe('Whose sheet carries the stores pool (usually the leader)'),
        pool: z.string().min(1).describe("The pool's name ('stores'); it must exist — create it with character_manage adjust_pool {value, max, label}")
    }).describe('set_upkeep: the ONE pool that holds the stores, in mouth-days');
}

export function mouthPoolSchema() {
    return z.object({
        characterId: z.string().min(1).describe('Whose sheet carries the pool'),
        pool: z.string().min(1).describe("A pool whose current value is mouths to feed ('captives'); read live every day")
    });
}

export function starvationSchema() {
    return z.object({
        loyaltyDelta: z.number().int().optional().describe('Loyalty change on a starving day for every member but the leader and mounts (default -1)'),
        perDay: z.boolean().optional().describe('true (default): every starving day docks; false: once at the first shortfall, again only after a fed day')
    }).describe('set_upkeep: what a day without enough stores does');
}

export interface PoolRef { characterId: string; pool: string }

export interface PartyUpkeep {
    linkPool: PoolRef;
    mouthsFromPool?: PoolRef[];
    extraMouths?: number;
    countRoles?: UpkeepRole[];
    starvation: { loyaltyDelta: number; perDay: boolean };
    /** The last whole day charged; the next advance charges days after it. */
    lastDay: number;
    /** The day the current shortfall began; cleared by a fed day. Drives once-mode starvation. */
    starvedSince?: number;
}

export const DEFAULT_STARVATION = { loyaltyDelta: -1, perDay: true } as const;

/** Parse the stored column; malformed or missing JSON reads as no upkeep. */
export function parseUpkeep(raw: string | null | undefined): PartyUpkeep | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as Partial<PartyUpkeep> | null;
        if (!v || typeof v !== 'object' || !v.linkPool || typeof v.linkPool.characterId !== 'string' || typeof v.linkPool.pool !== 'string' || typeof v.lastDay !== 'number') return null;
        return {
            linkPool: { characterId: v.linkPool.characterId, pool: v.linkPool.pool },
            ...(Array.isArray(v.mouthsFromPool) ? { mouthsFromPool: v.mouthsFromPool.filter(p => p && typeof p.characterId === 'string' && typeof p.pool === 'string') } : {}),
            ...(typeof v.extraMouths === 'number' ? { extraMouths: v.extraMouths } : {}),
            ...(Array.isArray(v.countRoles) ? { countRoles: v.countRoles.filter((r): r is UpkeepRole => (MEMBER_ROLES as readonly string[]).includes(r)) } : {}),
            starvation: {
                loyaltyDelta: typeof v.starvation?.loyaltyDelta === 'number' ? v.starvation.loyaltyDelta : DEFAULT_STARVATION.loyaltyDelta,
                perDay: typeof v.starvation?.perDay === 'boolean' ? v.starvation.perDay : DEFAULT_STARVATION.perDay
            },
            lastDay: v.lastDay,
            ...(typeof v.starvedSince === 'number' ? { starvedSince: v.starvedSince } : {})
        };
    } catch { return null; }
}

export interface MouthMember { characterId: string; role: string; unitModels?: number | null }

export interface MouthCount {
    total: number;
    /** Σ unitModels ?? 1 over the counted roles. */
    members: number;
    pools: Array<{ characterId: string; pool: string; mouths: number }>;
    extra: number;
}

/**
 * Mouths per day: every counted member eats one a day (a unit eats its
 * models), each linked mouth pool eats its current value, plus the extra.
 * `poolValue` reads a pool live; a missing pool counts 0.
 */
export function countMouths(members: MouthMember[], upkeep: Pick<PartyUpkeep, 'mouthsFromPool' | 'extraMouths' | 'countRoles'>, poolValue: (ref: PoolRef) => number | null): MouthCount {
    const roles = upkeep.countRoles && upkeep.countRoles.length ? new Set<string>(upkeep.countRoles) : null;
    const memberMouths = members
        .filter(m => !roles || roles.has(m.role))
        .reduce((s, m) => s + Math.max(0, Math.floor(m.unitModels ?? 1)), 0);
    const pools = (upkeep.mouthsFromPool ?? []).map(ref => ({ characterId: ref.characterId, pool: ref.pool, mouths: Math.max(0, Math.floor(poolValue(ref) ?? 0)) }));
    const extra = Math.max(0, Math.floor(upkeep.extraMouths ?? 0));
    return { total: memberMouths + pools.reduce((s, p) => s + p.mouths, 0) + extra, members: memberMouths, pools, extra };
}

/** Whole days the stores cover at today's mouths; null when nobody eats. */
export function daysLeft(stores: number, mouths: number): number | null {
    return mouths > 0 ? Math.floor(Math.max(0, stores) / mouths) : null;
}

/** Starvation loyalty skips the leader and the mounts; everyone else goes hungry. */
export function starvationTarget(role: string): boolean {
    return role !== 'leader' && role !== 'mount';
}

export interface UpkeepTick {
    storesFrom: number;
    storesTo: number;
    starvedDays: number;
    /** The loyalty change to apply once to every starvation target (0 when nobody starved). */
    loyaltyDelta: number;
    upkeep: PartyUpkeep;
}

/**
 * Charge `days` whole days at `mouths` a day from `stores`. A day the stores
 * cannot cover is a starving day: stores to 0. perDay docks on every such
 * day; once-mode docks when a shortfall begins and again only after a fed
 * day. Pure: the caller persists the pool, the loyalty and the upkeep.
 */
export function tickUpkeep(upkeep: PartyUpkeep, stores: number, mouths: number, days: number): UpkeepTick {
    const n = Math.max(0, Math.floor(days));
    let left = Math.max(0, stores);
    let starvedDays = 0;
    let hits = 0;
    let starvedSince = upkeep.starvedSince;
    for (let d = 1; d <= n; d++) {
        const day = upkeep.lastDay + d;
        if (mouths <= 0) { starvedSince = undefined; continue; }
        if (left >= mouths) { left -= mouths; starvedSince = undefined; continue; }
        left = 0;
        starvedDays++;
        if (upkeep.starvation.perDay || starvedSince === undefined) hits++;
        if (starvedSince === undefined) starvedSince = day;
    }
    const next: PartyUpkeep = { ...upkeep, lastDay: upkeep.lastDay + n };
    if (starvedSince !== undefined) next.starvedSince = starvedSince; else delete next.starvedSince;
    // `hits ? … : 0`, never `0 * -1`: a -0 would print as "loyalty -0".
    return { storesFrom: stores, storesTo: left, starvedDays, loyaltyDelta: hits ? hits * upkeep.starvation.loyaltyDelta : 0, upkeep: next };
}

/** Belt-and-braces: the migration carries the column, but a handler never assumes it ran. */
export function ensureUpkeepColumn(db: Database.Database): void {
    try { db.exec('ALTER TABLE parties ADD COLUMN upkeep TEXT'); } catch { /* column exists */ }
}

export function readUpkeep(db: Database.Database, partyId: string): PartyUpkeep | null {
    try {
        const row = db.prepare('SELECT upkeep FROM parties WHERE id = ?').get(partyId) as { upkeep?: string | null } | undefined;
        return parseUpkeep(row?.upkeep);
    } catch { return null; }
}

export function writeUpkeep(db: Database.Database, partyId: string, upkeep: PartyUpkeep | null): void {
    db.prepare('UPDATE parties SET upkeep = ?, updated_at = ? WHERE id = ?').run(upkeep ? JSON.stringify(upkeep) : null, new Date().toISOString(), partyId);
}

/** '200 mouth-days at 18 mouths = 11 days' — the line every reply prints so an old-unit pool is caught before it starves anyone. */
export function storesLine(stores: number, mouths: MouthCount): string {
    const left = daysLeft(stores, mouths.total);
    return `${stores} mouth-days at ${mouths.total} mouths = ${left === null ? 'no one eats' : `${left} days`}`;
}

/** The units reminder: stores are mouth-days, and a pool kept in another unit must be converted before it is linked. */
export const UNITS_NOTE = "Stores are mouth-days: one mouth eats 1 a day, a unit of 10 models eats 10. A pool kept in another unit (camp-days for the whole band) reads wrong here and starves people early: convert it FIRST with character_manage adjust_pool {characterId, pool, value: <mouth-days>, max: <mouth-days>, label: 'Stores (mouth-days)'}, then link it.";
