/**
 * Play report 7 #1 (area damage on units, per model) over the real MCP
 * boundary.
 *
 * tests/combat/unit-area.test.ts drives the handlers. A client reaches them
 * through the SDK's outer-shape validation (a default-strip z.object: a key
 * the outer mirror lacks vanishes, a nested type mismatch is rejected) and
 * withSession's re-parse. This file registers combat_manage and
 * combat_action as buildServer does and proves the new params cross:
 *  - tools/list advertises area, modelsInArea and saves (combat_manage) and
 *    modelsInArea (combat_action), and add_participant's unit.saves
 *  - modelsInArea as a record ({line: 2}) on apply_damage and cast_spell, and
 *    as a bare number on use_ability with area: true
 *  - unit.saves nested in create's participants[].unit and add_participant's
 *    unit (long keys normalised to short), set_unit {saves} and {saves: null}
 *  - a spaced unit with no count refused with writes 'none'; an unknown save
 *    key on set_unit refused with nothing written
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
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';

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

describe('area damage on units over the MCP boundary (play report 7 #1)', () => {
    let client: Client;
    let server: McpServer;
    let enc: string;
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now(), updatedAt: now() } as any);
        new CharacterRepository(db).create({
            id: 'mage', name: 'Mage', characterClass: 'wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
            hp: 30, maxHp: 30, ac: 12, level: 5, spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: getMaxSpellLevel('wizard' as any, 5),
            knownSpells: ['Fireball'], preparedSpells: ['Fireball'], createdAt: now(), updatedAt: now()
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
        const created = await call('combat_manage', { action: 'create', worldId: W, seed: 'mcp-unit-area', participants: [
            { id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 50 },
            { id: 'drake', name: 'Drake', hp: 120, maxHp: 120, initiative: 40, abilities: [{ name: 'Fire Breath', recharge: 5 }] },
            { id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, unit: { models: 6, hpPerModel: 9, packed: true, saves: { dex: 2 } } },
            { id: 'line', name: 'Line', hp: 50, maxHp: 50, initiative: 4, isEnemy: true, unit: { models: 10, hpPerModel: 5, packed: false } }
        ] });
        enc = created.encounterId as string;
        expect(enc).toBeTruthy();
    });

    afterEach(async () => {
        await client?.close();
        await server?.close();
        closeDb();
    });

    it('tools/list advertises area, modelsInArea and saves', async () => {
        const { tools } = await client.listTools();
        const props = (name: string) => tools.find(t => t.name === name)!.inputSchema.properties as Record<string, any>;
        expect(props('combat_manage').area).toBeDefined();
        expect(props('combat_manage').modelsInArea).toBeDefined();
        expect(props('combat_manage').saves).toBeDefined();
        expect(JSON.stringify(props('combat_manage').unit)).toContain('saves');
        expect(props('combat_action').modelsInArea).toBeDefined();
    });

    it("unit.saves crosses nested in create's participants and add_participant's unit; set_unit replaces and clears it", async () => {
        expect(tok('militia').unit.saves).toEqual({ dex: 2 });
        const added = await call('combat_manage', { action: 'add_participant', encounterId: enc, name: 'Pikes', hp: 40, maxHp: 40, isEnemy: true, unit: { models: 4, hpPerModel: 10, packed: true, saves: { Dexterity: 1 } } });
        expect(added.error).toBeUndefined();
        const pikes = new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.name === 'Pikes') as any;
        expect(pikes.unit.saves).toEqual({ dex: 1 });
        const set = await call('combat_manage', { action: 'set_unit', encounterId: enc, participantId: 'militia', saves: { CON: 2 } });
        expect(set.error).toBeUndefined();
        expect(set.unit.saves).toEqual({ con: 2 });
        expect(tok('militia').unit.saves).toEqual({ con: 2 });
        const cleared = await call('combat_manage', { action: 'set_unit', encounterId: enc, participantId: 'militia', saves: null });
        expect(cleared.error).toBeUndefined();
        expect(tok('militia').unit.saves).toBeUndefined();
    });

    it('an unknown save key is refused and nothing is written', async () => {
        const res = await client.callTool({ name: 'combat_manage', arguments: { action: 'set_unit', encounterId: enc, participantId: 'militia', saves: { luck: 2 } } }) as ToolResult;
        const text = res.content?.[0]?.text ?? '';
        expect(res.isError || /error/i.test(text)).toBeTruthy();
        expect(text).toMatch(/luck/);
        expect(tok('militia').unit.saves).toEqual({ dex: 2 });
    });

    it('modelsInArea as a record crosses on apply_damage; a spaced unit without it is refused with writes none', async () => {
        const refused = await call('combat_manage', { action: 'apply_damage', encounterId: enc, targetIds: ['line'], dice: 10, source: 'scree', area: true });
        expect(refused).toMatchObject({ error: true, writes: 'none' });
        expect(tok('line').hp).toBe(50);
        const r = await call('combat_manage', { action: 'apply_damage', encounterId: enc, targetIds: ['line'], dice: 10, source: 'scree', modelsInArea: { line: 2 } });
        expect(r.targets[0].unitArea).toMatchObject({ modelsInArea: 2, inAreaSource: 'given', modelsKilled: 2 });
        expect(tok('line').hp).toBe(40);
    });

    it('modelsInArea as a bare number with area: true crosses on use_ability', async () => {
        // The drake's turn: the mage acts first, so pass it.
        await call('combat_manage', { action: 'advance', encounterId: enc, confirm: true });
        const r = await call('combat_manage', { action: 'use_ability', encounterId: enc, participantId: 'drake', ability: 'Fire Breath', targetIds: ['militia'], damage: 31, damageType: 'fire', savingThrow: { ability: 'dex', dc: 13 }, area: true, modelsInArea: 4 });
        expect(r.error).toBeUndefined();
        expect(r.targets[0].unitArea).toMatchObject({ modelsInArea: 4, inAreaSource: 'given', modelsKilled: 4, modelsAfter: 2 });
        expect(r.targets[0].unitArea.saves).toHaveLength(4);
        expect(r.targets[0].unitArea.saveBonus).toMatchObject({ drilled: 2 });
    });

    it('cast_spell takes modelsInArea through the combat_action quartet', async () => {
        const r = await call('combat_action', { action: 'cast_spell', encounterId: enc, actorId: 'mage', spellName: 'Fireball', targetIds: ['line'], modelsInArea: { line: 3 } });
        const ar = r.actionResult ?? r;
        expect(ar.unitAreas?.[0]).toMatchObject({ targetId: 'line', modelsInArea: 3, inAreaSource: 'given', shape: 'sphere' });
        expect(tok('line').hp).toBe(50 - 5 * ar.unitAreas[0].modelsKilled);
    });
});

/**
 * Adversarial review: the same params through buildServer itself (the
 * passthrough outer schema, withOutputMode), and output_mode 'summary'
 * keeping each unit's line (unitLines) whole. Before, summary kept only each
 * target's id: the per-model result was gone from apply_damage and cast_spell.
 */
