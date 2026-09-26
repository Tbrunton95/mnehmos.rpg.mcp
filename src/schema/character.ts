import { PartSchema, SizeCategorySchema, AttackProfileSchema, AbilitySchema } from './token-extras.js';
import { z } from 'zod';
import { CharacterTypeSchema } from './party.js';
import {
    SubclassSchema,
    SpellSlotsSchema,
    PactMagicSlotsSchema,
    SpellcastingAbilitySchema
} from './spell.js';

export const SkillProficiencySchema = z.enum([
    'acrobatics', 'animal_handling', 'arcana', 'athletics', 'deception',
    'history', 'insight', 'intimidation', 'investigation', 'medicine',
    'nature', 'perception', 'performance', 'persuasion', 'religion',
    'sleight_of_hand', 'stealth', 'survival'
]);

export const SaveProficiencySchema = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);

export const CurrencySchema = z.object({
    // Decimal: add_currency rounds to cents (FINDINGS #111).
    gold: z.number().min(0).default(0),
    silver: z.number().int().min(0).default(0),
    copper: z.number().int().min(0).default(0),
});

/**
 * Bastion world-brief origin tracker.
 *
 * The world's central conceit is that almost no one is native to Bastion —
 * the population is summoned from every fictional universe (Forgotten Realms,
 * Konoha, contemporary Earth, ...). origin records where a soul came from
 * and when it arrived, so tools can enforce/expose that fact.
 */
export const CharacterOriginSchema = z.object({
    universe: z.string().min(1)
        .describe('Source universe (e.g. "Contemporary Earth — Arizona Mine", "Forgotten Realms", "Konoha")'),
    native: z.boolean().default(false)
        .describe('True iff born in Bastion; false for summoned souls'),
    arrivedAt: z.string().optional()
        .describe('PD-year or ISO date the soul arrived in Bastion'),
    arrivedInCohortId: z.string().uuid().optional()
        .describe('Optional cohort/wave ID the soul arrived with')
});

export type CharacterOrigin = z.infer<typeof CharacterOriginSchema>;

/**
 * One resource pool (item 15: counters). Every field is declared: a plain
 * z.object strips what it does not name, and the adjust_pool history used to
 * vanish on the next read that way (FINDINGS #111). A factory, so each schema
 * that embeds a pool gets its own instance (an outer tool schema that reuses
 * one zod instance twice publishes a $ref).
 */
export function resourcePoolSchema() {
    return z.object({
        current: z.number(),
        max: z.number(),
        lastRefilledAt: z.string().optional(),
        label: z.string().optional().describe('Display name for the counter ("An\'ggrath\'s calls"); the key stays the id'),
        note: z.string().optional().describe('What the counter is, or to whom it is owed'),
        show: z.boolean().optional().describe('Show it in the boot digest and the status block'),
        itemInstanceId: z.string().optional().describe('Linked item instance: the pool is authoritative and its charges mirror the pool'),
        history: z.array(z.object({
            at: z.string().optional(),
            from: z.number().optional(),
            to: z.number().optional(),
            delta: z.number().optional(),
            set: z.number().optional(),
            reason: z.string().optional(),
            witnesses: z.array(z.string()).optional(),
        })).optional().describe('Last 20 moves that carried a reason or witnesses'),
    });
}

export type ResourcePool = z.infer<ReturnType<typeof resourcePoolSchema>>;

