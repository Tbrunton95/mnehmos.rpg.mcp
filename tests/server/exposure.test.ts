import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleWorldManage, WorldManageTool } from '../../src/server/consolidated/world-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../src/server/consolidated/character-manage.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { tickExposure } from '../../src/engine/exposure.js';

// Deep One audit request 10: exposure timers. Brine-bound is `dry_hours
// +1/h, at 12 → a condition`: the pool climbs with world_manage advance,
// clamps at its cap, adds the condition once, and never moves on a clock
// correction. advance {fireScheduled} fires the due rows in the same call.
const W = 'deep';
const ctx = { sessionId: 'exposure' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const world = async (a: Record<string, unknown>) => json(await handleWorldManage(WorldManageTool.inputSchema.parse(a), ctx as any));
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const brine = { action: 'set_exposure', characterId: 'wake', name: 'brine-bound', pool: 'dry_hours', perHour: 1, cap: 12, thresholds: [{ at: 12, condition: { name: 'Drying Out', effect: 'disadvantage on CON checks until submerged' } }], note: 'Out of the water' };

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    const worlds = new WorldRepository(db);
    worlds.create({ id: W, name: 'Deep One', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 47, time: '06:00' } } as any);
    worlds.create({ id: 'other', name: 'Other', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 3, time: '12:00' } } as any);
    const chars = new CharacterRepository(db);
    const base = { characterType: 'pc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 20, ac: 12, level: 1, createdAt: now, updatedAt: now };
    chars.create({ ...base, id: 'wake', name: 'Wake' } as any);
    chars.create({ ...base, id: 'tesk', name: 'Tesk' } as any);
    chars.create({ ...base, id: 'elsewhere', name: 'Elsewhere' } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ? WHERE id IN (?, ?)').run(W, 'wake', 'tesk');
    db.prepare('UPDATE characters SET world_id = ? WHERE id = ?').run('other', 'elsewhere');
});
afterEach(() => closeDb());

const pools = (id: string) => (new CharacterRepository(getDb()).findById(id) as any).resourcePools as Record<string, { current: number; max: number }>;
const conditionNames = (id: string) => ((new CharacterRepository(getDb()).findById(id) as any).conditions ?? []).map((c: { name: string }) => c.name);

describe('character_manage set_exposure / clear_exposure', () => {
    it('set creates the pool at 0/cap, get lists the timer, set again upserts by name, clear removes it', async () => {
        const r = await char(brine);
        expect(r).toMatchObject({ success: true, actionType: 'set_exposure', characterId: 'wake', replaced: false, poolCreated: true, pool: { name: 'dry_hours', current: 0, max: 12 } });
        expect(pools('wake').dry_hours).toMatchObject({ current: 0, max: 12 });

        const sheet = await char({ action: 'get', characterId: 'wake' });
        expect(sheet.exposure).toEqual([{ name: 'brine-bound', pool: 'dry_hours', perHour: 1, cap: 12, thresholds: [{ at: 12, condition: { name: 'Drying Out', effect: 'disadvantage on CON checks until submerged' } }], note: 'Out of the water' }]);

        const again = await char({ ...brine, perHour: 2 });
        expect(again).toMatchObject({ replaced: true, poolCreated: false });
        expect((await char({ action: 'get', characterId: 'wake' })).exposure).toHaveLength(1);

        const cleared = await char({ action: 'clear_exposure', characterId: 'wake', name: 'brine-bound' });
        expect(cleared).toMatchObject({ success: true, removed: ['brine-bound'], remaining: [] });
        expect((await char({ action: 'get', characterId: 'wake' })).exposure).toBeUndefined();
        // The pool keeps its value unless removePool is asked for.
        expect(pools('wake').dry_hours).toMatchObject({ current: 0, max: 12 });
        await char(brine);
        await char({ action: 'clear_exposure', characterId: 'wake', removePool: true });
        expect(pools('wake').dry_hours).toBeUndefined();
    });

    it('refuses an unknown character and a timer without a pool', async () => {
        const r = await char({ ...brine, characterId: 'nobody' });
        expect(r.error).toBeTruthy();
        const bad = await char({ action: 'set_exposure', characterId: 'wake', name: 'x', perHour: 1 });
        expect(bad.error).toBeTruthy();
    });
});

