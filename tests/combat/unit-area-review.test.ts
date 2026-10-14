/**
 * Play report 7 #1, adversarial review on the merged tree (lanes B, D, A, C, E).
 *
 * Gaps found in area damage on units, per model:
 *  - a band-scaled area on a unit whose band was assumed (lane B) printed the
 *    band multiplier without "(band assumed)", the one line where the
 *    assumption mattered;
 *  - each model's failed save spent one of the token's legendary
 *    resistances (a unit is many bodies; legendary resistance belongs to one
 *    creature), so one area drained them all and the saves line printed
 *    "legendary resistance" as a save modifier;
 *  - a save's rider followed the result most models inside got, the dead
 *    included: a cone that killed the three that failed knocked the three
 *    survivors prone although every one of them saved;
 *  - output_mode 'summary' dropped the per-unit report: cast_spell kept only
 *    each unit's id and apply_damage cut the second unit's line mid-word.
 *    unitLines (the owner's line per unit, the break test named) is kept whole;
 *  - lane B's stats on an ad-hoc unit token reach each model's save, and a
 *    kill credit by count on an assumed-band unit says "(band assumed)".
 */
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { shapeReply } from '../../src/server/output-mode.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'unscoped' };
const W = 'blackcrown';
const ORDER = ['Mortal', 'Elite Mortal', 'Astartes', 'Astartes Elite', 'Monster/Lord', 'Primarch-class'];
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guardedManage = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const guardedAction = withOperation('combat_action', (a) => handleCombatAction(a, ctx as any));
let enc: string;
const manageRaw = (args: Record<string, unknown>) => guardedManage(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }));
const manage = async (args: Record<string, unknown>) => {
    const text = (await manageRaw(args)).content[0].text;
    return { text, r: tag(text, 'COMBAT_MANAGE') ?? { rawText: text } };
};
const actRaw = (args: Record<string, unknown>) => guardedAction(CombatActionTool.inputSchema.parse({ encounterId: enc, ...args }));
const summary = (res: any) => JSON.parse(shapeReply(res, { mode: 'summary' }).content![0].text);
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };
const spellDice = (pattern: RegExp, total: number) => {
    const orig = CombatEngine.prototype.rollDice;
    vi.spyOn(CombatEngine.prototype, 'rollDice').mockImplementation(function (this: CombatEngine, n: string, t: any) {
        if (pattern.test(n)) return { notation: n, rolls: [total], diceTotal: total, modifier: 0, total } as any;
        return orig.call(this, n, t);
    });
};

const MILITIA = (extra: Record<string, unknown> = {}, unit: Record<string, unknown> = {}) => ({
    id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, ac: 11,
    unit: { models: 6, hpPerModel: 9, packed: true, attackBonus: 2, morale: 6, ...unit }, ...extra
});

