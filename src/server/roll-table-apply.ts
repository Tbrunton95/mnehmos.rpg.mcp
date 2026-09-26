/**
 * Roll a world's roll_table and apply what it lands on. The first table
 * takes the modifier (input plus the character's modifierPool ÷ poolDivisor);
 * each entry's chain rolls the next table, plain, up to five deep.
 *
 * With a character and apply on, every entry that carries an apply block
 * acts on the character in a fixed order: gift (an effect), condition and
 * writes, form, then terminal death, which stops the chain. Without a
 * character only the text and the chain are rolled.
 */
import type Database from 'better-sqlite3';
import { listRules, findPool, type RuleSpec, type TableRule } from '../engine/table-rules.js';
import { rollTable, type TableRoll, type RollTableEntry } from '../engine/roll-table.js';
import { loggedRoller, type DiceRoller } from '../math/logged-d20.js';
import { applyScheduledOps, type ScheduledWriteOp } from '../engine/scheduled-ops.js';
import { growthFromPools, type GrowthReady } from './growth.js';
import type { HpMode } from '../engine/forms.js';
import { CharacterRepository } from '../storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../storage/repos/custom-effects.repo.js';
import { handleKill, setForm } from './consolidated/character-manage.js';

/** Chained tables stop after this many. */
export const CHAIN_DEPTH = 5;

export interface RollAndApplyInput {
    worldId: string;
    name: string;
    characterId?: string;
    modifier?: number;
    modifierPool?: string;
    /** Apply entries to characterId. The caller decides the default. */
    apply: boolean;
    /** Default: loggedRoller for the character, tool table_rules, with seed. */
    roller?: DiceRoller;
    seed?: string;
    /** Chain depth already used by the caller (default 0). */
    depth?: number;
    /** Tool name the default roller logs under. */
    tool?: string;
}

type EntryApply = {
    gift?: { name: string; description?: string; category: 'boon' | 'curse' | 'neutral' | 'transformative'; powerLevel: number; mechanics: unknown[] };
    condition?: { name: string; duration?: number; source?: string; pinned?: boolean };
    writes?: ScheduledWriteOp[];
    terminal?: 'kill';
    corpse?: boolean;
    form?: string;
    hpMode?: HpMode;
};

export interface AppliedEntry {
    table: string;
    index: number;
    text: string;
    gift?: { name: string; effectId?: number; refreshedExisting: boolean };
    condition?: string;
    writes?: string[];
    form?: Record<string, unknown>;
    killed?: true;
    corpseId?: string;
    errors?: string[];
    /** Growth tracks the writes crossed: offered, never applied. */
    growthReady?: GrowthReady[];
}

interface ChainedRoll { table: string; depth: number; rolled: Omit<TableRoll, 'entry' | 'index' | 'rollId' | 'seed'>; entry: TableRoll['entry'] & { index: number }; rollId?: string }

function rollView(r: TableRoll) {
    const { entry: _e, index: _i, rollId: _r, seed: _s, ...rolled } = r;
    return rolled;
}

function findTable(db: Database.Database, worldId: string, name: string): TableRule | undefined {
    return listRules(db, worldId).find(r => r.name.toLowerCase() === name.toLowerCase());
}

/** Apply one entry to the character. */
async function applyEntry(db: Database.Database, worldId: string, characterId: string, table: string, index: number, entry: RollTableEntry): Promise<AppliedEntry | undefined> {
    const spec = (entry as { apply?: EntryApply }).apply;
    if (!spec) return undefined;
    const repo = new CharacterRepository(db);
    const out: AppliedEntry = { table, index, text: entry.text };
    const errors: string[] = [];
    const source = `table ${table}`;

    if (spec.gift) {
        try {
            const effects = new CustomEffectsRepository(db);
            const existed = !!effects.findByTargetAndName(characterId, 'character', spec.gift.name);
            const effect = effects.apply({
                target_id: characterId,
                target_type: 'character',
                name: spec.gift.name,
                description: spec.gift.description ?? `${spec.gift.category}: ${spec.gift.name} (${entry.text})`,
                source: { type: 'divine', entity_name: source },
                category: spec.gift.category,
                power_level: spec.gift.powerLevel,
                mechanics: spec.gift.mechanics as never,
                duration: { type: 'permanent' },
                triggers: [],
                removal_conditions: [],
                stackable: false,
                max_stacks: 1
            });
            out.gift = { name: spec.gift.name, effectId: effect.id, refreshedExisting: existed };
        } catch (e) { errors.push(`gift '${spec.gift.name}': ${e instanceof Error ? e.message : String(e)}`); }
    }

    if (spec.condition || spec.writes?.length) {
        const char = repo.findById(characterId);
        if (char) {
            const ops: ScheduledWriteOp[] = [
                ...(spec.condition ? [{ op: 'add_condition' as const, name: spec.condition.name, ...(spec.condition.duration !== undefined ? { duration: spec.condition.duration } : {}), source: spec.condition.source ?? source }] : []),
                ...(spec.writes ?? [])
            ];
            const { applied, updates } = applyScheduledOps(char, ops, { defaultSource: source, reason: `${source}: ${entry.text}` });
            if (updates.resourcePools) {
                const ready = growthFromPools(db, worldId, char as never, char.resourcePools as never, updates.resourcePools as never);
                if (ready.length) out.growthReady = ready;
            }
            if (spec.condition?.pinned && Array.isArray(updates.conditions)) {
                updates.conditions = (updates.conditions as Array<{ name: string; pinned?: boolean }>).map(c => c.name === spec.condition!.name ? { ...c, pinned: true } : c);
            }
            if (Object.keys(updates).length) repo.update(characterId, updates as never);
            if (spec.condition) out.condition = spec.condition.name;
            out.writes = applied;
        }
    }

    if (spec.form) {
        const r = setForm({ characterId, form: spec.form, hpMode: spec.hpMode, worldId });
        if (r.error) errors.push(`form: ${String(r.message)}`);
        else out.form = { form: r.form, hp: r.hp, maxHp: r.maxHp, ac: r.ac, ...(Array.isArray(r.liveTokens) && r.liveTokens.length ? { liveTokens: r.liveTokens } : {}) };
    }

    if (spec.terminal === 'kill') {
        const k = await handleKill({ action: 'kill', characterId, cause: `${source}: ${entry.text}`, worldId, createCorpse: spec.corpse ?? false }) as { success?: boolean; corpseId?: string; message?: string };
        if (k.success) {
            out.killed = true;
            if (k.corpseId) out.corpseId = k.corpseId;
        } else errors.push(`kill: ${String(k.message)}`);
    }

    if (errors.length) out.errors = errors;
    return out;
}

