/**
 * The ordered write list: the ops a mend clock applies when it fires, and
 * that a table entry or an offering applies at once. Every op clamps exactly
 * as its live verb does. Pure: returns the applied lines and the sheet
 * updates; the caller writes them through the character repository.
 */
import { z } from 'zod';

/** A fresh schema each call, so no outer schema holds one zod instance twice. */
export function scheduledWriteOpSchema() {
    return z.object({
        op: z.enum(['adjust_pool', 'adjust_hp', 'adjust_max_hp', 'add_condition', 'remove_condition']),
        pool: z.string().optional().describe('Pool name (adjust_pool)'),
        delta: z.number().optional().describe('Delta (adjust_pool / adjust_hp / adjust_max_hp)'),
        max: z.number().optional().describe('Pool max update (adjust_pool)'),
        name: z.string().optional().describe('Condition name (add_condition / remove_condition)'),
        duration: z.number().optional().describe('Condition duration (add_condition)'),
        source: z.string().optional().describe('Condition source (add_condition; default "mend clock")')
    });
}

export type ScheduledWriteOp = z.infer<ReturnType<typeof scheduledWriteOpSchema>>;

type PoolLike = { current: number; max: number; history?: unknown[]; [k: string]: unknown };

/** Pool history keeps this many entries. */
export const POOL_HISTORY_CAP = 20;

/** Append a history entry to a pool, keeping the last 20. */
export function pushPoolHistory(pool: PoolLike, entry: Record<string, unknown>): void {
    pool.history = (pool.history ?? []).concat([{ at: new Date().toISOString(), ...entry }]).slice(-POOL_HISTORY_CAP);
}

/**
 * Apply ops in order. defaultSource names a condition's source when the op
 * gives none (default 'mend clock'); reason, when given, is written to the
 * history of every pool an adjust_pool op moves.
 */
export function applyScheduledOps(
    char: { hp: number; maxHp: number },
    ops: ScheduledWriteOp[],
    opts: { defaultSource?: string; reason?: string } = {}
): { applied: string[]; updates: Record<string, unknown> } {
    const applied: string[] = [];
    const pools: Record<string, PoolLike> = { ...((char as { resourcePools?: Record<string, PoolLike> }).resourcePools || {}) };
    let conditions = [...(((char as { conditions?: Array<{ name: string; duration?: number; source?: string }> }).conditions) || [])];
    let hp = char.hp, maxHp = char.maxHp;
    let poolsTouched = false, condsTouched = false, hpTouched = false, maxHpTouched = false;
    for (const op of ops) {
        switch (op.op) {
            case 'adjust_pool': {
                if (!op.pool) { applied.push('⚠ adjust_pool op missing pool name — skipped'); break; }
                const existing = pools[op.pool] || { current: 0, max: op.max ?? 100 };
                const pmax = op.max ?? existing.max;
                const before = existing.current;
                const current = Math.min(pmax, Math.max(0, before + (op.delta ?? 0)));
                pools[op.pool] = { ...existing, current, max: pmax };
                if (opts.reason) pushPoolHistory(pools[op.pool], { from: before, to: current, delta: op.delta ?? 0, reason: opts.reason });
                poolsTouched = true;
                applied.push(`${op.pool}: ${before} → ${current} (of ${pmax})`);
                break;
            }
            case 'adjust_hp': {
                const before = hp;
                hp = Math.min(maxHp, Math.max(0, hp + (op.delta ?? 0)));
                if (hp !== before) hpTouched = true;
                applied.push(`hp: ${before} → ${hp}`);
                break;
            }
            case 'adjust_max_hp': {
                const beforeM = maxHp;
                maxHp = Math.max(1, maxHp + (op.delta ?? 0));
                if (hp > maxHp) { hp = maxHp; hpTouched = true; }
                if (maxHp !== beforeM) maxHpTouched = true;
                applied.push(`maxHp: ${beforeM} → ${maxHp}`);
                break;
            }
            case 'add_condition': {
                if (!op.name) { applied.push('⚠ add_condition op missing name — skipped'); break; }
                if (conditions.some(c => c.name === op.name)) { applied.push(`condition "${op.name}" already present — skipped`); break; }
                conditions.push({ name: op.name, ...(op.duration !== undefined ? { duration: op.duration } : {}), source: op.source ?? opts.defaultSource ?? 'mend clock' });
                condsTouched = true;
                applied.push(`+condition ${op.name}`);
                break;
            }
            case 'remove_condition': {
                if (!op.name) { applied.push('⚠ remove_condition op missing name — skipped'); break; }
                const beforeLen = conditions.length;
                conditions = conditions.filter(c => c.name !== op.name);
                if (conditions.length !== beforeLen) { condsTouched = true; applied.push(`−condition ${op.name}`); }
                else applied.push(`condition "${op.name}" not present — skipped`);
                break;
            }
        }
    }
    if (ops.length === 0) applied.push('⚠ writes JSON empty or malformed — nothing applied');
    const updates: Record<string, unknown> = {};
    if (poolsTouched) updates.resourcePools = pools;
    if (condsTouched) updates.conditions = conditions;
    if (hpTouched) updates.hp = hp;
    if (maxHpTouched) updates.maxHp = maxHp;
    return { applied, updates };
}