async function setup(units: any[], opts: { banded?: boolean; mage?: boolean; captain?: boolean } = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
    if (opts.banded) {
        await handleTableRules({ worldId: W, action: 'define', kind: 'band', name: 'bands', spec: { order: ORDER, damageScale: {} } }, ctx as any);
    }
    if (opts.mage) {
        new CharacterRepository(db).create({
            id: 'mage', name: 'Mage', characterClass: 'wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
            hp: 30, maxHp: 30, ac: 12, level: 5, spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: getMaxSpellLevel('wizard' as any, 5),
            knownSpells: ['Fireball'], preparedSpells: ['Fireball'], createdAt: now, updatedAt: now
        } as any);
    }
    if (opts.captain) {
        new CharacterRepository(db).create({
            id: 'captain', name: 'Captain', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 12 }, band: 'Mortal',
            hp: 40, maxHp: 40, ac: 16, level: 5, resourcePools: { blood: { current: 0, max: 100 } }, createdAt: now, updatedAt: now
        } as any);
    }
    const created = await manage({ action: 'create', worldId: W, participants: [
        ...(opts.mage ? [{ id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 70, band: 'Mortal' }] : []),
        { id: 'drake', name: 'Drake', hp: 120, maxHp: 120, initiative: 60, band: 'Astartes', abilities: [{ name: 'Fire Breath', recharge: 5 }] },
        ...units
    ] });
    enc = created.r.encounterId;
    expect(enc, created.text.slice(0, 400)).toBeTruthy();
}
const breath = (extra: Record<string, unknown> = {}) => manage({ action: 'use_ability', participantId: 'drake', ability: 'Fire Breath', targetIds: ['militia'], damage: 12, damageType: 'fire', savingThrow: { ability: 'dex', dc: 13 }, area: true, ...extra });

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('area damage on units: adversarial review (play report 7 #1)', () => {
    it('a band-scaled area on a unit whose band was assumed says "(band assumed)"', async () => {
        await setup([MILITIA()], { banded: true });
        expect(tok('militia')).toMatchObject({ band: 'Mortal', bandAssumed: true });
        const { r } = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 4, source: 'grenade', actorId: 'drake', area: true });
        expect(r.targets[0].bandScale).toMatchObject({ before: 4, after: 6 });
        expect(r.message).toMatch(/×1\.5625 band per model \(4 → 6\) \(band assumed\)/);
        // A band set by the GM carries no tag.
        await manage({ action: 'set_band', participantId: 'militia', band: 'Mortal' });
        const set = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 4, source: 'grenade', actorId: 'drake', area: true });
        expect(set.r.message).toMatch(/×1\.5625 band per model \(4 → 6\)/);
        expect(set.r.message).not.toMatch(/band assumed/);
    });

    it("a model's failed save never spends the unit token's legendary resistance", async () => {
        await setup([MILITIA({ legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: true })]);
        d20s(1, 1, 1, 1, 1, 1);
        const { r } = await breath();
        const ua = r.targets[0].unitArea;
        expect(ua).toMatchObject({ failed: 6, saved: 0, modelsKilled: 6 });
        expect(ua.saves.every((s: any) => !s.saved)).toBe(true);
        expect(ua.saveBonus.parts.join(' ')).not.toMatch(/legendary/);
        expect(r.message).not.toMatch(/legendary resistance \(/);
        expect(tok('militia').legendaryResistancesRemaining).toBe(3);
    });

    it("a save's rider follows the models still standing, not the dead", async () => {
        await setup([MILITIA()]);
        // 12 over 9-HP models: the three that fail die; the three that save stand.
        d20s(20, 1, 20, 1, 1, 20);
        const { r } = await breath({ savingThrow: { ability: 'dex', dc: 13, onFail: { conditions: ['prone'] } } });
        expect(r.targets[0].unitArea).toMatchObject({ failed: 3, saved: 3, modelsKilled: 3, modelsAfter: 3 });
        expect(r.targets[0].conditionsApplied).toBeUndefined();
        expect((tok('militia').conditions ?? []).map((c: any) => c.type)).not.toContain('prone');
    });

    it('survivors that mostly failed take the rider; a unit the area wiped takes none', async () => {
        await setup([MILITIA(), { ...MILITIA(), id: 'm2', name: 'Second Militia' }]);
        // 4 fire kills no one: two save, four fail and stand.
        d20s(20, 1, 1, 20, 1, 1);
        const low = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 4, source: 'embers', area: true, save: { ability: 'dex', dc: 13, onFail: { conditions: ['prone'] } } });
        expect(low.r.targets[0].unitArea).toMatchObject({ failed: 4, saved: 2, modelsKilled: 0 });
        expect(low.r.targets[0].conditionsApplied).toEqual(['prone']);
        // 31 kills all six whatever they roll: nobody is left to fall prone.
        d20s(1, 1, 1, 1, 1, 1);
        const wipe = await manage({ action: 'apply_damage', targetIds: ['m2'], dice: 31, source: 'cone', area: true, save: { ability: 'dex', dc: 13, onFail: { conditions: ['prone'] } } });
        expect(wipe.r.targets[0].unitArea).toMatchObject({ modelsKilled: 6, modelsAfter: 0 });
        expect(wipe.r.targets[0].conditionsApplied).toBeUndefined();
    });

    it("output_mode 'summary' keeps each unit's line whole on apply_damage and use_ability", async () => {
        await setup([MILITIA(), { ...MILITIA(), id: 'm2', name: 'Second Militia' }]);
        d20s(20, 1, 20, 1, 1, 20, 1, 1, 1, 1, 1, 1);
        const res = await manageRaw({ action: 'apply_damage', targetIds: ['militia', 'm2'], dice: 12, source: 'Fire Breath of the great drake Ignathrax, rolling down the ridge', area: true, save: { ability: 'dex', dc: 13 } });
        const s = summary(res);
        expect(s.unitLines).toEqual([
            'Militia — 6 in the area: 3 failed, 3 saved; 12 / 6 vs 9 HP each: 3 dead, 3/6 left; BREAK TEST DUE (morale 6)',
            'Second Militia — 6 in the area: 6 failed, 0 saved; 12 / 6 vs 9 HP each: 6 dead, 0/6 left'
        ]);
        // Three models are left: one fails and dies, two save and stand.
        d20s(20, 1, 20);
        const ab =await manageRaw({ action: 'use_ability', participantId: 'drake', ability: 'Fire Breath', targetIds: ['militia'], damage: 12, savingThrow: { ability: 'dex', dc: 13 }, area: true });
        expect(summary(ab).unitLines).toEqual(['Militia — 3 in the area: 1 failed, 2 saved; 12 / 6 vs 9 HP each: 1 dead, 2/6 left']);
    });

    it("output_mode 'summary' keeps each unit's line on lair_action (its prose was cut at 300 characters)", async () => {
        closeDb();
        const db = getDb(':memory:');
        clearCombatState();
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
        enc = (await manage({ action: 'create', worldId: W, participants: [
            { id: 'drake', name: 'Drake', hp: 120, maxHp: 120, initiative: 10, hasLairActions: true },
            MILITIA({ initiative: 5 }), { ...MILITIA({ initiative: 4 }), id: 'm2', name: 'Second Militia' }
        ] })).r.encounterId;
        expect(new EncounterRepository(getDb()).loadState(enc)!.turnOrder[0]).toBe('LAIR');
        const res = await manageRaw({ action: 'lair_action', actionDescription: 'The cavern roof gives way along the whole western gallery, and the scree runs down over the ranks below', targetIds: ['militia', 'm2'], damage: 10 });
        const s = summary(res);
        expect(s.unitLines).toEqual([
            'Militia — 6 in the area, no save: 10 vs 9 HP each: 6 dead, 0/6 left',
            'Second Militia — 6 in the area, no save: 10 vs 9 HP each: 6 dead, 0/6 left'
        ]);
    });

    it("output_mode 'summary' keeps each unit's line on cast_spell (it kept only the unit's id)", async () => {
        await setup([MILITIA()], { mage: true });
        spellDice(/^8d6$/, 12);
        d20s(20, 1, 20, 1, 1, 20);
        const res = await actRaw({ action: 'cast_spell', actorId: 'mage', spellName: 'Fireball', targetIds: ['militia'] });
        const s = summary(res);
        expect(s.unitLines).toEqual(['Militia — 6 in the sphere: 3 failed, 3 saved; 12 / 6 vs 9 HP each: 3 dead, 3/6 left; BREAK TEST DUE (morale 6)']);
    });

    it('a world spell given modelsInArea says the count was not used (it has no area flag)', async () => {
        await setup([MILITIA()], { mage: true });
        await handleTableRules({ worldId: W, action: 'define', kind: 'spell', name: 'Quake', spec: { effects: [{ type: 'damage', dice: '20' }] } }, ctx as any);
        const res = await actRaw({ action: 'cast_spell', actorId: 'mage', spellName: 'Quake', targetId: 'militia', modelsInArea: { militia: 2 } });
        const text = res.content[0].text;
        expect(text).toMatch(/modelsInArea ignored: Quake is a world spell with no area flag/);
        expect(tok('militia').hp).toBe(34);
    });

    it('kill credit counts the models and says when the per-band credit read an assumed band', async () => {
        await setup([MILITIA()], { banded: true, captain: true });
        await handleTableRules({ worldId: W, action: 'define', kind: 'growth_track', name: 'Blood', spec: { pool: 'blood', perKill: 1, perBandAbove: 1, steps: [{ at: 50, condition: { name: 'Veteran' } }] } }, ctx as any);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 10, source: 'grenade', actorId: 'captain', modelsInArea: { militia: 4 } });
        expect(r.targets[0].unitArea).toMatchObject({ modelsKilled: 4, modelsAfter: 2 });
        // perKill 1 + perBandAbove 1 (Mortal over Mortal), four times over.
        expect(r.growth?.[0]).toMatchObject({ victimId: 'militia', modelsKilled: 4, delta: 8, kills: 4, reason: 'kill: 4 × Militia (band assumed)' });
    });

    it("cover adds to every model's DEX save; a CON save takes none and says so", async () => {
        await setup([MILITIA()]);
        // d20 11 + half cover +2 = 13 vs DC 13: every model saves.
        d20s(11, 11, 11, 11, 11, 11);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 12, source: 'scree', area: true, cover: { militia: 'half' }, save: { ability: 'dex', dc: 13 } });
        expect(r.targets[0].unitArea).toMatchObject({ saved: 6, failed: 0, modelsKilled: 0 });
        expect(r.targets[0].unitArea.saves.every((x: any) => x.total === 13)).toBe(true);
        expect(r.targets[0].cover).toMatchObject({ kind: 'half', saveBonus: 2 });
        expect(r.message).toMatch(/cover \+2 = \+2/);
        d20s(11, 11, 11, 11, 11, 11);
        const con = await manage({ action: 'apply_damage', targetIds: ['militia'], dice: 12, source: 'spores', area: true, cover: { militia: 'half' }, save: { ability: 'con', dc: 13 } });
        expect(con.r.targets[0].unitArea).toMatchObject({ saved: 0, failed: 6, modelsKilled: 6 });
        expect(con.r.targets[0].cover).toMatchObject({ saveBonus: 0, note: 'cover adds to DEX saves only' });
    });

    it('resistance and immunity apply per model, after the save', async () => {
        await setup([MILITIA({ resistances: ['fire'] }), { ...MILITIA({ immunities: ['fire'] }), id: 'm2', name: 'Salamanders' }]);
        d20s(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1);
        const { r } = await manage({ action: 'apply_damage', targetIds: ['militia', 'm2'], dice: 31, damageType: 'fire', source: 'cone', area: true, save: { ability: 'dex', dc: 13 } });
        // Resistant: 31 → 15 on a failure (15 / 7): every model dies.
        expect(r.targets[0].unitArea).toMatchObject({ perModel: { full: 15, half: 7 }, modelsKilled: 6 });
        expect(r.targets[0].damageModifier).toBe('resistant');
        expect(r.targets[1].unitArea).toMatchObject({ perModel: { full: 0, half: 0 }, modelsKilled: 0, modelsAfter: 6 });
        expect(tok('m2').hp).toBe(54);
    });

    it('unit.saves set mid-fight survives a fresh process (the encounter row, not the cached engine)', async () => {
        await setup([MILITIA()]);
        await manage({ action: 'set_unit', participantId: 'militia', saves: { dex: 3 } });
        clearCombatState();
        d20s(10, 10, 10, 10, 10, 10);
        const { r } = await breath();
        expect(r.targets[0].unitArea).toMatchObject({ saved: 6, saveBonus: { total: 3, drilled: 3 } });
    });

    it("lane B's stats on an ad-hoc unit token reach every model's save, with unit.saves on top", async () => {
        await setup([MILITIA({ stats: { dex: 14 } }, { saves: { dex: 1 } })]);
        expect(tok('militia').abilityScores).toMatchObject({ dexterity: 14 });
        d20s(10, 10, 10, 10, 10, 9);
        const { r } = await breath();
        // d20 10 + DEX +2 + drilled +1 = 13 vs DC 13 saves; 9 → 12 fails.
        expect(r.targets[0].unitArea).toMatchObject({ saved: 5, failed: 1, saveBonus: { total: 3, drilled: 1 } });
        expect(r.message).toMatch(/DEX \+2, drilled \+1 = \+3/);
    });
});
