/**
 * Play report 2, item 7: surprise. A surprised participant loses its round-1
 * turn (the slot passes with a note; regeneration, recharge and durations
 * still tick) and cannot react, act or take legendary actions until that
 * slot has passed. Then it is an ordinary combatant.
 */
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

type P = CombatParticipant & { surprised?: boolean };
const who = (e: CombatEngine, id: string) => e.getState()!.participants.find(x => x.id === id)! as P;
const current = (e: CombatEngine) => e.getState()!.turnOrder[e.getState()!.currentTurnIndex];

function trio(seed: string, gob: Partial<P> = {}, hero: Partial<P> = {}) {
    const e = new CombatEngine(seed);
    e.startEncounter([
        { id: 'hero', name: 'Hero', initiativeBonus: 0, initiative: 20, hp: 30, maxHp: 30, conditions: [], position: { x: 0, y: 0 }, ...hero },
        { id: 'gob', name: 'Goblin', initiativeBonus: 0, initiative: 15, hp: 20, maxHp: 20, conditions: [], isEnemy: true, position: { x: 2, y: 1 }, surprised: true, ...gob },
        { id: 'orc', name: 'Orc', initiativeBonus: 0, initiative: 10, hp: 30, maxHp: 30, conditions: [], isEnemy: true }
    ] as P[]);
    return e;
}

describe('engine: a surprised participant loses its first turn', () => {
    it('its round-1 slot passes with a note; the flag clears; the next actor is up', () => {
        const e = trio('pass');
        expect(current(e)).toBe('hero');
        e.nextTurnWithConditions();
        expect(current(e)).toBe('orc');
        expect(e.getState()!.round).toBe(1);
        expect(e.turnStartNotes).toContain('😲 Goblin is surprised: its first turn passes');
        expect(who(e, 'gob').surprised).toBe(false);
        // Round 2: the goblin acts.
        e.nextTurnWithConditions(); // hero, round 2
        e.nextTurnWithConditions(); // goblin
        expect(current(e)).toBe('gob');
        expect(e.getState()!.round).toBe(2);
        expect(e.turnStartNotes.some(n => /surprised/.test(n))).toBe(false);
    });

    it('regeneration and recharge still tick on the passed turn', () => {
        const e = trio('tick', { hp: 10, regeneration: 5, abilities: [{ name: 'Fire Breath', recharge: 2, ready: false }] });
        e.nextTurnWithConditions();
        const gob = who(e, 'gob');
        expect(gob.hp).toBe(15);
        expect(e.turnStartNotes.some(n => /Goblin regenerates 5 HP/.test(n))).toBe(true);
        expect(e.turnStartNotes.some(n => /Fire Breath (recharges|does not recharge)/.test(n))).toBe(true);
    });

    it('a surprised actor first in the order is passed at startEncounter', () => {
        const e = new CombatEngine('first');
        e.startEncounter([
            { id: 'gob', name: 'Goblin', initiativeBonus: 0, initiative: 20, hp: 20, maxHp: 20, conditions: [], isEnemy: true, surprised: true },
            { id: 'hero', name: 'Hero', initiativeBonus: 0, initiative: 10, hp: 30, maxHp: 30, conditions: [] }
        ] as P[]);
        expect(current(e)).toBe('hero');
        expect(e.getState()!.currentTurnIndex).toBe(1);
        expect(e.turnStartNotes).toContain('😲 Goblin is surprised: its first turn passes');
        expect(who(e, 'gob').surprised).toBe(false);
    });

    it('everyone surprised: round 1 passes and the first actor acts in round 2', () => {
        const e = new CombatEngine('all');
        e.startEncounter([
            { id: 'a', name: 'A', initiativeBonus: 0, initiative: 20, hp: 20, maxHp: 20, conditions: [], surprised: true },
            { id: 'b', name: 'B', initiativeBonus: 0, initiative: 10, hp: 20, maxHp: 20, conditions: [], surprised: true }
        ] as P[]);
        expect(current(e)).toBe('a');
        expect(e.getState()!.round).toBe(2);
        expect(e.turnStartNotes.filter(n => /surprised/.test(n))).toHaveLength(2);
    });

    it('a surprised creature at 0 HP still clears its flag when its slot comes', () => {
        const e = trio('downed', { hp: 0 });
        e.nextTurnWithConditions(); // goblin skipped (down), flag cleared
        expect(current(e)).toBe('orc');
        expect(who(e, 'gob').surprised).toBe(false);
        expect(e.turnStartNotes.some(n => /surprised/.test(n))).toBe(false);
        e.heal('gob', 5);
        e.nextTurnWithConditions(); // hero, round 2
        e.nextTurnWithConditions(); // goblin acts
        expect(current(e)).toBe('gob');
        expect(e.canTakeReactions('gob')).toBe(true);
        expect(e.validateActionEconomy('gob', 'action').valid).toBe(true);
    });
});

