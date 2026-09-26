import seedrandom from 'seedrandom';
import type Database from 'better-sqlite3';
import { freshSeed } from './seed.js';
import { recordRolls, type RollLogEntry } from '../storage/roll-log.js';
import { currentOperation } from '../server/operation-guard.js';

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
