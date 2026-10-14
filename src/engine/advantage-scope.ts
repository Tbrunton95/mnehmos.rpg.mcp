/**
 * Play report 7 #7, the owner's spec: declared advantage.
 *
 * A condition stays prose. Anything that changes a roll is declared on an
 * effect mechanic:
 *   {type: 'advantage_on' | 'disadvantage_on', value: '<scope>', condition: '<when-tag>'}
 * The scope grammar is fixed, so the engine knows which rolls it touches:
 *   attack, attack:melee, attack:ranged
 *   grapple, grapple:<move>            (clinch, takedown, throw, slam, control, break, shove)
 *   check:<skill>, check:<ability>     (check:athletics, check:str)
 *   save:<ability>                     (save:str)
 *   initiative
 * Anything else is refused at write time, naming these forms. `condition` is a
 * when-tag: a tagged mechanic fires only when the roll asserts the tag (the
 * roll's context, or the GM naming the effect in advantageSources); an
 * untagged one fires on every roll in its scope.
 *
 * The older form — a number (or prose) in value, scoped by `skill` / `save`,
 * or flagged autoApply — keeps exactly the meaning it had: the resolver's
 * autoAdvantage and applyDeclaredEffects still read it, and this module
 * never does. A mechanic is in the new grammar only when its value is a
 * scope string and it carries none of skill, save or autoApply (write-time
 * validation refuses that mix, so nothing stored is ambiguous).
 *
 * Pure: no database, no dice.
 */
import { normSkill, skillKey, srdSkillAbility, SRD_SKILL_ABILITY, type ShortAbility } from './skill-modifier.js';
import { normTag } from './senses.js';

export type SourceWhich = 'advantage' | 'disadvantage';

/** What a mechanic's value declares. */
export type AdvantageScope =
    | { kind: 'attack'; range?: 'melee' | 'ranged' }
    | { kind: 'grapple'; move?: string }
    | { kind: 'check'; skill?: string; ability?: ShortAbility }
    | { kind: 'save'; ability: ShortAbility }
    | { kind: 'initiative' };

/** The roll being made, as the scope matcher sees it. */
export type RollScope =
    /** A skill check (skill key + the ability it rolled with, if any) or an ability check (ability only). */
    | { kind: 'check'; skill?: string; ability?: ShortAbility }
    | { kind: 'save'; ability: ShortAbility }
    /** A grapple contest: the move, and the skills and abilities the roll is made with. */
    | { kind: 'grapple'; move: string; skills: string[]; abilities: ShortAbility[] }
    | { kind: 'attack'; range: 'melee' | 'ranged' }
    | { kind: 'initiative' };

/** The grapple moves that roll a contest (execute takes a posted crit and rolls none). */
export const SCOPE_GRAPPLE_MOVES = ['clinch', 'takedown', 'throw', 'slam', 'control', 'break', 'shove'] as const;

/** The accepted forms, printed in every refusal. */
export const SCOPE_GRAMMAR = `Accepted scopes: attack, attack:melee, attack:ranged, grapple, grapple:<move> (${SCOPE_GRAPPLE_MOVES.join(', ')}), check:<skill> (an SRD skill such as check:athletics, or a skill this world defines), check:<ability> (check:str), save:<ability> (save:str), initiative.`;

const ABILITIES: readonly ShortAbility[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const LONG: Record<string, ShortAbility> = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };
const LONG_OF: Record<ShortAbility, string> = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };

/** 'str', 'STR', 'Strength' → 'str'; anything else undefined. */
export function abilityOf(text: string): ShortAbility | undefined {
    const t = text.trim().toLowerCase();
    if ((ABILITIES as readonly string[]).includes(t)) return t as ShortAbility;
    return LONG[t];
}

/** The long ability name ('wisdom') the older form scopes saves by. */
export const longAbility = (a: ShortAbility): string => LONG_OF[a];

