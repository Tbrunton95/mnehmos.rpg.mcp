import { v4 as uuid } from 'uuid';

import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { handleExecuteCombatAction, handleCreateEncounter, handleGetEncounterState, clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { parseDiceTerms } from '../../src/engine/combat/rng.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { resolveSpell } from '../../src/engine/magic/spell-resolver.js';
import { getSpell } from '../../src/engine/magic/spell-database.js';

/**
 * Item 16: spells roll on the encounter's seeded, logged dice. The attack
 * d20 reads the same condition, Dodge and Help modifiers as a weapon attack;
 * debuff spells apply their conditions after each target's own save; healing
 * adds the caster's own casting ability.
 */
const ctx = { sessionId: 'unscoped' };
const act = withOperation('combat_action', (a) => handleExecuteCombatAction(a, ctx as any));
const now = () => new Date().toISOString();

function stateOf(text: string): any {
    const match = text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/);
    if (!match) throw new Error('Could not extract state JSON');
    return JSON.parse(match[1]);
}

function maxDice(notation: string) {
    const terms = parseDiceTerms(notation);
    const rolls: number[] = []; let modifier = 0;
    for (const t of terms) {
        if (t.kind === 'dice') for (let i = 0; i < t.count; i++) rolls.push(t.sign * t.sides);
        else modifier += t.sign * t.value;
    }
    const diceTotal = rolls.reduce((a, b) => a + b, 0);
    return { notation, rolls, diceTotal, modifier, total: diceTotal + modifier };
}

function caster(id: string, cls: string, extra: Record<string, unknown> = {}): any {
    return {
        id, name: `${cls} ${id.slice(0, 4)}`,
        stats: { str: 8, dex: 14, con: 12, int: 18, wis: 8, cha: 18 },
        hp: 30, maxHp: 30, ac: 12, level: 5, characterClass: cls,
        spellSlots: getInitialSpellSlots(cls as any, 5), maxSpellLevel: getMaxSpellLevel(cls as any, 5),
        createdAt: now(), updatedAt: now(), ...extra
    };
}

