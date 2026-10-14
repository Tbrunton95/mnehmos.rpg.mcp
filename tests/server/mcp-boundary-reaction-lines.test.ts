/**
 * Play report 7, lane G2, over the real MCP boundary (buildServer: the
 * passthrough outer schema, withSession's re-parse, the operation guard and
 * output_mode).
 *
 * (b) attack.ranged is nested: inside combat_action ready's `attack` and
 *     inside combat_manage set_intent's `readied.attack`, whose outer mirror
 *     is ReadiedSchema (a default-strip z.object). The SDK would drop a key
 *     the nested mirror does not declare before any handler saw it.
 * (a) output_mode 'summary' keeps reactionLines whole on combat_action move,
 *     dash {targetPosition} and combat_manage trigger_readied, while the
 *     opportunityAttacks / readiedTriggered rows collapse to handles.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { replyJson } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';

const BOLT = { attackBonus: 40, damage: '1d1+10', damageType: 'piercing', ranged: true };

describe('lane G2 through buildServer: attack.ranged crosses, summary keeps reactionLines', () => {
    let client: Client;
    let enc: string;
    const raw = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        return (res.content as Array<{ type: string; text: string }>)[0].text;
    };
    const call = async (name: string, args: Record<string, unknown>) => {
        const text = await raw(name, args);
        const data = replyJson(text);
        expect(data, `no JSON in reply: ${text.slice(0, 300)}`).not.toBeNull();
        return data as Record<string, any>;
    };
    const summary = async (name: string, args: Record<string, unknown>) => JSON.parse(await raw(name, { ...args, output_mode: 'summary' })) as Record<string, any>;
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;

    beforeEach(async () => {
        closeDb();
        getDb(':memory:');
        clearCombatState();
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'reaction-lines-build-server', version: '0.0.0' });
        await client.connect(clientTransport);
        enc = (await call('combat_manage', { action: 'create', seed: 'mcp-reaction-lines', participants: [
            { id: 'grak', name: 'Grak', hp: 20, maxHp: 20, ac: 12, initiative: 20, position: { x: 0, y: 0 }, subdue: true, attackBonus: 40, attackDamage: '1d1+10', attackDamageType: 'bludgeoning' },
            { id: 'runner', name: 'Runner', hp: 5, maxHp: 5, ac: 10, initiative: 10, isEnemy: true, position: { x: 1, y: 0 } },
            { id: 'scout', name: 'Scout', hp: 5, maxHp: 5, ac: 10, initiative: 5, isEnemy: true, position: { x: 9, y: 9 } }
        ] })).encounterId;
    });
    afterEach(async () => { await client?.close(); closeDb(); });

    it('tools/list advertises attack.ranged inside set_intent readied', async () => {
        const { tools } = await client.listTools();
        const readied = (tools.find(t => t.name === 'combat_manage')!.inputSchema.properties as Record<string, any>).readied;
        const attack = (readied.anyOf ?? [readied]).map((s: any) => s.properties?.attack).find(Boolean);
        expect(attack?.properties?.ranged).toMatchObject({ type: 'boolean' });
    });

    it('combat_action ready {attack: {…, ranged: true}} crosses: refused under the order without onSubdue (writes none), stored with it', async () => {
        const refused = await call('combat_action', { action: 'ready', encounterId: enc, actorId: 'grak', readiedAction: 'shoot', trigger: 'he runs', on: 'enters_reach', watch: 'scout', attack: BOLT });
        expect(refused).toMatchObject({ error: true, writes: 'none' });
        expect(tok('grak').readied).toBeUndefined();
        const ready = await call('combat_action', { action: 'ready', encounterId: enc, actorId: 'grak', readiedAction: 'shoot', trigger: 'he runs', on: 'enters_reach', watch: 'scout', attack: { ...BOLT, onSubdue: 'hold' } });
        expect(ready.success).toBe(true);
        expect(ready.ignoredParams).toBeUndefined();
        expect(tok('grak').readied.attack).toEqual({ ...BOLT, onSubdue: 'hold' });
    });

    it('set_intent readied {attack: {…, ranged: true}} survives the nested ReadiedSchema mirror', async () => {
        const refused = await call('combat_manage', { action: 'set_intent', encounterId: enc, participantId: 'grak', readied: { action: 'shoot', trigger: 'he runs', on: 'enters_reach', attack: BOLT } });
        expect(refused).toMatchObject({ error: true, writes: 'none' });
        const held = await call('combat_manage', { action: 'set_intent', encounterId: enc, participantId: 'grak', readied: { action: 'shoot', trigger: 'he runs', on: 'enters_reach', attack: { ...BOLT, onSubdue: 'hold' } } });
        expect(held.success).toBe(true);
        expect(tok('grak').readied.attack).toEqual({ ...BOLT, onSubdue: 'hold' });
    });

    it("summary on move keeps the knockout line whole; the opportunityAttacks rows are handles", async () => {
        await call('combat_manage', { action: 'advance', encounterId: enc });
        const s = await summary('combat_action', { action: 'move', encounterId: enc, actorId: 'runner', targetPosition: { x: 5, y: 0 } });
        expect(s.reactionLines).toEqual([expect.stringMatching(/^⚡ Grak → Runner: OA hit \d+ vs AC 10, 11 bludgeoning, knocked out \(subdue\)$/)]);
        expect(JSON.stringify(s.actionResult ?? {})).not.toMatch(/knockedOut/);
    });

    it('summary on dash {targetPosition} keeps the line', async () => {
        await call('combat_manage', { action: 'advance', encounterId: enc });
        const s = await summary('combat_action', { action: 'dash', encounterId: enc, actorId: 'runner', targetPosition: { x: 9, y: 0 } });
        expect(s.reactionLines).toEqual([expect.stringMatching(/knocked out \(subdue\)$/)]);
    });

    // Lane G2 review: the nested mirrors stripped a key readied.attack does not take before any
    // handler saw it (a misspelt ranged under a subdue order skipped the refusal in silence).
    it('a key readied.attack does not take crosses the nested mirror and comes back in ignoredParams, never stored (set_intent, ready, trigger_readied)', async () => {
        const si = await call('combat_manage', { action: 'set_intent', encounterId: enc, participantId: 'grak', readied: { action: 'shoot', trigger: 'he runs', attack: { attackBonus: 40, damage: '1d1+10', rnaged: true } } });
        expect(si.success).toBe(true);
        expect(si.ignoredParams).toEqual(['readied.attack.rnaged']);
        expect(String(si.message)).toMatch(/readied\.attack\.rnaged — nearest valid key 'ranged'/);
        expect(tok('grak').readied.attack).toEqual({ attackBonus: 40, damage: '1d1+10' });

        const text = await raw('combat_action', { action: 'ready', encounterId: enc, actorId: 'grak', readiedAction: 'shoot', trigger: 'he runs', attack: { ...BOLT, onSubdue: 'hold', bonsu: 3 }, oops: 1 });
        const ready = replyJson(text) as Record<string, any>;
        expect(ready.success).toBe(true);
        expect(ready.ignoredParams).toEqual(['attack.bonsu', 'oops']);
        expect(text).toMatch(/Ignored params[^\n]*attack\.bonsu/);
        expect(tok('grak').readied.attack).toEqual({ ...BOLT, onSubdue: 'hold' });

        const held = await call('combat_manage', { action: 'trigger_readied', encounterId: enc, participantId: 'grak', targetId: 'runner', attack: { onSubdue: 'hold', rnaged: true } });
        expect(held).toMatchObject({ held: true, writes: 'none', ignoredParams: ['attack.rnaged'] });
    });

    it('tools/list still advertises every readied attack key, and lets unknown ones through for naming', async () => {
        const { tools } = await client.listTools();
        const readied = (tools.find(t => t.name === 'combat_manage')!.inputSchema.properties as Record<string, any>).readied;
        const attack = (readied.anyOf ?? [readied]).map((s: any) => s.properties?.attack).find(Boolean);
        expect(Object.keys(attack.properties)).toEqual(['using', 'attackBonus', 'damage', 'damageType', 'withPart', 'twoHanded', 'ranged', 'onSubdue']);
        expect(attack.additionalProperties).not.toBe(false);
    });

    it('summary on trigger_readied keeps a held shot line whole', async () => {
        await call('combat_action', { action: 'ready', encounterId: enc, actorId: 'grak', readiedAction: 'shoot', trigger: 'he runs', attack: { ...BOLT, onSubdue: 'hold' } });
        const s = await summary('combat_manage', { action: 'trigger_readied', encounterId: enc, participantId: 'grak', targetId: 'runner' });
        expect(s.reactionLines).toEqual(["⏸ Grak holds fire: subdue order; ranged can't be non-lethal (reaction kept)"]);
        expect(tok('grak').reactionUsed).toBeFalsy();
    });
});
