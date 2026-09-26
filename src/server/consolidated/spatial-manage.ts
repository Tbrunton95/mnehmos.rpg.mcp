/**
 * Consolidated Spatial Management Tool
 * Replaces 5 separate tools for spatial/room operations:
 * look_at_surroundings, generate_room_node, get_room_exits,
 * move_character_to_room, list_rooms
 */

import { z } from 'zod';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { getDb } from '../../storage/index.js';
import { RichFormatter } from '../utils/formatter.js';
import {
    handleLookAtSurroundings,
    handleGenerateRoomNode,
    handleUpdateRoomNode,
    handleGetRoomExits,
    handleMoveCharacterToRoom,
    handleListRooms,
    handleCreateNodeNetwork,
    handleGetNodeNetwork,
    handleListNodeNetworks,
    seatCharacterInRoom
} from '../handlers/spatial-handlers.js';
import { randomUUID } from 'crypto';
import { exitTypeFor } from '../../schema/spatial.js';
import { InventoryRepository } from '../../storage/repos/inventory.repo.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { readWorldClock, SET_CLOCK_HINT } from '../../engine/world-clock.js';
import { advanceWorldClock } from './world-manage.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = [
    'look',
    'generate',
    'update',
    'get_exits',
    'link',
    'move',
    'unseat',
    'delete_room',
    'list',
    'network_create',
    'network_get',
    'network_list',
    'gate_create',
    'gate_list',
    'set_gate',
    'traverse'
] as const;
type SpatialAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT HOLDER
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const BIOME_VALUES = [
    'forest', 'mountain', 'urban', 'dungeon',
    'coastal', 'cavern', 'divine', 'arcane'
 ] as const;
const biomeSchema = () => z.enum(BIOME_VALUES);

const AtmosphericEnum = z.enum([
    'DARKNESS', 'FOG', 'ANTIMAGIC', 'SILENCE', 'BRIGHT', 'MAGICAL'
]);

const DirectionEnum = z.enum([
    'north', 'south', 'east', 'west', 'up', 'down',
    'northeast', 'northwest', 'southeast', 'southwest'
]);

const NetworkTypeEnum = z.enum(['cluster', 'linear']);

const BoundingBoxSchema = z.object({
    minX: z.number().int().min(0),
    maxX: z.number().int().min(0),
    minY: z.number().int().min(0),
    maxY: z.number().int().min(0)
});

const LookSchema = z.object({
    action: z.literal('look'),
    observerId: z.string().uuid().describe('ID of the character observing')
});

const GenerateSchema = z.object({
    action: z.literal('generate'),
    name: z.string().min(1).max(100).describe('Room name'),
    baseDescription: z.string().min(10).max(2000).describe('Detailed description'),
    biomeContext: biomeSchema().describe('Biome/environment type'),
    atmospherics: z.array(AtmosphericEnum).default([]).describe('Environmental effects'),
    previousNodeId: z.string().uuid().optional().describe('Link from this room'),
    direction: DirectionEnum.optional().describe('Direction of exit from previous room'),
    networkId: z.string().uuid().optional().describe('Optional node network ID'),
    localX: z.number().int().optional().describe('Optional local X coordinate within node network'),
    localY: z.number().int().optional().describe('Optional local Y coordinate within node network'),
    autoLink: z.boolean().optional().describe('#96: linear networks auto-link each new room to the previous one (direction from coords, else north). Pass false to suppress')
});

const UpdateSchema = z.object({
    action: z.literal('update'),
    roomId: z.string().uuid().describe('Room ID'),
    name: z.string().min(1).max(100).optional().describe('Room name'),
    baseDescription: z.string().min(10).max(2000).optional().describe('Detailed description'),
    biomeContext: biomeSchema().optional().describe('Biome/environment type'),
    atmospherics: z.array(AtmosphericEnum).optional().describe('Environmental effects')
});

const GetExitsSchema = z.object({
    action: z.literal('get_exits'),
    roomId: z.string().uuid().describe('Room ID')
});

const MoveSchema = z.object({
    action: z.literal('move'),
    characterId: z.string().uuid().describe('Character ID'),
    roomId: z.string().uuid().optional().describe('Destination room ID; omit to follow an exit'),
    direction: DirectionEnum.optional().describe('Exit direction to follow from the character\'s current room'),
    networkId: z.string().uuid().optional().describe('Optional node network ID to assign to the room'),
    localX: z.number().int().optional().describe('Optional local X coordinate within node network'),
    localY: z.number().int().optional().describe('Optional local Y coordinate within node network')
}).refine(args => Boolean(args.roomId || args.direction), {
    message: 'move requires either roomId or direction',
    path: ['roomId']
});

const DeleteRoomSchema = z.object({
    action: z.literal('delete_room'),
    roomId: z.string().describe('Room node ID to delete'),
    force: z.boolean().optional().describe('If characters are seated in the room, unseat them and delete anyway')
});

const ListSchema = z.object({
    action: z.literal('list'),
    biome: biomeSchema().optional().describe('Filter by biome'),
    // FINDINGS #106: these two were the ROOT of the unscoped-list report — the
    // schema never declared them, so zod stripped the caller's scope BEFORE the
    // handler ever saw it. The handler filter (#106-A) is the second half.
    networkId: z.string().optional().describe('FINDINGS #106: filter rooms to one node network'),
    worldId: z.string().optional().describe('FINDINGS #106: filter rooms to one world (via the network join)')
});

const NetworkCreateSchema = z.object({
    action: z.literal('network_create'),
    name: z.string().min(1).max(100).describe('Network name'),
    networkType: NetworkTypeEnum.describe('Network shape'),
    worldId: z.string().min(1).describe('World ID'),
    centerX: z.number().int().min(0).describe('Center X coordinate'),
    centerY: z.number().int().min(0).describe('Center Y coordinate'),
    boundingBox: BoundingBoxSchema.optional().describe('Optional world-map bounding box')
});

const NetworkGetSchema = z.object({
    action: z.literal('network_get'),
    networkId: z.string().uuid().describe('Node network ID')
});

