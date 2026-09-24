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
