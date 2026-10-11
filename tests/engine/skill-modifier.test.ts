import { abilityModifier, computedSkillModifier, hasSkill, normSkill, skillModifier, skillOverride, overrideColumn, signed } from '../../src/engine/skill-modifier.js';

/**
 * Play report 2 #5: one skill number per character. A stealth/perception
 * column that is null means "compute from the sheet"; any number, 0
 * included, is an authoritative override that replaces the computed value.
 */
describe('skill-modifier', () => {
    const rogue = { stats: { str: 10, dex: 16, con: 10, int: 10, wis: 12, cha: 10 }, level: 5, skillProficiencies: ['Stealth'], expertise: [] as string[] };

    it('ability modifiers and signed text', () => {
        expect(abilityModifier(16)).toBe(3);
        expect(abilityModifier(7)).toBe(-2);
        expect(abilityModifier(undefined)).toBe(0);
        expect(signed(3)).toBe('+3');
        expect(signed(0)).toBe('+0');
        expect(signed(-2)).toBe('-2');
    });

    it('skill names fold case, spaces, underscores and hyphens', () => {
        expect(normSkill('Sleight of Hand')).toBe('sleightofhand');
        expect(normSkill('sleight_of_hand')).toBe('sleightofhand');
        expect(hasSkill(['Stealth', 'Animal Handling'], 'animal_handling')).toBe(true);
        expect(hasSkill(undefined, 'stealth')).toBe(false);
    });

    it('computes DEX + proficiency for a proficient skill, doubling on expertise', () => {
        expect(computedSkillModifier(rogue, 'stealth', 'dex', 3)).toEqual({ value: 6, abilityMod: 3, proficiency: 3, expertise: false });
        expect(computedSkillModifier({ ...rogue, expertise: ['stealth'] }, 'stealth', 'dex', 3)).toEqual({ value: 9, abilityMod: 3, proficiency: 6, expertise: true });
        expect(computedSkillModifier(rogue, 'perception', 'wis', 3).value).toBe(1);
    });

    it('null or absent columns mean computed; any number is an override, 0 included', () => {
        expect(skillOverride(rogue, 'stealth')).toBeUndefined();
        expect(skillOverride({ ...rogue, stealthBonus: null }, 'stealth')).toBeUndefined();
        expect(skillOverride({ ...rogue, stealthBonus: 0 }, 'stealth')).toBe(0);
        expect(skillOverride({ ...rogue, perceptionBonus: 7 }, 'perception')).toBe(7);
        expect(skillOverride({ ...rogue, stealthBonus: 9 }, 'athletics')).toBeUndefined();

        const computed = skillModifier(rogue, 'stealth', 'dex', 3);
        expect(computed).toMatchObject({ value: 6, source: 'computed', computed: 6 });
        const overridden = skillModifier({ ...rogue, stealthBonus: 9 }, 'stealth', 'dex', 3);
        expect(overridden).toMatchObject({ value: 9, source: 'override', override: 9, computed: 6 });
        const zero = skillModifier({ ...rogue, stealthBonus: 0 }, 'stealth', 'dex', 3);
        expect(zero).toMatchObject({ value: 0, source: 'override', override: 0, computed: 6 });
    });

    it('names the column a skill overrides', () => {
        expect(overrideColumn('Stealth')).toBe('stealth_bonus');
        expect(overrideColumn('perception')).toBe('perception_bonus');
        expect(overrideColumn('athletics')).toBeNull();
    });
});
