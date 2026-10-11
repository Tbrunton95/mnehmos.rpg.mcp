/**
 * Play report 2, item 17: fighting styles. archery adds +2 to hit on a
 * ranged attack; great_weapon rerolls weapon dice of 1 or 2 once on a
 * two-handed melee hit (crit dice too, never added dice); dueling adds +2
 * damage to a one-handed melee hit; defense adds +1 to a target's derived
 * AC when it wears armour. A GM-posted outcome takes none of it.
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, resolveReadiedAttack } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { fightingStyleEffects, GWF_REROLL_AT_OR_BELOW } from '../../src/engine/combat/fighting-style.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { cryptoInt } from '../../src/math/crypto-dice.js';

// Unseeded fights roll crypto dice; the tests pin them one draw at a time.
vi.mock('../../src/math/crypto-dice.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/math/crypto-dice.js')>();
    return { ...actual, cryptoInt: vi.fn(actual.cryptoInt) };
});

const ctx = { sessionId: 'unscoped' };
const manage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const action = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;
const act = async (args: Record<string, unknown>) => {
    const text = (await action({ action: 'attack', encounterId: enc, ...args })).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, d, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
/** Pin the next crypto draws in order; anything past the queue rolls its maximum. */
const pin = (...values: number[]) => { const q = [...values]; vi.mocked(cryptoInt).mockImplementation((sides: number) => q.shift() ?? sides); };

type Sheet = Record<string, unknown>;
async function setup(fighter: Sheet, foe: Sheet = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    const repo = new CharacterRepository(db);
    repo.create({ id: 'brannoc', name: 'Brannoc', characterType: 'pc', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 }, hp: 44, maxHp: 44, ac: 18, level: 5,
        createdAt: now, updatedAt: now, ...fighter } as any);
    repo.create({ id: 'orc', name: 'Orc', characterType: 'npc', stats: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 }, hp: 30, maxHp: 30, ac: 13, level: 2,
        createdAt: now, updatedAt: now, ...foe } as any);
    enc = tag((await manage({ action: 'create', participants: [
        { id: 'brannoc', name: 'Brannoc', hp: 44, maxHp: 44, initiative: 20, position: { x: 0, y: 0 } },
        { id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 10, isEnemy: true, position: { x: 1, y: 0 } }
    ] })).content[0].text, 'COMBAT_MANAGE').encounterId;
}

afterEach(() => { vi.mocked(cryptoInt).mockReset(); closeDb(); clearCombatState(); });

describe('fightingStyleEffects (pure)', () => {
    it('applies each style only in its own context, and nothing to a posted outcome', () => {
        expect(fightingStyleEffects('archery', { ranged: true })).toMatchObject({ style: 'archery', applied: true, attackBonus: 2 });
        expect(fightingStyleEffects('archery', { ranged: false })).toMatchObject({ style: 'archery', applied: false });
        expect(fightingStyleEffects('great_weapon', { twoHanded: true })).toMatchObject({ style: 'great_weapon', applied: true, rerollAtOrBelow: GWF_REROLL_AT_OR_BELOW });
        expect(fightingStyleEffects('great_weapon', { twoHanded: true, ranged: true })).toMatchObject({ applied: false });
        expect(fightingStyleEffects('great_weapon', { twoHanded: false })).toMatchObject({ applied: false });
        expect(fightingStyleEffects('dueling', {})).toMatchObject({ style: 'dueling', applied: true, damageBonus: 2 });
        expect(fightingStyleEffects('dueling', { twoHanded: true })).toMatchObject({ applied: false });
        expect(fightingStyleEffects('dueling', { offhand: true })).toMatchObject({ applied: false });
        expect(fightingStyleEffects('dueling', { ranged: true })).toMatchObject({ applied: false });
        expect(fightingStyleEffects('defense', {})).toMatchObject({ style: 'defense', applied: false });
        for (const style of ['archery', 'great_weapon', 'dueling', 'defense'] as const) {
            expect(fightingStyleEffects(style, { ranged: true, twoHanded: true, resolved: true })).toBeUndefined();
        }
        expect(fightingStyleEffects(undefined, {})).toBeUndefined();
    });
});

