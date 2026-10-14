/**
 * Play report 7 follow-up, lane O: water pressure is an area.
 *
 * The owner: "water pressure is an area, not a single hit. It's an
 * environment, so every model in the deep water takes it, each separately,
 * under the same per-model rule (and with a save per model if the effect
 * allows one). Pooling it lets one model's death soak damage meant for the
 * rest." With lane W's wounds, five pressure a round drowns a 9-HP man in two
 * rounds.
 *
 *  - pressure gains damageType? (resistances apply, per model) and
 *    save?: {ability, dc, half? (default true)};
 *  - on a unit every live model takes it (the whole field is water: a spaced
 *    unit needs no count), each with its own save, never spending the
 *    token's legendary resistance;
 *  - on any other token it is one save, with legendary resistance offered or
 *    spent as on every engine save, reversible with saveRef (the refund is
 *    what the success would have avoided);
 *  - the turn start records it (turnDamage), and advance owes the break test
 *    a unit crossed and prints its unit line.
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { EnvironmentSchema } from '../../src/schema/encounter.js';

process.env.NODE_ENV = 'test';

const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };

afterEach(() => { vi.restoreAllMocks(); });

const DRAKE_TOKEN = () => ({ id: 'drake', name: 'Drake', initiativeBonus: 0, initiative: 20, hp: 120, maxHp: 120, conditions: [], isEnemy: false, tags: ['aquatic'] });
const MILITIA = (over: Record<string, unknown> = {}) => ({
    id: 'militia', name: 'Militia', initiativeBonus: 0, initiative: 5, hp: 54, maxHp: 54, conditions: [], isEnemy: true,
    unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 0 }, ...over
});
const DEEP = (pressure: Record<string, unknown>) => ({ medium: 'water' as const, depthFt: 300, pressure: { startsAtFt: 100, ...pressure } });

function engineWith(tokens: Record<string, unknown>[], pressure: Record<string, unknown>) {
    const e = new CombatEngine('o-pressure');
    e.startEncounter(tokens as never);
    e.getState()!.environment = EnvironmentSchema.parse(DEEP(pressure));
    e.drainRollRecords();
    return e;
}
const who = (e: CombatEngine, id: string) => e.getState()!.participants.find(p => p.id === id)!;
/** One round: the drake's turn ends (the militia's starts: pressure), then the militia's ends. */
const round = (e: CombatEngine, opts: Parameters<CombatEngine['nextTurnWithConditions']>[0] = {}) => {
    e.nextTurnWithConditions(opts);
    const ev = e.turnDamage.find(t => t.participantId === 'militia');
    e.nextTurnWithConditions(opts);
    return ev!;
};

describe('the pressure schema', () => {
    it('takes damageType and save {ability, dc, half?}; a bad dice expression is refused', () => {
        const env = EnvironmentSchema.parse(DEEP({ damagePerRound: '1d6', damageType: 'bludgeoning', save: { ability: 'con', dc: 12 } }));
        expect(env.pressure).toMatchObject({ damageType: 'bludgeoning', save: { ability: 'con', dc: 12 } });
        expect(() => EnvironmentSchema.parse(DEEP({ damagePerRound: 'a lot' }))).toThrow(/dice/);
        expect(() => EnvironmentSchema.parse(DEEP({ damagePerRound: 3, save: { ability: 'luck', dc: 12 } }))).toThrow();
    });
});

