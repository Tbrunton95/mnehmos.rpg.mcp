import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleWorldManage, WorldManageTool } from '../../src/server/consolidated/world-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../src/server/consolidated/character-manage.js';
import { handlePartyManage, PartyManageTool } from '../../src/server/consolidated/party-manage.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { tickUpkeep, type PartyUpkeep } from '../../src/engine/party-upkeep.js';
import Database from 'better-sqlite3';
import { migrate } from '../../src/storage/migrations.js';

/**
 * Play report 3: party upkeep. Stores are mouth-days in ONE linked character
 * pool, never on the party; mouths are counted live (members by unitModels,
 * linked mouth pools such as captives, extra mouths). world_manage advance
 * charges every whole day since lastDay; a day the stores cannot cover is a
 * starving day (stores to 0) that docks loyalty from everyone but the leader
 * and the mounts. A clock correction never charges.
 */
const W = 'varek-world';
const ctx = { sessionId: 'upkeep' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const world = async (a: Record<string, unknown>) => json(await handleWorldManage(WorldManageTool.inputSchema.parse(a), ctx as any));
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const party = async (a: Record<string, unknown>) => json(await handlePartyManage(PartyManageTool.inputSchema.parse(a), ctx as any));
const pools = (id: string) => (new CharacterRepository(getDb()).findById(id) as any).resourcePools as Record<string, { current: number; max: number; history?: Array<Record<string, unknown>> }>;
const member = (pid: string, cid: string) => getDb().prepare('SELECT * FROM party_members WHERE party_id = ? AND character_id = ?').get(pid, cid) as any;
const stored = (pid: string) => { const row = getDb().prepare('SELECT upkeep FROM parties WHERE id = ?').get(pid) as { upkeep: string | null }; return row.upkeep ? JSON.parse(row.upkeep) : null; };

let pid: string;
let farPid: string;
const link = { linkPool: { characterId: 'varek', pool: 'stores' }, mouthsFromPool: [{ characterId: 'varek', pool: 'captives' }] };

beforeEach(async () => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    const worlds = new WorldRepository(db);
    worlds.create({ id: W, name: 'Varek', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 47, time: '06:00' } } as any);
    worlds.create({ id: 'other', name: 'Other', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 3, time: '12:00' } } as any);
    const chars = new CharacterRepository(db);
    const base = { characterType: 'npc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 12, level: 1, createdAt: now, updatedAt: now };
    chars.create({ ...base, id: 'varek', name: 'Varek', resourcePools: { stores: { current: 200, max: 600, label: 'Stores (mouth-days)' }, captives: { current: 8, max: 50 } } } as any);
    chars.create({ ...base, id: 'kurn', name: 'Kurn' } as any);
    chars.create({ ...base, id: 'horse', name: 'Warhorse' } as any);
    chars.create({ ...base, id: 'camp', name: 'Camp Followers' } as any);
    chars.create({ ...base, id: 'thrall', name: 'Thrall' } as any);
    chars.create({ ...base, id: 'far', name: 'Far Lord', resourcePools: { stores: { current: 100, max: 100 } } } as any);
    pid = (await party({ action: 'create', name: 'The Host', worldId: W, initialMembers: [{ characterId: 'varek', role: 'leader' }] })).party.id;
    await party({ action: 'add_member', partyId: pid, characterId: 'kurn' });
    await party({ action: 'add_member', partyId: pid, characterId: 'horse', role: 'mount' });
    await party({ action: 'add_member', partyId: pid, characterId: 'camp', role: 'hireling', unitModels: 6 });
    await party({ action: 'add_member', partyId: pid, characterId: 'thrall', role: 'prisoner' });
    farPid = (await party({ action: 'create', name: 'Far Host', worldId: 'other', initialMembers: [{ characterId: 'far', role: 'leader' }] })).party.id;
});
afterEach(() => closeDb());

