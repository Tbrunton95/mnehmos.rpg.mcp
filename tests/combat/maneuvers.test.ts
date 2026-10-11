/**
 * Play report 2, item 16: Battle Master manoeuvres on the superiority pool.
 * trip / menacing / disarming add the superiority die to a hit's damage and
 * make the target save (STR / WIS / STR) at 8 + proficiency + STR or DEX;
 * precision adds the die to a swing that missed by no more than the die can
 * make up; riposte is a reaction against a creature that missed you in
 * melee this round. The die is spent only when it was rolled; every
 * refusal happens before anything is rolled or written.
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { cryptoInt } from '../../src/math/crypto-dice.js';
import { maneuverProblem, maneuverSaveDC, maneuverAbilityMod, menacingUntil, dieMax, findSuperiorityPool } from '../../src/engine/combat/maneuvers.js';

vi.mock('../../src/math/crypto-dice.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/math/crypto-dice.js')>();
    return { ...actual, cryptoInt: vi.fn(actual.cryptoInt) };
});

const ctx = { sessionId: 'unscoped' };
const manage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const action = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const loose = (text: string) => { try { return JSON.parse(text); } catch { return null; } };
let enc: string;
const act = async (args: Record<string, unknown>) => {
    const text = (await action({ action: 'attack', encounterId: enc, ...args })).content[0].text;
    const d = tag(text, 'COMBAT_ACTION') ?? loose(text);
    return { text, d, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
const pool = () => sheet('brannoc').resourcePools.superiority;
const rolls = () => queryRolls(getDb(), { encounterId: enc, limit: 50 }) as any[];
const pin = (...values: number[]) => { const q = [...values]; vi.mocked(cryptoInt).mockImplementation((sides: number) => q.shift() ?? sides); };
const advance = async (n = 1) => { for (let i = 0; i < n; i++) await manage({ action: 'advance', encounterId: enc }); };

type Sheet = Record<string, unknown>;
const FIGHTER: Sheet = {
    superiorityDie: '1d8',
    resourcePools: { superiority: { current: 4, max: 4, refresh: 'short' } },
    attacks: [
        { name: 'longsword', attackBonus: 7, damage: '1d8+3', damageType: 'slashing', default: true },
        { name: 'longbow', attackBonus: 5, damage: '1d8+1', damageType: 'piercing', ranged: true }
    ]
};
const ORC: Sheet = {
    parts: [{ name: 'right arm', kind: 'arm', holds: ['scimitar'] }],
    attacks: [{ name: 'scimitar', attackBonus: 5, damage: '1d6+3', item: 'scimitar', default: true }]
};

async function setup(fighter: Sheet = FIGHTER, foe: Sheet = ORC, foeToken: Record<string, unknown> = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    const repo = new CharacterRepository(db);
    repo.create({ id: 'brannoc', name: 'Brannoc', characterType: 'pc', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 }, hp: 44, maxHp: 44, ac: 18, level: 5,
        createdAt: now, updatedAt: now, ...fighter } as any);
    repo.create({ id: 'orc', name: 'Orc', characterType: 'npc', stats: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 }, hp: 30, maxHp: 30, ac: 13, level: 2,
        createdAt: now, updatedAt: now, ...foe } as any);
    enc = tag((await manage({ action: 'create', participants: [
        { id: 'brannoc', name: 'Brannoc', hp: 44, maxHp: 44, initiative: 20, position: { x: 0, y: 0 } },
        { id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 10, isEnemy: true, position: { x: 1, y: 0 }, ...foeToken },
        { id: 'thug', name: 'Thug', hp: 20, maxHp: 20, ac: 12, initiative: 5, isEnemy: true, attackBonus: 4, attackDamage: '1d6+2', position: { x: 0, y: 1 } }
    ] })).content[0].text, 'COMBAT_MANAGE').encounterId;
}

afterEach(() => { vi.mocked(cryptoInt).mockReset(); closeDb(); clearCombatState(); });

describe('maneuvers (pure)', () => {
    it('save DC, ability modifier, die size and pool lookup', () => {
        expect(maneuverSaveDC(3, 3)).toBe(14);
        expect(maneuverAbilityMod({ str: 16, dex: 12 })).toBe(3);
        expect(maneuverAbilityMod({ str: 10, dex: 18 })).toBe(4);
        expect(maneuverAbilityMod({ str: 16, dex: 18 }, 'str')).toBe(3);
        expect(dieMax('1d8')).toBe(8);
        expect(dieMax('1d12')).toBe(12);
        expect(findSuperiorityPool({ superiority_dice: { current: 2, max: 4 } })?.key).toBe('superiority_dice');
        expect(findSuperiorityPool({ Superiority: { current: 2, max: 4 } })?.key).toBe('Superiority');
        expect(findSuperiorityPool({ rage: { current: 2, max: 4 } })).toBeUndefined();
    });

    it('menacingUntil: the end of the attacker\'s next turn is next round on its own turn, this round before it', () => {
        const order = ['a', 'b', 'c'];
        expect(menacingUntil({ round: 3, turnOrder: order, currentTurnIndex: 0 }, 'a')).toBe(4);
        expect(menacingUntil({ round: 3, turnOrder: order, currentTurnIndex: 1 }, 'a')).toBe(4);
        expect(menacingUntil({ round: 3, turnOrder: order, currentTurnIndex: 0 }, 'c')).toBe(3);
    });

    it('maneuverProblem refuses in order: posted outcome, volley/cleave, no sheet, no die, no pool, riposte conditions', () => {
        const ok = { sheet: { superiorityDie: '1d8' }, pool: { current: 2 }, round: 1, actorName: 'A', targetId: 't', targetName: 'T' };
        expect(maneuverProblem('trip', { ...ok, outcome: 'hit' })).toMatch(/outcome/);
        expect(maneuverProblem('trip', { ...ok, volley: true })).toMatch(/volley/);
        expect(maneuverProblem('trip', { ...ok, sheet: null })).toMatch(/character sheet/);
        expect(maneuverProblem('trip', { ...ok, sheet: {} })).toMatch(/superiorityDie/);
        expect(maneuverProblem('trip', { ...ok, pool: undefined })).toMatch(/adjust_pool \{pool: 'superiority'/);
        expect(maneuverProblem('trip', { ...ok, pool: { current: 0 } })).toMatch(/no superiority dice left/);
        expect(maneuverProblem('riposte', { ...ok })).toMatch(/reaction: true/);
        expect(maneuverProblem('riposte', { ...ok, reaction: true, ranged: true })).toMatch(/melee/);
        expect(maneuverProblem('riposte', { ...ok, reaction: true })).toMatch(/has not missed A in melee this round/);
        expect(maneuverProblem('riposte', { ...ok, reaction: true, lastMeleeMisses: [{ attackerId: 't', round: 1 }] })).toBeUndefined();
        expect(maneuverProblem('riposte', { ...ok, reaction: true, lastMeleeMisses: [{ attackerId: 't', round: 0 }] })).toMatch(/this round/);
        expect(maneuverProblem('trip', ok)).toBeUndefined();
    });
});

describe('refusals spend nothing', () => {
    const expectUntouched = (d: any, before: number) => {
        expect(d.error).toBe(true);
        expect(d.writes).toBe('none');
        expect(tok('brannoc').actionUsed).toBeFalsy();
        expect(rolls().filter(x => /attack|damage|superiority/.test(x.purpose))).toHaveLength(before);
    };

    it('a token without a sheet, a posted outcome, a missing die, a missing or empty pool', async () => {
        await setup();
        const before = rolls().length;
        await advance(2); // thug's turn
        const noSheet = await act({ actorId: 'thug', targetId: 'orc', maneuver: 'trip' });
        expect(noSheet.d.message).toMatch(/no character sheet/);
        expect(noSheet.d.writes).toBe('none');
        expect(tok('thug').actionUsed).toBeFalsy();
        await advance(1); // brannoc, round 2
        const posted = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'trip', outcome: 'hit', damage: 5 });
        expect(posted.d.message).toMatch(/outcome/);
        expectUntouched(posted.d, before);
        expect(pool().current).toBe(4);
        expect(tok('orc').hp).toBe(30);

        await setup({ ...FIGHTER, superiorityDie: undefined });
        const noDie = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'trip' });
        expect(noDie.d.message).toMatch(/superiorityDie/);
        expectUntouched(noDie.d, 0);

        await setup({ ...FIGHTER, resourcePools: {} });
        const noPool = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'trip' });
        expect(noPool.d.message).toMatch(/adjust_pool \{pool: 'superiority'/);
        expectUntouched(noPool.d, 0);

        await setup({ ...FIGHTER, resourcePools: { superiority: { current: 0, max: 4, refresh: 'short' } } });
        const empty = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'trip' });
        expect(empty.d.message).toMatch(/no superiority dice left/);
        expectUntouched(empty.d, 0);
        expect(pool().current).toBe(0);
    });

    it('an unknown manoeuvre name is refused by the schema', () => {
        expect(() => CombatActionTool.inputSchema.parse({ action: 'attack', encounterId: 'e', actorId: 'a', targetId: 'b', maneuver: 'kneecap' })).toThrow();
    });
});

describe('trip attack', () => {
    it('on a hit adds the die to the damage, spends it with a reason, and the target saves STR vs 8 + prof + STR; a failed save is prone', async () => {
        await setup();
        pin(15, 4, 6, 5);
        const { r, text } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'trip' });
        expect(r.roll).toMatchObject({ hit: true, bonus: 7, total: 22 });
        expect(r.damage.total).toBe(13);
        expect(tok('orc').hp).toBe(17);
        expect(r.maneuver).toMatchObject({ name: 'trip', die: '1d8', roll: 6, spent: true, addedTo: 'damage', dc: 14, pool: { before: 4, after: 3 },
            save: { ability: 'strength', dc: 14, natural: 5, total: 8, saved: false }, applied: { condition: 'prone' } });
        expect(pool()).toMatchObject({ current: 3, max: 4 });
        expect(pool().history.at(-1)).toMatchObject({ from: 4, to: 3, delta: -1, reason: 'superiority die (trip) vs Orc' });
        const prone = tok('orc').conditions.find((c: any) => c.type === 'prone');
        expect(prone).toMatchObject({ sourceId: 'brannoc' });
        expect(rolls().some(x => x.purpose === 'superiority die (trip)')).toBe(true);
        expect(rolls().some(x => /trip save vs Brannoc/.test(x.purpose))).toBe(true);
        expect(text).toMatch(/RULE maneuver trip/);
        expect(r.situational).toEqual(expect.arrayContaining([expect.stringMatching(/superiority die \(trip\) \+6/)]));
    });

    it('a saved trip spends the die and adds the damage but leaves the target standing', async () => {
        await setup();
        pin(15, 4, 6, 18);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'trip' });
        expect(r.maneuver.save).toMatchObject({ saved: true, total: 21 });
        expect(r.maneuver.applied).toBeUndefined();
        expect(tok('orc').conditions.some((c: any) => c.type === 'prone')).toBe(false);
        expect(pool().current).toBe(3);
    });

    it('a miss spends nothing: no die rolled, no save, pool untouched', async () => {
        await setup();
        pin(3, 4, 6, 6);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'trip' });
        expect(r.roll.hit).toBe(false);
        expect(r.maneuver).toMatchObject({ name: 'trip', spent: false, pool: { before: 4, after: 4 } });
        expect(r.maneuver.save).toBeUndefined();
        expect(pool().current).toBe(4);
        expect(rolls().some(x => /superiority|save/.test(x.purpose))).toBe(false);
    });

    it('a target larger than Large takes the die but cannot be tripped', async () => {
        await setup(FIGHTER, ORC, { size: 'huge' });
        pin(15, 4, 6, 1);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'trip' });
        expect(r.maneuver).toMatchObject({ spent: true, roll: 6 });
        expect(r.maneuver.save).toBeUndefined();
        expect(r.maneuver.applied.note).toMatch(/too large to trip/);
        expect(tok('orc').conditions.some((c: any) => c.type === 'prone')).toBe(false);
        expect(pool().current).toBe(3);
    });

    it('a hit that drops the target rolls no save and lands nothing on the body; the die is still spent', async () => {
        await setup(FIGHTER, { ...ORC, hp: 5 }, { hp: 5 });
        pin(15, 4, 6);
        const { r, text } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'trip' });
        expect(r.roll.hit).toBe(true);
        expect(tok('orc').hp).toBe(0);
        expect(r.maneuver).toMatchObject({ name: 'trip', spent: true, roll: 6, pool: { before: 4, after: 3 } });
        expect(r.maneuver.save).toBeUndefined();
        expect(r.maneuver.applied.note).toMatch(/Orc is down: no save/);
        expect(tok('orc').conditions.some((c: any) => c.type === 'prone')).toBe(false);
        expect(rolls().some(x => /save/.test(x.purpose))).toBe(false);
        expect(pool().current).toBe(3);
        expect(text).toMatch(/RULE maneuver trip: .*Orc is down: no save/);
    });

    it('a crit doubles the superiority die, never rerolled by great weapon fighting', async () => {
        await setup({ ...FIGHTER, fightingStyle: 'great_weapon', attacks: [{ name: 'greatsword', attackBonus: 7, damage: '2d6+4', twoHanded: true, default: true }] });
        // d20; weapon 2d6 then its reroll (the 1 → 3); the crit's 2d6 (no reroll); superiority die ×2; save
        pin(20, 1, 5, 3, 4, 6, 2, 1, 5);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'trip' });
        expect(r.roll.crit).toBe(true);
        expect(r.fightingStyle.rerolls).toEqual([{ sides: 6, from: 1, to: 3 }]);
        expect(r.maneuver).toMatchObject({ roll: 3, rolls: [2, 1], spent: true });
        expect(r.damage).toMatchObject({ total: 3 + 5 + 4 + 6 + 4 + 3, rolls: [3, 5, 4, 6] });
        expect(rolls().find(x => x.purpose === 'superiority die (trip)').dice).toHaveLength(2);
    });
});

describe('precision attack', () => {
    it('adds the die to a swing that missed by no more than the die, turning the miss, and spends it', async () => {
        await setup();
        pin(5, 3, 4);
        const { r, text } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'precision' });
        expect(r.roll).toMatchObject({ die: 5, bonus: 10, total: 15, hit: true, targetAc: 13 });
        expect(r.maneuver).toMatchObject({ name: 'precision', roll: 3, spent: true, addedTo: 'attack', turnedHit: true, before: 12, after: 15, pool: { before: 4, after: 3 } });
        expect(r.damage.total).toBe(7);
        expect(pool().current).toBe(3);
        expect(rolls().some(x => x.purpose === 'superiority die (precision)')).toBe(true);
        expect(text).toMatch(/15 vs AC 13/);
    });

    it('a swing that already hits rolls nothing and spends nothing', async () => {
        await setup();
        pin(15, 4);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'precision' });
        expect(r.roll).toMatchObject({ hit: true, bonus: 7 });
        expect(r.maneuver).toMatchObject({ spent: false, pool: { before: 4, after: 4 } });
        expect(pool().current).toBe(4);
    });

    it('a natural 1 cannot be turned: nothing rolled, nothing spent', async () => {
        await setup();
        pin(1, 4);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'precision' });
        expect(r.roll.hit).toBe(false);
        expect(r.maneuver).toMatchObject({ spent: false });
        expect(pool().current).toBe(4);
        expect(rolls().some(x => /precision/.test(x.purpose))).toBe(false);
    });

    it('a miss by more than the die can make up is not worth a die', async () => {
        await setup(FIGHTER, { ...ORC, ac: 25 });
        pin(5, 4);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'precision' });
        expect(r.roll).toMatchObject({ hit: false, total: 12, targetAc: 25 });
        expect(r.maneuver).toMatchObject({ spent: false, note: expect.stringMatching(/missed by 13/) });
        expect(pool().current).toBe(4);
    });

    it('a die that still misses is spent (it was rolled)', async () => {
        await setup(FIGHTER, { ...ORC, ac: 15 });
        pin(5, 1, 4);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'precision' });
        expect(r.roll).toMatchObject({ hit: false, bonus: 8, total: 13, targetAc: 15 });
        expect(r.maneuver).toMatchObject({ roll: 1, spent: true, turnedHit: false, before: 12, after: 13, pool: { before: 4, after: 3 } });
        expect(pool().current).toBe(3);
        expect(r.situational).toEqual(expect.arrayContaining([expect.stringMatching(/still a miss/)]));
    });
});

describe('riposte', () => {
    it('needs reaction: true, melee, and a melee miss by the target this round; then spends the reaction and adds the die', async () => {
        await setup();
        const noReaction = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'riposte' });
        expect(noReaction.d).toMatchObject({ error: true, writes: 'none' });
        expect(noReaction.d.message).toMatch(/reaction: true/);
        const noMiss = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'riposte', reaction: true });
        expect(noMiss.d).toMatchObject({ error: true, writes: 'none' });
        expect(noMiss.d.message).toMatch(/Orc has not missed Brannoc in melee this round/);
        expect(tok('brannoc').reactionUsed).toBeFalsy();

        await advance(1); // orc's turn
        pin(2, 4);
        const swing = await act({ actorId: 'orc', targetId: 'brannoc' });
        expect(swing.r.roll.hit).toBe(false);
        expect(tok('brannoc').lastMeleeMisses).toEqual([{ attackerId: 'orc', round: 1 }]);

        const ranged = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'riposte', reaction: true, using: 'longbow' });
        expect(ranged.d).toMatchObject({ error: true, writes: 'none' });
        expect(ranged.d.message).toMatch(/melee/);

        pin(15, 4, 6);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'riposte', reaction: true });
        expect(r.roll.hit).toBe(true);
        expect(r.reaction).toBe(true);
        expect(r.maneuver).toMatchObject({ name: 'riposte', roll: 6, spent: true, addedTo: 'damage' });
        expect(r.damage.total).toBe(13);
        expect(tok('brannoc').reactionUsed).toBe(true);
        expect(pool().current).toBe(3);

        const again = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'riposte', reaction: true });
        expect(again.d.error).toBe(true);
        expect(pool().current).toBe(3);
    });

    it('the recorded miss does not carry into the next round', async () => {
        await setup();
        await advance(1);
        pin(2, 4);
        await act({ actorId: 'orc', targetId: 'brannoc' });
        await advance(2); // thug, then brannoc round 2
        const stale = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'riposte', reaction: true });
        expect(stale.d).toMatchObject({ error: true, writes: 'none' });
    });
});

describe('menacing attack', () => {
    it('a failed WIS save frightens the target of the attacker until the end of the attacker\'s next turn', async () => {
        await setup();
        pin(15, 4, 6, 3);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'menacing' });
        expect(r.maneuver).toMatchObject({ name: 'menacing', spent: true, dc: 14, save: { ability: 'wisdom', natural: 3, total: 3, saved: false }, applied: { condition: 'frightened', untilEndOfTurnOf: 'brannoc', afterRound: 2 } });
        let fear = tok('orc').conditions.find((c: any) => c.type === 'frightened');
        expect(fear).toMatchObject({ sourceId: 'brannoc', metadata: { endsAtEndOfTurnOf: 'brannoc', afterRound: 2 } });

        await advance(1); // orc, round 1: frightened, attacks at disadvantage
        pin(10, 10, 4);
        const swing = await act({ actorId: 'orc', targetId: 'brannoc' });
        expect(swing.r.roll.allRolls).toHaveLength(2);
        expect(swing.r.situational).toEqual(expect.arrayContaining([expect.stringMatching(/Orc frightened \(disadvantage\)/)]));

        await advance(2); // thug, then brannoc round 2: still there at the start of the attacker's next turn
        expect(tok('orc').conditions.some((c: any) => c.type === 'frightened')).toBe(true);
        const ended = (await manage({ action: 'advance', encounterId: enc })).content[0].text; // end of brannoc's turn in round 2
        expect(tok('orc').conditions.some((c: any) => c.type === 'frightened')).toBe(false);
        expect(ended).toMatch(/Orc is no longer frightened of Brannoc/);
        fear = undefined;
    });

    it('a second menacing hit replaces the first fear instead of stacking it', async () => {
        await setup({ ...FIGHTER, attacksPerAction: 2 });
        pin(15, 4, 6, 3);
        await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'menacing' });
        pin(15, 4, 6, 3);
        await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'menacing' });
        expect(tok('orc').conditions.filter((c: any) => c.type === 'frightened')).toHaveLength(1);
        expect(pool().current).toBe(2);
    });
});

describe('disarming attack', () => {
    it('a failed STR save drops the held item: the part lets go, a prop lands at the target\'s feet, the sheet follows', async () => {
        await setup();
        pin(15, 4, 6, 3);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'disarming' });
        expect(r.maneuver).toMatchObject({ name: 'disarming', spent: true, save: { ability: 'strength', saved: false },
            applied: { dropped: 'scimitar', part: 'right arm', profilesAffected: ['scimitar'] } });
        const orc = tok('orc');
        expect(orc.parts[0].holds).toEqual([]);
        const state = getOrLoadEngine(ctx as any, enc)!.getState()!;
        const prop = (state.props ?? []).find(p => p.label === 'scimitar');
        expect(prop).toMatchObject({ position: '1,0', propType: 'interactive' });
        expect(prop!.description).toMatch(/dropped by Orc \(disarmed by Brannoc\)/);
        expect(sheet('orc').parts[0].holds).toEqual([]);
    });

    it('maneuverItem names what falls; a saved disarm drops nothing; a target with nothing in holds leaves it to the GM', async () => {
        await setup(FIGHTER, { ...ORC, parts: [{ name: 'arms', kind: 'arm', holds: ['scimitar', 'shield'] }] });
        pin(15, 4, 6, 20);
        const saved = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'disarming', maneuverItem: 'shield' });
        expect(saved.r.maneuver.save.saved).toBe(true);
        expect(saved.r.maneuver.applied).toBeUndefined();
        expect(tok('orc').parts[0].holds).toEqual(['scimitar', 'shield']);
        await advance(3);
        pin(15, 4, 6, 3);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'disarming', maneuverItem: 'shield' });
        expect(r.maneuver.applied).toMatchObject({ dropped: 'shield', part: 'arms', profilesAffected: [] });
        expect(tok('orc').parts[0].holds).toEqual(['scimitar']);

        await setup(FIGHTER, { ...ORC, parts: undefined });
        pin(15, 4, 6, 3);
        const bare = await act({ actorId: 'brannoc', targetId: 'orc', maneuver: 'disarming' });
        expect(bare.r.maneuver.applied).toMatchObject({ dropped: null });
        expect(bare.r.maneuver.applied.note).toMatch(/GM names what falls/);
    });
});
