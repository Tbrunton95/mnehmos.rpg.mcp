import { handleRestManage } from '../../../src/server/consolidated/rest-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleItemManage } from '../../../src/server/consolidated/item-manage.js';
import { handleInventoryManage } from '../../../src/server/consolidated/inventory-manage.js';
import { getCombatManager } from '../../../src/server/state/combat-manager.js';
import { getDb, closeDb } from '../../../src/storage/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';

/**
 * Play report 2, item 18: a rest refills the pools a GM marked with a refresh
 * policy (superiority dice, rages), readies per-rest abilities (Second Wind)
 * on the sheet, gives a legendary creature its resistances back on a long
 * rest, and keeps the hit-dice pool's label and history. The in-combat guard
 * reads active encounter rows in the database, not in-memory engines.
 */
const ctx = { sessionId: 'rest-pools' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const rest = async (args: Record<string, unknown>) => json(await handleRestManage({ characterId: 'bm', ...args }, ctx as any));
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const sheet = () => new CharacterRepository(getDb()).findById('bm')! as any;
const pools = () => sheet().resourcePools as Record<string, any>;
let now: string;

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    getCombatManager().clear();
    now = new Date().toISOString();
    new CharacterRepository(db).create({
        id: 'bm', name: 'Brannoc', characterType: 'pc', characterClass: 'fighter', level: 5,
        hp: 10, maxHp: 44, ac: 18, stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 },
        resourcePools: {
            superiority: { current: 1, max: 4, refresh: 'short' },
            rage: { current: 0, max: 3, refresh: 'long' },
            souls: { current: 2, max: 10, refresh: 'none' },
            respect: { current: 3, max: 10 },
            hit_dice: { current: 2, max: 5, label: 'Hit dice', note: 'd10s', history: [{ from: 5, to: 2, reason: 'spent on the road' }] }
        },
        abilities: [
            { name: 'Second Wind', perRest: 'short', ready: false },
            { name: 'Indomitable', perRest: 'long', ready: false },
            { name: 'Fire Breath', recharge: 5, ready: false }
        ],
        legendaryResistances: 3, legendaryResistancesRemaining: 1,
        createdAt: now, updatedAt: now
    } as any);
});
afterEach(() => { closeDb(); getCombatManager().clear(); });

describe('rest_manage refills pools by their refresh policy', () => {
    it('a short rest refills refresh:short pools and leaves long, none and unset pools alone', async () => {
        const r = await rest({ action: 'short', hitDiceToSpend: 0 });
        expect(r.restType).toBe('short');
        const p = pools();
        expect(p.superiority).toMatchObject({ current: 4, max: 4, refresh: 'short' });
        expect(p.superiority.lastRefilledAt).toBeTruthy();
        expect(p.superiority.history.at(-1)).toMatchObject({ from: 1, to: 4, reason: 'short rest' });
        expect(p.rage.current).toBe(0);
        expect(p.souls.current).toBe(2);
        expect(p.respect.current).toBe(3);
        expect(r.refilled).toEqual(expect.arrayContaining([{ kind: 'pool', name: 'superiority', from: 1, to: 4, max: 4 }]));
        expect(r.refilled.some((x: any) => x.name === 'rage')).toBe(false);
    });

    it('a long rest refills short and long pools, never none or unset', async () => {
        const r = await rest({ action: 'long' });
        const p = pools();
        expect(p.superiority.current).toBe(4);
        expect(p.rage).toMatchObject({ current: 3, max: 3 });
        expect(p.rage.history.at(-1)).toMatchObject({ from: 0, to: 3, reason: 'long rest' });
        expect(p.souls.current).toBe(2);
        expect(p.respect.current).toBe(3);
        expect(r.refilled).toEqual(expect.arrayContaining([
            { kind: 'pool', name: 'superiority', from: 1, to: 4, max: 4 },
            { kind: 'pool', name: 'rage', from: 0, to: 3, max: 3 }
        ]));
        expect(r.message).toMatch(/superiority 1 → 4/);
    });

    it('a pool already at max is left alone: no history noise, not listed', async () => {
        await char({ action: 'adjust_pool', characterId: 'bm', pool: 'superiority', value: 4 });
        const before = pools().superiority.history?.length ?? 0;
        const r = await rest({ action: 'short', hitDiceToSpend: 0 });
        expect(pools().superiority.history?.length ?? 0).toBe(before);
        expect(r.refilled.some((x: any) => x.name === 'superiority')).toBe(false);
    });

    it("the Operator's attentional_capacity refills on a long rest without a policy of its own", async () => {
        await char({ action: 'adjust_pool', characterId: 'bm', pool: 'attentional_capacity', value: 0, max: 3 });
        await rest({ action: 'short', hitDiceToSpend: 0 });
        expect(pools().attentional_capacity.current).toBe(0);
        await rest({ action: 'long' });
        expect(pools().attentional_capacity.current).toBe(3);
    });

    it('hit dice keep their label, note and history through both rests', async () => {
        await rest({ action: 'short', hitDiceToSpend: 1 });
        let hd = pools().hit_dice;
        expect(hd).toMatchObject({ current: 1, max: 5, label: 'Hit dice', note: 'd10s' });
        expect(hd.history[0]).toMatchObject({ from: 5, to: 2, reason: 'spent on the road' });
        await rest({ action: 'long' });
        hd = pools().hit_dice;
        expect(hd).toMatchObject({ current: 3, max: 5, label: 'Hit dice', note: 'd10s' });
        expect(hd.history[0]).toMatchObject({ from: 5, to: 2 });
    });

    it('a refilled linked pool pushes its charges onto the item', async () => {
        const tokenId = json(await handleItemManage({ action: 'create', name: 'Horn of the Watch', type: 'misc', weight: 0, value: 0 }, ctx as any)).item.id;
        await handleInventoryManage({ action: 'give', characterId: 'bm', itemId: tokenId }, ctx as any);
        await char({ action: 'adjust_pool', characterId: 'bm', pool: 'horn_calls', value: 1, max: 3, refresh: 'short', linkItem: tokenId });
        const instanceId = pools().horn_calls.itemInstanceId;
        const r = await rest({ action: 'short', hitDiceToSpend: 0 });
        expect((getDb().prepare('SELECT charges FROM item_instances WHERE id = ?').get(instanceId) as any).charges).toBe(3);
        expect(r.linkedItems).toEqual([expect.objectContaining({ pool: 'horn_calls', charges: 3, max: 3 })]);
    });
});

