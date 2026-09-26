import { handleCorpseManage, CorpseManageTool } from '../../src/server/consolidated/corpse-manage.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { queryRolls } from '../../src/storage/roll-log.js';

/**
 * Corpse loot rolled on Math.random: no log, no replay. It is seeded in the
 * repository and logged by the handler; the seed replays the same loot.
 */
const ctx = { sessionId: 'unscoped' };
const corpse = withOperation('corpse_manage', (args: any) => handleCorpseManage(CorpseManageTool.inputSchema.parse(args), ctx as any));
const json = (res: any) => JSON.parse(res.content[0].text.match(/<!-- CORPSE_MANAGE_JSON\n([\s\S]*?)\nCORPSE_MANAGE_JSON -->/)[1]);

describe('seeded corpse loot', () => {
    beforeEach(async () => {
        closeDb(); getDb(':memory:');
        await corpse({ action: 'loot_table_create', name: 'Warband', creatureTypes: ['marauder'],
            randomDrops: [{ itemName: 'Axe', weight: 0.5, quantity: { min: 1, max: 3 } }, { itemName: 'Idol', weight: 0.3 }],
            guaranteedDrops: [{ itemName: 'Rags', quantity: { min: 1, max: 4 } }],
            currencyRange: { gold: { min: 1, max: 50 }, silver: { min: 0, max: 20 } } });
    });
    afterEach(() => closeDb());

    const newCorpse = async (name: string) => json(await corpse({ action: 'create', characterName: name, characterType: 'enemy' })).corpse.id as string;

    it('the same seed rolls the same loot, and the roll is logged with its seed', async () => {
        const a = json(await corpse({ action: 'generate_loot', corpseId: await newCorpse('A'), creatureType: 'marauder', seed: 'loot-7' }));
        const b = json(await corpse({ action: 'generate_loot', corpseId: await newCorpse('B'), creatureType: 'marauder', seed: 'loot-7' }));
        expect(a.loot).toEqual(b.loot);
        expect(a.seed).toBe('loot-7');
        expect(a.rollId).toBeTruthy();
        const row = queryRolls(getDb(), { limit: 10 }).find((r: any) => r.id === a.rollId) as any;
        expect(row).toMatchObject({ tool: 'corpse_manage', replay: 'loot-7' });
        expect(row.purpose).toMatch(/loot/);
        expect(row.dice.length).toBeGreaterThan(0);
    });

    it('unseeded loot still gets a replayable seed', async () => {
        const a = json(await corpse({ action: 'generate_loot', corpseId: await newCorpse('A'), creatureType: 'marauder' }));
        expect(a.seed).toBeTruthy();
        const b = json(await corpse({ action: 'generate_loot', corpseId: await newCorpse('B'), creatureType: 'marauder', seed: a.seed }));
        expect(b.loot).toEqual(a.loot);
    });

    it('loot_table_roll is an alias of generate_loot', async () => {
        const r = json(await corpse({ action: 'loot_table_roll', corpseId: await newCorpse('C'), creatureType: 'marauder', seed: 'x' }));
        expect(r.success).toBe(true);
        expect(r.loot.items.map((i: any) => i.name)).toContain('Rags');
    });
});