describe('world_manage advance ticks exposure', () => {
    it('13h on a +1/h timer capped at 12 lands at 12, adds the condition once, and reports it', async () => {
        await char(brine);
        const r = await world({ action: 'advance', worldId: W, hours: 13 });
        expect(r.success).toBe(true);
        expect(r.exposure).toEqual([{ characterId: 'wake', name: 'brine-bound', pool: 'dry_hours', from: 0, to: 12, conditionsAdded: ['Drying Out'] }]);
        expect(r.message).toMatch(/exposure: brine-bound dry_hours 0→12 \+Drying Out/);
        expect(pools('wake').dry_hours).toMatchObject({ current: 12, max: 12 });
        expect(conditionNames('wake')).toEqual(['Drying Out']);
        const cond = (new CharacterRepository(getDb()).findById('wake') as any).conditions[0];
        expect(cond.source).toBe('disadvantage on CON checks until submerged');

        // Fired once: the GM removes the condition, the clock moves on, nothing re-adds it.
        await char({ action: 'update', characterId: 'wake', removeConditions: ['Drying Out'] });
        const r2 = await world({ action: 'advance', worldId: W, hours: 5 });
        expect(r2.exposure).toEqual([{ characterId: 'wake', name: 'brine-bound', pool: 'dry_hours', from: 12, to: 12, conditionsAdded: [] }]);
        expect(conditionNames('wake')).toEqual([]);
        const stored = JSON.parse((getDb().prepare('SELECT exposure FROM characters WHERE id = ?').get('wake') as any).exposure);
        expect(stored[0].fired).toEqual(['12:Drying Out']);
    });

    it('fractional hours accumulate as floats and only this world ticks', async () => {
        await char(brine);
        await char({ ...brine, characterId: 'elsewhere' });
        const r = await world({ action: 'advance', worldId: W, minutes: 90 });
        expect(r.exposure).toEqual([{ characterId: 'wake', name: 'brine-bound', pool: 'dry_hours', from: 0, to: 1.5, conditionsAdded: [] }]);
        await world({ action: 'advance', worldId: W, minutes: 90 });
        expect(pools('wake').dry_hours.current).toBe(3);
        expect(pools('elsewhere').dry_hours.current).toBe(0);
    });

    it('a correction never ticks; a plain update does not either', async () => {
        await char(brine);
        const c = await world({ action: 'update', worldId: W, environment: { day: 48, time: '06:00' }, correction: true });
        expect(c.correction.deltaHours).toBe(24);
        expect(c.exposure).toBeUndefined();
        expect(pools('wake').dry_hours.current).toBe(0);
        expect(conditionNames('wake')).toEqual([]);
        await world({ action: 'update', worldId: W, environment: { day: 48, time: '10:00' } });
        expect(pools('wake').dry_hours.current).toBe(0);
    });

    it('the tick is pure arithmetic: once:false re-adds, negative perHour drains, clamp at 0', () => {
        const entry = { name: 'thaw', pool: 'cold', perHour: -2, thresholds: [{ at: 4, condition: { name: 'Shivering' }, once: false }] };
        const t = tickExposure('x', [entry], { cold: { current: 10, max: 10 } }, [], 4);
        expect(t.lines[0]).toMatchObject({ from: 10, to: 2, conditionsAdded: ['Shivering'] });
        expect(t.entries[0].fired).toBeUndefined();
        const t2 = tickExposure('x', t.entries, t.pools, [], 4);
        expect(t2.lines[0]).toMatchObject({ from: 2, to: 0, conditionsAdded: [] });
        // Crossing it again from below re-adds when once is false.
        const t3 = tickExposure('x', [{ ...entry, perHour: 3 }], t2.pools, [], 2);
        expect(t3.lines[0]).toMatchObject({ from: 0, to: 6, conditionsAdded: ['Shivering'] });
    });
});

