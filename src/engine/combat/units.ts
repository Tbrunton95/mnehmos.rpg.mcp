/**
 * Mortal units as one token (Day 366): one initiative, one move, one action,
 * a fixed volley tier. Casualties come from HP, so any damage (cleave
 * included) moves the tier the moment it lands; suppressed, in melee and
 * broken formation each drop it one more step.
 */
import type { CombatParticipant } from './engine.js';
import { nearbyAllies, type SpeciesOf } from './nearby.js';

export const DEFAULT_TIERS = [
    { minFraction: 0.75, dice: '4d6' },
    { minFraction: 0.5, dice: '3d6' },
    { minFraction: 0.25, dice: '2d6' },
    { minFraction: 0, dice: '1d6' }
];

export interface VolleyTier {
    dice: string | null;
    models: number;
    maxModels: number;
    step: number;
    drops: string[];
    reason: string;
}

/**
 * Play report 7 follow-up (lane W, owner: "Track each model's wounds"): each
 * model of a unit keeps its own wounds. unit.wounded holds the current HP of
 * each wounded live model (below hpPerModel), most wounded first; unhurt
 * models are implicit, so hp = unhurt × hpPerModel + Σ wounded. Every write
 * to a unit's HP goes through the helpers below, which keep the pool and the
 * list in step:
 *  - applyToModels: per-model damage (an area), most wounded inside first;
 *  - spreadOnModels: damage that keeps overflow (a volley, cleave, a GM
 *    spread, a pooled road), most wounded first, killing in order; a single
 *    blow is a spread capped by unitCapFor at the most wounded model's HP;
 *  - healModels: the most wounded first, then revives models;
 *  - setUnitHp: a new pool total, as a spread or a heal.
 * A legacy unit (no list), or a list out of step with the pool (a writer
 * that did not route here), reads its pool the old way: a remainder below
 * hpPerModel is one wounded model at the front.
 */
type UnitHolder = Pick<CombatParticipant, 'hp' | 'unit'>;

const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Lane W review: a unit's models as its wounded (most wounded first) and a
 * count of the unhurt, never one entry per unhurt model, so every read and
 * write costs the wounded, not the unit's size (liveModels was arithmetic
 * before lane W; a 10^7-model unit took seconds a read as one array entry
 * per model, and 10^8 ran the process out of memory).
 */
interface ModelState { wounded: number[]; unhurt: number; per: number; models: number }

/** The pool's own reading: full models, the remainder one wounded model first. */
function poolState(hp: number, models: number, per: number): { wounded: number[]; unhurt: number } {
    if (hp <= 0) return { wounded: [], unhurt: 0 };
    const n = Math.max(0, Math.min(models, Math.ceil(hp / per)));
    if (n === 0) return { wounded: [], unhurt: 0 };
    const front = Math.min(per, hp - (n - 1) * per);
    return front < per ? { wounded: [front], unhurt: n - 1 } : { wounded: [], unhurt: n };
}

/** The unit's models now: the list when it is in step with the pool, else the pool's own reading. */
function modelState(p: UnitHolder): ModelState {
    const u = p.unit!;
    const per = u.hpPerModel;
    if (p.hp <= 0) return { wounded: [], unhurt: 0, per, models: u.models };
    const wounded = (u.wounded ?? []).filter(v => Number.isInteger(v) && v > 0 && v < per).sort((a, b) => a - b);
    if (u.wounded && wounded.length === u.wounded.length) {
        const rest = p.hp - sumOf(wounded);
        if (rest >= 0 && rest % per === 0 && rest / per + wounded.length <= u.models) return { wounded, unhurt: rest / per, per, models: u.models };
    }
    return { ...poolState(p.hp, u.models, per), per, models: u.models };
}

const liveOf = (s: { wounded: number[]; unhurt: number }) => s.wounded.length + s.unhurt;

/**
 * The current HP of each live model, most wounded first (unhurt models, at
 * hpPerModel, last). One entry per model: for tests and small units; the
 * helpers below never build it.
 */
