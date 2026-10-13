import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleWorldManage, WorldManageTool } from '../../../src/server/consolidated/world-manage.js';
import { handleCombatManage, CombatManageTool } from '../../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../../src/server/consolidated/combat-action.js';
import { handleImprovisationManage, ImprovisationManageTool } from '../../../src/server/consolidated/improvisation-manage.js';
import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { handleItemManage } from '../../../src/server/consolidated/item-manage.js';
import { handleInventoryManage, InventoryManageTool } from '../../../src/server/consolidated/inventory-manage.js';
import { clearCombatState, getOrLoadEngine } from '../../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

/**
 * Play report 6 #3: Many-Skins' arm healing had to be a reminder note
 * because the scheduled grammar had no part op, and a sheet-only write would
 * never have reached a live token (hydration copies parts once, at creation).
 * A scheduled set_part / remove_part now writes the sheet and every live
 * token at fire time, through schedule_change (fireNow, process_scheduled,
 * world_manage advance {fireScheduled}), montage costs and roll-table writes.
 *
 * Every call goes through the tool's outer schema first, so a key the mirror
 * would strip fails here the way it would for the HTTP client.
 */
const W = 'skinwood';
const ctx = { sessionId: 'sched-parts' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const world = async (a: Record<string, unknown>) => json(await handleWorldManage(WorldManageTool.inputSchema.parse(a), ctx as any));
const manage = async (a: Record<string, unknown>) => json(await handleCombatManage(CombatManageTool.inputSchema.parse(a), ctx as any));
const act = async (a: Record<string, unknown>) => {
    const text = (await handleCombatAction(a, ctx as any)).content[0].text as string;
    const m = text.match(/<!-- COMBAT_ACTION_JSON\n([\s\S]*?)\nCOMBAT_ACTION_JSON -->/);
    const d = m ? JSON.parse(m[1]) : null;
    return { text, r: d?.actionResult ?? d };
};
const montage = async (a: Record<string, unknown>) => json(await handleImprovisationManage(ImprovisationManageTool.inputSchema.parse({ action: 'montage', ...a }), ctx as any));
const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx as any));
const repo = () => new CharacterRepository(getDb());
const sheet = () => repo().findById('manyskins')! as any;
const sheetPart = (name: string) => (sheet().parts ?? []).find((p: any) => p.name === name);
const stored = (enc: string, id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const live = (enc: string, id: string) => getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === id)! as any;

const CRIPPLED_ARM = { name: 'left arm', kind: 'arm', state: 'crippled', holds: ['claw'] };
const heal = { op: 'set_part', part: 'left arm', state: 'intact' };

/** Many-Skins (acts first) against a Gor; the token takes the sheet's parts. */
const fight = async () => json(await handleCombatManage({ action: 'create', worldId: W, participants: [
    { id: 'manyskins', name: 'Many-Skins', hp: 30, maxHp: 30, initiative: 30 },
    { id: 'gor', name: 'Gor', hp: 20, maxHp: 20, initiative: 10, isEnemy: true }
] }, ctx as any)).encounterId as string;

