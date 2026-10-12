/**
 * How a tool reply reads to the operation guard, the audit log and output
 * shaping: one place that knows where a reply keeps its data and which of
 * its fields mean "nothing happened".
 *
 * Two error conventions coexist in the tools. Handlers and formatMcpError
 * say `error: true`; the action router's validation and unknown-action
 * replies say `error: 'validation_error'` or `error: 'invalid_action'`.
 * Both mean the call did nothing that should persist. `success: false`
 * without an error means the call wrote and part of it failed (a
 * non-atomic batch, a mover defeated by a reaction, a failed arcana check),
 * so it is NOT an error here. `writes: 'none'` on a non-error reply is a
 * refusal or a preview that wrote nothing.
 */
export type ReplyOutcome = 'error' | 'no_write' | 'applied';

export type ReplyLike = { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;

const EMBED = /<!--\s*([A-Z_]*JSON)\s*\n?([\s\S]*?)\n?\1\s*-->/;

/**
 * The operation guard's own first line, and only that: `▌ op <id> applied`,
 * `▌ op <id> NOT applied …`, `▌ op <id>: nothing written …`,
 * `▌ ↺ REPLAYED …`, `▌ ✖ REFUSED …`. Tool banners also draw `▌ ` rail
 * lines (status block, contact card), so the anchor is the guard's words,
 * not the glyph.
 */
const OP_LINE = /^▌ ((?:op |↺ REPLAYED|✖ REFUSED)[^\n]*)\n?/;

/** Lift the guard's line off the front of a reply text, when it is there. */
export function splitOpLine(text: string): { op?: string; rest: string } {
    const m = text.match(OP_LINE);
    return m ? { op: m[1].trim(), rest: text.slice(m[0].length) } : { rest: text };
}

/**
 * The text of the reply's data: the first `<!-- X_JSON -->` embed
 * (`embedded: true`), else the whole text when it is bare JSON (starts with
 * '{'); null when neither. A leading guard line is skipped.
 */
export function replyData(text: string | undefined): { body: string; embedded: boolean } | null {
    if (!text) return null;
    const { rest } = splitOpLine(text);
    const m = rest.match(EMBED);
    if (m) return { body: m[2].trim(), embedded: true };
    const bare = rest.trim();
    return bare.startsWith('{') ? { body: bare, embedded: false } : null;
}

/**
 * Where the reply's first embed sits: the text before it, the embed itself
 * and what follows. Null when the reply has no embed (bare JSON, prose).
 */
export function splitEmbed(text: string): { before: string; embed: string; after: string } | null {
    const m = text.match(EMBED);
    if (!m || m.index === undefined) return null;
    return { before: text.slice(0, m.index), embed: m[0], after: text.slice(m.index + m[0].length) };
}

/** replyData's body alone. */
export function replyBody(text: string | undefined): string | null {
    return replyData(text)?.body ?? null;
}

/** The reply's data as a plain object, or null when there is none or it does not parse. */
export function replyJson(text: string | undefined): Record<string, unknown> | null {
    const body = replyBody(text);
    if (body === null) return null;
    try {
        const parsed = JSON.parse(body);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
}

/**
 * 'error' when the reply is flagged isError, or its top-level `error` is true
 * or a non-empty string; 'no_write' when it says writes: 'none'; 'applied'
 * otherwise (prose and unparsable replies included: the guard keeps what a
 * call it cannot read wrote, as it always did).
 */
export function replyOutcome(res: ReplyLike): ReplyOutcome {
    if (res?.isError === true) return 'error';
    const parsed = replyJson(res?.content?.[0]?.text);
    if (!parsed) return 'applied';
    const err = parsed.error;
    if (err === true || (typeof err === 'string' && err !== '')) return 'error';
    if (parsed.writes === 'none') return 'no_write';
    return 'applied';
}
