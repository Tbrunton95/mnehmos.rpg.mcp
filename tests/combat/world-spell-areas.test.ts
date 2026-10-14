/**
 * Play report 7 follow-up, lane S: area world spells.
 *
 * The owner's rule: damage resolves by its shape, not by the code path that
 * delivered it. A world spell (table_rules kind spell) whose rule carries
 * area: {shape, size} resolves on a unit token model by model, exactly as an
 * SRD area spell does: one damage roll, one save per model inside on the
 * fight's dice, deaths counted per model. An unmarked world spell hits one
 * model at most. A spaced unit under an area spell with no count is refused
 * before any cost is paid or the casting roll is rolled.
 *
 * The presets: Foot of Gork (a stomp), Green Puke (a line) and Plague (a
 * cloud) are areas; Warp Lightning (a bolt) and the Dreaded Thirteenth Spell
 * stay single-target.
 *
 * Lane W (per-model wounds) builds in parallel: a model that saves for half
 * keeps its wound there, so the pool loses more than the dead models' HP.
 * Where that changes a number, these tests read it off the report
 * (hp = before − unitArea.hpLost) instead of pinning it.
 */
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { handleTableRules, TableRulesTool } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { shapeReply } from '../../src/server/output-mode.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { ConcentrationRepository } from '../../src/storage/repos/concentration.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { parseRuleSpec, loadRule } from '../../src/engine/table-rules.js';
import { ORRUK_WAAAGH_PRESET } from '../../src/data/table-rules/orruk-waaagh.js';
import { SKAVEN_HORNED_RAT_PRESET } from '../../src/data/table-rules/skaven-horned-rat.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'unscoped' };
const W = 'blackcrown';
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const guardedAction = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
const rules = (args: Record<string, unknown>) => handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...args }), ctx as any);
let enc: string;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guardedManage(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    return { text, r: tag(text, 'COMBAT_MANAGE') ?? { rawText: text } };
};
const actRaw = (args: Record<string, unknown>) => guardedAction(CombatActionTool.inputSchema.parse({ encounterId: enc, ...args }));
const act = async (args: Record<string, unknown>) => {
    const text = (await actRaw(args)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, d, r: d?.actionResult ?? d };
};
const summary = (res: any) => JSON.parse(shapeReply(res, { mode: 'summary' }).content![0].text);
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const rolls = () => queryRolls(getDb(), { encounterId: enc, limit: 500 }) as Array<{ purpose: string; dice?: number[] }>;
const modelSaves = (spell: string) => rolls().filter(x => new RegExp(`^${spell} save \\(model \\d+/\\d+\\)`).test(String(x.purpose)));
const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };
/** The purposes a d20 spy was called with (a mocked die is not logged, so read the calls). */
const purposes = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => String((c[0] as { purpose?: string } | undefined)?.purpose));

/** Fix the dice whose purpose starts with a key ('cast Foot of Gork', 'Foot of Gork damage'); every other roll stays live and logged. */
function fixDice(fixed: Record<string, number[]>) {
    const orig = CombatEngine.prototype.rollDice;
    vi.spyOn(CombatEngine.prototype, 'rollDice').mockImplementation(function (this: CombatEngine, notation: string, t: any) {
        const key = Object.keys(fixed).find(k => String(t?.purpose ?? '').startsWith(k));
        if (key) {
            const r = fixed[key];
            const total = r.reduce((a, b) => a + b, 0);
            return { notation, rolls: r, diceTotal: total, modifier: 0, total } as any;
        }
        return orig.call(this, notation, t);
    });
}

const MILITIA = (extra: Record<string, unknown> = {}, unit: Record<string, unknown> = {}) => ({
    id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, ac: 11,
    unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 2, morale: 6, ...unit }, ...extra
});
const LINE = (unit: Record<string, unknown> = {}) => ({
    id: 'line', name: 'Line', hp: 50, maxHp: 50, initiative: 4, isEnemy: true, ac: 11,
    unit: { models: 10, hpPerModel: 5, packed: false, attackBonus: 2, morale: 7, ...unit }
});
const CASTER = (id: string, name: string) => ({ id, name, hp: 40, maxHp: 40, initiative: 20 });

