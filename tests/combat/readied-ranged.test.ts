import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { isKnockedOut } from '../../src/engine/combat/nonlethal.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 7, lane G2 (b): a readied attack could be ranged only through a
 * named profile. ReadiedAttackSchema had no `ranged` key, so
 * ready {attack: {attackBonus, damage, ranged: true}} lost the flag: the
 * ready-time subdue refusal never fired (owner, item 5: "The conflict should
 * be settled when the shot is readied, not when the trigger fires") and at
 * fire time the lane fell back to the grid. Now attack.ranged is stored on
 * the readied action and read at ready time (the refusal) and at fire time
 * (before the profile and the grid); an explicit flag that disagrees with
 * its named profile wins and says so.
 */

const ctx = { sessionId: 'readied-ranged' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manage = async (args: Record<string, unknown>) => {
    const text = (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    return { text, d: tag(text, 'COMBAT_MANAGE') ?? {} };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION') ?? {};
    return { text, d, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;

async function setup(participants: any[], opts: { npc?: string[] } = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    for (const id of opts.npc ?? []) {
        new CharacterRepository(db).create({ id, name: id, characterType: 'npc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 5, maxHp: 5, ac: 10, level: 1, createdAt: now, updatedAt: now } as any);
    }
    enc = tag((await handleCombatManage({ action: 'create', seed: 'readied-ranged', participants }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
}

// Grak at (0,0); the runner starts four squares off and walks in to (1,0),
// entering Grak's reach. Adjacent at the trigger, so the grid alone would
// call the shot melee: only the stored flag makes it ranged.
const grak = (extra: Record<string, unknown> = {}) => ({ id: 'grak', name: 'Grak', hp: 20, maxHp: 20, ac: 12, initiative: 20, position: { x: 0, y: 0 }, ...extra });
const runner = (extra: Record<string, unknown> = {}) => ({ id: 'runner', name: 'Runner', hp: 5, maxHp: 5, ac: 10, initiative: 10, isEnemy: true, position: { x: 4, y: 0 }, ...extra });
const CROSSBOW = { name: 'crossbow', attackBonus: 40, damage: '1d1+10', damageType: 'piercing', ranged: true };
const SPEAR = { name: 'spear', attackBonus: 40, damage: '1d1+10', damageType: 'piercing' };
const BOLT = { attackBonus: 40, damage: '1d1+10', damageType: 'piercing', ranged: true };
const readyShot = (attack: Record<string, unknown>) => act({ action: 'ready', actorId: 'grak', readiedAction: 'shoot the runner', trigger: 'he runs for the horn', on: 'enters_reach', watch: 'runner', attack });
const runIn = () => act({ action: 'move', actorId: 'runner', targetPosition: { x: 1, y: 0 } });

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('attack.ranged at ready time', () => {
    it('ready {attack: {attackBonus, damage, ranged: true}} under a subdue order is refused without onSubdue, naming both values; nothing is written', async () => {
        await setup([grak({ subdue: true }), runner()]);
        const { d } = await readyShot(BOLT);
        expect(d).toMatchObject({ error: true, writes: 'none' });
        expect(String(d.message)).toMatch(/attack\.ranged: true/);
        expect(String(d.message)).toMatch(/onSubdue: 'hold'/);
        expect(String(d.message)).toMatch(/onSubdue: 'fire'/);
        expect(tok('grak').readied).toBeUndefined();
        expect(tok('grak').actionUsed).toBeFalsy();
    });

    it("accepted with onSubdue 'hold': the flag is stored on the readied attack", async () => {
        await setup([grak({ subdue: true }), runner()]);
        const { d } = await readyShot({ ...BOLT, onSubdue: 'hold' });
        expect(d.success).toBe(true);
        expect(d.readied.attack).toMatchObject({ ranged: true, onSubdue: 'hold' });
        expect(tok('grak').readied.attack).toMatchObject({ ranged: true, onSubdue: 'hold' });
    });

    it('set_intent readied {attack: {…, ranged: true}} under the order is refused the same way', async () => {
        await setup([grak({ subdue: true }), runner()]);
        const { d } = await manage({ action: 'set_intent', participantId: 'grak', readied: { action: 'shoot', trigger: 'he runs', on: 'enters_reach', attack: BOLT } });
        expect(d).toMatchObject({ error: true, writes: 'none' });
        expect(String(d.message)).toMatch(/onSubdue: 'hold'/);
        expect(tok('grak').readied).toBeUndefined();
        const ok = await manage({ action: 'set_intent', participantId: 'grak', readied: { action: 'shoot', trigger: 'he runs', on: 'enters_reach', attack: { ...BOLT, onSubdue: 'fire' } } });
        expect(ok.d.success).toBe(true);
        expect(tok('grak').readied.attack).toMatchObject({ ranged: true, onSubdue: 'fire' });
    });

    it('ranged: true over a melee profile follows the flag (refused under the order) and says so once answered', async () => {
        await setup([grak({ subdue: true, attacks: [SPEAR] }), runner()]);
        const refused = await readyShot({ using: 'spear', ranged: true });
        expect(refused.d).toMatchObject({ error: true, writes: 'none' });
        const { d } = await readyShot({ using: 'spear', ranged: true, onSubdue: 'fire' });
        expect(d.success).toBe(true);
        expect(d.rangedOverride).toMatchObject({ profile: 'spear', ranged: true });
        expect(String(d.rangedOverride.note)).toMatch(/attack\.ranged: true overrides the spear profile/);
        expect(String(d.message)).toMatch(/overrides the spear profile/);
    });

    it('ranged: false over a crossbow profile follows the flag: no refusal under the order, and the swing is non-lethal when it fires', async () => {
        await setup([grak({ subdue: true, attacks: [CROSSBOW] }), runner()], { npc: ['runner'] });
        const { d } = await readyShot({ using: 'crossbow', ranged: false });
        expect(d.success).toBe(true);
        expect(String(d.rangedOverride.note)).toMatch(/attack\.ranged: false overrides the crossbow profile \(ranged\)/);
        const { r } = await runIn();
        expect(r.readiedTriggered[0]).toMatchObject({ fired: true });
        expect(r.readiedTriggered[0].attack.knockedOut).toEqual({ by: 'grak', stable: true });
        expect(isKnockedOut(tok('runner'))).toBe(true);
    });

    it('a flag that agrees with its profile needs no note', async () => {
        await setup([grak({ attacks: [CROSSBOW] }), runner()]);
        const { d } = await readyShot({ using: 'crossbow', ranged: true });
        expect(d.success).toBe(true);
        expect(d.rangedOverride).toBeUndefined();
    });

    it('set_subdue on a token already holding a ranged: true readied attack (no profile) flags it and asks for onSubdue', async () => {
        await setup([grak(), runner()]);
        expect((await readyShot(BOLT)).d.success).toBe(true);
        const order = await manage({ action: 'set_subdue', participantId: 'grak', subdue: true });
        expect(order.d.readiedNeedsOnSubdue).toMatchObject({ participantId: 'grak' });
        const { r } = await runIn();
        expect(r.readiedTriggered).toEqual([expect.objectContaining({ fired: false, held: true, awaitingOnSubdue: true })]);
        expect(tok('runner').hp).toBe(5);
    });
});

describe('attack.ranged at fire time, before the profile and the grid', () => {
    it("held at fire time with the reaction kept, though the grid reads the adjacent runner as melee", async () => {
        await setup([grak({ subdue: true }), runner()]);
        await readyShot({ ...BOLT, onSubdue: 'hold' });
        const { text, r } = await runIn();
        expect(r.readiedTriggered).toEqual([expect.objectContaining({ participantId: 'grak', fired: false, held: true })]);
        expect(text).toMatch(/held fire: subdue order; ranged can't be non-lethal/);
        expect(tok('grak').reactionUsed).toBeFalsy();
        expect(tok('grak').readied.attack).toMatchObject({ ranged: true, onSubdue: 'hold' });
        expect(tok('runner').hp).toBe(5);
    });

    it('ranged survives a new process: the stored flag still holds the shot after a reload', async () => {
        await setup([grak({ subdue: true }), runner()]);
        await readyShot({ ...BOLT, onSubdue: 'hold' });
        clearCombatState();
        expect(tok('grak').readied.attack).toMatchObject({ ranged: true, onSubdue: 'hold' });
        const { r } = await runIn();
        expect(r.readiedTriggered).toEqual([expect.objectContaining({ fired: false, held: true })]);
        expect(tok('grak').reactionUsed).toBeFalsy();
    });

    it("onSubdue 'fire' with ranged: true fires lethally (subdue order overridden), not as a non-lethal swing", async () => {
        await setup([grak({ subdue: true }), runner()], { npc: ['runner'] });
        await readyShot({ ...BOLT, onSubdue: 'fire' });
        const { r } = await runIn();
        expect(r.readiedTriggered[0].attack.subdue).toMatchObject({ mode: 'overridden' });
        expect(r.readiedTriggered[0].attack.knockedOut).toBeUndefined();
        expect(isKnockedOut(tok('runner'))).toBe(false);
    });

    it('ranged: true over a melee profile fires as a shot and the breakdown says the flag won', async () => {
        await setup([grak({ subdue: true, attacks: [SPEAR] }), runner()]);
        await readyShot({ using: 'spear', ranged: true, onSubdue: 'hold' });
        const { r } = await runIn();
        expect(r.readiedTriggered[0]).toMatchObject({ fired: false, held: true });
        await manage({ action: 'set_subdue', participantId: 'grak', subdue: false });
        const fired = await manage({ action: 'trigger_readied', participantId: 'grak', targetId: 'runner' });
        expect(fired.d.success).toBe(true);
        expect((fired.d.attack.situational ?? []).join(' ')).toMatch(/attack\.ranged: true overrides the spear profile/);
    });

    it('trigger_readied by hand with attack {…, ranged: true} on a free-text readied action holds until the call names onSubdue', async () => {
        await setup([grak({ subdue: true }), runner()]);
        await manage({ action: 'set_intent', participantId: 'grak', readied: { action: 'shoot whoever runs', trigger: 'someone runs' } });
        const held = await manage({ action: 'trigger_readied', participantId: 'grak', targetId: 'runner', attack: BOLT });
        expect(held.d).toMatchObject({ held: true, writes: 'none', awaitingOnSubdue: true });
        expect(tok('grak').reactionUsed).toBeFalsy();
    });

    it('trigger_readied {attack: {ranged: true}} amends the stored shot: the stored weapon fires as a shot', async () => {
        await setup([grak({ subdue: true, attacks: [{ ...SPEAR, attackBonus: 1, default: true }, { name: 'javelin', attackBonus: 40, damage: '1d1+10', damageType: 'piercing' }] }), runner({ hp: 50, maxHp: 50 })]);
        await manage({ action: 'set_intent', participantId: 'grak', readied: { action: 'throw', trigger: 'he runs', attack: { using: 'javelin', onSubdue: 'fire' } } });
        const fired = await manage({ action: 'trigger_readied', participantId: 'grak', targetId: 'runner', attack: { ranged: true } });
        expect(fired.d.success).toBe(true);
        expect(fired.d.attack.total - fired.d.attack.roll).toBe(40);
        expect(fired.d.attack.subdue).toMatchObject({ mode: 'overridden' });
    });
});

describe('the state view shows the flag', () => {
    it("the readied line reads [ranged] (and [melee] for ranged: false)", async () => {
        await setup([grak({ subdue: true }), runner()]);
        await readyShot({ ...BOLT, onSubdue: 'hold' });
        const view = await manage({ action: 'get' });
        expect(view.text).toMatch(/⏳ readied: shoot the runner when he runs for the horn \[ranged\] \(hold if ranged\)/);
        expect(view.d.participants.find((p: any) => p.id === 'grak').readied.attack.ranged).toBe(true);
        await manage({ action: 'set_intent', participantId: 'grak', readied: { action: 'club him', trigger: 'he closes', on: 'enters_reach', attack: { attackBonus: 4, damage: '1d6', ranged: false } } });
        expect((await manage({ action: 'get' })).text).toMatch(/⏳ readied: club him when he closes \[melee\] \(non-lethal\)/);
    });
});

/**
 * Lane G2 review. (1) The ready-time refusal's call to paste was
 * attack: {onSubdue: 'hold' | 'fire'} (plus using when given): for a shot
 * made ranged by its own flag it dropped ranged: true and the attack's
 * numbers, so the pasted call readied a bare melee swing that no longer
 * needed onSubdue. (2) A key the readied attack does not take (a misspelt
 * ranged) was stripped in silence, so under a subdue order the ready-time
 * refusal never fired and nothing said why. (3) At fire time the flag's
 * override of its profile lived only in situational, which summary collapses.
 */
describe('lane G2 review', () => {
    it("the refusal's call to paste carries the readied attack itself, its ranged flag included (ready and set_intent)", async () => {
        await setup([grak({ subdue: true }), runner()]);
        const { d } = await readyShot(BOLT);
        expect(d).toMatchObject({ error: true, writes: 'none' });
        expect(String(d.message)).toContain("attack: {attackBonus: 40, damage: '1d1+10', damageType: 'piercing', ranged: true, onSubdue: 'hold' | 'fire'}");
        const s = await manage({ action: 'set_intent', participantId: 'grak', readied: { action: 'shoot', trigger: 'he runs', attack: BOLT } });
        expect(s.d).toMatchObject({ error: true, writes: 'none' });
        expect(String(s.d.message)).toContain("attack: {attackBonus: 40, damage: '1d1+10', damageType: 'piercing', ranged: true, onSubdue: 'hold' | 'fire'}");
    });

    it("a profile-named shot's paste still names its profile", async () => {
        await setup([grak({ subdue: true, attacks: [CROSSBOW] }), runner()]);
        const { d } = await readyShot({ using: 'crossbow' });
        expect(String(d.message)).toContain("attack: {using: 'crossbow', onSubdue: 'hold' | 'fire'}");
    });

    it('ready: a key the readied attack does not take is named in ignoredParams with the nearest valid key, and never stored', async () => {
        await setup([grak({ subdue: true }), runner()]);
        const { d, text } = await readyShot({ attackBonus: 40, damage: '1d1+10', rnaged: true });
        expect(d.success).toBe(true);
        expect(d.ignoredParams).toEqual(['attack.rnaged']);
        expect(String(d.message)).toMatch(/attack\.rnaged — nearest valid key 'ranged'/);
        expect(text).toMatch(/attack\.rnaged/);
        expect(tok('grak').readied.attack).toEqual({ attackBonus: 40, damage: '1d1+10' });
    });

    it('set_intent: a key inside readied.attack it does not take is named, and never stored', async () => {
        await setup([grak(), runner()]);
        const { d } = await manage({ action: 'set_intent', participantId: 'grak', readied: { action: 'shoot', trigger: 'he runs', attack: { attackBonus: 40, damage: '1d1+10', isRanged: true } } });
        expect(d.success).toBe(true);
        expect(d.ignoredParams).toEqual(['readied.attack.isRanged']);
        expect(String(d.message)).toMatch(/readied\.attack\.isRanged/);
        expect(tok('grak').readied.attack).toEqual({ attackBonus: 40, damage: '1d1+10' });
    });

    it('trigger_readied: a key the attack does not take is named; an amendment carrying one still amends the stored shot', async () => {
        await setup([grak({ attacks: [{ ...SPEAR, attackBonus: 1, default: true }, { name: 'javelin', attackBonus: 40, damage: '1d1+10', damageType: 'piercing' }] }), runner({ hp: 50, maxHp: 50 })]);
        await manage({ action: 'set_intent', participantId: 'grak', readied: { action: 'throw', trigger: 'he runs', attack: { using: 'javelin' } } });
        const fired = await manage({ action: 'trigger_readied', participantId: 'grak', targetId: 'runner', attack: { ranged: true, rnaged: true } });
        expect(fired.d.success).toBe(true);
        expect(fired.d.ignoredParams).toEqual(['attack.rnaged']);
        // The stored javelin fired (its +40), as a shot.
        expect(fired.d.attack.total - fired.d.attack.roll).toBe(40);
    });

    it('a fired shot whose flag overrode its profile says so on its reaction line (move and trigger_readied)', async () => {
        await setup([grak({ attacks: [SPEAR] }), runner({ hp: 50, maxHp: 50 })]);
        await readyShot({ using: 'spear', ranged: true });
        const { d } = await runIn();
        expect(d.reactionLines).toEqual([expect.stringMatching(/^⏳ Grak → Runner: readied .*; attack\.ranged: true overrides the spear profile$/)]);
        await setup([grak({ attacks: [SPEAR] }), runner({ hp: 50, maxHp: 50 })]);
        await manage({ action: 'set_intent', participantId: 'grak', readied: { action: 'throw', trigger: 'he runs', attack: { using: 'spear', ranged: true } } });
        const fired = await manage({ action: 'trigger_readied', participantId: 'grak', targetId: 'runner' });
        expect(fired.d.rangedOverride).toMatchObject({ profile: 'spear', ranged: true });
        expect(fired.d.reactionLines).toEqual([expect.stringMatching(/; attack\.ranged: true overrides the spear profile$/)]);
    });

    it('trigger_readied held on a ranged flag passed in this call: the answer to paste carries the flag', async () => {
        await setup([grak({ subdue: true, attacks: [SPEAR] }), runner()]);
        await manage({ action: 'set_intent', participantId: 'grak', readied: { action: 'throw', trigger: 'he runs', attack: { using: 'spear' } } });
        const held = await manage({ action: 'trigger_readied', participantId: 'grak', targetId: 'runner', attack: { ranged: true } });
        expect(held.d).toMatchObject({ held: true, writes: 'none', awaitingOnSubdue: true });
        expect(String(held.d.message)).toContain("attack: {ranged: true, onSubdue: 'hold' | 'fire'}");
        expect(held.d.reactionLines).toEqual([expect.stringContaining("attack: {ranged: true, onSubdue: 'hold' | 'fire'}")]);
    });

    it('trigger_readied held on a free-text readied action: the answer is this call again with onSubdue, not set_subdue (which has no stored shot and refuses)', async () => {
        await setup([grak({ subdue: true }), runner()]);
        await manage({ action: 'set_intent', participantId: 'grak', readied: { action: 'shoot whoever runs', trigger: 'someone runs' } });
        const held = await manage({ action: 'trigger_readied', participantId: 'grak', targetId: 'runner', attack: BOLT });
        expect(held.d).toMatchObject({ held: true, writes: 'none', awaitingOnSubdue: true });
        const paste = "combat_manage trigger_readied {encounterId: '" + enc + "', participantId: 'grak', targetId: 'runner', attack: {attackBonus: 40, damage: '1d1+10', damageType: 'piercing', ranged: true, onSubdue: 'hold' | 'fire'}}";
        expect(held.d.reactionLines).toEqual([expect.stringContaining(paste)]);
        expect(held.d.answer).toMatchObject({ action: 'trigger_readied', targetId: 'runner', attack: { ranged: true } });
        expect(String(held.d.message)).toContain(paste);
        // What the line used to name: refused, since no attack is stored to take the answer.
        const setSubdue = await manage({ action: 'set_subdue', participantId: 'grak', onSubdue: 'hold' });
        expect(setSubdue.d).toMatchObject({ error: true, writes: 'none' });
        const fired = await manage({ action: 'trigger_readied', participantId: 'grak', targetId: 'runner', attack: { ...BOLT, onSubdue: 'fire' } });
        expect(fired.d.attack.subdue).toMatchObject({ mode: 'overridden' });
    });
});