describe('party_manage set_upkeep', () => {
    it('links the stores pool, counts mouths live, starts from today and says so', async () => {
        const r = await party({ action: 'set_upkeep', partyId: pid, ...link });
        expect(r).toMatchObject({
            success: true, actionType: 'set_upkeep', partyId: pid, startDay: 47, daysLeft: 11,
            stores: { characterId: 'varek', pool: 'stores', current: 200, max: 600 },
            mouths: { total: 18, members: 10, pools: [{ characterId: 'varek', pool: 'captives', mouths: 8 }], extra: 0 }
        });
        expect(r.message).toMatch(/upkeep starts from Day 47; nothing before it is charged/);
        expect(r.message).toMatch(/200 mouth-days at 18 mouths = 11 days/);
        expect(r.unitsNote).toMatch(/mouth-days/);
        expect(stored(pid)).toMatchObject({ linkPool: { characterId: 'varek', pool: 'stores' }, mouthsFromPool: [{ characterId: 'varek', pool: 'captives' }], lastDay: 47, starvation: { loyaltyDelta: -1, perDay: true } });
        // Nothing moved on the sheet: the party row holds only the link.
        expect(pools('varek').stores.current).toBe(200);
    });

    it('refuses a pool the character does not carry, a mouth pool it does not carry, and writes nothing', async () => {
        const r = await party({ action: 'set_upkeep', partyId: pid, linkPool: { characterId: 'varek', pool: 'rations' } });
        expect(r.error).toBeTruthy();
        expect(r.message).toMatch(/does not carry a pool 'rations'/);
        expect(r.writes).toBe('none');
        expect(stored(pid)).toBeNull();
        const m = await party({ action: 'set_upkeep', partyId: pid, linkPool: { characterId: 'varek', pool: 'stores' }, mouthsFromPool: [{ characterId: 'kurn', pool: 'captives' }] });
        expect(m.error).toBeTruthy();
        expect(m.message).toMatch(/Kurn does not carry a pool 'captives'/);
        expect(stored(pid)).toBeNull();
        const first = await party({ action: 'set_upkeep', partyId: pid, linkPool: { characterId: 'varek', pool: 'stores' } });
        expect(first.success).toBe(true);
        expect(first.mouths.total).toBe(10);
    });

    it('re-running keeps lastDay unless startDay is passed; clear removes the link and leaves the pool', async () => {
        await party({ action: 'set_upkeep', partyId: pid, ...link });
        await world({ action: 'advance', worldId: W, days: 2 });
        expect(stored(pid).lastDay).toBe(49);
        const again = await party({ action: 'set_upkeep', partyId: pid, extraMouths: 2 });
        expect(again).toMatchObject({ success: true, replaced: true, startDay: 49 });
        expect(again.message).toMatch(/upkeep continues from Day 49/);
        expect(again.mouths).toMatchObject({ total: 20, extra: 2 });
        expect(stored(pid)).toMatchObject({ linkPool: { characterId: 'varek', pool: 'stores' }, extraMouths: 2, lastDay: 49 });
        const moved = await party({ action: 'set_upkeep', partyId: pid, startDay: 40 });
        expect(moved.startDay).toBe(40);
        expect(moved.message).toMatch(/upkeep starts from Day 40/);
        expect(stored(pid).lastDay).toBe(40);
        const cleared = await party({ action: 'set_upkeep', partyId: pid, clear: true });
        expect(cleared).toMatchObject({ success: true, cleared: true });
        expect(stored(pid)).toBeNull();
        expect(pools('varek').stores.current).toBe(164);
    });
});

