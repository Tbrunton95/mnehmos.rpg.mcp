/**
 * Play report 7 follow-up, lane W review: the wound helpers cost the wounded
 * models, not the whole unit.
 *
 * Before lane W, liveModels was arithmetic (ceil(hp / hpPerModel)). Lane W
 * read the models as one array entry per model, unhurt ones included, on
 * every read: a 1,000,000-model unit took ~300 ms per set of reads (get, the
 * attack reply's UNIT line) and 10^8 models ran the shared service out of
 * memory on the next read. The unhurt are now counted, never listed.
 *
 * The second block checks the counted helpers against the array semantics
 * lane W shipped (a reference copied here), over many seeded random units and
 * writes, so the change is cost only.
 */
import {
    modelHps, liveModels, woundLine, describeUnit, unitCapFor, applyToModels, spreadOnModels,
    healModels, setUnitHp, setWounded, areaOnUnit, volleyTier, breakTestDue
} from '../../src/engine/combat/units.js';

const big = (models: number, per: number, wounded?: number[]): any => ({
    id: 'horde', name: 'Horde', hp: models * per - (wounded ? wounded.reduce((a, v) => a + (per - v), 0) : 0), maxHp: models * per,
    unit: { models, hpPerModel: per, packed: true, attackBonus: 0, ...(wounded ? { wounded } : {}) }
});

