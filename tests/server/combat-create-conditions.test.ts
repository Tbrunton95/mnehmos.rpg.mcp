import {
    handleCreateEncounter,
    handleExecuteCombatAction,
    handleAdvanceTurn,
    clearCombatState
} from '../../src/server/handlers/combat-handlers';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage';

const ctx = { sessionId: 'test-session-create-conditions' };

function encounterIdOf(result: { content: Array<{ text: string }> }): string {
    return result.content[0].text.match(/Encounter ID: (encounter-[^\n\s]+)/)![1];
}

function manageJson(result: { content: Array<{ text: string }> }): any {
    const m = result.content[0].text.match(/<!-- COMBAT_MANAGE_JSON\n([\s\S]*?)\nCOMBAT_MANAGE_JSON -->/);
    return m ? JSON.parse(m[1]) : { error: 'parse_failed', rawText: result.content[0].text };
}

function persistedToken(encounterId: string, id: string): any {
    const row = getDb(':memory:').prepare('SELECT tokens FROM encounters WHERE id = ?').get(encounterId) as { tokens: string };
    return JSON.parse(row.tokens).find((t: any) => t.id === id);
}

/**
 * Encounter participants take conditions at create time, but the engine
 * reads Condition objects ({id, type, durationType, ...}). A bare string like
 * 'prone' reached the engine as-is and either failed the encounter token
 * schema on persist or threw on CONDITION_EFFECTS[c.type] once action economy
 * was checked. Character rows carry {name, duration?, source?} — the shape a
 * caller copies off the sheet — and add_participant dropped them entirely.
 */