export function modelHps(p: UnitHolder): number[] {
    if (!p.unit || p.hp <= 0) return [];
    const s = modelState(p);
    return [...s.wounded, ...Array<number>(s.unhurt).fill(s.per)];
}

export function liveModels(p: UnitHolder): number {
    if (!p.unit) return 0;
    return liveOf(modelState(p));
}

/** What one write did to a unit's models. */
export interface ModelsChange {
    hpBefore: number;
    hpAfter: number;
    modelsBefore: number;
    modelsAfter: number;
    /** Models that died. */
    killed: number;
    /** HP the models took (damage) or gained (healing). */
    absorbed: number;
    /** Healing only: models brought back. */
    revived?: number;
}

/**
 * Model counts at earlier pool readings, per unit, for this process: each
 * write records its before and after, so a break test or a kill count asked
 * with the HP before a blow reads the real count then (the pool alone cannot
 * say how many wounded models it held). Not persisted: the reading is wanted
 * in the same call as the write.
 */
const unitHistory = new WeakMap<object, Array<{ hpBefore: number; modelsBefore: number; hpAfter: number; modelsAfter: number }>>();

function record(p: UnitHolder, change: ModelsChange): ModelsChange {
    if (!p.unit || (change.hpBefore === change.hpAfter && change.modelsBefore === change.modelsAfter)) return change;
    const list = unitHistory.get(p.unit) ?? [];
    list.push({ hpBefore: change.hpBefore, modelsBefore: change.modelsBefore, hpAfter: change.hpAfter, modelsAfter: change.modelsAfter });
    if (list.length > 16) list.shift();
    unitHistory.set(p.unit, list);
    return change;
}

/**
 * The live models when the pool read `hp`: now, else walked back through
 * this process's writes to that reading, else the pool's own reading of it.
 */
export function modelsAtHp(p: UnitHolder, hp: number): number {
    const u = p.unit;
    if (!u) return 0;
    let curHp = p.hp;
    let models = liveModels(p);
    if (hp === curHp) return models;
    const list = unitHistory.get(u) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
        const h = list[i];
        if (h.hpAfter !== curHp || h.modelsAfter !== models) break;
        curHp = h.hpBefore;
        models = h.modelsBefore;
        if (curHp === hp) return models;
    }
    return liveOf(poolState(hp, u.models, u.hpPerModel));
}

/**
 * Write the models back: the wounded touched (0 for the dead; a value healed
 * to hpPerModel is unhurt again) and the unhurt counted. The pool is their
 * sum; the list holds the wounded, written only while any are.
 */
function writeModels(p: UnitHolder, wounded: number[], unhurt: number): void {
    const u = p.unit!;
    const per = u.hpPerModel;
    const live = wounded.filter(v => v > 0);
    const still = live.filter(v => v < per).sort((a, b) => a - b);
    const whole = unhurt + live.length - still.length;
    p.hp = sumOf(still) + whole * per;
    if (still.length) u.wounded = still;
    else delete (u as { wounded?: number[] }).wounded;
}

/**
 * Write the current reading back: a list out of step with the pool (after a
 * strength change) gives way to the pool's own reading.
 */
export function settleWounds(p: UnitHolder): void {
    if (!p.unit) return;
    const s = modelState(p);
    writeModels(p, s.wounded, s.unhurt);
}

/**
 * Per-model damage (an area): perModelDamage[i] lands on the i-th model,
 * most wounded first. A model dies when its damage meets its HP; otherwise
 * it keeps the wound. absorbed is what the models actually took.
 */
