/**
 * Status Condition Types
 * Based on D&D 5e with extensions for other systems
 */
export enum ConditionType {
    // D&D 5e Core Conditions
    BLINDED = 'blinded',
    CHARMED = 'charmed',
    DEAFENED = 'deafened',
    FRIGHTENED = 'frightened',
    GRAPPLED = 'grappled',
    INCAPACITATED = 'incapacitated',
    INVISIBLE = 'invisible',
    PARALYZED = 'paralyzed',
    PETRIFIED = 'petrified',
    POISONED = 'poisoned',
    PRONE = 'prone',
    RESTRAINED = 'restrained',
    STUNNED = 'stunned',
    UNCONSCIOUS = 'unconscious',

    // Extended Conditions
    BLEEDING = 'bleeding',
    BURNING = 'burning',
    CONCENTRATING = 'concentrating',
    EXHAUSTED = 'exhausted',
    HASTED = 'hasted',
    SLOWED = 'slowed',
    BLESSED = 'blessed',
    CURSED = 'cursed',
    MARKED = 'marked',
    HIDDEN = 'hidden'
}

/**
 * How a condition's duration is tracked
 */
export enum DurationType {
    /** Lasts until end of target's next turn */
    END_OF_TURN = 'end_of_turn',
    /** Lasts until start of target's next turn */
    START_OF_TURN = 'start_of_turn',
    /** Lasts for a specific number of rounds */
    ROUNDS = 'rounds',
    /** Lasts until a save is made */
    SAVE_ENDS = 'save_ends',
    /** Lasts indefinitely until removed */
    PERMANENT = 'permanent',
    /** Lasts until concentration is broken */
    CONCENTRATION = 'concentration'
}

/**
 * Ability scores for saving throws
 */
export enum Ability {
    STRENGTH = 'strength',
    DEXTERITY = 'dexterity',
    CONSTITUTION = 'constitution',
    INTELLIGENCE = 'intelligence',
    WISDOM = 'wisdom',
    CHARISMA = 'charisma'
}

/**
 * Ongoing effect that occurs each turn
 */
export interface OngoingEffect {
    /** Type of effect */
    type: 'damage' | 'healing' | 'custom';
    /** Amount (for damage/healing) */
    amount?: number;
    /** Dice notation (alternative to amount) */
    dice?: string;
    /** When the effect triggers */
    trigger: 'start_of_turn' | 'end_of_turn';
}

/**
 * Complete condition data
 */
export interface Condition {
    /** Unique ID for this condition instance */
    id: string;
    /** Type of condition */
    type: ConditionType;
    /** How long the condition lasts */
    durationType: DurationType;
    /** Remaining duration (rounds or turns) */
    duration?: number;
    /** Source participant ID (who applied it) */
    sourceId?: string;
    /** Save DC (if save_ends) */
    saveDC?: number;
    /** Ability for saving throw */
    saveAbility?: Ability;
    /** Ongoing effects */
    ongoingEffects?: OngoingEffect[];
    /** Custom metadata */
    metadata?: Record<string, any>;
}

const ABILITY_ABBREVIATIONS: Record<string, Ability> = {
    str: Ability.STRENGTH,
    dex: Ability.DEXTERITY,
    con: Ability.CONSTITUTION,
    int: Ability.INTELLIGENCE,
    wis: Ability.WISDOM,
    cha: Ability.CHARISMA
};

/**
 * Resolve a caller's durationType ("SAVE_ENDS", "save ends", "end-of-turn")
 * to DurationType, or undefined when it names none.
 */
