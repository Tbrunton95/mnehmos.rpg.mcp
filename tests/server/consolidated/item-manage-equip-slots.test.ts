/**
 * Play report 4 #3: equippable custom items.
 *  - item_manage create/update take `equipSlots` (top level) and write it to
 *    properties.equipSlots; update merges it into the stored properties even
 *    without mergeProperties; [] deletes the key so the type defaults return
 *  - properties.equipSlots is validated on write: an unknown slot is refused
 *    with the nearest slot, writes: 'none'; top-level and properties values
 *    that disagree are refused
 *  - first coverage of update {properties, mergeProperties: true}
 *  - EQUIP_SLOTS is the one slot list; the outer schema mirrors equipSlots
 */
import { handleItemManage, ItemManageTool } from '../../../src/server/consolidated/item-manage.js';
import { EQUIP_SLOTS } from '../../../src/schema/inventory.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'item-equip-slots' } as any;
function parse(result: { content: Array<{ type: string; text: string }> }) {
    const m = result.content[0].text.match(/<!-- ITEM_MANAGE_JSON\n([\s\S]*?)\nITEM_MANAGE_JSON -->/);
    return m ? JSON.parse(m[1]) : null;
}
const call = async (args: Record<string, unknown>) => parse(await handleItemManage(args, ctx));
const create = async (args: Record<string, unknown>) => call({ action: 'create', type: 'misc', ...args });
const stored = async (itemId: string) => (await call({ action: 'get', itemId })).item;