export function applyToModels(p: UnitHolder, perModelDamage: number[]): ModelsChange {
    const hpBefore = p.hp;
    if (!p.unit) return { hpBefore, hpAfter: hpBefore, modelsBefore: 0, modelsAfter: 0, killed: 0, absorbed: 0 };
    const s = modelState(p);
    const modelsBefore = liveOf(s);
    const reach = Math.min(modelsBefore, perModelDamage.length);
    const dmgAt = (i: number) => Math.max(0, Math.floor(perModelDamage[i] ?? 0));
    let killed = 0, absorbed = 0, unhurt = s.unhurt;
    const wounded: number[] = [];
    // The wounded first, then each unhurt model the list reaches.
    for (let i = 0; i < s.wounded.length; i++) {
        const hp = s.wounded[i];
        const d = i < reach ? dmgAt(i) : 0;
        if (d > 0 && d >= hp) { absorbed += hp; killed++; }
        else { absorbed += d; wounded.push(hp - d); }
    }
    for (let i = s.wounded.length; i < reach; i++) {
        const d = dmgAt(i);
        if (d <= 0) continue;
        unhurt--;
        if (d >= s.per) { absorbed += s.per; killed++; }
        else { absorbed += d; wounded.push(s.per - d); }
    }
    writeModels(p, wounded, unhurt);
    return record(p, { hpBefore, hpAfter: p.hp, modelsBefore, modelsAfter: modelsBefore - killed, killed, absorbed });
}

/**
 * Damage that keeps overflow (a volley, cleave, a GM spread, a pooled road):
 * through the models most wounded first, killing in order; what is left
 * wounds the next. A single blow is this capped by unitCapFor.
 */
export function spreadOnModels(p: UnitHolder, damage: number): ModelsChange {
    const hpBefore = p.hp;
    if (!p.unit) return { hpBefore, hpAfter: hpBefore, modelsBefore: 0, modelsAfter: 0, killed: 0, absorbed: 0 };
    const s = modelState(p);
    const modelsBefore = liveOf(s);
    let left = Math.max(0, Math.floor(damage));
    let killed = 0, absorbed = 0, unhurt = s.unhurt;
    const wounded: number[] = [];
    for (const hp of s.wounded) {
        if (left <= 0) { wounded.push(hp); continue; }
        if (left >= hp) { left -= hp; absorbed += hp; killed++; }
        else { wounded.push(hp - left); absorbed += left; left = 0; }
    }
    // Then the unhurt: whole models die, the remainder wounds the next.
    if (left > 0 && unhurt > 0) {
        const dead = Math.min(unhurt, Math.floor(left / s.per));
        unhurt -= dead; killed += dead; absorbed += dead * s.per; left -= dead * s.per;
        if (left > 0 && unhurt > 0) { unhurt--; wounded.push(s.per - left); absorbed += left; left = 0; }
    }
    writeModels(p, wounded, unhurt);
    return record(p, { hpBefore, hpAfter: p.hp, modelsBefore, modelsAfter: modelsBefore - killed, killed, absorbed });
}

/**
 * Healing: the most wounded model first, each up to hpPerModel; what is left
 * after every wound is healed revives models (hpPerModel each, the last one
 * wounded), never past the unit's full strength.
 */
export function healModels(p: UnitHolder, amount: number): ModelsChange {
    const hpBefore = p.hp;
    if (!p.unit) return { hpBefore, hpAfter: hpBefore, modelsBefore: 0, modelsAfter: 0, killed: 0, absorbed: 0 };
    const s = modelState(p);
    const per = s.per;
    const modelsBefore = liveOf(s);
    let left = Math.max(0, Math.floor(amount));
    let absorbed = 0, revived = 0, unhurt = s.unhurt;
    const wounded = s.wounded.map(v => {
        const add = Math.min(per - v, left);
        if (add <= 0) return v;
        left -= add;
        absorbed += add;
        return v + add;
    });
    // Then the dead come back: whole models, the remainder one wounded.
    const room = Math.max(0, s.models - modelsBefore);
    const whole = Math.min(room, Math.floor(left / per));
    unhurt += whole; revived += whole; absorbed += whole * per; left -= whole * per;
    if (left > 0 && whole < room) { wounded.push(left); revived++; absorbed += left; left = 0; }
    writeModels(p, wounded, unhurt);
    return record(p, { hpBefore, hpAfter: p.hp, modelsBefore, modelsAfter: modelsBefore + revived, killed: 0, absorbed, ...(revived ? { revived } : {}) });
}

