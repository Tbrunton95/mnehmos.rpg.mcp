import type { Part, Unit, Readied, AttackProfile, Ability as AbilityProfile, Buff, VesselProfile, Shields, FightingStyle, Senses } from '../../schema/token-extras.js';
import { fightingStyleEffects } from './fighting-style.js';
import { absorbWithShields, roleState, sectionRole } from './vessel.js';
import { damageWithModifiers } from './damage-modifiers.js';
import { findPart as findNamedPart, matchProfile } from './parts.js';
import { CombatRNG, CheckResult, checkDegreeOf } from './rng.js';
import { Condition, ConditionType, DurationType, Ability, CONDITION_EFFECTS, conditionAttackModifiers, conditionSpeedFactor } from './conditions.js';

import { SizeCategory, GridBounds, edgeDistanceSquares, effectiveReachFt, type EncounterEnvironment } from '../../schema/encounter.js';
import { resolveCover, coverArithmetic, ignoredCoverLine, totalCoverRefusal, ignoreCoverFor, type CoverResolution, type StandingCover, type IgnoreCoverScopes, type IgnoreCover } from './cover.js';
import { mobAttackBonus } from './units.js';
import { nonlethalSource, isNonlethalUnconscious, clearNonlethalUnconscious } from './nonlethal.js';
import { controlledMountOf, isControlledMount } from './mounts.js';
import { applyDeathSaveOutcome, damageAtZero, deathSaveCall, dyingLabel, dyingTail, isDying, outcomeOfRoll, wakeFromDying, markStable, counters as deathCounters, type DeathSaveMode, type DeathSaveOutcome, type DeathSaveResult, type DyingUpdate } from './dying.js';
import { offTurnEconomyNote } from './turn-guard.js';
import { hasSides, purposeWithSources, rollSidesNote, type DeclaredSides, type InitiativeDeclared } from '../attack-advantage.js';
import { conditionSaveDisadvantage, tokenSaveConditions } from '../advantage-sources.js';
export type { DeathSaveResult, DyingUpdate, DeathSaveMode, DeathSaveOutcome } from './dying.js';

/**
 * Character interface for combat participants
 *
 * D&D 5e legendary creature properties:
 * - legendaryActions: Total actions available (usually 3)
 * - legendaryActionsRemaining: Actions left this round (resets at start of their turn)
 * - legendaryResistances: Total resistances (usually 3/day)
 * - legendaryResistancesRemaining: Resistances left (does NOT reset between rounds)
 * - hasLairActions: Whether this creature can use lair actions on initiative 20
 *
 * Spatial combat properties (Phase 1-4):
 * - position: Current grid position
 * - movementSpeed: Base speed in feet (default 30)
 * - movementRemaining: Remaining movement this turn
 * - size: Creature size category (affects footprint)
 */
export interface CombatParticipant {
    id: string;
    name: string;
    initiativeBonus: number;
    initiative?: number;  // Rolled initiative value (set when encounter starts)
    isEnemy?: boolean;    // Whether this is an enemy (for turn automation)
    hp: number;
    maxHp: number;
    conditions: Condition[];
    position?: { x: number; y: number; z?: number };  // CRIT-003: Spatial position
    // Phase 4: Movement economy
    movementSpeed?: number;       // Base speed in feet (default 30)
    swimSpeed?: number;           // Swim speed in feet: the budget underwater (else half movementSpeed)
    flySpeed?: number;            // Fly speed in feet
    senses?: Senses;              // Play report 5 #8a: senses in feet (darkvision, blindsight, tremorsense, truesight), from the sheet; display and hiding read them
    movementRemaining?: number;   // Remaining movement this turn (in feet)
    size?: SizeCategory;          // Creature size for footprint calculation
    hasDashed?: boolean;          // Whether dash action was used this turn
    dashes?: number;              // Dash actions taken this turn (each adds a speed allotment to the move budget)
    extraActions?: number;        // Extra actions banked this turn (Action Surge); cleared when the turn ends
    surprised?: boolean;          // Caught flat-footed: its round-1 turn passes and it cannot react until it has
    isDodging?: boolean;          // Dodge: attacks against it roll at disadvantage until its next turn
    helpedBy?: string;            // Help: advantage on its next attack, granted by this participant
    band?: string;                // Table rules: power band (see table_rules band)
    bandAssumed?: boolean;        // Play report 7 #3: band is the world's lowest, assumed at create (nothing gave one); set_band clears it
    regeneration?: number;        // Table rules: HP healed at the start of each of its own turns
    parts?: Part[];               // Named body parts with states (crippled, dead, latched, breached)
    unit?: Unit;                  // A mortal unit as one token (models, volley tiers)
    intent?: string;              // Telegraphed intent; clears when its turn ends
    readied?: Readied;            // A readied action; stays until triggered
    // HIGH-002: Damage modifiers
    resistances?: string[];    // Damage types that deal half damage
    vulnerabilities?: string[]; // Damage types that deal double damage
    immunities?: string[];      // Damage types that deal no damage
    // HIGH-003: Opportunity attack tracking
    reactionUsed?: boolean;    // Whether reaction has been used this round
    hasDisengaged?: boolean;   // Whether creature took disengage action this turn
    // ACTION ECONOMY
    actionUsed?: boolean;          // Has used main Action this turn
    bonusActionUsed?: boolean;     // Has used Bonus Action this turn
    spellsCast?: {                 // Track spells cast this turn for Bonus Action Rule
        action?: number;           // Level of spell cast as Action
        bonus?: number;            // Level of spell cast as Bonus Action
        reaction?: number;         // Level of spell cast as Reaction
    };
    // LEGENDARY CREATURE SUPPORT
    legendaryActions?: number;           // Total legendary actions per round (usually 3)
    legendaryActionsRemaining?: number;  // Remaining legendary actions this round
    legendaryResistances?: number;       // Total legendary resistances (usually 3/day)
    legendaryResistancesRemaining?: number; // Remaining legendary resistances
    hasLairActions?: boolean;            // Can use lair actions on initiative 20
    abilityScores?: {
        strength: number;
        dexterity: number;
        constitution: number;
        intelligence: number;
        wisdom: number;
        charisma: number;
    };
    // MED-003: Death Saving Throw tracking
    deathSaveSuccesses?: number;  // 0-3, 3 = stabilized
    deathSaveFailures?: number;   // 0-3, 3 = dead
    isStabilized?: boolean;       // Unconscious but won't die
    isDead?: boolean;             // Permanently defeated
    // Play report 5 #5 (dying): who tracks death saves and how the slot behaves.
    deathSaves?: boolean;         // Tracks death saves at 0 HP (hydrated from the character row: pc/npc yes, enemy no; combat_profile.deathSaves overrides). Unset = a mook: dies at 0
    deathSaveMode?: DeathSaveMode; // auto (the engine rolls on advance) | prompt (DEATH SAVE DUE, advance refused until rolled); unset = the world's environment.deathSaveMode, else auto
    deathSaveRound?: number;      // The round the last death save was rolled or posted in
    deathSaveDue?: boolean;       // Prompt mode: its slot is up and the save has not been rolled
    deathSaveTaken?: boolean;     // A save rolled or posted by hand (death_save) before the slot: it is that slot's save, the engine rolls no second one
    // COMBAT STATS (Auto-resolution)
    /**
     * Armor Class. Used by the attack resolver. If omitted, the engine falls
     * back to a derived value (10 + initiativeBonus/2) for legacy compatibility.
     */
    ac?: number;
    attackDamage?: string;     // Default attack damage (e.g., "1d6+2")
    attackDamageType?: string; // Damage type of the default attack (resistances on opportunity attacks)
    attackBonus?: number;      // Default attack bonus used if none provided
    // PARTICIPANT EXTRAS (token-extras.ts ParticipantExtrasShape)
    reach?: number;                  // Melee reach in feet (default from size)
    attacksPerAction?: number;       // Multiattack: attacks one Attack action allows
    attacksMade?: number;            // Attacks made with this turn's Attack action
    attacks?: AttackProfile[];       // Named attack profiles (axe, whip), each with its part
    abilities?: AbilityProfile[];    // Limited abilities (recharge 5-6)
    autoLegendaryResistance?: boolean; // Spend a legendary resistance on a failed save automatically
    cr?: number;                     // Challenge rating
    lairUsedRound?: number;          // Round the lair action was last used (lair owner only)
    species?: string;                // 'Orruk': nearby counts and battle cries match it
    tags?: string[];                 // Free tags nearby matches read
    buffs?: Buff[];                  // Battle-cry buffs (combat_manage battle_cry)
    fightingStyle?: FightingStyle;   // Item 17: applied by executeAttack on its attacks (defense: by the handler on attacks against it)
    lastMeleeMisses?: Array<{ attackerId: string; round: number }>; // Item 16: who missed this token in melee this round (riposte)
    // Play report 5 #1: standing cover (combat_manage set_cover), the round an attack with breaksCover dropped it, and a feature that ignores cover.
    cover?: StandingCover;
    coverBrokenRound?: number;
    ignoreCover?: IgnoreCoverScopes;
    // Play report 5, item 3: per-turn movement and hits for trigger-tied attacks (Goring Rush).
    movedThisTurn?: number;          // Feet walked this turn (the move handler adds them; reset at turn start)
    movedSinceDash?: number;         // Feet walked since this turn's Dash (Dash resets it; requires.dashed + movedAtLeast reads it)
    meleeHitsThisTurn?: string[];    // Targets this token hit in melee this turn (requires.hitThisTurn)
    // Play report 7 #6: any combat action this token took this turn (a free one, a placement); reset at its turn start. The PC turn guard reads it.
    actedThisTurn?: boolean;
    // Play report 7 #5: a standing order 'take them alive': opportunity attacks and readied melee swings are non-lethal.
    subdue?: boolean;
    // Play report 7 #10: rider and mount. The rider carries mountedOn; the mount carries riderId, and controlledBy when the rider controls it.
    mountedOn?: string;
    riderId?: string;
    controlledBy?: string;
    // REQUEST 5: the void-combat lane (a token made from a create_vessel row)
    vessel?: VesselProfile;          // Section roles, shield regen; marks the token a vessel
    shields?: Shields;               // Drained before the hull; regen at the start of its turn
    reactorBreach?: boolean;         // A reactor section is dead: a d6 at each turn start, 1 destroys it
}

/**
 * Combat state tracking
 */
export interface CombatState {
    participants: CombatParticipant[];
    /** RNG stream position (CombatRNG.snapshot), refreshed by getState() and persisted with the encounter. */
    rngState?: object;
    turnOrder: string[]; // IDs in initiative order (may include 'LAIR' for lair actions)
    currentTurnIndex: number;
    round: number;
    terrain?: {  // CRIT-003: Terrain configuration
        obstacles: string[];  // "x,y" format blocking tiles
        difficultTerrain?: string[];
        water?: string[];  // Water terrain (streams, rivers): a token standing there swims
    };
    /** The medium the fight happens in (air unless set). Water turns on the underwater rules. */
    environment?: EncounterEnvironment;
    props?: Array<{  // Improvised props/objects (trees, ladders, buildings, etc.)
        id: string;
        position: string;  // "x,y" format
        label: string;     // Free-text label
        propType: 'structure' | 'cover' | 'climbable' | 'hazard' | 'interactive' | 'decoration';
        heightFeet?: number;
        cover?: 'none' | 'half' | 'three_quarter' | 'full';
        climbable?: boolean;
        climbDC?: number;
        breakable?: boolean;
        hp?: number;
        currentHp?: number;
        description?: string;
    }>;
    gridBounds?: GridBounds;   // Phase 2: Spatial boundary validation (BUG-001 fix)
    hasLairActions?: boolean;  // Whether any participant has lair actions
    lairOwnerId?: string;      // ID of the creature that owns the lair
}

/**
 * Result of a combat action with full transparency
 */
export interface CombatActionResult {
    type: 'attack' | 'heal' | 'damage' | 'save';
    actor: { id: string; name: string };
    target: { id: string; name: string; hpBefore: number; hpAfter: number; maxHp: number };
    
    // Attack specifics (if type === 'attack')
    attackRoll?: CheckResult;
    damage?: number;
    damageRolls?: number[];  // Individual damage dice
    damageType?: string;     // Findings #40: auditable against resistances
    damageModifier?: 'immune' | 'resistant' | 'vulnerable';  // HIGH-002: set only when one applied
    situational?: string[];  // What changed the roll or the damage (dodge, help, parts, unit cap)
    // An aimed part with its own hp or breakAt took the hit instead of the
    // body (damage is then 0): what it took and whether it broke (severed).
    partHit?: { name: string; damage: number; hpBefore?: number; hpAfter?: number; broken: boolean; state: Part['state'] };
    // Request 11: a band rule's damageScale changed the damage (steps = the
    // attacker's band index minus the target's; before/after the multiplier).
    bandScale?: { steps: number; multiplier: number; before: number; after: number };
    // Request 5: the target's shields took this much before the hull.
    shieldsAbsorbed?: number;
    shields?: Shields;
    // Item 17: the attacker's fighting style on this swing (never on a posted
    // outcome); applied: false carries why it did not fit. The handler adds
    // targetDefense when the target's defense style raised the AC.
    fightingStyle?: { style: FightingStyle; applied: boolean; attackBonus?: number; damageBonus?: number; rerolls?: Array<{ sides: number; from: number; to: number }>; note?: string };
    // Item 16: a die rolled after the d20 and folded into the attack (precision):
    // present only when it was rolled; turnedHit says the miss became a hit.
    attackBonusDie?: { label: string; dice: string; roll: number; before: number; after: number; turnedHit: boolean };
    attackBonusDieSkipped?: string;
    // Item 16: extra dice rolled on a hit (a superiority die), doubled on a crit,
    // added before resistance; never touched by great weapon fighting.
    extraDamage?: Array<{ label: string; dice: string; rolls: number[]; total: number }>;
    // Play report 5 #1: the cover on this attack: the AC arithmetic, or `ignored` on a posted outcome (no roll) or when a feature lifted it.
    cover?: Omit<CoverResolution, 'ignored'> & { acBefore?: number; acAfter?: number; ignored?: string | CoverResolution['ignored'] };
    
    // Play report 5, item 4: a non-lethal blow dropped the target — Unconscious
    // (sourced 'nonlethal: <actor>') and stable; no death saves, no kill, no corpse.
    knockedOut?: { by: string; stable: true };
    // Play report 7 #5: how a standing subdue order shaped this automatic swing
    // (an opportunity attack or a readied attack): non-lethal, n/a against a
    // unit, or overridden by onSubdue 'fire'.
    subdue?: { mode: 'non-lethal' | 'n/a: unit' | 'overridden'; note: string };
    // Play report 7 #7 (lane F): the declared sources this attack roll took
    // ('Bloodlust (attack:melee)', 'Horn Charge (charging, named)', 'GM: downhill').
    advantageSources?: string[];
    disadvantageSources?: string[];
    // A heal from 0 removed these (the knockout's Unconscious) from the target.
    woke?: { conditionsRemoved: string[] };

    // Heal specifics (if type === 'heal')
    healAmount?: number;
    // Play report 5 #5: what this blow did to a tracked target at or into 0 HP
    // (dropped, failed saves added, massive damage, the counters after).
    dying?: DyingUpdate;
    
    // Status
    success: boolean;
    defeated: boolean;
    message: string;
    detailedBreakdown: string;
}

/**
 * Result of a legendary action use
 */
export interface LegendaryActionResult {
    success: boolean;
    remaining: number;
    error?: string;
}

/**
 * Result of a legendary resistance use
 */
export interface LegendaryResistanceResult {
    success: boolean;
    remaining: number;
    error?: string;
}

/**
 * Play report 5 #5: a death save the engine rolled (or a posted one applied)
 * while advancing into a dying slot, for the handler to print and to run
 * the kill on. The outcome line is in turnStartNotes too.
 */
export interface DeathSaveEvent extends DeathSaveResult {
    participantId: string;
    name: string;
    round: number;
    note: string;
}

/**
 * Play report 7 (lane H): what the handler layer knows of a saver that the
 * pure engine does not, for a save the engine rolls by itself (the
 * end-of-turn save of a save_ends condition): its declared sides for a save
 * of this ability (the labels of untagged save:<ability> mechanics on its
 * active effects; a tagged one as a hint, since nothing asserts a tag there)
 * and its save modifier as every other engine save composes it (ability and
 * save proficiency, with the parts). The engine never reads the database;
 * the handlers pass a provider (saves.ts engineSaverSides) on create, advance
 * and remove_participant. Undefined: the engine's own reading only.
 */
export interface SaverSides {
    advantage: string[];
    disadvantage: string[];
    conditionalAdvantage?: string[];
    conditionalDisadvantage?: string[];
    modifier?: { total: number; parts: string[] };
}
export type SaverSidesProvider = (participant: CombatParticipant, ability: Ability) => SaverSides | undefined;

/**
 * Play report 7 (lane H): an end-of-turn save the last advance rolled for a
 * save_ends condition: the dice (both when two were rolled; `natural` is the
 * kept one), the modifier and its parts, whether it ended the condition, the
 * sources and hints, and the line (also in turnStartNotes).
 */
export interface EndOfTurnSave {
    participantId: string;
    name: string;
    condition: string;
    ability: Ability;
    dc: number;
    rolls: number[];
    natural: number;
    modifier: number;
    parts: string[];
    total: number;
    saved: boolean;
    advantage?: string[];
    disadvantage?: string[];
    conditional?: string[];
    line: string;
}

export interface EventEmitter {
    publish(topic: string, payload: any): void;
}

