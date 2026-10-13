/**
 * Play report 6 #2 over the real MCP boundary.
 *
 * tests/server/montage.test.ts drives handleImprovisationManage through the
 * tool's own inputSchema. A client reaches it through the SDK's validation of
 * the registered outer shape and withSession's re-parse: the outer mirror's
 * costs object used to be a default-strip z.object of z.array(z.any()), so a
 * bare string tier failed at the SDK with a raw Zod dump, a misspelt tier
 * vanished before the router could name it, and the montage schema's own
 * refusal was the only text the GM saw. This drives improvisation_manage and
 * character_manage through a real Client on InMemoryTransport and proves:
 *  - the report's exact payload (a plain string in costs.hardWon) lands as a
 *    note: applied, journaled, nothing on the sheet
 *  - a bare string tier and a JSON string tier reach the handler
 *  - a bad entry is refused by the montage schema (not the SDK) with the shape
 *    and example in the banner, writes 'none'
 *  - a misspelt tier is named, not dropped
 *  - schedule_change {writes: [{op: 'note', text}]} keeps text through the
 *    shared op mirror and prints it on fireNow
 *  - tools/list carries the shape describe on costs.hardWon
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { replyJson } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

// Seeds are seedrandom streams whose first d20 is known: montage-20 → 12, montage-5 → 3.
const W = 'moor';

describe('montage costs over the MCP boundary (play report 6 #2)', () => {
    let client: Client;
    let repo: CharacterRepository;

    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Moor', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now, environment: { day: 10, time: '08:00' } } as any);
        repo = new CharacterRepository(db);
        repo.create({
            id: 'varek', name: 'Varek', characterType: 'pc', level: 5,
            stats: { str: 14, dex: 12, con: 12, int: 10, wis: 12, cha: 8 },
            hp: 30, maxHp: 30, ac: 14, resourcePools: { grit: { current: 5, max: 5 } }, createdAt: now, updatedAt: now
        } as any);
        try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
        db.prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(W, 'varek');
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'montage-costs-boundary-test', version: '0.0.0' });
        await client.connect(clientTransport);
    });

    afterEach(async () => {
        await client.close();
        closeDb();
    });

    const raw = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as ToolResult;
    const call = async (name: string, args: Record<string, unknown>) => {
        const res = await raw(name, args);
        const text = res.content?.[0]?.text ?? '';
        const data = replyJson(text);
        expect(data, `no JSON in reply: ${text.slice(0, 300)}`).not.toBeNull();
        return { text, data: data as Record<string, any>, isError: res.isError };
    };
    const varek = () => repo.findById('varek') as any;
    // Hard-won sits between dc and dc + cleanMargin whatever the skill adds (ability alone or ability + proficiency).
    const hunt = { action: 'montage', characterId: 'varek', task: 'hunt the Gor by scent', dc: 10, cleanMargin: 10, skill: 'survival', context: ['scent'], worldId: W };

    it("the report's exact payload lands: a plain string in hardWon is a note, applied and journaled, nothing on the sheet", async () => {
        const r = await call('improvisation_manage', { ...hunt, costs: { hardWon: ['Varek loses the trail for a day'] }, seed: 'montage-20' });
        expect(r.isError).toBeFalsy();
        expect(r.data).toMatchObject({ success: true, actionType: 'montage', tier: 'hard_won', roll: 12, applied: ['note: Varek loses the trail for a day'] });
        expect(r.data.journalLine).toMatch(/— cost: Varek loses the trail for a day$/);
        expect(r.data.message).toContain('(cost: Varek loses the trail for a day)');
        expect(r.text).toContain('cost: Varek loses the trail for a day');
        const note = getDb().prepare('SELECT content FROM narrative_notes WHERE id = ?').get(r.data.journalNoteId) as any;
        expect(note.content).toContain('— cost: Varek loses the trail for a day');
        expect(varek().hp).toBe(30);
        expect(varek().resourcePools.grit.current).toBe(5);
    });

    it('a bare string tier and a JSON string tier both reach the handler', async () => {
        const bare = await call('improvisation_manage', { ...hunt, costs: { hardWon: 'a day lost' }, seed: 'montage-20', journal: false });
        expect(bare.isError).toBeFalsy();
        expect(bare.data).toMatchObject({ success: true, tier: 'hard_won', applied: ['note: a day lost'] });
        const json = await call('improvisation_manage', { ...hunt, costs: { costly: '[{"op":"adjust_hp","delta":-4}, "a Gor is wounded"]' }, seed: 'montage-5', journal: false });
        expect(json.isError).toBeFalsy();
        expect(json.data).toMatchObject({ success: true, tier: 'costly', applied: ['hp: 30 → 26', 'note: a Gor is wounded'] });
        expect(varek().hp).toBe(26);
    });

    it('a bad entry is refused by the montage schema, not the SDK: the banner carries the shape and the example, writes none, nothing rolled', async () => {
        const r = await call('improvisation_manage', { ...hunt, costs: { hardWon: [5] }, seed: 'montage-20' });
        expect(r.data).toMatchObject({ error: 'validation_error', action: 'montage', writes: 'none' });
        expect(r.data.issues[0]).toMatchObject({ path: 'costs.hardWon.0' });
        expect(r.data.issues[0].message).toMatch(/^a write is an object, not a number — /);
        expect(r.text).toContain("costs.hardWon.0: a write is an object, not a number");
        expect(r.text).toContain("{op: 'note', text}");
        expect(r.text).toContain("costs: {hardWon: ['Varek loses the trail for a day'], costly: [{op: 'adjust_hp', delta: -4}, 'a Gor is wounded']}");
        const unknown = await call('improvisation_manage', { ...hunt, costs: { costly: [{ op: 'lose_trail' }] }, seed: 'montage-5' });
        expect(unknown.data).toMatchObject({ error: 'validation_error', writes: 'none' });
        expect(unknown.text).toMatch(/costs\.costly\.0\.op: unknown op 'lose_trail' — /);
        const db = getDb();
        const hasLog = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roll_log'").get();
        if (hasLog) expect(db.prepare("SELECT COUNT(*) AS n FROM roll_log WHERE purpose = 'montage'").get()).toEqual({ n: 0 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM narrative_notes').get()).toEqual({ n: 0 });
        expect(varek().hp).toBe(30);
    });

    it('a misspelt tier crosses the outer mirror and is named, not dropped', async () => {
        const r = await call('improvisation_manage', { ...hunt, costs: { hard_won: ['a day lost'] }, seed: 'montage-20' });
        expect(r.data).toMatchObject({ error: 'validation_error', writes: 'none' });
        expect(r.data.issues[0]).toMatchObject({ path: 'costs' });
        expect(r.data.issues[0].message).toMatch(/'hard_won' is not a tier — did you mean hardWon\?/);
        expect(r.text).toMatch(/costs: 'hard_won' is not a tier — did you mean hardWon\?/);
        expect(getDb().prepare('SELECT COUNT(*) AS n FROM narrative_notes').get()).toEqual({ n: 0 });
    });

    it('schedule_change keeps a note op through the shared writes mirror and prints it when it fires', async () => {
        const r = await call('character_manage', { action: 'schedule_change', characterId: 'varek', worldId: W, firesAtDay: 10, writes: [{ op: 'note', text: 'the arm has healed' }], fireNow: true });
        expect(r.isError).toBeFalsy();
        expect(r.data).toMatchObject({ success: true, firedNow: true, ops: 1, applied: ['note: the arm has healed'] });
        expect(r.text).toContain('note: the arm has healed');
        expect(varek().hp).toBe(30);
        const listed = await call('character_manage', { action: 'list_scheduled', characterId: 'varek', worldId: W, includeFired: true });
        expect(JSON.parse(listed.data.scheduled[0].writes)).toEqual([{ op: 'note', text: 'the arm has healed' }]);
    });

    it('tools/list advertises costs tiers untyped (a list, a string, an op or a JSON string) with the plain-string and note describe, and leaves the tier object open', async () => {
        const { tools } = await client.listTools();
        const tool = tools.find(t => t.name === 'improvisation_manage')!;
        const costs = (tool.inputSchema.properties as Record<string, any>).costs;
        expect(costs.type).toBe('object');
        expect(costs.additionalProperties).toBe(true);
        // No type on a tier: a client that validates against the schema must not refuse the bare string the engine accepts.
        for (const tier of ['hardWon', 'costly']) { expect(costs.properties[tier].type).toBeUndefined(); expect(costs.properties[tier].description).toMatch(/costs applied on a/); }
        expect(costs.properties.hardWon.description).toMatch(/plain string/);
        expect(costs.properties.hardWon.description).toMatch(/\{op: 'note', text\}/);
        expect(costs.description).toMatch(/hardWon, costly/);
        const character = tools.find(t => t.name === 'character_manage')!;
        const writes = (character.inputSchema.properties as Record<string, any>).writes;
        expect(writes.items.properties.text).toBeDefined();
        expect(writes.items.properties.op.enum).toContain('note');
    });

    // Review edges: what the outer mirror cannot let through still refuses in
    // words a GM can act on, inside the SDK's own refusal.
    it('costs: null crosses the boundary as no cost', async () => {
        const r = await call('improvisation_manage', { ...hunt, costs: null, seed: 'montage-20', journal: false });
        expect(r.isError).toBeFalsy();
        expect(r.data).toMatchObject({ success: true, tier: 'hard_won', applied: [] });
    });

    it("a costs that is not an object is refused at the SDK, and the refusal carries the tier shape, not 'Expected object, received string'", async () => {
        const r = await raw('improvisation_manage', { ...hunt, costs: 'Varek loses the trail', seed: 'montage-20' });
        expect(r.isError).toBe(true);
        const text = r.content?.[0]?.text ?? '';
        expect(text).toMatch(/costs is an object of tiers, not a string — costs: \{hardWon: \[/);
        expect(text).not.toMatch(/Expected object, received string/);
        expect(getDb().prepare('SELECT COUNT(*) AS n FROM narrative_notes').get()).toEqual({ n: 0 });
    });

    it('schedule_change: a writes that is not a list, an op that is not a name and a note text that is not a string are refused at the SDK with the shape; nothing is inserted', async () => {
        const list = await raw('character_manage', { action: 'schedule_change', characterId: 'varek', worldId: W, firesAtDay: 11, writes: 'the arm has healed' });
        expect(list.isError).toBe(true);
        expect(list.content?.[0]?.text).toMatch(/writes is a list of ops, not a string — writes: \[\{op: 'note', text: 'the arm has healed'\}\]/);
        const op = await raw('character_manage', { action: 'schedule_change', characterId: 'varek', worldId: W, firesAtDay: 11, writes: [{ op: 5 }] });
        expect(op.isError).toBe(true);
        expect(op.content?.[0]?.text).toMatch(/op is a name, not a number — each write is/);
        const text = await raw('character_manage', { action: 'schedule_change', characterId: 'varek', worldId: W, firesAtDay: 11, writes: [{ op: 'note', text: 5 }] });
        expect(text.isError).toBe(true);
        expect(text.content?.[0]?.text).toMatch(/note text is a string, not a number — \{op: 'note', text: 'the arm has healed'\}/);
        const listed = await call('character_manage', { action: 'list_scheduled', characterId: 'varek', worldId: W, includeFired: true });
        expect(listed.data.count).toBe(0);
    });
});
