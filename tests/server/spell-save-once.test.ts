import { v4 as uuid } from 'uuid';

import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { handleExecuteCombatAction, handleCreateEncounter, handleGetEncounterState, clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';

const ctx = { sessionId: 'test-session' };

function stateOf(text: string): any {
    const match = text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/);
    if (!match) throw new Error('Could not extract state JSON');
    return JSON.parse(match[1]);
}

/**
 * A save spell must roll each target's save once, against the full rolled
 * damage. spell-resolver rolled its own unmodified save and halved (or
 * zeroed) resolution.damage; the handler then rolled every target's save
 * again on that already-reduced number.
 */
describe('spell saves are rolled once per target', () => {
    let charRepo: CharacterRepository;

    beforeEach(() => {
        closeDb();
        charRepo = new CharacterRepository(getDb(':memory:'));
        clearCombatState();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        closeDb();
    });

    it('halves Fireball once when the target saves', async () => {
        const wizardId = uuid();
        const now = new Date().toISOString();
        charRepo.create({
            id: wizardId,
            name: 'Evoker',
            stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
            hp: 30, maxHp: 30, ac: 12, level: 5,
            characterClass: 'wizard',
            knownSpells: ['Fireball'], preparedSpells: ['Fireball'], cantripsKnown: [],
            spellSlots: getInitialSpellSlots('wizard', 5),
            maxSpellLevel: getMaxSpellLevel('wizard', 5),
            createdAt: now, updatedAt: now
        } as any);

        const created = await handleCreateEncounter({
            seed: `save-once-${uuid()}`,
            participants: [
                { id: wizardId, name: 'Evoker', hp: 30, maxHp: 30, initiativeBonus: 0 },
                { id: 'dummy-target', name: 'Training Dummy', hp: 100, maxHp: 100, initiativeBonus: 0 }
            ]
        }, ctx as any);
        const encounterId = created.content[0].text.match(/Encounter ID: (encounter-[^\n]+)/)![1];

        // Every die rolls its maximum: 8d6 = 48 fire, every d20 = 20 (save passes).
        vi.spyOn(Math, 'random').mockReturnValue(0.99);
        // The save rolls on the encounter's seeded stream now.
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(20);

        await handleExecuteCombatAction({
            encounterId,
            action: 'cast_spell',
            actorId: wizardId,
            spellName: 'Fireball',
            targetId: 'dummy-target'
        }, ctx as any);

        const state = stateOf((await handleGetEncounterState({ encounterId }, ctx as any)).content[0].text);
        const dummy = state.participants.find((p: any) => p.id === 'dummy-target');
        expect(dummy.hp).toBe(100 - 24);
    });
});
