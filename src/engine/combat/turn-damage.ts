/**
 * Play report 7 follow-up (lane O): the damage a turn's start or end deals by
 * itself (water pressure, a condition's ongoing damage), as the engine
 * records it for the handlers (CombatEngine.turnDamage, beside endOfTurnSaves).
 *
 * The owner's rule: "damage resolves by its shape, not by which code path
 * delivered it." Pressure is an area (every model in the deep water, each
 * separately); ongoing damage follows its source's shape (single: the most
 * wounded model, capped at it; area: per model inside, each with its own
 * save). The handlers read these rows to owe a unit's break test, print its
 * unit line and settle a tracked creature the tick dropped or killed.
 *
 * Pure: the types, and the lines the engine prints.
 */
import type { DyingUpdate } from './dying.js';
import type { UnitAreaResult } from './units.js';

/** A save the engine rolled against a tick: one creature's, or one model's (rows of a unit's area). */
export interface TickSave {
    ability: string;
    dc: number;
    rolls: number[];
    natural: number;
    modifier: number;
    total: number;
    saved: boolean;
    parts: string[];
    advantage?: string[];
    disadvantage?: string[];
    conditional?: string[];
}

/** A unit's area tick, model by model (areaOnUnit's report, its saves and the owner's line). */
export interface TickUnitArea extends Omit<UnitAreaResult, 'modelDamage'> {
    saveBonus?: { ability: string; dc: number; total: number; drilled: number; parts: string[] };
    saves?: Array<{ model: number; natural: number; rolls: number[]; total: number; saved: boolean }>;
    advantageSources?: string[];
    disadvantageSources?: string[];
    line: string;
}

export interface TurnDamageEvent {
    participantId: string;
    name: string;
    /** 'pressure' (the deep water) or 'ongoing' (a condition's ongoing damage). */
    source: 'pressure' | 'ongoing';
    /** ongoing: the condition that ticked and its instance id. */
    condition?: string;
    conditionId?: string;
    when: 'start' | 'end';
    /** How it landed: on one creature or one model ('single'), or per model of a unit ('area'). */
    shape: 'single' | 'area';
    /** The damage rolled once, before saves and resistances. */
    rolled: number;
    damageType?: string;
    /** What it dealt: a creature's damage after its save and resistances; a unit's HP off the pool. */
    damage: number;
    hpBefore: number;
    hpAfter: number;
    /** The save of a creature, or of the one model a single tick lands on. */
    save?: TickSave;
    /** A unit's area tick, model by model. */
    unitArea?: TickUnitArea;
    /** A single tick on a unit: one model at most. */
    unitCap?: { before: number; after: number };
    modelsBefore?: number;
    modelsAfter?: number;
    modelsKilled?: number;
    /** An area condition on a unit: the models it covers after this tick. */
    modelsInArea?: number;
    /** A unit's wound line after the tick ("4 alive: 2 unhurt, 1 at 5/9, 1 at 2/9"). */
    wounds?: string;
    /** Why the condition ended on this tick: 'saved', 'its model died', 'no model left in the area'. */
    conditionEnded?: string;
    /** autoLegendaryResistance turned the failed save into a success. */
    legendaryResisted?: true;
    /** The failed save offered legendary resistance: the saveRef, the call, the HP it heals back. */
    legendaryOffer?: { saveRef: string; remaining: number; of?: number; askPlayer?: true; refund: number; call: string };
    /** What the tick did to a tracked creature at or into 0 HP. */
    dying?: DyingUpdate;
    /** The handlers' concentration save after the tick (a tick is damage): the spell, the save, whether it broke. */
    concentration?: { spell: string; broken: boolean; reason: string; saveRoll?: number; saveTotal?: number; saveDC?: number };
    /** A unit's line for unitLines, without its name ("burning (start of turn): 6 in the area, …"). */
    unitLine?: string;
    /** The turn note. */
    line: string;
}

/** A tick's save as the reply carries it (the provider's reading left behind). */
export function tickSaveRow(s: TickSave & { read?: unknown }): TickSave {
    const { read: _read, ...row } = s;
    return row;
}

/** 'DEX save d20 9 + 2 = 11 vs DC 13 (DEX +2)' and the dice note when two were rolled. */
export function tickSaveText(s: TickSave, sidesNote = ''): string {
    const short = s.ability.slice(0, 3).toUpperCase();
    return `${short} save d20 ${s.natural} ${s.modifier >= 0 ? '+' : '-'} ${Math.abs(s.modifier)} = ${s.total} vs DC ${s.dc}${s.parts.length ? ` (${s.parts.join(', ')})` : ''}${sidesNote}`;
}

/** The saves line under a unit's area tick: "Saves vs DC 12 (CON +0, drilled +2 = +2): 15✓ 2✗ …". */
export function tickUnitSavesLine(a: Pick<TickUnitArea, 'saveBonus' | 'saves' | 'advantageSources' | 'disadvantageSources'>): string | undefined {
    if (!a.saveBonus || !a.saves?.length) return undefined;
    const b = a.saveBonus;
    const shown = a.saves.slice(0, 30).map(s => `${s.natural}${s.saved ? '✓' : '✗'}`).join(' ');
    const adv = a.advantageSources ?? [], dis = a.disadvantageSources ?? [];
    const sides = [adv.length ? `; adv: ${adv.join(', ')}` : '', dis.length ? `; dis: ${dis.join(', ')}` : '', adv.length && dis.length ? '; cancel: one die' : ''].join('');
    return `Saves vs DC ${b.dc} (${b.parts.join(', ')} = ${b.total >= 0 ? '+' : ''}${b.total}${sides}): ${shown}${a.saves.length > 30 ? ` … (${a.saves.length} in all)` : ''}`;
}

/** '4 fire', '4 damage', or '2 fire (resistant, 4 rolled)'. */
export function tickDamageText(dealt: number, rolledBeforeModifier: number, damageType: string | undefined, modifier: string): string {
    return `${dealt} ${damageType ?? 'damage'}${modifier !== 'normal' ? ` (${modifier}, ${rolledBeforeModifier} rolled)` : ''}`;
}
