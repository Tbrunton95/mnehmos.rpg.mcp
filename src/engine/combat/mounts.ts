/**
 * Play report 7 #10: a rider and its mount (5e mounted combat).
 *
 * The link lives on the two tokens: the rider carries `mountedOn`, the mount
 * carries `riderId`, and `controlledBy` (the rider's id) when the rider
 * controls it. The rider stands on the mount's anchor square while mounted,
 * so their footprints overlap: every scan that treats other tokens as walls
 * or cover (the move handler, forced movement, cover, opportunity attacks,
 * readied triggers) skips the linked partner.
 *
 * Pure helpers over the encounter state. The handlers spend movement, roll
 * the DEX saves on the fight's dice and write the reply.
 */
import type { CombatParticipant } from './engine.js';
import { sizeRank, footprintCells, edgeDistanceSquares, DEFAULT_GRID_BOUNDS } from '../../schema/encounter.js';

type Pos = { x: number; y: number };
type Grid = { participants: CombatParticipant[]; terrain?: { obstacles?: string[] } | null; gridBounds?: { minX: number; maxX: number; minY: number; maxY: number } | null };

/** The other half of a token's link (its mount, or its rider), as ids. */
export function linkedIds(p: Pick<CombatParticipant, 'mountedOn' | 'riderId'>): string[] {
    return [p.mountedOn, p.riderId].filter((x): x is string => !!x);
}

/** True when a and b are rider and mount of each other. */
export function areLinked(a: Pick<CombatParticipant, 'id' | 'mountedOn' | 'riderId'>, b: Pick<CombatParticipant, 'id' | 'mountedOn' | 'riderId'>): boolean {
    return (!!a.mountedOn && a.mountedOn === b.id) || (!!a.riderId && a.riderId === b.id);
}

export function mountOf(state: Grid, rider: Pick<CombatParticipant, 'mountedOn'>): CombatParticipant | undefined {
    return rider.mountedOn ? state.participants.find(p => p.id === rider.mountedOn) : undefined;
}

export function riderOf(state: Grid, mount: Pick<CombatParticipant, 'riderId'>): CombatParticipant | undefined {
    return mount.riderId ? state.participants.find(p => p.id === mount.riderId) : undefined;
}

/** The mount this rider controls (its slot passes; it acts on the rider's turn). */
export function controlledMountOf(state: Grid, rider: Pick<CombatParticipant, 'id' | 'mountedOn'>): CombatParticipant | undefined {
    const m = mountOf(state, rider);
    return m && m.controlledBy === rider.id && m.riderId === rider.id ? m : undefined;
}

/** True when this token is a mount its rider controls. */
export function isControlledMount(state: Grid, p: Pick<CombatParticipant, 'id' | 'controlledBy' | 'riderId'>): boolean {
    if (!p.controlledBy || p.controlledBy !== p.riderId) return false;
    const rider = state.participants.find(x => x.id === p.controlledBy);
    return !!rider && rider.mountedOn === p.id;
}

export function link(rider: CombatParticipant, mount: CombatParticipant, controlled: boolean): void {
    rider.mountedOn = mount.id;
    mount.riderId = rider.id;
    if (controlled) mount.controlledBy = rider.id; else delete mount.controlledBy;
    if (mount.position) rider.position = { x: mount.position.x, y: mount.position.y };
}

export function unlink(rider?: CombatParticipant, mount?: CombatParticipant): void {
    if (rider) delete rider.mountedOn;
    if (mount) { delete mount.riderId; delete mount.controlledBy; }
}

/** Half the rider's speed, the cost of mounting or dismounting (5e). */
export function halfSpeed(speed: number): number {
    return Math.floor(speed / 2);
}

/**
 * Why `rider` cannot mount `mount` now, or undefined. `free` (encounter
 * setup) skips the turn and movement checks; `speed` is the rider's
 * effective speed and `canAct` whether it can take actions.
 */
