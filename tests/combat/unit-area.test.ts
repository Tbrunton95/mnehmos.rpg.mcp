import { areaOnUnit, unitSaveBonus, liveModels, breakTestDue, unitAreaLine } from '../../src/engine/combat/units.js';
import { UnitSchema } from '../../src/schema/token-extras.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { handleCombatMap } from '../../src/server/consolidated/combat-map.js';

/**
 * Play report 7 #1 (owner's spec): area damage on a unit token, per model.
 * "Each model in the area rolls its own save, and the engine rolls them on
 * the fight's logged dice. Nobody rolls by hand." Damage is rolled once; a
 * failed save takes it whole, a success half; any model whose damage meets
 * or beats its HP dies; the pool loses the dead models' HP, so the break
 * test reads the real count. An area with no save: every model inside takes
 * the full damage.
 */
const militia = (hp = 54, extra: Record<string, unknown> = {}): any => ({
    id: 'militia', name: 'Militia', hp, maxHp: 54,
    unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 0, ...extra }
});

describe('areaOnUnit (pure)', () => {
    it('the Day 70 cone: 31 over six 9-HP militia kills all six whichever saves pass', () => {
        for (const saves of [[false, false, false, false, false, false], [false, false, false, false, true, true], [true, true, true, true, true, true]]) {
            const r = areaOnUnit(militia(), { damage: 31, modelsInArea: 6, saves });
            expect(r).toMatchObject({ modelsBefore: 6, modelsInArea: 6, perModel: { full: 31, half: 15 }, modelsKilled: 6, modelsAfter: 0, hpLost: 54 });
            expect(r.failed + r.saved).toBe(6);
        }
        const four = areaOnUnit(militia(), { damage: 31, modelsInArea: 6, saves: [false, true, false, false, true, false] });
        expect(four).toMatchObject({ failed: 4, saved: 2 });
        expect(unitAreaLine(militia(), four, 'cone')).toContain('6 in the cone: 4 failed, 2 saved; 31 / 15 vs 9 HP each: 6 dead');
    });

    it('12 over 9-HP models: the saved take 6 and live, the failed take 12 and die', () => {
        const r = areaOnUnit(militia(), { damage: 12, modelsInArea: 6, saves: [true, false, true, false, false, true] });
        expect(r).toMatchObject({ failed: 3, saved: 3, perModel: { full: 12, half: 6 }, modelsKilled: 3, modelsAfter: 3, hpLost: 27 });
        // The pool reads back the real count: no overflow crosses models.
        expect(liveModels({ hp: 54 - r.hpLost, unit: militia().unit })).toBe(3);
    });

    it('the wounded front model is first inside and dies to what it has left', () => {
        // 50 HP = five full models and a front model on 5.
        const r = areaOnUnit(militia(50), { damage: 12, modelsInArea: 6, saves: [true, true, true, true, true, true] });
        expect(r).toMatchObject({ frontHp: 5, modelsBefore: 6, modelsKilled: 1, modelsAfter: 5, hpLost: 5 });
        expect(liveModels({ hp: 50 - r.hpLost, unit: militia().unit })).toBe(5);
        // A front model that survives keeps its wound; the others are whole.
        const kept = areaOnUnit(militia(50), { damage: 4, modelsInArea: 6 });
        expect(kept).toMatchObject({ modelsKilled: 0, hpLost: 0, modelsAfter: 6 });
        // Kills behind a surviving front model leave the front model's wound in the pool.
        const behind = areaOnUnit(militia(50), { damage: 9, modelsInArea: 6, saves: [true, false, false, true, true, true] });
        expect(behind).toMatchObject({ modelsKilled: 2, hpLost: 18, modelsAfter: 4 });
        expect(liveModels({ hp: 50 - behind.hpLost, unit: militia().unit })).toBe(4);
    });

    it('an area with no save: every model inside takes the full damage', () => {
        const r = areaOnUnit(militia(), { damage: 10, modelsInArea: 4 });
        expect(r).toMatchObject({ noSave: true, failed: 0, saved: 0, modelsInArea: 4, modelsKilled: 4, modelsAfter: 2, hpLost: 36 });
        expect(unitAreaLine(militia(), r, 'area')).toContain('4 of 6 in the area, no save: 10 vs 9 HP each: 4 dead');
    });

    it('models inside never exceed the live models; damage 0 kills nothing; a unit at 0 takes nothing', () => {
        expect(areaOnUnit(militia(18), { damage: 50, modelsInArea: 6 })).toMatchObject({ modelsBefore: 2, modelsInArea: 2, modelsKilled: 2, hpLost: 18 });
        expect(areaOnUnit(militia(), { damage: 0, modelsInArea: 6 })).toMatchObject({ modelsKilled: 0, hpLost: 0 });
        expect(areaOnUnit(militia(0), { damage: 30, modelsInArea: 6 })).toMatchObject({ modelsBefore: 0, modelsInArea: 0, modelsKilled: 0, hpLost: 0 });
    });

    it('a save that takes nothing (half: 0) saves the model outright', () => {
        const r = areaOnUnit(militia(), { damage: 20, half: 0, modelsInArea: 6, saves: [true, true, false, false, false, false] });
        expect(r).toMatchObject({ perModel: { full: 20, half: 0 }, modelsKilled: 4, modelsAfter: 2 });
    });

    it('the break test reads the real count', () => {
        const spaced = { id: 'line', name: 'Line', hp: 50, unit: { models: 10, hpPerModel: 5, packed: false, attackBonus: 0, morale: 7 } } as any;
        const r = areaOnUnit(spaced, { damage: 10, modelsInArea: 5 });
        expect(r.modelsKilled).toBe(5);
        expect(breakTestDue({ ...spaced, hp: 50 - r.hpLost }, 50)).toMatchObject({ modelsBefore: 10, modelsAfter: 5 });
    });
});

