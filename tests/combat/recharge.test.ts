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
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
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

    it('grantsAction (Action Surge) spends no action, banks one extra, is spent on use and refused again', async () => {
        const enc = await dragonFight({ abilities: [{ name: 'Action Surge', grantsAction: true }] });
        const { d } = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'action surge' });
        expect(d).toMatchObject({ success: true, grantsAction: true, actionCost: 'none', extraActions: 1, ready: false });
        expect(d.message).toMatch(/⚡ Red Dragon uses Action Surge: one extra action this turn/);
        const dragon = tok(enc, 'dragon');
        expect(dragon.actionUsed).toBeFalsy();
        expect(dragon.extraActions).toBe(1);
        expect(dragon.abilities[0].ready).toBe(false);
        const again = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Action Surge' });
        expect(again.d).toMatchObject({ error: true, writes: 'none' });
        expect(again.d.message).toMatch(/restore_ability/);
        expect(again.d.message).not.toMatch(/recharge \?/);
        expect(tok(enc, 'dragon').extraActions).toBe(1);
    });

    it('grantsAction is refused off its own turn, writing nothing', async () => {
        const enc = await dragonFight({ abilities: [{ name: 'Action Surge', grantsAction: true }] });
        await manage({ action: 'advance', encounterId: enc }); // hero's turn
        const { d } = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Action Surge' });
        expect(d).toMatchObject({ error: true, writes: 'none' });
        expect(d.message).toMatch(/not Red Dragon's turn \(Hero is acting\)/);
        const dragon = tok(enc, 'dragon');
        expect(dragon.abilities[0].ready).toBe(true);
        expect(dragon.extraActions ?? 0).toBe(0);
    });

    it("actionCost 'bonus' spends the bonus action and 'none' spends nothing", async () => {
        const enc = await dragonFight({ abilities: [{ name: 'Quick Bite', actionCost: 'bonus' }, { name: 'Glare', actionCost: 'none' }] });
        const bite = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Quick Bite' });
        expect(bite.d).toMatchObject({ success: true, actionCost: 'bonus' });
        expect(tok(enc, 'dragon').bonusActionUsed).toBe(true);
        expect(tok(enc, 'dragon').actionUsed).toBeFalsy();
        const biteAgain = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Quick Bite' });
        expect(biteAgain.d.error).toBe(true);
        expect(biteAgain.d.message).toMatch(/Bonus Action already used/);
        const glare = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Glare' });
        expect(glare.d).toMatchObject({ success: true, actionCost: 'none' });
        expect(glare.d.message).toMatch(/\(free\)/);
        expect(tok(enc, 'dragon').actionUsed).toBeFalsy();
        // A free ability is not spent either (no recharge, no granted action).
        expect(tok(enc, 'dragon').abilities[1].ready).toBe(true);
    });

    it("actionCost 'action' or 'bonus' is refused off its own turn; 'reaction' and 'none' may happen off-turn", async () => {
        const enc = await dragonFight({ abilities: [
            { name: 'Quick Bite', actionCost: 'bonus' }, { name: 'Tail Lash', actionCost: 'reaction' }, { name: 'Glare', actionCost: 'none' }, { name: 'Frightful Presence' }
        ] });
        await manage({ action: 'advance', encounterId: enc }); // hero's turn
        const bite = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Quick Bite' });
        expect(bite.d).toMatchObject({ error: true, writes: 'none' });
        expect(bite.d.message).toMatch(/not Red Dragon's turn \(Hero is acting\)/);
        expect(tok(enc, 'dragon').bonusActionUsed).toBeFalsy();
        const fright = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Frightful Presence' });
        expect(fright.d).toMatchObject({ error: true, writes: 'none' });
        expect(tok(enc, 'dragon').actionUsed).toBeFalsy();
        const lash = await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Tail Lash' });
        expect(lash.d).toMatchObject({ success: true, actionCost: 'reaction' });
        expect(tok(enc, 'dragon').reactionUsed).toBe(true);
        expect((await manage({ action: 'use_ability', encounterId: enc, participantId: 'dragon', ability: 'Glare' })).d).toMatchObject({ success: true, actionCost: 'none' });
    });
});

