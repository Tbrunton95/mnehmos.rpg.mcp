import { z } from 'zod';

// Spell schools from D&D 5e
export const SpellSchoolSchema = z.enum([
    'abjuration',
    'conjuration',
    'divination',
    'enchantment',
    'evocation',
    'illusion',
    'necromancy',
    'transmutation'
]);

export type SpellSchool = z.infer<typeof SpellSchoolSchema>;

// Casting time types
export const CastingTimeSchema = z.enum([
    'action',
    'bonus_action',
    'reaction',
    'minute',
    '10_minutes',
    'hour',
    '8_hours',
    '12_hours',
    '24_hours'
]);

export type CastingTime = z.infer<typeof CastingTimeSchema>;

// Spell range types
export const SpellRangeSchema = z.union([
    z.literal('self'),
    z.literal('touch'),
    z.number().int().min(0) // Distance in feet
]);

export type SpellRange = z.infer<typeof SpellRangeSchema>;

// Damage types
export const DamageTypeSchema = z.enum([
    'acid',
    'bludgeoning',
    'cold',
    'fire',
    'force',
    'lightning',
    'necrotic',
    'piercing',
    'poison',
    'psychic',
    'radiant',
    'slashing',
    'thunder'
]);

export type DamageType = z.infer<typeof DamageTypeSchema>;

// Save types
export const SaveTypeSchema = z.enum([
    'strength',
    'dexterity',
    'constitution',
    'intelligence',
    'wisdom',
    'charisma',
    'none'
]);

export type SaveType = z.infer<typeof SaveTypeSchema>;

// Spell components
export const SpellComponentsSchema = z.object({
    verbal: z.boolean(),
    somatic: z.boolean(),
    material: z.boolean(),
    materialDescription: z.string().optional()
});

export type SpellComponents = z.infer<typeof SpellComponentsSchema>;

// Spell target types
export const SpellTargetTypeSchema = z.enum([
    'self',
    'creature',
    'creatures',
    'point',
    'area',
    'object'
]);

export type SpellTargetType = z.infer<typeof SpellTargetTypeSchema>;

// Area of effect shapes
export const AreaShapeSchema = z.enum([
    'cone',
    'cube',
    'cylinder',
    'line',
    'sphere'
]);

export type AreaShape = z.infer<typeof AreaShapeSchema>;

// Spell effect schema
export const SpellEffectSchema = z.object({
    type: z.enum(['damage', 'healing', 'buff', 'debuff', 'utility', 'summon']),
    dice: z.string().optional(), // e.g., "8d6", "1d8+4"
    damageType: DamageTypeSchema.optional(),
    saveType: SaveTypeSchema.optional(),
    saveEffect: z.enum(['half', 'none', 'special']).optional(), // What happens on successful save
    upcastBonus: z.object({
        dice: z.string(), // Additional dice per level, e.g., "1d6"
        perLevel: z.number().int().default(1) // How many levels for the bonus
    }).optional(),
    conditions: z.array(z.string()).optional() // Conditions applied
});

export type SpellEffect = z.infer<typeof SpellEffectSchema>;

// Class list for spell availability
export const SpellcastingClassSchema = z.enum([
    'bard',
    'cleric',
    'druid',
    'paladin',
    'ranger',
    'sorcerer',
    'warlock',
    'wizard',
    'artificer'
]);

export type SpellcastingClass = z.infer<typeof SpellcastingClassSchema>;

// Complete spell definition
export const SpellSchema = z.object({
    id: z.string(),
    name: z.string(),
    level: z.number().int().min(0).max(9), // 0 = cantrip
    school: SpellSchoolSchema,
    castingTime: CastingTimeSchema,
    range: SpellRangeSchema,
    components: SpellComponentsSchema,
    duration: z.string(), // e.g., "Instantaneous", "1 minute", "Concentration, up to 1 hour"
    concentration: z.boolean(),
    ritual: z.boolean().optional().default(false),
    description: z.string(),
    higherLevels: z.string().optional(), // Description for upcasting
    classes: z.array(SpellcastingClassSchema),
    targetType: SpellTargetTypeSchema,
    areaOfEffect: z.object({
        shape: AreaShapeSchema,
        size: z.number().int() // Size in feet
    }).optional(),
    effects: z.array(SpellEffectSchema),
    autoHit: z.boolean().default(false), // e.g., Magic Missile
    // Play report 7 #7 (lane F review): the spell attack's own kind when the
    // range does not say it (5e: Spiritual Weapon is a melee spell attack at
    // range 60). Unset: touch / self / 5 ft is melee, any other range ranged.
    spellAttack: z.enum(['melee', 'ranged']).optional()
});

