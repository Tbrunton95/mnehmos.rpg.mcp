/**
 * FINDINGS #99: VEHICLE_MANAGE — R2. Cars are the second-most-used object
 * in the crime genre and every campaign hand-ran them: a brake light held
 * in prose for four days was a lawful stop the engine never knew about.
 * A vehicle is a row: plate, registeredTo, defects[], knownTo[] (who can
 * identify it and why), status. Cavities are NOT duplicated here — they are
 * container_manage rows with ownerType:'vehicle', and get JOINs them in.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { SessionContext } from '../types.js';

const ACTIONS = ['create', 'get', 'list', 'update', 'add_defect', 'clear_defect', 'note_known', 'delete'] as const;

const VehicleInputSchema = z.object({
    action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
    worldId: z.string().describe('REQUIRED — vehicles are world-scoped'),
    vehicleId: z.string().optional(),
    name: z.string().optional().describe("create: display name ('the Transit', 'UAZ-469')"),
    make: z.string().optional().describe('create/update: make and model, free text'),
    plate: z.string().optional().describe("create/update: plate ('FL LDJ 4416'); a plate is an identity, treat changes as events"),
    registeredTo: z.string().optional().describe('create/update: registered owner — NOT necessarily the character driving it'),
    ownerCharacterId: z.string().optional().describe('create/update: who actually controls it (character id), if anyone'),
    status: z.enum(['active', 'impounded', 'destroyed', 'sold', 'stolen', 'abandoned']).optional(),
    defect: z.string().optional().describe("add_defect/clear_defect: 'brake light out, rear left' — each defect is a lawful reason to be stopped"),
    knownName: z.string().optional().describe("note_known: who can identify this vehicle ('Petrakis investigators')"),
    knownWhy: z.string().optional().describe("note_known: why ('saw it at the yard, Day 3')"),
    notes: z.string().optional(),
    expectName: z.string().optional().describe('update/delete guard: refuse unless the row name matches (case-insensitive)'),
    includeContainers: z.boolean().optional().describe('get: JOIN in cavities/boot (container rows owned by this vehicle). Default true'),
    sessionId: z.string().optional()
});

type VehicleRow = {
    id: string; world_id: string; name: string; make: string | null; plate: string | null;
    registered_to: string | null; owner_character_id: string | null; status: string;
    defects: string; known_to: string; notes: string | null; created_at: string; updated_at: string;
};

function vdb() {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS vehicles (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL, name TEXT NOT NULL,
        make TEXT, plate TEXT, registered_to TEXT, owner_character_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        defects TEXT NOT NULL DEFAULT '[]', known_to TEXT NOT NULL DEFAULT '[]',
        notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    return db;
}

function renderRow(r: VehicleRow, containers?: Array<{ id: string; name: string; hidden: number; locked: number }>) {
    let defects: string[] = []; let knownTo: Array<{ name: string; why?: string }> = [];
    try { defects = JSON.parse(r.defects || '[]'); } catch { /* reported empty */ }
    try { knownTo = JSON.parse(r.known_to || '[]'); } catch { /* reported empty */ }
    return {
        vehicleId: r.id, name: r.name, make: r.make, plate: r.plate,
        registeredTo: r.registered_to, ownerCharacterId: r.owner_character_id,
        status: r.status, defects, knownTo, notes: r.notes,
        ...(containers ? { containers: containers.map(c => ({ containerId: c.id, name: c.name, hidden: !!c.hidden, locked: !!c.locked })) } : {})
    };
}

