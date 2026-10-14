/**
 * Play report 7 #3: a banded world meets an ad-hoc token with no band.
 *
 * Day 89: the hounds were made by hand with no band, the engine said nothing
 * at create, and refused the execute in the middle of the fight after the
 * player had pinned one on the strength of it. The owner's ruling: a token
 * gets a band the moment it is created. An explicit band wins; a sheet, a
 * bestiary creature or a preset passes its own on; with nothing to go on the
 * token takes the world's lowest band, marked assumed, and the reply names
 * every assumed token. Any band-dependent line against an assumed token says
 * "(band assumed)". A world can opt in to refusal (band spec requireBand),
 * and set_band changes a token's band mid-fight, before the next roll.
 * The engine never infers a band from HP, CR or size.
 */
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../../src/server/consolidated/combat-action.js';
import { handleTableRules } from '../../../src/server/consolidated/table-rules.js';
import { clearCombatState, getOrLoadEngine } from '../../../src/server/handlers/combat-handlers.js';
import { creditKill } from '../../../src/server/growth.js';
import { shapeReply } from '../../../src/server/output-mode.js';
import { EncounterRepository } from '../../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { CombatEngine } from '../../../src/engine/combat/engine.js';

process.env.NODE_ENV = 'test';

const W = 'blackcrown';
const ORDER = 'Mortal < Elite Mortal < Astartes < Astartes Elite < Monster/Lord < Primarch-class';
const ctx = { sessionId: 'band-assumed' };
const embedded = (res: any, tag: string) => {
    const m = res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : { rawText: res.content[0].text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const manageText = async (args: Record<string, unknown>) => (await handleCombatManage(args, ctx as any)).content[0].text as string;
const actText = async (args: Record<string, unknown>) => (await handleCombatAction(args, ctx as any)).content[0].text as string;
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');
const rules = async (args: Record<string, unknown>) => handleTableRules({ worldId: W, ...args }, ctx as any);
const encounters = () => (getDb().prepare('SELECT COUNT(*) AS n FROM encounters').get() as { n: number }).n;
const tokens = (encounterId: string) => new EncounterRepository(getDb()).loadState(encounterId)!.participants as any[];
const tok = (encounterId: string, id: string) => tokens(encounterId).find(t => t.id === id);
const now = () => new Date().toISOString();

const gor = { id: 'gor', name: 'Gor', hp: 60, maxHp: 60, initiative: 20, band: 'Astartes', attacksPerAction: 3, position: { x: 0, y: 0 } };
const hound = (n: number, extra: Record<string, unknown> = {}) => ({ id: `hound-${n}`, name: `Hound ${n}`, hp: 11, maxHp: 11, initiative: 5 - n, isEnemy: true, position: { x: n, y: 0 }, ...extra });

function world(withRules = true) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now(), updatedAt: now() } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    return withRules ? rules({ action: 'import', preset: 'day-366' }) : Promise.resolve();
}

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('a band at create (play report 7 #3)', () => {
    beforeEach(() => world());

    it('an explicit band wins, a sheet passes its own on, and a token with nothing to go on takes the lowest, assumed and named', async () => {
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'varek', name: 'Varek', stats: { str: 18, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, hp: 80, maxHp: 80, ac: 17, level: 9, band: 'Astartes Elite', createdAt: now(), updatedAt: now() } as any);
        const created = await manage({ action: 'create', worldId: W, seed: 'day-89', participants: [
            gor, { id: 'varek', name: 'Varek', hp: 80, maxHp: 80, initiative: 18 }, hound(1), hound(2), hound(3)
        ] });
        expect(created.error).toBeFalsy();
        const enc = created.encounterId;
        expect(tok(enc, 'gor')).toMatchObject({ band: 'Astartes' });
        expect(tok(enc, 'gor').bandAssumed).toBeUndefined();
        expect(tok(enc, 'varek')).toMatchObject({ band: 'Astartes Elite' });
        expect(tok(enc, 'varek').bandAssumed).toBeUndefined();
        for (const n of [1, 2, 3]) expect(tok(enc, `hound-${n}`)).toMatchObject({ band: 'Mortal', bandAssumed: true });
        expect(created.bandAssumed).toEqual([
            { id: 'hound-1', name: 'Hound 1', band: 'Mortal' },
            { id: 'hound-2', name: 'Hound 2', band: 'Mortal' },
            { id: 'hound-3', name: 'Hound 3', band: 'Mortal' }
        ]);
        const warning = created.warnings.join('\n');
        expect(warning).toContain("3 tokens have no band; assumed Mortal: Hound ×3. Set band if they're stronger");
        expect(warning).toContain(`combat_manage set_band {encounterId: '${enc}'`);
        expect(warning).toContain(ORDER);
        // The state JSON and the banner carry it too.
        expect(created.participants.find((p: any) => p.id === 'hound-1')).toMatchObject({ band: 'Mortal', bandAssumed: true });
        const text = await manageText({ action: 'get', encounterId: enc });
        expect(text).toMatch(/Hound 1[\s\S]*band Mortal \(assumed\)/);
    });

    it("output_mode 'summary' keeps every assumed row with its band, and the warning", async () => {
        const res = await handleCombatManage({ action: 'create', worldId: W, participants: [gor, ...Array.from({ length: 12 }, (_, i) => hound(i + 1))] }, ctx as any);
        const summary = JSON.parse(shapeReply(res as any, { mode: 'summary' }).content![0].text);
        expect(summary.bandAssumed).toHaveLength(12);
        expect(summary.bandAssumed[11]).toEqual({ id: 'hound-12', name: 'Hound 12', band: 'Mortal' });
        expect(summary.warnings[0]).toMatch(/^12 tokens have no band; assumed Mortal: Hound ×12\./);
    });

    it('the create banner prints the warning', async () => {
        const text = await manageText({ action: 'create', worldId: W, participants: [gor, hound(1)] });
        expect(text).toMatch(/1 token has no band; assumed Mortal: Hound 1/);
    });

    it('a sheet with no band is not assumed (a named character is never guessed) but is named', async () => {
        new CharacterRepository(getDb()).create({ id: 'karl', name: 'Karl', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 10, level: 1, createdAt: now(), updatedAt: now() } as any);
        const created = await manage({ action: 'create', worldId: W, participants: [gor, { id: 'karl', name: 'Karl', hp: 10, maxHp: 10, initiative: 3 }] });
        expect(tok(created.encounterId, 'karl').band).toBeUndefined();
        expect(created.bandAssumed).toBeUndefined();
        expect(created.warnings.join(' ')).toMatch(/Karl has no band on the sheet.*character_manage update \{characterId: 'karl', band/);
    });

    it('add_participant assigns the same: ad hoc assumed; a bestiary creature brings its band; a preset without one is assumed', async () => {
        await rules({ action: 'define', kind: 'creature', name: 'Gor Brute', spec: { hp: 30, ac: 14, band: 'Elite Mortal' } });
        const { encounterId } = await manage({ action: 'create', worldId: W, participants: [gor] });
        const adHoc = await manage({ action: 'add_participant', encounterId, id: 'bitch', name: 'The Bitch', hp: 14, maxHp: 14, isEnemy: true });
        expect(adHoc.error).toBeFalsy();
        expect(tok(encounterId, 'bitch')).toMatchObject({ band: 'Mortal', bandAssumed: true });
        expect(adHoc.bandAssumed).toEqual([{ id: 'bitch', name: 'The Bitch', band: 'Mortal' }]);
        expect(adHoc.warnings.join(' ')).toMatch(/1 token has no band; assumed Mortal: The Bitch/);
        const brute = await manage({ action: 'add_participant', encounterId, creature: 'Gor Brute', id: 'brute' });
        expect(tok(encounterId, 'brute')).toMatchObject({ band: 'Elite Mortal' });
        expect(tok(encounterId, 'brute').bandAssumed).toBeUndefined();
        expect(brute.bandAssumed).toBeUndefined();
        const wolves = await manage({ action: 'add_participant', encounterId, creature: 'wolf', count: 2, id: 'wolf' });
        expect(tok(encounterId, 'wolf-1')).toMatchObject({ band: 'Mortal', bandAssumed: true });
        expect(wolves.warnings.join(' ')).toMatch(/2 tokens have no band; assumed Mortal: Wolf ×2/);
    });

    it('spawn_quick_enemy assumes for a preset with no band, new fight or appended', async () => {
        const spawned = await manage({ action: 'spawn_quick_enemy', creature: 'wolf', count: 2, worldId: W, seed: 'spawn' });
        expect(spawned.error).toBeFalsy();
        for (const e of spawned.enemies) expect(tok(spawned.encounterId, e.id)).toMatchObject({ band: 'Mortal', bandAssumed: true });
        expect(spawned.warnings.join(' ')).toMatch(/2 tokens have no band; assumed Mortal/);
        const more = await manage({ action: 'spawn_quick_enemy', creature: 'goblin', encounterId: spawned.encounterId });
        expect(tok(spawned.encounterId, more.enemies[0].id)).toMatchObject({ band: 'Mortal', bandAssumed: true });
        expect(more.warnings.join(' ')).toMatch(/assumed Mortal/);
    });

    it('requireBand: true makes create and add_participant refuse an unbanded ad-hoc token, naming the fix', async () => {
        await rules({ action: 'define', kind: 'band', name: 'bands', spec: { order: ORDER.split(' < '), requireBand: true } });
        const before = encounters();
        const refused = await manage({ action: 'create', worldId: W, participants: [gor, hound(1), hound(2)] });
        expect(refused).toMatchObject({ error: true, writes: 'none' });
        expect(refused.message).toMatch(/requireBand/);
        expect(refused.message).toMatch(/Hound 1, Hound 2/);
        expect(refused.message).toContain(ORDER);
        expect(encounters()).toBe(before);
        const { encounterId } = await manage({ action: 'create', worldId: W, participants: [gor, hound(1, { band: 'Mortal' })] });
        expect(encounterId).toBeTruthy();
        const join = await manage({ action: 'add_participant', encounterId, name: 'Stray', hp: 5, maxHp: 5 });
        expect(join).toMatchObject({ error: true, writes: 'none' });
        expect(tokens(encounterId)).toHaveLength(2);
        // Review: spawn_quick_enemy refuses too, a new fight and an append alike.
        const before2 = encounters();
        const spawnNew = await manage({ action: 'spawn_quick_enemy', creature: 'wolf', worldId: W });
        expect(spawnNew).toMatchObject({ error: true, writes: 'none' });
        expect(spawnNew.message).toMatch(/band rule 'bands' requireBand: true/);
        expect(encounters()).toBe(before2);
        const spawnInto = await manage({ action: 'spawn_quick_enemy', creature: 'wolf', encounterId });
        expect(spawnInto).toMatchObject({ error: true, writes: 'none' });
        expect(tokens(encounterId)).toHaveLength(2);
    });

    // Review: an explicit band on no ladder ('Mortel') is never ranked; the
    // execute refused mid-fight. The create reply names it, before play.
    it('an explicit band on none of the world ladders is named at create and add_participant, with set_band', async () => {
        const created = await manage({ action: 'create', worldId: W, participants: [gor, hound(1, { band: 'Mortel' })] });
        expect(created.error).toBeFalsy();
        expect(tok(created.encounterId, 'hound-1')).toMatchObject({ band: 'Mortel' });
        expect(tok(created.encounterId, 'hound-1').bandAssumed).toBeUndefined();
        const warning = created.warnings.join('\n');
        expect(warning).toContain("Hound 1's band 'Mortel' is on none of this world's band ladders");
        expect(warning).toContain(`combat_manage set_band {encounterId: '${created.encounterId}', participantId: 'hound-1', band: '<band>'}`);
        expect(warning).toContain(ORDER);
        const join = await manage({ action: 'add_participant', encounterId: created.encounterId, id: 'pup', name: 'Pup', hp: 3, maxHp: 3, band: 'astartes' });
        expect(join.warnings).toBeUndefined();
        const bad = await manage({ action: 'add_participant', encounterId: created.encounterId, id: 'cur', name: 'Cur', hp: 3, maxHp: 3, band: 'Dog' });
        expect(bad.warnings.join(' ')).toContain("Cur's band 'Dog' is on none of this world's band ladders");
    });

    it('a world with no band rule, or no world at all, assumes nothing', async () => {
        await world(false);
        const unbanded = await manage({ action: 'create', worldId: W, participants: [gor, hound(1)] });
        expect(tok(unbanded.encounterId, 'hound-1').band).toBeUndefined();
        expect(unbanded.bandAssumed).toBeUndefined();
        expect(unbanded.warnings).toBeUndefined();
        closeDb(); getDb(':memory:'); clearCombatState();
        const nowhere = await manage({ action: 'create', participants: [gor, hound(1)] });
        expect(tok(nowhere.encounterId, 'hound-1').band).toBeUndefined();
    });
});

