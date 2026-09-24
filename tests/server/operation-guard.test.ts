import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleBatchManage } from '../../src/server/consolidated/batch-manage.js';
import { handleSessionManage } from '../../src/server/consolidated/session-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { getCombatManager } from '../../src/server/state/combat-manager.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

// With no tenant in scope the session is 'unscoped', as for a local server.
const ctx = { sessionId: 'unscoped' };
const guarded = (tool: string, h: (a: any, c: any) => Promise<any>) => withOperation(tool, (args) => h(args, ctx));
const manage = guarded('combat_manage', handleCombatManage);
const batch = guarded('batch_manage', handleBatchManage);
const session = guarded('session_manage', handleSessionManage);
let enc: string;
const hp = () => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === 'orla')!.hp;

/**
 * Field report, tier 1: a timed-out call could not be retried safely, and a
 * half-applied turn left HP, conditions and the turn order disagreeing.
 */
describe('operation guard', () => {
    beforeEach(async () => {
        closeDb(); getDb(':memory:'); clearCombatState();
        const res = await manage({ action: 'create', participants: [
            { id: 'orla', name: 'Orla', hp: 40, maxHp: 40, initiative: 20 },
            { id: 'knight', name: 'Knight D', hp: 100, maxHp: 100, initiative: 5, isEnemy: true }
        ] }, {});
        enc = JSON.parse(res.content[0].text.match(/<!-- COMBAT_MANAGE_JSON\n([\s\S]*?)\nCOMBAT_MANAGE_JSON -->/)![1]).encounterId;
    });
    afterEach(() => closeDb());

    it('a retried opId applies once and replays the stored reply', async () => {
        const call = { action: 'adjust_hp', encounterId: enc, participantId: 'orla', delta: -10, reason: 'melta splash', opId: 'op-1' };
        const first = await manage({ ...call }, {});
        expect(first.content[0].text).toMatch(/op op-1 applied/);
        const retry = await manage({ ...call }, {});
        expect(retry.content[0].text).toMatch(/REPLAYED op op-1/);
        expect(hp()).toBe(30);
        const status = await session({ action: 'op_status', forOpId: 'op-1' }, {});
        expect(status.content[0].text).toMatch(/op op-1 applied: combat_manage/);
        expect((await session({ action: 'op_status', forOpId: 'never-sent' }, {})).content[0].text).toMatch(/did not apply/);
    });

    it('the same opId with different arguments is refused and applies nothing', async () => {
        await manage({ action: 'adjust_hp', encounterId: enc, participantId: 'orla', delta: -10, reason: 'a', opId: 'op-2' }, {});
        const clash = await manage({ action: 'adjust_hp', encounterId: enc, participantId: 'orla', delta: -25, reason: 'b', opId: 'op-2' }, {});
        expect(clash.content[0].text).toMatch(/already used for a different call/);
        expect(hp()).toBe(30);
    });

    it('an atomic sequence that fails partway rolls every step back, memory included', async () => {
        const res = await batch({ action: 'execute_sequence', atomic: true, steps: [
            { id: 'hurt', tool: 'combat_manage', args: { action: 'adjust_hp', encounterId: enc, participantId: 'orla', delta: -15, reason: 'first step' } },
            { id: 'bad', tool: 'combat_manage', args: { action: 'adjust_hp', encounterId: enc, participantId: 'nobody', delta: -5, reason: 'fails' } }
        ] }, {});
        expect(res.content[0].text).toMatch(/every step in this sequence was rolled back/);
        expect(hp()).toBe(40);
        // The live engine was dropped, so the next read reloads the rolled-back HP.
        expect(getCombatManager().list().some(k => k.endsWith(enc))).toBe(false);
        const state = await manage({ action: 'get', encounterId: enc }, {});
        expect(state.content[0].text).toMatch(/40\/40 HP/);
    });

    it('a plain call that writes and then errors or throws leaves nothing behind', async () => {
        getDb().exec('CREATE TABLE IF NOT EXISTS probe (v TEXT)');
        const writesThenErrors = withOperation('probe_tool', async () => {
            getDb().prepare("INSERT INTO probe (v) VALUES ('half')").run();
            return { content: [{ type: 'text', text: '<!-- PROBE_JSON\n{"error":true,"message":"failed late"}\nPROBE_JSON -->' }] };
        });
        const writesThenThrows = withOperation('probe_tool', async () => {
            getDb().prepare("INSERT INTO probe (v) VALUES ('half')").run();
            throw new Error('boom');
        });
        await writesThenErrors({}, {});
        await expect(writesThenThrows({}, {})).rejects.toThrow('boom');
        expect((getDb().prepare('SELECT COUNT(*) AS n FROM probe').get() as { n: number }).n).toBe(0);
    });

    it('calls on one database run one at a time', async () => {
        const order: string[] = [];
        const slow = (name: string) => withOperation('probe_tool', async () => {
            order.push(`${name}:start`);
            await new Promise(r => setTimeout(r, 20));
            order.push(`${name}:end`);
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        await Promise.all([slow('a')({}, {}), slow('b')({}, {})]);
        expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    });
});
