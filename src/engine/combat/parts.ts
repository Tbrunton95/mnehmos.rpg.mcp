/**
 * Named parts and attack profiles: lookup, merge-on-write, and which profile
 * and part an attack comes from.
 */
import type { Part, AttackProfile } from '../../schema/token-extras.js';

type HasParts = { parts?: Part[] };
type HasProfiles = HasParts & { attacks?: AttackProfile[] };

const norm = (s: string) => s.trim().toLowerCase();
const singular = (s: string) => (s.length > 1 && s.endsWith('s') ? s.slice(0, -1) : s);

/**
 * A part by name, case-insensitive. A trailing 's' on either side matches
 * the singular ('wing' finds 'wings', 'left arms' finds 'left arm').
 */
export function findPart(who: HasParts, name: string): Part | undefined {
    const parts = who.parts ?? [];
    const key = norm(name);
    return parts.find(p => norm(p.name) === key)
        ?? parts.find(p => singular(norm(p.name)) === singular(key));
}

/**
 * Write a part by name, merging into the existing one: its name and every
 * field the update does not mention survive (holds, ac, latchedTo). A key
 * passed as undefined clears that field. Returns a new array.
 */
export function upsertPart(parts: Part[], next: Partial<Part> & { name: string }): Part[] {
    const out = [...parts];
    const idx = out.findIndex(p => norm(p.name) === norm(next.name));
    const merged: Record<string, unknown> = idx >= 0 ? { ...out[idx], ...next, name: out[idx].name } : { kind: 'other', state: 'intact', ...next };
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    if (idx >= 0) out[idx] = merged as Part; else out.push(merged as Part);
    return out;
}

/**
 * The fields a set_part write carries: the shape combat_manage set_part and
 * the scheduled grammar's set_part op share.
 */
export interface PartWrite {
    part: string;
    state: Part['state'];
    kind?: Part['kind'];
    latchedTo?: Part['latchedTo'];
    note?: string;
    holds?: string[];
    ac?: number;
    hp?: number;
    maxHp?: number;
    breakAt?: number;
}

/**
 * Play report 6 #3: set a part by name with the token handler's merge rules,
 * pure, so a clock, a montage cost or a table entry writes a part the way
 * set_part does and the same write replays onto live tokens. kind defaults
 * to the part's current kind, else other; latchedTo is kept only while
 * latched (the write's, else the previous hold); maxHp defaults to
 * max(1, hp) the first time hp is set; every other field given replaces and
 * every field left out survives. Names match trimmed, case-insensitive (no
 * singular/plural). Returns a new array, the part as it was and as it is.
 */
export function setPartOn(parts: Part[], write: PartWrite): { parts: Part[]; prev?: Part; next: Part } {
    const key = norm(write.part);
    const prev = parts.find(p => norm(p.name) === key);
    const out = upsertPart(parts, {
        name: prev ? prev.name : write.part.trim(),
        kind: write.kind ?? prev?.kind ?? 'other',
        state: write.state,
        latchedTo: write.state === 'latched' ? (write.latchedTo ?? prev?.latchedTo) : undefined,
        ...(write.note !== undefined ? { note: write.note } : {}),
        ...(write.holds !== undefined ? { holds: write.holds } : {}),
        ...(write.ac !== undefined ? { ac: write.ac } : {}),
        ...(write.hp !== undefined ? { hp: write.hp } : {}),
        ...(write.maxHp !== undefined ? { maxHp: write.maxHp }
            : write.hp !== undefined && prev?.maxHp === undefined ? { maxHp: Math.max(1, write.hp) } : {}),
        ...(write.breakAt !== undefined ? { breakAt: write.breakAt } : {})
    });
    const next = out.find(p => norm(p.name) === key)!;
    return { parts: out, ...(prev ? { prev } : {}), next };
}

/**
 * Remove a part by trimmed, case-insensitive name. Returns a new array and
 * the part removed; no `removed` when the name is not there.
 */
export function removePartFrom(parts: Part[], name: string): { parts: Part[]; removed?: Part } {
    const key = norm(name);
    const removed = parts.find(p => norm(p.name) === key);
    return { parts: removed ? parts.filter(p => p !== removed) : [...parts], ...(removed ? { removed } : {}) };
}

/** A profile by exact name, then by unique prefix; undefined when neither. */
export function matchProfile(profiles: AttackProfile[], name: string): AttackProfile | undefined {
    const key = norm(name);
    const exact = profiles.find(a => norm(a.name) === key);
    if (exact) return exact;
    const prefixed = profiles.filter(a => norm(a.name).startsWith(key));
    return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** The part whose holds names this weapon or slot. */
export function holdingPart(who: HasParts, weapon: string): Part | undefined {
    const key = norm(weapon);
    return (who.parts ?? []).find(p => p.holds?.some(h => norm(h) === key));
}

export interface AttackSource {
    profile?: AttackProfile;
    part?: Part;
    notes: string[];
}

/**
 * Which profile and part an attack comes from:
 * 1. using (or its alias weapon) names a profile, exactly or by unique prefix;
 *    a miss against a creature with profiles throws, listing them.
 * 2. withPart names a part (it wins over the profile's own part).
 * 3. withPart may instead name a profile.
 * 4. Otherwise the profile's part, or the part whose holds names the
 *    weapon (or hand, or the profile).
 * A weapon nobody holds is not an error: no part applies, and a note says so.
 */
export function resolveAttackSource(
    actor: HasProfiles,
    opts: { using?: string; weapon?: string; withPart?: string; hand?: string }
): AttackSource {
    const notes: string[] = [];
    const profiles = actor.attacks ?? [];
    const named = opts.using ?? opts.weapon;
    let profile: AttackProfile | undefined;
    let part: Part | undefined;

    if (named) {
        profile = matchProfile(profiles, named);
        const heldBy = profile ? undefined : holdingPart(actor, named);
        if (!profile && !heldBy && (profiles.length > 0 || opts.using)) {
            const list = profiles.length ? profiles.map(a => a.name).join(', ') : 'none';
            throw new Error(`No attack profile '${named}' (profiles: ${list})`);
        }
        if (heldBy) part = heldBy;
    }

    if (opts.withPart) {
        const byName = findPart(actor, opts.withPart);
        if (byName) part = byName;
        else if (!profile) {
            profile = matchProfile(profiles, opts.withPart);
            if (!profile) notes.push(`${opts.withPart}: no such part`);
        }
    }

    if (!part && profile?.part) {
        part = findPart(actor, profile.part);
        if (!part) notes.push(`${profile.name}: part '${profile.part}' is not declared on the token`);
    }
    if (!part) {
        const held = opts.weapon ?? opts.hand ?? profile?.name;
        if (held) {
            part = holdingPart(actor, held);
            if (!part && !profile && named) notes.push(`no part holds ${held}; no part penalty applies`);
        }
    }

    return { ...(profile ? { profile } : {}), ...(part ? { part } : {}), notes };
}
