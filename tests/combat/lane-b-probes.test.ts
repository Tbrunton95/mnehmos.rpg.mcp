import { CombatEngine } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 5, lane B verification probes: the branches the lane's own
 * tests did not walk. The shove's STR save on the character sheets (no
 * encounter), legendary resistance on that save in a fight, a non-lethal
 * blow through a ranged profile, and a second prone shove on a target already
 * prone.
 */
const ctx = { sessionId: 'lane-b-probes' };
const embedded = (res: any, tag: string) => {
    const m = res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : { rawText: res.content[0].text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');
const dice = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};
const now = () => new Date().toISOString();

describe('lane B probes', () => {
    let encounterId: string;
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(encounterId)!.participants.find((t: any) => t.id === id) as any;
    const fight = async (participants: Array<Record<string, unknown>>) => {
        const created = await manage({ action: 'create', seed: 'lane-b-probes', participants });
        encounterId = created.encounterId;
    };
    const marine = { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, position: { x: 2, y: 2 } };
    const cultist = { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true, position: { x: 3, y: 2 }, attackBonus: 4, attackDamage: '1d6' };

    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('shove {save} on the character sheets (no encounter): the target rolls a logged STR save against 8 + prof + STR, and only a failed save pushes (narratively)', async () => {
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'luciel', name: 'Luciel', characterType: 'pc', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 50, maxHp: 50, ac: 14, level: 5, createdAt: now(), updatedAt: now() } as any);
        repo.create({ id: 'foe', name: 'Foe', characterType: 'npc', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 12, level: 1, createdAt: now(), updatedAt: now() } as any);
        const res = await act({ action: 'grapple', move: 'shove', save: { ability: 'str' }, actorId: 'luciel', targetId: 'foe' });
        expect(res.error).toBeFalsy();
        // Level 5 → proficiency 3; STR 16 → +3; 8 + 3 + 3 = 14, from the sheet.
        expect(res.save).toMatchObject({ ability: 'strength', dc: 14, dcSource: expect.stringMatching(/sheet/) });
        expect(typeof res.save.saved).toBe('boolean');
        expect(res.rolls).toBeUndefined();          // no contest dice
        const logged = (getDb().prepare("SELECT purpose FROM roll_log WHERE purpose LIKE '%shove save%'").all() as Array<{ purpose: string }>);
        expect(logged.length).toBe(1);
        if (res.save.saved) {
            expect(res.hit).toBe(false);
            expect(res.pushed).toBeUndefined();
        } else {
            expect(res.hit).toBe(true);
            expect(res.pushed).toMatchObject({ feet: 5, narrative: true });
        }
        expect(res.ignoredParams).toBeUndefined();
    });

    it('legendary resistance is honoured on the shove save: an automatic one turns the failed save and the push does not happen; otherwise the count is offered', async () => {
        await fight([{ ...marine, cr: 5 }, { ...cultist, legendaryResistances: 1, autoLegendaryResistance: true }]);
        const live = getOrLoadEngine(ctx as any, encounterId)!.getState()!.participants.find(p => p.id === 'marine')!;
        live.abilityScores = { strength: 16, dexterity: 12, constitution: 14, intelligence: 10, wisdom: 10, charisma: 10 };
        dice(1);
        const res = await act({ action: 'grapple', move: 'shove', save: { ability: 'str' }, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(res.save).toMatchObject({ dc: 14, natural: 1, saved: true, legendaryResisted: true });
        expect(res.hit).toBe(false);
        expect(res.pushed).toBeUndefined();
        expect(tok('cultist').position).toEqual({ x: 3, y: 2 });
        expect(tok('cultist').legendaryResistancesRemaining).toBe(0);
        expect(tok('marine').attacksMade).toBe(1);   // the attack is still spent
        expect(String(res.breakdown)).toMatch(/legendary resistance/);

        // Without the automatic spend the save fails, the GM is told one is available, and the push lands.
        closeDb(); getDb(':memory:'); clearCombatState();
        await fight([{ ...marine, cr: 5 }, { ...cultist, legendaryResistances: 2 }]);
        dice(1);
        const offered = await act({ action: 'grapple', move: 'shove', save: { ability: 'str' }, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(offered.save).toMatchObject({ saved: false, legendaryResistanceAvailable: 2 });
        expect(offered.hit).toBe(true);
        expect(offered.pushed).toMatchObject({ feet: 5, to: { x: 4, y: 2 } });
    });

    it('nonlethal through a ranged attack profile is refused with nothing spent (the profile says ranged)', async () => {
        await fight([{ ...marine, attacks: [{ name: 'longbow', attackBonus: 5, damage: '1d8', damageType: 'piercing', ranged: true }] }, cultist]);
        const res = await act({ action: 'attack', encounterId, actorId: 'marine', targetId: 'cultist', using: 'longbow', nonlethal: true });
        expect(res.error).toBe(true);
        expect(res.writes).toBe('none');
        expect(String(res.message)).toMatch(/melee only/);
        expect(tok('marine').actionUsed).toBeFalsy();
        expect(tok('cultist').hp).toBe(10);
    });

    it('a prone shove on a target already prone writes one Prone, not two, and still spends the attack', async () => {
        await fight([{ ...marine, attacksPerAction: 2 }, cultist]);
        dice(18, 4);
        const first = await act({ action: 'grapple', move: 'shove', prone: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(first.hit).toBe(true);
        dice(18, 4);
        const again = await act({ action: 'grapple', move: 'shove', prone: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(again.error).toBeFalsy();
        expect(tok('cultist').conditions.filter((c: any) => c.type === 'prone')).toHaveLength(1);
        expect(tok('marine').attacksMade).toBe(2);
    });
});
