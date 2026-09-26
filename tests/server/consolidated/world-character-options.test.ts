import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { handleMathManage } from '../../../src/server/consolidated/math-manage.js';
import { handleImprovisationManage, ImprovisationManageTool } from '../../../src/server/consolidated/improvisation-manage.js';
import { handleRestManage } from '../../../src/server/consolidated/rest-manage.js';
import { handleExecuteCombatAction, handleCreateEncounter, clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../../src/server/operation-guard.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { parseRuleSpec, DATA_KINDS, worldSkillAbility, worldClassCasting } from '../../../src/engine/table-rules.js';

/**
 * Item 8: a world defines its own skills, species, classes and backgrounds
 * as table rules. Character create reads the world's entry first and the SRD
 * second; skill rolls and stunts read a world skill's ability; a class can
 * cast SRD spells as an SRD caster (casting.as).
 */
const W = 'mortal-realms';
const OTHER = 'zone';
const ctx = { sessionId: 'world-options' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx as any));
const math = async (a: Record<string, unknown>) => json(await handleMathManage(a, ctx as any));
const improv = async (a: Record<string, unknown>) => json(await handleImprovisationManage(ImprovisationManageTool.inputSchema.parse(a), ctx as any));
const act = withOperation('combat_action', (a) => handleExecuteCombatAction(a, ctx as any));

describe('world character option kinds', () => {
    it('are data kinds; skill ability takes long or short names', () => {
        for (const k of ['skill', 'species', 'char_class', 'background']) expect(DATA_KINDS.has(k)).toBe(true);
        expect(parseRuleSpec('skill', { ability: 'Strength' })).toMatchObject({ ability: 'str' });
        expect(parseRuleSpec('skill', { ability: 'WIS' })).toMatchObject({ ability: 'wis' });
        expect(() => parseRuleSpec('skill', { ability: 'luck' })).toThrow();
        expect(parseRuleSpec('char_class', {})).toMatchObject({ hitDie: 8, saves: [], skills: [] });
        expect(parseRuleSpec('char_class', { saves: ['Constitution'] })).toMatchObject({ saves: ['con'] });
        expect(parseRuleSpec('species', { abilityBonuses: { strength: 2 } })).toMatchObject({ abilityBonuses: { str: 2 }, languages: [], traits: [] });
        expect(parseRuleSpec('background', {})).toMatchObject({ skills: [], languages: [], tools: [] });
    });
});

