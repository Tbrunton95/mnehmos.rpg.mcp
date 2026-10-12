/**
 * Consolidated Party Management Tool
 *
 * Replaces 16 individual tools with a single action-based tool:
 * - create_party -> action: 'create'
 * - get_party -> action: 'get'
 * - list_parties -> action: 'list'
 * - update_party -> action: 'update'
 * - delete_party -> action: 'delete'
 * - add_party_member -> action: 'add_member'
 * - remove_party_member -> action: 'remove_member'
 * - update_party_member -> action: 'update_member'
 * - set_party_leader -> action: 'set_leader'
 * - set_active_character -> action: 'set_active'
 * - get_party_members -> action: 'get_members'
 * - get_party_context -> action: 'get_context'
 * - get_unassigned_characters -> action: 'get_unassigned'
 * - move_party -> action: 'move'
 * - get_party_position -> action: 'get_position'
 * - get_parties_in_region -> action: 'get_in_region'
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { SessionContext } from '../types.js';
import { getDb } from '../../storage/index.js';
import { PartyRepository } from '../../storage/repos/party.repo.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { QuestRepository } from '../../storage/repos/quest.repo.js';
import {
    Party,
    PartyMember,
    PartyStatusSchema,
    PartyContext
} from '../../schema/party.js';
import { InventoryRepository } from '../../storage/repos/inventory.repo.js';
import { EncounterRepository } from '../../storage/repos/encounter.repo.js';
import { handleKill } from './character-manage.js';
import { creditGrowth } from '../growth.js';
import { resolveWorldId } from '../../engine/table-rules.js';
import { readWorldClock, clockLabel, SET_CLOCK_HINT } from '../../engine/world-clock.js';
import { pushPoolHistory } from '../../engine/scheduled-ops.js';
import {
    linkPoolSchema, mouthPoolSchema, starvationSchema, DEFAULT_STARVATION,
    countMouths, daysLeft, starvationTarget, tickUpkeep,
    ensureUpkeepColumn, parseUpkeep, readUpkeep, writeUpkeep, storesLine, UNITS_NOTE,
    type PartyUpkeep, type PoolRef, type MouthCount, type UpkeepRole
} from '../../engine/party-upkeep.js';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { RichFormatter } from '../utils/formatter.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = [
    'create', 'get', 'list', 'update', 'delete',
    'add_member', 'remove_member', 'update_member', 'set_leader', 'set_active', 'get_members',
    'get_context', 'get_unassigned',
    'move', 'get_position', 'get_in_region',
    'muster', 'pay', 'after_battle',
    'set_upkeep', 'upkeep'
] as const;
type PartyAction = typeof ACTIONS[number];

const memberRoleSchema = () => z.enum(['leader', 'member', 'companion', 'hireling', 'prisoner', 'mount']);
// Item 7: the warband fields, as factories so inner and outer never share an instance.
const loyaltySchema = () => z.number().int().min(0).max(10).describe('Loyalty 0-10 (unset reads 5): paid +1, unpaid -1, victory +1, defeat -1');
const wageSchema = () => z.number().min(0).describe('Gold owed each pay (payMode wage)');
const payModeSchema = () => z.enum(['wage', 'share', 'none']).describe('wage: paid wage first; share: split what is left by sharePercentage; none: never paid (default: wage when a wage is set, else none)');
const unitModelsSchema = () => z.number().int().min(0).describe('Models in the unit this member stands for; losing the last one kills it');
const recruitSchema = () => z.object({
    characterId: z.string(),
    role: memberRoleSchema().optional(),
    loyalty: loyaltySchema().optional(),
    wage: wageSchema().optional(),
    payMode: payModeSchema().optional(),
    unitModels: unitModelsSchema().optional()
});
const casualtySchema = () => z.object({
    characterId: z.string(),
    models: z.number().int().min(0).optional().describe('Models the unit lost'),
    dead: z.boolean().optional().describe('The member died (a unit also dies at 0 models)')
});
// Play report 3: after_battle names who fought. Factories, like the rest.
const participantsSchema = () => z.array(z.string()).min(1).describe('after_battle: who fought, as member character ids (short ids resolve) or names (case-insensitive). An unknown name or id, a non-member, or a name two members share is refused and nothing is written. Casualties always count as having fought');
const encounterIdSchema = () => z.union([z.string(), z.array(z.string()).min(1)]).describe('after_battle: the fight (or the fights a raid ran as). Every member whose character id was a token in a listed encounter or one of its boarding children fought; the rest are absent and untouched. A missing encounter, or one no member fought in, is refused. A prisoner never counts from an encounter (includeParty leaves them out, and a captive who was an enemy token did not fight for you); a member removed mid-fight with remove_participant reads as absent. Name either in participants if they did fight. Combined with participants as a union');

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb() {
    const db = getDb();
    return {
        db,
        partyRepo: new PartyRepository(db),
        charRepo: new CharacterRepository(db),
        questRepo: new QuestRepository(db)
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const InitialMemberSchema = z.object({
    characterId: z.string(),
    role: memberRoleSchema().optional().default('member')
});

const CreateSchema = z.object({
    action: z.literal('create'),
    name: z.string().min(1).describe('Party name (required)'),
    description: z.string().optional(),
    worldId: z.string().optional(),
    initialMembers: z.array(InitialMemberSchema).optional()
});

const GetSchema = z.object({
    action: z.literal('get'),
    partyId: z.string().describe('Party ID to retrieve')
});

const ListSchema = z.object({
    action: z.literal('list'),
    status: PartyStatusSchema.optional(),
    worldId: z.string().optional()
});

const UpdateSchema = z.object({
    action: z.literal('update'),
    partyId: z.string().describe('Party ID to update'),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    currentLocation: z.string().optional(),
    formation: z.string().optional(),
    status: PartyStatusSchema.optional(),
    // FINDINGS #78: notes is accepted ONLY to be REFUSED loudly in the
    // handler. Party notes was removed by GM ruling; before that ruling this
    // schema silently stripped the field (family appearance eight — the write
    // vanished with updatedAt still moving, three rebuilds running). Zod
    // strips unknown keys, so the only way to refuse honestly is to accept
    // the key into the parse and throw. Never delete this line without
    // deleting the reject below it.
    notes: z.string().optional()
});

const DeleteSchema = z.object({
    action: z.literal('delete'),
    partyId: z.string().describe('Party ID to delete')
});

const AddMemberSchema = z.object({
    action: z.literal('add_member'),
    partyId: z.string(),
    characterId: z.string(),
    role: memberRoleSchema().optional().default('member'),
    position: z.number().int().optional(),
    notes: z.string().optional(),
    loyalty: loyaltySchema().optional(),
    wage: wageSchema().optional(),
    payMode: payModeSchema().optional(),
    unitModels: unitModelsSchema().optional()
});

const RemoveMemberSchema = z.object({
    action: z.literal('remove_member'),
    partyId: z.string(),
    characterId: z.string()
});

const UpdateMemberSchema = z.object({
    action: z.literal('update_member'),
    partyId: z.string(),
    characterId: z.string(),
    role: memberRoleSchema().optional(),
    position: z.number().int().optional(),
    sharePercentage: z.number().int().min(0).max(100).optional(),
    notes: z.string().optional(),
    loyalty: loyaltySchema().optional(),
    wage: wageSchema().optional(),
    payMode: payModeSchema().optional(),
    unitModels: unitModelsSchema().optional()
});

const MusterSchema = z.object({
    action: z.literal('muster'),
    partyId: z.string()
});

const PaySchema = z.object({
    action: z.literal('pay'),
    partyId: z.string(),
    payerId: z.string().optional().describe('Whose purse pays (default: the party leader)'),
    amount: z.number().min(0).optional().describe('Gold to pay out in all: wages first, the rest split as shares. Omit to pay wages only')
});

const AfterBattleSchema = z.object({
    action: z.literal('after_battle'),
    partyId: z.string(),
    victory: z.boolean().describe('true: those who fought +1 loyalty (and victory growth); false: -1'),
    casualties: z.array(casualtySchema()).optional(),
    recruits: z.array(recruitSchema()).optional().describe('Characters who join after the battle (not moved by its loyalty)'),
    participants: participantsSchema().optional(),
    encounterId: encounterIdSchema().optional()
});

// Play report 3: upkeep. Stores are mouth-days in ONE linked character pool;
// the party row keeps the link, the mouth pools, the roles counted, the
// starvation rule and the last day charged.
const SetUpkeepSchema = z.object({
    action: z.literal('set_upkeep'),
    partyId: z.string(),
    worldId: z.string().optional().describe("The world whose clock drives upkeep (default: the party's; written to the party when passed)"),
    linkPool: linkPoolSchema().optional(),
    mouthsFromPool: z.array(mouthPoolSchema()).optional().describe("Pools whose current value is mouths to feed ('captives'), read live every day so captures, Turnings and deaths change the count by themselves"),
    extraMouths: z.number().int().min(0).optional().describe('Mouths on no sheet (camp hangers-on); 0 clears'),
    countRoles: z.array(memberRoleSchema()).optional().describe('Member roles that eat (default: every role; [] resets); a unit eats its unitModels'),
    starvation: starvationSchema().optional(),
    startDay: z.number().int().optional().describe('Charge from this day instead of today; a re-run keeps the stored day unless this is passed'),
    clear: z.boolean().optional().describe('Remove the upkeep link; the pool keeps its value')
});

const UpkeepSchema = z.object({
    action: z.literal('upkeep'),
    partyId: z.string(),
    days: z.number().int().min(1).describe('Whole days to charge by hand; lastDay moves by this and the clock catches up to it before charging again')
});

const SetLeaderSchema = z.object({
    action: z.literal('set_leader'),
    partyId: z.string(),
    characterId: z.string()
});

const SetActiveSchema = z.object({
    action: z.literal('set_active'),
    partyId: z.string(),
    characterId: z.string()
});

const GetMembersSchema = z.object({
    action: z.literal('get_members'),
    partyId: z.string()
});

const GetContextSchema = z.object({
    action: z.literal('get_context'),
    partyId: z.string(),
    verbosity: z.enum(['minimal', 'standard', 'detailed']).optional().default('standard')
});

const GetUnassignedSchema = z.object({
    action: z.literal('get_unassigned'),
    excludeEnemies: z.boolean().optional().default(true)
});

const MoveSchema = z.object({
    action: z.literal('move'),
    partyId: z.string(),
    targetX: z.number().int().nonnegative(),
    targetY: z.number().int().nonnegative(),
    locationName: z.string().min(1),
    poiId: z.string().optional()
});

const GetPositionSchema = z.object({
    action: z.literal('get_position'),
    partyId: z.string()
});

const GetInRegionSchema = z.object({
    action: z.literal('get_in_region'),
    worldId: z.string(),
    x: z.number().int(),
    y: z.number().int(),
    radiusSquares: z.number().int().optional().default(3)
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleCreate(args: z.infer<typeof CreateSchema>): Promise<object> {
    const { partyRepo, charRepo } = ensureDb();
    const now = new Date().toISOString();

    const party: Party = {
        id: randomUUID(),
        name: args.name,
        description: args.description,
        worldId: args.worldId,
        status: 'active',
        formation: 'standard',
        createdAt: now,
        updatedAt: now,
        lastPlayedAt: now
    };

    partyRepo.create(party);

    const addedMembers: { characterId: string; name: string; role: string }[] = [];
    let leaderId: string | null = null;

    if (args.initialMembers && args.initialMembers.length > 0) {
        for (let i = 0; i < args.initialMembers.length; i++) {
            const memberInput = args.initialMembers[i];
            const character = charRepo.findById(memberInput.characterId);

            if (!character) continue;

            const member: PartyMember = {
                id: randomUUID(),
                partyId: party.id,
                characterId: memberInput.characterId,
                role: memberInput.role || 'member',
                isActive: i === 0,
                position: i + 1,
                sharePercentage: 100,
                joinedAt: now
            };

            partyRepo.addMember(member);
            addedMembers.push({
                characterId: character.id,
                name: character.name,
                role: member.role
            });

            if (member.role === 'leader') {
                leaderId = character.id;
            }
        }
    }

    return {
        success: true,
        party,
        members: addedMembers,
        memberCount: addedMembers.length,
        leaderId,
        message: `Created party: ${party.name}`
    };
}

async function handleGet(args: z.infer<typeof GetSchema>): Promise<object> {
    const { partyRepo } = ensureDb();
    const party = partyRepo.getPartyWithMembers(args.partyId);

    if (!party) {
        throw new Error(`Party not found: ${args.partyId}`);
    }

    partyRepo.touchParty(args.partyId);
    return { ...party };
}

async function handleList(args: z.infer<typeof ListSchema>): Promise<object> {
    const { partyRepo } = ensureDb();
    const parties = partyRepo.findAll({
        status: args.status,
        worldId: args.worldId
    });

    const partiesWithCounts = parties.map(party => {
        const members = partyRepo.findMembersByParty(party.id);
        return { ...party, memberCount: members.length };
    });

    return {
        parties: partiesWithCounts,
        count: partiesWithCounts.length,
        filter: { status: args.status, worldId: args.worldId }
    };
}

async function handleUpdate(args: z.infer<typeof UpdateSchema>): Promise<object> {
    const { partyRepo } = ensureDb();
    // FINDINGS #78: refuse, don't strip — the #67-A shape. Party notes is not
    // a stored field (GM ruling); a silent strip here cost three rebuilds of
    // updatedAt-only ghost writes before the boundary was found.
    if (args.notes !== undefined) {
        throw new Error(`party 'notes' is not a stored field (removed by GM ruling, FINDINGS #78) — campaign text lives in narrative_manage; per-member notes live on update_member. NOTHING WAS WRITTEN.`);
    }
    const { partyId, action: _action, notes: _notes, ...updates } = args;

    const updated = partyRepo.update(partyId, updates);
    if (!updated) {
        throw new Error(`Party not found: ${partyId}`);
    }

    return {
        ...updated,
        success: true,
        message: 'Party updated successfully'
    };
}

async function handleDelete(args: z.infer<typeof DeleteSchema>): Promise<object> {
    const { partyRepo } = ensureDb();
    const deleted = partyRepo.delete(args.partyId);

    if (!deleted) {
        throw new Error(`Party not found: ${args.partyId}`);
    }

    return {
        success: true,
        partyId: args.partyId,
        message: 'Party deleted. Members are now unassigned.'
    };
}

async function handleAddMember(args: z.infer<typeof AddMemberSchema>): Promise<object> {
    const { partyRepo, charRepo } = ensureDb();

    const party = partyRepo.findById(args.partyId);
    if (!party) throw new Error(`Party not found: ${args.partyId}`);

    const character = charRepo.findById(args.characterId);
    if (!character) throw new Error(`Character not found: ${args.characterId}`);

    const existing = partyRepo.findMember(args.partyId, args.characterId);
    if (existing) throw new Error(`Character ${character.name} is already in party ${party.name}`);

    if (args.role === 'leader') {
        partyRepo.setLeader(args.partyId, args.characterId);
    }

    const now = new Date().toISOString();
    const member: PartyMember = {
        id: randomUUID(),
        partyId: args.partyId,
        characterId: args.characterId,
        role: args.role || 'member',
        isActive: false,
        position: args.position,
        sharePercentage: 100,
        joinedAt: now,
        notes: args.notes,
        ...(args.loyalty !== undefined ? { loyalty: args.loyalty } : {}),
        ...(args.wage !== undefined ? { wage: args.wage } : {}),
        ...(args.payMode !== undefined ? { payMode: args.payMode } : {}),
        ...(args.unitModels !== undefined ? { unitModels: args.unitModels } : {})
    };

    partyRepo.addMember(member);
    partyRepo.touchParty(args.partyId);

    return {
        success: true,
        member,
        characterName: character.name,
        partyName: party.name,
        message: `${character.name} joined ${party.name}!`
    };
}

async function handleRemoveMember(args: z.infer<typeof RemoveMemberSchema>): Promise<object> {
    const { partyRepo, charRepo } = ensureDb();
    const character = charRepo.findById(args.characterId);
    const removed = partyRepo.removeMember(args.partyId, args.characterId);

    if (!removed) throw new Error('Member not found in party');

    return {
        success: true,
        characterId: args.characterId,
        characterName: character?.name,
        message: 'Member removed from party.'
    };
}

async function handleUpdateMember(args: z.infer<typeof UpdateMemberSchema>): Promise<object> {
    const { partyRepo } = ensureDb();
    const { partyId, characterId, action: _action, ...updates } = args;

    const updated = partyRepo.updateMember(partyId, characterId, updates);
    if (!updated) throw new Error('Member not found in party');

    return {
        ...updated,
        success: true,
        message: 'Member updated successfully'
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Item 7: THE WARBAND — muster, pay, after_battle
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_LOYALTY = 5;
const loyaltyOf = (m: PartyMember) => m.loyalty ?? DEFAULT_LOYALTY;
const payModeOf = (m: PartyMember) => m.payMode ?? (m.wage != null && m.wage > 0 ? 'wage' : 'none');
const clampLoyalty = (n: number) => Math.min(10, Math.max(0, n));
/** A refusal thrown before any write: the router prints writes: 'none' when the Error carries it (FINDINGS #64). */
const refuse = (message: string): never => { const e = new Error(message) as Error & { writes?: string }; e.writes = 'none'; throw e; };

