/**
 * Play report 7 #7, second phase (lane F), over the real MCP boundary.
 *
 * tests/combat/attack-declared-advantage.test.ts and
 * initiative-declared-advantage.test.ts drive the handlers. A client reaches
 * them through the SDK's outer-shape validation (a default-strip z.object: a
 * key the outer schema lacks vanishes, a nested mirror strips keys it does
 * not declare) and withSession's re-parse. This file registers combat_manage
 * and combat_action as buildServer does and proves:
 *  - combat_action attack {context, advantageSources, disadvantageSources,
 *    situationalAdvantage, situationalDisadvantage} cross and act (context
 *    as a bare string too), and a named prose condition is refused with
 *    nothing spent;
 *  - create participants[].context and add_participant {context} cross and
 *    fire a tagged initiative mechanic;
 *  - tools/list advertises the keys with their types.
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
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

process.env.NODE_ENV = 'test';

type ToolResult = { content?: Array<{ type: string; text?: string }> };
function payload(result: unknown): Record<string, any> {
    const text = (result as ToolResult).content?.[0]?.text ?? '';
    const m = text.match(/<!-- ([A-Z_]+_JSON)\n([\s\S]*?)\n\1 -->/);
    if (m) return JSON.parse(m[2]);
    try { return JSON.parse(text); } catch { throw new Error(`no JSON in reply:\n${text}`); }
}
const now = () => new Date().toISOString();
function effect(targetId: string, name: string, mechanics: unknown[]) {
    new CustomEffectsRepository(getDb()).apply({
        target_id: targetId, target_type: 'character', name, description: name,
        category: 'neutral', power_level: 1, source: { type: 'unknown' },
        mechanics: mechanics as never, duration: { type: 'until_removed' as never },
        triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
    } as never);
}

describe('declared advantage on attacks and initiative over the MCP boundary (play report 7, lane F)', () => {
    let client: Client;
    let server: McpServer;
    let enc: string;
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;

    beforeEach(async () => {
        closeDb();
        getDb(':memory:');
        clearCombatState();
        new CharacterRepository(getDb()).create({
            id: 'varek', name: 'Varek', characterType: 'pc', level: 3, hp: 30, maxHp: 30, ac: 13,
            stats: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
            conditions: [{ name: 'Gor Hunter' }], createdAt: now(), updatedAt: now()
        } as any);
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
    });

    afterEach(async () => {
        await client?.close();
        await server?.close();
        closeDb();
    });

    it('tools/list advertises the attack keys and add_participant context', async () => {
        const { tools } = await client.listTools();
        const actionProps = tools.find(t => t.name === 'combat_action')!.inputSchema.properties as Record<string, any>;
        expect(actionProps.situationalAdvantage.type).toBe('string');
        expect(actionProps.situationalDisadvantage.type).toBe('string');
        expect(actionProps.advantageSources.type).toBe('array');
        expect(actionProps.disadvantageSources.type).toBe('array');
        expect(String(actionProps.context.description)).toMatch(/attack/);
        expect(String(actionProps.advantageSources.description)).toMatch(/attack/);
        const manageProps = tools.find(t => t.name === 'combat_manage')!.inputSchema.properties as Record<string, any>;
        expect(manageProps.context).toBeDefined();
        expect(String(manageProps.context.description)).toMatch(/initiative/);
        expect(String(manageProps.participants.description)).toMatch(/context/);
    });

    it('attack: context (array and bare string), advantageSources, the situational reasons cross and act; a prose name is refused', async () => {
        effect('varek', 'Horn Charge', [{ type: 'advantage_on', value: 'attack:melee', condition: 'charging' }]);
        enc = (await call('combat_manage', { action: 'create', seed: 'lane-f-mcp', participants: [
            { id: 'varek', name: 'Varek', hp: 30, maxHp: 30, initiative: 20, attacksPerAction: 8, position: { x: 0, y: 0 } },
            { id: 'rival', name: 'Rival', hp: 300, maxHp: 300, ac: 10, initiative: 5, isEnemy: true, position: { x: 1, y: 0 } }
        ] })).encounterId;
        const swing = async (a: Record<string, unknown>) => {
            const d = await call('combat_action', { action: 'attack', encounterId: enc, actorId: 'varek', targetId: 'rival', attackBonus: 5, damage: 1, ...a });
            return { d, r: d.actionResult ?? d };
        };
        const arr = await swing({ context: ['charging'] });
        expect(arr.r.roll.allRolls).toHaveLength(2);
        expect(arr.r.advantageSources).toEqual(['Horn Charge (charging)']);
        const bare = await swing({ context: 'charging' });
        expect(bare.r.advantageSources).toEqual(['Horn Charge (charging)']);
        const named = await swing({ advantageSources: ['Horn Charge'] });
        expect(named.r.advantageSources).toEqual(['Horn Charge (charging, named)']);
        const gm = await swing({ situationalAdvantage: 'downhill', situationalDisadvantage: 'the fog' });
        expect(gm.r.roll.allRolls).toHaveLength(1);
        expect(gm.r.advantageSources).toEqual(['GM: downhill']);
        expect(gm.r.disadvantageSources).toEqual(['GM: the fog']);
        expect(gm.r.situationalAdvantage).toBe('downhill');
        const dis = await swing({ disadvantageSources: ['Horn Charge'] });
        expect(dis.d.error).toBe(true);
        expect(dis.d.writes).toBe('none');
        const hp = tok('rival').hp;
        const bad = await swing({ advantageSources: ['Gor Hunter'] });
        expect(bad.d.error).toBe(true);
        expect(bad.d.writes).toBe('none');
        expect(bad.d.sourceProblems[0]).toMatch(/^'Gor Hunter' grants no advantage on melee attacks\. To grant one, improvisation_manage feature_from_condition \{characterId: 'varek', match: 'Gor Hunter'/);
        expect(tok('rival').hp).toBe(hp);
    });

    it('create participants[].context and add_participant {context} cross and fire a tagged initiative mechanic', async () => {
        effect('varek', 'Ambusher', [{ type: 'advantage_on', value: 'initiative', condition: 'ambush' }]);
        const created = await call('combat_manage', { action: 'create', seed: 'lane-f-init', participants: [
            { id: 'varek', name: 'Varek', hp: 30, maxHp: 30, context: ['ambush'] },
            { id: 'gob', name: 'Goblin', hp: 7, maxHp: 7, initiative: 10, isEnemy: true }
        ] });
        expect(created.ignoredParams ?? []).not.toContain('participants[0].context');
        const row = created.initiative.find((r: any) => r.id === 'varek');
        expect(row.advantage).toEqual(['Ambusher (ambush)']);
        expect(row.rolls).toHaveLength(2);
        enc = created.encounterId;
        await call('combat_manage', { action: 'remove_participant', encounterId: enc, participantId: 'varek' });
        const joined = await call('combat_manage', { action: 'add_participant', encounterId: enc, characterId: 'varek', context: 'ambush' });
        expect(joined.error).toBeFalsy();
        expect(joined.initiative[0].advantage).toEqual(['Ambusher (ambush)']);
        expect(joined.initiative[0].rolls).toHaveLength(2);
    });
});
