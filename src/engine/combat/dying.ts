/**
 * Play report 5, item 5: dying.
 *
 * Who tracks death saves, what a save's outcome does to the counters, what
 * damage at 0 HP costs, and the labels the token line, the state view and
 * the status block print. Pure: no database, no dice. The engine rolls the
 * die and calls applyDeathSaveOutcome; the handlers write the sheet.
 *
 * The rule, as the owner stated it: any participant with a character row
 * (pc, npc) tracks death saves unless its combat_profile.deathSaves says
 * otherwise; quick spawns, bestiary mooks and unit models just die at 0 HP.
 * A nonlethal knockout sets isStabilized, so a stable token is never dying
 * until a lethal hit lands on it (damage at 0 makes a stable creature dying).
 */
import { z } from 'zod';
import type { CombatParticipant } from './engine.js';
import type { Condition, ConditionType, DurationType } from './conditions.js';

export const DEATH_SAVE_MODES = ['auto', 'prompt'] as const;
export type DeathSaveMode = typeof DEATH_SAVE_MODES[number];
/** A fresh enum each call, so no outer schema holds one zod instance twice. */
export function deathSaveModeSchema() {
    return z.enum(DEATH_SAVE_MODES);
}

export const DEATH_SAVE_OUTCOMES = ['success', 'failure', 'nat20', 'nat1'] as const;
export type DeathSaveOutcome = typeof DEATH_SAVE_OUTCOMES[number];
export function deathSaveOutcomeSchema() {
    return z.enum(DEATH_SAVE_OUTCOMES);
}

/** The condition source the engine writes on the Unconscious and Prone a drop to 0 HP applies. */
export const DYING_SOURCE = 'dying';

/** The sheet-side marker a stabilisation outside a fight leaves (source 'stabilized by <who>'). */
export const STABLE_CONDITION = 'Stable';

/** The fields of a participant the dying rules read and write. */
export type DyingParticipant = Pick<CombatParticipant, 'id' | 'name' | 'hp' | 'maxHp' | 'conditions'> & {
    deathSaves?: boolean;
    deathSaveMode?: DeathSaveMode;
    deathSaveSuccesses?: number;
    deathSaveFailures?: number;
    deathSaveRound?: number;
    deathSaveDue?: boolean;
    /** A save rolled or posted by hand since this slot last came up: it is the next slot's save (no second roll). */
    deathSaveTaken?: boolean;
    isStabilized?: boolean;
    isDead?: boolean;
    unit?: unknown;
};

export interface DeathSaveResult {
    roll?: number;
    /** Set when the result was posted by the GM instead of rolled. */
    posted?: DeathSaveOutcome;
    isNat20: boolean;
    isNat1: boolean;
    success: boolean;
    successes: number;
    failures: number;
    isStabilized: boolean;
    isDead: boolean;
    regainedHp: boolean;
}

/** What damage did to a tracked token at or into 0 HP (the engine's `dying` result field). */
export interface DyingUpdate {
    /** This blow took the token from above 0 to 0. */
    dropped?: boolean;
    /** Failed death saves this blow added (a hit while down). */
    failuresAdded?: number;
    /** The leftover past 0 reached max HP: dead outright. */
    instantDeath?: boolean;
    successes: number;
    failures: number;
    stable: boolean;
    dead: boolean;
    /** Conditions the drop applied (unconscious, prone). */
    conditionsApplied?: string[];
}

/** A flagged token that is not a unit tracks death saves. */
export function tracksDeathSaves(p: Pick<DyingParticipant, 'deathSaves' | 'unit'>): boolean {
    return p.deathSaves === true && !p.unit;
}

/** At 0 HP, tracked, neither dead nor stable. */
export function isDying(p: DyingParticipant): boolean {
    return p.hp <= 0 && tracksDeathSaves(p) && !p.isDead && !p.isStabilized;
}

/** dead > stable > dying; undefined for a mook that is merely at 0 (or anyone above 0). */
export function dyingStatus(p: DyingParticipant): 'dying' | 'stable' | 'dead' | undefined {
    if (p.isDead) return 'dead';
    if (p.hp > 0) return undefined;
    if (p.isStabilized) return 'stable';
    if (tracksDeathSaves(p)) return 'dying';
    return undefined;
}

export function counters(p: DyingParticipant): { successes: number; failures: number } {
    return { successes: Math.max(0, Math.min(3, p.deathSaveSuccesses ?? 0)), failures: Math.max(0, Math.min(3, p.deathSaveFailures ?? 0)) };
}

/** 'DYING ✓1 ✗2' | 'STABLE' | 'DEAD', or undefined when the dying rules do not apply. */
export function dyingLabel(p: DyingParticipant): string | undefined {
    const status = dyingStatus(p);
    if (!status) return undefined;
    if (status === 'dead') return 'DEAD';
    if (status === 'stable') return 'STABLE';
    const c = counters(p);
    return `DYING ✓${c.successes} ✗${c.failures}`;
}

