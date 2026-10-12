import Database from 'better-sqlite3';
import { migrate } from '../../src/storage/migrations.js';
import { runDataMigrations, DAY_366_PRINCIPLE_TEXT_MIGRATION_ID, DAY_366_OLD_PRINCIPLE_TEXTS } from '../../src/storage/data-migrations.js';
import { DAY_366_PRESET } from '../../src/data/table-rules/day-366.js';

/**
 * Play report 2, item 11: the day-366 preset named a table character
 * ('Luciel') and its setting's units ('Scions') in shared, importable
 * principle text. Worlds that already imported it keep the old text until
 * this migration rewrites it — ONLY where the stored text still equals the
 * old preset text byte for byte. A GM's rewrite is never touched.
 */
const principle = (name: string) => String((DAY_366_PRESET.find(e => e.kind === 'principle' && e.name === name)!.spec as { text: string }).text);

describe('day-366 principle text migration', () => {
    let db: Database.Database;
    const insert = (id: string, worldId: string, name: string, text: string) =>
        db.prepare("INSERT INTO table_rules (id, world_id, kind, name, spec, enabled, created_at, updated_at) VALUES (?, ?, 'principle', ?, ?, 1, '2026-10-01', '2026-10-01')")
            .run(id, worldId, name, JSON.stringify({ text }));
    const text = (id: string) => JSON.parse((db.prepare('SELECT spec FROM table_rules WHERE id = ?').get(id) as { spec: string }).spec).text as string;

    beforeEach(() => {
        db = new Database(':memory:');
        migrate(db);
        db.prepare('DELETE FROM data_migrations WHERE id = ?').run(DAY_366_PRINCIPLE_TEXT_MIGRATION_ID);
    });
    afterEach(() => db.close());

    it('the shipped preset names no table character and no setting unit', () => {
        for (const p of DAY_366_PRESET.filter(e => e.kind === 'principle')) {
            expect(String((p.spec as { text: string }).text)).not.toMatch(/Luciel|Scions/);
        }
        expect(principle('character-fantasy')).toMatch(/^The player character is a top-band warlord/);
        expect(principle('npcs-are-characters')).toMatch(/grading the player characters\.$/);
        expect(principle('mortal-units')).toMatch(/healthy units 3d6-4d6/);
        // The old texts the migration looks for are the ones that named them.
        expect(DAY_366_OLD_PRINCIPLE_TEXTS['character-fantasy']).toMatch(/^Luciel is an Astartes-scale warlord/);
        expect(DAY_366_OLD_PRINCIPLE_TEXTS['npcs-are-characters']).toMatch(/grading Luciel\.$/);
        expect(DAY_366_OLD_PRINCIPLE_TEXTS['mortal-units']).toMatch(/healthy Scions 3d6-4d6/);
    });

    it('rewrites a stored text only where it still equals the old preset text, and runs once', () => {
        insert('cf-old', 'w1', 'character-fantasy', 'Luciel is an Astartes-scale warlord who dominates ordinary mortals physically. Peer transhumans are serious fights capable of maiming him. Chaos offers genuine shortcuts to power that become increasingly difficult to refuse. If a mechanic repeatedly contradicts these, change the mechanic.');
        insert('npc-old', 'w1', 'npcs-are-characters', 'NPCs are characters, not consultants; no conscience chorus; no italic thoughts grading Luciel.');
        insert('mu-old', 'w1', 'mortal-units', DAY_366_OLD_PRINCIPLE_TEXTS['mortal-units']);
        insert('cf-edited', 'w2', 'character-fantasy', 'Luciel is an Astartes-scale warlord who dominates ordinary mortals physically. Peers maim him. Chaos tempts.');
        insert('other', 'w2', 'cleave', 'Cleave through packed lower-band targets in a plausible arc; spacing prevents it; never on peers.');

        const applied = runDataMigrations(db);
        const mine = applied.find(a => a.id === DAY_366_PRINCIPLE_TEXT_MIGRATION_ID)!;
        expect(mine.detail).toBe('3 principle text(s) generalised: character-fantasy, npcs-are-characters, mortal-units');
        expect(text('cf-old')).toBe(principle('character-fantasy'));
        expect(text('npc-old')).toBe(principle('npcs-are-characters'));
        expect(text('mu-old')).toBe(principle('mortal-units'));
        expect(text('cf-edited')).toMatch(/^Luciel is an Astartes-scale warlord who dominates ordinary mortals physically\. Peers maim him\./);
        expect(text('other')).toMatch(/^Cleave through/);
        expect(runDataMigrations(db)).toEqual([]);
    });
});