beforeEach(() => {
    closeDb(); clearCombatState();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Skinwood', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 10, time: '08:00' } } as any);
    new CharacterRepository(db).create({
        id: 'manyskins', name: 'Many-Skins', characterType: 'pc', level: 3,
        stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 30, maxHp: 30, ac: 13,
        parts: [CRIPPLED_ARM], createdAt: now, updatedAt: now
    } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(W, 'manyskins');
});
afterEach(() => { clearCombatState(); closeDb(); });

describe('schedule_change writes a body part on the sheet', () => {
    it('schedule, then process_scheduled: the arm goes intact and keeps its holds; the line says sheet', async () => {
        const s = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 12, writes: [heal], note: 'the arm knits' });
        expect(s).toMatchObject({ success: true, ops: 1, kind: 'clock' });
        expect(sheetPart('left arm').state).toBe('crippled');
        const p = await char({ action: 'process_scheduled', worldId: W, currentDay: 12 });
        expect(p.results).toHaveLength(1);
        expect(p.results[0].applied).toEqual(['set_part: left arm crippled → intact (sheet)']);
        expect(p.results[0].liveTokens).toBeUndefined();
        expect(sheetPart('left arm')).toEqual({ name: 'left arm', kind: 'arm', state: 'intact', holds: ['claw'] });
    });

    it('fires through world_manage advance {fireScheduled: true}', async () => {
        await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesInHours: 24, writes: [heal] });
        const adv = await world({ action: 'advance', worldId: W, hours: 30, fireScheduled: true });
        expect(adv.error).toBeUndefined();
        expect(JSON.stringify(adv.fired)).toMatch(/set_part: left arm crippled → intact \(sheet\)/);
        expect(sheetPart('left arm').state).toBe('intact');
    });

    it('fireNow applies at once: a new part with kind, hp and holds, then remove_part; the reply carries the lines', async () => {
        const r = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 10, fireNow: true, writes: [
            { op: 'set_part', part: 'tail', state: 'crippled', hp: 4, holds: ['lash'] },
            { op: 'remove_part', part: 'left arm' }
        ] });
        expect(r.firedNow).toBe(true);
        expect(r.applied).toEqual(['set_part: tail → crippled (new part on sheet)', '−part left arm (sheet)']);
        expect(r.message).toMatch(/FIRED NOW .*set_part: tail → crippled \(new part on sheet\); −part left arm \(sheet\)/);
        expect(sheet().parts).toEqual([{ name: 'tail', kind: 'other', state: 'crippled', hp: 4, maxHp: 4, holds: ['lash'] }]);
    });

    it('a part the sheet lacks on remove_part is skipped and nothing else on the sheet moves', async () => {
        const r = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 10, fireNow: true, writes: [{ op: 'remove_part', part: 'horn' }, { op: 'adjust_hp', delta: -2 }] });
        expect(r.applied).toEqual(['part "horn" not present on sheet — skipped', 'hp: 30 → 28']);
        expect(sheet().parts).toEqual([CRIPPLED_ARM]);
        expect(sheet().hp).toBe(28);
    });
});

