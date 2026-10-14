/**
 * Play report 7 follow-up, lane L review.
 *
 * 1. The roads that print no legendary resistance offer. Lane L moved the
 *    player rule into rollParticipantSave: a player-controlled creature is
 *    never spent for, it is asked. A road that prints nothing on an offer then
 *    asks nobody. Before lane L, a PC with autoLegendaryResistance had one spent
 *    there; after it, the save failed silently. The cast_spell condition loop
 *    (Hold Person), a manoeuvre's save (Trip Attack) and the stay-mounted save
 *    now print the offer: "the GM may spend one", or "ask the player". An
 *    automatic spend on the stay-mounted save says so too.
 * 2. An offer lapses when the creature's next turn starts, even when its slot
 *    comes round at 0 HP and passes. Before, it stayed open, so a creature healed
 *    rounds later could still answer a save from long ago.
 */
import { v4 as uuid } from 'uuid';
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleExecuteCombatAction, handleCreateEncounter, clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { normalizeCondition } from '../../src/engine/combat/conditions.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { handleTableRules, TableRulesTool } from '../../src/server/consolidated/table-rules.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { summarizeResult } from '../../src/server/output-mode.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'unscoped' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const manageG = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const actionG = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
const spellG = withOperation('combat_action', (a) => handleExecuteCombatAction(a, ctx as any));
let enc: string;
const manage = async (args: Record<string, unknown>) => {
    const text = (await manageG({ encounterId: enc, ...args })).content[0].text;
    return { text, d: tag(text, 'COMBAT_MANAGE') ?? tag(text, 'STATE') ?? {} };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await actionG({ encounterId: enc, ...args })).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, d, r: d?.actionResult ?? d };
};
const tok = (id: string) => (new EncounterRepository(getDb()).loadState(enc)!.participants as CombatParticipant[]).find(p => p.id === id)! as any;
const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };
const now = () => new Date().toISOString();
const sheet = (id: string, name: string, over: Record<string, unknown> = {}) => new CharacterRepository(getDb()).create({
    id, name, characterType: 'pc', level: 5, hp: 60, maxHp: 60, ac: 13,
    stats: { str: 10, dex: 10, con: 14, int: 10, wis: 10, cha: 8 },
    conditions: [], createdAt: now(), updatedAt: now(), ...over
} as any);

afterEach(() => { vi.restoreAllMocks(); });

