import { handleTableRules, TableRulesTool } from '../../src/server/consolidated/table-rules.js';
import { handleSessionManage } from '../../src/server/consolidated/session-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../src/server/consolidated/character-manage.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { handleKnowledgeManage } from '../../src/server/consolidated/knowledge-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { AgentRepository } from '../../src/storage/repos/agent.repo.js';
import { ConcentrationRepository } from '../../src/storage/repos/concentration.repo.js';
import { InventoryRepository } from '../../src/storage/repos/inventory.repo.js';
import { NpcMemoryRepository } from '../../src/storage/repos/npc-memory.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { RULE_PRESETS } from '../../src/data/table-rules/day-366.js';
import { SKAVEN_HORNED_RAT_PRESET } from '../../src/data/table-rules/skaven-horned-rat.js';
import { listRules, parseRuleSpec, type RuleKind } from '../../src/engine/table-rules.js';
import { applyGrowth, crossesStep } from '../../src/server/growth.js';
import { composePrompt } from '../../src/agent/prompt/compose.js';
import { buildKnowledgeSlice, KNOWLEDGE_CLOSING } from '../../src/agent/prompt/slices/knowledge.js';

/**
 * The 'skaven-horned-rat' preset (Age of Sigmar): the band ladder, the
 * favour family, Skaven and the Grey Seer, Verminlord forms on the Ascension
 * track, the Warpstone Hunger ladder with auto rungs, the bestiary, four
 * tables and the Lore of Ruin; plus the generic extensions it leans on
 * (auto growth steps, growth on spell costs and boosts, set_unit reinforce,
 * the agent knowledge slice).
 */
const W = 'skavenblight';
const ctx = { sessionId: 'skaven' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx as any));
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const combat = async (a: Record<string, unknown>) => json(await handleCombatManage(a, ctx as any));
const know = async (a: Record<string, unknown>) => json(await handleKnowledgeManage({ worldId: W, ...a }, ctx as any));
const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
const actionResult = (text: string) => JSON.parse(text.match(/<!-- COMBAT_ACTION_JSON\n([\s\S]*?)\nCOMBAT_ACTION_JSON -->/)![1]).actionResult;
const cast = withOperation('combat_action', (a: any) => handleCombatAction(CombatActionTool.inputSchema.parse(a), ctx as any));

function mkSeer(id: string, pools: Record<string, { current: number; max: number }>, extra: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    new CharacterRepository(getDb()).create({
        id, name: id, characterType: 'pc', characterClass: 'grey_seer', race: 'skaven', band: 'Grey Seer', level: 7,
        stats: { str: 8, dex: 14, con: 10, int: 18, wis: 14, cha: 12 }, hp: 60, maxHp: 60, ac: 14,
        resourcePools: pools, createdAt: now, updatedAt: now, ...extra
    } as any);
    getDb().prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(W, id);
}

