/**
 * Table rules applied to a single attack. Pure functions: they read the
 * attack result and the world's rules and say what is due; the handler
 * writes conditions and output. The engine computes numbers, the table
 * owns flavour.
 */
import type { CombatParticipant, CombatActionResult } from './engine.js';
import type { Condition } from './conditions.js';
import { DurationType } from './conditions.js';
import { PART_KINDS, type Part } from '../../schema/token-extras.js';
import { compareBands, type RuleSpec, type TableRule } from '../table-rules.js';

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

/** Refuses a called strike on a target below the attacker's band. */
export function calledStrikeProblem(
    rule: TableRule<'called_strike'>,
    order: string[],
    actor: CombatParticipant,
    target: CombatParticipant,
    limb: string
): string | null {
    const spec = rule.spec as RuleSpec<'called_strike'>;
    if (!spec.limbs[limb]) return `${rule.name} has no '${limb}' limb (limbs: ${Object.keys(spec.limbs).join(', ')})`;
    if (!spec.requirePeer) return null;
    const peer = isPeer(order, actor, target);
    if (peer === null) return `${rule.name} needs both bands set (unset for ${!actor.band ? actor.name : target.name})`;
    if (!peer) return `${rule.name}: called strikes are against a single opponent of your band or greater; ${target.name} (${target.band}) is below ${actor.name} (${actor.band})`;
    return null;
}

/** The crippled part a called strike leaves on a hit: the part aimed at, or the limb. */
export function crippledPart(rule: TableRule<'called_strike'>, limb: string, atPart?: string): Part {
    const spec = (rule.spec as RuleSpec<'called_strike'>).limbs[limb];
    const kind = (PART_KINDS as readonly string[]).includes(limb) ? limb as Part['kind'] : 'other';
    return { name: atPart ?? limb, kind, state: 'crippled', note: `called strike (${rule.name})${spec?.notes?.length ? `: ${spec.notes.join('; ')}` : ''}` };
}

/** The crippling condition a called strike leaves on a hit. */
export function crippleCondition(rule: TableRule<'called_strike'>, limb: string, actorName: string): Omit<Condition, 'id'> {
    const spec = (rule.spec as RuleSpec<'called_strike'>).limbs[limb];
    return {
        type: `crippled:${limb}` as Condition['type'],
        durationType: DurationType.PERMANENT,
        sourceId: `called strike: ${actorName}`,
        metadata: {
            rule: rule.name,
            ...(spec.speed !== undefined && spec.speed < 1 ? { speedFactor: spec.speed } : {}),
            ...(spec.attackDisadvantage ? { attackDisadvantage: true } : {}),
            notes: spec.notes
        }
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
