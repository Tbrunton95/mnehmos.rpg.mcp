/**
 * Play report 7 (lane H): the end-of-turn save of a durationType 'save_ends'
 * condition reads declared save sides and the 5e save rules.
 *
 * CombatEngine.processEndOfTurnConditions rolled rng.checkDegree on the
 * ability modifier alone: no declared sides, no conditions, no proficiency,
 * and no note. Now the handler layer gives the pure engine a provider (the
 * engine never reads the database) that returns the saver's declared sides
 * through lane G1's reading (untagged save:<ability> mechanics; a tagged
 * one's hint) and its save modifier as every other engine save composes it
 * (the sheet's ability and save proficiency on the world's curve, else the
 * token's scores). The engine applies restrained and exhaustion 3+ from the
 * token's own conditions, rolls two dice on advantage or disadvantage under
 * one labelled purpose, keeps the right one for the degree, and says what
 * happened in a turn note and an endOfTurnSaves row (output_mode summary keeps
 * it). The provider is passed again on every advance, so a fight rehydrated in
 * a new process reads it too.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine, type SaverSidesProvider } from '../../src/engine/combat/engine.js';
import { normalizeCondition } from '../../src/engine/combat/conditions.js';
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

const ctx = { sessionId: 'unscoped' };
const embed = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
let enc: string;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guardedManage(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    return { text, r: embed(text, 'COMBAT_MANAGE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : { rawText: text }) };
};
const rollsFor = (forId: string) => queryRolls(getDb(), { forId, limit: 200 }) as Array<{ purpose: string; dice: Array<{ value: number }> }>;
const saveRolls = (forId: string) => rollsFor(forId).filter(x => x.purpose.startsWith('save vs '));
const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };
const now = () => new Date().toISOString();

function sheet(id: string, name: string, over: Record<string, unknown> = {}) {
    new CharacterRepository(getDb()).create({
        id, name, characterType: 'pc', level: 5, hp: 60, maxHp: 60, ac: 13,
        stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 },
        conditions: [], createdAt: now(), updatedAt: now(), ...over
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
const DS = 'Danger Sense (save:dex)';

afterEach(() => { vi.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────
// The pure engine: an injected provider, the token's own conditions
// ─────────────────────────────────────────────────────────────────────────

describe('the engine rolls the end-of-turn save with the provider\'s sides and the token\'s conditions', () => {
    const engine = (conditions: unknown[], abilityScores = { strength: 10, dexterity: 12, constitution: 14, intelligence: 10, wisdom: 10, charisma: 10 }) => {
        const e = new CombatEngine('h-save-ends');
        e.startEncounter([
            { id: 'varek', name: 'Varek', initiativeBonus: 0, initiative: 20, hp: 60, maxHp: 60, conditions: [], abilityScores, position: { x: 0, y: 0 } },
            { id: 'orc', name: 'Orc', initiativeBonus: 0, initiative: 5, hp: 15, maxHp: 15, conditions: [], isEnemy: true, position: { x: 3, y: 3 } }
        ] as any);
        const v = e.getState()!.participants.find(p => p.id === 'varek')!;
        for (const c of conditions) v.conditions.push(normalizeCondition(c as never, 'varek')!);
        e.drainRollRecords();
        return e;
    };
    const varek = (e: CombatEngine) => e.getState()!.participants.find(p => p.id === 'varek')!;
    const dangerSense: SaverSidesProvider = (p, ability) => p.id === 'varek' && ability === 'dexterity' ? { advantage: [DS], disadvantage: [] } : undefined;
    const WEB = { name: 'webbed', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' };
    const NET = { name: 'restrained', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' };

    it('Danger Sense on a save_ends DEX save: two dice, the higher kept for the degree; the log, the note and the row name it', () => {
        const e = engine([WEB]);
        d20s(4, 17);
        e.nextTurnWithConditions({ saverSides: dangerSense });
        // DEX 12 (+1): 17 + 1 = 18 vs DC 13, saved.
        expect(e.endOfTurnSaves).toEqual([expect.objectContaining({
            participantId: 'varek', name: 'Varek', condition: 'webbed', ability: 'dexterity', dc: 13,
            rolls: [4, 17], natural: 17, modifier: 1, total: 18, saved: true, advantage: [DS]
        })]);
        expect(varek(e).conditions).toEqual([]);
        expect(e.turnStartNotes.join('\n')).toMatch(/Varek's end-of-turn DEX save vs webbed: d20 17 \+ 1 = 18 vs DC 13 \(DEX \+1\) ✓ saved: webbed ends \[d20 4, 17; adv: Danger Sense \(save:dex\)\]/);
    });

    it('both dice are one logged roll under the labelled purpose', () => {
        const e = engine([WEB]);
        e.nextTurnWithConditions({ saverSides: dangerSense });
        const recs = e.drainRollRecords().filter(r => r.forId === 'varek');
        expect(recs.map(r => r.purpose)).toEqual([`save vs webbed (adv: ${DS})`]);
        expect(recs[0].dice.map(d => d.value)).toEqual(e.endOfTurnSaves[0].rolls);
        expect(e.endOfTurnSaves[0].natural).toBe(Math.max(...e.endOfTurnSaves[0].rolls));
    });

    it('restrained (the very condition) gives disadvantage on its own DEX save, with no provider at all', () => {
        const e = engine([NET]);
        d20s(15, 6);
        e.nextTurnWithConditions();
        // 6 + 1 = 7 vs DC 13: still restrained.
        expect(e.endOfTurnSaves[0]).toMatchObject({ rolls: [15, 6], natural: 6, total: 7, saved: false, disadvantage: ['restrained'] });
        expect(varek(e).conditions.map(c => c.type)).toEqual(['restrained']);
        expect(e.turnStartNotes.join('\n')).toMatch(/✗ failed: still restrained \[d20 15, 6; dis: restrained\]/);
    });

    it('restrained and Danger Sense cancel: one die, both named, the note says so', () => {
        const e = engine([NET]);
        e.nextTurnWithConditions({ saverSides: dangerSense });
        const s = e.endOfTurnSaves[0];
        expect(s.rolls).toHaveLength(1);
        expect(s).toMatchObject({ advantage: [DS], disadvantage: ['restrained'] });
        expect(s.line).toMatch(/cancel: one die/);
        expect(e.drainRollRecords().filter(r => r.forId === 'varek').map(r => r.purpose)).toEqual([`save vs restrained (adv: ${DS}; dis: restrained)`]);
    });

    it('exhaustion 3 puts a save_ends CON save at disadvantage', () => {
        const e = engine([{ name: 'poisoned', durationType: 'save_ends', saveDC: 12, saveAbility: 'con' }, { name: 'exhaustion', level: 3 }]);
        d20s(18, 3);
        e.nextTurnWithConditions();
        expect(e.endOfTurnSaves[0]).toMatchObject({ condition: 'poisoned', ability: 'constitution', rolls: [18, 3], natural: 3, disadvantage: ['exhaustion 3'] });
    });

    it('the provider\'s hints for a tagged mechanic ride the row and the note; it rolls one die', () => {
        const e = engine([WEB]);
        const hint = "Evasive Footwork (in the open): a save the engine rolls asserts no tag, so it did not fire; write the mechanic without condition: 'in the open' if it holds on every DEX save";
        e.nextTurnWithConditions({ saverSides: () => ({ advantage: [], disadvantage: [], conditionalAdvantage: [hint] }) });
        expect(e.endOfTurnSaves[0].rolls).toHaveLength(1);
        expect(e.endOfTurnSaves[0].conditional).toEqual([hint]);
        expect(e.turnStartNotes.join('\n')).toContain(`conditional: ${hint}`);
    });

    it('the provider\'s modifier replaces the bare ability modifier (the save proficiency rides it)', () => {
        const e = engine([WEB]);
        d20s(9);
        e.nextTurnWithConditions({ saverSides: () => ({ advantage: [], disadvantage: [], modifier: { total: 4, parts: ['DEX +1', 'save proficiency +3'] } }) });
        expect(e.endOfTurnSaves[0]).toMatchObject({ rolls: [9], natural: 9, modifier: 4, total: 13, saved: true });
        expect(e.endOfTurnSaves[0].line).toMatch(/d20 9 \+ 4 = 13 vs DC 13 \(DEX \+1, save proficiency \+3\) ✓ saved/);
    });

    it('no source: one die, the plain purpose, the bare ability modifier as before', () => {
        const e = engine([WEB]);
        e.nextTurnWithConditions();
        expect(e.endOfTurnSaves[0].rolls).toHaveLength(1);
        expect(e.endOfTurnSaves[0].modifier).toBe(1);
        expect(e.endOfTurnSaves[0].advantage).toBeUndefined();
        expect(e.drainRollRecords().filter(r => r.forId === 'varek').map(r => r.purpose)).toEqual(['save vs webbed']);
    });

    it('a natural 1 still fails and a natural 20 still succeeds by one step, on the kept die (the old degree rule)', () => {
        const a = engine([WEB]);
        d20s(1, 1);
        a.nextTurnWithConditions({ saverSides: () => ({ advantage: [], disadvantage: [], modifier: { total: 12, parts: [] } }) });
        expect(a.endOfTurnSaves[0]).toMatchObject({ natural: 1, total: 13, saved: false });
        const b = engine([WEB]);
        d20s(20);
        b.nextTurnWithConditions({ saverSides: () => ({ advantage: [], disadvantage: [], modifier: { total: -9, parts: [] } }) });
        expect(b.endOfTurnSaves[0]).toMatchObject({ natural: 20, total: 11, saved: true });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Through combat_manage advance: the handler layer's provider
// ─────────────────────────────────────────────────────────────────────────

const VAREK = (conditions: unknown[]) => ({ id: 'varek', name: 'Varek', hp: 60, maxHp: 60, ac: 13, initiative: 20, position: { x: 0, y: 0 }, conditions });
const ORC = { id: 'orc', name: 'Orc', hp: 15, maxHp: 15, initiative: 5, isEnemy: true, position: { x: 4, y: 4 } };
const WEBBED = { name: 'webbed', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' };
async function fight(conditions: unknown[], seed = 'h-advance') {
    enc = (await manage({ action: 'create', seed, participants: [VAREK(conditions), ORC] })).r.encounterId;
    expect(enc).toBeTruthy();
}
const advance = () => manage({ action: 'advance', confirm: true });

describe('advance reads the saver\'s declared sides and sheet modifier through the handler layer', () => {
    beforeEach(() => {
        closeDb(); getDb(':memory:'); clearCombatState();
        sheet('varek', 'Varek');
    });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('Danger Sense on Varek\'s sheet: two dice on the end-of-turn DEX save; endOfTurnSaves, the note and the log name it', async () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        await fight([WEBBED]);
        const { r } = await advance();
        const row = r.endOfTurnSaves?.[0];
        expect(row).toMatchObject({ participantId: 'varek', condition: 'webbed', ability: 'dexterity', dc: 13, advantage: [DS] });
        expect(row.rolls).toHaveLength(2);
        expect(row.natural).toBe(Math.max(...row.rolls));
        expect(r.turnStartNotes.join('\n')).toMatch(/Varek's end-of-turn DEX save vs webbed: .*\[d20 \d+, \d+; adv: Danger Sense \(save:dex\)\]/);
        const logged = saveRolls('varek');
        expect(logged.map(x => x.purpose)).toEqual([`save vs webbed (adv: ${DS})`]);
        expect(logged[0].dice.map(d => d.value)).toEqual(row.rolls);
    });

    it('restrained save_ends with Danger Sense cancels to one die', async () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        await fight([{ name: 'restrained', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex' }]);
        const { r } = await advance();
        expect(r.endOfTurnSaves[0].rolls).toHaveLength(1);
        expect(r.endOfTurnSaves[0]).toMatchObject({ advantage: [DS], disadvantage: ['restrained'] });
        expect(saveRolls('varek').map(x => x.purpose)).toEqual([`save vs restrained (adv: ${DS}; dis: restrained)`]);
    });

    it('a tagged mechanic does not fire and is hinted on the row and the note', async () => {
        effect('varek', 'Evasive Footwork', [{ type: 'advantage_on', value: 'save:dex', condition: 'in the open' }]);
        await fight([WEBBED]);
        const { r } = await advance();
        expect(r.endOfTurnSaves[0].rolls).toHaveLength(1);
        expect(r.endOfTurnSaves[0].advantage).toBeUndefined();
        expect(r.endOfTurnSaves[0].conditional).toEqual([expect.stringMatching(/^Evasive Footwork \(in the open\): a save the engine rolls asserts no tag/)]);
        expect(r.turnStartNotes.join('\n')).toMatch(/conditional: Evasive Footwork \(in the open\)/);
        expect(saveRolls('varek').map(x => x.purpose)).toEqual(['save vs webbed']);
    });

    it('the save is a 5e saving throw: the sheet\'s ability and save proficiency on the world\'s curve', async () => {
        new CharacterRepository(getDb()).update('varek', { saveProficiencies: ['dexterity'] } as any);
        await fight([WEBBED]);
        const { r } = await advance();
        // DEX 12 (+1) + proficiency +3 at level 5.
        expect(r.endOfTurnSaves[0]).toMatchObject({ modifier: 4, parts: ['DEX +1', 'save proficiency +3'] });
        expect(r.endOfTurnSaves[0].total).toBe(r.endOfTurnSaves[0].natural + 4);
    });

    it('a sheetless token keeps the bare ability modifier of its own scores', async () => {
        enc = (await manage({ action: 'create', seed: 'h-token', participants: [
            { id: 'hound', name: 'Hound', hp: 11, maxHp: 11, initiative: 20, position: { x: 0, y: 0 }, stats: { dex: 14 }, conditions: [WEBBED] }, ORC
        ] })).r.encounterId;
        const { r } = await advance();
        expect(r.endOfTurnSaves[0]).toMatchObject({ participantId: 'hound', modifier: 2, parts: ['DEX +2'] });
    });

    it('two processes: the provider is set again after clearCombatState, and the seeded dice replay', async () => {
        const run = async (restart: boolean) => {
            closeDb(); getDb(':memory:'); clearCombatState();
            sheet('varek', 'Varek');
            effect('varek', 'Danger Sense', DANGER_SENSE);
            await fight([WEBBED], 'h-two-process');
            if (restart) {
                clearCombatState();
                expect(new EncounterRepository(getDb()).loadState(enc)).toBeTruthy();
            }
            const { r } = await advance();
            return { row: r.endOfTurnSaves?.[0], logged: saveRolls('varek').flatMap(x => x.dice.map(d => d.value)) };
        };
        const a = await run(false);
        const b = await run(true);
        expect(a.row.rolls).toHaveLength(2);
        expect(b.row).toMatchObject({ advantage: [DS] });
        expect(b.row.rolls).toEqual(a.row.rolls);
        expect(b.logged).toEqual(b.row.rolls);
    });
});

describe('output_mode summary keeps the end-of-turn save', () => {
    let client: Client;
    const call = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>)[0].text;
        const data = replyJson(text);
        expect(data, `no JSON in reply: ${text.slice(0, 300)}`).not.toBeNull();
        return data as Record<string, any>;
    };
    beforeEach(async () => {
        closeDb(); getDb(':memory:'); clearCombatState();
        sheet('varek', 'Varek');
        const server = buildServer(new PubSub(), new AuditLogger());
        const [c, s] = InMemoryTransport.createLinkedPair();
        await server.connect(s);
        client = new Client({ name: 'save-ends-summary', version: '0.0.0' });
        await client.connect(c);
    });
    afterEach(async () => { await client.close(); vi.restoreAllMocks(); closeDb(); });

    it('endOfTurnSaves is kept whole: the labels, both dice and the line', async () => {
        effect('varek', 'Danger Sense', DANGER_SENSE);
        effect('varek', 'Evasive Footwork', [{ type: 'advantage_on', value: 'save:dex', condition: 'in the open' }]);
        const created = await call('combat_manage', { action: 'create', seed: 'h-summary', participants: [VAREK([WEBBED]), ORC] });
        const adv = await call('combat_manage', { action: 'advance', encounterId: created.encounterId, confirm: true, output_mode: 'summary' });
        expect(adv.endOfTurnSaves).toEqual([expect.objectContaining({
            participantId: 'varek', condition: 'webbed', rolls: [expect.any(Number), expect.any(Number)], advantage: [DS],
            conditional: [expect.stringMatching(/^Evasive Footwork \(in the open\)/)],
            line: expect.stringMatching(/^Varek's end-of-turn DEX save vs webbed: /)
        })]);
    });
});
