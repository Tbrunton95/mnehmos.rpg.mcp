/**
 * Play report 2, item 1: Action Surge. An ability with grantsAction gives one
 * extra action on the user's own turn; a single takeAction primitive spends
 * the action, an open multiattack, or a banked extra, in that order.
 */
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

function fight(seed: string, fighter: Partial<CombatParticipant> = {}) {
    const e = new CombatEngine(seed);
    e.startEncounter([
        { id: 'fighter', name: 'Fighter', initiativeBonus: 0, initiative: 20, hp: 60, maxHp: 60, conditions: [], movementSpeed: 30,
            abilities: [{ name: 'Action Surge', grantsAction: true, ready: true }], ...fighter },
        { id: 'gob', name: 'Goblin', initiativeBonus: 0, initiative: 10, hp: 20, maxHp: 20, conditions: [], isEnemy: true, ac: 10 }
    ] as CombatParticipant[]);
    return e;
}
const who = (e: CombatEngine, id: string) => e.getState()!.participants.find(x => x.id === id)! as CombatParticipant & { extraActions?: number; dashes?: number };

describe('engine: extra actions', () => {
    it('grantExtraAction is refused off its own turn and when incapacitated; on its turn it banks one', () => {
        const e = fight('grant');
        const off = e.grantExtraAction('gob');
        expect(off.ok).toBe(false);
        expect((off as { error: string }).error).toMatch(/own turn/);
        e.applyCondition('fighter', { type: 'stunned', durationType: 'permanent' } as never);
        const stunned = e.grantExtraAction('fighter');
        expect(stunned.ok).toBe(false);
        expect((stunned as { error: string }).error).toMatch(/incapacitated/);
        e.removeCondition('fighter', who(e, 'fighter').conditions[0].id);
        const ok = e.grantExtraAction('fighter');
        expect(ok).toEqual({ ok: true, extraActions: 1 });
        expect(who(e, 'fighter').extraActions).toBe(1);
    });

    it('a spent action, a surge, then a second attack of a fresh Attack action', () => {
        const e = fight('surge-attack');
        expect(e.validateAttackEconomy('fighter').valid).toBe(true);
        expect(e.commitAttack('fighter')).toEqual({ made: 1, of: 1 });
        expect(e.validateAttackEconomy('fighter').valid).toBe(false);
        expect(e.grantExtraAction('fighter').ok).toBe(true);
        expect(e.validateAttackEconomy('fighter').valid).toBe(true);
        expect(e.commitAttack('fighter')).toEqual({ made: 1, of: 1 });
        expect(who(e, 'fighter').extraActions).toBe(0);
        expect(e.validateAttackEconomy('fighter').valid).toBe(false);
    });

    it('multiattack 2/2, a surge, two more swings, the fifth refused', () => {
        const e = fight('surge-multi', { attacksPerAction: 2 });
        expect(e.commitAttack('fighter')).toEqual({ made: 1, of: 2 });
        expect(e.commitAttack('fighter')).toEqual({ made: 2, of: 2 });
        expect(e.validateAttackEconomy('fighter').error).toMatch(/attacks 2\/2/);
        e.grantExtraAction('fighter');
        expect(e.validateAttackEconomy('fighter').valid).toBe(true);
        expect(e.commitAttack('fighter')).toEqual({ made: 1, of: 2 });
        // The open Attack action is finished before another extra would be spent.
        expect(e.validateAttackEconomy('fighter').valid).toBe(true);
        expect(e.commitAttack('fighter')).toEqual({ made: 2, of: 2 });
        expect(who(e, 'fighter').extraActions).toBe(0);
        expect(e.validateAttackEconomy('fighter').valid).toBe(false);
        expect(e.validateAttackEconomy('fighter').error).toMatch(/attacks 2\/2/);
    });

    it('Dash, a surge, Dash again: 90 ft of movement, dashes 2, and moveBudget follows', () => {
        const e = fight('surge-dash');
        expect(e.applyDash('fighter')).toEqual({ ok: true, movementRemaining: 60 });
        expect(e.applyDash('fighter').ok).toBe(false);
        expect((e.applyDash('fighter') as { error: string }).error).toMatch(/Action already used/);
        e.grantExtraAction('fighter');
        expect(e.applyDash('fighter')).toEqual({ ok: true, movementRemaining: 90 });
        const f = who(e, 'fighter');
        expect(f.dashes).toBe(2);
        expect(f.hasDashed).toBe(true);
        expect(e.moveBudget(f)).toBe(90);
        expect(f.extraActions).toBe(0);
    });

    it('Dodge and a committed action consume the extra; an open multiattack is closed by it', () => {
        const e = fight('surge-dodge', { attacksPerAction: 2 });
        e.commitAttack('fighter');
        expect(e.applyDodge('fighter').ok).toBe(false);
        e.grantExtraAction('fighter');
        expect(e.applyDodge('fighter').ok).toBe(true);
        const f = who(e, 'fighter');
        expect(f.extraActions).toBe(0);
        expect(f.attacksMade).toBe(2);
        expect(e.validateAttackEconomy('fighter').valid).toBe(false);
        // commitAction('action') goes through the same primitive.
        e.grantExtraAction('fighter');
        expect(e.validateActionEconomy('fighter', 'action').valid).toBe(true);
        e.commitAction('fighter', 'action');
        expect(who(e, 'fighter').extraActions).toBe(0);
        expect(e.validateActionEconomy('fighter', 'action').valid).toBe(false);
    });

    it('a banked extra clears at the end of the turn and at the next turn start', () => {
        const e = fight('surge-clear');
        e.commitAttack('fighter');
        e.grantExtraAction('fighter');
        expect(who(e, 'fighter').extraActions).toBe(1);
        e.nextTurnWithConditions(); // goblin
        expect(who(e, 'fighter').extraActions).toBe(0);
        // Off-turn, the spent action refuses as before: no swing on a stale surge.
        expect(e.validateAttackEconomy('fighter').valid).toBe(false);
        e.nextTurnWithConditions(); // fighter, round 2
        const f = who(e, 'fighter');
        expect(f.extraActions).toBe(0);
        expect(f.dashes).toBe(0);
        expect(f.actionUsed).toBe(false);
    });
});

