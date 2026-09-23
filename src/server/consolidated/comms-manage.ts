/**
 * FINDINGS #99: COMMS_MANAGE — R4, the biggest hole in the crime genre.
 * "Attribution is the entire tension of a crime story" and the engine had
 * no primitive for who can reach whom. Now: handset rows, SIM rows, a
 * DIRECTIONAL contact graph, burn/swap/split, and reachable(A→B).
 *
 * MODEL: a SIM carries a number + contacts. A device carries memory
 * contacts and (optionally) one inserted SIM. A character KNOWS a number
 * if it appears in any of their active devices' memory or inserted-SIM
 * contacts. A character is LIVE at a number if they hold an active device
 * whose inserted active SIM carries that number (radios/PDAs may carry a
 * native number instead). reachable(A→B) = A knows a number B is live at.
 * Directionality is real: B knowing A back is a separate computation.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { SessionContext } from '../types.js';

const ACTIONS = ['create_device', 'create_sim', 'insert_sim', 'eject_sim', 'add_contact', 'copy_contacts', 'burn', 'transfer', 'get', 'reachable', 'list', 'delete'] as const;

const CommsInputSchema = z.object({
    action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
    worldId: z.string().describe('REQUIRED — comms are world-scoped'),
    deviceId: z.string().optional(),
    simId: z.string().optional(),
    kind: z.enum(['handset', 'burner', 'radio', 'pda', 'landline']).optional().describe("create_device: what it is. radios/pdas/landlines may carry a native number"),
    label: z.string().optional().describe("create_device/create_sim: display name ('Kenny's Nokia', 'the bin SIM')"),
    number: z.string().optional().describe('create_sim (required) / create_device (native number for radio/pda/landline)'),
    ownerCharacterId: z.string().optional().describe("create_device/transfer: who physically holds it. A device held by no one is ownerless (found, stashed, evidence)"),
    contactName: z.string().optional().describe('add_contact: the name as stored on THIS device/sim — what the holder calls them'),
    contactNumber: z.string().optional().describe('add_contact: the number stored'),
    target: z.enum(['device', 'sim']).optional().describe('add_contact/burn: which row the verb hits. Default: device if deviceId passed, sim if simId'),
    split: z.boolean().optional().describe("burn {simId, split:true}: the SIM is snapped and binned in pieces — status 'split', contacts unrecoverable through the tool"),
    fromCharacterId: z.string().optional().describe('reachable: A'),
    toCharacterId: z.string().optional().describe('reachable: B'),
    sessionId: z.string().optional()
});

type DeviceRow = {
    id: string; world_id: string; kind: string; label: string; number: string | null;
    owner_character_id: string | null; sim_id: string | null; memory_contacts: string;
    status: string; created_at: string; updated_at: string;
};
type SimRow = {
    id: string; world_id: string; number: string; label: string | null;
    contacts: string; status: string; created_at: string; updated_at: string;
};
type Contact = { name: string; number: string };

function cmdb() {
    const db = getDb(process.env.NODE_ENV === 'test' ? ':memory:' : process.env.RPG_DATA_DIR ? `${process.env.RPG_DATA_DIR}/rpg.db` : 'rpg.db');
    db.exec(`CREATE TABLE IF NOT EXISTS comm_devices (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL, kind TEXT NOT NULL,
        label TEXT NOT NULL, number TEXT, owner_character_id TEXT, sim_id TEXT,
        memory_contacts TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS comm_sims (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL, number TEXT NOT NULL,
        label TEXT, contacts TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    return db;
}

const parseContacts = (s: string): Contact[] => { try { return JSON.parse(s || '[]'); } catch { return []; } };

/** Everything a character can dial FROM (active devices) and the numbers they KNOW / are LIVE at. */
function commsPicture(db: ReturnType<typeof cmdb>, worldId: string, characterId: string) {
    const devices = db.prepare("SELECT * FROM comm_devices WHERE world_id = ? AND owner_character_id = ? AND status = 'active'").all(worldId, characterId) as DeviceRow[];
    const known = new Map<string, { name: string; via: string }>();
    const liveAt: Array<{ number: string; via: string }> = [];
    for (const d of devices) {
        for (const c of parseContacts(d.memory_contacts)) if (!known.has(c.number)) known.set(c.number, { name: c.name, via: `${d.label} (memory)` });
        let simNumber: string | null = null;
        if (d.sim_id) {
            const sim = db.prepare("SELECT * FROM comm_sims WHERE id = ? AND status = 'active'").get(d.sim_id) as SimRow | undefined;
            if (sim) {
                simNumber = sim.number;
                for (const c of parseContacts(sim.contacts)) if (!known.has(c.number)) known.set(c.number, { name: c.name, via: `${d.label} (SIM ${sim.label ?? sim.number})` });
            }
        }
        const live = simNumber ?? d.number;
        if (live) liveAt.push({ number: live, via: d.label });
    }
    return { devices, known, liveAt };
}

