import { PartSchema, UnitSchema, ReadiedSchema, SizeCategorySchema, AttackProfileSchema, AbilitySchema } from './token-extras.js';
import type { SizeCategory } from './token-extras.js';
import { z } from 'zod';
import { DurationType, parseAbility, parseDurationType } from '../engine/combat/conditions.js';

export const ConditionSchema = z.object({
    id: z.string(),
    type: z.string(),
    durationType: z.string(),
    duration: z.number().optional(),
    sourceId: z.string().optional(),
    saveDC: z.number().optional(),
    saveAbility: z.string().optional(),
    ongoingEffects: z.array(z.any()).optional(),
    metadata: z.record(z.any()).optional()
});

/**
 * Caller-facing condition at encounter create: a bare name ("prone"), a
 * character-row entry ({name, duration?, source?}), or the same object with
 * the engine's duration/save fields ({type, durationType?, saveDC?,
 * saveAbility?, ...}). Normalized to ConditionSchema by normalizeConditions
 * (engine/combat/conditions.ts) before it reaches the engine.
 *
 * The object branch is strict and checked whole: anything normalizeConditions
 * would have to drop (no name, an unknown key) or read as permanent when the
 * caller meant otherwise (an unknown durationType or saveAbility, save_ends
 * without its DC and ability, rounds without a duration) fails the create —
 * the FINDINGS #93/#107 anatomy was input accepted and then quietly changed.
 * Checks live in superRefine so they report per field rather than as a bare
 * union "Invalid input".
 */
export const ConditionInputSchema = z.union([
    z.string(),
    z.object({
        id: z.string().optional(),
        type: z.string().optional(),
        name: z.string().optional(),
        durationType: z.string().optional()
            .describe(`One of ${Object.values(DurationType).join(', ')}; omitted = rounds with a duration, else permanent`),
        duration: z.number().optional().describe('Duration in rounds'),
        source: z.string().optional(),
        sourceId: z.string().optional(),
        saveDC: z.number().optional().describe('Required with durationType save_ends'),
        saveAbility: z.string().optional().describe('Ability name or abbreviation (con); required with durationType save_ends'),
        level: z.number().int().min(1).max(6).optional().describe('Exhaustion level 1-6 (2 halves speed, 3+ disadvantage on attacks and saves, 5 speed 0)')
    }).strict().superRefine((c, ctx) => {
        if (!(c.type || c.name || '').trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'condition object needs a name or type' });
        }
        const durationType = parseDurationType(c.durationType);
        if (c.durationType !== undefined && !durationType) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom, path: ['durationType'],
                message: `unknown durationType "${c.durationType}" (one of ${Object.values(DurationType).join(', ')})`
            });
        }
        if (c.saveAbility !== undefined && !parseAbility(c.saveAbility)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom, path: ['saveAbility'],
                message: `unknown saveAbility "${c.saveAbility}" (an ability name or str/dex/con/int/wis/cha)`
            });
        }
        if (durationType === DurationType.SAVE_ENDS && !((c.saveDC ?? 0) > 0 && c.saveAbility !== undefined)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'durationType save_ends needs saveDC (1+) and saveAbility, or the save never rolls and the condition never ends'
            });
        }
        if (durationType !== DurationType.SAVE_ENDS && (c.saveDC !== undefined || c.saveAbility !== undefined)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'saveDC/saveAbility only apply with durationType save_ends; without it the save never rolls'
            });
        }
        if (durationType === DurationType.ROUNDS && c.duration === undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom, path: ['duration'],
                message: 'durationType rounds needs a duration, or the condition never counts down'
            });
        }
    })
]);

// CRIT-003: Position schema for spatial combat
export const PositionSchema = z.object({
    x: z.number(),
    y: z.number(),
    z: z.number().optional()
});

export type Position = z.infer<typeof PositionSchema>;

/**
 * Grid bounds schema for spatial validation (BUG-001 fix)
 * Defines the valid coordinate range for an encounter's grid.
 * Default: 0-100 for both axes (101x101 grid)
 */
export const GridBoundsSchema = z.object({
    minX: z.number().default(0),
    maxX: z.number().default(100),
    minY: z.number().default(0),
    maxY: z.number().default(100),
    minZ: z.number().optional(),
    maxZ: z.number().optional()
});

export type GridBounds = z.infer<typeof GridBoundsSchema>;

/**
 * Default grid bounds (101x101 grid from 0-100)
 */
export const DEFAULT_GRID_BOUNDS: GridBounds = {
    minX: 0,
    maxX: 100,
    minY: 0,
    maxY: 100
};

/**
 * Size category for creatures (affects occupied squares)
 * Based on D&D 5e size categories. Defined beside the token extras so there
 * is one enum instance; re-exported here for existing importers.
 */
export { SizeCategorySchema };
export type { SizeCategory };

