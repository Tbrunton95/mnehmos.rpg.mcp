/**
 * Play report 7 #7 and #8, the owner's spec, end to end through the tools.
 *
 * "A condition stays prose. Anything that changes a roll should be declared
 * on an effect." Effect mechanics {type: 'advantage_on' | 'disadvantage_on',
 * value: '<scope>', condition: '<when-tag>'} are the one declaration
 * surface: the grammar is checked at write time, an untagged mechanic fires
 * on every roll in its scope, a tagged one on its tag (context) or its name
 * (advantageSources: the GM asserting it, and the log says so). A named
 * source that declares nothing refuses the roll with the call that would
 * declare it; situationalAdvantage: '<reason>' is the GM's one-off.
 * #8: a skillAdvantage trait named in advantageSources fires as its tag does.
 */
import { handleMathManage, MathManageTool } from '../../src/server/consolidated/math-manage.js';
import { handleImprovisationManage, ImprovisationManageTool } from '../../src/server/consolidated/improvisation-manage.js';
import { handleSceneManage, SceneManageTool } from '../../src/server/consolidated/scene-manage.js';
import { handleTableRules, TableRulesTool } from '../../src/server/consolidated/table-rules.js';
import { handleKnowledgeManage, KnowledgeManageTool } from '../../src/server/consolidated/knowledge-manage.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'declared-advantage' } as any;
const W = 'blackcrown';
const text = (res: any) => res.content[0].text as string;
const json = (res: any) => { const m = text(res).match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(text(res)); };
const mathRaw = withOperation('math_manage', (a: any) => handleMathManage(MathManageTool.inputSchema.parse(a), ctx));
const math = async (a: Record<string, unknown>) => json(await mathRaw(a));
const improv = async (a: Record<string, unknown>) => json(await withOperation('improvisation_manage', (x: any) => handleImprovisationManage(ImprovisationManageTool.inputSchema.parse(x), ctx))(a));
const scene = async (a: Record<string, unknown>) => json(await handleSceneManage(SceneManageTool.inputSchema.parse({ worldId: W, ...a }), ctx));
const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx));
const knowledge = async (a: Record<string, unknown>) => json(await withOperation('knowledge_manage', (x: any) => handleKnowledgeManage(KnowledgeManageTool.inputSchema.parse(x), ctx))({ worldId: W, ...a }));
const KEEN_SMELL = { name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent', passiveBonus: 5 };
const rollRows = () => { try { return getDb().prepare('SELECT for_id, purpose, expression FROM roll_log ORDER BY rowid').all() as Array<{ for_id: string; purpose: string; expression: string }>; } catch { return []; } }; // the table is made on the first logged roll
const calcCount = () => { try { return (getDb().prepare('SELECT COUNT(*) AS n FROM calculations').get() as { n: number }).n; } catch { return 0; } };
const effectsOf = (id: string) => getDb().prepare('SELECT name, mechanics FROM custom_effects WHERE target_id = ? AND is_active = 1 ORDER BY id').all(id) as Array<{ name: string; mechanics: string }>;

function mkChar(id: string, name: string, over: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    new CharacterRepository(getDb()).create({
        id, name, characterType: 'pc', level: 1, hp: 20, maxHp: 20, ac: 13, speed: 30,
        stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 },
        skillProficiencies: ['Athletics'], expertise: [], conditions: [], createdAt: now, updatedAt: now, ...over
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
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    mkChar('varek', 'Varek', {
        conditions: [
            { name: 'Horn-Lock: locks horns with a rival head-on', source: 'Gor heritage' },
            { name: 'Gor Hunter' },
            { name: 'Poisoned', source: 'bad water' }
        ],
        skillAdvantage: [KEEN_SMELL]
    });
});
afterEach(() => closeDb());

describe('write time: the scope grammar on effect mechanics', () => {
    it('feature_from_condition converts Horn-Lock in one call; the scope is stored in canonical form', async () => {
        const r = await improv({ action: 'feature_from_condition', characterId: 'varek', match: 'Horn-Lock', mechanics: [{ type: 'advantage', value: 'Grapple', condition: 'head-on' }] });
        expect(r.success).toBe(true);
        expect(r.feature.mechanics).toEqual([{ type: 'advantage_on', value: 'grapple', condition: 'head-on' }]);
        expect(new CharacterRepository(getDb()).findById('varek')!.conditions.map((c: any) => c.name)).toEqual(['Gor Hunter', 'Poisoned']);
    });

    it('a value outside the grammar is refused at write time naming the accepted forms; nothing is written', async () => {
        const bad = await improv({ action: 'apply_effect', targetId: 'varek', name: 'Sneaky', category: 'boon', durationType: 'until_removed', mechanics: [{ type: 'advantage_on', value: 'stealth checks' }] });
        expect(bad.error).toBe(true);
        expect(bad.writes).toBe('none');
        expect(bad.mechanicProblems).toEqual([expect.stringMatching(/^mechanics\[0\]: advantage_on value 'stealth checks' is not a scope\. Accepted scopes: attack, attack:melee, attack:ranged, grapple, grapple:<move>/)]);
        expect(String(bad.message)).toMatch(/Nothing was written/);
        expect(effectsOf('varek')).toEqual([]);
        const conv = await improv({ action: 'feature_from_condition', characterId: 'varek', match: 'Horn-Lock', mechanics: [{ type: 'advantage_on', value: 'grapple:hug', condition: 'head-on' }] });
        expect(conv.error).toBe(true);
        expect(conv.writes).toBe('none');
        expect(new CharacterRepository(getDb()).findById('varek')!.conditions).toHaveLength(3);
        expect(effectsOf('varek')).toEqual([]);
    });

    it('edit_effect and replace_effect refuse a bad scope and leave the row as it was', async () => {
        effect('varek', 'Iron Grip', [{ type: 'custom_trigger', value: 'grip' }]);
        const edit = await improv({ action: 'edit_effect', targetId: 'varek', name: 'Iron Grip', mechanics: [{ type: 'advantage_on', value: 'check:athletics', autoApply: true }] });
        expect(edit.error).toBe(true);
        expect(edit.writes).toBe('none');
        expect(edit.mechanicProblems[0]).toMatch(/is a scope; autoApply belongs to the older form/);
        const replace = await improv({ action: 'replace_effect', targetId: 'varek', name: 'Iron Grip', category: 'boon', durationType: 'until_removed', mechanics: [{ type: 'advantage_on', value: 'save:luck' }] });
        expect(replace.error).toBe(true);
        expect(replace.writes).toBe('none');
        expect(effectsOf('varek')).toEqual([{ name: 'Iron Grip', mechanics: JSON.stringify([{ type: 'custom_trigger', value: 'grip' }]) }]);
        const ok = await improv({ action: 'edit_effect', targetId: 'varek', name: 'Iron Grip', mechanics: [{ type: 'custom_trigger', value: 'grip' }, { type: 'advantage_on', value: 'Check: Athletics' }] });
        expect(ok.success).toBe(true);
        expect(JSON.parse(effectsOf('varek')[0].mechanics)[1]).toEqual({ type: 'advantage_on', value: 'check:athletics' });
    });

    it('the older form is written exactly as before', async () => {
        const r = await improv({ action: 'apply_effect', targetId: 'varek', name: 'Iron Will', category: 'boon', durationType: 'until_removed', mechanics: [{ type: 'advantage_on', value: 1, save: 'wisdom', autoApply: true }, { type: 'advantage_on', value: 'yes', skill: 'stealth' }] });
        expect(r.success).toBe(true);
        expect(JSON.parse(effectsOf('varek')[0].mechanics)).toEqual([{ type: 'advantage_on', value: 1, save: 'wisdom', autoApply: true }, { type: 'advantage_on', value: 'yes', skill: 'stealth' }]);
    });

    it('attack and initiative scopes are written now and touch no check, save or grapple (the attack lane reads them)', async () => {
        const r = await improv({ action: 'apply_effect', targetId: 'varek', name: 'Battle Fury', category: 'boon', durationType: 'until_removed', mechanics: [{ type: 'advantage_on', value: 'Attack:Melee' }, { type: 'advantage_on', value: 'initiative' }, { type: 'disadvantage_on', value: 'attack:ranged', condition: 'in the dark' }] });
        expect(r.success).toBe(true);
        expect(JSON.parse(effectsOf('varek')[0].mechanics)).toEqual([{ type: 'advantage_on', value: 'attack:melee' }, { type: 'advantage_on', value: 'initiative' }, { type: 'disadvantage_on', value: 'attack:ranged', condition: 'in the dark' }]);
        const dex = await math({ action: 'roll_ability_check', characterId: 'varek', ability: 'dex' });
        expect(dex.rolls).toHaveLength(1);
        const athletics = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'athletics' });
        expect(athletics.rolls).toHaveLength(1);
        const named = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'athletics', advantageSources: ['Battle Fury'] });
        expect(named.error).toBe(true);
        expect(named.sourceProblems[0]).toMatch(/^'Battle Fury' grants no advantage on athletics \(it declares advantage on attack:melee; advantage on initiative; disadvantage on attack:ranged\)\./);
    });

    it("check:<skill> takes the world's own skills and refuses one nobody defines", async () => {
        await rules({ action: 'define', kind: 'skill', name: 'Horn Lore', spec: { ability: 'int' } });
        const ok = await improv({ action: 'apply_effect', targetId: 'varek', name: 'Elder Teaching', category: 'boon', durationType: 'until_removed', mechanics: [{ type: 'advantage_on', value: 'check:horn-lore' }] });
        expect(ok.success).toBe(true);
        expect(JSON.parse(effectsOf('varek')[0].mechanics)[0].value).toBe('check:horn_lore');
        const bad = await improv({ action: 'apply_effect', targetId: 'varek', name: 'Haggler', category: 'boon', durationType: 'until_removed', mechanics: [{ type: 'advantage_on', value: 'check:haggling' }] });
        expect(bad.error).toBe(true);
        expect(bad.mechanicProblems[0]).toMatch(/'haggling' is not an SRD skill, an ability or a skill this world defines.*this world's skills \(Horn Lore\)/);
    });
});

