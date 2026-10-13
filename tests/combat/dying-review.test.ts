/**
 * Play report 5, item 5 (dying): the adversarial review of lane C after the
 * integration merge. Each test here began RED against the owner's spec:
 *
 *  - an auto-rolled natural 20 on advance wrote 1 HP to the sheet but left
 *    the sheet's dying Unconscious + Prone in place;
 *  - a death save rolled or posted by hand before the slot (the player rolls
 *    their own) was rolled a second time by the engine on advance;
 *  - a knocked-out named NPC hit lethally became dying, but its natural 20
 *    left the knockout's Unconscious on the token and the sheet;
 *  - cast_spell damage (the SRD path) that dropped or killed a tracked target
 *    never marked the sheet dying, never ran the kill, and said DEFEATED;
 *  - a readied attack firing on a move, an NPC opportunity attack and
 *    trigger_readied did the same;
 *  - the 1d4-hour return to 1 HP fired by world_manage advance left
 *    Unconscious, Prone and Stable on the sheet;
 *  - apply_damage with no encounter on a tracked sheet already at 0 said DOWN
 *    and never applied massive damage;
 *  - a hand update {hp: 0} mid-fight left the token conscious while dying.
 */
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleCharacterManage } from '../../src/server/consolidated/character-manage.js';
import { handleWorldManage, WorldManageTool } from '../../src/server/consolidated/world-manage.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { DYING_SOURCE } from '../../src/engine/combat/dying.js';
import { getInitialSpellSlots } from '../../src/engine/magic/spell-validator.js';