describe('unit save bonus', () => {
    it("is the token's ability modifier plus unit.saves for drilled troops", () => {
        const p = { ...militia(), abilityScores: { strength: 10, dexterity: 14, constitution: 12, intelligence: 10, wisdom: 10, charisma: 10 } };
        expect(unitSaveBonus(p, 'dex')).toMatchObject({ ability: 'dexterity', mod: 2, drilled: 0, total: 2 });
        const drilled = { ...p, unit: { ...p.unit, saves: { dex: 2 } } };
        expect(unitSaveBonus(drilled, 'Dexterity')).toMatchObject({ mod: 2, drilled: 2, total: 4 });
        expect(unitSaveBonus(drilled, 'con')).toMatchObject({ mod: 1, drilled: 0, total: 1 });
        // No scores: +0, as today.
        expect(unitSaveBonus(militia(), 'dex')).toMatchObject({ mod: 0, total: 0 });
    });

    it('UnitSchema takes saves with short or long keys and refuses an unknown one', () => {
        expect(UnitSchema.parse({ models: 6, hpPerModel: 9, saves: { dex: 2 } }).saves).toEqual({ dex: 2 });
        expect(UnitSchema.parse({ models: 6, hpPerModel: 9, saves: { Dexterity: 2, CON: 1 } }).saves).toEqual({ dex: 2, con: 1 });
        expect(UnitSchema.parse({ models: 6, hpPerModel: 9 })).not.toHaveProperty('saves');
        expect(() => UnitSchema.parse({ models: 6, hpPerModel: 9, saves: { luck: 2 } })).toThrow(/luck/);
        expect(() => UnitSchema.parse({ models: 6, hpPerModel: 9, saves: { dex: 1.5 } })).toThrow();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// In play: use_ability, apply_damage and lair_action on unit tokens
// ─────────────────────────────────────────────────────────────────────────

// The operation guard flushes engine dice to roll_log for the unscoped key.
const ctx = { sessionId: 'unscoped' };
const W = 'blackcrown';
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const guardedAction = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
let enc: string;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guardedManage(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    return { text, r: tag(text, 'COMBAT_MANAGE') ?? { rawText: text } };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await guardedAction(CombatActionTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, d, r: d?.actionResult ?? d };
};
const state = () => new EncounterRepository(getDb()).loadState(enc)!;
const tok = (id: string) => state().participants.find(p => p.id === id)! as any;
/** Patch a token in the saved state (as lane B's abilityScores will arrive), then reload. */
const patchTok = (id: string, patch: Record<string, unknown>) => {
    const repo = new EncounterRepository(getDb());
    const st = repo.loadState(enc)!;
    Object.assign(st.participants.find(p => p.id === id)!, patch);
    repo.saveState(enc, st);
    clearCombatState();
};
const rollCount = () => queryRolls(getDb(), { encounterId: enc, limit: 200 }).length;
const modelSaves = () => queryRolls(getDb(), { encounterId: enc, limit: 200 }).filter((x: any) => /save \(model \d+\/\d+\)/.test(String(x.purpose)));
const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };
const toLair = async () => {
    for (let i = 0; i < 6 && state().turnOrder[state().currentTurnIndex] !== 'LAIR'; i++) await manage({ action: 'advance' });
    expect(state().turnOrder[state().currentTurnIndex]).toBe('LAIR');
};

const MILITIA = (extra: Record<string, unknown> = {}, unit: Record<string, unknown> = {}) => ({
    id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, ac: 11,
    unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 2, morale: 6, ...unit }, ...extra
});
const LINE = (unit: Record<string, unknown> = {}) => ({
    id: 'line', name: 'Line', hp: 50, maxHp: 50, initiative: 4, isEnemy: true, ac: 11,
    unit: { models: 10, hpPerModel: 5, packed: false, attackBonus: 2, morale: 7, ...unit }
});

async function setup(units: any[], opts: { seed?: string; mage?: boolean; captain?: boolean } = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
    if (opts.mage) {
        new CharacterRepository(db).create({
            id: 'mage', name: 'Mage', characterClass: 'wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
            hp: 30, maxHp: 30, ac: 12, level: 5, spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: getMaxSpellLevel('wizard' as any, 5),
            knownSpells: ['Fireball', 'Burning Hands'], preparedSpells: ['Fireball', 'Burning Hands'], cantripsKnown: ['Fire Bolt'], createdAt: now, updatedAt: now
        } as any);
    }
    if (opts.captain) {
        new CharacterRepository(db).create({
            id: 'captain', name: 'Captain', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 12 },
            hp: 40, maxHp: 40, ac: 16, level: 5, resourcePools: { glory: { current: 0, max: 100 } }, createdAt: now, updatedAt: now
        } as any);
    }
    enc = (await manage({ action: 'create', worldId: W, ...(opts.seed ? { seed: opts.seed } : {}), participants: [
        ...(opts.mage ? [{ id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 50 }] : []),
        ...(opts.captain ? [{ id: 'captain', name: 'Captain', hp: 40, maxHp: 40, initiative: 60 }] : []),
        { id: 'drake', name: 'Drake', hp: 120, maxHp: 120, initiative: 40, hasLairActions: true, abilities: [{ name: 'Fire Breath', recharge: 5 }] },
        ...units
    ] })).r.encounterId;
}
/** Pin a spell's damage dice (the spell resolver rolls them on the encounter). */
const spellDice = (pattern: RegExp, total: number) => {
    const orig = CombatEngine.prototype.rollDice;
    vi.spyOn(CombatEngine.prototype, 'rollDice').mockImplementation(function (this: CombatEngine, n: string, t: any) {
        if (pattern.test(n)) return { notation: n, rolls: [total], diceTotal: total, modifier: 0, total } as any;
        return orig.call(this, n, t);
    });
};
const breath = (extra: Record<string, unknown> = {}) => manage({ action: 'use_ability', participantId: 'drake', ability: 'Fire Breath', targetIds: ['militia'], damage: 31, damageType: 'fire', savingThrow: { ability: 'dex', dc: 13 }, area: true, ...extra });

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('area damage on a unit token, per model (play report 7 #1)', () => {
    it('the Day 70 cone: each of six militia rolls its own save; 31 / 15 kills all six', async () => {
        await setup([MILITIA()]);
        d20s(20, 1, 1, 20, 1, 1);
        const { r } = await breath();
        expect(r.success).toBe(true);
        const t = r.targets[0];
        expect(t.unitArea).toMatchObject({ modelsBefore: 6, modelsInArea: 6, inAreaSource: 'packed', failed: 4, saved: 2, perModel: { full: 31, half: 15 }, modelsKilled: 6, modelsAfter: 0 });
        expect(t.unitArea.saves).toHaveLength(6);
        expect(t).toMatchObject({ damageTaken: 54, hpBefore: 54, hpAfter: 0 });
        expect(r.message).toContain('6 in the area: 4 failed, 2 saved; 31 / 15 vs 9 HP each: 6 dead, 0/6 left');
        expect(tok('militia').hp).toBe(0);
    });

    it("the saves are rolled on the fight's logged dice, one per model", async () => {
        await setup([MILITIA()]);
        // 12 over 9-HP models: a failed save takes 12 and dies, a success 6 and lives.
        const { r } = await breath({ damage: 12 });
        const ua = r.targets[0].unitArea;
        expect(ua.failed + ua.saved).toBe(6);
        expect(ua.modelsKilled).toBe(ua.failed);
        expect(ua.modelsAfter).toBe(ua.saved);
        expect(tok('militia').hp).toBe(54 - 9 * ua.failed);
        const logged = modelSaves();
        expect(logged).toHaveLength(6);
        expect(logged.map((x: any) => x.purpose).sort()).toEqual([1, 2, 3, 4, 5, 6].map(i => `Fire Breath save (model ${i}/6)`).sort());
        expect(new Set(logged.map((x: any) => x.for_id))).toEqual(new Set(['militia']));
    });

    it('a 12-point area splits on the saves: the saved live, the failed die', async () => {
        await setup([MILITIA()]);
        d20s(20, 1, 20, 1, 1, 20);
        const { r } = await breath({ damage: 12 });
        expect(r.targets[0].unitArea).toMatchObject({ failed: 3, saved: 3, perModel: { full: 12, half: 6 }, modelsKilled: 3, modelsAfter: 3 });
        expect(r.targets[0].damageTaken).toBe(27);
        expect(tok('militia').hp).toBe(27);
        expect(liveModels(tok('militia'))).toBe(3);
    });

    it('the wounded front model dies to what it has left; the rest saved and stand', async () => {
        await setup([MILITIA()]);
        await manage({ action: 'adjust_hp', participantId: 'militia', delta: -4, reason: 'earlier arrow' });
        d20s(20, 20, 20, 20, 20, 20);
        const { r } = await breath({ damage: 12 });
        expect(r.targets[0].unitArea).toMatchObject({ frontHp: 5, saved: 6, modelsKilled: 1, modelsAfter: 5 });
        expect(tok('militia').hp).toBe(45);
        expect(r.message).toContain('(front 5)');
    });

    it('an area with no save: every model inside takes the full damage (apply_damage area: true)', async () => {
        await setup([MILITIA()]);
        const before = rollCount();
        const { r } = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 10, source: 'falling rubble', area: true });
        expect(r.targets[0].unitArea).toMatchObject({ noSave: true, failed: 0, saved: 0, modelsInArea: 6, modelsKilled: 6, modelsAfter: 0 });
        expect(r.message).toContain('6 in the area, no save: 10 vs 9 HP each: 6 dead');
        expect(rollCount()).toBe(before);
    });

    it('lair_action is an area by default', async () => {
        await setup([MILITIA()]);
        await toLair();
        const lair = await manage({ action: 'lair_action', actionDescription: 'the gatehouse burns', targetIds: ['militia'], damage: 10, damageType: 'fire' });
        expect(lair.text).toContain('6 in the area, no save: 10 vs 9 HP each: 6 dead');
        expect(tok('militia').hp).toBe(0);
    });

    it('lair_action area: false hits one model at most', async () => {
        await setup([MILITIA()]);
        await toLair();
        const lair = await manage({ action: 'lair_action', actionDescription: 'a beam falls', targetIds: ['militia'], damage: 30, area: false });
        expect(lair.text).toMatch(/one model at most: 30 → 9/);
        expect(tok('militia').hp).toBe(45);
    });

    it('an area with no damage and no save needs no count: a narrative lair action on a spaced unit', async () => {
        await setup([LINE()]);
        await toLair();
        const lair = await manage({ action: 'lair_action', actionDescription: 'fog rolls over the line', targetIds: ['line'] });
        expect(lair.r.error).toBeUndefined();
        expect(lair.text).toMatch(/narrative only/);
    });

    it('damage that is not an area hits one model: apply_damage and use_ability without area', async () => {
        await setup([MILITIA()]);
        const bite = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 31, source: 'a bite' });
        expect(bite.r.targets[0]).toMatchObject({ damageTaken: 9, hpAfter: 45, unitCap: { before: 31, after: 9 } });
        expect(bite.r.message).toMatch(/one model at most: 31 → 9/);
        expect(bite.r.targets[0].unitArea).toBeUndefined();
        d20s(1);
        const tail = await breath({ area: undefined });
        expect(tail.r.targets[0]).toMatchObject({ damageTaken: 9, hpAfter: 36 });
        expect(tail.r.targets[0].unitArea).toBeUndefined();
    });

    it('a spaced unit needs modelsInArea: refused before anything is rolled or spent', async () => {
        await setup([LINE()]);
        const before = rollCount();
        const { r } = await manage({ action: 'use_ability', participantId: 'drake', ability: 'Fire Breath', targetIds: ['line'], damage: '4d6', savingThrow: { ability: 'dex', dc: 13 }, area: true });
        expect(r.error).toBe(true);
        expect(r.writes).toBe('none');
        expect(r.message).toMatch(/Line is spaced/);
        expect(r.message).toMatch(/modelsInArea: \{'line': /);
        expect(r.modelsInAreaNeeded).toEqual([{ targetId: 'line', name: 'Line', liveModels: 10 }]);
        expect(rollCount()).toBe(before);
        expect(tok('line').hp).toBe(50);
        expect(tok('drake').actionUsed).toBeFalsy();
        expect(tok('drake').abilities[0].ready).not.toBe(false);
        // The same on apply_damage and lair_action.
        const ad = await manage({ action: 'apply_damage', targetIds: ['line'], dice: 10, source: 'scree', area: true });
        expect(ad.r).toMatchObject({ error: true, writes: 'none' });
        await toLair();
        const lair = await manage({ action: 'lair_action', actionDescription: 'scree', targetIds: ['line'], damage: '2d6' });
        expect(lair.r.error).toBe(true);
        expect(lair.r.writes).toBe('none');
        expect(rollCount()).toBe(before);
        expect(tok('line').hp).toBe(50);
    });

    it('a spaced unit with modelsInArea {id: n}: only those models are inside', async () => {
        await setup([LINE()]);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['line'], dice: 10, source: 'scree', modelsInArea: { line: 2 } });
        expect(r.targets[0].unitArea).toMatchObject({ modelsBefore: 10, modelsInArea: 2, inAreaSource: 'given', modelsKilled: 2, modelsAfter: 8 });
        expect(r.message).toContain('2 of 10 in the area, no save');
        expect(tok('line').hp).toBe(40);
        // A number applies to every unit target; more than are standing is capped.
        const all = await manage({ action: 'apply_damage', targetIds: ['line'], dice: 10, source: 'scree', modelsInArea: 30 });
        expect(all.r.targets[0].unitArea).toMatchObject({ modelsBefore: 8, modelsInArea: 8, modelsKilled: 8 });
    });

    it("the save bonus is the token's abilityScores plus unit.saves", async () => {
        await setup([MILITIA({}, { saves: { dex: 2 } })]);
        patchTok('militia', { abilityScores: { strength: 12, dexterity: 13, constitution: 12, intelligence: 9, wisdom: 10, charisma: 9 } });
        d20s(10, 10, 10, 10, 10, 10);
        const { r } = await breath({ damage: 12 });
        // d20 10 + DEX +1 + drilled +2 = 13 vs DC 13: every model saves.
        expect(r.targets[0].unitArea).toMatchObject({ saved: 6, failed: 0, modelsKilled: 0, saveBonus: { ability: 'dexterity', total: 3 } });
        expect(r.targets[0].unitArea.saves.every((s: any) => s.total === 13 && s.saved)).toBe(true);
        expect(r.message).toMatch(/DEX \+1, drilled \+2/);
    });

    it('the break test reads the real count; a packed wipe owes none', async () => {
        await setup([LINE(), MILITIA()]);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['line', 'militia'], dice: 10, source: 'grapeshot', modelsInArea: { line: 5 } });
        expect(r.breakTests).toHaveLength(1);
        expect(r.breakTests[0]).toMatchObject({ participantId: 'line', modelsBefore: 10, modelsAfter: 5 });
        expect(r.message).toMatch(/BREAK TEST DUE: Line fell to 5\/10 models/);
        expect(tok('militia').hp).toBe(0);
    });

    it('seeded: the same seed replays the same saves model by model', async () => {
        const run = async () => {
            await setup([MILITIA()], { seed: 'day-70-cone' });
            const { r } = await breath({ damage: 12 });
            return r.targets[0].unitArea.saves.map((s: any) => [s.natural, s.saved]);
        };
        const a = await run();
        const b = await run();
        expect(a).toHaveLength(6);
        expect(b).toEqual(a);
    });
});

