import { handleCharacterManage } from '../../../src/server/consolidated/character-manage.js';
import { summarizeResult } from '../../../src/server/output-mode.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const ctx = { sessionId: 'lean' };
const json = (res: any) => JSON.parse(res.content[0].text.match(/<!-- CHARACTER_MANAGE_JSON\n([\s\S]*?)\nCHARACTER_MANAGE_JSON -->/)![1]);
const LONG = 'Chaos-touched: '.padEnd(4000, 'the Mouth whispers. ');

/**
 * Field report: every character_manage update echoed the whole sheet (about
 * 40 KB of conditions), and changing one condition meant removing and
 * re-adding its full text.
 */
describe('lean character updates', () => {
    let repo: CharacterRepository;
    beforeEach(() => {
        closeDb();
        repo = new CharacterRepository(getDb(':memory:'));
        const now = new Date().toISOString();
        repo.create({
            id: 'luciel', name: 'Luciel', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 },
            hp: 200, maxHp: 200, ac: 20, level: 15,
            conditions: [
                { name: `Broken jaw (Karanak): ${LONG}` },
                { name: `Warp-burn: ${LONG}` },
                { name: 'Oath of the Ninth: sworn' }
            ],
            createdAt: now, updatedAt: now
        } as any);
    });
    afterEach(() => closeDb());

    it('editConditions replaces text inside one condition and keeps the rest', async () => {
        const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'oath of the ninth', replace: { find: 'sworn', with: 'broken' } }] }, ctx as any));
        expect(r.success).toBe(true);
        const conds = repo.findById('luciel')!.conditions!.map(c => c.name);
        expect(conds).toContain('Oath of the Ninth: broken');
        expect(conds).toHaveLength(3);
        expect(conds[0]).toBe(`Broken jaw (Karanak): ${LONG}`);
    });

    it('editConditions can rename outright and set duration/source', async () => {
        await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'Warp-burn', name: 'Warp-burn: healed to a scar', duration: 3, source: 'rest' }] }, ctx as any);
        const c = repo.findById('luciel')!.conditions!.find(c => c.name.startsWith('Warp-burn'))!;
        expect(c).toMatchObject({ name: 'Warp-burn: healed to a scar', duration: 3, source: 'rest' });
    });

    it('refuses an ambiguous or missing match and writes nothing', async () => {
        const before = JSON.stringify(repo.findById('luciel')!.conditions);
        const amb = await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'the Mouth', name: 'x' }] }, ctx as any);
        expect(amb.content[0].text).toMatch(/matches 2 conditions/);
        const none = await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'nothing like this', name: 'x' }] }, ctx as any);
        expect(none.content[0].text).toMatch(/matches no condition/);
        expect(JSON.stringify(repo.findById('luciel')!.conditions)).toBe(before);
    });

    it('update reports which fields changed', async () => {
        const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', hp: 150 }, ctx as any));
        expect(r.changed).toEqual(['hp']);
    });

    it('summary mode keeps the message and small fields and drops the big ones', async () => {
        const full = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', hp: 150 }, ctx as any));
        const s = summarizeResult(full);
        const text = JSON.stringify(s);
        expect(text.length).toBeLessThan(1500);
        expect(s.success).toBe(true);
        expect(s.hp).toBe(150);
        expect(s.changed).toEqual(['hp']);
        expect(s.conditions).toBe('[3 items]');
        expect(JSON.stringify(full).length).toBeGreaterThan(8000);
    });
});
