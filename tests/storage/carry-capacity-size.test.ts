import { getDb, closeDb } from '../../src/storage/index.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { InventoryRepository } from '../../src/storage/repos/inventory.repo.js';
import { SIZE_TABLE } from '../../src/schema/encounter.js';

// Play report: carry capacity ignored size. 5e doubles it per size step above
// Medium and halves it for Tiny; the sheet's size (set by forms and species)
// now scales STR x 15. An explicit carry_capacity pool still wins.
const now = new Date().toISOString();
const make = (id: string, str: number, extra: Record<string, unknown> = {}) =>
    new CharacterRepository(getDb()).create({ id, name: id, characterType: 'pc', stats: { str, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 10, level: 1, createdAt: now, updatedAt: now, ...extra } as any);

beforeEach(() => { closeDb(); getDb(':memory:'); });
afterEach(() => closeDb());

describe('carry capacity scales with size', () => {
    it('has a multiplier per size', () => {
        expect(Object.fromEntries(Object.entries(SIZE_TABLE).map(([k, v]) => [k, v.carryMult])))
            .toEqual({ tiny: 0.5, small: 1, medium: 1, large: 2, huge: 4, gargantuan: 8 });
    });

    it('a Huge STR 24 sheet carries 1,440 lb; unset size is medium; tiny halves', () => {
        make('luciel', 24, { size: 'huge' });
        make('plain', 24);
        make('sprite', 10, { size: 'tiny' });
        const inv = new InventoryRepository(getDb());
        expect(inv.getInventory('luciel').capacity).toBe(1440);
        expect(inv.getInventoryWithDetails('luciel').capacity).toBe(1440);
        expect(inv.getInventory('plain').capacity).toBe(360);
        expect(inv.getInventory('sprite').capacity).toBe(75);
    });

    it('an explicit carry_capacity pool still wins over size', () => {
        make('mule', 24, { size: 'huge', resourcePools: { carry_capacity: { current: 0, max: 500 } } });
        expect(new InventoryRepository(getDb()).getInventory('mule').capacity).toBe(500);
    });
});
