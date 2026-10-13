/**
 * Play report 5, #1: cover. Three sources, one best value, never stacked:
 * a per-call `cover`, standing cover set on the token (combat_manage
 * set_cover, by attacker ids or by direction, dropped for the round by
 * breaksCover), and cover computed from the map (props with a cover rating
 * and creatures on the line of fire). +2 / +5 to AC on every attack roll
 * (attack, volley, opportunity, readied, legendary, spell attacks) and to
 * DEX saves (apply_damage, use_ability, lair_action, cast_spell), with the
 * arithmetic printed; total cover refuses a targeted attack or spell naming
 * the source and spends nothing; ignoreCover on a profile or the sheet
 * (Sharpshooter, Spell Sniper) is applied by itself; the state view reports
 * who can attempt a Hide.
 */
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { CombatRNG } from '../../src/engine/combat/rng.js';
import { getInitialSpellSlots } from '../../src/engine/magic/spell-validator.js';
import {
    normalizeCover, coverBonus, bestCover, standingCoverAgainst, coverBetween, resolveCover, coverArithmetic, canHideReport
} from '../../src/engine/combat/cover.js';

const ctx = { sessionId: 'cover' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manage = async (args: Record<string, unknown>) => {
    const text = (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    return { text, r: tag(text, 'COMBAT_MANAGE') ?? { rawText: text } };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ action: 'attack', encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, d, r: d?.actionResult ?? d };
};
const state = () => new EncounterRepository(getDb()).loadState(enc)!;
const tok = (id: string) => state().participants.find(p => p.id === id)! as any;
const live = () => getOrLoadEngine(ctx as any, enc)!.getState()!;
const now = () => new Date().toISOString();

/** Pin the next natural d20s of the encounter's dice (attack rolls read rollDie). */
const d20 = (...values: number[]) => {
    const spy = vi.spyOn(CombatRNG.prototype as any, 'rollDie');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

async function setup(opts: { props?: Array<Record<string, unknown>>; extra?: Array<Record<string, unknown>>; seed?: string } = {}) {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    // Varek shoots from the west; the gretchin stands 4 squares east.
    const created = await handleCombatManage({ action: 'create', seed: opts.seed ?? 'cover', participants: [
        { id: 'varek', name: 'Varek', hp: 40, maxHp: 40, initiative: 20, ac: 15, position: { x: 1, y: 5 }, attacks: [
            { name: 'bolt pistol', attackBonus: 6, damage: '1d10+2', damageType: 'piercing', ranged: true, default: true },
            { name: 'sharpshooter rifle', attackBonus: 6, damage: '1d12', damageType: 'piercing', ranged: true, ignoreCover: 'half-and-three-quarters' },
            { name: 'chainsword', attackBonus: 7, damage: '2d6+4', damageType: 'slashing', breaksCover: true }
        ] },
        { id: 'grot', name: 'Grot', hp: 20, maxHp: 20, initiative: 10, isEnemy: true, ac: 12, position: { x: 5, y: 5 }, attackBonus: 3, attackDamage: '1d6' },
        ...(opts.extra ?? [])
    ] }, ctx as any);
    enc = tag(created.content[0].text, 'COMBAT_MANAGE').encounterId;
    for (const prop of opts.props ?? []) {
        const st = state();
        st.props = [...(st.props ?? []), { id: `prop-${st.props?.length ?? 0}`, propType: 'cover', ...prop } as any];
        new EncounterRepository(getDb()).saveState(enc, st);
    }
    clearCombatState();
}

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('cover.ts: the pure rules', () => {
    it('normalises every spelling the engine has used for a cover rating', () => {
        expect(normalizeCover('half')).toBe('half');
        expect(normalizeCover('three-quarters')).toBe('three-quarters');
        expect(normalizeCover('three_quarter')).toBe('three-quarters');
        expect(normalizeCover('three-quarter')).toBe('three-quarters');
        expect(normalizeCover('3/4')).toBe('three-quarters');
        expect(normalizeCover('full')).toBe('total');
        expect(normalizeCover('total')).toBe('total');
        expect(normalizeCover('none')).toBe('none');
        expect(normalizeCover('NONE')).toBe('none');
        expect(normalizeCover('wall')).toBeUndefined();
        expect(normalizeCover(undefined)).toBeUndefined();
    });

    it('half is +2, three-quarters +5, total has no number (it refuses)', () => {
        expect(coverBonus('none')).toBe(0);
        expect(coverBonus('half')).toBe(2);
        expect(coverBonus('three-quarters')).toBe(5);
        expect(coverBonus('total')).toBe(0);
    });

    it('cover never stacks: the single best source wins, first among equals', () => {
        const best = bestCover([
            { kind: 'half', source: 'Grot (creature)', via: 'computed' },
            { kind: 'three-quarters', source: 'boulder', via: 'computed' },
            { kind: 'half', source: 'sandbags', via: 'standing' }
        ]);
        expect(best).toMatchObject({ kind: 'three-quarters', source: 'boulder' });
        expect(bestCover([])).toBeUndefined();
        expect(bestCover([{ kind: 'half', source: 'a', via: 'standing' }, { kind: 'half', source: 'b', via: 'computed' }])!.source).toBe('a');
    });

    it('standing cover applies to named attackers, or to a direction read from the grid, and is off for its broken round', () => {
        const target: any = { id: 't', name: 'Varek', position: { x: 5, y: 5 }, cover: { level: 'three-quarters', against: ['fg-handguns', 'fg-crossbows'], reason: 'rubble crest' } };
        expect(standingCoverAgainst(target, { id: 'fg-crossbows', name: 'Crossbows', position: { x: 9, y: 5 } } as any, 1)).toMatchObject({ kind: 'three-quarters', source: 'rubble crest', via: 'standing' });
        expect(standingCoverAgainst(target, { id: 'fg-crossbows', name: 'Crossbows' } as any, 1)).toMatchObject({ kind: 'three-quarters' });
        expect(standingCoverAgainst(target, { id: 'orc', name: 'Orc', position: { x: 9, y: 5 } } as any, 1)).toBeUndefined();
        // Names match too, any case.
        expect(standingCoverAgainst(target, { id: 'x1', name: 'FG-HANDGUNS' } as any, 1)).toBeDefined();

        const west: any = { id: 't', name: 'Varek', position: { x: 5, y: 5 }, cover: { level: 'half', against: { direction: 'west' } } };
        expect(standingCoverAgainst(west, { id: 'a', name: 'A', position: { x: 0, y: 5 } } as any, 1)).toMatchObject({ kind: 'half', source: 'cover to the west' });
        expect(standingCoverAgainst(west, { id: 'a', name: 'A', position: { x: 0, y: 3 } } as any, 1)).toMatchObject({ kind: 'half' });
        expect(standingCoverAgainst(west, { id: 'a', name: 'A', position: { x: 9, y: 5 } } as any, 1)).toBeUndefined();
        expect(standingCoverAgainst(west, { id: 'a', name: 'A', position: { x: 5, y: 0 } } as any, 1)).toBeUndefined();
        // A direction cannot be judged without both positions: no cover, a note.
        expect(standingCoverAgainst(west, { id: 'a', name: 'A' } as any, 1)).toBeUndefined();

        const everyone: any = { id: 't', name: 'Varek', cover: { level: 'half', reason: 'sandbags' }, coverBrokenRound: 3 };
        expect(standingCoverAgainst(everyone, { id: 'a', name: 'A' } as any, 2)).toMatchObject({ kind: 'half', source: 'sandbags' });
        expect(standingCoverAgainst(everyone, { id: 'a', name: 'A' } as any, 3)).toBeUndefined();
    });

    it('computed cover: a rated prop on the line of fire, a creature between the two gives half, adjacency gives none', () => {
        const mk = (over: Record<string, unknown> = {}) => ({
            participants: [
                { id: 'a', name: 'Archer', hp: 10, maxHp: 10, conditions: [], position: { x: 0, y: 5 } },
                { id: 't', name: 'Target', hp: 10, maxHp: 10, conditions: [], position: { x: 6, y: 5 } },
                { id: 'c', name: 'Bystander', hp: 10, maxHp: 10, conditions: [], position: { x: 3, y: 5 } }
            ],
            props: [], turnOrder: [], currentTurnIndex: 0, round: 1, ...over
        }) as any;
        const [a, t] = mk().participants;
        expect(coverBetween(mk(), a, t)).toMatchObject({ kind: 'half', source: 'Bystander (creature)', via: 'computed' });
        const withBoulder = mk({ props: [{ id: 'p1', position: '4,5', label: 'boulder', propType: 'cover', cover: 'three_quarter' }] });
        expect(coverBetween(withBoulder, withBoulder.participants[0], withBoulder.participants[1])).toMatchObject({ kind: 'three-quarters', source: 'boulder' });
        const wall = mk({ props: [{ id: 'p1', position: '2,5', label: 'rubble crest', propType: 'structure', cover: 'full' }] });
        expect(coverBetween(wall, wall.participants[0], wall.participants[1])).toMatchObject({ kind: 'total', source: 'rubble crest' });
        // A dead bystander is no cover; a prop off the line is none; adjacent squares have nothing between them.
        const dead = mk(); dead.participants[2].hp = 0;
        expect(coverBetween(dead, dead.participants[0], dead.participants[1])).toBeUndefined();
        const off = mk({ props: [{ id: 'p1', position: '3,8', label: 'cart', propType: 'cover', cover: 'half' }], participants: mk().participants.slice(0, 2) });
        expect(coverBetween(off, off.participants[0], off.participants[1])).toBeUndefined();
        const near = mk({ participants: [{ ...mk().participants[0], position: { x: 5, y: 5 } }, mk().participants[1]] });
        expect(coverBetween(near, near.participants[0], near.participants[1])).toBeUndefined();
    });

    it('resolveCover: an explicit value always wins; otherwise the best of standing and computed; ignoreCover lifts what it names', () => {
        const st: any = {
            participants: [
                { id: 'a', name: 'Archer', hp: 10, maxHp: 10, conditions: [], position: { x: 0, y: 5 } },
                { id: 't', name: 'Target', hp: 10, maxHp: 10, conditions: [], position: { x: 6, y: 5 }, cover: { level: 'half', reason: 'sandbags' } }
            ],
            props: [{ id: 'p1', position: '3,5', label: 'boulder', propType: 'cover', cover: 'three_quarter' }], round: 1, turnOrder: [], currentTurnIndex: 0
        };
        const [a, t] = st.participants;
        expect(resolveCover(st, a, t, { explicit: 'none' })).toMatchObject({ kind: 'none', acBonus: 0, via: 'call' });
        expect(resolveCover(st, a, t, { explicit: 'half' })).toMatchObject({ kind: 'half', acBonus: 2, source: 'declared', via: 'call' });
        expect(resolveCover(st, a, t, {})).toMatchObject({ kind: 'three-quarters', acBonus: 5, source: 'boulder', via: 'computed' });
        st.props = [];
        expect(resolveCover(st, a, t, {})).toMatchObject({ kind: 'half', acBonus: 2, source: 'sandbags', via: 'standing' });
        const lifted = resolveCover(st, a, t, { ignoreCover: 'half-and-three-quarters' });
        expect(lifted).toMatchObject({ kind: 'none', acBonus: 0, ignored: { kind: 'half', source: 'sandbags', by: 'half-and-three-quarters' } });
        t.cover = { level: 'total', reason: 'closed door' };
        expect(resolveCover(st, a, t, { ignoreCover: 'half-and-three-quarters' }).kind).toBe('total');
        expect(resolveCover(st, a, t, { ignoreCover: 'all' })).toMatchObject({ kind: 'none', ignored: { kind: 'total' } });
        expect(coverArithmetic('AC', 12, resolveCover(st, a, { ...t, cover: { level: 'three-quarters', reason: 'boulder' } }, {}))).toBe('AC 12 +5 (three-quarters, boulder) = 17');
    });
});

describe('cover on attack rolls', () => {
    it('half cover: AC 12 +2 = 14, printed, and the roll compares against 14', async () => {
        await setup();
        d20(13); // 13 + 6 = 19 hits AC 14 either way; the AC is what we read
        const { text, r } = await act({ actorId: 'varek', targetId: 'grot', cover: 'half' });
        expect(r.roll.targetAc).toBe(14);
        expect(r.cover).toMatchObject({ kind: 'half', acBonus: 2, acBefore: 12, acAfter: 14, source: 'declared', via: 'call' });
        expect(text).toContain('AC 12 +2 (half, declared) = 14');
    });

    it('three-quarters turns a hit into a miss: 14 + 6 = 20 hits AC 17 only without the +5', async () => {
        await setup();
        d20(10); // 10 + 6 = 16: hits AC 12, misses AC 17
        const { text, r } = await act({ actorId: 'varek', targetId: 'grot', cover: 'three-quarters' });
        expect(r.roll.targetAc).toBe(17);
        expect(r.roll.hit).toBe(false);
        expect(r.cover).toMatchObject({ kind: 'three-quarters', acBonus: 5, acBefore: 12, acAfter: 17 });
        expect(text).toContain('AC 12 +5 (three-quarters, declared) = 17');
        expect(tok('grot').hp).toBe(20);
    });

    it("the prop spellings 'three_quarter' and 'full' normalise on the call", async () => {
        await setup();
        expect((await act({ actorId: 'varek', targetId: 'grot', cover: 'three_quarter' })).r.cover.kind).toBe('three-quarters');
        const { d } = await act({ actorId: 'varek', targetId: 'grot', cover: 'full', actionSurge: true });
        expect(d.error).toBeTruthy();
        expect(d.message).toMatch(/total cover/);
    });

    it('total cover refuses before anything is spent: writes none, Help kept, action free, no attack roll logged', async () => {
        await setup();
        getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === 'varek')!.helpedBy = 'grot';
        const { d, text } = await act({ actorId: 'varek', targetId: 'grot', cover: 'total' });
        expect(d.error).toBeTruthy();
        expect(d.writes).toBe('none');
        expect(d.message).toMatch(/refused: total cover \(declared\) from Varek/);
        expect(d.message).toMatch(/Grot cannot be targeted/);
        expect(text).toMatch(/NO WRITE|writes/);
        expect(live().participants.find(p => p.id === 'varek')!.helpedBy).toBe('grot');
        expect(live().participants.find(p => p.id === 'varek')!.actionUsed).toBeFalsy();
        expect(queryRolls(getDb(), { encounterId: enc, limit: 20 }).filter((r: any) => /attack/.test(r.purpose))).toHaveLength(0);
    });

    it('a posted outcome rolls nothing, so cover is reported as ignored and the damage lands as posted', async () => {
        await setup();
        const { r } = await act({ actorId: 'varek', targetId: 'grot', outcome: 'hit', damage: 7, cover: 'half' });
        expect(r.cover).toMatchObject({ kind: 'half', ignored: expect.stringMatching(/posted outcome/) });
        expect(r.damage.total).toBe(7);
        expect(tok('grot').hp).toBe(13);
    });

    it('a posted outcome against total cover is refused too', async () => {
        await setup();
        const { d } = await act({ actorId: 'varek', targetId: 'grot', outcome: 'hit', damage: 7, cover: 'total' });
        expect(d.error).toBeTruthy();
        expect(d.writes).toBe('none');
        expect(tok('grot').hp).toBe(20);
    });

    it('volley {cover} is a real parameter: no ignoredParams, the AC is raised', async () => {
        await setup({ extra: [{ id: 'ardboyz', name: 'Ardboyz', hp: 50, maxHp: 50, initiative: 5, isEnemy: true, position: { x: 5, y: 9 }, unit: { models: 10, hpPerModel: 5, packed: true, attackBonus: 4 } }] });
        const text = (await handleCombatAction({ action: 'volley', encounterId: enc, actorId: 'ardboyz', targetId: 'varek', cover: 'half' }, ctx as any)).content[0].text;
        const d = tag(text, 'COMBAT_ACTION');
        expect(d.ignoredParams).toBeUndefined();
        expect(d.actionResult.roll.targetAc).toBe(17);
        expect(d.actionResult.cover).toMatchObject({ kind: 'half', acBonus: 2, acBefore: 15, acAfter: 17 });
    });

    it('a legendary-action attack takes cover like any other', async () => {
        await setup({ extra: [{ id: 'dragon', name: 'Dragon', hp: 200, maxHp: 200, initiative: 1, isEnemy: true, ac: 19, legendaryActions: 3, attackBonus: 11, attackDamage: '2d10+6', position: { x: 9, y: 9 } }] });
        const { r } = await act({ actorId: 'dragon', targetId: 'varek', legendaryCost: 1, cover: 'three-quarters' });
        expect(r.roll.targetAc).toBe(20);
        expect(r.legendary).toMatchObject({ cost: 1 });
    });
});

describe('computed cover from the map', () => {
    it('a three-quarter prop on the line of fire adds +5 and names the prop', async () => {
        await setup({ props: [{ position: '3,5', label: 'boulder', cover: 'three_quarter' }] });
        const { text, r } = await act({ actorId: 'varek', targetId: 'grot' });
        expect(r.roll.targetAc).toBe(17);
        expect(r.cover).toMatchObject({ kind: 'three-quarters', acBonus: 5, source: 'boulder', via: 'computed' });
        expect(text).toContain('AC 12 +5 (three-quarters, boulder) = 17');
    });

    it('a creature between attacker and target gives half cover, friend or foe', async () => {
        await setup({ extra: [{ id: 'squig', name: 'Squig', hp: 10, maxHp: 10, initiative: 8, isEnemy: true, ac: 11, position: { x: 3, y: 5 } }] });
        const { r } = await act({ actorId: 'varek', targetId: 'grot' });
        expect(r.cover).toMatchObject({ kind: 'half', acBonus: 2, source: 'Squig (creature)', via: 'computed' });
        expect(r.roll.targetAc).toBe(14);
    });

    it('a full prop on the line refuses the shot, naming it, unless the GM states the cover', async () => {
        await setup({ props: [{ position: '3,5', label: 'rubble crest', cover: 'full', propType: 'structure' }] });
        const refused = await act({ actorId: 'varek', targetId: 'grot' });
        expect(refused.d.error).toBeTruthy();
        expect(refused.d.writes).toBe('none');
        expect(refused.d.message).toMatch(/refused: total cover \(rubble crest\) from Varek/);
        const stated = await act({ actorId: 'varek', targetId: 'grot', cover: 'half' });
        expect(stated.r.cover).toMatchObject({ kind: 'half', via: 'call' });
        expect(stated.r.roll.targetAc).toBe(14);
    });

    it('an explicit cover: none overrides the map', async () => {
        await setup({ props: [{ position: '3,5', label: 'boulder', cover: 'three_quarter' }] });
        const { r } = await act({ actorId: 'varek', targetId: 'grot', cover: 'none' });
        expect(r.roll.targetAc).toBe(12);
        expect(r.cover).toMatchObject({ kind: 'none', via: 'call' });
    });
});

describe('standing cover: set_cover / clear_cover and breaksCover', () => {
    it('set_cover against named attackers raises the AC for them only; clear_cover removes it', async () => {
        await setup({ extra: [{ id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 7, isEnemy: true, ac: 13, attackBonus: 5, attackDamage: '1d12+3' }] });
        const set = await manage({ action: 'set_cover', participantId: 'varek', level: 'three-quarters', against: ['grot'], reason: 'rubble crest' });
        expect(set.r.success).toBe(true);
        expect(set.r.cover).toMatchObject({ level: 'three-quarters', against: ['grot'], reason: 'rubble crest' });
        expect(set.r.message).toMatch(/Varek.*three-quarters cover.*against grot.*rubble crest/i);
        expect(tok('varek').cover).toMatchObject({ level: 'three-quarters', against: ['grot'] });

        const fromGrot = await act({ actorId: 'grot', targetId: 'varek' });
        expect(fromGrot.r.roll.targetAc).toBe(20);
        expect(fromGrot.r.cover).toMatchObject({ kind: 'three-quarters', source: 'rubble crest', via: 'standing' });
        expect(fromGrot.text).toContain('AC 15 +5 (three-quarters, rubble crest) = 20');
        const fromOrc = await act({ actorId: 'orc', targetId: 'varek' });
        expect(fromOrc.r.roll.targetAc).toBe(15);
        expect(fromOrc.r.cover.kind).toBe('none');

        const cleared = await manage({ action: 'clear_cover', participantId: 'varek' });
        expect(cleared.r.success).toBe(true);
        expect(tok('varek').cover).toBeUndefined();
        getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === 'grot')!.actionUsed = false;
        expect((await act({ actorId: 'grot', targetId: 'varek' })).r.roll.targetAc).toBe(15);
    });

    it('set_cover by direction reads the grid: cover to the east protects from the Grot, not from a flanker', async () => {
        await setup({ extra: [{ id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 7, isEnemy: true, ac: 13, attackBonus: 5, position: { x: 1, y: 1 } }] });
        const set = await manage({ action: 'set_cover', participantId: 'varek', level: 'half', against: { direction: 'east' } });
        expect(set.r.cover).toMatchObject({ level: 'half', direction: 'east' });
        expect((await act({ actorId: 'grot', targetId: 'varek' })).r.roll.targetAc).toBe(17);
        expect((await act({ actorId: 'orc', targetId: 'varek' })).r.roll.targetAc).toBe(15);
    });

    it('standing total cover refuses, naming the reason; a level the engine does not know is refused with writes none', async () => {
        await setup();
        await manage({ action: 'set_cover', participantId: 'grot', level: 'total', reason: 'closed hatch' });
        const { d } = await act({ actorId: 'varek', targetId: 'grot' });
        expect(d.error).toBeTruthy();
        expect(d.message).toMatch(/refused: total cover \(closed hatch\) from Varek/);
        const bad = await manage({ action: 'set_cover', participantId: 'grot', level: 'wall' });
        expect(bad.r.error).toBeTruthy();
        expect(bad.r.writes).toBe('none');
        const missing = await manage({ action: 'set_cover', participantId: 'nobody', level: 'half' });
        expect(missing.r.error).toBeTruthy();
        expect(missing.r.writes).toBe('none');
    });

    it('breaksCover on an attack drops the attacker\'s own standing cover for the round; it is back next round', async () => {
        await setup();
        await manage({ action: 'set_cover', participantId: 'varek', level: 'three-quarters', reason: 'rubble crest' });
        const swing = await act({ actorId: 'varek', targetId: 'grot', breaksCover: true });
        expect(swing.r.coverBroken).toMatchObject({ round: 1 });
        expect(swing.text).toMatch(/leaves cover/);
        expect(tok('varek').coverBrokenRound).toBe(1);
        // The Grot's shot this round finds Varek in the open.
        const back = await act({ actorId: 'grot', targetId: 'varek' });
        expect(back.r.roll.targetAc).toBe(15);
        expect(back.r.cover.kind).toBe('none');
        // Next round the crest shelters him again.
        const st = live(); st.round = 2;
        getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === 'grot')!.actionUsed = false;
        const again = await act({ actorId: 'grot', targetId: 'varek' });
        expect(again.r.roll.targetAc).toBe(20);
    });

    it('a profile flagged breaksCover drops it by itself', async () => {
        await setup();
        await manage({ action: 'set_cover', participantId: 'varek', level: 'half' });
        const { r } = await act({ actorId: 'varek', targetId: 'grot', using: 'chainsword' });
        expect(r.coverBroken).toMatchObject({ round: 1, by: 'chainsword' });
    });

    it('explicit beats standing, and between standing and computed the single best source counts', async () => {
        await setup({ props: [{ position: '3,5', label: 'boulder', cover: 'three_quarter' }] });
        await manage({ action: 'set_cover', participantId: 'grot', level: 'half', reason: 'sandbags' });
        const best = await act({ actorId: 'varek', targetId: 'grot' });
        expect(best.r.cover).toMatchObject({ kind: 'three-quarters', source: 'boulder' });
        expect(best.r.roll.targetAc).toBe(17);
        getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === 'varek')!.actionUsed = false;
        const explicit = await act({ actorId: 'varek', targetId: 'grot', cover: 'half' });
        expect(explicit.r.cover).toMatchObject({ kind: 'half', source: 'declared', via: 'call' });
        expect(explicit.r.roll.targetAc).toBe(14);
    });
});

