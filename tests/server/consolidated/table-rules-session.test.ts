import { handleCharacterManage } from '../../../src/server/consolidated/character-manage.js';
import { handleSessionManage } from '../../../src/server/consolidated/session-manage.js';
import { handleTableRules } from '../../../src/server/consolidated/table-rules.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const ctx = { sessionId: 'rules-session' };
const W = 'world-40k';
const tagJson = (text: string, tag: string) => JSON.parse(text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`))![1]);

describe('milestone XP, tiny status, principles at boot', () => {
    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Vorago', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        new CharacterRepository(db).create({
            id: 'luciel', name: 'Luciel', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 },
            hp: 150, maxHp: 200, ac: 20, level: 1, xp: 0,
            resourcePools: { corruption: { current: 7, max: 100 }, warp: { current: 3, max: 10 } },
            conditions: [{ name: 'bleeding' }, { name: 'shaken' }, { name: 'marked' }],
            createdAt: now, updatedAt: now
        } as any);
        try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
        db.prepare("UPDATE characters SET world_id = ? WHERE id = 'luciel'").run(W);
    });
    afterEach(() => closeDb());

    const importDay366 = () => handleTableRules({ action: 'import', worldId: W, preset: 'day-366' }, ctx as any);

    it('XP offers a level-up without the rule, and never under milestone progression', async () => {
        const plain = tagJson((await handleCharacterManage({ action: 'add_xp', characterId: 'luciel', amount: 1000 }, ctx as any)).content[0].text, 'CHARACTER_MANAGE');
        expect(plain.canLevelUp).toBe(true);
        await importDay366();
        const milestone = tagJson((await handleCharacterManage({ action: 'add_xp', characterId: 'luciel', amount: 1000 }, ctx as any)).content[0].text, 'CHARACTER_MANAGE');
        expect(milestone.canLevelUp).toBe(false);
        expect(milestone.message).toMatch(/Milestone progression/);
    });

    it('the tiny status block shows HP, the named core pool and two conditions', async () => {
        await importDay366();
        await handleTableRules({ action: 'define', worldId: W, kind: 'status_block', name: 'tiny-status', spec: { corePool: 'corruption' } }, ctx as any);
        const res = (await handleCharacterManage({ action: 'get_status_block', characterId: 'luciel' }, ctx as any)).content[0].text;
        expect(res).toMatch(/150\/200/);
        expect(res).toMatch(/CORRUPTION/);
        expect(res).toMatch(/7\/100/);
        // Newest first: the last two on the sheet, then the count of the rest.
        expect(res).toMatch(/marked/);
        expect(res).toMatch(/shaken/);
        expect(res).toMatch(/\+1/);
        expect(res).not.toMatch(/bleeding/);
        // Only the named pool is shown.
        expect(res).not.toMatch(/WARP/i);
    });

    it('the core pool matches its stored key whatever the case', async () => {
        await importDay366();
        await handleTableRules({ action: 'define', worldId: W, kind: 'status_block', name: 'tiny-status', spec: { corePool: 'CORRUPTION' } }, ctx as any);
        const block = tagJson((await handleCharacterManage({ action: 'get_status_block', characterId: 'luciel' }, ctx as any)).content[0].text, 'CHARACTER_MANAGE');
        expect(block.corePool).toMatchObject({ name: 'corruption', current: 7, max: 100 });
        const boot = tagJson((await handleSessionManage({ action: 'boot', worldId: W }, ctx as any)).content[0].text, 'SESSION_MANAGE');
        expect(boot.characters[0].corruption).toBe('7/100');
    });

    it('defining a core pool no character has warns and still saves', async () => {
        const res = tagJson((await handleTableRules({ action: 'define', worldId: W, kind: 'status_block', name: 'tiny-status', spec: { corePool: 'resolve' } }, ctx as any)).content[0].text, 'TABLE_RULES');
        expect(res.success).toBe(true);
        expect(res.warning).toMatch(/no character in this world has pool 'resolve'/);
        const known = tagJson((await handleTableRules({ action: 'define', worldId: W, kind: 'status_block', name: 'tiny-status', spec: { corePool: 'Warp' } }, ctx as any)).content[0].text, 'TABLE_RULES');
        expect(known.warning).toBeUndefined();
    });

    it('a pinned condition leads the tiny block, then the newest', async () => {
        await importDay366();
        await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'bleeding', pinned: true }] }, ctx as any);
        const block = tagJson((await handleCharacterManage({ action: 'get_status_block', characterId: 'luciel' }, ctx as any)).content[0].text, 'CHARACTER_MANAGE');
        expect(block.conditions.map((c: { name: string }) => c.name)).toEqual(['bleeding', 'marked']);
        const boot = tagJson((await handleSessionManage({ action: 'boot', worldId: W }, ctx as any)).content[0].text, 'SESSION_MANAGE');
        expect(boot.characters[0].conditions.first).toEqual(['bleeding', 'marked', 'shaken']);
    });

    it('editConditions replaceSource edits the source text in place', async () => {
        await handleCharacterManage({ action: 'update', characterId: 'luciel', addConditions: [{ name: 'Day 366 reset', source: 'Luciel is an Astartes-scale warlord.' }] }, ctx as any);
        await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'day 366', replaceSource: { find: 'an Astartes-scale warlord', with: 'the Unclaimed Prince' } }] }, ctx as any);
        const got = tagJson((await handleCharacterManage({ action: 'get', characterId: 'luciel' }, ctx as any)).content[0].text, 'CHARACTER_MANAGE');
        expect(got.conditions.find((c: { name: string }) => c.name === 'Day 366 reset').source).toBe('Luciel is the Unclaimed Prince.');
        const miss = (await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'day 366', replaceSource: { find: 'Primarch', with: 'x' } }] }, ctx as any)).content[0].text;
        expect(miss).toMatch(/not in the matched condition's source\. Nothing was written/);
    });

    it('the header strip has no empty segments without a clock', async () => {
        await importDay366();
        const res = (await handleCharacterManage({ action: 'get_status_block', characterId: 'luciel' }, ctx as any)).content[0].text;
        expect(res).toMatch(/╓─ \+\+\+ ─── LUCIEL ──╖/);
    });

    it('get_context lists the enforced rules and the principles', async () => {
        await importDay366();
        const text = (await handleSessionManage({ action: 'get_context', worldId: W }, ctx as any)).content[0].text;
        expect(text).toMatch(/Table Rules/);
        expect(text).toMatch(/measure-of-a-body \[called_strike\]/);
        expect(text).toMatch(/Chaos pays first/);
    });
});
