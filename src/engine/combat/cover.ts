/**
 * Cover (play report 5, #1). 5e: half cover +2, three-quarters +5 to AC and
 * to DEX saves against an effect that starts on the far side of it; total
 * cover cannot be targeted directly. Cover never stacks: the single best
 * source counts. The engine knows cover three ways, an explicit value always
 * winning:
 *   1. a per-call `cover` (the GM states it);
 *   2. standing cover set on the token (combat_manage set_cover), against
 *      named attackers or a direction, dropped for the round by breaksCover;
 *   3. computed from the map: props with a cover rating and any creature on
 *      the line of fire (half cover, friend or foe).
 * Pure functions over the combat state; no dice, no writes.
 */
import { footprintCells } from '../../schema/encounter.js';
import type { CombatParticipant, CombatState } from './engine.js';
import {
    COVER_KINDS, COVER_INPUTS, IGNORE_COVER, COVER_DIRECTIONS, normalizeCover, normalizeDirection,
    coverEnum, ignoreCoverEnum, coverByTargetSchema, standingAgainstSchema, ignoreCoverSchema, IGNORE_COVER_DESCRIBE, COVER_BY_TARGET_DESCRIBE,
    type CoverKind, type IgnoreCover, type CoverDirection, type StandingCover, type IgnoreCoverScopes
} from '../../schema/cover.js';

export {
    COVER_KINDS, COVER_INPUTS, IGNORE_COVER, COVER_DIRECTIONS, normalizeCover, normalizeDirection,
    coverEnum, ignoreCoverEnum, coverByTargetSchema, standingAgainstSchema, ignoreCoverSchema, IGNORE_COVER_DESCRIBE, COVER_BY_TARGET_DESCRIBE
};
export type { CoverKind, IgnoreCover, CoverDirection, StandingCover, IgnoreCoverScopes };

export interface CoverSource {
    kind: CoverKind;
    /** What gives it: 'declared', a prop label, '<name> (creature)', a standing reason. */
    source: string;
    via: 'call' | 'standing' | 'computed';
}

export interface CoverResolution {
    /** The cover that applies after ignoreCover. */
    kind: CoverKind;
    /** +2 / +5 / 0 (total has no number: the caller refuses). */
    acBonus: number;
    source: string;
    via: 'call' | 'standing' | 'computed' | 'none';
    /** The cover that was there and a feature ignored. */
    ignored?: { kind: CoverKind; source: string; by: IgnoreCover };
    notes?: string[];
}

// ─── the rules ───

export function coverBonus(kind: CoverKind | undefined): number {
    return kind === 'half' ? 2 : kind === 'three-quarters' ? 5 : 0;
}

export function coverRank(kind: CoverKind | undefined): number {
    return kind === 'total' ? 3 : kind === 'three-quarters' ? 2 : kind === 'half' ? 1 : 0;
}

/** Cover never stacks: the single best source, the first among equals. */
export function bestCover(sources: Array<CoverSource | undefined>): CoverSource | undefined {
    let best: CoverSource | undefined;
    for (const s of sources) {
        if (!s || s.kind === 'none') continue;
        if (!best || coverRank(s.kind) > coverRank(best.kind)) best = s;
    }
    return best;
}

type Placed = { id: string; name: string; position?: { x: number; y: number }; size?: string };

/** Is the attacker in `direction` from the target? Cardinals take the 90° arc about their axis (y grows south). */
function bearingMatches(direction: CoverDirection, target: { x: number; y: number }, attacker: { x: number; y: number }): boolean {
    const dx = attacker.x - target.x;
    const dy = attacker.y - target.y;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    switch (direction) {
        case 'north': return dy < 0 && ay >= ax;
        case 'south': return dy > 0 && ay >= ax;
        case 'east': return dx > 0 && ax >= ay;
        case 'west': return dx < 0 && ax >= ay;
        case 'northeast': return dx > 0 && dy < 0;
        case 'northwest': return dx < 0 && dy < 0;
        case 'southeast': return dx > 0 && dy > 0;
        case 'southwest': return dx < 0 && dy > 0;
    }
}

/**
 * The target's standing cover as it applies to this attacker: named attackers
 * (id or name, any case) or a direction read from both positions; none while
 * the round it was broken in lasts.
 */