describe('band-dependent lines against an assumed token print "(band assumed)"', () => {
    let enc: string;
    beforeEach(async () => {
        await world();
        const created = await manage({ action: 'create', worldId: W, seed: 'assumed-lines', participants: [
            gor,
            hound(1, { conditions: [{ name: 'restrained', source: 'grapple: gor' }] }),
            hound(2),
            { id: 'mob', name: 'Militia', hp: 36, maxHp: 36, initiative: 1, isEnemy: true, position: { x: 1, y: 1 }, unit: { models: 4, hpPerModel: 9, packed: true } }
        ] });
        enc = created.encounterId;
    });

    it('execute on a pinned assumed hound works and says the band was assumed', async () => {
        const res = await act({ action: 'grapple', move: 'execute', encounterId: enc, actorId: 'gor', targetId: 'hound-1' });
        expect(res.error).toBeFalsy();
        expect(res.execute).toMatch(/Astartes over Mortal\) \(band assumed\)$/);
        expect(tok(enc, 'hound-1').hp).toBe(0);
    });

    it('the lower-band grapple disadvantage says so', async () => {
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        spy.mockReturnValueOnce(15).mockReturnValueOnce(5).mockReturnValueOnce(4);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId: enc, actorId: 'gor', targetId: 'hound-2' });
        expect(res.situational.join(' ')).toMatch(/Hound 2: disadvantage \(lower band \(Mortal vs Astartes\) \(band assumed\)\)/);
    });

    it('a crit on an assumed hound flags CONSEQUENCE DUE with the tag', async () => {
        const text = await actText({ action: 'attack', encounterId: enc, actorId: 'gor', targetId: 'hound-2', outcome: 'crit', damage: 4 });
        expect(text).toMatch(/CONSEQUENCE DUE \(peer-consequence, from above\): critical hit \(band assumed\)/);
    });

    it('a called strike at an assumed peer says so; cleave through an assumed unit says so', async () => {
        await manage({ action: 'set_band', encounterId: enc, participantId: 'gor', band: 'Mortal' });
        const strike = await actText({ action: 'attack', encounterId: enc, actorId: 'gor', targetId: 'hound-2', outcome: 'hit', damage: 2, calledStrike: 'leg' });
        expect(strike).toMatch(/RULE measure-of-a-body: Hound 2's leg crippled until repaired.*\(band assumed\)/);
        await manage({ action: 'set_band', encounterId: enc, participantId: 'gor', band: 'Astartes' });
        const cleave = await actText({ action: 'attack', encounterId: enc, actorId: 'gor', targetId: 'mob', outcome: 'hit', damage: 20, cleave: true });
        expect(cleave).toMatch(/cleave.*Militia.*Mortal.*\(band assumed\)/i);
    });

    it('band-scaled damage says so', async () => {
        await rules({ action: 'define', kind: 'band', name: 'bands', spec: { order: ORDER.split(' < '), damageScale: {} } });
        const text = await actText({ action: 'attack', encounterId: enc, actorId: 'gor', targetId: 'hound-2', outcome: 'hit', damage: 4 });
        expect(text).toMatch(/RULE bands: Astartes 2 above Mortal: damage ×1\.5625 \(4 → 6\) \(band assumed\)/);
    });

    it('a kill credited per band step on an assumed victim says so', async () => {
        await rules({ action: 'define', kind: 'growth_track', name: 'Blood', spec: { pool: 'blood', perKill: 1, perBandAbove: 1, steps: [{ at: 50, form: 'Bigger' }] } });
        new CharacterRepository(getDb()).create({ id: 'thrall', name: 'Thrall', band: 'Mortal', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 10, level: 1, resourcePools: { blood: { current: 0, max: 100 } }, createdAt: now(), updatedAt: now() } as any);
        const credit = await creditKill(getDb(), W, 'thrall', { id: 'hound-2', name: 'Hound 2', band: 'Mortal', bandAssumed: true }, 'Mortal');
        expect(credit).toMatchObject({ delta: 2, reason: 'kill: Hound 2 (band assumed)' });
    });

    // Review: the per-band step read the assumed band even when it added
    // nothing (a killer above the victim); a higher real band would have paid more.
    it('a per-band credit that added nothing for an assumed victim still says the band was assumed', async () => {
        await rules({ action: 'define', kind: 'growth_track', name: 'Blood', spec: { pool: 'blood', perKill: 1, perBandAbove: 1, steps: [{ at: 50, form: 'Bigger' }] } });
        new CharacterRepository(getDb()).create({ id: 'lord', name: 'Lord', band: 'Astartes', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 10, level: 1, resourcePools: { blood: { current: 0, max: 100 } }, createdAt: now(), updatedAt: now() } as any);
        const credit = await creditKill(getDb(), W, 'lord', { id: 'hound-2', name: 'Hound 2', band: 'Mortal', bandAssumed: true }, 'Astartes');
        expect(credit).toMatchObject({ delta: 1, reason: 'kill: Hound 2 (band assumed)' });
        const real = await creditKill(getDb(), W, 'lord', { id: 'hound-3', name: 'Hound 3', band: 'Mortal' }, 'Astartes');
        expect(real).toMatchObject({ delta: 1, reason: 'kill: Hound 3' });
    });

    // Review (lanes A and B merged): a unit under a band-scaled area loses
    // models per model; the band per model line read the assumed band too.
    it('band-scaled area damage on an assumed unit, model by model, says so', async () => {
        await rules({ action: 'define', kind: 'band', name: 'bands', spec: { order: ORDER.split(' < '), damageScale: {} } });
        const text = await manageText({ action: 'apply_damage', encounterId: enc, targetIds: ['mob'], dice: 6, source: 'grenade', actorId: 'gor', area: true });
        expect(text).toMatch(/×1\.5625 band per model \(6 → 9\) \(band assumed\)/);
    });
});

