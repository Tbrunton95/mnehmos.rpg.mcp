import { handleCharacterManage } from '../../../src/server/consolidated/character-manage.js';
import { handleTableRules } from '../../../src/server/consolidated/table-rules.js';
import { handleKnowledgeManage } from '../../../src/server/consolidated/knowledge-manage.js';
import { handleSceneManage } from '../../../src/server/consolidated/scene-manage.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const ctx = { sessionId: 'house' };
const W = 'vorago';
const tagJson = (text: string) => JSON.parse(text.match(/<!-- CHARACTER_MANAGE_JSON\n([\s\S]*?)\nCHARACTER_MANAGE_JSON -->/)![1]);
const banner = (text: string) => text.split('<!--')[0].replace(/\n+$/, '\n');
const know = (a: Record<string, unknown>) => handleKnowledgeManage({ worldId: W, ...a }, ctx as any);
const block = async () => (await handleCharacterManage({ action: 'get_status_block', characterId: 'luciel' }, ctx as any)).content[0].text;

beforeEach(async () => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Vorago', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    new CharacterRepository(db).create({
        id: 'luciel', name: 'Luciel', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 },
        hp: 320, maxHp: 320, ac: 20, level: 15,
        resourcePools: { resolve: { current: 100, max: 100 } },
        conditions: [{ name: 'Old grant from day 12' }, { name: 'Warp-sight' }, { name: 'Oath of the Ninth', pinned: true }],
        createdAt: now, updatedAt: now
    } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare("UPDATE characters SET world_id = ? WHERE id = 'luciel'").run(W);
    await handleTableRules({ action: 'import', worldId: W, preset: 'day-366' }, ctx as any);
});
afterEach(() => closeDb());

describe('house-format status block', () => {
    it('renders the Luciel block from data: one COND line, no extras, and the footer', async () => {
        await know({ action: 'record', key: 'ithraes-true-name', statement: "Ithraes is Oszaverek's true name", knowers: [{ id: 'luciel', how: 'witnessed' }] });
        for (const q of [1, 2, 3, 4]) await know({ action: 'record', key: `vaurek-q${q}`, statement: `Vaurek quarter ${q}` });
        await know({ action: 'learn', key: 'vaurek-q1', knowerId: 'luciel', how: 'witnessed' });
        await know({ action: 'learn', key: 'vaurek-q3', knowerId: 'luciel', how: 'deduced' });
        await handleSceneManage({ action: 'set', worldId: W, placeLabel: 'Leaving the Realm of Khorne', narration: 'The brass sky thins.', engineState: { pull: 'green, damp, slow' }, participants: ['luciel'] }, ctx as any);
        await handleTableRules({ action: 'define', worldId: W, kind: 'status_block', name: 'tiny-status', spec: {
            corePool: 'resolve', conditionLayout: 'line', showMore: false, showLocation: false, showObjective: false,
            footer: ['knows:ithraes', 'knows:vaurek', 'scene.place', 'scene.pull']
        } }, ctx as any);

        const text = await block();
        expect(banner(text)).toBe([
            '╓─ +++ ─── LUCIEL ───────────────────╖',
            '▌ HP 320/320 · RESOLVE 100/100',
            '▌ COND Oath of the Ninth · Warp-sight',
            '╙────────────────────────────────────╜',
            'Ithraes · Vaurek (2 of 4) · Leaving the Realm of Khorne · Pull: green, damp, slow',
            ''
        ].join('\n'));
        const data = tagJson(text);
        expect(data.footer).toEqual(['Ithraes', 'Vaurek (2 of 4)', 'Leaving the Realm of Khorne', 'Pull: green, damp, slow']);
        expect(data.conditionLayout).toBe('line');
        expect(data.moreConditions).toBe(1);
    });

    it('a footer segment with nothing behind it is left out, and a label can be given', async () => {
        await handleTableRules({ action: 'define', worldId: W, kind: 'status_block', name: 'tiny-status', spec: {
            footer: ['knows:vaurek', 'scene.place', 'scene.pull', 'location', 'objective', 'knows:ithraes|The True Name', 'Day 367']
        } }, ctx as any);
        await know({ action: 'record', key: 'ithraes', statement: 'x' });
        const data = tagJson(await block());
        expect(data.footer).toEqual(['The True Name (0 of 1)', 'Day 367']);
    });

    it('the defaults still render the rows layout with +N more', async () => {
        const text = banner(await block());
        expect(text).toMatch(/▌ Oath of the Ninth\n▌ Warp-sight\n▌ \+1 more\n/);
        expect(tagJson(await block()).footer).toBeUndefined();
    });
});
