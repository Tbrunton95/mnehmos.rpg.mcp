/**
 * Play report 6 #3: the one commit step for a scheduled write list, shared
 * by schedule_change fireNow, the due-row processor (process_scheduled and
 * world_manage advance {fireScheduled}), montage costs and roll-table
 * writes. It writes the sheet row, mirrors linked item charges, replays the
 * part ops onto every live token (a token copies the sheet's parts once, at
 * creation, and the HP sync never re-reads them) and names the encounters
 * reached in the applied line: 'set_part: left arm crippled → intact
 * (sheet; token in <encounterId>)'.
 */
import type { Character } from '../schema/character.js';
import type { Part, VesselProfile } from '../schema/token-extras.js';
import { roleState } from '../engine/combat/vessel.js';
import { setPartOn, removePartFrom } from '../engine/combat/parts.js';
import { scheduledPartWrite, type ScheduledOpsResult, type ScheduledWriteOp, type ScheduledSetPart } from '../engine/scheduled-ops.js';
import { CharacterRepository } from '../storage/repos/character.repo.js';
import { getDb } from '../storage/index.js';
import { patchLiveTokens } from './handlers/combat-handlers.js';
import { mirrorLinkedCharges } from './consolidated/character-manage.js';

export interface ScheduledCommit {
    /** The applied lines; a part line carries the encounters its token write reached. */
    applied: string[];
    /** The sheet row was written. */
    wrote: boolean;
    /** There were updates and the repository returned nothing: the row is gone. Nothing else was done. */
    writeFailed: boolean;
    /** Item instances whose charges followed a pool. */
    linked: ReturnType<typeof mirrorLinkedCharges>;
    /** Encounters whose token took a part op. */
    liveTokens: string[];
}

/**
 * Commit an applyScheduledOps result for a character: sheet row, linked
 * charges, live tokens. A failed row write stops everything after it and
 * is reported, never thrown: the caller decides (fireNow and montage throw).
 */
export function commitScheduledWrites(characterId: string, result: ScheduledOpsResult, opts: { repo?: CharacterRepository } = {}): ScheduledCommit {
    const applied = [...result.applied];
    let wrote = false;
    if (Object.keys(result.updates).length) {
        const repo = opts.repo ?? new CharacterRepository(getDb());
        const written = repo.update(characterId, result.updates as Partial<Character>);
        if (!written) return { applied, wrote: false, writeFailed: true, linked: [], liveTokens: [] };
        wrote = true;
    }
    const linked = result.updates.resourcePools
        ? mirrorLinkedCharges(characterId, result.updates.resourcePools as Parameters<typeof mirrorLinkedCharges>[1])
        : [];
    const liveTokens = new Set<string>();
    for (const { op, line } of result.partOps) {
        const reached = patchLiveTokens(characterId, tok => applyPartOpToToken(tok, op)).patched;
        if (!reached.length) continue;
        for (const id of reached) liveTokens.add(id);
        applied[line] = withTokens(applied[line], op, reached);
    }
    return { applied, wrote, writeFailed: false, linked, liveTokens: [...liveTokens] };
}

/** One part op onto a live token's parts; true when the token changed. */
function applyPartOpToToken(tok: Record<string, unknown>, op: ScheduledWriteOp): boolean {
    const parts = Array.isArray(tok.parts) ? tok.parts as Part[] : [];
    if (op.op === 'remove_part') {
        if (!op.part?.trim()) return false;
        const r = removePartFrom(parts, op.part);
        if (!r.removed) return false;
        tok.parts = r.parts;
    } else if (op.op === 'set_part') {
        if (!op.part?.trim() || !op.state || (op.state as string) === 'latched') return false;
        tok.parts = setPartOn(parts, scheduledPartWrite(op as ScheduledSetPart)).parts;
    } else return false;
    refreshVesselFlags(tok);
    return true;
}

/**
 * The engine's refreshVessel, on a stored token: a dead or breached reactor
 * section sets reactorBreach; a repaired one clears it.
 */
function refreshVesselFlags(tok: Record<string, unknown>): void {
    if (!tok.vessel) return;
    const who = tok as unknown as { vessel?: VesselProfile; parts?: Part[]; name: string };
    if (roleState(who, 'reactor') === 'dead') tok.reactorBreach = true;
    else if (tok.reactorBreach) delete tok.reactorBreach;
}

/** The applied line with the encounters the token write reached. */
function withTokens(line: string, op: ScheduledWriteOp, reached: string[]): string {
    const where = `token in ${reached.join(', ')}`;
    if (/\((sheet|new part on sheet)\)$/.test(line)) return line.replace(/\)$/, `; ${where})`);
    // The sheet never had the part; the token did.
    if (op.op === 'remove_part') return `−part ${op.part} (${where}; not on sheet)`;
    return `${line} (${where})`;
}
