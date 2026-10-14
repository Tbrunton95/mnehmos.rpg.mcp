/**
 * Play report 7 (lane H): the concentration CON save reads declared save sides.
 *
 * Lane G1 wired the saver's untagged save:<ability> mechanics and the
 * standard conditions' 5e save rules into every save the engine rolls through
 * rollParticipantSave / rollCharacterSave. The concentration save rolled its
 * own one d20 on every road (an attack, cast_spell, an area, apply_damage on
 * the sheets, an execute, concentration_manage check_save), so 'Steady Mind'
 * {advantage_on, save:con} (War Caster) rolled one die logged 'concentration'
 * and exhaustion 3 did not apply. Now every road shares one roll that reads
 * the concentrating creature's sides through lane G1's code: two dice on the
 * same logged, seeded stream, the purpose labelled
 * 'concentration (adv: Steady Mind (save:con))', the labels on the reply's
 * concentration result and a saveSources row. A tagged mechanic does not fire
 * (no call asserts a tag) and is named as a hint. With no source the purpose
 * and the reply are exactly as before. (The world spell and the sheet
 * execute are covered in tests/server/world-spells.test.ts and
 * tests/combat/grapple-sheet-execute.test.ts.)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { handleConcentrationManage } from '../../src/server/consolidated/concentration-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { fightConcentrationDie } from '../../src/engine/combat/saves.js';
import { checkConcentration } from '../../src/engine/magic/concentration.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { ConcentrationRepository } from '../../src/storage/repos/concentration.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { replyJson } from '../../src/server/reply-status.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'unscoped' };
const embed = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const guardedAction = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
const guardedConc = withOperation('concentration_manage', (a) => handleConcentrationManage(a, ctx as any));
let enc: string | undefined;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guardedManage(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    return { text, r: embed(text, 'COMBAT_MANAGE') ?? { rawText: text } };
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
        id: 'cleric', name: 'Cleric', characterType: 'pc', level: 5, hp: 60, maxHp: 60, ac: 12,
        stats: { str: 10, dex: 10, con: 14, int: 10, wis: 16, cha: 10 },
        conditions: [], createdAt: now(), updatedAt: now(), ...over
    } as any);
    new ConcentrationRepository(getDb()).create({ characterId: 'cleric', activeSpell: 'Bless', spellLevel: 1, targetIds: [], startedAt: 1, maxDuration: 10, saveDCBase: 10 } as any);
}
function mage() {
    new CharacterRepository(getDb()).create({
        id: 'mage', name: 'Mage', characterClass: 'wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
        hp: 30, maxHp: 30, ac: 12, level: 5, spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: getMaxSpellLevel('wizard' as any, 5),
        knownSpells: ['Fireball', 'Magic Missile'], preparedSpells: ['Fireball', 'Magic Missile'], cantripsKnown: [], createdAt: now(), updatedAt: now()
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
const STEADY = 'Steady Mind (save:con)';

const CLERIC = (extra: Record<string, unknown> = {}) => ({ id: 'cleric', name: 'Cleric', hp: 60, maxHp: 60, ac: 12, initiative: 5, position: { x: 0, y: 0 }, ...extra });
const BRUTE = { id: 'brute', name: 'Brute', hp: 40, maxHp: 40, ac: 12, initiative: 30, isEnemy: true, position: { x: 1, y: 0 }, attackBonus: 5, attackDamage: '1d8+3' };
async function fight(participants: Array<Record<string, unknown>>, seed = 'h-conc') {
    enc = (await manage({ action: 'create', seed, participants })).r.encounterId;
    expect(enc).toBeTruthy();
}
const hit = (damage = 8) => act({ action: 'attack', actorId: 'brute', targetId: 'cleric', outcome: 'hit', damage });

beforeEach(() => {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    enc = undefined;
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('the shared concentration roll', () => {
    it('reads Steady Mind through lane G1: two dice under one labelled purpose, the labels on the check', () => {
        cleric();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        const e = new CombatEngine('h-unit');
        e.startEncounter([{ id: 'cleric', name: 'Cleric', initiativeBonus: 0, initiative: 20, hp: 60, maxHp: 60, conditions: [] }] as any);
        e.drainRollRecords();
        const row = new CharacterRepository(getDb()).findById('cleric')!;
        const r = checkConcentration(row, 12, new ConcentrationRepository(getDb()), 0, fightConcentrationDie(e, getDb(), 'cleric'));
        expect(r.saveRolls).toHaveLength(2);
        expect(r.saveRoll).toBe(Math.max(...r.saveRolls!));
        expect(r.advantageSources).toEqual([STEADY]);
        const recs = e.drainRollRecords().filter(x => x.forId === 'cleric');
        expect(recs.map(x => x.purpose)).toEqual([`concentration (adv: ${STEADY})`]);
        expect(recs[0].dice.map(d => d.value)).toEqual(r.saveRolls);
    });

    it('a plain number die still works (direct engine callers): one die, no labels', () => {
        cleric();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        const row = new CharacterRepository(getDb()).findById('cleric')!;
        const r = checkConcentration(row, 12, new ConcentrationRepository(getDb()), 0, () => 9);
        expect(r).toMatchObject({ saveRoll: 9, saveTotal: 11 });
        expect(r.advantageSources).toBeUndefined();
        expect(r.saveRolls).toBeUndefined();
    });
});

describe('Steady Mind on every concentration road', () => {
    it('after an attack: two dice, logged and labelled; concentrationSaves, saveSources and the rule line name it', async () => {
        cleric();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        await fight([BRUTE, CLERIC()]);
        const { r, d, text } = await hit();
        expect(r.success).toBe(true);
        const logged = concRolls('cleric');
        expect(logged.map(x => x.purpose)).toEqual([`concentration (adv: ${STEADY})`]);
        expect(logged[0].dice).toHaveLength(2);
        const rolls = logged[0].dice.map(x => x.value);
        expect(r.concentrationSaves).toEqual([expect.objectContaining({ targetId: 'cleric', name: 'Cleric', spell: 'Bless', saveRolls: rolls, saveRoll: Math.max(...rolls), saveDC: 10, advantageSources: [STEADY] })]);
        expect(d.saveSources).toEqual([{ targetId: 'cleric', name: 'Cleric', ability: 'constitution', save: 'concentration on Bless', broken: r.concentrationSaves[0].broken, rolls, advantage: [STEADY] }]);
        expect(text).toMatch(new RegExp(`Concentration on Bless: CON save \\d+ vs DC 10 .*\\[d20 ${rolls[0]}, ${rolls[1]}; adv: Steady Mind \\(save:con\\)\\]`));
    });

    it('after an area (apply_damage in a fight): the target\'s concentration result, its line and saveSources', async () => {
        cleric();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        await fight([BRUTE, CLERIC()]);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['cleric'], dice: 6, source: 'rockfall' });
        expect(r.success).toBe(true);
        const c = r.targets[0].concentration;
        expect(c).toMatchObject({ spell: 'Bless', saveDC: 10, advantageSources: [STEADY] });
        expect(c.saveRolls).toHaveLength(2);
        expect(c.saveRoll).toBe(Math.max(...c.saveRolls));
        expect(r.message).toMatch(/Concentration on Bless: CON save \d+ vs DC 10 .*\[d20 \d+, \d+; adv: Steady Mind \(save:con\)\]/);
        expect(r.saveSources).toEqual([{ targetId: 'cleric', name: 'Cleric', ability: 'constitution', save: 'concentration on Bless', broken: c.broken, rolls: c.saveRolls, advantage: [STEADY] }]);
        expect(concRolls('cleric').map(x => x.purpose)).toEqual([`concentration (adv: ${STEADY})`]);
    });

    it('after a spell (cast_spell Magic Missile): concentrationSaves and saveSources', async () => {
        cleric();
        mage();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        await fight([{ id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 50 }, CLERIC({ isEnemy: true })]);
        const { r, d, text } = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Magic Missile', targetId: 'cleric' });
        expect(r.concentrationSaves).toEqual([expect.objectContaining({ targetId: 'cleric', spell: 'Bless', advantageSources: [STEADY] })]);
        expect(r.concentrationSaves[0].saveRolls).toHaveLength(2);
        expect(d.saveSources).toEqual([expect.objectContaining({ targetId: 'cleric', save: 'concentration on Bless', advantage: [STEADY] })]);
        expect(text).toMatch(/Concentration on Bless: CON save .*adv: Steady Mind \(save:con\)/);
        expect(concRolls('cleric').map(x => x.purpose)).toEqual([`concentration (adv: ${STEADY})`]);
    });

    it('after a save spell (Fireball): the DEX save and the concentration save are two rows of saveSources', async () => {
        cleric();
        mage();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        effect('cleric', 'Danger Sense', [{ type: 'advantage_on', value: 'save:dex' }]);
        await fight([{ id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 50 }, CLERIC({ isEnemy: true })]);
        const { d } = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Fireball', targetId: 'cleric' });
        expect(d.saveSources).toEqual([
            expect.objectContaining({ targetId: 'cleric', ability: 'dexterity', advantage: ['Danger Sense (save:dex)'] }),
            expect.objectContaining({ targetId: 'cleric', ability: 'constitution', save: 'concentration on Bless', advantage: [STEADY] })
        ]);
    });

    it('apply_damage on the sheets (no fight): one logged roll holding both dice, the labels on the target', async () => {
        cleric();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['cleric'], dice: 6, source: 'rockfall' });
        expect(r.success).toBe(true);
        const c = r.targets[0].concentration;
        expect(c).toMatchObject({ spell: 'Bless', advantageSources: [STEADY] });
        const logged = concRolls('cleric');
        expect(logged.map(x => x.purpose)).toEqual([`concentration (adv: ${STEADY})`]);
        expect(logged[0].dice.map(x => x.value)).toEqual(c.saveRolls);
        expect(r.saveSources).toEqual([expect.objectContaining({ targetId: 'cleric', save: 'concentration on Bless', advantage: [STEADY] })]);
        expect(r.message).toMatch(/adv: Steady Mind \(save:con\)/);
    });

    it('concentration_manage check_save names it on the reply and in the log', async () => {
        cleric();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        const res = await guardedConc({ action: 'check_save', characterId: 'cleric', damageAmount: 12 });
        const text = res.content[0].text;
        const data = replyJson(text) as Record<string, any>;
        expect(data.advantageSources).toEqual([STEADY]);
        expect(data.saveRolls).toHaveLength(2);
        expect(data.saveRoll).toBe(Math.max(...data.saveRolls));
        expect(concRolls('cleric').map(x => x.purpose)).toEqual([`concentration (adv: ${STEADY})`]);
    });
});

describe('the standard conditions and cancelling', () => {
    it('exhaustion 3 on the token gives disadvantage: two dice, the lower kept', async () => {
        cleric();
        await fight([BRUTE, CLERIC({ conditions: [{ name: 'exhaustion', level: 3 }] })]);
        const spy = d20s(15, 4);
        const { r } = await hit();
        expect(r.concentrationSaves[0]).toMatchObject({ saveRolls: [15, 4], saveRoll: 4, disadvantageSources: ['exhaustion 3'] });
        // Both dice under the labelled purpose (mocked dice log nothing, so read the tags).
        expect(spy.mock.calls.map(c => c[0])).toEqual([{ purpose: 'concentration (dis: exhaustion 3)', forId: 'cleric' }, { purpose: 'concentration (dis: exhaustion 3)', forId: 'cleric' }]);
    });

    it('a sheet Exhaustion 3 counts on the sheets road', async () => {
        cleric({ conditions: [{ name: 'Exhaustion 3' }] });
        const { r } = await manage({ action: 'apply_damage', targetIds: ['cleric'], dice: 6, source: 'rockfall' });
        expect(r.targets[0].concentration).toMatchObject({ disadvantageSources: ['exhaustion 3'] });
        expect(r.targets[0].concentration.saveRolls).toHaveLength(2);
    });

    it('Steady Mind and exhaustion 3 cancel: one die, both named, the line says so', async () => {
        cleric();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        await fight([BRUTE, CLERIC({ conditions: [{ name: 'exhaustion', level: 3 }] })]);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['cleric'], dice: 6, source: 'rockfall' });
        const c = r.targets[0].concentration;
        expect(c.saveRolls).toBeUndefined();
        expect(c).toMatchObject({ advantageSources: [STEADY], disadvantageSources: ['exhaustion 3'] });
        expect(r.message).toMatch(/cancel: one die/);
        expect(concRolls('cleric').map(x => x.purpose)).toEqual([`concentration (adv: ${STEADY}; dis: exhaustion 3)`]);
        expect(concRolls('cleric')[0].dice).toHaveLength(1);
    });

    it('a CON-only source does not touch other saves, and save:wis does not touch concentration', async () => {
        cleric();
        effect('cleric', 'Iron Will', [{ type: 'advantage_on', value: 'save:wis' }]);
        await fight([BRUTE, CLERIC()]);
        await hit();
        expect(concRolls('cleric').map(x => x.purpose)).toEqual(['concentration']);
        expect(concRolls('cleric')[0].dice).toHaveLength(1);
    });
});

describe('a tagged mechanic does not fire, and is hinted', () => {
    it('on an area: one die, the hint on the concentration result, saveSources and the line', async () => {
        cleric();
        effect('cleric', 'Calm Focus', [{ type: 'advantage_on', value: 'save:con', condition: 'calm' }]);
        await fight([BRUTE, CLERIC()]);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['cleric'], dice: 6, source: 'rockfall' });
        const c = r.targets[0].concentration;
        expect(c.saveRolls).toBeUndefined();
        expect(c.advantageSources).toBeUndefined();
        expect(c.conditionalAdvantage).toEqual([expect.stringMatching(/^Calm Focus \(calm\): a save the engine rolls asserts no tag, so it did not fire; write the mechanic without condition: 'calm' if it holds on every CON save/)]);
        expect(r.saveSources).toEqual([expect.objectContaining({ targetId: 'cleric', save: 'concentration on Bless', conditional: c.conditionalAdvantage })]);
        expect(r.message).toMatch(/conditional: Calm Focus \(calm\)/);
        expect(concRolls('cleric').map(x => x.purpose)).toEqual(['concentration']);
    });

    it('after an attack: the hint rides concentrationSaves and the rule lines', async () => {
        cleric();
        effect('cleric', 'Calm Focus', [{ type: 'advantage_on', value: 'save:con', condition: 'calm' }]);
        await fight([BRUTE, CLERIC()]);
        const { r, text } = await hit();
        expect(r.concentrationSaves[0].conditionalAdvantage).toEqual([expect.stringMatching(/^Calm Focus \(calm\): /)]);
        expect(text).toMatch(/conditional: Calm Focus \(calm\)/);
    });
});

describe('no source, no change', () => {
    it('the attack reply carries no concentration fields; the purpose is plain', async () => {
        cleric();
        await fight([BRUTE, CLERIC()]);
        const { r, d, text } = await hit();
        expect(r.concentrationSaves).toBeUndefined();
        expect(d.saveSources).toBeUndefined();
        expect(text).not.toMatch(/Concentration on/);
        expect(concRolls('cleric').map(x => x.purpose)).toEqual(['concentration']);
    });

    it('the area result keeps exactly its old keys', async () => {
        cleric();
        await fight([BRUTE, CLERIC()]);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['cleric'], dice: 6, source: 'rockfall' });
        expect(Object.keys(r.targets[0].concentration).sort()).toEqual(['broken', 'reason', 'saveDC', 'saveRoll', 'saveTotal', 'spell']);
        expect(r.saveSources).toBeUndefined();
        expect(r.message).not.toMatch(/\[d20/);
    });
});

describe('seeded replay', () => {
    it('both concentration dice come off the fight\'s seeded stream: the same seed replays them', async () => {
        const run = async () => {
            closeDb(); getDb(':memory:'); clearCombatState();
            cleric();
            effect('cleric', 'Steady Mind', STEADY_MIND);
            await fight([BRUTE, CLERIC()], 'h-replay');
            const { r } = await manage({ action: 'apply_damage', targetIds: ['cleric'], dice: 6, source: 'rockfall' });
            return { rolls: r.targets[0].concentration.saveRolls as number[], logged: concRolls('cleric').flatMap(x => x.dice.map(d => d.value)) };
        };
        const a = await run();
        const b = await run();
        expect(a.rolls).toHaveLength(2);
        expect(b.rolls).toEqual(a.rolls);
        expect(a.logged).toEqual(a.rolls);
    });
});

describe('output_mode summary keeps the concentration labels', () => {
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
        client = new Client({ name: 'concentration-summary', version: '0.0.0' });
        await client.connect(c);
    });
    afterEach(async () => { await client.close(); });

    it('apply_damage and an attack keep the concentration row whole: the labels and both dice', async () => {
        cleric();
        effect('cleric', 'Steady Mind', STEADY_MIND);
        const two = [expect.any(Number), expect.any(Number)];
        const created = await call('combat_manage', { action: 'create', seed: 'h-summary', participants: [BRUTE, CLERIC()] });
        enc = created.encounterId;
        const ad = await call('combat_manage', { action: 'apply_damage', encounterId: enc, targetIds: ['cleric'], dice: 4, source: 'rockfall', output_mode: 'summary' });
        expect(ad.saveSources).toEqual([{ targetId: 'cleric', name: 'Cleric', ability: 'constitution', save: 'concentration on Bless', broken: expect.any(Boolean), rolls: two, advantage: [STEADY] }]);
        const at = await call('combat_action', { action: 'attack', encounterId: enc, actorId: 'brute', targetId: 'cleric', outcome: 'hit', damage: 4, output_mode: 'summary' });
        expect(at.saveSources).toEqual([{ targetId: 'cleric', name: 'Cleric', ability: 'constitution', save: 'concentration on Bless', broken: expect.any(Boolean), rolls: two, advantage: [STEADY] }]);
    });
});
