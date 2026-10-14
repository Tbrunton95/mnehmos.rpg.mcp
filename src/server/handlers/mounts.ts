/**
 * Play report 7 #10: combat_manage mount / dismount, and what keeps a rider
 * and its mount honest as the fight goes on.
 *
 * - mount {riderId, mountId, controlled?, free?}: links the pair and puts the
 *   rider on the mount's square. Mid-fight it is movement on the rider's
 *   turn and costs half its speed (5e); `free` is for setting the scene.
 * - dismount {riderId, position?, free?}: half the rider's speed, then a free
 *   square within 5 ft of the mount (the one named, or the nearest).
 * - settleMounts: run after any combat_manage / combat_action write. A mount
 *   gone, at 0 HP or knocked prone drops its rider prone (5e: the rider's
 *   reaction could land it on its feet, which the GM applies); a rider at 0
 *   HP falls; a rider knocked prone rolls the DC 10 DEX save on the fight's
 *   dice — fail: dismounted, prone in a free square within 5 ft; success:
 *   it keeps the saddle and is not prone.
 * - afterForcedMove: a pushed mount carries its rider, who saves the same
 *   way; a pushed rider is shoved off the mount.
 */
import { z } from 'zod';
import type { CombatEngine, CombatParticipant } from '../../engine/combat/engine.js';
import { ConditionType, DurationType } from '../../engine/combat/conditions.js';
import { edgeDistanceSquares, footprintCells } from '../../schema/encounter.js';
import { mountRefusal, link, unlink, halfSpeed, mountOf, riderOf, freeCellNear, cellFree, autoFailsDex } from '../../engine/combat/mounts.js';
import { rollParticipantSave, saveSidesNote } from '../../engine/combat/saves.js';
import type { ForcedMoveResult } from '../../engine/combat/forced-move.js';
import { getDb } from '../../storage/index.js';
import { EncounterRepository } from '../../storage/repos/encounter.repo.js';
import { getDomainServices } from '../domain-services.js';
import type { SessionContext } from '../types.js';
import { getOrLoadEngine, buildStateJson } from './combat-handlers.js';

const positionSchema = () => z.object({ x: z.number(), y: z.number() });

export const MountSchema = z.object({
    action: z.literal('mount'),
    encounterId: z.string(),
    riderId: z.string().describe('The token that climbs on'),
    mountId: z.string().describe('The creature it rides: at least one size larger, within 5 ft'),
    controlled: z.boolean().optional().describe('true (default): the rider controls it — it moves on the rider\'s turn with its own speed, its own slot passes, and it may only Dash, Disengage or Dodge. false: an independent mount keeps its turn and moves itself, carrying the rider'),
    free: z.boolean().optional().describe('Setting the scene (the rider starts mounted): no movement spent and any turn. Mid-fight mounting costs half the rider\'s speed on its own turn'),
    reason: z.string().optional().describe('Why — logged')
});

export const DismountSchema = z.object({
    action: z.literal('dismount'),
    encounterId: z.string(),
    riderId: z.string().describe('The mounted token'),
    position: positionSchema().optional().describe('A free square within 5 ft of the mount (default: the nearest free one)'),
    free: z.boolean().optional().describe('No movement spent and any turn (a GM correction)'),
    reason: z.string().optional().describe('Why — logged')
});

/** One thing that happened to a rider and its mount, as the reply carries it. */
export interface MountEvent {
    riderId: string;
    rider: string;
    mountId: string;
    mount?: string;
    cause: string;
    /** The rider left the mount (thrown, fell, shoved off, or the mount went down). */
    fell: boolean;
    prone?: boolean;
    at?: { x: number; y: number };
    /** Play report 7 (lane G1): rolls (two when a declared source or a condition put it at advantage or disadvantage) and what did. */
    save?: {
        ability: 'dexterity'; dc: 10; natural?: number; rolls?: number[]; modifier?: number; total?: number; saved: boolean; autoFail?: string;
        advantageSources?: string[]; disadvantageSources?: string[]; conditionalAdvantage?: string[]; conditionalDisadvantage?: string[];
    };
    note?: string;
    /**
     * Review (lane G1): a tagged save:dex mechanic the stay-mounted save did
     * not fire, as on every engine save; a list of strings on the row, which
     * output_mode 'summary' keeps (it drops the nested save).
     */
    conditional?: string[];
    line: string;
}

