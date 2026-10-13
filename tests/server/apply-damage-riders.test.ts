/**
 * Play report 5, #6: riders on area damage. apply_damage.save.onFail /
 * onSuccess carry conditions applied per target through resolveAreaSave
 * (lair_action and use_ability share it via savingThrow.onFail / onSuccess),
 * reported as conditionsApplied and a Conditions: line; the sheet path
 * upserts them on the row. The nested outer `save` mirror must carry them,
 * which only a call over the real MCP boundary proves.
 */
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';
import { schemaShape } from '../../src/server/schema-shape.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { withSession } from '../../src/server/types.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';

const ctx = { sessionId: 'riders' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;
const manage = async (args: Record<string, unknown>) => {
    const text = (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    return tag(text, 'COMBAT_MANAGE') ?? { rawText: text };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const row = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
const now = () => new Date().toISOString();
/** Pin the next engine d20s: 15 saves against DC 13 with +0, 5 fails. */
const d20s = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

async function setup() {
    closeDb(); getDb(':memory:'); clearCombatState();
    new CharacterRepository(getDb()).create({ id: 'hero', name: 'Hero', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 30, maxHp: 30, ac: 14, level: 3, createdAt: now(), updatedAt: now() } as any);
    const created = await handleCombatManage({ action: 'create', seed: 'riders', participants: [
        { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20 },
        { id: 'grot', name: 'Grot', hp: 20, maxHp: 20, initiative: 10, isEnemy: true, ac: 12 }
    ] }, ctx as any);
    enc = tag(created.content[0].text, 'COMBAT_MANAGE').encounterId;
}

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('apply_damage riders in an encounter', () => {
    it('onFail puts prone + Buried (sourced rockslide) on the failing target only; the saver gets nothing', async () => {
        await setup();
        d20s(5, 15); // hero fails, grot saves
        const r = await manage({ action: 'apply_damage', targetIds: ['hero', 'grot'], dice: 6, source: 'rockslide', save: { ability: 'dex', dc: 13, onFail: { conditions: ['prone', { name: 'Buried', source: 'rockslide' }] } } });
        expect(r.success).toBe(true);
        const hero = r.targets.find((t: any) => t.targetId === 'hero');
        const grot = r.targets.find((t: any) => t.targetId === 'grot');
        expect(hero.saved).toBe(false);
        expect(hero.conditionsApplied).toEqual(['prone', 'Buried']);
        expect(grot.saved).toBe(true);
        expect(grot.conditionsApplied).toBeUndefined();
        expect(r.message).toMatch(/Hero[\s\S]*Conditions: prone, Buried/);
        expect(tok('hero').conditions.map((c: any) => [c.type, c.sourceId])).toEqual([['prone', 'rockslide (failed save)'], ['Buried', 'rockslide']]);
        expect(tok('grot').conditions).toEqual([]);
        // Token only by default: the sheet is untouched.
        expect(row('hero').conditions ?? []).toEqual([]);
    });

    it('onSuccess applies only to savers; mirrorToCharacter writes the row too; a same-type condition is replaced, not doubled', async () => {
        await setup();
        getOrLoadEngine(ctx as any, enc)!.applyCondition('hero', { type: 'prone', durationType: 'permanent', sourceId: 'earlier' } as any);
        d20s(15, 5);
        const r = await manage({ action: 'apply_damage', targetIds: ['hero', 'grot'], dice: 6, source: 'shockwave', save: { ability: 'str', dc: 13, onFail: { conditions: ['prone'], mirrorToCharacter: true }, onSuccess: { conditions: [{ name: 'Braced', duration: 1 }], mirrorToCharacter: true } } });
        const hero = r.targets.find((t: any) => t.targetId === 'hero');
        const grot = r.targets.find((t: any) => t.targetId === 'grot');
        expect(hero.saved).toBe(true);
        expect(hero.conditionsApplied).toEqual(['Braced']);
        expect(grot.saved).toBe(false);
        expect(grot.conditionsApplied).toEqual(['prone']);
        expect(tok('hero').conditions.map((c: any) => c.type)).toEqual(['prone', 'Braced']);
        expect(row('hero').conditions).toEqual([{ name: 'Braced', duration: 1, source: 'shockwave (saved)' }]);
        // Replace, not stack: a second failed save leaves one prone.
        d20s(5, 5);
        await manage({ action: 'apply_damage', targetIds: ['grot'], dice: 1, source: 'shockwave', save: { ability: 'str', dc: 13, onFail: { conditions: ['prone'] } } });
        expect(tok('grot').conditions.filter((c: any) => c.type === 'prone')).toHaveLength(1);
    });

    it('an invalid rider condition (save_ends without its DC) is refused before any roll, writes none', async () => {
        await setup();
        const r = await manage({ action: 'apply_damage', targetIds: ['hero'], dice: 6, source: 'rockslide', save: { ability: 'dex', dc: 13, onFail: { conditions: [{ name: 'Buried', durationType: 'save_ends' }] } } });
        expect(r.error).toBeTruthy();
        expect(r.writes).toBe('none');
        expect(tok('hero').hp).toBe(30);
    });

    it('use_ability and lair_action take savingThrow.onFail through the same resolver', async () => {
        closeDb(); getDb(':memory:'); clearCombatState();
        const created = await handleCombatManage({ action: 'create', seed: 'riders-2', participants: [
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20 },
            { id: 'dragon', name: 'Dragon', hp: 200, maxHp: 200, initiative: 30, isEnemy: true, ac: 19, hasLairActions: true, abilities: [{ name: 'Tail Sweep', recharge: 5 }] }
        ] }, ctx as any);
        enc = tag(created.content[0].text, 'COMBAT_MANAGE').encounterId;
        d20s(5);
        const used = await manage({ action: 'use_ability', participantId: 'dragon', ability: 'Tail Sweep', targetIds: ['hero'], damage: 10, savingThrow: { ability: 'dex', dc: 15, onFail: { conditions: ['prone'] } } });
        expect(used.success).toBe(true);
        expect(used.targets[0].conditionsApplied).toEqual(['prone']);
        expect(tok('hero').conditions.map((c: any) => c.type)).toEqual(['prone']);
        // On to the LAIR slot.
        let st = getOrLoadEngine(ctx as any, enc)!.getState()!;
        while (st.turnOrder[st.currentTurnIndex] !== 'LAIR') { await manage({ action: 'advance' }); st = getOrLoadEngine(ctx as any, enc)!.getState()!; }
        d20s(5);
        const lair = await manage({ action: 'lair_action', actionDescription: 'the floor cracks', targetIds: ['hero'], damage: 5, savingThrow: { ability: 'dexterity', dc: 15, onFail: { conditions: [{ name: 'Restrained', source: 'the cracked floor' }] } } });
        expect(lair.success).toBe(true);
        expect(JSON.stringify(lair)).toMatch(/Conditions: Restrained/);
        expect(tok('hero').conditions.map((c: any) => c.type)).toEqual(['prone', 'restrained']);
    });
});

describe('apply_damage riders on the sheet path', () => {
    it('failing rows get the conditions upserted by name with the source; the reply carries conditionsApplied', async () => {
        closeDb(); getDb(':memory:'); clearCombatState();
        new CharacterRepository(getDb()).create({ id: 'rogue', name: 'Rogue', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 14, level: 1, conditions: [{ name: 'Buried', source: 'old' }], createdAt: now(), updatedAt: now() } as any);
        const text = (await handleCombatManage({ action: 'apply_damage', targetIds: ['rogue'], dice: 6, source: 'rockslide', save: { ability: 'dex', dc: 30, onFail: { conditions: ['prone', { name: 'Buried', source: 'rockslide', duration: 3 }] } } }, ctx as any)).content[0].text;
        const r = tag(text, 'COMBAT_MANAGE');
        expect(r.success).toBe(true);
        expect(r.targets[0].saved).toBe(false);
        expect(r.targets[0].conditionsApplied).toEqual(['prone', 'Buried']);
        expect(r.message).toMatch(/Conditions: prone, Buried/);
        expect(row('rogue').conditions).toEqual([{ name: 'prone', source: 'rockslide (failed save)' }, { name: 'Buried', duration: 3, source: 'rockslide' }]);
    });
});

describe('over the MCP boundary', () => {
    let client: Client;
    let server: McpServer;
    const call = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>)[0].text;
        return tag(text, name.toUpperCase()) ?? { rawText: text, isError: (res as { isError?: boolean }).isError };
    };

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
            server.tool(toolName, entry.metadata.description, schemaShape(entry.schema.extend(envelopeShape)),
                withOperation(toolName, withSession(entry.schema, entry.handler as any) as any) as any);
        }
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'riders-test', version: '0.0.0' });
        await client.connect(clientTransport);
    });
    afterEach(async () => { await client?.close(); await server?.close(); });

    it('save.onFail survives the outer schema: the condition is applied, and cover rides the same call', async () => {
        const created = await call('combat_manage', { action: 'create', seed: 'riders-mcp', participants: [
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'grot', name: 'Grot', hp: 20, maxHp: 20, initiative: 10, isEnemy: true, ac: 12, position: { x: 4, y: 0 } }
        ] });
        enc = created.encounterId;
        const r = await call('combat_manage', { action: 'apply_damage', encounterId: enc, targetIds: ['hero'], dice: 6, source: 'rockslide', save: { ability: 'dex', dc: 30, onFail: { conditions: ['prone', { name: 'Buried', source: 'rockslide' }] } }, cover: { hero: 'half' } });
        expect(r.success).toBe(true);
        expect(r.ignoredParams).toBeUndefined();
        expect(r.targets[0].conditionsApplied).toEqual(['prone', 'Buried']);
        expect(r.targets[0].cover).toMatchObject({ kind: 'half', saveBonus: 2 });
        expect(tok('hero').conditions.map((c: any) => c.type)).toEqual(['prone', 'Buried']);

        // combat_action: cover (and coverByTarget's record shape) cross too.
        const atk = await call('combat_action', { action: 'attack', encounterId: enc, actorId: 'grot', targetId: 'hero', attackBonus: 3, damage: 1, cover: 'three-quarters' });
        expect(atk.ignoredParams).toBeUndefined();
        expect(atk.actionResult.cover).toMatchObject({ kind: 'three-quarters', acBonus: 5 });
        const set = await call('combat_manage', { action: 'set_cover', encounterId: enc, participantId: 'hero', level: 'half', against: { direction: 'east' }, reason: 'low wall' });
        expect(set.success).toBe(true);
        expect(set.cover).toMatchObject({ level: 'half', direction: 'east' });
        const setIds = await call('combat_manage', { action: 'set_cover', encounterId: enc, participantId: 'hero', level: 'half', against: ['grot'] });
        expect(setIds.cover).toMatchObject({ level: 'half', against: ['grot'] });
    });

    it('a typo inside a rider condition is refused at the boundary with nothing written', async () => {
        const created = await call('combat_manage', { action: 'create', seed: 'riders-mcp-2', participants: [
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20 }
        ] });
        enc = created.encounterId;
        const r = await call('combat_manage', { action: 'apply_damage', encounterId: enc, targetIds: ['hero'], dice: 6, source: 'rockslide', save: { ability: 'dex', dc: 30, onFail: { conditions: [{ nme: 'Buried' }] } } });
        expect(r.error ?? r.isError).toBeTruthy();
        expect(tok('hero').hp).toBe(30);
    });

    it('tools/list advertises cover on combat_action and the save riders on combat_manage', async () => {
        const { tools } = await client.listTools();
        const action = tools.find(t => t.name === 'combat_action')!.inputSchema.properties as Record<string, any>;
        const manageProps = tools.find(t => t.name === 'combat_manage')!.inputSchema.properties as Record<string, any>;
        expect(action.cover.enum).toEqual(expect.arrayContaining(['none', 'half', 'three-quarters', 'total']));
        expect(action.coverByTarget.type).toBe('object');
        expect(action.breaksCover.type).toBe('boolean');
        expect(manageProps.save.properties.onFail.properties.conditions.type).toBe('array');
        expect(manageProps.save.properties.onSuccess).toBeDefined();
        expect(manageProps.cover.type).toBe('object');
        expect(manageProps.level.enum).toEqual(expect.arrayContaining(['half', 'three-quarters', 'total']));
    });
});
