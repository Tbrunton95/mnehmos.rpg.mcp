import { handleImprovisationManage, ImprovisationManageTool } from '../../src/server/consolidated/improvisation-manage.js';
import { handlePartyManage, PartyManageTool } from '../../src/server/consolidated/party-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../src/server/consolidated/character-manage.js';
import { handleMathManage, MathManageTool } from '../../src/server/consolidated/math-manage.js';
import { applyScheduledOps, scheduledWriteOpSchema, SCHEDULED_OP_SHAPE } from '../../src/engine/scheduled-ops.js';
import { handleTableRules, TableRulesTool } from '../../src/server/consolidated/table-rules.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { readWorldClock } from '../../src/engine/world-clock.js';
import { closeDb, getDb } from '../../src/storage/index.js';

// Deep One audit request 7: forty-eight cells, one roll. A long task resolves
// on a single logged die with three fixed tiers; the tier's cost is applied
// through the scheduled-op grammar, the clock may move, and the session log
// takes one line so the cost is on record.
//
// Seeds below are seedrandom streams whose first d20 is known:
//   montage-22 → 20, montage-20 → 12, montage-5 → 3.
const W = 'drowned';
const ctx = { sessionId: 'montage' } as any;
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const montage = async (a: Record<string, unknown>) => json(await handleImprovisationManage(ImprovisationManageTool.inputSchema.parse({ action: 'montage', ...a }), ctx));
const pm = async (a: Record<string, unknown>) => json(await handlePartyManage(PartyManageTool.inputSchema.parse(a), ctx));
// The banner and the data together: a refusal's text is what the GM reads.
const montageRaw = async (a: Record<string, unknown>) => { const res = await handleImprovisationManage(ImprovisationManageTool.inputSchema.parse({ action: 'montage', ...a }), ctx); return { text: res.content[0].text as string, data: json(res) }; };
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx));
const wake = () => new CharacterRepository(getDb()).findById('wake') as any;
// Peel optional / default / effects wrappers off a zod field to reach its object.
const unwrap = (s: any): any => { while (s?._def?.innerType || s?._def?.schema) s = s._def.innerType ?? s._def.schema; return s; };

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Deep One', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 10, time: '08:00' } } as any);
    new CharacterRepository(db).create({
        id: 'wake', name: 'Wake', characterType: 'pc', level: 3,
        stats: { str: 14, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        hp: 20, maxHp: 20, ac: 12, resourcePools: { grit: { current: 5, max: 5 } }, createdAt: now, updatedAt: now
    } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(W, 'wake');
});
afterEach(() => closeDb());

const costs = {
    hardWon: [{ op: 'adjust_pool', pool: 'grit', delta: -2 }],
    costly: [{ op: 'adjust_hp', delta: -6 }, { op: 'add_condition', name: 'exhausted', duration: 24 }]
};