describe('ignoreCover (Sharpshooter, Spell Sniper)', () => {
    it("a profile with ignoreCover: 'half-and-three-quarters' shoots past a boulder and says so; total still refuses", async () => {
        await setup({ props: [{ position: '3,5', label: 'boulder', cover: 'three_quarter' }] });
        const { text, r } = await act({ actorId: 'varek', targetId: 'grot', using: 'sharpshooter rifle' });
        expect(r.roll.targetAc).toBe(12);
        expect(r.cover).toMatchObject({ kind: 'none', acBonus: 0, ignored: { kind: 'three-quarters', source: 'boulder', by: 'half-and-three-quarters' } });
        expect(text).toMatch(/ignores three-quarters cover \(boulder\)/);
        const total = await act({ actorId: 'varek', targetId: 'grot', using: 'sharpshooter rifle', cover: 'total' });
        expect(total.d.error).toBeTruthy();
    });

    it("the sheet's ignoreCover {ranged: 'all'} rides onto the token and applies to ranged attacks only", async () => {
        closeDb(); getDb(':memory:'); clearCombatState();
        new CharacterRepository(getDb()).create({ id: 'sniper', name: 'Sniper', stats: { str: 10, dex: 16, con: 10, int: 10, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 14, level: 5,
            ignoreCover: { ranged: 'all' }, attacks: [{ name: 'longbow', attackBonus: 8, damage: '1d8+3', ranged: true, default: true }, { name: 'dagger', attackBonus: 6, damage: '1d4+3' }],
            createdAt: now(), updatedAt: now() } as any);
        const row = new CharacterRepository(getDb()).findById('sniper')!;
        expect((row as any).ignoreCover).toEqual({ ranged: 'all' });
        const created = await handleCombatManage({ action: 'create', seed: 'sniper', participants: [
            { id: 'sniper', name: 'Sniper', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 5 } },
            { id: 'grot', name: 'Grot', hp: 20, maxHp: 20, initiative: 10, isEnemy: true, ac: 12, position: { x: 6, y: 5 } },
            { id: 'squig', name: 'Squig', hp: 10, maxHp: 10, initiative: 8, isEnemy: true, ac: 11, position: { x: 3, y: 5 } }
        ] }, ctx as any);
        enc = tag(created.content[0].text, 'COMBAT_MANAGE').encounterId;
        expect(tok('sniper').ignoreCover).toEqual({ ranged: 'all' });
        const shot = await act({ actorId: 'sniper', targetId: 'grot' });
        expect(shot.r.cover).toMatchObject({ kind: 'none', ignored: { kind: 'half', source: 'Squig (creature)' } });
        expect(shot.r.roll.targetAc).toBe(12);
        getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === 'sniper')!.actionUsed = false;
        const stab = await act({ actorId: 'sniper', targetId: 'grot', using: 'dagger', ranged: false });
        expect(stab.r.cover).toMatchObject({ kind: 'half', acBonus: 2 });
    });
});

