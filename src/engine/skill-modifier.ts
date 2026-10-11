/**
 * Play report 2 #5: ONE skill number per character.
 *
 * Stealth and Perception carry an optional override column on the sheet
 * (stealthBonus / perceptionBonus). The column is tri-state:
 *   - null or absent: the modifier is COMPUTED from the sheet — ability
 *     modifier + proficiency (doubled by expertise);
 *   - any number, 0 included: an authoritative OVERRIDE that replaces the
 *     computed value (a stat block's skill total). It never adds.
 *
 * Every reader (roll_skill_check, stunts, the eavesdrop layer, spatial look,
 * POI discovery, the update offset-sync) composes through this module so the
 * numbers agree. Pure: no database, no dice.
 */

export type ShortAbility = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
export type SkillSource = 'override' | 'computed';

/** The sheet fields a skill modifier reads. */
export interface SkillSheet {
    stats: Record<string, number>;
    level: number;
    skillProficiencies?: string[];
    expertise?: string[];
    stealthBonus?: number | null;
    perceptionBonus?: number | null;
}

export interface ComputedSkill {
    value: number;
    abilityMod: number;
    /** The proficiency contribution (doubled on expertise), 0 when not proficient. */
    proficiency: number;
    expertise: boolean;
}

export interface SkillModifier extends ComputedSkill {
    source: SkillSource;
    /** The computed value, also when an override displaces it. */
    computed: number;
    /** Present when the column holds a number. */
    override?: number;
}

/** The skills with an override column, by the sheet field and the SQL column that hold it. */
export const OVERRIDE_SKILLS: Record<string, { field: 'stealthBonus' | 'perceptionBonus'; column: 'stealth_bonus' | 'perception_bonus'; ability: ShortAbility }> = {
    stealth: { field: 'stealthBonus', column: 'stealth_bonus', ability: 'dex' },
    perception: { field: 'perceptionBonus', column: 'perception_bonus', ability: 'wis' }
};

export function abilityModifier(score: number | undefined | null): number {
    return Math.floor(((typeof score === 'number' ? score : 10) - 10) / 2);
}

/** Case-fold a skill name and drop spaces, underscores and hyphens: 'Sleight of Hand' == 'sleight_of_hand'. */
export function normSkill(skill: string): string {
    return skill.toLowerCase().replace(/[ _-]/g, '');
}

export function hasSkill(list: readonly string[] | undefined | null, skill: string): boolean {
    if (!list?.length) return false;
    const want = normSkill(skill);
    return list.some(s => normSkill(String(s)) === want);
}

/** '+3', '+0', '-2'. */
export function signed(n: number): string {
    return `${n >= 0 ? '+' : ''}${n}`;
}

/** The SQL column a skill's override lives in, or null for a skill without one. */
export function overrideColumn(skill: string): 'stealth_bonus' | 'perception_bonus' | null {
    return OVERRIDE_SKILLS[normSkill(skill)]?.column ?? null;
}

/** Ability modifier + proficiency (doubled by expertise). `profBonus` is the proficiency bonus at the sheet's level under the world's curve. */
export function computedSkillModifier(sheet: SkillSheet, skill: string, ability: ShortAbility, profBonus: number): ComputedSkill {
    const abilityMod = abilityModifier(sheet.stats?.[ability]);
    const expertise = hasSkill(sheet.expertise, skill);
    const proficiency = expertise ? profBonus * 2 : hasSkill(sheet.skillProficiencies, skill) ? profBonus : 0;
    return { value: abilityMod + proficiency, abilityMod, proficiency, expertise };
}

/** The override a sheet holds for a skill: a number (0 included) when set, undefined when the column is null/absent or the skill has no column. */
export function skillOverride(sheet: SkillSheet, skill: string): number | undefined {
    const spec = OVERRIDE_SKILLS[normSkill(skill)];
    if (!spec) return undefined;
    const v = sheet[spec.field];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The number a skill check rolls with: the override when the column holds one, the computed value otherwise. */
export function skillModifier(sheet: SkillSheet, skill: string, ability: ShortAbility, profBonus: number): SkillModifier {
    const computed = computedSkillModifier(sheet, skill, ability, profBonus);
    const override = skillOverride(sheet, skill);
    if (override === undefined) return { ...computed, source: 'computed', computed: computed.value };
    return { ...computed, value: override, source: 'override', computed: computed.value, override };
}
