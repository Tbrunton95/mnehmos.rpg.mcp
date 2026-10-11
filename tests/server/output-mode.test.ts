import { shapeReply, pickFields, summarizeResult } from '../../src/server/output-mode.js';
import { handleWorldManage } from '../../src/server/consolidated/world-manage.js';
import { handleNarrativeManage } from '../../src/server/consolidated/narrative-manage.js';
import { handleItemManage } from '../../src/server/consolidated/item-manage.js';
import { handlePrecedentManage } from '../../src/server/consolidated/precedent-manage.js';
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

// Play report 2, #13: summary mode replaced every oversized value with a
// count, so item.id, precedentId and the ids inside session find were gone
// — the handles the next call needs.
describe('summary keeps the handles', () => {
    const embed = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/)![2]);

    it('item_manage create keeps item.id and its name', async () => {
        const res = await handleItemManage({ action: 'create', name: 'Chainsword', type: 'misc', description: 'A roaring blade of the Astartes, forty characters long at least.' }, {} as any);
        const s = JSON.parse(text(shapeReply(res, { mode: 'summary' })));
        expect(s.item.id).toBe(embed(res).item.id);
        expect(s.item.name).toBe('Chainsword');
        expect(s.item._keys).toBeGreaterThan(0);
        expect(s.message).toMatch(/created/);
    });

    it('precedent_manage search keeps a precedentId per row', async () => {
        for (const st of ['Sleet halves sight', 'Fire spreads one square a round', "Flight is the Warp's, not the air's"]) {
            await handlePrecedentManage({ action: 'record', worldId: W, kind: 'ruling', statement: st }, {} as any);
        }
        const res = await handlePrecedentManage({ action: 'search', worldId: W }, {} as any);
        const s = JSON.parse(text(shapeReply(res, { mode: 'summary' })));
        expect(s.count).toBe(3);
        expect(s.precedents).toHaveLength(3);
        expect(s.precedents.map((p: { precedentId: string }) => p.precedentId).sort()).toEqual(embed(res).precedents.map((p: { precedentId: string }) => p.precedentId).sort());
        const rec = await handlePrecedentManage({ action: 'record', worldId: W, kind: 'ruling', statement: 'x'.repeat(300) }, {} as any);
        expect(JSON.parse(text(shapeReply(rec, { mode: 'summary' }))).precedent.precedentId).toBe(embed(rec).precedent.precedentId);
    });

    it('an id list one level inside an object survives (session find)', () => {
        const s = summarizeResult({ success: true, results: { characters: [{ id: 'c1', match: 'x'.repeat(300) }], items: [{ id: 'i1', match: 'y'.repeat(300) }], note: 'z'.repeat(300) } });
        expect(s.results).toEqual({ characters: [{ id: 'c1' }], items: [{ id: 'i1' }], _keys: 3 });
    });

    it('id-less values still collapse to counts', () => {
        const s = summarizeResult({ blob: { a: 'x'.repeat(300), b: 1 }, conditions: [{ name: 'x'.repeat(300) }, { name: 'y' }, { name: 'z' }], small: [1, 2, 3] });
        expect(s.blob).toBe('{2 keys}');
        expect(s.conditions).toBe('[3 items]');
        expect(s.small).toEqual([1, 2, 3]);
    });

    it('a short name is a handle, a long one is not', () => {
        const s = summarizeResult({ rule: { name: 'n'.repeat(100), kind: 'status_block', spec: { a: 'x'.repeat(300) } }, short: { name: 'tiny-status', kind: 'status_block', spec: { a: 'x'.repeat(300) } } });
        expect(s.rule).toBe('{3 keys}');
        expect(s.short).toEqual({ name: 'tiny-status', _keys: 3 });
    });

    it('a long id list is capped at 25 rows with the remainder counted', () => {
        const rows = Array.from({ length: 30 }, (_, i) => ({ id: `row-${i}`, name: `Row ${i}`, text: 'z'.repeat(50) }));
        const s = summarizeResult({ rows });
        expect(s.rows).toHaveLength(26);
        expect(s.rows[0]).toEqual({ id: 'row-0', name: 'Row 0' });
        expect(s.rows[25]).toEqual({ _more: 5 });
    });

    it('a reply keeps at most 50 id rows in all, nested lists included; the rest count as before', () => {
        const list = () => Array.from({ length: 25 }, (_, i) => ({ participantId: `p${i}`, hp: i, note: 'n'.repeat(20) }));
        const s = summarizeResult({ a: list(), b: { inner: list(), other: 'o'.repeat(300) }, c: list() });
        expect(s.a).toHaveLength(25);
        expect(s.b).toEqual({ inner: expect.any(Array), _keys: 2 });
        expect((s.b as { inner: unknown[] }).inner).toHaveLength(25);
        expect(s.c).toBe('[25 items]');
    });

    it('a top-level ...Ids list of scalars is kept up to 50', () => {
        const ids = Array.from({ length: 60 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
        const s = summarizeResult({ wouldScopeIds: ids, encounterId: 'enc-1', scopedIds: ids.slice(0, 3) });
        expect(s.wouldScopeIds).toHaveLength(51);
        expect(s.wouldScopeIds[50]).toEqual({ _more: 10 });
        expect(s.encounterId).toBe('enc-1');
        expect(s.scopedIds).toEqual(ids.slice(0, 3));
    });
});

describe('the guard line rides summary and json as _op', () => {
    const body = JSON.stringify({ success: true, hp: 5, big: 'x'.repeat(400) });

    it('summary, fields and json carry _op from a leading guard line', () => {
        const res = { content: [{ type: 'text', text: `▌ op v1 applied\nBANNER\n<!-- X_JSON\n${body}\nX_JSON -->` }] };
        expect(JSON.parse(text(shapeReply(res, { mode: 'summary' })))).toMatchObject({ _op: 'op v1 applied', hp: 5 });
        expect(JSON.parse(text(shapeReply(res, { mode: 'json' })))).toEqual({ _op: 'op v1 applied', success: true, hp: 5, big: 'x'.repeat(400) });
        expect(JSON.parse(text(shapeReply(res, { fields: ['hp'] })))).toEqual({ _op: 'op v1 applied', success: true, hp: 5 });
    });

    it('a bare-JSON reply behind a guard line is read too', () => {
        const res = { content: [{ type: 'text', text: '▌ op v2: nothing written — opId not consumed\n{"success":true,"writes":"none"}' }] };
        expect(JSON.parse(text(shapeReply(res, { mode: 'json' })))).toEqual({ _op: 'op v2: nothing written — opId not consumed', success: true, writes: 'none' });
        expect(JSON.parse(text(shapeReply(res, { mode: 'summary' })))).toEqual({ _op: 'op v2: nothing written — opId not consumed', success: true, writes: 'none' });
    });

    it('json mode without a guard line is byte-for-byte the embed, as before', () => {
        const res = { content: [{ type: 'text', text: `BANNER\n<!-- X_JSON\n${body}\nX_JSON -->` }] };
        expect(text(shapeReply(res, { mode: 'json' }))).toBe(body);
    });

    it("a tool's own rail line is never lifted as _op", () => {
        const res = { content: [{ type: 'text', text: `▌ HP 320/320 · RESOLVE 100/100\n▌ COND x\n<!-- X_JSON\n${body}\nX_JSON -->` }] };
        expect(JSON.parse(text(shapeReply(res, { mode: 'summary' })))._op).toBeUndefined();
        expect(text(shapeReply(res, { mode: 'json' }))).toBe(body);
    });
});
