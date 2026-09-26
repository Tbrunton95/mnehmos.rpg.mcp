import seedrandom from 'seedrandom';
import type Database from 'better-sqlite3';
import { freshSeed } from './seed.js';
import { recordRolls, type RollLogEntry } from '../storage/roll-log.js';
import { currentOperation } from '../server/operation-guard.js';
import { parseDiceTerms } from '../engine/combat/rng.js';

/**
 * Seeded d20 for rolls made outside an encounter's stream (math_manage
 * checks, concentration_manage saves). The seed is kept so roll_log can
 * replay it. Advantage plus disadvantage cancel to a single die.
 */
export function d20(advantage?: boolean, disadvantage?: boolean, seed: string = freshSeed('check')): { rolls: number[]; natural: number; seed: string } {
    const rng = seedrandom(seed);
    const r = () => Math.floor(rng() * 20) + 1;
    if (advantage && !disadvantage) { const a = r(), b = r(); return { rolls: [a, b], natural: Math.max(a, b), seed }; }
    if (disadvantage && !advantage) { const a = r(), b = r(); return { rolls: [a, b], natural: Math.min(a, b), seed }; }
    const a = r(); return { rolls: [a], natural: a, seed };
}

/** Store a roll in roll_log under the running operation. */
export function logRoll(db: Database.Database, entry: RollLogEntry, fallbackTool = 'math_manage'): string | undefined {
    try {
        const op = currentOperation();
        return recordRolls(db, [entry], { opId: op?.opId, tool: op?.tool ?? fallbackTool })[0];
    } catch { return undefined; }
}

/** One seeded d20 (or 2d20 keep one), logged, returning the kept die. */
export function loggedD20(
    db: Database.Database,
    tag: { purpose: string; forId?: string; targetId?: string },
    opts: { advantage?: boolean; disadvantage?: boolean; tool?: string } = {}
): { rolls: number[]; natural: number; seed: string; rollId?: string } {
    const roll = d20(opts.advantage, opts.disadvantage, freshSeed(tag.purpose.replace(/\s+/g, '-')));
    const expression = opts.advantage && !opts.disadvantage ? '2d20kh1' : opts.disadvantage && !opts.advantage ? '2d20kl1' : '1d20';
    const rollId = logRoll(db, {
        purpose: tag.purpose, forId: tag.forId, targetId: tag.targetId, expression,
        dice: roll.rolls.map(value => ({ sides: 20, value })), result: roll.natural, replay: roll.seed
    }, opts.tool);
    return { ...roll, rollId };
}

/** `count` seeded dice of `sides` (surface damage outside an encounter), logged. */
export function loggedDice(
    db: Database.Database,
    tag: { purpose: string; forId?: string; targetId?: string },
    count: number,
    sides: number,
    tool?: string
): { rolls: number[]; total: number; seed: string; rollId?: string } {
    const seed = freshSeed(tag.purpose.replace(/\s+/g, '-'));
    const rng = seedrandom(seed);
    const rolls = Array.from({ length: count }, () => Math.floor(rng() * sides) + 1);
    const total = rolls.reduce((a, b) => a + b, 0);
    const rollId = logRoll(db, {
        purpose: tag.purpose, forId: tag.forId, targetId: tag.targetId, expression: `${count}d${sides}`,
        dice: rolls.map(value => ({ sides, value })), result: total, replay: seed
    }, tool);
    return { rolls, total, seed, rollId };
}

/**
 * Any dice notation ('2d6+1', '1d100', '1d4-1d4+10'), seeded and logged. The
 * seed is kept so roll_log can replay it; pass one only to replay exactly.
 * rolls are the dice in order, negative for a subtracted term.
 */
export function loggedRoll(
    db: Database.Database,
    tag: { purpose: string; forId?: string; targetId?: string },
    notation: string,
    opts: { seed?: string; tool?: string } = {}
): { total: number; rolls: number[]; seed: string; rollId?: string } {
    const terms = parseDiceTerms(notation);
    const seed = opts.seed ?? freshSeed(tag.purpose.replace(/\s+/g, '-'));
    const rng = seedrandom(seed);
    const rolls: number[] = [];
    const dice: Array<{ sides: number; value: number }> = [];
    let total = 0;
    for (const t of terms) {
        if (t.kind === 'dice') {
            for (let i = 0; i < t.count; i++) {
                const v = Math.floor(rng() * t.sides) + 1;
                dice.push({ sides: t.sides, value: v });
                rolls.push(t.sign * v);
                total += t.sign * v;
            }
        } else total += t.sign * t.value;
    }
    const rollId = logRoll(db, {
        purpose: tag.purpose, forId: tag.forId, targetId: tag.targetId, expression: notation.replace(/\s+/g, ''),
        dice, result: total, replay: seed
    }, opts.tool);
    return { total, rolls, seed, rollId };
}

/**
 * The one dice shape tables, miscasts and offerings take: roll a notation
 * under a purpose tag. loggedRoller rolls outside an encounter;
 * engineRoller rolls on an encounter's own seeded stream.
 */
export type DiceRoller = (notation: string, tag: string) => { total: number; rolls: number[]; rollId?: string; seed?: string };

/**
 * A DiceRoller on loggedRoll. With a seed, the roller's n-th roll uses
 * `${seed}` (n = 0) then `${seed}:${n}`, so a whole sequence (a table and
 * its chains) replays from one seed.
 */
export function loggedRoller(db: Database.Database, opts: { forId?: string; targetId?: string; tool?: string; seed?: string } = {}): DiceRoller {
    let n = 0;
    return (notation, tag) => {
        const seed = opts.seed === undefined ? undefined : n === 0 ? opts.seed : `${opts.seed}:${n}`;
        n++;
        return loggedRoll(db, { purpose: tag, forId: opts.forId, targetId: opts.targetId }, notation, { seed, tool: opts.tool });
    };
}

/** A DiceRoller on an encounter's stream (CombatEngine.rollDice), tagged for roll_log. */
export function engineRoller(
    engine: { rollDice(notation: string, tag: { purpose: string; forId?: string; targetId?: string }): { total: number; rolls: number[] } },
    opts: { forId?: string; targetId?: string } = {}
): DiceRoller {
    return (notation, tag) => {
        const r = engine.rollDice(notation, { purpose: tag, ...(opts.forId ? { forId: opts.forId } : {}), ...(opts.targetId ? { targetId: opts.targetId } : {}) });
        return { total: r.total, rolls: r.rolls };
    };
}