describe('improvisation_manage montage', () => {
    it('clean: total ≥ dc + cleanMargin, nothing applied, one roll logged under purpose montage', async () => {
        const r = await montage({ characterId: 'wake', task: 'clear the drowned deck', dc: 12, ability: 'str', costs, seed: 'montage-22', journal: false });
        expect(r).toMatchObject({ success: true, actionType: 'montage', tier: 'clean', roll: 20, abilityModifier: 2, total: 22, dc: 12, cleanAt: 17, applied: [] });
        expect(r.hook).toMatch(/planned/);
        const db = getDb();
        const rows = db.prepare("SELECT purpose, for_id, result, replay, source FROM roll_log WHERE purpose = 'montage'").all() as any[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ for_id: 'wake', result: 20, replay: 'montage-22', source: 'seeded' });
        const wake = new CharacterRepository(db).findById('wake') as any;
        expect(wake.hp).toBe(20);
        expect(wake.resourcePools.grit.current).toBe(5);
    });

    it('hard_won: ≥ dc but under the clean line applies only costs.hardWon', async () => {
        const r = await montage({ characterId: 'wake', task: 'a week at the forge', dc: 12, ability: 'str', costs, seed: 'montage-20', journal: false });
        expect(r).toMatchObject({ tier: 'hard_won', roll: 12, total: 14, applied: ['grit: 5 → 3 (of 5)'] });
        const wake = new CharacterRepository(getDb()).findById('wake') as any;
        expect(wake.resourcePools.grit.current).toBe(3);
        expect(wake.hp).toBe(20);
        expect((wake.conditions ?? []).length).toBe(0);
    });

    it('costly: under dc applies only costs.costly (hp and condition)', async () => {
        const r = await montage({ characterId: 'wake', task: 'a night of bribes', dc: 12, ability: 'str', costs, seed: 'montage-5', journal: false });
        expect(r).toMatchObject({ tier: 'costly', roll: 3, total: 5 });
        expect(r.applied).toEqual(['hp: 20 → 14', expect.stringMatching(/exhausted/)]);
        const wake = new CharacterRepository(getDb()).findById('wake') as any;
        expect(wake.hp).toBe(14);
        expect(wake.resourcePools.grit.current).toBe(5);
        expect(wake.conditions.map((c: any) => c.name)).toEqual(['exhausted']);
    });

    it('modifier and cleanMargin move the lines; dice notation is honoured', async () => {
        // 12 + 2 (str) + 3 = 17 ≥ 12 + 5 → clean under the default margin...
        const a = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', modifier: 3, seed: 'montage-20', journal: false });
        expect(a).toMatchObject({ tier: 'clean', total: 17, modifier: 3 });
        // ...and hard_won with a wider margin.
        const b = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', modifier: 3, cleanMargin: 8, seed: 'montage-20', journal: false });
        expect(b).toMatchObject({ tier: 'hard_won', total: 17, cleanAt: 20 });
        // No ability named: no ability modifier.
        const c = await montage({ characterId: 'wake', task: 'x', dc: 12, seed: 'montage-20', journal: false });
        expect(c).toMatchObject({ abilityModifier: 0, total: 12, tier: 'hard_won' });
        const d = await montage({ characterId: 'wake', task: 'x', dc: 5, dice: '2d6', seed: 'montage-20', journal: false });
        expect(d.rolls).toHaveLength(2);
        expect(d.roll).toBe(d.rolls[0] + d.rolls[1]);
    });

    it('hours with worldId advance the world clock and report it', async () => {
        const r = await montage({ characterId: 'wake', task: 'bail the hold', dc: 10, hours: 6, worldId: W, seed: 'montage-22', journal: false });
        expect(r.timePassed).toMatchObject({ hours: 6, clock: 'Day 10, 14:00' });
        expect(r.message).toMatch(/6h pass/);
        expect(readWorldClock(getDb(), W)).toMatchObject({ day: 10, time: '14:00' });
        // Without hours the clock does not move.
        await montage({ characterId: 'wake', task: 'x', dc: 10, worldId: W, seed: 'montage-22', journal: false });
        expect(readWorldClock(getDb(), W)).toMatchObject({ day: 10, time: '14:00' });
    });

    it('hours that cross a midnight charge party upkeep through advance, and timePassed reports it', async () => {
        const db = getDb();
        new CharacterRepository(db).update('wake', { resourcePools: { grit: { current: 5, max: 5 }, stores: { current: 30, max: 30 } } } as any);
        const pid = (await pm({ action: 'create', name: 'The Wake Crew', worldId: W, initialMembers: [{ characterId: 'wake', role: 'leader' }] })).party.id;
        expect((await pm({ action: 'set_upkeep', partyId: pid, linkPool: { characterId: 'wake', pool: 'stores' } })).startDay).toBe(10);
        const r = await montage({ characterId: 'wake', task: 'a day at the oars', dc: 10, hours: 24, worldId: W, seed: 'montage-22', journal: false });
        expect(r.timePassed).toMatchObject({ hours: 24, clock: 'Day 11, 08:00', upkeep: [expect.objectContaining({ partyId: pid, name: 'The Wake Crew', days: 1, storesFrom: 30, storesTo: 29, mouths: 1 })] });
        expect(r.timePassed.message).toMatch(/upkeep: The Wake Crew 30→29 \(1d × 1\)/);
        expect((new CharacterRepository(db).findById('wake') as any).resourcePools.stores.current).toBe(29);
        expect((new CharacterRepository(db).findById('wake') as any).resourcePools.grit.current).toBe(5);
    });

    it('journal writes one [montage] line to the latest active session_log, creating one when none exists', async () => {
        const first = await montage({ characterId: 'wake', task: 'a week at the forge', dc: 12, ability: 'str', costs, worldId: W, seed: 'montage-20' });
        expect(first.journalCreated).toBe(true);
        expect(first.journalNoteId).toBeTruthy();
        const db = getDb();
        const note = db.prepare('SELECT type, status, content FROM narrative_notes WHERE id = ?').get(first.journalNoteId) as any;
        expect(note.type).toBe('session_log');
        expect(note.status).toBe('active');
        expect(note.content).toMatch(/^Session log/);
        expect(note.content).toContain('[montage] a week at the forge — hard-won (roll 14 vs DC 12) — cost: grit: 5 → 3 (of 5)');
        expect(note.content).toContain('[Day 10, 08:00]');

        // A second montage appends to the same log rather than making another.
        const second = await montage({ characterId: 'wake', task: 'clear the deck', dc: 12, worldId: W, seed: 'montage-22' });
        expect(second.journalNoteId).toBe(first.journalNoteId);
        expect(second.journalCreated).toBeUndefined();
        expect(db.prepare("SELECT COUNT(*) AS n FROM narrative_notes WHERE type = 'session_log'").get()).toEqual({ n: 1 });
        const again = db.prepare('SELECT content FROM narrative_notes WHERE id = ?').get(first.journalNoteId) as any;
        expect(again.content).toContain('[montage] clear the deck — clean (roll 20 vs DC 12) — cost: none');

        // worldId resolves from the character when omitted (single-world save).
        const third = await montage({ characterId: 'wake', task: 'y', dc: 12, seed: 'montage-22' });
        expect(third.journalNoteId).toBe(first.journalNoteId);
    });

    it('refuses a missing character or world without rolling or writing', async () => {
        const r = await montage({ characterId: 'nobody', task: 'x', dc: 10, worldId: W });
        expect(r.error).toBe(true);
        expect(r.message).toMatch(/not found/);
        const w = await montage({ characterId: 'wake', task: 'x', dc: 10, worldId: 'nowhere' });
        expect(w.error).toBe(true);
        expect(w.message).toMatch(/World nowhere not found/);
        const db = getDb();
        // roll_log is created on the first logged roll: either it is absent or it holds no montage row.
        const hasLog = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roll_log'").get();
        if (hasLog) expect(db.prepare("SELECT COUNT(*) AS n FROM roll_log WHERE purpose = 'montage'").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM narrative_notes").get()).toEqual({ n: 0 });
    });

    it('is on the outer mirror and the tool description', () => {
        const shape = (ImprovisationManageTool.inputSchema as any).shape;
        for (const k of ['characterId', 'task', 'dc', 'dice', 'ability', 'modifier', 'cleanMargin', 'costs', 'hours', 'worldId', 'journal', 'seed']) expect(shape[k]).toBeDefined();
        expect(ImprovisationManageTool.description).toMatch(/forty-eight cells, one roll/);
        expect(ImprovisationManageTool.actionSchemas.montage).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Play report 6 #2: the GM wrote costs: {hardWon: ['Varek loses the trail for
// a day']} and saw "Validation failed for action montage" and nothing else.
// A plain string is a note: logged, journaled, shown, nothing on the sheet
// changes. A malformed cost is refused with the shape and an example, a
// misspelt tier is named instead of dropped, and the banner lists the issues.
// ═══════════════════════════════════════════════════════════════════════════
describe('montage costs as plain text (play report 6 #2)', () => {
    it('a string in hardWon is a note: applied carries it, the sheet is untouched, the journal and the message read it without a prefix', async () => {
        const r = await montage({ characterId: 'wake', task: 'hunt the Gor', dc: 12, ability: 'str', costs: { hardWon: ['Varek loses the trail for a day'] }, worldId: W, seed: 'montage-20' });
        expect(r).toMatchObject({ success: true, tier: 'hard_won', total: 14, applied: ['note: Varek loses the trail for a day'] });
        expect(r.message).toContain('(cost: Varek loses the trail for a day)');
        expect(r.message).not.toContain('note:');
        expect(r.journalLine).toBe('[montage] hunt the Gor — hard-won (roll 14 vs DC 12) — cost: Varek loses the trail for a day');
        const note = getDb().prepare('SELECT content FROM narrative_notes WHERE id = ?').get(r.journalNoteId) as any;
        expect(note.content).toContain('— cost: Varek loses the trail for a day');
        const w = wake();
        expect(w.hp).toBe(20);
        expect(w.resourcePools.grit.current).toBe(5);
        expect(w.conditions ?? []).toEqual([]);
    });

    it('strings and ops mix in one tier and apply in order', async () => {
        const r = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { costly: [{ op: 'adjust_hp', delta: -4 }, 'a Gor is wounded'] }, seed: 'montage-5', journal: false });
        expect(r).toMatchObject({ tier: 'costly', applied: ['hp: 20 → 16', 'note: a Gor is wounded'] });
        expect(r.message).toContain('(cost: hp: 20 → 16; a Gor is wounded)');
        expect(wake().hp).toBe(16);
    });

    it('a bare string tier is one note; a JSON string tier or entry is parsed; a lone op object is a list of one', async () => {
        const a = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { hardWon: 'a day lost' }, seed: 'montage-20', journal: false });
        expect(a.applied).toEqual(['note: a day lost']);
        const b = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { hardWon: '[{"op":"adjust_pool","pool":"grit","delta":-1}]' }, seed: 'montage-20', journal: false });
        expect(b.applied).toEqual(['grit: 5 → 4 (of 5)']);
        expect(wake().resourcePools.grit.current).toBe(4);
        const c = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { hardWon: ['{"op":"adjust_pool","pool":"grit","delta":-1}', 'and a bruise'] }, seed: 'montage-20', journal: false });
        expect(c.applied).toEqual(['grit: 4 → 3 (of 5)', 'note: and a bruise']);
        const d = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { hardWon: { op: 'adjust_pool', pool: 'grit', delta: -1 } }, seed: 'montage-20', journal: false });
        expect(d.applied).toEqual(['grit: 3 → 2 (of 5)']);
        // The whole costs object as a JSON string is read too.
        const e = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: '{"hardWon": ["a day lost"]}', seed: 'montage-20', journal: false });
        expect(e.applied).toEqual(['note: a day lost']);
    });

    it('a string that reads like an op is still a note, with a warning that names the object form; nothing changes', async () => {
        const r = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { hardWon: ['adjust_hp -6'] }, seed: 'montage-20', journal: false });
        expect(r.applied[0]).toBe('note: adjust_hp -6');
        expect(r.applied[1]).toMatch(/^⚠ .*reads like an op.*\{op: 'adjust_hp', delta: -6\}/);
        expect(wake().hp).toBe(20);
        const p = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { hardWon: ['adjust_pool grit -2'] }, seed: 'montage-20', journal: false });
        expect(p.applied[1]).toMatch(/\{op: 'adjust_pool', pool: 'grit', delta: -2\}/);
        expect(wake().resourcePools.grit.current).toBe(5);
    });

    it('a number, an unknown op or a non-list tier is refused before the roll with the shape and an example; writes none; the banner lists the issue', async () => {
        for (const costs of [{ hardWon: [5] }, { hardWon: [{ op: 'lose_trail' }] }, { costly: 5 }, { costly: [{ delta: -4 }] }]) {
            const { text, data } = await montageRaw({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs, seed: 'montage-20', journal: false });
            expect(data.error).toBe('validation_error');
            expect(data.writes).toBe('none');
            expect(text).toContain("{op: 'note', text}");
            expect(text).toContain("costs: {hardWon: ['Varek loses the trail for a day'], costly: [{op: 'adjust_hp', delta: -4}, 'a Gor is wounded']}");
        }
        const bad = await montageRaw({ characterId: 'wake', task: 'x', dc: 12, costs: { hardWon: [{ op: 'lose_trail' }] }, seed: 'montage-20', journal: false });
        expect(bad.data.issues[0]).toMatchObject({ path: 'costs.hardWon.0.op' });
        expect(bad.data.issues[0].message).toMatch(/^unknown op 'lose_trail' — /);
        expect(bad.text).toMatch(/costs\.hardWon\.0\.op: unknown op 'lose_trail'/);
        const num = await montageRaw({ characterId: 'wake', task: 'x', dc: 12, costs: { hardWon: [5] } });
        expect(num.data.issues[0]).toMatchObject({ path: 'costs.hardWon.0' });
        expect(num.data.issues[0].message).toMatch(/^a write is an object, not a number — /);
        const tier = await montageRaw({ characterId: 'wake', task: 'x', dc: 12, costs: { costly: 5 } });
        expect(tier.data.issues[0]).toMatchObject({ path: 'costs.costly' });
        expect(tier.data.issues[0].message).toMatch(/^a tier is a list of costs, not a number — /);
        const noOp = await montageRaw({ characterId: 'wake', task: 'x', dc: 12, costs: { costly: [{ delta: -4 }] } });
        expect(noOp.data.issues[0]).toMatchObject({ path: 'costs.costly.0.op' });
        expect(noOp.data.issues[0].message).toMatch(/^op is required — /);
        // Nothing rolled, nothing written.
        const db = getDb();
        const hasLog = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roll_log'").get();
        if (hasLog) expect(db.prepare("SELECT COUNT(*) AS n FROM roll_log WHERE purpose = 'montage'").get()).toEqual({ n: 0 });
        expect(wake().hp).toBe(20);
        expect(db.prepare('SELECT COUNT(*) AS n FROM narrative_notes').get()).toEqual({ n: 0 });
    });

    it('a misspelt tier is named with its nearest tier, not dropped', async () => {
        const { text, data } = await montageRaw({ characterId: 'wake', task: 'x', dc: 12, costs: { hard_won: ['a day lost'] }, seed: 'montage-20', journal: false });
        expect(data.error).toBe('validation_error');
        expect(data.writes).toBe('none');
        expect(data.issues[0]).toMatchObject({ path: 'costs' });
        expect(data.issues[0].message).toMatch(/'hard_won' is not a tier — did you mean hardWon\?/);
        expect(data.issues[0].message).toMatch(/clean costs nothing/);
        expect(text).toMatch(/costs: 'hard_won' is not a tier — did you mean hardWon\?/);
        const clean = await montageRaw({ characterId: 'wake', task: 'x', dc: 12, costs: { clean: ['nothing'] } });
        expect(clean.data.issues[0].message).toMatch(/'clean' is not a tier/);
    });

    it('the describes and the tool text carry the shape and the plain-string rule', () => {
        const outerCosts = unwrap((ImprovisationManageTool.inputSchema as any).shape.costs);
        const innerCosts = unwrap((ImprovisationManageTool.actionSchemas.montage.schema as any).shape.costs);
        for (const costsObj of [outerCosts, innerCosts]) {
            expect(costsObj.shape.hardWon.description).toMatch(/plain string/);
            expect(costsObj.shape.hardWon.description).toMatch(/\{op: 'note', text\}/);
            expect(costsObj.shape.costly.description).toMatch(/hardWon/);
        }
        expect((ImprovisationManageTool.inputSchema as any).shape.costs.description).toMatch(/hardWon, costly/);
        expect(ImprovisationManageTool.actionSchemas.montage.description).toMatch(/plain-text note/);
        expect(ImprovisationManageTool.description).toMatch(/\{op: 'adjust_pool', pool, delta, max\?\}/);
        expect(ImprovisationManageTool.description).toMatch(/\{op: 'note', text\}/);
        expect(ImprovisationManageTool.description).toMatch(/costs: \{hardWon: \['Varek loses the trail for a day'\]/);
        // The shared grammar's describe on schedule_change names the note op too (the describe sits on the outer wrapper).
        expect((CharacterManageTool.inputSchema as any).shape.writes.description).toMatch(/\{op: 'note', text\}/);
        expect((CharacterManageTool.actionSchemas.schedule_change.schema as any).shape.writes.description).toMatch(/\{op: 'note', text\}/);
    });
});