export function mountRefusal(
    state: Grid,
    riderId: string,
    mountId: string,
    opts: { free?: boolean; currentId?: string; speed: number; canAct: boolean }
): string | undefined {
    if (riderId === mountId) return `a token cannot mount itself (riderId and mountId are both '${riderId}')`;
    const rider = state.participants.find(p => p.id === riderId);
    const mount = state.participants.find(p => p.id === mountId);
    if (!rider) return `rider ${riderId} is not in this encounter`;
    if (!mount) return `mount ${mountId} is not in this encounter`;
    if (rider.mountedOn) return `${rider.name} is already mounted (on ${state.participants.find(p => p.id === rider.mountedOn)?.name ?? rider.mountedOn}): dismount first`;
    if (rider.riderId) return `${rider.name} is already ridden (by ${state.participants.find(p => p.id === rider.riderId)?.name ?? rider.riderId}): a mount cannot ride`;
    if (mount.riderId) return `${mount.name} is already ridden (by ${state.participants.find(p => p.id === mount.riderId)?.name ?? mount.riderId})`;
    if (mount.mountedOn) return `${mount.name} is already mounted on ${state.participants.find(p => p.id === mount.mountedOn)?.name ?? mount.mountedOn}: a rider cannot carry a rider`;
    if (rider.unit || mount.unit) return `${rider.unit ? rider.name : mount.name} is a unit: units do not mount (a cavalry unit is one token)`;
    if (sizeRank(mount.size) <= sizeRank(rider.size)) return `${mount.name} (${mount.size ?? 'medium'}) must be at least one size larger than ${rider.name} (${rider.size ?? 'medium'}) to carry it (5e)`;
    if (mount.hp <= 0) return `${mount.name} is at 0 HP`;
    if (rider.hp <= 0) return `${rider.name} is at 0 HP`;
    if (!opts.canAct) return `${rider.name} cannot act (incapacitated, stunned or the like)`;
    if (rider.position && mount.position && edgeDistanceSquares(rider, mount) > 1) return `${rider.name} must be within 5 ft of ${mount.name} to mount it (${edgeDistanceSquares(rider, mount) * 5} ft apart)`;
    if (rider.conditions.some(c => String(c.type).toLowerCase() === 'prone')) return `${rider.name} is prone: stand up first (remove_condition prone; standing costs half its speed)`;
    if (mount.conditions.some(c => String(c.type).toLowerCase() === 'prone')) return `${mount.name} is prone: it must stand before it can be ridden`;
    if (opts.free) return undefined;
    if (opts.currentId !== rider.id) return `mounting is movement on ${rider.name}'s own turn (it is ${state.participants.find(p => p.id === opts.currentId)?.name ?? opts.currentId ?? 'nobody'}'s turn). At encounter setup pass free: true`;
    const need = halfSpeed(opts.speed);
    if (opts.speed <= 0) return `${rider.name}'s speed is 0: it cannot spend movement to mount`;
    const left = rider.movementRemaining ?? opts.speed;
    if (left < need) return `mounting costs half ${rider.name}'s speed: needs ${need} ft, ${left} left`;
    return undefined;
}

const key = (c: Pos) => `${c.x},${c.y}`;

/** Every cell another token fills, skipping `who` and its linked partner (and any ids in `skip`). */
function occupiedCells(state: Grid, who: CombatParticipant, skip: string[] = []): Set<string> {
    const out = new Set<string>(state.terrain?.obstacles ?? []);
    const ignore = new Set([who.id, ...skip]);
    for (const p of state.participants) {
        if (ignore.has(p.id)) continue;
        for (const c of footprintCells(p)) out.add(key(c));
    }
    return out;
}

/** True when `who`'s footprint at `at` is clear of terrain, other tokens (but its partner when allowed) and the grid edge. */
export function cellFree(state: Grid, who: CombatParticipant, at: Pos, skip: string[] = []): boolean {
    const occupied = occupiedCells(state, who, skip);
    // Review: a fight created in this process carries no bounds until it is
    // reloaded, when the store hands back the default board (0..100). Use the
    // same board here, so a rider never lands off it (y = -1) and a fall lands
    // on the same square whether or not the engine was reloaded in between.
    const b = state.gridBounds ?? DEFAULT_GRID_BOUNDS;
    return footprintCells(who, at).every(c => !occupied.has(key(c)) && !(b && (c.x < b.minX || c.x > b.maxX || c.y < b.minY || c.y > b.maxY)));
}

