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
import { handleKill } from './character-manage.js';
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
    'muster', 'pay', 'after_battle'
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
    victory: z.boolean().describe('true: survivors +1 loyalty; false: -1'),
    casualties: z.array(casualtySchema()).optional(),
    recruits: z.array(recruitSchema()).optional().describe('Characters who join after the battle (not moved by its loyalty)')
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

async function handleMuster(args: z.infer<typeof MusterSchema>): Promise<object> {
    const { partyRepo, charRepo } = ensureDb();
    const party = partyRepo.findById(args.partyId);
    if (!party) throw new Error(`Party not found: ${args.partyId}`);
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
        message: `${party.name} musters ${members.length} (${models} models in units); wages due ${wagesDue} gold${members.some(m => m.wavering) ? `; wavering: ${members.filter(m => m.wavering).map(m => m.name).join(', ')}` : ''}`
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
    if (strangers.length) throw new Error(`Not in ${party.name}: ${strangers.join(', ')}. Nothing was written.`);
    for (const r of args.recruits ?? []) {
        if (!charRepo.findById(r.characterId)) throw new Error(`Recruit not found: ${r.characterId}. Nothing was written.`);
        if (partyRepo.findMember(party.id, r.characterId)) throw new Error(`Recruit ${r.characterId} is already in ${party.name}. Nothing was written.`);
    }

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
    for (const m of partyRepo.findMembersByParty(party.id)) {
        if (dead.has(m.characterId)) continue;
        const to = clampLoyalty(loyaltyOf(m) + step);
        partyRepo.updateMember(party.id, m.characterId, { loyalty: to });
        loyalty.push({ characterId: m.characterId, from: loyaltyOf(m), to, ...(to === 0 ? { wavering: true } : {}) });
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
    return {
        success: true, actionType: 'after_battle', partyId: party.id, victory: args.victory,
        losses, killed, loyalty, recruited,
        message: `${party.name} after ${args.victory ? 'victory' : 'defeat'}: ${killed.length} dead${killed.length ? ` (${killed.map(k => String(k.name)).join(', ')})` : ''}, ${losses.reduce((s, l) => s + Number(l.models), 0)} models lost; survivors loyalty ${step > 0 ? '+1' : '-1'}${recruited.length ? `; ${recruited.length} recruited` : ''}${loyalty.some(l => l.wavering) ? '; some are wavering (loyalty 0)' : ''}.`
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
        description: 'Book casualties (models lost; the dead or a unit at 0 models are killed and struck off), survivors ±1 loyalty by victory, recruits join'
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
- after_battle {partyId, victory, casualties?: [{characterId, models?, dead?}], recruits?}: the dead are killed and struck off, survivors ±1 loyalty, recruits join

Actions: create, get, list, update, delete, add_member, remove_member, update_member, set_leader, set_active, get_members, get_context, get_unassigned, move, get_position, get_in_region, muster, pay, after_battle
Aliases: new/form->create, join/recruit->add_member, leader->set_leader, active/pov->set_active, roster->get_members, travel/goto->move`,
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
        recruits: z.array(recruitSchema()).optional().describe('after_battle: [{characterId, role?, loyalty?, wage?, payMode?, unitModels?}]')
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
