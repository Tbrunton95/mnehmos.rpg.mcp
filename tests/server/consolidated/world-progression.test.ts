import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { handleMathManage } from '../../../src/server/consolidated/math-manage.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { parseRuleSpec } from '../../../src/engine/table-rules.js';
import { worldProgression } from '../../../src/engine/progression.js';
import { saveModifier, saveSourceFor } from '../../../src/engine/combat/saves.js';
import { calculateSpellSaveDC, calculateSpellAttackBonus } from '../../../src/engine/magic/spell-validator.js';

/**
 * Item 10: a world sets its own progression (table_rules progression):
 * maxLevel (null = no cap), xpThresholds, a proficiency curve, and mode
 * 'none'. Without a rule the SRD holds: XP, level 20, the 2 + (L-1)/4 curve.
 */
const W = 'ascension';
const ctx = { sessionId: 'world-progression' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const raw = async (a: Record<string, unknown>) => {
    try { return (await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any)).content[0].text as string; }
    catch (e) { return (e as Error).message; }
};
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const rule = (spec: Record<string, unknown>) => handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, action: 'define', kind: 'progression', name: 'Ascension', spec }), ctx as any);
const stats = { str: 10, dex: 10, con: 10, int: 16, wis: 14, cha: 10 };

describe('progression kind', () => {
    it('takes maxLevel (null = uncapped), xpThresholds, profBonus and mode none', () => {
        expect(parseRuleSpec('progression', {})).toMatchObject({ mode: 'milestone' });
        expect(parseRuleSpec('progression', { mode: 'none', maxLevel: null })).toMatchObject({ mode: 'none', maxLevel: null });
        expect(parseRuleSpec('progression', { xpThresholds: [0, 100], profBonus: [3] })).toMatchObject({ xpThresholds: [0, 100], profBonus: [3] });
        expect(() => parseRuleSpec('progression', { xpThresholds: [0] })).toThrow();
        expect(() => parseRuleSpec('progression', { maxLevel: 0 })).toThrow();
        expect(() => parseRuleSpec('progression', { profBonus: [] })).toThrow();
    });
});

