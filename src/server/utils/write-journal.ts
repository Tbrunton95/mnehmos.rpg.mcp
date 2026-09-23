/**
 * FINDINGS #88: THE WRITE JOURNAL — row-level snapshots + generic revert.
 *
 * Born from a wrong-id write (a junk property landed on the 15m line instead
 * of the headlamp) that was recoverable ONLY because mergeProperties + null
 * happened to compose. character_manage's write_audit proved the pattern;
 * this generalises it: before a destructive write, snapshot the FULL PRIOR
 * ROW. Revert is then table-agnostic — INSERT OR REPLACE the snapshot back.
 * A journaled DELETE is undeletable-by-accident: the row comes back whole.
 *
 * The table allowlist is the injection guard AND the scope statement: only
 * tables whose rows are safe to restore wholesale are revertable.
 */

interface JournalDb {
    // Parameter positions are any[] on purpose: better-sqlite3's Statement
    // overloads include `(params: {}) => T` variants that are not assignable
    // to unknown[]-typed signatures (TS2345). any[] is bivariant — the real
    // Database satisfies this structurally without importing its types here.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    prepare(sql: string): {
        get: (...args: any[]) => unknown;
        run: (...args: any[]) => { lastInsertRowid: number | bigint; changes: number };
        all: (...args: any[]) => unknown[];
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    exec(sql: string): void;
}

const ALLOWED_TABLES = new Set([
    'items', 'item_instances', 'narrative_notes', 'corpses',
    'rooms', 'pois', 'quests', 'characters',
    // FINDINGS #98 (KEEPER 1.3): agents carry persona slices, secrets, journals
    // and circuit state — the most expensive rows to lose were the one table
    // the journal excluded. The bricking incident had no revert path for
    // exactly this reason.
    'agents'
]);

function assertTable(table: string): string {
    if (!ALLOWED_TABLES.has(table)) throw new Error(`write_journal: table "${table}" is not allowlisted for journaling/revert`);
    return table;
}

export function ensureJournal(db: JournalDb): void {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS write_journal (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_table TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            snapshot TEXT NOT NULL,
            op TEXT NOT NULL,
            source TEXT,
            created_at TEXT NOT NULL
        )`);
    } catch { /* exists */ }
}

/**
 * Snapshot the row AS IT IS NOW, before the caller mutates or deletes it.
 * Returns the journal id (cite it in results), or null if the row doesn't
 * exist — callers refuse on their own terms before ever getting here.
 */
export function journalSnapshot(db: JournalDb, table: string, entityId: string, op: 'update' | 'delete', source?: string): number | null {
    ensureJournal(db);
    const t = assertTable(table);
    const row = db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(entityId);
    if (!row) return null;
    const r = db.prepare(
        'INSERT INTO write_journal (entity_table, entity_id, snapshot, op, source, created_at) VALUES (?,?,?,?,?,?)'
    ).run(t, entityId, JSON.stringify(row), op, source ?? null, new Date().toISOString());
    return Number(r.lastInsertRowid);
}

/** Read the journal — optionally filtered by table and/or entity id. */
export function readJournal(db: JournalDb, opts: { table?: string; entityId?: string; limit?: number }): Array<Record<string, unknown>> {
    ensureJournal(db);
    let sql = 'SELECT id, entity_table, entity_id, op, source, created_at FROM write_journal WHERE 1=1';
    const params: unknown[] = [];
    if (opts.table) { sql += ' AND entity_table = ?'; params.push(assertTable(opts.table)); }
    if (opts.entityId) { sql += ' AND entity_id = ?'; params.push(opts.entityId); }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(opts.limit ?? 10);
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

/**
 * Restore the snapshot wholesale. If the row was deleted, it comes back; if
 * it was mutated, every column returns to the journaled state. The report
 * names the table, the id, and the column count — counts from the store.
 */
export function revertWrite(db: JournalDb, writeId: number): { table: string; entityId: string; op: string; restoredColumns: number; journaledAt: string } {
    ensureJournal(db);
    const row = db.prepare('SELECT * FROM write_journal WHERE id = ?').get(writeId) as { entity_table: string; entity_id: string; snapshot: string; op: string; created_at: string } | undefined;
    if (!row) throw new Error(`write_journal: no journal entry ${writeId} — nothing reverted. session_manage journal to list entries.`);
    const table = assertTable(row.entity_table);
    const snap = JSON.parse(row.snapshot) as Record<string, unknown>;
    const cols = Object.keys(snap);
    db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map(c => snap[c]));
    return { table, entityId: row.entity_id, op: row.op, restoredColumns: cols.length, journaledAt: row.created_at };
}
