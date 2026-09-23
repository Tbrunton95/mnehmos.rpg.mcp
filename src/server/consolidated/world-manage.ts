/**
 * Consolidated World Management Tool
 * Replaces 7 separate tools for world lifecycle management:
 * create_world, get_world, list_worlds, delete_world, update_world_environment,
 * generate_world, get_world_state
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { WorldRepository } from '../../storage/repos/world.repo.js';
import { World } from '../../schema/world.js';
import { generateWorld as generateWorldProc } from '../../engine/worldgen/index.js';
import { persistWorldRegions } from '../tools.js';
import { getWorldManager } from '../state/world-manager.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['create', 'get', 'list', 'delete', 'update', 'generate', 'get_state', 'snapshot', 'restore', 'list_snapshots', 'delete_snapshot', 'audit'] as const;
type WorldManageAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function getWorldRepo(): WorldRepository {
    const db = getDb(process.env.NODE_ENV === 'test' ? ':memory:' : 'rpg.db');
    return new WorldRepository(db);
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const CreateSchema = z.object({
    action: z.literal('create'),
    name: z.string().min(1).describe('World name'),
    seed: z.string().describe('Seed for generation'),
    width: z.number().int().min(10).max(1000).describe('World width'),
    height: z.number().int().min(10).max(1000).describe('World height'),
    landRatio: z.number().min(0.1).max(0.9).optional().describe('Land to water ratio')
});

const GetSchema = z.object({
    action: z.literal('get'),
    id: z.string().describe('World ID')
});

const ListSchema = z.object({
    action: z.literal('list')
});

const DeleteSchema = z.object({
    action: z.literal('delete'),
    id: z.string().describe('World ID to delete')
});

// FINDINGS #98 (ЗАСТАВА T1.2): every other world-scoped call takes worldId;
// update took only id and silently 400d. Preprocess maps worldId → id so
// either spelling works and downstream types stay strict.
const UpdateSchema = z.preprocess(
    (v) => (v && typeof v === 'object' && !(v as Record<string, unknown>).id && (v as Record<string, unknown>).worldId
        ? { ...(v as Record<string, unknown>), id: (v as Record<string, unknown>).worldId }
        : v),
    z.object({
        action: z.literal('update'),
        id: z.string().describe('World ID (worldId accepted as alias)'),
        worldId: z.string().optional().describe('Alias of id — pass either'),
        environment: z.object({
            dayNightCycle: z.enum(['day', 'night', 'dawn', 'dusk']).optional(),
            weather: z.string().optional(),
            season: z.enum(['spring', 'summer', 'autumn', 'winter', 'none']).optional(),
            temperature: z.string().optional(),
            lighting: z.string().optional()
        }).passthrough().describe('Environment properties to update')
    })
);

const GenerateSchema = z.object({
    action: z.literal('generate'),
    seed: z.string().describe('Seed for random number generation'),
    width: z.number().int().min(10).max(1000).describe('Width of the world grid'),
    height: z.number().int().min(10).max(1000).describe('Height of the world grid'),
    landRatio: z.number().min(0.1).max(0.9).optional().describe('Land to water ratio'),
    temperatureOffset: z.number().min(-30).max(30).optional().describe('Temperature offset'),
    moistureOffset: z.number().min(-30).max(30).optional().describe('Moisture offset')
});

const SnapshotSchema = z.object({
    action: z.literal('snapshot'),
    label: z.string().describe('Snapshot label, e.g. "pre-lab-x16". Sanitized to a filename.')
});
const RestoreSchema = z.object({
    action: z.literal('restore'),
    label: z.string().describe('Label of the snapshot to restore. THE ENTIRE DATABASE returns to that moment.'),
    worldId: z.string().optional().describe('FINDINGS #111: the world you are restoring FOR. Other worlds with writes newer than the snapshot are COLLATERAL — restore refuses and names them unless confirmGlobal:true'),
    confirmGlobal: z.boolean().optional().describe('FINDINGS #111: acknowledge that every other campaign in this file rolls back too — required when collateral worlds exist')
});
const ListSnapshotsSchema = z.object({
    action: z.literal('list_snapshots')
});
const DeleteSnapshotSchema = z.object({
    action: z.literal('delete_snapshot'),
    label: z.string().describe('Snapshot label to delete from disk. Irreversible for that file.')
});

import { readdirSync, statSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';

function snapshotDir(db: import('better-sqlite3').Database): string {
    const dbFile = (db as unknown as { name: string }).name;
    const dir = join(dirname(dbFile), 'snapshots');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

function sanitizeLabel(label: string): string {
    return label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * FINDINGS #34 T1.1 — engine-side snapshot/restore.
 * Snapshot: VACUUM INTO a labeled file (atomic, works on the live DB).
 * Restore: transactional table-by-table copy back from the ATTACHed snapshot —
 * the process keeps its connection, no file locking games. Same-schema only:
 * a snapshot taken before a migration cannot be restored after it.
 */