describe('world_manage advance {fireScheduled}', () => {
    it('fires the due live rows of the world, skips cancelled ones and other worlds, and reports fired[]', async () => {
        const due = await char({ action: 'schedule_change', characterId: 'wake', worldId: W, firesInHours: 6, writes: [{ op: 'adjust_hp', delta: -3 }], note: 'the salt bites' });
        const cancelled = await char({ action: 'schedule_change', characterId: 'tesk', worldId: W, firesInHours: 6, writes: [{ op: 'adjust_hp', delta: -9 }], note: 'never' });
        await char({ action: 'cancel_scheduled', scheduleId: cancelled.scheduleId });
        const later = await char({ action: 'schedule_change', characterId: 'wake', worldId: W, firesInHours: 48, event: true, note: 'Sol calls' });
        await char({ action: 'schedule_change', characterId: 'elsewhere', worldId: 'other', firesAtDay: 1, event: true, note: 'not ours' });

        const counted = await world({ action: 'advance', worldId: W, hours: 1 });
        expect(counted.fired).toBeUndefined();
        expect(counted.dueNow.scheduled).toBe(0);

        const r = await world({ action: 'advance', worldId: W, hours: 7, fireScheduled: true });
        expect(r.firedCount).toBe(1);
        expect(r.fired).toEqual([expect.objectContaining({ scheduleId: due.scheduleId, characterId: 'wake', applied: ['hp: 10 → 7'] })]);
        expect(r.dueNow.scheduled).toBe(0);
        expect(r.message).toMatch(/fired 1 scheduled row/);
        expect((new CharacterRepository(getDb()).findById('wake') as any).hp).toBe(7);
        expect((new CharacterRepository(getDb()).findById('tesk') as any).hp).toBe(10);

        const rows = getDb().prepare('SELECT id, fired, cancelled_at FROM scheduled_state_changes ORDER BY id').all() as Array<{ id: number; fired: number; cancelled_at: string | null }>;
        expect(rows.find(x => x.id === due.scheduleId)!.fired).toBe(1);
        expect(rows.find(x => x.id === cancelled.scheduleId)).toMatchObject({ fired: 0 });
        expect(rows.find(x => x.id === cancelled.scheduleId)!.cancelled_at).not.toBeNull();
        expect(rows.find(x => x.id === later.scheduleId)!.fired).toBe(0);
        expect(rows.filter(x => x.fired === 1)).toHaveLength(1);

        // process_scheduled finds nothing left for the fired row.
        const p = await char({ action: 'process_scheduled', worldId: W });
        expect(p.firedCount).toBe(0);
    });
});

describe('status block footer', () => {
    it('shows exposure: dry_hours 7/12 on the full block and the compact block', async () => {
        await char(brine);
        await world({ action: 'advance', worldId: W, hours: 7 });
        const full = await char({ action: 'get_status_block', characterId: 'wake' });
        expect(full.footer).toEqual(['exposure: dry_hours 7/12']);
        expect(full.exposure).toEqual([{ name: 'brine-bound', pool: 'dry_hours', perHour: 1, current: 7, cap: 12 }]);
        const res = await handleCharacterManage({ action: 'get_status_block', characterId: 'wake' }, ctx as any);
        expect(res.content[0].text).toMatch(/exposure: dry_hours 7\/12/);

        getDb().prepare(`INSERT INTO table_rules (id, world_id, kind, name, spec, enabled, created_at, updated_at) VALUES ('sb', ?, 'status_block', 'tiny', ?, 1, 'now', 'now')`)
            .run(W, JSON.stringify({ compact: true, corePool: 'dry_hours', footer: ['location'] }));
        const compact = await char({ action: 'get_status_block', characterId: 'wake' });
        expect(compact.compact).toBe(true);
        expect(compact.footer).toEqual(['exposure: dry_hours 7/12']);
    });

    it('the outer mirror carries every set_exposure and advance param', () => {
        const shape = CharacterManageTool.inputSchema.shape as Record<string, unknown>;
        for (const k of ['perHour', 'cap', 'thresholds', 'pool', 'name', 'note', 'removePool']) expect(shape[k], k).toBeDefined();
        expect((WorldManageTool.inputSchema.shape as Record<string, unknown>).fireScheduled).toBeDefined();
    });
});
