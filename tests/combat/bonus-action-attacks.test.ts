import { CombatEngine } from '../../src/engine/combat/engine.js';
import { evaluateAttackTrigger, attackTriggerProblem } from '../../src/engine/combat/attack-triggers.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 5, item 3: trigger-tied bonus-action attacks. A profile (or
 * the call) may say `bonusAction: true` and `requires: {dashed, movedAtLeast,
 * hitThisTurn}`; the engine tracks movedThisTurn and movedSinceDash (reset
 * at turn start, movedSinceDash reset by Dash, the move handler adds the
 * feet walked) and names exactly what is missing when it refuses, before
 * anything is spent. The bonus attack spends the bonus action only: an open
 * multiattack is untouched. Side fix: `dash {targetPosition}` used to be
 * accepted and ignored; it now dashes and moves in one call.
 */
const ctx = { sessionId: 'bonus-attacks' };
const embedded = (res: any, tag: string) => {
    const m = res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : { rawText: res.content[0].text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');
const dice = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

const GORING = { name: 'Goring Rush', attackBonus: 5, damage: '1d6+3', damageType: 'piercing', bonusAction: true, requires: { dashed: true, movedAtLeast: 20 } };
const FOLLOW_UP = { name: 'Horn Follow-up', attackBonus: 5, damage: '1d4+3', damageType: 'piercing', bonusAction: true, requires: { hitThisTurn: true } };
const GREATAXE = { name: 'greataxe', attackBonus: 5, damage: '1d12+3', damageType: 'slashing', default: true };
const varek = (extra: Record<string, unknown> = {}) => ({ id: 'varek', name: 'Varek', hp: 40, maxHp: 40, initiative: 20, position: { x: 0, y: 0 }, attacks: [GREATAXE, GORING, FOLLOW_UP], ...extra });
const bandit = (extra: Record<string, unknown> = {}) => ({ id: 'bandit', name: 'Bandit', hp: 30, maxHp: 30, ac: 12, initiative: 5, isEnemy: true, position: { x: 5, y: 0 }, attackBonus: 3, attackDamage: '1d6', ...extra });

describe('attack triggers (pure)', () => {
    const p = (over: Record<string, unknown>) => ({ id: 'v', name: 'Varek', hp: 1, maxHp: 1, conditions: [], position: { x: 0, y: 0 }, ...over }) as any;

    it('names what is missing: a Dash, feet after it, a melee hit on the target', () => {
        expect(attackTriggerProblem(p({}), { dashed: true, movedAtLeast: 20 }, { label: 'Goring Rush' })).toBe('Goring Rush needs a Dash this turn and 20 ft moved after it: dashed no, moved 0 ft');
        expect(attackTriggerProblem(p({ dashes: 1, movedSinceDash: 15, movedThisTurn: 25 }), { dashed: true, movedAtLeast: 20 }, { label: 'Goring Rush' })).toBe('Goring Rush needs a Dash this turn and 20 ft moved after it: dashed yes, moved 15 ft');
        expect(attackTriggerProblem(p({ dashes: 1, movedSinceDash: 20 }), { dashed: true, movedAtLeast: 20 }, { label: 'Goring Rush' })).toBeUndefined();
        // Without a Dash in the requirement, the whole turn's movement counts.
        expect(attackTriggerProblem(p({ movedThisTurn: 25, movedSinceDash: 0 }), { movedAtLeast: 20 }, { label: 'Charge' })).toBeUndefined();
        expect(attackTriggerProblem(p({ meleeHitsThisTurn: ['other'] }), { hitThisTurn: true }, { label: 'Horn Follow-up', targetId: 'bandit' })).toMatch(/needs a melee hit on bandit this turn: no hit on bandit/);
        expect(attackTriggerProblem(p({ meleeHitsThisTurn: ['bandit'] }), { hitThisTurn: true }, { label: 'Horn Follow-up', targetId: 'bandit' })).toBeUndefined();
    });

    it('a token without a position uses the declared movedFt and says so', () => {
        const r = evaluateAttackTrigger(p({ position: undefined, dashes: 1 }), { dashed: true, movedAtLeast: 20 }, { label: 'Goring Rush', movedFt: 25 });
        expect(r.problem).toBeUndefined();
        expect(r.facts).toMatchObject({ dashed: true, movedFt: 25, movedSource: 'declared' });
        expect(evaluateAttackTrigger(p({ position: undefined, dashes: 1 }), { dashed: true, movedAtLeast: 20 }, { label: 'Goring Rush' }).problem).toMatch(/moved 0 ft \(no position: pass movedFt\)/);
        // With a position the grid decides; a declared figure is not trusted over it.
        expect(evaluateAttackTrigger(p({ dashes: 1, movedSinceDash: 10 }), { dashed: true, movedAtLeast: 20 }, { label: 'Goring Rush', movedFt: 25 }).problem).toMatch(/moved 10 ft/);
    });
});

describe('trigger-tied bonus-action attacks', () => {
    let encounterId: string;
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(encounterId)!.participants.find((t: any) => t.id === id) as any;
    const fight = async (participants: Array<Record<string, unknown>>) => {
        const created = await manage({ action: 'create', seed: 'goring', participants });
        encounterId = created.encounterId;
    };
    const move = (x: number, y: number, actorId = 'varek') => act({ action: 'move', encounterId, actorId, targetPosition: { x, y } });
    const dash = (extra: Record<string, unknown> = {}) => act({ action: 'dash', encounterId, actorId: 'varek', ...extra });
    const attack = (extra: Record<string, unknown>) => act({ action: 'attack', encounterId, actorId: 'varek', targetId: 'bandit', ...extra });

    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('Goring Rush is refused before a Dash, refused after a Dash and 15 ft, and lands after 20 ft, spending the bonus action only', async () => {
        await fight([varek(), bandit()]);
        const before = await attack({ using: 'Goring Rush' });
        expect(before.error).toBe(true);
        expect(before.writes).toBe('none');
        expect(String(before.message)).toMatch(/Goring Rush needs a Dash this turn and 20 ft moved after it: dashed no, moved 0 ft/);
        expect(tok('varek').bonusActionUsed).toBeFalsy();
        expect(tok('varek').actionUsed).toBeFalsy();

        await dash();
        await move(3, 0);
        const short = await attack({ using: 'Goring Rush' });
        expect(short.error).toBe(true);
        expect(short.writes).toBe('none');
        expect(String(short.message)).toMatch(/dashed yes, moved 15 ft/);
        expect(tok('varek').movedThisTurn).toBe(15);
        expect(tok('varek').movedSinceDash).toBe(15);

        await move(4, 0);
        dice(15);
        const res = await attack({ using: 'Goring Rush' });
        expect(res.error).toBeFalsy();
        const r = res.actionResult;
        expect(r.success).toBe(true);
        expect(r.bonusAction).toMatchObject({ spent: true, trigger: { dashed: true, movedFt: 20, movedSource: 'grid' } });
        expect(r.attackProfile?.name).toBe('Goring Rush');
        const v = tok('varek');
        expect(v.bonusActionUsed).toBe(true);
        expect(v.actionUsed).toBe(true);      // the Dash's
        expect(v.attacksMade ?? 0).toBe(0);   // no swing of the Attack action
        expect(res.rawText).toMatch(/bonus action spent/);
    });

    it('a second bonus action, an off-turn one, or one with reaction / legendaryCost / actionSurge is refused before anything is spent', async () => {
        await fight([varek({ attacks: [GREATAXE, { ...GORING, requires: undefined }] }), bandit({ attacks: [{ name: 'club', attackBonus: 3, damage: '1d4', bonusAction: true }] })]);
        dice(15);
        const first = await attack({ using: 'Goring Rush' });
        expect(first.error).toBeFalsy();
        const again = await attack({ using: 'Goring Rush' });
        expect(again.error).toBe(true);
        expect(again.writes).toBe('none');
        expect(String(again.message)).toMatch(/Bonus Action already used/);

        const offTurn = await act({ action: 'attack', encounterId, actorId: 'bandit', targetId: 'varek', using: 'club' });
        expect(offTurn.error).toBe(true);
        expect(offTurn.writes).toBe('none');
        expect(String(offTurn.message)).toMatch(/own turn/);
        expect(tok('bandit').bonusActionUsed).toBeFalsy();

        for (const extra of [{ reaction: true }, { legendaryCost: 1 }, { actionSurge: true }]) {
            const bad = await attack({ using: 'greataxe', bonusAction: true, ...extra });
            expect(bad.error).toBe(true);
            expect(bad.writes).toBe('none');
            expect(String(bad.message)).toMatch(/not both/);
        }
        expect(tok('varek').actionUsed).toBeFalsy();
    });

    it('movement before the Dash counts for the turn but not after it; both counters reset at the next turn and survive set_environment', async () => {
        await fight([varek(), bandit({ position: { x: 9, y: 0 } })]);
        await move(2, 0);           // 10 ft before the Dash
        await dash();
        await move(5, 0);           // 15 ft after it
        expect(tok('varek')).toMatchObject({ movedThisTurn: 25, movedSinceDash: 15 });
        const refused = await attack({ using: 'Goring Rush' });
        expect(String(refused.message)).toMatch(/moved 15 ft/);

        await manage({ action: 'set_environment', encounterId, environment: { medium: 'air' } });
        expect(tok('varek')).toMatchObject({ movedThisTurn: 25, movedSinceDash: 15 });

        await manage({ action: 'advance', encounterId });   // bandit
        await manage({ action: 'advance', encounterId });   // varek again
        expect(tok('varek')).toMatchObject({ movedThisTurn: 0, movedSinceDash: 0 });
        expect(tok('varek').bonusActionUsed).toBeFalsy();
    });

    it('theatre of the mind: with no positions the GM declares movedFt, and the reply says it was declared', async () => {
        await fight([varek({ position: undefined }), bandit({ position: undefined })]);
        await dash();
        const none = await attack({ using: 'Goring Rush' });
        expect(none.error).toBe(true);
        expect(String(none.message)).toMatch(/pass movedFt/);
        dice(15);
        const res = await attack({ using: 'Goring Rush', movedFt: 25 });
        expect(res.error).toBeFalsy();
        expect(res.actionResult.bonusAction.trigger).toMatchObject({ dashed: true, movedFt: 25, movedSource: 'declared' });
    });

    it('hitThisTurn: the follow-up needs a melee hit on that target this turn', async () => {
        await fight([varek({ position: { x: 4, y: 0 } }), bandit()]);
        const early = await attack({ using: 'Horn Follow-up' });
        expect(early.error).toBe(true);
        expect(String(early.message)).toMatch(/needs a melee hit on bandit this turn/);
        dice(15);
        const hit = await attack({ using: 'greataxe' });
        expect(hit.actionResult.success).toBe(true);
        expect(tok('varek').meleeHitsThisTurn).toEqual(['bandit']);
        dice(15);
        const follow = await attack({ using: 'Horn Follow-up' });
        expect(follow.error).toBeFalsy();
        expect(follow.actionResult.bonusAction).toMatchObject({ spent: true, trigger: { hitThisTurn: true } });
    });

    it('with multiattack, a bonus-action swing leaves the open Attack action where it was', async () => {
        await fight([varek({ position: { x: 4, y: 0 }, attacksPerAction: 2 }), bandit()]);
        dice(15);
        await attack({ using: 'greataxe' });
        expect(tok('varek').attacksMade).toBe(1);
        dice(15);
        const bonus = await attack({ using: 'greataxe', bonusAction: true });
        expect(bonus.error).toBeFalsy();
        expect(bonus.actionResult.bonusAction).toMatchObject({ spent: true });
        expect(bonus.actionResult.multiattack).toBeUndefined();
        expect(tok('varek').attacksMade).toBe(1);
        expect(tok('varek').bonusActionUsed).toBe(true);
        dice(15);
        const second = await attack({ using: 'greataxe' });
        expect(second.error).toBeFalsy();
        expect(tok('varek').attacksMade).toBe(2);
    });

    it('requires on the call itself ties an ordinary attack to a trigger; a profile on the sheet carries the flags too', async () => {
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        repo.create({ id: 'varek', name: 'Varek', characterType: 'pc', stats: { str: 18, dex: 10, con: 16, int: 8, wis: 10, cha: 10 }, hp: 40, maxHp: 40, ac: 15, level: 3, attacks: [GREATAXE, GORING], createdAt: now, updatedAt: now } as any);
        await fight([varek({ attacks: undefined }), bandit()]);
        expect(repo.findById('varek')!.attacks![1]).toMatchObject({ bonusAction: true, requires: { dashed: true, movedAtLeast: 20 } });
        const tied = await attack({ using: 'greataxe', requires: { dashed: true } });
        expect(tied.error).toBe(true);
        expect(tied.writes).toBe('none');
        expect(String(tied.message)).toMatch(/greataxe needs a Dash this turn: dashed no/);
        const sheetProfile = await attack({ using: 'Goring Rush' });
        expect(sheetProfile.error).toBe(true);
        expect(String(sheetProfile.message)).toMatch(/Goring Rush needs a Dash/);
    });

    it('profile flags survive token persistence', async () => {
        await fight([varek(), bandit()]);
        const goring = tok('varek').attacks.find((a: any) => a.name === 'Goring Rush');
        expect(goring).toMatchObject({ bonusAction: true, requires: { dashed: true, movedAtLeast: 20 } });
    });

    it('dash {targetPosition} dashes and moves in one call, so Goring Rush follows; a blocked square still spends the Dash and says why', async () => {
        await fight([varek(), bandit()]);
        const res = await dash({ targetPosition: { x: 4, y: 0 } });
        expect(res.error).toBeFalsy();
        expect(res.dashes).toBe(1);
        expect(res.move).toMatchObject({ success: true, to: { x: 4, y: 0 }, feet: 20 });
        expect(res.movementRemaining).toBe(40);
        expect(tok('varek')).toMatchObject({ position: { x: 4, y: 0 }, movedSinceDash: 20, movedThisTurn: 20 });
        dice(15);
        const rush = await attack({ using: 'Goring Rush' });
        expect(rush.error).toBeFalsy();
        expect(rush.actionResult.bonusAction.trigger).toMatchObject({ dashed: true, movedFt: 20 });

        closeDb(); getDb(':memory:'); clearCombatState();
        await fight([varek(), bandit()]);
        const blocked = await dash({ targetPosition: { x: 5, y: 0 } });
        expect(blocked.error).toBeFalsy();
        expect(blocked.move).toMatchObject({ success: false });
        expect(JSON.stringify(blocked.move)).toMatch(/blocked/i);
        expect(tok('varek')).toMatchObject({ dashes: 1, position: { x: 0, y: 0 } });
    });
});
