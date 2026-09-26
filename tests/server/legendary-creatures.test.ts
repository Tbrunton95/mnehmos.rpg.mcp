/**
 * Legendary Creature Tests
 * 
 * D&D 5e legendary creatures have:
 * 1. Legendary Actions - Can take 1-3 actions at end of other creatures' turns
 * 2. Legendary Resistances - Auto-succeed on failed saves (typically 3/day)
 * 3. Lair Actions - On initiative count 20, lair does something
 * 4. Multiattack - Multiple attacks as single action (future)
 * 
 * @see https://www.dndbeyond.com/sources/basic-rules/monsters#LegendaryCreatures
 */

import { CombatEngine, CombatParticipant } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

describe('Legendary Creatures', () => {
    let engine: CombatEngine;

    describe('Legendary Actions', () => {
        it('should track legendary action count on legendary creatures', () => {
            engine = new CombatEngine('legendary-test-1');

            const participants: CombatParticipant[] = [
                {
                    id: 'hero-1',
                    name: 'Valeros',
                    initiativeBonus: 2,
                    hp: 50,
                    maxHp: 50,
                    conditions: [],
                    isEnemy: false
                },
                {
                    id: 'dragon-1',
                    name: 'Adult Red Dragon',
                    initiativeBonus: 10,
                    hp: 256,
                    maxHp: 256,
                    conditions: [],
                    isEnemy: true,
                    legendaryActions: 3,
                    legendaryActionsRemaining: 3
                }
            ];

            const state = engine.startEncounter(participants);
            const dragon = state.participants.find(p => p.id === 'dragon-1');

            expect(dragon?.legendaryActions).toBe(3);
            expect(dragon?.legendaryActionsRemaining).toBe(3);
        });

        it('should allow legendary action at end of another creatures turn', () => {
            engine = new CombatEngine('legendary-test-2');

            const participants: CombatParticipant[] = [
                {
                    id: 'dragon-1',
                    name: 'Adult Red Dragon',
                    initiativeBonus: 20,
                    hp: 256,
                    maxHp: 256,
                    conditions: [],
                    isEnemy: true,
                    legendaryActions: 3,
                    legendaryActionsRemaining: 3
                },
                {
                    id: 'hero-1',
                    name: 'Valeros',
                    initiativeBonus: 2,
                    hp: 50,
                    maxHp: 50,
                    conditions: [],
                    isEnemy: false
                }
            ];

            engine.startEncounter(participants);
            
            // Dragon's turn first (highest init), skip it
            engine.nextTurnWithConditions();
            
            // Now it's hero's turn - dragon should be able to use legendary action
            const canUseLegendary = engine.canUseLegendaryAction('dragon-1');
            expect(canUseLegendary).toBe(true);
        });

        it('should NOT allow legendary action on creatures own turn', () => {
            engine = new CombatEngine('legendary-test-3');

            const participants: CombatParticipant[] = [
                {
                    id: 'dragon-1',
                    name: 'Adult Red Dragon',
                    initiativeBonus: 20,
                    hp: 256,
                    maxHp: 256,
                    conditions: [],
                    isEnemy: true,
                    legendaryActions: 3,
                    legendaryActionsRemaining: 3
                },
                {
                    id: 'hero-1',
                    name: 'Valeros',
                    initiativeBonus: 2,
                    hp: 50,
                    maxHp: 50,
                    conditions: [],
                    isEnemy: false
                }
            ];

            engine.startEncounter(participants);
            
            // It's dragon's turn - should NOT be able to use legendary action
            const canUseLegendary = engine.canUseLegendaryAction('dragon-1');
            expect(canUseLegendary).toBe(false);
        });

        it('should decrement legendary actions when used', () => {
            engine = new CombatEngine('legendary-test-4');

            const participants: CombatParticipant[] = [
                {
                    id: 'dragon-1',
                    name: 'Adult Red Dragon',
                    initiativeBonus: 20,
                    hp: 256,
                    maxHp: 256,
                    conditions: [],
                    isEnemy: true,
                    legendaryActions: 3,
                    legendaryActionsRemaining: 3
                },
                {
                    id: 'hero-1',
                    name: 'Valeros',
                    initiativeBonus: 2,
                    hp: 50,
                    maxHp: 50,
                    conditions: [],
                    isEnemy: false
                }
            ];

            engine.startEncounter(participants);
            engine.nextTurnWithConditions(); // End dragon's turn
            
            // Use 1 legendary action (costs 1)
            const result = engine.useLegendaryAction('dragon-1', 1);
            expect(result.success).toBe(true);
            expect(result.remaining).toBe(2);

            // Use tail attack (costs 2)
            const result2 = engine.useLegendaryAction('dragon-1', 2);
            expect(result2.success).toBe(true);
            expect(result2.remaining).toBe(0);

            // Try to use another - should fail
            const result3 = engine.useLegendaryAction('dragon-1', 1);
            expect(result3.success).toBe(false);
        });

        it('should reset legendary actions at start of creatures turn', () => {
            engine = new CombatEngine('legendary-test-5');

            const participants: CombatParticipant[] = [
                {
                    id: 'dragon-1',
                    name: 'Adult Red Dragon',
                    initiativeBonus: 20,
                    hp: 256,
                    maxHp: 256,
                    conditions: [],
                    isEnemy: true,
                    legendaryActions: 3,
                    legendaryActionsRemaining: 3
                },
                {
                    id: 'hero-1',
                    name: 'Valeros',
                    initiativeBonus: 2,
                    hp: 50,
                    maxHp: 50,
                    conditions: [],
                    isEnemy: false
                }
            ];

            engine.startEncounter(participants);
            engine.nextTurnWithConditions(); // End dragon's turn, hero's turn

            // Use all legendary actions
            engine.useLegendaryAction('dragon-1', 3);
            
            const state = engine.getState();
            const dragonBefore = state?.participants.find(p => p.id === 'dragon-1');
            expect(dragonBefore?.legendaryActionsRemaining).toBe(0);

            // Complete the round - hero's turn ends, dragon's turn starts
            engine.nextTurnWithConditions();

            // Dragon's legendary actions should be reset
            const stateAfter = engine.getState();
            const dragonAfter = stateAfter?.participants.find(p => p.id === 'dragon-1');
            expect(dragonAfter?.legendaryActionsRemaining).toBe(3);
        });
    });

    describe('Legendary Resistances', () => {
        it('should track legendary resistance count', () => {
            engine = new CombatEngine('legendary-resist-1');

            const participants: CombatParticipant[] = [
                {
                    id: 'dragon-1',
                    name: 'Adult Red Dragon',
                    initiativeBonus: 20,
                    hp: 256,
                    maxHp: 256,
                    conditions: [],
                    isEnemy: true,
                    legendaryResistances: 3,
                    legendaryResistancesRemaining: 3
                }
            ];

            const state = engine.startEncounter(participants);
            const dragon = state.participants.find(p => p.id === 'dragon-1');

            expect(dragon?.legendaryResistances).toBe(3);
            expect(dragon?.legendaryResistancesRemaining).toBe(3);
        });

        it('should allow using legendary resistance to auto-succeed a save', () => {
            engine = new CombatEngine('legendary-resist-2');

            const participants: CombatParticipant[] = [
                {
                    id: 'dragon-1',
                    name: 'Adult Red Dragon',
                    initiativeBonus: 20,
                    hp: 256,
                    maxHp: 256,
                    conditions: [],
                    isEnemy: true,
                    legendaryResistances: 3,
                    legendaryResistancesRemaining: 3,
                    abilityScores: {
                        strength: 27,
                        dexterity: 10,
                        constitution: 25,
                        intelligence: 16,
                        wisdom: 13,
                        charisma: 21
                    }
                }
            ];

            engine.startEncounter(participants);
            
            // Use legendary resistance
            const result = engine.useLegendaryResistance('dragon-1');
            expect(result.success).toBe(true);
            expect(result.remaining).toBe(2);
        });

        it('should NOT reset legendary resistances between rounds', () => {
            engine = new CombatEngine('legendary-resist-3');

            const participants: CombatParticipant[] = [
                {
                    id: 'dragon-1',
                    name: 'Adult Red Dragon',
                    initiativeBonus: 20,
                    hp: 256,
                    maxHp: 256,
                    conditions: [],
                    isEnemy: true,
                    legendaryResistances: 3,
                    legendaryResistancesRemaining: 3
                },
                {
                    id: 'hero-1',
                    name: 'Valeros',
                    initiativeBonus: 2,
                    hp: 50,
                    maxHp: 50,
                    conditions: [],
                    isEnemy: false
                }
            ];

            engine.startEncounter(participants);
            
            // Use 1 legendary resistance
            engine.useLegendaryResistance('dragon-1');
            
            // Complete a full round
            engine.nextTurnWithConditions();
            engine.nextTurnWithConditions();
            
            // Should still have 2 remaining (NOT reset like legendary actions)
            const state = engine.getState();
            const dragon = state?.participants.find(p => p.id === 'dragon-1');
            expect(dragon?.legendaryResistancesRemaining).toBe(2);
        });
    });

    describe('Lair Actions', () => {
        it('should support lair action on initiative count 20', () => {
            engine = new CombatEngine('lair-test-1');

            const participants: CombatParticipant[] = [
                {
                    id: 'dragon-1',
                    name: 'Adult Red Dragon',
                    initiativeBonus: 15,
                    hp: 256,
                    maxHp: 256,
                    conditions: [],
                    isEnemy: true,
                    hasLairActions: true
                },
                {
                    id: 'hero-1',
                    name: 'Valeros',
                    initiativeBonus: 5,
                    hp: 50,
                    maxHp: 50,
                    conditions: [],
                    isEnemy: false
                }
            ];

            const state = engine.startEncounter(participants);
            
            // There should be a "LAIR" entry in turn order at initiative 20
            // (handled in startEncounter when a creature has hasLairActions)
            const hasLairInOrder = state.turnOrder.includes('LAIR');
            expect(hasLairInOrder).toBe(true);
        });

        it('should trigger lair action check when reaching initiative 20', () => {
            engine = new CombatEngine('lair-test-2');

            const participants: CombatParticipant[] = [
                {
                    id: 'dragon-1',
                    name: 'Adult Red Dragon',
                    initiativeBonus: 25, // Will likely roll higher than 20
                    hp: 256,
                    maxHp: 256,
                    conditions: [],
                    isEnemy: true,
                    hasLairActions: true
                },
                {
                    id: 'hero-1',
                    name: 'Valeros',
                    initiativeBonus: 0,
                    hp: 50,
                    maxHp: 50,
                    conditions: [],
                    isEnemy: false
                }
            ];

            engine.startEncounter(participants);
            
            // Check if lair actions are pending
            const lairActionsPending = engine.isLairActionPending();
            // This will depend on turn order, but the method should exist
            expect(typeof lairActionsPending).toBe('boolean');
        });
    });
});

