import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { forcedMove } from '../../src/engine/combat/forced-move.js';
import { resolveCover } from '../../src/engine/combat/cover.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';

/**
 * Play report 7 #10: a rider and its mount. combat_manage mount / dismount
 * link two tokens (mountedOn, riderId, controlledBy). A controlled mount
 * moves on its rider's turn with its own budget, carrying the rider (who
 * moves free, and is credited the feet for mounted charges); its own slot
 * passes and its resources reset at the rider's turn; it may only Dash,
 * Disengage or Dodge. An independent mount moves itself, carrying the rider,
 * who cannot move it. Opportunity attacks on the pair's path come once per
 * reactor and target the rider by default. Linked partners never block or
 * cover each other. Falls (5e): the mount pushed, or the rider knocked prone,
 * rolls the rider's DC 10 DEX save on the fight's dice — fail: dismounted,
 * prone in a free cell within 5 ft; a mount at 0 HP, or removed, drops its
 * rider prone.
 */

const ctx = { sessionId: 'mount' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manage = async (args: Record<string, unknown>) => {
    const text = (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    return { text, d: tag(text, 'COMBAT_MANAGE') ?? {} };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, d, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;
const live = (id: string) => getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === id)! as any;
const hasProne = (p: any) => (p.conditions ?? []).some((c: any) => String(c.type).toLowerCase() === 'prone');
/** Script the next d20s the engine rolls (saves roll through rollD20). */
const d20 = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

// Kael (medium, 30 ft) beside a Large warhorse (60 ft) whose 2x2 footprint
// fills (1..2, 0..1); a bandit further off.
const kael = (extra: Record<string, unknown> = {}) => ({ id: 'kael', name: 'Kael', hp: 30, maxHp: 30, ac: 16, initiative: 20, position: { x: 0, y: 0 }, attackBonus: 5, attackDamage: '1d8+3', ...extra });
const horse = (extra: Record<string, unknown> = {}) => ({ id: 'horse', name: 'Warhorse', hp: 19, maxHp: 19, ac: 11, initiative: 15, size: 'large', movementSpeed: 60, position: { x: 1, y: 0 }, attackBonus: 6, attackDamage: '2d6+4', ...extra });
const bandit = (extra: Record<string, unknown> = {}) => ({ id: 'bandit', name: 'Bandit', hp: 11, maxHp: 11, ac: 12, initiative: 10, isEnemy: true, position: { x: 10, y: 10 }, attackBonus: 40, attackDamage: '1d1+2', ...extra });

async function setup(participants: any[] = [kael(), horse(), bandit()]) {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    enc = tag((await handleCombatManage({ action: 'create', seed: 'mount', participants }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
}
const mountUp = (extra: Record<string, unknown> = {}) => manage({ action: 'mount', riderId: 'kael', mountId: 'horse', free: true, ...extra });

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('mount and dismount', () => {
    it('mount links the pair, puts the rider on the mount, and at setup (free) spends nothing', async () => {
        await setup();
        const { d, text } = await mountUp();
        expect(d).toMatchObject({ success: true, actionType: 'mount', mounted: { riderId: 'kael', mountId: 'horse', controlled: true }, movementSpent: 0 });
        expect(tok('kael')).toMatchObject({ mountedOn: 'horse', position: { x: 1, y: 0 }, movementRemaining: 30 });
        expect(tok('horse')).toMatchObject({ riderId: 'kael', controlledBy: 'kael' });
        expect(text).toMatch(/🐎/);
    });

    it('mid-fight on the rider\'s turn mounting costs half the rider\'s speed', async () => {
        await setup();
        const { d } = await manage({ action: 'mount', riderId: 'kael', mountId: 'horse' });
        expect(d).toMatchObject({ success: true, movementSpent: 15 });
        expect(tok('kael').movementRemaining).toBe(15);
    });

    it('an independent mount (controlled: false) carries no controlledBy', async () => {
        await setup();
        const { d } = await mountUp({ controlled: false });
        expect(d.mounted.controlled).toBe(false);
        expect(tok('horse').controlledBy).toBeUndefined();
        expect(tok('horse').riderId).toBe('kael');
    });

    it('refuses with nothing written: same token, unknown, not larger, not adjacent, already linked, 0 HP, rider cannot act, short of half speed, not the rider\'s turn', async () => {
        await setup([kael(), horse(), bandit({ position: { x: 3, y: 0 } }), { id: 'dog', name: 'Dog', hp: 5, maxHp: 5, initiative: 5, position: { x: 0, y: 1 } }, { id: 'far', name: 'Far Horse', hp: 19, maxHp: 19, size: 'large', initiative: 4, position: { x: 8, y: 8 } }]);
        const refused = async (args: Record<string, unknown>, why: RegExp) => {
            const { d } = await manage({ action: 'mount', ...args });
            expect(d.error, JSON.stringify(d)).toBe(true);
            expect(d.writes).toBe('none');
            expect(String(d.message)).toMatch(why);
        };
        await refused({ riderId: 'kael', mountId: 'kael' }, /itself/);
        await refused({ riderId: 'kael', mountId: 'ghost' }, /not in this encounter/);
        await refused({ riderId: 'kael', mountId: 'dog' }, /larger/);
        await refused({ riderId: 'kael', mountId: 'far' }, /within 5 ft|adjacent/);
        live('kael').movementRemaining = 10;
        await refused({ riderId: 'kael', mountId: 'horse' }, /needs 15 ft.*10 left/);
        live('kael').movementRemaining = 30;
        live('horse').hp = 0;
        await refused({ riderId: 'kael', mountId: 'horse' }, /0 HP/);
        live('horse').hp = 19;
        await manage({ action: 'add_condition', participantId: 'kael', condition: 'stunned' });
        await refused({ riderId: 'kael', mountId: 'horse' }, /cannot act/);
        await manage({ action: 'remove_condition', participantId: 'kael', name: 'stunned' });
        await manage({ action: 'add_condition', participantId: 'horse', condition: 'prone' });
        await refused({ riderId: 'kael', mountId: 'horse' }, /prone/);
        await manage({ action: 'remove_condition', participantId: 'horse', name: 'prone' });
        await refused({ riderId: 'bandit', mountId: 'horse' }, /turn/);
        expect((await mountUp()).d.success).toBe(true);
        await refused({ riderId: 'kael', mountId: 'horse', free: true }, /already/);
        await refused({ riderId: 'dog', mountId: 'horse', free: true }, /already/);
        expect(tok('kael').mountedOn).toBe('horse');
        expect(tok('dog').mountedOn).toBeUndefined();
    });

    it('dismount costs half the rider\'s speed and places it on a free cell within 5 ft (or the one named)', async () => {
        await setup();
        await mountUp();
        const { d } = await manage({ action: 'dismount', riderId: 'kael' });
        expect(d).toMatchObject({ success: true, actionType: 'dismount', dismounted: { riderId: 'kael', mountId: 'horse' }, movementSpent: 15 });
        const k = tok('kael');
        expect(k.mountedOn).toBeUndefined();
        expect(tok('horse').riderId).toBeUndefined();
        expect(tok('horse').controlledBy).toBeUndefined();
        expect(k.movementRemaining).toBe(15);
        // Outside the mount's 2x2 footprint, touching it.
        expect(k.position.x >= 1 && k.position.x <= 2 && k.position.y >= 0 && k.position.y <= 1).toBe(false);
        expect(Math.max(Math.max(0, 1 - k.position.x, k.position.x - 2), Math.max(0, 0 - k.position.y, k.position.y - 1))).toBe(1);

        await mountUp();
        const named = await manage({ action: 'dismount', riderId: 'kael', position: { x: 3, y: 1 }, free: true });
        expect(named.d.success).toBe(true);
        expect(tok('kael').position).toEqual({ x: 3, y: 1 });
    });

    it('dismount is refused (nothing written) when not mounted, short of half speed, or the named cell is not free within 5 ft', async () => {
        await setup();
        expect((await manage({ action: 'dismount', riderId: 'kael' })).d).toMatchObject({ error: true, writes: 'none' });
        await mountUp();
        live('kael').movementRemaining = 10;
        const short = await manage({ action: 'dismount', riderId: 'kael' });
        expect(short.d).toMatchObject({ error: true, writes: 'none' });
        expect(String(short.d.message)).toMatch(/needs 15 ft.*10 left/);
        live('kael').movementRemaining = 30;
        const far = await manage({ action: 'dismount', riderId: 'kael', position: { x: 7, y: 7 } });
        expect(far.d).toMatchObject({ error: true, writes: 'none' });
        expect(tok('kael').mountedOn).toBe('horse');
    });
});

describe('a controlled mount moves on the rider\'s turn', () => {
    it('move {actorId: rider} moves the mount with the mount\'s budget; the rider moves free, follows, and is credited the feet', async () => {
        await setup();
        await mountUp();
        const { r, text } = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 11, y: 0 } });
        expect(r.success).toBe(true);
        expect(r.mounted).toMatchObject({ riderId: 'kael', mountId: 'horse', movedBy: 'mount' });
        expect(tok('horse').position).toEqual({ x: 11, y: 0 });
        expect(tok('kael').position).toEqual({ x: 11, y: 0 });
        expect(tok('horse').movementRemaining).toBe(10);
        expect(tok('kael').movementRemaining).toBe(30);
        expect(tok('kael').movedThisTurn).toBe(50);
        expect(text).toMatch(/Warhorse/);
    });

    it('beyond the mount\'s budget it is refused; a Dash by the mount widens it', async () => {
        await setup();
        await mountUp();
        const { text } = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 14, y: 0 } });
        expect(text).toMatch(/Insufficient movement/);
        expect(tok('horse').position).toEqual({ x: 1, y: 0 });
        const dash = await act({ action: 'dash', actorId: 'horse' });
        expect(dash.d.success).toBe(true);
        const { r } = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 14, y: 0 } });
        expect(r.success).toBe(true);
        expect(tok('kael').position).toEqual({ x: 14, y: 0 });
    });

    it('a large mount is not blocked by its own rider', async () => {
        await setup();
        await mountUp();
        const { r } = await act({ action: 'move', actorId: 'horse', targetPosition: { x: 0, y: 0 } });
        expect(r.success).toBe(true);
        expect(tok('horse').position).toEqual({ x: 0, y: 0 });
        expect(tok('kael').position).toEqual({ x: 0, y: 0 });
    });

    it('an enemy along the path makes one opportunity attack, at the rider by default, and says the mount could be chosen', async () => {
        // The bandit stands below the horse's lane: in reach of its footprint
        // from (1,0) to (4,0), out of it from (5,0).
        await setup([kael(), horse(), bandit({ position: { x: 3, y: 2 } })]);
        await mountUp();
        const { r, text } = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 8, y: 0 } });
        expect(r.opportunityAttacks).toHaveLength(1);
        expect(r.opportunityAttacks[0]).toMatchObject({ attackerId: 'bandit', targetId: 'kael' });
        expect(text).toMatch(/could target the Warhorse/);
        expect(tok('kael').hp).toBe(30 - r.opportunityAttacks[0].damage);
        expect(tok('horse').hp).toBe(19);
    });

    it('readied triggers are checked for both: one watching the rider fires at the rider when the mount carries it into reach', async () => {
        await setup([kael(), horse(), bandit({ position: { x: 9, y: 0 } })]);
        await mountUp();
        await manage({ action: 'set_intent', participantId: 'bandit', readied: { action: 'stab the rider', trigger: 'Kael comes close', on: 'enters_reach', watch: 'kael', attack: { attackBonus: 40, damage: '1d1+1' } } });
        const { r } = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 7, y: 0 } });
        expect(r.readiedTriggered).toEqual([expect.objectContaining({ participantId: 'bandit', fired: true, targetId: 'kael' })]);
        expect(tok('kael').hp).toBe(30 - r.readiedTriggered[0].attack.damage);
        expect(tok('horse').hp).toBe(19);
    });

    it('the controlled mount\'s own slot passes with a note, and its movement resets when the rider\'s turn starts', async () => {
        await setup();
        await mountUp();
        await act({ action: 'move', actorId: 'kael', targetPosition: { x: 11, y: 0 } });
        expect(tok('horse').movementRemaining).toBe(10);
        const adv = await manage({ action: 'advance' });
        expect(adv.text).toMatch(/🐎 Warhorse moves on Kael's turn/);
        expect(adv.d.currentTurn?.id ?? adv.d.activeParticipant ?? '').toMatch(/bandit|Bandit/);
        await manage({ action: 'advance' });
        expect(tok('kael').movementRemaining).toBe(30);
        expect(tok('horse').movementRemaining).toBe(60);
    });

    it('a controlled mount may only Dash, Disengage or Dodge: attack, cast_spell and help are refused with nothing spent', async () => {
        await setup([kael(), horse(), bandit({ position: { x: 3, y: 0 } })]);
        await mountUp();
        for (const call of [
            { action: 'attack', actorId: 'horse', targetId: 'bandit' },
            { action: 'cast_spell', actorId: 'horse', spellName: 'Fire Bolt', targetId: 'bandit' },
            { action: 'help', actorId: 'horse', targetId: 'kael' }
        ]) {
            const { d } = await act(call);
            expect(d.error, JSON.stringify(d)).toBe(true);
            expect(d.writes).toBe('none');
            expect(String(d.message)).toMatch(/Dash, Disengage or Dodge/);
        }
        expect(tok('horse').actionUsed).toBeFalsy();
        expect(tok('bandit').hp).toBe(11);
        expect((await act({ action: 'dodge', actorId: 'horse' })).d.success).toBe(true);
    });

    it('the rider\'s attack after a mounted charge meets its movedAtLeast trigger', async () => {
        await setup([kael({ attacks: [{ name: 'lance', attackBonus: 40, damage: '1d1+5', requires: { movedAtLeast: 20 } }], attackBonus: undefined, attackDamage: undefined }), horse(), bandit({ position: { x: 9, y: 0 } })]);
        await mountUp();
        const early = await act({ action: 'attack', actorId: 'kael', targetId: 'bandit', using: 'lance' });
        expect(early.d.error).toBe(true);
        await act({ action: 'move', actorId: 'kael', targetPosition: { x: 7, y: 0 } });
        const charge = await act({ action: 'attack', actorId: 'kael', targetId: 'bandit', using: 'lance' });
        expect(charge.d.error, JSON.stringify(charge.d)).toBeFalsy();
        expect(charge.r.trigger).toMatchObject({ movedFt: 30 });
    });
});

