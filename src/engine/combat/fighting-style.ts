/**
 * Item 17 (play report 2): fighting styles, pure. What a style does to one
 * attack given how it is made. executeAttack calls it for the handler's
 * attacks, readied attacks and opportunity attacks alike; defense is the
 * target's style and is applied by the handler where the AC is derived.
 */
import type { FightingStyle } from '../../schema/token-extras.js';

/** Great weapon fighting rerolls weapon dice at or below this once. */
export const GWF_REROLL_AT_OR_BELOW = 2;

export interface FightingStyleContext {
    /** The attack is ranged (not a melee weapon attack). */
    ranged?: boolean;
    /** The weapon is wielded in both hands for this swing. */
    twoHanded?: boolean;
    /** The swing is made with the off-hand weapon. */
    offhand?: boolean;
    /** A second weapon is equipped in the off hand (dueling wants no other weapon). */
    dualWielding?: boolean;
    /** The GM posted the result: no style touches a posted roll or damage. */
    resolved?: boolean;
}

export interface FightingStyleEffects {
    style: FightingStyle;
    /** Whether the style changes this attack at all. */
    applied: boolean;
    attackBonus?: number;
    damageBonus?: number;
    rerollAtOrBelow?: number;
    /** The situational line, or why the style did not apply. */
    note: string;
}

/**
 * The style's effect on this attack, or undefined when there is no style or
 * the GM posted the outcome. A style that does not fit the swing comes back
 * with applied: false and the reason, so the reply can say why.
 */
export function fightingStyleEffects(style: FightingStyle | undefined, ctx: FightingStyleContext): FightingStyleEffects | undefined {
    if (!style || ctx.resolved) return undefined;
    const melee = !ctx.ranged;
    switch (style) {
        case 'archery':
            return ctx.ranged
                ? { style, applied: true, attackBonus: 2, note: 'archery +2 to hit (ranged)' }
                : { style, applied: false, note: 'archery: melee attack, no bonus (ranged: true or a ranged profile)' };
        case 'great_weapon':
            if (!melee) return { style, applied: false, note: 'great weapon fighting: ranged attack, no reroll' };
            if (!ctx.twoHanded) return { style, applied: false, note: 'great weapon fighting: one-handed, no reroll (twoHanded on the profile or the call)' };
            return { style, applied: true, rerollAtOrBelow: GWF_REROLL_AT_OR_BELOW, note: `great weapon fighting: weapon dice of ${GWF_REROLL_AT_OR_BELOW} or less rerolled once` };
        case 'dueling':
            if (!melee) return { style, applied: false, note: 'dueling: ranged attack, no bonus' };
            if (ctx.twoHanded) return { style, applied: false, note: 'dueling: two-handed, no bonus' };
            if (ctx.offhand) return { style, applied: false, note: 'dueling: off-hand weapon, no bonus' };
            if (ctx.dualWielding) return { style, applied: false, note: 'dueling: a second weapon is wielded, no bonus (unequip it or carry a shield)' };
            return { style, applied: true, damageBonus: 2, note: 'dueling +2 damage (one-handed melee)' };
        case 'defense':
            return { style, applied: false, note: 'defense: +1 AC against attacks on this creature, not a bonus on its own' };
    }
}
