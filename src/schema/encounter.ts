import { PartSchema, UnitSchema, ReadiedSchema, SizeCategorySchema, AttackProfileSchema, AbilitySchema, BuffSchema, FightingStyleSchema } from './token-extras.js';
import type { SizeCategory } from './token-extras.js';
import { z } from 'zod';
import { DurationType, parseAbility, parseDurationType } from '../engine/combat/conditions.js';
import { parseDiceTerms } from '../engine/combat/dice-terms.js';

/** Lane O: a dice expression the fight's dice can roll ('1d6', '2d4+1'), checked when it is written, not at the tick. */
const diceText = () => z.string().min(1).refine(s => { try { parseDiceTerms(s); return true; } catch { return false; } }, { message: "not a dice expression: use notation like '1d6' or '2d4+1', or a number" });

/**
 * Play report 7 follow-up (lane O): ongoing damage on a condition, as callers
 * write it (add_condition, a save rider, create's conditions). One effect or
 * a list. The road it arrives by stamps its shape: single, unless an area on
 * a unit put it there (add_condition {area, modelsInArea}; a rider from an
 * area on a unit records the standing models inside).
 */
export function ongoingInputSchema() {
    // Lenient types, checked whole in superRefine: inside the condition union a
    // type failure reads as a bare "Invalid input"; a refinement names the field.
    const one = z.object({
        damage: z.union([z.number(), z.string()]).optional().describe("Required. Each tick's damage: a whole number or dice ('1d6'), rolled once per tick on the fight's logged dice"),
        damageType: z.string().optional().describe('Resistances, immunities and vulnerabilities read it'),
        when: z.string().optional().describe("Required: 'start' | 'end', the start or the end of the bearer's turn"),
        save: z.object({
            ability: z.string().optional().describe("Required: 'dex', 'Dexterity' or 'dexterity'"),
            dc: z.number().optional().describe('Required: 1-30'),
            onSuccess: z.string().optional().describe("'none' (default: no damage that tick) | 'half' | 'end' (no damage, and the condition ends; on a unit's area the models that save leave it)")
        }).strict().optional().describe("A plain-5e save against each tick (total against the DC); a creature's failed save offers or spends legendary resistance (saveRef refunds the damage); a unit's models each save and never spend it")
    }).strict().superRefine((o, ctx) => {
        const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
        if (o.damage === undefined) issue(['damage'], "ongoing needs damage: a whole number or dice ('1d6')");
        else if (typeof o.damage === 'number' && !(Number.isInteger(o.damage) && o.damage >= 0)) issue(['damage'], `ongoing damage ${o.damage}: a whole number, 0 or more`);
        else if (typeof o.damage === 'string') { try { parseDiceTerms(o.damage); } catch { issue(['damage'], `ongoing damage '${o.damage}' is not a dice expression: use notation like '1d6' or '2d4+1', or a number`); } }
        if (o.when !== 'start' && o.when !== 'end') issue(['when'], `ongoing needs when: 'start' | 'end' (the start or the end of the bearer's turn)${o.when !== undefined ? `; '${o.when}' is neither` : ''}`);
        if (o.save) {
            if (!o.save.ability || !parseAbility(o.save.ability)) issue(['save', 'ability'], `ongoing save needs ability: an ability name or str/dex/con/int/wis/cha${o.save.ability ? `; '${o.save.ability}' is not one` : ''}`);
            if (o.save.dc === undefined || !Number.isInteger(o.save.dc) || o.save.dc < 1 || o.save.dc > 30) issue(['save', 'dc'], 'ongoing save needs dc: a whole number from 1 to 30');
            if (o.save.onSuccess !== undefined && !['none', 'half', 'end'].includes(o.save.onSuccess)) issue(['save', 'onSuccess'], `ongoing save onSuccess '${o.save.onSuccess}': one of none, half, end`);
        }
    });
    // No transform after the refinement: zod drops a dirty value at a transform, and the condition union then reads it as a bare "Invalid input".
    return z.preprocess(v => (v && typeof v === 'object' && !Array.isArray(v) ? [v] : v), z.array(one).min(1));
}