/**
 * The free square nearest to `prefer` (default: who's own position) from
 * which `who`'s footprint is within 5 ft of `around`'s footprint and off it.
 * Rings out to `maxRing` squares when nothing touches (a crowded fall).
 * Undefined when nothing is free.
 */
export function freeCellNear(state: Grid, who: CombatParticipant, around: CombatParticipant, opts: { prefer?: Pos; maxRing?: number } = {}): Pos | undefined {
    if (!around.position) return undefined;
    const prefer = opts.prefer ?? who.position ?? around.position;
    const maxRing = opts.maxRing ?? 3;
    const span = Math.max(1, Math.round(Math.sqrt(footprintCells(around).length)));
    const whoSpan = Math.max(1, Math.round(Math.sqrt(footprintCells(who, around.position).length)));
    for (let ring = 1; ring <= maxRing; ring++) {
        const candidates: Pos[] = [];
        for (let y = around.position.y - ring - whoSpan; y <= around.position.y + span + ring; y++) {
            for (let x = around.position.x - ring - whoSpan; x <= around.position.x + span + ring; x++) {
                const at = { x, y };
                const d = edgeDistanceSquares(who, around, { a: at });
                if (d !== ring) continue;
                if (!cellFree(state, who, at)) continue;
                candidates.push(at);
            }
        }
        if (candidates.length) {
            const dist = (c: Pos) => Math.max(Math.abs(c.x - prefer.x), Math.abs(c.y - prefer.y));
            candidates.sort((a, b) => dist(a) - dist(b) || a.y - b.y || a.x - b.x);
            return candidates[0];
        }
    }
    return undefined;
}

/** The square of the mount's footprint nearest to `from` (where a rider is struck from, 5e: the rider fills the mount's space). */
export function nearestMountCell(mount: CombatParticipant, from: Pos, at?: Pos): Pos | undefined {
    const cells = footprintCells(mount, at);
    if (!cells.length) return undefined;
    const dist = (c: Pos) => Math.max(Math.abs(c.x - from.x), Math.abs(c.y - from.y));
    return [...cells].sort((a, b) => dist(a) - dist(b) || a.y - b.y || a.x - b.x)[0];
}

/** The actions a controlled mount may take (5e: Dash, Disengage, Dodge; moving is not an action). */
export const CONTROLLED_MOUNT_ACTIONS = ['dash', 'disengage', 'dodge', 'move'] as const;

/**
 * Why a controlled mount may not take this action, or undefined. A reaction
 * (an opportunity attack) is not an action and stays allowed.
 */
export function controlledMountActionRefusal(state: Grid, actorId: string, action: string, opts: { reaction?: boolean } = {}): string | undefined {
    const p = state.participants.find(x => x.id === actorId);
    if (!p || !isControlledMount(state, p)) return undefined;
    const a = action.toLowerCase();
    if ((CONTROLLED_MOUNT_ACTIONS as readonly string[]).includes(a)) return undefined;
    if (a === 'attack' && opts.reaction) return undefined;
    const rider = state.participants.find(x => x.id === p.controlledBy);
    return `${p.name} is a controlled mount (ridden by ${rider?.name ?? p.controlledBy}): it may only Dash, Disengage or Dodge (5e), so ${a} is refused. Nothing was spent. Let it act on its own (combat_manage mount {…, controlled: false}) or dismount first`;
}

/** Conditions that fail a DEX save outright (5e): the rider simply falls. */
export const AUTO_FAIL_DEX = ['paralyzed', 'petrified', 'stunned', 'unconscious'];

export function autoFailsDex(p: Pick<CombatParticipant, 'conditions' | 'hp'>): string | undefined {
    if (p.hp <= 0) return 'at 0 HP';
    const c = p.conditions.find(x => AUTO_FAIL_DEX.includes(String(x.type).toLowerCase()));
    return c ? String(c.type).toLowerCase() : undefined;
}
