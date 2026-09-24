import Database from 'better-sqlite3';
import { migrate } from '../../src/storage/migrations.js';
import { RegionRepository } from '../../src/storage/repos/region.repo.js';

/**
 * Region rows used to carry two id formats: generation wrote
 * `${worldId}:region:${n}`, the old seed-restore path wrote `${worldId}:${n}`.
 * Campaign databases restored by the old path hold only the legacy form, with
 * nation ownership and territorial claims pointing at it, so the startup
 * migration has to move every reference along with the row.
 */
describe('legacy region id migration', () => {
    const W = 'world-pripyat-01-1786243224217';
    const now = '2026-08-09T03:13:45.645Z';
    let db: Database.Database;

    function insertRegion(id: string, owner: string | null = null, control = 0, worldId = W) {
        db.prepare(`
            INSERT INTO regions (id, world_id, name, type, center_x, center_y, color, owner_nation_id, control_level, created_at, updated_at)
            VALUES (?, ?, ?, 'wilderness', 0, 0, '#888888', ?, ?, ?, ?)
        `).run(id, worldId, `Region for ${id}`, owner, control, now, now);
    }

    function insertClaim(id: string, nationId: string, regionId: string) {
        db.prepare(`
            INSERT INTO territorial_claims (id, nation_id, region_id, claim_strength, justification, created_at)
            VALUES (?, ?, ?, 100, NULL, ?)
        `).run(id, nationId, regionId, now);
    }

    function regionIds(worldId = W): string[] {
        return (db.prepare('SELECT id FROM regions WHERE world_id = ? ORDER BY id').all(worldId) as Array<{ id: string }>)
            .map(row => row.id);
    }

    function ownership(regionId: string) {
        return db.prepare('SELECT owner_nation_id AS owner, control_level AS control FROM regions WHERE id = ?')
            .get(regionId) as { owner: string | null; control: number } | undefined;
    }

    function claims(): Array<{ id: string; nationId: string; regionId: string }> {
        return db.prepare('SELECT id, nation_id AS nationId, region_id AS regionId FROM territorial_claims ORDER BY id')
            .all() as Array<{ id: string; nationId: string; regionId: string }>;
    }

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        migrate(db);
        const insertWorld = db.prepare(`
            INSERT INTO worlds (id, name, seed, width, height, created_at, updated_at)
            VALUES (?, ?, 'pripyat-01', 40, 40, ?, ?)
        `);
        insertWorld.run(W, 'World (pripyat-01)', now, now);
        insertWorld.run('other-world', 'Other', now, now);
        const insertNation = db.prepare(`
            INSERT INTO nations (id, world_id, name, leader, ideology, created_at, updated_at)
            VALUES (?, ?, ?, 'Leader', 'autocracy', ?, ?)
        `);
        insertNation.run('duty', W, 'Duty', now, now);
        insertNation.run('monolith', W, 'Monolith', now, now);
    });

    afterEach(() => {
        db.close();
    });

    it('renames legacy rows to the generation format, carrying ownership and every reference', () => {
        insertRegion(`${W}:0`, 'duty', 10);
        insertRegion(`${W}:1`);
        insertRegion(`${W}:3`, 'monolith', 10);
        insertClaim('claim-duty', 'duty', `${W}:0`);
        insertClaim('claim-monolith', 'monolith', `${W}:3`);
        db.prepare(`
            INSERT INTO encounters (id, region_id, tokens, round, status, created_at, updated_at)
            VALUES ('enc-1', ?, '[]', 1, 'completed', ?, ?)
        `).run(`${W}:1`, now, now);
        db.prepare(`
            INSERT INTO structures (id, world_id, region_id, name, type, x, y, population, created_at, updated_at)
            VALUES ('rostok', ?, ?, 'Rostok', 'town', 5, 5, 100, ?, ?)
        `).run(W, `${W}:3`, now, now);
        db.prepare(`
            INSERT INTO corpses (id, character_id, character_name, character_type, world_id, region_id, state_updated_at, created_at, updated_at)
            VALUES ('corpse-1', 'char-1', 'Stalker', 'npc', ?, ?, ?, ?, ?)
        `).run(W, `${W}:1`, now, now, now);

        migrate(db);

        expect(regionIds()).toEqual([`${W}:region:0`, `${W}:region:1`, `${W}:region:3`]);
        expect(ownership(`${W}:region:0`)).toEqual({ owner: 'duty', control: 10 });
        expect(ownership(`${W}:region:3`)).toEqual({ owner: 'monolith', control: 10 });
        expect(claims()).toEqual([
            { id: 'claim-duty', nationId: 'duty', regionId: `${W}:region:0` },
            { id: 'claim-monolith', nationId: 'monolith', regionId: `${W}:region:3` },
        ]);
        expect(db.prepare("SELECT region_id AS r FROM encounters WHERE id = 'enc-1'").get()).toEqual({ r: `${W}:region:1` });
        expect(db.prepare("SELECT region_id AS r FROM structures WHERE id = 'rostok'").get()).toEqual({ r: `${W}:region:3` });
        expect(db.prepare("SELECT region_id AS r FROM corpses WHERE id = 'corpse-1'").get()).toEqual({ r: `${W}:region:1` });
    });

    it('changes nothing on a second run', () => {
        insertRegion(`${W}:0`, 'duty', 10);
        insertClaim('claim-duty', 'duty', `${W}:0`);

        migrate(db);
        const regionsAfterFirst = db.prepare('SELECT * FROM regions ORDER BY id').all();
        const claimsAfterFirst = claims();

        migrate(db);

        expect(db.prepare('SELECT * FROM regions ORDER BY id').all()).toEqual(regionsAfterFirst);
        expect(claims()).toEqual(claimsAfterFirst);
    });

    it('folds a legacy row into an existing generation row instead of keeping both', () => {
        // A world that already hit the bug: generation rows plus a second,
        // legacy set written by a later seed restore.
        insertRegion(`${W}:region:0`);
        insertRegion(`${W}:0`, 'duty', 10);
        insertClaim('claim-legacy-0', 'duty', `${W}:0`);

        insertRegion(`${W}:region:1`, 'monolith', 40);
        insertRegion(`${W}:1`, 'duty', 10);
        insertClaim('claim-canonical-1', 'monolith', `${W}:region:1`);
        insertClaim('claim-legacy-1-monolith', 'monolith', `${W}:1`);
        insertClaim('claim-legacy-1-duty', 'duty', `${W}:1`);

        migrate(db);

        expect(regionIds()).toEqual([`${W}:region:0`, `${W}:region:1`]);
        // The unowned generation row takes the legacy row's ownership...
        expect(ownership(`${W}:region:0`)).toEqual({ owner: 'duty', control: 10 });
        // ...but an owned one keeps its own.
        expect(ownership(`${W}:region:1`)).toEqual({ owner: 'monolith', control: 40 });
        // Claims follow the row; a nation never ends up claiming one region twice.
        expect(claims()).toEqual([
            { id: 'claim-canonical-1', nationId: 'monolith', regionId: `${W}:region:1` },
            { id: 'claim-legacy-0', nationId: 'duty', regionId: `${W}:region:0` },
            { id: 'claim-legacy-1-duty', nationId: 'duty', regionId: `${W}:region:1` },
        ]);
    });

    it('leaves ids that are not the legacy pattern alone', () => {
        insertRegion('region-1');
        insertRegion(`${W}:region:2`);
        insertRegion(`${W}:north`);
        insertRegion(`${W}:4b`);
        insertRegion('other-world:5', null, 0, W);

        migrate(db);

        expect(regionIds()).toEqual([`${W}:4b`, `${W}:north`, `${W}:region:2`, 'other-world:5', 'region-1'].sort());
    });

    it('still resolves a legacy id to the migrated row', () => {
        // Campaign notes and earlier tool output name the legacy form (the
        // pripyat session log lists `${worldId}:<n>` as the claimable ids).
        insertRegion(`${W}:5`, 'duty', 10);

        migrate(db);

        const repo = new RegionRepository(db);
        expect(repo.findById(`${W}:5`)?.id).toBe(`${W}:region:5`);
        expect(repo.findById(`${W}:region:5`)?.id).toBe(`${W}:region:5`);
        expect(repo.findById(`${W}:6`)).toBeNull();
    });
});
