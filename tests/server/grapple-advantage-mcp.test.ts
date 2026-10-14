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
import { closeDb, getDb } from '../../src/storage/index.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';

/**
 * Play report 4, item 1, over the real MCP boundary. The GM's words were
 * `grapple {move: 'throw', advantage: true}` rolled one d20 and said nothing.
 * The grapple tests call the handler directly; this one goes through an MCP
 * Client and the SDK's input validation, registered exactly as index.ts
 * registers every consolidated tool (server.tool with the envelope-extended
 * shape, withOperation, withSession), so a key the outer schema does not
 * carry is stripped here as it is in production. advantage, disadvantage,
 * advantageSources and disadvantageSources must survive that boundary.
 */
const embedded = (res: unknown, tag: string) => {
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    const m = text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : { rawText: text };
};

/** Queue the next engine d20s (actor first, then defender). */
const dice = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

describe('grapple advantage over the MCP boundary (play report 4)', () => {
    let client: Client;
    let server: McpServer;
    let encounterId: string;

    const call = async (name: string, args: Record<string, unknown>) => embedded(await client.callTool({ name, arguments: args }), name.toUpperCase());
    const fight = async (participants: Array<Record<string, unknown>>) => {
        const created = await call('combat_manage', { action: 'create', seed: 'grapple-mcp', participants });
        encounterId = created.encounterId;
    };
    const marine = { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, attacksPerAction: 4, conditions: [{ name: 'Bulwark Stance', source: 'ritual' }] };
    const cultist = { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true };

    beforeEach(async () => {
        closeDb(); getDb(':memory:'); clearCombatState();
        // index.ts, buildServer: the same envelope, the same shape, the same wrappers.
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
        client = new Client({ name: 'grapple-mcp-test', version: '0.0.0' });
        await client.connect(clientTransport);
    });
    afterEach(async () => { vi.restoreAllMocks(); await client.close(); await server.close(); closeDb(); });

    it('tools/list advertises advantage, disadvantage and both source lists on combat_action', async () => {
        const { tools } = await client.listTools();
        const combat = tools.find(t => t.name === 'combat_action')!;
        const props = (combat.inputSchema as { properties: Record<string, { type?: string; items?: { type?: string } }> }).properties;
        expect(props.advantage?.type).toBe('boolean');
        expect(props.disadvantage?.type).toBe('boolean');
        expect(props.advantageSources).toEqual(expect.objectContaining({ type: 'array', items: expect.objectContaining({ type: 'string' }) }));
        expect(props.disadvantageSources).toEqual(expect.objectContaining({ type: 'array', items: expect.objectContaining({ type: 'string' }) }));
        // Play report 7 #7: the GM's one-off reasons and the grapple's tags.
        expect(props.situationalAdvantage?.type).toBe('string');
        expect(props.situationalDisadvantage?.type).toBe('string');
        expect(props.context).toEqual(expect.objectContaining({ type: 'array', items: expect.objectContaining({ type: 'string' }) }));
    });

    it("play report 7: situationalAdvantage and context cross the boundary; a declared, tagged effect fires on the tag", async () => {
        new CustomEffectsRepository(getDb()).apply({
            target_id: 'marine', target_type: 'character', name: 'Horn-Lock', description: 'locks horns head-on',
            category: 'neutral', power_level: 1, source: { type: 'unknown' },
            mechanics: [{ type: 'advantage_on', value: 'grapple', condition: 'head-on' }] as never, duration: { type: 'until_removed' as never },
            triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
        } as never);
        await fight([marine, cultist]);
        let spy = dice(5, 18, 9);
        const downhill = await call('combat_action', { action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', situationalAdvantage: 'downhill' });
        expect(downhill.error).toBeFalsy();
        expect(downhill.situational).toEqual(['Marine: advantage (GM: downhill)']);
        expect(spy).toHaveBeenNthCalledWith(1, expect.objectContaining({ purpose: 'grapple (adv: GM: downhill)' }));
        spy = dice(5, 18, 9);
        const headOn = await call('combat_action', { action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', context: ['head-on'] });
        expect(headOn.advantageSources).toEqual(['Horn-Lock (head-on)']);
        expect(headOn.rolls.actor).toEqual([5, 18]);
        // An empty reason is refused by the SDK before the handler.
        const empty = await client.callTool({ name: 'combat_action', arguments: { action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', situationalAdvantage: '' } }) as { isError?: boolean };
        expect(empty.isError).toBe(true);
    });

    it("the GM's call — grapple {move: 'throw', advantage: true} — rolls the actor two d20s, keeps the high one and names the reason", async () => {
        await fight([marine, cultist]);
        const spy = dice(5, 18, 9);
        const res = await call('combat_action', { action: 'grapple', move: 'throw', encounterId, actorId: 'marine', targetId: 'cultist', advantage: true, surface: 'concrete' });
        expect(res.error).toBeFalsy();
        expect(res.move).toBe('throw');
        expect(res.rolls).toEqual({ actor: [5, 18], defender: [9] });
        expect(res.rollMode).toEqual({ actor: 'advantage', defender: 'normal' });
        expect(res.situational).toEqual(['Marine: advantage (GM)']);
        expect(res.breakdown).toMatch(/Marine d20\(5,18 adv → 18\)/);
        // The kept die decides the margin (18 vs 9, equal stats) and the extra surface die.
        expect(res.margin).toBe(9);
        expect(res.hit).toBe(true);
        expect(res.conditionsApplied).toEqual(['Prone']);
        expect(typeof res.surfaceDamage).toBe('number');
        expect(res.damageDetail).toMatch(/^2d6 \[\d+,\d+\] into concrete \(margin ≥5: extra die\)/);
        expect(spy).toHaveBeenNthCalledWith(1, expect.objectContaining({ purpose: 'grapple (adv: GM)', forId: 'marine', targetId: 'cultist' }));
        expect(spy).toHaveBeenNthCalledWith(2, expect.objectContaining({ purpose: 'grapple (adv: GM)', forId: 'marine' }));
        expect(spy).toHaveBeenNthCalledWith(3, expect.objectContaining({ purpose: 'grapple', forId: 'cultist' }));
        expect(res.actionSpent).toBe('attack 1/4');
    });

    it('advantageSources survive the outer schema as an array and as a JSON string; disadvantage: true keeps the low die', async () => {
        // Play report 7 #7: the token's prose condition declares nothing; the feature beside it (same label) does.
        new CustomEffectsRepository(getDb()).apply({
            target_id: 'marine', target_type: 'character', name: 'Bulwark Stance', description: 'braced',
            category: 'neutral', power_level: 1, source: { type: 'unknown' },
            mechanics: [{ type: 'advantage_on', value: 1, skill: 'athletics' }] as never, duration: { type: 'until_removed' as never },
            triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
        } as never);
        await fight([marine, cultist]);
        dice(5, 18, 9);
        const arr = await call('combat_action', { action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantageSources: ['bulwark'] });
        expect(arr.error).toBeFalsy();
        expect(arr.advantageSources).toEqual(['Bulwark Stance']);
        expect(arr.situational).toEqual(['Marine: advantage (Bulwark Stance)']);
        expect(arr.rolls.actor).toEqual([5, 18]);
        dice(5, 18, 9);
        const str = await call('combat_action', { action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantageSources: '["ritual"]' });
        expect(str.error).toBeFalsy();
        expect(str.advantageSources).toEqual(['Bulwark Stance']);
        dice(15, 3, 10);
        const dis = await call('combat_action', { action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', disadvantage: true });
        expect(dis.rolls).toEqual({ actor: [15, 3], defender: [10] });
        expect(dis.rollMode.actor).toBe('disadvantage');
    });

    it('advantage: true with disadvantage: true rolls one die; a named source that matches nothing is refused with nothing rolled or spent', async () => {
        await fight([marine, cultist]);
        dice(11, 4);
        const both = await call('combat_action', { action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantage: true, disadvantage: true });
        expect(both.rolls).toEqual({ actor: [11], defender: [4] });
        expect(both.rollMode.actor).toBe('cancelled');
        expect(both.actionSpent).toBe('attack 1/4');
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const bad = await call('combat_action', { action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist', advantageSources: ['Khorne'] });
        expect(bad.error).toBe(true);
        expect(bad.writes).toBe('none');
        expect(String(bad.message)).toMatch(/advantage source "Khorne" matches nothing in Marine's conditions or active effects/);
        expect(spy).not.toHaveBeenCalled();
        // Nothing was spent: the next clinch is still attack 2/4.
        dice(11, 4);
        const next = await call('combat_action', { action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(next.actionSpent).toBe('attack 2/4');
    });
});
