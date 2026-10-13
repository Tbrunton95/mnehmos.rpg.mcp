/**
 * Play report 6 #3 over the real MCP boundary: schedule_change {writes:
 * [{op: 'set_part', …}]} is a nested array item on character_manage's outer
 * mirror, which strips keys it does not declare and rejects type mismatches
 * with a raw Zod dump. The mirror shares the inner op schema instance, so
 * every part key must cross tools/call intact and come back from
 * list_scheduled; a state the grammar refuses must fail before any row is
 * inserted.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { schemaShape } from '../../src/server/schema-shape.js';
import { withSession } from '../../src/server/types.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';

process.env.NODE_ENV = 'test';

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
function payload(result: unknown): Record<string, any> {
    const text = (result as ToolResult).content?.[0]?.text ?? '';
    const m = text.match(/<!-- ([A-Z_]+_JSON)\n([\s\S]*?)\n\1 -->/);
    if (m) return JSON.parse(m[2]);
    try { return JSON.parse(text); } catch { throw new Error(`no JSON in reply:\n${text}`); }
}

const TOOLS = ['character_manage', 'combat_manage', 'improvisation_manage', 'table_rules'];
const W = 'skinwood';
const PART_WRITE = { op: 'set_part', part: 'left arm', state: 'intact', kind: 'arm', holds: ['claw'], ac: 15, hp: 4, maxHp: 8, breakAt: 10, note: 'knitted' };

describe('scheduled body parts over the MCP boundary (play report 6 #3)', () => {
    let client: Client;
    let server: McpServer;
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));
    const raw = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as ToolResult;
    const scheduledRows = () => { try { return (getDb().prepare('SELECT COUNT(*) AS n FROM scheduled_state_changes').get() as { n: number }).n; } catch { return 0; } };
    const sheetParts = () => (new CharacterRepository(getDb()).findById('manyskins') as any).parts;

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Skinwood', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now, environment: { day: 10, time: '08:00' } } as any);
        new CharacterRepository(db).create({
            id: 'manyskins', name: 'Many-Skins', characterType: 'pc', level: 3,
            stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 30, maxHp: 30, ac: 13,
            parts: [{ name: 'left arm', kind: 'arm', state: 'crippled', holds: ['claw'] }], createdAt: now, updatedAt: now
        } as any);
        try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
        db.prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(W, 'manyskins');
        server = new McpServer({ name: 'rpg-mcp-test', version: '0.0.0' });
        const registry = buildConsolidatedRegistry();
        const envelopeShape = {
            sessionId: z.string().optional(),
            output_mode: z.enum(['json', 'banner', 'summary']).optional(),
            opId: z.string().optional(),
            fields: z.array(z.string()).optional(),
        };
        for (const toolName of TOOLS) {
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
        clearCombatState();
        closeDb();
    });

    it('tools/list advertises writes on character_manage with the part ops and fields in the item schema', async () => {
        const { tools } = await client.listTools();
        const props = tools.find(t => t.name === 'character_manage')!.inputSchema.properties as Record<string, any>;
        expect(props.writes).toBeDefined();
        const item = props.writes.items ?? props.writes.anyOf?.find((s: any) => s.type === 'array')?.items;
        const text = JSON.stringify(item ?? props.writes);
        for (const key of ['set_part', 'remove_part', '"part"', '"state"', '"kind"', '"holds"', '"breakAt"']) expect(text).toContain(key);
        expect(text).not.toMatch(/"latched"/);
        // The describes a GM reads name the part ops where the writes grammar is explained.
        expect(props.writes.description).toMatch(/\{op: 'set_part', part: 'left arm', state: 'intact'.*\} \/ \{op: 'remove_part', part\}/);
        expect(props.writes.description).toMatch(/every live token/);
        const describe = (name: string) => tools.find(t => t.name === name)!.description ?? '';
        expect(describe('improvisation_manage')).toMatch(/remove_condition, set_part, remove_part/);
        expect(describe('table_rules')).toMatch(/set_part \/ remove_part included/);
    });

    it('schedule_change keeps every set_part key through the mirror and list_scheduled; firing writes the sheet and the token', async () => {
        const enc = (await call('combat_manage', { action: 'create', worldId: W, participants: [
            { id: 'manyskins', name: 'Many-Skins', hp: 30, maxHp: 30, initiative: 30 },
            { id: 'gor', name: 'Gor', hp: 20, maxHp: 20, initiative: 10, isEnemy: true }
        ] })).encounterId as string;
        const r = await call('character_manage', { action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 12, writes: [PART_WRITE, { op: 'remove_part', part: 'tail' }], note: 'the arm knits' });
        expect(r).toMatchObject({ success: true, ops: 2 });
        const list = await call('character_manage', { action: 'list_scheduled', worldId: W });
        expect(list.scheduled).toHaveLength(1);
        expect(JSON.parse(list.scheduled[0].writes)).toEqual([PART_WRITE, { op: 'remove_part', part: 'tail' }]);
        const fired = await call('character_manage', { action: 'process_scheduled', worldId: W, currentDay: 12 });
        expect(fired.results[0].applied).toEqual([`set_part: left arm crippled → intact (sheet; token in ${enc})`, 'part "tail" not present on sheet — skipped']);
        expect(sheetParts()).toEqual([{ name: 'left arm', kind: 'arm', state: 'intact', holds: ['claw'], ac: 15, hp: 4, maxHp: 8, breakAt: 10, note: 'knitted' }]);
        const tok = (await call('combat_manage', { action: 'get', encounterId: enc })).participants.find((p: any) => p.id === 'manyskins');
        expect(tok.parts).toEqual([{ name: 'left arm', kind: 'arm', state: 'intact', holds: ['claw'], ac: 15, hp: 4, maxHp: 8, breakAt: 10, note: 'knitted' }]);
    });

    it('a state the grammar refuses (latched, or a typo) fails at the boundary with nothing inserted', async () => {
        for (const state of ['latched', 'broken']) {
            const res = await raw('character_manage', { action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 12, writes: [{ op: 'set_part', part: 'left arm', state }] });
            expect(res.isError).toBe(true);
            expect(res.content?.[0]?.text ?? '').toMatch(/state/);
        }
        expect(scheduledRows()).toBe(0);
        expect(sheetParts()[0].state).toBe('crippled');
    });

    it('a writes string is parsed first, so a JSON string with a part op is a clock like any other', async () => {
        const r = await call('character_manage', { action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 10, fireNow: true, writes: JSON.stringify([{ op: 'set_part', part: 'left arm', state: 'intact' }]) });
        expect(r.applied).toEqual(['set_part: left arm crippled → intact (sheet)']);
        expect(sheetParts()[0].state).toBe('intact');
    });

    it('tools/list names the part ops where a GM reads the montage cost shapes (the costs describe), not only in the tier line', async () => {
        const { tools } = await client.listTools();
        const props = tools.find(t => t.name === 'improvisation_manage')!.inputSchema.properties as Record<string, any>;
        const text = JSON.stringify(props.costs);
        for (const key of ['set_part', 'remove_part', 'live token']) expect(text).toContain(key);
    });

    it('a set_part with no state is refused before any row is inserted, with the field named', async () => {
        const res = await raw('character_manage', { action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 12, writes: [{ op: 'set_part', part: 'left arm' }] });
        const body = payload(res);
        expect(body.error).toBe(true);
        expect(body.writes).toBe('none');
        expect(String(body.message)).toMatch(/set_part.*state/);
        expect(scheduledRows()).toBe(0);
        expect(sheetParts()[0].state).toBe('crippled');
    });
});
