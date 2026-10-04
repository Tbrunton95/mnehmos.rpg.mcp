import { handleWorldManage, WorldManageTool } from '../../src/server/consolidated/world-manage.js';
import { handlePrecedentManage } from '../../src/server/consolidated/precedent-manage.js';
import { buildBootPacket, renderBootPacket } from '../../src/server/boot-packet.js';
import { reconcileWorld, RECONCILE_KINDS } from '../../src/server/reconcile.js';
import { AttackProfileSchema } from '../../src/schema/token-extras.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

// Deep One audit request 4: fights run in chat leave sheets that disagree with
// themselves. reconcile names each drift with the call that fixes it; boot
// shows the count; nothing is written.
const W = 'm42';
const ctx = { sessionId: 'reconcile' };
const tag = (res: any, t: string) => JSON.parse(res.content[0].text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`))![1]);
const world = async (a: Record<string, unknown>) => tag(await handleWorldManage(WorldManageTool.inputSchema.parse(a), ctx as any), 'WORLD_MANAGE');
const prec = async (a: Record<string, unknown>) => tag(await handlePrecedentManage({ worldId: W, ...a }, ctx as any), 'PRECEDENT_MANAGE');
const reconcile = async (a: Record<string, unknown> = {}) => world({ action: 'reconcile', worldId: W, ...a });
const kinds = (r: any) => r.findings.map((f: any) => f.kind).sort();

let now: string;
const base = { characterType: 'pc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 20, ac: 12, level: 1 };

function addItem(id: string, name: string) {
    getDb().prepare("INSERT INTO items (id, name, type, weight, value, created_at, updated_at) VALUES (?, ?, 'weapon', 3, 10, ?, ?)").run(id, name, now, now);
}
function hold(characterId: string, itemId: string, quantity = 1, equipped = 0, slot: string | null = null) {
    getDb().prepare('INSERT INTO inventory_items (character_id, item_id, quantity, equipped, slot) VALUES (?, ?, ?, ?, ?)').run(characterId, itemId, quantity, equipped, slot);
}
function liveEncounter(id: string, characterIds: string[]) {
    const tokens = characterIds.map(cid => ({ id: cid, name: cid, hp: 10, maxHp: 10, position: { x: 0, y: 0 }, initiative: 10 }));
    getDb().prepare("INSERT INTO encounters (id, tokens, round, status, created_at, updated_at) VALUES (?, ?, 1, 'active', ?, ?)").run(id, JSON.stringify(tokens), now, now);
}

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    now = new Date().toISOString();
    const worlds = new WorldRepository(db);
    worlds.create({ id: W, name: 'Deep One', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now, environment: { day: 47, time: '06:00' } } as any);
    worlds.create({ id: 'other', name: 'Other', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    const chars = new CharacterRepository(db);
    chars.create({ ...base, id: 'wake', name: 'Wake', createdAt: now, updatedAt: now } as any);
    chars.create({ ...base, id: 'tesk', name: 'Tesk', createdAt: now, updatedAt: now } as any);
    chars.create({ ...base, id: 'elsewhere', name: 'Elsewhere', createdAt: now, updatedAt: now, abilities: [{ name: 'Far Roar', ready: false }] } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ? WHERE id IN (?, ?)').run(W, 'wake', 'tesk');
    db.prepare('UPDATE characters SET world_id = ? WHERE id = ?').run('other', 'elsewhere');
});
afterEach(() => closeDb());

describe('world_manage reconcile', () => {
    it('is clean on a consistent world, and refuses an unknown world', async () => {
        addItem('sword', 'Chainsword');
        hold('wake', 'sword', 1, 1, 'mainhand');
        const r = await reconcile();
        expect(r).toMatchObject({ success: true, actionType: 'reconcile', worldId: W, count: 0, findings: [], scope: 'world' });
        expect(r.kinds).toEqual([...RECONCILE_KINDS]);
        expect(r.message).toMatch(/clean/);
        expect((await reconcile({ worldId: 'nope' })).error).toBe(true);
    });

    it('equipped_missing: an equipped row with quantity 0 or no item row, cleared by unequip', async () => {
        addItem('sword', 'Chainsword');
        hold('wake', 'sword', 0, 1, 'mainhand');
        getDb().exec('PRAGMA foreign_keys = OFF');
        hold('tesk', 'ghost-item', 1, 1, 'offhand');
        let r = await reconcile();
        expect(kinds(r)).toEqual(['equipped_missing', 'equipped_missing']);
        const wake = r.findings.find((f: any) => f.characterId === 'wake');
        expect(wake).toMatchObject({ characterName: 'Wake', detail: expect.stringMatching(/Chainsword equipped in mainhand but quantity 0/) });
        expect(wake.fix).toBe('inventory_manage unequip {characterId: "wake", itemId: "sword"}');
        const tesk = r.findings.find((f: any) => f.characterId === 'tesk');
        expect(tesk.detail).toMatch(/ghost-item equipped in offhand but its item row no longer exists/);
        expect(tesk.fix).toMatch(/inventory_manage unequip .* then inventory_manage remove/);

        getDb().prepare('UPDATE inventory_items SET equipped = 0, slot = NULL WHERE character_id = ?').run('wake');
        getDb().prepare('DELETE FROM inventory_items WHERE character_id = ?').run('tesk');
        r = await reconcile();
        expect(r.count).toBe(0);
    });

    it('attack_duplicate: two profiles sharing a name (any case), cleared by a distinct rename', async () => {
        const db = getDb();
        const chars = new CharacterRepository(db);
        chars.update('wake', { attacks: [{ name: 'Greataxe', attackBonus: 5, damage: '1d12+3' }, { name: 'greataxe', attackBonus: 7, damage: '1d12+5' }, { name: 'Bite', attackBonus: 3, damage: 4 }] } as any);
        let r = await reconcile();
        expect(kinds(r)).toEqual(['attack_duplicate']);
        expect(r.findings[0]).toMatchObject({ characterId: 'wake', detail: expect.stringMatching(/2 attack profiles named 'greataxe'/), fix: expect.stringMatching(/character_manage update \{characterId: "wake", attacks: \[\.\.\.\]\}/) });

        chars.update('wake', { attacks: [{ name: 'Greataxe', attackBonus: 5, damage: '1d12+3' }, { name: 'Greataxe (two hands)', attackBonus: 7, damage: '1d12+5' }] } as any);
        r = await reconcile();
        expect(r.count).toBe(0);
    });

    it('attack_item_missing: the new item field must name something in the inventory (template name/id or instance custom name)', async () => {
        expect(AttackProfileSchema.parse({ name: 'Chainsword', attackBonus: 5, damage: '2d6', item: 'Chainsword' }).item).toBe('Chainsword');
        const db = getDb();
        const chars = new CharacterRepository(db);
        addItem('sword', 'Chainsword');
        hold('wake', 'sword', 1, 1, 'mainhand');
        db.prepare("INSERT INTO item_instances (id, template_id, owner_character_id, attachments, custom_name, created_at, updated_at) VALUES ('inst-1', 'sword', 'wake', '{}', 'Teeth of the Choir', ?, ?)").run(now, now);
        chars.update('wake', { attacks: [
            { name: 'sword', attackBonus: 5, damage: '2d6', item: 'chainsword' },
            { name: 'relic', attackBonus: 6, damage: '2d6', item: 'Teeth of the Choir' },
            { name: 'by id', attackBonus: 6, damage: '2d6', item: 'inst-1' },
            { name: 'pistol', attackBonus: 4, damage: '1d10', item: 'Bolt Pistol' },
            { name: 'fist', attackBonus: 2, damage: 1 }
        ] } as any);
        let r = await reconcile();
        expect(kinds(r)).toEqual(['attack_item_missing']);
        expect(r.findings[0]).toMatchObject({ characterId: 'wake', detail: "attack 'pistol' swings 'Bolt Pistol', which is not in the inventory" });
        expect(r.findings[0].fix).toMatch(/inventory_manage give \{characterId: "wake", itemId: <id of 'Bolt Pistol'>\}/);
        expect(r.findings[0].fix).toMatch(/character_manage update/);

        addItem('pistol', 'Bolt Pistol');
        hold('wake', 'pistol');
        r = await reconcile();
        expect(r.count).toBe(0);
        // A held item with quantity 0 is not held.
        db.prepare("UPDATE inventory_items SET quantity = 0 WHERE item_id = 'pistol'").run();
        expect(kinds(await reconcile())).toEqual(['attack_item_missing']);
    });

    it('condition_stale_precedent: a source or note citing a superseded or unknown prec-id, cleared by editConditions', async () => {
        const db = getDb();
        const chars = new CharacterRepository(db);
        const old = await prec({ action: 'record', kind: 'ruling', statement: 'Brine-bound: 1 fatigue per dry hour', scope: 'brine' });
        const oldId: string = old.precedent.precedentId;
        chars.update('wake', { conditions: [
            { name: 'Brine-bound', source: `ruling ${oldId}` },
            { name: 'Marked', source: 'the Choir' }
        ] } as any);
        // A note field is not in the schema but survives in the JSON column; scan it too.
        db.prepare('UPDATE characters SET conditions = ? WHERE id = ?').run(JSON.stringify([{ name: 'Hunted', source: 'Inquisition', note: 'see prec-deadbeef' }]), 'tesk');
        let r = await reconcile();
        // The live ruling passes; the unknown id fails.
        expect(kinds(r)).toEqual(['condition_stale_precedent']);
        expect(r.findings[0]).toMatchObject({ characterId: 'tesk', detail: "condition 'Hunted' cites prec-deadbeef, which is not in the precedent ledger" });
        expect(r.findings[0].fix).toMatch(/character_manage update \{characterId: "tesk", editConditions: \[\{match: "Hunted"/);

        const sup = await prec({ action: 'supersede', precedentId: oldId, statement: 'Brine-bound: 1 fatigue per dry hour, 2 in the Warp' });
        const newId: string = sup.precedent.precedentId;
        r = await reconcile({ characterId: 'wake' });
        expect(kinds(r)).toEqual(['condition_stale_precedent']);
        expect(r.findings[0]).toMatchObject({ characterId: 'wake', characterName: 'Wake', detail: `condition 'Brine-bound' cites ${oldId}, which is superseded by ${newId}` });
        expect(r.findings[0].fix).toBe(`character_manage update {characterId: "wake", editConditions: [{match: "Brine-bound", replaceSource: {find: "${oldId}", with: "${newId}"}}]} after reading precedent_manage get {precedentId: "${newId}"}`);

        chars.update('wake', { conditions: [{ name: 'Brine-bound', source: `ruling ${newId}` }, { name: 'Marked', source: 'the Choir' }] } as any);
        expect((await reconcile({ characterId: 'wake' })).count).toBe(0);
    });

    it('ability_spent_outside_combat: ready:false with no live encounter; a live encounter holding the character clears it', async () => {
        const db = getDb();
        const chars = new CharacterRepository(db);
        chars.update('wake', { abilities: [{ name: 'Tidal Surge', recharge: 5, ready: false }, { name: 'Brine Breath', ready: true }] } as any);
        let r = await reconcile();
        expect(kinds(r)).toEqual(['ability_spent_outside_combat']);
        expect(r.findings[0]).toMatchObject({ characterId: 'wake', detail: 'Tidal Surge ready:false with no live encounter', fix: expect.stringMatching(/character_manage update \{characterId: "wake", abilities: \[\.\.\.\]\} with ready: true/) });

        liveEncounter('enc-1', ['wake', 'someone']);
        expect((await reconcile()).count).toBe(0);
        // A fight that ended no longer excuses it.
        db.prepare("UPDATE encounters SET status = 'completed' WHERE id = 'enc-1'").run();
        expect(kinds(await reconcile())).toEqual(['ability_spent_outside_combat']);
        chars.update('wake', { abilities: [{ name: 'Tidal Surge', recharge: 5, ready: true }, { name: 'Brine Breath', ready: true }] } as any);
        expect((await reconcile()).count).toBe(0);
    });

    it('legendary_depleted_outside_combat: remaining below the maximum with no live encounter', async () => {
        const db = getDb();
        const chars = new CharacterRepository(db);
        chars.update('wake', { legendaryActions: 3, legendaryActionsRemaining: 1, legendaryResistances: 2, legendaryResistancesRemaining: 0 } as any);
        chars.update('tesk', { legendaryActions: 2, legendaryActionsRemaining: 2 } as any);
        let r = await reconcile();
        expect(kinds(r)).toEqual(['legendary_depleted_outside_combat']);
        expect(r.findings[0]).toMatchObject({ characterId: 'wake', detail: 'legendary actions 1/3, legendary resistances 0/2 with no live encounter', fix: 'character_manage update {characterId: "wake", legendaryActionsRemaining: 3, legendaryResistancesRemaining: 2}' });

        liveEncounter('enc-2', ['wake']);
        expect((await reconcile()).count).toBe(0);
        db.prepare("DELETE FROM encounters WHERE id = 'enc-2'").run();
        chars.update('wake', { legendaryActionsRemaining: 3, legendaryResistancesRemaining: 2 } as any);
        expect((await reconcile()).count).toBe(0);
    });

    it('xp_unposted: only when an xp_awards table exists; unposted rows are summed per character', async () => {
        const db = getDb();
        // No table (older campaign DB before the award ledger): no lane, no crash.
        db.exec('DROP TABLE IF EXISTS xp_awards');
        expect((await reconcile()).count).toBe(0);
        db.exec(`CREATE TABLE IF NOT EXISTS xp_awards (id TEXT PRIMARY KEY, world_id TEXT, character_id TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT, source TEXT, posted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, posted_at TEXT)`);
        const ins = db.prepare('INSERT INTO xp_awards (id, world_id, character_id, amount, reason, posted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        ins.run('a1', W, 'wake', 150, 'the Choir', 0, now);
        ins.run('a2', W, 'wake', 50, 'the pier', 0, now);
        ins.run('a3', W, 'tesk', 100, 'posted already', 1, now);
        let r = await reconcile();
        expect(kinds(r)).toEqual(['xp_unposted']);
        expect(r.findings[0]).toMatchObject({ characterId: 'wake', detail: '2 award(s) totalling 200 XP narrated but not posted', fix: 'character_manage post_awards {characterId: "wake"}' });
        db.prepare('UPDATE xp_awards SET posted = 1').run();
        expect((await reconcile()).count).toBe(0);
    });

    it('characterId narrows the read; other worlds never leak in; byKind counts', async () => {
        const db = getDb();
        const chars = new CharacterRepository(db);
        chars.update('wake', { abilities: [{ name: 'Tidal Surge', ready: false }] } as any);
        chars.update('tesk', { abilities: [{ name: 'Snap', ready: false }], attacks: [{ name: 'a', attackBonus: 1, damage: 1 }, { name: 'a', attackBonus: 1, damage: 1 }] } as any);
        // 'elsewhere' (other world) has a spent ability too — never ours.
        const all = await reconcile();
        expect(all.count).toBe(3);
        expect(all.byKind).toEqual({ ability_spent_outside_combat: 2, attack_duplicate: 1 });
        expect(all.findings.map((f: any) => f.characterId)).not.toContain('elsewhere');
        const one = await reconcile({ characterId: 'tesk' });
        expect(one).toMatchObject({ characterId: 'tesk', count: 2 });
        expect(one.findings.every((f: any) => f.characterId === 'tesk')).toBe(true);
        expect((await reconcile({ characterId: 'elsewhere' })).count).toBe(0);
        expect((await reconcile({ worldId: 'other' })).count).toBe(1);
        // The text output names each finding and its fix.
        const text = (await handleWorldManage({ action: 'reconcile', worldId: W }, ctx as any)).content[0].text;
        expect(text).toMatch(/SHEET RECONCILE/);
        expect(text).toMatch(/Tesk: \[attack_duplicate\]/);
        expect(text).toMatch(/fix: character_manage update/);
    });

    it('reads every character and says so when characters carry no world_id', () => {
        closeDb();
        const db = getDb(':memory:');
        new WorldRepository(db).create({ id: W, name: 'Deep One', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        new CharacterRepository(db).create({ ...base, id: 'wake', name: 'Wake', createdAt: now, updatedAt: now, abilities: [{ name: 'Tidal Surge', ready: false }] } as any);
        const r = reconcileWorld(db, W);
        expect(r.scope).toBe('all-characters');
        expect(r.count).toBe(1);
    });
});

describe('boot packet RECONCILE line', () => {
    it('appears with the count and the first 5 one-liners when findings exist, and disappears when clean', async () => {
        const db = getDb();
        const chars = new CharacterRepository(db);
        let packet = buildBootPacket(W);
        expect(packet.reconcile).toBeUndefined();
        expect(renderBootPacket(packet)).not.toMatch(/RECONCILE/);

        chars.update('wake', { abilities: [{ name: 'Tidal Surge', ready: false }], legendaryActions: 3, legendaryActionsRemaining: 0, attacks: [{ name: 'a', attackBonus: 1, damage: 1 }, { name: 'a', attackBonus: 1, damage: 1 }, { name: 'b', attackBonus: 1, damage: 1 }, { name: 'b', attackBonus: 1, damage: 1 }] } as any);
        chars.update('tesk', { abilities: [{ name: 'Snap', ready: false }], legendaryResistances: 1, legendaryResistancesRemaining: 0 } as any);
        packet = buildBootPacket(W);
        expect(packet.reconcile).toMatchObject({ count: 6 });
        expect(packet.reconcile!.first).toHaveLength(5);
        const text = renderBootPacket(packet);
        expect(text).toMatch(/⚠ RECONCILE: 6 findings — world_manage reconcile \{worldId\}/);
        expect(text).toMatch(/• Wake: \[attack_duplicate\] 2 attack profiles named 'a'/);
        expect(text).toMatch(/… 1 more/);

        chars.update('wake', { abilities: [{ name: 'Tidal Surge', ready: true }], legendaryActionsRemaining: 3, attacks: [{ name: 'a', attackBonus: 1, damage: 1 }, { name: 'b', attackBonus: 1, damage: 1 }] } as any);
        chars.update('tesk', { abilities: [{ name: 'Snap', ready: true }], legendaryResistancesRemaining: 1 } as any);
        packet = buildBootPacket(W);
        expect(packet.reconcile).toBeUndefined();
        expect(renderBootPacket(packet)).not.toMatch(/RECONCILE/);
    });

    it('a single finding reads "1 finding"', () => {
        const chars = new CharacterRepository(getDb());
        chars.update('wake', { abilities: [{ name: 'Tidal Surge', ready: false }] } as any);
        expect(renderBootPacket(buildBootPacket(W))).toMatch(/⚠ RECONCILE: 1 finding —/);
    });
});
