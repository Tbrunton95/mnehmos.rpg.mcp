import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../../src/server/consolidated/combat-action.js';
import { handleTableRules } from '../../../src/server/consolidated/table-rules.js';
import { clearCombatState, getOrLoadEngine } from '../../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { CombatEngine } from '../../../src/engine/combat/engine.js';
import { DEFAULT_BAND_ORDER } from '../../../src/engine/table-rules.js';

/**
 * Request 11: damage scales with the band gap, opt-in by the band rule's
 * damageScale. steps = attacker's band index - target's; multiplier is
 * perStepAbove^steps above and perStepBelow^-steps below, clamped to
 * [floor, cap]; damage = max(1, floor(damage × multiplier)). Without the
 * field (or without a rule) nothing changes. Executes, grapples, heals,
 * spells and actorless damage are never scaled.
 */
const W = 'world-40k';
const ctx = { sessionId: 'band-damage' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manage = async (args: Record<string, unknown>) => {
    const text = (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    return { text, r: tag(text, 'COMBAT_MANAGE') };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, d, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const live = (id: string) => getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === id)! as any;
const freshAction = (id: string) => { live(id).actionUsed = false; live(id).attacksUsed = 0; };

type Scale = Record<string, number> | null | 'none';

/**
 * 'none': no band rule at all. null: a band rule without damageScale.
 * An object: damageScale with those fields (defaults fill the rest).
 */
async function setup(scale: Scale = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Vorago', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    const chars = new CharacterRepository(db);
    const mk = (id: string, name: string, hp: number, band?: string) => chars.create({ id, name, stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp, maxHp: hp, ac: 15, level: 5, band, createdAt: now, updatedAt: now } as any);
    mk('elite', 'Elite', 60, 'Elite Mortal');
    mk('astartes', 'Astartes', 200, 'Astartes');
    mk('primarch', 'Primarch', 500, 'Primarch-class');
    mk('mortal', 'Mortal', 30, 'Mortal');
    mk('nobody', 'Nobody', 40);
    if (scale !== 'none') {
        const spec: Record<string, unknown> = { order: DEFAULT_BAND_ORDER };
        if (scale) spec.damageScale = scale;
        const r = await handleTableRules({ action: 'define', worldId: W, kind: 'band', name: 'bands', spec }, ctx as any);
        if (r.content[0].text.includes('"error":true')) throw new Error(r.content[0].text);
    }
    enc = tag((await handleCombatManage({ action: 'create', worldId: W, seed: 'band-damage', participants: [
        { id: 'elite', name: 'Elite', hp: 60, maxHp: 60, initiative: 30, band: 'Elite Mortal' },
        { id: 'astartes', name: 'Astartes', hp: 200, maxHp: 200, initiative: 25, band: 'Astartes' },
        { id: 'primarch', name: 'Primarch', hp: 500, maxHp: 500, initiative: 20, band: 'Primarch-class' },
        { id: 'mortal', name: 'Mortal', hp: 30, maxHp: 30, initiative: 15, isEnemy: true, band: 'Mortal' },
        { id: 'nobody', name: 'Nobody', hp: 40, maxHp: 40, initiative: 10, isEnemy: true },
        { id: 'scions', name: 'Scions', hp: 50, maxHp: 50, initiative: 5, isEnemy: true, band: 'Elite Mortal', unit: { models: 10, hpPerModel: 5, packed: true, attackBonus: 6 } }
    ] }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
}

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('band-scaled damage (request 11)', () => {
    it('an attacker one band below deals half, reported and narrated', async () => {
        await setup({});
        const { text, r } = await act({ action: 'attack', actorId: 'elite', targetId: 'astartes', outcome: 'hit', damage: 20 });
        expect(r.bandScale).toEqual({ steps: -1, multiplier: 0.5, before: 20, after: 10 });
        expect(r.damage.total).toBe(10);
        expect(tok('astartes').hp).toBe(190);
        expect(text).toMatch(/×0\.5 band \(20 → 10\)/);
        expect(text).toMatch(/RULE bands: Elite Mortal 1 below Astartes: damage ×0\.5/);
        // The sheet follows the token.
        expect(new CharacterRepository(getDb()).findById('astartes')!.hp).toBe(190);
    });

    it('two bands above multiplies by perStepAbove squared; four above hits the cap', async () => {
        await setup({});
        const two = await act({ action: 'attack', actorId: 'astartes', targetId: 'mortal', outcome: 'hit', damage: 16 });
        expect(two.r.bandScale).toEqual({ steps: 2, multiplier: 1.5625, before: 16, after: 25 });
        expect(tok('mortal').hp).toBe(5);
        const four = await act({ action: 'attack', actorId: 'primarch', targetId: 'mortal', outcome: 'hit', damage: 10 });
        expect(four.r.bandScale).toMatchObject({ steps: 5, multiplier: 2, before: 10, after: 20 });
        expect(tok('mortal').hp).toBe(0);
    });

    it('a custom scale clamps at its own cap and floor', async () => {
        await setup({ perStepAbove: 1.5, perStepBelow: 0.8, cap: 2, floor: 0.7 });
        const up = await act({ action: 'attack', actorId: 'astartes', targetId: 'mortal', outcome: 'hit', damage: 10 });
        expect(up.r.bandScale).toEqual({ steps: 2, multiplier: 2, before: 10, after: 20 });
        const down = await act({ action: 'attack', actorId: 'mortal', targetId: 'primarch', outcome: 'hit', damage: 10 });
        expect(down.r.bandScale).toEqual({ steps: -5, multiplier: 0.7, before: 10, after: 7 });
    });

    it('a blow that landed never drops below 1', async () => {
        await setup({});
        const { r } = await act({ action: 'attack', actorId: 'mortal', targetId: 'primarch', outcome: 'hit', damage: 2 });
        expect(r.bandScale).toEqual({ steps: -5, multiplier: 0.25, before: 2, after: 1 });
        expect(tok('primarch').hp).toBe(499);
    });

    it('no rule, a rule without damageScale, or an unset band: damage is identical', async () => {
        for (const scale of ['none', null] as Scale[]) {
            await setup(scale);
            const { r } = await act({ action: 'attack', actorId: 'elite', targetId: 'astartes', outcome: 'hit', damage: 20 });
            expect(r.bandScale).toBeUndefined();
            expect(r.damage.total).toBe(20);
            expect(tok('astartes').hp).toBe(180);
        }
        await setup({});
        const unset = await act({ action: 'attack', actorId: 'elite', targetId: 'nobody', outcome: 'hit', damage: 20 });
        expect(unset.r.bandScale).toBeUndefined();
        expect(tok('nobody').hp).toBe(20);
        freshAction('elite');
        const level = await act({ action: 'attack', actorId: 'elite', targetId: 'scions', outcome: 'hit', damage: 3 });
        expect(level.r.bandScale).toBeUndefined();
    });

    it('bandScale: false skips it for one swing', async () => {
        await setup({});
        const { r } = await act({ action: 'attack', actorId: 'elite', targetId: 'astartes', outcome: 'hit', damage: 20, bandScale: false });
        expect(r.bandScale).toBeUndefined();
        expect(tok('astartes').hp).toBe(180);
    });

    it('applies after resistance, on a rolled hit too', async () => {
        await setup({});
        live('astartes').resistances = ['fire'];
        const { r } = await act({ action: 'attack', actorId: 'elite', targetId: 'astartes', outcome: 'hit', damage: 20, damageType: 'fire' });
        expect(r.damage.modifier).toBe('resistant');
        expect(r.bandScale).toEqual({ steps: -1, multiplier: 0.5, before: 10, after: 5 });
        freshAction('elite');
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(15);
        const rolled = await act({ action: 'attack', actorId: 'elite', targetId: 'mortal', attackBonus: 5, damage: 8 });
        expect(rolled.r.roll.hit).toBe(true);
        expect(rolled.r.bandScale).toEqual({ steps: 1, multiplier: 1.25, before: 8, after: 10 });
    });

    it('a volley scales by the unit band', async () => {
        await setup({});
        const { text, r } = await act({ action: 'volley', actorId: 'scions', targetId: 'astartes', outcome: 'hit', damage: 20 });
        expect(text).toMatch(/VOLLEY 4d6/);
        expect(r.bandScale).toEqual({ steps: -1, multiplier: 0.5, before: 20, after: 10 });
        expect(tok('astartes').hp).toBe(190);
    });

    it('apply_damage scales per target when an actor is given, never without one', async () => {
        await setup({});
        const withActor = await manage({ action: 'apply_damage', targetIds: ['astartes', 'mortal', 'nobody'], dice: 20, source: 'bite', actorId: 'elite' });
        const by = Object.fromEntries(withActor.r.targets.map((t: any) => [t.targetId, t]));
        expect(by.astartes.damageTaken).toBe(10);
        expect(by.astartes.bandScale).toEqual({ steps: -1, multiplier: 0.5, before: 20, after: 10 });
        expect(by.mortal.damageTaken).toBe(25);
        expect(by.mortal.bandScale).toMatchObject({ steps: 1, multiplier: 1.25 });
        expect(by.nobody.damageTaken).toBe(20);
        expect(by.nobody.bandScale).toBeUndefined();
        expect(withActor.text).toMatch(/×0\.5 band \(20 → 10\)/);
        const hazard = await manage({ action: 'apply_damage', targetIds: ['astartes'], dice: 20, source: 'rubble' });
        expect(hazard.r.targets[0].damageTaken).toBe(20);
        expect(hazard.r.targets[0].bandScale).toBeUndefined();
        expect(tok('astartes').hp).toBe(170);
    });

    it('apply_damage on sheets outside a fight scales the same way', async () => {
        await setup({});
        await manage({ action: 'end' });
        const r = (await manage({ action: 'apply_damage', encounterId: undefined, targetIds: ['astartes'], dice: 20, source: 'bite', actorId: 'elite' })).r;
        expect(r.targets[0].damageTaken).toBe(10);
        expect(r.targets[0].bandScale).toEqual({ steps: -1, multiplier: 0.5, before: 20, after: 10 });
        expect(new CharacterRepository(getDb()).findById('astartes')!.hp).toBe(190);
    });

    it('execute is never scaled: a pinned lower-band foe takes the posted damage', async () => {
        await setup({});
        live('mortal').conditions.push({ type: 'restrained', sourceId: 'grapple: astartes' });
        const { r, d } = await act({ action: 'grapple', move: 'execute', actorId: 'astartes', targetId: 'mortal', damage: 10 });
        expect(d.grappleMove).toBe('execute');
        expect(r.bandScale).toBeUndefined();
        expect(r.damage.total).toBe(10);
        expect(tok('mortal').hp).toBe(20);
    });

    it('surface damage from a throw scales by the thrower band', async () => {
        await setup({});
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        // The lower band rolls at disadvantage: two dice for the thrower, one for the defender.
        spy.mockReturnValueOnce(20).mockReturnValueOnce(20).mockReturnValueOnce(1);
        const { d } = await act({ action: 'grapple', move: 'throw', surface: 'concrete', actorId: 'elite', targetId: 'astartes' });
        expect(d.hit).toBe(true);
        expect(d.bandScale).toMatchObject({ steps: -1, multiplier: 0.5 });
        expect(d.surfaceDamage).toBe(Math.max(1, Math.floor(d.bandScale.before / 2)));
        expect(d.damageDetail).toMatch(/×0\.5 band/);
    });
});
