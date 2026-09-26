import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleInventoryManage, InventoryManageTool } from '../../../src/server/consolidated/inventory-manage.js';
import { handleItemManage } from '../../../src/server/consolidated/item-manage.js';
import { handleSessionManage } from '../../../src/server/consolidated/session-manage.js';
import { handleTableRules } from '../../../src/server/consolidated/table-rules.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { renderPoolLine } from '../../../src/render/pda.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const W = 'vorago';
const ctx = { sessionId: 'pools' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
// Every call goes through the outer schema first, so a param missing from
// the mirror fails here the way it would for the HTTP client.
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const inv = async (a: Record<string, unknown>) => json(await handleInventoryManage(InventoryManageTool.inputSchema.parse(a), ctx as any));
const pools = () => new CharacterRepository(getDb()).findById('luciel')!.resourcePools as Record<string, any>;

let tokenId: string;

beforeEach(async () => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Vorago', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    new CharacterRepository(db).create({
        id: 'luciel', name: 'Luciel', characterType: 'pc', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 }, hp: 180, maxHp: 200, ac: 20, level: 15,
        resourcePools: { corruption: { current: 12, max: 100 } },
        createdAt: now, updatedAt: now
    } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ?').run(W);
    tokenId = json(await handleItemManage({ action: 'create', name: "An'ggrath's Skull Token", type: 'misc', weight: 0, value: 0 }, ctx as any)).item.id;
    await inv({ action: 'give', characterId: 'luciel', itemId: tokenId });
});
afterEach(() => closeDb());

describe('pools as counters', () => {
    it('keeps its history: reason and witnesses survive a read', async () => {
        await char({ action: 'adjust_pool', characterId: 'luciel', pool: 'respect', value: 3, max: 10, reason: 'held the gate', witnesses: ['sol'] });
        const got = await char({ action: 'get', characterId: 'luciel' });
        expect(got.resourcePools.respect.history).toHaveLength(1);
        expect(got.resourcePools.respect.history[0]).toMatchObject({ from: 0, to: 3, set: 3, reason: 'held the gate', witnesses: ['sol'] });
    });

    it('carries a label, a note and a show flag, and changing them alone moves nothing', async () => {
        await char({ action: 'adjust_pool', characterId: 'luciel', pool: 'anggrath_calls', value: 3, max: 3 });
        const r = await char({ action: 'adjust_pool', characterId: 'luciel', pool: 'anggrath_calls', label: "An'ggrath's calls", note: 'owed to the Blood God', show: true });
        expect(r).toMatchObject({ before: 3, current: 3, max: 3, label: "An'ggrath's calls" });
        expect(pools().anggrath_calls).toMatchObject({ current: 3, max: 3, label: "An'ggrath's calls", note: 'owed to the Blood God', show: true });
        const d = await char({ action: 'adjust_pool', characterId: 'luciel', pool: 'anggrath_calls', delta: -1 });
        expect(d.message).toMatch(/3 -> 2 \(of 3\)/);
        expect(pools().anggrath_calls.label).toBe("An'ggrath's calls");
    });

    it('a linked item mirrors the pool; adjust_charges on it points to adjust_pool', async () => {
        const r = await char({ action: 'adjust_pool', characterId: 'luciel', pool: 'anggrath_calls', value: 3, max: 3, linkItem: tokenId });
        expect(r.item).toMatchObject({ name: "An'ggrath's Skull Token", charges: 3, max: 3 });
        const instanceId = pools().anggrath_calls.itemInstanceId;
        expect(instanceId).toMatch(/^inst-/);
        await char({ action: 'adjust_pool', characterId: 'luciel', pool: 'anggrath_calls', delta: -1 });
        const row = getDb().prepare('SELECT charges, charges_max FROM item_instances WHERE id = ?').get(instanceId) as any;
        expect(row).toEqual({ charges: 2, charges_max: 3 });
        const refused = await inv({ action: 'adjust_charges', characterId: 'luciel', itemId: tokenId, delta: -1 });
        expect(refused.error).toBe(true);
        expect(refused.message).toMatch(/adjust_pool.*anggrath_calls/);
        expect((getDb().prepare('SELECT charges FROM item_instances WHERE id = ?').get(instanceId) as any).charges).toBe(2);
    });

    it('a scheduled refill mirrors onto the linked item too', async () => {
        await char({ action: 'adjust_pool', characterId: 'luciel', pool: 'anggrath_calls', value: 1, max: 3, linkItem: tokenId });
        await char({ action: 'schedule_change', characterId: 'luciel', worldId: W, firesAtDay: 1, writes: [{ op: 'adjust_pool', pool: 'anggrath_calls', delta: 2 }], fireNow: true });
        const instanceId = pools().anggrath_calls.itemInstanceId;
        expect((getDb().prepare('SELECT charges FROM item_instances WHERE id = ?').get(instanceId) as any).charges).toBe(3);
    });

    it('an unlinked item keeps adjust_charges as before', async () => {
        const r = await inv({ action: 'adjust_charges', characterId: 'luciel', itemId: tokenId, value: 2, max: 5 });
        expect(r).toMatchObject({ success: true, current: 2, max: 5 });
    });

    it('the pool line prints current/max', () => {
        const line = renderPoolLine({ pool: 'calls', before: 3, current: 2, max: 3, delta: -1 }).flat().map(c => c.text).join('');
        expect(line).toMatch(/2\/3/);
    });
});

describe('shown counters', () => {
    beforeEach(async () => {
        await char({ action: 'adjust_pool', characterId: 'luciel', pool: 'anggrath_calls', value: 2, max: 3, label: "An'ggrath's calls", show: true, linkItem: tokenId });
        await char({ action: 'adjust_pool', characterId: 'luciel', pool: 'hidden_count', value: 1, max: 5 });
        await char({ action: 'adjust_pool', characterId: 'luciel', pool: 'psi', value: 4, max: 10, show: true });
    });

    it('reach the boot digest, with the core pool still detected', async () => {
        await handleTableRules({ action: 'define', worldId: W, kind: 'status_block', name: 'tiny-status', spec: { corePool: 'corruption', compact: true } }, ctx as any);
        const res = await handleSessionManage({ action: 'boot', worldId: W }, ctx as any);
        const p = json(res);
        expect(p.characters[0]).toMatchObject({ corruption: '12/100' });
        expect(p.characters[0].counters).toEqual([{ name: "An'ggrath's calls", value: '2/3', item: "An'ggrath's Skull Token" }]);
        const text = res.content[0].text;
        expect(text).toMatch(/Luciel: HP 180\/200 · CORRUPTION 12\/100/);
        expect(text).toMatch(/counters: An'ggrath's calls 2\/3/);
        expect(text).not.toMatch(/hidden_count|PSI/i);
    });

    it('reach the tiny status block', async () => {
        await handleTableRules({ action: 'define', worldId: W, kind: 'status_block', name: 'tiny-status', spec: { corePool: 'corruption', compact: true } }, ctx as any);
        const res = await handleCharacterManage({ action: 'get_status_block', characterId: 'luciel' }, ctx as any);
        const b = json(res);
        expect(b.counters).toEqual([{ name: "An'ggrath's calls", current: 2, max: 3 }]);
        expect(res.content[0].text).toMatch(/AN'GGRATH'S CALLS\s+2\/3/);
    });
});
