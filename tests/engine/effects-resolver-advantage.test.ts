import { autoAdvantage, applyDeclaredEffects, loadAutoMechanics, type AutoApplication } from '../../src/engine/effects-resolver.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Wishlist item 10: advantage is a lane in the resolver. autoApply
 * advantage_on / disadvantage_on mechanics are read for saves and skills
 * (scoped by save / skill, falling back to condition); a GM-declared effect
 * whose only fitting mechanic is advantage_on grants advantage.
 */
function effect(name: string, mechanics: unknown[]) {
    new CustomEffectsRepository(getDb()).apply({
        target_id: 'vex', target_type: 'character', name, description: name,
        category: 'neutral', power_level: 1, source: { type: 'unknown' },
        mechanics: mechanics as never, duration: { type: 'until_removed' as never },
        triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
    } as never);
}

describe('effects resolver advantage lane', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('autoAdvantage collects autoApply advantage_on and disadvantage_on scoped to the save or skill', () => {
        effect('Iron Will', [{ type: 'advantage_on', value: 1, save: 'wisdom', autoApply: true }]);
        effect('Clumsy', [{ type: 'disadvantage_on', value: 1, skill: 'acrobatics', autoApply: true }]);
        effect('Keen Nose', [{ type: 'advantage_on', value: 1, condition: 'perception', autoApply: true }]);
        effect('Vs Khorne', [{ type: 'advantage_on', value: 1, condition: 'vs Khorne' }]); // not autoApply
        const mechs = loadAutoMechanics(getDb(), 'vex');

        const wis = { adv: [] as string[], dis: [] as string[] };
        autoAdvantage(mechs, 'save', 'wisdom', wis);
        expect(wis).toEqual({ adv: ['Iron Will'], dis: [] });

        const dex = { adv: [] as string[], dis: [] as string[] };
        autoAdvantage(mechs, 'save', 'dexterity', dex);
        expect(dex).toEqual({ adv: [], dis: [] });

        const acro = { adv: [] as string[], dis: [] as string[] };
        autoAdvantage(mechs, 'skill', 'acrobatics', acro);
        expect(acro).toEqual({ adv: [], dis: ['Clumsy'] });

        const perc = { adv: [] as string[], dis: [] as string[] };
        autoAdvantage(mechs, 'skill', 'perception', perc);
        expect(perc.adv).toEqual(['Keen Nose']);
    });

    it('an advantage_on mechanic with no numeric value still loads for the advantage lane', () => {
        effect('Blessed', [{ type: 'advantage_on', value: 'yes', save: 'wisdom', autoApply: true }]);
        const out = { adv: [] as string[], dis: [] as string[] };
        autoAdvantage(loadAutoMechanics(getDb(), 'vex'), 'save', 'wisdom', out);
        expect(out.adv).toEqual(['Blessed']);
    });

    it('a declared effect with only an advantage_on mechanic grants advantage and reports no problem', () => {
        effect('VAUREK', [{ type: 'advantage_on', value: 1, condition: 'vs Khorne', save: 'wisdom' }]);
        const applied: AutoApplication[] = [];
        const res = applyDeclaredEffects(getDb(), 'vex', [{ name: 'vaurek' }], 'saving_throw_bonus', applied, 'wisdom');
        expect(res.total).toBe(0);
        expect(res.problems).toEqual([]);
        expect(res.advantage).toEqual(['VAUREK (vs Khorne)']);
        expect(res.disadvantage).toEqual([]);
        expect(applied).toEqual([]);
    });

    it('a declared advantage scoped to another save is refused loudly', () => {
        effect('VAUREK', [{ type: 'advantage_on', value: 1, condition: 'vs Khorne', save: 'wisdom' }]);
        const res = applyDeclaredEffects(getDb(), 'vex', [{ name: 'VAUREK' }], 'saving_throw_bonus', [], 'dexterity');
        expect(res.advantage).toEqual([]);
        expect(res.problems.length).toBe(1);
    });

    it('a declared disadvantage_on lands in the disadvantage list', () => {
        effect('Hexed', [{ type: 'disadvantage_on', value: 1, skill: 'stealth' }]);
        const res = applyDeclaredEffects(getDb(), 'vex', [{ name: 'Hexed' }], 'skill_bonus', [], 'stealth');
        expect(res.disadvantage).toEqual(['Hexed']);
        expect(res.problems).toEqual([]);
    });
});
