import { z } from 'zod';

// Party status enum
export const PartyStatusSchema = z.enum(['active', 'dormant', 'archived']);
export type PartyStatus = z.infer<typeof PartyStatusSchema>;

// Member role enum
export const MemberRoleSchema = z.enum(['leader', 'member', 'companion', 'hireling', 'prisoner', 'mount']);
export type MemberRole = z.infer<typeof MemberRoleSchema>;

// Character type enum (to distinguish PCs from NPCs/enemies)
export const CharacterTypeSchema = z.enum(['pc', 'npc', 'enemy', 'neutral']);
export type CharacterType = z.infer<typeof CharacterTypeSchema>;

// Party schema
export const PartySchema = z.object({
    id: z.string(),
    name: z.string().min(1),
    description: z.string().optional(),
    worldId: z.string().optional(),
    status: PartyStatusSchema.default('active'),
    currentLocation: z.string().optional(),
    currentQuestId: z.string().optional(),
    formation: z.string().default('standard'),
    // NEW: Position fields for world map location tracking
    positionX: z.number().int().nonnegative().optional(),
    positionY: z.number().int().nonnegative().optional(),
    currentPOI: z.string().optional(), // Structure ID if at a POI
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastPlayedAt: z.string().datetime().optional(),
});

export type Party = z.infer<typeof PartySchema>;

// Party member junction schema
export const PartyMemberSchema = z.object({
    id: z.string(),
    partyId: z.string(),
    characterId: z.string(),
    role: MemberRoleSchema.default('member'),
    isActive: z.boolean().default(false),
    position: z.number().int().optional(),
    sharePercentage: z.number().int().min(0).max(100).default(100),
    joinedAt: z.string().datetime(),
    notes: z.string().optional(),
    // Item 7: the warband. Unset loyalty reads 5.
    loyalty: z.number().int().min(0).max(10).nullable().optional(),
    wage: z.number().min(0).nullable().optional(),
    payMode: z.enum(['wage', 'share', 'none']).nullable().optional(),
    unitModels: z.number().int().min(0).nullable().optional(),
});

export type PartyMember = z.infer<typeof PartyMemberSchema>;

// Extended party member with embedded character data
export const PartyMemberWithCharacterSchema = PartyMemberSchema.extend({
    character: z.object({
        id: z.string(),
        name: z.string(),
        hp: z.number(),
        maxHp: z.number(),
        ac: z.number(),
        level: z.number(),
        stats: z.object({
            str: z.number(),
            dex: z.number(),
            con: z.number(),
            int: z.number(),
            wis: z.number(),
            cha: z.number(),
        }),
        behavior: z.string().optional(),
        characterType: CharacterTypeSchema.optional(),
    }),
});

export type PartyMemberWithCharacter = z.infer<typeof PartyMemberWithCharacterSchema>;

// Full party with embedded members
export const PartyWithMembersSchema = PartySchema.extend({
    members: z.array(PartyMemberWithCharacterSchema),
    leader: PartyMemberWithCharacterSchema.optional(),
    activeCharacter: PartyMemberWithCharacterSchema.optional(),
    memberCount: z.number().int(),
});

export type PartyWithMembers = z.infer<typeof PartyWithMembersSchema>;

// NEW: Party position type
export interface PartyPosition {
    x: number;
    y: number;
    locationName: string;
    poiId?: string;
}

// Party context for LLM (optimized structure)
export const PartyContextSchema = z.object({
    party: z.object({
        id: z.string(),
        name: z.string(),
        status: PartyStatusSchema,
        location: z.string().optional(),
        formation: z.string(),
    }),
    leader: z.object({
        id: z.string(),
        name: z.string(),
        hp: z.number(),
        maxHp: z.number(),
        level: z.number(),
    }).optional(),
    activeCharacter: z.object({
        id: z.string(),
        name: z.string(),
        hp: z.number(),
        maxHp: z.number(),
        level: z.number(),
        conditions: z.array(z.string()).optional(),
    }).optional(),
    members: z.array(z.object({
        name: z.string(),
        role: MemberRoleSchema,
        hp: z.string(), // "85/85" format for compactness
        status: z.string().optional(),
    })),
    activeQuest: z.object({
        name: z.string(),
        currentObjective: z.string().optional(),
        progress: z.string().optional(),
    }).optional(),
    recentEvents: z.array(z.string()).optional(),
});

export type PartyContext = z.infer<typeof PartyContextSchema>;
