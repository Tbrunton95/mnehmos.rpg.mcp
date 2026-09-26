/**
 * F1: create persists the whole engine state. The create path used to write a
 * hand-listed token map (dropping anything not on it) and never saved the RNG
 * position, so the first reload rolled from the seed again.
 */
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { TokenSchema } from '../../src/schema/encounter.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const ctx = { sessionId: 'f1' } as any;
const json = (res: any, tag: string) => JSON.parse(res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`))![1]);

let enc: string;
beforeEach(async () => {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    enc = json(await handleCombatManage({ action: 'create', seed: 'f1', participants: [
        { id: 'a', name: 'Alpha', hp: 20, maxHp: 20, initiative: 15 },
        { id: 'b', name: 'Brute', hp: 30, maxHp: 30, initiative: 5, isEnemy: true, attackDamageType: 'fire', legendaryActions: 3 }
    ] }, ctx), 'COMBAT_MANAGE').encounterId;
});
afterEach(() => { closeDb(); clearCombatState(); });

describe('create persists the whole engine state', () => {
    it('stores the RNG position at create', () => {
        const row = getDb().prepare('SELECT rng_state FROM encounters WHERE id = ?').get(enc) as { rng_state: string | null };
        expect(row.rng_state).not.toBeNull();
    });

    it('fields set at create survive a cold reload', () => {
        clearCombatState();
        const b = getOrLoadEngine(ctx, enc)!.getState()!.participants.find(p => p.id === 'b')!;
        expect(b.attackDamageType).toBe('fire');
        expect(b.legendaryActionsRemaining).toBe(3);
        expect(b.movementRemaining).toBe(30);
        expect(b.actionUsed).toBe(false);
    });

    it('tokens carry size medium and speed 30 by default', () => {
        const tokens = new EncounterRepository(getDb()).loadState(enc)!.participants as any[];
        for (const t of tokens) expect(t).toMatchObject({ size: 'medium', movementSpeed: 30 });
    });

    it('TokenSchema keeps fields it does not list', () => {
        const parsed = TokenSchema.parse({ id: 'x', name: 'X', initiativeBonus: 0, hp: 1, maxHp: 1, conditions: [], somethingNew: 7 }) as any;
        expect(parsed.somethingNew).toBe(7);
    });
});
