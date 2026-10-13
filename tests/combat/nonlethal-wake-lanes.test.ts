import { CombatEngine } from '../../src/engine/combat/engine.js';
import { evaluateAttackTrigger } from '../../src/engine/combat/attack-triggers.js';
import { isKnockedOut } from '../../src/engine/combat/nonlethal.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleCharacterManage } from '../../src/server/consolidated/character-manage.js';
import { handleRestManage } from '../../src/server/consolidated/rest-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 5, item 4 (verification): every lane that brings a knocked-out
 * creature back above 0 HP wakes it — on the token AND on the sheet — not
 * only the heal action and adjust_hp. The describe text promises a spell
 * does; a long or short rest and a character_manage hp correction are the
 * out-of-fight lanes the GM reaches for once the bandit is hauled to camp.
 * The sheet→token HP sync that runs before every action carries the wake
 * back onto a live token.
 */
const ctx = { sessionId: 'nonlethal-wake' };
const embedded = (res: any) => {
    if (!res || !Array.isArray(res.content)) return res;
    const text = res.content[0].text as string;
    const m = text.match(/<!-- ([A-Z_]+)_JSON\n([\s\S]*?)\n\1_JSON -->/);
    if (m) return { ...JSON.parse(m[2]), rawText: text };
    try { return { ...JSON.parse(text), rawText: text }; } catch { return { rawText: text }; }
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any));
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any));
const character = async (args: Record<string, unknown>) => embedded(await handleCharacterManage(args, ctx as any));
const rest = async (args: Record<string, unknown>) => embedded(await handleRestManage(args, ctx as any));
const dice = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

const now = () => new Date().toISOString();
const KO = { name: 'Unconscious', source: 'nonlethal: brannoc' };

