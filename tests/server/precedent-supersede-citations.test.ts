import { handlePrecedentManage, findCitations } from '../../src/server/consolidated/precedent-manage.js';
import { handleNarrativeManage } from '../../src/server/consolidated/narrative-manage.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

// Deep One audit request 4: when a ruling is overruled, the old id lives on
// in condition sources, notes and named items. supersede names every one.
const W = 'm42';
const ctx = { sessionId: 'cite' };
const tag = (res: any, t: string) => JSON.parse(res.content[0].text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`))![1]);
const prec = async (a: Record<string, unknown>) => tag(await handlePrecedentManage({ worldId: W, ...a }, ctx as any), 'PRECEDENT_MANAGE');
const narrative = async (a: Record<string, unknown>) => { const t = (await handleNarrativeManage(a, ctx as any)).content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };

let now: string;
beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Deep One', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    const chars = new CharacterRepository(db);
    const base = { characterType: 'pc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 20, ac: 12, level: 1, createdAt: now, updatedAt: now };
    chars.create({ ...base, id: 'wake', name: 'Wake' } as any);
    chars.create({ ...base, id: 'tesk', name: 'Tesk' } as any);
    db.prepare("INSERT INTO items (id, name, type, weight, value, created_at, updated_at) VALUES ('sword', 'Chainsword', 'weapon', 3, 10, ?, ?)").run(now, now);
});
afterEach(() => closeDb());

describe('precedent_manage supersede citations', () => {
    it('lists conditions (source and note), narrative notes and item custom names citing the old id, with a hint', async () => {
        const db = getDb();
        const chars = new CharacterRepository(db);
        const old = await prec({ action: 'record', kind: 'ruling', statement: 'Brine-bound: 1 fatigue per dry hour', scope: 'brine' });
        const oldId: string = old.precedent.precedentId;
        const other = await prec({ action: 'record', kind: 'ruling', statement: 'Unrelated', scope: 'other' });

        chars.update('wake', { conditions: [{ name: 'Brine-bound', source: `ruling ${oldId}` }, { name: 'Marked', source: `ruling ${other.precedent.precedentId}` }] } as any);
        // A note field on a condition survives in the JSON column even though the schema does not declare it.
        db.prepare('UPDATE characters SET conditions = ? WHERE id = ?').run(JSON.stringify([{ name: 'Dry', source: 'the desert', note: `per ${oldId.toUpperCase()}` }]), 'tesk');
        const note = await narrative({ action: 'add', worldId: W, type: 'plot_thread', content: `The Drowned Choir\nWake's thirst runs on ${oldId}.` });
        const noteId = note.noteId ?? note.id ?? note.note?.id;
        const bound = await narrative({ action: 'add', worldId: W, type: 'canonical_moment', content: `Tesk swore under ${oldId}`, entityType: 'character', entityId: 'tesk' });
        const boundId = bound.noteId ?? bound.id ?? bound.note?.id;
        await narrative({ action: 'add', worldId: W, type: 'session_log', content: 'Nothing cited here' });
        db.prepare("INSERT INTO item_instances (id, template_id, owner_character_id, attachments, custom_name, created_at, updated_at) VALUES ('inst-1', 'sword', 'wake', '{}', ?, ?, ?)").run(`Salt Blade (${oldId})`, now, now);
        db.prepare("INSERT INTO item_instances (id, template_id, owner_character_id, attachments, custom_name, created_at, updated_at) VALUES ('inst-2', 'sword', NULL, '{}', 'Plain sword', ?, ?)").run(now, now);

        const sup = await prec({ action: 'supersede', precedentId: oldId, statement: 'Brine-bound: 1 fatigue per dry hour, 2 in the Warp' });
        const newId: string = sup.precedent.precedentId;
        expect(sup.replaced.supersededBy).toBe(newId);
        expect(sup.citations).toHaveLength(5);
        expect(sup.citations).toEqual(expect.arrayContaining([
            { where: 'condition', characterId: 'wake', id: 'Brine-bound', text: `Brine-bound — ruling ${oldId}` },
            { where: 'condition', characterId: 'tesk', id: 'Dry', text: 'Dry — the desert' },
            { where: 'note', id: noteId, text: '[plot_thread] The Drowned Choir' },
            { where: 'note', characterId: 'tesk', id: boundId, text: `[canonical_moment] Tesk swore under ${oldId}` },
            { where: 'item', characterId: 'wake', id: 'inst-1', text: `Salt Blade (${oldId})` }
        ]));
        expect(sup.hint).toMatch(new RegExp(`5 citation\\(s\\) of ${oldId} remain`));
        expect(sup.hint).toMatch(new RegExp(`replaceSource: \\{find: "${oldId}", with: "${newId}"\\}`));
        expect(sup.message).toMatch(/5 citation\(s\) of the old id still stand/);
    });

    it('reports an empty list and no hint when nothing cites the old id', async () => {
        const old = await prec({ action: 'record', kind: 'invention', statement: 'Vigil holds overwatch at 4 km', scope: 'Vigil' });
        new CharacterRepository(getDb()).update('wake', { conditions: [{ name: 'Marked', source: 'the Choir' }] } as any);
        const sup = await prec({ action: 'supersede', precedentId: old.precedent.precedentId, statement: 'Vigil holds overwatch at 6 km' });
        expect(sup.citations).toEqual([]);
        expect(sup.hint).toBeUndefined();
        expect(sup.message).not.toMatch(/citation/);
    });

    it('findCitations survives a db without the optional tables', () => {
        const db = getDb();
        db.exec('DROP TABLE IF EXISTS item_instances');
        db.exec('DROP TABLE IF EXISTS narrative_notes');
        new CharacterRepository(db).update('wake', { conditions: [{ name: 'Brine-bound', source: 'ruling prec-0badcafe' }] } as any);
        expect(findCitations(db, 'prec-0badcafe')).toEqual([{ where: 'condition', characterId: 'wake', id: 'Brine-bound', text: 'Brine-bound — ruling prec-0badcafe' }]);
    });
});