export function standingCoverAgainst(
    target: Placed & { cover?: StandingCover; coverBrokenRound?: number },
    attacker: Placed,
    round: number | undefined
): CoverSource | undefined {
    const sc = target.cover;
    if (!sc) return undefined;
    const level = normalizeCover(sc.level);
    if (!level || level === 'none') return undefined;
    if (round !== undefined && target.coverBrokenRound === round) return undefined;
    // The token stores ids and direction flat; the call form {direction} is read too.
    const against = Array.isArray(sc.against) ? sc.against : undefined;
    const rawDirection = sc.direction ?? (sc.against && !Array.isArray(sc.against) ? (sc.against as { direction?: unknown }).direction : undefined);
    if (against?.length) {
        const lc = (s: string) => s.trim().toLowerCase();
        const names = against.map(lc);
        if (!names.includes(lc(attacker.id)) && !names.includes(lc(attacker.name))) return undefined;
    }
    const dir = rawDirection !== undefined ? normalizeDirection(rawDirection) : undefined;
    if (rawDirection !== undefined) {
        if (!dir || !target.position || !attacker.position) return undefined;
        if (!bearingMatches(dir, target.position, attacker.position)) return undefined;
    }
    const source = sc.reason ?? (dir ? `cover to the ${dir}` : 'standing cover');
    return { kind: level, source, via: 'standing' };
}

/** Bresenham's line, inclusive of both ends, on integer grid cells. */
export function lineCells(a: { x: number; y: number }, b: { x: number; y: number }): Array<{ x: number; y: number }> {
    const cells: Array<{ x: number; y: number }> = [];
    let x0 = Math.round(a.x), y0 = Math.round(a.y);
    const x1 = Math.round(b.x), y1 = Math.round(b.y);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (let guard = 0; guard < 10000; guard++) {
        cells.push({ x: x0, y: y0 });
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
    }
    return cells;
}

type StateLike = Pick<CombatState, 'participants' | 'props'> & { round?: number; environment?: CombatState['environment'] };

/**
 * A prop's square as place_prop stored it: 'x,y' as the GM typed it ('3,5',
 * '3, 5', '3,5,0' with an elevation), or an {x, y} object. Undefined when it
 * cannot be read, so an odd prop counts for nothing rather than throwing.
 */
export function propCell(position: unknown): { x: number; y: number } | undefined {
    if (position && typeof position === 'object') {
        const p = position as { x?: unknown; y?: unknown };
        return typeof p.x === 'number' && typeof p.y === 'number' ? { x: Math.round(p.x), y: Math.round(p.y) } : undefined;
    }
    if (typeof position !== 'string') return undefined;
    const [x, y] = position.split(',').map(s => Number(s.trim()));
    return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : undefined;
}

/**
 * Cover computed from the map along the line of fire between the two tokens'
 * anchor squares: a rated prop on an intermediate square, or a living
 * creature standing there (half). Neither token's own footprint counts.
 */
export function coverBetween(state: StateLike, attacker: CombatParticipant, target: CombatParticipant): CoverSource | undefined {
    if (!attacker.position || !target.position) return undefined;
    const line = lineCells(attacker.position, target.position);
    const inner = line.slice(1, -1);
    if (!inner.length) return undefined;
    const key = (c: { x: number; y: number }) => `${c.x},${c.y}`;
    const own = new Set([...footprintCells(attacker), ...footprintCells(target)].map(key));
    const candidates: CoverSource[] = [];
    const seen = new Set<string>();
    const add = (c: CoverSource) => { const k = `${c.kind}|${c.source}`; if (!seen.has(k)) { seen.add(k); candidates.push(c); } };
    for (const cell of inner) {
        const k = key(cell);
        if (own.has(k)) continue;
        for (const prop of state.props ?? []) {
            const at = propCell((prop as { position: unknown }).position);
            if (!at || at.x !== cell.x || at.y !== cell.y) continue;
            const kind = normalizeCover(prop.cover);
            if (kind && kind !== 'none') add({ kind, source: prop.label, via: 'computed' });
        }
        for (const p of state.participants) {
            if (p.id === attacker.id || p.id === target.id || p.hp <= 0 || !p.position) continue;
            if (footprintCells(p).some(c => c.x === cell.x && c.y === cell.y)) add({ kind: 'half', source: `${p.name} (creature)`, via: 'computed' });
        }
    }
    return bestCover(candidates);
}

/**
 * The cover that applies to one attack or save: the explicit value when the
 * call states one, else the best of the target's standing cover and the
 * map's; then the attacker's ignoreCover lifts what it names.
 */