describe('pressure on a unit: every model in the deep water, separately', () => {
    it('3 a round on 9-HP militia: wounds add up and the third round drowns them all', () => {
        const e = engineWith([DRAKE_TOKEN(), MILITIA()], { damagePerRound: 3 });
        const first = round(e);
        expect(first).toMatchObject({ source: 'pressure', shape: 'area', rolled: 3, damage: 18, hpBefore: 54, hpAfter: 36, modelsKilled: 0 });
        expect(first.line).toBe('🌊 Militia — pressure at 300 ft: 6 in the deep water, no save: 3 vs 9 HP each: 0 dead, 6/6 left (6 at 6/9)');
        expect(who(e, 'militia').unit!.wounded).toEqual([6, 6, 6, 6, 6, 6]);
        expect(round(e)).toMatchObject({ hpAfter: 18, modelsKilled: 0 });
        const third = round(e);
        expect(third).toMatchObject({ hpAfter: 0, modelsKilled: 6, modelsAfter: 0 });
        expect(who(e, 'militia').hp).toBe(0);
    });

    it('pooled no more: one model\'s death never soaks damage meant for the rest', () => {
        // Old: 20 off a pool of 54 left 34 (4 standing). Per model: 20 kills all six.
        const e = engineWith([DRAKE_TOKEN(), MILITIA()], { damagePerRound: 20 });
        expect(round(e)).toMatchObject({ modelsKilled: 6, hpAfter: 0 });
    });

    it('a save per model: each model rolls on the fight\'s dice, half on a success; never the token\'s legendary resistance', () => {
        const e = engineWith([DRAKE_TOKEN(), MILITIA({ legendaryResistances: 3, autoLegendaryResistance: true })], { damagePerRound: 5, save: { ability: 'con', dc: 12 } });
        const spy = d20s(20, 1, 20, 1, 20, 1);
        e.nextTurnWithConditions();
        const ev = e.turnDamage[0];
        expect(ev.unitArea).toMatchObject({ failed: 3, saved: 3, perModel: { full: 5, half: 2 }, modelsInArea: 6 });
        expect(ev.line).toContain('6 in the deep water: 3 failed, 3 saved; 5 / 2 vs 9 HP each: 0 dead, 6/6 left (3 at 7/9, 3 at 4/9)');
        expect(ev.line).toContain('Saves vs DC 12 (CON +0 = +0): 20✓ 1✗ 20✓ 1✗ 20✓ 1✗');
        expect(ev).toMatchObject({ damage: 21, hpAfter: 33 });
        expect(who(e, 'militia').legendaryResistancesRemaining).toBe(3);
        // Each model's die is its own roll on the fight's stream, named for the model.
        const purposes = spy.mock.calls.map(c => (c[0] as { purpose: string }).purpose);
        expect(purposes).toContain('pressure save (constitution) (model 6/6)');
    });

    it('half: false takes nothing on a success; the unit\'s drilled bonus rides each model\'s save', () => {
        const e = engineWith([DRAKE_TOKEN(), MILITIA({ unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 0, saves: { con: 5 } } })], { damagePerRound: 5, save: { ability: 'con', dc: 12, half: false } });
        d20s(7, 7, 7, 1, 1, 1);
        e.nextTurnWithConditions();
        expect(e.turnDamage[0].unitArea).toMatchObject({ failed: 3, saved: 3, perModel: { full: 5, half: 0 } });
        expect(e.turnDamage[0].line).toContain('Saves vs DC 12 (CON +0, drilled +5 = +5)');
    });

    it('a spaced unit needs no count: the whole field is water', () => {
        const e = engineWith([DRAKE_TOKEN(), MILITIA({ unit: { models: 6, hpPerModel: 9, packed: false, attackBonus: 0 } })], { damagePerRound: 3 });
        expect(round(e)).toMatchObject({ unitArea: expect.objectContaining({ modelsInArea: 6 }), hpAfter: 36 });
    });

    it('resistances apply per model', () => {
        const e = engineWith([DRAKE_TOKEN(), MILITIA({ resistances: ['bludgeoning'] })], { damagePerRound: 6, damageType: 'bludgeoning' });
        expect(round(e)).toMatchObject({ damage: 18, hpAfter: 36, damageType: 'bludgeoning' });
    });
});

