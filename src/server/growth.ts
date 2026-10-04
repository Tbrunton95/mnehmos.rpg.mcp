/**
 * Growth tracks (table_rules kind growth_track): kills and victories feed a
 * pool, and crossing a step offers that step's form. The offer is a call to
 * make (character_manage set_form), never applied here: whether a character
 * grows is the player's choice.
 *
 * A step marked auto is the exception, and the reason a track can double as
 * an addiction ladder: crossing it puts the step's condition on the sheet,
 * rolls its table for the character and takes its form, there and then, and
 * the pool remembers the rung ('<track>@<at>' in growthApplied) so it fires
 * once. direction says which way a crossing counts (up by default).
 */
import type Database from 'better-sqlite3';
import { loadRules, findPool, bandOrderFor, type TableRule } from '../engine/table-rules.js';
import { applyScheduledOps, type ScheduledWriteOp } from '../engine/scheduled-ops.js';
import type { DiceRoller } from '../math/logged-d20.js';
import { CharacterRepository } from '../storage/repos/character.repo.js';

export interface GrowthReady {
    track: string;
    pool: string;
    at: number;
    form?: string;
    condition?: { name: string; effect?: string; duration?: number };
    table?: string;
    note?: string;
    /** The call that takes the step, for the player to choose. */
    call: string;
}

/** One auto step that fired on a crossing. */
export interface GrowthApplied {
    track: string;
    pool: string;
    at: number;
    condition?: string;
    /** The roll_table result (table_rules roll shape) when the step names a table. */
    table?: Record<string, unknown>;
    /** The set_form result when the step names a form. */
    form?: Record<string, unknown>;
    note?: string;
    errors?: string[];
}

export interface GrowthOutcome {
    /** The highest non-auto step crossed: offered, never applied. */
    growthReady?: GrowthReady;
    /** Every auto step crossed, applied in order. */
    growthApplied?: GrowthApplied[];
}

export interface GrowthCredit extends GrowthOutcome {
    track: string;
    pool: string;
    delta: number;
    from: number;
    to: number;
    reason: string;
}

export interface GrowthApplyOptions {
    seed?: string;
    roller?: DiceRoller;
    /** Table chain depth used so far; a step's table never nests past 3. */
    depth?: number;
}

type Track = TableRule<'growth_track'>;
type Step = Track['spec']['steps'][number];
type PoolLike = { current: number; growthApplied?: string[] };
type CharLike = { id: string; form?: { name?: string } | null; resourcePools?: Record<string, PoolLike> | null };

const key = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
const rungKey = (track: Track, step: Step) => `${track.name}@${step.at}`;
/** Steps nest tables this deep at most. */
const MAX_DEPTH = 3;

function tracksFor(db: Database.Database, worldId: string | null | undefined, pool?: string): Track[] {
    const all = loadRules(db, worldId, 'growth_track');
    return pool ? all.filter(t => key(t.spec.pool) === key(pool)) : all;
}

/** Whether a move from before to after crosses the step the way the track counts. */
export function crossesStep(step: Pick<Step, 'at'>, direction: 'up' | 'down' | 'both' | undefined, before: number, after: number): 'up' | 'down' | null {
    const dir = direction ?? 'up';
    if ((dir === 'up' || dir === 'both') && before < step.at && step.at <= after) return 'up';
    if ((dir === 'down' || dir === 'both') && before >= step.at && after < step.at) return 'down';
    return null;
}

function callFor(charId: string, worldId: string | null | undefined, step: Step): string {
    if (step.form) return `character_manage set_form {characterId: '${charId}', form: '${step.form}'}`;
    if (step.table) return `table_rules roll {worldId: '${worldId ?? '<world>'}', name: '${step.table}', characterId: '${charId}'}`;
    return `combat_manage add_condition / character_manage update {characterId: '${charId}'}: condition '${step.condition!.name}'`;
}

function offerOf(track: Track, step: Step, pool: string, char: CharLike, worldId: string | null | undefined): GrowthReady {
    return {
        track: track.name, pool, at: step.at,
        ...(step.form ? { form: step.form } : {}),
        ...(step.condition ? { condition: { name: step.condition.name, ...(step.condition.effect ? { effect: step.condition.effect } : {}), ...(step.condition.duration !== undefined ? { duration: step.condition.duration } : {}) } } : {}),
        ...(step.table ? { table: step.table } : {}),
        ...(step.note ? { note: step.note } : {}),
        call: callFor(char.id, worldId, step)
    };
}

/**
 * The highest non-auto step a pool crossed from `before` to `after`, as an
 * offer. None when nothing was crossed, or the character already wears the
 * step's form. Auto steps are applyGrowth's business.
 */