export function parseDurationType(value: string | undefined): DurationType | undefined {
    const key = (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return (Object.values(DurationType) as string[]).includes(key) ? key as DurationType : undefined;
}

/**
 * Resolve a caller's saveAbility — full name or three-letter abbreviation,
 * any case — to Ability, or undefined when it names none.
 */
export function parseAbility(value: string | undefined): Ability | undefined {
    const key = (value ?? '').trim().toLowerCase();
    if ((Object.values(Ability) as string[]).includes(key)) return key as Ability;
    return Object.hasOwn(ABILITY_ABBREVIATIONS, key) ? ABILITY_ABBREVIATIONS[key] : undefined;
}

/**
 * A condition as callers hand it to encounter create / add_participant:
 * a bare name ("prone"), a character-row entry ({name, duration?, source?}),
 * or the same object with the engine's duration/save fields
 * ({type, durationType?, sourceId?, saveDC?, saveAbility?}).
 */
export type ConditionInput = string | {
    id?: string;
    type?: string;
    name?: string;
    durationType?: string;
    duration?: number;
    source?: string;
    sourceId?: string;
    saveDC?: number;
    saveAbility?: string;
    /** Exhaustion level (1-6), stored as metadata.level */
    level?: number;
};

/**
 * Spellings callers use for the standard conditions: British 'paralysed',
 * and 'exhaustion' (base-schemas, improvisation) for the enum's 'exhausted'.
 */
export const CONDITION_ALIASES: Record<string, ConditionType> = {
    paralysed: ConditionType.PARALYZED,
    exhaustion: ConditionType.EXHAUSTED
};

/**
 * Normalize a caller-supplied condition into the engine's Condition shape.
 * Known names map case-insensitively onto ConditionType; anything else is
 * kept verbatim as a custom condition with no mechanical effect. durationType
 * and saveAbility resolve like the name does (any case; "con" for
 * constitution). With no durationType, a duration means rounds (the
 * character-row convention) and none means permanent. Returns null when
 * there is no name to go on.
 *
 * Lenient by design, for character-row data. Caller input goes through
 * ConditionInputSchema (schema/encounter.ts) first, which rejects anything
 * this would have to drop or guess at.
 */
export function normalizeCondition(input: ConditionInput, participantId: string): Condition | null {
    const raw = typeof input === 'string' ? { name: input } : input;
    const label = String(raw.type || raw.name || '').trim();
    if (!label) return null;

    const lower = label.toLowerCase();
    const type = (Object.values(ConditionType) as string[]).includes(lower)
        ? lower as ConditionType
        : Object.hasOwn(CONDITION_ALIASES, lower) ? CONDITION_ALIASES[lower] : label as ConditionType;
    const durationType = parseDurationType(raw.durationType)
        ?? (raw.duration !== undefined ? DurationType.ROUNDS : DurationType.PERMANENT);
    const sourceId = raw.sourceId ?? raw.source;
    const saveAbility = parseAbility(raw.saveAbility);

    return {
        // Same instance-id scheme as CombatEngine.applyCondition
        id: raw.id ?? `${participantId}-${type}-${Date.now()}-${Math.random()}`,
        type,
        durationType,
        ...(raw.duration !== undefined ? { duration: raw.duration } : {}),
        ...(sourceId !== undefined ? { sourceId } : {}),
        ...(raw.saveDC !== undefined ? { saveDC: raw.saveDC } : {}),
        ...(saveAbility ? { saveAbility } : {}),
        ...(raw.level !== undefined ? { metadata: { level: raw.level } } : {})
    };
}

export function normalizeConditions(inputs: ConditionInput[] | undefined, participantId: string): Condition[] {
    return (inputs ?? [])
        .map(c => normalizeCondition(c, participantId))
        .filter((c): c is Condition => c !== null);
}

/**
 * Condition effect modifiers
 * Defines mechanical effects of each condition type
 */
export const CONDITION_EFFECTS: Record<ConditionType, {
    description: string;
    attackDisadvantage?: boolean;
    /** The creature's own attacks have advantage (invisible, hidden) */
    attackAdvantage?: boolean;
    attacksAgainstAdvantage?: boolean;
    /** Attacks against the creature have disadvantage (invisible, hidden) */
    attacksAgainstDisadvantage?: boolean;
    /** Prone: attacks against have advantage within 5 ft, disadvantage beyond */
    proneRule?: boolean;
    /** A hit from within 5 ft is a critical hit (paralyzed, unconscious) */
    autoCritWithin5ft?: boolean;
    abilityCheckDisadvantage?: boolean;
    savingThrowDisadvantage?: boolean;
    speed?: number; // 0 means no movement
    autoFail?: Ability[];
    canTakeActions?: boolean;
    canTakeReactions?: boolean;
}> = {
    [ConditionType.BLINDED]: {
        description: 'Cannot see, fails checks requiring sight',
        attackDisadvantage: true,
        attacksAgainstAdvantage: true,
        autoFail: [Ability.STRENGTH, Ability.DEXTERITY] // Auto-fail checks requiring sight
    },
    [ConditionType.CHARMED]: {
        description: 'Cannot attack charmer, charmer has advantage on social checks',
        attackDisadvantage: false
    },
    [ConditionType.DEAFENED]: {
        description: 'Cannot hear, fails checks requiring hearing',
        autoFail: [] // Auto-fail hearing checks
    },
    [ConditionType.FRIGHTENED]: {
        description: 'Disadvantage on checks while source is in sight, cannot move closer',
        attackDisadvantage: true,
        abilityCheckDisadvantage: true
    },
    [ConditionType.GRAPPLED]: {
        description: 'Speed becomes 0',
        speed: 0
    },
    [ConditionType.INCAPACITATED]: {
        description: 'Cannot take actions or reactions',
        canTakeActions: false,
        canTakeReactions: false
    },
    [ConditionType.INVISIBLE]: {
        description: 'Attacks have advantage, attacks against have disadvantage',
        attackAdvantage: true,
        attacksAgainstDisadvantage: true
    },
    [ConditionType.PARALYZED]: {
        description: 'Incapacitated, auto-fail STR/DEX saves, attacks against have advantage, crits within 5ft',
        canTakeActions: false,
        canTakeReactions: false,
        speed: 0,
        autoFail: [Ability.STRENGTH, Ability.DEXTERITY],
        attacksAgainstAdvantage: true,
        autoCritWithin5ft: true
    },
    [ConditionType.PETRIFIED]: {
        description: 'Transformed to stone, incapacitated, resistance to all damage, attacks against have advantage',
        canTakeActions: false,
        canTakeReactions: false,
        speed: 0,
        autoFail: [Ability.STRENGTH, Ability.DEXTERITY],
        attacksAgainstAdvantage: true
    },
    [ConditionType.POISONED]: {
        description: 'Disadvantage on attack rolls and ability checks',
        attackDisadvantage: true,
        abilityCheckDisadvantage: true
    },
    [ConditionType.PRONE]: {
        description: 'Disadvantage on attacks, attacks against have advantage (if within 5ft)',
        attackDisadvantage: true,
        proneRule: true // Standing up costs half speed; the GM charges it
    },
    [ConditionType.RESTRAINED]: {
        description: 'Speed 0, disadvantage on attacks and DEX saves, attacks against have advantage',
        speed: 0,
        attackDisadvantage: true,
        savingThrowDisadvantage: true,
        attacksAgainstAdvantage: true
    },
    [ConditionType.STUNNED]: {
        description: 'Incapacitated, cannot move, auto-fail STR/DEX saves, attacks against have advantage',
        canTakeActions: false,
        canTakeReactions: false,
        speed: 0,
        autoFail: [Ability.STRENGTH, Ability.DEXTERITY],
        attacksAgainstAdvantage: true
    },
    [ConditionType.UNCONSCIOUS]: {
        description: 'Incapacitated, prone, auto-fail STR/DEX saves, attacks against have advantage, crits within 5ft',
        canTakeActions: false,
        canTakeReactions: false,
        speed: 0,
        autoFail: [Ability.STRENGTH, Ability.DEXTERITY],
        attacksAgainstAdvantage: true,
        autoCritWithin5ft: true
    },
    [ConditionType.BLEEDING]: {
        description: 'Takes ongoing damage at start of turn',
        attackDisadvantage: false
    },
    [ConditionType.BURNING]: {
        description: 'Takes ongoing fire damage at start of turn',
        attackDisadvantage: false
    },
    [ConditionType.CONCENTRATING]: {
        description: 'Maintaining concentration on a spell or effect',
        attackDisadvantage: false
    },
    [ConditionType.EXHAUSTED]: {
        // By level (metadata.level, default 1): see exhaustionLevel. Level 3+
        // hampers attacks and saves, 2 halves speed, 5 stops it.
        description: 'Disadvantage on checks; by level: 2 half speed, 3 disadvantage on attacks and saves, 5 speed 0',
        abilityCheckDisadvantage: true
    },
    [ConditionType.HASTED]: {
        description: 'Increased speed and extra actions',
        attackDisadvantage: false
    },
    [ConditionType.SLOWED]: {
        description: 'Reduced speed and disadvantage on DEX saves',
        savingThrowDisadvantage: true
    },
    [ConditionType.BLESSED]: {
        description: 'Bonus to attack rolls and saving throws',
        attackDisadvantage: false
    },
    [ConditionType.CURSED]: {
        description: 'Penalty to attack rolls and saving throws',
        attackDisadvantage: true
    },
    [ConditionType.MARKED]: {
        description: 'Attacks against this target have advantage',
        attacksAgainstAdvantage: true
    },
    [ConditionType.HIDDEN]: {
        description: 'Cannot be seen by enemies: attacks have advantage, attacks against have disadvantage',
        attackAdvantage: true,
        attacksAgainstDisadvantage: true
    }
};

/**
 * The 5e standard conditions whose registry mechanics fire on their own.
 * Homebrew entries (CURSED, MARKED, ...) stay descriptive: a GM's flavour tag
 * must never start changing rolls silently.
 */
export const STANDARD_CONDITIONS: ReadonlySet<ConditionType> = new Set([
    ConditionType.BLINDED, ConditionType.FRIGHTENED, ConditionType.GRAPPLED, ConditionType.INVISIBLE,
    ConditionType.HIDDEN, ConditionType.PARALYZED, ConditionType.PETRIFIED, ConditionType.POISONED,
    ConditionType.PRONE, ConditionType.RESTRAINED, ConditionType.STUNNED, ConditionType.UNCONSCIOUS,
    ConditionType.EXHAUSTED
]);

/** The effective exhaustion level: the highest over the creature's exhausted conditions (0 when none; 1 when unlevelled). */
export function exhaustionLevel(conditions: Condition[]): number {
    return conditions
        .filter(c => c.type === ConditionType.EXHAUSTED)
        .reduce((max, c) => Math.max(max, typeof c.metadata?.level === 'number' ? c.metadata.level : 1), 0);
}

/** Speed after the standard conditions: 0 when rooted, a factor otherwise. */
export function conditionSpeedFactor(conditions: Condition[]): number {
    if (conditions.some(c => STANDARD_CONDITIONS.has(c.type) && CONDITION_EFFECTS[c.type].speed === 0)) return 0;
    const level = exhaustionLevel(conditions);
    return level >= 5 ? 0 : level >= 2 ? 0.5 : 1;
}

type ConditionHolder = { id: string; name: string; hp?: number; conditions: Condition[] };

/**
 * Advantage, disadvantage and auto-crit an attack gets from the standard
 * conditions on both sides (the allow-list only). Each entry is a labelled
 * note for the situational line: 'Bloodthirster prone (disadvantage)'.
 * Frightened counts while its source is a living participant, or when it has
 * no source or one the encounter cannot name.
 */
export function conditionAttackModifiers(
    actor: ConditionHolder,
    target: ConditionHolder,
    opts: { within5ft: boolean; participants?: ConditionHolder[] }
): { adv: string[]; dis: string[]; autoCrit?: string } {
    const adv: string[] = [];
    const dis: string[] = [];
    let autoCrit: string | undefined;
    const standard = (who: ConditionHolder) => who.conditions.filter(c => STANDARD_CONDITIONS.has(c.type));
    const sourceGone = (c: Condition) => {
        if (!c.sourceId) return false;
        const key = c.sourceId.toLowerCase();
        const src = opts.participants?.find(p => p.id === c.sourceId || p.name.toLowerCase() === key);
        return src ? (src.hp ?? 1) <= 0 : false;
    };
    const seen = new Set<string>();
    const push = (list: string[], note: string) => { if (!seen.has(note)) { seen.add(note); list.push(note); } };

    for (const c of standard(actor)) {
        const fx = CONDITION_EFFECTS[c.type];
        if (c.type === ConditionType.FRIGHTENED && sourceGone(c)) continue;
        if (fx.attackDisadvantage) push(dis, `${actor.name} ${c.type} (disadvantage)`);
        if (fx.attackAdvantage) push(adv, `${actor.name} ${c.type} (advantage)`);
    }
    const level = exhaustionLevel(actor.conditions);
    if (level >= 3) push(dis, `${actor.name} exhaustion ${level} (disadvantage)`);

    for (const c of standard(target)) {
        const fx = CONDITION_EFFECTS[c.type];
        if (fx.attacksAgainstAdvantage) push(adv, `${target.name} ${c.type} (advantage)`);
        if (fx.attacksAgainstDisadvantage) push(dis, `${target.name} ${c.type} (disadvantage)`);
        if (fx.proneRule) push(opts.within5ft ? adv : dis, `${target.name} ${c.type} (${opts.within5ft ? 'advantage' : 'disadvantage'})`);
        if (fx.autoCritWithin5ft && opts.within5ft && !autoCrit) autoCrit = `${target.name} ${c.type}: a hit within 5 ft is a crit`;
    }
    return { adv, dis, ...(autoCrit ? { autoCrit } : {}) };
}
