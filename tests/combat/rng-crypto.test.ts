import { describe, it, expect } from 'vitest';
import { CombatRNG } from '../../src/engine/combat/rng.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';

/**
 * CombatRNG has two modes. A seed string is the seeded ARC4 stream it always
 * was (replay exact). `{ mode: 'crypto' }` draws from crypto.randomInt, keys
 * each roll with a unique nonce, and its snapshot round-trips `draws` so a
 * reload knows how many dice the fight has rolled.
 */
describe('CombatRNG modes', () => {
    it('a seed string is seeded and replays exactly, with a seeded snapshot', () => {
        const a = new CombatRNG('exact-seed');
        const b = new CombatRNG('exact-seed');
        expect(a.mode).toBe('seeded');
        expect(a.describe()).toBe('seeded:exact-seed');
        const ra = [a.d20(), a.roll('2d6+3'), a.rollExploding(1, 6), a.d20()];
        const rb = [b.d20(), b.roll('2d6+3'), b.rollExploding(1, 6), b.d20()];
        expect(ra).toEqual(rb);
        const snap = a.snapshot();
        expect(snap.mode).toBe('seeded');
        expect(snap).toMatchObject({ origin: 'exact-seed' });
        expect((snap as { arc4?: object }).arc4).toBeDefined();
        const records = a.drainRecords();
        expect(records.every(r => r.source === 'seeded' && r.replay === undefined)).toBe(true);
    });

    it('crypto mode rolls in bounds, keys every roll with a unique crypto nonce and has no arc4 state', () => {
        const rng = CombatRNG.crypto();
        expect(rng.mode).toBe('crypto');
        expect(rng.describe()).toBe('crypto');
        for (let i = 0; i < 500; i++) {
            rng.tag = { purpose: `roll ${i}` };
            const v = rng.d20();
            expect(v).toBeGreaterThanOrEqual(1);
            expect(v).toBeLessThanOrEqual(20);
        }
        const records = rng.drainRecords();
        expect(records).toHaveLength(500);
        const keys = new Set(records.map(r => r.replay));
        expect(keys.size).toBe(500);
        for (const r of records) {
            expect(r.source).toBe('crypto');
            expect(r.replay).toMatch(/^crypto:[0-9a-f]{8}$/);
            expect(r.origin).toMatch(/^crypto-[0-9a-f]{8}$/);
        }
        const snap = rng.snapshot();
        expect(snap).toEqual({ mode: 'crypto', origin: records[0].origin, draws: 500 });
        expect('arc4' in snap).toBe(false);
    });

    it('a crypto snapshot round-trips draws and origin through JSON', () => {
        const live = CombatRNG.crypto();
        live.d20(); live.d20(); live.roll('3d6');
        const saved = JSON.parse(JSON.stringify(live.snapshot()));
        expect(saved.draws).toBe(5);
        const restored = new CombatRNG('ignored-seed', saved);
        expect(restored.mode).toBe('crypto');
        expect(restored.snapshot()).toEqual(saved);
        restored.d20();
        expect(restored.snapshot()).toEqual({ ...saved, draws: 6 });
        expect(restored.drainRecords()[0].startDraw).toBe(5);
    });

    it('a legacy snapshot without mode is seeded, and a seeded snapshot resumes the stream', () => {
        const live = new CombatRNG('legacy');
        live.d20(); live.d20();
        const snap = JSON.parse(JSON.stringify(live.snapshot()));
        const next = [live.d20(), live.d20(), live.d20()];
        delete snap.mode;
        const restored = new CombatRNG('other', snap);
        expect(restored.mode).toBe('seeded');
        expect([restored.d20(), restored.d20(), restored.d20()]).toEqual(next);
    });

    it('a crypto audit key is refused as a seed', () => {
        expect(() => new CombatRNG('crypto:1a2b3c4d')).toThrow(/cannot be replayed/);
        expect(() => new CombatRNG('crypto-1a2b3c4d')).toThrow(/cannot be replayed/);
    });

    it('rollAttackD20 and rollDamageDetailed work in crypto mode', () => {
        const rng = CombatRNG.crypto();
        for (let i = 0; i < 100; i++) {
            const r = rng.rollAttackD20(5, 15, true, false);
            expect(r.allRolls).toHaveLength(2);
            expect(r.roll).toBe(Math.max(...r.allRolls));
            expect(r.total).toBe(r.roll + 5);
        }
        const dmg = rng.rollDamageDetailed('2d6+3');
        expect(dmg.rolls).toHaveLength(2);
        expect(dmg.total).toBe(dmg.diceTotal + 3);
    });
});

describe('CombatEngine on crypto dice', () => {
    const p = (id: string) => ({ id, name: id, hp: 10, maxHp: 10, initiativeBonus: 0, conditions: [] } as any);

    it('CombatEngine.crypto() reports its mode, and the returned state carries a crypto rngState', () => {
        const engine = CombatEngine.crypto();
        expect(engine.diceMode).toBe('crypto');
        expect(engine.describeDice()).toBe('crypto');
        const state = engine.startEncounter([p('x'), p('y')]);
        expect(state.rngState).toMatchObject({ mode: 'crypto', draws: 2 });
        const keys = engine.drainRollRecords().map(r => r.replay);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
    });

    it('a reload of a crypto encounter stays crypto and continues the draw count', () => {
        const a = CombatEngine.crypto();
        const state = JSON.parse(JSON.stringify(a.startEncounter([p('x'), p('y')])));
        const b = new CombatEngine('would-be-seeded');
        b.loadState(state);
        expect(b.diceMode).toBe('crypto');
        b.rollD20({ purpose: 'after reload' });
        const rec = b.drainRollRecords()[0];
        expect(rec.startDraw).toBe(2);
        expect(rec.replay).toMatch(/^crypto:/);
        expect(b.getState()!.rngState).toMatchObject({ mode: 'crypto', draws: 3 });
    });

    it('a seeded encounter is unchanged: same seed, same initiative and attack dice', () => {
        const a = new CombatEngine('fight');
        const b = new CombatEngine('fight');
        expect(a.diceMode).toBe('seeded');
        expect(a.describeDice()).toBe('seeded:fight');
        const sa = a.startEncounter([p('x'), p('y')]);
        const sb = b.startEncounter([p('x'), p('y')]);
        expect(sa.participants.map(q => q.initiative)).toEqual(sb.participants.map(q => q.initiative));
        expect(a.executeAttack('x', 'y', 5, 10, 4).attackRoll).toEqual(b.executeAttack('x', 'y', 5, 10, 4).attackRoll);
    });
});
