import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCharacterManage } from '../../src/server/consolidated/character-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const ctx = { sessionId: 'bands' };
const json = (res: any, tag: string) => JSON.parse(res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`))![1]);

describe('band and regeneration travel from sheet to token', () => {
    let repo: CharacterRepository;
    beforeEach(() => {
        closeDb();
        repo = new CharacterRepository(getDb(':memory:'));
        clearCombatState();
        const now = new Date().toISOString();
        repo.create({ id: 'luciel', name: 'Luciel', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 }, hp: 200, maxHp: 200, ac: 20, level: 15, band: 'Astartes', createdAt: now, updatedAt: now } as any);
        repo.create({ id: 'beast', name: 'Beast', stats: { str: 24, dex: 10, con: 24, int: 3, wis: 10, cha: 3 }, hp: 300, maxHp: 300, ac: 16, level: 12, band: 'Monster/Lord', regeneration: 10, createdAt: now, updatedAt: now } as any);
    });
    afterEach(() => closeDb());

    it('the character row stores band and regeneration', () => {
        expect(repo.findById('luciel')!.band).toBe('Astartes');
        expect(repo.findById('beast')!.regeneration).toBe(10);
    });

    it('character_manage update sets them', async () => {
        await handleCharacterManage({ action: 'update', characterId: 'luciel', band: 'Astartes Elite', regeneration: 2 }, ctx as any);
        expect(repo.findById('luciel')).toMatchObject({ band: 'Astartes Elite', regeneration: 2 });
    });

    it('combat create defaults tokens from the rows and keeps them through save and load', async () => {
        const created = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 20 },
            { id: 'beast', name: 'Beast', hp: 300, maxHp: 300, initiative: 5, isEnemy: true },
            { id: 'scion', name: 'Scion', hp: 12, maxHp: 12, initiative: 3, isEnemy: true, band: 'Elite Mortal' }
        ] }, ctx as any), 'COMBAT_MANAGE');
        const tokens = new EncounterRepository(getDb()).loadState(created.encounterId)!.participants as any[];
        const by = (id: string) => tokens.find(t => t.id === id);
        expect(by('luciel').band).toBe('Astartes');
        expect(by('beast')).toMatchObject({ band: 'Monster/Lord', regeneration: 10 });
        expect(by('scion').band).toBe('Elite Mortal');
    });

    it('add_participant defaults from the row', async () => {
        const created = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 20 }
        ] }, ctx as any), 'COMBAT_MANAGE');
        await handleCombatManage({ action: 'add_participant', encounterId: created.encounterId, characterId: 'beast', isEnemy: true }, ctx as any);
        const tokens = new EncounterRepository(getDb()).loadState(created.encounterId)!.participants as any[];
        expect(tokens.find(t => t.id === 'beast')).toMatchObject({ band: 'Monster/Lord', regeneration: 10 });
    });
});

describe('the combat profile travels from sheet to token', () => {
    beforeEach(() => {
        closeDb();
        const repo = new CharacterRepository(getDb(':memory:'));
        clearCombatState();
        const now = new Date().toISOString();
        repo.create({
            id: 'hydra', name: 'Hydra', stats: { str: 20, dex: 12, con: 20, int: 2, wis: 10, cha: 7 }, hp: 172, maxHp: 172, ac: 15, level: 8,
            size: 'huge', reach: 10, attacksPerAction: 3, cr: 8, autoLegendaryResistance: true,
            attacks: [{ name: 'bite', attackBonus: 8, damage: '1d10+5', damageType: 'piercing', part: 'middle head' }],
            abilities: [{ name: 'Roar', recharge: 5 }],
            legendaryActions: 3, legendaryResistances: 2, hasLairActions: true,
            createdAt: now, updatedAt: now
        } as any);
    });
    afterEach(() => closeDb());

    const expectProfile = (token: any) => {
        expect(token).toMatchObject({ size: 'huge', reach: 10, attacksPerAction: 3, cr: 8, autoLegendaryResistance: true, legendaryActions: 3, legendaryResistances: 2, hasLairActions: true });
        expect(token.attacks[0]).toMatchObject({ name: 'bite', part: 'middle head' });
        expect(token.abilities[0]).toMatchObject({ name: 'Roar', recharge: 5 });
    };

    it('combat create reads it from the row', async () => {
        const created = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'hydra', name: 'Hydra', hp: 172, maxHp: 172, initiative: 10, isEnemy: true },
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 12 }
        ] }, ctx as any), 'COMBAT_MANAGE');
        const tokens = new EncounterRepository(getDb()).loadState(created.encounterId)!.participants as any[];
        expectProfile(tokens.find(t => t.id === 'hydra'));
    });

    it('add_participant reads it from the row; the caller still wins', async () => {
        const created = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 12 }
        ] }, ctx as any), 'COMBAT_MANAGE');
        await handleCombatManage({ action: 'add_participant', encounterId: created.encounterId, characterId: 'hydra', isEnemy: true }, ctx as any);
        let tokens = new EncounterRepository(getDb()).loadState(created.encounterId)!.participants as any[];
        expectProfile(tokens.find(t => t.id === 'hydra'));

        const again = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'hydra', name: 'Hydra', hp: 172, maxHp: 172, initiative: 10, isEnemy: true, size: 'gargantuan' }
        ] }, ctx as any), 'COMBAT_MANAGE');
        tokens = new EncounterRepository(getDb()).loadState(again.encounterId)!.participants as any[];
        expect(tokens.find(t => t.id === 'hydra').size).toBe('gargantuan');
    });
});
