import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { getDb, closeDb } from '../../../src/storage/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';

const ctx = { sessionId: 'combat-profile' };
const json = (res: any) => JSON.parse(res.content[0].text.match(/<!-- \w+_JSON\n([\s\S]*?)\n\w+_JSON -->/)![1]);

// Every call goes through the outer schema first, as the MCP client does:
// a param missing from the mirror is stripped there and never arrives.
const call = (args: Record<string, unknown>) =>
    handleCharacterManage(CharacterManageTool.inputSchema.parse(args), ctx as any);

const profile = {
    size: 'huge',
    reach: 15,
    attacksPerAction: 3,
    attacks: [
        { name: 'bite', attackBonus: 11, damage: '2d10+6', damageType: 'piercing', part: 'middle head' },
        { name: 'claw', attackBonus: 11, damage: '2d6+6', damageType: 'slashing', default: true }
    ],
    abilities: [{ name: 'Hellfire Breath', recharge: 5 }],
    cr: 13,
    autoLegendaryResistance: true,
    legendaryActions: 3,
    legendaryResistances: 3,
    legendaryResistancesRemaining: 2,
    hasLairActions: true
};

describe('character_manage combat profile', () => {
    let repo: CharacterRepository;
    beforeEach(() => {
        closeDb();
        repo = new CharacterRepository(getDb(':memory:'));
    });
    afterEach(() => closeDb());

    it('the migration adds the combat_profile column', () => {
        const cols = getDb().prepare('PRAGMA table_info(characters)').all() as { name: string }[];
        expect(cols.some(c => c.name === 'combat_profile')).toBe(true);
    });

    it('create stores the profile and the legendary counters', async () => {
        const created = json(await call({ action: 'create', name: 'Tiamat Spawn', hp: 250, maxHp: 250, ...profile }));
        const row = repo.findById(created.id)!;
        expect(row).toMatchObject({
            size: 'huge', reach: 15, attacksPerAction: 3, cr: 13, autoLegendaryResistance: true,
            legendaryActions: 3, legendaryResistances: 3, legendaryResistancesRemaining: 2, hasLairActions: true
        });
        expect(row.attacks).toHaveLength(2);
        expect(row.attacks![0]).toMatchObject({ name: 'bite', part: 'middle head', damage: '2d10+6' });
        expect(row.abilities![0]).toMatchObject({ name: 'Hellfire Breath', recharge: 5, ready: true });
    });

    it('update sets fields one at a time and keeps the rest of the profile', async () => {
        const created = json(await call({ action: 'create', name: 'Ogre', hp: 59, maxHp: 59, ...profile }));
        await call({ action: 'update', characterId: created.id, size: 'large', reach: 10 });
        await call({ action: 'update', characterId: created.id, legendaryResistancesRemaining: 0, hasLairActions: false });
        const row = repo.findById(created.id)!;
        expect(row).toMatchObject({ size: 'large', reach: 10, attacksPerAction: 3, cr: 13, legendaryResistancesRemaining: 0, hasLairActions: false });
        expect(row.attacks).toHaveLength(2);
    });

    it('a sheet without a profile reads back with none', async () => {
        const created = json(await call({ action: 'create', name: 'Plain Hero' }));
        const row = repo.findById(created.id)!;
        expect(row.size).toBeUndefined();
        expect(row.attacks).toBeUndefined();
        expect(row.cr).toBeUndefined();
        const stored = getDb().prepare('SELECT combat_profile FROM characters WHERE id = ?').get(created.id) as { combat_profile: string | null };
        expect(stored.combat_profile).toBeNull();
    });
});