describe('engine: a surprised participant cannot react or act until its slot passes', () => {
    const path = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }];

    it('canTakeReactions is false while surprised, true after its slot', () => {
        const e = trio('react');
        expect(e.canTakeReactions('gob')).toBe(false);
        expect(e.getOpportunityAttackers('hero', path)).toEqual([]);
        e.nextTurnWithConditions();
        expect(e.canTakeReactions('gob')).toBe(true);
        expect(e.getOpportunityAttackers('hero', path).map(h => h.attacker.id)).toEqual(['gob']);
    });

    it('validateActionEconomy refuses action, bonus and reaction with the surprise message', () => {
        const e = trio('econ');
        for (const kind of ['action', 'bonus', 'reaction'] as const) {
            const v = e.validateActionEconomy('gob', kind);
            expect(v.valid).toBe(false);
            expect(v.error).toMatch(/Goblin is surprised/);
        }
        expect(e.validateAttackEconomy('gob').error).toMatch(/surprised/);
        e.nextTurnWithConditions();
        expect(e.validateActionEconomy('gob', 'reaction').valid).toBe(true);
    });

    it('legendaryActionProblem refuses while surprised', () => {
        const e = trio('legendary', { legendaryActions: 3 });
        expect(e.legendaryActionProblem('gob')).toMatch(/Goblin is surprised/);
        e.nextTurnWithConditions();
        e.nextTurnWithConditions(); // hero, round 2: the goblin may act off-turn
        expect(e.legendaryActionProblem('gob')).toBeUndefined();
    });
});

// ── Tools ────────────────────────────────────────────────────────────────────
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

// The corridor from reactions.test.ts: a walk from (0,0) to (4,0) along y=0
// passes the goblin at (2,1) and leaves its reach after (3,0).
const WALLS = ['1,-1', '2,-1', '3,-1', '1,1', '3,1'];
const hero = (extra: Record<string, unknown> = {}) => ({ id: 'hero', name: 'Hero', hp: 30, maxHp: 30, ac: 12, initiative: 20, position: { x: 0, y: 0 }, ...extra });
const gob = (extra: Record<string, unknown> = {}) => ({ id: 'gob', name: 'Goblin', hp: 30, maxHp: 30, ac: 12, initiative: 10, isEnemy: true, attackBonus: 40, attackDamage: '1d1+2', position: { x: 2, y: 1 }, ...extra });