describe('great weapon fighting', () => {
    const gwf = { fightingStyle: 'great_weapon', attacks: [
        { name: 'greatsword', attackBonus: 7, damage: '2d6+4', damageType: 'slashing', twoHanded: true, default: true },
        { name: 'longbow', attackBonus: 5, damage: '1d8+2', damageType: 'piercing', ranged: true, twoHanded: true },
        { name: 'shortsword', attackBonus: 7, damage: '1d6+4', damageType: 'piercing' }
    ] };

    it('rerolls weapon dice of 1 or 2 once on a two-handed melee hit, reports and logs them', async () => {
        await setup(gwf);
        pin(15, 1, 2, 5, 4);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', using: 'greatsword' });
        expect(r.roll.hit).toBe(true);
        expect(r.fightingStyle).toMatchObject({ style: 'great_weapon', applied: true, rerolls: [{ sides: 6, from: 1, to: 5 }, { sides: 6, from: 2, to: 4 }] });
        expect(r.damage).toMatchObject({ total: 13, rolls: [5, 4] });
        expect(tok('orc').hp).toBe(17);
        expect(r.situational).toEqual(expect.arrayContaining([expect.stringMatching(/great weapon fighting rerolled 2: 1→5, 2→4/)]));
        const rolls = queryRolls(getDb(), { encounterId: enc, limit: 20 }) as any[];
        const reroll = rolls.find(x => x.purpose === 'damage reroll (great weapon fighting)');
        expect(reroll).toBeTruthy();
        expect(reroll.dice.map((d: any) => d.value)).toEqual([5, 4]);
    });

    it('rerolls the crit dice too', async () => {
        await setup(gwf);
        pin(20, 1, 6, 5, 2, 6, 4);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', using: 'greatsword' });
        expect(r.roll.crit).toBe(true);
        expect(r.damage).toMatchObject({ total: 25, rolls: [5, 6, 4, 6] });
        expect(r.fightingStyle.rerolls).toEqual([{ sides: 6, from: 1, to: 5 }, { sides: 6, from: 2, to: 4 }]);
    });

    it('a miss rerolls nothing and logs no reroll', async () => {
        await setup(gwf);
        pin(2, 1, 1, 6, 6);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', using: 'greatsword' });
        expect(r.roll.hit).toBe(false);
        expect(r.fightingStyle?.rerolls).toBeUndefined();
        const rolls = queryRolls(getDb(), { encounterId: enc, limit: 20 }) as any[];
        expect(rolls.some(x => /reroll/.test(x.purpose))).toBe(false);
    });

    it('not on a ranged two-handed weapon, a one-handed weapon, or a posted outcome', async () => {
        await setup(gwf);
        pin(15, 1);
        const bow = await act({ actorId: 'brannoc', targetId: 'orc', using: 'longbow' });
        expect(bow.r.fightingStyle).toMatchObject({ style: 'great_weapon', applied: false });
        expect(bow.r.damage.rolls).toEqual([1]);
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        pin(15, 1);
        const short = await act({ actorId: 'brannoc', targetId: 'orc', using: 'shortsword' });
        expect(short.r.fightingStyle).toMatchObject({ applied: false });
        expect(short.r.damage.rolls).toEqual([1]);
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        pin(1, 1);
        const posted = await act({ actorId: 'brannoc', targetId: 'orc', using: 'greatsword', outcome: 'hit' });
        expect(posted.r.fightingStyle).toBeUndefined();
        expect(posted.r.damage.rolls).toEqual([1, 1]);
    });

    it('twoHanded on the call makes a versatile weapon two-handed for that swing', async () => {
        await setup(gwf);
        pin(15, 1, 5);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', using: 'shortsword', twoHanded: true });
        expect(r.fightingStyle).toMatchObject({ applied: true, rerolls: [{ sides: 6, from: 1, to: 5 }] });
        expect(r.damage.total).toBe(9);
    });

    it('an opportunity attack and a readied attack by a great_weapon token reroll on the fight\'s dice', () => {
        const engineWith = (seed: string) => {
            const engine = new CombatEngine(seed);
            engine.startEncounter([
                { id: 'f', name: 'Fighter', initiativeBonus: 0, initiative: 20, hp: 40, maxHp: 40, conditions: [], position: { x: 0, y: 0 }, fightingStyle: 'great_weapon',
                    attacks: [{ name: 'maul', attackBonus: 30, damage: '2d6+4', twoHanded: true, default: true }] },
                { id: 'o', name: 'Orc', initiativeBonus: 0, initiative: 10, hp: 300, maxHp: 300, conditions: [], ac: 10, position: { x: 1, y: 0 } }
            ] as CombatParticipant[]);
            return engine;
        };
        let seen = 0;
        for (let i = 0; i < 40 && seen < 2; i++) {
            const engine = engineWith(`oa-gwf-${i}`);
            const oa = engine.executeOpportunityAttack('f', 'o');
            if (oa.fightingStyle?.rerolls?.length) {
                seen++;
                for (const re of oa.fightingStyle.rerolls) expect(re.from).toBeLessThanOrEqual(2);
                expect(oa.fightingStyle.style).toBe('great_weapon');
            }
        }
        expect(seen).toBeGreaterThan(0);
        seen = 0;
        for (let i = 0; i < 40 && seen < 1; i++) {
            const engine = engineWith(`ready-gwf-${i}`);
            const state = engine.getState()!;
            const [f, o] = ['f', 'o'].map(id => state.participants.find(p => p.id === id)!);
            const r = resolveReadiedAttack(engine, f, o, { using: 'maul' });
            if (r.fightingStyle?.rerolls?.length) seen++;
        }
        expect(seen).toBe(1);
    });
});

