/**
 * Play report 5, item 5 (dying): the adversarial pass.
 *
 * The lane mirrored the sheet and ran the kill on the attack branch,
 * apply_damage, use_ability and lair_action. Damage reaches a token by other
 * roads too: an opportunity attack or a readied attack fired by a move,
 * trigger_readied, cast_spell, a world spell. Healing reaches a sheet by a
 * potion (inventory_manage use), a spell's HP write-back, a hand update and
 * the stabilise recovery the lane itself files. The owner's spec is one rule
 * for all of them: at 0 a tracked character is dying (Unconscious + Prone on
 * the sheet too), three failures or massive damage kill it with a corpse, and
 * any healing above 0 restores consciousness.
 */
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleCharacterManage } from '../../src/server/consolidated/character-manage.js';
import { handleWorldManage, WorldManageTool } from '../../src/server/consolidated/world-manage.js';
import { handleInventoryManage } from '../../src/server/consolidated/inventory-manage.js';
import { handleItemManage } from '../../src/server/consolidated/item-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { DYING_SOURCE } from '../../src/engine/combat/dying.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { parseDiceTerms } from '../../src/engine/combat/rng.js';

type P = CombatParticipant & Record<string, unknown>;
const ctx = { sessionId: 'dying-verify' };
const embedded = (res: any, tag: string) => {
    const m = res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? { ...JSON.parse(m[1]), rawText: res.content[0].text } : { rawText: res.content[0].text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');
const world = async (a: Record<string, unknown>) => {
    const t = (await handleWorldManage(WorldManageTool.inputSchema.parse(a), ctx as any)).content[0].text;
    const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/);
    return m ? JSON.parse(m[2]) : JSON.parse(t);
};
const now = () => new Date().toISOString();

/** Queue the next engine d20s. */
const d20 = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};
function maxDice(notation: string) {
    const rolls: number[] = []; let modifier = 0;
    for (const t of parseDiceTerms(notation)) {
        if (t.kind === 'dice') for (let i = 0; i < t.count; i++) rolls.push(t.sign * t.sides);
        else modifier += t.sign * t.value;
    }
    const diceTotal = rolls.reduce((a, b) => a + b, 0);
    return { notation, rolls, diceTotal, modifier, total: diceTotal + modifier };
}

const W = 'varek';
let enc: string;
const repo = () => new CharacterRepository(getDb());
const row = (id: string) => repo().findById(id) as any;
const rowDying = (id: string) => (row(id).conditions as Array<{ name: string; source?: string }>).filter(c => c.source === DYING_SOURCE || c.name === 'Stable').map(c => c.name).sort();
const stored = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as P;
const hasCond = (p: P, type: string, source?: string) => p.conditions.some(c => c.type === type && (source === undefined || c.sourceId === source));
const corpses = (id: string) => (getDb().prepare('SELECT * FROM corpses WHERE character_id = ?').all(id) as any[]);
const mk = (id: string, extra: Record<string, unknown> = {}) => repo().create({
    id, name: id[0].toUpperCase() + id.slice(1), stats: { str: 10, dex: 10, con: 10, int: 10, wis: 14, cha: 10 },
    hp: 20, maxHp: 20, ac: 12, level: 5, createdAt: now(), updatedAt: now(), ...extra
} as any);
const setToken = (id: string, patch: Record<string, unknown>) => {
    const r = new EncounterRepository(getDb());
    const st = r.loadState(enc)!;
    Object.assign(st.participants.find(p => p.id === id)!, patch);
    r.saveState(enc, st);
    clearCombatState();
};

/**
 * medic (init 20) at (0,0); the hero (init 10) at (1,0); a sheetless goblin
 * (init 5) adjacent to the hero at (2,0) that always hits for `gobDamage`.
 */
