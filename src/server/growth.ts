/**
 * Growth tracks (table_rules kind growth_track): kills and victories feed a
 * pool, and crossing a step offers that step's form. The offer is a call to
 * make (character_manage set_form), never applied here: whether a character
 * grows is the player's choice.
 */
import type Database from 'better-sqlite3';
import { loadRules, findPool, bandOrder, type TableRule } from '../engine/table-rules.js';
import { applyScheduledOps } from '../engine/scheduled-ops.js';
import { CharacterRepository } from '../storage/repos/character.repo.js';

export interface GrowthReady {
    track: string;
    pool: string;
    at: number;
    form: string;
    note?: string;
    /** The call that takes the form, for the player to choose. */
    call: string;
}

export interface GrowthCredit {
    track: string;
    pool: string;
    delta: number;
    from: number;
    to: number;
    reason: string;
    growthReady?: GrowthReady;
}

type Track = TableRule<'growth_track'>;
type PoolLike = { current: number };
type CharLike = { id: string; form?: { name?: string } | null; resourcePools?: Record<string, PoolLike> | null };

const key = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

function tracksFor(db: Database.Database, worldId: string | null | undefined, pool?: string): Track[] {
    const all = loadRules(db, worldId, 'growth_track');
    return pool ? all.filter(t => key(t.spec.pool) === key(pool)) : all;
}

/**
 * The highest step a pool crossed going up from `before` to `after`, as an
 * offer. None when nothing was crossed, or the character already wears it.
 */
export function growthReadyFor(db: Database.Database, worldId: string | null | undefined, char: CharLike, pool: string, before: number, after: number): GrowthReady | undefined {
    if (!(after > before)) return undefined;
    let best: { track: Track; step: Track['spec']['steps'][number] } | undefined;
    for (const track of tracksFor(db, worldId, pool)) {
        for (const step of track.spec.steps) {
            if (before < step.at && step.at <= after && (!best || step.at > best.step.at)) best = { track, step };
        }
    }
    if (!best) return undefined;
    if (char.form?.name && key(char.form.name) === key(best.step.form)) return undefined;
    return {
        track: best.track.name, pool, at: best.step.at, form: best.step.form,
        ...(best.step.note ? { note: best.step.note } : {}),
        call: `character_manage set_form {characterId: '${char.id}', form: '${best.step.form}'}`
    };
}

/** Offers for every pool that rose between two snapshots of a sheet's pools. */
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

/**
 * Credit a kill or a victory to a character on the world's growth track
 * whose pool the character has. A kill is worth perKill, plus perBandAbove
 * for each band step the victim stands at or above the killer (the same
 * band counts once); a victory is worth perVictory. Written with the reason
 * in the pool's history. Undefined when no track applies or it is worth 0.
 */
export function creditGrowth(
    db: Database.Database, worldId: string | null | undefined, characterId: string,
    kind: 'kill' | 'victory', opts: { victim?: string; victimBand?: string | null; attackerBand?: string | null } = {}
): GrowthCredit | undefined {
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
                const order = bandOrder(db, worldId).map(b => b.toLowerCase());
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
        const ready = growthReadyFor(db, worldId, char as CharLike, found.key, from, to);
        return { track: track.name, pool: found.key, delta, from, to, reason, ...(ready ? { growthReady: ready } : {}) };
    }
    return undefined;
}
