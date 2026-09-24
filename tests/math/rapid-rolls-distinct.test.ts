import { DiceEngine } from '../../src/math/dice.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Field report (old build): saves rolled in one batch came back 18, 18, 18
 * then 1, 1, 1, and two turrets rolled 35 damage each. The dice seeded from
 * the clock, and encounters without a seed all shared the seed 'combat'.
 */
describe('rolls made in the same instant differ', () => {
    it('200 back-to-back unseeded dice engines never share a seed', () => {
        const seeds = new Set(Array.from({ length: 200 }, () => (new DiceEngine() as unknown as { seed: string }).seed));
        expect(seeds.size).toBe(200);
    });

    it('back-to-back 1d20 rolls do not repeat as a block', () => {
        const rolls = Array.from({ length: 60 }, () => new DiceEngine().roll('1d20').result as number);
        // Three identical 1d20s in a row happens by chance 1 time in 400 per
        // position; twenty separate triples all identical would be the bug.
        const triples = Array.from({ length: 20 }, (_, i) => rolls.slice(i * 3, i * 3 + 3));
        expect(triples.filter(t => t[0] === t[1] && t[1] === t[2]).length).toBeLessThan(3);
        expect(new Set(rolls).size).toBeGreaterThan(10);
    });

    it('two encounters created together without a seed roll different dice', async () => {
        closeDb(); getDb(':memory:'); clearCombatState();
        const ctx = { sessionId: 'turrets' };
        const mk = async () => JSON.parse((await handleCombatManage({ action: 'create', participants: [
            { id: 'a', name: 'Turret', hp: 50, maxHp: 50, initiative: 10 }, { id: 'b', name: 'Target', hp: 500, maxHp: 500, initiative: 5 }
        ] }, ctx as any)).content[0].text.match(/<!-- COMBAT_MANAGE_JSON\n([\s\S]*?)\nCOMBAT_MANAGE_JSON -->/)![1]).encounterId as string;
        const [e1, e2] = [await mk(), await mk()];
        const dmg = (id: string) => getOrLoadEngine(ctx as any, id)!.executeAttack('a', 'b', 100, 1, '20d10').damage;
        expect(dmg(e1)).not.toBe(dmg(e2));
        closeDb();
    });
});