describe('dueling and archery', () => {
    const duelist = { fightingStyle: 'dueling', attacks: [
        { name: 'rapier', attackBonus: 7, damage: '1d8+4', damageType: 'piercing', default: true },
        { name: 'greatsword', attackBonus: 7, damage: '2d6+4', twoHanded: true },
        { name: 'hand crossbow', attackBonus: 5, damage: '1d6+2', ranged: true }
    ] };

    it('dueling adds +2 damage to a one-handed melee hit only', async () => {
        await setup(duelist);
        pin(15, 3);
        const rapier = await act({ actorId: 'brannoc', targetId: 'orc', using: 'rapier' });
        expect(rapier.r.fightingStyle).toMatchObject({ style: 'dueling', applied: true, damageBonus: 2 });
        expect(rapier.r.damage.total).toBe(9);
        expect(tok('orc').hp).toBe(21);
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        pin(15, 3, 3);
        const great = await act({ actorId: 'brannoc', targetId: 'orc', using: 'greatsword' });
        expect(great.r.fightingStyle).toMatchObject({ applied: false });
        expect(great.r.damage.total).toBe(10);
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        pin(15, 3);
        const off = await act({ actorId: 'brannoc', targetId: 'orc', using: 'rapier', hand: 'offhand' });
        expect(off.r.fightingStyle).toMatchObject({ applied: false });
        expect(off.r.damage.total).toBe(7);
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        pin(15, 3);
        const bow = await act({ actorId: 'brannoc', targetId: 'orc', using: 'hand crossbow' });
        expect(bow.r.fightingStyle).toMatchObject({ applied: false });
        expect(bow.r.damage.total).toBe(5);
    });

    it('dueling is off while a second weapon is equipped in the off hand; a shield there is fine', async () => {
        await setup(duelist);
        const now = new Date().toISOString();
        const give = (id: string, type: string) => {
            getDb().prepare("INSERT INTO items (id, name, type, weight, value, created_at, updated_at) VALUES (?, ?, ?, 2, 10, ?, ?)").run(id, id, type, now, now);
            getDb().prepare('INSERT INTO inventory_items (character_id, item_id, quantity, equipped, slot) VALUES (?, ?, 1, 1, ?)').run('brannoc', id, 'offhand');
        };
        give('shield', 'armor');
        pin(15, 3);
        const withShield = await act({ actorId: 'brannoc', targetId: 'orc', using: 'rapier' });
        expect(withShield.r.fightingStyle).toMatchObject({ applied: true, damageBonus: 2 });
        getDb().prepare("DELETE FROM inventory_items WHERE item_id = 'shield'").run();
        give('dagger', 'weapon');
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        pin(15, 3);
        const twoBlades = await act({ actorId: 'brannoc', targetId: 'orc', using: 'rapier' });
        expect(twoBlades.r.fightingStyle).toMatchObject({ applied: false, note: expect.stringMatching(/second weapon/) });
        expect(twoBlades.r.damage.total).toBe(7);
    });

    it('dueling does not land on a miss', async () => {
        await setup(duelist);
        pin(1, 8);
        const { r } = await act({ actorId: 'brannoc', targetId: 'orc', using: 'rapier' });
        expect(r.roll.hit).toBe(false);
        expect(r.damage.total).toBe(0);
        expect(r.fightingStyle).toMatchObject({ style: 'dueling', applied: true });
        expect(r.fightingStyle.damageBonus).toBeUndefined();
        expect(tok('orc').hp).toBe(30);
    });

    it('archery adds +2 to hit with a ranged profile or ranged: true, not in melee', async () => {
        await setup({ fightingStyle: 'archery', attacks: [
            { name: 'longbow', attackBonus: 5, damage: '1d8+2', ranged: true, default: true },
            { name: 'dagger', attackBonus: 5, damage: '1d4+2' }
        ] });
        pin(10, 4);
        const bow = await act({ actorId: 'brannoc', targetId: 'orc', using: 'longbow' });
        expect(bow.r.roll.bonus).toBe(7);
        expect(bow.r.roll.total).toBe(17);
        expect(bow.r.fightingStyle).toMatchObject({ style: 'archery', applied: true, attackBonus: 2 });
        expect(bow.r.situational).toEqual(expect.arrayContaining([expect.stringMatching(/archery \+2 to hit/)]));
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        pin(10, 4);
        const dagger = await act({ actorId: 'brannoc', targetId: 'orc', using: 'dagger' });
        expect(dagger.r.roll.bonus).toBe(5);
        expect(dagger.r.fightingStyle).toMatchObject({ applied: false });
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        pin(10, 4);
        const thrown = await act({ actorId: 'brannoc', targetId: 'orc', using: 'dagger', ranged: true });
        expect(thrown.r.roll.bonus).toBe(7);
    });

    it('a profile without ranged set is read from the grid: a shot from beyond reach is ranged', async () => {
        await setup({ fightingStyle: 'dueling', attacks: [{ name: 'sling', attackBonus: 5, damage: '1d4+2', default: true }] });
        await manage({ action: 'remove_participant', encounterId: enc, participantId: 'orc' });
        await manage({ action: 'add_participant', encounterId: enc, name: 'Far Orc', hp: 30, maxHp: 30, ac: 13, isEnemy: true, position: { x: 8, y: 0 } });
        const far = new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.name === 'Far Orc')!;
        pin(15, 2);
        const { r } = await act({ actorId: 'brannoc', targetId: far.id, using: 'sling' });
        expect(r.fightingStyle).toMatchObject({ style: 'dueling', applied: false });
        expect(r.damage.total).toBe(4);
    });
});

