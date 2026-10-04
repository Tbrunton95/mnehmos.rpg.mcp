/**
 * Request 5: the void-combat lane. A token whose row carries `vessel` is a
 * ship: its hull is its HP, its sections are `system` parts with a role,
 * its shields a pool drained before the hull. These helpers read section
 * state by role; the engine applies the consequences (speed, refused guns,
 * bridge disadvantage, reactor breach).
 */
import type { Part, VesselProfile, Shields } from '../../schema/token-extras.js';

export type SectionState = 'intact' | 'crippled' | 'dead';

type VesselLike = { vessel?: VesselProfile; parts?: Part[]; shields?: Shields; name: string };

/** The role a part plays: its own role, else the profile's roles[name]. */
export function sectionRole(who: VesselLike, part: Part): string | undefined {
    if (part.role) return part.role.toLowerCase();
    const roles = who.vessel?.roles ?? {};
    const key = Object.keys(roles).find(k => k.toLowerCase() === part.name.toLowerCase());
    return key ? roles[key].toLowerCase() : undefined;
}

/** Every part of a role. */
export function sectionsOfRole(who: VesselLike, role: string): Part[] {
    return (who.parts ?? []).filter(pt => sectionRole(who, pt) === role);
}

/**
 * The worst state among the parts of a role: dead if any is dead or
 * breached, crippled if any is crippled, else intact. A role with no
 * section is intact (the vessel has no such system to lose).
 */
export function roleState(who: VesselLike, role: string): SectionState {
    const parts = sectionsOfRole(who, role);
    if (parts.some(pt => pt.state === 'dead' || pt.state === 'breached')) return 'dead';
    if (parts.some(pt => pt.state === 'crippled')) return 'crippled';
    return 'intact';
}

/**
 * Drain the shields before the hull. Returns what the shields took and what
 * reaches the hull. No shields, or none left, passes the damage through.
 */
export function absorbWithShields(who: VesselLike, damage: number): { absorbed: number; through: number } {
    if (!who.shields || who.shields.current <= 0 || damage <= 0) return { absorbed: 0, through: damage };
    const absorbed = Math.min(who.shields.current, damage);
    who.shields.current -= absorbed;
    return { absorbed, through: damage - absorbed };
}

/** `shields 40/60` */
export function describeShields(shields: Shields | undefined): string {
    return shields ? `shields ${shields.current}/${shields.max}` : 'no shields';
}

/** The vessel's section readout for a status line: `drive crippled, reactor DEAD`. */
export function describeSections(who: VesselLike): string {
    return (who.parts ?? [])
        .filter(pt => sectionRole(who, pt) !== undefined && pt.state !== 'intact')
        .map(pt => `${pt.name} (${sectionRole(who, pt)}) ${pt.state === 'dead' ? 'DEAD' : pt.state}`)
        .join(', ');
}