describe('a scheduled part op reaches the live token', () => {
    it('the crippled arm joins the fight; the clock fires; the token arm is intact with holds kept, a token-only part untouched, the next attack straight, the line names the encounter', async () => {
        const enc = await fight();
        expect(stored(enc, 'manyskins').parts).toEqual([CRIPPLED_ARM]);
        await manage({ action: 'set_part', encounterId: enc, participantId: 'manyskins', part: 'tail', state: 'crippled', note: 'token only' });
        // With its one arm crippled an unnamed swing is at disadvantage.
        const before = await act({ action: 'attack', encounterId: enc, actorId: 'manyskins', targetId: 'gor', attackBonus: 5, damage: 1 });
        expect(before.r.roll.allRolls).toHaveLength(2);
        expect(before.text).toMatch(/left arm crippled \(disadvantage/);

        const s = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 10, fireNow: true, writes: [heal], note: 'the arm knits' });
        expect(s.applied).toEqual([`set_part: left arm crippled → intact (sheet; token in ${enc})`]);
        expect(s.liveTokens).toEqual([enc]);
        expect(sheetPart('left arm')).toEqual({ name: 'left arm', kind: 'arm', state: 'intact', holds: ['claw'] });
        const tokParts = stored(enc, 'manyskins').parts;
        expect(tokParts).toEqual([
            { name: 'left arm', kind: 'arm', state: 'intact', holds: ['claw'] },
            expect.objectContaining({ name: 'tail', state: 'crippled', note: 'token only' })
        ]);
        expect(live(enc, 'manyskins').parts).toEqual(tokParts);

        live(enc, 'manyskins').actionUsed = false;
        const after = await act({ action: 'attack', encounterId: enc, actorId: 'manyskins', targetId: 'gor', attackBonus: 5, damage: 1 });
        expect(after.r.roll.allRolls).toHaveLength(1);
        expect(after.text).not.toMatch(/left arm crippled/);
    });

    it('process_scheduled names the encounter too, and the row result carries liveTokens', async () => {
        const enc = await fight();
        await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 12, writes: [heal] });
        const p = await char({ action: 'process_scheduled', worldId: W, currentDay: 12 });
        expect(p.results[0].applied).toEqual([`set_part: left arm crippled → intact (sheet; token in ${enc})`]);
        expect(p.results[0].liveTokens).toEqual([enc]);
        expect(stored(enc, 'manyskins').parts[0].state).toBe('intact');
    });

    it('two active encounters both take the write; a completed one does not', async () => {
        const a = await fight();
        const b = await fight();
        const c = await fight();
        await manage({ action: 'end', encounterId: c });
        expect(stored(c, 'manyskins').parts[0].state).toBe('crippled');
        const s = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 10, fireNow: true, writes: [heal] });
        expect([...s.liveTokens].sort()).toEqual([a, b].sort());
        expect(s.applied[0]).toMatch(new RegExp(`^set_part: left arm crippled → intact \\(sheet; token in (${a}, ${b}|${b}, ${a})\\)$`));
        expect(stored(a, 'manyskins').parts[0].state).toBe('intact');
        expect(stored(b, 'manyskins').parts[0].state).toBe('intact');
        expect(stored(c, 'manyskins').parts[0].state).toBe('crippled');
    });

    it('a crippled wing healed gives speed back at the next turn start, not mid-turn', async () => {
        repo().update('manyskins', { parts: [{ name: 'left wing', kind: 'wing', state: 'crippled' }] } as any);
        const enc = await fight();
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        expect(stored(enc, 'manyskins').movementRemaining).toBe(15);
        const s = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 10, fireNow: true, writes: [{ op: 'set_part', part: 'left wing', state: 'intact' }] });
        expect(s.applied).toEqual([`set_part: left wing crippled → intact (sheet; token in ${enc})`]);
        expect(stored(enc, 'manyskins').movementRemaining).toBe(15);
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        expect(stored(enc, 'manyskins').movementRemaining).toBe(30);
    });

    it('remove_part on a token-only part: the token loses it and the line says the sheet never had it', async () => {
        const enc = await fight();
        await manage({ action: 'set_part', encounterId: enc, participantId: 'manyskins', part: 'tail', state: 'crippled' });
        const s = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 10, fireNow: true, writes: [{ op: 'remove_part', part: 'tail' }] });
        expect(s.applied).toEqual([`−part tail (token in ${enc}; not on sheet)`]);
        expect(s.liveTokens).toEqual([enc]);
        expect(stored(enc, 'manyskins').parts.map((p: any) => p.name)).toEqual(['left arm']);
        expect(sheet().parts).toEqual([CRIPPLED_ARM]);
    });

    it('a part the token never had is added to it, as on the sheet', async () => {
        const enc = await fight();
        const s = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 10, fireNow: true, writes: [{ op: 'set_part', part: 'right eye', state: 'dead', kind: 'head' }] });
        expect(s.applied).toEqual([`set_part: right eye → dead (new part on sheet; token in ${enc})`]);
        expect(stored(enc, 'manyskins').parts).toEqual([CRIPPLED_ARM, { name: 'right eye', kind: 'head', state: 'dead' }]);
    });
});