describe('reactions: opportunity and readied attacks', () => {
    it('a readied attack fired by trigger_readied takes the per-call cover; total is refused with nothing spent', async () => {
        await setup();
        await manage({ action: 'set_intent', participantId: 'grot', readied: { action: 'shoot', trigger: 'Varek shows himself', attack: { attackBonus: 3, damage: '1d6' } } });
        const fired = await manage({ action: 'trigger_readied', participantId: 'grot', targetId: 'varek', cover: 'half' });
        expect(fired.r.success).toBe(true);
        expect(fired.r.attack.targetAc).toBe(17);
        expect(fired.r.attack.cover).toMatchObject({ kind: 'half', acBonus: 2, acBefore: 15, acAfter: 17 });
        expect(fired.r.message).toContain('AC 15 +2 (half, declared) = 17');

        await manage({ action: 'set_intent', participantId: 'grot', readied: { action: 'shoot', trigger: 'again', attack: { attackBonus: 3, damage: '1d6' } } });
        live().participants.find(p => p.id === 'grot')!.reactionUsed = false;
        const refused = await manage({ action: 'trigger_readied', participantId: 'grot', targetId: 'varek', cover: 'total' });
        expect(refused.r.error).toBeTruthy();
        expect(refused.r.writes).toBe('none');
        expect(refused.r.message).toMatch(/refused: total cover \(declared\) from Grot/);
        // Nothing was written: the readied action stands and the reaction (reset above, in memory) is still free.
        expect(live().participants.find(p => p.id === 'grot')!.readied).toBeDefined();
        expect(live().participants.find(p => p.id === 'grot')!.reactionUsed).toBeFalsy();
    });

    it('a readied attack with no per-call cover inherits the standing value', async () => {
        await setup();
        await manage({ action: 'set_cover', participantId: 'varek', level: 'three-quarters', reason: 'rubble crest' });
        await manage({ action: 'set_intent', participantId: 'grot', readied: { action: 'shoot', trigger: 'Varek moves', attack: { attackBonus: 3, damage: '1d6' } } });
        const fired = await manage({ action: 'trigger_readied', participantId: 'grot', targetId: 'varek' });
        expect(fired.r.attack.targetAc).toBe(20);
        expect(fired.r.attack.cover).toMatchObject({ kind: 'three-quarters', source: 'rubble crest', via: 'standing' });
    });

    it('an NPC opportunity attack against total standing cover is skipped with a line; the move completes and the reaction is kept', async () => {
        await setup({ extra: [{ id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 7, isEnemy: true, ac: 13, attackBonus: 5, attackDamage: '1d12+3', position: { x: 2, y: 5 } }] });
        // Varek is sheltered from the east (the Orc stands east of him at x=2).
        await manage({ action: 'set_cover', participantId: 'varek', level: 'total', against: { direction: 'east' }, reason: 'firing slit' });
        const text = (await handleCombatAction({ action: 'move', encounterId: enc, actorId: 'varek', targetPosition: { x: 1, y: 8 } }, ctx as any)).content[0].text;
        expect(text).toMatch(/OPPORTUNITY ATTACK.*(skipped|no shot).*total cover \(firing slit\)/s);
        expect(tok('varek').position).toEqual({ x: 1, y: 8 });
        expect(tok('orc').reactionUsed).toBeFalsy();
        expect(tok('varek').hp).toBe(40);
    });

    it('an NPC opportunity attack against standing half cover rolls against AC +2', async () => {
        await setup({ extra: [{ id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 7, isEnemy: true, ac: 13, attackBonus: 5, attackDamage: '1d12+3', position: { x: 2, y: 5 } }] });
        await manage({ action: 'set_cover', participantId: 'varek', level: 'half', reason: 'low wall' });
        const text = (await handleCombatAction({ action: 'move', encounterId: enc, actorId: 'varek', targetPosition: { x: 1, y: 8 } }, ctx as any)).content[0].text;
        const d = tag(text, 'COMBAT_ACTION');
        expect(d.actionResult.opportunityAttacks[0].targetAc).toBe(17);
        expect(text).toContain('AC 15 +2 (half, low wall) = 17');
    });
});

