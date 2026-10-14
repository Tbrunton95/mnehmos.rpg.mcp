import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { summarizeResult } from '../../src/server/output-mode.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 7, lane G2 (a): output_mode 'summary' collapsed a move's
 * opportunityAttacks / readiedTriggered rows to id handles, so a knockout,
 * a held shot, an override, a hit and its damage, or a rider struck survived
 * only inside the first 300 characters of rawText. Every reply that resolves
 * reactions now carries a top-level reactionLines: string[] — one short,
 * complete line per reaction — which summary keeps whole (as unitLines).
 * The JSON rows stay as they are.
 */

const ctx = { sessionId: 'reaction-lines' };
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

async function setup(participants: any[], opts: { pc?: string[]; npc?: string[] } = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    const rows = [...(opts.pc ?? []).map(id => [id, 'pc']), ...(opts.npc ?? []).map(id => [id, 'npc'])];
    for (const [id, characterType] of rows) {
        new CharacterRepository(db).create({ id, name: id === 'gor' ? 'Gor' : id, characterType, stats: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }, hp: 5, maxHp: 5, ac: 10, level: 3, createdAt: now, updatedAt: now } as any);
    }
    const created = tag((await handleCombatManage({ action: 'create', seed: 'subdue', participants }, ctx as any)).content[0].text, 'COMBAT_MANAGE');
    enc = created.encounterId;
}

