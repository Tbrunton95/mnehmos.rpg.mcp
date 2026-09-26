import { CombatEngine } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const ctx = { sessionId: 'grapple-control' };
const embedded = (res: any, tag: string) => {
    const m = res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : { rawText: res.content[0].text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');

/** Queue the next engine d20s (actor first, then defender). */
const dice = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

/**
 * Item 5: grapple in one call on the fight's dice. Tokens without sheets can
 * grapple, band and size set disadvantage by themselves, size limits who can
 * be held or thrown, control: true pins instead of hurting, execute finishes
 * a pinned lower-band foe, and break escapes one holder.
 */
describe('one-call grapple', () => {
    let encounterId: string;
    const tokens = () => new EncounterRepository(getDb()).loadState(encounterId)!.participants as any[];
    const tok = (id: string) => tokens().find(t => t.id === id);

    const fight = async (participants: Array<Record<string, unknown>>) => {
        const created = await manage({ action: 'create', seed: 'grapple-control', participants });
        encounterId = created.encounterId;
    };

    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('tokens without character rows grapple on engine dice and spend the attack', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20 },
            { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ]);
        const spy = dice(18, 4);
        const res = await act({ action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(res.hit).toBe(true);
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'grapple', forId: 'marine', targetId: 'cultist' }));
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'grapple', forId: 'cultist', targetId: 'marine' }));
        expect(tok('cultist').conditions.map((c: any) => c.type).sort()).toEqual(['grappled', 'prone']);
        expect(tok('cultist').conditions[0].sourceId).toBe('grapple: marine');
        expect(tok('marine').actionUsed).toBe(true);
        // The attack is spent: a second grapple this turn is refused and writes nothing.
        const again = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(again.error).toBeTruthy();
        expect(String(again.message ?? again.rawText)).toMatch(/already used/i);
    });

    it('a lost grapple still spends the attack and saves the dice position', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20 },
            { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ]);
        const before = JSON.stringify((new EncounterRepository(getDb()).loadState(encounterId) as any).rngState);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(tok('marine').actionUsed).toBe(true);
        expect(JSON.stringify((new EncounterRepository(getDb()).loadState(encounterId) as any).rngState)).not.toBe(before);
    });

    it('the lower band rolls at disadvantage, once, with the reason printed', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, band: 'Astartes' },
            { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true, band: 'Mortal', size: 'small' }
        ]);
        dice(5, 20, 3);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.rolls.defender).toEqual([20, 3]);
        expect(res.rolls.actor).toEqual([5]);
        expect(res.situational).toHaveLength(1);
        expect(res.situational[0]).toMatch(/Cultist.*disadvantage.*lower band.*smaller/);
    });

    it('a smaller escaper breaks at disadvantage', async () => {
        await fight([
            { id: 'imp', name: 'Imp', hp: 10, maxHp: 10, initiative: 20, size: 'small', conditions: [{ name: 'grappled', source: 'grapple: ogre' }] },
            { id: 'ogre', name: 'Ogre', hp: 60, maxHp: 60, initiative: 5, isEnemy: true, size: 'large' }
        ]);
        dice(15, 2, 1);
        const res = await act({ action: 'grapple', move: 'break', encounterId, actorId: 'imp', targetId: 'ogre' });
        expect(res.rolls.actor).toEqual([15, 2]);
        expect(res.situational[0]).toMatch(/Imp.*smaller/);
    });

    it('refuses a target more than one size larger, and a throw of anything larger', async () => {
        await fight([
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20 },
            { id: 'giant', name: 'Giant', hp: 100, maxHp: 100, initiative: 5, isEnemy: true, size: 'huge' },
            { id: 'ogre', name: 'Ogre', hp: 60, maxHp: 60, initiative: 4, isEnemy: true, size: 'large' }
        ]);
        const huge = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'hero', targetId: 'giant' });
        expect(huge.error).toBeTruthy();
        expect(String(huge.message ?? huge.rawText)).toMatch(/huge.*medium|too large|more than one size/i);
        const thrown = await act({ action: 'grapple', move: 'throw', encounterId, actorId: 'hero', targetId: 'ogre' });
        expect(thrown.error).toBeTruthy();
        expect(tok('hero').actionUsed).toBeFalsy();
        // One size up is a legal grapple (the smaller hero rolls at disadvantage).
        dice(20, 20, 1);
        expect((await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'hero', targetId: 'ogre' })).hit).toBe(true);
    });

    it('control: true pins (Grappled + Restrained) with no surface damage', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20 },
            { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ]);
        dice(20, 1);
        const res = await act({ action: 'grapple', move: 'slam', control: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.controlled).toBe(true);
        expect(res.surfaceDamage).toBeUndefined();
        expect(tok('cultist').conditions.map((c: any) => c.type)).toEqual(expect.arrayContaining(['grappled', 'restrained']));
        expect(tok('cultist').hp).toBe(10);
    });

    it('throw without control rolls surface damage on the fight dice', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20 },
            { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ]);
        dice(20, 1);
        const surface = vi.spyOn(CombatEngine.prototype, 'rollDice');
        const res = await act({ action: 'grapple', move: 'throw', surface: 'concrete', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.surfaceDamage).toBeGreaterThanOrEqual(1);
        expect(res.damageDetail).toMatch(/d6/);
        expect(surface).toHaveBeenCalledWith('2d6', expect.objectContaining({ forId: 'marine', targetId: 'cultist' }));
    });

    it('execute finishes a foe this actor pinned, of a lower band, as a posted crit', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, band: 'Astartes', attacksPerAction: 2 },
            { id: 'cultist', name: 'Cultist', hp: 14, maxHp: 14, initiative: 5, isEnemy: true, band: 'Mortal' }
        ]);
        // Not pinned yet: refused.
        const early = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(early.error).toBeTruthy();
        expect(String(early.message ?? early.rawText)).toMatch(/pinned|restrained/i);
        dice(20, 1, 1);
        await act({ action: 'grapple', move: 'control', control: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        const res = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(tok('cultist').hp).toBe(0);
        expect(res.execute).toBeTruthy();
    });

    it('execute is refused against a peer or when bands are unset', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, band: 'Astartes', attacksPerAction: 3 },
            { id: 'rival', name: 'Rival', hp: 60, maxHp: 60, initiative: 5, isEnemy: true, band: 'Astartes',
                conditions: [{ name: 'restrained', source: 'grapple: marine' }] },
            { id: 'thrall', name: 'Thrall', hp: 10, maxHp: 10, initiative: 4, isEnemy: true,
                conditions: [{ name: 'restrained', source: 'grapple: marine' }] }
        ]);
        const peer = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'rival' });
        expect(String(peer.message ?? peer.rawText)).toMatch(/lower band/i);
        const unset = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'thrall' });
        expect(String(unset.message ?? unset.rawText)).toMatch(/band.*unset|unset/i);
        expect(tok('rival').hp).toBe(60);
    });

    it('break with a targetId escapes only that holder; the escaper uses Acrobatics', async () => {
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        repo.create({ id: 'luciel', name: 'Luciel', stats: { str: 10, dex: 18, con: 12, int: 10, wis: 10, cha: 10 }, hp: 40, maxHp: 40, ac: 15, level: 5,
            skillProficiencies: ['acrobatics'], createdAt: now, updatedAt: now } as any);
        await fight([
            { id: 'luciel', name: 'Luciel', hp: 40, maxHp: 40, initiative: 20, conditions: [
                { name: 'grappled', source: 'grapple: a' }, { name: 'restrained', source: 'grapple: b' }
            ] },
            { id: 'a', name: 'A', hp: 20, maxHp: 20, initiative: 5, isEnemy: true },
            { id: 'b', name: 'B', hp: 20, maxHp: 20, initiative: 4, isEnemy: true }
        ]);
        dice(10, 10);
        const res = await act({ action: 'grapple', move: 'break', encounterId, actorId: 'luciel', targetId: 'a' });
        // d20 10 + DEX 4 + prof 3 = 17 vs d20 10 + 0.
        expect(res.breakdown).toMatch(/\+3prof/);
        expect(res.hit).toBe(true);
        expect(tok('luciel').conditions.map((c: any) => c.sourceId)).toEqual(['grapple: b']);
    });

    it('without an encounter, sheets still grapple on logged seeded dice', async () => {
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        for (const [id, name] of [['luciel', 'Luciel'], ['foe', 'Foe']]) {
            repo.create({ id, name, stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 50, maxHp: 50, ac: 14, level: 5, createdAt: now, updatedAt: now } as any);
        }
        const res = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe' });
        expect(res.error).toBeFalsy();
        const logged = getDb().prepare("SELECT for_id FROM roll_log WHERE purpose = 'grapple' ORDER BY for_id").all() as Array<{ for_id: string }>;
        expect(logged.map(r => r.for_id)).toEqual(['foe', 'luciel']);
        if (res.hit) expect(repo.findById('foe')!.conditions).toEqual([expect.objectContaining({ name: 'Clinched', source: 'grapple: luciel' })]);
        const none = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'nobody' });
        expect(String(none.message)).toMatch(/No character nobody/);
    });
});
