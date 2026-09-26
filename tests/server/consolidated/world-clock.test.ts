import { handleWorldManage, WorldManageTool } from '../../../src/server/consolidated/world-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleLedgerManage } from '../../../src/server/consolidated/ledger-manage.js';
import { handleKnowledgeManage } from '../../../src/server/consolidated/knowledge-manage.js';
import { handlePrecedentManage } from '../../../src/server/consolidated/precedent-manage.js';
import { handleNarrativeManage } from '../../../src/server/consolidated/narrative-manage.js';
import { handleSessionManage } from '../../../src/server/consolidated/session-manage.js';
import { readWorldClock, clockAfter, dayClock } from '../../../src/engine/world-clock.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const W = 'zastava';
const ctx = { sessionId: 'clock' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const world = async (a: Record<string, unknown>) => json(await handleWorldManage(WorldManageTool.inputSchema.parse(a), ctx as any));
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const ledger = async (a: Record<string, unknown>) => json(await handleLedgerManage(a, ctx as any));

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    const worlds = new WorldRepository(db);
    worlds.create({ id: W, name: 'Zastava', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 47, time: '06:00', weatherConditions: 'sleet' } } as any);
    // A second world: the status block must not go blank because two exist.
    worlds.create({ id: 'other', name: 'Other', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 3, time: '12:00' } } as any);
    const chars = new CharacterRepository(db);
    chars.create({ id: 'marcus', name: 'Marcus', characterType: 'pc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 20, ac: 12, level: 1, regeneration: 1, createdAt: now, updatedAt: now } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ?').run(W);
});
afterEach(() => closeDb());

describe('world clock helpers', () => {
    it('reads the stored clock, legacy currentDay included, and rolls past midnight', () => {
        expect(readWorldClock(getDb(), W)).toMatchObject({ day: 47, time: '06:00', at: 47.25 });
        getDb().prepare('UPDATE worlds SET environment = ? WHERE id = ?').run(JSON.stringify({ currentDay: 9 }), 'other');
        expect(readWorldClock(getDb(), 'other')).toMatchObject({ day: 9, at: 9 });
        expect(readWorldClock(getDb(), 'nowhere')).toBeNull();
        expect(clockAfter(47.25, 20)).toEqual({ day: 48, time: '02:00' });
        expect(clockAfter(47.25, 0.5)).toEqual({ day: 47, time: '06:30' });
        expect(dayClock(48.5)).toBe('Day 48, 12:00');
    });
});

describe('world_manage advance', () => {
    it('moves the clock by hours across midnight, regenerates, and counts what came due', async () => {
        await char({ action: 'schedule_change', characterId: 'marcus', worldId: W, firesAtDay: 47, firesAtHour: 22, event: true, note: 'Sol calls' });
        await ledger({ action: 'create', worldId: W, debtor: 'Marcus', creditor: 'Kenny', amount: 2000, dueDay: 48 });
        expect(WorldManageTool.description).toMatch(/advance/);
        const r = await world({ action: 'advance', worldId: W, hours: 20 });
        expect(r).toMatchObject({ success: true, actionType: 'advance', elapsedHours: 20 });
        expect(r.environment).toMatchObject({ day: 48, time: '02:00', weatherConditions: 'sleet' });
        expect(r.regenerated?.[0]).toMatchObject({ name: 'Marcus', to: 20 });
        expect(r.dueNow).toEqual({ scheduled: 1, debts: 1 });
        expect(r.message).toMatch(/Day 48, 02:00/);
        expect(readWorldClock(getDb(), W)).toMatchObject({ day: 48, time: '02:00' });
    });

    it('takes minutes and days, and refuses with no clock or no amount', async () => {
        expect((await world({ action: 'advance', worldId: W, days: 2, minutes: 30 })).environment).toMatchObject({ day: 49, time: '06:30' });
        getDb().prepare('UPDATE worlds SET environment = ? WHERE id = ?').run('{}', 'other');
        expect((await world({ action: 'advance', worldId: 'other', hours: 1 })).message).toMatch(/no clock.*world_manage update/i);
        expect((await world({ action: 'advance', worldId: W })).message).toMatch(/minutes, hours or days/);
    });
});

