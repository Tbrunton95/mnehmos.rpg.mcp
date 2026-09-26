import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Item 11: opportunity attacks along the whole path (reach, footprint and
 * conditions), refused moves that provoke nothing, PC reactors offered the
 * swing instead of rolled for, and readied actions that fire themselves.
 */

const ctx = { sessionId: 'reactions' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manage = async (args: Record<string, unknown>) => (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, d, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const live = (id: string) => getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === id)! as any;

// A corridor along y=0: the goblin at (2,1) sits beside it, so a walk from
// (0,0) to (4,0) enters its reach at (1,0) and leaves it after (3,0).
const WALLS = ['1,-1', '2,-1', '3,-1', '1,1', '3,1'];

async function setup(participants: any[], opts: { pc?: string[]; terrain?: boolean } = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    for (const id of opts.pc ?? []) {
        new CharacterRepository(db).create({ id, name: id, stats: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }, hp: 30, maxHp: 30, ac: 12, level: 3, createdAt: now, updatedAt: now } as any);
    }
    enc = tag((await handleCombatManage({
        action: 'create', seed: 'reactions', participants,
        ...(opts.terrain ? { terrain: { obstacles: WALLS } } : {})
    }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
}

const hero = (extra: Record<string, unknown> = {}) => ({ id: 'hero', name: 'Hero', hp: 30, maxHp: 30, ac: 12, initiative: 20, position: { x: 0, y: 0 }, ...extra });
const gob = (extra: Record<string, unknown> = {}) => ({ id: 'gob', name: 'Goblin', hp: 30, maxHp: 30, ac: 12, initiative: 10, isEnemy: true, attackBonus: 40, attackDamage: '1d1+2', position: { x: 2, y: 1 }, ...extra });

afterEach(() => closeDb());

describe('engine: opportunity attackers along a path', () => {
    const fight = (gobExtra: Record<string, unknown> = {}) => {
        const e = new CombatEngine('oa-path');
        e.startEncounter([
            { id: 'hero', name: 'Hero', initiativeBonus: 0, hp: 30, maxHp: 30, conditions: [], position: { x: 0, y: 0 } },
            { id: 'gob', name: 'Goblin', initiativeBonus: 0, hp: 30, maxHp: 30, conditions: [], isEnemy: true, position: { x: 2, y: 1 } }
        ] as any);
        // startEncounter resets turn resources; the state under test goes on after.
        Object.assign(e.getState()!.participants.find(p => p.id === 'gob')!, gobExtra);
        return e;
    };
    const path = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }];

    it('a path that skirts an enemy provokes where it leaves reach; the endpoints alone do not', () => {
        const hits = fight().getOpportunityAttackers('hero', path);
        expect(hits.map(h => [h.attacker.id, h.stepIndex])).toEqual([['gob', 3]]);
        expect(fight().getOpportunityAttackers('hero', { x: 0, y: 0 }, { x: 4, y: 0 })).toEqual([]);
    });

    it('a reactor who cannot take reactions makes no opportunity attack', () => {
        const stunned = fight({ conditions: [{ id: 's', type: 'stunned', durationType: 'permanent' }] });
        expect(stunned.getOpportunityAttackers('hero', path)).toEqual([]);
        expect(fight({ reactionUsed: true }).getOpportunityAttackers('hero', path)).toEqual([]);
    });
});

describe('engine: opportunity attacks roll like attacks', () => {
    const duel = (seed: string, heroExtra: Record<string, unknown> = {}, gobExtra: Record<string, unknown> = {}) => {
        const e = new CombatEngine(seed);
        e.startEncounter([
            { id: 'gob', name: 'Goblin', initiativeBonus: 0, hp: 30, maxHp: 30, conditions: [], isEnemy: true, attackBonus: 40, attackDamage: '1d1+2', position: { x: 0, y: 0 }, ...gobExtra },
            { id: 'hero', name: 'Hero', initiativeBonus: 0, hp: 60, maxHp: 60, ac: 12, conditions: [], position: { x: 1, y: 0 }, ...heroExtra }
        ] as any);
        return e;
    };

    it('a prone mover within 5 ft is attacked with advantage', () => {
        const r = duel('oa-prone', { conditions: [{ id: 'p', type: 'prone', durationType: 'permanent' }] }).executeOpportunityAttack('gob', 'hero');
        expect(r.attackRoll?.allRolls).toHaveLength(2);
        expect(r.situational?.join(' ')).toMatch(/prone/i);
        expect(r.detailedBreakdown).toMatch(/OPPORTUNITY ATTACK by Goblin/);
    });

    it('a dodging mover is attacked with disadvantage', () => {
        const r = duel('oa-dodge', { isDodging: true }).executeOpportunityAttack('gob', 'hero');
        expect(r.attackRoll?.allRolls).toHaveLength(2);
        expect(r.situational?.join(' ')).toMatch(/dodging/);
    });

    it('a paralysed mover takes a crit from any hit within 5 ft', () => {
        for (let i = 0; i < 10; i++) {
            const r = duel(`oa-para-${i}`, { conditions: [{ id: 'x', type: 'paralyzed', durationType: 'permanent' }] }).executeOpportunityAttack('gob', 'hero');
            if (r.success) expect(r.attackRoll?.isCrit).toBe(true);
        }
    });

    it('one blow kills at most one model of a unit', () => {
        for (let i = 0; i < 5; i++) {
            const r = duel(`oa-unit-${i}`, { hp: 50, maxHp: 50, unit: { models: 5, hpPerModel: 10, packed: false, attackBonus: 0 } }, { attackDamage: '1d1+30' }).executeOpportunityAttack('gob', 'hero');
            if (r.success) expect(r.damage).toBe(10);
        }
    });
});

describe('move: opportunity attacks after the move is validated', () => {
    it('a corridor walk past a goblin provokes at the step it leaves reach, reported as data', async () => {
        await setup([hero(), gob()], { terrain: true });
        const { r } = await act({ action: 'move', actorId: 'hero', targetPosition: { x: 4, y: 0 } });
        expect(r.opportunityAttacks).toHaveLength(1);
        expect(r.opportunityAttacks[0]).toMatchObject({ attackerId: 'gob', stepIndex: 3, at: { x: 3, y: 0 } });
        expect(typeof r.opportunityAttacks[0].hit).toBe('boolean');
        expect(r.opportunityAttacks[0].targetHpAfter).toBe(tok('hero').hp);
        expect(tok('gob').reactionUsed).toBe(true);
        expect(tok('hero').position).toEqual({ x: 4, y: 0 });
    });

    it('a refused move (not enough movement) spends no reaction and deals no damage', async () => {
        await setup([hero({ position: { x: 1, y: 0 } }), gob({ position: { x: 0, y: 0 } })]);
        const { text, r } = await act({ action: 'move', actorId: 'hero', targetPosition: { x: 20, y: 0 } });
        expect(text).toMatch(/Insufficient movement/);
        expect(r.opportunityAttacks ?? []).toEqual([]);
        expect(tok('gob').reactionUsed).toBeFalsy();
        expect(tok('hero').hp).toBe(30);
        expect(tok('hero').position).toEqual({ x: 1, y: 0 });
    });

    it('a stunned goblin makes no opportunity attack', async () => {
        await setup([hero({ position: { x: 1, y: 0 } }), gob({ position: { x: 0, y: 0 } })]);
        await manage({ action: 'add_condition', participantId: 'gob', condition: 'stunned' });
        const { text, r } = await act({ action: 'move', actorId: 'hero', targetPosition: { x: 4, y: 0 } });
        expect(text).not.toMatch(/opportunity attack/i);
        expect(r.opportunityAttacks).toEqual([]);
    });

    it('a mover dropped by the attack stops at the step where it fell', async () => {
        await setup([hero({ hp: 1 }), gob({ attackDamage: '1d1+10' })], { terrain: true });
        const { text, r } = await act({ action: 'move', actorId: 'hero', targetPosition: { x: 4, y: 0 } });
        // +40 only misses on a natural 1; this seed hits.
        expect(r.opportunityAttacks[0].hit).toBe(true);
        expect(text).toMatch(/cannot complete the movement/);
        expect(tok('hero').hp).toBe(0);
        expect(tok('hero').position).toEqual({ x: 3, y: 0 });
        expect(tok('hero').movementRemaining).toBe(15);
    });

    it('a PC reactor is offered the swing with the exact call, never rolled for', async () => {
        await setup([
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, ac: 12, initiative: 20, position: { x: 0, y: 0 }, attackBonus: 40, attackDamage: '1d1+2' },
            { id: 'gob', name: 'Goblin', hp: 30, maxHp: 30, ac: 12, initiative: 10, isEnemy: true, position: { x: 1, y: 0 } }
        ], { pc: ['hero'] });
        const { text, r } = await act({ action: 'move', actorId: 'gob', targetPosition: { x: 5, y: 0 } });
        expect(r.opportunityAttacks).toEqual([]);
        expect(r.opportunityAttacksAvailable).toHaveLength(1);
        expect(r.opportunityAttacksAvailable[0]).toMatchObject({
            attackerId: 'hero', stepIndex: 0,
            call: { tool: 'combat_action', action: 'attack', encounterId: enc, actorId: 'hero', targetId: 'gob', reaction: true }
        });
        expect(text).toMatch(/OPPORTUNITY ATTACK AVAILABLE/);
        expect(tok('hero').reactionUsed).toBeFalsy();
        expect(tok('gob').hp).toBe(30);
        // The offered call works: the reaction is spent, not the action.
        const { r: swing } = await act(r.opportunityAttacksAvailable[0].call);
        expect(swing.reaction).toBe(true);
        expect(tok('hero').reactionUsed).toBe(true);
        expect(tok('hero').actionUsed).toBeFalsy();
    });
});

