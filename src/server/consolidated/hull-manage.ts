/**
 * FINDINGS #92: HULL_MANAGE — the KEEPER campaign's one BUILD (spec §9).
 * Sections ride the spatial room graph by JOIN, never by widening it: a
 * hull_sections row is keyed to a room_nodes id, so spatial serves PSAR
 * untouched and delete_room never learns hull exists. All actions REQUIRE
 * worldId (KEEPER db discipline §13). Register B is preserved throughout:
 * vent reports occupants and their traits — the GM names who lives and
 * executes deaths via character_manage kill; the engine never judges
 * sealed biology. Power is sum-vs-budget with loud overdraw (spec Q4).
 */
import { z } from 'zod';
import { matchAction, isGuidingError } from '../../utils/fuzzy-enum.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { SessionContext } from '../types.js';

const ACTIONS = ['get_state', 'set_section', 'allocate_power', 'vent', 'seal', 'damage', 'repair', 'process_life_support'] as const;
type HullAction = typeof ACTIONS[number];
const ALIASES: Record<string, HullAction> = {
    'state': 'get_state', 'status': 'get_state', 'sections': 'get_state',
    'section': 'set_section', 'update_section': 'set_section',
    'power': 'allocate_power', 'budget': 'allocate_power',
    'vent_section': 'vent', 'decompress': 'vent',
    'unseal': 'seal', 'bulkhead': 'seal',
    'breach': 'damage', 'hull_damage': 'damage',
    'patch': 'repair', 'fix': 'repair',
    'life_support': 'process_life_support', 'lifesupport': 'process_life_support'
};

const HullInputSchema = z.object({
    action: z.string().describe('Action: get_state, set_section, allocate_power, vent, seal, damage, repair, process_life_support'),
    worldId: z.string().describe('REQUIRED on every action — hull state is world-scoped (§13 discipline)'),
    roomId: z.string().optional().describe('room_nodes id — the section'),
    pressure: z.number().min(0).max(100).optional().describe('set_section: 0 = vacuum'),
    atmosphere: z.enum(['breathable', 'thin', 'toxic', 'vacuum']).optional(),
    hullIntegrity: z.number().min(0).max(100).optional(),
    power: z.enum(['on', 'off', 'emergency']).optional().describe('set_section: powers doors, lights, containment — off carries the §8.2 containment penalty'),
    temperature: z.number().optional().describe('set_section: feeds stage clocks — cold slows, heat accelerates'),
    powerDraw: z.number().min(0).optional().describe('set_section: this section\'s draw against station generation'),
    sealed: z.boolean().optional().describe('seal: bulkhead state — a sealed section takes no adjacency damage from a vent'),
    generation: z.number().min(0).optional().describe('allocate_power: set station generation (omit to just read the budget)'),
    amount: z.number().positive().optional().describe('damage/repair: integrity delta'),
    elapsedHours: z.number().positive().optional().describe('process_life_support: hours since last processing'),
    lifeSupportRepair: z.number().positive().optional().describe('process_life_support: points restored (consumes parts in fiction — the acquisition loop pays for this)'),
    sessionId: z.string().optional()
});
type HullInput = z.infer<typeof HullInputSchema>;
// Exported so noUnusedLocals holds while the alias stays available to
// future handlers that take typed slices of the input.
export type { HullInput };