describe('clock-driven verbs default to the world clock', () => {
    it('process_scheduled without currentDay fires what the world day has reached', async () => {
        await char({ action: 'schedule_change', characterId: 'marcus', worldId: W, firesAtDay: 47, firesAtHour: 5, event: true, note: 'dawn' });
        await char({ action: 'schedule_change', characterId: 'marcus', worldId: W, firesAtDay: 47, firesAtHour: 9, event: true, note: 'later' });
        const r = await char({ action: 'process_scheduled', worldId: W });
        expect(r).toMatchObject({ success: true, clockSource: 'world', currentDay: 47, currentTime: '06:00', firedCount: 1 });
        const p = await char({ action: 'process_scheduled', worldId: W, currentDay: 48 });
        expect(p).toMatchObject({ clockSource: 'param', currentDay: 48, firedCount: 1 });
    });

    it('process_scheduled with neither refuses with the recipe', async () => {
        getDb().prepare('UPDATE worlds SET environment = ? WHERE id = ?').run('{}', W);
        const res = await handleCharacterManage({ action: 'process_scheduled', worldId: W }, ctx as any);
        expect(res.content[0].text).toMatch(/currentDay.*world_manage update/s);
    });

    it('firesInHours arms from the world clock when no base is passed', async () => {
        const r = await char({ action: 'schedule_change', characterId: 'marcus', firesInHours: 6, event: true, note: 'back in six' });
        expect(r).toMatchObject({ success: true, clockSource: 'world', firesAtClock: 'Day 47, 12:00' });
        const p = await char({ action: 'schedule_change', characterId: 'marcus', firesInHours: 6, currentDay: 10, event: true });
        expect(p).toMatchObject({ clockSource: 'param', firesAtDay: 10.25 });
    });

    it('ledger process_due uses the world day', async () => {
        await ledger({ action: 'create', worldId: W, debtor: 'Marcus', creditor: 'Kenny', amount: 2000, dueDay: 47 });
        const r = await ledger({ action: 'process_due', worldId: W });
        expect(r).toMatchObject({ success: true, day: 47, clockSource: 'world', count: 1 });
        expect(r.transitions[0]).toMatchObject({ from: 'pending', to: 'due' });
        const p = await ledger({ action: 'process_due', worldId: W, currentDay: 49 });
        expect(p).toMatchObject({ day: 49, clockSource: 'param' });
    });

    it('knowledge, precedent and narrative stamps take the world day', async () => {
        const k = json(await handleKnowledgeManage({ action: 'record', worldId: W, key: 'cache', statement: 'The cache is under the mill', knowers: [{ id: 'marcus', how: 'witnessed' }] }, ctx as any));
        expect(k.knowers[0]).toMatch(/day 47/);
        const l = json(await handleKnowledgeManage({ action: 'learn', worldId: W, key: 'cache', knowerId: 'sol', how: 'told', fromId: 'marcus' }, ctx as any));
        expect(l.road).toMatch(/day 47/);
        const p = json(await handlePrecedentManage({ action: 'record', worldId: W, kind: 'ruling', statement: 'Sleet halves sight' }, ctx as any));
        expect(p.precedent.day).toBe(47);
        const s = json(await handlePrecedentManage({ action: 'supersede', worldId: W, precedentId: p.precedent.precedentId, statement: 'Sleet thirds sight', day: 50 }, ctx as any));
        expect(s.precedent.day).toBe(50);
        const note = json(await handleNarrativeManage({ action: 'add', worldId: W, type: 'bestiary', content: 'Rumour: a thing in the mill' }, ctx as any));
        const noteId = note.noteId ?? note.id ?? note.note?.id;
        const a = json(await handleNarrativeManage({ action: 'append', noteId, content: 'Tracks by the wheel' }, ctx as any));
        expect(a).toMatchObject({ stamp: 'Day 47, 06:00', clockSource: 'world' });
        const b = json(await handleNarrativeManage({ action: 'append', noteId, content: 'Tracks by the wheel', day: 12 }, ctx as any));
        expect(b).toMatchObject({ stamp: 'Day 12', clockSource: 'param' });
    });
});

describe('readers use the world clock', () => {
    it('the full status block shows the clock and weather in a two-world save', async () => {
        const b = await char({ action: 'get_status_block', characterId: 'marcus' });
        expect(b).toMatchObject({ day: 47, time: '06:00', weather: 'sleet' });
    });

    it('boot flags a debt the world day has reached as DUE', async () => {
        await ledger({ action: 'create', worldId: W, debtor: 'Marcus', creditor: 'Kenny', amount: 2000, dueDay: 46 });
        await ledger({ action: 'create', worldId: W, debtor: 'Marcus', creditor: 'Sol', amount: 400, dueDay: 60 });
        const res = await handleSessionManage({ action: 'boot', worldId: W }, ctx as any);
        const p = json(res);
        const debts = p.clocks.filter((c: any) => c.kind === 'debt');
        expect(debts.find((d: any) => /Kenny/.test(d.what)).due).toBe(true);
        expect(debts.find((d: any) => /Sol/.test(d.what)).due).toBe(false);
        expect(res.content[0].text).toMatch(/DUE \[pending\] day 46: Marcus owes Kenny/);
        expect(res.content[0].text).toMatch(/Clocks \(day 47, 06:00\)/);
    });

    it('get_context reports the stored day and time', async () => {
        const r = json(await handleSessionManage({ action: 'get_context', worldId: W, includeWorld: true }, ctx as any));
        expect(r.world ?? r.context?.world).toMatchObject({ day: 47, time: '06:00' });
    });
});
