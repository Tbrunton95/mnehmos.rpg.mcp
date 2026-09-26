import { v4 as uuid } from 'uuid';

import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import {
    handleExecuteCombatAction, handleCreateEncounter, handleGetEncounterState,
    handleAdvanceTurn, handleExecuteLairAction, clearCombatState, getOrLoadEngine
} from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { handleConcentrationManage } from '../../src/server/consolidated/concentration-manage.js';
import { ConcentrationRepository } from '../../src/storage/repos/concentration.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { checkConcentration } from '../../src/engine/magic/concentration.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { saveModifier } from '../../src/engine/combat/saves.js';

// The operation guard flushes engine dice for the unscoped session key.
const ctx = { sessionId: 'unscoped' };
const cast = withOperation('combat_action', (a) => handleExecuteCombatAction(a, ctx as any));

function stateOf(text: string): any {
    const match = text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/);
    if (!match) throw new Error('Could not extract state JSON');
    return JSON.parse(match[1]);
}

const now = () => new Date().toISOString();

function wizard(id: string): any {
    return {
        id, name: 'Evoker',
        stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
        hp: 30, maxHp: 30, ac: 12, level: 5, characterClass: 'wizard',
        knownSpells: ['Fireball'], preparedSpells: ['Fireball'], cantripsKnown: [],
        spellSlots: getInitialSpellSlots('wizard', 5), maxSpellLevel: getMaxSpellLevel('wizard', 5),
        createdAt: now(), updatedAt: now()
    };
}

/**
 * Saves inside combat read the sheet: ability modifier by either key style,
 * save proficiency by level, rolled on the encounter's seeded stream and
 * logged. The spell loop used Math.random and looked up abilityScores['dex']
 * on a long-keyed map, so every spell save modifier was 0.
 */
describe('saveModifier', () => {
    it('reads short-keyed stats and long-keyed abilityScores alike', () => {
        expect(saveModifier({ stats: { dex: 18 } }, 'dexterity').mod).toBe(4);
        expect(saveModifier({ abilityScores: { dexterity: 16 } }, 'dex').mod).toBe(3);
        expect(saveModifier({}, 'wis').total).toBe(0);
    });

    it('adds proficiency by level when the save is proficient, in any case or length', () => {
        const m = saveModifier({ stats: { wis: 14 }, saveProficiencies: ['WIS'], level: 5 }, 'wisdom');
        expect(m).toMatchObject({ mod: 2, prof: 3, total: 5 });
        expect(saveModifier({ stats: { con: 10 }, saveProficiencies: ['Constitution'], level: 1 }, 'con').prof).toBe(2);
        expect(saveModifier({ stats: { con: 10 }, saveProficiencies: ['dex'], level: 9 }, 'con').prof).toBe(0);
    });
});

describe('spell saves inside an encounter', () => {
    let charRepo: CharacterRepository;
    beforeEach(() => {
        closeDb();
        charRepo = new CharacterRepository(getDb(':memory:'));
        clearCombatState();
    });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    async function fireballAt(target: Record<string, unknown>, token: Record<string, unknown> = {}): Promise<{ encounterId: string; result: any; state: any }> {
        const wizardId = uuid();
        charRepo.create(wizard(wizardId));
        const created = await handleCreateEncounter({
            seed: `saves-${uuid()}`,
            participants: [
                { id: wizardId, name: 'Evoker', hp: 30, maxHp: 30, initiative: 20 },
                { hp: 100, maxHp: 100, initiative: 1, isEnemy: true, ...target }
            ]
        }, ctx as any);
        const encounterId = created.content[0].text.match(/Encounter ID: (encounter-[^\n]+)/)![1];
        // Fields no create schema takes yet (abilityScores) go straight onto the live token.
        if (Object.keys(token).length) {
            const engine = getOrLoadEngine(ctx as any, encounterId)!;
            Object.assign(engine.getState()!.participants.find(p => p.id === target.id)!, token);
            new EncounterRepository(getDb()).saveState(encounterId, engine.getState()!);
        }
        const res = await cast({ encounterId, action: 'cast_spell', actorId: wizardId, spellName: 'Fireball', targetId: target.id });
        const result = stateOf(res.content[0].text).actionResult;
        const state = stateOf((await handleGetEncounterState({ encounterId }, ctx as any)).content[0].text);
        return { encounterId, result, state };
    }

    it('a sheet target adds its DEX modifier and save proficiency, and the die reaches roll_log', async () => {
        charRepo.create({
            id: 'rogue', name: 'Rogue', stats: { str: 10, dex: 18, con: 10, int: 10, wis: 10, cha: 10 },
            hp: 100, maxHp: 100, ac: 15, level: 5, saveProficiencies: ['dexterity'], createdAt: now(), updatedAt: now()
        } as any);
        const { encounterId, result } = await fireballAt({ id: 'rogue', name: 'Rogue' });
        const save = result.saves[0];
        expect(save).toMatchObject({ id: 'rogue', ability: 'dexterity', modifier: 7 });
        expect(save.total).toBe(save.natural + 7);
        const rolls = queryRolls(getDb(), { encounterId, limit: 20 });
        const logged = rolls.find((r: any) => String(r.purpose).includes('dexterity save'));
        expect(logged).toMatchObject({ for_id: 'rogue' });
        expect((logged as any).dice[0].value).toBe(save.natural);
    });

    it('an ad-hoc token reads its long-keyed abilityScores', async () => {
        const { result } = await fireballAt({ id: 'ogre', name: 'Ogre' }, {
            abilityScores: { strength: 19, dexterity: 16, constitution: 16, intelligence: 5, wisdom: 7, charisma: 7 }
        });
        expect(result.saves[0].modifier).toBe(3);
    });

    it('does not roll the save with Math.random', async () => {
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        await fireballAt({ id: 'ogre', name: 'Ogre' });
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ purpose: expect.stringContaining('dexterity save'), forId: 'ogre' }));
    });

    it('spends a legendary resistance on a failed save when set to auto', async () => {
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(1);
        const { result, state } = await fireballAt({
            id: 'dragon', name: 'Dragon', legendaryResistances: 3, autoLegendaryResistance: true
        });
        expect(result.saves[0]).toMatchObject({ saved: true, legendaryResisted: true });
        // Saved: Fireball halves.
        const dragon = state.participants.find((p: any) => p.id === 'dragon');
        expect(dragon.hp).toBeGreaterThan(100 - 48);
        expect(remainingLR('dragon')).toBe(2);
    });

    it('an automatic legendary resistance on a sheet-backed creature is spent on the sheet too', async () => {
        charRepo.create({
            id: 'wyrm', name: 'Wyrm', stats: { str: 20, dex: 10, con: 20, int: 10, wis: 10, cha: 10 },
            hp: 100, maxHp: 100, ac: 18, level: 10, legendaryResistances: 3, legendaryResistancesRemaining: 3,
            autoLegendaryResistance: true, createdAt: now(), updatedAt: now()
        } as any);
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(1);
        const { result } = await fireballAt({ id: 'wyrm', name: 'Wyrm' });
        expect(result.saves[0]).toMatchObject({ saved: true, legendaryResisted: true });
        expect(remainingLR('wyrm')).toBe(2);
        // Resistances last the day: the next fight hydrates from the sheet.
        expect(charRepo.findById('wyrm')!.legendaryResistancesRemaining).toBe(2);
    });

    it('reports an unspent legendary resistance on a failed save otherwise', async () => {
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(1);
        const { result } = await fireballAt({ id: 'dragon', name: 'Dragon', legendaryResistances: 3 });
        expect(result.saves[0]).toMatchObject({ saved: false, legendaryResistanceAvailable: 3 });
        expect(result.saves[0].legendaryResisted).toBeUndefined();
    });
});

