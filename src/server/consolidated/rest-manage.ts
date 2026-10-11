/**
 * Consolidated Rest Management Tool
 *
 * Replaces 2 individual rest tools with a single action-based tool:
 * - take_long_rest -> action: 'long'
 * - take_short_rest -> action: 'short'
 *
 * Item 18 (play report 2): a rest also refills every resource pool whose
 * `refresh` policy it satisfies, readies the sheet's perRest abilities, and
 * (long) gives a legendary creature its resistances back. The in-combat
 * guard reads active encounter rows: the in-memory combat manager is evicted
 * per call in production and never saw a fight.
 */

import { z } from 'zod';
import { SessionContext } from '../types.js';
import { getDb } from '../../storage/index.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { restoreAllSpellSlots, restorePactSlots, getSpellcastingConfig } from '../../engine/magic/spell-validator.js';
import { castingClassFor, findWorldRule, resolveWorldId } from '../../engine/table-rules.js';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { findOpen5eClass } from '../../content/open5e-catalog.js';
import { CLASS_DATA } from '../../data/class-starting-data.js';
import { loggedRoll } from '../../math/logged-d20.js';
import { pushPoolHistory } from '../../engine/scheduled-ops.js';
import { restoreByRest } from '../../engine/combat/abilities.js';
import { liveEncountersFor } from '../reconcile.js';
import { mirrorLinkedCharges } from './character-manage.js';
import type { Ability } from '../../schema/token-extras.js';
import type { ResourcePool } from '../../schema/character.js';
import type Database from 'better-sqlite3';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['long', 'short'] as const;
type RestAction = typeof ACTIONS[number];
export type RestKind = 'short' | 'long';