describe('an independent mount', () => {
    it('the rider cannot move it (refused, dismount first); it moves itself and carries the rider', async () => {
        await setup();
        await mountUp({ controlled: false });
        const { d } = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 6, y: 0 } });
        expect(d.error).toBe(true);
        expect(d.writes).toBe('none');
        expect(String(d.message)).toMatch(/independent.*dismount first/);
        expect(tok('horse').position).toEqual({ x: 1, y: 0 });
        const { r } = await act({ action: 'move', actorId: 'horse', targetPosition: { x: 6, y: 0 } });
        expect(r.success).toBe(true);
        expect(tok('kael').position).toEqual({ x: 6, y: 0 });
        expect(tok('horse').movementRemaining).toBe(35);
        // Its slot is its own: advance from Kael lands on the Warhorse.
        const adv = await manage({ action: 'advance' });
        expect(adv.text).not.toMatch(/moves on Kael's turn/);
    });
});

describe('linked partners never block or cover each other', () => {
    it('forced movement of a mount ignores its rider; cover between the pair is none', async () => {
        const e = new CombatEngine('mount-grid');
        e.startEncounter([
            { id: 'kael', name: 'Kael', initiativeBonus: 0, hp: 30, maxHp: 30, conditions: [], position: { x: 6, y: 5 }, mountedOn: 'horse' },
            { id: 'horse', name: 'Warhorse', initiativeBonus: 0, hp: 19, maxHp: 19, conditions: [], size: 'large', position: { x: 6, y: 5 }, riderId: 'kael', controlledBy: 'kael' },
            { id: 'bandit', name: 'Bandit', initiativeBonus: 0, hp: 11, maxHp: 11, conditions: [], isEnemy: true, position: { x: 8, y: 6 } }
        ] as any);
        const state = e.getState()!;
        const [k, h, b] = ['kael', 'horse', 'bandit'].map(id => state.participants.find(p => p.id === id)!);
        // Pushed north-west by the bandit: the new footprint covers Kael's square.
        const pushed = forcedMove(state, h, b, 5);
        expect(pushed.stoppedBy).toBeUndefined();
        expect(pushed.feet).toBe(5);
        // The rider gets no cover from its own mount.
        h.position = { x: 6, y: 5 };
        expect(resolveCover(state, b, k).kind).toBe('none');
        expect(e.getOpportunityAttackers('horse', [{ x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }, { x: 10, y: 5 }]).map(x => x.attacker.id)).not.toContain('kael');
        void k;
    });
});