/** The canonical text of a scope: 'check:sleight_of_hand', 'save:dex', 'grapple:control'. */
export function scopeText(scope: AdvantageScope): string {
    switch (scope.kind) {
        case 'attack': return scope.range ? `attack:${scope.range}` : 'attack';
        case 'grapple': return scope.move ? `grapple:${scope.move}` : 'grapple';
        case 'check': return `check:${scope.ability ?? scope.skill}`;
        case 'save': return `save:${scope.ability}`;
        case 'initiative': return 'initiative';
    }
}

export type ScopeParse = { ok: true; scope: AdvantageScope; text: string } | { ok: false; problem: string };

/**
 * Read a mechanic's value as a scope. Case and spacing fold ('Check: Sleight
 * of Hand' → 'check:sleight_of_hand'). `worldSkills` is given at write time:
 * then check:<skill> must be an SRD skill, an ability or one of them; read
 * time (no list) accepts any skill name, since writing already checked it.
 */
export function parseAdvantageScope(value: unknown, opts: { worldSkills?: readonly string[] } = {}): ScopeParse {
    const raw = typeof value === 'string' ? value.trim() : '';
    const refuse = (why?: string): ScopeParse => ({ ok: false, problem: `${why ? `${why} ` : ''}${SCOPE_GRAMMAR}` });
    if (!raw) return refuse(`'${String(value ?? '')}' is not a scope.`);
    const colon = raw.indexOf(':');
    const head = (colon < 0 ? raw : raw.slice(0, colon)).trim().toLowerCase();
    const tail = colon < 0 ? undefined : raw.slice(colon + 1).trim();
    const ok = (scope: AdvantageScope): ScopeParse => ({ ok: true, scope, text: scopeText(scope) });
    switch (head) {
        case 'attack': {
            if (tail === undefined) return ok({ kind: 'attack' });
            const range = tail.toLowerCase();
            return range === 'melee' || range === 'ranged' ? ok({ kind: 'attack', range }) : refuse(`'${raw}': an attack scope is attack, attack:melee or attack:ranged.`);
        }
        case 'grapple': {
            if (tail === undefined) return ok({ kind: 'grapple' });
            const move = tail.toLowerCase();
            if (move === 'execute') return refuse(`'${raw}': execute rolls no contest, so nothing can roll it at advantage.`);
            return (SCOPE_GRAPPLE_MOVES as readonly string[]).includes(move) ? ok({ kind: 'grapple', move }) : refuse(`'${raw}': '${tail}' is not a grapple move.`);
        }
        case 'check': {
            if (!tail) return refuse(`'${raw}': check needs a skill or an ability (check:athletics, check:str).`);
            const ability = abilityOf(tail);
            if (ability) return ok({ kind: 'check', ability });
            if (srdSkillAbility(tail)) return ok({ kind: 'check', skill: skillKey(tail) });
            if (opts.worldSkills && !opts.worldSkills.some(w => normSkill(w) === normSkill(tail))) {
                const world = opts.worldSkills.length ? `, or this world's skills (${opts.worldSkills.join(', ')})` : '';
                return { ok: false, problem: `'${raw}': '${tail}' is not an SRD skill, an ability or a skill this world defines. check takes the 18 SRD skills (${Object.keys(SRD_SKILL_ABILITY).join(', ')}), an ability (${ABILITIES.join(', ')})${world}; define a world skill with table_rules {kind: 'skill', name: '${tail}', spec: {ability}}. ${SCOPE_GRAMMAR}` };
            }
            return ok({ kind: 'check', skill: skillKey(tail) });
        }
        case 'save': {
            const ability = tail ? abilityOf(tail) : undefined;
            return ability ? ok({ kind: 'save', ability }) : refuse(`'${raw}': save needs an ability (save:str … save:cha).`);
        }
        case 'initiative':
            return tail === undefined ? ok({ kind: 'initiative' }) : refuse(`'${raw}': initiative takes no qualifier.`);
        default:
            return refuse(`'${raw}' is not a scope.`);
    }
}

