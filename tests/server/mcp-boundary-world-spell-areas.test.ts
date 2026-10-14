/**
 * Play report 7 follow-up (lane S): area world spells over the real MCP
 * boundary (buildServer: the outer mirrors, withSession's re-parse, the
 * operation guard and output_mode).
 *
 * The area flag sits nested in a table_rules spell spec (spec.area {shape,
 * size}), and the count rides combat_action cast_spell's modelsInArea. This
 * file proves both cross: define keeps area and get reads it back; an
 * import of the Orruk preset marks Green Puke; cast_spell refuses a spaced
 * unit without a count (writes 'none', nothing rolled) and resolves the
 * models given; the summary keeps unitLines.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { replyJson } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';

const W = 'blackcrown';

describe('area world spells through buildServer (lane S)', () => {
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
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;
    const rollCount = () => queryRolls(getDb(), { encounterId: enc, limit: 500 }).length;

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'world-spell-areas-build-server', version: '0.0.0' });
        await client.connect(clientTransport);
        enc = (await call('combat_manage', { action: 'create', worldId: W, seed: 'mcp-world-areas', participants: [
            { id: 'shaman', name: 'Shaman', hp: 30, maxHp: 30, initiative: 20 },
            { id: 'line', name: 'Line', hp: 50, maxHp: 50, initiative: 4, isEnemy: true, unit: { models: 10, hpPerModel: 5, packed: false } },
            { id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 3, isEnemy: true, unit: { models: 6, hpPerModel: 9, packed: true, morale: 6 } }
        ] })).encounterId;
        expect(enc).toBeTruthy();
    });
    afterEach(async () => { vi.restoreAllMocks(); await client?.close(); closeDb(); });

    it('spec.area crosses nested in a table_rules define and reads back; a bad shape is refused', async () => {
        const def = await call('table_rules', { action: 'define', worldId: W, kind: 'spell', name: 'Quake', spec: { area: { shape: 'cylinder', size: 30 }, effects: [{ type: 'damage', dice: '30' }] } });
        expect(def.success).toBe(true);
        expect(def.rule.spec.area).toEqual({ shape: 'cylinder', size: 30 });
        const got = await call('table_rules', { action: 'get', worldId: W, name: 'Quake' });
        expect(got.rule.spec.area).toEqual({ shape: 'cylinder', size: 30 });
        const bad = await raw('table_rules', { action: 'define', worldId: W, kind: 'spell', name: 'Fog', spec: { area: { shape: 'blob', size: 30 }, effects: [{ type: 'damage', dice: '3' }] } });
        expect(bad).toMatch(/area\.shape/);
        expect((await call('table_rules', { action: 'get', worldId: W, name: 'Fog' })).error).toBe(true);
    });

    it('an imported Green Puke on a spaced unit: refused without modelsInArea (writes none), then per model with it; summary keeps unitLines', async () => {
        const imported = await call('table_rules', { action: 'import', worldId: W, preset: 'orruk-waaagh' });
        expect(imported.error).toBeUndefined();
        expect((await call('table_rules', { action: 'get', worldId: W, name: 'Green Puke' })).rule.spec.area).toEqual({ shape: 'line', size: 30 });

        const before = rollCount();
        const refused = await call('combat_action', { action: 'cast_spell', encounterId: enc, actorId: 'shaman', spellName: 'Green Puke', targetId: 'line' });
        expect(refused).toMatchObject({ error: true, writes: 'none' });
        expect(String(refused.message)).toMatch(/Line is spaced/);
        expect(rollCount()).toBe(before);
        expect(tok('shaman').actionUsed).toBeFalsy();

        const orig = CombatEngine.prototype.rollDice;
        vi.spyOn(CombatEngine.prototype, 'rollDice').mockImplementation(function (this: CombatEngine, n: string, t: any) {
            if (/^cast Green Puke/.test(t?.purpose)) return { notation: n, rolls: [2, 5], diceTotal: 7, modifier: 0, total: 7 } as any;
            if (/^Green Puke damage/.test(t?.purpose)) return { notation: n, rolls: [4, 6], diceTotal: 10, modifier: 0, total: 10 } as any;
            return orig.call(this, n, t);
        });
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(1);
        const text = await raw('combat_action', { action: 'cast_spell', encounterId: enc, actorId: 'shaman', spellName: 'Green Puke', targetId: 'line', modelsInArea: { line: 4 }, output_mode: 'summary' });
        const s = JSON.parse(text);
        expect(s.unitLines).toEqual([expect.stringMatching(/^Line — 4 of 10 in the line: 4 failed, 0 saved; 10 \/ 5 vs 5 HP each: 4 dead, 6\/10 left/)]);
        expect(tok('line').hp).toBe(30);
    });
});
