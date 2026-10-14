/**
 * Play report 7 follow-up, lane O: ongoing damage by shape.
 *
 * The owner's rule: "damage resolves by its shape, not by which code path
 * delivered it." Ongoing damage follows its source's shape:
 *  - burning or bleeding from a single-target hit stays on the one model it
 *    was applied to, and that model dies when it runs out (on a unit: the
 *    most wounded model takes each tick, capped at it; the condition ends
 *    when that model dies);
 *  - ongoing damage from an area ticks per model in the area, each with its
 *    own save if the effect has one; the recorded count drops by the models
 *    killed, and at 0 the condition ends.
 * The write road: `ongoing: {damage, damageType?, when: start | end, save?}`
 * on add_condition (area?, modelsInArea?), on save riders (an area rider on
 * a unit records the standing models inside; any other rider is single) and
 * on create's conditions. Every tick is rolled once on the fight's logged
 * dice, logged, and printed as a turn note and a turnDamage row.
 *
 * "An ongoing effect with save should use the plain-5e end-of-turn save (no
 * natural-20 or natural-1 steps), and Legendary Resistance should be offered
 * on it too, the same way": an offer of kind 'ongoing' with a saveRef whose
 * answer heals back the damage the success would have avoided. Per-model
 * saves on a unit never spend legendary resistance.
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { normalizeCondition, stampOngoingShape, type Condition } from '../../src/engine/combat/conditions.js';
import { answerLegendaryOffer } from '../../src/engine/combat/legendary-resistance.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { ConcentrationRepository } from '../../src/storage/repos/concentration.repo.js';
import { startConcentration } from '../../src/engine/magic/concentration.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { summarizeResult } from '../../src/server/output-mode.js';

process.env.NODE_ENV = 'test';

const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };
const noSides = (modifier?: { total: number; parts: string[] }) => () => ({ advantage: [], disadvantage: [], ...(modifier ? { modifier } : {}) });

afterEach(() => { vi.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────
// The write road: normalizeCondition carries `ongoing`
// ─────────────────────────────────────────────────────────────────────────

describe('ongoing on a condition (the input shape)', () => {
    it('ongoing becomes ongoingEffects: damage or dice, its type, when, the save; single by default', () => {
        const c = normalizeCondition({ name: 'burning', ongoing: { damage: '1d6', damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 12, onSuccess: 'end' } } } as never, 'kael')!;
        expect(c.ongoingEffects).toEqual([{
            type: 'damage', dice: '1d6', trigger: 'start_of_turn', damageType: 'fire',
            save: { ability: 'dexterity', dc: 12, onSuccess: 'end' }, shape: { kind: 'single' }
        }]);
        const n = normalizeCondition({ name: 'bleeding', ongoing: [{ damage: 2, when: 'end' }, { damage: '1d4', damageType: 'necrotic', when: 'start' }] } as never, 'kael')!;
        expect(n.ongoingEffects).toEqual([
            { type: 'damage', amount: 2, trigger: 'end_of_turn', shape: { kind: 'single' } },
            { type: 'damage', dice: '1d4', trigger: 'start_of_turn', damageType: 'necrotic', shape: { kind: 'single' } }
        ]);
    });

    it('stampOngoingShape records the area and its models on every ongoing effect', () => {
        const c = normalizeCondition({ name: 'choking', ongoing: { damage: 3, when: 'start' } } as never, 'm')!;
        stampOngoingShape(c, { kind: 'area', models: 4 });
        expect(c.ongoingEffects![0].shape).toEqual({ kind: 'area', models: 4 });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// The pure engine: one tick helper for both loops
// ─────────────────────────────────────────────────────────────────────────

const KAEL_TOKEN = () => ({ id: 'kael', name: 'Kael', initiativeBonus: 0, initiative: 20, hp: 40, maxHp: 40, conditions: [], isEnemy: false });
const ORC = (over: Record<string, unknown> = {}) => ({ id: 'orc', name: 'Orc', initiativeBonus: 0, initiative: 5, hp: 15, maxHp: 15, conditions: [], isEnemy: true, ...over });
const MILITIA = (over: Record<string, unknown> = {}) => ({
    id: 'militia', name: 'Militia', initiativeBonus: 0, initiative: 5, hp: 54, maxHp: 54, conditions: [], isEnemy: true,
    unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 0 }, ...over
});

function engineWith(tokens: Record<string, unknown>[], seed = 'o-engine') {
    const e = new CombatEngine(seed);
    e.startEncounter(tokens as never);
    e.drainRollRecords();
    return e;
}
const who = (e: CombatEngine, id: string) => e.getState()!.participants.find(p => p.id === id)!;
const give = (e: CombatEngine, id: string, input: Record<string, unknown>, shape?: { kind: 'single' } | { kind: 'area'; models: number }): Condition => {
    const c = normalizeCondition(input as never, id)!;
    if (shape) stampOngoingShape(c, shape);
    who(e, id).conditions.push(c);
    return c;
};

describe('a single-target tick on a creature', () => {
    it('ticks at the start of its turn: rolled once on the logged dice, a turn note and a turnDamage row', () => {
        const e = engineWith([KAEL_TOKEN(), ORC()]);
        const c = give(e, 'orc', { name: 'burning', ongoing: { damage: '1d4', damageType: 'fire', when: 'start' } });
        e.nextTurnWithConditions({ encounterId: 'enc-o' });
        const rolls = e.drainRollRecords().filter(r => r.purpose === 'ongoing burning');
        expect(rolls).toHaveLength(1);
        expect(rolls[0]).toMatchObject({ forId: 'orc' });
        const n = rolls[0].dice[0].value;
        const ev = e.turnDamage[0];
        expect(ev).toMatchObject({
            participantId: 'orc', name: 'Orc', source: 'ongoing', condition: 'burning', conditionId: c.id, when: 'start', shape: 'single',
            rolled: n, damage: n, damageType: 'fire', hpBefore: 15, hpAfter: 15 - n
        });
        expect(ev.line).toBe(`🔥 Orc — burning (start of turn): ${n} fire, HP 15 → ${15 - n}/15`);
        expect(e.turnStartNotes).toContain(ev.line);
        expect(who(e, 'orc').hp).toBe(15 - n);
    });

    it('ticks at the end of its turn when the effect says end', () => {
        const e = engineWith([KAEL_TOKEN(), ORC()]);
        give(e, 'kael', { name: 'bleeding', ongoing: { damage: 2, when: 'end' } });
        e.nextTurnWithConditions();
        expect(e.turnDamage[0]).toMatchObject({ participantId: 'kael', when: 'end', damage: 2, hpAfter: 38 });
        expect(e.turnDamage[0].line).toBe('🔥 Kael — bleeding (end of turn): 2 damage, HP 40 → 38/40');
    });

    it('resistance applies after the roll', () => {
        const e = engineWith([KAEL_TOKEN(), ORC({ resistances: ['fire'] })]);
        give(e, 'orc', { name: 'burning', ongoing: { damage: 4, damageType: 'fire', when: 'start' } });
        e.nextTurnWithConditions();
        expect(e.turnDamage[0]).toMatchObject({ rolled: 4, damage: 2, hpAfter: 13 });
        expect(e.turnDamage[0].line).toContain('2 fire (resistant, 4 rolled)');
    });

    it('the save is plain 5e: a natural 1 whose total meets the DC saves; onSuccess none takes nothing', () => {
        const e = engineWith([KAEL_TOKEN(), ORC()]);
        give(e, 'orc', { name: 'burning', ongoing: { damage: 4, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 13 } } });
        d20s(1);
        e.nextTurnWithConditions({ saverSides: noSides({ total: 12, parts: ['DEX +0', 'bonus +12'] }) });
        const ev = e.turnDamage[0];
        expect(ev.save).toMatchObject({ ability: 'dexterity', dc: 13, natural: 1, total: 13, saved: true });
        expect(ev).toMatchObject({ rolled: 4, damage: 0, hpAfter: 15 });
        expect(ev.line).toContain('DEX save d20 1 + 12 = 13 vs DC 13 (DEX +0, bonus +12) ✓ saved: no damage');
        expect(who(e, 'orc').conditions.map(c => c.type)).toEqual(['burning']);
    });

    it('onSuccess half halves; a failure takes it all', () => {
        const e = engineWith([KAEL_TOKEN(), ORC()]);
        give(e, 'orc', { name: 'burning', ongoing: { damage: 6, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 13, onSuccess: 'half' } } });
        d20s(18);
        e.nextTurnWithConditions();
        expect(e.turnDamage[0]).toMatchObject({ damage: 3, hpAfter: 12 });
        expect(e.turnDamage[0].line).toContain('✓ saved (half): 3 fire, HP 15 → 12/15');
        const f = engineWith([KAEL_TOKEN(), ORC()]);
        give(f, 'orc', { name: 'burning', ongoing: { damage: 6, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 13, onSuccess: 'half' } } });
        d20s(2);
        f.nextTurnWithConditions();
        expect(f.turnDamage[0]).toMatchObject({ damage: 6, hpAfter: 9 });
        expect(f.turnDamage[0].line).toContain('✗ failed: 6 fire, HP 15 → 9/15');
    });

    it("onSuccess end: a success takes nothing and ends the condition (and no save_ends save is rolled for it after)", () => {
        const e = engineWith([KAEL_TOKEN(), ORC()]);
        give(e, 'kael', { name: 'burning', durationType: 'save_ends', saveDC: 30, saveAbility: 'dex', ongoing: { damage: 6, damageType: 'fire', when: 'end', save: { ability: 'dex', dc: 10, onSuccess: 'end' } } });
        d20s(15);
        e.nextTurnWithConditions();
        expect(e.turnDamage[0]).toMatchObject({ damage: 0, conditionEnded: 'saved' });
        expect(e.turnDamage[0].line).toContain('✓ saved: no damage; burning ends');
        expect(who(e, 'kael').conditions).toEqual([]);
        expect(e.endOfTurnSaves).toEqual([]);
    });
});

describe('legendary resistance on an ongoing save (plain 5e, offered the same way)', () => {
    const BOSS = (over: Record<string, unknown> = {}) => ({
        id: 'boss', name: 'Grimgor', initiativeBonus: 0, initiative: 5, hp: 120, maxHp: 120, conditions: [], isEnemy: true, legendaryResistances: 3, ...over
    });
    const BURN = { name: 'burning', ongoing: { damage: 8, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 15 } } };

    it('autoLegendaryResistance spends one: the failed save becomes a success and the tick takes nothing', () => {
        const e = engineWith([KAEL_TOKEN(), BOSS({ autoLegendaryResistance: true })]);
        give(e, 'boss', BURN);
        const spent: number[] = [];
        d20s(2);
        e.nextTurnWithConditions({ saverSides: () => ({ advantage: [], disadvantage: [], onSpent: (r: number) => { spent.push(r); } }) });
        expect(e.turnDamage[0]).toMatchObject({ damage: 0, hpAfter: 120, legendaryResisted: true });
        expect(e.turnDamage[0].save).toMatchObject({ saved: true });
        expect(e.turnDamage[0].line).toContain('✗ failed → 👑 legendary resistance (LR 2/3 left): no damage');
        expect(who(e, 'boss').legendaryResistancesRemaining).toBe(2);
        expect(spent).toEqual([2]);
        expect(e.legendaryOffers).toEqual([]);
    });

    it("offered: the damage lands, the offer is kind 'ongoing' with a saveRef and the refund; answering heals it back", () => {
        const e = engineWith([KAEL_TOKEN(), BOSS()]);
        const c = give(e, 'boss', BURN);
        d20s(2);
        e.nextTurnWithConditions({ encounterId: 'enc-o' });
        const ev = e.turnDamage[0];
        const call = "combat_manage legendary_resistance {encounterId: 'enc-o', participantId: 'boss', saveRef: 'ong-1-boss-1', reason: 'save vs burning'}";
        expect(ev).toMatchObject({ damage: 8, hpAfter: 112, legendaryOffer: { saveRef: 'ong-1-boss-1', remaining: 3, of: 3, refund: 8, call } });
        expect(ev.line.endsWith(call)).toBe(true);
        expect(ev.line).toContain('⭐ LR 3/3 left, spend one?');
        expect(e.legendaryOffers).toEqual([expect.objectContaining({ participantId: 'boss', saveRef: 'ong-1-boss-1', kind: 'ongoing', condition: 'burning', conditionId: c.id, refund: 8, call })]);
        expect(who(e, 'boss').pendingLegendaryOffers).toEqual([{ ref: 'ong-1-boss-1', kind: 'ongoing', conditionId: c.id, condition: 'burning', round: 1, refund: 8 }]);
        // The GM spends it: the success would have avoided all 8.
        e.useLegendaryResistance('boss');
        const answer = answerLegendaryOffer(e, who(e, 'boss'), 'ong-1-boss-1');
        expect(answer).toMatchObject({ refunded: 8 });
        expect(who(e, 'boss').hp).toBe(120);
        expect(who(e, 'boss').conditions.map(x => x.type)).toEqual(['burning']);
    });

    it('a half-on-success save refunds the half a success would have avoided; an end save also ends the condition', () => {
        const e = engineWith([KAEL_TOKEN(), BOSS()]);
        give(e, 'boss', { name: 'burning', ongoing: { damage: 9, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 15, onSuccess: 'half' } } });
        d20s(2);
        e.nextTurnWithConditions();
        expect(e.turnDamage[0].legendaryOffer).toMatchObject({ refund: 5 });
        const f = engineWith([KAEL_TOKEN(), BOSS()]);
        const c = give(f, 'boss', { name: 'burning', ongoing: { damage: 9, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 15, onSuccess: 'end' } } });
        d20s(2);
        f.nextTurnWithConditions();
        expect(who(f, 'boss').pendingLegendaryOffers![0]).toMatchObject({ refund: 9, endsCondition: true });
        f.useLegendaryResistance('boss');
        expect(answerLegendaryOffer(f, who(f, 'boss'), 'ong-1-boss-1')).toMatchObject({ refunded: 9, conditionEnded: { id: c.id, name: 'burning' } });
        expect(who(f, 'boss').conditions).toEqual([]);
    });

    it('a player-controlled creature is asked, never spent for', () => {
        const e = engineWith([KAEL_TOKEN(), BOSS({ name: 'Kaela', isEnemy: false, autoLegendaryResistance: true })]);
        give(e, 'boss', BURN);
        d20s(2);
        e.nextTurnWithConditions({ encounterId: 'enc-o', saverSides: () => ({ advantage: [], disadvantage: [], playerDecides: true }) });
        expect(e.turnDamage[0]).toMatchObject({ damage: 8, legendaryOffer: { askPlayer: true, remaining: 3 } });
        expect(e.turnDamage[0].line).toContain('⭐ Kaela failed with 3/3 legendary resistance left: ask the player.');
        expect(who(e, 'boss').legendaryResistancesRemaining).toBe(3);
    });
});

describe('a single-target tick on a unit: one model, the most wounded', () => {
    it('lands on the most wounded model, capped at it; the condition ends when that model dies', () => {
        // A legacy pool of 50: one model on 5, five unhurt.
        const e = engineWith([KAEL_TOKEN(), MILITIA({ hp: 50 })]);
        give(e, 'militia', { name: 'burning', ongoing: { damage: 6, damageType: 'fire', when: 'start' } });
        e.nextTurnWithConditions();
        const ev = e.turnDamage[0];
        expect(ev).toMatchObject({ shape: 'single', rolled: 6, damage: 5, hpBefore: 50, hpAfter: 45, unitCap: { before: 6, after: 5 }, modelsBefore: 6, modelsAfter: 5, modelsKilled: 1, conditionEnded: 'its model died' });
        expect(ev.line).toContain('one model at most: 6 → 5');
        expect(ev.line).toContain('burning ends: the model it was on is dead');
        expect(ev.wounds).toBe('5 alive: 5 unhurt');
        expect(who(e, 'militia').conditions).toEqual([]);
    });

    it('below the model\'s HP it wounds that one model, tick after tick, until it dies', () => {
        const e = engineWith([KAEL_TOKEN(), MILITIA()]);
        give(e, 'militia', { name: 'burning', ongoing: { damage: 3, damageType: 'fire', when: 'start' } });
        const round = () => { e.nextTurnWithConditions(); const ev = e.turnDamage[0]; e.nextTurnWithConditions(); return ev; };
        expect(round()).toMatchObject({ damage: 3, hpAfter: 51, modelsKilled: 0 });
        expect(who(e, 'militia').unit!.wounded).toEqual([6]);
        expect(round()).toMatchObject({ damage: 3, hpAfter: 48 });
        expect(who(e, 'militia').unit!.wounded).toEqual([3]);
        const third = round();
        expect(third).toMatchObject({ damage: 3, hpAfter: 45, modelsKilled: 1, conditionEnded: 'its model died' });
        expect(who(e, 'militia').unit!.wounded).toBeUndefined();
        expect(who(e, 'militia').conditions).toEqual([]);
    });

    it('a legacy ongoing effect with no shape is single', () => {
        const e = engineWith([KAEL_TOKEN(), MILITIA()]);
        who(e, 'militia').conditions.push({ id: 'old', type: 'burning' as never, durationType: 'permanent' as never, ongoingEffects: [{ type: 'damage', amount: 20, trigger: 'start_of_turn' }] });
        e.nextTurnWithConditions();
        expect(e.turnDamage[0]).toMatchObject({ shape: 'single', damage: 9, hpAfter: 45, modelsKilled: 1 });
    });

    it('a save for the one model is a model\'s save: it never spends the token\'s legendary resistance', () => {
        const e = engineWith([KAEL_TOKEN(), MILITIA({ legendaryResistances: 3, autoLegendaryResistance: true })]);
        give(e, 'militia', { name: 'burning', ongoing: { damage: 6, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 13 } } });
        d20s(2);
        e.nextTurnWithConditions();
        expect(e.turnDamage[0]).toMatchObject({ damage: 6, hpAfter: 48 });
        expect(e.turnDamage[0].save).toMatchObject({ saved: false });
        expect(e.turnDamage[0].legendaryResisted).toBeUndefined();
        expect(who(e, 'militia').legendaryResistancesRemaining).toBe(3);
        expect(e.legendaryOffers).toEqual([]);
    });
});

describe('an area tick on a unit: per model, each with its own save', () => {
    const CLOUD = { name: 'poison cloud', ongoing: { damage: 6, damageType: 'poison', when: 'start', save: { ability: 'con', dc: 12 } } };

    it('min(recorded, live) models, most wounded first, each saving; the count drops by the dead', () => {
        const e = engineWith([KAEL_TOKEN(), MILITIA({ legendaryResistances: 3, autoLegendaryResistance: true })]);
        const c = give(e, 'militia', CLOUD, { kind: 'area', models: 4 });
        const spy = d20s(15, 2, 15, 2);
        e.nextTurnWithConditions({ saverSides: noSides({ total: 0, parts: ['CON +0'] }) });
        const ev = e.turnDamage[0];
        expect(ev).toMatchObject({ shape: 'area', rolled: 6, damage: 12, hpBefore: 54, hpAfter: 42, modelsKilled: 0, modelsInArea: 4, conditionId: c.id });
        expect(ev.unitArea).toMatchObject({ modelsInArea: 4, failed: 2, saved: 2, perModel: { full: 6, half: 0 } });
        expect(ev.unitArea!.saves!.map(s => s.saved)).toEqual([true, false, true, false]);
        expect(ev.line).toContain('poison cloud (start of turn): 4 of 6 in the area: 2 failed, 2 saved; 6 / 0 vs 9 HP each: 0 dead, 6/6 left (4 unhurt, 2 at 3/9)');
        expect(ev.line).toContain('Saves vs DC 12 (CON +0 = +0): 15✓ 2✗ 15✓ 2✗');
        expect(who(e, 'militia').legendaryResistancesRemaining).toBe(3);
        const purposes = spy.mock.calls.map(c => (c[0] as { purpose: string }).purpose);
        expect(purposes).toContain('ongoing poison cloud save (constitution) (model 1/4)');
        expect(purposes).toContain('ongoing poison cloud save (constitution) (model 4/4)');

        // Next round: the two wounded go first and die; the count drops to 2.
        e.nextTurnWithConditions();
        for (const v of [2, 2, 2, 2]) spy.mockReturnValueOnce(v);
        e.nextTurnWithConditions({ saverSides: noSides({ total: 0, parts: ['CON +0'] }) });
        const next = e.turnDamage[0];
        expect(next).toMatchObject({ modelsKilled: 2, modelsInArea: 2, hpAfter: 42 - 6 - 12 });
        expect(next.line).toContain('the area now covers 2');
        expect(who(e, 'militia').conditions[0].ongoingEffects![0].shape).toEqual({ kind: 'area', models: 2 });
    });

    it('at 0 models left in the area the condition ends', () => {
        const e = engineWith([KAEL_TOKEN(), MILITIA()]);
        give(e, 'militia', { name: 'burning field', ongoing: { damage: 20, damageType: 'fire', when: 'start' } }, { kind: 'area', models: 2 });
        e.nextTurnWithConditions();
        expect(e.turnDamage[0]).toMatchObject({ shape: 'area', modelsKilled: 2, conditionEnded: 'no model left in the area', hpAfter: 36 });
        expect(e.turnDamage[0].line).toContain('burning field ends: no model left in the area');
        expect(who(e, 'militia').conditions).toEqual([]);
    });

    it('onSuccess end: the models that save leave the area', () => {
        const e = engineWith([KAEL_TOKEN(), MILITIA()]);
        give(e, 'militia', { name: 'choking', ongoing: { damage: 2, when: 'start', save: { ability: 'con', dc: 12, onSuccess: 'end' } } }, { kind: 'area', models: 3 });
        d20s(15, 2, 15);
        e.nextTurnWithConditions();
        expect(e.turnDamage[0]).toMatchObject({ modelsInArea: 1, damage: 2 });
        expect(who(e, 'militia').conditions[0].ongoingEffects![0].shape).toEqual({ kind: 'area', models: 1 });
    });

    it('an area shape on a creature that is not a unit is one creature: a single tick', () => {
        const e = engineWith([KAEL_TOKEN(), ORC()]);
        give(e, 'orc', { name: 'burning', ongoing: { damage: 3, when: 'start' } }, { kind: 'area', models: 4 });
        e.nextTurnWithConditions();
        expect(e.turnDamage[0]).toMatchObject({ shape: 'single', damage: 3, hpAfter: 12 });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Through the handlers
// ─────────────────────────────────────────────────────────────────────────

const ctx = { sessionId: 'unscoped' };
const embed = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guarded = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
let enc: string;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guarded(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    return { text, r: embed(text, 'COMBAT_MANAGE') ?? embed(text, 'STATE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : { rawText: text }) };
};
const advance = () => manage({ action: 'advance', confirm: true });
const tok = (id: string) => (new EncounterRepository(getDb()).loadState(enc)!.participants as CombatParticipant[]).find(p => p.id === id)!;
const now = () => new Date().toISOString();
const create = async (participants: unknown[], seed = 'o-handlers', extra: Record<string, unknown> = {}) => {
    enc = (await manage({ action: 'create', seed, participants, ...extra })).r.encounterId;
    expect(enc).toBeTruthy();
};
const H_DRAKE = { id: 'drake', name: 'Drake', hp: 120, maxHp: 120, initiative: 20, isEnemy: false, position: { x: 0, y: 0 } };
const H_MILITIA = (over: Record<string, unknown> = {}) => ({ id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, position: { x: 5, y: 5 }, unit: { models: 6, hpPerModel: 9, packed: true, morale: 6 }, ...over });

describe('the write road through combat_manage', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('add_condition takes ongoing: single by default, written on the encounter row, the reply says what ticks', async () => {
        await create([H_DRAKE, { id: 'orc', name: 'Orc', hp: 15, maxHp: 15, initiative: 5, isEnemy: true }]);
        const { r } = await manage({ action: 'add_condition', participantId: 'orc', condition: { name: 'burning', ongoing: { damage: '1d6', damageType: 'fire', when: 'start' } } });
        expect(r.success).toBe(true);
        expect(r.condition.ongoingEffects).toEqual([{ type: 'damage', dice: '1d6', trigger: 'start_of_turn', damageType: 'fire', shape: { kind: 'single' } }]);
        expect(r.ongoing).toEqual(['1d6 fire at the start of its turn (single target)']);
        expect(tok('orc').conditions[0].ongoingEffects![0]).toMatchObject({ dice: '1d6', shape: { kind: 'single' } });
    });

    it('add_condition {area: true} on a packed unit records every live model; modelsInArea records a count', async () => {
        await create([H_DRAKE, H_MILITIA()]);
        const { r } = await manage({ action: 'add_condition', participantId: 'militia', area: true, condition: { name: 'choking', ongoing: { damage: 2, when: 'start' } } });
        expect(r.condition.ongoingEffects[0].shape).toEqual({ kind: 'area', models: 6 });
        const { r: two } = await manage({ action: 'add_condition', participantId: 'militia', modelsInArea: 3, condition: { name: 'burning field', ongoing: { damage: 2, damageType: 'fire', when: 'start' } } });
        expect(two.condition.ongoingEffects[0].shape).toEqual({ kind: 'area', models: 3 });
        expect(two.ongoing).toEqual(['2 fire at the start of its turn (area: 3 models)']);
    });

    it('add_condition {area: true} on a spaced unit with no count is refused before anything is written', async () => {
        await create([H_DRAKE, H_MILITIA({ unit: { models: 6, hpPerModel: 9, packed: false } })]);
        const { r } = await manage({ action: 'add_condition', participantId: 'militia', area: true, condition: { name: 'choking', ongoing: { damage: 2, when: 'start' } } });
        expect(r).toMatchObject({ error: true, writes: 'none' });
        expect(r.message).toMatch(/spaced.*modelsInArea/);
        expect(tok('militia').conditions).toEqual([]);
    });

    it('ongoing with a bad dice expression, or no when, is refused', async () => {
        await create([H_DRAKE, { id: 'orc', name: 'Orc', hp: 15, maxHp: 15, initiative: 5, isEnemy: true }]);
        const refused = async (args: Record<string, unknown>) => { try { return (await manage(args)).r; } catch (err) { return { error: true, message: String((err as Error).message) }; } };
        const bad = await refused({ action: 'add_condition', participantId: 'orc', condition: { name: 'burning', ongoing: { damage: 'lots', when: 'start' } } });
        expect(bad.error).toBeTruthy();
        expect(JSON.stringify(bad)).toMatch(/dice/);
        const noWhen = await refused({ action: 'add_condition', participantId: 'orc', condition: { name: 'burning', ongoing: { damage: 3 } } });
        expect(noWhen.error).toBeTruthy();
        expect(JSON.stringify(noWhen)).toMatch(/when/);
        expect(tok('orc').conditions).toEqual([]);
    });

    it('the create road takes ongoing on a participant\'s conditions (the old ongoingEffects key is still refused)', async () => {
        await create([H_DRAKE, { id: 'orc', name: 'Orc', hp: 15, maxHp: 15, initiative: 5, isEnemy: true, conditions: [{ name: 'burning', ongoing: { damage: 3, damageType: 'fire', when: 'start' } }] }]);
        expect(tok('orc').conditions[0].ongoingEffects![0]).toMatchObject({ amount: 3, damageType: 'fire', shape: { kind: 'single' } });
        const { r } = await advance();
        expect(r.turnDamage).toEqual([expect.objectContaining({ participantId: 'orc', condition: 'burning', damage: 3, hpAfter: 12 })]);
        expect(r.turnStartNotes).toContain('🔥 Orc — burning (start of turn): 3 fire, HP 15 → 12/15');
        expect(tok('orc').hp).toBe(12);
    });

    it('an area save rider on a unit records the standing models inside; a non-area rider is single', async () => {
        await create([H_DRAKE, H_MILITIA(), { id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 4, isEnemy: true }]);
        const spy = d20s(2, 2, 2, 2, 2, 2);
        const rider = { conditions: [{ name: 'poisoned cloud', ongoing: { damage: 2, damageType: 'poison', when: 'start', save: { ability: 'con', dc: 12 } } }] };
        const { r } = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 4, damageType: 'poison', source: 'Green Puke', area: true, save: { ability: 'con', dc: 12, onFail: rider } });
        expect(r.targets[0].conditionsApplied).toEqual(['poisoned cloud']);
        expect(tok('militia').conditions[0].ongoingEffects![0].shape).toEqual({ kind: 'area', models: 6 });
        spy.mockReturnValueOnce(2);
        await manage({ action: 'apply_damage', targetIds: ['orc'], dice: 4, source: 'Spit', save: { ability: 'con', dc: 12, onFail: rider } });
        expect(tok('orc').conditions[0].ongoingEffects![0].shape).toEqual({ kind: 'single' });
    });
});

describe('ticks through advance: break tests, unit lines, deaths, two processes', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('a turn-start area tick that carries a unit through its break point owes a break test, in unitLines and breakTests', async () => {
        await create([H_DRAKE, H_MILITIA()]);
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [3, 3, 3, 3] });
        await manage({ action: 'add_condition', participantId: 'militia', area: true, condition: { name: 'burning field', ongoing: { damage: 3, damageType: 'fire', when: 'start' } } });
        clearCombatState();
        const { r, text } = await advance();
        expect(r.turnDamage[0]).toMatchObject({ participantId: 'militia', shape: 'area', modelsKilled: 4, hpAfter: 12 });
        expect(r.breakTests).toEqual([expect.objectContaining({ participantId: 'militia', modelsBefore: 6, modelsAfter: 2 })]);
        expect(r.unitLines).toEqual([expect.stringMatching(/^Militia — burning field \(start of turn\): 6 in the area, no save: 3 vs 9 HP each \(wounded first: 4 at 3\/9\): 4 dead, 2\/6 left \(2 at 6\/9\).*; BREAK TEST DUE \(morale 6\)$/)]);
        expect(text).toContain('BREAK TEST DUE: Militia fell to 2/6 models');
        const summary = summarizeResult(r) as Record<string, any>;
        expect(summary.unitLines).toEqual(r.unitLines);
        expect(summary.turnDamage[0].line).toBe(r.turnDamage[0].line);
    });

    it('a tick that drops a tracked creature marks the sheet dying; massive damage kills it with a corpse', async () => {
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'kael', name: 'Kael', characterType: 'pc', level: 3, hp: 5, maxHp: 20, ac: 12, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, conditions: [], createdAt: now(), updatedAt: now() } as any);
        repo.create({ id: 'vex', name: 'Vex', characterType: 'pc', level: 3, hp: 5, maxHp: 10, ac: 12, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, conditions: [], createdAt: now(), updatedAt: now() } as any);
        await create([H_DRAKE,
            { id: 'kael', name: 'Kael', hp: 5, maxHp: 20, initiative: 6, isEnemy: false, conditions: [{ name: 'bleeding', ongoing: { damage: 8, when: 'start' } }] },
            { id: 'vex', name: 'Vex', hp: 5, maxHp: 10, initiative: 4, isEnemy: false, conditions: [{ name: 'burning', ongoing: { damage: 30, damageType: 'fire', when: 'start' } }] }]);
        const { r } = await advance(); // the drake's turn ends; Kael's starts
        expect(r.turnDamage[0]).toMatchObject({ participantId: 'kael', hpAfter: 0, dying: expect.objectContaining({ dropped: true }) });
        expect(repo.findById('kael')!.hp).toBe(0);
        expect((repo.findById('kael')!.conditions as any[]).map(c => c.name)).toEqual(expect.arrayContaining(['Unconscious', 'Prone']));
        const { r: r2 } = await advance(); // Kael (down) passes; Vex's turn starts
        expect(r2.turnDamage.find((t: any) => t.participantId === 'vex')).toMatchObject({ dying: expect.objectContaining({ dead: true, instantDeath: true }) });
        expect(r2.killed).toEqual([expect.objectContaining({ participantId: 'vex', cause: expect.stringMatching(/burning.*massive damage/) })]);
    });

    it('an offered ongoing save answered with saveRef in a second process heals the damage back, on the sheet too', async () => {
        new CharacterRepository(getDb()).create({ id: 'grimgor', name: 'Grimgor', characterType: 'enemy', level: 10, hp: 120, maxHp: 120, ac: 17, legendaryResistances: 3, legendaryResistancesRemaining: 3, stats: { str: 18, dex: 10, con: 18, int: 10, wis: 10, cha: 10 }, conditions: [], createdAt: now(), updatedAt: now() } as any);
        await create([H_DRAKE, { id: 'grimgor', name: 'Grimgor', hp: 120, maxHp: 120, initiative: 5, isEnemy: true, conditions: [{ name: 'burning', ongoing: { damage: 10, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 30 } } }] }]);
        clearCombatState();
        const { r } = await advance();
        expect(r.turnDamage[0]).toMatchObject({ participantId: 'grimgor', damage: 10, hpAfter: 110, legendaryOffer: { saveRef: 'ong-1-grimgor-1', refund: 10 } });
        expect(r.legendaryOffers).toEqual([expect.objectContaining({ saveRef: 'ong-1-grimgor-1', kind: 'ongoing', refund: 10 })]);
        expect(new CharacterRepository(getDb()).findById('grimgor')!.hp).toBe(110);
        clearCombatState();
        const { r: spent } = await manage({ action: 'legendary_resistance', participantId: 'grimgor', saveRef: 'ong-1-grimgor-1', reason: 'save vs burning' });
        expect(spent).toMatchObject({ success: true, remaining: 2, refunded: 10, hp: 120 });
        expect(spent.message).toMatch(/turns the failed save vs burning into a success.*10 HP back/);
        expect(tok('grimgor').hp).toBe(120);
        expect(new CharacterRepository(getDb()).findById('grimgor')!.hp).toBe(120);
        // The next advance's sync does not take the refund back.
        await advance();
        expect(tok('grimgor').hp).toBe(120);
    });

    it('a spend without saveRef names the open ongoing offer, its refund and the adjust_hp that undoes it', async () => {
        await create([H_DRAKE, { id: 'grimgor', name: 'Grimgor', hp: 120, maxHp: 120, initiative: 5, isEnemy: true, legendaryResistances: 3, conditions: [{ name: 'burning', ongoing: { damage: 10, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 30 } } }] }]);
        await advance();
        const { r } = await manage({ action: 'legendary_resistance', participantId: 'grimgor', reason: 'the web' });
        expect(r).toMatchObject({ success: true, remaining: 2, openOffers: [expect.objectContaining({ saveRef: 'ong-1-grimgor-1', kind: 'ongoing', condition: 'burning', refund: 10 })] });
        expect(r.message).toMatch(/saveRef 'ong-1-grimgor-1' \(save vs burning, refund 10\).*adjust_hp \{encounterId, participantId: 'grimgor', delta: 10, reason\}/s);
        expect(tok('grimgor').hp).toBe(110);
    });

    it('remove_participant that brings the next slot up ticks its turn start and reports it', async () => {
        await create([{ id: 'scout', name: 'Scout', hp: 10, maxHp: 10, initiative: 25, isEnemy: true }, H_MILITIA({ conditions: [{ name: 'burning', ongoing: { damage: 4, damageType: 'fire', when: 'start' } }] })], 'o-remove');
        clearCombatState();
        const { r: up } = await manage({ action: 'remove_participant', participantId: 'scout' });
        expect(up.turnDamage).toEqual([expect.objectContaining({ participantId: 'militia', condition: 'burning', damage: 4, hpAfter: 50, shape: 'single' })]);
        expect(up.unitLines).toEqual(['Militia — burning (start of turn): 4 fire on the most wounded model: 0 dead, 6/6 left (5 unhurt, 1 at 5/9)']);
        expect(tok('militia').unit!.wounded).toEqual([5]);
    });

    it('a refund that lifts a player character off 0 wakes the token and the sheet', async () => {
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'kael', name: 'Kael', characterType: 'pc', level: 5, hp: 5, maxHp: 30, ac: 12, legendaryResistances: 3, legendaryResistancesRemaining: 3, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, conditions: [], createdAt: now(), updatedAt: now() } as any);
        await create([H_DRAKE, { id: 'kael', name: 'Kael', hp: 5, maxHp: 30, initiative: 5, isEnemy: false, conditions: [{ name: 'burning', ongoing: { damage: 8, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 30 } } }] }]);
        const { r } = await advance();
        expect(r.turnDamage[0]).toMatchObject({ participantId: 'kael', hpAfter: 0, legendaryOffer: { askPlayer: true, refund: 5 }, dying: expect.objectContaining({ dropped: true }) });
        expect((repo.findById('kael')!.conditions as any[]).map(c => c.name)).toEqual(expect.arrayContaining(['Unconscious', 'Prone']));
        clearCombatState();
        const { r: yes } = await manage({ action: 'legendary_resistance', participantId: 'kael', saveRef: r.turnDamage[0].legendaryOffer.saveRef, reason: 'the player spends one' });
        expect(yes).toMatchObject({ success: true, refunded: 5, hp: 5 });
        expect(tok('kael').hp).toBe(5);
        expect(tok('kael').conditions.map(c => String(c.type))).not.toContain('unconscious');
        expect(repo.findById('kael')!.hp).toBe(5);
        expect((repo.findById('kael')!.conditions as any[]).map(c => c.name)).not.toContain('Unconscious');
    });

    it('a tick is damage: a concentrating creature makes its CON save on the fight\'s dice', async () => {
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'mage', name: 'Mage', characterType: 'pc', level: 5, hp: 30, maxHp: 30, ac: 12, stats: { str: 8, dex: 12, con: 10, int: 16, wis: 10, cha: 10 }, conditions: [], createdAt: now(), updatedAt: now() } as any);
        startConcentration('mage', 'Bless', 1, 1, 10, ['mage'], new ConcentrationRepository(getDb()), repo);
        await create([H_DRAKE, { id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 5, isEnemy: false, conditions: [{ name: 'burning', ongoing: { damage: 6, damageType: 'fire', when: 'start' } }] }]);
        d20s(2);
        const { r, text } = await advance();
        expect(r.turnDamage[0]).toMatchObject({ participantId: 'mage', damage: 6, concentration: { spell: 'Bless', broken: true, saveDC: 10, saveTotal: 2 } });
        expect(text).toContain('Concentration on Bless: CON save 2 vs DC 10 ✗ BROKEN');
        expect(new ConcentrationRepository(getDb()).isConcentrating('mage')).toBe(false);
    });

    it("a tick's concentration save offers legendary resistance (lane K's rule), and saveRef puts the spell back", async () => {
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'hag', name: 'Hag', characterType: 'npc', level: 5, hp: 30, maxHp: 30, ac: 12, legendaryResistances: 3, legendaryResistancesRemaining: 3, stats: { str: 8, dex: 12, con: 10, int: 16, wis: 10, cha: 10 }, conditions: [], createdAt: now(), updatedAt: now() } as any);
        startConcentration('hag', 'Hex', 1, 1, 10, ['kael'], new ConcentrationRepository(getDb()), repo);
        await create([H_DRAKE, { id: 'hag', name: 'Hag', hp: 30, maxHp: 30, initiative: 5, isEnemy: true, conditions: [{ name: 'burning', ongoing: { damage: 6, damageType: 'fire', when: 'start' } }] }]);
        d20s(2);
        const { r } = await advance();
        expect(r.turnDamage[0]).toMatchObject({ participantId: 'hag', concentration: { spell: 'Hex', broken: true } });
        expect(new ConcentrationRepository(getDb()).isConcentrating('hag')).toBe(false);
        const offer = (r.legendaryOffers ?? []).find((o: any) => o.kind === 'concentration');
        expect(offer).toMatchObject({ participantId: 'hag', kind: 'concentration', remaining: 3 });
        expect(offer.call).toMatch(/legendary_resistance .*saveRef: 'con-/);
        clearCombatState();
        const { r: yes } = await manage({ action: 'legendary_resistance', participantId: 'hag', saveRef: offer.saveRef, reason: 'concentration save on Hex' });
        expect(yes).toMatchObject({ success: true, remaining: 2, concentrationRestored: { spell: 'Hex' } });
        expect(new ConcentrationRepository(getDb()).isConcentrating('hag')).toBe(true);
    });

    it('a seeded fight replays its ticks, straight through or reloaded in a new process', async () => {
        const run = async (restart: boolean) => {
            closeDb(); getDb(':memory:'); clearCombatState();
            await create([H_DRAKE, H_MILITIA({ conditions: [{ name: 'burning', ongoing: { damage: '2d4', damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 12 } } }] })], 'o-replay');
            if (restart) clearCombatState();
            const { r } = await advance();
            if (restart) clearCombatState();
            await advance();
            if (restart) clearCombatState();
            const { r: third } = await advance();
            return [r.turnDamage[0], third.turnDamage[0]].map((t: any) => ({ rolled: t.rolled, damage: t.damage, save: t.save, hpAfter: t.hpAfter }));
        };
        const a = await run(false);
        const b = await run(true);
        expect(b).toEqual(a);
        expect(queryRolls(getDb(), { limit: 500 }).some(r => r.purpose === 'ongoing burning')).toBe(true);
    });

    it('a natural 20 answering DEATH SAVE DUE starts the turn: its ticks run there, through the provider, and the reply says so', async () => {
        await create([
            { id: 'hero', name: 'Hero', hp: 1, maxHp: 30, initiative: 20, isEnemy: false, deathSaves: true, deathSaveMode: 'prompt', conditions: [{ name: 'burning', ongoing: { damage: 0 + 1, damageType: 'fire', when: 'start' } }] },
            { id: 'orc', name: 'Orc', hp: 15, maxHp: 15, initiative: 5, isEnemy: true }
        ]);
        await manage({ action: 'apply_damage', targetIds: ['hero'], dice: 5, source: 'axe' });
        await advance(); // the hero's (down) turn ends
        const held = await advance(); // the orc's ends; round 2: DEATH SAVE DUE for the hero
        expect(held.r.deathSaveDue).toMatchObject({ participantId: 'hero' });
        const { r } = await manage({ action: 'death_save', participantId: 'hero', outcome: 'nat20' });
        expect(r.turnDamage).toEqual([expect.objectContaining({ participantId: 'hero', condition: 'burning', damage: 1, hpBefore: 1, hpAfter: 0 })]);
        expect(r.turnStartNotes.join('\n')).toContain('🔥 Hero — burning (start of turn): 1 fire, HP 1 → 0/30');
    });

    it('a sheet-backed creature the natural-20 turn\'s tick drops again is dying on its sheet, not woken', async () => {
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'vex', name: 'Vex', characterType: 'pc', level: 3, hp: 1, maxHp: 30, ac: 12, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, conditions: [], createdAt: now(), updatedAt: now() } as any);
        await create([
            { id: 'vex', name: 'Vex', hp: 1, maxHp: 30, initiative: 20, isEnemy: false, deathSaveMode: 'prompt', conditions: [{ name: 'burning', ongoing: { damage: 1, damageType: 'fire', when: 'start' } }] },
            { id: 'orc', name: 'Orc', hp: 15, maxHp: 15, initiative: 5, isEnemy: true }
        ]);
        await manage({ action: 'apply_damage', targetIds: ['vex'], dice: 5, source: 'axe' });
        await advance();
        await advance();
        const { r } = await manage({ action: 'death_save', participantId: 'vex', outcome: 'nat20' });
        expect(r.turnDamage).toEqual([expect.objectContaining({ participantId: 'vex', hpAfter: 0, dying: expect.objectContaining({ dropped: true }) })]);
        expect(repo.findById('vex')!.hp).toBe(0);
        expect((repo.findById('vex')!.conditions as any[]).map(c => c.name)).toEqual(expect.arrayContaining(['Unconscious', 'Prone']));
    });
});
