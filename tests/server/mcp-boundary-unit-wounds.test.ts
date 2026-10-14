/**
 * Play report 7 follow-up, lane W: a unit's wound list over the real MCP
 * boundary, through buildServer (the passthrough outer schema,
 * withOutputMode). tests/combat/unit-wounds.test.ts drives the handlers; a
 * client reaches them through the SDK's outer-shape validation, where a key
 * the outer mirror lacks vanishes. This file proves:
 *  - tools/list advertises set_unit's wounded on combat_manage, and unit.wounded
 *    nested in add_participant's unit;
 *  - set_unit {wounded: [5, 2]} crosses, lands sorted most wounded first and
 *    moves HP; {wounded: null} crosses and clears it;
 *  - a value at hpPerModel is refused with writes 'none' and nothing written;
 *  - the wound line survives output_mode 'summary' on set_unit and on an area.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';

process.env.NODE_ENV = 'test';

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
const now = () => new Date().toISOString();
const W = 'blackcrown';

function payload(result: unknown): Record<string, any> {
    const text = (result as ToolResult).content?.[0]?.text ?? '';
    const m = text.match(/<!-- ([A-Z_]+_JSON)\n([\s\S]*?)\n\1 -->/);
    if (m) return JSON.parse(m[2]);
    try { return JSON.parse(text); } catch { return { rawText: text, isError: (result as ToolResult).isError }; }
}

describe('unit wounds over the MCP boundary (play report 7 follow-up, lane W)', () => {
    let client: Client;
    let enc: string;
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now(), updatedAt: now() } as any);
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'unit-wounds-build-server', version: '0.0.0' });
        await client.connect(clientTransport);
        const created = await call('combat_manage', { action: 'create', worldId: W, seed: 'mcp-unit-wounds', participants: [
            { id: 'drake', name: 'Drake', hp: 120, maxHp: 120, initiative: 40 },
            { id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, unit: { models: 6, hpPerModel: 9, packed: true } }
        ] });
        enc = created.encounterId as string;
        expect(enc).toBeTruthy();
    });
    afterEach(async () => { await client?.close(); closeDb(); });

    it('tools/list advertises wounded on set_unit and in the nested unit', async () => {
        const { tools } = await client.listTools();
        const props = tools.find(t => t.name === 'combat_manage')!.inputSchema.properties as Record<string, any>;
        expect(props.wounded).toBeDefined();
        expect(JSON.stringify(props.unit)).toContain('wounded');
    });

    it('set_unit {wounded} crosses, sorts, moves HP; null clears it', async () => {
        const set = await call('combat_manage', { action: 'set_unit', encounterId: enc, participantId: 'militia', wounded: [5, 2] });
        expect(set.error).toBeUndefined();
        // Lane W review: the reply shows the wound line, not the raw list; the row holds it sorted.
        expect(set.unit).not.toHaveProperty('wounded');
        expect(set.wounds).toBe('6 alive: 4 unhurt, 1 at 5/9, 1 at 2/9');
        expect(tok('militia').unit.wounded).toEqual([2, 5]);
        expect(tok('militia').hp).toBe(43);
        const cleared = await call('combat_manage', { action: 'set_unit', encounterId: enc, participantId: 'militia', wounded: null });
        expect(cleared.error).toBeUndefined();
        expect(tok('militia').unit.wounded).toBeUndefined();
        expect(tok('militia').hp).toBe(43);
    });

    it('a wound at hpPerModel is refused with writes none and nothing written', async () => {
        const refused = await call('combat_manage', { action: 'set_unit', encounterId: enc, participantId: 'militia', wounded: [9] });
        expect(refused).toMatchObject({ error: true, writes: 'none' });
        expect(tok('militia').unit.wounded).toBeUndefined();
        expect(tok('militia').hp).toBe(54);
    });

    it("lane W review: create's nested participants[].unit.wounded crosses; a list that does not fit the hp is refused with nothing written", async () => {
        const refused = await call('combat_manage', { action: 'create', worldId: W, participants: [
            { id: 'hero', name: 'Hero', hp: 40, maxHp: 40, initiative: 30 },
            { id: 'pikes', name: 'Pikes', hp: 40, maxHp: 40, initiative: 5, isEnemy: true, unit: { models: 4, hpPerModel: 10, packed: true, wounded: [3] } }
        ] });
        expect(refused).toMatchObject({ error: true, writes: 'none' });
        expect(refused.message).toMatch(/unit\.wounded \[3\] does not fit hp 40.*hp: 33/);
        expect((getDb().prepare('SELECT COUNT(*) AS n FROM encounters').get() as { n: number }).n).toBe(1);
        const made = await call('combat_manage', { action: 'create', worldId: W, participants: [
            { id: 'hero', name: 'Hero', hp: 40, maxHp: 40, initiative: 30 },
            { id: 'pikes', name: 'Pikes', hp: 33, maxHp: 40, initiative: 5, isEnemy: true, unit: { models: 4, hpPerModel: 10, packed: true, wounded: [3] } }
        ] });
        expect(made.error).toBeUndefined();
        const pikes = new EncounterRepository(getDb()).loadState(made.encounterId)!.participants.find(p => p.id === 'pikes') as any;
        expect(pikes.unit.wounded).toEqual([3]);
        expect(made.participants.find((p: any) => p.id === 'pikes').unit.wounds).toBe('4 alive: 3 unhurt, 1 at 3/10');
    });

    it("add_participant's nested unit carries wounded; summary keeps the wound line", async () => {
        const added = await call('combat_manage', { action: 'add_participant', encounterId: enc, name: 'Pikes', hp: 33, maxHp: 40, isEnemy: true, unit: { models: 4, hpPerModel: 10, packed: true, wounded: [3] } });
        expect(added.error).toBeUndefined();
        const pikes = new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.name === 'Pikes') as any;
        expect(pikes.unit.wounded).toEqual([3]);
        const s = await call('combat_manage', { action: 'set_unit', encounterId: enc, participantId: 'militia', wounded: [4, 4], output_mode: 'summary' });
        expect(s.wounds).toBe('6 alive: 4 unhurt, 2 at 4/9');
        const area = await call('combat_manage', { action: 'apply_damage', encounterId: enc, targetIds: ['militia'], dice: 4, source: 'embers', area: true, output_mode: 'summary' });
        expect(area.unitLines).toEqual(['Militia — 6 in the area, no save: 4 vs 9 HP each (wounded first: 2 at 4/9): 2 dead, 4/6 left (4 at 5/9)']);
    });
});