describe('world_manage advance ticks upkeep', () => {
    it('3 days drain the linked pool by 18 a day (10 members + 8 captives) and report it', async () => {
        await party({ action: 'set_upkeep', partyId: pid, ...link });
        const r = await world({ action: 'advance', worldId: W, days: 3 });
        expect(r.success).toBe(true);
        expect(r.upkeep).toEqual([{ partyId: pid, name: 'The Host', days: 3, storesFrom: 200, storesTo: 146, mouths: 18, starvedDays: 0, loyalty: [] }]);
        expect(r.message).toMatch(/upkeep: The Host 200→146 \(3d × 18\)/);
        expect(pools('varek').stores.current).toBe(146);
        const hist = pools('varek').stores.history!;
        expect(hist[hist.length - 1]).toMatchObject({ from: 200, to: 146, delta: -54 });
        expect(String(hist[hist.length - 1].reason)).toMatch(/upkeep The Host: 3 day\(s\) × 18 mouths/);
        expect(stored(pid).lastDay).toBe(50);
        // Half a day crosses no midnight: nothing charged. The next half does.
        const half = await world({ action: 'advance', worldId: W, hours: 12 });
        expect(half.upkeep).toBeUndefined();
        expect(pools('varek').stores.current).toBe(146);
        const rest = await world({ action: 'advance', worldId: W, hours: 12 });
        expect(rest.upkeep).toEqual([expect.objectContaining({ days: 1, storesFrom: 146, storesTo: 128 })]);
    });

    it('a shortfall is a starving day: stores to 0, loyalty -1 for everyone but the leader and mounts, every day', async () => {
        await char({ action: 'adjust_pool', characterId: 'varek', pool: 'stores', value: 20 });
        await party({ action: 'set_upkeep', partyId: pid, ...link });
        const r = await world({ action: 'advance', worldId: W, days: 2 });
        expect(r.upkeep[0]).toMatchObject({ days: 2, storesFrom: 20, storesTo: 0, mouths: 18, starvedDays: 1 });
        expect(r.upkeep[0].loyalty).toHaveLength(3);
        expect(r.upkeep[0].loyalty).toEqual(expect.arrayContaining([
            expect.objectContaining({ characterId: 'kurn', from: 5, to: 4 }),
            expect.objectContaining({ characterId: 'camp', from: 5, to: 4 }),
            expect.objectContaining({ characterId: 'thrall', from: 5, to: 4 })
        ]));
        expect(r.message).toMatch(/upkeep: The Host 20→0 \(2d × 18\) STARVING 1d, loyalty -1 ×3/);
        expect(member(pid, 'varek').loyalty).toBeNull();
        expect(member(pid, 'horse').loyalty).toBeNull();
        expect(member(pid, 'kurn').loyalty).toBe(4);
        // perDay: every further starving day docks again.
        const r2 = await world({ action: 'advance', worldId: W, days: 1 });
        expect(r2.upkeep[0]).toMatchObject({ storesFrom: 0, storesTo: 0, starvedDays: 1 });
        expect(member(pid, 'kurn').loyalty).toBe(3);
        expect(member(pid, 'horse').loyalty).toBeNull();
        const m = await party({ action: 'muster', partyId: pid });
        expect(m.upkeep).toMatchObject({ starving: true, daysLeft: 0 });
        expect(m.message).toMatch(/STARVING/);
        // A refill ends the shortfall: muster stops saying STARVING before the next tick.
        await char({ action: 'adjust_pool', characterId: 'varek', pool: 'stores', value: 200 });
        const fed = await party({ action: 'muster', partyId: pid });
        expect(fed.upkeep).toMatchObject({ starving: false, daysLeft: 11 });
        expect(fed.message).not.toMatch(/STARVING/);
    });

    it("a mouth pool change changes the next day's draw; extraMouths and countRoles change the count", async () => {
        await party({ action: 'set_upkeep', partyId: pid, ...link });
        await char({ action: 'adjust_pool', characterId: 'varek', pool: 'captives', value: 0 });
        const r = await world({ action: 'advance', worldId: W, days: 1 });
        expect(r.upkeep[0]).toMatchObject({ mouths: 10, storesFrom: 200, storesTo: 190 });
        await party({ action: 'set_upkeep', partyId: pid, extraMouths: 5 });
        const r2 = await world({ action: 'advance', worldId: W, days: 1 });
        expect(r2.upkeep[0]).toMatchObject({ mouths: 15, storesFrom: 190, storesTo: 175 });
        const narrowed = await party({ action: 'set_upkeep', partyId: pid, countRoles: ['leader', 'member', 'hireling'], extraMouths: 0 });
        expect(narrowed.mouths).toMatchObject({ total: 8, members: 8 });
        await char({ action: 'adjust_pool', characterId: 'varek', pool: 'captives', value: 3 });
        const r3 = await world({ action: 'advance', worldId: W, days: 1 });
        expect(r3.upkeep[0]).toMatchObject({ mouths: 11, storesFrom: 175, storesTo: 164 });
    });

    it('other worlds are untouched; a plain update does not tick but the next advance catches up', async () => {
        await party({ action: 'set_upkeep', partyId: pid, ...link });
        await party({ action: 'set_upkeep', partyId: farPid, linkPool: { characterId: 'far', pool: 'stores' } });
        await world({ action: 'advance', worldId: W, days: 1 });
        expect(pools('far').stores.current).toBe(100);
        const o = await world({ action: 'advance', worldId: 'other', days: 1 });
        expect(o.upkeep).toEqual([expect.objectContaining({ partyId: farPid, name: 'Far Host', mouths: 1, storesFrom: 100, storesTo: 99 })]);
        expect(pools('varek').stores.current).toBe(182);
        // A plain update moves the clock without charging; the midnights it
        // skipped are charged by the next advance.
        await world({ action: 'update', worldId: W, environment: { day: 49, time: '06:00' } });
        expect(pools('varek').stores.current).toBe(182);
        const r = await world({ action: 'advance', worldId: W, days: 1 });
        expect(r.upkeep[0]).toMatchObject({ days: 2, storesFrom: 182, storesTo: 146 });
    });

    it('a correction never charges: it moves the anchor with the clock', async () => {
        await party({ action: 'set_upkeep', partyId: pid, ...link });
        await world({ action: 'advance', worldId: W, days: 1 });
        expect(pools('varek').stores.current).toBe(182);
        const c = await world({ action: 'update', worldId: W, environment: { day: 60, time: '06:00' }, correction: true });
        expect(c.correction.deltaHours).toBe(288);
        expect(c.upkeep).toBeUndefined();
        expect(c.upkeepAnchored).toEqual([{ partyId: pid, name: 'The Host', from: 48, to: 60 }]);
        expect(pools('varek').stores.current).toBe(182);
        expect(member(pid, 'kurn').loyalty ?? 5).toBe(5);
        expect(stored(pid).lastDay).toBe(60);
        const r = await world({ action: 'advance', worldId: W, days: 1 });
        expect(r.upkeep[0]).toMatchObject({ days: 1, storesFrom: 182, storesTo: 164 });
        // era_jump goes through the same path, and its reply says what it anchored.
        const e = await world({ action: 'era_jump', worldId: W, day: 400, label: 'M42, after the Drowning' });
        expect(e.upkeepAnchored).toEqual([{ partyId: pid, name: 'The Host', from: 61, to: 400 }]);
        expect(pools('varek').stores.current).toBe(164);
        expect(stored(pid).lastDay).toBe(400);
    });

    it('a correction that leaves the day alone leaves the anchor alone: a hand tick ahead is not charged twice, a plain update is still caught up', async () => {
        await party({ action: 'set_upkeep', partyId: pid, ...link });
        // Two days by hand: lastDay 49 while the clock still reads Day 47.
        await party({ action: 'upkeep', partyId: pid, days: 2 });
        expect(pools('varek').stores.current).toBe(164);
        const weather = await world({ action: 'update', worldId: W, environment: { weatherConditions: 'rain' }, correction: true });
        expect(weather.success).toBe(true);
        expect(weather.upkeepAnchored).toBeUndefined();
        expect(stored(pid).lastDay).toBe(49);
        // A time-of-day correction is not a day change either.
        const noon = await world({ action: 'update', worldId: W, environment: { time: '12:00' }, correction: true });
        expect(noon.upkeepAnchored).toBeUndefined();
        expect(stored(pid).lastDay).toBe(49);
        // Days 48 and 49 were paid by hand: the clock reaching Day 50 charges one day only.
        const r = await world({ action: 'advance', worldId: W, days: 3 });
        expect(r.upkeep).toEqual([expect.objectContaining({ days: 1, storesFrom: 164, storesTo: 146 })]);
        expect(stored(pid).lastDay).toBe(50);
        // A plain update moves the clock without charging; a weather correction in between must not swallow the days it skipped.
        await world({ action: 'update', worldId: W, environment: { day: 52, time: '06:00' } });
        const fog = await world({ action: 'update', worldId: W, environment: { weatherConditions: 'fog' }, correction: true });
        expect(fog.upkeepAnchored).toBeUndefined();
        expect(stored(pid).lastDay).toBe(50);
        const catchUp = await world({ action: 'advance', worldId: W, days: 1 });
        expect(catchUp.upkeep).toEqual([expect.objectContaining({ days: 3, storesFrom: 146, storesTo: 92 })]);
        // A correction that does change the day still re-anchors.
        const moved = await world({ action: 'update', worldId: W, environment: { day: 70 }, correction: true });
        expect(moved.upkeepAnchored).toEqual([{ partyId: pid, name: 'The Host', from: 53, to: 70 }]);
    });
});

