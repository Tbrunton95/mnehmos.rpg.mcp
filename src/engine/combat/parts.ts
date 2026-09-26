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

/** A profile by exact name, then by unique prefix; undefined when neither. */
function matchProfile(profiles: AttackProfile[], name: string): AttackProfile | undefined {
    const key = norm(name);
    const exact = profiles.find(a => norm(a.name) === key);
    if (exact) return exact;
    const prefixed = profiles.filter(a => norm(a.name).startsWith(key));
    return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** The part whose holds names this weapon or slot. */
function holdingPart(who: HasParts, weapon: string): Part | undefined {
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
