/**
 * FINDINGS #93: CONTAINER_MANAGE — the highest-value ask in the feature
 * request: nothing could be inside anything, so every campaign hand-ran a
 * "cache ledger" in prose and it drifted. One primitive: stashes, safes,
 * wall voids, vehicle boots, backpacks, buried caches.
 * Contents do NOT count against the holder's carry weight — that is the
 * point of setting something down. put/take move REAL inventory rows, so
 * the Iron Law holds: an item is in exactly one place.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { matchAction, isGuidingError } from '../../utils/fuzzy-enum.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { ItemRepository } from '../../storage/repos/item.repo.js';
import { InventoryRepository } from '../../storage/repos/inventory.repo.js';
import { SessionContext } from '../types.js';

const ACTIONS = ['create', 'get', 'list', 'put', 'take', 'move', 'destroy'] as const;
type ContainerAction = typeof ACTIONS[number];
const ALIASES: Record<string, ContainerAction> = {
    'new': 'create', 'stash': 'create', 'open': 'get', 'contents': 'get',
    'store': 'put', 'deposit': 'put', 'retrieve': 'take', 'withdraw': 'take',
    'relocate': 'move', 'delete': 'destroy'
};

const ContainerInputSchema = z.object({
    action: z.string().describe('Action: create, get, list, put, take, move, destroy'),
    worldId: z.string().describe('REQUIRED — containers are world-scoped'),
    containerId: z.string().optional(),
    name: z.string().optional().describe('create: container name ("boot of the UAZ", "floor cache, den")'),
    ownerType: z.enum(['character', 'room', 'vehicle', 'corpse', 'none']).optional().describe('create/move: what holds the container'),
    ownerId: z.string().optional().describe('create/move: id of the owner (character id, room_nodes id, item id for a vehicle, corpse id); omit for none'),
    capacityLbs: z.number().positive().optional().describe('create: weight capacity; OMIT for unlimited'),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional().describe('hidden containers are excluded from list unless includeHidden'),
    trapped: z.boolean().optional().describe('flag only — the trap itself is GM fiction'),
    includeHidden: z.boolean().optional(),
    characterId: z.string().optional().describe('put/take: whose inventory the item moves from/to'),
    itemId: z.string().optional().describe('put/take: item template id'),
    quantity: z.number().int().min(1).optional().default(1),
    ignoreLock: z.boolean().optional().describe('put/take on a locked container: GM override after the fiction opens it'),
    force: z.boolean().optional().describe('destroy: spill and destroy even with contents'),
    sessionId: z.string().optional()
});

function cdb() {
    const db = getDb(process.env.NODE_ENV === 'test' ? ':memory:' : process.env.RPG_DATA_DIR ? `${process.env.RPG_DATA_DIR}/rpg.db` : 'rpg.db');
    db.exec(`CREATE TABLE IF NOT EXISTS containers (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL, name TEXT NOT NULL,
        owner_type TEXT NOT NULL DEFAULT 'none', owner_id TEXT,
        capacity_lbs REAL, locked INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0, trapped INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS container_items (
        container_id TEXT NOT NULL, item_id TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (container_id, item_id))`);
    return { db, itemRepo: new ItemRepository(db), invRepo: new InventoryRepository(db) };
}
type CRow = { id: string; world_id: string; name: string; owner_type: string; owner_id: string | null; capacity_lbs: number | null; locked: number; hidden: number; trapped: number };

function contents(db: ReturnType<typeof cdb>['db'], itemRepo: ItemRepository, containerId: string) {
    const rows = db.prepare('SELECT item_id, quantity FROM container_items WHERE container_id = ?').all(containerId) as Array<{ item_id: string; quantity: number }>;
    let weight = 0;
    const items = rows.map(r => {
        const t = itemRepo.findById(r.item_id);
        const w = (t?.weight ?? 0) * r.quantity;
        weight += w;
        return { itemId: r.item_id, name: t?.name ?? r.item_id, quantity: r.quantity, unitWeight: t?.weight ?? 0, weight: w };
    });
    return { items, totalWeight: Math.round(weight * 100) / 100 };
}

async function route(args: unknown): Promise<Record<string, unknown>> {
    const input = ContainerInputSchema.parse(args);
    const matched = matchAction(input.action, ACTIONS, ALIASES);
    if (isGuidingError(matched)) return { error: true, message: matched.message };
    const { db, itemRepo, invRepo } = cdb();
    const now = new Date().toISOString();
    const find = (id?: string): CRow | null => id ? ((db.prepare('SELECT * FROM containers WHERE id = ? AND world_id = ?').get(id, input.worldId) as CRow | undefined) ?? null) : null;

    switch (matched.matched) {
        case 'create': {
            if (!input.name) return { error: true, message: 'create requires name' };
            const id = `ctr-${randomUUID().slice(0, 8)}`;
            db.prepare('INSERT INTO containers (id, world_id, name, owner_type, owner_id, capacity_lbs, locked, hidden, trapped, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
                .run(id, input.worldId, input.name, input.ownerType ?? 'none', input.ownerId ?? null, input.capacityLbs ?? null, input.locked ? 1 : 0, input.hidden ? 1 : 0, input.trapped ? 1 : 0, now, now);
            return { success: true, actionType: 'create', containerId: id, name: input.name, ownerType: input.ownerType ?? 'none', ownerId: input.ownerId ?? null, capacityLbs: input.capacityLbs ?? 'unlimited', message: `Container "${input.name}" created (${id})` };
        }
        case 'get': {
            const c = find(input.containerId);
            if (!c) return { error: true, message: `No container ${input.containerId} in this world — container_manage list to see them` };
            const inv = contents(db, itemRepo, c.id);
            return { success: true, actionType: 'get', containerId: c.id, name: c.name, ownerType: c.owner_type, ownerId: c.owner_id, locked: c.locked === 1, hidden: c.hidden === 1, trapped: c.trapped === 1, capacityLbs: c.capacity_lbs ?? 'unlimited', ...inv, message: `${c.name}: ${inv.items.length} item type(s), ${inv.totalWeight} lbs${c.locked ? ' — LOCKED' : ''}` };
        }
        case 'list': {
            const rows = db.prepare(`SELECT * FROM containers WHERE world_id = ?${input.includeHidden ? '' : ' AND hidden = 0'}${input.ownerId ? ' AND owner_id = ?' : ''} ORDER BY name`).all(...(input.ownerId ? [input.worldId, input.ownerId] : [input.worldId])) as CRow[];
            return {
                success: true, actionType: 'list', count: rows.length,
                containers: rows.map(c => ({ containerId: c.id, name: c.name, ownerType: c.owner_type, ownerId: c.owner_id, locked: c.locked === 1, trapped: c.trapped === 1, itemTypes: (db.prepare('SELECT COUNT(*) AS n FROM container_items WHERE container_id = ?').get(c.id) as { n: number }).n })),
                ...(input.includeHidden ? {} : { note: 'hidden containers excluded — includeHidden:true to show them (GM eyes)' }),
                message: `${rows.length} container(s)`
            };
        }
        case 'put':
        case 'take': {
            const c = find(input.containerId);
            if (!c) return { error: true, message: `No container ${input.containerId} in this world` };
            if (!input.characterId || !input.itemId) return { error: true, message: `${matched.matched} requires characterId and itemId` };
            if (c.locked === 1 && !input.ignoreLock) return { error: true, message: `${c.name} is LOCKED — open it in fiction first, then pass ignoreLock:true. Nothing moved.` };
            const qty = input.quantity ?? 1;
            const tpl = itemRepo.findById(input.itemId);
            if (!tpl) return { error: true, message: `Item template ${input.itemId} not found` };
            if (matched.matched === 'put') {
                if (c.capacity_lbs !== null) {
                    const cur = contents(db, itemRepo, c.id).totalWeight;
                    const adding = (tpl.weight ?? 0) * qty;
                    if (cur + adding > c.capacity_lbs) return { error: true, message: `${c.name} capacity ${c.capacity_lbs} lbs — holds ${cur}, adding ${adding} overflows. Nothing moved.` };
                }
                const ok = invRepo.removeItem(input.characterId, input.itemId, qty);
                if (!ok) return { error: true, message: `Character does not have ${qty}x ${tpl.name} to put — nothing moved` };
                db.prepare('INSERT INTO container_items (container_id, item_id, quantity) VALUES (?,?,?) ON CONFLICT(container_id, item_id) DO UPDATE SET quantity = quantity + ?').run(c.id, input.itemId, qty, qty);
                return { success: true, actionType: 'put', containerId: c.id, item: tpl.name, quantity: qty, message: `${qty}x ${tpl.name} → ${c.name}. Off the carry weight, on the world.` };
            } else {
                const have = db.prepare('SELECT quantity FROM container_items WHERE container_id = ? AND item_id = ?').get(c.id, input.itemId) as { quantity: number } | undefined;
                if (!have || have.quantity < qty) return { error: true, message: `${c.name} holds ${have?.quantity ?? 0}x ${tpl.name} — cannot take ${qty}. Nothing moved.` };
                if (have.quantity === qty) db.prepare('DELETE FROM container_items WHERE container_id = ? AND item_id = ?').run(c.id, input.itemId);
                else db.prepare('UPDATE container_items SET quantity = quantity - ? WHERE container_id = ? AND item_id = ?').run(qty, c.id, input.itemId);
                invRepo.addItem(input.characterId, input.itemId, qty);
                return { success: true, actionType: 'take', containerId: c.id, item: tpl.name, quantity: qty, message: `${qty}x ${tpl.name} ← ${c.name}, back on the character.` };
            }
        }
        case 'move': {
            const c = find(input.containerId);
            if (!c) return { error: true, message: `No container ${input.containerId} in this world` };
            db.prepare('UPDATE containers SET owner_type = COALESCE(?, owner_type), owner_id = ?, locked = COALESCE(?, locked), hidden = COALESCE(?, hidden), trapped = COALESCE(?, trapped), updated_at = ? WHERE id = ?')
                .run(input.ownerType ?? null, input.ownerId ?? c.owner_id, input.locked === undefined ? null : (input.locked ? 1 : 0), input.hidden === undefined ? null : (input.hidden ? 1 : 0), input.trapped === undefined ? null : (input.trapped ? 1 : 0), now, c.id);
            return { success: true, actionType: 'move', containerId: c.id, name: c.name, message: `${c.name} updated — owner ${input.ownerType ?? c.owner_type}/${input.ownerId ?? c.owner_id ?? 'none'}` };
        }
        case 'destroy': {
            const c = find(input.containerId);
            if (!c) return { error: true, message: `No container ${input.containerId} in this world` };
            const inv = contents(db, itemRepo, c.id);
            if (inv.items.length && !input.force) return { error: true, message: `${c.name} still holds ${inv.items.length} item type(s) — take them out, or destroy with force:true to SPILL AND LOSE them (report will name everything).`, contents: inv.items };
            db.prepare('DELETE FROM container_items WHERE container_id = ?').run(c.id);
            db.prepare('DELETE FROM containers WHERE id = ?').run(c.id);
            return { success: true, actionType: 'destroy', containerId: c.id, name: c.name, ...(inv.items.length ? { spilled: inv.items, spillNote: 'Contents destroyed with the container — named above. If the fiction scatters them instead, re-create as world items.' } : {}), message: `${c.name} destroyed${inv.items.length ? ` — ${inv.items.length} item type(s) went with it` : ''}` };
        }
    }
    return { error: true, message: 'unhandled' };
}

export async function handleContainerManage(args: unknown, _ctx: SessionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        const result = await route(args);
        let output = result.error ? RichFormatter.error(String(result.message)) : RichFormatter.header(`Container — ${String(result.actionType)}`, '📦') + (result.message ? RichFormatter.alert(String(result.message), 'info') : '');
        output += RichFormatter.embedJson(result, 'CONTAINER_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: RichFormatter.error(msg) + RichFormatter.embedJson({ error: true, message: msg }, 'CONTAINER_MANAGE') }] };
    }
}

export const ContainerManageTool = {
    name: 'container_manage',
    description: `FINDINGS #93: containers — things can finally be inside things. Stashes, safes, wall voids, vehicle boots, backpacks, buried caches: one primitive, retiring the hand-run cache ledger.

Actions: create, get, list, put, take, move, destroy
- Contents do NOT count against carry weight — that is the point of setting something down.
- put/take move REAL inventory rows: an item is in exactly one place (Iron Law).
- locked refuses put/take until the fiction opens it (ignoreLock:true = GM override). hidden hides from list. trapped is a flag; the trap is fiction.
- capacityLbs omitted = unlimited. destroy refuses while loaded unless force (spill named in full).
worldId REQUIRED on every call.`,
    inputSchema: ContainerInputSchema,
    // Every action shares the one input schema; the switch dispatcher validates per action.
    actionSchemas: Object.fromEntries(ACTIONS.map(a => [a, { schema: ContainerInputSchema, aliases: [] as string[] }]))
};
