import { handleExecuteCombatAction, handleCreateEncounter, handleGetEncounterState, clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleTableRules, TableRulesTool } from '../../src/server/consolidated/table-rules.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { parseRuleSpec } from '../../src/engine/table-rules.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { computeCastingTotal } from '../../src/server/handlers/world-spell.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { getCombatManager } from '../../src/server/state/combat-manager.js';

/**
 * Item 9: world spells. A `spell` rule casts on a casting roll (2d6 by
 * default) against a target, pays signed pool costs, can be unbound, applies
 * its effects on the encounter's dice and rolls a miscast table on a double,
 * a failure or a fumble. It spends no slots; an SRD spell still does.
 */
const W = 'warp-world';
const ctx = { sessionId: 'unscoped' };
const act = withOperation('combat_action', (a) => handleExecuteCombatAction(a, ctx as any));
const consolidated = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
const rules = withOperation('table_rules', async (args: Record<string, unknown>) => handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...args }), ctx as any));
const define = (kind: string, name: string, spec: unknown) => rules({ action: 'define', kind, name, spec });
const now = () => new Date().toISOString();
const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;

function stateOf(text: string): any {
    const match = text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/);
    if (!match) throw new Error(`Could not extract state JSON from: ${text}`);
    return JSON.parse(match[1]);
}

/** Fix the casting dice (tags starting 'cast ' / 'unbind '); every other roll stays live and logged. */
function fixCasting(rolls: Record<string, number[]>) {
    const orig = CombatEngine.prototype.rollDice;
    vi.spyOn(CombatEngine.prototype, 'rollDice').mockImplementation(function (this: CombatEngine, notation: string, tag: any) {
        const key = Object.keys(rolls).find(k => tag.purpose.startsWith(k));
        if (key) {
            const r = rolls[key];
            const total = r.reduce((a, b) => a + b, 0);
            return { notation, rolls: r, diceTotal: total, modifier: 0, total };
        }
        return orig.call(this, notation, tag);
    });
}

function mkChar(id: string, extra: Record<string, unknown> = {}) {
    new CharacterRepository(getDb()).create({
        id, name: id[0].toUpperCase() + id.slice(1), characterType: 'pc', characterClass: 'wizard',
        stats: { str: 10, dex: 10, con: 12, int: 16, wis: 10, cha: 10 }, hp: 30, maxHp: 30, ac: 12, level: 5,
        spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: getMaxSpellLevel('wizard' as any, 5),
        knownSpells: ['Fireball'], preparedSpells: ['Fireball'],
        resourcePools: { warp: { current: 0, max: 10 }, wind: { current: 5, max: 10 } },
        createdAt: now(), updatedAt: now(), ...extra
    } as any);
    getDb().prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(W, id);
}

async function encounter(extra: any[] = []) {
    const created = await handleCreateEncounter({
        seed: `ws-${Math.random()}`,
        participants: [
            { id: 'lex', name: 'Lex', hp: 30, maxHp: 30, initiative: 20 },
            { id: 'orc', name: 'Orc', hp: 40, maxHp: 40, initiative: 1, isEnemy: true, abilityScores: { strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 } },
            ...extra
        ]
    }, ctx as any);
    return created.content[0].text.match(/Encounter ID: (encounter-[^\n]+)/)![1] as string;
}

const hpOf = async (encounterId: string, id: string) =>
    stateOf((await handleGetEncounterState({ encounterId }, ctx as any)).content[0].text).participants.find((p: any) => p.id === id).hp;

