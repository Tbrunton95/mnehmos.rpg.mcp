import { randomUUID } from 'crypto';
import { handleSpatialManage, SpatialManageTool } from '../../../src/server/consolidated/spatial-manage.js';
import { advanceWorldClock } from '../../../src/server/consolidated/world-manage.js';
import { readWorldClock } from '../../../src/engine/world-clock.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { InventoryRepository } from '../../../src/storage/repos/inventory.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

/**
 * Item 6 and the link bug. spatial_manage link wrote exits typed 'passage',
 * which the room reader's enum rejects, so a linked room threw on every
 * read. Link now writes type OPEN (locked/hidden map to the enum) with the
 * free text in kind, and legacy exits heal on read. Gates join rooms across
 * networks: a toll in gold, a holder, open/closed, and a traverse that can
 * advance the world clock by the travel time.
 */
const W = 'realm-world';
const ctx = { sessionId: 'gates' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const sp = async (a: Record<string, unknown>) => json(await handleSpatialManage(SpatialManageTool.inputSchema.parse(a), ctx as any));
const gold = (id: string) => new InventoryRepository(getDb()).getCurrency(id).gold;
const roomOf = (id: string) => (getDb().prepare('SELECT current_room_id AS r FROM characters WHERE id = ?').get(id) as any).r;

let kor: string;
let netA: string; let netB: string;
let hall: string; let yard: string; let far: string;

const room = async (name: string, networkId?: string) => (await sp({ action: 'generate', name, baseDescription: `The ${name}, stone and smoke.`, biomeContext: 'urban', ...(networkId ? { networkId } : {}) })).roomId as string;

beforeEach(async () => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Realms', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 5, time: '06:00' } } as any);
    kor = randomUUID();
    new CharacterRepository(db).create({ id: kor, name: 'Kor', characterType: 'pc', stats: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 12, level: 3, createdAt: now, updatedAt: now } as any);
    new InventoryRepository(db).setCurrency(kor, { gold: 10 });
    netA = (await sp({ action: 'network_create', name: 'Varnholt', networkType: 'cluster', worldId: W, centerX: 1, centerY: 1 })).networkId;
    netB = (await sp({ action: 'network_create', name: 'The Brass Realm', networkType: 'cluster', worldId: W, centerX: 8, centerY: 8 })).networkId;
    hall = await room('Hall', netA);
    yard = await room('Yard', netA);
    far = await room('Brass Gate', netB);
});
afterEach(() => closeDb());

describe('spatial_manage link', () => {
    it('linked rooms read, list their exits and can be walked by direction', async () => {
        const l = await sp({ action: 'link', fromRoomId: hall, toRoomId: yard, direction: 'north', exitType: 'door' });
        expect(l.success).toBe(true);
        const ex = await sp({ action: 'get_exits', roomId: hall });
        expect(ex.exits).toEqual([expect.objectContaining({ direction: 'north', targetNodeId: yard, type: 'OPEN', kind: 'door' })]);
        await sp({ action: 'move', characterId: kor, roomId: hall });
        const look = await sp({ action: 'look', observerId: kor });
        expect(look.exits.map((e: any) => e.direction)).toEqual(['north']);
        const mv = await sp({ action: 'move', characterId: kor, direction: 'north' });
        expect(mv).toMatchObject({ success: true, newRoomId: yard });
        expect((await sp({ action: 'get_exits', roomId: yard })).exits[0]).toMatchObject({ direction: 'south', targetNodeId: hall, type: 'OPEN' });
    });

    it('a locked or hidden exitType maps to the exit enum', async () => {
        await sp({ action: 'link', fromRoomId: hall, toRoomId: yard, direction: 'east', exitType: 'locked door' });
        expect((await sp({ action: 'get_exits', roomId: hall })).exits[0]).toMatchObject({ type: 'LOCKED', kind: 'locked door' });
    });

    it('legacy exits typed passage heal on read', async () => {
        getDb().prepare('UPDATE room_nodes SET exits = ? WHERE id = ?').run(JSON.stringify([{ direction: 'west', targetNodeId: yard, type: 'passage' }]), hall);
        const ex = await sp({ action: 'get_exits', roomId: hall });
        expect(ex.exits[0]).toMatchObject({ direction: 'west', type: 'OPEN', kind: 'passage' });
        await sp({ action: 'move', characterId: kor, roomId: hall });
        expect((await sp({ action: 'move', characterId: kor, direction: 'west' })).newRoomId).toBe(yard);
    });
});