describe('world characters', () => {
    beforeEach(async () => {
        closeDb();
        clearCombatState();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        const worlds = new WorldRepository(db);
        worlds.create({ id: W, name: 'Mortal Realms', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        worlds.create({ id: OTHER, name: 'Zone', seed: 'z', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        await rules({ action: 'define', kind: 'skill', name: 'Waaagh Lore', spec: { ability: 'strength', description: 'Knowing the green tide' } });
        await rules({ action: 'define', kind: 'skill', name: 'Scrounging', spec: { ability: 'wis' } });
        await rules({ action: 'define', kind: 'species', name: 'Orruk', spec: { size: 'large', speed: 30, abilityBonuses: { str: 2, con: 1 }, languages: ['Orruk'], traits: ['Tough as Old Boots'], hpPerLevel: 1 } });
        await rules({ action: 'define', kind: 'char_class', name: 'Brute', spec: { hitDie: 12, saves: ['str', 'con'], skills: ['Waaagh Lore'], armor: ['heavy'], weapons: ['choppas'] } });
        await rules({ action: 'define', kind: 'char_class', name: 'Weirdnob', spec: { hitDie: 8, saves: ['wis'], casting: { as: 'wizard' } } });
        await rules({ action: 'define', kind: 'background', name: 'Scrap Scavenger', spec: { skills: ['Scrounging'], languages: ['Grot'], tools: ['junk kit'], gold: 7 } });
    });
    afterEach(() => { closeDb(); clearCombatState(); });

    it('create reads the world class, species and background', async () => {
        const c = await char({
            action: 'create', worldId: W, name: 'Gorbad', class: 'brute', race: 'orruk', background: 'scrap scavenger',
            stats: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 8 }, provisionEquipment: false
        });
        expect(c.characterClass).toBe('Brute');
        expect(c.race).toBe('Orruk');
        expect(c.background).toBe('Scrap Scavenger');
        expect(c.stats).toMatchObject({ str: 18, con: 15 });
        // d12 + CON +2 at level 1, plus the species' 1 per level
        expect(c.maxHp).toBe(12 + 2 + 1);
        expect(c.saveProficiencies).toEqual(['str', 'con']);
        expect(c.skillProficiencies).toEqual(expect.arrayContaining(['Waaagh Lore', 'Scrounging']));
        expect(c.languages).toEqual(expect.arrayContaining(['Orruk', 'Grot']));
        expect(c.toolProficiencies).toEqual(['junk kit']);
        expect(c.armorProficiencies).toEqual(['heavy']);
        expect(c.weaponProficiencies).toEqual(['choppas']);
        expect(c.size).toBe('large');
        expect(c._rules.class).toMatchObject({ world: true, name: 'Brute', hitDie: 12 });
        expect(c._rules.species).toMatchObject({ world: true, name: 'Orruk', speed: 30, traits: ['Tough as Old Boots'] });
        expect(c._rules.background).toMatchObject({ world: true, name: 'Scrap Scavenger' });
        const row = new CharacterRepository(getDb()).findById(c.id)!;
        expect((row as any).currency.gold).toBe(7);
    });

    it('falls back to the SRD for names the world does not define, and other worlds do not see the rules', async () => {
        const wiz = await char({ action: 'create', worldId: W, name: 'Merl', class: 'Wizard', race: 'Human', provisionEquipment: false, stats: { str: 10, dex: 10, con: 10, int: 16, wis: 10, cha: 10 } });
        expect(wiz._rules.class.hitDie).toBe(6);
        const zoner = await char({ action: 'create', worldId: OTHER, name: 'Strelok', class: 'Brute', race: 'Orruk', provisionEquipment: false });
        expect(zoner._rules.class).toMatchObject({ custom: true });
        expect(zoner.maxHp).toBe(8);
    });

    it('level_up reads the world hit die and species bonus', async () => {
        const c = await char({ action: 'create', worldId: W, name: 'Gorbad', class: 'Brute', race: 'Orruk', provisionEquipment: false, stats: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 8 } });
        const up = await char({ action: 'level_up', characterId: c.id });
        // d12 average 7 + CON +2 + species 1
        expect(up.hpIncrease).toBe(10);
        expect(up.hpProvenance).toMatchObject({ hitDie: 12, speciesMaxHpPerLevel: 1 });
    });

    it('skill rolls and stunts read a world skill; an unknown stunt skill needs an ability', async () => {
        const c = await char({ action: 'create', worldId: W, name: 'Gorbad', class: 'Brute', race: 'Orruk', provisionEquipment: false, stats: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 8 } });
        expect(worldSkillAbility(getDb(), W, 'waaagh_lore')).toBe('str');
        expect(worldSkillAbility(getDb(), OTHER, 'Waaagh Lore')).toBeUndefined();
        const r = await math({ action: 'roll_skill_check', characterId: c.id, skill: 'Waaagh Lore' });
        expect(r.breakdown).toEqual(expect.arrayContaining(['STR +4', 'proficiency +2']));
        const s = await improv({ action: 'stunt', actorId: c.id, skill: 'Waaagh Lore', dc: 10 });
        expect(s.modifier).toBe(6);
        const refused = await handleImprovisationManage({ action: 'stunt', actorId: c.id, skill: 'basket weaving', dc: 10 }, ctx as any);
        expect(refused.content[0].text).toMatch(/basket weaving.*ability/i);
        const withAbility = await improv({ action: 'stunt', actorId: c.id, skill: 'basket weaving', ability: 'dexterity', dc: 10 });
        expect(withAbility.modifier).toBe(0);
        expect(withAbility.skill).toBe('basket weaving');
    });

    it('options {worldId} lists the world entries', async () => {
        const o = await char({ action: 'options', worldId: W, category: 'classes' });
        expect(o.world.classes.map((c: any) => c.name)).toEqual(['Brute', 'Weirdnob']);
        expect(o.world.species[0]).toMatchObject({ name: 'Orruk', speed: 30 });
        expect(o.world.backgrounds[0]).toMatchObject({ name: 'Scrap Scavenger', gold: 7 });
        expect(o.world.skills.map((s: any) => s.name)).toEqual(['Scrounging', 'Waaagh Lore']);
        const none = await char({ action: 'options', category: 'classes' });
        expect(none.world).toBeUndefined();
    });

    it('a class with casting.as gets that caster\'s slots and casts SRD spells as it', async () => {
        const c = await char({
            action: 'create', worldId: W, name: 'Wurrzag', class: 'Weirdnob', race: 'Orruk', level: 5, provisionEquipment: false,
            stats: { str: 10, dex: 12, con: 12, int: 16, wis: 12, cha: 10 }, knownSpells: ['Fireball'], preparedSpells: ['Fireball']
        });
        expect(worldClassCasting(getDb(), W, 'weirdnob')).toEqual({ as: 'wizard' });
        expect(c.spellSlots.level3).toEqual({ current: 2, max: 2 });
        const created = await handleCreateEncounter({
            seed: 'weirdnob',
            participants: [
                { id: c.id, name: 'Wurrzag', hp: 30, maxHp: 30, initiative: 20 },
                { id: 'stormcast', name: 'Stormcast', hp: 100, maxHp: 100, initiative: 1, isEnemy: true }
            ]
        }, ctx as any);
        const encounterId = created.content[0].text.match(/Encounter ID: (encounter-[^\n]+)/)![1];
        await act({ encounterId, action: 'cast_spell', actorId: c.id, spellName: 'Fireball', targetIds: ['stormcast'] });
        const row = new CharacterRepository(getDb()).findById(c.id)!;
        expect(row.characterClass).toBe('Weirdnob');
        expect((row as any).spellSlots.level3.current).toBe(1);
        clearCombatState();
        await handleRestManage({ action: 'long_rest', characterId: c.id }, ctx as any);
        expect((new CharacterRepository(getDb()).findById(c.id) as any).spellSlots.level3.current).toBe(2);
        expect(new CharacterRepository(getDb()).findById(c.id)!.characterClass).toBe('Weirdnob');
    });
});