describe('pressure on a creature: one save, legendary resistance as on every engine save', () => {
    const BOSS = (over: Record<string, unknown> = {}) => ({ id: 'boss', name: 'Grimgor', initiativeBonus: 0, initiative: 5, hp: 120, maxHp: 120, conditions: [], isEnemy: true, legendaryResistances: 3, ...over });

    it('the old line stands for a plain tick', () => {
        const e = engineWith([DRAKE_TOKEN(), BOSS({ legendaryResistances: undefined })], { damagePerRound: 5 });
        e.nextTurnWithConditions();
        expect(e.turnDamage[0]).toMatchObject({ source: 'pressure', shape: 'single', damage: 5, hpAfter: 115 });
        expect(e.turnDamage[0].line).toBe('🌊 Grimgor takes 5 pressure damage at 300 ft (120 → 115/120)');
    });

    it('a success halves it (plain 5e); a failure is offered legendary resistance with the refund', () => {
        const e = engineWith([DRAKE_TOKEN(), BOSS()], { damagePerRound: 9, damageType: 'bludgeoning', save: { ability: 'con', dc: 15 } });
        d20s(2);
        e.nextTurnWithConditions({ encounterId: 'enc-p' });
        const ev = e.turnDamage[0];
        expect(ev).toMatchObject({ damage: 9, hpAfter: 111, legendaryOffer: { saveRef: 'ong-1-boss-1', refund: 5, remaining: 3 } });
        expect(ev.line).toContain('🌊 Grimgor takes 9 pressure damage (bludgeoning) at 300 ft (120 → 111/120) — CON save d20 2 + 0 = 2 vs DC 15 (CON +0) ✗ failed');
        expect(e.legendaryOffers[0]).toMatchObject({ kind: 'ongoing', condition: 'water pressure', saveRef: 'ong-1-boss-1', refund: 5 });
        const f = engineWith([DRAKE_TOKEN(), BOSS()], { damagePerRound: 9, save: { ability: 'con', dc: 15 } });
        d20s(16);
        f.nextTurnWithConditions();
        expect(f.turnDamage[0]).toMatchObject({ damage: 4, hpAfter: 116 });
    });

    it('autoLegendaryResistance spends one: a success', () => {
        const e = engineWith([DRAKE_TOKEN(), BOSS({ autoLegendaryResistance: true })], { damagePerRound: 9, save: { ability: 'con', dc: 15 } });
        d20s(2);
        e.nextTurnWithConditions();
        expect(e.turnDamage[0]).toMatchObject({ damage: 4, legendaryResisted: true });
        expect(who(e, 'boss').legendaryResistancesRemaining).toBe(2);
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
const tok = (id: string) => (new EncounterRepository(getDb()).loadState(enc)!.participants as CombatParticipant[]).find(p => p.id === id)! as any;
const H_DRAKE = { id: 'drake', name: 'Drake', hp: 120, maxHp: 120, initiative: 20, isEnemy: false, tags: ['aquatic'], position: { x: 0, y: 0 } };
const H_MILITIA = { id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, position: { x: 5, y: 5 }, unit: { models: 6, hpPerModel: 9, packed: true, morale: 6 } };

describe('pressure through advance', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('drowns militia over rounds, owes the break test it crosses, in a second process each call', async () => {
        enc = (await manage({ action: 'create', seed: 'o-drown', participants: [H_DRAKE, H_MILITIA], environment: DEEP({ damagePerRound: 3 }) })).r.encounterId;
        await manage({ action: 'set_unit', participantId: 'militia', wounded: [3, 3, 3, 3] });
        clearCombatState();
        const { r, text } = await manage({ action: 'advance' });
        expect(r.turnDamage).toEqual([expect.objectContaining({ participantId: 'militia', source: 'pressure', modelsKilled: 4, hpBefore: 30, hpAfter: 12 })]);
        expect(r.breakTests).toEqual([expect.objectContaining({ participantId: 'militia', modelsBefore: 6, modelsAfter: 2, moraleTotal: 6 })]);
        expect(r.unitLines).toEqual(['Militia — pressure at 300 ft: 6 in the deep water, no save: 3 vs 9 HP each (wounded first: 4 at 3/9): 4 dead, 2/6 left (2 at 6/9); BREAK TEST DUE (morale 6)']);
        expect(text).toContain('BREAK TEST DUE: Militia fell to 2/6 models');
        expect(tok('militia').unit.wounded).toEqual([6, 6]);
        clearCombatState();
        await manage({ action: 'advance' });
        clearCombatState();
        const { r: next } = await manage({ action: 'advance' });
        expect(next.turnDamage[0]).toMatchObject({ hpAfter: 6, modelsKilled: 0 });
        expect(next.breakTests).toBeUndefined();
        expect(tok('militia').unit.wounded).toEqual([3, 3]);
    });

    it('a surprised first slot passed at create takes its pressure: the medium is known before the first slot passes', async () => {
        const { r } = await manage({ action: 'create', seed: 'o-surprise', surprised: ['militia'], participants: [H_DRAKE, { ...H_MILITIA, initiative: 30 }], environment: DEEP({ damagePerRound: 3 }) });
        enc = r.encounterId;
        expect(r.turnDamage).toEqual([expect.objectContaining({ participantId: 'militia', source: 'pressure', hpAfter: 36 })]);
        expect(r.unitLines).toEqual(['Militia — pressure at 300 ft: 6 in the deep water, no save: 3 vs 9 HP each: 0 dead, 6/6 left (6 at 6/9)']);
        expect(tok('militia').hp).toBe(36);
        expect(tok('militia').unit.wounded).toEqual([6, 6, 6, 6, 6, 6]);
    });

    it('set_environment takes pressure.save; the offered save is answered with saveRef in a second process', async () => {
        enc = (await manage({ action: 'create', seed: 'o-boss', participants: [H_DRAKE, { id: 'boss', name: 'Grimgor', hp: 120, maxHp: 120, initiative: 5, isEnemy: true, legendaryResistances: 3 }] })).r.encounterId;
        const { r: env } = await manage({ action: 'set_environment', environment: DEEP({ damagePerRound: 8, save: { ability: 'con', dc: 30, half: true } }) });
        expect(env.environment.pressure.save).toEqual({ ability: 'con', dc: 30, half: true });
        clearCombatState();
        const { r } = await manage({ action: 'advance' });
        expect(r.turnDamage[0]).toMatchObject({ participantId: 'boss', damage: 8, hpAfter: 112, legendaryOffer: { saveRef: 'ong-1-boss-1', refund: 4 } });
        clearCombatState();
        const { r: spent } = await manage({ action: 'legendary_resistance', participantId: 'boss', saveRef: 'ong-1-boss-1', reason: 'save vs water pressure' });
        expect(spent).toMatchObject({ success: true, refunded: 4, hp: 116 });
        expect(tok('boss').hp).toBe(116);
    });
});
