/**
 * Play report 7 #1 (owner's spec): area damage on a unit token, per model.
 *
 * "Each model in the area rolls its own save, and the engine rolls them on
 * the fight's logged dice. Nobody rolls by hand." The damage is rolled once
 * by the caller; here each model inside rolls its save (the token's ability
 * modifier plus unit.saves, cover as for the unit), a failure takes the full
 * damage and a success half (none when the effect says so), resistances and
 * the band scale apply per model, and areaOnUnit counts the dead. The caller
 * takes hpLost off the pool, so the break test reads the real count.
 *
 * Which models are inside: a packed unit, every live model unless the GM
 * gives a count; a spaced unit, only the count the GM gives (modelsInArea,
 * read off combat_map aoe's hint). A spaced unit with no count is refused
 * before anything is rolled or spent.
 *
 * Damage to a unit that is not an area hits one model at most (unitCapFor),
 * as a single blow does (engine.ts executeAttack).
 */
import type Database from 'better-sqlite3';
import type { CombatEngine, CombatParticipant } from './engine.js';
import { areaOnUnit, liveModels, unitAreaLine, unitSaveBonus, type UnitAreaResult } from './units.js';
import { rollParticipantSave, engineSaveDeclarations, toLongAbility } from './saves.js';
import type { BandDamageScale } from '../table-rules.js';

export { liveModels };

/** modelsInArea after its schema: {targetId: n}, '*' for every unit target. */
export type ModelsInArea = Record<string, number>;

/** The count the GM gave for this target (its own key, else '*'), if any. */
export function modelsInAreaFor(m: ModelsInArea | number | undefined, id: string): number | undefined {
    if (m === undefined || m === null) return undefined;
    if (typeof m === 'number') return m;
    return m[id] ?? m['*'];
}

export interface UnitAreaNeed { targetId: string; name: string; liveModels: number }

/** Spaced unit targets still standing with no count: the area cannot say which models it covers. */
export function unitsNeedingCount(participants: CombatParticipant[], targetIds: string[] | undefined, modelsInArea: ModelsInArea | number | undefined): UnitAreaNeed[] {
    const out: UnitAreaNeed[] = [];
    for (const id of targetIds ?? []) {
        const p = participants.find(x => x.id === id);
        if (!p?.unit || p.unit.packed) continue;
        const live = liveModels(p);
        if (live <= 0) continue;
        if (modelsInAreaFor(modelsInArea, id) === undefined) out.push({ targetId: id, name: p.name, liveModels: live });
    }
    return out;
}

/** The refusal for spaced units with no count, naming the exact key to add. */
export function areaCountMessage(needs: UnitAreaNeed[]): string {
    const names = needs.map(n => n.name).join(', ');
    const record = needs.map(n => `'${n.targetId}': <0-${n.liveModels}>`).join(', ');
    const what = needs.length === 1 ? `of its ${needs[0].liveModels} models` : 'of each unit\'s models';
    return `refused: ${names} ${needs.length === 1 ? 'is' : 'are'} spaced: say how many ${what} the area covers. `
        + `Call again with modelsInArea: {${record}} (a bare number applies to every unit target); combat_map aoe prints a modelsInArea hint per unit. `
        + `A packed unit needs none (every model is inside). Nothing was rolled or spent.`;
}

export function areaCountRefusal(needs: UnitAreaNeed[]): Error & { writes: 'none'; modelsInAreaNeeded: UnitAreaNeed[] } {
    const err = new Error(areaCountMessage(needs)) as Error & { writes: 'none'; modelsInAreaNeeded: UnitAreaNeed[] };
    err.writes = 'none';
    err.modelsInAreaNeeded = needs;
    return err;
}

/** Models of a unit that went down between two HP readings (the kills a blow or an area credits). */
export function modelsKilledBetween(unit: NonNullable<CombatParticipant['unit']>, hpBefore: number, hpAfter: number): number {
    return Math.max(0, liveModels({ hp: hpBefore, unit }) - liveModels({ hp: hpAfter, unit }));
}

/** A blow that is not an area takes one model at most: the front model's HP. */
export function unitCapFor(target: Pick<CombatParticipant, 'hp' | 'unit'>, damage: number): { damage: number; cap?: { before: number; after: number } } {
    if (!target.unit || target.hp <= 0 || damage <= 0) return { damage };
    const models = liveModels(target);
    const front = target.hp - (models - 1) * target.unit.hpPerModel;
    if (damage <= front) return { damage };
    return { damage: front, cap: { before: damage, after: front } };
}

export function unitCapLine(cap: { before: number; after: number }): string {
    return `one model at most: ${cap.before} → ${cap.after} (not an area: pass area: true, or modelsInArea, for an area effect)`;
}

