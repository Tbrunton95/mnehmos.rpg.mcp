/**
 * Play report 7 (lane G1): declared save advantage on the engine's own saves.
 *
 * Lane E wired the save:<ability> scope and the standard conditions' 5e save
 * rules into math_manage roll_saving_throw only. Every save the engine rolls
 * by itself goes through rollParticipantSave (apply_damage / use_ability /
 * lair_action areas, cast_spell's save and debuff loops, a unit's per-model
 * saves, the DC 10 stay-mounted save, shove's save, a manoeuvre's save, a
 * world spell's save) or rollCharacterSave (the same on the sheets, outside a
 * fight). The owner's rule: an untagged mechanic fires on every roll in its
 * scope by itself. So Danger Sense declared {advantage_on, save:dex} rolls two
 * dice against a Fireball, and restrained gives disadvantage on a DEX save the
 * engine rolls. A tagged mechanic never fires there (no call carries a tag for
 * each target) and is named as a hint. The older form keeps its meaning: it
 * never touched an engine save and still does not.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { rollParticipantSave, rollCharacterSave, engineSaveDeclarations } from '../../src/engine/combat/saves.js';
import { rollUnitArea } from '../../src/engine/combat/unit-area.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { replyJson } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';

// The operation guard flushes engine dice to roll_log for the unscoped key.
const ctx = { sessionId: 'unscoped' };
const embed = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const guardedAction = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
let enc: string;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guardedManage(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    return { text, r: embed(text, 'COMBAT_MANAGE') ?? { rawText: text } };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await guardedAction(CombatActionTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    const d = embed(text, 'COMBAT_ACTION') ?? embed(text, 'STATE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : null);
    return { text, d, r: d?.actionResult ?? d };
};
const state = () => new EncounterRepository(getDb()).loadState(enc)!;
const tok = (id: string) => state().participants.find(p => p.id === id)! as any;
const rollsFor = (forId: string) => queryRolls(getDb(), { forId, limit: 200 }) as Array<{ purpose: string; dice: Array<{ value: number }>; for_id: string }>;
/** The dice logged for one purpose (a save at advantage is one roll_log row holding both dice). */
const loggedDice = (forId: string, purpose: string) => rollsFor(forId).filter(x => x.purpose === purpose).flatMap(x => x.dice.map(d => d.value));
const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };

const now = () => new Date().toISOString();
function sheet(id: string, name: string, over: Record<string, unknown> = {}) {
    new CharacterRepository(getDb()).create({
        id, name, characterType: 'pc', level: 3, hp: 60, maxHp: 60, ac: 13,
        stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 },
        conditions: [], createdAt: now(), updatedAt: now(), ...over
    } as any);
}
function mage() {
    new CharacterRepository(getDb()).create({
        id: 'mage', name: 'Mage', characterClass: 'wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
        hp: 30, maxHp: 30, ac: 12, level: 5, spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: getMaxSpellLevel('wizard' as any, 5),
        knownSpells: ['Fireball', 'Hold Person'], preparedSpells: ['Fireball', 'Hold Person'], cantripsKnown: [], createdAt: now(), updatedAt: now()
    } as any);
}
function effect(targetId: string, name: string, mechanics: unknown[]) {
    new CustomEffectsRepository(getDb()).apply({
        target_id: targetId, target_type: 'character', name, description: name,
        category: 'neutral', power_level: 1, source: { type: 'unknown' },
        mechanics: mechanics as never, duration: { type: 'until_removed' as never },
        triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
    } as never);
}
const DANGER_SENSE = [{ type: 'advantage_on', value: 'save:dex' }];

const VAREK = (extra: Record<string, unknown> = {}) => ({ id: 'varek', name: 'Varek', hp: 60, maxHp: 60, ac: 13, initiative: 5, position: { x: 0, y: 0 }, ...extra });
const DRAKE = (extra: Record<string, unknown> = {}) => ({ id: 'drake', name: 'Drake', hp: 120, maxHp: 120, initiative: 40, isEnemy: true, hasLairActions: true, position: { x: 5, y: 5 }, abilities: [{ name: 'Fire Breath', recharge: 5 }], ...extra });
const MILITIA = (extra: Record<string, unknown> = {}) => ({ id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 3, isEnemy: true, ac: 11, unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 2, morale: 6 }, ...extra });

