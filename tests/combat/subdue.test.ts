import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { isKnockedOut } from '../../src/engine/combat/nonlethal.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 7 #5: a standing subdue order ("take them alive") on a token.
 * Its automatic opportunity attacks and readied melee swings knock out
 * instead of killing (the play report 5 knockout: 0 HP, Unconscious sourced
 * 'nonlethal: <actor>', stable, no kill, no corpse). A ranged readied shot
 * cannot be non-lethal, so the conflict is settled when the shot is readied
 * (owner's answer): readying one under the order is refused unless the call
 * says attack.onSubdue 'hold' (no shot, reaction and shot kept) or 'fire'
 * (lethal, "subdue order overridden"); an order that arrives after the ready
 * is flagged and, until answered, the trigger holds.
 */

const ctx = { sessionId: 'subdue' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manageText = async (args: Record<string, unknown>) => (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
const manage = async (args: Record<string, unknown>) => { const text = await manageText(args); return { text, d: tag(text, 'COMBAT_MANAGE') ?? {} }; };
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, d, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;
const live = (id: string) => getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === id)! as any;
const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
const corpses = () => (getDb().prepare('SELECT COUNT(*) AS n FROM corpses').get() as { n: number }).n;

async function setup(participants: any[], opts: { pc?: string[]; npc?: string[] } = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    const rows = [...(opts.pc ?? []).map(id => [id, 'pc']), ...(opts.npc ?? []).map(id => [id, 'npc'])];
    for (const [id, characterType] of rows) {
        new CharacterRepository(db).create({ id, name: id, characterType, stats: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }, hp: 5, maxHp: 5, ac: 10, level: 3, createdAt: now, updatedAt: now } as any);
    }
    const created = tag((await handleCombatManage({ action: 'create', seed: 'subdue', participants }, ctx as any)).content[0].text, 'COMBAT_MANAGE');
    enc = created.encounterId;
}

// Gor stands at (0,0) with a +40 swing that drops a 5-HP bandit; the bandit
// starts adjacent and walks east, leaving Gor's reach at its first step.
const gor = (extra: Record<string, unknown> = {}) => ({ id: 'gor', name: 'Gor', hp: 40, maxHp: 40, ac: 14, initiative: 20, position: { x: 0, y: 0 }, attackBonus: 40, attackDamage: '1d1+10', ...extra });
const bandit = (extra: Record<string, unknown> = {}) => ({ id: 'bandit', name: 'Bandit', hp: 5, maxHp: 5, ac: 10, initiative: 10, isEnemy: true, position: { x: 1, y: 0 }, ...extra });
const CROSSBOW = { name: 'crossbow', attackBonus: 40, damage: '1d1+10', damageType: 'piercing', ranged: true };
const SPEAR = { name: 'spear', attackBonus: 40, damage: '1d1+10', damageType: 'piercing' };

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('subdue: the standing flag', () => {
    it('create participants [{subdue: true}] and add_participant {subdue: true} keep it (shape and ROW_KEYS together)', async () => {
        await setup([gor({ subdue: true }), bandit()]);
        expect(tok('gor').subdue).toBe(true);
        expect(tok('bandit').subdue).toBeUndefined();
        const added = await manage({ action: 'add_participant', name: 'Grak', hp: 20, maxHp: 20, subdue: true, position: { x: 5, y: 5 } });
        expect(added.d.success).toBe(true);
        expect(tok(added.d.participant.id).subdue).toBe(true);
    });

    it('set_subdue turns it on and off, logs it, persists across a new process, and get shows it', async () => {
        await setup([gor(), bandit()]);
        const on = await manage({ action: 'set_subdue', participantId: 'gor', subdue: true, reason: 'Varek: alive' });
        expect(on.d).toMatchObject({ success: true, actionType: 'set_subdue', participantId: 'gor', subdue: true });
        expect(on.text).toMatch(/subdue/i);
        clearCombatState();
        expect(tok('gor').subdue).toBe(true);
        const view = await manage({ action: 'get' });
        expect(view.d.participants.find((p: any) => p.id === 'gor')).toMatchObject({ subdue: true });
        expect(view.text).toMatch(/🤲 subdue \(take alive\)/);
        const history = getDb().prepare(`SELECT action_type, result_summary FROM combat_action_log WHERE action_type = 'set_subdue'`).all() as any[];
        expect(history.length).toBe(1);
        const off = await manage({ action: 'set_subdue', participantId: 'gor', subdue: false });
        expect(off.d.subdue).toBe(false);
        expect(tok('gor').subdue).toBeFalsy();
    });

    it('set_subdue refuses an unknown participant or an empty call, writing nothing', async () => {
        await setup([gor(), bandit()]);
        const unknown = await manage({ action: 'set_subdue', participantId: 'nobody', subdue: true });
        expect(unknown.d).toMatchObject({ error: true, writes: 'none' });
        const empty = await manage({ action: 'set_subdue', participantId: 'gor' });
        expect(empty.d).toMatchObject({ error: true, writes: 'none' });
        expect(tok('gor').subdue).toBeUndefined();
    });
});

describe('subdue: opportunity attacks knock out', () => {
    it('an NPC reactor under the order knocks the mover out: Unconscious sourced to it, stable, no kill, no corpse, the sheet mirrored', async () => {
        await setup([gor({ subdue: true }), bandit()], { npc: ['bandit'] });
        const { text, r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 5, y: 0 } });
        expect(r.opportunityAttacks).toHaveLength(1);
        const oa = r.opportunityAttacks[0];
        expect(oa.hit).toBe(true);
        expect(oa.knockedOut).toEqual({ by: 'gor', stable: true });
        expect(oa.subdue).toMatchObject({ mode: 'non-lethal' });
        expect(r.killed).toBeUndefined();
        const b = tok('bandit');
        expect(b.hp).toBe(0);
        expect(b.isStabilized).toBe(true);
        expect(b.isDead).toBeFalsy();
        expect(isKnockedOut(b)).toBe(true);
        expect(b.conditions).toEqual([expect.objectContaining({ type: 'unconscious', sourceId: 'nonlethal: gor' })]);
        expect(sheet('bandit').conditions).toEqual([expect.objectContaining({ name: 'Unconscious', source: 'nonlethal: gor' })]);
        expect(corpses()).toBe(0);
        expect(text).toMatch(/💤 Bandit knocked out by Gor/);
        expect(text).toMatch(/knocked out/);
    });

    it('an opportunity attack that does not drop the mover is an ordinary hit', async () => {
        await setup([gor({ subdue: true, attackDamage: '1d1' }), bandit()]);
        const { r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 5, y: 0 } });
        expect(r.opportunityAttacks[0].hit).toBe(true);
        expect(r.opportunityAttacks[0].knockedOut).toBeUndefined();
        expect(tok('bandit')).toMatchObject({ hp: 4, conditions: [] });
    });

    it('without the order the same swing kills, as before', async () => {
        await setup([gor(), bandit()]);
        const { r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 5, y: 0 } });
        expect(r.opportunityAttacks[0].knockedOut).toBeUndefined();
        expect(r.opportunityAttacks[0].subdue).toBeUndefined();
        expect(tok('bandit').hp).toBe(0);
        expect(isKnockedOut(tok('bandit'))).toBe(false);
    });

    it('against a unit the order does not apply: the swing is lethal and says so', async () => {
        await setup([gor({ subdue: true }), bandit({ hp: 20, maxHp: 20, unit: { models: 4, hpPerModel: 5, packed: true, attackBonus: 0 } })]);
        const { r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 5, y: 0 } });
        const oa = r.opportunityAttacks[0];
        expect(oa.knockedOut).toBeUndefined();
        expect(oa.subdue).toMatchObject({ mode: 'n/a: unit' });
        expect(oa.situational.join(' ')).toMatch(/subdue: n\/a against a unit/);
        expect(tok('bandit').hp).toBe(15);
    });

    it('a subdued reactor does not swing at a mover already at 0 HP: skipped, reaction kept', async () => {
        await setup([gor({ subdue: true }), bandit({ hp: 0 })]);
        const { r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 5, y: 0 } });
        expect(r.opportunityAttacks).toEqual([]);
        expect(r.opportunityAttacksSkipped).toEqual([expect.objectContaining({ attackerId: 'gor', reason: expect.stringMatching(/already down/) })]);
        expect(tok('gor').reactionUsed).toBeFalsy();
    });

    it('a PC reactor under the order is offered the swing with nonlethal: true', async () => {
        await setup([gor({ subdue: true }), bandit()], { pc: ['gor'] });
        const { text, r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 5, y: 0 } });
        expect(r.opportunityAttacks).toEqual([]);
        expect(r.opportunityAttacksAvailable[0].call).toMatchObject({ tool: 'combat_action', action: 'attack', actorId: 'gor', targetId: 'bandit', reaction: true, nonlethal: true });
        expect(text).toMatch(/non-lethal/);
        // The offered call knocks out.
        const { r: swing } = await act(r.opportunityAttacksAvailable[0].call);
        expect(swing.knockedOut).toMatchObject({ by: 'gor' });
    });

    it('engine: executeOpportunityAttack by a subdued attacker knocks out', () => {
        const e = new CombatEngine('subdue-engine');
        e.startEncounter([
            { id: 'gor', name: 'Gor', initiativeBonus: 0, hp: 30, maxHp: 30, conditions: [], attackBonus: 40, attackDamage: '1d1+10', position: { x: 0, y: 0 }, subdue: true },
            { id: 'bandit', name: 'Bandit', initiativeBonus: 0, hp: 5, maxHp: 5, ac: 10, conditions: [], isEnemy: true, position: { x: 1, y: 0 } }
        ] as any);
        const r = e.executeOpportunityAttack('gor', 'bandit');
        expect(r.success).toBe(true);
        expect(r.knockedOut).toEqual({ by: 'gor', stable: true });
        expect(r.message).toMatch(/KNOCKED OUT/);
    });
});

