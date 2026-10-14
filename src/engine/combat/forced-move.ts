/**
 * Forced movement (play report 5, item 2): a shove, a thunderwave, a gust.
 *
 * One square per 5 ft, directly away from the creature doing the pushing
 * (the sign of the gap between the two footprint centres on each axis).
 * A step is taken only when every cell of the mover's footprint at the next
 * anchor is free of terrain obstacles and of other participants' footprints
 * and inside the encounter's grid bounds when it has any. The push stops at
 * the first blocked step and says why.
 *
 * It writes `position` and nothing else: no movement is spent, difficult
 * terrain costs nothing, and it runs no opportunity attacks and no readied
 * triggers — 5e: forced movement never provokes.
 */
import type { CombatParticipant, CombatState } from './engine.js';
import { footprintCells, SIZE_TABLE, DEFAULT_GRID_BOUNDS } from '../../schema/encounter.js';

export interface ForcedMoveResult {
    from: { x: number; y: number };
    to: { x: number; y: number };
    /** Feet asked for. */
    requested: number;
    /** Feet actually moved (a multiple of 5). */
    feet: number;
    squares: number;
    direction: { dx: number; dy: number };
    /** Why the push stopped short, when it did. */
    stoppedBy?: string;
}

type Grid = Pick<CombatState, 'participants' | 'terrain' | 'gridBounds'>;

const squaresOf = (p: { size?: string | null }) => {
    const s = (p.size ?? 'medium').toLowerCase() as keyof typeof SIZE_TABLE;
    return SIZE_TABLE[s in SIZE_TABLE ? s : 'medium'].squares;
};
const centre = (p: { size?: string | null }, pos: { x: number; y: number }) => {
    const half = (squaresOf(p) - 1) / 2;
    return { x: pos.x + half, y: pos.y + half };
};

/**
 * Push `mover` `feet` directly away from `awayFrom`. Both must be placed;
 * the caller reports an unplaced token as a narrative push instead.
 */
export function forcedMove(state: Grid, mover: CombatParticipant, awayFrom: CombatParticipant, feet: number): ForcedMoveResult {
    if (!mover.position || !awayFrom.position) throw new Error('forcedMove needs both tokens placed');
    const from = { x: mover.position.x, y: mover.position.y };
    const requested = Math.max(0, Math.floor(feet / 5) * 5);
    const a = centre(awayFrom, awayFrom.position), m = centre(mover, from);
    const dx = Math.sign(m.x - a.x), dy = Math.sign(m.y - a.y);
    const base: ForcedMoveResult = { from, to: { ...from }, requested, feet: 0, squares: 0, direction: { dx, dy } };
    if (dx === 0 && dy === 0) return { ...base, stoppedBy: 'no direction: the two footprints overlap' };

    const obstacles = new Set<string>(state.terrain?.obstacles ?? []);
    const occupied = new Map<string, string>();
    for (const p of state.participants) {
        if (p.id === mover.id) continue;
        // Play report 7 #10: a rider and its mount share squares; neither blocks the other.
        if (p.id === mover.riderId || p.id === mover.mountedOn) continue;
        for (const cell of footprintCells(p)) occupied.set(`${cell.x},${cell.y}`, p.name);
    }
    // A fight made in this process has no gridBounds; a reloaded one has the
    // default. Read the default either way so a push lands on the same square.
    const bounds = state.gridBounds ?? DEFAULT_GRID_BOUNDS;
    const blockedAt = (anchor: { x: number; y: number }): string | undefined => {
        for (const cell of footprintCells(mover, anchor)) {
            const key = `${cell.x},${cell.y}`;
            if (bounds && (cell.x < bounds.minX || cell.x > bounds.maxX || cell.y < bounds.minY || cell.y > bounds.maxY)) return 'edge of the grid';
            if (obstacles.has(key)) return `obstacle at (${cell.x}, ${cell.y})`;
            const who = occupied.get(key);
            if (who) return `creature ${who}`;
        }
        return undefined;
    };

    let cur = { ...from };
    let stoppedBy: string | undefined;
    const steps = requested / 5;
    for (let i = 0; i < steps; i++) {
        const next = { x: cur.x + dx, y: cur.y + dy };
        const why = blockedAt(next);
        if (why) { stoppedBy = why; break; }
        cur = next;
    }
    const squares = Math.max(Math.abs(cur.x - from.x), Math.abs(cur.y - from.y));
    if (squares > 0) mover.position = { ...mover.position, x: cur.x, y: cur.y };
    return { ...base, to: cur, feet: squares * 5, squares, ...(stoppedBy ? { stoppedBy } : {}) };
}
