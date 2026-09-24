import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { getCombatManager } from '../../../src/server/state/combat-manager.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const ctx = { sessionId: 'adjust-hp' };

function json(res: { content: Array<{ text: string }> }) {
    const text = res.content[0].text;
    const m = text.match(/<!-- COMBAT_MANAGE_JSON\n([\s\S]*?)\nCOMBAT_MANAGE_JSON -->/);
    if (m) return JSON.parse(m[1]);
    try { return JSON.parse(text); } catch { return { rawText: text }; }
}

async function call(args: Record<string, unknown>) {
    return json(await handleCombatManage(args, ctx as any));
}

/**
 * Field report: correcting a wrong HP total mid-encounter meant posting a
 * "heal" from an unrelated participant. adjust_hp is the bookkeeping verb:
 * it sets or shifts HP with a required reason and logs it as a correction.
 */
describe('combat_manage adjust_hp', () => {
    let encounterId: string;
    let repo: CharacterRepository;

    beforeEach(async () => {
        closeDb();
        repo = new CharacterRepository(getDb(':memory:'));
        clearCombatState();
        const now = new Date().toISOString();
        repo.create({ id: 'justicar', name: 'Justicar', stats: { str: 18, dex: 12, con: 16, int: 10, wis: 12, cha: 10 }, hp: 90, maxHp: 120, ac: 18, level: 8, createdAt: now, updatedAt: now } as any);
        const created = await call({ action: 'create', seed: 'adjust', participants: [
            { id: 'justicar', name: 'Justicar', hp: 90, maxHp: 120, initiative: 15 },
            { id: 'token-cultist', name: 'Cultist', hp: 12, maxHp: 12, initiative: 5, isEnemy: true }
        ] });
        encounterId = created.encounterId;
    });

    afterEach(() => closeDb());

    it('sets HP to a value, writes it to the character row and logs the reason', async () => {
        const r = await call({ action: 'adjust_hp', encounterId, participantId: 'justicar', value: 74, reason: 'double-applied volley last round' });
        expect(r.success).toBe(true);
        expect(r.before).toBe(90);
        expect(r.after).toBe(74);
        expect(repo.findById('justicar')!.hp).toBe(74);

        const hist = await call({ action: 'get_history', encounterId });
        const entry = hist.actions.find((a: any) => a.action === 'adjust_hp');
        expect(entry.summary).toMatch(/double-applied volley last round/);
        expect(entry.damage ?? null).toBeNull();
        expect(entry.healing ?? null).toBeNull();
        expect(entry.hpChanges).toEqual({ justicar: { before: 90, after: 74 } });
    });

    it('applies a delta and clamps to 0..maxHp, saying it clamped', async () => {
        const up = await call({ action: 'adjust_hp', encounterId, participantId: 'justicar', delta: 500, reason: 'restore' });
        expect(up.after).toBe(120);
        expect(up.clamped).toBe(true);
        const down = await call({ action: 'adjust_hp', encounterId, participantId: 'token-cultist', delta: -30, reason: 'posted overkill' });
        expect(down.after).toBe(0);
        expect(down.defeated).toBe(true);
    });

    it('works for a token with no character row, and survives a reload from the database', async () => {
        await call({ action: 'adjust_hp', encounterId, participantId: 'token-cultist', value: 5, reason: 'wrong starting HP' });
        getCombatManager().clear();
        const state = await call({ action: 'get', encounterId });
        const cultist = (state.participants ?? state.state?.participants).find((p: any) => p.id === 'token-cultist');
        expect(cultist.hp).toBe(5);
    });

    it('resets death saves when lifted off 0, and refuses to raise the dead without revive', async () => {
        await call({ action: 'adjust_hp', encounterId, participantId: 'justicar', value: 0, reason: 'downed' });
        const back = await call({ action: 'adjust_hp', encounterId, participantId: 'justicar', value: 10, reason: 'stim' });
        expect(back.after).toBe(10);
        expect(back.deathSaves).toEqual({ successes: 0, failures: 0 });

        const engine = getCombatManager().get(`${ctx.sessionId}:${encounterId}`)!;
        const j = engine.getState()!.participants.find(p => p.id === 'justicar')!;
        j.hp = 0; (j as any).isDead = true;
        const refused = await call({ action: 'adjust_hp', encounterId, participantId: 'justicar', value: 10, reason: 'oops' });
        expect(refused.error).toBeTruthy();
        const revived = await call({ action: 'adjust_hp', encounterId, participantId: 'justicar', value: 10, reason: 'apothecary rite', revive: true });
        expect(revived.after).toBe(10);
    });

    it('refuses value and delta together, and a missing reason', async () => {
        expect((await call({ action: 'adjust_hp', encounterId, participantId: 'justicar', value: 5, delta: 5, reason: 'x' })).error).toBeTruthy();
        expect((await call({ action: 'adjust_hp', encounterId, participantId: 'justicar', value: 5 })).error).toBeTruthy();
        expect(repo.findById('justicar')!.hp).toBe(90);
    });
});
