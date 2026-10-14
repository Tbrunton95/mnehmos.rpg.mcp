/**
 * Play report 7 follow-up (lane L): the end-of-turn save of a save_ends
 * condition is a plain 5e save, and legendary resistance answers it as it
 * answers every other save the engine rolls.
 *
 * - Plain 5e: total against DC. A natural 1 or 20 means nothing on a save.
 * - A failed end-of-turn save by a creature with resistances left either
 *   spends one by itself (autoLegendaryResistance: the save succeeds and the
 *   condition ends) or is offered ("LR 2/3 left, spend one?") with a saveRef
 *   and the call to paste. The GM's spend with that saveRef turns the failed
 *   save into a success after the fact: the condition ends. The offer lapses
 *   when the creature's next turn starts.
 * - A player-controlled creature (a pc row on the heroes' side) is asked,
 *   never spent for, on every road: the save-ends save and the saves
 *   rollParticipantSave rolls (apply_damage, spells, lair actions).
 * - The engine never reads the database: the handlers' provider (lane H's
 *   SaverSides) says whether the player decides and mirrors a spend to the
 *   sheet. The offer lives in the participant JSON on the encounter row, so a
 *   second process answers it.
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { normalizeCondition } from '../../src/engine/combat/conditions.js';
import { legendaryOnFailedSave } from '../../src/engine/combat/legendary-resistance.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { summarizeResult } from '../../src/server/output-mode.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'unscoped' };
const embed = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
let enc: string;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guardedManage(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    return { text, r: embed(text, 'COMBAT_MANAGE') ?? embed(text, 'STATE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : { rawText: text }) };
};
const advance = () => manage({ action: 'advance', confirm: true });
const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };
const now = () => new Date().toISOString();
const tok = (id: string) => (new EncounterRepository(getDb()).loadState(enc)!.participants as CombatParticipant[]).find(p => p.id === id)!;
const lrLogRows = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM combat_action_log WHERE action_type = 'legendary_resistance'`).get() as { n: number }).n;
const callFor = (encounterId: string, id: string, ref: string, condition = 'webbed') =>
    `combat_manage legendary_resistance {encounterId: '${encounterId}', participantId: '${id}', saveRef: '${ref}', reason: 'save vs ${condition}'}`;

const WEB = { name: 'webbed', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' };

afterEach(() => { vi.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────
// The shared rule (a pure function)
// ─────────────────────────────────────────────────────────────────────────

describe('legendaryOnFailedSave: one rule for every save the engine rolls', () => {
    const spender = () => ({ useLegendaryResistance: vi.fn(() => ({ success: true, remaining: 1 })) });
    const p = (over: Partial<CombatParticipant> = {}) => ({ id: 'boss', name: 'Boss', legendaryResistances: 3, legendaryResistancesRemaining: 2, ...over }) as CombatParticipant;

    it('autoLegendaryResistance spends one; otherwise the count is offered', () => {
        const s = spender();
        expect(legendaryOnFailedSave(s, p({ autoLegendaryResistance: true }))).toEqual({ resisted: { remaining: 1 } });
        expect(legendaryOnFailedSave(s, p())).toEqual({ available: 2 });
        expect(s.useLegendaryResistance).toHaveBeenCalledTimes(1);
    });

    it('a player-controlled creature is asked, never spent for, even with autoLegendaryResistance', () => {
        const s = spender();
        expect(legendaryOnFailedSave(s, p({ autoLegendaryResistance: true }), { playerDecides: true })).toEqual({ available: 2, askPlayer: true });
        expect(legendaryOnFailedSave(s, p(), { playerDecides: true })).toEqual({ available: 2, askPlayer: true });
        expect(s.useLegendaryResistance).not.toHaveBeenCalled();
    });

    it('none left, or one model of a unit saving: nothing spent, nothing offered', () => {
        const s = spender();
        expect(legendaryOnFailedSave(s, p({ legendaryResistancesRemaining: 0, autoLegendaryResistance: true }))).toEqual({});
        expect(legendaryOnFailedSave(s, p({ autoLegendaryResistance: true }), { noLegendaryResistance: true })).toEqual({});
        expect(s.useLegendaryResistance).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// The pure engine
// ─────────────────────────────────────────────────────────────────────────

describe('the engine\'s end-of-turn save: plain 5e, legendary resistance spent or offered', () => {
    const engineWith = (boss: Record<string, unknown>, conditions: unknown[]) => {
        const e = new CombatEngine('l-save-ends');
        e.startEncounter([
            {
                id: 'boss', name: 'Grimgor', initiativeBonus: 0, initiative: 20, hp: 120, maxHp: 120, conditions: [], isEnemy: true,
                abilityScores: { strength: 18, dexterity: 10, constitution: 18, intelligence: 10, wisdom: 10, charisma: 10 },
                legendaryResistances: 3, ...boss
            },
            { id: 'orc', name: 'Orc', initiativeBonus: 0, initiative: 5, hp: 15, maxHp: 15, conditions: [], isEnemy: true }
        ] as any);
        const b = e.getState()!.participants.find(p => p.id === 'boss')!;
        for (const c of conditions) b.conditions.push(normalizeCondition(c as never, 'boss')!);
        e.drainRollRecords();
        return e;
    };
    const boss = (e: CombatEngine) => e.getState()!.participants.find(p => p.id === 'boss')!;

    it('a natural 1 whose total meets the DC saves, and nothing is spent', () => {
        const e = engineWith({ autoLegendaryResistance: true }, [WEB]);
        d20s(1);
        e.nextTurnWithConditions({ saverSides: () => ({ advantage: [], disadvantage: [], modifier: { total: 12, parts: ['DEX +0', 'bonus +12'] } }) });
        expect(e.endOfTurnSaves[0]).toMatchObject({ natural: 1, total: 13, saved: true });
        expect(e.endOfTurnSaves[0].legendaryResisted).toBeUndefined();
        expect(boss(e).legendaryResistancesRemaining).toBe(3);
        expect(e.endOfTurnSaves[0].line).toMatch(/= 13 vs DC 13 \(DEX \+0, bonus \+12\) ✓ saved: webbed ends$/);
    });

    it('autoLegendaryResistance: the failed save becomes a success, the condition ends, the line and row say so', () => {
        const e = engineWith({ autoLegendaryResistance: true }, [WEB]);
        const conditionId = boss(e).conditions[0].id;
        d20s(2);
        e.nextTurnWithConditions({ encounterId: 'enc-l' });
        expect(e.endOfTurnSaves[0]).toMatchObject({ participantId: 'boss', natural: 2, total: 2, saved: true, legendaryResisted: true, conditionId });
        expect(e.endOfTurnSaves[0].legendaryOffer).toBeUndefined();
        expect(e.endOfTurnSaves[0].line).toMatch(/= 2 vs DC 13 \(DEX \+0\) ✗ failed → 👑 legendary resistance \(LR 2\/3 left\): webbed ends$/);
        expect(boss(e).legendaryResistancesRemaining).toBe(2);
        expect(boss(e).conditions).toEqual([]);
        expect(e.legendaryOffers).toEqual([]);
        expect(boss(e).pendingLegendaryOffers ?? []).toEqual([]);
    });

    it('the provider mirrors an automatic spend to the sheet (onSpent); a mirror that throws does not undo the save', () => {
        const spent: number[] = [];
        const a = engineWith({ autoLegendaryResistance: true }, [WEB]);
        d20s(2);
        a.nextTurnWithConditions({ saverSides: () => ({ advantage: [], disadvantage: [], onSpent: (r: number) => { spent.push(r); } }) });
        expect(spent).toEqual([2]);
        const b = engineWith({ autoLegendaryResistance: true }, [WEB]);
        d20s(2);
        b.nextTurnWithConditions({ saverSides: () => ({ advantage: [], disadvantage: [], onSpent: () => { throw new Error('no database'); } }) });
        expect(b.endOfTurnSaves[0]).toMatchObject({ saved: true, legendaryResisted: true });
        expect(boss(b).conditions).toEqual([]);
    });

    it('without autoLegendaryResistance the failed save is offered: a saveRef, the call, a pending offer on the token', () => {
        const e = engineWith({}, [WEB]);
        const conditionId = boss(e).conditions[0].id;
        d20s(2);
        e.nextTurnWithConditions({ encounterId: 'enc-l' });
        const s = e.endOfTurnSaves[0];
        const call = callFor('enc-l', 'boss', 'eot-1-boss-1');
        expect(s).toMatchObject({ saved: false, conditionId, legendaryOffer: { saveRef: 'eot-1-boss-1', remaining: 3, of: 3, call } });
        expect(s.legendaryResisted).toBeUndefined();
        expect(s.line).toMatch(/✗ failed: still webbed ⭐ LR 3\/3 left, spend one\? combat_manage legendary_resistance/);
        expect(s.line.endsWith(call)).toBe(true);
        expect(e.turnStartNotes.join('\n')).toContain(call);
        expect(boss(e).legendaryResistancesRemaining).toBe(3);
        expect(boss(e).conditions.map(c => c.type)).toEqual(['webbed']);
        expect(boss(e).pendingLegendaryOffers).toEqual([{ ref: 'eot-1-boss-1', kind: 'save_ends', conditionId, condition: 'webbed', round: 1 }]);
        expect(e.legendaryOffers).toEqual([{
            participantId: 'boss', name: 'Grimgor', saveRef: 'eot-1-boss-1', kind: 'save_ends', condition: 'webbed', conditionId,
            remaining: 3, of: 3, call, line: expect.stringMatching(/^⭐ Grimgor: LR 3\/3 left, spend one\? /)
        }]);
    });

    it('a player-controlled creature (the provider says so) is asked and never spent for, autoLegendaryResistance or not', () => {
        const e = engineWith({ name: 'Kael', isEnemy: false, autoLegendaryResistance: true }, [WEB]);
        d20s(2);
        e.nextTurnWithConditions({ encounterId: 'enc-l', saverSides: () => ({ advantage: [], disadvantage: [], playerDecides: true }) });
        const s = e.endOfTurnSaves[0];
        expect(s).toMatchObject({ saved: false, legendaryOffer: { saveRef: 'eot-1-boss-1', remaining: 3, askPlayer: true } });
        expect(s.line).toContain(`⭐ Kael failed with 3/3 legendary resistance left: ask the player. If they spend one: ${callFor('enc-l', 'boss', 'eot-1-boss-1')}`);
        expect(boss(e).legendaryResistancesRemaining).toBe(3);
        expect(boss(e).conditions.map(c => c.type)).toEqual(['webbed']);
        expect(e.legendaryOffers[0]).toMatchObject({ askPlayer: true });
    });

    it('two failed saves in one turn each get their own saveRef', () => {
        const e = engineWith({}, [WEB, { name: 'frightened', durationType: 'save_ends', saveDC: 14, saveAbility: 'wis' }]);
        d20s(2, 3);
        e.nextTurnWithConditions({ encounterId: 'enc-l' });
        expect(e.legendaryOffers.map(o => [o.saveRef, o.condition])).toEqual([['eot-1-boss-1', 'webbed'], ['eot-1-boss-2', 'frightened']]);
        expect(boss(e).pendingLegendaryOffers!.map(o => o.ref)).toEqual(['eot-1-boss-1', 'eot-1-boss-2']);
    });

    it('the offer lapses when the creature\'s next turn starts, with a note', () => {
        const e = engineWith({}, [WEB]);
        d20s(2);
        e.nextTurnWithConditions({ encounterId: 'enc-l' }); // Grimgor's turn ends: offered; the orc is up
        expect(boss(e).pendingLegendaryOffers).toHaveLength(1);
        e.nextTurnWithConditions({ encounterId: 'enc-l' }); // the orc's turn ends: still open
        expect(boss(e).pendingLegendaryOffers ?? []).toEqual([]);
        expect(e.getCurrentParticipant()!.id).toBe('boss');
        expect(e.turnStartNotes.join('\n')).toMatch(/Grimgor: the legendary resistance offer on the save vs webbed \(eot-1-boss-1\) lapsed: its turn has begun/);
    });

    it('a unit token\'s own save follows the creature rule: offered once for the token', () => {
        const e = engineWith({ name: 'Militia', unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 2, morale: 6 }, hp: 54, maxHp: 54 }, [WEB]);
        d20s(2);
        e.nextTurnWithConditions({ encounterId: 'enc-l' });
        expect(e.endOfTurnSaves[0]).toMatchObject({ saved: false, legendaryOffer: { saveRef: 'eot-1-boss-1', remaining: 3 } });
        expect(e.legendaryOffers).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Through the handlers: advance, then combat_manage legendary_resistance
// ─────────────────────────────────────────────────────────────────────────

const WEBBED = { name: 'webbed', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' };
const BOSS = (over: Record<string, unknown> = {}) => ({ id: 'grimgor', name: 'Grimgor', hp: 120, maxHp: 120, ac: 17, initiative: 20, isEnemy: true, position: { x: 0, y: 0 }, legendaryResistances: 3, conditions: [WEBBED], ...over });
const ORC = { id: 'orc', name: 'Orc', hp: 15, maxHp: 15, initiative: 5, isEnemy: true, position: { x: 4, y: 4 } };
const sheet = (id: string, name: string, over: Record<string, unknown> = {}) => new CharacterRepository(getDb()).create({
    id, name, characterType: 'pc', level: 5, hp: 60, maxHp: 60, ac: 13,
    stats: { str: 10, dex: 10, con: 14, int: 10, wis: 12, cha: 8 },
    conditions: [], createdAt: now(), updatedAt: now(), ...over
} as any);
const create = async (participants: unknown[], seed = 'l-handlers') => {
    enc = (await manage({ action: 'create', seed, participants })).r.encounterId;
    expect(enc).toBeTruthy();
};

describe('advance offers the resistance; the spend with saveRef ends the condition', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('offered at advance, answered in a second process: the save becomes a success and webbed ends', async () => {
        await create([BOSS(), ORC]);
        clearCombatState();
        d20s(2);
        const { r, text } = await advance();
        const conditionId = r.endOfTurnSaves[0].conditionId;
        const call = callFor(enc, 'grimgor', 'eot-1-grimgor-1');
        expect(r.endOfTurnSaves[0]).toMatchObject({ participantId: 'grimgor', saved: false, legendaryOffer: { saveRef: 'eot-1-grimgor-1', remaining: 3, of: 3, call } });
        expect(r.legendaryOffers).toEqual([expect.objectContaining({ participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', kind: 'save_ends', condition: 'webbed', conditionId, call })]);
        expect(text).toContain(call);
        expect(tok('grimgor').pendingLegendaryOffers).toEqual([expect.objectContaining({ ref: 'eot-1-grimgor-1', kind: 'save_ends', conditionId })]);

        clearCombatState();
        const { r: spent } = await manage({ action: 'legendary_resistance', participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', reason: 'save vs webbed' });
        expect(spent).toMatchObject({ success: true, remaining: 2, of: 3, saveRef: 'eot-1-grimgor-1', conditionEnded: { id: conditionId, name: 'webbed' } });
        expect(spent.message).toMatch(/👑 Grimgor turns the failed save vs webbed into a success \(save vs webbed\): webbed ends; LR 2\/3 left/);
        expect(tok('grimgor').conditions).toEqual([]);
        expect(tok('grimgor').legendaryResistancesRemaining).toBe(2);
        expect(tok('grimgor').pendingLegendaryOffers ?? []).toEqual([]);
        expect(lrLogRows()).toBe(1);
    });

    it('a surprised first slot\'s failed save at create is offered with the call naming this fight, and the saveRef answers it', async () => {
        const { r } = await manage({ action: 'create', seed: 'l-surprise', surprised: ['grimgor'], participants: [BOSS({ conditions: [{ ...WEBBED, saveDC: 30 }] }), ORC] });
        enc = r.encounterId;
        expect(r.endOfTurnSaves[0]).toMatchObject({ participantId: 'grimgor', saved: false });
        expect(r.legendaryOffers).toEqual([expect.objectContaining({ saveRef: 'eot-1-grimgor-1', call: callFor(enc, 'grimgor', 'eot-1-grimgor-1') })]);
        const { r: spent } = await manage({ action: 'legendary_resistance', participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', reason: 'save vs webbed' });
        expect(spent).toMatchObject({ success: true, conditionEnded: { name: 'webbed' } });
        expect(tok('grimgor').conditions).toEqual([]);
    });

    it('remove_participant that brings a surprised slot up carries its offer', async () => {
        await create([{ id: 'scout', name: 'Scout', hp: 10, maxHp: 10, initiative: 25, isEnemy: true, position: { x: 2, y: 2 } }, BOSS({ conditions: [{ ...WEBBED, saveDC: 30 }] }), ORC]);
        await manage({ action: 'set_surprised', participantIds: ['grimgor'] });
        const { r } = await manage({ action: 'remove_participant', participantId: 'scout' });
        expect(r.endOfTurnSaves?.[0]).toMatchObject({ participantId: 'grimgor', saved: false });
        expect(r.legendaryOffers).toEqual([expect.objectContaining({ saveRef: 'eot-1-grimgor-1', call: callFor(enc, 'grimgor', 'eot-1-grimgor-1') })]);
    });

    it('an unknown or already-answered saveRef is refused before anything is written', async () => {
        await create([BOSS(), ORC]);
        d20s(2);
        await advance();
        const rolls = queryRolls(getDb(), { limit: 500 }).length;
        const bad = await manage({ action: 'legendary_resistance', participantId: 'grimgor', saveRef: 'eot-9-grimgor-1', reason: 'save vs webbed' });
        expect(bad.r).toMatchObject({ error: true, writes: 'none' });
        expect(bad.r.message).toMatch(/no open legendary resistance offer eot-9-grimgor-1.*open: eot-1-grimgor-1 \(save vs webbed\)/);
        expect(tok('grimgor').legendaryResistancesRemaining).toBe(3);
        expect(tok('grimgor').conditions.map(c => c.type)).toEqual(['webbed']);
        expect(tok('grimgor').pendingLegendaryOffers).toHaveLength(1);
        expect(lrLogRows()).toBe(0);
        expect(queryRolls(getDb(), { limit: 500 }).length).toBe(rolls);

        await manage({ action: 'legendary_resistance', participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', reason: 'save vs webbed' });
        const twice = await manage({ action: 'legendary_resistance', participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', reason: 'save vs webbed' });
        expect(twice.r).toMatchObject({ error: true, writes: 'none' });
        expect(tok('grimgor').legendaryResistancesRemaining).toBe(2);
        expect(lrLogRows()).toBe(1);
    });

    it('a condition already gone is refused (nothing to undo, nothing spent)', async () => {
        await create([BOSS(), ORC]);
        d20s(2);
        await advance();
        await manage({ action: 'remove_condition', participantId: 'grimgor', name: 'webbed' });
        const r = (await manage({ action: 'legendary_resistance', participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', reason: 'save vs webbed' })).r;
        expect(r).toMatchObject({ error: true, writes: 'none' });
        expect(r.message).toMatch(/webbed no longer stands on Grimgor/);
        expect(tok('grimgor').legendaryResistancesRemaining).toBe(3);
    });

    it('the offer lapses at the creature\'s next turn: the saveRef is refused after that', async () => {
        await create([BOSS(), ORC]);
        d20s(2);
        await advance(); // Grimgor's turn ends: offered
        const { r } = await advance(); // the orc's turn ends; round 2, Grimgor's turn begins
        expect(r.turnStartNotes.join('\n')).toMatch(/Grimgor: the legendary resistance offer on the save vs webbed \(eot-1-grimgor-1\) lapsed/);
        expect(tok('grimgor').pendingLegendaryOffers ?? []).toEqual([]);
        const late = (await manage({ action: 'legendary_resistance', participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', reason: 'save vs webbed' })).r;
        expect(late).toMatchObject({ error: true, writes: 'none' });
        expect(late.message).toMatch(/offers lapse when its next turn starts/);
        expect(tok('grimgor').legendaryResistancesRemaining).toBe(3);
    });

    it('without saveRef it spends as before and names the offers it could have answered', async () => {
        await create([BOSS(), ORC]);
        d20s(2);
        await advance();
        const { r } = await manage({ action: 'legendary_resistance', participantId: 'grimgor', reason: 'the fireball' });
        expect(r).toMatchObject({ success: true, remaining: 2, openOffers: [expect.objectContaining({ saveRef: 'eot-1-grimgor-1', kind: 'save_ends', condition: 'webbed' })] });
        expect(r.conditionEnded).toBeUndefined();
        expect(r.message).toMatch(/answered no offer.*saveRef 'eot-1-grimgor-1'/s);
        expect(tok('grimgor').conditions.map(c => c.type)).toEqual(['webbed']);
    });

    it('autoLegendaryResistance on a sheet-backed monster spends by itself, and the sheet keeps the count across processes', async () => {
        sheet('grimgor', 'Grimgor', { characterType: 'enemy', legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: true });
        await create([{ id: 'grimgor', name: 'Grimgor', hp: 60, maxHp: 60, initiative: 20, isEnemy: true, position: { x: 0, y: 0 }, conditions: [WEBBED] }, ORC]);
        clearCombatState();
        d20s(2);
        const { r } = await advance();
        expect(r.endOfTurnSaves[0]).toMatchObject({ participantId: 'grimgor', saved: true, legendaryResisted: true });
        expect(r.legendaryOffers).toBeUndefined();
        expect(tok('grimgor').conditions).toEqual([]);
        expect(tok('grimgor').legendaryResistancesRemaining).toBe(2);
        expect(new CharacterRepository(getDb()).findById('grimgor')!.legendaryResistancesRemaining).toBe(2);
    });

    it('a player character with autoLegendaryResistance is asked, not spent for, on the save-ends save; the player\'s yes ends it', async () => {
        sheet('kael', 'Kael', { legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: true });
        await create([{ id: 'kael', name: 'Kael', hp: 60, maxHp: 60, initiative: 20, isEnemy: false, position: { x: 0, y: 0 }, conditions: [WEBBED] }, ORC]);
        d20s(2);
        const { r } = await advance();
        const call = callFor(enc, 'kael', 'eot-1-kael-1');
        expect(r.endOfTurnSaves[0]).toMatchObject({ participantId: 'kael', saved: false, legendaryOffer: { askPlayer: true, remaining: 3, call } });
        expect(r.endOfTurnSaves[0].line).toContain(`⭐ Kael failed with 3/3 legendary resistance left: ask the player. If they spend one: ${call}`);
        expect(r.legendaryOffers[0]).toMatchObject({ askPlayer: true, saveRef: 'eot-1-kael-1' });
        expect(tok('kael').legendaryResistancesRemaining).toBe(3);
        expect(new CharacterRepository(getDb()).findById('kael')!.legendaryResistancesRemaining).toBe(3);
        const { r: yes } = await manage({ action: 'legendary_resistance', participantId: 'kael', saveRef: 'eot-1-kael-1', reason: 'the player spends one' });
        expect(yes).toMatchObject({ success: true, remaining: 2, mirroredToCharacter: true });
        expect(tok('kael').conditions).toEqual([]);
        expect(new CharacterRepository(getDb()).findById('kael')!.legendaryResistancesRemaining).toBe(2);
    });

    it('a player character with autoLegendaryResistance is asked on a rollParticipantSave road too (apply_damage with a save)', async () => {
        sheet('kael', 'Kael', { legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: true });
        await create([{ id: 'kael', name: 'Kael', hp: 60, maxHp: 60, initiative: 20, isEnemy: false, position: { x: 0, y: 0 }, conditions: [] }, ORC]);
        d20s(2);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['kael'], dice: 10, source: 'Falling rocks', save: { ability: 'dex', dc: 15 } });
        expect(r.targets[0]).toMatchObject({ saved: false, legendaryResistanceAvailable: 3, legendaryResistanceAskPlayer: true });
        expect(r.targets[0].legendaryResisted).toBeUndefined();
        expect(r.message).toMatch(/3 legendary resistance\(s\) left: ask the player/);
        expect(tok('kael').legendaryResistancesRemaining).toBe(3);
        expect(new CharacterRepository(getDb()).findById('kael')!.legendaryResistancesRemaining).toBe(3);
    });

    it('an allied npc row is the GM\'s to spend: autoLegendaryResistance still spends', async () => {
        sheet('warden', 'Warden', { characterType: 'npc', legendaryResistances: 2, legendaryResistancesRemaining: 2, autoLegendaryResistance: true });
        await create([{ id: 'warden', name: 'Warden', hp: 60, maxHp: 60, initiative: 20, isEnemy: false, position: { x: 0, y: 0 }, conditions: [WEBBED] }, ORC]);
        d20s(2);
        const { r } = await advance();
        expect(r.endOfTurnSaves[0]).toMatchObject({ saved: true, legendaryResisted: true });
        expect(new CharacterRepository(getDb()).findById('warden')!.legendaryResistancesRemaining).toBe(1);
    });

    it('the verb mirrors to the sheet by exact id only: a sheet whose id merely starts with the token\'s is left alone', async () => {
        await create([{ id: 'dragon', name: 'Dragon', hp: 200, maxHp: 200, initiative: 20, isEnemy: true, legendaryResistances: 3, position: { x: 0, y: 0 } }, ORC]);
        sheet('dragon-lord', 'Dragon Lord', { characterType: 'enemy', legendaryResistances: 3, legendaryResistancesRemaining: 3 });
        const { r } = await manage({ action: 'legendary_resistance', participantId: 'dragon', reason: 'the hold person' });
        expect(r).toMatchObject({ success: true, remaining: 2, mirroredToCharacter: false });
        expect(new CharacterRepository(getDb()).findById('dragon-lord')!.legendaryResistancesRemaining).toBe(3);
    });

    it('a seeded fight replays the save and its offer, straight through or reloaded in a new process', async () => {
        const run = async (restart: boolean) => {
            closeDb(); getDb(':memory:'); clearCombatState();
            await create([BOSS({ conditions: [{ ...WEBBED, saveDC: 30 }] }), ORC], 'l-replay');
            if (restart) clearCombatState();
            const { r } = await advance();
            // The encounter id is minted per create; the call is compared without it.
            const row = r.endOfTurnSaves[0];
            return { ...row, legendaryOffer: { ...row.legendaryOffer, call: row.legendaryOffer.call.replace(enc, '<enc>') } };
        };
        const a = await run(false);
        const b = await run(true);
        expect(a.saved).toBe(false);
        expect(b.rolls).toEqual(a.rolls);
        expect(b.legendaryOffer).toEqual(a.legendaryOffer);
        expect(a.legendaryOffer).toMatchObject({ saveRef: 'eot-1-grimgor-1', remaining: 3, call: callFor('<enc>', 'grimgor', 'eot-1-grimgor-1') });
    });

    it('output_mode summary keeps legendaryOffers whole, the call included', async () => {
        const long = { name: 'webbed in the broodmother silk of the deep warrens', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' };
        await create([BOSS({ id: 'grimgor-ironhide-the-unbroken', name: 'Grimgor Ironhide, Megaboss of the Ironjawz', conditions: [long] }), ORC]);
        d20s(2);
        const { r } = await advance();
        const summary = summarizeResult(r) as Record<string, any>;
        const call = callFor(enc, 'grimgor-ironhide-the-unbroken', 'eot-1-grimgor-ironhide-the-unbroken-1', long.name);
        expect(summary.legendaryOffers).toEqual([expect.objectContaining({ saveRef: 'eot-1-grimgor-ironhide-the-unbroken-1', call })]);
        expect(summary.endOfTurnSaves[0].line.length).toBeGreaterThan(300);
        expect(summary.endOfTurnSaves[0].line).toBe(r.endOfTurnSaves[0].line); expect(summary.endOfTurnSaves[0].line.endsWith(call)).toBe(true);
    });
});