function log(encounterId: string, engine: CombatEngine, actionType: string, targetId: string, summary: string, reason?: string): void {
    const state = engine.getState();
    if (!state) return;
    getDomainServices().combatActionLog.log({
        encounterId, round: state.round, turnIndex: state.currentTurnIndex,
        actorId: 'GM', actorName: 'GM', actionType,
        targetIds: [targetId], resultSummary: summary, resultDetail: reason
    });
}

function save(encounterId: string, engine: CombatEngine): void {
    const state = engine.getState();
    if (state) new EncounterRepository(getDb()).saveState(encounterId, state);
}

const isProne = (p: CombatParticipant) => p.conditions.some(c => String(c.type).toLowerCase() === ConditionType.PRONE);

function knockProne(engine: CombatEngine, p: CombatParticipant, source: string): void {
    if (isProne(p)) return;
    engine.applyCondition(p.id, { type: ConditionType.PRONE, durationType: DurationType.PERMANENT, sourceId: source });
}

/** Put a dismounted rider down: off the mount's squares (nearest free one within 5 ft), prone when it fell. */
function landRider(engine: CombatEngine, rider: CombatParticipant, mount: CombatParticipant | undefined, opts: { prone: boolean; prefer?: { x: number; y: number }; source: string }): { x: number; y: number } | undefined {
    const state = engine.getState()!;
    unlink(rider, mount);
    if (mount?.position && rider.position) {
        const onMount = footprintCells(rider).some(c => footprintCells(mount).some(m => m.x === c.x && m.y === c.y));
        if (onMount || !cellFree(state, rider, rider.position)) {
            const spot = freeCellNear(state, rider, mount, { prefer: opts.prefer ?? rider.position });
            if (spot) rider.position = spot;
        }
    } else if (rider.position && !cellFree(state, rider, rider.position)) {
        const spot = freeCellNear(state, rider, rider, { prefer: rider.position });
        if (spot) rider.position = spot;
    }
    if (opts.prone) knockProne(engine, rider, opts.source);
    return rider.position ? { x: rider.position.x, y: rider.position.y } : undefined;
}

/** The rider's DC 10 DEX save to stay mounted (5e), on the fight's dice; the unconscious, stunned, paralysed and petrified fail outright. */
function stayMountedSave(engine: CombatEngine, rider: CombatParticipant): NonNullable<MountEvent['save']> {
    const auto = autoFailsDex(rider);
    if (auto) return { ability: 'dexterity', dc: 10, saved: false, autoFail: auto };
    let db;
    try { db = getDb(); } catch { db = undefined; }
    // Play report 7 (lane G1): the rider's declared save:dex sides and conditions fire here as on any engine save.
    const r = rollParticipantSave(engine, db, rider, 'dex', 10, { purpose: 'stay mounted (DC 10 DEX)' });
    return {
        ability: 'dexterity', dc: 10, natural: r.natural, rolls: r.rolls, modifier: r.modifier, total: r.total, saved: r.saved,
        ...(r.advantageSources ? { advantageSources: r.advantageSources } : {}),
        ...(r.disadvantageSources ? { disadvantageSources: r.disadvantageSources } : {}),
        ...(r.conditionalAdvantage ? { conditionalAdvantage: r.conditionalAdvantage } : {}),
        ...(r.conditionalDisadvantage ? { conditionalDisadvantage: r.conditionalDisadvantage } : {})
    };
}