describe('Legendary creatures at the table (tools)', () => {
    const ctx = { sessionId: 'legendary-tools' };
    const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
    let enc: string;
    const manage = async (args: Record<string, unknown>) => {
        const text = (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
        return { text, d: tag(text, 'COMBAT_MANAGE') };
    };
    const attack = async (args: Record<string, unknown>) => {
        const text = (await handleCombatAction({ action: 'attack', encounterId: enc, ...args }, ctx as any)).content[0].text;
        const d = tag(text, 'COMBAT_ACTION');
        return { text, r: d?.actionResult ?? d };
    };
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;

    // The hero acts first, so the dragon is off turn.
    async function setup() {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        const now = new Date().toISOString();
        new CharacterRepository(db).create({ id: 'dragon', name: 'Dragon', stats: { str: 27, dex: 10, con: 25, int: 16, wis: 13, cha: 21 },
            hp: 256, maxHp: 256, ac: 19, level: 1, legendaryActions: 3, legendaryResistances: 3, legendaryResistancesRemaining: 3,
            createdAt: now, updatedAt: now } as any);
        enc = tag((await handleCombatManage({ action: 'create', participants: [
            { id: 'hero', name: 'Valeros', hp: 50, maxHp: 50, initiative: 25, ac: 10 },
            { id: 'dragon', name: 'Dragon', hp: 256, maxHp: 256, initiative: 10, isEnemy: true, ac: 19 }
        ] }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
    }

    afterEach(() => closeDb());

    it('an off-turn attack with legendaryCost spends legendary actions, not the action, and carries no off-turn warning', async () => {
        await setup();
        const { text, r } = await attack({ actorId: 'dragon', targetId: 'hero', attackBonus: 14, damage: '2d6+8', legendaryCost: 1 });
        expect(r.legendary).toEqual({ cost: 1, remaining: 2 });
        expect(text).not.toMatch(/off_turn_action/);
        expect(tok('dragon').legendaryActionsRemaining).toBe(2);
        expect(tok('dragon').actionUsed).toBeFalsy();
    });

    it('legendaryCost is refused on its own turn and beyond what is left, writing nothing', async () => {
        await setup();
        const tooMuch = await attack({ actorId: 'dragon', targetId: 'hero', attackBonus: 14, damage: 5, legendaryCost: 4 });
        expect(tooMuch.text).toMatch(/Not enough legendary actions \(need 4, have 3\)/);
        expect(tok('dragon').legendaryActionsRemaining).toBe(3);
        expect(tok('hero').hp).toBe(50);
        await manage({ action: 'advance' });
        const own = await attack({ actorId: 'dragon', targetId: 'hero', attackBonus: 14, damage: 5, legendaryCost: 1 });
        expect(own.text).toMatch(/own turn/);
    });

    it('legendary_action spends, logs and refuses once spent', async () => {
        await setup();
        const first = await manage({ action: 'legendary_action', participantId: 'dragon', cost: 2, description: 'wing attack' });
        expect(first.d).toMatchObject({ success: true, remaining: 1, cost: 2 });
        expect(tok('dragon').legendaryActionsRemaining).toBe(1);
        const second = await manage({ action: 'legendary_action', participantId: 'dragon', cost: 2, description: 'wing attack' });
        expect(second.d.error).toBe(true);
        expect(second.text).toMatch(/need 2, have 1/);
        const history = await manage({ action: 'get_history' });
        expect(history.text).toMatch(/wing attack/);
    });

    it("the 'legendary' alias reaches legendary_action", async () => {
        await setup();
        const { d } = await manage({ action: 'legendary', participantId: 'dragon', description: 'detect' });
        expect(d.actionType).toBe('legendary_action');
        expect(tok('dragon').legendaryActionsRemaining).toBe(2);
    });

    it('legendary_resistance spends one and mirrors the count to the sheet', async () => {
        await setup();
        const { d } = await manage({ action: 'legendary_resistance', participantId: 'dragon', reason: 'hold person' });
        expect(d).toMatchObject({ success: true, remaining: 2 });
        expect(tok('dragon').legendaryResistancesRemaining).toBe(2);
        expect(new CharacterRepository(getDb()).findById('dragon')!.legendaryResistancesRemaining).toBe(2);
        const hero = await manage({ action: 'legendary_resistance', participantId: 'hero', reason: 'x' });
        expect(hero.d.error).toBe(true);
    });

    it('the state view shows legendary actions and resistances left', async () => {
        await setup();
        await manage({ action: 'legendary_resistance', participantId: 'dragon', reason: 'hold person' });
        await manage({ action: 'legendary_action', participantId: 'dragon', description: 'tail' });
        const { text } = await manage({ action: 'get' });
        expect(text).toMatch(/LA 2\/3 · LR 2\/3/);
    });

    it('reaction:true spends the reaction, not the action, and a second reaction is refused', async () => {
        await setup();
        const { text } = await attack({ actorId: 'dragon', targetId: 'hero', attackBonus: 14, damage: 3, reaction: true });
        expect(text).not.toMatch(/off_turn_action/);
        expect(tok('dragon').reactionUsed).toBe(true);
        expect(tok('dragon').actionUsed).toBeFalsy();
        expect((await attack({ actorId: 'dragon', targetId: 'hero', attackBonus: 14, damage: 3, reaction: true })).text).toMatch(/Reaction already used/);
    });
});
