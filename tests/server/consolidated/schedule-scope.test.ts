import { handleWorldManage, WorldManageTool } from '../../../src/server/consolidated/world-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleSessionManage } from '../../../src/server/consolidated/session-manage.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

// Play report: another campaign's unscoped scheduled rows surfaced in KALMIS.
// A row belongs to a world by its own tag, or by its character's tag when it
// has none. Nothing else counts it, fires it, or offers to stamp it.
const K = 'kalmis';
const O = 'salt';
const ctx = { sessionId: 'sched-scope' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const world = async (a: Record<string, unknown>) => json(await handleWorldManage(WorldManageTool.inputSchema.parse(a), ctx as any));
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));

let ids: { mine: number; foreign: number; drifter: number };

const legacyRow = (characterId: string, day: number, note: string): number => {
    const r = getDb().prepare(`INSERT INTO scheduled_state_changes (character_id, fires_at_day, writes, note, created_at, is_event, world_id) VALUES (?, ?, '[]', ?, ?, 1, NULL)`)
        .run(characterId, day, note, new Date().toISOString());
    return Number(r.lastInsertRowid);
};

beforeEach(async () => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    const worlds = new WorldRepository(db);
    worlds.create({ id: K, name: 'Kalmis', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 47, time: '06:00' } } as any);
    worlds.create({ id: O, name: 'Salt', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 90, time: '12:00' } } as any);
    const chars = new CharacterRepository(db);
    const base = { characterType: 'pc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 20, ac: 12, level: 1, createdAt: now, updatedAt: now };
    chars.create({ ...base, id: 'luciel', name: 'Luciel' } as any);
    chars.create({ ...base, id: 'marrow', name: 'Marrow' } as any);
    chars.create({ ...base, id: 'drifter', name: 'Drifter' } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(K, 'luciel');
    db.prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(O, 'marrow');
    // Create the table through the tool, then plant legacy NULL rows.
    await char({ action: 'schedule_change', characterId: 'luciel', worldId: K, firesAtDay: 100, event: true, note: 'far future' });
    ids = { mine: legacyRow('luciel', 40, 'luciel legacy'), foreign: legacyRow('marrow', 41, 'salt legacy'), drifter: legacyRow('drifter', 42, 'drifter legacy') };
});
afterEach(() => closeDb());

