import { handleWorldManage, WorldManageTool } from '../../../src/server/consolidated/world-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleKnowledgeManage } from '../../../src/server/consolidated/knowledge-manage.js';
import { handlePrecedentManage } from '../../../src/server/consolidated/precedent-manage.js';
import { handleNarrativeManage } from '../../../src/server/consolidated/narrative-manage.js';
import { handleSessionManage } from '../../../src/server/consolidated/session-manage.js';
import { handleLedgerManage } from '../../../src/server/consolidated/ledger-manage.js';
import { readWorldClock, recordsAfterClock } from '../../../src/engine/world-clock.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

// Items 15 and 14: a clock correction is not time passing, and records dated
// after the clock (a reset epoch, a lost save) are named at boot and in audit.
const W = 'zastava';
const ctx = { sessionId: 'clock-fix' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const world = async (a: Record<string, unknown>) => json(await handleWorldManage(WorldManageTool.inputSchema.parse(a), ctx as any));
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    const worlds = new WorldRepository(db);
    worlds.create({ id: W, name: 'Zastava', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 47, time: '06:00' } } as any);
    worlds.create({ id: 'other', name: 'Other', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 3, time: '12:00' } } as any);
    const chars = new CharacterRepository(db);
    chars.create({ id: 'marcus', name: 'Marcus', characterType: 'pc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 20, ac: 12, level: 1, regeneration: 1, createdAt: now, updatedAt: now } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ?').run(W);
});
afterEach(() => closeDb());

describe('world_manage update {correction:true}', () => {
    it('moves the clock without regeneration or an elapsed note, and says what moved', async () => {
        const r = await world({ action: 'update', worldId: W, correction: true, environment: { day: 52, time: '06:00' } });
        expect(r).toMatchObject({ success: true, actionType: 'update', correction: { from: 'Day 47, 06:00', to: 'Day 52, 06:00', deltaHours: 120 } });
        expect(r.elapsedHours).toBeUndefined();
        expect(r.elapsedNote).toBeUndefined();
        expect(r.regenerated).toBeUndefined();
        expect(r.hint).toBeUndefined();
        expect(new CharacterRepository(getDb()).findById('marcus')!.hp).toBe(10);
        expect(readWorldClock(getDb(), W)).toMatchObject({ day: 52, time: '06:00' });
    });

    it('a backwards correction is quiet too', async () => {
        const r = await world({ action: 'update', worldId: W, correction: true, environment: { day: 40 } });
        expect(r.correction).toMatchObject({ deltaHours: -168 });
        expect(r.elapsedNote).toBeUndefined();
    });

    it('a large or backward plain update carries a hint; a small one does not', async () => {
        const big = await world({ action: 'update', worldId: W, environment: { day: 50, time: '06:00' } });
        expect(big.elapsedHours).toBe(72);
        expect(big.hint).toMatch(/correction:\s*true/);
        const back = await world({ action: 'update', worldId: W, environment: { day: 49 } });
        expect(back.hint).toMatch(/correction:\s*true/);
        const small = await world({ action: 'update', worldId: W, environment: { day: 49, time: '08:00' } });
        expect(small.hint).toBeUndefined();
        expect(WorldManageTool.inputSchema.shape.correction).toBeDefined();
    });
});

describe('records dated after the world clock', () => {
    it('recordsAfterClock reads fired schedules, precedents, knowledge and narrative stamps, not debts', async () => {
        await char({ action: 'schedule_change', characterId: 'marcus', worldId: W, firesAtDay: 50, event: true, note: 'Sol calls' });
        await char({ action: 'process_scheduled', worldId: W, currentDay: 51 });
        await handlePrecedentManage({ action: 'record', worldId: W, kind: 'ruling', statement: 'Sleet halves sight', day: 55 }, ctx as any);
        await handlePrecedentManage({ action: 'record', worldId: W, kind: 'ruling', statement: 'Old ruling', day: 40 }, ctx as any);
        await handleKnowledgeManage({ action: 'record', worldId: W, key: 'cache', statement: 'The cache is under the mill', knowers: [{ id: 'marcus', how: 'witnessed', day: 60 }] }, ctx as any);
        const note = json(await handleNarrativeManage({ action: 'add', worldId: W, type: 'plot_thread', content: 'The mill' }, ctx as any));
        const noteId = note.noteId ?? note.id ?? note.note?.id;
        await handleNarrativeManage({ action: 'append', noteId, content: 'Tracks by the wheel', day: 58 }, ctx as any);
        await handleLedgerManage({ action: 'create', worldId: W, debtor: 'Marcus', creditor: 'Kenny', amount: 5, dueDay: 90 }, ctx as any);
        // Another world's records never count here.
        await handlePrecedentManage({ action: 'record', worldId: 'other', kind: 'ruling', statement: 'Elsewhere', day: 99 }, ctx as any);

        const recs = recordsAfterClock(getDb(), W);
        const sources = recs.map(r => r.source).sort();
        expect(sources).toEqual(['knowledge', 'narrative', 'precedent', 'scheduled']);
        expect(recs.find(r => r.source === 'narrative')!.day).toBe(58);
        expect(recs.some(r => /Elsewhere|Old ruling/.test(r.what))).toBe(false);
        // With the clock caught up, nothing is ahead of it.
        expect(recordsAfterClock(getDb(), W, 61)).toEqual([]);
    });

    it('boot, get_context and the audit name them; a clean world says nothing', async () => {
        const clean = json(await handleSessionManage({ action: 'boot', worldId: W }, ctx as any));
        expect(clean.clockWarning).toBeUndefined();

        await handlePrecedentManage({ action: 'record', worldId: W, kind: 'ruling', statement: 'Sleet halves sight', day: 55 }, ctx as any);
        const res = await handleSessionManage({ action: 'boot', worldId: W }, ctx as any);
        const p = json(res);
        expect(p.clockWarning).toMatch(/1 record.*after the world clock.*Day 55/);
        expect(res.content[0].text).toMatch(/after the world clock/);

        const c = json(await handleSessionManage({ action: 'get_context', worldId: W, includeWorld: true }, ctx as any));
        expect((c.world ?? c.context?.world).clockWarning).toMatch(/after the world clock/);

        const a = await world({ action: 'audit', worldId: W });
        const check = a.checks.find((x: any) => /after the world clock/.test(x.check));
        expect(check).toMatchObject({ status: 'contradictions' });
        expect(check.items[0]).toMatchObject({ source: 'precedent', day: 55 });

        // Correcting the clock forward clears it.
        await world({ action: 'update', worldId: W, correction: true, environment: { day: 56 } });
        expect(json(await handleSessionManage({ action: 'boot', worldId: W }, ctx as any)).clockWarning).toBeUndefined();
    });
});