describe('write time: every other road that stores an effect mechanic (review)', () => {
    const tableRows = () => getDb().prepare("SELECT name, spec FROM table_rules WHERE kind = 'roll_table'").all() as Array<{ name: string; spec: string }>;
    const omens = (value: string) => ({ entries: [{ weight: 1, text: 'the hunt favours you', apply: { gift: { name: 'Hunt Favour', mechanics: [{ type: 'advantage_on', value }] } } }] });

    it("a roll_table gift's advantage scope is checked on define and import: refused naming the entry, nothing written", async () => {
        const bad = await rules({ action: 'define', kind: 'roll_table', name: 'Omens', spec: omens('stealth checks') });
        expect(bad.error).toBe(true);
        expect(String(bad.message)).toMatch(/^roll_table 'Omens': entries\[0\]\.apply\.gift\.mechanics\[0\]: advantage_on value 'stealth checks' is not a scope\. Accepted scopes: attack/);
        expect(String(bad.message)).toMatch(/Nothing was written/);
        const imported = await rules({ action: 'import', rules: [{ kind: 'principle', name: 'Fair dice', spec: { text: 'dice in the open' } }, { kind: 'roll_table', name: 'Omens', spec: omens('grapples') }] });
        expect(imported.error).toBe(true);
        expect(tableRows()).toEqual([]);
        expect(getDb().prepare('SELECT COUNT(*) AS n FROM table_rules').get()).toEqual({ n: 0 });
    });

    it('a good gift scope is stored canonical, and the gift a roll hands out fires by its scope', async () => {
        const ok = await rules({ action: 'define', kind: 'roll_table', name: 'Omens', spec: omens('Check: Stealth') });
        expect(ok.success).toBe(true);
        expect(JSON.parse(tableRows()[0].spec).entries[0].apply.gift.mechanics).toEqual([{ type: 'advantage_on', value: 'check:stealth' }]);
        const rolled = await rules({ action: 'roll', name: 'Omens', characterId: 'varek', seed: 'omen' });
        expect(rolled.success).toBe(true);
        const r = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'stealth', seed: 'gift' });
        expect(r.advantageSources).toEqual(['Hunt Favour']);
    });

    it("knowledge_manage record: an effectOnKnower's advantage scope is checked before the fact is written", async () => {
        const bad = await knowledge({ action: 'record', key: 'true-name', statement: "the Choir's true name", effectOnKnower: { name: 'Knows the Name', description: 'speaks it', mechanics: [{ type: 'advantage_on', value: 'deception checks' }] }, knowers: ['varek'], how: 'told', fromId: 'nobody' });
        expect(bad.error).toBe(true);
        expect(bad.writes).toBe('none');
        expect(String(bad.message)).toMatch(/effectOnKnower\.mechanics\[0\]: advantage_on value 'deception checks' is not a scope/);
        const bare = await knowledge({ action: 'record', key: 'true-name', statement: "the Choir's true name", effectOnKnower: { name: 'Knows the Name', description: 'speaks it', mechanics: [{ type: 'advantage_on', value: 'deception checks' }] } });
        expect(bare.error).toBe(true);
        let facts = 0;
        try { facts = (getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_facts').get() as { n: number }).n; } catch { /* the table is made on the first record */ }
        expect(facts).toBe(0);
        const ok = await knowledge({ action: 'record', key: 'true-name', statement: "the Choir's true name", effectOnKnower: { name: 'Knows the Name', description: 'speaks it', mechanics: [{ type: 'advantage_on', value: 'Check: Deception' }] }, knowers: ['varek'], how: 'witnessed' });
        expect(ok.success).toBe(true);
        expect(effectsOf('varek').map(e => JSON.parse(e.mechanics))).toEqual([[{ type: 'advantage_on', value: 'check:deception' }]]);
        expect((await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'deception', seed: 'name' })).advantageSources).toEqual(['Knows the Name']);
    });
});

