import { CombatEngine } from '../../src/engine/combat/engine.js';
import { ConditionType, DurationType } from '../../src/engine/combat/conditions.js';
import { isKnockedOut, nonlethalSource } from '../../src/engine/combat/nonlethal.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 5, item 4: `attack {nonlethal: true}` (melee only). A blow that
 * drops the target to 0 leaves it at 0 HP, Unconscious (sourced
 * 'nonlethal: <actor>') and stable — no death saves, no kill credit, no
 * corpse — and prints [KNOCKED OUT — stable]. Healing above 0 (the heal
 * action, engine.heal, a posted adjust_hp) removes the nonlethal Unconscious
 * on the token and the sheet. Ranged attacks, volleys, cleaves and units are
 * refused before anything is spent.
 */
const ctx = { sessionId: 'nonlethal' };
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

describe('nonlethal attacks', () => {
    let encounterId: string;
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(encounterId)!.participants.find((t: any) => t.id === id) as any;
    const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
    const corpses = () => (getDb().prepare('SELECT COUNT(*) AS n FROM corpses').get() as { n: number }).n;
    const attack = (extra: Record<string, unknown>) => act({ action: 'attack', encounterId, actorId: 'brannoc', targetId: 'bandit', ...extra });

    const brannoc = { id: 'brannoc', name: 'Brannoc', hp: 44, maxHp: 44, initiative: 20, position: { x: 0, y: 0 } };
    const bandit = { id: 'bandit', name: 'Bandit', hp: 5, maxHp: 5, ac: 10, initiative: 10, isEnemy: true, position: { x: 1, y: 0 } };
    const thug = { id: 'thug', name: 'Thug', hp: 5, maxHp: 5, ac: 10, initiative: 5, isEnemy: true, position: { x: 0, y: 1 }, attackBonus: 3, attackDamage: '1d4' };

    const setup = async (extra: Array<Record<string, unknown>> = []) => {
        closeDb(); getDb(':memory:'); clearCombatState();
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        repo.create({ id: 'brannoc', name: 'Brannoc', characterType: 'pc', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 }, hp: 44, maxHp: 44, ac: 18, level: 5, createdAt: now, updatedAt: now } as any);
        repo.create({ id: 'bandit', name: 'Bandit', characterType: 'npc', stats: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, hp: 5, maxHp: 5, ac: 10, level: 1, createdAt: now, updatedAt: now } as any);
        const created = await manage({ action: 'create', seed: 'nonlethal', participants: [brannoc, bandit, thug, ...extra] });
        encounterId = created.encounterId;
    };
    beforeEach(() => setup());
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('a dropping blow knocks the target out: 0 HP, Unconscious sourced to the actor, stable, no saves, no kill, no corpse', async () => {
        dice(15);
        const res = await attack({ damage: 10, damageType: 'bludgeoning', nonlethal: true });
        expect(res.error).toBeFalsy();
        const r = res.actionResult;
        expect(r.success).toBe(true);
        expect(r.defeated).toBe(true);
        expect(r.knockedOut).toMatchObject({ by: 'brannoc', stable: true });
        expect(r.growth).toBeUndefined();
        expect(res.rawText).toMatch(/KNOCKED OUT/);
        expect(res.rawText).not.toMatch(/DEFEATED/);

        const t = tok('bandit');
        expect(t.hp).toBe(0);
        expect(t.isStabilized).toBe(true);
        expect(t.deathSaveSuccesses ?? 0).toBe(0);
        expect(t.deathSaveFailures ?? 0).toBe(0);
        expect(t.isDead).toBeFalsy();
        expect(t.conditions).toEqual([expect.objectContaining({ type: 'unconscious', sourceId: 'nonlethal: brannoc' })]);
        expect(isKnockedOut(t)).toBe(true);

        const s = sheet('bandit');
        expect(s.hp).toBe(0);
        expect(s.conditions).toEqual([expect.objectContaining({ name: 'Unconscious', source: 'nonlethal: brannoc' })]);
        expect(corpses()).toBe(0);

        // The state view says knocked out, not defeated.
        const view = await manage({ action: 'get', encounterId });
        expect(view.participants.find((p: any) => p.id === 'bandit')).toMatchObject({ knockedOut: true, stable: true, isDefeated: true });
        expect(String(view.rawText ?? JSON.stringify(view))).toMatch(/KNOCKED OUT/);
    });

    it('a blow that does not drop the target behaves exactly as before: no condition, no flag', async () => {
        dice(15);
        const res = await attack({ damage: 1, nonlethal: true });
        expect(res.actionResult.success).toBe(true);
        expect(res.actionResult.knockedOut).toBeUndefined();
        expect(tok('bandit')).toMatchObject({ hp: 4, conditions: [] });
        expect(tok('bandit').isStabilized).toBeFalsy();
        // A miss too.
        closeDb(); getDb(':memory:'); clearCombatState();
    });

    it('is refused with nothing spent on a ranged attack, a grid-inferred shot, a cleave or a unit', async () => {
        await setup([
            { id: 'mob', name: 'Mob', hp: 20, maxHp: 20, ac: 10, initiative: 1, isEnemy: true, position: { x: 2, y: 2 }, unit: { models: 5, hpPerModel: 4, packed: true, attackBonus: 2 } },
            { id: 'far', name: 'Far', hp: 5, maxHp: 5, ac: 10, initiative: 2, isEnemy: true, position: { x: 4, y: 0 } }
        ]);
        const ranged = await attack({ damage: 10, nonlethal: true, ranged: true });
        expect(ranged.error).toBe(true);
        expect(ranged.writes).toBe('none');
        expect(String(ranged.message)).toMatch(/melee only/i);
        expect(tok('brannoc').actionUsed).toBeFalsy();

        const cleave = await attack({ damage: 10, nonlethal: true, cleave: true });
        expect(cleave.error).toBe(true);
        expect(cleave.writes).toBe('none');
        expect(String(cleave.message)).toMatch(/melee only|cleave/i);

        const unit = await act({ action: 'attack', encounterId, actorId: 'brannoc', targetId: 'mob', damage: 10, nonlethal: true });
        expect(unit.error).toBe(true);
        expect(unit.writes).toBe('none');
        expect(String(unit.message)).toMatch(/unit/i);

        // 20 ft away with no ranged flag: the grid says it is a shot, and it is refused before Help or the action is spent.
        const far = await act({ action: 'attack', encounterId, actorId: 'brannoc', targetId: 'far', damage: 10, nonlethal: true });
        expect(far.error).toBe(true);
        expect(far.writes).toBe('none');
        expect(String(far.message)).toMatch(/melee only/i);
        expect(tok('brannoc').actionUsed).toBeFalsy();
        expect(tok('far').hp).toBe(5);
    });

    it('the heal action wakes a knocked-out target: the nonlethal Unconscious leaves the token and the sheet', async () => {
        dice(15);
        await attack({ damage: 10, nonlethal: true });
        expect(tok('bandit').conditions).toHaveLength(1);
        // Round 2: the bandit (down) is skipped, the thug passes, Brannoc heals.
        await manage({ action: 'advance', encounterId });
        await manage({ action: 'advance', encounterId });
        expect((await manage({ action: 'get', encounterId })).currentTurn?.id).toBe('brannoc');
        const heal = await act({ action: 'heal', encounterId, actorId: 'brannoc', targetId: 'bandit', amount: 3 });
        expect(heal.error).toBeFalsy();
        expect(heal.actionResult.woke).toMatchObject({ conditionsRemoved: ['unconscious'] });
        const t = tok('bandit');
        expect(t.hp).toBe(3);
        expect(t.conditions).toEqual([]);
        expect(t.isStabilized).toBeFalsy();
        expect(sheet('bandit').conditions ?? []).toEqual([]);
        expect(sheet('bandit').hp).toBe(3);
    });

    it('a posted adjust_hp above 0 wakes a knocked-out token too, and leaves other conditions alone', async () => {
        dice(15);
        const res = await act({ action: 'attack', encounterId, actorId: 'brannoc', targetId: 'thug', damage: 10, nonlethal: true });
        expect(res.actionResult.knockedOut).toMatchObject({ by: 'brannoc' });
        await manage({ action: 'add_condition', encounterId, participantId: 'thug', condition: { name: 'Prone' } });
        expect(tok('thug').conditions.map((c: any) => c.type).sort()).toEqual(['prone', 'unconscious']);
        const fixed = await manage({ action: 'adjust_hp', encounterId, participantId: 'thug', value: 2, reason: 'came round' });
        expect(fixed.error).toBeFalsy();
        expect(fixed.woke).toMatchObject({ conditionsRemoved: ['unconscious'] });
        expect(tok('thug').hp).toBe(2);
        expect(tok('thug').conditions.map((c: any) => c.type)).toEqual(['prone']);
        expect(tok('thug').isStabilized).toBeFalsy();
    });

    it('engine.heal from 0 clears a nonlethal Unconscious but never one from another source', () => {
        const e = new CombatEngine('ko-heal');
        e.startEncounter([
            { id: 'a', name: 'A', initiativeBonus: 5, hp: 10, maxHp: 10, conditions: [] },
            { id: 'b', name: 'B', initiativeBonus: 0, hp: 0, maxHp: 10, conditions: [] }
        ] as any);
        const b = e.getState()!.participants.find(p => p.id === 'b')!;
        b.isStabilized = true;
        e.applyCondition('b', { type: ConditionType.UNCONSCIOUS, durationType: DurationType.PERMANENT, sourceId: nonlethalSource('a') });
        e.applyCondition('b', { type: ConditionType.UNCONSCIOUS, durationType: DurationType.PERMANENT, sourceId: 'sleep spell' });
        expect(isKnockedOut(b)).toBe(true);
        e.heal('b', 4);
        expect(b.hp).toBe(4);
        expect(b.conditions.map(c => c.sourceId)).toEqual(['sleep spell']);
        expect(b.isStabilized).toBe(false);
        expect(isKnockedOut(b)).toBe(false);
    });
});