describe('spatial_manage gates', () => {
    const gate = async (a: Record<string, unknown> = {}) => sp({ action: 'gate_create', worldId: W, name: 'Realmgate', fromRoomId: yard, toRoomId: far, direction: 'down', travelHours: 30, toll: { gold: 3 }, holder: 'The Brass Lord', ...a });

    it('gate_create writes gate exits on both sides; gate_list finds it by world and room', async () => {
        const g = await gate();
        expect(g).toMatchObject({ success: true, gate: { name: 'Realmgate', status: 'open', bidirectional: true, travelHours: 30, toll: { gold: 3 }, holder: 'The Brass Lord' } });
        expect((await sp({ action: 'get_exits', roomId: yard })).exits[0]).toMatchObject({ direction: 'down', targetNodeId: far, type: 'OPEN', kind: 'gate', gateId: g.gateId });
        expect((await sp({ action: 'get_exits', roomId: far })).exits[0]).toMatchObject({ direction: 'up', targetNodeId: yard, kind: 'gate' });
        expect((await sp({ action: 'gate_list', worldId: W })).count).toBe(1);
        expect((await sp({ action: 'gate_list', roomId: far })).gates[0].gateId).toBe(g.gateId);
        expect((await sp({ action: 'gate_list', roomId: hall })).count).toBe(0);
    });

    it('traverse crosses networks, takes the toll in gold and advances the clock', async () => {
        const g = await gate();
        await sp({ action: 'move', characterId: kor, roomId: yard });
        const t = await sp({ action: 'traverse', gateId: g.gateId, characterId: kor, advanceClock: true });
        expect(t).toMatchObject({ success: true, from: { roomId: yard }, to: { roomId: far }, tollPaid: { gold: 3 } });
        expect(t.clock).toMatchObject({ clock: 'Day 6, 12:00', dueNow: { scheduled: 0, debts: 0 } });
        expect(gold(kor)).toBe(7);
        expect(roomOf(kor)).toBe(far);
        expect(readWorldClock(getDb(), W)).toMatchObject({ day: 6, time: '12:00' });
        // Back the other way: bidirectional, toll again, no clock.
        const back = await sp({ action: 'traverse', gateId: g.gateId, characterId: kor });
        expect(back.to.roomId).toBe(yard);
        expect(back.clock).toBeUndefined();
        expect(gold(kor)).toBe(4);
    });

    it('refuses a short purse, a closed gate, a one-way return and a traveller not at the gate; nothing is written', async () => {
        const g = await gate({ toll: { gold: 50 } });
        await sp({ action: 'move', characterId: kor, roomId: yard });
        expect((await sp({ action: 'traverse', gateId: g.gateId, characterId: kor })).message).toMatch(/toll/i);
        expect(gold(kor)).toBe(10);
        expect(roomOf(kor)).toBe(yard);

        const shut = await sp({ action: 'set_gate', gateId: g.gateId, status: 'closed', holder: 'Nobody' });
        expect(shut.gate).toMatchObject({ status: 'closed', holder: 'Nobody' });
        expect((await sp({ action: 'get_exits', roomId: yard })).exits[0].type).toBe('LOCKED');
        expect((await sp({ action: 'traverse', gateId: g.gateId, characterId: kor })).message).toMatch(/closed/i);
        await sp({ action: 'set_gate', gateId: g.gateId, status: 'open' });
        expect((await sp({ action: 'get_exits', roomId: far })).exits[0].type).toBe('OPEN');

        const oneWay = await gate({ name: 'Oneway', fromRoomId: hall, direction: 'up', toll: undefined, bidirectional: false });
        await sp({ action: 'move', characterId: kor, roomId: far });
        expect((await sp({ action: 'traverse', gateId: oneWay.gateId, characterId: kor })).message).toMatch(/one way/i);
        await sp({ action: 'move', characterId: kor, roomId: yard });
        expect((await sp({ action: 'traverse', gateId: oneWay.gateId, characterId: kor })).message).toMatch(/not at/i);
        expect(roomOf(kor)).toBe(yard);
    });
});

describe('advanceWorldClock', () => {
    it('is the advance write path, callable directly', () => {
        const r = advanceWorldClock(W, 20) as any;
        expect(r).toMatchObject({ success: true, clock: 'Day 6, 02:00', dueNow: { scheduled: 0, debts: 0 } });
        expect((advanceWorldClock('nowhere', 1) as any).error).toBe(true);
    });
});
