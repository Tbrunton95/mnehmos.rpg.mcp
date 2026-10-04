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
import type { WorldRepository } from '../../storage/repos/world.repo.js';
import { World, WorldEnvironmentSchema } from '../../schema/world.js';
import { generateWorld as generateWorldProc } from '../../engine/worldgen/index.js';
import { getWorldManager } from '../state/world-manager.js';
import { getDomainServices } from '../domain-services.js';
import { getDb } from '../../storage/index.js';
import { persistGeneratedWorldEntities } from '../../services/generated-world-persistence.service.js';
import { readWorldClock, clockAt, clockAfter, dayClock, clockLabel, clockWarning, recordsAfterClock, scheduleInWorldSql, scheduleLiveSql } from '../../engine/world-clock.js';
import { parseExposure, tickExposure, type ExposureTickLine } from '../../engine/exposure.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { fireDueScheduledRows } from './character-manage.js';
import { reconcileWorld, reconcileLine, RECONCILE_KINDS, type ReconcileFinding } from '../reconcile.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['create', 'get', 'list', 'delete', 'update', 'generate', 'get_state', 'snapshot', 'restore', 'list_snapshots', 'delete_snapshot', 'audit', 'advance', 'era_jump', 'reconcile'] as const;
type WorldManageAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function getWorldRepo(): WorldRepository {
    return getDomainServices().world;
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
        correction: z.boolean().optional().describe('Item 15: the clock was WRONG, not time passing — skips regeneration and the elapsed/time_passed note; returns correction {from, to, deltaHours}'),
        environment: WorldEnvironmentSchema.partial().describe(
            'Canonical environment properties to update: day, time, date, timeOfDay, season, moonPhase, weatherConditions, temperature, lighting'
        )
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
    return writeEnvironment(args.id, args.environment, 'update', { correction: args.correction === true });
}

// Item 15: a plain update that jumps this far (or goes backwards) is more
// often a fix than a journey; the result says how to mark it as one.
const LARGE_JUMP_HOURS = 72;

/**
 * The one write path for the world clock: update and advance both land here,
 * so elapsedHours, regeneration and the time_passed note never diverge.
 */
function writeEnvironment(worldId: string, patch: Partial<z.infer<typeof WorldEnvironmentSchema>>, actionType: 'update' | 'advance' | 'era_jump', opts: { correction?: boolean } = {}): Record<string, unknown> {
    const worldRepo = getWorldRepo();
    // FINDINGS #88: elapsedHours — the world clock and the emission timer must
    // never disagree. The PRIOR clock is read before the write; the delta is
    // returned so the chair passes the ENGINE's number to secret_manage
    // check_conditions instead of hand-computing hours a second time.
    const prior = worldRepo.findById(worldId) as { environment?: { day?: number; time?: string } } | null;
    const priorClock = clockAt(prior?.environment);
    const updated = worldRepo.updateEnvironment(worldId, patch);

    if (!updated) {
        return { error: true, message: `World not found: ${worldId}` };
    }

    // Read the merged clock so a time-only update still yields elapsed hours.
    const newClock = clockAt(updated.environment as { day?: number; time?: string });
    const deltaHours = priorClock !== null && newClock !== null ? Math.round((newClock - priorClock) * 24 * 100) / 100 : null;

    // Item 15: a correction moves the clock without time passing — no
    // regeneration, no elapsed hours to feed time_passed, just what moved.
    if (opts.correction) {
        const db = getDb();
        const warning = clockWarning(db, worldId);
        return {
            success: true,
            actionType,
            worldId,
            environment: updated.environment,
            correction: {
                from: priorClock !== null ? dayClock(priorClock) : null,
                to: newClock !== null ? dayClock(newClock) : null,
                deltaHours
            },
            ...(warning ? { clockWarning: warning } : {}),
            message: `Clock corrected for world ${worldId}${newClock !== null ? ` to ${dayClock(newClock)}` : ''} — no time passed: no regeneration, no time_passed check`
        };
    }
    const elapsedHours = deltaHours;

    // Table rules: regeneration runs out of combat too. A minute is ten
    // rounds, so any advance of a minute or more restores regenerating
    // characters in this world who are still standing.
    let regenerated: Array<{ id: string; name: string; from: number; to: number }> | undefined;
    if (elapsedHours !== null && elapsedHours >= 1 / 60) {
        try {
            const db = getDb();
            const rows = db.prepare('SELECT id, name, hp, max_hp FROM characters WHERE world_id = ? AND regeneration > 0 AND hp > 0 AND hp < max_hp')
                .all(worldId) as Array<{ id: string; name: string; hp: number; max_hp: number }>;
            const heal = db.prepare('UPDATE characters SET hp = max_hp, updated_at = ? WHERE id = ?');
            const now = new Date().toISOString();
            for (const r of rows) heal.run(now, r.id);
            if (rows.length) regenerated = rows.map(r => ({ id: r.id, name: r.name, from: r.hp, to: r.max_hp }));
        } catch { /* characters.world_id not present on this database */ }
    }

    return {
        ...(regenerated ? { regenerated } : {}),
        success: true,
        actionType,
        worldId,
        environment: updated.environment,
        ...(elapsedHours !== null ? {
            elapsedHours,
            elapsedNote: elapsedHours >= 0
                ? `${elapsedHours}h elapsed since the prior clock — pass THIS number to secret_manage check_conditions {type:'time_passed', hoursPassed:${elapsedHours}}`
                : `clock moved BACKWARDS ${Math.abs(elapsedHours)}h — rewind or correction; no time_passed check applies`
        } : {}),
        ...(actionType === 'update' && elapsedHours !== null && (elapsedHours >= LARGE_JUMP_HOURS || elapsedHours < 0) ? {
            hint: `The clock moved ${elapsedHours}h. If this fixes a wrong clock rather than passing time, re-send with correction: true — it skips regeneration and the time_passed note.`
        } : {}),
        message: `Updated environment for world ${worldId}${elapsedHours !== null && elapsedHours > 0 ? ` — ${elapsedHours}h elapsed` : ''}${regenerated ? `; regenerated to full: ${regenerated.map(r => r.name).join(', ')}` : ''}`
    };
}

