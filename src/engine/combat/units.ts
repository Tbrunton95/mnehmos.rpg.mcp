/**
 * Mortal units as one token (Day 366): one initiative, one move, one action,
 * a fixed volley tier. Casualties come from HP, so any damage (cleave
 * included) moves the tier the moment it lands; suppressed, in melee and
 * broken formation each drop it one more step.
 */
import type { CombatParticipant } from './engine.js';

export const DEFAULT_TIERS = [
    { minFraction: 0.75, dice: '4d6' },
    { minFraction: 0.5, dice: '3d6' },
    { minFraction: 0.25, dice: '2d6' },
    { minFraction: 0, dice: '1d6' }
];

export interface VolleyTier {
    dice: string | null;
    models: number;
    maxModels: number;
    step: number;
    drops: string[];
    reason: string;
}

export function liveModels(p: Pick<CombatParticipant, 'hp' | 'unit'>): number {
    if (!p.unit) return 0;
    return Math.max(0, Math.min(p.unit.models, Math.ceil(p.hp / p.unit.hpPerModel)));
}

export function volleyTier(p: Pick<CombatParticipant, 'hp' | 'unit'>): VolleyTier | null {
    const u = p.unit;
    if (!u) return null;
    const tiers = u.tiers?.length ? u.tiers : DEFAULT_TIERS;
    const models = liveModels(p);
    const drops = [u.suppressed && 'suppressed', u.inMelee && 'in melee', u.brokenFormation && 'broken formation'].filter(Boolean) as string[];
    if (models === 0) return { dice: null, models, maxModels: u.models, step: -1, drops, reason: 'no models left' };
    const strength = models / u.models;
    let step = tiers.findIndex(t => strength >= t.minFraction);
    if (step < 0) step = tiers.length - 1;
    step = Math.min(tiers.length - 1, step + drops.length);
    const reason = `${models}/${u.models} models${drops.map(d => `, ${d} −1`).join('')}`;
    return { dice: tiers[step].dice, models, maxModels: u.models, step, drops, reason };
}

export function describeUnit(p: Pick<CombatParticipant, 'hp' | 'unit'>): string {
    const t = volleyTier(p);
    if (!p.unit || !t) return '';
    return `${p.unit.routed ? 'ROUTED · ' : ''}×${t.models}/${t.maxModels} ${p.unit.packed ? 'packed' : 'spaced'} · volley ${t.dice ?? 'none'}${t.drops.length ? ` (${t.drops.join(', ')})` : ''}`;
}

/** A unit owes a break test when it drops through this fraction of its models, unless it sets its own breakAt. */
export const DEFAULT_BREAK_AT = 0.5;

/** One labelled term added to a unit's morale for a break test (a banner, a battle cry, mob rule). */
export interface MoraleModifier { label: string; value: number }

export interface BreakTest {
    participantId: string;
    name: string;
    modelsBefore: number;
    modelsAfter: number;
    maxModels: number;
    breakAt: number;
    /** The unit's own morale, when it has one. */
    morale?: number;
    modifiers: MoraleModifier[];
    /** The modifiers summed. */
    moraleBonus: number;
    /** morale + moraleBonus, when morale is set. */
    moraleTotal?: number;
    /** The call that routs the unit when the GM's test fails. */
    setUnit: string;
    /** The BREAK TEST DUE line for the banner. */
    line: string;
}

/**
 * A break test is due when damage carries a unit from above its breakAt
 * fraction of models (default half) to at or below it, the unit still
 * stands, and it has not already routed. Only the crossing counts: losses
 * below the line owe no second test. The engine flags; the GM rolls, and
 * routs the unit with set_unit {routed: true}. moraleBonus terms (a banner,
 * a battle cry, mob rule) add to the morale as one labelled sum.
 */
export function breakTestDue(
    p: Pick<CombatParticipant, 'id' | 'name' | 'hp' | 'unit'>,
    hpBefore: number,
    opts: { moraleBonus?: MoraleModifier[] } = {}
): BreakTest | null {
    const u = p.unit;
    if (!u || u.routed) return null;
    const modelsBefore = liveModels({ hp: hpBefore, unit: u });
    const modelsAfter = liveModels(p);
    if (modelsAfter <= 0) return null;
    const breakAt = u.breakAt ?? DEFAULT_BREAK_AT;
    if (!(modelsBefore / u.models > breakAt && breakAt >= modelsAfter / u.models)) return null;
    const modifiers = (opts.moraleBonus ?? []).filter(m => m.value !== 0);
    const moraleBonus = modifiers.reduce((a, m) => a + m.value, 0);
    const moraleTotal = u.morale !== undefined ? u.morale + moraleBonus : undefined;
    const terms = modifiers.map(m => ` ${m.value >= 0 ? '+' : ''}${m.value} (${m.label})`).join('');
    const moraleText = u.morale !== undefined
        ? `morale ${u.morale}${terms}${modifiers.length ? ` = ${moraleTotal}` : ''}`
        : `morale unset${terms ? `, bonus${terms}` : ''}`;
    const setUnit = `combat_manage set_unit {participantId: '${p.id}', routed: true}`;
    return {
        participantId: p.id, name: p.name, modelsBefore, modelsAfter, maxModels: u.models, breakAt,
        ...(u.morale !== undefined ? { morale: u.morale } : {}),
        modifiers, moraleBonus,
        ...(moraleTotal !== undefined ? { moraleTotal } : {}),
        setUnit,
        line: `BREAK TEST DUE: ${p.name} fell to ${modelsAfter}/${u.models} models (break at ${Math.round(breakAt * 100)}%): ${moraleText}. Roll it; on a failure ${setUnit}`
    };
}
