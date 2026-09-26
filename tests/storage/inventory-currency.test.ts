/**
 * removeCurrency / hasCurrency must convert denominations. Before this fix,
 * hasCurrency accepted 20 silver as covering 1 gold, but removeCurrency
 * subtracted gold directly and refused (or, via callers that trusted
 * hasCurrency, left gold negative). Payment now makes change from higher
 * denominations and never leaves any denomination negative. Gold stays
 * decimal-to-the-cent (FINDINGS #111).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { InventoryRepository } from '../../src/storage/repos/inventory.repo.js';

let db: Database.Database;
let repo: InventoryRepository;
const ID = 'c1';

function set(c: { gold?: number; silver?: number; copper?: number }) {
    repo.setCurrency(ID, { gold: 0, silver: 0, copper: 0, ...c });
}

beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE characters (id TEXT PRIMARY KEY, currency TEXT)`);
    db.prepare(`INSERT INTO characters (id, currency) VALUES (?, NULL)`).run(ID);
    repo = new InventoryRepository(db);
});

function nonNegative() {
    const c = repo.getCurrency(ID);
    expect(c.gold).toBeGreaterThanOrEqual(0);
    expect(c.silver).toBeGreaterThanOrEqual(0);
    expect(c.copper).toBeGreaterThanOrEqual(0);
    return c;
}

describe('InventoryRepository currency conversion', () => {
    it('pays 1 gold out of 20 silver: 10 silver left, gold stays 0', () => {
        set({ silver: 20 });
        expect(repo.hasCurrency(ID, { gold: 1 })).toBe(true);
        expect(repo.removeCurrency(ID, { gold: 1 })).toBe(true);
        expect(nonNegative()).toEqual({ gold: 0, silver: 10, copper: 0 });
    });

    it('pays 1 gold out of silver and copper mixed', () => {
        set({ silver: 9, copper: 15 });
        expect(repo.removeCurrency(ID, { gold: 1 })).toBe(true);
        const c = nonNegative();
        expect(c.gold * 100 + c.silver * 10 + c.copper).toBe(5);
    });

    it('makes change from gold when paying copper', () => {
        set({ gold: 2 });
        expect(repo.removeCurrency(ID, { copper: 3 })).toBe(true);
        const c = nonNegative();
        expect(Math.round(c.gold * 100) + c.silver * 10 + c.copper).toBe(197);
    });

    it('keeps decimal gold to the cent', () => {
        set({ gold: 1.5 });
        expect(repo.removeCurrency(ID, { gold: 0.25 })).toBe(true);
        expect(nonNegative()).toEqual({ gold: 1.25, silver: 0, copper: 0 });
    });

    it('pays decimal gold from silver/copper when gold is short', () => {
        set({ gold: 0.2, silver: 5, copper: 3 });
        expect(repo.removeCurrency(ID, { gold: 0.5 })).toBe(true);
        const c = nonNegative();
        expect(Math.round(c.gold * 100) + c.silver * 10 + c.copper).toBe(23);
    });

    it('refuses when total is short and writes nothing', () => {
        set({ silver: 9, copper: 9 });
        expect(repo.hasCurrency(ID, { gold: 1 })).toBe(false);
        expect(repo.removeCurrency(ID, { gold: 1 })).toBe(false);
        expect(repo.getCurrency(ID)).toEqual({ gold: 0, silver: 9, copper: 9 });
    });

    it('exact denominations are spent as-is', () => {
        set({ gold: 50, silver: 20 });
        expect(repo.removeCurrency(ID, { gold: 30, silver: 10 })).toBe(true);
        expect(repo.getCurrency(ID)).toEqual({ gold: 20, silver: 10, copper: 0 });
    });

    it('transferCurrency gives the recipient the named amount', () => {
        db.prepare(`INSERT INTO characters (id, currency) VALUES ('c2', NULL)`).run();
        set({ silver: 20 });
        expect(repo.transferCurrency(ID, 'c2', { gold: 1 })).toBe(true);
        nonNegative();
        expect(repo.getCurrency('c2')).toEqual({ gold: 1, silver: 0, copper: 0 });
    });
});
