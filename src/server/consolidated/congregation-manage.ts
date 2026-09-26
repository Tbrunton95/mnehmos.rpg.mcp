/**
 * Item 4: CONGREGATION_MANAGE — cults as one row each, the horde pattern.
 * A congregation has a size and a zeal (0-10), a god (a pool on its
 * founder) and optionally the pool_family that god belongs to. Every whole
 * in-fiction week it yields favour to the founder: weeklyYield when set,
 * else max(1, round(size × zeal / 100)), credited through adjust_pool so the
 * family's jealousy and clamps apply. A week in which it was not tended for
 * more than seven days costs a point of zeal; at zeal 0 the flock shrinks by
 * a tenth; at size 0 it has dispersed. process_weekly is the explicit verb:
 * world_manage advance only counts what is due (FINDINGS #100).
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { matchAction, isGuidingError } from '../../utils/fuzzy-enum.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { SessionContext } from '../types.js';
import { readWorldClock, SET_CLOCK_HINT } from '../../engine/world-clock.js';
import { loadRule } from '../../engine/table-rules.js';
import { familyMember } from '../../engine/pool-family.js';
import { handleAdjustPool } from './character-manage.js';

const ACTIONS = ['create', 'get', 'list', 'set', 'tend', 'strike', 'purge', 'process_weekly', 'delete'] as const;
type CongregationAction = typeof ACTIONS[number];
const ALIASES: Record<string, CongregationAction> = {
    'new': 'create', 'found': 'create', 'congregations': 'list', 'update': 'set',
    'preach': 'tend', 'visit': 'tend', 'minister': 'tend',
    'raid': 'strike', 'attack': 'strike', 'losses': 'strike',
    'wipe_out': 'purge', 'exterminate': 'purge',
    'weekly': 'process_weekly', 'process': 'process_weekly', 'tithe': 'process_weekly',
    'remove': 'delete', 'destroy': 'delete'
};
const STATUSES = ['active', 'dispersed', 'purged'] as const;
const MAX_ZEAL = 10;

const CongregationInputSchema = z.object({
    action: z.string().describe('Action: create, get, list, set, tend, strike, purge, process_weekly, delete'),
    worldId: z.string().describe('REQUIRED — congregations are world-scoped and read that world\'s clock'),
    congregationId: z.string().optional(),
    name: z.string().optional(),
    god: z.string().optional().describe('create/set: the pool on the founder that the yield feeds (Khorne, Slaanesh...)'),
    family: z.string().nullable().optional().describe('create/set: the pool_family rule the god belongs to — the yield moves through it, so rivals grow jealous. null clears'),
    founderId: z.string().optional().describe('create/set: the character whose pool receives the weekly yield'),
    location: z.string().optional(),
    size: z.number().int().min(0).optional().describe('create/set: members'),
    zeal: z.number().int().min(0).max(MAX_ZEAL).optional().describe('create/set: 0-10 (default 5). Yield = max(1, round(size × zeal / 100)) a week'),
    weeklyYield: z.number().int().min(0).nullable().optional().describe('create/set: a fixed weekly yield instead of the formula; null returns to the formula'),
    status: z.enum(STATUSES).optional().describe('set: active | dispersed | purged; list: filter'),
    day: z.number().optional().describe('create/tend: the day to stamp (default: the world clock)'),
    losses: z.number().int().min(0).optional().describe('strike: members lost'),
    zealDelta: z.number().int().optional().describe('strike: zeal change (clamped 0-10)'),
    sessionId: z.string().optional()
});
type Input = z.infer<typeof CongregationInputSchema>;

function cdb() {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS congregations (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL, name TEXT NOT NULL,
        god TEXT NOT NULL, family TEXT, founder_id TEXT NOT NULL, location TEXT,
        size INTEGER NOT NULL, zeal INTEGER NOT NULL, weekly_yield INTEGER,
        last_tended_day REAL, last_processed_day REAL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    return db;
}
type CRow = {
    id: string; world_id: string; name: string; god: string; family: string | null; founder_id: string;
    location: string | null; size: number; zeal: number; weekly_yield: number | null;
    last_tended_day: number | null; last_processed_day: number | null; status: string;
};

const view = (r: CRow) => ({
    congregationId: r.id, name: r.name, god: r.god, family: r.family, founderId: r.founder_id,
    location: r.location, size: r.size, zeal: r.zeal, weeklyYield: r.weekly_yield,
    lastTendedDay: r.last_tended_day, lastProcessedDay: r.last_processed_day, status: r.status
});

/** The weekly yield: the fixed number when set, else max(1, round(size × zeal / 100)). */
export function congregationYield(size: number, zeal: number, weeklyYield: number | null): number {
    return weeklyYield ?? Math.max(1, Math.round(size * zeal / 100));
}