describe('party_manage upkeep by hand', () => {
    it('charges days without the clock and moves lastDay; the clock catches up to it before charging again', async () => {
        await party({ action: 'set_upkeep', partyId: pid, ...link });
        const r = await party({ action: 'upkeep', partyId: pid, days: 2 });
        expect(r).toMatchObject({ success: true, actionType: 'upkeep', partyId: pid, days: 2, storesFrom: 200, storesTo: 164, mouths: 18, starvedDays: 0, lastDay: 49, daysLeft: 9 });
        expect(r.message).toMatch(/charged 2 day\(s\) by hand/);
        expect(pools('varek').stores.current).toBe(164);
        const a = await world({ action: 'advance', worldId: W, days: 1 });
        expect(a.upkeep).toBeUndefined();
        await world({ action: 'advance', worldId: W, days: 1 });
        expect(pools('varek').stores.current).toBe(164);
        const b = await world({ action: 'advance', worldId: W, days: 1 });
        expect(b.upkeep[0]).toMatchObject({ days: 1, storesFrom: 164, storesTo: 146 });
        const none = await party({ action: 'upkeep', partyId: farPid, days: 1 });
        expect(none.error).toBeTruthy();
        expect(none.message).toMatch(/no upkeep/);
    });
});

describe('muster shows stores and mouths', () => {
    it('stores, the mouth breakdown and days left ride the roster', async () => {
        const before = await party({ action: 'muster', partyId: pid });
        expect(before.upkeep).toBeUndefined();
        await party({ action: 'set_upkeep', partyId: pid, ...link });
        const m = await party({ action: 'muster', partyId: pid });
        expect(m.upkeep).toMatchObject({
            stores: { characterId: 'varek', pool: 'stores', current: 200, max: 600 },
            mouths: { total: 18, members: 10, pools: [{ characterId: 'varek', pool: 'captives', mouths: 8 }], extra: 0 },
            daysLeft: 11, lastDay: 47, starving: false
        });
        expect(m.message).toMatch(/stores 200 mouth-days \/ 18 mouths = 11 days/);
    });

    it('the outer mirror carries every set_upkeep and upkeep param', () => {
        const shape = PartyManageTool.inputSchema.shape as Record<string, unknown>;
        for (const k of ['linkPool', 'mouthsFromPool', 'extraMouths', 'countRoles', 'starvation', 'startDay', 'clear', 'days', 'worldId']) expect(shape[k], k).toBeDefined();
        expect((WorldManageTool.description)).toMatch(/upkeep/);
    });
});

