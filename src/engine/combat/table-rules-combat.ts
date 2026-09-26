/**
 * Table rules applied to a single attack. Pure functions: they read the
 * attack result and the world's rules and say what is due; the handler
 * writes conditions and output. The engine computes numbers, the table
 * owns flavour.
 */
import type { CombatParticipant, CombatActionResult } from './engine.js';
import { PART_KINDS, type Part } from '../../schema/token-extras.js';
import { compareBands, type RuleSpec, type TableRule } from '../table-rules.js';
import { findPart } from './parts.js';

export interface ConsequenceDue {
    rule: string;
    reason: string;
    options: string[];
    /** 'up': a hit on the same band or higher. 'down': a higher band maiming a lower one. */
    direction: 'up' | 'down';
}

export interface PreparedOutcome {
    rule: string;
    tier: 'miss' | 'hit' | 'catastrophic';
    margin?: number;
    /** What the GM names: the miss options, or the effect the tier carries. */
    effectDue: string[];
    note: string;
}

function roll(result: CombatActionResult): { isHit: boolean; isCrit: boolean; isNat20: boolean; margin?: number; resolved?: string } {
    const ar = (result.attackRoll ?? {}) as { isHit?: boolean; isCrit?: boolean; isNat20?: boolean; margin?: number; resolved?: string };
    return { isHit: !!ar.isHit, isCrit: !!ar.isCrit, isNat20: !!ar.isNat20, margin: ar.resolved ? undefined : ar.margin, resolved: ar.resolved };
}

/**
 * The target counts as the attacker's peer when its band is the same or
 * higher. null means a band is unset, so band rules cannot fire.
 */
export function isPeer(order: string[], actor: CombatParticipant, target: CombatParticipant): boolean | null {
    const cmp = compareBands(order, target.band, actor.band);
    return cmp === null ? null : cmp >= 0;
}

/**
 * A significant hit on a peer: a crit, or damage at or above the threshold.
 * Under direction 'both' a higher band's hit on a lower one counts too. A
 * hit that kills never flags: there is no body left to mark. Unit tokens
 * never flag either; casualties are their consequence.
 */
export function peerConsequence(
    rule: TableRule<'peer_consequence'>,
    order: string[],
    actor: CombatParticipant,
    target: CombatParticipant,
    result: CombatActionResult
): ConsequenceDue | { skipped: string } | null {
    const r = roll(result);
    if (!r.isHit) return null;
    if (target.hp <= 0 || (target as { unit?: unknown }).unit) return null;
    const peer = isPeer(order, actor, target);
    if (peer === null) return { skipped: `${rule.name}: band unset for ${!actor.band ? actor.name : target.name}` };
    const spec = rule.spec as RuleSpec<'peer_consequence'>;
    if (!peer && spec.direction !== 'both') return null;
    const threshold = Math.ceil(target.maxHp * spec.thresholdFraction);
    const damage = result.damage ?? 0;
    let reason: string | null = null;
    if (spec.onCrit && r.isCrit) reason = 'critical hit';
    else if (damage >= threshold) reason = `${damage} damage ≥ ${Math.round(spec.thresholdFraction * 100)}% of max HP (${threshold})`;
    return reason ? { rule: rule.name, reason, options: spec.options, direction: peer ? 'up' : 'down' } : null;
}

type LimbSpec = RuleSpec<'called_strike'>['limbs'][string];

/** What a called strike lands on: an existing part of the target, or a new one. */
export interface ResolvedStrike {
    partName: string;
    kind: Part['kind'];
    limbSpec: LimbSpec;
    existing?: Part;
}

const singularKind = (s: string): Part['kind'] | undefined => {
    const kinds = PART_KINDS as readonly string[];
    if (kinds.includes(s)) return s as Part['kind'];
    const one = s.length > 1 && s.endsWith('s') ? s.slice(0, -1) : s;
    return kinds.includes(one) ? one as Part['kind'] : undefined;
};

/**
 * Where a called strike lands, before any roll:
 * 1. the target's own part named atPart ?? calledStrike: it keeps its kind,
 *    and reads the rule's limb for its name, then its kind, then 'other';
 * 2. the rule's limb: a new part named atPart ?? limb (today's behaviour);
 * 3. a part kind ('wing', 'wings'): a new part of that kind;
 * otherwise a problem naming the limbs and the target's parts.
 */