const saveText = (s: NonNullable<MountEvent['save']>) => s.autoFail
    ? `DEX save fails outright (${s.autoFail})`
    : `DEX save d20=${s.natural}${(s.modifier ?? 0) >= 0 ? '+' : ''}${s.modifier} = ${s.total} vs DC 10 — ${s.saved ? 'stays mounted' : 'fails'}${saveSidesNote({ rolls: s.rolls ?? [s.natural ?? 0], advantageSources: s.advantageSources, disadvantageSources: s.disadvantageSources })}`;

/** The rider was moved or knocked down while mounted: roll the save, and land it on a failure. */
function riderSaves(engine: CombatEngine, rider: CombatParticipant, mount: CombatParticipant, cause: string, opts: { clearProneOnSuccess: boolean }): MountEvent {
    const s = stayMountedSave(engine, rider);
    // Review (lane G1): a tagged mechanic the save did not fire is named, as on every engine save's line.
    const conditional = [...(s.conditionalAdvantage ?? []), ...(s.conditionalDisadvantage ?? [])];
    const hints = conditional.map(c => `\n   conditional: ${c}`).join('');
    const extra = conditional.length ? { conditional } : {};
    if (s.saved) {
        if (opts.clearProneOnSuccess) rider.conditions = rider.conditions.filter(c => String(c.type).toLowerCase() !== ConditionType.PRONE);
        if (mount.position) rider.position = { x: mount.position.x, y: mount.position.y };
        return { riderId: rider.id, rider: rider.name, mountId: mount.id, mount: mount.name, cause, fell: false, save: s, ...extra, line: `🐎 ${rider.name} keeps the saddle on ${mount.name} (${cause}): ${saveText(s)}${opts.clearProneOnSuccess ? '; not prone' : ''}${hints}` };
    }
    const at = landRider(engine, rider, mount, { prone: true, source: `fell from ${mount.name}` });
    return { riderId: rider.id, rider: rider.name, mountId: mount.id, mount: mount.name, cause, fell: true, prone: true, ...(at ? { at } : {}), save: s, ...extra, line: `🐎 ${rider.name} falls from ${mount.name} (${cause}): ${saveText(s)} — prone${at ? ` at (${at.x}, ${at.y})` : ''}${hints}` };
}

/**
 * Reconcile every rider and mount after a write (see the module note).
 * Returns what happened; the caller saves the state when anything did.
 */
