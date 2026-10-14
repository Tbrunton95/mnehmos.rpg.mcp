/**
 * GM-named advantage and disadvantage sources, matched against what is on a
 * creature: its conditions (short name before the colon, full name, source)
 * and its active custom effects (name). Grown in math_manage for wishlist
 * item 10; play report 4 shares it with grapple, which rolls an opposed check
 * on the fight's dice and needs the same vocabulary.
 *
 * Matching is matchUniqueLabel's: exact beats prefix beats substring, one hit
 * per distinct label (a condition and the feature made from it count once),
 * and two hits in the deciding tier are ambiguous. The problem texts are a
 * contract — tests match them.
 *
 * Play report 7 #7 (the owner's spec): a name grants only what DECLARES it
 * for this roll — resolveAdvantageSources. An effect declares it by a
 * mechanic (the scope grammar of src/engine/advantage-scope.ts, or the older
 * skill/save form); a standard condition by its 5e rules (poisoned,
 * frightened and exhaustion: disadvantage on checks; restrained and slowed:
 * on DEX saves; exhaustion 3+: on saves); a skillAdvantage trait for its own
 * skills (#8). A prose condition declares nothing. Anything else is refused
 * with the reason and the call that would declare it; every caller (grapple,
 * math_manage) refuses the roll before any die or write.
 */
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { matchUniqueLabel } from '../utils/match-label.js';
import { scopedMechanic, scopeCovers, rollPhrase, suggestedScope, longAbility, type RollScope, type EffectDeclaration } from './advantage-scope.js';
import { legacyAdvantageFits, legacyScopePhrase } from './effects-resolver.js';
import { CONDITION_EFFECTS, CONDITION_ALIASES, STANDARD_CONDITIONS, ConditionType } from './combat/conditions.js';
import { normSkill, type ShortAbility } from './skill-modifier.js';
import { normTag, type SkillAdvantageTrait } from './senses.js';

export type SourceKind = 'advantage' | 'disadvantage';

export interface NamedSourceOwner {
    /** Printed in the miss text: "... matches nothing in Kessa's conditions or active effects". */
    ownerName: string;
    /** Sheet and/or token conditions: {name, source}. */
    conditions: Array<{ name: string; source?: string | null }>;
    /** Active custom effect names (loadEffectNames). */
    effectNames: string[];
}

/**
 * A prose condition is named by its text up to the first colon
 * ('VAUREK: the ward-sigil…' → 'VAUREK'), as feature_from_condition does.
 */
const shortName = (text: string) => text.split(':')[0].trim().slice(0, 60) || text.slice(0, 60);

/** Each text resolved to one label, or a problem line; order is kept on both lists. */
export function resolveNamedSources(texts: readonly string[], which: SourceKind, owner: NamedSourceOwner): { labels: string[]; problems: string[] } {
    const labels: string[] = [];
    const problems: string[] = [];
    const candidates = [
        ...owner.conditions.map(c => ({ label: shortName(c.name), texts: [shortName(c.name), c.name, c.source ?? ''], value: shortName(c.name) })),
        ...owner.effectNames.map(n => ({ label: n, texts: [n], value: n }))
    ];
    for (const text of texts) {
        const t = String(text ?? '').trim().toLowerCase();
        if (!t) { problems.push(`${which} source "" is empty — nothing granted`); continue; }
        const m = matchUniqueLabel(candidates, t);
        if ('match' in m) { labels.push(m.match); continue; }
        problems.push('ambiguous' in m
            ? `${which} source "${text}" matches ${m.ambiguous.length} conditions or effects by ${m.tier} [${m.ambiguous.join(' | ')}] — use more of the text; nothing granted`
            : `${which} source "${text}" matches nothing in ${owner.ownerName}'s conditions or active effects — nothing granted`);
    }
    return { labels, problems };
}

// ─── Play report 7 #7 and #8: the declaration step ───

