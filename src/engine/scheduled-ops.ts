/**
 * The ordered write list: the ops a mend clock applies when it fires, and
 * that a table entry or an offering applies at once. Every op clamps exactly
 * as its live verb does. Pure: returns the applied lines and the sheet
 * updates; the caller writes them through the character repository (the
 * shared commit step in server/scheduled-commit.ts also replays part ops
 * onto live tokens).
 */
import { z } from 'zod';
import { stripDyingRowConditions, type RowCondition } from './combat/dying.js';
import { PART_KINDS, PART_STATES, type Part } from '../schema/token-extras.js';
import { setPartOn, removePartFrom, type PartWrite } from './combat/parts.js';

/**
 * Play report 6 #3: the part states a clock can set. latched is left out: a
 * clock has no participant to hold, so it is refused at the schema and, for
 * a row written by hand, skipped at fire time.
 */
export const SCHEDULED_PART_STATES = PART_STATES.filter(s => s !== 'latched') as ReadonlyArray<Exclude<Part['state'], 'latched'>>;

/**
 * Play report 6 #2: the write grammar in one line, for every message that
 * refuses a malformed op. The GM saw "Validation failed for action montage"
 * and nothing else; a refusal now says what shape was wanted and shows one.
 */
/** The montage costs example every shape message ends on: a plain string is a note there. */
export const MONTAGE_COSTS_EXAMPLE = "costs: {hardWon: ['Varek loses the trail for a day'], costly: [{op: 'adjust_hp', delta: -4}, 'a Gor is wounded']}";
export const SCHEDULED_OP_SHAPE = `each write is {op: 'adjust_pool', pool, delta, max?} | {op: 'adjust_hp' | 'adjust_max_hp', delta} | {op: 'add_condition', name, duration?, source?} | {op: 'remove_condition', name} | {op: 'note', text} | {op: 'set_part', part, state, kind?, hp?, maxHp?, ac?, holds?, note?, breakAt?} | {op: 'remove_part', part} (a note prints its text when it fires and changes nothing), e.g. writes: [{op: 'adjust_hp', delta: -4}, {op: 'note', text: 'the arm has healed'}]; montage costs also take a plain string as a note: ${MONTAGE_COSTS_EXAMPLE}`;

/** A Zod `received` as prose: 'a string', 'an array', 'null', 'nothing'. */
export const describeReceived = (received: string) =>
    received === 'undefined' ? 'nothing' : received === 'null' ? 'null' : /^[aeiou]/.test(received) ? `an ${received}` : `a ${received}`;
const opErrorMap: z.ZodErrorMap = (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.invalid_enum_value) return { message: `unknown op '${String(issue.received)}' — ${SCHEDULED_OP_SHAPE}` };
    if (issue.code === z.ZodIssueCode.invalid_type) return { message: `${issue.received === 'undefined' ? 'op is required' : `op is a name, not ${describeReceived(issue.received)}`} — ${SCHEDULED_OP_SHAPE}` };
    return { message: ctx.defaultError };
};
const writeErrorMap: z.ZodErrorMap = (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.invalid_type) return { message: `a write is an object, not ${describeReceived(issue.received)} — ${SCHEDULED_OP_SHAPE}` };
    return { message: ctx.defaultError };
};
const noteTextErrorMap: z.ZodErrorMap = (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.invalid_type) return { message: `note text is a string, not ${describeReceived(issue.received)} — {op: 'note', text: 'the arm has healed'}` };
    return { message: ctx.defaultError };
};

