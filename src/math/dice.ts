import seedrandom from 'seedrandom';
import { DiceExpression, CalculationResult } from './schemas.js';
import { assertNotCryptoKey, cryptoInt, cryptoReplayKey } from './crypto-dice.js';
import { parseDiceTerms, type DiceTerm } from '../engine/combat/rng.js';

/**
 * Dice for math_manage and other rolls outside an encounter. Without a seed
 * the engine rolls crypto dice (the table default) and its `seed` is the
 * roll's 'crypto:<nonce>' audit key; with a seed it is a replayable
 * seedrandom stream.
 */
export class DiceEngine {
    /** Backstop for one die's explosion chain; parse() already refuses d1!. */
    static readonly MAX_EXPLOSIONS = 100;

    readonly mode: 'crypto' | 'seeded';
    private rng: seedrandom.PRNG | null;
    /** The seed (seeded) or the 'crypto:<nonce>' audit key (crypto) written to roll_log.replay. */
    private seed: string;

    constructor(seed?: string) {
        if (seed) {
            assertNotCryptoKey(seed);
            this.mode = 'seeded';
            this.seed = seed;
            this.rng = seedrandom(seed);
        } else {
            this.mode = 'crypto';
            this.seed = cryptoReplayKey();
            this.rng = null;
        }
    }

    /** 'crypto' or 'seeded:<seed>', for a reply. */
    describe(): string {
        return this.mode === 'crypto' ? 'crypto' : `seeded:${this.seed}`;
    }

    /** The replay key this engine's rolls log: the seed, or 'crypto:<nonce>'. */
    get replayKey(): string {
        return this.seed;
    }

    private die(sides: number): number {
        return this.rng ? Math.floor(this.rng() * sides) + 1 : cryptoInt(sides);
    }

    /** NdX, dX (1dX), NdX+M, NdXdl1, NdXkh2, NdXdl1+5, NdX! */
    private static readonly SINGLE_TERM = /^(\d+)?d(\d+)(?:(dl|dh|kl|kh)(\d+))?([+-]\d+)?(!)?$/;

    /**
     * A sum of dice and numbers ('6d10+3d10+4', '2d6+1d4-1'): two or more
     * terms with at least one dice term. null when the text is not one.
     */
    static multiTerms(expression: string): DiceTerm[] | null {
        let terms: DiceTerm[];
        try { terms = parseDiceTerms(expression); } catch { return null; }
        if (terms.length < 2 || !terms.some(t => t.kind === 'dice')) return null;
        return terms;
    }

    private rollTerms(expression: string, terms: DiceTerm[]): CalculationResult {
        const dice: Array<{ sides: number; value: number; sign: 1 | -1 }> = [];
        const steps: string[] = [];
        let total = 0;
        for (const t of terms) {
            const sign = t.sign < 0 ? '-' : '+';
            if (t.kind === 'dice') {
                const values = Array.from({ length: t.count }, () => this.die(t.sides));
                for (const value of values) dice.push({ sides: t.sides, value, sign: t.sign });
                const sum = values.reduce((a, b) => a + b, 0);
                total += t.sign * sum;
                steps.push(`${sign} ${t.count}d${t.sides}: [${values.join(', ')}] = ${sum}`);
            } else {
                total += t.sign * t.value;
                steps.push(`${sign} ${t.value}`);
            }
        }
        steps.push(`Total: ${total}`);
        return {
            input: expression,
            result: total,
            steps,
            timestamp: new Date().toISOString(),
            seed: this.seed,
            metadata: { rolls: dice.map(d => d.value), dice }
        };
    }

    // Parse string "2d6+4" into DiceExpression object
    parse(expression: string): DiceExpression {
        const match = expression.match(DiceEngine.SINGLE_TERM);
        if (!match) {
            throw new Error(`Invalid dice expression: ${expression}`);
        }

        const count = match[1] ? parseInt(match[1], 10) : 1; // Default to 1 if omitted
        const sides = parseInt(match[2], 10);
        const modifierType = match[3]; // dl, dh, kl, kh
        const modifierCount = match[4] ? parseInt(match[4], 10) : 0;
        const modifier = match[5] ? parseInt(match[5], 10) : 0;
        const explode = !!match[6];
        if (explode && sides < 2) {
            // A d1 always rolls its maximum, so it would explode forever.
            throw new Error(`Invalid dice expression: ${expression} — exploding dice need at least 2 sides`);
        }

        const result: DiceExpression = {
            count,
            sides,
            modifier,
            explode
        };

        // Add drop/keep modifiers
        if (modifierType === 'dl') result.dropLowest = modifierCount;
        else if (modifierType === 'dh') result.dropHighest = modifierCount;
        else if (modifierType === 'kl') result.keepLowest = modifierCount;
        else if (modifierType === 'kh') result.keepHighest = modifierCount;

        return result;
    }