beforeEach(async () => {
    closeDb(); clearCombatState();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Skavenblight', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('the skaven-horned-rat preset', () => {
    it('is registered, listed in the tool description, and every entry parses', () => {
        expect(RULE_PRESETS['skaven-horned-rat']).toBe(SKAVEN_HORNED_RAT_PRESET);
        for (const e of SKAVEN_HORNED_RAT_PRESET) {
            try { parseRuleSpec(e.kind as RuleKind, e.spec); } catch (err) { throw new Error(`${e.name}: ${(err as Error).message}`); }
        }
        expect(TableRulesTool.description).toMatch(/skaven-horned-rat/);
        const names = new Set(SKAVEN_HORNED_RAT_PRESET.map(e => e.name));
        expect(names.size).toBe(SKAVEN_HORNED_RAT_PRESET.length);
        // Every form a track names, every table a spell or a step names, and every chain exists.
        const creatures = SKAVEN_HORNED_RAT_PRESET.filter(e => e.kind === 'creature').map(e => e.name);
        const tables = SKAVEN_HORNED_RAT_PRESET.filter(e => e.kind === 'roll_table').map(e => e.name);
        for (const t of SKAVEN_HORNED_RAT_PRESET.filter(e => e.kind === 'growth_track')) {
            for (const s of (t.spec as any).steps) {
                if (s.form) expect(creatures).toContain(s.form);
                if (s.table) expect(tables).toContain(s.table);
            }
        }
        for (const sp of SKAVEN_HORNED_RAT_PRESET.filter(e => e.kind === 'spell')) expect(tables).toContain((sp.spec as any).miscast.table);
        for (const tb of SKAVEN_HORNED_RAT_PRESET.filter(e => e.kind === 'roll_table')) {
            for (const en of (tb.spec as any).entries) if (en.chain) expect(tables).toContain(en.chain);
        }
        const band = parseRuleSpec('band', SKAVEN_HORNED_RAT_PRESET.find(e => e.kind === 'band')!.spec) as any;
        expect(band.order).toEqual(['Clanrat', 'Stormvermin', 'Packmaster', 'Warlock Engineer', 'Grey Seer', 'Verminlord', 'Horned Rat']);
        expect(band.damageScale).toMatchObject({ perStepBelow: 0.5, perStepAbove: 1.25, floor: 0.25, cap: 2 });
        const hunger = parseRuleSpec('growth_track', SKAVEN_HORNED_RAT_PRESET.find(e => e.name === 'Warpstone Hunger')!.spec) as any;
        expect(hunger.steps.map((s: any) => [s.at, s.auto, s.condition?.name ?? s.table ?? s.form])).toEqual([[3, true, 'Twitching'], [6, true, 'Burning Eyes'], [10, true, 'Mutation'], [15, true, 'Rat-Thing']]);
        expect(hunger.direction).toBe('up');
    });

    it('imports onto a fresh world, and boot counts the data kinds', async () => {
        const r = await rules({ action: 'import', preset: 'skaven-horned-rat' });
        expect(r).toMatchObject({ success: true, created: SKAVEN_HORNED_RAT_PRESET.length, updated: 0 });
        const kinds = new Set(listRules(getDb(), W).map(x => x.kind));
        for (const k of ['band', 'lexicon', 'pool_family', 'species', 'char_class', 'background', 'growth_track', 'creature', 'roll_table', 'spell', 'principle']) expect(kinds.has(k as any)).toBe(true);
        const boot = json(await handleSessionManage({ action: 'boot', worldId: W }, ctx as any));
        expect(boot.tableRules.data).toMatchObject({ growth_track: 2, roll_table: 4, spell: 9, pool_family: 1, species: 1, char_class: 1 });
        expect(boot.tableRules.bestiary).toBe(SKAVEN_HORNED_RAT_PRESET.filter(e => e.kind === 'creature').length);
        expect(boot.tableRules.principles.some((p: string) => /Flee/.test(p))).toBe(true);
        // Importing twice updates, never duplicates.
        expect(await rules({ action: 'import', preset: 'skaven-horned-rat' })).toMatchObject({ created: 0, updated: SKAVEN_HORNED_RAT_PRESET.length });
    });

    it('a Grey Seer is created from the world species, class and background', async () => {
        await rules({ action: 'import', preset: 'skaven-horned-rat' });
        const c = await char({ action: 'create', worldId: W, name: 'Thanquol', race: 'skaven', class: 'grey_seer', background: 'Council whelp', level: 5, provisionEquipment: false, stats: { str: 8, dex: 12, con: 10, int: 17, wis: 14, cha: 12 } });
        const id = c.id ?? c.character?.id ?? c.characterId;
        expect(id).toBeTruthy();
        const s = sheet(id);
        expect(s.race.toLowerCase()).toBe('skaven');
        expect(s.stats.dex).toBe(14);
        expect(s.stats.int).toBe(18);
    });
});