// Gor at (0,0) with a +40 swing; the bandit starts adjacent and walks east,
// leaving Gor's reach at its first step.
const gor = (extra: Record<string, unknown> = {}) => ({ id: 'gor', name: 'Gor', hp: 40, maxHp: 40, ac: 14, initiative: 20, position: { x: 0, y: 0 }, attackBonus: 40, attackDamage: '1d1+10', attackDamageType: 'bludgeoning', ...extra });
const bandit = (extra: Record<string, unknown> = {}) => ({ id: 'bandit', name: 'Bandit', hp: 5, maxHp: 5, ac: 10, initiative: 10, isEnemy: true, position: { x: 1, y: 0 }, ...extra });
const CROSSBOW = { name: 'crossbow', attackBonus: 40, damage: '1d1+10', damageType: 'piercing', ranged: true };
const SPEAR = { name: 'spear', attackBonus: 40, damage: '1d1+10', damageType: 'piercing' };

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('reactionLines on combat_action move', () => {
    it('an opportunity attack that knocks out under the subdue order: one line, the hit, the damage and the knockout', async () => {
        await setup([gor({ subdue: true }), bandit()], { npc: ['bandit'] });
        const { d, r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 5, y: 0 } });
        expect(r.opportunityAttacks).toHaveLength(1);
        const total = r.opportunityAttacks[0].total;
        expect(d.reactionLines).toEqual([`⚡ Gor → Bandit: OA hit ${total} vs AC 10, 11 bludgeoning, knocked out (subdue)`]);
    });

    it('a plain opportunity attack hit names the damage and the HP left; the JSON rows stay as they were', async () => {
        await setup([gor({ attackDamage: '1d1' }), bandit()]);
        const { d, r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 5, y: 0 } });
        const oa = r.opportunityAttacks[0];
        expect(oa).toMatchObject({ attackerId: 'gor', attackerName: 'Gor', hit: true, damage: 1, targetHpAfter: 4 });
        expect(d.reactionLines).toEqual([`⚡ Gor → Bandit: OA hit ${oa.total} vs AC 10, 1 bludgeoning (HP 4)`]);
    });

    it('a miss says miss, with the total against the AC', async () => {
        await setup([gor({ attackBonus: -30 }), bandit()]);
        const { d, r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 5, y: 0 } });
        const oa = r.opportunityAttacks[0];
        expect(oa.hit).toBe(false);
        expect(d.reactionLines).toEqual([`⚡ Gor → Bandit: OA miss ${oa.total} vs AC 10`]);
    });

    it('a natural 1 says so, since its total can beat the AC', async () => {
        const { rolledReactionLine } = await import('../../src/engine/combat/reaction-lines.js');
        expect(rolledReactionLine('OA', 'Gor', { name: 'Bandit' }, { roll: 1, total: 41, targetAc: 10, hit: false })).toBe('⚡ Gor → Bandit: OA miss (nat 1) 41 vs AC 10');
        expect(rolledReactionLine('readied', 'Gor', { name: 'Bandit' }, { roll: 20, total: 60, targetAc: 10, hit: true, crit: true, damage: 22, damageType: 'piercing', targetHpAfter: 0 }, { killed: true })).toBe('⏳ Gor → Bandit: readied CRIT 60 vs AC 10, 22 piercing, killed');
    });

    it('a PC reactor is offered the swing: the line carries the exact call to paste (non-lethal under the order)', async () => {
        await setup([gor({ subdue: true }), bandit()], { pc: ['gor'] });
        const { d } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 5, y: 0 } });
        expect(d.reactionLines).toHaveLength(1);
        const line = d.reactionLines[0] as string;
        expect(line).toMatch(/^⚡ Gor may strike Bandit/);
        expect(line).toContain(`combat_action attack {encounterId: '${enc}', actorId: 'gor', targetId: 'bandit', reaction: true, nonlethal: true, ranged: false}`);
        expect(line).toMatch(/player decides/);
    });

    it('a subdued reactor holding its swing at a mover already down says so, reaction kept', async () => {
        await setup([gor({ subdue: true }), bandit({ hp: 0 })]);
        const { d } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 5, y: 0 } });
        expect(d.reactionLines).toEqual(['⏸ Gor does not strike Bandit: already down (subdue order; reaction kept)']);
    });

    it("a held readied shot (onSubdue 'hold'): '⏸ … holds fire: subdue order; ranged can't be non-lethal (reaction kept)'", async () => {
        await setup([gor({ subdue: true, attacks: [CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        expect((await act({ action: 'ready', actorId: 'gor', readiedAction: 'shoot the runner', trigger: 'he runs', on: 'enters_reach', watch: 'bandit', attack: { using: 'crossbow', onSubdue: 'hold' } })).d.success).toBe(true);
        const { d } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 1, y: 0 } });
        expect(d.reactionLines).toEqual(["⏸ Gor holds fire: subdue order; ranged can't be non-lethal (reaction kept)"]);
    });

    it('an unanswered onSubdue holds and the line names the answer to paste', async () => {
        await setup([gor({ attacks: [CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        await act({ action: 'ready', actorId: 'gor', readiedAction: 'shoot', trigger: 'he runs', on: 'enters_reach', watch: 'bandit', attack: { using: 'crossbow' } });
        await manage({ action: 'set_subdue', participantId: 'gor', subdue: true });
        const { d } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 1, y: 0 } });
        expect(d.reactionLines).toHaveLength(1);
        expect(d.reactionLines[0]).toMatch(/^⏸ Gor holds fire: subdue order; ranged can't be non-lethal \(reaction kept\); onSubdue unanswered: /);
        expect(d.reactionLines[0]).toContain(`combat_manage set_subdue {encounterId: '${enc}', participantId: 'gor', onSubdue: 'hold' | 'fire'}`);
    });

    it("an overridden order (onSubdue 'fire'): the readied shot's hit, damage and 'subdue order overridden'", async () => {
        await setup([gor({ subdue: true, attacks: [CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })], { npc: ['bandit'] });
        await act({ action: 'ready', actorId: 'gor', readiedAction: 'shoot', trigger: 'he runs', on: 'enters_reach', watch: 'bandit', attack: { using: 'crossbow', onSubdue: 'fire' } });
        const { d, r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 1, y: 0 } });
        const total = r.readiedTriggered[0].attack.total;
        expect(d.reactionLines).toHaveLength(1);
        expect(d.reactionLines[0]).toMatch(new RegExp(`^⏳ Gor → Bandit: readied hit ${total} vs AC 10, 11 piercing, (killed|drops \\(0 HP\\)); subdue order overridden$`));
    });

    it('a readied melee swing that knocks out under the order', async () => {
        await setup([gor({ subdue: true, attacks: [SPEAR], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })], { npc: ['bandit'] });
        await manage({ action: 'set_intent', participantId: 'gor', readied: { action: 'club him', trigger: 'he closes', on: 'enters_reach', watch: 'bandit', attack: { using: 'spear' } } });
        const { d, r } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 1, y: 0 } });
        expect(d.reactionLines).toEqual([`⏳ Gor → Bandit: readied hit ${r.readiedTriggered[0].attack.total} vs AC 10, 11 piercing, knocked out (subdue)`]);
    });

    it('a readied action with no attack is flagged with the trigger_readied call', async () => {
        await setup([gor(), bandit({ position: { x: 4, y: 0 } })]);
        await manage({ action: 'set_intent', participantId: 'gor', readied: { action: 'shout the alarm', trigger: 'he closes', on: 'enters_reach', watch: 'bandit' } });
        const { d } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 1, y: 0 } });
        expect(d.reactionLines).toEqual([`⏳ Gor's readied action triggers (shout the alarm): combat_manage trigger_readied {encounterId: '${enc}', participantId: 'gor'}`]);
    });

    it('a move that provokes nothing carries no reactionLines', async () => {
        await setup([gor(), bandit({ position: { x: 6, y: 6 } })]);
        const { d } = await act({ action: 'move', actorId: 'bandit', targetPosition: { x: 8, y: 6 } });
        expect(d.actionResult.success).toBe(true);
        expect(d.reactionLines).toBeUndefined();
    });
});

