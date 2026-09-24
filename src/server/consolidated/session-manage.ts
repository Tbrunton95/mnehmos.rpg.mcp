/**
 * Consolidated session_manage tool
 * Replaces: initialize_session, get_narrative_context
 * 2 tools → 1 tool with 2 actions
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { matchAction, isGuidingError } from '../../utils/fuzzy-enum.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { readJournal, revertWrite } from '../utils/write-journal.js';
import { PartyRepository } from '../../storage/repos/party.repo.js';
import { QuestRepository } from '../../storage/repos/quest.repo.js';
import { WorldRepository } from '../../storage/repos/world.repo.js';
import { SessionContext } from '../types.js';
import { listRules } from '../../engine/table-rules.js';
import { CHANGELOG, type ChangelogEntry } from '../../data/changelog.js';
import { getMeta, setMeta } from '../../storage/data-migrations.js';
import { lookupOperation } from '../operation-guard.js';
import { queryRolls } from '../../storage/roll-log.js';
import { buildBootPacket, renderBootPacket } from '../boot-packet.js';

/** Engine changes this database has not been shown yet. */
function unseenChangelog(): ChangelogEntry[] {
    const seen = getMeta(getDb(), 'changelog_seen') ?? '';
    return CHANGELOG.filter(e => e.id > seen);
}

function markChangelogSeen(): void {
    const last = CHANGELOG[CHANGELOG.length - 1];
    if (last) setMeta(getDb(), 'changelog_seen', last.id);
}

function renderChangelog(entries: ChangelogEntry[]): string {
    return entries.map(e => `• ${e.title}: ${e.detail}\n`).join('');
}

/**
 * A world's table rules for session boot: the enforced rules by name and
 * kind, and the principles as text (reference only, never enforced).
 */
function tableRulesAtBoot(worldId: string | undefined | null): { enforced: Array<{ name: string; kind: string }>; principles: string[] } | undefined {
    if (!worldId) return undefined;
    const rules = listRules(getDb(), worldId).filter(r => r.enabled);
    if (!rules.length) return undefined;
    return {
        enforced: rules.filter(r => r.kind !== 'principle').map(r => ({ name: r.name, kind: r.kind })),
        principles: rules.filter(r => r.kind === 'principle').map(r => String((r.spec as { text?: string }).text ?? ''))
    };
}

function renderTableRules(t: { enforced: Array<{ name: string; kind: string }>; principles: string[] }): string {
    let out = RichFormatter.section('📜 Table Rules');
    if (t.enforced.length) out += `Enforced: ${t.enforced.map(r => `${r.name} [${r.kind}]`).join(', ')}\n`;
    for (const p of t.principles) out += `• ${p}\n`;
    return out;
}

export interface McpResponse {
    content: Array<{ type: 'text'; text: string }>;
}

const ACTIONS = ['initialize', 'get_context', 'capabilities', 'find', 'journal', 'revert', 'changelog', 'op_status', 'rolls', 'boot'] as const;

type SessionAction = typeof ACTIONS[number];

// Alias map for fuzzy action matching
const ALIASES: Record<string, SessionAction> = {
    'init': 'initialize',
    'start': 'initialize',
    'setup': 'initialize',
    'initialize_session': 'initialize',
    'start_session': 'initialize',
    'context': 'get_context',
    'narrative': 'get_context',
    'narrative_context': 'get_context',
    'get_narrative': 'get_context',
    'summary': 'get_context'
};

function ensureDb() {
    const db = getDb();
    return {
        db,
        partyRepo: new PartyRepository(db),
        questRepo: new QuestRepository(db),
        worldRepo: new WorldRepository(db)
    };
}

// Input schema
const SessionManageInputSchema = z.object({
    action: z.string().describe('Action: initialize, get_context, capabilities, find, journal, revert, changelog, op_status, rolls, boot'),

    // FINDINGS #88 (mirror law): find / journal / revert params — the shared
    // schema IS the outer schema here, so one addition covers both sides.
    query: z.string().optional().describe('find: name/content fragment'),
    limit: z.number().int().optional().describe('find/journal: max results'),
    entityTable: z.string().optional().describe('journal: filter by table (items, item_instances, narrative_notes…)'),
    entityId: z.string().optional().describe('journal: filter by row id'),
    writeId: z.number().int().optional().describe('revert: journal entry id to restore'),
    all: z.boolean().optional().describe('changelog: every entry, not only the ones this database has not seen'),
    forOpId: z.string().optional().describe('op_status / rolls: the opId a call carried'),
    forId: z.string().optional().describe('rolls: whose rolls (character or token id)'),
    characterIds: z.array(z.string()).optional().describe('boot: whose digest (default: the world\'s player characters)'),
    journalLimit: z.number().int().min(0).max(20).optional().describe('boot: journal entries to include (default 5)'),
    encounterId: z.string().optional().describe('rolls: rolls in this encounter'),

    // initialize fields
    worldId: z.string().optional().describe('World ID to load'),
    partyId: z.string().optional().describe('Party ID to load'),
    createNew: z.boolean().optional().default(false).describe('Create new session resources'),
    worldName: z.string().optional().describe('Name for new world'),
    partyName: z.string().optional().describe('Name for new party'),

    // get_context fields
    includeParty: z.boolean().optional().default(true).describe('Include party details'),
    includeQuests: z.boolean().optional().default(true).describe('Include active quests'),
    includeWorld: z.boolean().optional().default(true).describe('Include world state'),
    includeNarrative: z.boolean().optional().default(true).describe('Include recent narrative'),
    includeCombat: z.boolean().optional().default(true).describe('Include active combat'),
    narrativeLimit: z.number().int().min(1).max(50).optional().default(10).describe('Max narrative entries')
});

