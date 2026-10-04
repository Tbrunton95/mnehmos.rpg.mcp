/**
 * Deep One audit: an unresolved {{…}} reference in execute_sequence must fail
 * THAT step loudly. Before, an unknown step id passed the literal string on
 * and a dead path dropped the arg, so the downstream tool refused for the
 * wrong reason (or, worse, succeeded with a missing optional).
 */
import { handleBatchManage, BatchManageTool } from '../../../src/server/consolidated/batch-manage.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

process.env.NODE_ENV = 'test';
const ctx = { sessionId: 'batch-ref' } as any;
function parse(result: { content: Array<{ type: string; text: string }> }) {
    const m = result.content[0].text.match(/<!-- BATCH_MANAGE_JSON\n([\s\S]*?)\nBATCH_MANAGE_JSON -->/);
    return m ? JSON.parse(m[1]) : null;
}
const sword = { id: 'sword', tool: 'item_manage', args: { action: 'create', name: 'Longsword', type: 'weapon' } };

describe('execute_sequence unresolved references', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('resolves {{sword.item.id}} and uses it downstream', async () => {
        const res = parse(await handleBatchManage({ action: 'execute_sequence', steps: [
            sword,
            { id: 'look', tool: 'item_manage', args: { action: 'get', itemId: '{{sword.item.id}}' } }
        ] }, ctx));
        expect(res.success).toBe(true);
        expect(res.steps[1].result.item.name).toBe('Longsword');
    });

    it('fails the step on an unknown step id and lists the known steps', async () => {
        const res = parse(await handleBatchManage({ action: 'execute_sequence', stopOnError: false, steps: [
            sword,
            { id: 'look', tool: 'item_manage', args: { action: 'get', itemId: '{{blade.item.id}}' } }
        ] }, ctx));
        expect(res.success).toBe(false);
        expect(res.failureCount).toBe(1);
        const step = res.steps[1];
        expect(step.success).toBe(false);
        expect(step.unresolvedRef).toBe('{{blade.item.id}}');
        expect(step.knownSteps).toEqual(['sword']);
        expect(step.error).toMatch(/unresolved reference/i);
        expect(res.unresolvedRefs).toEqual(['{{blade.item.id}}']);
    });

    it('fails the step on a dead path and names the keys the step result has', async () => {
        const res = parse(await handleBatchManage({ action: 'execute_sequence', stopOnError: false, steps: [
            sword,
            { id: 'look', tool: 'item_manage', args: { action: 'get', itemId: '{{sword.itemId}}' } }
        ] }, ctx));
        const step = res.steps[1];
        expect(step.success).toBe(false);
        expect(step.unresolvedRef).toBe('{{sword.itemId}}');
        expect(step.availableKeys).toEqual(expect.arrayContaining(['success', 'item', 'message']));
        expect(step.error).toContain('item');
    });

    it('recognises the {{step.N.path}} spelling and corrects it', async () => {
        const res = parse(await handleBatchManage({ action: 'execute_sequence', stopOnError: false, steps: [
            { tool: 'item_manage', args: { action: 'create', name: 'Dagger', type: 'weapon' } },
            { tool: 'item_manage', args: { action: 'get', itemId: '{{step.1.item.id}}' } }
        ] }, ctx));
        const step = res.steps[1];
        expect(step.success).toBe(false);
        expect(step.unresolvedRef).toBe('{{step.1.item.id}}');
        expect(step.hint).toBe('did you mean {{step1.item.id}}');
        expect(step.knownSteps).toEqual(['step1']);
    });

    it('a reference inside a nested object is checked too, and stopOnError halts the sequence', async () => {
        const res = parse(await handleBatchManage({ action: 'execute_sequence', steps: [
            sword,
            { id: 'patch', tool: 'item_manage', args: { action: 'update', itemId: '{{sword.item.id}}', properties: { from: '{{nowhere.x}}' } } },
            { id: 'after', tool: 'item_manage', args: { action: 'list' } }
        ] }, ctx));
        expect(res.steps.length).toBe(2);
        expect(res.steps[1].unresolvedRef).toBe('{{nowhere.x}}');
        expect(res.failureCount).toBe(1);
    });

    it('documents the {{step1.item.id}} form', () => {
        expect(BatchManageTool.description).toContain('{{step1.item.id}}');
    });
});