/**
 * Get the grid footprint (squares occupied) for a size category
 * @param size The creature's size category
 * @returns Number of squares on each side (e.g., 2 for Large = 2x2)
 */
export function getSizeFootprint(size: SizeCategory): number {
    switch (size) {
        case 'tiny':
        case 'small':
        case 'medium':
            return 1;
        case 'large':
            return 2;
        case 'huge':
            return 3;
        case 'gargantuan':
            return 4;
    }
}

export const TokenSchema = z.object({
    id: z.string(),
    name: z.string(),
    initiativeBonus: z.number(),
    initiative: z.number().optional(),  // Rolled initiative value
    isEnemy: z.boolean().optional(),    // Whether this is an enemy
    hp: z.number(),
    maxHp: z.number(),
    conditions: z.array(ConditionSchema),
    position: PositionSchema.optional(), // CRIT-003: Spatial position for movement
    // Phase 4: Movement economy
    movementSpeed: z.number().default(30), // Base speed in feet (6 squares at 5ft/square)
    movementRemaining: z.number().optional(), // Remaining movement this turn
    size: SizeCategorySchema.default('medium'), // Creature size for footprint
    abilityScores: z.object({
        strength: z.number(),
        dexterity: z.number(),
        constitution: z.number(),
        intelligence: z.number(),
        wisdom: z.number(),
        charisma: z.number()
    }).optional(),
    // Combat Stats for Auto-Resolution
    ac: z.number().optional().describe('Armor Class for auto-resolution'),
    attackDamage: z.string().optional().describe('Default attack damage (e.g., "1d6+2")'),
    attackBonus: z.number().optional().describe('Default attack bonus'),
    // Lair-action ownership — must be persisted so loadState can rebuild the
    // LAIR slot in turnOrder (see encounter.repo.ts loadState lookup).
    hasLairActions: z.boolean().optional().describe('Whether this token owns lair actions'),
    // Damage modifiers (HIGH-002) — must persist so post-load attack resolution
    // continues to honor immunities/resistances/vulnerabilities.
    resistances: z.array(z.string()).optional().describe('Damage types dealt at half damage'),
    vulnerabilities: z.array(z.string()).optional().describe('Damage types dealt at double damage'),
    immunities: z.array(z.string()).optional().describe('Damage types ignored entirely'),
    band: z.string().optional().describe("Table rules: power band"),
    regeneration: z.number().optional().describe('Table rules: HP healed at the start of each of its rounds'),
    parts: z.array(PartSchema).optional(),
    unit: UnitSchema.optional(),
    intent: z.string().optional(),
    readied: ReadiedSchema.optional(),
    // Participant extras (token-extras.ts ParticipantExtrasShape)
    reach: z.number().optional(),
    attackDamageType: z.string().optional(),
    attacksPerAction: z.number().optional(),
    attacks: z.array(AttackProfileSchema).optional(),
    abilities: z.array(AbilitySchema).optional(),
    legendaryActions: z.number().optional(),
    legendaryResistances: z.number().optional(),
    legendaryResistancesRemaining: z.number().optional(),
    autoLegendaryResistance: z.boolean().optional(),
    cr: z.number().optional()
// Tokens are engine participants; a field not listed here must still
// survive a parse (create used to strip everything off this list).
}).passthrough();

export type Token = z.infer<typeof TokenSchema>;

// CRIT-003: Terrain schema for blocking obstacles
export const TerrainSchema = z.object({
    obstacles: z.array(z.string()).default([]), // "x,y" format for blocking tiles
    difficultTerrain: z.array(z.string()).optional() // Future: 2x movement cost
});

export type Terrain = z.infer<typeof TerrainSchema>;

export const PropSchema = z.object({
    id: z.string(),
    position: z.string(), // "x,y" format
    label: z.string(),
    propType: z.enum(['structure', 'cover', 'climbable', 'hazard', 'interactive', 'decoration']),
    heightFeet: z.number().optional(),
    cover: z.enum(['none', 'half', 'three_quarter', 'full']).optional(),
    climbable: z.boolean().optional(),
    climbDC: z.number().optional(),
    breakable: z.boolean().optional(),
    hp: z.number().optional(),
    currentHp: z.number().optional(),
    description: z.string().optional()
});

export type Prop = z.infer<typeof PropSchema>;

export const EncounterSchema = z.object({
    id: z.string(),
    regionId: z.string().optional(), // Made optional as it might not always be linked to a region
    tokens: z.array(TokenSchema),
    round: z.number().int().min(0),
    activeTokenId: z.string().optional(),
    status: z.enum(['active', 'completed', 'paused']),
    terrain: TerrainSchema.optional(), // CRIT-003: Terrain obstacles
    props: z.array(PropSchema).optional(), // PHASE 1: Improvised props
    gridBounds: GridBoundsSchema.optional(), // BUG-001: Spatial boundary validation
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type Encounter = z.infer<typeof EncounterSchema>;
