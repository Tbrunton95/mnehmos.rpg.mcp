import { CombatEngine } from '../../src/engine/combat/engine.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

function fight(seed: string) {
    const e = new CombatEngine(seed);
    // Initiative bonuses fix the order: marine, then heretic, then scout.
    e.startEncounter([
        { id: 'marine', name: 'Marine', initiativeBonus: 50, hp: 100, maxHp: 100, conditions: [] },
        { id: 'heretic', name: 'Heretic', initiativeBonus: 25, hp: 100, maxHp: 100, conditions: [] },
        { id: 'scout', name: 'Scout', initiativeBonus: 0, hp: 100, maxHp: 100, conditions: [] }
    ] as any);
    return e;
}

/**
 * Audit: dodge and help returned flavour text and changed nothing; dash
 * doubled movement in memory but never saved, so a reload lost it.
 */
describe('dodge and help change the dice', () => {
    it('attacks against a dodger roll two d20s and keep the lower', () => {
        const e = fight('dodge');
        expect(e.applyDodge('marine').ok).toBe(true);
        e.nextTurnWithConditions(); // heretic
        const r = e.executeAttack('heretic', 'marine', 5, 15, 1);
        const ar = r.attackRoll as any;
        expect(ar.allRolls).toHaveLength(2);
        expect(ar.roll).toBe(Math.min(...ar.allRolls));
    });

    it('dodge lasts until the dodger\'s next turn', () => {
        const e = fight('dodge-ends');
        e.applyDodge('marine');
        e.nextTurnWithConditions(); e.nextTurnWithConditions(); e.nextTurnWithConditions(); // back to the marine
        const r = e.executeAttack('heretic', 'marine', 5, 15, 1);
        expect((r.attackRoll as any).allRolls).toHaveLength(1);
    });

    it('help gives the ally advantage on one attack, then it is spent', () => {
        const e = fight('help');
        expect(e.applyHelp('marine', 'heretic').ok).toBe(true);
        e.nextTurnWithConditions(); // heretic
        const first = e.executeAttack('heretic', 'scout', 5, 15, 1).attackRoll as any;
        expect(first.allRolls).toHaveLength(2);
        expect(first.roll).toBe(Math.max(...first.allRolls));
        const second = e.executeAttack('heretic', 'scout', 5, 15, 1).attackRoll as any;
        expect(second.allRolls).toHaveLength(1);
    });

    it('unused help lapses when the helper\'s next turn starts', () => {
        const e = fight('help-lapses');
        e.applyHelp('marine', 'heretic');
        e.nextTurnWithConditions(); e.nextTurnWithConditions(); e.nextTurnWithConditions(); // back to the marine
        const r = e.executeAttack('heretic', 'scout', 5, 15, 1).attackRoll as any;
        expect(r.allRolls).toHaveLength(1);
    });

    it('dodge and help both spend the action', () => {
        const e = fight('econ');
        e.applyDodge('marine');
        expect(e.applyHelp('marine', 'heretic').ok).toBe(false);
    });
});

describe('dodge, help and dash survive a reload', () => {
    const ctx = { sessionId: 'dhd' };
    let encounterId: string;

    beforeEach(async () => {
        closeDb();
        getDb(':memory:');
        clearCombatState();
        const res = await handleCombatManage({ action: 'create', seed: 'dhd', participants: [
            { id: 'marine', name: 'Marine', hp: 100, maxHp: 100, initiativeBonus: 50 },
            { id: 'heretic', name: 'Heretic', hp: 100, maxHp: 100, initiativeBonus: 0, isEnemy: true }
        ] }, ctx as any);
        encounterId = JSON.parse(res.content[0].text.match(/<!-- COMBAT_MANAGE_JSON\n([\s\S]*?)\nCOMBAT_MANAGE_JSON -->/)![1]).encounterId;
    });
    afterEach(() => closeDb());

    const saved = (id: string) => new EncounterRepository(getDb()).loadState(encounterId)!.participants.find(p => p.id === id)! as any;

    it('dash', async () => {
        await handleCombatAction({ action: 'dash', encounterId, actorId: 'marine' }, ctx as any);
        expect(saved('marine').hasDashed).toBe(true);
        expect(saved('marine').movementRemaining).toBe(60);
    });

    it('dodge', async () => {
        await handleCombatAction({ action: 'dodge', encounterId, actorId: 'marine' }, ctx as any);
        expect(saved('marine').isDodging).toBe(true);
        expect(saved('marine').actionUsed).toBe(true);
    });

    it('help', async () => {
        await handleCombatAction({ action: 'help', encounterId, actorId: 'marine', targetId: 'heretic' }, ctx as any);
        expect(saved('heretic').helpedBy).toBe('marine');
    });
});