const start = async (hero: Record<string, unknown> = {}, gob: Record<string, unknown> = {}, more: Array<Record<string, unknown>> = []) => {
    repo().update('hero', { hp: (hero.hp as number | undefined) ?? 0 } as any);
    const created = await manage({ action: 'create', seed: 'dying-verify', worldId: W, participants: [
        { id: 'medic', name: 'Medic', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
        { id: 'hero', name: 'Hero', hp: 0, maxHp: 20, initiative: 10, position: { x: 1, y: 0 }, ...hero },
        { id: 'gob', name: 'Goblin', hp: 7, maxHp: 7, initiative: 5, isEnemy: true, position: { x: 2, y: 0 }, attackBonus: 100, attackDamage: '1d1+5', ...gob },
        ...more
    ] });
    enc = created.encounterId;
    return created;
};

beforeEach(() => {
    closeDb(); getDb(':memory:'); clearCombatState();
    new WorldRepository(getDb()).create({ id: W, name: 'Varek', seed: 's', width: 10, height: 10, createdAt: now(), updatedAt: now(), environment: { day: 12, time: '08:00' } } as any);
    mk('medic', { skillProficiencies: ['Medicine'] });
    mk('hero', { hp: 0 });
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('every road that drops a tracked token mirrors the sheet and runs the kill', () => {
    it('an opportunity attack fired by a move: the dropped mover is DYING on token and sheet', async () => {
        await start({ hp: 6 });
        await manage({ action: 'advance', encounterId: enc, confirm: true }); // medic → hero (6 HP, acts)
        const r = await act({ action: 'move', encounterId: enc, actorId: 'hero', targetPosition: { x: 1, y: 3 } });
        expect(r.error).toBeUndefined();
        expect(r.actionResult.opportunityAttacks).toHaveLength(1);
        expect(r.actionResult.opportunityAttacks[0]).toMatchObject({ hit: true, targetHpAfter: 0 });
        const hero = stored('hero');
        expect(hasCond(hero, 'unconscious', DYING_SOURCE)).toBe(true);
        expect(rowDying('hero')).toEqual(['Prone', 'Unconscious']);
        expect(r.rawText).toMatch(/DYING ✓0 ✗0/);
        expect(r.rawText).not.toMatch(/Hero was defeated/);
    });

    it('an opportunity attack of massive damage kills: the sheet is killed with a corpse and the reply says so', async () => {
        await start({ hp: 6 }, { attackDamage: '1d1+29' });
        await manage({ action: 'advance', encounterId: enc, confirm: true });
        const r = await act({ action: 'move', encounterId: enc, actorId: 'hero', targetPosition: { x: 1, y: 3 } });
        expect(r.error).toBeUndefined();
        expect(stored('hero').isDead).toBe(true);
        expect(corpses('hero')).toHaveLength(1);
        expect(row('hero').hp).toBe(0);
        // One record, the shape combat_action attack reports (a move stops where the mover fell: one blow can kill it).
        expect(r.actionResult.killed).toMatchObject({ participantId: 'hero' });
        expect(r.rawText).toMatch(/☠ Hero is dead/);
    });

    it('trigger_readied: the readied attack that drops the hero mirrors the sheet; massive damage kills with a corpse', async () => {
        await start({ hp: 6 });
        setToken('gob', { readied: { action: 'stab', trigger: 'the hero stirs', attack: { attackBonus: 100, damage: '1d1+5' } } });
        const r = await manage({ action: 'trigger_readied', encounterId: enc, participantId: 'gob', targetId: 'hero' });
        expect(r.error).toBeUndefined();
        expect(r.attack).toMatchObject({ hit: true, targetHpAfter: 0 });
        expect(hasCond(stored('hero'), 'unconscious', DYING_SOURCE)).toBe(true);
        expect(rowDying('hero')).toEqual(['Prone', 'Unconscious']);
        expect(r.message).toMatch(/DYING ✓0 ✗0/);

        // Round two: the same readied blow, now massive.
        repo().update('hero', { hp: 6, conditions: [] } as any);
        setToken('hero', { hp: 6, conditions: [], deathSaveFailures: 0 });
        setToken('gob', { reactionUsed: false, readied: { action: 'stab', trigger: 'the hero stirs', attack: { attackBonus: 100, damage: '1d1+29' } } });
        const k = await manage({ action: 'trigger_readied', encounterId: enc, participantId: 'gob', targetId: 'hero' });
        expect(k.error).toBeUndefined();
        expect(stored('hero').isDead).toBe(true);
        expect(corpses('hero')).toHaveLength(1);
        expect(k.killed).toMatchObject({ participantId: 'hero' }); // one record, as combat_action attack reports
        expect(k.message).toMatch(/☠ Hero is dead/);
    });

    it('cast_spell: a save spell that drops the hero prints DYING, mirrors the sheet; massive damage kills with a corpse', async () => {
        mk('evoker', {
            stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 }, characterClass: 'wizard',
            knownSpells: ['Fireball'], preparedSpells: ['Fireball'], cantripsKnown: [],
            spellSlots: getInitialSpellSlots('wizard', 5), maxSpellLevel: getMaxSpellLevel('wizard', 5)
        });
        await start({ hp: 6 }, {}, [{ id: 'evoker', name: 'Evoker', hp: 30, maxHp: 30, initiative: 15, position: { x: 5, y: 5 } }]);
        // The evoker acts: medic → evoker.
        await manage({ action: 'advance', encounterId: enc, confirm: true });
        // Every die at its minimum (8d6 = 8 fire): the hero fails the save and drops to 0 with 2 past.
        vi.spyOn(CombatEngine.prototype, 'rollDice').mockImplementation((n: string) => {
            const rolls: number[] = []; let modifier = 0;
            for (const t of parseDiceTerms(n)) { if (t.kind === 'dice') for (let i = 0; i < t.count; i++) rolls.push(t.sign); else modifier += t.sign * t.value; }
            const diceTotal = rolls.reduce((a, b) => a + b, 0);
            return { notation: n, rolls, diceTotal, modifier, total: diceTotal + modifier };
        });
        d20(1);
        const r = await act({ action: 'cast_spell', encounterId: enc, actorId: 'evoker', spellName: 'Fireball', targetId: 'hero' });
        expect(r.error).toBeUndefined();
        expect(stored('hero').hp).toBe(0);
        expect(hasCond(stored('hero'), 'unconscious', DYING_SOURCE)).toBe(true);
        expect(rowDying('hero')).toEqual(['Prone', 'Unconscious']);
        expect(r.rawText).toMatch(/DYING ✓0 ✗0/);
        expect(r.rawText).not.toMatch(/DEFEATED/);

        // Again at full dice: 48 fire on a 6 HP hero is 42 past 0 — dead outright.
        vi.restoreAllMocks();
        repo().update('hero', { hp: 6, conditions: [] } as any);
        setToken('hero', { hp: 6, conditions: [] });
        setToken('evoker', { actionsRemaining: 1, actionUsed: false, spellSlots: getInitialSpellSlots('wizard', 5) });
        vi.spyOn(CombatEngine.prototype, 'rollDice').mockImplementation((n: string) => maxDice(n));
        d20(1);
        const k = await act({ action: 'cast_spell', encounterId: enc, actorId: 'evoker', spellName: 'Fireball', targetId: 'hero' });
        expect(k.error).toBeUndefined();
        expect(stored('hero').isDead).toBe(true);
        expect(corpses('hero')).toHaveLength(1);
        expect(k.actionResult.killed).toEqual(expect.arrayContaining([expect.objectContaining({ participantId: 'hero' })]));
        expect(k.rawText).toMatch(/☠ Hero is dead/);
    });
});

describe('every road that heals above 0 wakes the sheet', () => {
    it('a natural 20 on advance takes the dying conditions off the sheet as well as the token', async () => {
        await start();
        repo().update('hero', { conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' }] } as any);
        d20(20);
        const r = await manage({ action: 'advance', encounterId: enc, confirm: true });
        expect(r.deathSaves[0]).toMatchObject({ participantId: 'hero', regainedHp: true });
        expect(row('hero').hp).toBe(1);
        expect(rowDying('hero')).toEqual([]);
    });

    it('a potion (inventory_manage use) on a dying sheet wakes it: HP above 0 and the dying conditions gone', async () => {
        repo().update('hero', { hp: 0, conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' }, { name: 'Poisoned', source: 'spider' }] } as any);
        const potion = embedded(await handleItemManage({ action: 'create', name: 'Potion of Healing', type: 'consumable', weight: 0.5, value: 50, properties: { healing: 4, effect: 'Restore 4 HP' } } as any, ctx as any), 'ITEM_MANAGE');
        const itemId = potion.item.id as string;
        await handleInventoryManage({ action: 'give', characterId: 'medic', itemId, quantity: 1 } as any, ctx as any);
        const used = embedded(await handleInventoryManage({ action: 'use', characterId: 'medic', itemId, targetId: 'hero' } as any, ctx as any), 'INVENTORY_MANAGE');
        expect(used.error).toBeUndefined();
        expect(row('hero').hp).toBe(4);
        expect(rowDying('hero')).toEqual([]);
        expect(row('hero').conditions.map((c: any) => c.name)).toEqual(['Poisoned']);
    });

    it("a stabilised sheet's 1d4-hour return to 1 HP fires through world_manage advance and wakes it: Stable, Unconscious and Prone come off", async () => {
        repo().update('hero', { hp: 0, conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' }] } as any);
        const s = await act({ action: 'stabilize', actorId: 'medic', targetId: 'hero', medicineBonus: 20 });
        expect(s.stabilized).toBe(true);
        expect(rowDying('hero')).toEqual(['Prone', 'Stable', 'Unconscious']);
        expect(s.recoversIn.scheduleId).toBeGreaterThan(0);
        const fired = await world({ action: 'advance', worldId: W, hours: 4, fireScheduled: true });
        expect(fired.firedCount).toBe(1);
        expect(row('hero').hp).toBe(1);
        expect(rowDying('hero')).toEqual([]);
    });

    it('the repository rule itself: an HP write that crosses 0 upward strips the dying conditions unless the call sets conditions', async () => {
        repo().update('hero', { hp: 0, conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Stable', source: 'stabilized by Medic' }, { name: 'Frightened', source: 'dragon' }] } as any);
        repo().update('hero', { hp: 3 } as any);
        expect(row('hero').conditions.map((c: any) => c.name)).toEqual(['Frightened']);
        // An explicit conditions list is the caller's to own.
        repo().update('hero', { hp: 0, conditions: [{ name: 'Unconscious', source: 'dying' }] } as any);
        repo().update('hero', { hp: 5, conditions: [{ name: 'Unconscious', source: 'dying' }] } as any);
        expect(row('hero').conditions.map((c: any) => c.name)).toEqual(['Unconscious']);
        // Staying at or below 0 touches nothing.
        repo().update('hero', { hp: 0 } as any);
        expect(row('hero').conditions.map((c: any) => c.name)).toEqual(['Unconscious']);
    });
});

describe('the slot and the sheet path', () => {
    it('a death save already rolled or posted this round is not rolled a second time when the slot comes up', async () => {
        await start();
        d20(15);
        const posted = await manage({ action: 'death_save', encounterId: enc, participantId: 'hero' });
        expect(posted.deathSave).toMatchObject({ successes: 1, failures: 0 });
        const spy = d20(3);
        const r = await manage({ action: 'advance', encounterId: enc, confirm: true }); // medic → hero's slot, same round
        expect(r.error).toBeUndefined();
        expect(stored('hero')).toMatchObject({ deathSaveSuccesses: 1, deathSaveFailures: 0 });
        expect(spy).not.toHaveBeenCalled();
        expect(r.rawText).toMatch(/Hero.*death save already made this round/);
        expect(r.currentTurn.id).toBe('gob');
    });

    it('the DEATH SAVE DUE line in the advance state view carries the real encounter id', async () => {
        await start({ deathSaveMode: 'prompt' });
        const r = await manage({ action: 'advance', encounterId: enc, confirm: true });
        expect(r.deathSaveDue).toMatchObject({ participantId: 'hero' });
        expect(r.rawText).not.toMatch(/<encounterId>/);
        expect(r.rawText).toContain(`combat_manage death_save {encounterId: '${enc}', participantId: 'hero'}`);
    });

    it('apply_damage on a sheet already at 0: massive damage kills with a corpse; a lesser blow on a Stable sheet makes it dying again', async () => {
        repo().update('hero', { hp: 0, conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' }, { name: 'Stable', source: 'stabilized by Medic' }] } as any);
        const again = await manage({ action: 'apply_damage', targetIds: ['hero'], dice: 3, source: 'a kick' });
        expect(again.error).toBeUndefined();
        expect(again.targets[0]).toMatchObject({ hpAfter: 0, dying: true });
        expect(again.message).toMatch(/no longer stable/i);
        expect(rowDying('hero')).toEqual(['Prone', 'Unconscious']);
        expect(corpses('hero')).toHaveLength(0);

        const massive = await manage({ action: 'apply_damage', targetIds: ['hero'], dice: 25, source: 'the ceiling' });
        expect(massive.targets[0]).toMatchObject({ dead: true, massiveDamage: true });
        expect(massive.killed).toEqual([expect.objectContaining({ characterId: 'hero' })]);
        expect(corpses('hero')).toHaveLength(1);
    });
});
