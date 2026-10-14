import { abilityModifier, computedSkillModifier, hasSkill, normSkill, skillModifier, skillOverride, overrideColumn, signed, SRD_SKILL_ABILITY, skillKey, srdSkillAbility, resolveSkillAbility, unmappedSkillWarning } from '../../src/engine/skill-modifier.js';

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

/**
 * Play report 7 #11: 'sleight-of-hand' rolled WIS. roll_skill_check folded
 * spaces only, missed the SRD map and fell back to WIS without a word. One
 * map and one fold now serve roll_skill_check, opposed, stunts and the montage.
 */
describe('skill names (play report 7 #11)', () => {
    it('the 18 SRD skills map to their abilities under snake_case keys', () => {
        expect(Object.keys(SRD_SKILL_ABILITY)).toHaveLength(18);
        expect(SRD_SKILL_ABILITY.sleight_of_hand).toBe('dex');
        expect(SRD_SKILL_ABILITY.animal_handling).toBe('wis');
        expect(SRD_SKILL_ABILITY.athletics).toBe('str');
        expect(Object.isFrozen(SRD_SKILL_ABILITY)).toBe(true);
    });

    it('skillKey folds every spelling of an SRD skill to its key, and other names to lower snake case', () => {
        for (const s of ['Sleight of Hand', 'sleight-of-hand', 'sleight_of_hand', 'SleightOfHand', ' SLEIGHT OF HAND ']) expect(skillKey(s)).toBe('sleight_of_hand');
        expect(skillKey('Animal-Handling')).toBe('animal_handling');
        expect(skillKey('Waaagh Lore')).toBe('waaagh_lore');
        expect(skillKey('basket-weaving')).toBe('basket_weaving');
    });

    it('srdSkillAbility reads any spelling; an unknown skill gives undefined', () => {
        expect(srdSkillAbility('sleight-of-hand')).toBe('dex');
        expect(srdSkillAbility('SleightOfHand')).toBe('dex');
        expect(srdSkillAbility('Animal-Handling')).toBe('wis');
        expect(srdSkillAbility('haggling')).toBeUndefined();
        expect(srdSkillAbility('')).toBeUndefined();
    });

    it('resolveSkillAbility: given beats world beats SRD; none says so', () => {
        expect(resolveSkillAbility('athletics', { given: 'dex', world: 'int' })).toEqual({ ability: 'dex', source: 'given' });
        expect(resolveSkillAbility('athletics', { given: 'Dexterity' })).toEqual({ ability: 'dex', source: 'given' });
        expect(resolveSkillAbility('athletics', { world: 'int' })).toEqual({ ability: 'int', source: 'world' });
        expect(resolveSkillAbility('sleight-of-hand', {})).toEqual({ ability: 'dex', source: 'srd' });
        expect(resolveSkillAbility('haggling', {})).toEqual({ source: 'none' });
        expect(resolveSkillAbility('haggling', { given: null, world: null })).toEqual({ source: 'none' });
    });

    it("the unmapped warning is the montage's words", () => {
        expect(unmappedSkillWarning('haggling')).toBe("skill 'haggling' names no ability (not an SRD skill or a world skill): rolled with no skill modifier (no ability, no proficiency) — pass ability, or define it with table_rules {kind: 'skill', name: 'haggling', spec: {ability}}");
    });
});
