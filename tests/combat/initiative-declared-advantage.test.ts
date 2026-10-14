/**
 * Play report 7 #7, second phase (lane F): declared advantage on initiative.
 *
 * An untagged `initiative` mechanic (or `check:dex`: initiative is a
 * Dexterity check in 5e) on a token's active effects rolls its initiative
 * twice at create and add_participant and keeps the higher; a disadvantage
 * mechanic keeps the lower; both cancel to one die. A tagged one fires when
 * the token's context asserts the tag (participants[].context on create,
 * context on add_participant). The initiative rows lane B added carry the
 * labels and both dice; the second die is on the fight's logged dice. A
 * given initiative ignores all of it.
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatRNG } from '../../src/engine/combat/rng.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { shapeReply } from '../../src/server/output-mode.js';

process.env.NODE_ENV = 'test';

// The operation guard writes a session's combat dice to roll_log; outside a tenant that session is 'unscoped'.
const ctx = { sessionId: 'unscoped' } as any;
const json = (res: any) => {
    const t = res.content[0].text as string;
    const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/);
    return m ? { ...JSON.parse(m[2]), rawText: t } : { ...JSON.parse(t), rawText: t };
};
const manage = async (a: Record<string, unknown>) => json(await withOperation('combat_manage', (x: any) => handleCombatManage(x, ctx))(a));
const initiativeRolls = (forId: string) => {
    try {
        return (getDb().prepare("SELECT purpose, dice, replay FROM roll_log WHERE for_id = ? AND purpose LIKE 'initiative%' ORDER BY rowid").all(forId) as Array<{ purpose: string; dice: string; replay: string }>)
            .map(r => ({ purpose: r.purpose, dice: (JSON.parse(r.dice) as Array<{ value: number }>).map(d => d.value), replay: r.replay }));
    } catch { return []; }
};

const now = () => new Date().toISOString();
function sheet(id: string, name: string) {
    new CharacterRepository(getDb()).create({
        id, name, characterType: 'pc', level: 3, hp: 30, maxHp: 30, ac: 13,
        stats: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 }, conditions: [], createdAt: now(), updatedAt: now()
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
const varek = (extra: Record<string, unknown> = {}) => ({ id: 'varek', name: 'Varek', hp: 30, maxHp: 30, initiativeBonus: 2, ...extra });
const gob = { id: 'gob', name: 'Goblin', hp: 7, maxHp: 7, initiative: 12, isEnemy: true };
const create = (participants: Array<Record<string, unknown>>, seed = 'initiative-adv') => manage({ action: 'create', seed, participants });
const rowOf = (res: any, id: string) => (res.initiative as Array<Record<string, any>>).find(r => r.id === id)!;

beforeEach(() => {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    sheet('varek', 'Varek');
});
afterEach(() => closeDb());

describe('create: declared initiative', () => {
    it('output_mode summary keeps the row whole: both dice and the source that fired', async () => {
        effect('varek', 'Alert Senses', [{ type: 'advantage_on', value: 'initiative' }]);
        const raw = await withOperation('combat_manage', (x: any) => handleCombatManage(x, ctx))({ action: 'create', seed: 'initiative-summary', participants: [varek(), gob] });
        const full = json(raw).initiative.find((r: any) => r.id === 'varek');
        expect(full.rolls).toHaveLength(2);
        const summary = JSON.parse(shapeReply(raw as any, { mode: 'summary' }).content![0].text);
        const row = summary.initiative.find((r: any) => r.id === 'varek');
        expect(row).toEqual(full);
        expect(row.advantage).toEqual(['Alert Senses (initiative)']);
    });

    it('an untagged initiative mechanic rolls twice and keeps the higher; the row, the log and the replay say so', async () => {
        effect('varek', 'Alert Senses', [{ type: 'advantage_on', value: 'initiative' }]);
        const res = await create([varek(), gob]);
        expect(res.error).toBeFalsy();
        const row = rowOf(res, 'varek');
        expect(row.advantage).toEqual(['Alert Senses (initiative)']);
        expect(row.rolls).toHaveLength(2);
        expect(row.natural).toBe(Math.max(...row.rolls));
        expect(row.roll).toBe(row.natural + 2);
        expect(row.disadvantage).toBeUndefined();
        expect(res.rawText).toMatch(/Varek \d+ \(advantage\)/);
        const logged = initiativeRolls('varek');
        expect(logged).toHaveLength(1);
        expect(logged[0].purpose).toBe('initiative (adv: Alert Senses (initiative))');
        expect(logged[0].dice).toEqual(row.rolls);
        // Seeded replay: the stream from the logged origin gives the same two dice.
        const [origin, draw] = String(logged[0].replay).split('@');
        const rng = new CombatRNG(origin);
        for (let i = 0; i < Number(draw); i++) rng.d20(0);
        expect([rng.d20(0), rng.d20(0)]).toEqual(row.rolls);
        // The goblin's given initiative is untouched.
        expect(rowOf(res, 'gob')).toMatchObject({ roll: 12, given: true });
    });

    it('the same seed gives the same order; the first die is the one the plain roll would have been', async () => {
        const plain = rowOf(await create([varek(), gob], 'same-seed'), 'varek');
        clearCombatState();
        effect('varek', 'Alert Senses', [{ type: 'advantage_on', value: 'initiative' }]);
        const a = rowOf(await create([varek(), gob], 'same-seed'), 'varek');
        clearCombatState();
        const b = rowOf(await create([varek(), gob], 'same-seed'), 'varek');
        expect(a).toEqual(b);
        expect(a.rolls[0]).toBe(plain.natural);
    });

    it('check:dex covers initiative; a disadvantage mechanic keeps the lower; both cancel to one die', async () => {
        effect('varek', 'Nimble', [{ type: 'advantage_on', value: 'check:dex' }]);
        const nimble = rowOf(await create([varek(), gob]), 'varek');
        expect(nimble.advantage).toEqual(['Nimble (check:dex)']);
        expect(nimble.rolls).toHaveLength(2);
        clearCombatState();
        getDb().prepare('DELETE FROM custom_effects').run();
        effect('varek', 'Sluggish', [{ type: 'disadvantage_on', value: 'initiative' }]);
        const slow = rowOf(await create([varek(), gob]), 'varek');
        expect(slow.disadvantage).toEqual(['Sluggish (initiative)']);
        expect(slow.natural).toBe(Math.min(...slow.rolls));
        clearCombatState();
        effect('varek', 'Alert Senses', [{ type: 'advantage_on', value: 'initiative' }]);
        const both = rowOf(await create([varek(), gob]), 'varek');
        expect(both.advantage).toEqual(['Alert Senses (initiative)']);
        expect(both.disadvantage).toEqual(['Sluggish (initiative)']);
        expect(both.rolls).toBeUndefined();
        expect(initiativeRolls('varek').pop()!.dice).toHaveLength(1);
    });

    it('a tagged mechanic fires on participants[].context, not without; a tag that fires nothing is warned', async () => {
        effect('varek', 'Ambusher', [{ type: 'advantage_on', value: 'initiative', condition: 'ambush' }]);
        const bare = await create([varek(), gob]);
        expect(rowOf(bare, 'varek').advantage).toBeUndefined();
        expect(rowOf(bare, 'varek').rolls).toBeUndefined();
        clearCombatState();
        const tagged = await create([varek({ context: ['Ambush'] }), gob]);
        expect(tagged.ignoredParams ?? []).not.toContain('participants[0].context');
        expect(rowOf(tagged, 'varek').advantage).toEqual(['Ambusher (ambush)']);
        expect(rowOf(tagged, 'varek').rolls).toHaveLength(2);
        clearCombatState();
        const stray = await create([varek({ context: 'dawn' }), gob]);
        expect(rowOf(stray, 'varek').advantage).toBeUndefined();
        expect(stray.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Varek: context \[dawn\] fired nothing on initiative/)]));
    });

    it('a given initiative ignores declared advantage: no dice, no labels', async () => {
        effect('varek', 'Alert Senses', [{ type: 'advantage_on', value: 'initiative' }]);
        const res = await create([varek({ initiative: 17 }), gob]);
        expect(rowOf(res, 'varek')).toEqual({ id: 'varek', name: 'Varek', roll: 17, modifier: 2, given: true });
        expect(initiativeRolls('varek')).toEqual([]);
    });

    it('the older advantage form does not touch initiative', async () => {
        effect('varek', 'Old Quickness', [{ type: 'advantage_on', value: 1, autoApply: true }]);
        const row = rowOf(await create([varek(), gob]), 'varek');
        expect(row.advantage).toBeUndefined();
        expect(row.rolls).toBeUndefined();
        expect(initiativeRolls('varek')[0].purpose).toBe('initiative');
    });
});

describe('add_participant: declared initiative', () => {
    it('a sheet-backed joiner rolls twice on an untagged mechanic; context asserts a tag', async () => {
        effect('varek', 'Alert Senses', [{ type: 'advantage_on', value: 'initiative' }]);
        effect('varek', 'Ambusher', [{ type: 'advantage_on', value: 'initiative', condition: 'ambush' }]);
        const enc = (await create([gob])).encounterId;
        const res = await manage({ action: 'add_participant', encounterId: enc, characterId: 'varek', context: ['ambush'] });
        expect(res.error).toBeFalsy();
        expect(res.ignoredParams ?? []).not.toContain('context');
        const row = res.initiative[0];
        expect(row.id).toBe('varek');
        expect(row.advantage).toEqual(['Alert Senses (initiative)', 'Ambusher (ambush)']);
        expect(row.rolls).toHaveLength(2);
        expect(row.natural).toBe(Math.max(...row.rolls));
        expect(res.message).toMatch(/advantage ← Alert Senses \(initiative\), Ambusher \(ambush\)/);
        expect(initiativeRolls('varek')[0]).toMatchObject({ purpose: 'initiative (adv: Alert Senses (initiative), Ambusher (ambush))', dice: row.rolls });
    });

    it('without the tag only the untagged mechanic fires; a tag that fires nothing is warned', async () => {
        effect('varek', 'Ambusher', [{ type: 'advantage_on', value: 'initiative', condition: 'ambush' }]);
        const enc = (await create([gob])).encounterId;
        const res = await manage({ action: 'add_participant', encounterId: enc, characterId: 'varek', context: 'dawn' });
        expect(res.initiative[0].advantage).toBeUndefined();
        expect(res.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Varek: context \[dawn\] fired nothing on initiative/)]));
    });
});
