/**
 * Play report 7 follow-up, lane W (owner's answer: "Track each model's
 * wounds. Pick option 1."): a unit token remembers each model's wounds.
 *
 *  - unit.wounded holds the current HP of each wounded live model (below
 *    hpPerModel), most wounded first; unhurt models are implicit, so
 *    hp = unhurt × hpPerModel + Σ wounded. A legacy unit with no list reads
 *    its pool the old way: a remainder below hpPerModel is one wounded model.
 *  - Repeated damage adds up: 5 twice kills a 9-HP model; a model that saved
 *    half against one area is already hurt when the next comes.
 *  - A single blow kills one model at most, starting with the most wounded,
 *    and below that model's HP it wounds it.
 *  - Volleys, cleave and GM spreads keep overflow: most wounded first, then
 *    the unhurt, killing in order. Healing restores the most wounded first;
 *    what is left over revives models.
 *  - The reply is compact: "4 alive: 2 unhurt, 1 at 5/9, 1 at 2/9".
 */
import {
    modelHps, liveModels, woundLine, applyToModels, spreadOnModels, healModels, setUnitHp,
    unitCapFor, breakTestDue, areaOnUnit, volleyTier, mobAttackBonus, moraleModifiers, describeUnit
} from '../../src/engine/combat/units.js';
import { unitCapFor as reexportedCap, unitCapLine, modelsKilledBetween } from '../../src/engine/combat/unit-area.js';
import { UnitSchema } from '../../src/schema/token-extras.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { shapeReply } from '../../src/server/output-mode.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';

process.env.NODE_ENV = 'test';

const unitTok = (hp: number, unit: Record<string, unknown> = {}): any => ({
    id: 'militia', name: 'Militia', hp, maxHp: 54,
    unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 0, ...unit }
});

