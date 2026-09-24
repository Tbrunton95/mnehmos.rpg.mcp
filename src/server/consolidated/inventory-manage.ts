/**
 * Consolidated Inventory Management Tool
 * Replaces 9 separate tools: give_item, remove_item, transfer_item, use_item, extinguish_light, equip_item, unequip_item, get_inventory, get_inventory_detailed
 */

import { z } from 'zod';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { ItemRepository } from '../../storage/repos/item.repo.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../storage/repos/custom-effects.repo.js';
import { journalSnapshot } from '../utils/write-journal.js';
import { INVENTORY_LIMITS } from '../../schema/inventory.js';
import { getDomainServices } from '../domain-services.js';
import { getDb } from '../../storage/index.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import * as pda from '../../render/pda.js';
import { getLightSourceProfile } from '../../services/light-source.service.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['give', 'remove', 'transfer', 'use', 'extinguish', 'equip', 'unequip', 'get', 'get_detailed', 'add_currency', 'attach', 'detach', 'adjust_condition', 'adjust_charges', 'coat', 'uncoat'] as const;
type InventoryAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb() {
    const services = getDomainServices();
    const db = services.db;
    // FINDINGS #86: charge columns on instances — guarded ALTERs, run once.
    try { db.exec('ALTER TABLE item_instances ADD COLUMN charges INTEGER'); } catch { /* column exists */ }
    try { db.exec('ALTER TABLE item_instances ADD COLUMN charges_max INTEGER'); } catch { /* column exists */ }
    return {
        db,
        itemRepo: services.item,
        inventoryRepo: services.inventory,
        charRepo: services.character,
        effectsRepo: new CustomEffectsRepository(db),
    };
}

/**
 * Rebuild AC from the character's currently equipped armor instead of
 * incrementally adding/subtracting bonuses. Older starter items persisted
 * their armor base as `ac`; newer/authored items may use `baseAC`.
 */
function allowedEquipSlots(item: {
    type: string;
    properties?: Record<string, unknown>;
}): string[] {
    const properties = item.properties ?? {};
    if (properties.requiresSelection === true) return [];

    if (Array.isArray(properties.equipSlots)) {
        return properties.equipSlots.filter((slot): slot is string => typeof slot === 'string');
    }

    if (item.type === 'weapon') return ['mainhand', 'offhand'];
    if (item.type === 'armor') {
        return typeof properties.acBonus === 'number' ? ['offhand'] : ['armor'];
    }
    return [];
}

