/**
 * Play report 7 #6, adversarial review on the merged tree (lanes B, D, A, C, E).
 *
 * What the review found and pins here:
 *  - remove_participant of the actor that is up now lands the way an advance
 *    lands: a surprised slot passes (round 1), a dying slot rolls its death
 *    save (or owes DEATH SAVE DUE in prompt mode), a controlled mount's slot
 *    passes to the next, an orphaned LAIR slot passes.
 *  - mounting and dismounting on the rider's own turn (lane C) touch the turn,
 *    and so does a controlled mount's Dash, Disengage or Dodge on its rider's
 *    turn: the rider chose them.
 *  - the off-turn economy refusal at a round wrap: a token later in the order
 *    whose own turn last round spent its action is told its turn has ended,
 *    not that its action was spent off-turn.
 *  - actedThisTurn lives on the encounter row (a second process reads it).
 *  - over buildServer (withOutputMode): the TURN NOT TAKEN refusal keeps
 *    turnNotTaken and confirmCall in output_mode summary.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server/build-server.js';
import { PubSub } from '../../src/engine/pubsub.js';
import { AuditLogger } from '../../src/server/audit.js';
import { replyJson } from '../../src/server/reply-status.js';
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

process.env.NODE_ENV = 'test';

type P = CombatParticipant & Record<string, unknown>;
const ctx = { sessionId: 'pc-turn-guard-review' };
const W = 'blackcrown';
const now = () => new Date().toISOString();
const embedded = (res: any, tag: string) => {
    const text = res.content[0].text as string;
    const m = text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? { ...JSON.parse(m[1]), text } : { rawText: text, text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage({ encounterId: enc, ...args }, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction({ encounterId: enc, ...args }, ctx as any), 'COMBAT_ACTION');

let enc: string;
const repo = () => new CharacterRepository(getDb());
const mk = (id: string, extra: Record<string, unknown> = {}) => repo().create({
    id, name: id[0].toUpperCase() + id.slice(1), stats: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
    hp: 20, maxHp: 20, ac: 12, level: 3, createdAt: now(), updatedAt: now(), ...extra
} as any);
const stored = () => new EncounterRepository(getDb()).loadState(enc)!;
const tok = (id: string) => stored().participants.find((p: P) => p.id === id)! as P;
const currentId = () => { const s = stored(); return s.turnOrder[s.currentTurnIndex]; };
const create = async (participants: Array<Record<string, unknown>>, opts: Record<string, unknown> = {}) => {
    const created = embedded(await handleCombatManage({ action: 'create', seed: 'pc-turn-guard-review', worldId: W, participants, ...opts }, ctx as any), 'COMBAT_MANAGE');
    enc = created.encounterId;
    return created;
};
const gor = (extra: Record<string, unknown> = {}) => ({ id: 'gor', name: 'Gor', hp: 30, maxHp: 30, ac: 10, initiative: 10, isEnemy: true, position: { x: 1, y: 0 }, ...extra });

beforeEach(() => {
    closeDb(); getDb(':memory:'); clearCombatState();
    new WorldRepository(getDb()).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now(), updatedAt: now(), environment: { day: 89, time: '06:00' } } as any);
    mk('kael');
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('remove_participant of the actor that is up lands as an advance lands', () => {
    it('a surprised slot next in round 1 passes (surprise spent), and the slot after it is up', async () => {
        mk('mira');
        await create([
            { id: 'scout', name: 'Scout', hp: 10, maxHp: 10, initiative: 25, position: { x: 9, y: 9 } },
            { id: 'kael', name: 'Kael', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            gor()
        ], { surprised: ['kael'] });
        expect(currentId()).toBe('scout');
        const gone = await manage({ action: 'remove_participant', participantId: 'scout' });
        expect(gone.error).toBeUndefined();
        expect(gone.currentTurn).toBe('gor');
        expect(currentId()).toBe('gor');
        expect(tok('kael').surprised).toBeFalsy();
        expect(gone.message).toMatch(/surprised/);
    });

    it('a dying slot next (auto mode) rolls its death save, as an advance does', async () => {
        repo().update('kael', { hp: 0 } as any);
        await create([
            { id: 'scout', name: 'Scout', hp: 10, maxHp: 10, initiative: 25, position: { x: 9, y: 9 } },
            { id: 'kael', name: 'Kael', hp: 0, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            gor()
        ]);
        expect(currentId()).toBe('scout');
        const before = tok('kael') as any;
        const tally = (t: any) => (t.deathSaveSuccesses ?? 0) + (t.deathSaveFailures ?? 0) + (t.hp > 0 ? 1 : 0) + (t.isStabilized ? 1 : 0) + (t.isDead ? 1 : 0);
        const gone = await manage({ action: 'remove_participant', participantId: 'scout' });
        expect(gone.error).toBeUndefined();
        expect(tally(tok('kael'))).toBeGreaterThan(tally(before));
        expect(gone.deathSaves?.[0]).toMatchObject({ participantId: 'kael' });
    });

    it('a dying slot next (prompt mode) owes DEATH SAVE DUE, and advance is refused until it is rolled', async () => {
        new WorldRepository(getDb()).updateEnvironment(W, { deathSaveMode: 'prompt' });
        repo().update('kael', { hp: 0 } as any);
        await create([
            { id: 'scout', name: 'Scout', hp: 10, maxHp: 10, initiative: 25, position: { x: 9, y: 9 } },
            { id: 'kael', name: 'Kael', hp: 0, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            gor()
        ]);
        const gone = await manage({ action: 'remove_participant', participantId: 'scout' });
        expect(gone.currentTurn).toBe('kael');
        expect(gone.deathSaveDue).toMatchObject({ participantId: 'kael' });
        const refused = await manage({ action: 'advance' });
        expect(refused.error).toBe(true);
        expect(refused.message).toMatch(/DEATH SAVE DUE/);
    });

    it("a controlled mount's slot next passes to the slot after it", async () => {
        await create([
            { id: 'kael', name: 'Kael', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'scout', name: 'Scout', hp: 10, maxHp: 10, initiative: 18, position: { x: 9, y: 9 } },
            { id: 'horse', name: 'Warhorse', hp: 19, maxHp: 19, ac: 11, initiative: 15, size: 'large', movementSpeed: 60, position: { x: 3, y: 3 } },
            gor({ position: { x: 12, y: 12 } })
        ]);
        await act({ action: 'move', actorId: 'kael', targetPosition: { x: 2, y: 2 } });
        await manage({ action: 'mount', riderId: 'kael', mountId: 'horse', free: true });
        await manage({ action: 'advance' });
        expect(currentId()).toBe('scout');
        const gone = await manage({ action: 'remove_participant', participantId: 'scout' });
        expect(gone.currentTurn).toBe('gor');
    });

    it('wrapping past the last slot opens the next round once, and the new actor starts its turn', async () => {
        await create([
            { id: 'kael', name: 'Kael', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            gor()
        ]);
        await act({ action: 'move', actorId: 'kael', targetPosition: { x: 0, y: 1 } });
        await manage({ action: 'advance' });
        const gone = await manage({ action: 'remove_participant', participantId: 'gor' });
        expect(gone.currentTurn).toBe('kael');
        expect(gone.round).toBe(2);
        expect(tok('kael')).toMatchObject({ movedThisTurn: 0, actedThisTurn: false });
    });
});

describe('lane C: mounting is the rider acting', () => {
    const scene = async () => {
        await create([
            { id: 'kael', name: 'Kael', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'horse', name: 'Warhorse', hp: 19, maxHp: 19, ac: 11, initiative: 15, size: 'large', movementSpeed: 60, position: { x: 1, y: 0 } },
            gor({ position: { x: 12, y: 12 } })
        ]);
    };

    it('mounting on the rider\'s own turn touches it: advance passes without confirm', async () => {
        await scene();
        const up = await manage({ action: 'mount', riderId: 'kael', mountId: 'horse' });
        expect(up.success).toBe(true);
        const r = await manage({ action: 'advance' });
        expect(r.error).toBeUndefined();
        expect(r.skippedTurn).toBeUndefined();
    });

    it('a free mount (scene set-up) does not touch the turn', async () => {
        await scene();
        await manage({ action: 'mount', riderId: 'kael', mountId: 'horse', free: true });
        const r = await manage({ action: 'advance' });
        expect(r.error).toBe(true);
        expect(r.message).toMatch(/TURN NOT TAKEN: Kael/);
    });

    it('dismounting on the rider\'s own turn touches it', async () => {
        await scene();
        await manage({ action: 'mount', riderId: 'kael', mountId: 'horse', free: true });
        const down = await manage({ action: 'dismount', riderId: 'kael' });
        expect(down.success).toBe(true);
        const r = await manage({ action: 'advance' });
        expect(r.error).toBeUndefined();
    });

    it("a controlled mount's Dodge on its rider's turn is the rider's choice: the turn is touched", async () => {
        await scene();
        await manage({ action: 'mount', riderId: 'kael', mountId: 'horse', free: true });
        const dodge = await act({ action: 'dodge', actorId: 'horse' });
        expect(dodge.error).toBeUndefined();
        const r = await manage({ action: 'advance' });
        expect(r.error).toBeUndefined();
        // The controlled mount's own slot passes inside the advance; Gor is up.
        expect(r.currentTurn.id).toBe('gor');
    });

    it("a controlled mount acting on its rider's turn is on its turn: no offTurn, and a spent action does not say its turn ended", async () => {
        await scene();
        await manage({ action: 'mount', riderId: 'kael', mountId: 'horse', free: true });
        const first = await act({ action: 'disengage', actorId: 'horse' });
        expect(first.error).toBeUndefined();
        expect(first.offTurn).toBeUndefined();
        expect(first.text).not.toMatch(/off_turn_action/);
        const again = await act({ action: 'dodge', actorId: 'horse' });
        expect(again.error).toBe(true);
        expect(again.text).toMatch(/Action already used this turn/);
        expect(again.text).not.toMatch(/turn has ended|spent off-turn/);
    });

    it("the controlled mount's slot passes inside the advance without tripping the guard", async () => {
        mk('horse');
        await scene();
        await manage({ action: 'mount', riderId: 'kael', mountId: 'horse', free: true });
        await act({ action: 'move', actorId: 'kael', targetPosition: { x: 4, y: 4 } });
        const r = await manage({ action: 'advance' });
        expect(r.error).toBeUndefined();
        expect(r.currentTurn.id).toBe('gor');
    });
});

describe('off-turn refusal at a round wrap', () => {
    it("Kael last in the order, his action spent on his own turn, advanced into round 2: his turn has ended", async () => {
        await create([
            { id: 'kael', name: 'Kael', hp: 20, maxHp: 20, initiative: 5, position: { x: 0, y: 0 } },
            gor({ initiative: 15 })
        ]);
        expect(currentId()).toBe('gor');
        await manage({ action: 'advance' });
        expect(currentId()).toBe('kael');
        await act({ action: 'attack', actorId: 'kael', targetId: 'gor', outcome: 'miss' });
        const next = await manage({ action: 'advance' });
        expect(next.round).toBe(2);
        expect(currentId()).toBe('gor');
        const late = await act({ action: 'dodge', actorId: 'kael' });
        expect(late.error).toBe(true);
        expect(late.text).toMatch(/it is Gor's turn: Kael's turn has ended \(advance passed it\)/);
        expect(late.text).not.toMatch(/spent off-turn/);
    });

    it('a token that has not had a turn yet (round 1, later slot) is told its action was spent off-turn', async () => {
        await create([
            { id: 'kael', name: 'Kael', hp: 20, maxHp: 20, initiative: 5, position: { x: 0, y: 0 } },
            gor({ initiative: 15 })
        ]);
        const first = await act({ action: 'dodge', actorId: 'kael' });
        expect(first.error).toBeUndefined();
        const again = await act({ action: 'dodge', actorId: 'kael' });
        expect(again.error).toBe(true);
        expect(again.text).toMatch(/Kael's turn is still to come this round, and its action was spent off-turn/);
    });
});

describe('two processes', () => {
    it('a free battle cry in one process lets the next process advance (actedThisTurn is on the row)', async () => {
        await create([{ id: 'kael', name: 'Kael', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } }, gor()]);
        await manage({ action: 'battle_cry', participantId: 'kael', name: 'For Blackcrown!', attackAdvantage: true, actionCost: 'none' });
        expect(tok('kael').actedThisTurn).toBe(true);
        clearCombatState();
        const r = await manage({ action: 'advance' });
        expect(r.error).toBeUndefined();
        expect(r.currentTurn.id).toBe('gor');
    });

    it('a refusal in one process, then confirm in another', async () => {
        await create([{ id: 'kael', name: 'Kael', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } }, gor()]);
        expect((await manage({ action: 'advance' })).error).toBe(true);
        clearCombatState();
        const r = await manage({ action: 'advance', confirm: true });
        expect(r.skippedTurn).toMatchObject({ participantId: 'kael', round: 1 });
        expect(currentId()).toBe('gor');
    });
});

describe('over buildServer (withOutputMode)', () => {
    let client: Client;
    beforeEach(async () => {
        const server = buildServer(new PubSub(), new AuditLogger());
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'pc-turn-guard-review', version: '0.0.0' });
        await client.connect(clientTransport);
    });
    afterEach(async () => { await client.close(); });
    const call = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>)[0].text;
        return { text, data: (replyJson(text) ?? {}) as Record<string, any> };
    };

    it('output_mode summary keeps turnNotTaken and confirmCall; confirm and skipTurn cross; nothing is ignored', async () => {
        const { data: created } = await call('combat_manage', { action: 'create', seed: 'mcp', worldId: W, participants: [
            { id: 'kael', name: 'Kael', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            gor()
        ] });
        const e = created.encounterId as string;
        const { data: refused } = await call('combat_manage', { action: 'advance', encounterId: e, output_mode: 'summary' });
        expect(refused.error).toBe(true);
        expect(refused.writes).toBe('none');
        expect(refused.turnNotTaken).toMatchObject({ participantId: 'kael', name: 'Kael', round: 1 });
        expect(refused.confirmCall).toBe(`combat_manage advance {encounterId: '${e}', confirm: true}`);
        const { data: passed } = await call('combat_manage', { action: 'advance', encounterId: e, confirm: true, output_mode: 'summary' });
        expect(passed.error).toBeFalsy();
        expect(passed.skippedTurn).toMatchObject({ participantId: 'kael', round: 1 });
        expect(passed.ignoredParams).toBeUndefined();
    });
});
