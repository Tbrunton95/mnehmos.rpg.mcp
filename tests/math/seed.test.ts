import { DiceEngine } from '../../src/math/dice.js';
import { freshSeed } from '../../src/math/seed.js';

/**
 * Unseeded rolls used to seed from new Date().toISOString(), so every roll made
 * in the same millisecond (a batch_manage execute_sequence) replayed the same
 * dice: three saves all 18, two 4d10 pools identical.
 */
describe('per-roll seeds', () => {
    it('freshSeed never repeats, even within one millisecond', () => {
        const seeds = new Set(Array.from({ length: 500 }, () => freshSeed('roll')));
        expect(seeds.size).toBe(500);
    });

    it('unseeded DiceEngines created back to back roll independent streams', () => {
        const rolls = Array.from({ length: 50 }, () => new DiceEngine().roll('10d10').metadata?.rolls as number[]);
        const distinct = new Set(rolls.map(r => r.join(',')));
        expect(distinct.size).toBe(50);
    });

    it('an explicit seed still replays identically', () => {
        const a = new DiceEngine('fixed-seed').roll('4d10').metadata?.rolls;
        const b = new DiceEngine('fixed-seed').roll('4d10').metadata?.rolls;
        expect(a).toEqual(b);
    });
});

import { CombatRNG } from '../../src/engine/combat/rng.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';

describe('combat RNG position survives a reload', () => {
    it('a restored snapshot continues the stream instead of replaying it', () => {
        const live = new CombatRNG('enc-seed');
        live.d20(0); live.d20(0); live.d20(0);
        const saved = JSON.parse(JSON.stringify(live.snapshot()));
        const restored = new CombatRNG('different', saved);
        const fresh = new CombatRNG('enc-seed');
        const next = [live.d20(0), live.d20(0), live.d20(0), live.d20(0), live.d20(0)];
        expect([restored.d20(0), restored.d20(0), restored.d20(0), restored.d20(0), restored.d20(0)]).toEqual(next);
        // Without the snapshot a reload would restart at the first roll.
        expect([fresh.d20(0), fresh.d20(0), fresh.d20(0)]).not.toEqual(next.slice(0, 3));
    });

    it('CombatEngine.loadState resumes from state.rngState', () => {
        const a = new CombatEngine('fight');
        a.startEncounter([
            { id: 'x', name: 'X', initiativeBonus: 0, hp: 10, maxHp: 10, conditions: [] },
            { id: 'y', name: 'Y', initiativeBonus: 0, hp: 10, maxHp: 10, conditions: [] }
        ] as any);
        const state = JSON.parse(JSON.stringify(a.getState()));
        const b = new CombatEngine('fight');
        b.loadState(state);
        const hitA = a.executeAttack('x', 'y', 5, 10, 4);
        const hitB = b.executeAttack('x', 'y', 5, 10, 4);
        expect(hitB.attackRoll).toEqual(hitA.attackRoll);
    });
});