type SessionManageInput = z.infer<typeof SessionManageInputSchema>;

const SessionManageActionSchemas = {
    initialize: {
        schema: SessionManageInputSchema.extend({ action: z.literal('initialize') }),
        aliases: ['init', 'start', 'setup', 'initialize_session', 'start_session'],
        description: 'Start or resume a session, optionally creating world and party resources'
    },
    get_context: {
        schema: SessionManageInputSchema.extend({ action: z.literal('get_context') }),
        aliases: ['context', 'narrative', 'narrative_context', 'get_narrative', 'summary'],
        description: 'Get narrative context for AI game mastering'
    },
    capabilities: {
        schema: SessionManageInputSchema.extend({ action: z.literal('capabilities') }),
        aliases: ['server_info', 'version', 'build_info', 'handshake'],
        description: 'FINDINGS #87: the capability handshake — what is this server, when was it built, which findings level, which actions per tool. One call at boot replaces probing; a chair whose client schema lacks an action the server lists knows to route raw args via batch'
    },
    find: {
        schema: SessionManageInputSchema.extend({ action: z.literal('find'), query: z.string().describe('Name/content fragment to find'), limit: z.number().int().min(1).max(25).optional().default(8) }),
        aliases: ['lookup', 'search_all', 'reverse_lookup'],
        description: 'FINDINGS #88: reverse lookup — one query across characters, items, instances, rooms, POIs, notes, quests; returns ids grouped by table. Ends the search-by-name-and-hope loop'
    },
    journal: {
        schema: SessionManageInputSchema.extend({ action: z.literal('journal'), entityTable: z.string().optional(), entityId: z.string().optional(), limit: z.number().int().min(1).max(50).optional().default(10) }),
        aliases: ['write_journal', 'history', 'writes'],
        description: 'FINDINGS #88: list journaled writes (items, instances, notes…) — newest first, filterable by table/entity. Each row is revertable by id'
    },
    boot: {
        schema: SessionManageInputSchema.extend({ action: z.literal('boot'), worldId: z.string() }),
        aliases: ['boot_packet', 'before_play', 'session_start'],
        description: "Everything to read before play in one call: what's new, table rules, character digests (features marked engine-applied or reminder), clocks, open threads, live telegraphs, last journal entries, recent precedents"
    },
    rolls: {
        schema: SessionManageInputSchema.extend({ action: z.literal('rolls') }),
        aliases: ['roll_log', 'dice_log', 'audit_rolls'],
        description: 'The roll log, newest first: who each roll was for, why, the dice, and how to replay it (a seed, or an encounter stream origin@draw). Filter by forId, encounterId or forOpId'
    },
    op_status: {
        schema: SessionManageInputSchema.extend({ action: z.literal('op_status'), forOpId: z.string() }),
        aliases: ['operation', 'did_it_apply'],
        description: 'Did the call carrying this opId apply? After a timeout, check before retrying (a retry with the same opId is also safe)'
    },
    changelog: {
        schema: SessionManageInputSchema.extend({ action: z.literal('changelog') }),
        aliases: ['whats_new', 'changes', 'release_notes'],
        description: 'What changed in the engine since this database last looked (all: true for everything); marks them seen'
    },
    revert: {
        schema: SessionManageInputSchema.extend({ action: z.literal('revert'), writeId: z.number().int().describe('Journal entry id to revert') }),
        aliases: ['undo', 'rollback', 'restore_write'],
        description: 'FINDINGS #88: restore the journaled snapshot wholesale — a mutated row returns to its prior state, a deleted row comes back. Counts from the store'
    }
};

// Action handlers