describe('area damage on units through buildServer, output_mode summary (play report 7 #1)', () => {
    let client: Client;
    let enc: string;
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now(), updatedAt: now() } as any);
        new CharacterRepository(db).create({
            id: 'mage', name: 'Mage', characterClass: 'wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
            hp: 30, maxHp: 30, ac: 12, level: 5, spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: getMaxSpellLevel('wizard' as any, 5),
            knownSpells: ['Fireball'], preparedSpells: ['Fireball'], createdAt: now(), updatedAt: now()
        } as any);
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'unit-area-build-server', version: '0.0.0' });
        await client.connect(clientTransport);
        const created = await call('combat_manage', { action: 'create', worldId: W, seed: 'mcp-unit-area-summary', participants: [
            { id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 50 },
            { id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, stats: { dex: 14 }, unit: { models: 6, hpPerModel: 9, packed: true, saves: { Dexterity: 1 } } },
            { id: 'line', name: 'Line', hp: 50, maxHp: 50, initiative: 4, isEnemy: true, unit: { models: 10, hpPerModel: 5, packed: false } }
        ] });
        enc = created.encounterId as string;
        expect(enc).toBeTruthy();
    });
    afterEach(async () => { await client?.close(); closeDb(); });

    it('nested unit.saves and stats land on the token; summary keeps unitLines on apply_damage', async () => {
        expect(tok('militia').unit.saves).toEqual({ dex: 1 });
        expect(tok('militia').abilityScores).toMatchObject({ dexterity: 14 });
        const s = await call('combat_manage', { action: 'apply_damage', encounterId: enc, targetIds: ['militia', 'line'], dice: 31, source: 'rockslide', area: true, modelsInArea: { line: 2 }, output_mode: 'summary' });
        expect(s.error).toBeUndefined();
        expect(s.targets).toEqual([{ targetId: 'militia' }, { targetId: 'line' }]);
        expect(s.unitLines).toEqual([
            'Militia — 6 in the area, no save: 31 vs 9 HP each: 6 dead, 0/6 left',
            'Line — 2 of 10 in the area, no save: 31 vs 5 HP each: 2 dead, 8/10 left'
        ]);
        expect(tok('line').hp).toBe(40);
    });

    it('summary keeps unitLines on cast_spell (it kept only the unit id under actionResult)', async () => {
        const s = await call('combat_action', { action: 'cast_spell', encounterId: enc, actorId: 'mage', spellName: 'Fireball', targetIds: ['militia'], output_mode: 'summary' });
        expect(s.error).toBeUndefined();
        expect(s.unitLines).toHaveLength(1);
        expect(s.unitLines[0]).toMatch(/^Militia — 6 in the sphere: \d failed, \d saved; \d+ \/ \d+ vs 9 HP each: \d dead, \d\/6 left/);
        expect(tok('militia').hp).toBe(9 * Number(s.unitLines[0].match(/(\d)\/6 left/)[1]));
    });
});
