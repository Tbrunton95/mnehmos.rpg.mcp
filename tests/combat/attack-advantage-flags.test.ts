import { CombatRNG } from '../../src/engine/combat/rng.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 4, side bug: `attack {advantage: false}` with disadvantage unset
 * rolled two dice and kept the LOW one. rollAttackD20 compared the raw flags
 * (`false !== undefined` is true, so "one flag set"), then `advantage ? max :
 * min` took the min. An unset flag and an explicit false mean the same thing:
 * a straight roll. Volley passes the same flags through the same path.
 */
const ctx = { sessionId: 'attack-advantage-flags' };
const embedded = (res: any, tag: string) => {
    const m = res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    const d = m ? JSON.parse(m[1]) : { rawText: res.content[0].text };
    return d?.actionResult ?? d;
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');

describe('rollAttackD20 flag coercion', () => {
    const rng = () => new CombatRNG('flags');

    it('an explicit false with the other flag unset is one die, like both unset', () => {
        expect(rng().rollAttackD20(0, 10, false, undefined).allRolls).toHaveLength(1);
        expect(rng().rollAttackD20(0, 10, undefined, false).allRolls).toHaveLength(1);
        expect(rng().rollAttackD20(0, 10, undefined, undefined).allRolls).toHaveLength(1);
        expect(rng().rollAttackD20(0, 10, false, false).allRolls).toHaveLength(1);
    });

    it('one flag set rolls two and keeps the right one; both set cancel', () => {
        const adv = rng().rollAttackD20(0, 10, true, undefined);
        expect(adv.allRolls).toHaveLength(2);
        expect(adv.roll).toBe(Math.max(...adv.allRolls));
        const advFalse = rng().rollAttackD20(0, 10, true, false);
        expect(advFalse.allRolls).toHaveLength(2);
        expect(advFalse.roll).toBe(Math.max(...advFalse.allRolls));
        const dis = rng().rollAttackD20(0, 10, false, true);
        expect(dis.allRolls).toHaveLength(2);
        expect(dis.roll).toBe(Math.min(...dis.allRolls));
        expect(rng().rollAttackD20(0, 10, true, true).allRolls).toHaveLength(1);
    });
});

describe('combat_action attack and volley with advantage: false', () => {
    let encounterId: string;
    const fight = async (participants: Array<Record<string, unknown>>) => {
        const created = await manage({ action: 'create', seed: 'attack-flags', participants });
        encounterId = created.encounterId;
    };

    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('attack {advantage: false} alone is a straight roll; {disadvantage: false} too', async () => {
        await fight([
            { id: 'fighter', name: 'Fighter', hp: 60, maxHp: 60, initiative: 20, attacksPerAction: 3 },
            { id: 'gob', name: 'Goblin', hp: 200, maxHp: 200, initiative: 5, isEnemy: true, ac: 10 }
        ]);
        const a = await act({ action: 'attack', encounterId, actorId: 'fighter', targetId: 'gob', attackBonus: 5, damage: 1, advantage: false });
        expect(a.roll.allRolls).toHaveLength(1);
        const b = await act({ action: 'attack', encounterId, actorId: 'fighter', targetId: 'gob', attackBonus: 5, damage: 1, disadvantage: false });
        expect(b.roll.allRolls).toHaveLength(1);
        // The real flags still work.
        const c = await act({ action: 'attack', encounterId, actorId: 'fighter', targetId: 'gob', attackBonus: 5, damage: 1, advantage: true, disadvantage: false });
        expect(c.roll.allRolls).toHaveLength(2);
        expect(c.roll.die).toBe(Math.max(...c.roll.allRolls));
    });

    it('volley {advantage: false} alone is a straight roll', async () => {
        await fight([
            { id: 'scions', name: 'Scions', hp: 50, maxHp: 50, initiative: 25, unit: { models: 10, hpPerModel: 5, packed: true, attackBonus: 6 } },
            { id: 'gob', name: 'Goblin', hp: 200, maxHp: 200, initiative: 5, isEnemy: true, ac: 10 }
        ]);
        const v = await act({ action: 'volley', encounterId, actorId: 'scions', targetId: 'gob', advantage: false });
        expect(v.error).toBeFalsy();
        expect(v.roll.allRolls).toHaveLength(1);
    });
});