function hullDb() {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS hull_sections (
        room_id TEXT PRIMARY KEY, world_id TEXT NOT NULL,
        pressure INTEGER NOT NULL DEFAULT 100, atmosphere TEXT NOT NULL DEFAULT 'breathable',
        hull_integrity INTEGER NOT NULL DEFAULT 100, power TEXT NOT NULL DEFAULT 'on',
        temperature REAL NOT NULL DEFAULT 20, power_draw REAL NOT NULL DEFAULT 1,
        sealed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS hull_station (
        world_id TEXT PRIMARY KEY, generation REAL NOT NULL DEFAULT 10,
        life_support REAL NOT NULL DEFAULT 100, decay_per_hour REAL NOT NULL DEFAULT 0.2,
        updated_at TEXT NOT NULL)`);
    return db;
}
type SectionRow = { room_id: string; world_id: string; pressure: number; atmosphere: string; hull_integrity: number; power: string; temperature: number; power_draw: number; sealed: number; updated_at: string };

function roomName(db: ReturnType<typeof hullDb>, roomId: string): string {
    const r = db.prepare('SELECT name FROM room_nodes WHERE id = ?').get(roomId) as { name: string } | undefined;
    return r?.name ?? '(room not in spatial graph)';
}
function requireSection(db: ReturnType<typeof hullDb>, worldId: string, roomId: string): SectionRow | null {
    return (db.prepare('SELECT * FROM hull_sections WHERE room_id = ? AND world_id = ?').get(roomId, worldId) as SectionRow | undefined) ?? null;
}
function ensureStation(db: ReturnType<typeof hullDb>, worldId: string): void {
    db.prepare('INSERT OR IGNORE INTO hull_station (world_id, updated_at) VALUES (?, ?)').run(worldId, new Date().toISOString());
}
function budget(db: ReturnType<typeof hullDb>, worldId: string) {
    ensureStation(db, worldId);
    const station = db.prepare('SELECT * FROM hull_station WHERE world_id = ?').get(worldId) as { generation: number; life_support: number; decay_per_hour: number };
    const draws = db.prepare(`SELECT room_id, power, power_draw FROM hull_sections WHERE world_id = ? AND power != 'off'`).all(worldId) as Array<{ room_id: string; power: string; power_draw: number }>;
    const totalDraw = draws.reduce((n, d) => n + (d.power === 'emergency' ? d.power_draw * 0.5 : d.power_draw), 0);
    return { station, totalDraw, margin: station.generation - totalDraw, overdrawn: totalDraw > station.generation };
}

async function route(args: unknown, _ctx: SessionContext): Promise<Record<string, unknown>> {
    const input = HullInputSchema.parse(args);
    const matched = matchAction(input.action, ACTIONS, ALIASES);
    if (isGuidingError(matched)) return { error: true, message: matched.message };
    const db = hullDb();
    const now = new Date().toISOString();
    const w = input.worldId;

    switch (matched.matched) {
        case 'get_state': {
            const b = budget(db, w);
            const rows = (input.roomId
                ? [requireSection(db, w, input.roomId)].filter(Boolean)
                : db.prepare('SELECT * FROM hull_sections WHERE world_id = ? ORDER BY room_id').all(w)) as SectionRow[];
            return {
                success: true, actionType: 'get_state', worldId: w,
                station: { generation: b.station.generation, lifeSupport: b.station.life_support, decayPerHour: b.station.decay_per_hour, totalDraw: b.totalDraw, margin: b.margin, overdrawn: b.overdrawn },
                sectionCount: rows.length,
                sections: rows.map(s => ({ roomId: s.room_id, room: roomName(db, s.room_id), pressure: s.pressure, atmosphere: s.atmosphere, hullIntegrity: s.hull_integrity, power: s.power, temperature: s.temperature, powerDraw: s.power_draw, sealed: s.sealed === 1 })),
                ...(b.overdrawn ? { powerWarning: `⚠ OVERDRAWN: draw ${b.totalDraw} vs generation ${b.station.generation} — cut sections or raise generation; the §8.2 containment penalty applies to whatever you cut` } : {}),
                message: `${rows.length} section(s) · life support ${b.station.life_support} · power margin ${b.margin}`
            };
        }
        case 'set_section': {
            if (!input.roomId) return { error: true, message: 'set_section requires roomId' };
            const room = db.prepare('SELECT id FROM room_nodes WHERE id = ?').get(input.roomId);
            if (!room) return { error: true, message: `Room ${input.roomId} is not in the spatial graph — build it with spatial_manage generate first. Hull rides rooms; it does not invent them.` };
            ensureStation(db, w);
            const before = requireSection(db, w, input.roomId);
            db.prepare(`INSERT INTO hull_sections (room_id, world_id, pressure, atmosphere, hull_integrity, power, temperature, power_draw, sealed, updated_at)
                VALUES (@r, @w, COALESCE(@p, 100), COALESCE(@a, 'breathable'), COALESCE(@h, 100), COALESCE(@pw, 'on'), COALESCE(@t, 20), COALESCE(@d, 1), COALESCE(@s, 0), @u)
                ON CONFLICT(room_id) DO UPDATE SET
                    pressure = COALESCE(@p, pressure), atmosphere = COALESCE(@a, atmosphere),
                    hull_integrity = COALESCE(@h, hull_integrity), power = COALESCE(@pw, power),
                    temperature = COALESCE(@t, temperature), power_draw = COALESCE(@d, power_draw),
                    sealed = COALESCE(@s, sealed), updated_at = @u`)
                .run({ r: input.roomId, w, p: input.pressure ?? null, a: input.atmosphere ?? null, h: input.hullIntegrity ?? null, pw: input.power ?? null, t: input.temperature ?? null, d: input.powerDraw ?? null, s: input.sealed === undefined ? null : (input.sealed ? 1 : 0), u: now });
            const after = requireSection(db, w, input.roomId) as SectionRow;
            return {
                success: true, actionType: 'set_section', worldId: w, roomId: input.roomId, room: roomName(db, input.roomId),
                created: before === null,
                section: { pressure: after.pressure, atmosphere: after.atmosphere, hullIntegrity: after.hull_integrity, power: after.power, temperature: after.temperature, powerDraw: after.power_draw, sealed: after.sealed === 1 },
                ...(input.power === 'off' ? { containmentNote: 'Power OFF: the §8.2 containment penalty now applies to every specimen caged in this section — visible input, hidden number.' } : {}),
                message: `${roomName(db, input.roomId)}: ${before === null ? 'section created' : 'section updated'}`
            };
        }
        case 'allocate_power': {
            ensureStation(db, w);
            if (input.generation !== undefined) db.prepare('UPDATE hull_station SET generation = ?, updated_at = ? WHERE world_id = ?').run(input.generation, now, w);
            const b = budget(db, w);
            const perSection = db.prepare('SELECT room_id, power, power_draw FROM hull_sections WHERE world_id = ? ORDER BY power_draw DESC').all(w) as Array<{ room_id: string; power: string; power_draw: number }>;
            return {
                success: true, actionType: 'allocate_power', worldId: w,
                generation: b.station.generation, totalDraw: b.totalDraw, margin: b.margin, overdrawn: b.overdrawn,
                sections: perSection.map(s => ({ roomId: s.room_id, room: roomName(db, s.room_id), power: s.power, draw: s.power_draw, effectiveDraw: s.power === 'off' ? 0 : s.power === 'emergency' ? s.power_draw * 0.5 : s.power_draw })),
                message: b.overdrawn
                    ? `⚠ OVERDRAWN by ${Math.abs(b.margin)}: something must go dark. Cutting power is a set_section {power:'off'} decision with a containment penalty attached — the engine reports the ledger, the keeper chooses the wing.`
                    : `Budget holds: draw ${b.totalDraw} of ${b.station.generation} (margin ${b.margin}). Emergency power draws half and runs doors only.`
            };
        }
        case 'vent': {
            if (!input.roomId) return { error: true, message: 'vent requires roomId' };
            const sec = requireSection(db, w, input.roomId);
            if (!sec) return { error: true, message: `No hull section on room ${input.roomId} — set_section first. Venting a room the hull does not track is narration, not mechanics.` };
            db.prepare(`UPDATE hull_sections SET pressure = 0, atmosphere = 'vacuum', updated_at = ? WHERE room_id = ?`).run(now, input.roomId);
            // Adjacency damage: exits from the spatial graph; sealed sections shrug it.
            const damaged: Array<{ roomId: string; room: string; integrity: number }> = [];
            try {
                const exits = JSON.parse((db.prepare('SELECT exits FROM room_nodes WHERE id = ?').get(input.roomId) as { exits: string } | undefined)?.exits ?? '{}') as Record<string, string>;
                for (const adjId of Object.values(exits)) {
                    const adj = requireSection(db, w, adjId);
                    if (adj && adj.sealed !== 1) {
                        const ni = Math.max(0, adj.hull_integrity - 10);
                        db.prepare('UPDATE hull_sections SET hull_integrity = ?, updated_at = ? WHERE room_id = ?').run(ni, now, adjId);
                        damaged.push({ roomId: adjId, room: roomName(db, adjId), integrity: ni });
                    }
                }
            } catch { /* unreadable exits — no adjacency damage */ }
            const occupants = db.prepare('SELECT id, name FROM characters WHERE current_room_id = ?').all(input.roomId) as Array<{ id: string; name: string }>;
            const occupantReport = occupants.map(o => {
                let effects: string[] = [];
                try { effects = (db.prepare('SELECT name FROM custom_effects WHERE character_id = ?').all(o.id) as Array<{ name: string }>).map(e => e.name); } catch { /* no effects table */ }
                return { characterId: o.id, name: o.name, traits: effects };
            });
            return {
                success: true, actionType: 'vent', worldId: w, roomId: input.roomId, room: roomName(db, input.roomId),
                section: { pressure: 0, atmosphere: 'vacuum' },
                adjacentDamaged: damaged,
                occupants: occupantReport,
                resolution: 'REGISTER B: the engine does not judge sealed biology. Each occupant is listed with its trait ledger — the keeper knows which ones he built to survive this. Resolve deaths via character_manage kill {cause:"explosive decompression", createCorpse:true}; survivors get a condition. Unsealed stored samples in this section are destroyed per the cache ledger — write the note.',
                message: `${roomName(db, input.roomId)} VENTED — vacuum. ${occupantReport.length} occupant(s) listed for resolution, ${damaged.length} adjacent section(s) took hull damage.`
            };
        }
        case 'seal': {
            if (!input.roomId) return { error: true, message: 'seal requires roomId' };
            const sec = requireSection(db, w, input.roomId);
            if (!sec) return { error: true, message: `No hull section on room ${input.roomId} — set_section first.` };
            const to = input.sealed === undefined ? 1 : (input.sealed ? 1 : 0);
            db.prepare('UPDATE hull_sections SET sealed = ?, updated_at = ? WHERE room_id = ?').run(to, now, input.roomId);
            return { success: true, actionType: 'seal', worldId: w, roomId: input.roomId, room: roomName(db, input.roomId), sealed: to === 1, message: `${roomName(db, input.roomId)} ${to === 1 ? 'SEALED — bulkheads take no adjacency damage; nothing walks through a sealed door without opening it' : 'UNSEALED'}` };
        }
        case 'damage':
        case 'repair': {
            if (!input.roomId || input.amount === undefined) return { error: true, message: `${matched.matched} requires roomId and amount` };
            const sec = requireSection(db, w, input.roomId);
            if (!sec) return { error: true, message: `No hull section on room ${input.roomId} — set_section first.` };
            const delta = matched.matched === 'damage' ? -input.amount : input.amount;
            const ni = Math.max(0, Math.min(100, sec.hull_integrity + delta));
            const opened = ni === 0 && sec.hull_integrity > 0;
            db.prepare(`UPDATE hull_sections SET hull_integrity = ?, ${opened ? `pressure = 0, atmosphere = 'vacuum',` : ''} updated_at = ? WHERE room_id = ?`).run(ni, now, input.roomId);
            return {
                success: true, actionType: matched.matched, worldId: w, roomId: input.roomId, room: roomName(db, input.roomId),
                before: sec.hull_integrity, after: ni, ...(opened ? { openedToSpace: true } : {}),
                message: `${roomName(db, input.roomId)}: integrity ${sec.hull_integrity} → ${ni}${opened ? ' — SECTION OPEN TO SPACE (pressure 0, vacuum). Repair patches metal, not air: restore atmosphere with set_section once integrity holds.' : ''}`
            };
        }
        case 'process_life_support': {
            if (input.elapsedHours === undefined && input.lifeSupportRepair === undefined) return { error: true, message: 'process_life_support needs elapsedHours (decay) and/or lifeSupportRepair (restore)' };
            ensureStation(db, w);
            const st = db.prepare('SELECT * FROM hull_station WHERE world_id = ?').get(w) as { life_support: number; decay_per_hour: number };
            const breached = (db.prepare(`SELECT COUNT(*) AS n FROM hull_sections WHERE world_id = ? AND (pressure = 0 OR atmosphere = 'vacuum')`).get(w) as { n: number }).n;
            const decay = input.elapsedHours !== undefined ? input.elapsedHours * (st.decay_per_hour + breached * 0.1) : 0;
            const next = Math.max(0, Math.min(100, st.life_support - decay + (input.lifeSupportRepair ?? 0)));
            db.prepare('UPDATE hull_station SET life_support = ?, updated_at = ? WHERE world_id = ?').run(next, now, w);
            return {
                success: true, actionType: 'process_life_support', worldId: w,
                before: st.life_support, after: next,
                ...(input.elapsedHours !== undefined ? { decay: Math.round(decay * 100) / 100, formula: `${st.decay_per_hour}/h base + 0.1/h per breached section (${breached} breached) × ${input.elapsedHours}h` } : {}),
                ...(input.lifeSupportRepair !== undefined ? { repaired: input.lifeSupportRepair } : {}),
                ...(next === 0 ? { failed: true, failureNote: '⚠ LIFE SUPPORT FAILED — breathable sections begin degrading on the GM\'s clock: set_section atmosphere thin → toxic as the fiction dictates. The engine states the failure; the suffocation is Register B.' } : {}),
                message: `Life support ${st.life_support} → ${next}${next === 0 ? ' — FAILED' : next < 25 ? ' — critical, parts needed (the acquisition loop is the supply line)' : ''}`
            };
        }
    }
    return { error: true, message: `Unhandled action ${String(matched.matched)}` };
}

export async function handleHullManage(args: unknown, ctx: SessionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    return renderHull(args, ctx, 'Hull', '🛰️', 'HULL_MANAGE');
}

// FINDINGS #94: the alias answers IN ITS OWN VOICE — a compound GM should
// never see a space-station banner. Same route, different dress.
export async function handleSiegeManage(args: unknown, ctx: SessionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    return renderHull(args, ctx, 'Siege', '🧱', 'SIEGE_MANAGE');
}

async function renderHull(args: unknown, _ctx: SessionContext, label: string, icon: string, jsonTag: string): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        const result = await route(args, _ctx);
        let output = result.error
            ? RichFormatter.error(String(result.message))
            : RichFormatter.header(`${label} — ${String(result.actionType ?? 'result')}`, icon) + (result.message ? RichFormatter.alert(String(result.message), 'info') : '');
        output += RichFormatter.embedJson(result, jsonTag);
        return { content: [{ type: 'text', text: output }] };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: RichFormatter.error(msg) + RichFormatter.embedJson({ error: true, message: msg }, jsonTag) }] };
    }
}

export const HullManageTool = {
    name: 'hull_manage',
    description: `FINDINGS #92: station hull state — the KEEPER campaign's pressure/power/atmosphere layer, riding the spatial room graph by JOIN.

Actions: get_state, set_section, allocate_power, vent, seal, damage, repair, process_life_support
Aliases: state→get_state, power/budget→allocate_power, decompress→vent, patch→repair

🛰️ SECTIONS: each spatial room can carry hull state (pressure 0–100, atmosphere, integrity, power on/off/emergency, temperature, draw, sealed). set_section creates/updates; rooms must exist in spatial_manage first.
⚡ POWER: sum-vs-budget. allocate_power reports generation vs total draw and REFUSES nothing — cutting a wing is set_section {power:'off'}, a keeper decision with a containment penalty attached (§8.2). Emergency = half draw.
💨 VENT: sets vacuum, damages unsealed adjacent sections, and LISTS occupants with their trait ledgers — the engine never judges sealed biology; deaths resolve via character_manage kill (Register B).
🫁 LIFE SUPPORT: station pool, decays per hour + per breached section; repairs consume parts from the acquisition loop. At 0 the engine states the failure and the GM runs the suffocation.

worldId is REQUIRED on every call — hull state is world-scoped and PSAR has none.`,
    inputSchema: HullInputSchema,
    // Every action shares the one input schema; the switch dispatcher validates per action.
    actionSchemas: Object.fromEntries(ACTIONS.map(a => [a, { schema: HullInputSchema, aliases: [] as string[] }]))
};

// FINDINGS #93: SIEGE ALIAS — the same machinery, addressed in the genre's
// own vocabulary. hull_manage is a fortified-compound engine dressed as a
// space station: section=zone, pressure=breach-state (100 intact → 0 open),
// atmosphere=habitability, power=the generator budget, vent=deliberate
// sacrifice of a zone, life_support=the supply pool (food/water/meds),
// sealed=barricaded. One handler, two names — zero divergence possible.
export const SiegeManageTool = {
    name: 'siege_manage',
    description: `FINDINGS #93: fortified-compound engine — alias of hull_manage, same actions, same machinery, siege vocabulary.

Actions: get_state, set_section, allocate_power, vent, seal, damage, repair, process_life_support
READ IT AS: section = ZONE of the compound · pressure 100→0 = intact→BREACHED-OPEN · atmosphere = habitability (breathable=held, toxic=overrun-adjacent, vacuum=lost) · power = generator budget, off = dark zone (things move in dark zones) · vent = deliberately sacrificing a zone — occupants enumerated with their traits, deaths are the GM's via character_manage kill · seal = barricaded (no adjacency damage) · damage/repair = barrier integrity, 0 = OPEN · process_life_support = the supply pool: food, water, meds — decays per hour + per breached zone, repaired by consuming scavenged parts.
Zones ride spatial_manage rooms (one call each — a compound IS a room graph, no world map needed beyond a small grid). worldId REQUIRED — the multi-campaign db demands it (#91).`,
    inputSchema: HullInputSchema,
    // Every action shares the one input schema; the switch dispatcher validates per action.
    actionSchemas: Object.fromEntries(ACTIONS.map(a => [a, { schema: HullInputSchema, aliases: [] as string[] }]))
};