async function setup(participants: any[], opts: { presets?: string[]; seed?: string; sheets?: Array<Record<string, unknown>> } = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
    for (const p of opts.presets ?? []) {
        const res = await rules({ action: 'import', preset: p });
        if (res.content[0].text.includes('"error":true')) throw new Error(res.content[0].text);
    }
    for (const s of opts.sheets ?? []) {
        new CharacterRepository(db).create({
            name: String(s.id), stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 30, maxHp: 30, ac: 12, level: 5,
            createdAt: now, updatedAt: now, ...s
        } as any);
    }
    enc = (await manage({ action: 'create', worldId: W, ...(opts.seed ? { seed: opts.seed } : {}), participants })).r.encounterId;
    expect(enc).toBeTruthy();
}

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('the area flag on a world spell rule', () => {
    it('a spell rule takes area {shape, size} as an SRD spell takes areaOfEffect', () => {
        const spec = parseRuleSpec('spell', { area: { shape: 'cylinder', size: 20 }, effects: [{ type: 'damage', dice: '4d6' }] });
        expect(spec.area).toEqual({ shape: 'cylinder', size: 20 });
        expect(parseRuleSpec('spell', { effects: [{ type: 'damage', dice: '2d6' }] }).area).toBeUndefined();
    });

    it('define refuses an area it cannot read, naming the shapes, and writes nothing', async () => {
        await setup([CASTER('seer', 'Seer'), MILITIA()]);
        const bad = (await rules({ action: 'define', kind: 'spell', name: 'Bad Cloud', spec: { area: { shape: 'blob', size: 20 }, effects: [{ type: 'damage', dice: '10' }] } })).content[0].text;
        expect(bad).toMatch(/area\.shape/);
        expect(bad).toMatch(/cone.*cube.*cylinder.*line.*sphere/);
        const noSize = (await rules({ action: 'define', kind: 'spell', name: 'Bad Cloud', spec: { area: { shape: 'sphere' }, effects: [{ type: 'damage', dice: '10' }] } })).content[0].text;
        expect(noSize).toMatch(/area\.size/);
        expect(loadRule(getDb(), W, 'spell', 'Bad Cloud')).toBeUndefined();
    });

    it("a stored spell whose area does not parse keeps its defaults and reads as unmarked (it does not fall back to the raw JSON)", async () => {
        await setup([CASTER('seer', 'Seer'), MILITIA()]);
        const now = new Date().toISOString();
        getDb().prepare("INSERT INTO table_rules (id, world_id, kind, name, spec, enabled, created_at, updated_at) VALUES ('stray', ?, 'spell', 'Stray Quake', ?, 1, ?, ?)")
            .run(W, JSON.stringify({ area: true, effects: [{ type: 'damage', dice: '20' }] }), now, now);
        const rule = loadRule(getDb(), W, 'spell', 'Stray Quake')!;
        expect(rule.spec.cost).toEqual([]);
        expect(rule.spec.known).toBe(true);
        expect(rule.spec.effects[0]).toMatchObject({ type: 'damage', target: 'target', saveEffect: 'none' });
        expect(rule.spec.area).toBeUndefined();
        // Unmarked: one model at most.
        const { r } = await act({ action: 'cast_spell', actorId: 'seer', spellName: 'Stray Quake', targetId: 'militia' });
        expect(r.unitCaps?.[0]).toMatchObject({ targetId: 'militia', before: 20, after: 9 });
        expect(tok('militia').hp).toBe(45);
    });

    it('the presets mark the three with a shape (Foot of Gork, Green Puke, Plague) and leave the bolt and the Thirteenth Spell single-target', () => {
        const spell = (preset: typeof ORRUK_WAAAGH_PRESET, name: string) => preset.find(e => e.kind === 'spell' && e.name === name)!.spec as Record<string, unknown>;
        expect(spell(ORRUK_WAAAGH_PRESET, 'Foot of Gork').area).toEqual({ shape: 'cylinder', size: 20 });
        expect(spell(ORRUK_WAAAGH_PRESET, 'Green Puke').area).toEqual({ shape: 'line', size: 30 });
        expect(spell(SKAVEN_HORNED_RAT_PRESET, 'Plague').area).toEqual({ shape: 'sphere', size: 20 });
        for (const name of ['Warp Lightning', 'Warp Lightning (warpstone)', 'Dreaded Thirteenth Spell', 'Dreaded Thirteenth Spell (warpstone)']) {
            expect(spell(SKAVEN_HORNED_RAT_PRESET, name)).not.toHaveProperty('area');
        }
        expect(spell(ORRUK_WAAAGH_PRESET, 'Mighty Waaagh!')).not.toHaveProperty('area');
        // Every preset spec still parses with its area.
        for (const e of [...ORRUK_WAAAGH_PRESET, ...SKAVEN_HORNED_RAT_PRESET].filter(e => e.kind === 'spell')) {
            expect(() => parseRuleSpec('spell', e.spec)).not.toThrow();
        }
    });
});