/** Whether a declared scope covers this roll. check:<skill> and check:<ability> reach a grapple's Athletics (or Acrobatics on a break); check:dex reaches initiative (5e: a Dexterity check). */
export function scopeCovers(scope: AdvantageScope, roll: RollScope): boolean {
    switch (scope.kind) {
        case 'attack': return roll.kind === 'attack' && (!scope.range || scope.range === roll.range);
        case 'grapple': return roll.kind === 'grapple' && (!scope.move || scope.move === roll.move);
        case 'save': return roll.kind === 'save' && roll.ability === scope.ability;
        case 'initiative': return roll.kind === 'initiative';
        case 'check':
            if (scope.ability) {
                if (roll.kind === 'check') return roll.ability === scope.ability;
                if (roll.kind === 'grapple') return roll.abilities.includes(scope.ability);
                if (roll.kind === 'initiative') return scope.ability === 'dex';
                return false;
            }
            if (!scope.skill) return false;
            if (roll.kind === 'check') return !!roll.skill && normSkill(roll.skill) === normSkill(scope.skill);
            if (roll.kind === 'grapple') return roll.skills.some(s => normSkill(s) === normSkill(scope.skill!));
            return false;
    }
}

/** A roll in the words of a refusal: 'stealth', 'STR checks', 'WIS saves', 'a grapple (clinch)'. */
export function rollPhrase(roll: RollScope): string {
    switch (roll.kind) {
        case 'check': return roll.skill ? roll.skill.replace(/_/g, ' ') : `${(roll.ability ?? '').toUpperCase()} checks`;
        case 'save': return `${roll.ability.toUpperCase()} saves`;
        case 'grapple': return `a grapple (${roll.move})`;
        case 'attack': return `${roll.range} attacks`;
        case 'initiative': return 'initiative';
    }
}

/** The scope that would cover this roll, for the call a refusal prints. */
export function suggestedScope(roll: RollScope): string {
    switch (roll.kind) {
        case 'check': return roll.skill ? `check:${skillKey(roll.skill)}` : `check:${roll.ability}`;
        case 'save': return `save:${roll.ability}`;
        case 'grapple': return 'grapple';
        case 'attack': return `attack:${roll.range}`;
        case 'initiative': return 'initiative';
    }
}

type Mech = Record<string, unknown>;
const ADVANTAGE_TYPES: Record<string, SourceWhich> = { advantage_on: 'advantage', disadvantage_on: 'disadvantage' };
const LEGACY_KEYS = ['skill', 'save', 'autoApply'] as const;
const NUMERIC = /^\s*[+-]?\d+(\.\d+)?\s*$/;

export interface ScopedMechanic { which: SourceWhich; scope: AdvantageScope; text: string; tag?: string }

/** A mechanic in the new grammar, read: undefined for every other mechanic, the older advantage form included. */
export function scopedMechanic(m: unknown): ScopedMechanic | undefined {
    if (!m || typeof m !== 'object') return undefined;
    const mech = m as Mech;
    const which = ADVANTAGE_TYPES[String(mech.type ?? '')];
    if (!which || typeof mech.value !== 'string' || NUMERIC.test(mech.value)) return undefined;
    if (mech.skill !== undefined || mech.save !== undefined || mech.autoApply === true) return undefined;
    const parsed = parseAdvantageScope(mech.value);
    if (!parsed.ok) return undefined;
    const tag = typeof mech.condition === 'string' && mech.condition.trim() ? mech.condition.trim() : undefined;
    return { which, scope: parsed.scope, text: parsed.text, ...(tag ? { tag } : {}) };
}

/**
 * Write-time check for apply_effect, edit_effect, replace_effect and
 * feature_from_condition (after the type aliases are normalised). An
 * advantage mechanic whose value is text is the new grammar: it must parse,
 * is stored in canonical form, and may not carry skill, save or autoApply.
 * A number in value, or a skill/save/autoApply mechanic with prose in value,
 * is the older form and passes untouched. Problems are prefixed mechanics[i].
 * `stored` is the row's mechanics on an edit: one of them re-sent unchanged
 * passes as it is.
 */