export function growthReadyFor(db: Database.Database, worldId: string | null | undefined, char: CharLike, pool: string, before: number, after: number): GrowthReady | undefined {
    let best: { track: Track; step: Step } | undefined;
    for (const track of tracksFor(db, worldId, pool)) {
        for (const step of track.spec.steps) {
            if (step.auto) continue;
            if (crossesStep(step, track.spec.direction, before, after) && (!best || step.at > best.step.at)) best = { track, step };
        }
    }
    if (!best) return undefined;
    if (best.step.form && char.form?.name && key(char.form.name) === key(best.step.form)) return undefined;
    return offerOf(best.track, best.step, pool, char, worldId);
}

/** The auto steps a move crosses that the pool has not fired yet, in firing order. */
function autoStepsCrossed(db: Database.Database, worldId: string | null | undefined, pool: string, fired: string[], before: number, after: number): Array<{ track: Track; step: Step }> {
    const out: Array<{ track: Track; step: Step }> = [];
    for (const track of tracksFor(db, worldId, pool)) {
        for (const step of track.spec.steps) {
            if (!step.auto || fired.includes(rungKey(track, step))) continue;
            if (crossesStep(step, track.spec.direction, before, after)) out.push({ track, step });
        }
    }
    // Climbing fires the lowest rung first; falling fires the highest first.
    return out.sort((a, b) => after >= before ? a.step.at - b.step.at : b.step.at - a.step.at);
}

/**
 * A pool moved from before to after: fire every auto step it crossed (once
 * each, remembered on the pool) and offer the highest step it did not. The
 * caller has already written the pool; this writes the rungs, conditions,
 * tables and forms the steps carry.
 */
export async function applyGrowth(
    db: Database.Database, worldId: string | null | undefined, characterId: string,
    pool: string, before: number, after: number, opts: GrowthApplyOptions = {}
): Promise<GrowthOutcome> {
    if (before === after) return {};
    const repo = new CharacterRepository(db);
    let char = repo.findById(characterId) as (CharLike & { name: string }) | null;
    if (!char) return {};
    const found = findPool(char.resourcePools, pool);
    const poolKey = found?.key ?? pool;
    const fired = found?.pool.growthApplied ?? [];
    const steps = autoStepsCrossed(db, worldId, poolKey, fired, before, after);
    const applied: GrowthApplied[] = [];
    const depth = opts.depth ?? 0;

    for (const { track, step } of steps) {
        // Remember the rung before anything else, so a step that throws never fires twice.
        const fresh = repo.findById(characterId) as CharLike | null;
        if (!fresh) break;
        const pools = { ...(fresh.resourcePools ?? {}) } as Record<string, PoolLike>;
        const p = pools[poolKey] ?? { current: after, max: Math.max(after, 100) };
        pools[poolKey] = { ...p, growthApplied: [...(p.growthApplied ?? []), rungKey(track, step)] };
        repo.update(characterId, { resourcePools: pools } as never);

        const out: GrowthApplied = { track: track.name, pool: poolKey, at: step.at, ...(step.note ? { note: step.note } : {}) };
        const errors: string[] = [];
        if (step.condition) {
            const c = repo.findById(characterId);
            if (c) {
                const ops: ScheduledWriteOp[] = [{ op: 'add_condition', name: step.condition.name, ...(step.condition.duration !== undefined ? { duration: step.condition.duration } : {}), source: `${track.name} ${step.at}${step.condition.effect ? `: ${step.condition.effect}` : ''}` }];
                const { updates } = applyScheduledOps(c, ops, { defaultSource: track.name, reason: `${track.name}: ${poolKey} reached ${step.at}` });
                if (Object.keys(updates).length) repo.update(characterId, updates as never);
                out.condition = step.condition.name;
            }
        }
        if (step.table) {
            if (depth >= MAX_DEPTH) errors.push(`table '${step.table}' skipped: growth tables nest ${MAX_DEPTH} deep at most`);
            else if (!worldId) errors.push(`table '${step.table}' skipped: no world to read it from`);
            else {
                const { rollAndApply } = await import('./roll-table-apply.js');
                const r = await rollAndApply(db, { worldId, name: step.table, characterId, apply: true, seed: opts.seed, roller: opts.roller, depth: depth + 1, tool: 'growth_track' });
                if (r.error) errors.push(`table '${step.table}': ${String(r.message)}`);
                else out.table = r;
            }
        }
        if (step.form) {
            const { setForm } = await import('./consolidated/character-manage.js');
            const r = setForm({ characterId, form: step.form, worldId: worldId ?? undefined });
            if (r.error) errors.push(`form '${step.form}': ${String(r.message)}`);
            else out.form = { form: r.form, hp: r.hp, maxHp: r.maxHp, ac: r.ac, ...(Array.isArray(r.liveTokens) && r.liveTokens.length ? { liveTokens: r.liveTokens } : {}) };
        }
        if (errors.length) out.errors = errors;
        applied.push(out);
    }

    char = repo.findById(characterId) as (CharLike & { name: string }) | null;
    const ready = char ? growthReadyFor(db, worldId, char, poolKey, before, after) : undefined;
    return { ...(ready ? { growthReady: ready } : {}), ...(applied.length ? { growthApplied: applied } : {}) };
}

