import { handleBatchManage } from '../../../src/server/consolidated/batch-manage.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

/**
 * Field report: inside one execute_sequence, unseeded rolls made in the same
 * millisecond came back identical (three saves all 18; 4d10 [10,9,9,7] twice)
 * because the dice seeded from the clock. Each step must get its own seed.
 */
describe('execute_sequence dice', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('gives every unseeded roll in a sequence its own seed and dice', async () => {
        const res = await handleBatchManage({
            action: 'execute_sequence',
            steps: [1, 2, 3].map(i => ({ id: `r${i}`, tool: 'math_manage', args: { action: 'roll', expression: '12d10' } }))
        }, { sessionId: 'batch-dice' } as any);
        const text = res.content[0].text;
        const rolls = [...text.matchAll(/Rolled 12d10: \[([^\]]+)\]/g)].map(m => m[1]);
        // Each step's dice appear more than once (banner + embedded JSON).
        expect(new Set(rolls).size).toBe(3);
        const seeds = [...text.matchAll(/▌ seed (\S+)/g)].map(m => m[1]);
        expect(new Set(seeds).size).toBe(3);
    });
});
