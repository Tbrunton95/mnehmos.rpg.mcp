/**
 * Play report 5 #9 over the real MCP boundary.
 *
 * The SDK validates every tools/call against the registered outer shape
 * BEFORE any tool code runs (validateToolInput, then withSession's parse), so
 * the only words a GM sees for a wrong-typed knower are the ones carried on
 * the zod schema itself. This drives knowledge_manage through a real Client on
 * InMemoryTransport, the path stdio, tcp, unix and websocket take, and proves:
 *  - a bare string knower crosses the boundary and is refused by the handler
 *    with the shape, an example and writes: 'none' (never a default road)
 *  - bare strings with one top-level `how` record
 *  - a knower of the wrong type is refused at the SDK with the shape in its
 *    message, not only "Expected object, received string"
 *  - tools/list still advertises the knower object (id required, how an enum)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { replyJson } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';

const W = 'vorago';
type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

describe('knowledge_manage knowers over the MCP boundary (play report 5 #9)', () => {
    let client: Client;

    beforeEach(async () => {
        closeDb();
        const repo = new CharacterRepository(getDb(':memory:'));
        const now = new Date().toISOString();
        for (const [id, name] of [['luciel', 'Luciel'], ['vigil', 'Vigil']]) {
            repo.create({ id, name, characterType: 'npc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 10, level: 1, createdAt: now, updatedAt: now } as any);
        }
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'knowers-boundary-test', version: '0.0.0' });
        await client.connect(clientTransport);
    });

    afterEach(async () => {
        await client.close();
        closeDb();
    });

    const raw = async (args: Record<string, unknown>) => await client.callTool({ name: 'knowledge_manage', arguments: { worldId: W, ...args } }) as ToolResult;
    const call = async (args: Record<string, unknown>) => {
        const res = await raw(args);
        const text = res.content?.[0]?.text ?? '';
        const data = replyJson(text);
        expect(data, `no JSON in reply: ${text.slice(0, 300)}`).not.toBeNull();
        return { text, data: data as Record<string, any>, isError: res.isError };
    };

    it('a bare string knower without a road is refused by the handler with the shape, and nothing is written', async () => {
        const { data, text } = await call({ action: 'record', key: 'ithraes', statement: 'x', knowers: ['luciel'] });
        expect(data.error).toBe(true);
        expect(data.writes).toBe('none');
        expect(text).toMatch(/each knower is an object \{id, how, fromId\?/);
        expect(text).toMatch(/e\.g\. knowers: \[\{id: 'luciel', how: 'witnessed'\}/);
        expect(text).not.toMatch(/Expected object, received string/);
        expect((await call({ action: 'list' })).data.count).toBe(0);
    });

    it('bare string knowers with one top-level how record over the wire', async () => {
        const { data } = await call({ action: 'record', key: 'ithraes', statement: 'x', knowers: ['luciel', 'vigil'], how: 'position' });
        expect(data.success).toBe(true);
        const who = await call({ action: 'who_knows', key: 'ithraes' });
        expect(who.data.knowers.map((k: any) => k.road)).toEqual(['Luciel: position', 'Vigil: position']);
    });

    it('a wrong-typed knower is refused at the SDK with the shape in the message, and nothing is written', async () => {
        const res = await raw({ action: 'record', key: 'ithraes', statement: 'x', knowers: [42] });
        expect(res.isError).toBe(true);
        const text = res.content?.[0]?.text ?? '';
        expect(text).toMatch(/each knower is an object \{id, how, fromId\?/);
        expect(text).toMatch(/e\.g\. knowers: \[\{id: 'luciel', how: 'witnessed'\}/);
        expect((await call({ action: 'list' })).data.count).toBe(0);
    });

    it('a knower with an unknown road is refused at the SDK naming the roads, and nothing is written', async () => {
        const res = await raw({ action: 'record', key: 'ithraes', statement: 'x', knowers: [{ id: 'luciel', how: 'guessed' }] });
        expect(res.isError).toBe(true);
        expect(res.content?.[0]?.text ?? '').toMatch(/witnessed \| told \| position \| deduced \| read \| rumour/);
        expect((await call({ action: 'list' })).data.count).toBe(0);
    });

    it('tools/list advertises the knower object: id required, how the road enum, and the shape in the description', async () => {
        const { tools } = await client.listTools();
        const tool = tools.find(t => t.name === 'knowledge_manage')!;
        const knowers = (tool.inputSchema.properties as Record<string, any>).knowers;
        expect(knowers.type).toBe('array');
        expect(knowers.items.type).toBe('object');
        expect(knowers.items.required).toEqual(['id']);
        expect(knowers.items.properties.how.enum).toEqual(['witnessed', 'told', 'position', 'deduced', 'read', 'rumour']);
        expect(knowers.description).toMatch(/\{id, how, fromId\?/);
        expect(tool.description).toMatch(/knowers\?: \[\{id, how, fromId\?, note\?, day\?\}\]/);
    });

    it('knowers given as one bare string (not an array) is refused at the SDK with the shape in the message', async () => {
        const res = await raw({ action: 'record', key: 'ithraes', statement: 'x', knowers: 'luciel', how: 'witnessed' });
        expect(res.isError).toBe(true);
        const text = res.content?.[0]?.text ?? '';
        expect(text).toMatch(/each knower is an object \{id, how, fromId\?/);
        expect(text).toMatch(/knowers: \['luciel', 'vigil'\], how: 'witnessed'/);
        expect((await call({ action: 'list' })).data.count).toBe(0);
    });
});