describe('cast_spell on a unit token (play report 7 #1)', () => {
    it("an area spell (Burning Hands, a 15-ft cone) goes model by model on the caster's DC", async () => {
        await setup([MILITIA()], { mage: true });
        spellDice(/^3d6$/, 12);
        // DC 15 (INT +4, proficiency +3): 20 saves, 1 fails.
        d20s(20, 1, 20, 1, 1, 20);
        const { text, r } = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Burning Hands', targetIds: ['militia'] });
        expect(r.unitAreas?.[0]).toMatchObject({ targetId: 'militia', shape: 'cone', modelsInArea: 6, failed: 3, saved: 3, perModel: { full: 12, half: 6 }, modelsKilled: 3, modelsAfter: 3 });
        expect(text).toContain('6 in the cone: 3 failed, 3 saved; 12 / 6 vs 9 HP each: 3 dead, 3/6 left');
        expect(tok('militia').hp).toBe(27);
        expect(r.breakTests?.[0]).toMatchObject({ participantId: 'militia', modelsAfter: 3 });
    });

    it('the Day 70 numbers through Fireball: 31 over six 9-HP militia, all six die', async () => {
        await setup([MILITIA()], { mage: true });
        spellDice(/^8d6$/, 31);
        const { text, r } = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Fireball', targetIds: ['militia'] });
        expect(r.unitAreas?.[0]).toMatchObject({ shape: 'sphere', modelsKilled: 6, modelsAfter: 0, perModel: { full: 31, half: 15 } });
        expect(text).toMatch(/6 in the sphere: \d failed, \d saved; 31 \/ 15 vs 9 HP each: 6 dead/);
        expect(tok('militia').hp).toBe(0);
        expect(modelSaves()).toHaveLength(6);
    });

    it('an area spell on a spaced unit without modelsInArea is refused before the slot is spent', async () => {
        await setup([LINE()], { mage: true });
        const slots = JSON.stringify(new CharacterRepository(getDb()).findById('mage')!.spellSlots);
        const before = rollCount();
        const { d } = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Fireball', targetIds: ['line'] });
        expect(d.error).toBe(true);
        expect(d.writes).toBe('none');
        expect(String(d.message)).toMatch(/Line is spaced/);
        expect(rollCount()).toBe(before);
        expect(JSON.stringify(new CharacterRepository(getDb()).findById('mage')!.spellSlots)).toBe(slots);
        expect(tok('mage').actionUsed).toBeFalsy();
        expect(tok('line').hp).toBe(50);
    });

    it('an area spell on a spaced unit with modelsInArea: only those models', async () => {
        await setup([LINE()], { mage: true });
        spellDice(/^8d6$/, 30);
        const { r } = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Fireball', targetIds: ['line'], modelsInArea: { line: 5 } });
        expect(r.unitAreas?.[0]).toMatchObject({ modelsInArea: 5, inAreaSource: 'given', modelsKilled: 5, modelsAfter: 5 });
        expect(tok('line').hp).toBe(25);
        expect(r.breakTests?.[0]).toMatchObject({ participantId: 'line', modelsAfter: 5 });
    });

    it('a single-target spell (Fire Bolt) on a unit takes one model at most', async () => {
        await setup([MILITIA()], { mage: true });
        spellDice(/d10/, 15);
        vi.spyOn(CombatEngine.prototype, 'rollSpellAttackD20').mockReturnValue({ natural: 15, rolls: [15], advantage: false, disadvantage: false, situational: [] } as any);
        const { text, r } = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Fire Bolt', targetId: 'militia' });
        expect(tok('militia').hp).toBe(45);
        expect(r.unitCaps?.[0]).toMatchObject({ targetId: 'militia', before: 15, after: 9 });
        expect(text).toMatch(/one model at most: 15 → 9/);
        expect(r.unitAreas).toBeUndefined();
    });
});