export const ONGOING_DESCRIBE = "Play report 7 follow-up: ongoing damage {damage: number | dice, damageType?, when: 'start' | 'end', save?: {ability, dc, onSuccess?: 'none' | 'half' | 'end'}} (or a list). Every tick is rolled once, logged and printed. On a unit it follows its source's shape: single-target (the default) lands on the most wounded model, capped at it, and ends when that model dies; an area (add_condition area / modelsInArea, or a rider from an area on a unit) ticks per model inside, each with its own save. See docs/table-rules/ongoing-damage.md";

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
export function conditionInputSchema() {
    return z.union([
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
        level: z.number().int().min(1).max(6).optional().describe('Exhaustion level 1-6 (2 halves speed, 3+ disadvantage on attacks and saves, 5 speed 0)'),
        ongoing: ongoingInputSchema().optional().describe(ONGOING_DESCRIBE)
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
}

/** The shared instance; schemas that sit twice inside one outer object take conditionInputSchema() instead. */
export const ConditionInputSchema = conditionInputSchema();

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

/** Sizes smallest first; sizeRank indexes this list. */
export const SIZE_ORDER: readonly SizeCategory[] = SizeCategorySchema.options;

/**
 * Squares per side, natural melee reach (5e: huge and up reach 10 ft) and the
 * carrying-capacity multiplier (5e: x2 per size above Medium, x1/2 for Tiny).
 */
export const SIZE_TABLE: Record<SizeCategory, { squares: number; reachFt: number; carryMult: number }> = {
    tiny: { squares: 1, reachFt: 5, carryMult: 0.5 },
    small: { squares: 1, reachFt: 5, carryMult: 1 },
    medium: { squares: 1, reachFt: 5, carryMult: 1 },
    large: { squares: 2, reachFt: 5, carryMult: 2 },
    huge: { squares: 3, reachFt: 10, carryMult: 4 },
    gargantuan: { squares: 4, reachFt: 10, carryMult: 8 }
};

function sizeOf(size?: string | null): SizeCategory {
    const s = (size ?? '').toLowerCase() as SizeCategory;
    return s in SIZE_TABLE ? s : 'medium';
}

/** Carrying-capacity multiplier for a size; unset or unknown reads as medium (x1). */
export function carryMultiplier(size?: string | null): number {
    return SIZE_TABLE[sizeOf(size)].carryMult;
}

/** Position in SIZE_ORDER; unset or unknown reads as medium. */
export function sizeRank(size?: string | null): number {
    return SIZE_ORDER.indexOf(sizeOf(size));
}

type Sized = { size?: string | null; reach?: number | null; position?: { x: number; y: number } | null };

/** Melee reach in feet: the attack profile's reach, then the token's, then its size. */
export function effectiveReachFt(p: Sized, profile?: { reachFt?: number | null } | null): number {
    return profile?.reachFt ?? p.reach ?? SIZE_TABLE[sizeOf(p.size)].reachFt;
}

/** Grid cells a token fills: its position is the top-left of a square footprint. */
export function footprintCells(p: Sized, at?: { x: number; y: number }): Array<{ x: number; y: number }> {
    const pos = at ?? p.position;
    if (!pos) return [];
    const n = SIZE_TABLE[sizeOf(p.size)].squares;
    const cells: Array<{ x: number; y: number }> = [];
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) cells.push({ x: pos.x + dx, y: pos.y + dy });
    return cells;
}

/**
 * Squares between two footprints (Chebyshev, edge to edge): 1 = adjacent,
 * 0 = overlapping. Infinity when either has no position.
 */
export function edgeDistanceSquares(
    a: Sized, b: Sized,
    at?: { a?: { x: number; y: number }; b?: { x: number; y: number } }
): number {
    const pa = at?.a ?? a.position, pb = at?.b ?? b.position;
    if (!pa || !pb) return Infinity;
    const na = SIZE_TABLE[sizeOf(a.size)].squares, nb = SIZE_TABLE[sizeOf(b.size)].squares;
    const gap = (a0: number, an: number, b0: number, bn: number) => Math.max(0, b0 - (a0 + an - 1), a0 - (b0 + bn - 1));
    return Math.max(gap(pa.x, na, pb.x, nb), gap(pa.y, na, pb.y, nb));
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
    fightingStyle: FightingStyleSchema.optional(),
    legendaryActions: z.number().optional(),
    legendaryResistances: z.number().optional(),
    legendaryResistancesRemaining: z.number().optional(),
    autoLegendaryResistance: z.boolean().optional(),
    cr: z.number().optional(),
    species: z.string().optional(),
    tags: z.array(z.string()).optional(),
    buffs: z.array(BuffSchema).optional()
// Tokens are engine participants; a field not listed here must still
// survive a parse (create used to strip everything off this list).
}).passthrough();