export interface DeclaringOwner {
    /** For the calls a refusal prints (characterId / targetId). */
    ownerId: string;
    ownerName: string;
    /** Sheet and token conditions. `on` picks the conversion call (feature_from_condition on a sheet, apply_effect for a token-only one); `level` is a token's exhaustion level. */
    conditions: Array<{ name: string; source?: string | null; level?: number; on?: 'sheet' | 'token' }>;
    /** Active effects with their mechanics (loadEffectDeclarations). */
    effects: EffectDeclaration[];
    /** The sheet's skillAdvantage traits. */
    traits?: SkillAdvantageTrait[] | null;
}

export interface GrantedSource {
    /** What the reply, the breakdown and the roll_log purpose print. */
    label: string;
    /** ENGINE: an untagged scoped mechanic (it fires by itself anyway); EFFECT: an effect's declaration; SHEET: a standard condition or a trait. */
    lane: 'ENGINE' | 'EFFECT' | 'SHEET';
    via: 'effect' | 'condition' | 'trait';
    /** The effect, condition or trait name. */
    name: string;
    /** The when-tag the grant asserts (a tagged mechanic, a trait's when). */
    tag?: string;
    /** How the tag was asserted: by the roll's context, or by naming the source (the GM asserting the circumstance holds; the label says 'named'). */
    asserted?: 'context' | 'named';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A string inside a printed call: single-quoted, or double-quoted when it holds an apostrophe ("Hunter's Mark"), so the call parses as pasted. */
export const quoteArg = (s: string) => s.includes("'") ? JSON.stringify(s) : `'${s}'`;
const article = (word: string) => /^[aeiou]/i.test(word) ? 'an' : 'a';

/** A condition's standard type ('Poisoned', 'paralysed', 'Exhaustion 3') and exhaustion level, or undefined for prose. */
function standardCondition(name: string, level?: number): { type: ConditionType; level: number } | undefined {
    const t = name.trim().toLowerCase();
    const exhausted = /^exhaust(?:ed|ion)\b\D*([1-6])?\s*\)?$/.exec(t);
    if (exhausted) return { type: ConditionType.EXHAUSTED, level: level ?? (exhausted[1] ? Number(exhausted[1]) : 1) };
    const type = (Object.values(ConditionType) as string[]).includes(t) ? t as ConditionType : CONDITION_ALIASES[t];
    if (!type) return undefined;
    // The 5e conditions, plus slowed (the Slow spell's DEX-save rule). Homebrew registry entries stay descriptive.
    if (!STANDARD_CONDITIONS.has(type) && type !== ConditionType.SLOWED) return undefined;
    return { type, level: level ?? 1 };
}

/** What a standard condition declares on this roll, and in words for a refusal. */
function conditionDeclaration(c: { type: ConditionType; level: number }, which: SourceKind, roll: RollScope): { declares: boolean; words: string[] } {
    const fx = CONDITION_EFFECTS[c.type];
    const exhausted3 = c.type === ConditionType.EXHAUSTED && c.level >= 3;
    const saveAbilities = (fx.savingThrowDisadvantageAbilities ?? []).map(a => String(a));
    const disOn: string[] = [];
    if (fx.attackDisadvantage || exhausted3) disOn.push('attacks');
    if (fx.abilityCheckDisadvantage) disOn.push('ability checks');
    if (exhausted3) disOn.push('saves');
    else if (saveAbilities.length) disOn.push(`${saveAbilities.map(a => a.slice(0, 3).toUpperCase()).join('/')} saves`);
    const words = [...(fx.attackAdvantage ? ['advantage on attacks'] : []), ...(disOn.length ? [`disadvantage on ${disOn.join(' and ')}`] : [])];
    let declares = false;
    if (which === 'advantage') declares = roll.kind === 'attack' && !!fx.attackAdvantage;
    else if (roll.kind === 'check' || roll.kind === 'grapple' || roll.kind === 'initiative') declares = !!fx.abilityCheckDisadvantage;
    else if (roll.kind === 'save') declares = exhausted3 || saveAbilities.includes(longAbility(roll.ability));
    else if (roll.kind === 'attack') declares = !!fx.attackDisadvantage || exhausted3;
    return { declares, words };
}

