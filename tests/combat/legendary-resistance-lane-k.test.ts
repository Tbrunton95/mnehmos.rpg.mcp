/**
 * Play report 7 follow-up (lane K): legendary resistance on the saves that
 * still ignored it.
 *
 * The owner's answer: "Any saving throw counts", and it assumed the engine
 * already offered legendary resistance on spell, lair and concentration
 * saves. Lane L's reviewer found it did not on three:
 *
 * - The concentration CON save (lane H's shared roll, seven roads: an
 *   attack, cast_spell, an area through resolveAreaSave, a world spell,
 *   apply_damage on the sheets, an execute on the sheets, concentration_manage
 *   check_save). Now a failed save asks lane L's rule: autoLegendaryResistance
 *   spends one (the spell holds; the count is mirrored to the sheet by exact
 *   id); otherwise it is offered ('LR 2/3 left, spend one?' with the call); a
 *   player character is asked, never spent for. In a fight the offer is
 *   reversible: kind 'concentration' in pendingLegendaryOffers carries a
 *   snapshot of the broken row, and combat_manage legendary_resistance
 *   {saveRef} restores it as it was (refused, writing nothing, when the
 *   creature has started concentrating on something else). Off a fight no
 *   encounter row can hold an offer: the reply reports
 *   legendaryResistanceAvailable and the repair call (concentration_manage
 *   restore), and an automatic spend still works on the sheet.
 * - A stunt's target save: the same rule in a fight (kind 'stunt', its saveRef
 *   heals the avoided damage back); off a fight a report only.
 * - An aura's save (aura_manage process, a report that writes nothing): the
 *   offer text on each failed row; nothing is ever spent there.
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { handleConcentrationManage } from '../../src/server/consolidated/concentration-manage.js';
import { handleImprovisationManage } from '../../src/server/consolidated/improvisation-manage.js';
import { handleAuraManage } from '../../src/server/consolidated/aura-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { startConcentration } from '../../src/engine/magic/concentration.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { ConcentrationRepository } from '../../src/storage/repos/concentration.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { summarizeResult } from '../../src/server/output-mode.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'unscoped' };
const embed = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const guardedAction = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
let enc: string | undefined;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guardedManage(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    return { text, r: embed(text, 'COMBAT_MANAGE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : { rawText: text }) };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await guardedAction(CombatActionTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    const d = embed(text, 'COMBAT_ACTION') ?? embed(text, 'STATE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : null);
    return { text, d, r: d?.actionResult ?? d };
};
const conc = async (args: Record<string, unknown>) => {
    const text = (await handleConcentrationManage(args, ctx as any)).content[0].text;
    return JSON.parse(text);
};
const improv = async (args: Record<string, unknown>) => {
    const text = (await handleImprovisationManage(args, ctx as any)).content[0].text;
    return { text, r: embed(text, 'IMPROVISATION_MANAGE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : { rawText: text }) };
};
const aura = async (args: Record<string, unknown>) => {
    const text = (await handleAuraManage(args, ctx as any)).content[0].text;
    return { text, r: embed(text, 'AURA_MANAGE') };
};
const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };
const now = () => new Date().toISOString();
const sheetRow = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
const concRow = (id: string) => new ConcentrationRepository(getDb()).findByCharacterId(id);
const tok = (id: string) => (new EncounterRepository(getDb()).loadState(enc!)!.participants as CombatParticipant[]).find(p => p.id === id)!;
const lrLogRows = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM combat_action_log WHERE action_type = 'legendary_resistance'`).get() as { n: number }).n;
const callFor = (encounterId: string, id: string, ref: string, reason: string) =>
    `combat_manage legendary_resistance {encounterId: '${encounterId}', participantId: '${id}', saveRef: '${ref}', reason: '${reason}'}`;

/** The hag concentrates on Hex (round 1, 10 rounds, on Kael); CON 10, so a DC 30 save always fails. */
const HEX = { spell: 'Hex', spellLevel: 1, targetIds: ['kael'], startedAt: 1, maxDuration: 10, saveDCBase: 10 };
function sheet(id: string, name: string, over: Record<string, unknown> = {}) {
    new CharacterRepository(getDb()).create({
        id, name, characterType: 'enemy', level: 8, hp: 200, maxHp: 200, ac: 13,
        stats: { str: 10, dex: 10, con: 10, int: 12, wis: 12, cha: 16 },
        conditions: [], createdAt: now(), updatedAt: now(), ...over
    } as any);
}
function concentrating(id: string) {
    new ConcentrationRepository(getDb()).create({ characterId: id, activeSpell: 'Hex', spellLevel: 1, targetIds: ['kael'], startedAt: 1, maxDuration: 10, saveDCBase: 10 });
    new CharacterRepository(getDb()).update(id, { concentratingOn: 'Hex' } as any);
}
const HAG = (over: Record<string, unknown> = {}) => sheet('hag', 'Hag', { legendaryResistances: 3, legendaryResistancesRemaining: 3, ...over });
const BRUTE = { id: 'brute', name: 'Brute', hp: 40, maxHp: 40, ac: 12, initiative: 30, isEnemy: false, position: { x: 1, y: 0 }, attackBonus: 5, attackDamage: '1d8+3' };
const HAG_TOKEN = { id: 'hag', name: 'Hag', hp: 200, maxHp: 200, ac: 13, initiative: 10, isEnemy: true, position: { x: 0, y: 0 } };
async function fight(participants: Array<Record<string, unknown>>, seed = 'k-conc') {
    enc = (await manage({ action: 'create', seed, participants })).r.encounterId;
    expect(enc).toBeTruthy();
}
/** A 60-point blow: DC 30, a save the hag cannot make. */
const smash = (damage = 60, targetId = 'hag') => act({ action: 'attack', actorId: 'brute', targetId, outcome: 'hit', damage });