/** One model's save, as the reply reports it. */
export interface UnitModelSave { model: number; natural: number; rolls: number[]; total: number; saved: boolean }

/** targets[].unitArea: what the area did to the unit. */
export interface UnitAreaReport extends UnitAreaResult {
    inAreaSource: 'packed' | 'given';
    shape: string;
    /** The modifier each model rolled with (the token's ability modifier, proficiency if any, drilled, cover). */
    saveBonus?: { ability: string; dc: number; total: number; drilled: number; parts: string[] };
    saves?: UnitModelSave[];
    /**
     * Play report 7 (lane G1): what put every model's save at advantage or
     * disadvantage (the unit token's untagged save:<ability> mechanics, read
     * once; its standard conditions' 5e rules), and the tag a tagged one waits for.
     */
    advantageSources?: string[];
    disadvantageSources?: string[];
    conditionalAdvantage?: string[];
    conditionalDisadvantage?: string[];
    /** The owner's line: "6 in the cone: 4 failed, 2 saved; 31 / 15 vs 9 HP each: 6 dead, 0/6 left". */
    line: string;
}

export interface UnitAreaRoll {
    report: UnitAreaReport;
    /** HP off the pool: the dead models' HP. */
    hpLost: number;
    /** Most models inside saved (ties count as failed): the unit's saved flag. */
    majoritySaved: boolean;
    /**
     * Which rider the unit takes: what most of the models still standing
     * inside got (ties: failed). Unset when no save was rolled or no model
     * inside is left standing: the dead take no condition.
     */
    riderResult?: 'saved' | 'failed';
    damageModifier: 'immune' | 'resistant' | 'vulnerable' | 'normal';
    bandScale?: { steps: number; multiplier: number; before: number; after: number };
}

/**
 * Roll the area on one unit: one save per model inside (front model first,
 * purpose '<effect> save (model n/N)' on the fight's logged dice), then
 * areaOnUnit. Nothing is written to the token; the caller applies hpLost.
 */
export function rollUnitArea(
    engine: CombatEngine,
    db: Database.Database | undefined,
    target: CombatParticipant,
    opts: {
        damage: number;
        halfOnSave: boolean;
        savingThrow?: { ability: string; dc: number };
        damageType?: string;
        /** Cover's bonus on this unit's DEX save (the same for every model). */
        coverBonus?: number;
        purpose: string;
        modelsInArea?: ModelsInArea | number;
        shape?: string;
        bandScaleFor?: (target: CombatParticipant) => BandDamageScale | null;
    }
): UnitAreaRoll {
    const modelsBefore = liveModels(target);
    const given = modelsInAreaFor(opts.modelsInArea, target.id);
    const inAreaSource: 'packed' | 'given' = given !== undefined ? 'given' : 'packed';
    const inside = Math.max(0, Math.min(modelsBefore, given ?? modelsBefore));
    const coverBonus = opts.coverBonus ?? 0;

    // One save per model inside, on the encounter's seeded, logged stream.
    let saves: boolean[] | undefined;
    let rows: UnitModelSave[] | undefined;
    let saveBonus: UnitAreaReport['saveBonus'];
    let labels: Pick<UnitAreaReport, 'advantageSources' | 'disadvantageSources' | 'conditionalAdvantage' | 'conditionalDisadvantage'> = {};
    if (opts.savingThrow) {
        const ability = toLongAbility(opts.savingThrow.ability) ?? 'dexterity';
        const bonus = unitSaveBonus(target as { abilityScores?: Partial<Record<string, number>>; unit?: { saves?: Partial<Record<string, number>> } }, ability);
        const extra = bonus.drilled + coverBonus;
        // Play report 7 (lane G1): the unit token's declared save sides, read
        // once and applied to every model (one token, one set of effects).
        const declared = inside > 0 ? engineSaveDeclarations(db, target.id, ability) : undefined;
        saves = [];
        rows = [];
        for (let i = 1; i <= inside; i++) {
            // A model's failed save never spends the token's legendary
            // resistance: that belongs to one creature, not to each of many.
            const s = rollParticipantSave(engine, db, target, ability, opts.savingThrow.dc, {
                purpose: `${opts.purpose} save (model ${i}/${inside})${coverBonus ? ` (cover +${coverBonus})` : ''}`,
                ...(extra ? { extraBonus: extra } : {}),
                noLegendaryResistance: true,
                declared
            });
            saves.push(s.saved);
            rows.push({ model: i, natural: s.natural, rolls: s.rolls, total: s.total, saved: s.saved });
            if (i === 1) {
                labels = {
                    ...(s.advantageSources ? { advantageSources: s.advantageSources } : {}),
                    ...(s.disadvantageSources ? { disadvantageSources: s.disadvantageSources } : {}),
                    ...(s.conditionalAdvantage ? { conditionalAdvantage: s.conditionalAdvantage } : {}),
                    ...(s.conditionalDisadvantage ? { conditionalDisadvantage: s.conditionalDisadvantage } : {})
                };
            }
            if (!saveBonus) {
                // The parts as rollParticipantSave composed them, with the drilled and cover terms named.
                const parts = s.parts.filter(p => !/^bonus /.test(p));
                if (bonus.drilled) parts.push(`drilled ${bonus.drilled >= 0 ? '+' : ''}${bonus.drilled}`);
                if (coverBonus) parts.push(`cover +${coverBonus}`);
                saveBonus = { ability, dc: opts.savingThrow.dc, total: s.modifier, drilled: bonus.drilled, parts };
            }
        }
        if (!saveBonus) {
            saveBonus = { ability, dc: opts.savingThrow.dc, total: bonus.total + coverBonus, drilled: bonus.drilled, parts: [...bonus.parts, ...(coverBonus ? [`cover +${coverBonus}`] : [])] };
        }
    }

    // A failure takes the roll, a success half of it (none when the effect
    // says so); resistances apply after the save, then the band scale, per model.
    const fullRaw = Math.max(0, opts.damage);
    const halfRaw = opts.halfOnSave ? Math.floor(fullRaw / 2) : 0;
    const fullMod = engine.calculateDamageWithModifiers(fullRaw, opts.damageType, target);
    const halfMod = engine.calculateDamageWithModifiers(halfRaw, opts.damageType, target);
    let full = fullMod.finalDamage;
    let half = halfMod.finalDamage;
    let bandScale: UnitAreaRoll['bandScale'];
    const scale = full > 0 || half > 0 ? opts.bandScaleFor?.(target) : null;
    if (scale) {
        const scaled = (x: number) => x > 0 ? Math.max(1, Math.floor(x * scale.multiplier)) : 0;
        bandScale = { ...scale, before: full, after: scaled(full) };
        full = scaled(full);
        half = scaled(half);
    }

    const result = areaOnUnit(target, { damage: full, half, modelsInArea: inside, ...(saves ? { saves } : {}) });
    const shape = opts.shape ?? 'area';
    const report: UnitAreaReport = {
        ...result, inAreaSource, shape,
        ...(saveBonus ? { saveBonus } : {}),
        ...(rows ? { saves: rows } : {}),
        ...labels,
        line: unitAreaLine(target, result, shape)
    };
    const { standing } = result;
    const riderResult = saves && standing.saved + standing.failed > 0 ? (standing.saved > standing.failed ? 'saved' as const : 'failed' as const) : undefined;
    return { report, hpLost: result.hpLost, majoritySaved: result.saved > result.failed, ...(riderResult ? { riderResult } : {}), damageModifier: fullMod.modifier, ...(bandScale ? { bandScale } : {}) };
}