async function route(input: Input): Promise<Record<string, unknown>> {
    const matched = matchAction(input.action, ACTIONS, ALIASES);
    if (isGuidingError(matched)) return { error: true, message: matched.message };
    const db = cdb();
    const now = new Date().toISOString();
    const w = input.worldId;
    const find = (id?: string): CRow | null => id ? ((db.prepare('SELECT * FROM congregations WHERE id = ? AND world_id = ?').get(id, w) as CRow | undefined) ?? null) : null;
    const clockDay = (): number | null => input.day ?? readWorldClock(db, w)?.at ?? null;
    const missing = () => ({ error: true, message: `No congregation ${input.congregationId ?? '(no congregationId)'} in world ${w}` });
    const checkFamily = (family: string | null | undefined, god: string): string | null => {
        if (!family) return null;
        const rule = loadRule(db, w, 'pool_family', family);
        if (!rule) return `No pool_family '${family}' in world ${w}. Nothing was written.`;
        if (!familyMember(rule.spec, god)) return `'${god}' is not in family '${rule.name}' (${rule.spec.pools.join(', ')}). Nothing was written.`;
        return null;
    };

    switch (matched.matched) {
        case 'create': {
            if (!input.name || !input.god || !input.founderId || input.size === undefined) return { error: true, message: 'create requires name, god, founderId, size (zeal defaults to 5). Nothing was written.' };
            if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(input.founderId)) return { error: true, message: `Founder ${input.founderId} not found. Nothing was written.` };
            const bad = checkFamily(input.family, input.god);
            if (bad) return { error: true, message: bad };
            const id = `congregation-${randomUUID().slice(0, 8)}`;
            const day = clockDay();
            db.prepare(`INSERT INTO congregations (id, world_id, name, god, family, founder_id, location, size, zeal, weekly_yield, last_tended_day, last_processed_day, status, created_at, updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`)
                .run(id, w, input.name, input.god, input.family ?? null, input.founderId, input.location ?? null, input.size, input.zeal ?? 5, input.weeklyYield ?? null, day, day, now, now);
            const row = find(id) as CRow;
            return {
                success: true, actionType: 'create', congregationId: id, congregation: view(row),
                ...(day === null ? { note: `No world clock: the weeks start counting at the first process_weekly after one is set (${SET_CLOCK_HINT}).` } : {}),
                message: `The congregation "${input.name}" of ${input.god} — ${input.size} souls, zeal ${row.zeal}${input.location ? `, at ${input.location}` : ''}.`
            };
        }
        case 'get': {
            const r = find(input.congregationId);
            if (!r) return missing();
            return { success: true, actionType: 'get', congregationId: r.id, congregation: view(r), weeklyYieldNow: congregationYield(r.size, r.zeal, r.weekly_yield), message: `${r.name}: ${r.size} souls, zeal ${r.zeal}, ${r.status}` };
        }
        case 'list': {
            const rows = (input.status
                ? db.prepare('SELECT * FROM congregations WHERE world_id = ? AND status = ? ORDER BY size DESC').all(w, input.status)
                : db.prepare('SELECT * FROM congregations WHERE world_id = ? ORDER BY size DESC').all(w)) as CRow[];
            return { success: true, actionType: 'list', count: rows.length, congregations: rows.map(view), message: `${rows.length} congregation(s)` };
        }
        case 'set': {
            const r = find(input.congregationId);
            if (!r) return missing();
            if (input.founderId && !db.prepare('SELECT 1 FROM characters WHERE id = ?').get(input.founderId)) return { error: true, message: `Founder ${input.founderId} not found. Nothing was written.` };
            const god = input.god ?? r.god;
            const family = input.family === undefined ? r.family : input.family;
            const bad = checkFamily(family, god);
            if (bad) return { error: true, message: bad };
            const size = input.size ?? r.size;
            const status = input.status ?? (size === 0 && r.status === 'active' ? 'dispersed' : r.status);
            db.prepare(`UPDATE congregations SET name = ?, god = ?, family = ?, founder_id = ?, location = ?, size = ?, zeal = ?, weekly_yield = ?, status = ?, updated_at = ? WHERE id = ?`)
                .run(input.name ?? r.name, god, family, input.founderId ?? r.founder_id, input.location ?? r.location, size, input.zeal ?? r.zeal,
                    input.weeklyYield === undefined ? r.weekly_yield : input.weeklyYield, status, now, r.id);
            const after = find(r.id) as CRow;
            return { success: true, actionType: 'set', congregationId: r.id, congregation: view(after), message: `${after.name} updated — ${after.size} souls, zeal ${after.zeal}, ${after.status}` };
        }
        case 'tend': {
            const r = find(input.congregationId);
            if (!r) return missing();
            const day = clockDay();
            if (day === null) return { error: true, message: `tend needs a day: pass day, ${SET_CLOCK_HINT}. Nothing was written.` };
            db.prepare('UPDATE congregations SET last_tended_day = ?, last_processed_day = COALESCE(last_processed_day, ?), updated_at = ? WHERE id = ?').run(day, day, now, r.id);
            return { success: true, actionType: 'tend', congregationId: r.id, congregation: view(find(r.id) as CRow), message: `${r.name} tended on day ${day}: no neglect for the next seven days.` };
        }
        case 'strike': {
            const r = find(input.congregationId);
            if (!r) return missing();
            if (input.losses === undefined && input.zealDelta === undefined) return { error: true, message: 'strike takes losses and/or zealDelta. Nothing was written.' };
            const size = Math.max(0, r.size - (input.losses ?? 0));
            const zeal = Math.min(MAX_ZEAL, Math.max(0, r.zeal + (input.zealDelta ?? 0)));
            const status = size === 0 && r.status === 'active' ? 'dispersed' : r.status;
            db.prepare('UPDATE congregations SET size = ?, zeal = ?, status = ?, updated_at = ? WHERE id = ?').run(size, zeal, status, now, r.id);
            return {
                success: true, actionType: 'strike', congregationId: r.id, sizeBefore: r.size, zealBefore: r.zeal, congregation: view(find(r.id) as CRow),
                message: `${r.name} struck: ${r.size} → ${size} souls, zeal ${r.zeal} → ${zeal}${status === 'dispersed' && r.status !== 'dispersed' ? ' — dispersed' : ''}.`
            };
        }
        case 'purge': {
            const r = find(input.congregationId);
            if (!r) return missing();
            db.prepare(`UPDATE congregations SET size = 0, status = 'purged', updated_at = ? WHERE id = ?`).run(now, r.id);
            return { success: true, actionType: 'purge', congregationId: r.id, sizeBefore: r.size, congregation: view(find(r.id) as CRow), message: `${r.name} purged — ${r.size} souls gone. It yields nothing more.` };
        }
        case 'delete': {
            const r = find(input.congregationId);
            if (!r) return missing();
            db.prepare('DELETE FROM congregations WHERE id = ?').run(r.id);
            return { success: true, actionType: 'delete', congregationId: r.id, name: r.name, message: `${r.name} deleted.` };
        }
        case 'process_weekly': {
            const clock = readWorldClock(db, w);
            if (!clock) return { error: true, message: `process_weekly reads the world clock and world ${w} has none: ${SET_CLOCK_HINT}. Nothing was written.` };
            const rows = (input.congregationId
                ? [find(input.congregationId)].filter(Boolean)
                : db.prepare(`SELECT * FROM congregations WHERE world_id = ? AND status = 'active' ORDER BY created_at`).all(w)) as CRow[];
            if (input.congregationId && !rows.length) return missing();
            const results: Array<Record<string, unknown>> = [];
            let weeksProcessed = 0;
            for (const r of rows) {
                if (r.status !== 'active') continue;
                if (r.last_processed_day === null) {
                    db.prepare('UPDATE congregations SET last_processed_day = ?, last_tended_day = COALESCE(last_tended_day, ?), updated_at = ? WHERE id = ?').run(clock.at, clock.at, now, r.id);
                    results.push({ congregationId: r.id, name: r.name, weeks: [], note: `weeks count from day ${clock.at}` });
                    continue;
                }
                const weeks = Math.floor((clock.at - r.last_processed_day) / 7 + 1e-9);
                if (weeks < 1) continue;
                let { size, zeal } = r;
                let status = r.status;
                let done = 0;
                const lines: Array<Record<string, unknown>> = [];
                for (let n = 1; n <= weeks; n++) {
                    done = n;
                    const weekEnd = r.last_processed_day + 7 * n;
                    const tended = r.last_tended_day ?? r.last_processed_day;
                    const neglected = weekEnd - tended > 7;
                    if (neglected) zeal = Math.max(0, zeal - 1);
                    if (zeal === 0) size = Math.floor(size * 0.9);
                    if (size <= 0) {
                        size = 0; status = 'dispersed';
                        lines.push({ week: n, day: weekEnd, zeal, size, yield: 0, ...(neglected ? { neglected: true } : {}), dispersed: true });
                        break;
                    }
                    const gain = congregationYield(size, zeal, r.weekly_yield);
                    let favour: Record<string, unknown>;
                    try {
                        favour = await handleAdjustPool({
                            action: 'adjust_pool', characterId: r.founder_id, pool: r.god, delta: gain,
                            reason: `congregation ${r.name} week ${n}`,
                            ...(r.family ? { family: r.family, worldId: w } : {})
                        }) as Record<string, unknown>;
                    } catch (e) {
                        favour = { error: true, message: e instanceof Error ? e.message : String(e) };
                    }
                    lines.push({
                        week: n, day: weekEnd, zeal, size, yield: gain, ...(neglected ? { neglected: true } : {}),
                        ...(favour.error ? { yieldError: favour.message } : { pool: favour.pool, poolNow: favour.current, ...(Array.isArray(favour.rivals) && favour.rivals.length ? { rivals: favour.rivals } : {}) })
                    });
                }
                weeksProcessed += done;
                db.prepare('UPDATE congregations SET size = ?, zeal = ?, status = ?, last_processed_day = ?, updated_at = ? WHERE id = ?')
                    .run(size, zeal, status, r.last_processed_day + 7 * done, now, r.id);
                const total = lines.reduce((s, l) => s + (l.yieldError ? 0 : Number(l.yield ?? 0)), 0);
                results.push({ congregationId: r.id, name: r.name, god: r.god, weeks: lines, totalYield: total, size, zeal, status });
            }
            return {
                success: true, actionType: 'process_weekly', clockAt: clock.at, weeksProcessed, results,
                formula: 'per week: untended more than 7 days → zeal −1; zeal 0 → size ×0.9 (floor); yield = weeklyYield ?? max(1, round(size × zeal / 100)) to the founder\'s god pool through its family',
                message: results.length
                    ? results.map(x => `${String(x.name)}: ${(x.weeks as unknown[]).length} week(s)${x.totalYield !== undefined ? `, +${String(x.totalYield)} ${String(x.god)}` : ''}${x.status === 'dispersed' ? ' — dispersed' : ''}`).join('; ')
                    : 'No congregation has a whole week to process.'
            };
        }
    }
    return { error: true, message: 'unhandled' };
}

