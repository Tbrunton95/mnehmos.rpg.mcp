/**
 * EFFECTS RESOLVER v1 — the first consumer of the trait store.
 *
 * Contract (Findings #13/#19): consumes ONLY mechanics explicitly flagged
 * `autoApply: true`. Bare mechanics and prose-conditional mechanics remain
 * GM-declared — the fiction lives in the condition, and only the GM stands
 * in the fiction. `condition` on an autoApply mechanic acts as a DOMAIN
 * FILTER (damage type / save ability / skill name, substring match), not a
 * fiction gate.
 *
 * Every application is reported back to the caller for the table to see.
 */
import type Database from 'better-sqlite3';

export interface AutoMechanic {
    type: string;
    value: number;
    condition?: string;
    effectName: string;
    /** FINDINGS #101: explicit scoping keys — skill_bonus/save/resistance mechanics
     *  may name their domain directly; condition remains the legacy channel. */
    skill?: string;
    save?: string;
    damageType?: string;
    /** RESOLVER v2 (FINDINGS #60): pool-derived values hide their arithmetic
     *  by default — hidden pools (psi) must never leak through a breakdown. */
    hidePool?: boolean;
}

export interface AutoApplication {
    effect: string;
    type: string;
    value: number;
    detail?: string;
    /** RESOLVER v2: true when the GM declared the lane and the engine computed the number. */
    declared?: boolean;
}

// ─── RESOLVER v2 (FINDINGS #60): pool-derived mechanic values ───
// A mechanic may carry, instead of a fixed value:
//   valueFromPool: { pool, per?, offset?, negate?, min?, max? }
// resolved at consumption time as:
//   v = floor(pool.current / per); if negate v = -v; v += offset; clamp [min,max]
// This is the Ne Tvar flagship: tier-from-hidden-pool is pure arithmetic over
// engine-held state — the engine owns the recompute; the GM owns only WHICH
// lane fires (the fiction). Pool internals never print unless hidePool:false.
export interface ValueFromPool { pool: string; per?: number; offset?: number; negate?: boolean; min?: number; max?: number }

function readPools(db: Database.Database, characterId: string): Record<string, { current: number; max: number }> {
    try {
        const row = db.prepare('SELECT resource_pools FROM characters WHERE id = ?').get(characterId) as { resource_pools?: string } | undefined;
        return row?.resource_pools ? JSON.parse(row.resource_pools) : {};
    } catch { return {}; }
}

// FINDINGS #70: third value source — the actor's own proficiency bonus.
// Odinets' whole design intent is level-scaling damage; a hard-coded +2
// kills it silently at L5. Standard 5e table: floor((level-1)/4)+2.
function readLevel(db: Database.Database, characterId: string): number {
    try {
        const row = db.prepare('SELECT level FROM characters WHERE id = ?').get(characterId) as { level?: number } | undefined;
        return row?.level ?? 1;
    } catch { return 1; }
}

function resolveMechValue(m: { value?: unknown; valueFromPool?: unknown; valueFromProficiency?: unknown }, pools: Record<string, { current: number; max: number }>, level?: number): number | undefined {
    if (m.valueFromProficiency === true && typeof level === 'number') {
        return Math.floor((level - 1) / 4) + 2;
    }
    const vfp = m.valueFromPool as ValueFromPool | undefined;
    if (vfp && typeof vfp === 'object' && typeof vfp.pool === 'string') {
        const cur = pools[vfp.pool]?.current ?? 0;
        // FINDINGS #98 (ЗАСТАВА T1.1): 'divisor' accepted as alias for 'per'.
        // per defaults to 1 — a {pool} with no divisor feeds the RAW pool value
        // (+70 on a Perception check); pass per/divisor to tier it.
        const rawPer = typeof vfp.per === 'number' ? vfp.per : (vfp as { divisor?: unknown }).divisor;
        const per = typeof rawPer === 'number' && rawPer > 0 ? rawPer : 1;
        let v = Math.floor(cur / per);
        if (vfp.negate === true) v = -v;
        if (typeof vfp.offset === 'number') v += vfp.offset;
        if (typeof vfp.min === 'number') v = Math.max(vfp.min, v);
        if (typeof vfp.max === 'number') v = Math.min(vfp.max, v);
        return v;
    }
    if (typeof m.value === 'number') return m.value;
    return undefined;
}

