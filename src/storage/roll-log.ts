/**
 * Every roll, stored: who it was for, against whom, why, the dice, and how to
 * replay it (a seed, or an encounter stream's origin + draw index). A number
 * from a month ago can be checked and replayed.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface RollLogEntry {
    purpose: string;
    forId?: string;
    targetId?: string;
    encounterId?: string;
    expression?: string;
    dice: Array<{ sides: number; value: number }>;
    result?: number;
    /** A math_manage seed, or 'origin@draw' for an encounter stream. */
    replay: string | null;
}

export function ensureRollLog(db: Database.Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS roll_log (
        id TEXT PRIMARY KEY,
        op_id TEXT,
        tool TEXT,
        encounter_id TEXT,
        for_id TEXT,
        target_id TEXT,
        purpose TEXT NOT NULL,
        expression TEXT,
        dice TEXT NOT NULL,
        result INTEGER,
        replay TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_roll_log_for ON roll_log(for_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_roll_log_enc ON roll_log(encounter_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_roll_log_op ON roll_log(op_id);`);
}

export function recordRolls(db: Database.Database, entries: RollLogEntry[], op: { opId?: string; tool?: string }): string[] {
    if (!entries.length) return [];
    ensureRollLog(db);
    const insert = db.prepare(`INSERT INTO roll_log (id, op_id, tool, encounter_id, for_id, target_id, purpose, expression, dice, result, replay, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    return entries.map(e => {
        const id = `roll-${randomUUID()}`;
        insert.run(id, op.opId ?? null, op.tool ?? null, e.encounterId ?? null, e.forId ?? null, e.targetId ?? null, e.purpose,
            e.expression ?? null, JSON.stringify(e.dice), e.result ?? null, e.replay, now);
        return id;
    });
}

export function queryRolls(db: Database.Database, q: { forId?: string; encounterId?: string; opId?: string; limit?: number }): Array<Record<string, unknown>> {
    ensureRollLog(db);
    const where: string[] = []; const args: unknown[] = [];
    if (q.forId) { where.push('for_id = ?'); args.push(q.forId); }
    if (q.encounterId) { where.push('encounter_id = ?'); args.push(q.encounterId); }
    if (q.opId) { where.push('op_id = ?'); args.push(q.opId); }
    const rows = db.prepare(`SELECT * FROM roll_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(...args, Math.min(q.limit ?? 20, 200)) as Array<Record<string, unknown>>;
    return rows.map(r => ({ ...r, dice: JSON.parse(String(r.dice)) }));
}
