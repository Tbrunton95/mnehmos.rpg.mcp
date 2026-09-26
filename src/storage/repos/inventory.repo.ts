import Database from 'better-sqlite3';
import { Inventory, InventoryItem, InventorySchema } from '../../schema/inventory.js';

export class InventoryRepository {
    constructor(private db: Database.Database) { }

    getInventory(characterId: string): Inventory {
        const stmt = this.db.prepare(`
            SELECT i.*, ii.quantity, ii.equipped, ii.slot
            FROM inventory_items ii
            JOIN items i ON ii.item_id = i.id
            WHERE ii.character_id = ?
        `);

        const rows = stmt.all(characterId) as InventoryRow[];

        const items: InventoryItem[] = rows.map(row => ({
            itemId: row.id,
            quantity: row.quantity,
            equipped: Boolean(row.equipped),
            slot: row.slot || undefined
        }));

        // Get currency from characters table
        const currency = this.getCurrency(characterId);

        return InventorySchema.parse({
            characterId,
            items,
            capacity: this.carryCapacity(characterId), // #95 R1c: pool-derived, STR x 15 when absent
            currency
        });
    }

    // FINDINGS #95 (RULING R1c): capacity reads the character's carry_capacity
    // pool when present; the 5e STR x 15 rule (getCapacity) is only the
    // ABSENT-pool default. Pool max < 0 encodes the "unlimited" sentinel (0 is
    // a real state — a man who can carry nothing; null is indistinguishable
    // from unset — Tom's ruling).
    private carryCapacity(characterId: string): number | 'unlimited' {
        try {
            const row = this.db.prepare('SELECT resource_pools FROM characters WHERE id = ?').get(characterId) as { resource_pools?: string | null } | undefined;
            if (row?.resource_pools) {
                const pools = JSON.parse(row.resource_pools) as Record<string, { current?: number; max?: number }>;
                const cc = pools['carry_capacity'];
                if (cc && typeof cc.max === 'number') return cc.max < 0 ? 'unlimited' : cc.max;
            }
        } catch { /* column shape unexpected — default */ }
        return this.getCapacity(characterId);
    }

    addItem(characterId: string, itemId: string, quantity: number = 1): void {
        const stmt = this.db.prepare(`
            INSERT INTO inventory_items (character_id, item_id, quantity)
            VALUES (?, ?, ?)
            ON CONFLICT(character_id, item_id) DO UPDATE SET
            quantity = quantity + excluded.quantity
        `);
        stmt.run(characterId, itemId, quantity);
    }

    removeItem(characterId: string, itemId: string, quantity: number = 1): boolean {
        const getStmt = this.db.prepare('SELECT quantity FROM inventory_items WHERE character_id = ? AND item_id = ?');
        const row = getStmt.get(characterId, itemId) as { quantity: number } | undefined;

        if (!row || row.quantity < quantity) return false;

        if (row.quantity === quantity) {
            const delStmt = this.db.prepare('DELETE FROM inventory_items WHERE character_id = ? AND item_id = ?');
            delStmt.run(characterId, itemId);
        } else {
            const updateStmt = this.db.prepare('UPDATE inventory_items SET quantity = quantity - ? WHERE character_id = ? AND item_id = ?');
            updateStmt.run(quantity, characterId, itemId);
        }
        return true;
    }

    equipItem(characterId: string, itemId: string, slot: string): void {
        // First, unequip anything in that slot
        const unequipStmt = this.db.prepare('UPDATE inventory_items SET equipped = 0, slot = NULL WHERE character_id = ? AND slot = ?');
        unequipStmt.run(characterId, slot);

        // Then equip the new item
        const equipStmt = this.db.prepare('UPDATE inventory_items SET equipped = 1, slot = ? WHERE character_id = ? AND item_id = ?');
        equipStmt.run(slot, characterId, itemId);
    }

    unequipItem(characterId: string, itemId: string): void {
        const stmt = this.db.prepare('UPDATE inventory_items SET equipped = 0, slot = NULL WHERE character_id = ? AND item_id = ?');
        stmt.run(characterId, itemId);
    }

    /**
     * Find all characters who own a specific item (for world-unique enforcement)
     */
    findItemOwners(itemId: string): string[] {
        const stmt = this.db.prepare('SELECT character_id FROM inventory_items WHERE item_id = ?');
        const rows = stmt.all(itemId) as { character_id: string }[];
        return rows.map(r => r.character_id);
    }

