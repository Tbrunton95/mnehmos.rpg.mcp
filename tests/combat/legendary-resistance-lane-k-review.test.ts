/**
 * Lane K review: legendary resistance on concentration, stunt and aura saves.
 *
 * - An answered or lapsed offer's saveRef is never handed to a later offer:
 *   lane L's refs counted only the open offers, so a concentration save that
 *   failed again in the same round got the answered ref back, and a repeated
 *   answer call spent a second resistance on the new offer.
 * - A stunt's refund is the HP a success would have kept, not the damage
 *   difference: a blow that overkilled healed back more than it took.
 * - A stunt's target with a live token is in a fight even when the stunt
 *   names no encounterId: its token's count, an offer on the encounter row.
 * - output_mode summary keeps an aura's offer call (it rode only the effect
 *   rows, which summary collapses).
 * - lair_action carries a concentration save's offer at its top level.
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { handleImprovisationManage } from '../../src/server/consolidated/improvisation-manage.js';
import { handleAuraManage } from '../../src/server/consolidated/aura-manage.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { type CombatParticipant } from '../../src/engine/combat/engine.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { ConcentrationRepository } from '../../src/storage/repos/concentration.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { summarizeResult } from '../../src/server/output-mode.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'unscoped' };
const embed = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const guardedAction = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
let enc: string | undefined;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guardedManage(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    return { text, r: embed(text, 'COMBAT_MANAGE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : { rawText: text }) };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await guardedAction(CombatActionTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    const d = embed(text, 'COMBAT_ACTION') ?? embed(text, 'STATE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : null);
    return { text, d, r: d?.actionResult ?? d };
};
const improv = async (args: Record<string, unknown>) => {
    const text = (await handleImprovisationManage(args, ctx as any)).content[0].text;
    return { text, r: embed(text, 'IMPROVISATION_MANAGE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : { rawText: text }) };
};
const aura = async (args: Record<string, unknown>) => {
    const text = (await handleAuraManage(args, ctx as any)).content[0].text;
    return { text, r: embed(text, 'AURA_MANAGE') };
};
const now = () => new Date().toISOString();
const sheetRow = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
const concRow = (id: string) => new ConcentrationRepository(getDb()).findByCharacterId(id);
const tok = (id: string, e = enc!) => (new EncounterRepository(getDb()).loadState(e)!.participants as CombatParticipant[]).find(p => p.id === id)!;
const lrLogRows = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM combat_action_log WHERE action_type = 'legendary_resistance'`).get() as { n: number }).n;

function sheet(id: string, name: string, over: Record<string, unknown> = {}) {
    new CharacterRepository(getDb()).create({
        id, name, characterType: 'enemy', level: 8, hp: 200, maxHp: 200, ac: 13,
        stats: { str: 10, dex: 10, con: 10, int: 12, wis: 12, cha: 16 },
        conditions: [], createdAt: now(), updatedAt: now(), ...over
    } as any);
}
function concentrating(id: string, spell = 'Hex') {
    new ConcentrationRepository(getDb()).create({ characterId: id, activeSpell: spell, spellLevel: 1, targetIds: ['kael'], startedAt: 1, maxDuration: 10, saveDCBase: 10 });
    new CharacterRepository(getDb()).update(id, { concentratingOn: spell } as any);
}
const HAG = (over: Record<string, unknown> = {}) => sheet('hag', 'Hag', { legendaryResistances: 3, legendaryResistancesRemaining: 3, ...over });
const BRUTE = { id: 'brute', name: 'Brute', hp: 40, maxHp: 40, ac: 12, initiative: 30, isEnemy: false, position: { x: 1, y: 0 }, attackBonus: 5, attackDamage: '1d8+3' };
const HAG_TOKEN = { id: 'hag', name: 'Hag', hp: 200, maxHp: 200, ac: 13, initiative: 10, isEnemy: true, position: { x: 0, y: 0 } };
async function fight(participants: Array<Record<string, unknown>>, seed = 'k-review') {
    enc = (await manage({ action: 'create', seed, participants })).r.encounterId;
    expect(enc).toBeTruthy();
}
const rockfall = () => manage({ action: 'apply_damage', targetIds: ['hag'], dice: 60, source: 'rockfall' });

beforeEach(() => {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    enc = undefined;
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('an answered or lapsed saveRef is never handed to a later offer', () => {
    it('answered, then the spell breaks again the same round: a new ref, and a repeated answer call is refused with nothing spent', async () => {
        HAG();
        concentrating('hag');
        await fight([BRUTE, HAG_TOKEN]);
        const first = (await act({ action: 'attack', actorId: 'brute', targetId: 'hag', outcome: 'hit', damage: 60 })).d.legendaryOffers[0];
        expect(first.saveRef).toBe('con-1-hag-1');
        const answer = { action: 'legendary_resistance', participantId: 'hag', saveRef: 'con-1-hag-1', reason: 'concentration save on Hex' };
        expect((await manage(answer)).r).toMatchObject({ success: true, remaining: 2 });
        expect(concRow('hag')?.activeSpell).toBe('Hex');

        // The same round, in a second process (the engine reloads from the encounter row): Hex breaks again and is offered again.
        clearCombatState();
        expect(tok('hag').closedLegendaryRefs).toEqual(['con-1-hag-1']);
        const second = (await rockfall()).r.legendaryOffers[0];
        expect(second.saveRef).not.toBe('con-1-hag-1');
        expect(second.saveRef).toBe('con-1-hag-2');

        // The first answer call again (a retry, a stale paste): refused, nothing spent, the new offer stays open.
        const again = (await manage(answer)).r;
        expect(again).toMatchObject({ error: true, writes: 'none' });
        expect(again.message).toMatch(/con-1-hag-1/);
        expect(tok('hag').legendaryResistancesRemaining).toBe(2);
        expect(tok('hag').pendingLegendaryOffers?.map(o => o.ref)).toEqual(['con-1-hag-2']);
        expect(concRow('hag')).toBeNull();
        expect(lrLogRows()).toBe(1);
    });

    it('lapsed at its turn start, then the spell breaks again the same round: the lapsed ref is not reused', async () => {
        HAG();
        concentrating('hag');
        await fight([BRUTE, HAG_TOKEN]);
        expect((await rockfall()).r.legendaryOffers[0].saveRef).toBe('con-1-hag-1');
        await manage({ action: 'advance', confirm: true }); // the hag's turn starts, round 1: the offer lapses
        expect(tok('hag').pendingLegendaryOffers ?? []).toEqual([]);
        concentrating('hag', 'Bless'); // she casts again on her turn
        const next = (await rockfall()).r.legendaryOffers[0];
        expect(next.saveRef).toBe('con-1-hag-2');
        // The lapsed call pasted late is refused.
        const late = (await manage({ action: 'legendary_resistance', participantId: 'hag', saveRef: 'con-1-hag-1', reason: 'concentration save on Hex' })).r;
        expect(late).toMatchObject({ error: true, writes: 'none' });
        expect(tok('hag').legendaryResistancesRemaining).toBe(3);
        expect(concRow('hag')).toBeNull();
    });
});

describe("a stunt's refund is the HP a success would have kept", () => {
    const ACTOR = () => sheet('luciel', 'Luciel', { characterType: 'pc', stats: { str: 30, dex: 14, con: 20, int: 12, wis: 12, cha: 16 }, level: 15 });
    const kick = async (extra: Record<string, unknown> = {}) => {
        const args = { action: 'stunt', actorId: 'luciel', skill: 'athletics', dc: 5, modifier: 30, successDamage: '8', targetIds: ['ogre'], savingThrowAbility: 'dex', savingThrowDc: 30, halfDamageOnSave: true, narrativeIntent: 'kick the brazier', ...extra };
        let out = await improv(args);
        for (let i = 0; i < 20 && out.r.natural === 1; i++) out = await improv(args);
        return out;
    };

    it('an ogre at 5 HP takes 8 (a save would have taken 4): the offer heals back 1, not 4', async () => {
        sheet('ogre', 'Ogre', { hp: 5, stats: { str: 18, dex: 1, con: 16, int: 5, wis: 7, cha: 7 }, legendaryResistances: 3, legendaryResistancesRemaining: 3 });
        ACTOR();
        await fight([
            { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'ogre', name: 'Ogre', hp: 5, maxHp: 200, initiative: 5, isEnemy: true, position: { x: 1, y: 0 } }
        ], 'k-floor');
        const { r } = await kick({ encounterId: enc });
        expect(r.targets[0]).toMatchObject({ saved: false, damage: 8, hpBefore: 5, hpAfter: 0, legendaryOffer: { saveRef: 'stu-1-ogre-1' } });
        expect(tok('ogre').pendingLegendaryOffers).toEqual([expect.objectContaining({ ref: 'stu-1-ogre-1', refund: 1 })]);
        clearCombatState();
        const { r: spent } = await manage({ action: 'legendary_resistance', participantId: 'ogre', saveRef: 'stu-1-ogre-1', reason: 'the brazier' });
        expect(spent).toMatchObject({ success: true, refunded: 1, hp: 1 });
        expect(tok('ogre').hp).toBe(1);
        expect(sheetRow('ogre').hp).toBe(1);
    });

    it("a target with a live token is in that fight even when the stunt names no encounterId: the token's count spends, the sheet is mirrored", async () => {
        sheet('ogre', 'Ogre', { stats: { str: 18, dex: 1, con: 16, int: 5, wis: 7, cha: 7 }, legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: true });
        ACTOR();
        await fight([
            { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'ogre', name: 'Ogre', hp: 200, maxHp: 200, initiative: 5, isEnemy: true, position: { x: 1, y: 0 } }
        ], 'k-live');
        const { r } = await kick();
        expect(r.targets[0]).toMatchObject({ saved: true, damage: 4, legendaryResisted: true, legendaryRemaining: 2 });
        expect(tok('ogre').legendaryResistancesRemaining).toBe(2);
        expect(sheetRow('ogre').legendaryResistancesRemaining).toBe(2);
        expect(tok('ogre').hp).toBe(196);
    });

    it('a live token not auto: the offer rides its fight with a saveRef, not a sheet repair', async () => {
        sheet('ogre', 'Ogre', { stats: { str: 18, dex: 1, con: 16, int: 5, wis: 7, cha: 7 }, legendaryResistances: 3, legendaryResistancesRemaining: 3 });
        ACTOR();
        await fight([
            { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'ogre', name: 'Ogre', hp: 200, maxHp: 200, initiative: 5, isEnemy: true, position: { x: 1, y: 0 } }
        ], 'k-live');
        const { r } = await kick();
        const call = `combat_manage legendary_resistance {encounterId: '${enc}', participantId: 'ogre', saveRef: 'stu-1-ogre-1', reason: 'save vs the stunt (kick the brazier)'}`;
        expect(r.targets[0]).toMatchObject({ saved: false, damage: 8, legendaryOffer: { saveRef: 'stu-1-ogre-1', call } });
        expect(r.legendaryOffers[0].noFight).toBeUndefined();
        expect(tok('ogre').pendingLegendaryOffers).toEqual([expect.objectContaining({ ref: 'stu-1-ogre-1', refund: 4 })]);
        expect(tok('ogre').hp).toBe(192);
        clearCombatState();
        const { r: spent } = await manage({ action: 'legendary_resistance', participantId: 'ogre', saveRef: 'stu-1-ogre-1', reason: 'the brazier' });
        expect(spent).toMatchObject({ success: true, refunded: 4, hp: 196 });
        expect(sheetRow('ogre').hp).toBe(196);
    });
});

describe('output_mode summary keeps an aura offer', () => {
    it("aura_manage process: legendaryOffers at the top level, the call whole", async () => {
        sheet('cleric', 'Cleric', { characterType: 'pc', stats: { str: 10, dex: 10, con: 14, int: 10, wis: 18, cha: 10 } });
        await fight([
            { id: 'cleric', name: 'Cleric', hp: 40, maxHp: 40, initiative: 20, position: { x: 5, y: 5 } },
            { id: 'dragon', name: 'Dragon', hp: 300, maxHp: 300, initiative: 10, isEnemy: true, position: { x: 6, y: 5 }, legendaryResistances: 3, stats: { str: 20, dex: 10, con: 20, int: 10, wis: 1, cha: 10 } }
        ], 'k-aura');
        await aura({ action: 'create', ownerId: 'cleric', spellName: 'Spirit Guardians', spellLevel: 3, radius: 15, affectsEnemies: true, effects: [{ trigger: 'start_of_turn', type: 'damage', dice: '3d8', damageType: 'radiant', saveType: 'wisdom', saveDC: 40 }], currentRound: 1 });
        const { r } = await aura({ action: 'process', encounterId: enc, targetId: 'dragon', trigger: 'start_of_turn' });
        const call = `combat_manage legendary_resistance {encounterId: '${enc}', participantId: 'dragon', reason: 'Spirit Guardians save'}`;
        expect(r.legendaryOffers).toEqual([expect.objectContaining({ participantId: 'dragon', name: 'Dragon', kind: 'aura', condition: 'Spirit Guardians', remaining: 3, call })]);
        const summary = summarizeResult(r) as Record<string, any>;
        expect(r.legendaryOffers[0].line).toBe(`⭐ Dragon: LR 3/3 left, spend one? ${call} (the aura report wrote nothing: on a spend the save succeeds, so apply none of this effect)`);
        expect(summary.legendaryOffers).toEqual([expect.objectContaining({ call, line: r.legendaryOffers[0].line })]);
        expect(tok('dragon').legendaryResistancesRemaining).toBe(3);
    });
});

describe('lair_action carries a concentration save offer', () => {
    it('a lair action breaks the hag\'s Hex: the offer at the top level, and its saveRef restores the spell', async () => {
        HAG();
        concentrating('hag');
        await fight([{ ...BRUTE, isEnemy: true, hasLairActions: true }, { ...HAG_TOKEN, isEnemy: false }]);
        let st = getOrLoadEngine(ctx as any, enc!)!.getState()!;
        while (st.turnOrder[st.currentTurnIndex] !== 'LAIR') { await manage({ action: 'advance', confirm: true }); st = getOrLoadEngine(ctx as any, enc!)!.getState()!; }
        const { r } = await manage({ action: 'lair_action', actionDescription: 'the ceiling falls', targetIds: ['hag'], damage: 60 });
        const ref = r.legendaryOffers?.[0]?.saveRef;
        expect(ref).toMatch(/^con-\d+-hag-1$/);
        expect(r.legendaryOffers[0]).toMatchObject({ kind: 'concentration', condition: 'Hex' });
        expect(concRow('hag')).toBeNull();
        const { r: spent } = await manage({ action: 'legendary_resistance', participantId: 'hag', saveRef: ref, reason: 'concentration save on Hex' });
        expect(spent).toMatchObject({ success: true, concentrationRestored: expect.objectContaining({ spell: 'Hex' }) });
        expect(concRow('hag')?.activeSpell).toBe('Hex');
    });
});
