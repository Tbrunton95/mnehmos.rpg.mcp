/**
 * Deep One audit request 9: obligations that aren't money.
 * ledger_manage rows carry a `kind` — debt | oath | meeting | border | favour.
 * Only debts have a figure; the others need a consequence and ride the same clock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleLedgerManage, LedgerManageTool, ensureLedgerKindColumn } from '../../src/server/consolidated/ledger-manage.js';
import { handleSessionManage } from '../../src/server/consolidated/session-manage.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const W = 'teshra';
const ctx = { sessionId: 'ledger' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const ledger = async (a: Record<string, unknown>) => json(await handleLedgerManage(a, ctx as any));

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Teshra', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 10, time: '06:00' } } as any);
});
afterEach(() => closeDb());

describe('ledger_manage kinds', () => {
    it('creates an oath without an amount and renders it by kind, amount-less', async () => {
        const r = await ledger({ action: 'create', worldId: W, kind: 'oath', debtor: 'Teshra', creditor: 'Namar', note: 'Teshra salt-oath', dueDay: 20, consequence: "Namar's house turns on Teshra" });
        expect(r.success).toBe(true);
        expect(r.kind).toBe('oath');
        expect(r.message).toBe("oath · Teshra salt-oath · Teshra → Namar · if not: Namar's house turns on Teshra · due Day 20");
        const g = await ledger({ action: 'get', worldId: W, ledgerId: r.ledgerId });
        expect(g.kind).toBe('oath');
        expect(g.amount).toBeUndefined();
        expect(g.currency).toBeUndefined();
        expect(g.summary).toBe("oath · Teshra salt-oath · Teshra → Namar · due day 20 · if not: Namar's house turns on Teshra");
    });

    it('refuses a non-debt kind without a consequence, and a debt without an amount', async () => {
        const oath = await ledger({ action: 'create', worldId: W, kind: 'meeting', debtor: 'Marcus', creditor: 'the connect', dueDay: 12 });
        expect(oath.error).toBe(true);
        expect(oath.message).toMatch(/meeting .*needs a consequence/);
        const debt = await ledger({ action: 'create', worldId: W, debtor: 'Marcus', creditor: 'Kenny' });
        expect(debt.error).toBe(true);
        expect(debt.message).toMatch(/amount/);
        expect((await ledger({ action: 'list', worldId: W })).count).toBe(0);
    });

    it('debts render as before and default kind is debt', async () => {
        const r = await ledger({ action: 'create', worldId: W, debtor: 'Marcus', creditor: 'Kenny', amount: 2000, dueDay: 48, consequence: 'Kenny sends the cousins' });
        expect(r.kind).toBe('debt');
        expect(r.message).toBe('Marcus owes Kenny $2000 · if not: Kenny sends the cousins · due Day 48');
        const g = await ledger({ action: 'get', worldId: W, ledgerId: r.ledgerId });
        expect(g).toMatchObject({ kind: 'debt', amount: 2000, currency: '$' });
    });

    it('openExposure sums currency debts only; list filters by kind', async () => {
        await ledger({ action: 'create', worldId: W, debtor: 'Marcus', creditor: 'Kenny', amount: 2000, dueDay: 48 });
        await ledger({ action: 'create', worldId: W, debtor: 'Sol', creditor: 'Kenny', amount: 400 });
        await ledger({ action: 'create', worldId: W, kind: 'oath', debtor: 'Teshra', creditor: 'Namar', note: 'salt-oath', consequence: 'war' });
        await ledger({ action: 'create', worldId: W, kind: 'favour', debtor: 'Namar', creditor: 'Teshra', consequence: 'the favour is called in publicly' });
        const all = await ledger({ action: 'list', worldId: W });
        expect(all.count).toBe(4);
        expect(all.openExposure).toBe(2400);
        expect(all.openObligations).toBe(2);
        expect(all.message).toBe('4 obligation(s) — open exposure $2400 — 2 open non-money obligation(s)');
        const oaths = await ledger({ action: 'list', worldId: W, kind: 'oath' });
        expect(oaths.count).toBe(1);
        expect(oaths.debts[0]).toMatchObject({ kind: 'oath', debtor: 'Teshra' });
        expect(oaths.openExposure).toBe(0);
        const debts = await ledger({ action: 'list', worldId: W, kind: 'debt' });
        expect(debts.count).toBe(2);
        expect(debts.debts.every((d: any) => typeof d.amount === 'number')).toBe(true);
    });

    it('an owed meeting lapses on the clock and names its consequence', async () => {
        const { ledgerId } = await ledger({ action: 'create', worldId: W, kind: 'meeting', debtor: 'Marcus', creditor: 'the connect', note: 'the pier at dusk', dueDay: 12, graceDays: 1, consequence: 'the connect stops answering' });
        const due = await ledger({ action: 'process_due', worldId: W, currentDay: 12 });
        expect(due.transitions).toHaveLength(1);
        expect(due.transitions[0]).toMatchObject({ ledgerId, kind: 'meeting', from: 'pending', to: 'due' });
        expect(due.transitions[0].amount).toBeUndefined();
        const lapsed = await ledger({ action: 'process_due', worldId: W, currentDay: 14 });
        expect(lapsed.transitions[0]).toMatchObject({ kind: 'meeting', to: 'lapsed', consequenceDue: 'the connect stops answering' });
        expect(lapsed.transitions[0].what).toBe('meeting · the pier at dusk · Marcus → the connect · due day 12 · if not: the connect stops answering');
        expect(lapsed.message).toContain('meeting Marcus → the connect: the connect stops answering');
        expect((await ledger({ action: 'get', worldId: W, ledgerId })).status).toBe('lapsed');
    });

    it('settle keeps an oath, default breaks it and reports the consequence', async () => {
        const a = await ledger({ action: 'create', worldId: W, kind: 'oath', debtor: 'Teshra', creditor: 'Namar', note: 'salt-oath', consequence: 'war' });
        const kept = await ledger({ action: 'settle', worldId: W, ledgerId: a.ledgerId });
        expect(kept).toMatchObject({ status: 'settled', kind: 'oath' });
        expect(kept.message).toBe('oath Teshra → Namar: KEPT (salt-oath)');
        const b = await ledger({ action: 'create', worldId: W, kind: 'border', debtor: 'the Ithraes', creditor: 'Teshra', note: 'the river line', consequence: 'Teshra marches' });
        const broke = await ledger({ action: 'default', worldId: W, ledgerId: b.ledgerId });
        expect(broke).toMatchObject({ kind: 'border', consequenceDue: 'Teshra marches' });
        expect(broke.message).toBe('the Ithraes → Teshra: BROKE the border (the river line). Consequence due: Teshra marches');
    });

    it('boot packet lists obligations with their kind word', async () => {
        await ledger({ action: 'create', worldId: W, debtor: 'Marcus', creditor: 'Kenny', amount: 2000, dueDay: 48, consequence: 'cousins' });
        await ledger({ action: 'create', worldId: W, kind: 'oath', debtor: 'Teshra', creditor: 'Namar', note: 'Teshra salt-oath', dueDay: 9, consequence: 'war' });
        const res = await handleSessionManage({ action: 'boot', worldId: W }, ctx as any);
        const p = json(res);
        const oath = p.clocks.find((c: any) => c.kind === 'oath');
        expect(oath).toMatchObject({ status: 'pending', due: true, what: 'oath · Teshra salt-oath · Teshra → Namar; if not: war' });
        expect(p.clocks.find((c: any) => c.kind === 'debt').what).toBe('Marcus owes Kenny $2000; if not: cousins');
        expect(res.content[0].text).toContain('• DUE [pending] day 9: oath · Teshra salt-oath · Teshra → Namar; if not: war');
    });

    it('migrates an older ledger table that predates kind', async () => {
        const db = getDb();
        db.exec(`CREATE TABLE ledger_debts (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, debtor TEXT NOT NULL, creditor TEXT NOT NULL,
            amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT '$', due_day REAL, grace_days REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending', consequence TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
        db.prepare("INSERT INTO ledger_debts VALUES ('old', ?, 'Sol', 'Kenny', 400, '$', NULL, 0, 'pending', NULL, NULL, 'x', 'x')").run(W);
        ensureLedgerKindColumn(db);
        ensureLedgerKindColumn(db); // idempotent
        const l = await ledger({ action: 'list', worldId: W });
        expect(l.debts[0]).toMatchObject({ kind: 'debt', amount: 400 });
        expect(l.openExposure).toBe(400);
    });

    it('exposes kind in the tool schema', () => {
        const shape = (LedgerManageTool.inputSchema as any).shape;
        expect(shape.kind).toBeDefined();
        expect(LedgerManageTool.description).toMatch(/oath \| meeting \| border \| favour/);
    });
});