describe('the printed edit_effect call pastes over an older-form mechanic (review)', () => {
    it('re-sending a stored older-form mechanic unchanged is not a new scope: the call the refusal prints is accepted, and fires', async () => {
        effect('varek', 'Shadow Cloak', [{ type: 'advantage_on', value: 'in dim light' }]);
        // The older form: named, it grants on any save or check, as before.
        expect((await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', advantageSources: ['Shadow Cloak'], seed: 'cloak' })).advantageSources).toEqual(['Shadow Cloak']);
        const refused = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', disadvantageSources: ['Shadow Cloak'] });
        expect(refused.error).toBe(true);
        const m = /improvisation_manage edit_effect (\{.*\});/.exec(refused.sourceProblems[0])!;
        expect(m).toBeTruthy();
        const pasted = await improv({ action: 'edit_effect', ...Function(`return (${m[1]})`)() });
        expect(pasted.success).toBe(true);
        expect(JSON.parse(effectsOf('varek')[0].mechanics)).toEqual([{ type: 'advantage_on', value: 'in dim light' }, { type: 'disadvantage_on', value: 'save:wis' }]);
        const fired = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', disadvantageSources: ['Shadow Cloak'], seed: 'cloak' });
        expect(fired.error).toBeFalsy();
        expect(fired.disadvantageSources).toEqual(['Shadow Cloak']);
        // A NEW prose value is still refused, on edit and on replace.
        const fresh = await improv({ action: 'edit_effect', targetId: 'varek', name: 'Shadow Cloak', mechanics: [{ type: 'advantage_on', value: 'in dim light' }, { type: 'advantage_on', value: 'in fog' }] });
        expect(fresh.error).toBe(true);
        expect(fresh.mechanicProblems).toEqual([expect.stringMatching(/^mechanics\[1\]: advantage_on value 'in fog' is not a scope/)]);
        const replaced = await improv({ action: 'replace_effect', targetId: 'varek', name: 'Shadow Cloak', category: 'boon', durationType: 'until_removed', mechanics: [{ value: 'in dim light', type: 'advantage_on' }, { type: 'advantage_on', value: 'check:stealth' }] });
        expect(replaced.success).toBe(true);
    });
});

describe('a name with an apostrophe: the printed call still pastes (review)', () => {
    it("feature_from_condition for \"Hunter's Mark\" is quoted so it parses, converts, and fires", async () => {
        new CharacterRepository(getDb()).update('varek', { conditions: [{ name: "Hunter's Mark: the quarry is marked" }] } as never);
        const refused = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'survival', advantageSources: ["Hunter's Mark"] });
        expect(refused.error).toBe(true);
        const m = /improvisation_manage (feature_from_condition) (\{.*\});/.exec(refused.sourceProblems[0])!;
        expect(m).toBeTruthy();
        const args = Function(`return (${m[2]})`)();
        expect(args.match).toBe("Hunter's Mark");
        expect((await improv({ action: m[1], ...args })).success).toBe(true);
        const r = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'survival', advantageSources: ["Hunter's Mark"], seed: 'mark' });
        expect(r.advantageSources).toEqual(["Hunter's Mark"]);
        // Named the other way, the edit_effect call parses too.
        const other = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', disadvantageSources: ["Hunter's Mark"] });
        const e = /improvisation_manage (edit_effect) (\{.*\});/.exec(other.sourceProblems[0])!;
        expect(Function(`return (${e[2]})`)().name).toBe("Hunter's Mark");
    });
});