export async function handleCongregationManage(args: unknown, _ctx: SessionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        const result = await route(CongregationInputSchema.parse(args));
        let output = result.error ? RichFormatter.error(String(result.message)) : RichFormatter.header(`Congregation — ${String(result.actionType)}`, '🕯️') + (result.message ? RichFormatter.alert(String(result.message), 'info') : '');
        output += RichFormatter.embedJson(result, 'CONGREGATION_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: RichFormatter.error(msg) + RichFormatter.embedJson({ error: true, message: msg }, 'CONGREGATION_MANAGE') }] };
    }
}

export const CongregationManageTool = {
    name: 'congregation_manage',
    description: `Cults and congregations as one row each: size, zeal (0-10), the god they feed and its founder. Every in-fiction week a congregation yields favour to the founder's god pool — weeklyYield, or max(1, round(size × zeal / 100)) — through the god's pool_family (so rivals grow jealous).

Actions: create, get, list, set, tend, strike, purge, process_weekly, delete
- create {name, god, founderId, size, zeal?, family?, location?, weeklyYield?}: stamps the world clock.
- tend: resets neglect. A week untended for more than 7 days costs 1 zeal; at zeal 0 the flock shrinks by a tenth; at 0 souls it disperses.
- strike {losses?, zealDelta?}: raids, martyrdoms, revivals. purge wipes it out.
- process_weekly: catches up every whole week since the last run from the world clock (world_manage advance reports dueNow.congregations).
worldId REQUIRED on every call.`,
    inputSchema: CongregationInputSchema,
    // Every action shares the one input schema; the switch dispatcher validates per action.
    actionSchemas: Object.fromEntries(ACTIONS.map(a => [a, { schema: CongregationInputSchema, aliases: [] as string[] }]))
};
