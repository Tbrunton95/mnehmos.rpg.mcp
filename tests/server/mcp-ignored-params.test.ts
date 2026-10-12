import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';
import { ConsolidatedTools } from '../../src/server/consolidated/index.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { replyJson, splitEmbed } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';

/**
 * Play report 4 #2, at the protocol boundary. A key the tool's outer schema
 * did not declare used to be stripped twice before the action router ran:
 * by the SDK's default-strip z.object around the registered shape, then by
 * withSession's own parse. The router's ignored-key check never saw it. Both
 * parses are passthrough now, so the key reaches the router and comes back
 * named in ignoredParams; sessionId alone is removed, since no handler reads
 * it. Everything here goes through a real Client on an in-memory transport,
 * the same code path stdio, tcp, unix and websocket take.
 */
describe('ignored params reach the router over MCP', () => {
    let client: Client;
    const seen: Array<Record<string, unknown>> = [];

    beforeAll(async () => {
        closeDb();
        getDb(':memory:');
        // The grapple branch runs before combat_action's router, so what it
        // reports is lane G's business; here only that the key arrives.
        const registry = buildConsolidatedRegistry();
        const original = registry.combat_action.handler as (args: unknown, ctx: unknown) => Promise<unknown>;
        registry.combat_action.handler = async (args: unknown, ctx: unknown) => {
            seen.push({ ...(args as Record<string, unknown>) });
            return original(args, ctx);
        };
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'ignored-params-test', version: '0.0.0' });
        await client.connect(clientTransport);
    });

    afterAll(async () => {
        await client.close();
        closeDb();
    });

    const call = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>)[0].text;
        const data = replyJson(text);
        expect(data, `no JSON in reply: ${text.slice(0, 200)}`).not.toBeNull();
        return { text, data: data!, banner: splitEmbed(text)?.before ?? '' };
    };

    it('tools/list: the 42 consolidated tools, each with a non-empty schema that now admits extra keys', async () => {
        const { tools } = await client.listTools();
        const byName = new Map(tools.map(t => [t.name, t]));
        expect(ConsolidatedTools).toHaveLength(42);
        for (const contract of ConsolidatedTools) {
            const tool = byName.get(contract.name);
            expect(tool, contract.name).toBeDefined();
            const schema = tool!.inputSchema as { type?: string; properties?: Record<string, unknown>; additionalProperties?: unknown };
            expect(schema.type).toBe('object');
            const keys = Object.keys(schema.properties ?? {});
            expect(keys, contract.name).toContain('action');
            expect(keys, contract.name).toContain('sessionId');
            expect(keys.length, contract.name).toBeGreaterThan(2);
            expect(schema.additionalProperties, contract.name).toBe(true);
        }
        expect(byName.has('search_tools')).toBe(true);
        expect(byName.has('load_tool_schema')).toBe(true);
    });

    it('item_manage create with a typo key: the item is created and the key is named once in the banner', async () => {
        const { data, banner } = await call('item_manage', { action: 'create', name: 'Rope', type: 'misc', wieght: 2, sessionId: 'envelope' });
        expect(data.success).toBe(true);
        expect((data.item as { name: string }).name).toBe('Rope');
        expect(data.ignoredParams).toEqual(['wieght']);
        expect(data.message).toMatch(/Ignored params \(not create parameters; nothing was written for them\): wieght — nearest valid key 'weight'\./);
        expect(banner.split('Ignored params').length - 1).toBe(1);
    });

    it('a clean call carries no ignoredParams and no warning line', async () => {
        const { data, banner } = await call('item_manage', { action: 'create', name: 'Lantern', type: 'misc', weight: 2, sessionId: 'envelope', opId: 'clean-1' });
        expect(data.success).toBe(true);
        expect(data.ignoredParams).toBeUndefined();
        expect(banner).not.toContain('Ignored params');
        expect(banner).toContain('op clean-1 applied');
    });

    it('combat_action grapple with a typo key: the key reaches the handler; sessionId does not', async () => {
        seen.length = 0;
        const { data } = await call('combat_action', { action: 'grapple', move: 'clinch', actorId: 'nobody', targetId: 'no-one', advantge: true, sessionId: 'envelope' });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ action: 'grapple', move: 'clinch', actorId: 'nobody', targetId: 'no-one', advantge: true });
        expect('sessionId' in seen[0]).toBe(false);
        // No such actor: refused before any write. Naming the key is lane G's.
        expect(data.error).toBe(true);
        expect(data.writes).toBe('none');
    });

    it('world_manage update (preprocess-wrapped schema): a banner that never prints message gets the warning line', async () => {
        const created = await call('world_manage', { action: 'create', name: 'Mcp World', seed: 'mcp', width: 20, height: 20 });
        const worldId = created.data.worldId as string;
        const { data, banner } = await call('world_manage', { action: 'update', id: worldId, environment: { season: 'winter' }, bogus: 1 });
        expect(data.success).toBe(true);
        expect((data.environment as { season: string }).season).toBe('winter');
        expect(data.ignoredParams).toEqual(['bogus']);
        expect(banner).toContain("> ⚠️ **WARNING**: Ignored params (not update parameters; nothing was written for them): bogus — no close match among update's parameters.");
        expect(banner.split('Ignored params').length - 1).toBe(1);
    });

    it('fields: [...] keeps ignoredParams beside the asked-for field', async () => {
        const created = await call('world_manage', { action: 'create', name: 'Fields World', seed: 'fields', width: 20, height: 20 });
        const worldId = created.data.worldId as string;
        const res = await client.callTool({ name: 'world_manage', arguments: { action: 'update', id: worldId, environment: { season: 'spring' }, bogus: 1, fields: ['worldId'] } });
        const text = (res.content as Array<{ text: string }>)[0].text;
        expect(JSON.parse(text)).toMatchObject({ success: true, worldId, ignoredParams: ['bogus'] });
    });

    it('a validation error over MCP names the unknown key beside the missing one', async () => {
        const { data } = await call('item_manage', { action: 'create', nmae: 'Rope', type: 'misc' });
        expect(data.error).toBe('validation_error');
        expect(data.writes).toBe('none');
        expect(data.unknownParams).toEqual(['nmae']);
        expect((data.issues as Array<{ path: string; message: string }>).find(i => i.path === 'name')!.message).toBe("Required — you sent 'nmae'; did you mean 'name'?");
    });

    it("a worldId the action does not take still stamps the dice it rolled, and the reply says that instead of 'no close match'", async () => {
        // rest_manage's outer schema has no worldId, so before this change the SDK
        // dropped the key before the operation guard saw it. Now it reaches the
        // guard, which stamps roll_log.world_id with it for every die the call
        // rolls — so the ignored-key note must name that, not claim the key did nothing.
        const created = await call('character_manage', { action: 'create', name: 'Rester', class: 'fighter', level: 1 });
        const characterId = created.data.id as string;
        const { data } = await call('rest_manage', { action: 'short', characterId, hitDiceToSpend: 1, worldId: 'W-stray' });
        expect(data.error, JSON.stringify(data).slice(0, 400)).toBeFalsy();
        expect(data.restType).toBe('short');
        expect(data.hitDiceSpent).toBe(1);
        expect(data.ignoredParams).toEqual(['worldId']);
        expect(data.message).toMatch(/Ignored params \(not short parameters; nothing was written for them\): worldId — not among short's parameters; it only stamps this call's dice log \(roll_log\.world_id\)\./);
        const rows = getDb().prepare('SELECT purpose, world_id FROM roll_log WHERE for_id = ?').all(characterId) as Array<{ purpose: string; world_id: string | null }>;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every(r => r.purpose === 'hit_dice' && r.world_id === 'W-stray')).toBe(true);
    });

    it('a non-router tool still parses its own input and strips as before', async () => {
        const created = await call('world_manage', { action: 'create', name: 'Precedent World', seed: 'prec', width: 20, height: 20 });
        const worldId = created.data.worldId as string;
        const { data, text } = await call('precedent_manage', { action: 'list', worldId, bogus: 1, sessionId: 'envelope' });
        expect(data.error).toBeFalsy();
        expect(data.count).toBe(0);
        expect(text).not.toMatch(/Unrecognized key|validation_error/);
    });

    it('none of the 14 tools without a router chokes on an undeclared key now that it reaches them', async () => {
        const nonRouter = ['batch_manage', 'comms_manage', 'congregation_manage', 'container_manage', 'horde_manage', 'hull_manage', 'siege_manage',
            'knowledge_manage', 'ledger_manage', 'precedent_manage', 'session_manage', 'spawn_manage', 'table_rules', 'travel_manage', 'vehicle_manage'];
        for (const name of nonRouter) {
            // An unknown action with a stray key: their own strip schema drops the key, so
            // whatever they answer (unknown action, missing worldId), it is never zod's
            // "Unrecognized key(s)" and never an SDK InvalidParams rejection.
            const res = await client.callTool({ name, arguments: { action: 'no_such_action', bogus: 1, sessionId: 'envelope' } });
            const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
            expect(text, name).not.toMatch(/[Uu]nrecognized key/);
        }
    });
});