export type Token = z.infer<typeof TokenSchema>;

// CRIT-003: Terrain schema for blocking obstacles
export const TerrainSchema = z.object({
    obstacles: z.array(z.string()).default([]), // "x,y" format for blocking tiles
    difficultTerrain: z.array(z.string()).optional(), // Future: 2x movement cost
    water: z.array(z.string()).optional() // "x,y" cells a token swims in (the underwater rules apply there)
});

export type Terrain = z.infer<typeof TerrainSchema>;

/**
 * The medium a fight happens in. Water (or a token on a terrain.water cell)
 * turns on the underwater rules: swim speed or half speed, no ranged
 * attacks unless rangedAllowed, melee at disadvantage unless the damage
 * type is in the list or the attacker carries the swim tag, and pressure
 * damage at the start of each turn below the threshold.
 */
export const ENVIRONMENT_MEDIA = ['air', 'water', 'vacuum'] as const;
export const EnvironmentSchema = z.object({
    medium: z.enum(ENVIRONMENT_MEDIA).default('air'),
    depthFt: z.number().min(0).optional().describe('Depth of the water, in feet (pressure compares against it)'),
    pressure: z.object({
        startsAtFt: z.number().min(0).describe('Pressure damage applies at this depth or deeper'),
        damagePerRound: z.union([z.number().int().min(0), diceText()]).describe('Damage at the start of each turn: a number or dice'),
        unlessTag: z.string().optional().describe('Tokens with this tag are spared (default: the swim tag)'),
        // Play report 7 follow-up (lane O): pressure is an area (the owner: "every model in the deep water takes it, each separately").
        damageType: z.string().optional().describe('Play report 7 follow-up: the damage type (resistances read it, per model on a unit)'),
        save: z.object({
            ability: z.string().refine(a => !!parseAbility(a), { message: 'an ability name or str/dex/con/int/wis/cha' }),
            dc: z.number().int().min(1).max(30),
            half: z.boolean().optional().describe('A success halves it (default true; false: a success takes none)')
        }).optional().describe("Play report 7 follow-up: a plain-5e save against each turn's pressure: one for a creature (legendary resistance offered or spent, saveRef refunds), one per model of a unit (never its legendary resistance)")
    }).optional(),
    rangedAllowed: z.boolean().optional().describe('Allow ranged attacks underwater (default false)'),
    light: z.enum(['bright', 'dim', 'darkness']).optional().describe("Play report 5 #1: the light in the fight. 'darkness' lets a token attempt a Hide from any foe without darkvision (canHide in the state view)"),
    meleeDisadvantageUnlessDamageType: z.array(z.string()).optional().describe("Damage types that swing freely underwater (default ['piercing'])"),
    swimTag: z.string().optional().describe("Token tag that marks a swimmer: no melee penalty, pressure-adapted (default 'aquatic')")
});

export type EncounterEnvironment = z.infer<typeof EnvironmentSchema>;

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
    environment: EnvironmentSchema.optional(), // The medium the fight happens in (air, water, vacuum)
    props: z.array(PropSchema).optional(), // PHASE 1: Improvised props
    gridBounds: GridBoundsSchema.optional(), // BUG-001: Spatial boundary validation
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type Encounter = z.infer<typeof EncounterSchema>;