describe('an offer lapses when the creature\'s slot comes round, even at 0 HP', () => {
    it('a creature at 0 HP whose slot passes loses its open offer, with the note', () => {
        const e = new CombatEngine('l-review-lapse');
        e.startEncounter([
            { id: 'boss', name: 'Grimgor', initiativeBonus: 0, initiative: 20, hp: 120, maxHp: 120, conditions: [], isEnemy: true, legendaryResistances: 3 },
            { id: 'kael', name: 'Kael', initiativeBonus: 0, initiative: 10, hp: 30, maxHp: 30, conditions: [], isEnemy: false },
            { id: 'orc', name: 'Orc', initiativeBonus: 0, initiative: 5, hp: 15, maxHp: 15, conditions: [], isEnemy: true }
        ] as any);
        const boss = () => e.getState()!.participants.find(p => p.id === 'boss')!;
        boss().conditions.push(normalizeCondition({ name: 'webbed', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' } as never, 'boss')!);
        d20s(2);
        e.nextTurnWithConditions({ encounterId: 'enc-l' }); // Grimgor's turn ends: offered
        expect(boss().pendingLegendaryOffers).toHaveLength(1);
        // Kael drops Grimgor (a knockout: 0 HP, not dead) before the round comes back.
        boss().hp = 0;
        e.nextTurnWithConditions({ encounterId: 'enc-l' }); // Kael's turn ends
        e.nextTurnWithConditions({ encounterId: 'enc-l' }); // the orc's turn ends; Grimgor's slot comes round at 0 HP and passes
        expect(e.getState()!.round).toBe(2);
        expect(boss().pendingLegendaryOffers ?? []).toEqual([]);
        expect(e.turnStartNotes.join('\n')).toMatch(/Grimgor: the legendary resistance offer on the save vs webbed \(eot-1-boss-1\) lapsed/);
    });
});

describe('the roads that printed no offer now ask (cast_spell conditions, manoeuvres, staying mounted)', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { closeDb(); });

    const wizard = (id: string) => new CharacterRepository(getDb()).create({
        id, name: 'Witch', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 8, cha: 18 },
        hp: 30, maxHp: 30, ac: 12, level: 5, characterClass: 'wizard', characterType: 'npc',
        spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: getMaxSpellLevel('wizard' as any, 5),
        knownSpells: ['Hold Person'], preparedSpells: ['Hold Person'], createdAt: now(), updatedAt: now()
    } as any);
    const holdPerson = async (target: Record<string, unknown>) => {
        const casterId = uuid();
        wizard(casterId);
        const created = await handleCreateEncounter({ seed: `l-review-${casterId}`, participants: [
            { id: casterId, name: 'Witch', hp: 30, maxHp: 30, initiative: 20, isEnemy: true },
            { hp: 100, maxHp: 100, initiative: 1, ...target }
        ] }, ctx as any);
        enc = created.content[0].text.match(/Encounter ID: (encounter-[^\n]+)/)![1];
        d20s(1);
        return (await spellG({ encounterId: enc, action: 'cast_spell', actorId: casterId, spellName: 'Hold Person', targetId: target.id })).content[0].text;
    };

    it('Hold Person on a boss without autoLegendaryResistance: the failed save offers one to the GM', async () => {
        const text = await holdPerson({ id: 'grimgor', name: 'Grimgor', isEnemy: false, legendaryResistances: 3 });
        expect(text).toMatch(/Grimgor WISDOM save: .*\[FAIL\]/);
        expect(text).toContain('⭐ Failed with 3 legendary resistance(s) left: the GM may spend one');
        expect(tok('grimgor').legendaryResistancesRemaining).toBe(3);
    });

    it('Hold Person on a player character with autoLegendaryResistance: the player is asked, nothing is spent', async () => {
        sheet('kael', 'Kael', { legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: true });
        const text = await holdPerson({ id: 'kael', name: 'Kael', isEnemy: false });
        expect(text).toContain('⭐ Failed with 3 legendary resistance(s) left: ask the player');
        expect(text).not.toContain('Legendary resistance spent');
        expect(tok('kael').legendaryResistancesRemaining).toBe(3);
        expect(new CharacterRepository(getDb()).findById('kael')!.legendaryResistancesRemaining).toBe(3);
    });

    it('a Trip Attack\'s failed save offers the target\'s legendary resistance on the rule line and in maneuver.save', async () => {
        sheet('brannoc', 'Brannoc', { stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 }, superiorityDie: '1d8',
            resourcePools: { superiority: { current: 4, max: 4, refresh: 'short' } },
            attacks: [{ name: 'longsword', attackBonus: 40, damage: '1d8+3', damageType: 'slashing', default: true }] });
        enc = tag((await manageG({ action: 'create', seed: 'l-review-trip', participants: [
            { id: 'brannoc', name: 'Brannoc', hp: 44, maxHp: 44, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'ogre', name: 'Ogre Tyrant', hp: 90, maxHp: 90, ac: 13, initiative: 10, isEnemy: true, position: { x: 1, y: 0 }, legendaryResistances: 2 }
        ] })).content[0].text, 'COMBAT_MANAGE').encounterId;
        d20s(2); // the STR save fails (the attack, +40, rolls on the fight's own stream)
        const { r, text } = await act({ action: 'attack', actorId: 'brannoc', targetId: 'ogre', maneuver: 'trip' });
        expect(r.maneuver.save).toMatchObject({ saved: false, legendaryResistanceAvailable: 2 });
        expect(text).toMatch(/RULE maneuver trip: .*STR save \d+ vs DC \d+ FAILED.*⭐ 2 legendary resistance\(s\) left: the GM may spend one/);
        expect(tok('ogre').legendaryResistancesRemaining).toBe(2);
    });

    it('a shove with a save prints the target\'s offer on its breakdown (it carried only the JSON fields)', async () => {
        enc = tag((await manageG({ action: 'create', seed: 'l-review-shove', participants: [
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, position: { x: 2, y: 2 }, abilityScores: { strength: 16, dexterity: 12, constitution: 14, intelligence: 10, wisdom: 10, charisma: 10 } },
            { id: 'boss', name: 'Grimgor', hp: 120, maxHp: 120, initiative: 5, isEnemy: true, position: { x: 3, y: 2 }, legendaryResistances: 3 }
        ] })).content[0].text, 'COMBAT_MANAGE').encounterId;
        d20s(2);
        const { d, text } = await act({ action: 'grapple', move: 'shove', save: { ability: 'str' }, actorId: 'marine', targetId: 'boss' });
        expect(d.save).toMatchObject({ saved: false, legendaryResistanceAvailable: 3 });
        expect(String(d.breakdown)).toMatch(/FAILED; ⭐ 3 legendary resistance\(s\) left: the GM may spend one/);
        expect(text).toContain('⭐ 3 legendary resistance(s) left: the GM may spend one');
        expect(tok('boss').legendaryResistancesRemaining).toBe(3);
    });

    it('the stay-mounted save of a player character with autoLegendaryResistance asks the player; a monster\'s automatic spend is named', async () => {
        sheet('kael', 'Kael', { legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: true });
        const horse = (id: string, x: number) => ({ id, name: `Warhorse ${id}`, hp: 19, maxHp: 19, ac: 11, initiative: 15, size: 'large', movementSpeed: 60, position: { x, y: 0 } });
        enc = tag((await manageG({ action: 'create', seed: 'l-review-mount', participants: [
            { id: 'kael', name: 'Kael', hp: 30, maxHp: 30, ac: 16, initiative: 20, position: { x: 0, y: 0 } },
            horse('horse', 1),
            { id: 'boss', name: 'Grimgor', hp: 120, maxHp: 120, ac: 17, initiative: 12, isEnemy: true, position: { x: 6, y: 0 }, legendaryResistances: 3, autoLegendaryResistance: true },
            { ...horse('boar', 7), isEnemy: true }
        ] })).content[0].text, 'COMBAT_MANAGE').encounterId;
        await manage({ action: 'mount', riderId: 'kael', mountId: 'horse', free: true });
        await manage({ action: 'mount', riderId: 'boss', mountId: 'boar', free: true });

        d20s(2);
        const pc = await manage({ action: 'add_condition', participantId: 'kael', condition: 'prone' });
        expect(pc.d.mounts?.[0]).toMatchObject({ riderId: 'kael', fell: true, save: { saved: false, legendaryResistanceAvailable: 3, legendaryResistanceAskPlayer: true } });
        expect(pc.d.mounts[0].line).toMatch(/⭐ 3 legendary resistance\(s\) left: ask the player/);
        expect(tok('kael').legendaryResistancesRemaining).toBe(3);

        vi.restoreAllMocks();
        d20s(2);
        const boss = await manage({ action: 'add_condition', participantId: 'boss', condition: 'prone' });
        expect(boss.d.mounts?.[0]).toMatchObject({ riderId: 'boss', fell: false, save: { saved: true, legendaryResisted: true } });
        expect(boss.d.mounts[0].line).toMatch(/legendary resistance/);
        expect(tok('boss').legendaryResistancesRemaining).toBe(2);
    });
});

