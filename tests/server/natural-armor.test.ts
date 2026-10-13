/**
 * Play report 5 #8b: natural armour. combat_profile.naturalArmor {base,
 * addDex, maxDex?} is the floor the worn armour must beat: unarmoured is the
 * higher of 10 + DEX and base + DEX, a worn suit replaces it only when its
 * own total is higher, and shields and every other acBonus add on top of
 * whichever wins. Species rules carry it; create uses it for the default AC;
 * update {naturalArmor} reports the derived AC and writes it when the sheet
 * follows its gear.
 */
import { handleCharacterManage, CharacterManageTool } from '../../src/server/consolidated/character-manage.js';
import { handleItemManage } from '../../src/server/consolidated/item-manage.js';
import { handleInventoryManage } from '../../src/server/consolidated/inventory-manage.js';
import { handleTableRules, TableRulesTool } from '../../src/server/consolidated/table-rules.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'natural-armor' } as any;
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
// Every call goes through the outer schema first, as the MCP client does.
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx));
const item = async (a: Record<string, unknown>) => json(await handleItemManage(a, ctx));
const inv = async (a: Record<string, unknown>) => json(await handleInventoryManage(a, ctx));
const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;

const STATS = { str: 14, dex: 12, con: 13, int: 10, wis: 11, cha: 10 };

async function armour(characterId: string, name: string, properties: Record<string, unknown>, slot = 'armor') {
    const created = await item({ action: 'create', name, type: 'armor', properties });
    await inv({ action: 'give', characterId, itemId: created.item.id, quantity: 1 });
    return inv({ action: 'equip', characterId, itemId: created.item.id, slot });
}

describe('natural armour (play report 5 #8b)', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('naturalArmor survives create, update and get through the outer schema; a bad shape is refused', async () => {
        const c = await char({ action: 'create', name: 'Varek', stats: STATS, naturalArmor: { base: 12, addDex: true } });
        expect(c.naturalArmor).toEqual({ base: 12, addDex: true });
        expect((await char({ action: 'get', characterId: c.id })).naturalArmor).toEqual({ base: 12, addDex: true });
        await char({ action: 'update', characterId: c.id, naturalArmor: { base: 15, addDex: false } });
        expect(sheet(c.id).naturalArmor).toEqual({ base: 15, addDex: false });
        expect(() => CharacterManageTool.inputSchema.parse({ action: 'update', characterId: c.id, naturalArmor: { base: -1 } })).toThrow();
        expect(() => CharacterManageTool.inputSchema.parse({ action: 'update', characterId: c.id, naturalArmor: { base: 12, hide: 'thick' } })).toThrow();
    });

    it('create with natural armour starts the AC at base + DEX, not 10 + DEX', async () => {
        const c = await char({ action: 'create', name: 'Varek', stats: STATS, naturalArmor: { base: 12, addDex: true } });
        expect(c.ac).toBe(13);
        const plain = await char({ action: 'create', name: 'Plain', stats: STATS });
        expect(plain.ac).toBe(11);
    });

    it('an unarmoured sheet derives natural armour 12 + DEX +1; a ring adds on top', async () => {
        const c = await char({ action: 'create', name: 'Varek', stats: STATS, naturalArmor: { base: 12, addDex: true } });
        const ring = await item({ action: 'create', name: 'Ring', type: 'misc', properties: { acBonus: 1 }, equipSlots: ['accessory'] });
        await inv({ action: 'give', characterId: c.id, itemId: ring.item.id, quantity: 1 });
        const worn = await inv({ action: 'equip', characterId: c.id, itemId: ring.item.id, slot: 'accessory' });
        expect(worn.ac).toMatchObject({ before: 13, after: 14, source: 'derived' });
        expect(worn.ac.parts).toEqual(['natural armour 12 + DEX +1', 'Ring +1']);
        expect(sheet(c.id).ac).toBe(14);
    });

    it('the mail shirt (14) beats natural 13; leather (12) loses to it; a shield adds on top of natural', async () => {
        const c = await char({ action: 'create', name: 'Varek', stats: STATS, naturalArmor: { base: 12, addDex: true } });
        const shirt = await armour(c.id, 'Mail shirt', { baseAc: 13, maxDexBonus: 2 });
        expect(shirt.ac.after).toBe(14);
        expect(shirt.ac.parts[0]).toBe('Mail shirt base 13 + DEX(max 2) (beats natural armour 13)');
        await inv({ action: 'unequip', characterId: c.id, slot: 'armor' });
        const leather = await armour(c.id, 'Leather', { baseAC: 11, armorCategory: 'light' });
        expect(leather.ac.after).toBe(13);
        expect(leather.ac.parts[0]).toBe('natural armour 12 + DEX +1 (beats Leather 12)');
        const shield = await armour(c.id, 'Shield', { armorCategory: 'shield', acBonus: 2 }, 'offhand');
        expect(shield.ac.after).toBe(15);
        expect(shield.ac.parts).toEqual(['natural armour 12 + DEX +1 (beats Leather 12)', 'Shield +2']);
    });

    it('update {naturalArmor} reports the derived AC and writes it when the sheet follows its gear; a hand-set AC is kept and told', async () => {
        const c = await char({ action: 'create', name: 'Varek', stats: STATS });
        expect(c.ac).toBe(11);
        const r = await char({ action: 'update', characterId: c.id, naturalArmor: { base: 12, addDex: true } });
        expect(r.armorClass).toMatchObject({ derived: 13, parts: ['natural armour 12 + DEX +1'], applied: true });
        expect(r.message).toContain('AC 11 → 13');
        expect(sheet(c.id)).toMatchObject({ ac: 13, acSource: 'derived', naturalArmor: { base: 12, addDex: true } });

        const h = await char({ action: 'create', name: 'Hand-set', stats: STATS, ac: 16 });
        await char({ action: 'update', characterId: h.id, ac: 16 });
        const kept = await char({ action: 'update', characterId: h.id, naturalArmor: { base: 12, addDex: true } });
        expect(kept.armorClass).toMatchObject({ derived: 13, applied: false });
        expect(kept.message).toContain('AC 16 is hand-set');
        expect(kept.message).toContain('gear gives 13');
        expect(sheet(h.id)).toMatchObject({ ac: 16, acSource: 'manual' });
    });

    it('a species rule with naturalArmor writes it onto the sheet at create and the AC follows', async () => {
        const db = getDb();
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: 'w', name: 'W', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: 'w', ...a }), ctx));
        await rules({ action: 'define', kind: 'species', name: 'Hide-orc', spec: { speed: 30, naturalArmor: { base: 12, addDex: true }, traits: ['Thick Hide'] } });
        const c = await char({ action: 'create', name: 'Gruk', race: 'Hide-orc', worldId: 'w', stats: STATS });
        expect(sheet(c.id).naturalArmor).toEqual({ base: 12, addDex: true });
        expect(c.ac).toBe(13);
        expect(c._rules.species).toMatchObject({ world: true, name: 'Hide-orc', naturalArmor: { base: 12, addDex: true } });
    });
});