// Item 14: advance the clock by an amount instead of computing the new day
// and HH:MM by hand. It writes through the same path as update, then counts
// what the new clock has reached. Firing stays with the GM: process_scheduled
// and ledger process_due are explicit verbs (FINDINGS #100).
const AdvanceSchema = z.preprocess(
    (v) => (v && typeof v === 'object' && !(v as Record<string, unknown>).worldId && (v as Record<string, unknown>).id
        ? { ...(v as Record<string, unknown>), worldId: (v as Record<string, unknown>).id }
        : v),
    z.object({
        action: z.literal('advance'),
        worldId: z.string().describe('World whose clock moves (id accepted as alias)'),
        id: z.string().optional().describe('Alias of worldId'),
        minutes: z.number().min(0).optional().describe('Minutes to advance'),
        hours: z.number().min(0).optional().describe('Hours to advance'),
        days: z.number().min(0).optional().describe('Days to advance'),
        fireScheduled: z.boolean().optional().describe('Request 10: after the clock moves, fire the due live scheduled rows of this world in the same call (what process_scheduled does); reply carries fired[]. Default false: due rows are only counted')
    })
);

async function handleAdvance(args: z.infer<typeof AdvanceSchema>): Promise<object> {
    const hours = (args.days ?? 0) * 24 + (args.hours ?? 0) + (args.minutes ?? 0) / 60;
    if (!(hours > 0)) {
        return { error: true, actionType: 'advance', message: 'advance needs minutes, hours or days greater than zero. Nothing was written.' };
    }
    return advanceWorldClock(args.worldId, hours, { fireScheduled: args.fireScheduled === true });
}

/**
 * Request 10: tick every exposure timer in the world by the elapsed hours.
 * Only the advance path calls this: a correction moves the clock without
 * time passing, so nothing dries out.
 */
