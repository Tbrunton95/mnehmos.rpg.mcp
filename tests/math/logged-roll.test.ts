import { loggedRoll, loggedRoller, engineRoller, loggedD20, loggedDice } from '../../src/math/logged-d20.js';
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

    it('unseeded rolls are crypto dice with a unique crypto key each time', () => {
        const a = loggedRoll(getDb(), { purpose: 'x', forId: 'k' }, '1d20');
        const b = loggedRoll(getDb(), { purpose: 'x', forId: 'k' }, '1d20');
        expect(a.seed).not.toBe(b.seed);
        expect(a.source).toBe('crypto');
        expect(a.seed).toMatch(/^crypto:[0-9a-f]{8}$/);
        const rows = queryRolls(getDb(), { forId: 'k' });
        expect(rows.map((r: any) => r.source)).toEqual(['crypto', 'crypto']);
        expect(rows.map((r: any) => r.replay).sort()).toEqual([a.seed, b.seed].sort());
    });

    it('a seeded roll is marked seeded; a crypto key is refused as a seed', () => {
        const a = loggedRoll(getDb(), { purpose: 's', forId: 's' }, '1d20', { seed: 'again' });
        expect(a.source).toBe('seeded');
        expect(queryRolls(getDb(), { forId: 's' })[0]).toMatchObject({ source: 'seeded', replay: 'again' });
        expect(() => loggedRoll(getDb(), { purpose: 's' }, '1d20', { seed: 'crypto:deadbeef' })).toThrow(/cannot be replayed/);
    });
});

describe('loggedD20 and loggedDice', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('loggedD20 is crypto by default, keeps the right die under advantage, and logs 2d20kh1', () => {
        for (let i = 0; i < 50; i++) {
            const r = loggedD20(getDb(), { purpose: 'adv', forId: 'h' }, { advantage: true });
            expect(r.rolls).toHaveLength(2);
            expect(r.natural).toBe(Math.max(...r.rolls));
            expect(r.source).toBe('crypto');
        }
        const row = queryRolls(getDb(), { forId: 'h', limit: 1 })[0] as any;
        expect(row).toMatchObject({ expression: '2d20kh1', source: 'crypto' });
        expect(row.replay).toMatch(/^crypto:/);
    });

    it('loggedD20 with a seed replays the same die', () => {
        const a = loggedD20(getDb(), { purpose: 'seeded d20' }, { seed: 'd20-seed' });
        const b = loggedD20(getDb(), { purpose: 'seeded d20' }, { seed: 'd20-seed' });
        expect(a.natural).toBe(b.natural);
        expect(a.source).toBe('seeded');
        expect(a.seed).toBe('d20-seed');
    });

    it('loggedDice is crypto by default and logs count and sides', () => {
        const r = loggedDice(getDb(), { purpose: 'surface', forId: 'd' }, 3, 6);
        expect(r.rolls).toHaveLength(3);
        expect(r.total).toBe(r.rolls.reduce((x, y) => x + y, 0));
        expect(r.source).toBe('crypto');
        const row = queryRolls(getDb(), { forId: 'd' })[0] as any;
        expect(row).toMatchObject({ expression: '3d6', source: 'crypto', result: r.total });
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