type RawMech = { type?: string; value?: unknown; condition?: string; autoApply?: boolean; valueFromPool?: unknown; valueFromProficiency?: unknown; hidePool?: boolean; skill?: string; save?: string; damageType?: string; lane?: string; note?: string };

export function loadAutoMechanics(db: Database.Database, targetId: string): AutoMechanic[] {
    const rows = db.prepare(
        `SELECT name, mechanics FROM custom_effects
         WHERE target_id = ? AND is_active = 1`
    ).all(targetId) as Array<{ name: string; mechanics: string }>;

    const pools = readPools(db, targetId);
    const level = readLevel(db, targetId);
    const out: AutoMechanic[] = [];
    for (const row of rows) {
        try {
            const mechs = JSON.parse(row.mechanics || '[]') as RawMech[];
            for (const m of mechs) {
                if (!m || m.autoApply !== true || typeof m.type !== 'string') continue;
                const value = resolveMechValue(m, pools, level);
                if (typeof value !== 'number') continue;
                // Pool-derived values hide arithmetic UNLESS the row opts out.
                const hidePool = m.valueFromPool ? m.hidePool !== false : m.hidePool === true;
                out.push({ type: m.type, value, condition: m.condition, effectName: row.name, hidePool, skill: m.skill, save: m.save, damageType: m.damageType });
            }
        } catch { /* malformed mechanics JSON — resolver ignores, lenient-read handles reporting */ }
    }
    return out;
}

// ─── RESOLVER v2 (FINDINGS #60): the DECLARED-EFFECTS channel ───
// Register B meets Register A: the GM names the conditional trait (and the
// lane, when a trait carries more than one), asserting the fiction gate
// fired; the ENGINE reads the row and computes the number — including
// tier-from-hidden-pool — so a chair never re-derives arithmetic the
// database already holds. Missing effects and ambiguous lanes are reported
// LOUDLY and apply nothing; the resolver never guesses fiction.
export interface DeclaredEffectRef { name: string; lane?: string }

export function applyDeclaredEffects(
    db: Database.Database,
    targetId: string,
    refs: DeclaredEffectRef[],
    wantType: string,
    applied: AutoApplication[],
    domain?: string
): { total: number; problems: string[] } {
    let total = 0;
    const problems: string[] = [];
    if (!refs.length) return { total, problems };
    const pools = readPools(db, targetId);
    const level = readLevel(db, targetId);
    const byName = db.prepare(
        `SELECT name, mechanics FROM custom_effects
         WHERE target_id = ? AND is_active = 1 AND lower(name) = lower(?)`
    );
    for (const ref of refs) {
        const row = byName.get(targetId, ref.name) as { name: string; mechanics: string } | undefined;
        if (!row) { problems.push(`declared effect "${ref.name}" not found on target — nothing applied`); continue; }
        let mechs: RawMech[] = [];
        try { mechs = JSON.parse(row.mechanics || '[]') as RawMech[]; } catch { problems.push(`declared effect "${ref.name}" has malformed mechanics — nothing applied`); continue; }
        let candidates = mechs.filter(m => m && m.type === wantType);
        // FINDINGS #101: explicit scope keys (skill/save) are honored when the
        // call names its domain — a mechanic scoped to acrobatics refuses a
        // persuasion roll LOUDLY instead of summing silently.
        if (domain) {
            const scoped = candidates.filter(m => {
                const key = wantType === 'skill_bonus' ? m.skill : wantType === 'saving_throw_bonus' ? m.save : undefined;
                return key === undefined || domainMatch(key, domain);
            });
            if (scoped.length === 0 && candidates.length > 0) {
                const declaredScope = candidates.map(c => c.skill ?? c.save).filter(Boolean).join(' | ') || '(unscoped)';
                problems.push(`declared effect "${ref.name}": its ${wantType} is scoped to "${declaredScope}", not "${domain}" — nothing applied (FINDINGS #101)`);
                continue;
            }
            candidates = scoped;
        }
        if (ref.lane) {
            // FINDINGS #104: the declared lane now matches the mechanic's own
            // stored lane key (#101) as well as its condition text — passing
            // back the lane you WROTE no longer zeroes the trait you wrote it
            // on. (Pre-#104 this filtered on condition alone, so a stored
            // lane:'TRAIT' matched nothing and the trait silently applied 0.)
            const lane = ref.lane.toLowerCase();
            candidates = candidates.filter(m =>
                (m.condition ?? '').toLowerCase().includes(lane) ||
                (m.lane ?? '').toLowerCase() === lane);
        }
        if (candidates.length === 0) {
            problems.push(`declared effect "${ref.name}": no ${wantType} mechanic${ref.lane ? ` matching lane "${ref.lane}"` : ''} — nothing applied`);
            continue;
        }
        if (candidates.length > 1) {
            problems.push(`declared effect "${ref.name}": ${candidates.length} ${wantType} lanes [${candidates.map(c => c.lane ?? c.condition ?? 'unconditioned').join(' | ')}] — pass lane to pick one; nothing applied`);
            continue;
        }
        const m = candidates[0];
        const value = resolveMechValue(m, pools, level);
        if (typeof value !== 'number') { problems.push(`declared effect "${ref.name}": mechanic has no resolvable value — nothing applied`); continue; }
        const hidePool = m.valueFromPool ? m.hidePool !== false : m.hidePool === true;
        total += value;
        applied.push({ effect: row.name, type: wantType, value, detail: hidePool ? (m.condition ?? undefined) : (m.condition ?? undefined), declared: true });
    }
    return { total, problems };
}

