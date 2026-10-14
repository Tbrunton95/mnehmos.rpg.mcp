/**
 * Play report 7, lane G2: one short, complete line per reaction a call
 * resolved, for the reply's top-level `reactionLines`.
 *
 * Reactions resolve with nobody choosing at the moment: the opportunity
 * attacks and readied attacks a move sets off (a mount's move carrying its
 * rider included, and dash {targetPosition}, which runs the same move), and
 * trigger_readied. Their JSON rows (opportunityAttacks, readiedTriggered, …)
 * stay as they are, but output_mode 'summary' collapses them to id handles,
 * so what happened — a knockout, a held shot, an override, a hit, its damage,
 * a rider struck — lived only in the first 300 characters of rawText. The
 * lines carry it instead, and summary keeps them whole (SUMMARY_KEEP in
 * src/server/output-mode.ts), as unitLines does for units.
 *
 *   ⚡ Grak → Runner: OA hit 21 vs AC 12, 7 piercing, knocked out (subdue)
 *   ⏸ Grak holds fire: subdue order; ranged can't be non-lethal (reaction kept)
 *   ⏳ Grak → Runner: readied hit 25 vs AC 12, 11 piercing, killed; subdue order overridden
 *   ⚡ Kael may strike Runner (OA; the player decides): combat_action attack {…}
 */
import { HELD_FIRE } from './subdue.js';

/** The numbers a rolled reaction carries (reactionAttackData's shape). */
export type ReactionRoll = {
    roll?: number;
    total?: number;
    targetAc?: number;
    hit?: boolean;
    crit?: boolean;
    damage?: number;
    damageType?: string;
    targetHpAfter?: number;
    knockedOut?: unknown;
    subdue?: { mode: string };
};

/** Who was struck: a rider names its mount (and whether the mount could have been chosen); a mount names its rider. */
export type ReactionTarget = { name: string; riding?: string; couldStrikeMount?: boolean; carrying?: string };

function targetLabel(t: ReactionTarget): string {
    if (t.riding) return `${t.name} (riding ${t.riding}${t.couldStrikeMount ? '; could strike the mount' : ''})`;
    if (t.carrying) return `${t.name} (carrying ${t.carrying})`;
    return t.name;
}

/**
 * A rolled reaction: an opportunity attack ('OA', ⚡) or a readied attack
 * ('readied', ⏳). `killed` when the blow ran a kill (settleAttackDying).
 */
export function rolledReactionLine(kind: 'OA' | 'readied', reactor: string, target: ReactionTarget, a: ReactionRoll, opts: { killed?: boolean; override?: string } = {}): string {
    const glyph = kind === 'OA' ? '⚡' : '⏳';
    const vs = `${a.total ?? '?'} vs AC ${a.targetAc ?? '?'}`;
    // A natural 1 misses whatever the total; say so, or 'miss 41 vs AC 10' reads wrong.
    let out = `${glyph} ${reactor} → ${targetLabel(target)}: ${kind} ${a.hit ? (a.crit ? 'CRIT' : 'hit') : a.roll === 1 ? 'miss (nat 1)' : 'miss'} ${vs}`;
    if (a.hit) {
        out += `, ${a.damage ?? 0} ${a.damageType || 'damage'}`;
        if (a.knockedOut) out += ', knocked out (subdue)';
        else if (opts.killed) out += ', killed';
        else if (typeof a.targetHpAfter === 'number' && a.targetHpAfter <= 0) out += ', drops (0 HP)';
        else if (typeof a.targetHpAfter === 'number') out += ` (HP ${a.targetHpAfter})`;
    }
    if (a.subdue?.mode === 'overridden') out += '; subdue order overridden';
    else if (a.subdue?.mode === 'n/a: unit') out += '; subdue n/a against a unit';
    // Lane G2 review: a readied attack's own ranged flag that overrode its profile ('attack.ranged: true overrides the spear profile').
    if (opts.override) out += `; ${opts.override}`;
    return out;
}

/** A readied shot held under the subdue order: no shot, the reaction kept; an unanswered onSubdue names the answer. */
export function heldFireLine(reactor: string, answer?: string): string {
    return `⏸ ${reactor} holds ${HELD_FIRE.replace(/^held /, '')} (reaction kept)${answer ? `; onSubdue unanswered: ${answer}` : ''}`;
}

/** A subdued reactor that does not strike a target already at 0 HP. */
export function notStruckDownLine(reactor: string, target: ReactionTarget): string {
    return `⏸ ${reactor} does not strike ${targetLabel(target)}: already down (subdue order; reaction kept)`;
}

/** A player character's opportunity attack, offered with the exact call to paste. */
export function offeredReactionLine(reactor: string, target: ReactionTarget, call: string, opts: { nonlethal?: boolean; orMount?: string } = {}): string {
    return `⚡ ${reactor} may strike ${targetLabel(target)} (OA; the player decides${opts.nonlethal ? '; subdue order: non-lethal' : ''}): ${call}${opts.orMount ? ` (or the mount: targetId '${opts.orMount}')` : ''}`;
}

/** The short form of why an opportunity attack had no shot (total cover), for the line. */
function shortReason(reason: string): string {
    const cover = reason.match(/total cover \(([^)]*)\)/);
    if (cover) return `total cover (${cover[1]})`;
    const first = reason.split(/(?<=\.)\s/)[0].replace(/\.$/, '');
    return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

/** An opportunity attack the reactor could not make (no shot): nothing rolled, the reaction kept. */
export function skippedReactionLine(reactor: string, target: ReactionTarget, reason: string): string {
    return `⚡ ${reactor} → ${targetLabel(target)}: no opportunity attack (${shortReason(reason)}; reaction kept)`;
}

/** A readied action with no attack set off by a move: the GM resolves it with the call. */
export function readiedFlaggedLine(reactor: string, action: string, call: string): string {
    return `⏳ ${reactor}'s readied action triggers (${action}): ${call}`;
}

/** A readied attack that could not fire (a dead part, an unknown profile): nothing spent. */
export function readiedProblemLine(reactor: string, problem: string): string {
    return `⏳ ${reactor}'s readied attack could not fire (${shortReason(problem)}); nothing spent, resolve it with trigger_readied`;
}

/** trigger_readied on a readied action with no attack: the reaction is spent and the GM resolves it. */
export function readiedFiredNoAttackLine(reactor: string, action: string): string {
    return `⏳ ${reactor}'s readied action fires (${action}): reaction spent; resolve its effect`;
}
