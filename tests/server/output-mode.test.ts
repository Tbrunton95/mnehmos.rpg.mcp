import { shapeReply, pickFields } from '../../src/server/output-mode.js';
import { handleWorldManage } from '../../src/server/consolidated/world-manage.js';
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

describe('pickFields: deep paths and misses', () => {
    const fixture = { success: true, actionType: 'get', world: { id: 'w', name: 'Vorago', environment: { weather: 'sleet', time: 'dusk' } }, tags: [{ name: 'a', pinned: true }, { name: 'b' }] };

    it('walks a dotted path of any depth', () => {
        expect(pickFields(fixture, ['world.environment.weather'])).toEqual({ success: true, actionType: 'get', world: { environment: { weather: 'sleet' } } });
        expect(pickFields(fixture, ['world.environment.weather', 'world.name'])).toEqual({ success: true, actionType: 'get', world: { name: 'Vorago', environment: { weather: 'sleet' } } });
    });

    it('still projects one level into lists', () => {
        expect(pickFields(fixture, ['tags.name'])).toEqual({ success: true, actionType: 'get', tags: [{ name: 'a' }, { name: 'b' }] });
    });

    it('reports a field that matches nothing, with the top-level keys', () => {
        const out = pickFields(fixture, ['name']);
        expect(out.fieldsNotFound).toEqual(['name']);
        expect(out.availableFields).toEqual(['success', 'actionType', 'world', 'tags']);
        expect(out.world).toBeUndefined();
        const dead = pickFields(fixture, ['world.climate.rain', 'world.name']);
        expect(dead.fieldsNotFound).toEqual(['world.climate.rain']);
        expect(dead.world).toEqual({ name: 'Vorago' });
    });

    it('world_manage get {fields:["name"]} no longer returns bare success', async () => {
        const got = await handleWorldManage({ action: 'get', id: W }, {} as any);
        const shaped = JSON.parse(text(shapeReply(got, { fields: ['name'] })));
        expect(shaped.fieldsNotFound).toEqual(['name']);
        expect(shaped.availableFields).toContain('world');
        const deep = JSON.parse(text(shapeReply(got, { fields: ['world.name'] })));
        expect(deep.world).toEqual({ name: 'Vorago' });
        expect(deep.fieldsNotFound).toBeUndefined();
    });
});