describe('reactionLines on a controlled mount carrying its rider', () => {
    const kael = { id: 'kael', name: 'Kael', hp: 30, maxHp: 30, ac: 16, initiative: 20, position: { x: 0, y: 0 } };
    const horse = { id: 'horse', name: 'Warhorse', hp: 19, maxHp: 19, ac: 11, initiative: 15, size: 'large', movementSpeed: 60, position: { x: 1, y: 0 } };
    const orc = (extra: Record<string, unknown> = {}) => ({ id: 'orc', name: 'Orc', hp: 15, maxHp: 15, ac: 13, initiative: 10, isEnemy: true, attackBonus: 40, attackDamage: '1d1+2', attackDamageType: 'slashing', ...extra });

    it('the opportunity attack strikes the rider by default and the line says the mount could have been chosen', async () => {
        await setup([kael, horse, orc({ position: { x: 3, y: 2 } })]);
        await manage({ action: 'mount', riderId: 'kael', mountId: 'horse', free: true });
        const { d, r } = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 8, y: 0 } });
        expect(r.opportunityAttacks).toHaveLength(1);
        expect(d.reactionLines).toEqual([`⚡ Orc → Kael (riding Warhorse; could strike the mount): OA hit ${r.opportunityAttacks[0].total} vs AC 16, 3 slashing (HP 27)`]);
    });

    it('a readied attack watching the rider strikes the rider, and the line says so', async () => {
        await setup([kael, horse, orc({ position: { x: 9, y: 0 } })]);
        await manage({ action: 'mount', riderId: 'kael', mountId: 'horse', free: true });
        await manage({ action: 'set_intent', participantId: 'orc', readied: { action: 'stab the rider', trigger: 'Kael comes close', on: 'enters_reach', watch: 'kael', attack: { attackBonus: 40, damage: '1d1+1', damageType: 'piercing' } } });
        const { d, r } = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 7, y: 0 } });
        expect(d.reactionLines).toEqual([`⏳ Orc → Kael (riding Warhorse): readied hit ${r.readiedTriggered[0].attack.total} vs AC 16, 2 piercing (HP 28)`]);
    });
});

