import Database from 'better-sqlite3';
import { migrate } from '../../src/storage/migrations.js';
import { runDataMigrations, WORLD_SPELL_AREA_MIGRATION_ID } from '../../src/storage/data-migrations.js';
import { parseRuleSpec } from '../../src/engine/table-rules.js';
import { ORRUK_WAAAGH_PRESET } from '../../src/data/table-rules/orruk-waaagh.js';
import { SKAVEN_HORNED_RAT_PRESET } from '../../src/data/table-rules/skaven-horned-rat.js';

/**
 * Play report 7 follow-up (lane S): the owner named Foot of Gork, Green Puke
 * and Plague as areas, so the presets now carry area {shape, size}. Worlds
 * that imported a preset before keep the old spec until this migration adds
 * the same area, so they resolve per model by default (Blackcrown included).
 * It patches only a row of those three names whose stored spec has no area
 * key, in a world that holds another spell of the same preset: a spec the GM
 * already gave an area, a GM's own spell of that name (or any other spell)
 * is untouched.
 */
describe('world spell area migration', () => {
    let db: Database.Database;
    const presetSpec = (preset: typeof ORRUK_WAAAGH_PRESET, name: string) => {
        const { area: _area, ...rest } = preset.find(e => e.kind === 'spell' && e.name === name)!.spec as Record<string, unknown>;
        return rest;
    };
    const insert = (id: string, worldId: string, kind: string, name: string, spec: unknown) =>
        db.prepare('INSERT INTO table_rules (id, world_id, kind, name, spec, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, \'2026-10-01\', \'2026-10-01\')')
            .run(id, worldId, kind, name, typeof spec === 'string' ? spec : JSON.stringify(spec));
    const spec = (id: string) => JSON.parse((db.prepare('SELECT spec FROM table_rules WHERE id = ?').get(id) as { spec: string }).spec);
    const updatedAt = (id: string) => (db.prepare('SELECT updated_at FROM table_rules WHERE id = ?').get(id) as { updated_at: string }).updated_at;

    beforeEach(() => {
        db = new Database(':memory:');
        migrate(db);
        db.prepare('DELETE FROM data_migrations WHERE id = ?').run(WORLD_SPELL_AREA_MIGRATION_ID);
    });
    afterEach(() => db.close());

    it('adds the preset area to an imported row of the three names, leaves every other row alone, and runs once', () => {
        // Rows as an import before this change wrote them: no area key.
        insert('gork', 'blackcrown', 'spell', 'Foot of Gork', presetSpec(ORRUK_WAAAGH_PRESET, 'Foot of Gork'));
        insert('puke', 'blackcrown', 'spell', 'Green Puke', presetSpec(ORRUK_WAAAGH_PRESET, 'Green Puke'));
        insert('plague', 'blackcrown', 'spell', 'Plague', presetSpec(SKAVEN_HORNED_RAT_PRESET, 'Plague'));
        // A GM's edit that already gave an area keeps it.
        insert('plague-edited', 'w2', 'spell', 'Plague', { ...presetSpec(SKAVEN_HORNED_RAT_PRESET, 'Plague'), area: { shape: 'sphere', size: 40 } });
        // A row whose GM already settled it with an explicit null keeps that too.
        insert('puke-null', 'w3', 'spell', 'Green Puke', { ...presetSpec(ORRUK_WAAAGH_PRESET, 'Green Puke'), area: null });
        // Single-target spells and other names are never touched.
        insert('bolt', 'blackcrown', 'spell', 'Warp Lightning', presetSpec(SKAVEN_HORNED_RAT_PRESET, 'Warp Lightning'));
        insert('thirteen', 'blackcrown', 'spell', 'Dreaded Thirteenth Spell', presetSpec(SKAVEN_HORNED_RAT_PRESET, 'Dreaded Thirteenth Spell'));
        insert('lower', 'w4', 'spell', 'plague', { effects: [{ type: 'damage', dice: '1d6' }] });
        // The name on another kind is not a spell.
        insert('table', 'w5', 'roll_table', 'Plague', { entries: [{ weight: 1, text: 'cough' }] });
        // An unreadable spec is left as it is.
        insert('broken', 'w6', 'spell', 'Foot of Gork', '{not json');

        const applied = runDataMigrations(db);
        const mine = applied.find(a => a.id === WORLD_SPELL_AREA_MIGRATION_ID)!;
        expect(mine.detail).toBe('3 preset spell row(s) marked as areas: Foot of Gork (blackcrown), Green Puke (blackcrown), Plague (blackcrown)');

        expect(spec('gork').area).toEqual({ shape: 'cylinder', size: 20 });
        expect(spec('puke').area).toEqual({ shape: 'line', size: 30 });
        expect(spec('plague').area).toEqual({ shape: 'sphere', size: 20 });
        // The rest of the spec is untouched, and still parses.
        expect(spec('gork')).toMatchObject(presetSpec(ORRUK_WAAAGH_PRESET, 'Foot of Gork'));
        expect(parseRuleSpec('spell', spec('gork')).area).toEqual({ shape: 'cylinder', size: 20 });
        expect(updatedAt('gork')).not.toBe('2026-10-01');

        expect(spec('plague-edited').area).toEqual({ shape: 'sphere', size: 40 });
        expect(spec('puke-null').area).toBeNull();
        expect(spec('bolt')).not.toHaveProperty('area');
        expect(spec('thirteen')).not.toHaveProperty('area');
        expect(spec('lower')).not.toHaveProperty('area');
        expect(spec('table')).not.toHaveProperty('area');
        expect((db.prepare("SELECT spec FROM table_rules WHERE id = 'broken'").get() as { spec: string }).spec).toBe('{not json');
        expect(updatedAt('bolt')).toBe('2026-10-01');

        // Logged once, idempotent.
        expect(db.prepare('SELECT detail FROM data_migrations WHERE id = ?').get(WORLD_SPELL_AREA_MIGRATION_ID)).toEqual({ detail: mine.detail });
        expect(runDataMigrations(db)).toEqual([]);
    });

    it("leaves a GM's own spell of one of those names alone in a world that never imported the preset", () => {
        // Review (lane S): the names are generic ('Plague'), and a hosted
        // engine holds many worlds. A row is the preset's only where the world
        // also holds another spell that preset ships; a GM's lone single-target
        // Plague must not become a 20-ft sphere that hits every model of a unit.
        insert('own-plague', 'grimdark', 'spell', 'Plague', { effects: [{ type: 'damage', dice: '4d6', damageType: 'necrotic', save: { ability: 'con' }, saveEffect: 'half' }] });
        insert('own-stomp', 'grimdark', 'spell', 'Foot of Gork', { effects: [{ type: 'damage', dice: '1d6' }] });
        // Blackcrown imported the Skaven preset: its Plague sits beside Warp Lightning, and is marked.
        insert('plague', 'blackcrown', 'spell', 'Plague', presetSpec(SKAVEN_HORNED_RAT_PRESET, 'Plague'));
        insert('bolt', 'blackcrown', 'spell', 'Warp Lightning', presetSpec(SKAVEN_HORNED_RAT_PRESET, 'Warp Lightning'));
        // A tweaked preset row (dice raised) in a world that imported the preset is still the preset's.
        insert('gork', 'waaagh', 'spell', 'Foot of Gork', { ...presetSpec(ORRUK_WAAAGH_PRESET, 'Foot of Gork'), effects: [{ type: 'damage', dice: '5d6', damageType: 'bludgeoning', save: { ability: 'dex' }, saveEffect: 'half' }] });
        insert('mighty', 'waaagh', 'spell', 'Mighty Waaagh!', presetSpec(ORRUK_WAAAGH_PRESET, 'Mighty Waaagh!'));

        const mine = runDataMigrations(db).find(a => a.id === WORLD_SPELL_AREA_MIGRATION_ID)!;
        expect(spec('own-plague')).not.toHaveProperty('area');
        expect(spec('own-stomp')).not.toHaveProperty('area');
        expect(updatedAt('own-plague')).toBe('2026-10-01');
        expect(spec('plague').area).toEqual({ shape: 'sphere', size: 20 });
        expect(spec('gork').area).toEqual({ shape: 'cylinder', size: 20 });
        expect(spec('gork').effects[0].dice).toBe('5d6');
        expect(mine.detail).toBe('2 preset spell row(s) marked as areas: Foot of Gork (waaagh), Plague (blackcrown); 2 left alone (their world holds no other spell of the preset): Foot of Gork (grimdark), Plague (grimdark)');
    });

    it('says so when there is nothing to mark', () => {
        const applied = runDataMigrations(db);
        expect(applied.find(a => a.id === WORLD_SPELL_AREA_MIGRATION_ID)!.detail).toBe('no unmarked preset area spell found');
    });
});
