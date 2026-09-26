import { withOperation } from '../../../src/server/operation-guard.js';
import { handleMathManage, MathManageTool } from '../../../src/server/consolidated/math-manage.js';
import { handleSessionManage } from '../../../src/server/consolidated/session-manage.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../../src/storage/repos/custom-effects.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

/**
 * Wishlist item 10: roll_saving_throw is a first-class verb. It takes long
 * ability names, advantage sources named against the sheet's conditions or
 * effects, logs why it had advantage, and reports a legendary resistance.
 */
const ctx = { sessionId: 'unscoped' };
// Every call goes through the outer schema first, as a client would send it.
const math = withOperation('math_manage', (args: any) => handleMathManage(MathManageTool.inputSchema.parse(args), ctx));
const session = withOperation('session_manage', (args: any) => handleSessionManage(args, ctx));
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };

function effect(targetId: string, name: string, mechanics: unknown[]) {
    new CustomEffectsRepository(getDb()).apply({
        target_id: targetId, target_type: 'character', name, description: name,
        category: 'neutral', power_level: 1, source: { type: 'unknown' },
        mechanics: mechanics as never, duration: { type: 'until_removed' as never },
        triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
    } as never);
}

describe('math_manage roll_saving_throw', () => {
    beforeEach(() => {
        closeDb(); getDb(':memory:');
        const now = new Date().toISOString();
        new CharacterRepository(getDb()).create({
            id: 'kessa', name: 'Kessa', stats: { str: 10, dex: 12, con: 10, int: 10, wis: 16, cha: 10 },
            hp: 30, maxHp: 30, ac: 14, level: 5, saveProficiencies: ['Wisdom'],
            conditions: [
                { name: 'VAUREK: the ward-sigil of the Iron Choir', source: 'Choir rite' },
                { name: 'Shaken by the Warp', source: 'daemon gaze' },
                { name: 'Shaken nerves' }
            ],
            createdAt: now, updatedAt: now
        } as any);
        new CharacterRepository(getDb()).create({
            id: 'wyrm', name: 'Wyrm', stats: { str: 20, dex: 10, con: 18, int: 10, wis: 1, cha: 10 },
            hp: 200, maxHp: 200, ac: 18, level: 1, legendaryResistances: 3, legendaryResistancesRemaining: 2,
            createdAt: now, updatedAt: now
        } as any);
    });
    afterEach(() => closeDb());

    it('the description presents roll_saving_throw as a real verb', () => {
        expect(MathManageTool.description).not.toContain('there is no standalone roll_saving_throw tool');
        expect(MathManageTool.description).toContain('roll_saving_throw');
    });

    it('accepts long ability names in any case', async () => {
        const r = json(await math({ action: 'roll_saving_throw', characterId: 'kessa', ability: 'Wisdom', dc: 10 }));
        expect(r.success).toBe(true);
        expect(r.ability).toBe('wis');
        // WIS +3, save proficiency +3 at level 5
        expect(r.bonus).toBe(6);
        const r2 = json(await math({ action: 'roll_saving_throw', characterId: 'kessa', ability: 'DEXTERITY' }));
        expect(r2.ability).toBe('dex');
        expect(r2.bonus).toBe(1);
    });

    it('an advantage source matched against a condition rolls 2d20 and logs why', async () => {
        const r = json(await math({ action: 'roll_saving_throw', characterId: 'kessa', ability: 'wis', dc: 15, advantageSources: ['vaurek'] }));
        expect(r.rolls).toHaveLength(2);
        expect(r.natural).toBe(Math.max(...r.rolls));
        expect(r.advantageSources).toEqual(['VAUREK']);
        expect(r.contributions).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'ADV ← VAUREK', value: 0 })]));
        expect(r.bonus).toBe(6);
        const log = json(await session({ action: 'rolls', forId: 'kessa' })).rolls;
        const row = log.find((x: any) => x.id === r.rollId);
        expect(row.purpose).toBe('wis save (adv: VAUREK)');
        expect(row.expression).toBe('2d20kh1');
    });

    it('a source can match by condition source text or by active effect name', async () => {
        effect('kessa', 'Iron Choir Blessing', [{ type: 'custom_trigger', value: 'blessed' }]);
        const r = json(await math({ action: 'roll_saving_throw', characterId: 'kessa', ability: 'wis', disadvantageSources: ['daemon gaze'], advantageSources: ['iron choir blessing'] }));
        expect(r.disadvantageSources).toEqual(['Shaken by the Warp']);
        expect(r.advantageSources).toEqual(['Iron Choir Blessing']);
        // advantage and disadvantage cancel to one die
        expect(r.rolls).toHaveLength(1);
        const row = json(await session({ action: 'rolls', forId: 'kessa' })).rolls.find((x: any) => x.id === r.rollId);
        expect(row.purpose).toBe('wis save (adv: Iron Choir Blessing; dis: Shaken by the Warp)');
    });

    it('a missing or ambiguous source is refused and grants nothing', async () => {
        const miss = json(await math({ action: 'roll_saving_throw', characterId: 'kessa', ability: 'wis', advantageSources: ['Khorne'] }));
        expect(miss.rolls).toHaveLength(1);
        expect(miss.advantageSources ?? []).toEqual([]);
        expect(miss.resolverProblems.join(' ')).toMatch(/Khorne.*matches nothing/);
        const amb = json(await math({ action: 'roll_saving_throw', characterId: 'kessa', ability: 'wis', disadvantageSources: ['shaken'] }));
        expect(amb.rolls).toHaveLength(1);
        expect(amb.resolverProblems.join(' ')).toMatch(/shaken.*matches 2.*by prefix/);
    });

    it('an exact name beats a longer name that contains it', async () => {
        effect('kessa', 'Blessed', [{ type: 'custom_trigger', value: 'blessed' }]);
        effect('kessa', 'Blessed by Nurgle', [{ type: 'custom_trigger', value: 'rot' }]);
        const r = json(await math({ action: 'roll_saving_throw', characterId: 'kessa', ability: 'wis', advantageSources: ['Blessed'] }));
        expect(r.advantageSources).toEqual(['Blessed']);
        expect(r.rolls).toHaveLength(2);
        expect(r.resolverProblems).toBeUndefined();
    });

    it('autoApply and declared advantage effects compose into the roll', async () => {
        effect('kessa', 'Iron Will', [{ type: 'advantage_on', value: 1, save: 'wisdom', autoApply: true }]);
        const auto = json(await math({ action: 'roll_saving_throw', characterId: 'kessa', ability: 'wis' }));
        expect(auto.rolls).toHaveLength(2);
        expect(auto.advantageSources).toEqual(['Iron Will']);

        effect('kessa', 'Oathbound', [{ type: 'advantage_on', value: 1, condition: 'vs Khorne' }]);
        const dex = json(await math({ action: 'roll_saving_throw', characterId: 'kessa', ability: 'dex', declaredEffects: [{ name: 'Oathbound' }] }));
        expect(dex.rolls).toHaveLength(2);
        expect(dex.advantageSources).toEqual(['Oathbound (vs Khorne)']);
        expect(dex.resolverProblems).toBeUndefined();
    });

    it('skill checks take advantage sources too', async () => {
        const r = json(await math({ action: 'roll_skill_check', characterId: 'kessa', skill: 'insight', advantageSources: ['VAUREK'] }));
        expect(r.rolls).toHaveLength(2);
        const row = json(await session({ action: 'rolls', forId: 'kessa' })).rolls.find((x: any) => x.id === r.rollId);
        expect(row.purpose).toBe('insight check (adv: VAUREK)');
    });

    it('a failed save reports an available legendary resistance without spending it', async () => {
        const r = json(await math({ action: 'roll_saving_throw', characterId: 'wyrm', ability: 'wisdom', dc: 40 }));
        expect(r.outcome).toBe('FAILURE');
        expect(r.legendaryResistanceAvailable).toBe(2);
        expect(new CharacterRepository(getDb()).findById('wyrm')!.legendaryResistancesRemaining).toBe(2);
        const pass = json(await math({ action: 'roll_saving_throw', characterId: 'wyrm', ability: 'con', dc: 1 }));
        expect(pass.legendaryResistanceAvailable).toBeUndefined();
    });
});