beforeEach(async () => {
    closeDb(); clearCombatState();
    const db = getDb(':memory:');
    new WorldRepository(db).create({ id: W, name: 'Warp', seed: 's', width: 10, height: 10, createdAt: now(), updatedAt: now() } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    mkChar('lex');
    await define('roll_table', 'Perils', { dice: '1d6', entries: [
        { min: 1, max: 6, text: 'The warp bites', apply: { writes: [{ op: 'adjust_pool', pool: 'warp', delta: 2 }] } }
    ] });
    await define('spell', 'Smite', {
        castingRoll: { target: 5, ability: 'int' },
        cost: [{ pool: 'warp', delta: 1 }],
        effects: [{ type: 'damage', dice: '2d6', damageType: 'force' }],
        miscast: { on: 'double', table: 'Perils' }
    });
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('the spell kind', () => {
    it('fills its defaults', () => {
        const s = parseRuleSpec('spell', { castingRoll: { target: 7 }, effects: [{ type: 'damage', dice: '1d6' }] }) as any;
        expect(s.castingRoll).toMatchObject({ dice: '2d6', modifier: 0, target: 7 });
        expect(s.cost).toEqual([]);
        expect(s.known).toBe(true);
        expect(s.effects[0]).toMatchObject({ saveEffect: 'none', target: 'target' });
        expect(() => parseRuleSpec('spell', { miscast: { on: 'always', table: 'x' } })).toThrow();
        expect(() => parseRuleSpec('spell', { effects: [{ type: 'explode' }] })).toThrow();
    });
});

describe('computeCastingTotal', () => {
    it('adds the modifier and ability to the dice, part by part', () => {
        const engine = { rollDice: () => ({ notation: '2d6', rolls: [2, 5], diceTotal: 7, modifier: 0, total: 7 }) } as any;
        const r = computeCastingTotal(engine, { dice: '2d6', modifier: 1, ability: 'int', target: 7 } as any, { id: 'lex', name: 'Lex' } as any, { stats: { int: 16 } } as any, 'cast Smite');
        expect(r).toMatchObject({ dice: '2d6', rolls: [2, 5], modifier: 4, total: 11 });
        expect(r.parts).toEqual(['2d6 (2+5)', 'modifier +1', 'INT +3']);
    });
});

describe('castWorldSpell', () => {
    it('a double rolls Perils on the encounter dice, pays warp and spends no slot', async () => {
        fixCasting({ 'cast ': [3, 3] });
        const encounterId = await encounter();
        const slotsBefore = JSON.stringify(sheet('lex').spellSlots);
        const res = await act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'smite', targetId: 'orc' });
        const text = res.content[0].text;
        const ar = stateOf(text).actionResult;
        expect(ar.worldSpell.casting).toMatchObject({ rolls: [3, 3], total: 9, target: 5, success: true, double: true });
        expect(ar.worldSpell.miscast).toMatchObject({ table: 'Perils', on: 'double' });
        expect(text).toMatch(/Perils/);
        const perils = queryRolls(getDb(), { encounterId, limit: 50 }).find((r: any) => r.purpose === 'table Perils') as any;
        expect(perils).toBeDefined();
        expect(perils.encounter_id).toBe(encounterId);
        // +1 cost, +2 Perils; the cost is in the pool history
        const warp = sheet('lex').resourcePools.warp;
        expect(warp.current).toBe(3);
        expect(warp.history.some((h: any) => /cast Smite/.test(h.reason) && h.delta === 1)).toBe(true);
        expect(JSON.stringify(sheet('lex').spellSlots)).toBe(slotsBefore);
        expect(await hpOf(encounterId, 'orc')).toBeLessThan(40);
    });

    it('logs the casting roll with the encounter', async () => {
        const encounterId = await encounter();
        await act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Smite', targetId: 'orc' });
        const cast = queryRolls(getDb(), { encounterId, limit: 50 }).find((r: any) => r.purpose === 'cast Smite') as any;
        expect(cast).toMatchObject({ for_id: 'lex', encounter_id: encounterId });
    });

    it('a failed cast still pays and lands nothing', async () => {
        await define('spell', 'Gust', { castingRoll: { target: 10 }, cost: [{ pool: 'wind', delta: -2 }], effects: [{ type: 'damage', dice: '3d6' }] });
        fixCasting({ 'cast ': [1, 2] });
        const encounterId = await encounter();
        const res = await act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Gust', targetId: 'orc' });
        const ar = stateOf(res.content[0].text).actionResult;
        expect(ar.success).toBe(false);
        expect(ar.worldSpell.casting.success).toBe(false);
        expect(sheet('lex').resourcePools.wind.current).toBe(3);
        expect(await hpOf(encounterId, 'orc')).toBe(40);
    });

    it('a cost the caster cannot pay is refused and nothing is written', async () => {
        await define('spell', 'Storm', { castingRoll: { target: 5 }, cost: [{ pool: 'wind', delta: -6 }], effects: [{ type: 'damage', dice: '3d6' }] });
        const encounterId = await encounter();
        await expect(act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Storm', targetId: 'orc' })).rejects.toThrow(/wind/);
        expect(sheet('lex').resourcePools.wind.current).toBe(5);
        expect(queryRolls(getDb(), { encounterId, limit: 50 }).some((r: any) => r.purpose === 'cast Storm')).toBe(false);
    });

    it('a spell the caster does not know is refused and rolled back', async () => {
        await define('spell', 'Secret Fire', { known: false, castingRoll: { target: 5 }, cost: [{ pool: 'warp', delta: 1 }], effects: [{ type: 'damage', dice: '3d6' }] });
        const encounterId = await encounter();
        await expect(act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Secret Fire', targetId: 'orc' })).rejects.toThrow(/does not know/);
        expect(sheet('lex').resourcePools.warp.current).toBe(0);
        // Once learned it casts.
        new CharacterRepository(getDb()).update('lex', { knownSpells: ['Fireball', 'secret fire'] } as any);
        const res = await act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Secret Fire', targetId: 'orc' });
        expect(stateOf(res.content[0].text).actionResult.worldSpell).toBeDefined();
    });

    it('an incapacitated caster cannot cast', async () => {
        const encounterId = await encounter();
        const engine = getCombatManager().get(`${ctx.sessionId}:${encounterId}`)!;
        engine.applyCondition('lex', { type: 'stunned' as any, durationType: 'permanent' as any });
        new EncounterRepository(getDb()).saveState(encounterId, engine.getState()!);
        await expect(act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Smite', targetId: 'orc' })).rejects.toThrow(/incapacitated/i);
        expect(sheet('lex').resourcePools.warp.current).toBe(0);
    });

    it('a save against the casting total halves the damage', async () => {
        await define('spell', 'Firestorm', { castingRoll: { target: 5 }, effects: [{ type: 'damage', dice: '4d6', save: { ability: 'dex' }, saveEffect: 'half' }] });
        fixCasting({ 'cast ': [6, 5], 'Firestorm': [6, 6, 6, 6] });
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(20);
        const encounterId = await encounter();
        const res = await act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Firestorm', targetId: 'orc' });
        const ar = stateOf(res.content[0].text).actionResult;
        expect(ar.worldSpell.effects[0]).toMatchObject({ targetId: 'orc', rolled: 24, saved: true, dc: 11, damage: 12 });
        expect(await hpOf(encounterId, 'orc')).toBe(28);
    });

    it('a condition effect lands on a failed save; a pool effect moves the target pool', async () => {
        mkChar('vex', { resourcePools: { faith: { current: 4, max: 10 } } });
        await define('spell', 'Doom', { castingRoll: { target: 5 }, effects: [
            { type: 'condition', condition: 'frightened', duration: 2, save: { ability: 'wis', dc: 12 } },
            { type: 'pool', pool: 'faith', delta: -1 },
            { type: 'pool', pool: 'warp', delta: 1, target: 'caster' }
        ] });
        fixCasting({ 'cast ': [6, 5] });
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(2);
        const encounterId = await encounter([{ id: 'vex', name: 'Vex', hp: 30, maxHp: 30, initiative: 2, isEnemy: true }]);
        await act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Doom', targetId: 'vex' });
        const st = stateOf((await handleGetEncounterState({ encounterId }, ctx as any)).content[0].text);
        expect(st.participants.find((p: any) => p.id === 'vex').conditions.map((c: string) => c.toLowerCase())).toContain('frightened');
        expect(sheet('vex').resourcePools.faith.current).toBe(3);
        expect(sheet('lex').resourcePools.warp.current).toBe(1);
    });

    it('an unbinder who beats the casting total stops the spell', async () => {
        mkChar('shaman');
        await define('spell', 'Bolt', { castingRoll: { target: 5 }, contestedBy: 'unbind', effects: [{ type: 'damage', dice: '2d6' }] });
        fixCasting({ 'cast ': [5, 4], 'unbind ': [6, 5] });
        const encounterId = await encounter([{ id: 'shaman', name: 'Shaman', hp: 30, maxHp: 30, initiative: 2, isEnemy: true }]);
        const res = await consolidated({ action: 'cast_spell', encounterId, actorId: 'lex', spellName: 'Bolt', targetId: 'orc', unbinderId: 'shaman' });
        const text = res.content[0].text;
        expect(text).toMatch(/unbound/i);
        expect(await hpOf(encounterId, 'orc')).toBe(40);
    });

    it('an unbinder who falls short lets it through', async () => {
        mkChar('shaman');
        await define('spell', 'Bolt', { castingRoll: { target: 5 }, contestedBy: 'unbind', effects: [{ type: 'damage', dice: '2d6' }] });
        fixCasting({ 'cast ': [5, 4], 'unbind ': [1, 2] });
        const encounterId = await encounter([{ id: 'shaman', name: 'Shaman', hp: 30, maxHp: 30, initiative: 2, isEnemy: true }]);
        const res = await act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Bolt', targetId: 'orc', unbinderId: 'shaman' });
        const ar = stateOf(res.content[0].text).actionResult;
        expect(ar.worldSpell.unbind).toMatchObject({ unbinderId: 'shaman', total: 3, unbound: false });
        expect(await hpOf(encounterId, 'orc')).toBeLessThan(40);
    });

    it('an unbinderId on a spell that cannot be unbound is refused', async () => {
        const encounterId = await encounter();
        await expect(act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Smite', targetId: 'orc', unbinderId: 'orc' })).rejects.toThrow(/unbind/);
    });

    it('spends the action', async () => {
        const encounterId = await encounter();
        await act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Smite', targetId: 'orc' });
        await expect(act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Smite', targetId: 'orc' })).rejects.toThrow(/Action already used/);
    });

    it('an SRD Fireball in the same world still uses a slot', async () => {
        const encounterId = await encounter();
        const before = sheet('lex').spellSlots.level3.current;
        await act({ encounterId, action: 'cast_spell', actorId: 'lex', spellName: 'Fireball', targetId: 'orc' });
        expect(sheet('lex').spellSlots.level3.current).toBe(before - 1);
    });
});