describe('the Warpstone Hunger ladder (auto growth steps)', () => {
    beforeEach(async () => { await rules({ action: 'import', preset: 'skaven-horned-rat' }); });

    it('crossesStep reads direction', () => {
        expect(crossesStep({ at: 3 }, 'up', 2, 3)).toBe('up');
        expect(crossesStep({ at: 3 }, 'up', 3, 4)).toBeNull();
        expect(crossesStep({ at: 3 }, 'up', 4, 2)).toBeNull();
        expect(crossesStep({ at: 3 }, 'down', 3, 2)).toBe('down');
        expect(crossesStep({ at: 3 }, 'down', 2, 3)).toBeNull();
        expect(crossesStep({ at: 3 }, 'both', 4, 1)).toBe('down');
        expect(crossesStep({ at: 3 }, undefined, 0, 10)).toBe('up');
    });

    it('adjust_pool to 3 puts Twitching on the sheet at once, once', async () => {
        mkSeer('seer', { warpstone_taint: { current: 2, max: 100 } });
        const r = await char({ action: 'adjust_pool', characterId: 'seer', pool: 'warpstone_taint', delta: 1 });
        expect(r.growthApplied).toHaveLength(1);
        expect(r.growthApplied[0]).toMatchObject({ track: 'Warpstone Hunger', pool: 'warpstone_taint', at: 3, condition: 'Twitching' });
        expect(r.growthReady).toBeUndefined();
        expect(r.message).toMatch(/GROWTH Warpstone Hunger 3: condition Twitching/);
        const s = sheet('seer');
        expect(s.conditions.map((c: any) => c.name)).toEqual(['Twitching']);
        expect(s.conditions[0].source).toMatch(/Warpstone Hunger 3: Hands shake/);
        expect(s.resourcePools.warpstone_taint.growthApplied).toEqual(['Warpstone Hunger@3']);
        // Down and back up: the rung does not fire twice.
        await char({ action: 'adjust_pool', characterId: 'seer', pool: 'warpstone_taint', delta: -2 });
        const again = await char({ action: 'adjust_pool', characterId: 'seer', pool: 'warpstone_taint', delta: 2 });
        expect(again.growthApplied).toBeUndefined();
        expect(sheet('seer').conditions).toHaveLength(1);
    });

    it('a jump across several rungs fires them in order; the table rung rolls Mutation with a seed', async () => {
        mkSeer('seer', { warpstone_taint: { current: 0, max: 100 } });
        const r = await char({ action: 'adjust_pool', characterId: 'seer', pool: 'warpstone_taint', delta: 7 });
        expect(r.growthApplied.map((a: any) => a.at)).toEqual([3, 6]);
        expect(sheet('seer').conditions.map((c: any) => c.name)).toEqual(['Twitching', 'Burning Eyes']);

        // The pool is written first, then the step fires: a direct call with a seed is replayable.
        new CharacterRepository(getDb()).update('seer', { resourcePools: { warpstone_taint: { current: 10, max: 100, growthApplied: ['Warpstone Hunger@3', 'Warpstone Hunger@6'] } } } as any);
        const g = await applyGrowth(getDb(), W, 'seer', 'warpstone_taint', 9, 10, { seed: 'mutation-1' });
        expect(g.growthApplied).toHaveLength(1);
        const step = g.growthApplied![0];
        expect(step).toMatchObject({ track: 'Warpstone Hunger', at: 10 });
        const table = step.table as any;
        expect(table.table).toBe('Mutation');
        expect(table.rolled.dice).toBe('1d6');
        expect(table.entry.index).toBeGreaterThanOrEqual(0);
        expect(table.entry.index).toBeLessThan(6);
        const replay = await applyGrowth(getDb(), W, 'seer', 'warpstone_taint', 9, 10, { seed: 'mutation-1' });
        // Already fired: nothing, and the first roll is on the sheet.
        expect(replay.growthApplied).toBeUndefined();
        expect(sheet('seer').resourcePools.warpstone_taint.growthApplied).toContain('Warpstone Hunger@10');
        // Whatever the die said, the entry applied to the Seer (a gift, a condition, a pool write or a chain).
        const applied = table.applied as any[];
        expect(Array.isArray(table.chained)).toBe(true);
        expect(applied.length + table.chained.length).toBeGreaterThanOrEqual(1);
    });

    it('the top rung takes the Rat-Thing form', async () => {
        mkSeer('seer', { warpstone_taint: { current: 14, max: 100, growthApplied: ['Warpstone Hunger@3', 'Warpstone Hunger@6', 'Warpstone Hunger@10'] } });
        const r = await char({ action: 'adjust_pool', characterId: 'seer', pool: 'warpstone_taint', delta: 1 });
        expect(r.growthApplied[0]).toMatchObject({ at: 15 });
        expect(r.growthApplied[0].form).toMatchObject({ form: 'Rat-Thing', maxHp: 30, ac: 12 });
        expect(sheet('seer').form.name).toBe('Rat-Thing');
    });

    it('a non-auto step is still only offered; a condition offer names its call', async () => {
        mkSeer('seer', { horned_rat_favour: { current: 19, max: 200 } });
        const a = await char({ action: 'adjust_pool', characterId: 'seer', pool: 'horned_rat_favour', delta: 1 });
        expect(a.growthApplied[0]).toMatchObject({ track: 'Ascension', at: 20, condition: 'Grey Seer (ascendant)' });
        const b = await char({ action: 'adjust_pool', characterId: 'seer', pool: 'horned_rat_favour', delta: 30 });
        expect(b.growthApplied).toBeUndefined();
        expect(b.growthReady).toMatchObject({ track: 'Ascension', at: 50, form: 'Verminlord Warpseer' });
        expect(b.growthReady.call).toMatch(/set_form/);
        expect(sheet('seer').form).toBeUndefined();
        await rules({ action: 'define', kind: 'growth_track', name: 'Offered Hunger', spec: { pool: 'hunger', steps: [{ at: 2, condition: { name: 'Peckish' } }, { at: 4, table: 'Mutation' }] } });
        const c = await char({ action: 'adjust_pool', characterId: 'seer', pool: 'hunger', delta: 2 });
        expect(c.growthReady).toMatchObject({ track: 'Offered Hunger', at: 2, condition: { name: 'Peckish' } });
        expect(c.growthReady.call).toMatch(/Peckish/);
        expect(sheet('seer').conditions.some((x: any) => x.name === 'Peckish')).toBe(false);
        const d = await char({ action: 'adjust_pool', characterId: 'seer', pool: 'hunger', delta: 2 });
        expect(d.growthReady).toMatchObject({ at: 4, table: 'Mutation' });
        expect(d.growthReady.call).toMatch(/table_rules roll/);
    });

    it('a step needs form, condition or table', () => {
        expect(() => parseRuleSpec('growth_track', { pool: 'x', steps: [{ at: 1 }] })).toThrow(/form, condition or table/);
        expect(() => parseRuleSpec('growth_track', { pool: 'x', steps: [{ at: 1, condition: { name: 'Shaky' } }], direction: 'sideways' })).toThrow();
    });
});

