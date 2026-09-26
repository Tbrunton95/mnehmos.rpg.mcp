import { handleImprovisationManage } from '../../../src/server/consolidated/improvisation-manage.js';
import { handleCharacterManage } from '../../../src/server/consolidated/character-manage.js';
import { handleNarrativeManage } from '../../../src/server/consolidated/narrative-manage.js';
import { handleSessionManage } from '../../../src/server/consolidated/session-manage.js';
import { handlePrecedentManage } from '../../../src/server/consolidated/precedent-manage.js';
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { handleTableRules } from '../../../src/server/consolidated/table-rules.js';
import { handleLedgerManage } from '../../../src/server/consolidated/ledger-manage.js';
import { clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { summarizeResult, pickFields } from '../../../src/server/output-mode.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const W = 'vorago';
const ctx = { sessionId: 'fb' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const impro = async (a: Record<string, unknown>) => json(await handleImprovisationManage(a, ctx as any));
const WARP = "Warp-sight: Luciel sees the Warp's currents. Costs 1 RESOLVE each scene it is used; the Mouth listens when he looks.";

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Vorago', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 367, time: '06:00' } } as any);
    new CharacterRepository(db).create({
        id: 'luciel', name: 'Luciel', characterType: 'pc', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 }, hp: 180, maxHp: 200, ac: 20, level: 15, band: 'Astartes',
        resourcePools: { corruption: { current: 12, max: 100 } },
        parts: [{ name: 'left wing', kind: 'wing', state: 'crippled' }],
        conditions: [{ name: WARP }, { name: 'Oath of the Ninth: sworn' }],
        createdAt: now, updatedAt: now
    } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare("UPDATE characters SET world_id = ?").run(W);
});
afterEach(() => closeDb());