describe('an area world spell on a unit token goes model by model', () => {
    it('Foot of Gork (a 20-ft cylinder) on packed militia: one damage roll, one DEX save per model on the casting total, deaths per model', async () => {
        await setup([CASTER('wurrzag', 'Wurrzag'), MILITIA()], { presets: ['orruk-waaagh'] });
        // Casting 3+5 = 8 vs 7: cast, and the save DC is the casting total (8).
        fixDice({ 'cast Foot of Gork': [3, 5], 'Foot of Gork damage': [3, 3, 3, 3] });
        const spy = d20s(20, 1, 20, 1, 1, 20);
        const { text, r } = await act({ action: 'cast_spell', actorId: 'wurrzag', spellName: 'Foot of Gork', targetId: 'militia' });
        const ua = r.unitAreas?.[0];
        expect(ua).toMatchObject({ targetId: 'militia', name: 'Militia', shape: 'cylinder', inAreaSource: 'packed', modelsInArea: 6, failed: 3, saved: 3, perModel: { full: 12, half: 6 }, modelsKilled: 3, modelsAfter: 3 });
        expect(ua.saveBonus).toMatchObject({ ability: 'dexterity', dc: 8 });
        expect(ua.saves.map((s: any) => s.natural)).toEqual([20, 1, 20, 1, 1, 20]);
        expect(text).toContain('6 in the cylinder: 3 failed, 3 saved; 12 / 6 vs 9 HP each: 3 dead, 3/6 left');
        expect(text).toMatch(/Saves vs DC 8 \(.*\): 20✓ 1✗ 20✓ 1✗ 1✗ 20✓/);
        // No token-level save: the unit saved model by model.
        expect(r.saves).toBeUndefined();
        const effect = r.worldSpell.effects[0];
        expect(effect).not.toHaveProperty('save');
        expect(effect).toMatchObject({ targetId: 'militia', rolled: 12, dc: 8, damage: ua.hpLost, hpBefore: 54, hpAfter: 54 - ua.hpLost });
        expect(tok('militia').hp).toBe(54 - ua.hpLost);
        // The break test reads the real count.
        expect(r.breakTests?.[0]).toMatchObject({ participantId: 'militia', modelsAfter: 3 });
        expect(text).toMatch(/BREAK TEST DUE: Militia fell to 3\/6 models/);
        expect(purposes(spy)).toEqual([1, 2, 3, 4, 5, 6].map(i => `Foot of Gork save (model ${i}/6)`));
        expect(text).toMatch(/\[WORLD SPELL: Foot of Gork, CAST, DMG: \d+/);
    });

    it('the models that saved keep their wounds on the token (lane W): three stand at 3/9, not one at 9', async () => {
        await setup([CASTER('wurrzag', 'Wurrzag'), MILITIA()], { presets: ['orruk-waaagh'] });
        fixDice({ 'cast Foot of Gork': [3, 5], 'Foot of Gork damage': [3, 3, 3, 3] });
        d20s(20, 1, 20, 1, 1, 20);
        const { r } = await act({ action: 'cast_spell', actorId: 'wurrzag', spellName: 'Foot of Gork', targetId: 'militia' });
        expect(r.unitAreas?.[0]).toMatchObject({ modelsKilled: 3, modelsAfter: 3 });
        const militia = tok('militia');
        expect(militia.hp).toBe(9);
        expect(militia.unit.wounded).toEqual([3, 3, 3]);
        const state = (await manage({ action: 'get' })).r;
        expect(state.participants.find((p: any) => p.id === 'militia').unit.wounds).toMatch(/^3 alive: 3 at 3\/9$/);
    });

    it('the summary keeps each unit line whole, with the break test named', async () => {
        await setup([CASTER('wurrzag', 'Wurrzag'), MILITIA()], { presets: ['orruk-waaagh'] });
        fixDice({ 'cast Foot of Gork': [3, 5], 'Foot of Gork damage': [3, 3, 3, 3] });
        d20s(20, 1, 20, 1, 1, 20);
        const s = summary(await actRaw({ action: 'cast_spell', actorId: 'wurrzag', spellName: 'Foot of Gork', targetId: 'militia' }));
        expect(s.unitLines).toHaveLength(1);
        expect(s.unitLines[0]).toMatch(/^Militia — 6 in the cylinder: 3 failed, 3 saved; 12 \/ 6 vs 9 HP each: 3 dead, 3\/6 left/);
        expect(s.unitLines[0]).toMatch(/; BREAK TEST DUE \(morale 6\)$/);
    });

    it('Green Puke (a 30-ft line) on a spaced unit is refused without a count, nothing spent or rolled; with modelsInArea only those models', async () => {
        await setup([CASTER('shaman', 'Shaman'), LINE()], { presets: ['orruk-waaagh'] });
        const before = rolls().length;
        const refused = await act({ action: 'cast_spell', actorId: 'shaman', spellName: 'Green Puke', targetId: 'line' });
        expect(refused.d.error).toBe(true);
        expect(refused.d.writes).toBe('none');
        expect(String(refused.d.message)).toMatch(/Line is spaced: say how many of its 10 models the area covers/);
        expect(String(refused.d.message)).toMatch(/modelsInArea: \{'line': <0-10>\}/);
        expect(rolls().length).toBe(before);
        expect(rolls().some(x => /^cast Green Puke/.test(x.purpose))).toBe(false);
        expect(tok('shaman').actionUsed).toBeFalsy();
        expect(tok('line').hp).toBe(50);

        // 2+5 = 7 vs 6: cast, DC 7; 2d6 = 10 acid; every model inside fails and dies.
        fixDice({ 'cast Green Puke': [2, 5], 'Green Puke damage': [4, 6] });
        const spy = d20s(1, 1, 1, 1);
        const { text, r } = await act({ action: 'cast_spell', actorId: 'shaman', spellName: 'Green Puke', targetId: 'line', modelsInArea: { line: 4 } });
        expect(r.unitAreas?.[0]).toMatchObject({ targetId: 'line', shape: 'line', inAreaSource: 'given', modelsInArea: 4, failed: 4, saved: 0, modelsKilled: 4, modelsAfter: 6, hpLost: 20 });
        expect(text).toContain('4 of 10 in the line: 4 failed, 0 saved; 10 / 5 vs 5 HP each: 4 dead, 6/10 left');
        expect(tok('line').hp).toBe(30);
        expect(r.breakTests).toBeUndefined();
        expect(purposes(spy)).toEqual([1, 2, 3, 4].map(i => `Green Puke save (model ${i}/4)`));
        expect(tok('shaman').actionUsed).toBe(true);
    });

    it('a costed area spell refused for a missing count pays nothing: the pool, the casting roll and the action are untouched', async () => {
        await setup([CASTER('seer', 'Seer'), LINE()], { sheets: [{ id: 'seer', resourcePools: { warpstone: { current: 3, max: 10 } } }] });
        await rules({ action: 'define', kind: 'spell', name: 'Warpfire', spec: {
            castingRoll: { dice: '2d6', target: 5 }, cost: [{ pool: 'warpstone', delta: -1 }],
            area: { shape: 'cone', size: 15 }, effects: [{ type: 'damage', dice: '2d6', damageType: 'fire', save: { ability: 'dex' }, saveEffect: 'half' }]
        } });
        const before = rolls().length;
        const refused = await act({ action: 'cast_spell', actorId: 'seer', spellName: 'Warpfire', targetId: 'line' });
        expect(refused.d.writes).toBe('none');
        expect((new CharacterRepository(getDb()).findById('seer') as any).resourcePools.warpstone.current).toBe(3);
        expect(rolls().length).toBe(before);
        expect(tok('seer').actionUsed).toBeFalsy();
    });

    it("Plague (a 20-ft sphere): the poison goes model by model on CON; its Plagued rider stays one save for the token", async () => {
        await setup([CASTER('seer', 'Seer'), MILITIA()], { presets: ['skaven-horned-rat'] });
        // 2+6 = 8 vs 7: cast, DC 8. 2d6 = 12 poison, half 6.
        fixDice({ 'cast Plague': [2, 6], 'Plague damage': [6, 6] });
        // Six model saves, then the token's one CON save against the condition.
        const spy = d20s(20, 1, 20, 1, 1, 20, 1);
        const { text, r } = await act({ action: 'cast_spell', actorId: 'seer', spellName: 'Plague', targetId: 'militia' });
        expect(r.unitAreas?.[0]).toMatchObject({ shape: 'sphere', failed: 3, saved: 3, modelsKilled: 3, modelsAfter: 3 });
        expect(r.unitAreas?.[0].saveBonus).toMatchObject({ ability: 'constitution', dc: 8 });
        expect(purposes(spy)).toEqual([...[1, 2, 3, 4, 5, 6].map(i => `Plague save (model ${i}/6)`), 'constitution save vs Plague']);
        // The condition: one save for the token, as on the SRD road.
        expect(r.saves).toHaveLength(1);
        expect(r.saves[0]).toMatchObject({ id: 'militia', ability: 'constitution', natural: 1, saved: false });
        expect(r.conditionsApplied).toEqual([{ id: 'militia', name: 'Militia', condition: 'Plagued' }]);
        expect(text).toMatch(/Militia is Plagued \(Plague\)/);
    });

    it("the unit token's declared save:dex sides reach every model's save (lane G1), and saveSources names the models", async () => {
        await setup([CASTER('wurrzag', 'Wurrzag'), MILITIA()], { presets: ['orruk-waaagh'] });
        new CustomEffectsRepository(getDb()).apply({
            target_id: 'militia', target_type: 'character', name: 'Shield Drill', description: 'Shield Drill', category: 'boon', power_level: 1,
            source: { type: 'unknown' }, mechanics: [{ type: 'advantage_on', value: 'save:dex' }] as never, duration: { type: 'until_removed' as never },
            triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
        } as never);
        fixDice({ 'cast Foot of Gork': [3, 5], 'Foot of Gork damage': [3, 3, 3, 3] });
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const { text, d, r } = await act({ action: 'cast_spell', actorId: 'wurrzag', spellName: 'Foot of Gork', targetId: 'militia' });
        const ua = r.unitAreas[0];
        expect(ua.saves).toHaveLength(6);
        expect(ua.saves.every((s: any) => s.rolls.length === 2 && s.natural === Math.max(...s.rolls))).toBe(true);
        expect(spy).toHaveBeenCalledTimes(12);
        expect(ua.advantageSources).toEqual(['Shield Drill (save:dex)']);
        expect(d.saveSources).toEqual([{ targetId: 'militia', name: 'Militia', ability: 'dexterity', models: 6, advantage: ['Shield Drill (save:dex)'] }]);
        expect(text).toMatch(/Saves vs DC 8 \(.*adv: Shield Drill \(save:dex\)\)/);
    });

    it("a concentrating unit's CON save (lane H) takes the HP the area cost, not the rolled figure", async () => {
        await setup([CASTER('wurrzag', 'Wurrzag'), { ...MILITIA(), id: 'warband', name: 'Warband' }], {
            presets: ['orruk-waaagh'], sheets: [{ id: 'warband', name: 'Warband', hp: 54, maxHp: 54 }]
        });
        new ConcentrationRepository(getDb()).create({ characterId: 'warband', activeSpell: 'Bless', spellLevel: 1, targetIds: [], startedAt: 1, maxDuration: 10, saveDCBase: 10 } as any);
        // 20 per model, 10 on a save: every model inside dies whichever way it saves.
        fixDice({ 'cast Foot of Gork': [3, 5], 'Foot of Gork damage': [5, 5, 5, 5] });
        // Three model saves, then the concentration save: 12 vs DC 13 (27 HP lost) breaks it; vs DC 10 (20 rolled) it would hold.
        const spy = d20s(20, 1, 20, 12);
        const { r } = await act({ action: 'cast_spell', actorId: 'wurrzag', spellName: 'Foot of Gork', targetId: 'warband', modelsInArea: { warband: 3 } });
        expect(r.unitAreas[0]).toMatchObject({ modelsInArea: 3, modelsKilled: 3, hpLost: 27 });
        expect(tok('warband').hp).toBe(27);
        expect(purposes(spy)).toEqual(['Foot of Gork save (model 1/3)', 'Foot of Gork save (model 2/3)', 'Foot of Gork save (model 3/3)', 'concentration']);
        // 12 + CON 0 vs DC 13 (half of 27): broken. Against the rolled 20 (DC 10) it would have held.
        expect(new ConcentrationRepository(getDb()).isConcentrating('warband')).toBe(false);
    });

    it("an effect aimed at the caster stays one token's hit: a unit caster takes one model at most", async () => {
        await setup([{ ...MILITIA({ initiative: 20 }, { hpPerModel: 8 }), id: 'monks', name: 'Monks', hp: 48, maxHp: 48, isEnemy: false }, MILITIA()]);
        await rules({ action: 'define', kind: 'spell', name: 'Blood Rite', spec: {
            area: { shape: 'sphere', size: 10 },
            effects: [{ type: 'damage', dice: '6', damageType: 'necrotic' }, { type: 'damage', dice: '12', damageType: 'necrotic', target: 'caster' }]
        } });
        const { text, r } = await act({ action: 'cast_spell', actorId: 'monks', spellName: 'Blood Rite', targetId: 'militia' });
        // The target unit: 6 vs 9 HP each, no save, nobody dies.
        expect(r.unitAreas).toHaveLength(1);
        expect(r.unitAreas[0]).toMatchObject({ targetId: 'militia', noSave: true, modelsKilled: 0 });
        // The caster unit: one model at most.
        expect(r.unitCaps).toEqual([{ targetId: 'monks', name: 'Monks', before: 12, after: 8 }]);
        expect(tok('monks').hp).toBe(40);
        // Review (lane S): Blood Rite already has an area, so the cap line must
        // not tell the GM to give it one; it says why this hit is single.
        expect(text).toMatch(/one model at most: 12 → 8 \(aimed at the caster: a single hit, not Blood Rite's area\)/);
        expect(text).not.toMatch(/Blood Rite is not an area/);
    });

    it('the area survives a second process: the encounter row holds the result; the same seed replays every model save', async () => {
        const run = async () => {
            await setup([CASTER('wurrzag', 'Wurrzag'), MILITIA()], { presets: ['orruk-waaagh'], seed: 'world-area-replay' });
            fixDice({ 'cast Foot of Gork': [3, 5], 'Foot of Gork damage': [3, 3, 3, 3] });
            const { r } = await act({ action: 'cast_spell', actorId: 'wurrzag', spellName: 'Foot of Gork', targetId: 'militia' });
            vi.restoreAllMocks();
            // A second process: no engine in memory, the state from the encounter row.
            clearCombatState();
            const after = tok('militia');
            expect(after.hp).toBe(54 - r.unitAreas[0].hpLost);
            const view = (await manage({ action: 'get' })).text;
            expect(view).toMatch(/Militia/);
            return modelSaves('Foot of Gork').map(x => x.dice);
        };
        const a = await run();
        const b = await run();
        expect(a).toHaveLength(6);
        expect(b).toEqual(a);
    });

    it('a unit already wiped out takes the area as Fireball does: no model inside, no token save, no legendary resistance spent, no damage claimed', async () => {
        // Review (lane S): a 0-HP unit fell off the per-model road onto the
        // token's own save, so a destroyed unit rolled a d20 on the fight's
        // dice, could spend its legendary resistance, and the banner claimed
        // 6 bludgeoning. The SRD road puts it through rollUnitArea: 0 inside.
        await setup([CASTER('wurrzag', 'Wurrzag'), MILITIA({ hp: 0, legendaryResistances: 3, autoLegendaryResistance: true })], { presets: ['orruk-waaagh'] });
        fixDice({ 'cast Foot of Gork': [3, 5], 'Foot of Gork damage': [3, 3, 3, 3] });
        const spy = d20s(1);
        const { text, r } = await act({ action: 'cast_spell', actorId: 'wurrzag', spellName: 'Foot of Gork', targetId: 'militia' });
        expect(purposes(spy)).toEqual([]);
        expect(r.saves).toBeUndefined();
        expect(r.unitAreas?.[0]).toMatchObject({ targetId: 'militia', modelsInArea: 0, modelsKilled: 0, hpLost: 0 });
        expect(r.worldSpell.effects[0]).toMatchObject({ targetId: 'militia', damage: 0, hpBefore: 0, hpAfter: 0 });
        expect(r.worldSpell.effects[0]).not.toHaveProperty('save');
        expect(text).not.toMatch(/DEXTERITY save/);
        expect(text).toMatch(/\[WORLD SPELL: Foot of Gork, CAST, DMG: 0,/);
        expect(tok('militia').legendaryResistancesRemaining ?? 3).toBe(3);
        expect(tok('militia').hp).toBe(0);
    });
});

describe('an unmarked world spell hits one model of a unit at most', () => {
    it('Warp Lightning (a bolt, no save) on a unit kills one model at most, and says how to mark a spell as an area', async () => {
        await setup([CASTER('seer', 'Seer'), MILITIA()], { presets: ['skaven-horned-rat'] });
        fixDice({ 'cast Warp Lightning': [3, 4], 'Warp Lightning damage': [5, 6] });
        const { text, r } = await act({ action: 'cast_spell', actorId: 'seer', spellName: 'Warp Lightning', targetId: 'militia' });
        expect(tok('militia').hp).toBe(45);
        expect(r.unitCaps).toEqual([{ targetId: 'militia', name: 'Militia', before: 11, after: 9 }]);
        expect(r.unitAreas).toBeUndefined();
        expect(r.worldSpell.effects[0]).toMatchObject({ rolled: 11, damage: 9, unitCap: { before: 11, after: 9 } });
        expect(text).toMatch(/one model at most: 11 → 9 \(Warp Lightning is not an area: give its spell rule area: \{shape, size\} for an area\)/);
        expect(text).toMatch(/\[WORLD SPELL: Warp Lightning, CAST, DMG: 9,/);
    });

    it('the Dreaded Thirteenth Spell stays single-target: one CON save for the token, one model at most', async () => {
        await setup([CASTER('seer', 'Seer'), MILITIA()], { presets: ['skaven-horned-rat'] });
        fixDice({ 'cast Dreaded Thirteenth Spell': [4, 5], 'Dreaded Thirteenth Spell damage': [5, 5, 5, 5, 5, 5] });
        const spy = d20s(1);
        const { r } = await act({ action: 'cast_spell', actorId: 'seer', spellName: 'Dreaded Thirteenth Spell', targetId: 'militia' });
        expect(r.saves).toHaveLength(1);
        expect(r.unitCaps).toEqual([{ targetId: 'militia', name: 'Militia', before: 30, after: 9 }]);
        expect(tok('militia').hp).toBe(45);
        expect(purposes(spy)).toEqual(['constitution save vs Dreaded Thirteenth Spell']);
    });

    it('modelsInArea on an unmarked world spell is not used, and the note says so', async () => {
        await setup([CASTER('seer', 'Seer'), LINE()], { presets: ['skaven-horned-rat'] });
        fixDice({ 'cast Warp Lightning': [3, 4], 'Warp Lightning damage': [5, 6] });
        // A spaced unit and no area flag: nothing to count, nothing refused.
        const { text, r } = await act({ action: 'cast_spell', actorId: 'seer', spellName: 'Warp Lightning', targetId: 'line', modelsInArea: { line: 4 } });
        expect(r.unitCaps?.[0]).toMatchObject({ before: 11, after: 5 });
        expect(tok('line').hp).toBe(45);
        expect(text).toMatch(/modelsInArea ignored: Warp Lightning has no area flag, so it hits one model of a unit at most/);
        expect(r.worldSpell.notes).toEqual([expect.stringMatching(/^modelsInArea ignored: Warp Lightning has no area flag/)]);
    });
});