async function fight(participants: Array<Record<string, unknown>>, seed = 'engine-saves') {
    enc = (await manage({ action: 'create', seed, participants })).r.encounterId;
    expect(enc).toBeTruthy();
}
const breath = (extra: Record<string, unknown> = {}) => manage({ action: 'use_ability', participantId: 'drake', ability: 'Fire Breath', targetIds: ['varek'], damage: 20, damageType: 'fire', savingThrow: { ability: 'dex', dc: 15 }, ...extra });
const rubble = (extra: Record<string, unknown> = {}) => manage({ action: 'apply_damage', targetIds: ['varek'], dice: 20, damageType: 'fire', source: 'Firestorm', area: true, save: { ability: 'dex', dc: 15 }, ...extra });
const toLair = async () => {
    for (let i = 0; i < 6 && state().turnOrder[state().currentTurnIndex] !== 'LAIR'; i++) await manage({ action: 'advance', confirm: true });
    expect(state().turnOrder[state().currentTurnIndex]).toBe('LAIR');
};

beforeEach(() => {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    sheet('varek', 'Varek');
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

// ─────────────────────────────────────────────────────────────────────────
// rollParticipantSave: the one composition every engine save goes through
// ─────────────────────────────────────────────────────────────────────────

describe('rollParticipantSave reads the saver\'s declared save sides', () => {
    const engine = (conditions: unknown[] = []) => {
        const e = new CombatEngine('engine-save-unit');
        e.startEncounter([
            { id: 'varek', name: 'Varek', initiativeBonus: 0, initiative: 20, hp: 60, maxHp: 60, conditions, position: { x: 0, y: 0 } }
        ] as any);
        e.drainRollRecords();
        return e;
    };
    const varek = (e: CombatEngine) => e.getState()!.participants.find(p => p.id === 'varek')!;
    // Consecutive dice under one tag are one roll record (rng.ts), so a save at advantage is one row holding both dice.
    const purposeOf = (e: CombatEngine) => e.drainRollRecords().filter(x => x.forId === 'varek').map(x => x.purpose);

    it('an untagged save:dex mechanic rolls two dice, keeps the higher, and names itself in the purpose and the result', () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        const e = engine();
        const s = rollParticipantSave(e, getDb(), varek(e), 'dex', 15);
        expect(s.rolls).toHaveLength(2);
        expect(s.natural).toBe(Math.max(...s.rolls));
        expect(s.advantageSources).toEqual(['Danger Sense (save:dex)']);
        expect(s.disadvantageSources).toBeUndefined();
        const recs = e.drainRollRecords().filter(x => x.forId === 'varek');
        expect(recs.map(x => x.purpose)).toEqual(['dexterity save (adv: Danger Sense (save:dex))']);
        expect(recs[0].dice.map(d => d.value)).toEqual(s.rolls);
    });

    it('save:wis does not fire on a DEX save; it fires on a WIS save', () => {
        effect('varek', 'Iron Will', [{ type: 'advantage_on', value: 'save:wis' }]);
        const e = engine();
        const dex = rollParticipantSave(e, getDb(), varek(e), 'dexterity', 15);
        expect(dex.rolls).toHaveLength(1);
        expect(dex.advantageSources).toBeUndefined();
        expect(purposeOf(e)).toEqual(['dexterity save']);
        const wis = rollParticipantSave(e, getDb(), varek(e), 'wis', 15);
        expect(wis.rolls).toHaveLength(2);
        expect(wis.advantageSources).toEqual(['Iron Will (save:wis)']);
    });

    it('a tagged mechanic does not fire (nothing asserts its tag) and is named as a hint', () => {
        effect('varek', 'Evasive Footwork', [{ type: 'advantage_on', value: 'save:dex', condition: 'in the open' }]);
        effect('varek', 'Old Wound', [{ type: 'disadvantage_on', value: 'save:dex', condition: 'cold' }]);
        const e = engine();
        const s = rollParticipantSave(e, getDb(), varek(e), 'dex', 15);
        expect(s.rolls).toHaveLength(1);
        expect(s.advantageSources).toBeUndefined();
        expect(s.disadvantageSources).toBeUndefined();
        expect(s.conditionalAdvantage).toEqual([expect.stringMatching(/^Evasive Footwork \(in the open\): .*asserts no tag.*condition: 'in the open'.*DEX save/)]);
        expect(s.conditionalDisadvantage).toEqual([expect.stringMatching(/^Old Wound \(cold\): /)]);
        expect(purposeOf(e)).toEqual(['dexterity save']);
    });

    it('restrained gives disadvantage on a DEX save, not on a WIS save, and cancels with Danger Sense', () => {
        const e = engine([{ type: 'restrained', durationType: 'permanent' }]);
        const dex = rollParticipantSave(e, getDb(), varek(e), 'dex', 15);
        expect(dex.rolls).toHaveLength(2);
        expect(dex.natural).toBe(Math.min(...dex.rolls));
        expect(dex.disadvantageSources).toEqual(['restrained']);
        expect(purposeOf(e)[0]).toBe('dexterity save (dis: restrained)');
        const wis = rollParticipantSave(e, getDb(), varek(e), 'wis', 15);
        expect(wis.rolls).toHaveLength(1);
        expect(wis.disadvantageSources).toBeUndefined();
        effect('varek', 'Danger Sense', DANGER_SENSE);
        e.drainRollRecords();
        const both = rollParticipantSave(e, getDb(), varek(e), 'dex', 15);
        expect(both.rolls).toHaveLength(1);
        expect(both.advantageSources).toEqual(['Danger Sense (save:dex)']);
        expect(both.disadvantageSources).toEqual(['restrained']);
        expect(purposeOf(e)).toEqual(['dexterity save (adv: Danger Sense (save:dex); dis: restrained)']);
    });

    it('exhaustion 3 keeps its label and cancels with Danger Sense; slowed (not a 5e condition) gives nothing by itself', () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        const e = engine([{ type: 'exhausted', durationType: 'permanent', metadata: { level: 3 } }, { type: 'slowed', durationType: 'permanent' }]);
        const s = rollParticipantSave(e, getDb(), varek(e), 'dex', 15);
        expect(s.rolls).toHaveLength(1);
        expect(s.disadvantageSources).toEqual(['exhaustion 3']);
        expect(s.advantageSources).toEqual(['Danger Sense (save:dex)']);
    });

    it("the caller's own sides cancel with the declared ones", () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        const e = engine();
        const s = rollParticipantSave(e, getDb(), varek(e), 'dex', 15, { disSources: ['GM: knee-deep mud'] });
        expect(s.rolls).toHaveLength(1);
        expect(s.disadvantageSources).toEqual(['GM: knee-deep mud']);
        expect(s.advantageSources).toEqual(['Danger Sense (save:dex)']);
    });

    it('the older form keeps its meaning: a numeric save-scoped or autoApply mechanic never touched an engine save', () => {
        effect('varek', 'Old Charm', [{ type: 'advantage_on', value: 1, save: 'dexterity' }]);
        effect('varek', 'Old Ward', [{ type: 'advantage_on', value: 1, save: 'dexterity', autoApply: true }]);
        const e = engine();
        const s = rollParticipantSave(e, getDb(), varek(e), 'dex', 15);
        expect(s.rolls).toHaveLength(1);
        expect(s.advantageSources).toBeUndefined();
        expect(s.conditionalAdvantage).toBeUndefined();
        expect(purposeOf(e)).toEqual(['dexterity save']);
    });

    it('declared sides passed in are used without reading the database (a unit reads them once)', () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        const declared = engineSaveDeclarations(getDb(), 'varek', 'dex');
        expect(declared.advantage).toEqual(['Danger Sense (save:dex)']);
        const e = engine();
        const s = rollParticipantSave(e, undefined, varek(e), 'dex', 15, { declared });
        expect(s.rolls).toHaveLength(2);
        expect(s.advantageSources).toEqual(['Danger Sense (save:dex)']);
    });
});

