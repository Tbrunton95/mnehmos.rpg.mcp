import { DiceEngine } from '../../src/math/dice.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { handleMathManage, MathManageTool } from '../../src/server/consolidated/math-manage.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';

// Play report: math_manage roll refused '6d10+3d10', which likely pushed the
// GM to an outside RNG. Multi-term expressions now roll on the same seeded
// DiceEngine, list every die, log them all, and replay from the seed.
const ctx = { sessionId: 'unscoped' };
const math = withOperation('math_manage', (args: any) => handleMathManage(MathManageTool.inputSchema.parse(args), ctx));
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };

beforeEach(() => { closeDb(); getDb(':memory:'); });
afterEach(() => closeDb());

describe('DiceEngine multi-term', () => {
    it('rolls 6d10+3d10+4 as nine dice plus 4, seeded', () => {
        const r = new DiceEngine('fixed').roll('6d10+3d10+4');
        const dice = (r.metadata as any).dice as Array<{ sides: number; value: number; sign: number }>;
        expect(dice).toHaveLength(9);
        expect(dice.every(d => d.sides === 10 && d.value >= 1 && d.value <= 10)).toBe(true);
        expect(r.result).toBe(dice.reduce((a, d) => a + d.value, 0) + 4);
        expect((r.metadata as any).rolls).toHaveLength(9);
        expect(new DiceEngine('fixed').roll('6d10+3d10+4').result).toBe(r.result);
    });

    it('subtracts a signed term: 2d6+1d4-1', () => {
        const r = new DiceEngine('s2').roll('2d6+1d4-1');
        const dice = (r.metadata as any).dice;
        expect(dice.map((d: any) => d.sides)).toEqual([6, 6, 4]);
        expect(r.result).toBe(dice.reduce((a: number, d: any) => a + d.value, 0) - 1);
        expect(r.steps.join('\n')).toMatch(/1d4/);
    });

    it('keeps single-term keep/drop and explode syntax unchanged, and still refuses junk', () => {
        const single = new DiceEngine('k').roll('4d6dl1');
        expect((single.metadata as any).rolls).toHaveLength(4);
        expect(new DiceEngine('e').roll('2d6+1!').steps[0]).toMatch(/Rolled 2d6/);
        expect(() => new DiceEngine('x').roll('2d6++1')).toThrow(/Invalid dice/);
        expect(() => new DiceEngine('x').roll('7')).toThrow(/Invalid dice/);
    });
});

describe("math_manage roll '6d10+3d10'", () => {
    it('is seeded, logs all nine dice, and replays from its seed', async () => {
        const r = json(await math({ action: 'roll', expression: '6d10+3d10', purpose: 'volley' }));
        expect(r.success).toBe(true);
        expect(r.seed).toBeTruthy();
        const logged = queryRolls(getDb(), { limit: 5 }).find((x: any) => x.purpose === 'volley') as any;
        expect(logged.dice).toHaveLength(9);
        expect(logged.dice.every((d: any) => d.sides === 10)).toBe(true);
        expect(logged.result).toBe(r.total);
        const again = json(await math({ action: 'roll', expression: '6d10+3d10', seed: r.seed }));
        expect(again.total).toBe(r.total);
    });

    it('logs mixed sides per die', async () => {
        await math({ action: 'roll', expression: '2d6+1d4-1', purpose: 'mixed' });
        const logged = queryRolls(getDb(), { limit: 5 }).find((x: any) => x.purpose === 'mixed') as any;
        expect(logged.dice.map((d: any) => d.sides)).toEqual([6, 6, 4]);
    });
});