describe('the wound list (pure)', () => {
    it('a legacy unit reads its pool: a remainder below hpPerModel is one wounded model', () => {
        expect(modelHps(unitTok(54))).toEqual([9, 9, 9, 9, 9, 9]);
        expect(modelHps(unitTok(50))).toEqual([5, 9, 9, 9, 9, 9]);
        expect(liveModels(unitTok(50))).toBe(6);
        expect(modelHps(unitTok(0))).toEqual([]);
        expect(woundLine(unitTok(50))).toBe('6 alive: 5 unhurt, 1 at 5/9');
        expect(woundLine(unitTok(54))).toBe('6 alive: 6 unhurt');
    });

    it('the list counts the models: liveModels reads it, not ceil(hp / hpPerModel)', () => {
        // Three models at 3: 9 HP in the pool, which the old reading took for one model.
        const p = unitTok(9, { wounded: [3, 3, 3] });
        expect(modelHps(p)).toEqual([3, 3, 3]);
        expect(liveModels(p)).toBe(3);
        expect(woundLine(p)).toBe('3 alive: 3 at 3/9');
        // Unhurt models are implicit: 2 unhurt + 5 + 2 = 25.
        const q = unitTok(25, { wounded: [2, 5] });
        expect(modelHps(q)).toEqual([2, 5, 9, 9]);
        expect(woundLine(q)).toBe('4 alive: 2 unhurt, 1 at 5/9, 1 at 2/9');
        // A list out of step with the pool (a writer that did not route through
        // the helpers) falls back to the pool's own reading.
        expect(modelHps(unitTok(20, { wounded: [3, 3, 3] }))).toEqual([2, 9, 9]);
    });

    it('a big unit reads compactly, equal wounds grouped', () => {
        const big = { id: 'tide', name: 'Tide', hp: 40 * 9 - 4 - 4 - 7, unit: { models: 40, hpPerModel: 9, packed: true, attackBonus: 0, wounded: [2, 5, 5] } } as any;
        expect(woundLine(big)).toBe('40 alive: 37 unhurt, 2 at 5/9, 1 at 2/9');
        expect(describeUnit(big)).toMatch(/×40\/40 packed · volley 4d6 · 37 unhurt, 2 at 5\/9, 1 at 2\/9/);
    });

    it('5 twice kills a 9-HP model; the pool and the list agree after each', () => {
        const p = unitTok(54);
        const first = applyToModels(p, [5, 5, 5, 5, 5, 5]);
        expect(first).toMatchObject({ killed: 0, absorbed: 30, modelsBefore: 6, modelsAfter: 6, hpBefore: 54, hpAfter: 24 });
        expect(p.hp).toBe(24);
        expect(p.unit.wounded).toEqual([4, 4, 4, 4, 4, 4]);
        const second = applyToModels(p, [5, 5, 5, 5, 5, 5]);
        expect(second).toMatchObject({ killed: 6, absorbed: 24, modelsAfter: 0 });
        expect(p.hp).toBe(0);
        expect(p.unit.wounded).toBeUndefined();
    });

    it('an area takes the most wounded inside first; each model dies when its damage meets its HP, else keeps the wound', () => {
        // 12 over six 9-HP models: the three that save take 6 and stand on 3.
        const p = unitTok(54);
        const r = areaOnUnit(p, { damage: 12, modelsInArea: 6, saves: [true, false, true, false, false, true] });
        expect(r).toMatchObject({ modelsKilled: 3, modelsAfter: 3, hpLost: 45, standing: { saved: 3, failed: 0 } });
        expect(r.modelDamage).toEqual([6, 12, 6, 12, 12, 6]);
        // Pure: nothing written yet.
        expect(p.hp).toBe(54);
        applyToModels(p, r.modelDamage);
        expect(p.hp).toBe(9);
        expect(liveModels(p)).toBe(3);
        // The next area of 4 finishes them: each saved model is already burned.
        const next = areaOnUnit(p, { damage: 4, modelsInArea: 3 });
        expect(next).toMatchObject({ modelsBefore: 3, modelsKilled: 3, modelsAfter: 0, hpLost: 9 });
    });

    it('a partial area takes the most wounded models first', () => {
        const p = unitTok(25, { wounded: [2, 5] });
        const r = areaOnUnit(p, { damage: 3, modelsInArea: 2 });
        // The models on 2 and 5 are inside: 2 dies, 5 drops to 2.
        expect(r).toMatchObject({ modelsInArea: 2, modelsKilled: 1, modelsAfter: 3, hpLost: 5 });
        applyToModels(p, r.modelDamage);
        expect(modelHps(p)).toEqual([2, 9, 9]);
    });

    it('a single blow takes the most wounded model, capped at its HP; below that it wounds it', () => {
        const p = unitTok(25, { wounded: [2, 5] });
        expect(unitCapFor(p, 30)).toEqual({ damage: 2, cap: { before: 30, after: 2 } });
        expect(reexportedCap).toBe(unitCapFor);
        expect(unitCapLine({ before: 30, after: 2 })).toMatch(/one model at most: 30 → 2/);
        spreadOnModels(p, unitCapFor(p, 30).damage);
        expect(modelHps(p)).toEqual([5, 9, 9]);
        spreadOnModels(p, unitCapFor(p, 3).damage);
        expect(modelHps(p)).toEqual([2, 9, 9]);
    });

    it('a spread (volley, cleave, a GM correction) keeps overflow: most wounded first, killing in order', () => {
        const p = unitTok(25, { wounded: [2, 5] });
        const r = spreadOnModels(p, 10);
        // 2 dies (8 left), 5 dies (3 left), an unhurt model drops to 6.
        expect(r).toMatchObject({ killed: 2, absorbed: 10, modelsBefore: 4, modelsAfter: 2 });
        expect(modelHps(p)).toEqual([6, 9]);
        expect(p.hp).toBe(15);
    });

    it('healing restores the most wounded first; beyond every wound it revives models', () => {
        const p = unitTok(25, { wounded: [2, 5] });
        healModels(p, 4);
        expect(modelHps(p)).toEqual([5, 6, 9, 9]);
        healModels(p, 10);
        // 5 → 9 (4), 6 → 9 (3), then 3 more revive one model on 3.
        expect(modelHps(p)).toEqual([3, 9, 9, 9, 9]);
        expect(p.hp).toBe(39);
        // Never past full strength.
        healModels(p, 100);
        expect(modelHps(p)).toEqual([9, 9, 9, 9, 9, 9]);
        expect(p.hp).toBe(54);
        expect(p.unit.wounded).toBeUndefined();
    });

    it('setUnitHp: a lower pool spreads, a higher one heals', () => {
        const p = unitTok(25, { wounded: [2, 5] });
        setUnitHp(p, 20);
        expect(modelHps(p)).toEqual([2, 9, 9]);
        setUnitHp(p, 24);
        expect(modelHps(p)).toEqual([6, 9, 9]);
    });

    it('the readers follow the list: volley tier, mob rule, morale', () => {
        const p = { ...unitTok(9, { wounded: [3, 3, 3], mobRule: { per: 3, attackBonusPer: 3 } }), id: 'm', name: 'M' };
        expect(volleyTier(p)!.models).toBe(3);
        // 3 of 6 is half strength: 3d6 (the old pool reading saw 1 model: 1d6).
        expect(volleyTier(p)!.dice).toBe('3d6');
        expect(mobAttackBonus(p)).toEqual({ bonus: 1, models: 3 });
        expect(moraleModifiers(p)).toEqual([{ label: 'mob rule (3 models)', value: 1 }]);
    });

    it('the break test and the kill count read the real count before and after', () => {
        // Ten 5-HP models, six on 2 after an earlier area.
        const p = { id: 'line', name: 'Line', hp: 32, maxHp: 50, unit: { models: 10, hpPerModel: 5, packed: false, attackBonus: 0, morale: 7, wounded: [2, 2, 2, 2, 2, 2] } } as any;
        expect(liveModels(p)).toBe(10);
        const hpBefore = p.hp;
        const r = areaOnUnit(p, { damage: 2, modelsInArea: 6 });
        applyToModels(p, r.modelDamage);
        expect(liveModels(p)).toBe(4);
        expect(breakTestDue(p, hpBefore)).toMatchObject({ modelsBefore: 10, modelsAfter: 4 });
        expect(modelsKilledBetween(p.unit, hpBefore, p.hp)).toBe(6);
    });

    it('UnitSchema takes wounded as whole numbers of at least 1', () => {
        expect(UnitSchema.parse({ models: 6, hpPerModel: 9, wounded: [5, 2] }).wounded).toEqual([5, 2]);
        expect(UnitSchema.parse({ models: 6, hpPerModel: 9 })).not.toHaveProperty('wounded');
        expect(() => UnitSchema.parse({ models: 6, hpPerModel: 9, wounded: [0] })).toThrow();
        expect(() => UnitSchema.parse({ models: 6, hpPerModel: 9, wounded: [1.5] })).toThrow();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// In play
// ─────────────────────────────────────────────────────────────────────────

const ctx = { sessionId: 'unscoped' };
const W = 'blackcrown';
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const guardedAction = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
let enc: string;
const manageRaw = (args: Record<string, unknown>) => guardedManage(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }));
const manage = async (args: Record<string, unknown>) => {
    const text = (await manageRaw(args)).content[0].text;
    return { text, r: tag(text, 'COMBAT_MANAGE') ?? { rawText: text } };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await guardedAction(CombatActionTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, d, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };
const summary = (res: any) => JSON.parse(shapeReply(res, { mode: 'summary' }).content![0].text);

const MILITIA = (unit: Record<string, unknown> = {}) => ({
    id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, ac: 11,
    unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 2, morale: 6, ...unit }
});
const LINE = () => ({
    id: 'line', name: 'Line', hp: 50, maxHp: 50, initiative: 4, isEnemy: true, ac: 11,
    unit: { models: 10, hpPerModel: 5, packed: false, attackBonus: 2, morale: 7 }
});

async function setup(units: any[], opts: { captain?: boolean } = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
    if (opts.captain) {
        new CharacterRepository(db).create({
            id: 'captain', name: 'Captain', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 12 },
            hp: 40, maxHp: 40, ac: 16, level: 5, resourcePools: { glory: { current: 0, max: 100 } }, createdAt: now, updatedAt: now
        } as any);
    }
    enc = (await manage({ action: 'create', worldId: W, participants: [
        ...(opts.captain ? [{ id: 'captain', name: 'Captain', hp: 40, maxHp: 40, initiative: 60 }] : []),
        { id: 'drake', name: 'Drake', hp: 120, maxHp: 120, initiative: 40, abilities: [{ name: 'Fire Breath', recharge: 5 }] },
        { id: 'guard', name: 'Guard', hp: 40, maxHp: 40, initiative: 30, unit: { models: 4, hpPerModel: 10, packed: true, attackBonus: 20 } },
        ...units
    ] })).r.encounterId;
}
const breath = (extra: Record<string, unknown> = {}) => manage({ action: 'use_ability', participantId: 'drake', ability: 'Fire Breath', targetIds: ['militia'], damage: 12, damageType: 'fire', savingThrow: { ability: 'dex', dc: 13 }, area: true, ...extra });

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('wounds in play (play report 7 follow-up, lane W)', () => {
    it('five a round never drowned anyone; now two areas of 5 kill every 9-HP model', async () => {
        await setup([MILITIA()]);
        const first = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 5, source: 'deep water', area: true });
        expect(first.r.targets[0].unitArea).toMatchObject({ modelsKilled: 0, modelsAfter: 6 });
        expect(first.r.targets[0]).toMatchObject({ damageTaken: 30, hpBefore: 54, hpAfter: 24 });
        expect(first.r.message).toContain('0 dead, 6/6 left (6 at 4/9)');
        expect(tok('militia').unit.wounded).toEqual([4, 4, 4, 4, 4, 4]);
        const second = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 5, source: 'deep water', area: true });
        expect(second.r.targets[0].unitArea).toMatchObject({ modelsBefore: 6, modelsKilled: 6, modelsAfter: 0 });
        expect(tok('militia').hp).toBe(0);
    });

    it("a militiaman who saved half against the breath is already burned when the next blast comes", async () => {
        await setup([MILITIA()]);
        // 12 fire: three fail and die, three save, take 6 and stand on 3.
        d20s(20, 1, 20, 1, 1, 20);
        const first = await breath();
        expect(first.r.targets[0].unitArea).toMatchObject({ failed: 3, saved: 3, modelsKilled: 3, modelsAfter: 3 });
        expect(first.r.targets[0].damageTaken).toBe(45);
        expect(tok('militia').hp).toBe(9);
        expect(tok('militia').unit.wounded).toEqual([3, 3, 3]);
        expect(first.r.message).toContain('3 dead, 3/6 left (3 at 3/9)');
        // Next blast (the breath is spent: the same fire as apply_damage): all
        // three save and take 6, which the wounded cannot stand.
        d20s(20, 20, 20);
        const next = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 12, damageType: 'fire', source: 'second blast', area: true, save: { ability: 'dex', dc: 13 } });
        expect(next.r.targets[0].unitArea).toMatchObject({ modelsBefore: 3, saved: 3, modelsKilled: 3, modelsAfter: 0 });
        expect(next.r.message).toContain('(wounded first: 3 at 3/9)');
        expect(tok('militia').hp).toBe(0);
    });

    it('a single blow finishes the most wounded model first', async () => {
        await setup([MILITIA()], { captain: true });
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [2, 5] });
        expect(tok('militia').hp).toBe(43);
        const blow = await act({ action: 'attack', actorId: 'captain', targetId: 'militia', outcome: 'hit', damage: 30 });
        expect(blow.text).toMatch(/one model at most: 30 → 2/);
        expect(tok('militia').hp).toBe(41);
        expect(tok('militia').unit.wounded).toEqual([5]);
        expect(blow.text).toMatch(/UNIT Militia: ×5\/6 packed · volley \dd6 · 4 unhurt, 1 at 5\/9/);
        expect(blow.r.targetUnit).toMatchObject({ models: 5, maxModels: 6, wounds: '5 alive: 4 unhurt, 1 at 5/9' });
    });

    it('a blow that kills a wounded model credits one kill', async () => {
        await setup([MILITIA()], { captain: true });
        const r = await handleTableRules({ action: 'define', worldId: W, kind: 'growth_track', name: 'Glory', spec: { pool: 'glory', perKill: 2, steps: [{ at: 50, condition: { name: 'Veteran' } }] } }, ctx as any);
        expect(r.content[0].text).not.toContain('"error":true');
        // Three wounded models on 3: one blow of 3 finishes one of them.
        d20s(20, 1, 20, 1, 1, 20);
        await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 12, source: 'fire', area: true, save: { ability: 'dex', dc: 13 } });
        expect(tok('militia').hp).toBe(9);
        const { r: hit } = await act({ action: 'attack', actorId: 'captain', targetId: 'militia', outcome: 'hit', damage: 3 });
        expect(tok('militia').hp).toBe(6);
        expect(liveModels(tok('militia'))).toBe(2);
        expect(hit.growth).toMatchObject({ track: 'Glory', delta: 2, reason: 'kill: Militia' });
    });

    it('a volley spreads in order: most wounded first, then the unhurt', async () => {
        await setup([MILITIA()]);
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [2, 5] });
        await act({ action: 'volley', actorId: 'guard', targetId: 'militia', outcome: 'hit', damage: 10 });
        // 2 and 5 die (7), an unhurt model takes the last 3.
        expect(tok('militia').hp).toBe(33);
        expect(tok('militia').unit.wounded).toEqual([6]);
        expect(liveModels(tok('militia'))).toBe(4);
    });

    it('adjust_hp spreads a loss most wounded first and heals a gain most wounded first', async () => {
        await setup([MILITIA()]);
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [2, 5] });
        const down = await manage({ action: 'adjust_hp', participantId: 'militia', delta: -3, reason: 'arrows' });
        expect(down.r).toMatchObject({ before: 43, after: 40 });
        expect(tok('militia').unit.wounded).toEqual([4]);
        expect(down.r.wounds).toBe('5 alive: 4 unhurt, 1 at 4/9');
        const up = await manage({ action: 'adjust_hp', participantId: 'militia', delta: 8, reason: 'a chirurgeon' });
        // 4 → 9 takes 5, the last 3 revive a model on 3.
        expect(up.r.after).toBe(48);
        expect(tok('militia').unit.wounded).toEqual([3]);
        expect(liveModels(tok('militia'))).toBe(6);
    });

    it('healing a unit restores the most wounded first', async () => {
        await setup([MILITIA()]);
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [2, 5] });
        await act({ action: 'heal', actorId: 'drake', targetId: 'militia', amount: 4 });
        expect(tok('militia').unit.wounded).toEqual([5, 6]);
        expect(tok('militia').hp).toBe(47);
    });

    it('break tests read the real count: the second area kills the wounded and crosses the line', async () => {
        await setup([LINE()]);
        const first = await manage({ action: 'apply_damage', targetIds: ['line'], dice: 3, source: 'grapeshot', modelsInArea: { line: 6 } });
        expect(first.r.targets[0].unitArea).toMatchObject({ modelsKilled: 0, modelsAfter: 10 });
        expect(first.r.breakTests ?? []).toHaveLength(0);
        // Six on 2: two more points kill those six (the most wounded are inside first).
        const second = await manage({ action: 'apply_damage', targetIds: ['line'], dice: 2, source: 'grapeshot', modelsInArea: { line: 6 } });
        expect(second.r.targets[0].unitArea).toMatchObject({ modelsBefore: 10, modelsKilled: 6, modelsAfter: 4 });
        expect(second.r.breakTests[0]).toMatchObject({ participantId: 'line', modelsBefore: 10, modelsAfter: 4 });
        expect(second.r.message).toMatch(/BREAK TEST DUE: Line fell to 4\/10 models/);
    });

    it('the wounds survive a fresh process: the encounter row holds them', async () => {
        await setup([MILITIA()]);
        d20s(20, 1, 20, 1, 1, 20);
        await breath();
        clearCombatState();
        expect(tok('militia').unit.wounded).toEqual([3, 3, 3]);
        const view = await manage({ action: 'get' });
        const m = view.r.participants.find((p: any) => p.id === 'militia');
        expect(m.unit).toMatchObject({ liveModels: 3, wounds: '3 alive: 3 at 3/9' });
        clearCombatState();
        // A 4-point area with no save finishes all three in a new process.
        const next = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 4, source: 'embers', area: true });
        expect(next.r.targets[0].unitArea).toMatchObject({ modelsBefore: 3, modelsKilled: 3, modelsAfter: 0 });
    });

    it('the state view shows the wound line, not every model', async () => {
        await setup([MILITIA()]);
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [2, 5] });
        const view = await manage({ action: 'get' });
        const m = view.r.participants.find((p: any) => p.id === 'militia');
        expect(m.unit.wounds).toBe('6 alive: 4 unhurt, 1 at 5/9, 1 at 2/9');
        expect(m.unit).not.toHaveProperty('wounded');
        expect(view.text).toMatch(/🪖 ×6\/6 packed · volley 4d6 · 4 unhurt, 1 at 5\/9, 1 at 2\/9/);
    });

    it('damage that is not an area finishes the most wounded model, and the target reports the wounds', async () => {
        await setup([MILITIA()]);
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [3, 3, 3] });
        const bite = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 31, source: 'a bite' });
        expect(bite.r.targets[0]).toMatchObject({ damageTaken: 3, unitCap: { before: 31, after: 3 }, wounds: '5 alive: 3 unhurt, 2 at 3/9' });
        expect(bite.r.message).toMatch(/one model at most: 31 → 3/);
        // Below the most wounded model's HP, the blow wounds it.
        const nick = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 2, source: 'a nick' });
        expect(nick.r.targets[0]).toMatchObject({ damageTaken: 2, wounds: '5 alive: 3 unhurt, 1 at 3/9, 1 at 1/9' });
    });

    it('a kill credit by count reads the wounded models an area finished', async () => {
        await setup([MILITIA()], { captain: true });
        const r = await handleTableRules({ action: 'define', worldId: W, kind: 'growth_track', name: 'Glory', spec: { pool: 'glory', perKill: 2, steps: [{ at: 50, condition: { name: 'Veteran' } }] } }, ctx as any);
        expect(r.content[0].text).not.toContain('"error":true');
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [3, 3, 3] });
        // Four points over every model: the three on 3 die, the three unhurt drop to 5.
        const { r: hit } = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 4, source: 'grenade', actorId: 'captain', area: true });
        expect(hit.targets[0].unitArea).toMatchObject({ modelsKilled: 3, modelsAfter: 3 });
        expect(hit.growth?.[0]).toMatchObject({ victimId: 'militia', modelsKilled: 3, delta: 6, reason: 'kill: 3 × Militia' });
    });

    it('a regenerating unit heals its most wounded models first at the start of its turn', async () => {
        await setup([{ ...MILITIA(), regeneration: 4 }]);
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [2, 5] });
        for (let i = 0; i < 4 && new EncounterRepository(getDb()).loadState(enc)!.turnOrder[new EncounterRepository(getDb()).loadState(enc)!.currentTurnIndex] !== 'militia'; i++) {
            await manage({ action: 'advance', confirm: true });
        }
        // 2 → 6 takes the 4: the model on 5 waits.
        expect(tok('militia').unit.wounded).toEqual([5, 6]);
        expect(tok('militia').hp).toBe(47);
    });

    it("output_mode 'summary' keeps the unit line with its wounds", async () => {
        await setup([MILITIA()]);
        d20s(20, 1, 20, 1, 1, 20);
        const res = await manageRaw({ action: 'use_ability', participantId: 'drake', ability: 'Fire Breath', targetIds: ['militia'], damage: 12, savingThrow: { ability: 'dex', dc: 13 }, area: true });
        expect(summary(res).unitLines).toEqual(['Militia — 6 in the area: 3 failed, 3 saved; 12 / 6 vs 9 HP each: 3 dead, 3/6 left (3 at 3/9); BREAK TEST DUE (morale 6)']);
    });
});

