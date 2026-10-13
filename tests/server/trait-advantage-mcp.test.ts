/**
 * Play report 5 #8c over the real MCP boundary. The lane tests call the
 * handlers directly; a client reaches them through the SDK's outer-shape
 * validation and withSession's re-parse. The nested params this feature adds
 * (character_manage skillAdvantage: an array of objects; math_manage context:
 * an array of tags; scene_manage senseDenial: an object or an array of
 * objects) must survive both layers, and tools/list must advertise them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { schemaShape } from '../../src/server/schema-shape.js';
import { withSession } from '../../src/server/types.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';

process.env.NODE_ENV = 'test';

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
function payload(result: unknown): Record<string, any> {
    const text = (result as ToolResult).content?.[0]?.text ?? '';
    const m = text.match(/<!-- ([A-Z_]+_JSON)\n([\s\S]*?)\n\1 -->/);
    if (m) return JSON.parse(m[2]);
    // scene_manage replies with plain JSON (no banner).
    try { return JSON.parse(text); } catch { throw new Error(`no JSON in reply:\n${text}`); }
}

describe('trait advantage over the MCP boundary (play report 5 #8c)', () => {
    let client: Client;
    let server: McpServer;
    const W = 'moor';
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Moor', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        server = new McpServer({ name: 'rpg-mcp-test', version: '0.0.0' });
        const registry = buildConsolidatedRegistry();
        const envelopeShape = {
            sessionId: z.string().optional(),
            output_mode: z.enum(['json', 'banner', 'summary']).optional(),
            opId: z.string().optional(),
            fields: z.array(z.string()).optional(),
        };
        for (const toolName of ['character_manage', 'math_manage', 'scene_manage']) {
            const entry = registry[toolName];
            server.tool(toolName, entry.metadata.description, schemaShape(entry.schema.extend(envelopeShape)),
                withOperation(toolName, withSession(entry.schema, entry.handler as any) as any) as any);
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

    it('tools/list advertises skillAdvantage, context, against, senseDenial and wind', async () => {
        const { tools } = await client.listTools();
        const props = (name: string) => tools.find(t => t.name === name)!.inputSchema.properties as Record<string, any>;
        expect(props('character_manage').skillAdvantage.type).toBe('array');
        expect(props('character_manage').senses).toBeDefined();
        expect(props('character_manage').naturalArmor).toBeDefined();
        expect(props('math_manage').context).toBeDefined();
        expect(props('math_manage').against).toBeDefined();
        expect(props('math_manage').targetContext).toBeDefined();
        expect(props('scene_manage').senseDenial).toBeDefined();
        expect(props('scene_manage').wind).toBeDefined();
    });

    it('the trait, the tagged check, the denial and the lifted denial all cross the boundary intact', async () => {
        const created = await call('character_manage', { action: 'create', name: 'Varek', worldId: W, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 12, cha: 10 },
            skillAdvantage: [{ name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent', passiveBonus: 5 }] });
        expect(created.skillAdvantage).toEqual([{ name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent', passiveBonus: 5 }]);

        const tagged = await call('math_manage', { action: 'roll_skill_check', characterId: created.id, skill: 'perception', context: ['scent'] });
        expect(tagged.rolls).toHaveLength(2);
        expect(tagged.advantageSources).toEqual(['Keen Smell (scent)']);

        const denied = await call('scene_manage', { action: 'set', worldId: W, narration: 'The wind turns.', participants: [created.id], senseDenial: { scent: 'wind from the east carries everything away' } });
        expect(denied.success).toBe(true);
        expect(denied.scene.senseDenial).toEqual([{ senses: { scent: 'wind from the east carries everything away' } }]);
        const under = await call('math_manage', { action: 'roll_skill_check', characterId: created.id, skill: 'perception', context: ['scent'] });
        expect(under.rolls).toHaveLength(1);
        expect(under.deniedAdvantage).toEqual([{ trait: 'Keen Smell', when: 'scent', reason: 'wind from the east carries everything away' }]);

        const perTarget = await call('scene_manage', { action: 'set', worldId: W, narration: 'Smoke.', participants: [created.id], senseDenial: [{ targetId: created.id, scent: 'buried in peat-smoke' }], wind: 'from W' });
        expect(perTarget.scene.senseDenial).toEqual([{ targetId: created.id, senses: { scent: 'buried in peat-smoke' } }]);
        expect(perTarget.scene.wind).toBe('from W');

        const block = await call('character_manage', { action: 'get_status_block', characterId: created.id });
        expect(block.passive).toEqual({ perception: 11, senses: [{ when: 'scent', trait: 'Keen Smell', value: 16, label: 'passive Perception (scent) 16' }] });
    });

    it('a malformed trait is refused at the SDK with nothing written', async () => {
        const result = await client.callTool({ name: 'character_manage', arguments: { action: 'create', name: 'Bad', skillAdvantage: [{ name: 'X', skills: 'perception', when: 'scent' }] } }) as ToolResult;
        expect(result.isError).toBe(true);
        expect(result.content?.[0]?.text).toMatch(/skillAdvantage/);
        const n = (getDb().prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n;
        expect(n).toBe(0);
    });
});