describe('a world spell\'s save prints the offer too', () => {
    const W = 'l-review-world';
    const rules = withOperation('table_rules', async (args: Record<string, unknown>) => handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...args }), ctx as any));
    beforeEach(() => {
        closeDb(); clearCombatState();
        const db = getDb(':memory:');
        new WorldRepository(db).create({ id: W, name: 'Warp', seed: 's', width: 10, height: 10, createdAt: now(), updatedAt: now() } as any);
        try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    });
    afterEach(() => { closeDb(); });

    it('a failed save offers the legendary resistance to the GM, or asks a player character', async () => {
        sheet('lex', 'Lex', { characterClass: 'wizard', stats: { str: 10, dex: 10, con: 12, int: 16, wis: 10, cha: 10 } });
        getDb().prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(W, 'lex');
        sheet('kael', 'Kael', { legendaryResistances: 2, legendaryResistancesRemaining: 2, autoLegendaryResistance: true });
        await rules({ action: 'define', kind: 'spell', name: 'Gaze of Mork', spec: { castingRoll: { target: 2 }, effects: [{ type: 'damage', dice: '1d4', damageType: 'force', save: { ability: 'dex', dc: 30 }, saveEffect: 'half' }] } });
        const castAt = async (target: Record<string, unknown>) => {
            clearCombatState();
            const created = await handleCreateEncounter({ seed: `l-review-ws-${target.id}`, participants: [
                { id: 'lex', name: 'Lex', hp: 30, maxHp: 30, initiative: 20 },
                { hp: 120, maxHp: 120, initiative: 5, ...target }
            ] }, ctx as any);
            enc = created.content[0].text.match(/Encounter ID: (encounter-[^\n]+)/)![1];
            return (await spellG({ encounterId: enc, action: 'cast_spell', actorId: 'lex', spellName: 'Gaze of Mork', targetId: target.id })).content[0].text;
        };
        const gm = await castAt({ id: 'boss', name: 'Grimgor', isEnemy: true, legendaryResistances: 3 });
        expect(gm).toMatch(/Grimgor DEXTERITY save: .*\[FAIL\].*⭐ 3 legendary resistance\(s\) left: the GM may spend one/);
        expect(tok('boss').legendaryResistancesRemaining).toBe(3);
        const pc = await castAt({ id: 'kael', name: 'Kael', isEnemy: false });
        expect(pc).toMatch(/Kael DEXTERITY save: .*\[FAIL\].*⭐ 2 legendary resistance\(s\) left: ask the player/);
        expect(tok('kael').legendaryResistancesRemaining).toBe(2);
    });
});

describe('a spend without saveRef keeps its open offers in a summary reply', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { closeDb(); });

    it('two open offers: the summary keeps each row whole (condition name, conditionId, saveRef), not only the ids', async () => {
        enc = tag((await manageG({ action: 'create', seed: 'l-review-open', participants: [
            { id: 'grimgor', name: 'Grimgor', hp: 120, maxHp: 120, initiative: 20, isEnemy: true, legendaryResistances: 3, conditions: [
                { name: 'webbed', durationType: 'save_ends', saveDC: 30, saveAbility: 'dex' },
                { name: 'frightened', durationType: 'save_ends', saveDC: 30, saveAbility: 'wis' }
            ] },
            { id: 'orc', name: 'Orc', hp: 15, maxHp: 15, initiative: 5, isEnemy: true }
        ] })).content[0].text, 'COMBAT_MANAGE').encounterId;
        await manage({ action: 'advance', confirm: true });
        const { d } = await manage({ action: 'legendary_resistance', participantId: 'grimgor', reason: 'the fireball' });
        expect(d.openOffers).toHaveLength(2);
        const summary = summarizeResult(d) as Record<string, any>;
        expect(summary.openOffers).toEqual(d.openOffers);
    });
});
