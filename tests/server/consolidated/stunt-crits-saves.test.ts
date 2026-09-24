import { handleImprovisationManage } from '../../../src/server/consolidated/improvisation-manage.js';
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const ctx = { sessionId: 'stunts' };

function data(res: { content: Array<{ text: string }> }): any {
    const text = res.content[0].text;
    const m = text.match(/<!-- [A-Z_]*JSON\n([\s\S]*?)\n[A-Z_]*JSON -->/);
    return m ? JSON.parse(m[1]) : JSON.parse(text);
}

async function stunt(extra: Record<string, unknown>) {
    return data(await handleImprovisationManage({ action: 'stunt', actorId: 'luciel', skill: 'athletics', dc: 5, ...extra }, ctx as any));
}

/**
 * Audit: stunts crit on beating the DC by 10 (not a natural 20), doubled the
 * whole damage total including the modifier, rolled target saves without the
 * target's ability modifier, refused plain-number damage, and only updated the
 * character row, never the encounter sheet.
 */
describe('stunt crits and saves', () => {
    let repo: CharacterRepository;
    beforeEach(() => {
        closeDb();
        repo = new CharacterRepository(getDb(':memory:'));
        clearCombatState();
        const now = new Date().toISOString();
        repo.create({ id: 'luciel', name: 'Luciel', stats: { str: 30, dex: 14, con: 20, int: 12, wis: 12, cha: 16 }, hp: 200, maxHp: 200, ac: 20, level: 15, createdAt: now, updatedAt: now } as any);
        repo.create({ id: 'duelist', name: 'Duelist', stats: { str: 10, dex: 30, con: 10, int: 10, wis: 10, cha: 10 }, hp: 500, maxHp: 500, ac: 15, level: 5, createdAt: now, updatedAt: now } as any);
    });
    afterEach(() => closeDb());

    it('crits only on a natural 20, however far the DC is beaten', async () => {
        for (let i = 0; i < 25; i++) {
            const r = await stunt({ modifier: 30 });
            expect(r.criticalSuccess).toBe(r.natural === 20);
        }
    });

    it('doubles damage dice on a crit, never the modifier', async () => {
        for (let i = 0; i < 25; i++) {
            const r = await stunt({ modifier: 30, successDamage: '1d1+5', targetIds: ['duelist'] });
            if (r.natural === 1) continue; // a natural 1 fails the stunt
            expect(r.damage).toBe(r.criticalSuccess ? 7 : 6);
        }
    });

    it('accepts a plain number and never doubles it', async () => {
        let r = await stunt({ modifier: 30, successDamage: '8', targetIds: ['duelist'] });
        while (r.natural === 1) r = await stunt({ modifier: 30, successDamage: '8', targetIds: ['duelist'] });
        expect(r.damage).toBe(8);
    });

    it("adds the target's ability modifier to its save", async () => {
        for (let i = 0; i < 10; i++) {
            const r = await stunt({ modifier: 30, successDamage: '1d1+5', targetIds: ['duelist'], savingThrowAbility: 'dex', savingThrowDc: 11, halfDamageOnSave: true });
            if (r.natural === 1) continue;
            // DEX 30 (+10): d20 + 10 always reaches DC 11.
            expect(r.targets[0].saved).toBe(true);
        }
    });

    it('puts the damage on the encounter token when an encounterId is given', async () => {
        const created = data(await handleCombatManage({ action: 'create', seed: 'stunt-enc', participants: [
            { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 20 },
            { id: 'duelist', name: 'Duelist', hp: 500, maxHp: 500, initiative: 5, isEnemy: true }
        ] }, ctx as any));
        let r = await stunt({ modifier: 30, successDamage: '8', targetIds: ['duelist'], encounterId: created.encounterId });
        while (r.natural === 1) r = await stunt({ modifier: 30, successDamage: '8', targetIds: ['duelist'], encounterId: created.encounterId });
        expect(r.encounterTokensUpdated).toBe(true);
        const row = getDb().prepare('SELECT tokens FROM encounters WHERE id = ?').get(created.encounterId) as { tokens: string };
        const tok = JSON.parse(row.tokens).find((t: any) => t.id === 'duelist');
        expect(tok.hp).toBe(500 - r.damage);
        expect(repo.findById('duelist')!.hp).toBe(500 - r.damage);
    });
});
