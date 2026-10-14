/**
 * Play report 7 #5 (subdue) and #10 (mounts) over the real MCP boundary.
 *
 * tests/combat/subdue.test.ts and tests/combat/mount.test.ts drive the
 * handlers directly. A client reaches them through the SDK's outer-shape
 * validation (a default-strip z.object: a key the outer schema lacks
 * vanishes, a nested mirror strips keys it does not declare) and
 * withSession's re-parse. This file registers combat_manage and
 * combat_action as buildServer does and proves:
 *  - create participants[].subdue and add_participant {subdue} keep the flag;
 *  - set_subdue {subdue, onSubdue} crosses;
 *  - set_intent {readied: {attack: {using, onSubdue}}}: onSubdue survives the
 *    outer ReadiedSchema mirror, and without it a ranged ready is refused;
 *  - combat_action ready {attack: {using, onSubdue}} crosses;
 *  - mount {riderId, mountId, controlled, free} and dismount {riderId,
 *    position, free} cross and act; move {actorId: rider} moves the mount;
 *  - tools/list advertises the new keys and actions.
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
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { replyJson } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';

type ToolResult = { content?: Array<{ type: string; text?: string }> };
function payload(result: unknown): Record<string, any> {
    const text = (result as ToolResult).content?.[0]?.text ?? '';
    const m = text.match(/<!-- ([A-Z_]+_JSON)\n([\s\S]*?)\n\1 -->/);
    if (!m) throw new Error(`no embedded JSON in reply:\n${text}`);
    return JSON.parse(m[2]);
}

const CROSSBOW = { name: 'crossbow', attackBonus: 40, damage: '1d1+10', damageType: 'piercing', ranged: true };

describe('subdue and mounts over the MCP boundary (play report 7 #5, #10)', () => {
    let client: Client;
    let server: McpServer;
    let enc: string;
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;

    beforeEach(async () => {
        closeDb();
        getDb(':memory:');
        clearCombatState();
        server = new McpServer({ name: 'rpg-mcp-test', version: '0.0.0' });
        const registry = buildConsolidatedRegistry();
        const envelopeShape = {
            sessionId: z.string().optional(),
            output_mode: z.enum(['json', 'banner', 'summary']).optional(),
            opId: z.string().optional(),
            fields: z.array(z.string()).optional(),
        };
        for (const toolName of ['combat_manage', 'combat_action']) {
            const entry = registry[toolName];
            server.tool(toolName, entry.metadata.description, schemaShape(entry.schema.extend(envelopeShape)),
                withOperation(toolName, withSession(entry.schema, entry.handler as any) as any) as any);
        }
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'test-client', version: '0.0.0' });
        await client.connect(clientTransport);
        const created = await call('combat_manage', { action: 'create', seed: 'mcp-subdue', participants: [
            { id: 'kael', name: 'Kael', hp: 30, maxHp: 30, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'horse', name: 'Warhorse', hp: 19, maxHp: 19, initiative: 15, size: 'large', movementSpeed: 60, position: { x: 1, y: 0 } },
            { id: 'grak', name: 'Grak', hp: 20, maxHp: 20, initiative: 12, position: { x: 0, y: 4 }, subdue: true, attacks: [CROSSBOW] },
            { id: 'bandit', name: 'Bandit', hp: 5, maxHp: 5, initiative: 10, isEnemy: true, position: { x: 6, y: 6 } }
        ] });
        enc = created.encounterId;
    });

    afterEach(async () => {
        await client?.close();
        await server?.close();
        closeDb();
    });

    it('tools/list advertises the new keys and actions', async () => {
        const { tools } = await client.listTools();
        const props = (name: string) => tools.find(t => t.name === name)!.inputSchema.properties as Record<string, any>;
        for (const key of ['subdue', 'onSubdue', 'riderId', 'mountId', 'controlled', 'free']) expect(props('combat_manage')[key], key).toBeDefined();
        const manage = tools.find(t => t.name === 'combat_manage')!.description ?? '';
        expect(manage).toMatch(/set_subdue/);
        expect(manage).toMatch(/mount/);
        expect(manage).toMatch(/dismount/);
    });

    it('create participants[].subdue and add_participant {subdue} keep the flag; set_subdue {subdue, onSubdue} crosses', async () => {
        expect(tok('grak').subdue).toBe(true);
        const added = await call('combat_manage', { action: 'add_participant', encounterId: enc, name: 'Gor', hp: 30, maxHp: 30, subdue: true, position: { x: 9, y: 9 } });
        expect(added.success).toBe(true);
        expect(tok(added.participant.id).subdue).toBe(true);
        const set = await call('combat_manage', { action: 'set_subdue', encounterId: enc, participantId: 'kael', subdue: true, reason: 'alive' });
        expect(set).toMatchObject({ success: true, subdue: true });
        expect(tok('kael').subdue).toBe(true);
    });

    it('set_intent readied {attack: {using, onSubdue}}: onSubdue survives the nested mirror; without it the ranged ready is refused', async () => {
        const refused = await call('combat_manage', { action: 'set_intent', encounterId: enc, participantId: 'grak', readied: { action: 'shoot', trigger: 'he runs', on: 'enters_reach', attack: { using: 'crossbow' } } });
        expect(refused).toMatchObject({ error: true, writes: 'none' });
        expect(tok('grak').readied).toBeUndefined();
        const held = await call('combat_manage', { action: 'set_intent', encounterId: enc, participantId: 'grak', readied: { action: 'shoot', trigger: 'he runs', on: 'enters_reach', attack: { using: 'crossbow', onSubdue: 'hold' } } });
        expect(held.success).toBe(true);
        expect(tok('grak').readied.attack).toEqual({ using: 'crossbow', onSubdue: 'hold' });
    });

    it("combat_action ready {attack: {using, onSubdue: 'fire'}} crosses; set_subdue {onSubdue} rewrites it", async () => {
        const refused = await call('combat_action', { action: 'ready', encounterId: enc, actorId: 'grak', readiedAction: 'shoot', trigger: 'he runs', attack: { using: 'crossbow' } });
        expect(refused).toMatchObject({ error: true, writes: 'none' });
        const ready = await call('combat_action', { action: 'ready', encounterId: enc, actorId: 'grak', readiedAction: 'shoot', trigger: 'he runs', attack: { using: 'crossbow', onSubdue: 'fire' } });
        expect(ready.success).toBe(true);
        expect(tok('grak').readied.attack.onSubdue).toBe('fire');
        const answer = await call('combat_manage', { action: 'set_subdue', encounterId: enc, participantId: 'grak', onSubdue: 'hold' });
        expect(answer.success).toBe(true);
        expect(tok('grak').readied.attack.onSubdue).toBe('hold');
    });

    it('mount {riderId, mountId, controlled, free} and dismount {riderId, position, free} cross and act; the rider moves the mount', async () => {
        const mounted = await call('combat_manage', { action: 'mount', encounterId: enc, riderId: 'kael', mountId: 'horse', controlled: true, free: true });
        expect(mounted).toMatchObject({ success: true, mounted: { riderId: 'kael', mountId: 'horse', controlled: true } });
        const moved = await call('combat_action', { action: 'move', encounterId: enc, actorId: 'kael', targetPosition: { x: 5, y: 0 } });
        expect(moved.actionResult.mounted).toMatchObject({ riderId: 'kael', mountId: 'horse' });
        expect(tok('horse').position).toEqual({ x: 5, y: 0 });
        expect(tok('kael').position).toEqual({ x: 5, y: 0 });
        const off = await call('combat_manage', { action: 'dismount', encounterId: enc, riderId: 'kael', position: { x: 7, y: 0 }, free: true });
        expect(off).toMatchObject({ success: true, dismounted: { riderId: 'kael', mountId: 'horse' } });
        expect(tok('kael').position).toEqual({ x: 7, y: 0 });
        expect(tok('kael').mountedOn).toBeUndefined();
    });
});

/**
 * Review: the same through buildServer itself (the operation guard and
 * output_mode included): trigger_readied's nested attack.onSubdue crosses the
 * outer `attack` mirror and answers for the stored shot, and output_mode
 * 'summary' keeps a thrown rider's mounts[] rows with their lines.
 */
