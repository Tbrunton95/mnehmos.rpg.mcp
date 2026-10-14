import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { ConcentrationRepository } from '../../src/storage/repos/concentration.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { DEFAULT_BAND_ORDER } from '../../src/engine/table-rules.js';

/**
 * Play report 2, item 4: execute existed only as an attack rewrite inside an
 * encounter. On character sheets (no encounterId) it now reads the pin from
 * the sheet, applies the damage to the row and, at 0 HP, kills through the
 * same path as character_manage kill: HP 0, concentration ended, a corpse
 * row stamped with the world. With no damage given it is a coup de grâce
 * (its HP, defences bypassed); posted or dice damage respects defences.
 */
const W = 'exec-world';
const ctx = { sessionId: 'sheet-execute' };
const embedded = (res: any) => {
    const m = res.content[0].text.match(/<!-- COMBAT_ACTION_JSON\n([\s\S]*?)\nCOMBAT_ACTION_JSON -->/);
    return m ? JSON.parse(m[1]) : { rawText: res.content[0].text };
};
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any));
const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
const corpses = () => { try { return getDb().prepare('SELECT character_id, world_id FROM corpses').all() as Array<{ character_id: string; world_id: string | null }>; } catch { return []; } };
const rollLog = (purpose: string) => { try { return getDb().prepare('SELECT for_id, target_id, expression, result FROM roll_log WHERE purpose = ?').all(purpose) as Array<{ for_id: string; target_id: string; expression: string; result: number }>; } catch { return []; } };

