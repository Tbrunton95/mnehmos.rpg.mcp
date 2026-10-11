/**
 * Item 16 (play report 2): Battle Master manoeuvres, pure. The table of
 * what each one does, the refusals that come before any die is rolled, the
 * save DC, and when a Menacing fright ends. The handler spends the pool and
 * applies the effects; the engine rolls the die into the attack or the
 * damage (executeAttack partOpts extraDamageDice / attackBonusDie).
 */
import { findPool } from '../table-rules.js';
import type { SizeCategory } from '../../schema/token-extras.js';

export const MANEUVER_NAMES = ['trip', 'precision', 'riposte', 'menacing', 'disarming'] as const;
export type ManeuverName = typeof MANEUVER_NAMES[number];

export const SUPERIORITY_DICE = ['1d6', '1d8', '1d10', '1d12'] as const;
export type SuperiorityDie = typeof SUPERIORITY_DICE[number];

/** The pool keys a GM writes for superiority dice; the first is the one the hints name. */
export const SUPERIORITY_POOL_KEYS = ['superiority', 'superiority_dice', 'superiority dice', 'superiority-dice'] as const;

export interface ManeuverDef {
    label: string;
    /** The save the target makes on a hit. */
    save?: 'strength' | 'wisdom';
    /** What a failed save does. */
    effect?: 'prone' | 'frightened' | 'disarm';
    /** Where the superiority die lands. */
    dieTo: 'attack' | 'damage';
    /** Spent when the attack hits, or when the die was rolled at all (precision). */
    spendOn: 'hit' | 'use';
    /** A reaction against a creature that missed you in melee this round. */
    reaction?: boolean;
    meleeOnly?: boolean;
    /** Targets above this size shrug the effect (the die still lands). */
    maxTargetSize?: SizeCategory;
}

export const MANEUVERS: Record<ManeuverName, ManeuverDef> = {
    trip: { label: 'Trip Attack', save: 'strength', effect: 'prone', dieTo: 'damage', spendOn: 'hit', maxTargetSize: 'large' },
    precision: { label: 'Precision Attack', dieTo: 'attack', spendOn: 'use' },
    riposte: { label: 'Riposte', dieTo: 'damage', spendOn: 'hit', reaction: true, meleeOnly: true },
    menacing: { label: 'Menacing Attack', save: 'wisdom', effect: 'frightened', dieTo: 'damage', spendOn: 'hit' },
    disarming: { label: 'Disarming Attack', save: 'strength', effect: 'disarm', dieTo: 'damage', spendOn: 'hit' }
};

/** The superiority pool under any of its names. */
export function findSuperiorityPool<P>(pools: Record<string, P> | undefined | null): { key: string; pool: P } | undefined {
    for (const key of SUPERIORITY_POOL_KEYS) {
        const found = findPool(pools, key);
        if (found) return found;
    }
    return undefined;
}

/** 8 + proficiency + the manoeuvre ability's modifier. */
export function maneuverSaveDC(profBonus: number, abilityMod: number): number {
    return 8 + profBonus + abilityMod;
}

/** The STR or DEX modifier the manoeuvres use: the sheet's choice, else the higher. */
export function maneuverAbilityMod(stats: { str?: number; dex?: number } | undefined, maneuverAbility?: 'str' | 'dex'): number {
    const mod = (score?: number) => Math.floor(((score ?? 10) - 10) / 2);
    if (maneuverAbility === 'str') return mod(stats?.str);
    if (maneuverAbility === 'dex') return mod(stats?.dex);
    return Math.max(mod(stats?.str), mod(stats?.dex));
}

/** The most one die of this notation can add ('1d8' → 8). */
export function dieMax(notation: string): number {
    const m = notation.trim().toLowerCase().match(/^(\d*)d(\d+)$/);
    if (!m) return 0;
    return (m[1] === '' ? 1 : parseInt(m[1], 10)) * parseInt(m[2], 10);
}

export interface MeleeMiss { attackerId: string; round: number }

export interface ManeuverContext {
    outcome?: string;
    volley?: boolean;
    cleave?: boolean;
    /** The actor's sheet, or null when the token has none. */
    sheet?: { superiorityDie?: string } | null;
    /** The superiority pool as found on the sheet. */
    pool?: { current: number };
    reaction?: boolean;
    ranged?: boolean;
    /** Melee misses recorded on the actor's token (riposte). */
    lastMeleeMisses?: MeleeMiss[];
    round?: number;
    actorName: string;
    targetId: string;
    targetName: string;
}

/**
 * Why this manoeuvre cannot be used, or undefined when it can. Checked
 * before anything is rolled or written, in the order a GM would ask.
 */
export function maneuverProblem(name: ManeuverName, ctx: ManeuverContext): string | undefined {
    const def = MANEUVERS[name];
    if (ctx.outcome) return `A manoeuvre rides the engine's roll: drop outcome '${ctx.outcome}' (the GM-posted lane takes no superiority die)`;
    if (ctx.volley) return 'A manoeuvre is one swing at one creature, not a volley';
    if (ctx.cleave) return 'A manoeuvre is one swing at one creature, not a cleave';
    if (!ctx.sheet) return `${ctx.actorName} has no character sheet: superiority dice live on the sheet (superiorityDie and the superiority pool)`;
    if (!ctx.sheet.superiorityDie) return `${ctx.actorName} has no superiorityDie: character_manage update {superiorityDie: '1d8'} (1d6 | 1d8 | 1d10 | 1d12)`;
    if (!ctx.pool) return `${ctx.actorName} has no superiority pool: character_manage adjust_pool {pool: 'superiority', value: 4, max: 4, refresh: 'short'}`;
    if (ctx.pool.current <= 0) return `${ctx.actorName} has no superiority dice left (0 in the pool); a short rest refills them`;
    if (def.reaction) {
        if (!ctx.reaction) return `${def.label} is a reaction: pass reaction: true (it spends the reaction, not the action)`;
        if (def.meleeOnly && ctx.ranged) return `${def.label} is a melee attack; this one is ranged`;
        const missed = (ctx.lastMeleeMisses ?? []).some(m => m.attackerId === ctx.targetId && (ctx.round === undefined || m.round === ctx.round));
        if (!missed) return `${ctx.targetName} has not missed ${ctx.actorName} in melee this round: ${def.label} answers a melee miss against you`;
    }
    return undefined;
}

/**
 * Menacing's fright lasts until the end of the attacker's next turn. On the
 * attacker's own turn (its slot at or before the current one) that is next
 * round; before its slot this round, it is this round.
 */
export function menacingUntil(state: { round: number; turnOrder: string[]; currentTurnIndex: number }, actorId: string): number {
    const idx = state.turnOrder.indexOf(actorId);
    return idx === -1 || idx <= state.currentTurnIndex ? state.round + 1 : state.round;
}