// ── Tools ────────────────────────────────────────────────────────────────────
// The operation guard flushes engine dice for the unscoped session key and
// rolls back a refused call's writes, as in play.
const ctx = { sessionId: 'unscoped' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const guardedAct = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
const manage = async (args: Record<string, unknown>) => {
    const text = (await guardedManage(args)).content[0].text;
    return { text, d: tag(text, 'COMBAT_MANAGE') };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await guardedAct(args)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, d, r: d?.actionResult ?? d };
};
const tok = (enc: string, id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;
const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;

/**
 * A fighter with a character row whose sheet carries Action Surge; the token
 * is created without abilities so hydrateExtras reads the sheet. Initiative
 * puts the fighter first, so its turn is live at create.
 */
async function tableFight(opts: { sheetAbilities?: Array<Record<string, unknown>>; tokenAbilities?: Array<Record<string, unknown>>; fighter?: Record<string, unknown>; seed?: string } = {}) {
    const db = getDb();
    const now = new Date().toISOString();
    new CharacterRepository(db).create({
        id: 'fighter', name: 'Fighter', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 60, maxHp: 60, ac: 16, level: 5,
        abilities: opts.sheetAbilities ?? [{ name: 'Action Surge', grantsAction: true }],
        createdAt: now, updatedAt: now
    } as any);
    const { d } = await manage({ action: 'create', seed: opts.seed ?? 'surge-table', participants: [
        { id: 'fighter', name: 'Fighter', hp: 60, maxHp: 60, initiative: 20, position: { x: 0, y: 0 }, movementSpeed: 30,
            ...(opts.tokenAbilities ? { abilities: opts.tokenAbilities } : {}), ...(opts.fighter ?? {}) },
        { id: 'gob', name: 'Goblin', hp: 30, maxHp: 30, ac: 5, initiative: 10, isEnemy: true, position: { x: 1, y: 0 } }
    ] });
    return d.encounterId as string;
}

describe('tools: use_ability with grantsAction', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => closeDb());

    it('a sheet Action Surge hydrates onto the token; using it banks an extra action and marks token and sheet spent', async () => {
        const enc = await tableFight();
        expect(tok(enc, 'fighter').abilities).toEqual([{ name: 'Action Surge', grantsAction: true, ready: true }]);
        const { d } = await manage({ action: 'use_ability', encounterId: enc, participantId: 'fighter', ability: 'Action Surge' });
        expect(d).toMatchObject({ success: true, grantsAction: true, extraActions: 1, ready: false, mirroredToCharacter: true });
        expect(tok(enc, 'fighter').extraActions).toBe(1);
        expect(tok(enc, 'fighter').abilities[0].ready).toBe(false);
        expect(sheet('fighter').abilities[0]).toMatchObject({ name: 'Action Surge', ready: false });
        // The state view shows the banked action.
        const view = await manage({ action: 'get', encounterId: enc });
        expect(view.text).toMatch(/⚡ extra actions 1/);
        expect(JSON.stringify(view.d)).toMatch(/"extraActions":1/);
        // A new fight hydrates the sheet's spent state.
        const next = await manage({ action: 'create', seed: 'surge-next', participants: [
            { id: 'fighter', name: 'Fighter', hp: 60, maxHp: 60, initiative: 20 },
            { id: 'gob2', name: 'Goblin', hp: 30, maxHp: 30, initiative: 10, isEnemy: true }
        ] });
        expect(tok(next.d.encounterId, 'fighter').abilities[0].ready).toBe(false);
    });

    it('a grantsAction ability with a recharge is spent on the token only; the sheet keeps it ready', async () => {
        const enc = await tableFight({ sheetAbilities: [{ name: 'Action Surge', grantsAction: true, recharge: 5 }] });
        const { d } = await manage({ action: 'use_ability', encounterId: enc, participantId: 'fighter', ability: 'Action Surge' });
        expect(d).toMatchObject({ success: true, grantsAction: true, extraActions: 1, mirroredToCharacter: false });
        expect(tok(enc, 'fighter').abilities[0].ready).toBe(false);
        expect(sheet('fighter').abilities[0].ready).toBe(true);
    });

    it('the extra action survives an eviction and buys a second Dash: 90 ft, dashes 2, a 70 ft move accepted', async () => {
        const enc = await tableFight();
        expect((await act({ action: 'dash', encounterId: enc, actorId: 'fighter' })).d.movementRemaining).toBe(60);
        await manage({ action: 'use_ability', encounterId: enc, participantId: 'fighter', ability: 'Action Surge' });
        clearCombatState();
        expect(getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === 'fighter')!.extraActions).toBe(1);
        const second = await act({ action: 'dash', encounterId: enc, actorId: 'fighter' });
        expect(second.d.movementRemaining).toBe(90);
        // The reply owns up to the second Dash and the extra action it spent.
        expect(second.d).toMatchObject({ dashes: 2, extraActionSpent: true });
        expect(second.d.message).toMatch(/again \(dash 2\)\. Movement extended; 90ft remaining\. ⚡ The extra action \(Action Surge\) paid for it; 0 left/);
        expect(second.d.message).not.toMatch(/doubled/);
        const f = tok(enc, 'fighter');
        expect(f.dashes).toBe(2);
        expect(f.extraActions).toBe(0);
        const move = await act({ action: 'move', encounterId: enc, actorId: 'fighter', targetPosition: { x: 14, y: 0 } });
        expect(move.text).not.toMatch(/Insufficient movement/);
        expect(tok(enc, 'fighter').position).toEqual({ x: 14, y: 0 });
        expect(tok(enc, 'fighter').movementRemaining).toBe(20);
    });
});

