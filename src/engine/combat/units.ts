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
    return `×${t.models}/${t.maxModels} ${p.unit.packed ? 'packed' : 'spaced'} · volley ${t.dice ?? 'none'}${t.drops.length ? ` (${t.drops.join(', ')})` : ''}`;
}
