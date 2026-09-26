import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { withOperation } from '../../../src/server/operation-guard.js';
import { clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../../src/storage/repos/custom-effects.repo.js';
import { CorpseRepository } from '../../../src/storage/repos/corpse.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { parseRuleSpec } from '../../../src/engine/table-rules.js';
import { rollAndApply } from '../../../src/server/roll-table-apply.js';

/**
 * Item 1: the Eye of the Gods. A table entry can apply itself: a gift (an
 * effect), a condition and writes, a form, or death. table_rules roll
 * applies the entry to characterId unless apply: false previews it.
 */
const W = 'eye-world';
const ctx = { sessionId: 'eye' };
const tag = (text: string) => JSON.parse(text.match(/<!-- TABLE_RULES_JSON\n([\s\S]*?)\nTABLE_RULES_JSON -->/)![1]);
const rules = withOperation('table_rules', async (args: Record<string, unknown>) => handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...args }), ctx as any));
const run = async (args: Record<string, unknown>) => tag((await rules(args)).content[0].text);
const sheet = () => new CharacterRepository(getDb()).findById('kor')! as any;
const table = (name: string, entries: unknown[], extra: Record<string, unknown> = {}) =>
    run({ action: 'define', kind: 'roll_table', name, spec: { entries, ...extra } });

beforeEach(() => {
    closeDb(); clearCombatState();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Eye', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    new CharacterRepository(db).create({
        id: 'kor', name: 'Kor', characterType: 'pc', stats: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 12 }, hp: 20, maxHp: 40, ac: 15, level: 5,
        resourcePools: { favour: { current: 9, max: 20 } }, createdAt: now, updatedAt: now
    } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ?').run(W);
});
afterEach(() => closeDb());

describe('entry apply spec', () => {
    it('validates the apply block', () => {
        const spec = parseRuleSpec('roll_table', { entries: [{ text: 'gift', apply: { gift: { name: 'Mark' } } }] });
        expect((spec.entries[0] as any).apply.gift).toMatchObject({ name: 'Mark', category: 'boon', powerLevel: 1, mechanics: [] });
        expect(() => parseRuleSpec('roll_table', { entries: [{ text: 'x', apply: { terminal: 'explode' } }] })).toThrow();
        expect(() => parseRuleSpec('roll_table', { entries: [{ text: 'x', apply: { hpMode: 'most' } }] })).toThrow();
        expect(() => parseRuleSpec('roll_table', { entries: [{ text: 'x', apply: { writes: [{ op: 'explode' }] } }] })).toThrow();
    });
});

