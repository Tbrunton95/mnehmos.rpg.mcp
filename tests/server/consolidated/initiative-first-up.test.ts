/**
 * Play report 7 #9: the order the fight runs in, said out loud.
 *
 * create rolled initiative but carried it only inside participants[] and the
 * banner's INITIATIVE ORDER block; output_mode 'summary' collapsed both, so
 * the chair started resolving turns without telling the table the order.
 * create (and spawn_quick_enemy, which shares the path) now replies
 * initiative: [{id, name, roll, modifier, natural?, given?, surprised?}] in
 * turn order (LAIR as {id: 'LAIR', roll: 20, lair: true}), firstUp {id, name,
 * roll} after any surprised skip, and a banner line naming them. Summary
 * keeps both whole; a fields projection is respected as asked.
 * add_participant reports the joiner's roll and its place in the order.
 */
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { shapeReply } from '../../../src/server/output-mode.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'initiative-first-up' };
const embedded = (res: any) => {
    const m = res.content[0].text.match(/<!-- COMBAT_MANAGE_JSON\n([\s\S]*?)\nCOMBAT_MANAGE_JSON -->/);
    return m ? JSON.parse(m[1]) : JSON.parse(res.content[0].text);
};
const call = (args: Record<string, unknown>) => handleCombatManage(args, ctx as any);
const manage = async (args: Record<string, unknown>) => embedded(await call(args));

const gor = { id: 'gor', name: 'Gor', hp: 40, maxHp: 40, initiativeBonus: 2, isEnemy: true };
const mira = { id: 'mira', name: 'Mira', hp: 20, maxHp: 20, initiative: 14 };
const hound = { id: 'hound-1', name: 'Hound 1', hp: 11, maxHp: 11, initiativeBonus: 1, isEnemy: true };

beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
afterEach(() => closeDb());

describe('initiative and firstUp at create (play report 7 #9)', () => {
    it('lists every slot in turn order with roll and modifier, marks the given one, and names who is first up', async () => {
        const created = await manage({ action: 'create', seed: 'order', participants: [gor, mira, hound] });
        expect(created.error).toBeFalsy();
        const rows = created.initiative as Array<Record<string, any>>;
        expect(rows.map(r => r.id)).toEqual(created.participants.map((p: any) => p.id));
        for (const r of rows) {
            const p = created.participants.find((x: any) => x.id === r.id);
            expect(r.roll).toBe(p.initiative);
        }
        const m = rows.find(r => r.id === 'mira')!;
        expect(m).toMatchObject({ name: 'Mira', roll: 14, modifier: 0, given: true });
        expect(m.natural).toBeUndefined();
        const g = rows.find(r => r.id === 'gor')!;
        expect(g.modifier).toBe(2);
        expect(g.natural).toBe(g.roll - 2);
        expect(g.natural).toBeGreaterThanOrEqual(1);
        expect(g.natural).toBeLessThanOrEqual(20);
        expect(g.given).toBeUndefined();
        expect(created.firstUp).toEqual({ id: rows[0].id, name: rows[0].name, roll: rows[0].roll });
        expect(created.firstUp.id).toBe(created.currentTurn.id);
        const line = `🎲 Initiative: ${rows.map(r => `${r.name} ${r.roll}${r.given ? ' (given)' : ''}`).join(' · ')} — FIRST UP: ${rows[0].name}. Tell the table the order before resolving the first turn.`;
        expect(created.rawText).toContain(line);
        expect((await call({ action: 'create', seed: 'order', participants: [gor, mira, hound] })).content[0].text).toContain('FIRST UP:');
    });

    it('a lair slot is a row at 20 and can be first up', async () => {
        const created = await manage({ action: 'create', seed: 'lair', participants: [
            { ...gor, initiative: 12, hasLairActions: true }, { ...mira, initiative: 9 }
        ] });
        expect(created.initiative[0]).toEqual({ id: 'LAIR', name: 'LAIR', roll: 20, lair: true });
        expect(created.firstUp).toEqual({ id: 'LAIR', name: 'LAIR', roll: 20 });
        expect(created.rawText).toMatch(/🎲 Initiative: LAIR 20 · Gor 12 \(given\) · Mira 9 \(given\) — FIRST UP: LAIR\./);
    });

    it('a surprised first actor is marked, and firstUp is the slot after it', async () => {
        const created = await manage({ action: 'create', seed: 'ambush', surprised: ['gor'], participants: [
            { ...gor, initiative: 18 }, { ...mira, initiative: 14 }, { ...hound, initiative: 3 }
        ] });
        expect(created.initiative[0]).toMatchObject({ id: 'gor', roll: 18, given: true, surprised: true });
        expect(created.firstUp).toEqual({ id: 'mira', name: 'Mira', roll: 14 });
        expect(created.rawText).toMatch(/Gor 18 \(given, surprised\) · Mira 14 \(given\) · Hound 1 3 \(given\) — FIRST UP: Mira\./);
    });

    it('summary keeps initiative and firstUp whole (25 rows at most); fields is respected as asked', async () => {
        const res = await call({ action: 'create', seed: 'summary', participants: [gor, mira, hound] });
        const summary = JSON.parse(shapeReply(res as any, { mode: 'summary' }).content![0].text);
        const full = embedded(res);
        expect(summary.initiative).toEqual(full.initiative);
        expect(summary.firstUp).toEqual(full.firstUp);
        const picked = JSON.parse(shapeReply(res as any, { fields: ['encounterId'] }).content![0].text);
        expect(picked.initiative).toBeUndefined();
        expect(picked.firstUp).toBeUndefined();
        const crowd = await call({ action: 'create', seed: 'crowd', participants: Array.from({ length: 30 }, (_, i) => ({ id: `m-${i}`, name: `Militia ${i}`, hp: 5, maxHp: 5, initiative: 30 - i })) });
        const small = JSON.parse(shapeReply(crowd as any, { mode: 'summary' }).content![0].text);
        expect(small.initiative).toHaveLength(26);
        expect(small.initiative[0]).toMatchObject({ id: 'm-0', roll: 30, given: true });
        expect(small.initiative[25]).toEqual({ _more: 5 });
    });

    it('spawn_quick_enemy (a new fight) carries them too', async () => {
        const spawned = await manage({ action: 'spawn_quick_enemy', creature: 'goblin', count: 2, seed: 'spawn' });
        expect(spawned.initiative).toHaveLength(2);
        expect(spawned.firstUp.id).toBe(spawned.initiative[0].id);
        expect(spawned.rawText).toMatch(/FIRST UP: Goblin/);
    });
});

