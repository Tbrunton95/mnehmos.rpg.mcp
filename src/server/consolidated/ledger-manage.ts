/**
 * FINDINGS #99: LEDGER_MANAGE — R3. Debts with due dates, counterparties,
 * and a status machine the clock drives. Sol's $400, Kenny's $2,000, the
 * tax on every ounce — five narrative notes a GM had to remember become
 * rows that process_due walks on the fiction's clock.
 * Status machine: pending → due (day arrives) → lapsed (grace exhausted).
 * settle / default are GM verbs; consequence is Register B — the engine
 * REPORTS it at the transition, the GM runs it.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { loadRule } from '../../engine/table-rules.js';
import { SessionContext } from '../types.js';

const ACTIONS = ['create', 'get', 'list', 'process_due', 'settle', 'default', 'update', 'delete'] as const;

const LedgerInputSchema = z.object({
    action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
    worldId: z.string().describe('REQUIRED — debts are world-scoped'),
    ledgerId: z.string().optional(),
    debtor: z.string().optional().describe("create: who owes ('Marcus', a character id, a crew name)"),
    creditor: z.string().optional().describe("create: who is owed ('Kenny', 'the connect')"),
    amount: z.number().optional().describe('create/update/settle: principal. settle with a partial amount reduces; reaching 0 settles'),
    currency: z.string().optional().describe("create: display currency ('$', 'RU', 'Thrones'). Default: the world lexicon's currency, else '$'"),
    dueDay: z.number().optional().describe('create/update: in-fiction day it comes due'),
    graceDays: z.number().optional().describe('create/update: days past due before due → lapsed. Default 0 (lapses the day after due)'),
    consequence: z.string().optional().describe("create/update: what lapsing/defaulting MEANS ('Kenny sends the cousins'). Register B — reported at the transition, run by the GM"),
    note: z.string().optional(),
    currentDay: z.number().optional().describe('process_due: the fiction clock — REQUIRED for process_due'),
    status: z.enum(['pending', 'due', 'lapsed', 'settled', 'defaulted']).optional().describe('list filter'),
    sessionId: z.string().optional()
});

type DebtRow = {
    id: string; world_id: string; debtor: string; creditor: string; amount: number;
    currency: string; due_day: number | null; grace_days: number; status: string;
    consequence: string | null; note: string | null; created_at: string; updated_at: string;
};

function ldb() {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS ledger_debts (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL,
        debtor TEXT NOT NULL, creditor TEXT NOT NULL,
        amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT '$',
        due_day REAL, grace_days REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        consequence TEXT, note TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    return db;
}

function render(r: DebtRow) {
    return {
        ledgerId: r.id, debtor: r.debtor, creditor: r.creditor,
        amount: r.amount, currency: r.currency, dueDay: r.due_day, graceDays: r.grace_days,
        status: r.status, consequence: r.consequence, note: r.note
    };
}

/** '$' and other symbols lead; a word follows: '$5', '5 Thrones'. */
function money(amount: number, currency: string): string {
    return currency.length <= 2 ? `${currency}${amount}` : `${amount} ${currency}`;
}

