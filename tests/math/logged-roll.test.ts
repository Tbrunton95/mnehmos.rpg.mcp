import { loggedRoll, loggedRoller, engineRoller } from '../../src/math/logged-d20.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';

/**
 * One dice abstraction for rolls outside an encounter: any notation, seeded,
 * logged to roll_log with its replay seed. DiceRoller is the shape tables,
 * miscasts and offerings take, so they roll on the right stream anywhere.
 */
describe('loggedRoll', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('rolls any notation, logs it with its seed, and replays from the seed', () => {
        const a = loggedRoll(getDb(), { purpose: 'omen', forId: 'hero' }, '2d6+1', { seed: 'omen-1' });
        expect(a.rolls).toHaveLength(2);
        expect(a.total).toBe(a.rolls[0] + a.rolls[1] + 1);
        expect(a.seed).toBe('omen-1');
        const row = queryRolls(getDb(), { forId: 'hero' }).find((r: any) => r.id === a.rollId) as any;
        expect(row).toMatchObject({ purpose: 'omen', expression: '2d6+1', replay: 'omen-1', result: a.total });
        expect(row.dice.map((d: any) => d.sides)).toEqual([6, 6]);
        const b = loggedRoll(getDb(), { purpose: 'omen' }, '2d6+1', { seed: 'omen-1' });
        expect(b.rolls).toEqual(a.rolls);
    });

    it('handles negative dice terms and refuses bad notation', () => {
        const r = loggedRoll(getDb(), { purpose: 'x' }, '1d4-1d4+10');
        expect(r.total).toBe(r.rolls[0] + r.rolls[1] + 10);
        expect(r.rolls[1]).toBeLessThan(0);
        expect(() => loggedRoll(getDb(), { purpose: 'x' }, '1d6++2')).toThrow(/Invalid dice/);
    });

    it('unseeded rolls get a fresh seed each time', () => {
        const a = loggedRoll(getDb(), { purpose: 'x' }, '1d20');
        const b = loggedRoll(getDb(), { purpose: 'x' }, '1d20');
        expect(a.seed).not.toBe(b.seed);
    });
});

describe('DiceRoller', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('loggedRoller logs every roll under its tag; a seeded roller replays its whole sequence', () => {
        const r1 = loggedRoller(getDb(), { forId: 'hero', seed: 'chain' });
        const seq1 = [r1('1d100', 'table a'), r1('1d100', 'table b')];
        const r2 = loggedRoller(getDb(), { forId: 'hero', seed: 'chain' });
        const seq2 = [r2('1d100', 'table a'), r2('1d100', 'table b')];
        expect(seq2.map(s => s.rolls)).toEqual(seq1.map(s => s.rolls));
        const logged = queryRolls(getDb(), { forId: 'hero', limit: 10 });
        expect(logged).toHaveLength(4);
        expect(logged.map((l: any) => l.purpose)).toContain('table b');
        expect(new Set(logged.map((l: any) => l.replay)).size).toBe(2);
    });

    it('engineRoller rolls on the encounter stream under the tag', () => {
        const engine = new CombatEngine('roller-seed');
        const spy = vi.spyOn(engine, 'rollDice');
        const roll = engineRoller(engine, { forId: 'hero' });
        const r = roll('2d6', 'perils');
        expect(spy).toHaveBeenCalledWith('2d6', { purpose: 'perils', forId: 'hero' });
        expect(r.total).toBe(r.rolls[0] + r.rolls[1]);
    });
});