describe('math_manage: a named source must declare it', () => {
    it("'Gor Hunter' grants nothing and the roll is refused with the conversion call; nothing is rolled or logged", async () => {
        const before = calcCount();
        const res = await mathRaw({ action: 'roll_skill_check', characterId: 'varek', skill: 'stealth', advantageSources: ['Gor Hunter'] });
        const r = json(res);
        expect(r.error).toBe(true);
        expect(r.writes).toBe('none');
        expect(r.actionType).toBe('roll_skill_check');
        expect(r.sourceProblems).toEqual([`'Gor Hunter' grants no advantage on stealth. To grant one, improvisation_manage feature_from_condition {characterId: 'varek', match: 'Gor Hunter', mechanics: [{type: 'advantage_on', value: 'check:stealth'}]}; for a one-off, use situationalAdvantage: '<reason>'.`]);
        expect(String(r.message)).toMatch(/Nothing was rolled or logged/);
        expect(text(res)).toMatch(/Gor Hunter/);
        expect(rollRows()).toEqual([]);
        expect(calcCount()).toBe(before);
    });

    it('a miss or an ambiguous name now refuses the roll too, in the pinned words', async () => {
        const miss = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', advantageSources: ['Khorne'] });
        expect(miss.error).toBe(true);
        expect(miss.writes).toBe('none');
        expect(miss.sourceProblems).toEqual(['advantage source "Khorne" matches nothing in Varek\'s conditions or active effects — nothing granted']);
        expect(rollRows()).toEqual([]);
    });

    it("situationalAdvantage is the GM's one-off, logged with its reason; advantage: true is logged as GM", async () => {
        const r = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', situationalAdvantage: 'the Choir sings' });
        expect(r.rolls).toHaveLength(2);
        expect(r.advantageSources).toEqual(['GM: the Choir sings']);
        expect(r.situationalAdvantage).toBe('the Choir sings');
        expect(r.contributions).toEqual(expect.arrayContaining([{ label: 'ADV ← GM: the Choir sings', value: 0, lane: 'SITUATIONAL' }]));
        const flag = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'insight', advantage: true });
        expect(flag.advantageSources).toEqual(['GM']);
        const dis = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'insight', situationalDisadvantage: 'smoke in the eyes' });
        expect(dis.rolls).toHaveLength(2);
        expect(dis.disadvantageSources).toEqual(['GM: smoke in the eyes']);
        expect(rollRows().map(x => x.purpose)).toEqual(['wis save (adv: GM: the Choir sings)', 'insight check (adv: GM)', 'insight check (dis: GM: smoke in the eyes)']);
    });

    it('an untagged scoped mechanic fires on every roll in its scope, by itself', async () => {
        effect('varek', 'Wolf Ears', [{ type: 'advantage_on', value: 'check:perception' }]);
        effect('varek', 'Brittle Will', [{ type: 'disadvantage_on', value: 'save:wis' }]);
        effect('varek', 'Gor Strength', [{ type: 'advantage_on', value: 'check:str' }]);
        const perc = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception' });
        expect(perc.rolls).toHaveLength(2);
        expect(perc.advantageSources).toEqual(['Wolf Ears']);
        expect(perc.contributions).toEqual(expect.arrayContaining([{ label: 'ADV ← Wolf Ears', value: 0, lane: 'ENGINE' }]));
        expect((await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'insight' })).rolls).toHaveLength(1);
        expect((await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis' })).disadvantageSources).toEqual(['Brittle Will']);
        expect((await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'dex' })).disadvantageSources).toBeUndefined();
        // check:str covers Athletics (STR) and a STR ability check.
        expect((await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'athletics' })).advantageSources).toEqual(['Gor Strength']);
        expect((await math({ action: 'roll_ability_check', characterId: 'varek', ability: 'str' })).advantageSources).toEqual(['Gor Strength']);
        // Named as well, it is listed once.
        expect((await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', advantageSources: ['Wolf Ears'] })).advantageSources).toEqual(['Wolf Ears']);
    });

    it('a tagged mechanic fires on its tag — on saves and ability checks too — or on its name, and the log says which', async () => {
        effect('varek', 'Choir Ward', [{ type: 'advantage_on', value: 'save:wis', condition: 'the Choir sings' }]);
        const bare = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis' });
        expect(bare.rolls).toHaveLength(1);
        expect(bare.conditionalAdvantage).toEqual(["Choir Ward (the Choir sings): pass context: ['the Choir sings'] or advantageSources: ['Choir Ward'] when it holds"]);
        const tagged = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', context: ['the choir sings'] });
        expect(tagged.rolls).toHaveLength(2);
        expect(tagged.advantageSources).toEqual(['Choir Ward (the Choir sings)']);
        expect(tagged.resolverProblems).toBeUndefined();
        const named = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', advantageSources: ['Choir Ward'] });
        expect(named.advantageSources).toEqual(['Choir Ward (the Choir sings, named)']);
        expect(named.contributions).toEqual(expect.arrayContaining([{ label: 'ADV ← Choir Ward (the Choir sings, named)', value: 0, lane: 'EFFECT' }]));
        const both = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', context: ['the Choir sings'], advantageSources: ['Choir Ward'] });
        expect(both.advantageSources).toEqual(['Choir Ward (the Choir sings)']);
        expect(rollRows().map(x => x.purpose)).toEqual(['wis save', 'wis save (adv: Choir Ward (the Choir sings))', 'wis save (adv: Choir Ward (the Choir sings, named))', 'wis save (adv: Choir Ward (the Choir sings))']);
        // A tag that fires nothing on a save is said, not swallowed.
        const stray = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', context: ['scent'] });
        expect(stray.resolverProblems).toEqual([`context [scent] fired nothing on this save: no tagged effect on Varek declares it here (skillAdvantage traits fire on skill checks only)`]);
    });

    it('a standard condition declares its 5e disadvantage; a prose one is refused', async () => {
        const r = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', disadvantageSources: ['poisoned'] });
        expect(r.rolls).toHaveLength(2);
        expect(r.disadvantageSources).toEqual(['Poisoned']);
        expect(r.contributions).toEqual(expect.arrayContaining([{ label: 'DIS ← Poisoned', value: 0, lane: 'SHEET' }]));
        const save = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', disadvantageSources: ['bad water'] });
        expect(save.error).toBe(true);
        expect(save.sourceProblems[0]).toMatch(/^'Poisoned' grants no disadvantage on WIS saves/);
    });
});

