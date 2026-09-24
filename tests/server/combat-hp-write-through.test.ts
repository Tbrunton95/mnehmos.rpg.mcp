import {
    handleCreateEncounter,
    handleGetEncounterState,
    handleAdvanceTurn,
    handleExecuteLairAction,
    clearCombatState
} from '../../src/server/handlers/combat-handlers';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage';

const mockCtx = { sessionId: 'test-session' };

function extractStateJson(responseText: string): any {
    const match = responseText.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/);
    if (!match) throw new Error('Could not extract state JSON from response');
    return JSON.parse(match[1]);
}

/**
 * Combat HP must survive the DB→memory sync.
 *
 * syncParticipantHpFromDb copies characters.hp over the encounter's in-memory
 * HP on every state read and after advance_turn. Damage paths that only touched
 * memory (lair actions, damage-over-time, opportunity attacks, death-save
 * crits) were silently reverted by it, and never reached the characters row.
 */
describe('combat HP write-through', () => {
    let repo: CharacterRepository;
    const heroId = 'hero-write-through';

    beforeEach(() => {
        closeDb();
        repo = new CharacterRepository(getDb(':memory:'));
        clearCombatState();
        const now = new Date().toISOString();
        repo.create({
            id: heroId,
            name: 'Hero',
            stats: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
            hp: 50,
            maxHp: 50,
            ac: 14,
            level: 3,
            createdAt: now,
            updatedAt: now
        } as any);
    });

    afterEach(() => {
        closeDb();
    });

    async function encounterAtLairTurn(): Promise<string> {
        const created = await handleCreateEncounter({
            seed: 'write-through',
            participants: [
                { id: heroId, name: 'Hero', initiative: 25, hp: 50, maxHp: 50, isEnemy: false, conditions: [] },
                { id: 'dragon', name: 'Dragon', initiative: 5, hp: 100, maxHp: 100, isEnemy: true, hasLairActions: true, conditions: [] }
            ]
        }, mockCtx as any);
        const encounterId = created.content[0].text.match(/Encounter ID: (encounter-[^\n\s]+)/)![1];
        // Order is Hero (25) → LAIR (20) → Dragon (5); one advance reaches the lair.
        await handleAdvanceTurn({ encounterId }, mockCtx as any);
        return encounterId;
    }

    it('keeps lair damage in the encounter and writes it to the character row', async () => {
        const encounterId = await encounterAtLairTurn();

        await handleExecuteLairAction({
            encounterId,
            actionDescription: 'The ceiling collapses',
            targetIds: [heroId],
            damage: 7,
            damageType: 'bludgeoning'
        }, mockCtx as any);

        const state = extractStateJson((await handleGetEncounterState({ encounterId }, mockCtx as any)).content[0].text);
        expect(state.participants.find((p: any) => p.id === heroId).hp).toBe(43);
        expect(repo.findById(heroId)!.hp).toBe(43);
    });

    it('does not overwrite an HP change made through character_manage between combat calls', async () => {
        const encounterId = await encounterAtLairTurn();

        await handleExecuteLairAction({
            encounterId,
            actionDescription: 'The ceiling collapses',
            targetIds: [heroId],
            damage: 7
        }, mockCtx as any);

        // Out-of-combat write (character_manage update) lands between calls.
        repo.update(heroId, { hp: 30 });

        await handleAdvanceTurn({ encounterId }, mockCtx as any);

        const state = extractStateJson((await handleGetEncounterState({ encounterId }, mockCtx as any)).content[0].text);
        expect(state.participants.find((p: any) => p.id === heroId).hp).toBe(30);
        expect(repo.findById(heroId)!.hp).toBe(30);
    });
});
