/**
 * Play report 7 #2, #3, #4 and #9 over the real MCP boundary (buildServer:
 * the SDK's outer-shape validation, withSession's re-parse, output_mode).
 *
 * - create participants[].stats with short keys and abilityScores with a
 *   capital key cross the outer schema (participants is z.array(z.any())) and
 *   land on the token; a participant key create does not take comes back as
 *   a dotted path in ignoredParams, named once in the banner.
 * - add_participant top-level stats, abilityScores and id cross the outer
 *   mirror (z.record for the scores) and are not reported as ignored.
 * - output_mode 'summary' keeps initiative, firstUp and the assumed-band
 *   warning whole.
 * - set_band crosses; tools/list advertises the new keys.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { replyJson, splitEmbed } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';

const W = 'kennels';
const TEN = { strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 };

describe('ad-hoc tokens over the MCP boundary (play report 7)', () => {
    let client: Client;
    const call = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>)[0].text;
        const data = replyJson(text);
        expect(data, `no JSON in reply: ${text.slice(0, 300)}`).not.toBeNull();
        return { text, data: data! as Record<string, any>, banner: splitEmbed(text)?.before ?? text };
    };
    const tok = (encounterId: string, id: string) => (new EncounterRepository(getDb()).loadState(encounterId)!.participants as any[]).find(t => t.id === id);

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Kennels', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'ad-hoc-tokens-mcp', version: '0.0.0' });
        await client.connect(clientTransport);
    });
    afterEach(async () => { await client.close(); closeDb(); });

    it('create: nested stats / abilityScores land; a nested unknown key is a dotted path in ignoredParams, named once in the banner', async () => {
        const { data, banner } = await call('combat_manage', { action: 'create', seed: 'mcp', participants: [
            { id: 'gor', name: 'Gor', hp: 40, maxHp: 40, initiative: 20 },
            { id: 'hound-1', name: 'Hound 1', hp: 11, maxHp: 11, initiative: 5, isEnemy: true, stats: { str: 15 }, abilityScores: { DEX: 14 }, wis: 12 }
        ] });
        expect(data.error).toBeFalsy();
        expect(tok(data.encounterId, 'hound-1').abilityScores).toEqual({ ...TEN, strength: 15, dexterity: 14 });
        expect(data.ignoredParams).toEqual(['participants[1].wis']);
        expect(banner.split('Ignored params').length - 1).toBe(1);
        expect(banner).toMatch(/participants\[1\]\.wis — an ability score: pass stats: \{wis: …\}/);
    });

    it('add_participant: top-level stats, abilityScores and id cross the outer mirror and are not ignored', async () => {
        const { data: created } = await call('combat_manage', { action: 'create', seed: 'mcp', participants: [{ id: 'gor', name: 'Gor', hp: 40, maxHp: 40, initiative: 20 }] });
        const { data } = await call('combat_manage', { action: 'add_participant', encounterId: created.encounterId, id: 'hound-2', name: 'Hound 2', hp: 11, maxHp: 11, stats: { str: 15 }, abilityScores: { dexterity: 12 } });
        expect(data.error).toBeFalsy();
        expect(data.ignoredParams).toBeUndefined();
        expect(data.participant.id).toBe('hound-2');
        expect(tok(created.encounterId, 'hound-2').abilityScores).toEqual({ ...TEN, strength: 15, dexterity: 12 });
        expect(data.initiative[0]).toMatchObject({ id: 'hound-2', modifier: 1, of: 2 });
        const dup = await call('combat_manage', { action: 'add_participant', encounterId: created.encounterId, id: 'hound-2', name: 'Hound 3', hp: 11, maxHp: 11 });
        expect(dup.data).toMatchObject({ error: true, writes: 'none' });
    });

    it("output_mode 'summary' keeps initiative, firstUp and the assumed-band warning whole; set_band crosses", async () => {
        await call('table_rules', { action: 'import', worldId: W, preset: 'day-366' });
        const { data } = await call('combat_manage', { action: 'create', worldId: W, seed: 'summary', output_mode: 'summary', participants: [
            { id: 'gor', name: 'Gor', hp: 40, maxHp: 40, initiative: 20, band: 'Astartes' },
            { id: 'hound-1', name: 'Hound 1', hp: 11, maxHp: 11, initiative: 5, isEnemy: true }
        ] });
        expect(data.initiative).toEqual([
            { id: 'gor', name: 'Gor', roll: 20, modifier: 0, given: true },
            { id: 'hound-1', name: 'Hound 1', roll: 5, modifier: 0, given: true }
        ]);
        expect(data.firstUp).toEqual({ id: 'gor', name: 'Gor', roll: 20 });
        expect(data.warnings[0]).toMatch(/^1 token has no band; assumed Mortal: Hound 1\./);
        expect(data.bandAssumed).toEqual([{ id: 'hound-1', name: 'Hound 1', band: 'Mortal' }]);
        const set = await call('combat_manage', { action: 'set_band', encounterId: data.encounterId, participantId: 'hound-1', band: 'Elite Mortal' });
        expect(set.data).toMatchObject({ success: true, band: 'Elite Mortal' });
        expect(tok(data.encounterId, 'hound-1').bandAssumed).toBeUndefined();
    });

    // Review: requireBand rides inside table_rules spec (a nested key); it
    // must cross the outer schema and make create refuse.
    it('table_rules spec.requireBand crosses the boundary and create refuses an unbanded token, writing nothing', async () => {
        const defined = await call('table_rules', { action: 'define', worldId: W, kind: 'band', name: 'bands', spec: { order: ['Mortal', 'Elite Mortal', 'Astartes'], requireBand: true } });
        expect(defined.data.error).toBeFalsy();
        const before = (getDb().prepare('SELECT COUNT(*) AS n FROM encounters').get() as { n: number }).n;
        const { data } = await call('combat_manage', { action: 'create', worldId: W, participants: [
            { id: 'gor', name: 'Gor', hp: 40, maxHp: 40, initiative: 20, band: 'Astartes' },
            { id: 'hound-1', name: 'Hound 1', hp: 11, maxHp: 11, initiative: 5, isEnemy: true }
        ] });
        expect(data).toMatchObject({ error: true, writes: 'none' });
        expect(data.message).toMatch(/requireBand: true/);
        expect((getDb().prepare('SELECT COUNT(*) AS n FROM encounters').get() as { n: number }).n).toBe(before);
    });

    it('tools/list advertises stats, abilityScores and id on combat_manage', async () => {
        const { tools } = await client.listTools();
        const props = (tools.find(t => t.name === 'combat_manage')!.inputSchema as { properties: Record<string, unknown> }).properties;
        for (const key of ['stats', 'abilityScores', 'id', 'band']) expect(Object.keys(props)).toContain(key);
    });
});
