import { handlePartyManage, PartyManageTool } from '../../../src/server/consolidated/party-manage.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { InventoryRepository } from '../../../src/storage/repos/inventory.repo.js';
import { CorpseRepository } from '../../../src/storage/repos/corpse.repo.js';
import { EncounterRepository } from '../../../src/storage/repos/encounter.repo.js';
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

/**
 * Item 7: the warband. Party members carry loyalty (0-10, unset reads 5),
 * a wage, a pay mode (wage | share | none) and a unit's model count.
 * muster reads the roster; pay pays wages first, then shares, from the
 * payer's purse (paid +1 loyalty, unpaid -1); after_battle books casualties
 * (models lost, the dead killed and struck off), moves survivors' loyalty
 * by the outcome, and adds recruits. Play report 3: after_battle takes
 * participants (member ids or names) and/or encounterId (the fight's tokens,
 * boarding children included) so only those who fought move; the rest are
 * reported absent and untouched.
 */
const ctx = { sessionId: 'warband' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const party = async (a: Record<string, unknown>) => json(await handlePartyManage(PartyManageTool.inputSchema.parse(a), ctx as any));
const gold = (id: string) => new InventoryRepository(getDb()).getCurrency(id).gold;
const member = (pid: string, cid: string) => getDb().prepare('SELECT * FROM party_members WHERE party_id = ? AND character_id = ?').get(pid, cid) as any;
const now = () => new Date().toISOString();
const mkChar = (id: string, name: string) => new CharacterRepository(getDb()).create({ id, name, characterType: 'npc', stats: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 12, level: 1, createdAt: now(), updatedAt: now() } as any);
const token = (id: string) => ({ id, name: id, initiativeBonus: 0, hp: 10, maxHp: 10, conditions: [], position: { x: 0, y: 0 } });
/** An ended fight laid straight into the encounters table (tokens stay after end), optionally hung off a parent as a boarding. */
const encounter = (id: string, tokenIds: string[], parentId?: string) => {
    const repo = new EncounterRepository(getDb());
    repo.create({ id, tokens: tokenIds.map(token), round: 1, status: 'completed', createdAt: now(), updatedAt: now() } as any);
    if (parentId) repo.setParent(id, parentId);
    return id;
};
const ids = (xs: Array<{ characterId: string }>) => xs.map(x => x.characterId).sort();

let pid: string;

beforeEach(async () => {
    closeDb(); clearCombatState();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    const repo = new CharacterRepository(db);
    const mk = (id: string, name: string, pools: Record<string, unknown> = {}) => repo.create({ id, name, characterType: 'npc', stats: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 12, level: 1, resourcePools: pools, createdAt: now, updatedAt: now } as any);
    mk('lord', 'Warlord', { stores: { current: 60, max: 60, label: 'Stores (mouth-days)' }, captives: { current: 2, max: 10 } }); mk('merc', 'Sellsword'); mk('bro', 'Blood Brother'); mk('warriors', 'Chaos Warriors'); mk('thrall', 'Thrall'); mk('newbie', 'Recruit');
    new InventoryRepository(db).setCurrency('lord', { gold: 30 });
    pid = (await party({ action: 'create', name: 'The Host', initialMembers: [{ characterId: 'lord', role: 'leader' }] })).party.id;
    await party({ action: 'add_member', partyId: pid, characterId: 'merc', role: 'hireling', wage: 10, payMode: 'wage', loyalty: 4 });
    await party({ action: 'add_member', partyId: pid, characterId: 'bro', payMode: 'share', sharePercentage: 100 });
    await party({ action: 'add_member', partyId: pid, characterId: 'warriors', unitModels: 10, payMode: 'none' });
    await party({ action: 'add_member', partyId: pid, characterId: 'thrall', role: 'prisoner' });
});
afterEach(() => closeDb());

describe('party warband', () => {
    it('add_member and update_member store loyalty, wage, payMode and unitModels', async () => {
        expect(member(pid, 'merc')).toMatchObject({ loyalty: 4, wage: 10, pay_mode: 'wage' });
        expect(member(pid, 'warriors')).toMatchObject({ unit_models: 10, pay_mode: 'none', loyalty: null });
        const u = await party({ action: 'update_member', partyId: pid, characterId: 'thrall', loyalty: 1, wage: 0, payMode: 'none', unitModels: 1 });
        expect(u).toMatchObject({ success: true, loyalty: 1, wage: 0, payMode: 'none', unitModels: 1 });
        expect(() => PartyManageTool.inputSchema.parse({ action: 'update_member', loyalty: 11 })).toThrow();
        expect(json(await handlePartyManage({ action: 'update_member', partyId: pid, characterId: 'thrall', loyalty: 11 }, ctx as any)).error).toBeTruthy();
        expect(member(pid, 'thrall').loyalty).toBe(1);
    });

    it('muster lists the roster with loyalty (unset reads 5), pay and models', async () => {
        const m = await party({ action: 'muster', partyId: pid });
        expect(m.success).toBe(true);
        const by = Object.fromEntries(m.members.map((x: any) => [x.characterId, x]));
        expect(by.merc).toMatchObject({ name: 'Sellsword', loyalty: 4, wage: 10, payMode: 'wage' });
        expect(by.warriors).toMatchObject({ loyalty: 5, unitModels: 10, payMode: 'none' });
        expect(by.bro).toMatchObject({ loyalty: 5, payMode: 'share' });
        expect(m.wagesDue).toBe(10);
    });

    it('pay: wages first, then shares, from the leader; paid +1 loyalty, unpaid -1', async () => {
        const r = await party({ action: 'pay', partyId: pid, amount: 25 });
        expect(r).toMatchObject({ success: true, payerId: 'lord' });
        expect(r.paid).toEqual(expect.arrayContaining([
            expect.objectContaining({ characterId: 'merc', gold: 10, as: 'wage', loyalty: 5 }),
            expect.objectContaining({ characterId: 'bro', gold: 15, as: 'share', loyalty: 6 })
        ]));
        expect(gold('lord')).toBe(5);
        expect(gold('merc')).toBe(10);
        expect(gold('bro')).toBe(15);
        expect(member(pid, 'warriors').loyalty).toBeNull();
        // The purse is short now: the wage goes unpaid and loyalty drops.
        const r2 = await party({ action: 'pay', partyId: pid });
        expect(r2.unpaid).toEqual([expect.objectContaining({ characterId: 'merc', owed: 10, loyalty: 4 })]);
        expect(gold('lord')).toBe(5);
        expect(member(pid, 'bro').loyalty).toBe(6);
    });

    it('after_battle books models lost, kills the dead, moves loyalty and adds recruits', async () => {
        const r = await party({ action: 'after_battle', partyId: pid, victory: true,
            casualties: [{ characterId: 'warriors', models: 4 }, { characterId: 'bro', dead: true }],
            recruits: [{ characterId: 'newbie', role: 'hireling', wage: 2, payMode: 'wage' }] });
        expect(r.success).toBe(true);
        expect(r.losses).toEqual([expect.objectContaining({ characterId: 'warriors', models: 4, unitModels: 6 })]);
        expect(r.killed).toEqual([expect.objectContaining({ characterId: 'bro' })]);
        expect(member(pid, 'bro')).toBeUndefined();
        expect(new CharacterRepository(getDb()).findById('bro')!.hp).toBe(0);
        expect(new CorpseRepository(getDb()).findByCharacterId('bro')).toBeTruthy();
        expect(member(pid, 'warriors')).toMatchObject({ unit_models: 6, loyalty: 6 });
        expect(member(pid, 'merc').loyalty).toBe(5);
        expect(member(pid, 'newbie')).toMatchObject({ role: 'hireling', wage: 2, loyalty: null });
        expect(r.recruited).toEqual([expect.objectContaining({ characterId: 'newbie' })]);
    });

    it('a unit that loses its last model dies; defeat costs loyalty; bad input writes nothing', async () => {
        const bad = await party({ action: 'after_battle', partyId: pid, victory: false, casualties: [{ characterId: 'nobody', models: 1 }] });
        expect(bad.error).toBeTruthy();
        expect(member(pid, 'merc').loyalty).toBe(4);
        const r = await party({ action: 'after_battle', partyId: pid, victory: false, casualties: [{ characterId: 'warriors', models: 10 }] });
        expect(r.killed.map((k: any) => k.characterId)).toEqual(['warriors']);
        expect(member(pid, 'warriors')).toBeUndefined();
        expect(member(pid, 'merc').loyalty).toBe(3);
        expect(member(pid, 'bro').loyalty).toBe(4);
    });
});

describe('after_battle: who fought', () => {
    it('participants by name (case-insensitive) and by id: the rest are absent and untouched', async () => {
        const r = await party({ action: 'after_battle', partyId: pid, victory: true, participants: ['SELLSWORD', 'warriors'] });
        expect(r.success).toBe(true);
        expect(r.participantSource).toBe('participants');
        expect(ids(r.participants)).toEqual(['merc', 'warriors']);
        expect(r.participants.find((p: any) => p.characterId === 'merc')).toMatchObject({ name: 'Sellsword' });
        expect(ids(r.absent)).toEqual(['bro', 'lord', 'thrall']);
        expect(r.absent.find((a: any) => a.characterId === 'bro')).toEqual({ characterId: 'bro', name: 'Blood Brother', loyalty: 5 });
        expect(ids(r.loyalty)).toEqual(['merc', 'warriors']);
        expect(member(pid, 'merc').loyalty).toBe(5);
        expect(member(pid, 'warriors').loyalty).toBe(6);
        expect(member(pid, 'lord').loyalty).toBeNull();
        expect(member(pid, 'bro').loyalty).toBeNull();
        expect(member(pid, 'thrall').loyalty).toBeNull();
        expect(r.message).toMatch(/absent, untouched: Warlord, Blood Brother, Thrall/);
        expect(r.note).toBeUndefined();
    });

    it('a name matching two members is refused naming both; an unknown name, id or non-member is refused; nothing is written', async () => {
        mkChar('twin-a', 'Twin'); mkChar('twin-b', 'Twin');
        await party({ action: 'add_member', partyId: pid, characterId: 'twin-a' });
        await party({ action: 'add_member', partyId: pid, characterId: 'twin-b' });
        const amb = await party({ action: 'after_battle', partyId: pid, victory: true, participants: ['twin'] });
        expect(amb.error).toBeTruthy();
        expect(amb.message).toMatch(/twin-a/);
        expect(amb.message).toMatch(/twin-b/);
        expect(amb.message).toMatch(/Nothing was written/);
        const unknown = await party({ action: 'after_battle', partyId: pid, victory: true, participants: ['Sellsword', 'nobody'] });
        expect(unknown.error).toBeTruthy();
        expect(unknown.message).toMatch(/nobody/);
        // newbie exists but is not in the party.
        const stranger = await party({ action: 'after_battle', partyId: pid, victory: true, participants: ['newbie'] });
        expect(stranger.error).toBeTruthy();
        expect(stranger.message).toMatch(/newbie/);
        expect(member(pid, 'merc').loyalty).toBe(4);
        expect(member(pid, 'twin-a').loyalty).toBeNull();
        expect(member(pid, 'lord').loyalty).toBeNull();
    });

    it('encounterId: members whose character was a token in any listed encounter fought; short token ids resolve; an ended fight still counts', async () => {
        mkChar('chaos-knights-00000000', 'Chaos Knights');
        await party({ action: 'add_member', partyId: pid, characterId: 'chaos-knights-00000000', unitModels: 5 });
        const a = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'lord', name: 'Warlord', hp: 10, maxHp: 10, position: { x: 0, y: 0 } },
            { id: 'raider', name: 'Raider', hp: 5, maxHp: 5, isEnemy: true, position: { x: 1, y: 0 } }
        ] }, ctx as any)).encounterId;
        expect(json(await handleCombatManage({ action: 'end', encounterId: a }, ctx as any)).success).toBe(true);
        encounter('raid-b', ['chaos-knights', 'raider-2']);
        const r = await party({ action: 'after_battle', partyId: pid, victory: true, encounterId: [a, 'raid-b'] });
        expect(r.success).toBe(true);
        expect(r.participantSource).toBe('encounters');
        expect(r.encounterIds).toEqual([a, 'raid-b']);
        expect(ids(r.participants)).toEqual(['chaos-knights-00000000', 'lord']);
        expect(ids(r.absent)).toEqual(['bro', 'merc', 'thrall', 'warriors']);
        expect(member(pid, 'lord').loyalty).toBe(6);
        expect(member(pid, 'chaos-knights-00000000').loyalty).toBe(6);
        expect(member(pid, 'merc').loyalty).toBe(4);
        expect(member(pid, 'warriors').loyalty).toBeNull();
        expect(member(pid, 'thrall').loyalty).toBeNull();
    });

    it('a boarding child counts for its parent; a single encounterId string works', async () => {
        encounter('void-fight', ['gloriana-vessel', 'murder-vessel']);
        encounter('boarding-1', ['bro', 'crew-1'], 'void-fight');
        const r = await party({ action: 'after_battle', partyId: pid, victory: false, encounterId: 'void-fight' });
        expect(r.success).toBe(true);
        expect(r.participantSource).toBe('encounters');
        expect(ids(r.participants)).toEqual(['bro']);
        expect(member(pid, 'bro').loyalty).toBe(4);
        expect(member(pid, 'merc').loyalty).toBe(4);
        expect(member(pid, 'lord').loyalty).toBeNull();
    });

    it('participants and encounterId together are unioned; casualties always count as having fought', async () => {
        encounter('skirmish', ['lord', 'raider']);
        const r = await party({ action: 'after_battle', partyId: pid, victory: true, participants: ['Sellsword'], encounterId: 'skirmish', casualties: [{ characterId: 'warriors', models: 3 }] });
        expect(r.success).toBe(true);
        expect(r.participantSource).toBe('participants');
        expect(r.encounterIds).toEqual(['skirmish']);
        expect(ids(r.participants)).toEqual(['lord', 'merc', 'warriors']);
        expect(ids(r.absent)).toEqual(['bro', 'thrall']);
        expect(member(pid, 'warriors')).toMatchObject({ unit_models: 7, loyalty: 6 });
        expect(member(pid, 'lord').loyalty).toBe(6);
        expect(member(pid, 'merc').loyalty).toBe(5);
        expect(member(pid, 'bro').loyalty).toBeNull();
    });

    it('a missing encounter, or one no member fought in, is refused with nothing written', async () => {
        const missing = await party({ action: 'after_battle', partyId: pid, victory: true, encounterId: 'no-such-fight' });
        expect(missing.error).toBeTruthy();
        expect(missing.message).toMatch(/no-such-fight/);
        encounter('others', ['stranger-1', 'stranger-2']);
        const none = await party({ action: 'after_battle', partyId: pid, victory: true, encounterId: ['others'], casualties: [{ characterId: 'warriors', models: 1 }] });
        expect(none.error).toBeTruthy();
        expect(none.message).toMatch(/others/);
        expect(none.message).toMatch(/Nothing was written/);
        expect(member(pid, 'merc').loyalty).toBe(4);
        expect(member(pid, 'warriors').unit_models).toBe(10);
    });

    it('live path: includeParty and add_participant tokens count; a captured enemy now held as prisoner stays put unless named', async () => {
        mkChar('raider-chief-00000000', 'Raider Chief');
        const a = json(await handleCombatManage({ action: 'create', includeParty: true, partyId: pid, participants: [
            { id: 'mook-1', name: 'Mook', hp: 5, maxHp: 5, isEnemy: true, position: { x: 3, y: 3 } }
        ] }, ctx as any)).encounterId;
        expect(json(await handleCombatManage({ action: 'add_participant', encounterId: a, characterId: 'raider-chief', isEnemy: true, position: { x: 4, y: 4 } }, ctx as any)).success).toBe(true);
        expect(json(await handleCombatManage({ action: 'end', encounterId: a }, ctx as any)).success).toBe(true);
        // The row keeps the tokens after end: members by character id (the prisoner was never pulled in), the NPC enemy by its full id.
        const stored = (JSON.parse(new EncounterRepository(getDb()).findById(a)!.tokens) as Array<{ id: string }>).map(t => t.id).sort();
        expect(stored).toEqual(['bro', 'lord', 'merc', 'mook-1', 'raider-chief-00000000', 'warriors']);
        // Captured and held before the aftermath is booked: the victory over him is not his.
        await party({ action: 'add_member', partyId: pid, characterId: 'raider-chief-00000000', role: 'prisoner' });
        const r = await party({ action: 'after_battle', partyId: pid, victory: true, encounterId: a });
        expect(r.success).toBe(true);
        expect(r.participantSource).toBe('encounters');
        expect(ids(r.participants)).toEqual(['bro', 'lord', 'merc', 'warriors']);
        expect(ids(r.absent)).toEqual(['raider-chief-00000000', 'thrall']);
        expect(member(pid, 'raider-chief-00000000').loyalty).toBeNull();
        expect(member(pid, 'thrall').loyalty).toBeNull();
        expect(member(pid, 'lord').loyalty).toBe(6);
        expect((r.growth ?? []).map((g: any) => g.characterId)).not.toContain('raider-chief-00000000');
        // Named outright, a prisoner still counts (a thrall made to fight).
        const r2 = await party({ action: 'after_battle', partyId: pid, victory: true, encounterId: a, participants: ['Thrall'] });
        expect(ids(r2.participants)).toEqual(['bro', 'lord', 'merc', 'thrall', 'warriors']);
        expect(member(pid, 'thrall').loyalty).toBe(6);
        expect(member(pid, 'raider-chief-00000000').loyalty).toBeNull();
        // A fight where the only member token is now a prisoner is one no member fought in.
        encounter('ambush', ['raider-chief-00000000', 'mook-2']);
        const none = await party({ action: 'after_battle', partyId: pid, victory: true, encounterId: 'ambush' });
        expect(none.error).toBeTruthy();
        expect(none.message).toMatch(/ambush/);
        expect(none.message).toMatch(/prisoner/i);
        expect(member(pid, 'lord').loyalty).toBe(7);
    });

    it('an exact name beats another member\'s id prefix; a short id still resolves', async () => {
        mkChar('warlord-of-the-wastes', 'Wastes Warlord');
        await party({ action: 'add_member', partyId: pid, characterId: 'warlord-of-the-wastes' });
        // 'Warlord' is Warlord's name and, case-folded, a 7-char prefix of the other member's id.
        const r = await party({ action: 'after_battle', partyId: pid, victory: true, participants: ['Warlord'] });
        expect(r.success).toBe(true);
        expect(ids(r.participants)).toEqual(['lord']);
        expect(r.absent.find((x: any) => x.characterId === 'warlord-of-the-wastes')).toEqual({ characterId: 'warlord-of-the-wastes', name: 'Wastes Warlord', loyalty: 5 });
        expect(member(pid, 'lord').loyalty).toBe(6);
        expect(member(pid, 'warlord-of-the-wastes').loyalty).toBeNull();
        const r2 = await party({ action: 'after_battle', partyId: pid, victory: true, participants: ['warlord-of-the'] });
        expect(ids(r2.participants)).toEqual(['warlord-of-the-wastes']);
        expect(member(pid, 'warlord-of-the-wastes').loyalty).toBe(6);
        expect(member(pid, 'lord').loyalty).toBe(6);
    });

    it('every refusal before a write says writes: none', async () => {
        mkChar('twin-a', 'Twin'); mkChar('twin-b', 'Twin');
        await party({ action: 'add_member', partyId: pid, characterId: 'twin-a' });
        await party({ action: 'add_member', partyId: pid, characterId: 'twin-b' });
        encounter('others', ['stranger-1']);
        const refusals = [
            await party({ action: 'after_battle', partyId: pid, victory: true, participants: ['twin'] }),
            await party({ action: 'after_battle', partyId: pid, victory: true, participants: ['nobody'] }),
            await party({ action: 'after_battle', partyId: pid, victory: true, encounterId: 'no-such-fight' }),
            await party({ action: 'after_battle', partyId: pid, victory: true, encounterId: 'others' }),
            await party({ action: 'after_battle', partyId: pid, victory: true, casualties: [{ characterId: 'newbie', dead: true }] }),
            await party({ action: 'after_battle', partyId: pid, victory: true, recruits: [{ characterId: 'lord' }] })
        ];
        for (const r of refusals) {
            expect(r.error).toBeTruthy();
            expect(r.writes).toBe('none');
            expect(r.message).toMatch(/Nothing was written/);
        }
        expect(member(pid, 'lord').loyalty).toBeNull();
    });

    it('without participants or encounterId every member counts as in the fight, and the reply says so', async () => {
        const r = await party({ action: 'after_battle', partyId: pid, victory: true });
        expect(r.participantSource).toBe('all');
        expect(r.absent).toEqual([]);
        expect(ids(r.participants)).toEqual(['bro', 'lord', 'merc', 'thrall', 'warriors']);
        expect(r.note).toMatch(/every member counted as in the fight/);
        expect(r.message).toMatch(/every member counted as in the fight/);
        expect(member(pid, 'thrall').loyalty).toBe(6);
        expect(r.encounterIds).toBeUndefined();
    });
});