describe('tools: surprise at create', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => closeDb());

    it('create {surprised} flags the token, shows it, passes its slot on advance, and it reacts from round 2', async () => {
        const created = await manage({ action: 'create', seed: 'surprise-oa', participants: [hero(), gob()], terrain: { obstacles: WALLS }, surprised: ['gob'] });
        const enc = created.d.encounterId as string;
        expect(created.text).toMatch(/Goblin.*😲 surprised/);
        expect(created.d.participants.find((p: any) => p.id === 'gob').surprised).toBe(true);
        expect(tok(enc, 'gob').surprised).toBe(true);
        // Round 1: the walk past the goblin provokes nothing.
        const walk = await act({ action: 'move', encounterId: enc, actorId: 'hero', targetPosition: { x: 4, y: 0 } });
        expect(walk.r.opportunityAttacks ?? []).toEqual([]);
        expect(tok(enc, 'gob').reactionUsed).toBeFalsy();
        expect(tok(enc, 'hero').hp).toBe(30);
        // Advance: the goblin's slot passes with the note; the hero is up in round 2.
        const adv = await manage({ action: 'advance', encounterId: enc });
        expect(adv.text).toMatch(/😲 Goblin is surprised: its first turn passes/);
        expect(adv.d.round).toBe(2);
        expect(adv.d.currentTurn.id).toBe('hero');
        expect(tok(enc, 'gob').surprised).toBe(false);
        expect(adv.text).not.toMatch(/😲 surprised/);
        // Round 2: the walk back provokes.
        const back = await act({ action: 'move', encounterId: enc, actorId: 'hero', targetPosition: { x: 0, y: 0 } });
        expect(back.r.opportunityAttacks).toHaveLength(1);
        expect(tok(enc, 'gob').reactionUsed).toBe(true);
    });

    it('the flag survives an eviction and reload; a reload after its slot passed never re-skips it', async () => {
        const created = await manage({ action: 'create', seed: 'surprise-reload', participants: [hero(), gob()], surprised: ['gob'] });
        const enc = created.d.encounterId as string;
        clearCombatState();
        expect((getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === 'gob') as any).surprised).toBe(true);
        await manage({ action: 'advance', encounterId: enc }); // goblin passed, hero round 2
        clearCombatState();
        await manage({ action: 'advance', encounterId: enc }); // goblin acts
        const state = getOrLoadEngine(ctx as any, enc)!.getState()!;
        expect(state.turnOrder[state.currentTurnIndex]).toBe('gob');
        expect(state.round).toBe(2);
    });

    it('a surprised first actor is passed at create, with the note', async () => {
        const created = await manage({ action: 'create', seed: 'surprise-first', participants: [hero(), gob()], surprised: ['hero'] });
        expect(created.text).toMatch(/😲 Hero is surprised: its first turn passes/);
        expect(created.d.currentTurn.id).toBe('gob');
        expect(created.d.round).toBe(1);
        expect(tok(created.d.encounterId, 'hero').surprised).toBe(false);
    });

    it('an id that names nobody is refused with writes none and no encounter row', async () => {
        const { d } = await manage({ action: 'create', seed: 'surprise-bad', participants: [hero(), gob()], surprised: ['nobody'] });
        expect(d).toMatchObject({ error: true, writes: 'none' });
        expect(d.message).toMatch(/surprised names no participant: nobody/);
        expect((getDb().prepare('SELECT COUNT(*) AS n FROM encounters').get() as { n: number }).n).toBe(0);
    });

    it('while surprised: attack {reaction: true}, trigger_readied and use_ability are refused, writing nothing', async () => {
        const created = await manage({ action: 'create', seed: 'surprise-refuse', participants: [hero(), gob({ abilities: [{ name: 'Nasty Bite', actionCost: 'reaction' }] })], surprised: ['gob'] });
        const enc = created.d.encounterId as string;
        const swing = await act({ action: 'attack', encounterId: enc, actorId: 'gob', targetId: 'hero', reaction: true, attackBonus: 40, damage: 3 });
        expect(swing.text).toMatch(/Goblin is surprised/);
        expect(tok(enc, 'hero').hp).toBe(30);
        expect(tok(enc, 'gob').reactionUsed).toBeFalsy();
        await manage({ action: 'set_intent', encounterId: enc, participantId: 'gob', readied: { action: 'stab', trigger: 'the hero moves' } });
        const fired = await manage({ action: 'trigger_readied', encounterId: enc, participantId: 'gob' });
        expect(fired.d).toMatchObject({ error: true, writes: 'none' });
        expect(fired.d.message).toMatch(/cannot take reactions \(down, surprised/);
        const bite = await manage({ action: 'use_ability', encounterId: enc, participantId: 'gob', ability: 'Nasty Bite' });
        expect(bite.d).toMatchObject({ error: true, writes: 'none' });
        expect(bite.d.message).toMatch(/surprised/);
    });

    it('while surprised: a free ability (actionCost none) and a free battle cry are refused too, writing nothing', async () => {
        const created = await manage({ action: 'create', seed: 'surprise-free', participants: [hero(), gob({ abilities: [{ name: 'Taunt', actionCost: 'none' }] })], surprised: ['gob'] });
        const enc = created.d.encounterId as string;
        const taunt = await manage({ action: 'use_ability', encounterId: enc, participantId: 'gob', ability: 'Taunt' });
        expect(taunt.d).toMatchObject({ error: true, writes: 'none' });
        expect(taunt.d.message).toMatch(/Goblin is surprised/);
        const cry = await manage({ action: 'battle_cry', encounterId: enc, participantId: 'gob', name: 'Waaagh!', attackAdvantage: true });
        expect(cry.d).toMatchObject({ error: true, writes: 'none' });
        expect(cry.d.message).toMatch(/Goblin is surprised/);
        expect(tok(enc, 'gob').buffs ?? []).toEqual([]);
        // Once its slot has passed, both go through.
        await manage({ action: 'advance', encounterId: enc }); // goblin passed; hero round 2
        expect((await manage({ action: 'use_ability', encounterId: enc, participantId: 'gob', ability: 'Taunt' })).d.success).toBe(true);
        expect((await manage({ action: 'battle_cry', encounterId: enc, participantId: 'gob', name: 'Waaagh!', attackAdvantage: true })).d.success).toBe(true);
    });
});

