/**
 * Consolidated Item Management Tool
 * Replaces 6 separate tools: create_item_template, get_item, list_items, search_items, update_item, delete_item
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { ItemRepository } from '../../storage/repos/item.repo.js';
import { getDb } from '../../storage/index.js';
import { EQUIP_SLOTS, equipSlotSchema } from '../../schema/inventory.js';
import { similarity } from '../../utils/fuzzy-enum.js';
import { canonicalArmorProps, hasArmorProps, readArmorProps, ARMOR_CATEGORIES } from '../../engine/armor.js';
import { journalSnapshot } from '../utils/write-journal.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import { findOpen5eItem, searchOpen5eItems } from '../../content/open5e-catalog.js';
import { materializeOpen5eItem } from '../../services/open5e-item.service.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['create', 'get', 'list', 'search', 'update', 'delete', 'catalog_search', 'catalog_get', 'materialize', 'scope_items'] as const;
type ItemAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb() {
    const db = getDb();
    const itemRepo = new ItemRepository(db);
    return { db, itemRepo };
}

// ═══════════════════════════════════════════════════════════════════════════
// EQUIP SLOTS (play report 4 #3)
// ═══════════════════════════════════════════════════════════════════════════
// A template says where it can be equipped in properties.equipSlots; the
// type defaults (weapon → mainhand/offhand, armor → armor or offhand) apply
// only when the key is absent. create/update take `equipSlots` at the top
// level and write it there; the key is validated however it arrives.

/** Refuse before any write: the Error carries writes: 'none' so the renderer prints NO WRITE. */
function refuse(message: string): never {
    const e = new Error(message);
    (e as Error & { writes?: string }).writes = 'none';
    throw e;
}

/** A slot named twice is one slot. */
const uniqueSlots = (slots: readonly string[]): string[] => [...new Set(slots)];

/** properties.equipSlots as written: an array of known slots. An unknown one is refused with its nearest slot; null clears the key. */
function checkEquipSlots(value: unknown): string[] {
    if (value === null) return [];
    if (!Array.isArray(value)) refuse(`properties.equipSlots must be an array of slots, got ${JSON.stringify(value)}. Slots: ${EQUIP_SLOTS.join(', ')}. NOTHING was written.`);
    for (const s of value as unknown[]) {
        if (typeof s === 'string' && (EQUIP_SLOTS as readonly string[]).includes(s)) continue;
        let best: { slot: string; score: number } | undefined;
        if (typeof s === 'string') {
            for (const slot of EQUIP_SLOTS) {
                const score = similarity(s, slot);
                if (!best || score > best.score) best = { slot, score };
            }
        }
        const text = typeof s === 'string' ? s : JSON.stringify(s);
        const nearest = best && best.score >= 0.5 ? ` — nearest is '${best.slot}'` : '';
        refuse(`properties.equipSlots names '${text}', which is not an equipment slot${nearest}. Slots: ${EQUIP_SLOTS.join(', ')}. NOTHING was written.`);
    }
    return uniqueSlots(value as string[]);
}

/**
 * The slots the caller asked for, from the top-level `equipSlots` and/or
 * `properties.equipSlots`. undefined: nothing said about slots. []: clear the
 * key. Both given and disagreeing (as sets) is refused.
 */
function resolveEquipSlots(topLevel: readonly string[] | undefined, properties: Record<string, unknown> | undefined): string[] | undefined {
    const inProps = properties && 'equipSlots' in properties ? checkEquipSlots(properties.equipSlots) : undefined;
    if (topLevel && inProps) {
        const same = uniqueSlots(topLevel).sort().join(',') === [...inProps].sort().join(',');
        if (!same) refuse(`equipSlots [${topLevel.join(', ')}] and properties.equipSlots [${inProps.join(', ')}] disagree — pass one of them. NOTHING was written.`);
    }
    return topLevel ? uniqueSlots(topLevel) : inProps;
}