describe('set_unit {wounded} (play report 7 follow-up, lane W)', () => {
    it('sets the wounded models, keeps the live count and moves HP to match', async () => {
        await setup([MILITIA()]);
        const r = await manage({ action: 'set_unit', participantId: 'militia', wounded: [5, 2] });
        expect(r.r.success).toBe(true);
        // Sorted most wounded first; six live: four unhurt + 5 + 2.
        // Lane W review: the reply shows the wound line, not the raw list; the row holds it.
        expect(r.r.unit).not.toHaveProperty('wounded');
        expect(tok('militia').unit.wounded).toEqual([2, 5]);
        expect(r.r.wounds).toBe('6 alive: 4 unhurt, 1 at 5/9, 1 at 2/9');
        expect(tok('militia').hp).toBe(43);
        expect(liveModels(tok('militia'))).toBe(6);
        // An empty list heals every wound; the live count stays.
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [] });
        expect(tok('militia').hp).toBe(54);
        expect(tok('militia').unit.wounded).toBeUndefined();
    });

    it('refuses a value at or over hpPerModel, or more wounded than are standing, writing nothing', async () => {
        await setup([MILITIA()]);
        await manage({ action: 'adjust_hp', participantId: 'militia', delta: -27, reason: 'losses' });
        expect(liveModels(tok('militia'))).toBe(3);
        const high = await manage({ action: 'set_unit', participantId: 'militia', wounded: [9] });
        expect(high.r).toMatchObject({ error: true, writes: 'none' });
        expect(high.r.message).toMatch(/below hpPerModel \(9\)/);
        const many = await manage({ action: 'set_unit', participantId: 'militia', wounded: [1, 1, 1, 1] });
        expect(many.r).toMatchObject({ error: true, writes: 'none' });
        expect(many.r.message).toMatch(/3 standing/);
        expect(tok('militia').hp).toBe(27);
        expect(tok('militia').unit.wounded).toBeUndefined();
    });

    it('null clears the list (the pool reads the old way); a new strength resets it', async () => {
        await setup([MILITIA()]);
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [2, 5] });
        const cleared = await manage({ action: 'set_unit', participantId: 'militia', wounded: null });
        expect(cleared.r.success).toBe(true);
        expect(tok('militia').unit.wounded).toBeUndefined();
        expect(tok('militia').hp).toBe(43);
        expect(modelHps(tok('militia'))).toEqual([7, 9, 9, 9, 9]);
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [2, 5] });
        expect(tok('militia').hp).toBe(34);
        // A new hpPerModel resets it: the pool's own reading at the new size
        // (34 HP of 10-HP models: three unhurt and one on 4).
        const thicker = await manage({ action: 'set_unit', participantId: 'militia', hpPerModel: 10 });
        expect(thicker.r.success).toBe(true);
        expect(tok('militia').unit.wounded).toEqual([4]);
        expect(modelHps(tok('militia'))).toEqual([4, 10, 10, 10]);
    });

    it('reinforcing keeps the wounded: the new models arrive unhurt', async () => {
        await setup([MILITIA()]);
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [2, 5] });
        const r = await manage({ action: 'set_unit', participantId: 'militia', models: 8 });
        expect(r.r.reinforced).toMatchObject({ modelsBefore: 6, models: 8, added: 2, hpBefore: 43, hp: 61, liveModels: 8 });
        expect(tok('militia').unit.wounded).toEqual([2, 5]);
    });
});
