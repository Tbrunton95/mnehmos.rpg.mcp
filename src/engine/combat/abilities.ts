/**
 * Limited abilities on tokens and sheets: lookup by name, the ready flag,
 * which ready ability grants an action (Action Surge), and the mirror of one
 * ability's ready flag onto the character row. Shared by combat_manage
 * use_ability, the combat_action attack/grapple {actionSurge} shorthand,
 * character_manage spend_ability / restore_ability and the rest helpers.
 */
import type Database from 'better-sqlite3';
import type { Ability } from '../../schema/token-extras.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';

/** Case- and whitespace-insensitive name equality. */
export const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The ability of this name (any case), or undefined. */
export function findAbility<T extends { name: string }>(abilities: T[] | undefined, name: string): T | undefined {
    return (abilities ?? []).find(a => sameName(a.name, name));
}

/** Set one ability's ready flag in place. True when the ability was found. */
export function setAbilityReady(abilities: Ability[] | undefined, name: string, ready: boolean): boolean {
    const ability = findAbility(abilities, name);
    if (!ability) return false;
    ability.ready = ready;
    return true;
}

/** Does a rest of this kind ready a perRest ability of that policy? short rests ready short; long rests ready both. */
export function restReadies(perRest: 'short' | 'long' | undefined, kind: 'short' | 'long'): boolean {
    if (!perRest) return false;
    return kind === 'long' || perRest === 'short';
}

/**
 * Ready every spent perRest ability a rest of this kind brings back, in
 * place. Returns the names readied, in sheet order. Recharge-only and
 * grantsAction-only abilities (no perRest) are never touched: the fight's
 * d6 or restore_ability handle those.
 */
export function restoreByRest(abilities: Ability[] | undefined, kind: 'short' | 'long'): string[] {
    const readied: string[] = [];
    for (const a of abilities ?? []) {
        if (a.ready === false && restReadies(a.perRest, kind)) {
            a.ready = true;
            readied.push(a.name);
        }
    }
    return readied;
}

/** The spend message for a perRest ability: what brings it back. */
export function perRestSpentNote(ability: { name: string; perRest?: 'short' | 'long' }): string {
    return `${ability.name} is spent until a ${ability.perRest} rest (rest_manage ${ability.perRest}, or character_manage restore_ability)`;
}

/**
 * The ready action-granting ability a shorthand spends: `true` takes the
 * first ready grantsAction ability; a string names one. The problem text
 * tells the GM what is missing.
 */
export function findActionGrant(abilities: Ability[] | undefined, want: true | string): { ability: Ability } | { problem: string } {
    const list = abilities ?? [];
    if (want === true) {
        const grants = list.filter(a => a.grantsAction === true);
        const ready = grants.find(a => a.ready !== false);
        if (ready) return { ability: ready };
        if (grants.length) return { problem: `${grants.map(a => a.name).join(', ')} ${grants.length === 1 ? 'is' : 'are'} spent (character_manage restore_ability or a rest readies it)` };
        return { problem: "no ready action-granting ability; give it abilities: [{name: 'Action Surge', grantsAction: true}]" };
    }
    const named = findAbility(list, want);
    if (!named) {
        const known = list.map(a => a.name);
        return { problem: `no ability '${want}'${known.length ? `; it has ${known.join(', ')}` : ''}` };
    }
    if (named.grantsAction !== true) return { problem: `${named.name} grants no action (set grantsAction: true on it)` };
    if (named.ready === false) return { problem: `${named.name} is spent (character_manage restore_ability or a rest readies it)` };
    return { ability: named };
}

/**
 * The action grant a shorthand spends, the token first and then the sheet.
 * A sheet ability whose name the token also carries is never read: in a
 * fight the token's copy is the live truth (a recharge surge spent on the
 * token leaves the sheet copy ready for the next fight, not for this turn).
 * A sheet ability the token lacks is a second source and is spent there.
 */
export function findActionGrantAcross(
    tokenAbilities: Ability[] | undefined,
    sheetAbilities: Ability[] | undefined,
    want: true | string
): { ability: Ability; onToken: boolean } | { problem: string } {
    const onToken = findActionGrant(tokenAbilities, want);
    if (!('problem' in onToken)) return { ability: onToken.ability, onToken: true };
    const sheetOnly = (sheetAbilities ?? []).filter(a => !findAbility(tokenAbilities, a.name));
    const fromRow = findActionGrant(sheetOnly, want);
    if (!('problem' in fromRow)) return { ability: fromRow.ability, onToken: false };
    // Neither: the token's verdict when it carries the ability (or any grant,
    // for `true`); otherwise name everything known on both.
    const tokenKnowsIt = want === true
        ? (tokenAbilities ?? []).some(a => a.grantsAction === true)
        : !!findAbility(tokenAbilities, want);
    if (tokenKnowsIt) return onToken;
    const across = findActionGrant([...(tokenAbilities ?? []), ...sheetOnly], want);
    return 'problem' in across ? across : fromRow;
}

/**
 * Mirror one ability's ready flag onto the character row's abilities (the
 * combat_profile column). {found: false} when there is no row or the row
 * has no such ability; nothing is written then.
 */
export function patchRowAbility(db: Database.Database, characterId: string, name: string, ready: boolean): { found: boolean } {
    const repo = new CharacterRepository(db);
    const row = repo.findById(characterId);
    if (!row) return { found: false };
    const abilities = (row.abilities ?? []).map(a => ({ ...a }));
    if (!setAbilityReady(abilities, name, ready)) return { found: false };
    repo.update(characterId, { abilities } as never);
    return { found: true };
}