// FINDINGS #87: CAPABILITY HANDSHAKE — twice a wave was handed over as "src
// only, not live" and WAS live (#85, #86); once the verb existed and the
// CLIENT schema hid it. The server could not be asked what it is. This action
// self-inspects the RUNNING code: it scans its own consolidated directory for
// ACTIONS arrays and FINDINGS markers, so the answer describes the process
// that is actually serving, not any tree on any disk.
async function handleCapabilities(_input: SessionManageInput, _ctx: SessionContext): Promise<McpResponse> {
    const { readdirSync, readFileSync, statSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const { createHash } = await import('crypto');
    const here = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(here).filter(f => f.endsWith('.js') || f.endsWith('.ts')).sort();
    let findingsLevel = 0;
    let newestMtime = 0;
    const actionsByTool: Record<string, string[]> = {};
    const hash = createHash('sha1');
    for (const f of files) {
        const full = join(here, f);
        const st = statSync(full);
        if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
        hash.update(`${f}:${st.size}:${Math.floor(st.mtimeMs)};`);
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(/FINDINGS #(\d+)/g)) {
            const n = parseInt(m[1], 10);
            if (n > findingsLevel) findingsLevel = n;
        }
        const am = text.match(/const ACTIONS = \[([^\]]*)\]/);
        if (am) {
            const actions = [...am[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
            // FINDINGS #94: a file can export MULTIPLE tools (hull + siege
            // alias) — credit the ACTIONS to every tool name declared in it,
            // not just the filename. Fixes siege_manage's absence and the
            // 34-vs-35 count.
            const names = [...text.matchAll(/name:\s*'([a-z_]+)'/g)].map(x => x[1]).filter(n => n.includes('_'));
            if (names.length) for (const n of names) actionsByTool[n] = actions;
            else actionsByTool[f.replace(/\.(js|ts)$/, '').replace(/-/g, '_')] = actions;
        }
    }
    const result = {
        success: true,
        actionType: 'capabilities',
        buildHash: hash.digest('hex').slice(0, 12),
        builtAt: new Date(newestMtime).toISOString(),
        findingsLevel,
        runningFrom: here,
        toolCount: Object.keys(actionsByTool).length,
        actionsByTool,
        note: 'Self-inspection of the RUNNING process. If the client schema lacks an action listed here, the schema is stale — reopen the client or route raw args via batch_manage (03 §9).'
    };
    let output = RichFormatter.header('Server Capabilities', '🤝');
    output += RichFormatter.keyValue({
        'Build': result.buildHash,
        'Built at': result.builtAt,
        'Findings level': `#${result.findingsLevel}`,
        'Tools': result.toolCount
    });
    output += RichFormatter.embedJson(result, 'SESSION_MANAGE');
    return { content: [{ type: 'text', text: output }] };
}

// FINDINGS #88: reverse lookup, journal read, and revert — the meta verbs
// live beside the handshake. find LIKE-scans allowlisted tables defensively
// (a missing table is a skipped lane, never a crash); journal/revert ride
// the shared write-journal module.
async function handleFind(input: SessionManageInput & { query?: string; limit?: number }, _ctx: SessionContext): Promise<McpResponse> {
    const db = getDb();
    const q = `%${input.query ?? ''}%`;
    const limit = input.limit ?? 8;
    // FINDINGS #111: worldId is a STRICT filter on every lane that carries one
    // (characters, narrative_notes, pois, quests, encounters via world_id;
    // rooms/room_nodes via their network joins). Unscopable lanes (items,
    // instances) run global and SAY SO. Before this, a search for a name in
    // one campaign returned three other campaigns' notes — law 3's shape.
    const W = (input as { worldId?: string }).worldId;
    const scoped = (sql: string, col = 'world_id') => W ? sql.replace(' LIMIT ?', ` AND ${col} = ? LIMIT ?`) : sql;
    const lanes: Array<{ table: string; sql: string; label: (r: Record<string, unknown>) => string; scopable: boolean }> = [
        { table: 'characters', sql: scoped('SELECT id, name, character_type AS extra FROM characters WHERE name LIKE ? LIMIT ?'), label: r => `${r.name} (${r.extra})`, scopable: true },
        { table: 'items', sql: 'SELECT id, name, type AS extra FROM items WHERE name LIKE ? LIMIT ?', label: r => `${r.name} (${r.extra})`, scopable: false },
        { table: 'item_instances', sql: `SELECT i.id, COALESCE(i.custom_name, t.name) AS name, i.owner_character_id AS extra FROM item_instances i LEFT JOIN items t ON t.id = i.template_id WHERE COALESCE(i.custom_name, t.name) LIKE ? LIMIT ?`, label: r => `${r.name} (owner ${r.extra})`, scopable: false },
        { table: 'rooms', sql: W ? 'SELECT r.id, r.name, r.networkId AS extra FROM rooms r JOIN pois p ON p.networkId = r.networkId WHERE r.name LIKE ? AND p.worldId = ? LIMIT ?' : 'SELECT id, name, networkId AS extra FROM rooms WHERE name LIKE ? LIMIT ?', label: r => `${r.name} (POI room)`, scopable: true },
        { table: 'room_nodes', sql: W ? 'SELECT rn.id, rn.name, rn.biome_context AS extra FROM room_nodes rn JOIN node_networks nn ON nn.id = rn.network_id WHERE rn.name LIKE ? AND nn.world_id = ? LIMIT ?' : 'SELECT id, name, biome_context AS extra FROM room_nodes WHERE name LIKE ? LIMIT ?', label: r => `${r.name} (spatial)`, scopable: true },
        { table: 'pois', sql: scoped('SELECT id, name, type AS extra FROM pois WHERE name LIKE ? LIMIT ?', 'worldId'), label: r => `${r.name} (${r.extra})`, scopable: true },
        { table: 'narrative_notes', sql: scoped('SELECT id, substr(content, 1, 60) AS name, type AS extra FROM narrative_notes WHERE content LIKE ? LIMIT ?'), label: r => `[${r.extra}] ${r.name}…`, scopable: true },
        { table: 'quests', sql: scoped('SELECT id, name, status AS extra FROM quests WHERE name LIKE ? LIMIT ?'), label: r => `${r.name} (${r.extra})`, scopable: true }
    ];
    const results: Record<string, Array<{ id: unknown; match: string }>> = {};
    const skipped: string[] = [];
    const unscopedLanes: string[] = [];
    for (const lane of lanes) {
        try {
            const rows = (W && lane.scopable ? db.prepare(lane.sql).all(q, W, limit) : db.prepare(lane.sql).all(q, limit)) as Array<Record<string, unknown>>;
            if (rows.length) results[lane.table] = rows.map(r => ({ id: r.id, match: lane.label(r) }));
            if (W && !lane.scopable && rows.length) unscopedLanes.push(lane.table);
        } catch { skipped.push(lane.table); }
    }
    const total = Object.values(results).reduce((n, a) => n + a.length, 0);
    const payload = { success: true, actionType: 'find', query: input.query, totalMatches: total, results, ...(W ? { worldId: W, ...(unscopedLanes.length ? { unscopedLanes, note: 'items/instances carry no world_id — those lanes ran GLOBAL' } : {}) } : {}), ...(skipped.length ? { skippedTables: skipped } : {}) };
    let output = RichFormatter.header(`Find: "${input.query}"`, '🔎');
    output += RichFormatter.keyValue({ 'Matches': total });
    for (const [table, rows] of Object.entries(results)) {
        output += `\n**${table}:**\n`;
        for (const r of rows) output += `  • \`${r.id}\` — ${r.match}\n`;
    }
    output += RichFormatter.embedJson(payload, 'SESSION_MANAGE');
    return { content: [{ type: 'text', text: output }] };
}

async function handleJournal(input: SessionManageInput & { entityTable?: string; entityId?: string; limit?: number }, _ctx: SessionContext): Promise<McpResponse> {
    const db = getDb();
    const rows = readJournal(db, { table: input.entityTable, entityId: input.entityId, limit: input.limit });
    const payload = { success: true, actionType: 'journal', count: rows.length, writes: rows };
    let output = RichFormatter.header('Write Journal', '📜');
    output += RichFormatter.keyValue({ 'Entries': rows.length });
    for (const r of rows) output += `  • #${r.id} ${r.op} ${r.entity_table}/${r.entity_id} — ${r.source ?? ''} @ ${r.created_at}\n`;
    output += RichFormatter.embedJson(payload, 'SESSION_MANAGE');
    return { content: [{ type: 'text', text: output }] };
}

async function handleRevert(input: SessionManageInput & { writeId?: number }, _ctx: SessionContext): Promise<McpResponse> {
    const db = getDb();
    if (input.writeId === undefined) {
        const payload = { error: true, message: 'revert requires writeId — session_manage journal to list entries' };
        return { content: [{ type: 'text', text: RichFormatter.error(payload.message) + RichFormatter.embedJson(payload, 'SESSION_MANAGE') }] };
    }
    const result = revertWrite(db, input.writeId);
    const payload = { success: true, actionType: 'revert', writeId: input.writeId, ...result, message: `Reverted ${result.op} on ${result.table}/${result.entityId} — ${result.restoredColumns} column(s) restored to the ${result.journaledAt} snapshot` };
    let output = RichFormatter.header('Write Reverted', '⏪');
    output += RichFormatter.keyValue({ 'Table': result.table, 'Row': result.entityId, 'Was': result.op, 'Columns restored': result.restoredColumns });
    output += RichFormatter.embedJson(payload, 'SESSION_MANAGE');
    return { content: [{ type: 'text', text: output }] };
}

async function handleInitialize(input: SessionManageInput, ctx: SessionContext): Promise<McpResponse> {
    const { worldRepo, partyRepo } = ensureDb();
    const now = new Date().toISOString();

    let worldId = input.worldId;
    let partyId = input.partyId;
    const created: { world?: boolean; party?: boolean } = {};

    // Create or load world
    if (!worldId && input.createNew) {
        worldId = randomUUID();
        worldRepo.create({
            id: worldId,
            name: input.worldName || 'New World',
            seed: randomUUID().slice(0, 8),
            width: 100,
            height: 100,
            createdAt: now,
            updatedAt: now
        });
        created.world = true;
    } else if (!worldId) {
        // Try to find existing world
        const worlds = worldRepo.findAll();
        if (worlds.length > 0) {
            worldId = worlds[0].id;
        }
    }

    // Create or load party
    if (!partyId && input.createNew) {
        partyId = randomUUID();
        partyRepo.create({
            id: partyId,
            name: input.partyName || 'Adventuring Party',
            status: 'active',
            formation: 'standard',
            createdAt: now,
            updatedAt: now
        });
        created.party = true;
    } else if (!partyId) {
        // Try to find existing party
        const parties = partyRepo.findAll();
        if (parties.length > 0) {
            partyId = parties[0].id;
        }
    }

    // Get session state
    const world = worldId ? worldRepo.findById(worldId) : null;
    const party = partyId ? partyRepo.getPartyWithMembers(partyId) : null;

    let output = RichFormatter.header('Session Initialized', '🎮');
    output += RichFormatter.keyValue({
        'Session ID': ctx.sessionId,
        'World': world ? `${world.name} (${worldId})` : 'None',
        'Party': party ? `${party.name} (${partyId})` : 'None'
    });

    if (created.world || created.party) {
        output += RichFormatter.section('Created');
        if (created.world) output += `• New world: ${input.worldName || 'New World'}\n`;
        if (created.party) output += `• New party: ${input.partyName || 'Adventuring Party'}\n`;
    }

    if (party && party.members && party.members.length > 0) {
        output += RichFormatter.section('Party Members');
        const rows = party.members.map(m => [
            m.character.name,
            (m.character as any).characterClass || 'Adventurer',
            `${m.character.hp}/${m.character.maxHp}`,
            m.role === 'leader' ? '★' : ''
        ]);
        output += RichFormatter.table(['Name', 'Class', 'HP', 'Leader'], rows);
    }

    const bootRules = tableRulesAtBoot(worldId);
    if (bootRules) output += renderTableRules(bootRules);
    const whatsNew = unseenChangelog();
    if (whatsNew.length) { output += RichFormatter.section("🆕 What's new in the engine") + renderChangelog(whatsNew); markChangelogSeen(); }

    const result = {
        success: true,
        actionType: 'initialize',
        ...(bootRules ? { tableRules: bootRules } : {}),
        ...(whatsNew.length ? { whatsNew } : {}),
        sessionId: ctx.sessionId,
        worldId,
        worldName: world?.name,
        partyId,
        partyName: party?.name,
        partyMembers: party?.members?.map(m => ({
            id: m.character.id,
            name: m.character.name,
            class: (m.character as any).characterClass,
            hp: m.character.hp,
            maxHp: m.character.maxHp,
            isLeader: m.role === 'leader'
        })) || [],
        created
    };

    output += RichFormatter.embedJson(result, 'SESSION_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

async function handleGetContext(input: SessionManageInput, _ctx: SessionContext): Promise<McpResponse> {
    const { partyRepo, questRepo, worldRepo, db } = ensureDb();

    const context: Record<string, any> = {};
    const bootRules = tableRulesAtBoot(input.worldId);
    if (bootRules) context.tableRules = bootRules;
    const whatsNew = unseenChangelog();
    if (whatsNew.length) { context.whatsNew = whatsNew; markChangelogSeen(); }

    // Get party context
    if (input.includeParty && input.partyId) {
        const party = partyRepo.getPartyWithMembers(input.partyId);
        if (party) {
            context.party = {
                id: party.id,
                name: party.name,
                members: party.members?.map(m => ({
                    id: m.character.id,
                    name: m.character.name,
                    level: m.character.level,
                    hp: m.character.hp,
                    maxHp: m.character.maxHp,
                    ac: m.character.ac,
                    conditions: [],
                    isLeader: m.role === 'leader'
                })) || []
            };
        }
    }

    // Get active quests
    if (input.includeQuests) {
        const allQuests = questRepo.findAll();
        const activeQuests = allQuests.filter((q: { status: string }) => q.status === 'active' || q.status === 'in_progress');
        context.quests = activeQuests.map((q: { id: string; name: string; status: string; objectives?: Array<{ completed: boolean; description?: string }> }) => ({
            id: q.id,
            title: q.name,
            status: q.status,
            currentObjective: q.objectives?.find((o: { completed: boolean; description?: string }) => !o.completed)?.description
        }));
    }

    // Get world context
    if (input.includeWorld && input.worldId) {
        const world = worldRepo.findById(input.worldId);
        if (world) {
            context.world = {
                id: world.id,
                name: world.name,
                currentTime: (world.environment as any)?.timeOfDay || 'day'
            };

            // Get current location if party has position
            if (input.partyId) {
                const party = partyRepo.findById(input.partyId);
                if (party && (party as any).currentLocation) {
                    context.world.currentLocation = (party as any).currentLocation;
                }
            }

            // FINDINGS #82: due clocks & events surface at boot — the GM's
            // deadlines stop living only in their head. Day detection tries
            // environment.day / .currentDay / a number in .date (the env is
            // passthrough, so the key is GM-shaped); no day means no DUE list,
            // and a missing table degrades to nothing. kind derives from
            // writes === '[]' so this works on any schema vintage.
            try {
                const env = (world.environment ?? {}) as Record<string, unknown>;
                const day = typeof env.day === 'number' ? env.day
                    : typeof env.currentDay === 'number' ? env.currentDay
                        : (() => { const m = String(env.date ?? '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; })();
                // FINDINGS #97 (SALT leak #2, session half): the ⏰ section scopes to
                // this world's characters when worldId is present — a boot no longer
                // surfaces (or tempts firing of) other campaigns' clocks.
                const schedScope = 'JOIN characters c ON c.id = s.character_id AND c.world_id = ?';
                const pendingTotal = (input.worldId
                    ? (db.prepare(`SELECT COUNT(*) AS n FROM scheduled_state_changes s ${schedScope} WHERE s.fired = 0`).get(input.worldId) as { n: number }).n
                    : (db.prepare('SELECT COUNT(*) AS n FROM scheduled_state_changes WHERE fired = 0').get() as { n: number }).n);
                const due = day !== null
                    ? (input.worldId
                        ? db.prepare(`SELECT s.id, s.character_id, s.fires_at_day, s.note, s.writes FROM scheduled_state_changes s ${schedScope} WHERE s.fired = 0 AND s.fires_at_day <= ? ORDER BY s.fires_at_day LIMIT 10`).all(input.worldId, day)
                        : db.prepare('SELECT id, character_id, fires_at_day, note, writes FROM scheduled_state_changes WHERE fired = 0 AND fires_at_day <= ? ORDER BY fires_at_day LIMIT 10').all(day)) as Array<{ id: number; character_id: string; fires_at_day: number; note: string | null; writes: string }>
                    : [];
                if (due.length || pendingTotal) {
                    context.scheduled = {
                        day,
                        pendingTotal,
                        due: due.map(d => ({ scheduleId: d.id, kind: d.writes === '[]' ? 'event' : 'clock', characterId: d.character_id, firesAtDay: d.fires_at_day, note: d.note }))
                    };
                }
            } catch { /* scheduled table absent — nothing to surface */ }
        }
    }

    // Get recent narrative (using direct SQL since no repo exists)
    // FINDINGS #97 (SALT leak #1): when worldId is passed it now SCOPES this
    // query — previously ignored, injecting every campaign's canon into the
    // caller's context window. No worldId = global (single-campaign legacy).
    if (input.includeNarrative) {
        try {
            const narratives = (input.worldId
                ? db.prepare(`
                SELECT id, type, content, created_at
                FROM narrative_notes
                WHERE world_id = ?
                ORDER BY created_at DESC
                LIMIT ?
            `).all(input.worldId, input.narrativeLimit || 10)
                : db.prepare(`
                SELECT id, type, content, created_at
                FROM narrative_notes
                ORDER BY created_at DESC
                LIMIT ?
            `).all(input.narrativeLimit || 10)) as Array<{ id: string; type: string; content: string; created_at: string }>;
            context.narrative = narratives.map((n: { created_at: string; type: string; content: string }) => ({
                timestamp: n.created_at,
                type: n.type,
                content: n.content
            }));
        } catch {
            // narrative_notes table might not exist
            context.narrative = [];
        }
    }

    // Get active combat
    if (input.includeCombat) {
        // Check for active encounters
        try {
            const activeEncounters = db.prepare(`
                SELECT id, round, status, active_token_id
                FROM encounters
                WHERE status = 'active'
                ORDER BY updated_at DESC
                LIMIT 1
            `).all() as any[];

            if (activeEncounters.length > 0) {
                const enc = activeEncounters[0];
                // FINDINGS #79: liveness check — an 'active' ROW with no engine
                // in memory is not active combat; it is either a resumable
                // crash-survivor or a pre-#79 ghost whose end never marked the
                // row. Report it as persisted, never as running: the boot
                // banner must not claim a fight that is not happening.
                // Every call reads the encounter fresh, so an active row is
                // the running fight; memory says nothing about it any more.
                context.activeCombat = {
                    encounterId: enc.id,
                    round: enc.round,
                    currentTurn: enc.active_token_id
                };
            }
        } catch {
            // No encounters table or no active combat
        }
    }

    // Build output
    let output = RichFormatter.header('Narrative Context', '📜');

    if (context.party) {
        output += RichFormatter.section('Party');
        output += `**${context.party.name}** (${context.party.members.length} members)\n`;
        for (const m of context.party.members) {
            const leaderMark = m.isLeader ? ' ★' : '';
            output += `• ${m.name}${leaderMark} - Level ${m.level} ${m.race} ${m.class} (HP: ${m.hp}/${m.maxHp})\n`;
        }
    }

    if (context.quests && context.quests.length > 0) {
        output += RichFormatter.section('Active Quests');
        for (const q of context.quests) {
            output += `• **${q.title}** [${q.status}]\n`;
            if (q.currentObjective) {
                output += `  → ${q.currentObjective}\n`;
            }
        }
    }

    if (context.world) {
        output += RichFormatter.section('World');
        output += `**${context.world.name}**`;
        if (context.world.currentLocation) {
            output += ` - Currently at: ${context.world.currentLocation}`;
        }
        output += '\n';
    }

    if (context.scheduled) {
        output += RichFormatter.section('⏰ Scheduled');
        for (const d of context.scheduled.due) {
            output += `📣 DUE (Day ${d.firesAtDay}${d.kind === 'event' ? ', event' : ''}): ${d.note ?? '(no note)'} — fire via character_manage process_scheduled\n`;
        }
        if (!context.scheduled.due.length) output += `${context.scheduled.pendingTotal} pending, none due${context.scheduled.day === null ? ' (world day unknown)' : ''}\n`;
        else if (context.scheduled.pendingTotal > context.scheduled.due.length) output += `(+${context.scheduled.pendingTotal - context.scheduled.due.length} more pending, not yet due)\n`;
    }

    if (context.whatsNew) output += RichFormatter.section("🆕 What's new in the engine") + renderChangelog(context.whatsNew);
    if (context.tableRules) output += renderTableRules(context.tableRules);

    if (context.activeCombat) {
        output += RichFormatter.section('Active Combat');
        output += `Encounter: ${context.activeCombat.encounterId}\n`;
        output += `Round: ${context.activeCombat.round}\n`;
    }

    if (context.narrative && context.narrative.length > 0) {
        output += RichFormatter.section('Recent Events');
        for (const n of context.narrative.slice(0, 5)) {
            output += `• [${n.type}] ${n.content.substring(0, 100)}${n.content.length > 100 ? '...' : ''}\n`;
        }
    }

    const result = {
        success: true,
        actionType: 'get_context',
        ...context
    };

    output += RichFormatter.embedJson(result, 'SESSION_MANAGE');

    return { content: [{ type: 'text', text: output }] };
}

// Main handler
export async function handleSessionManage(args: unknown, ctx: SessionContext): Promise<McpResponse> {
    const input = SessionManageInputSchema.parse(args);
    const matchResult = matchAction(input.action, ACTIONS, ALIASES, 0.6);

    if (isGuidingError(matchResult)) {
        let output = RichFormatter.error(`Unknown action: "${input.action}"`);
        output += `\nAvailable actions: ${ACTIONS.join(', ')}`;
        if (matchResult.suggestions.length > 0) {
            output += `\nDid you mean: ${matchResult.suggestions.map(s => `"${s.value}" (${Math.round(s.similarity * 100)}%)`).join(', ')}?`;
        }
        output += RichFormatter.embedJson(matchResult, 'SESSION_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    }

    switch (matchResult.matched) {
        case 'initialize':
            return handleInitialize(input, ctx);
        case 'get_context':
            return handleGetContext(input, ctx);
        case 'capabilities':
            return handleCapabilities(input, ctx);
        case 'find':
            return handleFind(input as SessionManageInput & { query?: string; limit?: number }, ctx);
        case 'journal':
            return handleJournal(input as SessionManageInput & { entityTable?: string; entityId?: string; limit?: number }, ctx);
        case 'revert':
            return handleRevert(input as SessionManageInput & { writeId?: number }, ctx);
        case 'op_status': {
            const found = input.forOpId ? lookupOperation(getDb(), input.forOpId) : null;
            const payload = found
                ? { success: true, actionType: 'op_status', opId: input.forOpId, applied: true, tool: found.tool, appliedAt: found.createdAt, reply: found.response.slice(0, 600) }
                : { success: true, actionType: 'op_status', opId: input.forOpId, applied: false, message: 'No call with this opId applied. Retrying it is safe.' };
            let output = RichFormatter.header('Operation', '🧾');
            output += found ? `op ${input.forOpId} applied: ${found.tool} at ${found.createdAt}\n` : `op ${input.forOpId} did not apply. Retry it with the same opId.\n`;
            output += RichFormatter.embedJson(payload, 'SESSION_MANAGE');
            return { content: [{ type: 'text', text: output }] };
        }
        case 'boot': {
            if (!input.worldId) {
                const payload = { error: true, message: 'boot needs worldId' };
                return { content: [{ type: 'text', text: RichFormatter.error(payload.message) + RichFormatter.embedJson(payload, 'SESSION_MANAGE') }] };
            }
            const whatsNew = unseenChangelog();
            if (whatsNew.length) markChangelogSeen();
            const rules = tableRulesAtBoot(input.worldId);
            const packet = buildBootPacket(input.worldId, input.characterIds, input.journalLimit ?? 5);
            const payload = { success: true, actionType: 'boot', ...(whatsNew.length ? { whatsNew } : {}), ...(rules ? { tableRules: rules } : {}), ...packet };
            let output = RichFormatter.header('Before Play', '📋');
            if (whatsNew.length) output += RichFormatter.section("🆕 What's new in the engine") + renderChangelog(whatsNew);
            if (rules) output += renderTableRules(rules);
            output += renderBootPacket(packet);
            output += RichFormatter.embedJson(payload, 'SESSION_MANAGE');
            return { content: [{ type: 'text', text: output }] };
        }
        case 'rolls': {
            const rows = queryRolls(getDb(), { forId: input.forId, encounterId: input.encounterId, opId: input.forOpId, limit: input.limit });
            const payload = { success: true, actionType: 'rolls', count: rows.length, rolls: rows };
            let output = RichFormatter.header('Roll Log', '🎲');
            for (const r of rows) {
                const dice = (r.dice as Array<{ sides: number; value: number }>).map(d => `d${d.sides}:${d.value}`).join(' ');
                output += `• ${r.created_at} ${r.purpose}${r.for_id ? ` for ${r.for_id}` : ''}${r.target_id ? ` → ${r.target_id}` : ''}: [${dice}]${r.result !== null ? ` = ${r.result}` : ''}${r.replay ? ` (replay ${r.replay})` : ''}${r.op_id ? ` op ${r.op_id}` : ''}\n`;
            }
            if (!rows.length) output += 'No rolls logged for that filter.\n';
            output += RichFormatter.embedJson(payload, 'SESSION_MANAGE');
            return { content: [{ type: 'text', text: output }] };
        }
        case 'changelog': {
            const entries = input.all ? CHANGELOG : unseenChangelog();
            markChangelogSeen();
            const payload = { success: true, actionType: 'changelog', count: entries.length, entries };
            let output = RichFormatter.header("What's New", '🆕');
            output += entries.length ? renderChangelog(entries) : 'Nothing new since the last session.\n';
            output += RichFormatter.embedJson(payload, 'SESSION_MANAGE');
            return { content: [{ type: 'text', text: output }] };
        }
        default:
            return {
                content: [{
                    type: 'text',
                    text: RichFormatter.error(`Unhandled action: ${matchResult.matched}`) +
                        RichFormatter.embedJson({ error: true, message: `Unhandled: ${matchResult.matched}` }, 'SESSION_MANAGE')
                }]
            };
    }
}

// Tool definition for registration
export const SessionManageTool = {
    name: 'session_manage',
    description: `Session lifecycle and narrative context for AI game mastering.

🎮 SESSION WORKFLOW:
1. initialize - Start/resume session (loads or creates world + party)
2. get_context - Get comprehensive context for AI decision-making

📋 CONTEXT INCLUDES:
- Party members with HP, level, class
- Active quests and current objectives
- World state (time, location, weather)
- Recent narrative events
- Active combat status

💡 AI USAGE:
Call get_context at conversation start to understand game state.
Inject context into system prompt for informed storytelling.

Actions: initialize, get_context
Aliases: init/start→initialize, context/narrative→get_context`,
    actionSchemas: SessionManageActionSchemas,
    inputSchema: SessionManageInputSchema
};