describe('scheduled op grammar: note (play report 6 #2)', () => {
    it('a note touches nothing and is reported; a note without text and an unknown op are reported, not swallowed', () => {
        const r = applyScheduledOps({ hp: 5, maxHp: 5 } as any, [{ op: 'note', text: 'the arm has healed' }]);
        expect(r).toMatchObject({ applied: ['note: the arm has healed'], updates: {} });
        expect(applyScheduledOps({ hp: 5, maxHp: 5 } as any, [{ op: 'note' }]).applied).toEqual(['⚠ note op missing text — skipped']);
        const unknown = applyScheduledOps({ hp: 5, maxHp: 5 } as any, [{ op: 'set_wings' } as any]);
        expect(unknown.applied[0]).toMatch(/^⚠ unknown op 'set_wings' — skipped \(ops: adjust_pool, adjust_hp, adjust_max_hp, add_condition, remove_condition, note/);
        expect(unknown.updates).toEqual({});
    });

    it('the schema accepts the note op and refuses the rest with the shape', () => {
        expect(scheduledWriteOpSchema().parse({ op: 'note', text: 'x' })).toEqual({ op: 'note', text: 'x' });
        const str = scheduledWriteOpSchema().safeParse('the arm has healed');
        expect(str.success).toBe(false);
        expect(str.error!.issues[0].message).toBe(`a write is an object, not a string — ${SCHEDULED_OP_SHAPE}`);
        const unknown = scheduledWriteOpSchema().safeParse({ op: 'lose_trail' });
        expect(unknown.error!.issues[0].message).toBe(`unknown op 'lose_trail' — ${SCHEDULED_OP_SHAPE}`);
        const missing = scheduledWriteOpSchema().safeParse({ delta: 2 });
        expect(missing.error!.issues[0].message).toBe(`op is required — ${SCHEDULED_OP_SHAPE}`);
        expect(SCHEDULED_OP_SHAPE).toMatch(/\{op: 'note', text\}/);
        expect(SCHEDULED_OP_SHAPE).toContain("costs: {hardWon: ['Varek loses the trail for a day'], costly: [{op: 'adjust_hp', delta: -4}, 'a Gor is wounded']}");
    });
});

describe('schedule_change note op (play report 6 #2)', () => {
    it('a note-only clock is accepted, fires now and prints its text; the sheet is untouched', async () => {
        const r = await char({ action: 'schedule_change', characterId: 'wake', worldId: W, firesAtDay: 10, writes: [{ op: 'note', text: 'the arm has healed' }], fireNow: true });
        expect(r).toMatchObject({ success: true, kind: 'clock', ops: 1, firedNow: true, applied: ['note: the arm has healed'] });
        expect(r.message).toContain('note: the arm has healed');
        expect(wake().hp).toBe(20);
        expect(getDb().prepare('SELECT fired, writes FROM scheduled_state_changes WHERE id = ?').get(r.scheduleId)).toMatchObject({ fired: 1, writes: JSON.stringify([{ op: 'note', text: 'the arm has healed' }]) });
    });

    it('a scheduled note fires through process_scheduled, the result and the clock banner print it, and the row is spent', async () => {
        const s = await char({ action: 'schedule_change', characterId: 'wake', worldId: W, firesAtDay: 11, writes: [{ op: 'note', text: 'the arm has healed' }], note: 'Many-Skins mends' });
        expect(s).toMatchObject({ success: true, ops: 1 });
        const res = await handleCharacterManage(CharacterManageTool.inputSchema.parse({ action: 'process_scheduled', worldId: W, currentDay: 11 }), ctx);
        const p = json(res);
        expect(p.results).toHaveLength(1);
        expect(p.results[0]).toMatchObject({ scheduleId: s.scheduleId, kind: 'clock', applied: ['note: the arm has healed'] });
        expect(res.content[0].text).toContain('note: the arm has healed');
        expect(wake().hp).toBe(20);
        expect((await char({ action: 'process_scheduled', worldId: W, currentDay: 12 })).results).toEqual([]);
    });

    it('an empty writes list is still refused without event: true, and a plain string in writes is refused with the object form', async () => {
        const empty = await char({ action: 'schedule_change', characterId: 'wake', worldId: W, firesAtDay: 11, writes: [] });
        expect(empty.error).toBe(true);
        expect(empty.message).toMatch(/needs event: true/);
        // The outer mirror would refuse the string too; the router's own refusal is the one with the shape.
        const str = json(await handleCharacterManage({ action: 'schedule_change', characterId: 'wake', worldId: W, firesAtDay: 11, writes: ['the arm has healed'] }, ctx));
        expect(str.error).toBe('validation_error');
        expect(str.writes).toBe('none');
        expect(str.issues[0]).toMatchObject({ path: 'writes.0' });
        expect(str.issues[0].message).toMatch(/^a write is an object, not a string — .*\{op: 'note', text\}/);
        expect(getDb().prepare('SELECT COUNT(*) AS n FROM scheduled_state_changes').get()).toEqual({ n: 0 });
    });
});

// Review of play report 6 #2: the edges the first pass left to the SDK's
// raw Zod dump or to a silent note. null is no cost; a costs that is not an
// object, an op that is not a name and a note text that is not a string all
// say so with the shape; a braced string that is not JSON, a capitalised op
// name and a part op written as text all warn; 'note: x' is the note x.
describe('montage costs: review edges (play report 6 #2)', () => {
    it('costs: null and a null tier are no cost, not a refusal', async () => {
        const a = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: null, seed: 'montage-20', journal: false });
        expect(a).toMatchObject({ success: true, tier: 'hard_won', applied: [] });
        const b = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { hardWon: null, costly: ['y'] }, seed: 'montage-20', journal: false });
        expect(b).toMatchObject({ success: true, tier: 'hard_won', applied: [] });
        expect(wake().hp).toBe(20);
    });

    it('a costs that is not an object of tiers is refused with the tier shape, before the roll', async () => {
        for (const [costs, received] of [[5, 'a number'], [[], 'an array'], ['Varek loses the trail', 'a string'], [true, 'a boolean']] as const) {
            // The outer mirror refuses these too, with the same line (the SDK's refusal); the router's own banner is checked here.
            const outer = ImprovisationManageTool.inputSchema.safeParse({ action: 'montage', characterId: 'wake', task: 'x', dc: 12, costs });
            expect(outer.success).toBe(false);
            expect(outer.error!.issues[0].message).toMatch(new RegExp(`^costs is an object of tiers, not ${received} — costs: \\{hardWon: \\[`));
            const res = await handleImprovisationManage({ action: 'montage', characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs, seed: 'montage-20', journal: false }, ctx);
            const text = res.content[0].text as string;
            const data = json(res);
            expect(data).toMatchObject({ error: 'validation_error', writes: 'none' });
            expect(data.issues[0]).toMatchObject({ path: 'costs' });
            expect(data.issues[0].message).toMatch(new RegExp(`^costs is an object of tiers, not ${received} — costs: \\{hardWon: \\[`));
            expect(text).toContain("costs: {hardWon: ['Varek loses the trail for a day'], costly: [{op: 'adjust_hp', delta: -4}, 'a Gor is wounded']}");
        }
        const db = getDb();
        const hasLog = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roll_log'").get();
        if (hasLog) expect(db.prepare("SELECT COUNT(*) AS n FROM roll_log WHERE purpose = 'montage'").get()).toEqual({ n: 0 });
    });

    it('an op that is not a name and a note text that is not a string are refused with the shape', async () => {
        const op = await montageRaw({ characterId: 'wake', task: 'x', dc: 12, costs: { hardWon: [{ op: 5 }] } });
        expect(op.data).toMatchObject({ error: 'validation_error', writes: 'none' });
        expect(op.data.issues[0]).toMatchObject({ path: 'costs.hardWon.0.op' });
        expect(op.data.issues[0].message).toMatch(/^op is a name, not a number — each write is \{op: 'adjust_pool'/);
        const text = await montageRaw({ characterId: 'wake', task: 'x', dc: 12, costs: { hardWon: [{ op: 'note', text: 5 }] } });
        expect(text.data.issues[0]).toMatchObject({ path: 'costs.hardWon.0.text' });
        expect(text.data.issues[0].message).toMatch(/^note text is a string, not a number — \{op: 'note', text: 'the arm has healed'\}/);
        expect(scheduledWriteOpSchema().safeParse({ op: null }).error!.issues[0].message).toMatch(/^op is a name, not null — /);
        expect(scheduledWriteOpSchema().safeParse(null).error!.issues[0].message).toMatch(/^a write is an object, not null — /);
    });

    it('a braced string that is not JSON is a note with a warning naming the object form; nothing changes', async () => {
        const a = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { hardWon: ['{"op":"adjust_hp","delta":-4'] }, seed: 'montage-20', journal: false });
        expect(a.applied[0]).toBe('note: {"op":"adjust_hp","delta":-4');
        expect(a.applied[1]).toMatch(/^⚠ .*reads like an op written as text but is not JSON.*\{op: 'adjust_hp', delta: -4\}/);
        const b = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { hardWon: ["{op: 'adjust_pool', pool: 'grit', delta: -2}"] }, seed: 'montage-20', journal: false });
        expect(b.applied[1]).toMatch(/not JSON.*\{op: 'adjust_pool', pool: 'grit', delta: -2\}/);
        const c = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { hardWon: ['{the roof caves in}'] }, seed: 'montage-20', journal: false });
        expect(c.applied).toEqual(['note: {the roof caves in}']);
        expect(wake().hp).toBe(20);
        expect(wake().resourcePools.grit.current).toBe(5);
    });

    it('a capitalised op name and a part op written as text still warn, with the part form filled in', () => {
        const r = applyScheduledOps({ hp: 5, maxHp: 5 } as any, [
            { op: 'note', text: 'Adjust_hp -6' },
            { op: 'note', text: 'set_part left arm intact' },
            { op: 'note', text: 'set_part tail' },
            { op: 'note', text: 'remove_part tail' },
            { op: 'note', text: 'note the trail is lost' }
        ]);
        expect(r.updates).toEqual({});
        expect(r.applied[1]).toMatch(/\{op: 'adjust_hp', delta: -6\}$/);
        expect(r.applied[3]).toMatch(/\{op: 'set_part', part: 'left arm', state: 'intact'\}$/);
        expect(r.applied[5]).toMatch(/\{op: 'set_part', part: 'tail', state: 'intact' \| 'crippled' \| 'dead' \| 'breached'\}$/);
        expect(r.applied[7]).toMatch(/\{op: 'remove_part', part: 'tail'\}$/);
        // 'note …' is prose, not an op written as text.
        expect(r.applied.slice(8)).toEqual(['note: note the trail is lost']);
    });

    it("a plain string 'note: x' is the note x, once", async () => {
        const r = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', costs: { hardWon: ['note: the trail is lost'] }, seed: 'montage-20', journal: false });
        expect(r.applied).toEqual(['note: the trail is lost']);
        expect(r.message).toContain('(cost: the trail is lost)');
    });

    it('the tier describes name the part ops the shared grammar carries', () => {
        const outerCosts = unwrap((ImprovisationManageTool.inputSchema as any).shape.costs);
        const innerCosts = unwrap((ImprovisationManageTool.actionSchemas.montage.schema as any).shape.costs);
        for (const costsObj of [outerCosts, innerCosts]) {
            expect(costsObj.shape.hardWon.description).toMatch(/\{op: 'set_part', part, state/);
            expect(costsObj.shape.hardWon.description).toMatch(/\{op: 'remove_part', part\}/);
        }
    });

    it('schedule_change refuses a writes that is not a list with the list shape, and inserts nothing', async () => {
        for (const [writes, received] of [['the arm has healed', 'a string'], [5, 'a number'], [{ op: 'note', text: 'x' }, 'an object'], [null, 'null']] as const) {
            const r = json(await handleCharacterManage({ action: 'schedule_change', characterId: 'wake', worldId: W, firesAtDay: 11, writes }, ctx));
            expect(r).toMatchObject({ error: 'validation_error', writes: 'none' });
            expect(r.issues[0]).toMatchObject({ path: 'writes' });
            expect(r.issues[0].message).toMatch(new RegExp(`^writes is a list of ops, not ${received} — writes: \\[\\{op: 'note', text: 'the arm has healed'\\}\\]`));
        }
        expect(getDb().prepare('SELECT COUNT(*) AS n FROM scheduled_state_changes').get()).toEqual({ n: 0 });
    });
});

