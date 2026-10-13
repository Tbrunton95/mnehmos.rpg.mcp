/**
 * Participant extras: the one place a new token's optional combat fields are
 * defaulted. The caller's value wins, then the character row's, then the
 * creature preset's. Keys nobody set are left off, so a spread never writes
 * `undefined` over anything.
 */
import type { CombatParticipant } from './engine.js';
import type { Part, SizeCategory, Shields, Ability, AbilityInput } from '../../schema/token-extras.js';
import { CREATURE_PRESETS, type CreaturePreset } from '../../data/creature-presets.js';
import { sameName } from './abilities.js';

type ExtrasKey = 'size' | 'reach' | 'movementSpeed' | 'attackBonus' | 'attackDamage' | 'attackDamageType' |
    'attacksPerAction' | 'attacks' | 'abilities' | 'legendaryActions' | 'legendaryResistances' |
    'legendaryResistancesRemaining' | 'autoLegendaryResistance' | 'hasLairActions' | 'cr' |
    'band' | 'regeneration' | 'parts' | 'ac' | 'species' | 'tags' | 'swimSpeed' | 'flySpeed' | 'senses' | 'vessel' | 'shields' | 'fightingStyle' | 'ignoreCover' | 'deathSaves' | 'deathSaveMode';

/** What hydrateExtras hands the token: every ability carries a boolean ready. */
export type ExtrasOutput = Partial<Pick<CombatParticipant, ExtrasKey>>;

/**
 * Fields a caller may pass for a new participant (create, add_participant).
 * Abilities arrive as inputs: `ready` unset means "the sheet decides".
 */
export type ExtrasInput = Omit<ExtrasOutput, 'abilities'> & { abilities?: AbilityInput[] };

/** The character-row fields that default a token (the sheet side of hydrateExtras). */
export type ExtrasRow = ExtrasInput & { parts?: Part[]; speed?: number; resourcePools?: Record<string, { current: number; max: number }> };

const ROW_KEYS = [
    'band', 'regeneration', 'parts', 'ac',
    'size', 'reach', 'movementSpeed', 'swimSpeed', 'flySpeed', 'senses', 'attackBonus', 'attackDamage', 'attackDamageType',
    'attacksPerAction', 'attacks', 'abilities', 'legendaryActions', 'legendaryResistances',
    'legendaryResistancesRemaining', 'autoLegendaryResistance', 'hasLairActions', 'cr',
    'species', 'tags', 'vessel', 'fightingStyle', 'ignoreCover', 'deathSaves', 'deathSaveMode'
] as const;

/** The preset side: CreaturePreset names its fields differently. */
function presetExtras(preset?: CreaturePreset): ExtrasInput {
    if (!preset) return {};
    return {
        ac: preset.ac,
        size: preset.size as SizeCategory | undefined,
        movementSpeed: preset.speed,
        cr: preset.cr,
        attacksPerAction: preset.attacksPerAction,
        attackBonus: preset.defaultAttack?.toHit,
        attackDamage: preset.defaultAttack?.damage,
        attackDamageType: preset.defaultAttack?.damageType
    };
}

/**
 * Item 18: the caller's abilities, with the sheet's spent state carried over.
 * An entry whose `ready` the caller left unset takes `ready: false` from a
 * same-named sheet ability that is spent (a per-rest ability the last fight
 * used), else ready. An explicit ready from the caller is kept as sent.
 */
function mergeAbilities(callers: AbilityInput[], row?: Ability[] | null): Ability[] {
    return callers.map(a => {
        if (a.ready !== undefined) return a as Ability;
        const onSheet = (row ?? []).find(r => sameName(r.name, a.name));
        return { ...a, ready: onSheet?.ready === false ? false : true };
    });
}

/**
 * Default a new participant's extras: caller ?? row ?? preset, per field.
 * Returns only the keys that resolved to a value. Empty parts from the row do
 * not count as set (a sheet with parts: [] gives the token none).
 */
export function hydrateExtras(p: ExtrasInput, row?: ExtrasRow | null, preset?: CreaturePreset): ExtrasOutput {
    const fromPreset = presetExtras(preset);
    const out: Record<string, unknown> = {};
    for (const key of ROW_KEYS) {
        // The sheet stores walking speed as `speed`; the token calls it movementSpeed.
        const rowValue = key === 'movementSpeed' ? (row?.movementSpeed ?? row?.speed) : row?.[key];
        const value = p[key] ?? rowValue ?? (fromPreset as Record<string, unknown>)[key];
        if (value === undefined || value === null) continue;
        if (key === 'parts' && Array.isArray(value) && value.length === 0) continue;
        if (key === 'abilities' && p.abilities) {
            out.abilities = mergeAbilities(p.abilities, row?.abilities as Ability[] | undefined);
            continue;
        }
        out[key] = value;
    }
    // Request 5: a vessel's shields ride its `shields` resource pool, and its
    // speed lives in the vessel profile (the sheet has no speed of its own).
    if (out.vessel) {
        const vessel = out.vessel as { speed?: number };
        const pool = p.shields ?? row?.resourcePools?.shields;
        if (pool && typeof pool.current === 'number' && typeof pool.max === 'number') {
            out.shields = { current: pool.current, max: pool.max } satisfies Shields;
        }
        if (out.movementSpeed === undefined && typeof vessel.speed === 'number') out.movementSpeed = vessel.speed;
    }
    return out as ExtrasOutput;
}

/**
 * Match a participant name to a creature preset ('goblin', 'Goblin Archer',
 * 'goblin 2'). Only used when the caller gave neither ac nor attackDamage, so
 * a hand-built statline is never overridden by a namesake.
 */
export function matchPreset(name: string): CreaturePreset | undefined {
    const lowerName = name.toLowerCase();
    // Exact, then longest prefix ("giant rat" before "giant"), then without a trailing number.
    let key = Object.keys(CREATURE_PRESETS).find(k => k === lowerName);
    if (!key) {
        const keys = Object.keys(CREATURE_PRESETS).sort((a, b) => b.length - a.length);
        key = keys.find(k => lowerName.startsWith(k));
    }
    if (!key) {
        const baseName = lowerName.replace(/ \d+$/, '');
        key = Object.keys(CREATURE_PRESETS).find(k => k === baseName);
    }
    return key ? CREATURE_PRESETS[key] : undefined;
}
