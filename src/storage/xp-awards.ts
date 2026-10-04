/**
 * The XP award ledger: every XP the engine writes leaves a posted row here
 * (who, how much, why, which tool), and an award the GM narrated at the
 * table but has not applied yet sits as an unposted row until
 * `character_manage post_awards` pushes it through the normal add_xp path.
 * The boot packet and the status block read the pending rows, so a
 * "you get 200 XP for that" said in chat can no longer vanish.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface XpAward {
    id: string;
    worldId: string | null;
    characterId: string;
    amount: number;
    reason: string;
    source: string;
    posted: boolean;
    createdAt: string;
    postedAt: string | null;
}

export const XP_AWARDS_DDL = `
    CREATE TABLE IF NOT EXISTS xp_awards (
        id TEXT PRIMARY KEY,
        world_id TEXT,
        character_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        posted INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        posted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_xp_awards_char_posted ON xp_awards(character_id, posted);
    CREATE INDEX IF NOT EXISTS idx_xp_awards_world_posted ON xp_awards(world_id, posted);`;

export function ensureXpAwards(db: Database.Database): void {
    db.exec(XP_AWARDS_DDL);
}

interface Row { id: string; world_id: string | null; character_id: string; amount: number; reason: string; source: string; posted: number; created_at: string; posted_at: string | null }
const fromRow = (r: Row): XpAward => ({
    id: r.id, worldId: r.world_id, characterId: r.character_id, amount: r.amount, reason: r.reason,
    source: r.source, posted: r.posted === 1, createdAt: r.created_at, postedAt: r.posted_at
});

/** Record one award. `posted: false` is a narrated award waiting for post_awards. */
export function recordAward(db: Database.Database, a: { worldId?: string | null; characterId: string; amount: number; reason: string; source: string; posted?: boolean }): XpAward {
    ensureXpAwards(db);
    const now = new Date().toISOString();
    const posted = a.posted !== false;
    const row: Row = {
        id: `xpa-${randomUUID().slice(0, 8)}`, world_id: a.worldId ?? null, character_id: a.characterId,
        amount: Math.trunc(a.amount), reason: a.reason, source: a.source, posted: posted ? 1 : 0,
        created_at: now, posted_at: posted ? now : null
    };
    db.prepare(`INSERT INTO xp_awards (id, world_id, character_id, amount, reason, source, posted, created_at, posted_at)
                VALUES (@id, @world_id, @character_id, @amount, @reason, @source, @posted, @created_at, @posted_at)`).run(row);
    return fromRow(row);
}

export interface ListFilter { characterId?: string; worldId?: string; pendingOnly?: boolean; limit?: number }

export function listAwards(db: Database.Database, f: ListFilter = {}): XpAward[] {
    ensureXpAwards(db);
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.characterId) { where.push('character_id = ?'); params.push(f.characterId); }
    if (f.worldId) { where.push('world_id = ?'); params.push(f.worldId); }
    if (f.pendingOnly) where.push('posted = 0');
    const sql = `SELECT * FROM xp_awards${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    params.push(Math.max(1, Math.min(f.limit ?? 50, 500)));
    return (db.prepare(sql).all(...params) as Row[]).map(fromRow);
}

/** Sum and count of unposted rows for one character or one world. */
export function pendingTotal(db: Database.Database, f: { characterId?: string; worldId?: string }): { total: number; count: number } {
    ensureXpAwards(db);
    const where: string[] = ['posted = 0'];
    const params: unknown[] = [];
    if (f.characterId) { where.push('character_id = ?'); params.push(f.characterId); }
    if (f.worldId) { where.push('world_id = ?'); params.push(f.worldId); }
    const r = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM xp_awards WHERE ${where.join(' AND ')}`).get(...params) as { total: number; count: number };
    return { total: r.total, count: r.count };
}

/**
 * Mark pending rows posted and return them grouped by character, so the
 * caller makes one XP write per character. The write itself is the
 * caller's (the add_xp path), not this module's.
 */
export function postPending(db: Database.Database, f: { characterId?: string; worldId?: string }): Array<{ characterId: string; total: number; awards: XpAward[] }> {
    const pending = listAwards(db, { ...f, pendingOnly: true, limit: 500 });
    if (!pending.length) return [];
    const now = new Date().toISOString();
    const mark = db.prepare('UPDATE xp_awards SET posted = 1, posted_at = ? WHERE id = ?');
    const byChar = new Map<string, { characterId: string; total: number; awards: XpAward[] }>();
    for (const a of pending) {
        mark.run(now, a.id);
        const g = byChar.get(a.characterId) ?? { characterId: a.characterId, total: 0, awards: [] };
        g.total += a.amount;
        g.awards.push({ ...a, posted: true, postedAt: now });
        byChar.set(a.characterId, g);
    }
    return [...byChar.values()];
}