export function resolveCover(
    state: StateLike,
    attacker: CombatParticipant,
    target: CombatParticipant,
    opts: { explicit?: unknown; ignoreCover?: IgnoreCover } = {}
): CoverResolution {
    const notes: string[] = [];
    let picked: CoverSource | undefined;
    if (opts.explicit !== undefined && opts.explicit !== null) {
        const explicit = normalizeCover(opts.explicit);
        if (explicit) picked = { kind: explicit, source: 'declared', via: 'call' };
        else notes.push(`unknown cover '${String(opts.explicit)}' ignored (none | half | three-quarters | total)`);
    }
    if (!picked) {
        picked = bestCover([standingCoverAgainst(target, attacker, state.round), coverBetween(state, attacker, target)]);
    }
    const base = (r: CoverResolution) => notes.length ? { ...r, notes } : r;
    if (!picked) return base({ kind: 'none', acBonus: 0, source: 'none', via: 'none' });
    if (picked.kind === 'none') return base({ kind: 'none', acBonus: 0, source: picked.source, via: picked.via });
    if (opts.ignoreCover === 'all' || (opts.ignoreCover === 'half-and-three-quarters' && picked.kind !== 'total')) {
        return base({ kind: 'none', acBonus: 0, source: 'none', via: 'none', ignored: { kind: picked.kind, source: picked.source, by: opts.ignoreCover } });
    }
    return base({ kind: picked.kind, acBonus: coverBonus(picked.kind), source: picked.source, via: picked.via });
}

/** `AC 12 +5 (three-quarters, boulder) = 17`. */
export function coverArithmetic(label: string, base: number, res: CoverResolution): string {
    return `${label} ${base} +${res.acBonus} (${res.kind}, ${res.source}) = ${base + res.acBonus}`;
}

/** `DEX save 10 +3 +2 (half, creature) = 15 vs DC 13`. */
export function saveArithmetic(ability: string, natural: number, modifier: number, res: CoverResolution, total: number, dc: number): string {
    const abbr = ability.slice(0, 3).toUpperCase();
    return `${abbr} save ${natural} ${modifier >= 0 ? '+' : '-'}${Math.abs(modifier)} +${res.acBonus} (${res.kind}, ${res.source}) = ${total} vs DC ${dc}`;
}

/** The line a report shows when a feature ignored cover. */
export function ignoredCoverLine(res: CoverResolution, actorName: string): string | undefined {
    return res.ignored ? `${actorName} ignores ${res.ignored.kind} cover (${res.ignored.source}): ${res.ignored.by === 'all' ? 'ignores all cover' : 'Sharpshooter-style, half and three-quarters'}` : undefined;
}

/** The refusal a total-cover target earns: nothing rolled, nothing spent. */
export function totalCoverRefusal(res: CoverResolution, attackerName: string, targetName: string): Error & { writes: 'none' } {
    const err = new Error(
        `refused: total cover (${res.source}) from ${attackerName}: ${targetName} cannot be targeted directly. `
        + `If the effect still reaches it (an area that gets around the obstruction, a GM ruling), pass cover: 'none' | 'half' | 'three-quarters' for it. Nothing was rolled or spent.`
    ) as Error & { writes: 'none' };
    err.writes = 'none';
    return err;
}

/** Which ignoreCover scope an attack falls under. */
export function ignoreCoverFor(scopes: IgnoreCoverScopes | IgnoreCover | undefined, lane: 'ranged' | 'melee' | 'spells'): IgnoreCover | undefined {
    if (!scopes) return undefined;
    if (typeof scopes === 'string') return scopes;
    return scopes[lane];
}

/** Does this observer see in the dark? Lane D's senses.darkvisionFt, or a DARKVISION condition. */
export function hasDarkvision(p: CombatParticipant): boolean {
    const senses = (p as { senses?: { darkvisionFt?: number; blindsightFt?: number; truesightFt?: number } }).senses;
    if (senses && ((senses.darkvisionFt ?? 0) > 0 || (senses.blindsightFt ?? 0) > 0 || (senses.truesightFt ?? 0) > 0)) return true;
    return (p.conditions ?? []).some(c => String(c.type).toLowerCase() === 'darkvision');
}

/**
 * Who this token could attempt to hide from, and why: standing or computed
 * cover of three-quarters or better against a living foe, darkness against a
 * foe without darkvision, or heavy obscurement on the token. A report, never
 * a roll.
 */
export function canHideReport(state: StateLike, token: CombatParticipant): Array<{ from: string; reason: string }> {
    const out: Array<{ from: string; reason: string }> = [];
    if (token.hp <= 0) return out;
    const dark = (state.environment as { light?: string } | undefined)?.light === 'darkness';
    const obscured = (token.conditions ?? []).find(c => /heavily obscured|heavy obscurement/i.test(String(c.type)));
    for (const o of state.participants) {
        if (o.id === token.id || o.hp <= 0 || !!o.isEnemy === !!token.isEnemy) continue;
        const best = bestCover([standingCoverAgainst(token, o, state.round), coverBetween(state, o, token)]);
        if (best && coverRank(best.kind) >= 2) { out.push({ from: o.name, reason: `${best.kind} cover (${best.source})` }); continue; }
        if (obscured) { out.push({ from: o.name, reason: String(obscured.type) }); continue; }
        if (dark && !hasDarkvision(o)) out.push({ from: o.name, reason: `darkness (${o.name} has no darkvision)` });
    }
    return out;
}
