/**
 * F2: one shared set of participant extras (size, reach, attack profiles,
 * abilities, legendary counters, lair, cr) accepted by create and
 * add_participant, hydrated caller > sheet > preset, and kept on the token.
 */
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { hydrateExtras } from '../../src/engine/combat/participant-extras.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const ctx = { sessionId: 'f2' } as any;
const json = (res: any, tag: string) => JSON.parse(res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`))![1]);
const tokens = (enc: string) => new EncounterRepository(getDb()).loadState(enc)!.participants as any[];

const BLOODTHIRSTER = {
    size: 'huge', reach: 15, movementSpeed: 40, attacksPerAction: 2, cr: 20,
    attacks: [
        { name: 'axe', attackBonus: 14, damage: '3d12+8', damageType: 'slashing', part: 'right arm', default: true },
        { name: 'whip', attackBonus: 12, damage: '2d8+6', damageType: 'slashing', part: 'left arm', reachFt: 20 }
    ],
    abilities: [{ name: 'Hellfire Breath', recharge: 5 }],
    legendaryActions: 3, legendaryResistances: 3, autoLegendaryResistance: false, hasLairActions: true,
    attackDamageType: 'slashing'
};

beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
afterEach(() => { closeDb(); clearCombatState(); });

describe('create keeps the extras', () => {
    it('stores size, reach, profiles, abilities, legendary counters, lair and cr on the token', async () => {
        const enc = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'luciel', name: 'Luciel', hp: 300, maxHp: 300, initiative: 25 },
            { id: 'khorne', name: 'An\'ggrath', hp: 600, maxHp: 600, initiative: 10, isEnemy: true, ...BLOODTHIRSTER }
        ] }, ctx), 'COMBAT_MANAGE').encounterId;
        clearCombatState();
        const state = getOrLoadEngine(ctx, enc)!.getState()!;
        const k = state.participants.find(p => p.id === 'khorne')! as any;
        expect(k).toMatchObject({ size: 'huge', reach: 15, movementSpeed: 40, attacksPerAction: 2, cr: 20, hasLairActions: true, attackDamageType: 'slashing',
            legendaryActions: 3, legendaryActionsRemaining: 3, legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: false });
        expect(k.attacks.map((a: any) => a.name)).toEqual(['axe', 'whip']);
        expect(k.attacks[1]).toMatchObject({ part: 'left arm', reachFt: 20 });
        expect(k.abilities[0]).toMatchObject({ name: 'Hellfire Breath', recharge: 5, ready: true });
        expect(state.turnOrder).toContain('LAIR');
    });

    it('a spent legendary resistance is not refilled at create', async () => {
        const enc = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'k', name: 'K', hp: 60, maxHp: 60, initiative: 10, isEnemy: true, legendaryResistances: 3, legendaryResistancesRemaining: 1 }
        ] }, ctx), 'COMBAT_MANAGE').encounterId;
        expect(tokens(enc)[0].legendaryResistancesRemaining).toBe(1);
    });

    it('keeps the caller\'s name and values over a preset', async () => {
        const enc = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'g2', name: 'Goblin 2', hp: 7, maxHp: 7, initiative: 5, isEnemy: true },
            { id: 'g3', name: 'Goblin 3', hp: 7, maxHp: 7, initiative: 4, isEnemy: true, attackDamage: '1d4', size: 'medium' }
        ] }, ctx), 'COMBAT_MANAGE').encounterId;
        const [g2, g3] = ['g2', 'g3'].map(id => tokens(enc).find(t => t.id === id));
        expect(g2.name).toBe('Goblin 2');
        expect(g2.ac).toBe(15);
        expect(g2.size).toBe('small');
        expect(g3.name).toBe('Goblin 3');
        expect(g3.attackDamage).toBe('1d4');
        expect(g3.size).toBe('medium');
    });
});

describe('add_participant keeps the extras', () => {
    it('an ad-hoc lair owner adds the LAIR slot and starts with full legendary counters', async () => {
        const enc = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'luciel', name: 'Luciel', hp: 300, maxHp: 300, initiative: 25 }
        ] }, ctx), 'COMBAT_MANAGE').encounterId;
        const out = await handleCombatManage({ action: 'add_participant', encounterId: enc, name: 'An\'ggrath', hp: 600, maxHp: 600, isEnemy: true, ...BLOODTHIRSTER }, ctx);
        expect(out.content[0].text).not.toMatch(/error/i);
        const state = getOrLoadEngine(ctx, enc)!.getState()!;
        const k = state.participants.find(p => p.name === 'An\'ggrath')! as any;
        expect(k).toMatchObject({ size: 'huge', reach: 15, attacksPerAction: 2, legendaryActionsRemaining: 3, legendaryResistancesRemaining: 3, hasLairActions: true });
        expect(k.attacks).toHaveLength(2);
        expect(state.turnOrder).toContain('LAIR');
        expect(state.lairOwnerId).toBe(k.id);
        clearCombatState();
        expect(getOrLoadEngine(ctx, enc)!.getState()!.turnOrder).toContain('LAIR');
    });

    it('a character row supplies legendary counters and lair when the caller does not', async () => {
        const now = new Date().toISOString();
        new CharacterRepository(getDb()).create({ id: 'drake', name: 'Drake', stats: { str: 20, dex: 10, con: 20, int: 10, wis: 10, cha: 10 }, hp: 100, maxHp: 100, ac: 18, level: 10,
            legendaryActions: 3, legendaryResistances: 3, legendaryResistancesRemaining: 2, hasLairActions: true, createdAt: now, updatedAt: now } as any);
        const enc = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'luciel', name: 'Luciel', hp: 300, maxHp: 300, initiative: 25 }
        ] }, ctx), 'COMBAT_MANAGE').encounterId;
        await handleCombatManage({ action: 'add_participant', encounterId: enc, characterId: 'drake', isEnemy: true }, ctx);
        const d = tokens(enc).find(t => t.id === 'drake');
        expect(d).toMatchObject({ legendaryActions: 3, legendaryActionsRemaining: 3, legendaryResistancesRemaining: 2, hasLairActions: true });
    });
});

describe('hydrateExtras', () => {
    it('prefers caller, then sheet, then preset, and omits what nobody set', () => {
        const out = hydrateExtras(
            { reach: 10, band: 'Astartes' },
            { band: 'Mortal', regeneration: 5, legendaryActions: 2 } as any,
            { size: 'large', speed: 40, cr: 5, defaultAttack: { name: 'claw', damage: '2d6+4', damageType: 'slashing', toHit: 7 } } as any
        );
        expect(out).toEqual({ reach: 10, band: 'Astartes', regeneration: 5, legendaryActions: 2, size: 'large', movementSpeed: 40, cr: 5,
            attackDamage: '2d6+4', attackBonus: 7, attackDamageType: 'slashing' });
        expect(Object.keys(hydrateExtras({}))).toHaveLength(0);
    });
});