describe('reactionLines on dash {targetPosition} and trigger_readied', () => {
    it('dash {targetPosition} carries the move\'s reactionLines at the top of its reply', async () => {
        await setup([gor({ subdue: true }), bandit()], { npc: ['bandit'] });
        await manage({ action: 'advance' });
        const { d } = await act({ action: 'dash', actorId: 'bandit', targetPosition: { x: 9, y: 0 } });
        expect(d.success).toBe(true);
        expect(d.move.opportunityAttacks).toHaveLength(1);
        expect(d.reactionLines).toEqual([expect.stringMatching(/^⚡ Gor → Bandit: OA hit \d+ vs AC 10, 11 bludgeoning, knocked out \(subdue\)$/)]);
    });

    it('trigger_readied: a fired readied attack has its line', async () => {
        await setup([gor({ subdue: true }), bandit()], { npc: ['bandit'] });
        await manage({ action: 'set_intent', participantId: 'gor', readied: { action: 'club it', trigger: 'it moves', attack: { attackBonus: 40, damage: '1d1+10', damageType: 'bludgeoning' } } });
        const { d } = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit' });
        expect(d.success).toBe(true);
        expect(d.reactionLines).toEqual([`⏳ Gor → Bandit: readied hit ${d.attack.total} vs AC 10, 11 bludgeoning, knocked out (subdue)`]);
    });

    it('trigger_readied: a held shot has its line, and nothing is written', async () => {
        await setup([gor({ subdue: true, attacks: [CROSSBOW], attackBonus: undefined, attackDamage: undefined }), bandit({ position: { x: 4, y: 0 } })]);
        await act({ action: 'ready', actorId: 'gor', readiedAction: 'shoot', trigger: 'he runs', attack: { using: 'crossbow', onSubdue: 'hold' } });
        const { d } = await manage({ action: 'trigger_readied', participantId: 'gor', targetId: 'bandit' });
        expect(d).toMatchObject({ held: true, writes: 'none' });
        expect(d.reactionLines).toEqual(["⏸ Gor holds fire: subdue order; ranged can't be non-lethal (reaction kept)"]);
        expect(tok('gor').reactionUsed).toBeFalsy();
    });

    it('trigger_readied with no attack: the line says the action fired and the reaction is spent', async () => {
        await setup([gor(), bandit()]);
        await manage({ action: 'set_intent', participantId: 'gor', readied: { action: 'shout the alarm', trigger: 'he runs' } });
        const { d } = await manage({ action: 'trigger_readied', participantId: 'gor' });
        expect(d.reactionLines).toEqual(["⏳ Gor's readied action fires (shout the alarm): reaction spent; resolve its effect"]);
    });
});

describe('summary keeps reactionLines whole', () => {
    it('summarizeResult keeps every line, a long one (a PC call with long ids) included, while the rows collapse', () => {
        const long = `⚡ Kael may strike Bandit (OA; the player decides): combat_action attack {encounterId: 'encounter-${'x'.repeat(80)}', actorId: '${'a'.repeat(36)}', targetId: '${'b'.repeat(36)}', reaction: true, nonlethal: true, ranged: false} (or the mount: targetId '${'c'.repeat(36)}')`;
        expect(long.length).toBeGreaterThan(300);
        const rows = Array.from({ length: 3 }, (_, i) => ({ attackerId: `r${i}`, attackerName: `R${i}`, stepIndex: i, at: { x: i, y: 0 }, knockedOut: { by: `r${i}`, stable: true }, situational: ['x'.repeat(80)] }));
        const s = summarizeResult({ success: true, actionResult: { opportunityAttacks: rows, note: 'n'.repeat(400) }, reactionLines: ['⚡ Gor → Bandit: OA hit 47 vs AC 10, 11 bludgeoning, knocked out (subdue)', long] });
        expect(s.reactionLines).toEqual(['⚡ Gor → Bandit: OA hit 47 vs AC 10, 11 bludgeoning, knocked out (subdue)', long]);
        expect(JSON.stringify(s.actionResult)).not.toMatch(/knockedOut/);
    });
});