describe('falls (5e: DC 10 DEX to stay mounted)', () => {
    it('a shoved mount carries its rider, who saves: a success stays mounted', async () => {
        await setup([kael({ position: { x: 5, y: 5 } }), horse({ position: { x: 6, y: 5 } }), bandit({ position: { x: 8, y: 6 } })]);
        await mountUp();
        d20(15);
        const { d } = await act({ action: 'grapple', move: 'shove', actorId: 'bandit', targetId: 'horse', outcome: 'win' });
        expect(d.pushed?.feet).toBe(5);
        expect(d.mounts?.[0]).toMatchObject({ riderId: 'kael', save: { dc: 10, saved: true }, fell: false });
        expect(tok('kael').mountedOn).toBe('horse');
        expect(tok('kael').position).toEqual(tok('horse').position);
    });

    it('a failed save: dismounted, prone, in a free cell within 5 ft of the mount', async () => {
        await setup([kael({ position: { x: 5, y: 5 } }), horse({ position: { x: 6, y: 5 } }), bandit({ position: { x: 8, y: 6 } })]);
        await mountUp();
        d20(2);
        const { d, text } = await act({ action: 'grapple', move: 'shove', actorId: 'bandit', targetId: 'horse', outcome: 'win' });
        expect(d.mounts?.[0]).toMatchObject({ riderId: 'kael', save: { dc: 10, saved: false }, fell: true });
        const k = tok('kael');
        expect(k.mountedOn).toBeUndefined();
        expect(tok('horse').riderId).toBeUndefined();
        expect(hasProne(k)).toBe(true);
        const h = tok('horse');
        const inside = k.position.x >= h.position.x && k.position.x <= h.position.x + 1 && k.position.y >= h.position.y && k.position.y <= h.position.y + 1;
        expect(inside).toBe(false);
        expect(text).toMatch(/falls/);
    });

    it('the rider knocked prone saves too: a success keeps the saddle (not prone), a failure falls', async () => {
        await setup();
        await mountUp();
        d20(18);
        const kept = await manage({ action: 'add_condition', participantId: 'kael', condition: 'prone' });
        expect(kept.d.mounts?.[0]).toMatchObject({ riderId: 'kael', fell: false });
        expect(tok('kael').mountedOn).toBe('horse');
        expect(hasProne(tok('kael'))).toBe(false);
        vi.restoreAllMocks();
        d20(1);
        const fell = await manage({ action: 'add_condition', participantId: 'kael', condition: 'prone' });
        expect(fell.d.mounts?.[0]).toMatchObject({ riderId: 'kael', fell: true });
        expect(tok('kael').mountedOn).toBeUndefined();
        expect(hasProne(tok('kael'))).toBe(true);
    });

    it('a mount at 0 HP drops its rider prone, with the note that a reaction could land it on its feet', async () => {
        await setup();
        await mountUp();
        const { d, text } = await manage({ action: 'adjust_hp', participantId: 'horse', value: 0, reason: 'spear' });
        expect(d.mounts?.[0]).toMatchObject({ riderId: 'kael', fell: true });
        expect(tok('kael').mountedOn).toBeUndefined();
        expect(hasProne(tok('kael'))).toBe(true);
        expect(text).toMatch(/reaction/);
    });

    it('a mount removed from the fight drops its rider prone where it sat', async () => {
        await setup();
        await mountUp();
        const { d } = await manage({ action: 'remove_participant', participantId: 'horse' });
        expect(d.mounts?.[0]).toMatchObject({ riderId: 'kael', fell: true });
        expect(tok('kael').mountedOn).toBeUndefined();
        expect(hasProne(tok('kael'))).toBe(true);
        expect(tok('kael').position).toEqual({ x: 1, y: 0 });
    });

    it('shoving the rider pushes it off the mount', async () => {
        await setup([kael({ position: { x: 5, y: 5 } }), horse({ position: { x: 6, y: 5 } }), bandit({ position: { x: 8, y: 6 } })]);
        await mountUp();
        const { d } = await act({ action: 'grapple', move: 'shove', actorId: 'bandit', targetId: 'kael', outcome: 'win' });
        expect(d.mounts?.[0]).toMatchObject({ riderId: 'kael', fell: true });
        const k = tok('kael');
        expect(k.mountedOn).toBeUndefined();
        const inside = k.position.x >= 6 && k.position.x <= 7 && k.position.y >= 5 && k.position.y <= 6;
        expect(inside).toBe(false);
    });
});

