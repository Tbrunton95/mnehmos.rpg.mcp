import { CombatEngine } from '../../src/engine/combat/engine.js';

function fight(seed: string) {
    const e = new CombatEngine(seed);
    e.startEncounter([
        { id: 'marine', name: 'Marine', initiativeBonus: 0, hp: 100, maxHp: 100, conditions: [], attackBonus: 40, attackDamage: '1d1+4', attackDamageType: 'fire' },
        { id: 'heretic', name: 'Heretic', initiativeBonus: 9, hp: 100, maxHp: 100, conditions: [], ac: 12 }
    ] as any);
    return e;
}

/**
 * Audit: opportunity attacks used initiativeBonus+2 as the attack bonus, a
 * 10+init/2 guess for AC and a fixed 1d6+2, and doubled the whole total on a
 * crit (and crit on beating AC by 10). They now use the attacker's own attack
 * bonus/damage and the target's AC, crit on a natural 20 only, and double dice.
 */
describe('opportunity attacks use real stats', () => {
    it('deals the attacker\'s own damage against the target\'s AC', () => {
        let hits = 0;
        for (let i = 0; i < 20; i++) {
            const r = fight(`oa-${i}`).executeOpportunityAttack('marine', 'heretic');
            const crit = r.attackRoll?.isCrit;
            if (r.success) {
                hits++;
                // 1d1+4 = 5; a crit doubles the die only: 1+1+4 = 6.
                expect(r.damage).toBe(crit ? 6 : 5);
            } else {
                // +40 against AC 12 only misses on a natural 1.
                expect(r.attackRoll?.isNat1).toBe(true);
            }
        }
        expect(hits).toBeGreaterThan(15);
    });

    it('applies resistance to the attacker\'s damage type', () => {
        const e = new CombatEngine('oa-resist');
        e.startEncounter([
            { id: 'marine', name: 'Marine', initiativeBonus: 0, hp: 100, maxHp: 100, conditions: [], attackBonus: 40, attackDamage: '1d1+9', attackDamageType: 'fire' },
            { id: 'heretic', name: 'Heretic', initiativeBonus: 0, hp: 100, maxHp: 100, conditions: [], ac: 12, resistances: ['fire'] }
        ] as any);
        const r = e.executeOpportunityAttack('marine', 'heretic');
        if (r.success && !r.attackRoll?.isCrit) expect(r.damage).toBe(5);
    });
});
