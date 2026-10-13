/**
 * Play report 5, #1: every nested cover parameter over the real MCP boundary
 * (Client + InMemoryTransport, tools registered as index.ts does). The mirror
 * audit checks top-level keys only, so a nested value that the outer schema
 * types differently is stripped or rejected silently: cast_spell's
 * coverByTarget record and bare cover with targetIds, trigger_readied's cover
 * in both forms, use_ability's savingThrow.onFail, character_manage's scoped
 * ignoreCover riding onto a token, attack {breaksCover}, and the environment's
 * light. tools/list must say what each takes.
 */
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { buildConsolidatedRegistry } from '../../src/server/consolidated-registry.js';
import { schemaShape } from '../../src/server/schema-shape.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { withSession } from '../../src/server/types.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { getInitialSpellSlots } from '../../src/engine/magic/spell-validator.js';

const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;
const state = () => new EncounterRepository(getDb()).loadState(enc)!;
const tok = (id: string) => state().participants.find(p => p.id === id)! as any;
const now = () => new Date().toISOString();

describe('cover over the MCP boundary', () => {
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
        for (const toolName of ['combat_manage', 'combat_action', 'character_manage']) {
            const entry = registry[toolName];
            server.tool(toolName, entry.metadata.description, schemaShape(entry.schema.extend(envelopeShape)),
                withOperation(toolName, withSession(entry.schema, entry.handler as any) as any) as any);
        }
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'cover-test', version: '0.0.0' });
        await client.connect(clientTransport);
    });
    afterEach(async () => { vi.restoreAllMocks(); await client?.close(); await server?.close(); });

    /** A wizard first in the order, a gretchin with a recharge ability, an orc. */
    async function fight(seed: string) {
        new CharacterRepository(getDb()).create({
            id: 'wiz', name: 'Wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 12, level: 5,
            characterClass: 'wizard', knownSpells: ['Fireball'], preparedSpells: ['Fireball'], cantripsKnown: ['Fire Bolt'],
            spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: 3, createdAt: now(), updatedAt: now()
        } as any);
        const created = await call('combat_manage', { action: 'create', seed, participants: [
            { id: 'wiz', name: 'Wizard', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 5 } },
            { id: 'grot', name: 'Grot', hp: 20, maxHp: 20, initiative: 10, isEnemy: true, ac: 12, position: { x: 6, y: 5 }, attackBonus: 3, attackDamage: '1d6', abilities: [{ name: 'Belch', recharge: 5 }] },
            { id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 5, isEnemy: true, ac: 13, position: { x: 6, y: 7 }, attackBonus: 4, attackDamage: '1d8' }
        ] });
        enc = created.encounterId;
    }

    it('cast_spell: coverByTarget as a record crosses (one save raised, one target skipped)', async () => {
        await fight('cover-mcp-1');
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(10);
        const fb = await call('combat_action', { action: 'cast_spell', encounterId: enc, actorId: 'wiz', spellName: 'Fireball', targetIds: ['grot', 'orc'], slotLevel: 3, coverByTarget: { grot: 'half', orc: 'total' } });
        spy.mockRestore();
        expect(fb.ignoredParams).toBeUndefined();
        expect(fb.actionResult.saves.find((s: any) => s.id === 'grot').cover).toMatchObject({ kind: 'half', saveBonus: 2 });
        expect(fb.actionResult.coverSkipped).toEqual(['orc']);
        expect(tok('orc').hp).toBe(30);
    });

    it('cast_spell: a bare cover with targetIds: [one] crosses and raises the spell attack AC', async () => {
        await fight('cover-mcp-2');
        const bolt = await call('combat_action', { action: 'cast_spell', encounterId: enc, actorId: 'wiz', spellName: 'Fire Bolt', targetIds: ['grot'], cover: 'half' });
        expect(bolt.ignoredParams).toBeUndefined();
        expect(bolt.actionResult.cover).toMatchObject({ kind: 'half', acBonus: 2, acBefore: 12, acAfter: 14 });
    });

    it('trigger_readied: cover as a bare kind and as {targetId: kind} both cross', async () => {
        await fight('cover-mcp-3');
        await call('combat_manage', { action: 'set_intent', encounterId: enc, participantId: 'grot', readied: { action: 'shoot', trigger: 'the wizard moves', attack: { attackBonus: 3, damage: '1d6' } } });
        const bare = await call('combat_manage', { action: 'trigger_readied', encounterId: enc, participantId: 'grot', targetId: 'wiz', cover: 'half' });
        expect(bare.ignoredParams).toBeUndefined();
        expect(bare.attack.cover).toMatchObject({ kind: 'half', acBonus: 2, acBefore: 12, acAfter: 14 });
        await call('combat_manage', { action: 'set_intent', encounterId: enc, participantId: 'orc', readied: { action: 'throw', trigger: 'the wizard moves', attack: { attackBonus: 4, damage: '1d8' } } });
        const keyed = await call('combat_manage', { action: 'trigger_readied', encounterId: enc, participantId: 'orc', targetId: 'wiz', cover: { wiz: 'three-quarters' } });
        expect(keyed.ignoredParams).toBeUndefined();
        expect(keyed.attack.cover).toMatchObject({ kind: 'three-quarters', acBonus: 5, acAfter: 17 });
    });

    it('use_ability: savingThrow.onFail and cover cross the loose outer savingThrow', async () => {
        await fight('cover-mcp-4');
        await call('combat_manage', { action: 'advance', encounterId: enc }); // the gretchin's turn
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(2);
        const used = await call('combat_manage', { action: 'use_ability', encounterId: enc, participantId: 'grot', ability: 'Belch', targetIds: ['wiz'], damage: 4, savingThrow: { ability: 'dex', dc: 15, onFail: { conditions: ['prone'] } }, cover: { wiz: 'half' } });
        spy.mockRestore();
        expect(used.success).toBe(true);
        expect(used.ignoredParams).toBeUndefined();
        expect(used.targets[0].conditionsApplied).toEqual(['prone']);
        expect(used.targets[0].cover).toMatchObject({ kind: 'half', saveBonus: 2 });
        expect(tok('wiz').conditions.map((c: any) => c.type)).toContain('prone');
    });

    it('character_manage: a scoped ignoreCover crosses to the sheet and rides onto a token added from it; the bare form crosses on add_participant', async () => {
        new CharacterRepository(getDb()).create({ id: 'archer', name: 'Archer', stats: { str: 10, dex: 16, con: 10, int: 10, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 14, level: 4, createdAt: now(), updatedAt: now() } as any);
        const upd = await call('character_manage', { action: 'update', characterId: 'archer', ignoreCover: { ranged: 'half-and-three-quarters' } });
        expect(upd.isError).toBeFalsy();
        expect(upd.ignoredParams).toBeUndefined();
        expect(new CharacterRepository(getDb()).findById('archer')!.ignoreCover).toEqual({ ranged: 'half-and-three-quarters' });
        await fight('cover-mcp-5');
        await call('combat_manage', { action: 'add_participant', encounterId: enc, characterId: 'archer', position: { x: 0, y: 7 } });
        expect(tok('archer').ignoreCover).toEqual({ ranged: 'half-and-three-quarters' });
        await call('combat_manage', { action: 'add_participant', encounterId: enc, name: 'Sniper', hp: 10, maxHp: 10, isEnemy: true, ignoreCover: 'all', position: { x: 8, y: 8 } });
        const sniper = state().participants.find(p => p.name === 'Sniper') as any;
        expect(sniper.ignoreCover).toEqual({ ranged: 'all', melee: 'all', spells: 'all' });
    });

    it('attack {breaksCover} and set_environment {light} cross; tools/list names cover everywhere it is taken', async () => {
        await fight('cover-mcp-6');
        await call('combat_manage', { action: 'set_cover', encounterId: enc, participantId: 'wiz', level: 'half', reason: 'crate' });
        const atk = await call('combat_action', { action: 'attack', encounterId: enc, actorId: 'wiz', targetId: 'grot', attackBonus: 3, damage: 1, breaksCover: true });
        expect(atk.ignoredParams).toBeUndefined();
        expect(atk.actionResult.coverBroken).toMatchObject({ round: 1, by: 'breaksCover' });
        expect(tok('wiz').coverBrokenRound).toBe(1);

        const env = await call('combat_manage', { action: 'set_environment', encounterId: enc, environment: { light: 'darkness' } });
        expect(env.ignoredParams).toBeUndefined();
        expect(env.environment).toMatchObject({ medium: 'air', light: 'darkness' });
        expect(tok('wiz').canHide ?? state().environment.light).toBeDefined();

        const { tools } = await client.listTools();
        const manageProps = tools.find(t => t.name === 'combat_manage')!.inputSchema.properties as Record<string, any>;
        const actionProps = tools.find(t => t.name === 'combat_action')!.inputSchema.properties as Record<string, any>;
        const charProps = tools.find(t => t.name === 'character_manage')!.inputSchema.properties as Record<string, any>;
        expect(manageProps.environment.description).toMatch(/light/);
        expect(manageProps.against).toBeDefined();
        expect(manageProps.cover.description).toMatch(/trigger_readied/);
        expect(actionProps.coverByTarget.description).toMatch(/cast_spell/);
        expect(actionProps.cover.description).toMatch(/cast_spell/);
        expect(Object.keys(charProps.ignoreCover.properties ?? {})).toEqual(expect.arrayContaining(['ranged', 'melee', 'spells']));
    });
});