describe('subdue and mounts through buildServer (review)', () => {
    let client: Client;
    let enc: string;
    const call = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>)[0].text;
        const data = replyJson(text);
        expect(data, `no JSON in reply: ${text.slice(0, 300)}`).not.toBeNull();
        return data as Record<string, any>;
    };
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;

    beforeEach(async () => {
        closeDb();
        getDb(':memory:');
        clearCombatState();
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'subdue-mounts-build-server', version: '0.0.0' });
        await client.connect(clientTransport);
        enc = (await call('combat_manage', { action: 'create', seed: 'mcp-subdue-review', participants: [
            { id: 'kael', name: 'Kael', hp: 30, maxHp: 30, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'horse', name: 'Warhorse', hp: 19, maxHp: 19, initiative: 15, size: 'large', movementSpeed: 60, position: { x: 1, y: 0 } },
            { id: 'grak', name: 'Grak', hp: 20, maxHp: 20, initiative: 12, position: { x: 0, y: 6 }, attacks: [{ name: 'knife', attackBonus: 1, damage: '1d1', default: true }, CROSSBOW] },
            { id: 'bandit', name: 'Bandit', hp: 50, maxHp: 50, ac: 10, initiative: 10, isEnemy: true, position: { x: 6, y: 6 } }
        ] })).encounterId;
    });
    afterEach(async () => { await client?.close(); closeDb(); });

    it("trigger_readied {attack: {onSubdue: 'fire'}} crosses and fires the stored crossbow", async () => {
        expect((await call('combat_action', { action: 'ready', encounterId: enc, actorId: 'grak', readiedAction: 'shoot', trigger: 'he runs', attack: { using: 'crossbow' } })).success).toBe(true);
        expect((await call('combat_manage', { action: 'set_subdue', encounterId: enc, participantId: 'grak', subdue: true })).readiedNeedsOnSubdue).toBeDefined();
        const fired = await call('combat_manage', { action: 'trigger_readied', encounterId: enc, participantId: 'grak', targetId: 'bandit', attack: { onSubdue: 'fire' } });
        expect(fired.success).toBe(true);
        expect(fired.ignoredParams).toBeUndefined();
        expect(fired.attack.subdue).toMatchObject({ mode: 'overridden' });
        expect(fired.attack.total - fired.attack.roll).toBe(40);
        expect(tok('grak').reactionUsed).toBe(true);
    });

    it("output_mode 'summary' keeps a thrown rider's mounts[] rows and their lines", async () => {
        await call('combat_manage', { action: 'mount', encounterId: enc, riderId: 'kael', mountId: 'horse', free: true });
        const res = await client.callTool({ name: 'combat_manage', arguments: { action: 'adjust_hp', encounterId: enc, participantId: 'horse', value: 0, reason: 'spear', output_mode: 'summary' } });
        const summary = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
        expect(summary.mounts).toEqual([expect.objectContaining({ riderId: 'kael', mountId: 'horse', fell: true, prone: true, line: expect.stringMatching(/🐎 Kael is thrown as Warhorse drops/) })]);
        expect(tok('kael').mountedOn).toBeUndefined();
    });
});
