import { handleImprovisationManage, ImprovisationManageTool } from '../../src/server/consolidated/improvisation-manage.js';
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
