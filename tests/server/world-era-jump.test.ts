import { handleWorldManage, WorldManageTool } from '../../src/server/consolidated/world-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../src/server/consolidated/character-manage.js';
import { handleNarrativeManage } from '../../src/server/consolidated/narrative-manage.js';
import { handleSessionManage } from '../../src/server/consolidated/session-manage.js';
import { handleLedgerManage } from '../../src/server/consolidated/ledger-manage.js';
import { buildBootPacket, renderBootPacket } from '../../src/server/boot-packet.js';
import { readWorldClock, clockWarning } from '../../src/engine/world-clock.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

// Deep One audit request 2: a campaign skips an era. The clock moves without
// time passing, the era label shows wherever the clock shows, the old age's
// threads are parked, its scheduled rows cancelled (on record, not deleted),
// and row-level ability state is fresh for the new age.
const W = 'm42';
const ctx = { sessionId: 'era' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const world = async (a: Record<string, unknown>) => json(await handleWorldManage(WorldManageTool.inputSchema.parse(a), ctx as any));
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const narrative = async (a: Record<string, unknown>) => json(await handleNarrativeManage(a, ctx as any));

let threadId: string;
let scheduleIds: number[];

beforeEach(async () => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    const worlds = new WorldRepository(db);
    worlds.create({ id: W, name: 'Deep One', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 47, time: '06:00' } } as any);
    worlds.create({ id: 'other', name: 'Other', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 3, time: '12:00' } } as any);
    const chars = new CharacterRepository(db);
    const base = { characterType: 'pc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 20, ac: 12, level: 1, createdAt: now, updatedAt: now };
    chars.create({ ...base, id: 'wake', name: 'Wake', abilities: [{ name: 'Tidal Surge', recharge: 5, ready: false }, { name: 'Brine Breath', ready: true }], legendaryActions: 3, legendaryActionsRemaining: 1, legendaryResistances: 2, legendaryResistancesRemaining: 0 } as any);
    chars.create({ ...base, id: 'tesk', name: 'Tesk' } as any);
    chars.create({ ...base, id: 'elsewhere', name: 'Elsewhere', abilities: [{ name: 'Far Roar', ready: false }] } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ? WHERE id IN (?, ?)').run(W, 'wake', 'tesk');
    db.prepare('UPDATE characters SET world_id = ? WHERE id = ?').run('other', 'elsewhere');

    // A wall-clock effect on Wake (expires_at set), a permanent one on Tesk.
    const insertEffect = db.prepare(`INSERT INTO custom_effects (target_id, target_type, name, source_type, category, power_level, mechanics, duration_type, duration_value, triggers, removal_conditions, is_active, created_at, expires_at)
                                     VALUES (?, 'character', ?, 'arcane', 'boon', 1, '[]', ?, ?, '[]', '[]', 1, ?, ?)`);
    insertEffect.run('wake', 'Blessing of the Tide', 'hours', 8, now, new Date(Date.now() + 8 * 3600e3).toISOString());
    insertEffect.run('tesk', 'Old Scar', 'permanent', null, now, null);

    const note = await narrative({ action: 'add', worldId: W, type: 'plot_thread', content: 'The Drowned Choir\nSomeone sings under the pier.' });
    threadId = note.noteId ?? note.id ?? note.note?.id;
    await narrative({ action: 'add', worldId: W, type: 'plot_thread', content: 'Already done', status: 'resolved' });
    await narrative({ action: 'add', worldId: 'other', type: 'plot_thread', content: 'Another campaign' });

    const a = await char({ action: 'schedule_change', characterId: 'wake', worldId: W, firesAtDay: 50, event: true, note: 'Sol calls' });
    const b = await char({ action: 'schedule_change', characterId: 'tesk', firesAtDay: 60, event: true, note: 'Tide turns' });
    await char({ action: 'schedule_change', characterId: 'elsewhere', worldId: 'other', firesAtDay: 5, event: true, note: 'Not ours' });
    scheduleIds = [a.scheduleId, b.scheduleId];
});
afterEach(() => closeDb());

