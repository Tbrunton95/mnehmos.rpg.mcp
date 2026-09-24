import { handleRestManage } from '../../../src/server/consolidated/rest-manage.js';
import { getCombatManager } from '../../../src/server/state/combat-manager.js';
import { CombatEngine } from '../../../src/engine/combat/engine.js';
import { getDb, closeDb } from '../../../src/storage/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';

/**
 * Audit: short rests always rolled d8 whatever the class, never tracked how
 * many hit dice were left (a character could spend 20 every hour), and the
 * "in combat" check looked at every session's encounters.
 */
describe('short rest hit dice', () => {
    let repo: CharacterRepository;
    const ctx = { sessionId: 'rest-a' };

    beforeEach(() => {
        closeDb();
        repo = new CharacterRepository(getDb(':memory:'));
        getCombatManager().clear();
        const now = new Date().toISOString();
        repo.create({
            id: 'fighter', name: 'Veteran', characterType: 'pc', characterClass: 'fighter',
            level: 5, hp: 1, maxHp: 200, ac: 16,
            stats: { str: 16, dex: 14, con: 10, int: 10, wis: 12, cha: 8 },
            createdAt: now, updatedAt: now
        } as any);
    });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); getCombatManager().clear(); });

    const rest = async (args: Record<string, unknown>, c: object = ctx) =>
        JSON.parse((await handleRestManage({ characterId: 'fighter', ...args }, c as any)).content[0].text);

    it('rolls the class hit die', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.99);
        const r = await rest({ action: 'short', hitDiceToSpend: 2 });
        expect(r.hitDieSize).toBe('d10');
        expect(r.rolls).toEqual([10, 10]);
        expect(r.hpRestored).toBe(20);
    });

    it('tracks the dice left and cannot spend more than remain', async () => {
        const first = await rest({ action: 'short', hitDiceToSpend: 3 });
        expect(first.hitDiceSpent).toBe(3);
        expect(first.hitDiceRemaining).toBe(2);
        const second = await rest({ action: 'short', hitDiceToSpend: 5 });
        expect(second.hitDiceSpent).toBe(2);
        expect(second.hitDiceRemaining).toBe(0);
        const third = await rest({ action: 'short', hitDiceToSpend: 1 });
        expect(third.hitDiceSpent).toBe(0);
        expect(third.hpRestored).toBe(0);
        expect(repo.findById('fighter')!.resourcePools?.hit_dice).toMatchObject({ current: 0, max: 5 });
    });

    it('a long rest regains half the level in hit dice', async () => {
        await rest({ action: 'short', hitDiceToSpend: 5 });
        const long = await rest({ action: 'long' });
        expect(long.hitDiceRegained).toBe(2);
        expect(repo.findById('fighter')!.resourcePools?.hit_dice).toMatchObject({ current: 2, max: 5 });
    });

    it('only this session\'s encounters block a rest', async () => {
        const engine = new CombatEngine('enc-other');
        engine.startEncounter([{ id: 'fighter', name: 'Veteran', initiativeBonus: 0, hp: 1, maxHp: 200, conditions: [] }] as any);
        getCombatManager().create('rest-b:enc-other', engine);
        const r = await rest({ action: 'short', hitDiceToSpend: 1 });
        expect(r.restType).toBe('short');

        const own = new CombatEngine('enc-own');
        own.startEncounter([{ id: 'fighter', name: 'Veteran', initiativeBonus: 0, hp: 1, maxHp: 200, conditions: [] }] as any);
        getCombatManager().create('rest-a:enc-own', own);
        const refused = (await handleRestManage({ action: 'short', characterId: 'fighter' }, ctx as any)).content[0].text;
        expect(refused).toMatch(/Cannot rest while in combat/);
        expect(refused).not.toMatch(/enc-other/);
    });
});

describe('ending an encounter clears stale engines in the same session only', () => {
    it('deleteEncountersForCharacter respects the session', () => {
        const m = getCombatManager();
        m.clear();
        for (const key of ['s1:a', 's2:b']) {
            const e = new CombatEngine(key);
            e.startEncounter([{ id: 'x', name: 'X', initiativeBonus: 0, hp: 1, maxHp: 1, conditions: [] }] as any);
            m.create(key, e);
        }
        expect(m.deleteEncountersForCharacter('x', 's1')).toBe(1);
        expect(m.get('s2:b')).not.toBeNull();
        m.clear();
    });
});