async function handleMuster(args: z.infer<typeof MusterSchema>): Promise<object> {
    const { db, partyRepo, charRepo } = ensureDb();
    const party = partyRepo.findById(args.partyId);
    if (!party) throw new Error(`Party not found: ${args.partyId}`);
    const upkeep = readUpkeep(db, party.id);
    const view = upkeep ? upkeepView(partyRepo, charRepo, party, upkeep) : undefined;
    const members = partyRepo.findMembersByParty(party.id).map(m => {
        const c = charRepo.findById(m.characterId);
        return {
            characterId: m.characterId, name: c?.name ?? m.characterId, role: m.role,
            hp: c ? `${c.hp}/${c.maxHp}` : undefined,
            loyalty: loyaltyOf(m), payMode: payModeOf(m),
            ...(m.wage != null ? { wage: m.wage } : {}),
            ...(m.unitModels != null ? { unitModels: m.unitModels } : {}),
            sharePercentage: m.sharePercentage,
            ...(loyaltyOf(m) === 0 ? { wavering: true } : {})
        };
    });
    const wagesDue = members.filter(m => m.payMode === 'wage').reduce((s, m) => s + (m.wage ?? 0), 0);
    const models = members.reduce((s, m) => s + (m.unitModels ?? 0), 0);
    return {
        success: true, actionType: 'muster', partyId: party.id, partyName: party.name,
        members, count: members.length, wagesDue, models,
        ...(view ? { upkeep: view } : {}),
        message: `${party.name} musters ${members.length} (${models} models in units); wages due ${wagesDue} gold${members.some(m => m.wavering) ? `; wavering: ${members.filter(m => m.wavering).map(m => m.name).join(', ')}` : ''}${view ? `; stores ${view.stores.current} mouth-days / ${view.mouths.total} mouths = ${view.daysLeft === null ? 'no one eats' : `${view.daysLeft} days`} (upkeep from Day ${view.lastDay})${view.starving ? '; STARVING' : ''}${view.stores.missing ? `; STORES POOL MISSING: ${view.stores.characterId} no longer carries '${view.stores.pool}'` : ''}` : ''}`
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Play report 3: UPKEEP — set_upkeep, upkeep, and the world-clock tick
// ═══════════════════════════════════════════════════════════════════════════

type PoolMap = Record<string, { current: number; max: number; label?: string; [k: string]: unknown }>;
type SheetWithPools = { id: string; name: string; resourcePools?: PoolMap };

/** A character's pool by reference, or null when the character or the pool is missing. */
function poolOf(charRepo: CharacterRepository, ref: PoolRef): { char: SheetWithPools; pool: PoolMap[string] } | null {
    const c = charRepo.findById(ref.characterId) as unknown as SheetWithPools | null;
    const pool = c?.resourcePools?.[ref.pool];
    return c && pool ? { char: c, pool } : null;
}

export interface UpkeepView {
    stores: { characterId: string; name?: string; pool: string; current: number; max: number; label?: string; missing?: boolean };
    mouths: MouthCount;
    daysLeft: number | null;
    lastDay: number;
    starving: boolean;
    starvation: PartyUpkeep['starvation'];
    countRoles?: UpkeepRole[];
}

/** Stores against today's mouths: what muster and set_upkeep show. */
function upkeepView(partyRepo: PartyRepository, charRepo: CharacterRepository, party: Party, upkeep: PartyUpkeep): UpkeepView {
    const members = partyRepo.findMembersByParty(party.id);
    const mouths = countMouths(members, upkeep, ref => poolOf(charRepo, ref)?.pool.current ?? null);
    const linked = poolOf(charRepo, upkeep.linkPool);
    const stores = linked?.pool.current ?? 0;
    return {
        stores: {
            characterId: upkeep.linkPool.characterId, ...(linked ? { name: linked.char.name } : {}), pool: upkeep.linkPool.pool,
            current: stores, max: linked?.pool.max ?? 0,
            ...(linked?.pool.label ? { label: linked.pool.label } : {}), ...(linked ? {} : { missing: true })
        },
        mouths, daysLeft: daysLeft(stores, mouths.total), lastDay: upkeep.lastDay,
        // Starving while the shortfall still runs: a refill (adjust_pool) ends
        // it on the spot, before the next tick clears starvedSince.
        starving: upkeep.starvedSince !== undefined && stores < mouths.total, starvation: upkeep.starvation,
        ...(upkeep.countRoles ? { countRoles: upkeep.countRoles } : {})
    };
}

const mouthBreakdown = (m: MouthCount) => `${m.members} from members${m.pools.map(p => `, ${p.mouths} from ${p.pool}`).join('')}${m.extra ? `, ${m.extra} extra` : ''}`;

export interface UpkeepTickLine {
    partyId: string;
    name: string;
    days: number;
    storesFrom: number;
    storesTo: number;
    mouths: number;
    starvedDays: number;
    loyalty: Array<{ characterId: string; name: string; from: number; to: number }>;
    loyaltyDelta?: number;
    error?: string;
}

/** 'The Host 200→146 (3d × 18) STARVING 1d, loyalty -1 ×3' — one segment per party for the advance message. */
export function upkeepLineText(l: UpkeepTickLine): string {
    if (l.error) return `${l.name}: ${l.error}`;
    return `${l.name} ${l.storesFrom}→${l.storesTo} (${l.days}d × ${l.mouths})${l.starvedDays ? ` STARVING ${l.starvedDays}d` : ''}${l.loyalty.length ? `, loyalty ${l.loyaltyDelta! > 0 ? '+' : ''}${l.loyaltyDelta} ×${l.loyalty.length}` : ''}`;
}

/**
 * Charge `days` whole days to a party: the linked pool moves through the
 * character row with a history entry (what adjust_pool writes, so get and
 * the status block show it), a starving day docks loyalty from everyone but
 * the leader and mounts, and the party's lastDay moves on. A missing stores
 * pool charges nothing and says so; the anchor stays put so a re-link picks
 * up where it stopped.
 */
function runPartyUpkeep(db: ReturnType<typeof getDb>, party: Party, upkeep: PartyUpkeep, days: number, reasonTail: string): UpkeepTickLine {
    const partyRepo = new PartyRepository(db);
    const charRepo = new CharacterRepository(db);
    const members = partyRepo.findMembersByParty(party.id);
    const mouths = countMouths(members, upkeep, ref => poolOf(charRepo, ref)?.pool.current ?? null);
    const linked = poolOf(charRepo, upkeep.linkPool);
    if (!linked) {
        return { partyId: party.id, name: party.name, days, storesFrom: 0, storesTo: 0, mouths: mouths.total, starvedDays: 0, loyalty: [], error: `${upkeep.linkPool.characterId} no longer carries pool '${upkeep.linkPool.pool}'; nothing charged. Re-link with party_manage set_upkeep {partyId, linkPool} or clear it` };
    }
    const tick = tickUpkeep(upkeep, linked.pool.current, mouths.total, days);
    if (tick.storesTo !== tick.storesFrom) {
        const pools: PoolMap = { ...(linked.char.resourcePools ?? {}) };
        const pool = { ...pools[upkeep.linkPool.pool], current: tick.storesTo };
        pushPoolHistory(pool, { from: tick.storesFrom, to: tick.storesTo, delta: tick.storesTo - tick.storesFrom, reason: `upkeep ${party.name}: ${days} day(s) × ${mouths.total} mouths${reasonTail}` });
        pools[upkeep.linkPool.pool] = pool;
        charRepo.update(linked.char.id, { resourcePools: pools } as Partial<import('../../schema/character.js').Character>);
    }
    const loyalty: UpkeepTickLine['loyalty'] = [];
    if (tick.loyaltyDelta !== 0) {
        for (const m of members) {
            if (!starvationTarget(m.role)) continue;
            const from = loyaltyOf(m);
            const to = clampLoyalty(from + tick.loyaltyDelta);
            partyRepo.updateMember(party.id, m.characterId, { loyalty: to });
            loyalty.push({ characterId: m.characterId, name: charRepo.findById(m.characterId)?.name ?? m.characterId, from, to });
        }
    }
    writeUpkeep(db, party.id, tick.upkeep);
    return {
        partyId: party.id, name: party.name, days, storesFrom: tick.storesFrom, storesTo: tick.storesTo, mouths: mouths.total, starvedDays: tick.starvedDays, loyalty,
        ...(tick.loyaltyDelta !== 0 ? { loyaltyDelta: tick.loyaltyDelta } : {})
    };
}

function partiesWithUpkeep(db: ReturnType<typeof getDb>, worldId: string): Array<{ id: string; upkeep: PartyUpkeep }> {
    try {
        const rows = db.prepare('SELECT id, upkeep FROM parties WHERE world_id = ? AND upkeep IS NOT NULL').all(worldId) as Array<{ id: string; upkeep: string }>;
        return rows.map(r => ({ id: r.id, upkeep: parseUpkeep(r.upkeep) })).filter((r): r is { id: string; upkeep: PartyUpkeep } => r.upkeep !== null);
    } catch { return []; /* upkeep column not present on this database */ }
}

/**
 * The world tick: advance calls it with the clock AFTER the move. Every party
 * of the world with upkeep is charged the whole days between its lastDay and
 * today, so travel and montage time eat stores because they go through
 * advance. Only the advance path calls it: a correction never lands here.
 */
export function tickWorldUpkeep(db: ReturnType<typeof getDb>, worldId: string, clockAt: number): UpkeepTickLine[] {
    const rows = partiesWithUpkeep(db, worldId);
    if (!rows.length) return [];
    const partyRepo = new PartyRepository(db);
    const today = Math.floor(clockAt + 1e-9);
    const lines: UpkeepTickLine[] = [];
    for (const row of rows) {
        const days = today - row.upkeep.lastDay;
        if (days < 1) continue;
        const party = partyRepo.findById(row.id);
        if (!party) continue;
        lines.push(runPartyUpkeep(db, party, row.upkeep, days, ''));
    }
    return lines;
}

/**
 * A clock correction says no time passed: the anchor moves with the clock and
 * nothing is charged, so the next advance charges only the days it crosses.
 * era_jump lands here too; without it a jump of years would starve the camp
 * on the first advance after it.
 */
export function reanchorWorldUpkeep(db: ReturnType<typeof getDb>, worldId: string, clockAt: number): Array<{ partyId: string; name: string; from: number; to: number }> {
    const rows = partiesWithUpkeep(db, worldId);
    if (!rows.length) return [];
    const partyRepo = new PartyRepository(db);
    const today = Math.floor(clockAt + 1e-9);
    const out: Array<{ partyId: string; name: string; from: number; to: number }> = [];
    for (const row of rows) {
        if (row.upkeep.lastDay === today) continue;
        writeUpkeep(db, row.id, { ...row.upkeep, lastDay: today });
        out.push({ partyId: row.id, name: partyRepo.findById(row.id)?.name ?? row.id, from: row.upkeep.lastDay, to: today });
    }
    return out;
}

async function handleSetUpkeep(args: z.infer<typeof SetUpkeepSchema>): Promise<object> {
    const { db, partyRepo, charRepo } = ensureDb();
    const refuse = (message: string) => ({ error: true, actionType: 'set_upkeep', message: `${message} Nothing was written.`, writes: 'none' });
    const party = partyRepo.findById(args.partyId);
    if (!party) return refuse(`Party not found: ${args.partyId}.`);
    ensureUpkeepColumn(db);
    const existing = readUpkeep(db, party.id);
    if (args.clear) {
        writeUpkeep(db, party.id, null);
        return {
            success: true, actionType: 'set_upkeep', partyId: party.id, partyName: party.name, cleared: true, ...(existing ? { was: existing } : {}),
            message: existing
                ? `${party.name} upkeep cleared: ${existing.linkPool.characterId}'s pool '${existing.linkPool.pool}' is unlinked and keeps its value; nothing is charged from here.`
                : `${party.name} had no upkeep; nothing to clear.`
        };
    }
    const worldId = args.worldId ?? party.worldId;
    if (!worldId) return refuse(`${party.name} has no world: pass worldId (it is written to the party, and that world's clock drives upkeep).`);
    const clock = readWorldClock(db, worldId);
    if (!clock) {
        const exists = db.prepare('SELECT 1 FROM worlds WHERE id = ?').get(worldId);
        return refuse(exists ? `set_upkeep reads the world clock and world ${worldId} has none: ${SET_CLOCK_HINT}.` : `World not found: ${worldId}.`);
    }
    const linkRef = args.linkPool ?? existing?.linkPool;
    if (!linkRef) return refuse("set_upkeep needs linkPool {characterId, pool}: stores live in a character's pool (mouth-days), never on the party. Create it with character_manage adjust_pool {characterId, pool: 'stores', value, max, label: 'Stores (mouth-days)'} and link it here.");
    const resolveRef = (ref: PoolRef, isStores: boolean): PoolRef | string => {
        const c = charRepo.findById(ref.characterId) as unknown as SheetWithPools | null;
        if (!c) return `Character not found: ${ref.characterId}.`;
        if (!c.resourcePools?.[ref.pool]) return `${c.name} does not carry a pool '${ref.pool}': create it first with character_manage adjust_pool {characterId: '${c.id}', pool: '${ref.pool}', value, max${isStores ? ", label: 'Stores (mouth-days)'" : ''}}.`;
        return { characterId: c.id, pool: ref.pool };
    };
    const link = resolveRef(linkRef, true);
    if (typeof link === 'string') return refuse(link);
    const mouthPools: PoolRef[] = [];
    for (const ref of args.mouthsFromPool ?? existing?.mouthsFromPool ?? []) {
        const r = resolveRef(ref, false);
        if (typeof r === 'string') return refuse(r);
        mouthPools.push(r);
    }
    const extra = args.extraMouths ?? existing?.extraMouths ?? 0;
    const roles = (args.countRoles ?? existing?.countRoles ?? []) as UpkeepRole[];
    const startDayGiven = args.startDay !== undefined;
    const upkeep: PartyUpkeep = {
        linkPool: link,
        ...(mouthPools.length ? { mouthsFromPool: mouthPools } : {}),
        ...(extra > 0 ? { extraMouths: extra } : {}),
        ...(roles.length ? { countRoles: roles } : {}),
        starvation: {
            loyaltyDelta: args.starvation?.loyaltyDelta ?? existing?.starvation.loyaltyDelta ?? DEFAULT_STARVATION.loyaltyDelta,
            perDay: args.starvation?.perDay ?? existing?.starvation.perDay ?? DEFAULT_STARVATION.perDay
        },
        lastDay: args.startDay ?? existing?.lastDay ?? Math.floor(clock.at + 1e-9),
        ...(!startDayGiven && existing?.starvedSince !== undefined ? { starvedSince: existing.starvedSince } : {})
    };
    // Every check passed: now the writes. A party without a world takes the one passed.
    if (args.worldId && party.worldId !== args.worldId) partyRepo.update(party.id, { worldId: args.worldId });
    writeUpkeep(db, party.id, upkeep);
    const view = upkeepView(partyRepo, charRepo, party, upkeep);
    const startText = startDayGiven || !existing
        ? `upkeep starts from Day ${upkeep.lastDay}; nothing before it is charged`
        : `upkeep continues from Day ${upkeep.lastDay} (pass startDay to move it)`;
    const s = upkeep.starvation;
    return {
        success: true, actionType: 'set_upkeep', partyId: party.id, partyName: party.name, worldId, clock: clockLabel(clock),
        replaced: !!existing, upkeep, stores: view.stores, mouths: view.mouths, daysLeft: view.daysLeft, startDay: upkeep.lastDay,
        unitsNote: UNITS_NOTE,
        message: `${party.name} upkeep ${existing ? 'updated' : 'set'}: ${storesLine(view.stores.current, view.mouths)} (${mouthBreakdown(view.mouths)}); ${startText}. `
            + `Every world_manage advance charges the whole days it crosses; a day the stores cannot cover is a starving day (stores to 0) and docks loyalty ${s.loyaltyDelta} ${s.perDay ? 'each starving day' : 'once per shortfall'} from everyone but the leader and mounts. `
            + 'Stores are mouth-days: a pool kept in other units must be converted before it is linked (see unitsNote).'
    };
}

async function handleUpkeep(args: z.infer<typeof UpkeepSchema>): Promise<object> {
    const { db, partyRepo } = ensureDb();
    const party = partyRepo.findById(args.partyId);
    if (!party) return { error: true, actionType: 'upkeep', message: `Party not found: ${args.partyId}. Nothing was written.`, writes: 'none' };
    const upkeep = readUpkeep(db, party.id);
    if (!upkeep) return { error: true, actionType: 'upkeep', message: `${party.name} has no upkeep: link a stores pool first with party_manage set_upkeep {partyId, linkPool: {characterId, pool}}. Nothing was written.`, writes: 'none' };
    const line = runPartyUpkeep(db, party, upkeep, args.days, ' (by hand)');
    if (line.error) return { error: true, actionType: 'upkeep', message: `${line.error}. Nothing was written.`, writes: 'none' };
    const lastDay = readUpkeep(db, party.id)?.lastDay ?? upkeep.lastDay + args.days;
    const left = daysLeft(line.storesTo, line.mouths);
    return {
        success: true, actionType: 'upkeep', ...line, lastDay, daysLeft: left,
        message: `${party.name} charged ${args.days} day(s) by hand: ${upkeepLineText(line)}; ${left === null ? 'no one eats' : `${left} days of stores left`}; the next world_manage advance charges from Day ${lastDay}.`
    };
}

async function handlePay(args: z.infer<typeof PaySchema>): Promise<object> {
    const { db, partyRepo, charRepo } = ensureDb();
    const party = partyRepo.findById(args.partyId);
    if (!party) throw new Error(`Party not found: ${args.partyId}`);
    const members = partyRepo.findMembersByParty(party.id);
    const payerId = args.payerId ? (charRepo.findById(args.payerId)?.id ?? null) : (members.find(m => m.role === 'leader')?.characterId ?? null);
    if (!payerId) throw new Error(args.payerId ? `Payer not found: ${args.payerId}. Nothing was paid.` : `${party.name} has no leader to pay from: pass payerId. Nothing was paid.`);
    const inv = new InventoryRepository(db);
    const paid: Array<Record<string, unknown>> = [];
    const unpaid: Array<Record<string, unknown>> = [];
    let budget = args.amount ?? Infinity;
    const payees = members.filter(m => m.characterId !== payerId);
    const settle = (m: PartyMember, gold: number, as: 'wage' | 'share') => {
        const name = charRepo.findById(m.characterId)?.name ?? m.characterId;
        const ok = gold > 0 && gold <= budget && inv.transferCurrency(payerId, m.characterId, { gold });
        const loyalty = clampLoyalty(loyaltyOf(m) + (ok ? 1 : -1));
        partyRepo.updateMember(party.id, m.characterId, { loyalty });
        if (ok) { budget -= gold; paid.push({ characterId: m.characterId, name, gold, as, loyalty }); }
        else unpaid.push({ characterId: m.characterId, name, owed: gold, as, loyalty });
    };
    const pay = db.transaction(() => {
        for (const m of payees.filter(p => payModeOf(p) === 'wage')) settle(m, m.wage ?? 0, 'wage');
        if (args.amount !== undefined) {
            const sharers = payees.filter(p => payModeOf(p) === 'share');
            const weight = sharers.reduce((s, p) => s + p.sharePercentage, 0);
            const pot = Math.max(0, budget);
            for (const m of sharers) settle(m, weight > 0 ? Math.floor(pot * m.sharePercentage / weight) : 0, 'share');
        }
    });
    pay();
    const purse = inv.getCurrency(payerId).gold;
    return {
        success: true, actionType: 'pay', partyId: party.id, payerId, paid, unpaid,
        ...(args.amount === undefined ? { sharesSkipped: 'no amount given: wages only' } : {}),
        payerGoldLeft: purse,
        message: `${party.name} paid: ${paid.map(p => `${String(p.name)} ${String(p.gold)}g (${String(p.as)})`).join(', ') || 'nobody'}${unpaid.length ? `; UNPAID: ${unpaid.map(u => String(u.name)).join(', ')} (loyalty -1)` : ''}. Payer has ${purse} gold left.`
    };
}

async function handleAfterBattle(args: z.infer<typeof AfterBattleSchema>): Promise<object> {
    const { partyRepo, charRepo } = ensureDb();
    const party = partyRepo.findById(args.partyId);
    if (!party) throw new Error(`Party not found: ${args.partyId}`);
    // Validate everything before any write.
    const casualties = (args.casualties ?? []).map(c => ({ c, m: partyRepo.findMember(party.id, c.characterId) }));
    const strangers = casualties.filter(x => !x.m).map(x => x.c.characterId);
    if (strangers.length) refuse(`Not in ${party.name}: ${strangers.join(', ')}. Nothing was written.`);
    for (const r of args.recruits ?? []) {
        if (!charRepo.findById(r.characterId)) refuse(`Recruit not found: ${r.characterId}. Nothing was written.`);
        if (partyRepo.findMember(party.id, r.characterId)) refuse(`Recruit ${r.characterId} is already in ${party.name}. Nothing was written.`);
    }
    const whoFought = resolveWhoFought(party, args.participants, args.encounterId, casualties.map(x => x.m!.characterId));

    const killed: Array<Record<string, unknown>> = [];
    const losses: Array<Record<string, unknown>> = [];
    const dead = new Set<string>();
    for (const { c, m } of casualties) {
        const member = m!;
        const name = charRepo.findById(member.characterId)?.name ?? member.characterId;
        let left = member.unitModels ?? null;
        if (c.models && left !== null) {
            left = Math.max(0, left - c.models);
            partyRepo.updateMember(party.id, member.characterId, { unitModels: left });
            losses.push({ characterId: member.characterId, name, models: c.models, unitModels: left });
        }
        if (c.dead || left === 0) {
            const k = await handleKill({ action: 'kill', characterId: member.characterId, cause: `fell in battle with ${party.name}` }) as Record<string, unknown>;
            partyRepo.removeMember(party.id, member.characterId);
            dead.add(member.characterId);
            killed.push({ characterId: member.characterId, name, ...(k.corpseId ? { corpseId: k.corpseId } : {}), ...(k.error ? { killError: k.message } : {}) });
        }
    }
    const step = args.victory ? 1 : -1;
    const loyalty: Array<Record<string, unknown>> = [];
    // Who fought: the survivors in the set move; the rest are absent, untouched.
    const fought: Array<{ characterId: string; name: string }> = [];
    const absent: Array<{ characterId: string; name: string; loyalty: number }> = [];
    for (const m of partyRepo.findMembersByParty(party.id)) {
        if (dead.has(m.characterId)) continue;
        const name = charRepo.findById(m.characterId)?.name ?? m.characterId;
        if (!whoFought.inFight(m.characterId)) { absent.push({ characterId: m.characterId, name, loyalty: loyaltyOf(m) }); continue; }
        fought.push({ characterId: m.characterId, name });
        const to = clampLoyalty(loyaltyOf(m) + step);
        partyRepo.updateMember(party.id, m.characterId, { loyalty: to });
        loyalty.push({ characterId: m.characterId, from: loyaltyOf(m), to, ...(to === 0 ? { wavering: true } : {}) });
    }
    // Growth tracks: a victory feeds each surviving member's growth pool.
    // Recruits joining now were not in the fight; nor were the absent.
    const growth: Array<Record<string, unknown>> = [];
    if (args.victory) {
        const db = getDb();
        for (const m of partyRepo.findMembersByParty(party.id)) {
            if (dead.has(m.characterId) || !whoFought.inFight(m.characterId)) continue;
            try {
                const credit = await creditGrowth(db, resolveWorldId(db, { characterIds: [m.characterId] }), m.characterId, 'victory');
                if (credit) growth.push({ characterId: m.characterId, name: charRepo.findById(m.characterId)?.name ?? m.characterId, ...credit });
            } catch { /* no rules table: no growth */ }
        }
    }
    const recruited: Array<Record<string, unknown>> = [];
    const now = new Date().toISOString();
    for (const r of args.recruits ?? []) {
        const c = charRepo.findById(r.characterId)!;
        partyRepo.addMember({
            id: randomUUID(), partyId: party.id, characterId: c.id, role: r.role ?? 'member', isActive: false,
            sharePercentage: 100, joinedAt: now,
            ...(r.loyalty !== undefined ? { loyalty: r.loyalty } : {}),
            ...(r.wage !== undefined ? { wage: r.wage } : {}),
            ...(r.payMode !== undefined ? { payMode: r.payMode } : {}),
            ...(r.unitModels !== undefined ? { unitModels: r.unitModels } : {})
        });
        recruited.push({ characterId: c.id, name: c.name, role: r.role ?? 'member' });
    }
    partyRepo.touchParty(party.id);
    const allNote = 'every member counted as in the fight: pass participants (ids or names) or encounterId to name who fought';
    const whoLine = whoFought.source === 'all'
        ? `survivors loyalty ${step > 0 ? '+1' : '-1'} (${allNote})`
        : `${fought.length} fought (${fought.map(f => f.name).join(', ') || 'nobody left standing'}): loyalty ${step > 0 ? '+1' : '-1'}${absent.length ? `; absent, untouched: ${absent.map(a => a.name).join(', ')}` : ''}`;
    return {
        success: true, actionType: 'after_battle', partyId: party.id, victory: args.victory,
        losses, killed, loyalty, recruited,
        participantSource: whoFought.source, participants: fought, absent,
        ...(whoFought.encounterIds ? { encounterIds: whoFought.encounterIds } : {}),
        ...(whoFought.source === 'all' ? { note: allNote } : {}),
        ...(growth.length ? { growth } : {}),
        message: `${party.name} after ${args.victory ? 'victory' : 'defeat'}: ${killed.length} dead${killed.length ? ` (${killed.map(k => String(k.name)).join(', ')})` : ''}, ${losses.reduce((s, l) => s + Number(l.models), 0)} models lost; ${whoLine}${recruited.length ? `; ${recruited.length} recruited` : ''}${loyalty.some(l => l.wavering) ? '; some are wavering (loyalty 0)' : ''}${growth.length ? `; growth: ${growth.map(g => `${String(g.name)} ${String(g.from)} → ${String(g.to)}${g.growthReady ? ` (ready for ${String((g.growthReady as { form: string }).form)})` : ''}`).join(', ')}` : ''}.`
    };
}

/**
 * Play report 3: who fought. Explicit participants (member ids, short ids
 * included, or names, case-insensitive) first; then every member whose
 * character id was a token in a listed encounter or one of its boarding
 * children (tokens stay in encounters.tokens after end; a token's short id
 * resolves through charRepo.findById); casualties always count. A prisoner
 * never counts from an encounter: a captive who was an enemy token and is
 * held before the aftermath is booked did not fight for the party (name a
 * thrall who did in participants). With neither, everyone counts, as
 * before. Refusals here happen before any write: an unknown or ambiguous
 * participant, a missing encounter, or an encounter no member fought in.
 */
type WhoFought = { source: 'participants' | 'encounters' | 'all'; inFight: (characterId: string) => boolean; encounterIds?: string[] };
function resolveWhoFought(party: Party, participants: string[] | undefined, encounterId: string | string[] | undefined, casualtyIds: string[]): WhoFought {
    const { partyRepo, charRepo } = ensureDb();
    const named = participants ?? [];
    const encounterIds = encounterId === undefined ? [] : Array.isArray(encounterId) ? encounterId : [encounterId];
    if (!named.length && !encounterIds.length) return { source: 'all', inFight: () => true };

    const members = partyRepo.findMembersByParty(party.id);
    const roster = members.map(m => ({ characterId: m.characterId, name: charRepo.findById(m.characterId)?.name ?? m.characterId, role: m.role }));
    // Prisoners never fought for the party by way of a token (see above).
    const fighterIds = new Set(roster.filter(r => r.role !== 'prisoner').map(r => r.characterId));
    const fought = new Set<string>(casualtyIds);

    for (const raw of named) {
        const needle = raw.trim();
        // An exact id, then an exact name (case-insensitive), then a unique id
        // prefix of 6+ chars via the repo. The name comes before the prefix so
        // "Warlord" is the member of that name, not whoever's id starts warlord-.
        const exact = roster.find(r => r.characterId === needle);
        if (exact) { fought.add(exact.characterId); continue; }
        const byName = roster.filter(r => r.name.toLowerCase() === needle.toLowerCase());
        if (byName.length === 1) { fought.add(byName[0].characterId); continue; }
        if (byName.length > 1) refuse(`"${raw}" names ${byName.length} members of ${party.name}: ${byName.map(r => `${r.name} (${r.characterId})`).join(', ')}. Pass the character id. Nothing was written.`);
        const byPrefix = partyRepo.findMember(party.id, needle);
        if (byPrefix) { fought.add(byPrefix.characterId); continue; }
        refuse(`Not in ${party.name}: ${raw} (no member has that id or name). Nothing was written.`);
    }

    if (encounterIds.length) {
        const encRepo = new EncounterRepository(getDb());
        const tokenIdsOf = (row: { tokens: string } | undefined): string[] => {
            if (!row) return [];
            try { return (JSON.parse(row.tokens) as Array<{ id: string }>).map(t => t.id); } catch { return []; }
        };
        for (const eid of encounterIds) {
            const row = encRepo.findById(eid);
            if (!row) refuse(`Encounter not found: ${eid}. Nothing was written.`);
            const tokenIds = [...tokenIdsOf(row), ...encRepo.childrenOf(eid).flatMap(c => tokenIdsOf(encRepo.findById(c.id)))];
            let hits = 0;
            for (const tid of tokenIds) {
                const row = charRepo.findById(tid);
                if (row && fighterIds.has(row.id)) { fought.add(row.id); hits++; }
            }
            if (!hits) refuse(`No member of ${party.name} fought in encounter ${eid} (no token there, nor in its boardings, is a member's character; a prisoner's token does not count). Drop it, or name who fought in participants. Nothing was written.`);
        }
    }
    return {
        source: named.length ? 'participants' : 'encounters',
        inFight: id => fought.has(id),
        ...(encounterIds.length ? { encounterIds } : {})
    };
}

async function handleSetLeader(args: z.infer<typeof SetLeaderSchema>): Promise<object> {
    const { partyRepo, charRepo } = ensureDb();

    const member = partyRepo.findMember(args.partyId, args.characterId);
    if (!member) throw new Error('Character is not a member of this party');

    const character = charRepo.findById(args.characterId);
    partyRepo.setLeader(args.partyId, args.characterId);
    partyRepo.touchParty(args.partyId);

    return {
        success: true,
        newLeaderId: args.characterId,
        newLeaderName: character?.name,
        message: `${character?.name} is now the party leader!`
    };
}

async function handleSetActive(args: z.infer<typeof SetActiveSchema>): Promise<object> {
    const { partyRepo, charRepo } = ensureDb();

    const member = partyRepo.findMember(args.partyId, args.characterId);
    if (!member) throw new Error('Character is not a member of this party');

    const character = charRepo.findById(args.characterId);
    partyRepo.setActiveCharacter(args.partyId, args.characterId);
    partyRepo.touchParty(args.partyId);

    return {
        success: true,
        activeCharacterId: args.characterId,
        activeCharacterName: character?.name,
        message: `${character?.name} is now the active character!`
    };
}

async function handleGetMembers(args: z.infer<typeof GetMembersSchema>): Promise<object> {
    const { partyRepo } = ensureDb();
    const party = partyRepo.getPartyWithMembers(args.partyId);

    if (!party) throw new Error(`Party not found: ${args.partyId}`);

    return {
        partyId: party.id,
        partyName: party.name,
        members: party.members,
        memberCount: party.memberCount,
        leader: party.leader,
        activeCharacter: party.activeCharacter
    };
}

async function handleGetContext(args: z.infer<typeof GetContextSchema>): Promise<object> {
    const { partyRepo, questRepo } = ensureDb();
    const party = partyRepo.getPartyWithMembers(args.partyId);

    if (!party) throw new Error(`Party not found: ${args.partyId}`);

    const context: PartyContext = {
        party: {
            id: party.id,
            name: party.name,
            status: party.status,
            location: party.currentLocation,
            formation: party.formation
        },
        members: party.members.map((m: { character: { name: string; hp: number; maxHp: number }; role: 'leader' | 'member' | 'companion' | 'hireling' | 'prisoner' | 'mount' }) => ({
            name: m.character.name,
            role: m.role,
            hp: `${m.character.hp}/${m.character.maxHp}`,
            status: m.character.hp < m.character.maxHp * 0.25 ? 'critical' :
                m.character.hp < m.character.maxHp * 0.5 ? 'wounded' :
                    m.character.hp < m.character.maxHp ? 'hurt' : 'healthy'
        }))
    };

    if (party.leader) {
        context.leader = {
            id: party.leader.character.id,
            name: party.leader.character.name,
            hp: party.leader.character.hp,
            maxHp: party.leader.character.maxHp,
            level: party.leader.character.level
        };
    }

    if (party.activeCharacter) {
        context.activeCharacter = {
            id: party.activeCharacter.character.id,
            name: party.activeCharacter.character.name,
            hp: party.activeCharacter.character.hp,
            maxHp: party.activeCharacter.character.maxHp,
            level: party.activeCharacter.character.level,
            conditions: party.activeCharacter.character.hp < party.activeCharacter.character.maxHp * 0.5
                ? ['wounded'] : undefined
        };
    }

    if (party.currentQuestId) {
        try {
            const quest = questRepo.findById(party.currentQuestId);
            if (quest) {
                const completedCount = quest.objectives.filter((o: { completed: boolean }) => o.completed).length;
                context.activeQuest = {
                    name: quest.name,
                    currentObjective: quest.objectives.find((o: { completed: boolean; description?: string }) => !o.completed)?.description,
                    progress: `${Math.round((completedCount / quest.objectives.length) * 100)}%`
                };
            }
        } catch {
            // Quest not found, skip
        }
    }

    partyRepo.touchParty(args.partyId);

    return {
        ...context,
        verbosity: args.verbosity
    };
}

async function handleGetUnassigned(args: z.infer<typeof GetUnassignedSchema>): Promise<object> {
    const { partyRepo } = ensureDb();
    const excludeTypes = args.excludeEnemies ? ['enemy'] : undefined;
    const characters = partyRepo.getUnassignedCharacters(excludeTypes);

    return {
        characters,
        count: characters.length,
        filter: { excludeEnemies: args.excludeEnemies }
    };
}

async function handleMove(args: z.infer<typeof MoveSchema>): Promise<object> {
    const { partyRepo } = ensureDb();

    const party = partyRepo.findById(args.partyId);
    if (!party) throw new Error(`Party not found: ${args.partyId}`);

    const updatedParty = partyRepo.updatePartyPosition(
        args.partyId,
        args.targetX,
        args.targetY,
        args.locationName,
        args.poiId
    );

    if (!updatedParty) throw new Error(`Failed to update party position: ${args.partyId}`);

    return {
        success: true,
        party: updatedParty,
        newPosition: {
            x: args.targetX,
            y: args.targetY,
            location: args.locationName,
            poiId: args.poiId || null
        },
        message: `Party "${updatedParty.name}" moved to ${args.locationName} (${args.targetX}, ${args.targetY})`
    };
}

async function handleGetPosition(args: z.infer<typeof GetPositionSchema>): Promise<object> {
    const { partyRepo } = ensureDb();

    const party = partyRepo.findById(args.partyId);
    if (!party) throw new Error(`Party not found: ${args.partyId}`);

    const position = partyRepo.getPartyPosition(args.partyId);

    return {
        partyId: party.id,
        partyName: party.name,
        position: position || { x: null, y: null, locationName: 'Unknown', poiId: null }
    };
}

async function handleGetInRegion(args: z.infer<typeof GetInRegionSchema>): Promise<object> {
    const { partyRepo } = ensureDb();

    const parties = partyRepo.getPartiesNearPosition(
        args.worldId,
        args.x,
        args.y,
        args.radiusSquares
    );

    return {
        parties,
        count: parties.length,
        searchArea: { x: args.x, y: args.y, radius: args.radiusSquares },
        message: `Found ${parties.length} parties within ${args.radiusSquares} squares of (${args.x}, ${args.y})`
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<PartyAction, ActionDefinition> = {
    create: {
        schema: CreateSchema,
        handler: handleCreate,
        aliases: ['new', 'add', 'form'],
        description: 'Create a new party'
    },
    get: {
        schema: GetSchema,
        handler: handleGet,
        aliases: ['fetch', 'find', 'retrieve'],
        description: 'Get party by ID'
    },
    list: {
        schema: ListSchema,
        handler: handleList,
        aliases: ['all', 'query', 'search'],
        description: 'List all parties'
    },
    update: {
        schema: UpdateSchema,
        handler: handleUpdate,
        aliases: ['modify', 'edit', 'set'],
        description: 'Update party properties'
    },
    delete: {
        schema: DeleteSchema,
        handler: handleDelete,
        aliases: ['remove', 'disband', 'destroy'],
        description: 'Delete/disband a party'
    },
    add_member: {
        schema: AddMemberSchema,
        handler: handleAddMember,
        aliases: ['join', 'recruit', 'add_char'],
        description: 'Add a character to the party'
    },
    remove_member: {
        schema: RemoveMemberSchema,
        handler: handleRemoveMember,
        aliases: ['kick', 'leave', 'remove_char'],
        description: 'Remove a character from the party'
    },
    update_member: {
        schema: UpdateMemberSchema,
        handler: handleUpdateMember,
        aliases: ['modify_member', 'set_role'],
        description: 'Update a member\'s role/position'
    },
    set_leader: {
        schema: SetLeaderSchema,
        handler: handleSetLeader,
        aliases: ['leader', 'promote'],
        description: 'Set the party leader'
    },
    set_active: {
        schema: SetActiveSchema,
        handler: handleSetActive,
        aliases: ['active', 'pov', 'focus'],
        description: 'Set active character (player POV)'
    },
    get_members: {
        schema: GetMembersSchema,
        handler: handleGetMembers,
        aliases: ['members', 'roster'],
        description: 'Get all party members'
    },
    get_context: {
        schema: GetContextSchema,
        handler: handleGetContext,
        aliases: ['context', 'summary', 'status'],
        description: 'Get party context for LLM'
    },
    get_unassigned: {
        schema: GetUnassignedSchema,
        handler: handleGetUnassigned,
        aliases: ['unassigned', 'available', 'free'],
        description: 'Get characters not in any party'
    },
    move: {
        schema: MoveSchema,
        handler: handleMove,
        aliases: ['travel', 'goto', 'relocate'],
        description: 'Move party to location'
    },
    get_position: {
        schema: GetPositionSchema,
        handler: handleGetPosition,
        aliases: ['position', 'location', 'where'],
        description: 'Get party position'
    },
    get_in_region: {
        schema: GetInRegionSchema,
        handler: handleGetInRegion,
        aliases: ['nearby', 'in_area', 'find_parties'],
        description: 'Get parties in a region'
    },
    muster: {
        schema: MusterSchema,
        handler: handleMuster,
        aliases: ['warband', 'rollcall'],
        description: 'Item 7: the roster with loyalty (unset reads 5), pay mode, wage and unit models; wages due'
    },
    pay: {
        schema: PaySchema,
        handler: handlePay,
        aliases: ['pay_wages', 'payday', 'wages'],
        description: 'Pay wages first, then (with amount) shares by sharePercentage, from payerId or the leader; paid +1 loyalty, unpaid -1'
    },
    after_battle: {
        schema: AfterBattleSchema,
        handler: handleAfterBattle,
        aliases: ['battle_aftermath', 'aftermath', 'casualties'],
        description: 'Book casualties (models lost; the dead or a unit at 0 models are killed and struck off); those who fought (participants by id or name, and/or the tokens of encounterId and its boardings; else everyone) ±1 loyalty and victory growth, the rest absent and untouched; recruits join'
    },
    set_upkeep: {
        schema: SetUpkeepSchema,
        handler: handleSetUpkeep,
        aliases: ['stores', 'link_stores', 'rations'],
        description: "Link the party's stores (mouth-days) to ONE character pool and say who eats: members by unitModels, mouth pools read live (captives), extra mouths; starts charging from today (startDay overrides); clear unlinks"
    },
    upkeep: {
        schema: UpkeepSchema,
        handler: handleUpkeep,
        aliases: ['tick_upkeep', 'eat', 'feed'],
        description: 'Charge whole days of upkeep by hand (world_manage advance does it by the clock): stores drop by mouths a day, a shortfall is a starving day that docks loyalty from everyone but the leader and mounts'
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

export const PartyManageTool = {
    name: 'party_manage',
    description: `Manage adventuring parties and members.

👥 PARTY LIFECYCLE:
1. Create characters with character_manage first
2. create - Form a new party (can include initialMembers)
3. add_member - Add characters to existing party

⚔️ WORKFLOW:
- set_leader: Designate party leader for social interactions
- set_active: Switch POV character for narrative focus
- get_context: AI-friendly party summary for story generation

🗺️ TRAVEL:
- move: Relocate party on world map (requires worldId)
- get_position: Query current party location
- get_in_region: Find nearby parties

⚔️ WARBAND:
- add_member / update_member take loyalty (0-10, unset reads 5), wage, payMode (wage | share | none) and unitModels
- muster: roster with loyalty, pay and models
- pay {partyId, payerId?, amount?}: wages first, then shares; paid +1 loyalty, unpaid -1
- after_battle {partyId, victory, casualties?: [{characterId, models?, dead?}], recruits?, participants?: [id | name], encounterId?: id | [id]}: the dead are killed and struck off; only those who fought move ±1 loyalty (and take victory growth) — name them in participants (ids or names, case-insensitive; ambiguous or unknown is refused) and/or pass the fight's encounterId (its tokens and boarding children count; a raid run as several fights takes a list); casualties always count; with neither, every member counts and the reply says so. Reply: participantSource ('participants' | 'encounters' | 'all'), participants, absent (untouched, with loyalty). A prisoner never counts from an encounterId (nor does a captive who was an enemy token); a member removed mid-fight with remove_participant reads as absent — name either in participants if they fought. Recruits join after and are not moved

🍞 UPKEEP (stores are MOUTH-DAYS; one mouth eats 1 a day, a unit eats its unitModels):
- set_upkeep {partyId, linkPool: {characterId, pool}, mouthsFromPool?: [{characterId, pool}], extraMouths?, countRoles?, starvation?: {loyaltyDelta: -1, perDay: true}, startDay?, clear?, worldId?}: stores live in ONE linked character pool (never on the party; adjust it with character_manage adjust_pool); mouth pools (captives) are read live each day; needs the world clock; starts charging from today and says so; reply prints stores against mouths as days left — convert a pool kept in other units BEFORE linking it
- world_manage advance charges every whole day it crosses (reply upkeep[]), as do spatial_manage traverse {advanceClock} and improvisation_manage montage {hours} (reply clock.upkeep / timePassed.upkeep); a day the stores cannot cover is a starving day (stores to 0) that docks loyalty from everyone but the leader and mounts; a clock correction charges nothing
- upkeep {partyId, days}: charge days by hand; muster shows stores, mouths (breakdown) and daysLeft

Actions: create, get, list, update, delete, add_member, remove_member, update_member, set_leader, set_active, get_members, get_context, get_unassigned, move, get_position, get_in_region, muster, pay, after_battle, set_upkeep, upkeep
Aliases: new/form->create, join/recruit->add_member, leader->set_leader, active/pov->set_active, roster->get_members, travel/goto->move, stores/rations->set_upkeep, eat/feed->upkeep`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe('Action to perform'),
        // Party identifiers
        partyId: z.string().optional(),
        // Create/Update fields
        name: z.string().optional(),
        description: z.string().optional(),
        worldId: z.string().optional(),
        initialMembers: z.array(InitialMemberSchema).optional(),
        currentLocation: z.string().optional(),
        formation: z.string().optional(),
        status: PartyStatusSchema.optional(),
        // Member fields
        characterId: z.string().optional(),
        role: memberRoleSchema().optional(),
        position: z.number().int().optional(),
        sharePercentage: z.number().int().optional(),
        notes: z.string().optional(),
        // Context fields
        verbosity: z.enum(['minimal', 'standard', 'detailed']).optional(),
        excludeEnemies: z.boolean().optional(),
        // Position/Movement fields
        targetX: z.number().int().optional(),
        targetY: z.number().int().optional(),
        locationName: z.string().optional(),
        poiId: z.string().optional(),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        radiusSquares: z.number().int().optional(),
        // Item 7 (mirror law): warband fields
        loyalty: loyaltySchema().optional(),
        wage: wageSchema().optional(),
        payMode: payModeSchema().optional(),
        unitModels: unitModelsSchema().optional(),
        payerId: z.string().optional().describe('pay: whose purse pays (default: the leader)'),
        amount: z.number().min(0).optional().describe('pay: gold to pay out in all; wages first, the rest as shares'),
        victory: z.boolean().optional().describe('after_battle: won (+1 loyalty) or lost (-1)'),
        casualties: z.array(casualtySchema()).optional().describe('after_battle: [{characterId, models?, dead?}]'),
        recruits: z.array(recruitSchema()).optional().describe('after_battle: [{characterId, role?, loyalty?, wage?, payMode?, unitModels?}]'),
        participants: participantsSchema().optional(),
        encounterId: encounterIdSchema().optional(),
        // Play report 3 (mirror law): upkeep fields
        linkPool: linkPoolSchema().optional(),
        mouthsFromPool: z.array(mouthPoolSchema()).optional().describe('set_upkeep: pools whose current value is mouths to feed, read live'),
        extraMouths: z.number().int().min(0).optional().describe('set_upkeep: mouths on no sheet'),
        countRoles: z.array(memberRoleSchema()).optional().describe('set_upkeep: member roles that eat (default all)'),
        starvation: starvationSchema().optional(),
        startDay: z.number().int().optional().describe('set_upkeep: charge from this day instead of today'),
        clear: z.boolean().optional().describe('set_upkeep: unlink the stores pool'),
        days: z.number().int().min(1).optional().describe('upkeep: whole days to charge by hand')
    })
};

export async function handlePartyManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    const response = await router(args as Record<string, unknown>);

    // Wrap response with ASCII formatting
    try {
        const data = JSON.parse(response.content[0].text);
        const action = String((args as Record<string, unknown>).action || '').toLowerCase();
        let output = '';

        if (data.error) {
            output = RichFormatter.header('Party Error', '❌');
            output += RichFormatter.alert(data.message || 'Unknown error', 'error');
            if (data.validActions) {
                output += RichFormatter.section('Valid Actions');
                output += RichFormatter.list(data.validActions);
            }
        } else if (action === 'create' || action === 'new' || action === 'form') {
            output = RichFormatter.header(`Party Formed: ${data.party?.name || 'Unknown'}`, '👥');
            output += RichFormatter.keyValue({
                'ID': data.party?.id,
                'Status': data.party?.status || 'active',
                'Members': data.memberCount || 0,
                'Leader': data.leaderId || 'None'
            });
            if (data.members?.length) {
                output += RichFormatter.section('Initial Members');
                const rows = data.members.map((m: { name: string; role: string }) => [m.name, m.role]);
                output += RichFormatter.table(['Name', 'Role'], rows);
            }
        } else if (action === 'get' || action === 'fetch' || action === 'find') {
            output = RichFormatter.header(`${data.name}`, '👥');
            output += RichFormatter.keyValue({
                'ID': data.id,
                'Status': data.status || 'active',
                'Formation': data.formation || 'standard',
                'Location': data.currentLocation || 'Unknown',
                'Members': data.memberCount || 0
            });
            if (data.members?.length) {
                output += RichFormatter.section('Party Members');
                const rows = data.members.map((m: { character?: { name: string }; characterId: string; role: string; isActive: boolean }) => [
                    m.character?.name || m.characterId,
                    m.role,
                    m.isActive ? '★' : ''
                ]);
                output += RichFormatter.table(['Name', 'Role', 'Active'], rows);
            }
        } else if (action === 'list' || action === 'all' || action === 'query') {
            output = RichFormatter.header(`Parties (${data.count})`, '👥');
            if (data.filter?.status) {
                output += `*Filtered by: ${data.filter.status}*\n\n`;
            }
            if (data.parties?.length) {
                const rows = data.parties.map((p: { name: string; status?: string; memberCount?: number; currentLocation?: string }) => [
                    p.name,
                    p.status || 'active',
                    p.memberCount || 0,
                    p.currentLocation || 'Unknown'
                ]);
                output += RichFormatter.table(['Name', 'Status', 'Members', 'Location'], rows);
            } else {
                output += '*No parties found*\n';
            }
        } else if (action === 'update' || action === 'modify' || action === 'edit') {
            output = RichFormatter.header(`Party Updated: ${data.name}`, '✏️');
            output += data.message + '\n';
        } else if (action === 'delete' || action === 'disband' || action === 'remove') {
            output = RichFormatter.header('Party Disbanded', '🗑️');
            output += `ID: ${data.partyId}\n`;
            output += data.message + '\n';
        } else if (action === 'add_member' || action === 'join' || action === 'recruit') {
            output = RichFormatter.header('Member Joined', '➕');
            output += RichFormatter.keyValue({
                'Character': data.characterName,
                'Party': data.partyName,
                'Role': data.member?.role || 'member'
            });
        } else if (action === 'remove_member' || action === 'kick' || action === 'leave') {
            output = RichFormatter.header('Member Removed', '➖');
            output += `${data.characterName || data.characterId} has left the party.\n`;
        } else if (action === 'update_member' || action === 'modify_member') {
            output = RichFormatter.header('Member Updated', '✏️');
            output += data.message + '\n';
        } else if (action === 'set_leader' || action === 'leader' || action === 'promote') {
            output = RichFormatter.header('New Leader', '👑');
            output += `${data.newLeaderName} is now leading the party!\n`;
        } else if (action === 'set_active' || action === 'active' || action === 'pov') {
            output = RichFormatter.header('Active Character', '⭐');
            output += `POV switched to ${data.activeCharacterName}.\n`;
        } else if (action === 'get_members' || action === 'members' || action === 'roster') {
            output = RichFormatter.header(`${data.partyName} Roster`, '📋');
            output += RichFormatter.keyValue({
                'Leader': data.leader?.character?.name || 'None',
                'Active': data.activeCharacter?.character?.name || 'None',
                'Members': data.memberCount || 0
            });
            if (data.members?.length) {
                output += RichFormatter.section('Members');
                const rows = data.members.map((m: { character?: { name: string; hp?: string; maxHp?: string }; characterId: string; role: string; isActive: boolean }) => [
                    m.character?.name || m.characterId,
                    m.role,
                    `${m.character?.hp || '?'}/${m.character?.maxHp || '?'}`,
                    m.isActive ? '★' : ''
                ]);
                output += RichFormatter.table(['Name', 'Role', 'HP', 'Active'], rows);
            }
        } else if (action === 'get_context' || action === 'context' || action === 'summary' || action === 'status') {
            output = RichFormatter.header(`${data.party?.name || 'Party'} Context`, '📊');
            if (data.party) {
                output += RichFormatter.keyValue({
                    'Status': data.party.status,
                    'Formation': data.party.formation,
                    'Location': data.party.location || 'Unknown'
                });
            }
            if (data.leader) {
                output += RichFormatter.section('Leader');
                output += `${data.leader.name} (Lv${data.leader.level}) - ${data.leader.hp}/${data.leader.maxHp} HP\n`;
            }
            if (data.activeCharacter) {
                output += RichFormatter.section('Active Character');
                output += `${data.activeCharacter.name} (Lv${data.activeCharacter.level}) - ${data.activeCharacter.hp}/${data.activeCharacter.maxHp} HP\n`;
            }
            if (data.members?.length) {
                output += RichFormatter.section('Party Status');
                const rows = data.members.map((m: { name: string; role: string; hp: string; status: string }) => [m.name, m.role, m.hp, m.status]);
                output += RichFormatter.table(['Name', 'Role', 'HP', 'Status'], rows);
            }
            if (data.activeQuest) {
                output += RichFormatter.section('Active Quest');
                output += `${data.activeQuest.name} (${data.activeQuest.progress})\n`;
                if (data.activeQuest.currentObjective) {
                    output += `*Current: ${data.activeQuest.currentObjective}*\n`;
                }
            }
        } else if (action === 'get_unassigned' || action === 'unassigned' || action === 'available') {
            output = RichFormatter.header(`Unassigned Characters (${data.count})`, '👤');
            if (data.characters?.length) {
                const rows = data.characters.map((c: { name: string; characterClass?: string; level?: number }) => [c.name, c.characterClass || 'Adventurer', `Lv${c.level || 1}`]);
                output += RichFormatter.table(['Name', 'Class', 'Level'], rows);
            } else {
                output += '*No unassigned characters*\n';
            }
        } else if (action === 'move' || action === 'travel' || action === 'goto') {
            output = RichFormatter.header('Party Moved', '🗺️');
            output += RichFormatter.keyValue({
                'Party': data.party?.name,
                'Location': data.newPosition?.location,
                'Position': `(${data.newPosition?.x}, ${data.newPosition?.y})`
            });
        } else if (action === 'get_position' || action === 'position' || action === 'where') {
            output = RichFormatter.header(`${data.partyName} Location`, '📍');
            if (data.position) {
                output += RichFormatter.keyValue({
                    'Location': data.position.locationName || 'Unknown',
                    'Position': data.position.x !== null ? `(${data.position.x}, ${data.position.y})` : 'Not set'
                });
            }
        } else if (action === 'get_in_region' || action === 'nearby' || action === 'in_area') {
            output = RichFormatter.header(`Nearby Parties (${data.count})`, '🔍');
            output += `Search area: (${data.searchArea?.x}, ${data.searchArea?.y}) radius ${data.searchArea?.radius}\n\n`;
            if (data.parties?.length) {
                const rows = data.parties.map((p: { name: string; locationName?: string; positionX?: number; positionY?: number }) => [
                    p.name,
                    p.locationName || 'Unknown',
                    `(${p.positionX ?? '?'}, ${p.positionY ?? '?'})`
                ]);
                output += RichFormatter.table(['Party', 'Location', 'Position'], rows);
            } else {
                output += '*No parties found in this area*\n';
            }
        } else if (action === 'set_upkeep' || action === 'stores' || action === 'link_stores' || action === 'rations' || action === 'upkeep' || action === 'tick_upkeep' || action === 'eat' || action === 'feed') {
            output = RichFormatter.header(data.actionType === 'upkeep' ? 'Upkeep Charged' : (data.cleared ? 'Upkeep Cleared' : 'Upkeep Set'), '🍞');
            if (data.stores) {
                output += RichFormatter.keyValue({
                    'Stores': `${data.stores.current}/${data.stores.max} mouth-days (${data.stores.characterId} · ${data.stores.pool})`,
                    'Mouths': data.mouths?.total,
                    'Days left': data.daysLeft === null ? 'no one eats' : data.daysLeft,
                    'Charged through': `Day ${data.startDay}`
                });
            }
            if (data.message) output += RichFormatter.alert(data.message, data.starvedDays ? 'warning' : 'info');
            if (data.unitsNote) output += RichFormatter.alert(data.unitsNote, 'warning');
        } else {
            // Fallback for unknown actions
            output = RichFormatter.header('Party Operation', '👥');
            output += JSON.stringify(data, null, 2) + '\n';
        }

        // Embed JSON for programmatic access
        output += RichFormatter.embedJson(data, 'PARTY_MANAGE');

        return { content: [{ type: 'text', text: output }] };
    } catch {
        // If JSON parsing fails, return original response
        return response;
    }
}