describe('defense', () => {
    const hold = (characterId: string, itemId: string, slot: string) => {
        const now = new Date().toISOString();
        getDb().prepare("INSERT INTO items (id, name, type, weight, value, created_at, updated_at) VALUES (?, ?, 'armor', 20, 50, ?, ?)").run(itemId, itemId, now, now);
        getDb().prepare('INSERT INTO inventory_items (character_id, item_id, quantity, equipped, slot) VALUES (?, ?, 1, 1, ?)').run(characterId, itemId, slot);
    };

    it('+1 to a derived AC when the target wears armour; named in the result', async () => {
        await setup({ attacks: [{ name: 'sword', attackBonus: 7, damage: '1d8+3', default: true }] }, { fightingStyle: 'defense' });
        hold('orc', 'chain-shirt', 'armor');
        pin(6, 4);
        const { r, text } = await act({ actorId: 'brannoc', targetId: 'orc' });
        expect(r.roll.targetAc).toBe(14);
        expect(r.roll.hit).toBe(false);
        expect(r.fightingStyle).toMatchObject({ targetDefense: { style: 'defense', acBonus: 1 } });
        expect(text).toMatch(/Orc defense \+1 AC \(armour worn\)/);
    });

    it('no bonus without armour, with a dc passed, or against an aimed part with its own AC', async () => {
        await setup({ attacks: [{ name: 'sword', attackBonus: 7, damage: '1d8+3', default: true }] }, { fightingStyle: 'defense', parts: [{ name: 'shield arm', kind: 'arm', ac: 16 }] });
        pin(6, 4);
        expect((await act({ actorId: 'brannoc', targetId: 'orc' })).r.roll.targetAc).toBe(13);
        hold('orc', 'chain-shirt', 'armor');
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        pin(6, 4);
        expect((await act({ actorId: 'brannoc', targetId: 'orc', dc: 13 })).r.roll.targetAc).toBe(13);
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        pin(6, 4);
        expect((await act({ actorId: 'brannoc', targetId: 'orc', atPart: 'shield arm' })).r.roll.targetAc).toBe(16);
        await manage({ action: 'advance', encounterId: enc }); await manage({ action: 'advance', encounterId: enc });
        pin(6, 4);
        expect((await act({ actorId: 'brannoc', targetId: 'orc' })).r.roll.targetAc).toBe(14);
    });
});

describe('fighting style on the token', () => {
    it('hydrates from the sheet and is kept in the stored token', async () => {
        await setup({ fightingStyle: 'archery' });
        expect(tok('brannoc').fightingStyle).toBe('archery');
        expect(tok('orc').fightingStyle).toBeUndefined();
    });
});
