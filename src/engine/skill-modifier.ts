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

/**
 * Play report 7 #11: the 18 SRD skills and the ability each rolls with, under
 * snake_case keys. The one map: roll_skill_check (and opposed through it),
 * stunts and the montage read it, so no reader can disagree on a spelling.
 */
export const SRD_SKILL_ABILITY: Readonly<Record<string, ShortAbility>> = Object.freeze({
    athletics: 'str',
    acrobatics: 'dex', sleight_of_hand: 'dex', stealth: 'dex',
    arcana: 'int', history: 'int', investigation: 'int', nature: 'int', religion: 'int',
    animal_handling: 'wis', insight: 'wis', medicine: 'wis', perception: 'wis', survival: 'wis',
    deception: 'cha', intimidation: 'cha', performance: 'cha', persuasion: 'cha'
});

const SRD_BY_NORM: ReadonlyMap<string, string> = new Map(Object.keys(SRD_SKILL_ABILITY).map(k => [normSkill(k), k]));

/**
 * The key a skill is read by: the SRD key for any spelling of an SRD skill
 * ('Sleight of Hand', 'sleight-of-hand', 'SleightOfHand' → 'sleight_of_hand'),
 * else the name folded to lower snake case ('Waaagh Lore' → 'waaagh_lore').
 */
export function skillKey(skill: string): string {
    const trimmed = String(skill ?? '').trim();
    return SRD_BY_NORM.get(normSkill(trimmed)) ?? trimmed.toLowerCase().replace(/[\s-]+/g, '_');
}

/** The ability an SRD skill rolls with, in any spelling; undefined for any other name. */
export function srdSkillAbility(skill: string): ShortAbility | undefined {
    const key = SRD_BY_NORM.get(normSkill(String(skill ?? '').trim()));
    return key ? SRD_SKILL_ABILITY[key] : undefined;
}

export type SkillAbilitySource = 'given' | 'world' | 'srd' | 'none';

const SHORT_ABILITIES: readonly ShortAbility[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
/** 'dex', 'DEX' or 'Dexterity' → 'dex'; anything else undefined. */
function shortAbility(v: string | null | undefined): ShortAbility | undefined {
    if (typeof v !== 'string') return undefined;
    const k = v.trim().toLowerCase().slice(0, 3) as ShortAbility;
    return SHORT_ABILITIES.includes(k) ? k : undefined;
}

/**
 * Which ability a skill check rolls with: the one the call gives, else the
 * world's skill (table_rules skill, looked up by the caller), else the SRD
 * map; 'none' when nothing names one. The caller decides what none means
 * (roll_skill_check and the montage roll with no ability and warn; a stunt refuses).
 */
export function resolveSkillAbility(skill: string, opts: { given?: string | null; world?: string | null }): { ability?: ShortAbility; source: SkillAbilitySource } {
    const given = shortAbility(opts.given);
    if (given) return { ability: given, source: 'given' };
    const world = shortAbility(opts.world);
    if (world) return { ability: world, source: 'world' };
    const srd = srdSkillAbility(skill);
    if (srd) return { ability: srd, source: 'srd' };
    return { source: 'none' };
}

/** What a skill that names no ability rolls with, said in the montage's words. */
export function unmappedSkillWarning(skill: string): string {
    return `skill '${skill}' names no ability (not an SRD skill or a world skill): rolled with no skill modifier (no ability, no proficiency) — pass ability, or define it with table_rules {kind: 'skill', name: '${skill}', spec: {ability}}`;
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