describe('montage costs and roll-table writes reach parts too', () => {
    it('montage costs.costly with a set_part cripples the arm on the sheet and the live token', async () => {
        repo().update('manyskins', { parts: [{ ...CRIPPLED_ARM, state: 'intact' }] } as any);
        const enc = await fight();
        // montage-5 rolls a 3: 3 + 0 (str) is under DC 12, so the costly tier applies.
        const r = await montage({ characterId: 'manyskins', task: 'wrestle the bear', dc: 12, ability: 'str', seed: 'montage-5', journal: false, costs: { costly: [{ op: 'set_part', part: 'left arm', state: 'crippled' }] } });
        expect(r.tier).toBe('costly');
        expect(r.applied).toEqual([`set_part: left arm intact → crippled (sheet; token in ${enc})`]);
        // The reply names the encounters reached, as schedule_change and roll tables do.
        expect(r.liveTokens).toEqual([enc]);
        expect(sheetPart('left arm')).toEqual({ name: 'left arm', kind: 'arm', state: 'crippled', holds: ['claw'] });
        expect(stored(enc, 'manyskins').parts[0]).toEqual({ name: 'left arm', kind: 'arm', state: 'crippled', holds: ['claw'] });
    });

    it('a roll_table entry with a set_part write heals the arm on the sheet and the live token', async () => {
        const enc = await fight();
        await rules({ action: 'define', kind: 'roll_table', name: 'Mending', spec: { entries: [{ text: 'the arm knits', apply: { writes: [{ op: 'set_part', part: 'left arm', state: 'intact', note: 'knitted' }] } }] } });
        const r = await rules({ action: 'roll', name: 'Mending', characterId: 'manyskins' });
        expect(r.applied[0].writes).toEqual([`set_part: left arm crippled → intact (sheet; token in ${enc})`]);
        expect(r.applied[0].liveTokens).toEqual([enc]);
        expect(sheetPart('left arm')).toEqual({ name: 'left arm', kind: 'arm', state: 'intact', holds: ['claw'], note: 'knitted' });
        expect(stored(enc, 'manyskins').parts[0]).toMatchObject({ state: 'intact', note: 'knitted', holds: ['claw'] });
    });

    it('the shared commit step mirrors a linked pool onto its item for montage costs and roll-table writes too', async () => {
        const inv = async (a: Record<string, unknown>) => json(await handleInventoryManage(InventoryManageTool.inputSchema.parse(a), ctx as any));
        const itemId = json(await handleItemManage({ action: 'create', name: 'Skin-drum', type: 'misc', weight: 0, value: 0 }, ctx as any)).item.id;
        await inv({ action: 'give', characterId: 'manyskins', itemId });
        await char({ action: 'adjust_pool', characterId: 'manyskins', pool: 'beats', value: 3, max: 3, linkItem: itemId });
        const instanceId = sheet().resourcePools.beats.itemInstanceId;
        const charges = () => (getDb().prepare('SELECT charges FROM item_instances WHERE id = ?').get(instanceId) as any).charges;
        expect(charges()).toBe(3);
        const m = await montage({ characterId: 'manyskins', task: 'drum the pack home', dc: 12, ability: 'str', seed: 'montage-5', journal: false, costs: { costly: [{ op: 'adjust_pool', pool: 'beats', delta: -1 }] } });
        expect(m.applied).toEqual(['beats: 3 → 2 (of 3)']);
        expect(charges()).toBe(2);
        await rules({ action: 'define', kind: 'roll_table', name: 'Toll', spec: { entries: [{ text: 'a beat is spent', apply: { writes: [{ op: 'adjust_pool', pool: 'beats', delta: -1 }] } }] } });
        const r = await rules({ action: 'roll', name: 'Toll', characterId: 'manyskins' });
        expect(r.applied[0].writes).toEqual(['beats: 2 → 1 (of 3)']);
        expect(charges()).toBe(1);
    });
});