describe('scheduled rows scope by their own tag or their character\'s', () => {
    it('schedule_change without worldId tags the row with the character\'s world', async () => {
        const r = await char({ action: 'schedule_change', characterId: 'luciel', firesAtDay: 50, event: true, note: 'tagged' });
        const row = getDb().prepare('SELECT world_id FROM scheduled_state_changes WHERE id = ?').get(r.scheduleId) as { world_id: string | null };
        expect(row.world_id).toBe(K);
    });

    it('process_scheduled fires this world\'s untagged rows, ignores another world\'s, and lists owner-unknown ids', async () => {
        const r = await char({ action: 'process_scheduled', worldId: K });
        expect(r.results.map((x: any) => x.scheduleId)).toEqual([ids.mine]);
        expect(r.unscopedOwnerUnknown).toEqual([ids.drifter]);
        expect(r.skippedUnscoped).toBeUndefined();
        expect(r.scopeWarning).toBeUndefined();
        expect(JSON.stringify(r)).not.toMatch(/stamps all/);
        const foreign = getDb().prepare('SELECT fired, world_id FROM scheduled_state_changes WHERE id = ?').get(ids.foreign) as any;
        expect(foreign).toEqual({ fired: 0, world_id: null });
    });

    it('a recurring untagged row fired in a world re-arms tagged to that world', async () => {
        getDb().prepare('UPDATE scheduled_state_changes SET recur_every_days = 30 WHERE id = ?').run(ids.mine);
        const r = await char({ action: 'process_scheduled', worldId: K });
        const next = r.results[0].rearmedAs;
        const row = getDb().prepare('SELECT world_id FROM scheduled_state_changes WHERE id = ?').get(next) as any;
        expect(row.world_id).toBe(K);
    });

    it('list_scheduled shows this world\'s rows only; owner-unknown ids are named apart', async () => {
        const r = await char({ action: 'list_scheduled', worldId: K });
        const listed = r.scheduled.map((x: any) => x.scheduleId);
        expect(listed).toContain(ids.mine);
        expect(listed).not.toContain(ids.foreign);
        expect(listed).not.toContain(ids.drifter);
        expect(r.unscopedOwnerUnknown).toEqual([ids.drifter]);
    });

    it('world_manage advance counts this world\'s untagged due rows', async () => {
        const r = await world({ action: 'advance', worldId: K, hours: 1 });
        expect(r.dueNow.scheduled).toBe(1);
    });

    it('boot and get_context show no foreign rows, and do show a row tagged here on an untagged character', async () => {
        await char({ action: 'schedule_change', characterId: 'drifter', worldId: K, firesAtDay: 43, event: true, note: 'drifter tagged here' });
        const boot = await handleSessionManage({ action: 'boot', worldId: K }, ctx as any);
        const text = boot.content[0].text;
        expect(text).toContain('luciel legacy');
        expect(text).not.toContain('salt legacy');
        expect(text).not.toContain('drifter legacy');
        expect(text).toContain('drifter tagged here');
        const c = json(await handleSessionManage({ action: 'get_context', worldId: K, includeWorld: true }, ctx as any));
        const sched = c.scheduled ?? c.context?.scheduled;
        expect(sched.due.map((d: any) => d.scheduleId)).toEqual([ids.mine, ids.drifter + 1]);
    });

    it('boot lists due rows before future ones', async () => {
        for (let i = 0; i < 9; i++) await char({ action: 'schedule_change', characterId: 'luciel', worldId: K, firesAtDay: 20 + i, event: true, note: `old ${i}` });
        // Push the old ones into the future so only the legacy row is due.
        getDb().prepare("UPDATE scheduled_state_changes SET fires_at_day = fires_at_day + 100 WHERE note LIKE 'old %'").run();
        const p = json(await handleSessionManage({ action: 'boot', worldId: K }, ctx as any));
        const clocks = (p.clocks ?? []).filter((c: any) => c.kind === 'scheduled');
        expect(clocks[0]).toMatchObject({ due: true });
        expect(clocks[0].what).toContain('luciel legacy');
    });
});

describe('scope_scheduled', () => {
    it('with no ids stamps only untagged rows on this world\'s characters', async () => {
        const r = await char({ action: 'scope_scheduled', worldId: K });
        expect(r.rowsScoped).toBe(1);
        const rows = getDb().prepare('SELECT id, world_id FROM scheduled_state_changes WHERE id IN (?, ?, ?)').all(ids.mine, ids.foreign, ids.drifter) as any[];
        expect(Object.fromEntries(rows.map(x => [x.id, x.world_id]))).toEqual({ [ids.mine]: K, [ids.foreign]: null, [ids.drifter]: null });
    });

    it('refuses a row whose character belongs to another world, naming the owner', async () => {
        const r = await char({ action: 'scope_scheduled', worldId: K, scheduleIds: [ids.foreign] });
        expect(r.rowsScoped).toBe(0);
        expect(r.refusedOtherWorld).toEqual([expect.objectContaining({ scheduleId: ids.foreign, ownedBy: O })]);
        const row = getDb().prepare('SELECT world_id FROM scheduled_state_changes WHERE id = ?').get(ids.foreign) as any;
        expect(row.world_id).toBeNull();
    });

    it('accepts an untagged character\'s row by explicit id, and the owner can claim its own', async () => {
        const r = await char({ action: 'scope_scheduled', worldId: K, scheduleIds: [ids.drifter] });
        expect(r.rowsScoped).toBe(1);
        const s = await char({ action: 'scope_scheduled', worldId: O, scheduleIds: [ids.foreign] });
        expect(s.rowsScoped).toBe(1);
    });

    it('preview reports and writes nothing; the single scheduleId lane still works', async () => {
        const p = await char({ action: 'scope_scheduled', worldId: K, scheduleIds: [ids.drifter, ids.foreign], preview: true });
        expect(p).toMatchObject({ preview: true, wouldScope: 1 });
        expect((getDb().prepare('SELECT COUNT(*) AS n FROM scheduled_state_changes WHERE world_id IS NULL').get() as any).n).toBe(3);
        const one = await char({ action: 'scope_scheduled', worldId: K, scheduleId: ids.mine });
        expect(one.rowsScoped).toBe(1);
    });
});