describe('encounter conditions at create', () => {
    beforeEach(() => {
        closeDb();
        getDb(':memory:');
        clearCombatState();
    });

    afterEach(() => {
        closeDb();
    });

    const foe = { id: 'foe', name: 'Foe', initiative: 5, hp: 30, maxHp: 30, ac: 10, isEnemy: true };

    it('accepts string conditions and survives attack + advance', async () => {
        const created = await handleCreateEncounter({
            seed: 'cond-string',
            participants: [
                { id: 'hero', name: 'Hero', initiative: 20, hp: 30, maxHp: 30, ac: 10, isEnemy: false, conditions: ['prone'] },
                { ...foe, conditions: ['Poisoned'] }
            ]
        }, ctx);
        const encounterId = encounterIdOf(created);

        await handleExecuteCombatAction({ encounterId, action: 'attack', actorId: 'hero', targetId: 'foe', attackBonus: 5, dc: 10, damage: 1 }, ctx);
        await handleAdvanceTurn({ encounterId }, ctx);
        await handleExecuteCombatAction({ encounterId, action: 'attack', actorId: 'foe', targetId: 'hero', attackBonus: 5, dc: 10, damage: 1 }, ctx);
        await handleAdvanceTurn({ encounterId }, ctx);

        const hero = persistedToken(encounterId, 'hero');
        expect(hero.conditions).toHaveLength(1);
        expect(hero.conditions[0]).toMatchObject({ type: 'prone', durationType: 'permanent' });
        expect(typeof hero.conditions[0].id).toBe('string');
        // Names are matched case-insensitively onto the engine's ConditionType.
        expect(persistedToken(encounterId, 'foe').conditions[0].type).toBe('poisoned');
    });

    it('accepts character-row shaped {name, duration, source} objects', async () => {
        const created = await handleCreateEncounter({
            seed: 'cond-row-shape',
            participants: [
                { id: 'hero', name: 'Hero', initiative: 20, hp: 30, maxHp: 30, ac: 10, isEnemy: false, conditions: [] },
                { ...foe, conditions: [{ name: 'Restrained', duration: 2, source: 'grapple: Hero' }] }
            ]
        }, ctx);
        const encounterId = encounterIdOf(created);

        expect(persistedToken(encounterId, 'foe').conditions[0]).toMatchObject({
            type: 'restrained', durationType: 'rounds', duration: 2, sourceId: 'grapple: Hero'
        });

        // Round-based durations tick at the start of the holder's turn.
        await handleAdvanceTurn({ encounterId }, ctx);
        expect(persistedToken(encounterId, 'foe').conditions[0].duration).toBe(1);
    });

    it('applies the engine mechanics of a normalized condition', async () => {
        const created = await handleCreateEncounter({
            seed: 'cond-stunned',
            participants: [
                { id: 'hero', name: 'Hero', initiative: 20, hp: 30, maxHp: 30, ac: 10, isEnemy: false, conditions: [{ type: 'stunned' }] },
                { ...foe, conditions: [] }
            ]
        }, ctx);
        const encounterId = encounterIdOf(created);

        await expect(handleExecuteCombatAction({
            encounterId, action: 'attack', actorId: 'hero', targetId: 'foe', attackBonus: 5, dc: 10, damage: 1
        }, ctx)).rejects.toThrow(/incapacitated/i);
    });

    it('keeps unknown condition names without crashing the engine', async () => {
        const created = await handleCreateEncounter({
            seed: 'cond-unknown',
            participants: [
                { id: 'hero', name: 'Hero', initiative: 20, hp: 30, maxHp: 30, ac: 10, isEnemy: false, conditions: ['Clinched', { name: 'Blessed by Tyr' }] },
                { ...foe, conditions: [] }
            ]
        }, ctx);
        const encounterId = encounterIdOf(created);

        await handleExecuteCombatAction({ encounterId, action: 'attack', actorId: 'hero', targetId: 'foe', attackBonus: 5, dc: 10, damage: 1 }, ctx);
        await handleAdvanceTurn({ encounterId }, ctx);
        await handleAdvanceTurn({ encounterId }, ctx);

        expect(persistedToken(encounterId, 'hero').conditions.map((c: any) => c.type)).toEqual(['Clinched', 'Blessed by Tyr']);
    });

    it('lets a save-ends condition given at create end on a save', async () => {
        const created = await handleCreateEncounter({
            seed: 'cond-save-ends',
            participants: [
                {
                    id: 'hero', name: 'Hero', initiative: 20, hp: 30, maxHp: 30, ac: 10, isEnemy: false,
                    conditions: [{ type: 'Stunned', durationType: 'SAVE_ENDS', saveDC: 1, saveAbility: 'con' }]
                },
                { ...foe, conditions: [] }
            ]
        }, ctx);
        const encounterId = encounterIdOf(created);

        expect(persistedToken(encounterId, 'hero').conditions[0]).toMatchObject({
            type: 'stunned', durationType: 'save_ends', saveDC: 1, saveAbility: 'constitution'
        });

        // DC 1 with no ability scores: only a natural 1 fails. A condition
        // that silently went permanent would still be there after ten rounds.
        for (let turn = 0; turn < 20 && persistedToken(encounterId, 'hero').conditions.length > 0; turn++) {
            await handleAdvanceTurn({ encounterId }, ctx);
        }
        expect(persistedToken(encounterId, 'hero').conditions).toEqual([]);
    });

    // Each of these used to be accepted and then silently dropped or turned
    // into a permanent condition (the FINDINGS #93/#107 anatomy). They must
    // fail the create instead.
    it.each([
        ['an object with no name or type', { condition: 'Stunned' }],
        ['a blank name', { name: '  ' }],
        ['an unrecognised key', { name: 'Poisoned', rounds: 3 }],
        ['ongoing effects the create lane does not take', { type: 'burning', ongoingEffects: [{ type: 'damage', dice: '1d6', trigger: 'start_of_turn' }] }],
        ['an unknown durationType', { type: 'stunned', durationType: 'until_dawn' }],
        ['an unknown saveAbility', { type: 'stunned', durationType: 'save_ends', saveDC: 12, saveAbility: 'luck' }],
        ['save_ends with no saveDC', { type: 'stunned', durationType: 'save_ends', saveAbility: 'con' }],
        ['save_ends with no saveAbility', { type: 'stunned', durationType: 'save_ends', saveDC: 12 }],
        ['save fields without save_ends', { type: 'stunned', saveDC: 12, saveAbility: 'con' }],
        ['rounds with no duration', { type: 'stunned', durationType: 'rounds' }]
    ])('rejects %s', async (_label, condition) => {
        await expect(handleCreateEncounter({
            seed: 'cond-reject',
            participants: [
                { id: 'hero', name: 'Hero', initiative: 20, hp: 30, maxHp: 30, ac: 10, isEnemy: false, conditions: [condition] },
                { ...foe, conditions: [] }
            ]
        }, ctx)).rejects.toThrow();
        expect(getDb(':memory:').prepare('SELECT COUNT(*) AS n FROM encounters').get()).toEqual({ n: 0 });
    });

    it('combat_manage create reports a nameless condition object instead of dropping it', async () => {
        const data = manageJson(await handleCombatManage({
            action: 'create',
            seed: 'cond-manage-reject',
            participants: [
                { id: 'hero', name: 'Hero', initiative: 20, hp: 30, maxHp: 30, ac: 10, side: 'party', conditions: [{ condition: 'Stunned' }, { label: 'Prone' }] },
                { ...foe, conditions: [] }
            ]
        }, ctx));

        expect(data.success).not.toBe(true);
        expect(data.error).toBe('validation_error');
        expect(data.issues.map((i: { path: string }) => i.path)).toEqual(
            expect.arrayContaining(['participants.0.conditions.0', 'participants.0.conditions.1'])
        );
        expect(getDb(':memory:').prepare('SELECT COUNT(*) AS n FROM encounters').get()).toEqual({ n: 0 });
    });

    it('combat_manage create forwards string and object conditions', async () => {
        const data = manageJson(await handleCombatManage({
            action: 'create',
            seed: 'cond-manage',
            participants: [
                { id: 'hero', name: 'Hero', initiative: 20, hp: 30, maxHp: 30, ac: 10, side: 'party', conditions: ['prone'] },
                { ...foe, conditions: [{ name: 'Frightened', source: 'dragon' }] }
            ]
        }, ctx));
        expect(data.success).toBe(true);

        expect(persistedToken(data.encounterId, 'hero').conditions[0].type).toBe('prone');
        expect(persistedToken(data.encounterId, 'foe').conditions[0]).toMatchObject({ type: 'frightened', sourceId: 'dragon' });

        await handleExecuteCombatAction({ encounterId: data.encounterId, action: 'attack', actorId: 'hero', targetId: 'foe', attackBonus: 5, dc: 10, damage: 1 }, ctx);
        const adv = manageJson(await handleCombatManage({ action: 'advance', encounterId: data.encounterId }, ctx));
        expect(adv.error).toBeUndefined();
    });

    it('add_participant hydrates the character row conditions into engine shape', async () => {
        const now = new Date().toISOString();
        new CharacterRepository(getDb(':memory:')).create({
            id: 'row-hero',
            name: 'Row Hero',
            stats: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
            hp: 25,
            maxHp: 25,
            ac: 13,
            level: 3,
            conditions: [{ name: 'Prone', source: 'grapple: Foe' }, { name: 'Poisoned', duration: 3 }],
            createdAt: now,
            updatedAt: now
        } as any);

        const created = manageJson(await handleCombatManage({
            action: 'create',
            seed: 'cond-hydrate',
            participants: [{ ...foe, initiative: 1, conditions: [] }]
        }, ctx));
        expect(created.success).toBe(true);
        const encounterId = created.encounterId;

        const added = manageJson(await handleCombatManage({ action: 'add_participant', encounterId, characterId: 'row-hero' }, ctx));
        expect(added.success).toBe(true);

        const token = persistedToken(encounterId, 'row-hero');
        expect(token.conditions).toHaveLength(2);
        expect(token.conditions[0]).toMatchObject({ type: 'prone', durationType: 'permanent', sourceId: 'grapple: Foe' });
        expect(token.conditions[1]).toMatchObject({ type: 'poisoned', durationType: 'rounds', duration: 3 });

        await handleExecuteCombatAction({ encounterId, action: 'attack', actorId: 'row-hero', targetId: 'foe', attackBonus: 5, dc: 10, damage: 1 }, ctx);
        await handleAdvanceTurn({ encounterId }, ctx);
        await handleAdvanceTurn({ encounterId }, ctx);
    });
});