describe('a scheduled part op on a vessel token', () => {
    const MURDER = {
        hull: 220, ac: 15,
        sections: [{ name: 'Drive', hp: 50, role: 'drive' }, { name: 'Reactor', hp: 60, role: 'reactor' }],
        weapons: [{ name: 'Lance', attackBonus: 6, damage: '4d10', damageType: 'energy', range: 40000, section: 'Drive' }],
        speed: 8, band: 'Cruiser'
    };

    it('a reactor section scheduled dead sets reactorBreach on the live token; scheduled intact again clears it', async () => {
        await rules({ action: 'define', kind: 'vessel', name: 'Murder-class', spec: MURDER });
        const ship = (await char({ action: 'create_vessel', worldId: W, vessel: 'Murder-class', name: 'Blade of Ruin' })).characterId as string;
        const r = repo().findById(ship)! as any;
        const enc = json(await handleCombatManage({ action: 'create', worldId: W, participants: [
            { id: ship, name: r.name, hp: r.hp, maxHp: r.maxHp, initiative: 20 },
            { id: 'gor', name: 'Gor', hp: 20, maxHp: 20, initiative: 10, isEnemy: true }
        ] }, ctx as any)).encounterId as string;
        expect(stored(enc, ship).reactorBreach).toBeUndefined();
        const dead = await char({ action: 'schedule_change', characterId: ship, worldId: W, firesAtDay: 10, fireNow: true, writes: [{ op: 'set_part', part: 'Reactor', state: 'dead' }], note: 'the containment fails' });
        expect(dead.applied).toEqual([`set_part: Reactor intact → dead (sheet; token in ${enc})`]);
        expect(stored(enc, ship).reactorBreach).toBe(true);
        expect(live(enc, ship).reactorBreach).toBe(true);
        expect((repo().findById(ship) as any).parts.find((p: any) => p.name === 'Reactor')).toMatchObject({ state: 'dead', role: 'reactor', kind: 'system' });
        const fixed = await char({ action: 'schedule_change', characterId: ship, worldId: W, firesAtDay: 10, fireNow: true, writes: [{ op: 'set_part', part: 'Reactor', state: 'intact' }], note: 'the enginseers seal it' });
        expect(fixed.applied).toEqual([`set_part: Reactor dead → intact (sheet; token in ${enc})`]);
        expect(stored(enc, ship).reactorBreach).toBeUndefined();
        expect(live(enc, ship).reactorBreach).toBeUndefined();
    });
});

describe('a part op beside a note, a token made after the clock, and another process reading the fight', () => {
    it('a note that prints two lines before the part op: the token line is rewritten at its own index', async () => {
        const enc = await fight();
        const s = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 10, fireNow: true, writes: [{ op: 'note', text: 'adjust_hp -3' }, heal, { op: 'note', text: 'the arm has healed' }] });
        expect(s.applied).toHaveLength(4);
        expect(s.applied[0]).toBe('note: adjust_hp -3');
        expect(s.applied[1]).toMatch(/^⚠ 'adjust_hp -3' reads like an op/);
        expect(s.applied[2]).toBe(`set_part: left arm crippled → intact (sheet; token in ${enc})`);
        expect(s.applied[3]).toBe('note: the arm has healed');
        expect(s.liveTokens).toEqual([enc]);
        expect(stored(enc, 'manyskins').parts[0].state).toBe('intact');
        expect(sheet().hp).toBe(30);
    });

    it('a token hydrated from the sheet after the clock fired starts with the healed arm and swings straight', async () => {
        await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 12, writes: [heal] });
        const p = await char({ action: 'process_scheduled', worldId: W, currentDay: 12 });
        expect(p.results[0].applied).toEqual(['set_part: left arm crippled → intact (sheet)']);
        const enc = await fight();
        expect(stored(enc, 'manyskins').parts).toEqual([{ name: 'left arm', kind: 'arm', state: 'intact', holds: ['claw'] }]);
        const a = await act({ action: 'attack', encounterId: enc, actorId: 'manyskins', targetId: 'gor', attackBonus: 5, damage: 1 });
        expect(a.r.roll.allRolls).toHaveLength(1);
        expect(a.text).not.toMatch(/left arm crippled/);
    });

    it('a process that never held the engine loads the fired token from the encounter row (the guard evicts engines before every call)', async () => {
        const enc = await fight();
        await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 10, fireNow: true, writes: [heal] });
        // The other server: nothing in memory, the encounter row is what it has.
        clearCombatState();
        expect(live(enc, 'manyskins').parts).toEqual([{ name: 'left arm', kind: 'arm', state: 'intact', holds: ['claw'] }]);
        const a = await act({ action: 'attack', encounterId: enc, actorId: 'manyskins', targetId: 'gor', attackBonus: 5, damage: 1 });
        expect(a.r.roll.allRolls).toHaveLength(1);
        expect(a.text).not.toMatch(/left arm crippled/);
    });
});