describe('worldProgression', () => {
    beforeEach(() => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Ascension', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    });
    afterEach(() => closeDb());

    it('without a rule is the SRD: xp, level 20, the standard table and curve', () => {
        const p = worldProgression(getDb(), W);
        expect(p).toMatchObject({ mode: 'xp', maxLevel: 20 });
        expect(p.xpFor(2)).toBe(300);
        expect(p.xpFor(20)).toBe(355000);
        expect(p.profBonus(1)).toBe(2);
        expect(p.profBonus(5)).toBe(3);
        expect(p.profBonus(17)).toBe(6);
        expect(worldProgression(getDb(), null).maxLevel).toBe(20);
    });

    it('reads the rule; the last XP step and the last curve value repeat past the end', async () => {
        await rule({ mode: 'xp', maxLevel: null, xpThresholds: [0, 100, 300], profBonus: [2, 2, 3] });
        const p = worldProgression(getDb(), W);
        expect(p).toMatchObject({ mode: 'xp', maxLevel: null, rule: 'Ascension' });
        expect(p.xpFor(1)).toBe(0);
        expect(p.xpFor(3)).toBe(300);
        expect(p.xpFor(5)).toBe(700);
        expect(p.profBonus(2)).toBe(2);
        expect(p.profBonus(30)).toBe(3);
    });

    it('an uncapped world without thresholds extends the SRD table by its last step', async () => {
        await rule({ mode: 'xp', maxLevel: null });
        expect(worldProgression(getDb(), W).xpFor(21)).toBe(405000);
    });
});

describe('levels past 20', () => {
    beforeEach(() => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Ascension', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    });
    afterEach(() => closeDb());

    it('are refused by default, naming the progression rule, and nothing is written', async () => {
        expect(await raw({ action: 'create', name: 'Too Powerful', level: 21, worldId: W, provisionEquipment: false })).toMatch(/level 21.*max.*20.*progression/i);
        expect(await raw({ action: 'create', name: 'Too Powerful', level: 21, provisionEquipment: false })).toMatch(/max.*20/i);
        expect(new CharacterRepository(getDb()).findAll().length).toBe(0);
    });

    it('a world with maxLevel null allows them; a level 25 wizard keeps level 20 slots', async () => {
        await rule({ mode: 'xp', maxLevel: null });
        const c = await char({ action: 'create', name: 'Archmage', class: 'Wizard', level: 25, worldId: W, stats });
        expect(c.level).toBe(25);
        expect(c.spellSlots.level9).toEqual({ current: 1, max: 1 });
        const up = await char({ action: 'level_up', characterId: c.id });
        expect(up.newLevel).toBe(26);
        expect(up.spellSlots.level9).toEqual({ current: 1, max: 1 });
        const upd = await char({ action: 'update', characterId: c.id, level: 30 });
        expect(upd.level).toBe(30);
    });

    it('a world maxLevel caps create, update and level_up', async () => {
        await rule({ mode: 'milestone', maxLevel: 5 });
        expect(await raw({ action: 'create', name: 'Hero', level: 6, worldId: W, provisionEquipment: false })).toMatch(/level 6.*max.*5.*Ascension/i);
        const c = await char({ action: 'create', name: 'Hero', level: 5, worldId: W, provisionEquipment: false });
        expect(await raw({ action: 'update', characterId: c.id, level: 6 })).toMatch(/max.*5.*Ascension/i);
        expect(await raw({ action: 'level_up', characterId: c.id })).toMatch(/max.*5.*Ascension/i);
        expect(new CharacterRepository(getDb()).findById(c.id)!.level).toBe(5);
    });
});

describe('xp and the proficiency curve', () => {
    beforeEach(() => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Ascension', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    });
    afterEach(() => closeDb());

    it('add_xp and get_progression read the world thresholds', async () => {
        await rule({ mode: 'xp', xpThresholds: [0, 100, 300] });
        const c = await char({ action: 'create', name: 'Aspirant', level: 1, worldId: W, provisionEquipment: false });
        const x = await char({ action: 'add_xp', characterId: c.id, amount: 100 });
        expect(x).toMatchObject({ canLevelUp: true, nextLevelXp: 100 });
        const p = await char({ action: 'get_progression', characterId: c.id });
        expect(p).toMatchObject({ xpForNextLevel: 100, readyToLevel: true });
    });

    it("mode none never offers a level from XP", async () => {
        await rule({ mode: 'none' });
        const c = await char({ action: 'create', name: 'Mortal', level: 1, worldId: W, provisionEquipment: false });
        const x = await char({ action: 'add_xp', characterId: c.id, amount: 100000 });
        expect(x).toMatchObject({ canLevelUp: false, progression: 'none' });
        const p = await char({ action: 'get_progression', characterId: c.id });
        expect(p).toMatchObject({ readyToLevel: false, progression: 'none' });
    });

    it('get_progression table mode goes past 20 in an uncapped world', async () => {
        const capped = await char({ action: 'get_progression', level: 20 });
        expect(capped.maxLevel).toBe(true);
        await rule({ mode: 'xp', maxLevel: null });
        const t = await char({ action: 'get_progression', level: 21, worldId: W });
        expect(t).toMatchObject({ level: 21, xpRequiredForLevel: 405000, xpForNextLevel: 455000 });
    });

    it('skill checks, saves and spell DCs use the world curve', async () => {
        await rule({ mode: 'milestone', profBonus: [5] });
        const c = await char({
            action: 'create', name: 'Chosen', class: 'Wizard', level: 1, worldId: W, stats, provisionEquipment: false,
            skillProficiencies: ['arcana'], saveProficiencies: ['int']
        });
        const skill = json(await handleMathManage({ action: 'roll_skill_check', characterId: c.id, skill: 'arcana' }, ctx as any));
        expect(skill.breakdown).toEqual(expect.arrayContaining(['proficiency +5']));
        const save = json(await handleMathManage({ action: 'roll_saving_throw', characterId: c.id, ability: 'int' }, ctx as any));
        expect(save.breakdown).toEqual(expect.arrayContaining(['save proficiency +5']));
        const token = { id: c.id, name: 'Chosen', hp: 10, maxHp: 10, initiative: 0, isEnemy: false, conditions: [] } as any;
        expect(saveModifier(saveSourceFor(getDb(), token), 'int').prof).toBe(5);
        const row = new CharacterRepository(getDb()).findById(c.id)!;
        expect(calculateSpellSaveDC(row, 5)).toBe(8 + 5 + 3);
        expect(calculateSpellAttackBonus(row, 5)).toBe(5 + 3);
        expect(calculateSpellSaveDC(row)).toBe(8 + 2 + 3);
    });
});