describe('rest_manage readies per-rest abilities and legendary resistances', () => {
    it('a short rest readies perRest:short abilities only; recharge-only abilities are untouched', async () => {
        const r = await rest({ action: 'short', hitDiceToSpend: 0 });
        const byName = Object.fromEntries(sheet().abilities.map((a: any) => [a.name, a.ready]));
        expect(byName).toEqual({ 'Second Wind': true, Indomitable: false, 'Fire Breath': false });
        expect(r.refilled).toEqual(expect.arrayContaining([{ kind: 'ability', name: 'Second Wind' }]));
        expect(r.refilled.some((x: any) => x.name === 'Indomitable')).toBe(false);
        expect(r.legendaryResistancesRestored).toBeUndefined();
        expect(sheet().legendaryResistancesRemaining).toBe(1);
    });

    it('a long rest readies short and long abilities and restores legendary resistances', async () => {
        const r = await rest({ action: 'long' });
        const byName = Object.fromEntries(sheet().abilities.map((a: any) => [a.name, a.ready]));
        expect(byName).toEqual({ 'Second Wind': true, Indomitable: true, 'Fire Breath': false });
        expect(r.refilled).toEqual(expect.arrayContaining([{ kind: 'ability', name: 'Second Wind' }, { kind: 'ability', name: 'Indomitable' }]));
        expect(r.legendaryResistancesRestored).toEqual({ from: 1, to: 3 });
        expect(sheet().legendaryResistancesRemaining).toBe(3);
        expect(r.message).toMatch(/Second Wind, Indomitable ready/);
    });

    it('a rest with nothing to refill says so and lists nothing', async () => {
        await rest({ action: 'long' });
        const again = await rest({ action: 'long' });
        expect(again.refilled).toEqual([]);
        expect(again.legendaryResistancesRestored).toBeUndefined();
    });
});

describe('the in-combat guard reads the database', () => {
    const liveEncounter = (id: string, status = 'active') => {
        const tokens = [{ id: 'bm', name: 'Brannoc', hp: 10, maxHp: 44, position: { x: 0, y: 0 }, initiative: 10 }];
        getDb().prepare('INSERT INTO encounters (id, tokens, round, status, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)').run(id, JSON.stringify(tokens), status, now, now);
    };

    it('refuses while the character is a token in an active encounter row, naming it and the way out; writes nothing', async () => {
        liveEncounter('enc-live');
        getCombatManager().clear();
        for (const action of ['short', 'long']) {
            const r = await rest({ action });
            expect(r).toMatchObject({ error: true, writes: 'none' });
            expect(r.message).toMatch(/Cannot rest while in combat/);
            expect(r.message).toMatch(/enc-live/);
            expect(r.message).toMatch(/combat_manage end/);
        }
        expect(sheet().hp).toBe(10);
        expect(pools().superiority.current).toBe(1);
    });

    it('a completed or paused encounter does not block', async () => {
        liveEncounter('enc-done', 'completed');
        liveEncounter('enc-paused', 'paused');
        const r = await rest({ action: 'short', hitDiceToSpend: 0 });
        expect(r.restType).toBe('short');
        expect(pools().superiority.current).toBe(4);
    });

    it("another character's active fight is not this character's", async () => {
        getDb().prepare('INSERT INTO encounters (id, tokens, round, status, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)')
            .run('enc-other', JSON.stringify([{ id: 'someone-else', name: 'X', hp: 1, maxHp: 1 }]), 'active', now, now);
        expect((await rest({ action: 'long' })).restType).toBe('long');
    });
});
