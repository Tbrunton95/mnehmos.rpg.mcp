/**
 * Play report 7 #2 and #4: ad-hoc tokens carry the numbers the GM gives them.
 *
 * #2: a hound built by hand with stats {str: 15} used to land with no ability
 * scores at all (the participant schema never declared them, and the strip
 * dropped them in silence), so its grapple contest and saves read STR 10.
 * create participants[] and add_participant now take stats (short keys) and
 * abilityScores (long or short); missing scores are 10, an unknown key is
 * refused with the six valid keys, the two disagreeing is refused, a
 * sheet-backed token keeps its sheet (with a warning), initiativeBonus comes
 * from DEX when omitted, and a participant key create does not take is named
 * as a dotted path in ignoredParams.
 *
 * #4: add_participant takes the caller's token id ('hound-1'), refusing one
 * already in the fight, LAIR, or a character row's id without that
 * characterId; a creature count numbers them id-1 … id-n; a characterId
 * already in the fight is refused instead of doubling.
 */
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { CombatEngine } from '../../../src/engine/combat/engine.js';
import { EncounterRepository } from '../../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'ad-hoc-tokens' };
const embedded = (res: any, tag: string) => {
    const m = res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : { rawText: res.content[0].text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const manageText = async (args: Record<string, unknown>) => (await handleCombatManage(args, ctx as any)).content[0].text;
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');
const encounters = () => (getDb().prepare('SELECT COUNT(*) AS n FROM encounters').get() as { n: number }).n;
const tokens = (encounterId: string) => new EncounterRepository(getDb()).loadState(encounterId)!.participants as any[];
const tok = (encounterId: string, id: string) => tokens(encounterId).find(t => t.id === id);
const TEN = { strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 };
const now = () => new Date().toISOString();
const sheet = (id: string, name: string, stats: Record<string, number>, extra: Record<string, unknown> = {}) =>
    new CharacterRepository(getDb()).create({ id, name, stats, hp: 30, maxHp: 30, ac: 14, level: 3, createdAt: now(), updatedAt: now(), ...extra } as any);

const gor = { id: 'gor', name: 'Gor', hp: 40, maxHp: 40, initiative: 20 };

beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('stats and abilityScores on ad-hoc tokens (play report 7 #2)', () => {
    it('create takes stats with short keys: the given score lands, the rest are 10, the reply echoes them', async () => {
        const created = await manage({ action: 'create', seed: 'hounds', participants: [
            gor,
            { id: 'hound-1', name: 'Hound 1', hp: 11, maxHp: 11, initiative: 5, isEnemy: true, stats: { str: 15 } }
        ] });
        expect(created.error).toBeFalsy();
        expect(tok(created.encounterId, 'hound-1').abilityScores).toEqual({ ...TEN, strength: 15 });
        expect(created.ignoredParams).toBeUndefined();
        expect(created.participants.find((p: any) => p.id === 'hound-1').abilityScores).toEqual({ ...TEN, strength: 15 });
    });

    it('abilityScores takes long or short keys in any case; initiativeBonus comes from DEX when omitted, and a given one wins', async () => {
        const created = await manage({ action: 'create', seed: 'scores', participants: [
            gor,
            { id: 'a', name: 'Alpha', hp: 10, maxHp: 10, isEnemy: true, abilityScores: { Strength: 14, DEX: 16 } },
            { id: 'b', name: 'Beta', hp: 10, maxHp: 10, isEnemy: true, abilityScores: { dexterity: 16 }, initiativeBonus: 0 }
        ] });
        expect(created.error).toBeFalsy();
        const a = tok(created.encounterId, 'a'), b = tok(created.encounterId, 'b');
        expect(a.abilityScores).toEqual({ ...TEN, strength: 14, dexterity: 16 });
        expect(a.initiativeBonus).toBe(3);
        expect(b.initiativeBonus).toBe(0);
    });

    it('an unknown ability key is refused before anything is written, naming the six', async () => {
        const before = encounters();
        const res = await manage({ action: 'create', participants: [gor, { id: 'h', name: 'Hound', hp: 11, maxHp: 11, stats: { agi: 14 } }] });
        expect(res.error).toBe(true);
        expect(res.writes).toBe('none');
        expect(res.message).toMatch(/agi/);
        expect(res.message).toMatch(/str, dex, con, int, wis, cha/);
        expect(encounters()).toBe(before);
    });

    it('stats and abilityScores that disagree are refused; agreeing ones merge', async () => {
        const before = encounters();
        const clash = await manage({ action: 'create', participants: [gor, { id: 'h', name: 'Hound', hp: 11, maxHp: 11, stats: { str: 15 }, abilityScores: { strength: 13 } }] });
        expect(clash.error).toBe(true);
        expect(clash.writes).toBe('none');
        expect(clash.message).toMatch(/str.*15.*13|strength/i);
        expect(encounters()).toBe(before);
        const agree = await manage({ action: 'create', participants: [gor, { id: 'h', name: 'Hound', hp: 11, maxHp: 11, stats: { str: 15 }, abilityScores: { strength: 15, wis: 12 } }] });
        expect(agree.error).toBeFalsy();
        expect(tok(agree.encounterId, 'h').abilityScores).toEqual({ ...TEN, strength: 15, wisdom: 12 });
    });

    it('a sheet-backed participant keeps its sheet: the caller scores are not written and a warning names character_manage update', async () => {
        sheet('kael', 'Kael', { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 });
        const created = await manage({ action: 'create', participants: [{ id: 'kael', name: 'Kael', hp: 30, maxHp: 30, initiative: 15, stats: { str: 8 } }, gor] });
        expect(created.error).toBeFalsy();
        expect(tok(created.encounterId, 'kael').abilityScores).toBeUndefined();
        expect(created.warnings.join(' ')).toMatch(/Kael.*sheet.*character_manage update/);
    });

    it('a participant key create does not take is named as a dotted path, merged with any top-level key', async () => {
        const created = await manage({ action: 'create', bogus: 1, participants: [
            gor,
            { id: 'h', name: 'Hound', hp: 11, maxHp: 11, str: 15, speed: 40 }
        ] });
        expect(created.error).toBeFalsy();
        expect(created.ignoredParams).toEqual(expect.arrayContaining(['participants[1].str', 'participants[1].speed', 'bogus']));
        expect(created.message).toMatch(/participants\[1\]\.str — an ability score: pass stats: \{str: …\}/);
        expect(created.message).toMatch(/participants\[1\]\.speed — nearest valid key 'movementSpeed'/);
        // The keys did nothing: no scores, the default speed.
        expect(tok(created.encounterId, 'h').abilityScores).toBeUndefined();
        expect(tok(created.encounterId, 'h').movementSpeed).toBe(30);
        // The banner shows the note even though create prints rawText.
        const text = await manageText({ action: 'create', participants: [gor, { id: 'h2', name: 'Hound', hp: 11, maxHp: 11, str: 15 }] });
        expect(text).toMatch(/Ignored params/);
    });

    it('add_participant takes stats and abilityScores on an ad-hoc token, with DEX initiative', async () => {
        const { encounterId } = await manage({ action: 'create', seed: 'join', participants: [gor] });
        const res = await manage({ action: 'add_participant', encounterId, name: 'Hound', hp: 11, maxHp: 11, isEnemy: true, stats: { str: 15, dex: 14 } });
        expect(res.error).toBeFalsy();
        expect(res.ignoredParams).toBeUndefined();
        const hound = tokens(encounterId).find(t => t.name === 'Hound');
        expect(hound.abilityScores).toEqual({ ...TEN, strength: 15, dexterity: 14 });
        expect(hound.initiativeBonus).toBe(2);
        expect(res.participant.abilityScores).toEqual({ ...TEN, strength: 15, dexterity: 14 });
        const bad = await manage({ action: 'add_participant', encounterId, name: 'Hound', hp: 11, maxHp: 11, abilityScores: { luck: 3 } });
        expect(bad).toMatchObject({ error: true, writes: 'none' });
        expect(tokens(encounterId)).toHaveLength(2);
    });

    // Review: the nested key taught "pass stats: {str: …}", the same key at the
    // top of add_participant said "no close match" and left the GM guessing.
    it('add_participant names a top-level ability key the way create names a nested one', async () => {
        const { encounterId } = await manage({ action: 'create', seed: 'join', participants: [gor] });
        const res = await manage({ action: 'add_participant', encounterId, name: 'Hound', hp: 11, maxHp: 11, str: 15, Dexterity: 14, speed: 40 });
        expect(res.error).toBeFalsy();
        expect(res.ignoredParams).toEqual(['str', 'Dexterity', 'speed']);
        expect(res.message).toMatch(/str — an ability score: pass stats: \{str: …\}/);
        expect(res.message).toMatch(/Dexterity — an ability score: pass stats: \{dex: …\}/);
        expect(res.message).toMatch(/speed — nearest valid key 'movementSpeed'/);
        expect(tokens(encounterId).find(t => t.name === 'Hound').abilityScores).toBeUndefined();
    });

    it('add_participant on a creature overrides only the scores given; on a characterId the sheet wins with a warning', async () => {
        const { encounterId } = await manage({ action: 'create', seed: 'join', participants: [gor] });
        const wolf = await manage({ action: 'add_participant', encounterId, creature: 'wolf', stats: { str: 18 } });
        expect(wolf.error).toBeFalsy();
        const w = tokens(encounterId).find(t => t.name === 'Wolf');
        expect(w.abilityScores.strength).toBe(18);
        expect(w.abilityScores.dexterity).toBe(15);
        sheet('mira', 'Mira', { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 });
        const mira = await manage({ action: 'add_participant', encounterId, characterId: 'mira', stats: { dex: 8 } });
        expect(mira.error).toBeFalsy();
        expect(tok(encounterId, 'mira').abilityScores).toBeUndefined();
        expect(mira.warnings.join(' ')).toMatch(/Mira.*sheet.*character_manage update/);
    });

    // Review (lanes A and B merged): lane A's tests patched abilityScores onto
    // the saved token; this is the real road, stats at create.
    it('a unit built with stats {dex: 13} and unit.saves {dex: 2} saves model by model at +3', async () => {
        const created = await manage({ action: 'create', seed: 'unit-stats', participants: [
            gor,
            { id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, ac: 11, stats: { dex: 13 }, unit: { models: 6, hpPerModel: 9, packed: true, saves: { dex: 2 } } }
        ] });
        expect(tok(created.encounterId, 'militia').abilityScores.dexterity).toBe(13);
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        for (let i = 0; i < 6; i++) spy.mockReturnValueOnce(10);
        const res = await manage({ action: 'apply_damage', encounterId: created.encounterId, targetIds: ['militia'], dice: 12, source: 'breath', area: true, save: { ability: 'dex', dc: 13 } });
        expect(res.error).toBeFalsy();
        expect(res.targets[0].unitArea).toMatchObject({ saved: 6, failed: 0, saveBonus: { ability: 'dexterity', total: 3 } });
    });

    it('hounds built with stats {str: 15} contest a grapple at +2, not +0', async () => {
        const created = await manage({ action: 'create', seed: 'grapple-hounds', participants: [
            { id: 'hound', name: 'Hound', hp: 11, maxHp: 11, initiative: 20, isEnemy: true, stats: { str: 15 } },
            { id: 'mira', name: 'Mira', hp: 20, maxHp: 20, initiative: 5 }
        ] });
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        spy.mockReturnValueOnce(10).mockReturnValueOnce(10);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId: created.encounterId, actorId: 'hound', targetId: 'mira' });
        expect(res.error).toBeFalsy();
        expect(res.breakdown).toMatch(/^Hound d20\(10\)\+2stat/);
        expect(res.hit).toBe(true);
    });
});