describe('rollCharacterSave (the sheet path, outside a fight) reads them too', () => {
    it('Danger Sense and a sheet Restrained cancel; Danger Sense alone rolls two logged dice', () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        const row = new CharacterRepository(getDb()).findById('varek')!;
        const s = rollCharacterSave(getDb(), row, 'dex', 15, { purpose: 'trap save' });
        expect(s.rolls).toHaveLength(2);
        expect(s.advantageSources).toEqual(['Danger Sense (save:dex)']);
        expect(rollsFor('varek').map(r => r.purpose)).toContain('trap save (adv: Danger Sense (save:dex))');
        new CharacterRepository(getDb()).update('varek', { conditions: [{ name: 'Restrained: pinned under the net' }] } as any);
        const both = rollCharacterSave(getDb(), new CharacterRepository(getDb()).findById('varek')!, 'dex', 15, { purpose: 'trap save' });
        expect(both.rolls).toHaveLength(1);
        expect(both.disadvantageSources).toEqual(['restrained']);
    });

    it('apply_damage on sheets (no fight) carries the labels on the target and its line', async () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        const { r } = await manage({ encounterId: undefined, action: 'apply_damage', targetIds: ['varek'], dice: 20, source: 'rockslide', save: { ability: 'dex', dc: 15 } });
        expect(r.success).toBe(true);
        expect(r.targets[0]).toMatchObject({ advantageSources: ['Danger Sense (save:dex)'] });
        expect(r.targets[0].saveRolls).toHaveLength(2);
        expect(r.message).toMatch(/adv: Danger Sense \(save:dex\)/);
        expect(r.saveSources).toEqual([expect.objectContaining({ targetId: 'varek', advantage: ['Danger Sense (save:dex)'] })]);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// The roads: every save the engine rolls by itself
// ─────────────────────────────────────────────────────────────────────────

describe('Danger Sense on every engine save road', () => {
    it('apply_damage area save: two dice, the target, the line, saveSources and the roll log name it', async () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        await fight([DRAKE(), VAREK()]);
        const { r } = await rubble();
        expect(r.success).toBe(true);
        const t = r.targets[0];
        expect(t.saveRolls).toHaveLength(2);
        expect(t.saveRoll).toBe(Math.max(...t.saveRolls));
        expect(t.advantageSources).toEqual(['Danger Sense (save:dex)']);
        expect(r.message).toMatch(/Dexterity Save: .*\[d20 \d+, \d+; adv: Danger Sense \(save:dex\)\]/);
        expect(r.saveSources).toEqual([{ targetId: 'varek', name: 'Varek', ability: 'dexterity', rolls: t.saveRolls, advantage: ['Danger Sense (save:dex)'] }]);
        const logged = rollsFor('varek').filter(x => /Firestorm save/.test(x.purpose));
        expect(logged.map(x => x.purpose)).toEqual(['Firestorm save (dexterity) (adv: Danger Sense (save:dex))']);
        expect(logged[0].dice.map(d => d.value)).toEqual(t.saveRolls);
    });

    it('use_ability save', async () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        await fight([DRAKE(), VAREK()]);
        const { r } = await breath();
        expect(r.success).toBe(true);
        expect(r.targets[0].saveRolls).toHaveLength(2);
        expect(r.targets[0].advantageSources).toEqual(['Danger Sense (save:dex)']);
        expect(r.saveSources?.[0]).toMatchObject({ targetId: 'varek', advantage: ['Danger Sense (save:dex)'] });
        expect(loggedDice('varek', 'Fire Breath save (dexterity) (adv: Danger Sense (save:dex))')).toEqual(r.targets[0].saveRolls);
    });

    it('lair_action save', async () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        await fight([DRAKE(), VAREK()]);
        await toLair();
        const lair = await manage({ action: 'lair_action', actionDescription: 'the ceiling falls', targetIds: ['varek'], damage: 10, savingThrow: { ability: 'dexterity', dc: 15 } });
        expect(lair.text).toMatch(/adv: Danger Sense \(save:dex\)/);
        expect(lair.r.saveSources).toEqual([expect.objectContaining({ targetId: 'varek', advantage: ['Danger Sense (save:dex)'] })]);
        expect(lair.r.saveSources[0].rolls).toHaveLength(2);
        expect(loggedDice('varek', 'lair save (dexterity) (adv: Danger Sense (save:dex))')).toEqual(lair.r.saveSources[0].rolls);
    });

    it('cast_spell save (Fireball): saves[] and saveSources name it, the line shows both dice', async () => {
        mage();
        effect('varek', 'Danger Sense', DANGER_SENSE);
        await fight([{ id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 50 }, VAREK({ isEnemy: true })]);
        const { r, d, text } = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Fireball', targetId: 'varek' });
        expect(r.saves[0]).toMatchObject({ id: 'varek', advantageSources: ['Danger Sense (save:dex)'] });
        expect(r.saves[0].rolls).toHaveLength(2);
        expect(r.saveSources).toEqual([expect.objectContaining({ targetId: 'varek', advantage: ['Danger Sense (save:dex)'] })]);
        // Lifted to the reply's top level, where output_mode 'summary' keeps it.
        expect(d.saveSources).toEqual(r.saveSources);
        expect(text).toMatch(/DEXTERITY save: d20\(\d+,\d+\).*adv: Danger Sense \(save:dex\)/);
        expect(loggedDice('varek', 'dexterity save vs Fireball (adv: Danger Sense (save:dex))')).toEqual(r.saves[0].rolls);
    });

    it("cast_spell's debuff loop (Hold Person, a WIS save) reads save:wis", async () => {
        mage();
        effect('varek', 'Iron Will', [{ type: 'advantage_on', value: 'save:wis' }]);
        await fight([{ id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 50 }, VAREK({ isEnemy: true })]);
        const { text } = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Hold Person', targetId: 'varek' });
        expect(text).toMatch(/Varek WISDOM save: d20\(\d+,\d+\).*adv: Iron Will \(save:wis\)/);
        expect(loggedDice('varek', 'wisdom save vs Hold Person (adv: Iron Will (save:wis))')).toHaveLength(2);
    });

    it("a unit's per-model saves read the unit token's mechanics once and apply them to every model", async () => {
        effect('militia', 'Shield Drill', DANGER_SENSE.map(m => ({ ...m })));
        await fight([DRAKE(), MILITIA()]);
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const { r } = await breath({ targetIds: ['militia'], damage: 12, area: true, savingThrow: { ability: 'dex', dc: 13 } });
        const ua = r.targets[0].unitArea;
        expect(ua.saves).toHaveLength(6);
        expect(ua.saves.every((s: any) => s.rolls.length === 2 && s.natural === Math.max(...s.rolls))).toBe(true);
        expect(spy).toHaveBeenCalledTimes(12);
        expect(ua.advantageSources).toEqual(['Shield Drill (save:dex)']);
        expect(r.targets[0].advantageSources).toEqual(['Shield Drill (save:dex)']);
        expect(r.message).toMatch(/Saves vs DC 13 \(.*adv: Shield Drill \(save:dex\)\)/);
        expect(r.saveSources).toEqual([{ targetId: 'militia', name: 'Militia', ability: 'dexterity', models: 6, advantage: ['Shield Drill (save:dex)'] }]);
        const logged = rollsFor('militia').filter(x => /Fire Breath save \(model \d\/6\)/.test(x.purpose));
        expect(logged).toHaveLength(6);
        expect(logged.every(x => x.purpose.endsWith(' (adv: Shield Drill (save:dex))') && x.dice.length === 2)).toBe(true);
    });

    it('rollUnitArea reads the custom effects once for the whole unit, not once per model', () => {
        effect('militia', 'Shield Drill', DANGER_SENSE.map(m => ({ ...m })));
        const e = new CombatEngine('unit-once');
        e.startEncounter([{ ...MILITIA(), initiativeBonus: 0, conditions: [] }] as any);
        const db = getDb();
        let effectReads = 0;
        const counting = new Proxy(db, {
            get(target, prop, receiver) {
                if (prop === 'prepare') return (sql: string) => { if (/custom_effects/.test(sql)) effectReads++; return target.prepare(sql); };
                const v = Reflect.get(target, prop, receiver);
                return typeof v === 'function' ? v.bind(target) : v;
            }
        });
        const militia = e.getState()!.participants.find(p => p.id === 'militia')!;
        const roll = rollUnitArea(e, counting as any, militia, { damage: 12, halfOnSave: true, savingThrow: { ability: 'dex', dc: 13 }, purpose: 'Fire Breath' });
        expect(roll.report.saves).toHaveLength(6);
        expect(roll.report.saves!.every(s => s.rolls.length === 2)).toBe(true);
        expect(effectReads).toBe(1);
    });

    it("a unit's failed model saves never spend its legendary resistance, disadvantage or not", async () => {
        effect('militia', 'Clumsy Ranks', [{ type: 'disadvantage_on', value: 'save:dex' }]);
        await fight([DRAKE(), MILITIA({ legendaryResistances: 3, autoLegendaryResistance: true })]);
        d20s(1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2);
        const { r } = await breath({ targetIds: ['militia'], damage: 12, area: true, savingThrow: { ability: 'dex', dc: 13 } });
        const ua = r.targets[0].unitArea;
        expect(ua).toMatchObject({ failed: 6, saved: 0, disadvantageSources: ['Clumsy Ranks (save:dex)'] });
        expect(ua.saves.every((s: any) => s.natural === 1 && s.rolls.length === 2)).toBe(true);
        expect(tok('militia').legendaryResistancesRemaining).toBe(3);
    });

    it('the DC 10 stay-mounted save reads them: two dice, the label on mounts[].save and in the line', async () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        await fight([VAREK({ initiative: 20 }), { id: 'horse', name: 'Warhorse', hp: 19, maxHp: 19, ac: 11, initiative: 15, size: 'large', movementSpeed: 60, position: { x: 1, y: 0 } }]);
        await manage({ action: 'mount', riderId: 'varek', mountId: 'horse', free: true });
        d20s(3, 16);
        const { r } = await manage({ action: 'add_condition', participantId: 'varek', condition: 'prone' });
        expect(r.mounts?.[0]).toMatchObject({ riderId: 'varek', fell: false, save: { dc: 10, natural: 16, rolls: [3, 16], saved: true, advantageSources: ['Danger Sense (save:dex)'] } });
        expect(r.mounts[0].line).toMatch(/adv: Danger Sense \(save:dex\)/);
        expect(tok('varek').mountedOn).toBe('horse');
    });

    it('review: a tagged save:dex mechanic on a rider is hinted on the stay-mounted line and on the mounts row', async () => {
        effect('varek', 'Saddle Sense', [{ type: 'advantage_on', value: 'save:dex', condition: 'mounted' }]);
        await fight([VAREK({ initiative: 20 }), { id: 'horse', name: 'Warhorse', hp: 19, maxHp: 19, ac: 11, initiative: 15, size: 'large', movementSpeed: 60, position: { x: 1, y: 0 } }]);
        await manage({ action: 'mount', riderId: 'varek', mountId: 'horse', free: true });
        const { r } = await manage({ action: 'add_condition', participantId: 'varek', condition: 'prone' });
        const ev = r.mounts?.[0];
        expect(ev.save.rolls).toHaveLength(1);
        expect(ev.save.conditionalAdvantage).toEqual([expect.stringMatching(/^Saddle Sense \(mounted\): /)]);
        // The row carries the hint as a list of strings (output_mode 'summary' keeps those), and the line prints it.
        expect(ev.conditional).toEqual(ev.save.conditionalAdvantage);
        expect(ev.line).toMatch(/\n   conditional: Saddle Sense \(mounted\): a save the engine rolls asserts no tag/);
        expect(r.message).toMatch(/conditional: Saddle Sense \(mounted\)/);
    });

    it("a manoeuvre's save (trip, STR) reads the target's save:str: maneuver.save, saveSources and the rule line", async () => {
        sheet('brannoc', 'Brannoc', { superiorityDie: '1d8', resourcePools: { superiority: { current: 4, max: 4, refresh: 'short' } },
            attacks: [{ name: 'longsword', attackBonus: 7, damage: '1d8+3', damageType: 'slashing', default: true }] });
        effect('varek', 'Sure Footing', [{ type: 'advantage_on', value: 'save:str' }]);
        await fight([{ id: 'brannoc', name: 'Brannoc', hp: 44, maxHp: 44, initiative: 20, position: { x: 1, y: 0 } }, VAREK({ isEnemy: true })], 'g1-trip');
        d20s(3, 18);
        const { r, text } = await act({ action: 'attack', actorId: 'brannoc', targetId: 'varek', maneuver: 'trip', dc: 2 });
        expect(r.maneuver.save).toMatchObject({ ability: 'strength', natural: 18, rolls: [3, 18], advantageSources: ['Sure Footing (save:str)'] });
        expect(r.saveSources).toEqual([{ targetId: 'varek', name: 'Varek', ability: 'strength', rolls: [3, 18], advantage: ['Sure Footing (save:str)'] }]);
        expect(text).toMatch(/RULE maneuver trip: .*STR save \d+ vs DC \d+ saved \[d20 3, 18; adv: Sure Footing \(save:str\)\]/);
    });

    it("shove's save reads the target's save:str", async () => {
        effect('varek', 'Rooted Stance', [{ type: 'advantage_on', value: 'save:str' }]);
        await fight([{ id: 'brute', name: 'Brute', hp: 40, maxHp: 40, ac: 12, initiative: 30, isEnemy: true, position: { x: 1, y: 0 }, stats: { str: 16 } }, VAREK()]);
        const { d } = await act({ action: 'grapple', move: 'shove', actorId: 'brute', targetId: 'varek', save: { ability: 'str', dc: 13 } });
        expect(d.save).toMatchObject({ ability: 'strength', advantageSources: ['Rooted Stance (save:str)'] });
        expect(d.save.rolls).toHaveLength(2);
        expect(String(d.breakdown)).toMatch(/adv: Rooted Stance \(save:str\)/);
    });
});