beforeEach(async () => {
    closeDb(); clearCombatState();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Exec', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    await handleTableRules({ action: 'define', worldId: W, kind: 'band', name: 'bands', spec: { order: DEFAULT_BAND_ORDER } }, ctx as any);
    const repo = new CharacterRepository(db);
    const mk = (id: string, name: string, extra: Record<string, unknown>) => repo.create({
        id, name, stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, ac: 14, level: 5, createdAt: now, updatedAt: now, ...extra
    } as any);
    mk('luciel', 'Luciel', { hp: 200, maxHp: 200, band: 'Astartes', level: 12, characterType: 'pc' });
    mk('cultist', 'Cultist', { hp: 14, maxHp: 14, band: 'Mortal', characterType: 'enemy', resistances: ['slashing'], conditions: [{ name: 'Restrained', source: 'grapple: luciel' }] });
    mk('rival', 'Rival', { hp: 60, maxHp: 60, band: 'Astartes', conditions: [{ name: 'Restrained', source: 'grapple: luciel' }] });
    mk('loose', 'Loose', { hp: 14, maxHp: 14, band: 'Mortal' });
    new ConcentrationRepository(db).create({ characterId: 'cultist', activeSpell: 'Bless', spellLevel: 1, startedAt: 1, maxDuration: 10, targetIds: [] });
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('grapple execute on character sheets', () => {
    it('with no damage it is a coup de grâce: HP 0, concentration ended, a corpse with the world, nothing rolled', async () => {
        const res = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(res).toMatchObject({ actionType: 'grapple', grappleMove: 'execute', pinFrom: 'sheet', writesTo: 'sheet', hpBefore: 14, hpAfter: 0, damage: 14, defeated: true, killed: true });
        expect(res.damageDetail).toMatch(/coup de grâce/);
        expect(res.corpseId).toBeTruthy();
        expect(res.concentration).toMatchObject({ spell: 'Bless', broken: true });
        expect(res.message).toMatch(/Luciel executes Cultist/);
        expect(sheet('cultist').hp).toBe(0);
        expect(corpses()).toEqual([{ character_id: 'cultist', world_id: W }]);
        expect(new ConcentrationRepository(getDb()).isConcentrating('cultist')).toBe(false);
        expect(rollLog('execute damage')).toEqual([]);
    });

    it('a damageType with no damage still bypasses resistance: the coup de grâce kills', async () => {
        const res = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'cultist', damageType: 'slashing' });
        expect(res.killed).toBe(true);
        expect(res.damage).toBe(14);
        expect(res.damageModifier).toBeUndefined();
        expect(sheet('cultist').hp).toBe(0);
    });

    it('dice damage is a crit (dice doubled) logged as execute damage; posted and rolled damage respect resistance; a survivor keeps breathing', async () => {
        const rolled = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'cultist', damage: '2d6', damageType: 'slashing' });
        expect(rolled.error).toBeFalsy();
        const log = rollLog('execute damage');
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ for_id: 'luciel', target_id: 'cultist', expression: '4d6' });
        expect(rolled.damageModifier).toBe('resistant');
        expect(rolled.damage).toBe(Math.floor(log[0].result / 2));
        expect(rolled.damageDetail).toMatch(/4d6.*crit/);
        expect(rolled.hpAfter).toBe(14 - rolled.damage);
        expect(rolled.killed).toBe(false);
        expect(rolled.defeated).toBe(false);
        expect(sheet('cultist').hp).toBe(rolled.hpAfter);
        expect(corpses()).toEqual([]);
        // Concentration took a CON save, not death.
        expect(rolled.concentration).toMatchObject({ spell: 'Bless' });
        expect(rolled.concentration.reason).not.toBe('death');
        // A posted number is halved by the resistance too.
        const before = sheet('cultist').hp;
        const posted = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'cultist', damage: 4, damageType: 'slashing' });
        expect(posted.damage).toBe(2);
        expect(posted.damageDetail).toMatch(/posted.*resistant/);
        expect(sheet('cultist').hp).toBe(Math.max(0, before - 2));
    });

    it("play report 7 (lane H): the survivor's concentration save reads its Steady Mind (save:con): two logged dice, the labels on the reply", async () => {
        new CustomEffectsRepository(getDb()).apply({
            target_id: 'cultist', target_type: 'character', name: 'Steady Mind', description: 'Steady Mind', category: 'boon', power_level: 1,
            source: { type: 'unknown' }, mechanics: [{ type: 'advantage_on', value: 'save:con' }] as never, duration: { type: 'until_removed' as never },
            triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
        } as never);
        const res = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'cultist', damage: 4 });
        expect(res.killed).toBe(false);
        expect(res.concentration).toMatchObject({ spell: 'Bless', reason: expect.stringMatching(/damage|failed_save/), advantageSources: ['Steady Mind (save:con)'] });
        expect(res.concentration.saveRolls).toHaveLength(2);
        expect(res.concentration.saveRoll).toBe(Math.max(...res.concentration.saveRolls));
        const logged = rollLog('concentration (adv: Steady Mind (save:con))');
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ for_id: 'cultist', expression: '2d20kh1', result: res.concentration.saveRoll });
        expect(res.saveSources).toEqual([{ targetId: 'cultist', name: 'Cultist', ability: 'constitution', save: 'concentration on Bless', broken: res.concentration.broken, rolls: res.concentration.saveRolls, advantage: ['Steady Mind (save:con)'] }]);
        expect(res.message).toMatch(/Concentration on Bless: (held|BROKEN) \[d20 \d+, \d+; adv: Steady Mind \(save:con\)\]/);
    });

    it("lane K: the survivor's failed concentration save spends its autoLegendaryResistance from the sheet, so its spell holds; without it the restore call is reported", async () => {
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        // CON 10 against DC 30 (60 damage): the save always fails.
        repo.create({
            id: 'warlock', name: 'Warlock', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 16 }, ac: 12, level: 5, hp: 200, maxHp: 200,
            band: 'Mortal', characterType: 'enemy', legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: true,
            conditions: [{ name: 'Restrained', source: 'grapple: luciel' }], createdAt: now, updatedAt: now
        } as any);
        new ConcentrationRepository(getDb()).create({ characterId: 'warlock', activeSpell: 'Hex', spellLevel: 1, startedAt: 1, maxDuration: 10, targetIds: [] });
        const res = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'warlock', damage: 60 });
        expect(res.error).toBeFalsy();
        expect(res.concentration).toMatchObject({ spell: 'Hex', broken: false, legendaryResisted: true, legendaryRemaining: 2, legendaryOf: 3 });
        expect(res.message).toMatch(/Concentration on Hex: failed → 👑 legendary resistance \(LR 2\/3 left\): held/);
        expect(new ConcentrationRepository(getDb()).findByCharacterId('warlock')?.activeSpell).toBe('Hex');
        expect(sheet('warlock').legendaryResistancesRemaining).toBe(2);

        repo.update('warlock', { autoLegendaryResistance: false } as any);
        const offered = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'warlock', damage: 60 });
        const repair = "concentration_manage restore {characterId: 'warlock', spell: 'Hex', spellLevel: 1, startedAt: 1, maxDuration: 10, spendLegendaryResistance: true}";
        expect(offered.concentration).toMatchObject({ broken: true, legendaryResistanceAvailable: 2, legendaryOffer: { remaining: 2, of: 3, call: repair } });
        expect(offered.legendaryOffers).toEqual([expect.objectContaining({ participantId: 'warlock', kind: 'concentration', call: repair, noFight: true })]);
        expect(offered.message).toContain(`BROKEN ⭐ LR 2/3 left, spend one? ${repair}`);
        expect(new ConcentrationRepository(getDb()).isConcentrating('warlock')).toBe(false);
        expect(sheet('warlock').legendaryResistancesRemaining).toBe(2);
    });

    it('refusals write nothing: missing row, peer band, unpinned target, posted lose, already down', async () => {
        const cases: Array<[Record<string, unknown>, RegExp]> = [
            [{ targetId: 'nobody' }, /No character nobody/],
            [{ targetId: 'rival' }, /lower band/],
            [{ targetId: 'loose' }, /pinned by Luciel: found nothing/],
            [{ targetId: 'cultist', outcome: 'lose' }, /not contested/]
        ];
        for (const [extra, re] of cases) {
            const res = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', ...extra });
            expect(res.error).toBeTruthy();
            expect(res.writes).toBe('none');
            expect(String(res.message)).toMatch(re);
        }
        new CharacterRepository(getDb()).update('cultist', { hp: 0 });
        const down = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'cultist' });
        expect(down.error).toBeTruthy();
        expect(String(down.message)).toMatch(/already down/);
        expect(corpses()).toEqual([]);
        expect(sheet('rival').hp).toBe(60);
        expect(sheet('loose').hp).toBe(14);
    });

    it('an actor at 0 HP or helpless on its sheet cannot execute: refused, no corpse, the target untouched', async () => {
        const repo = new CharacterRepository(getDb());
        repo.update('luciel', { hp: 0 });
        const down = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'cultist' });
        expect(down.error).toBeTruthy();
        expect(down.writes).toBe('none');
        expect(String(down.message)).toMatch(/Luciel cannot execute anyone: Luciel is at 0 HP/);
        repo.update('luciel', { hp: 200, conditions: [{ name: 'Paralysed' }] } as never);
        const held = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'cultist' });
        expect(held.error).toBeTruthy();
        expect(held.writes).toBe('none');
        expect(String(held.message)).toMatch(/Luciel is Paralysed/);
        expect(sheet('cultist').hp).toBe(14);
        expect(corpses()).toEqual([]);
        expect(new ConcentrationRepository(getDb()).isConcentrating('cultist')).toBe(true);
    });

    it("a sheet execute credits the kill to the actor's growth track (item 6)", async () => {
        await handleTableRules({ action: 'define', worldId: W, kind: 'growth_track', name: 'Blooded', spec: {
            pool: 'growth', perKill: 1, perBandAbove: 1, steps: [{ at: 50, condition: { name: 'Blooded' } }]
        } }, ctx as any);
        new CharacterRepository(getDb()).update('luciel', { resourcePools: { growth: { current: 3, max: 100 } } } as never);
        const res = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'cultist' });
        expect(res.killed).toBe(true);
        expect(res.growth).toMatchObject({ track: 'Blooded', pool: 'growth', delta: 1, from: 3, to: 4, reason: 'kill: Cultist' });
        expect(res.message).toMatch(/GROWTH Blooded: growth 3 → 4/);
        expect(sheet('luciel').resourcePools.growth.current).toBe(4);
    });

    it('the pin may be written in any accepted form on the sheet', async () => {
        new CharacterRepository(getDb()).update('loose', { conditions: [{ name: 'Grappled', source: 'Luciel' }, { name: 'Prone' }] } as never);
        const res = await act({ action: 'grapple', move: 'execute', actorId: 'luciel', targetId: 'loose' });
        expect(res.error).toBeFalsy();
        expect(res.killed).toBe(true);
    });
});