export function settleMounts(engine: CombatEngine): MountEvent[] {
    const state = engine.getState();
    if (!state) return [];
    const events: MountEvent[] = [];
    for (const rider of state.participants) {
        if (!rider.mountedOn) continue;
        const mount = mountOf(state, rider);
        const reactionNote = !rider.reactionUsed && engine.canTakeReactions(rider.id) && rider.hp > 0
            ? `5e: ${rider.name} may spend its reaction to dismount as it falls and land on its feet (combat_manage remove_condition {participantId: '${rider.id}', name: 'prone'})`
            : undefined;
        if (!mount) {
            // The mount left the fight (removed, fled, despawned): the rider drops where it sat.
            const gone = rider.mountedOn;
            const at = landRider(engine, rider, undefined, { prone: true, source: `fell: mount ${gone} left` });
            events.push({ riderId: rider.id, rider: rider.name, mountId: gone, cause: 'its mount left the fight', fell: true, prone: true, ...(at ? { at } : {}), ...(reactionNote ? { note: reactionNote } : {}), line: `🐎 ${rider.name}'s mount (${gone}) left the fight: ${rider.name} is dismounted, prone${at ? ` at (${at.x}, ${at.y})` : ''}.${reactionNote ? ` ${reactionNote}` : ''}` });
            continue;
        }
        if (mount.riderId !== rider.id) {
            unlink(rider);
            events.push({ riderId: rider.id, rider: rider.name, mountId: mount.id, mount: mount.name, cause: 'the link was broken', fell: true, prone: false, line: `🐎 ${rider.name} is no longer on ${mount.name} (the link was broken)` });
            continue;
        }
        if (mount.hp <= 0 || isProne(mount)) {
            const cause = mount.hp <= 0 ? `${mount.name} drops (0 HP)` : `${mount.name} is knocked prone`;
            const at = landRider(engine, rider, mount, { prone: true, source: `fell from ${mount.name}` });
            events.push({ riderId: rider.id, rider: rider.name, mountId: mount.id, mount: mount.name, cause, fell: true, prone: true, ...(at ? { at } : {}), ...(reactionNote ? { note: reactionNote } : {}), line: `🐎 ${rider.name} is thrown as ${cause}: dismounted, prone${at ? ` at (${at.x}, ${at.y})` : ''}.${reactionNote ? ` ${reactionNote}` : ''}` });
            continue;
        }
        if (rider.hp <= 0) {
            const at = landRider(engine, rider, mount, { prone: true, source: `fell from ${mount.name}` });
            events.push({ riderId: rider.id, rider: rider.name, mountId: mount.id, mount: mount.name, cause: `${rider.name} drops (0 HP)`, fell: true, prone: true, ...(at ? { at } : {}), line: `🐎 ${rider.name} drops from ${mount.name} (0 HP): prone${at ? ` at (${at.x}, ${at.y})` : ''}` });
            continue;
        }
        if (isProne(rider)) {
            events.push(riderSaves(engine, rider, mount, `${rider.name} knocked prone while mounted`, { clearProneOnSuccess: true }));
            continue;
        }
        // The rider sits on the mount's anchor square.
        if (mount.position && (!rider.position || rider.position.x !== mount.position.x || rider.position.y !== mount.position.y)) {
            rider.position = { x: mount.position.x, y: mount.position.y };
        }
    }
    // A mount whose rider is gone, or no longer on it, is just a creature again.
    for (const mount of state.participants) {
        if (!mount.riderId) continue;
        const rider = riderOf(state, mount);
        if (!rider || rider.mountedOn !== mount.id) {
            const gone = mount.riderId;
            unlink(undefined, mount);
            if (!rider) events.push({ riderId: gone, rider: gone, mountId: mount.id, mount: mount.name, cause: 'its rider left the fight', fell: true, line: `🐎 ${mount.name} has no rider now (${gone} left the fight)` });
        }
    }
    return events;
}

/**
 * The hook combat_manage and combat_action run after a write: settle the
 * pair, save when anything changed, and hand back the events and lines.
 * Never throws (a missing engine settles nothing).
 */
export function settleMountsAfter(ctx: SessionContext, encounterId: string | undefined): { events: MountEvent[]; lines: string[]; participants?: unknown[] } {
    if (!encounterId) return { events: [], lines: [] };
    try {
        const engine = getOrLoadEngine(ctx, encounterId);
        const state = engine?.getState();
        if (!engine || !state || !state.participants.some(p => p.mountedOn || p.riderId)) return { events: [], lines: [] };
        const events = settleMounts(engine);
        if (!events.length) return { events, lines: [] };
        save(encounterId, engine);
        for (const e of events) log(encounterId, engine, 'mount_fall', e.riderId, e.line);
        // Review: the reply was built before the settle, so its participants
        // still showed the rider mounted on its old square. Hand back the rows
        // as they stand now; the hooks swap them in.
        let participants: unknown[] | undefined;
        try { participants = (buildStateJson(engine.getState()!, encounterId) as { participants?: unknown[] }).participants; } catch { participants = undefined; }
        return { events, lines: events.map(e => e.line), ...(participants ? { participants } : {}) };
    } catch {
        return { events: [], lines: [] };
    }
}

/**
 * Review: fold a settle into a parsed reply: the events, the lines (on the
 * rawText the banner prints, else the message), and the participants as they
 * stand after it, so the reply never shows a rider still mounted next to the
 * line that threw it.
 */
