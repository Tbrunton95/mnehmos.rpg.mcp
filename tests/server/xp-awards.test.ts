/**
 * Request 3: the XP award ledger. Every XP write leaves a posted row; an
 * award narrated at the table but not applied sits unposted and shows as
 * "XP owed" on boot and the status block until post_awards applies it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleCharacterManage, CharacterManageTool } from '../../src/server/consolidated/character-manage.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleImprovisationManage } from '../../src/server/consolidated/improvisation-manage.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { buildBootPacket, renderBootPacket } from '../../src/server/boot-packet.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { listAwards, pendingTotal } from '../../src/storage/xp-awards.js';

const ctx = { sessionId: 'awards' } as any;
const W = 'deep';
const json = (r: any) => {
    const text = r.content[0].text as string;
    const m = text.match(/<!-- [A-Z_]*JSON\n([\s\S]*?)\n[A-Z_]*JSON -->/);
    return m ? JSON.parse(m[1]) : JSON.parse(text);
};
const banner = (r: any) => (r.content[0].text as string).split('<!--')[0];
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(a, ctx));

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'The Deep', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    const repo = new CharacterRepository(db);
    for (const [id, name] of [['namar', 'Namar'], ['tesk', 'Tesk']]) {
        repo.create({ id, name, stats: { str: 16, dex: 14, con: 14, int: 12, wis: 12, cha: 10 }, hp: 30, maxHp: 30, ac: 15, level: 1, xp: 0, characterType: 'pc', createdAt: now, updatedAt: now } as any);
    }
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ?').run(W);
});
afterEach(() => { closeDb(); clearCombatState(); });

describe('add_xp and the ledger', () => {
    it('refuses add_xp without a reason and writes nothing', async () => {
        const r = await char({ action: 'add_xp', characterId: 'namar', amount: 100 });
        expect(r.error).toBeTruthy();
        expect(r.message).toMatch(/reason/);
        expect(new CharacterRepository(getDb()).findById('namar')!.xp).toBe(0);
        expect(listAwards(getDb())).toHaveLength(0);
        const blank = await char({ action: 'add_xp', characterId: 'namar', amount: 100, reason: '   ' });
        expect(blank.error).toBeTruthy();
    });

    it('add_xp records a posted row with reason, source and world', async () => {
        const r = await char({ action: 'award_xp', characterId: 'namar', amount: 100, reason: 'the brine gate' });
        expect(r.newXp).toBe(100);
        expect(r.awardId).toMatch(/^xpa-/);
        const rows = listAwards(getDb(), { characterId: 'namar' });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ amount: 100, reason: 'the brine gate', source: 'character_manage add_xp', posted: true, worldId: W });
        expect(rows[0].postedAt).toBeTruthy();
        expect(CharacterManageTool.inputSchema.shape.reason.description).toMatch(/add_xp/);
    });

    it('award_note records an unposted award and returns the pending total', async () => {
        const a = await char({ action: 'award_note', characterId: 'namar', amount: 150, reason: 'talked the Deep One down' });
        expect(a.pending).toEqual({ total: 150, count: 1 });
        const b = await char({ action: 'award_note', characterId: 'namar', amount: 50, reason: 'the map' });
        expect(b.pending).toEqual({ total: 200, count: 2 });
        expect(b.message).toMatch(/XP owed: \+200 \(2 awards\)/);
        expect(new CharacterRepository(getDb()).findById('namar')!.xp).toBe(0);
        expect(listAwards(getDb(), { pendingOnly: true }).every(r => !r.posted && r.source === 'character_manage award_note')).toBe(true);
    });

    it('post_awards applies pending awards in one write per character and offers the level', async () => {
        await char({ action: 'award_note', characterId: 'namar', amount: 200, reason: 'the gate' });
        await char({ action: 'award_note', characterId: 'namar', amount: 100, reason: 'the map' });
        await char({ action: 'award_note', characterId: 'tesk', amount: 50, reason: 'the lantern' });
        const r = await char({ action: 'post_awards', worldId: W });
        expect(r.count).toBe(3);
        expect(r.total).toBe(350);
        const namar = r.posted.find((p: any) => p.characterId === 'namar');
        expect(namar).toMatchObject({ amount: 300, oldXp: 0, newXp: 300, canLevelUp: true });
        expect(r.levelUps).toEqual(['Namar']);
        expect(new CharacterRepository(getDb()).findById('tesk')!.xp).toBe(50);
        expect(pendingTotal(getDb(), { worldId: W })).toEqual({ total: 0, count: 0 });
        // Posting does not double-record: three rows, all posted, no fourth.
        expect(listAwards(getDb(), { worldId: W })).toHaveLength(3);
        expect(listAwards(getDb(), { worldId: W }).every(a => a.posted && a.postedAt)).toBe(true);
        // Nothing left: a second post is a no-op.
        expect((await char({ action: 'post_awards', characterId: 'namar' })).count).toBe(0);
        // Level-up itself is unchanged.
        const lv = await char({ action: 'level_up', characterId: 'namar' });
        expect(lv.newLevel).toBe(2);
    });

    it('post_awards by characterId leaves the other character owed', async () => {
        await char({ action: 'award_note', characterId: 'namar', amount: 20, reason: 'a' });
        await char({ action: 'award_note', characterId: 'tesk', amount: 30, reason: 'b' });
        const r = await char({ action: 'post_awards', characterId: 'namar' });
        expect(r.total).toBe(20);
        expect(pendingTotal(getDb(), { characterId: 'tesk' })).toEqual({ total: 30, count: 1 });
        const bad = await char({ action: 'post_awards' });
        expect(bad.error).toBeTruthy();
    });

    it('list_awards filters by character, world and pendingOnly, and caps with limit', async () => {
        await char({ action: 'add_xp', characterId: 'namar', amount: 10, reason: 'one' });
        await char({ action: 'add_xp', characterId: 'tesk', amount: 20, reason: 'two' });
        await char({ action: 'award_note', characterId: 'namar', amount: 30, reason: 'three' });
        const all = await char({ action: 'list_awards', worldId: W });
        expect(all.count).toBe(3);
        expect(all.pending).toEqual({ total: 30, count: 1 });
        const namar = await char({ action: 'list_awards', characterId: 'namar' });
        expect(namar.awards.map((a: any) => a.reason).sort()).toEqual(['one', 'three']);
        const pending = await char({ action: 'list_awards', worldId: W, pendingOnly: true });
        expect(pending.awards).toHaveLength(1);
        expect(pending.awards[0]).toMatchObject({ reason: 'three', posted: false });
        const capped = await char({ action: 'list_awards', worldId: W, limit: 1 });
        expect(capped.awards).toHaveLength(1);
        expect(banner(await handleCharacterManage({ action: 'list_awards', worldId: W }, ctx))).toMatch(/OWED namar: \+30 — three/);
    });
});

describe('the other XP writers record rows', () => {
    it('combat end with xpAward records a posted row per recipient', async () => {
        const enc = json(await handleCombatManage({ action: 'create', worldId: W, participants: [
            { id: 'namar', name: 'Namar', hp: 30, maxHp: 30, initiative: 20, ac: 15 },
            { id: 'tesk', name: 'Tesk', hp: 30, maxHp: 30, initiative: 15, ac: 15 },
            { id: 'crab', name: 'Crab', hp: 10, maxHp: 10, initiative: 10, ac: 10, isEnemy: true }
        ] }, ctx)).encounterId;
        const end = json(await handleCombatManage({ action: 'end', encounterId: enc, xpAward: 200 }, ctx));
        expect(end.xpAwarded).toHaveLength(2);
        const rows = listAwards(getDb(), { worldId: W });
        expect(rows).toHaveLength(2);
        for (const r of rows) expect(r).toMatchObject({ amount: 100, reason: `encounter ${enc}`, source: 'combat_manage end', posted: true });
        expect(new CharacterRepository(getDb()).findById('namar')!.xp).toBe(100);
    });

    it('stunt with xpAward records a posted row naming the stunt', async () => {
        const r = json(await handleImprovisationManage({ action: 'stunt', actorId: 'namar', skill: 'athletics', dc: 5, narrativeIntent: 'swing from the chain', xpAward: 25 }, ctx));
        expect(r.xpAwarded).toBe(25);
        const rows = listAwards(getDb(), { characterId: 'namar' });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ amount: 25, reason: 'stunt: swing from the chain', source: 'improvisation_manage stunt', posted: true, worldId: W });
    });
});

describe('XP owed on the glass', () => {
    it('the boot packet carries an XP owed line only while awards are pending', async () => {
        expect(buildBootPacket(W).xpOwed).toBeUndefined();
        expect(renderBootPacket(buildBootPacket(W))).not.toMatch(/XP owed/);
        await char({ action: 'award_note', characterId: 'namar', amount: 200, reason: 'the gate' });
        await char({ action: 'award_note', characterId: 'tesk', amount: 50, reason: 'the lantern' });
        const p = buildBootPacket(W);
        expect(p.xpOwed).toMatchObject({ total: 250, count: 2 });
        expect(renderBootPacket(p)).toMatch(/XP owed: \+250 \(2 awards\) — character_manage post_awards/);
        await char({ action: 'post_awards', worldId: W });
        expect(buildBootPacket(W).xpOwed).toBeUndefined();
    });

    it('the status block footer shows xp owed for that character only', async () => {
        await char({ action: 'award_note', characterId: 'namar', amount: 75, reason: 'the gate' });
        const full = await handleCharacterManage({ action: 'get_status_block', characterId: 'namar' }, ctx);
        expect(json(full).footer).toEqual(['xp owed +75']);
        expect(banner(full)).toMatch(/xp owed \+75/);
        expect(json(await handleCharacterManage({ action: 'get_status_block', characterId: 'tesk' }, ctx)).footer).toBeUndefined();

        // The compact block appends it after the house footer segments.
        await handleTableRules({ action: 'define', worldId: W, kind: 'status_block', name: 'tiny', spec: { compact: true, footer: ['Day 367'] } }, ctx);
        const tiny = json(await handleCharacterManage({ action: 'get_status_block', characterId: 'namar' }, ctx));
        expect(tiny.compact).toBe(true);
        expect(tiny.footer).toEqual(['Day 367', 'xp owed +75']);
        await char({ action: 'post_awards', characterId: 'namar' });
        expect(json(await handleCharacterManage({ action: 'get_status_block', characterId: 'namar' }, ctx)).footer).toEqual(['Day 367']);
    });
});
