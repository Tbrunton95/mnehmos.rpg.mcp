import { randomBytes, randomInt } from 'node:crypto';
import { parseDiceTerms } from '../engine/combat/rng.js';

/**
 * Cryptographic dice: the default for every roll the caller did not seed.
 *
 * Four days of play ran every fight in chat because the table requires
 * crypto dice and the engine only had seeded streams. A seeded stream is
 * still available (pass `seed`) for replay and audits; without one, every
 * die comes from crypto.randomInt and carries a nonce so roll_log can still
 * show which call made it. A crypto roll cannot be replayed: the nonce is an
 * audit key, not a seed.
 */

/** One die of `sides` faces, uniform, from the OS entropy pool. */
export function cryptoInt(sides: number): number {
    if (!Number.isInteger(sides) || sides < 1) throw new Error(`Cannot roll a d${sides}`);
    return sides === 1 ? 1 : randomInt(1, sides + 1);
}

/** A number in [0, 1) from crypto, for code that was written around Math.random. */
export function cryptoUnit(): number {
    // randomInt's range may not exceed 2^48 - 1.
    const span = 2 ** 48 - 1;
    return randomInt(0, span) / span;
}

/** 8 hex chars (32 bits) of entropy: the per-roll key written to roll_log.replay. */
export function cryptoNonce(): string {
    return randomBytes(4).toString('hex');
}

export const CRYPTO_REPLAY_PREFIX = 'crypto:';

/** The replay key a crypto roll logs: 'crypto:<nonce>'. */
export function cryptoReplayKey(nonce: string = cryptoNonce()): string {
    return `${CRYPTO_REPLAY_PREFIX}${nonce}`;
}

/** True for a crypto roll's audit key ('crypto:…') or a crypto stream's origin ('crypto-…'). */
export function isCryptoKey(value: string | null | undefined): boolean {
    return typeof value === 'string' && /^crypto[:-]/.test(value);
}

/**
 * Refuse a crypto audit key passed where a seed goes. Seeding a stream from
 * 'crypto:abcd1234' would roll new dice that look like a replay.
 */
export function assertNotCryptoKey(seed: string): void {
    if (isCryptoKey(seed)) {
        throw new Error(`${seed} is a crypto roll's audit key, not a seed: crypto rolls cannot be replayed. Pass seed on the original call to make a replayable roll.`);
    }
}

export interface CryptoRollResult {
    total: number;
    /** Each die in order, negative for a subtracted term. */
    rolls: number[];
    dice: Array<{ sides: number; value: number }>;
    /** 'crypto:<nonce>', unique to this roll. */
    replay: string;
}

/** Roll any notation ('2d6+1', '1d4-1d4+10') on crypto dice. */
export function cryptoRoll(notation: string): CryptoRollResult {
    const terms = parseDiceTerms(notation);
    const rolls: number[] = [];
    const dice: Array<{ sides: number; value: number }> = [];
    let total = 0;
    for (const t of terms) {
        if (t.kind === 'dice') {
            for (let i = 0; i < t.count; i++) {
                const v = cryptoInt(t.sides);
                dice.push({ sides: t.sides, value: v });
                rolls.push(t.sign * v);
                total += t.sign * v;
            }
        } else total += t.sign * t.value;
    }
    return { total, rolls, dice, replay: cryptoReplayKey() };
}

export interface CryptoRoller {
    readonly mode: 'crypto';
    /** One die. */
    die(sides: number): number;
    /** A d20, or 2d20 keep high/low. */
    d20(advantage?: boolean, disadvantage?: boolean): { rolls: number[]; natural: number; replay: string };
    /** Any notation. */
    roll(notation: string): CryptoRollResult;
}

/** The crypto dice as one roller object, for code that takes a dice source. */
export function cryptoRoller(): CryptoRoller {
    return {
        mode: 'crypto',
        die: cryptoInt,
        d20(advantage, disadvantage) {
            const a = cryptoInt(20);
            if (advantage === disadvantage) return { rolls: [a], natural: a, replay: cryptoReplayKey() };
            const b = cryptoInt(20);
            return { rolls: [a, b], natural: advantage ? Math.max(a, b) : Math.min(a, b), replay: cryptoReplayKey() };
        },
        roll: cryptoRoll
    };
}