export function foldSettleIntoReply(parsed: Record<string, unknown>, settled: ReturnType<typeof settleMountsAfter>): void {
    if (!settled.events.length) return;
    parsed.mounts = [...(Array.isArray(parsed.mounts) ? parsed.mounts : []), ...settled.events];
    const lines = settled.lines.join('\n');
    if (typeof parsed.rawText === 'string' && parsed.rawText) parsed.rawText = `${parsed.rawText}\n${lines}`;
    else parsed.message = parsed.message ? `${String(parsed.message)}\n${lines}` : lines;
    // Only a reply that carries the state's rows (not some other list named participants).
    const stateRows = Array.isArray(parsed.participants) && parsed.participants.every(r => !!r && typeof r === 'object' && 'isCurrentTurn' in (r as object));
    if (stateRows && settled.participants) parsed.participants = settled.participants;
}

/**
 * Forced movement touched a rider or a mount (a shove). A pushed mount
 * carries its rider, who rolls the DC 10 DEX save (5e); a pushed rider is
 * shoved off its mount and lands on a free square. The caller saves.
 */
export function afterForcedMove(engine: CombatEngine, moved: CombatParticipant, fm: ForcedMoveResult): MountEvent[] {
    const state = engine.getState();
    if (!state || fm.feet <= 0) return [];
    if (moved.riderId) {
        const rider = riderOf(state, moved);
        if (!rider || rider.mountedOn !== moved.id) return [];
        if (moved.position) rider.position = { x: moved.position.x, y: moved.position.y };
        return [riderSaves(engine, rider, moved, `${moved.name} moved against its will (forced movement)`, { clearProneOnSuccess: false })];
    }
    if (moved.mountedOn) {
        const mount = mountOf(state, moved);
        const at = landRider(engine, moved, mount, { prone: false, prefer: fm.to, source: 'shoved off' });
        return [{ riderId: moved.id, rider: moved.name, mountId: moved.mountedOn ?? mount?.id ?? '', mount: mount?.name, cause: 'shoved off the mount', fell: true, prone: false, ...(at ? { at } : {}), line: `🐎 ${moved.name} is shoved off ${mount?.name ?? 'its mount'}${at ? ` to (${at.x}, ${at.y})` : ''}` }];
    }
    return [];
}

export async function handleMount(params: z.infer<typeof MountSchema>, ctx: SessionContext) {
    const refuse = (message: string) => ({ error: true, actionType: 'mount', message: `${message}. Nothing was written.`, writes: 'none' });
    const engine = getOrLoadEngine(ctx, params.encounterId);
    const state = engine?.getState();
    if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
    const rider = state.participants.find(p => p.id === params.riderId);
    const speed = rider ? engine.effectiveSpeed(rider) : 0;
    const refusal = mountRefusal(state, params.riderId, params.mountId, {
        free: params.free, currentId: state.turnOrder[state.currentTurnIndex], speed, canAct: rider ? engine.canTakeActions(rider.id) : false
    });
    if (refusal) return refuse(refusal);
    const mount = state.participants.find(p => p.id === params.mountId)!;
    const controlled = params.controlled !== false;
    const spent = params.free ? 0 : halfSpeed(speed);
    if (spent) rider!.movementRemaining = (rider!.movementRemaining ?? speed) - spent;
    // Review: mounting mid-fight is the rider's movement this turn, so the PC
    // turn guard (play report 7 #6) must not read the turn as untouched. A free
    // mount is the GM setting the scene, not the rider acting.
    if (spent) engine.markActed(rider!.id);
    link(rider!, mount, controlled);
    // Play report 7 #6: mounting on its own turn is the rider acting (the PC turn guard reads it); a free set-up is not.
    if (!params.free) engine.markActed(rider!.id);
    save(params.encounterId, engine);
    const how = controlled
        ? `controlled: it moves on ${rider!.name}'s turn with its own speed (move {actorId: '${rider!.id}'}), its own slot passes, and it may only Dash, Disengage or Dodge`
        : `independent: it keeps its own turn and moves itself (move {actorId: '${mount.id}'}), carrying ${rider!.name}`;
    const summary = `🐎 ${rider!.name} mounts ${mount.name} (${how})${spent ? ` — ${spent} ft of movement (half its speed), ${rider!.movementRemaining} left` : ' — free (scene set-up): no movement spent'}`;
    log(params.encounterId, engine, 'mount', rider!.id, summary, params.reason);
    return {
        success: true, actionType: 'mount', encounterId: params.encounterId,
        mounted: { riderId: rider!.id, mountId: mount.id, controlled },
        movementSpent: spent, riderMovementRemaining: rider!.movementRemaining ?? speed,
        position: rider!.position ?? null,
        message: summary
    };
}

