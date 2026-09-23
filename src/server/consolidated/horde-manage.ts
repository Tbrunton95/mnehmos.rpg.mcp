/**
 * FINDINGS #93: HORDE_MANAGE — mass entities + noise, the survival-horror
 * pair. A horde is not N creatures: it is ONE object with size, position,
 * drift, and an attraction score that noise feeds. Noise belongs to a PLACE,
 * decays on the in-fiction clock, and is what attraction reads.
 * resolve_press answers "how many reach the wall this turn" with the formula
 * printed; spending those bodies (spawned combatants, wall damage) is
 * Register B — the GM's, always.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { matchAction, isGuidingError } from '../../utils/fuzzy-enum.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { SessionContext } from '../types.js';

const ACTIONS = ['create', 'get', 'list', 'set', 'add_noise', 'list_noise', 'tick', 'resolve_press', 'destroy'] as const;
type HordeAction = typeof ACTIONS[number];
const ALIASES: Record<string, HordeAction> = {
    'new': 'create', 'spawn': 'create', 'hordes': 'list', 'update': 'set',
    'noise': 'add_noise', 'sound': 'add_noise', 'gunshot': 'add_noise',
    'move_tick': 'tick', 'advance': 'tick', 'drift': 'tick',
    'press': 'resolve_press', 'assault': 'resolve_press', 'wall': 'resolve_press',
    'disperse': 'destroy'
};

const HordeInputSchema = z.object({
    action: z.string().describe('Action: create, get, list, set, add_noise, list_noise, tick, resolve_press, destroy'),
    worldId: z.string().describe('REQUIRED — hordes and noise are world-scoped'),
    hordeId: z.string().optional(),
    name: z.string().optional(),
    size: z.number().int().min(0).optional().describe('bodies in the mass'),
    x: z.number().optional(), y: z.number().optional(),
    speed: z.number().min(0).optional().describe('tiles per hour of drift (default 0.5)'),
    attraction: z.number().min(0).optional().describe('set: override the attraction score'),
    intensity: z.number().min(1).optional().describe('add_noise: 1 = footstep on gravel · 10 = generator · 25 = gunshot · 50 = explosion/alarm'),
    decayHours: z.number().positive().optional().describe('add_noise: in-fiction hours before the noise is forgotten (default: intensity/5)'),
    hours: z.number().positive().optional().describe('tick: in-fiction hours to advance drift and decay noise'),
    reach: z.number().positive().optional().describe('resolve_press: distance at which the horde is AT the wall (default 2)'),
    pressFraction: z.number().min(0).max(1).optional().describe('resolve_press: fraction of the mass that commits per press (default 0.1)'),
    losses: z.number().int().min(0).optional().describe('resolve_press: bodies the defense already destroyed — subtracted from size, counts from the store'),
    sessionId: z.string().optional()
});

function hdb() {
    const db = getDb(process.env.NODE_ENV === 'test' ? ':memory:' : process.env.RPG_DATA_DIR ? `${process.env.RPG_DATA_DIR}/rpg.db` : 'rpg.db');
    db.exec(`CREATE TABLE IF NOT EXISTS hordes (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL, name TEXT NOT NULL,
        size INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
        speed REAL NOT NULL DEFAULT 0.5, attraction REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS noise_events (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
        intensity REAL NOT NULL, remaining_hours REAL NOT NULL, created_at TEXT NOT NULL)`);
    return db;
}
type HRow = { id: string; world_id: string; name: string; size: number; x: number; y: number; speed: number; attraction: number };
type NRow = { id: string; x: number; y: number; intensity: number; remaining_hours: number };

async function route(args: unknown): Promise<Record<string, unknown>> {
    const input = HordeInputSchema.parse(args);
    const matched = matchAction(input.action, ACTIONS, ALIASES);
    if (isGuidingError(matched)) return { error: true, message: matched.message };
    const db = hdb();
    const now = new Date().toISOString();
    const w = input.worldId;
    const find = (id?: string): HRow | null => id ? ((db.prepare('SELECT * FROM hordes WHERE id = ? AND world_id = ?').get(id, w) as HRow | undefined) ?? null) : null;

    switch (matched.matched) {
        case 'create': {
            if (!input.name || input.size === undefined || input.x === undefined || input.y === undefined) return { error: true, message: 'create requires name, size, x, y' };
            const id = `horde-${randomUUID().slice(0, 8)}`;
            db.prepare('INSERT INTO hordes (id, world_id, name, size, x, y, speed, attraction, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
                .run(id, w, input.name, input.size, input.x, input.y, input.speed ?? 0.5, input.attraction ?? 0, now);
            return { success: true, actionType: 'create', hordeId: id, name: input.name, size: input.size, position: { x: input.x, y: input.y }, message: `Horde "${input.name}" — ${input.size} bodies at (${input.x}, ${input.y})` };
        }
        case 'get': case 'list': {
            const rows = (matched.matched === 'get' ? [find(input.hordeId)].filter(Boolean) : db.prepare('SELECT * FROM hordes WHERE world_id = ? ORDER BY size DESC').all(w)) as HRow[];
            if (matched.matched === 'get' && !rows.length) return { error: true, message: `No horde ${input.hordeId} in this world` };
            return { success: true, actionType: matched.matched, count: rows.length, hordes: rows.map(h => ({ hordeId: h.id, name: h.name, size: h.size, position: { x: h.x, y: h.y }, speed: h.speed, attraction: Math.round(h.attraction * 10) / 10 })), message: `${rows.length} horde(s)` };
        }
        case 'set': {
            const h = find(input.hordeId);
            if (!h) return { error: true, message: `No horde ${input.hordeId} in this world` };
            db.prepare('UPDATE hordes SET size = COALESCE(?, size), x = COALESCE(?, x), y = COALESCE(?, y), speed = COALESCE(?, speed), attraction = COALESCE(?, attraction), updated_at = ? WHERE id = ?')
                .run(input.size ?? null, input.x ?? null, input.y ?? null, input.speed ?? null, input.attraction ?? null, now, h.id);
            const after = find(h.id) as HRow;
            return { success: true, actionType: 'set', hordeId: h.id, name: h.name, size: after.size, position: { x: after.x, y: after.y }, attraction: after.attraction, message: `${h.name} updated — ${after.size} bodies at (${after.x}, ${after.y})` };
        }
        case 'add_noise': {
            if (input.x === undefined || input.y === undefined || input.intensity === undefined) return { error: true, message: 'add_noise requires x, y, intensity (1 footstep · 10 generator · 25 gunshot · 50 alarm)' };
            const id = `noise-${randomUUID().slice(0, 8)}`;
            const decay = input.decayHours ?? Math.max(0.5, input.intensity / 5);
            db.prepare('INSERT INTO noise_events (id, world_id, x, y, intensity, remaining_hours, created_at) VALUES (?,?,?,?,?,?,?)')
                .run(id, w, input.x, input.y, input.intensity, decay, now);
            return { success: true, actionType: 'add_noise', noiseId: id, position: { x: input.x, y: input.y }, intensity: input.intensity, remainingHours: decay, message: `Noise ${input.intensity} at (${input.x}, ${input.y}) — the world remembers it for ${decay}h. Every tick, every horde hears it.` };
        }
        case 'list_noise': {
            const rows = db.prepare('SELECT * FROM noise_events WHERE world_id = ? ORDER BY intensity DESC').all(w) as NRow[];
            return { success: true, actionType: 'list_noise', count: rows.length, noise: rows.map(n => ({ noiseId: n.id, position: { x: n.x, y: n.y }, intensity: n.intensity, remainingHours: Math.round(n.remaining_hours * 100) / 100 })), message: `${rows.length} active noise event(s)` };
        }
        case 'tick': {
            if (!input.hours) return { error: true, message: 'tick requires hours (in-fiction time to advance)' };
            const noise = db.prepare('SELECT * FROM noise_events WHERE world_id = ?').all(w) as NRow[];
            const hordes = db.prepare('SELECT * FROM hordes WHERE world_id = ?').all(w) as HRow[];
            const moves: Array<Record<string, unknown>> = [];
            for (const h of hordes) {
                // Strongest pull: intensity / (1 + distance). Silence = attraction decays.
                let best: { n: NRow; pull: number } | null = null;
                for (const n of noise) {
                    const d = Math.hypot(n.x - h.x, n.y - h.y);
                    const pull = n.intensity / (1 + d);
                    if (!best || pull > best.pull) best = { n, pull };
                }
                let nx = h.x, ny = h.y, toward: string | null = null;
                let attraction = Math.max(0, h.attraction - 5 * input.hours);
                if (best && best.pull >= 1) {
                    attraction = Math.min(100, attraction + best.pull * input.hours);
                    const d = Math.hypot(best.n.x - h.x, best.n.y - h.y);
                    if (d > 0.1) {
                        const step = Math.min(d, h.speed * input.hours * (1 + attraction / 100));
                        nx = h.x + ((best.n.x - h.x) / d) * step;
                        ny = h.y + ((best.n.y - h.y) / d) * step;
                    }
                    toward = `noise ${best.n.id} at (${best.n.x}, ${best.n.y}), pull ${Math.round(best.pull * 10) / 10}`;
                }
                db.prepare('UPDATE hordes SET x = ?, y = ?, attraction = ?, updated_at = ? WHERE id = ?').run(nx, ny, attraction, now, h.id);
                moves.push({ hordeId: h.id, name: h.name, from: { x: h.x, y: h.y }, to: { x: Math.round(nx * 100) / 100, y: Math.round(ny * 100) / 100 }, toward, attraction: Math.round(attraction * 10) / 10 });
            }
            db.prepare('UPDATE noise_events SET remaining_hours = remaining_hours - ? WHERE world_id = ?').run(input.hours, w);
            const expired = db.prepare('DELETE FROM noise_events WHERE world_id = ? AND remaining_hours <= 0').run(w).changes;
            return { success: true, actionType: 'tick', hours: input.hours, hordes: moves, noiseExpired: expired, formula: 'pull = intensity/(1+dist); attraction +pull/h toward loudest, −5/h in silence; drift = speed × hours × (1 + attraction/100)', message: `${moves.length} horde(s) drifted over ${input.hours}h; ${expired} noise event(s) faded.` };
        }
        case 'resolve_press': {
            const h = find(input.hordeId);
            if (!h) return { error: true, message: `No horde ${input.hordeId} in this world` };
            if (input.losses !== undefined) {
                const newSize = Math.max(0, h.size - input.losses);
                db.prepare('UPDATE hordes SET size = ?, updated_at = ? WHERE id = ?').run(newSize, now, h.id);
                return { success: true, actionType: 'resolve_press', hordeId: h.id, name: h.name, losses: input.losses, sizeBefore: h.size, sizeAfter: newSize, ...(newSize === 0 ? { destroyed: true, note: 'The horde is spent — destroy to remove the row, or leave it as stragglers.' } : {}), message: `${h.name}: −${input.losses} bodies, ${newSize} remain.` };
            }
            if (input.x === undefined || input.y === undefined) return { error: true, message: 'resolve_press requires x, y (the wall/gate being pressed) — or losses to book casualties' };
            const dist = Math.hypot(input.x - h.x, input.y - h.y);
            const reach = input.reach ?? 2;
            if (dist > reach) return { success: true, actionType: 'resolve_press', hordeId: h.id, name: h.name, distance: Math.round(dist * 100) / 100, reach, reached: 0, message: `${h.name} is ${Math.round(dist * 10) / 10} out (reach ${reach}) — nothing reaches the wall this turn. It is still coming.` };
            const frac = input.pressFraction ?? 0.1;
            const reached = Math.ceil(h.size * frac * Math.min(1, Math.max(0.2, h.attraction / 100)));
            return {
                success: true, actionType: 'resolve_press', hordeId: h.id, name: h.name,
                distance: Math.round(dist * 100) / 100, reached,
                formula: `ceil(size ${h.size} × pressFraction ${frac} × clamp(attraction ${Math.round(h.attraction)}/100, 0.2..1))`,
                resolution: 'REGISTER B: spend these bodies as the fiction dictates — spawn the closest N as combatants, damage the barrier via hull/siege damage, or narrate the surge. Book kills back with resolve_press {losses:N}.',
                message: `${h.name} PRESSES: ${reached} bodies reach the wall this turn.`
            };
        }
        case 'destroy': {
            const h = find(input.hordeId);
            if (!h) return { error: true, message: `No horde ${input.hordeId} in this world` };
            db.prepare('DELETE FROM hordes WHERE id = ?').run(h.id);
            return { success: true, actionType: 'destroy', hordeId: h.id, name: h.name, finalSize: h.size, message: `${h.name} dispersed/destroyed (${h.size} bodies at the end).` };
        }
    }
    return { error: true, message: 'unhandled' };
}

export async function handleHordeManage(args: unknown, _ctx: SessionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        const result = await route(args);
        let output = result.error ? RichFormatter.error(String(result.message)) : RichFormatter.header(`Horde — ${String(result.actionType)}`, '🧟') + (result.message ? RichFormatter.alert(String(result.message), 'info') : '');
        output += RichFormatter.embedJson(result, 'HORDE_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: RichFormatter.error(msg) + RichFormatter.embedJson({ error: true, message: msg }, 'HORDE_MANAGE') }] };
    }
}

export const HordeManageTool = {
    name: 'horde_manage',
    description: `FINDINGS #93: mass entities + noise — the survival-horror pair. A horde is ONE object (size, position, drift, attraction), not N combatants; noise belongs to a PLACE and decays on the in-fiction clock.

Actions: create, get, list, set, add_noise, list_noise, tick, resolve_press, destroy
- add_noise: 1 footstep · 10 generator · 25 gunshot · 50 alarm. The world remembers for decayHours; every tick, every horde hears it.
- tick {hours}: hordes drift toward the loudest pull (formula printed); silence decays attraction; noise fades.
- resolve_press {x, y}: "how many reach the wall this turn" — printed formula, Register B resolution (spawn the closest N, damage the barrier, narrate the surge). Book kills with {losses:N}.
worldId REQUIRED on every call.`,
    inputSchema: HordeInputSchema
};