export const CharacterSchema = z.object({
    id: z.string(),
    name: z.string()
        .min(1, 'Character name cannot be empty')
        .max(100, 'Character name cannot exceed 100 characters'),
    stats: z.object({
        str: z.number().int().min(0),
        dex: z.number().int().min(0),
        con: z.number().int().min(0),
        int: z.number().int().min(0),
        wis: z.number().int().min(0),
        cha: z.number().int().min(0),
    }),
    hp: z.number().int().min(0),
    maxHp: z.number().int().min(0),
    ac: z.number().int().min(0),
    level: z.number().int().min(1),
    xp: z.number().int().min(0).default(0).describe('Current experience points'),
    characterType: CharacterTypeSchema.optional().default('pc'),

    // PHASE-2: Social Hearing Mechanics - skill bonuses for opposed rolls
    perceptionBonus: z.number().int().optional().default(0)
        .describe('Proficiency bonus for Perception checks (WIS-based)'),
    stealthBonus: z.number().int().optional().default(0)
        .describe('Proficiency bonus for Stealth checks (DEX-based)'),

    // Table rules: power band (named in the world's band rule) and the HP a
    // regenerating creature heals at the start of each of its rounds.
    band: z.string().optional(),
    regeneration: z.number().int().min(0).optional(),
    parts: z.array(PartSchema).optional(),

    // Combat profile: what a token made from this sheet starts with (size,
    // reach, multiattack, named attacks, limited abilities, CR, automatic
    // legendary resistance). Stored together in the combat_profile column.
    size: SizeCategorySchema.optional(),
    reach: z.number().int().min(0).optional(),
    attacksPerAction: z.number().int().min(1).optional(),
    attacks: z.array(AttackProfileSchema).optional(),
    abilities: z.array(AbilitySchema).optional(),
    cr: z.number().min(0).optional(),
    autoLegendaryResistance: z.boolean().optional(),
    /** The form a character has taken (character_manage set_form): its name and the sheet's own values to go back to. */
    form: z.object({
        name: z.string(),
        since: z.string().optional(),
        base: z.record(z.string(), z.unknown())
    }).optional(),

    // Spellcasting fields (CRIT-002/006)
    // Flexible character class - allows any string (standard D&D classes or custom like "Chronomancer")
    characterClass: z.string().optional().default('fighter'),
    race: z.string().optional().default('Human')
        .describe('Character race - any string allowed (Human, Elf, Dragonborn, Mousefolk...)'),
    subclass: SubclassSchema.optional(),
    spellSlots: SpellSlotsSchema.optional(),
    pactMagicSlots: PactMagicSlotsSchema.optional(), // Warlock only
    knownSpells: z.array(z.string()).optional().default([]),
    preparedSpells: z.array(z.string()).optional().default([]),
    cantripsKnown: z.array(z.string()).optional().default([]),
    maxSpellLevel: z.number().int().min(0).max(9).optional().default(0),
    spellcastingAbility: SpellcastingAbilitySchema.optional(),
    spellSaveDC: z.number().int().optional(),
    spellAttackBonus: z.number().int().optional(),
    concentratingOn: z.string().nullable().optional().default(null),
    activeSpells: z.array(z.string()).optional().default([]),
    conditions: z.array(z.object({
        name: z.string().describe('Condition name (e.g., Poisoned, Frightened)'),
        duration: z.number().int().optional().describe('Duration in rounds'),
        source: z.string().optional().describe('Source of the condition'),
        pinned: z.boolean().optional().describe('Shown first in the tiny status block and the boot digest')
    })).optional().default([]),
    position: z.object({
        x: z.number(),
        y: z.number()
    }).optional(),

    // PHASE-1: Spatial Graph System - current room for spatial awareness
    currentRoomId: z.string().uuid().optional()
        .describe('ID of the room the character is currently in'),

    // HIGH-007: Legendary creature fields
    legendaryActions: z.number().int().min(0).optional()
        .describe('Total legendary actions per round (usually 3)'),
    legendaryActionsRemaining: z.number().int().min(0).optional()
        .describe('Remaining legendary actions this round'),
    legendaryResistances: z.number().int().min(0).optional()
        .describe('Total legendary resistances per day (usually 3)'),
    legendaryResistancesRemaining: z.number().int().min(0).optional()
        .describe('Remaining legendary resistances'),
    hasLairActions: z.boolean().optional().default(false)
        .describe('Whether this creature can use lair actions on initiative 20'),

    // HIGH-002: Damage modifiers
    resistances: z.array(z.string()).optional().default([])
        .describe('Damage types that deal half damage (e.g., ["fire", "cold"])'),
    vulnerabilities: z.array(z.string()).optional().default([])
        .describe('Damage types that deal double damage'),
    immunities: z.array(z.string()).optional().default([])
        .describe('Damage types that deal no damage'),

    // §10.3 forward-compat: generalized resource pools.
    // Operator's attentional_capacity lives here (resourcePools.attentional_capacity).
    // Backwards-compatible — existing 5e characters keep spellSlots untouched.
    resourcePools: z.record(z.string(), resourcePoolSchema()).optional().default({}),

    // Skill and Save Proficiencies — free strings by design: skill LISTS are
    // theme data (5e's eighteen, Cyberpunk's, WoD's...), not engine rules.
    // roll_skill_check maps known 5e skills to abilities automatically and
    // takes an explicit `ability` for everything else.
    skillProficiencies: z.array(z.string())
        .optional().default([]).describe('Skills the character is proficient in (any theme skill list)'),
    saveProficiencies: z.array(z.string())
        .optional().default([]).describe('Saving throws the character is proficient in (str/dex/con/int/wis/cha)'),
    expertise: z.array(z.string()).optional().default([])
        .describe('Skills with double proficiency bonus (rogues, bards)'),
    armorProficiencies: z.array(z.string()).optional().default([])
        .describe('Armor categories the character is proficient with'),
    weaponProficiencies: z.array(z.string()).optional().default([])
        .describe('Weapons or weapon categories the character is proficient with'),
    toolProficiencies: z.array(z.string()).optional().default([])
        .describe('Tools the character is proficient with'),
    languages: z.array(z.string()).optional().default([])
        .describe('Languages the character can speak or understand'),
    currency: CurrencySchema.optional().default({})
        .describe('Character currency in gold, silver, and copper denominations'),

    // Background and alignment — accepted previously but silently dropped on
    // persistence (no migration column). See docs/bastion/05-world-brief-vs-tool-surface.md.
    background: z.string().optional()
        .describe('Character background (e.g. "Soldier", "Charlatan", "Folk Hero")'),
    alignment: z.string().optional()
        .describe('Character alignment (free-form string, e.g. "lawful_good", "chaotic_neutral")'),

    // Bastion-world origin tracker (universe of origin, native-ness, arrival data).
    origin: CharacterOriginSchema.optional()
        .describe('Source universe / Bastion-arrival metadata'),

    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type Character = z.infer<typeof CharacterSchema>;

export const NPCSchema = CharacterSchema.extend({
    factionId: z.string().optional(),
    behavior: z.string().optional(),
});

export type NPC = z.infer<typeof NPCSchema>;