describe('features as data', () => {
    it('a prose condition becomes a structured feature with trigger and cost, and one clause edits in place', async () => {
        const made = await impro({ action: 'feature_from_condition', characterId: 'luciel', match: 'warp-sight', category: 'boon',
            triggers: [{ event: 'on_spell_cast', condition: 'when he looks into the Warp' }], cost: '1 RESOLVE per scene' });
        expect(made.feature).toMatchObject({ name: 'Warp-sight', description: WARP, cost: '1 RESOLVE per scene' });
        expect(new CharacterRepository(getDb()).findById('luciel')!.conditions!.map(c => c.name)).toEqual(['Oath of the Ninth: sworn']);
        const edited = await impro({ action: 'edit_effect', effectId: made.effectId, descriptionReplace: { find: 'the Mouth listens', with: 'the Mouth answers' }, cost: '2 RESOLVE per scene' });
        expect(edited.changed).toEqual(['descriptionReplace', 'cost']);
        expect(edited.effect.description).toMatch(/the Mouth answers when he looks/);
        expect(edited.effect.cost).toBe('2 RESOLVE per scene');
    });

    it('refuses an ambiguous match or a clause that is not there, writing nothing', async () => {
        expect((await impro({ action: 'feature_from_condition', characterId: 'luciel', match: 'o' })).message).toMatch(/matches 2 conditions/);
        const made = await impro({ action: 'feature_from_condition', characterId: 'luciel', match: 'oath' });
        expect((await impro({ action: 'edit_effect', effectId: made.effectId, descriptionReplace: { find: 'broken', with: 'x' } })).message).toMatch(/is not in the effect's text/);
    });
});

describe('boot packet', () => {
    it('hands over what to read before play in one call', async () => {
        await handleTableRules({ action: 'import', worldId: W, preset: 'day-366' }, ctx as any);
        await handleTableRules({ action: 'define', worldId: W, kind: 'status_block', name: 'tiny-status', spec: { corePool: 'corruption' } }, ctx as any);
        await impro({ action: 'feature_from_condition', characterId: 'luciel', match: 'warp-sight', triggers: [{ event: 'on_spell_cast', condition: 'when he looks' }], cost: '1 RESOLVE per scene' });
        await handlePrecedentManage({ action: 'record', worldId: W, kind: 'ruling', statement: "Flight is the Warp's, not the air's", scope: 'flight' }, ctx as any);
        await handleLedgerManage({ action: 'create', worldId: W, debtor: 'Luciel', creditor: 'the Blood God', amount: 1, currency: 'skull ', dueDay: 367, consequence: 'the claim comes due' }, ctx as any);
        const enc = json(await handleCombatManage({ action: 'create', worldId: W, participants: [
            { id: 'luciel', name: 'Luciel', hp: 180, maxHp: 200, initiative: 20 },
            { id: 'angrath', name: "An'ggrath", hp: 900, maxHp: 900, initiative: 10, isEnemy: true }
        ] }, ctx as any)).encounterId;
        await handleCombatManage({ action: 'set_intent', encounterId: enc, participantId: 'angrath', intent: 'closes the thirty metres and takes the wing' }, ctx as any);

        const res = await handleSessionManage({ action: 'boot', worldId: W }, ctx as any);
        const text = res.content[0].text;
        const p = json(res);
        expect(p.whatsNew?.length).toBeGreaterThan(0);
        expect(p.tableRules.enforced.length).toBeGreaterThan(0);
        expect(p.characters[0]).toMatchObject({ name: 'Luciel', hp: '180/200', band: 'Astartes', corruption: '12/100', parts: ['left wing: crippled'] });
        expect(p.characters[0].features[0]).toMatchObject({ name: 'Warp-sight', engine: 'reminder', cost: '1 RESOLVE per scene' });
        expect(p.clocks.some((c: any) => c.kind === 'debt' && /the Blood God/.test(c.what))).toBe(true);
        expect(p.telegraphs[0]).toMatchObject({ name: "An'ggrath", intent: 'closes the thirty metres and takes the wing' });
        expect(p.precedents[0].statement).toMatch(/Flight is the Warp's/);
        expect(text).toMatch(/◇ Warp-sight \[on_spell_cast \(when he looks\)\] cost: 1 RESOLVE per scene/);
    });
});

describe('boot threads', () => {
    it('show the head of a grown thread and its latest section, never an archive', async () => {
        const nm = async (a: Record<string, unknown>) => json(await handleNarrativeManage(a, ctx as any));
        const { noteId } = await nm({ action: 'add', worldId: W, type: 'plot_thread', content: 'The Vaurek quarters.\nFour pieces, scattered by the Mouth.' });
        await nm({ action: 'append', noteId, day: 360, content: 'First quarter found under the Brass Gate.' });
        await nm({ action: 'append', noteId, day: 366, content: 'Second quarter taken from the Ithraes vault.' });
        const t = json(await handleSessionManage({ action: 'boot', worldId: W }, ctx as any)).threads;
        expect(t).toHaveLength(1);
        expect(t[0].text).toBe('The Vaurek quarters. … latest [Day 366]: Second quarter taken from the Ithraes vault.');
        expect(t[0].long).toBeUndefined();

        await nm({ action: 'append', noteId, day: 367, content: 'z'.repeat(8000) });
        await nm({ action: 'archive', noteId, keepLast: 1 });
        const again = json(await handleSessionManage({ action: 'boot', worldId: W }, ctx as any)).threads;
        expect(again).toHaveLength(1);
        expect(again[0]).toMatchObject({ id: noteId, long: true });
        expect(again[0].chars).toBeGreaterThan(8000);
        expect(again[0].text).toMatch(/^The Vaurek quarters\. … latest \[Day 367\]: z+…$/);
    });

    it('a thread with no sections keeps its first 160 chars', async () => {
        await handleNarrativeManage({ action: 'add', worldId: W, type: 'plot_thread', content: 'The Oath of the Ninth binds Luciel.' }, ctx as any);
        expect(json(await handleSessionManage({ action: 'boot', worldId: W }, ctx as any)).threads[0].text).toBe('The Oath of the Ninth binds Luciel.');
    });
});

describe('field selection', () => {
    it('keeps only the named fields plus the essentials', () => {
        expect(pickFields({ success: true, actionType: 'get', hp: 5, conditions: [1, 2], name: 'x' }, ['hp'])).toEqual({ success: true, actionType: 'get', hp: 5 });
        expect(summarizeResult({ big: 'x'.repeat(400) }).big).toMatch(/400 chars/);
    });

    it('a dotted field projects into each element of a list, or into an object', () => {
        const sheet = { success: true, hp: 5, conditions: [{ name: 'A', source: 'x'.repeat(900) }, { name: 'B', pinned: true, source: 'y' }], combat: { reach: 10, size: 'huge' } };
        expect(pickFields(sheet, ['conditions.name', 'conditions.pinned'])).toEqual({ success: true, conditions: [{ name: 'A' }, { name: 'B', pinned: true }] });
        expect(pickFields(sheet, ['combat.size', 'hp'])).toEqual({ success: true, hp: 5, combat: { size: 'huge' } });
        // An undotted name still takes the whole value.
        expect(pickFields(sheet, ['combat'])).toEqual({ success: true, combat: { reach: 10, size: 'huge' } });
    });

    it('get carries the condition names, so fields:[conditionNames] is the index', async () => {
        const got = json(await handleCharacterManage({ action: 'get', characterId: 'luciel' }, ctx as any));
        expect(got.conditionNames).toEqual([WARP, 'Oath of the Ninth: sworn']);
    });
});