/** The Operator's attention meter refills on a long rest even without a policy of its own (perception_manage says so). */
const LONG_BY_DEFAULT = new Set(['attentional_capacity']);

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb() {
    const db = getDb();
    return {
        characterRepo: new CharacterRepository(db)
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function getAbilityModifier(score: number): number {
    return Math.floor((score - 10) / 2);
}

/** One hit die for the character: crypto dice, logged to roll_log as 'hit_dice'. */
function rollHitDie(sides: number, characterId: string): number {
    return loggedRoll(getDb(), { purpose: 'hit_dice', forId: characterId }, `1d${sides}`, { tool: 'rest_manage' }).total;
}

// The same lookup character creation uses; custom classes fall back to d8.
function getHitDieSize(characterClass: string | undefined, characterId?: string): number {
    const className = characterClass || 'Adventurer';
    // Item 8: a world class (table_rules char_class) names its own hit die.
    if (characterId) {
        const db = getDb();
        const world = findWorldRule(db, resolveWorldId(db, { characterIds: [characterId] }), 'char_class', className);
        if (world) return world.spec.hitDie;
    }
    const classData = CLASS_DATA[className.trim().toLowerCase().replace(/^srd[-_:]/, '')];
    return findOpen5eClass(className)?.hitDie
        ?? Number.parseInt(classData?.hitDice.replace('d', '') ?? '8', 10);
}

type Pools = Record<string, ResourcePool>;

// Hit dice live in resourcePools.hit_dice, one die per level. A character
// that has never rested starts with all of them.
function hitDicePool(character: { level: number; resourcePools?: Pools }): { current: number; max: number } {
    const pool = character.resourcePools?.hit_dice;
    const max = Math.max(1, character.level);
    if (!pool) return { current: max, max };
    return { current: Math.min(Math.max(0, pool.current), max), max };
}

/** Rebuild hit_dice with a new count, keeping its label, note, show and history. */
function withHitDice(pools: Pools, current: number, max: number): Pools {
    return { ...pools, hit_dice: { ...(pools.hit_dice ?? {}), current, max } };
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED REST RULES (rest_manage and travel_manage rest)
// ═══════════════════════════════════════════════════════════════════════════

export type Refilled =
    | { kind: 'pool'; name: string; from: number; to: number; max: number }
    | { kind: 'ability'; name: string };

export interface RestRefresh {
    /** Every pool, copied, with the refilled ones at max (hit_dice untouched: the callers own it). */
    pools: Pools;
    /** The sheet's abilities, copied, with perRest ones readied; undefined when the sheet has none. */
    abilities: Ability[] | undefined;
    /** What changed, in order: pools first, then abilities. */
    refilled: Refilled[];
    /** The refilled pools that mirror onto an item instance (mirrorLinkedCharges takes them). */
    linkedPools: Pools;
    /** Long rest: a legendary creature's resistances back to the full count. */
    legendaryResistancesRestored?: { from: number; to: number };
}

/**
 * Pure: what a rest of this kind refreshes on a sheet. A pool with
 * refresh 'short' refills on either rest, 'long' on a long rest only;
 * 'none' or unset is never touched (attentional_capacity reads as long).
 * A pool already at max is left alone, so histories stay clean. perRest
 * abilities with ready:false are readied by the same rule.
 */
export function refreshForRest(
    char: { resourcePools?: Pools | null; abilities?: Ability[] | null; legendaryResistances?: number | null; legendaryResistancesRemaining?: number | null },
    kind: RestKind,
    now: string = new Date().toISOString()
): RestRefresh {
    const pools: Pools = {};
    const refilled: Refilled[] = [];
    const linkedPools: Pools = {};
    for (const [key, pool] of Object.entries(char.resourcePools ?? {})) {
        if (!pool) continue;
        const copy: ResourcePool = { ...pool };
        pools[key] = copy;
        if (key === 'hit_dice') continue;
        const policy = pool.refresh ?? (LONG_BY_DEFAULT.has(key.toLowerCase()) ? 'long' : undefined);
        const refills = policy === 'short' || (policy === 'long' && kind === 'long');
        if (!refills || !(pool.current < pool.max)) continue;
        const from = pool.current;
        copy.current = pool.max;
        copy.lastRefilledAt = now;
        pushPoolHistory(copy as ResourcePool & { history?: unknown[] }, { from, to: pool.max, reason: `${kind} rest` });
        refilled.push({ kind: 'pool', name: key, from, to: pool.max, max: pool.max });
        if (copy.itemInstanceId) linkedPools[key] = copy;
    }
    let abilities: Ability[] | undefined;
    if (char.abilities?.length) {
        abilities = char.abilities.map(a => ({ ...a }));
        for (const name of restoreByRest(abilities, kind)) refilled.push({ kind: 'ability', name });
    }
    const out: RestRefresh = { pools, abilities, refilled, linkedPools };
    const lr = char.legendaryResistances, lrr = char.legendaryResistancesRemaining;
    if (kind === 'long' && typeof lr === 'number' && typeof lrr === 'number' && lrr < lr) {
        out.legendaryResistancesRestored = { from: lrr, to: lr };
    }
    return out;
}

/** A reply line for what a rest brought back; empty when nothing did. */
export function describeRefilled(r: RestRefresh): string {
    const parts: string[] = [];
    const pools = r.refilled.filter((x): x is Extract<Refilled, { kind: 'pool' }> => x.kind === 'pool');
    const abilities = r.refilled.filter((x): x is Extract<Refilled, { kind: 'ability' }> => x.kind === 'ability');
    if (pools.length) parts.push(pools.map(p => `${p.name} ${p.from} → ${p.to}`).join(', '));
    if (abilities.length) parts.push(`${abilities.map(a => a.name).join(', ')} ready`);
    if (r.legendaryResistancesRestored) parts.push(`legendary resistances ${r.legendaryResistancesRestored.from} → ${r.legendaryResistancesRestored.to}`);
    return parts.join('; ');
}

type SlotCharacter = Parameters<typeof restoreAllSpellSlots>[0];

export interface SlotRestore {
    updates: Record<string, unknown>;
    spellSlotsRestored?: { type: string; slotsRestored?: number; slotLevel?: number; level1?: number; level2?: number; level3?: number; level4?: number; level5?: number };
    pactSlotsRestored?: { slotsRestored: number; slotLevel: number };
}

/**
 * The spell-slot side of a rest (item 8: a world class's casting.as table):
 * a long rest restores every slot and clears concentration; a short rest
 * restores pact magic only. Shared by rest_manage and travel_manage rest.
 */
export function restoreSlotsForRest(db: Database.Database, character: SlotCharacter, kind: RestKind): SlotRestore {
    const charClass = castingClassFor(db, character as never) || 'fighter';
    const spellConfig = getSpellcastingConfig(charClass);
    const out: SlotRestore = { updates: {} };
    if (!spellConfig.canCast || character.level < spellConfig.startLevel) return out;
    if (kind === 'long') {
        const restoredChar = restoreAllSpellSlots({ ...character, characterClass: charClass });
        if (spellConfig.pactMagic) {
            out.spellSlotsRestored = {
                type: 'pactMagic',
                slotsRestored: restoredChar.pactMagicSlots?.max || 0,
                slotLevel: restoredChar.pactMagicSlots?.slotLevel || 0
            };
            out.updates.pactMagicSlots = restoredChar.pactMagicSlots;
        } else if (restoredChar.spellSlots) {
            out.spellSlotsRestored = {
                type: 'standard',
                level1: restoredChar.spellSlots.level1.max,
                level2: restoredChar.spellSlots.level2.max,
                level3: restoredChar.spellSlots.level3.max,
                level4: restoredChar.spellSlots.level4.max,
                level5: restoredChar.spellSlots.level5.max
            };
            out.updates.spellSlots = restoredChar.spellSlots;
        }
        out.updates.concentratingOn = null;
        out.updates.activeSpells = [];
    } else if (spellConfig.pactMagic) {
        const restoredChar = restorePactSlots({ ...character, characterClass: charClass });
        out.pactSlotsRestored = {
            slotsRestored: restoredChar.pactMagicSlots?.max || 0,
            slotLevel: restoredChar.pactMagicSlots?.slotLevel || 0
        };
        out.updates.pactMagicSlots = restoredChar.pactMagicSlots;
    }
    return out;
}

/** Push every refilled linked pool onto its item instance (the pool is the truth). */
export function mirrorLinkedForRest(characterId: string, r: RestRefresh): ReturnType<typeof mirrorLinkedCharges> {
    return Object.keys(r.linkedPools).length ? mirrorLinkedCharges(characterId, r.linkedPools) : [];
}

/** The refusal a rest in an active encounter gets (writes: 'none'). */
export function restInCombatRefusal(name: string, encounterIds: string[]): string {
    return `Cannot rest while in combat: ${name} is a token in active encounter ${encounterIds.join(', ')}. End it first with combat_manage end {encounterId: '${encounterIds[0]}'}.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const LongRestSchema = z.object({
    action: z.literal('long'),
    characterId: z.string().describe('Character taking the rest')
});

const ShortRestSchema = z.object({
    action: z.literal('short'),
    characterId: z.string().describe('Character taking the rest'),
    hitDiceToSpend: z.number().int().min(0).max(20).default(1)
        .describe('Hit dice to spend for healing (default: 1)')
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleLongRest(args: z.infer<typeof LongRestSchema>, _ctx?: SessionContext): Promise<object> {
    const { characterRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        throw new Error(`Character ${args.characterId} not found`);
    }

    // Combat validation reads the database (item 18).
    const live = liveEncountersFor(getDb(), character.id);
    if (live.length) return { error: true, actionType: 'long', message: restInCombatRefusal(character.name, live), writes: 'none' };

    const hpRestored = character.maxHp - character.hp;
    const newHp = character.maxHp;

    // Pools by policy, perRest abilities and legendary resistances first;
    // then a long rest regains half the character's hit dice (minimum one).
    const refresh = refreshForRest(character, 'long');
    const dice = hitDicePool(character as { level: number; resourcePools?: Pools });
    const hitDiceRegained = Math.min(dice.max - dice.current, Math.max(1, Math.floor(dice.max / 2)));
    const pools = withHitDice(refresh.pools, dice.current + hitDiceRegained, dice.max);

    const slots = restoreSlotsForRest(getDb(), character, 'long');
    const updatedChar: Record<string, unknown> = {
        hp: newHp, resourcePools: pools,
        ...(refresh.abilities ? { abilities: refresh.abilities } : {}),
        ...(refresh.legendaryResistancesRestored ? { legendaryResistancesRemaining: refresh.legendaryResistancesRestored.to } : {}),
        ...slots.updates
    };

    characterRepo.update(args.characterId, updatedChar as never);
    const linkedItems = mirrorLinkedForRest(character.id, refresh);
    const refilledLine = describeRefilled(refresh);

    return {
        message: `${character.name} completes a long rest.${refilledLine ? ` Refreshed: ${refilledLine}.` : ''}`,
        character: character.name,
        previousHp: character.hp,
        newHp,
        maxHp: character.maxHp,
        hpRestored,
        restType: 'long',
        hitDiceRegained,
        hitDiceRemaining: dice.current + hitDiceRegained,
        spellSlotsRestored: slots.spellSlotsRestored,
        refilled: refresh.refilled,
        ...(linkedItems.length ? { linkedItems } : {}),
        ...(refresh.legendaryResistancesRestored ? { legendaryResistancesRestored: refresh.legendaryResistancesRestored } : {})
    };
}

async function handleShortRest(args: z.infer<typeof ShortRestSchema>, _ctx?: SessionContext): Promise<object> {
    const { characterRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        throw new Error(`Character ${args.characterId} not found`);
    }

    // Combat validation reads the database (item 18).
    const live = liveEncountersFor(getDb(), character.id);
    if (live.length) return { error: true, actionType: 'short', message: restInCombatRefusal(character.name, live), writes: 'none' };

    const dice = hitDicePool(character as { level: number; resourcePools?: Pools });
    const hitDiceToSpend = Math.min(args.hitDiceToSpend ?? 1, dice.current);
    const hitDieSize = getHitDieSize(character.characterClass, character.id);
    const conModifier = getAbilityModifier(character.stats.con);

    // Roll hit dice for healing
    let totalHealing = 0;
    const rolls: number[] = [];

    for (let i = 0; i < hitDiceToSpend; i++) {
        const roll = rollHitDie(hitDieSize, character.id);
        rolls.push(roll);
        totalHealing += Math.max(1, roll + conModifier);
    }

    const actualHealing = Math.min(totalHealing, character.maxHp - character.hp);
    const newHp = character.hp + actualHealing;

    // Pools with refresh short, perRest short abilities; pact slots (item 8: casting.as).
    const refresh = refreshForRest(character, 'short');
    const hitDiceRemaining = dice.current - hitDiceToSpend;
    const pools = withHitDice(refresh.pools, hitDiceRemaining, dice.max);
    const slots = restoreSlotsForRest(getDb(), character, 'short');
    const updatedChar: Record<string, unknown> = {
        hp: newHp, resourcePools: pools,
        ...(refresh.abilities ? { abilities: refresh.abilities } : {}),
        ...slots.updates
    };

    characterRepo.update(args.characterId, updatedChar as never);
    const linkedItems = mirrorLinkedForRest(character.id, refresh);
    const refilledLine = describeRefilled(refresh);

    return {
        message: `${character.name} completes a short rest.${refilledLine ? ` Refreshed: ${refilledLine}.` : ''}`,
        character: character.name,
        previousHp: character.hp,
        newHp,
        maxHp: character.maxHp,
        hpRestored: actualHealing,
        hitDiceSpent: hitDiceToSpend,
        hitDiceRequested: args.hitDiceToSpend ?? 1,
        hitDiceRemaining,
        hitDieSize: `d${hitDieSize}`,
        conModifier,
        rolls,
        restType: 'short',
        pactSlotsRestored: slots.pactSlotsRestored,
        refilled: refresh.refilled,
        ...(linkedItems.length ? { linkedItems } : {})
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<RestAction, ActionDefinition> = {
    long: {
        schema: LongRestSchema,
        handler: handleLongRest,
        aliases: ['long_rest', 'full'],
        description: 'Take a long rest (8 hours). Restores HP, spell slots, pools with refresh short or long, perRest abilities and legendary resistances.'
    },
    short: {
        schema: ShortRestSchema,
        handler: handleShortRest,
        aliases: ['short_rest', 'quick'],
        description: 'Take a short rest (1 hour). Spend hit dice to recover HP; pools with refresh short and perRest short abilities come back.'
    }
};

const router = createActionRouter({
    actions: ACTIONS,
    definitions,
    threshold: 0.6
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEFINITION & HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export const RestManageTool = {
    name: 'rest_manage',
    description: `Manage character rest mechanics (D&D 5e style).

⏰ REST TYPES:
- long (8 hours): Full HP restoration, all spell slots restored
- long also regains half your level in hit dice (minimum 1)
- short (1 hour): Spend hit dice to heal (class hit die + CON per die); dice left are tracked in resourcePools.hit_dice

♻️ WHAT ELSE COMES BACK (item 18):
- Resource pools by their refresh policy (character_manage adjust_pool {refresh}): short refills on either rest, long on a long rest only; none/unset never. Pools already full are left alone; each refill is on the pool's history and in the reply's refilled[]
- Abilities with perRest (Second Wind: short, Indomitable: long) spent in a fight are readied on the sheet (refilled[] lists them); recharge-only abilities are not
- A long rest restores legendary resistances: legendaryResistancesRemaining back to legendaryResistances (legendaryResistancesRestored in the reply)
- A linked pool pushes its charges onto the item (linkedItems)

⚔️ COMBAT RESTRICTION:
Refused (writes: none) while the character is a token in an active encounter row; the reply names the encounter and combat_manage end. A completed or paused encounter does not block.

✨ SPELLCASTING:
- Full casters: All spell slots restored on long rest
- Warlocks: Pact slots restore on SHORT rest
- Concentration spells cleared on long rest

Actions: long, short
Aliases: long_rest/full→long, short_rest/quick→short`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe('Action: long, short'),
        characterId: z.string().describe('Character ID'),
        hitDiceToSpend: z.number().int().min(0).max(20).optional()
            .describe('For short rest: hit dice to spend (default: 1)')
    })
};

export async function handleRestManage(args: unknown, ctx: SessionContext): Promise<McpResponse> {
    return router(args as Record<string, unknown>, ctx);
}
