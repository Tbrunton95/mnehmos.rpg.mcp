/**
 * Play report 5, item 5: dying (the owner's spec).
 *
 * A participant with a character row (pc, npc) tracks death saves; quick
 * spawns, bestiary mooks and unit models just die at 0 HP. On advance into
 * a dying tracked slot the engine rolls the save itself (auto) or stops and
 * prints DEATH SAVE DUE (prompt mode, per world or per character). Damage at
 * 0 HP adds failures (two on a crit or a melee hit on the unconscious);
 * massive damage kills outright, on the dropping blow too. Healing clears
 * the counters. combat_action stabilize spends an action on a Medicine DC 10
 * (automatic with a healer's kit or Spare the Dying) and files the 1d4-hour
 * return to 1 HP as a scheduled change. Outside a fight apply_damage says
 * DYING and offers the stabilise call.
 */
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { handleCharacterManage } from '../../src/server/consolidated/character-manage.js';
import { handleRestManage } from '../../src/server/consolidated/rest-manage.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { tracksDeathSaves, isDying, dyingLabel, applyDeathSaveOutcome, normalizeDeathSaveOutcome, DYING_SOURCE } from '../../src/engine/combat/dying.js';

type P = CombatParticipant & Record<string, unknown>;
const ctx = { sessionId: 'dying' };
const embedded = (res: any, tag: string) => {
    const m = res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : { rawText: res.content[0].text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');
const character = async (args: Record<string, unknown>) => embedded(await handleCharacterManage(args, ctx as any), 'CHARACTER_MANAGE');
const rest = async (args: Record<string, unknown>) => JSON.parse((await handleRestManage(args, ctx as any)).content[0].text);
const now = () => new Date().toISOString();

/** Queue the next engine d20s (the death save, the Medicine check). */
const d20 = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

const token = (over: Partial<P>): P => ({ id: 'x', name: 'X', initiativeBonus: 0, hp: 10, maxHp: 10, conditions: [], ...over }) as P;
const who = (e: CombatEngine, id: string) => e.getState()!.participants.find(p => p.id === id)! as P;
const current = (e: CombatEngine) => e.getState()!.turnOrder[e.getState()!.currentTurnIndex];
const hasCond = (p: P, type: string, source?: string) => p.conditions.some(c => c.type === type && (source === undefined || c.sourceId === source));

/** gob (init 20) acts first; the hero (init 10) lies at 0 HP; the orc (init 5) follows. */
function fight(seed: string, hero: Partial<P> = {}) {
    const e = new CombatEngine(seed);
    e.startEncounter([
        token({ id: 'gob', name: 'Goblin', initiative: 20, isEnemy: true, position: { x: 0, y: 0 } }),
        token({ id: 'hero', name: 'Hero', initiative: 10, hp: 0, maxHp: 20, deathSaves: true, position: { x: 1, y: 0 }, ...hero }),
        token({ id: 'orc', name: 'Orc', initiative: 5, isEnemy: true, position: { x: 5, y: 5 } })
    ]);
    return e;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('dying helpers', () => {
    it('tracks death saves only on a flagged token that is not a unit', () => {
        expect(tracksDeathSaves(token({ deathSaves: true }))).toBe(true);
        expect(tracksDeathSaves(token({}))).toBe(false);
        expect(tracksDeathSaves(token({ deathSaves: true, unit: { models: 10, hpPerModel: 1, packed: false, attackBonus: 0 } } as any))).toBe(false);
    });

    it('isDying: at 0 HP, tracked, neither dead nor stable (a nonlethal knockout is stable, not dying)', () => {
        expect(isDying(token({ hp: 0, deathSaves: true }))).toBe(true);
        expect(isDying(token({ hp: 0, deathSaves: true, isStabilized: true }))).toBe(false);
        expect(isDying(token({ hp: 0, deathSaves: true, isDead: true }))).toBe(false);
        expect(isDying(token({ hp: 3, deathSaves: true }))).toBe(false);
        expect(isDying(token({ hp: 0 }))).toBe(false);
    });

    it('labels: DYING ✓s ✗f, then STABLE, then DEAD', () => {
        expect(dyingLabel(token({ hp: 0, deathSaves: true, deathSaveSuccesses: 1, deathSaveFailures: 2 }))).toBe('DYING ✓1 ✗2');
        expect(dyingLabel(token({ hp: 0, deathSaves: true, isStabilized: true }))).toBe('STABLE');
        expect(dyingLabel(token({ hp: 0, isDead: true }))).toBe('DEAD');
        expect(dyingLabel(token({ hp: 0 }))).toBeUndefined();
    });

    it('applies every outcome: 10+ success, 9- failure, nat 1 two failures, nat 20 back to 1 HP', () => {
        const p = token({ hp: 0, deathSaves: true });
        expect(applyDeathSaveOutcome(p, 'success', 14)).toMatchObject({ successes: 1, failures: 0, success: true });
        expect(applyDeathSaveOutcome(p, 'failure', 4)).toMatchObject({ successes: 1, failures: 1, success: false });
        expect(applyDeathSaveOutcome(p, 'nat1', 1)).toMatchObject({ failures: 3, isDead: true, isNat1: true });
        const q = token({ hp: 0, deathSaves: true, deathSaveSuccesses: 2, deathSaveFailures: 2 });
        expect(applyDeathSaveOutcome(q, 'success', 10)).toMatchObject({ successes: 3, isStabilized: true });
        const r = token({ hp: 0, deathSaves: true, deathSaveFailures: 2 });
        expect(applyDeathSaveOutcome(r, 'nat20', 20)).toMatchObject({ regainedHp: true, isNat20: true, successes: 0, failures: 0 });
        expect(r.hp).toBe(1);
    });

    it('normalises posted outcomes', () => {
        expect(normalizeDeathSaveOutcome('nat 20')).toBe('nat20');
        expect(normalizeDeathSaveOutcome('natural_1')).toBe('nat1');
        expect(normalizeDeathSaveOutcome('pass')).toBe('success');
        expect(normalizeDeathSaveOutcome('FAIL')).toBe('failure');
        expect(normalizeDeathSaveOutcome(20)).toBe('nat20');
        expect(normalizeDeathSaveOutcome(13)).toBe('success');
        expect(normalizeDeathSaveOutcome('maybe')).toBeUndefined();
    });
});

describe('engine: advance into a dying tracked slot (auto mode)', () => {
    it('10+ is a success, logged on the fight dice; the slot passes to the next combatant', () => {
        const e = fight('auto-success');
        const spy = d20(14);
        e.nextTurnWithConditions();
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'death save', forId: 'hero' }));
        expect(current(e)).toBe('orc');
        expect(who(e, 'hero')).toMatchObject({ deathSaveSuccesses: 1, deathSaveFailures: 0 });
        expect(e.turnStartNotes.join('\n')).toMatch(/Hero.*death save.*14.*success.*✓1 ✗0/);
        expect(e.deathSaveEvents).toHaveLength(1);
        expect(e.deathSaveEvents[0]).toMatchObject({ participantId: 'hero', roll: 14, success: true });
    });

    it('9 or lower is a failure; a natural 1 is two', () => {
        const e = fight('auto-fail');
        d20(6);
        e.nextTurnWithConditions();
        expect(who(e, 'hero').deathSaveFailures).toBe(1);
        expect(e.turnStartNotes.join('\n')).toMatch(/failure.*✓0 ✗1/);
        const f = fight('auto-nat1');
        d20(1);
        f.nextTurnWithConditions();
        expect(who(f, 'hero').deathSaveFailures).toBe(2);
        expect(f.turnStartNotes.join('\n')).toMatch(/NATURAL 1/);
    });

    it('a natural 20 brings them back to 1 HP, conscious, and they take this turn (no auto-advance)', () => {
        const e = fight('auto-nat20', { conditions: [] });
        d20(20);
        e.nextTurnWithConditions();
        expect(current(e)).toBe('hero');
        const hero = who(e, 'hero');
        expect(hero.hp).toBe(1);
        expect(hero.deathSaveSuccesses ?? 0).toBe(0);
        expect(hasCond(hero, 'unconscious')).toBe(false);
        expect(e.turnStartNotes.join('\n')).toMatch(/NATURAL 20.*1 HP/);
    });

    it('three successes: stable, unconscious, no more saves are rolled', () => {
        const e = fight('auto-stable', { deathSaveSuccesses: 2 });
        const spy = d20(12);
        e.nextTurnWithConditions();
        expect(who(e, 'hero')).toMatchObject({ isStabilized: true, deathSaveSuccesses: 3 });
        expect(e.turnStartNotes.join('\n')).toMatch(/STABLE/);
        expect(current(e)).toBe('orc');
        // Round 2: gob, then the hero's slot passes without a roll.
        e.nextTurnWithConditions();
        e.nextTurnWithConditions();
        expect(current(e)).toBe('orc');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('three failures: dead, recorded for the handler to run the kill', () => {
        const e = fight('auto-dead', { deathSaveFailures: 2 });
        d20(3);
        e.nextTurnWithConditions();
        expect(who(e, 'hero')).toMatchObject({ isDead: true, deathSaveFailures: 3 });
        expect(e.turnStartNotes.join('\n')).toMatch(/DEAD/);
        expect(e.deathSaveEvents[0]).toMatchObject({ participantId: 'hero', isDead: true });
        expect(current(e)).toBe('orc');
    });

    it('mooks, the stable and the dead pass silently: no roll, no note', () => {
        const mook = new CombatEngine('mook');
        mook.startEncounter([
            token({ id: 'gob', name: 'Goblin', initiative: 20 }),
            token({ id: 'rat', name: 'Rat', initiative: 10, hp: 0, isEnemy: true }),
            token({ id: 'orc', name: 'Orc', initiative: 5 })
        ]);
        const spy = d20(14);
        mook.nextTurnWithConditions();
        expect(current(mook)).toBe('orc');
        expect(spy).not.toHaveBeenCalled();
        expect(mook.turnStartNotes).toEqual([]);
        // A nonlethal knockout sets isStabilized: stable, never dying.
        const ko = fight('ko', { isStabilized: true });
        ko.nextTurnWithConditions();
        expect(spy).not.toHaveBeenCalled();
        expect(current(ko)).toBe('orc');
        expect(ko.turnStartNotes).toEqual([]);
    });

    it('prompt mode (world default) stops at the slot with DEATH SAVE DUE and the exact call; nothing is rolled', () => {
        const e = fight('prompt-world');
        const spy = d20(14);
        e.nextTurnWithConditions({ deathSaveMode: 'prompt' });
        expect(spy).not.toHaveBeenCalled();
        expect(current(e)).toBe('hero');
        expect(who(e, 'hero').deathSaveDue).toBe(true);
        expect(e.turnStartNotes.join('\n')).toMatch(/DEATH SAVE DUE: Hero \(0 HP, ✓0 ✗0\).*combat_manage death_save \{encounterId: 'prompt-world', participantId: 'hero'\}/);
    });

    it('a per-character deathSaveMode wins over the world default, both ways', () => {
        const e = fight('prompt-char', { deathSaveMode: 'prompt' });
        d20(14);
        e.nextTurnWithConditions();
        expect(current(e)).toBe('hero');
        const f = fight('auto-char', { deathSaveMode: 'auto' });
        const spy = d20(14);
        f.nextTurnWithConditions({ deathSaveMode: 'prompt' });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(current(f)).toBe('orc');
    });

    it('a posted outcome clears the due flag and counts', () => {
        const e = fight('posted');
        e.nextTurnWithConditions({ deathSaveMode: 'prompt' });
        const r = e.postDeathSave('hero', 'failure');
        expect(r).toMatchObject({ failures: 1, posted: 'failure' });
        expect(who(e, 'hero').deathSaveDue).toBe(false);
        expect(who(e, 'hero').deathSaveRound).toBe(1);
    });
});

describe('engine: damage and healing at 0 HP', () => {
    const hit = (e: CombatEngine, extra: Record<string, unknown>, damage = 3, outcome: 'hit' | 'crit' = 'hit') =>
        e.executeAttack('gob', 'hero', 5, 10, damage, 'slashing', false, false, undefined, undefined, outcome, undefined, extra);

    it('dropping a tracked token to 0 applies Unconscious + Prone (source dying); a mook gets nothing', () => {
        const e = fight('drop', { hp: 5 });
        const r = hit(e, { ranged: true }, 7);
        const hero = who(e, 'hero');
        expect(hero.hp).toBe(0);
        expect(hasCond(hero, 'unconscious', DYING_SOURCE)).toBe(true);
        expect(hasCond(hero, 'prone', DYING_SOURCE)).toBe(true);
        expect(r.dying).toMatchObject({ dropped: true, successes: 0, failures: 0, dead: false });
        expect(r.message).toMatch(/DYING/);
        e.executeAttack('gob', 'orc', 5, 10, 30, 'slashing', false, false, undefined, undefined, 'hit');
        expect(who(e, 'orc').hp).toBe(0);
        expect(who(e, 'orc').conditions).toEqual([]);
    });

    it('a ranged hit while down is one failure; a crit, or a melee hit within 5 ft, is two', () => {
        const e = fight('down-hits');
        expect(hit(e, { ranged: true }).dying).toMatchObject({ failuresAdded: 1, failures: 1 });
        expect(hit(e, {}).dying).toMatchObject({ failuresAdded: 2, failures: 3, dead: true });
        const f = fight('down-crit');
        expect(hit(f, { ranged: true }, 3, 'crit').dying).toMatchObject({ failuresAdded: 2, failures: 2 });
    });

    it('massive damage kills outright: leftover past 0 at or above max HP, on the dropping blow too', () => {
        const e = fight('massive', { hp: 8, maxHp: 20 });
        const r = hit(e, { ranged: true }, 28);
        expect(who(e, 'hero').isDead).toBe(true);
        expect(r.dying).toMatchObject({ dead: true, instantDeath: true });
        expect(r.message).toMatch(/DEAD/);
        const f = fight('not-massive', { hp: 8, maxHp: 20 });
        hit(f, { ranged: true }, 27);
        expect(who(f, 'hero').isDead ?? false).toBe(false);
        const g = fight('massive-at-zero');
        hit(g, { ranged: true }, 20);
        expect(who(g, 'hero').isDead).toBe(true);
    });

    it('applyDamage (area, ongoing) adds a failure at 0 HP, two when the caller says crit', () => {
        const e = fight('area');
        expect(e.applyDamage('hero', 4)).toMatchObject({ failuresAdded: 1 });
        expect(e.applyDamage('hero', 4, { crit: true })).toMatchObject({ failuresAdded: 2, dead: true });
        const m = new CombatEngine('area-mook');
        m.startEncounter([token({ id: 'rat', hp: 0 })]);
        expect(m.applyDamage('rat', 4)).toBeUndefined();
    });

    it('damage to a stable creature makes it dying again', () => {
        const e = fight('stable-hit', { isStabilized: true });
        hit(e, { ranged: true });
        expect(who(e, 'hero')).toMatchObject({ isStabilized: false, deathSaveFailures: 1 });
    });

    it('healing above 0 clears both counters, the due flag and the dying Unconscious (prone stays: stand up)', () => {
        const e = fight('heal', { deathSaveSuccesses: 1, deathSaveFailures: 2, deathSaveDue: true });
        who(e, 'hero').conditions = [
            { id: 'u', type: 'unconscious', durationType: 'permanent', sourceId: DYING_SOURCE },
            { id: 'p', type: 'prone', durationType: 'permanent', sourceId: DYING_SOURCE }
        ] as any;
        e.heal('hero', 5);
        const hero = who(e, 'hero');
        expect(hero).toMatchObject({ hp: 5, deathSaveSuccesses: 0, deathSaveFailures: 0, deathSaveDue: false });
        expect(hasCond(hero, 'unconscious')).toBe(false);
        expect(hasCond(hero, 'prone')).toBe(true);
        const f = fight('heal-action', { deathSaveFailures: 2 });
        who(f, 'hero').conditions = [{ id: 'u', type: 'unconscious', durationType: 'permanent', sourceId: DYING_SOURCE }] as any;
        f.executeHeal('orc', 'hero', 4);
        expect(who(f, 'hero')).toMatchObject({ hp: 4, deathSaveFailures: 0 });
        expect(hasCond(who(f, 'hero'), 'unconscious')).toBe(false);
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
        id, name: id[0].toUpperCase() + id.slice(1), stats: { str: 10, dex: 10, con: 10, int: 10, wis: 14, cha: 10 },
        hp: 20, maxHp: 20, ac: 12, level: 5, createdAt: now(), updatedAt: now(), ...extra
    } as any);
    const corpses = (id: string) => (getDb().prepare('SELECT * FROM corpses WHERE character_id = ?').all(id) as any[]);
    const scheduled = (id: string) => (getDb().prepare('SELECT * FROM scheduled_state_changes WHERE character_id = ?').all(id) as any[]);

    /** medic (init 20) first; the hero (init 10) lies at 0 HP; a sheetless goblin (init 5) stands; a sheetless rat (init 1) lies at 0 as a mook. */
    const start = async (hero: Record<string, unknown> = {}, more: Array<Record<string, unknown>> = [], opts: Record<string, unknown> = {}) => {
        // create does not write token HP to the rows; the next sync reads the row, so the sheet must agree.
        repo().update('hero', { hp: (hero.hp as number | undefined) ?? 0 } as any);
        const created = await manage({ action: 'create', seed: 'dying-tools', worldId: W, participants: [
            { id: 'medic', name: 'Medic', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'hero', name: 'Hero', hp: 0, maxHp: 20, initiative: 10, position: { x: 1, y: 0 }, ...hero },
            { id: 'gob', name: 'Goblin', hp: 7, maxHp: 7, initiative: 5, isEnemy: true, position: { x: 6, y: 6 } },
            { id: 'rat', name: 'Rat', hp: 0, maxHp: 3, initiative: 1, isEnemy: true, position: { x: 7, y: 7 } },
            ...more
        ], ...opts });
        enc = created.encounterId;
        return created;
    };
    const setToken = (id: string, patch: Record<string, unknown>) => {
        const r = new EncounterRepository(getDb());
        const st = r.loadState(enc)!;
        Object.assign(st.participants.find(p => p.id === id)!, patch);
        r.saveState(enc, st);
        clearCombatState();
    };

    beforeEach(() => {
        closeDb(); getDb(':memory:'); clearCombatState();
        new WorldRepository(getDb()).create({ id: W, name: 'Varek', seed: 's', width: 10, height: 10, createdAt: now(), updatedAt: now(), environment: { day: 12, time: '08:00' } } as any);
        mk('medic', { skillProficiencies: ['Medicine'] });
        mk('hero', { hp: 0 });
    });
    afterEach(() => { closeDb(); });

    describe('who tracks death saves', () => {
        it('a pc or npc row tracks; an enemy row and a sheetless mook do not; the row flag and a token flag override', async () => {
            mk('villain', { characterType: 'enemy', hp: 0 });
            mk('aide', { characterType: 'npc', hp: 0 });
            mk('optout', { characterType: 'pc', hp: 0, deathSaves: false });
            await start({}, [
                { id: 'villain', name: 'Villain', hp: 0, maxHp: 20, initiative: 4, isEnemy: true },
                { id: 'aide', name: 'Aide', hp: 0, maxHp: 20, initiative: 3 },
                { id: 'optout', name: 'Optout', hp: 0, maxHp: 20, initiative: 2 },
                { id: 'boss', name: 'Boss', hp: 0, maxHp: 20, initiative: 1, isEnemy: true, deathSaves: true }
            ]);
            const got = await manage({ action: 'get', encounterId: enc });
            const by = (id: string) => got.participants.find((p: any) => p.id === id);
            expect(by('hero').deathSaves).toMatchObject({ status: 'dying', successes: 0, failures: 0 });
            expect(by('aide').deathSaves).toMatchObject({ status: 'dying' });
            expect(by('boss').deathSaves).toMatchObject({ status: 'dying' });
            expect(by('villain').deathSaves).toBeUndefined();
            expect(by('rat').deathSaves).toBeUndefined();
            expect(by('optout').deathSaves).toBeUndefined();
            expect(row('optout').deathSaves).toBe(false);
            expect(got.rawText).toMatch(/Hero.*🩸 DYING ✓0 ✗0/);
            expect(got.rawText).toMatch(/Rat.*💀 DEFEATED/);
        });
    });

    describe('advance', () => {
        it('auto-rolls the save; a natural 20 writes 1 HP to the sheet and the next sync keeps it', async () => {
            await start();
            d20(20);
            const r = await manage({ action: 'advance', encounterId: enc, confirm: true });
            expect(r.currentTurn.id).toBe('hero');
            expect(r.deathSaves[0]).toMatchObject({ participantId: 'hero', roll: 20, regainedHp: true });
            expect(r.rawText).toMatch(/NATURAL 20/);
            expect(row('hero').hp).toBe(1);
            const got = await manage({ action: 'get', encounterId: enc });
            expect(got.participants.find((p: any) => p.id === 'hero').hp).toBe(1);
        });

        it('three failures run the kill: sheet at 0, a corpse, DEAD printed plainly', async () => {
            await start();
            setToken('hero', { deathSaveFailures: 2 });
            d20(4);
            const r = await manage({ action: 'advance', encounterId: enc, confirm: true });
            expect(r.rawText).toMatch(/Hero.*DEAD/);
            expect(r.deathSaves[0]).toMatchObject({ participantId: 'hero', isDead: true });
            expect(r.killed[0]).toMatchObject({ participantId: 'hero', cause: expect.stringMatching(/death save/) });
            expect(corpses('hero')).toHaveLength(1);
            expect(r.currentTurn.id).toBe('gob');
            expect((await manage({ action: 'get', encounterId: enc })).rawText).toMatch(/Hero.*☠ DEAD/);
        });

        it('a success and a failure show as counters in the state view and STATE_JSON', async () => {
            await start();
            d20(15);
            await manage({ action: 'advance', encounterId: enc, confirm: true });
            const got = await manage({ action: 'get', encounterId: enc });
            expect(got.rawText).toMatch(/Hero.*🩸 DYING ✓1 ✗0/);
            expect(got.participants.find((p: any) => p.id === 'hero').deathSaves).toMatchObject({ successes: 1, failures: 0, status: 'dying' });
        });

        it('prompt mode from the world: DEATH SAVE DUE with the call, advance refused until the save is rolled', async () => {
            new WorldRepository(getDb()).updateEnvironment(W, { deathSaveMode: 'prompt' });
            await start();
            const spy = d20(14);
            const due = await manage({ action: 'advance', encounterId: enc, confirm: true });
            expect(spy).not.toHaveBeenCalled();
            expect(due.currentTurn.id).toBe('hero');
            expect(due.deathSaveDue).toMatchObject({ participantId: 'hero', name: 'Hero', successes: 0, failures: 0 });
            expect(due.rawText).toMatch(/DEATH SAVE DUE: Hero/);
            expect(due.rawText).toContain(`combat_manage death_save {encounterId: '${enc}', participantId: 'hero'}`);
            const refused = await manage({ action: 'advance', encounterId: enc });
            expect(refused.error).toBe(true);
            expect(refused.writes).toBe('none');
            expect(refused.message).toMatch(/DEATH SAVE DUE/);
            const save = await manage({ action: 'death_save', encounterId: enc, participantId: 'hero' });
            expect(save.deathSave).toMatchObject({ participantId: 'hero', roll: 14, success: true });
            const next = await manage({ action: 'advance', encounterId: enc });
            expect(next.currentTurn.id).toBe('gob');
        });

        it('prompt mode per character (combat_profile.deathSaveMode) does the same in an auto world', async () => {
            repo().update('hero', { deathSaveMode: 'prompt' } as any);
            expect(row('hero').deathSaveMode).toBe('prompt');
            await start();
            const spy = d20(14);
            const due = await manage({ action: 'advance', encounterId: enc, confirm: true });
            expect(spy).not.toHaveBeenCalled();
            expect(due.deathSaveDue.participantId).toBe('hero');
        });
    });

    describe('death_save', () => {
        it('takes participantId (characterId still works); both differing or neither is refused with writes none', async () => {
            await start();
            const a = await manage({ action: 'death_save', encounterId: enc, participantId: 'hero' });
            expect(a.deathSave).toMatchObject({ participantId: 'hero', characterId: 'hero' });
            const b = await manage({ action: 'death_save', encounterId: enc, characterId: 'hero' });
            expect(b.deathSave.participantId).toBe('hero');
            const both = await manage({ action: 'death_save', encounterId: enc, participantId: 'hero', characterId: 'gob' });
            expect(both.error).toBe(true);
            expect(both.writes).toBe('none');
            const neither = await manage({ action: 'death_save', encounterId: enc });
            expect(neither.error).toBeTruthy();
        });

        it('posts an outcome without a die; a posted nat 20 writes 1 HP to the sheet', async () => {
            await start();
            const spy = d20(5);
            const r = await manage({ action: 'death_save', encounterId: enc, participantId: 'hero', outcome: 'nat20' });
            expect(spy).not.toHaveBeenCalled();
            expect(r.deathSave).toMatchObject({ posted: 'nat20', regainedHp: true, isNat20: true });
            expect(stored('hero').hp).toBe(1);
            expect(row('hero').hp).toBe(1);
            await start();
            const f = await manage({ action: 'death_save', encounterId: enc, participantId: 'hero', outcome: 'fail' });
            expect(f.deathSave).toMatchObject({ posted: 'failure', failures: 1 });
        });

        it('three failures by hand kill through character_manage kill (corpse, cause)', async () => {
            await start();
            setToken('hero', { deathSaveFailures: 2 });
            const r = await manage({ action: 'death_save', encounterId: enc, participantId: 'hero', outcome: 'failure' });
            expect(r.deathSave.isDead).toBe(true);
            expect(r.killed).toMatchObject({ participantId: 'hero' });
            expect(corpses('hero')).toHaveLength(1);
            expect(r.rawText).toMatch(/DEAD/);
        });
    });

    describe('damage and healing through the tools', () => {
        it('a hit on the downed hero adds failures and reports them; the dropping blow adds the conditions and mirrors them', async () => {
            await start({ hp: 6 });
            await manage({ action: 'advance', encounterId: enc, confirm: true }); // medic → hero passes? no: hero is at 6 HP, so hero acts
            await manage({ action: 'advance', encounterId: enc, confirm: true }); // → gob
            const drop = await act({ action: 'attack', encounterId: enc, actorId: 'gob', targetId: 'hero', outcome: 'hit', damage: 6, ranged: true });
            expect(drop.actionResult.dying).toMatchObject({ dropped: true, failures: 0 });
            expect(drop.rawText).toMatch(/DYING ✓0 ✗0/);
            const hero = stored('hero');
            expect(hasCond(hero, 'unconscious', DYING_SOURCE)).toBe(true);
            expect(hasCond(hero, 'prone', DYING_SOURCE)).toBe(true);
            expect(row('hero').conditions.map((c: any) => `${c.name}:${c.source}`)).toEqual(expect.arrayContaining(['Unconscious:dying', 'Prone:dying']));
            // The action is spent: the second swing is a reaction (an opportunity attack).
            const again = await act({ action: 'attack', encounterId: enc, actorId: 'gob', targetId: 'hero', outcome: 'hit', damage: 2, ranged: true, reaction: true });
            expect(again.actionResult.dying).toMatchObject({ failuresAdded: 1, failures: 1 });
            expect(again.rawText).toMatch(/DYING ✓0 ✗1/);
        });

        it('massive damage from a hit kills: the sheet is killed with a corpse', async () => {
            await start({ hp: 6 });
            await manage({ action: 'advance', encounterId: enc, confirm: true });
            await manage({ action: 'advance', encounterId: enc, confirm: true });
            const r = await act({ action: 'attack', encounterId: enc, actorId: 'gob', targetId: 'hero', outcome: 'hit', damage: 30, ranged: true });
            expect(r.actionResult.dying).toMatchObject({ dead: true, instantDeath: true });
            expect(r.actionResult.killed).toMatchObject({ participantId: 'hero' });
            expect(corpses('hero')).toHaveLength(1);
            expect(row('hero').hp).toBe(0);
        });

        it('apply_damage in the fight adds a failure to the dying and reports DYING', async () => {
            await start();
            const r = await manage({ action: 'apply_damage', encounterId: enc, targetIds: ['hero', 'rat'], dice: 3, source: 'burning oil' });
            expect(r.targets[0].dying).toMatchObject({ failuresAdded: 1, failures: 1 });
            expect(r.message).toMatch(/Hero[\s\S]*DYING ✓0 ✗1/);
            expect(r.message).toMatch(/Rat[\s\S]*DEFEATED/);
        });

        it('adjust_hp above 0 and a heal clear the counters and wake the hero (sheet too)', async () => {
            await start();
            repo().update('hero', { conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' }] } as any);
            setToken('hero', { deathSaveSuccesses: 1, deathSaveFailures: 2, conditions: [{ id: 'u', type: 'unconscious', durationType: 'permanent', sourceId: 'dying' }] });
            const r = await manage({ action: 'adjust_hp', encounterId: enc, participantId: 'hero', value: 5, reason: 'potion posted at the table' });
            expect(r.deathSaves).toEqual({ successes: 0, failures: 0 });
            expect(hasCond(stored('hero'), 'unconscious')).toBe(false);
            expect(row('hero').conditions.some((c: any) => c.source === 'dying')).toBe(false);
            // Back down, then a heal action.
            await manage({ action: 'adjust_hp', encounterId: enc, participantId: 'hero', value: 0, reason: 'posted' });
            setToken('hero', { deathSaveFailures: 2, conditions: [{ id: 'u', type: 'unconscious', durationType: 'permanent', sourceId: 'dying' }] });
            repo().update('hero', { conditions: [{ name: 'Unconscious', source: 'dying' }] } as any);
            const h = await act({ action: 'heal', encounterId: enc, actorId: 'medic', targetId: 'hero', amount: 4 });
            expect(h.error).toBeUndefined();
            expect(stored('hero')).toMatchObject({ hp: 4, deathSaveFailures: 0 });
            expect(hasCond(stored('hero'), 'unconscious')).toBe(false);
            expect(row('hero').conditions.some((c: any) => c.source === 'dying')).toBe(false);
        });
    });

    describe('combat_action stabilize', () => {
        it('adjacent, spends the action, Medicine DC 10 on the fight dice; success files the 1d4-hour return to 1 HP', async () => {
            await start();
            setToken('hero', { deathSaveSuccesses: 1, deathSaveFailures: 2 });
            const spy = d20(12);
            const r = await act({ action: 'stabilize', encounterId: enc, actorId: 'medic', targetId: 'hero' });
            expect(r.error).toBeUndefined();
            expect(spy).toHaveBeenCalledWith(expect.objectContaining({ purpose: expect.stringMatching(/stabili[sz]e.*Medicine/i), forId: 'medic' }));
            // WIS 14 (+2) + proficiency +3 at level 5 = +5
            expect(r.check).toMatchObject({ skill: 'Medicine', natural: 12, modifier: 5, total: 17, dc: 10, success: true });
            expect(r.stabilized).toBe(true);
            expect(stored('hero')).toMatchObject({ isStabilized: true, deathSaveSuccesses: 0, deathSaveFailures: 0 });
            expect(stored('medic').actionUsed).toBe(true);
            expect(r.recoversIn.hours).toBeGreaterThanOrEqual(1);
            expect(r.recoversIn.hours).toBeLessThanOrEqual(4);
            const rows = scheduled('hero');
            expect(rows).toHaveLength(1);
            expect(JSON.parse(rows[0].writes)).toEqual([{ op: 'adjust_hp', delta: 1 }]);
            expect(rows[0].fires_at_day).toBeCloseTo(12 + 8 / 24 + r.recoversIn.hours / 24, 5);
            expect(rows[0].world_id).toBe(W);
            expect(r.recoversIn.scheduleId).toBe(rows[0].id);
            expect((await manage({ action: 'get', encounterId: enc })).rawText).toMatch(/Hero.*💤 STABLE/);
        });

        it('a failed check still spends the action and leaves them dying', async () => {
            await start();
            d20(2);
            const r = await act({ action: 'stabilize', encounterId: enc, actorId: 'medic', targetId: 'hero' });
            expect(r.check).toMatchObject({ total: 7, success: false });
            expect(r.stabilized).toBe(false);
            expect(stored('hero').isStabilized ?? false).toBe(false);
            expect(stored('medic').actionUsed).toBe(true);
            expect(scheduled('hero')).toHaveLength(0);
        });

        it("a healer's kit makes it automatic and spends a charge", async () => {
            getDb().prepare("INSERT INTO items (id, name, type, weight, value, properties, created_at, updated_at) VALUES ('kit', ?, 'misc', 3, 5, ?, ?, ?)").run("Healer's Kit", JSON.stringify({ healersKit: true, uses: 10 }), now(), now());
            getDb().prepare('INSERT INTO inventory_items (character_id, item_id, quantity) VALUES (?, ?, 1)').run('medic', 'kit');
            await start();
            const spy = d20(1);
            const r = await act({ action: 'stabilize', encounterId: enc, actorId: 'medic', targetId: 'hero' });
            expect(r.error).toBeUndefined();
            expect(spy).not.toHaveBeenCalled();
            expect(r.stabilized).toBe(true);
            expect(r.kit).toMatchObject({ name: "Healer's Kit", chargesLeft: 9 });
            const inst = getDb().prepare("SELECT charges FROM item_instances WHERE owner_character_id = 'medic' AND template_id = 'kit'").get() as any;
            expect(inst.charges).toBe(9);
            expect(stored('medic').actionUsed).toBe(true);
        });

        it('Spare the Dying (a cantrip or ability on the sheet) is automatic too', async () => {
            repo().update('medic', { cantripsKnown: ['Spare the Dying'] } as any);
            await start();
            const spy = d20(1);
            const r = await act({ action: 'stabilize', encounterId: enc, actorId: 'medic', targetId: 'hero' });
            expect(spy).not.toHaveBeenCalled();
            expect(r.stabilized).toBe(true);
            expect(r.feature).toMatch(/Spare the Dying/);
        });

        it('refuses before anything is spent: not adjacent, action spent, target up, target dead or already stable', async () => {
            await start({}, [{ id: 'far', name: 'Far', hp: 0, maxHp: 10, initiative: 1, deathSaves: true, position: { x: 8, y: 8 } }]);
            const far = await act({ action: 'stabilize', encounterId: enc, actorId: 'medic', targetId: 'far' });
            expect(far.error).toBe(true);
            expect(far.writes).toBe('none');
            expect(far.message).toMatch(/adjacent|5 ft/);
            expect(stored('medic').actionUsed ?? false).toBe(false);
            const up = await act({ action: 'stabilize', encounterId: enc, actorId: 'medic', targetId: 'gob' });
            expect(up.error).toBe(true);
            expect(up.message).toMatch(/0 HP/);
            setToken('hero', { isStabilized: true });
            const stable = await act({ action: 'stabilize', encounterId: enc, actorId: 'medic', targetId: 'hero' });
            expect(stable.error).toBe(true);
            expect(stable.message).toMatch(/already stable/i);
            setToken('hero', { isStabilized: false, isDead: true });
            const dead = await act({ action: 'stabilize', encounterId: enc, actorId: 'medic', targetId: 'hero' });
            expect(dead.error).toBe(true);
            expect(dead.message).toMatch(/dead/i);
            setToken('hero', { isDead: false });
            setToken('medic', { actionUsed: true });
            const spent = await act({ action: 'stabilize', encounterId: enc, actorId: 'medic', targetId: 'hero' });
            expect(spent.error).toBe(true);
            expect(spent.message).toMatch(/action/i);
        });

        it('with no encounter it runs on the sheets: Medicine on logged dice, Stable written, the 1d4 hours filed', async () => {
            repo().update('hero', { conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' }] } as any);
            const r = await act({ action: 'stabilize', actorId: 'medic', targetId: 'hero', medicineBonus: 9 });
            expect(r.error).toBeUndefined();
            expect(r.writesTo).toBe('sheet');
            expect(r.check).toMatchObject({ modifier: 9, dc: 10 });
            expect(r.stabilized).toBe(r.check.success);
            if (r.stabilized) {
                expect(row('hero').conditions.some((c: any) => c.name === 'Stable')).toBe(true);
                expect(scheduled('hero')).toHaveLength(1);
            }
            const roll = getDb().prepare("SELECT * FROM roll_log WHERE purpose LIKE '%Medicine%' AND for_id = 'medic'").all();
            expect(roll.length).toBeGreaterThan(0);
        });

        it('is advertised on combat_action with its keys mirrored', () => {
            expect(CombatActionTool.description).toMatch(/stabilize/);
            const shape = (CombatActionTool.inputSchema as any).shape;
            expect(shape.useKit).toBeDefined();
            expect(shape.medicineBonus).toBeDefined();
            expect((CombatActionTool.actionSchemas as any).stabilize).toBeDefined();
        });
    });

    describe('outside a fight', () => {
        it('apply_damage on sheets: a tracked sheet dropped to 0 says DYING and offers the stabilise call', async () => {
            repo().update('hero', { hp: 8 } as any);
            const r = await manage({ action: 'apply_damage', targetIds: ['hero'], dice: 10, source: 'rockfall' });
            expect(r.targets[0]).toMatchObject({ hpAfter: 0, dying: true });
            expect(r.message).toMatch(/DYING/);
            expect(r.message).toMatch(/combat_action stabilize \{actorId: '<healer>', targetId: 'hero'\}/);
            expect(row('hero').conditions.map((c: any) => `${c.name}:${c.source}`)).toEqual(expect.arrayContaining(['Unconscious:dying', 'Prone:dying']));
            expect(corpses('hero')).toHaveLength(0);
        });

        it('apply_damage on sheets: massive damage kills with a corpse; an enemy row is just DOWN', async () => {
            repo().update('hero', { hp: 8 } as any);
            const r = await manage({ action: 'apply_damage', targetIds: ['hero'], dice: 40, source: 'collapse' });
            expect(r.targets[0]).toMatchObject({ hpAfter: 0, dead: true });
            expect(r.message).toMatch(/DEAD/);
            expect(corpses('hero')).toHaveLength(1);
            mk('villain', { characterType: 'enemy', hp: 5 });
            const v = await manage({ action: 'apply_damage', targetIds: ['villain'], dice: 10, source: 'rockfall' });
            expect(v.message).toMatch(/DOWN/);
            expect(v.message).not.toMatch(/DYING/);
            expect(row('villain').conditions ?? []).toEqual([]);
        });

        it('a long rest clears the dying state on the sheet', async () => {
            repo().update('hero', { hp: 1, conditions: [{ name: 'Unconscious', source: 'dying' }, { name: 'Prone', source: 'dying' }, { name: 'Stable', source: 'stabilized by Medic' }, { name: 'Cursed', source: 'a hag' }] } as any);
            const r = await rest({ action: 'long', characterId: 'hero' });
            expect(r.deathSavesCleared).toBe(true);
            expect(row('hero').conditions.map((c: any) => c.name)).toEqual(['Cursed']);
        });

        it('the status block shows the counters from the live token', async () => {
            await start();
            setToken('hero', { deathSaveSuccesses: 1, deathSaveFailures: 2 });
            const s = await character({ action: 'get_status_block', characterId: 'hero' });
            expect(s.dying).toMatchObject({ status: 'dying', successes: 1, failures: 2, label: 'DYING ✓1 ✗2' });
            expect(s.message).toMatch(/DYING ✓1 ✗2/);
        });
    });
});
