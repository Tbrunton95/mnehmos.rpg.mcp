/**
 * Deep One audit, request 6: item_manage ergonomics.
 *  - value/weight default 0 on create
 *  - search accepts `query` as an alias of `name`; a filterless search warns
 *  - items carry a nullable world_id; worldId scopes search/list; scope_items
 *    stamps legacy rows
 *  - fractional value survives the round trip
 *  - the tool text names `item.id` for sequence references
 */
import { handleItemManage, ItemManageTool } from '../../../src/server/consolidated/item-manage.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'item-scope' } as any;
function parse(result: { content: Array<{ type: string; text: string }> }) {
    const m = result.content[0].text.match(/<!-- ITEM_MANAGE_JSON\n([\s\S]*?)\nITEM_MANAGE_JSON -->/);
    return m ? JSON.parse(m[1]) : null;
}
const create = async (args: Record<string, unknown>) => parse(await handleItemManage({ action: 'create', type: 'misc', ...args }, ctx));

describe('item_manage: audit request 6', () => {
    beforeEach(() => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        const worlds = new WorldRepository(db);
        for (const id of ['w-a', 'w-b']) worlds.create({ id, name: id, seed: 's', width: 4, height: 4, createdAt: now, updatedAt: now } as any);
    });
    afterEach(() => closeDb());

    it('defaults value and weight to 0 on create', async () => {
        const data = await create({ name: 'Pebble' });
        expect(data.success).toBe(true);
        expect(data.item.value).toBe(0);
        expect(data.item.weight).toBe(0);
    });

    it('keeps a fractional value through the round trip', async () => {
        const data = await create({ name: 'Salt pinch', value: 0.35, weight: 0.1 });
        const got = parse(await handleItemManage({ action: 'get', itemId: data.item.id }, ctx));
        expect(got.item.value).toBe(0.35);
        expect(got.item.weight).toBe(0.1);
        const found = parse(await handleItemManage({ action: 'search', name: 'salt', minValue: 0.3, maxValue: 0.4 }, ctx));
        expect(found.count).toBe(1);
    });

    it('search takes query as an alias of name; name wins when both are given', async () => {
        await create({ name: 'Iron Sword', type: 'weapon' });
        await create({ name: 'Oak Staff', type: 'weapon' });
        const byQuery = parse(await handleItemManage({ action: 'search', query: 'iron' }, ctx));
        expect(byQuery.count).toBe(1);
        expect(byQuery.items[0].name).toBe('Iron Sword');
        expect(byQuery.warning).toBeUndefined();
        const both = parse(await handleItemManage({ action: 'search', query: 'iron', name: 'oak' }, ctx));
        expect(both.count).toBe(1);
        expect(both.items[0].name).toBe('Oak Staff');
    });

    it('a search with no filter at all returns the catalogue with a warning', async () => {
        await create({ name: 'A' });
        await create({ name: 'B' });
        const all = parse(await handleItemManage({ action: 'search' }, ctx));
        expect(all.success).toBe(true);
        expect(all.count).toBe(2);
        expect(all.warning).toMatch(/no filter given; returning the whole catalogue/);
    });

    it('worldId scopes create, search and list; includeUnscoped adds legacy rows', async () => {
        const a = await create({ name: 'Brine knife', type: 'weapon', worldId: 'w-a' });
        expect(a.item.worldId).toBe('w-a');
        await create({ name: 'Brine net', worldId: 'w-b' });
        await create({ name: 'Brine rope' }); // legacy, unscoped

        const scoped = parse(await handleItemManage({ action: 'search', query: 'brine', worldId: 'w-a' }, ctx));
        expect(scoped.items.map((i: any) => i.name)).toEqual(['Brine knife']);

        const withLegacy = parse(await handleItemManage({ action: 'search', query: 'brine', worldId: 'w-a', includeUnscoped: true }, ctx));
        expect(withLegacy.items.map((i: any) => i.name).sort()).toEqual(['Brine knife', 'Brine rope']);

        const listed = parse(await handleItemManage({ action: 'list', worldId: 'w-b' }, ctx));
        expect(listed.items.map((i: any) => i.name)).toEqual(['Brine net']);
        const listedAll = parse(await handleItemManage({ action: 'list', worldId: 'w-b', includeUnscoped: true }, ctx));
        expect(listedAll.count).toBe(2);

        // No worldId: every row, as before.
        const everything = parse(await handleItemManage({ action: 'list' }, ctx));
        expect(everything.count).toBe(3);
    });

    it('scope_items stamps legacy rows by id or all at once, never restamping', async () => {
        const legacy1 = await create({ name: 'Old lamp' });
        const legacy2 = await create({ name: 'Old rope' });
        const owned = await create({ name: 'Owned', worldId: 'w-b' });

        const one = parse(await handleItemManage({ action: 'scope_items', worldId: 'w-a', itemIds: [legacy1.item.id, owned.item.id, 'nope'] }, ctx));
        expect(one.success).toBe(true);
        expect(one.rowsScoped).toBe(1);
        expect(one.scopedIds).toEqual([legacy1.item.id]);
        expect(one.alreadyScoped).toEqual([{ itemId: owned.item.id, worldId: 'w-b' }]);
        expect(one.missingIds).toEqual(['nope']);

        const rest = parse(await handleItemManage({ action: 'scope_items', worldId: 'w-a', all: true }, ctx));
        expect(rest.rowsScoped).toBe(1);
        expect(rest.scopedIds).toEqual([legacy2.item.id]);

        const again = parse(await handleItemManage({ action: 'scope_items', worldId: 'w-a', all: true }, ctx));
        expect(again.rowsScoped).toBe(0);

        const listed = parse(await handleItemManage({ action: 'list', worldId: 'w-a' }, ctx));
        expect(listed.count).toBe(2);
        expect(parse(await handleItemManage({ action: 'get', itemId: owned.item.id }, ctx)).item.worldId).toBe('w-b');
    });

    it('scope_items refuses when neither itemIds nor all is given', async () => {
        const res = parse(await handleItemManage({ action: 'scope_items', worldId: 'w-a' }, ctx));
        expect(res.error).toBeTruthy();
    });

    it('tool text names item.id for sequence references and the outer schema mirrors the new params', () => {
        expect(ItemManageTool.description).toContain('item.id');
        expect(ItemManageTool.description).toContain('{{step1.item.id}}');
        expect(ItemManageTool.description).toContain('scope_items');
        const shape = ItemManageTool.inputSchema.shape as Record<string, unknown>;
        for (const k of ['worldId', 'includeUnscoped', 'itemIds', 'all', 'query']) expect(shape[k], k).toBeDefined();
    });
});