export function validateAdvantageMechanics<T>(mechanics: readonly T[], opts: { worldSkills?: readonly string[]; stored?: readonly unknown[] } = {}): { mechanics: T[]; problems: string[] } {
    const problems: string[] = [];
    // An edit that re-sends a mechanic the row already holds, unchanged, is
    // not writing a new one: an older-form mechanic keeps its meaning through
    // the edit_effect call a refusal prints.
    const stored = new Set((opts.stored ?? []).map(mechanicKey));
    const out = mechanics.map((m, i) => {
        if (!m || typeof m !== 'object') return m;
        if (stored.has(mechanicKey(m))) return m;
        const mech = m as unknown as Mech;
        const type = String(mech.type ?? '');
        if (!ADVANTAGE_TYPES[type] || typeof mech.value !== 'string' || NUMERIC.test(mech.value)) return m;
        const legacy = LEGACY_KEYS.filter(k => k === 'autoApply' ? mech.autoApply === true : mech[k] !== undefined);
        const parsed = parseAdvantageScope(mech.value, opts);
        if (parsed.ok && legacy.length) {
            problems.push(`mechanics[${i}]: ${type} value '${mech.value}' is a scope; ${legacy.join(', ')} belong${legacy.length === 1 ? 's' : ''} to the older form — drop ${legacy.length === 1 ? 'it' : 'them'}. An untagged scoped mechanic fires by itself on every roll in its scope; condition: '<tag>' makes it fire only when the roll asserts the tag (context) or the GM names the effect (advantageSources).`);
            return m;
        }
        if (legacy.length) return m; // the older form, prose in value: unchanged
        if (!parsed.ok) {
            // The parse problem opens with the value itself: "'stealth checks' is not a scope. Accepted scopes: …".
            problems.push(`mechanics[${i}]: ${type} value ${parsed.problem}`);
            return m;
        }
        return { ...mech, value: parsed.text } as unknown as T;
    });
    return { mechanics: out, problems };
}

/** A mechanic compared by content, whatever order its keys come in. */
function mechanicKey(m: unknown): string {
    const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
    return JSON.stringify(sort(m));
}

/** An active effect with its mechanics, as declarations are read. */
export interface EffectDeclaration { name: string; mechanics: unknown[] }

export interface ScopedFire { label: string; lane: 'ENGINE' | 'EFFECT'; effect: string; tag?: string }

/**
 * The scoped mechanics that fire on this roll by themselves: untagged ones in
 * scope (ENGINE lane, labelled by the effect's name), and tagged ones whose
 * tag the roll's context asserts (EFFECT lane, 'Horn-Lock (head-on)'). Tagged
 * ones in scope without their tag are `gated`, for the hint.
 */
export function scopedAdvantage(effects: readonly EffectDeclaration[], which: SourceWhich, roll: RollScope, context: readonly string[] = []): { fired: ScopedFire[]; gated: Array<{ effect: string; tag: string; scope: string }> } {
    const tags = new Set(context.map(normTag));
    const fired: ScopedFire[] = [];
    const gated: Array<{ effect: string; tag: string; scope: string }> = [];
    const seen = new Set<string>();
    for (const e of effects) {
        for (const m of e.mechanics ?? []) {
            const s = scopedMechanic(m);
            if (!s || s.which !== which || !scopeCovers(s.scope, roll)) continue;
            if (!s.tag) {
                if (!seen.has(e.name.toLowerCase())) { seen.add(e.name.toLowerCase()); fired.push({ label: e.name, lane: 'ENGINE', effect: e.name }); }
            } else if (tags.has(normTag(s.tag))) {
                const label = `${e.name} (${s.tag})`;
                if (!seen.has(label.toLowerCase())) { seen.add(label.toLowerCase()); fired.push({ label, lane: 'EFFECT', effect: e.name, tag: s.tag }); }
            } else {
                gated.push({ effect: e.name, tag: s.tag, scope: s.text });
            }
        }
    }
    return { fired, gated };
}