/**
 * What a standard condition declares, in words ('disadvantage on attacks and
 * ability checks'), or undefined for a prose condition. The reconcile
 * finding reads it: a standard condition is never converted into a feature,
 * which would take its 5e rules off the sheet.
 */
export function standardConditionRules(name: string, level?: number): string[] | undefined {
    const std = standardCondition(shortName(name), level);
    return std ? conditionDeclaration(std, 'advantage', { kind: 'initiative' }).words : undefined;
}

/**
 * Play report 7 (lane H): a token's conditions as conditionSaveDisadvantage
 * reads them: its type ('restrained') and an exhaustion level from metadata.
 * One reading for every save rolled off a token (rollParticipantSave, the
 * concentration save in a fight, the engine's end-of-turn save).
 */
export function tokenSaveConditions(conditions: ReadonlyArray<{ type: unknown; metadata?: Record<string, unknown> }> | undefined): Array<{ name: string; level?: number }> {
    return (conditions ?? []).map(c => ({ name: String(c.type), level: typeof c.metadata?.level === 'number' ? c.metadata.level : undefined }));
}

/**
 * Play report 7 (lane G1): the standard conditions' 5e rules on a save the
 * engine rolls by itself (an area, a spell, a shove, staying mounted), as the
 * disadvantage labels: restrained on DEX saves (CONDITION_EFFECTS'
 * savingThrowDisadvantageAbilities), 'exhaustion 3' (the highest level) on
 * every save. The 5e conditions only (STANDARD_CONDITIONS): slowed's DEX rule
 * is a registry entry 5e does not have (the Slow spell is a -2), so it fires
 * only when the GM names it, as a homebrew entry does. No standard condition
 * grants advantage on a save. `name` is a token's type ('restrained') or a
 * sheet condition ('Restrained: pinned', 'Exhaustion 3').
 */
export function conditionSaveDisadvantage(conditions: ReadonlyArray<{ name: string; level?: number }>, ability: ShortAbility): string[] {
    const out: string[] = [];
    let exhaustion = 0;
    for (const c of conditions) {
        const std = standardCondition(shortName(String(c?.name ?? '')), c?.level);
        if (!std || !STANDARD_CONDITIONS.has(std.type)) continue;
        if (std.type === ConditionType.EXHAUSTED) { exhaustion = Math.max(exhaustion, std.level); continue; }
        const abilities = (CONDITION_EFFECTS[std.type].savingThrowDisadvantageAbilities ?? []).map(a => String(a));
        if (abilities.includes(longAbility(ability)) && !out.includes(std.type)) out.push(std.type);
    }
    if (exhaustion >= 3) out.push(`exhaustion ${exhaustion}`);
    return out;
}

/** The refusal for a skillAdvantage trait that does not fit this roll. */
function traitProblem(t: SkillAdvantageTrait, which: SourceKind, roll: RollScope, owner: DeclaringOwner): string {
    const head = `'${t.name}' is ${owner.ownerName}'s skillAdvantage trait`;
    if (which === 'disadvantage') return `${head}: it grants advantage, not disadvantage; nothing granted`;
    const skills = t.skills.map(String);
    const of = `${head} for ${skills.join(', ')} (when: ${t.when})`;
    const call = `math_manage {action: 'roll_skill_check', characterId: ${quoteArg(owner.ownerId)}, skill: ${quoteArg(skills[0] ?? 'perception')}, context: [${quoteArg(t.when)}]}`;
    if (roll.kind === 'check' && roll.skill) {
        const phrase = rollPhrase(roll);
        return `${of}; this is ${article(phrase)} ${phrase} check, so it does not apply — on ${article(skills[0] ?? '')} ${skills.join(' or ')} check name it, or tag it: ${call}; nothing granted`;
    }
    if (roll.kind === 'check' || roll.kind === 'save') return `${of}; saves and ability checks take no skill traits — roll it as ${call}; nothing granted`;
    if (roll.kind === 'grapple') return `${of}; a grapple rolls ${roll.skills.map(s => cap(s)).join(' or ')}, so it does not apply; nothing granted`;
    return `${of}; ${rollPhrase(roll)} take no skill traits; nothing granted`;
}