function domainMatch(condition: string | undefined, domain: string | undefined): boolean {
    if (!condition) return true;                       // unfiltered — applies across the domain
    if (!domain) return false;                          // filtered mechanic, unknown domain — skip
    return domain.toLowerCase().includes(condition.toLowerCase())
        || condition.toLowerCase().includes(domain.toLowerCase());
}

/** Sum of autoApply attack_bonus mechanics on the actor. */
export function autoAttackBonus(mechs: AutoMechanic[], applied: AutoApplication[]): number {
    let total = 0;
    for (const m of mechs.filter(m => m.type === 'attack_bonus')) {
        total += m.value;
        applied.push({ effect: m.effectName, type: 'attack_bonus', value: m.value });
    }
    return total;
}

/** Sum of autoApply ac_bonus mechanics on the target. */
export function autoAcBonus(mechs: AutoMechanic[], applied: AutoApplication[]): number {
    let total = 0;
    for (const m of mechs.filter(m => m.type === 'ac_bonus')) {
        total += m.value;
        applied.push({ effect: m.effectName, type: 'ac_bonus', value: m.value });
    }
    return total;
}

/** Apply autoApply damage_resistance mechanics (condition = damage-type filter). */
export function autoDamageResistance(
    mechs: AutoMechanic[], damage: number, damageType: string | undefined, applied: AutoApplication[]
): number {
    let result = damage;
    for (const m of mechs.filter(m => m.type === 'damage_resistance')) {
        if (domainMatch(m.damageType ?? m.condition, damageType)) {
            const before = result;
            result = Math.floor(result * m.value);
            applied.push({ effect: m.effectName, type: 'damage_resistance', value: m.value, detail: `${before} -> ${result}${m.condition ? ` (${m.condition})` : ''}` });
        }
    }
    return result;
}

/** Sum of autoApply saving_throw_bonus mechanics (condition = ability filter). */
export function autoSaveBonus(mechs: AutoMechanic[], ability: string | undefined, applied: AutoApplication[]): number {
    let total = 0;
    for (const m of mechs.filter(m => m.type === 'saving_throw_bonus')) {
        if (domainMatch(m.save ?? m.condition, ability)) {
            total += m.value;
            applied.push({ effect: m.effectName, type: 'saving_throw_bonus', value: m.value, detail: ability });
        }
    }
    return total;
}

/** Sum of autoApply skill_bonus mechanics (condition = skill filter). */
export function autoSkillBonus(mechs: AutoMechanic[], skill: string | undefined, applied: AutoApplication[]): number {
    let total = 0;
    for (const m of mechs.filter(m => m.type === 'skill_bonus')) {
        if (domainMatch(m.skill ?? m.condition, skill)) {
            total += m.value;
            applied.push({ effect: m.effectName, type: 'skill_bonus', value: m.value, detail: skill });
        }
    }
    return total;
}

/** FINDINGS #70: sum of autoApply damage_bonus mechanics on the actor — the
 *  resolver damage lane. Flat adds only (dice-shaped bonuses are a later
 *  path); applied AFTER crit doubling, BEFORE resistance, per spec. */
export function autoDamageBonus(mechs: AutoMechanic[], applied: AutoApplication[]): number {
    let total = 0;
    for (const m of mechs.filter(m => m.type === 'damage_bonus')) {
        total += m.value;
        applied.push({ effect: m.effectName, type: 'damage_bonus', value: m.value });
    }
    return total;
}
