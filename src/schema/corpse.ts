import { z } from 'zod';

/**
 * FAILED-004: Corpse/Loot System Schema
 * Tracks corpses, loot tables, and harvestable resources
 */

export const CorpseStateSchema = z.enum(['fresh', 'decaying', 'skeletal', 'gone']);
export type CorpseState = z.infer<typeof CorpseStateSchema>;

export const CorpseSchema = z.object({
    id: z.string(),
    characterId: z.string().describe('Original character/creature ID'),
    characterName: z.string(),
    characterType: z.enum(['pc', 'npc', 'enemy', 'neutral']),
    creatureType: z.string().optional().describe('Creature type for loot table lookup (e.g., "goblin", "dragon")'),
    cr: z.number().optional().describe('Challenge rating for loot scaling'),

    // Location
    worldId: z.string().nullable(),
    regionId: z.string().nullable(),
    position: z.object({
        x: z.number(),
        y: z.number()
    }).nullable(),
    encounterId: z.string().nullable().describe('Encounter where death occurred'),

    // State
    state: CorpseStateSchema.default('fresh'),
    stateUpdatedAt: z.string().datetime(),

    // Loot
    lootGenerated: z.boolean().default(false),
    looted: z.boolean().default(false),
    lootedBy: z.string().nullable(),
    lootedAt: z.string().datetime().nullable(),

    // Currency (from loot generation)
    currency: z.object({
        gold: z.number().min(0).default(0),
        silver: z.number().int().min(0).default(0),
        copper: z.number().int().min(0).default(0)
    }).default({ gold: 0, silver: 0, copper: 0 }),
    currencyLooted: z.boolean().default(false),

    // Harvesting
    harvestable: z.boolean().default(false),
    harvestableResources: z.array(z.object({
        resourceType: z.string(),
        quantity: z.number().int(),
        harvested: z.boolean().default(false)
    })).default([]),

    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
});

export type Corpse = z.infer<typeof CorpseSchema>;

export const LootTableEntrySchema = z.object({
    itemId: z.string().nullable().describe('Specific item ID, or null for template-based'),
    itemTemplateId: z.string().nullable().describe('Item template to instantiate'),
    itemName: z.string().optional().describe('Name for dynamic item creation'),
    quantity: z.object({
        min: z.number().int().min(0),
        max: z.number().int().min(0)
    }),
    weight: z.number().min(0).max(1).describe('Drop probability 0-1'),
    conditions: z.array(z.string()).optional().describe('Conditions for this drop')
});

export type LootTableEntry = z.infer<typeof LootTableEntrySchema>;

export const LootTableSchema = z.object({
    id: z.string(),
    name: z.string(),
    creatureTypes: z.array(z.string()).describe('Creature types this applies to (e.g., "goblin", "dragon")'),
    crRange: z.object({
        min: z.number().min(0),
        max: z.number().min(0)
    }).optional(),
    guaranteedDrops: z.array(LootTableEntrySchema).default([]),
    randomDrops: z.array(LootTableEntrySchema).default([]),
    currencyRange: z.object({
        gold: z.object({ min: z.number(), max: z.number() }),
        silver: z.object({ min: z.number(), max: z.number() }).optional(),
        copper: z.object({ min: z.number(), max: z.number() }).optional()
    }).optional(),
    harvestableResources: z.array(z.object({
        resourceType: z.string(),
        quantity: z.object({ min: z.number(), max: z.number() }),
        dcRequired: z.number().int().optional()
    })).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
});

export type LootTable = z.infer<typeof LootTableSchema>;

// Corpse decay rules (in game hours)
export const CORPSE_DECAY_RULES = {
    fresh_to_decaying: 24,    // 1 day
    decaying_to_skeletal: 168, // 1 week
    skeletal_to_gone: 720      // 30 days
};

