import { shapeReply } from '../../src/server/output-mode.js';
import { handleNarrativeManage } from '../../src/server/consolidated/narrative-manage.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const W = 'om-world';
beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Vorago', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
});
afterEach(() => closeDb());

const text = (r: { content?: Array<{ text: string }> }) => r.content![0].text;

describe('output_mode and fields on replies', () => {
    it('use the embedded JSON when the reply has one', () => {
        const res = { content: [{ type: 'text', text: `BANNER\n<!-- X_JSON\n${JSON.stringify({ success: true, hp: 5, big: 'x'.repeat(400) })}\nX_JSON -->` }] };
        expect(JSON.parse(text(shapeReply(res, { mode: 'summary' }))).big).toMatch(/400 chars/);
        expect(JSON.parse(text(shapeReply(res, { mode: 'json' })))).toMatchObject({ hp: 5 });
        expect(JSON.parse(text(shapeReply(res, { fields: ['hp'] })))).toEqual({ success: true, hp: 5 });
    });

    it('fall back to a bare JSON reply, so fields work on narrative_manage', async () => {
        const { noteId } = JSON.parse(text(await handleNarrativeManage({ action: 'add', worldId: W, type: 'plot_thread', content: 'y'.repeat(9000), tags: ['vaurek'] }, {} as any)));
        const got = await handleNarrativeManage({ action: 'get', noteId }, {} as any);
        expect(JSON.parse(text(shapeReply(got, { fields: ['id', 'tags'] })))).toEqual({ id: noteId, tags: ['vaurek'] });
        expect(JSON.parse(text(shapeReply(got, { mode: 'summary' }))).content).toMatch(/9000 chars/);
    });

    it('leave prose, and replies with no mode, untouched', () => {
        const prose = { content: [{ type: 'text', text: 'Just words {not json' }] };
        expect(shapeReply(prose, { fields: ['a'] })).toBe(prose);
        const bare = { content: [{ type: 'text', text: '{"a":1}' }] };
        expect(shapeReply(bare, {})).toBe(bare);
    });
});