describe('#8: a skillAdvantage trait named in advantageSources', () => {
    it('Keen Smell by name on Perception fires as its tag would, and is logged as named', async () => {
        const r = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', advantageSources: ['Keen Smell'] });
        expect(r.success).toBe(true);
        expect(r.rolls).toHaveLength(2);
        expect(r.advantageSources).toEqual(['Keen Smell (scent, named)']);
        expect(r.traitAdvantage).toEqual(['Keen Smell (scent, named)']);
        expect(r.conditionalAdvantage).toBeUndefined();
        expect(r.contributions).toEqual(expect.arrayContaining([{ label: 'ADV ← Keen Smell (scent, named)', value: 0, lane: 'SHEET' }]));
        expect(rollRows()[0].purpose).toBe('perception check (adv: Keen Smell (scent, named))');
        // With the tag too, one label.
        const both = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent'], advantageSources: ['keen'] });
        expect(both.advantageSources).toEqual(['Keen Smell (scent)']);
    });

    it('a scene denial still applies to a named trait, and is quoted', async () => {
        await scene({ action: 'set', narration: 'Peat smoke.', participants: ['varek'], senseDenial: { scent: 'buried in peat-smoke' } });
        const r = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', advantageSources: ['Keen Smell'] });
        expect(r.success).toBe(true);
        expect(r.rolls).toHaveLength(1);
        expect(r.deniedAdvantage).toEqual([{ trait: 'Keen Smell', when: 'scent', reason: 'buried in peat-smoke' }]);
        expect(r.advantageSources).toBeUndefined();
    });

    it('on Insight, or on a save, the trait is refused with the exact call', async () => {
        const insight = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'insight', advantageSources: ['Keen Smell'] });
        expect(insight.error).toBe(true);
        expect(insight.writes).toBe('none');
        expect(insight.sourceProblems).toEqual([`'Keen Smell' is Varek's skillAdvantage trait for perception, survival (when: scent); this is an insight check, so it does not apply — on a perception or survival check name it, or tag it: math_manage {action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent']}; nothing granted`]);
        const save = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', advantageSources: ['Keen Smell'] });
        expect(save.error).toBe(true);
        expect(save.sourceProblems[0]).toMatch(/saves and ability checks take no skill traits — roll it as math_manage \{action: 'roll_skill_check'/);
        expect(rollRows()).toEqual([]);
    });
});