type Member =
    | { kind: 'condition'; c: DeclaringOwner['conditions'][number] }
    | { kind: 'effect'; e: EffectDeclaration }
    | { kind: 'trait'; t: SkillAdvantageTrait };

/**
 * Each GM-named source resolved to what it DECLARES for this roll. Names are
 * matched as resolveNamedSources matches them (the miss, ambiguous and empty
 * texts are byte-identical), with traits as candidates too and every
 * candidate sharing a label merged (a condition kept beside the feature made
 * from it finds the feature's declaration). A hit grants when:
 *  - an effect has a `<which>_on` mechanic in the scope grammar covering this
 *    roll (a tagged one is asserted by the name: 'Horn-Lock (head-on, named)',
 *    or by context: 'Horn-Lock (head-on)'), or one in the older form whose
 *    skill/save scope fits (labelled by the effect's name, as before);
 *  - a skillAdvantage trait lists the roll's skill (a grapple's Athletics, or
 *    Acrobatics on a break): 'Keen Smell (scent, named)' — the caller applies
 *    the scene's denial and the wind as for a context tag;
 *  - a standard condition's 5e rules declare it.
 * Anything else is a problem naming the reason and the call that declares it.
 */
export function resolveAdvantageSources(texts: readonly string[], which: SourceKind, owner: DeclaringOwner, roll: RollScope, context: readonly string[] = []): { granted: GrantedSource[]; problems: string[] } {
    const granted: GrantedSource[] = [];
    const problems: string[] = [];
    const tags = new Set(context.map(normTag));
    const groups = new Map<string, { label: string; texts: string[]; members: Member[] }>();
    const add = (label: string, texts: string[], member: Member) => {
        const key = label.toLowerCase();
        const g = groups.get(key);
        if (g) { g.texts.push(...texts); g.members.push(member); }
        else groups.set(key, { label, texts: [...texts], members: [member] });
    };
    for (const c of owner.conditions) add(shortName(c.name), [shortName(c.name), c.name, c.source ?? ''], { kind: 'condition', c });
    for (const e of owner.effects) add(e.name, [e.name], { kind: 'effect', e });
    for (const t of owner.traits ?? []) if (t && typeof t.name === 'string') add(t.name, [t.name], { kind: 'trait', t });
    const candidates = [...groups.values()].map(g => ({ label: g.label, texts: g.texts, value: g }));
    const scope = suggestedScope(roll);
    const one = `{type: '${which}_on', value: '${scope}'}`;
    const oneOff = `for a one-off, use situational${cap(which)}: '<reason>'.`;
    const tagged = (name: string, tag: string): Pick<GrantedSource, 'label' | 'tag' | 'asserted'> => tags.has(normTag(tag))
        ? { label: `${name} (${tag})`, tag, asserted: 'context' }
        : { label: `${name} (${tag}, named)`, tag, asserted: 'named' };

    for (const text of texts) {
        const t = String(text ?? '').trim().toLowerCase();
        if (!t) { problems.push(`${which} source "" is empty — nothing granted`); continue; }
        const m = matchUniqueLabel(candidates, t);
        if (!('match' in m)) {
            problems.push('ambiguous' in m
                ? `${which} source "${text}" matches ${m.ambiguous.length} conditions or effects by ${m.tier} [${m.ambiguous.join(' | ')}] — use more of the text; nothing granted`
                : `${which} source "${text}" matches nothing in ${owner.ownerName}'s conditions or active effects — nothing granted`);
            continue;
        }
        const group = m.match;
        const hits: GrantedSource[] = [];
        const declares: string[] = [];
        for (const member of group.members) {
            if (member.kind === 'effect') {
                for (const mech of member.e.mechanics ?? []) {
                    const s = scopedMechanic(mech);
                    if (s) {
                        if (s.which === which && scopeCovers(s.scope, roll)) {
                            hits.push(s.tag
                                ? { ...tagged(member.e.name, s.tag), lane: 'EFFECT', via: 'effect', name: member.e.name }
                                : { label: member.e.name, lane: 'ENGINE', via: 'effect', name: member.e.name });
                        } else declares.push(`${s.which} on ${s.text}`);
                        continue;
                    }
                    const mt = (mech as { type?: unknown })?.type;
                    if (mt !== 'advantage_on' && mt !== 'disadvantage_on') continue;
                    const w: SourceKind = mt === 'advantage_on' ? 'advantage' : 'disadvantage';
                    if (w === which && legacyAdvantageFits(mech as Record<string, unknown>, roll)) hits.push({ label: member.e.name, lane: 'EFFECT', via: 'effect', name: member.e.name });
                    else declares.push(`${w} on ${legacyScopePhrase(mech as Record<string, unknown>)}`);
                }
            } else if (member.kind === 'trait') {
                const fits = which === 'advantage' && (
                    (roll.kind === 'check' && !!roll.skill && member.t.skills.some(s => normSkill(String(s)) === normSkill(roll.skill!)))
                    || (roll.kind === 'grapple' && member.t.skills.some(s => roll.skills.some(r => normSkill(String(s)) === normSkill(r)))));
                if (fits) hits.push({ ...tagged(member.t.name, member.t.when), lane: 'SHEET', via: 'trait', name: member.t.name });
            } else {
                const std = standardCondition(shortName(member.c.name), member.c.level);
                if (!std) continue;
                const d = conditionDeclaration(std, which, roll);
                // A token keeps a standard condition's type in lower case ('poisoned'); it prints as the condition's name.
                const shown = shortName(member.c.name) === shortName(member.c.name).toLowerCase() ? cap(shortName(member.c.name)) : shortName(member.c.name);
                if (d.declares) hits.push({ label: shown, lane: 'SHEET', via: 'condition', name: shown });
                else declares.push(...d.words);
            }
        }
        if (hits.length) {
            for (const h of hits) if (!granted.some(g => g.label.toLowerCase() === h.label.toLowerCase())) granted.push(h);
            continue;
        }
        // Nothing declares it: say why, and the call that would.
        const trait = group.members.find((x): x is Extract<Member, { kind: 'trait' }> => x.kind === 'trait');
        const effect = group.members.find((x): x is Extract<Member, { kind: 'effect' }> => x.kind === 'effect');
        const cond = group.members.find((x): x is Extract<Member, { kind: 'condition' }> => x.kind === 'condition');
        if (trait && !effect) { problems.push(traitProblem(trait.t, which, roll, owner)); continue; }
        const head = `'${group.label}' grants no ${which} on ${rollPhrase(roll)}${declares.length ? ` (it declares ${[...new Set(declares)].join('; ')})` : ''}.`;
        if (effect) {
            const mechs = [...(effect.e.mechanics ?? []).map(x => JSON.stringify(x)), one].join(', ');
            problems.push(`${head} To grant one, improvisation_manage edit_effect {targetId: ${quoteArg(owner.ownerId)}, name: ${quoteArg(effect.e.name)}, mechanics: [${mechs}]}; ${oneOff}`);
        } else if (cond && standardCondition(shortName(cond.c.name), cond.c.level)) {
            problems.push(`${head} Standard conditions declare only their 5e rules; ${oneOff}`);
        } else if (cond && cond.c.on === 'token') {
            problems.push(`${head} To grant one, improvisation_manage apply_effect {targetId: ${quoteArg(owner.ownerId)}, name: ${quoteArg(group.label)}, category: 'neutral', durationType: 'until_removed', mechanics: [${one}]}; ${oneOff}`);
        } else {
            problems.push(`${head} To grant one, improvisation_manage feature_from_condition {characterId: ${quoteArg(owner.ownerId)}, match: ${quoteArg(group.label)}, mechanics: [${one}]}; ${oneOff}`);
        }
    }
    return { granted, problems };
}

