/**
 * Play report 5 #7, #8a, #8b and the rest of #8c over the real MCP boundary.
 *
 * tests/server/trait-advantage-mcp.test.ts proves skillAdvantage, context,
 * a scene-wide senseDenial and wind cross the SDK's outer-shape validation
 * and withSession's re-parse. This file covers the other nested params the
 * lane added, each of which a nested mirror could strip or a type mismatch
 * could reject with a raw Zod dump:
 *  - character_manage senses and naturalArmor on create and update (and the
 *    addDex default the outer parse applies), the status block's senses and
 *    passive block, a bad sense refused with nothing written
 *  - table_rules define {kind: 'species', spec: {senses, naturalArmor,
 *    skillAdvantage}} copied onto a sheet at create
 *  - combat_manage create participants[].senses and add_participant {senses}
 *  - math_manage opposed {targetContext}, roll_skill_check {against}
 *  - improvisation_manage montage {skill, context} (the outer mirror's
 *    context is z.any() because process_triggers shares the key)
 *  - item_manage armour aliases canonicalised with `aliased` in the reply, a
 *    category typo refused with writes 'none'; inventory_manage equip replies
 *    with armor {…} and warnings[], and the worn armour's stealth disadvantage
 *    reaches roll_skill_check
 *  - scene_manage senseDenial as an array mixing per-target and scene-wide
 *    entries, and an amendment that keeps what it did not restate
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
import { WorldRepository } from '../../src/storage/repos/world.repo.js';

process.env.NODE_ENV = 'test';

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
function payload(result: unknown): Record<string, any> {
    const text = (result as ToolResult).content?.[0]?.text ?? '';
    const m = text.match(/<!-- ([A-Z_]+_JSON)\n([\s\S]*?)\n\1 -->/);
    if (m) return JSON.parse(m[2]);
    try { return JSON.parse(text); } catch { throw new Error(`no JSON in reply:\n${text}`); }
}

const TOOLS = ['character_manage', 'combat_manage', 'math_manage', 'scene_manage', 'improvisation_manage', 'item_manage', 'inventory_manage', 'table_rules'];
const KEEN_SMELL = { name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent', passiveBonus: 5 };
const STATS = { str: 10, dex: 12, con: 10, int: 10, wis: 12, cha: 10 };

describe('senses, natural armour and armour over the MCP boundary (play report 5 #7, #8)', () => {
    let client: Client;
    let server: McpServer;
    const W = 'moor';
    const call = async (name: string, args: Record<string, unknown>) => payload(await client.callTool({ name, arguments: args }));
    const raw = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as ToolResult;
    const count = (table: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Moor', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
        server = new McpServer({ name: 'rpg-mcp-test', version: '0.0.0' });
        const registry = buildConsolidatedRegistry();
        const envelopeShape = {
            sessionId: z.string().optional(),
            output_mode: z.enum(['json', 'banner', 'summary']).optional(),
            opId: z.string().optional(),
            fields: z.array(z.string()).optional(),
        };
        for (const toolName of TOOLS) {
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
        clearCombatState();
        closeDb();
    });

    it('tools/list advertises the nested params on every tool that takes them', async () => {
        const { tools } = await client.listTools();
        const props = (name: string) => tools.find(t => t.name === name)!.inputSchema.properties as Record<string, any>;
        expect(props('character_manage').senses.type).toBe('object');
        expect(props('character_manage').naturalArmor.type).toBe('object');
        expect(props('combat_manage').senses).toBeDefined();
        expect(props('math_manage').targetContext).toBeDefined();
        expect(props('math_manage').against).toBeDefined();
        expect(props('math_manage').seed).toBeDefined();
        expect(props('improvisation_manage').context).toBeDefined();
        expect(props('improvisation_manage').skill).toBeDefined();
        expect(props('scene_manage').senseDenial).toBeDefined();
        expect(props('scene_manage').wind).toBeDefined();
        expect(props('inventory_manage').recomputeAc).toBeDefined();
    });

    it('senses and naturalArmor cross create, update, get and the status block; a bad sense is refused with nothing written', async () => {
        const created = await call('character_manage', { action: 'create', name: 'Varek', worldId: W, stats: STATS, senses: { darkvisionFt: 60 }, naturalArmor: { base: 12 } });
        expect(created.senses).toEqual({ darkvisionFt: 60 });
        // The outer parse applies addDex's default and the inner parse keeps it.
        expect(created.naturalArmor).toEqual({ base: 12, addDex: true });
        // Natural armour 12 + DEX +1 beats unarmoured 11 at create.
        expect(created.ac).toBe(13);

        const updated = await call('character_manage', { action: 'update', characterId: created.id, naturalArmor: { base: 14, addDex: false }, senses: { darkvisionFt: 60, blindsightFt: 10 } });
        expect(updated.armorClass).toMatchObject({ derived: 14, applied: true });
        expect(updated.senses).toEqual({ darkvisionFt: 60, blindsightFt: 10 });
        const got = await call('character_manage', { action: 'get', characterId: created.id });
        expect(got.ac).toBe(14);
        expect(got.naturalArmor).toEqual({ base: 14, addDex: false });
        expect(got.passive).toEqual({ perception: 11, senses: [] });

        const blockRaw = await raw('character_manage', { action: 'get_status_block', characterId: created.id });
        const block = payload(blockRaw);
        expect(block.senses).toEqual({ darkvisionFt: 60, blindsightFt: 10 });
        expect(block.passive).toEqual({ perception: 11, senses: [] });
        // The rendered block (the text around the JSON) shows the senses on the speed row.
        expect(blockRaw.content?.[0]?.text).toMatch(/DV 60/);
        expect(blockRaw.content?.[0]?.text).toMatch(/BS 10/);

        const bad = await raw('character_manage', { action: 'update', characterId: created.id, senses: { darkvisionFt: 'sixty' } });
        expect(bad.isError).toBe(true);
        expect(bad.content?.[0]?.text).toMatch(/senses/);
        expect((await call('character_manage', { action: 'get', characterId: created.id })).senses).toEqual({ darkvisionFt: 60, blindsightFt: 10 });
        const unknown = await raw('character_manage', { action: 'update', characterId: created.id, senses: { xrayFt: 5 } });
        expect(unknown.isError).toBe(true);
    });

    it('a species rule with senses, naturalArmor and skillAdvantage crosses table_rules define and lands on the sheet at create', async () => {
        const rule = await call('table_rules', { action: 'define', worldId: W, kind: 'species', name: 'Ratfolk', spec: { speed: 30, senses: { darkvisionFt: 60 }, naturalArmor: { base: 12, addDex: true }, skillAdvantage: [KEEN_SMELL], traits: ['Keen Smell'] } });
        expect(rule.error).toBeFalsy();
        const c = await call('character_manage', { action: 'create', name: 'Skritch', worldId: W, race: 'Ratfolk', stats: STATS });
        expect(c.senses).toEqual({ darkvisionFt: 60 });
        expect(c.naturalArmor).toEqual({ base: 12, addDex: true });
        expect(c.skillAdvantage).toEqual([KEEN_SMELL]);
        expect(c.ac).toBe(13);
        const block = await call('character_manage', { action: 'get_status_block', characterId: c.id });
        expect(block.passive.senses).toEqual([{ when: 'scent', trait: 'Keen Smell', value: 16, label: 'passive Perception (scent) 16' }]);
    });

    it('token senses cross combat_manage create participants[] and add_participant, and default from the sheet', async () => {
        const sheet = await call('character_manage', { action: 'create', name: 'Varek', worldId: W, stats: STATS, senses: { darkvisionFt: 60 } });
        const other = await call('character_manage', { action: 'create', name: 'Mole', worldId: W, stats: STATS });
        const enc = await call('combat_manage', { action: 'create', participants: [
            { id: sheet.id, name: 'Varek', initiativeBonus: 0, hp: 10, maxHp: 10 },
            { id: 'bat', name: 'Bat', initiativeBonus: 0, hp: 5, maxHp: 5, isEnemy: true, senses: { blindsightFt: 30 } }
        ] });
        const encounterId = enc.encounterId ?? enc.id;
        expect(encounterId).toBeTruthy();
        const added = await call('combat_manage', { action: 'add_participant', encounterId, characterId: other.id, senses: { tremorsenseFt: 20 } });
        expect(added.error).toBeFalsy();
        const state = await call('combat_manage', { action: 'get', encounterId });
        const token = (id: string) => state.participants.find((p: any) => p.id === id);
        expect(token(sheet.id).senses).toEqual({ darkvisionFt: 60 });
        expect(token('bat').senses).toEqual({ blindsightFt: 30 });
        expect(token(other.id).senses).toEqual({ tremorsenseFt: 20 });
    });

    it("opposed {targetContext} fires the defender's trait, roll_skill_check {against} compares to the observer's passives, montage {skill, context} fires the trait", async () => {
        const varek = await call('character_manage', { action: 'create', name: 'Varek', worldId: W, stats: STATS, skillAdvantage: [KEEN_SMELL] });
        const ratling = await call('character_manage', { action: 'create', name: 'Ratling', worldId: W, stats: { str: 8, dex: 14, con: 10, int: 10, wis: 10, cha: 8 } });

        const opposed = await call('math_manage', { action: 'opposed', characterId: ratling.id, skill: 'stealth', targetId: varek.id, targetSkill: 'perception', targetContext: ['scent'] });
        expect(opposed.success).toBe(true);
        expect(opposed.defender.rolls).toHaveLength(2);
        expect(opposed.defender.advantageSources).toEqual(['Keen Smell (scent)']);
        expect(opposed.initiator.rolls).toHaveLength(1);
        expect(opposed.passiveCheck).toMatchObject({ sense: 'scent', trait: 'Keen Smell', passive: 16 });
        // A bare string tag is accepted on the defender too.
        const bare = await call('math_manage', { action: 'opposed', characterId: ratling.id, skill: 'stealth', targetId: varek.id, targetSkill: 'perception', targetContext: 'scent' });
        expect(bare.defender.rolls).toHaveLength(2);

        const hide = await call('math_manage', { action: 'roll_skill_check', characterId: ratling.id, skill: 'stealth', against: varek.id });
        expect(hide.against).toMatchObject({ observerId: varek.id, observerName: 'Varek', passivePerception: 11 });
        expect(hide.against.passives).toEqual([{ when: 'scent', trait: 'Keen Smell', value: 16, label: 'passive Perception (scent) 16' }]);
        expect(typeof hide.against.noticed).toBe('boolean');

        const montage = await call('improvisation_manage', { action: 'montage', characterId: varek.id, task: 'follow the trail', dc: 10, skill: 'survival', context: ['scent'], seed: 'mcp-montage' });
        expect(montage.success).toBe(true);
        expect(montage.advantageSources).toEqual(['Keen Smell (scent)']);
        expect(montage.advantageRoll.rolls).toHaveLength(2);
        expect(montage.abilityModifier).toBe(1);
        expect(montage.context).toEqual(['scent']);
    });

    it('armour aliases are canonicalised through item_manage, equip replies carry armor and warnings, a typo is refused with writes none, and the worn armour puts Stealth at disadvantage', async () => {
        const wearer = await call('character_manage', { action: 'create', name: 'Varek', worldId: W, stats: STATS });
        expect(wearer.ac).toBe(11);
        const shirt = await call('item_manage', { action: 'create', name: 'Mail shirt', type: 'armor', weight: 20, value: 50, properties: { baseAc: 13, maxDex: 2, armorType: 'medium', stealth_disadvantage: true } });
        expect(shirt.aliased).toEqual({ baseAc: 'baseAC', maxDex: 'maxDexBonus', armorType: 'armorCategory', stealth_disadvantage: 'stealthDisadvantage' });
        expect(shirt.item.properties).toEqual({ baseAC: 13, maxDexBonus: 2, armorCategory: 'medium', stealthDisadvantage: true });
        expect(shirt.armorProps).toMatchObject({ baseAC: 13, maxDexBonus: 2, armorCategory: 'medium', stealthDisadvantage: true });

        const itemsBefore = count('items');
        const typo = await call('item_manage', { action: 'create', name: 'Odd coat', type: 'armor', weight: 1, value: 1, properties: { baseAC: 12, armorCategory: 'medum' } });
        expect(typo.error ?? typo.success === false).toBeTruthy();
        expect(JSON.stringify(typo)).toMatch(/nearest is 'medium'/);
        expect(typo.writes).toBe('none');
        expect(count('items')).toBe(itemsBefore);

        await call('inventory_manage', { action: 'give', characterId: wearer.id, itemId: shirt.item.id, quantity: 1 });
        const worn = await call('inventory_manage', { action: 'equip', characterId: wearer.id, itemId: shirt.item.id, slot: 'armor' });
        expect(worn.success).toBe(true);
        expect(worn.ac).toMatchObject({ before: 11, after: 14, source: 'derived' });
        expect(worn.armor).toMatchObject({ item: 'Mail shirt', category: 'medium', baseAC: 13, dexApplied: 1, dexCap: 2, stealthDisadvantage: true });
        expect(worn.warnings).toBeUndefined();

        const sneak = await call('math_manage', { action: 'roll_skill_check', characterId: wearer.id, skill: 'stealth' });
        expect(sneak.rolls).toHaveLength(2);
        expect(sneak.disadvantageSources).toEqual(['Mail shirt (stealth disadvantage)']);
        const cancelled = await call('math_manage', { action: 'roll_skill_check', characterId: wearer.id, skill: 'stealth', advantage: true });
        expect(cancelled.rolls).toHaveLength(1);

        await call('inventory_manage', { action: 'unequip', characterId: wearer.id, itemId: shirt.item.id });
        const blank = await call('item_manage', { action: 'create', name: 'Padded jack', type: 'armor', weight: 5, value: 5, properties: { weightClass: 'light' } });
        await call('inventory_manage', { action: 'give', characterId: wearer.id, itemId: blank.item.id, quantity: 1 });
        const unreadable = await call('inventory_manage', { action: 'equip', characterId: wearer.id, itemId: blank.item.id, slot: 'armor' });
        expect(unreadable.success).toBe(true);
        expect(unreadable.ac.after).toBe(11);
        expect(unreadable.warnings).toHaveLength(1);
        expect(unreadable.warnings[0]).toContain('no readable baseAC');
        expect(unreadable.warnings[0]).toContain(`item_manage update {itemId: '${blank.item.id}', properties: {baseAC: <n>}, mergeProperties: true}`);
        // The fix it prints, fed back through the boundary, repairs the row and the next equip derives.
        const fixed = await call('item_manage', { action: 'update', itemId: blank.item.id, properties: { baseAC: 11, armorCategory: 'light' }, mergeProperties: true });
        expect(fixed.success).toBe(true);
        expect(fixed.item.properties).toMatchObject({ weightClass: 'light', baseAC: 11, armorCategory: 'light' });
        await call('inventory_manage', { action: 'unequip', characterId: wearer.id, itemId: blank.item.id });
        const again = await call('inventory_manage', { action: 'equip', characterId: wearer.id, itemId: blank.item.id, slot: 'armor' });
        expect(again.ac.after).toBe(12);
        expect(again.warnings).toBeUndefined();
    });

    it('senseDenial as an array mixing a per-target and a scene-wide entry crosses intact, and an amendment keeps what it did not restate', async () => {
        const varek = await call('character_manage', { action: 'create', name: 'Varek', worldId: W, stats: STATS, skillAdvantage: [KEEN_SMELL] });
        const set = await call('scene_manage', { action: 'set', worldId: W, narration: 'Smoke and a west wind.', participants: [varek.id],
            senseDenial: [{ targetId: varek.id, scent: 'buried in peat-smoke' }, { hearing: 'the waterfall drowns everything' }], wind: 'from W' });
        expect(set.success).toBe(true);
        expect(set.scene.senseDenial).toEqual([{ targetId: varek.id, senses: { scent: 'buried in peat-smoke' } }, { senses: { hearing: 'the waterfall drowns everything' } }]);
        expect(set.scene.wind).toBe('from W');
        const under = await call('math_manage', { action: 'roll_skill_check', characterId: varek.id, skill: 'perception', context: ['scent'] });
        expect(under.rolls).toHaveLength(1);
        expect(under.deniedAdvantage[0].reason).toBe('buried in peat-smoke');

        const turned = await call('scene_manage', { action: 'set', worldId: W, wind: 'from E' });
        expect(turned.success).toBe(true);
        expect(turned.scene.wind).toBe('from E');
        expect(turned.scene.senseDenial).toHaveLength(2);
        expect(turned.inherited).toEqual(expect.arrayContaining(['narration', 'participants', 'senseDenial']));

        const scenesBefore = count('scenes');
        const empty = await raw('scene_manage', { action: 'set', worldId: W, senseDenial: { targetId: varek.id } });
        expect(empty.isError).toBe(true);
        expect(empty.content?.[0]?.text).toMatch(/names no sense/);
        expect(count('scenes')).toBe(scenesBefore);
    });
});