describe('world_manage era_jump', () => {
    it('dryRun computes the full report and writes nothing', async () => {
        const r = await world({ action: 'era_jump', worldId: W, day: 1, time: '08:00', label: 'M42, after the Drowning', dryRun: true });
        expect(r).toMatchObject({ success: true, actionType: 'era_jump', dryRun: true, from: { day: 47, time: '06:00' }, to: { day: 1, time: '08:00', era: 'M42, after the Drowning' }, threadsAction: 'dormant', abilitiesReset: 1, effectsCleared: 1 });
        expect(r.threads).toEqual([{ id: threadId, title: 'The Drowned Choir', status: 'dormant' }]);
        expect([...r.scheduledCancelled].sort()).toEqual([...scheduleIds].sort());
        expect(r.message).toMatch(/Nothing was written/);

        const db = getDb();
        expect(readWorldClock(db, W)).toMatchObject({ day: 47, time: '06:00' });
        expect(readWorldClock(db, W)!.era).toBeUndefined();
        expect((db.prepare('SELECT status FROM narrative_notes WHERE id = ?').get(threadId) as any).status).toBe('active');
        expect((db.prepare('SELECT COUNT(*) AS n FROM scheduled_state_changes WHERE cancelled_at IS NOT NULL').get() as any).n).toBe(0);
        const wake = new CharacterRepository(db).findById('wake')!;
        expect(wake.abilities!.find(a => a.name === 'Tidal Surge')!.ready).toBe(false);
        expect(wake.legendaryActionsRemaining).toBe(1);
        expect((db.prepare('SELECT COUNT(*) AS n FROM custom_effects WHERE is_active = 1').get() as any).n).toBe(2);
    });

    it('a real run moves the clock by correction, writes the era, parks threads, cancels rows, resets abilities', async () => {
        const r = await world({ action: 'era_jump', worldId: W, day: 1, time: '08:00', label: 'M42' });
        expect(r).toMatchObject({ success: true, dryRun: false, from: { day: 47, time: '06:00' }, to: { day: 1, time: '08:00', era: 'M42' }, abilitiesReset: 1, effectsCleared: 1 });
        expect(r.elapsedHours).toBeUndefined();
        expect(r.regenerated).toBeUndefined();

        const db = getDb();
        expect(readWorldClock(db, W)).toMatchObject({ day: 1, time: '08:00', era: 'M42' });
        expect(readWorldClock(db, 'other')).toMatchObject({ day: 3 });
        // No regeneration: the correction path.
        expect(new CharacterRepository(db).findById('wake')!.hp).toBe(10);

        const thread = db.prepare('SELECT status, content FROM narrative_notes WHERE id = ?').get(threadId) as { status: string; content: string };
        expect(thread.status).toBe('dormant');
        expect(thread.content).toMatch(/── \[Day 47, 06:00\] ──\n\[era: M42\] parked at day 47/);
        expect((db.prepare("SELECT status FROM narrative_notes WHERE world_id = 'other'").get() as any).status).toBe('active');

        const cancelled = db.prepare('SELECT id, cancelled_at, fired FROM scheduled_state_changes WHERE cancelled_at IS NOT NULL ORDER BY id').all() as Array<{ id: number; cancelled_at: string; fired: number }>;
        expect(cancelled.map(c => c.id).sort()).toEqual([...scheduleIds].sort());
        expect(cancelled.every(c => c.fired === 0)).toBe(true);
        expect((db.prepare('SELECT COUNT(*) AS n FROM scheduled_state_changes').get() as any).n).toBe(3);

        const wake = new CharacterRepository(db).findById('wake')!;
        expect(wake.abilities!.every(a => a.ready)).toBe(true);
        expect(wake.legendaryActionsRemaining).toBe(3);
        expect(wake.legendaryResistancesRemaining).toBe(2);
        expect(new CharacterRepository(db).findById('elsewhere')!.abilities![0].ready).toBe(false);
        expect((db.prepare("SELECT is_active FROM custom_effects WHERE name = 'Blessing of the Tide'").get() as any).is_active).toBe(0);
        expect((db.prepare("SELECT is_active FROM custom_effects WHERE name = 'Old Scar'").get() as any).is_active).toBe(1);
    });

    it('threads: archived | keep and scheduled: keep are honoured; resetAbilities:false leaves rows alone', async () => {
        const r = await world({ action: 'era_jump', worldId: W, day: 1, label: 'M42', threads: 'archived', scheduled: 'keep', resetAbilities: false });
        expect(r).toMatchObject({ threadsAction: 'archived', scheduledCancelled: [], abilitiesReset: 0, effectsCleared: 0 });
        const db = getDb();
        expect((db.prepare('SELECT status FROM narrative_notes WHERE id = ?').get(threadId) as any).status).toBe('archived');
        expect((db.prepare('SELECT COUNT(*) AS n FROM scheduled_state_changes WHERE cancelled_at IS NOT NULL').get() as any).n).toBe(0);
        expect(new CharacterRepository(db).findById('wake')!.legendaryActionsRemaining).toBe(1);
        // time omitted keeps the stored time
        expect(r.to).toMatchObject({ day: 1, time: '06:00', era: 'M42' });

        const k = await world({ action: 'era_jump', worldId: W, day: 2, label: 'M43', threads: 'keep' });
        expect(k.threads).toEqual([]);
    });

    it('cancelled rows are hidden from list_scheduled and process_scheduled unless includeCancelled', async () => {
        await world({ action: 'era_jump', worldId: W, day: 100, label: 'M42' });
        const hidden = await char({ action: 'list_scheduled', worldId: W });
        expect(hidden.count).toBe(0);
        const shown = await char({ action: 'list_scheduled', worldId: W, includeCancelled: true });
        expect(shown.count).toBe(2);
        expect(shown.scheduled.every((s: any) => s.cancelled === true && s.cancelledAt)).toBe(true);
        // Day 100 is past both rows' fire days; nothing fires.
        const fired = await char({ action: 'process_scheduled', worldId: W });
        expect(fired.results ?? fired.fired ?? []).toHaveLength(0);
        expect(fired.message).toMatch(/nothing due/i);
        const boot = buildBootPacket(W);
        expect(boot.clocks.filter(c => c.kind === 'scheduled')).toHaveLength(0);
    });

    it('cancel_scheduled stamps cancelled_at by default and deletes with hard: true', async () => {
        const soft = await char({ action: 'cancel_scheduled', scheduleId: scheduleIds[0] });
        expect(soft).toMatchObject({ success: true, scheduleId: scheduleIds[0] });
        const db = getDb();
        expect((db.prepare('SELECT cancelled_at FROM scheduled_state_changes WHERE id = ?').get(scheduleIds[0]) as any).cancelled_at).toBeTruthy();
        const again = await char({ action: 'cancel_scheduled', scheduleId: scheduleIds[0] });
        expect(again.error).toBe(true);
        const hard = await char({ action: 'cancel_scheduled', scheduleId: scheduleIds[1], hard: true });
        expect(hard).toMatchObject({ success: true, deleted: true });
        expect(db.prepare('SELECT id FROM scheduled_state_changes WHERE id = ?').get(scheduleIds[1])).toBeUndefined();
        expect((await char({ action: 'list_scheduled', worldId: W })).count).toBe(0);
    });

    it('the era shows in the boot header, the status block and clockWarning', async () => {
        await world({ action: 'era_jump', worldId: W, day: 1, time: '08:00', label: 'M42', scheduled: 'keep' });
        const p = buildBootPacket(W);
        expect(p.era).toBe('M42');
        expect(renderBootPacket(p)).toMatch(/## Clocks \(day 1, 08:00 · era M42\)/);

        const sb = await handleCharacterManage({ action: 'get_status_block', characterId: 'wake' }, ctx as any);
        expect(json(sb).era).toBe('M42');
        expect(sb.content[0].text).toMatch(/D1 . 08:00 . M42/);

        // A thread stamped Day 47 is now ahead of the clock; the warning names the era.
        expect(clockWarning(getDb(), W)).toMatch(/Day 1, 08:00 · era M42/);

        const c = json(await handleSessionManage({ action: 'get_context', worldId: W, includeWorld: true }, ctx as any));
        expect((c.world ?? c.context?.world).era).toBe('M42');
    });

    it('boot warns when no day is set but scheduled or ledger rows wait on one', async () => {
        const db = getDb();
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: 'noclock', name: 'No Clock', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: {} } as any);
        expect(buildBootPacket('noclock').clockWarning).toBeUndefined();
        await handleLedgerManage({ action: 'create', worldId: 'noclock', debtor: 'Wake', creditor: 'Kenny', amount: 5, dueDay: 9 }, ctx as any);
        const p = buildBootPacket('noclock');
        expect(p.day).toBeNull();
        expect(p.clockWarning).toBe('no world day set — world_manage update {environment:{day,time}} or era_jump');
        expect(renderBootPacket(p)).toMatch(/⚠ CLOCK: no world day set/);
    });

    it('refuses an unknown world and is on the outer mirror', async () => {
        const r = await world({ action: 'era_jump', worldId: 'nope', day: 1, label: 'x' });
        expect(r.error).toBe(true);
        for (const k of ['day', 'time', 'label', 'threads', 'scheduled', 'resetAbilities', 'dryRun']) expect((WorldManageTool.inputSchema.shape as any)[k]).toBeDefined();
        expect((CharacterManageTool.inputSchema.shape as any).includeCancelled).toBeDefined();
        expect((CharacterManageTool.inputSchema.shape as any).hard).toBeDefined();
    });
});
