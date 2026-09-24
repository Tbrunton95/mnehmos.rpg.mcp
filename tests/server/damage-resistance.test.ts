import { handleCreateEncounter, handleExecuteCombatAction, clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const mockCtx = { sessionId: 'test-session' };

/**
 * HIGH-002: Damage Resistance Not Applied
 *
 * Tests for damage resistance and vulnerability in combat.
 * - Resistance should halve damage
 * - Vulnerability should double damage
 * - Immunity should reduce damage to 0
 */
describe('HIGH-002: Damage Resistance', () => {
    beforeEach(() => {
        closeDb();
        getDb(':memory:');
        clearCombatState();
    });

    describe('Damage Type and Resistance', () => {
        it('should halve fire damage for fire-resistant character', async () => {
            // Create encounter with fire-resistant hero
            const createResult = await handleCreateEncounter({
                seed: 'resist-test-1',
                participants: [
                    {
                        id: 'hero-1',
                        name: 'Fire-Resistant Hero',
                        initiativeBonus: 10,
                        hp: 50,
                        maxHp: 50,
                        resistances: ['fire']
                    },
                    {
                        id: 'dragon-1',
                        name: 'Fire Dragon',
                        initiativeBonus: 1,
                        hp: 100,
                        maxHp: 100,
                        isEnemy: true
                    }
                ]
            }, mockCtx);
            const createData = JSON.parse(createResult.content[0].text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/)?.[1] || '{}');
            const encounterId = createData.encounterId;

            // Dragon attacks with fire breath (40 fire damage)
            const attackResult = await handleExecuteCombatAction({
                encounterId,
                action: 'attack',
                actorId: 'dragon-1',
                targetId: 'hero-1',
                attackBonus: 10,
                dc: 10, // Guaranteed hit
                damage: 40,
                damageType: 'fire'
            }, mockCtx);

            const attackText = attackResult.content[0].text;
            // Should show resistance applied, damage halved to 20
            expect(attackText).toMatch(/resist/i);
            expect(attackText).toContain('20'); // Halved damage
        });

        it('should double damage for vulnerable character', async () => {
            // Create encounter with cold-vulnerable creature
            const createResult = await handleCreateEncounter({
                seed: 'vuln-test-1',
                participants: [
                    {
                        id: 'hero-1',
                        name: 'Ice Mage',
                        initiativeBonus: 10,
                        hp: 30,
                        maxHp: 30
                    },
                    {
                        id: 'fire-elem-1',
                        name: 'Fire Elemental',
                        initiativeBonus: 1,
                        hp: 50,
                        maxHp: 50,
                        isEnemy: true,
                        vulnerabilities: ['cold']
                    }
                ]
            }, mockCtx);
            const createData = JSON.parse(createResult.content[0].text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/)?.[1] || '{}');
            const encounterId = createData.encounterId;

            // Ice Mage attacks with cold damage (10 cold damage)
            const attackResult = await handleExecuteCombatAction({
                encounterId,
                action: 'attack',
                actorId: 'hero-1',
                targetId: 'fire-elem-1',
                attackBonus: 10,
                dc: 10, // Guaranteed hit
                damage: 10,
                damageType: 'cold'
            }, mockCtx);

            const attackText = attackResult.content[0].text;
            // Should show vulnerability applied, damage doubled to 20
            expect(attackText).toMatch(/vulnerab/i);
            expect(attackText).toContain('20'); // Doubled damage
        });

        it('should apply immunity (0 damage) for immune character', async () => {
            // Create encounter with fire-immune creature
            const createResult = await handleCreateEncounter({
                seed: 'immune-test-1',
                participants: [
                    {
                        id: 'hero-1',
                        name: 'Pyromancer',
                        initiativeBonus: 10,
                        hp: 30,
                        maxHp: 30
                    },
                    {
                        id: 'fire-elem-1',
                        name: 'Fire Elemental',
                        initiativeBonus: 1,
                        hp: 50,
                        maxHp: 50,
                        isEnemy: true,
                        immunities: ['fire']
                    }
                ]
            }, mockCtx);
            const createData = JSON.parse(createResult.content[0].text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/)?.[1] || '{}');
            const encounterId = createData.encounterId;

            // Pyromancer attacks with fire damage
            const attackResult = await handleExecuteCombatAction({
                encounterId,
                action: 'attack',
                actorId: 'hero-1',
                targetId: 'fire-elem-1',
                attackBonus: 10,
                dc: 10,
                damage: 30,
                damageType: 'fire'
            }, mockCtx);

            const attackText = attackResult.content[0].text;
            // Should show immunity, 0 damage
            expect(attackText).toMatch(/immun/i);
        });

        it('should apply normal damage without damage type', async () => {
            // Create encounter - normal attack without type
            const createResult = await handleCreateEncounter({
                seed: 'normal-test-1',
                participants: [
                    {
                        id: 'hero-1',
                        name: 'Fighter',
                        initiativeBonus: 10,
                        hp: 30,
                        maxHp: 30
                    },
                    {
                        id: 'goblin-1',
                        name: 'Goblin',
                        initiativeBonus: 1,
                        hp: 20,
                        maxHp: 20,
                        isEnemy: true,
                        resistances: ['fire'] // Has resistance but attack is slashing
                    }
                ]
            }, mockCtx);
            const createData = JSON.parse(createResult.content[0].text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/)?.[1] || '{}');
            const encounterId = createData.encounterId;

            // Normal attack (no type = physical/slashing)
            const attackResult = await handleExecuteCombatAction({
                encounterId,
                action: 'attack',
                actorId: 'hero-1',
                targetId: 'goblin-1',
                attackBonus: 10,
                dc: 10,
                damage: 10
                // No damageType - should be unaffected by fire resistance
            }, mockCtx);

            const attackText = attackResult.content[0].text;
            // Should NOT show resistance (different damage type)
            expect(attackText).not.toMatch(/resist/i);
            expect(attackText).toContain('10'); // Full damage
        });

        // The tests above can match a participant name ("Fire-Resistant
        // Hero") or the encounter id ("immune-test-1"). This one reads the
        // PDA damage line and the actionResult envelope, which must agree.
        // One `it` per case so beforeEach gives each a fresh DB: the
        // encounter id is seed + Date.now(), which can repeat within a
        // millisecond and fail the INSERT if the cases share a DB.
        it.each([
            { key: 'resistances', damage: 40, dealt: 20, modifier: 'resistant', shown: /RESISTANT/ },
            { key: 'vulnerabilities', damage: 10, dealt: 20, modifier: 'vulnerable', shown: /VULNERABLE/ },
            { key: 'immunities', damage: 30, dealt: 0, modifier: 'immune', shown: /IMMUNE/ }
        ])('should print the $modifier modifier on the damage line and in actionResult', async (c) => {
            const createResult = await handleCreateEncounter({
                seed: 'modifier-line-1',
                participants: [
                    { id: 'hero-1', name: 'Hero', initiativeBonus: 10, hp: 30, maxHp: 30 },
                    { id: 'orc-1', name: 'Orc', initiativeBonus: 1, hp: 50, maxHp: 50, isEnemy: true, [c.key]: ['fire'] }
                ]
            }, mockCtx);
            const createData = JSON.parse(createResult.content[0].text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/)?.[1] || '{}');

            const attackResult = await handleExecuteCombatAction({
                encounterId: createData.encounterId,
                action: 'attack',
                actorId: 'hero-1',
                targetId: 'orc-1',
                attackBonus: 10,
                dc: 10,
                damage: c.damage,
                damageType: 'fire'
            }, mockCtx);

            const attackText = attackResult.content[0].text;
            const state = JSON.parse(attackText.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/)?.[1] || '{}');
            expect(state.actionResult.roll.hit).toBe(true);
            expect(state.actionResult.damage).toMatchObject({ total: c.dealt, type: 'fire', modifier: c.modifier });

            const damageLine = attackText.split('\n').find((l: string) => l.includes('⌁'));
            expect(damageLine).toMatch(c.shown);
            expect(damageLine).toContain(`${c.dealt} fire`);
        });
    });
});