// Review (lanes B and C merged): combat_manage prints reply warnings as
// alerts; set_subdue already puts its warning in message, so the banner
// printed the same warning twice.
describe('reply warnings print once in the banner', () => {
    it('set_subdue on a token holding a ranged readied shot shows its warning once', async () => {
        const created = await manage({ action: 'create', seed: 'once', participants: [
            { ...gor, initiative: 20, position: { x: 0, y: 0 }, attacks: [{ name: 'crossbow', attackBonus: 5, damage: '1d8', damageType: 'piercing', ranged: true }] },
            { id: 'bandit', name: 'Bandit', hp: 5, maxHp: 5, initiative: 10, isEnemy: true, position: { x: 4, y: 0 } }
        ] });
        const encounterId = created.encounterId;
        const ready = await act({ action: 'ready', encounterId, actorId: 'gor', readiedAction: 'shoot the runner', trigger: 'he runs', on: 'enters_reach', watch: 'bandit', attack: { using: 'crossbow' } });
        expect(ready.error).toBeFalsy();
        const text = await manageText({ action: 'set_subdue', encounterId, participantId: 'gor', subdue: true });
        const banner = text.split('<!--')[0];
        expect(banner.match(/already holds a readied ranged shot/g)).toHaveLength(1);
    });
});