describe('a world with several band ladders (review)', () => {
    beforeEach(async () => {
        await world();
        await rules({ action: 'import', preset: 'orruk-waaagh' });
    });
    const boss = { id: 'boss', name: 'Gorrakh', hp: 80, maxHp: 80, initiative: 20, band: 'Boss', position: { x: 0, y: 0 } };
    const pinned = (holder: string) => ({ conditions: [{ name: 'restrained', source: `grapple: ${holder}` }] });

    it("an orruk fight's ad-hoc tokens are assumed on the orruk ladder, so the Boss can execute a pinned grot", async () => {
        const created = await manage({ action: 'create', worldId: W, participants: [boss, hound(1, pinned('boss'))] });
        expect(tok(created.encounterId, 'hound-1')).toMatchObject({ band: 'Grot', bandAssumed: true });
        const warning = created.warnings.join('\n');
        expect(warning).toContain('assumed Grot: Hound 1');
        expect(warning).toContain('orruk-bands: Grot < Boy < Brute < Boss < Warboss');
        expect(warning).toMatch(/also has bands/);
        const res = await act({ action: 'grapple', move: 'execute', encounterId: created.encounterId, actorId: 'boss', targetId: 'hound-1' });
        expect(res.error).toBeFalsy();
        expect(res.execute).toMatch(/Boss over Grot\) \(band assumed\)$/);
    });

    it('add_participant into an orruk fight assumes on the ladder the fight already uses', async () => {
        const { encounterId } = await manage({ action: 'create', worldId: W, participants: [boss] });
        const join = await manage({ action: 'add_participant', encounterId, id: 'snotling', name: 'Snotling', hp: 3, maxHp: 3, isEnemy: true });
        expect(join.error).toBeFalsy();
        expect(tok(encounterId, 'snotling')).toMatchObject({ band: 'Grot', bandAssumed: true });
        const spawned = await manage({ action: 'spawn_quick_enemy', creature: 'goblin', encounterId });
        expect(tok(encounterId, spawned.enemies[0].id)).toMatchObject({ band: 'Grot', bandAssumed: true });
    });

    it("when the fight's bands sit on two ladders, a refusal says they share none (not 'unset') and names the other ladder", async () => {
        const created = await manage({ action: 'create', worldId: W, participants: [gor, boss, hound(1, pinned('boss'))] });
        // No one ladder holds Astartes and Boss: the first ladder by name is used.
        expect(tok(created.encounterId, 'hound-1')).toMatchObject({ band: 'Mortal', bandAssumed: true });
        const res = await act({ action: 'grapple', move: 'execute', encounterId: created.encounterId, actorId: 'boss', targetId: 'hound-1' });
        expect(res).toMatchObject({ error: true, writes: 'none' });
        expect(res.message).not.toMatch(/unset/);
        expect(res.message).toMatch(/Gorrakh \(Boss\) and Hound 1 \(Mortal, assumed\) share no band ladder/);
        expect(res.message).toContain(`combat_manage set_band {encounterId: '${created.encounterId}', participantId: 'hound-1', band: '<band>'} (order: Grot < Boy < Brute < Boss < Warboss)`);
        // The fix it names works: the hound moves onto the orruk ladder, and the execute lands.
        expect((await manage({ action: 'set_band', encounterId: created.encounterId, participantId: 'hound-1', band: 'grot' })).band).toBe('Grot');
        const again = await act({ action: 'grapple', move: 'execute', encounterId: created.encounterId, actorId: 'boss', targetId: 'hound-1' });
        expect(again.error).toBeFalsy();
        expect(again.execute).toMatch(/Boss over Grot\)$/);
    });

    it('cleave and called strike across two ladders say so too', async () => {
        const created = await manage({ action: 'create', worldId: W, participants: [gor, boss,
            { id: 'mob', name: 'Boyz', hp: 36, maxHp: 36, initiative: 1, isEnemy: true, band: 'Boy', position: { x: 1, y: 1 }, unit: { models: 4, hpPerModel: 9, packed: true } },
            hound(2)] });
        const cleave = await act({ action: 'attack', encounterId: created.encounterId, actorId: 'gor', targetId: 'mob', outcome: 'hit', damage: 2, cleave: true });
        expect(String(cleave.message)).toMatch(/Cleave needs both bands on one ladder: Gor \(Astartes\) and Boyz \(Boy\) share no band ladder/);
        expect(String(cleave.message)).toContain("participantId: 'mob'");
        expect(String(cleave.message)).toContain('(order: Mortal < Elite Mortal');
        const strike = await act({ action: 'attack', encounterId: created.encounterId, actorId: 'boss', targetId: 'gor', outcome: 'hit', damage: 2, calledStrike: 'leg' });
        expect(String(strike.message)).toMatch(/needs both bands on one ladder: Gorrakh \(Boss\) and Gor \(Astartes\) share no band ladder/);
    });

    it('requireBand on one ladder refuses for the world, and the refusal names the rule that set it', async () => {
        await rules({ action: 'define', kind: 'band', name: 'orruk-bands', spec: { order: ['Grot', 'Boy', 'Brute', 'Boss', 'Warboss'], requireBand: true } });
        const refused = await manage({ action: 'create', worldId: W, participants: [gor, hound(1)] });
        expect(refused).toMatchObject({ error: true, writes: 'none' });
        expect(refused.message).toMatch(/band rule 'orruk-bands' requireBand: true/);
    });

    it('set_band refuses a band on no ladder, naming every ladder', async () => {
        const created = await manage({ action: 'create', worldId: W, participants: [boss, hound(1)] });
        const res = await manage({ action: 'set_band', encounterId: created.encounterId, participantId: 'hound-1', band: 'Godlike' });
        expect(res).toMatchObject({ error: true, writes: 'none' });
        expect(res.message).toContain('bands: Mortal < Elite Mortal');
        expect(res.message).toContain('orruk-bands: Grot < Boy');
    });
});