function rollHealing(value: unknown): { amount: number; notation?: string; rolls?: number[] } | null {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return { amount: Math.floor(value) };
    }

    const text = String(value);
    const match = text.match(/(\d+)\s*d\s*(\d+)(?:\s*([+-])\s*(\d+))?/i);
    if (match) {
        const count = Number(match[1]);
        const sides = Number(match[2]);
        const modifier = match[4] ? Number(match[4]) * (match[3] === '-' ? -1 : 1) : 0;
        const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
        return {
            amount: Math.max(0, rolls.reduce((sum, roll) => sum + roll, modifier)),
            notation: `${count}d${sides}${modifier ? (modifier > 0 ? `+${modifier}` : modifier) : ''}`,
            rolls
        };
    }

    const numeric = Number(text.trim());
    if (Number.isFinite(numeric) && numeric >= 0) return { amount: Math.floor(numeric) };
    throw new Error(`Invalid healing value: ${text}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const GiveSchema = z.object({
    action: z.literal('give'),
    characterId: z.string().describe('Character receiving the item'),
    itemId: z.string().describe('Item to give'),
    quantity: z.number().int().min(1).default(1).describe('Quantity to give')
});

const RemoveSchema = z.object({
    action: z.literal('remove'),
    characterId: z.string().describe('Character losing the item'),
    itemId: z.string().describe('Item to remove'),
    quantity: z.number().int().min(1).default(1).describe('Quantity to remove')
});

const TransferSchema = z.object({
    action: z.literal('transfer'),
    fromCharacterId: z.string().describe('Character giving the item'),
    toCharacterId: z.string().describe('Character receiving the item'),
    itemId: z.string().describe('The item to transfer'),
    quantity: z.number().int().min(1).default(1).describe('How many to transfer')
});

const UseSchema = z.object({
    action: z.literal('use'),
    characterId: z.string().describe('Character using the item'),
    itemId: z.string().describe('The consumable item to use'),
    targetId: z.string().optional().describe('Optional target character for the effect')
});

const ExtinguishSchema = z.object({
    action: z.literal('extinguish'),
    characterId: z.string().describe('Character carrying or benefiting from the light source'),
    itemId: z.string().describe('The light-source item to extinguish')
});

const EquipSchema = z.object({
    action: z.literal('equip'),
    characterId: z.string().describe('Character equipping the item'),
    itemId: z.string().describe('Item to equip'),
    slot: z.enum(['mainhand', 'offhand', 'armor', 'head', 'feet', 'accessory', 'accessory2', 'accessory3']).describe('Equipment slot — #96: three accessory slots (medallion + rings; detector + patch + dosimeter)')
});

const UnequipSchema = z.object({
    action: z.literal('unequip'),
    characterId: z.string().describe('Character unequipping the item'),
    itemId: z.string().optional().describe('Item to unequip (or pass slot alone — FINDINGS #34 T3)'),
    slot: z.enum(['mainhand', 'offhand', 'armor', 'head', 'feet', 'accessory', 'accessory2', 'accessory3']).optional().describe('Unequip whatever occupies this slot')
});

const GetSchema = z.object({
    action: z.literal('get'),
    characterId: z.string().describe('Character whose inventory to retrieve')
});

const AddCurrencySchema = z.object({
    action: z.literal('add_currency'),
    characterId: z.string().describe('Character ID'),
    amount: z.number().describe('Currency delta: positive credits, negative debits, DECIMALS ACCEPTED (#111 — 1945 runs on cents; stored to two places). Balance can never go below 0.'),
    reason: z.string().optional().describe('What this payment is for (loot, fence sale, quest reward, toll...)')
});

const GetDetailedSchema = z.object({
    action: z.literal('get_detailed'),
    characterId: z.string().describe('Character whose inventory to retrieve')
});

const AttachSchema = z.object({
    action: z.literal('attach'),
    characterId: z.string().describe('Owner of both the weapon and the loose attachment'),
    itemId: z.string().describe('Weapon TEMPLATE id (an instance is created lazily on first attach) or an existing instance id'),
    attachmentItemId: z.string().describe('Attachment TEMPLATE id — must be in the character inventory; consumed into the instance on success')
});

const DetachSchema = z.object({
    action: z.literal('detach'),
    characterId: z.string().describe('Owner of the instance'),
    itemId: z.string().optional().describe('Weapon TEMPLATE id or instance id — resolved the same way attach resolves it (FINDINGS #59: the #57 spec, honored)'),
    instanceId: z.string().optional().describe('Weapon instance id (explicit alternative to itemId)'),
    slotType: z.string().describe('Slot to clear: optic | muzzle | underbarrel | mag | side — the part returns to loose inventory')
});

// ─── FINDINGS #60: instance condition writes — the technician bench and
// degradation land on the SPECIFIC item, not the template. First condition
// write births the instance (documented since #57); the pool-pattern
// per-weapon condition retires gun-by-gun as this takes over.
// FINDINGS #86: DE-WEAPONED — the machinery never gated on item type
// (resolveInstance checks ownership only), but every description said
// "weapon", so a disciplined chair refused to bench a knife. Condition is
// a lane for ANY owned item: knives, toolkits, detectors, lamps, suits.
const AdjustConditionSchema = z.object({
    action: z.literal('adjust_condition'),
    characterId: z.string().describe('Owner of the item'),
    itemId: z.string().optional().describe('Item TEMPLATE id or instance id — any owned item (weapon, knife, toolkit, detector, lamp); resolved like attach/detach'),
    instanceId: z.string().optional().describe('Item instance id (explicit alternative to itemId)'),
    delta: z.number().optional().describe('Relative change — degradation (−1 firefight / −3 rain / −5 jam per 01 §7, or fiction-priced wear) or repair (+10 per technician tier price)'),
    value: z.number().optional().describe('Absolute set (overrides delta)'),
    max: z.number().optional().describe('Clamp ceiling — pass the toolkit ceiling (basic 70 / advanced 90 / expert 100); default 100')
});

// ─── FINDINGS #86: charge state — batteries, filters, film, lighter fuel.
// Same instance lane as condition (first write births the instance), but a
// separate column: a lamp at condition 90 with 0 battery hours is a working
// lamp with no light, and the difference decides scenes. NULL = the item
// has no charge lane. charges_max is intrinsic capacity, stored when passed.
// FINDINGS #96 (COATINGS — the #58 shape, different noun): oils, poisons and
// blade-toxins are one primitive — a charged consumable bound to a WEAPON
// INSTANCE, decrementing one charge per application, carrying its bonus and
// remaining hits on the instance. combat_action reads instance.attachments
// ._coating and surfaces it as a declaredModifier in the breakdown; each
// resolved hit debits remainingHits via 'uncoat' or the combat lane.
const CoatSchema = z.object({
    action: z.literal('coat'),
    characterId: z.string().describe('Owner of both weapon and coating'),
    itemId: z.string().optional().describe('Weapon TEMPLATE id or instance id — resolved like adjust_condition'),
    instanceId: z.string().optional().describe('Weapon instance id (explicit alternative)'),
    coatingItemId: z.string().describe('The oil/poison/toxin item — template properties may carry {coatingBonus, coatingLabel, coatingHits, appliesTo}'),
    hits: z.number().int().min(1).optional().describe('Hits this application lasts (default: template coatingHits, else 5)')
});
const UncoatSchema = z.object({
    action: z.literal('uncoat'),
    characterId: z.string().describe('Owner of the weapon'),
    itemId: z.string().optional().describe('Weapon TEMPLATE id or instance id'),
    instanceId: z.string().optional().describe('Weapon instance id (explicit alternative)'),
    spendHit: z.boolean().optional().describe('true = debit ONE hit (the combat lane) instead of wiping; wipes automatically at 0')
});

const AdjustChargesSchema = z.object({
    action: z.literal('adjust_charges'),
    characterId: z.string().describe('Owner of the item'),
    itemId: z.string().optional().describe('Item TEMPLATE id or instance id — resolved like adjust_condition'),
    instanceId: z.string().optional().describe('Item instance id (explicit alternative to itemId)'),
    delta: z.number().optional().describe('Relative change — hours burned, exposures taken, filter spent'),
    value: z.number().optional().describe('Absolute set (overrides delta; REQUIRED on first write if the template carries no numeric charges/batteryHours/uses property to baseline from)'),
    max: z.number().optional().describe('Intrinsic capacity — stored on the instance as charges_max when passed; clamp ceiling thereafter')
});

// ─── FINDINGS #57: per-instance item state ───
// A specific gun: its own condition, its own mounted parts. Created lazily —
// the first attach (or future condition-write) births the instance; until
// then the template row is the item, exactly as before.
type ItemInstance = { id: string; template_id: string; owner_character_id: string | null; condition: number | null; attachments: string; custom_name: string | null };

// FINDINGS #59: resolve NEVER writes. The old findOrCreateInstance minted the
// instance BEFORE the gates ran — a refused attach (wrong caliber, missing
// part, occupied slot) left a row behind. Same law as #58's magazine: a
// refused action writes nothing. Resolution and minting are now two verbs.
function resolveInstance(db: ReturnType<typeof getDb>, characterId: string, templateOrInstanceId: string): { instance: ItemInstance | null; templateId: string } | { error: string } {
    const asInstance = db.prepare('SELECT * FROM item_instances WHERE id = ?').get(templateOrInstanceId) as ItemInstance | undefined;
    if (asInstance) {
        if (asInstance.owner_character_id !== characterId) return { error: `Instance ${templateOrInstanceId} is not owned by ${characterId}` };
        return { instance: asInstance, templateId: asInstance.template_id };
    }
    // Template path: the character must own the item
    const owned = db.prepare('SELECT quantity FROM inventory_items WHERE character_id = ? AND item_id = ?').get(characterId, templateOrInstanceId) as { quantity: number } | undefined;
    if (!owned || owned.quantity < 1) return { error: 'Character does not own that item (pass the item template id from their inventory, or an instance id)' };
    // Reuse an existing instance of this template for this owner before minting another
    const existing = db.prepare('SELECT * FROM item_instances WHERE owner_character_id = ? AND template_id = ?').get(characterId, templateOrInstanceId) as ItemInstance | undefined;
    return { instance: existing ?? null, templateId: templateOrInstanceId };
}

function mintInstance(db: ReturnType<typeof getDb>, characterId: string, templateId: string): ItemInstance {
    const tpl = db.prepare('SELECT properties FROM items WHERE id = ?').get(templateId) as { properties?: string } | undefined;
    const tplProps = tpl?.properties ? JSON.parse(tpl.properties) : {};
    const now = new Date().toISOString();
    const id = `inst-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    db.prepare('INSERT INTO item_instances (id, template_id, owner_character_id, condition, attachments, custom_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, templateId, characterId, typeof tplProps.condition === 'number' ? tplProps.condition : null, '{}', null, now, now);
    return db.prepare('SELECT * FROM item_instances WHERE id = ?').get(id) as ItemInstance;
}

function attachGateCheck(gunProps: Record<string, unknown>, attProps: Record<string, unknown>): string | null {
    // FINDINGS #96 (BUG 1+2+GAP 3 in one): the gate read ONLY attachmentSlots
    // as an array — a template declaring slots:{side:null, muzzle:null} (object,
    // different key) was invisible, whatever the instance said, however the
    // template was updated. Resolve generously: attachmentSlots OR slots,
    // array OR object-keys. And the slot vocabulary is thereby FREE — a sword
    // declaring slots:{blade:null, pommel:null} validates blade-oil runes the
    // same as a rifle validates optics. The weapon's own declaration is the enum.
    const rawSlots = gunProps.attachmentSlots ?? gunProps.slots;
    const slots = Array.isArray(rawSlots)
        ? rawSlots.map(String)
        : (rawSlots && typeof rawSlots === 'object') ? Object.keys(rawSlots as Record<string, unknown>) : [];
    const slotType = attProps.slotType as string | undefined;
    if (!slotType) return 'Attachment has no slotType property — not mountable hardware';
    if (!slots.includes(slotType)) return `Weapon has no ${slotType} slot (slots: ${slots.join(', ') || 'none'} — declared via properties.attachmentSlots[] or properties.slots{})`;
    const attachFor = String(attProps.attachFor ?? 'any').toLowerCase();
    if (attachFor !== 'any' && attachFor !== 'rifle') {
        const ammo = String(gunProps.ammoType ?? '').toLowerCase();
        // #96: a weapon with NO ammoType is melee — there is no caliber to
        // mismatch; the slot declaration already gated fitment. Skip.
        if (ammo && !attachFor.split('/').some(cal => ammo.includes(cal.trim()))) {
            return `Caliber gate refused: attachment fits ${attProps.attachFor}, weapon is ${gunProps.ammoType}`;
        }
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

// FINDINGS #69: ONE armor-class derivation, used by equip AND unequip. The old
// per-path arithmetic ignored the head slot (Sphere-08's +1 vanished on every
// re-equip) and the unequip path could write AC while reporting acChange: null.
// Derivation: armor-slot baseAC + min(DEX, maxDexBonus), else unarmored
// 10 + DEX; PLUS every other equipped item's acBonus (head, accessory).
function deriveArmorClass(
    db: ReturnType<typeof getDb>,
    characterId: string
): { ac: number; parts: string[] } {
    const charRepo = new CharacterRepository(db);
    const itemRepo = new ItemRepository(db);
    const character = charRepo.findById(characterId);
    const dexMod = Math.floor((((character?.stats as { dex?: number })?.dex ?? 10) - 10) / 2);
    let base = 10 + dexMod;
    let baseDesc = `unarmored 10 + DEX ${dexMod >= 0 ? '+' : ''}${dexMod}`;
    let bonus = 0;
    const bonusParts: string[] = [];
    const rows = db.prepare('SELECT item_id, slot FROM inventory_items WHERE character_id = ? AND equipped = 1').all(characterId) as Array<{ item_id: string; slot: string | null }>;
    for (const row of rows) {
        const t = itemRepo.findById(row.item_id);
        const p = (t?.properties ?? {}) as { baseAC?: number; ac?: number; maxDexBonus?: number; strengthRequired?: number; acBonus?: number };
        // Legacy starter armor carries `ac` instead of `baseAC`.
        const armorBase = typeof p.baseAC === 'number' ? p.baseAC : typeof p.ac === 'number' ? p.ac : null;
        if (row.slot === 'armor' && armorBase !== null) {
            // Legacy heavy armor has no maxDexBonus but carries a Strength
            // requirement; heavy armor never adds Dexterity.
            const maxDex = typeof p.maxDexBonus === 'number' ? p.maxDexBonus
                : typeof p.strengthRequired === 'number' ? 0 : 99;
            // Worn armor replaces the unarmored base (5e), even when lower.
            base = armorBase + (maxDex > 0 ? Math.min(dexMod, maxDex) : 0);
            baseDesc = `${t?.name ?? 'armor'} base ${armorBase}${maxDex === 0 ? ' (no DEX)' : maxDex < 99 ? ` + DEX(max ${maxDex})` : ' + DEX'}`;
        }
        // acBonus stacks from every equipped item, magic armor included.
        if (typeof p.acBonus === 'number' && p.acBonus !== 0) {
            bonus += p.acBonus;
            bonusParts.push(`${t?.name ?? row.item_id} ${p.acBonus >= 0 ? '+' : ''}${p.acBonus}`);
        }
    }
    return { ac: base + bonus, parts: [baseDesc, ...bonusParts] };
}

const definitions: Record<InventoryAction, ActionDefinition> = {
    give: {
        schema: GiveSchema,
        handler: async (params: z.infer<typeof GiveSchema>) => {
            const { inventoryRepo, itemRepo } = ensureDb();

            // Validate quantity limits
            if (params.quantity > INVENTORY_LIMITS.MAX_GIVE_QUANTITY) {
                throw new Error(`Cannot give more than ${INVENTORY_LIMITS.MAX_GIVE_QUANTITY} items at once. Requested: ${params.quantity}`);
            }

            // Get item details for validation
            const item = itemRepo.findById(params.itemId);
            if (!item) {
                throw new Error(`Item not found: ${params.itemId}`);
            }

            // Check unique item constraints
            const properties = item.properties || {};
            const isUnique = properties.unique === true;
            const isWorldUnique = properties.worldUnique === true;

            if (isUnique || isWorldUnique) {
                if (params.quantity > 1) {
                    throw new Error(`Cannot give more than 1 of unique item "${item.name}"`);
                }

                const inventory = inventoryRepo.getInventory(params.characterId);
                const existingItem = inventory.items.find((i: { itemId: string }) => i.itemId === params.itemId);
                if (existingItem) {
                    throw new Error(`Character already owns unique item "${item.name}". Unique items cannot stack.`);
                }

                if (isWorldUnique) {
                    const allOwners = inventoryRepo.findItemOwners(params.itemId);
                    if (allOwners.length > 0) {
                        throw new Error(`World-unique item "${item.name}" is already owned by another character.`);
                    }
                }
            }

            // Check weight capacity — #95 R1c: 'unlimited' sentinel skips the wall
            const currentInventory = inventoryRepo.getInventoryWithDetails(params.characterId);
            const addedWeight = item.weight * params.quantity;
            const newTotalWeight = currentInventory.totalWeight + addedWeight;

            if (currentInventory.capacity !== 'unlimited' && newTotalWeight > Number(currentInventory.capacity)) {
                throw new Error(
                    `Cannot add items: would exceed weight capacity. ` +
                    `Current: ${currentInventory.totalWeight.toFixed(1)}/${currentInventory.capacity}, ` +
                    `Adding: ${addedWeight.toFixed(1)}`
                );
            }

            // Check stack size limits
            const existingItem = currentInventory.items.find((i: { item: { id: string } }) => i.item.id === params.itemId);
            const existingQuantity = existingItem?.quantity || 0;
            const newTotal = existingQuantity + params.quantity;

            if (newTotal > INVENTORY_LIMITS.MAX_STACK_SIZE) {
                throw new Error(
                    `Cannot add items: would exceed max stack size of ${INVENTORY_LIMITS.MAX_STACK_SIZE}. ` +
                    `Current: ${existingQuantity}, Adding: ${params.quantity}`
                );
            }

            inventoryRepo.addItem(params.characterId, params.itemId, params.quantity);

            return {
                success: true,
                actionType: 'give',
                itemName: item.name,
                quantity: params.quantity,
                characterId: params.characterId,
                message: `Added ${params.quantity}x ${item.name} to inventory`
            };
        },
        aliases: ['add', 'grant', 'award']
    },

    add_currency: {
        schema: AddCurrencySchema,
        handler: async (params: z.infer<typeof AddCurrencySchema>) => {
            const { inventoryRepo } = ensureDb();
            // FINDINGS #111: money is decimal. The chair carried a nickel coffee and
            // a quarter scopa hand in his head for 101 days because the schema said
            // int. Round to cents at the write; the repo stores a float in JSON.
            const amount = Math.round(params.amount * 100) / 100;
            const current = inventoryRepo.getCurrency(params.characterId);
            if (amount < 0 && Math.round((current.gold + amount) * 100) / 100 < 0) {
                throw new Error(`Insufficient funds: ${current.gold} available, attempted to deduct ${-amount}`);
            }
            const updated = inventoryRepo.addCurrency(params.characterId, { gold: amount });
            updated.gold = Math.round(updated.gold * 100) / 100;
            return {
                success: true,
                actionType: 'add_currency',
                characterId: params.characterId,
                delta: amount,
                balance: updated.gold,
                reason: params.reason,
                message: `${amount >= 0 ? 'Credited' : 'Debited'} ${Math.abs(amount)}${params.reason ? ` (${params.reason})` : ''} — balance ${updated.gold}`
            };
        },
        aliases: ['credit', 'debit', 'pay', 'currency']
    },

    remove: {
        schema: RemoveSchema,
        handler: async (params: z.infer<typeof RemoveSchema>) => {
            const { db, inventoryRepo, itemRepo } = ensureDb();

            const item = itemRepo.findById(params.itemId);
            const success = inventoryRepo.removeItem(params.characterId, params.itemId, params.quantity);

            if (success) {
                // FINDINGS #83: the OTHER direction of #69 — a successful stack
                // remove left built instances alive (the GM's ghost guns: an
                // AK-74M with a mounted suppressor surviving its own sale). If
                // the stack row is now GONE, the built instance of that template
                // goes with it and the report names what went; if stock remains,
                // the build stays — you sold the spare, not your gun.
                const gone: Array<{ instanceId: string; name: string; condition: number | null; mounted: Record<string, string> }> = [];
                try {
                    const remaining = db.prepare('SELECT quantity FROM inventory_items WHERE character_id = ? AND item_id = ?').get(params.characterId, params.itemId) as { quantity: number } | undefined;
                    if (!remaining) {
                        const insts = db.prepare('SELECT * FROM item_instances WHERE owner_character_id = ? AND template_id = ?').all(params.characterId, params.itemId) as ItemInstance[];
                        for (const inst of insts) {
                            db.prepare('DELETE FROM item_instances WHERE id = ?').run(inst.id);
                            let mounted: Record<string, string> = {};
                            try { mounted = JSON.parse(inst.attachments || '{}'); } catch { /* unreadable build map — reported empty */ }
                            gone.push({ instanceId: inst.id, name: inst.custom_name ?? item?.name ?? inst.template_id, condition: inst.condition, mounted });
                        }
                    }
                } catch { /* instances table absent — nothing to cascade */ }
                return {
                    success: true,
                    actionType: 'remove',
                    itemName: item?.name || params.itemId,
                    quantity: params.quantity,
                    characterId: params.characterId,
                    ...(gone.length ? { instancesRemoved: gone } : {}),
                    message: `Removed ${params.quantity}x ${item?.name || params.itemId} from inventory${gone.length ? ` — stack emptied, built instance${gone.length === 1 ? '' : 's'} went with it: ${gone.map(g => `${g.name} (cond ${g.condition ?? '—'}${Object.keys(g.mounted).length ? `, mounted: ${Object.entries(g.mounted).map(([s, n]) => `${s}: ${n}`).join(', ')}` : ''})`).join('; ')}` : ''}`
                };
            }

            {
                // FINDINGS #69: built guns live in item_instances with no stack
                // row — remove falls through. Accepts instance id OR template id.
                // Deleting the instance destroys the build WITH it (a sold gun
                // sells its glass); the result names what went with it.
                const inst = db.prepare('SELECT * FROM item_instances WHERE owner_character_id = ? AND (id = ? OR template_id = ?)').get(params.characterId, params.itemId, params.itemId) as ItemInstance | undefined;
                if (inst) {
                    db.prepare('DELETE FROM item_instances WHERE id = ?').run(inst.id);
                    let mounted: Record<string, string> = {};
                    try { mounted = JSON.parse(inst.attachments || '{}'); } catch { /* unreadable build map — reported empty */ }
                    const tmpl = itemRepo.findById(inst.template_id);
                    return {
                        success: true,
                        actionType: 'remove',
                        removedInstance: true,
                        instanceId: inst.id,
                        itemName: inst.custom_name ?? tmpl?.name ?? inst.template_id,
                        condition: inst.condition,
                        mountedLost: mounted,
                        quantity: 1,
                        characterId: params.characterId,
                        message: `Removed built instance ${inst.custom_name ?? tmpl?.name ?? inst.template_id} (cond ${inst.condition ?? '—'})${Object.keys(mounted).length ? ` — mounted parts went with it: ${Object.entries(mounted).map(([s, n]) => `${s}: ${n}`).join(', ')}` : ''}`
                    };
                }
                throw new Error(`Failed to remove item. No stack row with enough quantity, and no built instance of it either.`);
            }
        },
        aliases: ['take', 'subtract', 'drop']
    },

    transfer: {
        schema: TransferSchema,
        handler: async (params: z.infer<typeof TransferSchema>) => {
            const { db, inventoryRepo, itemRepo } = ensureDb();

            const item = itemRepo.findById(params.itemId);
            if (!item) {
                throw new Error(`Item not found: ${params.itemId}`);
            }

            const success = inventoryRepo.transferItem(
                params.fromCharacterId,
                params.toCharacterId,
                params.itemId,
                params.quantity
            );

            if (!success) {
                throw new Error(`Transfer failed. Source may not have enough quantity or item is equipped.`);
            }

            // FINDINGS #57: a traded gun carries its wear and its glass —
            // the instance row (condition + attachments) moves with the item.
            try {
                db.prepare('UPDATE item_instances SET owner_character_id = ?, updated_at = ? WHERE owner_character_id = ? AND template_id = ?')
                    .run(params.toCharacterId, new Date().toISOString(), params.fromCharacterId, params.itemId);
            } catch (instErr) {
                // Reported, never silent (#40 doctrine)
                console.error(`[inventory] instance transfer failed: ${(instErr as Error).message}`);
            }

            return {
                success: true,
                actionType: 'transfer',
                itemName: item.name,
                quantity: params.quantity,
                fromCharacterId: params.fromCharacterId,
                toCharacterId: params.toCharacterId,
                message: `Transferred ${params.quantity}x ${item.name}`
            };
        },
        aliases: ['trade', 'move', 'pass']
    },

    use: {
        schema: UseSchema,
        handler: async (params: z.infer<typeof UseSchema>) => {
            const { db, inventoryRepo, itemRepo, charRepo, effectsRepo } = ensureDb();

            const item = itemRepo.findById(params.itemId);
            if (!item) {
                throw new Error(`Item not found: ${params.itemId}`);
            }

            const lightSource = getLightSourceProfile(item);
            if (item.type !== 'consumable' && !lightSource) {
                throw new Error(`Item "${item.name}" is not a consumable or recognized light source (type: ${item.type})`);
            }

            const inventory = inventoryRepo.getInventory(params.characterId);
            const hasItem = inventory.items.some((i: { itemId: string; quantity: number }) =>
                i.itemId === params.itemId && i.quantity > 0
            );
            if (!hasItem) {
                throw new Error(`Character does not have item "${item.name}"`);
            }

            if (lightSource) {
                const properties = item.properties ?? {};
                const open5e = properties.open5e && typeof properties.open5e === 'object'
                    ? properties.open5e as Record<string, unknown>
                    : undefined;
                const lightResult = db.transaction(() => {
                    if (lightSource.consumesItem && !inventoryRepo.removeItem(params.characterId, params.itemId, 1)) {
                        throw new Error(`Failed to use light source`);
                    }

                    const effect = effectsRepo.apply({
                        target_id: params.characterId,
                        target_type: 'character',
                        name: `Light source: ${item.name}`,
                        description: `${item.name} is lit and provides ${lightSource.brightRadiusFeet} ft bright light plus ${lightSource.dimRadiusFeet} ft dim light${lightSource.shape === 'cone' ? ' in a cone' : ''}.`,
                        source: {
                            type: 'natural',
                            entity_id: item.id,
                            entity_name: item.name,
                        },
                        category: 'neutral',
                        power_level: 1,
                        mechanics: [{
                            type: 'sense_granted',
                            value: `${lightSource.shape}:${lightSource.brightRadiusFeet}ft bright/${lightSource.dimRadiusFeet}ft dim`,
                        }],
                        duration: { type: 'minutes', value: lightSource.durationMinutes },
                        triggers: [],
                        removal_conditions: [{ type: 'duration_expires' }],
                        stackable: false,
                        max_stacks: 1,
                    });

                    return { effect, consumed: lightSource.consumesItem };
                })();

                return {
                    success: true,
                    actionType: 'use',
                    itemName: item.name,
                    characterId: params.characterId,
                    effect: 'Light source lit',
                    lightSource: {
                        ...lightSource,
                        active: true,
                        effectId: lightResult.effect.id,
                        expiresAt: lightResult.effect.expires_at,
                        consumed: lightResult.consumed,
                        provenance: {
                            itemId: item.id,
                            itemName: item.name,
                            open5e: open5e ?? null,
                        },
                    },
                    message: `${lightResult.consumed ? 'Consumed and lit' : 'Lit'} ${item.name}; the light is authoritative for ${lightSource.durationMinutes} minutes`,
                };
            }

            const properties = item.properties ?? {};
            let healingValue: unknown = properties.healing ?? properties.healingDice ?? properties.heal;
            const effect = properties.effect || properties.effects || 'No defined effect';
            if (healingValue === undefined && typeof effect === 'string' && /heal|restore|regain/i.test(effect)) {
                healingValue = effect;
            }
            const healing = rollHealing(healingValue);
            const targetId = params.targetId || params.characterId;
            const target = healing ? charRepo.findById(targetId) : null;
            if (healing && !target) {
                throw new Error(`Healing target not found: ${targetId}`);
            }

            const removed = inventoryRepo.removeItem(params.characterId, params.itemId, 1);
            if (!removed) {
                throw new Error(`Failed to consume item`);
            }

            const hpBefore = target?.hp;
            const hpAfter = target && healing
                ? Math.min(target.maxHp, target.hp + healing.amount)
                : undefined;
            if (target && hpAfter !== hpBefore) {
                charRepo.update(target.id, { hp: hpAfter } as any);
            }

            return {
                success: true,
                actionType: 'use',
                itemName: item.name,
                characterId: params.characterId,
                targetId,
                effect,
                healing: healing?.amount,
                healingNotation: healing?.notation,
                healingRolls: healing?.rolls,
                hpBefore,
                hpAfter,
                message: `Used ${item.name}`
            };
        },
        aliases: ['consume', 'apply', 'activate']
    },

    extinguish: {
        schema: ExtinguishSchema,
        handler: async (params: z.infer<typeof ExtinguishSchema>) => {
            const { itemRepo, effectsRepo } = ensureDb();
            const item = itemRepo.findById(params.itemId);
            if (!item) {
                throw new Error(`Item not found: ${params.itemId}`);
            }

            const lightSource = getLightSourceProfile(item);
            if (!lightSource) {
                throw new Error(`Item "${item.name}" is not a recognized light source`);
            }

            const effectName = `Light source: ${item.name}`;
            const activeEffect = effectsRepo.findByTargetAndName(params.characterId, 'character', effectName);
            const provenance = {
                itemId: item.id,
                itemName: item.name,
                open5e: item.properties?.open5e && typeof item.properties.open5e === 'object'
                    ? item.properties.open5e
                    : null,
            };

            if (!activeEffect) {
                return {
                    success: true,
                    actionType: 'extinguish',
                    characterId: params.characterId,
                    itemName: item.name,
                    lightSource: {
                        ...lightSource,
                        active: false,
                        effectId: null,
                        expiresAt: null,
                        provenance,
                    },
                    alreadyExtinguished: true,
                    message: `${item.name} is already extinguished`,
                };
            }

            const extinguished = effectsRepo.deactivate(activeEffect.id);
            return {
                success: true,
                actionType: 'extinguish',
                characterId: params.characterId,
                itemName: item.name,
                effectId: extinguished?.id ?? activeEffect.id,
                lightSource: {
                    ...lightSource,
                    active: false,
                    effectId: extinguished?.id ?? activeEffect.id,
                    expiresAt: activeEffect.expires_at,
                    provenance,
                },
                extinguished: true,
                message: `Extinguished ${item.name}`,
            };
        },
        aliases: ['put_out', 'douse']
    },

    equip: {
        schema: EquipSchema,
        handler: async (params: z.infer<typeof EquipSchema>) => {
            const { db, inventoryRepo, itemRepo, charRepo } = ensureDb();

            // Verify ownership
            const inventory = inventoryRepo.getInventory(params.characterId);
            const hasItem = inventory.items.some((i: { itemId: string; quantity: number }) =>
                i.itemId === params.itemId && i.quantity > 0
            );

            if (!hasItem) {
                throw new Error(`Character does not own item ${params.itemId}`);
            }

            const item = itemRepo.findById(params.itemId);
            if (!item) {
                throw new Error(`Item not found: ${params.itemId}`);
            }

            const allowedSlots = allowedEquipSlots(item);
            if (item.properties?.requiresSelection === true) {
                throw new Error(`Item "${item.name}" is an unresolved equipment choice; materialize a concrete item first`);
            }
            if (!allowedSlots.includes(params.slot)) {
                const guidance = allowedSlots.length > 0
                    ? `Allowed slots: ${allowedSlots.join(', ')}`
                    : 'This item is not equippable; custom equippable items must define properties.equipSlots';
                throw new Error(`Cannot equip "${item.name}" in ${params.slot}. ${guidance}`);
            }

            inventoryRepo.equipItem(params.characterId, params.itemId, params.slot);

            // FINDINGS #69: AC is DERIVED from the full equipped set (armor
            // base + capped DEX + every other equipped acBonus, head included),
            // not patched incrementally — the old arithmetic dropped the
            // Sphere-08's +1 on every armor re-equip.
            const character = charRepo.findById(params.characterId);
            let acChange: string | null = null;
            if (character) {
                const derived = deriveArmorClass(db, params.characterId);
                if (derived.ac !== character.ac) {
                    charRepo.update(params.characterId, { ac: derived.ac });
                    acChange = `AC ${character.ac} → ${derived.ac} (now ${derived.ac}: ${derived.parts.join(' + ')})`;
                } else {
                    acChange = `AC unchanged (now ${derived.ac}: ${derived.parts.join(' + ')})`;
                }
            }

            return {
                success: true,
                actionType: 'equip',
                itemName: item.name,
                slot: params.slot,
                characterId: params.characterId,
                acChange,
                message: `Equipped ${item.name} in ${params.slot} slot`
            };
        },
        aliases: ['wear', 'wield', 'don']
    },

    unequip: {
        schema: UnequipSchema,
        handler: async (params: z.infer<typeof UnequipSchema>) => {
            const { db, inventoryRepo, itemRepo, charRepo } = ensureDb();

            const inventory = inventoryRepo.getInventory(params.characterId);
            // FINDINGS #34 T3: slot-only unequip — resolve the occupant.
            let itemId = params.itemId;
            if (!itemId && params.slot) {
                const occupant = inventory.items.find((i: { slot?: string; equipped: boolean }) => i.equipped && i.slot === params.slot);
                if (!occupant) {
                    return { error: true, actionType: 'unequip', message: `Nothing equipped in slot "${params.slot}"` };
                }
                itemId = (occupant as { itemId: string }).itemId;
            }
            if (!itemId) {
                return { error: true, actionType: 'unequip', message: 'Pass itemId or slot' };
            }
            const item = itemRepo.findById(itemId);
            // (equippedItem/slot lookup retired — #69 derives AC from the
            // whole equipped set after the write; noUnusedLocals-safe.)

            inventoryRepo.unequipItem(params.characterId, itemId);

            // FINDINGS #69: same derivation as equip — the live defect was a
            // 19 → 14 write reported as acChange: null. The write and the
            // report now come from the same computation; a write can never
            // again be silent, and remaining equipped bonuses (head slot)
            // survive the removal of the body armor.
            const character = charRepo.findById(params.characterId);
            let acChange: string | null = null;
            if (character) {
                const derived = deriveArmorClass(db, params.characterId);
                if (derived.ac !== character.ac) {
                    charRepo.update(params.characterId, { ac: derived.ac });
                    acChange = `AC ${character.ac} → ${derived.ac} (now ${derived.ac}: ${derived.parts.join(' + ')})`;
                } else {
                    acChange = `AC unchanged (now ${derived.ac}: ${derived.parts.join(' + ')})`;
                }
            }

            return {
                success: true,
                actionType: 'unequip',
                itemName: item?.name || itemId,
                characterId: params.characterId,
                acChange,
                message: `Unequipped ${item?.name || itemId}`
            };
        },
        aliases: ['remove_equipped', 'doff', 'unwield']
    },

    get: {
        schema: GetSchema,
        handler: async (params: z.infer<typeof GetSchema>) => {
            const { inventoryRepo } = ensureDb();

            const inventory = inventoryRepo.getInventoryWithDetails(params.characterId);

            return {
                success: true,
                actionType: 'get',
                characterId: params.characterId,
                inventory: inventory.items,
                itemIds: inventory.items.map(entry => entry.item.id),
                currency: inventory.currency,
                gold: inventory.currency.gold,
                silver: inventory.currency.silver,
                copper: inventory.currency.copper,
                itemCount: inventory.items.length
            };
        },
        aliases: ['list', 'show', 'view']
    },

    attach: {
        schema: AttachSchema,
        handler: async (params: z.infer<typeof AttachSchema>) => {
            const { db, itemRepo } = ensureDb();
            const resolved = resolveInstance(db, params.characterId, params.itemId);
            if ('error' in resolved) return { error: true, actionType: 'attach', message: resolved.error };
            const gunTpl = itemRepo.findById(resolved.templateId);
            const attTpl = itemRepo.findById(params.attachmentItemId);
            if (!gunTpl) return { error: true, actionType: 'attach', message: `Weapon template ${resolved.templateId} not found` };
            if (!attTpl) return { error: true, actionType: 'attach', message: `Attachment ${params.attachmentItemId} not found` };
            const ownedAtt = db.prepare('SELECT quantity FROM inventory_items WHERE character_id = ? AND item_id = ?').get(params.characterId, params.attachmentItemId) as { quantity: number } | undefined;
            if (!ownedAtt || ownedAtt.quantity < 1) return { error: true, actionType: 'attach', message: `${attTpl.name} is not in the character's inventory` };
            const gunProps = (gunTpl.properties || {}) as Record<string, unknown>;
            const attProps = (attTpl.properties || {}) as Record<string, unknown>;
            const refusal = attachGateCheck(gunProps, attProps);
            if (refusal) return { error: true, actionType: 'attach', message: refusal };
            const mounted = resolved.instance ? JSON.parse(resolved.instance.attachments || '{}') as Record<string, string> : {};
            const slotType = attProps.slotType as string;
            if (mounted[slotType]) {
                const occupant = itemRepo.findById(mounted[slotType]);
                return { error: true, actionType: 'attach', message: `${slotType} slot is occupied by ${occupant?.name ?? mounted[slotType]} — detach it first` };
            }
            // ─── FINDINGS #59: every gate has passed — only NOW does anything write ───
            const instance = resolved.instance ?? mintInstance(db, params.characterId, resolved.templateId);
            const created = resolved.instance === null;
            mounted[slotType] = params.attachmentItemId;
            db.prepare('UPDATE item_instances SET attachments = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(mounted), new Date().toISOString(), instance.id);
            // Consume the loose part into the instance
            const remaining = ownedAtt.quantity - 1;
            if (remaining > 0) db.prepare('UPDATE inventory_items SET quantity = ? WHERE character_id = ? AND item_id = ?').run(remaining, params.characterId, params.attachmentItemId);
            else db.prepare('DELETE FROM inventory_items WHERE character_id = ? AND item_id = ?').run(params.characterId, params.attachmentItemId);
            return {
                success: true, actionType: 'attach',
                instanceId: instance.id, instanceCreated: created,
                weapon: gunTpl.name, attachment: attTpl.name, slotType,
                effect: attProps.effect ?? null,
                condition: instance.condition,
                mounted: Object.fromEntries(Object.entries(mounted).filter(([s]) => !s.startsWith('_')).map(([s, tid]) => [s, itemRepo.findById(tid as string)?.name ?? tid])),
                message: `${attTpl.name} mounted on ${gunTpl.name} (${slotType})`
            };
        },
        aliases: ['mount', 'install']
    },

    detach: {
        schema: DetachSchema,
        handler: async (params: z.infer<typeof DetachSchema>) => {
            const { db, itemRepo, inventoryRepo } = ensureDb();
            // FINDINGS #59: detach resolves like attach — itemId may be the weapon
            // TEMPLATE id or an instance id (the #57 spec); instanceId stays as the
            // explicit form. The old schema demanded instanceId alone AND the outer
            // schema never carried it — direct detach was uncallable (mirror strike 9).
            const key = params.instanceId ?? params.itemId;
            if (!key) return { error: true, actionType: 'detach', message: 'Pass itemId (weapon template or instance id) or instanceId' };
            // FINDINGS #96: _-prefixed slots are META lanes (coating), not mounted
            // hardware — there is no loose part to return. The right verb is named.
            if (params.slotType.startsWith('_')) return { error: true, actionType: 'detach', message: `${params.slotType} is a meta lane, not a mounted part — use uncoat to wipe or spend a coating` };
            let instance = db.prepare('SELECT * FROM item_instances WHERE id = ?').get(key) as ItemInstance | undefined;
            if (!instance) {
                instance = db.prepare('SELECT * FROM item_instances WHERE owner_character_id = ? AND template_id = ?').get(params.characterId, key) as ItemInstance | undefined;
            }
            if (!instance) return { error: true, actionType: 'detach', message: `No built instance found for ${key} on that character — nothing has ever been mounted on it` };
            if (instance.owner_character_id !== params.characterId) return { error: true, actionType: 'detach', message: 'Instance is not owned by that character' };
            const mounted = JSON.parse(instance.attachments || '{}') as Record<string, string>;
            const partId = mounted[params.slotType];
            if (!partId) return { error: true, actionType: 'detach', message: `Nothing mounted in ${params.slotType}` };
            delete mounted[params.slotType];
            db.prepare('UPDATE item_instances SET attachments = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(mounted), new Date().toISOString(), instance.id);
            inventoryRepo.addItem(params.characterId, partId, 1);
            const part = itemRepo.findById(partId);
            const gun = itemRepo.findById(instance.template_id);
            return {
                success: true, actionType: 'detach',
                instanceId: instance.id, weapon: gun?.name, attachment: part?.name ?? partId, slotType: params.slotType,
                mounted: Object.fromEntries(Object.entries(mounted).filter(([s]) => !s.startsWith('_')).map(([s, tid]) => [s, itemRepo.findById(tid as string)?.name ?? tid])),
                message: `${part?.name ?? partId} removed from ${gun?.name ?? instance.template_id} — back in loose inventory`
            };
        },
        aliases: ['unmount', 'strip']
    },

    adjust_condition: {
        schema: AdjustConditionSchema,
        handler: async (params: z.infer<typeof AdjustConditionSchema>) => {
            const { db, itemRepo } = ensureDb();
            // FINDINGS #60: resolve like attach/detach; the first condition write
            // births the instance (the #57 contract). Ownership is checked by
            // resolveInstance BEFORE any mint — refusals write nothing (#59 law).
            if (params.delta === undefined && params.value === undefined) {
                return { error: true, actionType: 'adjust_condition', message: 'Pass delta (relative) or value (absolute)' };
            }
            const key = params.instanceId ?? params.itemId;
            if (!key) return { error: true, actionType: 'adjust_condition', message: 'Pass itemId (weapon template or instance id) or instanceId' };
            const resolved = resolveInstance(db, params.characterId, key);
            if ('error' in resolved) return { error: true, actionType: 'adjust_condition', message: resolved.error };
            const gunTpl = itemRepo.findById(resolved.templateId);
            if (!gunTpl) return { error: true, actionType: 'adjust_condition', message: `Item template ${resolved.templateId} not found` };
            const instance = resolved.instance ?? mintInstance(db, params.characterId, resolved.templateId);
            const created = resolved.instance === null;
            // FINDINGS #88: journal the pre-write instance state — revertable.
            const journalId = created ? null : journalSnapshot(db, 'item_instances', instance.id, 'update', 'inventory_manage adjust_condition');
            const tplProps = (gunTpl.properties || {}) as Record<string, unknown>;
            const before = typeof instance.condition === 'number' ? instance.condition : (typeof tplProps.condition === 'number' ? tplProps.condition : 100);
            const ceiling = params.max ?? 100;
            const raw = params.value !== undefined ? params.value : before + (params.delta ?? 0);
            const current = Math.min(ceiling, Math.max(0, raw));
            db.prepare('UPDATE item_instances SET condition = ?, updated_at = ? WHERE id = ?')
                .run(current, new Date().toISOString(), instance.id);
            return {
                success: true, actionType: 'adjust_condition',
                instanceId: instance.id, instanceCreated: created,
                journalId,
                weapon: gunTpl.name,
                before, current, max: ceiling,
                clamped: raw !== current,
                message: `${gunTpl.name}: cond ${before} → ${current} (ceiling ${ceiling})${raw !== current ? ' [clamped]' : ''}`
            };
        },
        aliases: ['condition', 'set_condition', 'repair', 'degrade']
    },

    // FINDINGS #86: the charge lane — a dead headlamp was previously
    // indistinguishable from a live one without a hand-patched template
    // property, and a future chair would have narrated light he does not
    // have. Same resolve/mint contract as adjust_condition; counts from
    // the store; refuses a delta with no baseline rather than inventing one.
    adjust_charges: {
        schema: AdjustChargesSchema,
        handler: async (params: z.infer<typeof AdjustChargesSchema>) => {
            const { db, itemRepo } = ensureDb();
            if (params.delta === undefined && params.value === undefined) {
                return { error: true, actionType: 'adjust_charges', message: 'Pass delta (relative) or value (absolute)' };
            }
            const key = params.instanceId ?? params.itemId;
            if (!key) return { error: true, actionType: 'adjust_charges', message: 'Pass itemId (item template or instance id) or instanceId' };
            const resolved = resolveInstance(db, params.characterId, key);
            if ('error' in resolved) return { error: true, actionType: 'adjust_charges', message: resolved.error };
            const tpl = itemRepo.findById(resolved.templateId);
            if (!tpl) return { error: true, actionType: 'adjust_charges', message: `Item template ${resolved.templateId} not found` };
            const tplProps = (tpl.properties || {}) as Record<string, unknown>;
            const tplBaseline = [tplProps.charges, tplProps.batteryHours, tplProps.uses].find(v => typeof v === 'number') as number | undefined;
            const instance = resolved.instance ?? mintInstance(db, params.characterId, resolved.templateId);
            const created = resolved.instance === null;
            // FINDINGS #88: journal the pre-write instance state — revertable.
            const journalId = created ? null : journalSnapshot(db, 'item_instances', instance.id, 'update', 'inventory_manage adjust_charges');
            const instCharges = (instance as ItemInstance & { charges?: number | null; charges_max?: number | null });
            const before = typeof instCharges.charges === 'number' ? instCharges.charges : (tplBaseline ?? null);
            if (before === null && params.value === undefined) {
                return { error: true, actionType: 'adjust_charges', message: `${tpl.name} has no charge baseline (no prior write, no numeric charges/batteryHours/uses on the template) — set an absolute value: first. NOTHING was written.` };
            }
            const storedMax = typeof instCharges.charges_max === 'number' ? instCharges.charges_max : undefined;
            const ceiling = params.max ?? storedMax;
            const raw = params.value !== undefined ? params.value : (before as number) + (params.delta ?? 0);
            const current = Math.max(0, ceiling !== undefined ? Math.min(ceiling, raw) : raw);
            db.prepare('UPDATE item_instances SET charges = ?, charges_max = COALESCE(?, charges_max), updated_at = ? WHERE id = ?')
                .run(current, params.max ?? null, new Date().toISOString(), instance.id);
            return {
                success: true, actionType: 'adjust_charges',
                instanceId: instance.id, instanceCreated: created,
                journalId,
                item: tpl.name,
                before, current, max: ceiling ?? null,
                clamped: raw !== current,
                message: `${tpl.name}: charges ${before ?? '—'} → ${current}${ceiling !== undefined ? ` / ${ceiling}` : ''}${raw !== current ? ' [clamped]' : ''}${current === 0 ? ' — DEAD' : ''}`
            };
        },
        aliases: ['charges', 'set_charges', 'spend_charge', 'recharge']
    },

    coat: {
        schema: CoatSchema,
        handler: async (params: z.infer<typeof CoatSchema>) => {
            const { db, itemRepo } = ensureDb();
            const weaponRef = params.instanceId ?? params.itemId;
            if (!weaponRef) return { error: true, actionType: 'coat', message: 'Pass itemId (weapon template/instance) or instanceId' };
            const resolved = resolveInstance(db, params.characterId, weaponRef);
            if ('error' in resolved) return { error: true, actionType: 'coat', message: resolved.error };
            const wpnTpl = itemRepo.findById(resolved.templateId);
            const coatTpl = itemRepo.findById(params.coatingItemId);
            if (!wpnTpl) return { error: true, actionType: 'coat', message: `Weapon template ${resolved.templateId} not found` };
            if (!coatTpl) return { error: true, actionType: 'coat', message: `Coating ${params.coatingItemId} not found` };
            const owned = db.prepare('SELECT quantity FROM inventory_items WHERE character_id = ? AND item_id = ?').get(params.characterId, params.coatingItemId) as { quantity: number } | undefined;
            if (!owned || owned.quantity < 1) return { error: true, actionType: 'coat', message: `${coatTpl.name} is not in the character's inventory — nothing applied` };
            const cProps = (coatTpl.properties || {}) as Record<string, unknown>;
            // appliesTo gate (optional): 'silver', 'steel', 'blade', a damage type…
            const appliesTo = cProps.appliesTo ? String(cProps.appliesTo).toLowerCase() : null;
            if (appliesTo) {
                const wProps = (wpnTpl.properties || {}) as Record<string, unknown>;
                const hay = `${wpnTpl.name} ${wProps.damageType ?? ''} ${wProps.material ?? ''} ${wpnTpl.type ?? ''}`.toLowerCase();
                if (!appliesTo.split('/').some(t => hay.includes(t.trim()))) {
                    return { error: true, actionType: 'coat', message: `${coatTpl.name} applies to ${cProps.appliesTo}; ${wpnTpl.name} does not match — nothing applied` };
                }
            }
            const instance = resolved.instance ?? mintInstance(db, params.characterId, resolved.templateId);
            const created = resolved.instance === null;
            const mounted = JSON.parse(instance.attachments || '{}') as Record<string, unknown>;
            const prior = mounted._coating as { name?: string } | undefined;
            const hits = params.hits ?? (typeof cProps.coatingHits === 'number' ? cProps.coatingHits : 5);
            mounted._coating = {
                itemId: params.coatingItemId,
                name: coatTpl.name,
                label: cProps.coatingLabel ?? coatTpl.name,
                bonus: typeof cProps.coatingBonus === 'number' ? cProps.coatingBonus : 2,
                remainingHits: hits,
                appliedAt: new Date().toISOString()
            };
            db.prepare('UPDATE item_instances SET attachments = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(mounted), new Date().toISOString(), instance.id);
            // FINDINGS #96-C (design b, ruled charges-when-declared) — AFTER every
            // gate, with the coating written: if the coating TEMPLATE declares
            // numeric charges/uses, the JAR is the unit — one application debits
            // ONE CHARGE on the coating's own instance row; the stack row only
            // leaves when the jar runs dry. No charge declaration = stack-per-dose
            // (pre-#96-C behavior). adjust_charges reads the same lane.
            const jarCapacity = typeof cProps.charges === 'number' ? cProps.charges : (typeof cProps.uses === 'number' ? cProps.uses : null);
            let dosesLeft: number;
            let jarNote: string | undefined;
            if (jarCapacity !== null) {
                const jarResolved = resolveInstance(db, params.characterId, params.coatingItemId);
                const jar = ('error' in jarResolved ? null : jarResolved.instance) ?? mintInstance(db, params.characterId, params.coatingItemId);
                const jarRow = db.prepare('SELECT charges FROM item_instances WHERE id = ?').get(jar.id) as { charges: number | null } | undefined;
                const before = typeof jarRow?.charges === 'number' ? jarRow.charges : jarCapacity;
                const after = before - 1;
                if (after <= 0) {
                    db.prepare('DELETE FROM item_instances WHERE id = ?').run(jar.id);
                    const remaining = owned.quantity - 1;
                    if (remaining > 0) db.prepare('UPDATE inventory_items SET quantity = ? WHERE character_id = ? AND item_id = ?').run(remaining, params.characterId, params.coatingItemId);
                    else db.prepare('DELETE FROM inventory_items WHERE character_id = ? AND item_id = ?').run(params.characterId, params.coatingItemId);
                    dosesLeft = remaining > 0 ? jarCapacity * remaining : 0;
                    jarNote = `jar EMPTY and discarded${remaining > 0 ? ` — ${remaining} full jar(s) left` : ' — that was the last one'}`;
                } else {
                    db.prepare('UPDATE item_instances SET charges = ?, charges_max = COALESCE(charges_max, ?), updated_at = ? WHERE id = ?').run(after, jarCapacity, new Date().toISOString(), jar.id);
                    dosesLeft = after + jarCapacity * (owned.quantity - 1);
                    jarNote = `jar at ${after}/${jarCapacity}`;
                }
            } else {
                const remaining = owned.quantity - 1;
                if (remaining > 0) db.prepare('UPDATE inventory_items SET quantity = ? WHERE character_id = ? AND item_id = ?').run(remaining, params.characterId, params.coatingItemId);
                else db.prepare('DELETE FROM inventory_items WHERE character_id = ? AND item_id = ?').run(params.characterId, params.coatingItemId);
                dosesLeft = remaining;
            }
            return {
                success: true, actionType: 'coat',
                instanceId: instance.id, instanceCreated: created,
                weapon: wpnTpl.name, coating: coatTpl.name,
                bonus: (mounted._coating as { bonus: number }).bonus, remainingHits: hits,
                dosesLeft,
                ...(jarNote ? { jarNote } : {}),
                ...(prior ? { replaced: prior.name } : {}),
                combatLane: `attack reads this coating from the equipped weapon automatically (hand param picks mainhand/offhand) — printed as 🧪 in the breakdown, one hit debited per connect; manual lane: uncoat {spendHit:true}`,
                message: `${coatTpl.name} on ${wpnTpl.name} — +${(mounted._coating as { bonus: number }).bonus} for ${hits} hits${prior ? ` (replaced ${prior.name})` : ''}. ${jarNote ?? `One dose consumed (${dosesLeft} left).`}`
            };
        },
        aliases: ['apply_oil', 'apply_coating', 'poison_blade', 'oil']
    },

    uncoat: {
        schema: UncoatSchema,
        handler: async (params: z.infer<typeof UncoatSchema>) => {
            const { db, itemRepo } = ensureDb();
            const weaponRef = params.instanceId ?? params.itemId;
            if (!weaponRef) return { error: true, actionType: 'uncoat', message: 'Pass itemId (weapon template/instance) or instanceId' };
            const resolved = resolveInstance(db, params.characterId, weaponRef);
            if ('error' in resolved) return { error: true, actionType: 'uncoat', message: resolved.error };
            if (!resolved.instance) return { error: true, actionType: 'uncoat', message: 'No instance — nothing was ever coated' };
            const mounted = JSON.parse(resolved.instance.attachments || '{}') as Record<string, unknown>;
            const coating = mounted._coating as { name: string; label: string; bonus: number; remainingHits: number } | undefined;
            if (!coating) return { error: true, actionType: 'uncoat', message: 'No coating on this weapon' };
            const wpnTpl = itemRepo.findById(resolved.templateId);
            if (params.spendHit) {
                coating.remainingHits -= 1;
                const expired = coating.remainingHits <= 0;
                if (expired) delete mounted._coating; else mounted._coating = coating;
                db.prepare('UPDATE item_instances SET attachments = ?, updated_at = ? WHERE id = ?')
                    .run(JSON.stringify(mounted), new Date().toISOString(), resolved.instance.id);
                return {
                    success: true, actionType: 'uncoat', spendHit: true,
                    weapon: wpnTpl?.name, coating: coating.name,
                    remainingHits: Math.max(0, coating.remainingHits), expired,
                    message: expired ? `${coating.name} is SPENT — the edge runs dry on ${wpnTpl?.name}.` : `${coating.name}: ${coating.remainingHits} hit(s) left on ${wpnTpl?.name}.`
                };
            }
            delete mounted._coating;
            db.prepare('UPDATE item_instances SET attachments = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(mounted), new Date().toISOString(), resolved.instance.id);
            return { success: true, actionType: 'uncoat', weapon: wpnTpl?.name, coating: coating.name, wiped: true, message: `${coating.name} wiped from ${wpnTpl?.name}.` };
        },
        aliases: ['wipe', 'spend_coating_hit']
    },

    get_detailed: {
        schema: GetDetailedSchema,
        handler: async (params: z.infer<typeof GetDetailedSchema>) => {
            const { db, inventoryRepo, itemRepo } = ensureDb();

            const inventory = inventoryRepo.getInventoryWithDetails(params.characterId);

            // FINDINGS #57: built items — instances with condition + mounted parts
            // (#86: + charge state — a lamp's battery rides the same row)
            let instances: Array<Record<string, unknown>> = [];
            try {
                const rows = db.prepare('SELECT * FROM item_instances WHERE owner_character_id = ?').all(params.characterId) as Array<{ id: string; template_id: string; condition: number | null; attachments: string; custom_name: string | null; charges?: number | null; charges_max?: number | null }>;
                instances = rows.map(r => {
                    const att = JSON.parse(r.attachments || '{}') as Record<string, unknown>;
                    // FINDINGS #96: _-prefixed keys are META (coating rides here) —
                    // never fed to findById (objects crash the binder); coating
                    // surfaces as its own field.
                    const coating = att._coating as { name?: string; bonus?: number; remainingHits?: number } | undefined;
                    return {
                        instanceId: r.id,
                        name: r.custom_name ?? itemRepo.findById(r.template_id)?.name ?? r.template_id,
                        templateId: r.template_id,
                        condition: r.condition,
                        ...(typeof r.charges === 'number' ? { charges: r.charges, chargesMax: r.charges_max ?? null } : {}),
                        ...(coating ? { coating: { name: coating.name, bonus: coating.bonus, remainingHits: coating.remainingHits } } : {}),
                        mounted: Object.fromEntries(Object.entries(att).filter(([s]) => !s.startsWith('_')).map(([s, tid]) => [s, itemRepo.findById(tid as string)?.name ?? tid]))
                    };
                });
            } catch { /* instances table absent pre-migration — nothing to show */ }

            return {
                success: true,
                actionType: 'get_detailed',
                characterId: params.characterId,
                inventory: inventory.items,
                instances,
                totalWeight: inventory.totalWeight,
                capacity: inventory.capacity,
                // THE READ LIE (fixed): this read `.gold` off an object that
                // only ever had `.currency.{gold}` — reporting RU 0 for every
                // character forever, while every currency WRITE worked fine.
                gold: inventory.currency?.gold ?? 0,
                silver: inventory.currency?.silver ?? 0,
                copper: inventory.currency?.copper ?? 0,
                currency: inventory.currency,
                itemCount: inventory.items.length
            };
        },
        aliases: ['detailed', 'full', 'complete']
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// ROUTER & TOOL DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

const router = createActionRouter({
    actions: ACTIONS,
    definitions,
    threshold: 0.6
});

export const InventoryManageTool = {
    name: 'inventory_manage',
    description: `Manage character inventories and equipment.

📦 ITEM WORKFLOW:
1. Create items with item_manage first (or use existing items)
2. give - Add items to character inventory
3. equip - Slot weapons/armor (updates AC automatically)

🔄 COMMON ACTIONS:
- transfer: Move items between characters atomically (use this for a player-to-NPC handoff)
- use: Consume potions/scrolls or light a torch/lantern (persists duration and provenance)
- extinguish: Put out an active torch/lantern without consuming or removing the source item
- get_detailed: Show weight, capacity, and item details

IMPORTANT: give is a world/DM grant to one character and does not remove an item from another character. For a handoff, always use transfer with fromCharacterId and toCharacterId.

⚔️ EQUIPMENT SLOTS:
mainhand, offhand, armor, head, feet, accessory, accessory2, accessory3 (#96)

Actions: ${ACTIONS.join(', ')}
Aliases: add→give, take→remove, trade→transfer, consume→use, wield→equip`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action to perform: ${ACTIONS.join(', ')}`),
        characterId: z.string().optional().describe('Character ID'),
        itemId: z.string().optional().describe('Item ID'),
        quantity: z.number().optional().describe('Quantity (default: 1)'),
        fromCharacterId: z.string().optional().describe('Source character (for transfer)'),
        toCharacterId: z.string().optional().describe('Target character (for transfer)'),
        targetId: z.string().optional().describe('Effect target (for use)'),
        slot: z.enum(['mainhand', 'offhand', 'armor', 'head', 'feet', 'accessory']).optional().describe('Equipment slot (for equip)'),
        // FINDINGS #33 (mirror law, 5th strike): amount/reason were never in the
        // outer — direct add_currency was broken since wave 10; only batch worked.
        amount: z.number().optional().describe('RU delta for add_currency: positive credits, negative debits'),
        reason: z.string().optional().describe('Audit-trail reason for add_currency'),
        // FINDINGS #57 (mirror law, same edit as the inner): attach/detach params
        attachmentItemId: z.string().optional().describe('Attachment template id (attach)'),
        // FINDINGS #96 (mirror law): coat/uncoat params
        coatingItemId: z.string().optional().describe('coat: the oil/poison/toxin item — one dose consumed onto the weapon instance'),
        hits: z.number().int().optional().describe('coat: hits the application lasts (default template coatingHits, else 5)'),
        spendHit: z.boolean().optional().describe('uncoat: debit ONE hit (combat lane) instead of wiping; auto-wipes at 0'),
        slotType: z.string().optional().describe('Slot to clear (detach): optic|muzzle|underbarrel|mag|side'),
        // FINDINGS #59 (mirror law, NINTH strike): instanceId existed in the inner
        // detach schema but never in the outer — direct detach could not validate.
        instanceId: z.string().optional().describe('Weapon instance id (detach — explicit alternative to itemId, which also accepts the template id)'),
        // FINDINGS #60 (mirror law): adjust_condition params
        // FINDINGS #86 (mirror law): shared by adjust_charges; condition covers
        // ANY owned item now (knife, toolkit, detector, lamp — never only guns)
        delta: z.number().optional().describe('Delta (adjust_condition / adjust_charges): degradation/repair, hours burned/recharged'),
        value: z.number().optional().describe('Absolute set (adjust_condition / adjust_charges)'),
        max: z.number().optional().describe('Ceiling — adjust_condition: toolkit tier 70/90/100, default 100; adjust_charges: intrinsic capacity, stored on the instance')
    })
};

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export async function handleInventoryManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    const response = await router(args as Record<string, unknown>);

    // Wrap response with ASCII formatting
    try {
        const parsed = JSON.parse(response.content[0].text);
        let output = '';

        if (parsed.error) {
            // FINDINGS #64: refusals via the payload-gated renderer — NO WRITE
            // prints iff the throw site asserted writes:'none'.
            output = pda.refuseFromPayload(parsed);
            if (parsed.validActions) {
                output += RichFormatter.section('Valid Actions');
                output += RichFormatter.list(parsed.validActions);
            }
        } else if (parsed.actionType === 'give' || parsed.actionType === 'remove') {
            output = RichFormatter.header(parsed.actionType === 'give' ? 'Item Added' : 'Item Removed', parsed.actionType === 'give' ? '➕' : '➖');
            output += RichFormatter.keyValue({
                'Item': parsed.itemName,
                'Quantity': parsed.quantity,
                'Character': parsed.characterId,
            });
            output += RichFormatter.success(parsed.message);
        } else if (parsed.actionType === 'transfer') {
            output = RichFormatter.header('Item Transferred', '🔀');
            output += RichFormatter.keyValue({
                'Item': parsed.itemName,
                'Quantity': parsed.quantity,
                'From': parsed.fromCharacterId,
                'To': parsed.toCharacterId,
            });
            output += RichFormatter.success(parsed.message);
        } else if (parsed.actionType === 'use') {
            output = RichFormatter.header(parsed.lightSource ? 'Light Source Lit' : 'Item Used', parsed.lightSource ? '🔥' : '✨');
            output += RichFormatter.keyValue({
                'Item': parsed.itemName,
                'Target': parsed.targetId,
            });
            output += RichFormatter.section('Effect');
            output += `${parsed.effect}\n`;
            if (parsed.lightSource) {
                output += RichFormatter.keyValue({
                    'Bright': `${parsed.lightSource.brightRadiusFeet} ft`,
                    'Dim': `${parsed.lightSource.dimRadiusFeet} ft`,
                    'Duration': `${parsed.lightSource.durationMinutes} minutes`,
                    'Effect ID': parsed.lightSource.effectId,
                });
            }
            output += RichFormatter.success(parsed.message);
        } else if (parsed.actionType === 'extinguish') {
            output = RichFormatter.header('Light Source Extinguished', '🕯️');
            output += RichFormatter.keyValue({
                'Item': parsed.itemName,
                'Character': parsed.characterId,
                'Effect ID': parsed.effectId,
            });
            output += RichFormatter.success(parsed.message);
        } else if (parsed.actionType === 'equip' || parsed.actionType === 'unequip') {
            output = RichFormatter.header(parsed.actionType === 'equip' ? 'Item Equipped' : 'Item Unequipped', parsed.actionType === 'equip' ? '⚔️' : '📦');
            output += RichFormatter.keyValue({
                'Item': parsed.itemName,
                'Character': parsed.characterId,
                ...(parsed.slot && { 'Slot': parsed.slot }),
            });
            if (parsed.acChange) {
                output += RichFormatter.alert(parsed.acChange, 'info');
            }
            output += RichFormatter.success(parsed.message);
        } else if (parsed.actionType === 'attach' || parsed.actionType === 'detach') {
            output = RichFormatter.header(parsed.actionType === 'attach' ? 'Part Mounted' : 'Part Removed', '🔧');
            output += `${parsed.message}\n`;
            if (parsed.effect) output += `Effect: ${parsed.effect}\n`;
            if (parsed.instanceCreated) output += `*Instance born: this ${parsed.weapon} is now a specific gun — \`${parsed.instanceId}\`*\n`;
            const mountedNow = parsed.mounted as Record<string, string> | undefined;
            if (mountedNow && Object.keys(mountedNow).length) {
                output += 'Mounted: ' + Object.entries(mountedNow).map(([s, n]) => `${s}: ${n}`).join(' │ ') + '\n';
            }
        } else if (parsed.actionType === 'adjust_condition') {
            // FINDINGS #63 (PDA Wave B): BENCH — condition writes in rail with
            // the wear bar and jam-risk band.
            output = pda.renderBench(parsed as Parameters<typeof pda.renderBench>[0]);
        } else if (parsed.actionType === 'get' || parsed.actionType === 'get_detailed') {
            output = RichFormatter.header('Inventory', '🎒');
            output += RichFormatter.keyValue({
                'Character': parsed.characterId,
                ...(parsed.totalWeight !== undefined && {
                    'Weight': `${parsed.totalWeight}/${parsed.capacity} lbs`
                }),
                ...(parsed.gold !== undefined && { 'RU': parsed.gold }),
                'Items': parsed.itemCount || 0
            });
            if (parsed.inventory?.length) {
                output += RichFormatter.inventory(parsed.inventory.map((i: { item?: { name: string }; itemId: string; quantity: number; equipped: boolean; slot?: string }) => ({
                    name: i.item?.name || i.itemId,
                    quantity: i.quantity,
                    equipped: i.equipped,
                    slot: i.slot,
                })));
            } else {
                output += '*Inventory is empty*\n';
            }
            const built = parsed.instances as Array<{ id: string; name?: string; condition: number | null; mounted?: Record<string, string>; customName?: string | null }> | undefined;
            if (built?.length) {
                output += RichFormatter.section('Built Guns');
                built.forEach(g => {
                    const parts = g.mounted && Object.keys(g.mounted).length ? ' — ' + Object.entries(g.mounted).map(([s, n]) => `${s}: ${n}`).join(' │ ') : '';
                    output += `• **${g.customName || g.name || g.id}**${g.condition !== null ? ` (cond ${g.condition})` : ''}${parts}\n`;
                });
            }
        } else {
            // Fallback
            output = RichFormatter.header('Inventory Operation', '🎒');
            output += JSON.stringify(parsed, null, 2) + '\n';
        }

        // Embed JSON for programmatic access
        output += RichFormatter.embedJson(parsed, 'INVENTORY_MANAGE');

        return { content: [{ type: 'text', text: output }] };
    } catch {
        // If JSON parsing fails, return original response
        return response;
    }
}
