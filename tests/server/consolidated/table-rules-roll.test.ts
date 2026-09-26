import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { handleSessionManage } from '../../../src/server/consolidated/session-manage.js';
import { withOperation } from '../../../src/server/operation-guard.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { queryRolls } from '../../../src/storage/roll-log.js';
import { parseRuleSpec, DATA_KINDS } from '../../../src/engine/table-rules.js';
import { tableRanges, defaultDice, rollTable } from '../../../src/engine/roll-table.js';

/**
 * Item 11: a roll_table kind for any random table a world keeps (the Eye of
 * the Gods, miscasts, omens, weather). Weights become cumulative ranges; a
 * modifier shifts the total, clamped to the table's span; an entry can chain
 * to another table. Rolls are seeded and logged.
 */
const W = 'world-tables';
const ctx = { sessionId: 'unscoped' };
const tag = (text: string, t: string) => JSON.parse(text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`))![1]);
const rules = withOperation('table_rules', async (args: Record<string, unknown>) => handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...args }), ctx as any));
const run = async (args: Record<string, unknown>) => tag((await rules(args)).content[0].text, 'TABLE_RULES');

const fixed = (...totals: number[]) => {
    let i = 0;
    return (notation: string) => { const t = totals[i++ % totals.length]; return { total: t, rolls: [t] }; };
};

describe('roll_table spec', () => {
    it('is a data kind', () => {
        expect(DATA_KINDS.has('roll_table')).toBe(true);
        expect(DATA_KINDS.has('creature')).toBe(true);
        expect(DATA_KINDS.has('band')).toBe(false);
    });

    it('weights become cumulative ranges from 1, and the default die spans them', () => {
        const spec = parseRuleSpec('roll_table', { entries: [{ weight: 2, text: 'A' }, { weight: 1, text: 'B' }, { text: 'C' }] });
        expect(spec.poolDivisor).toBe(1);
        expect(tableRanges(spec).map(r => [r.lo, r.hi])).toEqual([[1, 2], [3, 3], [4, 4]]);
        expect(defaultDice(spec)).toBe('1d4');
    });

    it('ranged entries keep their numbers; the default die reaches the top', () => {
        const spec = parseRuleSpec('roll_table', { entries: [{ min: 1, max: 3, text: 'low' }, { min: 4, max: 6, text: 'high' }] });
        expect(defaultDice(spec)).toBe('1d6');
        expect(tableRanges(spec).map(r => [r.lo, r.hi])).toEqual([[1, 3], [4, 6]]);
    });

    it('refuses weighted and ranged entries mixed, overlaps, and an empty table', () => {
        expect(() => parseRuleSpec('roll_table', { entries: [{ weight: 1, text: 'a' }, { min: 2, max: 3, text: 'b' }] })).toThrow(/weight.*or.*min|mix/i);
        expect(() => parseRuleSpec('roll_table', { entries: [{ min: 1, max: 4, text: 'a' }, { min: 3, max: 6, text: 'b' }] })).toThrow(/overlap/);
        expect(() => parseRuleSpec('roll_table', { entries: [] })).toThrow();
        expect(() => parseRuleSpec('roll_table', { poolDivisor: 0, entries: [{ text: 'a' }] })).toThrow();
    });

    it('rollTable adds the modifier and clamps to the span', () => {
        const spec = parseRuleSpec('roll_table', { entries: [{ weight: 2, text: 'A' }, { weight: 1, text: 'B' }] });
        expect(rollTable(spec, fixed(2), { tag: 't' })).toMatchObject({ dice: '1d3', total: 2, index: 0, entry: { text: 'A' } });
        const up = rollTable(spec, fixed(2), { modifier: 5, tag: 't' });
        expect(up).toMatchObject({ modifier: 5, total: 3, clamped: true, index: 1 });
        const down = rollTable(spec, fixed(1), { modifier: -4, tag: 't' });
        expect(down).toMatchObject({ total: 1, clamped: true, index: 0 });
    });
});

describe('table_rules roll', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    async function eye() {
        await run({ action: 'define', kind: 'roll_table', name: 'Eye of the Gods', spec: {
            dice: '2d6', modifierPool: 'favour', poolDivisor: 3,
            entries: [
                { min: 2, max: 6, text: 'Mutation', chain: 'Mutations' },
                { min: 7, max: 10, text: 'Gift of strength' },
                { min: 11, max: 12, text: 'Daemonhood' }
            ]
        } });
        await run({ action: 'define', kind: 'roll_table', name: 'Mutations', spec: { entries: [{ text: 'Tentacle' }, { text: 'Horns' }] } });
    }

    it('rolls, logs the roll, and replays from a seed', async () => {
        await eye();
        const a = await run({ action: 'roll', name: 'Eye of the Gods', seed: 'eye-1' });
        expect(a.success).toBe(true);
        expect(a.rolled.dice).toBe('2d6');
        expect(a.rolled.rolls).toHaveLength(2);
        expect(a.entry.text).toBeTruthy();
        const row = queryRolls(getDb(), { limit: 20 }).find((r: any) => r.id === a.rollId) as any;
        expect(row).toMatchObject({ purpose: 'table Eye of the Gods', expression: '2d6', replay: 'eye-1', tool: 'table_rules' });
        const b = await run({ action: 'roll', name: 'eye of the gods', seed: 'eye-1' });
        expect(b.rolled).toEqual(a.rolled);
        expect(b.entry).toEqual(a.entry);
    });

    it('an entry with chain rolls the next table', async () => {
        await run({ action: 'define', kind: 'roll_table', name: 'Start', spec: { entries: [{ text: 'go on', chain: 'Mutations' }] } });
        await run({ action: 'define', kind: 'roll_table', name: 'Mutations', spec: { entries: [{ text: 'Tentacle' }, { text: 'Horns' }] } });
        const r = await run({ action: 'roll', name: 'Start' });
        expect(r.entry.text).toBe('go on');
        expect(r.chained).toHaveLength(1);
        expect(r.chained[0]).toMatchObject({ table: 'Mutations', depth: 1 });
        expect(['Tentacle', 'Horns']).toContain(r.chained[0].entry.text);
        expect(r.text).toMatch(/go on.*(Tentacle|Horns)/s);
    });

    it('chains stop after five tables', async () => {
        await run({ action: 'define', kind: 'roll_table', name: 'Loop', spec: { entries: [{ text: 'again', chain: 'Loop' }] } });
        const r = await run({ action: 'roll', name: 'Loop' });
        expect(r.chained).toHaveLength(5);
        expect(r.note).toMatch(/depth/);
    });

    it('a chain to a missing table is reported, not thrown', async () => {
        await run({ action: 'define', kind: 'roll_table', name: 'Broken', spec: { entries: [{ text: 'x', chain: 'Nowhere' }] } });
        const r = await run({ action: 'roll', name: 'Broken' });
        expect(r.success).toBe(true);
        expect(r.chained).toEqual([]);
        expect(r.note).toMatch(/Nowhere/);
    });

    it("the modifier adds the character's pool divided by poolDivisor", async () => {
        await eye();
        const now = new Date().toISOString();
        new CharacterRepository(getDb()).create({
            id: 'kor', name: 'Kor', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 10, level: 1,
            resourcePools: { Favour: { current: 7, max: 20 } }, createdAt: now, updatedAt: now
        } as any);
        const r = await run({ action: 'roll', name: 'Eye of the Gods', characterId: 'kor', modifier: 1, seed: 's' });
        // floor(7 / 3) = 2, plus the input 1
        expect(r.rolled.modifier).toBe(3);
        expect(r.rolled.total).toBe(Math.min(12, r.rolled.natural + 3));
        const row = queryRolls(getDb(), { forId: 'kor' })[0] as any;
        expect(row.purpose).toBe('table Eye of the Gods');
    });

    it('refuses an unknown table or a rule of another kind', async () => {
        await run({ action: 'define', kind: 'band', name: 'bands' });
        expect((await run({ action: 'roll', name: 'Nope' })).error).toBe(true);
        expect((await run({ action: 'roll', name: 'bands' })).message).toMatch(/not a roll_table/);
    });

    it('the description names the kind and the verb', () => {
        expect(TableRulesTool.description).toContain('roll_table');
        expect(TableRulesTool.description).toMatch(/roll \{/);
    });

    it('boot lists tables as data, not as enforced rules', async () => {
        await eye();
        await run({ action: 'define', kind: 'band', name: 'bands' });
        const res = await handleSessionManage({ action: 'boot', worldId: W }, ctx as any);
        const p = tag(res.content[0].text, 'SESSION_MANAGE');
        expect(p.tableRules.enforced.map((r: any) => r.kind)).toEqual(['band']);
        expect(p.tableRules.data).toEqual({ roll_table: 2 });
        expect(res.content[0].text).toMatch(/Data: roll_table 2/);
    });
});