export function resolveCalledStrike(
    rule: TableRule<'called_strike'>,
    target: CombatParticipant,
    calledStrike: string,
    atPart?: string
): ResolvedStrike | { problem: string } {
    const limbs = (rule.spec as RuleSpec<'called_strike'>).limbs;
    const limb = (key: string): LimbSpec | undefined => {
        const k = key.trim().toLowerCase();
        const hit = Object.keys(limbs).find(l => l.toLowerCase() === k);
        return hit ? limbs[hit] : undefined;
    };
    const called = calledStrike.trim().toLowerCase();
    const existing = findPart(target, atPart ?? calledStrike);
    if (existing) {
        const limbSpec = limb(existing.name) ?? limb(existing.kind) ?? limb('other') ?? { notes: [] };
        return { partName: existing.name, kind: existing.kind, limbSpec, existing };
    }
    const ruleLimb = limb(called);
    if (ruleLimb) return { partName: atPart ?? called, kind: singularKind(called) ?? 'other', limbSpec: ruleLimb };
    const kind = singularKind(called);
    if (kind) return { partName: atPart ?? called, kind, limbSpec: limb(kind) ?? limb('other') ?? { notes: [] } };
    const parts = target.parts?.map(p => p.name).join(', ') || 'none';
    return { problem: `${rule.name} has no '${calledStrike}' limb and ${target.name} has no part by that name (limbs: ${Object.keys(limbs).join(', ')}; ${target.name}'s parts: ${parts})` };
}

/** Refuses a called strike at nothing, or on a target below the attacker's band. */
export function calledStrikeProblem(
    rule: TableRule<'called_strike'>,
    order: string[],
    actor: CombatParticipant,
    target: CombatParticipant,
    limb: string,
    atPart?: string
): string | null {
    const spec = rule.spec as RuleSpec<'called_strike'>;
    const resolved = resolveCalledStrike(rule, target, limb, atPart);
    if ('problem' in resolved) return resolved.problem;
    if (!spec.requirePeer) return null;
    const peer = isPeer(order, actor, target);
    if (peer === null) return `${rule.name} needs both bands set (unset for ${!actor.band ? actor.name : target.name})`;
    if (!peer) return `${rule.name}: called strikes are against a single opponent of your band or greater; ${target.name} (${target.band}) is below ${actor.name} (${actor.band})`;
    return null;
}

/**
 * The crippled part a called strike leaves on a hit. An existing part keeps
 * its kind, hold and every other field; only its state and note change.
 */
export function crippledPart(rule: TableRule<'called_strike'>, resolved: ResolvedStrike): Part {
    const notes = resolved.limbSpec?.notes ?? [];
    return {
        ...resolved.existing,
        name: resolved.partName,
        kind: resolved.existing?.kind ?? resolved.kind,
        state: 'crippled',
        note: `called strike (${rule.name})${notes.length ? `: ${notes.join('; ')}` : ''}`
    };
}

/**
 * The tier a prepared asset lands in. It always does something: a miss is a
 * breach, displacement or forced cover; a hit adds its effect; a hit by the
 * margin or a natural 20 (a GM-posted crit) is catastrophic.
 */
export function preparedOutcome(rule: TableRule<'prepared_asset'>, result: CombatActionResult): PreparedOutcome {
    const spec = rule.spec as RuleSpec<'prepared_asset'>;
    const r = roll(result);
    if (!r.isHit) {
        return { rule: rule.name, tier: 'miss', margin: r.margin, effectDue: spec.missOptions, note: `miss still lands: GM names one of ${spec.missOptions.join(' / ')}` };
    }
    const catastrophic = r.resolved ? r.isCrit : (r.isNat20 || (r.margin ?? 0) >= spec.catastrophicMargin);
    if (catastrophic) {
        const why = r.resolved ? 'GM-posted crit' : r.isNat20 ? 'natural 20' : `hit by ${r.margin} (≥ ${spec.catastrophicMargin})`;
        return { rule: rule.name, tier: 'catastrophic', margin: r.margin, effectDue: [spec.catastrophicEffect], note: `${why}: full damage + ${spec.catastrophicEffect}; GM names it` };
    }
    return { rule: rule.name, tier: 'hit', margin: r.margin, effectDue: [spec.hitEffect], note: `hit: full damage + ${spec.hitEffect}; GM names it` };
}