const NetworkListSchema = z.object({
    action: z.literal('network_list'),
    worldId: z.string().min(1).optional().describe('Optional world filter')
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleLook(args: z.infer<typeof LookSchema>, ctx?: SessionContext): Promise<object> {
    if (!ctx) throw new Error('No session context');
    const result = await handleLookAtSurroundings({ observerId: args.observerId }, ctx);
    return extractResultData(result, 'look');
}

async function handleGenerate(args: z.infer<typeof GenerateSchema>, ctx?: SessionContext): Promise<object> {
    if (!ctx) throw new Error('No session context');
    // FINDINGS #96 (GAP 8): LINEAR NETWORKS AUTO-LINK. A room generated into a
    // networkType:'linear' network with no explicit previousNodeId links to the
    // network's most recently created room automatically (direction inferred
    // from local coords when both present, else 'north' by convention).
    // Suppress with autoLink:false. Four rooms, zero exits, 'linkedToPrevious:
    // false' ×4 was the repro — linear means linear now.
    let previousNodeId = args.previousNodeId;
    let direction = args.direction;
    let autoLinked: string | null = null;
    if (!previousNodeId && args.networkId && args.autoLink !== false) {
        try {
            const db = getDb();
            const net = db.prepare('SELECT type FROM node_networks WHERE id = ?').get(args.networkId) as { type?: string } | undefined;
            if (net?.type === 'linear') {
                const prev = db.prepare('SELECT id, name, local_x, local_y FROM room_nodes WHERE network_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(args.networkId) as { id: string; name: string; local_x: number | null; local_y: number | null } | undefined;
                if (prev) {
                    previousNodeId = prev.id;
                    if (!direction && args.localX !== undefined && args.localY !== undefined && prev.local_x !== null && prev.local_y !== null) {
                        const dx = args.localX - prev.local_x, dy = args.localY - prev.local_y;
                        direction = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'east' : 'west') : (dy >= 0 ? 'north' : 'south');
                    }
                    direction = direction ?? 'north';
                    autoLinked = `${prev.name} ─${direction}→ (auto: linear network)`;
                }
            }
        } catch { /* pre-migration or shape drift — generate proceeds unlinked, as before */ }
    }
    const result = await handleGenerateRoomNode({
        name: args.name,
        baseDescription: args.baseDescription,
        biomeContext: args.biomeContext,
        atmospherics: args.atmospherics,
        previousNodeId,
        direction,
        networkId: args.networkId,
        localX: args.localX,
        localY: args.localY
    }, ctx);
    const data = extractResultData(result, 'generate') as Record<string, unknown>;
    if (autoLinked) data.autoLinked = autoLinked;
    return data;
}

async function handleUpdate(args: z.infer<typeof UpdateSchema>, ctx?: SessionContext): Promise<object> {
    if (!ctx) throw new Error('No session context');
    const result = await handleUpdateRoomNode({
        roomId: args.roomId,
        name: args.name,
        baseDescription: args.baseDescription,
        biomeContext: args.biomeContext,
        atmospherics: args.atmospherics
    }, ctx);
    return extractResultData(result, 'update');
}

async function handleGetExits(args: z.infer<typeof GetExitsSchema>, ctx?: SessionContext): Promise<object> {
    if (!ctx) throw new Error('No session context');
    const result = await handleGetRoomExits({ roomId: args.roomId }, ctx);
    return extractResultData(result, 'get_exits');
}

async function handleMove(args: z.infer<typeof MoveSchema>, ctx?: SessionContext): Promise<object> {
    if (!ctx) throw new Error('No session context');
    // FINDINGS #108: the dual-table fallback failed SILENTLY in the field —
    // the bare catch swallowed whatever broke, violating the #106-A law from
    // one paragraph up. The catch now CARRIES: any fallback failure rides the
    // response as fallbackDiagnostic instead of vanishing, and the room_nodes
    // and rooms lookups are separated so the diagnostic names its layer.
    let fallbackDiagnostic: string | null = null;
    try {
        const db = getDb();
        let inNodes: unknown = null;
        try {
            inNodes = db.prepare('SELECT id FROM room_nodes WHERE id = ?').get(args.roomId);
        } catch (e) {
            fallbackDiagnostic = `room_nodes lookup threw: ${e instanceof Error ? e.message : String(e)}`;
        }
        if (!inNodes && !fallbackDiagnostic) {
            let poiRoom: { id: string; name: string } | undefined;
            try {
                poiRoom = db.prepare('SELECT id, name FROM rooms WHERE id = ?').get(args.roomId) as { id: string; name: string } | undefined;
            } catch (e) {
                fallbackDiagnostic = `rooms lookup threw: ${e instanceof Error ? e.message : String(e)}`;
            }
            if (poiRoom) {
                // FINDINGS #109: the #108 diagnostic named it — characters.
                // current_room_id carries a FOREIGN KEY into room_nodes; POI rooms
                // live in the parallel `rooms` table, so this seat is refused AT THE
                // DATABASE, correctly. Ruling (chair's recommendation, adopted): the
                // FK is NOT relaxed — it is the invariant the audit stands on, and a
                // second seat column would be two truths about where a body is (the
                // #100 shape in miniature). The doomed UPDATE is no longer attempted;
                // this branch states the doctrine. The real fix is the #109
                // unification: preset rooms become real room_nodes.
                return {
                    success: false, actionType: 'move', characterId: args.characterId,
                    roomId: poiRoom.id, roomName: poiRoom.name, table: 'rooms (POI layer)',
                    error: 'POI-room seat refused by design (#109)',
                    detail: `Room "${poiRoom.name}" exists in the POI layer, but characters.current_room_id is foreign-keyed into room_nodes — the spatial invariant the audit depends on. Seat into a real spatial room (spatial_manage generate + link), or wait for the #109 unification (preset rooms written as room_nodes).`
                };
            } else if (!fallbackDiagnostic) {
                fallbackDiagnostic = `room ${args.roomId} in neither room_nodes nor rooms (both lookups ran clean)`;
            }
        }
    } catch (e) {
        fallbackDiagnostic = `fallback outer failure: ${e instanceof Error ? e.message : String(e)}`;
    }
    const result = await handleMoveCharacterToRoom({
        characterId: args.characterId,
        roomId: args.roomId,
        direction: args.direction,
        networkId: args.networkId,
        localX: args.localX,
        localY: args.localY
    }, ctx);
    const data = extractResultData(result, 'move') as Record<string, unknown>;
    if (fallbackDiagnostic && data && data.success === false) {
        data.fallbackDiagnostic = fallbackDiagnostic;
    }
    return data;
}

// #67-E: UNSEAT — room occupancy is dual-booked (room_nodes.entity_ids +
// characters.current_room_id) and campaign resets never touched it: Gleb-era
// seatings survived a Tier-1 board wipe and haunted three rooms, including
// the Flooded Run's phantom presence. This verb clears BOTH sides.
//   {characterId}          — unseat one character wherever they sit
//   {roomId}               — unseat EVERY occupant of one room (purge pass)
async function handleUnseat(args: { characterId?: string; roomId?: string }): Promise<object> {
    const db = getDb();
    if (!args.characterId && !args.roomId)
        return { error: true, message: 'unseat needs characterId (one body) or roomId (whole room)', writes: 'none' };

    const pullFromEntityIds = (roomId: string, ids: string[]) => {
        const row = db.prepare('SELECT entity_ids FROM room_nodes WHERE id = ?').get(roomId) as { entity_ids?: string } | undefined;
        if (!row) return;
        try {
            const parsed = JSON.parse(row.entity_ids || '[]') as string[];
            const filtered = parsed.filter(e => !ids.includes(e));
            if (filtered.length !== parsed.length)
                db.prepare('UPDATE room_nodes SET entity_ids = ? WHERE id = ?').run(JSON.stringify(filtered), roomId);
        } catch { /* malformed entity_ids — overwrite clean */ db.prepare('UPDATE room_nodes SET entity_ids = ? WHERE id = ?').run('[]', roomId); }
    };

    if (args.characterId) {
        const c = db.prepare('SELECT id, name, current_room_id FROM characters WHERE id = ?').get(args.characterId) as { id: string; name: string; current_room_id?: string } | undefined;
        if (!c) return { error: true, message: `Character ${args.characterId} not found`, writes: 'none' };
        db.prepare('UPDATE characters SET current_room_id = NULL WHERE id = ?').run(args.characterId);
        if (c.current_room_id) pullFromEntityIds(c.current_room_id, [args.characterId]);
        // Ghost hygiene: pull this id from ANY room still listing it.
        const ghostRooms = db.prepare(`SELECT id FROM room_nodes WHERE entity_ids LIKE '%' || ? || '%'`).all(args.characterId) as Array<{ id: string }>;
        for (const g of ghostRooms) pullFromEntityIds(g.id, [args.characterId]);
        return {
            success: true, actionType: 'unseat', characterId: args.characterId,
            roomsScrubbed: (c.current_room_id ? 1 : 0) + ghostRooms.length,
            message: `${c.name} unseated — both bookkeeping sides cleared${ghostRooms.length ? ` (+${ghostRooms.length} ghost listing${ghostRooms.length > 1 ? 's' : ''} scrubbed)` : ''}.`
        };
    }

    const room = db.prepare('SELECT id, name, entity_ids FROM room_nodes WHERE id = ?').get(args.roomId!) as { id: string; name: string; entity_ids?: string } | undefined;
    if (!room) return { error: true, message: `Room ${args.roomId} not found`, writes: 'none' };
    const seated = db.prepare('SELECT id, name FROM characters WHERE current_room_id = ?').all(args.roomId!) as Array<{ id: string; name: string }>;
    let listed: string[] = [];
    try { listed = JSON.parse(room.entity_ids || '[]') as string[]; } catch { /* treated as empty */ }
    db.prepare('UPDATE characters SET current_room_id = NULL WHERE current_room_id = ?').run(args.roomId!);
    db.prepare('UPDATE room_nodes SET entity_ids = ? WHERE id = ?').run('[]', args.roomId!);
    return {
        success: true, actionType: 'unseat', roomId: args.roomId,
        roomName: room.name,
        unseated: seated.map(s => ({ id: s.id, name: s.name })),
        ghostListingsCleared: listed.filter(id => !seated.some(s => s.id === id)),
        message: `"${room.name}" cleared: ${seated.length} seated character(s) unseated, ${listed.length} entity listing(s) wiped. Both sides agree: empty.`
    };
}

async function handleDeleteRoom(args: z.infer<typeof DeleteRoomSchema>, ctx?: SessionContext): Promise<object> {
    if (!ctx) throw new Error('No session context');
    const db = getDb();

    const room = db.prepare('SELECT id, name FROM room_nodes WHERE id = ?').get(args.roomId) as { id: string; name: string } | undefined;
    if (!room) return { error: true, message: `Room ${args.roomId} not found` };

    const seated = db.prepare('SELECT id, name FROM characters WHERE current_room_id = ?').all(args.roomId) as Array<{ id: string; name: string }>;
    if (seated.length > 0 && !args.force) {
        return {
            error: true,
            message: `Room "${room.name}" has ${seated.length} seated character(s): ${seated.map(s => s.name).join(', ')}. Move them first, or pass force:true to unseat and delete.`
        };
    }
    if (seated.length > 0) {
        db.prepare('UPDATE characters SET current_room_id = NULL WHERE current_room_id = ?').run(args.roomId);
    }

    // Scrub exits in other rooms that point at the deleted room.
    let exitsCleaned = 0;
    const referencing = db.prepare(`SELECT id, exits FROM room_nodes WHERE id != ? AND exits LIKE '%' || ? || '%'`).all(args.roomId, args.roomId) as Array<{ id: string; exits: string }>;
    const updExits = db.prepare('UPDATE room_nodes SET exits = ? WHERE id = ?');
    for (const r of referencing) {
        try {
            const parsed = JSON.parse(r.exits || '[]') as unknown[];
            const filtered = parsed.filter(e => !JSON.stringify(e).includes(args.roomId));
            if (filtered.length !== parsed.length) {
                updExits.run(JSON.stringify(filtered), r.id);
                exitsCleaned++;
            }
        } catch { /* malformed exits JSON — leave untouched */ }
    }

    db.prepare('DELETE FROM room_nodes WHERE id = ?').run(args.roomId);

    return {
        success: true,
        actionType: 'delete_room',
        roomId: args.roomId,
        roomName: room.name,
        unseated: seated.map(s => s.name),
        exitsCleaned,
        message: `Room "${room.name}" deleted${seated.length ? `, ${seated.length} character(s) unseated` : ''}${exitsCleaned ? `, ${exitsCleaned} room(s) had exits scrubbed` : ''}`
    };
}

async function handleList(args: z.infer<typeof ListSchema>, ctx?: SessionContext): Promise<object> {
    if (!ctx) throw new Error('No session context');
    const result = await handleListRooms({ biome: args.biome }, ctx);
    const data = extractResultData(result, 'list') as Record<string, unknown>;
    // FINDINGS #106: networkId and worldId were parsed and DROPPED at this
    // forward — list returned every campaign's rooms (66 across three worlds,
    // per the field report). Accept-and-discard, READ-lane edition. Filter by
    // id-set with an honest excluded count; a failed filter SAYS SO instead
    // of silently widening (law 17's read-lane cousin).
    const rooms = data.rooms as Array<Record<string, unknown>> | undefined;
    if (rooms && (args.networkId || args.worldId)) {
        try {
            const db = getDb();
            let allowed: Set<string> | null = null;
            if (args.networkId) {
                allowed = new Set((db.prepare('SELECT id FROM room_nodes WHERE network_id = ?').all(args.networkId) as Array<{ id: string }>).map(r => r.id));
            }
            if (args.worldId) {
                const wset = new Set((db.prepare('SELECT rn.id FROM room_nodes rn JOIN node_networks nn ON rn.network_id = nn.id WHERE nn.world_id = ?').all(args.worldId) as Array<{ id: string }>).map(r => r.id));
                allowed = allowed ? new Set([...allowed].filter(id => wset.has(id))) : wset;
            }
            const before = rooms.length;
            const kept = rooms.filter(r => allowed!.has(String(r.id)));
            data.rooms = kept;
            data.count = kept.length;
            data.excludedOutOfScope = before - kept.length;
            data.scope = { ...(args.networkId ? { networkId: args.networkId } : {}), ...(args.worldId ? { worldId: args.worldId } : {}) };
        } catch {
            data.scopeWarning = 'scope filter failed on this build — result is UNSCOPED (#106)';
        }
    }
    return data;
}

async function handleNetworkCreate(args: z.infer<typeof NetworkCreateSchema>, ctx?: SessionContext): Promise<object> {
    if (!ctx) throw new Error('No session context');
    const result = await handleCreateNodeNetwork({
        name: args.name,
        networkType: args.networkType,
        worldId: args.worldId,
        centerX: args.centerX,
        centerY: args.centerY,
        boundingBox: args.boundingBox
    }, ctx);
    return extractResultData(result, 'network_create');
}

async function handleNetworkGet(args: z.infer<typeof NetworkGetSchema>, ctx?: SessionContext): Promise<object> {
    if (!ctx) throw new Error('No session context');
    const result = await handleGetNodeNetwork({ networkId: args.networkId }, ctx);
    return extractResultData(result, 'network_get');
}

async function handleNetworkList(args: z.infer<typeof NetworkListSchema>, ctx?: SessionContext): Promise<object> {
    if (!ctx) throw new Error('No session context');
    const result = await handleListNodeNetworks({ worldId: args.worldId }, ctx);
    return extractResultData(result, 'network_list');
}

function extractResultData(result: McpResponse, actionType: string): Record<string, unknown> {
    try {
        const data = JSON.parse(result.content[0].text);
        return { actionType, ...data };
    } catch {
        return { success: false, actionType, rawData: result.content[0].text };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

// FINDINGS #96 (GAP 9): LINK — the most-missed verb. Two rooms, a direction,
// bidirectional by default. Exits are {direction, targetNodeId, type} objects
// in the room's exits JSON; link writes both sides (or one, if asked) and
// REPLACES an existing exit in that direction rather than duplicating.
// Also the GAP 8 answer while auto-linking waits: build linear networks with
// generate then one link call per pair.
const OPPOSITES: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up', northeast: 'southwest', southwest: 'northeast', northwest: 'southeast', southeast: 'northwest' };
const LinkSchema = z.object({
    action: z.literal('link'),
    fromRoomId: z.string().describe('Room the exit leaves'),
    toRoomId: z.string().describe('Room the exit reaches'),
    direction: z.enum(['north', 'south', 'east', 'west', 'up', 'down', 'northeast', 'northwest', 'southeast', 'southwest']).describe('Direction FROM from-room TO to-room'),
    bidirectional: z.boolean().optional().default(true).describe('Also write the reverse exit (default true)'),
    exitType: z.string().optional().default('passage').describe('door, passage, ladder, hatch, hole… — free text')
});
async function handleLink(args: z.infer<typeof LinkSchema>): Promise<object> {
    const db = getDb();
    const rooms = [args.fromRoomId, args.toRoomId].map(id => db.prepare('SELECT id, name, exits FROM room_nodes WHERE id = ?').get(id) as { id: string; name: string; exits: string } | undefined);
    if (!rooms[0]) return { error: true, message: `from-room ${args.fromRoomId} not found — nothing linked` };
    if (!rooms[1]) return { error: true, message: `to-room ${args.toRoomId} not found — nothing linked` };
    // Item 6: type is the exit enum the room reader parses (OPEN, LOCKED,
    // HIDDEN); the free text goes in kind. Writing 'passage' as the type
    // made every linked room throw on read.
    const exit = { type: exitTypeFor(args.exitType), kind: args.exitType };
    const r1 = writeExit(db, rooms[0]!.id, args.direction, args.toRoomId, exit);
    let r2 = false;
    if (args.bidirectional) r2 = writeExit(db, rooms[1]!.id, OPPOSITES[args.direction], args.fromRoomId, exit);
    return {
        success: true,
        actionType: 'link',
        from: { roomId: rooms[0]!.id, name: rooms[0]!.name, direction: args.direction, replacedExisting: r1 },
        ...(args.bidirectional ? { to: { roomId: rooms[1]!.id, name: rooms[1]!.name, direction: OPPOSITES[args.direction], replacedExisting: r2 } } : { oneWay: true }),
        exitType: args.exitType,
        exitEnum: exit.type,
        message: `${rooms[0]!.name} ─${args.direction}→ ${rooms[1]!.name}${args.bidirectional ? ` (and back, ${OPPOSITES[args.direction]})` : ' (ONE WAY)'}`
    };
}

/** Write (or replace) the exit in one direction of a room; true when one was replaced. */
function writeExit(db: ReturnType<typeof getDb>, roomId: string, direction: string, targetNodeId: string, extra: Record<string, unknown>): boolean {
    const row = db.prepare('SELECT exits FROM room_nodes WHERE id = ?').get(roomId) as { exits?: string } | undefined;
    let exits: Array<Record<string, unknown>> = [];
    try { exits = JSON.parse(row?.exits || '[]'); } catch { exits = []; }
    const replaced = exits.some(e => e.direction === direction);
    exits = exits.filter(e => e.direction !== direction);
    exits.push({ direction, targetNodeId, ...extra });
    db.prepare('UPDATE room_nodes SET exits = ? WHERE id = ?').run(JSON.stringify(exits), roomId);
    return replaced;
}

// ═══════════════════════════════════════════════════════════════════════════
// Item 6: GATES — realmgates, toll bridges, portcullises. A gate joins two
// rooms (often in different networks) with a travel time, a toll in gold, a
// holder (who keeps it; informational) and a status (open | closed). Its
// exits carry kind 'gate' and its id; a closed gate's exits are LOCKED.
// traverse moves a character through it, pays the toll and, with
// advanceClock, moves the world clock by the travel time.
// ═══════════════════════════════════════════════════════════════════════════
const tollSchema = () => z.object({
    gold: z.number().min(0).optional(),
    silver: z.number().min(0).optional(),
    copper: z.number().min(0).optional()
}).describe('Toll each traveller pays from their own purse: {gold?, silver?, copper?}');
const gateStatusSchema = () => z.enum(['open', 'closed']);
type Toll = { gold?: number; silver?: number; copper?: number };

function gdb() {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS gates (
        id TEXT PRIMARY KEY, world_id TEXT, name TEXT NOT NULL,
        from_room_id TEXT NOT NULL, to_room_id TEXT NOT NULL, direction TEXT NOT NULL,
        travel_hours REAL NOT NULL DEFAULT 0, toll TEXT, holder TEXT,
        status TEXT NOT NULL DEFAULT 'open', bidirectional INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL)`);
    return db;
}
type GateRow = { id: string; world_id: string | null; name: string; from_room_id: string; to_room_id: string; direction: string; travel_hours: number; toll: string | null; holder: string | null; status: string; bidirectional: number };
const parseToll = (t: string | null): Toll | null => { try { const v = t ? JSON.parse(t) : null; return v && Object.values(v).some(n => Number(n) > 0) ? v : null; } catch { return null; } };
const tollText = (t: Toll | null) => t ? [t.gold ? `${t.gold} gold` : '', t.silver ? `${t.silver} silver` : '', t.copper ? `${t.copper} copper` : ''].filter(Boolean).join(', ') : 'none';
const gateView = (g: GateRow) => ({
    gateId: g.id, worldId: g.world_id, name: g.name, fromRoomId: g.from_room_id, toRoomId: g.to_room_id,
    direction: g.direction, travelHours: g.travel_hours, toll: parseToll(g.toll), holder: g.holder,
    status: g.status, bidirectional: !!g.bidirectional
});
const findGate = (db: ReturnType<typeof getDb>, id?: string) => id ? ((db.prepare('SELECT * FROM gates WHERE id = ?').get(id) as GateRow | undefined) ?? null) : null;
function writeGateExits(db: ReturnType<typeof getDb>, g: GateRow): void {
    const extra = { type: g.status === 'closed' ? 'LOCKED' : 'OPEN', kind: 'gate', gateId: g.id, description: `${g.name} (gate)` };
    writeExit(db, g.from_room_id, g.direction, g.to_room_id, extra);
    if (g.bidirectional) writeExit(db, g.to_room_id, OPPOSITES[g.direction], g.from_room_id, extra);
}

const GateCreateSchema = z.object({
    action: z.literal('gate_create'),
    worldId: z.string().optional().describe("World the gate belongs to (default: the from-room's network world); traverse advanceClock moves this world's clock"),
    name: z.string().min(1).describe('Gate name'),
    fromRoomId: z.string().describe('Room on the near side'),
    toRoomId: z.string().describe('Room on the far side (any network)'),
    direction: DirectionEnum.describe('Direction FROM from-room through the gate'),
    travelHours: z.number().min(0).optional().describe('In-fiction hours the crossing takes (default 0)'),
    toll: tollSchema().optional(),
    holder: z.string().optional().describe('Who holds the gate (informational)'),
    status: gateStatusSchema().optional().describe('open (default) | closed'),
    bidirectional: z.boolean().optional().default(true).describe('Travel both ways (default true)')
});
const GateListSchema = z.object({
    action: z.literal('gate_list'),
    worldId: z.string().optional().describe('Filter: gates of this world'),
    roomId: z.string().optional().describe('Filter: gates with an end in this room')
});
const SetGateSchema = z.object({
    action: z.literal('set_gate'),
    gateId: z.string().describe('Gate id'),
    status: gateStatusSchema().optional().describe('open | closed (its exits follow: OPEN | LOCKED)'),
    holder: z.string().optional().describe('Who holds it now'),
    toll: tollSchema().optional(),
    travelHours: z.number().min(0).optional(),
    name: z.string().optional()
});
const TraverseSchema = z.object({
    action: z.literal('traverse'),
    gateId: z.string().describe('Gate to pass through'),
    characterId: z.string().describe('Traveller; must be seated at one end (the far end only when bidirectional)'),
    advanceClock: z.boolean().optional().describe("true: move the gate's world clock forward by its travelHours (world_manage advance; dueNow returned)")
});

async function handleGateCreate(args: z.infer<typeof GateCreateSchema>): Promise<object> {
    const db = gdb();
    const rooms = [args.fromRoomId, args.toRoomId].map(id => db.prepare('SELECT id, name, network_id FROM room_nodes WHERE id = ?').get(id) as { id: string; name: string; network_id: string | null } | undefined);
    if (!rooms[0]) return { error: true, message: `from-room ${args.fromRoomId} not found. Nothing was written.` };
    if (!rooms[1]) return { error: true, message: `to-room ${args.toRoomId} not found. Nothing was written.` };
    const worldId = args.worldId ?? (rooms[0].network_id
        ? (db.prepare('SELECT world_id FROM node_networks WHERE id = ?').get(rooms[0].network_id) as { world_id?: string } | undefined)?.world_id ?? null
        : null);
    const id = `gate-${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO gates (id, world_id, name, from_room_id, to_room_id, direction, travel_hours, toll, holder, status, bidirectional, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, worldId, args.name, args.fromRoomId, args.toRoomId, args.direction, args.travelHours ?? 0, args.toll ? JSON.stringify(args.toll) : null, args.holder ?? null, args.status ?? 'open', args.bidirectional ? 1 : 0, new Date().toISOString());
    const g = findGate(db, id)!;
    writeGateExits(db, g);
    return {
        success: true, actionType: 'gate_create', gateId: id, gate: gateView(g),
        message: `${args.name}: ${rooms[0].name} ─${args.direction}→ ${rooms[1].name}${args.bidirectional ? ' (both ways)' : ' (ONE WAY)'}, ${g.travel_hours}h, toll ${tollText(parseToll(g.toll))}${g.holder ? `, held by ${g.holder}` : ''} — ${g.status}`
    };
}

async function handleGateList(args: z.infer<typeof GateListSchema>): Promise<object> {
    const db = gdb();
    const where: string[] = []; const params: unknown[] = [];
    if (args.worldId) { where.push('world_id = ?'); params.push(args.worldId); }
    if (args.roomId) { where.push('(from_room_id = ? OR to_room_id = ?)'); params.push(args.roomId, args.roomId); }
    const rows = db.prepare(`SELECT * FROM gates${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`).all(...params) as GateRow[];
    return { success: true, actionType: 'gate_list', count: rows.length, gates: rows.map(gateView), message: `${rows.length} gate(s)` };
}

async function handleSetGate(args: z.infer<typeof SetGateSchema>): Promise<object> {
    const db = gdb();
    const g = findGate(db, args.gateId);
    if (!g) return { error: true, message: `No gate ${args.gateId}. Nothing was written.` };
    db.prepare('UPDATE gates SET status = ?, holder = ?, toll = ?, travel_hours = ?, name = ? WHERE id = ?')
        .run(args.status ?? g.status, args.holder ?? g.holder, args.toll ? JSON.stringify(args.toll) : g.toll, args.travelHours ?? g.travel_hours, args.name ?? g.name, g.id);
    const after = findGate(db, g.id)!;
    writeGateExits(db, after);
    return { success: true, actionType: 'set_gate', gateId: g.id, gate: gateView(after), message: `${after.name}: ${after.status}${after.holder ? `, held by ${after.holder}` : ''}, toll ${tollText(parseToll(after.toll))}` };
}

async function handleTraverse(args: z.infer<typeof TraverseSchema>): Promise<object> {
    const db = gdb();
    const g = findGate(db, args.gateId);
    if (!g) return { error: true, message: `No gate ${args.gateId}. Nothing was written.` };
    if (g.status !== 'open') return { error: true, message: `${g.name} is closed${g.holder ? ` (held by ${g.holder})` : ''}: set_gate {status: 'open'} first. Nothing was written.` };
    const character = new CharacterRepository(db).findById(args.characterId);
    if (!character) return { error: true, message: `Character ${args.characterId} not found. Nothing was written.` };
    const at = (character as unknown as { currentRoomId?: string }).currentRoomId;
    let toRoomId: string;
    if (at === g.from_room_id) toRoomId = g.to_room_id;
    else if (at === g.to_room_id) {
        if (!g.bidirectional) return { error: true, message: `${g.name} is one way (from ${g.from_room_id}); ${character.name} is on the far side. Nothing was written.` };
        toRoomId = g.from_room_id;
    } else return { error: true, message: `${character.name} is not at ${g.name} (seated in ${at ?? 'no room'}; its ends are ${g.from_room_id} and ${g.to_room_id}). Move there first. Nothing was written.` };
    if (!db.prepare('SELECT 1 FROM room_nodes WHERE id = ?').get(toRoomId)) return { error: true, message: `${g.name} leads to room ${toRoomId}, which no longer exists. Nothing was written.` };
    if (args.advanceClock && g.travel_hours > 0) {
        if (!g.world_id) return { error: true, message: `${g.name} has no world, so advanceClock has no clock to move. Nothing was written.` };
        if (!readWorldClock(db, g.world_id)) return { error: true, message: `World ${g.world_id} has no clock for advanceClock: ${SET_CLOCK_HINT}. Nothing was written.` };
    }
    const toll = parseToll(g.toll);
    const inv = new InventoryRepository(db);
    if (toll && !inv.hasCurrency(character.id, toll)) {
        const purse = inv.getCurrency(character.id);
        return { error: true, message: `${character.name} cannot pay the toll of ${tollText(toll)} (purse: ${purse.gold} gold, ${purse.silver} silver, ${purse.copper} copper). Nothing was written.` };
    }
    const names = db.prepare('SELECT id, name FROM room_nodes WHERE id IN (?, ?)').all(at, toRoomId) as Array<{ id: string; name: string }>;
    const nameOf = (id: string) => names.find(n => n.id === id)?.name ?? id;
    const move = db.transaction(() => {
        // Seat first: the seat writes the whole sheet it read, purse included,
        // so the toll comes off after it.
        seatCharacterInRoom(character, toRoomId);
        if (toll && !inv.removeCurrency(character.id, toll)) throw new Error('toll could not be taken');
    });
    move();
    let clock: Record<string, unknown> | undefined;
    if (args.advanceClock && g.travel_hours > 0 && g.world_id) {
        const r = advanceWorldClock(g.world_id, g.travel_hours);
        clock = { clock: r.clock, elapsedHours: r.elapsedHours, dueNow: r.dueNow, ...(r.regenerated ? { regenerated: r.regenerated } : {}), ...(r.error ? { error: r.error, message: r.message } : {}) };
    }
    return {
        success: true, actionType: 'traverse', gateId: g.id, gateName: g.name, characterId: character.id, characterName: character.name,
        from: { roomId: at, name: nameOf(at!) }, to: { roomId: toRoomId, name: nameOf(toRoomId) },
        travelHours: g.travel_hours, ...(toll ? { tollPaid: toll } : {}), ...(g.holder ? { holder: g.holder } : {}),
        ...(clock ? { clock } : {}),
        message: `${character.name} passes ${g.name}: ${nameOf(at!)} → ${nameOf(toRoomId)}${toll ? `, paying ${tollText(toll)}` : ''}${g.travel_hours ? ` (${g.travel_hours}h${clock ? `; clock now ${String(clock.clock)}` : ' — the clock was not moved; pass advanceClock: true'})` : ''}`
    };
}

const definitions: Record<SpatialAction, ActionDefinition> = {
    look: {
        schema: LookSchema,
        handler: handleLook,
        aliases: ['observe', 'surroundings', 'look_at'],
        description: 'Look at surroundings - filtered by darkness, fog, perception'
    },
    generate: {
        schema: GenerateSchema,
        handler: handleGenerate,
        aliases: ['create', 'room', 'new_room'],
        description: 'Create a persistent room with immutable description'
    },
    update: {
        schema: UpdateSchema,
        handler: handleUpdate,
        aliases: ['edit', 'patch'],
        description: 'Partially update room description, biome, or atmospherics'
    },
    get_exits: {
        schema: GetExitsSchema,
        handler: handleGetExits,
        aliases: ['exits', 'doors'],
        description: 'Get all exits from a room'
    },
    link: {
        schema: LinkSchema,
        handler: handleLink,
        aliases: ['connect', 'join_rooms', 'add_exit'],
        description: 'FINDINGS #96: link two rooms with an exit — bidirectional by default, replaces same-direction exits, free exitType (door/ladder/hatch). {fromRoomId, toRoomId, direction, bidirectional?, exitType?}'
    },
    move: {
        schema: MoveSchema,
        handler: handleMove,
        aliases: ['enter', 'go', 'travel'],
        description: 'Move a character to a room'
    },
    unseat: {
        schema: z.object({
            action: z.literal('unseat'),
            characterId: z.string().optional().describe('Unseat one character wherever they sit (both bookkeeping sides + ghost listings)'),
            roomId: z.string().optional().describe('Unseat EVERY occupant of one room — the purge pass for stale campaign seatings')
        }),
        handler: handleUnseat,
        aliases: ['clear_room', 'evict', 'purge_seating'],
        description: '#67-E: Clear room occupancy on BOTH sides (characters.current_room_id + room_nodes.entity_ids). Campaign resets never touched seatings — this is the broom'
    },
    delete_room: {
        schema: DeleteRoomSchema,
        handler: handleDeleteRoom,
        aliases: ['remove_room', 'demolish'],
        description: 'Delete a spatial room node — refuses if occupied unless force:true; scrubs exits pointing at it'
    },
    list: {
        schema: ListSchema,
        handler: handleList,
        aliases: ['rooms', 'all_rooms'],
        description: 'List all rooms, optionally filtered by biome'
    },
    network_create: {
        schema: NetworkCreateSchema,
        handler: handleNetworkCreate,
        aliases: ['create_network'],
        description: 'Create a node network for a town, road, or dungeon'
    },
    network_get: {
        schema: NetworkGetSchema,
        handler: handleNetworkGet,
        aliases: ['get_network'],
        description: 'Get a node network by ID'
    },
    network_list: {
        schema: NetworkListSchema,
        handler: handleNetworkList,
        aliases: ['networks'],
        description: 'List node networks, optionally filtered by world'
    },
    gate_create: {
        schema: GateCreateSchema,
        handler: handleGateCreate,
        aliases: ['create_gate', 'realmgate', 'add_gate'],
        description: 'Item 6: a gate between two rooms (any networks): {name, fromRoomId, toRoomId, direction, travelHours?, toll?: {gold}, holder?, status?, bidirectional?, worldId?}. Writes exits of kind gate on both sides'
    },
    gate_list: {
        schema: GateListSchema,
        handler: handleGateList,
        aliases: ['gates', 'list_gates'],
        description: 'List gates, by worldId and/or roomId'
    },
    set_gate: {
        schema: SetGateSchema,
        handler: handleSetGate,
        aliases: ['update_gate', 'open_gate', 'close_gate'],
        description: 'Change a gate: status open|closed (exits follow), holder, toll, travelHours, name'
    },
    traverse: {
        schema: TraverseSchema,
        handler: handleTraverse,
        aliases: ['pass_gate', 'cross', 'use_gate'],
        description: 'Pass a character through an open gate: pays the toll from their purse (refused if short), moves them to the other end, and with advanceClock moves the world clock by travelHours'
    }
};

const router = createActionRouter({
    actions: ACTIONS,
    definitions,
    threshold: 0.6
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEFINITION & HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export const SpatialManageTool = {
    name: 'spatial_manage',
    description: `Manage spatial graph - rooms, exits, and character locations.
Actions: look, generate, update, get_exits, link, move, unseat, delete_room, list, network_create, network_get, network_list, gate_create, gate_list, set_gate, traverse
Aliases: observe→look, create→generate, edit→update, exits→get_exits, enter→move, rooms→list, networks→network_list

🏠 SPATIAL WORKFLOW:
1. network_create - Create a spatial network for a town, dungeon, road, or region
2. generate - Create a new room with description, atmospherics, and optional local coordinates
3. update - Patch room description, biome, or atmospherics
4. look - View room from character's perspective (perception-filtered)
5. get_exits - Get all exits from a room
6. move - Move character to a room
7. list / network_list - List rooms or networks
8. link - Join two rooms with an exit (exitType door/ladder/hatch is the exit's kind; 'locked …' / 'hidden …' lock or hide it)
9. gate_create / gate_list / set_gate / traverse - Gates between rooms of any networks: travel hours, a toll in gold, a holder, open or closed; traverse {gateId, characterId, advanceClock?} pays and crosses

Environmental effects: DARKNESS, FOG, ANTIMAGIC, SILENCE, BRIGHT, MAGICAL
Biomes: forest, mountain, urban, dungeon, coastal, cavern, divine, arcane`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        observerId: z.string().optional().describe('Observer character ID (for look)'),
        characterId: z.string().optional().describe('Character ID (for move)'),
        roomId: z.string().optional().describe('Room ID'),
        // FINDINGS #96 (mirror law): link params
        fromRoomId: z.string().optional().describe('link: room the exit leaves'),
        toRoomId: z.string().optional().describe('link: room the exit reaches'),
        bidirectional: z.boolean().optional().describe('link: write the reverse exit too (default true)'),
        exitType: z.string().optional().describe('link: door, passage, ladder, hatch… free text'),
        force: z.boolean().optional().describe('delete_room: unseat occupants and delete anyway'),
        name: z.string().optional().describe('Room or network name'),
        baseDescription: z.string().optional().describe('Room description (for generate/update)'),
        biomeContext: biomeSchema().optional().describe('Biome type'),
        atmospherics: z.array(AtmosphericEnum).optional(),
        previousNodeId: z.string().optional(),
        autoLink: z.boolean().optional().describe('#96 generate: linear networks auto-link to the previous room; false suppresses'),
        direction: DirectionEnum.optional(),
        biome: biomeSchema().optional().describe('Filter biome (for list)'),
        networkId: z.string().optional().describe('Node network ID'),
        networkType: NetworkTypeEnum.optional().describe('Network shape'),
        worldId: z.string().optional().describe('World ID'),
        centerX: z.number().optional().describe('Network center X'),
        centerY: z.number().optional().describe('Network center Y'),
        boundingBox: BoundingBoxSchema.optional().describe('Network bounding box'),
        localX: z.number().optional().describe('Room local X within network'),
        localY: z.number().optional().describe('Room local Y within network'),
        // Item 6 (mirror law): gate params
        gateId: z.string().optional().describe('set_gate / traverse: gate id'),
        travelHours: z.number().min(0).optional().describe('gate_create / set_gate: in-fiction hours the crossing takes'),
        toll: tollSchema().optional(),
        holder: z.string().optional().describe('gate_create / set_gate: who holds the gate (informational)'),
        status: gateStatusSchema().optional().describe('gate_create / set_gate: open | closed'),
        advanceClock: z.boolean().optional().describe("traverse: move the gate's world clock by its travelHours")
    })
};

export async function handleSpatialManage(args: unknown, ctx: SessionContext): Promise<McpResponse> {
    try {
        const result = await router(args as Record<string, unknown>, ctx);
        const parsed = JSON.parse(result.content[0].text);

        let output = '';

        if (parsed.error) {
            output = RichFormatter.header('Error', '❌');
            output += RichFormatter.alert(parsed.message || parsed.error || 'Unknown error', 'error');
            if (parsed.suggestions) {
                output += '\n**Did you mean:**\n';
                parsed.suggestions.forEach((s: { value: string; similarity: number }) => {
                    output += `  • ${s.value} (${s.similarity}% match)\n`;
                });
            }
        } else {
            switch (parsed.actionType) {
                case 'look':
                    output = RichFormatter.header(parsed.roomName || 'Surroundings', '👁️');
                    if (parsed.description) {
                        output += '\n' + parsed.description + '\n\n';
                    }
                    if (parsed.exits?.length > 0) {
                        output += '**Exits:**\n';
                        parsed.exits.forEach((e: { direction: string; description?: string; type: string }) => {
                            output += `  • ${e.direction}: ${e.description || e.type}\n`;
                        });
                    }
                    if (parsed.atmospherics?.length > 0) {
                        output += `\n**Atmospherics:** ${parsed.atmospherics.join(', ')}\n`;
                    }
                    break;
                case 'generate':
                    output = RichFormatter.header('Room Created', '🏠');
                    output += RichFormatter.keyValue({
                        'ID': `\`${parsed.roomId}\``,
                        'Name': parsed.name,
                        'Biome': parsed.biomeContext,
                        'Network': parsed.networkId ? `\`${parsed.networkId}\`` : 'None',
                        'Linked': parsed.linkedToPrevious ? '✅' : '❌'
                    });
                    break;
                case 'update':
                    output = RichFormatter.header('Room Updated', '🏠');
                    output += RichFormatter.keyValue({
                        'ID': `\`${parsed.roomId}\``,
                        'Name': parsed.name,
                        'Biome': parsed.biomeContext,
                        'Atmospherics': parsed.atmospherics?.join(', ') || 'None'
                    });
                    break;
                case 'get_exits':
                    output = RichFormatter.header(`Exits from ${parsed.roomName || 'Room'}`, '🚪');
                    if (parsed.exits?.length > 0) {
                        parsed.exits.forEach((e: { direction: string; targetNodeId: string; type: string }) => {
                            output += `  • **${e.direction}** → \`${e.targetNodeId}\` (${e.type})\n`;
                        });
                    } else {
                        output += 'No exits.\n';
                    }
                    break;
                case 'move':
                    output = RichFormatter.header('Character Moved', '🚶');
                    output += RichFormatter.keyValue({
                        'Character': parsed.characterName,
                        'To Room': parsed.newRoomName,
                        'Visit #': parsed.visitedCount
                    });
                    break;
                case 'list':
                    output = RichFormatter.header(`Rooms (${parsed.count})`, '🏠');
                    if (parsed.rooms?.length > 0) {
                        parsed.rooms.forEach((r: { name: string; id: string; biomeContext: string; exitCount: number; entityCount: number; visitedCount: number }) => {
                            output += `• **${r.name}** (\`${r.id}\`) - ${r.biomeContext}\n`;
                            output += `  Exits: ${r.exitCount} | Entities: ${r.entityCount} | Visits: ${r.visitedCount}\n`;
                        });
                    } else {
                        output += 'No rooms found.\n';
                    }
                    break;
                case 'network_create':
                    output = RichFormatter.header('Network Created', '🗺️');
                    output += RichFormatter.keyValue({
                        'ID': `\`${parsed.networkId}\``,
                        'Name': parsed.name,
                        'Type': parsed.networkType,
                        'World': parsed.worldId
                    });
                    break;
                case 'network_get':
                    output = RichFormatter.header(parsed.name || 'Network', '🗺️');
                    output += RichFormatter.keyValue({
                        'ID': `\`${parsed.networkId}\``,
                        'Type': parsed.networkType,
                        'World': parsed.worldId,
                        'Center': `${parsed.centerX}, ${parsed.centerY}`
                    });
                    break;
                case 'network_list':
                    output = RichFormatter.header(`Networks (${parsed.count})`, '🗺️');
                    if (parsed.networks?.length > 0) {
                        parsed.networks.forEach((n: { name: string; id: string; networkType: string; worldId: string }) => {
                            output += `• **${n.name}** (\`${n.id}\`) - ${n.networkType} / ${n.worldId}\n`;
                        });
                    } else {
                        output += 'No networks found.\n';
                    }
                    break;
                default:
                    output = RichFormatter.header('Spatial', '🏠');
                    if (parsed.message) output += parsed.message + '\n';
            }
        }

        output += RichFormatter.embedJson(parsed, 'SPATIAL_MANAGE');

        return {
            content: [{
                type: 'text' as const,
                text: output
            }]
        };
    } catch (error) {
        return {
            content: [{
                type: 'text' as const,
                text: RichFormatter.header('Error', '') +
                    RichFormatter.alert(error instanceof Error ? error.message : String(error), 'error')
            }]
        };
    }
}
