/**
 * Token extras from the 40k field report: named body parts with states,
 * mortal units as one token, and telegraphed intent / readied actions.
 */
import { z } from 'zod';
import { IGNORE_COVER, ignoreCoverSchema, IGNORE_COVER_DESCRIBE } from './cover.js';
import { deathSaveModeSchema } from '../engine/combat/dying.js';

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
    breakAt: z.number().int().min(1).optional().describe('One aimed hit dealing at least this much breaks (severs) the part'),
    role: z.string().optional().describe("Vessel sections (kind system): drive | guns | bridge | reactor | hangar | other; the engine reads crippled or dead sections by role")
});
export type Part = z.infer<typeof PartSchema>;

/**
 * Request 5: what makes a token a vessel. Hull is its HP, sections are its
 * `system` parts, shields a {current, max} pool the engine drains before
 * the hull and refills by regenPerRound at the start of its turn.
 */
export const VesselProfileSchema = z.object({
    regenPerRound: z.number().int().min(0).default(0),
    /** sectionName → role, for parts that carry no role of their own. */
    roles: z.record(z.string(), z.string()).default({}),
    speed: z.number().int().min(0).optional(),
    crew: z.number().int().min(0).optional(),
    sizeLabel: z.string().optional().describe("The rule's size word when it is not a 5e category ('colossal')"),
    traits: z.array(z.string()).optional(),
    /** A spatial network (room_nodes.network_id) holding the vessel's deck plan; board lists its rooms. */
    networkId: z.string().optional()
}).passthrough();
export type VesselProfile = z.infer<typeof VesselProfileSchema>;

export const ShieldsSchema = z.object({
    current: z.number().min(0),
    max: z.number().min(0)
});
export type Shields = z.infer<typeof ShieldsSchema>;

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

/**
 * Item 17: the fighting styles the engine applies by itself. archery: +2 to
 * hit on a ranged attack. great_weapon: weapon dice of 1 or 2 are rerolled
 * once on a two-handed melee hit (crit dice too; never added dice such as a
 * superiority die). dueling: +2 damage on a one-handed melee hit (not with
 * twoHanded, not hand: 'offhand'). defense: +1 AC when the target's AC is
 * derived from its sheet or token and it wears armour: if the sheet's ac
 * already counts it, do not set defense (or pass dc) or it counts twice.
 * two_weapon is not listed: the engine never subtracted the off-hand
 * modifier, so there is nothing for it to lift.
 */
export const FIGHTING_STYLES = ['great_weapon', 'dueling', 'archery', 'defense'] as const;
export const FightingStyleSchema = z.enum(FIGHTING_STYLES);
export type FightingStyle = z.infer<typeof FightingStyleSchema>;

/**
 * Play report 5, item 3: the trigger a profile needs. A fresh instance each
 * call: the attack schema and the outer mirror must not hold one zod object twice.
 */
export const attackRequiresSchema = () => z.object({
    dashed: z.boolean().optional().describe('The attacker must have taken the Dash action this turn'),
    movedAtLeast: z.number().int().min(0).optional().describe("Feet the attacker must have moved this turn (after the Dash when dashed is set). A token without a position uses the call's movedFt and the reply says it was declared"),
    hitThisTurn: z.boolean().optional().describe('The attacker must have hit this target with a melee attack this turn')
});
export type AttackRequires = z.infer<ReturnType<typeof attackRequiresSchema>>;

