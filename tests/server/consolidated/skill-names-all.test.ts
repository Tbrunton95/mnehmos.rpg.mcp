/**
 * Play report 7 #11, review: every spelling of all 18 SRD skills rolls its
 * ability on each road that takes a skill — roll_skill_check, opposed (both
 * sides), a stunt and the montage — through the one map (SRD_SKILL_ABILITY).
 * The lane's own test pinned Sleight of Hand; this walks the whole list in
 * snake, title, kebab, Pascal, upper-case and loosely spaced spellings.
 */
import { handleMathManage, MathManageTool } from '../../../src/server/consolidated/math-manage.js';
import { handleImprovisationManage, ImprovisationManageTool } from '../../../src/server/consolidated/improvisation-manage.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { SRD_SKILL_ABILITY } from '../../../src/engine/skill-modifier.js';

const ctx = { sessionId: 'skill-names-all' } as any;
const json = (res: any) => { const t = res.content[0].text as string; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const math = async (a: Record<string, unknown>) => json(await handleMathManage(MathManageTool.inputSchema.parse(a), ctx));
const improv = async (a: Record<string, unknown>) => json(await handleImprovisationManage(ImprovisationManageTool.inputSchema.parse(a), ctx));
// STR 12, DEX 14, CON 10, INT 8, WIS 16, CHA 6: every ability has its own modifier, no proficiencies.
const MOD: Record<string, number> = { str: 1, dex: 2, con: 0, int: -1, wis: 3, cha: -2 };

beforeEach(() => {
    closeDb();
    getDb(':memory:');
    const now = new Date().toISOString();
    for (const id of ['a', 'b']) {
        new CharacterRepository(getDb()).create({
            id, name: id.toUpperCase(), characterType: 'pc', level: 1, hp: 10, maxHp: 10, ac: 10, speed: 30,
            stats: { str: 12, dex: 14, con: 10, int: 8, wis: 16, cha: 6 }, skillProficiencies: [], expertise: [], conditions: [], createdAt: now, updatedAt: now
        } as any);
    }
});
afterEach(() => closeDb());

const spellings = (key: string) => {
    const words = key.split('_');
    const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
    return [key, words.map(cap).join(' '), words.join('-'), words.map(cap).join(''), words.join(' ').toUpperCase(), `  ${words.join('  ')} `, words.map(cap).join('-')];
};

describe('all 18 SRD skills in every spelling (play report 7 #11 review)', () => {
    it('roll_skill_check, opposed, stunt and montage each roll the skill\'s ability, with no warning', async () => {
        const wrong: string[] = [];
        for (const [key, ability] of Object.entries(SRD_SKILL_ABILITY)) {
            for (const skill of spellings(key)) {
                const r = await math({ action: 'roll_skill_check', characterId: 'a', skill, seed: 'all' });
                if (r.skillAbility !== ability || r.skillAbilitySource !== 'srd' || r.bonus !== MOD[ability] || r.resolverProblems) wrong.push(`roll_skill_check '${skill}': ${r.skillAbility} ${r.bonus}`);
                const o = await math({ action: 'opposed', characterId: 'a', skill, targetId: 'b', targetSkill: skill });
                if (o.initiator?.skillAbility !== ability || o.defender?.skillAbility !== ability || o.initiator?.bonus !== MOD[ability]) wrong.push(`opposed '${skill}': ${o.initiator?.skillAbility} / ${o.defender?.skillAbility}`);
                const st = await improv({ action: 'stunt', actorId: 'a', skill, dc: 10 });
                if (st.modifier !== MOD[ability]) wrong.push(`stunt '${skill}': ${st.modifier}`);
                const m = await improv({ action: 'montage', characterId: 'a', task: 'the long night', dc: 12, skill, seed: 'all', journal: false });
                if (m.abilityModifier !== MOD[ability] || m.warnings) wrong.push(`montage '${skill}': ${m.abilityModifier} ${JSON.stringify(m.warnings ?? '')}`);
            }
        }
        expect(wrong).toEqual([]);
    }, 60_000);
});
