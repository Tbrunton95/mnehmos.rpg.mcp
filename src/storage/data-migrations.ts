/**
 * One-time data upgrades. Schema migrations add tables and columns; these
 * rewrite old rows into new shapes (a mid-campaign overhaul upgrades what is
 * already there instead of leaving it half-compatible). Each runs once per
 * database and is recorded in data_migrations.
 */
import type Database from 'better-sqlite3';

export interface DataMigration {
    id: string;
    description: string;
    run(db: Database.Database): string;
}

const CRIPPLE = /^crippled:(leg|arm|wing|head)$/i;

export const DATA_MIGRATIONS: DataMigration[] = [
    {
        id: '2026-09-24-crippled-conditions-to-parts',
        description: "Called strikes now cripple a named part: old 'crippled:<limb>' character conditions become crippled parts",
        run(db) {
            const cols = db.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>;
            if (!cols.some(c => c.name === 'parts')) return 'no parts column';
            const rows = db.prepare("SELECT id, conditions, parts FROM characters WHERE conditions LIKE '%crippled:%'").all() as Array<{ id: string; conditions: string | null; parts: string | null }>;
            const write = db.prepare('UPDATE characters SET conditions = ?, parts = ? WHERE id = ?');
            let moved = 0;
            for (const r of rows) {
                const conds = JSON.parse(r.conditions || '[]') as Array<{ name: string; source?: string }>;
                const parts = JSON.parse(r.parts || '[]') as Array<{ name: string; kind: string; state: string; note?: string }>;
                const keep = conds.filter(c => {
                    const m = String(c.name ?? '').match(CRIPPLE);
                    if (!m) return true;
                    const limb = m[1].toLowerCase();
                    if (!parts.some(p => p.name.toLowerCase() === limb)) parts.push({ name: limb, kind: limb, state: 'crippled', note: c.source ?? 'called strike (migrated)' });
                    moved++;
                    return false;
                });
                write.run(JSON.stringify(keep), JSON.stringify(parts), r.id);
            }
            return `${moved} condition(s) moved to parts`;
        }
    }
];

export function ensureMetaTables(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS data_migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL,
            detail TEXT
        );
        CREATE TABLE IF NOT EXISTS engine_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);
}

/** Run every data migration this database has not had yet, each in its own transaction. */
export function runDataMigrations(db: Database.Database): Array<{ id: string; detail: string }> {
    ensureMetaTables(db);
    const done = new Set((db.prepare('SELECT id FROM data_migrations').all() as Array<{ id: string }>).map(r => r.id));
    const applied: Array<{ id: string; detail: string }> = [];
    for (const m of DATA_MIGRATIONS) {
        if (done.has(m.id)) continue;
        db.transaction(() => {
            const detail = m.run(db);
            db.prepare('INSERT INTO data_migrations (id, applied_at, detail) VALUES (?, ?, ?)').run(m.id, new Date().toISOString(), detail);
            applied.push({ id: m.id, detail });
        })();
        console.error(`[Migration] Data: ${m.id}: ${applied[applied.length - 1]?.detail}`);
    }
    return applied;
}

export function getMeta(db: Database.Database, key: string): string | null {
    ensureMetaTables(db);
    return (db.prepare('SELECT value FROM engine_meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value ?? null;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
    ensureMetaTables(db);
    db.prepare('INSERT INTO engine_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
