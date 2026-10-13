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
                { name: 'Oath of the Ninth: sworn', source: 'sworn before Karanak' }
            ],
            createdAt: now, updatedAt: now
        } as any);
    });
    afterEach(() => closeDb());

    /**
     * Play report 5 #10: a replace whose find sat in the condition's source
     * was refused with "is not in the matched condition" and no way forward.
     * The refusal now says where the text is and prints the call that hits.
     */
    describe('editConditions find misses say where the text is (play report 5 #10)', () => {
        const conditionsOf = () => JSON.stringify(repo.findById('luciel')!.conditions);

        it('find present in the source, not the name: prints the replaceSource call with the caller\'s match and with', async () => {
            const before = conditionsOf();
            const res = await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'oath', replace: { find: 'Karanak', with: 'the Mouth' } }] }, ctx as any);
            const r = json(res);
            expect(r.error).toBe(true);
            expect(r.writes).toBe('none');
            expect(r.message).toMatch(/'Karanak' is not in the name of 'Oath of the Ninth: sworn' but is in its source/);
            expect(r.message).toContain('replaceSource: {find: "Karanak", with: "the Mouth"}');
            expect(r.message).toContain('match: "oath"');
            expect(r.message).toMatch(/Nothing was written/);
            expect(conditionsOf()).toBe(before);
        });

        it('replaceSource find present only in the name: suggests replace', async () => {
            const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'oath', replaceSource: { find: 'Ninth', with: 'Tenth' } }] }, ctx as any));
            expect(r.error).toBe(true);
            expect(r.writes).toBe('none');
            expect(r.message).toMatch(/'Ninth' is not in the source of 'Oath of the Ninth: sworn' but is in its name/);
            expect(r.message).toContain('replace: {find: "Ninth", with: "Tenth"}');
        });

        it('find in neither: lists the condition\'s name and source, clipped', async () => {
            const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'warp-burn', replace: { find: 'nope', with: 'x' } }] }, ctx as any));
            expect(r.error).toBe(true);
            expect(r.writes).toBe('none');
            expect(r.message).toMatch(/'nope' is not in the name of 'Warp-burn: Chaos-touched: .*' nor in its source/);
            expect(r.message).toMatch(/It holds: name 'Warp-burn: Chaos-touched: /);
            expect(r.message).toMatch(/source '\(none\)'/);
            expect(r.message.length).toBeLessThan(600);
        });

        it('a case-only mismatch says find is case-sensitive and shows the casing that is there', async () => {
            const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'oath', replace: { find: 'SWORN', with: 'broken' } }] }, ctx as any));
            expect(r.error).toBe(true);
            expect(r.message).toMatch(/'SWORN' is not in the name of 'Oath of the Ninth: sworn' as written; 'sworn' is \(find is case-sensitive\)/);
            expect(repo.findById('luciel')!.conditions!.map(c => c.name)).toContain('Oath of the Ninth: sworn');
        });

        it('a match that hits no name but one source names that condition', async () => {
            const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'before Karanak', pinned: true }] }, ctx as any));
            expect(r.error).toBe(true);
            expect(r.writes).toBe('none');
            expect(r.message).toMatch(/'before Karanak' matches no condition name, but it is in the source of 'Oath of the Ninth: sworn'/);
            expect(r.message).toContain('{match: "Oath of the Ninth: sworn"}');
        });

        it('a refused edit writes nothing even when the call also carries a raw-column field', async () => {
            const db = getDb();
            const before = conditionsOf();
            const gold = () => (db.prepare('SELECT currency FROM characters WHERE id = ?').get('luciel') as { currency: string | null }).currency;
            const goldBefore = gold();
            const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', startingGold: 99, editConditions: [{ match: 'oath', replace: { find: 'nope', with: 'x' } }] }, ctx as any));
            expect(r.error).toBe(true);
            expect(r.writes).toBe('none');
            expect(gold()).toBe(goldBefore);
            expect(gold() ?? '').not.toContain('99');
            expect(conditionsOf()).toBe(before);
        });

        it('edits apply in order, so a later miss describes the condition as the earlier edit left it, and nothing is written', async () => {
            const before = conditionsOf();
            const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [
                { match: 'oath', replace: { find: 'sworn', with: 'broken' } },
                { match: 'oath', replace: { find: 'sworn', with: 'x' } }
            ] }, ctx as any));
            expect(r.error).toBe(true);
            expect(r.message).toMatch(/'sworn' is not in the name of 'Oath of the Ninth: broken' but is in its source/);
            expect(conditionsOf()).toBe(before);
        });
    });

    describe('editConditions: several sources, the preview lane, a hand heal beside an edit (review of play report 5 #10)', () => {
        const conditionsOf = () => JSON.stringify(repo.findById('luciel')!.conditions);

        it('a match that hits no name but several sources names them all', async () => {
            repo.update('luciel', { conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' }, { name: 'Oath of the Ninth: sworn' }] } as any);
            const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'dying', pinned: true }] }, ctx as any));
            expect(r.error).toBe(true);
            expect(r.writes).toBe('none');
            expect(r.message).toMatch(/'dying' matches no condition name, but it is in the source of 2 conditions: 'Unconscious', 'Prone'; match on the name instead, e.g. \{match: "Unconscious"\}\. Nothing was written/);
            expect(repo.findById('luciel')!.conditions!.every(c => !c.pinned)).toBe(true);
        });

        it('preview refuses a bad edit the way the write would, and a good preview shows the resulting conditions with nothing written', async () => {
            const before = conditionsOf();
            const bad = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', preview: true, editConditions: [{ match: 'oath', replace: { find: 'Karanak', with: 'the Mouth' } }] }, ctx as any));
            expect(bad.error).toBe(true);
            expect(bad.writes).toBe('none');
            expect(bad.message).toMatch(/'Karanak' is not in the name of 'Oath of the Ninth: sworn' but is in its source/);
            const good = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', preview: true, editConditions: [{ match: 'oath', replaceSource: { find: 'Karanak', with: 'the Mouth' } }] }, ctx as any));
            expect(good.preview).toBe(true);
            expect(good.success).toBe(true);
            expect(good.wouldChange.conditions.from.find((c: any) => c.name === 'Oath of the Ninth: sworn').source).toBe('sworn before Karanak');
            expect(good.wouldChange.conditions.to.find((c: any) => c.name === 'Oath of the Ninth: sworn').source).toBe('sworn before the Mouth');
            expect(conditionsOf()).toBe(before);
        });

        describe('a hand heal above 0 (play report 5 #5) beside condition edits', () => {
            const downed = () => repo.update('luciel', { hp: 0, conditions: [
                { name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' },
                { name: 'Oath of the Ninth: sworn', source: 'sworn before Karanak' }
            ] } as any);

            it('update {hp} above 0 alone takes the dying conditions off and says so', async () => {
                downed();
                const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', hp: 5 }, ctx as any));
                expect(r.success).toBe(true);
                expect(r.conditions.map((c: any) => c.name)).toEqual(['Oath of the Ninth: sworn']);
                expect(r.message).toMatch(/healed above 0: Unconscious, Prone \(dying\) came off/);
                expect(repo.findById('luciel')!.hp).toBe(5);
            });

            it('with editConditions in the same call the edit lands and the dying conditions still come off', async () => {
                downed();
                const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', hp: 5, editConditions: [{ match: 'oath', replaceSource: { find: 'Karanak', with: 'the Mouth' } }] }, ctx as any));
                expect(r.success).toBe(true);
                expect(r.conditions).toEqual([{ name: 'Oath of the Ninth: sworn', source: 'sworn before the Mouth' }]);
                expect(r.message).toMatch(/Unconscious, Prone \(dying\) came off/);
                expect(repo.findById('luciel')!.conditions!.map(c => c.name)).toEqual(['Oath of the Ninth: sworn']);
            });

            it('with addConditions / removeConditions in the same call the same holds', async () => {
                downed();
                const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', hp: 5, removeConditions: ['Oath of the Ninth: sworn'], addConditions: [{ name: 'Winded', duration: 1 }] }, ctx as any));
                expect(r.success).toBe(true);
                expect(r.conditions.map((c: any) => c.name)).toEqual(['Winded']);
            });

            it('a refused edit beside the heal writes nothing: hp stays 0 and the dying conditions stay', async () => {
                downed();
                const before = conditionsOf();
                const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', hp: 5, editConditions: [{ match: 'oath', replace: { find: 'Karanak', with: 'x' } }] }, ctx as any));
                expect(r.error).toBe(true);
                expect(r.writes).toBe('none');
                expect(repo.findById('luciel')!.hp).toBe(0);
                expect(conditionsOf()).toBe(before);
            });

            it('conditions set whole beside the heal is kept as given: the caller owns the list', async () => {
                downed();
                const r = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', hp: 5, conditions: [{ name: 'Prone', source: 'dying' }] }, ctx as any));
                expect(r.success).toBe(true);
                expect(r.conditions).toEqual([{ name: 'Prone', source: 'dying' }]);
                expect(r.message).not.toMatch(/came off/);
            });
        });
    });

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