describe('tools: combat_action attack {actionSurge}', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => closeDb());
    const swing = (enc: string, extra: Record<string, unknown> = {}) => act({ action: 'attack', encounterId: enc, actorId: 'fighter', targetId: 'gob', attackBonus: 20, damage: 1, ...extra });

    it('after the action is spent, actionSurge: true spends the token ability, swings, and mirrors the spend to the sheet', async () => {
        const enc = await tableFight();
        expect((await swing(enc)).r.success).toBe(true);
        const refused = await swing(enc);
        expect(refused.text).toMatch(/Action already used this turn/);
        const surged = await swing(enc, { actionSurge: true });
        expect(surged.r.success).toBe(true);
        expect(surged.text).toMatch(/⚡ Action Surge spent/);
        expect(surged.r.actionSurge).toEqual({ spent: true, ability: 'Action Surge', source: 'token', mirroredToCharacter: true, extraActions: 0 });
        expect(tok(enc, 'fighter').abilities[0].ready).toBe(false);
        expect(sheet('fighter').abilities[0].ready).toBe(false);
        expect(tok(enc, 'gob').hp).toBe(28);
        // Spent: a fourth swing with the flag is refused and nothing moves.
        const again = await swing(enc, { actionSurge: true });
        expect(again.text).toMatch(/Action already used this turn; Action Surge is spent \(character_manage restore_ability or a rest readies it\)/);
        expect(tok(enc, 'gob').hp).toBe(28);
    });

    it('while the action is free the flag is a no-op and the ability stays ready', async () => {
        const enc = await tableFight();
        const first = await swing(enc, { actionSurge: true });
        expect(first.r.success).toBe(true);
        expect(first.r.actionSurge).toEqual({ spent: false });
        expect(first.text).toMatch(/action still free: Action Surge not spent/);
        expect(tok(enc, 'fighter').abilities[0].ready).toBe(true);
        expect(sheet('fighter').abilities[0].ready).toBe(true);
    });

    it('a string names the ability; a name that grants no action, or is unknown, is refused with the token untouched', async () => {
        const enc = await tableFight({ sheetAbilities: [{ name: 'Second Wind' }, { name: 'Surge', grantsAction: true }] });
        await swing(enc);
        const wrong = await swing(enc, { actionSurge: 'Second Wind' });
        expect(wrong.text).toMatch(/Second Wind grants no action \(set grantsAction: true on it\)/);
        const unknown = await swing(enc, { actionSurge: 'Haste' });
        expect(unknown.text).toMatch(/no ability 'Haste'; it has Second Wind, Surge/);
        expect(tok(enc, 'fighter').abilities.every((a: any) => a.ready !== false)).toBe(true);
        const named = await swing(enc, { actionSurge: 'surge' });
        expect(named.r.actionSurge).toMatchObject({ spent: true, ability: 'Surge' });
        expect(named.text).toMatch(/⚡ Action Surge spent \(Surge\)/);
        expect(tok(enc, 'fighter').abilities[1].ready).toBe(false);
    });

    it('a sheet-only ability is found when the token carries its own abilities; the spend lands on the sheet', async () => {
        const enc = await tableFight({ tokenAbilities: [{ name: 'Shield Bash' }] });
        await swing(enc);
        const surged = await swing(enc, { actionSurge: true });
        expect(surged.r.actionSurge).toMatchObject({ spent: true, ability: 'Action Surge', source: 'sheet', mirroredToCharacter: true });
        expect(sheet('fighter').abilities[0].ready).toBe(false);
        expect(tok(enc, 'fighter').abilities).toEqual([{ name: 'Shield Bash', ready: true }]);
    });

    it('a token copy marked spent is never bypassed by a ready sheet copy of the same name', async () => {
        // A recharge surge is spent on the token only (the sheet keeps it ready
        // for the next fight); the shorthand must not read the sheet copy as a
        // second surge in the same turn.
        const enc = await tableFight({ sheetAbilities: [{ name: 'Action Surge', grantsAction: true, recharge: 5 }] });
        await manage({ action: 'use_ability', encounterId: enc, participantId: 'fighter', ability: 'Action Surge' });
        expect(tok(enc, 'fighter').abilities[0].ready).toBe(false);
        expect(sheet('fighter').abilities[0].ready).toBe(true);
        expect((await swing(enc)).r.success).toBe(true); // the action
        expect((await swing(enc)).r.success).toBe(true); // the banked extra
        expect(tok(enc, 'gob').hp).toBe(28);
        const third = await swing(enc, { actionSurge: true });
        expect(third.text).toMatch(/Action already used this turn; Action Surge is spent/);
        expect(third.r?.success).not.toBe(true);
        expect(tok(enc, 'gob').hp).toBe(28);
        expect(sheet('fighter').abilities[0].ready).toBe(true);
        // By name too, and through grapple.
        const named = await swing(enc, { actionSurge: 'Action Surge' });
        expect(named.text).toMatch(/Action Surge is spent/);
        const hold = await act({ action: 'grapple', move: 'clinch', encounterId: enc, actorId: 'fighter', targetId: 'gob', actionSurge: true });
        expect(hold.d).toMatchObject({ error: true, writes: 'none' });
        expect(hold.d.message).toMatch(/Action Surge is spent/);
        expect(sheet('fighter').abilities[0].ready).toBe(true);
        // A sheet ability of another name is still a second source.
        new CharacterRepository(getDb()).update('fighter', { abilities: [{ name: 'Action Surge', grantsAction: true, recharge: 5 }, { name: 'Heroic Burst', grantsAction: true }] } as never);
        const other = await swing(enc, { actionSurge: true });
        expect(other.r.actionSurge).toMatchObject({ spent: true, ability: 'Heroic Burst', source: 'sheet' });
        expect(sheet('fighter').abilities[1].ready).toBe(false);
    });

    it('a reaction and an Action Surge do not mix', async () => {
        const enc = await tableFight();
        await manage({ action: 'advance', encounterId: enc }); // goblin's turn
        const both = await swing(enc, { reaction: true, actionSurge: true });
        expect(both.text).toMatch(/reaction or an Action Surge, not both/);
        expect(tok(enc, 'fighter').reactionUsed).toBeFalsy();
        expect(tok(enc, 'fighter').abilities[0].ready).toBe(true);
        expect(tok(enc, 'gob').hp).toBe(30);
    });

    it('a legendary action and an Action Surge do not mix', async () => {
        const enc = await tableFight({ fighter: { legendaryActions: 3 } });
        await manage({ action: 'advance', encounterId: enc }); // goblin's turn
        const both = await swing(enc, { legendaryCost: 1, actionSurge: true });
        expect(both.text).toMatch(/legendary action or an Action Surge, not both/);
        expect(tok(enc, 'fighter').legendaryActionsRemaining).toBe(3);
        expect(tok(enc, 'fighter').abilities[0].ready).toBe(true);
    });

    it('a Ready after a surge says it spent the extra action', async () => {
        const enc = await tableFight();
        await swing(enc);
        await manage({ action: 'use_ability', encounterId: enc, participantId: 'fighter', ability: 'Action Surge' });
        const ready = await act({ action: 'ready', encounterId: enc, actorId: 'fighter', readiedAction: 'swing', trigger: 'the goblin moves' });
        expect(ready.d).toMatchObject({ success: true, extraActionSpent: true });
        expect(ready.d.warning).toBeUndefined();
        expect(ready.d.message).toMatch(/extra action \(Action Surge\) paid for it; 0 left/);
        expect(tok(enc, 'fighter').extraActions).toBe(0);
    });
});
