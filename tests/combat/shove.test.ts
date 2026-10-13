import { CombatEngine } from '../../src/engine/combat/engine.js';
import { forcedMove } from '../../src/engine/combat/forced-move.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 5, item 2: `grapple {move: 'shove'}`. A shove pushes the target
 * 5 ft (10 as a documented house extension) directly away or knocks it
 * prone, never both. The contest is the other moves' Athletics contest, or
 * a STR save instead when `save` is given (DC 8 + proficiency + STR by
 * default). `bonusAction: true` spends the bonus action, on the actor's own
 * turn only. Forced movement writes the position only: no opportunity
 * attacks, no readied triggers, no movement spent, and it stops at the first
 * blocked square and says why.
 */
const ctx = { sessionId: 'shove' };
const embedded = (res: any, tag: string) => {
    const m = res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : { rawText: res.content[0].text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');

/** Queue the next engine d20s (actor first, then defender; a save rolls one). */
const dice = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

type P = { id: string; name: string; position?: { x: number; y: number }; size?: string; conditions?: any[] };
const tokenOf = (p: P) => ({ hp: 10, maxHp: 10, conditions: [], ...p }) as any;
const state = (participants: P[], extra: Record<string, unknown> = {}) => ({ participants: participants.map(tokenOf), ...extra }) as any;

describe('forcedMove (pure)', () => {
    it('pushes one square per 5 ft directly away, orthogonally and diagonally, writing position only', () => {
        const s = state([{ id: 'a', name: 'A', position: { x: 2, y: 2 } }, { id: 'b', name: 'B', position: { x: 3, y: 2 } }]);
        const r = forcedMove(s, s.participants[1], s.participants[0], 10);
        expect(r).toMatchObject({ from: { x: 3, y: 2 }, to: { x: 5, y: 2 }, feet: 10, requested: 10, squares: 2 });
        expect(r.stoppedBy).toBeUndefined();
        expect(s.participants[1].position).toEqual({ x: 5, y: 2 });
        expect(s.participants[1].movementRemaining).toBeUndefined();

        const d = state([{ id: 'a', name: 'A', position: { x: 2, y: 2 } }, { id: 'b', name: 'B', position: { x: 1, y: 3 } }]);
        const rd = forcedMove(d, d.participants[1], d.participants[0], 5);
        expect(rd.to).toEqual({ x: 0, y: 4 });
    });

    it('stops at the first blocked step: a terrain obstacle, another creature, or the edge of the grid', () => {
        const wall = state([{ id: 'a', name: 'A', position: { x: 2, y: 2 } }, { id: 'b', name: 'B', position: { x: 3, y: 2 } }], { terrain: { obstacles: ['5,2'] } });
        const r1 = forcedMove(wall, wall.participants[1], wall.participants[0], 10);
        expect(r1).toMatchObject({ to: { x: 4, y: 2 }, feet: 5, requested: 10 });
        expect(r1.stoppedBy).toMatch(/obstacle at \(5, 2\)/);

        const crowd = state([
            { id: 'a', name: 'A', position: { x: 2, y: 2 } }, { id: 'b', name: 'B', position: { x: 3, y: 2 } },
            { id: 'c', name: 'Cultist', position: { x: 4, y: 2 } }
        ]);
        const r2 = forcedMove(crowd, crowd.participants[1], crowd.participants[0], 5);
        expect(r2).toMatchObject({ to: { x: 3, y: 2 }, feet: 0 });
        expect(r2.stoppedBy).toMatch(/Cultist/);
        expect(crowd.participants[1].position).toEqual({ x: 3, y: 2 });

        const edge = state([{ id: 'a', name: 'A', position: { x: 1, y: 2 } }, { id: 'b', name: 'B', position: { x: 0, y: 2 } }], { gridBounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } });
        const r3 = forcedMove(edge, edge.participants[1], edge.participants[0], 5);
        expect(r3.feet).toBe(0);
        expect(r3.stoppedBy).toMatch(/edge of the grid/);
    });

    it('a large target has its whole footprint checked, and overlapping footprints have no direction', () => {
        // The ogre fills (3,2)-(4,3); the pillar at (5,3) is in the second row of its next footprint.
        const s = state([{ id: 'a', name: 'A', position: { x: 2, y: 2 } }, { id: 'o', name: 'Ogre', size: 'large', position: { x: 3, y: 2 } }], { terrain: { obstacles: ['5,3'] } });
        const r = forcedMove(s, s.participants[1], s.participants[0], 10);
        expect(r.feet).toBe(0);
        expect(r.stoppedBy).toMatch(/obstacle at \(5, 3\)/);

        const same = state([{ id: 'a', name: 'A', position: { x: 2, y: 2 } }, { id: 'b', name: 'B', position: { x: 2, y: 2 } }]);
        const r2 = forcedMove(same, same.participants[1], same.participants[0], 5);
        expect(r2.feet).toBe(0);
        expect(r2.stoppedBy).toMatch(/no direction/);
    });
});

describe('grapple shove', () => {
    let encounterId: string;
    const tokens = () => new EncounterRepository(getDb()).loadState(encounterId)!.participants as any[];
    const tok = (id: string) => tokens().find(t => t.id === id);
    const rollPurposes = () => {
        try { return (getDb().prepare('SELECT purpose FROM roll_log').all() as Array<{ purpose: string }>).map(r => r.purpose); } catch { return [] as string[]; }
    };

    const marine = { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, position: { x: 2, y: 2 }, abilityScores: { strength: 16, dexterity: 12, constitution: 14, intelligence: 10, wisdom: 10, charisma: 10 } };
    const cultist = { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true, position: { x: 3, y: 2 }, attackBonus: 4, attackDamage: '1d6' };
    const fight = async (participants: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => {
        const created = await manage({ action: 'create', seed: 'shove', participants, ...extra });
        encounterId = created.encounterId;
    };

    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('a won contest pushes the target 5 ft directly away, spends one attack and provokes nothing', async () => {
        await fight([marine, cultist]);
        dice(18, 4);
        const res = await act({ action: 'grapple', move: 'shove', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(res.hit).toBe(true);
        expect(res.move).toBe('shove');
        expect(res.pushed).toMatchObject({ feet: 5, from: { x: 3, y: 2 }, to: { x: 4, y: 2 } });
        expect(res.forcedMovement).toMatchObject({ opportunityAttacks: expect.stringMatching(/none/) });
        expect(tok('cultist').position).toEqual({ x: 4, y: 2 });
        expect(tok('cultist').conditions).toEqual([]);
        expect(tok('marine').actionUsed).toBe(true);
        expect(tok('marine').attacksMade).toBe(1);
        // Forced movement never provokes: the cultist's reaction is untouched and no opportunity die was rolled.
        expect(tok('cultist').reactionUsed).toBeFalsy();
        expect(rollPurposes().some(p => /opportunity/i.test(p))).toBe(false);
        expect(String(res.message)).toMatch(/5 ft/);
    });

    it('push: 10 moves two squares and is labelled a house extension; a lost contest moves nothing and still spends the attack', async () => {
        await fight([marine, cultist]);
        dice(18, 4);
        const res = await act({ action: 'grapple', move: 'shove', push: 10, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.pushed).toMatchObject({ feet: 10, to: { x: 5, y: 2 } });
        expect(JSON.stringify(res)).toMatch(/house/i);
        expect(tok('cultist').position).toEqual({ x: 5, y: 2 });

        clearCombatState(); closeDb(); getDb(':memory:'); clearCombatState();
        await fight([marine, cultist]);
        dice(2, 18);
        const lost = await act({ action: 'grapple', move: 'shove', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(lost.hit).toBe(false);
        expect(lost.pushed).toBeUndefined();
        expect(tok('cultist').position).toEqual({ x: 3, y: 2 });
        expect(tok('marine').actionUsed).toBe(true);
    });

    it('a push stops at another token and says who was in the way', async () => {
        await fight([marine, cultist, { id: 'thug', name: 'Thug', hp: 10, maxHp: 10, initiative: 3, isEnemy: true, position: { x: 5, y: 2 } }]);
        dice(18, 4);
        const res = await act({ action: 'grapple', move: 'shove', push: 10, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.pushed).toMatchObject({ feet: 5, requested: 10, to: { x: 4, y: 2 } });
        expect(res.pushed.stoppedBy).toMatch(/Thug/);
        expect(tok('cultist').position).toEqual({ x: 4, y: 2 });
    });

    it('prone: true knocks the target prone on the token and the sheet and does not move it; push + prone is refused with nothing spent', async () => {
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        repo.create({ id: 'cultist', name: 'Cultist', characterType: 'npc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 12, level: 1, createdAt: now, updatedAt: now } as any);
        await fight([marine, cultist]);
        const both = await act({ action: 'grapple', move: 'shove', push: 5, prone: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(both.error).toBe(true);
        expect(both.writes).toBe('none');
        expect(String(both.message)).toMatch(/push or prone, not both/i);
        expect(tok('marine').actionUsed).toBeFalsy();

        dice(18, 4);
        const res = await act({ action: 'grapple', move: 'shove', prone: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.hit).toBe(true);
        expect(res.conditionsApplied).toEqual(['Prone']);
        expect(res.pushed).toBeUndefined();
        expect(tok('cultist').position).toEqual({ x: 3, y: 2 });
        expect(tok('cultist').conditions.map((c: any) => c.type)).toEqual(['prone']);
        expect(tok('cultist').conditions[0].sourceId).toBe('grapple: marine');
        expect(repo.findById('cultist')!.conditions).toEqual([expect.objectContaining({ name: 'Prone', source: 'grapple: marine' })]);
    });

    it('save: {ability: str} rolls a STR save instead of the contest, at 8 + proficiency + STR by default', async () => {
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        repo.create({ id: 'marine', name: 'Marine', characterType: 'pc', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 60, maxHp: 60, ac: 16, level: 1, createdAt: now, updatedAt: now } as any);
        await fight([{ ...marine, attacksPerAction: 2 }, cultist]);
        const spy = dice(3);
        const res = await act({ action: 'grapple', move: 'shove', save: { ability: 'str' }, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(res.save).toMatchObject({ ability: 'strength', dc: 13, dcSource: expect.stringMatching(/sheet/), natural: 3, saved: false });
        expect(res.rolls).toBeUndefined();
        expect(res.hit).toBe(true);
        expect(res.pushed).toMatchObject({ feet: 5 });
        // One d20 only (the target's save), tagged as such.
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ purpose: expect.stringMatching(/shove save/), forId: 'cultist' }));
        expect(String(res.breakdown)).toMatch(/DC 13/);

        // A passed save: no push, the attack still spent. An explicit dc wins.
        dice(19);
        const held = await act({ action: 'grapple', move: 'shove', save: { ability: 'str', dc: 15 }, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(held.hit).toBe(false);
        expect(held.save).toMatchObject({ dc: 15, dcSource: 'given', saved: true });
        expect(held.pushed).toBeUndefined();
        expect(tok('marine').attacksMade).toBe(2);
    });

    it('a sheetless token sets the default DC from its CR and ability scores', async () => {
        await fight([{ ...marine, cr: 5 }, cultist]);
        // combat_manage create does not carry abilityScores onto a token; a bestiary spawn does. Set them on the live token.
        const live = getOrLoadEngine(ctx as any, encounterId)!.getState()!.participants.find(p => p.id === 'marine')!;
        live.abilityScores = { strength: 16, dexterity: 12, constitution: 14, intelligence: 10, wisdom: 10, charisma: 10 };
        dice(3);
        const res = await act({ action: 'grapple', move: 'shove', save: { ability: 'str' }, encounterId, actorId: 'marine', targetId: 'cultist' });
        // CR 5 → proficiency 3; STR 16 → +3; 8 + 3 + 3 = 14.
        expect(res.save).toMatchObject({ dc: 14, dcSource: expect.stringMatching(/token/) });
    });

    it('bonusAction: true spends the bonus action and leaves the action free; a second one, an off-turn one, or a surge with it are refused with nothing spent', async () => {
        await fight([marine, cultist]);
        dice(18, 4);
        const res = await act({ action: 'grapple', move: 'shove', bonusAction: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(res.actionSpent).toBe('bonus action');
        expect(tok('marine').bonusActionUsed).toBe(true);
        expect(tok('marine').actionUsed).toBeFalsy();
        expect(tok('marine').attacksMade ?? 0).toBe(0);

        const again = await act({ action: 'grapple', move: 'shove', bonusAction: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(again.error).toBe(true);
        expect(again.writes).toBe('none');
        expect(String(again.message)).toMatch(/Bonus Action already used/i);
        expect(tok('cultist').position).toEqual({ x: 4, y: 2 });

        // The cultist is not up: its bonus action waits for its turn.
        const offTurn = await act({ action: 'grapple', move: 'shove', bonusAction: true, encounterId, actorId: 'cultist', targetId: 'marine' });
        expect(offTurn.error).toBe(true);
        expect(offTurn.writes).toBe('none');
        expect(String(offTurn.message)).toMatch(/own turn/i);
        expect(tok('cultist').bonusActionUsed).toBeFalsy();

        const surge = await act({ action: 'grapple', move: 'takedown', bonusAction: true, actionSurge: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(surge.error).toBe(true);
        expect(surge.writes).toBe('none');
        expect(String(surge.message)).toMatch(/not both/i);
    });

    it('a helpless target is shoved without a contest; break never takes a bonus action', async () => {
        await fight([marine, { ...cultist, conditions: [{ name: 'Unconscious' }] }]);
        const spy = dice(18, 4);
        const res = await act({ action: 'grapple', move: 'shove', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.hit).toBe(true);
        expect(res.autoWin).toBeDefined();
        expect(spy).not.toHaveBeenCalled();
        expect(res.pushed).toMatchObject({ feet: 5 });

        const brk = await act({ action: 'grapple', move: 'break', bonusAction: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(brk.error).toBe(true);
        expect(brk.writes).toBe('none');
    });

    it('push and prone on a move other than shove are refused before anything is spent', async () => {
        await fight([marine, cultist]);
        const res = await act({ action: 'grapple', move: 'takedown', push: 5, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBe(true);
        expect(res.writes).toBe('none');
        expect(String(res.message)).toMatch(/shove/);
        expect(tok('marine').actionUsed).toBeFalsy();
    });

    it('without positions or an encounter the push is narrative; prone still writes the sheet', async () => {
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        for (const [id, name] of [['luciel', 'Luciel'], ['foe', 'Foe']]) {
            repo.create({ id, name, stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 50, maxHp: 50, ac: 14, level: 5, createdAt: now, updatedAt: now } as any);
        }
        const res = await act({ action: 'grapple', move: 'shove', outcome: 'win', actorId: 'luciel', targetId: 'foe' });
        expect(res.error).toBeFalsy();
        expect(res.pushed).toMatchObject({ feet: 5, narrative: true });
        expect(res.ignoredParams).toBeUndefined();

        const prone = await act({ action: 'grapple', move: 'shove', prone: true, outcome: 'win', actorId: 'luciel', targetId: 'foe' });
        expect(prone.conditionsApplied).toEqual(['Prone']);
        expect(repo.findById('foe')!.conditions).toEqual([expect.objectContaining({ name: 'Prone', source: 'grapple: luciel' })]);

        // In a fight with unplaced tokens the push is narrative too.
        await fight([{ ...marine, position: undefined }, { ...cultist, position: undefined }]);
        dice(18, 4);
        const unplaced = await act({ action: 'grapple', move: 'shove', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(unplaced.pushed).toMatchObject({ feet: 5, narrative: true });
    });

    it('a hold the actor had on the target stays, with a note', async () => {
        await fight([marine, { ...cultist, conditions: [{ name: 'Grappled', source: 'grapple: marine' }] }]);
        dice(18, 4);
        const res = await act({ action: 'grapple', move: 'shove', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.pushed).toMatchObject({ feet: 5 });
        expect(tok('cultist').conditions.map((c: any) => c.type)).toEqual(['grappled']);
        expect(String(res.holdNote ?? '')).toMatch(/hold/i);
    });

    it('push, prone, save and bonusAction are grapple keys: none comes back in ignoredParams', async () => {
        await fight([marine, cultist]);
        dice(3);
        const res = await act({ action: 'grapple', move: 'shove', push: 5, save: { ability: 'str' }, bonusAction: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(res.ignoredParams).toBeUndefined();
    });
});
