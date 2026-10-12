import { withOperation, lookupOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleWorldManage } from '../../src/server/consolidated/world-manage.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
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
const world = guarded('world_manage', handleWorldManage);
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

    // Play report 2, #11: a validation failure or an unknown action was stored
    // as applied, so the corrected retry with the same opId was refused.
    describe('error and no-write replies leave the opId free', () => {
        const W = 'w-guard';
        beforeEach(() => {
            const now = new Date().toISOString();
            new WorldRepository(getDb()).create({ id: W, name: 'Guarded', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        });

        it('a validation error does not burn the opId, and the corrected resend applies', async () => {
            const bad = await world({ action: 'update', id: W, environment: { bogus: 1 }, opId: 'v1' }, {});
            expect(bad.content[0].text).toMatch(/op v1 NOT applied/);
            expect(bad.content[0].text).toMatch(/validation_error/);
            expect((await session({ action: 'op_status', forOpId: 'v1' }, {})).content[0].text).toMatch(/did not apply/);
            const good = await world({ action: 'update', id: W, environment: { weatherConditions: 'rain' }, opId: 'v1' }, {});
            expect(good.content[0].text).toMatch(/op v1 applied/);
            expect(new WorldRepository(getDb()).findById(W)!.environment).toMatchObject({ weatherConditions: 'rain' });
            expect((await session({ action: 'op_status', forOpId: 'v1' }, {})).content[0].text).toMatch(/op v1 applied: world_manage/);
        });

        it('the #14 did-you-mean refusal is a validation error, so the opId stays free too', async () => {
            const bad = await world({ action: 'update', id: W, environment: { wether: 'rain' }, opId: 'v1b' }, {});
            expect(bad.content[0].text).toMatch(/op v1b NOT applied/);
            expect(bad.content[0].text).toMatch(/Did you mean 'weatherConditions'/);
            const good = await world({ action: 'update', id: W, environment: { weather: 'rain' }, opId: 'v1b' }, {});
            expect(good.content[0].text).toMatch(/op v1b applied/);
            expect(new WorldRepository(getDb()).findById(W)!.environment).toMatchObject({ weatherConditions: 'rain' });
        });

        it('an unknown action leaves the opId free', async () => {
            const bad = await world({ action: 'frobnicate', opId: 'v2' }, {});
            expect(bad.content[0].text).toMatch(/op v2 NOT applied/);
            const good = await world({ action: 'update', id: W, environment: { season: 'winter' }, opId: 'v2' }, {});
            expect(good.content[0].text).toMatch(/op v2 applied/);
        });

        it('success:false without an error wrote, so it claims the opId and replays', async () => {
            getDb().exec('CREATE TABLE IF NOT EXISTS probe (v TEXT)');
            const partial = withOperation('probe_tool', async () => {
                getDb().prepare("INSERT INTO probe (v) VALUES ('partial')").run();
                return { content: [{ type: 'text', text: '<!-- PROBE_JSON\n{"success":false,"message":"step 2 of 3 failed"}\nPROBE_JSON -->' }] };
            });
            expect((await partial({ opId: 'v3' }, {})).content[0].text).toMatch(/op v3 applied/);
            expect((await partial({ opId: 'v3' }, {})).content[0].text).toMatch(/REPLAYED op v3/);
            expect((getDb().prepare('SELECT COUNT(*) AS n FROM probe').get() as { n: number }).n).toBe(1);
        });

        it('a reply with writes:none does not consume the opId', async () => {
            const preview = withOperation('probe_tool', async () => ({ content: [{ type: 'text', text: '<!-- PROBE_JSON\n{"success":true,"preview":true,"writes":"none"}\nPROBE_JSON -->' }] }));
            expect((await preview({ opId: 'v4' }, {})).content[0].text).toMatch(/op v4: nothing written — opId not consumed/);
            expect((await session({ action: 'op_status', forOpId: 'v4' }, {})).content[0].text).toMatch(/did not apply/);
            const real = await world({ action: 'update', id: W, environment: { season: 'spring' }, opId: 'v4' }, {});
            expect(real.content[0].text).toMatch(/op v4 applied/);
        });

        it('an opId burned by an error reply before this fix is healed: the retry runs', async () => {
            lookupOperation(getDb(), 'make-table');
            getDb().prepare('INSERT INTO op_log (op_id, tool, args_hash, response, created_at) VALUES (?, ?, ?, ?, ?)')
                .run('burned', 'world_manage', 'stale', '<!-- WORLD_MANAGE_JSON\n{"error":"validation_error","writes":"none"}\nWORLD_MANAGE_JSON -->', '2026-01-01T00:00:00.000Z');
            expect(lookupOperation(getDb(), 'burned')).toBeNull();
            expect((await session({ action: 'op_status', forOpId: 'burned' }, {})).content[0].text).toMatch(/did not apply/);
            const good = await world({ action: 'update', id: W, environment: { season: 'autumn' }, opId: 'burned' }, {});
            expect(good.content[0].text).toMatch(/op burned applied/);
            expect(good.content[0].text).not.toMatch(/REPLAYED|REFUSED/);
            expect(lookupOperation(getDb(), 'burned')?.tool).toBe('world_manage');
        });

        it('an opId a preview consumed before this fix is healed too: the real call runs', async () => {
            // Before #11 a writes:'none' reply (a preview, a budget read) was
            // stored as applied; the real call with that opId was then refused
            // and op_status claimed a write that never happened.
            lookupOperation(getDb(), 'make-table');
            getDb().prepare('INSERT INTO op_log (op_id, tool, args_hash, response, created_at) VALUES (?, ?, ?, ?, ?)')
                .run('previewed', 'character_manage', 'stale', '<!-- CHARACTER_MANAGE_JSON\n{"success":true,"preview":true,"writes":"none"}\nCHARACTER_MANAGE_JSON -->', '2026-01-01T00:00:00.000Z');
            expect(lookupOperation(getDb(), 'previewed')).toBeNull();
            expect((await session({ action: 'op_status', forOpId: 'previewed' }, {})).content[0].text).toMatch(/did not apply/);
            const good = await world({ action: 'update', id: W, environment: { season: 'summer' }, opId: 'previewed' }, {});
            expect(good.content[0].text).toMatch(/op previewed applied/);
            expect(good.content[0].text).not.toMatch(/REPLAYED|REFUSED/);
            expect(lookupOperation(getDb(), 'previewed')?.tool).toBe('world_manage');
        });

        it('the MCP isError flag rolls the call back like an error embed', async () => {
            getDb().exec('CREATE TABLE IF NOT EXISTS probe (v TEXT)');
            const flagged = withOperation('probe_tool', async () => {
                getDb().prepare("INSERT INTO probe (v) VALUES ('half')").run();
                return { isError: true, content: [{ type: 'text', text: 'the handler gave up' }] };
            });
            await flagged({ opId: 'v6' }, {});
            expect((getDb().prepare('SELECT COUNT(*) AS n FROM probe').get() as { n: number }).n).toBe(0);
            expect(lookupOperation(getDb(), 'v6')).toBeNull();
        });
    });
});