/**
 * Play report 3: upkeep. Stores live in ONE linked character pool (mouth-days);
 * the party row keeps the link, the mouth pools, the roles counted, the
 * starvation rule and the day it was last charged. set_upkeep needs a world
 * clock and refuses a pool the character does not carry; muster shows stores
 * against mouths as days left; upkeep {days} charges by hand; clear unlinks.
 */
describe('party upkeep', () => {
    const upkeepRow = () => { const r = getDb().prepare('SELECT upkeep, world_id FROM parties WHERE id = ?').get(pid) as { upkeep: string | null; world_id: string | null }; return { upkeep: r.upkeep ? JSON.parse(r.upkeep) : null, worldId: r.world_id }; };
    const stores = () => (new CharacterRepository(getDb()).findById('lord') as any).resourcePools.stores.current as number;

    it('needs a world with a clock, then links the pool, counts mouths and starts from today', async () => {
        const noWorld = await party({ action: 'set_upkeep', partyId: pid, linkPool: { characterId: 'lord', pool: 'stores' } });
        expect(noWorld.error).toBeTruthy();
        expect(noWorld.message).toMatch(/no world/);
        expect(noWorld.writes).toBe('none');
        const now = new Date().toISOString();
        new WorldRepository(getDb()).create({ id: 'host-world', name: 'Host', seed: 's', width: 4, height: 4, createdAt: now, updatedAt: now } as any);
        const noClock = await party({ action: 'set_upkeep', partyId: pid, worldId: 'host-world', linkPool: { characterId: 'lord', pool: 'stores' } });
        expect(noClock.error).toBeTruthy();
        expect(noClock.message).toMatch(/set the world clock once with world_manage update/);
        expect(upkeepRow()).toEqual({ upkeep: null, worldId: null });

        getDb().prepare('UPDATE worlds SET environment = ? WHERE id = ?').run(JSON.stringify({ day: 12, time: '08:00' }), 'host-world');
        const r = await party({ action: 'set_upkeep', partyId: pid, worldId: 'host-world', linkPool: { characterId: 'lord', pool: 'stores' }, mouthsFromPool: [{ characterId: 'lord', pool: 'captives' }] });
        expect(r).toMatchObject({ success: true, startDay: 12, daysLeft: 3, stores: { characterId: 'lord', pool: 'stores', current: 60, max: 60 }, mouths: { total: 16, members: 14, pools: [{ characterId: 'lord', pool: 'captives', mouths: 2 }] } });
        expect(r.message).toMatch(/upkeep starts from Day 12; nothing before it is charged/);
        expect(r.message).toMatch(/60 mouth-days at 16 mouths = 3 days/);
        // The party had no world: the one passed is written to it so advance finds it.
        expect(upkeepRow()).toMatchObject({ worldId: 'host-world', upkeep: { linkPool: { characterId: 'lord', pool: 'stores' }, lastDay: 12 } });
        expect(stores()).toBe(60);

        const m = await party({ action: 'muster', partyId: pid });
        expect(m.upkeep).toMatchObject({ stores: { current: 60, max: 60 }, mouths: { total: 16 }, daysLeft: 3, lastDay: 12 });
        expect(m.message).toMatch(/stores 60 mouth-days \/ 16 mouths = 3 days/);

        const tick = await party({ action: 'upkeep', partyId: pid, days: 1 });
        expect(tick).toMatchObject({ success: true, days: 1, storesFrom: 60, storesTo: 44, mouths: 16, starvedDays: 0, lastDay: 13 });
        expect(stores()).toBe(44);

        const cleared = await party({ action: 'set_upkeep', partyId: pid, clear: true });
        expect(cleared).toMatchObject({ success: true, cleared: true });
        expect(upkeepRow().upkeep).toBeNull();
        expect((await party({ action: 'muster', partyId: pid })).upkeep).toBeUndefined();
        expect(stores()).toBe(44);
    });

    it('refuses an unknown party and a missing linkPool on a first set', async () => {
        const gone = await party({ action: 'set_upkeep', partyId: 'nobody-here', linkPool: { characterId: 'lord', pool: 'stores' } });
        expect(gone.error).toBeTruthy();
        const now = new Date().toISOString();
        new WorldRepository(getDb()).create({ id: 'host-world', name: 'Host', seed: 's', width: 4, height: 4, createdAt: now, updatedAt: now, environment: { day: 1, time: '06:00' } } as any);
        const noLink = await party({ action: 'set_upkeep', partyId: pid, worldId: 'host-world' });
        expect(noLink.error).toBeTruthy();
        expect(noLink.message).toMatch(/linkPool/);
        expect(noLink.writes).toBe('none');
    });
});