    transferItem(fromCharacterId: string, toCharacterId: string, itemId: string, quantity: number = 1): boolean {
        // Verify source has enough
        const getStmt = this.db.prepare('SELECT quantity, equipped FROM inventory_items WHERE character_id = ? AND item_id = ?');
        const row = getStmt.get(fromCharacterId, itemId) as { quantity: number; equipped: number } | undefined;

        if (!row || row.quantity < quantity) return false;

        // Can't transfer equipped items
        if (row.equipped) return false;

        // Use transaction for atomicity
        const transfer = this.db.transaction(() => {
            // Remove from source
            if (row.quantity === quantity) {
                const delStmt = this.db.prepare('DELETE FROM inventory_items WHERE character_id = ? AND item_id = ?');
                delStmt.run(fromCharacterId, itemId);
            } else {
                const updateStmt = this.db.prepare('UPDATE inventory_items SET quantity = quantity - ? WHERE character_id = ? AND item_id = ?');
                updateStmt.run(quantity, fromCharacterId, itemId);
            }

            // Add to destination
            const addStmt = this.db.prepare(`
                INSERT INTO inventory_items (character_id, item_id, quantity)
                VALUES (?, ?, ?)
                ON CONFLICT(character_id, item_id) DO UPDATE SET
                quantity = quantity + excluded.quantity
            `);
            addStmt.run(toCharacterId, itemId, quantity);
        });

        transfer();
        return true;
    }

    getInventoryWithDetails(characterId: string): InventoryWithItems {
        const stmt = this.db.prepare(`
            SELECT i.*, ii.quantity, ii.equipped, ii.slot
            FROM inventory_items ii
            JOIN items i ON ii.item_id = i.id
            WHERE ii.character_id = ?
            ORDER BY ii.equipped DESC, i.type, i.name
        `);

        const rows = stmt.all(characterId) as InventoryRowFull[];

        const items = rows.map(row => ({
            item: {
                id: row.id,
                name: row.name,
                description: row.description || undefined,
                type: row.type as 'weapon' | 'armor' | 'consumable' | 'quest' | 'misc',
                weight: row.weight,
                value: row.value,
                properties: row.properties ? JSON.parse(row.properties) : undefined
            },
            quantity: row.quantity,
            equipped: Boolean(row.equipped),
            slot: row.slot || undefined
        }));

        const totalWeight = items.reduce((sum, i) => sum + (i.item.weight * i.quantity), 0);

        const currency = this.getCurrency(characterId);

        return {
            characterId,
            items,
            totalWeight,
            capacity: this.carryCapacity(characterId), // #95 R1c
            currency
        };
    }

    /** D&D 5e carrying capacity: Strength score multiplied by 15 pounds. */
    private getCapacity(characterId: string): number {
        const row = this.db.prepare('SELECT stats FROM characters WHERE id = ?').get(characterId) as { stats: string } | undefined;
        if (!row?.stats) return 0;

        try {
            const stats = JSON.parse(row.stats) as { str?: number };
            return Math.max(0, Math.trunc(stats.str ?? 0) * 15);
        } catch {
            return 0;
        }
    }

    // ============================================================
    // CURRENCY OPERATIONS
    // ============================================================

    /**
     * Get currency for a character
     */
    getCurrency(characterId: string): { gold: number; silver: number; copper: number } {
        const stmt = this.db.prepare('SELECT currency FROM characters WHERE id = ?');
        const row = stmt.get(characterId) as { currency: string | null } | undefined;

        if (!row || !row.currency) {
            return { gold: 0, silver: 0, copper: 0 };
        }

        try {
            const parsed = JSON.parse(row.currency);
            return {
                gold: parsed.gold ?? 0,
                silver: parsed.silver ?? 0,
                copper: parsed.copper ?? 0
            };
        } catch {
            return { gold: 0, silver: 0, copper: 0 };
        }
    }

    /**
     * Set currency for a character (replaces existing)
     */
    setCurrency(characterId: string, currency: { gold?: number; silver?: number; copper?: number }): void {
        const current = this.getCurrency(characterId);
        const updated = {
            gold: currency.gold ?? current.gold,
            silver: currency.silver ?? current.silver,
            copper: currency.copper ?? current.copper
        };

        const stmt = this.db.prepare('UPDATE characters SET currency = ? WHERE id = ?');
        stmt.run(JSON.stringify(updated), characterId);
    }

    /**
     * Add currency to a character
     */
    addCurrency(characterId: string, currency: { gold?: number; silver?: number; copper?: number }): { gold: number; silver: number; copper: number } {
        const current = this.getCurrency(characterId);
        const updated = {
            gold: current.gold + (currency.gold ?? 0),
            silver: current.silver + (currency.silver ?? 0),
            copper: current.copper + (currency.copper ?? 0)
        };

        const stmt = this.db.prepare('UPDATE characters SET currency = ? WHERE id = ?');
        stmt.run(JSON.stringify(updated), characterId);

        return updated;
    }

