import { handlePrecedentManage } from '../../../src/server/consolidated/precedent-manage.js';
import { handleKnowledgeManage } from '../../../src/server/consolidated/knowledge-manage.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../../src/storage/repos/custom-effects.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const W = 'vorago';
const ctx = { sessionId: 'pk' };
const tag = (res: any, t: string) => JSON.parse(res.content[0].text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`))![1]);
const prec = async (a: Record<string, unknown>) => tag(await handlePrecedentManage({ worldId: W, ...a }, ctx as any), 'PRECEDENT_MANAGE');
const know = async (a: Record<string, unknown>) => tag(await handleKnowledgeManage({ worldId: W, ...a }, ctx as any), 'KNOWLEDGE_MANAGE');

beforeEach(() => {
    closeDb();
    const repo = new CharacterRepository(getDb(':memory:'));
    const now = new Date().toISOString();
    for (const [id, name, type] of [['luciel', 'Luciel', 'pc'], ['oszaverek', 'Oszaverek', 'npc'], ['vigil', 'Vigil', 'npc'], ['inquisitor', 'Inquisitor Hale', 'npc']]) {
        repo.create({ id, name, characterType: type, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 10, level: 1, createdAt: now, updatedAt: now } as any);
    }
});
afterEach(() => closeDb());

describe('precedent ledger', () => {
    it('records rulings and inventions, finds them by text or scope, and supersedes', async () => {
        const flight = await prec({ action: 'record', kind: 'ruling', statement: "Flight is the Warp's, not the air's", scope: 'flight', context: 'Day 366 mountain' });
        await prec({ action: 'record', kind: 'invention', statement: 'Vigil holds overwatch at 4 km', scope: 'Vigil', tags: ['range'] });
        expect((await prec({ action: 'search', query: 'warp' })).precedents[0].statement).toMatch(/Flight is the Warp's/);
        expect((await prec({ action: 'search', scope: 'vigil' })).count).toBe(1);
        const sup = await prec({ action: 'supersede', precedentId: flight.precedent.precedentId, statement: "Flight is the Warp's; the air only carries it under a daemon's wing" });
        expect(sup.replaced.supersededBy).toBe(sup.precedent.precedentId);
        const now = await prec({ action: 'search', scope: 'flight' });
        expect(now.count).toBe(1);
        expect(now.precedents[0].statement).toMatch(/daemon's wing/);
        expect((await prec({ action: 'search', scope: 'flight', includeSuperseded: true })).count).toBe(2);
    });
});

describe('knowledge ledger', () => {
    it('tracks roads to a fact; telling needs a teller who knows; can_know answers for an NPC', async () => {
        await know({ action: 'record', key: 'ithraes', statement: "Ithraes is Oszaverek's true name", knowers: [{ id: 'luciel', how: 'witnessed', note: "spoken in the Mouth's chamber", day: 366 }] });
        expect((await know({ action: 'can_know', key: 'ithraes', knowerId: 'inquisitor' })).knows).toBe(false);
        const refused = await know({ action: 'learn', key: 'ithraes', knowerId: 'inquisitor', how: 'told', fromId: 'vigil' });
        expect(refused.message).toMatch(/Vigil does not know 'ithraes', so could not have told Inquisitor Hale/);
        await know({ action: 'learn', key: 'ithraes', knowerId: 'vigil', how: 'told', fromId: 'luciel', day: 367 });
        await know({ action: 'learn', key: 'ithraes', knowerId: 'inquisitor', how: 'told', fromId: 'vigil' });
        const who = await know({ action: 'who_knows', key: 'ithraes' });
        expect(who.knowers.map((k: any) => k.road)).toEqual([
            "Luciel: witnessed (spoken in the Mouth's chamber), day 366",
            'Vigil: told by Luciel, day 367',
            'Inquisitor Hale: told by Vigil'
        ]);
        expect((await know({ action: 'what_knows', knowerId: 'vigil' })).facts[0].key).toBe('ithraes');
    });

    it('a fact with an effect applies it to each knower and removes it when they forget', async () => {
        await know({ action: 'record', key: 'ithraes', statement: "Ithraes is Oszaverek's true name", effectOnKnower: {
            name: 'Holds the true name Ithraes', description: "The collar's disadvantage does not apply to Oszaverek's powers against the one who holds this name",
            mechanics: [{ type: 'custom_trigger', value: 'collar disadvantage lifted', condition: 'powers against Luciel' }]
        } });
        const learn = await know({ action: 'learn', key: 'ithraes', knowerId: 'oszaverek', how: 'position' });
        expect(learn.effect).toBe('applied Holds the true name Ithraes');
        const effects = new CustomEffectsRepository(getDb());
        expect(effects.findByTargetAndName('oszaverek', 'npc', 'Holds the true name Ithraes')).not.toBeNull();
        await know({ action: 'forget', key: 'ithraes', knowerId: 'oszaverek' });
        expect(effects.findByTargetAndName('oszaverek', 'npc', 'Holds the true name Ithraes')).toBeNull();
    });
});

/**
 * Play report 5 #9. `knowers: ['luciel']` came back as a raw Zod dump
 * ("Expected object, received string" at knowers.0) that never said what a
 * knower looks like, and a record whose second knower was refused had already
 * written the fact and the first knower while claiming writes: 'none'.
 */
describe('knowledge record: knower shape errors and atomicity (play report 5 #9)', () => {
    const SHAPE = /each knower is an object \{id, how, fromId\?/;
    const EXAMPLE = /e\.g\. knowers: \[\{id: 'luciel', how: 'witnessed'\}/;

    it('a bare string knower with no road is refused with the shape and an example, and writes nothing', async () => {
        const r = await know({ action: 'record', key: 'ithraes', statement: 'x', knowers: ['luciel'] });
        expect(r.error).toBe(true);
        expect(r.writes).toBe('none');
        expect(r.message).toMatch(SHAPE);
        expect(r.message).toMatch(EXAMPLE);
        expect(r.message).toMatch(/how: 'witnessed'/);
        expect(r.message).not.toMatch(/"code":\s*"invalid_type"/);
        expect(r.message).not.toMatch(/Expected object, received string/);
        expect((await know({ action: 'list' })).count).toBe(0);
    });

    it('a knower object without how is refused naming the road list, never defaulting to witnessed', async () => {
        const r = await know({ action: 'record', key: 'ithraes', statement: 'x', knowers: [{ id: 'luciel' }] });
        expect(r.error).toBe(true);
        expect(r.writes).toBe('none');
        expect(r.message).toMatch(/needs how/);
        expect(r.message).toMatch(/witnessed \| told \| position \| deduced \| read \| rumour/);
        expect((await know({ action: 'list' })).count).toBe(0);
    });

    it('a wrong-typed knower renders path: message lines, not the Zod JSON dump', async () => {
        const r = await know({ action: 'record', key: 'ithraes', statement: 'x', knowers: [42] });
        expect(r.error).toBe(true);
        expect(r.writes).toBe('none');
        expect(r.message).toMatch(/^knowers\.0: /);
        expect(r.message).toMatch(SHAPE);
        expect(r.message).not.toMatch(/"code":/);
        const bad = await know({ action: 'record', key: 'ithraes', statement: 'x', knowers: [{ id: 'luciel', how: 'guessed' }] });
        expect(bad.error).toBe(true);
        expect(bad.message).toMatch(/^knowers\.0\.how: /);
        expect(bad.message).toMatch(/witnessed \| told \| position \| deduced \| read \| rumour/);
        expect(bad.message).not.toMatch(/"code":/);
        expect((await know({ action: 'list' })).count).toBe(0);
    });

    it('bare string knowers take one top-level road for all; told takes the top-level teller', async () => {
        const r = await know({ action: 'record', key: 'ithraes', statement: 'x', knowers: ['luciel', 'vigil'], how: 'position' });
        expect(r.success).toBe(true);
        const who = await know({ action: 'who_knows', key: 'ithraes' });
        expect(who.knowers.map((k: any) => k.road)).toEqual(['Luciel: position', 'Vigil: position']);
        const told = await know({ action: 'record', key: 'quarter', statement: 'y', knowers: [{ id: 'luciel', how: 'witnessed' }, 'vigil', 'inquisitor'], how: 'told', fromId: 'luciel' });
        expect(told.success).toBe(true);
        expect((await know({ action: 'who_knows', key: 'quarter' })).knowers.map((k: any) => k.road)).toEqual(['Luciel: witnessed', 'Vigil: told by Luciel', 'Inquisitor Hale: told by Luciel']);
    });

    it('record is atomic: a refused second knower leaves no fact behind, and the corrected retry succeeds', async () => {
        const before = JSON.stringify(await know({ action: 'list' }));
        const r = await know({ action: 'record', key: 'ithraes', statement: 'x', knowers: [{ id: 'luciel', how: 'witnessed' }, { id: 'vigil', how: 'told' }] });
        expect(r.error).toBe(true);
        expect(r.writes).toBe('none');
        expect(r.message).toMatch(/told needs fromId: who told Vigil\?/);
        expect((await know({ action: 'list' })).count).toBe(0);
        expect(JSON.stringify(await know({ action: 'list' }))).toBe(before);
        // A teller who is not in the list ahead of the one told is refused too, before any write.
        const unknownTeller = await know({ action: 'record', key: 'ithraes', statement: 'x', knowers: [{ id: 'vigil', how: 'told', fromId: 'luciel' }, { id: 'luciel', how: 'witnessed' }] });
        expect(unknownTeller.error).toBe(true);
        expect(unknownTeller.message).toMatch(/Luciel does not know 'ithraes'.*could not have told Vigil/);
        expect((await know({ action: 'list' })).count).toBe(0);
        const retry = await know({ action: 'record', key: 'ithraes', statement: 'x', knowers: [{ id: 'luciel', how: 'witnessed' }, { id: 'vigil', how: 'told', fromId: 'luciel' }] });
        expect(retry.success).toBe(true);
        expect(retry.message).not.toMatch(/already exists/);
        expect((await know({ action: 'who_knows', key: 'ithraes' })).count).toBe(2);
    });

    it('knowers given as one bare string (not an array) is refused with the shape, not "Expected array"', async () => {
        const r = await know({ action: 'record', key: 'ithraes', statement: 'x', knowers: 'luciel', how: 'witnessed' });
        expect(r.error).toBe(true);
        expect(r.writes).toBe('none');
        expect(r.message).toMatch(/^knowers: /);
        expect(r.message).toMatch(SHAPE);
        expect(r.message).toMatch(/knowers: \['luciel', 'vigil'\], how: 'witnessed'/);
        expect(r.message).not.toMatch(/Expected array/);
        expect((await know({ action: 'list' })).count).toBe(0);
    });
});
