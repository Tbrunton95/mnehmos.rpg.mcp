import { handlePartyManage, PartyManageTool } from '../../../src/server/consolidated/party-manage.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { InventoryRepository } from '../../../src/storage/repos/inventory.repo.js';
import { CorpseRepository } from '../../../src/storage/repos/corpse.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

/**
 * Item 7: the warband. Party members carry loyalty (0-10, unset reads 5),
 * a wage, a pay mode (wage | share | none) and a unit's model count.
 * muster reads the roster; pay pays wages first, then shares, from the
 * payer's purse (paid +1 loyalty, unpaid -1); after_battle books casualties
 * (models lost, the dead killed and struck off), moves survivors' loyalty
 * by the outcome, and adds recruits.
 */
const ctx = { sessionId: 'warband' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const party = async (a: Record<string, unknown>) => json(await handlePartyManage(PartyManageTool.inputSchema.parse(a), ctx as any));
const gold = (id: string) => new InventoryRepository(getDb()).getCurrency(id).gold;
const member = (pid: string, cid: string) => getDb().prepare('SELECT * FROM party_members WHERE party_id = ? AND character_id = ?').get(pid, cid) as any;

let pid: string;

beforeEach(async () => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    const repo = new CharacterRepository(db);
    const mk = (id: string, name: string) => repo.create({ id, name, characterType: 'npc', stats: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 12, level: 1, createdAt: now, updatedAt: now } as any);
    mk('lord', 'Warlord'); mk('merc', 'Sellsword'); mk('bro', 'Blood Brother'); mk('warriors', 'Chaos Warriors'); mk('thrall', 'Thrall'); mk('newbie', 'Recruit');
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