// Default loot tables
export const DEFAULT_LOOT_TABLES: Omit<LootTable, 'id' | 'createdAt' | 'updatedAt'>[] = [
    {
        name: 'Goblin Loot',
        creatureTypes: ['goblin', 'hobgoblin'],
        crRange: { min: 0, max: 2 },
        guaranteedDrops: [],
        randomDrops: [
            { itemId: null, itemTemplateId: null, itemName: 'Rusty Scimitar', quantity: { min: 0, max: 1 }, weight: 0.3 },
            { itemId: null, itemTemplateId: null, itemName: 'Shortbow', quantity: { min: 0, max: 1 }, weight: 0.2 },
            { itemId: null, itemTemplateId: null, itemName: 'Crude Arrow', quantity: { min: 1, max: 10 }, weight: 0.5 }
        ],
        currencyRange: {
            gold: { min: 0, max: 2 },
            silver: { min: 1, max: 10 },
            copper: { min: 5, max: 30 }
        },
        harvestableResources: [
            { resourceType: 'goblin ear', quantity: { min: 1, max: 2 }, dcRequired: 10 }
        ]
    },
    {
        name: 'Orc Loot',
        creatureTypes: ['orc', 'orog'],
        crRange: { min: 0.5, max: 3 },
        guaranteedDrops: [],
        randomDrops: [
            { itemId: null, itemTemplateId: null, itemName: 'Greataxe', quantity: { min: 0, max: 1 }, weight: 0.4 },
            { itemId: null, itemTemplateId: null, itemName: 'Javelin', quantity: { min: 1, max: 4 }, weight: 0.5 }
        ],
        currencyRange: {
            gold: { min: 1, max: 5 },
            silver: { min: 5, max: 20 }
        },
        harvestableResources: [
            { resourceType: 'orc tusk', quantity: { min: 1, max: 2 }, dcRequired: 12 }
        ]
    },
    {
        name: 'Dragon Loot',
        creatureTypes: ['dragon', 'drake', 'wyvern'],
        crRange: { min: 5, max: 30 },
        guaranteedDrops: [
            { itemId: null, itemTemplateId: null, itemName: 'Dragon Scale', quantity: { min: 3, max: 10 }, weight: 1.0 }
        ],
        randomDrops: [
            { itemId: null, itemTemplateId: null, itemName: 'Dragon Tooth', quantity: { min: 1, max: 4 }, weight: 0.6 },
            { itemId: null, itemTemplateId: null, itemName: 'Dragon Blood Vial', quantity: { min: 0, max: 2 }, weight: 0.3 }
        ],
        currencyRange: {
            gold: { min: 500, max: 5000 }
        },
        harvestableResources: [
            { resourceType: 'dragon hide', quantity: { min: 5, max: 20 }, dcRequired: 15 },
            { resourceType: 'dragon heart', quantity: { min: 1, max: 1 }, dcRequired: 20 }
        ]
    },
    {
        name: 'Undead Loot',
        creatureTypes: ['skeleton', 'zombie', 'ghoul'],
        crRange: { min: 0, max: 5 },
        guaranteedDrops: [],
        randomDrops: [
            { itemId: null, itemTemplateId: null, itemName: 'Bone Fragment', quantity: { min: 1, max: 5 }, weight: 0.7 },
            { itemId: null, itemTemplateId: null, itemName: 'Tattered Cloth', quantity: { min: 0, max: 1 }, weight: 0.3 }
        ],
        currencyRange: {
            gold: { min: 0, max: 3 },
            silver: { min: 0, max: 10 }
        },
        harvestableResources: [
            { resourceType: 'ectoplasm', quantity: { min: 0, max: 1 }, dcRequired: 14 }
        ]
    },
    {
        name: 'Wolf Loot',
        creatureTypes: ['wolf', 'dire wolf', 'worg'],
        crRange: { min: 0.25, max: 3 },
        guaranteedDrops: [],
        randomDrops: [],
        currencyRange: undefined,
        harvestableResources: [
            { resourceType: 'wolf pelt', quantity: { min: 1, max: 1 }, dcRequired: 10 },
            { resourceType: 'wolf fang', quantity: { min: 2, max: 4 }, dcRequired: 8 }
        ]
    }
];