/** A new pool total for a unit (a GM correction, a sheet sync): a drop spreads, a rise heals. */
export function setUnitHp(p: UnitHolder, hp: number): ModelsChange {
    const target = Math.max(0, Math.floor(hp));
    if (target < p.hp) return spreadOnModels(p, p.hp - target);
    if (target > p.hp) return healModels(p, target - p.hp);
    const n = liveModels(p);
    return { hpBefore: p.hp, hpAfter: p.hp, modelsBefore: n, modelsAfter: n, killed: 0, absorbed: 0 };
}

/**
 * set_unit {wounded}: the wounded models' HP, the live count kept; HP moves
 * to match (unhurt × hpPerModel + Σ wounded). null drops the list, so the
 * pool reads the old way. Refused (nothing written) when a value is not
 * below hpPerModel or more are listed than stand.
 */
export function setWounded(p: UnitHolder, wounded: number[] | null): { ok: true; change: ModelsChange } | { ok: false; message: string } {
    const u = p.unit;
    if (!u) return { ok: false, message: 'not a unit' };
    const live = liveModels(p);
    const hpBefore = p.hp;
    if (wounded === null) {
        delete (u as { wounded?: number[] }).wounded;
        return { ok: true, change: record(p, { hpBefore, hpAfter: p.hp, modelsBefore: live, modelsAfter: liveModels(p), killed: 0, absorbed: 0 }) };
    }
    const bad = wounded.filter(v => !Number.isInteger(v) || v < 1 || v >= u.hpPerModel);
    if (bad.length) return { ok: false, message: `wounded: each value is a wounded model's current HP, a whole number from 1 to below hpPerModel (${u.hpPerModel}); ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not. An unhurt model is not listed` };
    if (wounded.length > live) return { ok: false, message: `wounded: ${wounded.length} listed but ${live} standing; list at most ${live} (raise the HP with adjust_hp or reinforce with set_unit {models} first)` };
    writeModels(p, [...wounded], live - wounded.length);
    return { ok: true, change: record(p, { hpBefore, hpAfter: p.hp, modelsBefore: live, modelsAfter: live, killed: 0, absorbed: Math.abs(p.hp - hpBefore) }) };
}

/**
 * Lane W review: a unit brought into a fight with a wound list (create,
 * add_participant). The list must stand beside the HP given (each value
 * below hpPerModel, no more than the unit's models, and
 * hp = unhurt × hpPerModel + Σ wounded), else modelHps reads the pool and
 * the GM's wounds vanish without a word. The problem, or null when it fits.
 */
export function woundedFitProblem(p: { hp: number; unit?: { models: number; hpPerModel: number; wounded?: number[] } }): string | null {
    const u = p.unit;
    if (!u?.wounded) return null;
    const per = u.hpPerModel;
    const bad = u.wounded.filter(v => !Number.isInteger(v) || v < 1 || v >= per);
    if (bad.length) return `unit.wounded: each value is a wounded model's current HP, a whole number from 1 to below hpPerModel (${per}); ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not. An unhurt model is not listed`;
    if (u.wounded.length > u.models) return `unit.wounded lists ${u.wounded.length} wounded models but the unit has ${u.models}`;
    const sum = sumOf(u.wounded);
    const rest = p.hp - sum;
    if (rest >= 0 && rest % per === 0 && rest / per + u.wounded.length <= u.models) return null;
    const fits = (u.models - u.wounded.length) * per + sum;
    return `unit.wounded [${u.wounded.join(', ')}] does not fit hp ${p.hp}: hp is the unhurt models × ${per} plus the wounded (${sum}), ${u.models} models at most, so with all ${u.models} standing it is ${fits} (pass hp: ${fits}); or leave wounded out and set it after with set_unit {wounded}`;
}

