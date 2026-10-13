/**
 * Play report 5 #7: armour properties are validated and canonicalised when a
 * template is written. A GM who types baseAc gets baseAC stored and the alias
 * named in the reply; a category typo is refused with the nearest name and
 * nothing written; a non-integer base is refused; update (wholesale and
 * merged) canonicalises too; the description documents the key set.
 */
import { handleItemManage, ItemManageTool } from '../../../src/server/consolidated/item-manage.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'item-armor-props' } as any;
function parse(result: { content: Array<{ type: string; text: string }> }) {
    const m = result.content[0].text.match(/<!-- ITEM_MANAGE_JSON\n([\s\S]*?)\nITEM_MANAGE_JSON -->/);
    return m ? JSON.parse(m[1]) : null;
}
const call = async (args: Record<string, unknown>) => parse(await handleItemManage(args, ctx));
const create = async (args: Record<string, unknown>) => call({ action: 'create', type: 'armor', ...args });
const stored = async (itemId: string) => (await call({ action: 'get', itemId })).item;

describe('item_manage: armour properties (play report 5 #7)', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    describe('create', () => {
        it("stores the GM's {baseAc: 13, maxDexBonus: 2} as baseAC and names the alias", async () => {
            const data = await create({ name: 'Mail shirt', properties: { baseAc: 13, maxDexBonus: 2 } });
            expect(data.success).toBe(true);
            expect(data.item.properties).toEqual({ baseAC: 13, maxDexBonus: 2 });
            expect(data.aliased).toEqual({ baseAc: 'baseAC' });
            expect(data.armorProps).toMatchObject({ baseAC: 13, maxDexBonus: 2 });
            expect(data.message).toContain('baseAc → baseAC');
            expect((await stored(data.item.id)).properties).toEqual({ baseAC: 13, maxDexBonus: 2 });
        });

        it('canonicalises every alias and lower-cases the category; other keys are kept', async () => {
            const data = await create({ name: 'Scale', properties: { base_ac: 14, maxDex: 2, armorType: 'Medium', stealth_disadvantage: true, strReq: 13, colour: 'rust' } });
            expect(data.item.properties).toEqual({ baseAC: 14, maxDexBonus: 2, armorCategory: 'medium', stealthDisadvantage: true, strengthRequired: 13, colour: 'rust' });
            expect(data.aliased).toEqual({ base_ac: 'baseAC', maxDex: 'maxDexBonus', armorType: 'armorCategory', stealth_disadvantage: 'stealthDisadvantage', strReq: 'strengthRequired' });
        });

        it('a category typo is refused with the nearest name and nothing written', async () => {
            const data = await create({ name: 'Coat', properties: { baseAC: 13, armorCategory: 'medum' } });
            expect(data.error).toBe(true);
            expect(data.writes).toBe('none');
            expect(data.message).toMatch(/armorCategory 'medum' is not one of light, medium, heavy, shield — nearest is 'medium'/);
            expect(data.message).toContain('NOTHING was written');
            expect((await call({ action: 'list' })).count).toBe(0);
        });

        it('a base that is not a non-negative integer is refused', async () => {
            const data = await create({ name: 'Coat', properties: { baseAC: 'thirteen' } });
            expect(data.error).toBe(true);
            expect(data.writes).toBe('none');
            expect(data.message).toMatch(/baseAC must be a non-negative integer/);
        });

        it('two spellings that disagree are refused', async () => {
            const data = await create({ name: 'Coat', properties: { baseAC: 14, baseAc: 13 } });
            expect(data.error).toBe(true);
            expect(data.message).toMatch(/baseAC 14 and baseAc 13 disagree/);
        });

        it('a legacy ac and an SRD category stay in place, mirrored to the canonical keys', async () => {
            const data = await create({ name: 'Starter mail', properties: { ac: 16, strengthRequired: 13, stealthDisadvantage: true } });
            expect(data.item.properties).toEqual({ ac: 16, baseAC: 16, strengthRequired: 13, stealthDisadvantage: true });
            expect(data.aliased).toEqual({ ac: 'baseAC' });
            const shield = await create({ name: 'SRD shield', properties: { category: 'Shield', acBonus: 2, equipSlots: ['offhand'] } });
            expect(shield.item.properties).toEqual({ category: 'Shield', acBonus: 2, equipSlots: ['offhand'], armorCategory: 'shield' });
        });

        it('a non-armour item with no armour keys is left alone', async () => {
            const data = await call({ action: 'create', type: 'consumable', name: 'Tonic', properties: { strength: 'strong', category: 'Adventuring Gear' } });
            expect(data.item.properties).toEqual({ strength: 'strong', category: 'Adventuring Gear' });
            expect(data.aliased).toBeUndefined();
        });
    });

    describe('update', () => {
        it('mergeProperties canonicalises the merged set and reports the alias', async () => {
            const created = await create({ name: 'Mail shirt', properties: { weightClass: 'medium' } });
            const data = await call({ action: 'update', itemId: created.item.id, properties: { baseAc: 13, maxDex: 2 }, mergeProperties: true });
            expect(data.success).toBe(true);
            expect(data.item.properties).toEqual({ weightClass: 'medium', baseAC: 13, maxDexBonus: 2 });
            expect(data.aliased).toEqual({ baseAc: 'baseAC', maxDex: 'maxDexBonus' });
        });

        it('a wholesale properties update canonicalises too, and a typo is refused before the journal write', async () => {
            const created = await create({ name: 'Mail shirt', properties: { baseAC: 13 } });
            const data = await call({ action: 'update', itemId: created.item.id, properties: { base_ac: 14, armorCategory: 'medium' } });
            expect(data.item.properties).toEqual({ baseAC: 14, armorCategory: 'medium' });
            const refused = await call({ action: 'update', itemId: created.item.id, properties: { armorCategory: 'hevy' }, mergeProperties: true });
            expect(refused.error).toBe(true);
            expect(refused.writes).toBe('none');
            expect(refused.message).toMatch(/nearest is 'heavy'/);
            expect((await stored(created.item.id)).properties).toEqual({ baseAC: 14, armorCategory: 'medium' });
        });
    });

    it('the description documents the canonical armour set and the inference rules', () => {
        const d = ItemManageTool.description;
        expect(d).toContain("{ baseAC: 13, armorCategory: 'medium', maxDexBonus: 2, strengthRequired?: 13, stealthDisadvantage?: true }");
        expect(d).toContain("{ armorCategory: 'shield', acBonus: 2 }");
        expect(d).toMatch(/heavy: no DEX; medium: cap 2; light: full DEX/);
        expect(d).toContain('baseAc');
    });
});
