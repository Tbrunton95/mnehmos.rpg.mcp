/**
 * Play report 7 follow-up, lane O: ongoing damage and water pressure over the
 * real MCP boundary, through buildServer (the passthrough outer schema,
 * withOutputMode). tests/combat/ongoing-damage.test.ts and
 * pressure-by-shape.test.ts drive the handlers; a client reaches them through
 * the SDK's outer-shape validation, where a key a nested mirror does not
 * declare vanishes. This file proves:
 *  - add_condition's `ongoing` (inside the condition) crosses, and area /
 *    modelsInArea cross on add_condition;
 *  - `ongoing` nested in a save rider (apply_damage save.onFail.conditions[])
 *    crosses and tools/list advertises it there;
 *  - pressure.save and pressure.damageType cross on create's environment and
 *    tick on advance; output_mode summary keeps turnDamage and unitLines.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';

process.env.NODE_ENV = 'test';

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

function payload(result: unknown): Record<string, any> {
    const text = (result as ToolResult).content?.[0]?.text ?? '';
    const m = text.match(/<!-- ([A-Z_]+_JSON)\n([\s\S]*?)\n\1 -->/);
    if (m) return JSON.parse(m[2]);
    try { return JSON.parse(text); } catch { return { rawText: text, isError: (result as ToolResult).isError }; }
}

describe('ongoing damage and pressure over the MCP boundary (play report 7 follow-up, lane O)', () => {
    let client: Client;
    let enc: string;
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;

    beforeEach(async () => {
        closeDb();
        getDb(':memory:');
        clearCombatState();
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'ongoing-damage-build-server', version: '0.0.0' });
        await client.connect(clientTransport);
    });
    afterEach(async () => { await client?.close(); closeDb(); });

    const fight = async (environment?: Record<string, unknown>) => {
        const created = await call('combat_manage', { action: 'create', seed: 'mcp-ongoing', ...(environment ? { environment } : {}), participants: [
            { id: 'drake', name: 'Drake', hp: 120, maxHp: 120, initiative: 40, tags: ['aquatic'] },
            { id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, unit: { models: 6, hpPerModel: 9, packed: true, morale: 6 } },
            { id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 4, isEnemy: true }
        ] });
        enc = created.encounterId as string;
        expect(enc).toBeTruthy();
    };

    it('tools/list advertises ongoing in the save rider and area / modelsInArea for add_condition', async () => {
        const { tools } = await client.listTools();
        const props = tools.find(t => t.name === 'combat_manage')!.inputSchema.properties as Record<string, any>;
        expect(JSON.stringify(props.save)).toContain('ongoing');
        expect(props.area.description).toMatch(/add_condition/);
        expect(props.modelsInArea.description).toMatch(/add_condition/);
        expect(props.condition.description).toMatch(/ongoing/);
    });

    it('add_condition: ongoing inside the condition crosses, with area and modelsInArea', async () => {
        await fight();
        const single = await call('combat_manage', { action: 'add_condition', encounterId: enc, participantId: 'orc', condition: { name: 'burning', ongoing: { damage: '1d6', damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 12, onSuccess: 'end' } } } });
        expect(single.error).toBeUndefined();
        expect(tok('orc').conditions[0].ongoingEffects).toEqual([{ type: 'damage', dice: '1d6', trigger: 'start_of_turn', damageType: 'fire', save: { ability: 'dexterity', dc: 12, onSuccess: 'end' }, shape: { kind: 'single' } }]);
        const area = await call('combat_manage', { action: 'add_condition', encounterId: enc, participantId: 'militia', modelsInArea: 4, condition: { name: 'choking', ongoing: { damage: 2, damageType: 'poison', when: 'start' } } });
        expect(area.error).toBeUndefined();
        expect(tok('militia').conditions[0].ongoingEffects[0].shape).toEqual({ kind: 'area', models: 4 });
        const all = await call('combat_manage', { action: 'add_condition', encounterId: enc, participantId: 'militia', area: true, replace: true, condition: { name: 'choking', ongoing: { damage: 2, when: 'end' } } });
        expect(all.error).toBeUndefined();
        expect(tok('militia').conditions[0].ongoingEffects[0].shape).toEqual({ kind: 'area', models: 6 });
    });

    it('ongoing nested in a save rider crosses and records the area on the unit', async () => {
        await fight();
        const hit = await call('combat_manage', { action: 'apply_damage', encounterId: enc, targetIds: ['militia'], dice: 2, damageType: 'poison', source: 'Plague cloud', area: true,
            save: { ability: 'con', dc: 30, onFail: { conditions: [{ name: 'plagued', ongoing: { damage: 3, damageType: 'poison', when: 'start', save: { ability: 'con', dc: 12, onSuccess: 'half' } } }] } } });
        expect(hit.error).toBeUndefined();
        expect(hit.targets[0].conditionsApplied).toEqual(['plagued']);
        expect(tok('militia').conditions[0].ongoingEffects[0]).toMatchObject({ amount: 3, damageType: 'poison', save: { ability: 'constitution', dc: 12, onSuccess: 'half' }, shape: { kind: 'area', models: 6 } });
    });

    it('pressure.save and damageType cross on create and tick per model on advance; summary keeps turnDamage and unitLines', async () => {
        await fight({ medium: 'water', depthFt: 300, pressure: { startsAtFt: 100, damagePerRound: 4, damageType: 'bludgeoning', save: { ability: 'con', dc: 30, half: true } } });
        expect(tok('militia').hp).toBe(54);
        const adv = await call('combat_manage', { action: 'advance', encounterId: enc, output_mode: 'summary' });
        expect(adv.error).toBeUndefined();
        expect(adv.turnDamage).toEqual([expect.objectContaining({ participantId: 'militia', source: 'pressure', damage: 24, hpAfter: 30, damageType: 'bludgeoning' })]);
        expect(adv.turnDamage[0].line).toMatch(/^🌊 Militia — pressure at 300 ft: 6 in the deep water: 6 failed, 0 saved; 4 \/ 2 vs 9 HP each: 0 dead, 6\/6 left \(6 at 5\/9\)/);
        expect(adv.unitLines).toEqual(['Militia — pressure at 300 ft: 6 in the deep water: 6 failed, 0 saved; 4 / 2 vs 9 HP each: 0 dead, 6/6 left (6 at 5/9)']);
        expect(tok('militia').unit.wounded).toEqual([5, 5, 5, 5, 5, 5]);
    });
});