/** Wounded models grouped by HP, highest first: "2 at 5/9, 1 at 2/9" (six groups at most, then the rest counted). */
function woundGroups(hps: number[], per: number): string[] {
    const counts = new Map<number, number>();
    for (const v of hps) if (v < per) counts.set(v, (counts.get(v) ?? 0) + 1);
    const groups = [...counts.entries()].sort((a, b) => b[0] - a[0]);
    const shown = groups.slice(0, 6).map(([v, n]) => `${n} at ${v}/${per}`);
    if (groups.length > 6) {
        const rest = groups.slice(6);
        shown.push(`${sumOf(rest.map(([, n]) => n))} more at ${rest[rest.length - 1][0]}-${rest[0][0]}/${per}`);
    }
    return shown;
}

/** The wounded and the unhurt counted as one string (a value at hpPerModel counts as unhurt). */
function woundPartsOf(wounded: number[], unhurt: number, per: number): string {
    const groups = woundGroups(wounded, per);
    if (!groups.length) return '';
    const whole = unhurt + wounded.filter(v => v >= per).length;
    return [...(whole ? [`${whole} unhurt`] : []), ...groups].join(', ');
}

/** "2 unhurt, 1 at 5/9, 1 at 2/9" (the unhurt left out when none are), or '' when no model is wounded. */
export function woundParts(p: UnitHolder): string {
    if (!p.unit) return '';
    const s = modelState(p);
    return woundPartsOf(s.wounded, s.unhurt, s.per);
}

/** The owner's compact line: "4 alive: 2 unhurt, 1 at 5/9, 1 at 2/9". */
export function woundLine(p: UnitHolder): string {
    if (!p.unit) return '';
    const n = liveModels(p);
    if (n === 0) return '0 alive';
    return `${n} alive: ${woundParts(p) || `${n} unhurt`}`;
}

/**
 * A blow that is not an area takes one model at most: the most wounded
 * model's HP (lane W; before, the front model's share of the pool).
 */
export function unitCapFor(target: UnitHolder, damage: number): { damage: number; cap?: { before: number; after: number } } {
    if (!target.unit || target.hp <= 0 || damage <= 0) return { damage };
    const s = modelState(target);
    const front = s.wounded[0] ?? (s.unhurt > 0 ? s.per : 0);
    if (damage <= front) return { damage };
    return { damage: front, cap: { before: damage, after: front } };
}

export function unitCapLine(cap: { before: number; after: number }): string {
    return `one model at most: ${cap.before} → ${cap.after} (not an area: pass area: true, or modelsInArea, for an area effect)`;
}

export function volleyTier(p: Pick<CombatParticipant, 'hp' | 'unit'>): VolleyTier | null {
    const u = p.unit;
    if (!u) return null;
    const tiers = u.tiers?.length ? u.tiers : DEFAULT_TIERS;
    const models = liveModels(p);
    const drops = [u.suppressed && 'suppressed', u.inMelee && 'in melee', u.brokenFormation && 'broken formation'].filter(Boolean) as string[];
    if (models === 0) return { dice: null, models, maxModels: u.models, step: -1, drops, reason: 'no models left' };
    const strength = models / u.models;
    let step = tiers.findIndex(t => strength >= t.minFraction);
    if (step < 0) step = tiers.length - 1;
    step = Math.min(tiers.length - 1, step + drops.length);
    const reason = `${models}/${u.models} models${drops.map(d => `, ${d} −1`).join('')}`;
    return { dice: tiers[step].dice, models, maxModels: u.models, step, drops, reason };
}

export function describeUnit(p: Pick<CombatParticipant, 'hp' | 'unit'>): string {
    const t = volleyTier(p);
    if (!p.unit || !t) return '';
    // Lane W: the wounded, compactly ("· 2 unhurt, 1 at 5/9, 1 at 2/9"), when any are.
    const wounds = woundParts(p);
    return `${p.unit.routed ? 'ROUTED · ' : ''}×${t.models}/${t.maxModels} ${p.unit.packed ? 'packed' : 'spaced'} · volley ${t.dice ?? 'none'}${t.drops.length ? ` (${t.drops.join(', ')})` : ''}${wounds ? ` · ${wounds}` : ''}`;
}