/** Offers only, for every pool that rose between two snapshots of a sheet's pools (no auto steps fire). */
export function growthFromPools(
    db: Database.Database, worldId: string | null | undefined, char: CharLike,
    before: Record<string, PoolLike> | null | undefined, after: Record<string, PoolLike> | null | undefined
): GrowthReady[] {
    const out: GrowthReady[] = [];
    for (const [k, p] of Object.entries(after ?? {})) {
        const from = before?.[k]?.current ?? 0;
        const r = growthReadyFor(db, worldId, char, k, from, p.current);
        if (r) out.push(r);
    }
    return out;
}

/** applyGrowth for every pool that moved between two snapshots of a sheet's pools, merged. */
export async function applyGrowthFromPools(
    db: Database.Database, worldId: string | null | undefined, characterId: string,
    before: Record<string, PoolLike> | null | undefined, after: Record<string, PoolLike> | null | undefined,
    opts: GrowthApplyOptions = {}
): Promise<GrowthOutcome & { growthReady?: GrowthReady; readyAll?: GrowthReady[] }> {
    const ready: GrowthReady[] = [];
    const applied: GrowthApplied[] = [];
    for (const [k, p] of Object.entries(after ?? {})) {
        const from = before?.[k]?.current ?? 0;
        if (from === p.current) continue;
        const r = await applyGrowth(db, worldId, characterId, k, from, p.current, opts);
        if (r.growthReady) ready.push(r.growthReady);
        if (r.growthApplied) applied.push(...r.growthApplied);
    }
    return { ...(ready.length ? { growthReady: ready[0], readyAll: ready } : {}), ...(applied.length ? { growthApplied: applied } : {}) };
}

/**
 * Credit a kill or a victory to a character on the world's growth track
 * whose pool the character has. A kill is worth perKill, plus perBandAbove
 * for each band step the victim stands at or above the killer (the same
 * band counts once); a victory is worth perVictory. Written with the reason
 * in the pool's history. Undefined when no track applies or it is worth 0.
 */
export async function creditGrowth(
    db: Database.Database, worldId: string | null | undefined, characterId: string,
    kind: 'kill' | 'victory', opts: { victim?: string; victimBand?: string | null; attackerBand?: string | null } = {}
): Promise<GrowthCredit | undefined> {
    const repo = new CharacterRepository(db);
    const char = repo.findById(characterId);
    if (!char) return undefined;
    const pools = (char.resourcePools ?? {}) as Record<string, PoolLike>;
    for (const track of tracksFor(db, worldId)) {
        const found = findPool(pools, track.spec.pool);
        if (!found) continue;
        let delta = 0;
        if (kind === 'victory') delta = track.spec.perVictory ?? 0;
        else {
            delta = track.spec.perKill ?? 0;
            const per = track.spec.perBandAbove;
            const attackerBand = opts.attackerBand ?? char.band;
            if (per && opts.victimBand && attackerBand) {
                // The ladder that holds both bands: a world may import several.
                const order = bandOrderFor(db, worldId, [opts.victimBand, attackerBand]).map(b => b.toLowerCase());
                const iv = order.indexOf(opts.victimBand.trim().toLowerCase());
                const ia = order.indexOf(attackerBand.trim().toLowerCase());
                if (iv >= 0 && ia >= 0) delta += per * Math.max(0, iv - ia + 1);
            }
        }
        if (!delta) continue;
        const reason = kind === 'kill' ? `kill: ${opts.victim ?? 'a foe'}` : 'victory';
        const from = found.pool.current;
        const { updates } = applyScheduledOps(char, [{ op: 'adjust_pool', pool: found.key, delta }], { reason });
        repo.update(char.id, updates as never);
        const to = ((updates.resourcePools as Record<string, PoolLike>)[found.key]).current;
        const outcome = await applyGrowth(db, worldId, char.id, found.key, from, to);
        return { track: track.name, pool: found.key, delta, from, to, reason, ...outcome };
    }
    return undefined;
}
