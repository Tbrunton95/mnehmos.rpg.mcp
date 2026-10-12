import Database from 'better-sqlite3';
import { migrate } from '../../src/storage/migrations.js';
import { runDataMigrations, SKILL_OVERRIDE_MIGRATION_ID } from '../../src/storage/data-migrations.js';
import { handleWorldManage, WorldManageTool } from '../../src/server/consolidated/world-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../src/server/consolidated/character-manage.js';
import { buildBootPacket, renderBootPacket } from '../../src/server/boot-packet.js';
import { RECONCILE_KINDS } from '../../src/server/reconcile.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 2 #5: every existing sheet carries stealth/perception columns
 * born 0 by the old default. The migration reads the journal (audit_logs
 * with success true, write_audit) to tell a deliberate override from that
 * default: an explicit override stays; a 0 nobody wrote becomes NULL
 * (computed); a non-zero value nobody wrote was a legacy ADDITIVE bonus and
 * becomes computed + value. Every move is listed for the GM as a reconcile
 * finding until acknowledged.
 */
type Row = { id: string; name: string; stats?: Record<string, number>; level?: number; skills?: string[]; stealth?: number | null; perception?: number | null };

function insertCharacter(db: Database.Database, r: Row) {
    const now = '2026-10-11T00:00:00.000Z';
    const cols = ['id', 'name', 'stats', 'hp', 'max_hp', 'ac', 'level', 'skill_proficiencies', 'created_at', 'updated_at'];
    const vals: unknown[] = [r.id, r.name, JSON.stringify(r.stats ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }), 10, 10, 10, r.level ?? 1, JSON.stringify(r.skills ?? []), now, now];
    // Omitting the column lets the old DEFAULT 0 apply, as every pre-fix row has it.
    if (r.stealth !== undefined) { cols.push('stealth_bonus'); vals.push(r.stealth); }
    if (r.perception !== undefined) { cols.push('perception_bonus'); vals.push(r.perception); }
    db.prepare(`INSERT INTO characters (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
}
const auditWriteAs = (db: Database.Database, action: string, args: Record<string, unknown>, success: boolean, result: unknown = '') =>
    db.prepare('INSERT INTO audit_logs (action, details, timestamp) VALUES (?, ?, ?)')
        .run(action, JSON.stringify({ args, result, success, duration: 1 }), '2026-10-01T00:00:00.000Z');
const auditWrite = (db: Database.Database, args: Record<string, unknown>, success: boolean, result = '') => auditWriteAs(db, 'character_manage', args, success, result);
const column = (db: Database.Database, id: string) => db.prepare('SELECT stealth_bonus AS s, perception_bonus AS p FROM characters WHERE id = ?').get(id) as { s: number | null; p: number | null };
const listed = (db: Database.Database) => db.prepare('SELECT character_id, skill, before, after, computed, kind, acknowledged FROM skill_override_migrations ORDER BY character_id, skill').all();

describe('skill override migration', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = new Database(':memory:');
        migrate(db);
        // Pretend this database predates the migration.
        db.prepare('DELETE FROM data_migrations WHERE id = ?').run(SKILL_OVERRIDE_MIGRATION_ID);
    });
    afterEach(() => db.close());

    it('nulls a 0 nobody wrote, folds a legacy additive bonus into an override, keeps explicit overrides, and runs once', () => {
        insertCharacter(db, { id: 'plain', name: 'Plain' });                                                        // 0/0, computed 0: nulled, not listed
        insertCharacter(db, { id: 'rogue', name: 'Rogue', stats: { str: 10, dex: 16, con: 10, int: 10, wis: 10, cha: 10 }, level: 5, skills: ['Stealth'] }); // 0, computed +6: nulled, listed
        insertCharacter(db, { id: 'bonus', name: 'Bonus', stats: { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 }, stealth: 3 });                   // +3 nobody wrote: +2 + 3 = +5
        insertCharacter(db, { id: 'explicit', name: 'Explicit', stealth: 5 });
        auditWrite(db, { action: 'update', characterId: 'explicit', stealthOverride: 5 }, true);
        insertCharacter(db, { id: 'refused', name: 'Refused', stealth: 4 });
        auditWrite(db, { action: 'update', characterId: 'refused', stealthOverride: 4 }, false);                      // a refused write is no evidence
        insertCharacter(db, { id: 'journal', name: 'Journal' });                                                      // 0 with a write_audit row: an explicit zero
        db.prepare("INSERT INTO write_audit (character_id, field, old_value, new_value, source, created_at) VALUES ('journal', 'stealthBonus', '3', '0', 'character_manage', '2026-10-01T00:00:00.000Z')").run();
        insertCharacter(db, { id: 'a1b2c3d4-0000-4000-8000-000000000000', name: 'Prefix', stealth: 7 });
        auditWrite(db, { action: 'update', characterId: 'a1b2c3d4', stealthOverride: 7 }, true);                      // #70 prefix id in the journal
        insertCharacter(db, { id: 'created', name: 'Created', perception: 9 });
        auditWrite(db, { action: 'create', name: 'Created', perceptionOverride: 9 }, true, 'Character Created: Created\nID: created\n');
        insertCharacter(db, { id: 'eyes', name: 'Eyes', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 14, cha: 10 }, skills: ['Perception'] });        // perception 0, computed +4
        // The audit wrapper sits at tool registration: an override set through a
        // batch_manage execute_sequence step is journaled under batch_manage, nested in steps[].
        insertCharacter(db, { id: 'batched', name: 'Batched', stealth: 6 });
        auditWriteAs(db, 'batch_manage', { action: 'execute_sequence', steps: [{ tool: 'character_manage', args: { action: 'update', characterId: 'batched', stealthOverride: 6 } }] }, true);
        insertCharacter(db, { id: '0badc0de-0000-4000-8000-00000000c0de', name: 'Batched Create', perception: 8 });
        auditWriteAs(db, 'batch_manage', { action: 'execute_sequence', steps: [{ tool: 'character_manage', args: { action: 'create', name: 'Batched Create', perceptionOverride: 8 } }] }, true,
            { content: [{ type: 'text', text: 'step 1: Character Created: Batched Create\nID: 0badc0de-0000-4000-8000-00000000c0de\n' }] });

        const applied = runDataMigrations(db);
        expect(applied.map(a => a.id)).toContain(SKILL_OVERRIDE_MIGRATION_ID);
        const detail = applied.find(a => a.id === SKILL_OVERRIDE_MIGRATION_ID)!.detail;
        expect(detail).toMatch(/default 0/);
        expect(detail).toMatch(/legacy bonus/);

        expect(column(db, 'plain')).toEqual({ s: null, p: null });
        expect(column(db, 'rogue')).toEqual({ s: null, p: null });
        expect(column(db, 'bonus')).toEqual({ s: 5, p: null });
        expect(column(db, 'explicit')).toEqual({ s: 5, p: null });
        expect(column(db, 'refused')).toEqual({ s: 4, p: null });     // computed 0 + 4
        expect(column(db, 'journal')).toEqual({ s: 0, p: null });
        expect(column(db, 'a1b2c3d4-0000-4000-8000-000000000000')).toEqual({ s: 7, p: null });
        expect(column(db, 'created')).toEqual({ s: null, p: 9 });
        expect(column(db, 'batched')).toEqual({ s: 6, p: null });                                                 // a batch step's update is an explicit write
        expect(column(db, '0badc0de-0000-4000-8000-00000000c0de')).toEqual({ s: null, p: 8 });               // a batch step's create too, by the id in the reply
        expect(column(db, 'eyes')).toEqual({ s: null, p: null });

        expect(listed(db)).toEqual([
            { character_id: 'bonus', skill: 'stealth', before: 3, after: 5, computed: 2, kind: 'bonus_to_override', acknowledged: 0 },
            { character_id: 'eyes', skill: 'perception', before: 0, after: null, computed: 4, kind: 'default_to_null', acknowledged: 0 },
            { character_id: 'refused', skill: 'stealth', before: 4, after: 4, computed: 0, kind: 'bonus_to_override', acknowledged: 0 },
            { character_id: 'rogue', skill: 'stealth', before: 0, after: null, computed: 6, kind: 'default_to_null', acknowledged: 0 }
        ]);
        expect(runDataMigrations(db)).toEqual([]);
    });

    it('a stealthOverride passed under the old additive name counts as explicit; a world proficiency curve feeds the computed value', () => {
        db.prepare("INSERT INTO worlds (id, name, seed, width, height, created_at, updated_at) VALUES ('w', 'W', 's', 1, 1, '2026-10-01', '2026-10-01')").run();
        db.prepare("INSERT INTO table_rules (id, world_id, kind, name, spec, enabled, created_at, updated_at) VALUES ('r', 'w', 'progression', 'steep', ?, 1, '2026-10-01', '2026-10-01')").run(JSON.stringify({ mode: 'xp', profBonus: [5, 5, 5] }));
        try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
        insertCharacter(db, { id: 'old-name', name: 'Old', stealth: 2 });
        auditWrite(db, { action: 'update', characterId: 'old-name', stealthBonus: 2 }, true);
        insertCharacter(db, { id: 'curve', name: 'Curve', skills: ['stealth'], level: 1 });
        db.prepare("UPDATE characters SET world_id = 'w' WHERE id = 'curve'").run();
        runDataMigrations(db);
        expect(column(db, 'old-name').s).toBe(2);
        expect(listed(db)).toEqual([{ character_id: 'curve', skill: 'stealth', before: 0, after: null, computed: 5, kind: 'default_to_null', acknowledged: 0 }]);
    });
});

describe('world_manage reconcile skill_override_migrated', () => {
    const W = 'w1';
    const ctx = { sessionId: 'reconcile' };
    const json = (res: any) => JSON.parse(res.content[0].text.match(/<!-- WORLD_MANAGE_JSON\n([\s\S]*?)\nWORLD_MANAGE_JSON -->/)![1]);
    const reconcile = async (a: Record<string, unknown> = {}) => json(await handleWorldManage(WorldManageTool.inputSchema.parse({ action: 'reconcile', worldId: W, ...a }), ctx as any));

    beforeEach(() => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'One', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        new WorldRepository(db).create({ id: 'w2', name: 'Two', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
        insertCharacter(db, { id: 'rogue', name: 'Rogue', stats: { str: 10, dex: 16, con: 10, int: 10, wis: 10, cha: 10 }, level: 5, skills: ['Stealth'] });
        insertCharacter(db, { id: 'bonus', name: 'Bonus', stats: { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 }, stealth: 3 });
        insertCharacter(db, { id: 'far', name: 'Far', stats: { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 }, stealth: 3 });
        db.prepare("UPDATE characters SET world_id = ? WHERE id IN ('rogue', 'bonus')").run(W);
        db.prepare("UPDATE characters SET world_id = 'w2' WHERE id = 'far'").run();
        db.prepare('DELETE FROM data_migrations WHERE id = ?').run(SKILL_OVERRIDE_MIGRATION_ID);
        runDataMigrations(db);
    });
    afterEach(() => closeDb());

    it('lists each moved column with the restore call, boot counts it, acknowledge clears it for this world only', async () => {
        expect(RECONCILE_KINDS).toContain('skill_override_migrated');
        let packet = buildBootPacket(W);
        expect(packet.reconcile).toMatchObject({ count: 2 });
        expect(renderBootPacket(packet)).toMatch(/RECONCILE: 2 findings/);

        let r = await reconcile();
        expect(r.count).toBe(2);
        expect(r.byKind).toEqual({ skill_override_migrated: 2 });
        const rogue = r.findings.find((f: any) => f.characterId === 'rogue');
        expect(rogue.detail).toMatch(/stealth \+0 -> null \(computed \+6; a 0 nobody wrote/);
        expect(rogue.fix).toMatch(/character_manage update \{characterId: "rogue", stealthOverride: 0\}/);
        expect(rogue.fix).toMatch(/world_manage reconcile \{worldId: "w1", acknowledge: \["skill_override_migrated"\]\}/);
        const bonus = r.findings.find((f: any) => f.characterId === 'bonus');
        expect(bonus.detail).toMatch(/stealth \+3 -> \+5 \(computed \+2; legacy additive bonus folded into an override\)/);

        // One character at a time, then the rest of the world.
        r = await reconcile({ characterId: 'rogue', acknowledge: ['skill_override_migrated'] });
        expect(r.acknowledged).toEqual({ skill_override_migrated: 1 });
        expect(r.count).toBe(0);
        expect(r.message).toMatch(/Acknowledged skill_override_migrated ×1/);
        r = await reconcile();
        expect(r.count).toBe(1);
        expect(r.findings[0].characterId).toBe('bonus');
        r = await reconcile({ acknowledge: ['skill_override_migrated'] });
        expect(r.acknowledged).toEqual({ skill_override_migrated: 1 });
        expect(r.count).toBe(0);
        packet = buildBootPacket(W);
        expect(packet.reconcile).toBeUndefined();

        // The other world's row is untouched.
        const other = json(await handleWorldManage(WorldManageTool.inputSchema.parse({ action: 'reconcile', worldId: 'w2' }), ctx as any));
        expect(other.count).toBe(1);
        expect(other.findings[0].characterId).toBe('far');
    });
    it('the named fix clears the finding: an explicit override write acknowledges that skill\'s ledger row; a column back at its old number is no longer listed; one moved elsewhere stays listed with its live value', async () => {
        const db = getDb();
        const ledger = (id: string) => db.prepare('SELECT acknowledged FROM skill_override_migrations WHERE character_id = ? AND skill = ?').get(id, 'stealth') as { acknowledged: number };
        expect((await reconcile()).count).toBe(2);

        // The GM follows the fix call on the rogue: stealthOverride: 0 restores the old number.
        const upd = JSON.parse((await handleCharacterManage(CharacterManageTool.inputSchema.parse({ action: 'update', characterId: 'rogue', stealthOverride: 0 }), ctx as any)).content[0].text.match(/<!-- CHARACTER_MANAGE_JSON\n([\s\S]*?)\nCHARACTER_MANAGE_JSON -->/)![1]);
        expect(upd.success).toBe(true);
        expect(upd.ledgerAcknowledged).toEqual(['stealth']);
        expect(ledger('rogue').acknowledged).toBe(1);
        let r = await reconcile();
        expect(r.count).toBe(1);
        expect(r.findings[0].characterId).toBe('bonus');

        // The column moved elsewhere without a decision (the stat-change sync, a raw edit): still listed, with the live number.
        db.prepare("UPDATE characters SET stealth_bonus = 9 WHERE id = 'bonus'").run();
        r = await reconcile();
        expect(r.count).toBe(1);
        expect(r.findings[0].detail).toBe('stealth +3 -> +5 (computed +2; legacy additive bonus folded into an override; now +9)');

        // The old number is back (by any writer): the move is undone, no finding; the ledger row stays unacknowledged and reconcile wrote nothing.
        db.prepare("UPDATE characters SET stealth_bonus = 3 WHERE id = 'bonus'").run();
        r = await reconcile();
        expect(r.count).toBe(0);
        expect(ledger('bonus').acknowledged).toBe(0);
        expect(buildBootPacket(W).reconcile).toBeUndefined();
    });

    it('acknowledging a kind with nothing to mark says so instead of claiming a write', async () => {
        const r = await reconcile({ acknowledge: ['xp_unposted'] });
        expect(r.acknowledged).toEqual({});
        expect(r.message).toMatch(/^Nothing to acknowledge for xp_unposted/);
        expect(r.message).not.toMatch(/Acknowledged \./);
        expect(r.count).toBe(2);
    });
});
