import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';
import { schemaShape } from '../../src/server/schema-shape.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { withSession } from '../../src/server/types.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 5, lane B, over the real MCP boundary. The mirror audit checks
 * top-level keys only: a nested object the outer schema does not carry in
 * full (shove's `save`, attack's `requires`) is stripped by the SDK's parse
 * and the handler never sees it. These calls go through an MCP Client and
 * the SDK's input validation, registered exactly as index.ts registers every
 * consolidated tool, so push, prone, save, bonusAction, requires, movedFt
 * and nonlethal must all come out the other side intact.
 */
const embedded = (res: unknown, tag: string) => {
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    const m = text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : { rawText: text };
};
const dice = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

describe('lane B params over the MCP boundary (play report 5)', () => {
    let client: Client;
    let server: McpServer;
    let encounterId: string;

    const call = async (name: string, args: Record<string, unknown>) => embedded(await client.callTool({ name, arguments: args }), name.toUpperCase());
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(encounterId)!.participants.find((t: any) => t.id === id) as any;
    const fight = async (participants: Array<Record<string, unknown>>) => {
        const created = await call('combat_manage', { action: 'create', seed: 'lane-b-mcp', participants });
        encounterId = created.encounterId;
    };
    const varek = { id: 'varek', name: 'Varek', hp: 40, maxHp: 40, initiative: 20, position: { x: 2, y: 2 }, cr: 3, attacks: [
        { name: 'greataxe', attackBonus: 5, damage: '1d12+3', default: true },
        { name: 'Goring Rush', attackBonus: 5, damage: '1d6+3', bonusAction: true, requires: { dashed: true, movedAtLeast: 20 } }
    ] };
    const bandit = { id: 'bandit', name: 'Bandit', hp: 5, maxHp: 5, ac: 10, initiative: 5, isEnemy: true, position: { x: 3, y: 2 } };

    beforeEach(async () => {
        closeDb(); getDb(':memory:'); clearCombatState();
        const envelopeShape = {
            sessionId: z.string().optional(),
            output_mode: z.enum(['json', 'banner', 'summary']).optional(),
            opId: z.string().optional(),
            fields: z.array(z.string()).optional()
        };
        const registry = buildConsolidatedRegistry();
        server = new McpServer({ name: 'rpg-mcp-test', version: '0.0.0' });
        for (const toolName of ['combat_manage', 'combat_action']) {
            const entry = registry[toolName];
            server.tool(
                toolName,
                entry.metadata.description,
                schemaShape((entry.schema as z.ZodObject<z.ZodRawShape>).extend(envelopeShape)),
                withOperation(toolName, withSession(entry.schema, entry.handler as never) as never) as never
            );
        }
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'lane-b-mcp-test', version: '0.0.0' });
        await client.connect(clientTransport);
    });
    afterEach(async () => { vi.restoreAllMocks(); await client.close(); await server.close(); closeDb(); });

    it('tools/list advertises the new keys with their nested shapes on combat_action', async () => {
        const { tools } = await client.listTools();
        const combat = tools.find(t => t.name === 'combat_action')!;
        const props = (combat.inputSchema as { properties: Record<string, any> }).properties;
        expect(props.push?.type).toBe('number');
        expect(props.prone?.type).toBe('boolean');
        expect(props.bonusAction?.type).toBe('boolean');
        expect(props.nonlethal?.type).toBe('boolean');
        expect(props.movedFt?.type).toBe('number');
        expect(props.save?.type).toBe('object');
        expect(Object.keys(props.save.properties).sort()).toEqual(['ability', 'dc']);
        expect(props.requires?.type).toBe('object');
        expect(Object.keys(props.requires.properties).sort()).toEqual(['dashed', 'hitThisTurn', 'movedAtLeast']);
        expect((props.move.enum as string[])).toContain('shove');
    });

    it("grapple shove with a nested save {ability, dc} survives the boundary: the target rolls against the given DC and is pushed", async () => {
        await fight([varek, bandit]);
        dice(2);
        const res = await call('combat_action', { action: 'grapple', move: 'shove', push: 10, save: { ability: 'str', dc: 15 }, bonusAction: true, encounterId, actorId: 'varek', targetId: 'bandit' });
        expect(res.error).toBeFalsy();
        expect(res.save).toMatchObject({ ability: 'strength', dc: 15, dcSource: 'given', saved: false });
        expect(res.pushed).toMatchObject({ feet: 10, to: { x: 5, y: 2 } });
        expect(res.actionSpent).toBe('bonus action');
        expect(res.ignoredParams).toBeUndefined();
        expect(tok('bandit').position).toEqual({ x: 5, y: 2 });
        expect(tok('varek').bonusActionUsed).toBe(true);
    });

    it('attack requires {dashed} survives the boundary: the refusal names the missing Dash and spends nothing', async () => {
        await fight([varek, bandit]);
        const res = await call('combat_action', { action: 'attack', encounterId, actorId: 'varek', targetId: 'bandit', using: 'greataxe', requires: { dashed: true } });
        expect(res.error).toBe(true);
        expect(res.writes).toBe('none');
        expect(String(res.message)).toMatch(/greataxe needs a Dash this turn: dashed no/);
        expect(tok('varek').actionUsed).toBeFalsy();
    });

    it('bonusAction, movedFt and nonlethal survive the boundary on an attack', async () => {
        await fight([{ ...varek, position: undefined }, { ...bandit, position: undefined }]);
        await call('combat_action', { action: 'dash', encounterId, actorId: 'varek' });
        dice(15);
        const rush = await call('combat_action', { action: 'attack', encounterId, actorId: 'varek', targetId: 'bandit', using: 'Goring Rush', movedFt: 25, nonlethal: true });
        expect(rush.error).toBeFalsy();
        expect(rush.actionResult.bonusAction).toMatchObject({ spent: true, trigger: { dashed: true, movedFt: 25, movedSource: 'declared' } });
        expect(rush.actionResult.knockedOut).toMatchObject({ by: 'varek', stable: true });
        expect(tok('bandit').conditions).toEqual([expect.objectContaining({ type: 'unconscious', sourceId: 'nonlethal: varek' })]);
        expect(tok('varek').bonusActionUsed).toBe(true);
    });
});
