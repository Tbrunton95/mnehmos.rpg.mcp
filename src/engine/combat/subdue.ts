/**
 * Play report 7 #5: a standing subdue order ("take them alive") on a token.
 *
 * The order shapes the swings the engine makes for the token without anyone
 * choosing at the moment: opportunity attacks (engine.executeOpportunityAttack)
 * and readied attacks (resolveReadiedAttack, from a move or trigger_readied).
 * A melee swing becomes non-lethal (the play report 5 knockout). A ranged
 * shot cannot be non-lethal (5e), so the conflict is settled when the shot is
 * readied (owner's answer): the readied attack carries onSubdue 'hold' (the
 * order wins: no shot, the reaction and the shot are kept) or 'fire' (the shot
 * wins: lethal, "subdue order overridden"). An order put on a token after it
 * readied a shot leaves onSubdue unanswered; until the GM answers, the shot
 * holds, because holding cannot kill anyone by accident and firing can.
 *
 * A unit is a formation, not one body: the order does not apply against it.
 * A subdued token does not strike a target already at 0 HP.
 */
import type { CombatParticipant } from './engine.js';
import type { ReadiedAttack } from '../../schema/token-extras.js';
import { matchProfile } from './parts.js';

export const ON_SUBDUE = ['hold', 'fire'] as const;
export type OnSubdue = typeof ON_SUBDUE[number];

/** What a subdue order does to one readied attack as it fires. */
export type ReadiedSubdue =
    | { mode: 'non-lethal' | 'n/a: unit' | 'overridden'; note: string }
    | { mode: 'hold'; note: string; awaitingOnSubdue: boolean }
    | { mode: 'downed'; note: string };

export const HELD_FIRE = "held fire: subdue order; ranged can't be non-lethal";

/**
 * The order's effect on a readied attack about to fire in `lane` (ranged or
 * melee, as resolveReadiedAttack reads it from the profile, else the grid).
 * Undefined when the reactor is under no order.
 */
export function readiedSubdueFor(
    reactor: Pick<CombatParticipant, 'name' | 'subdue'>,
    target: Pick<CombatParticipant, 'name' | 'hp' | 'unit'>,
    spec: Pick<ReadiedAttack, 'onSubdue'> | undefined,
    lane: 'ranged' | 'melee'
): ReadiedSubdue | undefined {
    if (!reactor.subdue) return undefined;
    if (target.unit) return { mode: 'n/a: unit', note: `subdue: n/a against a unit (${target.name} is a formation; the attack is lethal)` };
    if (target.hp <= 0) return { mode: 'downed', note: `subdue: ${target.name} is already down; ${reactor.name} does not strike (reaction kept)` };
    if (spec?.onSubdue === 'fire') return { mode: 'overridden', note: `subdue order overridden (onSubdue: 'fire'): ${reactor.name} shoots to kill` };
    if (lane === 'ranged') {
        return spec?.onSubdue === 'hold'
            ? { mode: 'hold', awaitingOnSubdue: false, note: HELD_FIRE }
            : { mode: 'hold', awaitingOnSubdue: true, note: `${HELD_FIRE} — onSubdue is unanswered, so the trigger holds until the GM answers (holding can't kill anyone by accident)` };
    }
    return { mode: 'non-lethal', note: 'subdue order: non-lethal (take them alive)' };
}

/** The refusal resolveReadiedAttack throws for a held shot or a downed target: nothing was spent. */
export type HeldReadiedError = Error & { writes: 'none'; held: Extract<ReadiedSubdue, { mode: 'hold' | 'downed' }> };

export function heldReadiedError(held: Extract<ReadiedSubdue, { mode: 'hold' | 'downed' }>): HeldReadiedError {
    return Object.assign(new Error(held.note), { writes: 'none' as const, held });
}

/** The held decision carried by an error resolveReadiedAttack threw, if that is what it was. */
export function heldReadied(err: unknown): HeldReadiedError['held'] | undefined {
    return (err as Partial<HeldReadiedError> | undefined)?.held;
}