describe('spells on the encounter dice', () => {
    let repo: CharacterRepository;
    beforeEach(() => { closeDb(); repo = new CharacterRepository(getDb(':memory:')); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    async function encounter(casterId: string, target: Record<string, unknown>, seed = `sed-${uuid()}`, casterPos?: { x: number; y: number }) {
        const created = await handleCreateEncounter({
            seed,
            participants: [
                { id: casterId, name: 'Caster', hp: 30, maxHp: 30, initiative: 20, ...(casterPos ? { position: casterPos } : {}) },
                { hp: 100, maxHp: 100, initiative: 1, isEnemy: true, ...target }
            ]
        }, ctx as any);
        return created.content[0].text.match(/Encounter ID: (encounter-[^\n]+)/)![1] as string;
    }
    const stateFor = async (encounterId: string) => stateOf((await handleGetEncounterState({ encounterId }, ctx as any)).content[0].text);

    it('a spell attack d20 is logged as a spell attack with its target', async () => {
        const id = uuid();
        repo.create(caster(id, 'wizard', { knownSpells: ['Fire Bolt'], cantripsKnown: ['Fire Bolt'] }));
        const encounterId = await encounter(id, { id: 'orc', name: 'Orc' });
        await act({ encounterId, action: 'cast_spell', actorId: id, spellName: 'Fire Bolt', targetId: 'orc' });
        const rolls = queryRolls(getDb(), { encounterId, limit: 50 });
        const attack = rolls.find((r: any) => r.purpose === 'spell attack');
        expect(attack).toMatchObject({ for_id: id, target_id: 'orc' });
        expect((attack as any).dice[0].sides).toBe(20);
    });

    it('a prone target at range rolls the spell attack at disadvantage', async () => {
        const id = uuid();
        repo.create(caster(id, 'wizard', { knownSpells: ['Fire Bolt'], cantripsKnown: ['Fire Bolt'] }));
        const encounterId = await encounter(id, { id: 'orc', name: 'Orc', position: { x: 2, y: 0 }, conditions: ['prone'] }, undefined, { x: 0, y: 0 });
        await act({ encounterId, action: 'cast_spell', actorId: id, spellName: 'Fire Bolt', targetId: 'orc' });
        const attack = queryRolls(getDb(), { encounterId, limit: 50 }).find((r: any) => r.purpose === 'spell attack') as any;
        expect(attack.dice).toHaveLength(2);
    });

    it('Hold Person paralyses on a failed save and not on a pass', async () => {
        const id = uuid();
        repo.create(caster(id, 'wizard', { knownSpells: ['Hold Person'], preparedSpells: ['Hold Person'] }));
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(1);
        const e1 = await encounter(id, { id: 'thug', name: 'Thug' });
        const res = await act({ encounterId: e1, action: 'cast_spell', actorId: id, spellName: 'Hold Person', targetId: 'thug' });
        const result = stateOf(res.content[0].text).actionResult;
        expect(result.conditionsApplied).toEqual([expect.objectContaining({ id: 'thug', condition: 'paralyzed' })]);
        expect((await stateFor(e1)).participants.find((p: any) => p.id === 'thug').conditions).toContain('paralyzed');

        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(20);
        const id2 = uuid();
        repo.create(caster(id2, 'wizard', { knownSpells: ['Hold Person'], preparedSpells: ['Hold Person'] }));
        clearCombatState();
        const e2 = await encounter(id2, { id: 'thug2', name: 'Thug' });
        await act({ encounterId: e2, action: 'cast_spell', actorId: id2, spellName: 'Hold Person', targetId: 'thug2' });
        expect((await stateFor(e2)).participants.find((p: any) => p.id === 'thug2').conditions).not.toContain('paralyzed');
    });

    it('Hex has no save and applies its condition', async () => {
        const id = uuid();
        repo.create(caster(id, 'warlock', { knownSpells: ['Hex'], pactMagicSlots: { current: 2, max: 2, slotLevel: 3 } }));
        const encounterId = await encounter(id, { id: 'mark', name: 'Mark' });
        await act({ encounterId, action: 'cast_spell', actorId: id, spellName: 'Hex', targetId: 'mark' });
        const conds: string[] = (await stateFor(encounterId)).participants.find((p: any) => p.id === 'mark').conditions;
        expect(conds.map(c => c.toLowerCase())).toContain('hexed');
    });

    it("Cure Wounds adds the caster's own casting ability, on the encounter dice", async () => {
        const id = uuid();
        repo.create(caster(id, 'bard', { knownSpells: ['Cure Wounds'] }));
        vi.spyOn(CombatEngine.prototype, 'rollDice').mockImplementation((n: string) => maxDice(n));
        const encounterId = await encounter(id, { id: 'ally', name: 'Ally', hp: 5, maxHp: 30, isEnemy: false });
        await act({ encounterId, action: 'cast_spell', actorId: id, spellName: 'Cure Wounds', targetId: 'ally' });
        // 1d8 max 8 + CHA 18 (+4) = 12, not WIS 8 (-1)
        expect((await stateFor(encounterId)).participants.find((p: any) => p.id === 'ally').hp).toBe(17);
    });

    it('the same seed rolls the same spell damage', async () => {
        const hp: number[] = [];
        for (let i = 0; i < 2; i++) {
            const id = uuid();
            repo.create(caster(id, 'wizard', { knownSpells: ['Fireball'], preparedSpells: ['Fireball'] }));
            clearCombatState();
            const encounterId = await encounter(id, { id: `dummy${i}`, name: 'Dummy' }, 'same-seed-fireball');
            await act({ encounterId, action: 'cast_spell', actorId: id, spellName: 'Fireball', targetId: `dummy${i}` });
            hp.push((await stateFor(encounterId)).participants.find((p: any) => p.id === `dummy${i}`).hp);
        }
        expect(hp[0]).toBe(hp[1]);
        expect(hp[0]).toBeLessThan(100);
    });
});

describe('resolveSpell with injected dice', () => {
    const wiz = (extra: Record<string, unknown> = {}): any => ({
        id: 'w', name: 'W', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
        hp: 30, maxHp: 30, ac: 12, level: 5, characterClass: 'wizard', ...extra
    });
    const dice = (natural: number) => ({
        d20: vi.fn(() => ({ natural, rolls: [natural] })),
        roll: vi.fn((n: string) => { const m = maxDice(n); return { total: m.total, rolls: m.rolls }; })
    });

    it('a spellAttackBonus of 0 is respected, not replaced by the computed bonus', () => {
        const d = dice(10);
        const zero = resolveSpell(getSpell('Fire Bolt')!, wiz({ spellAttackBonus: 0 }), 0, { targetAC: 11, dice: d });
        expect(zero.hit).toBe(false);
        const computed = resolveSpell(getSpell('Fire Bolt')!, wiz(), 0, { targetAC: 11, dice: dice(10) });
        expect(computed.hit).toBe(true);
    });

    it('rolls damage and magic missile through the injected roller', () => {
        const d = dice(15);
        const r = resolveSpell(getSpell('Magic Missile')!, wiz(), 1, { dice: d });
        expect(d.roll).toHaveBeenCalledWith('3d4+3', expect.any(String));
        expect(r.damage).toBe(15);
    });

    it('with perTargetSaves the resolver rolls no save of its own', () => {
        const d = dice(15);
        const r = resolveSpell(getSpell('Fireball')!, wiz(), 3, { dice: d, perTargetSaves: true });
        expect(d.d20).not.toHaveBeenCalled();
        expect(r.damageRolled).toBe(48);
        const hold = resolveSpell(getSpell('Hold Person')!, wiz(), 2, { dice: d, perTargetSaves: true });
        expect(hold.conditionsApplied).toBeUndefined();
    });
});
