/**
 * Item 13: 5e encounter budgeting (DMG XP thresholds and the group
 * multiplier). Advisory only: it reports, never blocks.
 */
import { budgetEncounter, xpForCr, encounterMultiplier, partyThresholds } from '../../src/engine/encounter-budget.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

describe('encounter budget module', () => {
    it('XP by CR, fractions included, CR 30 at the top', () => {
        expect(xpForCr(0)).toBe(10);
        expect(xpForCr(0.125)).toBe(25);
        expect(xpForCr(0.25)).toBe(50);
        expect(xpForCr(0.5)).toBe(100);
        expect(xpForCr(1)).toBe(200);
        expect(xpForCr(5)).toBe(1800);
        expect(xpForCr(20)).toBe(25000);
        expect(xpForCr(30)).toBe(155000);
        expect(xpForCr(40)).toBe(155000);
    });

    it('party thresholds sum per character', () => {
        expect(partyThresholds([1, 1, 1, 1])).toEqual({ easy: 100, medium: 200, hard: 300, deadly: 400 });
        expect(partyThresholds([5])).toEqual({ easy: 250, medium: 500, hard: 750, deadly: 1100 });
        expect(partyThresholds([25])).toEqual(partyThresholds([20]));
    });

    it('the multiplier ladder by monster count, shifted for small and large parties', () => {
        expect(encounterMultiplier(1, 4)).toBe(1);
        expect(encounterMultiplier(2, 4)).toBe(1.5);
        expect(encounterMultiplier(3, 4)).toBe(2);
        expect(encounterMultiplier(6, 4)).toBe(2);
        expect(encounterMultiplier(7, 4)).toBe(2.5);
        expect(encounterMultiplier(11, 4)).toBe(3);
        expect(encounterMultiplier(15, 4)).toBe(4);
        // Fewer than three characters: one step up. Six or more: one step down.
        expect(encounterMultiplier(1, 2)).toBe(1.5);
        expect(encounterMultiplier(15, 1)).toBe(5);
        expect(encounterMultiplier(1, 6)).toBe(0.5);
        expect(encounterMultiplier(3, 6)).toBe(1.5);
    });

    it('rates the DMG example: four level-3 characters against a CR 3 and two CR 1s', () => {
        const r = budgetEncounter({ partyLevels: [3, 3, 3, 3], monsters: [{ cr: 3 }, { cr: 1, count: 2 }] });
        expect(r.rawXp).toBe(1100);
        expect(r.monsterCount).toBe(3);
        expect(r.multiplier).toBe(2);
        expect(r.adjustedXp).toBe(2200);
        expect(r.thresholds).toEqual({ easy: 300, medium: 600, hard: 900, deadly: 1600 });
        expect(r.difficulty).toBe('deadly');
    });

    it('trivial below easy; explicit xp beats cr; unrated monsters are named', () => {
        expect(budgetEncounter({ partyLevels: [10, 10, 10, 10], monsters: [{ cr: 0.25 }] }).difficulty).toBe('trivial');
        expect(budgetEncounter({ partyLevels: [1], monsters: [{ cr: 5, xp: 10 }] }).rawXp).toBe(10);
        const r = budgetEncounter({ partyLevels: [3], monsters: [{ name: 'Mystery' }, { cr: 1 }] });
        expect(r.unrated).toEqual(['Mystery']);
        expect(r.rawXp).toBe(200);
    });
});

describe('combat_manage budget', () => {
    const ctx = { sessionId: 'budget' };
    const tag = (text: string) => JSON.parse(text.match(/<!-- COMBAT_MANAGE_JSON\n([\s\S]*?)\nCOMBAT_MANAGE_JSON -->/)![1]);
    const manage = async (args: Record<string, unknown>) => tag((await handleCombatManage(args, ctx as any)).content[0].text);
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => closeDb());

    it('rates creatures by name against given levels, read-only', async () => {
        const r = await manage({ action: 'budget', partyLevels: [1, 1, 1, 1], creatures: [{ creature: 'goblin', count: 4 }] });
        expect(r.error).toBeFalsy();
        expect(r.rawXp).toBe(200);
        expect(r.multiplier).toBe(2);
        expect(r.adjustedXp).toBe(400);
        expect(r.difficulty).toBe('deadly');
        expect(r.writes).toBe('none');
    });

    it('rates a live encounter from its tokens and the allies\' sheet levels', async () => {
        const now = new Date().toISOString();
        new CharacterRepository(getDb()).create({ id: 'hero', name: 'Hero', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 40, maxHp: 40, ac: 16, level: 5, createdAt: now, updatedAt: now } as any);
        const created = await manage({ action: 'create', participants: [
            { id: 'hero', name: 'Hero', hp: 40, maxHp: 40 },
            { id: 'ogre', name: 'Brute', hp: 59, maxHp: 59, ac: 11, cr: 2, isEnemy: true }
        ] });
        expect(created.threat).toMatch(/⚔️ THREAT:/);
        // One monster against a party under three: x1.5.
        expect(created.threat).toMatch(/675 XP adjusted: MEDIUM for L5/);
        const r = await manage({ action: 'budget', encounterId: created.encounterId });
        expect(r).toMatchObject({ rawXp: 450, adjustedXp: 675, difficulty: 'medium', partyLevels: [5] });
    });

    it('refuses without any levels', async () => {
        const r = await manage({ action: 'budget', creatures: [{ creature: 'goblin' }] });
        expect(r.error).toBe(true);
        expect(r.message).toMatch(/partyLevels/);
    });
});