describe('cover on DEX saves', () => {
    const d20s = (...values: number[]) => {
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        for (const v of values) spy.mockReturnValueOnce(v);
        return spy;
    };

    it('apply_damage {cover: {grot: half}}: +2 on the DEX save, printed; a non-DEX save takes none', async () => {
        await setup();
        d20s(10);
        const half = await manage({ action: 'apply_damage', targetIds: ['grot'], dice: 8, source: 'rockslide', save: { ability: 'dex', dc: 13 }, cover: { grot: 'half' } });
        expect(half.r.success).toBe(true);
        expect(half.r.targets[0]).toMatchObject({ targetId: 'grot', saveRoll: 10, saveTotal: 12, saved: false, cover: { kind: 'half', saveBonus: 2 } });
        expect(half.r.message).toContain('DEX save 10 +0 +2 (half, declared) = 12 vs DC 13');
        d20s(10);
        const con = await manage({ action: 'apply_damage', targetIds: ['grot'], dice: 8, source: 'poison cloud', save: { ability: 'con', dc: 13 }, cover: { grot: 'half' } });
        expect(con.r.targets[0].saveTotal).toBe(10);
        expect(con.r.targets[0].cover).toMatchObject({ kind: 'half', saveBonus: 0, note: expect.stringMatching(/DEX saves only/) });
    });

    it('total cover on an area effect skips the target with a line unless the GM passes cover: none', async () => {
        await setup({ props: [{ position: '3,5', label: 'rubble crest', cover: 'full', propType: 'structure' }] });
        const skipped = await manage({ action: 'apply_damage', actorId: 'varek', targetIds: ['grot'], dice: 10, source: 'frag grenade', save: { ability: 'dex', dc: 13 } });
        expect(skipped.r.targets[0]).toMatchObject({ targetId: 'grot', damageTaken: 0, cover: { kind: 'total', source: 'rubble crest', unaffected: true } });
        expect(skipped.r.message).toMatch(/Grot.*unaffected: total cover \(rubble crest\)/);
        expect(tok('grot').hp).toBe(20);
        const around = await manage({ action: 'apply_damage', actorId: 'varek', targetIds: ['grot'], dice: 10, source: 'frag grenade', save: { ability: 'dex', dc: 30 }, cover: { grot: 'none' } });
        expect(around.r.targets[0].damageTaken).toBe(10);
    });

    it('the sheet path (no encounter) adds the declared cover to the DEX save', async () => {
        closeDb(); getDb(':memory:'); clearCombatState();
        new CharacterRepository(getDb()).create({ id: 'rogue', name: 'Rogue', stats: { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 14, level: 1, createdAt: now(), updatedAt: now() } as any);
        const text = (await handleCombatManage({ action: 'apply_damage', targetIds: ['rogue'], dice: 6, source: 'trap', save: { ability: 'dex', dc: 15 }, cover: { rogue: 'three-quarters' } }, ctx as any)).content[0].text;
        const r = tag(text, 'COMBAT_MANAGE');
        expect(r.success).toBe(true);
        expect(r.targets[0].saveTotal).toBe(r.targets[0].saveRoll + 2 + 5);
        expect(r.targets[0].cover).toMatchObject({ kind: 'three-quarters', saveBonus: 5 });
        expect(r.message).toMatch(/DEX save \d+ \+2 \+5 \(three-quarters, declared\) = \d+ vs DC 15/);
    });

    it('use_ability (a breath weapon) computes cover from the user to each target and takes a per-target override', async () => {
        await setup({
            props: [{ position: '7,5', label: 'pillar', cover: 'three_quarter' }],
            extra: [{ id: 'dragon', name: 'Dragon', hp: 200, maxHp: 200, initiative: 30, isEnemy: true, ac: 19, position: { x: 9, y: 5 }, abilities: [{ name: 'Fire Breath', recharge: 5 }] }]
        });
        d20s(10, 10);
        const r = (await manage({ action: 'use_ability', participantId: 'dragon', ability: 'Fire Breath', targetIds: ['grot', 'varek'], damage: 20, damageType: 'fire', savingThrow: { ability: 'dex', dc: 15 }, cover: { varek: 'half' } })).r;
        expect(r.success).toBe(true);
        const grot = r.targets.find((t: any) => t.targetId === 'grot');
        const varek = r.targets.find((t: any) => t.targetId === 'varek');
        expect(grot.cover).toMatchObject({ kind: 'three-quarters', saveBonus: 5, source: 'pillar', via: 'computed' });
        expect(grot.saveTotal).toBe(15);
        expect(varek.cover).toMatchObject({ kind: 'half', saveBonus: 2, via: 'call' });
        expect(varek.saveTotal).toBe(12);
    });

    it('lair_action takes {cover: {id: kind}} on its DEX save', async () => {
        await setup({ extra: [{ id: 'dragon', name: 'Dragon', hp: 200, maxHp: 200, initiative: 30, isEnemy: true, ac: 19, hasLairActions: true }] });
        // Advance to the LAIR slot (initiative 20 after the dragon at 30).
        let st = live();
        while (st.turnOrder[st.currentTurnIndex] !== 'LAIR') { await manage({ action: 'advance' }); st = live(); }
        d20s(10);
        const r = (await manage({ action: 'lair_action', actionDescription: 'the ceiling drops', targetIds: ['grot'], damage: 12, savingThrow: { ability: 'dexterity', dc: 14 }, cover: { grot: 'half' } })).r;
        expect(r.success).toBe(true);
        // lair_action embeds no STATE_JSON: its prose rides message.
        expect(r.message ?? r.rawText ?? JSON.stringify(r)).toContain('DEX save 10 +0 +2 (half, declared) = 12 vs DC 14');
    });
});

describe('cover on spells', () => {
    async function caster() {
        closeDb(); getDb(':memory:'); clearCombatState();
        new CharacterRepository(getDb()).create({
            id: 'wiz', name: 'Wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 12, level: 5,
            characterClass: 'wizard', knownSpells: ['Fireball'], preparedSpells: ['Fireball'], cantripsKnown: ['Fire Bolt'],
            spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: 3, createdAt: now(), updatedAt: now()
        } as any);
        const created = await handleCombatManage({ action: 'create', seed: 'spells', participants: [
            { id: 'wiz', name: 'Wizard', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 5 } },
            { id: 'grot', name: 'Grot', hp: 20, maxHp: 20, initiative: 10, isEnemy: true, ac: 12, position: { x: 6, y: 5 } },
            { id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 5, isEnemy: true, ac: 13, position: { x: 6, y: 7 } }
        ] }, ctx as any);
        enc = tag(created.content[0].text, 'COMBAT_MANAGE').encounterId;
    }
    const cast = async (args: Record<string, unknown>) => {
        const text = (await handleCombatAction({ action: 'cast_spell', encounterId: enc, actorId: 'wiz', ...args }, ctx as any)).content[0].text;
        const d = tag(text, 'COMBAT_ACTION');
        return { text, d, r: d?.actionResult ?? d };
    };

    it('a spell attack (Fire Bolt) rolls against AC +2 with half cover, printed', async () => {
        await caster();
        const { text, r } = await cast({ spellName: 'Fire Bolt', targetId: 'grot', cover: 'half' });
        expect(r.cover).toMatchObject({ kind: 'half', acBonus: 2, acBefore: 12, acAfter: 14 });
        expect(text).toContain('AC 12 +2 (half, declared) = 14');
    });

    it('a targeted spell against total cover is refused before the slot or action is spent', async () => {
        await caster();
        const { d } = await cast({ spellName: 'Fire Bolt', targetId: 'grot', cover: 'total' });
        expect(d.error).toBeTruthy();
        expect(d.writes).toBe('none');
        expect(d.message).toMatch(/refused: total cover \(declared\) from Wizard/);
        expect(tok('wiz').actionUsed).toBeFalsy();
    });

    it('a DEX-save area spell (Fireball) adds +2 to the covered target\'s save and skips one behind total cover', async () => {
        await caster();
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(10);
        const { text, r } = await cast({ spellName: 'Fireball', targetIds: ['grot', 'orc'], slotLevel: 3, coverByTarget: { grot: 'half', orc: 'total' } });
        spy.mockRestore();
        const grot = r.saves.find((s: any) => s.id === 'grot');
        expect(grot.total).toBe(12);
        expect(grot.cover).toMatchObject({ kind: 'half', saveBonus: 2 });
        expect(text).toContain('DEX save 10 +0 +2 (half, declared) = 12');
        expect(r.saves.find((s: any) => s.id === 'orc')).toBeUndefined();
        expect(text).toMatch(/Orc.*unaffected: total cover \(declared\)/);
        expect(tok('orc').hp).toBe(30);
    });

    it("the sheet's ignoreCover {spells: 'half-and-three-quarters'} (Spell Sniper) lifts computed cover on a spell attack", async () => {
        await caster();
        new CharacterRepository(getDb()).update('wiz', { ignoreCover: { spells: 'half-and-three-quarters' } } as any);
        const st = state();
        st.props = [{ id: 'p', position: '3,5', label: 'boulder', propType: 'cover', cover: 'three_quarter' } as any];
        new EncounterRepository(getDb()).saveState(enc, st);
        clearCombatState();
        const { text, r } = await cast({ spellName: 'Fire Bolt', targetId: 'grot' });
        expect(r.cover).toMatchObject({ kind: 'none', ignored: { kind: 'three-quarters', source: 'boulder' } });
        expect(text).toMatch(/ignores three-quarters cover \(boulder\)/);
    });
});

