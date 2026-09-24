import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrate } from '../../src/storage/migrations.js';

// Claude Desktop starts two server processes against one rpg.db. Both used
// to see "cost column missing" and both ALTERed; the loser crashed with
// "duplicate column name". migrate() now holds the write lock for the pass.
describe('migrate() write lock', () => {
    let dir: string;
    const open: Database.Database[] = [];
    const conn = (path: string, timeoutMs: number) => {
        const db = new Database(path);
        db.pragma('journal_mode = WAL');
        db.pragma(`busy_timeout = ${timeoutMs}`);
        open.push(db);
        return db;
    };

    afterEach(() => {
        for (const db of open.splice(0)) db.close();
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('waits for another writer instead of migrating around it', () => {
        dir = mkdtempSync(join(tmpdir(), 'mig-lock-'));
        const path = join(dir, 'rpg.db');
        const holder = conn(path, 0);
        const other = conn(path, 50);

        holder.exec('BEGIN IMMEDIATE');
        expect(() => migrate(other)).toThrow(/busy|locked/i);
        // Nothing half-applied while the lock was held.
        expect(other.prepare("SELECT name FROM sqlite_master WHERE name = 'characters'").get()).toBeUndefined();
        holder.exec('COMMIT');

        migrate(other);
        migrate(holder);
        const cols = (holder.prepare('PRAGMA table_info(custom_effects)').all() as { name: string }[]).map(c => c.name);
        expect(cols.filter(c => c === 'cost')).toHaveLength(1);
    });

    it('is safe to run inside a caller-owned transaction', () => {
        const db = new Database(':memory:');
        open.push(db);
        db.transaction(() => migrate(db))();
        expect(() => migrate(db)).not.toThrow();
    });
});
