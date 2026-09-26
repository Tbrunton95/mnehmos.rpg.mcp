/**
 * Forms: any creature statblock (a world creature rule or a built-in
 * preset) is a shape a character can take. The form replaces the sheet
 * fields it names and keeps the rest; the character's own values are kept
 * as a base snapshot so the form can be put down again.
 */
import { z } from 'zod';
import type { CreatureSpec } from './table-rules.js';
import type { AttackProfile, Part } from '../schema/token-extras.js';

/** The sheet fields a form sets and a revert restores. */
export const FORM_KEYS = [
    'stats', 'hp', 'maxHp', 'ac', 'size', 'reach', 'attacksPerAction', 'attacks', 'abilities', 'cr',
    'resistances', 'vulnerabilities', 'immunities', 'regeneration', 'band', 'parts',
    'legendaryActions', 'legendaryResistances'
] as const;
export type FormKey = typeof FORM_KEYS[number];

export const HP_MODES = ['keep_fraction', 'full', 'keep'] as const;
export type HpMode = typeof HP_MODES[number];

/** A fresh enum each call, so no outer schema holds one zod instance twice. */
export function hpModeSchema() {
    return z.enum(HP_MODES);
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * The sheet fields a creature spec sets. stats is partial (merged over the
 * base by the caller); a single attack (attack, or attackBonus/attackDamage)
 * becomes one default attack profile.
 */
export function sheetFromCreature(spec: CreatureSpec): Partial<Record<FormKey, unknown>> {
    const full = spec.maxHp ?? spec.hp;
    let attacks: AttackProfile[] | undefined = spec.attacks ? copy(spec.attacks as AttackProfile[]) : undefined;
    if (!attacks && spec.attack) {
        attacks = [{ name: spec.attack.name, attackBonus: spec.attack.toHit ?? spec.attackBonus ?? 0, damage: spec.attack.damage, ...(spec.attack.damageType ? { damageType: spec.attack.damageType } : {}), default: true }];
    } else if (!attacks && spec.attackDamage) {
        attacks = [{ name: 'attack', attackBonus: spec.attackBonus ?? 0, damage: spec.attackDamage, ...(spec.attackDamageType ? { damageType: spec.attackDamageType } : {}), default: true }];
    }
    const parts = (spec.parts as Part[] | undefined)?.map(pt => {
        const { latchedTo: _l, ...rest } = pt;
        return { ...rest, state: 'intact' as const, ...(pt.maxHp !== undefined || pt.hp !== undefined ? { hp: pt.maxHp ?? pt.hp } : {}) };
    });
    const out: Partial<Record<FormKey, unknown>> = {
        stats: spec.stats ? { ...spec.stats } : undefined,
        hp: full,
        maxHp: full,
        ac: spec.ac,
        size: spec.size,
        reach: spec.reach,
        attacksPerAction: spec.attacksPerAction,
        attacks,
        abilities: spec.abilities?.map(a => ({ ...a, ready: true })),
        cr: spec.cr,
        resistances: [...spec.resistances],
        vulnerabilities: [...spec.vulnerabilities],
        immunities: [...spec.immunities],
        regeneration: spec.regeneration,
        band: spec.band,
        parts,
        legendaryActions: spec.legendaryActions,
        legendaryResistances: spec.legendaryResistances
    };
    for (const k of Object.keys(out) as FormKey[]) if (out[k] === undefined) delete out[k];
    return out;
}

/** The character's own FORM_KEYS; null marks a field it did not set. */
export function snapshotBase(char: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(FORM_KEYS.map(k => [k, char[k] === undefined || char[k] === null ? null : copy(char[k])]));
}

/**
 * HP after a change of maximum. keep_fraction (default) keeps the share of
 * HP left, never dropping a living creature to 0; full heals to the new
 * maximum; keep keeps the number, capped at it.
 */
export function nextHp(mode: HpMode | undefined, cur: number, curMax: number, newMax: number): number {
    if (mode === 'full') return newMax;
    if (mode === 'keep') return Math.min(cur, newMax);
    if (cur <= 0) return 0;
    return Math.min(newMax, Math.max(1, Math.round(cur * newMax / Math.max(1, curMax))));
}