// Play report 6 #1: the montage dropped skill proficiency. `skill` rolled the
// bare ability modifier, so a proficient Survival hunt totalled three under
// roll_skill_check and graded hard-won instead of clean. The montage now rolls
// the same number stunts and roll_skill_check roll (src/engine/skill-modifier.ts):
// ability + proficiency (doubled by expertise) on the world's curve, or the
// sheet's stealth/perception override, and prints the working.
describe('montage rolls the skill modifier (play report 6 #1)', () => {
    const repo = () => new CharacterRepository(getDb());
    const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx));

    it('a proficient skill adds the proficiency bonus and prints the working', async () => {
        repo().update('wake', { skillProficiencies: ['Athletics'] } as any);
        const r = await montage({ characterId: 'wake', task: 'haul the anchor chain', dc: 12, skill: 'athletics', seed: 'montage-20', journal: false });
        expect(r).toMatchObject({ roll: 12, abilityModifier: 2, proficiency: 2, expertise: false, skillModifier: 4, skillSource: 'computed', total: 16, tier: 'hard_won' });
        expect(r.breakdown).toEqual(['1d20 12', 'str +2', 'proficiency +2']);
        expect(r.message).toContain('1d20 12 + str +2 + proficiency +2 = 16 vs DC 12');
    });

    it('expertise doubles the proficiency bonus and is named instead of it', async () => {
        repo().update('wake', { skillProficiencies: ['Athletics'], expertise: ['Athletics'] } as any);
        const r = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'athletics', seed: 'montage-20', journal: false });
        expect(r).toMatchObject({ abilityModifier: 2, proficiency: 4, expertise: true, skillModifier: 6, total: 18, tier: 'clean' });
        expect(r.breakdown).toEqual(['1d20 12', 'str +2', 'expertise +4']);
        expect(r.breakdown.join(' ')).not.toMatch(/proficiency/);
    });

    it('a stealth or perception override replaces the computed value; 0 is an authoritative zero', async () => {
        repo().update('wake', { skillProficiencies: ['Stealth', 'Perception'], stealthBonus: 7, perceptionBonus: 0 } as any);
        const s = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'stealth', seed: 'montage-20', journal: false });
        expect(s).toMatchObject({ skillModifier: 7, skillSource: 'override', total: 19, tier: 'clean' });
        expect(s.breakdown).toEqual(['1d20 12', 'stealth override +7 (replaces computed +2)']);
        expect(s.breakdown.join(' ')).not.toMatch(/proficiency/);
        const p = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'perception', seed: 'montage-20', journal: false });
        expect(p).toMatchObject({ skillModifier: 0, skillSource: 'override', total: 12, tier: 'hard_won' });
        expect(p.breakdown).toEqual(['1d20 12', 'perception override +0 (replaces computed +2)']);
    });

    it('ability overrides the governing stat but keeps proficiency; ability alone adds only its modifier; neither adds nothing', async () => {
        repo().update('wake', { skillProficiencies: ['Athletics'] } as any);
        const con = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'athletics', ability: 'con', seed: 'montage-20', journal: false });
        expect(con).toMatchObject({ abilityModifier: 0, proficiency: 2, skillModifier: 2, total: 14 });
        expect(con.breakdown).toEqual(['1d20 12', 'con +0', 'proficiency +2']);
        const str = await montage({ characterId: 'wake', task: 'x', dc: 12, ability: 'str', seed: 'montage-20', journal: false });
        expect(str).toMatchObject({ abilityModifier: 2, proficiency: 0, expertise: false, skillModifier: 2, total: 14 });
        expect(str.skillSource).toBeUndefined();
        expect(str.breakdown).toEqual(['1d20 12', 'str +2']);
        const none = await montage({ characterId: 'wake', task: 'x', dc: 12, seed: 'montage-20', journal: false });
        expect(none).toMatchObject({ abilityModifier: 0, skillModifier: 0, total: 12 });
        expect(none.breakdown).toEqual(['1d20 12']);
    });

    it("the proficiency bonus follows the world's progression curve (table_rules progression profBonus)", async () => {
        repo().update('wake', { skillProficiencies: ['Athletics'] } as any);
        await rules({ action: 'define', kind: 'progression', name: 'curve', spec: { mode: 'milestone', profBonus: [5] } });
        const r = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'athletics', seed: 'montage-20', journal: false });
        expect(r).toMatchObject({ abilityModifier: 2, proficiency: 5, skillModifier: 7, total: 19 });
        expect(r.breakdown).toContain('proficiency +5');
    });

    it('a world skill rolls its own ability and takes proficiency; a hyphenated SRD skill still maps', async () => {
        repo().update('wake', { skillProficiencies: ['Scrounging', 'Sleight of Hand'] } as any);
        await rules({ action: 'define', kind: 'skill', name: 'Scrounging', spec: { ability: 'wis' } });
        const w = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'scrounging', seed: 'montage-20', journal: false });
        expect(w).toMatchObject({ abilityModifier: 0, proficiency: 2, skillModifier: 2, total: 14 });
        expect(w.breakdown).toEqual(['1d20 12', 'wis +0', 'proficiency +2']);
        expect(w.warnings).toBeUndefined();
        const h = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'sleight-of-hand', seed: 'montage-20', journal: false });
        expect(h).toMatchObject({ abilityModifier: 0, proficiency: 2, skillModifier: 2, total: 14 });
        expect(h.breakdown).toEqual(['1d20 12', 'dex +0', 'proficiency +2']);
        expect(h.warnings).toBeUndefined();
    });

    it('a skill that maps to no ability rolls with no skill modifier and says so', async () => {
        repo().update('wake', { skillProficiencies: ['Haggling'] } as any);
        const r = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'haggling', seed: 'montage-20', journal: false });
        expect(r).toMatchObject({ abilityModifier: 0, proficiency: 0, skillModifier: 0, total: 12 });
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0]).toMatch(/skill 'haggling' names no ability/);
        expect(r.warnings[0]).toMatch(/rolled with no skill modifier/);
        // No proficiency line, even though the sheet lists the skill: there is no ability to add it to.
        expect(r.breakdown.join(' ')).not.toMatch(/proficiency \+/);
        expect(r.breakdown.join(' ')).not.toMatch(/\b(str|dex|con|int|wis|cha) [+-]/);
    });

    it('the journal line and the tier cost follow the proficient total', async () => {
        repo().update('wake', { skillProficiencies: ['Athletics'] } as any);
        // 12 + 2 (str) + 2 (proficiency) = 16, one under the clean line: hard-won, grit paid.
        const r = await montage({ characterId: 'wake', task: 'a week at the forge', dc: 12, skill: 'athletics', costs, worldId: W, seed: 'montage-20' });
        expect(r).toMatchObject({ tier: 'hard_won', total: 16, applied: ['grit: 5 → 3 (of 5)'] });
        const note = getDb().prepare('SELECT content FROM narrative_notes WHERE id = ?').get(r.journalNoteId) as any;
        expect(note.content).toContain('[montage] a week at the forge — hard-won (roll 16 vs DC 12) — cost: grit: 5 → 3 (of 5)');
    });

    it('the mirror and the tool text name the skill modifier', () => {
        const shape = (ImprovisationManageTool.inputSchema as any).shape;
        for (const k of ['skill', 'context']) expect(shape[k]).toBeDefined();
        expect(ImprovisationManageTool.description).toMatch(/total = roll \+ skill modifier \(ability \+ proficiency, doubled by expertise, or the sheet's stealth\/perception override\) \+ modifier/);
        expect(ImprovisationManageTool.description).toMatch(/ability alone adds just that ability's modifier/);
        const montageDoc = ImprovisationManageTool.actionSchemas.montage;
        expect(montageDoc.description).toMatch(/skill\?, context\?/);
        expect((montageDoc.schema as any).shape.skill.description).toMatch(/proficiency/);
        expect((montageDoc.schema as any).shape.ability.description).toMatch(/proficiency/);
        expect((montageDoc.schema as any).shape.worldId.description).toMatch(/proficiency/);
        expect(shape.ability.description).toMatch(/montage/);
        expect(shape.modifier.description).toMatch(/montage/);
    });
});

// Review of play report 6 #1: the GM's need, stated plainly — a montage on a
// skill must total what roll_skill_check totals on the same sheet. Parity is
// checked sheet by sheet (proficiency, expertise, a negative stat, both
// override columns incl. an authoritative 0 and an explicit null, an ability
// override, a higher level, a world curve, a world skill, a spaced skill name,
// an unmapped skill with ability passed), then the roll replays on its seed,
// and the tier and its cost follow the proficient total.
describe('montage totals what roll_skill_check totals (play report 6 #1 review)', () => {
    const repo = () => new CharacterRepository(getDb());
    const math = async (a: Record<string, unknown>) => json(await handleMathManage(MathManageTool.inputSchema.parse(a), ctx));
    const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx));
    const base = { level: 3, stats: { str: 14, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, skillProficiencies: [] as string[], expertise: [] as string[], stealthBonus: null, perceptionBonus: null };
    const agree = async (label: string, roll: Record<string, unknown>, bonus: number) => {
        const c = await math({ action: 'roll_skill_check', characterId: 'wake', dc: 12, seed: 'montage-20', ...roll });
        const m = await montage({ characterId: 'wake', task: label, dc: 12, seed: 'montage-20', journal: false, ...roll });
        expect(c.bonus, `${label}: roll_skill_check bonus`).toBe(bonus);
        expect(m.skillModifier, `${label}: montage skillModifier`).toBe(c.bonus);
        expect(m.total - m.roll, `${label}: montage total − roll`).toBe(c.bonus);
        expect(m.roll).toBe(12);
        return m;
    };

    it('agrees with roll_skill_check on every sheet shape', async () => {
        repo().update('wake', { ...base, skillProficiencies: ['Athletics'] } as any);
        await agree('proficient', { skill: 'athletics' }, 4);
        repo().update('wake', { ...base, expertise: ['Athletics'] } as any);
        await agree('expertise alone doubles', { skill: 'athletics' }, 6);
        repo().update('wake', { ...base } as any);
        await agree('not proficient', { skill: 'athletics' }, 2);
        repo().update('wake', { ...base, stats: { ...base.stats, dex: 8 }, skillProficiencies: ['Acrobatics'] } as any);
        await agree('negative stat + proficiency', { skill: 'acrobatics' }, 1);
        repo().update('wake', { ...base, skillProficiencies: ['Stealth', 'Perception'], stealthBonus: 7, perceptionBonus: 0 } as any);
        const s = await agree('stealth override', { skill: 'stealth' }, 7);
        expect(s.skillSource).toBe('override');
        const p = await agree('perception override 0', { skill: 'perception' }, 0);
        expect(p.skillSource).toBe('override');
        repo().update('wake', { ...base, skillProficiencies: ['Perception'], perceptionBonus: null } as any);
        const n = await agree('perception null → computed', { skill: 'perception' }, 2);
        expect(n.skillSource).toBe('computed');
        repo().update('wake', { ...base, skillProficiencies: ['Athletics'] } as any);
        await agree('ability override keeps proficiency', { skill: 'athletics', ability: 'con' }, 2);
        await agree('long ability name', { skill: 'athletics', ability: 'Constitution' }, 2);
        repo().update('wake', { ...base, level: 9, skillProficiencies: ['Athletics'] } as any);
        await agree('level 9 → +4', { skill: 'athletics' }, 6);
        repo().update('wake', { ...base, skillProficiencies: ['Sleight of Hand'] } as any);
        await agree('spaced skill name', { skill: 'Sleight Of Hand' }, 2);
        repo().update('wake', { ...base, skillProficiencies: ['Haggling'] } as any);
        const h = await agree('unmapped skill with ability passed', { skill: 'haggling', ability: 'cha' }, 2);
        expect(h.warnings).toBeUndefined();
        await rules({ action: 'define', kind: 'skill', name: 'Scrounging', spec: { ability: 'wis' } });
        repo().update('wake', { ...base, skillProficiencies: ['Scrounging'] } as any);
        await agree('world skill', { skill: 'scrounging' }, 2);
        await rules({ action: 'define', kind: 'progression', name: 'curve', spec: { mode: 'milestone', profBonus: [5] } });
        repo().update('wake', { ...base, skillProficiencies: ['Athletics'], expertise: ['Stealth'] } as any);
        await agree('world curve', { skill: 'athletics' }, 7);
        await agree('world curve, expertise', { skill: 'stealth' }, 10);
    });

    it('the seed replays the roll, the two dice of an advantaged roll and the proficient total', async () => {
        repo().update('wake', { ...base, skillProficiencies: ['Athletics'], skillAdvantage: [{ name: 'Sea Legs', skills: ['athletics'], when: 'deck' }] } as any);
        const a = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'athletics', seed: 'montage-20', journal: false });
        const b = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'athletics', seed: 'montage-20', journal: false });
        expect(b).toMatchObject({ roll: a.roll, rolls: a.rolls, total: a.total, breakdown: a.breakdown, tier: a.tier });
        expect(a.total).toBe(16);
        const c = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'athletics', context: ['deck'], seed: 'montage-20', journal: false });
        const d = await montage({ characterId: 'wake', task: 'x', dc: 12, skill: 'athletics', context: ['deck'], seed: 'montage-20', journal: false });
        expect(c.advantageSources).toEqual(['Sea Legs (deck)']);
        expect(c.advantageRoll.rolls).toHaveLength(2);
        expect(d.advantageRoll).toEqual(c.advantageRoll);
        expect(d.total).toBe(c.total);
        expect(c.total - c.roll).toBe(4);
        expect(c.breakdown).toContain('proficiency +2');
    });

    it('the tier and a plain-text cost follow the proficient total; expertise lifts the same roll clear of the cost', async () => {
        repo().update('wake', { ...base, skillProficiencies: ['Athletics'] } as any);
        // 12 + 2 + 2 = 16: hard-won, one under the clean line; the note is the cost on record.
        const r = await montage({ characterId: 'wake', task: 'haul the chain', dc: 12, skill: 'athletics', costs: { hardWon: ['a day lost to the tide'] }, worldId: W, seed: 'montage-20' });
        expect(r).toMatchObject({ tier: 'hard_won', total: 16, applied: ['note: a day lost to the tide'] });
        expect(r.journalLine).toBe('[montage] haul the chain — hard-won (roll 16 vs DC 12) — cost: a day lost to the tide');
        expect(wake().hp).toBe(20);
        // 12 + 2 + 4 = 18: clean; the hard-won cost is not applied and nothing is noted.
        repo().update('wake', { ...base, expertise: ['Athletics'] } as any);
        const e = await montage({ characterId: 'wake', task: 'haul the chain', dc: 12, skill: 'athletics', costs: { hardWon: ['a day lost to the tide'] }, worldId: W, seed: 'montage-20' });
        expect(e).toMatchObject({ tier: 'clean', total: 18, applied: [] });
        expect(e.journalLine).toBe('[montage] haul the chain — clean (roll 18 vs DC 12) — cost: none');
    });

    it('the skill describe names what is left out: auto-apply effect bonuses are not added, so the GM is not promised them', () => {
        const montageDoc = ImprovisationManageTool.actionSchemas.montage;
        expect((montageDoc.schema as any).shape.skill.description).toMatch(/skill_bonus effects[^.]*not added/);
        expect(ImprovisationManageTool.description).toMatch(/apply_effect skill_bonus mechanics and declaredEffects are not added/);
    });
});
