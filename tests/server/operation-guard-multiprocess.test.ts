/**
 * Claude Desktop runs two server processes against one rpg.db. Each cached
 * its own combat engine, so a process whose cache went stale rolled the other
 * process's dice again and saved over its writes. Every guarded call now takes
 * the write lock first and reloads combat engines from the database.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

// No tenant in tests: the guard's session key and the handlers' are both 'unscoped'.
const ctx = { sessionId: 'unscoped' } as any;
const CM = withOperation('combat_manage', a => handleCombatManage(a, ctx));
const CA = withOperation('combat_action', a => handleCombatAction(a, ctx));
const json = (r: any, tag: string) => JSON.parse(r.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`))[1]);

const participants = [
    { id: 'a', name: 'A', hp: 9999, maxHp: 9999, initiative: 20, ac: 10 },
    { id: 'b', name: 'B', hp: 9999, maxHp: 9999, initiative: 10, ac: 10, isEnemy: true }
];

let dir: string | undefined;
afterEach(() => {
    closeDb();
    clearCombatState();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
});

describe('two server processes, one database', () => {
    it("never replays the other process's dice from a stale cache (seeded stream)", async () => {
        closeDb();
        const db = getDb(':memory:');
        const enc = json(await CM({ action: 'create', seed: 'two-procs', participants }, undefined), 'COMBAT_MANAGE').encounterId;
        await CA({ action: 'attack', encounterId: enc, actorId: 'a', targetId: 'b', attackBonus: 5, damage: '4d6' }, undefined);
        await CM({ action: 'advance', encounterId: enc }, undefined);
        await CM({ action: 'advance', encounterId: enc }, undefined);

        // The other process: its own engine from the database, five dice, saved.
        const repo = new EncounterRepository(db);
        const other = new CombatEngine(enc);
        other.loadState(repo.loadState(enc)!);
        const theirs = [1, 2, 3, 4, 5].map(() => other.rollD20({ purpose: 'other process' }));
        const theirStart = other.drainRollRecords()[0].startDraw;
        repo.saveState(enc, other.getState()!);

        await CA({ action: 'attack', encounterId: enc, actorId: 'a', targetId: 'b', attackBonus: 5, damage: '4d6' }, undefined);
        const last = db.prepare("SELECT replay, dice FROM roll_log WHERE purpose = 'attack' ORDER BY rowid DESC LIMIT 1").get() as { replay: string; dice: string };
        const startDraw = Number(last.replay.split('@')[1]);
        expect(startDraw).toBe(theirStart + theirs.length);
    });

    it('crypto mode: two processes never log the same replay key', async () => {
        closeDb();
        const db = getDb(':memory:');
        // Unseeded: crypto dice.
        const created = json(await CM({ action: 'create', participants }, undefined), 'COMBAT_MANAGE');
        expect(created.dice).toBe('crypto');
        const enc = created.encounterId;
        await CA({ action: 'attack', encounterId: enc, actorId: 'a', targetId: 'b', attackBonus: 5, damage: '4d6' }, undefined);

        // The other process: loads the same encounter, rolls, saves and logs its own dice.
        const repo = new EncounterRepository(db);
        const other = new CombatEngine(enc);
        other.loadState(repo.loadState(enc)!);
        expect(other.diceMode).toBe('crypto');
        for (let i = 0; i < 25; i++) other.rollD20({ purpose: `other process ${i}` });
        const theirs = other.drainRollRecords();
        expect(theirs).toHaveLength(25);
        repo.saveState(enc, other.getState()!);
        const { recordRolls } = await import('../../src/storage/roll-log.js');
        recordRolls(db, theirs.map(r => ({ purpose: r.purpose, encounterId: enc, dice: r.dice, replay: r.replay!, source: r.source })), { tool: 'other' });

        for (let i = 0; i < 10; i++) {
            await CM({ action: 'advance', encounterId: enc }, undefined);
            await CM({ action: 'advance', encounterId: enc }, undefined);
            const res = json(await CA({ action: 'attack', encounterId: enc, actorId: 'a', targetId: 'b', attackBonus: 5, damage: '4d6' }, undefined), 'COMBAT_ACTION');
            expect(res.error, JSON.stringify(res)).toBeUndefined();
        }
        const rows = db.prepare('SELECT replay, source FROM roll_log WHERE encounter_id = ?').all(enc) as Array<{ replay: string; source: string }>;
        expect(rows.length).toBeGreaterThanOrEqual(25 + 11 * 2);
        for (const r of rows) { expect(r.source).toBe('crypto'); expect(r.replay).toMatch(/^crypto:[0-9a-f]{8}$/); }
        expect(new Set(rows.map(r => r.replay)).size).toBe(rows.length);
        // The draw count still advances across both processes.
        const state = repo.loadState(enc)!;
        expect((state.rngState as { mode: string; draws: number }).mode).toBe('crypto');
        expect((state.rngState as { draws: number }).draws).toBeGreaterThanOrEqual(2 + 25 + 11 * 2);
    });

    it('waits for the other process to finish writing', async () => {
        closeDb();
        dir = mkdtempSync(join(tmpdir(), 'op-lock-'));
        const path = join(dir, 'rpg.db');
        const db = getDb(path);
        const enc = json(await CM({ action: 'create', participants }, undefined), 'COMBAT_MANAGE').encounterId;

        const holder = new Database(path);
        holder.pragma('busy_timeout = 0');
        db.pragma('busy_timeout = 50');
        holder.exec('BEGIN IMMEDIATE');
        await expect(CM({ action: 'set_intent', encounterId: enc, participantId: 'b', intent: 'blocked' }, undefined)).rejects.toThrow(/busy|locked/i);
        holder.exec('COMMIT');
        holder.close();

        const ok = json(await CM({ action: 'set_intent', encounterId: enc, participantId: 'b', intent: 'lands' }, undefined), 'COMBAT_MANAGE');
        expect(ok.error).toBeUndefined();
        const b = new EncounterRepository(db).loadState(enc)!.participants.find(p => p.id === 'b') as any;
        expect(b.intent).toBe('lands');
    });
});
