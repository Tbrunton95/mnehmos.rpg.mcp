/**
 * Play report 7 #3: a banded world meets a token with no band.
 *
 * The owner's ruling: a token gets its band the moment it is created, not
 * when a player relies on it. An explicit band wins; a sheet, a bestiary
 * creature or a preset passes its own on; with nothing to go on the token
 * takes the world's lowest band and is marked assumed (bandAssumed), and the
 * reply names every assumed token so the GM sees it before play. A named
 * character (a sheet with no band) is never guessed; it is only named.
 * A world can opt in to refusal instead (band spec requireBand: true).
 *
 * The engine never infers a band from HP, CR or size: these are the only
 * sources, with the GM's set_band.
 */
import type Database from 'better-sqlite3';
import { loadRules, type TableRule } from '../table-rules.js';

export interface WorldBandDefault {
    /** The band rule the ladder comes from (the one the fight's bands sit on, else the first by name). */
    rule: string;
    order: string[];
    /** The world's lowest band: what an unbanded ad-hoc token is assumed to be. */
    lowest: string;
    /** band spec requireBand: refuse an unbanded ad-hoc token instead. */
    requireBand: boolean;
    /** The band rule that set requireBand (any of the world's ladders may). */
    requireBandRule?: string;
    /** The world's other enabled band rules, by name (a world may import several ladders). */
    others: string[];
    /** Every enabled ladder (name and order), the chosen one included. */
    ladders: Array<{ name: string; order: string[] }>;
}

/**
 * The ladder new tokens are banded on: the band rule that holds every band
 * the fight already carries (the rule the band checks read for those bands,
 * bandRuleFor), else the world's first enabled band rule by name. In a world
 * with day-366's 'bands' beside orruk-waaagh's 'orruk-bands', an orruk fight's
 * ad-hoc grots are assumed Grot, not Mortal (review: Mortal could never rank
 * against the Boss, and execute refused mid-fight). null when no world
 * resolves or the world has no band rule: nothing is assumed in an unbanded world.
 */
export function worldBandDefault(db: Database.Database, worldId: string | null | undefined, fightBands: Array<string | null | undefined> = []): WorldBandDefault | null {
    if (!worldId) return null;
    let rules: TableRule<'band'>[];
    try { rules = loadRules(db, worldId, 'band'); } catch { return null; }
    const want = [...new Set(fightBands.filter((b): b is string => typeof b === 'string' && !!b.trim()).map(b => b.trim().toLowerCase()))];
    const holds = (r: TableRule<'band'>) => want.every(w => (r.spec.order ?? []).some(o => o.toLowerCase() === w));
    const rule = (want.length ? rules.find(holds) : undefined) ?? rules[0];
    if (!rule?.spec.order?.length) return null;
    return {
        rule: rule.name,
        order: rule.spec.order,
        lowest: rule.spec.order[0],
        requireBand: rules.some(r => (r.spec as { requireBand?: unknown }).requireBand === true),
        requireBandRule: rules.find(r => (r.spec as { requireBand?: unknown }).requireBand === true)?.name,
        others: rules.filter(r => r !== rule).map(r => r.name),
        ladders: rules.map(r => ({ name: r.name, order: r.spec.order ?? [] }))
    };
}

/** A token (or sheet) as the band checks read it. */
export interface BandHolder { id: string; name: string; band?: string | null; bandAssumed?: boolean }

/**
 * Review of play report 7 #3: why two bands do not rank. Either one is unset,
 * or both are set and no one ladder of the world holds both (an orruk Boss
 * against a hound assumed Mortal on day-366's ladder) — the refusals used to
 * call the second "unset" for a token that had a band. move is the token
 * whose band to change (the unset one, else an assumed one, else the
 * target); other is the token whose ladder it should join.
 */
export function bandsUnranked<T extends BandHolder>(rule: string, actor: T, target: T): { move: T; other: T; problem: string } {
    if (!actor.band || !target.band) {
        const move = !actor.band ? actor : target;
        return { move, other: move === actor ? target : actor, problem: `${rule} needs both bands set (unset for ${move.name})` };
    }
    const move = target.bandAssumed || !actor.bandAssumed ? target : actor;
    const shown = (t: BandHolder) => `${t.name} (${t.band}${t.bandAssumed ? ', assumed' : ''})`;
    return { move, other: move === actor ? target : actor, problem: `${rule} needs both bands on one ladder: ${shown(actor)} and ${shown(target)} share no band ladder in this world` };
}

/** ' (band assumed)' when any of these tokens carries an assumed band, else ''. */
export function bandAssumedTag(...tokens: Array<{ bandAssumed?: boolean } | null | undefined>): string {
    return tokens.some(t => t?.bandAssumed) ? ' (band assumed)' : '';
}

/** 'Hound ×3, The Bitch': numbered names ('Hound 1', 'Hound 2') grouped by their base. */
export function groupNames(names: string[]): string {
    const groups = new Map<string, string[]>();
    for (const n of names) {
        const base = n.replace(/\s+\d+$/, '');
        groups.set(base, [...(groups.get(base) ?? []), n]);
    }
    return [...groups.entries()].map(([base, all]) => all.length > 1 ? `${base} ×${all.length}` : all[0]).join(', ');
}