describe('subdue: readied melee swings knock out', () => {
    it('a readied melee swing fired by a move knocks out and says so', async () => {
        await setup([gor({ subdue: true, attacks: [SPEAR] }), bandit({ position: { x: 4, y: 0 } })], { npc: ['bandit'] });
        const ready = await manage({ action: 'set_intent', participantId: 'gor', readied: { action: 'club the bandit', trigger: 'it closes', on: 'enters_reach', watch: 'bandit', attack: { using: 'spear' } } });
        expect(ready.d.success).toBe(true);
        const { text, r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 1, y: 0 } });
        expect(r.readiedTriggered).toHaveLength(1);
        expect(r.readiedTriggered[0]).toMatchObject({ participantId: 'gor', fired: true });
        expect(r.readiedTriggered[0].attack.knockedOut).toEqual({ by: 'gor', stable: true });
        expect(isKnockedOut(tok('bandit'))).toBe(true);
        expect(sheet('bandit').conditions).toEqual([expect.objectContaining({ name: 'Unconscious', source: 'nonlethal: gor' })]);
        expect(text).toMatch(/💤 Bandit knocked out by Gor/);
    });

    it('trigger_readied by hand knocks out too', async () => {
        await setup([gor({ subdue: true }), bandit()]);
        await manage({ action: 'set_intent', participantId: 'gor', readied: { action: 'club it', trigger: 'it moves', attack: { attackBonus: 40, damage: '1d1+10' } } });
        const { text, d } = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit' });
        expect(d.success).toBe(true);
        expect(d.attack.knockedOut).toEqual({ by: 'gor', stable: true });
        expect(isKnockedOut(tok('bandit'))).toBe(true);
        expect(text).toMatch(/knocked out by Gor/);
    });

    it('trigger_readied at a target already down: no swing, the reaction and the readied action are kept', async () => {
        await setup([gor({ subdue: true }), bandit({ hp: 0 })]);
        await manage({ action: 'set_intent', participantId: 'gor', readied: { action: 'club it', trigger: 'it moves', attack: { attackBonus: 40, damage: '1d1+10' } } });
        const { d } = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit' });
        expect(d.held).toBe(true);
        expect(d.writes).toBe('none');
        expect(String(d.message)).toMatch(/already down/);
        expect(tok('gor').reactionUsed).toBeFalsy();
        expect(tok('gor').readied.action).toBe('club it');
    });
});