beforeEach(() => {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    enc = undefined;
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

// ─────────────────────────────────────────────────────────────────────────
// Concentration in a fight: autoLegendaryResistance spends
// ─────────────────────────────────────────────────────────────────────────

describe('a failed concentration save by an auto monster spends a legendary resistance: the spell holds', () => {
    it('after an attack: the spell holds, the token and the sheet keep the count, and a second process spends the next', async () => {
        HAG({ autoLegendaryResistance: true });
        concentrating('hag');
        await fight([BRUTE, HAG_TOKEN]);
        const { r, d, text } = await smash();
        expect(r.success).toBe(true);
        expect(r.concentrationSaves).toEqual([expect.objectContaining({
            targetId: 'hag', name: 'Hag', spell: 'Hex', broken: false, reason: 'damage', saveDC: 30,
            legendaryResisted: true, legendaryRemaining: 2, legendaryOf: 3
        })]);
        expect(r.concentrationSaves[0].legendaryOffer).toBeUndefined();
        expect(d.legendaryOffers).toBeUndefined();
        expect(text).toMatch(/🧠 Hag: Concentration on Hex: CON save \d+ vs DC 30 ✗ failed → 👑 legendary resistance \(LR 2\/3 left\): held/);
        expect(concRow('hag')).toMatchObject({ activeSpell: 'Hex', startedAt: 1, maxDuration: 10, targetIds: ['kael'] });
        expect(sheetRow('hag').concentratingOn).toBe('Hex');
        expect(tok('hag').legendaryResistancesRemaining).toBe(2);
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(2);

        // A second process: the engine reloads from the encounter row (the brute's attack is spent: a rockfall).
        clearCombatState();
        const { r: again } = await manage({ action: 'apply_damage', targetIds: ['hag'], dice: 60, source: 'rockfall' });
        expect(again.targets[0].concentration).toMatchObject({ broken: false, legendaryResisted: true, legendaryRemaining: 1 });
        expect(tok('hag').legendaryResistancesRemaining).toBe(1);
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(1);
        expect(concRow('hag')?.activeSpell).toBe('Hex');
    });

    it('after an area (apply_damage in a fight): the target row and its line say the resistance held the spell', async () => {
        HAG({ autoLegendaryResistance: true });
        concentrating('hag');
        await fight([BRUTE, HAG_TOKEN]);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['hag'], dice: 60, source: 'rockfall' });
        expect(r.targets[0].concentration).toMatchObject({ spell: 'Hex', broken: false, reason: 'damage', legendaryResisted: true, legendaryRemaining: 2 });
        expect(r.message).toMatch(/Concentration on Hex: CON save \d+ vs DC 30 ✗ failed → 👑 legendary resistance \(LR 2\/3 left\): held/);
        expect(r.legendaryOffers).toBeUndefined();
        expect(concRow('hag')?.activeSpell).toBe('Hex');
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(2);
    });

    it('after cast_spell (Magic Missile): concentrationSaves carries the spend', async () => {
        HAG({ autoLegendaryResistance: true });
        concentrating('hag');
        new CharacterRepository(getDb()).create({
            id: 'mage', name: 'Mage', characterClass: 'wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
            hp: 30, maxHp: 30, ac: 12, level: 5, spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: getMaxSpellLevel('wizard' as any, 5),
            knownSpells: ['Magic Missile'], preparedSpells: ['Magic Missile'], cantripsKnown: [], createdAt: now(), updatedAt: now()
        } as any);
        await fight([{ id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 50 }, HAG_TOKEN]);
        d20s(1); // the concentration save: 1 + 0 against DC 10
        const { r, text } = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Magic Missile', targetId: 'hag' });
        expect(r.concentrationSaves).toEqual([expect.objectContaining({ targetId: 'hag', spell: 'Hex', broken: false, legendaryResisted: true, legendaryRemaining: 2 })]);
        expect(text).toMatch(/🧠 Hag: Concentration on Hex: CON save 1 vs DC 10 ✗ failed → 👑 legendary resistance \(LR 2\/3 left\): held/);
        expect(concRow('hag')?.activeSpell).toBe('Hex');
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(2);
    });

    it('a sheetless count is never mirrored onto a sheet whose id merely starts with the token\'s', async () => {
        HAG({ autoLegendaryResistance: true });
        concentrating('hag');
        sheet('hag-sister', 'Hag Sister', { legendaryResistances: 3, legendaryResistancesRemaining: 3 });
        await fight([BRUTE, HAG_TOKEN]);
        await smash();
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(2);
        expect(sheetRow('hag-sister').legendaryResistancesRemaining).toBe(3);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Concentration in a fight: offered with a saveRef, answered
// ─────────────────────────────────────────────────────────────────────────

describe('a failed concentration save is offered; the saveRef restores the spell as it was', () => {
    it('offered after an attack, answered in a second process: Hex is back with its round, duration and targets', async () => {
        HAG();
        concentrating('hag');
        await fight([BRUTE, HAG_TOKEN]);
        const { r, d, text } = await smash();
        const call = callFor(enc!, 'hag', 'con-1-hag-1', 'concentration save on Hex');
        expect(r.concentrationSaves).toEqual([expect.objectContaining({
            targetId: 'hag', spell: 'Hex', broken: true,
            legendaryOffer: { saveRef: 'con-1-hag-1', remaining: 3, of: 3, call, line: `⭐ LR 3/3 left, spend one? ${call}` }
        })]);
        expect(r.concentrationSaves[0].legendaryResisted).toBeUndefined();
        expect(d.legendaryOffers).toEqual([expect.objectContaining({ participantId: 'hag', saveRef: 'con-1-hag-1', kind: 'concentration', condition: 'Hex', remaining: 3, of: 3, call })]);
        expect(d.legendaryOffers[0].conditionId).toBeUndefined();
        expect(text).toContain(`Concentration on Hex: CON save`);
        expect(text).toContain(`✗ BROKEN ⭐ LR 3/3 left, spend one? ${call}`);
        expect(concRow('hag')).toBeNull();
        expect(sheetRow('hag').concentratingOn).toBeFalsy();
        expect(tok('hag').legendaryResistancesRemaining).toBe(3);
        expect(tok('hag').pendingLegendaryOffers).toEqual([{ ref: 'con-1-hag-1', kind: 'concentration', condition: 'Hex', round: 1, concentration: HEX }]);

        clearCombatState();
        const { r: spent } = await manage({ action: 'legendary_resistance', participantId: 'hag', saveRef: 'con-1-hag-1', reason: 'concentration save on Hex' });
        expect(spent).toMatchObject({ success: true, remaining: 2, of: 3, saveRef: 'con-1-hag-1', concentrationRestored: HEX, mirroredToCharacter: true });
        expect(spent.message).toMatch(/👑 Hag turns the failed concentration save on Hex into a success \(concentration save on Hex\): concentration on Hex holds; LR 2\/3 left/);
        expect(concRow('hag')).toMatchObject({ activeSpell: 'Hex', spellLevel: 1, targetIds: ['kael'], startedAt: 1, maxDuration: 10, saveDCBase: 10 });
        expect(sheetRow('hag').concentratingOn).toBe('Hex');
        expect(tok('hag').legendaryResistancesRemaining).toBe(2);
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(2);
        expect(tok('hag').pendingLegendaryOffers ?? []).toEqual([]);
        expect(lrLogRows()).toBe(1);
    });

    it('refused, writing nothing, when the creature has started concentrating on another spell since', async () => {
        HAG();
        concentrating('hag');
        await fight([BRUTE, HAG_TOKEN]);
        await smash();
        // A new spell replaced it (cast_spell's startConcentration).
        const db = getDb();
        startConcentration('hag', 'Bless', 1, 2, 10, [], new ConcentrationRepository(db), new CharacterRepository(db));
        const rolls = queryRolls(getDb(), { limit: 500 }).length;
        const { r } = await manage({ action: 'legendary_resistance', participantId: 'hag', saveRef: 'con-1-hag-1', reason: 'concentration save on Hex' });
        expect(r).toMatchObject({ error: true, writes: 'none' });
        expect(r.message).toMatch(/Hag has started concentrating on Bless since the save, so Hex cannot come back \(offer con-1-hag-1\)\. Nothing spent\./);
        expect(concRow('hag')?.activeSpell).toBe('Bless');
        expect(tok('hag').legendaryResistancesRemaining).toBe(3);
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(3);
        expect(tok('hag').pendingLegendaryOffers).toHaveLength(1);
        expect(lrLogRows()).toBe(0);
        expect(queryRolls(getDb(), { limit: 500 }).length).toBe(rolls);
    });

    it('refused when the creature has dropped to 0 HP since (concentration cannot hold)', async () => {
        HAG();
        concentrating('hag');
        await fight([BRUTE, HAG_TOKEN]);
        await smash();
        await manage({ action: 'adjust_hp', participantId: 'hag', value: 0, reason: 'finished off' });
        const { r } = await manage({ action: 'legendary_resistance', participantId: 'hag', saveRef: 'con-1-hag-1', reason: 'concentration save on Hex' });
        expect(r).toMatchObject({ error: true, writes: 'none' });
        expect(r.message).toMatch(/at 0 HP/);
        expect(concRow('hag')).toBeNull();
        expect(tok('hag').legendaryResistancesRemaining).toBe(3);
    });

    it('without saveRef the spend lowers the count and names the restore call for the open offer', async () => {
        HAG();
        concentrating('hag');
        await fight([BRUTE, HAG_TOKEN]);
        await smash();
        const { r } = await manage({ action: 'legendary_resistance', participantId: 'hag', reason: 'the hex' });
        expect(r).toMatchObject({ success: true, remaining: 2, openOffers: [{ saveRef: 'con-1-hag-1', kind: 'concentration', condition: 'Hex' }] });
        expect(r.concentrationRestored).toBeUndefined();
        expect(r.message).toContain("saveRef 'con-1-hag-1' (concentration save on Hex)");
        expect(r.message).toContain("restore the spell with concentration_manage restore {characterId: 'hag', spell: 'Hex', spellLevel: 1, startedAt: 1, maxDuration: 10, targetIds: ['kael']}");
        expect(concRow('hag')).toBeNull();
    });

    it('the offer lapses when the creature\'s next turn starts', async () => {
        HAG();
        concentrating('hag');
        await fight([BRUTE, HAG_TOKEN]);
        await smash();
        const { r } = await manage({ action: 'advance', confirm: true }); // the brute's turn ends; the hag's begins
        expect(r.turnStartNotes.join('\n')).toMatch(/Hag: the legendary resistance offer on the concentration save on Hex \(con-1-hag-1\) lapsed/);
        expect(tok('hag').pendingLegendaryOffers ?? []).toEqual([]);
        const late = (await manage({ action: 'legendary_resistance', participantId: 'hag', saveRef: 'con-1-hag-1', reason: 'concentration save on Hex' })).r;
        expect(late).toMatchObject({ error: true, writes: 'none' });
        expect(tok('hag').legendaryResistancesRemaining).toBe(3);
    });

    it('a concentration save that took a source: its saveSources row carries the offer and whether the spell ended', async () => {
        HAG();
        concentrating('hag');
        new CustomEffectsRepository(getDb()).apply({
            target_id: 'hag', target_type: 'character', name: 'Steady Mind', description: 'Steady Mind', category: 'boon', power_level: 1,
            source: { type: 'unknown' }, mechanics: [{ type: 'advantage_on', value: 'save:con' }] as never, duration: { type: 'until_removed' as never },
            triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
        } as never);
        await fight([BRUTE, HAG_TOKEN]);
        const { d, text } = await smash();
        const call = callFor(enc!, 'hag', 'con-1-hag-1', 'concentration save on Hex');
        expect(d.saveSources).toEqual([expect.objectContaining({
            targetId: 'hag', save: 'concentration on Hex', broken: true, advantage: ['Steady Mind (save:con)'],
            legendaryOffer: expect.objectContaining({ saveRef: 'con-1-hag-1', call })
        })]);
        // The sides tail first, then the offer and its call.
        expect(text).toMatch(/✗ BROKEN \[d20 \d+, \d+; adv: Steady Mind \(save:con\)\] ⭐ LR 3\/3 left, spend one\? combat_manage legendary_resistance/);
    });

    it('offered on use_ability (a breath weapon): legendaryOffers at the top level', async () => {
        HAG();
        concentrating('hag');
        await fight([{ ...BRUTE, abilities: [{ name: 'Fire Breath', recharge: 5 }] }, HAG_TOKEN]);
        const { r } = await manage({ action: 'use_ability', participantId: 'brute', ability: 'Fire Breath', targetIds: ['hag'], damage: 60, damageType: 'fire' });
        expect(r.success).toBe(true);
        expect(r.targets[0].concentration).toMatchObject({ broken: true, legendaryOffer: { saveRef: 'con-1-hag-1' } });
        expect(r.legendaryOffers).toEqual([expect.objectContaining({ saveRef: 'con-1-hag-1', kind: 'concentration', call: callFor(enc!, 'hag', 'con-1-hag-1', 'concentration save on Hex') })]);
    });

    it('offered on an area (apply_damage in a fight): legendaryOffers at the top level, the call on the target line', async () => {
        HAG();
        concentrating('hag');
        await fight([BRUTE, HAG_TOKEN]);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['hag'], dice: 60, source: 'rockfall' });
        const call = callFor(enc!, 'hag', 'con-1-hag-1', 'concentration save on Hex');
        expect(r.targets[0].concentration).toMatchObject({ broken: true, legendaryOffer: { saveRef: 'con-1-hag-1', call } });
        expect(r.legendaryOffers).toEqual([expect.objectContaining({ saveRef: 'con-1-hag-1', kind: 'concentration', call })]);
        expect(r.message).toContain(call);
        const { r: spent } = await manage({ action: 'legendary_resistance', participantId: 'hag', saveRef: 'con-1-hag-1', reason: 'concentration save on Hex' });
        expect(spent.concentrationRestored).toEqual(HEX);
        expect(concRow('hag')?.activeSpell).toBe('Hex');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// A player character is asked, never spent for
// ─────────────────────────────────────────────────────────────────────────

describe('a player character concentrating is asked, never spent for', () => {
    it('autoLegendaryResistance on a pc row: the spell breaks, the offer asks the player, the count stays; their yes restores it', async () => {
        sheet('kael', 'Kael', { characterType: 'pc', legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: true });
        concentrating('kael');
        await fight([{ ...BRUTE, isEnemy: true }, { id: 'kael', name: 'Kael', hp: 200, maxHp: 200, initiative: 10, isEnemy: false, position: { x: 0, y: 0 } }]);
        const { r, d } = await smash(60, 'kael');
        const call = callFor(enc!, 'kael', 'con-1-kael-1', 'concentration save on Hex');
        expect(r.concentrationSaves[0]).toMatchObject({ broken: true, legendaryOffer: { askPlayer: true, remaining: 3, call } });
        expect(r.concentrationSaves[0].legendaryOffer.line).toBe(`⭐ Kael failed with 3/3 legendary resistance left: ask the player. If they spend one: ${call}`);
        expect(d.legendaryOffers[0]).toMatchObject({ askPlayer: true, saveRef: 'con-1-kael-1' });
        expect(tok('kael').legendaryResistancesRemaining).toBe(3);
        expect(sheetRow('kael').legendaryResistancesRemaining).toBe(3);
        expect(concRow('kael')).toBeNull();
        const { r: yes } = await manage({ action: 'legendary_resistance', participantId: 'kael', saveRef: 'con-1-kael-1', reason: 'the player spends one' });
        expect(yes).toMatchObject({ success: true, remaining: 2, concentrationRestored: HEX });
        expect(concRow('kael')?.activeSpell).toBe('Hex');
        expect(sheetRow('kael').legendaryResistancesRemaining).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Off a fight: the sheets
// ─────────────────────────────────────────────────────────────────────────

describe('off a fight: autoLegendaryResistance spends from the sheet, otherwise the repair call is reported', () => {
    it('apply_damage on the sheets, auto: the sheet count drops and Hex holds', async () => {
        HAG({ autoLegendaryResistance: true });
        concentrating('hag');
        const { r } = await manage({ action: 'apply_damage', targetIds: ['hag'], dice: 60, source: 'rockfall' });
        expect(r.targets[0].concentration).toMatchObject({ spell: 'Hex', broken: false, legendaryResisted: true, legendaryRemaining: 2, legendaryOf: 3 });
        expect(r.message).toMatch(/✗ failed → 👑 legendary resistance \(LR 2\/3 left\): held/);
        expect(concRow('hag')?.activeSpell).toBe('Hex');
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(2);
        expect(r.legendaryOffers).toBeUndefined();
    });

    it('apply_damage on the sheets, not auto: legendaryResistanceAvailable and the restore call, which puts Hex back and spends one', async () => {
        HAG();
        concentrating('hag');
        const { r } = await manage({ action: 'apply_damage', targetIds: ['hag'], dice: 60, source: 'rockfall' });
        const repair = "concentration_manage restore {characterId: 'hag', spell: 'Hex', spellLevel: 1, startedAt: 1, maxDuration: 10, targetIds: ['kael'], spendLegendaryResistance: true}";
        expect(r.targets[0].concentration).toMatchObject({
            broken: true, legendaryResistanceAvailable: 3,
            legendaryOffer: { remaining: 3, of: 3, call: repair, line: `⭐ LR 3/3 left, spend one? ${repair}` }
        });
        expect(r.targets[0].concentration.legendaryOffer.saveRef).toBeUndefined();
        expect(r.legendaryOffers).toEqual([expect.objectContaining({ participantId: 'hag', kind: 'concentration', condition: 'Hex', call: repair, noFight: true })]);
        expect(r.message).toContain(repair);
        expect(concRow('hag')).toBeNull();
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(3);

        const restored = await conc({ action: 'restore', characterId: 'hag', spell: 'Hex', spellLevel: 1, startedAt: 1, maxDuration: 10, targetIds: ['kael'], spendLegendaryResistance: true });
        expect(restored).toMatchObject({ success: true, concentrationRestored: HEX, legendaryResistanceSpent: true, legendaryResistancesRemaining: 2, of: 3 });
        expect(restored.message).toMatch(/👑 Hag turns the failed concentration save into a success: concentration on Hex holds again .*LR 2\/3 left/);
        expect(concRow('hag')).toMatchObject({ activeSpell: 'Hex', startedAt: 1, maxDuration: 10, targetIds: ['kael'] });
        expect(sheetRow('hag').concentratingOn).toBe('Hex');
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(2);
    });

    it('restore refuses, writing nothing: a spell held since, none left, a live token', async () => {
        HAG({ legendaryResistancesRemaining: 0 });
        const none = await conc({ action: 'restore', characterId: 'hag', spell: 'Hex', spellLevel: 1, startedAt: 1, spendLegendaryResistance: true });
        expect(none).toMatchObject({ error: true, writes: 'none' });
        expect(none.message).toMatch(/no legendary resistance left/);
        expect(concRow('hag')).toBeNull();

        concentrating('hag');
        const held = await conc({ action: 'restore', characterId: 'hag', spell: 'Bless', spellLevel: 1, startedAt: 1 });
        expect(held).toMatchObject({ error: true, writes: 'none' });
        expect(held.message).toMatch(/started concentrating on Hex since the save, so Bless cannot come back/);
        expect(concRow('hag')?.activeSpell).toBe('Hex');

        new ConcentrationRepository(getDb()).delete('hag');
        new CharacterRepository(getDb()).update('hag', { legendaryResistancesRemaining: 2 } as any);
        await fight([BRUTE, HAG_TOKEN]);
        const live = await conc({ action: 'restore', characterId: 'hag', spell: 'Hex', spellLevel: 1, startedAt: 1, spendLegendaryResistance: true });
        expect(live).toMatchObject({ error: true, writes: 'none' });
        expect(live.message).toMatch(/has a token in encounter .*combat_manage legendary_resistance/);
        expect(concRow('hag')).toBeNull();
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(2);
    });

    it('a pc sheet off a fight is asked: auto never spends for it', async () => {
        sheet('kael', 'Kael', { characterType: 'pc', legendaryResistances: 2, legendaryResistancesRemaining: 2, autoLegendaryResistance: true });
        concentrating('kael');
        const { r } = await manage({ action: 'apply_damage', targetIds: ['kael'], dice: 60, source: 'rockfall' });
        expect(r.targets[0].concentration).toMatchObject({ broken: true, legendaryResistanceAvailable: 2, legendaryResistanceAskPlayer: true, legendaryOffer: { askPlayer: true } });
        expect(r.targets[0].concentration.legendaryOffer.line).toMatch(/^⭐ Kael failed with 2\/2 legendary resistance left: ask the player\. If they spend one: concentration_manage restore/);
        expect(sheetRow('kael').legendaryResistancesRemaining).toBe(2);
    });

    it('concentration_manage check_save with no fight: auto spends from the sheet; otherwise the restore call', async () => {
        HAG({ autoLegendaryResistance: true });
        concentrating('hag');
        const auto = await conc({ action: 'check_save', characterId: 'hag', damageAmount: 60 });
        expect(auto).toMatchObject({ spell: 'Hex', maintained: true, broken: false, legendaryResisted: true, legendaryRemaining: 2 });
        expect(auto.message).toMatch(/Hag: Concentration on Hex: CON save \d+ vs DC 30 ✗ failed → 👑 legendary resistance \(LR 2\/3 left\): held/);
        expect(concRow('hag')?.activeSpell).toBe('Hex');
        expect(sheetRow('hag').legendaryResistancesRemaining).toBe(2);

        new CharacterRepository(getDb()).update('hag', { autoLegendaryResistance: false } as any);
        const offered = await conc({ action: 'check_save', characterId: 'hag', damageAmount: 60 });
        expect(offered).toMatchObject({ broken: true, legendaryResistanceAvailable: 2, legendaryOffer: { remaining: 2, call: expect.stringMatching(/^concentration_manage restore \{characterId: 'hag', spell: 'Hex'/) } });
        expect(offered.legendaryOffers).toEqual([expect.objectContaining({ kind: 'concentration', noFight: true })]);
        expect(concRow('hag')).toBeNull();
    });

    it('concentration_manage check_save on a character with a live token: the offer rides the fight with a saveRef', async () => {
        HAG();
        concentrating('hag');
        await fight([BRUTE, HAG_TOKEN]);
        const r = await conc({ action: 'check_save', characterId: 'hag', damageAmount: 60 });
        const call = callFor(enc!, 'hag', 'con-1-hag-1', 'concentration save on Hex');
        expect(r).toMatchObject({ broken: true, legendaryOffer: { saveRef: 'con-1-hag-1', call } });
        expect(r.legendaryOffers).toEqual([expect.objectContaining({ saveRef: 'con-1-hag-1', kind: 'concentration' })]);
        expect(tok('hag').pendingLegendaryOffers).toEqual([expect.objectContaining({ ref: 'con-1-hag-1', concentration: HEX })]);
        clearCombatState();
        const { r: spent } = await manage({ action: 'legendary_resistance', participantId: 'hag', saveRef: 'con-1-hag-1', reason: 'concentration save on Hex' });
        expect(spent).toMatchObject({ success: true, concentrationRestored: HEX });
        expect(concRow('hag')?.activeSpell).toBe('Hex');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// A stunt's target save
// ─────────────────────────────────────────────────────────────────────────

describe("a stunt's target save asks legendary resistance", () => {
    const OGRE = (over: Record<string, unknown> = {}) => sheet('ogre', 'Ogre', { stats: { str: 18, dex: 1, con: 16, int: 5, wis: 7, cha: 7 }, legendaryResistances: 3, legendaryResistancesRemaining: 3, ...over });
    const ACTOR = () => sheet('luciel', 'Luciel', { characterType: 'pc', stats: { str: 30, dex: 14, con: 20, int: 12, wis: 12, cha: 16 }, level: 15 });
    const OGRE_TOKEN = { id: 'ogre', name: 'Ogre', hp: 200, maxHp: 200, initiative: 5, isEnemy: true, position: { x: 1, y: 0 } };
    const LUCIEL_TOKEN = { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 20, position: { x: 0, y: 0 } };
    /** A stunt that always lands (modifier 30 vs DC 5, save DEX 1 vs DC 30): 8 damage, half on a save. */
    const kick = async (extra: Record<string, unknown> = {}) => {
        let out = await improv({ action: 'stunt', actorId: 'luciel', skill: 'athletics', dc: 5, modifier: 30, successDamage: '8', targetIds: ['ogre'], savingThrowAbility: 'dex', savingThrowDc: 30, halfDamageOnSave: true, narrativeIntent: 'kick the brazier', ...extra });
        for (let i = 0; i < 20 && out.r.natural === 1; i++) out = await improv({ action: 'stunt', actorId: 'luciel', skill: 'athletics', dc: 5, modifier: 30, successDamage: '8', targetIds: ['ogre'], savingThrowAbility: 'dex', savingThrowDc: 30, halfDamageOnSave: true, narrativeIntent: 'kick the brazier', ...extra });
        return out;
    };

    it('in a fight, auto: the save succeeds, half damage, the token and the sheet keep the count', async () => {
        OGRE({ autoLegendaryResistance: true });
        ACTOR();
        await fight([LUCIEL_TOKEN, OGRE_TOKEN], 'k-stunt');
        const { r, text } = await kick({ encounterId: enc });
        expect(r.targets[0]).toMatchObject({ id: 'ogre', saved: true, damage: 4, legendaryResisted: true, legendaryRemaining: 2, legendaryOf: 3, hpAfter: 196 });
        expect(text).toMatch(/👑 ogre: the failed save becomes a success \(legendary resistance, LR 2\/3 left\)/);
        expect(tok('ogre').legendaryResistancesRemaining).toBe(2);
        expect(sheetRow('ogre').legendaryResistancesRemaining).toBe(2);
        expect(tok('ogre').hp).toBe(196);
    });

    it('in a fight, offered: full damage lands, the saveRef heals the avoided half back on the token and the sheet', async () => {
        OGRE();
        ACTOR();
        await fight([LUCIEL_TOKEN, OGRE_TOKEN], 'k-stunt');
        const { r, text } = await kick({ encounterId: enc });
        const call = callFor(enc!, 'ogre', 'stu-1-ogre-1', 'save vs the stunt (kick the brazier)');
        expect(r.targets[0]).toMatchObject({ saved: false, damage: 8, hpAfter: 192, legendaryOffer: { saveRef: 'stu-1-ogre-1', remaining: 3, of: 3, call } });
        expect(r.legendaryOffers).toEqual([expect.objectContaining({ saveRef: 'stu-1-ogre-1', kind: 'stunt', condition: 'kick the brazier', call })]);
        expect(text).toContain(call);
        expect(tok('ogre').pendingLegendaryOffers).toEqual([{ ref: 'stu-1-ogre-1', kind: 'stunt', condition: 'kick the brazier', round: 1, refund: 4 }]);
        expect(tok('ogre').hp).toBe(192);

        clearCombatState();
        const { r: spent } = await manage({ action: 'legendary_resistance', participantId: 'ogre', saveRef: 'stu-1-ogre-1', reason: 'the brazier' });
        expect(spent).toMatchObject({ success: true, remaining: 2, refunded: 4, hp: 196 });
        expect(spent.message).toMatch(/👑 Ogre turns the failed save vs the stunt \(kick the brazier\) into a success \(the brazier\): 4 HP back; LR 2\/3 left/);
        expect(tok('ogre').hp).toBe(196);
        expect(sheetRow('ogre').hp).toBe(196);
        expect(sheetRow('ogre').legendaryResistancesRemaining).toBe(2);
    });

    it('in a fight, a player character target is asked, never spent for', async () => {
        OGRE({ characterType: 'pc', autoLegendaryResistance: true });
        ACTOR();
        await fight([LUCIEL_TOKEN, { ...OGRE_TOKEN, isEnemy: false }], 'k-stunt');
        const { r } = await kick({ encounterId: enc });
        expect(r.targets[0]).toMatchObject({ saved: false, damage: 8, legendaryOffer: { saveRef: 'stu-1-ogre-1', askPlayer: true } });
        expect(r.targets[0].legendaryOffer.line).toMatch(/^⭐ Ogre failed with 3\/3 legendary resistance left: ask the player/);
        expect(tok('ogre').legendaryResistancesRemaining).toBe(3);
    });

    it('off a fight a report only: nothing spent even with autoLegendaryResistance, the repair call to paste', async () => {
        OGRE({ autoLegendaryResistance: true });
        ACTOR();
        const { r } = await kick();
        expect(r.targets[0]).toMatchObject({
            saved: false, damage: 8, hpAfter: 192, legendaryResistanceAvailable: 3,
            legendaryOffer: { remaining: 3, call: "character_manage update {characterId: 'ogre', legendaryResistancesRemaining: 2, hp: 196}" }
        });
        expect(r.targets[0].legendaryResisted).toBeUndefined();
        expect(r.legendaryOffers).toEqual([expect.objectContaining({ kind: 'stunt', noFight: true })]);
        expect(sheetRow('ogre').legendaryResistancesRemaining).toBe(3);
        expect(sheetRow('ogre').hp).toBe(192);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// An aura's save: a report that writes nothing
// ─────────────────────────────────────────────────────────────────────────

describe("an aura's failed save carries the offer text; nothing is spent", () => {
    it('Spirit Guardians on a legendary auto monster: the row offers, the token keeps its count', async () => {
        sheet('cleric', 'Cleric', { characterType: 'pc', stats: { str: 10, dex: 10, con: 14, int: 10, wis: 18, cha: 10 } });
        await fight([
            { id: 'cleric', name: 'Cleric', hp: 40, maxHp: 40, initiative: 20, position: { x: 5, y: 5 } },
            { id: 'dragon', name: 'Dragon', hp: 300, maxHp: 300, initiative: 10, isEnemy: true, position: { x: 6, y: 5 }, legendaryResistances: 3, autoLegendaryResistance: true, stats: { str: 20, dex: 10, con: 20, int: 10, wis: 1, cha: 10 } }
        ], 'k-aura');
        await aura({ action: 'create', ownerId: 'cleric', spellName: 'Spirit Guardians', spellLevel: 3, radius: 15, affectsEnemies: true, effects: [{ trigger: 'start_of_turn', type: 'damage', dice: '3d8', damageType: 'radiant', saveType: 'wisdom', saveDC: 40 }], currentRound: 1 });
        const { r, text } = await aura({ action: 'process', encounterId: enc, targetId: 'dragon', trigger: 'start_of_turn' });
        const call = `combat_manage legendary_resistance {encounterId: '${enc}', participantId: 'dragon', reason: 'Spirit Guardians save'}`;
        expect(r.effects[0]).toMatchObject({ auraName: 'Spirit Guardians', succeeded: false, saveDC: 40, legendaryResistanceAvailable: 3, legendaryOffer: { remaining: 3, of: 3, call } });
        expect(r.effects[0].legendaryOffer.line).toBe(`⭐ LR 3/3 left, spend one? ${call} (the aura report wrote nothing: on a spend the save succeeds, so apply none of this effect)`);
        expect(r.effects[0].legendaryResisted).toBeUndefined();
        expect(text).toContain(r.effects[0].legendaryOffer.line);
        expect(tok('dragon').legendaryResistancesRemaining).toBe(3);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Seeded replay, output_mode summary
// ─────────────────────────────────────────────────────────────────────────

describe('seeded replay and output_mode summary', () => {
    it('a seeded fight replays the concentration save and its offer, straight through or reloaded in a new process', async () => {
        const run = async (restart: boolean) => {
            closeDb(); getDb(':memory:'); clearCombatState();
            HAG();
            concentrating('hag');
            await fight([BRUTE, HAG_TOKEN], 'k-replay');
            if (restart) clearCombatState();
            const { r } = await manage({ action: 'apply_damage', targetIds: ['hag'], dice: '10d10+30', source: 'rockfall' });
            const c = r.targets[0].concentration;
            return { damage: r.damageRolled, saveRoll: c.saveRoll, saveDC: c.saveDC, broken: c.broken, offer: { ...c.legendaryOffer, call: c.legendaryOffer.call.replace(enc!, '<enc>'), line: c.legendaryOffer.line.replace(enc!, '<enc>') } };
        };
        const a = await run(false);
        const b = await run(true);
        expect(a.broken).toBe(true);
        expect(b).toEqual(a);
        expect(a.offer).toMatchObject({ saveRef: 'con-1-hag-1', remaining: 3, call: callFor('<enc>', 'hag', 'con-1-hag-1', 'concentration save on Hex') });
    });

    it('output_mode summary keeps the concentration offer, the call whole', async () => {
        const id = 'grandmother-thornwick-hag-of-the-black-briar-and-the-weeping-fen';
        const spell = 'Hex of the Thousand Thorns Upon the Faithless and the Oathbreakers';
        sheet(id, 'Grandmother Thornwick, Hag of the Black Briar and the Weeping Fen', { legendaryResistances: 3, legendaryResistancesRemaining: 3 });
        new ConcentrationRepository(getDb()).create({ characterId: id, activeSpell: spell, spellLevel: 1, targetIds: [], startedAt: 1, maxDuration: 10, saveDCBase: 10 });
        await fight([BRUTE, { ...HAG_TOKEN, id, name: 'Grandmother Thornwick, Hag of the Black Briar and the Weeping Fen' }]);
        const { d } = await smash(60, id);
        const summary = summarizeResult(d) as Record<string, any>;
        const call = callFor(enc!, id, `con-1-${id}-1`, `concentration save on ${spell}`);
        expect(call.length).toBeGreaterThan(300);
        expect(summary.legendaryOffers).toEqual([expect.objectContaining({ saveRef: `con-1-${id}-1`, kind: 'concentration', call })]);
    });
});