describe('a huge unit reads and writes at the cost of its wounded (lane W review)', () => {
    it('ten million models: reads, a capped blow, a spread, a heal and set_unit wounds stay fast', () => {
        const p = big(10_000_000, 9, [2, 5]);
        const t0 = performance.now();
        for (let i = 0; i < 5; i++) {
            expect(liveModels(p)).toBe(10_000_000);
            expect(woundLine(p)).toBe('10000000 alive: 9999998 unhurt, 1 at 5/9, 1 at 2/9');
            expect(describeUnit(p)).toContain('9999998 unhurt, 1 at 5/9, 1 at 2/9');
            expect(volleyTier(p)!.models).toBe(10_000_000);
        }
        const hp0 = p.hp;
        spreadOnModels(p, unitCapFor(p, 30).damage);
        expect(p.unit.wounded).toEqual([5]);
        expect(breakTestDue(p, hp0)).toBeNull();
        spreadOnModels(p, 23);
        // 5 dies (18 left), two unhurt die (0 left).
        expect(liveModels(p)).toBe(9_999_996);
        expect(p.unit.wounded).toBeUndefined();
        healModels(p, 20);
        // Two models revive at 9, one at 2.
        expect(liveModels(p)).toBe(9_999_999);
        expect(p.unit.wounded).toEqual([2]);
        expect(setWounded(p, [1, 1, 1]).ok).toBe(true);
        expect(woundLine(p)).toBe('9999999 alive: 9999996 unhurt, 3 at 1/9');
        setUnitHp(p, p.hp - 1);
        expect(woundLine(p)).toBe('9999998 alive: 9999996 unhurt, 2 at 1/9');
        // A spaced area over ten of them takes the most wounded first.
        const r = areaOnUnit(p, { damage: 4, modelsInArea: 10 });
        expect(r).toMatchObject({ modelsKilled: 2, modelsAfter: 9_999_996, woundsAfter: '9999988 unhurt, 8 at 5/9' });
        applyToModels(p, r.modelDamage);
        expect(woundLine(p)).toBe('9999996 alive: 9999988 unhurt, 8 at 5/9');
        expect(performance.now() - t0).toBeLessThan(250);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// The array semantics lane W shipped (37458a5), as the reference.
// ─────────────────────────────────────────────────────────────────────────

type U = { hp: number; unit: { models: number; hpPerModel: number; wounded?: number[] } };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
function refHps(p: U): number[] {
    const u = p.unit, per = u.hpPerModel;
    if (p.hp <= 0) return [];
    const w = (u.wounded ?? []).filter(v => Number.isInteger(v) && v > 0 && v < per).sort((a, b) => a - b);
    if (u.wounded && w.length === u.wounded.length) {
        const rest = p.hp - sum(w);
        if (rest >= 0 && rest % per === 0 && rest / per + w.length <= u.models) return [...w, ...Array<number>(rest / per).fill(per)];
    }
    const n = Math.max(0, Math.min(u.models, Math.ceil(p.hp / per)));
    if (n === 0) return [];
    return [Math.min(per, p.hp - (n - 1) * per), ...Array<number>(n - 1).fill(per)];
}
function refWrite(p: U, hps: number[]) {
    const live = hps.filter(v => v > 0);
    const w = live.filter(v => v < p.unit.hpPerModel).sort((a, b) => a - b);
    p.hp = sum(live);
    if (w.length) p.unit.wounded = w; else delete p.unit.wounded;
}
function refApply(p: U, dmg: number[]) {
    const hps = refHps(p); let killed = 0, absorbed = 0;
    for (let i = 0; i < Math.min(hps.length, dmg.length); i++) {
        const d = Math.max(0, Math.floor(dmg[i] ?? 0));
        if (d <= 0) continue;
        if (d >= hps[i]) { absorbed += hps[i]; hps[i] = 0; killed++; } else { absorbed += d; hps[i] -= d; }
    }
    refWrite(p, hps);
    return { killed, absorbed };
}
function refSpread(p: U, damage: number) {
    const hps = refHps(p); let left = Math.max(0, Math.floor(damage)), killed = 0, absorbed = 0;
    for (let i = 0; i < hps.length && left > 0; i++) {
        if (left >= hps[i]) { left -= hps[i]; absorbed += hps[i]; hps[i] = 0; killed++; } else { hps[i] -= left; absorbed += left; left = 0; }
    }
    refWrite(p, hps);
    return { killed, absorbed };
}
function refHeal(p: U, amount: number) {
    const per = p.unit.hpPerModel; const hps = refHps(p); let left = Math.max(0, Math.floor(amount)), absorbed = 0, revived = 0;
    for (let i = 0; i < hps.length && left > 0; i++) { const add = Math.min(per - hps[i], left); if (add > 0) { hps[i] += add; left -= add; absorbed += add; } }
    while (left > 0 && hps.length < p.unit.models) { const add = Math.min(per, left); hps.push(add); left -= add; absorbed += add; revived++; }
    refWrite(p, hps);
    return { absorbed, revived };
}
function refArea(p: U, damage: number, inside: number, saves?: boolean[]) {
    const hps = refHps(p); const per = p.unit.hpPerModel; const n = Math.min(hps.length, inside);
    const after = [...hps]; let killed = 0, hpLost = 0;
    for (let i = 0; i < n; i++) {
        const dmg = saves?.[i] ? Math.floor(damage / 2) : damage;
        if (dmg > 0 && dmg >= hps[i]) { killed++; hpLost += hps[i]; after[i] = 0; } else { hpLost += dmg; after[i] = hps[i] - dmg; }
    }
    const aw = after.filter(v => v > 0 && v < per);
    return { killed, hpLost, frontHp: hps[0] ?? 0, woundedInside: hps.slice(0, n).filter(v => v < per).length, afterWounded: aw.sort((a, b) => a - b), afterUnhurt: after.filter(v => v >= per).length };
}

/** A seeded LCG, so a failure replays. */
function lcg(seed: number) { let s = seed >>> 0; return (n: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; }; }

describe('the counted helpers match the array semantics (lane W review)', () => {
    it('1000 seeded random units and writes agree on HP, the list, the count and every result', () => {
        const rnd = lcg(20261014);
        for (let trial = 0; trial < 1000; trial++) {
            const models = 1 + rnd(12), per = 1 + rnd(10);
            // A legacy pool, a list in step, or a list out of step.
            const shape = rnd(3);
            let hp = rnd(models * per + 1);
            let wounded: number[] | undefined;
            if (shape > 0 && per > 1) {
                const live = Math.max(1, Math.ceil(hp / per));
                wounded = Array.from({ length: rnd(live + 1) }, () => 1 + rnd(per - 1));
                if (shape === 1) hp = (live - wounded.length) * per + sum(wounded);
            }
            const mk = (): any => ({ id: 'u', name: 'U', hp, maxHp: models * per, unit: { models, hpPerModel: per, packed: true, attackBonus: 0, ...(wounded ? { wounded: [...wounded] } : {}) } });
            const a = mk(), b = mk();
            const ctx = `trial ${trial}: ${JSON.stringify(a)}`;
            expect(modelHps(a), ctx).toEqual(refHps(b));
            expect(liveModels(a), ctx).toBe(refHps(b).length);
            expect(unitCapFor(a, 1000).damage, ctx).toBe(a.hp > 0 ? refHps(b)[0] ?? 0 : 1000);
            const op = rnd(5);
            if (op === 0) {
                const dmg = Array.from({ length: rnd(models + 2) }, () => rnd(per * 2 + 1));
                const r = applyToModels(a, dmg), q = refApply(b, dmg);
                expect({ killed: r.killed, absorbed: r.absorbed }, ctx).toEqual(q);
            } else if (op === 1) {
                const d = rnd(models * per + 3);
                const r = spreadOnModels(a, d), q = refSpread(b, d);
                expect({ killed: r.killed, absorbed: r.absorbed }, ctx).toEqual(q);
            } else if (op === 2) {
                const h = rnd(models * per + 3);
                const r = healModels(a, h), q = refHeal(b, h);
                expect({ absorbed: r.absorbed, revived: r.revived ?? 0 }, ctx).toEqual(q);
            } else if (op === 3) {
                const d = rnd(per * 2 + 1), inside = rnd(models + 2);
                const saves = Array.from({ length: inside }, () => rnd(2) === 1);
                const r = areaOnUnit(a, { damage: d, modelsInArea: inside, saves }), q = refArea(b, d, inside, saves);
                expect({ killed: r.modelsKilled, hpLost: r.hpLost, frontHp: r.frontHp, woundedInside: r.woundedInside ?? 0 }, ctx)
                    .toEqual({ killed: q.killed, hpLost: q.hpLost, frontHp: q.frontHp, woundedInside: q.woundedInside });
                // The wounds after, as the counted line reads them.
                const after: any = { hp: sum(q.afterWounded) + q.afterUnhurt * per, unit: { models, hpPerModel: per, wounded: q.afterWounded } };
                const line = woundLine(after);
                expect(r.woundsAfter, ctx).toBe(line.includes(': ') && /at \d/.test(line) ? line.slice(line.indexOf(': ') + 2) : '');
                applyToModels(a, r.modelDamage); refApply(b, r.modelDamage);
            } else {
                const t = rnd(models * per + 3);
                setUnitHp(a, t);
                if (t < b.hp) refSpread(b, b.hp - t); else if (t > b.hp) refHeal(b, t - b.hp);
            }
            expect(a.hp, ctx).toBe(b.hp);
            expect(a.unit.wounded, ctx).toEqual(b.unit.wounded);
            expect(liveModels(a), ctx).toBe(refHps(b).length);
        }
    });
});