/** A named attack: its bonus, damage and the part that makes it ('whip' in the left arm). */
export const AttackProfileSchema = z.object({
    bonusAction: z.boolean().optional().describe("A bonus-action attack (Goring Rush, an off-hand strike): attack {using} spends the bonus action, not the Attack action, on the actor's own turn only"),
    requires: attackRequiresSchema().optional().describe('The trigger this attack needs: {dashed?, movedAtLeast?, hitThisTurn?} — refused with nothing spent when it is not met, naming what is missing'),
    name: z.string().min(1).describe("Profile name ('axe', 'whip'); attack {using} picks it"),
    attackBonus: z.number().int(),
    damage: z.union([z.number(), z.string()]).describe("Flat damage or dice ('2d8+6')"),
    damageType: z.string().optional(),
    part: z.string().optional().describe('The part that makes this attack (its state applies)'),
    item: z.string().optional().describe("The inventory item this profile swings ('Chainsword', an item id or instance id). world_manage reconcile flags a profile whose item the character no longer holds"),
    reachFt: z.number().int().min(0).optional().describe('Reach in feet when longer than the creature\'s own'),
    ranged: z.boolean().optional().describe('A ranged weapon: archery applies, great weapon fighting and dueling do not. Unset: read from the grid when both tokens are placed, else melee'),
    twoHanded: z.boolean().optional().describe('Wielded in both hands: great weapon fighting applies, dueling does not'),
    default: z.boolean().optional().describe('Used when an attack names no profile'),
    ignoreCover: z.enum(IGNORE_COVER).optional().describe("Play report 5 #1: this weapon ignores cover by itself: 'half-and-three-quarters' (Sharpshooter) or 'all'; total cover still refuses unless 'all'"),
    breaksCover: z.boolean().optional().describe("Play report 5 #1: swinging it drops the attacker's own standing cover for the round (a charge out of the rubble)"),
    note: z.string().optional()
});
export type AttackProfile = z.infer<typeof AttackProfileSchema>;

/** A limited ability ('Hellfire Breath', recharge 5-6; 'Second Wind', perRest short). */
export const AbilitySchema = z.object({
    name: z.string().min(1),
    recharge: z.number().int().min(2).max(6).optional().describe('Recharges on a d6 roll of this or higher at the start of its turn'),
    ready: z.boolean().default(true),
    grantsAction: z.boolean().optional().describe('Using it gives one extra action this turn (Action Surge): it costs nothing, is spent on use, and is used on its own turn'),
    actionCost: z.enum(['action', 'bonus', 'reaction', 'none']).optional().describe("What using it costs (default action; none when grantsAction). action|bonus only on its own turn"),
    perRest: z.enum(['short', 'long']).optional().describe('Spent on use (mirrored to the sheet) and readied by a rest: short = any rest, long = a long rest only'),
    note: z.string().optional()
});
export type Ability = z.infer<typeof AbilitySchema>;

/**
 * The same ability as a participant input (combat_manage create,
 * add_participant): `ready` stays unset when the caller did not say, so the
 * sheet's spent state can win (hydrateExtras). The token is normalised to a
 * boolean before it is stored.
 */
export const AbilityInputSchema = AbilitySchema.extend({
    ready: z.boolean().optional().describe('Unset: the sheet decides (a spent perRest ability stays spent); true/false is kept as sent')
});
export type AbilityInput = z.infer<typeof AbilityInputSchema>;

/**
 * Who counts as 'nearby' for a Waaagh! (a spell's nearby bonus, a battle
 * cry, mob rule): every key given must match. species reads the token's
 * species, else the character sheet's race; tag reads the token's tags.
 * A factory, so each schema that embeds it gets its own instance.
 */
export const nearbyMatchSchema = () => z.object({
    band: z.string().optional().describe('Same band (any case)'),
    species: z.string().optional().describe("Token species or the sheet's race (any case): 'Orruk'"),
    tag: z.string().optional().describe("One of the token's tags (any case)"),
    nameIncludes: z.string().optional().describe('Part of the name (any case)')
});
export type NearbyMatch = z.infer<ReturnType<typeof nearbyMatchSchema>>;

/**
 * A battle-cry buff on a token (combat_manage battle_cry). It lasts until
 * the start of its source's turn after untilRound.
 */
