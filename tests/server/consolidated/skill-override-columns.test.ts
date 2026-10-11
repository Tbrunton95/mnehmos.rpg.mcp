import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleMathManage } from '../../../src/server/consolidated/math-manage.js';
import { handleImprovisationManage, ImprovisationManageTool } from '../../../src/server/consolidated/improvisation-manage.js';
import { handleNpcManage } from '../../../src/server/consolidated/npc-manage.js';
import { handleSpawnManage } from '../../../src/server/consolidated/spawn-manage.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { SpatialRepository } from '../../../src/storage/repos/spatial.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { randomUUID } from 'crypto';

/**
 * Play report 2 #5: the stealth/perception columns were born 0 on every
 * create, and 0 displaced the computed DEX/WIS + proficiency on every roll
 * (a level-5 rogue with DEX 16 rolled +0 stealth). The columns are now
 * tri-state: NULL = compute from the sheet; a number, 0 included, is an
 * authoritative override. Every reader rolls the same number.
 */
const ctx = { sessionId: 'skill-override' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const math = async (a: Record<string, unknown>) => json(await handleMathManage(a, ctx as any));
const improv = async (a: Record<string, unknown>) => json(await handleImprovisationManage(ImprovisationManageTool.inputSchema.parse(a), ctx as any));
const column = (id: string) => getDb().prepare('SELECT stealth_bonus AS s, perception_bonus AS p FROM characters WHERE id = ?').get(id) as { s: number | null; p: number | null };

const rogue = { action: 'create', name: 'Shade', class: 'Rogue', race: 'Human', level: 5, provisionEquipment: false,
    stats: { str: 10, dex: 16, con: 10, int: 10, wis: 12, cha: 10 }, skillProficiencies: ['Stealth'] };

describe('skill override columns (play report 2 #5)', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('create writes NULL; roll_skill_check composes DEX + proficiency with no column entry', async () => {
        const c = await char(rogue);
        expect(column(c.id)).toEqual({ s: null, p: null });
        const r = await math({ action: 'roll_skill_check', characterId: c.id, skill: 'stealth', seed: 'shade-1' });
        expect(r.bonus).toBe(6);
        expect(r.breakdown).toEqual(expect.arrayContaining(['DEX +3', 'proficiency +3']));
        expect(r.breakdown.some((b: string) => /column|override/i.test(b))).toBe(false);
        expect(r.contributions.some((k: any) => /column|override/i.test(k.label))).toBe(false);
        const s = await improv({ action: 'stunt', actorId: c.id, skill: 'stealth', dc: 10 });
        expect(s.modifier).toBe(6);
    });

    it('stealthOverride at create is the number rolled, labelled as an override', async () => {
        const c = await char({ ...rogue, stealthOverride: 9 });
        expect(column(c.id)).toEqual({ s: 9, p: null });
        const r = await math({ action: 'roll_skill_check', characterId: c.id, skill: 'stealth', seed: 'shade-2' });
        expect(r.bonus).toBe(9);
        expect(r.breakdown.some((b: string) => /stealth override \+9/.test(b) && /\+6/.test(b))).toBe(true);
        expect(r.contributions).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'stealth override', value: 9, lane: 'SHEET', source: 'stealth_bonus' })]));
        const s = await improv({ action: 'stunt', actorId: c.id, skill: 'stealth', dc: 10 });
        expect(s.modifier).toBe(9);
        // perception stays computed: WIS +1, no proficiency
        const p = await math({ action: 'roll_skill_check', characterId: c.id, skill: 'perception', seed: 'shade-3' });
        expect(p.bonus).toBe(1);
    });

    it('update stealthOverride: null clears the override; 0 is an authoritative zero', async () => {
        const c = await char({ ...rogue, stealthOverride: 9 });
        const cleared = await char({ action: 'update', characterId: c.id, stealthOverride: null });
        expect(cleared.success).toBe(true);
        expect(cleared.changed).toContain('stealthBonus');
        expect(column(c.id)).toEqual({ s: null, p: null });
        expect((await math({ action: 'roll_skill_check', characterId: c.id, skill: 'stealth', seed: 'x' })).bonus).toBe(6);
        await char({ action: 'update', characterId: c.id, stealthOverride: 0 });
        expect(column(c.id)).toEqual({ s: 0, p: null });
        expect((await math({ action: 'roll_skill_check', characterId: c.id, skill: 'stealth', seed: 'y' })).bonus).toBe(0);
        expect((await improv({ action: 'stunt', actorId: c.id, skill: 'stealth', dc: 10 })).modifier).toBe(0);
    });

    it('a stat change leaves a NULL column alone and keeps a non-null override offset through the world curve', async () => {
        const c = await char(rogue);
        const plain = await char({ action: 'update', characterId: c.id, stats: { str: 10, dex: 18, con: 10, int: 10, wis: 12, cha: 10 } });
        expect(plain.columnSync).toBeUndefined();
        expect(column(c.id)).toEqual({ s: null, p: null });
        expect((await math({ action: 'roll_skill_check', characterId: c.id, skill: 'stealth', seed: 'z' })).bonus).toBe(7);

        const o = await char({ ...rogue, name: 'Kroshka', stealthOverride: 10 });
        // composed +6 → override +10 is an offset of +4; DEX 16→18 composes +7, so the override follows to +11
        const synced = await char({ action: 'update', characterId: o.id, stats: { str: 10, dex: 18, con: 10, int: 10, wis: 12, cha: 10 } });
        expect(synced.columnSync).toMatchObject({ stealth_bonus: { from: 10, to: 11, offset: 4 } });
        expect(column(o.id).s).toBe(11);
        // the sheet's proficiency is read case-insensitively ('Stealth' on the sheet, 'stealth' as the skill)
        const prof = await char({ action: 'update', characterId: o.id, skillProficiencies: [] });
        expect(prof.columnSync).toMatchObject({ stealth_bonus: { from: 11, to: 8, offset: 4 } });
    });

    it('the eavesdrop layer rolls the same numbers, logging each d20', async () => {
        const db = getDb();
        const speaker = await char({ ...rogue, stealthOverride: 9 });
        const listener = await char({ action: 'create', name: 'Warden', class: 'Fighter', race: 'Human', level: 5, provisionEquipment: false,
            stats: { str: 10, dex: 10, con: 10, int: 10, wis: 14, cha: 10 }, skillProficiencies: ['Perception'] });
        const roomId = randomUUID();
        const now = new Date().toISOString();
        new SpatialRepository(db).create({
            id: roomId, name: 'Cellar', baseDescription: 'A damp stone cellar under the inn.', biomeContext: 'urban', atmospherics: [],
            exits: [], entityIds: [speaker.id, listener.id], createdAt: now, updatedAt: now, visitedCount: 0
        } as any);
        const repo = new CharacterRepository(db);
        repo.update(speaker.id, { currentRoomId: roomId } as any);
        repo.update(listener.id, { currentRoomId: roomId } as any);

        const r = json(await handleNpcManage({ action: 'interact', speakerId: speaker.id, content: 'The key is under the third flagstone.', volume: 'TALK' }, ctx as any));
        expect(r.success).toBe(true);
        const eaves = r.listeners.find((l: any) => l.listenerId === listener.id);
        expect(eaves.opposedRoll.speakerTotal - eaves.opposedRoll.speakerRoll).toBe(9);   // the override, not WIS/DEX + 9
        expect(eaves.opposedRoll.listenerTotal - eaves.opposedRoll.listenerRoll).toBe(5); // WIS +2, proficiency +3
        const rolls = db.prepare('SELECT purpose, for_id FROM roll_log WHERE purpose LIKE ? ORDER BY purpose').all('eavesdrop_%') as Array<{ purpose: string; for_id: string }>;
        expect(rolls).toEqual([
            { purpose: 'eavesdrop_perception', for_id: listener.id },
            { purpose: 'eavesdrop_stealth', for_id: speaker.id }
        ]);
    });

    it('spawned creatures take their stat-block skill totals; a preset 0 means not listed', async () => {
        const spawn = async (template: string) => json(await handleSpawnManage({ action: 'spawn_character', template, position: '0,0' }, ctx as any));
        const lurker = await spawn('lurker');
        expect(lurker.success).toBe(true);
        expect(column(lurker.characterId)).toEqual({ s: 6, p: 3 });
        const zombie = await spawn('zombified_stalker');
        expect(column(zombie.characterId)).toEqual({ s: null, p: null });
        // DEX 7 → computed -2, no proficiency
        expect((await math({ action: 'roll_skill_check', characterId: zombie.characterId, skill: 'stealth', seed: 'q' })).bonus).toBe(-2);
        const bloodsucker = await spawn('bloodsucker');
        expect(column(bloodsucker.characterId)).toEqual({ s: 7, p: 4 });
    });
});
