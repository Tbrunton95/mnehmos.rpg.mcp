import { handleCongregationManage, CongregationManageTool } from '../../../src/server/consolidated/congregation-manage.js';
import { handleWorldManage, WorldManageTool } from '../../../src/server/consolidated/world-manage.js';
import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { ConsolidatedTools } from '../../../src/server/consolidated/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

/**
 * Item 4: congregations. A cult is one row (size, zeal) that yields favour
 * to its founder's god every in-fiction week; neglect costs zeal, and a
 * congregation at zeal 0 shrinks. process_weekly catches up whole weeks
 * from the world clock and credits the yield through the favour family.
 */
const W = 'cult-world';
const ctx = { sessionId: 'cong' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const cong = async (a: Record<string, unknown>) => json(await handleCongregationManage(CongregationManageTool.inputSchema.parse({ worldId: W, ...a }), ctx as any));
const world = async (a: Record<string, unknown>) => json(await handleWorldManage(WorldManageTool.inputSchema.parse(a), ctx as any));
const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx as any));
const pools = () => new CharacterRepository(getDb()).findById('kor')!.resourcePools as Record<string, any>;

beforeEach(async () => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Cult', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 10, time: '00:00' } } as any);
    new WorldRepository(db).create({ id: 'noclock', name: 'None', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    new CharacterRepository(db).create({ id: 'kor', name: 'Kor', characterType: 'pc', stats: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 12, level: 3, resourcePools: { Slaanesh: { current: 10, max: 100 } }, createdAt: now, updatedAt: now } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ?').run(W);
    await rules({ action: 'define', kind: 'pool_family', name: 'Gods', spec: { pools: ['Khorne', 'Slaanesh'], max: 100, jealousy: { Khorne: { Slaanesh: 0.5 } } } });
});
afterEach(() => closeDb());

const found = (a: Record<string, unknown> = {}) => cong({ action: 'create', name: 'Brass Hounds', god: 'Khorne', family: 'Gods', founderId: 'kor', location: 'Varnholt', size: 200, zeal: 5, ...a });

describe('congregation_manage', () => {
    it('is a registered consolidated tool', () => {
        expect(ConsolidatedTools.map(t => t.name)).toContain('congregation_manage');
    });

    it('create stamps the world clock; get and list read it back', async () => {
        const c = await found();
        expect(c).toMatchObject({ success: true, congregation: { name: 'Brass Hounds', god: 'Khorne', size: 200, zeal: 5, status: 'active', lastTendedDay: 10, lastProcessedDay: 10 } });
        const g = await cong({ action: 'get', congregationId: c.congregationId });
        expect(g.congregation).toMatchObject({ founderId: 'kor', location: 'Varnholt', family: 'Gods' });
        expect((await cong({ action: 'list' })).count).toBe(1);
        expect((await cong({ action: 'list', worldId: 'noclock' })).count).toBe(0);
    });

    it('advance reports due congregations; process_weekly yields through the family', async () => {
        const c = await found();
        const quiet = await world({ action: 'advance', worldId: W, days: 3 });
        expect(quiet.dueNow).toEqual({ scheduled: 0, debts: 0 });
        const adv = await world({ action: 'advance', worldId: W, days: 4 });
        expect(adv.dueNow).toMatchObject({ congregations: 1 });
        const r = await cong({ action: 'process_weekly' });
        expect(r).toMatchObject({ success: true, weeksProcessed: 1 });
        expect(r.results[0]).toMatchObject({ congregationId: c.congregationId, weeks: [expect.objectContaining({ week: 1, zeal: 5, size: 200, yield: 10 })] });
        expect(pools().Khorne.current).toBe(10);
        expect(pools().Slaanesh.current).toBe(5);
        expect(pools().Khorne.history.at(-1).reason).toMatch(/congregation Brass Hounds week 1/);
        // Nothing more is due until another whole week passes.
        expect((await cong({ action: 'process_weekly' })).weeksProcessed).toBe(0);
        expect((await world({ action: 'advance', worldId: W, days: 1 })).dueNow.congregations).toBeUndefined();
    });

    it('neglect costs zeal each untended week; tending resets it', async () => {
        const c = await found();
        await world({ action: 'advance', worldId: W, days: 21 });
        const r = await cong({ action: 'process_weekly' });
        expect(r.results[0].weeks.map((w: any) => [w.zeal, w.yield])).toEqual([[5, 10], [4, 8], [3, 6]]);
        expect(r.results[0].weeks[1].neglected).toBe(true);
        expect(pools().Khorne.current).toBe(24);
        await cong({ action: 'tend', congregationId: c.congregationId });
        await world({ action: 'advance', worldId: W, days: 7 });
        const r2 = await cong({ action: 'process_weekly' });
        expect(r2.results[0].weeks[0]).toMatchObject({ zeal: 3, yield: 6 });
        expect(r2.results[0].weeks[0].neglected).toBeUndefined();
    });

    it('zeal 0 shrinks the flock; size 0 disperses it and it yields nothing', async () => {
        const c = await found({ size: 10, zeal: 1 });
        await world({ action: 'advance', worldId: W, days: 14 });
        const r = await cong({ action: 'process_weekly' });
        expect(r.results[0].weeks[1]).toMatchObject({ zeal: 0, size: 9 });
        await cong({ action: 'strike', congregationId: c.congregationId, losses: 9 });
        const g = await cong({ action: 'get', congregationId: c.congregationId });
        expect(g.congregation).toMatchObject({ size: 0, status: 'dispersed' });
        await world({ action: 'advance', worldId: W, days: 7 });
        const before = pools().Khorne.current;
        expect((await cong({ action: 'process_weekly' })).weeksProcessed).toBe(0);
        expect(pools().Khorne.current).toBe(before);
    });

    it('weeklyYield overrides the formula; set, strike zeal, purge and delete', async () => {
        const c = await found({ weeklyYield: 3 });
        await world({ action: 'advance', worldId: W, days: 7 });
        expect((await cong({ action: 'process_weekly' })).results[0].weeks[0].yield).toBe(3);
        const s = await cong({ action: 'set', congregationId: c.congregationId, location: 'The Pit', weeklyYield: null });
        expect(s.congregation).toMatchObject({ location: 'The Pit', weeklyYield: null });
        const st = await cong({ action: 'strike', congregationId: c.congregationId, losses: 50, zealDelta: -2 });
        expect(st.congregation).toMatchObject({ size: 150, zeal: 3 });
        const p = await cong({ action: 'purge', congregationId: c.congregationId });
        expect(p.congregation.status).toBe('purged');
        expect((await cong({ action: 'list', status: 'active' })).count).toBe(0);
        expect((await cong({ action: 'delete', congregationId: c.congregationId })).success).toBe(true);
        expect((await cong({ action: 'get', congregationId: c.congregationId })).error).toBe(true);
    });

    it('refuses what it cannot do', async () => {
        expect((await cong({ action: 'create', name: 'x' })).error).toBe(true);
        expect((await cong({ action: 'process_weekly', worldId: 'noclock' })).message).toMatch(/clock/i);
        expect((await found({ founderId: 'nobody' })).error).toBe(true);
        expect((await found({ family: 'Nope' })).error).toBe(true);
    });
});
