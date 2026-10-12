import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { clearCombatState, getOrLoadEngine } from '../../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

/**
 * Play report 2, item 15: per-ability verbs on the sheet. spend_ability and
 * restore_ability flip one ability's ready flag (or every spent one) in the
 * combat profile and patch the same ability by name on the character's live
 * tokens, never resending the whole array.
 */
const ctx = { sessionId: 'abilities' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const sheet = (id = 'vex') => new CharacterRepository(getDb()).findById(id)! as any;
const storedToken = (enc: string, id: string) => (JSON.parse((getDb().prepare('SELECT tokens FROM encounters WHERE id = ?').get(enc) as any).tokens) as any[]).find(t => t.id === id);

describe('character_manage spend_ability / restore_ability', () => {
    beforeEach(() => {
        closeDb(); clearCombatState();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new CharacterRepository(db).create({
            id: 'vex', name: 'Vex', characterType: 'pc', stats: { str: 14, dex: 16, con: 12, int: 10, wis: 10, cha: 14 }, hp: 30, maxHp: 30, ac: 15, level: 6,
            attacks: [{ name: 'sword', attackBonus: 6, damage: '1d8+3' }],
            abilities: [{ name: 'Action Surge', grantsAction: true }, { name: 'Second Wind' }, { name: 'Fire Breath', recharge: 5 }],
            createdAt: now, updatedAt: now
        } as any);
    });
    afterEach(() => closeDb());

    it('spend flips only the named ability (any case), keeps the rest of the combat profile, and says it grants no action', async () => {
        const r = await char({ action: 'spend_ability', characterId: 'vex', name: 'action surge', reason: 'used in the alley' });
        expect(r).toMatchObject({ success: true, actionType: 'spend_ability', characterId: 'vex', characterName: 'Vex', ability: 'Action Surge', ready: false, bookkeeping: true, liveTokens: [], tokensWithoutAbility: [] });
        expect(r.message).toMatch(/Action Surge marked spent — bookkeeping only; it grants no action/);
        expect(r.message).toMatch(/used in the alley/);
        const s = sheet();
        expect(s.abilities).toEqual([
            { name: 'Action Surge', grantsAction: true, ready: false },
            { name: 'Second Wind', ready: true },
            { name: 'Fire Breath', recharge: 5, ready: true }
        ]);
        expect(s.attacks).toEqual([{ name: 'sword', attackBonus: 6, damage: '1d8+3' }]);
    });

    it('refuses an unknown ability (listing the known ones), an already-spent one, and a bad name/all pairing, writing nothing', async () => {
        const unknown = await char({ action: 'spend_ability', characterId: 'vex', name: 'Haste' });
        expect(unknown).toMatchObject({ error: true, writes: 'none' });
        expect(unknown.message).toMatch(/Vex has no ability 'Haste'; it has Action Surge, Second Wind, Fire Breath/);
        await char({ action: 'spend_ability', characterId: 'vex', name: 'Second Wind' });
        const twice = await char({ action: 'spend_ability', characterId: 'vex', name: 'Second Wind' });
        expect(twice).toMatchObject({ error: true, writes: 'none' });
        expect(twice.message).toMatch(/Second Wind is already spent/);
        const ready = await char({ action: 'restore_ability', characterId: 'vex', name: 'Action Surge' });
        expect(ready).toMatchObject({ error: true, writes: 'none' });
        expect(ready.message).toMatch(/Action Surge is already ready/);
        expect((await char({ action: 'restore_ability', characterId: 'vex' })).writes).toBe('none');
        expect((await char({ action: 'restore_ability', characterId: 'vex', name: 'Second Wind', all: true })).writes).toBe('none');
        expect((await char({ action: 'spend_ability', characterId: 'nobody', name: 'Second Wind' })).writes).toBe('none');
        expect(sheet().abilities.map((a: any) => a.ready)).toEqual([true, false, true]);
    });

    it('restore by name, and all: true readies every spent ability; all with nothing spent is refused', async () => {
        await char({ action: 'spend_ability', characterId: 'vex', name: 'Action Surge' });
        await char({ action: 'spend_ability', characterId: 'vex', name: 'Second Wind' });
        const one = await char({ action: 'restore_ability', characterId: 'vex', name: 'second wind' });
        expect(one).toMatchObject({ success: true, actionType: 'restore_ability', restored: ['Second Wind'], ready: true, bookkeeping: true });
        expect(sheet().abilities.map((a: any) => a.ready)).toEqual([false, true, true]);
        await char({ action: 'spend_ability', characterId: 'vex', name: 'Fire Breath' });
        const all = await char({ action: 'restore_ability', characterId: 'vex', all: true });
        expect(all).toMatchObject({ success: true, restored: ['Action Surge', 'Fire Breath'] });
        expect(sheet().abilities.every((a: any) => a.ready === true)).toBe(true);
        const nothing = await char({ action: 'ready_ability', characterId: 'vex', all: true });
        expect(nothing).toMatchObject({ error: true, writes: 'none' });
        expect(nothing.message).toMatch(/no spent ability/);
    });

    it('reaches the live token by name: the stored token flips, token-only abilities are untouched, a token without it is listed', async () => {
        const live = json(await handleCombatManage({ action: 'create', seed: 'abilities-live', participants: [
            { id: 'vex', name: 'Vex', hp: 30, maxHp: 30, initiative: 20, abilities: [{ name: 'Action Surge', grantsAction: true }, { name: 'Shove' }] },
            { id: 'x', name: 'X', hp: 10, maxHp: 10, initiative: 1, isEnemy: true }
        ] }, ctx as any)).encounterId as string;
        const other = json(await handleCombatManage({ action: 'create', seed: 'abilities-other', participants: [
            { id: 'vex', name: 'Vex', hp: 30, maxHp: 30, initiative: 20, abilities: [{ name: 'Shove' }] },
            { id: 'y', name: 'Y', hp: 10, maxHp: 10, initiative: 1, isEnemy: true }
        ] }, ctx as any)).encounterId as string;
        const r = await char({ action: 'spend_ability', characterId: 'vex', name: 'Action Surge' });
        expect(r.liveTokens).toEqual([live]);
        expect(r.tokensWithoutAbility).toEqual([other]);
        expect(r.message).toMatch(/1 live token\(s\) updated/);
        expect(storedToken(live, 'vex').abilities).toEqual([{ name: 'Action Surge', grantsAction: true, ready: false }, { name: 'Shove', ready: true }]);
        expect(storedToken(other, 'vex').abilities).toEqual([{ name: 'Shove', ready: true }]);
        // The engine held in memory sees it too, and a fresh load agrees.
        expect((getOrLoadEngine(ctx as any, live)!.getState()!.participants.find(p => p.id === 'vex')!.abilities ?? [])[0].ready).toBe(false);
        clearCombatState();
        expect((getOrLoadEngine(ctx as any, live)!.getState()!.participants.find(p => p.id === 'vex')!.abilities ?? [])[0].ready).toBe(false);
        const back = await char({ action: 'restore_ability', characterId: 'vex', name: 'Action Surge' });
        expect(back.liveTokens).toEqual([live]);
        expect(storedToken(live, 'vex').abilities[0].ready).toBe(true);
    });

    it('a use_ability spend of a grantsAction ability reaches the sheet, and restore_ability readies the token again', async () => {
        const enc = json(await handleCombatManage({ action: 'create', seed: 'abilities-surge', participants: [
            { id: 'vex', name: 'Vex', hp: 30, maxHp: 30, initiative: 20 },
            { id: 'x', name: 'X', hp: 10, maxHp: 10, initiative: 1, isEnemy: true }
        ] }, ctx as any)).encounterId as string;
        const used = json(await handleCombatManage({ action: 'use_ability', encounterId: enc, participantId: 'vex', ability: 'Action Surge' }, ctx as any));
        expect(used).toMatchObject({ success: true, grantsAction: true, mirroredToCharacter: true });
        expect(sheet().abilities[0].ready).toBe(false);
        expect(storedToken(enc, 'vex').abilities[0].ready).toBe(false);
        const r = await char({ action: 'restore_ability', characterId: 'vex', name: 'Action Surge' });
        expect(r).toMatchObject({ success: true, restored: ['Action Surge'], liveTokens: [enc] });
        expect(storedToken(enc, 'vex').abilities[0].ready).toBe(true);
        expect(sheet().abilities[0].ready).toBe(true);
    });
});
