/**
 * Consolidated spawn_manage tool
 * Replaces: spawn_equipped_character, spawn_populated_location, spawn_preset_encounter, spawn_preset_location, setup_tactical_encounter
 * 5 tools → 1 tool with 5 actions
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { matchAction, isGuidingError } from '../../utils/fuzzy-enum.js';

export interface McpResponse {
    content: Array<{ type: 'text'; text: string }>;
}
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { PartyRepository } from '../../storage/repos/party.repo.js';
import { EncounterRepository } from '../../storage/repos/encounter.repo.js';
import { SpatialRepository } from '../../storage/repos/spatial.repo.js';
import { PoiRepository } from '../../storage/repos/poi.repo.js';
import { SessionContext } from '../types.js';
import { CombatEngine, CombatParticipant } from '../../engine/combat/engine.js';
import { getCombatManager } from '../state/combat-manager.js';
// generateEncounterMap removed - using local simple renderer
import { expandCreatureTemplate } from '../../data/creature-presets.js';
import { getPatternGenerator } from '../terrain-patterns.js';

// Pattern type inline definition
type TerrainPatternName = 'river_valley' | 'canyon' | 'arena' | 'mountain_pass' | 'maze' | 'maze_rooms';

// Simple ASCII map generator for spawned encounters
function generateEncounterMap(encounterData: { state: { tokens?: Array<{ position?: { x: number; y: number }; type?: string }>; participants?: Array<{ position?: { x: number; y: number }; name: string; isEnemy?: boolean }> } }, width: number, height: number): string {
    const state = encounterData.state;
    const grid: string[][] = [];
    
    // Initialize empty grid
    for (let y = 0; y < height; y++) {
        grid[y] = [];
        for (let x = 0; x < width; x++) {
            grid[y][x] = '.';
        }
    }
    
    // Place tokens
    if (state.tokens) {
        for (const token of state.tokens) {
            if (token.position && token.position.x >= 0 && token.position.x < width && 
                token.position.y >= 0 && token.position.y < height) {
                const symbol = token.type === 'pc' ? '@' : token.type === 'enemy' ? 'E' : 'N';
                grid[token.position.y][token.position.x] = symbol;
            }
        }
    }
    
    // Build ASCII output
    const lines: string[] = [];
    lines.push('┌' + '─'.repeat(width) + '┐');
    for (const row of grid) {
        lines.push('│' + row.join('') + '│');
    }
    lines.push('└' + '─'.repeat(width) + '┘');
    
    return lines.join('\n');
}
import { parsePosition } from '../../utils/schema-shorthand.js';
import { ENCOUNTER_PRESETS, EncounterPreset, getEncountersByTag, getEncountersForLevel, scaleEncounter } from '../../data/encounter-presets.js';
import { Character, CharacterOriginSchema } from '../../schema/character.js';

// Helper function to build a complete Character object
function buildCharacter(data: {
    id: string;
    name: string;
    stats: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
    hp: number;
    maxHp: number;
    ac: number;
    level: number;
    characterType: 'pc' | 'npc' | 'enemy' | 'ally';
    race: string;
    characterClass: string;
    resistances?: string[];
    vulnerabilities?: string[];
    immunities?: string[];
    origin?: z.infer<typeof CharacterOriginSchema>;
    position?: { x: number; y: number };
    inventory?: string[];
    createdAt: string;
    updatedAt: string;
}): Character {
    return {
        id: data.id,
        name: data.name,
        stats: data.stats,
        hp: data.hp,
        maxHp: data.maxHp,
        ac: data.ac,
        level: data.level,
        xp: 0,
        characterType: data.characterType as any,
        race: data.race,
        characterClass: data.characterClass,
        conditions: [],
        perceptionBonus: 0,
        stealthBonus: 0,
        knownSpells: [],
        preparedSpells: [],
        cantripsKnown: [],
        maxSpellLevel: 0,
        concentratingOn: null,
        activeSpells: [],
        resistances: data.resistances || [],
        vulnerabilities: data.vulnerabilities || [],
        immunities: data.immunities || [],
        resourcePools: {},
        skillProficiencies: [],
        saveProficiencies: [],
        expertise: [],
        armorProficiencies: [],
        weaponProficiencies: [],
        toolProficiencies: [],
        languages: [],
        currency: { gold: 0, silver: 0, copper: 0 },
        origin: data.origin,
        hasLairActions: false,
        position: data.position,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt
    };
}

const ACTIONS = [
    'spawn_character', 'spawn_location', 'spawn_encounter',
    'spawn_preset_location', 'spawn_tactical', 'update_poi_room'
] as const;

type SpawnAction = typeof ACTIONS[number];

function ensureDb() {
    const db = getDb();
    return {
        db,
        charRepo: new CharacterRepository(db),
        partyRepo: new PartyRepository(db),
        encounterRepo: new EncounterRepository(db),
        spatialRepo: new SpatialRepository(db),
        poiRepo: new PoiRepository(db)
    };
}

// Alias map for fuzzy action matching
const ALIASES: Record<string, SpawnAction> = {
    'rename_room': 'update_poi_room',
    'rename_poi_room': 'update_poi_room',
    'poi_room': 'update_poi_room',
    'character': 'spawn_character',
    'create_character': 'spawn_character',
    'spawn_equipped': 'spawn_character',
    'equipped_character': 'spawn_character',
    'location': 'spawn_location',
    'populated_location': 'spawn_location',
    'spawn_populated': 'spawn_location',
    'encounter': 'spawn_encounter',
    'preset_encounter': 'spawn_encounter',
    'random_encounter': 'spawn_encounter',
    'preset_location': 'spawn_preset_location',
    'preset': 'spawn_preset_location',
    'location_preset': 'spawn_preset_location',
    'tactical': 'spawn_tactical',
    'tactical_encounter': 'spawn_tactical',
    'setup_tactical': 'spawn_tactical',
    'combat_setup': 'spawn_tactical'
};

// Input schema combining all spawn actions
const SpawnManageInputSchema = z.object({
    action: z.string().describe('Action: spawn_character, spawn_location, spawn_encounter, spawn_preset_location, spawn_tactical'),

    // Common fields
    name: z.string().optional().describe('Name for spawned entity'),
    worldId: z.string().optional().describe('World ID for location spawning'),

    // spawn_character fields
    template: z.string().optional().describe('Creature template (e.g., "goblin", "orc_warrior")'),
    equipment: z.array(z.string()).optional().describe('Equipment to give the character'),
    position: z.string().optional().describe('Position as "x,y" string'),
    characterType: z.enum(['pc', 'npc', 'enemy', 'ally']).optional().default('enemy'),
    origin: CharacterOriginSchema.optional(),

    // spawn_location fields (populated)
    locationType: z.string().optional().describe('Location type (tavern, shop, temple, etc.)'),
    npcs: z.array(z.object({
        name: z.string(),
        role: z.string(),
        race: z.string().optional().default('Human'),
        behavior: z.string().optional()
    })).optional().describe('NPCs to spawn in location'),
    rooms: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        exits: z.array(z.string()).optional()
    })).optional().describe('Rooms in the location'),

    // spawn_encounter fields
    preset: z.string().optional().describe('Encounter preset ID'),
    random: z.boolean().optional().describe('Select random encounter'),
    difficulty: z.enum(['easy', 'medium', 'hard', 'deadly']).optional(),
    level: z.number().int().min(1).max(20).optional(),
    tags: z.array(z.string()).optional().describe('Tags to filter random encounters'),
    partySize: z.number().int().min(1).max(10).optional().default(4),
    partyLevel: z.number().int().min(1).max(20).optional(),
    partyId: z.string().optional().describe('Party ID for encounter setup'),
    partyPositions: z.array(z.string()).optional().describe('Party starting positions'),
    seed: z.string().optional().describe('Random seed for determinism'),

    // spawn_preset_location fields
    x: z.number().int().min(0).optional().describe('X coordinate'),
    y: z.number().int().min(0).optional().describe('Y coordinate'),
    customName: z.string().optional().describe('Override default name'),
    // FINDINGS #84: update_poi_room — POI-layer rooms had no update verb;
    // preset shells were stuck with their spawn names forever.
    poiId: z.string().optional().describe('update_poi_room: the POI whose room to rename'),
    roomName: z.string().optional().describe('update_poi_room: CURRENT name of the room to change'),
    newName: z.string().optional().describe('update_poi_room: new room name'),
    newDescription: z.string().optional().describe('update_poi_room: new room description'),
    newPoiName: z.string().optional().describe('FINDINGS #107: update_poi_room — rename the POI ROW itself (alone, or alongside a room edit). The repair lane for preset-named POIs'),
    spawnNpcs: z.boolean().optional().default(false),
    discoveryState: z.enum(['unknown', 'rumored', 'discovered', 'explored', 'mapped']).optional().default('discovered'),

    // spawn_tactical fields
    participants: z.array(z.object({
        template: z.string().describe('Creature template'),
        name: z.string().optional(),
        position: z.string().describe('Position as "x,y"'),
        isEnemy: z.boolean().optional().default(true)
    })).optional().describe('Combat participants'),
    terrain: z.object({
        obstacles: z.array(z.string()).optional(),
        difficultTerrain: z.array(z.string()).optional(),
        water: z.array(z.string()).optional(),
        pattern: z.string().optional()
    }).optional().describe('Terrain configuration'),
    gridSize: z.object({
        width: z.number().int().min(5).max(100).default(20),
        height: z.number().int().min(5).max(100).default(20)
    }).optional().describe('Combat grid dimensions')
});

type SpawnManageInput = z.infer<typeof SpawnManageInputSchema>;

const SpawnManageActionSchemas = {
    spawn_character: {
        schema: SpawnManageInputSchema.extend({
            action: z.literal('spawn_character'),
            template: z.string().describe('Creature template (e.g., "goblin", "orc_warrior")')
        }),
        aliases: ['character', 'create_character', 'spawn_equipped', 'equipped_character'],
        description: 'Spawn an equipped character from a creature template'
    },
    spawn_location: {
        schema: SpawnManageInputSchema.extend({ action: z.literal('spawn_location') }),
        aliases: ['location', 'populated_location', 'spawn_populated'],
        description: 'Spawn a populated location with optional NPCs and rooms'
    },
    spawn_encounter: {
        schema: SpawnManageInputSchema.extend({
            action: z.literal('spawn_encounter')
        }).refine(args => Boolean(args.preset || args.random), {
            message: 'spawn_encounter requires preset or random=true',
            path: ['preset']
        }),
        aliases: ['encounter', 'preset_encounter', 'random_encounter'],
        description: 'Spawn an encounter from a preset or random encounter filter'
    },
    spawn_preset_location: {
        schema: SpawnManageInputSchema.extend({
            action: z.literal('spawn_preset_location'),
            worldId: z.string().describe('World ID for location spawning'),
            preset: z.string().describe('Location preset ID'),
            x: z.number().int().min(0).describe('X coordinate'),
            y: z.number().int().min(0).describe('Y coordinate')
        }),
        aliases: ['preset_location', 'preset', 'location_preset'],
        description: 'Spawn a preset location at world coordinates'
    },
    spawn_tactical: {
        schema: SpawnManageInputSchema.extend({
            action: z.literal('spawn_tactical'),
            participants: z.array(z.object({
                template: z.string().describe('Creature template'),
                name: z.string().optional(),
                position: z.string().describe('Position as "x,y"'),
                isEnemy: z.boolean().optional().default(true)
            })).min(1).describe('Combat participants')
        }),
        aliases: ['tactical', 'tactical_encounter', 'setup_tactical', 'combat_setup'],
        description: 'Set up a tactical encounter with explicit participants'
    }
};

// Action handlers
async function handleSpawnCharacter(input: SpawnManageInput, _ctx: SessionContext): Promise<McpResponse> {
    const { charRepo } = ensureDb();
    const now = new Date().toISOString();

    if (!input.template) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('spawn_character requires template parameter') +
                    RichFormatter.embedJson({ error: true, message: 'template required' }, 'SPAWN_MANAGE')
            }]
        };
    }

    const preset = expandCreatureTemplate(input.template, input.name);
    if (!preset) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(`Unknown creature template: ${input.template}`) +
                    RichFormatter.embedJson({ error: true, message: `Unknown template: ${input.template}` }, 'SPAWN_MANAGE')
            }]
        };
    }

    const pos = input.position ? parsePosition(input.position) : { x: 0, y: 0 };
    const characterId = randomUUID();

    const character = buildCharacter({
        id: characterId,
        name: preset.name,
        stats: preset.stats,
        hp: preset.hp,
        maxHp: preset.maxHp,
        ac: preset.ac,
        level: preset.level,
        characterType: input.characterType || preset.characterType || 'enemy',
        race: preset.race || 'Unknown',
        characterClass: preset.characterClass || 'monster',
        resistances: preset.resistances || [],
        vulnerabilities: preset.vulnerabilities || [],
        immunities: preset.immunities || [],
        origin: input.origin,
        position: pos,
        inventory: input.equipment || [],
        createdAt: now,
        updatedAt: now
    });

    charRepo.create(character);

    let output = RichFormatter.header('Character Spawned', '👤');
    output += RichFormatter.keyValue({
        'ID': characterId,
        'Name': preset.name,
        'Template': input.template,
        'HP': `${preset.hp}/${preset.maxHp}`,
        'AC': preset.ac,
        'Position': `(${pos.x}, ${pos.y})`
    });

    if (input.equipment && input.equipment.length > 0) {
        output += RichFormatter.section('Equipment');
        output += RichFormatter.list(input.equipment);
    }

    const result = {
        success: true,
        actionType: 'spawn_character',
        characterId,
        name: preset.name,
        template: input.template,
        hp: preset.hp,
        maxHp: preset.maxHp,
        ac: preset.ac,
        position: pos,
        equipment: input.equipment || [],
        origin: input.origin
    };

    output += RichFormatter.embedJson(result, 'SPAWN_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleSpawnLocation(input: SpawnManageInput, _ctx: SessionContext): Promise<McpResponse> {
    const { charRepo, db } = ensureDb();
    const now = new Date().toISOString();

    const locationId = randomUUID();
    const locationName = input.name || `${input.locationType || 'Location'}-${locationId.slice(0, 8)}`;

    // Create NPCs if provided
    const createdNpcs: Array<{ id: string; name: string; role: string }> = [];
    if (input.npcs && input.npcs.length > 0) {
        for (const npcData of input.npcs) {
            const npcId = randomUUID();
            const npc = {
                id: npcId,
                name: npcData.name,
                race: npcData.race || 'Human',
                characterClass: npcData.role,
                characterType: 'npc' as const,
                behavior: npcData.behavior,
                hp: 10,
                maxHp: 10,
                ac: 10,
                level: 1,
                stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
                createdAt: now,
                updatedAt: now,
                metadata: JSON.stringify({ location: locationName, locationId })
            };
            charRepo.create(npc as any);
            createdNpcs.push({ id: npcId, name: npcData.name, role: npcData.role });
        }
    }

    // Create rooms if provided
    const createdRooms: Array<{ id: string; name: string }> = [];
    if (input.rooms && input.rooms.length > 0) {
        for (const roomData of input.rooms) {
            const roomId = randomUUID();
            // Store room in database (simplified - real impl would use room repo)
            db.prepare(`
                INSERT OR REPLACE INTO rooms (id, networkId, name, description, exits, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                roomId,
                locationId,
                roomData.name,
                roomData.description || '',
                JSON.stringify(roomData.exits || []),
                now,
                now
            );
            createdRooms.push({ id: roomId, name: roomData.name });
        }
    }

    let output = RichFormatter.header('Location Spawned', '🏠');
    output += RichFormatter.keyValue({
        'ID': locationId,
        'Name': locationName,
        'Type': input.locationType || 'generic',
        'NPCs': createdNpcs.length,
        'Rooms': createdRooms.length
    });

    if (createdNpcs.length > 0) {
        output += RichFormatter.section('NPCs');
        const npcRows = createdNpcs.map(n => [n.name, n.role]);
        output += RichFormatter.table(['Name', 'Role'], npcRows);
    }

    if (createdRooms.length > 0) {
        output += RichFormatter.section('Rooms');
        output += RichFormatter.list(createdRooms.map(r => r.name));
    }

    const result = {
        success: true,
        actionType: 'spawn_location',
        locationId,
        name: locationName,
        type: input.locationType,
        npcs: createdNpcs,
        rooms: createdRooms
    };

    output += RichFormatter.embedJson(result, 'SPAWN_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleSpawnEncounter(input: SpawnManageInput, ctx: SessionContext): Promise<McpResponse> {
    const { charRepo, encounterRepo, partyRepo } = ensureDb();
    const combatManager = getCombatManager();
    const now = new Date().toISOString();

    // Get encounter preset
    let encounterData: EncounterPreset | undefined;
    if (input.preset) {
        encounterData = ENCOUNTER_PRESETS[input.preset];
        if (!encounterData) {
            return {
                content: [{
                    type: 'text',
                    text: RichFormatter.error(`Unknown encounter preset: ${input.preset}`) +
                        RichFormatter.embedJson({ error: true, message: `Unknown preset: ${input.preset}` }, 'SPAWN_MANAGE')
                }]
            };
        }
    } else if (input.random) {
        let candidates: EncounterPreset[] = [];
        if (input.tags && input.tags.length > 0) {
            // Get encounters matching any of the tags
            for (const tag of input.tags) {
                candidates = [...candidates, ...getEncountersByTag(tag)];
            }
            // Filter by difficulty if specified
            if (input.difficulty && candidates.length > 0) {
                const filtered = candidates.filter(e => e.difficulty === input.difficulty);
                if (filtered.length > 0) candidates = filtered;
            }
        } else if (input.level) {
            candidates = getEncountersForLevel(input.level);
            // Filter by difficulty if specified
            if (input.difficulty && candidates.length > 0) {
                const filtered = candidates.filter(e => e.difficulty === input.difficulty);
                if (filtered.length > 0) candidates = filtered;
            }
        } else {
            // Pick from all presets
            candidates = Object.values(ENCOUNTER_PRESETS);
        }

        if (candidates.length > 0) {
            encounterData = candidates[Math.floor(Math.random() * candidates.length)];
        }
    }

    if (!encounterData) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('No matching encounter found') +
                    RichFormatter.embedJson({ error: true, message: 'No matching encounter' }, 'SPAWN_MANAGE')
            }]
        };
    }

    // Scale if needed
    if (input.partySize && input.partyLevel) {
        encounterData = scaleEncounter(encounterData, input.partyLevel, input.partySize);
    }

    // Create participants
    const participants: CombatParticipant[] = [];
    const createdCharacterIds: string[] = [];

    for (const participant of encounterData.participants || []) {
        for (let i = 0; i < (participant.count || 1); i++) {
            const preset = expandCreatureTemplate(participant.template, participant.name);
            if (!preset) continue;

            const characterId = randomUUID();
            const pos = participant.position
                ? parsePosition(participant.position)
                : { x: Math.floor(Math.random() * 10), y: Math.floor(Math.random() * 10) };

            const character = buildCharacter({
                id: characterId,
                name: (participant.count || 1) > 1 ? `${preset.name} ${i + 1}` : preset.name,
                stats: preset.stats,
                hp: preset.hp,
                maxHp: preset.maxHp,
                ac: preset.ac,
                level: preset.level,
                characterType: 'enemy',
                race: preset.race || 'Unknown',
                characterClass: preset.characterClass || 'monster',
                position: pos,
                createdAt: now,
                updatedAt: now
            });

            charRepo.create(character);
            createdCharacterIds.push(characterId);

            const dexMod = Math.floor((preset.stats.dex - 10) / 2);
            participants.push({
                id: characterId,
                name: character.name,
                hp: preset.hp,
                maxHp: preset.maxHp,
                ac: preset.ac,
                attackDamage: preset.defaultAttack?.damage,
                attackBonus: preset.defaultAttack?.toHit,
                initiative: 0,
                initiativeBonus: dexMod,
                isEnemy: true,
                conditions: [],
                position: pos,
                size: preset.size || 'medium',
                movementSpeed: preset.speed || 30,
                movementRemaining: preset.speed || 30,
                resistances: preset.resistances || [],
                vulnerabilities: preset.vulnerabilities || [],
                immunities: preset.immunities || []
            });
        }
    }

    // Add party members if provided
    if (input.partyId) {
        const party = partyRepo.getPartyWithMembers(input.partyId);
        if (party && party.members) {
            const positions = input.partyPositions || [];
            for (let i = 0; i < party.members.length; i++) {
                const member = party.members[i];
                const char = member.character;
                const pos = positions[i] ? parsePosition(positions[i]) : { x: 15 + i, y: 10 };
                const dexMod = Math.floor((char.stats.dex - 10) / 2);

                participants.push({
                    id: char.id,
                    name: char.name,
                    hp: char.hp,
                    maxHp: char.maxHp,
                    ac: char.ac || 10,
                    initiative: 0,
                    initiativeBonus: dexMod,
                    isEnemy: false,
                    conditions: [],
                    position: pos,
                    size: 'medium',
                    movementSpeed: 30,
                    movementRemaining: 30,
                    resistances: [],
                    vulnerabilities: [],
                    immunities: []
                });
            }
        }
    }

    // Create encounter
    const encounterId = `encounter-${input.seed || randomUUID()}-${Date.now()}`;
    const namespacedId = `${ctx.sessionId}:${encounterId}`;
    const engine = new CombatEngine(input.seed || randomUUID());
    const encounterState = engine.startEncounter(participants);
    combatManager.create(namespacedId, engine);

    // Save to database
    encounterRepo.create({
        id: encounterId,
        tokens: encounterState.participants.map((p: CombatParticipant) => ({
            id: p.id,
            name: p.name,
            initiativeBonus: p.initiativeBonus,
            initiative: p.initiative,
            isEnemy: p.isEnemy,
            hp: p.hp,
            maxHp: p.maxHp,
            conditions: p.conditions,
            position: p.position,
            movementSpeed: p.movementSpeed ?? 30,
            size: p.size ?? 'medium'
        })),
        round: encounterState.round,
        activeTokenId: encounterState.turnOrder[encounterState.currentTurnIndex],
        status: 'active',
        terrain: encounterData.terrain ? { ...encounterData.terrain, obstacles: encounterData.terrain.obstacles || [] } : { obstacles: [] },
        props: [],
        gridBounds: { minX: 0, maxX: 20, minY: 0, maxY: 20 },
        createdAt: now,
        updatedAt: now
    });

    const asciiMap = generateEncounterMap({ state: encounterState }, 20, 20);

    let output = RichFormatter.header('Encounter Spawned', '⚔️');
    output += RichFormatter.keyValue({
        'ID': encounterId,
        'Preset': input.preset || 'random',
        'Difficulty': encounterData.difficulty || 'medium',
        'Enemies': participants.filter(p => p.isEnemy).length,
        'Allies': participants.filter(p => !p.isEnemy).length,
        'Round': encounterState.round
    });

    output += RichFormatter.section('Battle Map');
    output += '```\n' + asciiMap + '\n```\n';

    output += RichFormatter.section('Turn Order');
    const turnRows = encounterState.participants.map((p: CombatParticipant, i: number) => [
        i === encounterState.currentTurnIndex ? '►' : '',
        p.name,
        (p.initiative ?? 0).toString(),
        `${p.hp}/${p.maxHp}`,
        p.isEnemy ? 'Enemy' : 'Ally'
    ]);
    output += RichFormatter.table(['', 'Name', 'Init', 'HP', 'Side'], turnRows);

    const result = {
        success: true,
        actionType: 'spawn_encounter',
        encounterId,
        preset: input.preset,
        difficulty: encounterData.difficulty,
        round: encounterState.round,
        participants: encounterState.participants.map((p: CombatParticipant) => ({
            id: p.id,
            name: p.name,
            hp: p.hp,
            maxHp: p.maxHp,
            initiative: p.initiative,
            isEnemy: p.isEnemy,
            position: p.position
        })),
        turnOrder: encounterState.turnOrder,
        currentTurnIndex: encounterState.currentTurnIndex
    };

    output += RichFormatter.embedJson(result, 'SPAWN_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleSpawnPresetLocation(input: SpawnManageInput, _ctx: SessionContext): Promise<McpResponse> {
    if (!input.worldId || input.x === undefined || input.y === undefined) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('spawn_preset_location requires worldId, x, y') +
                    RichFormatter.embedJson({ error: true, message: 'worldId, x, y required' }, 'SPAWN_MANAGE')
            }]
        };
    }

    if (!input.preset) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('spawn_preset_location requires preset') +
                    RichFormatter.embedJson({ error: true, message: 'preset required' }, 'SPAWN_MANAGE')
            }]
        };
    }

    const { charRepo, spatialRepo, poiRepo } = ensureDb();
    const now = new Date().toISOString();

    // Location presets (simplified - real impl would use data files)
    const locationPresets: Record<string, any> = {
        'generic_tavern': {
            name: 'The Rusty Tankard',
            type: 'tavern',
            rooms: [
                { name: 'Common Room', description: 'A busy tavern common room' },
                { name: 'Kitchen', description: 'A warm kitchen' },
                { name: 'Upstairs Rooms', description: 'Guest rooms' }
            ],
            npcs: [
                { name: 'Barkeep', role: 'Innkeeper', race: 'Human' },
                { name: 'Serving Wench', role: 'Server', race: 'Human' }
            ]
        },
        'dungeon_entrance': {
            name: 'Dark Cave Entrance',
            type: 'dungeon',
            rooms: [
                { name: 'Cave Mouth', description: 'A dark cave entrance' },
                { name: 'Entry Chamber', description: 'First chamber of the dungeon' }
            ],
            npcs: []
        },
        'forest_clearing': {
            name: 'Forest Clearing',
            type: 'wilderness',
            rooms: [
                { name: 'Clearing', description: 'A peaceful forest clearing' }
            ],
            npcs: []
        },
        // FINDINGS #84: STALKER presets — the three fantasy stubs put a Kitchen
        // in a Military HQ and Upstairs Rooms in a flea market. Zone locations
        // get Zone shells. FIRST room in each list is the seat room (travel
        // enterLocation reads LIMIT 1), so it is always the natural arrival
        // point. No auto-NPCs — the GM casts the Zone themselves.
        'military_checkpoint': {
            name: 'Military Checkpoint',
            type: 'checkpoint',
            rooms: [
                { name: 'Barrier Gate', description: 'Counterweighted pole barrier across the road, concrete blocks staggered for a slalom approach' },
                { name: 'Guardhouse', description: 'Brick guardhouse with a slit window facing the approach, a field telephone, and a duty ledger' },
                { name: 'Sandbag Position', description: 'Machine-gun position in a sandbag horseshoe, ammunition boxes stacked as furniture' },
                { name: 'Holding Room', description: 'Windowless back room with a bench bolted to the wall and a door that locks from outside' }
            ],
            npcs: []
        },
        'flea_market': {
            name: 'Open-Air Market',
            type: 'market',
            rooms: [
                { name: 'Market Rows', description: 'Trestle tables and tarpaulin stalls in uneven rows, goods laid out on groundsheets' },
                { name: 'Trader Stalls', description: 'The established pitches — shipping-container kiosks with padlocks and price lists nobody honours' },
                { name: 'Back Lot', description: 'Behind the stalls: parked vehicles, quiet deals, and the goods that never reach a table' }
            ],
            npcs: []
        },
        'trader_bunker': {
            name: 'Trader Bunker',
            type: 'bunker',
            rooms: [
                { name: 'Blast Door Entry', description: 'Steel blast door at the bottom of a concrete stair, viewing slot at eye height' },
                { name: 'Counter Room', description: 'Low-ceilinged room split by a counter, shelving crammed to the concrete behind it' },
                { name: 'Back Storage', description: 'Locked storage deeper in — crates the customers never see' }
            ],
            npcs: []
        },
        'rookie_village': {
            name: 'Rookie Village',
            type: 'settlement',
            rooms: [
                { name: 'Village Street', description: 'One unpaved street between abandoned houses, washing lines strung between the ones still lived in' },
                { name: 'Communal Fire', description: 'Oil-drum fire in a cleared yard, pallet benches around it — where the village talks' },
                { name: 'Occupied House', description: 'A weather-sealed house with boarded windows and a stove flue through the wall' },
                { name: 'Root Cellar', description: 'Earth-floored cellar under a collapsed house, cold and dry, used for storage or hiding' }
            ],
            npcs: []
        },
        'rail_station': {
            name: 'Rail Station',
            type: 'station',
            rooms: [
                { name: 'Platform', description: 'Cracked concrete platform under a rusted canopy, rails swallowed by weeds in both directions' },
                { name: 'Station Hall', description: 'Ticket hall with a caved ceiling panel, timetable board still showing a departure that never left' },
                { name: 'Signal Box', description: 'Raised signal box with levers seized in position and a clear view down the line' },
                { name: 'Sidings', description: 'Freight sidings with rotting wagons — cover, salvage, and things that nest in wagons' }
            ],
            npcs: []
        },
        'industrial_ruin': {
            name: 'Industrial Ruin',
            type: 'industrial',
            rooms: [
                { name: 'Works Yard', description: 'Open yard between buildings, rusted gantry crane overhead, drifts of scrap in the corners' },
                { name: 'Machine Hall', description: 'High hall of dead machinery, belts perished on their pulleys, light through holed roof sheets' },
                { name: 'Office Block', description: 'Two floors of offices — paperwork, lockers, and whatever the last shift left' },
                { name: 'Basement Level', description: 'Service basement below the hall — pipe runs, standing water, and no natural light' }
            ],
            npcs: []
        },
        'apartment_block': {
            name: 'Apartment Block',
            type: 'ruins',
            rooms: [
                { name: 'Entryway', description: 'Concrete entryway with dead letterboxes and a lift shaft that has been open since the accident' },
                { name: 'Stairwell', description: 'Switchback stairwell, every landing a decision, sound carrying five floors in both directions' },
                { name: 'Second-Floor Flat', description: 'A stripped two-room flat — defendable, one entrance, windows over the approach' },
                { name: 'Roof Access', description: 'Roof through a steel hatch — sightlines across the district and no cover from the sky' }
            ],
            npcs: []
        },
        'underground_entrance': {
            name: 'Underground Entrance',
            type: 'underground',
            rooms: [
                { name: 'Shaft Head', description: 'Surface works over a vertical shaft — headframe timber, a winch that may or may not turn' },
                { name: 'Collar Room', description: 'Concrete collar room at the shaft top, ladder rungs descending past the reach of daylight' },
                { name: 'Head of the Descent', description: 'Where the ladders end and the galleries begin — the last place with a way back up' }
            ],
            npcs: []
        }
    };

    const presetData = locationPresets[input.preset];
    if (!presetData) {
        // FINDINGS #94: enum refusals name the valid set — house style
        // (world_manage's season refusal is the model).
        const valid = Object.keys(locationPresets).join(', ');
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(`Unknown location preset: ${input.preset} — valid: ${valid}`) +
                    RichFormatter.embedJson({ error: true, message: `Unknown preset: ${input.preset}`, validPresets: Object.keys(locationPresets) }, 'SPAWN_MANAGE')
            }]
        };
    }

    const locationId = randomUUID();
    // FINDINGS #107: the chair passed `name` — accepted by the shared schema
    // (spawn_character's field), ignored by THIS handler, which only read
    // customName. Two overlapping params, one wired: Emmett Mountain filed as
    // 'Industrial Ruin'. Both are honored now, customName winning.
    const locationName = input.customName || input.name || presetData.name;

    const biomeContext = presetData.type === 'dungeon'
        ? 'dungeon'
        : presetData.type === 'tavern'
            ? 'urban'
            : 'forest';

    // Persist the location in the canonical spatial graph and POI tables.
    spatialRepo.createNetwork({
        id: locationId,
        name: locationName,
        type: 'cluster',
        worldId: input.worldId,
        centerX: input.x,
        centerY: input.y,
        createdAt: now,
        updatedAt: now
    });

    // Create rooms
    const createdRooms: Array<{ id: string; name: string }> = [];
    for (const roomData of presetData.rooms) {
        const roomId = randomUUID();
        spatialRepo.create({
            id: roomId,
            name: roomData.name,
            baseDescription: roomData.description.length >= 10
                ? roomData.description
                : `${roomData.description} awaits exploration.`,
            biomeContext,
            atmospherics: [],
            networkId: locationId,
            exits: [],
            entityIds: [],
            createdAt: now,
            updatedAt: now,
            visitedCount: 0
        });
        createdRooms.push({ id: roomId, name: roomData.name });
    }

    // Link preset rooms into a traversable sequence.
    for (let i = 1; i < createdRooms.length; i++) {
        spatialRepo.addExit(createdRooms[i - 1].id, {
            direction: 'east',
            targetNodeId: createdRooms[i].id,
            type: 'OPEN'
        });
        spatialRepo.addExit(createdRooms[i].id, {
            direction: 'west',
            targetNodeId: createdRooms[i - 1].id,
            type: 'OPEN'
        });
    }

    // Create POI
    const poiId = randomUUID();
    poiRepo.create({
        id: poiId,
        worldId: input.worldId,
        name: locationName,
        type: presetData.type,
        x: input.x,
        y: input.y,
        discoveryState: input.discoveryState || 'discovered',
        discoveryDc: 15,
        networkId: locationId,
        createdAt: now,
        updatedAt: now
    });

    // Create NPCs if requested
    const createdNpcs: Array<{ id: string; name: string; role: string }> = [];
    if (input.spawnNpcs && presetData.npcs.length > 0) {
        for (const npcData of presetData.npcs) {
            const npcId = randomUUID();
            charRepo.create({
                id: npcId,
                name: npcData.name,
                race: npcData.race,
                characterClass: npcData.role,
                characterType: 'npc',
                hp: 10,
                maxHp: 10,
                ac: 10,
                level: 1,
                stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
                createdAt: now,
                updatedAt: now
            } as any);
            if (createdRooms[0]) spatialRepo.addEntityToRoom(createdRooms[0].id, npcId);
            createdNpcs.push({ id: npcId, name: npcData.name, role: npcData.role });
        }
    }

    let output = RichFormatter.header('Preset Location Spawned', '🏰');
    output += RichFormatter.keyValue({
        'POI ID': poiId,
        'Network ID': locationId,
        'Name': locationName,
        'Preset': input.preset,
        'Position': `(${input.x}, ${input.y})`,
        'Discovery': input.discoveryState || 'discovered',
        'Rooms': createdRooms.length,
        'NPCs': createdNpcs.length
    });

    const result = {
        success: true,
        actionType: 'spawn_preset_location',
        poiId,
        networkId: locationId,
        name: locationName,
        preset: input.preset,
        position: { x: input.x, y: input.y },
        rooms: createdRooms,
        npcs: createdNpcs
    };

    output += RichFormatter.embedJson(result, 'SPAWN_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleSpawnTactical(input: SpawnManageInput, ctx: SessionContext): Promise<McpResponse> {
    if (!input.participants || input.participants.length === 0) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('spawn_tactical requires participants array') +
                    RichFormatter.embedJson({ error: true, message: 'participants required' }, 'SPAWN_MANAGE')
            }]
        };
    }

    const { charRepo, encounterRepo } = ensureDb();
    const combatManager = getCombatManager();
    const now = new Date().toISOString();

    const participants: CombatParticipant[] = [];
    const createdCharacterIds: string[] = [];

    for (const p of input.participants) {
        const preset = expandCreatureTemplate(p.template, p.name);
        if (!preset) {
            return {
                content: [{
                    type: 'text',
                    text: RichFormatter.error(`Unknown template: ${p.template}`) +
                        RichFormatter.embedJson({ error: true, message: `Unknown template: ${p.template}` }, 'SPAWN_MANAGE')
                }]
            };
        }

        const pos = parsePosition(p.position);
        const characterId = randomUUID();

        const character = buildCharacter({
            id: characterId,
            name: preset.name,
            stats: preset.stats,
            hp: preset.hp,
            maxHp: preset.maxHp,
            ac: preset.ac,
            level: preset.level,
            characterType: p.isEnemy ? 'enemy' : 'ally',
            race: preset.race || 'Unknown',
            characterClass: preset.characterClass || 'monster',
            position: pos,
            createdAt: now,
            updatedAt: now
        });

        charRepo.create(character);
        createdCharacterIds.push(characterId);

        const dexMod = Math.floor((preset.stats.dex - 10) / 2);
        participants.push({
            id: characterId,
            name: preset.name,
            hp: preset.hp,
            maxHp: preset.maxHp,
            ac: preset.ac,
            attackDamage: preset.defaultAttack?.damage,
            attackBonus: preset.defaultAttack?.toHit,
            initiative: 0,
            initiativeBonus: dexMod,
            isEnemy: p.isEnemy ?? true,
            conditions: [],
            position: pos,
            size: preset.size || 'medium',
            movementSpeed: preset.speed || 30,
            movementRemaining: preset.speed || 30,
            resistances: preset.resistances || [],
            vulnerabilities: preset.vulnerabilities || [],
            immunities: preset.immunities || []
        });
    }

    // Build terrain
    const width = input.gridSize?.width || 20;
    const height = input.gridSize?.height || 20;
    let terrain: { obstacles: string[]; difficultTerrain?: string[]; water?: string[] } = {
        obstacles: input.terrain?.obstacles || [],
        difficultTerrain: input.terrain?.difficultTerrain,
        water: input.terrain?.water
    };

    if (input.terrain?.pattern) {
        const validPatterns: TerrainPatternName[] = ['river_valley', 'canyon', 'arena', 'mountain_pass', 'maze', 'maze_rooms'];
        if (validPatterns.includes(input.terrain.pattern as TerrainPatternName)) {
            const patternGen = getPatternGenerator(input.terrain.pattern as TerrainPatternName);
            const patternTerrain = patternGen(0, 0, width, height);
            terrain = {
                obstacles: [...terrain.obstacles, ...patternTerrain.obstacles],
                difficultTerrain: [...(terrain.difficultTerrain || []), ...(patternTerrain.difficultTerrain || [])],
                water: [...(terrain.water || []), ...(patternTerrain.water || [])]
            };
        }
    }

    // Create encounter
    const encounterId = `encounter-${input.seed || randomUUID()}-${Date.now()}`;
    const namespacedId = `${ctx.sessionId}:${encounterId}`;
    const engine = new CombatEngine(input.seed || randomUUID());
    const encounterState = engine.startEncounter(participants);
    (encounterState as any).terrain = terrain;
    combatManager.create(namespacedId, engine);

    // Save to database
    encounterRepo.create({
        id: encounterId,
        tokens: encounterState.participants.map((p: CombatParticipant) => ({
            id: p.id,
            name: p.name,
            initiativeBonus: p.initiativeBonus,
            initiative: p.initiative,
            isEnemy: p.isEnemy,
            hp: p.hp,
            maxHp: p.maxHp,
            conditions: p.conditions,
            position: p.position,
            movementSpeed: p.movementSpeed ?? 30,
            size: p.size ?? 'medium'
        })),
        round: encounterState.round,
        activeTokenId: encounterState.turnOrder[encounterState.currentTurnIndex],
        status: 'active',
        terrain,
        props: [],
        gridBounds: { minX: 0, maxX: width, minY: 0, maxY: height },
        createdAt: now,
        updatedAt: now
    });

    const asciiMap = generateEncounterMap({ state: encounterState }, width, height);

    let output = RichFormatter.header('Tactical Encounter Created', '🎯');
    output += RichFormatter.keyValue({
        'ID': encounterId,
        'Grid': `${width}x${height}`,
        'Participants': participants.length,
        'Round': encounterState.round
    });

    output += RichFormatter.section('Battle Map');
    output += '```\n' + asciiMap + '\n```\n';

    const result = {
        success: true,
        actionType: 'spawn_tactical',
        encounterId,
        gridSize: { width, height },
        round: encounterState.round,
        participants: encounterState.participants.map((p: CombatParticipant) => ({
            id: p.id,
            name: p.name,
            hp: p.hp,
            maxHp: p.maxHp,
            initiative: p.initiative,
            isEnemy: p.isEnemy,
            position: p.position
        })),
        turnOrder: encounterState.turnOrder,
        terrain
    };

    output += RichFormatter.embedJson(result, 'SPAWN_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

// Main handler
// FINDINGS #84: POI-layer rooms live in the `rooms` table — separate from
// spatial_manage's room_nodes — and had NO update verb: a preset shell's names
// were stuck at spawn forever (a Military HQ keeping its Kitchen). This is
// the missing verb. changes come from the store; a zero-change rename refuses
// loudly and lists the rooms that ARE there.
async function handleUpdatePoiRoom(input: SpawnManageInput, _ctx: SessionContext): Promise<McpResponse> {
    // FINDINGS #107: the verb now also renames the POI ROW itself — pass
    // newPoiName (alone or with room edits). The repair lane for every
    // preset-named POI placed before the #107 create fix.
    if (!input.poiId || (!input.newPoiName && (!input.roomName || (!input.newName && !input.newDescription)))) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error('update_poi_room requires poiId, and either newPoiName (renames the POI row) or roomName + newName/newDescription (edits a room)') +
                    RichFormatter.embedJson({ error: true, message: 'poiId + newPoiName, or poiId + roomName + newName/newDescription' }, 'SPAWN_MANAGE')
            }]
        };
    }
    const { db } = ensureDb();
    const poi = db.prepare('SELECT id, name, networkId FROM pois WHERE id = ?').get(input.poiId) as { id: string; name: string; networkId: string } | undefined;
    if (!poi) {
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(`POI ${input.poiId} not found`) +
                    RichFormatter.embedJson({ error: true, message: `POI ${input.poiId} not found` }, 'SPAWN_MANAGE')
            }]
        };
    }
    const now = new Date().toISOString();
    if (input.newPoiName) {
        db.prepare('UPDATE pois SET name = ?, updatedAt = ? WHERE id = ?').run(input.newPoiName, now, input.poiId);
        if (!input.roomName) {
            return {
                content: [{
                    type: 'text',
                    text: RichFormatter.header('POI RENAMED', '📍') + RichFormatter.alert(`"${poi.name}" → "${input.newPoiName}" (#107)`, 'info') +
                        RichFormatter.embedJson({ success: true, actionType: 'update_poi_room', poiId: poi.id, oldName: poi.name, newPoiName: input.newPoiName }, 'SPAWN_MANAGE')
                }]
            };
        }
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (input.newName) { sets.push('name = ?'); vals.push(input.newName); }
    if (input.newDescription) { sets.push('description = ?'); vals.push(input.newDescription); }
    sets.push('updatedAt = ?'); vals.push(now);
    const r = db.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE networkId = ? AND name = ?`).run(...vals, poi.networkId, input.roomName);
    if (r.changes === 0) {
        const existing = db.prepare('SELECT name FROM rooms WHERE networkId = ?').all(poi.networkId) as Array<{ name: string }>;
        return {
            content: [{
                type: 'text',
                text: RichFormatter.error(`No room named "${input.roomName}" in ${poi.name} — rooms there: ${existing.map(e => e.name).join(', ') || '(none)'} . NOTHING was renamed.`) +
                    RichFormatter.embedJson({ error: true, poiId: poi.id, poiName: poi.name, roomsPresent: existing.map(e => e.name), message: `no room named ${input.roomName}` }, 'SPAWN_MANAGE')
            }]
        };
    }
    let output = RichFormatter.header('POI Room Updated', '🏷️');
    output += RichFormatter.keyValue({
        'POI': poi.name,
        'Room': input.roomName + (input.newName ? ` → ${input.newName}` : ''),
        'Rows changed': r.changes
    });
    output += RichFormatter.embedJson({ success: true, actionType: 'update_poi_room', poiId: poi.id, poiName: input.newPoiName ?? poi.name, ...(input.newPoiName ? { poiRenamedTo: input.newPoiName } : {}), room: input.roomName, newName: input.newName ?? null, newDescription: input.newDescription ?? null, changes: r.changes }, 'SPAWN_MANAGE');
    return { content: [{ type: 'text', text: output }] };
}

export async function handleSpawnManage(args: unknown, ctx: SessionContext): Promise<McpResponse> {
    const input = SpawnManageInputSchema.parse(args);
    const matchResult = matchAction(input.action, ACTIONS, ALIASES, 0.6);

    if (isGuidingError(matchResult)) {
        let output = RichFormatter.error(`Unknown action: "${input.action}"`);
        output += `\nAvailable actions: ${ACTIONS.join(', ')}`;
        if (matchResult.suggestions.length > 0) {
            output += `\nDid you mean: ${matchResult.suggestions.map(s => `"${s.value}" (${Math.round(s.similarity * 100)}%)`).join(', ')}?`;
        }
        output += RichFormatter.embedJson(matchResult, 'SPAWN_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    }

    switch (matchResult.matched) {
        case 'spawn_character':
            return handleSpawnCharacter(input, ctx);
        case 'spawn_location':
            return handleSpawnLocation(input, ctx);
        case 'spawn_encounter':
            return handleSpawnEncounter(input, ctx);
        case 'spawn_preset_location':
            return handleSpawnPresetLocation(input, ctx);
        case 'spawn_tactical':
            return handleSpawnTactical(input, ctx);
        case 'update_poi_room':
            return handleUpdatePoiRoom(input, ctx);
        default:
            return {
                content: [{
                    type: 'text',
                    text: RichFormatter.error(`Unhandled action: ${matchResult.matched}`) +
                        RichFormatter.embedJson({ error: true, message: `Unhandled: ${matchResult.matched}` }, 'SPAWN_MANAGE')
                }]
            };
    }
}

// Tool definition for registration
export const SpawnManageTool = {
    name: 'spawn_manage',
    description: `Create game entities from templates - characters, locations, encounters.

🎯 QUICK START:
- spawn_character: Single creature from template (goblin, orc, bandit)
- spawn_encounter: Full combat from preset or random selection

🏠 LOCATIONS:
- spawn_location: Custom populated location with NPCs and rooms
- spawn_preset_location: Pre-built location (tavern, dungeon entrance) at world coordinates

⚔️ TACTICAL COMBAT:
- spawn_tactical: Custom combat setup with positioned participants and terrain patterns

📋 TEMPLATES: goblin, orc, skeleton, zombie, bandit, wolf, bear, etc.
Terrain patterns: arena, canyon, river_valley, mountain_pass, maze

🔄 WORKFLOW:
1. spawn_encounter/spawn_tactical creates combat → Returns encounterId
2. Use combat_action for attacks, combat_map for visualization
3. Use corpse_manage after combat ends

Actions: spawn_character, spawn_location, spawn_encounter, spawn_preset_location, spawn_tactical`,
    actionSchemas: SpawnManageActionSchemas,
    inputSchema: SpawnManageInputSchema
};