describe('tickUpkeep is pure arithmetic', () => {
    const base: PartyUpkeep = { linkPool: { characterId: 'x', pool: 'stores' }, starvation: { loyaltyDelta: -2, perDay: false }, lastDay: 10 };
    it('once mode docks at the first shortfall only, and again after a fed day', () => {
        const t = tickUpkeep(base, 10, 18, 3);
        expect(t).toMatchObject({ storesFrom: 10, storesTo: 0, starvedDays: 3, loyaltyDelta: -2 });
        expect(t.upkeep).toMatchObject({ lastDay: 13, starvedSince: 11 });
        const t2 = tickUpkeep(t.upkeep, 0, 18, 1);
        expect(t2).toMatchObject({ starvedDays: 1, loyaltyDelta: 0 });
        expect(t2.upkeep.lastDay).toBe(14);
        const fed = tickUpkeep(t2.upkeep, 40, 18, 1);
        expect(fed).toMatchObject({ storesTo: 22, starvedDays: 0, loyaltyDelta: 0 });
        expect(fed.upkeep.starvedSince).toBeUndefined();
        const again = tickUpkeep(fed.upkeep, 22, 18, 2);
        expect(again).toMatchObject({ storesTo: 0, starvedDays: 1, loyaltyDelta: -2 });
    });

    it('perDay docks every starving day; no mouths eat nothing; zero days change nothing', () => {
        const perDay: PartyUpkeep = { ...base, starvation: { loyaltyDelta: -1, perDay: true } };
        expect(tickUpkeep(perDay, 20, 18, 3)).toMatchObject({ storesTo: 0, starvedDays: 2, loyaltyDelta: -2 });
        expect(tickUpkeep(perDay, 20, 0, 3)).toMatchObject({ storesTo: 20, starvedDays: 0, loyaltyDelta: 0 });
        expect(tickUpkeep(perDay, 20, 18, 0)).toMatchObject({ storesFrom: 20, storesTo: 20, starvedDays: 0, loyaltyDelta: 0 });
        expect(tickUpkeep(perDay, 20, 18, 0).upkeep.lastDay).toBe(10);
    });
});

describe('parties.upkeep migration', () => {
    it('adds the column once on a fresh database and leaves it alone on a second run', () => {
        const db = new Database(':memory:');
        migrate(db);
        migrate(db);
        const cols = (db.prepare('PRAGMA table_info(parties)').all() as Array<{ name: string }>).map(c => c.name);
        expect(cols.filter(c => c === 'upkeep')).toHaveLength(1);
        db.close();
    });
});