describe('canHide in the state view', () => {
    it('standing three-quarters cover against an observer, or darkness against a foe without darkvision, marks a Hide as possible; no roll is made', async () => {
        await setup({ extra: [{ id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 7, isEnemy: true, ac: 13, position: { x: 8, y: 8 } }] });
        await manage({ action: 'set_cover', participantId: 'varek', level: 'three-quarters', against: ['grot'], reason: 'rubble crest' });
        let got = (await manage({ action: 'get' })).r;
        let varek = got.participants.find((p: any) => p.id === 'varek');
        expect(varek.canHide).toEqual([{ from: 'Grot', reason: 'three-quarters cover (rubble crest)' }]);
        expect(got.rawText ?? got.message ?? '').toMatch(/🫥 can hide from Grot/);
        expect(got.participants.find((p: any) => p.id === 'grot').canHide).toBeUndefined();

        await manage({ action: 'set_environment', environment: { medium: 'air', light: 'darkness' } });
        // Lane D adds senses to the token schema; until then it is read from the live token when present.
        (live().participants.find(p => p.id === 'orc') as any).senses = { darkvisionFt: 60 };
        got = (await manage({ action: 'get' })).r;
        varek = got.participants.find((p: any) => p.id === 'varek');
        // The Orc has darkvision: darkness hides nothing from it; the Grot has none.
        expect(varek.canHide).toEqual(expect.arrayContaining([{ from: 'Grot', reason: 'three-quarters cover (rubble crest)' }]));
        expect(varek.canHide.some((h: any) => h.from === 'Orc')).toBe(false);
        const grot = got.participants.find((p: any) => p.id === 'grot');
        expect(grot.canHide).toEqual([{ from: 'Varek', reason: 'darkness (Varek has no darkvision)' }]);
        expect(queryRolls(getDb(), { encounterId: enc, limit: 50 }).filter((r: any) => /hide|stealth/i.test(r.purpose))).toHaveLength(0);
    });

    it('canHideReport reads the token it is given against every living foe', () => {
        const st: any = {
            round: 1, turnOrder: [], currentTurnIndex: 0, props: [{ id: 'p', position: '3,5', label: 'boulder', propType: 'cover', cover: 'three_quarter' }],
            participants: [
                { id: 'a', name: 'Archer', hp: 10, maxHp: 10, conditions: [], position: { x: 0, y: 5 } },
                { id: 't', name: 'Target', hp: 10, maxHp: 10, conditions: [], isEnemy: true, position: { x: 6, y: 5 } },
                { id: 'd', name: 'Dead', hp: 0, maxHp: 10, conditions: [], isEnemy: true, position: { x: 6, y: 6 } }
            ]
        };
        expect(canHideReport(st, st.participants[0])).toEqual([{ from: 'Target', reason: 'three-quarters cover (boulder)' }]);
        expect(canHideReport(st, st.participants[1])).toEqual([{ from: 'Archer', reason: 'three-quarters cover (boulder)' }]);
    });
});