/**
 * Play report 7 #1: what an area did to a unit, model by model. Lane W: the
 * models inside are taken most wounded first (all of a packed unit, or
 * modelsInArea of a spaced one); each takes `full`, or `half` when its own
 * save passed, and dies when that meets or beats its current HP; a survivor
 * keeps the wound (unit.wounded), so the next area or tick finds it hurt.
 * hpLost is what the models actually took, dead and wounded alike. Pure: the
 * caller applies modelDamage with applyToModels (engine.applyDamage's
 * models option).
 */
export interface UnitAreaResult {
    modelsBefore: number;
    maxModels: number;
    hpPerModel: number;
    /** The most wounded model's HP before the area (hpPerModel unless wounded). */
    frontHp: number;
    /** Lane W: how many of the models inside were already wounded (they are inside first). */
    woundedInside?: number;
    /** Lane W: those wounded models, grouped ("3 at 3/9"). */
    woundedFirst?: string;
    modelsInArea: number;
    /** Saves rolled: failed and passed. Both 0 when the area allows none. */
    failed: number;
    saved: number;
    /** The area allowed no save: every model inside took the full damage. */
    noSave?: true;
    /** The damage a model takes on a failed save (full) and on a success (half). */
    perModel: { full: number; half: number };
    modelsKilled: number;
    modelsAfter: number;
    /** HP off the unit's pool: what the models took, the dead models' HP and the survivors' wounds. */
    hpLost: number;
    /** Lane W: the damage each model inside takes, most wounded first; applyToModels lands it. */
    modelDamage: number[];
    /** Lane W: the wounded after the area, compactly ("4 at 5/9"); '' when none are. */
    woundsAfter: string;
    /**
     * Models inside that are still standing, by their save (both 0 when the
     * area allowed none). A save's rider lands on the unit by what these got:
     * the dead take no condition.
     */
    standing: { failed: number; saved: number };
}

export function areaOnUnit(
    p: Pick<CombatParticipant, 'hp' | 'unit'>,
    opts: { damage: number; half?: number; modelsInArea: number; saves?: boolean[] }
): UnitAreaResult {
    const u = p.unit;
    const hpPerModel = u?.hpPerModel ?? 1;
    const s: ModelState = u ? modelState(p) : { wounded: [], unhurt: 0, per: hpPerModel, models: 0 };
    const W = s.wounded.length;
    const modelsBefore = liveOf(s);
    // The i-th model's HP, most wounded first (the unhurt after the wounded).
    const hpAt = (i: number) => i < W ? s.wounded[i] : s.per;
    const frontHp = modelsBefore > 0 ? hpAt(0) : 0;
    const full = Math.max(0, opts.damage);
    const half = Math.max(0, opts.half ?? Math.floor(full / 2));
    const inside = Math.max(0, Math.min(modelsBefore, Math.floor(opts.modelsInArea)));
    let failed = 0, saved = 0, modelsKilled = 0, hpLost = 0;
    const standing = { failed: 0, saved: 0 };
    const modelDamage: number[] = [];
    // After the area: the survivors inside, the wounded outside as they were, the unhurt outside counted.
    const afterWounded: number[] = s.wounded.slice(inside);
    const unhurtAfter = s.unhurt - Math.max(0, inside - W);
    for (let i = 0; i < inside; i++) {
        const passed = !!opts.saves?.[i];
        if (opts.saves) { if (passed) saved++; else failed++; }
        const dmg = passed ? half : full;
        modelDamage.push(dmg);
        const hp = hpAt(i);
        if (dmg > 0 && dmg >= hp) { modelsKilled++; hpLost += hp; }
        else {
            hpLost += dmg;
            afterWounded.push(hp - dmg);
            if (opts.saves) { if (passed) standing.saved++; else standing.failed++; }
        }
    }
    const hurtInside = s.wounded.slice(0, Math.min(inside, W));
    const woundsAfter = u ? woundPartsOf(afterWounded, unhurtAfter, hpPerModel) : '';
    return {
        modelsBefore, maxModels: u?.models ?? 0, hpPerModel, frontHp,
        ...(hurtInside.length ? { woundedInside: hurtInside.length, woundedFirst: woundGroups(hurtInside, hpPerModel).join(', ') } : {}),
        modelsInArea: inside,
        failed, saved, ...(opts.saves ? {} : { noSave: true as const }),
        perModel: { full, half }, modelsKilled, modelsAfter: modelsBefore - modelsKilled, hpLost, modelDamage, woundsAfter, standing
    };
}