/** A fresh schema each call, so no outer schema holds one zod instance twice. */
export function scheduledWriteOpSchema() {
    return z.object({
        op: z.enum(['adjust_pool', 'adjust_hp', 'adjust_max_hp', 'add_condition', 'remove_condition', 'note', 'set_part', 'remove_part'], { errorMap: opErrorMap }),
        pool: z.string().optional().describe('Pool name (adjust_pool)'),
        delta: z.number().optional().describe('Delta (adjust_pool / adjust_hp / adjust_max_hp)'),
        max: z.number().optional().describe('Pool max update (adjust_pool)'),
        name: z.string().optional().describe('Condition name (add_condition / remove_condition)'),
        duration: z.number().optional().describe('Condition duration (add_condition)'),
        source: z.string().optional().describe('Condition source (add_condition; default "mend clock")'),
        text: z.string({ errorMap: noteTextErrorMap }).optional().describe('Note text (note): printed when the op fires and journaled by a montage; nothing on the sheet changes'),
        // Play report 6 #3: body parts. A set_part merges into the sheet's
        // part of that name (fields left out survive) and replays onto every
        // live token when the write commits; remove_part takes it off both.
        part: z.string().optional().describe("Part name (set_part / remove_part): 'left arm'; matches the sheet's and the token's part case-insensitively, adds it when absent"),
        state: z.enum(PART_STATES).exclude(['latched']).optional().describe('Part state (set_part): intact | crippled | dead | breached. latched cannot be scheduled (a clock has no participant to hold; use combat_manage set_part)'),
        kind: z.enum(PART_KINDS).optional().describe("Part kind (set_part): head | arm | leg | wing | torso | system | other; defaults to the part's current kind, else other"),
        hp: z.number().int().min(0).optional().describe('Part HP (set_part); maxHp defaults to hp when first set'),
        maxHp: z.number().int().min(1).optional().describe('Part max HP (set_part)'),
        ac: z.number().int().min(0).optional().describe('AC to hit the part when aimed at (set_part); omit to keep'),
        holds: z.array(z.string()).optional().describe("Weapons or slots the part wields (set_part): ['claw']; omit to keep"),
        note: z.string().optional().describe('Part note (set_part); omit to keep'),
        breakAt: z.number().int().min(1).optional().describe('One aimed hit of at least this much severs the part (set_part); omit to keep')
    }, { errorMap: writeErrorMap });
}

export type ScheduledWriteOp = z.infer<ReturnType<typeof scheduledWriteOpSchema>>;

/** The op names, for the unknown-op line and the op-like-text warning. */
const SCHEDULED_OPS: readonly string[] = scheduledWriteOpSchema().shape.op.options;
const WRITE_OP_NAMES = SCHEDULED_OPS.filter(o => o !== 'note');
const OP_LIKE_TEXT = new RegExp(`^(${WRITE_OP_NAMES.join('|')})\\b\\s*(.*)$`, 'i');
const OP_NAME_INSIDE = new RegExp(`\\b(${WRITE_OP_NAMES.join('|')})\\b`, 'i');
const OP_FIELD_WORDS = /\b(op|pool|delta|max|name|duration|source|text|part|state|kind|hp|maxHp|ac|holds|note|breakAt)\b/gi;

/**
 * Play report 6 #2: a note whose text starts with an op name ('adjust_hp -6',
 * 'Set_part left arm intact') was probably meant as a write, and so was a
 * braced string naming an op that is not JSON ('{"op":"adjust_hp","delta":-4'
 * with its bracket lost, or a JS literal in quotes). Returns the object form
 * it should take, or undefined when the text reads as prose.
 */