describe("a scheduled part op on a character in a form (documented: the form's parts are the sheet's parts)", () => {
    it("the clock writes the form's part; set_form base brings the base parts back untouched", async () => {
        await rules({ action: 'define', kind: 'creature', name: 'Great Bear', spec: { hp: 40, ac: 12, attackBonus: 5, attackDamage: '1d8+3', parts: [{ name: 'left forepaw', kind: 'arm' }] } });
        const f = await char({ action: 'set_form', characterId: 'manyskins', worldId: W, form: 'Great Bear' });
        expect(f.error).toBeUndefined();
        expect(sheet().parts).toEqual([{ name: 'left forepaw', kind: 'arm', state: 'intact' }]);
        expect(sheet().form.base.parts).toEqual([CRIPPLED_ARM]);
        const s = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 10, fireNow: true, writes: [{ op: 'set_part', part: 'left forepaw', state: 'crippled' }] });
        expect(s.applied).toEqual(['set_part: left forepaw intact → crippled (sheet)']);
        expect(sheet().parts).toEqual([{ name: 'left forepaw', kind: 'arm', state: 'crippled' }]);
        expect(sheet().form.base.parts).toEqual([CRIPPLED_ARM]);
        const back = await char({ action: 'set_form', characterId: 'manyskins', worldId: W, form: 'base' });
        expect(back.error).toBeUndefined();
        expect(sheet().parts).toEqual([CRIPPLED_ARM]);
        expect(sheet().form).toBeFalsy();
    });
});

describe('schedule_change refuses a clock that could do nothing when it fires (refuse-not-fake)', () => {
    const rows = () => { try { return (getDb().prepare('SELECT COUNT(*) AS n FROM scheduled_state_changes').get() as any).n as number; } catch { return 0; } };

    it('a set_part without state or part, a remove_part without part, an adjust_pool without pool: refused with the shape, nothing inserted', async () => {
        const cases: Array<[Record<string, unknown>, RegExp]> = [
            [{ op: 'set_part', part: 'left arm' }, /set_part.*state/],
            [{ op: 'set_part', state: 'intact' }, /set_part.*part/],
            [{ op: 'remove_part' }, /remove_part.*part/],
            [{ op: 'adjust_pool', delta: -1 }, /adjust_pool.*pool/]
        ];
        for (const [op, re] of cases) {
            const r = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 12, writes: [heal, op] });
            expect(r.error).toBe(true);
            expect(r.writes).toBe('none');
            expect(r.message).toMatch(re);
            expect(r.message).toMatch(/writes\[1\]/);
            expect(r.message).toMatch(/Nothing was inserted/);
            expect(r.message).toMatch(/each write is/);
        }
        expect(rows()).toBe(0);
        expect(sheet().parts).toEqual([CRIPPLED_ARM]);
        // A complete list still schedules, a note included.
        const ok = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 12, writes: [heal, { op: 'note', text: 'the arm has healed' }] });
        expect(ok).toMatchObject({ success: true, ops: 2 });
        expect(rows()).toBe(1);
    });

    it('an event row is a notification: its (empty) writes are not checked', async () => {
        const r = await char({ action: 'schedule_change', characterId: 'manyskins', worldId: W, firesAtDay: 12, event: true, note: 'the healer returns' });
        expect(r).toMatchObject({ success: true, kind: 'event' });
    });
});
