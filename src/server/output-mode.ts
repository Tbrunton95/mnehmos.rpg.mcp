/**
 * output_mode: 'summary' — a small reply for chairs whose context is precious.
 * Keeps the result's scalar fields and short lists, and replaces anything
 * large (a 40 KB condition list, a full sheet's arrays) with its size —
 * except the handles. An oversized object keeps its id-like keys and a short
 * name beside `_keys`; an oversized list of id-bearing rows keeps those
 * handles per row, 25 rows a list and 50 a reply, the remainder counted as
 * `{_more}` (play report 2, #13). Lists and objects without a handle still
 * collapse to '[N items]' / '{N keys}'.
 */
import { replyData, replyJson, splitEmbed, splitOpLine } from './reply-status.js';
import { RichFormatter } from './utils/formatter.js';

const MAX_STRING = 300;
const MAX_INLINE = 200;
/** Rows of handles kept from one id-bearing list. */
const MAX_ID_ROWS = 25;
/** Rows of handles kept across one reply, nested lists included. */
const MAX_ID_ROWS_PER_REPLY = 50;
/** A top-level `…Ids` list of scalars keeps this many. */
const MAX_ID_SCALARS = 50;
/** A `name` longer than this is text, not a handle. */
const MAX_NAME = 80;

const ID_KEY = /^(id|[a-z][A-Za-z0-9]*Id|[a-z][a-z0-9_]*_id)$/;
const IDS_KEY = /Ids$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: unknown): boolean => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const hasIdKey = (o: Record<string, unknown>): boolean => Object.entries(o).some(([k, v]) => ID_KEY.test(k) && isScalar(v));

/** The handles of an object: its id-like scalars, and its name when short. */
function idView(o: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (ID_KEY.test(k) && isScalar(v)) out[k] = v;
    if (typeof o.name === 'string' && o.name.length <= MAX_NAME) out.name = o.name;
    return out;
}

/** What is left of the reply's row budget while one summary is built. */
type Budget = { rows: number };

/**
 * An oversized list: the handles of each row when any row carries an id key,
 * capped by the list and the reply budgets with the remainder counted;
 * undefined when the list has no id-bearing row.
 */
function idRows(arr: unknown[], budget: Budget): unknown[] | string | undefined {
    const objs = arr.filter(isPlainObject);
    if (!objs.some(hasIdKey)) return undefined;
    if (budget.rows <= 0) return `[${arr.length} items]`;
    const take = Math.min(MAX_ID_ROWS, budget.rows, objs.length);
    budget.rows -= take;
    const rows: unknown[] = objs.slice(0, take).map(idView);
    if (arr.length > take) rows.push({ _more: arr.length - take });
    return rows;
}

function shrink(value: unknown, budget: Budget): unknown {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
    if (Array.isArray(value)) {
        const inline = JSON.stringify(value);
        if (inline.length <= MAX_INLINE) return value;
        return idRows(value, budget) ?? `[${value.length} items]`;
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const inline = JSON.stringify(obj);
        if (inline.length <= MAX_INLINE) return obj;
        const n = Object.keys(obj).length;
        const handles = idView(obj);
        if (Object.keys(handles).length) return { ...handles, _keys: n };
        // One level down: an object of id-bearing lists (session find's results).
        const inner: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
            if (!Array.isArray(v)) continue;
            const rows = idRows(v, budget);
            if (rows !== undefined) inner[k] = rows;
        }
        if (Object.keys(inner).length) return { ...inner, _keys: n };
        return `{${n} keys}`;
    }
    return undefined;
}

/** A top-level `…Ids` (or id-named) list of scalars: kept whole up to 50, then counted. */
function idScalars(k: string, v: unknown): unknown[] | undefined {
    if (!Array.isArray(v) || !(IDS_KEY.test(k) || ID_KEY.test(k)) || !v.every(isScalar)) return undefined;
    return v.length <= MAX_ID_SCALARS ? v : [...v.slice(0, MAX_ID_SCALARS), { _more: v.length - MAX_ID_SCALARS }];
}

