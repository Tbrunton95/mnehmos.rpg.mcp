import Database from 'better-sqlite3';
import { migrate } from '../../src/storage/migrations.js';
import { runDataMigrations } from '../../src/storage/data-migrations.js';
import { handleSessionManage } from '../../src/server/consolidated/session-manage.js';
import { CHANGELOG } from '../../src/data/changelog.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Field report: a mid-campaign overhaul should upgrade old rows instead of
 * leaving them half-compatible, and the engine should say at session start
 * what changed (outcome went unused for a whole fight because nothing said
 * it had arrived).
 */
describe('data migrations', () => {
    it("move old 'crippled:<limb>' conditions to parts, once", () => {
        const db = new Database(':memory:');
        migrate(db);
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO characters (id, name, stats, hp, max_hp, ac, level, conditions, created_at, updated_at)
                    VALUES ('k', 'Karanak', '{}', 10, 10, 10, 1, ?, ?, ?)`)
            .run(JSON.stringify([{ name: 'crippled:leg', source: 'called strike: Luciel' }, { name: 'Oath: sworn' }]), now, now);
        // Pretend this database predates the migration.
        db.prepare('DELETE FROM data_migrations').run();
        const applied = runDataMigrations(db);
        expect(applied.map(a => a.id)).toContain('2026-09-24-crippled-conditions-to-parts');
        const row = db.prepare("SELECT conditions, parts FROM characters WHERE id = 'k'").get() as { conditions: string; parts: string };
        expect(JSON.parse(row.conditions)).toEqual([{ name: 'Oath: sworn' }]);
        expect(JSON.parse(row.parts)).toEqual([{ name: 'leg', kind: 'leg', state: 'crippled', note: 'called strike: Luciel' }]);
        expect(runDataMigrations(db)).toEqual([]);
    });
});

describe('changelog at session start', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('shows what is new once, then only when asked for all', async () => {
        const first = (await handleSessionManage({ action: 'get_context' }, { sessionId: 'c' } as any)).content[0].text;
        expect(first).toMatch(/What's new in the engine/);
        expect(first).toMatch(/Post a result you rolled at the table/);
        const second = (await handleSessionManage({ action: 'get_context' }, { sessionId: 'c' } as any)).content[0].text;
        expect(second).not.toMatch(/What's new in the engine/);
        const all = (await handleSessionManage({ action: 'changelog', all: true }, { sessionId: 'c' } as any)).content[0].text;
        expect(all.match(/^• /gm)?.length).toBe(CHANGELOG.length);
    });
});