/** A target's active custom effects with their mechanics (none when the table is absent; malformed mechanics read as none). */
export function loadEffectDeclarations(db: Database.Database, targetId: string): EffectDeclaration[] {
    try {
        const rows = db.prepare('SELECT name, mechanics FROM custom_effects WHERE target_id = ? AND is_active = 1 ORDER BY id').all(targetId) as Array<{ name: string; mechanics: string | null }>;
        return rows.map(r => {
            let mechanics: unknown[] = [];
            try { const parsed = JSON.parse(r.mechanics || '[]'); if (Array.isArray(parsed)) mechanics = parsed; } catch { /* malformed: declares nothing */ }
            return { name: r.name, mechanics };
        });
    } catch { return []; }
}

/** The names of a target's active custom effects (none when the table is absent). */
export function loadEffectNames(db: Database.Database, targetId: string): string[] {
    try {
        return (db.prepare('SELECT name FROM custom_effects WHERE target_id = ? AND is_active = 1').all(targetId) as Array<{ name: string }>).map(r => r.name);
    } catch { return []; }
}

/** A JSON string arrives as the value it encodes; anything else passes through. */
export const jsonIfString = (v: unknown) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; };

const DEFAULT_PROBLEM_NOTE = "Play report 7: a name that matches nothing, matches two things, or declares nothing for this roll REFUSES the roll (writes: 'none') with the reason and the call that would declare it. Logged in the roll's purpose.";

