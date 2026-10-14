/**
 * Play report 7 #7 review: output_mode 'summary' over the real MCP boundary
 * (buildServer). A refusal that teaches must survive the small reply: the
 * chair pastes the call it prints. Summary cut every string at 300
 * characters and folded any list over 200 to '[N items]', so sourceProblems,
 * mechanicProblems and the unmapped-skill warning arrived as '[1 items]'.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { replyJson } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';
const W = 'blackcrown';

describe('declared advantage under output_mode summary (play report 7 review)', () => {
    let client: Client;
    const call = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>)[0].text;
        const data = replyJson(text);
        expect(data, `no JSON in reply: ${text.slice(0, 300)}`).not.toBeNull();
        return data as Record<string, any>;
    };

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
        const server = buildServer(new PubSub(), new AuditLogger());
        const [c, s] = InMemoryTransport.createLinkedPair();
        await server.connect(s);
        client = new Client({ name: 'summary-advantage', version: '0.0.0' });
        await client.connect(c);
    });
    afterEach(async () => { await client.close(); closeDb(); });

    it('a refused check keeps every source problem whole, with the call to paste', async () => {
        const v = await call('character_manage', { action: 'create', name: 'Varek', worldId: W, conditions: [{ name: 'Gor Hunter' }], skillAdvantage: [{ name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent' }] });
        const r = await call('math_manage', { action: 'roll_skill_check', characterId: v.id, skill: 'insight', advantageSources: ['Gor Hunter', 'Keen Smell'], output_mode: 'summary' });
        expect(r.error).toBe(true);
        expect(r.writes).toBe('none');
        expect(r.sourceProblems).toEqual([
            `'Gor Hunter' grants no advantage on insight. To grant one, improvisation_manage feature_from_condition {characterId: '${v.id}', match: 'Gor Hunter', mechanics: [{type: 'advantage_on', value: 'check:insight'}]}; for a one-off, use situationalAdvantage: '<reason>'.`,
            `'Keen Smell' is Varek's skillAdvantage trait for perception, survival (when: scent); this is an insight check, so it does not apply — on a perception or survival check name it, or tag it: math_manage {action: 'roll_skill_check', characterId: '${v.id}', skill: 'perception', context: ['scent']}; nothing granted`
        ]);
    });

    it('a refused effect keeps its mechanic problems whole, the accepted forms included', async () => {
        const v = await call('character_manage', { action: 'create', name: 'Kessa', worldId: W });
        const r = await call('improvisation_manage', { action: 'apply_effect', targetId: v.id, name: 'Sneaky', category: 'boon', durationType: 'until_removed', mechanics: [{ type: 'advantage_on', value: 'stealth checks in dim light' }], output_mode: 'summary' });
        expect(r.error).toBe(true);
        expect(r.mechanicProblems).toHaveLength(1);
        expect(r.mechanicProblems[0]).toMatch(/^mechanics\[0\]: advantage_on value 'stealth checks in dim light' is not a scope\. Accepted scopes: .* save:<ability> \(save:str\), initiative\.$/);
    });

    it('a refused grapple keeps its source problems whole', async () => {
        const v = await call('character_manage', { action: 'create', name: 'Varek', worldId: W, conditions: [{ name: 'Horn-Lock: locks horns head-on' }] });
        const t = await call('character_manage', { action: 'create', name: 'Rival', worldId: W });
        const r = await call('combat_action', { action: 'grapple', move: 'clinch', actorId: v.id, targetId: t.id, advantageSources: ['Horn-Lock'], output_mode: 'summary' });
        expect(r.error).toBe(true);
        expect(r.writes).toBe('none');
        expect(r.sourceProblems).toEqual([`'Horn-Lock' grants no advantage on a grapple (clinch). To grant one, improvisation_manage feature_from_condition {characterId: '${v.id}', match: 'Horn-Lock', mechanics: [{type: 'advantage_on', value: 'grapple'}]}; for a one-off, use situationalAdvantage: '<reason>'.`]);
    });

    it("an unmapped skill's loud warning survives summary", async () => {
        const v = await call('character_manage', { action: 'create', name: 'Nim', worldId: W });
        const r = await call('math_manage', { action: 'roll_skill_check', characterId: v.id, skill: 'haggling', seed: 'summary', output_mode: 'summary' });
        expect(r.success).toBe(true);
        expect(r.skillAbilitySource).toBe('none');
        expect(r.resolverProblems).toEqual([`skill 'haggling' names no ability (not an SRD skill or a world skill): rolled with no skill modifier (no ability, no proficiency) — pass ability, or define it with table_rules {kind: 'skill', name: 'haggling', spec: {ability}}`]);
    });
});
