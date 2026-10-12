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

    // Play report 4 #2: a roll step prints its disclosure block instead of the
    // reply's message, so the ignored-key note the router put in that message
    // never reached the batch banner — only the embed knew. The step line
    // carries it now; a clean roll step prints nothing extra.
    it('a roll step with a key roll does not take shows the ignored-key note under its disclosure block', async () => {
        const res = await handleBatchManage({
            action: 'execute_sequence',
            steps: [
                { id: 'typo', tool: 'math_manage', args: { action: 'roll', expression: '1d20', expresion: '2d6' } },
                { id: 'clean', tool: 'math_manage', args: { action: 'roll', expression: '1d20' } }
            ]
        }, { sessionId: 'batch-ignored' } as any);
        const text = res.content[0].text;
        const banner = text.slice(0, text.indexOf('<!-- BATCH_MANAGE_JSON'));
        expect(banner).toMatch(/⚠ Ignored params \(not roll parameters; nothing was written for them\): expresion — nearest valid key 'expression'\./);
        expect(banner.split('Ignored params').length - 1).toBe(1);
        const embed = JSON.parse(text.match(/<!-- BATCH_MANAGE_JSON\n([\s\S]*?)\nBATCH_MANAGE_JSON -->/)![1]);
        expect(embed.stepResults.typo.ignoredParams).toEqual(['expresion']);
        expect(embed.stepResults.clean.ignoredParams).toBeUndefined();
        expect(embed.successCount).toBe(2);
    });
});
