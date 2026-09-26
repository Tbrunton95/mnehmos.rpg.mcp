/**
 * Who stands near whom, for the Waaagh! mechanics: a spell's nearby bonus,
 * a battle cry's reach and mob rule's nearby units. Allies are the living
 * participants on the same side (same isEnemy), not routed, within `range`
 * feet edge to edge on the grid; a unit counts its live models. Tokens
 * without a position are never counted.
 */
import type { CombatParticipant } from './engine.js';
import type { NearbyMatch } from '../../schema/token-extras.js';
import { edgeDistanceSquares } from '../../schema/encounter.js';
import { liveModels } from './units.js';

/** A token's species when the token itself has none (a character sheet's race). */
export type SpeciesOf = (p: CombatParticipant) => string | undefined;

const same = (a: string | undefined | null, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Every key the match gives must hold; an empty match matches everyone. */
export function matchesParticipant(p: CombatParticipant, match: NearbyMatch | undefined, speciesOf?: SpeciesOf): boolean {
    if (!match) return true;
    if (match.band && !same(p.band, match.band)) return false;
    if (match.species && !same(p.species ?? speciesOf?.(p), match.species)) return false;
    if (match.tag && !(p.tags ?? []).some(t => same(t, match.tag!))) return false;
    if (match.nameIncludes && !p.name.toLowerCase().includes(match.nameIncludes.trim().toLowerCase())) return false;
    return true;
}

/** How many a participant counts for: a unit's live models, else 1. */
export function headCount(p: CombatParticipant): number {
    return p.unit ? liveModels(p) : 1;
}

/** Distance in feet, edge to edge, or null when either token is unplaced. */
export function distanceFt(a: CombatParticipant, b: CombatParticipant): number | null {
    if (!a.position || !b.position) return null;
    return edgeDistanceSquares(a, b) * 5;
}

/**
 * The allies of `center` within range that match, and how many they count
 * for (units by live models). The center itself is never counted.
 */
export function nearbyAllies(
    participants: CombatParticipant[],
    center: CombatParticipant,
    opts: { range: number; match?: NearbyMatch; unitsOnly?: boolean },
    speciesOf?: SpeciesOf
): { participants: CombatParticipant[]; count: number } {
    const found = participants.filter(p => {
        if (p.id === center.id) return false;
        if (!!p.isEnemy !== !!center.isEnemy) return false;
        if (p.hp <= 0 || p.isDead) return false;
        if (p.unit?.routed) return false;
        if (opts.unitsOnly && !p.unit) return false;
        const ft = distanceFt(center, p);
        if (ft === null || ft > opts.range) return false;
        return matchesParticipant(p, opts.match, speciesOf);
    });
    return { participants: found, count: found.reduce((n, p) => n + headCount(p), 0) };
}