describe('table_rules roll applies the entry', () => {
    it('a gift becomes an effect; the same gift again refreshes it', async () => {
        await table('Gifts', [{ text: 'Mark of Khorne', apply: { gift: { name: 'Mark of Khorne', description: '+1 to hit', mechanics: [{ type: 'attack_bonus', value: 1 }] } } }]);
        const r = await run({ action: 'roll', name: 'Gifts', characterId: 'kor' });
        expect(r.success).toBe(true);
        expect(r.applied[0]).toMatchObject({ table: 'Gifts', gift: { name: 'Mark of Khorne', refreshedExisting: false } });
        const fx = new CustomEffectsRepository(getDb()).findByTargetAndName('kor', 'character', 'Mark of Khorne');
        expect(fx).toMatchObject({ category: 'boon', source_entity_name: 'table Gifts' });
        const again = await run({ action: 'roll', name: 'Gifts', characterId: 'kor' });
        expect(again.applied[0].gift.refreshedExisting).toBe(true);
    });

    it('a condition and writes land on the sheet, with the table in the pool history', async () => {
        await table('Warp', [{ text: 'Scarred', apply: {
            condition: { name: 'Warpscarred', pinned: true },
            writes: [{ op: 'adjust_pool', pool: 'favour', delta: 2 }, { op: 'adjust_max_hp', delta: 5 }]
        } }]);
        const r = await run({ action: 'roll', name: 'Warp', characterId: 'kor' });
        expect(r.applied[0].writes).toEqual(expect.arrayContaining([expect.stringMatching(/favour: 9 → 11/), expect.stringMatching(/maxHp: 40 → 45/)]));
        const s = sheet();
        expect(s.conditions).toEqual([expect.objectContaining({ name: 'Warpscarred', source: 'table Warp', pinned: true })]);
        expect(s.maxHp).toBe(45);
        expect(s.resourcePools.favour.history.at(-1)).toMatchObject({ from: 9, to: 11, reason: expect.stringMatching(/Warp/) });
    });

    it('a form entry transforms; a terminal entry kills, leaves a corpse and stops the chain', async () => {
        await run({ action: 'define', kind: 'creature', name: 'Daemon Prince', spec: { hp: 180, ac: 19, size: 'huge' } });
        await table('Ascend', [{ text: 'Daemonhood', apply: { form: 'Daemon Prince', hpMode: 'full' } }]);
        const a = await run({ action: 'roll', name: 'Ascend', characterId: 'kor' });
        expect(a.applied[0].form).toMatchObject({ form: 'Daemon Prince', hp: 180 });
        expect(sheet().form.name).toBe('Daemon Prince');

        await table('After', [{ text: 'never' }]);
        await table('Doom', [{ text: 'Torn apart', chain: 'After', apply: { terminal: 'kill', corpse: true } }]);
        const d = await run({ action: 'roll', name: 'Doom', characterId: 'kor' });
        expect(d.applied[0]).toMatchObject({ killed: true, corpseId: expect.any(String) });
        expect(sheet().hp).toBe(0);
        expect(new CorpseRepository(getDb()).findByCharacterId('kor')).toBeTruthy();
        expect(d.chained).toEqual([]);
        expect(d.note).toMatch(/dead/);
    });

    it('apply: false previews and writes nothing; no characterId rolls text only', async () => {
        await table('Warp', [{ text: 'Scarred', apply: { condition: { name: 'Warpscarred' } } }]);
        const p = await run({ action: 'roll', name: 'Warp', characterId: 'kor', apply: false });
        expect(p).toMatchObject({ success: true, preview: true, text: 'Scarred' });
        expect(p.applied).toBeUndefined();
        expect(sheet().conditions).toEqual([]);
        const t = await run({ action: 'roll', name: 'Warp' });
        expect(t.text).toBe('Scarred');
        expect(t.applied).toBeUndefined();
    });

    it('the favour modifier reads the top entry, and a chained entry applies too', async () => {
        await table('Mutations', [{ text: 'Horns', apply: { gift: { name: 'Horns', category: 'transformative' } } }]);
        await table('Eye of the Gods', [
            { min: 2, max: 6, text: 'Spawndom', apply: { terminal: 'kill' } },
            { min: 7, max: 10, text: 'Nothing' },
            { min: 11, max: 12, text: 'Mutation', chain: 'Mutations', apply: { writes: [{ op: 'adjust_pool', pool: 'favour', delta: -3 }] } }
        ], { dice: '2d6', modifierPool: 'favour', poolDivisor: 1 });
        const r = await run({ action: 'roll', name: 'Eye of the Gods', characterId: 'kor', modifier: 20, seed: 'up' });
        expect(r.poolBonus).toMatchObject({ pool: 'favour', current: 9, bonus: 9 });
        expect(r.entry.text).toBe('Mutation');
        expect(r.applied.map((a: any) => a.table)).toEqual(['Eye of the Gods', 'Mutations']);
        expect(sheet().resourcePools.favour.current).toBe(6);
        expect(new CustomEffectsRepository(getDb()).findByTargetAndName('kor', 'character', 'Horns')).toBeTruthy();
    });
});

describe('rollAndApply', () => {
    it('takes any roller and a missing modifier pool adds 0 with a note', async () => {
        await table('T', [{ min: 1, max: 3, text: 'low' }, { min: 4, max: 6, text: 'high', apply: { condition: { name: 'Lucky' } } }], { modifierPool: 'souls' });
        const roller = () => ({ total: 5, rolls: [5] });
        const r = await rollAndApply(getDb(), { worldId: W, name: 'T', characterId: 'kor', apply: true, roller }) as any;
        expect(r).toMatchObject({ success: true, text: 'high' });
        expect(r.note).toMatch(/souls/);
        expect(sheet().conditions[0].name).toBe('Lucky');
    });
});