    /**
     * Remove currency from a character, converting denominations.
     * 1 gold = 10 silver = 100 copper; gold is decimal to the cent (FINDINGS #111),
     * so all arithmetic runs on integer copper units. Each named denomination is paid
     * from itself first; any shortfall is paid from leftover copper, then silver, then
     * gold, with change returned in silver/copper. No denomination ever goes negative.
     * @returns true if successful, false if insufficient funds (nothing written)
     */
    removeCurrency(characterId: string, currency: { gold?: number; silver?: number; copper?: number }): boolean {
        const current = this.getCurrency(characterId);
        const have = toCopperUnits(current);
        const need = toCopperUnits({ gold: currency.gold ?? 0, silver: currency.silver ?? 0, copper: currency.copper ?? 0 });
        if (need.gold < 0 || need.silver < 0 || need.copper < 0) return false;
        if (need.gold + need.silver + need.copper > have.gold + have.silver + have.copper) {
            return false;
        }

        // 1. Pay each named denomination from itself.
        let g = have.gold, s = have.silver, c = have.copper;
        const payG = Math.min(g, need.gold); g -= payG;
        const payS = Math.min(s, need.silver); s -= payS;
        const payC = Math.min(c, need.copper); c -= payC;
        let owed = (need.gold - payG) + (need.silver - payS) + (need.copper - payC);

        // 2. Shortfall from leftover copper, then silver, then gold (making change).
        if (owed > 0) {
            const take = Math.min(c, owed); c -= take; owed -= take;
        }
        if (owed > 0 && s > 0) {
            const coins = Math.min(s / 10, Math.ceil(owed / 10));
            const value = Math.round(coins * 10);
            s -= value;
            if (value > owed) { c += value - owed; owed = 0; } else owed -= value;
        }
        if (owed > 0 && g > 0) {
            // Break whole gold pieces where possible; decimal gold is spent as-is.
            const value = Math.min(g, Math.ceil(owed / 100) * 100);
            g -= value;
            if (value > owed) {
                const change = value - owed;
                s += Math.floor(change / 10) * 10;
                c += change % 10;
                owed = 0;
            } else owed -= value;
        }
        if (owed > 0 || g < 0 || s < 0 || c < 0) return false; // unreachable given the total check

        const updated = fromCopperUnits({ gold: g, silver: s, copper: c });
        const stmt = this.db.prepare('UPDATE characters SET currency = ? WHERE id = ?');
        stmt.run(JSON.stringify(updated), characterId);

        return true;
    }

    /**
     * Transfer currency between characters
     * @returns true if successful, false if insufficient funds
     */
    transferCurrency(fromCharacterId: string, toCharacterId: string, currency: { gold?: number; silver?: number; copper?: number }): boolean {
        const transfer = this.db.transaction(() => {
            if (!this.removeCurrency(fromCharacterId, currency)) {
                return false;
            }
            this.addCurrency(toCharacterId, currency);
            return true;
        });

        return transfer();
    }

    /**
     * Check if character has at least this much currency
     */
    hasCurrency(characterId: string, currency: { gold?: number; silver?: number; copper?: number }): boolean {
        const have = toCopperUnits(this.getCurrency(characterId));
        const need = toCopperUnits({ gold: currency.gold ?? 0, silver: currency.silver ?? 0, copper: currency.copper ?? 0 });
        return have.gold + have.silver + have.copper >= need.gold + need.silver + need.copper;
    }
}

/** Each denomination expressed in integer copper (gold to the cent). */
function toCopperUnits(c: { gold: number; silver: number; copper: number }): { gold: number; silver: number; copper: number } {
    return { gold: Math.round(c.gold * 100), silver: Math.round(c.silver * 10), copper: Math.round(c.copper) };
}

function fromCopperUnits(c: { gold: number; silver: number; copper: number }): { gold: number; silver: number; copper: number } {
    return { gold: Math.round(c.gold) / 100, silver: Math.round(c.silver) / 10, copper: c.copper };
}

interface InventoryRowFull {
    id: string;
    name: string;
    description: string | null;
    type: string;
    weight: number;
    value: number;
    properties: string | null;
    quantity: number;
    equipped: number;
    slot: string | null;
}

interface InventoryWithItems {
    characterId: string;
    items: Array<{
        item: {
            id: string;
            name: string;
            description?: string;
            type: 'weapon' | 'armor' | 'consumable' | 'quest' | 'misc';
            weight: number;
            value: number;
            properties?: Record<string, any>;
        };
        quantity: number;
        equipped: boolean;
        slot?: string;
    }>;
        totalWeight: number;
    capacity: number | 'unlimited';
    currency: { gold: number; silver: number; copper: number };
}

interface InventoryRow {
    id: string;
    name: string;
    type: string;
    weight: number;
    value: number;
    quantity: number;
    equipped: number;
    slot: string | null;
}