/**
 * Combat Engine for managing RPG combat encounters
 * Handles initiative, turn order, and combat flow
 * 
 * Now supports D&D 5e legendary creatures:
 * - Legendary Actions (usable at end of other creatures' turns)
 * - Legendary Resistances (auto-succeed failed saves)
 * - Lair Actions (trigger on initiative count 20)
 */
export class CombatEngine {
    /** What happened at the start of the new turn (regeneration), for the advance output. */
    turnStartNotes: string[] = [];
    /**
     * Play report 7 #7 (lane F): the initiative rolls the last startEncounter
     * or addParticipants made with a declared source, by participant id: the
     * labels on each side and both dice when two were rolled. Read by the
     * create and add_participant replies (lane B's initiative rows).
     */
    initiativeDeclared: Map<string, InitiativeDeclared> = new Map();
    /** Play report 5 #5: the death saves the last advance rolled on dying slots it passed (or stopped at). */
    deathSaveEvents: DeathSaveEvent[] = [];
    /** Play report 7 (lane H): the end-of-turn saves (save_ends conditions) the last advance rolled. */
    endOfTurnSaves: EndOfTurnSave[] = [];
    /** Play report 7 (lane H): the handler-supplied reader for those saves (see SaverSides); unset: the engine's own reading. */
    private saverSides: SaverSidesProvider | undefined;
    /** The world's default death-save mode for the advance in progress (handler-supplied; auto when unset). */
    private deathSaveModeDefault: DeathSaveMode | undefined;
    private rng: CombatRNG;
    private state: CombatState | null = null;
    private emitter?: EventEmitter;

    /**
     * @param seed a seed string for a replayable (seeded) stream, or
     * `{ mode: 'crypto' }` for crypto dice: the default for play.
     */
    /** The encounter this engine runs (the handlers construct it with the id; the DEATH SAVE DUE call quotes it). */
    encounterId: string | undefined;

    constructor(seed: string | { mode: 'crypto' }, emitter?: EventEmitter) {
        this.rng = new CombatRNG(seed);
        this.emitter = emitter;
        if (typeof seed === 'string' && seed) this.encounterId = seed;
    }

    /** A CombatEngine on crypto dice. */
    static crypto(emitter?: EventEmitter): CombatEngine {
        return new CombatEngine({ mode: 'crypto' }, emitter);
    }

    /** 'crypto' or 'seeded' — which dice this encounter rolls. */
    get diceMode(): 'crypto' | 'seeded' {
        return this.rng.mode;
    }

    /** 'crypto' or 'seeded:<seed>', for a reply. */
    describeDice(): string {
        return this.rng.describe();
    }

    /**
     * Start a new combat encounter
     * Rolls initiative for all participants and establishes turn order
     * 
     * If any participant has hasLairActions=true, adds 'LAIR' to turn order at initiative 20
     */
    /**
     * Add new participants to an existing encounter. Rolls initiative for
     * each, resorts the turn order, and keeps currentTurnIndex pointing at
     * the same actor (so an insertion ahead of the active turn doesn't skip it).
     */
    addParticipants(newParticipants: CombatParticipant[], opts: { initiativeSources?: Record<string, DeclaredSides> } = {}): CombatState {
        if (!this.state) throw new Error('No active combat');

        this.initiativeDeclared = new Map();
        const withInit = newParticipants.map(p => ({
            ...p,
            initiative: this.rollInitiative(p, opts.initiativeSources?.[p.id]),
            isEnemy: p.isEnemy ?? this.detectIsEnemy(p.id, p.name),
            // Legendary counters start full; a spent resistance (from the sheet) stays spent.
            legendaryActionsRemaining: p.legendaryActions ?? p.legendaryActionsRemaining,
            legendaryResistancesRemaining: p.legendaryResistancesRemaining ?? p.legendaryResistances,
            movementRemaining: p.movementSpeed ?? 30,
            actionUsed: false,
            bonusActionUsed: false,
            spellsCast: {},
            reactionUsed: false,
            hasDashed: false,
            dashes: 0,
            extraActions: 0,
            hasDisengaged: false
        }));

        const currentId = this.state.turnOrder[this.state.currentTurnIndex];
        const merged = [...this.state.participants, ...withInit];

        merged.sort((a, b) => {
            const ai = a.initiative ?? 0;
            const bi = b.initiative ?? 0;
            if (bi !== ai) return bi - ai;
            return a.id.localeCompare(b.id);
        });

        // A lair owner joining a fight that had no lair brings the LAIR slot.
        const lairJoiner = withInit.find(p => p.hasLairActions);
        if (lairJoiner && !this.state.hasLairActions) {
            this.state.hasLairActions = true;
            this.state.lairOwnerId = lairJoiner.id;
        }

        // Rebuild turn order, preserving any LAIR slot at its initiative-20 position.
        const newTurnOrder: string[] = merged.map(p => p.id);
        if (this.state.hasLairActions) {
            // The lair loses ties: a creature that rolled 20 acts first.
            const lairIndex = merged.findIndex(p => (p.initiative ?? 0) < 20);
            if (lairIndex === -1) newTurnOrder.push('LAIR');
            else newTurnOrder.splice(lairIndex, 0, 'LAIR');
        }

        // Keep the active participant's turn anchored after the resort.
        const newIndex = newTurnOrder.indexOf(currentId);
        this.state.participants = merged;
        this.state.turnOrder = newTurnOrder;
        if (newIndex >= 0) this.state.currentTurnIndex = newIndex;

        // Callers persist this state directly: it carries the RNG position
        // after the initiative rolls (getState refreshes it).
        return this.getState()!;
    }

    /**
     * One initiative roll on the fight's logged dice. Play report 7 #7 (lane
     * F): a declared source (an untagged initiative or check:dex mechanic, or
     * a tagged one its context asserts; resolved by the caller) rolls two d20s
     * and keeps the higher (advantage) or the lower (disadvantage); both
     * cancel to one die. The purpose names the sources and the roll is kept
     * in initiativeDeclared. With no source it is the one die it always was.
     */
    private rollInitiative(p: CombatParticipant, sides?: DeclaredSides): number {
        if (!hasSides(sides)) return this.tagged({ purpose: 'initiative', forId: p.id }, () => this.rng.d20(p.initiativeBonus));
        const adv = sides!.advantage ?? [], dis = sides!.disadvantage ?? [];
        const two = !!adv.length !== !!dis.length;
        const rolls = this.tagged({ purpose: purposeWithSources('initiative', sides), forId: p.id }, () => two ? [this.rng.d20(0), this.rng.d20(0)] : [this.rng.d20(0)]);
        const natural = !two ? rolls[0] : adv.length ? Math.max(...rolls) : Math.min(...rolls);
        this.initiativeDeclared.set(p.id, {
            ...(adv.length ? { advantage: [...adv] } : {}),
            ...(dis.length ? { disadvantage: [...dis] } : {}),
            ...(two ? { rolls } : {})
        });
        return natural + (p.initiativeBonus ?? 0);
    }

    startEncounter(participants: CombatParticipant[], opts: { initiativeSources?: Record<string, DeclaredSides>; saverSides?: SaverSidesProvider } = {}): CombatState {
        // Roll initiative for each participant and store the value. A given
        // initiative is kept as given: no die, no declared source.
        this.initiativeDeclared = new Map();
        // Play report 7 (lane H): a surprised first slot's end-of-turn saves read it.
        if (opts.saverSides) this.saverSides = opts.saverSides;
        this.endOfTurnSaves = [];
        const participantsWithInitiative = participants.map(p => {
            const rolledInitiative = p.initiative ?? this.rollInitiative(p, opts.initiativeSources?.[p.id]);
            return {
                ...p,
                ac: p.ac,
                attackDamage: p.attackDamage,
                attackBonus: p.attackBonus,
                initiative: rolledInitiative,
                // Auto-detect isEnemy if not explicitly set
                isEnemy: p.isEnemy ?? this.detectIsEnemy(p.id, p.name),
                // Initialize legendary actions remaining to max if applicable
                legendaryActionsRemaining: p.legendaryActions ?? p.legendaryActionsRemaining,
                // Resistances are per day: a spent one (from the sheet) is not refilled by a new fight.
                legendaryResistancesRemaining: p.legendaryResistancesRemaining ?? p.legendaryResistances,
                // Initialize resources
                movementRemaining: p.movementSpeed ?? 30,
                actionUsed: false,
                bonusActionUsed: false,
                spellsCast: {},
                reactionUsed: false,
                hasDashed: false,
                dashes: 0,
                extraActions: 0,
                hasDisengaged: false
            };
        });

        // Check if any participant has lair actions
        const lairOwner = participantsWithInitiative.find(p => p.hasLairActions);
        const hasLairActions = !!lairOwner;

        // Sort by initiative (highest first), use ID as tiebreaker for determinism
        participantsWithInitiative.sort((a, b) => {
            if (b.initiative !== a.initiative) {
                return b.initiative - a.initiative;
            }
            return a.id.localeCompare(b.id);
        });

        // Build turn order
        let turnOrder = participantsWithInitiative.map(r => r.id);

        // If there's a lair owner, insert 'LAIR' at initiative 20
        if (hasLairActions) {
            // Find the right position for initiative 20
            // LAIR goes after all creatures with initiative >= 20 (the lair
            // loses ties), before those below 20
            const lairIndex = participantsWithInitiative.findIndex(p => (p.initiative ?? 0) < 20);
            if (lairIndex === -1) {
                // All initiatives are above 20, add at end
                turnOrder.push('LAIR');
            } else {
                // Insert LAIR at the correct position
                turnOrder.splice(lairIndex, 0, 'LAIR');
            }
        }

        this.state = {
            participants: participantsWithInitiative,
            turnOrder,
            currentTurnIndex: 0,
            round: 1,
            hasLairActions,
            lairOwnerId: lairOwner?.id
        };

        // A surprised creature first in the order loses that turn at once:
        // its slot passes (with the note) and the next actor is up. A LAIR
        // slot first is not a participant; the next advance handles it.
        this.turnStartNotes = [];
        const first = this.getCurrentParticipant();
        if (first?.surprised) {
            if (first.hp > 0) {
                this.passSurprisedTurn(first);
                this.advanceToNextActor();
            } else {
                first.surprised = false;
            }
        }

        this.emitter?.publish('combat', {
            type: 'encounter_started',
            state: this.state
        });

        // Callers persist this state directly: it carries the RNG position
        // after the initiative rolls (getState refreshes it).
        return this.getState()!;
    }

    /**
     * Auto-detect if a participant is an enemy based on ID/name patterns
     * 
     * IMPORTANT: UUIDs (like "9e48fa16-0ee4-4b99-a1e0-a162528d1e24") are typically 
     * player characters created via the UI. Pattern-based IDs (like "goblin-1", 
     * "orc-archer-2") are typically spawned enemies. Default to false for UUIDs.
     */
    private detectIsEnemy(id: string, name: string): boolean {
        const idLower = id.toLowerCase();
        const nameLower = name.toLowerCase();

        // Common enemy patterns - check NAME first (most reliable for determination)
        const enemyPatterns = [
            'goblin', 'orc', 'wolf', 'bandit', 'skeleton', 'zombie',
            'dragon', 'troll', 'ogre', 'kobold', 'gnoll', 'demon',
            'devil', 'undead', 'enemy', 'monster', 'creature', 'beast',
            'spider', 'rat', 'bat', 'slime', 'ghost', 'wraith',
            'dracolich', 'lich', 'vampire', 'golem', 'elemental',
            'cultist', 'thug', 'assassin', 'minion', 'guard', 'scout',
            'warrior', 'archer', 'mage', 'shaman', 'warlord', 'boss'
        ];

        // Check NAME for enemy patterns (more reliable since IDs can be UUIDs)
        for (const pattern of enemyPatterns) {
            if (nameLower.includes(pattern)) {
                return true;
            }
        }

        // Check ID for enemy patterns (for pattern-based IDs like "goblin-1")
        for (const pattern of enemyPatterns) {
            if (idLower.includes(pattern)) {
                return true;
            }
        }

        // Common player/ally patterns (not enemies)
        const allyPatterns = [
            'hero', 'player', 'pc', 'ally', 'companion', 'npc-friendly',
            'party', 'adventurer', 'cleric', 'paladin', 'ranger', 'rogue',
            'wizard', 'sorcerer', 'warlock', 'bard', 'druid', 'monk', 'fighter'
        ];

        for (const pattern of allyPatterns) {
            if (idLower.includes(pattern) || nameLower.includes(pattern)) {
                return false;
            }
        }

        // Check if ID looks like a UUID (player characters created via UI have UUIDs)
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidPattern.test(id)) {
            // UUIDs are typically player characters - default to NOT enemy
            return false;
        }

        // Default: for non-UUID IDs that don't match patterns, check if ID starts with enemy pattern
        // This catches pattern-based IDs like "enemy-1" or "mob-3"
        if (idLower.startsWith('enemy') || idLower.startsWith('mob') || idLower.startsWith('hostile')) {
            return true;
        }