function opLikeText(text: string): { form: string; braced: boolean } | undefined {
    const t = text.trim();
    let name: string, rest: string, braced = false;
    const m = OP_LIKE_TEXT.exec(t);
    if (m) {
        name = m[1].toLowerCase(); rest = m[2];
    } else if (/^[[{]/.test(t)) {
        const inside = OP_NAME_INSIDE.exec(t);
        if (!inside) return undefined;
        name = inside[1].toLowerCase();
        braced = true;
        // What is left once the brackets, quotes, the op name and the field names go: the values.
        rest = t.replace(/[[\]{}"'`,:]/g, ' ').replace(new RegExp(`\\b${name}\\b`, 'gi'), ' ').replace(OP_FIELD_WORDS, ' ').replace(/\s+/g, ' ').trim();
    } else return undefined;
    const num = /-?\d+/.exec(rest);
    const delta = num ? num[0] : '<n>';
    const words = rest.replace(/-?\d+/g, '').replace(/\s+/g, ' ').trim();
    const quoted = (s: string, fallback: string) => `'${s || fallback}'`;
    let form: string;
    switch (name) {
        case 'adjust_pool': form = `{op: 'adjust_pool', pool: ${quoted(words.split(' ')[0], '<pool>')}, delta: ${delta}}`; break;
        case 'adjust_hp':
        case 'adjust_max_hp': form = `{op: '${name}', delta: ${delta}}`; break;
        case 'add_condition':
        case 'remove_condition': form = `{op: '${name}', name: ${quoted(words, '<condition>')}}`; break;
        case 'set_part': {
            // 'set_part left arm intact': a trailing state is the state, the rest is the part.
            const ws = words.split(' ').filter(Boolean);
            const last = ws[ws.length - 1]?.toLowerCase();
            let state: string | undefined;
            if (last && (SCHEDULED_PART_STATES as readonly string[]).includes(last)) { ws.pop(); state = last; }
            form = `{op: 'set_part', part: ${quoted(ws.join(' '), '<part>')}, state: ${state ? `'${state}'` : SCHEDULED_PART_STATES.map(s => `'${s}'`).join(' | ')}}`;
            break;
        }
        case 'remove_part': form = `{op: 'remove_part', part: ${quoted(words, '<part>')}}`; break;
        default: form = `{op: '${name}', …}`;
    }
    return { form, braced };
}

/** A part op that reached the sheet (or would reach a token), with the index of its applied line. */
export interface ScheduledPartOp { op: ScheduledWriteOp; line: number }

export interface ScheduledOpsResult {
    applied: string[];
    updates: Record<string, unknown>;
    /**
     * Play report 6 #3: the set_part / remove_part ops to replay onto live
     * tokens, in order. The commit step rewrites applied[line] with the
     * encounters it reached.
     */
    partOps: ScheduledPartOp[];
}

type PoolLike = { current: number; max: number; history?: unknown[]; [k: string]: unknown };

/** Pool history keeps this many entries. */
export const POOL_HISTORY_CAP = 20;

/** Append a history entry to a pool, keeping the last 20. */
export function pushPoolHistory(pool: PoolLike, entry: Record<string, unknown>): void {
    pool.history = (pool.history ?? []).concat([{ at: new Date().toISOString(), ...entry }]).slice(-POOL_HISTORY_CAP);
}

/** A set_part op whose part and state are present. */
export type ScheduledSetPart = ScheduledWriteOp & { op: 'set_part'; part: string; state: NonNullable<ScheduledWriteOp['state']> };

/** The part fields of a set_part op, as setPartOn takes them (the commit step replays the same write onto tokens). */
export function scheduledPartWrite(op: ScheduledSetPart): PartWrite {
    return {
        part: op.part,
        state: op.state,
        ...(op.kind !== undefined ? { kind: op.kind } : {}),
        ...(op.note !== undefined ? { note: op.note } : {}),
        ...(op.holds !== undefined ? { holds: op.holds } : {}),
        ...(op.ac !== undefined ? { ac: op.ac } : {}),
        ...(op.hp !== undefined ? { hp: op.hp } : {}),
        ...(op.maxHp !== undefined ? { maxHp: op.maxHp } : {}),
        ...(op.breakAt !== undefined ? { breakAt: op.breakAt } : {})
    };
}

/**
 * Play report 6 #3 (review): the field an op must carry to do anything when
 * it fires, or undefined when it is complete. A clock is the deferred case:
 * a row that would only print '⚠ … skipped' days from now is a mistake best
 * refused before the insert (FINDINGS #82, refuse-not-fake), so
 * schedule_change asks this of every op. Blank strings count as missing.
 * Immediate roads (montage, tables) keep the skipped line: they report at
 * once.
 */
export function scheduledOpMissing(op: ScheduledWriteOp): string | undefined {
    const blank = (v: unknown) => typeof v !== 'string' || v.trim() === '';
    switch (op.op) {
        case 'adjust_pool': return blank(op.pool) ? "adjust_pool needs pool (the pool's name)" : undefined;
        case 'add_condition':
        case 'remove_condition': return blank(op.name) ? `${op.op} needs name (the condition's name)` : undefined;
        case 'set_part': {
            const missing = [...(blank(op.part) ? ['part'] : []), ...(!op.state ? ['state'] : [])];
            if (!missing.length) return undefined;
            return `set_part needs ${missing.join(' and ')} (${missing.map(m => m === 'part' ? "the part's name" : 'intact | crippled | dead | breached').join('; ')})`;
        }
        case 'remove_part': return blank(op.part) ? "remove_part needs part (the part's name)" : undefined;
        case 'note': return blank(op.text) ? 'note needs text' : undefined;
        default: return undefined;
    }
}

/**
 * Apply ops in order. defaultSource names a condition's source when the op
 * gives none (default 'mend clock'); reason, when given, is written to the
 * history of every pool an adjust_pool op moves.
 */
export function applyScheduledOps(
    char: { hp: number; maxHp: number },
    ops: ScheduledWriteOp[],
    opts: { defaultSource?: string; reason?: string } = {}
): ScheduledOpsResult {
    const applied: string[] = [];
    const pools: Record<string, PoolLike> = { ...((char as { resourcePools?: Record<string, PoolLike> }).resourcePools || {}) };
    let conditions = [...(((char as { conditions?: Array<{ name: string; duration?: number; source?: string }> }).conditions) || [])];
    let parts: Part[] = [...((char as { parts?: Part[] }).parts ?? [])];
    const partOps: ScheduledPartOp[] = [];
    let hp = char.hp, maxHp = char.maxHp;
    let poolsTouched = false, condsTouched = false, hpTouched = false, maxHpTouched = false, partsTouched = false;
    for (const op of ops) {
        switch (op.op) {
            case 'adjust_pool': {
                if (!op.pool) { applied.push('⚠ adjust_pool op missing pool name — skipped'); break; }
                const existing = pools[op.pool] || { current: 0, max: op.max ?? 100 };
                const pmax = op.max ?? existing.max;
                const before = existing.current;
                const current = Math.min(pmax, Math.max(0, before + (op.delta ?? 0)));
                pools[op.pool] = { ...existing, current, max: pmax };
                if (opts.reason) pushPoolHistory(pools[op.pool], { from: before, to: current, delta: op.delta ?? 0, reason: opts.reason });
                poolsTouched = true;
                applied.push(`${op.pool}: ${before} → ${current} (of ${pmax})`);
                break;
            }
            case 'adjust_hp': {
                const before = hp;
                hp = Math.min(maxHp, Math.max(0, hp + (op.delta ?? 0)));
                if (hp !== before) hpTouched = true;
                applied.push(`hp: ${before} → ${hp}`);
                // Play report 5 #5: back above 0 (the stable creature's 1d4-hour
                // return, any healing clock) wakes the sheet: the dying rules'
                // Unconscious and Prone and a Stable marker come off.
                if (before <= 0 && hp > 0) {
                    const woke = stripDyingRowConditions(conditions as RowCondition[]);
                    if (woke.removed.length) {
                        conditions = woke.conditions as typeof conditions;
                        condsTouched = true;
                        applied.push(`wakes: ${woke.removed.join(', ')} cleared`);
                    }
                }
                break;
            }
            case 'adjust_max_hp': {
                const beforeM = maxHp;
                maxHp = Math.max(1, maxHp + (op.delta ?? 0));
                if (hp > maxHp) { hp = maxHp; hpTouched = true; }
                if (maxHp !== beforeM) maxHpTouched = true;
                applied.push(`maxHp: ${beforeM} → ${maxHp}`);
                break;
            }
            case 'add_condition': {
                if (!op.name) { applied.push('⚠ add_condition op missing name — skipped'); break; }
                if (conditions.some(c => c.name === op.name)) { applied.push(`condition "${op.name}" already present — skipped`); break; }
                conditions.push({ name: op.name, ...(op.duration !== undefined ? { duration: op.duration } : {}), source: op.source ?? opts.defaultSource ?? 'mend clock' });
                condsTouched = true;
                applied.push(`+condition ${op.name}`);
                break;
            }
            case 'remove_condition': {
                if (!op.name) { applied.push('⚠ remove_condition op missing name — skipped'); break; }
                const beforeLen = conditions.length;
                conditions = conditions.filter(c => c.name !== op.name);
                if (conditions.length !== beforeLen) { condsTouched = true; applied.push(`−condition ${op.name}`); }
                else applied.push(`condition "${op.name}" not present — skipped`);
                break;
            }
            // Play report 6 #3: a part on the sheet, through the token handler's
            // merge rules. The op is kept in partOps so the commit step replays
            // it onto every live token (hydration never re-reads parts).
            case 'set_part': {
                // A blank name is no name: it would make a nameless part.
                if (!op.part?.trim()) { applied.push('⚠ set_part op missing part name — skipped'); break; }
                if (!op.state) { applied.push('⚠ set_part op missing state — skipped'); break; }
                if ((op.state as string) === 'latched') { applied.push(`⚠ set_part ${op.part}: latched cannot be scheduled (a clock has no participant to hold; use combat_manage set_part on the token) — skipped`); break; }
                const r = setPartOn(parts, scheduledPartWrite(op as ScheduledSetPart));
                parts = r.parts;
                partsTouched = true;
                partOps.push({ op, line: applied.length });
                applied.push(r.prev
                    ? `set_part: ${r.next.name} ${r.prev.state === r.next.state ? r.next.state : `${r.prev.state} → ${r.next.state}`} (sheet)`
                    : `set_part: ${r.next.name} → ${r.next.state} (new part on sheet)`);
                break;
            }
            case 'remove_part': {
                if (!op.part?.trim()) { applied.push('⚠ remove_part op missing part name — skipped'); break; }
                const r = removePartFrom(parts, op.part);
                // A token may hold a part the sheet never had: the op still replays.
                partOps.push({ op, line: applied.length });
                if (r.removed) { parts = r.parts; partsTouched = true; applied.push(`−part ${r.removed.name} (sheet)`); }
                else applied.push(`part "${op.part}" not present on sheet — skipped`);
                break;
            }
            // Play report 6 #2: a note is printed and journaled; nothing on the
            // sheet changes. A plain-string montage cost arrives as one, and a
            // note-only schedule_change is the reminder the GM built by hand
            // with event + note. Text that starts with an op name is still a
            // note, and says so: a write is an object.
            case 'note': {
                if (!op.text) { applied.push('⚠ note op missing text — skipped'); break; }
                applied.push(`note: ${op.text}`);
                const like = opLikeText(op.text);
                if (like) applied.push(like.braced
                    ? `⚠ '${op.text}' reads like an op written as text but is not JSON, so it is a note and nothing changed — pass the object itself: ${like.form}`
                    : `⚠ '${op.text}' reads like an op but was given as text, so it is a note and nothing changed — a write is an object: ${like.form}`);
                break;
            }
            default:
                // An op the grammar does not know is said, not swallowed.
                applied.push(`⚠ unknown op '${String((op as { op?: unknown }).op)}' — skipped (ops: ${SCHEDULED_OPS.join(', ')})`);
        }
    }
    if (ops.length === 0) applied.push('⚠ writes JSON empty or malformed — nothing applied');
    const updates: Record<string, unknown> = {};
    if (poolsTouched) updates.resourcePools = pools;
    if (condsTouched) updates.conditions = conditions;
    if (hpTouched) updates.hp = hp;
    if (maxHpTouched) updates.maxHp = maxHp;
    if (partsTouched) updates.parts = parts;
    return { applied, updates, partOps };
}
