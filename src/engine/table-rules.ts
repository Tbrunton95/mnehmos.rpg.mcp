/**
 * Table rules: a world's house rules stored as data and enforced by the
 * engine. The engine computes the numbers (who is a peer, which tier a
 * prepared asset lands in, when a consequence is due); the table owns the
 * flavour (which joint breaks, what the catastrophe looks like).
 *
 * No world, or no enabled rule of a kind, means the engine behaves exactly
 * as it did without table rules.
 */
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { PartSchema, UnitSchema, ParticipantExtrasShape, type AttackProfile, type Part } from '../schema/token-extras.js';
import { expandCreatureTemplate, type CreaturePreset } from '../data/creature-presets.js';
import { UNPRINTABLE_POOLS } from '../render/pda.js';

export const DEFAULT_BAND_ORDER = ['Mortal', 'Elite Mortal', 'Astartes', 'Astartes Elite', 'Monster/Lord', 'Primarch-class'];

export const RuleSpecSchemas = {
    band: z.object({
        order: z.array(z.string().min(1)).min(2).default(DEFAULT_BAND_ORDER)
    }).passthrough(),
    peer_consequence: z.object({
        thresholdFraction: z.number().gt(0).max(1).default(0.25),
        onCrit: z.boolean().default(true),
        options: z.array(z.string()).default(['crippled joint', 'breached plate', 'thrown out of position']),
        /** 'up': hits on the same band or higher. 'both': a higher band's hits on a lower one too. */
        direction: z.enum(['up', 'both']).default('up')
    }).passthrough(),
    called_strike: z.object({
        requirePeer: z.boolean().default(true),
        limbs: z.record(z.string(), z.object({
            speed: z.number().min(0).max(1).optional(),
            attackDisadvantage: z.boolean().optional(),
            notes: z.array(z.string()).default([])
        })).default({
            leg: { speed: 0.5, notes: ['no brace', 'footing/Athletics at disadvantage'] },
            arm: { attackDisadvantage: true, notes: ["that arm's attacks at disadvantage"] },
            other: { notes: ['that part fails; GM names it'] }
        })
    }).passthrough(),
    prepared_asset: z.object({
        catastrophicMargin: z.number().int().min(1).default(10),
        missOptions: z.array(z.string()).default(['breach', 'displacement', 'forced into cover']),
        hitEffect: z.string().default('crippled system'),
        catastrophicEffect: z.string().default('catastrophic')
    }).passthrough(),
    progression: z.object({
        mode: z.enum(['milestone', 'xp']).default('milestone')
    }).passthrough(),
    status_block: z.object({
        compact: z.boolean().default(true),
        maxConditions: z.number().int().min(0).max(10).default(2),
        /** The one resource pool the tiny block shows (e.g. 'corruption'). Only a named pool is ever shown. */
        corePool: z.string().optional(),
        // Item 18: the house format. Unset, each reproduces the default block.
        /** 'rows' (default): one condition a row. 'line': one labelled row, 'COND A · B'. */
        conditionLayout: z.enum(['rows', 'line']).optional(),
        /** Label on the 'line' layout's row (default 'COND'). */
        conditionLabel: z.string().optional(),
        /** false drops the '+N more' row. */
        showMore: z.boolean().optional(),
        /** false drops the AT row. */
        showLocation: z.boolean().optional(),
        /** false drops the OBJ row. */
        showObjective: z.boolean().optional(),
        /**
         * A free line under the frame, segments joined by ' · ': 'scene.place',
         * 'scene.<engineState key>', 'knows:<key prefix>' (or 'knows:<prefix>|Label')
         * as 'Label (k of n)', 'location', 'objective'. Anything else prints as written.
         */
        footer: z.array(z.string()).optional()
    }).passthrough(),
    principle: z.object({
        text: z.string().min(1)
    }).passthrough(),
    /**
     * The world's words for the engine's fixed labels. Without a lexicon
     * rule a world reads the STALKER defaults the engine grew up with.
     */
    lexicon: z.object({
        /** Label on the gold field: 'Thrones', 'crowns', 'RU'. */
        currency: z.string().min(1).default('gold'),
        /** Badge on the status block's header strip. Empty for none. */
        badge: z.string().default(''),
        /** Line appended when a quest fails. Empty for none. */
        questFailLine: z.string().default('')
    }).passthrough(),
    /**
     * A bestiary entry: a statblock saved once and spawned by name
     * (combat_manage spawn_quick_enemy / add_participant {creature}). Never
     * enforced; session boot counts these instead of listing them.
     */
    creature: z.object({
        ...ParticipantExtrasShape,
        displayName: z.string().optional().describe('Token name when it differs from the rule name'),
        hp: z.number().int().positive(),
        maxHp: z.number().int().positive().optional(),
        ac: z.number().int().min(0),
        stats: z.object({
            str: z.number().int(), dex: z.number().int(), con: z.number().int(),
            int: z.number().int(), wis: z.number().int(), cha: z.number().int()
        }).partial().optional(),
        initiativeBonus: z.number().int().optional().describe('Default: the DEX modifier'),
        /** The preset shape of a single attack; attackBonus/attackDamage or attacks[] are the token shapes. */
        attack: z.object({ name: z.string(), damage: z.string(), damageType: z.string().optional(), toHit: z.number().int().optional() }).optional(),
        resistances: z.array(z.string()).default([]),
        vulnerabilities: z.array(z.string()).default([]),
        immunities: z.array(z.string()).default([]),
        regeneration: z.number().int().min(0).optional(),
        band: z.string().optional(),
        parts: z.array(PartSchema).optional(),
        unit: UnitSchema.optional(),
        xpValue: z.number().min(0).optional(),
        traits: z.array(z.string()).default([])
    }).passthrough(),
    /**
     * A random table (the Eye of the Gods, a miscast table, omens, weather).
     * Entries are all weighted (cumulative ranges from 1) or all ranged
     * (min..max on the die). table_rules roll rolls it; data, never enforced.
     */
    roll_table: z.object({
        /** Default: 1d<total weight>, or 1d<highest max>. */
        dice: z.string().optional(),
        /** A character pool whose current value, ÷ poolDivisor (floored), adds to the roll. */
        modifierPool: z.string().optional(),
        poolDivisor: z.number().gt(0).default(1),
        entries: z.array(z.object({
            min: z.number().int().optional(),
            max: z.number().int().optional(),
            weight: z.number().int().positive().optional(),
            text: z.string().min(1),
            /** Another roll_table rule rolled after this entry. */
            chain: z.string().optional()
        }).passthrough()).min(1)
    }).passthrough().superRefine(refineRollTable),
    /**
     * A family of rival pools (the gods' favour). adjust_pool {family} moves
     * a member; a gain makes each jealous rival lose round(gain × fraction).
     * floor (may be negative) and max clamp the family's pools.
     */
    pool_family: z.object({
        pools: z.array(z.string().min(1)).min(1),
        max: z.number().optional(),
        floor: z.number().optional(),
        /** jealousy[gainer][rival] = fraction of the gain the rival loses. */
        jealousy: z.record(z.string(), z.record(z.string(), z.number().min(0))).default({}),
        /** What an offering is worth: an item name, 'kill', or a deed. */
        offering_values: z.record(z.string(), z.number()).default({})
    }).passthrough()
} as const;