type P = CombatParticipant & Record<string, unknown>;
const ctx = { sessionId: 'dying-review' };
const embedded = (res: any, tag: string) => {
    const text = res.content[0].text as string;
    const m = text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    if (m) return JSON.parse(m[1]);
    try { return JSON.parse(text); } catch { return { rawText: text }; }
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');
const character = async (args: Record<string, unknown>) => embedded(await handleCharacterManage(args, ctx as any), 'CHARACTER_MANAGE');
const world = async (args: Record<string, unknown>) => embedded(await handleWorldManage(WorldManageTool.inputSchema.parse(args), ctx as any), 'WORLD_MANAGE');
const now = () => new Date().toISOString();

/** Queue the next engine d20s. */
const d20 = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

const token = (over: Partial<P>): P => ({ id: 'x', name: 'X', initiativeBonus: 0, hp: 10, maxHp: 10, conditions: [], ...over }) as P;
const who = (e: CombatEngine, id: string) => e.getState()!.participants.find(p => p.id === id)! as P;
const current = (e: CombatEngine) => e.getState()!.turnOrder[e.getState()!.currentTurnIndex];
const hasCond = (p: { conditions: Array<{ type: string; sourceId?: string }> }, type: string, source?: string) =>
    p.conditions.some(c => c.type === type && (source === undefined || c.sourceId === source));

/** gob (init 20) acts first; the hero (init 10) lies at 0 HP; the orc (init 5) follows. */
function fight(seed: string, hero: Partial<P> = {}) {
    const e = new CombatEngine(seed);
    e.startEncounter([
        token({ id: 'gob', name: 'Goblin', initiative: 20, isEnemy: true, position: { x: 0, y: 0 } }),
        token({ id: 'hero', name: 'Hero', initiative: 10, hp: 0, maxHp: 20, deathSaves: true, position: { x: 1, y: 0 } }),
        token({ id: 'orc', name: 'Orc', initiative: 5, isEnemy: true, position: { x: 5, y: 5 } }),
        ...([] as P[])
    ].map(t => (t.id === 'hero' ? { ...t, ...hero } : t)));
    return e;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('engine: a death save made by hand is the slot\'s save', () => {
    it('rollDeathSave before the slot: nextTurnWithConditions does not roll again; the slot passes with a note', () => {
        const e = fight('banked');
        const spy = d20(14, 2);
        expect(e.rollDeathSave('hero')).toMatchObject({ roll: 14, success: true, successes: 1 });
        e.nextTurnWithConditions();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(who(e, 'hero')).toMatchObject({ deathSaveSuccesses: 1, deathSaveFailures: 0 });
        expect(current(e)).toBe('orc');
        expect(e.turnStartNotes.join('\n')).toMatch(/Hero.*death save already (rolled|made)/i);
        // The next round rolls as usual.
        e.nextTurnWithConditions(); // orc → gob (round 2)
        e.nextTurnWithConditions(); // gob → hero's slot
        expect(spy).toHaveBeenCalledTimes(2);
        expect(who(e, 'hero')).toMatchObject({ deathSaveSuccesses: 1, deathSaveFailures: 1 });
    });

    it('a posted outcome before the slot counts the same; in prompt mode the slot is satisfied and the following one prompts again', () => {
        const e = fight('banked-prompt');
        expect(e.postDeathSave('hero', 'failure')).toMatchObject({ failures: 1 });
        const spy = d20(14);
        e.nextTurnWithConditions({ deathSaveMode: 'prompt' });
        expect(spy).not.toHaveBeenCalled();
        expect(current(e)).toBe('orc');
        expect(who(e, 'hero').deathSaveDue).toBeFalsy();
        e.nextTurnWithConditions({ deathSaveMode: 'prompt' }); // → gob, round 2
        e.nextTurnWithConditions({ deathSaveMode: 'prompt' }); // → hero: DUE again
        expect(current(e)).toBe('hero');
        expect(who(e, 'hero').deathSaveDue).toBe(true);
        // Answering the DUE is consumed by that slot, not banked for the next.
        expect(e.postDeathSave('hero', 'success')).toMatchObject({ successes: 1, failures: 1 });
        e.nextTurnWithConditions({ deathSaveMode: 'prompt' }); // → orc
        e.nextTurnWithConditions({ deathSaveMode: 'prompt' }); // → gob, round 3
        e.nextTurnWithConditions({ deathSaveMode: 'prompt' }); // → hero: DUE again
        expect(who(e, 'hero').deathSaveDue).toBe(true);
    });

    it('a natural 20 on a token knocked out earlier clears the knockout Unconscious too', () => {
        const e = fight('ko-then-lethal', { isStabilized: true });
        who(e, 'hero').conditions = [{ id: 'u', type: 'unconscious', durationType: 'permanent', sourceId: 'nonlethal: gob' }] as any;
        // A lethal ranged hit while knocked out: dying again with a failure.
        e.executeAttack('gob', 'hero', 5, 10, 2, 'piercing', false, false, undefined, undefined, 'hit', undefined, { ranged: true });
        expect(who(e, 'hero')).toMatchObject({ isStabilized: false, deathSaveFailures: 1 });
        d20(20);
        e.nextTurnWithConditions();
        const hero = who(e, 'hero');
        expect(hero.hp).toBe(1);
        expect(hasCond(hero as any, 'unconscious')).toBe(false);
        // The posted path does the same.
        const f = fight('ko-posted', { isStabilized: true, deathSaveFailures: 1 });
        who(f, 'hero').isStabilized = false;
        who(f, 'hero').conditions = [{ id: 'u', type: 'unconscious', durationType: 'permanent', sourceId: 'nonlethal: gob' }] as any;
        expect(f.postDeathSave('hero', 'nat20')).toMatchObject({ regainedHp: true });
        expect(hasCond(who(f, 'hero') as any, 'unconscious')).toBe(false);
    });
});

describe('through the tools', () => {
    const W = 'varek';
    let enc: string;
    const repo = () => new CharacterRepository(getDb());
    const row = (id: string) => repo().findById(id) as any;
    const stored = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as P;
    const live = (id: string) => getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === id)! as P;
    const mk = (id: string, extra: Record<string, unknown> = {}) => repo().create({
        id, name: id[0].toUpperCase() + id.slice(1), stats: { str: 10, dex: 10, con: 10, int: 16, wis: 14, cha: 10 },
        hp: 20, maxHp: 20, ac: 12, level: 5, createdAt: now(), updatedAt: now(), ...extra
    } as any);
    const corpses = (id: string) => (getDb().prepare('SELECT * FROM corpses WHERE character_id = ?').all(id) as any[]);
    const rowConds = (id: string) => ((row(id).conditions ?? []) as Array<{ name: string; source?: string }>).map(c => `${c.name}:${c.source}`);

    /** medic (init 20) first; the hero (init 10); a sheetless goblin (init 5) with a sure 3-damage swing; a sheetless rat (init 1) at 0 as a mook. */
    const start = async (hero: Record<string, unknown> = {}, more: Array<Record<string, unknown>> = [], opts: Record<string, unknown> = {}) => {
        repo().update('hero', { hp: (hero.hp as number | undefined) ?? 0, ...(hero.maxHp !== undefined ? { maxHp: hero.maxHp } : {}) } as any);
        const created = await manage({ action: 'create', seed: 'dying-review', worldId: W, participants: [
            { id: 'medic', name: 'Medic', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'hero', name: 'Hero', hp: 0, maxHp: 20, initiative: 10, position: { x: 1, y: 0 }, ...hero },
            { id: 'gob', name: 'Goblin', hp: 7, maxHp: 7, ac: 10, initiative: 5, isEnemy: true, attackBonus: 40, attackDamage: '1d1+2', position: { x: 6, y: 6 } },
            { id: 'rat', name: 'Rat', hp: 0, maxHp: 3, initiative: 1, isEnemy: true, position: { x: 7, y: 7 } },
            ...more
        ], ...opts });
        enc = created.encounterId;
        return created;
    };

    beforeEach(() => {
        closeDb(); getDb(':memory:'); clearCombatState();
        new WorldRepository(getDb()).create({ id: W, name: 'Varek', seed: 's', width: 10, height: 10, createdAt: now(), updatedAt: now(), environment: { day: 12, time: '08:00' } } as any);
        mk('medic', { skillProficiencies: ['Medicine'], characterClass: 'wizard', knownSpells: ['Magic Missile'], preparedSpells: ['Magic Missile'], spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: 3 });
        mk('hero', { hp: 0 });
    });
    afterEach(() => { closeDb(); });

    describe('advance', () => {
        it('an auto-rolled natural 20 wakes the sheet too: the dying Unconscious and Prone come off the row', async () => {
            await start();
            repo().update('hero', { conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' }, { name: 'Cursed', source: 'a hag' }] } as any);
            d20(20);
            const r = await manage({ action: 'advance', encounterId: enc });
            expect(r.deathSaves[0]).toMatchObject({ participantId: 'hero', regainedHp: true });
            expect(row('hero').hp).toBe(1);
            expect(rowConds('hero')).toEqual(['Cursed:a hag']);
        });

        it('a death save posted by hand before the slot is the slot\'s save: advance does not roll a second one', async () => {
            await start();
            const posted = await manage({ action: 'death_save', encounterId: enc, participantId: 'hero', outcome: 'success' });
            expect(posted.deathSave).toMatchObject({ successes: 1 });
            const spy = d20(3);
            const r = await manage({ action: 'advance', encounterId: enc });
            expect(spy).not.toHaveBeenCalled();
            expect(r.currentTurn.id).toBe('gob');
            expect(r.rawText).toMatch(/Hero.*death save already/i);
            expect(stored('hero')).toMatchObject({ deathSaveSuccesses: 1, deathSaveFailures: 0 });
            await manage({ action: 'advance', encounterId: enc }); // gob → rat passes → medic (round 2)
            const again = await manage({ action: 'advance', encounterId: enc }); // → hero: rolled this time
            expect(spy).toHaveBeenCalledTimes(1);
            expect(again.deathSaves[0]).toMatchObject({ participantId: 'hero', roll: 3, success: false });
            expect(stored('hero')).toMatchObject({ deathSaveSuccesses: 1, deathSaveFailures: 1 });
        });

        it('a knocked-out named NPC hit lethally is dying; its natural 20 brings it round with the knockout Unconscious gone from token and sheet', async () => {
            mk('bandit', { characterType: 'npc', hp: 5, maxHp: 5 });
            await start({ hp: 20 }, [{ id: 'bandit', name: 'Bandit', hp: 5, maxHp: 5, ac: 10, initiative: 15, isEnemy: true, position: { x: 0, y: 1 } }]);
            d20(15);
            const ko = await act({ action: 'attack', encounterId: enc, actorId: 'medic', targetId: 'bandit', damage: 10, damageType: 'bludgeoning', nonlethal: true });
            expect(ko.actionResult.knockedOut).toMatchObject({ by: 'medic' });
            expect(rowConds('bandit')).toEqual(['Unconscious:nonlethal: medic']);
            await manage({ action: 'advance', encounterId: enc }); // medic → bandit (knocked out: passes, no save) → hero
            const view = await manage({ action: 'get', encounterId: enc });
            expect(view.currentTurn.id).toBe('hero');
            await manage({ action: 'advance', encounterId: enc }); // → gob
            const lethal = await act({ action: 'attack', encounterId: enc, actorId: 'gob', targetId: 'bandit', outcome: 'hit', damage: 2, ranged: true });
            expect(lethal.actionResult.dying).toMatchObject({ failuresAdded: 1, failures: 1 });
            expect(stored('bandit')).toMatchObject({ isStabilized: false, deathSaveFailures: 1 });
            expect((await manage({ action: 'get', encounterId: enc })).rawText).toMatch(/Bandit.*DYING ✓0 ✗1/);
            await manage({ action: 'advance', encounterId: enc }); // gob → rat passes → medic (round 2)
            d20(20);
            const r = await manage({ action: 'advance', encounterId: enc }); // → bandit: natural 20
            expect(r.deathSaves[0]).toMatchObject({ participantId: 'bandit', regainedHp: true });
            expect(r.currentTurn.id).toBe('bandit');
            const bandit = stored('bandit');
            expect(bandit.hp).toBe(1);
            expect(hasCond(bandit as any, 'unconscious')).toBe(false);
            expect(row('bandit').hp).toBe(1);
            expect(rowConds('bandit').some(c => c.startsWith('Unconscious'))).toBe(false);
        });
    });

    describe('spells', () => {
        it('cast_spell damage that drops a tracked target marks the sheet dying and says DYING, not DEFEATED', async () => {
            await start({ hp: 5 });
            const r = await act({ action: 'cast_spell', encounterId: enc, actorId: 'medic', targetId: 'hero', spellName: 'Magic Missile' });
            expect(r.error).toBeUndefined();
            expect(stored('hero').hp).toBe(0);
            expect(hasCond(stored('hero') as any, 'unconscious', DYING_SOURCE)).toBe(true);
            expect(hasCond(stored('hero') as any, 'prone', DYING_SOURCE)).toBe(true);
            expect(rowConds('hero')).toEqual(expect.arrayContaining(['Unconscious:dying', 'Prone:dying']));
            expect(r.rawText).toMatch(/DYING ✓0 ✗0/);
            expect(r.rawText).not.toMatch(/DEFEATED/);
            expect(r.actionResult.dying).toMatchObject({ dropped: true });
            expect(corpses('hero')).toHaveLength(0);
        });

        it('cast_spell massive damage kills a tracked target: the sheet is killed with a corpse and DEAD is printed', async () => {
            await start({ hp: 1, maxHp: 2 });
            const r = await act({ action: 'cast_spell', encounterId: enc, actorId: 'medic', targetId: 'hero', spellName: 'Magic Missile' });
            expect(r.error).toBeUndefined();
            expect(stored('hero').isDead).toBe(true);
            expect(r.actionResult.dying).toMatchObject({ dead: true, instantDeath: true });
            expect(r.actionResult.killed).toEqual([expect.objectContaining({ participantId: 'hero' })]); // a list, as the area paths report
            expect(r.rawText).toMatch(/DEAD/);
            expect(corpses('hero')).toHaveLength(1);
        });
    });

    describe('reactions', () => {
        it('a readied attack that fires on a move and drops a tracked mover marks its sheet dying', async () => {
            await start({ hp: 2 }, [], {});
            await manage({ action: 'set_intent', encounterId: enc, participantId: 'gob', readied: { action: 'stab', trigger: 'the hero comes close', on: 'enters_reach', watch: 'hero', attack: { attackBonus: 40, damage: '1d1+2' } } });
            await manage({ action: 'advance', encounterId: enc }); // medic → hero (2 HP, acts)
            const r = await act({ action: 'move', encounterId: enc, actorId: 'hero', targetPosition: { x: 5, y: 6 } });
            expect(r.actionResult.readiedTriggered?.[0]).toMatchObject({ participantId: 'gob', fired: true });
            expect(stored('hero').hp).toBe(0);
            expect(hasCond(stored('hero') as any, 'unconscious', DYING_SOURCE)).toBe(true);
            expect(rowConds('hero')).toEqual(expect.arrayContaining(['Unconscious:dying', 'Prone:dying']));
            expect(r.rawText).toMatch(/DYING/);
        });

        it('an NPC opportunity attack with massive damage kills the mover: the kill runs with a corpse', async () => {
            await start({ hp: 1, maxHp: 2, position: { x: 5, y: 6 } });
            await manage({ action: 'advance', encounterId: enc }); // medic → hero (1 HP, acts)
            const r = await act({ action: 'move', encounterId: enc, actorId: 'hero', targetPosition: { x: 1, y: 6 } });
            expect(r.actionResult.opportunityAttacks).toHaveLength(1);
            expect(stored('hero').isDead).toBe(true);
            expect(r.actionResult.killed).toMatchObject({ participantId: 'hero' });
            expect(corpses('hero')).toHaveLength(1);
            expect(r.rawText).toMatch(/DEAD/);
        });

        it('trigger_readied with an attack that drops a tracked target marks its sheet dying; massive damage kills with a corpse', async () => {
            await start({ hp: 2 });
            await manage({ action: 'set_intent', encounterId: enc, participantId: 'gob', readied: { action: 'shoot', trigger: 'the hero stands', attack: { attackBonus: 40, damage: '1d1+2', ranged: true } } });
            const r = await manage({ action: 'trigger_readied', encounterId: enc, participantId: 'gob', targetId: 'hero' });
            expect(r.error).toBeUndefined();
            expect(stored('hero').hp).toBe(0);
            expect(rowConds('hero')).toEqual(expect.arrayContaining(['Unconscious:dying', 'Prone:dying']));
            expect(r.message).toMatch(/DYING/);
            // Massive damage through the same call.
            repo().update('hero', { hp: 1, maxHp: 2, conditions: [] } as any);
            await manage({ action: 'adjust_hp', encounterId: enc, participantId: 'hero', value: 1, maxHp: 2, reason: 'reset for the test' });
            await manage({ action: 'set_intent', encounterId: enc, participantId: 'gob', readied: { action: 'shoot', trigger: 'again', attack: { attackBonus: 40, damage: '1d1+2', ranged: true } } });
            getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === 'gob')!.reactionUsed = false;
            const k = await manage({ action: 'trigger_readied', encounterId: enc, participantId: 'gob', targetId: 'hero' });
            expect(k.error).toBeUndefined();
            expect(stored('hero').isDead).toBe(true);
            expect(k.killed).toMatchObject({ participantId: 'hero' });
            expect(corpses('hero')).toHaveLength(1);
        });
    });

    describe('outside a fight', () => {
        it('apply_damage on a tracked sheet already at 0 stays DYING (no DOWN); massive damage at 0 kills with a corpse', async () => {
            repo().update('hero', { hp: 0, conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' }] } as any);
            const r = await manage({ action: 'apply_damage', targetIds: ['hero'], dice: 3, source: 'a kick' });
            expect(r.targets[0]).toMatchObject({ hpAfter: 0, dying: true });
            expect(r.message).toMatch(/DYING/);
            expect(r.message).not.toMatch(/DOWN/);
            expect(corpses('hero')).toHaveLength(0);
            const m = await manage({ action: 'apply_damage', targetIds: ['hero'], dice: 20, source: 'the ceiling' });
            expect(m.targets[0]).toMatchObject({ dead: true });
            expect(m.message).toMatch(/DEAD \(massive damage\)/);
            expect(corpses('hero')).toHaveLength(1);
        });

        it('the 1d4-hour return to 1 HP fired by world_manage advance wakes the sheet: Unconscious, Prone and Stable come off', async () => {
            repo().update('hero', { hp: 0, conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' }, { name: 'Cursed', source: 'a hag' }] } as any);
            const s = await act({ action: 'stabilize', actorId: 'medic', targetId: 'hero', medicineBonus: 20 });
            expect(s.stabilized).toBe(true);
            expect(s.recoversIn.hours).toBeGreaterThanOrEqual(1);
            expect(rowConds('hero')).toContain('Stable:stabilized by Medic');
            const adv = await world({ action: 'advance', worldId: W, hours: 4, fireScheduled: true });
            expect(adv.error).toBeUndefined();
            expect(JSON.stringify(adv.fired ?? adv)).toMatch(/hp: 0 → 1/);
            expect(row('hero').hp).toBe(1);
            expect(rowConds('hero')).toEqual(['Cursed:a hag']);
        });
    });

    describe('sync', () => {
        it('a hand update {hp: 0} on a tracked sheet mid-fight puts the token unconscious and prone at the next sync', async () => {
            await start({ hp: 20 });
            const u = await character({ action: 'update', characterId: 'hero', hp: 0 });
            expect(u.error).toBeUndefined();
            await manage({ action: 'get', encounterId: enc });
            const hero = live('hero');
            expect(hero.hp).toBe(0);
            expect(hasCond(hero as any, 'unconscious', DYING_SOURCE)).toBe(true);
            expect(hasCond(hero as any, 'prone', DYING_SOURCE)).toBe(true);
        });
    });
});
