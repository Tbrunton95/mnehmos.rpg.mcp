import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleWorldManage } from '../../src/server/consolidated/world-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const ctx = { sessionId: 'regen' };
const tagJson = (text: string, tag: string) => JSON.parse(text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`))![1]);

/**
 * Ruling: a regenerating creature heals its stated amount at the start of
 * each of its rounds, in and out of combat, and the encounter sheet applies
 * it automatically. Destroyed stays destroyed.
 */
describe('regeneration', () => {
    let repo: CharacterRepository;
    beforeEach(() => {
        closeDb();
        repo = new CharacterRepository(getDb(':memory:'));
        clearCombatState();
        const now = new Date().toISOString();
        repo.create({ id: 'marine', name: 'Marine', stats: { str: 20, dex: 12, con: 20, int: 10, wis: 10, cha: 10 }, hp: 100, maxHp: 100, ac: 18, level: 10, createdAt: now, updatedAt: now } as any);
        repo.create({ id: 'spawn', name: 'Chaos Spawn', stats: { str: 22, dex: 10, con: 22, int: 2, wis: 8, cha: 2 }, hp: 60, maxHp: 120, ac: 12, level: 8, regeneration: 10, createdAt: now, updatedAt: now } as any);
    });
    afterEach(() => closeDb());

    async function fight(spawnHp: number) {
        const created = tagJson((await handleCombatManage({ action: 'create', participants: [
            { id: 'marine', name: 'Marine', hp: 100, maxHp: 100, initiative: 20 },
            { id: 'spawn', name: 'Chaos Spawn', hp: spawnHp, maxHp: 120, initiative: 5, isEnemy: true }
        ] }, ctx as any)).content[0].text, 'COMBAT_MANAGE');
        return created.encounterId as string;
    }
    const spawnToken = (id: string) => new EncounterRepository(getDb()).loadState(id)!.participants.find(p => p.id === 'spawn')!;

    it('heals at the start of its own turn and says so', async () => {
        repo.update('spawn', { hp: 60 } as any);
        const enc = await fight(60);
        const out = (await handleCombatManage({ action: 'advance', encounterId: enc }, ctx as any)).content[0].text;
        expect(out).toMatch(/Chaos Spawn regenerates 10 HP \(60 → 70\/120\)/);
        expect(spawnToken(enc).hp).toBe(70);
        expect(repo.findById('spawn')!.hp).toBe(70);
    });

    it('never past max HP', async () => {
        repo.update('spawn', { hp: 115 } as any);
        const enc = await fight(115);
        await handleCombatManage({ action: 'advance', encounterId: enc }, ctx as any);
        expect(spawnToken(enc).hp).toBe(120);
    });

    it('not at 0 HP: destroyed stays destroyed', async () => {
        repo.update('spawn', { hp: 0 } as any);
        const enc = await fight(0);
        await handleCombatManage({ action: 'advance', encounterId: enc }, ctx as any);
        await handleCombatManage({ action: 'advance', encounterId: enc }, ctx as any);
        expect(spawnToken(enc).hp).toBe(0);
    });

    it('out of combat, a time advance restores regenerating characters in the world', async () => {
        const now = new Date().toISOString();
        new WorldRepository(getDb()).create({ id: 'w', name: 'Vorago', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 3, time: '10:00' } } as any);
        try { getDb().exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
        getDb().prepare("UPDATE characters SET world_id = 'w'").run();
        repo.update('marine', { hp: 50 } as any);
        const res = await handleWorldManage({ action: 'update', worldId: 'w', environment: { time: '10:05' } }, ctx as any);
        expect(res.content[0].text).toMatch(/regenerated to full: Chaos Spawn/);
        expect(repo.findById('spawn')!.hp).toBe(120);
        // No regeneration value: no healing.
        expect(repo.findById('marine')!.hp).toBe(50);
    });
});
