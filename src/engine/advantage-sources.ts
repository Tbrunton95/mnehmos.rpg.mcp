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
 * contract — tests match them — and the caller decides what a problem means:
 * math_manage warns and rolls anyway; grapple refuses before anything is
 * spent, because a grapple writes.
 */
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { matchUniqueLabel } from '../utils/match-label.js';

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

/** The names of a target's active custom effects (none when the table is absent). */
export function loadEffectNames(db: Database.Database, targetId: string): string[] {
    try {
        return (db.prepare('SELECT name FROM custom_effects WHERE target_id = ? AND is_active = 1').all(targetId) as Array<{ name: string }>).map(r => r.name);
    } catch { return []; }
}

/** A JSON string arrives as the value it encodes; anything else passes through. */
export const jsonIfString = (v: unknown) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; };

const DEFAULT_PROBLEM_NOTE = "A miss or an ambiguous match is refused and grants nothing. Logged in the roll's purpose.";

/**
 * The schema field for advantageSources / disadvantageSources. A factory: an
 * outer mirror must never hold one zod instance twice. `problemNote` is what
 * a miss means for the calling tool (math_manage's default: warned, the roll
 * still happens).
 */
export const sourcesField = (what: string, problemNote: string = DEFAULT_PROBLEM_NOTE) => z.preprocess(jsonIfString, z.array(z.string())).optional()
    .describe(`Wishlist item 10: names that grant ${what} — each must match exactly one of the character's conditions (name or source) or active effects (name), case-insensitive substring. ${problemNote}`);
