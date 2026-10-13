/**
 * Play report 5 #10 over the real MCP boundary.
 *
 * The lane tests call handleCharacterManage directly. A client reaches it
 * through the SDK's validation of the registered outer shape (a nested key
 * the outer mirror lacks vanishes there) and withSession's own parse. This
 * drives character_manage through a real Client on InMemoryTransport and
 * proves, end to end:
 *  - a replace whose find sits in the source is refused with writes: 'none',
 *    the row untouched, and the printed replaceSource call pasted back hits
 *  - replaceSource, pinned and duration cross the boundary and land
 *  - tools/list advertises editConditions items with replace and
 *    replaceSource {find, with} and the describe that names the miss rule
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { replyJson } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

describe('character_manage editConditions over the MCP boundary (play report 5 #10)', () => {
    let client: Client;
    let repo: CharacterRepository;

    beforeEach(async () => {
        closeDb();
        repo = new CharacterRepository(getDb(':memory:'));
        const now = new Date().toISOString();
        repo.create({
            id: 'luciel', name: 'Luciel', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 },
            hp: 200, maxHp: 200, ac: 20, level: 15,
            conditions: [{ name: 'Oath of the Ninth: sworn', source: 'sworn before Karanak' }, { name: 'Warp-burn', source: 'the Mouth' }],
            createdAt: now, updatedAt: now
        } as any);
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'edit-conditions-boundary-test', version: '0.0.0' });
        await client.connect(clientTransport);
    });

    afterEach(async () => {
        await client.close();
        closeDb();
    });

    const raw = async (args: Record<string, unknown>) => await client.callTool({ name: 'character_manage', arguments: args }) as ToolResult;
    const call = async (args: Record<string, unknown>) => {
        const res = await raw(args);
        const text = res.content?.[0]?.text ?? '';
        const data = replyJson(text);
        expect(data, `no JSON in reply: ${text.slice(0, 300)}`).not.toBeNull();
        return { text, data: data as Record<string, any>, isError: res.isError };
    };
    const oath = () => repo.findById('luciel')!.conditions!.find(c => c.name.startsWith('Oath'))!;

    it('a replace whose find sits in the source is refused with writes none and the row untouched; the printed call pasted back hits', async () => {
        const miss = await call({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'oath', replace: { find: 'Karanak', with: 'the Mouth' } }] });
        expect(miss.data.error).toBe(true);
        expect(miss.data.writes).toBe('none');
        expect(miss.text).toContain('Use replaceSource: editConditions: [{match: "oath", replaceSource: {find: "Karanak", with: "the Mouth"}}]');
        expect(oath().source).toBe('sworn before Karanak');
        // The printed call is a pasteable object literal: read it back as the GM would and send it.
        const printed = String(miss.data.message).match(/Use replaceSource: editConditions: (\[\{.*\}\])\. Nothing was written/);
        expect(printed).not.toBeNull();
        const editConditions = new Function(`return ${printed![1]}`)();
        const hit = await call({ action: 'update', characterId: 'luciel', editConditions });
        expect(hit.data.success).toBe(true);
        expect(hit.data.changed).toEqual(['conditions']);
        expect(oath().source).toBe('sworn before the Mouth');
    });

    it('replaceSource, pinned and duration cross the boundary and land together', async () => {
        const r = await call({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'warp', replaceSource: { find: 'Mouth', with: 'Maw' }, pinned: true, duration: 3 }] });
        expect(r.data.success).toBe(true);
        expect(repo.findById('luciel')!.conditions!.find(c => c.name === 'Warp-burn')).toEqual({ name: 'Warp-burn', source: 'the Maw', pinned: true, duration: 3 });
    });

    it('a case-only miss over the wire names the casing that is there, and writes nothing', async () => {
        const r = await call({ action: 'update', characterId: 'luciel', editConditions: [{ match: 'oath', replaceSource: { find: 'karanak', with: 'x' } }] });
        expect(r.data.error).toBe(true);
        expect(r.data.writes).toBe('none');
        expect(r.data.message).toMatch(/'karanak' is not in the source of 'Oath of the Ninth: sworn' as written; 'Karanak' is \(find is case-sensitive\)/);
        expect(oath().source).toBe('sworn before Karanak');
    });

    it('tools/list advertises editConditions items with replace and replaceSource {find, with} and the miss rule', async () => {
        const { tools } = await client.listTools();
        const tool = tools.find(t => t.name === 'character_manage')!;
        const edit = (tool.inputSchema.properties as Record<string, any>).editConditions;
        expect(edit.type).toBe('array');
        expect(edit.items.required).toEqual(['match']);
        for (const key of ['replace', 'replaceSource']) {
            expect(edit.items.properties[key].type).toBe('object');
            expect(edit.items.properties[key].required).toEqual(['find', 'with']);
        }
        expect(edit.items.properties.replace.description).toMatch(/find is case-sensitive.*needs replaceSource/);
        expect(edit.items.properties.replaceSource.description).toMatch(/text in the name needs replace/);
        expect(edit.description).toMatch(/match reads condition names only/);
    });
});