export async function handleDismount(params: z.infer<typeof DismountSchema>, ctx: SessionContext) {
    const refuse = (message: string) => ({ error: true, actionType: 'dismount', message: `${message}. Nothing was written.`, writes: 'none' });
    const engine = getOrLoadEngine(ctx, params.encounterId);
    const state = engine?.getState();
    if (!engine || !state) return refuse(`Encounter ${params.encounterId} not found (memory or DB)`);
    const rider = state.participants.find(p => p.id === params.riderId);
    if (!rider) return refuse(`rider ${params.riderId} is not in this encounter`);
    if (!rider.mountedOn) return refuse(`${rider.name} is not mounted`);
    const mountId = rider.mountedOn;
    const mount = mountOf(state, rider);
    const speed = engine.effectiveSpeed(rider);
    const need = params.free ? 0 : halfSpeed(speed);
    if (!params.free) {
        const current = state.turnOrder[state.currentTurnIndex];
        if (current !== rider.id) return refuse(`dismounting is movement on ${rider.name}'s own turn (it is ${state.participants.find(p => p.id === current)?.name ?? current}'s turn); a GM correction passes free: true`);
        if (speed <= 0) return refuse(`${rider.name}'s speed is 0: it cannot spend movement to dismount`);
        const left = rider.movementRemaining ?? speed;
        if (left < need) return refuse(`dismounting costs half ${rider.name}'s speed: needs ${need} ft, ${left} left`);
    }
    let at: { x: number; y: number } | undefined;
    if (mount?.position) {
        if (params.position) {
            const d = edgeDistanceSquares(rider, mount, { a: params.position });
            if (d < 1) return refuse(`(${params.position.x}, ${params.position.y}) is on ${mount.name}'s own squares: name a square beside it`);
            if (d > 1) return refuse(`(${params.position.x}, ${params.position.y}) is ${d * 5} ft from ${mount.name}: a dismount lands within 5 ft of the mount`);
            if (!cellFree(state, rider, params.position)) return refuse(`(${params.position.x}, ${params.position.y}) is not free (terrain, another creature or the grid edge)`);
            at = { x: params.position.x, y: params.position.y };
        } else {
            at = freeCellNear(state, rider, mount, { maxRing: 1 });
            if (!at) return refuse(`no free square within 5 ft of ${mount.name}: name one with position, or clear a space`);
        }
    } else if (params.position) {
        at = { x: params.position.x, y: params.position.y };
    }
    if (need) rider.movementRemaining = (rider.movementRemaining ?? speed) - need;
    // Review: a dismount mid-fight is the rider's movement this turn (PC turn guard).
    if (need) engine.markActed(rider.id);
    unlink(rider, mount);
    if (at) rider.position = at;
    // Play report 7 #6: dismounting on its own turn is the rider acting; a free correction is not.
    if (!params.free) engine.markActed(rider.id);
    save(params.encounterId, engine);
    const summary = `🐎 ${rider.name} dismounts ${mount?.name ?? mountId}${at ? ` to (${at.x}, ${at.y})` : ''}${need ? ` — ${need} ft of movement (half its speed), ${rider.movementRemaining} left` : ' — free: no movement spent'}`;
    log(params.encounterId, engine, 'dismount', rider.id, summary, params.reason);
    return {
        success: true, actionType: 'dismount', encounterId: params.encounterId,
        dismounted: { riderId: rider.id, mountId },
        position: at ?? rider.position ?? null, movementSpent: need, riderMovementRemaining: rider.movementRemaining ?? speed,
        message: summary
    };
}
