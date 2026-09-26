import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { handleItemManage } from '../../../src/server/consolidated/item-manage.js';
import { withOperation } from '../../../src/server/operation-guard.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { InventoryRepository } from '../../../src/storage/repos/inventory.repo.js';
import { CorpseRepository } from '../../../src/storage/repos/corpse.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { queryRolls } from '../../../src/storage/roll-log.js';

/**
 * Item 5: offerings. character_manage offer gives an item, a kill or a deed
 * to a god: the offering is consumed, favour moves through the family (so
 * rivals grow jealous), and the god's answer table is rolled with the
 * favour as its modifier.
 */
const W = 'altar-world';
const ctx = { sessionId: 'offer' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const char = withOperation('character_manage', async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any)));
const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx as any));
const repo = () => new CharacterRepository(getDb());
const pools = () => repo().findById('kor')!.resourcePools as Record<string, any>;

let skullId: string;

beforeEach(async () => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Altar', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    const base = { stats: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, ac: 12, level: 3, createdAt: now, updatedAt: now };
    repo().create({ id: 'kor', name: 'Kor', characterType: 'pc', hp: 20, maxHp: 20, resourcePools: { Slaanesh: { current: 5, max: 20 } }, ...base } as any);
    repo().create({ id: 'thrall', name: 'Thrall', characterType: 'npc', hp: 8, maxHp: 8, ...base } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ?').run(W);
    await rules({ action: 'define', kind: 'pool_family', name: 'Gods', spec: {
        pools: ['Khorne', 'Slaanesh'], max: 20,
        jealousy: { Khorne: { Slaanesh: 0.5 } },
        offering_values: { 'Brass Skull': 2, kill: 3, 'raze a shrine': 4 }
    } });
    await rules({ action: 'define', kind: 'roll_table', name: 'Khorne Answers', spec: {
        entries: [{ min: 1, max: 5, text: 'Silence' }, { min: 6, max: 30, text: 'Blood for the Blood God', apply: { condition: { name: 'Blood-mad' } } }]
    } });
    skullId = json(await handleItemManage({ action: 'create', name: 'Brass Skull', type: 'misc', weight: 1, value: 0 }, ctx as any)).item.id;
    new InventoryRepository(db).addItem('kor', skullId, 3);
});
afterEach(() => closeDb());

const qty = () => (getDb().prepare('SELECT quantity FROM inventory_items WHERE character_id = ? AND item_id = ?').get('kor', skullId) as any)?.quantity ?? 0;

describe('character_manage offer', () => {
    it('an item offering is consumed, moves favour with jealousy, and rolls the answer', async () => {
        const r = await char({ action: 'offer', characterId: 'kor', family: 'Gods', pool: 'khorne', offering: 'item', itemId: skullId, quantity: 2, answerTable: 'Khorne Answers', seed: 'altar' });
        expect(r.success).toBe(true);
        expect(r).toMatchObject({ value: 4, offering: 'item', consumed: { item: 'Brass Skull', quantity: 2 } });
        expect(r.favour).toMatchObject({ pool: 'Khorne', before: 0, current: 4 });
        expect(r.favour.rivals).toEqual([expect.objectContaining({ pool: 'Slaanesh', from: 5, to: 3 })]);
        expect(qty()).toBe(1);
        expect(pools().Khorne.history.at(-1).reason).toMatch(/offering: 2 × Brass Skull/);
        expect(r.answer).toMatchObject({ table: 'Khorne Answers', poolBonus: { pool: 'Khorne', bonus: 4 } });
        const row = queryRolls(getDb(), { forId: 'kor' })[0] as any;
        expect(row.purpose).toBe('table Khorne Answers');
        if (r.answer.entry.text !== 'Silence') expect(repo().findById('kor')!.conditions.map((c: any) => c.name)).toContain('Blood-mad');
    });

    it('a kill offering kills the victim and takes the kill value', async () => {
        const r = await char({ action: 'offer', characterId: 'kor', family: 'Gods', pool: 'Khorne', offering: 'kill', victimId: 'thrall' });
        expect(r).toMatchObject({ success: true, value: 3, consumed: { victim: 'Thrall' } });
        expect(repo().findById('thrall')!.hp).toBe(0);
        expect(new CorpseRepository(getDb()).findByCharacterId('thrall')).toBeTruthy();
        expect(pools().Khorne.current).toBe(3);
        expect(r.answer).toBeUndefined();
    });

    it('a deed reads offering_values in any case, or an explicit value', async () => {
        const a = await char({ action: 'offer', characterId: 'kor', family: 'Gods', pool: 'Khorne', offering: 'deed', deed: 'Raze a Shrine' });
        expect(a.value).toBe(4);
        const b = await char({ action: 'offer', characterId: 'kor', family: 'Gods', pool: 'Khorne', offering: 'deed', deed: 'Took a head', value: 1 });
        expect(b.value).toBe(1);
        expect(pools().Khorne.current).toBe(5);
    });

    it('refuses what it cannot price, what is not owned, and a pool outside the family; nothing is written', async () => {
        const before = JSON.stringify(pools());
        const bad = [
            await char({ action: 'offer', characterId: 'kor', family: 'Gods', pool: 'Khorne', offering: 'deed', deed: 'sang a hymn' }),
            await char({ action: 'offer', characterId: 'kor', family: 'Gods', pool: 'Khorne', offering: 'item', itemId: skullId, quantity: 9 }),
            await char({ action: 'offer', characterId: 'kor', family: 'Gods', pool: 'Nurgle', offering: 'item', itemId: skullId }),
            await char({ action: 'offer', characterId: 'kor', family: 'Gods', pool: 'Khorne', offering: 'kill', victimId: 'nobody' }),
            await char({ action: 'offer', characterId: 'kor', family: 'Gods', pool: 'Khorne', offering: 'item', itemId: skullId, answerTable: 'Missing' })
        ];
        for (const r of bad) expect(r).toMatchObject({ error: true, writes: 'none' });
        expect(JSON.stringify(pools())).toBe(before);
        expect(qty()).toBe(3);
    });

    it('apply: false previews the answer', async () => {
        const r = await char({ action: 'offer', characterId: 'kor', family: 'Gods', pool: 'Khorne', offering: 'deed', deed: 'raze a shrine', answerTable: 'Khorne Answers', apply: false });
        expect(r.answer.preview).toBe(true);
        expect(repo().findById('kor')!.conditions).toEqual([]);
    });
});