/** The exact call the DEATH SAVE DUE line offers. */
export function deathSaveCall(encounterId: string, participantId: string): string {
    return `combat_manage death_save {encounterId: '${encounterId}', participantId: '${participantId}'}`;
}

/** The outcome a natural d20 lands. */
export function outcomeOfRoll(roll: number): DeathSaveOutcome {
    if (roll === 20) return 'nat20';
    if (roll === 1) return 'nat1';
    return roll >= 10 ? 'success' : 'failure';
}

/**
 * A posted outcome in any of the spellings the table uses: 'success' |
 * 'failure' | 'nat20' | 'nat1', 'pass' | 'fail', 'natural 20' | 'nat_1',
 * or the natural die itself (1..20). Anything else is undefined.
 */
export function normalizeDeathSaveOutcome(v: unknown): DeathSaveOutcome | undefined {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 20) return outcomeOfRoll(v);
    if (typeof v !== 'string') return undefined;
    const s = v.trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (s === 'success' || s === 'pass' || s === 'passed' || s === 'succeeded') return 'success';
    if (s === 'failure' || s === 'fail' || s === 'failed') return 'failure';
    if (s === 'nat20' || s === 'natural20' || s === 'crit' || s === 'criticalsuccess') return 'nat20';
    if (s === 'nat1' || s === 'natural1' || s === 'criticalfailure' || s === 'fumble') return 'nat1';
    if (/^\d{1,2}$/.test(s)) return normalizeDeathSaveOutcome(Number(s));
    return undefined;
}

/**
 * Apply one death save to the counters: 10+ a success, 9- a failure, a
 * natural 1 two failures, a natural 20 back to 1 HP with both counters
 * cleared. Three successes stabilise (unconscious, no more saves); three
 * failures kill. The due flag clears: the save for this turn is made.
 */
export function applyDeathSaveOutcome(p: DyingParticipant, outcome: DeathSaveOutcome, roll?: number, round?: number): DeathSaveResult {
    p.deathSaveSuccesses = p.deathSaveSuccesses ?? 0;
    p.deathSaveFailures = p.deathSaveFailures ?? 0;
    const isNat20 = outcome === 'nat20';
    const isNat1 = outcome === 'nat1';
    const success = outcome === 'success' || isNat20;
    if (isNat20) {
        p.hp = Math.max(p.hp, 1);
        p.deathSaveSuccesses = 0;
        p.deathSaveFailures = 0;
        p.isStabilized = false;
        wakeFromDying(p);
    } else if (isNat1) {
        p.deathSaveFailures = Math.min(3, p.deathSaveFailures + 2);
    } else if (success) {
        p.deathSaveSuccesses = Math.min(3, p.deathSaveSuccesses + 1);
    } else {
        p.deathSaveFailures = Math.min(3, p.deathSaveFailures + 1);
    }
    if (p.deathSaveSuccesses >= 3) p.isStabilized = true;
    if (p.deathSaveFailures >= 3) p.isDead = true;
    p.deathSaveDue = false;
    if (round !== undefined) p.deathSaveRound = round;
    return {
        ...(roll !== undefined ? { roll } : {}),
        isNat20, isNat1, success,
        successes: p.deathSaveSuccesses,
        failures: p.deathSaveFailures,
        isStabilized: p.isStabilized ?? false,
        isDead: p.isDead ?? false,
        regainedHp: isNat20
    };
}

/** The two conditions a drop to 0 HP puts on a tracked token (same instance-id scheme as CombatEngine.applyCondition). */
export function dyingConditions(participantId: string): Condition[] {
    return (['unconscious', 'prone'] as ConditionType[]).map(type => ({
        id: `${participantId}-${type}-${Date.now()}-${Math.random()}`,
        type,
        durationType: 'permanent' as DurationType,
        sourceId: DYING_SOURCE
    }));
}

/** Add Unconscious + Prone (source dying) where missing; returns the names added. */
export function applyDyingConditions(p: DyingParticipant): string[] {
    const added: string[] = [];
    for (const c of dyingConditions(p.id)) {
        if (p.conditions.some(x => x.type === c.type)) continue;
        p.conditions.push(c);
        added.push(c.type);
    }
    return added;
}

/**
 * Consciousness returns: the dying Unconscious comes off (prone stays, as
 * 5e leaves you lying there: standing up costs half your movement), the
 * counters clear, the stable flag and the due flag with them.
 */
export function wakeFromDying(p: DyingParticipant): void {
    p.conditions = p.conditions.filter(c => !(String(c.type) === 'unconscious' && c.sourceId === DYING_SOURCE));
    p.deathSaveSuccesses = 0;
    p.deathSaveFailures = 0;
    p.isStabilized = false;
    p.deathSaveDue = false;
    p.deathSaveTaken = false;
}

/** Stable: unconscious, no more saves, counters fresh (they start again if damage makes it dying). */
export function markStable(p: DyingParticipant): void {
    p.isStabilized = true;
    p.deathSaveSuccesses = 0;
    p.deathSaveFailures = 0;
    p.deathSaveDue = false;
    p.deathSaveTaken = false;
}