describe('tools: set_surprised', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => closeDb());
    const orc = { id: 'orc', name: 'Orc', hp: 30, maxHp: 30, ac: 12, initiative: 5, isEnemy: true };

    it('flags a participant whose round-1 turn has not come, logs it, and the slot passes on advance', async () => {
        const created = await manage({ action: 'create', seed: 'set-surprised', participants: [hero(), gob(), orc] });
        const enc = created.d.encounterId as string;
        const set = await manage({ action: 'set_surprised', encounterId: enc, participantIds: ['gob'], reason: 'ambushed at the ford' });
        expect(set.d).toMatchObject({ success: true, actionType: 'set_surprised', participantIds: ['gob'], surprised: true });
        expect(set.text).toMatch(/😲 Goblin surprised/);
        expect(tok(enc, 'gob').surprised).toBe(true);
        expect((await manage({ action: 'get_history', encounterId: enc })).text).toMatch(/ambushed at the ford/);
        const adv = await manage({ action: 'advance', encounterId: enc });
        expect(adv.text).toMatch(/Goblin is surprised: its first turn passes/);
        expect(adv.d.currentTurn.id).toBe('orc');
        // The alias reaches it; surprised: false clears a flag at any time.
        await manage({ action: 'surprise', encounterId: enc, participantIds: ['orc'], surprised: false });
        expect(tok(enc, 'orc').surprised).toBe(false);
    });

    it('is refused for the current actor, for one whose turn has passed, and in round 2+', async () => {
        const created = await manage({ action: 'create', seed: 'set-surprised-late', participants: [hero(), gob(), orc] });
        const enc = created.d.encounterId as string;
        const current = await manage({ action: 'set_surprised', encounterId: enc, participantIds: ['hero'] });
        expect(current.d).toMatchObject({ error: true, writes: 'none' });
        expect(current.d.message).toMatch(/Hero's turn has started/);
        await manage({ action: 'advance', encounterId: enc }); // goblin
        const passed = await manage({ action: 'set_surprised', encounterId: enc, participantIds: ['orc', 'hero'] });
        expect(passed.d).toMatchObject({ error: true, writes: 'none' });
        expect(tok(enc, 'orc').surprised).toBeFalsy();
        await manage({ action: 'advance', encounterId: enc }); // orc
        await manage({ action: 'advance', encounterId: enc }); // hero, round 2
        const late = await manage({ action: 'set_surprised', encounterId: enc, participantIds: ['orc'] });
        expect(late.d).toMatchObject({ error: true, writes: 'none' });
        expect(late.d.message).toMatch(/Round 2: surprise is a round-1 state/);
        const unknown = await manage({ action: 'set_surprised', encounterId: enc, participantIds: ['nobody'] });
        expect(unknown.d).toMatchObject({ error: true, writes: 'none' });
    });
});
