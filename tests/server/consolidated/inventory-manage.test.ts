/**
 * Tests for consolidated inventory_manage tool
 * Validates all 9 actions: give, remove, transfer, use, extinguish, equip, unequip, get, get_detailed
 */

import { handleInventoryManage, InventoryManageTool } from '../../../src/server/consolidated/inventory-manage.js';
import { handleItemManage } from '../../../src/server/consolidated/item-manage.js';
import { handleCharacterManage } from '../../../src/server/consolidated/character-manage.js';
import { getDb } from '../../../src/storage/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { randomUUID } from 'crypto';
import { EQUIP_SLOTS } from '../../../src/schema/inventory.js';

// Force test mode
process.env.NODE_ENV = 'test';

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    // Match HTML comment format: <!-- INVENTORY_MANAGE_JSON ... INVENTORY_MANAGE_JSON -->
    const jsonMatch = text.match(/<!-- INVENTORY_MANAGE_JSON\n([\s\S]*?)\nINVENTORY_MANAGE_JSON -->/);
    return jsonMatch ? JSON.parse(jsonMatch[1]) : null;
}

function parseItemResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    const jsonMatch = text.match(/<!-- ITEM_MANAGE_JSON\n([\s\S]*?)\nITEM_MANAGE_JSON -->/);
    return jsonMatch ? JSON.parse(jsonMatch[1]) : null;
}

