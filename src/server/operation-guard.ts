/**
 * Every tool call as one operation (field report, tier 1):
 *
 * - All or nothing. The call runs inside a SAVEPOINT on its campaign
 *   database. If it throws or answers with an error (error: true, a string
 *   error code such as validation_error, or the MCP isError flag), every
 *   write it made is rolled back and the session's in-memory combat engines
 *   are dropped so the next call reloads them from the (rolled back)
 *   database. Half-applied turns were where the drift came from.
 * - One at a time. Calls on the same database queue behind each other, so
 *   two requests can never interleave inside one savepoint.
 * - Operation IDs. A call may carry opId. The first call runs and stores its
 *   reply; a retry with the same opId and arguments gets that reply back and
 *   applies nothing, so a timeout is safe to retry. The same opId with other
 *   arguments is refused. An error reply, or one that says writes: 'none',
 *   consumes nothing: the opId stays free for the corrected resend (play
 *   report 2, #11).
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../storage/index.js';
import { getCombatManager } from './state/combat-manager.js';
import { getTenant } from '../storage/tenant-context.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { recordRolls } from '../storage/roll-log.js';
import { replyOutcome } from './reply-status.js';

export interface OperationContext {
    opId?: string;
    tool: string;
    /** The world the call named (args.worldId) or the tenant carries, for roll_log.world_id. */
    worldId?: string;
}

const opContext = new AsyncLocalStorage<OperationContext>();

/** The operation this code runs inside (for roll_log), if any. */
export function currentOperation(): OperationContext | undefined {
    return opContext.getStore();
}

/** The world an encounter was stamped with, when the column and row exist. */
function encounterWorld(db: Database.Database, encounterId: string): string | null {
    try {
        const row = db.prepare('SELECT world_id FROM encounters WHERE id = ?').get(encounterId) as { world_id?: string | null } | undefined;
        return row?.world_id ?? null;
    } catch { return null; }
}

/** Write the session's combat dice since the last drain to roll_log. */
function flushCombatRolls(db: Database.Database, sessionId: string, op: OperationContext): void {
    const manager = getCombatManager();
    for (const key of manager.list()) {
        if (!key.startsWith(`${sessionId}:`)) continue;
        const engine = manager.get(key);
        const records = engine?.drainRollRecords?.() ?? [];
        if (!records.length) continue;
        const encounterId = key.slice(sessionId.length + 1);
        const worldId = op.worldId ?? encounterWorld(db, encounterId);
        recordRolls(db, records.map(r => ({
            purpose: r.purpose, forId: r.forId, targetId: r.targetId, encounterId, worldId,
            dice: r.dice, result: r.dice.reduce((a, d) => a + d.value, 0),
            // Crypto rolls carry their own nonce key; seeded ones replay from origin@draw.
            replay: r.replay ?? (r.origin !== null ? `${r.origin}@${r.startDraw}` : null),
            source: r.source
        })), op);
    }
}

type ToolReply = { content?: Array<{ type: string; text: string }>; isError?: boolean };
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

/** The guard's line on top of a reply's first text block. */
function prefixed(res: ToolReply, line: string): ToolReply {
    if (!res?.content?.[0]) return res;
    return { ...res, content: [{ ...res.content[0], text: `${line}\n${res.content[0].text}` }, ...res.content.slice(1)] };
}

/**
 * A stored op_log row whose reply was an error or said writes: 'none':
 * written before the guard read string errors and no-write replies, it
 * records nothing that happened, so the opId it holds is still free.
 */
function storedUnconsumed(response: string): boolean {
    return replyOutcome({ content: [{ type: 'text', text: response }] }) !== 'applied';
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
    // A row holding an error or a no-write reply was burned before this guard
    // read them; op_status and the replay check agree that it did not apply.
    if (!row || storedUnconsumed(row.response)) return null;
    return { tool: row.tool, createdAt: row.created_at, response: row.response };
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
            // Claude Desktop runs two server processes on one database. The
            // outermost call takes the write lock up front (BEGIN IMMEDIATE),
            // so the other process waits on busy_timeout instead of working
            // from state about to go stale; a nested call keeps a savepoint.
            const outer = !db.inTransaction;
            const sp = `op_${++savepointSeq}`;
            db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
            const rollback = () => {
                if (outer) { if (db.inTransaction) db.exec('ROLLBACK'); }
                else { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); }
            };
            // Under the lock, read fresh: a cached combat engine may predate
            // the other process's writes, and would roll its dice again.
            if (outer) evictSessionEngines(sessionKey());
            let argsHash = '';
            if (opId) {
                ensureOpLog(db);
                argsHash = hashArgs(toolName, args ?? {});
                const done = db.prepare('SELECT tool, args_hash, response, created_at FROM op_log WHERE op_id = ?').get(opId) as { tool: string; args_hash: string; response: string; created_at: string } | undefined;
                if (done && storedUnconsumed(done.response)) {
                    // Healing: an opId burned by a validation, unknown-action or
                    // preview reply before this fix. Drop the row and let the call run.
                    db.prepare('DELETE FROM op_log WHERE op_id = ?').run(opId);
                } else if (done) {
                    if (done.args_hash !== argsHash || done.tool !== toolName) {
                        const message = `opId ${opId} was already used for a different call (${done.tool} at ${done.created_at}). Nothing was applied; use a new opId.`;
                        rollback();
                        return { content: [{ type: 'text', text: `▌ ✖ REFUSED — ${message}\n<!-- OPERATION_JSON\n${JSON.stringify({ error: true, opId, message, writes: 'none' })}\nOPERATION_JSON -->` }] };
                    }
                    rollback();
                    return { content: [{ type: 'text', text: `▌ ↺ REPLAYED op ${opId}: already applied at ${done.created_at}; nothing applied again.\n${done.response}` }] };
                }
            }

            let res: ToolReply;
            const argWorld = typeof args?.worldId === 'string' && args.worldId ? args.worldId : undefined;
            const op: OperationContext = { opId, tool: toolName, worldId: argWorld ?? getTenant()?.worldId };
            try {
                res = await opContext.run(op, () => handler(args, extra));
            } catch (e) {
                rollback();
                evictSessionEngines(sessionKey());
                throw e;
            }
            const outcome = replyOutcome(res);
            if (outcome === 'error') {
                // The call failed partway or refused: nothing it wrote stays,
                // and the opId is not consumed.
                rollback();
                evictSessionEngines(sessionKey());
                return opId ? prefixed(res, `▌ op ${opId} NOT applied (error) — opId still free; fix the call and resend with the same opId`) : res;
            }
            flushCombatRolls(db, sessionKey(), op);
            if (opId) {
                if (outcome === 'no_write') {
                    // A refusal or a preview: the audit row commits, but there
                    // is nothing to replay, so the opId stays free.
                    res = prefixed(res, `▌ op ${opId}: nothing written — opId not consumed`);
                } else {
                    db.prepare('INSERT INTO op_log (op_id, tool, args_hash, response, created_at) VALUES (?, ?, ?, ?, ?)')
                        .run(opId, toolName, argsHash, res?.content?.[0]?.text ?? '', new Date().toISOString());
                    res = prefixed(res, `▌ op ${opId} applied`);
                }
            }
            db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
            return res;
        } finally {
            release();
        }
    };
}