        // Fallback default: unknown entities default to NOT enemy
        // Reasoning: It's safer to have an enemy show as friendly (player corrects it)
        // than to have a player character show as enemy (breaks immersion)
        return false;
    }

    /**
     * Get the current state
     */
    /** A bare d20 on the encounter's seeded stream, for saves handlers roll. */
    rollD20(tag: import('./rng.js').RollTag = { purpose: 'save' }): number {
        return this.tagged(tag, () => this.rng.d20(0));
    }

    /** Roll any dice ('2d6') on the encounter's stream, tagged for roll_log. */
    rollDice(notation: string, tag: import('./rng.js').RollTag): import('./rng.js').DamageResult {
        return this.tagged(tag, () => this.rng.rollDamageDetailed(notation));
    }

    /**
     * A spell attack d20 on the encounter's stream, with the same Dodge, Help
     * (spent) and standard-condition modifiers a weapon attack reads. Within
     * 5 ft comes from the grid when both tokens are placed, else it is
     * assumed unless the attack is ranged. Logged as 'spell attack'.
     * Play report 7 #7 (lane F): `declared` is the caster's declared advantage
     * for this spell attack's lane (resolved by the caller), each source named
     * in the situational lines and the purpose.
     */
    rollSpellAttackD20(actorId: string, targetId: string, opts: { ranged?: boolean; advantage?: boolean; disadvantage?: boolean; declared?: DeclaredSides } = {}): {
        natural: number; rolls: number[]; advantage: boolean; disadvantage: boolean; situational: string[]; autoCrit?: string;
        advantageSources?: string[]; disadvantageSources?: string[]
    } {
        if (!this.state) throw new Error('No active combat');
        const actor = this.state.participants.find(p => p.id === actorId);
        const target = this.state.participants.find(p => p.id === targetId);
        if (!actor) throw new Error(`Actor ${actorId} not found`);
        if (!target) throw new Error(`Target ${targetId} not found`);
        let advantage = !!opts.advantage;
        let disadvantage = !!opts.disadvantage;
        const situational: string[] = [];
        if (target.isDodging) { disadvantage = true; situational.push(`${target.name} is dodging (disadvantage)`); }
        if (actor.helpedBy) {
            advantage = true;
            const helper = this.state.participants.find(p => p.id === actor.helpedBy);
            situational.push(`helped by ${helper?.name ?? actor.helpedBy} (advantage)`);
            actor.helpedBy = undefined;
        }
        const within5ft = opts.ranged ? false
            : (actor.position && target.position ? edgeDistanceSquares(actor, target) <= 1 : true);
        const mods = conditionAttackModifiers(actor, target, { within5ft, participants: this.state.participants });
        if (mods.adv.length) { advantage = true; situational.push(...mods.adv); }
        if (mods.dis.length) { disadvantage = true; situational.push(...mods.dis); }
        const declaredAdv = opts.declared?.advantage ?? [], declaredDis = opts.declared?.disadvantage ?? [];
        for (const a of declaredAdv) { advantage = true; situational.push(`advantage ← ${a}`); }
        for (const d of declaredDis) { disadvantage = true; situational.push(`disadvantage ← ${d}`); }
        const r = this.tagged({ purpose: purposeWithSources('spell attack', opts.declared), forId: actorId, targetId }, () => this.rng.rollAttackD20(0, 0, advantage, disadvantage));
        return {
            natural: r.roll, rolls: r.allRolls, advantage, disadvantage, situational, ...(mods.autoCrit ? { autoCrit: mods.autoCrit } : {}),
            ...(declaredAdv.length ? { advantageSources: [...declaredAdv] } : {}),
            ...(declaredDis.length ? { disadvantageSources: [...declaredDis] } : {})
        };
    }

    /** Roll under a tag so the audit log says who the dice were for and why. */
    private tagged<T>(tag: import('./rng.js').RollTag, fn: () => T): T {
        const prev = this.rng.tag;
        this.rng.tag = tag;
        try { return fn(); } finally { this.rng.tag = prev; }
    }

    /** The dice rolled since the last drain (the operation guard writes them to roll_log). */
    drainRollRecords(): import('./rng.js').RollRecord[] {
        return this.rng.drainRecords();
    }

    getState(): CombatState | null {
        // Every save goes through a getState() taken after the rolls, so the
        // stored RNG position is current.
        if (this.state) this.state.rngState = this.rng.snapshot();
        return this.state;
    }

    /**
     * Load an existing combat state. A saved RNG position resumes the stream;
     * without one (older rows) the constructor's seed is used.
     */
    loadState(state: CombatState): void {
        this.state = state;
        if (state.rngState) this.rng = new CombatRNG('', state.rngState);
    }

    /**
     * Get the participant whose turn it currently is
     * Returns null if it's LAIR's turn
     */
    getCurrentParticipant(): CombatParticipant | null {
        if (!this.state) return null;

        const currentId = this.state.turnOrder[this.state.currentTurnIndex];
        
        // LAIR is a special entry, not a participant
        if (currentId === 'LAIR') return null;
        
        return this.state.participants.find(p => p.id === currentId) || null;
    }

    /**
     * Check if it's currently the LAIR's turn (initiative 20)
     */
    isLairActionPending(): boolean {
        if (!this.state) return false;
        return this.state.turnOrder[this.state.currentTurnIndex] === 'LAIR';
    }

    /**
     * Check if a legendary creature can use a legendary action
     * Rules: Can only use at the end of another creature's turn, not their own
     */
    canUseLegendaryAction(participantId: string): boolean {
        if (!this.state) return false;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return false;

        // Must have legendary actions
        if (!participant.legendaryActions || participant.legendaryActions <= 0) return false;

        // Must have remaining uses
        if (!participant.legendaryActionsRemaining || participant.legendaryActionsRemaining <= 0) return false;

        // Cannot use on their own turn
        const currentId = this.state.turnOrder[this.state.currentTurnIndex];
        if (currentId === participantId) return false;

        // Cannot use if it's the LAIR's turn (no creature to follow)
        if (currentId === 'LAIR') return false;

        return true;
    }

    /**
     * Why a legendary action of this cost cannot be taken now, or undefined
     * when it can. Checked before any roll so a refusal spends nothing.
     */
    legendaryActionProblem(participantId: string, cost: number = 1): string | undefined {
        if (!this.state) return 'No active combat';
        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return `Participant ${participantId} not in this encounter`;
        if (participant.surprised) return `${participant.name} is surprised: no legendary action until its first turn passes`;
        if (!participant.legendaryActions || participant.legendaryActions <= 0) return `${participant.name} has no legendary actions`;
        const currentId = this.state.turnOrder[this.state.currentTurnIndex];
        if (currentId === participantId) return `${participant.name} cannot take a legendary action on its own turn`;
        if (currentId === 'LAIR') return 'No legendary action on the LAIR turn (there is no creature\'s turn to follow)';
        const remaining = participant.legendaryActionsRemaining ?? 0;
        if (remaining < cost) return `Not enough legendary actions (need ${cost}, have ${remaining})`;
        return undefined;
    }

    /**
     * Use a legendary action
     * @param participantId - ID of the legendary creature
     * @param cost - How many legendary actions this use costs (default 1)
     * @returns Result with success status and remaining actions
     */
    useLegendaryAction(participantId: string, cost: number = 1): LegendaryActionResult {
        if (!this.state) {
            return { success: false, remaining: 0, error: 'No active combat' };
        }

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) {
            return { success: false, remaining: 0, error: 'Participant not found' };
        }

        if (!this.canUseLegendaryAction(participantId)) {
            return { 
                success: false, 
                remaining: participant.legendaryActionsRemaining ?? 0,
                error: 'Cannot use legendary action (own turn, no actions, or none remaining)'
            };
        }

        const remaining = participant.legendaryActionsRemaining ?? 0;
        if (remaining < cost) {
            return {
                success: false,
                remaining,
                error: `Not enough legendary actions (need ${cost}, have ${remaining})`
            };
        }

        participant.legendaryActionsRemaining = remaining - cost;

        this.emitter?.publish('combat', {
            type: 'legendary_action_used',
            participantId,
            cost,
            remaining: participant.legendaryActionsRemaining
        });

        return {
            success: true,
            remaining: participant.legendaryActionsRemaining
        };
    }

    /**
     * Use a legendary resistance to automatically succeed on a failed save
     * Unlike legendary actions, these do NOT reset each round
     */
    useLegendaryResistance(participantId: string): LegendaryResistanceResult {
        if (!this.state) {
            return { success: false, remaining: 0, error: 'No active combat' };
        }

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) {
            return { success: false, remaining: 0, error: 'Participant not found' };
        }

        // Must have legendary resistances
        if (!participant.legendaryResistances || participant.legendaryResistances <= 0) {
            return { success: false, remaining: 0, error: 'No legendary resistances' };
        }

        const remaining = participant.legendaryResistancesRemaining ?? 0;
        if (remaining <= 0) {
            return { success: false, remaining: 0, error: 'No legendary resistances remaining' };
        }

        participant.legendaryResistancesRemaining = remaining - 1;

        this.emitter?.publish('combat', {
            type: 'legendary_resistance_used',
            participantId,
            remaining: participant.legendaryResistancesRemaining
        });

        return {
            success: true,
            remaining: participant.legendaryResistancesRemaining
        };
    }

    /**
     * Reset legendary actions for a participant (called at start of their turn)
     */
    private resetLegendaryActions(participant: CombatParticipant): void {
        if (participant.legendaryActions && participant.legendaryActions > 0) {
            participant.legendaryActionsRemaining = participant.legendaryActions;
        }
    }

    /**
     * Advance to the next turn
     * Returns the participant whose turn it now is
     */
    nextTurn(): CombatParticipant | null {
        if (!this.state) return null;

        this.state.currentTurnIndex++;

        // If we've gone through everyone, start a new round
        if (this.state.currentTurnIndex >= this.state.turnOrder.length) {
            this.state.currentTurnIndex = 0;
            this.state.round++;
        }

        return this.getCurrentParticipant();
    }

    /**
     * HIGH-002: Calculate damage after applying resistance/vulnerability/immunity
     */
    calculateDamageWithModifiers(
        baseDamage: number,
        damageType: string | undefined,
        target: CombatParticipant
    ): { finalDamage: number; modifier: 'immune' | 'resistant' | 'vulnerable' | 'normal' } {
        return damageWithModifiers(baseDamage, damageType, target);
    }

    /**
     * Roll an attack's damage. 5e crit: a dice expression rolls its dice twice
     * and counts the modifier once; a plain number has no dice and lands as
     * given, crit or not.
     */
    private rollAttackDamage(damage: number | string, crit: boolean, rerollAtOrBelow?: number): { total: number; rolls?: number[]; breakdown: string; rerolls?: Array<{ sides: number; from: number; to: number }> } {
        if (typeof damage !== 'string') return { total: damage, breakdown: '' };
        // Item 17: great weapon fighting rerolls the weapon dice, crit dice included.
        const opts = rerollAtOrBelow !== undefined ? { rerollAtOrBelow } : {};
        const first = this.rng.rollDamageDetailed(damage, opts);
        let diceTotal = first.diceTotal;
        let rolls = first.rolls;
        let rerolls = first.rerolls;
        if (crit) {
            const extra = this.rng.rollDamageDetailed(damage, opts);
            diceTotal += extra.diceTotal;
            rolls = [...rolls, ...extra.rolls];
            if (extra.rerolls) rerolls = [...(rerolls ?? []), ...extra.rerolls];
        }
        const mod = first.modifier;
        return { total: diceTotal + mod, rolls, breakdown: ` (${rolls.join('+')}${mod >= 0 ? '+' + mod : mod})`, ...(rerolls ? { rerolls } : {}) };
    }

    /**
     * Execute an attack with full transparency
     * Returns detailed breakdown of what happened
     */
    executeAttack(
        actorId: string,
        targetId: string,
        attackBonus: number,
        dc: number,
        damage: number | string,
        damageType?: string,  // HIGH-002: Optional damage type for resistance calculation
        advantage?: boolean,
        disadvantage?: boolean,
        // FINDINGS #70: resolver damage lane — flat trait damage (Odinets et al.)
        // applied AFTER crit doubling, BEFORE resistance: flat adds never double
        // (spec ruling pending Tom's ratification; matches 5e dice-double law),
        // and resistance sees the true total.
        flatDamageBonus?: number,
        flatDamageLabel?: string,
        // An attack the GM resolved at the table: no d20 is rolled, so no
        // natural 1 or 20 can override it, and a posted damage number lands
        // exactly as posted (field report: a nat 20 doubled a posted 111).
        resolved?: 'hit' | 'crit' | 'miss',
        // The attack is made with a limb no crippling condition touches
        // (e.g. the good arm), so condition attack disadvantage is skipped.
        unaffectedLimb?: boolean,
        // Named parts: the attacker's part used and the target part aimed at;
        // uncapped lifts the one-model cap on unit targets (cleave, volleys).
        // ranged says the attack is not made within 5 ft (prone, auto-crit);
        // ignoreConditions skips the standard-condition modifiers entirely;
        // opportunity tags the rolls and the event as an opportunity attack.
        // bandScale (request 11) is the band rule's multiplier for this pair,
        // applied after resistance and before the part or unit caps.
        // Item 17: fightingStyle overrides the actor's own; twoHanded / offhand
        // say how this swing is made; reachFt is the profile's reach, read
        // when `ranged` is unset to tell a shot from a swing by the grid.
        // Item 16: extraDamageDice are rolled on a hit (twice on a crit) and
        // added before resistance; attackBonusDie is rolled after the d20 and
        // folded into the total (onlyIfMiss: only when the swing missed and
        // not on a natural 1; maxMissBy: only when the die could make it up).
        // Play report 5 #1: cover. `cover` is the resolution the caller
        // already made (an explicit value, or standing/computed); unset, the
        // engine resolves standing and computed cover itself, lifting what the
        // attacker's ignoreCover names. Total cover refuses before anything is
        // spent. The bonus is added to dc here, so every path (attack, volley,
        // opportunity, readied, legendary) prints the same arithmetic.
        // Play report 5: nonlethal knocks out instead of defeating (melee only).
        // Play report 7 #7 (lane F): `declared` is the attacker's declared
        // advantage per lane, resolved by the caller from its effect mechanics
        // (attack, attack:melee, attack:ranged), named sources and the GM's own
        // ruling; this attack reads the side for its own lane (the same lane
        // cover and fighting style read) and names every source.
        partOpts?: {
            withPart?: string; atPart?: string; uncapped?: boolean; ranged?: boolean; ignoreConditions?: boolean; opportunity?: boolean;
            nonlethal?: boolean;
            bandScale?: { steps: number; multiplier: number };
            fightingStyle?: FightingStyle; twoHanded?: boolean; offhand?: boolean; dualWielding?: boolean; reachFt?: number;
            extraDamageDice?: Array<{ dice: string; label: string }>;
            attackBonusDie?: { dice: string; label: string; onlyIfMiss?: boolean; maxMissBy?: number };
            cover?: CoverResolution; ignoreCover?: IgnoreCoverScopes | IgnoreCover;
            declared?: Partial<Record<'melee' | 'ranged', DeclaredSides>>;
        }
    ): CombatActionResult {
        if (!this.state) throw new Error('No active combat');

        const actor = this.state.participants.find(p => p.id === actorId);
        const target = this.state.participants.find(p => p.id === targetId);

        if (!actor) throw new Error(`Actor ${actorId} not found`);
        if (!target) throw new Error(`Target ${targetId} not found`);

        const hpBefore = target.hp;

        // A dead or latched part cannot attack: refused before anything
        // changes (no Help spent, no roll, no action).
        const partName = (x?: string) => x?.trim().toLowerCase();
        const findPart = (who: CombatParticipant, name?: string) => name ? who.parts?.find(pt => pt.name.toLowerCase() === partName(name)) : undefined;
        const usedPart = findPart(actor, partOpts?.withPart);
        if (partOpts?.withPart) {
            if (!usedPart) {
                const named = actor.attacks?.length ? `; named attacks: ${actor.attacks.map(a => a.name).join(', ')} (pass using)` : '';
                throw new Error(`${actor.name} has no part '${partOpts.withPart}' (parts: ${actor.parts?.map(pt => pt.name).join(', ') || 'none'})${named}`);
            }
            if (usedPart.state === 'dead') throw new Error(`${actor.name}'s ${usedPart.name} is dead and cannot attack`);
            if (usedPart.state === 'latched') throw new Error(`${actor.name}'s ${usedPart.name} is latched and cannot attack while it holds`);
            // Request 5: a vessel's guns section that is not intact fires nothing.
            if (actor.vessel && sectionRole(actor, usedPart) === 'guns' && usedPart.state !== 'intact') {
                throw new Error(`${actor.name}'s ${usedPart.name} (guns) is ${usedPart.state}: its weapons cannot fire. Repair the section (combat_manage set_part state: intact) or fire from another section`);
            }
        }

        // Underwater (a water encounter, or a water cell under the attacker):
        // no ranged attacks unless the environment allows them. Refused before
        // anything is spent.
        const env = this.environmentOf();
        const submerged = this.inWater(actor);
        if (submerged && partOpts?.ranged && !env.rangedAllowed) {
            throw new Error(`${actor.name} is underwater: ranged attacks are refused here (combat_manage set_environment {rangedAllowed: true} to allow them). Nothing was spent.`);
        }

        // Play report 5 #1: cover, resolved before anything is spent. Total
        // cover refuses the attack outright (writes: none); half and
        // three-quarters raise the AC with the arithmetic printed; a posted
        // outcome rolls nothing, so the cover is reported as ignored.
        const situational: string[] = [];
        const coverLane: 'ranged' | 'melee' = (partOpts?.ranged ?? (actor.position && target.position
            ? edgeDistanceSquares(actor, target) * 5 > effectiveReachFt(actor, partOpts?.reachFt !== undefined ? { reachFt: partOpts.reachFt } : undefined)
            : false)) ? 'ranged' : 'melee';
        const coverRes = partOpts?.cover ?? resolveCover(this.state, actor, target, { ignoreCover: ignoreCoverFor(partOpts?.ignoreCover ?? actor.ignoreCover, coverLane) });
        if (coverRes.kind === 'total') throw totalCoverRefusal(coverRes, actor.name, target.name);
        let coverInfo: CombatActionResult['cover'];
        if (resolved) {
            coverInfo = { ...coverRes, acBonus: 0, ...(coverRes.kind !== 'none' ? { ignored: 'posted outcome: no roll, the AC was not used' } : {}) };
        } else if (coverRes.acBonus > 0) {
            const acBefore = dc;
            dc += coverRes.acBonus;
            coverInfo = { ...coverRes, acBefore, acAfter: dc };
            situational.push(`cover: ${coverArithmetic('AC', acBefore, coverRes)}`);
        } else {
            coverInfo = { ...coverRes, acBefore: dc, acAfter: dc };
            const lifted = ignoredCoverLine(coverRes, actor.name);
            if (lifted) situational.push(lifted);
        }
        for (const note of coverRes.notes ?? []) situational.push(note);
        // Play report 5, item 4: a non-lethal blow is melee only (5e). The
        // handler refuses an explicit ranged flag; a shot the grid infers
        // (beyond the attacker's reach with no flag) is refused here, before
        // Help or anything else is spent.
        if (partOpts?.nonlethal) {
            const apart = actor.position && target.position ? edgeDistanceSquares(actor, target) * 5 : undefined;
            const reach = effectiveReachFt(actor, partOpts.reachFt !== undefined ? { reachFt: partOpts.reachFt } : undefined);
            const gridRanged = partOpts.ranged ?? (apart !== undefined ? apart > reach : false);
            if (gridRanged) {
                const refusal = new Error(`${actor.name} cannot knock ${target.name} out from there: non-lethal blows are melee only (5e) and this attack is ranged${partOpts.ranged === undefined && apart !== undefined ? ` (${apart} ft apart, reach ${reach} ft)` : ''}. Nothing was spent.`) as Error & { writes?: string };
                refusal.writes = 'none';
                throw refusal;
            }
        }

        // Dodge and Help feed the roll. Help is spent by the attack even when
        // the GM posts the result.
        if (target.isDodging) { disadvantage = true; situational.push(`${target.name} is dodging (disadvantage)`); }
        if (actor.helpedBy) {
            advantage = true;
            const helper = this.state.participants.find(p => p.id === actor.helpedBy);
            situational.push(`helped by ${helper?.name ?? actor.helpedBy} (advantage)`);
            actor.helpedBy = undefined;
        }
        // Parts: a dead or latched part cannot attack (refused before any
        // roll, so nothing is spent); a crippled one attacks at disadvantage;
        // a breached target part, or a latcher attacked by the one it holds,
        // is hit with advantage.
        if (usedPart?.state === 'crippled') { disadvantage = true; situational.push(`${actor.name}'s ${usedPart.name} crippled (disadvantage)`); }
        // Request 5: a vessel with its bridge crippled or dead aims badly.
        if (actor.vessel) {
            const bridge = roleState(actor, 'bridge');
            if (bridge !== 'intact') { disadvantage = true; situational.push(`${actor.name}'s bridge ${bridge} (disadvantage)`); }
        }
        // Measure of a Body: a crippled arm's attacks are at disadvantage. With
        // no part resolved (no withPart, weapon or profile part), assume the
        // crippled arm only when no intact arm could be swinging instead.
        const crippledArm = actor.parts?.find(pt => pt.state === 'crippled' && pt.kind === 'arm');
        if (!usedPart && crippledArm && !unaffectedLimb) {
            const goodArm = actor.parts?.find(pt => pt.kind === 'arm' && pt.state === 'intact');
            if (goodArm) situational.push(`assumed ${goodArm.name}; name weapon or withPart if the crippled ${crippledArm.name} swings`);
            else { disadvantage = true; situational.push(`${actor.name}'s ${crippledArm.name} crippled (disadvantage; name withPart or unaffectedLimb for the good arm)`); }
        }
        const aimed = partOpts?.atPart ? findNamedPart(target, partOpts.atPart) : undefined;
        // A part with its own hp or breakAt is a separate object (a chain, a
        // shield, a plate): an aimed hit lands on it, not on the body.
        const armouredPart = aimed && aimed.state !== 'dead' && (aimed.hp !== undefined || aimed.breakAt !== undefined) ? aimed : undefined;
        let partHit: CombatActionResult['partHit'];
        if (aimed?.state === 'breached') { advantage = true; situational.push(`${target.name}'s ${aimed.name} breached (advantage)`); }
        if (target.parts?.some(pt => pt.state === 'latched' && pt.latchedTo?.participantId === actor.id)) {
            advantage = true;
            situational.push(`${target.name} is latched onto ${actor.name} (advantage)`);
        }

        // Battle-cry buffs (combat_manage battle_cry): advantage while they last.
        const buffs = actor.buffs ?? [];
        for (const b of buffs) {
            if (b.attackAdvantage) { advantage = true; situational.push(`${b.name} (advantage)`); }
        }
        // Play report 7 #7 (lane F): declared advantage for this attack's lane,
        // each source named ('advantage ← Bloodlust (attack:melee)'). It cancels
        // with any disadvantage as usual. A posted outcome rolls nothing.
        const declared = partOpts?.declared?.[coverLane];
        const declaredAdv = resolved ? [] : declared?.advantage ?? [];
        const declaredDis = resolved ? [] : declared?.disadvantage ?? [];
        for (const a of declaredAdv) { advantage = true; situational.push(`advantage ← ${a}`); }
        for (const d of declaredDis) { disadvantage = true; situational.push(`disadvantage ← ${d}`); }
        if (resolved && hasSides(declared)) situational.push(`declared advantage ignored: posted outcome, no roll (${[...(declared!.advantage ?? []).map(a => `adv: ${a}`), ...(declared!.disadvantage ?? []).map(d => `dis: ${d}`)].join('; ')})`);
        // Mob rule: a unit hits harder to miss the more models it has standing.
        const mob = mobAttackBonus(actor);
        if (mob.bonus) {
            attackBonus += mob.bonus;
            situational.push(`mob rule +${mob.bonus} to hit (${mob.models} models)`);
        }

        // Item 17: the attacker's fighting style. `ranged` unset is read from
        // the grid (a shot from beyond the attacker's reach), else melee.
        const styleRanged = partOpts?.ranged ?? (actor.position && target.position
            ? edgeDistanceSquares(actor, target) * 5 > effectiveReachFt(actor, partOpts?.reachFt !== undefined ? { reachFt: partOpts.reachFt } : undefined)
            : false);
        const fs = fightingStyleEffects(partOpts?.fightingStyle ?? actor.fightingStyle, { ranged: styleRanged, twoHanded: partOpts?.twoHanded, offhand: partOpts?.offhand, dualWielding: partOpts?.dualWielding, resolved: !!resolved });
        if (fs?.attackBonus) {
            attackBonus += fs.attackBonus;
            situational.push(fs.note);
        }

        // Conditions can carry mechanics in metadata (a called strike's
        // crippled arm). The GM passes unaffectedLimb for the good arm.
        const hampering = actor.conditions.filter(c => c.metadata?.attackDisadvantage);
        if (hampering.length && !unaffectedLimb) {
            disadvantage = true;
            situational.push(`${hampering.map(c => c.type).join(', ')} (disadvantage)`);
        }

        // Underwater melee swings at disadvantage unless the damage type is
        // on the free list (piercing by default) or the attacker swims (the
        // swim tag). A GM-posted result is left as posted.
        if (submerged && !partOpts?.ranged && !resolved) {
            const free = env.meleeDisadvantageUnlessDamageType.map(t => t.toLowerCase());
            const typeFree = !!damageType && free.includes(damageType.toLowerCase());
            if (!typeFree && !this.hasTag(actor, env.swimTag)) {
                disadvantage = true;
                situational.push(`underwater (disadvantage; ${free.join('/')} damage or the '${env.swimTag}' tag swings freely)`);
            }
        }

        // The 5e standard conditions on both sides (allow-list only; homebrew
        // tags never fire). Within 5 ft comes from the grid when both tokens
        // are placed, else it is assumed unless the attack is ranged.
        let autoCrit: string | undefined;
        if (!partOpts?.ignoreConditions) {
            const within5ft = partOpts?.ranged ? false
                : (actor.position && target.position ? edgeDistanceSquares(actor, target) <= 1 : true);
            const mods = conditionAttackModifiers(actor, target, { within5ft, participants: this.state.participants });
            if (mods.adv.length) { advantage = true; situational.push(...mods.adv); }
            if (mods.dis.length) { disadvantage = true; situational.push(...mods.dis); }
            autoCrit = mods.autoCrit;
        }

        // Roll with full transparency — 5e semantics (Findings #32):
        // crit reads the natural die, never the margin.
        const attackRoll: CheckResult & { allRolls: number[]; resolved?: 'hit' | 'crit' | 'miss' } = resolved
            ? {
                roll: undefined as unknown as number, modifier: 0, total: undefined as unknown as number,
                dc: undefined as unknown as number, margin: 0,
                degree: resolved === 'crit' ? 'critical-success' : resolved === 'hit' ? 'success' : 'failure',
                isNat20: false, isNat1: false,
                isHit: resolved !== 'miss', isCrit: resolved === 'crit',
                allRolls: [], resolved
            }
            : this.tagged({ purpose: purposeWithSources(partOpts?.opportunity ? 'opportunity attack' : 'attack', { advantage: declaredAdv, disadvantage: declaredDis }), forId: actorId, targetId }, () => this.rng.rollAttackD20(attackBonus, dc, advantage, disadvantage));
        // Paralyzed or unconscious within 5 ft: a rolled hit is a crit. A
        // GM-posted result lands exactly as posted, with a pointer instead.
        if (autoCrit && attackRoll.isHit && !attackRoll.isCrit) {
            if (resolved) {
                situational.push(`${autoCrit} (posted as ${resolved}; post outcome:crit if so)`);
            } else {
                attackRoll.isCrit = true;
                attackRoll.degree = 'critical-success';
                situational.push(autoCrit);
            }
        }

        // Item 16: a die added to the attack after the d20 (Precision Attack).
        // Never on a posted result, never on a natural 1 (nothing turns it),
        // and with maxMissBy only when the die could close the gap.
        let attackBonusDie: CombatActionResult['attackBonusDie'];
        let attackBonusDieSkipped: string | undefined;
        if (partOpts?.attackBonusDie && !resolved) {
            const abd = partOpts.attackBonusDie;
            const missBy = dc - attackRoll.total;
            if (attackRoll.isNat1) attackBonusDieSkipped = `${abd.label} not rolled: a natural 1 cannot be turned`;
            else if (abd.onlyIfMiss && attackRoll.isHit) attackBonusDieSkipped = `${abd.label} not rolled: the swing already hits`;
            else if (abd.maxMissBy !== undefined && missBy > abd.maxMissBy) attackBonusDieSkipped = `${abd.label} not rolled: missed by ${missBy}, more than ${abd.dice} can make up`;
            else {
                const roll = this.tagged({ purpose: abd.label, forId: actorId, targetId }, () => this.rng.roll(abd.dice));
                const before = attackRoll.total;
                const wasHit = attackRoll.isHit;
                attackRoll.modifier += roll;
                attackRoll.total += roll;
                attackRoll.margin = attackRoll.total - dc;
                attackRoll.isHit = attackRoll.isNat20 || attackRoll.total >= dc;
                if (attackRoll.isHit && !attackRoll.isCrit) attackRoll.degree = 'success';
                else if (!attackRoll.isHit) attackRoll.degree = 'failure';
                attackBonusDie = { label: abd.label, dice: abd.dice, roll, before, after: attackRoll.total, turnedHit: !wasHit && attackRoll.isHit };
                situational.push(`${abd.label} +${roll}: ${before} → ${attackRoll.total} vs AC ${dc}${attackBonusDie.turnedHit ? ' (turned the miss)' : attackRoll.isHit ? '' : ' (still a miss)'}`);
            }
            if (attackBonusDieSkipped) situational.push(attackBonusDieSkipped);
        }

        // Item 16: a melee miss is remembered on the target for the round, so a
        // riposte can answer it. Posted misses count too.
        if (!attackRoll.isHit && !styleRanged) {
            const round = this.state.round;
            target.lastMeleeMisses = [...(target.lastMeleeMisses ?? []).filter(m => m.round === round && m.attackerId !== actor.id), { attackerId: actor.id, round }];
        }
        // Play report 5: a melee hit is remembered on the attacker for the turn
        // (requires.hitThisTurn on a follow-up attack).
        if (attackRoll.isHit && !styleRanged) {
            actor.meleeHitsThisTurn = [...(actor.meleeHitsThisTurn ?? []).filter(id => id !== target.id), target.id];
        }

        let damageDealt = 0;
        let damageModifier: 'immune' | 'resistant' | 'vulnerable' | 'normal' = 'normal';
        let bandScale: CombatActionResult['bandScale'];
        let shieldsAbsorbed: number | undefined;

        // Calculate base damage from number or string
        let baseDamageVal = 0;
        let damageBreakdownStr = '';

        // Item 17: great weapon fighting rerolls only on a hit (a miss rolls and
        // logs nothing extra); the hit is known before the dice are rolled.
        const gwfThreshold = attackRoll.isHit && !resolved ? fs?.rerollAtOrBelow : undefined;
        const rolled = this.tagged({ purpose: partOpts?.opportunity ? 'opportunity damage' : 'damage', forId: actorId, targetId }, () => this.rollAttackDamage(damage, attackRoll.isHit && attackRoll.isCrit, gwfThreshold));
        baseDamageVal = rolled.total;
        const capturedDamageRolls = rolled.rolls;
        damageBreakdownStr = rolled.breakdown;
        if (rolled.rerolls?.length) situational.push(`great weapon fighting rerolled ${rolled.rerolls.length}: ${rolled.rerolls.map(r => `${r.from}→${r.to}`).join(', ')}`);
        const styleDamage = attackRoll.isHit && !resolved ? (fs?.damageBonus ?? 0) : 0;
        if (styleDamage) situational.push(fs!.note);

        // Battle-cry damage: a flat bonus or dice on the encounter's stream,
        // added on a hit (never doubled by a crit). A GM-posted result lands
        // exactly as posted, so it takes none.
        let buffDamage = 0;
        if (attackRoll.isHit && !resolved) {
            for (const b of buffs) {
                if (b.damageBonus === undefined || b.damageBonus === 0) continue;
                const extra = typeof b.damageBonus === 'number'
                    ? b.damageBonus
                    : this.tagged({ purpose: `${b.name} damage`, forId: actorId, targetId }, () => this.rng.roll(String(b.damageBonus)));
                buffDamage += extra;
                situational.push(`${b.name} +${extra} damage${typeof b.damageBonus === 'string' ? ` (${b.damageBonus})` : ''}`);
            }
        }

        // Item 16: extra dice on a hit (a superiority die), rolled again on a
        // crit, under their own purpose. Great weapon fighting never touches them.
        let extraDamage: CombatActionResult['extraDamage'];
        let extraDamageTotal = 0;
        if (attackRoll.isHit && !resolved && partOpts?.extraDamageDice?.length) {
            extraDamage = [];
            for (const extra of partOpts.extraDamageDice) {
                const rolledExtra = this.tagged({ purpose: extra.label, forId: actorId, targetId }, () => {
                    const first = this.rng.rollDamageDetailed(extra.dice);
                    if (!attackRoll.isCrit) return first;
                    const second = this.rng.rollDamageDetailed(extra.dice);
                    return { ...first, rolls: [...first.rolls, ...second.rolls], total: first.total + second.total };
                });
                extraDamage.push({ label: extra.label, dice: extra.dice, rolls: rolledExtra.rolls, total: rolledExtra.total });
                extraDamageTotal += rolledExtra.total;
                situational.push(`${extra.label} +${rolledExtra.total} (${extra.dice}${attackRoll.isCrit ? ' ×2 crit' : ''}: ${rolledExtra.rolls.join('+')})`);
            }
        }

        if (attackRoll.isHit) {
            // FINDINGS #70: the damage lane lands here — outside the crit
            // doubling, inside the resistance math. Item 17: dueling's +2 too;
            // item 16: the superiority die.
            const finalBaseDamage = baseDamageVal + (flatDamageBonus ?? 0) + buffDamage + styleDamage + extraDamageTotal;
            
            // HIGH-002: Apply resistance/vulnerability/immunity
            const modResult = this.calculateDamageWithModifiers(finalBaseDamage, damageType, target);
            damageDealt = modResult.finalDamage;
            damageModifier = modResult.modifier;
            // Request 11: the band gap scales what got through the resistance
            // math; a blow that landed never drops below 1.
            if (partOpts?.bandScale && damageDealt > 0) {
                const scaled = Math.max(1, Math.floor(damageDealt * partOpts.bandScale.multiplier));
                bandScale = { steps: partOpts.bandScale.steps, multiplier: partOpts.bandScale.multiplier, before: damageDealt, after: scaled };
                damageDealt = scaled;
            }
            // Request 5: shields take the hit before the hull or any section.
            if (target.shields && damageDealt > 0) {
                const soak = absorbWithShields(target, damageDealt);
                if (soak.absorbed > 0) {
                    shieldsAbsorbed = soak.absorbed;
                    damageDealt = soak.through;
                    situational.push(`${target.name}'s shields absorb ${soak.absorbed} (shields ${target.shields.current}/${target.shields.max})`);
                }
            }
            // A hit the shields fully absorbed never reaches the aimed section.
            if (armouredPart && !(shieldsAbsorbed && damageDealt === 0)) {
                partHit = this.damagePart(target, armouredPart, damageDealt);
                situational.push(`${target.name}'s ${armouredPart.name} takes the hit${partHit.broken ? ' and is severed' : ''} (body untouched)`);
                damageDealt = 0;
            }
            // A single blow on a unit kills at most one model; cleave on a
            // packed unit, volleys and area attacks flow through models.
            else if (target.unit && !partOpts?.uncapped && target.hp > 0) {
                const models = Math.ceil(target.hp / target.unit.hpPerModel);
                const currentModelHp = target.hp - (models - 1) * target.unit.hpPerModel;
                if (damageDealt > currentModelHp) {
                    situational.push(`one model at most: ${damageDealt} → ${currentModelHp} (cleave a packed unit to go through)`);
                    damageDealt = currentModelHp;
                }
            }
            target.hp = Math.max(0, target.hp - damageDealt);
            this.refreshVessel(target);
        }

        // Play report 5, item 4: a non-lethal blow that drops the body leaves
        // it at 0, Unconscious (sourced to the attacker) and stable — no death
        // saves; the handler credits no kill and makes no corpse. An
        // Unconscious from another source (a sleep spell) is left alone.
        let knockedOut: CombatActionResult['knockedOut'];
        if (partOpts?.nonlethal && attackRoll.isHit && !partHit && hpBefore > 0 && target.hp <= 0) {
            knockedOut = { by: actor.id, stable: true };
            target.isStabilized = true;
            target.deathSaveSuccesses = 0;
            target.deathSaveFailures = 0;
            if (!target.conditions.some(isNonlethalUnconscious)) {
                this.applyCondition(target.id, { type: ConditionType.UNCONSCIOUS, durationType: DurationType.PERMANENT, sourceId: nonlethalSource(actor.id) });
            }
        }

        const defeated = target.hp <= 0;
        // Play report 5 #5: a tracked target dropped to 0 goes unconscious and
        // prone; one already down takes a failed save, two on a crit or any
        // melee hit (within 5 ft: the unconscious are auto-crit when rolled; a
        // posted hit from 5 ft counts the same). Massive damage kills outright.
        // A non-lethal knockout is never a dying event: the GM chose to subdue, so no counters, no massive-damage death.
        const dying: DyingUpdate | undefined = attackRoll.isHit && damageDealt > 0 && !knockedOut
            ? damageAtZero(target, hpBefore, damageDealt, { crit: attackRoll.isCrit, melee: !partOpts?.ranged && (actor.position && target.position ? edgeDistanceSquares(actor, target) <= 1 : true) })
            : undefined;

        // Build detailed breakdown
        const diceShown = attackRoll.allRolls.length > 1
            ? `d20(${attackRoll.allRolls.join(',')}${advantage ? ' adv' : ' dis'}→${attackRoll.roll})`
            : `d20(${attackRoll.roll})`;
        let breakdown = resolved
            ? `🎲 Attack: resolved externally by the GM (${resolved.toUpperCase()})\n`
            : `🎲 Attack Roll: ${diceShown} + ${attackBonus} = ${attackRoll.total} vs AC ${dc}\n`;

        if (attackRoll.isNat20) {
            breakdown += `   ⭐ NATURAL 20!\n`;
        } else if (attackRoll.isNat1) {
            breakdown += `   💀 NATURAL 1!\n`;
        }

        breakdown += `   ${attackRoll.isHit ? '✅ HIT' : '❌ MISS'}`;

        if (attackRoll.isHit) {
            breakdown += attackRoll.isCrit ? ' (CRITICAL!)' : '';

            // HIGH-002: Show damage type and modifier
            const typeStr = damageType ? ` ${damageType}` : '';
            let modStr = '';
            if (damageModifier === 'immune') {
                modStr = ' [IMMUNE - No damage!]';
            } else if (damageModifier === 'resistant') {
                modStr = ' [Resistant - Halved!]';
            } else if (damageModifier === 'vulnerable') {
                modStr = ' [Vulnerable - Doubled!]';
            }

            const bandStr = bandScale ? ` ×${bandScale.multiplier} band (${bandScale.before} → ${bandScale.after})` : '';
            const shieldStr = shieldsAbsorbed ? ` [shields −${shieldsAbsorbed}, ${target.shields!.current}/${target.shields!.max} left]` : '';
            const dealtStr = `${typeStr}${damageBreakdownStr}${attackRoll.isCrit ? ' (crit)' : ''}${flatDamageBonus ? ` + ${flatDamageLabel ?? 'trait'} ${flatDamageBonus >= 0 ? '+' : ''}${flatDamageBonus}` : ''}${modStr}${bandStr}${shieldStr}`;
            if (partHit) {
                const hpStr = partHit.hpBefore !== undefined ? `, ${partHit.hpBefore} → ${partHit.hpAfter} HP` : '';
                breakdown += `\n\n💥 Part hit: ${partHit.name} takes ${partHit.damage}${dealtStr}${hpStr}${partHit.broken ? ' [SEVERED]' : ''}\n`;
            } else {
                breakdown += `\n\n💥 Damage: ${damageDealt}${dealtStr}\n`;
            }
            breakdown += `   ${target.name}: ${hpBefore} → ${target.hp}/${target.maxHp} HP`;
            if (defeated) {
                breakdown += knockedOut ? ` [KNOCKED OUT — stable]` : dying ? dyingTail(target, dying) : ` [DEFEATED]`;
            }
            if (dying?.failuresAdded) breakdown += `\n   🩸 hit while down: +${dying.failuresAdded} failed death save${dying.failuresAdded > 1 ? 's' : ''}${attackRoll.isCrit ? ' (crit)' : ''}`;
        }

        if (situational.length) breakdown += `\n   ⚖️ ${situational.join('; ')}`;

        // Build simple message
        let message = '';
        if (attackRoll.isHit) {
            message = partHit
                ? `${attackRoll.isCrit ? 'CRITICAL ' : ''}HIT! ${actor.name} deals ${partHit.damage} damage to ${target.name}'s ${partHit.name}${partHit.broken ? ' [SEVERED]' : ''}`
                : `${attackRoll.isCrit ? 'CRITICAL ' : ''}HIT! ${actor.name} deals ${damageDealt} damage to ${target.name}`;
            if (defeated) message += knockedOut ? ' [KNOCKED OUT — stable]' : dying ? ` [${dyingLabel(target) ?? 'DEFEATED'}${dying.instantDeath ? ' — massive damage' : ''}]` : ' [DEFEATED]';
        } else {
            message = `MISS! ${actor.name}'s attack misses ${target.name}`;
        }

        this.emitter?.publish('combat', {
            type: partOpts?.opportunity ? 'opportunity_attack' : 'attack_executed',
            result: {
                actor: actor.name,
                target: target.name,
                roll: attackRoll.roll,
                total: attackRoll.total,
                dc,
                hit: attackRoll.isHit,
                crit: attackRoll.isCrit,
                damage: damageDealt,
                targetHp: target.hp
            }
        });

        return {
            type: 'attack',
            actor: { id: actor.id, name: actor.name },
            target: { id: target.id, name: target.name, hpBefore, hpAfter: target.hp, maxHp: target.maxHp },
            attackRoll,
            ...(coverInfo ? { cover: coverInfo } : {}),
            damage: damageDealt,
            damageRolls: capturedDamageRolls,
            damageType,   // Findings #40: the AP-vs-expanding lane and every resistance list key off it
            damageModifier: damageModifier === 'normal' ? undefined : damageModifier,
            ...(bandScale ? { bandScale } : {}),
            ...(shieldsAbsorbed ? { shieldsAbsorbed } : {}),
            ...(target.shields ? { shields: { ...target.shields } } : {}),
            ...(fs ? { fightingStyle: {
                style: fs.style, applied: fs.applied,
                ...(fs.attackBonus ? { attackBonus: fs.attackBonus } : {}),
                ...(styleDamage ? { damageBonus: styleDamage } : {}),
                ...(rolled.rerolls?.length ? { rerolls: rolled.rerolls } : {}),
                note: fs.note
            } } : {}),
            ...(attackBonusDie ? { attackBonusDie } : {}),
            ...(attackBonusDieSkipped ? { attackBonusDieSkipped } : {}),
            ...(extraDamage ? { extraDamage } : {}),
            ...(knockedOut ? { knockedOut } : {}),
            ...(declaredAdv.length ? { advantageSources: declaredAdv } : {}),
            ...(declaredDis.length ? { disadvantageSources: declaredDis } : {}),
            success: attackRoll.isHit,
            defeated,
            message,
            detailedBreakdown: breakdown,
            ...(situational.length ? { situational } : {}),
            ...(partHit ? { partHit } : {}),
            ...(dying ? { dying } : {})
        };
    }

    /**
     * Damage an armoured part: a hit of breakAt or more, or hp run down to 0,
     * breaks it. A broken part is dead with a 'severed' note, and it lets go:
     * its own latch and every part latched onto it are released.
     */
    private damagePart(owner: CombatParticipant, part: Part, damage: number): NonNullable<CombatActionResult['partHit']> {
        const hpBefore = part.hp;
        if (part.hp !== undefined) part.hp = Math.max(0, part.hp - damage);
        const broken = (part.breakAt !== undefined && damage >= part.breakAt) || (part.hp !== undefined && part.hp <= 0);
        if (broken) {
            part.state = 'dead';
            part.latchedTo = undefined;
            part.note = part.note ? `${part.note}; severed` : 'severed';
            const key = part.name.toLowerCase();
            for (const other of this.state?.participants ?? []) {
                for (const pt of other.parts ?? []) {
                    if (pt.latchedTo?.participantId !== owner.id) continue;
                    if (!pt.latchedTo.part || pt.latchedTo.part.toLowerCase() !== key) continue;
                    pt.latchedTo = undefined;
                    if (pt.state === 'latched') pt.state = 'intact';
                }
            }
        }
        return { name: part.name, damage, ...(hpBefore !== undefined ? { hpBefore, hpAfter: part.hp } : {}), broken, state: part.state };
    }

    /**
     * Execute a heal action
     */
    executeHeal(actorId: string, targetId: string, amount: number): CombatActionResult {
        if (!this.state) throw new Error('No active combat');

        const actor = this.state.participants.find(p => p.id === actorId);
        const target = this.state.participants.find(p => p.id === targetId);
        
        if (!actor) throw new Error(`Actor ${actorId} not found`);
        if (!target) throw new Error(`Target ${targetId} not found`);

        const hpBefore = target.hp;
        const actualHeal = Math.min(amount, target.maxHp - target.hp);
        target.hp = Math.min(target.maxHp, target.hp + amount);
        // Coming back above 0 clears the death-save track and wakes a knockout.
        const woke = hpBefore <= 0 && target.hp > 0 ? this.riseFromZero(target) : [];

        const breakdown = `💚 Heal: ${amount} HP\n` +
            `   ${target.name}: ${hpBefore} → ${target.hp}/${target.maxHp} HP\n` +
            (actualHeal < amount ? `   (${amount - actualHeal} HP wasted - at max)` : '') +
            (woke.length ? `\n   💤→👁 ${target.name} comes round (${woke.join(', ')} cleared)` : '');

        const message = `${actor.name} heals ${target.name} for ${actualHeal} HP`;

        this.emitter?.publish('combat', {
            type: 'heal_executed',
            result: {
                actor: actor.name,
                target: target.name,
                amount: actualHeal,
                targetHp: target.hp
            }
        });

        return {
            type: 'heal',
            actor: { id: actor.id, name: actor.name },
            target: { id: target.id, name: target.name, hpBefore, hpAfter: target.hp, maxHp: target.maxHp },
            healAmount: actualHeal,
            ...(woke.length ? { woke: { conditionsRemoved: woke } } : {}),
            success: true,
            defeated: false,
            message,
            detailedBreakdown: breakdown
        };
    }

    /**
     * MED-003 / play report 5: a participant that comes back above 0 starts
     * the death-save track fresh, is no longer "stable", and a non-lethal
     * knockout's Unconscious leaves (an Unconscious from another source stays).
     * Returns the condition types removed.
     */
    private riseFromZero(participant: CombatParticipant): string[] {
        // Play report 5 #4/#5: both counters, the stable and due flags and the
        // dying Unconscious go (prone stays until they stand); a knockout's
        // Unconscious goes too and is the list the reply names.
        wakeFromDying(participant);
        return clearNonlethalUnconscious(participant);
    }

    /** Play report 5: a posted correction that lifts a knocked-out token above 0 wakes it. */
    wakeFromNonlethal(participantId: string): string[] {
        const participant = this.state?.participants.find(p => p.id === participantId);
        return participant ? clearNonlethalUnconscious(participant) : [];
    }

    /**
     * Pathfinder 2e: Make a check and return degree of success
     */
    makeCheck(
        modifier: number,
        dc: number
    ): 'critical-failure' | 'failure' | 'success' | 'critical-success' {
        return this.rng.checkDegree(modifier, dc);
    }

    /**
     * Make a detailed check exposing all dice mechanics
     */
    makeCheckDetailed(modifier: number, dc: number): CheckResult {
        return this.rng.checkDegreeDetailed(modifier, dc);
    }

    /**
     * Apply damage to a participant
     */
    applyDamage(participantId: string, damage: number, opts: { crit?: boolean; melee?: boolean } = {}): DyingUpdate | undefined {
        if (!this.state) return undefined;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return undefined;
        // Request 5: a vessel's shields take it first.
        const hpBefore = participant.hp;
        const soak = absorbWithShields(participant, damage);
        participant.hp = Math.max(0, participant.hp - soak.through);
        this.refreshVessel(participant);
        // Play report 5 #5: a tracked token dropped to 0 goes unconscious and
        // prone; one already down takes a failed save (two on a crit).
        const dying = damageAtZero(participant, hpBefore, soak.through, opts);
        this.emitter?.publish('combat', {
            type: 'damage_applied',
            participantId,
            amount: damage,
            ...(soak.absorbed ? { shieldsAbsorbed: soak.absorbed } : {}),
            newHp: participant.hp,
            ...(dying ? { dying } : {})
        });
        return dying;
    }

    /**
     * Request 5: derive a vessel's flags from its sections. A dead reactor
     * sets reactorBreach (the d6 rolls at each of its turn starts). Called
     * after damage and after part changes; harmless on anything else.
     */
    refreshVessel(participant: CombatParticipant): void {
        if (!participant.vessel) return;
        if (roleState(participant, 'reactor') === 'dead') participant.reactorBreach = true;
        else if (participant.reactorBreach) delete participant.reactorBreach; // the reactor was repaired: breach contained
    }

    /**
     * Request 5: the vessel's start-of-turn book-keeping. Shields regen by
     * regenPerRound; a breached reactor rolls a logged d6 (purpose 'reactor
     * breach'): a 1 destroys the vessel (hull 0, dead). Notes go to the
     * advance output.
     */
    private processVesselTurnStart(participant: CombatParticipant): void {
        if (!participant.vessel) return;
        this.refreshVessel(participant);
        const regen = participant.vessel.regenPerRound ?? 0;
        if (participant.shields && regen > 0 && participant.shields.current < participant.shields.max) {
            const before = participant.shields.current;
            participant.shields.current = Math.min(participant.shields.max, before + regen);
            this.turnStartNotes.push(`${participant.name}: shields regenerate ${participant.shields.current - before} (${before} → ${participant.shields.current}/${participant.shields.max})`);
        }
        if (participant.reactorBreach) {
            const d6 = this.tagged({ purpose: 'reactor breach', forId: participant.id }, () => this.rng.roll('1d6'));
            if (d6 === 1) {
                participant.hp = 0;
                participant.isDead = true;
                if (participant.shields) participant.shields.current = 0;
                this.turnStartNotes.push(`${participant.name}: REACTOR BREACH d6=1 — the reactor goes critical; the vessel is destroyed (hull 0)`);
                this.emitter?.publish('combat', { type: 'vessel_destroyed', participantId: participant.id, cause: 'reactor breach' });
            } else {
                this.turnStartNotes.push(`${participant.name}: reactor breach holds (d6=${d6}, a 1 destroys it)`);
            }
        }
    }

    /**
     * Heal a participant
     * MED-003: Also resets death saves if healing from 0 HP
     */
    heal(participantId: string, amount: number): void {
        if (!this.state) return;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (participant) {
            const wasAtZero = participant.hp === 0;
            participant.hp = Math.min(participant.maxHp, participant.hp + amount);

            // MED-003: Reset death saves when healed from 0 HP (and wake a knockout, play report 5)
            if (wasAtZero && participant.hp > 0) this.riseFromZero(participant);

            this.emitter?.publish('combat', {
                type: 'healed',
                participantId,
                amount,
                newHp: participant.hp
            });
        }
    }

    /**
     * MED-003: Roll a death saving throw for a participant at 0 HP
     * D&D 5e Rules:
     * - Roll d20
     * - 10+ = success
     * - 9 or less = failure
     * - Natural 20 = regain 1 HP (conscious again)
     * - Natural 1 = counts as 2 failures
     * - 3 successes = stabilized (unconscious but won't die)
     * - 3 failures = dead
     */
    rollDeathSave(participantId: string): DeathSaveResult | null {
        if (!this.state) return null;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return null;

        // Can only roll death saves at 0 HP
        if (participant.hp > 0) {
            return null;
        }

        // Already dead - can't roll
        if (participant.isDead) {
            return null;
        }

        // Already stabilized - no need to roll
        if (participant.isStabilized) {
            return null;
        }

        // Roll the d20 on the encounter's seeded stream (recorded, replayable:
        // purpose 'death save', forId the creature). Play report 5 #5: the
        // outcome arithmetic is shared with posted saves (applyDeathSaveOutcome).
        const answersDue = !!participant.deathSaveDue;
        const roll = this.rollD20({ purpose: 'death save', forId: participantId });
        const result: DeathSaveResult = applyDeathSaveOutcome(participant, outcomeOfRoll(roll), roll, this.state.round);
        this.afterDeathSave(participant, result, answersDue);

        this.emitter?.publish('combat', {
            type: 'death_save',
            participantId,
            result
        });

        return result;
    }

    /**
     * Play report 5 #5: what every death save leaves behind. A natural 20
     * wakes the creature fully: a knockout's Unconscious (a token knocked out
     * earlier, then hit lethally) goes with the dying one. A save made by
     * hand before the slot comes up is banked as that slot's save, so the
     * advance rolls no second die; one that answers DEATH SAVE DUE is the
     * slot's own and is consumed at once.
     */
    private afterDeathSave(participant: CombatParticipant, result: DeathSaveResult, answersDue: boolean): void {
        if (result.regainedHp) clearNonlethalUnconscious(participant);
        participant.deathSaveTaken = !answersDue && !result.regainedHp && !result.isDead && !result.isStabilized;
    }

    /**
     * MED-003: Apply damage at 0 HP (causes automatic death save failures)
     * D&D 5e Rules: Taking damage at 0 HP = 1 failure (crit = 2 failures)
     */
    applyDamageAtZeroHp(participantId: string, isCritical: boolean = false): void {
        if (!this.state) return;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant || participant.hp > 0 || participant.isDead) return;

        // Initialize if needed
        if (participant.deathSaveFailures === undefined) {
            participant.deathSaveFailures = 0;
        }

        // Critical hits cause 2 failures, normal hits cause 1
        const failures = isCritical ? 2 : 1;
        participant.deathSaveFailures = Math.min(3, participant.deathSaveFailures + failures);

        if (participant.deathSaveFailures >= 3) {
            participant.isDead = true;
        }

        // No longer stabilized if taking damage
        participant.isStabilized = false;

        this.emitter?.publish('combat', {
            type: 'death_save_failure',
            participantId,
            failures,
            total: participant.deathSaveFailures,
            isDead: participant.isDead
        });
    }

    /**
     * Check if a participant is still conscious (hp > 0)
     */
    isConscious(participantId: string): boolean {
        if (!this.state) return false;

        const participant = this.state.participants.find(p => p.id === participantId);
        return participant ? participant.hp > 0 : false;
    }

    /**
     * Get count of conscious participants
     */
    getConsciousCount(): number {
        if (!this.state) return 0;

        return this.state.participants.filter(p => p.hp > 0).length;
    }

    /**
     * Apply a condition to a participant
     */
    applyCondition(participantId: string, condition: Omit<Condition, 'id'>): Condition {
        if (!this.state) throw new Error('No active combat');

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) throw new Error(`Participant ${participantId} not found`);

        // Generate unique ID for condition instance
        const fullCondition: Condition = {
            ...condition,
            id: `${participantId}-${condition.type}-${Date.now()}-${Math.random()}`
        };

        participant.conditions.push(fullCondition);
        return fullCondition;
    }

    /**
     * Remove a specific condition instance by ID
     */
    removeCondition(participantId: string, conditionId: string): boolean {
        if (!this.state) return false;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return false;

        const initialLength = participant.conditions.length;
        participant.conditions = participant.conditions.filter(c => c.id !== conditionId);
        return participant.conditions.length < initialLength;
    }

    /**
     * Remove all conditions of a specific type from a participant
     */
    removeConditionsByType(participantId: string, type: ConditionType): number {
        if (!this.state) return 0;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return 0;

        const initialLength = participant.conditions.length;
        participant.conditions = participant.conditions.filter(c => c.type !== type);
        return initialLength - participant.conditions.length;
    }

    /**
     * Check if a participant has a specific condition type
     */
    hasCondition(participantId: string, type: ConditionType): boolean {
        if (!this.state) return false;

        const participant = this.state.participants.find(p => p.id === participantId);
        return participant ? participant.conditions.some(c => c.type === type) : false;
    }

    /**
     * Get all conditions on a participant
     */
    getConditions(participantId: string): Condition[] {
        if (!this.state) return [];

        const participant = this.state.participants.find(p => p.id === participantId);
        return participant ? [...participant.conditions] : [];
    }

    /**
     * HIGH-003: Reset reaction and disengage status at start of turn
     */
    private resetTurnResources(participant: CombatParticipant): void {
        // Dodge lasts until the dodger's next turn; unused Help lapses when
        // the helper's next turn starts.
        participant.isDodging = false;
        for (const p of this.state?.participants ?? []) {
            if (p.helpedBy === participant.id) p.helpedBy = undefined;
        }
        participant.reactionUsed = false;
        participant.hasDisengaged = false;
        participant.hasDashed = false;
        participant.dashes = 0;
        participant.extraActions = 0;
        participant.actionUsed = false;
        participant.attacksMade = 0;
        participant.bonusActionUsed = false;
        participant.spellsCast = {};
        participant.movementRemaining = this.effectiveSpeed(participant);
        // Play report 5: trigger-tied attacks read these; a new turn starts them fresh.
        participant.movedThisTurn = 0;
        participant.movedSinceDash = 0;
        participant.meleeHitsThisTurn = [];
        participant.actedThisTurn = false;
    }

    /**
     * Play report 7 #6: the token took a combat action (any combat_action, a
     * free battle cry or ability, a readied action set this turn). The PC
     * turn guard reads it with the economy; its turn start clears it.
     */
    markActed(participantId: string): void {
        const participant = this.state?.participants.find(p => p.id === participantId);
        if (!participant) return;
        participant.actedThisTurn = true;
        // A controlled mount acts at its rider's word (Dash, Disengage, Dodge on
        // the rider's turn): the rider's turn is touched too.
        if (this.state && isControlledMount(this.state, participant)) {
            const rider = this.state.participants.find(p => p.id === participant.controlledBy);
            if (rider) rider.actedThisTurn = true;
        }
    }

    /**
     * Play report 7 #6: run a token's turn start outside an advance, for a
     * natural 20 answering DEATH SAVE DUE (the advance stopped on the slot at
     * 0 HP and skipped its start). Returns what the start did (regeneration,
     * recharge, fading buffs), as an advance prints them.
     */
    beginTurn(participantId: string): string[] {
        const participant = this.state?.participants.find(p => p.id === participantId);
        this.turnStartNotes = [];
        if (participant && participant.hp > 0) this.processStartOfTurnConditions(participant);
        return [...this.turnStartNotes];
    }

    /**
     * Play report 7 #6: remove_participant took the actor that was up out of
     * the order (`removedIndex`: its slot before the removal). The next slot
     * comes up exactly as an advance brings it up: a surprised slot passes, a
     * dying slot rolls its death save (prompt mode: DEATH SAVE DUE), a
     * controlled mount's slot and an orphaned LAIR pass, past the last slot
     * the next round opens, and the new actor's turn starts. No end-of-turn
     * runs: the creature whose turn it was has left. turnStartNotes and
     * deathSaveEvents carry what happened, as after an advance.
     */
    startNextAfterRemoval(removedIndex: number, opts: { deathSaveMode?: DeathSaveMode; encounterId?: string; saverSides?: SaverSidesProvider } = {}): CombatParticipant | null {
        if (!this.state || this.state.turnOrder.length === 0) return null;
        this.turnStartNotes = [];
        this.deathSaveEvents = [];
        // Play report 7 (lane H): a surprised slot passed here rolls its end-of-turn saves.
        this.endOfTurnSaves = [];
        if (opts.saverSides) this.saverSides = opts.saverSides;
        this.deathSaveModeDefault = opts.deathSaveMode;
        if (opts.encounterId) this.encounterId = opts.encounterId;
        this.state.currentTurnIndex = removedIndex - 1;
        const up = this.advanceToNextActor();
        this.emitter?.publish('combat', {
            type: 'turn_changed',
            round: this.state.round,
            activeParticipantId: up?.id,
            isLairAction: this.isLairActionPending()
        });
        return up;
    }

    /**
     * Battle-cry buffs end at the start of their source's turn once the round
     * is past untilRound. A buff whose source is gone or down ends at the
     * start of its bearer's own turn instead, so it never outlives the fight.
     */
    private expireBuffs(participant: CombatParticipant): void {
        if (!this.state) return;
        const round = this.state.round;
        const faded = new Map<string, string[]>();
        for (const p of this.state.participants) {
            if (!p.buffs?.length) continue;
            const keep = p.buffs.filter(b => {
                if (round <= b.untilRound) return true;
                const source = b.sourceId ? this.state!.participants.find(o => o.id === b.sourceId) : undefined;
                const orphan = !source || source.hp <= 0;
                const ends = b.sourceId === participant.id || (orphan && p.id === participant.id);
                if (ends) faded.set(b.name, [...(faded.get(b.name) ?? []), p.name]);
                return !ends;
            });
            p.buffs = keep.length ? keep : undefined;
        }
        for (const [name, who] of faded) this.turnStartNotes.push(`${name} fades from ${who.join(', ')}`);
    }

    /**
     * Item 16: conditions carrying metadata.endsAtEndOfTurnOf = this
     * participant's id end now when the round has reached metadata.afterRound
     * (Menacing Attack: until the end of the attacker's next turn).
     */
    private expireSourceTurnConditions(source: CombatParticipant): void {
        if (!this.state) return;
        const round = this.state.round;
        for (const p of this.state.participants) {
            const keep = p.conditions.filter(c => {
                const meta = c.metadata as { endsAtEndOfTurnOf?: string; afterRound?: number } | undefined;
                if (meta?.endsAtEndOfTurnOf !== source.id) return true;
                if (typeof meta.afterRound === 'number' && round < meta.afterRound) return true;
                this.turnStartNotes.push(`${p.name} is no longer ${c.type} of ${source.name}`);
                return false;
            });
            if (keep.length !== p.conditions.length) p.conditions = keep;
        }
    }

    /** Item 16: a source-turn condition whose source is dead or gone ends at its bearer's turn start. */
    private expireOrphanedSourceTurnConditions(bearer: CombatParticipant): void {
        if (!this.state) return;
        const keep = bearer.conditions.filter(c => {
            const meta = c.metadata as { endsAtEndOfTurnOf?: string } | undefined;
            if (!meta?.endsAtEndOfTurnOf) return true;
            const source = this.state!.participants.find(o => o.id === meta.endsAtEndOfTurnOf);
            if (source && source.hp > 0) return true;
            this.turnStartNotes.push(`${bearer.name} is no longer ${c.type}${source ? ` of ${source.name} (down)` : ''}`);
            return false;
        });
        if (keep.length !== bearer.conditions.length) bearer.conditions = keep;
    }

    // ── Environment: the medium the fight happens in ──────────────────

    /** The encounter's environment with its defaults filled (air when unset). */
    environmentOf(): Required<Pick<EncounterEnvironment, 'medium' | 'swimTag' | 'meleeDisadvantageUnlessDamageType' | 'rangedAllowed'>> & EncounterEnvironment {
        const env = this.state?.environment;
        return {
            ...env,
            medium: env?.medium ?? 'air',
            swimTag: env?.swimTag ?? 'aquatic',
            meleeDisadvantageUnlessDamageType: env?.meleeDisadvantageUnlessDamageType ?? ['piercing'],
            rangedAllowed: env?.rangedAllowed ?? false
        };
    }

    /** Whether the token swims: a water encounter, or a terrain.water cell under it in an air one. */
    inWater(participant: CombatParticipant): boolean {
        if (!this.state) return false;
        if (this.state.environment?.medium === 'water') return true;
        const water = this.state.terrain?.water;
        if (!water?.length || !participant.position) return false;
        return water.includes(`${participant.position.x},${participant.position.y}`);
    }

    /** Whether the token carries a tag (any case). */
    hasTag(participant: CombatParticipant, tag: string | undefined): boolean {
        if (!tag) return false;
        const want = tag.trim().toLowerCase();
        return (participant.tags ?? []).some(t => t.trim().toLowerCase() === want);
    }

    /**
     * Base speed after conditions whose metadata carries a speedFactor (a
     * crippled leg halves it) and the standard conditions' own speed.
     */
    effectiveSpeed(participant: CombatParticipant): number {
        // Held by another creature's latched part: it cannot move away.
        if (this.state?.participants.some(o => o.parts?.some(pt => pt.state === 'latched' && pt.latchedTo?.participantId === participant.id))) return 0;
        // Request 5: a vessel with its drive crippled or dead is adrift.
        if (participant.vessel && roleState(participant, 'drive') !== 'intact') return 0;
        // Underwater the budget is the swim speed, else half the walking speed.
        const walk = participant.movementSpeed ?? 30;
        const medium = this.inWater(participant) ? (participant.swimSpeed ?? Math.floor(walk / 2)) : walk;
        // Battle-cry speed adds to the base, before any halving.
        const base = medium + (participant.buffs ?? []).reduce((n, b) => n + (b.speedBonus ?? 0), 0);
        let factor = participant.conditions.reduce((f, c) => {
            const sf = c.metadata?.speedFactor;
            return typeof sf === 'number' ? f * sf : f;
        }, 1);
        // A crippled leg or wing halves speed (once, however many).
        if (participant.parts?.some(pt => pt.state === 'crippled' && (pt.kind === 'leg' || pt.kind === 'wing'))) factor *= 0.5;
        // Standard conditions: grappled, restrained, stunned... root the
        // creature; exhaustion 2 halves speed and 5 stops it.
        factor *= conditionSpeedFactor(participant.conditions);
        return Math.floor(base * factor);
    }

    /**
     * The Dodge action: until the start of its next turn, attacks against the
     * participant roll at disadvantage. Consumes the main action.
     */
    applyDodge(participantId: string): { ok: true } | { ok: false; error: string } {
        if (!this.state) return { ok: false, error: 'No active combat' };
        const participant = this.state.participants.find((p) => p.id === participantId);
        if (!participant) return { ok: false, error: `Participant ${participantId} not found` };
        const econ = this.validateActionEconomy(participantId, 'action');
        if (!econ.valid) return { ok: false, error: econ.error || 'Action already used this turn' };
        participant.isDodging = true;
        this.takeAction(participant, 'other');
        return { ok: true };
    }

    /**
     * The Help action: the ally's next attack before the helper's next turn
     * rolls with advantage. Consumes the helper's main action.
     */
    applyHelp(helperId: string, allyId: string): { ok: true } | { ok: false; error: string } {
        if (!this.state) return { ok: false, error: 'No active combat' };
        const helper = this.state.participants.find((p) => p.id === helperId);
        if (!helper) return { ok: false, error: `Participant ${helperId} not found` };
        const ally = this.state.participants.find((p) => p.id === allyId);
        if (!ally) return { ok: false, error: `Participant ${allyId} not found` };
        if (helperId === allyId) return { ok: false, error: 'A participant cannot Help itself' };
        const econ = this.validateActionEconomy(helperId, 'action');
        if (!econ.valid) return { ok: false, error: econ.error || 'Action already used this turn' };
        ally.helpedBy = helperId;
        this.takeAction(helper, 'other');
        return { ok: true };
    }

    /**
     * Apply the Dash action for a participant. Adds a fresh movement
     * allotment on top of whatever they already have left and counts the
     * dash, so the budget-check in move actions (moveBudget) sees the wider
     * window. Consumes the main action: a second Dash in a turn needs an
     * extra action (Action Surge).
     */
    applyDash(participantId: string): { ok: true; movementRemaining: number } | { ok: false; error: string } {
        if (!this.state) return { ok: false, error: 'No active combat' };
        const participant = this.state.participants.find((p) => p.id === participantId);
        if (!participant) return { ok: false, error: `Participant ${participantId} not found` };

        // Dash IS the action. Reject if the participant already burned their
        // main action this turn (5e action economy). Without this guard, a
        // caller could attack and then dash for a free 60ft of movement.
        const econ = this.validateActionEconomy(participantId, 'action');
        if (!econ.valid) {
            return { ok: false, error: econ.error || 'Action already used this turn' };
        }

        const baseSpeed = this.effectiveSpeed(participant);
        const currentRemaining = participant.movementRemaining ?? baseSpeed;
        this.takeAction(participant, 'other');
        participant.movementRemaining = currentRemaining + baseSpeed;
        participant.dashes = (participant.dashes ?? 0) + 1;
        participant.hasDashed = true;
        // Play report 5: Goring Rush counts the feet moved AFTER the Dash.
        participant.movedSinceDash = 0;

        return { ok: true, movementRemaining: participant.movementRemaining };
    }

    /**
     * The most movement a participant may spend this turn: its speed, plus
     * one allotment per Dash taken (hasDashed alone counts as one for tokens
     * saved before dashes were counted).
     */
    moveBudget(participant: CombatParticipant): number {
        return this.effectiveSpeed(participant) * (1 + (participant.dashes ?? (participant.hasDashed ? 1 : 0)));
    }

    /**
     * Bank an extra action (Action Surge) for this turn. Only on the
     * participant's own turn and while it can act; the bank clears when the
     * turn ends, so a surge never leaks into off-turn swings.
     */
    grantExtraAction(participantId: string, n: number = 1): { ok: true; extraActions: number } | { ok: false; error: string } {
        if (!this.state) return { ok: false, error: 'No active combat' };
        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return { ok: false, error: `Participant ${participantId} not found` };
        if (this.state.turnOrder[this.state.currentTurnIndex] !== participantId) {
            return { ok: false, error: `${participant.name} can only gain an extra action on its own turn` };
        }
        if (!this.canTakeActions(participantId)) return { ok: false, error: `${participant.name} is incapacitated` };
        participant.extraActions = (participant.extraActions ?? 0) + n;
        return { ok: true, extraActions: participant.extraActions };
    }

    /**
     * The one place an action is consumed. An attack spends the action,
     * continues an open multiattack, or spends a banked extra action (a
     * fresh Attack action). Any other use spends the action or an extra;
     * an extra spent this way closes an open Attack action. Callers
     * validate first; false means nothing was left to spend.
     */
    private takeAction(participant: CombatParticipant, kind: 'attack' | 'other'): boolean {
        const of = participant.attacksPerAction ?? 1;
        const made = participant.attacksMade ?? 0;
        if (kind === 'attack') {
            if (!participant.actionUsed) {
                participant.actionUsed = true;
                participant.attacksMade = 1;
                return true;
            }
            if (made > 0 && made < of) {
                participant.attacksMade = made + 1;
                return true;
            }
            if ((participant.extraActions ?? 0) > 0) {
                participant.extraActions = (participant.extraActions ?? 0) - 1;
                participant.attacksMade = 1;
                return true;
            }
            participant.attacksMade = made + 1;
            return false;
        }
        if (!participant.actionUsed) {
            participant.actionUsed = true;
            return true;
        }
        if ((participant.extraActions ?? 0) > 0) {
            participant.extraActions = (participant.extraActions ?? 0) - 1;
            participant.attacksMade = of;
            return true;
        }
        return false;
    }

    /**
     * Process start-of-turn condition effects
     */
    private processStartOfTurnConditions(participant: CombatParticipant): void {
        // Battle cries end first, so this turn's speed no longer carries them.
        this.expireBuffs(participant);
        // Item 16: a fright whose source is gone or down ends at the bearer's
        // own turn start (the source's end-of-turn sweep would never come).
        this.expireOrphanedSourceTurnConditions(participant);

        // HIGH-003: Reset reaction at start of turn
        this.resetTurnResources(participant);
        // Play report 7 #10: a controlled mount's turn starts with its rider's
        // (movement, reaction, durations, regeneration), as its slot passes.
        const steed = this.controlledMountOf(participant);
        if (steed && steed.hp > 0) {
            this.processStartOfTurnConditions(steed);
            this.turnStartNotes.push(`🐎 ${steed.name} acts on ${participant.name}'s turn (controlled mount): ${steed.movementRemaining ?? this.effectiveSpeed(steed)} ft of its own movement; it may Dash, Disengage or Dodge`);
        }

        // LEGENDARY: Reset legendary actions at start of legendary creature's turn
        this.resetLegendaryActions(participant);

        // Table rules: a regenerating creature heals its stated amount at the
        // start of each of its turns. Destroyed stays destroyed: not at 0 HP.
        if (participant.regeneration && participant.hp > 0 && participant.hp < participant.maxHp) {
            const before = participant.hp;
            participant.hp = Math.min(participant.maxHp, participant.hp + participant.regeneration);
            this.turnStartNotes.push(`${participant.name} regenerates ${participant.hp - before} HP (${before} → ${participant.hp}/${participant.maxHp})`);
        }

        // Pressure: in a water encounter at or below the threshold depth, a
        // token that is not pressure-adapted (the unlessTag, else the swim
        // tag) takes the stated damage at the start of each of its turns.
        const env = this.environmentOf();
        const pressure = env.pressure;
        if (pressure && env.medium === 'water' && participant.hp > 0 && (env.depthFt ?? 0) >= pressure.startsAtFt
            && !this.hasTag(participant, pressure.unlessTag ?? env.swimTag)) {
            const amount = typeof pressure.damagePerRound === 'number'
                ? pressure.damagePerRound
                : this.tagged({ purpose: 'pressure', forId: participant.id }, () => this.rng.roll(pressure.damagePerRound as string));
            if (amount > 0) {
                const before = participant.hp;
                this.applyDamage(participant.id, amount);
                this.turnStartNotes.push(`${participant.name} takes ${amount} pressure damage at ${env.depthFt} ft (${before} → ${participant.hp}/${participant.maxHp})`);
            }
        }
        // Request 5: shields regen and the reactor-breach die.
        this.processVesselTurnStart(participant);

        // Recharge: each spent ability with a recharge number rolls a d6 on
        // the encounter stream; that number or more makes it ready again.
        for (const ability of participant.abilities ?? []) {
            if (!ability.recharge || ability.ready !== false) continue;
            const d6 = this.tagged({ purpose: `recharge ${ability.name}`, forId: participant.id }, () => this.rng.roll('1d6'));
            if (d6 >= ability.recharge) ability.ready = true;
            this.turnStartNotes.push(`${participant.name}: ${ability.name} ${ability.ready ? 'recharges' : 'does not recharge'} (d6=${d6}, needs ${ability.recharge}+)`);
        }

        for (const condition of [...participant.conditions]) {
            // Process ongoing effects
            if (condition.ongoingEffects) {
                for (const effect of condition.ongoingEffects) {
                    if (effect.trigger === 'start_of_turn') {
                        if (effect.type === 'damage' && effect.amount) {
                            this.applyDamage(participant.id, effect.amount);
                        } else if (effect.type === 'healing' && effect.amount) {
                            this.heal(participant.id, effect.amount);
                        } else if (effect.type === 'damage' && effect.dice) {
                            const damage = this.tagged({ purpose: `ongoing ${condition.type}`, forId: participant.id }, () => this.rng.roll(effect.dice!));
                            this.applyDamage(participant.id, damage);
                        }
                    }
                }
            }

            // Handle duration for START_OF_TURN conditions
            if (condition.durationType === DurationType.START_OF_TURN) {
                this.removeCondition(participant.id, condition.id);
            } else if (condition.durationType === DurationType.ROUNDS && condition.duration !== undefined) {
                // Decrement round-based durations at start of turn
                condition.duration--;
                if (condition.duration <= 0) {
                    this.removeCondition(participant.id, condition.id);
                }
            }
        }
    }

    /**
     * Process end-of-turn condition effects
     */
    private processEndOfTurnConditions(participant: CombatParticipant): void {
        for (const condition of [...participant.conditions]) {
            // Process ongoing effects
            if (condition.ongoingEffects) {
                for (const effect of condition.ongoingEffects) {
                    if (effect.trigger === 'end_of_turn') {
                        if (effect.type === 'damage' && effect.amount) {
                            this.applyDamage(participant.id, effect.amount);
                        } else if (effect.type === 'healing' && effect.amount) {
                            this.heal(participant.id, effect.amount);
                        } else if (effect.type === 'damage' && effect.dice) {
                            const damage = this.tagged({ purpose: `ongoing ${condition.type}`, forId: participant.id }, () => this.rng.roll(effect.dice!));
                            this.applyDamage(participant.id, damage);
                        }
                    }
                }
            }

            // Handle duration for END_OF_TURN conditions
            if (condition.durationType === DurationType.END_OF_TURN) {
                this.removeCondition(participant.id, condition.id);
            }

            // Handle save-ends conditions
            if (condition.durationType === DurationType.SAVE_ENDS && condition.saveDC && condition.saveAbility) {
                const save = this.rollEndOfTurnSave(participant, condition);
                if (save.saved) {
                    this.removeCondition(participant.id, condition.id);
                }
            }
        }
    }

    /**
     * Play report 7 (lane H): the end-of-turn save of a save_ends condition,
     * a 5e saving throw like every other save the engine rolls. The handler
     * layer's provider (SaverSides) gives the saver's declared sides (untagged
     * save:<ability> mechanics; tagged ones as hints) and its modifier (the
     * sheet's ability and save proficiency on the world's curve); without one,
     * the token's ability modifier as before; a unit token adds its drilled
     * unit.saves bonus either way. The token's own conditions add
     * their 5e save rules here (restrained: DEX, the very condition being
     * saved against included; exhaustion 3+). Advantage or disadvantage rolls
     * two dice under one labelled purpose and keeps one; both cancel to one
     * die. The kept die meets the DC by the same degree rule as before
     * (checkDegreeOf). A turn note and an endOfTurnSaves row say what happened.
     */
    private rollEndOfTurnSave(participant: CombatParticipant, condition: Condition): EndOfTurnSave {
        const ability = condition.saveAbility!;
        const dc = condition.saveDC!;
        const short = ability.slice(0, 3) as 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
        let read: SaverSides | undefined;
        // A provider that cannot read (no database) leaves the engine's own reading.
        try { read = this.saverSides?.(participant, ability); } catch { read = undefined; }
        const once = (list: string[]) => list.filter((x, i) => list.findIndex(y => y.toLowerCase() === x.toLowerCase()) === i);
        const advantage = once([...(read?.advantage ?? [])]);
        const disadvantage = once([...(read?.disadvantage ?? []), ...conditionSaveDisadvantage(tokenSaveConditions(participant.conditions), short)]);
        const conditional = [...(read?.conditionalAdvantage ?? []), ...(read?.conditionalDisadvantage ?? [])];
        const ownMod = this.getSaveBonus(participant, ability);
        // Lane H review: a unit token's drilled bonus (unit.saves) rides this
        // save as it rides each model's area save (unitSaveBonus).
        const drilled = participant.unit?.saves?.[short] ?? 0;
        const modifier = (read?.modifier?.total ?? ownMod) + drilled;
        const parts = [...(read?.modifier?.parts ?? [`${short.toUpperCase()} ${ownMod >= 0 ? '+' : ''}${ownMod}`]), ...(drilled ? [`drilled ${drilled >= 0 ? '+' : ''}${drilled}`] : [])];
        const tag = { purpose: purposeWithSources(`save vs ${condition.type}`, { advantage, disadvantage }), forId: participant.id };
        const two = !!advantage.length !== !!disadvantage.length;
        const rolls = [this.rollD20(tag)];
        if (two) rolls.push(this.rollD20(tag));
        const natural = !two ? rolls[0] : advantage.length ? Math.max(...rolls) : Math.min(...rolls);
        const check = checkDegreeOf(natural, modifier, dc);
        const saved = check.degree === 'success' || check.degree === 'critical-success';
        // Lane H review: the old degree rule lets a natural 1 fail a total that
        // meets the DC (and a natural 20 save one that misses it); the line says
        // so, or '13 vs DC 13 ✗ failed' reads as an error.
        const natural20or1 = saved !== (check.total >= dc) ? ` on a natural ${natural}` : '';
        const line = `${participant.name}'s end-of-turn ${short.toUpperCase()} save vs ${condition.type}: d20 ${natural} ${modifier >= 0 ? '+' : '-'} ${Math.abs(modifier)} = ${check.total} vs DC ${dc}`
            + `${parts.length ? ` (${parts.join(', ')})` : ''} ${saved ? `✓ saved${natural20or1}: ${condition.type} ends` : `✗ failed${natural20or1}: still ${condition.type}`}`
            + rollSidesNote(rolls, { advantage, disadvantage });
        const save: EndOfTurnSave = {
            participantId: participant.id, name: participant.name, condition: String(condition.type), ability, dc,
            rolls, natural, modifier, parts, total: check.total, saved,
            ...(advantage.length ? { advantage } : {}),
            ...(disadvantage.length ? { disadvantage } : {}),
            ...(conditional.length ? { conditional } : {}),
            line
        };
        this.endOfTurnSaves.push(save);
        this.turnStartNotes.push(line + conditional.map(c => `\n   conditional: ${c}`).join(''));
        return save;
    }

    /**
     * Get saving throw bonus for a participant
     */
    private getSaveBonus(participant: CombatParticipant, ability: Ability): number {
        if (!participant.abilityScores) return 0;

        const score = participant.abilityScores[ability];
        // D&D 5e modifier calculation: (score - 10) / 2
        return Math.floor((score - 10) / 2);
    }

    /**
     * Enhanced nextTurn with condition processing and legendary action reset
     * Now auto-skips dead participants (HP <= 0)
     */
    nextTurnWithConditions(opts: { deathSaveMode?: DeathSaveMode; encounterId?: string; saverSides?: SaverSidesProvider } = {}): CombatParticipant | null {
        if (!this.state) return null;
        this.turnStartNotes = [];
        this.deathSaveEvents = [];
        // Play report 7 (lane H): the handlers pass the saver reader on every
        // advance, so an engine rehydrated in a new process has it too.
        this.endOfTurnSaves = [];
        if (opts.saverSides) this.saverSides = opts.saverSides;
        this.deathSaveModeDefault = opts.deathSaveMode;
        if (opts.encounterId) this.encounterId = opts.encounterId;

        // Process end-of-turn conditions for current participant (if not LAIR)
        const currentParticipant = this.getCurrentParticipant();
        if (currentParticipant && currentParticipant.hp > 0) {
            this.processEndOfTurnConditions(currentParticipant);
            // Play report 7 #10: a controlled mount acts on its rider's turn, so its turn ends with the rider's.
            const steed = this.controlledMountOf(currentParticipant);
            if (steed && steed.hp > 0) this.processEndOfTurnConditions(steed);
        }
        // Item 16: conditions that end at the end of THIS creature's turn on
        // other creatures (Menacing's fright), whether or not it is still up.
        if (currentParticipant) this.expireSourceTurnConditions(currentParticipant);
        // A telegraphed intent lasts one turn; a readied action stays. A
        // banked extra action (Action Surge) dies with the turn too.
        if (currentParticipant) {
            currentParticipant.intent = undefined;
            currentParticipant.extraActions = 0;
        }

        const newParticipant = this.advanceToNextActor();

        this.emitter?.publish('combat', {
            type: 'turn_changed',
            round: this.state.round,
            activeParticipantId: newParticipant?.id,
            isLairAction: this.isLairActionPending()
        });

        return newParticipant;
    }

    /**
     * Move to the next slot that acts: dead participants, a LAIR whose owner
     * is down, and the round-1 slot of a surprised participant are passed
     * over. The new actor's start-of-turn processing runs here.
     */
    private advanceToNextActor(): CombatParticipant | null {
        if (!this.state) return null;
        let iterations = 0;
        // Safety limit: every slot may be surprised once, then acts.
        const maxIterations = this.state.turnOrder.length * 2 + 1;
        let newParticipant: CombatParticipant | null = null;
        let passed = false;
        // Play report 5 #5: a dying tracked slot in prompt mode stops the
        // advance here (DEATH SAVE DUE) instead of passing.
        let stopHere = false;

        do {
            this.state.currentTurnIndex++;

            if (this.state.currentTurnIndex >= this.state.turnOrder.length) {
                this.state.currentTurnIndex = 0;
                this.state.round++;
            }

            newParticipant = this.getCurrentParticipant();
            iterations++;

            // Surprise lasts until the creature's first slot has come round,
            // alive or not: a downed one clears the flag without a pass note,
            // so a heal in round 2 does not lose it another turn.
            passed = false;
            stopHere = false;
            if (newParticipant?.surprised) {
                if (newParticipant.hp > 0) {
                    this.passSurprisedTurn(newParticipant);
                    passed = true;
                } else {
                    newParticipant.surprised = false;
                }
            }
            // The dying slot: auto rolls the save (a natural 20 means the
            // creature takes this turn); prompt stops and owes the GM a call.
            // Mooks, the stable and the dead pass as they always did.
            if (!passed && newParticipant && isDying(newParticipant)) {
                stopHere = this.dyingSlot(newParticipant);
            }
            // Play report 7 #10: a controlled mount moves on its rider's turn
            // (5e: its initiative matches the rider's), so its own slot passes.
            if (!passed && !stopHere && newParticipant && newParticipant.hp > 0 && isControlledMount(this.state, newParticipant)) {
                const rider = this.state.participants.find(p => p.id === newParticipant!.controlledBy);
                this.turnStartNotes.push(`🐎 ${newParticipant.name} moves on ${rider?.name ?? newParticipant.controlledBy}'s turn (controlled mount): its own slot passes`);
                passed = true;
            }
        } while (
            !stopHere &&
            (passed || (newParticipant && newParticipant.hp <= 0) || this.lairOwnerDown()) &&
            iterations < maxIterations
        );

        // Process start-of-turn conditions for new current participant (if alive)
        if (newParticipant && newParticipant.hp > 0) {
            this.processStartOfTurnConditions(newParticipant);
        }
        return newParticipant;
    }

    /**
     * Play report 5 #5: the advance has landed on a dying tracked slot. In
     * prompt mode (the token's deathSaveMode, else the world's) the slot is
     * held: DEATH SAVE DUE with the exact call, nothing rolled, and the
     * handler refuses the next advance until death_save clears the flag.
     * In auto mode the save is rolled here on the fight's dice (purpose
     * 'death save', forId the creature): a natural 20 brings it back to 1 HP
     * and it takes this turn; anything else is noted and the slot passes.
     * Returns true when the advance stops on this slot.
     */
    private dyingSlot(p: CombatParticipant): boolean {
        if (!this.state) return false;
        const mode: DeathSaveMode = p.deathSaveMode ?? this.deathSaveModeDefault ?? 'auto';
        const c = deathCounters(p);
        // A save the table already rolled or posted for this slot (death_save
        // before the advance: the player rolled their own) is the slot's save
        // in either mode: nothing is rolled, nothing is owed, the slot passes.
        if (p.deathSaveTaken) {
            p.deathSaveTaken = false;
            this.turnStartNotes.push(`🩸 ${p.name}: death save already made this round by hand (✓${c.successes} ✗${c.failures}) — no second roll; the slot passes`);
            return false;
        }
        if (mode === 'prompt') {
            p.deathSaveDue = true;
            this.turnStartNotes.push(`🩸 DEATH SAVE DUE: ${p.name} (0 HP, ✓${c.successes} ✗${c.failures}) — ${deathSaveCall(this.encounterId ?? '<encounterId>', p.id)} (or post it: outcome: success | failure | nat20 | nat1). advance is refused until it is rolled`);
            return true;
        }
        const result = this.rollDeathSave(p.id);
        if (!result) return false;
        p.deathSaveTaken = false; // the engine's own roll is this slot's save, not a banked one
        const after = `✓${result.successes} ✗${result.failures}`;
        let note: string;
        if (result.isNat20) note = `🩸 ${p.name}: death save d20=20 — NATURAL 20: back to 1 HP, conscious, and takes this turn`;
        else if (result.isDead) note = `☠ ${p.name}: death save d20=${result.roll} — ${result.isNat1 ? 'NATURAL 1, two failures: ' : 'failure: '}DEAD (${after})`;
        else if (result.isStabilized) note = `💤 ${p.name}: death save d20=${result.roll} — success: STABLE (${after}); unconscious, no more saves`;
        else if (result.isNat1) note = `🩸 ${p.name}: death save d20=1 — NATURAL 1: two failures (${after})`;
        else note = `🩸 ${p.name}: death save d20=${result.roll} — ${result.success ? 'success' : 'failure'} (${after})`;
        this.turnStartNotes.push(note);
        this.deathSaveEvents.push({ ...result, participantId: p.id, name: p.name, round: this.state.round, note });
        return result.isNat20;
    }

    /**
     * Play report 5 #5: a GM-posted death save (the table rolled it). No die
     * is thrown; the outcome lands exactly as posted and the due flag clears.
     */
    postDeathSave(participantId: string, outcome: DeathSaveOutcome): (DeathSaveResult & { posted: DeathSaveOutcome }) | null {
        if (!this.state) return null;
        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant || participant.hp > 0 || participant.isDead || participant.isStabilized) return null;
        const answersDue = !!participant.deathSaveDue;
        const result = applyDeathSaveOutcome(participant, outcome, undefined, this.state.round);
        this.afterDeathSave(participant, result, answersDue);
        this.emitter?.publish('combat', { type: 'death_save', participantId, result: { ...result, posted: outcome } });
        return { ...result, posted: outcome };
    }

    /** Play report 5 #5: stabilise a creature at 0 HP (combat_action stabilize): unconscious, no more saves, counters fresh. */
    stabilize(participantId: string): boolean {
        const participant = this.state?.participants.find(p => p.id === participantId);
        if (!participant || participant.hp > 0 || participant.isDead) return false;
        markStable(participant);
        this.emitter?.publish('combat', { type: 'stabilized', participantId });
        return true;
    }

    /**
     * A surprised participant's first turn passes: it is noted, its start-
     * and end-of-turn effects still tick (regeneration, recharge, ongoing
     * damage, durations), and the flag clears so it reacts and acts from
     * here on.
     */
    private passSurprisedTurn(participant: CombatParticipant): void {
        this.turnStartNotes.push(`😲 ${participant.name} is surprised: its first turn passes`);
        this.processStartOfTurnConditions(participant);
        this.processEndOfTurnConditions(participant);
        participant.surprised = false;
    }

    /** The LAIR slot is up but the creature that owns the lair is dead: skip it. */
    private lairOwnerDown(): boolean {
        if (!this.state || this.state.turnOrder[this.state.currentTurnIndex] !== 'LAIR') return false;
        const owner = this.state.participants.find(p => p.id === this.state!.lairOwnerId);
        return !!owner && owner.hp <= 0;
    }

    /** Play report 7 #10: the mount this participant rides and controls, if any. */
    controlledMountOf(participant: CombatParticipant): CombatParticipant | undefined {
        return this.state ? controlledMountOf(this.state, participant) : undefined;
    }

    /**
     * Check if a participant can take actions (not incapacitated)
     */
    canTakeActions(participantId: string): boolean {
        if (!this.state) return false;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant || participant.hp <= 0) return false;

        // Check for incapacitating conditions. Custom conditions (names outside
        // ConditionType, kept verbatim by normalizeCondition) have no entry in
        // CONDITION_EFFECTS and no mechanical effect — never a crash.
        return !participant.conditions.some(c => {
            const effects = CONDITION_EFFECTS[c.type];
            return effects?.canTakeActions === false;
        });
    }

    /**
     * Check if a participant can take reactions
     */
    canTakeReactions(participantId: string): boolean {
        if (!this.state) return false;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant || participant.hp <= 0) return false;
        // Caught flat-footed: no reaction until its first turn has passed.
        if (participant.surprised) return false;

        return !participant.conditions.some(c => {
            const effects = CONDITION_EFFECTS[c.type];
            return effects?.canTakeReactions === false;
        });
    }

    /**
     * Validate Action Economy rules
     * Handles: Action/Bonus Action availability and "Bonus Action Spell" rule
     */
    validateActionEconomy(
        participantId: string, 
        actionType: 'action' | 'bonus' | 'reaction',
        spellLevel?: number
    ): { valid: boolean; error?: string } {
        if (!this.state) return { valid: false, error: 'No active combat' };

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return { valid: false, error: 'Participant not found' };

        // 1. Check strict incapacitation
        if (!this.canTakeActions(participantId)) {
            return { valid: false, error: 'Participant is incapacitated' };
        }
        if (participant.surprised) {
            return { valid: false, error: `${participant.name} is surprised: no action until its first turn passes` };
        }

        // 2. Check Action availability (a banked extra action reopens it)
        if (actionType === 'action') {
            if (participant.actionUsed && !((participant.extraActions ?? 0) > 0)) {
                // Play report 7 #6: off its own turn, say whose turn it is and that its own has ended.
                const offTurn = offTurnEconomyNote(this.state, participantId, 'action');
                return { valid: false, error: `Action already used this turn${offTurn ? ` — ${offTurn}` : ''}` };
            }
            
            // Bonus Action Spell Rule: If bonus spell cast, Action can only be Cantrip (level 0)
            if (spellLevel !== undefined && spellLevel > 0) {
                if (participant.spellsCast?.bonus !== undefined) {
                    return { valid: false, error: 'Cannot cast leveled spell as Action after casting Bonus Action spell (only Cantrips allowed)' };
                }
            }
        } 
        else if (actionType === 'bonus') {
            if (participant.bonusActionUsed) {
                const offTurn = offTurnEconomyNote(this.state, participantId, 'bonus');
                return { valid: false, error: `Bonus Action already used this turn${offTurn ? ` — ${offTurn}` : ''}` };
            }

            // Bonus Action Spell Rule: If casting spell as BA, no leveled Action spell allowed
            if (spellLevel !== undefined) {
                // If we already cast a leveled action spell, we cannot cast a BA spell
                if (participant.spellsCast?.action !== undefined && participant.spellsCast.action > 0) {
                     return { valid: false, error: 'Cannot cast Bonus Action spell if leveled spell was cast as Action' };
                }
            }
        }
        else if (actionType === 'reaction') {
            if (!this.canTakeReactions(participantId)) {
                return { valid: false, error: 'Cannot take reactions (incapacitated or condition)' };
            }
            if (participant.reactionUsed) {
                return { valid: false, error: 'Reaction already used this round' };
            }
        }

        return { valid: true };
    }

    /**
     * Validate one attack against the Attack action. With multiattack
     * (attacksPerAction > 1) the action stays open between swings, so the
     * second attack is valid while the first already spent the action; any
     * other use of the action (Dash, a spell) still closes it.
     */
    validateAttackEconomy(participantId: string): { valid: boolean; error?: string } {
        if (!this.state) return { valid: false, error: 'No active combat' };
        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return { valid: false, error: 'Participant not found' };
        const of = participant.attacksPerAction ?? 1;
        const made = participant.attacksMade ?? 0;
        // The open Attack action ends with its turn: off-turn, the spent
        // action (actionUsed) refuses the rest, as it would any attack.
        const ownTurn = this.state.turnOrder[this.state.currentTurnIndex] === participantId;
        if (made > 0 && made < of && ownTurn) {
            if (!this.canTakeActions(participantId)) return { valid: false, error: 'Participant is incapacitated' };
            return { valid: true };
        }
        const economy = this.validateActionEconomy(participantId, 'action');
        if (!economy.valid && of > 1 && made >= of) {
            const offTurn = ownTurn ? undefined : offTurnEconomyNote(this.state, participantId, 'action');
            return { valid: false, error: `Action already used this turn (attacks ${made}/${of})${offTurn ? ` — ${offTurn}` : ''}` };
        }
        return economy;
    }

    /**
     * Count one attack of the Attack action (the action is spent from the
     * first; a banked extra action opens a fresh one once the count is full).
     */
    commitAttack(participantId: string): { made: number; of: number } | undefined {
        const participant = this.state?.participants.find(p => p.id === participantId);
        if (!participant) return undefined;
        this.takeAction(participant, 'attack');
        return { made: participant.attacksMade ?? 0, of: participant.attacksPerAction ?? 1 };
    }

    /**
     * Commit an action to the economy tracking
     */
    commitAction(
        participantId: string, 
        actionType: 'action' | 'bonus' | 'reaction', 
        spellLevel?: number
    ): void {
        if (!this.state) return;
        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return;

        if (!participant.spellsCast) participant.spellsCast = {};

        if (actionType === 'action') {
            this.takeAction(participant, 'other');
            if (spellLevel !== undefined) participant.spellsCast.action = spellLevel;
        } else if (actionType === 'bonus') {
            participant.bonusActionUsed = true;
            if (spellLevel !== undefined) participant.spellsCast.bonus = spellLevel;
        } else if (actionType === 'reaction') {
            participant.reactionUsed = true;
            if (spellLevel !== undefined) participant.spellsCast.reaction = spellLevel;
        }
    }

    /**
     * HIGH-003: Check if two positions are adjacent (within 1 tile - 8-directional)
     */
    isAdjacent(pos1: { x: number; y: number }, pos2: { x: number; y: number }): boolean {
        const dx = Math.abs(pos1.x - pos2.x);
        const dy = Math.abs(pos1.y - pos2.y);
        return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
    }

    /**
     * Item 6: is the target (optionally standing at `targetAt`) within the
     * attacker's melee reach? Measured edge to edge between footprints, so a
     * large creature threatens from every square it fills.
     */
    isWithinReach(attacker: CombatParticipant, target: CombatParticipant, targetAt?: { x: number; y: number }, reachFt?: number): boolean {
        const squares = edgeDistanceSquares(attacker, target, { b: targetAt });
        return squares * 5 <= (reachFt ?? effectiveReachFt(attacker));
    }

    /**
     * HIGH-003 / item 11: who gets an opportunity attack on this move.
     *
     * With a path (start first, as findPath returns it) every step is checked:
     * a reactor swings at the first step i where the mover is in its reach at
     * path[i] and out of it at path[i+1], so a path that skirts an enemy
     * provokes even when both ends are clear of it. Reactors that cannot take
     * reactions (stunned, paralysed, unconscious) or already spent theirs are
     * skipped. The (from, to) form checks the two squares only and returns
     * the attackers, as it always has.
     */
    getOpportunityAttackers(moverId: string, path: Array<{ x: number; y: number }>): Array<{ attacker: CombatParticipant; stepIndex: number }>;
    getOpportunityAttackers(moverId: string, fromPos: { x: number; y: number }, toPos: { x: number; y: number }): CombatParticipant[];
    getOpportunityAttackers(
        moverId: string,
        pathOrFrom: Array<{ x: number; y: number }> | { x: number; y: number },
        toPos?: { x: number; y: number }
    ): Array<{ attacker: CombatParticipant; stepIndex: number }> | CombatParticipant[] {
        if (!Array.isArray(pathOrFrom)) {
            return this.getOpportunityAttackers(moverId, [pathOrFrom, toPos!]).map(h => h.attacker);
        }
        const path = pathOrFrom;
        if (!this.state || path.length < 2) return [];

        const mover = this.state.participants.find(p => p.id === moverId);
        if (!mover) return [];

        // If mover has disengaged, no opportunity attacks are provoked
        if (mover.hasDisengaged) return [];

        const attackers: Array<{ attacker: CombatParticipant; stepIndex: number }> = [];
        // Play report 7 #10 (review): a mount carries its rider, so a reactor
        // hostile to either is provoked: an enemy rider on a mount left without
        // isEnemy still draws the swing (the move handler picks which it strikes).
        const carried = mover.riderId ? this.state.participants.find(p => p.id === mover.riderId && p.mountedOn === mover.id) : undefined;

        for (const p of this.state.participants) {
            // Skip self, the defeated, allies, spent reactions and unplaced tokens
            if (p.id === moverId) continue;
            // Play report 7 #10: a rider never strikes its own mount (or the mount its rider).
            if (p.id === mover.riderId || p.id === mover.mountedOn) continue;
            if (p.hp <= 0) continue;
            if (!!p.isEnemy === !!mover.isEnemy && !(carried && !!p.isEnemy !== !!carried.isEnemy)) continue;
            if (p.reactionUsed) continue;
            if (!p.position) continue;
            // Stunned, paralysed, unconscious and the like cannot react.
            if (!this.canTakeReactions(p.id)) continue;

            // Leaving the reactor's reach (size and reach aware) provokes.
            const step = this.firstReachChange(p, mover, path, 'leaves_reach');
            if (step !== undefined) attackers.push({ attacker: p, stepIndex: step });
        }

        return attackers.sort((a, b) => a.stepIndex - b.stepIndex);
    }

    /**
     * The first step of a path where the mover enters or leaves a reactor's
     * reach. Leaving counts at the square it leaves from (path[i]); entering
     * at the square it enters (path[i+1]).
     */
    private firstReachChange(
        reactor: CombatParticipant, mover: CombatParticipant,
        path: Array<{ x: number; y: number }>, on: 'enters_reach' | 'leaves_reach', reachFt?: number
    ): number | undefined {
        for (let i = 0; i + 1 < path.length; i++) {
            const was = this.isWithinReach(reactor, mover, path[i], reachFt);
            const now = this.isWithinReach(reactor, mover, path[i + 1], reachFt);
            if (on === 'leaves_reach' && was && !now) return i;
            if (on === 'enters_reach' && !was && now) return i + 1;
        }
        return undefined;
    }

    /**
     * Item 11: readied actions this move sets off. A readied action with
     * `on` (enters_reach / leaves_reach) fires when its watched creature
     * (a participant id or name, 'enemy' by default, or 'any') crosses the
     * reactor's reach, measured with the readied attack's profile reach
     * when it names one. Reactors that cannot react are skipped.
     */
    getReadiedTriggers(moverId: string, path: Array<{ x: number; y: number }>, opts: { watched?: string } = {}): Array<{ reactor: CombatParticipant; stepIndex: number; readied: Readied }> {
        if (!this.state || path.length < 2) return [];
        const mover = this.state.participants.find(p => p.id === moverId);
        if (!mover) return [];
        // Play report 7 #10: a rider carried by its mount is watched for (its
        // id, name, side) while the reach is measured to the mount's footprint,
        // the space the rider shares.
        const who = (opts.watched ? this.state.participants.find(p => p.id === opts.watched) : undefined) ?? mover;
        const hits: Array<{ reactor: CombatParticipant; stepIndex: number; readied: Readied }> = [];
        for (const p of this.state.participants) {
            const readied = p.readied;
            if (!readied?.on || p.id === moverId || p.id === who.id || !p.position) continue;
            // Play report 7 #10: the linked partner moves with the mover; it never sets off its own readied action.
            if (p.id === mover.riderId || p.id === mover.mountedOn) continue;
            if (p.reactionUsed || !this.canTakeReactions(p.id)) continue;
            const watch = (readied.watch ?? 'enemy').trim().toLowerCase();
            const watched = watch === 'any'
                || (watch === 'enemy' && !!p.isEnemy !== !!who.isEnemy)
                || watch === who.id.toLowerCase() || watch === who.name.toLowerCase();
            if (!watched) continue;
            const profile = readied.attack?.using && p.attacks?.length ? matchProfile(p.attacks, readied.attack.using) : undefined;
            const step = this.firstReachChange(p, mover, path, readied.on, profile?.reachFt ?? undefined);
            if (step !== undefined) hits.push({ reactor: p, stepIndex: step, readied });
        }
        return hits.sort((a, b) => a.stepIndex - b.stepIndex);
    }

    /**
     * HIGH-003: Execute an opportunity attack with the attacker's default
     * attack against the target's AC. It rolls like any attack: standard
     * conditions on both sides (a prone mover within 5 ft is hit with
     * advantage, a paralysed one takes a crit), Dodge, Help and the one-model
     * cap on units. Spends the attacker's reaction.
     */
    executeOpportunityAttack(
        attackerId: string,
        targetId: string,
        // Play report 7 #7 (lane F): the attacker's declared advantage per lane
        // (untagged mechanics only: an opportunity attack carries no context).
        opts: { declared?: Partial<Record<'melee' | 'ranged', DeclaredSides>> } = {}
    ): CombatActionResult {
        if (!this.state) throw new Error('No active combat');

        const attacker = this.state.participants.find(p => p.id === attackerId);
        const target = this.state.participants.find(p => p.id === targetId);

        if (!attacker) throw new Error(`Attacker ${attackerId} not found`);
        if (!target) throw new Error(`Target ${targetId} not found`);

        // The attacker's own default attack (or its default profile) and the
        // target's AC, falling back to ability scores, then to the old
        // heuristics for bare tokens.
        const mod = (score?: number) => Math.floor(((score ?? 10) - 10) / 2);
        const profile = attacker.attackBonus === undefined
            ? attacker.attacks?.find(a => a.default) ?? (attacker.attacks?.length === 1 ? attacker.attacks[0] : undefined)
            : undefined;
        const attackBonus = attacker.attackBonus ?? profile?.attackBonus
            ?? (attacker.abilityScores
                ? Math.max(mod(attacker.abilityScores.strength), mod(attacker.abilityScores.dexterity)) + 2
                : attacker.initiativeBonus + 2);
        const damage = profile && attacker.attackDamage === undefined ? profile.damage : attacker.attackDamage ?? '1d6+2';
        const damageType = profile && attacker.attackDamage === undefined ? profile.damageType : attacker.attackDamageType;
        const targetAC = target.ac
            ?? (target.abilityScores ? 10 + mod(target.abilityScores.dexterity)
                : 10 + (target.initiativeBonus > 0 ? Math.floor(target.initiativeBonus / 2) : 0));

        // Play report 7 #5: under a standing subdue order the swing is
        // non-lethal (a mover it drops is knocked out); a unit is a formation,
        // not one body, so the order does not apply to it and the swing says so.
        const subdue: CombatActionResult['subdue'] = attacker.subdue
            ? (target.unit ? { mode: 'n/a: unit', note: `subdue: n/a against a unit (${target.name} is a formation; the swing is lethal)` } : { mode: 'non-lethal', note: 'subdue order: non-lethal (take them alive)' })
            : undefined;

        // Play report 7 #7 (lane F review): an opportunity attack is melee (5e),
        // so it reads the melee side whatever lane the grid gives the swing (a
        // 10-ft token reach with a 5-ft default profile would read as a shot).
        const declared = opts.declared?.melee ? { melee: opts.declared.melee, ranged: opts.declared.melee } : undefined;
        const result = this.executeAttack(attackerId, targetId, attackBonus, targetAC, damage, damageType,
            false, false, undefined, undefined, undefined, undefined, { opportunity: true, twoHanded: profile?.twoHanded, reachFt: profile?.reachFt, ...(subdue?.mode === 'non-lethal' ? { nonlethal: true } : {}), ...(declared ? { declared } : {}) });

        // Mark reaction as used
        attacker.reactionUsed = true;

        if (subdue) {
            result.subdue = subdue;
            result.situational = [...(result.situational ?? []), subdue.note];
        }
        result.detailedBreakdown = `⚡ OPPORTUNITY ATTACK by ${attacker.name}!${subdue ? ` (${subdue.note})` : ''}\n${result.detailedBreakdown}`;
        result.message = result.success
            ? `OPPORTUNITY ATTACK HIT! ${attacker.name} strikes ${target.name} for ${result.damage} damage${result.knockedOut ? ' [KNOCKED OUT]' : result.defeated ? ' [DEFEATED]' : ''}`
            : `OPPORTUNITY ATTACK MISS! ${attacker.name}'s attack misses ${target.name}`;
        return result;
    }

    /**
     * HIGH-003: Mark a participant as having taken the disengage action
     */
    disengage(participantId: string): void {
        if (!this.state) return;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (participant) {
            participant.hasDisengaged = true;
        }
    }

    /**
     * Check if attacks against a participant have advantage
     */
    attacksAgainstHaveAdvantage(participantId: string): boolean {
        if (!this.state) return false;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return false;

        return participant.conditions.some(c => {
            const effects = CONDITION_EFFECTS[c.type];
            return effects?.attacksAgainstAdvantage === true;
        });
    }

    /**
     * Check if a participant's attacks have disadvantage
     */
    attacksHaveDisadvantage(participantId: string): boolean {
        if (!this.state) return false;

        const participant = this.state.participants.find(p => p.id === participantId);
        if (!participant) return false;

        return participant.conditions.some(c => {
            const effects = CONDITION_EFFECTS[c.type];
            return effects?.attackDisadvantage === true;
        });
    }
}
