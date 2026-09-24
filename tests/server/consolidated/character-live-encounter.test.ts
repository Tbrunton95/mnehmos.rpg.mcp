import { handleCharacterManage } from '../../../src/server/consolidated/character-manage.js';
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const ctx = { sessionId: 'own' };
const json = (res: any) => JSON.parse(res.content[0].text.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/)![2]);

/** Field report: the engine never said which of sheet and token owns a number. */
describe('character get names the live encounter holding its token', () => {
    beforeEach(() => {
        closeDb(); clearCombatState();
        const now = new Date().toISOString();
        new CharacterRepository(getDb(':memory:')).create({ id: 'luciel', name: 'Luciel', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 }, hp: 200, maxHp: 200, ac: 20, level: 15, createdAt: now, updatedAt: now } as any);
    });
    afterEach(() => closeDb());

    it('lists the encounter, the token HP and the sync rule; nothing when out of combat', async () => {
        expect(json(await handleCharacterManage({ action: 'get', characterId: 'luciel' }, ctx as any)).liveEncounters).toBeUndefined();
        const enc = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 20 },
            { id: 'x', name: 'X', hp: 10, maxHp: 10, initiative: 1 }
        ] }, ctx as any)).encounterId;
        await handleCombatManage({ action: 'add_condition', encounterId: enc, participantId: 'luciel', condition: 'prone' }, ctx as any);
        const live = json(await handleCharacterManage({ action: 'get', characterId: 'luciel' }, ctx as any)).liveEncounters;
        expect(live).toEqual([expect.objectContaining({ encounterId: enc, tokenHp: 200, tokenConditions: ['prone'] })]);
        expect(live[0].sync).toMatch(/this sheet owns it/);
    });
});
