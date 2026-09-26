/**
 * output_mode: 'summary' — a small reply for chairs whose context is precious.
 * Keeps the result's scalar fields and short lists, and replaces anything
 * large (a 40 KB condition list, a full sheet's arrays) with its size.
 */
const MAX_STRING = 300;
const MAX_INLINE = 200;

function shrink(value: unknown): unknown {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
    if (Array.isArray(value)) {
        const inline = JSON.stringify(value);
        return inline.length <= MAX_INLINE ? value : `[${value.length} items]`;
    }
    if (typeof value === 'object') {
        const inline = JSON.stringify(value);
        return inline.length <= MAX_INLINE ? value : `{${Object.keys(value as object).length} keys}`;
    }
    return undefined;
}

export function summarizeResult(result: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result)) {
        const s = shrink(v);
        if (s !== undefined) out[k] = s;
    }
    return out;
}

/**
 * fields: [...] — only the named top-level fields, plus success/error/actionType/message.
 * A dotted name projects one level in: 'conditions.name' keeps just `name` of
 * each element when `conditions` is a list, or of the object itself. Several
 * dotted names on one head merge ('conditions.name', 'conditions.pinned').
 * An undotted name still takes the whole value.
 */
export function pickFields(result: Record<string, unknown>, fields: string[]): Record<string, unknown> {
    const keep = new Set(['success', 'error', 'actionType', 'message']);
    const sub = new Map<string, string[]>();
    for (const f of fields) {
        const dot = f.indexOf('.');
        if (dot <= 0) { keep.add(f); continue; }
        const head = f.slice(0, dot);
        sub.set(head, [...(sub.get(head) ?? []), f.slice(dot + 1)]);
    }
    const project = (v: unknown, keys: string[]): unknown => {
        if (!v || typeof v !== 'object') return v;
        const o = v as Record<string, unknown>;
        return Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
    };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result)) {
        if (keep.has(k)) out[k] = v;
        else if (sub.has(k)) out[k] = Array.isArray(v) ? v.map(e => project(e, sub.get(k)!)) : project(v, sub.get(k)!);
    }
    return out;
}

type Reply = { content?: Array<{ type: string; text: string }> };

/**
 * Apply output_mode / fields to a tool reply. The data comes from the
 * reply's `<!-- X_JSON -->` embed; a tool that replies with bare JSON (no
 * embed, text starting with '{') is read as-is, so fields and summary work
 * there too. Anything else — prose, a parse failure — comes back untouched.
 */
export function shapeReply<R extends Reply>(res: R, opts: { mode?: unknown; fields?: string[] }): R {
    const { mode, fields } = opts;
    const wantJson = mode === 'json' && !fields;
    const wantSummary = mode === 'summary' || !!fields;
    const text = res?.content?.[0]?.text;
    if (!(wantJson || wantSummary) || !text) return res;
    const m = text.match(/<!--\s*([A-Z_]*JSON)\s*\n?([\s\S]*?)\n?\1\s*-->/);
    const body = m ? m[2].trim() : text.trimStart().startsWith('{') ? text.trim() : null;
    if (body === null) return res;
    if (wantJson) return m ? { ...res, content: [{ type: 'text', text: body }] } : res;
    // summary: the result's small fields only; big lists become counts.
    try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const shaped = fields ? pickFields(parsed, fields) : summarizeResult(parsed);
            return { ...res, content: [{ type: 'text', text: JSON.stringify(shaped) }] };
        }
    } catch { /* not JSON: fall through to the full reply */ }
    return res;
}
