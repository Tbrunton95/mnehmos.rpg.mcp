/**
 * Play report 5, #1: cover — the verifier's cases. Each one is a way the
 * lane could be broken at the table rather than a repeat of cover.test.ts:
 *   - a prop placed at '3, 5' (a space) or '3,5,0' must still stand on the
 *     line of fire (place_prop stores the position as the GM typed it);
 *   - cast_spell with targetIds: [one] and a bare cover must apply it, and a
 *     bare cover on an area spell is every target's default that
 *     coverByTarget overrides;
 *   - a creature-targeted spell (Hold Person) named through targetIds against
 *     total cover is refused before the slot or the action is spent, like the
 *     targetId form; an area spell keeps skipping the covered target;
 *   - a readied shot with a GM-stated cover still honours the sheet-level
 *     ignoreCover (Sharpshooter on the row, not on a profile), as an ordinary
 *     attack does.
 */
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { CombatRNG } from '../../src/engine/combat/rng.js';
import { getInitialSpellSlots } from '../../src/engine/magic/spell-validator.js';
import { coverBetween } from '../../src/engine/combat/cover.js';

const ctx = { sessionId: 'cover-verify' };
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
const row = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
const now = () => new Date().toISOString();

/** Pin the next natural d20s of the encounter's dice (attack rolls read rollDie). */
const d20 = (...values: number[]) => {
    const spy = vi.spyOn(CombatRNG.prototype as any, 'rollDie');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

/** Varek shoots from the west (1,5); the gretchin stands 4 squares east (5,5). Rows are created before the fight so the tokens hydrate from them. */
async function setup(opts: { props?: Array<Record<string, unknown>>; rows?: Array<Record<string, unknown>> } = {}) {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    for (const r of opts.rows ?? []) new CharacterRepository(getDb()).create({ stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, level: 3, createdAt: now(), updatedAt: now(), ...r } as any);
    const created = await handleCombatManage({ action: 'create', seed: 'cover-verify', participants: [
        { id: 'varek', name: 'Varek', hp: 40, maxHp: 40, initiative: 20, ac: 15, position: { x: 1, y: 5 }, attacks: [
            { name: 'bolt pistol', attackBonus: 6, damage: '1d10+2', damageType: 'piercing', ranged: true, default: true }
        ] },
        { id: 'grot', name: 'Grot', hp: 20, maxHp: 20, initiative: 10, isEnemy: true, ac: 12, position: { x: 5, y: 5 }, attackBonus: 3, attackDamage: '1d6' }
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

describe('computed cover reads prop positions as GMs type them', () => {
    it("a prop placed at '3, 5' (with a space) stands on the line of fire and gives its +5", async () => {
        await setup({ props: [{ position: '3, 5', label: 'boulder', cover: 'three_quarter' }] });
        d20(10);
        const { r, text } = await act({ actorId: 'varek', targetId: 'grot' });
        expect(r.cover).toMatchObject({ kind: 'three-quarters', source: 'boulder', via: 'computed', acBefore: 12, acAfter: 17 });
        expect(text).toContain('AC 12 +5 (three-quarters, boulder) = 17');
    });

    it("the pure function takes '3,5,0' (an elevation) and an {x, y} object too", async () => {
        await setup();
        const st = live();
        const varek = st.participants.find(p => p.id === 'varek')!;
        const grot = st.participants.find(p => p.id === 'grot')!;
        const withProp = (prop: Record<string, unknown>) => coverBetween({ ...st, props: [{ id: 'p', propType: 'cover', ...prop } as any] }, varek, grot);
        expect(withProp({ position: '3,5,0', label: 'crate', cover: 'half' })).toMatchObject({ kind: 'half', source: 'crate' });
        expect(withProp({ position: { x: 3, y: 5 }, label: 'wall', cover: 'full' })).toMatchObject({ kind: 'total', source: 'wall' });
        // Off the line it still counts for nothing.
        expect(withProp({ position: '3, 7', label: 'far crate', cover: 'half' })).toBeUndefined();
    });
});

describe('cast_spell: cover with targetIds', () => {
    async function caster() {
        closeDb(); getDb(':memory:'); clearCombatState();
        new CharacterRepository(getDb()).create({
            id: 'wiz', name: 'Wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 12, level: 5,
            characterClass: 'wizard', knownSpells: ['Fireball', 'Hold Person'], preparedSpells: ['Fireball', 'Hold Person'], cantripsKnown: ['Fire Bolt'],
            spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: 3, createdAt: now(), updatedAt: now()
        } as any);
        const created = await handleCombatManage({ action: 'create', seed: 'spells-verify', participants: [
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

    it("a bare cover: 'half' applies when the one target is named through targetIds", async () => {
        await caster();
        const { text, r } = await cast({ spellName: 'Fire Bolt', targetIds: ['grot'], cover: 'half' });
        expect(r.cover).toMatchObject({ kind: 'half', acBonus: 2, acBefore: 12, acAfter: 14 });
        expect(text).toContain('AC 12 +2 (half, declared) = 14');
    });

    it("a bare cover on an area spell is every target's default; coverByTarget overrides one of them", async () => {
        await caster();
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(10);
        const { r } = await cast({ spellName: 'Fireball', targetIds: ['grot', 'orc'], slotLevel: 3, cover: 'half', coverByTarget: { orc: 'none' } });
        spy.mockRestore();
        expect(r.saves.find((s: any) => s.id === 'grot')).toMatchObject({ total: 12, cover: { kind: 'half', saveBonus: 2 } });
        const orc = r.saves.find((s: any) => s.id === 'orc');
        expect(orc.total).toBe(10);
        expect(orc.cover).toBeUndefined();
    });

    it('a creature-targeted spell (Hold Person) named through targetIds against total cover is refused before the slot or the action is spent', async () => {
        await caster();
        const slotsBefore = JSON.stringify(row('wiz').spellSlots);
        const { d } = await cast({ spellName: 'Hold Person', targetIds: ['grot', 'orc'], slotLevel: 3, coverByTarget: { orc: 'total' } });
        expect(d.error).toBeTruthy();
        expect(d.writes).toBe('none');
        expect(d.message).toMatch(/refused: total cover \(declared\) from Wizard: Orc cannot be targeted directly/);
        expect(tok('wiz').actionUsed).toBeFalsy();
        expect(JSON.stringify(row('wiz').spellSlots)).toBe(slotsBefore);
        expect(tok('orc').conditions ?? []).toEqual([]);
        // The point-targeted Fireball still reaches around: the covered target is skipped, the rest burn.
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(10);
        const { r } = await cast({ spellName: 'Fireball', targetIds: ['grot', 'orc'], slotLevel: 3, coverByTarget: { orc: 'total' } });
        spy.mockRestore();
        expect(r.coverSkipped).toEqual(['orc']);
        expect(tok('grot').hp).toBeLessThan(20);
    });
});

describe('readied attacks and the sheet-level ignoreCover', () => {
    it("a Sharpshooter's readied shot lifts the GM's stated half cover, as its ordinary attacks do", async () => {
        await setup({ rows: [{ id: 'grot', name: 'Grot', hp: 20, maxHp: 20, ac: 12, ignoreCover: { ranged: 'half-and-three-quarters' } }] });
        expect(tok('grot').ignoreCover).toEqual({ ranged: 'half-and-three-quarters' });
        await manage({ action: 'set_intent', participantId: 'grot', readied: { action: 'shoot', trigger: 'Varek shows himself', attack: { attackBonus: 3, damage: '1d6' } } });
        const fired = await manage({ action: 'trigger_readied', participantId: 'grot', targetId: 'varek', cover: 'half' });
        expect(fired.r.success).toBe(true);
        // 20 ft away: a ranged shot, so the ranged scope applies and the AC stays 15.
        expect(fired.r.attack.targetAc).toBe(15);
        expect(fired.r.attack.cover).toMatchObject({ kind: 'none', acBonus: 0, ignored: { kind: 'half', source: 'declared', by: 'half-and-three-quarters' } });
    });

    it('a readied shot with no sheet feature keeps the stated cover (the control)', async () => {
        await setup();
        await manage({ action: 'set_intent', participantId: 'grot', readied: { action: 'shoot', trigger: 'Varek shows himself', attack: { attackBonus: 3, damage: '1d6' } } });
        const fired = await manage({ action: 'trigger_readied', participantId: 'grot', targetId: 'varek', cover: 'half' });
        expect(fired.r.attack.targetAc).toBe(17);
    });
});