export const BuffSchema = z.object({
    name: z.string().min(1),
    source: z.string().describe('Who called it (name)'),
    sourceId: z.string().optional().describe('Who called it (participant id); the buff expires at the start of their turn after untilRound'),
    untilRound: z.number().int(),
    attackAdvantage: z.boolean().optional(),
    damageBonus: z.union([z.number(), z.string()]).optional().describe("Added to damage on a hit: a number or dice ('1d4'), rolled on the encounter's dice"),
    speedBonus: z.number().optional().describe('Feet added to speed'),
    moraleBonus: z.number().optional().describe('Added to morale on a break test')
});
export type Buff = z.infer<typeof BuffSchema>;

/**
 * Play report 5 #8a: the senses a sheet or token sees with, in feet. Spatial
 * look reads them in a DARKNESS room, the status block shows them, tokens
 * carry them for display. A fresh instance each call: outer schemas never
 * share one zod instance twice.
 */
export const SENSE_KEYS = ['darkvisionFt', 'blindsightFt', 'tremorsenseFt', 'truesightFt'] as const;
export const sensesSchema = () => z.object({
    darkvisionFt: z.number().int().min(0).optional().describe('Darkvision in feet: darkness seen as dim light (no colour; sight-based Perception at disadvantage)'),
    blindsightFt: z.number().int().min(0).optional().describe('Blindsight in feet: perceives without sight; darkness does not hinder it'),
    tremorsenseFt: z.number().int().min(0).optional().describe('Tremorsense in feet: vibrations through the ground'),
    truesightFt: z.number().int().min(0).optional().describe('Truesight in feet: sees in darkness, through illusions and invisibility')
}).strict();
export type Senses = z.infer<ReturnType<typeof sensesSchema>>;

/**
 * Play report 5 #8b: natural armour, the AC floor worn armour must beat.
 * Unarmoured AC is the higher of 10 + DEX and base + DEX; shields and every
 * other equipped acBonus add on top of whichever wins.
 */
export const naturalArmorSchema = () => z.object({
    base: z.number().int().min(0).describe('Base AC of the hide or plates (12 for a thick hide)'),
    addDex: z.boolean().default(true).describe('Add the DEX modifier (default true)'),
    maxDex: z.number().int().min(0).optional().describe('Cap on the DEX modifier added')
}).strict();
export type NaturalArmor = z.infer<ReturnType<typeof naturalArmorSchema>>;

/**
 * Play report 5 #8c: a conditional skill trait as data. Advantage on the
 * listed skills when a check is tagged with `when` (roll_skill_check
 * {context: ['scent']}); passiveBonus (default 5) lifts the passive for that
 * sense (passive Perception (scent) 16). The same shape covers Stonecunning
 * (history, stonework), Keen Hearing (perception, hearing), Sure-Footed
 * (acrobatics, ice).
 */
export const skillAdvantageTraitSchema = () => z.object({
    name: z.string().min(1).describe("The trait's name ('Keen Smell')"),
    skills: z.array(z.string().min(1)).min(1).describe("Skills it covers (['perception', 'survival'])"),
    when: z.string().min(1).describe("The context tag that fires it ('scent'); a check passes context: ['scent']"),
    passiveBonus: z.number().int().optional().describe('Added to the passive for this sense (default 5, advantage on a passive)'),
    note: z.string().optional().describe("What it covers in prose ('scent-based Perception; tracking by scent')")
}).strict();
export type SkillAdvantageTrait = z.infer<ReturnType<typeof skillAdvantageTraitSchema>>;

/**
 * Participant extras shared by combat_manage create, add_participant and the
 * internal create_encounter schema. A plain shape so each schema can spread
 * it; outer mirrors list the same keys flat (arrays of objects as z.any).
 */
