/**
 * Match a GM-typed name against a set of labelled candidates, most specific
 * first: an exact text, then a text that starts with the query, then one that
 * contains it. The first tier with any hit decides, so "Blessed" names the
 * effect "Blessed" even when "Blessed by Nurgle" is also on the sheet. Each
 * candidate may be known by several texts (a condition's short name, full
 * name and source); candidates count once per distinct label, ignoring case.
 */
export type MatchTier = 'exact' | 'prefix' | 'substring';

export interface LabelCandidate<T> {
    label: string;
    texts: string[];
    value: T;
}

export type LabelMatch<T> =
    | { tier: MatchTier; match: T }
    | { tier: MatchTier; ambiguous: string[] }
    | { none: true };

const TIERS: Array<[MatchTier, (text: string, q: string) => boolean]> = [
    ['exact', (t, q) => t === q],
    ['prefix', (t, q) => t.startsWith(q)],
    ['substring', (t, q) => t.includes(q)]
];

export function matchUniqueLabel<T>(candidates: Array<LabelCandidate<T>>, query: string): LabelMatch<T> {
    const q = query.trim().toLowerCase();
    if (!q) return { none: true };
    for (const [tier, test] of TIERS) {
        const hits = new Map<string, LabelCandidate<T>>();
        for (const c of candidates) {
            const key = c.label.toLowerCase();
            if (hits.has(key)) continue;
            if (c.texts.some(t => test((t ?? '').toLowerCase(), q))) hits.set(key, c);
        }
        if (hits.size === 1) return { tier, match: [...hits.values()][0].value };
        if (hits.size > 1) return { tier, ambiguous: [...hits.values()].map(h => h.label) };
    }
    return { none: true };
}