describe('subdue: a ranged readied shot is settled when it is readied', () => {
    const readyCrossbow = (attack: Record<string, unknown> = {}) => act({ action: 'ready', actorId: 'gor', readiedAction: 'shoot the runner', trigger: 'he runs for the horn', on: 'enters_reach', watch: 'bandit', attack: { using: 'crossbow', ...attack } });

    it('combat_action ready of a ranged attack under the order is refused without onSubdue, naming both values; nothing is spent', async () => {
        await setup([gor({ subdue: true, attacks: [CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        const { d } = await readyCrossbow();
        expect(d.error).toBe(true);
        expect(d.writes).toBe('none');
        expect(String(d.message)).toMatch(/onSubdue/);
        expect(String(d.message)).toMatch(/'hold'/);
        expect(String(d.message)).toMatch(/'fire'/);
        expect(tok('gor').actionUsed).toBeFalsy();
        expect(tok('gor').readied).toBeUndefined();
    });

    it('set_intent readied with a ranged attack under the order is refused the same way', async () => {
        await setup([gor({ subdue: true, attacks: [CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        const { d } = await manage({ action: 'set_intent', participantId: 'gor', readied: { action: 'shoot', trigger: 'he runs', on: 'enters_reach', attack: { using: 'crossbow' } } });
        expect(d).toMatchObject({ error: true, writes: 'none' });
        expect(String(d.message)).toMatch(/onSubdue: 'hold'/);
        expect(tok('gor').readied).toBeUndefined();
    });

    it("onSubdue 'hold': the trigger fires and the token holds fire; the reaction is not spent and the shot stays readied", async () => {
        await setup([gor({ subdue: true, attacks: [CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        const ready = await readyCrossbow({ onSubdue: 'hold' });
        expect(ready.d.success).toBe(true);
        expect(tok('gor').readied.attack.onSubdue).toBe('hold');
        const { text, r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 1, y: 0 } });
        expect(r.readiedTriggered).toEqual([expect.objectContaining({ participantId: 'gor', fired: false, held: true })]);
        expect(text).toMatch(/held fire: subdue order; ranged can't be non-lethal/);
        expect(tok('gor').reactionUsed).toBeFalsy();
        expect(tok('gor').readied.attack.onSubdue).toBe('hold');
        expect(tok('bandit').hp).toBe(5);
    });

    it("onSubdue 'fire': the shot fires as an ordinary lethal attack, the reply and the log say subdue order overridden", async () => {
        await setup([gor({ subdue: true, attacks: [CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        await readyCrossbow({ onSubdue: 'fire' });
        const { text, r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 1, y: 0 } });
        expect(r.readiedTriggered[0]).toMatchObject({ participantId: 'gor', fired: true });
        expect(r.readiedTriggered[0].attack.knockedOut).toBeUndefined();
        expect(r.readiedTriggered[0].attack.subdue).toMatchObject({ mode: 'overridden' });
        expect(text).toMatch(/subdue order overridden/);
        expect(tok('bandit').hp).toBe(0);
        expect(isKnockedOut(tok('bandit'))).toBe(false);
        const log = getDb().prepare(`SELECT result_summary FROM combat_action_log WHERE action_type = 'trigger_readied'`).all() as any[];
        expect(log.map(l => l.result_summary).join(' ')).toMatch(/subdue order overridden/);
    });

    it('a ranged ready without the order needs no onSubdue', async () => {
        await setup([gor({ attacks: [CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        const { d } = await readyCrossbow();
        expect(d.success).toBe(true);
    });

    it('an order put on a token already holding a ranged shot is flagged; until answered the trigger holds; the answer is stored and then honoured', async () => {
        await setup([gor({ attacks: [CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        await readyCrossbow();
        const order = await manage({ action: 'set_subdue', participantId: 'gor', subdue: true });
        expect(order.d.success).toBe(true);
        expect(order.d.readiedNeedsOnSubdue).toMatchObject({ participantId: 'gor' });
        expect(order.text).toMatch(/onSubdue/);
        // Unanswered: the trigger holds.
        const { r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 1, y: 0 } });
        expect(r.readiedTriggered).toEqual([expect.objectContaining({ fired: false, held: true, awaitingOnSubdue: true })]);
        expect(tok('gor').reactionUsed).toBeFalsy();
        expect(tok('bandit').hp).toBe(5);
        // By hand before the answer: still held, nothing written.
        const held = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit' });
        expect(held.d).toMatchObject({ held: true, writes: 'none', awaitingOnSubdue: true });
        // The answer lands on the readied shot.
        const answer = await manage({ action: 'set_subdue', participantId: 'gor', onSubdue: 'fire' });
        expect(answer.d.success).toBe(true);
        expect(answer.d.readiedNeedsOnSubdue).toBeUndefined();
        expect(tok('gor').subdue).toBe(true);
        expect(tok('gor').readied.attack).toMatchObject({ using: 'crossbow', onSubdue: 'fire' });
        const fired = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit' });
        expect(fired.d.success).toBe(true);
        expect(fired.d.attack.subdue).toMatchObject({ mode: 'overridden' });
        expect(tok('gor').reactionUsed).toBe(true);
    });

    it('a free-text readied action fired by hand with a ranged attack holds until the call itself names onSubdue', async () => {
        await setup([gor({ subdue: true, attacks: [CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        await manage({ action: 'set_intent', participantId: 'gor', readied: { action: 'shoot whoever runs', trigger: 'someone runs' } });
        const held = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit', attack: { using: 'crossbow' } });
        expect(held.d).toMatchObject({ held: true, writes: 'none', awaitingOnSubdue: true });
        expect(String(held.d.message)).toMatch(/onSubdue: 'hold' \| 'fire'\} on this call/);
        expect(tok('gor').reactionUsed).toBeFalsy();
        const fired = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit', attack: { using: 'crossbow', onSubdue: 'fire' } });
        expect(fired.d.success).toBe(true);
        expect(fired.d.attack.subdue).toMatchObject({ mode: 'overridden' });
    });

    it('the state view marks readied lines under the order', async () => {
        await setup([gor({ subdue: true, attacks: [CROSSBOW, SPEAR], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        await readyCrossbow({ onSubdue: 'hold' });
        expect((await manage({ action: 'get' })).text).toMatch(/⏳ readied: shoot the runner when he runs for the horn \(hold if ranged\)/);
        await manage({ action: 'set_intent', participantId: 'gor', readied: { action: 'spear him', trigger: 'he closes', on: 'enters_reach', attack: { using: 'spear' } } });
        expect((await manage({ action: 'get' })).text).toMatch(/⏳ readied: spear him when he closes \(non-lethal\)/);
    });
});

describe('review: every way to answer a held shot', () => {
    // The spear is the token's default profile and much weaker, so a shot that
    // lost its stored weapon would show +1 instead of the crossbow's +40.
    const WEAK_SPEAR = { name: 'spear', attackBonus: 1, damage: '1d1', damageType: 'piercing', default: true };

    it("trigger_readied {attack: {onSubdue: 'fire'}} answers for the stored shot: the stored crossbow fires, not a bare default attack", async () => {
        await setup([gor({ attacks: [WEAK_SPEAR, CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ hp: 50, maxHp: 50, position: { x: 4, y: 0 } })]);
        await act({ action: 'ready', actorId: 'gor', readiedAction: 'shoot the runner', trigger: 'he runs', attack: { using: 'crossbow' } });
        await manage({ action: 'set_subdue', participantId: 'gor', subdue: true });
        const held = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit' });
        expect(held.d).toMatchObject({ held: true, awaitingOnSubdue: true });
        expect(String(held.d.message)).toMatch(/attack: \{onSubdue: 'hold' \| 'fire'\} on this call/);
        const fired = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit', attack: { onSubdue: 'fire' } });
        expect(fired.d.success).toBe(true);
        expect(fired.d.attack.subdue).toMatchObject({ mode: 'overridden' });
        expect(fired.d.attack.total - fired.d.attack.roll).toBe(40);
    });

    it("trigger_readied {attack: {onSubdue: 'hold'}} holds the stored shot without asking again", async () => {
        await setup([gor({ attacks: [WEAK_SPEAR, CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        await act({ action: 'ready', actorId: 'gor', readiedAction: 'shoot', trigger: 'he runs', attack: { using: 'crossbow' } });
        await manage({ action: 'set_subdue', participantId: 'gor', subdue: true });
        const held = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit', attack: { onSubdue: 'hold' } });
        expect(held.d).toMatchObject({ held: true, writes: 'none' });
        expect(held.d.awaitingOnSubdue).toBeUndefined();
        expect(tok('gor').reactionUsed).toBeFalsy();
        expect(tok('gor').readied.attack.using).toBe('crossbow');
    });

    it('trigger_readied {attack: {}} keeps the stored shot and the onSubdue settled at ready time', async () => {
        await setup([gor({ subdue: true, attacks: [WEAK_SPEAR, CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ hp: 50, maxHp: 50, position: { x: 4, y: 0 } })]);
        await act({ action: 'ready', actorId: 'gor', readiedAction: 'shoot', trigger: 'he runs', attack: { using: 'crossbow', onSubdue: 'fire' } });
        const fired = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit', attack: {} });
        expect(fired.d.success).toBe(true);
        expect(fired.d.attack.subdue).toMatchObject({ mode: 'overridden' });
        expect(fired.d.attack.total - fired.d.attack.roll).toBe(40);
    });

    it('set_subdue {onSubdue} on a token holding no readied attack (and no order change) is refused with nothing written', async () => {
        await setup([gor(), bandit()]);
        const { d } = await manage({ action: 'set_subdue', participantId: 'gor', onSubdue: 'hold' });
        expect(d).toMatchObject({ error: true, writes: 'none' });
        expect(String(d.message)).toMatch(/no readied attack/);
        const history = getDb().prepare(`SELECT COUNT(*) AS n FROM combat_action_log WHERE action_type = 'set_subdue'`).get() as { n: number };
        expect(history.n).toBe(0);
        // With the order itself it still lands, and says the answer had nowhere to go.
        const both = await manage({ action: 'set_subdue', participantId: 'gor', subdue: true, onSubdue: 'hold' });
        expect(both.d.success).toBe(true);
        expect(tok('gor').subdue).toBe(true);
    });
});
