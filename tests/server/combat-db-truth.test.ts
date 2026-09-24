/**
 * Since every guarded call reads the encounter fresh (two server processes,
 * one database), nothing is ever "in memory" when a call starts. A live fight
 * must never be treated as a ghost for that: end, death saves, lair actions,
 * list and boot all read the database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleSessionManage } from '../../src/server/consolidated/session-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const ctx = { sessionId: 'unscoped' } as any;
const CM = withOperation('combat_manage', a => handleCombatManage(a, ctx));
const SM = withOperation('session_manage', a => handleSessionManage(a, ctx));
const text = (r: any) => r.content[0].text as string;
const json = (r: any, tag: string) => JSON.parse(text(r).match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`))![1]);

let enc: string;
beforeEach(async () => {
    closeDb();
    getDb(':memory:');
    enc = json(await CM({ action: 'create', participants: [
        { id: 'a', name: 'A', hp: 0, maxHp: 30, initiative: 20, ac: 10 },
        { id: 'b', name: 'B', hp: 30, maxHp: 30, initiative: 10, ac: 10, isEnemy: true }
    ] }, undefined), 'COMBAT_MANAGE').encounterId;
});
afterEach(() => { closeDb(); clearCombatState(); });

describe('a live fight is read from the database', () => {
    it('end closes it properly, and a second end says so', async () => {
        const out = text(await CM({ action: 'end', encounterId: enc }, undefined));
        expect(out).toMatch(/COMBAT ENDED/);
        expect(out).not.toMatch(/GHOST/);
        expect((getDb().prepare('SELECT status FROM encounters WHERE id = ?').get(enc) as { status: string }).status).toBe('completed');
        expect(text(await CM({ action: 'end', encounterId: enc }, undefined))).toMatch(/already ended/i);
    });

    it('a death save rolls on a live fight', async () => {
        const out = text(await CM({ action: 'death_save', encounterId: enc, characterId: 'a' }, undefined));
        expect(out).not.toMatch(/No active encounter/);
        expect(out).toMatch(/death save/i);
    });

    it('list shows it running, with no ghosts, and never buries it unasked', async () => {
        const listed = json(await CM({ action: 'list' }, undefined), 'COMBAT_MANAGE');
        expect(listed.encounters[0]).toMatchObject({ encounterId: enc, running: true });
        expect(listed.ghosts).toBeUndefined();
        const bury = json(await CM({ action: 'list', buryGhosts: true }, undefined), 'COMBAT_MANAGE');
        expect(bury.guardRefused).toBe(true);
        expect((getDb().prepare('SELECT status FROM encounters WHERE id = ?').get(enc) as { status: string }).status).toBe('active');
    });

    it('boot reports the fight without calling it not running', async () => {
        const ctxOut = json(await SM({ action: 'get_context', includeCombat: true }, undefined), 'SESSION_MANAGE');
        const combat = ctxOut.activeCombat ?? ctxOut.context?.activeCombat;
        expect(combat.encounterId).toBe(enc);
        expect(combat.inMemory).toBeUndefined();
    });
});
