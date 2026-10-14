import { handleMathManage, MathManageTool } from '../../../src/server/consolidated/math-manage.js';
import { handleImprovisationManage, ImprovisationManageTool } from '../../../src/server/consolidated/improvisation-manage.js';
import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { withOperation } from '../../../src/server/operation-guard.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../../src/storage/repos/custom-effects.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

/**
 * Play report 7 #11: roll_skill_check {skill: 'sleight-of-hand'} rolled WIS.
 * The key folded spaces only, missed the SRD map and fell back to 'wis' with
 * no word. Every spelling of an SRD skill now rolls its ability; a skill that
 * is neither SRD nor a world skill, with no ability given, rolls with no
 * ability and no proficiency and says so loudly (the montage's rule).
 */
const ctx = { sessionId: 'skill-names' } as any;
const W = 'skill-world';
const text = (res: any) => res.content[0].text as string;
const json = (res: any) => { const m = text(res).match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(text(res)); };
const mathRaw = withOperation('math_manage', (a: any) => handleMathManage(MathManageTool.inputSchema.parse(a), ctx));
const math = async (a: Record<string, unknown>) => json(await mathRaw(a));
const improv = async (a: Record<string, unknown>) => json(await handleImprovisationManage(ImprovisationManageTool.inputSchema.parse(a), ctx));
const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx));

function mkChar(id: string, name: string, over: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    new CharacterRepository(getDb()).create({
        id, name, characterType: 'pc', level: 1, hp: 10, maxHp: 10, ac: 12, speed: 30,
        stats: { str: 10, dex: 14, con: 10, int: 10, wis: 16, cha: 10 },
        skillProficiencies: ['Sleight of Hand'], expertise: [], conditions: [], createdAt: now, updatedAt: now, ...over
    } as any);
    getDb().prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(W, id);
}

function effect(targetId: string, name: string, mechanics: unknown[]) {
    new CustomEffectsRepository(getDb()).apply({
        target_id: targetId, target_type: 'character', name, description: name,
        category: 'neutral', power_level: 1, source: { type: 'unknown' },
        mechanics: mechanics as never, duration: { type: 'until_removed' as never },
        triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
    } as never);
}

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Skill World', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    // Nim: DEX 14 (+2), WIS 16 (+3), proficient in Sleight of Hand at level 1 (+2).
    mkChar('nim', 'Nim');
    mkChar('watcher', 'Watcher', { skillProficiencies: [] });
});
afterEach(() => closeDb());

