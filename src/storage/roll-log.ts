/**
 * Every roll, stored: who it was for, against whom, why, the dice, which
 * source rolled them (crypto or a seeded stream) and how to audit them (a
 * seed or an encounter stream's origin + draw index for a seeded roll; a
 * 'crypto:<nonce>' key for a crypto roll). A number from a month ago can be
 * checked, and a seeded one replayed.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isCryptoKey } from '../math/crypto-dice.js';

export type RollSource = 'crypto' | 'seeded';

export interface RollLogEntry {
    purpose: string;
    forId?: string;
    targetId?: string;
    encounterId?: string;
    worldId?: string | null;
    expression?: string;
    dice: Array<{ sides: number; value: number }>;
    result?: number;
    /** A math_manage seed, 'origin@draw' for a seeded encounter stream, or 'crypto:<nonce>'. */
    replay: string | null;
    /** Which dice rolled it; inferred from `replay` when omitted. */
    source?: RollSource;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some(c => c.name === column);
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
    // Crypto dice by default: which source rolled it, and the world it was
    // rolled in, so the GM's audit (session_manage rolls stats) is one call.
    if (!hasColumn(db, 'roll_log', 'source')) db.exec('ALTER TABLE roll_log ADD COLUMN source TEXT');
    if (!hasColumn(db, 'roll_log', 'world_id')) db.exec('ALTER TABLE roll_log ADD COLUMN world_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_roll_log_world ON roll_log(world_id, created_at)');
}

/** 'crypto' for a crypto key, 'seeded' for any other replay, null for an unreplayable legacy roll. */
export function sourceOf(replay: string | null | undefined): RollSource | null {
    if (!replay) return null;
    return isCryptoKey(replay) ? 'crypto' : 'seeded';
}

export function recordRolls(db: Database.Database, entries: RollLogEntry[], op: { opId?: string; tool?: string; worldId?: string | null }): string[] {
    if (!entries.length) return [];
    ensureRollLog(db);
    const insert = db.prepare(`INSERT INTO roll_log (id, op_id, tool, encounter_id, for_id, target_id, purpose, expression, dice, result, replay, source, world_id, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    return entries.map(e => {
        const id = `roll-${randomUUID()}`;
        insert.run(id, op.opId ?? null, op.tool ?? null, e.encounterId ?? null, e.forId ?? null, e.targetId ?? null, e.purpose,
            e.expression ?? null, JSON.stringify(e.dice), e.result ?? null, e.replay, e.source ?? sourceOf(e.replay), e.worldId ?? op.worldId ?? null, now);
        return id;
    });
}

export interface RollQuery {
    forId?: string;
    encounterId?: string;
    opId?: string;
    worldId?: string;
    /** ISO timestamp: rolls at or after this moment. */
    since?: string;
    /** Purpose fragment, case-insensitive ('save' matches 'dex save'). */
    purpose?: string;
    source?: RollSource;
    limit?: number;
}

function whereClause(q: RollQuery): { sql: string; args: unknown[] } {
    const where: string[] = []; const args: unknown[] = [];
    if (q.forId) { where.push('for_id = ?'); args.push(q.forId); }
    if (q.encounterId) { where.push('encounter_id = ?'); args.push(q.encounterId); }
    if (q.opId) { where.push('op_id = ?'); args.push(q.opId); }
    if (q.worldId) { where.push('world_id = ?'); args.push(q.worldId); }
    if (q.since) { where.push('created_at >= ?'); args.push(q.since); }
    if (q.purpose) { where.push('LOWER(purpose) LIKE ?'); args.push(`%${q.purpose.toLowerCase()}%`); }
    if (q.source) { where.push('source = ?'); args.push(q.source); }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export function queryRolls(db: Database.Database, q: RollQuery): Array<Record<string, unknown>> {
    ensureRollLog(db);
    const { sql, args } = whereClause(q);
    const rows = db.prepare(`SELECT * FROM roll_log ${sql} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(...args, Math.min(q.limit ?? 20, 200)) as Array<Record<string, unknown>>;
    return rows.map(r => ({ ...r, dice: JSON.parse(String(r.dice)) }));
}

/** Chi-squared 95% cutoff for 19 degrees of freedom (a d20's faces). */
export const D20_CHI2_CUTOFF_95 = 30.144;

export interface RollStats {
    /** Rolls (roll_log rows) matching the filter, not dice. */
    count: number;
    d20: {
        /** d20 dice counted. */
        n: number;
        mean: number;
        nat20: number;
        nat1: number;
        /** Chi-squared statistic of the face counts against uniform. */
        chi2: number;
        cutoff95: number;
        /** chi2 above the cutoff: the faces are not plausibly uniform at 95%. */
        biased: boolean;
    };
    /** How often each d20 face came up, index 0 = face 1. */
    faces: number[];
    bySource: Record<string, number>;
}

/**
 * The GM's audit: over every roll matching the filter, how the d20s fell.
 * Only d20 dice count toward the distribution; other dice only count rows.
 */
export function rollStats(db: Database.Database, q: Omit<RollQuery, 'limit'>): RollStats {
    ensureRollLog(db);
    const { sql, args } = whereClause(q);
    const rows = db.prepare(`SELECT dice, source FROM roll_log ${sql}`).all(...args) as Array<{ dice: string; source: string | null }>;
    const faces = new Array<number>(20).fill(0);
    const bySource: Record<string, number> = {};
    let n = 0; let sum = 0;
    for (const row of rows) {
        bySource[row.source ?? 'unknown'] = (bySource[row.source ?? 'unknown'] ?? 0) + 1;
        let dice: Array<{ sides: number; value: number }>;
        try { dice = JSON.parse(row.dice); } catch { continue; }
        for (const d of dice) {
            if (d.sides !== 20 || !Number.isInteger(d.value) || d.value < 1 || d.value > 20) continue;
            faces[d.value - 1]++; n++; sum += d.value;
        }
    }
    const expected = n / 20;
    const chi2 = n === 0 ? 0 : faces.reduce((acc, obs) => acc + ((obs - expected) ** 2) / expected, 0);
    return {
        count: rows.length,
        d20: {
            n,
            mean: n === 0 ? 0 : Math.round((sum / n) * 1000) / 1000,
            nat20: faces[19],
            nat1: faces[0],
            chi2: Math.round(chi2 * 1000) / 1000,
            cutoff95: D20_CHI2_CUTOFF_95,
            biased: n > 0 && chi2 > D20_CHI2_CUTOFF_95
        },
        faces,
        bySource
    };
}
