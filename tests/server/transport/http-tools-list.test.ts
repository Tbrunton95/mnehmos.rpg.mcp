import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServerTransport } from '../../../src/server/transport/http';
import { buildServer } from '../../../src/server/build-server';
import { PubSub } from '../../../src/engine/pubsub';
import { AuditLogger } from '../../../src/server/audit';
import { ConsolidatedTools } from '../../../src/server/consolidated/index';

const AUTH = 'service-token';

/**
 * rpg-mcp-live reaches this engine over HTTP and loads its tool catalog
 * from tools/list. Play report 4 #2 re-registered every consolidated tool
 * through registerTool with a passthrough object; this proves the catalog
 * the live service reads is still whole — 42 tools, each with its real
 * parameters — and now says additionalProperties: true.
 */
describe('HTTP transport tools/list', () => {
    let server: Server;
    let url: string;

    beforeAll(async () => {
        const pubsub = new PubSub();
        const audit = new AuditLogger();
        server = await startHttpServerTransport(() => buildServer(pubsub, audit), 0, { host: '127.0.0.1', authToken: AUTH, tenantSecret: 'tenant-secret' });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    });

    afterAll(async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('serves the 42 consolidated tools with their parameters and passthrough schemas to an MCP client', async () => {
        const client = new Client({ name: 'http-tools-list', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${AUTH}` } } });
        await client.connect(transport);
        try {
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
                expect(keys.length, contract.name).toBeGreaterThan(2);
                expect(schema.additionalProperties, contract.name).toBe(true);
            }
            expect(byName.has('search_tools')).toBe(true);
        } finally {
            await client.close();
        }
    });

    it('answers a bare JSON-RPC tools/list POST, as the live service sends it', async () => {
        const res = await fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${AUTH}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        });
        expect(res.status).toBe(200);
        const raw = await res.text();
        // Stateless mode answers as an SSE stream or plain JSON depending on the SDK's response mode.
        const payload = raw.trimStart().startsWith('{')
            ? raw
            : raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).find(l => l.includes('"tools"'));
        expect(payload, raw.slice(0, 300)).toBeDefined();
        const message = JSON.parse(payload!);
        const names = new Set((message.result.tools as Array<{ name: string }>).map(t => t.name));
        for (const contract of ConsolidatedTools) expect(names.has(contract.name), contract.name).toBe(true);
        const item = (message.result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown>; additionalProperties?: unknown } }>).find(t => t.name === 'item_manage')!;
        expect(Object.keys(item.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['action', 'itemId', 'name', 'sessionId', 'output_mode']));
        expect(item.inputSchema.additionalProperties).toBe(true);
    });
});