describe('caller ids on add_participant (play report 7 #4)', () => {
    const fight = async () => (await manage({ action: 'create', seed: 'ids', participants: [gor] })).encounterId as string;

    it("id: 'hound-1' names the token, and later calls reach it by that id", async () => {
        const encounterId = await fight();
        const res = await manage({ action: 'add_participant', encounterId, id: 'hound-1', name: 'Hound 1', hp: 11, maxHp: 11, isEnemy: true });
        expect(res.error).toBeFalsy();
        expect(res.ignoredParams).toBeUndefined();
        expect(res.participant.id).toBe('hound-1');
        expect(tok(encounterId, 'hound-1')).toBeTruthy();
        const hurt = await manage({ action: 'adjust_hp', encounterId, participantId: 'hound-1', delta: -3, reason: 'bitten' });
        expect(hurt.error).toBeFalsy();
        expect(tok(encounterId, 'hound-1').hp).toBe(8);
    });

    it('an id already in the fight, LAIR, or a bad shape is refused with nothing written', async () => {
        const encounterId = await fight();
        await manage({ action: 'add_participant', encounterId, id: 'hound-1', name: 'Hound 1', hp: 11, maxHp: 11 });
        const again = await manage({ action: 'add_participant', encounterId, id: 'hound-1', name: 'Hound 2', hp: 11, maxHp: 11 });
        expect(again).toMatchObject({ error: true, writes: 'none' });
        expect(again.message).toMatch(/hound-1.*already in this encounter.*Hound 1/);
        expect(tokens(encounterId)).toHaveLength(2);
        const gorAgain = await manage({ action: 'add_participant', encounterId, id: 'gor', name: 'Gor II', hp: 11, maxHp: 11 });
        expect(gorAgain).toMatchObject({ error: true, writes: 'none' });
        const lair = await manage({ action: 'add_participant', encounterId, id: 'LAIR', name: 'Lair', hp: 1, maxHp: 1 });
        expect(lair).toMatchObject({ error: true, writes: 'none' });
        expect(lair.message).toMatch(/LAIR/);
        const bad = await manage({ action: 'add_participant', encounterId, id: 'hound 3!', name: 'Hound 3', hp: 11, maxHp: 11 });
        expect(bad.error).toBeTruthy();
        expect(tokens(encounterId)).toHaveLength(2);
    });

    it("a character row's id needs characterId; characterId with a different id is refused", async () => {
        sheet('kael', 'Kael', { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 });
        const encounterId = await fight();
        const borrowed = await manage({ action: 'add_participant', encounterId, id: 'kael', name: 'Not Kael', hp: 5, maxHp: 5 });
        expect(borrowed).toMatchObject({ error: true, writes: 'none' });
        expect(borrowed.message).toMatch(/characterId: 'kael'/);
        const other = await manage({ action: 'add_participant', encounterId, characterId: 'kael', id: 'kael-2' });
        expect(other).toMatchObject({ error: true, writes: 'none' });
        const same = await manage({ action: 'add_participant', encounterId, characterId: 'kael', id: 'kael' });
        expect(same.error).toBeFalsy();
        expect(tok(encounterId, 'kael')).toBeTruthy();
    });

    it('a characterId already in the fight is refused instead of doubling the token', async () => {
        sheet('kael', 'Kael', { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 });
        const encounterId = await fight();
        expect((await manage({ action: 'add_participant', encounterId, characterId: 'kael' })).error).toBeFalsy();
        const twice = await manage({ action: 'add_participant', encounterId, characterId: 'kael' });
        expect(twice).toMatchObject({ error: true, writes: 'none' });
        expect(twice.message).toMatch(/kael.*already in this encounter/i);
        expect(tokens(encounterId).filter(t => t.id === 'kael')).toHaveLength(1);
    });

    it('a creature count numbers the id: rat-1 … rat-3; a collision on any refuses them all', async () => {
        const encounterId = await fight();
        const rats = await manage({ action: 'add_participant', encounterId, creature: 'giant_rat', count: 3, id: 'rat' });
        expect(rats.error).toBeFalsy();
        expect(rats.participants.map((p: any) => p.id)).toEqual(['rat-1', 'rat-2', 'rat-3']);
        const one = await manage({ action: 'add_participant', encounterId, creature: 'giant_rat', id: 'big-rat' });
        expect(one.participant.id).toBe('big-rat');
        const clash = await manage({ action: 'add_participant', encounterId, creature: 'giant_rat', count: 2, id: 'rat' });
        expect(clash).toMatchObject({ error: true, writes: 'none' });
        expect(tokens(encounterId)).toHaveLength(5);
    });

    it('create refuses two participants with one id, or a participant named LAIR, before anything is written', async () => {
        const before = encounters();
        const dup = await manage({ action: 'create', participants: [gor, { id: 'gor', name: 'Gor Twin', hp: 10, maxHp: 10 }] });
        expect(dup).toMatchObject({ error: true, writes: 'none' });
        expect(dup.message).toMatch(/gor/);
        const lair = await manage({ action: 'create', participants: [gor, { id: 'LAIR', name: 'Lair', hp: 1, maxHp: 1 }] });
        expect(lair).toMatchObject({ error: true, writes: 'none' });
        expect(encounters()).toBe(before);
    });
});
