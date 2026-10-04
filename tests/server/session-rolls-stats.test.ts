import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withOperation } from '../../src/server/operation-guard.js';
import { handleMathManage } from '../../src/server/consolidated/math-manage.js';
import { handleSessionManage } from '../../src/server/consolidated/session-manage.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { recordRolls, rollStats, queryRolls, ensureRollLog } from '../../src/storage/roll-log.js';
import { loggedD20 } from '../../src/math/logged-d20.js';

const ctx = { sessionId: 'unscoped' };
const g = (tool: string, h: (a: any, c: any) => Promise<any>) => withOperation(tool, (args) => h(args, ctx));
const math = g('math_manage', handleMathManage);
const session = g('session_manage', handleSessionManage);
const manage = g('combat_manage', handleCombatManage);
const action = g('combat_action', handleCombatAction);
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };

/**
 * The GM's dice audit is one call: session_manage rolls {stats: true} over
 * a world, a window, a purpose or a source, with the d20 chi-squared line.
 */
describe('session_manage rolls: filters and stats', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => closeDb());

    it('roll_log gains source and world_id; an unseeded math roll is crypto, a seeded one is seeded', async () => {
        const cols = (getDb().prepare('PRAGMA table_info(roll_log)').all() as Array<{ name: string }>).map(c => c.name);
        ensureRollLog(getDb());
        const after = (getDb().prepare('PRAGMA table_info(roll_log)').all() as Array<{ name: string }>).map(c => c.name);
        expect(after).toEqual(expect.arrayContaining(['source', 'world_id']));
        expect(cols.length).toBeLessThanOrEqual(after.length);

        const a = json(await math({ action: 'roll', expression: '1d20', forId: 'hero', purpose: 'free roll' }, {}));
        expect(a.dice).toBe('crypto');
        expect(a.seed).toMatch(/^crypto:[0-9a-f]{8}$/);
        const b = json(await math({ action: 'roll', expression: '1d20', forId: 'hero', purpose: 'seeded roll', seed: 'replay-me' }, {}));
        expect(b.dice).toBe('seeded:replay-me');
        const rows = json(await session({ action: 'rolls', forId: 'hero' }, {})).rolls;
        const free = rows.find((r: any) => r.purpose === 'free roll');
        const seeded = rows.find((r: any) => r.purpose === 'seeded roll');
        expect(free).toMatchObject({ source: 'crypto', replay: a.seed });
        expect(seeded).toMatchObject({ source: 'seeded', replay: 'replay-me' });
    });

    it('filters by source, purpose, since and worldId', async () => {
        await math({ action: 'roll', expression: '1d20', forId: 'hero', purpose: 'alpha check' }, {});
        await math({ action: 'roll', expression: '1d20', forId: 'hero', purpose: 'beta check', seed: 's1' }, {});
        const cut = new Date(Date.now() + 60_000).toISOString();
        recordRolls(getDb(), [{ purpose: 'gamma', dice: [{ sides: 20, value: 7 }], replay: 'crypto:00000001', worldId: 'w1' }], { tool: 'test' });

        expect(json(await session({ action: 'rolls', source: 'seeded' }, {})).rolls.map((r: any) => r.purpose)).toEqual(['beta check']);
        expect(json(await session({ action: 'rolls', source: 'crypto' }, {})).rolls.map((r: any) => r.purpose).sort()).toEqual(['alpha check', 'gamma']);
        expect(json(await session({ action: 'rolls', purpose: 'CHECK' }, {})).count).toBe(2);
        expect(json(await session({ action: 'rolls', since: cut }, {})).count).toBe(0);
        expect(json(await session({ action: 'rolls', worldId: 'w1' }, {})).rolls.map((r: any) => r.purpose)).toEqual(['gamma']);
    });

    it('world_id is filled from the call that named the world', async () => {
        const world = 'world-rolls';
        await math({ action: 'roll', expression: '2d6', forId: 'hero', purpose: 'with world', worldId: world }, {});
        const rows = queryRolls(getDb(), { worldId: world });
        expect(rows.map(r => r.purpose)).toEqual(['with world']);
    });

    it('stats: true returns the d20 audit over every matching roll, d20 dice only', async () => {
        // A flat distribution written straight to the log: every face 5 times.
        const entries = [] as Parameters<typeof recordRolls>[1];
        for (let face = 1; face <= 20; face++) for (let k = 0; k < 5; k++) entries.push({ purpose: 'flat', dice: [{ sides: 20, value: face }], replay: 'crypto:0000ffff' });
        // Non-d20 dice: counted as rolls, excluded from the faces.
        entries.push({ purpose: 'flat', dice: [{ sides: 6, value: 6 }, { sides: 6, value: 1 }], replay: 'crypto:0000fffe' });
        recordRolls(getDb(), entries, { tool: 'test', worldId: 'w-stats' });

        const r = json(await session({ action: 'rolls', purpose: 'flat', stats: true, limit: 3 }, {}));
        expect(r.rolls).toHaveLength(3);
        expect(r.stats.count).toBe(101);
        expect(r.stats.d20).toEqual({ n: 100, mean: 10.5, nat20: 5, nat1: 5, chi2: 0, cutoff95: 30.144, biased: false });
        expect(r.stats.faces).toEqual(new Array(20).fill(5));
        expect(r.stats.bySource).toEqual({ crypto: 101 });
    });

    it('stats flags a loaded die', () => {
        const entries = Array.from({ length: 200 }, () => ({ purpose: 'loaded', dice: [{ sides: 20, value: 20 }], replay: 'seed-x' }));
        recordRolls(getDb(), entries, { tool: 'test' });
        const s = rollStats(getDb(), { purpose: 'loaded' });
        expect(s.d20.n).toBe(200);
        expect(s.d20.nat20).toBe(200);
        expect(s.d20.mean).toBe(20);
        expect(s.d20.chi2).toBeGreaterThan(s.d20.cutoff95);
        expect(s.d20.biased).toBe(true);
        expect(s.bySource).toEqual({ seeded: 200 });
        expect(rollStats(getDb(), { purpose: 'nothing-here' })).toMatchObject({ count: 0, d20: { n: 0, chi2: 0, biased: false } });
    });

    it('1,000 crypto d20s through loggedD20 pass the chi-squared line and the stats call sees them', async () => {
        for (let i = 0; i < 1000; i++) loggedD20(getDb(), { purpose: 'fairness', forId: 'die' }, { tool: 'test' });
        const r = json(await session({ action: 'rolls', forId: 'die', stats: true, limit: 1 }, {}));
        expect(r.stats.count).toBe(1000);
        expect(r.stats.d20.n).toBe(1000);
        expect(r.stats.bySource).toEqual({ crypto: 1000 });
        // 99.9% line for 19 df; a fair die fails 30.144 one run in twenty.
        expect(r.stats.d20.chi2).toBeLessThan(43.82);
        expect(r.stats.d20.mean).toBeGreaterThan(9);
        expect(r.stats.d20.mean).toBeLessThan(12);
    });

    it('a crypto encounter logs its dice as crypto with a key per roll, and the encounter reply names its dice', async () => {
        const enc = json(await manage({ action: 'create', participants: [
            { id: 'a', name: 'A', hp: 50, maxHp: 50, initiative: 20, ac: 10 },
            { id: 'b', name: 'B', hp: 50, maxHp: 50, initiative: 5, ac: 10, isEnemy: true }
        ] }, {}));
        expect(enc.dice).toBe('crypto');
        await action({ action: 'attack', encounterId: enc.encounterId, actorId: 'a', targetId: 'b', attackBonus: 5, damage: '2d6' }, {});
        const r = json(await session({ action: 'rolls', encounterId: enc.encounterId, source: 'crypto', stats: true }, {}));
        expect(r.count).toBeGreaterThan(0);
        for (const row of r.rolls) expect(row.replay).toMatch(/^crypto:[0-9a-f]{8}$/);
        expect(new Set(r.rolls.map((x: any) => x.replay)).size).toBe(r.rolls.length);
        expect(r.stats.bySource.crypto).toBe(r.count);

        const seeded = json(await manage({ action: 'create', seed: 'audit-seed', participants: [
            { id: 'c', name: 'C', hp: 50, maxHp: 50, initiative: 20, ac: 10 },
            { id: 'd', name: 'D', hp: 50, maxHp: 50, initiative: 5, ac: 10, isEnemy: true }
        ] }, {}));
        expect(seeded.dice).toBe('seeded:audit-seed');
        await action({ action: 'attack', encounterId: seeded.encounterId, actorId: 'c', targetId: 'd', attackBonus: 5, damage: '2d6' }, {});
        const rows = json(await session({ action: 'rolls', encounterId: seeded.encounterId }, {})).rolls;
        for (const row of rows) expect(row).toMatchObject({ source: 'seeded' });
        expect(rows.some((row: any) => String(row.replay).startsWith('audit-seed@'))).toBe(true);
    });
});