/**
 * What one blow of `damage` did to a tracked token, given the HP before it.
 * Only tracked tokens are touched; the engine calls this after HP changed.
 *  - dropped to 0: Unconscious + Prone (source dying) go on;
 *  - massive damage (leftover past 0 ≥ max HP, the dropping blow included): dead;
 *  - a hit while at 0: one failure, two on a crit or a melee hit within 5 ft
 *    (the unconscious are auto-crit anyway; a posted hit from 5 ft counts the same);
 *    a stable token becomes dying again.
 */
export function damageAtZero(p: DyingParticipant, hpBefore: number, damage: number, opts: { crit?: boolean; melee?: boolean } = {}): DyingUpdate | undefined {
    if (!tracksDeathSaves(p) || p.isDead || damage <= 0 || p.hp > 0) return undefined;
    const update: DyingUpdate = { ...counters(p), stable: !!p.isStabilized, dead: false };
    const overflow = hpBefore > 0 ? damage - hpBefore : damage;
    if (hpBefore > 0) {
        update.dropped = true;
        update.conditionsApplied = applyDyingConditions(p);
    } else {
        const failures = opts.crit || opts.melee ? 2 : 1;
        p.deathSaveFailures = Math.min(3, (p.deathSaveFailures ?? 0) + failures);
        p.isStabilized = false;
        update.failuresAdded = failures;
        update.stable = false;
    }
    if (overflow >= p.maxHp && p.maxHp > 0) {
        update.instantDeath = true;
        p.deathSaveFailures = 3;
    }
    if ((p.deathSaveFailures ?? 0) >= 3) {
        p.isDead = true;
        p.isStabilized = false;
        p.deathSaveDue = false;
    }
    update.successes = p.deathSaveSuccesses ?? 0;
    update.failures = p.deathSaveFailures ?? 0;
    update.dead = !!p.isDead;
    update.stable = !!p.isStabilized;
    return update;
}

/** The one-line tail a damage result prints for a tracked token: ' 🩸 DYING ✓0 ✗1' / ' ☠ DEAD (massive damage)'. */
export function dyingTail(p: DyingParticipant, update?: DyingUpdate): string {
    const status = dyingStatus(p);
    if (!status) return p.hp <= 0 ? ' 💀 DEFEATED' : '';
    if (status === 'dead') return ` ☠ DEAD${update?.instantDeath ? ' (massive damage)' : update?.failuresAdded ? ' (third failed death save)' : ''}`;
    if (status === 'stable') return ' 💤 STABLE';
    return ` 🩸 ${dyingLabel(p)}`;
}

// ── The sheet side (character rows, no engine) ──────────────────────────

export type RowCondition = { name: string; duration?: number; source?: string; [k: string]: unknown };

/** Unconscious + Prone, source dying, for a sheet dropped to 0 outside a fight (or mirrored from the token). */
export function dyingRowConditions(): RowCondition[] {
    return [{ name: 'Unconscious', source: DYING_SOURCE }, { name: 'Prone', source: DYING_SOURCE }];
}

/** Add the dying conditions to a sheet's list where a same-named one is not already there. */
export function withDyingRowConditions(conditions: RowCondition[] | undefined): { conditions: RowCondition[]; added: string[] } {
    const list = [...(conditions ?? [])];
    const added: string[] = [];
    for (const c of dyingRowConditions()) {
        if (list.some(x => x.name.toLowerCase() === c.name.toLowerCase())) continue;
        list.push(c);
        added.push(c.name);
    }
    return { conditions: list, added };
}

/** A sheet condition the dying rules own: sourced 'dying', or the Stable marker. */
export function isDyingRowCondition(c: RowCondition): boolean {
    const src = String(c.source ?? '').toLowerCase();
    return src === DYING_SOURCE || src.startsWith('stabilized') || src.startsWith('stabilised') || c.name.toLowerCase() === STABLE_CONDITION.toLowerCase();
}

/** Strip the dying rules' conditions from a sheet (healing above 0, a long rest). */
export function stripDyingRowConditions(conditions: RowCondition[] | undefined): { conditions: RowCondition[]; removed: string[] } {
    const kept: RowCondition[] = [];
    const removed: string[] = [];
    for (const c of conditions ?? []) {
        if (isDyingRowCondition(c)) removed.push(c.name);
        else kept.push(c);
    }
    return { conditions: kept, removed };
}

/** The default from the row: pc and npc rows track; enemy and neutral do not; combat_profile.deathSaves overrides. */
export function rowTracksDeathSaves(row: { characterType?: string | null; deathSaves?: boolean | null } | null | undefined): boolean | undefined {
    if (!row) return undefined;
    if (typeof row.deathSaves === 'boolean') return row.deathSaves;
    return ['pc', 'npc'].includes(row.characterType ?? 'pc');
}
