import { describe, it, expect } from 'vitest';
import { cryptoInt, cryptoNonce, cryptoReplayKey, cryptoRoll, cryptoRoller, cryptoUnit, isCryptoKey, assertNotCryptoKey } from '../../src/math/crypto-dice.js';
import { D20_CHI2_CUTOFF_95 } from '../../src/storage/roll-log.js';

/**
 * Crypto dice are the table default: every unseeded die comes from
 * crypto.randomInt, each roll carries a unique nonce key, and a key can
 * never be passed back as a seed.
 */
describe('crypto dice', () => {
    it('20k d20s all land in bounds and fill every face', () => {
        const faces = new Array(20).fill(0);
        for (let i = 0; i < 20_000; i++) {
            const v = cryptoInt(20);
            expect(v).toBeGreaterThanOrEqual(1);
            expect(v).toBeLessThanOrEqual(20);
            faces[v - 1]++;
        }
        expect(faces.every(f => f > 0)).toBe(true);
    });

    it('20k d20s are roughly uniform (chi-squared under the 99.9% line)', () => {
        const n = 20_000;
        const faces = new Array(20).fill(0);
        for (let i = 0; i < n; i++) faces[cryptoInt(20) - 1]++;
        const expected = n / 20;
        const chi2 = faces.reduce((acc, obs) => acc + ((obs - expected) ** 2) / expected, 0);
        // 19 df: 95% is 30.144, 99.9% is 43.82. A fair die fails the looser
        // line one run in a thousand; the test uses the tighter one.
        expect(chi2).toBeLessThan(43.82);
        expect(D20_CHI2_CUTOFF_95).toBe(30.144);
    });

    it('d6 and d100 stay in bounds; a d1 is always 1; a d0 is refused', () => {
        for (let i = 0; i < 2000; i++) {
            const six = cryptoInt(6); expect(six).toBeGreaterThanOrEqual(1); expect(six).toBeLessThanOrEqual(6);
            const hundred = cryptoInt(100); expect(hundred).toBeGreaterThanOrEqual(1); expect(hundred).toBeLessThanOrEqual(100);
        }
        expect(cryptoInt(1)).toBe(1);
        expect(() => cryptoInt(0)).toThrow(/d0/);
    });

    it('cryptoUnit is in [0, 1)', () => {
        for (let i = 0; i < 5000; i++) { const u = cryptoUnit(); expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThan(1); }
    });

    it('nonces are 8 hex chars and never repeat over 10k', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 10_000; i++) {
            const n = cryptoNonce();
            expect(n).toMatch(/^[0-9a-f]{8}$/);
            seen.add(n);
        }
        expect(seen.size).toBe(10_000);
    });

    it('replay keys are crypto:<nonce> and are recognised, never accepted as seeds', () => {
        const key = cryptoReplayKey();
        expect(key).toMatch(/^crypto:[0-9a-f]{8}$/);
        expect(isCryptoKey(key)).toBe(true);
        expect(isCryptoKey('crypto-1a2b3c4d')).toBe(true);
        expect(isCryptoKey('vorago')).toBe(false);
        expect(isCryptoKey(null)).toBe(false);
        expect(() => assertNotCryptoKey(key)).toThrow(/cannot be replayed/);
        expect(() => assertNotCryptoKey('vorago')).not.toThrow();
    });

    it('cryptoRoll parses notation, signs subtracted dice and keys the roll', () => {
        const r = cryptoRoll('1d4-1d4+10');
        expect(r.rolls).toHaveLength(2);
        expect(r.rolls[1]).toBeLessThan(0);
        expect(r.total).toBe(r.rolls[0] + r.rolls[1] + 10);
        expect(r.dice.map(d => d.sides)).toEqual([4, 4]);
        expect(r.replay).toMatch(/^crypto:/);
        expect(() => cryptoRoll('1d6++2')).toThrow(/Invalid dice/);
    });

    it('cryptoRoller: d20 with advantage keeps the high die, disadvantage the low one', () => {
        const roller = cryptoRoller();
        expect(roller.mode).toBe('crypto');
        for (let i = 0; i < 200; i++) {
            const adv = roller.d20(true, false);
            expect(adv.rolls).toHaveLength(2);
            expect(adv.natural).toBe(Math.max(...adv.rolls));
            const dis = roller.d20(false, true);
            expect(dis.natural).toBe(Math.min(...dis.rolls));
            const both = roller.d20(true, true);
            expect(both.rolls).toHaveLength(1);
        }
        const keys = new Set(Array.from({ length: 500 }, () => roller.roll('2d6').replay));
        expect(keys.size).toBe(500);
    });
});