async function route(args: unknown): Promise<Record<string, unknown>> {
    const input = VehicleInputSchema.parse(args);
    const db = vdb();
    const now = new Date().toISOString();
    const find = (id?: string): VehicleRow | undefined => id
        ? db.prepare('SELECT * FROM vehicles WHERE id = ? AND world_id = ?').get(id, input.worldId) as VehicleRow | undefined
        : undefined;
    const guard = (r: VehicleRow): Record<string, unknown> | null =>
        input.expectName && r.name.toLowerCase() !== input.expectName.toLowerCase()
            ? { error: true, message: `Guard refused: row is "${r.name}", not "${input.expectName}" — nothing written` }
            : null;

    switch (input.action) {
        case 'create': case 'new': case 'register': {
            if (!input.name) return { error: true, message: 'create needs name' };
            const id = randomUUID();
            db.prepare(`INSERT INTO vehicles (id, world_id, name, make, plate, registered_to, owner_character_id, status, defects, known_to, notes, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?)`)
                .run(id, input.worldId, input.name, input.make ?? null, input.plate ?? null, input.registeredTo ?? null, input.ownerCharacterId ?? null, input.status ?? 'active', input.notes ?? null, now, now);
            return {
                success: true, actionType: 'create', vehicleId: id, name: input.name, plate: input.plate ?? null,
                cavityLane: `hidden cavity / boot: container_manage create {worldId, name:'…', ownerType:'vehicle', ownerId:'${id}', hidden:true, locked:true}`,
                message: `${input.name} registered${input.plate ? ` — plate ${input.plate}` : ''}${input.registeredTo ? `, registered to ${input.registeredTo}` : ''}`
            };
        }
        case 'get': case 'inspect': {
            const r = find(input.vehicleId);
            if (!r) return { error: true, message: `No vehicle ${input.vehicleId} in this world` };
            let containers: Array<{ id: string; name: string; hidden: number; locked: number }> | undefined;
            if (input.includeContainers !== false) {
                try {
                    containers = db.prepare("SELECT id, name, hidden, locked FROM containers WHERE owner_type = 'vehicle' AND owner_id = ?").all(r.id) as typeof containers;
                } catch { /* containers table absent — no cavities to show */ }
            }
            return { success: true, actionType: 'get', ...renderRow(r, containers) };
        }
        case 'list': {
            const rows = db.prepare('SELECT * FROM vehicles WHERE world_id = ? ORDER BY created_at').all(input.worldId) as VehicleRow[];
            return { success: true, actionType: 'list', count: rows.length, vehicles: rows.map(r => renderRow(r)) };
        }
        case 'update': {
            const r = find(input.vehicleId);
            if (!r) return { error: true, message: `No vehicle ${input.vehicleId} in this world` };
            const g = guard(r); if (g) return g;
            db.prepare(`UPDATE vehicles SET name = COALESCE(?, name), make = COALESCE(?, make), plate = COALESCE(?, plate),
                        registered_to = COALESCE(?, registered_to), owner_character_id = COALESCE(?, owner_character_id),
                        status = COALESCE(?, status), notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`)
                .run(input.name ?? null, input.make ?? null, input.plate ?? null, input.registeredTo ?? null, input.ownerCharacterId ?? null, input.status ?? null, input.notes ?? null, now, r.id);
            const after = find(r.id)!;
            return { success: true, actionType: 'update', was: { name: r.name, plate: r.plate, status: r.status }, now: renderRow(after), message: `${after.name} updated` };
        }
        case 'add_defect': {
            const r = find(input.vehicleId);
            if (!r) return { error: true, message: `No vehicle ${input.vehicleId} in this world` };
            if (!input.defect) return { error: true, message: 'add_defect needs defect' };
            let defects: string[] = []; try { defects = JSON.parse(r.defects || '[]'); } catch { defects = []; }
            if (!defects.includes(input.defect)) defects.push(input.defect);
            db.prepare('UPDATE vehicles SET defects = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(defects), now, r.id);
            return { success: true, actionType: 'add_defect', vehicleId: r.id, defects, message: `${r.name}: '${input.defect}' — a lawful reason to be stopped, on the record now` };
        }
        case 'clear_defect': {
            const r = find(input.vehicleId);
            if (!r) return { error: true, message: `No vehicle ${input.vehicleId} in this world` };
            if (!input.defect) return { error: true, message: 'clear_defect needs defect (exact text)' };
            let defects: string[] = []; try { defects = JSON.parse(r.defects || '[]'); } catch { defects = []; }
            const before = defects.length;
            defects = defects.filter(d => d !== input.defect);
            if (defects.length === before) return { error: true, message: `'${input.defect}' is not on ${r.name} — defects: [${defects.join(' | ') || 'none'}]` };
            db.prepare('UPDATE vehicles SET defects = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(defects), now, r.id);
            return { success: true, actionType: 'clear_defect', vehicleId: r.id, defects, message: `${r.name}: '${input.defect}' fixed` };
        }
        case 'note_known': {
            const r = find(input.vehicleId);
            if (!r) return { error: true, message: `No vehicle ${input.vehicleId} in this world` };
            if (!input.knownName) return { error: true, message: 'note_known needs knownName' };
            let knownTo: Array<{ name: string; why?: string }> = []; try { knownTo = JSON.parse(r.known_to || '[]'); } catch { knownTo = []; }
            knownTo.push({ name: input.knownName, ...(input.knownWhy ? { why: input.knownWhy } : {}) });
            db.prepare('UPDATE vehicles SET known_to = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(knownTo), now, r.id);
            return { success: true, actionType: 'note_known', vehicleId: r.id, knownTo, message: `${r.name} is known to ${input.knownName}${input.knownWhy ? ` (${input.knownWhy})` : ''} — ${knownTo.length} observer(s) can now identify it` };
        }
        case 'delete': case 'scrap': {
            const r = find(input.vehicleId);
            if (!r) return { error: true, message: `No vehicle ${input.vehicleId} in this world` };
            const g = guard(r); if (g) return g;
            let cavities = 0;
            try { cavities = (db.prepare("SELECT COUNT(*) AS n FROM containers WHERE owner_type = 'vehicle' AND owner_id = ?").get(r.id) as { n: number }).n; } catch { /* no containers table */ }
            if (cavities > 0) return { error: true, message: `${r.name} still owns ${cavities} container(s) — empty and destroy/move them first (container_manage), then delete the vehicle. Nothing deleted.` };
            db.prepare('DELETE FROM vehicles WHERE id = ?').run(r.id);
            return { success: true, actionType: 'delete', vehicleId: r.id, message: `${r.name} removed from the world` };
        }
    }
    return { error: true, message: `Unknown action '${input.action}' — create, get, list, update, add_defect, clear_defect, note_known, delete` };
}

export async function handleVehicleManage(args: unknown, _ctx: SessionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        const result = await route(args);
        let output = result.error ? RichFormatter.error(String(result.message)) : RichFormatter.header(`Vehicle — ${String(result.actionType)}`, '🚗') + (result.message ? RichFormatter.alert(String(result.message), 'info') : '');
        output += RichFormatter.embedJson(result, 'VEHICLE_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: RichFormatter.error(msg) + RichFormatter.embedJson({ error: true, message: msg }, 'VEHICLE_MANAGE') }] };
    }
}

export const VehicleManageTool = {
    name: 'vehicle_manage',
    description: `FINDINGS #99 (R2): vehicles as rows — plate, registeredTo, defects[], knownTo[], status. The brake light that was a lawful stop for four days of prose is properties on a row now.

Actions: create, get, list, update, add_defect, clear_defect, note_known, delete
- defects[] — each entry is a lawful reason to be stopped; add/clear as the fiction moves.
- knownTo[] — who can identify this vehicle and why; feed it every time someone clocks the plate.
- Cavities/boot are container_manage rows with ownerType:'vehicle' — create returns the exact call; get JOINs them in.
- expectName guards update/delete. delete refuses while containers are attached.
worldId REQUIRED on every call.`,
    inputSchema: VehicleInputSchema,
    // Every action shares the one input schema; the switch dispatcher validates per action.
    actionSchemas: Object.fromEntries(ACTIONS.map(a => [a, { schema: VehicleInputSchema, aliases: [] as string[] }]))
};