type NewToken = Record<string, unknown> & { id?: unknown; name?: unknown; band?: unknown };
type SheetLookup = (id: string) => { name?: string; band?: string | null } | null | undefined;

export interface BandAssignment {
    /** Tokens given the lowest band, marked assumed. */
    assumed: Array<{ id: string; name: string; band: string }>;
    /** Sheet-backed tokens whose sheet has no band: never assumed, only named. */
    sheetsWithoutBand: Array<{ id: string; name: string }>;
    /**
     * Review: tokens whose band (their own, or their sheet's) is on none of the
     * world's ladders ('Mortel'): the band rules can never rank them, so they
     * are named before play instead of refused mid-fight.
     */
    offLadder: Array<{ id: string; name: string; band: string; sheet?: true }>;
}

const bandOf = (p: NewToken): string | undefined => typeof p.band === 'string' && p.band.trim() ? p.band : undefined;

/**
 * Bands for new tokens, before they are written. A token with a band keeps
 * it; a sheet-backed one takes the sheet's (the caller's hydration already
 * reads it, so only its absence is noted here); anything else takes the
 * lowest band with bandAssumed: true. Mutates the participants in place.
 */
export function assignAssumedBands(participants: NewToken[], def: WorldBandDefault, sheet: SheetLookup): BandAssignment {
    const out: BandAssignment = { assumed: [], sheetsWithoutBand: [], offLadder: [] };
    const onALadder = (band: string) => def.ladders.some(l => l.order.some(o => o.toLowerCase() === band.trim().toLowerCase()));
    for (const p of participants) {
        const id = String(p.id ?? '');
        const own = bandOf(p);
        if (own) {
            if (!onALadder(own)) out.offLadder.push({ id, name: String(p.name ?? id), band: own });
            continue;
        }
        const row = id ? sheet(id) : null;
        if (row) {
            if (!row.band) out.sheetsWithoutBand.push({ id, name: String(p.name ?? row.name ?? id) });
            else if (!onALadder(row.band)) out.offLadder.push({ id, name: String(p.name ?? row.name ?? id), band: row.band, sheet: true });
            continue;
        }
        p.band = def.lowest;
        p.bandAssumed = true;
        out.assumed.push({ id, name: String(p.name ?? id), band: def.lowest });
    }
    return out;
}

/** The ad-hoc tokens with nothing to give them a band (requireBand refuses these). */
export function unbandedAdHoc(participants: NewToken[], sheet: SheetLookup): string[] {
    return participants.filter(p => !bandOf(p) && !(p.id && sheet(String(p.id)))).map(p => String(p.name ?? p.id));
}

/** The bands these tokens already carry: their own, else their sheet's (the ladder an assumption should join). */
export function knownBands(participants: NewToken[], sheet: SheetLookup): string[] {
    return participants.map(p => bandOf(p) ?? (p.id ? sheet(String(p.id))?.band ?? undefined : undefined)).filter((b): b is string => !!b);
}

const ladder = (def: WorldBandDefault) => `${def.rule}: ${def.order.join(' < ')}${def.others.length ? `; the world also has ${def.others.join(', ')}` : ''}`;

/** The set_band call for a token, ready to paste. */
export function setBandCall(encounterId: string, participantId = '<id>', band = '<band>'): string {
    return `combat_manage set_band {encounterId: '${encounterId}', participantId: '${participantId}', band: '${band}'}`;
}

/** The reply lines for an assignment: the assumed tokens by name, and any sheet without a band. */
export function bandAssignmentWarnings(a: BandAssignment, def: WorldBandDefault, encounterId: string): string[] {
    const lines: string[] = [];
    if (a.assumed.length) {
        const n = a.assumed.length;
        lines.push(`${n} token${n === 1 ? ' has' : 's have'} no band; assumed ${def.lowest}: ${groupNames(a.assumed.map(t => t.name))}. Set band if they're stronger: ${setBandCall(encounterId, a.assumed.length === 1 ? a.assumed[0].id : '<id>')} (${ladder(def)}). Execute, called strikes, CONSEQUENCE DUE and the other band rules read the assumed band and print (band assumed)`);
    }
    for (const s of a.sheetsWithoutBand) {
        lines.push(`${s.name} has no band on the sheet (a named character is never assumed): execute, called strikes and cleave refuse and the other band rules skip it until it has one. Set it: character_manage update {characterId: '${s.id}', band: '<band>'}, or for this fight ${setBandCall(encounterId, s.id)} (${ladder(def)})`);
    }
    for (const o of a.offLadder) {
        const all = def.ladders.map(l => `${l.name}: ${l.order.join(' < ')}`).join('; ');
        lines.push(`${o.name}'s band '${o.band}'${o.sheet ? ' (from the sheet)' : ''} is on none of this world's band ladders (${all}): execute, called strikes, cleave and the other band rules cannot rank it. Set it: ${setBandCall(encounterId, o.id)}${o.sheet ? `, or character_manage update {characterId: '${o.id}', band: '<band>'}` : ''}`);
    }
    return lines;
}

/** requireBand: the refusal, naming the tokens and the fix. */
export function requireBandRefusal(names: string[], def: WorldBandDefault, what: string): string {
    return `This world requires a band on every token (band rule '${def.requireBandRule ?? def.rule}' requireBand: true): no band for ${names.join(', ')}. Pass band on each (${ladder(def)}), or a characterId / creature that carries one. ${what}`;
}