describe('roll_skill_check reads every spelling of an SRD skill (play report 7 #11)', () => {
    it("'sleight-of-hand' rolls DEX plus proficiency, with no warning", async () => {
        for (const skill of ['sleight-of-hand', 'SleightOfHand', 'Sleight of Hand', 'sleight_of_hand']) {
            const r = await math({ action: 'roll_skill_check', characterId: 'nim', skill });
            expect(r.success).toBe(true);
            expect(r.bonus).toBe(4);
            expect(r.breakdown).toEqual(expect.arrayContaining(['DEX +2', 'proficiency +2']));
            expect(r.breakdown.join(' ')).not.toMatch(/WIS/);
            expect(r.skillAbility).toBe('dex');
            expect(r.skillAbilitySource).toBe('srd');
            expect(r.resolverProblems).toBeUndefined();
        }
    });

    it('a given ability wins and says so; a world skill reads its own ability', async () => {
        const given = await math({ action: 'roll_skill_check', characterId: 'nim', skill: 'sleight-of-hand', ability: 'wis' });
        expect(given.skillAbility).toBe('wis');
        expect(given.skillAbilitySource).toBe('given');
        expect(given.bonus).toBe(5);
        await rules({ action: 'define', kind: 'skill', name: 'Pick Pocket', spec: { ability: 'dex' } });
        const world = await math({ action: 'roll_skill_check', characterId: 'nim', skill: 'pick-pocket' });
        expect(world.skillAbility).toBe('dex');
        expect(world.skillAbilitySource).toBe('world');
        expect(world.breakdown).toContain('DEX +2');
    });

    it('a skill that names no ability rolls with no ability and no proficiency, loudly', async () => {
        new CharacterRepository(getDb()).update('nim', { skillProficiencies: ['Haggling'] } as never);
        const res = await mathRaw({ action: 'roll_skill_check', characterId: 'nim', skill: 'haggling' });
        const r = json(res);
        expect(r.success).toBe(true);
        expect(r.bonus).toBe(0);
        expect(r.total).toBe(r.natural);
        expect(r.skillAbility).toBeNull();
        expect(r.skillAbilitySource).toBe('none');
        expect(r.resolverProblems.join(' ')).toMatch(/skill 'haggling' names no ability/);
        expect(r.breakdown.join(' ')).toMatch(/⚠ skill 'haggling' names no ability/);
        expect(r.breakdown.join(' ')).not.toMatch(/\b(STR|DEX|CON|INT|WIS|CHA) [+-]/);
        expect(r.breakdown.join(' ')).not.toMatch(/proficiency \+/);
        expect(text(res)).toContain('RESOLVER:');
    });

    it("an autoApply skill_bonus scoped 'sleight_of_hand' applies to 'sleight-of-hand'", async () => {
        effect('nim', 'Light Fingers', [{ type: 'skill_bonus', value: 1, skill: 'sleight_of_hand', autoApply: true }]);
        const r = await math({ action: 'roll_skill_check', characterId: 'nim', skill: 'sleight-of-hand' });
        expect(r.bonus).toBe(5);
        expect(r.autoApplied).toEqual([expect.objectContaining({ effect: 'Light Fingers', value: 1 })]);
    });

    it('an older-form mechanic scoped to any spelling of a skill fits a roll in any spelling (review: the canonical key must not narrow it)', async () => {
        effect('nim', 'Quick Hands', [{ type: 'skill_bonus', value: 1, skill: 'sleight-of-hand', autoApply: true }]);
        effect('nim', 'Pickpocket Lore', [{ type: 'advantage_on', value: 1, skill: 'Sleight of Hand', autoApply: true }]);
        effect('nim', 'Beast Friend', [{ type: 'advantage_on', value: 1, skill: 'Animal Handling' }]);
        for (const skill of ['sleight-of-hand', 'Sleight of Hand', 'sleight_of_hand']) {
            const r = await math({ action: 'roll_skill_check', characterId: 'nim', skill, seed: 'hands' });
            expect(r.autoApplied).toEqual([expect.objectContaining({ effect: 'Quick Hands', value: 1 })]);
            expect(r.bonus).toBe(5);
            expect(r.advantageSources).toEqual(['Pickpocket Lore']);
        }
        // Named, the older form grants when its skill fits the roll — in any spelling.
        const beast = await math({ action: 'roll_skill_check', characterId: 'nim', skill: 'animal_handling', advantageSources: ['Beast Friend'], seed: 'beast' });
        expect(beast.error).toBeFalsy();
        expect(beast.advantageSources).toEqual(['Beast Friend']);
        const stunt = await improv({ action: 'stunt', actorId: 'nim', skill: 'Sleight of Hand', dc: 10 });
        expect(stunt.modifier).toBe(5);
    });

    it("opposed {skill: 'sleight-of-hand'} rolls DEX for the initiator", async () => {
        const r = await math({ action: 'opposed', characterId: 'nim', skill: 'sleight-of-hand', targetId: 'watcher', targetSkill: 'perception' });
        expect(r.success).toBe(true);
        expect(r.initiator.skillAbility).toBe('dex');
        expect(r.initiator.breakdown).toEqual(expect.arrayContaining(['DEX +2', 'proficiency +2']));
        expect(r.defender.skillAbility).toBe('wis');
    });

    it("a stunt on 'sleightofhand' maps to DEX; the montage on 'Sleight-Of-Hand' too", async () => {
        const s = await improv({ action: 'stunt', actorId: 'nim', skill: 'sleightofhand', dc: 10 });
        expect(s.modifier).toBe(4);
        const m = await improv({ action: 'montage', characterId: 'nim', task: 'lifting purses', dc: 12, skill: 'Sleight-Of-Hand', seed: 'skill-names', journal: false });
        expect(m).toMatchObject({ abilityModifier: 2, proficiency: 2, skillModifier: 4 });
        expect(m.warnings).toBeUndefined();
    });
});