/** The stored properties with equipSlots set (or, for [], removed). */
function withEquipSlots(base: Record<string, unknown> | undefined, slots: string[]): Record<string, unknown> {
    const out = { ...(base ?? {}) };
    if (slots.length) out.equipSlots = slots;
    else delete out.equipSlots;
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// ARMOUR PROPERTIES (play report 5 #7)
// ═══════════════════════════════════════════════════════════════════════════
// An armour template's keys are checked and canonicalised on every write: the
// GM's baseAc / base_ac / maxDex / armorType land as baseAC / maxDexBonus /
// armorCategory (the alias named in the reply), a category typo is refused
// with the nearest name, and a base that is not a non-negative integer is
// refused. Nothing is written on a refusal. Applies to type 'armor' and to
// any template carrying a definite armour key (a ring with acBonus is left alone).

/** The stored properties after canonicalisation, with the aliases rewritten and the armour props as read; refuses on a problem. */
function checkArmorProps(type: string | undefined, properties: Record<string, unknown> | undefined): { properties: Record<string, unknown>; aliased: Record<string, string>; armorProps: ReturnType<typeof readArmorProps> } | undefined {
    if (!properties) return undefined;
    if (type !== 'armor' && !hasArmorProps(properties)) return undefined;
    const r = canonicalArmorProps(properties);
    if (r.problems.length) refuse(`Armour properties: ${r.problems.join('; ')}. Canonical keys: baseAC, armorCategory (${ARMOR_CATEGORIES.join(' | ')}), maxDexBonus, strengthRequired, stealthDisadvantage, acBonus. NOTHING was written.`);
    const { aliased: _a, ...armorProps } = readArmorProps(r.properties);
    return { properties: r.properties, aliased: r.aliased, armorProps: { ...armorProps, aliased: {} } };
}

/** 'baseAc → baseAC, maxDex → maxDexBonus' for the message. */
const aliasNote = (aliased: Record<string, string>) => Object.entries(aliased).map(([from, to]) => `${from} → ${to}`).join(', ');

const equipSlotsField = (what: string) => z.array(equipSlotSchema()).optional().describe(what);
const TYPE_DEFAULTS = 'the type defaults return (weapon: mainhand/offhand; armor: armor, or offhand with acBonus; anything else: not equippable)';

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const CreateSchema = z.object({
    action: z.literal('create'),
    name: z.string().min(1).describe('Item name'),
    type: z.enum(['weapon', 'armor', 'consumable', 'quest', 'misc', 'scroll']).describe('Item type'),
    description: z.string().optional().describe('Item description'),
    weight: z.number().min(0).optional().default(0).describe('Item weight in lbs (default 0)'),
    value: z.number().min(0).optional().default(0).describe('Item value in gold pieces; fractions allowed (default 0)'),
    properties: z.record(z.any()).optional().describe('Additional item properties'),
    equipSlots: equipSlotsField(`Slots this template may be equipped in (${EQUIP_SLOTS.join(', ')}); written to properties.equipSlots. Needed for anything but a weapon or armor to be equippable`),
    worldId: z.string().optional().describe('World this template belongs to. Omit for a shared (unscoped) template')
});

const GetSchema = z.object({
    action: z.literal('get'),
    itemId: z.string().describe('The unique ID of the item to retrieve')
});

// Deep One audit, request 6: world scope on reads. With worldId only that
// world's rows come back; includeUnscoped adds the legacy null-world rows.
const ListSchema = z.object({
    action: z.literal('list'),
    type: z.enum(['weapon', 'armor', 'consumable', 'quest', 'misc', 'scroll']).optional().describe('Filter by item type'),
    worldId: z.string().optional().describe('Only this world\'s templates'),
    includeUnscoped: z.boolean().optional().describe('With worldId: also return legacy templates with no world')
});

const SearchSchema = z.object({
    action: z.literal('search'),
    name: z.string().optional().describe('Search by name (partial match)'),
    query: z.string().optional().describe('Alias of name (partial match). When both are given, name wins'),
    type: z.enum(['weapon', 'armor', 'consumable', 'quest', 'misc', 'scroll']).optional().describe('Filter by item type'),
    minValue: z.number().min(0).optional().describe('Minimum item value'),
    maxValue: z.number().min(0).optional().describe('Maximum item value'),
    worldId: z.string().optional().describe('Only this world\'s templates'),
    includeUnscoped: z.boolean().optional().describe('With worldId: also return legacy templates with no world')
});

const ScopeItemsSchema = z.object({
    action: z.literal('scope_items'),
    worldId: z.string().describe('World to stamp onto unscoped (legacy) templates'),
    itemIds: z.array(z.string()).optional().describe('Stamp these rows by id. A row already scoped to another world is reported, never restamped'),
    all: z.boolean().optional().describe('Stamp EVERY unscoped template in the database. Use only when the database holds one campaign'),
    preview: z.boolean().optional().describe('Report the would-be stamps, write NOTHING')
});

const UpdateSchema = z.object({
    action: z.literal('update'),
    itemId: z.string().describe('The ID of the item to update'),
    // FINDINGS #87: destructive-write guard — a junk property landed on the
    // wrong id this session (the 15m line took the headlamp's patch) because
    // nothing checked the id was the thing the caller thought it was.
    expectName: z.string().optional().describe('Guard: if the row\'s name does not match this (case-insensitive), REFUSE and name what is actually there. Cheap insurance against wrong-id writes'),
    preview: z.boolean().optional().describe('If true: return the would-be change (current vs proposed) and write NOTHING'),
    name: z.string().optional(),
    description: z.string().optional(),
    type: z.enum(['weapon', 'armor', 'consumable', 'quest', 'misc', 'scroll']).optional(),
    weight: z.number().min(0).optional(),
    value: z.number().min(0).optional(),
    properties: z.record(z.any()).optional(),
    // #67: item_manage update replaces properties WHOLESALE — every armour
    // edit forced re-typing the full property set or losing keys silently.
    // mergeProperties folds the passed keys into the stored set instead.
    mergeProperties: z.boolean().optional().describe('If true, passed properties MERGE into stored properties (shallow) instead of replacing them wholesale. Pass a key with value null to delete it.'),
    // Play report 4 #3: the slot list as its own param — merged into the stored
    // properties even without mergeProperties; [] deletes the key.
    equipSlots: equipSlotsField(`Slots this template may be equipped in (${EQUIP_SLOTS.join(', ')}); merged into properties.equipSlots, the other properties kept. [] removes the key so ${TYPE_DEFAULTS}`)
});

const DeleteSchema = z.object({
    action: z.literal('delete'),
    itemId: z.string().describe('The ID of the item to delete'),
    expectName: z.string().optional().describe('FINDINGS #87 guard: refuse unless the row\'s name matches (case-insensitive)')
});

const CatalogSearchSchema = z.object({
    action: z.literal('catalog_search'),
    query: z.string().optional().describe('Name, source key, or category to search in the pinned Open5e SRD catalog'),
    type: z.enum(['weapon', 'armor', 'consumable', 'quest', 'misc', 'scroll']).optional(),
    limit: z.number().int().min(1).max(100).optional().default(20),
    worldId: z.string().optional().describe('Accepted for symmetry with search; the SRD catalog is not world-scoped, so it is echoed and otherwise ignored')
});

const CatalogGetSchema = z.object({
    action: z.literal('catalog_get'),
    sourceKey: z.string().describe('Open5e source key, content key, or exact item name')
});

const MaterializeSchema = z.object({
    action: z.literal('materialize'),
    sourceKey: z.string().describe('Open5e source key, content key, or exact item name to create as an engine item template')
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<ItemAction, ActionDefinition> = {
    create: {
        schema: CreateSchema,
        handler: async (params: z.infer<typeof CreateSchema>) => {
            const { itemRepo } = ensureDb();

            // Play report 4 #3: validated before the write; refusals carry writes: 'none'.
            const slots = resolveEquipSlots(params.equipSlots, params.properties);
            // Play report 5 #7: armour keys canonicalised and checked before the write.
            const armour = checkArmorProps(params.type, params.properties);
            const baseProps = armour?.properties ?? params.properties;

            const now = new Date().toISOString();
            const item = {
                name: params.name,
                type: params.type,
                description: params.description,
                weight: params.weight ?? 0,
                value: params.value ?? 0,
                properties: slots !== undefined ? withEquipSlots(baseProps, slots) : baseProps,
                ...(params.worldId ? { worldId: params.worldId } : {}),
                id: randomUUID(),
                createdAt: now,
                updatedAt: now
            };

            itemRepo.create(item);

            const aliased = armour && Object.keys(armour.aliased).length ? armour.aliased : undefined;
            return {
                success: true,
                item,
                ...(slots !== undefined ? { equipSlots: slots } : {}),
                ...(armour ? { armorProps: armour.armorProps } : {}),
                ...(aliased ? { aliased } : {}),
                message: `Item template "${item.name}" created (id at item.id; in a sequence reference it as {{<stepId>.item.id}})${slots?.length ? `; equippable in ${slots.join(', ')}` : ''}${aliased ? `; armour keys canonicalised: ${aliasNote(aliased)}` : ''}`
            };
        },
        aliases: ['new', 'add', 'template']
    },

    get: {
        schema: GetSchema,
        handler: async (params: z.infer<typeof GetSchema>) => {
            const { itemRepo } = ensureDb();

            const item = itemRepo.findById(params.itemId);
            if (!item) {
                throw new Error(`Item not found: ${params.itemId}`);
            }

            return {
                success: true,
                item
            };
        },
        aliases: ['fetch', 'find', 'read']
    },

    list: {
        schema: ListSchema,
        handler: async (params: z.infer<typeof ListSchema>) => {
            const { itemRepo } = ensureDb();

            const scope = { worldId: params.worldId, includeUnscoped: params.includeUnscoped };
            let items;
            if (params.type) {
                items = itemRepo.findByType(params.type, scope);
            } else {
                items = itemRepo.findAll(scope);
            }

            return {
                success: true,
                items,
                count: items.length,
                filter: params.type || null,
                ...(params.worldId ? { worldId: params.worldId, includeUnscoped: !!params.includeUnscoped } : {})
            };
        },
        aliases: ['all', 'show']
    },

    search: {
        schema: SearchSchema,
        handler: async (params: z.infer<typeof SearchSchema>) => {
            const { itemRepo } = ensureDb();

            // `query` is an alias of `name`; an explicit `name` wins when both arrive.
            const name = params.name ?? params.query;
            const hasFilter = name !== undefined || params.type !== undefined
                || params.minValue !== undefined || params.maxValue !== undefined || params.worldId !== undefined;

            const items = itemRepo.search({
                name,
                type: params.type,
                minValue: params.minValue,
                maxValue: params.maxValue,
                worldId: params.worldId,
                includeUnscoped: params.includeUnscoped
            });

            return {
                success: true,
                items,
                count: items.length,
                query: { ...params, ...(name !== undefined ? { name } : {}) },
                ...(hasFilter ? {} : { warning: 'no filter given; returning the whole catalogue' })
            };
        },
        aliases: ['query', 'filter', 'find_by']
    },

    scope_items: {
        schema: ScopeItemsSchema,
        handler: async (params: z.infer<typeof ScopeItemsSchema>) => {
            const { itemRepo } = ensureDb();
            if (!params.all && !params.itemIds?.length) {
                const e = new Error('scope_items needs itemIds: [...] or all: true — NOTHING was written');
                (e as Error & { writes?: string }).writes = 'none';
                throw e;
            }
            // The claim verb for legacy templates (mirrors character_manage
            // scope_scheduled): explicit ids are checked one by one, `all`
            // takes every unscoped row; an already-scoped row is never restamped.
            const claims: string[] = []; const noops: string[] = [];
            const alreadyScoped: Array<{ itemId: string; worldId: string }> = []; const missing: string[] = [];
            if (params.itemIds?.length) {
                for (const id of new Set(params.itemIds)) {
                    const row = itemRepo.findById(id);
                    if (!row) { missing.push(id); continue; }
                    if (row.worldId === params.worldId) { noops.push(id); continue; }
                    if (row.worldId) { alreadyScoped.push({ itemId: id, worldId: row.worldId }); continue; }
                    claims.push(id);
                }
            } else {
                claims.push(...itemRepo.findUnscopedIds());
            }
            let stamped = 0;
            if (!params.preview) for (const id of claims) stamped += itemRepo.scopeToWorld(id, params.worldId);
            return {
                success: true,
                actionType: 'scope_items',
                worldId: params.worldId,
                ...(params.itemIds ? { itemIds: params.itemIds } : { all: true }),
                ...(params.preview ? { preview: true, writes: 'none', wouldScope: claims.length, wouldScopeIds: claims } : { rowsScoped: stamped, scopedIds: claims }),
                ...(noops.length ? { alreadyThisWorld: noops } : {}),
                ...(alreadyScoped.length ? { alreadyScoped } : {}),
                ...(missing.length ? { missingIds: missing } : {}),
                message: params.preview
                    ? `PREVIEW — would stamp ${claims.length} template(s) to ${params.worldId}. Nothing written.`
                    : claims.length === 0
                        ? `No templates stamped (already scoped rows are never restamped).`
                        : `${stamped} template(s) stamped to world ${params.worldId}.`
            };
        },
        aliases: ['claim_items', 'stamp_items']
    },

    update: {
        schema: UpdateSchema,
        handler: async (params: z.infer<typeof UpdateSchema>) => {
            const { db, itemRepo } = ensureDb();

            const { itemId, action, mergeProperties, expectName, preview, equipSlots, ...updates } = params;

            // FINDINGS #87: guard BEFORE any write path runs.
            const target = itemRepo.findById(itemId);
            if (!target) throw new Error(`Item not found: ${itemId}`);
            if (expectName !== undefined && target.name.toLowerCase() !== expectName.toLowerCase()) {
                throw new Error(`GUARD REFUSAL: item ${itemId} is "${target.name}", not "${expectName}" — NOTHING was written. Check the id (item_manage search by name).`);
            }

            // Play report 4 #3: properties.equipSlots is checked however it
            // arrives (wholesale, merged, or the top-level param), before any write.
            const slots = resolveEquipSlots(equipSlots, updates.properties);

            // #67: shallow merge lane — stored properties survive; passed keys
            // overwrite; explicit null deletes a key. Silent wholesale loss dies.
            let mergedFrom: string[] | undefined;
            if (mergeProperties && updates.properties) {
                const base = { ...((target.properties as Record<string, unknown>) ?? {}) };
                mergedFrom = Object.keys(base);
                for (const [k, v] of Object.entries(updates.properties)) {
                    if (v === null) delete base[k];
                    else base[k] = v;
                }
                updates.properties = base;
            }

            // Play report 4 #3: equipSlots rides on whatever properties the
            // write would otherwise leave — the merged set, the wholesale
            // replacement, or the stored set when no properties were passed.
            if (slots !== undefined) {
                updates.properties = withEquipSlots(updates.properties ?? (target.properties as Record<string, unknown> | undefined), slots);
            }

            // Play report 5 #7: the properties the write would leave (merged or
            // wholesale) are canonicalised and checked before the journal write.
            const armour = checkArmorProps(updates.type ?? target.type, updates.properties);
            if (armour) updates.properties = armour.properties;
            const aliased = armour && Object.keys(armour.aliased).length ? armour.aliased : undefined;

            // FINDINGS #87: preview lane — the diff, no write.
            if (preview) {
                const proposed: Record<string, { from: unknown; to: unknown }> = {};
                for (const [k, v] of Object.entries(updates)) {
                    if (v !== undefined) proposed[k] = { from: (target as Record<string, unknown>)[k], to: v };
                }
                return {
                    success: true,
                    preview: true,
                    itemId,
                    itemName: target.name,
                    wouldChange: proposed,
                    message: `PREVIEW ONLY — nothing written. ${Object.keys(proposed).length} field(s) would change on "${target.name}".`
                };
            }

            // FINDINGS #88: journal the prior row — every update is revertable.
            const journalId = journalSnapshot(db, 'items', itemId, 'update', 'item_manage update');

            const item = itemRepo.update(itemId, updates);

            if (!item) {
                throw new Error(`Item not found: ${itemId}`);
            }

            const slotNote = slots === undefined ? ''
                : slots.length ? `; equippable in ${slots.join(', ')}`
                    : `; equipSlots cleared — ${TYPE_DEFAULTS}`;
            return {
                success: true,
                item,
                journalId,
                ...(mergedFrom && { propertyMerge: { preservedKeys: mergedFrom, mode: 'shallow-merge' } }),
                ...(slots !== undefined ? { equipSlots: slots } : {}),
                ...(armour ? { armorProps: armour.armorProps } : {}),
                ...(aliased ? { aliased } : {}),
                message: `Item "${item.name}" updated${mergedFrom ? ' (properties merged, not replaced)' : ''}${slotNote}${aliased ? `; armour keys canonicalised: ${aliasNote(aliased)}` : ''} — revertable: session_manage revert {writeId:${journalId}}`
            };
        },
        aliases: ['modify', 'edit', 'patch']
    },

    delete: {
        schema: DeleteSchema,
        handler: async (params: z.infer<typeof DeleteSchema>) => {
            const { db, itemRepo } = ensureDb();

            const existing = itemRepo.findById(params.itemId);
            if (!existing) {
                throw new Error(`Item not found: ${params.itemId}`);
            }
            // FINDINGS #87: destructive-write guard on the hardest write of all.
            if (params.expectName !== undefined && existing.name.toLowerCase() !== params.expectName.toLowerCase()) {
                throw new Error(`GUARD REFUSAL: item ${params.itemId} is "${existing.name}", not "${params.expectName}" — NOTHING was deleted.`);
            }

            // FINDINGS #88: journal before delete — the row can come back whole.
            const journalId = journalSnapshot(db, 'items', params.itemId, 'delete', 'item_manage delete');

            itemRepo.delete(params.itemId);

            return {
                success: true,
                deletedItem: existing,
                journalId,
                message: `Item "${existing.name}" deleted — revertable: session_manage revert {writeId:${journalId}}`
            };
        },
        aliases: ['remove', 'destroy']
    },

    catalog_search: {
        schema: CatalogSearchSchema,
        handler: async (params: z.infer<typeof CatalogSearchSchema>) => {
            const items = searchOpen5eItems({
                query: params.query,
                type: params.type,
                limit: params.limit
            }).map((item) => ({
                ...item,
                value: item.valueCopper / 100
            }));

            return {
                success: true,
                actionType: 'catalog_search',
                items,
                count: items.length,
                query: params.query ?? null,
                filter: params.type ?? null,
                ...(params.worldId ? { worldId: params.worldId } : {}),
                catalogOnly: true,
                message: 'Pinned Open5e SRD results; call materialize before giving an item to a character.'
            };
        },
        aliases: ['source_search', 'srd_search']
    },

    catalog_get: {
        schema: CatalogGetSchema,
        handler: async (params: z.infer<typeof CatalogGetSchema>) => {
            const catalogItem = findOpen5eItem(params.sourceKey);
            if (!catalogItem) throw new Error(`Open5e SRD item not found: ${params.sourceKey}`);

            return {
                success: true,
                actionType: 'catalog_get',
                catalogItem: {
                    ...catalogItem,
                    value: catalogItem.valueCopper / 100
                },
                catalogOnly: true,
                message: 'Call materialize to create the authoritative engine item template.'
            };
        },
        aliases: ['source_get', 'srd_get']
    },

    materialize: {
        schema: MaterializeSchema,
        handler: async (params: z.infer<typeof MaterializeSchema>) => {
            const { itemRepo } = ensureDb();
            const materialized = materializeOpen5eItem(itemRepo, params.sourceKey);

            return {
                success: true,
                actionType: 'materialize',
                item: materialized.item,
                created: materialized.created,
                sourceKey: materialized.sourceItem.sourceKey,
                message: materialized.created
                    ? `Materialized source-backed item "${materialized.item.name}"`
                    : `Refreshed source-backed item "${materialized.item.name}"`
            };
        },
        aliases: ['source_create', 'srd_create']
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

export const ItemManageTool = {
    name: 'item_manage',
    description: `Manage item templates (definitions, not instances).

📦 ITEM WORKFLOW:
1. create - Define a custom item template (weight/value default 0; fractions like 0.35 gp are kept). The reply's id is at item.id; in a batch_manage sequence reference it as {{step1.item.id}}
2. catalog_search/catalog_get - Read exact pinned SRD definitions without mutating state
3. materialize - Create or refresh a deterministic source-backed template
4. Then use inventory_manage to give items to characters

🌍 WORLD SCOPE: pass worldId on create/search/list to keep one campaign's templates apart. With worldId, reads return that world's rows only; add includeUnscoped: true to also see legacy rows with no world. scope_items {worldId, itemIds | all: true} stamps legacy rows (never restamps a scoped row).
🔍 search: name or query (alias) for a partial name match, plus type/minValue/maxValue/worldId. No filter at all returns the whole catalogue with a warning.

🗡️ ITEM TYPES:
- weapon: Attack bonuses, damage dice in properties
- armor: baseAC, armorCategory and the DEX cap for armor class calculation (see ARMOR PROPERTIES)
- consumable: One-use items (potions, scrolls)
- quest/misc: Story items and general goods

⚔️ WEAPON PROPERTIES EXAMPLE:
{ attackBonus: 1, damageDice: "1d8", damageType: "slashing" }

🛡️ ARMOR PROPERTIES: { baseAC: 13, armorCategory: 'medium', maxDexBonus: 2, strengthRequired?: 13, stealthDisadvantage?: true }; a shield is { armorCategory: 'shield', acBonus: 2 } (equips in the offhand). DEX cap: maxDexBonus when written, else from the category (heavy: no DEX; medium: cap 2; light: full DEX). Aliases are rewritten to these keys on create/update and named in the reply's aliased: baseAc, base_ac, ac, armorClass → baseAC; maxDex, dexCap → maxDexBonus; category, armorType → armorCategory; strReq → strengthRequired; stealth_disadvantage → stealthDisadvantage. A typo in armorCategory is refused with the nearest name, a base that is not a non-negative integer is refused, two spellings that disagree are refused — nothing written. Any equipped item's acBonus adds to AC (magic armour, rings). stealthDisadvantage puts the wearer's Stealth checks at disadvantage (math_manage, eavesdropping); a strengthRequired above the wearer's STR is reported on equip (5e speed -10 ft, not applied). character_manage naturalArmor {base, addDex} is the floor worn armour must beat

🧷 EQUIP SLOTS: ${EQUIP_SLOTS.join(', ')}. By type a weapon equips in mainhand/offhand and armor in armor (offhand with acBonus); anything else (misc, consumable, quest, scroll), or a different slot, needs properties.equipSlots. Pass equipSlots: ['accessory'] on create or update — update merges it into the stored properties (other keys kept, no mergeProperties needed); equipSlots: [] removes the key so the type defaults return. properties: {equipSlots: [...]} works too and is validated the same way: an unknown slot is refused with the nearest slot and nothing written. An inventory_manage equip refusal prints the exact update call to run.

✏️ UPDATE PROPERTIES: update {properties} REPLACES the stored set wholesale. update {properties, mergeProperties: true} merges the passed keys into the stored set (shallow; a key set to null is deleted) and the reply's propertyMerge names the keys that were preserved. Both are journaled and revertable; preview: true shows the diff and writes nothing.

Actions: ${ACTIONS.join(', ')}
Aliases: new→create, fetch→get, query→search`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action to perform: ${ACTIONS.join(', ')}`),
        itemId: z.string().optional().describe('Item ID (for get, update, delete)'),
        name: z.string().optional().describe('Item name'),
        type: z.enum(['weapon', 'armor', 'consumable', 'quest', 'misc', 'scroll']).optional().describe('Item type'),
        description: z.string().optional().describe('Item description'),
        weight: z.number().optional().describe('Item weight in lbs'),
        value: z.number().optional().describe('Item value in gp'),
        properties: z.record(z.any()).optional().describe('Additional properties'),
        mergeProperties: z.boolean().optional().describe('update: MERGE passed properties into stored set (shallow) instead of wholesale replace; null value deletes a key'),
        // Play report 4 #3 (mirror law): equipSlots on create/update
        equipSlots: equipSlotsField(`create/update: slots the template may be equipped in (${EQUIP_SLOTS.join(', ')}) — written to properties.equipSlots; update merges it, [] clears it`),
        // FINDINGS #87 (mirror law): the destructive-write guard params
        expectName: z.string().optional().describe('update/delete guard: refuse unless the row\'s name matches (case-insensitive) — names what IS there on refusal'),
        preview: z.boolean().optional().describe('update: return the field-by-field diff, write NOTHING'),
        minValue: z.number().optional().describe('Minimum value for search'),
        maxValue: z.number().optional().describe('Maximum value for search'),
        sourceKey: z.string().optional().describe('Pinned Open5e source key/name (for catalog_get or materialize)'),
        query: z.string().optional().describe('search: alias of name (partial match). catalog_search: catalog search text'),
        limit: z.number().int().optional().describe('Maximum catalog results (1-100)'),
        worldId: z.string().optional().describe('create: world this template belongs to. search/list: only that world\'s rows. scope_items: world to stamp'),
        includeUnscoped: z.boolean().optional().describe('search/list with worldId: also return legacy rows with no world'),
        itemIds: z.array(z.string()).optional().describe('scope_items: rows to stamp by id'),
        all: z.boolean().optional().describe('scope_items: stamp every unscoped template')
    })
};

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export async function handleItemManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    const result = await router(args as Record<string, unknown>);

    // The router already returns McpResponse format
    // But we want to add rich formatting
    const parsed = JSON.parse(result.content[0].text);

    let output = '';

    if (parsed.error) {
        output = RichFormatter.header('Error', '❌');
        output += RichFormatter.alert(parsed.message || 'Unknown error', 'error');
        // Play report 4 #3: a refusal that asserted write-freedom says so on the card.
        if (parsed.writes === 'none') output += RichFormatter.alert('NO WRITE', 'info');
        if (parsed.suggestions) {
            output += '\n**Did you mean:**\n';
            parsed.suggestions.forEach((s: { value: string; similarity: number }) => {
                output += `  • ${s.value} (${s.similarity}% match)\n`;
            });
        }
    } else if (parsed.catalogItem) {
        const item = parsed.catalogItem;
        output = RichFormatter.header(`${item.name} (SRD Catalog)`, 'ðŸ“š');
        output += RichFormatter.keyValue({
            'Source Key': item.sourceKey,
            'Type': item.type,
            'Weight': `${item.weight} lbs`,
            'Value': `${item.value} gp`
        });
        if (item.description) output += `\n${item.description}\n`;
        output += RichFormatter.alert(parsed.message, 'info');
    } else if (parsed.item) {
        const item = parsed.item;
        output = RichFormatter.header(item.name || 'Item', '📦');
        output += RichFormatter.keyValue({
            'ID': `\`${item.id}\``,
            'Type': item.type,
            'Weight': `${item.weight} lbs`,
            'Value': `${item.value} gp`,
            ...(Array.isArray(item.properties?.equipSlots) ? { 'Equips in': item.properties.equipSlots.join(', ') } : {}),
        });
        if (item.description) {
            output += `\n${item.description}\n`;
        }
        if (parsed.message) {
            output += RichFormatter.success(parsed.message);
        }
    } else if (parsed.items) {
        output = RichFormatter.header('Items', '📦');
        if (parsed.filter) {
            output += RichFormatter.keyValue({ 'Filter': parsed.filter });
        }
        if (parsed.query) {
            const queryInfo: Record<string, unknown> = {};
            if (typeof parsed.query === 'string') {
                queryInfo['Query'] = parsed.query;
            } else {
                if (parsed.query.name) queryInfo['Name'] = parsed.query.name;
                if (parsed.query.type) queryInfo['Type'] = parsed.query.type;
                if (parsed.query.minValue !== undefined) queryInfo['Min Value'] = parsed.query.minValue;
                if (parsed.query.maxValue !== undefined) queryInfo['Max Value'] = parsed.query.maxValue;
            }
            output += RichFormatter.keyValue(queryInfo);
        }
        if (parsed.items.length === 0) {
            output += RichFormatter.alert('No items found.', 'info');
        } else {
            const rows = parsed.items.map((i: { name: string; type: string; weight: number; value: number }) =>
                [i.name, i.type, `${i.weight}`, `${i.value} gp`]
            );
            output += RichFormatter.table(['Name', 'Type', 'Weight', 'Value'], rows);
            output += `\n*${parsed.count} item(s) total*\n`;
        }
    } else if (parsed.deletedItem) {
        output = RichFormatter.header('Item Deleted', '🗑️');
        output += RichFormatter.keyValue({
            'Name': parsed.deletedItem.name,
            'ID': `\`${parsed.deletedItem.id}\``,
        });
        output += RichFormatter.success(parsed.message);
    }

    output += RichFormatter.embedJson(parsed, 'ITEM_MANAGE');

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}
