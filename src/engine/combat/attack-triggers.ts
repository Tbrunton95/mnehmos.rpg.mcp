/**
 * Trigger-tied attacks (play report 5, item 3): Goring Rush needs a Dash and
 * 20 ft moved after it; a follow-up needs a melee hit on the target this
 * turn. The requirement lives on the attack profile (or the call); this
 * module judges it against the actor's per-turn counters and names exactly
 * what is missing, so the refusal reads like a rule and not a stack trace.
 *
 * Movement is read from the grid when the token has a position
 * (movedThisTurn, or movedSinceDash when a Dash is required); a token
 * without one uses the GM's declared movedFt and the reply says so.
 */
import type { CombatParticipant } from './engine.js';

export interface AttackRequires {
    dashed?: boolean;
    movedAtLeast?: number;
    hitThisTurn?: boolean;
}

export interface AttackTriggerFacts {
    dashed?: boolean;
    movedFt?: number;
    movedSource?: 'grid' | 'declared';
    /** A movedFt the call declared while the token was placed: the grid counted instead, and the reply says so. */
    declaredMovedFtIgnored?: number;
    hitThisTurn?: boolean;
}

type Mover = Pick<CombatParticipant, 'hasDashed' | 'dashes' | 'movedThisTurn' | 'movedSinceDash' | 'position' | 'meleeHitsThisTurn'>;

export function evaluateAttackTrigger(
    p: Mover,
    requires: AttackRequires,
    opts: { label: string; targetId?: string; movedFt?: number }
): { problem?: string; facts: AttackTriggerFacts } {
    const needs: string[] = [];
    const state: string[] = [];
    const facts: AttackTriggerFacts = {};
    let ok = true;

    if (requires.dashed) {
        const dashed = (p.dashes ?? 0) > 0 || !!p.hasDashed;
        needs.push('a Dash this turn');
        state.push(`dashed ${dashed ? 'yes' : 'no'}`);
        facts.dashed = dashed;
        if (!dashed) ok = false;
    }
    if (requires.movedAtLeast !== undefined) {
        const afterDash = !!requires.dashed;
        needs.push(`${requires.movedAtLeast} ft moved ${afterDash ? 'after it' : 'this turn'}`);
        let moved: number;
        if (p.position) {
            moved = afterDash ? (p.movedSinceDash ?? 0) : (p.movedThisTurn ?? 0);
            facts.movedSource = 'grid';
            // A declared figure is never trusted over the grid, but it is never
            // dropped silently either: a GM who placed the token by hand sees why
            // the count reads 0 and what the engine did with the number passed.
            if (opts.movedFt !== undefined) {
                facts.declaredMovedFtIgnored = opts.movedFt;
                state.push(`moved ${moved} ft (grid; movedFt ${opts.movedFt} declared is not used while the token is placed — the move action counts the feet)`);
            } else {
                state.push(`moved ${moved} ft`);
            }
        } else {
            moved = opts.movedFt ?? 0;
            facts.movedSource = 'declared';
            state.push(`moved ${moved} ft${opts.movedFt === undefined ? ' (no position: pass movedFt)' : ' (declared)'}`);
        }
        facts.movedFt = moved;
        if (moved < requires.movedAtLeast) ok = false;
    }
    if (requires.hitThisTurn) {
        const who = opts.targetId ?? 'the target';
        needs.push(`a melee hit on ${who} this turn`);
        const hit = !!opts.targetId && (p.meleeHitsThisTurn ?? []).includes(opts.targetId);
        facts.hitThisTurn = hit;
        state.push(hit ? `hit ${who}` : `no hit on ${who}`);
        if (!hit) ok = false;
    }
    if (!needs.length || ok) return { facts };
    return { problem: `${opts.label} needs ${needs.join(' and ')}: ${state.join(', ')}`, facts };
}

/** The refusal text when the trigger is not met, else undefined. */
export function attackTriggerProblem(p: Mover, requires: AttackRequires, opts: { label: string; targetId?: string; movedFt?: number }): string | undefined {
    return evaluateAttackTrigger(p, requires, opts).problem;
}