/**
 * Play report 7 #1: the unit's report as one line for unitLines, the field
 * output_mode 'summary' keeps whole: "Militia — 6 in the cone: 4 failed,
 * 2 saved; 31 / 15 vs 9 HP each: 6 dead, 0/6 left", with the break test named.
 */
export function unitSummaryLine(name: string, report: Pick<UnitAreaReport, 'line'>, breakTest?: { moraleTotal?: number } | null): string {
    return `${name} — ${report.line}${breakTest ? `; BREAK TEST DUE${breakTest.moraleTotal !== undefined ? ` (morale ${breakTest.moraleTotal})` : ''}` : ''}`;
}

/**
 * The saves line under the unit's report: "Saves vs DC 13 (DEX +1, drilled +2
 * = +3): 20✓ 4✗ …"; play report 7 (lane G1) adds the sources every model's
 * save took ("…= +3; adv: Shield Drill (save:dex)") and the tag a tagged one
 * waits for.
 */
export function unitSavesLine(report: UnitAreaReport): string | undefined {
    if (!report.saveBonus || !report.saves?.length) return undefined;
    const b = report.saveBonus;
    const shown = report.saves.slice(0, 30).map(s => `${s.natural}${s.saved ? '✓' : '✗'}`).join(' ');
    const adv = report.advantageSources ?? [], dis = report.disadvantageSources ?? [];
    const sides = [adv.length ? `; adv: ${adv.join(', ')}` : '', dis.length ? `; dis: ${dis.join(', ')}` : '', adv.length && dis.length ? '; cancel: one die' : ''].join('');
    const conditional = [...(report.conditionalAdvantage ?? []), ...(report.conditionalDisadvantage ?? [])].map(c => `\n   conditional: ${c}`).join('');
    return `Saves vs DC ${b.dc} (${b.parts.join(', ')} = ${b.total >= 0 ? '+' : ''}${b.total}${sides}): ${shown}${report.saves.length > 30 ? ` … (${report.saves.length} in all)` : ''}${conditional}`;
}