// Item 18: a per-rest ability (Second Wind) is spent on use and stays spent
// on the sheet until rest_manage readies it; the next fight hydrates it spent.
describe('per-rest abilities', () => {
    const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
    function knight(abilities: Array<Record<string, unknown>>) {
        const now = new Date().toISOString();
        new CharacterRepository(getDb()).create({ id: 'knight', name: 'Knight', characterType: 'pc', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
            hp: 40, maxHp: 40, ac: 18, level: 5, abilities, createdAt: now, updatedAt: now } as any);
    }
    const fight = async (extra: Record<string, unknown> = {}) => (await manage({ action: 'create', seed: 'per-rest', participants: [
        { id: 'knight', name: 'Knight', hp: 40, maxHp: 40, initiative: 20, ...extra },
        { id: 'gob', name: 'Goblin', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
    ] })).d.encounterId as string;

    it('use_ability spends a perRest ability on the token and the sheet; a recharge-only spend stays on the token', async () => {
        knight([{ name: 'Second Wind', perRest: 'short' }, { name: 'Fire Breath', recharge: 5, actionCost: 'none' }]);
        const enc = await fight();
        const { d } = await manage({ action: 'use_ability', encounterId: enc, participantId: 'knight', ability: 'second wind' });
        expect(d).toMatchObject({ success: true, ready: false, mirroredToCharacter: true });
        expect(d.message).toMatch(/Second Wind is spent until a short rest/);
        expect(tok(enc, 'knight').abilities[0].ready).toBe(false);
        expect(sheet('knight').abilities[0].ready).toBe(false);
        // The action is spent too: a second use is refused as spent, writing nothing.
        const again = await manage({ action: 'use_ability', encounterId: enc, participantId: 'knight', ability: 'Second Wind' });
        expect(again.d).toMatchObject({ error: true, writes: 'none' });
        expect(again.d.message).toMatch(/spent until a short rest/);
        // Recharge spends never reach the sheet.
        const breath = await manage({ action: 'use_ability', encounterId: enc, participantId: 'knight', ability: 'Fire Breath' });
        expect(breath.d.success).toBe(true);
        expect(tok(enc, 'knight').abilities[1].ready).toBe(false);
        expect(sheet('knight').abilities[1].ready).toBe(true);
    });

    it('the next fight hydrates a spent perRest ability spent, with or without caller abilities', async () => {
        knight([{ name: 'Second Wind', perRest: 'short' }]);
        const first = await fight();
        await manage({ action: 'use_ability', encounterId: first, participantId: 'knight', ability: 'Second Wind' });
        await manage({ action: 'end', encounterId: first });
        const omitted = await fight();
        expect(tok(omitted, 'knight').abilities[0]).toMatchObject({ name: 'Second Wind', perRest: 'short', ready: false });
        await manage({ action: 'end', encounterId: omitted });
        // The live client resends the statline without a ready flag: the sheet's spent state wins.
        const resent = await fight({ abilities: [{ name: 'Second Wind', perRest: 'short' }] });
        expect(tok(resent, 'knight').abilities[0].ready).toBe(false);
        await manage({ action: 'end', encounterId: resent });
        // An explicit ready: true from the caller is honoured.
        const explicit = await fight({ abilities: [{ name: 'Second Wind', perRest: 'short', ready: true }] });
        expect(tok(explicit, 'knight').abilities[0].ready).toBe(true);
    });

    it('add_participant with a resent statline keeps the sheet\'s spent perRest ability too (any case)', async () => {
        knight([{ name: 'Second Wind', perRest: 'short', ready: false }]);
        const enc = (await manage({ action: 'create', seed: 'per-rest-add', participants: [
            { id: 'gob', name: 'Goblin', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ] })).d.encounterId as string;
        const added = await manage({ action: 'add_participant', encounterId: enc, characterId: 'knight', abilities: [{ name: 'second wind', perRest: 'short' }] });
        expect(added.d.success).toBe(true);
        expect(tok(enc, 'knight').abilities[0]).toMatchObject({ name: 'second wind', perRest: 'short', ready: false });
        // An explicit ready: true from the caller is honoured here as on create.
        const enc2 = (await manage({ action: 'create', seed: 'per-rest-add-2', participants: [
            { id: 'gob', name: 'Goblin', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ] })).d.encounterId as string;
        await manage({ action: 'add_participant', encounterId: enc2, characterId: 'knight', abilities: [{ name: 'Second Wind', perRest: 'short', ready: true }] });
        expect(tok(enc2, 'knight').abilities[0].ready).toBe(true);
    });

    it('battle_cry spends a perRest ability on the token and the sheet', async () => {
        knight([{ name: 'Waaagh!', perRest: 'long' }]);
        const enc = await fight();
        const { d } = await manage({ action: 'battle_cry', encounterId: enc, participantId: 'knight', name: 'Waaagh!', ability: 'Waaagh!', attackAdvantage: true });
        expect(d).toMatchObject({ success: true, ability: { name: 'Waaagh!', ready: false } });
        expect(d.message).toMatch(/spent until a long rest/);
        expect(tok(enc, 'knight').abilities[0].ready).toBe(false);
        expect(sheet('knight').abilities[0].ready).toBe(false);
        const again = await manage({ action: 'battle_cry', encounterId: enc, participantId: 'knight', name: 'Waaagh!', ability: 'Waaagh!', attackAdvantage: true });
        expect(again.d).toMatchObject({ error: true, writes: 'none' });
        expect(again.d.message).toMatch(/spent until a long rest/);
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
