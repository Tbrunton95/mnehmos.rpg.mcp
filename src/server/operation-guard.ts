/**
 * Every tool call as one operation (field report, tier 1):
 *
 * - All or nothing. The call runs inside a SAVEPOINT on its campaign
 *   database. If it throws or answers with an error, every write it made is
 *   rolled back and the session's in-memory combat engines are dropped so the
 *   next call reloads them from the (rolled back) database. Half-applied
 *   turns were where the drift came from.
 * - One at a time. Calls on the same database queue behind each other, so
 *   two requests can never interleave inside one savepoint.
 * - Operation IDs. A call may carry opId. The first call runs and stores its
 *   reply; a retry with the same opId and arguments gets that reply back and
 *   applies nothing, so a timeout is safe to retry. The same opId with other
 *   arguments is refused.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../storage/index.js';
import { getCombatManager } from './state/combat-manager.js';
import { getTenant } from '../storage/tenant-context.js';

type ToolReply = { content?: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolReply>;

/** Tools that wait on outside services (LLM calls) run without holding the database. */
const UNGUARDED = new Set(['agent_manage']);

const queues = new WeakMap<object, Promise<unknown>>();
let savepointSeq = 0;

function ensureOpLog(db: Database.Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS op_log (
        op_id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL
    )`);
}

function hashArgs(tool: string, args: Record<string, unknown>): string {
    const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, stable((v as Record<string, unknown>)[k])]))
            : v;
    return createHash('sha256').update(tool + JSON.stringify(stable(args))).digest('hex');
}

/** An error reply: the embedded JSON says error: true, or the call failed outright. */
function isErrorReply(res: ToolReply | undefined): boolean {
    const text = res?.content?.[0]?.text;
    if (!text) return false;
    const m = text.match(/<!--\s*([A-Z_]*JSON)\s*\n?([\s\S]*?)\n?\1\s*-->/);
    const body = m ? m[2] : text.trim().startsWith('{') ? text : null;
    if (!body) return false;
    try {
        const parsed = JSON.parse(body);
        return !!parsed && typeof parsed === 'object' && parsed.error === true;
    } catch { return false; }
}

function sessionKey(): string {
    const t = getTenant();
    return t ? `${t.accountId}:${t.campaignId}` : 'unscoped';
}

/** Drop this session's live engines so the next call reloads them from the database. */
export function evictSessionEngines(sessionId: string): void {
    const manager = getCombatManager();
    for (const key of manager.list()) if (key.startsWith(`${sessionId}:`)) manager.delete(key);
}

export function lookupOperation(db: Database.Database, opId: string): { tool: string; createdAt: string; response: string } | null {
    ensureOpLog(db);
    const row = db.prepare('SELECT tool, created_at, response FROM op_log WHERE op_id = ?').get(opId) as { tool: string; created_at: string; response: string } | undefined;
    return row ? { tool: row.tool, createdAt: row.created_at, response: row.response } : null;
}

export function withOperation(toolName: string, handler: Handler): Handler {
    return async (args, extra) => {
        const opId = typeof args?.opId === 'string' && args.opId ? args.opId : undefined;
        if (args) delete args.opId;
        if (UNGUARDED.has(toolName)) return handler(args, extra);

        let db: Database.Database;
        try { db = getDb(); } catch { return handler(args, extra); }

        const previous = queues.get(db) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>(r => { release = r; });
        queues.set(db, previous.then(() => mine));
        await previous.catch(() => undefined);
        try {
            let argsHash = '';
            if (opId) {
                ensureOpLog(db);
                argsHash = hashArgs(toolName, args ?? {});
                const done = db.prepare('SELECT tool, args_hash, response, created_at FROM op_log WHERE op_id = ?').get(opId) as { tool: string; args_hash: string; response: string; created_at: string } | undefined;
                if (done) {
                    if (done.args_hash !== argsHash || done.tool !== toolName) {
                        const message = `opId ${opId} was already used for a different call (${done.tool} at ${done.created_at}). Nothing was applied; use a new opId.`;
                        return { content: [{ type: 'text', text: `▌ ✖ REFUSED — ${message}\n<!-- OPERATION_JSON\n${JSON.stringify({ error: true, opId, message, writes: 'none' })}\nOPERATION_JSON -->` }] };
                    }
                    return { content: [{ type: 'text', text: `▌ ↺ REPLAYED op ${opId}: already applied at ${done.created_at}; nothing applied again.\n${done.response}` }] };
                }
            }

            const sp = `op_${++savepointSeq}`;
            db.exec(`SAVEPOINT ${sp}`);
            let res: ToolReply;
            try {
                res = await handler(args, extra);
            } catch (e) {
                db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`);
                evictSessionEngines(sessionKey());
                throw e;
            }
            if (isErrorReply(res)) {
                // The call failed partway or refused: nothing it wrote stays.
                db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`);
                evictSessionEngines(sessionKey());
                return res;
            }
            if (opId) {
                db.prepare('INSERT INTO op_log (op_id, tool, args_hash, response, created_at) VALUES (?, ?, ?, ?, ?)')
                    .run(opId, toolName, argsHash, res?.content?.[0]?.text ?? '', new Date().toISOString());
                if (res?.content?.[0]) res = { ...res, content: [{ ...res.content[0], text: `▌ op ${opId} applied\n${res.content[0].text}` }, ...res.content.slice(1)] };
            }
            db.exec(`RELEASE ${sp}`);
            return res;
        } finally {
            release();
        }
    };
}