describe('inventory_manage consolidated tool', () => {
    const ctx = { sessionId: 'test-session' };
    let testCharId: string;
    let testItemId: string;

    beforeEach(async () => {
        // Reset test database - getDb runs migrations which creates tables
        const db = getDb(':memory:');

        // Clear data (correct table names)
        db.exec('DELETE FROM inventory_items');
        db.exec('DELETE FROM items');
        db.exec('DELETE FROM characters');

        // Create a test character
        const charRepo = new CharacterRepository(db);
        testCharId = randomUUID();
        charRepo.create({
            id: testCharId,
            name: 'Test Hero',
            class: 'fighter',
            level: 1,
            race: 'human',
            hp: 10,
            maxHp: 10,
             // 10 + DEX 12 = 11: the sheet follows its gear. A stored AC that
             // differs from the derived value reads as hand-set (play report 3 #2).
             ac: 11,
             stats: { str: 14, dex: 12, con: 13, int: 10, wis: 11, cha: 10 },
             currency: { gold: 5, silver: 0, copper: 0 },
             speed: 30,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });

        // Create a test item
        const itemResult = await handleItemManage({
            action: 'create',
            name: 'Test Sword',
            type: 'weapon',
            weight: 3,
            value: 15
        }, ctx);
        testItemId = parseItemResult(itemResult).item.id;
    });

    describe('Tool Definition', () => {
        it('should have correct tool name', () => {
            expect(InventoryManageTool.name).toBe('inventory_manage');
        });

        it('should list all available actions in description', () => {
            expect(InventoryManageTool.description).toContain('give');
            expect(InventoryManageTool.description).toContain('remove');
            expect(InventoryManageTool.description).toContain('transfer');
            expect(InventoryManageTool.description).toContain('use');
            expect(InventoryManageTool.description).toContain('extinguish');
            expect(InventoryManageTool.description).toContain('equip');
            expect(InventoryManageTool.description).toContain('unequip');
            expect(InventoryManageTool.description).toContain('get');
            expect(InventoryManageTool.description).toContain('get_detailed');
        });

        it('distinguishes a world grant from an atomic character handoff', () => {
            expect(InventoryManageTool.description).toContain('use this for a player-to-NPC handoff');
            expect(InventoryManageTool.description).toContain('give is a world/DM grant');
            expect(InventoryManageTool.description).toContain('fromCharacterId and toCharacterId');
        });
    });

    describe('give action', () => {
        it('should add an item to inventory', async () => {
            const result = await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('give');
            expect(data.itemName).toBe('Test Sword');
            expect(data.quantity).toBe(1);
        });

        it('should add multiple items', async () => {
            // Create stackable item
            const potionResult = await handleItemManage({
                action: 'create',
                name: 'Health Potion',
                type: 'consumable',
                weight: 0.5,
                value: 50
            }, ctx);
            const potionId = parseItemResult(potionResult).item.id;

            const result = await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: potionId,
                quantity: 5
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.quantity).toBe(5);
        });

        it('should accept "add" alias', async () => {
            const result = await handleInventoryManage({
                action: 'add',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should return error for non-existent item', async () => {
            const result = await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: 'fake-item-id',
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBeDefined();
            expect(data.message).toContain('Item not found');
        });
    });

    describe('remove action', () => {
        beforeEach(async () => {
            // Give item first
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 3
            }, ctx);
        });

        it('should remove items from inventory', async () => {
            const result = await handleInventoryManage({
                action: 'remove',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('remove');
        });

        it('should accept "take" alias', async () => {
            const result = await handleInventoryManage({
                action: 'take',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should return error if not enough quantity', async () => {
            const result = await handleInventoryManage({
                action: 'remove',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 100
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBeDefined();
        });
    });

    describe('transfer action', () => {
        let secondCharId: string;

        beforeEach(async () => {
            // Create second character
            const db = getDb(':memory:');
            const charRepo = new CharacterRepository(db);
            secondCharId = randomUUID();
            charRepo.create({
                id: secondCharId,
                name: 'Second Hero',
                class: 'rogue',
                level: 1,
                race: 'elf',
                hp: 8,
                maxHp: 8,
                ac: 12,
                stats: { str: 10, dex: 16, con: 10, int: 12, wis: 10, cha: 14 },
                speed: 30,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });

            // Give first character an item
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 2
            }, ctx);
        });

        it('should transfer item between characters', async () => {
            const result = await handleInventoryManage({
                action: 'transfer',
                fromCharacterId: testCharId,
                toCharacterId: secondCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('transfer');
            expect(data.fromCharacterId).toBe(testCharId);
            expect(data.toCharacterId).toBe(secondCharId);
        });

        it('should accept "trade" alias', async () => {
            const result = await handleInventoryManage({
                action: 'trade',
                fromCharacterId: testCharId,
                toCharacterId: secondCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });
    });

    describe('use action', () => {
        let consumableId: string;

        beforeEach(async () => {
            // Create consumable item
            const potionResult = await handleItemManage({
                action: 'create',
                name: 'Healing Potion',
                type: 'consumable',
                weight: 0.5,
                value: 50,
                properties: { effect: 'Restore 2d4+2 HP' }
            }, ctx);
            consumableId = parseItemResult(potionResult).item.id;

            // Give it to character
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: consumableId,
                quantity: 3
            }, ctx);
        });

        it('should use consumable item', async () => {
            const result = await handleInventoryManage({
                action: 'use',
                characterId: testCharId,
                itemId: consumableId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('use');
            expect(data.effect).toBe('Restore 2d4+2 HP');
        });

        it('should roll and persist healing when the effect declares healing', async () => {
            const db = getDb(':memory:');
            const charRepo = new CharacterRepository(db);
            charRepo.update(testCharId, { hp: 2 });
            const potionResult = await handleItemManage({
                action: 'create',
                name: 'Greater Healing Potion',
                type: 'consumable',
                weight: 0.5,
                value: 100,
                properties: { healing: 4, effect: 'Restore 4 HP' }
            }, ctx);
            const healingId = parseItemResult(potionResult).item.id;
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: healingId,
                quantity: 1
            }, ctx);

            const data = parseResult(await handleInventoryManage({
                action: 'use',
                characterId: testCharId,
                itemId: healingId
            }, ctx));

            expect(data.success).toBe(true);
            expect(data.healing).toBe(4);
            expect(data.hpBefore).toBe(2);
            expect(data.hpAfter).toBe(6);
            expect(new CharacterRepository(getDb(':memory:')).findById(testCharId)?.hp).toBe(6);
        });

        it('should accept "consume" alias', async () => {
            const result = await handleInventoryManage({
                action: 'consume',
                characterId: testCharId,
                itemId: consumableId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should return error for non-consumable items', async () => {
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const result = await handleInventoryManage({
                action: 'use',
                characterId: testCharId,
                itemId: testItemId
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBeDefined();
            expect(data.message).toContain('not a consumable');
        });

        it('lights a torch, consumes one torch, and persists provenance and duration', async () => {
            const torchResult = await handleItemManage({
                action: 'create',
                name: 'Torch',
                type: 'misc',
                weight: 1,
                value: 0.01,
            }, ctx);
            const torchId = parseItemResult(torchResult).item.id;
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: torchId,
                quantity: 2,
            }, ctx);

            const data = parseResult(await handleInventoryManage({
                action: 'use',
                characterId: testCharId,
                itemId: torchId,
            }, ctx));

            expect(data.success).toBe(true);
            expect(data.lightSource).toMatchObject({
                kind: 'torch',
                durationMinutes: 60,
                brightRadiusFeet: 20,
                dimRadiusFeet: 20,
                active: true,
                provenance: { itemId: torchId, itemName: 'Torch' },
                consumesItem: true,
                consumed: true,
            });
            const inventory = parseResult(await handleInventoryManage({
                action: 'get',
                characterId: testCharId,
            }, ctx));
            expect(inventory.inventory.find((entry: { item: { id: string } }) => entry.item.id === torchId).quantity).toBe(1);
            expect(getDb(':memory:').prepare('SELECT COUNT(*) AS count FROM custom_effects WHERE target_id = ? AND name = ?').get(testCharId, 'Light source: Torch')).toEqual({ count: 1 });
        });

        it('lights a hooded lantern without consuming the reusable lantern', async () => {
            const lanternResult = await handleItemManage({
                action: 'create',
                name: 'Lantern, Hooded',
                type: 'misc',
                weight: 2,
                value: 5,
            }, ctx);
            const lanternId = parseItemResult(lanternResult).item.id;
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: lanternId,
                quantity: 1,
            }, ctx);

            const data = parseResult(await handleInventoryManage({
                action: 'use',
                characterId: testCharId,
                itemId: lanternId,
            }, ctx));

            expect(data.success).toBe(true);
            expect(data.lightSource).toMatchObject({
                kind: 'hooded_lantern',
                consumesItem: false,
                consumed: false,
            });
            const inventory = parseResult(await handleInventoryManage({
                action: 'get',
                characterId: testCharId,
            }, ctx));
            expect(inventory.inventory.find((entry: { item: { id: string } }) => entry.item.id === lanternId).quantity).toBe(1);
        });

        it('extinguishes a light source, preserves the source item, and is idempotent', async () => {
            const torchResult = await handleItemManage({
                action: 'create',
                name: 'Torch',
                type: 'misc',
                weight: 1,
                value: 0.01,
            }, ctx);
            const torchId = parseItemResult(torchResult).item.id;
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: torchId,
                quantity: 1,
            }, ctx);
            await handleInventoryManage({
                action: 'use',
                characterId: testCharId,
                itemId: torchId,
            }, ctx);

            const extinguished = parseResult(await handleInventoryManage({
                action: 'extinguish',
                characterId: testCharId,
                itemId: torchId,
            }, ctx));

            expect(extinguished).toMatchObject({
                success: true,
                actionType: 'extinguish',
                extinguished: true,
                lightSource: {
                    kind: 'torch',
                    active: false,
                    effectId: expect.any(Number),
                    provenance: { itemId: torchId, itemName: 'Torch' },
                },
            });
            const repeated = parseResult(await handleInventoryManage({
                action: 'extinguish',
                characterId: testCharId,
                itemId: torchId,
            }, ctx));
            expect(repeated).toMatchObject({
                success: true,
                actionType: 'extinguish',
                alreadyExtinguished: true,
                lightSource: { active: false, effectId: null },
            });

            const inventory = parseResult(await handleInventoryManage({
                action: 'get',
                characterId: testCharId,
            }, ctx));
            expect(inventory.inventory.find((entry: { item: { id: string }; quantity: number }) => entry.item.id === torchId)?.quantity ?? 0).toBe(0);
        });
    });

    describe('equip action', () => {
        beforeEach(async () => {
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);
        });

        it('should equip an item', async () => {
            const result = await handleInventoryManage({
                action: 'equip',
                characterId: testCharId,
                itemId: testItemId,
                slot: 'mainhand'
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('equip');
            expect(data.slot).toBe('mainhand');
        });

        it('should recompute legacy starter armor and shield AC as equipment changes', async () => {
            const armorResult = await handleItemManage({
                action: 'create',
                name: 'Chain Mail',
                type: 'armor',
                weight: 55,
                value: 75,
                properties: { ac: 16, stealthDisadvantage: true, strengthRequired: 13 }
            }, ctx);
            const armorId = parseItemResult(armorResult).item.id;
            await handleInventoryManage({ action: 'give', characterId: testCharId, itemId: armorId, quantity: 1 }, ctx);

            const equipped = parseResult(await handleInventoryManage({
                action: 'equip',
                characterId: testCharId,
                itemId: armorId,
                slot: 'armor'
            }, ctx));

            expect(equipped.success).toBe(true);
            expect(equipped.acChange).toContain('now 16');
            expect(equipped.ac).toMatchObject({ before: 11, after: 16, source: 'derived', derived: 16 });
            expect(equipped.ac.parts[0]).toContain('Chain Mail base 16 (no DEX)');
            const afterArmour = new CharacterRepository(getDb(':memory:')).findById(testCharId)!;
            expect(afterArmour.ac).toBe(16);
            // A derived write stamps the source, so the sheet follows gear from here.
            expect(afterArmour.acSource).toBe('derived');

            const shieldResult = await handleItemManage({
                action: 'create',
                name: 'Shield',
                type: 'armor',
                weight: 6,
                value: 10,
                properties: { acBonus: 2 }
            }, ctx);
            const shieldId = parseItemResult(shieldResult).item.id;
            await handleInventoryManage({ action: 'give', characterId: testCharId, itemId: shieldId, quantity: 1 }, ctx);
            const shieldEquipped = parseResult(await handleInventoryManage({
                action: 'equip',
                characterId: testCharId,
                itemId: shieldId,
                slot: 'offhand'
            }, ctx));

            expect(shieldEquipped.acChange).toContain('now 18');
            expect(new CharacterRepository(getDb(':memory:')).findById(testCharId)?.ac).toBe(18);

            const unequipped = parseResult(await handleInventoryManage({
                action: 'unequip',
                characterId: testCharId,
                itemId: armorId
            }, ctx));

            expect(unequipped.success).toBe(true);
            expect(unequipped.acChange).toContain('now 13');
            expect(new CharacterRepository(getDb(':memory:')).findById(testCharId)?.ac).toBe(13);
        });

        it('should accept "wield" alias', async () => {
            const result = await handleInventoryManage({
                action: 'wield',
                characterId: testCharId,
                itemId: testItemId,
                slot: 'mainhand'
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should return error for item not owned', async () => {
            const otherItemResult = await handleItemManage({
                action: 'create',
                name: 'Other Sword',
                type: 'weapon',
                weight: 3,
                value: 20
            }, ctx);
            const otherItemId = parseItemResult(otherItemResult).item.id;

            const result = await handleInventoryManage({
                action: 'equip',
                characterId: testCharId,
                itemId: otherItemId,
                slot: 'mainhand'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBeDefined();
            expect(data.message).toContain('does not own');
        });
    });

    // Play report 3 #2: a hand-set AC survives gear changes. acSource lives in
    // combat_profile: character_manage update {ac} and set_form mark it manual,
    // a derived write marks it derived, and a legacy row with no source follows
    // its gear only when the stored AC already equals what the gear derives.
    describe('hand-set AC survives gear changes (play report 3 #2)', () => {
        const sheet = () => new CharacterRepository(getDb(':memory:')).findById(testCharId)! as { ac: number; acSource?: string };
        const makeItem = async (name: string, type: string, properties: Record<string, unknown>) => {
            const created = parseItemResult(await handleItemManage({ action: 'create', name, type, weight: 1, value: 1, properties }, ctx));
            await handleInventoryManage({ action: 'give', characterId: testCharId, itemId: created.item.id, quantity: 1 }, ctx);
            return created.item.id as string;
        };
        const equip = async (itemId: string, slot: string, extra: Record<string, unknown> = {}) =>
            parseResult(await handleInventoryManage({ action: 'equip', characterId: testCharId, itemId, slot, ...extra }, ctx));
        const handSet = async (ac: number) => {
            await handleCharacterManage({ action: 'update', characterId: testCharId, ac }, ctx);
            expect(sheet()).toMatchObject({ ac, acSource: 'manual' });
        };

        beforeEach(async () => {
            await handleInventoryManage({ action: 'give', characterId: testCharId, itemId: testItemId, quantity: 1 }, ctx);
        });

        it('a hand-set 17 survives weapon, armour and accessory equips and an unequip', async () => {
            await handSet(17);
            const chainMail = await makeItem('Chain Mail', 'armor', { ac: 16, strengthRequired: 13 });
            const shield = await makeItem('Shield', 'armor', { acBonus: 2 });
            const ring = await makeItem('Ring of Protection', 'misc', { acBonus: 1, equipSlots: ['accessory', 'accessory2', 'accessory3'] });

            const sword = await equip(testItemId, 'mainhand');
            expect(sword.success).toBe(true);
            expect(sword.ac).toMatchObject({ before: 17, after: 17, source: 'manual', derived: 11 });
            expect(sword.acChange).toContain('AC kept at 17 (hand-set; gear gives 11');
            expect(sword.acChange).toContain('Pass recomputeAc: true to take it');
            expect(sword.acMatchesDerived).toBeUndefined();
            expect(sheet()).toMatchObject({ ac: 17, acSource: 'manual' });

            const armour = await equip(chainMail, 'armor');
            expect(armour.ac).toMatchObject({ before: 17, after: 17, source: 'manual', derived: 16 });
            expect(sheet()).toMatchObject({ ac: 17, acSource: 'manual' });

            const offhand = await equip(shield, 'offhand');
            expect(offhand.ac).toMatchObject({ after: 17, source: 'manual', derived: 18 });
            expect(offhand.acChange).toContain('gear gives 18');
            expect(sheet()).toMatchObject({ ac: 17, acSource: 'manual' });

            const accessory = await equip(ring, 'accessory2');
            expect(accessory.success).toBe(true);
            expect(accessory.ac).toMatchObject({ after: 17, source: 'manual', derived: 19 });
            expect(sheet()).toMatchObject({ ac: 17, acSource: 'manual' });

            const doffed = parseResult(await handleInventoryManage({ action: 'unequip', characterId: testCharId, itemId: chainMail }, ctx));
            expect(doffed.success).toBe(true);
            expect(doffed.ac).toMatchObject({ before: 17, after: 17, source: 'manual', derived: 14 });
            expect(doffed.acChange).toContain('AC kept at 17 (hand-set; gear gives 14');
            expect(sheet()).toMatchObject({ ac: 17, acSource: 'manual' });
        });

        it('recomputeAc: true takes the derived value and lets gear drive the sheet from then on', async () => {
            await handSet(17);
            const chainMail = await makeItem('Chain Mail', 'armor', { ac: 16, strengthRequired: 13 });
            const shield = await makeItem('Shield', 'armor', { acBonus: 2 });

            const taken = await equip(chainMail, 'armor', { recomputeAc: true });
            expect(taken.success).toBe(true);
            expect(taken.ac).toMatchObject({ before: 17, after: 16, source: 'derived', derived: 16 });
            expect(taken.acChange).toContain('AC 17 → 16');
            expect(sheet()).toMatchObject({ ac: 16, acSource: 'derived' });

            // No flag needed any more: the sheet follows its gear.
            const shieldOn = await equip(shield, 'offhand');
            expect(shieldOn.ac).toMatchObject({ before: 16, after: 18, source: 'derived' });
            expect(sheet()).toMatchObject({ ac: 18, acSource: 'derived' });

            const doffed = parseResult(await handleInventoryManage({ action: 'unequip', characterId: testCharId, slot: 'armor', recomputeAc: true }, ctx));
            expect(doffed.ac).toMatchObject({ before: 18, after: 13, source: 'derived' });
            expect(sheet()).toMatchObject({ ac: 13, acSource: 'derived' });
        });

        it('says when a kept hand-set AC equals what the gear now derives', async () => {
            await handSet(16);
            const chainMail = await makeItem('Chain Mail', 'armor', { ac: 16, strengthRequired: 13 });

            const armour = await equip(chainMail, 'armor');
            expect(armour.success).toBe(true);
            expect(armour.acMatchesDerived).toBe(true);
            expect(armour.ac).toMatchObject({ before: 16, after: 16, source: 'manual', derived: 16 });
            expect(armour.acChange).toContain('AC 16 is hand-set and the gear now derives 16 too; pass recomputeAc: true to let gear drive it from here');
            expect(armour.message).toContain('hand-set and the gear now derives 16 too');
            // Still manual: nothing flipped behind the GM's back.
            expect(sheet()).toMatchObject({ ac: 16, acSource: 'manual' });
        });

        it('a gear-following sheet (acSource derived) still recomputes without the flag', async () => {
            new CharacterRepository(getDb(':memory:')).update(testCharId, { ac: 11, acSource: 'derived' } as any);
            const shield = await makeItem('Shield', 'armor', { acBonus: 2 });
            const r = await equip(shield, 'offhand');
            expect(r.ac).toMatchObject({ before: 11, after: 13, source: 'derived', derived: 13 });
            expect(r.acChange).toContain('AC 11 → 13');
            expect(sheet()).toMatchObject({ ac: 13, acSource: 'derived' });
        });

        it('a legacy row with no acSource follows gear only when its AC already equals the derived value', async () => {
            // The fixture (11 = 10 + DEX 12, no source) follows: covered above.
            // A legacy 14 on the same stats does not; it is kept and stamped manual.
            new CharacterRepository(getDb(':memory:')).update(testCharId, { ac: 14 } as any);
            expect(sheet().acSource).toBeUndefined();
            const chainMail = await makeItem('Chain Mail', 'armor', { ac: 16, strengthRequired: 13 });
            const r = await equip(chainMail, 'armor');
            expect(r.ac).toMatchObject({ before: 14, after: 14, source: 'manual', derived: 16 });
            expect(r.acChange).toContain('AC kept at 14 (hand-set');
            expect(r.acChange).toContain('gear gives 16');
            // Review: the stamp is a durable write on the sheet, so the reply names it.
            expect(r.acChange).toContain('marked hand-set from here');
            expect(sheet()).toMatchObject({ ac: 14, acSource: 'manual' });
        });

        // Review: the compare rule's other arm is a write too — a legacy row whose
        // AC equalled its gear is stamped derived — and the reply has to say so,
        // or the GM's old hand-set 13 (that happened to equal the apron) starts
        // following gear with only "AC unchanged" to show for it.
        it('a legacy row that equalled its gear says gear drives it from here when first stamped derived', async () => {
            const apron = await makeItem('Leather Apron', 'misc', { equipSlots: ['armor'], ac: 12 });
            getDb(':memory:').prepare('UPDATE inventory_items SET equipped = 1, slot = ? WHERE character_id = ? AND item_id = ?').run('armor', testCharId, apron);
            new CharacterRepository(getDb(':memory:')).update(testCharId, { ac: 13 } as any);   // 12 + DEX +1, hand-set before acSource existed
            expect(sheet().acSource).toBeUndefined();

            const r = await equip(testItemId, 'mainhand');
            expect(r.ac).toMatchObject({ before: 13, after: 13, source: 'derived', derived: 13 });
            expect(r.acChange).toContain('AC unchanged (now 13: Leather Apron base 12 + DEX');
            expect(r.acChange).toContain('matched its gear, so gear drives it from here');
            expect(sheet()).toMatchObject({ ac: 13, acSource: 'derived' });

            // Already derived: no stamp, so no note.
            const again = parseResult(await handleInventoryManage({ action: 'unequip', characterId: testCharId, itemId: testItemId }, ctx));
            expect(again.acChange).toBe('AC unchanged (now 13: Leather Apron base 12 + DEX)');
        });

        // Play report 3 #2, the GM's case: Varek's hand-set 13 equals what the
        // apron derives (12 + DEX +1). The apron is an equipSlots item, not armor.
        it("Varek: a hand-set 13 survives the apron that derives 13, flags the match, and recomputeAc hands it to the gear", async () => {
            await handSet(13);
            const apron = await makeItem('Leather Apron', 'misc', { equipSlots: ['armor'], ac: 12 });

            const worn = await equip(apron, 'armor');
            expect(worn.success).toBe(true);
            expect(worn.ac).toMatchObject({ before: 13, after: 13, source: 'manual', derived: 13, parts: ['Leather Apron base 12 + DEX'] });
            expect(worn.acMatchesDerived).toBe(true);
            expect(worn.acChange).toContain('AC 13 is hand-set and the gear now derives 13 too; pass recomputeAc: true');
            expect(sheet()).toMatchObject({ ac: 13, acSource: 'manual' });

            // A weapon next: still kept, still flagged (the apron still derives 13).
            const sword = await equip(testItemId, 'mainhand');
            expect(sword.ac).toMatchObject({ after: 13, source: 'manual', derived: 13 });
            expect(sword.acMatchesDerived).toBe(true);

            // Taking the hint flips the source without moving the number...
            const taken = parseResult(await handleInventoryManage({ action: 'unequip', characterId: testCharId, itemId: testItemId, recomputeAc: true }, ctx));
            expect(taken.ac).toMatchObject({ before: 13, after: 13, source: 'derived', derived: 13 });
            expect(taken.acChange).toContain('gear drives it from here');
            expect(taken.acMatchesDerived).toBeUndefined();
            expect(sheet()).toMatchObject({ ac: 13, acSource: 'derived' });

            // ...and from then on the apron coming off is felt.
            const doffed = parseResult(await handleInventoryManage({ action: 'unequip', characterId: testCharId, slot: 'armor' }, ctx));
            expect(doffed.ac).toMatchObject({ before: 13, after: 11, source: 'derived' });
            expect(sheet()).toMatchObject({ ac: 11, acSource: 'derived' });
        });

        it("character_manage update {acSource: 'derived'} switches without touching gear", async () => {
            await handSet(17);
            const switched = JSON.parse((await handleCharacterManage({ action: 'update', characterId: testCharId, acSource: 'derived' }, ctx)).content[0].text.match(/<!-- CHARACTER_MANAGE_JSON\n([\s\S]*?)\nCHARACTER_MANAGE_JSON -->/)![1]);
            expect(switched.success).toBe(true);
            expect(switched.changed).toContain('acSource');
            // The number stays until the next gear change.
            expect(sheet()).toMatchObject({ ac: 17, acSource: 'derived' });

            const chainMail = await makeItem('Chain Mail', 'armor', { ac: 16, strengthRequired: 13 });
            const r = await equip(chainMail, 'armor');
            expect(r.ac).toMatchObject({ before: 17, after: 16, source: 'derived' });
            expect(sheet()).toMatchObject({ ac: 16, acSource: 'derived' });
        });

        it('the outer schema names every accessory slot and mirrors recomputeAc', () => {
            const outer = InventoryManageTool.inputSchema;
            for (const slot of ['accessory', 'accessory2', 'accessory3']) {
                expect(outer.safeParse({ action: 'equip', characterId: 'c', itemId: 'i', slot }).success).toBe(true);
            }
            const parsed = outer.safeParse({ action: 'equip', characterId: 'c', itemId: 'i', slot: 'armor', recomputeAc: true });
            expect(parsed.success).toBe(true);
            expect((parsed as { data: { recomputeAc?: boolean } }).data.recomputeAc).toBe(true);
            expect(InventoryManageTool.description).toContain('recomputeAc');
        });
    });

    // Play report 4 #3: a misc item with no equipSlots could not be equipped and
    // the refusal was a bare throw with no fix. The refusal now names the real
    // id, the slot that was tried, the allowed slots, and the exact item_manage
    // call that makes the item equippable; nothing is written.
    describe('equippable custom items (play report 4 #3)', () => {
        const owned = async (name: string, type: string, properties?: Record<string, unknown>) => {
            const created = parseItemResult(await handleItemManage({ action: 'create', name, type, weight: 1, value: 1, ...(properties ? { properties } : {}) }, ctx));
            await handleInventoryManage({ action: 'give', characterId: testCharId, itemId: created.item.id, quantity: 1 }, ctx);
            return created.item.id as string;
        };
        const equip = async (itemId: string, slot: string) =>
            parseResult(await handleInventoryManage({ action: 'equip', characterId: testCharId, itemId, slot }, ctx));
        const equippedRow = (itemId: string) =>
            getDb(':memory:').prepare('SELECT equipped, slot FROM inventory_items WHERE character_id = ? AND item_id = ?').get(testCharId, itemId) as { equipped: number; slot: string | null };

        beforeEach(async () => {
            await handleInventoryManage({ action: 'give', characterId: testCharId, itemId: testItemId, quantity: 1 }, ctx);
        });

        it('refuses a misc item with no equipSlots, printing the exact fixing call with the real id and the tried slot', async () => {
            const dosimeter = await owned('Dosimeter', 'misc', { rads: true });
            const data = await equip(dosimeter, 'accessory');
            expect(data.error).toBe(true);
            expect(data.writes).toBe('none');
            expect(data.actionType).toBe('equip');
            expect(data.itemId).toBe(dosimeter);
            expect(data.slot).toBe('accessory');
            expect(data.allowedSlots).toEqual([]);
            expect(data.fix).toEqual({ tool: 'item_manage', args: { action: 'update', itemId: dosimeter, equipSlots: ['accessory'] } });
            expect(data.message).toContain(`item_manage update {itemId: '${dosimeter}', equipSlots: ['accessory']}`);
            expect(data.message).toContain(`properties: {equipSlots: ['accessory']}, mergeProperties: true`);
            expect(data.message).toContain('NOTHING was written');
            expect(equippedRow(dosimeter)).toMatchObject({ equipped: 0 });
            // The rendered refusal carries the NO WRITE stamp (payload-gated on writes: 'none').
            const rendered = await handleInventoryManage({ action: 'equip', characterId: testCharId, itemId: dosimeter, slot: 'accessory' }, ctx);
            expect(rendered.content[0].text).toContain('NO WRITE');
        });

        it('running the printed fix makes the next equip succeed', async () => {
            const dosimeter = await owned('Dosimeter', 'misc', { rads: true });
            const refused = await equip(dosimeter, 'accessory');
            const fixed = parseItemResult(await handleItemManage(refused.fix.args, ctx));
            expect(fixed.success).toBe(true);
            expect(fixed.item.properties).toEqual({ rads: true, equipSlots: ['accessory'] });

            const data = await equip(dosimeter, 'accessory');
            expect(data.success).toBe(true);
            expect(data.slot).toBe('accessory');
            expect(equippedRow(dosimeter)).toMatchObject({ equipped: 1, slot: 'accessory' });
        });

        it('the properties + mergeProperties alternative fixes it too and keeps the other properties', async () => {
            const lamp = await owned('Head Lamp', 'misc', { lumens: 200 });
            expect((await equip(lamp, 'head')).error).toBe(true);
            const fixed = parseItemResult(await handleItemManage({ action: 'update', itemId: lamp, properties: { equipSlots: ['head'] }, mergeProperties: true }, ctx));
            expect(fixed.success).toBe(true);
            expect(fixed.item.properties).toEqual({ lumens: 200, equipSlots: ['head'] });
            expect((await equip(lamp, 'head')).success).toBe(true);
        });

        it('a weapon tried in the armor slot keeps mainhand/offhand in the fix and adds the tried slot', async () => {
            const data = await equip(testItemId, 'armor');
            expect(data.error).toBe(true);
            expect(data.writes).toBe('none');
            expect(data.allowedSlots).toEqual(['mainhand', 'offhand']);
            expect(data.fix.args).toEqual({ action: 'update', itemId: testItemId, equipSlots: ['mainhand', 'offhand', 'armor'] });
            expect(data.message).toContain(`item_manage update {itemId: '${testItemId}', equipSlots: ['mainhand', 'offhand', 'armor']}`);
            expect(data.message).toMatch(/mainhand or offhand/);
            expect(equippedRow(testItemId)).toMatchObject({ equipped: 0 });
        });

        it('a slot the item already allows is never duplicated in the fix', async () => {
            const ring = await owned('Ring', 'misc', { equipSlots: ['accessory'] });
            const data = await equip(ring, 'accessory2');
            expect(data.fix.args.equipSlots).toEqual(['accessory', 'accessory2']);
        });

        it('the slot enum is EQUIP_SLOTS on the inner and outer schemas and in the description', () => {
            const outer = InventoryManageTool.inputSchema;
            for (const slot of EQUIP_SLOTS) {
                expect(outer.safeParse({ action: 'equip', characterId: 'c', itemId: 'i', slot }).success).toBe(true);
                expect(InventoryManageTool.actionSchemas.equip.schema.safeParse({ action: 'equip', characterId: 'c', itemId: 'i', slot }).success).toBe(true);
                expect(InventoryManageTool.actionSchemas.unequip.schema.safeParse({ action: 'unequip', characterId: 'c', slot }).success).toBe(true);
            }
            expect(outer.safeParse({ action: 'equip', characterId: 'c', itemId: 'i', slot: 'ring' }).success).toBe(false);
            expect(InventoryManageTool.description).toContain(EQUIP_SLOTS.join(', '));
        });
    });

    describe('unequip action', () => {
        beforeEach(async () => {
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);
            await handleInventoryManage({
                action: 'equip',
                characterId: testCharId,
                itemId: testItemId,
                slot: 'mainhand'
            }, ctx);
        });

        it('should unequip an item', async () => {
            const result = await handleInventoryManage({
                action: 'unequip',
                characterId: testCharId,
                itemId: testItemId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('unequip');
        });

        it('should accept "doff" alias', async () => {
            const result = await handleInventoryManage({
                action: 'doff',
                characterId: testCharId,
                itemId: testItemId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });
    });

    describe('get action', () => {
        beforeEach(async () => {
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 2
            }, ctx);
        });

        it('should get inventory contents', async () => {
            const result = await handleInventoryManage({
                action: 'get',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('get');
            expect(data.inventory).toBeDefined();
            expect(data.itemCount).toBeGreaterThan(0);
            expect(data.inventory[0].item.name).toBe('Test Sword');
            expect(data.currency).toEqual({ gold: 5, silver: 0, copper: 0 });
        });

        it('should accept "list" alias', async () => {
            const result = await handleInventoryManage({
                action: 'list',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });
    });

    describe('get_detailed action', () => {
        beforeEach(async () => {
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 2
            }, ctx);
        });

        it('should get detailed inventory with weights', async () => {
            const result = await handleInventoryManage({
                action: 'get_detailed',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('get_detailed');
            expect(data.totalWeight).toBeDefined();
            expect(data.capacity).toBe(210);
            expect(data.currency).toEqual({ gold: 5, silver: 0, copper: 0 });
        });

        it('should accept "detailed" alias', async () => {
            const result = await handleInventoryManage({
                action: 'detailed',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should accept "full" alias', async () => {
            const result = await handleInventoryManage({
                action: 'full',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });
    });

    describe('fuzzy matching', () => {
        it('should auto-correct close typos', async () => {
            // "givee" (extra e) has similarity 0.8 with "give" - should auto-correct
            const result = await handleInventoryManage({
                action: 'givee',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should provide helpful error for unknown action', async () => {
            const result = await handleInventoryManage({
                action: 'xyz',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe('invalid_action');
            expect(data.message).toContain('Unknown action');
        });
    });

    describe('output formatting', () => {
        it('should include rich text formatting for give', async () => {
            const result = await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const text = result.content[0].text;
            expect(text).toContain('➕'); // Add emoji
            expect(text).toContain('Test Sword');
        });

        it('should embed JSON for parsing', async () => {
            const result = await handleInventoryManage({
                action: 'get',
                characterId: testCharId
            }, ctx);

            const text = result.content[0].text;
            expect(text).toContain('<!-- INVENTORY_MANAGE_JSON');
        });
    });
});
