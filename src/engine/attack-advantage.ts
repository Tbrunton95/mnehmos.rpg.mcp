/**
 * Play report 7 #7, second phase (lane F): declared advantage on attack rolls
 * and initiative.
 *
 * Lane E made the grammar (src/engine/advantage-scope.ts) and wired checks,
 * saves and grapple. The attack and initiative roads read it here:
 *  - attack, attack:melee, attack:ranged cover an attack roll in that lane
 *    (the attack's own lane: the profile's ranged flag, else the grid
 *    distance against reach, as cover and fighting styles decide it);
 *  - initiative, and check:dex (initiative is a Dexterity check in 5e),
 *    cover an initiative roll.
 * An untagged mechanic fires by itself; a tagged one when the roll asserts
 * its tag. Each source is labelled for the breakdown and the roll log:
 * 'Bloodlust (attack:melee)' for an untagged one (the scope it fired on),
 * 'Horn Charge (charging)' for a tag the call asserted.
 *
 * The older form (a number in value, skill / save keys, autoApply) never
 * covers an attack or initiative: scopedMechanic reads it as undefined.
 *
 * Pure: no database, no dice.
 */
import { scopedMechanic, scopeCovers, type RollScope, type EffectDeclaration, type SourceWhich } from './advantage-scope.js';
import { normTag } from './senses.js';

export type AttackLane = 'melee' | 'ranged';

/** The labels a roll takes from declared sources, side by side. */
export interface DeclaredSides { advantage: string[]; disadvantage: string[] }

/** One roll's declarations: what fired, what waits for its tag, and which tags fired something. */
export interface RollDeclarations extends DeclaredSides {
    /** Tagged mechanics in scope whose tag the roll did not assert (for the hint). */
    gated: Array<{ which: SourceWhich; effect: string; tag: string; scope: string }>;
    /** The context tags (normalised) that fired a mechanic. */
    firedTags: string[];
}

const pushOnce = (list: string[], label: string) => { if (!list.some(x => x.toLowerCase() === label.toLowerCase())) list.push(label); };

/**
 * The scoped mechanics on these effects that fire on this roll: untagged ones
 * in scope (one per effect and side, labelled with the scope), tagged ones
 * whose tag the context asserts (labelled with the tag).
 */
export function declaredOnRoll(effects: readonly EffectDeclaration[], roll: RollScope, context: readonly string[] = []): RollDeclarations {
    const tags = new Set(context.map(normTag));
    const out: RollDeclarations = { advantage: [], disadvantage: [], gated: [], firedTags: [] };
    const untagged = new Set<string>();
    for (const e of effects) {
        for (const m of e.mechanics ?? []) {
            const s = scopedMechanic(m);
            if (!s || !scopeCovers(s.scope, roll)) continue;
            const side = out[s.which];
            if (!s.tag) {
                const key = `${s.which}:${e.name.toLowerCase()}`;
                if (untagged.has(key)) continue;
                untagged.add(key);
                pushOnce(side, `${e.name} (${s.text})`);
            } else if (tags.has(normTag(s.tag))) {
                pushOnce(side, `${e.name} (${s.tag})`);
                if (!out.firedTags.includes(normTag(s.tag))) out.firedTags.push(normTag(s.tag));
            } else {
                out.gated.push({ which: s.which, effect: e.name, tag: s.tag, scope: s.text });
            }
        }
    }
    return out;
}

/** Both sides merged, each label once, in order. */
export function mergeSides(...sides: Array<Partial<DeclaredSides> | undefined>): DeclaredSides {
    const out: DeclaredSides = { advantage: [], disadvantage: [] };
    for (const s of sides) {
        for (const a of s?.advantage ?? []) pushOnce(out.advantage, a);
        for (const d of s?.disadvantage ?? []) pushOnce(out.disadvantage, d);
    }
    return out;
}

/** Whether a side has anything to say. */
export const hasSides = (s?: Partial<DeclaredSides>): boolean => !!(s?.advantage?.length || s?.disadvantage?.length);

/**
 * The roll log purpose naming the sources, as grapple and math_manage write
 * it: 'attack (adv: Bloodlust (attack:melee); dis: GM: the fog)'. With no
 * source it stays exactly the base ('attack'), which roll counts query.
 */
export function purposeWithSources(base: string, sides?: Partial<DeclaredSides>): string {
    const why = [
        sides?.advantage?.length ? `adv: ${sides.advantage.join(', ')}` : '',
        sides?.disadvantage?.length ? `dis: ${sides.disadvantage.join(', ')}` : ''
    ].filter(Boolean).join('; ');
    return why ? `${base} (${why})` : base;
}

/**
 * Play report 7 (lanes G1, H): the sources a d20 took, for a reply line:
 * ' [d20 4, 17; adv: Danger Sense (save:dex)]', '' when it took none. Both
 * sides on one die say they cancelled. Pure, so the engine's own end-of-turn
 * save prints it the way every save the handlers roll does (saveSidesNote).
 */
export function rollSidesNote(rolls: readonly number[], sides?: Partial<DeclaredSides>): string {
    const adv = sides?.advantage ?? [], dis = sides?.disadvantage ?? [];
    if (!adv.length && !dis.length) return '';
    const why = [adv.length ? `adv: ${adv.join(', ')}` : '', dis.length ? `dis: ${dis.join(', ')}` : ''].filter(Boolean).join('; ');
    return ` [d20 ${rolls.join(', ')}; ${why}${adv.length && dis.length && rolls.length === 1 ? '; cancel: one die' : ''}]`;
}

// ─── The texts the attack and initiative params carry (describes) ───

/** combat_action attack: what a named source means here. */
export const ATTACK_SOURCE_NOTE = "attack (play report 7, lane F): grants only what DECLARES it for this attack's lane — an effect mechanic {type: 'advantage_on' | 'disadvantage_on', value: 'attack' | 'attack:melee' | 'attack:ranged'} (naming a tagged one asserts its tag: 'Horn Charge (charging, named)'), or a standard condition's 5e rule (invisible: advantage; poisoned, prone, blinded, frightened, restrained: disadvantage). A name that matches nothing, two things, or declares nothing for this attack REFUSES it before any roll or spend (writes: none, sourceProblems with the call that would declare it). Logged in the roll's purpose ('attack (adv: …)').";

/** combat_action attack: the tags the attack asserts. */
export const ATTACK_CONTEXT_DESCRIBE = "attack (play report 7, lane F): tags this attack asserts (['charging']; a bare string is one tag). An effect mechanic {type: 'advantage_on' | 'disadvantage_on', value: 'attack' | 'attack:melee' | 'attack:ranged', condition: 'charging'} on the attacker fires on its tag; untagged ones fire on every attack in their lane without it. A tag that fires nothing is said. Opportunity and readied attacks carry no context: only untagged mechanics fire there";

/** combat_manage create participants[].context and add_participant context. */
export const INITIATIVE_CONTEXT_DESCRIBE = "Play report 7 (lane F): tags this token's initiative roll asserts (['ambush']; a bare string is one tag). An effect mechanic {type: 'advantage_on' | 'disadvantage_on', value: 'initiative' | 'check:dex', condition: 'ambush'} on the token fires on its tag; untagged ones fire without it (two d20s, keep the higher; disadvantage the lower; both cancel). A tag that fires nothing is warned; a given initiative rolls nothing and ignores it";

/**
 * Lane F: what an initiative roll records when a declared source fired: the
 * labels on each side, and both dice when two were rolled (advantage or
 * disadvantage alone; both together cancel to one die).
 */
export interface InitiativeDeclared { advantage?: string[]; disadvantage?: string[]; rolls?: number[] }