describe('set_band (play report 7 #3)', () => {
    let enc: string;
    beforeEach(async () => {
        await world();
        enc = (await manage({ action: 'create', worldId: W, participants: [gor, hound(1, { conditions: [{ name: 'restrained', source: 'grapple: gor' }] })] })).encounterId;
    });

    it('sets the band (any case), clears the assumption, and is logged', async () => {
        const res = await manage({ action: 'set_band', encounterId: enc, participantId: 'hound-1', band: 'elite mortal', reason: 'war-hound' });
        expect(res.error).toBeFalsy();
        expect(res).toMatchObject({ participantId: 'hound-1', band: 'Elite Mortal', previous: { band: 'Mortal', assumed: true } });
        expect(tok(enc, 'hound-1').band).toBe('Elite Mortal');
        expect(tok(enc, 'hound-1').bandAssumed).toBeUndefined();
        const text = await manageText({ action: 'get', encounterId: enc });
        expect(text).not.toMatch(/\(assumed\)/);
        const log = getDb().prepare("SELECT result_summary FROM combat_action_log WHERE action_type = 'set_band'").all() as Array<{ result_summary: string }>;
        expect(log.map(l => l.result_summary).join(' ')).toMatch(/Hound 1.*Mortal \(assumed\) → Elite Mortal/);
        // Applied to the next roll: execute now reads the new band with no tag.
        const ex = await act({ action: 'grapple', move: 'execute', encounterId: enc, actorId: 'gor', targetId: 'hound-1' });
        expect(ex.execute).toMatch(/Astartes over Elite Mortal\)$/);
    });

    // Review: the assumed mark and set_band live on the encounter row, so a
    // second process (no engine in memory) reads them.
    it('the assumed mark and a set_band survive a new process', async () => {
        clearCombatState();
        const ex = await act({ action: 'grapple', move: 'execute', encounterId: enc, actorId: 'gor', targetId: 'hound-1', damage: 1 });
        expect(ex.execute).toMatch(/\(band assumed\)$/);
        clearCombatState();
        await manage({ action: 'set_band', encounterId: enc, participantId: 'hound-1', band: 'Elite Mortal' });
        clearCombatState();
        expect(tok(enc, 'hound-1')).toMatchObject({ band: 'Elite Mortal' });
        expect(await manageText({ action: 'get', encounterId: enc })).not.toMatch(/\(assumed\)/);
        const again = await act({ action: 'grapple', move: 'execute', encounterId: enc, actorId: 'gor', targetId: 'hound-1' });
        expect(again.execute).toMatch(/Astartes over Elite Mortal\)$/);
    });

    // Review: the owner offered "combat_manage set_unit {participantId, band}
    // or a set_band"; the plan built set_band. set_unit {band} must point there.
    it('set_unit with a band points to set_band (on a unit: ignored with the hint; on a hound: the refusal names it)', async () => {
        const created = await manage({ action: 'create', worldId: W, participants: [gor, hound(2),
            { id: 'mob', name: 'Militia', hp: 36, maxHp: 36, initiative: 1, isEnemy: true, unit: { models: 4, hpPerModel: 9, packed: true } }] });
        const onUnit = await manage({ action: 'set_unit', encounterId: created.encounterId, participantId: 'mob', band: 'Elite Mortal', suppressed: true });
        expect(onUnit.error).toBeFalsy();
        expect(onUnit.ignoredParams).toEqual(['band']);
        expect(onUnit.message).toMatch(/band — set_unit does not set bands: combat_manage set_band \{encounterId, participantId, band\}/);
        expect(tok(created.encounterId, 'mob')).toMatchObject({ band: 'Mortal', bandAssumed: true });
        const onHound = await manage({ action: 'set_unit', encounterId: created.encounterId, participantId: 'hound-2', band: 'Elite Mortal' });
        expect(onHound).toMatchObject({ error: true, writes: 'none' });
        expect(onHound.message).toMatch(/set_band/);
    });

    it('an unknown band or participant is refused, naming the order', async () => {
        const res = await manage({ action: 'set_band', encounterId: enc, participantId: 'hound-1', band: 'Godlike' });
        expect(res).toMatchObject({ error: true, writes: 'none' });
        expect(res.message).toContain(ORDER);
        expect(tok(enc, 'hound-1')).toMatchObject({ band: 'Mortal', bandAssumed: true });
        const nobody = await manage({ action: 'set_band', encounterId: enc, participantId: 'nobody', band: 'Mortal' });
        expect(nobody).toMatchObject({ error: true, writes: 'none' });
    });
});