function handleSnapshot(args: z.infer<typeof SnapshotSchema>): object {
    const db = getDb();
    const label = sanitizeLabel(args.label);
    const file = join(snapshotDir(db), `${label}.db`);
    db.prepare(`VACUUM INTO ?`).run(file);
    const size = statSync(file).size;
    return {
        success: true, actionType: 'snapshot', label, file,
        sizeBytes: size,
        message: `Snapshot "${label}" written (${(size / 1024).toFixed(0)} KB). Restore with world_manage restore {label: "${label}"}.`
    };
}

function handleRestore(args: z.infer<typeof RestoreSchema>): object {
    const db = getDb();
    const label = sanitizeLabel(args.label);
    const file = join(snapshotDir(db), `${label}.db`);
    if (!existsSync(file)) {
        return { error: true, message: `No snapshot named "${label}". Use list_snapshots.` };
    }
    // FINDINGS #111: THE COLLATERAL GUARD. Restore is whole-DB by architecture
    // (one file), and in a multi-campaign file that means another chair's
    // rollback erased 21 in-fiction days of a campaign it never touched. Before
    // discarding the present, name every OTHER world with writes newer than
    // the snapshot and REFUSE unless the caller confirms the global cost.
    const snapMtime = (() => { try { return statSync(file).mtime.toISOString(); } catch { return null; } })();
    if (snapMtime && !args.confirmGlobal) {
        const collateral: Record<string, number> = {};
        const lanes: Array<[string, string]> = [
            ['narrative_notes', 'world_id'], ['characters', 'world_id'], ['encounters', 'world_id'], ['parties', 'world_id']
        ];
        for (const [table, col] of lanes) {
            try {
                const rows = db.prepare(`SELECT ${col} AS w, COUNT(*) AS n FROM "${table}" WHERE ${col} IS NOT NULL AND COALESCE(updated_at, created_at) > ? GROUP BY ${col}`).all(snapMtime) as Array<{ w: string; n: number }>;
                for (const r of rows) { if (r.w !== args.worldId) collateral[r.w] = (collateral[r.w] ?? 0) + r.n; }
            } catch { /* lane lacks the columns on this db — skip, do not lie */ }
        }
        const victims = Object.keys(collateral);
        if (victims.length) {
            return {
                error: true,
                actionType: 'restore',
                refused: 'collateral worlds have writes newer than the snapshot',
                snapshot: label, snapshotTakenAt: snapMtime,
                collateral,
                message: `REFUSED (#111): restoring "${label}" would roll back ${victims.length} other world(s) with newer writes: ${victims.map(w => `${w} (${collateral[w]} rows)`).join(', ')}. This is whole-DB by architecture. Re-run with confirmGlobal:true to accept the collateral — a pre-restore safety snapshot will still be taken first. Per-world restore is queued as its own wave.`,
                writes: 'none'
            };
        }
    }
    // Findings #35 doctrine, made mechanism: restore is a whole-DB rollback
    // across BOTH chairs. Snapshot the present before discarding it, so the
    // reverted interval is itself recoverable.
    const safetyLabel = sanitizeLabel(`pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const safetyFile = join(snapshotDir(db), `${safetyLabel}.db`);
    db.prepare(`VACUUM INTO ?`).run(safetyFile);

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map(r => r.name);
    db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS snap`);
    try {
        const snapTables = new Set((db.prepare(`SELECT name FROM snap.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map(r => r.name));
        db.exec('PRAGMA foreign_keys = OFF');
        const restore = db.transaction(() => {
            for (const t of tables) {
                if (!snapTables.has(t)) continue;   // table born after the snapshot — leave as-is
                db.prepare(`DELETE FROM "${t}"`).run();
                db.prepare(`INSERT INTO "${t}" SELECT * FROM snap."${t}"`).run();
            }
        });
        restore();
        db.exec('PRAGMA foreign_keys = ON');
        return {
            success: true, actionType: 'restore', label,
            tablesRestored: tables.filter(t => snapTables.has(t)).length,
            safetySnapshot: safetyLabel,
            message: `Database restored to snapshot "${label}". The discarded present was saved as "${safetyLabel}" — restore THAT to undo this. In-memory caches may be stale; reload encounters and worlds. ⚠️ This rollback affects BOTH chairs — announce it.`
        };
    } finally {
        db.exec('DETACH DATABASE snap');
    }
}

function handleDeleteSnapshot(args: z.infer<typeof DeleteSnapshotSchema>): object {
    const db = getDb();
    const label = sanitizeLabel(args.label);
    const file = join(snapshotDir(db), `${label}.db`);
    if (!existsSync(file)) {
        return { error: true, message: `No snapshot named "${label}".` };
    }
    const sizeKB = Math.round(statSync(file).size / 1024);
    unlinkSync(file);
    return { success: true, actionType: 'delete_snapshot', label, freedKB: sizeKB, message: `Snapshot "${label}" deleted (${sizeKB} KB freed).` };
}

function handleListSnapshots(): object {
    const db = getDb();
    const dir = snapshotDir(db);
    const snaps = readdirSync(dir).filter(f => f.endsWith('.db')).map(f => {
        const st = statSync(join(dir, f));
        return { label: basename(f, '.db'), sizeKB: Math.round(st.size / 1024), takenAt: st.mtime.toISOString() };
    }).sort((a, b) => b.takenAt.localeCompare(a.takenAt));
    return { success: true, actionType: 'list_snapshots', count: snaps.length, snapshots: snaps };
}

const GetStateSchema = z.object({
    action: z.literal('get_state'),
    worldId: z.string().describe('World ID')
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleCreate(args: z.infer<typeof CreateSchema>): Promise<object> {
    const worldRepo = getWorldRepo();
    const now = new Date().toISOString();

    const world: World = {
        id: randomUUID(),
        name: args.name,
        seed: args.seed,
        width: args.width,
        height: args.height,
        createdAt: now,
        updatedAt: now
    };

    worldRepo.create(world);

    return {
        success: true,
        actionType: 'create',
        worldId: world.id,
        name: world.name,
        seed: world.seed,
        dimensions: { width: world.width, height: world.height },
        message: `Created world "${world.name}" (${world.width}x${world.height})`
    };
}

async function handleGet(args: z.infer<typeof GetSchema>): Promise<object> {
    const worldRepo = getWorldRepo();
    const world = worldRepo.findById(args.id);

    if (!world) {
        return { error: true, message: `World not found: ${args.id}` };
    }

    return {
        success: true,
        actionType: 'get',
        world: {
            id: world.id,
            name: world.name,
            seed: world.seed,
            width: world.width,
            height: world.height,
            environment: world.environment,
            createdAt: world.createdAt,
            updatedAt: world.updatedAt
        }
    };
}

async function handleList(): Promise<object> {
    const worldRepo = getWorldRepo();
    const worlds = worldRepo.findAll();

    return {
        success: true,
        actionType: 'list',
        count: worlds.length,
        worlds: worlds.map(w => ({
            id: w.id,
            name: w.name,
            seed: w.seed,
            dimensions: { width: w.width, height: w.height },
            createdAt: w.createdAt
        }))
    };
}

async function handleDelete(args: z.infer<typeof DeleteSchema>): Promise<object> {
    const worldRepo = getWorldRepo();
    worldRepo.delete(args.id);

    // Also remove from in-memory state
    const worldManager = getWorldManager();
    worldManager.delete(args.id);

    return {
        success: true,
        actionType: 'delete',
        deletedId: args.id,
        message: `Deleted world ${args.id}`
    };
}

async function handleUpdate(args: z.infer<typeof UpdateSchema>): Promise<object> {
    const worldRepo = getWorldRepo();
    // FINDINGS #88: elapsedHours — the world clock and the emission timer must
    // never disagree. The PRIOR clock is read before the write; the delta is
    // returned so the chair passes the ENGINE's number to secret_manage
    // check_conditions instead of hand-computing hours a second time.
    const parseClock = (env: { day?: number; time?: string } | undefined): number | null => {
        if (!env || typeof env.day !== 'number') return null;
        let frac = 0;
        if (typeof env.time === 'string') {
            const m = env.time.match(/^(\d{1,2}):(\d{2})$/);
            if (m) frac = (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) / 1440;
        }
        return env.day + frac;
    };
    const prior = worldRepo.findById(args.id) as { environment?: { day?: number; time?: string } } | null;
    const priorClock = parseClock(prior?.environment);
    const updated = worldRepo.updateEnvironment(args.id, args.environment);

    if (!updated) {
        return { error: true, message: `World not found: ${args.id}` };
    }

    const newClock = parseClock(args.environment as { day?: number; time?: string });
    const elapsedHours = priorClock !== null && newClock !== null ? Math.round((newClock - priorClock) * 24 * 100) / 100 : null;

    return {
        success: true,
        actionType: 'update',
        worldId: args.id,
        environment: args.environment,
        ...(elapsedHours !== null ? {
            elapsedHours,
            elapsedNote: elapsedHours >= 0
                ? `${elapsedHours}h elapsed since the prior clock — pass THIS number to secret_manage check_conditions {type:'time_passed', hoursPassed:${elapsedHours}}`
                : `clock moved BACKWARDS ${Math.abs(elapsedHours)}h — rewind or correction; no time_passed check applies`
        } : {}),
        message: `Updated environment for world ${args.id}${elapsedHours !== null && elapsedHours > 0 ? ` — ${elapsedHours}h elapsed` : ''}`
    };
}

// FINDINGS #88: STATE CONSISTENCY AUDIT — generalises #80 (ghost encounters)
// and #85 (the living man's corpse). Rows that disagree, asked in one call.
// Every check is defensive: a missing table is a skipped check, never a crash.
// FINDINGS #103: party-seat check extracted so it can run world-scoped (throws
// into runW's labeled fallback if parties lack world_id on this build).
function auditPartySeats(db: ReturnType<typeof getDb>, worldId?: string): unknown[] {
    const parties = (worldId
        ? db.prepare(`SELECT id, name, current_location AS location FROM parties WHERE status = 'active' AND world_id = ?`).all(worldId)
        : db.prepare(`SELECT id, name, current_location AS location FROM parties WHERE status = 'active'`).all()) as Array<{ id: string; name: string; location: string | null }>;
    const out: unknown[] = [];
    for (const p of parties) {
        const members = db.prepare(`SELECT ch.id, ch.name, ch.current_room_id AS roomId FROM party_members pm JOIN characters ch ON ch.id = pm.character_id WHERE pm.party_id = ?`).all(p.id) as Array<{ id: string; name: string; roomId: string | null }>;
        const seats = members.map(m => ({ ...m, room: m.roomId ? ((db.prepare('SELECT name FROM rooms WHERE id = ?').get(m.roomId) ?? db.prepare('SELECT name FROM room_nodes WHERE id = ?').get(m.roomId)) as { name: string } | undefined)?.name ?? 'UNRESOLVED ROOM' : null }));
        const disagreement = seats.some(s => s.room === 'UNRESOLVED ROOM');
        out.push({ partyId: p.id, party: p.name, partyLocation: p.location, memberSeats: seats, note: disagreement ? 'member seated in a room no table knows' : 'positions listed for eyeball reconciliation — party location strings and room seats have no common key; the reader judges' });
    }
    return out;
}

// READ-ONLY — the audit names contradictions; fixing them stays a decision.
// FINDINGS #103: the audit now HONORS worldId (id accepted as alias — it was
// accepted-and-discarded before, the #100 contamination class on the health
// check itself). Checks scope by world where the table carries world_id;
// where it does not (characters, effects, auras, encounters — the #103
// migration queue), the check runs global and SAYS SO in its name, so the
// reader always knows which patient each row belongs to.
async function handleAudit(args: { worldId?: string }): Promise<object> {
    const db = getDb(process.env.NODE_ENV === 'test' ? ':memory:' : process.env.RPG_DATA_DIR ? `${process.env.RPG_DATA_DIR}/rpg.db` : 'rpg.db');
    const W = args.worldId;
    const checks: Array<{ check: string; status: 'ok' | 'contradictions' | 'skipped'; scope?: string; items: unknown[] }> = [];
    // Scoped-first with honest fallback: when W is given and a scoped query
    // exists, use it; if the scoped query throws (column not there yet), fall
    // back to global WITH the label — never silently widen.
    const runW = (check: string, scopedFn: (() => unknown[]) | null, globalFn: () => unknown[]) => {
        if (W && scopedFn) {
            try {
                const items = scopedFn();
                checks.push({ check, status: items.length ? 'contradictions' : 'ok', scope: 'world', items });
                return;
            } catch { /* fall through to labeled global */ }
        }
        try {
            const items = globalFn();
            checks.push({ check: W ? `${check} [GLOBAL — table has no world scope yet (#103)]` : check, status: items.length ? 'contradictions' : 'ok', scope: W ? 'global-fallback' : 'global', items });
        } catch { checks.push({ check, status: 'skipped', items: [] }); }
    };
    runW('corpses of living characters',
        () => db.prepare(`SELECT c.id AS corpseId, c.character_name AS name, c.state, ch.id AS characterId, ch.hp FROM corpses c JOIN characters ch ON ch.id = c.character_id WHERE ch.hp > 0 AND c.world_id = ?`).all(W),
        () => db.prepare(`SELECT c.id AS corpseId, c.character_name AS name, c.state, ch.id AS characterId, ch.hp FROM corpses c JOIN characters ch ON ch.id = c.character_id WHERE ch.hp > 0`).all());
    runW('characters seated in nonexistent rooms',
        // FINDINGS #105: scoped lane live once characters carry world_id.
        () => db.prepare(`SELECT id, name, current_room_id AS roomId FROM characters WHERE world_id = ? AND current_room_id IS NOT NULL AND current_room_id NOT IN (SELECT id FROM room_nodes) AND current_room_id NOT IN (SELECT id FROM rooms)`).all(W),
        () => db.prepare(`SELECT id, name, current_room_id AS roomId FROM characters WHERE current_room_id IS NOT NULL AND current_room_id NOT IN (SELECT id FROM room_nodes) AND current_room_id NOT IN (SELECT id FROM rooms)`).all());
    runW('scheduled rows for missing characters',
        () => db.prepare(`SELECT id AS scheduleId, character_id AS characterId, note, fires_at_day AS firesAtDay FROM scheduled_state_changes WHERE fired = 0 AND world_id = ? AND character_id NOT IN (SELECT id FROM characters)`).all(W),
        () => db.prepare(`SELECT id AS scheduleId, character_id AS characterId, note, fires_at_day AS firesAtDay FROM scheduled_state_changes WHERE fired = 0 AND character_id NOT IN (SELECT id FROM characters)`).all());
    runW('active effects on missing characters', null,
        // FINDINGS #103b: dead since #88 — queried character_id; the column is target_id. First run ever.
        () => db.prepare(`SELECT id, name, target_id AS characterId FROM custom_effects WHERE is_active = 1 AND target_id NOT IN (SELECT id FROM characters)`).all());
    runW('auras owned by missing characters', null,
        // FINDINGS #103b: dead since #88 — queried active_auras; the table is auras. First run ever.
        () => db.prepare(`SELECT id, spell_name AS spellName, owner_id AS ownerId FROM auras WHERE owner_id NOT IN (SELECT id FROM characters)`).all());
    runW('quests given by unknown names (advisory — non-terminal only, #89)',
        () => db.prepare(`SELECT id, name, giver, status FROM quests WHERE world_id = ? AND giver IS NOT NULL AND giver != '' AND status NOT IN ('completed', 'failed', 'abandoned', 'archived') AND giver NOT IN (SELECT name FROM characters)`).all(W),
        () => db.prepare(`SELECT id, name, giver, status FROM quests WHERE giver IS NOT NULL AND giver != '' AND status NOT IN ('completed', 'failed', 'abandoned', 'archived') AND giver NOT IN (SELECT name FROM characters)`).all());
    // FINDINGS #90: the third-Sidorovich lane — a note BOUND to an entity id
    // that no longer resolves. (Content MENTIONS of dead ids are structurally
    // uncatchable; bindings are not.)
    runW('notes bound to missing characters (advisory)',
        () => db.prepare(`SELECT id, type, entity_id AS entityId FROM narrative_notes WHERE world_id = ? AND entity_type = 'character' AND entity_id IS NOT NULL AND entity_id NOT IN (SELECT id FROM characters)`).all(W),
        () => db.prepare(`SELECT id, type, entity_id AS entityId FROM narrative_notes WHERE entity_type = 'character' AND entity_id IS NOT NULL AND entity_id NOT IN (SELECT id FROM characters)`).all());
    runW('active encounter rows (ghost candidates — combat_manage list tags liveness)',
        // FINDINGS #105: scoped lane live once encounters carry world_id.
        () => db.prepare(`SELECT id, round, updated_at AS updatedAt FROM encounters WHERE world_id = ? AND status = 'active'`).all(W),
        () => db.prepare(`SELECT id, round, updated_at AS updatedAt FROM encounters WHERE status = 'active'`).all());
    runW('party position vs member seats',
        () => auditPartySeats(db, W),
        () => auditPartySeats(db, undefined));
    const contradictions = checks.filter(c => c.status === 'contradictions').reduce((n, c) => n + c.items.length, 0);
    return {
        success: true,
        actionType: 'audit',
        worldId: args.worldId ?? null,
        checksRun: checks.filter(c => c.status !== 'skipped').length,
        checksSkipped: checks.filter(c => c.status === 'skipped').map(c => c.check),
        contradictions,
        checks,
        message: contradictions === 0
            ? 'Audit clean — no contradictions found. (party-position check always lists for eyeball review.)'
            : `Audit found ${contradictions} contradiction(s) across ${checks.filter(c => c.status === 'contradictions').length} check(s) — each names its rows. Fixing them is a decision, not an auto-repair.`
    };
}

async function handleGenerate(args: z.infer<typeof GenerateSchema>): Promise<object> {
    const worldRepo = getWorldRepo();
    const worldManager = getWorldManager();

    // Generate the procedural world
    const generatedWorld = generateWorldProc({
        seed: args.seed,
        width: args.width,
        height: args.height,
        landRatio: args.landRatio,
        temperatureOffset: args.temperatureOffset,
        moistureOffset: args.moistureOffset
    });

    // Create DB record
    const now = new Date().toISOString();
    const world: World = {
        id: `world-${args.seed}-${Date.now()}`,
        name: `World (${args.seed})`,
        seed: args.seed,
        width: args.width,
        height: args.height,
        createdAt: now,
        updatedAt: now
    };

    worldRepo.create(world);

    // Store in memory for fast access
    worldManager.create(world.id, generatedWorld);
    persistWorldRegions(getDb(process.env.NODE_ENV === 'test' ? ':memory:' : 'rpg.db'), world.id, generatedWorld as any);

    // Calculate biome stats from 2D biomes array
    const biomeStats: Record<string, number> = {};
    for (let y = 0; y < generatedWorld.biomes.length; y++) {
        for (let x = 0; x < generatedWorld.biomes[y].length; x++) {
            const biome = generatedWorld.biomes[y][x];
            biomeStats[biome] = (biomeStats[biome] || 0) + 1;
        }
    }

    const tileCount = args.width * args.height;

    return {
        success: true,
        actionType: 'generate',
        worldId: world.id,
        seed: args.seed,
        dimensions: { width: args.width, height: args.height },
        tileCount: tileCount,
        regionCount: generatedWorld.regions.length,
        biomeDistribution: biomeStats,
        message: `Generated ${args.width}x${args.height} world with ${generatedWorld.regions.length} regions`
    };
}

async function handleGetState(args: z.infer<typeof GetStateSchema>): Promise<object> {
    const worldManager = getWorldManager();
    const worldRepo = getWorldRepo();

    const dbWorld = worldRepo.findById(args.worldId);
    const memWorld = worldManager.get(args.worldId);

    if (!dbWorld && !memWorld) {
        return { error: true, message: `World not found: ${args.worldId}` };
    }

    // FINDINGS #22: counts previously read ONLY from memory — a lazy-loaded
    // world reported 0 tiles / 0 regions while existing fully in the DB (the
    // get_state lie). Read geography from the database when memory is cold.
    const db = getDb();
    let tileCount = 0;
    if (memWorld?.biomes) {
        tileCount = memWorld.width * memWorld.height;
    } else if (dbWorld && (dbWorld as { width?: number; height?: number }).width) {
        const w = (dbWorld as { width?: number }).width ?? 0;
        const h = (dbWorld as { height?: number }).height ?? 0;
        tileCount = w * h;
    }
    let regionCount = memWorld?.regions?.length || 0;
    if (!regionCount) {
        try {
            regionCount = (db.prepare('SELECT COUNT(*) AS n FROM regions WHERE world_id = ?').get(args.worldId) as { n: number }).n;
        } catch { /* regions table absent — leave 0 */ }
    }

    return {
        success: true,
        actionType: 'get_state',
        worldId: args.worldId,
        name: dbWorld?.name,
        inMemory: !!memWorld,
        inDatabase: !!dbWorld,
        hydrated: !!memWorld,
        tileCount: tileCount,
        regionCount,
        environment: dbWorld?.environment
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<WorldManageAction, ActionDefinition> = {
    create: {
        schema: CreateSchema,
        handler: handleCreate,
        aliases: ['new', 'add'],
        description: 'Create a new world in the database'
    },
    get: {
        schema: GetSchema,
        handler: handleGet,
        aliases: ['fetch', 'retrieve'],
        description: 'Get world details by ID'
    },
    list: {
        schema: ListSchema,
        handler: handleList,
        aliases: ['all', 'show'],
        description: 'List all worlds'
    },
    delete: {
        schema: DeleteSchema,
        handler: handleDelete,
        aliases: ['remove', 'destroy'],
        description: 'Delete a world'
    },
    update: {
        schema: UpdateSchema,
        handler: handleUpdate,
        aliases: ['set', 'modify', 'environment'],
        description: 'Update world environment (time, weather, season) — returns elapsedHours since the prior clock (#88)'
    },
    audit: {
        schema: z.preprocess(
            (v) => (v && typeof v === 'object' && !(v as Record<string, unknown>).worldId && (v as Record<string, unknown>).id
                ? { ...(v as Record<string, unknown>), worldId: (v as Record<string, unknown>).id }
                : v),
            z.object({ action: z.literal('audit'), worldId: z.string().optional().describe('FINDINGS #103: scope the audit to ONE world — id accepted as alias (it was accepted-and-discarded before). Omit for a whole-DB audit; unscopable checks are labeled [GLOBAL]'), id: z.string().optional().describe('Alias of worldId — pass either') })),
        handler: async (args) => handleAudit(args as { worldId?: string }),
        aliases: ['consistency', 'check_state', 'sanity'],
        description: 'FINDINGS #88: state consistency audit — corpses of living characters, seats in dead rooms, orphan clocks/effects/auras, unknown quest givers, active encounter rows, party-vs-member positions. Read-only; names contradictions, fixes nothing'
    },
    generate: {
        schema: GenerateSchema,
        handler: handleGenerate,
        aliases: ['gen', 'procedural', 'worldgen'],
        description: 'Generate a procedural world with terrain and biomes'
    },
    get_state: {
        schema: GetStateSchema,
        handler: handleGetState,
        aliases: ['state', 'status'],
        description: 'Get current world state (in-memory and database)'
    },
    snapshot: {
        schema: SnapshotSchema,
        handler: async (args) => handleSnapshot(args as z.infer<typeof SnapshotSchema>),
        aliases: ['backup'],
        description: 'Write a labeled SQLite snapshot of the entire database (VACUUM INTO — atomic, live-safe)'
    },
    restore: {
        schema: RestoreSchema,
        handler: async (args) => handleRestore(args as z.infer<typeof RestoreSchema>),
        aliases: ['rollback'],
        description: 'Restore the ENTIRE database to a labeled snapshot (transactional table copy-back)'
    },
    list_snapshots: {
        schema: ListSnapshotsSchema,
        handler: async () => handleListSnapshots(),
        aliases: ['snapshots'],
        description: 'List available snapshots with sizes and timestamps'
    },
    delete_snapshot: {
        schema: DeleteSnapshotSchema,
        handler: async (args) => handleDeleteSnapshot(args as z.infer<typeof DeleteSnapshotSchema>),
        aliases: ['remove_snapshot', 'prune'],
        description: 'Delete a snapshot file from disk (labels are write-once; this is the only removal path)'
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

export const WorldManageTool = {
    name: 'world_manage',
    description: `Manage RPG worlds - creation, retrieval, and procedural generation.
Actions: create, get, list, delete, update (environment), generate (procedural), get_state, snapshot, restore, list_snapshots
Aliases: new→create, fetch→get, all→list, remove→delete, set→update, gen→generate, state→get_state

🌍 WORLD WORKFLOW:
1. generate - Create procedural world with terrain/biomes
2. get_state - Check world status
3. update - Set time/weather/season
4. For map operations, use world_map tool instead`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        label: z.string().optional().describe('Snapshot label (for snapshot/restore)'),
        confirmGlobal: z.boolean().optional().describe('FINDINGS #111 (mirror): restore — accept rolling back OTHER worlds with newer writes; refused without it when collateral exists'),
        id: z.string().optional().describe('World ID'),
        worldId: z.string().optional().describe('World ID (for get_state)'),
        name: z.string().optional().describe('World name (for create)'),
        seed: z.string().optional().describe('Seed for generation'),
        width: z.number().optional().describe('World width'),
        height: z.number().optional().describe('World height'),
        landRatio: z.number().optional(),
        temperatureOffset: z.number().optional(),
        moistureOffset: z.number().optional(),
        environment: z.any().optional().describe('Environment properties (for update)')
    })
};

export async function handleWorldManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    const result = await router(args as Record<string, unknown>);
    const parsed = JSON.parse(result.content[0].text);

    let output = '';

    if (parsed.error) {
        output = RichFormatter.header('Error', '❌');
        output += RichFormatter.alert(parsed.message || 'Unknown error', 'error');
        if (parsed.suggestions) {
            output += '\n**Did you mean:**\n';
            parsed.suggestions.forEach((s: { action: string; similarity: number }) => {
                output += `  • ${s.action} (${s.similarity}% match)\n`;
            });
        }
    } else {
        switch (parsed.actionType) {
            case 'create':
                output = RichFormatter.header('World Created', '🌍');
                output += RichFormatter.keyValue({
                    'ID': `\`${parsed.worldId}\``,
                    'Name': parsed.name,
                    'Dimensions': `${parsed.dimensions?.width}x${parsed.dimensions?.height}`
                });
                break;
            case 'get':
                output = RichFormatter.header('World Details', '🌍');
                if (parsed.world) {
                    output += RichFormatter.keyValue({
                        'ID': `\`${parsed.world.id}\``,
                        'Name': parsed.world.name,
                        'Seed': parsed.world.seed,
                        'Dimensions': `${parsed.world.width}x${parsed.world.height}`
                    });
                }
                break;
            case 'list':
                output = RichFormatter.header(`Worlds (${parsed.count})`, '🌍');
                if (parsed.worlds?.length > 0) {
                    parsed.worlds.forEach((w: { name: string; id: string }) => {
                        output += `• **${w.name}** (\`${w.id}\`)\n`;
                    });
                } else {
                    output += 'No worlds found.\n';
                }
                break;
            case 'delete':
                output = RichFormatter.header('World Deleted', '🗑️');
                output += RichFormatter.keyValue({ 'Deleted ID': `\`${parsed.deletedId}\`` });
                break;
            case 'update':
                output = RichFormatter.header('Environment Updated', '🌤️');
                output += RichFormatter.keyValue({ 'World ID': `\`${parsed.worldId}\``, ...(parsed.elapsedHours !== undefined && parsed.elapsedHours !== null ? { 'Elapsed': `${parsed.elapsedHours}h` } : {}) });
                if (parsed.elapsedNote) output += RichFormatter.alert(parsed.elapsedNote, 'info');
                break;
            case 'audit':
                output = RichFormatter.header('Consistency Audit', '🩺');
                output += RichFormatter.keyValue({ 'Checks run': parsed.checksRun, 'Contradictions': parsed.contradictions });
                if (parsed.checks) {
                    for (const c of parsed.checks as Array<{ check: string; status: string; items: unknown[] }>) {
                        output += `\n${c.status === 'contradictions' ? '⚠️' : c.status === 'skipped' ? '⏭️' : '✅'} **${c.check}**${c.status === 'contradictions' ? ` — ${c.items.length}` : ''}\n`;
                    }
                }
                if (parsed.message) output += RichFormatter.alert(parsed.message, parsed.contradictions > 0 ? 'warning' : 'info');
                break;
            case 'generate':
                output = RichFormatter.header('World Generated', '🌍');
                output += RichFormatter.keyValue({
                    'ID': `\`${parsed.worldId}\``,
                    'Seed': parsed.seed,
                    'Dimensions': `${parsed.dimensions?.width}x${parsed.dimensions?.height}`,
                    'Tiles': parsed.tileCount,
                    'Regions': parsed.regionCount
                });
                break;
            case 'snapshot':
                output = RichFormatter.header('Snapshot Written', '💾');
                output += `**${parsed.label}** — ${Math.round((parsed.sizeBytes || 0) / 1024)} KB\n${parsed.file}\n`;
                break;
            case 'restore':
                output = RichFormatter.header('Database Restored', '⏪');
                output += `Returned to **${parsed.label}** (${parsed.tablesRestored} tables). Reload encounters/worlds before trusting in-memory state.\n`;
                break;
            case 'list_snapshots':
                output = RichFormatter.header(`Snapshots (${parsed.count})`, '💾');
                if (parsed.snapshots?.length > 0) {
                    parsed.snapshots.forEach((s: { label: string; sizeKB: number; takenAt: string }) => {
                        output += `• **${s.label}** — ${s.sizeKB} KB — ${s.takenAt}\n`;
                    });
                } else {
                    output += 'No snapshots yet. world_manage snapshot {label} writes one.\n';
                }
                break;
            case 'get_state':
                output = RichFormatter.header('World State', '📊');
                output += RichFormatter.keyValue({
                    'ID': `\`${parsed.worldId}\``,
                    'In Memory': parsed.inMemory ? '✅' : '❌',
                    'In Database': parsed.inDatabase ? '✅' : '❌',
                    'Tiles': parsed.tileCount,
                    'Regions': parsed.regionCount
                });
                break;
            default:
                output = RichFormatter.header('World', '🌍');
                if (parsed.message) output += parsed.message + '\n';
        }
    }

    output += RichFormatter.embedJson(parsed, 'WORLD_MANAGE');

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}