describe('the link in the state view', () => {
    it('persists across a new process; get shows it in JSON and text', async () => {
        await setup();
        await mountUp();
        clearCombatState();
        const { d, text } = await manage({ action: 'get' });
        expect(d.participants.find((p: any) => p.id === 'kael')).toMatchObject({ mountedOn: 'horse' });
        expect(d.participants.find((p: any) => p.id === 'horse')).toMatchObject({ riderId: 'kael', controlled: true });
        expect(text).toMatch(/🐎 riding Warhorse \(controlled\)/);
        expect(text).toMatch(/🐎 ridden by Kael/);
    });
});

describe('review: mounts against the other lanes and a second process', () => {
    /** Kael as a player character's row (lane D's turn guard reads the sheet). */
    async function setupPc(participants: any[] = [kael(), horse(), bandit()]) {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        const now = new Date().toISOString();
        new CharacterRepository(db).create({ id: 'kael', name: 'Kael', characterType: 'pc', stats: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 30, maxHp: 30, ac: 16, level: 3, createdAt: now, updatedAt: now } as any);
        enc = tag((await handleCombatManage({ action: 'create', seed: 'mount', participants }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
    }

    it('mounting or dismounting mid-fight is the rider\'s turn taken: the PC turn guard lets advance pass; a free (set-up) mount does not count', async () => {
        await setupPc();
        expect((await manage({ action: 'mount', riderId: 'kael', mountId: 'horse' })).d.movementSpent).toBe(15);
        const adv = await manage({ action: 'advance' });
        expect(adv.d.error, String(adv.d.message)).toBeFalsy();

        await setupPc();
        await mountUp();
        expect((await manage({ action: 'dismount', riderId: 'kael' })).d.movementSpent).toBe(15);
        const adv2 = await manage({ action: 'advance' });
        expect(adv2.d.error, String(adv2.d.message)).toBeFalsy();

        await setupPc();
        await mountUp();
        const held = await manage({ action: 'advance' });
        expect(held.d).toMatchObject({ error: true });
        expect(String(held.d.message)).toMatch(/TURN NOT TAKEN/);
    });

    it('a rider\'s dash {targetPosition} is refused before anything is spent: the move is the mount\'s, so is the Dash', async () => {
        await setup();
        await mountUp();
        const { d } = await act({ action: 'dash', actorId: 'kael', targetPosition: { x: 16, y: 0 } });
        expect(d.error).toBe(true);
        expect(d.writes).toBe('none');
        expect(String(d.message)).toMatch(/dash \{encounterId: '[^']+', actorId: 'horse', targetPosition/);
        expect(tok('kael').actionUsed).toBeFalsy();
        expect(tok('horse').position).toEqual({ x: 1, y: 0 });
        // The mount's own Dash does it.
        const { d: ok } = await act({ action: 'dash', actorId: 'horse', targetPosition: { x: 16, y: 0 } });
        expect(ok.success).toBe(true);
        expect(tok('kael').position).toEqual({ x: 16, y: 0 });
        // A plain Dash by the rider is allowed (it may dismount and walk), with a note that the mount's moves do not use it.
        await setup();
        await mountUp();
        const plain = await act({ action: 'dash', actorId: 'kael' });
        expect(plain.d.success).toBe(true);
        expect(String(plain.d.message)).toMatch(/Warhorse's movement/);
    });

    it('an enemy rider on a mount left without isEnemy still provokes: the reactor hostile to the rider strikes the rider', async () => {
        await setup([
            kael({ isEnemy: true, position: { x: 1, y: 0 } }),
            horse(),
            { id: 'gor', name: 'Gor', hp: 40, maxHp: 40, ac: 14, initiative: 5, position: { x: 3, y: 2 }, attackBonus: 40, attackDamage: '1d1' }
        ]);
        await mountUp();
        const { r } = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 8, y: 0 } });
        expect(r.opportunityAttacks).toHaveLength(1);
        expect(r.opportunityAttacks[0]).toMatchObject({ attackerId: 'gor', targetId: 'kael' });
        expect(tok('kael').hp).toBe(29);
        expect(tok('horse').hp).toBe(19);
    });

    it('a reactor hostile to the mount but not its rider strikes the mount', async () => {
        await setup([kael(), horse({ isEnemy: true }), { id: 'gor', name: 'Gor', hp: 40, maxHp: 40, ac: 14, initiative: 5, position: { x: 3, y: 2 }, attackBonus: 40, attackDamage: '1d1' }]);
        await mountUp();
        const { r } = await act({ action: 'move', actorId: 'kael', targetPosition: { x: 8, y: 0 } });
        expect(r.opportunityAttacks).toHaveLength(1);
        expect(r.opportunityAttacks[0]).toMatchObject({ attackerId: 'gor', targetId: 'horse' });
        expect(tok('kael').hp).toBe(30);
        expect(tok('horse').hp).toBe(18);
    });

    it('a fall lands on the board: the same square in a warm process and after a reload (default grid bounds)', async () => {
        const fall = async (reload: boolean) => {
            await setup();
            await mountUp();
            if (reload) clearCombatState();
            d20(1);
            const { d } = await manage({ action: 'add_condition', participantId: 'kael', condition: 'prone' });
            vi.restoreAllMocks();
            expect(d.mounts?.[0]).toMatchObject({ riderId: 'kael', fell: true });
            return tok('kael').position;
        };
        const warm = await fall(false);
        const cold = await fall(true);
        expect(warm.x).toBeGreaterThanOrEqual(0);
        expect(warm.y).toBeGreaterThanOrEqual(0);
        expect(warm).toEqual(cold);
    });

    it('the reply\'s participants agree with the fall it reports (no stale mountedOn)', async () => {
        await setup([kael(), horse(), bandit({ position: { x: 3, y: 0 } })]);
        await mountUp();
        const { d } = await act({ action: 'attack', actorId: 'bandit', targetId: 'horse', outcome: 'hit', damage: 40 });
        expect(d.mounts?.[0]).toMatchObject({ riderId: 'kael', fell: true });
        const k = d.participants.find((p: any) => p.id === 'kael');
        expect(k.mountedOn).toBeUndefined();
        expect(k.position).toEqual(tok('kael').position);
        expect(d.participants.find((p: any) => p.id === 'horse').riderId).toBeUndefined();
    });

    it('a controlled mount acting on its rider\'s turn is on-turn: no off_turn_action warning, no offTurn, no "its turn has ended"', async () => {
        await setup();
        await mountUp();
        const moved = await act({ action: 'move', actorId: 'horse', targetPosition: { x: 5, y: 0 } });
        expect(moved.r.success).toBe(true);
        expect(moved.d.offTurn).toBeUndefined();
        expect(moved.text).not.toMatch(/off_turn_action/);
        expect((await act({ action: 'dodge', actorId: 'horse' })).d.success).toBe(true);
        const again = await act({ action: 'disengage', actorId: 'horse' });
        expect(again.text).not.toMatch(/turn has ended/);
        expect(again.d.offTurn).toBeUndefined();
    });

    it('a controlled mount\'s use_ability or battle cry that costs its action is refused as a controlled mount (its own slot never comes); a free one is allowed', async () => {
        await setup([kael(), horse({ abilities: [{ name: 'Trample', recharge: 5 }, { name: 'Snort', actionCost: 'none' }] }), bandit({ position: { x: 3, y: 0 } })]);
        await mountUp();
        const trample = await manage({ action: 'use_ability', participantId: 'horse', ability: 'Trample', targetIds: ['bandit'], damage: 5 });
        expect(trample.d).toMatchObject({ error: true, writes: 'none' });
        expect(String(trample.d.message)).toMatch(/Dash, Disengage or Dodge/);
        expect(tok('bandit').hp).toBe(11);
        const cry = await manage({ action: 'battle_cry', participantId: 'horse', actionCost: 'action', attackAdvantage: true });
        expect(cry.d).toMatchObject({ error: true, writes: 'none' });
        expect(String(cry.d.message)).toMatch(/Dash, Disengage or Dodge/);
        const snort = await manage({ action: 'use_ability', participantId: 'horse', ability: 'Snort' });
        expect(snort.d.error, String(snort.d.message)).toBeFalsy();
    });

    it('remove_participant of the actor that is up passes a controlled mount\'s slot, as advance does', async () => {
        await setup([kael(), horse(), bandit({ initiative: 18 }), { id: 'dog', name: 'Dog', hp: 5, maxHp: 5, initiative: 5, position: { x: 12, y: 12 } }]);
        await mountUp();
        await act({ action: 'move', actorId: 'kael', targetPosition: { x: 9, y: 0 } });
        expect(tok('horse').movementRemaining).toBe(20);
        await manage({ action: 'advance' });
        const { d, text } = await manage({ action: 'remove_participant', participantId: 'bandit' });
        expect(d.currentTurn).toBe('dog');
        expect(text).toMatch(/Warhorse moves on Kael's turn/);
        expect(tok('horse').movementRemaining).toBe(20);
    });
});