/**
 * Roll a named roll_table (and its chain) and, with a character and apply
 * on, apply each entry. Returns the table_rules roll shape plus applied[]
 * (or preview: true when a character was named and apply is off).
 */
export async function rollAndApply(db: Database.Database, input: RollAndApplyInput): Promise<Record<string, unknown>> {
    const rule = findTable(db, input.worldId, input.name);
    if (!rule) return { error: true, message: `No rule '${input.name}' in this world` };
    if (rule.kind !== 'roll_table') return { error: true, message: `'${rule.name}' is a ${rule.kind} rule, not a roll_table` };
    const spec = rule.spec as RuleSpec<'roll_table'>;
    const notes: string[] = [];

    type Char = { id: string; name: string; resourcePools?: Record<string, { current: number }> };
    let char: Char | null = null;
    if (input.characterId) {
        const found = new CharacterRepository(db).findById(input.characterId) as Char | null;
        if (!found) return { error: true, message: `Character ${input.characterId} not found` };
        char = found;
    }
    const roller = input.roller ?? loggedRoller(db, { forId: char?.id, tool: input.tool ?? 'table_rules', seed: input.seed });

    let modifier = input.modifier ?? 0;
    const poolName = input.modifierPool ?? spec.modifierPool;
    let poolBonus: { pool: string; current: number; divisor: number; bonus: number } | undefined;
    if (poolName && char) {
        const found = findPool(char.resourcePools, poolName);
        if (found) {
            const bonus = Math.floor(found.pool.current / spec.poolDivisor);
            poolBonus = { pool: found.key, current: found.pool.current, divisor: spec.poolDivisor, bonus };
            modifier += bonus;
        } else notes.push(`${char.name} has no pool '${poolName}': it adds 0`);
    }

    const applying = !!char && input.apply;
    const applied: AppliedEntry[] = [];
    let dead = false;
    const apply = async (table: string, r: TableRoll) => {
        if (!applying) return;
        const a = await applyEntry(db, input.worldId, char!.id, table, r.index, r.entry);
        if (!a) return;
        applied.push(a);
        if (a.errors) notes.push(...a.errors.map(e => `${table}: ${e}`));
        if (a.killed) dead = true;
    };

    const first = rollTable(spec, roller, { modifier, tag: `table ${rule.name}` });
    await apply(rule.name, first);
    const chained: ChainedRoll[] = [];
    let next = first.entry.chain;
    let depth = (input.depth ?? 0) + 1;
    while (next) {
        if (dead) { notes.push(`chain to '${next}' stopped: ${char!.name} is dead`); break; }
        if (depth > CHAIN_DEPTH) { notes.push(`chain stopped at depth ${CHAIN_DEPTH} (next: '${next}')`); break; }
        const target = findTable(db, input.worldId, next);
        if (!target || target.kind !== 'roll_table') { notes.push(`chain to '${next}' skipped: no roll_table of that name`); break; }
        const r = rollTable(target.spec as RuleSpec<'roll_table'>, roller, { tag: `table ${target.name}` });
        chained.push({ table: target.name, depth, rolled: rollView(r), entry: { ...r.entry, index: r.index }, ...(r.rollId ? { rollId: r.rollId } : {}) });
        await apply(target.name, r);
        next = r.entry.chain;
        depth++;
    }
    const text = [first.entry.text, ...chained.map(c => c.entry.text)].join(' → ');
    const appliedLine = applied.length
        ? ` Applied to ${char!.name}: ${applied.map(a => [a.gift && `gift ${a.gift.name}`, a.condition && `condition ${a.condition}`, a.writes && !a.condition && 'writes', a.form && `form ${String(a.form.form)}`, a.killed && 'killed'].filter(Boolean).join(', ') || a.table).join('; ')}.`
        : '';
    return {
        success: true, actionType: 'roll', table: rule.name,
        ...(char ? { characterId: char.id } : {}),
        rolled: rollView(first), entry: { ...first.entry, index: first.index },
        ...(poolBonus ? { poolBonus } : {}),
        chained, text, rollId: first.rollId, seed: first.seed,
        ...(applying ? { applied } : {}),
        ...(applied.some(a => a.growthReady?.length) ? { growthReady: applied.flatMap(a => a.growthReady ?? []) } : {}),
        ...(char && !input.apply ? { preview: true } : {}),
        ...(notes.length ? { note: notes.join('; ') } : {}),
        message: `${rule.name}: ${first.dice}${first.modifier ? ` ${first.modifier >= 0 ? '+' : '-'} ${Math.abs(first.modifier)}` : ''} = ${first.total}${first.clamped ? ' (clamped)' : ''} → ${text}${appliedLine}${char && !input.apply ? ' (preview: nothing applied)' : ''}`
    };
}
