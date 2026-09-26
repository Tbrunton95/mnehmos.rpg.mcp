/**
 * PRECEDENT_MANAGE — the table's rulings and inventions as searchable records.
 * "Flight is the Warp's, not the air's", "Vigil at 4 km": continuity the GM
 * looks up instead of remembering. A ruling can be superseded; the old one is
 * kept and points to its replacement.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { readWorldClock } from '../../engine/world-clock.js';
import { SessionContext } from '../types.js';

const ACTIONS = ['record', 'search', 'get', 'supersede', 'list'] as const;

const PrecedentInputSchema = z.object({
    action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
    worldId: z.string().describe('REQUIRED: precedents are world-scoped'),
    precedentId: z.string().optional().describe('get / supersede: the precedent'),
    kind: z.enum(['ruling', 'invention']).optional().describe('record: a ruling on how things work, or something invented for the setting. search/list: filter'),
    statement: z.string().optional().describe("record / supersede: the precedent itself ('Flight is the Warp's, not the air's')"),
    scope: z.string().optional().describe("record: what it covers ('flight', 'Vigil', 'called strikes'). search: filter"),
    tags: z.array(z.string()).optional().describe('record: extra search tags'),
    context: z.string().optional().describe('record: where it came up (scene, fight, session)'),
    day: z.number().optional().describe('record: in-fiction day (default: the world clock)'),
    query: z.string().optional().describe('search: text found in statement, scope, tags or context'),
    includeSuperseded: z.boolean().optional().describe('search / list: also show superseded precedents'),
    limit: z.number().int().min(1).max(100).optional(),
    sessionId: z.string().optional()
});

type Row = {
    id: string; world_id: string; kind: string; statement: string; scope: string | null; tags: string;
    context: string | null; day: number | null; superseded_by: string | null; created_at: string;
};

function pdb() {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS precedents (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL,
        kind TEXT NOT NULL, statement TEXT NOT NULL, scope TEXT,
        tags TEXT NOT NULL DEFAULT '[]', context TEXT, day REAL,
        superseded_by TEXT, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_precedents_world ON precedents(world_id, created_at);`);
    return db;
}

function view(r: Row) {
    return {
        precedentId: r.id, kind: r.kind, statement: r.statement, scope: r.scope, tags: JSON.parse(r.tags),
        context: r.context, day: r.day, supersededBy: r.superseded_by, recordedAt: r.created_at
    };
}

export function recentPrecedents(worldId: string, limit = 5): Array<ReturnType<typeof view>> {
    try {
        const rows = pdb().prepare('SELECT * FROM precedents WHERE world_id = ? AND superseded_by IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?').all(worldId, limit) as Row[];
        return rows.map(view);
    } catch { return []; }
}

async function route(args: unknown): Promise<Record<string, unknown>> {
    const input = PrecedentInputSchema.parse(args);
    const db = pdb();
    const now = new Date().toISOString();
    // Item 14: an unstamped precedent takes the world day.
    const day = input.day ?? readWorldClock(db, input.worldId)?.day ?? null;
    const find = (id?: string) => id ? db.prepare('SELECT * FROM precedents WHERE id = ? AND world_id = ?').get(id, input.worldId) as Row | undefined : undefined;

    switch (input.action) {
        case 'record': case 'add': case 'rule': {
            if (!input.statement || !input.kind) return { error: true, message: "record needs kind ('ruling' | 'invention') and statement" };
            const id = `prec-${randomUUID().slice(0, 8)}`;
            db.prepare('INSERT INTO precedents (id, world_id, kind, statement, scope, tags, context, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(id, input.worldId, input.kind, input.statement, input.scope ?? null, JSON.stringify(input.tags ?? []), input.context ?? null, day, now);
            return { success: true, actionType: 'record', precedent: view(find(id)!), message: `${input.kind} recorded: ${input.statement}` };
        }
        case 'search': case 'list': case 'find': {
            const where = ['world_id = ?']; const params: unknown[] = [input.worldId];
            if (!input.includeSuperseded) where.push('superseded_by IS NULL');
            if (input.kind) { where.push('kind = ?'); params.push(input.kind); }
            if (input.scope) { where.push('LOWER(scope) LIKE ?'); params.push(`%${input.scope.toLowerCase()}%`); }
            if (input.query) {
                where.push('(LOWER(statement) LIKE ? OR LOWER(COALESCE(scope, \'\')) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(COALESCE(context, \'\')) LIKE ?)');
                const q = `%${input.query.toLowerCase()}%`; params.push(q, q, q, q);
            }
            const rows = db.prepare(`SELECT * FROM precedents WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params, input.limit ?? 20) as Row[];
            return { success: true, actionType: 'search', count: rows.length, precedents: rows.map(view), message: `${rows.length} precedent(s)` };
        }
        case 'get': {
            const r = find(input.precedentId);
            if (!r) return { error: true, message: `No precedent ${input.precedentId} in this world` };
            return { success: true, actionType: 'get', precedent: view(r) };
        }
        case 'supersede': case 'overrule': {
            const old = find(input.precedentId);
            if (!old) return { error: true, message: `No precedent ${input.precedentId} in this world` };
            if (!input.statement) return { error: true, message: 'supersede needs the new statement' };
            const id = `prec-${randomUUID().slice(0, 8)}`;
            db.prepare('INSERT INTO precedents (id, world_id, kind, statement, scope, tags, context, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(id, input.worldId, input.kind ?? old.kind, input.statement, input.scope ?? old.scope, JSON.stringify(input.tags ?? JSON.parse(old.tags)), input.context ?? null, day, now);
            db.prepare('UPDATE precedents SET superseded_by = ? WHERE id = ?').run(id, old.id);
            return { success: true, actionType: 'supersede', replaced: view(find(old.id)!), precedent: view(find(id)!), message: `Superseded: ${old.statement} → ${input.statement}` };
        }
    }
    return { error: true, message: `Unknown action '${input.action}': ${ACTIONS.join(', ')}` };
}

export async function handlePrecedentManage(args: unknown, _ctx: SessionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        const result = await route(args);
        let output = result.error ? RichFormatter.error(String(result.message)) : RichFormatter.header(`Precedent: ${String(result.actionType)}`, '⚖️') + (result.message ? RichFormatter.alert(String(result.message), 'info') : '');
        if (!result.error && Array.isArray(result.precedents)) {
            output += RichFormatter.list((result.precedents as Array<ReturnType<typeof view>>).map(p =>
                `[${p.kind}${p.scope ? ` · ${p.scope}` : ''}] ${p.statement}${p.supersededBy ? ` (superseded by ${p.supersededBy})` : ''} (${p.precedentId})`));
        }
        output += RichFormatter.embedJson(result, 'PRECEDENT_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: RichFormatter.error(msg) + RichFormatter.embedJson({ error: true, message: msg }, 'PRECEDENT_MANAGE') }] };
    }
}

export const PrecedentManageTool = {
    name: 'precedent_manage',
    description: `The table's rulings and inventions as searchable, dated records, so continuity is looked up, not remembered.

Actions: record, search, get, supersede, list
- record {worldId, kind: 'ruling' | 'invention', statement, scope?, tags?, context?, day?}: every ruling you make and everything you invent ("[invention]") goes here.
- search {worldId, query?, scope?, kind?}: check before ruling on something that may have come up before.
- supersede {worldId, precedentId, statement}: a new ruling replaces an old one; the old one is kept and points to it.
worldId REQUIRED on every call.`,
    inputSchema: PrecedentInputSchema,
    actionSchemas: Object.fromEntries(ACTIONS.map(a => [a, { schema: PrecedentInputSchema, aliases: [] as string[] }]))
};
