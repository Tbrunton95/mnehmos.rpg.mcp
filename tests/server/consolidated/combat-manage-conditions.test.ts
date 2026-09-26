import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { clearCombatState, handleExecuteCombatAction } from '../../../src/server/handlers/combat-handlers.js';
import { getCombatManager } from '../../../src/server/state/combat-manager.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const ctx = { sessionId: 'conditions' };

function json(res: { content: Array<{ text: string }> }) {
    const text = res.content[0].text;
    const m = text.match(/<!-- COMBAT_MANAGE_JSON\n([\s\S]*?)\nCOMBAT_MANAGE_JSON -->/);
    if (m) return JSON.parse(m[1]);
    try { return JSON.parse(text); } catch { return { rawText: text }; }
}
const call = async (args: Record<string, unknown>) => json(await handleCombatManage(args, ctx as any));

function tokenConditions(encounterId: string, id: string): Array<{ id: string; type: string; duration?: number }> {
    const row = getDb().prepare('SELECT tokens FROM encounters WHERE id = ?').get(encounterId) as { tokens: string };
    return JSON.parse(row.tokens).find((t: any) => t.id === id).conditions;
}

/**
 * Field report: conditions could not be removed mid-fight; the workaround
 * (character_manage update + removeConditions) edits the character row and
 * never touches the encounter sheet.
 */
describe('combat_manage add_condition / remove_condition', () => {
    let encounterId: string;
    let repo: CharacterRepository;

    beforeEach(async () => {
        closeDb();
        repo = new CharacterRepository(getDb(':memory:'));
        clearCombatState();
        const now = new Date().toISOString();
        repo.create({ id: 'luciel', name: 'Luciel', stats: { str: 24, dex: 14, con: 22, int: 14, wis: 14, cha: 18 }, hp: 200, maxHp: 200, ac: 20, level: 12,
            conditions: [{ name: 'Warp-touched', source: 'rite' }], createdAt: now, updatedAt: now } as any);
        const created = await call({ action: 'create', seed: 'cond', participants: [
            { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 20 },
            { id: 'token-scion', name: 'Scion Squad', hp: 30, maxHp: 30, initiative: 5, isEnemy: true }
        ] });
        encounterId = created.encounterId;
    });

    afterEach(() => closeDb());

    it('adds a named and a custom condition to the live token, surviving a reload', async () => {
        const a = await call({ action: 'add_condition', encounterId, participantId: 'token-scion', condition: 'prone' });
        expect(a.success).toBe(true);
        expect(a.condition.id).toBeTruthy();
        await call({ action: 'add_condition', encounterId, participantId: 'luciel', condition: { name: 'Crippled: left leg', source: 'called strike' } });
        getCombatManager().clear();
        expect(tokenConditions(encounterId, 'token-scion').map(c => c.type)).toEqual(['prone']);
        expect(tokenConditions(encounterId, 'luciel').map(c => c.type)).toEqual(['Crippled: left leg']);
        // A custom condition must not break the engine on the next action.
        const atk = await handleExecuteCombatAction({ encounterId, action: 'attack', actorId: 'luciel', targetId: 'token-scion', outcome: 'hit', damage: 5 }, ctx as any);
        expect(atk.content[0].text).toMatch(/GM RESULT/);
    });

    it('removes by name case-insensitively, or by id, and refuses when nothing matches', async () => {
        const a = await call({ action: 'add_condition', encounterId, participantId: 'token-scion', condition: 'prone' });
        await call({ action: 'add_condition', encounterId, participantId: 'token-scion', condition: 'frightened' });
        const byName = await call({ action: 'remove_condition', encounterId, participantId: 'token-scion', name: 'PRONE' });
        expect(byName.removed).toBe(1);
        expect(tokenConditions(encounterId, 'token-scion').map(c => c.type)).toEqual(['frightened']);
        const none = await call({ action: 'remove_condition', encounterId, participantId: 'token-scion', name: 'prone' });
        expect(none.error).toBeTruthy();
        const fr = tokenConditions(encounterId, 'token-scion')[0];
        const byId = await call({ action: 'remove_condition', encounterId, participantId: 'token-scion', conditionId: fr.id });
        expect(byId.removed).toBe(1);
        expect(tokenConditions(encounterId, 'token-scion')).toEqual([]);
        expect(a.condition.type).toBe('prone');
    });

    it('lets a round-based condition added mid-fight count down', async () => {
        await call({ action: 'add_condition', encounterId, participantId: 'token-scion', condition: { name: 'blinded', duration: 1 } });
        expect(tokenConditions(encounterId, 'token-scion').map(c => c.type)).toEqual(['blinded']);
        for (let i = 0; i < 4; i++) await call({ action: 'advance', encounterId });
        expect(tokenConditions(encounterId, 'token-scion')).toEqual([]);
    });

    it('replace swaps an existing condition of the same type', async () => {
        await call({ action: 'add_condition', encounterId, participantId: 'token-scion', condition: { name: 'restrained', duration: 5 } });
        await call({ action: 'add_condition', encounterId, participantId: 'token-scion', condition: { name: 'restrained', duration: 2 }, replace: true });
        const c = tokenConditions(encounterId, 'token-scion');
        expect(c).toHaveLength(1);
        expect(c[0].duration).toBe(2);
    });

    it('mirrors to the character sheet when asked', async () => {
        await call({ action: 'add_condition', encounterId, participantId: 'luciel', condition: 'poisoned', mirrorToCharacter: true });
        expect(repo.findById('luciel')!.conditions.map((c: any) => c.name)).toEqual(['Warp-touched', 'poisoned']);
        await call({ action: 'remove_condition', encounterId, participantId: 'luciel', name: 'Poisoned', mirrorToCharacter: true });
        expect(repo.findById('luciel')!.conditions.map((c: any) => c.name)).toEqual(['Warp-touched']);
    });

    it('remove_condition accepts the shapes add_condition takes (item 8)', async () => {
        await call({ action: 'add_condition', encounterId, participantId: 'token-scion', condition: 'prone' });
        const r1 = await call({ action: 'remove_condition', encounterId, participantId: 'token-scion', condition: 'PRONE' });
        expect(r1.removed).toBe(1);
        await call({ action: 'add_condition', encounterId, participantId: 'token-scion', condition: { name: 'restrained', duration: 2 } });
        const r2 = await call({ action: 'remove_condition', encounterId, participantId: 'token-scion', condition: { name: 'restrained', duration: 2 } });
        expect(r2.removed).toBe(1);
        // The applied condition echoed by add_condition goes straight back in,
        // and matches by instance id (only that one of two blinded goes).
        const a = await call({ action: 'add_condition', encounterId, participantId: 'token-scion', condition: 'blinded' });
        await call({ action: 'add_condition', encounterId, participantId: 'token-scion', condition: 'blinded' });
        const r3 = await call({ action: 'remove_condition', encounterId, participantId: 'token-scion', condition: a.condition });
        expect(r3.removed).toBe(1);
        expect(r3.removedConditions[0].id).toBe(a.condition.id);
        expect(tokenConditions(encounterId, 'token-scion').map(c => c.type)).toEqual(['blinded']);
        const none = await call({ action: 'remove_condition', encounterId, participantId: 'token-scion' });
        expect(none.error).toBeTruthy();
    });

    it('add_condition accepts a top-level name (item 8)', async () => {
        const a = await call({ action: 'add_condition', encounterId, participantId: 'token-scion', name: 'prone' });
        expect(a.success).toBe(true);
        expect(tokenConditions(encounterId, 'token-scion').map(c => c.type)).toEqual(['prone']);
        const none = await call({ action: 'add_condition', encounterId, participantId: 'token-scion' });
        expect(none.error).toBeTruthy();
    });

    it('add_participant imports sheet conditions only when asked', async () => {
        const now = new Date().toISOString();
        repo.create({ id: 'justicar', name: 'Justicar', stats: { str: 18, dex: 12, con: 16, int: 10, wis: 12, cha: 10 }, hp: 90, maxHp: 90, ac: 18, level: 8,
            conditions: [{ name: 'Prone', source: 'grapple: Luciel' }], createdAt: now, updatedAt: now } as any);
        await call({ action: 'add_participant', encounterId, characterId: 'justicar', importRowConditions: true });
        expect(tokenConditions(encounterId, 'justicar').map(c => c.type)).toEqual(['prone']);
    });
});