export const ParticipantExtrasShape = {
    size: SizeCategorySchema.optional().describe('tiny | small | medium | large | huge | gargantuan (default medium)'),
    reach: z.number().int().min(0).optional().describe('Melee reach in feet (default from size: 5, or 10 for huge and up)'),
    movementSpeed: z.number().int().min(0).optional().describe('Speed in feet (default 30)'),
    swimSpeed: z.number().int().min(0).optional().describe('Swim speed in feet: the movement budget underwater (else half speed)'),
    flySpeed: z.number().int().min(0).optional().describe('Fly speed in feet'),
    senses: sensesSchema().optional().describe('Senses in feet {darkvisionFt, blindsightFt, tremorsenseFt, truesightFt}; default from the sheet; shown on the token'),
    attackBonus: z.number().int().optional().describe('Default attack bonus'),
    attackDamage: z.string().optional().describe("Default attack damage ('1d6+2')"),
    attackDamageType: z.string().optional().describe('Damage type of the default attack'),
    attacksPerAction: z.number().int().min(1).optional().describe('Multiattack: attacks one Attack action allows (default 1)'),
    attacks: z.array(AttackProfileSchema).optional().describe('Named attack profiles {name, attackBonus, damage, damageType?, part?, reachFt?, default?, ignoreCover?, breaksCover?}'),
    ignoreCover: ignoreCoverSchema().optional().describe(IGNORE_COVER_DESCRIBE),
    abilities: z.array(AbilityInputSchema).optional().describe('Limited abilities {name, recharge?, perRest?: short | long, grantsAction?, actionCost?, ready?}; ready unset lets a spent sheet ability stay spent'),
    legendaryActions: z.number().int().min(0).optional().describe('Legendary actions per round'),
    legendaryResistances: z.number().int().min(0).optional().describe('Legendary resistances per day'),
    legendaryResistancesRemaining: z.number().int().min(0).optional().describe('Legendary resistances left (defaults to the full count)'),
    autoLegendaryResistance: z.boolean().optional().describe('Spend a legendary resistance on a failed save automatically'),
    hasLairActions: z.boolean().optional().describe('Adds a LAIR slot at initiative 20 to the turn order'),
    cr: z.number().min(0).optional().describe('Challenge rating'),
    species: z.string().optional().describe("Species ('Orruk'): nearby counts and battle cries match it"),
    tags: z.array(z.string()).optional().describe("Free tags ('mob', 'ladz') that nearby matches read"),
    fightingStyle: FightingStyleSchema.optional().describe('great_weapon | dueling | archery | defense: applied by the engine on its attacks (defense on attacks against it); default from the sheet'),
    deathSaves: z.boolean().optional().describe('Play report 5 #5: tracks death saves at 0 HP (default from the character row: pc/npc yes, enemy no; a token with no row is a mook and just dies). true opts a sheetless villain in, false opts a named character out'),
    deathSaveMode: deathSaveModeSchema().optional().describe("Play report 5 #5: auto (the engine rolls the save on advance) | prompt (DEATH SAVE DUE; advance refused until death_save). Default from the sheet, else the world's environment.deathSaveMode, else auto")
};

export const UnitTierSchema = z.object({
    minFraction: z.number().min(0).max(1).describe('Fraction of models still standing for this tier'),
    dice: z.string().min(1).describe("Volley damage at this tier ('4d6')")
});

/**
 * Mob rule: +1 morale on a break test per `per` live models (plus the
 * models of allied units nearby, when set), capped at maxBonus; +1 to hit
 * per attackBonusPer live models.
 */
export const mobRuleSchema = () => z.object({
    per: z.number().int().min(1).describe('Live models per +1 morale'),
    maxBonus: z.number().int().min(0).optional().describe('Cap on the morale bonus'),
    attackBonusPer: z.number().int().min(1).optional().describe('Live models per +1 to hit'),
    nearby: z.object({
        range: z.number().min(0).describe('Feet, edge to edge'),
        match: nearbyMatchSchema().default({})
    }).optional().describe("Allied units in range add their live models to the morale count")
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
    routed: z.boolean().optional().describe('Routed: cannot volley and owes no more break tests (set_unit)'),
    mobRule: mobRuleSchema().optional().describe('Mob rule: morale (and to-hit) grow with the models standing')
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
    withPart: z.string().optional().describe('The part that makes the attack'),
    twoHanded: z.boolean().optional().describe('Swung in both hands (great weapon fighting; no dueling); default from the profile')
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
