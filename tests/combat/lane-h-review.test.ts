/**
 * Play report 7 (lane H review): the concentration CON save and the
 * save_ends end-of-turn save, pushed where the lane's own tests did not go.
 *
 * - A blow that drops a concentrating creature to 0 HP ends its spell
 *   outright (5e): the attack and cast_spell used to roll a CON save anyway,
 *   and with a declared source the new line printed '✓ held' over a spell
 *   that had just ended.
 * - A unit token's end-of-turn save adds its drilled unit.saves bonus, as its
 *   area saves do.
 * - A surprised first slot's end-of-turn save rides create's JSON
 *   (endOfTurnSaves), so output_mode summary keeps it.
 * - Several save_ends conditions, a downed token, a condition with no save
 *   ability, and reconcile reading the new purposes.
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { normalizeCondition } from '../../src/engine/combat/conditions.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { ConcentrationRepository } from '../../src/storage/repos/concentration.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { reconcileWorld } from '../../src/server/reconcile.js';
import { summarizeResult } from '../../src/server/output-mode.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'unscoped' };
const embed = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const guardedAction = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
let enc: string | undefined;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guardedManage(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    return { text, r: embed(text, 'COMBAT_MANAGE') ?? embed(text, 'STATE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : { rawText: text }) };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await guardedAction(CombatActionTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    const d = embed(text, 'COMBAT_ACTION') ?? embed(text, 'STATE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : null);
    return { text, d, r: d?.actionResult ?? d };
};
const rollsFor = (forId: string) => queryRolls(getDb(), { forId, limit: 200 }) as Array<{ purpose: string; dice: Array<{ value: number }> }>;
const concRolls = (forId: string) => rollsFor(forId).filter(x => x.purpose.startsWith('concentration'));
const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };
const now = () => new Date().toISOString();

function cleric(over: Record<string, unknown> = {}) {
    new CharacterRepository(getDb()).create({
        id: 'cleric', name: 'Cleric', characterType: 'pc', level: 5, hp: 8, maxHp: 60, ac: 12,
        stats: { str: 10, dex: 10, con: 14, int: 10, wis: 16, cha: 10 },
        conditions: [], createdAt: now(), updatedAt: now(), ...over
    } as any);
    new ConcentrationRepository(getDb()).create({ characterId: 'cleric', activeSpell: 'Bless', spellLevel: 1, targetIds: [], startedAt: 1, maxDuration: 10, saveDCBase: 10 } as any);
}
function mage() {
    new CharacterRepository(getDb()).create({
        id: 'mage', name: 'Mage', characterClass: 'wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
        hp: 30, maxHp: 30, ac: 12, level: 5, spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: getMaxSpellLevel('wizard' as any, 5),
        knownSpells: ['Magic Missile'], preparedSpells: ['Magic Missile'], cantripsKnown: [], createdAt: now(), updatedAt: now()
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
const STEADY_MIND = [{ type: 'advantage_on', value: 'save:con' }];
const BRUTE = { id: 'brute', name: 'Brute', hp: 40, maxHp: 40, ac: 12, initiative: 30, isEnemy: true, position: { x: 1, y: 0 }, attackBonus: 5, attackDamage: '1d8+3' };
const CLERIC = (extra: Record<string, unknown> = {}) => ({ id: 'cleric', name: 'Cleric', hp: 8, maxHp: 60, ac: 12, initiative: 5, position: { x: 0, y: 0 }, ...extra });

beforeEach(() => {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    enc = undefined;
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('a blow that drops a concentrating creature to 0 HP ends the spell without a CON save', () => {
    it('an attack: no concentration die, no "held" line over a spell that ended at 0 HP', async () => {
        cleric();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        enc = (await manage({ action: 'create', seed: 'h-review-drop', participants: [BRUTE, CLERIC()] })).r.encounterId;
        const { r, d, text } = await act({ action: 'attack', actorId: 'brute', targetId: 'cleric', outcome: 'hit', damage: 12 });
        expect(r.success).toBe(true);
        expect(r.defeated).toBe(true);
        expect(concRolls('cleric')).toEqual([]);
        expect(text).not.toMatch(/✓ held/);
        expect(r.concentrationSaves).toBeUndefined();
        expect(d.saveSources).toBeUndefined();
        expect(new ConcentrationRepository(getDb()).isConcentrating('cleric')).toBe(false);
    });

    it('a spell (Magic Missile): no concentration die, no "held" line', async () => {
        cleric({ hp: 2 });
        mage();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        enc = (await manage({ action: 'create', seed: 'h-review-mm', participants: [{ id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 50 }, CLERIC({ hp: 2, isEnemy: true })] })).r.encounterId;
        const { r, text } = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Magic Missile', targetId: 'cleric' });
        expect(r.success).not.toBe(false);
        expect(concRolls('cleric')).toEqual([]);
        expect(text).not.toMatch(/✓ held/);
        expect(r.concentrationSaves).toBeUndefined();
        expect(new ConcentrationRepository(getDb()).isConcentrating('cleric')).toBe(false);
    });

    it('a survivor still rolls: the attack that leaves it standing rolls the labelled save', async () => {
        cleric({ hp: 60 });
        effect('cleric', 'Steady Mind', STEADY_MIND);
        enc = (await manage({ action: 'create', seed: 'h-review-stand', participants: [BRUTE, CLERIC({ hp: 60 })] })).r.encounterId;
        const { r } = await act({ action: 'attack', actorId: 'brute', targetId: 'cleric', outcome: 'hit', damage: 12 });
        expect(r.defeated).toBeFalsy();
        expect(concRolls('cleric').map(x => x.purpose)).toEqual(['concentration (adv: Steady Mind (save:con))']);
    });
});

describe('output_mode summary keeps whether the concentration held', () => {
    it('the concentration saveSources row says broken: true / false, so a summary reply carries the outcome', async () => {
        cleric({ hp: 60 });
        effect('cleric', 'Steady Mind', STEADY_MIND);
        enc = (await manage({ action: 'create', seed: 'h-review-summary', participants: [BRUTE, CLERIC({ hp: 60 })] })).r.encounterId;
        d20s(2, 3);
        const failed = await manage({ action: 'apply_damage', targetIds: ['cleric'], dice: 4, source: 'rockfall' });
        expect(failed.r.targets[0].concentration).toMatchObject({ broken: true, saveRolls: [2, 3] });
        const summary = summarizeResult(failed.r) as Record<string, any>;
        expect(summary.saveSources).toEqual([expect.objectContaining({ targetId: 'cleric', save: 'concentration on Bless', broken: true, rolls: [2, 3], advantage: ['Steady Mind (save:con)'] })]);
        vi.restoreAllMocks();
        new ConcentrationRepository(getDb()).create({ characterId: 'cleric', activeSpell: 'Bless', spellLevel: 1, targetIds: [], startedAt: 1, maxDuration: 10, saveDCBase: 10 } as any);
        d20s(18, 5);
        const held = await manage({ action: 'apply_damage', targetIds: ['cleric'], dice: 4, source: 'rockfall' });
        expect((summarizeResult(held.r) as Record<string, any>).saveSources).toEqual([expect.objectContaining({ save: 'concentration on Bless', broken: false })]);
    });
});

describe('the save_ends end-of-turn save, pushed further', () => {
    const WEBBED = { name: 'webbed', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' };

    it('a unit token adds its drilled unit.saves bonus, as its area saves do', async () => {
        enc = (await manage({ action: 'create', seed: 'h-review-unit', participants: [
            { id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 20, ac: 11, stats: { dex: 12 }, conditions: [WEBBED],
                unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 2, morale: 6, saves: { dex: 2 } } },
            { id: 'orc', name: 'Orc', hp: 15, maxHp: 15, initiative: 5, isEnemy: true }
        ] })).r.encounterId;
        const { r } = await manage({ action: 'advance', confirm: true });
        // DEX 12 (+1) + drilled +2.
        expect(r.endOfTurnSaves[0]).toMatchObject({ participantId: 'militia', modifier: 3, parts: ['DEX +1', 'drilled +2'] });
        expect(r.endOfTurnSaves[0].total).toBe(r.endOfTurnSaves[0].natural + 3);
    });

    it('a surprised first slot\'s end-of-turn save rides create\'s JSON, and output_mode summary keeps it', async () => {
        new CharacterRepository(getDb()).create({
            id: 'varek', name: 'Varek', characterType: 'pc', level: 5, hp: 60, maxHp: 60, ac: 13,
            stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 }, conditions: [], createdAt: now(), updatedAt: now()
        } as any);
        effect('varek', 'Danger Sense', [{ type: 'advantage_on', value: 'save:dex' }]);
        const { r, text } = await manage({ action: 'create', seed: 'h-review-surprise', surprised: ['varek'], participants: [
            { id: 'varek', name: 'Varek', hp: 60, maxHp: 60, initiative: 20, conditions: [WEBBED] },
            { id: 'orc', name: 'Orc', hp: 15, maxHp: 15, initiative: 5, isEnemy: true }
        ] });
        expect(text).toMatch(/Varek's end-of-turn DEX save vs webbed: .*adv: Danger Sense \(save:dex\)/);
        expect(r.endOfTurnSaves).toEqual([expect.objectContaining({ participantId: 'varek', condition: 'webbed', advantage: ['Danger Sense (save:dex)'] })]);
        expect(r.endOfTurnSaves[0].rolls).toHaveLength(2);
        const summary = summarizeResult(r) as Record<string, any>;
        expect(summary.endOfTurnSaves).toEqual([expect.objectContaining({ participantId: 'varek', advantage: ['Danger Sense (save:dex)'], line: expect.stringMatching(/^Varek's end-of-turn DEX save/) })]);
    });

    const engineWith = (conditions: unknown[], hp = 60) => {
        const e = new CombatEngine('h-review');
        e.startEncounter([
            { id: 'varek', name: 'Varek', initiativeBonus: 0, initiative: 20, hp, maxHp: 60, conditions: [], abilityScores: { strength: 10, dexterity: 12, constitution: 14, intelligence: 10, wisdom: 10, charisma: 10 } },
            { id: 'orc', name: 'Orc', initiativeBonus: 0, initiative: 5, hp: 15, maxHp: 15, conditions: [], isEnemy: true }
        ] as any);
        const v = e.getState()!.participants.find(p => p.id === 'varek')!;
        for (const c of conditions) v.conditions.push(normalizeCondition(c as never, 'varek')!);
        e.drainRollRecords();
        return e;
    };

    it('several save_ends conditions: each rolls its own save; restrained hampers the DEX save it still stands over, and not once it ends', () => {
        // restrained first: fails (6+1 = 7 vs 13) with disadvantage; then webbed's DEX save is also at disadvantage.
        const a = engineWith([{ name: 'restrained', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' }, WEBBED]);
        d20s(15, 6, 18, 2);
        a.nextTurnWithConditions();
        expect(a.endOfTurnSaves.map(s => [s.condition, s.rolls, s.saved, s.disadvantage])).toEqual([
            ['restrained', [15, 6], false, ['restrained']],
            ['webbed', [18, 2], false, ['restrained']]
        ]);
        // restrained first: saves (20 + 1); webbed's save rolls one die.
        const b = engineWith([{ name: 'restrained', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' }, WEBBED]);
        d20s(20, 20, 3);
        b.nextTurnWithConditions();
        expect(b.endOfTurnSaves.map(s => [s.condition, s.rolls, s.saved, s.disadvantage])).toEqual([
            ['restrained', [20, 20], true, ['restrained']],
            ['webbed', [3], false, undefined]
        ]);
    });

    it('lane L: plain 5e, so the line follows the total (13 vs DC 13 saves on a natural 1; 11 fails on a natural 20) and names no natural die', () => {
        const a = engineWith([WEBBED]);
        d20s(1);
        a.nextTurnWithConditions({ saverSides: () => ({ advantage: [], disadvantage: [], modifier: { total: 12, parts: ['DEX +1', 'bonus +11'] } }) });
        expect(a.endOfTurnSaves[0]).toMatchObject({ natural: 1, total: 13, saved: true });
        expect(a.endOfTurnSaves[0].line).toMatch(/= 13 vs DC 13 \(DEX \+1, bonus \+11\) ✓ saved: webbed ends$/);
        const b = engineWith([WEBBED]);
        d20s(20);
        b.nextTurnWithConditions({ saverSides: () => ({ advantage: [], disadvantage: [], modifier: { total: -9, parts: ['DEX -9'] } }) });
        expect(b.endOfTurnSaves[0]).toMatchObject({ natural: 20, total: 11, saved: false });
        expect(b.endOfTurnSaves[0].line).toMatch(/= 11 vs DC 13 \(DEX -9\) ✗ failed: still webbed$/);
        // A natural 20 that meets the DC reads the same as any other success.
        const c = engineWith([WEBBED]);
        d20s(20);
        c.nextTurnWithConditions();
        expect(c.endOfTurnSaves[0].line).toMatch(/✓ saved: webbed ends$/);
    });

    it('a downed token rolls no end-of-turn save; a save_ends condition with no save ability rolls none', () => {
        const down = engineWith([WEBBED], 0);
        down.nextTurnWithConditions();
        expect(down.endOfTurnSaves).toEqual([]);
        const noAbility = engineWith([{ name: 'webbed', durationType: 'save_ends', saveDC: 13 }]);
        noAbility.nextTurnWithConditions();
        expect(noAbility.endOfTurnSaves).toEqual([]);
        expect(noAbility.drainRollRecords().filter(r => r.forId === 'varek')).toEqual([]);
    });
});

describe('reconcile does not read the new purposes as named sources', () => {
    it('a sheet with Exhaustion 3 and a Restrained condition: concentration and save_ends purposes raise no advantage_source_undeclared', async () => {
        const W = 'w-h-review';
        new WorldRepository(getDb()).create({ id: W, name: 'Reach', seed: 's', width: 10, height: 10, createdAt: now(), updatedAt: now() } as any);
        cleric({ hp: 60, worldId: W, conditions: [{ name: 'Exhaustion 3' }, { name: 'Restrained: pinned' }, { name: 'Steady Mind' }] });
        effect('cleric', 'Steady Mind', STEADY_MIND);
        await manage({ action: 'apply_damage', targetIds: ['cleric'], dice: 6, source: 'rockfall' });
        const logged = concRolls('cleric').map(x => x.purpose);
        expect(logged).toEqual(['concentration (adv: Steady Mind (save:con); dis: exhaustion 3)']);
        const report = reconcileWorld(getDb(), W, 'cleric');
        expect(report.findings.filter(f => f.kind === 'advantage_source_undeclared')).toEqual([]);
    });
});
