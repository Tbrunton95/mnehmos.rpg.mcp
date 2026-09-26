/**
 * Token extras from the 40k field report: named body parts with states,
 * mortal units as one token, and telegraphed intent / readied actions.
 */
import { z } from 'zod';

export const PART_KINDS = ['head', 'arm', 'leg', 'wing', 'torso', 'system', 'other'] as const;
export const PART_STATES = ['intact', 'crippled', 'dead', 'latched', 'breached'] as const;

export const PartSchema = z.object({
    name: z.string().min(1).describe("The part's name ('middle head', 'left elbow', 'front plate')"),
    kind: z.enum(PART_KINDS).default('other').describe('leg or wing halves speed when crippled'),
    state: z.enum(PART_STATES).default('intact'),
    latchedTo: z.object({
        participantId: z.string(),
        part: z.string().optional()
    }).optional().describe('latched: who (and which part) this part holds'),
    note: z.string().optional(),
    holds: z.array(z.string()).optional().describe("Weapons or slots this part wields ('axe', 'mainhand'); an attack naming one uses this part"),
    ac: z.number().int().min(0).optional().describe('AC to hit this part when aimed at'),
    hp: z.number().int().min(0).optional().describe('A part with its own HP takes aimed damage instead of the body'),
    maxHp: z.number().int().min(1).optional(),
    breakAt: z.number().int().min(1).optional().describe('One aimed hit dealing at least this much breaks (severs) the part')
});
export type Part = z.infer<typeof PartSchema>;

/**
 * Creature size (D&D 5e categories). One enum instance, shared by tokens,
 * participant extras and the character sheet.
 */
export const SizeCategorySchema = z.enum([
    'tiny',      // 2.5ft, shares space
    'small',     // 5ft, 1 square
    'medium',    // 5ft, 1 square
    'large',     // 10ft, 2x2 squares
    'huge',      // 15ft, 3x3 squares
    'gargantuan' // 20ft+, 4x4+ squares
]);
export type SizeCategory = z.infer<typeof SizeCategorySchema>;

/** A named attack: its bonus, damage and the part that makes it ('whip' in the left arm). */
export const AttackProfileSchema = z.object({
    name: z.string().min(1).describe("Profile name ('axe', 'whip'); attack {using} picks it"),
    attackBonus: z.number().int(),
    damage: z.union([z.number(), z.string()]).describe("Flat damage or dice ('2d8+6')"),
    damageType: z.string().optional(),
    part: z.string().optional().describe('The part that makes this attack (its state applies)'),
    reachFt: z.number().int().min(0).optional().describe('Reach in feet when longer than the creature\'s own'),
    ranged: z.boolean().optional(),
    default: z.boolean().optional().describe('Used when an attack names no profile'),
    note: z.string().optional()
});
export type AttackProfile = z.infer<typeof AttackProfileSchema>;

/** A limited ability ('Hellfire Breath', recharge 5-6). */
export const AbilitySchema = z.object({
    name: z.string().min(1),
    recharge: z.number().int().min(2).max(6).optional().describe('Recharges on a d6 roll of this or higher at the start of its turn'),
    ready: z.boolean().default(true),
    note: z.string().optional()
});
export type Ability = z.infer<typeof AbilitySchema>;

/**
 * Participant extras shared by combat_manage create, add_participant and the
 * internal create_encounter schema. A plain shape so each schema can spread
 * it; outer mirrors list the same keys flat (arrays of objects as z.any).
 */
export const ParticipantExtrasShape = {
    size: SizeCategorySchema.optional().describe('tiny | small | medium | large | huge | gargantuan (default medium)'),
    reach: z.number().int().min(0).optional().describe('Melee reach in feet (default from size: 5, or 10 for huge and up)'),
    movementSpeed: z.number().int().min(0).optional().describe('Speed in feet (default 30)'),
    attackBonus: z.number().int().optional().describe('Default attack bonus'),
    attackDamage: z.string().optional().describe("Default attack damage ('1d6+2')"),
    attackDamageType: z.string().optional().describe('Damage type of the default attack'),
    attacksPerAction: z.number().int().min(1).optional().describe('Multiattack: attacks one Attack action allows (default 1)'),
    attacks: z.array(AttackProfileSchema).optional().describe('Named attack profiles {name, attackBonus, damage, damageType?, part?, reachFt?, default?}'),
    abilities: z.array(AbilitySchema).optional().describe('Limited abilities {name, recharge?, ready?}'),
    legendaryActions: z.number().int().min(0).optional().describe('Legendary actions per round'),
    legendaryResistances: z.number().int().min(0).optional().describe('Legendary resistances per day'),
    legendaryResistancesRemaining: z.number().int().min(0).optional().describe('Legendary resistances left (defaults to the full count)'),
    autoLegendaryResistance: z.boolean().optional().describe('Spend a legendary resistance on a failed save automatically'),
    hasLairActions: z.boolean().optional().describe('Adds a LAIR slot at initiative 20 to the turn order'),
    cr: z.number().min(0).optional().describe('Challenge rating')
};

export const UnitTierSchema = z.object({
    minFraction: z.number().min(0).max(1).describe('Fraction of models still standing for this tier'),
    dice: z.string().min(1).describe("Volley damage at this tier ('4d6')")
});

export const UnitSchema = z.object({
    models: z.number().int().min(1).describe('Models at full strength'),
    hpPerModel: z.number().int().min(1),
    packed: z.boolean().default(false).describe('Packed units can be cleaved; spaced ones cannot'),
    attackBonus: z.number().int().default(0).describe('Volley attack bonus against AC'),
    tiers: z.array(UnitTierSchema).min(1).optional().describe('Highest first. Default 4d6 ≥75%, 3d6 ≥50%, 2d6 ≥25%, 1d6 below'),
    suppressed: z.boolean().optional(),
    inMelee: z.boolean().optional(),
    brokenFormation: z.boolean().optional(),
    morale: z.number().int().optional().describe("The unit's morale, shown on a BREAK TEST DUE line (the GM rolls the test)"),
    breakAt: z.number().gt(0).lt(1).optional().describe('Fraction of models: dropping through it owes a break test (default 0.5)'),
    routed: z.boolean().optional().describe('Routed: cannot volley and owes no more break tests (set_unit)')
});
export type Unit = z.infer<typeof UnitSchema>;

/** Triggers the engine can see for itself during a move. */
export const READIED_TRIGGERS = ['enters_reach', 'leaves_reach'] as const;

/** The attack a readied action makes when it fires; omitted fields come from the token. */
export const ReadiedAttackSchema = z.object({
    using: z.string().optional().describe('Named attack profile on the token'),
    attackBonus: z.number().int().optional(),
    damage: z.union([z.number(), z.string()]).optional(),
    damageType: z.string().optional(),
    withPart: z.string().optional().describe('The part that makes the attack')
});
export type ReadiedAttack = z.infer<typeof ReadiedAttackSchema>;

export const ReadiedSchema = z.object({
    action: z.string().min(1),
    trigger: z.string().min(1),
    on: z.enum(READIED_TRIGGERS).optional().describe('enters_reach | leaves_reach: the engine watches moves for it. Unset = free text, fired by hand with trigger_readied'),
    watch: z.string().optional().describe("Who sets it off: a participant id or name, 'enemy' (default) or 'any'"),
    attack: ReadiedAttackSchema.optional().describe('{using?, attackBonus?, damage?, damageType?, withPart?}: with this the readied attack fires itself as a reaction')
});
export type Readied = z.infer<typeof ReadiedSchema>;
