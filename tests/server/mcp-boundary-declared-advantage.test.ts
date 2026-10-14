/**
 * Play report 7 #7, #8 and #11 over the real MCP boundary. The lane tests call
 * the handlers; a client reaches them through the SDK's outer-shape
 * validation and withSession's re-parse. The new params (math_manage
 * situationalAdvantage / situationalDisadvantage, the scope strings nested in
 * improvisation_manage mechanics[]) must survive both layers, and tools/list
 * must advertise them.
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
    try { return JSON.parse(text); } catch { throw new Error(`no JSON in reply:\n${text}`); }
}

describe('declared advantage over the MCP boundary (play report 7)', () => {
    let client: Client;
    let server: McpServer;
    const W = 'blackcrown';
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        server = new McpServer({ name: 'rpg-mcp-test', version: '0.0.0' });
        const registry = buildConsolidatedRegistry();
        const envelopeShape = {
            sessionId: z.string().optional(),
            output_mode: z.enum(['json', 'banner', 'summary']).optional(),
            opId: z.string().optional(),
            fields: z.array(z.string()).optional(),
        };
        for (const toolName of ['character_manage', 'math_manage', 'improvisation_manage']) {
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

    it('tools/list advertises the situational reasons as strings on math_manage', async () => {
        const { tools } = await client.listTools();
        const props = tools.find(t => t.name === 'math_manage')!.inputSchema.properties as Record<string, any>;
        expect(props.situationalAdvantage.type).toBe('string');
        expect(props.situationalDisadvantage.type).toBe('string');
        expect(props.advantageSources.type).toBe('array');
    });

    it('Horn-Lock converted over the wire, then named, tagged and refused; Keen Smell by name; sleight-of-hand rolls DEX', async () => {
        const varek = await call('character_manage', {
            action: 'create', name: 'Varek', worldId: W, stats: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
            conditions: [{ name: 'Horn-Lock: locks horns with a rival head-on' }, { name: 'Gor Hunter' }],
            skillAdvantage: [{ name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent' }]
        });
        expect(varek.id).toBeTruthy();

        // A scope outside the grammar is refused at the handler, nothing written.
        const bad = await call('improvisation_manage', { action: 'feature_from_condition', characterId: varek.id, match: 'Horn-Lock', mechanics: [{ type: 'advantage_on', value: 'grapples', condition: 'head-on' }] });
        expect(bad.error).toBe(true);
        expect(bad.writes).toBe('none');
        expect(bad.mechanicProblems[0]).toMatch(/'grapples' is not a scope/);

        // The nested scope and tag survive the SDK and the re-parse.
        const conv = await call('improvisation_manage', { action: 'feature_from_condition', characterId: varek.id, match: 'Horn-Lock', mechanics: [{ type: 'advantage_on', value: 'check:athletics', condition: 'head-on' }] });
        expect(conv.success).toBe(true);
        expect(conv.feature.mechanics).toEqual([{ type: 'advantage_on', value: 'check:athletics', condition: 'head-on' }]);

        const named = await call('math_manage', { action: 'roll_skill_check', characterId: varek.id, skill: 'athletics', advantageSources: ['Horn-Lock'] });
        expect(named.rolls).toHaveLength(2);
        expect(named.advantageSources).toEqual(['Horn-Lock (head-on, named)']);
        const tagged = await call('math_manage', { action: 'roll_skill_check', characterId: varek.id, skill: 'athletics', context: ['head-on'] });
        expect(tagged.advantageSources).toEqual(['Horn-Lock (head-on)']);

        const hunter = await call('math_manage', { action: 'roll_skill_check', characterId: varek.id, skill: 'stealth', advantageSources: ['Gor Hunter'] });
        expect(hunter.error).toBe(true);
        expect(hunter.writes).toBe('none');
        expect(hunter.sourceProblems[0]).toContain(`feature_from_condition {characterId: '${varek.id}', match: 'Gor Hunter'`);

        const nose = await call('math_manage', { action: 'roll_skill_check', characterId: varek.id, skill: 'perception', advantageSources: ['Keen Smell'] });
        expect(nose.advantageSources).toEqual(['Keen Smell (scent, named)']);

        const ruling = await call('math_manage', { action: 'roll_saving_throw', characterId: varek.id, ability: 'wis', situationalAdvantage: 'the Choir sings' });
        expect(ruling.advantageSources).toEqual(['GM: the Choir sings']);
        expect(ruling.situationalAdvantage).toBe('the Choir sings');

        const sleight = await call('math_manage', { action: 'roll_skill_check', characterId: varek.id, skill: 'sleight-of-hand' });
        expect(sleight.skillAbility).toBe('dex');
        expect(sleight.breakdown).toContain('DEX +2');
    });

    it('a non-string situational reason is refused at the SDK with nothing rolled', async () => {
        const v = await call('character_manage', { action: 'create', name: 'Kessa', worldId: W });
        const res = await client.callTool({ name: 'math_manage', arguments: { action: 'roll_saving_throw', characterId: v.id, ability: 'wis', situationalAdvantage: true } }) as ToolResult;
        expect(res.isError).toBe(true);
        let n = 0;
        try { n = (getDb().prepare('SELECT COUNT(*) AS n FROM roll_log').get() as { n: number }).n; } catch { /* no table: nothing logged */ }
        expect(n).toBe(0);
    });

    it('context sent as a JSON string of an array is read as the array, as grapple and attack read it (review)', async () => {
        const v = await call('character_manage', { action: 'create', name: 'Kessa', worldId: W });
        const ward = await call('improvisation_manage', { action: 'apply_effect', targetId: v.id, name: 'Choir Ward', category: 'boon', durationType: 'until_removed', mechanics: [{ type: 'advantage_on', value: 'save:wis', condition: 'the Choir sings' }] });
        expect(ward.success).toBe(true);
        const save = await call('math_manage', { action: 'roll_saving_throw', characterId: v.id, ability: 'wis', context: '["the Choir sings"]', seed: 'json-tags' });
        expect(save.context).toEqual(['the Choir sings']);
        expect(save.advantageSources).toEqual(['Choir Ward (the Choir sings)']);
        expect(save.resolverProblems).toBeUndefined();
        const bare = await call('math_manage', { action: 'roll_saving_throw', characterId: v.id, ability: 'wis', context: 'the Choir sings', seed: 'json-tags' });
        expect(bare.advantageSources).toEqual(['Choir Ward (the Choir sings)']);
    });
});