describe('kill credit from the real count (play report 7 #1)', () => {
    const withCaptain = async (units: any[]) => {
        await setup(units, { captain: true });
        const r = await handleTableRules({ action: 'define', worldId: W, kind: 'growth_track', name: 'Glory', spec: { pool: 'glory', perKill: 2, steps: [{ at: 50, condition: { name: 'Veteran' } }] } }, ctx as any);
        if (r.content[0].text.includes('"error":true')) throw new Error(r.content[0].text);
    };
    const glory = () => ((new CharacterRepository(getDb()).findById('captain') as any).resourcePools.glory.current as number);

    it('apply_damage with an actor credits one kill per model the area killed', async () => {
        await withCaptain([MILITIA()]);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 10, source: 'grenade', actorId: 'captain', modelsInArea: { militia: 4 } });
        expect(r.targets[0].unitArea).toMatchObject({ modelsKilled: 4, modelsAfter: 2 });
        expect(r.growth?.[0]).toMatchObject({ victimId: 'militia', modelsKilled: 4, track: 'Glory', delta: 8, from: 0, to: 8, reason: 'kill: 4 × Militia' });
        expect(r.message).toMatch(/GROWTH Glory: glory 0 → 8 \(kill: 4 × Militia\)/);
        expect(glory()).toBe(8);
    });

    it('a blow that kills one model of a standing unit credits one kill', async () => {
        await withCaptain([MILITIA()]);
        const { r } = await act({ action: 'attack', actorId: 'captain', targetId: 'militia', outcome: 'hit', damage: 9 });
        expect(tok('militia').hp).toBe(45);
        expect(r.growth).toMatchObject({ track: 'Glory', delta: 2, from: 0, to: 2, reason: 'kill: Militia' });
        expect(glory()).toBe(2);
    });

    it('a blow that kills no model credits nothing', async () => {
        await withCaptain([MILITIA()]);
        await manage({ action: 'adjust_hp', participantId: 'militia', delta: -4, reason: 'arrow' });
        const { r } = await act({ action: 'attack', actorId: 'captain', targetId: 'militia', outcome: 'hit', damage: 4 });
        expect(tok('militia').hp).toBe(46);
        expect(r.growth).toBeUndefined();
        expect(glory()).toBe(0);
    });
});