describe('combat_action ready is real', () => {
    it('writes the readied action with its trigger and attack, and spends the action', async () => {
        await setup([hero(), gob({ position: { x: 5, y: 0 } })]);
        const { d } = await act({ action: 'ready', actorId: 'hero', readiedAction: 'swing the axe', trigger: 'the goblin closes', on: 'enters_reach', watch: 'gob', attack: { attackBonus: 40, damage: '1d1+2' } });
        expect(d.success).toBe(true);
        expect(d.readiedAction).toBe('swing the axe');
        expect(d.warning).toBeUndefined();
        expect(tok('hero').readied).toEqual({ action: 'swing the axe', trigger: 'the goblin closes', on: 'enters_reach', watch: 'gob', attack: { attackBonus: 40, damage: '1d1+2' } });
        expect(tok('hero').actionUsed).toBe(true);
    });

    it('warns instead of refusing when the action is already spent', async () => {
        await setup([hero(), gob({ position: { x: 5, y: 0 } })]);
        await act({ action: 'ready', actorId: 'hero', readiedAction: 'first', trigger: 'x' });
        const { d } = await act({ action: 'ready', actorId: 'hero', readiedAction: 'second', trigger: 'y' });
        expect(d.success).toBe(true);
        expect(d.warning).toMatch(/Action already used/);
        expect(tok('hero').readied.action).toBe('second');
    });
});