describe('the standard conditions on a save the engine rolls', () => {
    it('restrained gives disadvantage on an area DEX save; Danger Sense cancels it to one die', async () => {
        await fight([DRAKE(), VAREK({ conditions: [{ name: 'restrained', source: 'net' }] })]);
        const first = await rubble();
        expect(first.r.targets[0].saveRolls).toHaveLength(2);
        expect(first.r.targets[0].saveRoll).toBe(Math.min(...first.r.targets[0].saveRolls));
        expect(first.r.targets[0].disadvantageSources).toEqual(['restrained']);
        effect('varek', 'Danger Sense', DANGER_SENSE);
        const second = await rubble();
        expect(second.r.targets[0].saveRolls).toBeUndefined();
        expect(second.r.targets[0]).toMatchObject({ advantageSources: ['Danger Sense (save:dex)'], disadvantageSources: ['restrained'] });
        expect(second.r.message).toMatch(/cancel: one die/);
    });

    it('a tagged mechanic on an area save is hinted on the target and in saveSources', async () => {
        effect('varek', 'Evasive Footwork', [{ type: 'advantage_on', value: 'save:dex', condition: 'in the open' }]);
        await fight([DRAKE(), VAREK()]);
        const { r } = await rubble();
        expect(r.targets[0].saveRolls).toBeUndefined();
        expect(r.targets[0].conditionalAdvantage).toEqual([expect.stringMatching(/^Evasive Footwork \(in the open\)/)]);
        expect(r.saveSources).toEqual([expect.objectContaining({ targetId: 'varek', conditional: [expect.stringMatching(/^Evasive Footwork \(in the open\)/)] })]);
        expect(r.message).toMatch(/conditional: Evasive Footwork \(in the open\)/);
    });

    it('no source, no change: the line, the purpose and the reply are as before', async () => {
        await fight([DRAKE(), VAREK()]);
        const { r } = await rubble();
        expect(r.targets[0].saveRolls).toBeUndefined();
        expect(r.targets[0].advantageSources).toBeUndefined();
        expect(r.saveSources).toBeUndefined();
        expect(r.message).not.toMatch(/\[d20/);
        expect(rollsFor('varek').filter(x => /Firestorm save/.test(x.purpose)).map(x => x.purpose)).toEqual(['Firestorm save (dexterity)']);
    });
});

describe('seeded replay', () => {
    it("both dice come off the encounter's seeded stream: the same seed replays the same two dice", async () => {
        const run = async () => {
            closeDb(); getDb(':memory:'); clearCombatState();
            sheet('varek', 'Varek');
            effect('varek', 'Danger Sense', DANGER_SENSE);
            await fight([DRAKE(), VAREK()], 'g1-replay');
            const { r } = await rubble();
            return { rolls: r.targets[0].saveRolls as number[], logged: rollsFor('varek').filter(x => /Firestorm save/.test(x.purpose)).flatMap(x => x.dice.map(d => d.value)) };
        };
        const a = await run();
        const b = await run();
        expect(a.rolls).toHaveLength(2);
        expect(b.rolls).toEqual(a.rolls);
        expect(a.logged).toEqual(a.rolls);
    });
});

describe('output_mode summary keeps the labels (play report 7, lane G1)', () => {
    let client: Client;
    const call = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>)[0].text;
        const data = replyJson(text);
        expect(data, `no JSON in reply: ${text.slice(0, 300)}`).not.toBeNull();
        return data as Record<string, any>;
    };
    beforeEach(async () => {
        const server = buildServer(new PubSub(), new AuditLogger());
        const [c, s] = InMemoryTransport.createLinkedPair();
        await server.connect(s);
        client = new Client({ name: 'engine-save-summary', version: '0.0.0' });
        await client.connect(c);
    });
    afterEach(async () => { await client.close(); });

    it('apply_damage and cast_spell keep saveSources whole: the labels and both dice', async () => {
        mage();
        effect('varek', 'Danger Sense', DANGER_SENSE);
        const created = await call('combat_manage', { action: 'create', seed: 'g1-summary', participants: [{ id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 50 }, VAREK({ isEnemy: true })] });
        enc = created.encounterId;
        const ad = await call('combat_manage', { action: 'apply_damage', encounterId: enc, targetIds: ['varek'], dice: 5, source: 'Firestorm', area: true, save: { ability: 'dex', dc: 15 }, output_mode: 'summary' });
        expect(ad.saveSources).toEqual([{ targetId: 'varek', name: 'Varek', ability: 'dexterity', rolls: [expect.any(Number), expect.any(Number)], advantage: ['Danger Sense (save:dex)'] }]);
        const fb = await call('combat_action', { action: 'cast_spell', encounterId: enc, actorId: 'mage', spellName: 'Fireball', targetId: 'varek', output_mode: 'summary' });
        expect(fb.saveSources).toEqual([expect.objectContaining({ targetId: 'varek', advantage: ['Danger Sense (save:dex)'], rolls: [expect.any(Number), expect.any(Number)] })]);
    });

    it('review: use_ability, a shove, a trip and the debuff loop keep saveSources whole too', async () => {
        mage();
        sheet('brannoc', 'Brannoc', { superiorityDie: '1d8', resourcePools: { superiority: { current: 4, max: 4, refresh: 'short' } },
            attacks: [{ name: 'longsword', attackBonus: 7, damage: '1d8+3', damageType: 'slashing', default: true }] });
        effect('varek', 'Danger Sense', DANGER_SENSE);
        effect('varek', 'Rooted Stance', [{ type: 'advantage_on', value: 'save:str' }]);
        effect('varek', 'Iron Will', [{ type: 'advantage_on', value: 'save:wis' }]);
        const two = [expect.any(Number), expect.any(Number)];
        // One fight per road, so each actor is the one acting.
        const open = async (seed: string, first: Record<string, unknown>) => {
            enc = (await call('combat_manage', { action: 'create', seed, participants: [{ ...first, initiative: 60 }, VAREK({ isEnemy: true })] })).encounterId;
        };
        const BRANNOC = { id: 'brannoc', name: 'Brannoc', hp: 44, maxHp: 44, position: { x: 1, y: 0 } };
        await open('g1-sum-ua', DRAKE());
        const ua = await call('combat_manage', { action: 'use_ability', encounterId: enc, participantId: 'drake', ability: 'Fire Breath', targetIds: ['varek'], damage: 4, damageType: 'fire', savingThrow: { ability: 'dex', dc: 15 }, output_mode: 'summary' });
        expect(ua.saveSources).toEqual([{ targetId: 'varek', name: 'Varek', ability: 'dexterity', rolls: two, advantage: ['Danger Sense (save:dex)'] }]);
        await open('g1-sum-hold', { id: 'mage', name: 'Mage', hp: 30, maxHp: 30, position: { x: 3, y: 3 } });
        const hp = await call('combat_action', { action: 'cast_spell', encounterId: enc, actorId: 'mage', spellName: 'Hold Person', targetId: 'varek', output_mode: 'summary' });
        expect(hp.saveSources).toEqual([{ targetId: 'varek', name: 'Varek', ability: 'wisdom', rolls: two, advantage: ['Iron Will (save:wis)'] }]);
        await open('g1-sum-trip', BRANNOC);
        const trip = await call('combat_action', { action: 'attack', encounterId: enc, actorId: 'brannoc', targetId: 'varek', maneuver: 'trip', dc: 2, output_mode: 'summary' });
        // dc 2: only a natural 1 misses, and a miss rolls no save.
        if (trip.saveSources || !/MISS/.test(JSON.stringify(trip))) expect(trip.saveSources).toEqual([{ targetId: 'varek', name: 'Varek', ability: 'strength', rolls: two, advantage: ['Rooted Stance (save:str)'] }]);
        await open('g1-sum-shove', BRANNOC);
        const shove = await call('combat_action', { action: 'grapple', move: 'shove', encounterId: enc, actorId: 'brannoc', targetId: 'varek', save: { ability: 'str', dc: 13 }, output_mode: 'summary' });
        expect(shove.saveSources).toEqual([{ targetId: 'varek', name: 'Varek', ability: 'strength', rolls: two, advantage: ['Rooted Stance (save:str)'] }]);
    });

    it("review: a rider's tagged mechanic keeps its hint on the mounts row under summary", async () => {
        effect('varek', 'Saddle Sense', [{ type: 'advantage_on', value: 'save:dex', condition: 'mounted' }]);
        effect('varek', 'Danger Sense', DANGER_SENSE);
        const created = await call('combat_manage', { action: 'create', seed: 'g1-summary-mount', participants: [VAREK({ initiative: 20 }), { id: 'horse', name: 'Warhorse', hp: 19, maxHp: 19, ac: 11, initiative: 15, size: 'large', movementSpeed: 60, position: { x: 1, y: 0 } }] });
        enc = created.encounterId;
        await call('combat_manage', { action: 'mount', encounterId: enc, riderId: 'varek', mountId: 'horse', free: true });
        const r = await call('combat_manage', { action: 'add_condition', encounterId: enc, participantId: 'varek', condition: 'prone', output_mode: 'summary' });
        expect(r.mounts?.[0].line).toMatch(/adv: Danger Sense \(save:dex\)/);
        expect(r.mounts?.[0].conditional).toEqual([expect.stringMatching(/^Saddle Sense \(mounted\): a save the engine rolls asserts no tag/)]);
    });
});
