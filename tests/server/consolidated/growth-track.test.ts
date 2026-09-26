import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handlePartyManage, PartyManageTool } from '../../../src/server/consolidated/party-manage.js';
import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../../src/server/consolidated/combat-action.js';
import { handleSessionManage } from '../../../src/server/consolidated/session-manage.js';
import { clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { parseRuleSpec, DATA_KINDS } from '../../../src/engine/table-rules.js';

/**
 * Growth tracks: kills (more for a bigger victim) and victories feed a pool;
 * crossing a step offers the next form as a call to make, never applying it.
 */
const W = 'bigga-world';
const ctx = { sessionId: 'bigga' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const party = async (a: Record<string, unknown>) => json(await handlePartyManage(PartyManageTool.inputSchema.parse(a), ctx as any));
const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx as any));
const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
const growth = (id: string) => sheet(id).resourcePools.growth.current;

beforeEach(async () => {
    closeDb(); clearCombatState();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Bigga', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    const repo = new CharacterRepository(db);
    const mk = (id: string, name: string, band: string, pools: Record<string, unknown> = { growth: { current: 8, max: 100 } }) => repo.create({
        id, name, characterType: 'pc', band, stats: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 12, level: 3,
        resourcePools: pools, createdAt: now, updatedAt: now
    } as any);
    mk('grimgor', 'Grimgor', 'Boy');
    mk('gitz', 'Gitz', 'Boy');
    mk('azhag', 'Azhag', 'Boy', { growth: { current: 9, max: 100 } });
    mk('wolf', 'Big Wolf', 'Brute', {});
    db.prepare('UPDATE characters SET world_id = ?').run(W);
    await rules({ action: 'define', kind: 'band', name: 'bands', spec: { order: ['Grot', 'Boy', 'Brute', 'Boss'] } });
    await rules({ action: 'define', kind: 'creature', name: 'Orruk Brute', spec: { hp: 52, ac: 16, band: 'Brute' } });
    await rules({ action: 'define', kind: 'growth_track', name: 'Getting Bigga', spec: {
        pool: 'growth', perKill: 1, perBandAbove: 1, perVictory: 2,
        steps: [{ at: 10, form: 'Orruk Brute', note: 'Big enough to wear the armour' }, { at: 30, form: 'Orruk Megaboss' }]
    } });
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('the growth_track kind', () => {
    it('parses, is data, and is listed as data at boot', async () => {
        const s = parseRuleSpec('growth_track', { pool: 'growth', steps: [{ at: 10, form: 'Brute' }] }) as any;
        expect(s.steps[0]).toMatchObject({ at: 10, form: 'Brute' });
        expect(() => parseRuleSpec('growth_track', { pool: 'growth', steps: [] })).toThrow();
        expect(DATA_KINDS.has('growth_track')).toBe(true);
        const boot = json(await handleSessionManage({ action: 'boot', worldId: W }, ctx as any));
        expect(boot.tableRules.data.growth_track).toBe(1);
        expect(boot.tableRules.enforced.some((r: any) => r.kind === 'growth_track')).toBe(false);
        expect(TableRulesTool.description).toMatch(/growth_track/);
    });
});

describe('crossing a step', () => {
    it('adjust_pool offers growthReady and never changes the form', async () => {
        const r = await char({ action: 'adjust_pool', characterId: 'grimgor', pool: 'growth', delta: 3 });
        expect(r.growthReady).toMatchObject({ track: 'Getting Bigga', pool: 'growth', at: 10, form: 'Orruk Brute', note: 'Big enough to wear the armour' });
        expect(r.growthReady.call).toMatch(/character_manage set_form \{characterId: 'grimgor', form: 'Orruk Brute'\}/);
        expect(sheet('grimgor').form).toBeUndefined();
        expect(sheet('grimgor').maxHp).toBe(20);
        // Already past the step: no second offer.
        expect((await char({ action: 'adjust_pool', characterId: 'grimgor', pool: 'growth', delta: 1 })).growthReady).toBeUndefined();
        // A pool no track reads never offers.
        expect((await char({ action: 'adjust_pool', characterId: 'grimgor', pool: 'teef', delta: 50 })).growthReady).toBeUndefined();
    });

    it('a character already in that form is not offered it again', async () => {
        await char({ action: 'set_form', characterId: 'gitz', form: 'Orruk Brute' });
        expect((await char({ action: 'adjust_pool', characterId: 'gitz', pool: 'growth', delta: 5 })).growthReady).toBeUndefined();
    });

    it('table writes offer it too', async () => {
        await rules({ action: 'define', kind: 'roll_table', name: 'Loot', spec: { entries: [{ weight: 1, text: 'A big fight', apply: { writes: [{ op: 'adjust_pool', pool: 'growth', delta: 5 }] } }] } });
        const r = await rules({ action: 'roll', name: 'Loot', characterId: 'grimgor' });
        expect(r.growthReady?.[0]).toMatchObject({ form: 'Orruk Brute' });
        expect(sheet('grimgor').form).toBeUndefined();
    });
});

describe('kill credit in combat', () => {
    async function fight(victim: Record<string, unknown>) {
        const enc = json(await handleCombatManage({ action: 'create', worldId: W, participants: [
            { id: 'grimgor', name: 'Grimgor', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            { name: 'Victim', hp: 5, maxHp: 5, ac: 1, isEnemy: true, initiative: 1, position: { x: 1, y: 0 }, ...victim }
        ] }, ctx as any)).encounterId;
        const text = (await handleCombatAction({ action: 'attack', encounterId: enc, actorId: 'grimgor', targetId: String(victim.id), outcome: 'hit', damage: 10 }, ctx as any)).content[0].text;
        const m = text.match(/<!-- COMBAT_ACTION_JSON\n([\s\S]*?)\nCOMBAT_ACTION_JSON -->/);
        return { text, r: m ? JSON.parse(m[1]).actionResult : null };
    }

    it('a kill adds perKill; a victim of the same band adds perBandAbove once', async () => {
        const a = await fight({ id: 'gob', name: 'Gob', band: 'Grot' });
        expect(a.r.growth).toMatchObject({ track: 'Getting Bigga', pool: 'growth', delta: 1, from: 8, to: 9 });
        expect(growth('grimgor')).toBe(9);
        expect(sheet('grimgor').resourcePools.growth.history.at(-1).reason).toBe('kill: Gob');

        const b = await fight({ id: 'rival', name: 'Rival Boy', band: 'Boy' });
        expect(b.r.growth).toMatchObject({ delta: 2, from: 9, to: 11 });
        expect(b.r.growth.growthReady).toMatchObject({ form: 'Orruk Brute' });
        expect(b.text).toMatch(/GROWTH/);
        expect(sheet('grimgor').form).toBeUndefined();
    });

    it('a bigger victim is worth more; a pool the killer lacks gives nothing', async () => {
        new CharacterRepository(getDb()).update('wolf', { hp: 5, maxHp: 5 } as any);
        const a = await fight({ id: 'wolf', name: 'Big Wolf', band: 'Brute' });
        expect(a.r.growth).toMatchObject({ delta: 3, to: 11 });
        // Without the pool, a kill is not credited.
        new CharacterRepository(getDb()).update('grimgor', { resourcePools: {} } as any);
        const b = await fight({ id: 'gob2', name: 'Gob', band: 'Grot' });
        expect(b.r.growth).toBeUndefined();
    });
});

describe('after_battle perVictory', () => {
    it('adds perVictory to every surviving member with the pool', async () => {
        const pid = (await party({ action: 'create', name: 'Da Boyz', initialMembers: [{ characterId: 'grimgor', role: 'leader' }] })).party.id;
        await party({ action: 'add_member', partyId: pid, characterId: 'azhag' });
        await party({ action: 'add_member', partyId: pid, characterId: 'wolf' });
        await party({ action: 'add_member', partyId: pid, characterId: 'gitz' });
        const r = await party({ action: 'after_battle', partyId: pid, victory: true, casualties: [{ characterId: 'gitz', dead: true }] });
        expect(growth('grimgor')).toBe(10);
        expect(growth('azhag')).toBe(11);
        expect(growth('gitz')).toBe(8);
        const byId = Object.fromEntries(r.growth.map((g: any) => [g.characterId, g]));
        expect(byId.grimgor).toMatchObject({ delta: 2, from: 8, to: 10, growthReady: { form: 'Orruk Brute' } });
        expect(byId.wolf).toBeUndefined();
        expect(sheet('grimgor').form).toBeUndefined();
        // A defeat gives nothing.
        const d = await party({ action: 'after_battle', partyId: pid, victory: false });
        expect(d.growth ?? []).toEqual([]);
        expect(growth('grimgor')).toBe(10);
    });
});