describe('readied actions fire on movement', () => {
    it('a readied attack fires itself when its watched enemy enters reach, even for a PC', async () => {
        await setup([hero(), gob({ position: { x: 4, y: 0 } })], { pc: ['hero'] });
        await manage({ action: 'set_intent', participantId: 'hero', readied: { action: 'axe the goblin', trigger: 'it comes close', on: 'enters_reach', watch: 'gob', attack: { attackBonus: 40, damage: '1d1+2' } } });
        const { text, r } = await act({ action: 'move', actorId: 'gob', targetPosition: { x: 1, y: 0 } });
        expect(r.readiedTriggered).toHaveLength(1);
        expect(r.readiedTriggered[0]).toMatchObject({ participantId: 'hero', fired: true, stepIndex: 3 });
        expect(typeof r.readiedTriggered[0].attack.hit).toBe('boolean');
        expect(text).toMatch(/READIED/);
        expect(tok('hero').reactionUsed).toBe(true);
        expect(tok('hero').readied).toBeUndefined();
        expect(tok('gob').hp).toBe(30 - r.readiedTriggered[0].attack.damage);
    });

    it('a readied action without an attack is only flagged for trigger_readied', async () => {
        await setup([hero(), gob({ position: { x: 4, y: 0 } })]);
        await manage({ action: 'set_intent', participantId: 'hero', readied: { action: 'pull the lever', trigger: 'it comes close', on: 'enters_reach' } });
        const { text, r } = await act({ action: 'move', actorId: 'gob', targetPosition: { x: 1, y: 0 } });
        expect(r.readiedTriggered).toEqual([expect.objectContaining({ participantId: 'hero', fired: false })]);
        expect(text).toMatch(/trigger_readied/);
        expect(tok('hero').reactionUsed).toBeFalsy();
        expect(tok('hero').readied.action).toBe('pull the lever');
    });

    it('free-text readied without on never fires on its own', async () => {
        await setup([hero(), gob({ position: { x: 4, y: 0 } })]);
        await manage({ action: 'set_intent', participantId: 'hero', readied: { action: 'pull the lever', trigger: 'it comes close' } });
        const { r } = await act({ action: 'move', actorId: 'gob', targetPosition: { x: 1, y: 0 } });
        expect(r.readiedTriggered).toEqual([]);
    });
});