async function route(args: unknown): Promise<Record<string, unknown>> {
    const input = LedgerInputSchema.parse(args);
    const db = ldb();
    const now = new Date().toISOString();
    const find = (id?: string): DebtRow | undefined => id
        ? db.prepare('SELECT * FROM ledger_debts WHERE id = ? AND world_id = ?').get(id, input.worldId) as DebtRow | undefined
        : undefined;

    switch (input.action) {
        case 'create': case 'new': case 'owe': {
            if (!input.debtor || !input.creditor || typeof input.amount !== 'number') {
                return { error: true, message: 'create needs debtor, creditor, amount' };
            }
            const id = randomUUID();
            // No currency given: the world lexicon's, else '$'.
            const currency = input.currency ?? loadRule(db, input.worldId, 'lexicon')?.spec.currency ?? '$';
            db.prepare(`INSERT INTO ledger_debts (id, world_id, debtor, creditor, amount, currency, due_day, grace_days, status, consequence, note, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
                .run(id, input.worldId, input.debtor, input.creditor, input.amount, currency, input.dueDay ?? null, input.graceDays ?? 0, input.consequence ?? null, input.note ?? null, now, now);
            return {
                success: true, actionType: 'create', ledgerId: id,
                message: `${input.debtor} owes ${input.creditor} ${money(input.amount, currency)}${input.dueDay !== undefined ? `, due Day ${input.dueDay}` : ' (no due date — pressure is narrative)'}${input.consequence ? `. Lapse means: ${input.consequence}` : ''}`
            };
        }
        case 'get': {
            const r = find(input.ledgerId);
            if (!r) return { error: true, message: `No debt ${input.ledgerId} in this world` };
            return { success: true, actionType: 'get', ...render(r) };
        }
        case 'list': {
            const rows = (input.status
                ? db.prepare('SELECT * FROM ledger_debts WHERE world_id = ? AND status = ? ORDER BY due_day IS NULL, due_day').all(input.worldId, input.status)
                : db.prepare('SELECT * FROM ledger_debts WHERE world_id = ? ORDER BY due_day IS NULL, due_day').all(input.worldId)) as DebtRow[];
            const open = rows.filter(r => ['pending', 'due', 'lapsed'].includes(r.status));
            const exposure = open.reduce((s, r) => s + r.amount, 0);
            return {
                success: true, actionType: 'list', count: rows.length,
                openExposure: exposure, debts: rows.map(render),
                message: `${rows.length} debt(s)${open.length ? ` — open exposure ${money(exposure, open[0]?.currency ?? '$')}` : ''}`
            };
        }
        case 'process_due': case 'tick': {
            if (typeof input.currentDay !== 'number') return { error: true, message: 'process_due needs currentDay (the fiction clock)' };
            const rows = db.prepare("SELECT * FROM ledger_debts WHERE world_id = ? AND status IN ('pending','due') AND due_day IS NOT NULL").all(input.worldId) as DebtRow[];
            const transitions: Array<Record<string, unknown>> = [];
            for (const r of rows) {
                let next: string | null = null;
                if (r.status === 'pending' && input.currentDay >= (r.due_day as number)) next = 'due';
                if ((r.status === 'due' || next === 'due') && input.currentDay > (r.due_day as number) + r.grace_days) next = 'lapsed';
                if (next && next !== r.status) {
                    db.prepare('UPDATE ledger_debts SET status = ?, updated_at = ? WHERE id = ?').run(next, now, r.id);
                    transitions.push({
                        ledgerId: r.id, debtor: r.debtor, creditor: r.creditor,
                        amount: r.amount, currency: r.currency, from: r.status, to: next,
                        ...(next === 'lapsed' && r.consequence ? { consequenceDue: r.consequence } : {})
                    });
                }
            }
            const lapsed = transitions.filter(t => t.to === 'lapsed');
            return {
                success: true, actionType: 'process_due', day: input.currentDay,
                transitions, count: transitions.length,
                message: transitions.length
                    ? `${transitions.length} transition(s)${lapsed.length ? ` — ${lapsed.length} LAPSED: consequences are due and named above (Register B — the engine reports, the chair runs them)` : ''}`
                    : 'Nothing came due'
            };
        }
        case 'settle': case 'pay': {
            const r = find(input.ledgerId);
            if (!r) return { error: true, message: `No debt ${input.ledgerId} in this world` };
            if (['settled', 'defaulted'].includes(r.status)) return { error: true, message: `${r.debtor} → ${r.creditor} is already ${r.status}` };
            const paid = typeof input.amount === 'number' ? input.amount : r.amount;
            const remaining = Math.max(0, r.amount - paid);
            const newStatus = remaining === 0 ? 'settled' : r.status;
            db.prepare('UPDATE ledger_debts SET amount = ?, status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?')
                .run(remaining, newStatus, input.note ?? null, now, r.id);
            return {
                success: true, actionType: 'settle', ledgerId: r.id, paid, remaining, status: newStatus,
                message: remaining === 0
                    ? `${r.debtor} → ${r.creditor}: SETTLED (${r.currency}${paid} paid)`
                    : `${r.debtor} → ${r.creditor}: ${r.currency}${paid} paid, ${r.currency}${remaining} still owed (${r.status})`
            };
        }
        case 'default': {
            const r = find(input.ledgerId);
            if (!r) return { error: true, message: `No debt ${input.ledgerId} in this world` };
            if (['settled', 'defaulted'].includes(r.status)) return { error: true, message: `${r.debtor} → ${r.creditor} is already ${r.status}` };
            db.prepare("UPDATE ledger_debts SET status = 'defaulted', updated_at = ? WHERE id = ?").run(now, r.id);
            return {
                success: true, actionType: 'default', ledgerId: r.id,
                ...(r.consequence ? { consequenceDue: r.consequence } : {}),
                message: `${r.debtor} → ${r.creditor}: DEFAULTED on ${r.currency}${r.amount}${r.consequence ? `. Consequence due: ${r.consequence}` : ''}`
            };
        }
        case 'update': {
            const r = find(input.ledgerId);
            if (!r) return { error: true, message: `No debt ${input.ledgerId} in this world` };
            db.prepare(`UPDATE ledger_debts SET amount = COALESCE(?, amount), due_day = COALESCE(?, due_day),
                        grace_days = COALESCE(?, grace_days), consequence = COALESCE(?, consequence),
                        note = COALESCE(?, note), updated_at = ? WHERE id = ?`)
                .run(input.amount ?? null, input.dueDay ?? null, input.graceDays ?? null, input.consequence ?? null, input.note ?? null, now, r.id);
            const after = find(r.id)!;
            return { success: true, actionType: 'update', was: { amount: r.amount, dueDay: r.due_day, status: r.status }, now: render(after), message: `${r.debtor} → ${r.creditor} updated` };
        }
        case 'delete': {
            const r = find(input.ledgerId);
            if (!r) return { error: true, message: `No debt ${input.ledgerId} in this world` };
            db.prepare('DELETE FROM ledger_debts WHERE id = ?').run(r.id);
            return { success: true, actionType: 'delete', ledgerId: r.id, message: `${r.debtor} → ${r.creditor} (${r.currency}${r.amount}, ${r.status}) struck from the ledger` };
        }
    }
    return { error: true, message: `Unknown action '${input.action}' — create, get, list, process_due, settle, default, update, delete` };
}

export async function handleLedgerManage(args: unknown, _ctx: SessionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        const result = await route(args);
        let output = result.error ? RichFormatter.error(String(result.message)) : RichFormatter.header(`Ledger — ${String(result.actionType)}`, '💰') + (result.message ? RichFormatter.alert(String(result.message), 'info') : '');
        output += RichFormatter.embedJson(result, 'LEDGER_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: RichFormatter.error(msg) + RichFormatter.embedJson({ error: true, message: msg }, 'LEDGER_MANAGE') }] };
    }
}

export const LedgerManageTool = {
    name: 'ledger_manage',
    description: `FINDINGS #99 (R3): debts as rows with a clock-driven status machine — pending → due (day arrives) → lapsed (grace exhausted). settle/default are GM verbs.

Actions: create, get, list, process_due, settle, default, update, delete
- process_due {worldId, currentDay} at boot: walks the machine on the FICTION clock, reports every transition, and NAMES each lapsed debt's consequence — Register B, the chair runs it.
- settle with partial amount reduces; 0 remaining = settled. default flips and reports the consequence.
- list returns openExposure — the number a debtor lies awake under.
- Cash physicality rides container_manage: bundles are items with weight that must live in containers.
worldId REQUIRED on every call.`,
    inputSchema: LedgerInputSchema,
    // Every action shares the one input schema; the switch dispatcher validates per action.
    actionSchemas: Object.fromEntries(ACTIONS.map(a => [a, { schema: LedgerInputSchema, aliases: [] as string[] }]))
};