/**
 * The owner's report line: "6 in the cone: 4 failed, 2 saved; 31 / 15 vs 9
 * HP each: 6 dead, 0/6 left". Lane W adds the wounded inside before ("(front
 * 5)", or "(wounded first: 3 at 3/9)") and after ("3/6 left (3 at 3/9)").
 */
export function unitAreaLine(p: Pick<CombatParticipant, 'unit'>, r: UnitAreaResult, shape = 'area'): string {
    const where = r.modelsInArea < r.modelsBefore ? `${r.modelsInArea} of ${r.modelsBefore}` : `${r.modelsInArea}`;
    const hurt = r.woundedInside ?? (r.modelsInArea > 0 && r.frontHp !== r.hpPerModel ? 1 : 0);
    const front = hurt === 1 ? ` (front ${r.frontHp})` : hurt > 1 && r.woundedFirst ? ` (wounded first: ${r.woundedFirst})` : '';
    const head = r.noSave
        ? `${where} in the ${shape}, no save: ${r.perModel.full}`
        : `${where} in the ${shape}: ${r.failed} failed, ${r.saved} saved; ${r.perModel.full} / ${r.perModel.half}`;
    const wounds = r.modelsAfter > 0 && r.woundsAfter ? ` (${r.woundsAfter})` : '';
    return `${head} vs ${r.hpPerModel} HP each${front}: ${r.modelsKilled} dead, ${r.modelsAfter}/${p.unit?.models ?? r.maxModels} left${wounds}`;
}

const UNIT_ABILITY_LONG: Record<string, string> = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
const UNIT_ABILITY_SHORT: Record<string, string> = Object.fromEntries(Object.entries(UNIT_ABILITY_LONG).map(([s, l]) => [l, s]));

/**
 * Play report 7 #1: a unit's save bonus against an area: the token's ability
 * modifier (abilityScores, long or short keys; 10 when unset) plus the
 * drilled bonus in unit.saves. Each model rolls with it.
 */
export function unitSaveBonus(
    p: { abilityScores?: Partial<Record<string, number>>; unit?: { saves?: Partial<Record<string, number>> } },
    ability: string
): { ability: string; mod: number; drilled: number; total: number; parts: string[] } {
    const a = ability.trim().toLowerCase();
    const long = UNIT_ABILITY_SHORT[a] ? a : UNIT_ABILITY_LONG[a] ?? 'dexterity';
    const short = UNIT_ABILITY_SHORT[long];
    const score = p.abilityScores?.[long] ?? p.abilityScores?.[short] ?? 10;
    const mod = Math.floor((score - 10) / 2);
    const drilled = p.unit?.saves?.[short] ?? 0;
    const parts = [`${short.toUpperCase()} ${mod >= 0 ? '+' : ''}${mod}`];
    if (drilled) parts.push(`drilled ${drilled >= 0 ? '+' : ''}${drilled}`);
    return { ability: long, mod, drilled, total: mod + drilled, parts };
}

/** A unit owes a break test when it drops through this fraction of its models, unless it sets its own breakAt. */
export const DEFAULT_BREAK_AT = 0.5;

/** One labelled term added to a unit's morale for a break test (a banner, a battle cry, mob rule). */
export interface MoraleModifier { label: string; value: number }

export interface BreakTest {
    participantId: string;
    name: string;
    modelsBefore: number;
    modelsAfter: number;
    maxModels: number;
    breakAt: number;
    /** The unit's own morale, when it has one. */
    morale?: number;
    modifiers: MoraleModifier[];
    /** The modifiers summed. */
    moraleBonus: number;
    /** morale + moraleBonus, when morale is set. */
    moraleTotal?: number;
    /** The call that routs the unit when the GM's test fails. */
    setUnit: string;
    /** The BREAK TEST DUE line for the banner. */
    line: string;
}

