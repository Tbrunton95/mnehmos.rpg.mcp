/**
 * Play report 5 #5 (dying) over the real MCP boundary.
 *
 * tests/combat/dying.test.ts drives the handlers directly. A client reaches
 * them through the SDK's outer-shape validation (a default-strip z.object:
 * a key the outer schema lacks vanishes) and withSession's re-parse. This
 * file registers world_manage, combat_manage, combat_action and
 * character_manage exactly as buildServer does and proves end to end:
 *  - environment.deathSaveMode (nested under world_manage update's
 *    environment) persists and reads back;
 *  - combat_manage death_save {participantId, outcome} lands as posted;
 *  - combat_action stabilize {actorId, targetId} resolves on the tokens;
 *  - character_manage update {deathSaves, deathSaveMode} writes the profile;
 *  - tools/list advertises the new keys;
 *  - (review) create's nested participants[].deathSaves / deathSaveMode,
 *    add_participant {deathSaves}, death_save {characterId, outcome: 'natural
 *    20'} and set_intent {readied: {attack}} → trigger_readied all cross.
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

process.env.NODE_ENV = 'test';

type ToolResult = { content?: Array<{ type: string; text?: string }> };
const now = () => new Date().toISOString();
const W = 'varek';

function payload(result: unknown): Record<string, any> {
    const text = (result as ToolResult).content?.[0]?.text ?? '';
    const m = text.match(/<!-- ([A-Z_]+_JSON)\n([\s\S]*?)\n\1 -->/);
    if (!m) throw new Error(`no embedded JSON in reply:\n${text}`);
    return JSON.parse(m[2]);
}

describe('dying over the MCP boundary (play report 5 #5)', () => {
    let client: Client;
    let server: McpServer;
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        new WorldRepository(db).create({ id: W, name: 'Varek', seed: 's', width: 10, height: 10, createdAt: now(), updatedAt: now(), environment: { day: 3, time: '09:00' } } as any);
        const repo = new CharacterRepository(db);
        for (const [id, hp] of [['medic', 20], ['hero', 0]] as Array<[string, number]>) {
            repo.create({ id, name: id, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 16, cha: 10 }, hp, maxHp: 20, ac: 12, level: 3, skillProficiencies: ['Medicine'], createdAt: now(), updatedAt: now() } as any);
        }
        server = new McpServer({ name: 'rpg-mcp-test', version: '0.0.0' });
        const registry = buildConsolidatedRegistry();
        const envelopeShape = {
            sessionId: z.string().optional(),
            output_mode: z.enum(['json', 'banner', 'summary']).optional(),
            opId: z.string().optional(),
            fields: z.array(z.string()).optional(),
        };
        for (const toolName of ['world_manage', 'combat_manage', 'combat_action', 'character_manage']) {
            const entry = registry[toolName];
            const extended = entry.schema.extend(envelopeShape);
            server.tool(toolName, entry.metadata.description, schemaShape(extended),
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

    it('tools/list advertises the dying keys', async () => {
        const { tools } = await client.listTools();
        const props = (name: string) => tools.find(t => t.name === name)!.inputSchema.properties as Record<string, any>;
        expect(props('combat_manage').outcome).toBeDefined();
        expect(props('combat_manage').deathSaves).toBeDefined();
        expect(props('combat_manage').deathSaveMode).toBeDefined();
        expect(props('combat_action').useKit).toBeDefined();
        expect(props('combat_action').medicineBonus).toBeDefined();
        expect(props('character_manage').deathSaves).toBeDefined();
        expect(props('character_manage').deathSaveMode).toBeDefined();
        expect(tools.find(t => t.name === 'combat_action')!.description).toMatch(/stabilize/);
    });

    it('world_manage update {environment: {deathSaveMode}} persists the nested key and prompt mode then governs advance', async () => {
        const upd = await call('world_manage', { action: 'update', worldId: W, environment: { deathSaveMode: 'prompt' } });
        expect(upd.error).toBeUndefined();
        expect(new WorldRepository(getDb()).findById(W)!.environment.deathSaveMode).toBe('prompt');
        const created = await call('combat_manage', { action: 'create', seed: 'mcp-dying', worldId: W, participants: [
            { id: 'medic', name: 'Medic', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'hero', name: 'Hero', hp: 0, maxHp: 20, initiative: 10, position: { x: 1, y: 0 } }
        ] });
        const enc = created.encounterId as string;
        const due = await call('combat_manage', { action: 'advance', encounterId: enc });
        expect(due.deathSaveDue).toMatchObject({ participantId: 'hero' });
        const refused = await call('combat_manage', { action: 'advance', encounterId: enc });
        expect(refused.error).toBe(true);
        expect(refused.writes).toBe('none');
        // A posted outcome crosses the boundary and clears the due flag.
        const posted = await call('combat_manage', { action: 'death_save', encounterId: enc, participantId: 'hero', outcome: 'success' });
        expect(posted.deathSave).toMatchObject({ participantId: 'hero', posted: 'success', successes: 1 });
        const next = await call('combat_manage', { action: 'advance', encounterId: enc });
        expect(next.error).toBeUndefined();
    });

    it('death_save {outcome: 20} as a number crosses the boundary (the mirror takes string | number) and returns 1 HP on token and sheet', async () => {
        const created = await call('combat_manage', { action: 'create', seed: 'mcp-dying-20', worldId: W, participants: [
            { id: 'medic', name: 'Medic', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'hero', name: 'Hero', hp: 0, maxHp: 20, initiative: 10, position: { x: 1, y: 0 } }
        ] });
        const enc = created.encounterId as string;
        const posted = await call('combat_manage', { action: 'death_save', encounterId: enc, participantId: 'hero', outcome: 20 });
        expect(posted.error).toBeUndefined();
        expect(posted.deathSave).toMatchObject({ participantId: 'hero', posted: 'nat20', regainedHp: true, hp: 1, sheetHp: 1 });
        expect(new CharacterRepository(getDb()).findById('hero')!.hp).toBe(1);
    });

    it('combat_action stabilize resolves on the tokens with the healer adjacent', async () => {
        const created = await call('combat_manage', { action: 'create', seed: 'mcp-stabilize', worldId: W, participants: [
            { id: 'medic', name: 'Medic', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'hero', name: 'Hero', hp: 0, maxHp: 20, initiative: 10, position: { x: 1, y: 0 } }
        ] });
        const enc = created.encounterId as string;
        const r = await call('combat_action', { action: 'stabilize', encounterId: enc, actorId: 'medic', targetId: 'hero', medicineBonus: 20 });
        expect(r.error).toBeUndefined();
        expect(r.check).toMatchObject({ modifier: 20, success: true });
        expect(r.stabilized).toBe(true);
        const hero = new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === 'hero') as any;
        expect(hero.isStabilized).toBe(true);
        expect(r.recoversIn.scheduleId).toBeGreaterThan(0);
    });

    it('create {participants: [{deathSaves, deathSaveMode}]} (nested, the mirror takes the array as any) reaches a sheetless token: its slot prompts in an auto world', async () => {
        const created = await call('combat_manage', { action: 'create', seed: 'mcp-dying-nested', worldId: W, participants: [
            { id: 'medic', name: 'Medic', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'brute', name: 'Brute', hp: 0, maxHp: 30, initiative: 15, isEnemy: true, position: { x: 3, y: 3 }, deathSaves: true, deathSaveMode: 'prompt' }
        ] });
        expect(created.error).toBeUndefined();
        const enc = created.encounterId as string;
        const brute = new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === 'brute') as any;
        expect(brute).toMatchObject({ deathSaves: true, deathSaveMode: 'prompt' });
        const due = await call('combat_manage', { action: 'advance', encounterId: enc });
        expect(due.deathSaveDue).toMatchObject({ participantId: 'brute' });
        expect(due.rawText ?? JSON.stringify(due)).not.toMatch(/<encounterId>/);
    });

    it('add_participant {deathSaves: true} opts a sheetless token in; death_save {characterId, outcome: "natural 20"} crosses as the alias and the spelling', async () => {
        const created = await call('combat_manage', { action: 'create', seed: 'mcp-dying-add', worldId: W, participants: [
            { id: 'medic', name: 'Medic', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } }
        ] });
        const enc = created.encounterId as string;
        // An ad-hoc token (no characterId) gets a generated id: find it by name.
        const added = await call('combat_manage', { action: 'add_participant', encounterId: enc, name: 'Villain', hp: 0, maxHp: 12, initiativeBonus: 2, isEnemy: true, deathSaves: true });
        expect(added.error).toBeUndefined();
        const tok = () => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.name === 'Villain') as any;
        expect(tok().deathSaves).toBe(true);
        const villainId = tok().id as string;
        const posted = await call('combat_manage', { action: 'death_save', encounterId: enc, characterId: villainId, outcome: 'natural 20' });
        expect(posted.error).toBeUndefined();
        expect(posted.deathSave).toMatchObject({ participantId: villainId, posted: 'nat20', regainedHp: true, hp: 1 });
        expect(tok().hp).toBe(1);
    });

    it('set_intent {readied: {attack}} then trigger_readied drops a tracked target through the nested attack: the sheet is marked dying and the reply says so', async () => {
        new CharacterRepository(getDb()).update('hero', { hp: 5 } as any);
        const created = await call('combat_manage', { action: 'create', seed: 'mcp-dying-readied', worldId: W, participants: [
            { id: 'medic', name: 'Medic', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'hero', name: 'Hero', hp: 5, maxHp: 20, initiative: 10, position: { x: 1, y: 0 } },
            { id: 'gob', name: 'Goblin', hp: 7, maxHp: 7, initiative: 5, isEnemy: true, position: { x: 2, y: 0 } }
        ] });
        const enc = created.encounterId as string;
        const set = await call('combat_manage', { action: 'set_intent', encounterId: enc, participantId: 'gob', readied: { action: 'stab', trigger: 'the hero stirs', attack: { attackBonus: 40, damage: '1d1+5' } } });
        expect(set.error).toBeUndefined();
        const fired = await call('combat_manage', { action: 'trigger_readied', encounterId: enc, participantId: 'gob', targetId: 'hero' });
        expect(fired.error).toBeUndefined();
        expect(fired.attack).toMatchObject({ hit: true, targetHpAfter: 0 });
        expect(fired.dying).toMatchObject({ dropped: true });
        expect(fired.message).toMatch(/DYING ✓0 ✗0/);
        const row = new CharacterRepository(getDb()).findById('hero') as any;
        expect(row.hp).toBe(0);
        expect((row.conditions as Array<{ name: string; source?: string }>).map(c => `${c.name}:${c.source}`)).toEqual(expect.arrayContaining(['Unconscious:dying', 'Prone:dying']));
    });

    it('character_manage update {deathSaves: false, deathSaveMode: prompt} writes the combat profile', async () => {
        const upd = await call('character_manage', { action: 'update', characterId: 'hero', deathSaves: false, deathSaveMode: 'prompt' });
        expect(upd.error).toBeUndefined();
        const row = new CharacterRepository(getDb()).findById('hero') as any;
        expect(row.deathSaves).toBe(false);
        expect(row.deathSaveMode).toBe('prompt');
    });
});