export function summarizeResult(result: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const budget: Budget = { rows: MAX_ID_ROWS_PER_REPLY };
    for (const [k, v] of Object.entries(result)) {
        const s = idScalars(k, v) ?? shrink(v, budget);
        if (s !== undefined) out[k] = s;
    }
    return out;
}

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
 * fields: [...] — only the named fields, plus success/error/actionType/message
 * and ignoredParams (play report 4 #2: a dropped key must not vanish because
 * the chair asked for two fields).
 * A dotted name walks the full path ('world.environment.weather'); through a
 * list it keeps that path of each element ('conditions.name'). Several names
 * on one head merge. An undotted name takes the whole value.
 * A name that matches nothing is reported in `fieldsNotFound`, with the
 * reply's top-level keys in `availableFields`, so a miss never reads as a
 * bare success.
 */
export function pickFields(result: Record<string, unknown>, fields: string[]): Record<string, unknown> {
    const always = ['success', 'error', 'actionType', 'message', 'ignoredParams'];
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

const IGNORED_NOTE = /Ignored params/;

/**
 * Play report 4 #2: the action router puts `ignoredParams` (and the note in
 * `message`) on the reply's data, but most banners never print `message`, so
 * a chair reading the banner still saw a clean success. One warning line goes
 * in before the embed when the banner lacks it — the note from `message` when
 * it carries one, else the bare key list. Bare-JSON replies already show the
 * field; prose and error replies are left alone.
 */
export function noteIgnoredParams<R extends Reply>(res: R): R {
    const text = res?.content?.[0]?.text;
    if (!text) return res;
    const data = replyJson(text);
    const ignored = data?.ignoredParams;
    if (!Array.isArray(ignored) || ignored.length === 0) return res;
    const parts = splitEmbed(text);
    if (!parts || IGNORED_NOTE.test(parts.before)) return res;
    const message = typeof data?.message === 'string' ? data.message : '';
    const at = message.indexOf('Ignored params');
    const note = at >= 0 ? message.slice(at) : `Ignored params (nothing was written for them): ${ignored.map(String).join(', ')}`;
    const banner = `${parts.before.replace(/\n*$/, '\n')}${RichFormatter.alert(note, 'warning')}\n`;
    return { ...res, content: [{ ...res.content![0], text: `${banner}${parts.embed}${parts.after}` }, ...res.content!.slice(1)] };
}

/**
 * Apply output_mode / fields to a tool reply. The data comes from the
 * reply's `<!-- X_JSON -->` embed; a tool that replies with bare JSON (no
 * embed, text starting with '{') is read as-is, so fields and summary work
 * there too. Anything else — prose, a parse failure — comes back untouched.
 * The operation guard's line on top of the reply ('op v1 applied',
 * 'REPLAYED …', 'NOT applied …') rides along as `_op`, so the opId's fate
 * survives output_mode; without one, json mode is the embed byte for byte.
 */
export function shapeReply<R extends Reply>(res: R, opts: { mode?: unknown; fields?: string[] }): R {
    const { mode, fields } = opts;
    const wantJson = mode === 'json' && !fields;
    const wantSummary = mode === 'summary' || !!fields;
    const text = res?.content?.[0]?.text;
    if (!(wantJson || wantSummary) || !text) return res;
    const { op } = splitOpLine(text);
    const data = replyData(text);
    if (data === null) return res;
    const { body, embedded } = data;
    if (wantJson && !op) return embedded ? { ...res, content: [{ type: 'text', text: body }] } : res;
    try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const shaped = wantJson ? parsed : fields ? pickFields(parsed, fields) : summarizeResult(parsed);
            const withOp = op ? { _op: op, ...shaped } : shaped;
            return { ...res, content: [{ type: 'text', text: JSON.stringify(withOp) }] };
        }
    } catch { /* not JSON: fall through to the full reply */ }
    return res;
}