async function route(args: unknown): Promise<Record<string, unknown>> {
    const input = CommsInputSchema.parse(args);
    const db = cmdb();
    const now = new Date().toISOString();
    const findDevice = (id?: string): DeviceRow | undefined => id ? db.prepare('SELECT * FROM comm_devices WHERE id = ? AND world_id = ?').get(id, input.worldId) as DeviceRow | undefined : undefined;
    const findSim = (id?: string): SimRow | undefined => id ? db.prepare('SELECT * FROM comm_sims WHERE id = ? AND world_id = ?').get(id, input.worldId) as SimRow | undefined : undefined;

    switch (input.action) {
        case 'create_device': {
            if (!input.kind || !input.label) return { error: true, message: 'create_device needs kind + label' };
            const id = randomUUID();
            db.prepare(`INSERT INTO comm_devices (id, world_id, kind, label, number, owner_character_id, sim_id, memory_contacts, status, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, NULL, '[]', 'active', ?, ?)`)
                .run(id, input.worldId, input.kind, input.label, input.number ?? null, input.ownerCharacterId ?? null, now, now);
            return { success: true, actionType: 'create_device', deviceId: id, message: `${input.label} (${input.kind}) exists${input.ownerCharacterId ? ' — in hand' : ' — ownerless'}${input.number ? `, native number ${input.number}` : ', no number until a SIM goes in'}` };
        }
        case 'create_sim': {
            if (!input.number) return { error: true, message: 'create_sim needs number' };
            const id = randomUUID();
            db.prepare(`INSERT INTO comm_sims (id, world_id, number, label, contacts, status, created_at, updated_at)
                        VALUES (?, ?, ?, ?, '[]', 'active', ?, ?)`)
                .run(id, input.worldId, input.number, input.label ?? null, now, now);
            return { success: true, actionType: 'create_sim', simId: id, number: input.number, message: `SIM ${input.label ?? input.number} exists — loose until inserted` };
        }
        case 'insert_sim': {
            const d = findDevice(input.deviceId); const s = findSim(input.simId);
            if (!d) return { error: true, message: `No device ${input.deviceId}` };
            if (!s) return { error: true, message: `No SIM ${input.simId}` };
            if (s.status !== 'active') return { error: true, message: `SIM ${s.label ?? s.number} is ${s.status} — dead plastic goes in, no number comes up` };
            const holder = db.prepare('SELECT id, label FROM comm_devices WHERE sim_id = ? AND world_id = ?').get(s.id, input.worldId) as { id: string; label: string } | undefined;
            if (holder && holder.id !== d.id) db.prepare('UPDATE comm_devices SET sim_id = NULL, updated_at = ? WHERE id = ?').run(now, holder.id);
            const ejected = d.sim_id;
            db.prepare('UPDATE comm_devices SET sim_id = ?, updated_at = ? WHERE id = ?').run(s.id, now, d.id);
            return { success: true, actionType: 'insert_sim', deviceId: d.id, simId: s.id, nowLiveAt: s.number, ...(ejected ? { ejectedSimId: ejected } : {}), ...(holder && holder.id !== d.id ? { pulledFrom: holder.label } : {}), message: `${s.label ?? s.number} into ${d.label} — live at ${s.number}${ejected ? ' (prior SIM ejected, loose)' : ''}` };
        }
        case 'eject_sim': {
            const d = findDevice(input.deviceId);
            if (!d) return { error: true, message: `No device ${input.deviceId}` };
            if (!d.sim_id) return { error: true, message: `${d.label} has no SIM in it` };
            const simId = d.sim_id;
            db.prepare('UPDATE comm_devices SET sim_id = NULL, updated_at = ? WHERE id = ?').run(now, d.id);
            return { success: true, actionType: 'eject_sim', deviceId: d.id, simId, message: `SIM out of ${d.label} — the handset keeps its memory contacts, the number leaves with the card` };
        }
        case 'add_contact': {
            if (!input.contactName || !input.contactNumber) return { error: true, message: 'add_contact needs contactName + contactNumber' };
            const tgt = input.target ?? (input.deviceId ? 'device' : 'sim');
            if (tgt === 'device') {
                const d = findDevice(input.deviceId);
                if (!d) return { error: true, message: `No device ${input.deviceId}` };
                const contacts = parseContacts(d.memory_contacts);
                contacts.push({ name: input.contactName, number: input.contactNumber });
                db.prepare('UPDATE comm_devices SET memory_contacts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(contacts), now, d.id);
                return { success: true, actionType: 'add_contact', deviceId: d.id, count: contacts.length, message: `'${input.contactName}' → ${d.label} memory (${input.contactNumber})` };
            }
            const s = findSim(input.simId);
            if (!s) return { error: true, message: `No SIM ${input.simId}` };
            const contacts = parseContacts(s.contacts);
            contacts.push({ name: input.contactName, number: input.contactNumber });
            db.prepare('UPDATE comm_sims SET contacts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(contacts), now, s.id);
            return { success: true, actionType: 'add_contact', simId: s.id, count: contacts.length, message: `'${input.contactName}' → SIM ${s.label ?? s.number} (${input.contactNumber})` };
        }
        case 'copy_contacts': {
            const d = findDevice(input.deviceId); const s = findSim(input.simId);
            if (!d || !s) return { error: true, message: 'copy_contacts needs deviceId + simId (SIM → device memory)' };
            const simContacts = parseContacts(s.contacts);
            const mem = parseContacts(d.memory_contacts);
            const have = new Set(mem.map(c => c.number));
            let copied = 0;
            for (const c of simContacts) if (!have.has(c.number)) { mem.push(c); copied++; }
            db.prepare('UPDATE comm_devices SET memory_contacts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(mem), now, d.id);
            return { success: true, actionType: 'copy_contacts', copied, total: mem.length, message: `${copied} contact(s) copied SIM → ${d.label} memory. The numbers now SURVIVE the SIM — that was the point, and it cuts both ways when the phone is seized` };
        }
        case 'burn': {
            const tgt = input.target ?? (input.deviceId ? 'device' : 'sim');
            if (tgt === 'device') {
                const d = findDevice(input.deviceId);
                if (!d) return { error: true, message: `No device ${input.deviceId}` };
                db.prepare("UPDATE comm_devices SET status = 'burned', updated_at = ? WHERE id = ?").run(now, d.id);
                return { success: true, actionType: 'burn', deviceId: d.id, ...(d.sim_id ? { simStillInside: d.sim_id, note: 'the SIM is still physically in the burned device — a searcher finds it unless you eject first' } : {}), message: `${d.label} burned — dead to the graph` };
            }
            const s = findSim(input.simId);
            if (!s) return { error: true, message: `No SIM ${input.simId}` };
            const status = input.split ? 'split' : 'burned';
            db.prepare('UPDATE comm_sims SET status = ?, updated_at = ? WHERE id = ?').run(status, now, s.id);
            const holder = db.prepare('SELECT id, label FROM comm_devices WHERE sim_id = ?').get(s.id) as { id: string; label: string } | undefined;
            return { success: true, actionType: 'burn', simId: s.id, status, ...(holder ? { stillInsideDevice: holder.label } : {}), message: `SIM ${s.label ?? s.number} ${status === 'split' ? 'snapped and binned in pieces' : 'burned'} — ${s.number} is dead${holder ? ` (the dead card is still inside ${holder.label})` : ''}` };
        }
        case 'transfer': {
            const d = findDevice(input.deviceId);
            if (!d) return { error: true, message: `No device ${input.deviceId}` };
            const from = d.owner_character_id;
            db.prepare('UPDATE comm_devices SET owner_character_id = ?, updated_at = ? WHERE id = ?').run(input.ownerCharacterId ?? null, now, d.id);
            return { success: true, actionType: 'transfer', deviceId: d.id, from, to: input.ownerCharacterId ?? null, message: `${d.label}: ${from ?? 'nobody'} → ${input.ownerCharacterId ?? 'nobody'}. Whoever holds it holds every number in it` };
        }
        case 'get': case 'picture': {
            if (!input.ownerCharacterId) return { error: true, message: 'get needs ownerCharacterId — whose comms picture' };
            const p = commsPicture(db, input.worldId, input.ownerCharacterId);
            return {
                success: true, actionType: 'get', characterId: input.ownerCharacterId,
                devices: p.devices.map(d => ({ deviceId: d.id, kind: d.kind, label: d.label, simId: d.sim_id, memoryContacts: parseContacts(d.memory_contacts).length })),
                liveAt: p.liveAt,
                knowsNumbers: [...p.known.entries()].map(([number, v]) => ({ number, name: v.name, via: v.via })),
                message: `${p.devices.length} active device(s), live at ${p.liveAt.length} number(s), knows ${p.known.size} number(s)`
            };
        }
        case 'reachable': {
            if (!input.fromCharacterId || !input.toCharacterId) return { error: true, message: 'reachable needs fromCharacterId + toCharacterId' };
            const A = commsPicture(db, input.worldId, input.fromCharacterId);
            const B = commsPicture(db, input.worldId, input.toCharacterId);
            const paths = B.liveAt
                .filter(l => A.known.has(l.number))
                .map(l => ({ number: l.number, storedAs: A.known.get(l.number)!.name, aDialsVia: A.known.get(l.number)!.via, bAnswersOn: l.via }));
            const reverse = A.liveAt.filter(l => B.known.has(l.number)).length;
            return {
                success: true, actionType: 'reachable',
                from: input.fromCharacterId, to: input.toCharacterId,
                reachable: paths.length > 0, paths,
                reverseDirection: { reachable: reverse > 0, pathCount: reverse },
                message: paths.length
                    ? `REACHABLE — ${paths.length} path(s): ${paths.map(p => `dial ${p.number} ('${p.storedAs}') → rings ${p.bAnswersOn}`).join('; ')}. Reverse direction: ${reverse ? `also reachable (${reverse})` : 'NOT reachable — they cannot call back'}`
                    : `NOT REACHABLE — A knows ${A.known.size} number(s), B is live at ${B.liveAt.length}; no overlap. ${reverse ? `Reverse IS reachable (${reverse}) — the silence is one-directional` : 'Neither direction connects.'}`
            };
        }
        case 'list': {
            const devices = db.prepare('SELECT * FROM comm_devices WHERE world_id = ? ORDER BY created_at').all(input.worldId) as DeviceRow[];
            const sims = db.prepare('SELECT * FROM comm_sims WHERE world_id = ? ORDER BY created_at').all(input.worldId) as SimRow[];
            const inDevice = new Set(devices.filter(d => d.sim_id).map(d => d.sim_id));
            return {
                success: true, actionType: 'list',
                devices: devices.map(d => ({ deviceId: d.id, kind: d.kind, label: d.label, owner: d.owner_character_id, status: d.status, simId: d.sim_id })),
                sims: sims.map(s => ({ simId: s.id, number: s.number, label: s.label, status: s.status, loose: !inDevice.has(s.id) })),
                message: `${devices.length} device(s), ${sims.length} SIM(s) (${sims.filter(s => !inDevice.has(s.id)).length} loose)`
            };
        }
        case 'delete': {
            if (input.deviceId) {
                const d = findDevice(input.deviceId);
                if (!d) return { error: true, message: `No device ${input.deviceId}` };
                db.prepare('DELETE FROM comm_devices WHERE id = ?').run(d.id);
                return { success: true, actionType: 'delete', deviceId: d.id, message: `${d.label} removed from the world (physically destroyed/gone; burn is the softer verb)` };
            }
            if (input.simId) {
                const s = findSim(input.simId);
                if (!s) return { error: true, message: `No SIM ${input.simId}` };
                db.prepare('DELETE FROM comm_sims WHERE id = ?').run(s.id);
                return { success: true, actionType: 'delete', simId: s.id, message: `SIM ${s.label ?? s.number} removed from the world` };
            }
            return { error: true, message: 'delete needs deviceId or simId' };
        }
    }
    return { error: true, message: `Unknown action '${input.action}' — create_device, create_sim, insert_sim, eject_sim, add_contact, copy_contacts, burn, transfer, get, reachable, list, delete` };
}

export async function handleCommsManage(args: unknown, _ctx: SessionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        const result = await route(args);
        let output = result.error ? RichFormatter.error(String(result.message)) : RichFormatter.header(`Comms — ${String(result.actionType)}`, '📱') + (result.message ? RichFormatter.alert(String(result.message), 'info') : '');
        output += RichFormatter.embedJson(result, 'COMMS_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: RichFormatter.error(msg) + RichFormatter.embedJson({ error: true, message: msg }, 'COMMS_MANAGE') }] };
    }
}

export const CommsManageTool = {
    name: 'comms_manage',
    description: `FINDINGS #99 (R4): who can reach whom — handset rows, SIM rows, a DIRECTIONAL contact graph, burn/swap/split, reachable(A→B). Attribution is the crime genre's whole tension; it lives in rows now.

Actions: create_device, create_sim, insert_sim, eject_sim, add_contact, copy_contacts, burn, transfer, get, reachable, list, delete
- A character KNOWS a number via active devices' memory + inserted-SIM contacts; is LIVE at a number via an active device's active SIM (or native number).
- reachable {fromCharacterId, toCharacterId} returns the paths AND the reverse direction — one-way silence is a real state.
- copy_contacts (SIM → memory) makes numbers survive the SIM — and survive seizure. burn kills a device; burn {simId, split:true} snaps the card. A burned device still physically contains its SIM until ejected.
- transfer moves the handset between hands: whoever holds it holds every number in it.
worldId REQUIRED on every call.`,
    inputSchema: CommsInputSchema
};