describe('combat_map aoe reads every square of a token and hints modelsInArea (play report 7 #1)', () => {
    const aoe = async (args: Record<string, unknown>) => {
        const text = (await handleCombatMap({ action: 'aoe', encounterId: enc, ...args }, ctx as any)).content[0].text;
        return { text, r: tag(text, 'COMBAT_MAP') ?? JSON.parse(text) };
    };

    it('a line through the side of a big spaced unit finds it and counts the squares it covers', async () => {
        await setup([
            // Huge (3×3) at (4,4): squares x 4..6, y 4..6. Its anchor is off the line.
            { ...LINE(), size: 'huge', position: { x: 4, y: 4 }, unit: { models: 9, hpPerModel: 5, packed: false, attackBonus: 2 }, hp: 45, maxHp: 45 },
            // Large (2×2) packed at (1,4): squares x 1..2, y 4..5.
            { ...MILITIA(), size: 'large', position: { x: 1, y: 4 } }
        ]);
        const { text, r } = await aoe({ shape: 'line', origin: { x: 0, y: 5 }, direction: { x: 1, y: 0 }, length: 5 });
        const line = r.affectedParticipants.find((p: any) => p.id === 'line');
        expect(line).toMatchObject({ cellsInside: 2, footprint: 9, unit: { packed: false, liveModels: 9, modelsInArea: 2 } });
        const militia = r.affectedParticipants.find((p: any) => p.id === 'militia');
        expect(militia).toMatchObject({ cellsInside: 2, footprint: 4, unit: { packed: true, liveModels: 6, modelsInArea: 6 } });
        expect(r.modelsInArea).toEqual({ line: 2, militia: 6 });
        expect(text).toMatch(/modelsInArea: \{('line': 2, 'militia': 6|'militia': 6, 'line': 2)\}/);
        expect(text).toMatch(/Line at \(4, 4\) — 2\/9 squares; unit spaced, 2 of 9 models inside/);
    });

    it('a medium token is found on its square as before', async () => {
        await setup([{ id: 'grot', name: 'Grot', hp: 7, maxHp: 7, initiative: 3, isEnemy: true, position: { x: 3, y: 5 } }]);
        const { r } = await aoe({ shape: 'line', origin: { x: 0, y: 5 }, direction: { x: 1, y: 0 }, length: 5 });
        expect(r.affectedParticipants.find((p: any) => p.id === 'grot')).toMatchObject({ cellsInside: 1, footprint: 1 });
        expect(r.modelsInArea).toBeUndefined();
    });
});
