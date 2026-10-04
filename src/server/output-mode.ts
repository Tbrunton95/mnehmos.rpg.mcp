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

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Walk `parts` into `v`, keeping only what the path touches. A list maps the
 * walk over its elements. `hit.found` flips when the path reaches a value
 * anywhere; an element that lacks the key projects to {} as before.
 */
function pluck(v: unknown, parts: string[], hit: { found: boolean }): unknown {
    if (parts.length === 0) { hit.found = true; return v; }
    if (Array.isArray(v)) {
        if (v.length === 0) hit.found = true;
        return v.map(e => pluck(e, parts, hit));
    }
    if (!isPlainObject(v)) return undefined;
    const [k, ...rest] = parts;
    if (!(k in v)) return {};
    const inner = pluck(v[k], rest, hit);
    return inner === undefined ? {} : { [k]: inner };
}

/** Merge two projections of the same head ('world.name' with 'world.environment.weather'). */
function mergeProjection(a: unknown, b: unknown): unknown {
    if (a === undefined) return b;
    if (b === undefined) return a;
    if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => mergeProjection(x, b[i]));
    if (isPlainObject(a) && isPlainObject(b)) {
        const out: Record<string, unknown> = { ...a };
        for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeProjection(out[k], v) : v;
        return out;
    }
    return a;
}

/**
 * fields: [...] — only the named fields, plus success/error/actionType/message.
 * A dotted name walks the full path ('world.environment.weather'); through a
 * list it keeps that path of each element ('conditions.name'). Several names
 * on one head merge. An undotted name takes the whole value.
 * A name that matches nothing is reported in `fieldsNotFound`, with the
 * reply's top-level keys in `availableFields`, so a miss never reads as a
 * bare success.
 */
export function pickFields(result: Record<string, unknown>, fields: string[]): Record<string, unknown> {
    const always = ['success', 'error', 'actionType', 'message'];
    const out: Record<string, unknown> = {};
    for (const k of always) if (k in result) out[k] = result[k];

    const picked: Record<string, unknown> = {};
    const notFound: string[] = [];
    for (const f of fields) {
        const parts = f.split('.').filter(p => p !== '');
        if (parts.length === 0) continue;
        const [head, ...rest] = parts;
        if (!(head in result)) { notFound.push(f); continue; }
        if (rest.length === 0) { picked[head] = result[head]; continue; }
        const hit = { found: false };
        const projection = pluck(result[head], rest, hit);
        if (!hit.found || projection === undefined) { notFound.push(f); continue; }
        picked[head] = mergeProjection(picked[head], projection);
    }
    // Keep the reply's own key order for the fields that matched.
    for (const k of Object.keys(result)) if (k in picked && !(k in out)) out[k] = picked[k];
    if (notFound.length) {
        out.fieldsNotFound = notFound;
        out.availableFields = Object.keys(result);
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