    roll(expression: string | DiceExpression): CalculationResult {
        // Play report: '6d10+3d10' was refused, which pushed the GM to an
        // outside RNG. When the single-term grammar (keep/drop, explode)
        // does not match, a multi-term sum rolls on this same seeded stream.
        if (typeof expression === 'string' && !DiceEngine.SINGLE_TERM.test(expression)) {
            const terms = DiceEngine.multiTerms(expression);
            if (terms) return this.rollTerms(expression, terms);
        }
        const expr = typeof expression === 'string' ? this.parse(expression) : expression;
        const rolls: number[] = [];
        const steps: string[] = [];

        let total = 0;

        // Advantage/Disadvantage logic would typically be handled by rolling twice
        // but here we just implement standard rolling.
        // If advantage is requested, the caller should probably call roll twice or we extend this.
        // The schema has advantage/disadvantage flags, so let's support them if passed in object.

        if (expr.advantage || expr.disadvantage) {
            // Roll two sets
            const set1 = this.rollSet(expr);
            const set2 = this.rollSet(expr);

            steps.push(`Roll 1: [${set1.rolls.join(', ')}] = ${set1.sum}`);
            steps.push(`Roll 2: [${set2.rolls.join(', ')}] = ${set2.sum}`);

            let chosenSet;
            if (expr.advantage) {
                chosenSet = set1.sum >= set2.sum ? set1 : set2;
                steps.push(`Advantage: Taken ${chosenSet.sum}`);
            } else {
                chosenSet = set1.sum <= set2.sum ? set1 : set2;
                steps.push(`Disadvantage: Taken ${chosenSet.sum}`);
            }

            total = chosenSet.sum + expr.modifier;
            steps.push(`Total: ${chosenSet.sum} + ${expr.modifier} = ${total}`);
            rolls.push(...chosenSet.rolls); // This is ambiguous, maybe we should store structure
        } else {
            const set = this.rollSet(expr);
            rolls.push(...set.rolls);
            total = set.sum + expr.modifier;
            steps.push(`Rolled ${expr.count}d${expr.sides}: [${set.rolls.join(', ')}]`);

            // Show kept/dropped dice if applicable
            if (set.dropped && set.dropped.length > 0) {
                steps.push(`Kept: [${set.kept?.join(', ')}], Dropped: [${set.dropped.join(', ')}]`);
                steps.push(`Sum of kept dice: ${set.sum}`);
            }

            if (expr.modifier !== 0) {
                steps.push(`Modifier: ${expr.modifier}`);
                steps.push(`Total: ${set.sum} + ${expr.modifier} = ${total}`);
            } else {
                steps.push(`Total: ${total}`);
            }
        }

        return {
            input: typeof expression === 'string' ? expression : `${expr.count}d${expr.sides}${expr.modifier >= 0 ? '+' : ''}${expr.modifier}`,
            result: total,
            steps,
            timestamp: new Date().toISOString(),
            seed: this.seed,
            metadata: { rolls }
        };
    }

    private rollSet(expr: DiceExpression): { rolls: number[], sum: number, kept?: number[], dropped?: number[] } {
        const rolls: number[] = [];

        for (let i = 0; i < expr.count; i++) {
            let roll = this.die(expr.sides);
            rolls.push(roll);

            if (expr.explode && roll === expr.sides) {
                // Explode!
                let exploded = roll;
                let explosions = 0;
                while (exploded === expr.sides && explosions++ < DiceEngine.MAX_EXPLOSIONS) {
                    exploded = this.die(expr.sides);
                    rolls.push(exploded);
                }
            }
        }

        // Apply drop/keep modifiers
        let keptRolls = [...rolls];
        let droppedRolls: number[] = [];

        if (expr.dropLowest && expr.dropLowest > 0) {
            const sorted = [...rolls].sort((a, b) => a - b);
            droppedRolls = sorted.slice(0, expr.dropLowest);
            keptRolls = sorted.slice(expr.dropLowest);
        } else if (expr.dropHighest && expr.dropHighest > 0) {
            const sorted = [...rolls].sort((a, b) => b - a);
            droppedRolls = sorted.slice(0, expr.dropHighest);
            keptRolls = sorted.slice(expr.dropHighest);
        } else if (expr.keepLowest && expr.keepLowest > 0) {
            const sorted = [...rolls].sort((a, b) => a - b);
            keptRolls = sorted.slice(0, expr.keepLowest);
            droppedRolls = sorted.slice(expr.keepLowest);
        } else if (expr.keepHighest && expr.keepHighest > 0) {
            const sorted = [...rolls].sort((a, b) => b - a);
            keptRolls = sorted.slice(0, expr.keepHighest);
            droppedRolls = sorted.slice(expr.keepHighest);
        }

        const sum = keptRolls.reduce((acc, val) => acc + val, 0);
        return { rolls, sum, kept: keptRolls, dropped: droppedRolls.length > 0 ? droppedRolls : undefined };
    }
}
