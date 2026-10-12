/**
 * Play report 4 #3 over the real MCP boundary.
 *
 * The lane tests call handleItemManage / handleInventoryManage directly. A
 * client reaches those handlers through two more layers: the SDK validates
 * the call against the tool's registered outer shape (a default-strip
 * z.object — a key the outer schema lacks vanishes here), then withSession
 * parses the args again with the tool's own schema. This file registers the
 * two tools exactly as src/server/index.ts does and drives them with a real
 * Client over InMemoryTransport, so it proves the GM's stated need end to end:
 *  - a misc item created with equipSlots equips
 *  - without equipSlots the refusal's fix {tool, args} fed back as a tool call
 *    makes the next equip succeed
 *  - properties.equipSlots is validated over the boundary too (writes: 'none')
 *  - tools/list advertises equipSlots on item_manage and the full slot enum on
 *    inventory_manage (the contract rpg-mcp-live reads)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { schemaShape } from '../../src/server/schema-shape.js';
import { withSession } from '../../src/server/types.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';
import { EQUIP_SLOTS } from '../../src/schema/inventory.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';

process.env.NODE_ENV = 'test';

type ToolResult = { content?: Array<{ type: string; text?: string }> };

/** The embedded JSON of a consolidated reply (ITEM_MANAGE_JSON / INVENTORY_MANAGE_JSON). */
function payload(result: unknown): Record<string, any> {
    const text = (result as ToolResult).content?.[0]?.text ?? '';
    const m = text.match(/<!-- ([A-Z_]+_JSON)\n([\s\S]*?)\n\1 -->/);
    if (!m) throw new Error(`no embedded JSON in reply:\n${text}`);
    return JSON.parse(m[2]);
}

describe('equippable custom items over the MCP boundary (play report 4 #3)', () => {
    let client: Client;
    let server: McpServer;
    let characterId: string;

    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        characterId = randomUUID();
        new CharacterRepository(db).create({
            id: characterId, name: 'Marine', class: 'fighter', level: 1, race: 'human',
            hp: 10, maxHp: 10, ac: 11, stats: { str: 14, dex: 12, con: 13, int: 10, wis: 11, cha: 10 },
            currency: { gold: 0, silver: 0, copper: 0 }, speed: 30,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } as any);

        // Register exactly as buildServer does (index.ts): the extended outer
        // shape goes to the SDK, withSession re-parses with the tool's schema,
        // withOperation wraps the call in the write lock.
        server = new McpServer({ name: 'rpg-mcp-test', version: '0.0.0' });
        const registry = buildConsolidatedRegistry();
        const envelopeShape = {
            sessionId: z.string().optional(),
            output_mode: z.enum(['json', 'banner', 'summary']).optional(),
            opId: z.string().optional(),
            fields: z.array(z.string()).optional(),
        };
        for (const toolName of ['item_manage', 'inventory_manage']) {
            const entry = registry[toolName];
            const extended = entry.schema.extend(envelopeShape);
            server.tool(
                toolName,
                entry.metadata.description,
                schemaShape(extended),
                withOperation(toolName, withSession(entry.schema, entry.handler as any) as any) as any
            );
        }
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'test-client', version: '0.0.0' });
        await client.connect(clientTransport);
    });

    afterEach(async () => {
        await client?.close();
        await server?.close();
        closeDb();
    });

    it('tools/list advertises equipSlots on item_manage and the full slot enum on inventory_manage', async () => {
        const { tools } = await client.listTools();
        const item = tools.find(t => t.name === 'item_manage')!;
        const inv = tools.find(t => t.name === 'inventory_manage')!;
        const itemProps = item.inputSchema.properties as Record<string, any>;
        const invProps = inv.inputSchema.properties as Record<string, any>;
        expect(itemProps.equipSlots).toBeDefined();
        expect(itemProps.equipSlots.type).toBe('array');
        expect(itemProps.equipSlots.items.enum).toEqual([...EQUIP_SLOTS]);
        expect(invProps.slot.enum).toEqual([...EQUIP_SLOTS]);
    });

    it('a misc item created with equipSlots equips in that slot', async () => {
        const created = await call('item_manage', { action: 'create', name: 'Dosimeter', type: 'misc', weight: 1, value: 5, properties: { rads: true }, equipSlots: ['accessory'] });
        expect(created.success).toBe(true);
        // equipSlots crossed the SDK's outer-shape validation and withSession intact.
        expect(created.item.properties).toEqual({ rads: true, equipSlots: ['accessory'] });

        const given = await call('inventory_manage', { action: 'give', characterId, itemId: created.item.id, quantity: 1 });
        expect(given.success ?? !given.error).toBeTruthy();

        const equipped = await call('inventory_manage', { action: 'equip', characterId, itemId: created.item.id, slot: 'accessory' });
        expect(equipped.success).toBe(true);
        expect(equipped.slot).toBe('accessory');
        const row = getDb(':memory:').prepare('SELECT equipped, slot FROM inventory_items WHERE character_id = ? AND item_id = ?').get(characterId, created.item.id) as { equipped: number; slot: string };
        expect(row).toMatchObject({ equipped: 1, slot: 'accessory' });
    });

    it("without equipSlots the refusal's fix, fed back as a tool call, makes the next equip succeed", async () => {
        const created = await call('item_manage', { action: 'create', name: 'Patch', type: 'misc', weight: 0, value: 1, properties: { dose: 'low' } });
        await call('inventory_manage', { action: 'give', characterId, itemId: created.item.id, quantity: 1 });

        const refused = await call('inventory_manage', { action: 'equip', characterId, itemId: created.item.id, slot: 'accessory2' });
        expect(refused.error).toBe(true);
        expect(refused.writes).toBe('none');
        expect(refused.fix).toEqual({ tool: 'item_manage', args: { action: 'update', itemId: created.item.id, equipSlots: ['accessory2'] } });
        expect(refused.message).toContain(`item_manage update {itemId: '${created.item.id}', equipSlots: ['accessory2']}`);
        expect(refused.message).toContain('NOTHING was written');

        // The printed call, run as the client would run it.
        const fixed = await call(refused.fix.tool, refused.fix.args);
        expect(fixed.success).toBe(true);
        expect(fixed.item.properties).toEqual({ dose: 'low', equipSlots: ['accessory2'] });

        const equipped = await call('inventory_manage', { action: 'equip', characterId, itemId: created.item.id, slot: 'accessory2' });
        expect(equipped.success).toBe(true);
        expect(equipped.slot).toBe('accessory2');
    });

    it('properties.equipSlots is validated over the boundary: an unknown slot is refused with the nearest slot and nothing written', async () => {
        const refused = await call('item_manage', { action: 'create', name: 'Glove', type: 'misc', properties: { equipSlots: ['mainhnd'] } });
        expect(refused.error).toBe(true);
        expect(refused.writes).toBe('none');
        expect(refused.message).toMatch(/nearest is 'mainhand'/);
        const listed = await call('item_manage', { action: 'list' });
        expect(listed.count).toBe(0);
    });

    it('an unknown top-level slot is refused by the outer schema at the SDK with nothing written', async () => {
        const result = await client.callTool({ name: 'item_manage', arguments: { action: 'create', name: 'Glove', type: 'misc', equipSlots: ['ring'] } }) as ToolResult & { isError?: boolean };
        expect(result.isError).toBe(true);
        expect(result.content?.[0]?.text).toMatch(/equipSlots/);
        const listed = await call('item_manage', { action: 'list' });
        expect(listed.count).toBe(0);
    });
});