import { handleCombatAction } from '../../../src/server/consolidated/combat-action.js';
import { CombatEngine } from '../../../src/engine/combat/engine.js';

describe('grapple with an encounterId', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('puts Prone and Grappled on the encounter token, not only the sheet', async () => {
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        for (const [id, name] of [['luciel', 'Luciel'], ['foe', 'Foe']]) {
            repo.create({ id, name, stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 50, maxHp: 50, ac: 14, level: 5, createdAt: now, updatedAt: now } as any);
        }
        const created = await call({ action: 'create', seed: 'grapple', participants: [
            { id: 'luciel', name: 'Luciel', hp: 50, maxHp: 50, initiative: 20 },
            { id: 'foe', name: 'Foe', hp: 50, maxHp: 50, initiative: 5, isEnemy: true }
        ] });
        // Attacker rolls 20, defender rolls 1 on the fight's dice: the takedown lands.
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValueOnce(20).mockReturnValueOnce(1);
        const res = await handleCombatAction({ action: 'grapple', move: 'takedown', encounterId: created.encounterId, actorId: 'luciel', targetId: 'foe' }, ctx as any);
        expect(res.content[0].text).toMatch(/encounterTokensUpdated/);
        expect(tokenConditions(created.encounterId, 'foe').map(c => c.type).sort()).toEqual(['grappled', 'prone']);
        expect(repo.findById('foe')!.conditions.map((c: any) => c.name).sort()).toEqual(['Grappled', 'Prone']);
        // The grapple spent Luciel's attack.
        const row = getDb().prepare('SELECT tokens FROM encounters WHERE id = ?').get(created.encounterId) as { tokens: string };
        expect(JSON.parse(row.tokens).find((t: any) => t.id === 'luciel').actionUsed).toBe(true);
    });
});
