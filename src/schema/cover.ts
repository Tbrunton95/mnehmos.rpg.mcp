/**
 * Cover vocabulary shared by the schemas and the engine (play report 5, #1).
 * Pure strings and zod factories; the rules over the combat state live in
 * src/engine/combat/cover.ts.
 */
import { z } from 'zod';

export const COVER_KINDS = ['none', 'half', 'three-quarters', 'total'] as const;
export type CoverKind = typeof COVER_KINDS[number];

/** Every spelling a call or a prop may carry; normalizeCover maps them. */
export const COVER_INPUTS = ['none', 'half', 'three-quarters', 'three-quarter', 'three_quarters', 'three_quarter', '3/4', 'total', 'full'] as const;

export const IGNORE_COVER = ['half-and-three-quarters', 'all'] as const;
export type IgnoreCover = typeof IGNORE_COVER[number];

export const COVER_DIRECTIONS = ['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'] as const;
export type CoverDirection = typeof COVER_DIRECTIONS[number];

/** Standing cover on a token (combat_manage set_cover). */
export interface StandingCover {
    level: CoverKind;
    /** Attacker ids or names it protects against; unset = everyone. set_cover stores ids here and a direction below; the call form {direction} is read too. */
    against?: string[] | { direction: CoverDirection };
    /** The side the cover faces: attackers in that direction (from the token) are covered against. */
    direction?: CoverDirection;
    reason?: string;
}

/** Scope of a sheet-level ignoreCover feature (Sharpshooter: ranged; Spell Sniper: spells). */
export interface IgnoreCoverScopes { ranged?: IgnoreCover; melee?: IgnoreCover; spells?: IgnoreCover }

export function normalizeCover(v: unknown): CoverKind | undefined {
    if (typeof v !== 'string') return undefined;
    const s = v.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
    if (s === 'none' || s === 'no' || s === 'open') return 'none';
    if (s === 'half' || s === '1/2') return 'half';
    if (s === 'three-quarters' || s === 'three-quarter' || s === 'threequarters' || s === '3/4' || s === 'three-fourths') return 'three-quarters';
    if (s === 'total' || s === 'full' || s === 'complete') return 'total';
    return undefined;
}

export function normalizeDirection(v: unknown): CoverDirection | undefined {
    if (typeof v !== 'string') return undefined;
    const s = v.trim().toLowerCase().replace(/[\s_-]+/g, '');
    const map: Record<string, CoverDirection> = {
        n: 'north', north: 'north', s: 'south', south: 'south', e: 'east', east: 'east', w: 'west', west: 'west',
        ne: 'northeast', northeast: 'northeast', nw: 'northwest', northwest: 'northwest',
        se: 'southeast', southeast: 'southeast', sw: 'southwest', southwest: 'southwest'
    };
    return map[s];
}

// ─── schema factories (a fresh instance per call: outer mirrors never hold one zod object twice) ───

export function coverEnum() {
    return z.enum(COVER_INPUTS);
}

export function ignoreCoverEnum() {
    return z.enum(IGNORE_COVER);
}

/**
 * apply_damage / use_ability / lair_action / trigger_readied / cast_spell
 * coverByTarget: {targetId: kind}. A bare kind means every target ({'*': kind}).
 */
export function coverByTargetSchema() {
    return z.preprocess(v => typeof v === 'string' ? { '*': v } : v, z.record(z.string(), coverEnum()));
}

export const COVER_BY_TARGET_DESCRIBE = "Play report 5 #1: cover per target, {targetId: 'none' | 'half' | 'three-quarters' | 'total'} (a bare kind applies to every target). DEX saves take +2 / +5; total leaves the target unaffected. Unset: computed from the map between the origin and each target when both have tokens; pass 'none' for a target the effect gets around";

/** set_cover against: ['id', 'name'] or {direction: 'west'} (also 'w'); normalised to {ids?, direction?}. */
export function standingAgainstSchema() {
    return z.preprocess(v => {
        if (Array.isArray(v)) return { ids: v };
        if (v && typeof v === 'object' && 'direction' in (v as Record<string, unknown>)) {
            const dir = normalizeDirection((v as { direction?: unknown }).direction);
            return { ...(v as Record<string, unknown>), direction: dir ?? (v as { direction?: unknown }).direction };
        }
        if (typeof v === 'string') return { ids: [v] };
        return v;
    }, z.object({
        ids: z.array(z.string().min(1)).min(1).optional(),
        direction: z.enum(COVER_DIRECTIONS).optional()
    }).strict());
}

/** Sheet ignoreCover: a bare value covers every attack; an object scopes it to ranged / melee / spells. */
export function ignoreCoverSchema() {
    return z.preprocess(v => typeof v === 'string' ? { ranged: v, melee: v, spells: v } : v, z.object({
        ranged: ignoreCoverEnum().optional(),
        melee: ignoreCoverEnum().optional(),
        spells: ignoreCoverEnum().optional()
    }).strict());
}

export const IGNORE_COVER_DESCRIBE = "Features that ignore cover, applied by themselves: 'half-and-three-quarters' (Sharpshooter, Spell Sniper) or 'all'. A bare value covers every attack; {ranged?, melee?, spells?} scopes it (Sharpshooter: {ranged: 'half-and-three-quarters'}; Spell Sniper: {spells: 'half-and-three-quarters'}). A profile's own ignoreCover wins when it swings";