function tickWorldExposure(db: ReturnType<typeof getDb>, worldId: string, hours: number): ExposureTickLine[] {
    let rows: Array<{ id: string; exposure: string }>;
    try {
        rows = db.prepare("SELECT id, exposure FROM characters WHERE world_id = ? AND exposure IS NOT NULL AND exposure != '[]'").all(worldId) as Array<{ id: string; exposure: string }>;
    } catch { return []; /* exposure or world_id column not present on this database */ }
    if (!rows.length) return [];
    const repo = new CharacterRepository(db);
    const lines: ExposureTickLine[] = [];
    const now = new Date().toISOString();
    for (const row of rows) {
        const entries = parseExposure(row.exposure);
        if (!entries.length) continue;
        const char = repo.findById(row.id) as { resourcePools?: Record<string, { current: number; max: number }>; conditions?: Array<{ name: string; duration?: number; source?: string }> } | null;
        if (!char) continue;
        const tick = tickExposure(row.id, entries, char.resourcePools ?? {}, char.conditions ?? [], hours);
        const updates: Record<string, unknown> = {};
        if (tick.poolsTouched) updates.resourcePools = tick.pools;
        if (tick.condsTouched) updates.conditions = tick.conditions;
        if (Object.keys(updates).length) repo.update(row.id, updates as Partial<import('../../schema/character.js').Character>);
        db.prepare('UPDATE characters SET exposure = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(tick.entries), now, row.id);
        lines.push(...tick.lines);
    }
    return lines;
}

/**
 * Move a world's clock forward by `hours` through the one write path
 * (regeneration, elapsed note) and count what came due. world_manage advance
 * and spatial_manage traverse {advanceClock} both call it.
 */
export function advanceWorldClock(worldId: string, hours: number, opts: { fireScheduled?: boolean } = {}): Record<string, unknown> {
    const args = { worldId };
    const db = getDb();
    const clock = readWorldClock(db, args.worldId);
    if (!clock) {
        const exists = db.prepare('SELECT 1 FROM worlds WHERE id = ?').get(args.worldId);
        return {
            error: true, actionType: 'advance',
            message: exists
                ? `World ${args.worldId} has no clock to advance: set one first with world_manage update {worldId, environment: {day, time: 'HH:MM'}}. Nothing was written.`
                : `World not found: ${args.worldId}`
        };
    }
    const next = clockAfter(clock.at, hours);
    const result = writeEnvironment(args.worldId, next, 'advance');
    if (result.error) return result;
    const at = clockAt(next)!;
    // Request 10: exposure timers tick with the clock; a correction never lands here.
    const exposure = tickWorldExposure(db, args.worldId, hours);
    // Request 10: fireScheduled fires the due rows here instead of only counting them.
    let fired: Array<Record<string, unknown>> | undefined; let firedWarning: string | undefined;
    if (opts.fireScheduled) {
        const f = fireDueScheduledRows({ worldId: args.worldId, effectiveDay: at });
        fired = f.results; firedWarning = f.backlogWarning;
    }
    // Read-only counts: what process_scheduled and process_due would act on now.
    let scheduled = 0; let debts = 0;
    try {
        scheduled = (db.prepare(`SELECT COUNT(*) AS n FROM scheduled_state_changes s WHERE ${scheduleLiveSql('s')} AND ${scheduleInWorldSql('s')} AND s.fires_at_day <= ?`).get(args.worldId, args.worldId, at) as { n: number }).n;
    } catch { /* no schedule table yet */ }
    try {
        debts = (db.prepare(`SELECT COUNT(*) AS n FROM ledger_debts WHERE world_id = ? AND due_day IS NOT NULL
                             AND ((status = 'pending' AND due_day <= ?) OR (status = 'due' AND ? > due_day + grace_days))`).get(args.worldId, next.day, next.day) as { n: number }).n;
    } catch { /* no ledger table yet */ }
    // Item 4: congregations with a whole week to process. Reported only when
    // there are some, so worlds without cults see the same dueNow as before.
    let congregations = 0;
    try {
        congregations = (db.prepare(`SELECT COUNT(*) AS n FROM congregations WHERE world_id = ? AND status = 'active'
                                     AND last_processed_day IS NOT NULL AND ? - last_processed_day >= 7`).get(args.worldId, at) as { n: number }).n;
    } catch { /* no congregations table yet */ }
    const label = `Day ${next.day}, ${next.time}`;
    const due = [scheduled ? `${scheduled} scheduled row(s) due: process_scheduled {worldId}` : '', debts ? `${debts} debt(s) to move: ledger_manage process_due {worldId}` : '', congregations ? `${congregations} congregation(s) with a week to process: congregation_manage process_weekly {worldId}` : ''].filter(Boolean);
    const exposureNote = exposure.length
        ? `; exposure: ${exposure.map(e => `${e.name} ${e.pool} ${e.from}→${e.to}${e.conditionsAdded.length ? ` +${e.conditionsAdded.join(', ')}` : ''}`).join('; ')}`
        : '';
    return {
        ...result,
        clock: label,
        dueNow: { scheduled, debts, ...(congregations > 0 ? { congregations } : {}) },
        ...(exposure.length ? { exposure } : {}),
        ...(fired ? { fired, firedCount: fired.length, ...(firedWarning ? { backlogWarning: firedWarning } : {}) } : {}),
        message: `Clock advanced ${Math.round(hours * 100) / 100}h to ${label}${result.regenerated ? `; regenerated to full: ${(result.regenerated as Array<{ name: string }>).map(r => r.name).join(', ')}` : ''}${exposureNote}${fired ? `; fired ${fired.length} scheduled row(s)` : ''}${due.length ? ` — ${due.join('; ')}` : ''}`
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Deep One audit request 2: ERA JUMP — a campaign skips years (M42 → the next
// era) and nothing from the old age should fire, stay armed or read as live.
// The clock moves through the correction path (no regeneration, no elapsed
// note); the era label is written beside it; active plot threads are parked
// with a dated section; unfired scheduled rows are cancelled (stamped, not
// deleted); row-level ability state resets; wall-clock effects expire. One
// report of ids and counts; dryRun computes the same report and writes nothing.
// ═══════════════════════════════════════════════════════════════════════════
const EraJumpSchema = z.object({
    action: z.literal('era_jump'),
    worldId: z.string().describe('World whose clock jumps'),
    day: z.number().describe('The new campaign day'),
    time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("HH:MM at the new day (default: the world's stored time)"),
    label: z.string().min(1).describe("Era label written to environment.era, e.g. 'M42, after the Drowning' — shown at boot, on the status block date line and in clockWarning"),
    threads: z.enum(['dormant', 'archived', 'keep']).optional().default('dormant').describe("What happens to every ACTIVE plot_thread: dormant (default) or archived, each with a '[era: <label>] parked at day N' section appended; keep leaves them active"),
    scheduled: z.enum(['cancel', 'keep']).optional().default('cancel').describe("Unfired scheduled rows for the world: cancel (default; stamps cancelled_at — list_scheduled {includeCancelled} still shows them) or keep"),
    resetAbilities: z.boolean().optional().default(true).describe('Default true: every character in the world gets combat_profile.abilities[].ready = true, legendary actions/resistances remaining back to their maxima, and wall-clock custom_effects (those with expires_at) expired'),
    dryRun: z.boolean().optional().default(false).describe('Compute the full report and write NOTHING')
});

async function handleEraJump(args: z.infer<typeof EraJumpSchema>): Promise<object> {
    const db = getDb();
    const worldRow = db.prepare('SELECT id FROM worlds WHERE id = ?').get(args.worldId);
    if (!worldRow) return { error: true, actionType: 'era_jump', message: `World not found: ${args.worldId}` };
    const prior = readWorldClock(db, args.worldId);
    const now = new Date().toISOString();
    const tryRows = <T>(fn: () => T[]): T[] => { try { return fn(); } catch { return []; } };

    // 2. Active plot threads: title is the first line of the note's head.
    const threadRows = tryRows(() => db.prepare("SELECT id, content FROM narrative_notes WHERE world_id = ? AND type = 'plot_thread' AND status = 'active' ORDER BY updated_at DESC")
        .all(args.worldId) as Array<{ id: string; content: string }>);
    const threadStatus = args.threads === 'keep' ? 'active' : args.threads;
    const threads = threadRows.map(r => ({ id: r.id, title: r.content.trim().split('\n')[0].slice(0, 100), status: threadStatus }));

    // 3. Unfired, uncancelled scheduled rows of this world (own tag or character's).
    const scheduledRows = args.scheduled === 'cancel'
        ? tryRows(() => db.prepare(`SELECT s.id FROM scheduled_state_changes s WHERE ${scheduleLiveSql('s')} AND ${scheduleInWorldSql('s')} ORDER BY s.id`).all(args.worldId, args.worldId) as Array<{ id: number }>)
        : [];
    const scheduledCancelled = scheduledRows.map(r => r.id);

    // 4. Row-level ability state: ready flags in the combat_profile JSON and
    // the legendary *_remaining columns (maxima live in legendary_actions /
    // legendary_resistances). Only rows that actually change are counted.
    type CharRow = { id: string; combat_profile: string | null; legendary_actions: number | null; legendary_actions_remaining: number | null; legendary_resistances: number | null; legendary_resistances_remaining: number | null };
    const resets: Array<{ id: string; profile: string | null }> = [];
    let effectsCleared = 0;
    if (args.resetAbilities) {
        const chars = tryRows(() => db.prepare('SELECT id, combat_profile, legendary_actions, legendary_actions_remaining, legendary_resistances, legendary_resistances_remaining FROM characters WHERE world_id = ?').all(args.worldId) as CharRow[]);
        for (const c of chars) {
            let profile: string | null = null;
            let changed = false;
            if (c.combat_profile) {
                try {
                    const parsed = JSON.parse(c.combat_profile) as { abilities?: Array<{ ready?: boolean }> };
                    if (Array.isArray(parsed.abilities) && parsed.abilities.some(a => a && a.ready === false)) {
                        for (const a of parsed.abilities) if (a) a.ready = true;
                        profile = JSON.stringify(parsed);
                        changed = true;
                    }
                } catch { /* unreadable profile: left alone */ }
            }
            if (c.legendary_actions !== null && c.legendary_actions_remaining !== c.legendary_actions) changed = true;
            if (c.legendary_resistances !== null && c.legendary_resistances_remaining !== c.legendary_resistances) changed = true;
            if (changed) resets.push({ id: c.id, profile });
        }
        try {
            effectsCleared = (db.prepare('SELECT COUNT(*) AS n FROM custom_effects WHERE is_active = 1 AND expires_at IS NOT NULL AND target_id IN (SELECT id FROM characters WHERE world_id = ?)').get(args.worldId) as { n: number }).n;
        } catch { effectsCleared = 0; }
    }

    const toTime = args.time ?? prior?.time;
    const from = { day: prior?.day ?? null, ...(prior?.time ? { time: prior.time } : {}) };
    const report = {
        success: true,
        actionType: 'era_jump',
        worldId: args.worldId,
        dryRun: args.dryRun,
        from,
        to: { day: args.day, ...(toTime ? { time: toTime } : {}), era: args.label },
        threadsAction: args.threads,
        threads,
        scheduledAction: args.scheduled,
        scheduledCancelled,
        abilitiesReset: resets.length,
        effectsCleared
    };
    const summary = `${threads.length} thread(s) ${args.threads === 'keep' ? 'kept active' : `→ ${threadStatus}`}, ${scheduledCancelled.length} scheduled row(s) ${args.scheduled === 'cancel' ? 'cancelled' : 'kept'}, ${resets.length} character(s) reset, ${effectsCleared} wall-clock effect(s) expired`;
    if (args.dryRun) {
        return { ...report, message: `DRY RUN — era '${args.label}' would start at ${dayClock(clockAt({ day: args.day, time: toTime }) ?? args.day)} (from ${prior ? clockLabel(prior) : 'no clock'}): ${summary}. Nothing was written.` };
    }

    // 1. The clock, through the correction path: no regeneration, no elapsed note.
    const clockResult = writeEnvironment(args.worldId, { day: args.day, ...(args.time ? { time: args.time } : {}), era: args.label }, 'era_jump', { correction: true });
    if (clockResult.error) return clockResult;
    // 2. Park the threads with a section stamped at the OLD clock.
    if (threads.length && args.threads !== 'keep') {
        const stamp = prior ? clockLabel(prior) : now.slice(0, 10);
        const section = `\n\n── [${stamp}] ──\n[era: ${args.label}] parked at day ${prior?.day ?? 'unset'}`;
        const park = db.prepare('UPDATE narrative_notes SET status = ?, content = content || ?, updated_at = ? WHERE id = ?');
        for (const t of threads) park.run(threadStatus, section, now, t.id);
    }
    // 3. Cancel the scheduled rows — a stamp, never a DELETE.
    if (scheduledCancelled.length) {
        const cancel = db.prepare('UPDATE scheduled_state_changes SET cancelled_at = ? WHERE id = ?');
        for (const id of scheduledCancelled) cancel.run(now, id);
    }
    // 4. Abilities ready, legendary pools full, wall-clock effects expired.
    if (args.resetAbilities) {
        const resetProfile = db.prepare('UPDATE characters SET combat_profile = ?, legendary_actions_remaining = legendary_actions, legendary_resistances_remaining = legendary_resistances, updated_at = ? WHERE id = ?');
        const resetLegendary = db.prepare('UPDATE characters SET legendary_actions_remaining = legendary_actions, legendary_resistances_remaining = legendary_resistances, updated_at = ? WHERE id = ?');
        for (const r of resets) {
            if (r.profile !== null) resetProfile.run(r.profile, now, r.id);
            else resetLegendary.run(now, r.id);
        }
        if (effectsCleared) {
            try { db.prepare('UPDATE custom_effects SET is_active = 0 WHERE is_active = 1 AND expires_at IS NOT NULL AND target_id IN (SELECT id FROM characters WHERE world_id = ?)').run(args.worldId); } catch { /* counted above; table absent */ }
        }
    }
    const after = readWorldClock(db, args.worldId);
    return {
        ...report,
        ...(clockResult.clockWarning ? { clockWarning: clockResult.clockWarning } : {}),
        message: `Era '${args.label}' begins at ${after ? clockLabel(after) : `Day ${args.day}`} (from ${prior ? clockLabel(prior) : 'no clock'}; no time passed, no regeneration): ${summary}.`
    };
}

// Deep One audit request 4: RECONCILE — sheet drift from fights run in chat.
// Lanes live in ../reconcile.ts (boot reads the same report). Read-only.
// ═══════════════════════════════════════════════════════════════════════════
const ReconcileSchema = z.object({
    action: z.literal('reconcile'),
    worldId: z.string().describe('World whose characters are checked'),
    characterId: z.string().optional().describe('Check one character instead of every character in the world')
});

async function handleReconcile(args: z.infer<typeof ReconcileSchema>): Promise<object> {
    const db = getDb();
    if (!db.prepare('SELECT id FROM worlds WHERE id = ?').get(args.worldId)) return { error: true, actionType: 'reconcile', message: `World not found: ${args.worldId}` };
    const report = reconcileWorld(db, args.worldId, args.characterId);
    const kinds = Object.entries(report.byKind).map(([k, n]) => `${k} ×${n}`).join(', ');
    return {
        success: true,
        actionType: 'reconcile',
        ...report,
        kinds: RECONCILE_KINDS,
        message: report.count === 0
            ? `Reconcile clean — ${args.characterId ? 'the sheet agrees' : 'every sheet agrees'} with inventory, encounters and the precedent ledger.${report.scope === 'all-characters' ? ' (characters carry no world_id on this db — every character was read)' : ''}`
            : `${report.count} finding(s): ${kinds}. Each carries the fix call; fixing is a decision, not an auto-repair.${report.scope === 'all-characters' ? ' (characters carry no world_id on this db — every character was read)' : ''}`
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
    const db = getDb();
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
        () => db.prepare(`SELECT id AS scheduleId, character_id AS characterId, note, fires_at_day AS firesAtDay FROM scheduled_state_changes WHERE ${scheduleLiveSql('')} AND world_id = ? AND character_id NOT IN (SELECT id FROM characters)`).all(W),
        () => db.prepare(`SELECT id AS scheduleId, character_id AS characterId, note, fires_at_day AS firesAtDay FROM scheduled_state_changes WHERE ${scheduleLiveSql('')} AND character_id NOT IN (SELECT id FROM characters)`).all());
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
    // Items 14/15: records stamped later than the clock — a clock that went
    // backwards. Advisory: the rows are right, the clock may not be.
    runW('records dated after the world clock (advisory)',
        () => recordsAfterClock(db, W!),
        () => (db.prepare('SELECT id FROM worlds').all() as Array<{ id: string }>).flatMap(w => recordsAfterClock(db, w.id).map(r => ({ worldId: w.id, ...r }))));
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
    const services = getDomainServices();
    const db = services.db;
    const worldRepo = services.world;
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
    persistGeneratedWorldEntities(db, world.id, generatedWorld);

    // Store in memory for fast access
    worldManager.create(world.id, generatedWorld);
    services.worldSnapshot.save(world.id, generatedWorld);

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
    advance: {
        schema: AdvanceSchema,
        handler: async (args) => handleAdvance(args as z.infer<typeof AdvanceSchema>),
        aliases: ['pass_time', 'tick'],
        description: 'Move the world clock forward by minutes, hours or days (midnight rollover handled); same side effects as update, plus exposure timers ticked, dueNow counts, and fireScheduled: true fires the due scheduled rows'
    },
    era_jump: {
        schema: EraJumpSchema,
        handler: async (args) => handleEraJump(args as z.infer<typeof EraJumpSchema>),
        aliases: ['new_era', 'epoch', 'time_skip'],
        description: "Request 2: skip to a new era — clock moves by the correction path, environment.era = label, active plot threads parked (dormant/archived) with a dated section, unfired scheduled rows cancelled, abilities/legendary pools reset, wall-clock effects expired; dryRun reports without writing"
    },
    reconcile: {
        schema: ReconcileSchema,
        handler: async (args) => handleReconcile(args as z.infer<typeof ReconcileSchema>),
        aliases: ['drift', 'check_sheets'],
        description: 'Request 4: sheet drift — equipped rows with no item, duplicate attack profiles, attack items not held, conditions citing superseded/missing precedents, abilities/legendary pools spent outside combat, unposted XP awards. Read-only; every finding names its fix call'
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
Actions: create, get, list, delete, update (environment), advance (clock), era_jump (new era), audit, reconcile (sheet drift), generate (procedural), get_state, snapshot, restore, list_snapshots
Aliases: new→create, fetch→get, all→list, remove→delete, set→update, gen→generate, state→get_state

🌍 WORLD WORKFLOW:
1. generate - Create procedural world with terrain/biomes
2. get_state - Check world status
3. update - Set time/weather/season; correction:true when fixing a wrong clock (no regeneration, no time_passed)
   advance {worldId, minutes?|hours?|days?, fireScheduled?} - move the clock forward; ticks every exposure timer in the world (character_manage set_exposure; reply exposure: [{characterId, name, pool, from, to, conditionsAdded}]); returns dueNow {scheduled, debts, congregations?}; fireScheduled: true also fires the due scheduled rows (reply fired[]) instead of only counting them
   era_jump {worldId, day, time?, label, threads?: dormant|archived|keep, scheduled?: cancel|keep, resetAbilities?: true, dryRun?} - years pass between campaigns: clock corrected (no regeneration), environment.era = label, active threads parked with a '[era: label]' section, unfired scheduled rows cancelled (stamped; list_scheduled {includeCancelled} shows them), abilities ready and legendary pools full, wall-clock effects expired. Reply: {from, to, threads, scheduledCancelled, abilitiesReset, effectsCleared}; dryRun writes nothing
   reconcile {worldId, characterId?} - after fights run in chat: {findings: [{kind, characterId, characterName, detail, fix}], count}. Kinds: equipped_missing (equipped row with quantity ≤ 0 or no item), attack_duplicate (two profiles share a name), attack_item_missing (profile.item not in inventory), condition_stale_precedent (source/note cites a prec-id that is superseded or missing), ability_spent_outside_combat, legendary_depleted_outside_combat, xp_unposted. Read-only; boot shows 'RECONCILE: n findings' when n > 0
4. For map operations, use world_map tool instead`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        label: z.string().optional().describe('Snapshot label (for snapshot/restore); era_jump: the era label written to environment.era'),
        confirmGlobal: z.boolean().optional().describe('FINDINGS #111 (mirror): restore — accept rolling back OTHER worlds with newer writes; refused without it when collateral exists'),
        id: z.string().optional().describe('World ID'),
        worldId: z.string().optional().describe('World ID (for get_state, audit, era_jump, reconcile)'),
        characterId: z.string().optional().describe('reconcile: check one character instead of the whole world'),
        name: z.string().optional().describe('World name (for create)'),
        seed: z.string().optional().describe('Seed for generation'),
        width: z.number().optional().describe('World width'),
        height: z.number().optional().describe('World height'),
        landRatio: z.number().optional(),
        temperatureOffset: z.number().optional(),
        moistureOffset: z.number().optional(),
        environment: z.any().optional().describe('Environment properties (for update)'),
        correction: z.boolean().optional().describe('update: the clock was wrong, not time passing — no regeneration, no elapsed note; returns correction {from, to, deltaHours}'),
        minutes: z.number().optional().describe('advance: minutes to move the clock forward'),
        hours: z.number().optional().describe('advance: hours to move the clock forward'),
        days: z.number().optional().describe('advance: days to move the clock forward'),
        fireScheduled: z.boolean().optional().describe('advance: fire the due live scheduled rows of the world after the clock moves (reply fired[]); default false, counts only'),
        day: z.number().optional().describe('era_jump: the new campaign day'),
        time: z.string().optional().describe('era_jump: HH:MM at the new day'),
        threads: z.enum(['dormant', 'archived', 'keep']).optional().describe('era_jump: what active plot threads become (default dormant)'),
        scheduled: z.enum(['cancel', 'keep']).optional().describe('era_jump: cancel (default) or keep unfired scheduled rows'),
        resetAbilities: z.boolean().optional().describe('era_jump: reset abilities/legendary pools and expire wall-clock effects (default true)'),
        dryRun: z.boolean().optional().describe('era_jump: compute the report, write nothing')
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
            parsed.suggestions.forEach((s: { value: string; similarity: number }) => {
                output += `  • ${s.value} (${s.similarity}% match)\n`;
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
                if (parsed.correction) output += RichFormatter.alert(`Correction: ${parsed.correction.from ?? '?'} → ${parsed.correction.to ?? '?'} (${parsed.correction.deltaHours ?? '?'}h) — no time passed`, 'info');
                if (parsed.elapsedNote) output += RichFormatter.alert(parsed.elapsedNote, 'info');
                if (parsed.hint) output += RichFormatter.alert(parsed.hint, 'warning');
                if (parsed.clockWarning) output += RichFormatter.alert(parsed.clockWarning, 'warning');
                break;
            case 'advance':
                output = RichFormatter.header('Clock Advanced', '🕰️');
                output += RichFormatter.keyValue({ 'World ID': `\`${parsed.worldId}\``, 'Now': parsed.clock, 'Elapsed': `${parsed.elapsedHours}h` });
                if (parsed.exposure?.length) {
                    output += RichFormatter.section('Exposure');
                    output += RichFormatter.list((parsed.exposure as Array<{ characterId: string; name: string; pool: string; from: number; to: number; conditionsAdded: string[] }>).map(e => `${e.characterId} · ${e.name}: ${e.pool} ${e.from} → ${e.to}${e.conditionsAdded.length ? ` (+${e.conditionsAdded.join(', ')})` : ''}`));
                }
                if (parsed.fired?.length) {
                    output += RichFormatter.section(`Fired (${parsed.fired.length})`);
                    output += RichFormatter.list((parsed.fired as Array<{ scheduleId: number; characterName?: string; note?: string | null; applied?: string[] }>).map(f => `#${f.scheduleId} ${f.characterName ?? ''}${f.note ? `: ${f.note}` : ''} — ${(f.applied ?? []).join('; ')}`));
                }
                if (parsed.message) output += RichFormatter.alert(parsed.message, 'info');
                break;
            case 'era_jump':
                output = RichFormatter.header(parsed.dryRun ? 'Era Jump (dry run)' : 'Era Jump', '⌛');
                output += RichFormatter.keyValue({
                    'World ID': `\`${parsed.worldId}\``,
                    'From': parsed.from?.day !== null && parsed.from?.day !== undefined ? `Day ${parsed.from.day}${parsed.from.time ? `, ${parsed.from.time}` : ''}` : 'no clock',
                    'To': `Day ${parsed.to?.day}${parsed.to?.time ? `, ${parsed.to.time}` : ''} · era ${parsed.to?.era}`,
                    'Threads': `${(parsed.threads ?? []).length} → ${parsed.threadsAction}`,
                    'Scheduled cancelled': (parsed.scheduledCancelled ?? []).length,
                    'Characters reset': parsed.abilitiesReset,
                    'Effects expired': parsed.effectsCleared
                });
                if (parsed.message) output += RichFormatter.alert(parsed.message, parsed.dryRun ? 'warning' : 'info');
                if (parsed.clockWarning) output += RichFormatter.alert(parsed.clockWarning, 'warning');
                break;
            case 'reconcile':
                output = RichFormatter.header('Sheet Reconcile', '🧮');
                output += RichFormatter.keyValue({ 'World ID': `\`${parsed.worldId}\``, ...(parsed.characterId ? { 'Character': `\`${parsed.characterId}\`` } : {}), 'Findings': parsed.count });
                for (const f of (parsed.findings ?? []).slice(0, 12) as ReconcileFinding[]) {
                    output += `• ${reconcileLine(f)}\n  fix: ${f.fix}\n`;
                }
                if ((parsed.findings ?? []).length > 12) output += `… ${parsed.findings.length - 12} more in the JSON\n`;
                if (parsed.message) output += RichFormatter.alert(parsed.message, parsed.count > 0 ? 'warning' : 'info');
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
