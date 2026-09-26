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
        corePool: z.string().optional()
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
    }).passthrough()
} as const;

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
