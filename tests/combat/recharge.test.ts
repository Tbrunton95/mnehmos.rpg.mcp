/**
 * Item 13: recharge abilities, use_ability, and the lair on a proper
 * initiative-20 slot.
 */
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';

// The operation guard flushes engine dice for the unscoped session key.
const ctx = { sessionId: 'unscoped' };
const guarded = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const manage = async (args: Record<string, unknown>) => {
    const text = (await guarded(args)).content[0].text;
    return { text, d: tag(text, 'COMBAT_MANAGE') };
};
const tok = (enc: string, id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;

beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
afterEach(() => closeDb());

async function dragonFight(dragon: Record<string, unknown> = {}, extra: Array<Record<string, unknown>> = []) {
    const { d } = await manage({ action: 'create', seed: 'recharge', participants: [
        { id: 'dragon', name: 'Red Dragon', hp: 200, maxHp: 200, ac: 18, initiative: 25, isEnemy: true,
            abilities: [{ name: 'Fire Breath', recharge: 5 }], ...dragon },
        { id: 'hero', name: 'Hero', hp: 60, maxHp: 60, ac: 15, initiative: 10 },
        { id: 'squire', name: 'Squire', hp: 60, maxHp: 60, ac: 12, initiative: 5 },
        ...extra
    ] });
    return d.encounterId as string;
}

describe('recharge at the start of the turn', () => {
    function engineWith(ready: boolean) {
        const engine = new CombatEngine('recharge-seed');
        const parts: CombatParticipant[] = [
            { id: 'wyrm', name: 'Wyrm', initiativeBonus: 0, initiative: 20, hp: 100, maxHp: 100, conditions: [], abilities: [{ name: 'Acid Breath', recharge: 5, ready }] } as CombatParticipant,
            { id: 'hero', name: 'Hero', initiativeBonus: 0, initiative: 10, hp: 50, maxHp: 50, conditions: [] } as CombatParticipant
        ];
        engine.startEncounter(parts);
        return engine;
    }

    it('a spent ability rolls a d6 at its turn start; ready on the recharge number or more', () => {
        const engine = engineWith(false);
        engine.nextTurnWithConditions(); // hero
        engine.nextTurnWithConditions(); // wyrm, round 2
        const note = engine.turnStartNotes.find(n => /Acid Breath/.test(n))!;
        expect(note).toMatch(/Acid Breath (recharges|does not recharge) \(d6=\d, needs 5\+\)/);
        const d6 = Number(note.match(/d6=(\d)/)![1]);
        const wyrm = engine.getState()!.participants.find(p => p.id === 'wyrm')!;
        expect(wyrm.abilities![0].ready).toBe(d6 >= 5);
    });

    it('a ready ability rolls nothing', () => {
        const engine = engineWith(true);
        engine.nextTurnWithConditions();
        engine.nextTurnWithConditions();
        expect(engine.turnStartNotes.some(n => /Acid Breath/.test(n))).toBe(false);
    });

    it('rolls on the seeded stream: the same seed gives the same die', () => {
        const a = engineWith(false); a.nextTurnWithConditions(); a.nextTurnWithConditions();
        const b = engineWith(false); b.nextTurnWithConditions(); b.nextTurnWithConditions();
        expect(a.turnStartNotes).toEqual(b.turnStartNotes);
    });
});

describe('combat_manage use_ability', () => {
    it('resolves a breath weapon: one damage roll, a save per target, spent and logged', async () => {
        const enc = await dragonFight();
        const { d } = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'fire breath',
            targetIds: ['hero', 'squire'], damage: '6d6', damageType: 'fire', savingThrow: { ability: 'dex', dc: 15 } });
        expect(d.error).toBeFalsy();
        expect(d.targets).toHaveLength(2);
        expect(d.damageRolled).toBeGreaterThanOrEqual(6);
        for (const t of d.targets) {
            expect(t.damageTaken).toBe(t.saved ? Math.floor(d.damageRolled / 2) : d.damageRolled);
            expect(tok(enc, t.targetId).hp).toBe(60 - t.damageTaken);
        }
        expect(tok(enc, 'dragon').abilities[0].ready).toBe(false);
        expect(tok(enc, 'dragon').actionUsed).toBe(true);
        const rolls = queryRolls(getDb(), { encounterId: enc, limit: 50 }) as any[];
        expect(rolls.some(r => /Fire Breath damage/.test(r.purpose))).toBe(true);
        expect(rolls.filter(r => /Fire Breath save \(dexterity\)/.test(r.purpose))).toHaveLength(2);
    });

    it('refuses a spent ability and writes nothing', async () => {
        const enc = await dragonFight({ abilities: [{ name: 'Fire Breath', recharge: 5, ready: false }] });
        const { d } = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Fire Breath', targetIds: ['hero'], damage: 10 });
        expect(d.error).toBe(true);
        expect(d.message).toMatch(/not recharged/);
        expect(tok(enc, 'hero').hp).toBe(60);
        expect(tok(enc, 'dragon').actionUsed).toBeFalsy();
    });

    it('refuses an unknown ability, listing the known ones', async () => {
        const enc = await dragonFight();
        const { d } = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Tail Sweep' });
        expect(d.error).toBe(true);
        expect(d.message).toMatch(/Fire Breath/);
    });

    it('spends the action: a second use in the turn is refused', async () => {
        const enc = await dragonFight({ abilities: [{ name: 'Frightful Presence' }] });
        expect((await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Frightful Presence' })).d.error).toBeFalsy();
        // No recharge: it stays ready.
        expect(tok(enc, 'dragon').abilities[0].ready).toBe(true);
        const again = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Frightful Presence' });
        expect(again.d.error).toBe(true);
        expect(again.d.message).toMatch(/Action already used/);
    });
});

describe('lair on initiative 20', () => {
    it('a creature that rolled 20 acts before the lair (the lair loses ties)', () => {
        const engine = new CombatEngine('tie');
        const state = engine.startEncounter([
            { id: 'dragon', name: 'Dragon', initiativeBonus: 0, initiative: 5, hp: 200, maxHp: 200, conditions: [], hasLairActions: true },
            { id: 'rogue', name: 'Rogue', initiativeBonus: 0, initiative: 20, hp: 30, maxHp: 30, conditions: [] }
        ] as CombatParticipant[]);
        expect(state.turnOrder).toEqual(['rogue', 'LAIR', 'dragon']);
    });

    it('the tie order survives a reload from the database', async () => {
        const enc = await dragonFight({ hasLairActions: true, initiative: 5 }, [{ id: 'rogue', name: 'Rogue', hp: 30, maxHp: 30, initiative: 20 }]);
        clearCombatState();
        const order = new EncounterRepository(getDb()).loadState(enc)!.turnOrder;
        expect(order.indexOf('rogue')).toBeLessThan(order.indexOf('LAIR'));
    });

    it('create through combat_manage with hasLairActions reaches the LAIR slot, shown in the state', async () => {
        const enc = await dragonFight({ hasLairActions: true });
        const { text } = await manage({ action: 'advance', encounterId: enc });
        expect(getOrLoadEngine(ctx as any, enc)!.isLairActionPending()).toBe(true);
        expect(text).toMatch(/LAIR ACTION PENDING/);
        expect(text).toMatch(/LAIR \(init 20\)/);
    });

    it('one lair action per round; dice damage; the second is refused', async () => {
        const enc = await dragonFight({ hasLairActions: true });
        await manage({ action: 'advance', encounterId: enc });
        const first = await manage({ action: 'lair_action', encounterId: enc, actionDescription: 'Magma erupts', targetIds: ['hero'], damage: '2d6', damageType: 'fire' });
        expect(first.d.error).toBeFalsy();
        const hp = tok(enc, 'hero').hp;
        expect(hp).toBeLessThanOrEqual(58);
        expect(hp).toBeGreaterThanOrEqual(48);
        const second = await manage({ action: 'lair_action', encounterId: enc, actionDescription: 'Again', targetIds: ['hero'], damage: 5 });
        expect(second.d.error).toBe(true);
        expect(second.text).toMatch(/already used its action this round/);
        expect(tok(enc, 'hero').hp).toBe(hp);
    });

    it('no lair turn once the owner is dead', async () => {
        const enc = await dragonFight({ hasLairActions: true, hp: 0 });
        await manage({ action: 'advance', encounterId: enc });
        const engine = getOrLoadEngine(ctx as any, enc)!;
        expect(engine.isLairActionPending()).toBe(false);
        expect(engine.getState()!.turnOrder[engine.getState()!.currentTurnIndex]).toBe('hero');
    });
});