function refineRollTable(
    spec: { entries: Array<{ min?: number; max?: number; weight?: number }> },
    ctx: z.RefinementCtx
): void {
    const ranged = spec.entries.filter(e => e.min !== undefined);
    if (ranged.length && ranged.length !== spec.entries.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries'], message: 'entries are all weighted (weight) or all ranged (min/max); do not mix them' });
        return;
    }
    spec.entries.forEach((e, i) => {
        if (e.min === undefined && e.max !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', i, 'min'], message: 'max needs min' });
        if (e.min !== undefined && e.weight !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', i], message: 'an entry takes weight or min/max, not both' });
        if (e.min !== undefined && e.max !== undefined && e.max < e.min) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', i, 'max'], message: 'max is below min' });
    });
    if (ranged.length) {
        const spans = ranged.map((e, i) => ({ i, lo: e.min!, hi: e.max ?? e.min! })).sort((a, b) => a.lo - b.lo);
        for (let k = 1; k < spans.length; k++) {
            if (spans[k].lo <= spans[k - 1].hi) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', spans[k].i], message: `ranges overlap (${spans[k - 1].lo}-${spans[k - 1].hi} and ${spans[k].lo}-${spans[k].hi})` });
            }
        }
    }
}

/**
 * Kinds that are the world's data (a bestiary, tables, spells, character
 * options), not rules the engine enforces: boot counts them instead of
 * listing them as enforced. Some kinds here arrive in later releases.
 */
export const DATA_KINDS: ReadonlySet<string> = new Set([
    'creature', 'roll_table', 'pool_family', 'spell', 'skill', 'species', 'char_class', 'background'
]);

export type RuleKind = keyof typeof RuleSpecSchemas;
export const RULE_KINDS = Object.keys(RuleSpecSchemas) as RuleKind[];
export type RuleSpec<K extends RuleKind> = z.infer<(typeof RuleSpecSchemas)[K]>;

export interface TableRule<K extends RuleKind = RuleKind> {
    id: string;
    worldId: string;
    kind: K;
    name: string;
    spec: RuleSpec<K>;
    enabled: boolean;
}

type RuleRow = { id: string; world_id: string; kind: string; name: string; spec: string; enabled: number };

/** Validate a spec for its kind, filling defaults. Throws a readable error. */
export function parseRuleSpec<K extends RuleKind>(kind: K, spec: unknown): RuleSpec<K> {
    const schema = RuleSpecSchemas[kind];
    if (!schema) throw new Error(`Unknown rule kind '${kind}'. Kinds: ${RULE_KINDS.join(', ')}`);
    const parsed = schema.safeParse(spec ?? {});
    if (!parsed.success) {
        const issues = parsed.error.issues.map(i => `${i.path.join('.') || kind}: ${i.message}`).join('; ');
        throw new Error(`Invalid ${kind} spec: ${issues}`);
    }
    return parsed.data as RuleSpec<K>;
}

function rowToRule(r: RuleRow): TableRule {
    let spec: unknown = {};
    try { spec = JSON.parse(r.spec); } catch { /* stored spec unreadable: defaults */ }
    const kind = r.kind as RuleKind;
    let parsed: RuleSpec<RuleKind>;
    try { parsed = parseRuleSpec(kind, spec); } catch { parsed = spec as RuleSpec<RuleKind>; }
    return { id: r.id, worldId: r.world_id, kind, name: r.name, spec: parsed, enabled: r.enabled === 1 };
}

/** All rules for a world (enabled and disabled), or [] when the table is absent. */
export function listRules(db: Database.Database, worldId: string): TableRule[] {
    try {
        const rows = db.prepare('SELECT * FROM table_rules WHERE world_id = ? ORDER BY kind, name').all(worldId) as RuleRow[];
        return rows.map(rowToRule);
    } catch {
        return [];
    }
}

/** Enabled rules of one kind for a world. */
export function loadRules<K extends RuleKind>(db: Database.Database, worldId: string | null | undefined, kind: K): TableRule<K>[] {
    if (!worldId) return [];
    try {
        const rows = db.prepare('SELECT * FROM table_rules WHERE world_id = ? AND kind = ? AND enabled = 1 ORDER BY name').all(worldId, kind) as RuleRow[];
        return rows.map(rowToRule) as TableRule<K>[];
    } catch {
        return [];
    }
}

/** The first enabled rule of a kind, by name order. */
export function loadRule<K extends RuleKind>(db: Database.Database, worldId: string | null | undefined, kind: K, name?: string): TableRule<K> | undefined {
    const rules = loadRules(db, worldId, kind);
    return name ? rules.find(r => r.name.toLowerCase() === name.toLowerCase()) : rules[0];
}

/**
 * The world a combat action belongs to: the encounter's stamped world, then
 * the character's. Either column may be absent on older databases.
 */
export function resolveWorldId(db: Database.Database, refs: { encounterId?: string; characterIds?: string[] }): string | null {
    if (refs.encounterId) {
        try {
            const row = db.prepare('SELECT world_id FROM encounters WHERE id = ?').get(refs.encounterId) as { world_id?: string | null } | undefined;
            if (row?.world_id) return row.world_id;
        } catch { /* no world_id column */ }
    }
    for (const id of refs.characterIds ?? []) {
        try {
            const row = db.prepare('SELECT world_id FROM characters WHERE id = ?').get(id) as { world_id?: string | null } | undefined;
            if (row?.world_id) return row.world_id;
        } catch { /* no world_id column */ }
    }
    // Untagged rows belong everywhere, but only a single-world save may lean
    // on that: when the database holds exactly one world, it is the world.
    // With two or more (a STALKER save and a 40k save side by side), nothing
    // is guessed, so one campaign's rules never reach another's characters.
    try {
        const worlds = db.prepare('SELECT id FROM worlds LIMIT 2').all() as Array<{ id: string }>;
        if (worlds.length === 1) return worlds[0].id;
    } catch { /* no worlds table */ }
    return null;
}

/**
 * Compare two bands under the world's order: -1 (a below b), 0 (same),
 * 1 (a above b), or null when either band is unset or not in the order.
 */
export function compareBands(order: string[], a: string | undefined | null, b: string | undefined | null): -1 | 0 | 1 | null {
    if (!a || !b) return null;
    const idx = (x: string) => order.findIndex(o => o.toLowerCase() === x.trim().toLowerCase());
    const ia = idx(a), ib = idx(b);
    if (ia < 0 || ib < 0) return null;
    return ia === ib ? 0 : ia < ib ? -1 : 1;
}

/**
 * A resource pool by name: the exact key first, then any case. Returns the
 * stored key so the block shows the name as the sheet spells it.
 */
export function findPool<P>(pools: Record<string, P> | undefined | null, name: string | undefined | null): { key: string; pool: P } | undefined {
    if (!pools || !name) return undefined;
    if (pools[name] !== undefined) return { key: name, pool: pools[name] };
    const key = Object.keys(pools).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? { key, pool: pools[key] } : undefined;
}

/**
 * Item 15: the pools a GM marked show: true, as counters for the boot digest
 * and the status block. The core pool is left out (it already has its own
 * slot), and so is anything unprintable: psi never reaches a display.
 */
export function shownCounters(
    pools: Record<string, { current: number; max: number; label?: string; show?: boolean; itemInstanceId?: string; note?: string }> | undefined | null,
    coreKey?: string
): Array<{ key: string; name: string; current: number; max: number; itemInstanceId?: string; note?: string }> {
    return Object.entries(pools ?? {})
        .filter(([k, p]) => p?.show === true && k !== coreKey && !UNPRINTABLE_POOLS.has(k.toLowerCase()))
        .map(([k, p]) => ({ key: k, name: p.label ?? k, current: p.current, max: p.max, ...(p.itemInstanceId ? { itemInstanceId: p.itemInstanceId } : {}), ...(p.note ? { note: p.note } : {}) }));
}

export interface Lexicon { currency: string; badge: string; questFailLine: string }

/** What a world without a lexicon rule reads: the STALKER campaign's words. */
export const DEFAULT_LEXICON: Lexicon = { currency: 'RU', badge: 'ПДА', questFailLine: "The Zone doesn't wait." };

/** The world's lexicon, or the defaults when it has none. */
export function worldLexicon(db: Database.Database, worldId: string | null | undefined): Lexicon {
    const spec = loadRule(db, worldId, 'lexicon')?.spec;
    return spec ? { currency: spec.currency, badge: spec.badge, questFailLine: spec.questFailLine } : DEFAULT_LEXICON;
}

/** The lexicon for a character's world. */
export function characterLexicon(db: Database.Database, characterId: string): Lexicon {
    return worldLexicon(db, resolveWorldId(db, { characterIds: [characterId] }));
}

/**
 * The conditions a short view shows: pinned ones first in sheet order, then
 * the rest newest first. A sheet's oldest grants never crowd out the fight.
 */
export function conditionsForDisplay<C extends { pinned?: boolean }>(conditions: C[], n: number): C[] {
    const pinned = conditions.filter(c => c.pinned);
    const rest = conditions.filter(c => !c.pinned).reverse();
    return [...pinned, ...rest].slice(0, n);
}

/** The world's band order, or the Day 366 default when no band rule exists. */
export function bandOrder(db: Database.Database, worldId: string | null | undefined): string[] {
    return loadRule(db, worldId, 'band')?.spec.order ?? DEFAULT_BAND_ORDER;
}

// ═══════════════════════════════════════════════════════════════════════════
// BESTIARY: creature rules and the built-in presets as one statblock shape
// ═══════════════════════════════════════════════════════════════════════════

export type CreatureSpec = RuleSpec<'creature'>;

export interface ResolvedCreature {
    /** The token name ('Chaos Spawn'): displayName, the rule name, or the preset's. */
    name: string;
    source: 'world' | 'preset';
    spec: CreatureSpec;
    /** The single attack for spawn summaries, in the preset shape. */
    defaultAttack?: { name: string; damage: string; damageType?: string; toHit?: number };
}

function presetToSpec(preset: CreaturePreset): CreatureSpec {
    return parseRuleSpec('creature', {
        displayName: preset.name,
        hp: preset.hp,
        maxHp: preset.maxHp,
        ac: preset.ac,
        stats: preset.stats,
        initiativeBonus: Math.floor((preset.stats.dex - 10) / 2),
        ...(preset.defaultAttack ? { attack: preset.defaultAttack } : {}),
        ...(preset.attacksPerAction ? { attacksPerAction: preset.attacksPerAction } : {}),
        ...(preset.size ? { size: preset.size } : {}),
        ...(preset.speed !== undefined ? { movementSpeed: preset.speed } : {}),
        ...(preset.cr !== undefined ? { cr: preset.cr } : {}),
        ...(preset.xpValue !== undefined ? { xpValue: preset.xpValue } : {}),
        resistances: preset.resistances ?? [],
        vulnerabilities: preset.vulnerabilities ?? [],
        immunities: preset.immunities ?? [],
        traits: preset.traits ?? []
    });
}

/** The attack a token makes when it names none: attack, then the default profile, then the first. */
function defaultAttackOf(spec: CreatureSpec): ResolvedCreature['defaultAttack'] {
    if (spec.attack) return spec.attack;
    const profiles = (spec.attacks ?? []) as AttackProfile[];
    const prof = profiles.find(a => a.default) ?? profiles[0];
    if (prof) return { name: prof.name, damage: String(prof.damage), damageType: prof.damageType, toHit: prof.attackBonus };
    if (spec.attackDamage) return { name: 'attack', damage: spec.attackDamage, damageType: spec.attackDamageType, toHit: spec.attackBonus };
    return undefined;
}

/**
 * A creature by name: the world's enabled creature rule first (any case),
 * then the built-in preset ('goblin', 'orc:warrior'). null when neither.
 */
export function resolveCreature(db: Database.Database, worldId: string | null | undefined, ref: string): ResolvedCreature | null {
    const rule = loadRule(db, worldId, 'creature', ref);
    if (rule) {
        const spec = parseRuleSpec('creature', rule.spec);
        return { name: spec.displayName ?? rule.name, source: 'world', spec, defaultAttack: defaultAttackOf(spec) };
    }
    const preset = expandCreatureTemplate(ref);
    if (!preset) return null;
    const spec = presetToSpec(preset);
    return { name: preset.name, source: 'preset', spec, defaultAttack: preset.defaultAttack ?? defaultAttackOf(spec) };
}

const LONG_STATS = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' } as const;

/**
 * One token from a statblock. Parts start intact and unlatched and limited
 * abilities start ready, per token: the spec is a template, never a record
 * of the last fight.
 */
export function creatureToParticipant(spec: CreatureSpec, opts: { id: string; name: string; position?: { x: number; y: number }; isEnemy?: boolean }): Record<string, unknown> {
    const stats = spec.stats ?? {};
    const abilityScores = Object.fromEntries(Object.entries(LONG_STATS).map(([s, l]) => [l, (stats as Record<string, number | undefined>)[s] ?? 10]));
    const attack = defaultAttackOf(spec);
    const parts = (spec.parts as Part[] | undefined)?.map(pt => {
        const { latchedTo: _latched, ...rest } = pt;
        return { ...rest, state: 'intact' as const, ...(pt.maxHp !== undefined || pt.hp !== undefined ? { hp: pt.maxHp ?? pt.hp } : {}) };
    });
    const out: Record<string, unknown> = {
        id: opts.id,
        name: opts.name,
        hp: spec.maxHp ?? spec.hp,
        maxHp: spec.maxHp ?? spec.hp,
        ac: spec.ac,
        initiativeBonus: spec.initiativeBonus ?? Math.floor(((stats.dex ?? 10) - 10) / 2),
        isEnemy: opts.isEnemy ?? true,
        conditions: [],
        position: opts.position ?? { x: 0, y: 0 },
        abilityScores,
        resistances: [...spec.resistances],
        vulnerabilities: [...spec.vulnerabilities],
        immunities: [...spec.immunities],
        size: spec.size ?? 'medium',
        movementSpeed: spec.movementSpeed ?? 30
    };
    const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
    const optional: Record<string, unknown> = {
        reach: spec.reach,
        attackBonus: spec.attackBonus ?? attack?.toHit,
        attackDamage: spec.attackDamage ?? attack?.damage,
        attackDamageType: spec.attackDamageType ?? attack?.damageType,
        attacksPerAction: spec.attacksPerAction,
        attacks: spec.attacks ? copy(spec.attacks as AttackProfile[]) : undefined,
        abilities: spec.abilities?.map(a => ({ ...a, ready: true })),
        legendaryActions: spec.legendaryActions,
        legendaryResistances: spec.legendaryResistances,
        autoLegendaryResistance: spec.autoLegendaryResistance,
        hasLairActions: spec.hasLairActions,
        cr: spec.cr,
        regeneration: spec.regeneration,
        band: spec.band,
        parts,
        unit: spec.unit ? copy(spec.unit) : undefined
    };
    for (const [k, v] of Object.entries(optional)) if (v !== undefined) out[k] = v;
    return out;
}
