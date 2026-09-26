import { v4 as uuid } from 'uuid';

import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { handleExecuteCombatAction, handleCreateEncounter, handleGetEncounterState, clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { parseDiceTerms } from '../../src/engine/combat/rng.js';

function maxDice(notation: string) {
    const rolls: number[] = []; let modifier = 0;
    for (const t of parseDiceTerms(notation)) {
        if (t.kind === 'dice') for (let i = 0; i < t.count; i++) rolls.push(t.sign * t.sides);
        else modifier += t.sign * t.value;
    }
    const diceTotal = rolls.reduce((a, b) => a + b, 0);
    return { notation, rolls, diceTotal, modifier, total: diceTotal + modifier };
}
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { resolveSpell } from '../../src/engine/magic/spell-resolver.js';
import { getSpell } from '../../src/engine/magic/spell-database.js';

const ctx = { sessionId: 'spell-crits' };

function stateOf(text: string): any {
    const match = text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/);
    if (!match) throw new Error('Could not extract state JSON');
    return JSON.parse(match[1]);
}

function wizard(id: string): any {
    const now = new Date().toISOString();
    return {
        id, name: 'Evoker',
        stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
        hp: 30, maxHp: 30, ac: 12, level: 5, characterClass: 'wizard',
        knownSpells: ['Fireball', 'Fire Bolt'], preparedSpells: ['Fireball'], cantripsKnown: ['Fire Bolt'],
        spellSlots: getInitialSpellSlots('wizard', 5), maxSpellLevel: getMaxSpellLevel('wizard', 5),
        createdAt: now, updatedAt: now
    };
}

/**
 * Audit: spell attacks had no natural 20 or natural 1 (a +7 caster hit AC 1
 * on a 1 and never crit), and cast_spell applied raw damage, ignoring the
 * target's resistances, immunities and vulnerabilities.
 */
describe('spell attack crits', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a natural 20 hits any AC and doubles the damage dice', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.99);
        const r = resolveSpell(getSpell('Fire Bolt')!, wizard('w'), 0, { targetAC: 99 });
        expect(r.attackRoll).toBe(20);
        expect(r.hit).toBe(true);
        expect(r.critical).toBe(true);
        // Level 5 Fire Bolt is 2d10; a crit rolls 4d10, all tens here.
        expect(r.damage).toBe(40);
    });

    it('a natural 1 misses any AC', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const r = resolveSpell(getSpell('Fire Bolt')!, wizard('w'), 0, { targetAC: 1 });
        expect(r.attackRoll).toBe(1);
        expect(r.hit).toBe(false);
        expect(r.damage).toBe(0);
    });
});

describe('cast_spell damage modifiers', () => {
    let charRepo: CharacterRepository;
    beforeEach(() => {
        closeDb();
        charRepo = new CharacterRepository(getDb(':memory:'));
        clearCombatState();
    });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    async function fireball(targetExtras: Record<string, unknown>): Promise<number> {
        const wizardId = uuid();
        charRepo.create(wizard(wizardId));
        const created = await handleCreateEncounter({
            seed: `mods-${uuid()}`,
            participants: [
                { id: wizardId, name: 'Evoker', hp: 30, maxHp: 30, initiativeBonus: 0 },
                { id: 'dummy', name: 'Dummy', hp: 100, maxHp: 100, initiativeBonus: 0, ...targetExtras }
            ]
        }, ctx as any);
        const encounterId = created.content[0].text.match(/Encounter ID: (encounter-[^\n]+)/)![1];
        // 8d6 all sixes = 48 fire; every d20 = 20, so the save passes: 24.
        // Spell damage rolls on the encounter's dice: every die at its maximum.
        vi.spyOn(CombatEngine.prototype, 'rollDice').mockImplementation((n: string) => maxDice(n));
        // The save rolls on the encounter's seeded stream now.
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(20);
        await handleExecuteCombatAction({ encounterId, action: 'cast_spell', actorId: wizardId, spellName: 'Fireball', targetId: 'dummy' }, ctx as any);
        const state = stateOf((await handleGetEncounterState({ encounterId }, ctx as any)).content[0].text);
        return state.participants.find((p: any) => p.id === 'dummy').hp;
    }

    it('halves again for fire resistance', async () => {
        expect(await fireball({ resistances: ['fire'] })).toBe(100 - 12);
    });

    it('takes nothing when immune', async () => {
        expect(await fireball({ immunities: ['fire'] })).toBe(100);
    });

    it('doubles when vulnerable', async () => {
        expect(await fireball({ vulnerabilities: ['fire'] })).toBe(100 - 48);
    });
});
