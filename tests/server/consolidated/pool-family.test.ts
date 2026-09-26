import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { parseRuleSpec, DATA_KINDS } from '../../../src/engine/table-rules.js';
import { applyFamilyDelta } from '../../../src/engine/pool-family.js';
import { applyScheduledOps, scheduledWriteOpSchema } from '../../../src/engine/scheduled-ops.js';

/**
 * Item 3: favour families. A pool_family rule groups pools (the four gods'
 * favour); a gain in one makes its rivals jealous. adjust_pool {family}
 * moves the pool and its rivals together, with history on each.
 */
const W = 'mortal-realms';
const ctx = { sessionId: 'family' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx as any));
const pools = () => new CharacterRepository(getDb()).findById('kharn')!.resourcePools as Record<string, any>;

const GODS = {
    pools: ['Khorne', 'Tzeentch', 'Nurgle', 'Slaanesh'],
    max: 20,
    floor: -10,
    jealousy: { Khorne: { Slaanesh: 0.5 }, Nurgle: { Tzeentch: 1 } },
    offering_values: { skull: 2, kill: 3 }
};

describe('pool_family spec', () => {
    it('is a data kind with defaults', () => {
        expect(DATA_KINDS.has('pool_family')).toBe(true);
        const spec = parseRuleSpec('pool_family', { pools: ['a'] });
        expect(spec).toMatchObject({ pools: ['a'], jealousy: {}, offering_values: {} });
        expect(() => parseRuleSpec('pool_family', { pools: [] })).toThrow();
        expect(() => parseRuleSpec('pool_family', { pools: ['a'], jealousy: { a: { b: -1 } } })).toThrow();
    });
});

describe('applyFamilyDelta', () => {
    const fam = { name: 'Gods', spec: parseRuleSpec('pool_family', GODS) };

    it('a gain makes rivals lose round(gain × fraction), with history on each', () => {
        const { pools: out, moves } = applyFamilyDelta({ Khorne: { current: 2, max: 20 }, Slaanesh: { current: 4, max: 20 } }, fam, 'khorne', 3, 'skulls');
        expect(out.Khorne.current).toBe(5);
        expect(out.Slaanesh.current).toBe(2);
        expect(moves).toEqual([
            expect.objectContaining({ pool: 'Khorne', from: 2, to: 5, delta: 3 }),
            expect.objectContaining({ pool: 'Slaanesh', from: 4, to: 2, delta: -2, rival: true })
        ]);
        expect(out.Khorne.history.at(-1)).toMatchObject({ from: 2, to: 5, reason: 'skulls' });
        expect(out.Slaanesh.history.at(-1)).toMatchObject({ from: 4, to: 2, reason: expect.stringMatching(/jealous.*Khorne/i) });
    });

    it('jealousy never reaches a pool outside the family', () => {
        const leaky = { name: 'Gods', spec: parseRuleSpec('pool_family', { ...GODS, jealousy: { Khorne: { gold: 1, Slaanesh: 0.5 } } }) };
        const { pools: out, moves } = applyFamilyDelta({ Khorne: { current: 2, max: 20 }, Slaanesh: { current: 4, max: 20 }, gold: { current: 5, max: 100 } }, leaky, 'Khorne', 4, 'skulls');
        expect(out.gold).toEqual({ current: 5, max: 100 });
        expect(moves.map(m => m.pool)).toEqual(['Khorne', 'Slaanesh']);
    });

    it('a loss moves no rival; the family floor and max clamp', () => {
        const a = applyFamilyDelta({ Khorne: { current: 2, max: 20 }, Slaanesh: { current: 4, max: 20 } }, fam, 'Khorne', -30, 'shamed');
        expect(a.pools.Khorne.current).toBe(-10);
        expect(a.pools.Slaanesh.current).toBe(4);
        expect(a.moves).toHaveLength(1);
        const b = applyFamilyDelta({}, fam, 'Nurgle', 50, 'plague');
        expect(b.pools.Nurgle).toMatchObject({ current: 20, max: 20 });
        expect(b.pools.Tzeentch.current).toBe(-10);
    });
});

describe('scheduled ops', () => {
    it('writes reason to pool history and names the condition source', () => {
        const ops = [scheduledWriteOpSchema().parse({ op: 'adjust_pool', pool: 'warp', delta: 2 }), { op: 'add_condition' as const, name: 'Marked' }];
        const r = applyScheduledOps({ hp: 5, maxHp: 5, resourcePools: { warp: { current: 1, max: 10 } } } as any, ops, { defaultSource: 'table Eye', reason: 'Eye of the Gods' });
        expect((r.updates.resourcePools as any).warp).toMatchObject({ current: 3, history: [expect.objectContaining({ from: 1, to: 3, reason: 'Eye of the Gods' })] });
        expect((r.updates.conditions as any)[0]).toMatchObject({ name: 'Marked', source: 'table Eye' });
    });
});

describe('adjust_pool {family}', () => {
    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Mortal Realms', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        new CharacterRepository(db).create({
            id: 'kharn', name: 'Kharn', characterType: 'pc', stats: { str: 18, dex: 12, con: 16, int: 8, wis: 10, cha: 10 }, hp: 30, maxHp: 30, ac: 16, level: 5,
            resourcePools: { slaanesh: { current: 6, max: 20 } }, createdAt: now, updatedAt: now
        } as any);
        try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
        db.prepare('UPDATE characters SET world_id = ?').run(W);
        await rules({ action: 'define', kind: 'pool_family', name: 'Gods', spec: GODS });
    });
    afterEach(() => closeDb());

    it('moves the pool and its jealous rivals, and reports rivals[]', async () => {
        const r = await char({ action: 'adjust_pool', characterId: 'kharn', pool: 'Khorne', delta: 4, family: 'Gods', reason: 'skull tower' });
        expect(r.success).toBe(true);
        expect(r).toMatchObject({ pool: 'Khorne', before: 0, current: 4, max: 20, family: 'Gods' });
        expect(r.rivals).toEqual([expect.objectContaining({ pool: 'slaanesh', from: 6, to: 4, delta: -2 })]);
        const p = pools();
        expect(p.Khorne.current).toBe(4);
        expect(p.slaanesh.current).toBe(4);
        expect(p.slaanesh.history.at(-1).reason).toMatch(/Khorne/);
    });

    it('refuses value with family, a pool outside the family, and an unknown family, writing nothing', async () => {
        const a = await char({ action: 'adjust_pool', characterId: 'kharn', pool: 'Khorne', value: 4, family: 'Gods' });
        expect(a).toMatchObject({ error: true, writes: 'none' });
        const b = await char({ action: 'adjust_pool', characterId: 'kharn', pool: 'corruption', delta: 1, family: 'Gods' });
        expect(b).toMatchObject({ error: true, writes: 'none' });
        expect(b.message).toMatch(/Khorne/);
        const c = await char({ action: 'adjust_pool', characterId: 'kharn', pool: 'Khorne', delta: 1, family: 'Nope' });
        expect(c).toMatchObject({ error: true, writes: 'none' });
        expect(pools()).toEqual({ slaanesh: { current: 6, max: 20 } });
    });

    it('without family a pool still clamps at 0', async () => {
        const r = await char({ action: 'adjust_pool', characterId: 'kharn', pool: 'slaanesh', delta: -50 });
        expect(r.current).toBe(0);
    });
});