/**
 * The schema field for advantageSources / disadvantageSources. A factory: an
 * outer mirror must never hold one zod instance twice. `problemNote` is what
 * a problem means for the calling tool.
 */
export const sourcesField = (what: string, problemNote: string = DEFAULT_PROBLEM_NOTE) => z.preprocess(jsonIfString, z.array(z.string())).optional()
    .describe(`Wishlist item 10: names that grant ${what} — each must match exactly one of the character's conditions (name or source), active effects (name) or skillAdvantage traits (name), case-insensitive substring, AND declare it for this roll (play report 7): an effect with a ${what === 'advantage' ? 'advantage_on' : 'disadvantage_on'} mechanic whose scope covers the roll (naming a tagged one asserts its tag: 'Horn-Lock (head-on, named)'), a standard condition's 5e rule, or a trait listing the skill. A prose condition declares nothing: convert it with improvisation_manage feature_from_condition. ${problemNote}`);

/**
 * Play report 7 #7 (lane F): a roll's tags (['head-on']), for the attack's
 * context and the initiative context on create and add_participant. A
 * factory, as above; a bare string is one tag and a JSON string of an array
 * is read as the array. `describe` says what the tags fire for the caller.
 */
export const tagsField = (describe: string) => z.preprocess(v => { const p = jsonIfString(v); return typeof p === 'string' ? [p] : p; }, z.array(z.string().min(1))).optional()
    .describe(describe);

/**
 * Play report 7 #7: situationalAdvantage / situationalDisadvantage — the
 * GM's own ruling with its reason, for a one-off. A factory, as above.
 */
export const situationalField = (which: SourceKind) => z.string().trim().min(1).optional()
    .describe(`Play report 7: the GM's own ruling, with its reason ('downhill', 'the Choir sings'): this roll takes ${which}, logged as ${which} (GM: <reason>) in the roll's purpose and the reply. For a one-off; anything lasting is declared on an effect (a ${which}_on mechanic). ${which === 'advantage' ? 'advantage' : 'disadvantage'}: true still works and is logged as GM`);