describe('band refusals name set_band', () => {
    it('execute against an unbanded token (no band rule in the world) names the call', async () => {
        await world(false);
        const created = await manage({ action: 'create', worldId: W, participants: [gor, hound(1, { conditions: [{ name: 'restrained', source: 'grapple: gor' }] })] });
        const res = await act({ action: 'grapple', move: 'execute', encounterId: created.encounterId, actorId: 'gor', targetId: 'hound-1' });
        expect(res.error).toBe(true);
        expect(res.message).toMatch(/execute needs both bands set \(unset for Hound 1\)/);
        expect(res.message).toContain(`combat_manage set_band {encounterId: '${created.encounterId}', participantId: 'hound-1', band: '<band>'}`);
    });

    it('cleave and called strike refusals name it too', async () => {
        await world(false);
        await rules({ action: 'define', kind: 'called_strike', name: 'measure', spec: {} });
        const created = await manage({ action: 'create', worldId: W, participants: [
            gor, hound(1),
            { id: 'mob', name: 'Militia', hp: 36, maxHp: 36, initiative: 1, isEnemy: true, unit: { models: 4, hpPerModel: 9, packed: true } }
        ] });
        const strike = await act({ action: 'attack', encounterId: created.encounterId, actorId: 'gor', targetId: 'hound-1', outcome: 'hit', damage: 2, calledStrike: 'leg' });
        expect(String(strike.message)).toMatch(/needs both bands set.*combat_manage set_band/);
        const cleave = await act({ action: 'attack', encounterId: created.encounterId, actorId: 'gor', targetId: 'mob', outcome: 'hit', damage: 2, cleave: true });
        expect(String(cleave.message)).toMatch(/Cleave needs both bands set.*combat_manage set_band/);
        expect(getOrLoadEngine(ctx as any, created.encounterId)!.getState()!.participants.find(p => p.id === 'gor')!.actionUsed).toBeFalsy();
    });
});
