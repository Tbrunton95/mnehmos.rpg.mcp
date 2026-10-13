/**
 * Non-lethal knockouts (play report 5, item 4).
 *
 * A non-lethal blow that drops a creature to 0 HP leaves it Unconscious and
 * stable: the Unconscious condition is sourced 'nonlethal: <actor id>', and
 * that source is the one key every wake-up lane reads — the engine's heal,
 * the heal action, a posted adjust_hp — so a sleep spell's Unconscious on
 * the same creature is never touched by a cure.
 */
import { ConditionType } from './conditions.js';
import type { CombatParticipant } from './engine.js';

type ConditionLike = { type: string; sourceId?: string };

export const NONLETHAL_PREFIX = 'nonlethal: ';

/** The condition source a knockout writes: 'nonlethal: <actor id>'. */
export function nonlethalSource(actorId: string): string {
    return `${NONLETHAL_PREFIX}${actorId}`;
}

/** Whether a token condition is the knockout's Unconscious. */
export function isNonlethalUnconscious(c: ConditionLike): boolean {
    return String(c.type ?? '').toLowerCase() === ConditionType.UNCONSCIOUS && String(c.sourceId ?? '').startsWith(NONLETHAL_PREFIX);
}

/** Whether a sheet condition ({name, source}) is the knockout's Unconscious. */
export function isNonlethalRowCondition(c: { name: string; source?: string }): boolean {
    return c.name.trim().toLowerCase() === ConditionType.UNCONSCIOUS && String(c.source ?? '').startsWith(NONLETHAL_PREFIX);
}

/**
 * Strip the knockout's Unconscious from a sheet's conditions, leaving every
 * other entry (a sleep spell's Unconscious, Prone). `removed` lists the
 * display names that left, empty when the sheet carried none. Pure: the
 * caller writes the row (rest_manage, character_manage update, the handlers).
 */
export function stripNonlethalRowConditions<T extends { name: string; source?: string }>(conditions: T[] | undefined | null): { conditions: T[]; removed: string[] } {
    const list = conditions ?? [];
    const gone = list.filter(isNonlethalRowCondition);
    if (!gone.length) return { conditions: list, removed: [] };
    return { conditions: list.filter(c => !isNonlethalRowCondition(c)), removed: [...new Set(gone.map(c => c.name.trim()))] };
}

/**
 * The out-of-fight wake: a sheet lifted from 0 (or below) to above 0 by a
 * rest or an hp correction loses the knockout's Unconscious. Undefined when
 * nothing rose or nothing was knocked out, so the caller writes no condition.
 */
export function wakeRowFromKnockout<T extends { name: string; source?: string }>(hpBefore: number, hpAfter: number, conditions: T[] | undefined | null): { conditions: T[]; removed: string[] } | undefined {
    if (!(hpBefore <= 0 && hpAfter > 0)) return undefined;
    const stripped = stripNonlethalRowConditions(conditions);
    return stripped.removed.length ? stripped : undefined;
}

/** Down, stable and Unconscious from a non-lethal blow: knocked out, not dying and not dead. */
export function isKnockedOut(p: Pick<CombatParticipant, 'hp' | 'isStabilized' | 'conditions'>): boolean {
    return p.hp <= 0 && !!p.isStabilized && (p.conditions ?? []).some(isNonlethalUnconscious);
}

/** Remove the knockout's Unconscious from a token; returns the condition types removed (lower-case). */
export function clearNonlethalUnconscious(p: Pick<CombatParticipant, 'conditions'>): string[] {
    const gone = (p.conditions ?? []).filter(isNonlethalUnconscious);
    if (!gone.length) return [];
    p.conditions = p.conditions.filter(c => !isNonlethalUnconscious(c));
    return [...new Set(gone.map(c => String(c.type).toLowerCase()))];
}