export type Spell = z.infer<typeof SpellSchema>;

// Spell slot schema for characters
export const SpellSlotSchema = z.object({
    current: z.number().int().min(0),
    max: z.number().int().min(0)
});

export type SpellSlot = z.infer<typeof SpellSlotSchema>;

// Full spell slots by level (1-9)
export const SpellSlotsSchema = z.object({
    level1: SpellSlotSchema.default({ current: 0, max: 0 }),
    level2: SpellSlotSchema.default({ current: 0, max: 0 }),
    level3: SpellSlotSchema.default({ current: 0, max: 0 }),
    level4: SpellSlotSchema.default({ current: 0, max: 0 }),
    level5: SpellSlotSchema.default({ current: 0, max: 0 }),
    level6: SpellSlotSchema.default({ current: 0, max: 0 }),
    level7: SpellSlotSchema.default({ current: 0, max: 0 }),
    level8: SpellSlotSchema.default({ current: 0, max: 0 }),
    level9: SpellSlotSchema.default({ current: 0, max: 0 })
});

export type SpellSlots = z.infer<typeof SpellSlotsSchema>;

// Warlock pact magic slots (all same level)
export const PactMagicSlotsSchema = z.object({
    current: z.number().int().min(0),
    max: z.number().int().min(0),
    slotLevel: z.number().int().min(1).max(5) // Warlock slots max at 5th level
});

export type PactMagicSlots = z.infer<typeof PactMagicSlotsSchema>;

// Spellcasting ability mapping
export const SpellcastingAbilitySchema = z.enum([
    'intelligence',
    'wisdom',
    'charisma'
]);

export type SpellcastingAbility = z.infer<typeof SpellcastingAbilitySchema>;

// Character class schema (for spellcasting validation)
export const CharacterClassSchema = z.enum([
    'barbarian',
    'bard',
    'cleric',
    'druid',
    'fighter',
    'monk',
    'paladin',
    'ranger',
    'rogue',
    'sorcerer',
    'warlock',
    'wizard',
    'artificer'
]);

export type CharacterClass = z.infer<typeof CharacterClassSchema>;

// Subclass schema for third-casters
export const SubclassSchema = z.enum([
    'eldritch_knight', // Fighter
    'arcane_trickster', // Rogue
    'champion', // Fighter (non-caster)
    'assassin', // Rogue (non-caster)
    'none'
]).default('none');

export type Subclass = z.infer<typeof SubclassSchema>;

// Cast spell request schema (for validation)
export const CastSpellRequestSchema = z.object({
    characterId: z.string(),
    spellName: z.string().min(1, 'Spell name is required'),
    slotLevel: z.number().int().min(1).max(9).optional(),
    targetId: z.string().optional(),
    targetPoint: z.object({
        x: z.number(),
        y: z.number()
    }).optional(),
    asReaction: z.boolean().optional(),
    metamagic: z.array(z.string()).optional()
});

export type CastSpellRequest = z.infer<typeof CastSpellRequestSchema>;

// Spell cast result schema
export const SpellCastResultSchema = z.object({
    success: z.boolean(),
    spellName: z.string(),
    slotUsed: z.number().int().optional(), // undefined for cantrips
    damage: z.number().int().optional(),
    damageType: DamageTypeSchema.optional(),
    healing: z.number().int().optional(),
    diceRolled: z.string().optional(),
    saveResult: z.enum(['passed', 'failed', 'none']).optional(),
    damageRolled: z.number().int().optional(),
    damageApplied: z.number().int().optional(),
    autoHit: z.boolean().optional(),
    attackRoll: z.number().int().optional(),
    acBonus: z.number().int().optional(), // For Shield
    dartCount: z.number().int().optional(), // For Magic Missile
    concentration: z.boolean().optional(),
    error: z.string().optional()
});

export type SpellCastResult = z.infer<typeof SpellCastResultSchema>;