describe('the joiner says where it falls (play report 7 #9)', () => {
    it("add_participant reports the joiner's roll, modifier and place in the order", async () => {
        const { encounterId } = await manage({ action: 'create', seed: 'join', participants: [{ ...gor, initiative: 18 }, { ...mira, initiative: 4 }] });
        const res = await manage({ action: 'add_participant', encounterId, id: 'hound-1', name: 'Hound 1', hp: 11, maxHp: 11, initiativeBonus: 1 });
        expect(res.initiative).toHaveLength(1);
        const row = res.initiative[0];
        expect(row).toMatchObject({ id: 'hound-1', name: 'Hound 1', modifier: 1 });
        expect(row.natural).toBe(row.roll - 1);
        const expected = row.roll > 18 || (row.roll === 18 && 'hound-1' < 'gor') ? 1 : row.roll > 4 ? 2 : 3;
        expect(row.position).toBe(expected);
        expect(row.of).toBe(3);
        expect(res.message).toMatch(new RegExp(`initiative ${row.roll} \\(d20 ${row.natural} \\+1\\), ${['1st', '2nd', '3rd'][expected - 1]} of 3`));
    });

    // Review: a joiner whose slot sits before the current actor first acts next
    // round (the order keeps the current turn anchored); "1st of 3" alone told
    // the table it would act now.
    it('says which round the joiner first acts in: next round when its slot has passed', async () => {
        const { encounterId } = await manage({ action: 'create', seed: 'join3', participants: [{ ...gor, initiative: 18 }, { ...mira, initiative: 4 }] });
        await manage({ action: 'advance', encounterId, confirm: true });
        // Mira (4) is up; a joiner at 10 sits between Gor and Mira: its slot has passed.
        const early = await manage({ action: 'add_participant', encounterId, id: 'early', name: 'Early', hp: 5, maxHp: 5, initiativeBonus: 0 });
        const row = early.initiative[0];
        const passed = row.position <= 2;
        expect(row.firstRound).toBe(passed ? 2 : 1);
        expect(early.message).toContain(passed ? 'first turn in round 2 (its slot has passed this round)' : 'acts this round');
        // A joiner after the current actor acts this round.
        const late = await manage({ action: 'add_participant', encounterId, id: 'late', name: 'Late', hp: 5, maxHp: 5, initiativeBonus: -20 });
        expect(late.initiative[0]).toMatchObject({ firstRound: 1 });
        expect(late.message).toContain('acts this round');
    });

    it('a creature count reports each one; spawn into a running fight does too', async () => {
        const { encounterId } = await manage({ action: 'create', seed: 'join2', participants: [{ ...gor, initiative: 18 }] });
        const rats = await manage({ action: 'add_participant', encounterId, creature: 'giant_rat', count: 2, id: 'rat' });
        expect(rats.initiative.map((r: any) => r.id)).toEqual(['rat-1', 'rat-2']);
        const spawned = await manage({ action: 'spawn_quick_enemy', creature: 'goblin', encounterId });
        expect(spawned.initiative[0]).toMatchObject({ id: spawned.enemies[0].id, of: 4 });
    });
});