function remainingLR(id: string): number | undefined {
    // The state JSON does not carry the counter; read the stored tokens.
    const row = getDb().prepare('SELECT tokens FROM encounters').all() as Array<{ tokens: string }>;
    for (const r of row) {
        const p = JSON.parse(r.tokens).find((t: any) => t.id === id);
        if (p) return p.legendaryResistancesRemaining;
    }
    return undefined;
}

describe('lair saves read the sheet', () => {
    let repo: CharacterRepository;
    beforeEach(() => {
        closeDb();
        repo = new CharacterRepository(getDb(':memory:'));
        clearCombatState();
        repo.create({
            id: 'hero', name: 'Hero', stats: { str: 10, dex: 16, con: 10, int: 10, wis: 10, cha: 10 },
            hp: 50, maxHp: 50, ac: 14, level: 5, saveProficiencies: ['dex'], createdAt: now(), updatedAt: now()
        } as any);
    });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('adds DEX and save proficiency to the lair save', async () => {
        const created = await handleCreateEncounter({
            seed: 'lair-saves',
            participants: [
                { id: 'hero', name: 'Hero', initiative: 25, hp: 50, maxHp: 50, isEnemy: false },
                { id: 'wyrm', name: 'Wyrm', initiative: 5, hp: 100, maxHp: 100, isEnemy: true, hasLairActions: true }
            ]
        }, ctx as any);
        const encounterId = created.content[0].text.match(/Encounter ID: (encounter-[^\n\s]+)/)![1];
        await handleAdvanceTurn({ encounterId }, ctx as any);
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(10);
        const res = await handleExecuteLairAction({
            encounterId, actionDescription: 'Stalactites fall', targetIds: ['hero'],
            damage: 10, savingThrow: { ability: 'dexterity', dc: 15 }
        }, ctx as any);
        // 10 + 3 (DEX) + 3 (prof at level 5) = 16 >= 15.
        expect(res.content[0].text).toContain('10 + 6 = 16');
        expect(res.content[0].text).toContain('SAVED');
    });
});

describe('concentration saves', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    function concentrator(saveProficiencies: string[] = []) {
        const repo = new CharacterRepository(getDb());
        const c = repo.create({
            id: 'cleric', name: 'Cleric', stats: { str: 10, dex: 10, con: 14, int: 10, wis: 16, cha: 10 },
            hp: 40, maxHp: 40, ac: 16, level: 5, saveProficiencies, createdAt: now(), updatedAt: now()
        } as any);
        const conc = new ConcentrationRepository(getDb());
        conc.create({ characterId: 'cleric', activeSpell: 'Bless', spellLevel: 1, targetIds: [], startedAt: 1, maxDuration: 10, saveDCBase: 10 } as any);
        return { char: repo.findById('cleric')!, conc };
    }

    it('adds CON save proficiency and rolls the die it is given', () => {
        const { char, conc } = concentrator(['constitution']);
        const r = checkConcentration(char, 10, conc, 0, () => 5);
        // 5 + 2 (CON) + 3 (prof) = 10 vs DC 10.
        expect(r).toMatchObject({ saveRoll: 5, saveTotal: 10, broken: false, constitutionModifier: 5 });
    });

    it('concentration_manage check_save logs its die to roll_log', async () => {
        concentrator();
        const guarded = withOperation('concentration_manage', (a) => handleConcentrationManage(a, ctx as any));
        await guarded({ action: 'check_save', characterId: 'cleric', damageAmount: 4 });
        const rolls = queryRolls(getDb(), { forId: 'cleric', limit: 5 });
        expect(rolls.find((r: any) => r.purpose === 'concentration')).toBeTruthy();
    });
});