describe('item_manage: equippable custom items (play report 4 #3)', () => {
    beforeEach(() => {
        closeDb();
        getDb(':memory:');
    });
    afterEach(() => closeDb());

    it('EQUIP_SLOTS is the one slot list', () => {
        expect([...EQUIP_SLOTS]).toEqual(['mainhand', 'offhand', 'armor', 'head', 'feet', 'accessory', 'accessory2', 'accessory3']);
    });

    describe('create', () => {
        it('writes a top-level equipSlots into properties.equipSlots beside the other properties', async () => {
            const data = await create({ name: 'Dosimeter', properties: { rads: true }, equipSlots: ['accessory'] });
            expect(data.success).toBe(true);
            expect(data.item.properties).toEqual({ rads: true, equipSlots: ['accessory'] });
            expect(data.equipSlots).toEqual(['accessory']);
            expect(data.message).toContain('accessory');
            expect((await stored(data.item.id)).properties.equipSlots).toEqual(['accessory']);
        });

        it('refuses an unknown slot inside properties.equipSlots with the nearest slot and writes nothing', async () => {
            const data = await create({ name: 'Glove', properties: { equipSlots: ['mainhnd'] } });
            expect(data.error).toBe(true);
            expect(data.writes).toBe('none');
            expect(data.message).toMatch(/mainhnd/);
            expect(data.message).toMatch(/nearest.*'mainhand'/);
            expect(data.message).toContain(EQUIP_SLOTS.join(', '));
            expect((await call({ action: 'list' })).count).toBe(0);
        });

        it('refuses a non-array properties.equipSlots and writes nothing', async () => {
            const result = await handleItemManage({ action: 'create', type: 'misc', name: 'Glove', properties: { equipSlots: 'mainhand' } }, ctx);
            const data = parse(result);
            expect(data.error).toBe(true);
            expect(data.writes).toBe('none');
            expect(data.message).toMatch(/equipSlots must be an array/);
            // The rendered card carries the NO WRITE stamp.
            expect(result.content[0].text).toContain('NO WRITE');
            expect((await call({ action: 'list' })).count).toBe(0);
        });

        it('refuses an unknown top-level slot before the handler, naming the slot list', async () => {
            const data = await create({ name: 'Glove', equipSlots: ['mainhnd'] });
            expect(data.error).toBe('validation_error');
            expect(data.writes).toBe('none');
            expect(JSON.stringify(data.issues)).toContain('mainhand');
            expect((await call({ action: 'list' })).count).toBe(0);
        });

        it('refuses when equipSlots and properties.equipSlots disagree; accepts them when they agree', async () => {
            const clash = await create({ name: 'Glove', equipSlots: ['head'], properties: { equipSlots: ['feet'] } });
            expect(clash.error).toBe(true);
            expect(clash.writes).toBe('none');
            expect(clash.message).toMatch(/disagree/);
            expect((await call({ action: 'list' })).count).toBe(0);

            const same = await create({ name: 'Glove', equipSlots: ['head', 'feet'], properties: { equipSlots: ['feet', 'head'] } });
            expect(same.success).toBe(true);
            expect(same.item.properties.equipSlots).toEqual(['head', 'feet']);
        });

        it('a slot named twice is written once, in both forms', async () => {
            const top = await create({ name: 'Visor', equipSlots: ['head', 'head', 'accessory'] });
            expect(top.success).toBe(true);
            expect(top.item.properties.equipSlots).toEqual(['head', 'accessory']);
            expect(top.equipSlots).toEqual(['head', 'accessory']);
            expect(top.message).toContain('equippable in head, accessory');

            const inProps = await create({ name: 'Visor 2', properties: { equipSlots: ['feet', 'feet'] } });
            expect(inProps.success).toBe(true);
            expect(inProps.item.properties.equipSlots).toEqual(['feet']);
        });

        it('an empty equipSlots on create writes no key', async () => {
            const data = await create({ name: 'Pebble', equipSlots: [] });
            expect(data.success).toBe(true);
            expect(data.item.properties?.equipSlots).toBeUndefined();
        });
    });

    describe('update', () => {
        let ringId: string;
        beforeEach(async () => {
            ringId = (await create({ name: 'Ring of Protection', properties: { acBonus: 1, glow: 'faint' } })).item.id;
        });

        it('equipSlots merges into the stored properties without mergeProperties', async () => {
            const data = await call({ action: 'update', itemId: ringId, equipSlots: ['accessory', 'accessory2'] });
            expect(data.success).toBe(true);
            expect(data.item.properties).toEqual({ acBonus: 1, glow: 'faint', equipSlots: ['accessory', 'accessory2'] });
            expect(data.equipSlots).toEqual(['accessory', 'accessory2']);
            expect((await stored(ringId)).properties).toEqual({ acBonus: 1, glow: 'faint', equipSlots: ['accessory', 'accessory2'] });
        });

        it('equipSlots: [] deletes the key and the type defaults return', async () => {
            await call({ action: 'update', itemId: ringId, equipSlots: ['head'] });
            const data = await call({ action: 'update', itemId: ringId, equipSlots: [] });
            expect(data.success).toBe(true);
            expect(data.item.properties).toEqual({ acBonus: 1, glow: 'faint' });
            expect(data.equipSlots).toEqual([]);
            expect(data.message).toMatch(/type default/i);
            expect((await stored(ringId)).properties.equipSlots).toBeUndefined();
        });

        it('equipSlots applies on top of a wholesale properties replacement', async () => {
            const data = await call({ action: 'update', itemId: ringId, properties: { weightless: true }, equipSlots: ['feet'] });
            expect(data.success).toBe(true);
            expect(data.item.properties).toEqual({ weightless: true, equipSlots: ['feet'] });
        });

        it('mergeProperties: true folds the passed keys into the stored set; null deletes a key', async () => {
            await call({ action: 'update', itemId: ringId, equipSlots: ['accessory'] });
            const data = await call({ action: 'update', itemId: ringId, properties: { glow: null, warm: true }, mergeProperties: true });
            expect(data.success).toBe(true);
            expect(data.item.properties).toEqual({ acBonus: 1, equipSlots: ['accessory'], warm: true });
            expect(data.propertyMerge).toEqual({ preservedKeys: ['acBonus', 'glow', 'equipSlots'], mode: 'shallow-merge' });
            expect(data.message).toContain('properties merged, not replaced');
            expect((await stored(ringId)).properties).toEqual({ acBonus: 1, equipSlots: ['accessory'], warm: true });
        });

        it('the properties + mergeProperties form sets equipSlots too, and is validated', async () => {
            const ok = await call({ action: 'update', itemId: ringId, properties: { equipSlots: ['accessory3'] }, mergeProperties: true });
            expect(ok.success).toBe(true);
            expect(ok.item.properties).toEqual({ acBonus: 1, glow: 'faint', equipSlots: ['accessory3'] });

            const bad = await call({ action: 'update', itemId: ringId, properties: { equipSlots: ['ring'] }, mergeProperties: true });
            expect(bad.error).toBe(true);
            expect(bad.writes).toBe('none');
            expect(bad.message).toMatch(/'ring'/);
            expect(bad.message).toContain(EQUIP_SLOTS.join(', '));
            expect((await stored(ringId)).properties.equipSlots).toEqual(['accessory3']);
        });

        it('refuses when equipSlots and properties.equipSlots disagree and writes nothing', async () => {
            const data = await call({ action: 'update', itemId: ringId, equipSlots: ['head'], properties: { equipSlots: ['feet'] }, mergeProperties: true });
            expect(data.error).toBe(true);
            expect(data.writes).toBe('none');
            expect(data.message).toMatch(/disagree/);
            expect((await stored(ringId)).properties).toEqual({ acBonus: 1, glow: 'faint' });
        });

        it('preview shows the would-be properties and writes nothing', async () => {
            const data = await call({ action: 'update', itemId: ringId, equipSlots: ['head'], preview: true });
            expect(data.preview).toBe(true);
            expect(data.wouldChange.properties).toEqual({ from: { acBonus: 1, glow: 'faint' }, to: { acBonus: 1, glow: 'faint', equipSlots: ['head'] } });
            expect((await stored(ringId)).properties.equipSlots).toBeUndefined();
        });
    });

    it('the outer schema mirrors equipSlots and the description documents the slots and mergeProperties', () => {
        const outer = ItemManageTool.inputSchema;
        const ok = outer.safeParse({ action: 'create', name: 'x', type: 'misc', equipSlots: ['mainhand', 'accessory3'] });
        expect(ok.success).toBe(true);
        expect((ok as { data: { equipSlots?: string[] } }).data.equipSlots).toEqual(['mainhand', 'accessory3']);
        expect(outer.safeParse({ action: 'create', name: 'x', type: 'misc', equipSlots: ['ring'] }).success).toBe(false);
        expect(ItemManageTool.description).toContain('equipSlots');
        expect(ItemManageTool.description).toContain('mergeProperties');
        expect(ItemManageTool.description).toContain(EQUIP_SLOTS.join(', '));
    });
});