/** The call that answers an unanswered onSubdue (set_subdue writes it onto the readied shot). */
export function onSubdueAnswer(encounterId: string, participantId: string) {
    return { tool: 'combat_manage', action: 'set_subdue', encounterId, participantId, onSubdue: "'hold' | 'fire'" };
}

export function onSubdueAnswerText(encounterId: string, participantId: string): string {
    return `combat_manage set_subdue {encounterId: '${encounterId}', participantId: '${participantId}', onSubdue: 'hold' | 'fire'}`;
}

/** Lane G2: a readied attack's own ranged flag disagreeing with its named profile (the flag wins). */
export type ReadiedRangedOverride = { profile: string; profileRanged: boolean | null; ranged: boolean; note: string };

/**
 * Play report 7 (lane G2): whether a readied attack is a ranged shot, read as
 * it is at ready time and at fire time: the readied attack's own `ranged`
 * flag first, then its named profile's. `ranged` undefined means neither
 * says, and the grid decides when it fires. `source` names what decided
 * ('attack.ranged: true' or the profile). `override` is set when the flag
 * disagrees with the profile: the flag wins, and the reply says so.
 */
export function readiedRanged(
    spec: Pick<ReadiedAttack, 'ranged'> | undefined,
    profile: { name: string; ranged?: boolean } | undefined
): { ranged?: boolean; source?: string; override?: ReadiedRangedOverride } {
    if (spec?.ranged !== undefined) {
        const profileSaysRanged = profile?.ranged === true;
        const override: ReadiedRangedOverride | undefined = profile && profileSaysRanged !== spec.ranged
            ? {
                profile: profile.name, profileRanged: profile.ranged ?? null, ranged: spec.ranged,
                note: `attack.ranged: ${spec.ranged} overrides the ${profile.name} profile (${profile.ranged === true ? 'ranged' : profile.ranged === false ? 'melee' : 'not marked ranged'}): this readied attack is ${spec.ranged ? 'a ranged shot' : 'a melee swing'}`
            }
            : undefined;
        return { ranged: spec.ranged, source: `attack.ranged: ${spec.ranged}`, ...(override ? { override } : {}) };
    }
    return { ranged: profile?.ranged, ...(profile ? { source: profile.name } : {}) };
}

/**
 * Lane G2: the state view's lane tag on a readied line whose attack carries
 * its own ranged flag: ' [ranged]', ' [melee]', and the profile it overrides.
 * Empty when the flag is unset (the profile, else the grid, decides).
 */
export function readiedLaneTag(p: Pick<CombatParticipant, 'readied' | 'attacks'>): string {
    const spec = p.readied?.attack;
    if (spec?.ranged === undefined) return '';
    const profile = spec.using ? matchProfile(p.attacks ?? [], spec.using) : undefined;
    const { override } = readiedRanged(spec, profile);
    return ` [${spec.ranged ? 'ranged' : 'melee'}${override ? `: overrides the ${override.profile} profile` : ''}]`;
}

/**
 * The state view's tag on a readied line under the order: ' (non-lethal)',
 * ' (hold if ranged)', the override, or an unanswered ranged shot. Reads the
 * token's own profiles only (no store), so a sheet-only profile reads as
 * melee here; the shot itself reads the sheet when it fires. Lane G2: the
 * readied attack's own ranged flag comes first.
 */
export function readiedSubdueTag(p: Pick<CombatParticipant, 'subdue' | 'readied' | 'attacks'>): string {
    const spec = p.readied?.attack;
    if (!p.subdue || !spec) return '';
    if (spec.onSubdue === 'fire') return ' (subdue order overridden: fires to kill)';
    const profile = spec.using ? matchProfile(p.attacks ?? [], spec.using) : undefined;
    const ranged = readiedRanged(spec, profile).ranged === true;
    if (spec.onSubdue === 'hold') return ranged ? ' (hold if ranged)' : ' (non-lethal; hold if ranged)';
    return ranged ? ' (holds fire: subdue order, onSubdue unanswered)' : ' (non-lethal)';
}