describe('trigger_readied spends the reaction and resolves the stored attack', () => {
    const readyAxe = () => manage({ action: 'set_intent', participantId: 'hero', readied: { action: 'axe the goblin', trigger: 'it moves', attack: { attackBonus: 40, damage: '1d1+2' } } });

    it('refuses when the reaction is spent or the reactor is incapacitated, writing nothing', async () => {
        await setup([hero(), gob({ position: { x: 1, y: 0 } })]);
        await readyAxe();
        live('hero').reactionUsed = true;
        expect(await manage({ action: 'trigger_readied', participantId: 'hero', targetId: 'gob' })).toMatch(/reaction/i);
        live('hero').reactionUsed = false;
        await manage({ action: 'add_condition', participantId: 'hero', condition: 'stunned' });
        expect(await manage({ action: 'trigger_readied', participantId: 'hero', targetId: 'gob' })).toMatch(/cannot take reactions/);
        expect(tok('hero').readied.action).toBe('axe the goblin');
        expect(tok('gob').hp).toBe(30);
    });

    it('rolls the stored attack in the same call', async () => {
        await setup([hero(), gob({ position: { x: 1, y: 0 } })]);
        await readyAxe();
        const text = await manage({ action: 'trigger_readied', participantId: 'hero', targetId: 'gob' });
        const d = tag(text, 'COMBAT_MANAGE');
        expect(d.success).toBe(true);
        expect(typeof d.attack.hit).toBe('boolean');
        expect(tok('hero').reactionUsed).toBe(true);
        expect(tok('hero').readied).toBeUndefined();
        expect(tok('gob').hp).toBe(30 - d.attack.damage);
    });

    it('a readied action with no attack spends the reaction and clears', async () => {
        await setup([hero(), gob({ position: { x: 1, y: 0 } })]);
        await manage({ action: 'set_intent', participantId: 'hero', readied: { action: 'pull the lever', trigger: 'it moves' } });
        const text = await manage({ action: 'trigger_readied', participantId: 'hero' });
        expect(text).toMatch(/pull the lever fires/);
        expect(tok('hero').reactionUsed).toBe(true);
        expect(tok('hero').readied).toBeUndefined();
    });
});