describe('nonlethal: every wake lane clears the knockout on token and sheet', () => {
    let encounterId: string;
    const tok = (id: string) => new EncounterRepository(getDb()).loadState(encounterId)!.participants.find((t: any) => t.id === id) as any;
    const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;

    const brannoc = { id: 'brannoc', name: 'Brannoc', hp: 44, maxHp: 44, initiative: 20, position: { x: 0, y: 0 } };
    const mara = { id: 'mara', name: 'Mara', hp: 24, maxHp: 24, initiative: 15, position: { x: 1, y: 1 } };
    const bandit = { id: 'bandit', name: 'Bandit', hp: 5, maxHp: 5, ac: 10, initiative: 10, isEnemy: true, position: { x: 1, y: 0 } };

    const rows = () => {
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'brannoc', name: 'Brannoc', characterType: 'pc', characterClass: 'fighter', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 }, hp: 44, maxHp: 44, ac: 18, level: 5, createdAt: now(), updatedAt: now() } as any);
        repo.create({
            id: 'mara', name: 'Mara', characterType: 'pc', characterClass: 'cleric', level: 3,
            stats: { str: 10, dex: 10, con: 12, int: 10, wis: 16, cha: 12 }, hp: 24, maxHp: 24, ac: 15,
            knownSpells: ['Cure Wounds'], preparedSpells: ['Cure Wounds'], cantripsKnown: [],
            spellSlots: getInitialSpellSlots('cleric', 3), maxSpellLevel: getMaxSpellLevel('cleric', 3),
            createdAt: now(), updatedAt: now()
        } as any);
        repo.create({ id: 'bandit', name: 'Bandit', characterType: 'npc', characterClass: 'fighter', stats: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, hp: 5, maxHp: 5, ac: 10, level: 1, createdAt: now(), updatedAt: now() } as any);
    };
    const fight = async () => {
        const created = await manage({ action: 'create', seed: 'nonlethal-wake', participants: [brannoc, mara, bandit] });
        encounterId = created.encounterId;
    };
    const knockOut = async () => {
        dice(15);
        const res = await act({ action: 'attack', encounterId, actorId: 'brannoc', targetId: 'bandit', damage: 10, damageType: 'bludgeoning', nonlethal: true });
        expect(res.actionResult.knockedOut).toMatchObject({ by: 'brannoc', stable: true });
        expect(isKnockedOut(tok('bandit'))).toBe(true);
        expect(sheet('bandit').conditions).toEqual([expect.objectContaining(KO)]);
    };

    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); rows(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('a healing spell (Cure Wounds) wakes the knocked-out target: token and sheet lose the Unconscious, the result says woke', async () => {
        await fight();
        await knockOut();
        await manage({ action: 'advance', encounterId });   // Mara's turn
        expect((await manage({ action: 'get', encounterId })).currentTurn?.id).toBe('mara');

        const cast = await act({ action: 'cast_spell', encounterId, actorId: 'mara', targetId: 'bandit', spellName: 'Cure Wounds' });
        expect(cast.error).toBeFalsy();
        expect(cast.actionResult.healAmount).toBeGreaterThan(0);
        expect(cast.actionResult.woke).toMatchObject({ conditionsRemoved: ['unconscious'], sheetUpdated: true });
        expect(cast.rawText).toMatch(/comes round/);

        const t = tok('bandit');
        expect(t.hp).toBeGreaterThan(0);
        expect(t.conditions).toEqual([]);
        expect(t.isStabilized).toBeFalsy();
        expect(isKnockedOut(t)).toBe(false);
        const s = sheet('bandit');
        expect(s.hp).toBe(t.hp);
        expect(s.conditions ?? []).toEqual([]);
    });

    it('a posted outcome (hit + damage) with nonlethal knocks out exactly like a rolled one', async () => {
        await fight();
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const res = await act({ action: 'attack', encounterId, actorId: 'brannoc', targetId: 'bandit', outcome: 'hit', damage: 10, nonlethal: true });
        expect(res.error).toBeFalsy();
        expect(spy).not.toHaveBeenCalled();
        expect(res.actionResult.knockedOut).toMatchObject({ by: 'brannoc', stable: true });
        expect(res.actionResult.growth).toBeUndefined();
        expect(tok('bandit')).toMatchObject({ hp: 0, isStabilized: true });
        expect(tok('bandit').conditions).toEqual([expect.objectContaining({ type: 'unconscious', sourceId: 'nonlethal: brannoc' })]);
        expect(sheet('bandit').conditions).toEqual([expect.objectContaining(KO)]);
    });

    it('a long rest out of the fight wakes a knocked-out sheet and leaves its other conditions alone', async () => {
        const repo = new CharacterRepository(getDb());
        repo.update('bandit', { hp: 0, conditions: [KO, { name: 'Prone' }] } as never);
        const res = await rest({ action: 'long', characterId: 'bandit' });
        expect(res.error).toBeFalsy();
        expect(res.newHp).toBe(5);
        expect(res.woke).toMatchObject({ conditionsRemoved: ['Unconscious'] });
        expect(String(res.message)).toMatch(/comes round/);
        expect(sheet('bandit').hp).toBe(5);
        expect(sheet('bandit').conditions).toEqual([expect.objectContaining({ name: 'Prone' })]);
    });

    it('a short rest that brings the sheet above 0 wakes it too; one that heals nothing does not touch the condition', async () => {
        const repo = new CharacterRepository(getDb());
        repo.update('bandit', { hp: 0, conditions: [KO] } as never);
        const res = await rest({ action: 'short', characterId: 'bandit', hitDiceToSpend: 1 });
        expect(res.error).toBeFalsy();
        expect(res.newHp).toBeGreaterThan(0);
        expect(res.woke).toMatchObject({ conditionsRemoved: ['Unconscious'] });
        expect(sheet('bandit').conditions ?? []).toEqual([]);

        // No dice spent: still at 0, still knocked out.
        repo.update('bandit', { hp: 0, conditions: [KO] } as never);
        const none = await rest({ action: 'short', characterId: 'bandit', hitDiceToSpend: 0 });
        expect(none.error).toBeFalsy();
        expect(none.woke).toBeUndefined();
        expect(sheet('bandit').conditions).toEqual([expect.objectContaining(KO)]);
    });

    it('character_manage update {hp} above 0 wakes the sheet, and the next combat read carries the wake onto the live token', async () => {
        await fight();
        await knockOut();

        const fixed = await character({ action: 'update', characterId: 'bandit', hp: 3 });
        expect(fixed.error).toBeFalsy();
        expect(fixed.woke).toMatchObject({ conditionsRemoved: ['Unconscious'] });
        expect(sheet('bandit').hp).toBe(3);
        expect(sheet('bandit').conditions ?? []).toEqual([]);

        // The state view reads the sheet before display: awake, not knocked out.
        const view = await manage({ action: 'get', encounterId });
        const seen = view.participants.find((p: any) => p.id === 'bandit');
        expect(seen.hp).toBe(3);
        expect(seen.knockedOut).toBeUndefined();
        expect(seen.conditions).toEqual([]);

        // The next action persists it: the token is awake and no longer "stable at 0".
        await manage({ action: 'advance', encounterId });
        const t = tok('bandit');
        expect(t.hp).toBe(3);
        expect(t.conditions).toEqual([]);
        expect(t.isStabilized).toBeFalsy();
        expect(isKnockedOut(t)).toBe(false);
    });

    it('an explicit conditions list on the same update wins: the GM decides what the sheet carries', async () => {
        const repo = new CharacterRepository(getDb());
        repo.update('bandit', { hp: 0, conditions: [KO] } as never);
        const res = await character({ action: 'update', characterId: 'bandit', hp: 3, conditions: [KO, { name: 'Dazed' }] });
        expect(res.error).toBeFalsy();
        expect(res.woke).toBeUndefined();
        expect(sheet('bandit').conditions.map((c: any) => c.name)).toEqual(['Unconscious', 'Dazed']);
    });
});

describe('attack triggers: a declared movedFt on a placed token is named, not silently dropped', () => {
    const p = (over: Record<string, unknown>) => ({ id: 'v', name: 'Varek', hp: 1, maxHp: 1, conditions: [], position: { x: 0, y: 0 }, ...over }) as any;

    it('the refusal says the grid counted and that the declared figure was not used', () => {
        const r = evaluateAttackTrigger(p({ dashes: 1, movedSinceDash: 10 }), { dashed: true, movedAtLeast: 20 }, { label: 'Goring Rush', movedFt: 25 });
        expect(r.problem).toMatch(/moved 10 ft \(grid; movedFt 25 declared is not used while the token is placed/);
        expect(r.facts).toMatchObject({ movedFt: 10, movedSource: 'grid', declaredMovedFtIgnored: 25 });
        // Without a declaration the line stays as it was.
        const plain = evaluateAttackTrigger(p({ dashes: 1, movedSinceDash: 10 }), { dashed: true, movedAtLeast: 20 }, { label: 'Goring Rush' });
        expect(plain.problem).toBe('Goring Rush needs a Dash this turn and 20 ft moved after it: dashed yes, moved 10 ft');
        expect(plain.facts.declaredMovedFtIgnored).toBeUndefined();
    });
});
