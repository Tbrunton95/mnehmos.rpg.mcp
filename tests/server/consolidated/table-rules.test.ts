import { handleTableRules } from '../../../src/server/consolidated/table-rules.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { loadRule, loadRules, compareBands, resolveWorldId, DEFAULT_BAND_ORDER } from '../../../src/engine/table-rules.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { DAY_366_PRESET } from '../../../src/data/table-rules/day-366.js';

const ctx = { sessionId: 'rules' };
const W = 'world-40k';

async function call(args: Record<string, unknown>) {
    const text = (await handleTableRules({ worldId: W, ...args }, ctx as any)).content[0].text;
    return JSON.parse(text.match(/<!-- TABLE_RULES_JSON\n([\s\S]*?)\nTABLE_RULES_JSON -->/)![1]);
}

describe('table_rules', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('defines a rule with defaults filled and reads it back', async () => {
        const r = await call({ action: 'define', kind: 'peer_consequence', name: 'peers', spec: { thresholdFraction: 0.3 } });
        expect(r.created).toBe(true);
        expect(r.rule.spec).toMatchObject({ thresholdFraction: 0.3, onCrit: true });
        expect(loadRule(getDb(), W, 'peer_consequence')!.spec.thresholdFraction).toBe(0.3);
    });

    it('define on an existing name updates it', async () => {
        await call({ action: 'define', kind: 'progression', name: 'xp', spec: { mode: 'milestone' } });
        const r = await call({ action: 'define', kind: 'progression', name: 'xp', spec: { mode: 'xp' } });
        expect(r.created).toBe(false);
        expect(loadRule(getDb(), W, 'progression')!.spec.mode).toBe('xp');
    });

    it('refuses an unknown kind or a bad spec', async () => {
        expect((await call({ action: 'define', kind: 'lasers', name: 'x' })).error).toBe(true);
        const bad = await call({ action: 'define', kind: 'peer_consequence', name: 'x', spec: { thresholdFraction: 3 } });
        expect(bad.error).toBe(true);
        expect(bad.message).toMatch(/thresholdFraction/);
    });

    it('disabled rules are not loaded; enable brings them back; delete removes', async () => {
        await call({ action: 'define', kind: 'progression', name: 'xp' });
        await call({ action: 'disable', name: 'xp' });
        expect(loadRules(getDb(), W, 'progression')).toHaveLength(0);
        await call({ action: 'enable', name: 'xp' });
        expect(loadRules(getDb(), W, 'progression')).toHaveLength(1);
        await call({ action: 'delete', name: 'xp' });
        expect((await call({ action: 'list' })).count).toBe(0);
    });

    it('rules belong to one world', async () => {
        await call({ action: 'define', kind: 'progression', name: 'xp' });
        expect(loadRules(getDb(), 'other-world', 'progression')).toHaveLength(0);
    });

    it('imports the Day 366 preset, and importing again updates in place', async () => {
        const first = await call({ action: 'import', preset: 'day-366' });
        expect(first.created).toBe(DAY_366_PRESET.length);
        const again = await call({ action: 'import', preset: 'day-366' });
        expect(again.created).toBe(0);
        expect(again.updated).toBe(DAY_366_PRESET.length);
        const list = await call({ action: 'list', kind: 'principle' });
        expect(list.rules.some((r: any) => /Chaos pays first/i.test(r.spec.text))).toBe(true);
        expect(loadRule(getDb(), W, 'called_strike')!.spec.limbs.leg.speed).toBe(0.5);
    });

    it('an import with one bad entry writes nothing', async () => {
        const r = await call({ action: 'import', rules: [
            { kind: 'progression', name: 'ok' },
            { kind: 'nope', name: 'bad' }
        ] });
        expect(r.error).toBe(true);
        expect((await call({ action: 'list' })).count).toBe(0);
    });

    it('refuses a define that would change an existing name to another kind', async () => {
        await call({ action: 'define', kind: 'progression', name: 'Spawn' });
        const r = await call({ action: 'define', kind: 'creature', name: 'spawn', spec: { hp: 10, ac: 10 } });
        expect(r.error).toBe(true);
        expect(r.message).toMatch(/already a progression rule/);
        expect(loadRule(getDb(), W, 'progression')!.name).toBe('Spawn');
    });

    it('a creature needs hp and ac', async () => {
        const r = await call({ action: 'define', kind: 'creature', name: 'Blob', spec: { hp: 10 } });
        expect(r.error).toBe(true);
        expect(r.message).toMatch(/ac/);
    });
});

describe('band helpers', () => {
    it('compares bands in order, case-insensitively, null when unset', () => {
        expect(compareBands(DEFAULT_BAND_ORDER, 'astartes', 'Astartes')).toBe(0);
        expect(compareBands(DEFAULT_BAND_ORDER, 'Mortal', 'Astartes')).toBe(-1);
        expect(compareBands(DEFAULT_BAND_ORDER, 'Primarch-class', 'Monster/Lord')).toBe(1);
        expect(compareBands(DEFAULT_BAND_ORDER, undefined, 'Astartes')).toBeNull();
        expect(compareBands(DEFAULT_BAND_ORDER, 'Ork', 'Astartes')).toBeNull();
    });

    it('resolveWorldId tolerates missing columns and rows', () => {
        closeDb();
        const db = getDb(':memory:');
        expect(resolveWorldId(db, { encounterId: 'nope', characterIds: ['nope'] })).toBeNull();
        closeDb();
    });
});

describe('world resolution for untagged rows', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('uses the only world in a single-world save, and guesses nothing when there are two', async () => {
        const db = getDb();
        expect(resolveWorldId(db, { characterIds: ['untagged'] })).toBeNull();
        const now = new Date().toISOString();
        const worlds = new WorldRepository(db);
        worlds.create({ id: W, name: 'Vorago', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        await call({ action: 'define', kind: 'progression', name: 'xp' });
        expect(resolveWorldId(db, { characterIds: ['untagged'] })).toBe(W);
        // A second campaign in the same save: its untagged characters must
        // not pick up this world's rules, even though only this world has any.
        worlds.create({ id: 'pripyat', name: 'Pripyat', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        expect(resolveWorldId(db, { characterIds: ['untagged'] })).toBeNull();
    });
});
