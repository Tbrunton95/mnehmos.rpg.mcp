/**
 * Play report 7 follow-up (lane L) over the real MCP boundary.
 *
 * combat_manage legendary_resistance takes a new saveRef, the ref an offered
 * end-of-turn save printed. A client reaches the handler through the SDK's
 * outer-shape validation (a default-strip z.object: a key the outer mirror
 * lacks vanishes, so the spend would answer no offer and the condition would
 * stay) and withSession's re-parse. This file proves:
 *  - tools/list advertises saveRef on combat_manage
 *  - an advance with output_mode 'summary' keeps legendaryOffers whole, the
 *    call to paste included
 *  - legendary_resistance {saveRef} crosses and ends the condition
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { replyJson } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';

const WEBBED = { name: 'webbed', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' };

describe('legendary resistance with saveRef over the MCP boundary (lane L)', () => {
    let client: Client;
    const call = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>)[0].text;
        const data = replyJson(text);
        expect(data, `no JSON in reply: ${text.slice(0, 300)}`).not.toBeNull();
        return data as Record<string, any>;
    };

    beforeEach(async () => {
        closeDb(); getDb(':memory:'); clearCombatState();
        const server = buildServer(new PubSub(), new AuditLogger());
        const [c, s] = InMemoryTransport.createLinkedPair();
        await server.connect(s);
        client = new Client({ name: 'lane-l-boundary', version: '0.0.0' });
        await client.connect(c);
    });
    afterEach(async () => { await client.close(); vi.restoreAllMocks(); closeDb(); });

    it('tools/list advertises saveRef on combat_manage', async () => {
        const tools = (await client.listTools()).tools;
        const manage = tools.find(t => t.name === 'combat_manage')!;
        expect(Object.keys((manage.inputSchema as { properties: Record<string, unknown> }).properties)).toContain('saveRef');
    });

    it('the offer survives a summary advance, and the spend with saveRef ends the condition', async () => {
        const created = await call('combat_manage', { action: 'create', seed: 'l-boundary', participants: [
            { id: 'grimgor', name: 'Grimgor', hp: 120, maxHp: 120, initiative: 20, isEnemy: true, legendaryResistances: 3, position: { x: 0, y: 0 }, conditions: [WEBBED] },
            { id: 'orc', name: 'Orc', hp: 15, maxHp: 15, initiative: 5, isEnemy: true, position: { x: 4, y: 4 } }
        ] });
        const enc = created.encounterId as string;
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValueOnce(2);
        const adv = await call('combat_manage', { action: 'advance', encounterId: enc, confirm: true, output_mode: 'summary' });
        const paste = `combat_manage legendary_resistance {encounterId: '${enc}', participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', reason: 'save vs webbed'}`;
        expect(adv.legendaryOffers).toEqual([expect.objectContaining({ participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', kind: 'save_ends', remaining: 3, call: paste })]);

        const spent = await call('combat_manage', { action: 'legendary_resistance', encounterId: enc, participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', reason: 'save vs webbed' });
        expect(spent).toMatchObject({ success: true, saveRef: 'eot-1-grimgor-1', remaining: 2, conditionEnded: { name: 'webbed' } });
        const token = new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: { id: string }) => p.id === 'grimgor');
        expect(token.conditions).toEqual([]);
        expect(token.legendaryResistancesRemaining).toBe(2);
    });
});