/**
 * A break test is due when damage carries a unit from above its breakAt
 * fraction of models (default half) to at or below it, the unit still
 * stands, and it has not already routed. Only the crossing counts: losses
 * below the line owe no second test. The engine flags; the GM rolls, and
 * routs the unit with set_unit {routed: true}. moraleBonus terms (a banner,
 * a battle cry, mob rule) add to the morale as one labelled sum.
 */
export function breakTestDue(
    p: Pick<CombatParticipant, 'id' | 'name' | 'hp' | 'unit'>,
    hpBefore: number,
    opts: { moraleBonus?: MoraleModifier[] } = {}
): BreakTest | null {
    const u = p.unit;
    if (!u || u.routed) return null;
    // Lane W: the count at hpBefore is read back through this process's
    // writes (the pool alone cannot say how many wounded models it held).
    const modelsBefore = modelsAtHp(p, hpBefore);
    const modelsAfter = liveModels(p);
    if (modelsAfter <= 0) return null;
    const breakAt = u.breakAt ?? DEFAULT_BREAK_AT;
    if (!(modelsBefore / u.models > breakAt && breakAt >= modelsAfter / u.models)) return null;
    const modifiers = (opts.moraleBonus ?? []).filter(m => m.value !== 0);
    const moraleBonus = modifiers.reduce((a, m) => a + m.value, 0);
    const moraleTotal = u.morale !== undefined ? u.morale + moraleBonus : undefined;
    const terms = modifiers.map(m => ` ${m.value >= 0 ? '+' : ''}${m.value} (${m.label})`).join('');
    const moraleText = u.morale !== undefined
        ? `morale ${u.morale}${terms}${modifiers.length ? ` = ${moraleTotal}` : ''}`
        : `morale unset${terms ? `, bonus${terms}` : ''}`;
    const setUnit = `combat_manage set_unit {participantId: '${p.id}', routed: true}`;
    return {
        participantId: p.id, name: p.name, modelsBefore, modelsAfter, maxModels: u.models, breakAt,
        ...(u.morale !== undefined ? { morale: u.morale } : {}),
        modifiers, moraleBonus,
        ...(moraleTotal !== undefined ? { moraleTotal } : {}),
        setUnit,
        line: `BREAK TEST DUE: ${p.name} fell to ${modelsAfter}/${u.models} models (break at ${Math.round(breakAt * 100)}%): ${moraleText}. Roll it; on a failure ${setUnit}`
    };
}

/**
 * The morale terms a unit brings to its break test: mob rule (+1 per `per`
 * live models, plus allied units nearby when set, capped at maxBonus) and
 * each battle-cry buff's moraleBonus. Pass them to breakTestDue.
 */
export function moraleModifiers(
    p: CombatParticipant,
    participants: CombatParticipant[] = [],
    speciesOf?: SpeciesOf
): MoraleModifier[] {
    const out: MoraleModifier[] = [];
    const mob = p.unit?.mobRule;
    if (p.unit && mob) {
        let models = liveModels(p);
        if (mob.nearby) models += nearbyAllies(participants, p, { range: mob.nearby.range, match: mob.nearby.match, unitsOnly: true }, speciesOf).count;
        let bonus = Math.floor(models / mob.per);
        if (mob.maxBonus !== undefined) bonus = Math.min(bonus, mob.maxBonus);
        if (bonus) out.push({ label: `mob rule (${models} models)`, value: bonus });
    }
    for (const b of p.buffs ?? []) if (b.moraleBonus) out.push({ label: b.name, value: b.moraleBonus });
    return out;
}

/** Mob rule to hit: +1 per attackBonusPer live models, or 0. */
export function mobAttackBonus(p: Pick<CombatParticipant, 'hp' | 'unit'>): { bonus: number; models: number } {
    const per = p.unit?.mobRule?.attackBonusPer;
    if (!p.unit || !per) return { bonus: 0, models: 0 };
    const models = liveModels(p);
    return { bonus: Math.floor(models / per), models };
}