describe('casting with warpstone', () => {
    let seer: string;
    let enc: string;
    beforeEach(async () => {
        await rules({ action: 'import', preset: 'skaven-horned-rat' });
        seer = 'thanquol';
        mkSeer(seer, { warpstone: { current: 3, max: 13 }, warpstone_taint: { current: 2, max: 100 }, horned_rat_favour: { current: 0, max: 200 } });
        const created = await combat({ action: 'create', worldId: W, seed: 'warp-1', participants: [
            { id: seer, name: 'Thanquol', hp: 60, maxHp: 60, initiative: 30, position: { x: 0, y: 0 }, abilityScores: { strength: 8, dexterity: 14, constitution: 10, intelligence: 18, wisdom: 14, charisma: 12 } },
            { id: 'duardin', name: 'Duardin', hp: 80, maxHp: 80, ac: 16, isEnemy: true, initiative: 1, position: { x: 4, y: 0 }, abilityScores: { strength: 14, dexterity: 10, constitution: 16, intelligence: 10, wisdom: 12, charisma: 10 } }
        ] });
        enc = created.encounterId;
    });

    it('a boost spends warpstone, adds the modifier and extra dice to the casting roll, and climbs the taint ladder', async () => {
        const text = (await cast({ action: 'cast_spell', encounterId: enc, actorId: seer, spellName: 'Warp Lightning', targetId: 'duardin',
            boost: { pool: 'warpstone', delta: -1, modifier: 2, extraDice: '1d6', sideEffect: [{ pool: 'warpstone_taint', delta: 1 }] } })).content[0].text;
        const ar = actionResult(text);
        const ws = ar.worldSpell;
        expect(ws.boost).toMatchObject({ pool: 'warpstone', delta: -1, modifier: 2, extraDice: '1d6' });
        expect(ws.boost.extraRolls).toHaveLength(1);
        expect(ws.boost.bonus).toBe(2 + ws.boost.extraRolls[0]);
        // INT 18 → +4, the boost's modifier +2 and its die all add to the 2d6.
        const c = ws.casting;
        expect(c.total).toBe(c.rolls[0] + c.rolls[1] + 4 + ws.boost.bonus);
        expect(c.parts.some((p: string) => /boost 1d6/.test(p))).toBe(true);
        expect(c.parts).toContain('boost +2');
        const s = sheet(seer);
        expect(s.resourcePools.warpstone.current).toBe(2);
        // Taint 2 → 3 by the side effect (a double's miscast may add 2 more on top).
        expect(s.resourcePools.warpstone_taint.current).toBe(ws.miscast ? 3 + (ws.miscast.applied?.some((a: any) => a.writes?.some((w: string) => /warpstone_taint/.test(w))) ? 2 : 0) : 3);
        expect(ws.boost.sideEffect).toEqual([expect.stringMatching(/warpstone_taint.*2 → 3/)]);
        // Taint 2 → 3 fires the Twitching rung, on the sheet and on the token.
        expect(ws.growthApplied[0]).toMatchObject({ track: 'Warpstone Hunger', at: 3, condition: 'Twitching' });
        expect(s.conditions.map((x: any) => x.name)).toContain('Twitching');
        const state = await combat({ action: 'get', encounterId: enc });
        const tok = (state.participants ?? state.state?.participants ?? state.encounter?.participants).find((p: any) => p.id === seer);
        expect(tok.conditions.some((x: any) => /twitching/i.test(typeof x === 'string' ? x : (x.type ?? x.name)))).toBe(true);
        expect(text).toMatch(/Boost:/);
        expect(text).toMatch(/GROWTH Warpstone Hunger 3/);
    });

    it('a boost the pool cannot pay is refused before anything is rolled or written', async () => {
        new CharacterRepository(getDb()).update(seer, { resourcePools: { warpstone: { current: 0, max: 13 }, warpstone_taint: { current: 2, max: 100 } } } as any);
        const text = (await cast({ action: 'cast_spell', encounterId: enc, actorId: seer, spellName: 'Warp Lightning', targetId: 'duardin', boost: { pool: 'warpstone', delta: -1, modifier: 2 } })).content[0].text;
        expect(text).toMatch(/cannot pay the boost on Warp Lightning: warpstone 0 is short of 1/);
        expect(sheet(seer).resourcePools.warpstone_taint.current).toBe(2);
        expect(sheet(seer).conditions).toHaveLength(0);
        const bad = (await cast({ action: 'cast_spell', encounterId: enc, actorId: seer, spellName: 'Warp Lightning', targetId: 'duardin', boost: { pool: 'warpstone', delta: -1 } })).content[0].text;
        expect(bad).toMatch(/boost needs modifier and\/or extraDice/);
    });

    it("the (warpstone) variant's cost climbs taint through the growth check", async () => {
        const text = (await cast({ action: 'cast_spell', encounterId: enc, actorId: seer, spellName: 'Warp Lightning (warpstone)', targetId: 'duardin' })).content[0].text;
        const ws = actionResult(text).worldSpell;
        expect(ws.costs).toEqual(expect.arrayContaining([expect.stringMatching(/warpstone/), expect.stringMatching(/warpstone_taint/)]));
        expect(ws.growthApplied[0]).toMatchObject({ at: 3, condition: 'Twitching' });
        const s = sheet(seer);
        expect(s.resourcePools.warpstone.current).toBe(2);
        expect(s.resourcePools.warpstone_taint.current).toBe(3);
        expect(s.conditions.map((x: any) => x.name)).toContain('Twitching');
        // The variant's own +2 rides the casting roll.
        expect(ws.casting.parts).toContain('modifier +2');
        expect(ws.casting.target).toBe(5);
        expect(ws.rule).toBe('Warp Lightning (warpstone)');
    });

    it('a double rolls the Warp Lightning Miscast table with the taint modifier', async () => {
        // Walk seeds until the 2d6 shows a double; the miscast table then rolls on the same stream.
        let found = false;
        for (let i = 0; i < 40 && !found; i++) {
            closeDb(); clearCombatState();
            const db = getDb(':memory:');
            const now = new Date().toISOString();
            new WorldRepository(db).create({ id: W, name: 'Skavenblight', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
            try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
            await rules({ action: 'import', preset: 'skaven-horned-rat' });
            mkSeer(seer, { warpstone_taint: { current: 9, max: 100, growthApplied: ['Warpstone Hunger@3', 'Warpstone Hunger@6'] } });
            const created = await combat({ action: 'create', worldId: W, seed: `double-${i}`, participants: [
                { id: seer, name: 'Thanquol', hp: 60, maxHp: 60, initiative: 30, position: { x: 0, y: 0 } },
                { id: 'duardin', name: 'Duardin', hp: 80, maxHp: 80, ac: 16, isEnemy: true, initiative: 1, position: { x: 4, y: 0 } }
            ] });
            const text = (await cast({ action: 'cast_spell', encounterId: created.encounterId, actorId: seer, spellName: 'Warp Lightning', targetId: 'duardin' })).content[0].text;
            const ws = actionResult(text).worldSpell;
            if (!ws.casting.double) continue;
            found = true;
            expect(ws.miscast).toMatchObject({ on: 'double', table: 'Warp Lightning Miscast' });
            // Taint 9 ÷ 3 = +3 on the 2d6.
            expect(ws.miscast.poolBonus).toMatchObject({ pool: 'warpstone_taint', current: 9, divisor: 3, bonus: 3 });
            expect(ws.miscast.rolled.total).toBe(ws.miscast.rolled.rolls[0] + ws.miscast.rolled.rolls[1] + 3);
            expect(text).toMatch(/MISCAST \(double\)/);
        }
        expect(found).toBe(true);
    });
});

describe('set_unit reinforce', () => {
    it('raising models adds their HP; lowering clamps; hpPerModel moves the maximum', async () => {
        await rules({ action: 'import', preset: 'skaven-horned-rat' });
        const created = await combat({ action: 'create', worldId: W, seed: 'tide-1', participants: [
            { id: 'seer', name: 'Thanquol', hp: 60, maxHp: 60, initiative: 30, position: { x: 0, y: 0 } }
        ] });
        const enc = created.encounterId;
        const add = await combat({ action: 'add_participant', encounterId: enc, creature: 'Clanrat tide', isEnemy: false, position: { x: 2, y: 2 } });
        expect(add.success).toBe(true);
        const tideId = add.participantId ?? add.participants?.[0]?.id ?? add.added?.[0]?.id ?? add.participant?.id;
        expect(tideId).toBeTruthy();
        // Thin the tide to 25 models' worth of HP.
        const thin = await combat({ action: 'adjust_hp', encounterId: enc, participantId: tideId, delta: -60, reason: 'the first volley' });
        expect(thin.error).toBeFalsy();
        const r = await combat({ action: 'set_unit', encounterId: enc, participantId: tideId, models: 50, reason: 'a second tide joins' });
        expect(r.success).toBe(true);
        expect(r.reinforced).toMatchObject({ modelsBefore: 40, models: 50, added: 10, lost: 0, hpPerModel: 4, hpBefore: 100, hp: 140, maxHpBefore: 160, maxHp: 200, liveModels: 35 });
        expect(r.unit.models).toBe(50);
        expect(r.message).toMatch(/models 40 → 50, HP 100 → 140\/200/);
        // Mob rule and breakAt survive the reinforcement.
        expect(r.unit.mobRule).toMatchObject({ per: 10, attackBonusPer: 20 });
        expect(r.unit.breakAt).toBe(0.5);
        const down = await combat({ action: 'set_unit', encounterId: enc, participantId: tideId, models: 20 });
        expect(down.reinforced).toMatchObject({ modelsBefore: 50, models: 20, added: 0, lost: 30, hp: 80, maxHp: 80 });
        const thicker = await combat({ action: 'set_unit', encounterId: enc, participantId: tideId, hpPerModel: 8 });
        expect(thicker.reinforced).toMatchObject({ models: 20, hpPerModel: 8, hp: 80, maxHp: 160 });
        // Persisted: a fresh load reads the new strength.
        clearCombatState();
        const state = await combat({ action: 'get', encounterId: enc });
        const tok = (state.participants ?? state.state?.participants ?? state.encounter?.participants).find((p: any) => p.id === tideId);
        expect(tok.unit).toMatchObject({ models: 20, hpPerModel: 8 });
        expect(tok.maxHp).toBe(160);
        // A non-unit token is refused.
        const no = await combat({ action: 'set_unit', encounterId: enc, participantId: 'seer', models: 3 });
        expect(no.error).toBe(true);
    });
});

describe('the agent knowledge slice', () => {
    function deps() {
        const db = getDb();
        return {
            agentRepo: new AgentRepository(db), characterRepo: new CharacterRepository(db), concentrationRepo: new ConcentrationRepository(db),
            inventoryRepo: new InventoryRepository(db), npcMemoryRepo: new NpcMemoryRepository(db), db
        };
    }

    it('lists what the NPC holds plus the common facts, and closes with the standing order; empty without facts', async () => {
        mkSeer('tesk', {}, { characterType: 'npc' });
        mkSeer('namar', {}, { characterType: 'npc' });
        expect(buildKnowledgeSlice('tesk', getDb())).toBeNull();
        expect(buildKnowledgeSlice('tesk', undefined)).toBeNull();

        await know({ action: 'record', key: 'namar-true-name', statement: "Namar is the Grey Seer's true name", secrecy: 'secret', knowers: [{ id: 'namar', how: 'position' }] });
        await know({ action: 'record', key: 'shard-cache', statement: 'The warpstone cache is under the third gnawhole', secrecy: 'restricted', knowers: [{ id: 'namar', how: 'witnessed' }] });
        await know({ action: 'learn', key: 'shard-cache', knowerId: 'tesk', how: 'told', fromId: 'namar', note: 'overheard at the Council', day: 3 });
        await know({ action: 'record', key: 'council-sits', statement: 'The Council of Thirteen sits at the new moon', secrecy: 'common' });

        const tesk = buildKnowledgeSlice('tesk', getDb())!;
        expect(tesk).toMatch(/--- WHAT YOU KNOW ---/);
        expect(tesk).toMatch(/\[RESTRICTED\] The warpstone cache is under the third gnawhole \(told by namar, overheard at the Council, day 3\)/);
        expect(tesk).toMatch(/The Council of Thirteen sits at the new moon \(common knowledge\)/);
        expect(tesk).not.toMatch(/Namar is the Grey Seer's true name/);
        expect(tesk.endsWith(KNOWLEDGE_CLOSING)).toBe(true);
        expect(KNOWLEDGE_CLOSING).toBe('State nothing beyond this on restricted or secret matters; if asked, deflect in character.');

        const namar = buildKnowledgeSlice('namar', getDb())!;
        expect(namar).toMatch(/\[SECRET\] Namar is the Grey Seer's true name \(position\)/);
        expect(namar.indexOf('[SECRET]')).toBeLessThan(namar.indexOf('[RESTRICTED]'));
        expect(namar.match(/The Council of Thirteen/g)).toHaveLength(1);
    });

    it('composePrompt includes the slice after secrets when deps carry a db, and skips it otherwise', async () => {
        mkSeer('tesk', {}, { characterType: 'npc' });
        const d = deps();
        const agent = d.agentRepo.create({ characterId: 'tesk', provider: 'openai', model: 'gpt-4o-mini' } as any);
        d.agentRepo.addSecret({ agentId: agent.id, content: 'You owe Clan Eshin a tail', importance: 'high' });
        await know({ action: 'record', key: 'shard-cache', statement: 'The warpstone cache is under the third gnawhole', secrecy: 'restricted', knowers: [{ id: 'tesk', how: 'witnessed' }] });

        const withDb = composePrompt({ agentId: agent.id, characterId: 'tesk', situation: 'A rival asks where the shards are.' }, d);
        expect(withDb.slicesIncluded).toContain('knowledge');
        const system = withDb.messages.find(m => m.role === 'system')!.content;
        expect(system).toMatch(/--- WHAT YOU KNOW ---/);
        expect(system).toMatch(/third gnawhole/);
        expect(system).toMatch(/State nothing beyond this on restricted or secret matters/);
        const i = withDb.slicesIncluded;
        if (i.includes('secrets')) expect(i.indexOf('secrets')).toBeLessThan(i.indexOf('knowledge'));
        expect(i.indexOf('knowledge')).toBeLessThan(i.indexOf('character_state'));

        const { db: _db, ...noDb } = d;
        const without = composePrompt({ agentId: agent.id, characterId: 'tesk' }, noDb);
        expect(without.slicesSkipped).toContain('knowledge');
    });
});
