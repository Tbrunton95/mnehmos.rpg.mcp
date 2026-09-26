import { CombatEngine, CombatParticipant } from '../../src/engine/combat/engine';
import {
    CONDITION_EFFECTS, Condition, ConditionType, DurationType,
    conditionAttackModifiers, normalizeCondition
} from '../../src/engine/combat/conditions';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Item 9 / F6: the 5e standard conditions feed advantage, disadvantage and
 * auto-crit into the attack themselves; homebrew tags never fire silently.
 */
const cond = (type: string, extra: Partial<Condition> = {}): Condition =>
    ({ id: `${type}-1`, type: type as ConditionType, durationType: DurationType.PERMANENT, ...extra });

const who = (id: string, conditions: Condition[] = [], hp = 20) => ({ id, name: id, hp, conditions });

describe('conditionAttackModifiers', () => {
    it('a prone attacker attacks at disadvantage', () => {
        const m = conditionAttackModifiers(who('Bloodthirster', [cond('prone')]), who('Luciel'), { within5ft: true });
        expect(m.dis).toEqual(['Bloodthirster prone (disadvantage)']);
        expect(m.adv).toEqual([]);
    });

    it('a prone target gives advantage within 5 ft and disadvantage beyond', () => {
        const near = conditionAttackModifiers(who('A'), who('T', [cond('prone')]), { within5ft: true });
        expect(near.adv).toHaveLength(1);
        expect(near.dis).toHaveLength(0);
        const far = conditionAttackModifiers(who('A'), who('T', [cond('prone')]), { within5ft: false });
        expect(far.dis).toHaveLength(1);
        expect(far.adv).toHaveLength(0);
    });

    it('paralysed and unconscious targets are auto-crits within 5 ft only', () => {
        const near = conditionAttackModifiers(who('A'), who('T', [cond('paralyzed')]), { within5ft: true });
        expect(near.autoCrit).toMatch(/paralyzed/);
        expect(near.adv).toHaveLength(1);
        const far = conditionAttackModifiers(who('A'), who('T', [cond('unconscious')]), { within5ft: false });
        expect(far.autoCrit).toBeUndefined();
        expect(far.adv).toHaveLength(1);
    });

    it('invisible cuts both ways', () => {
        expect(conditionAttackModifiers(who('A', [cond('invisible')]), who('T'), { within5ft: true }).adv).toHaveLength(1);
        expect(conditionAttackModifiers(who('A'), who('T', [cond('invisible')]), { within5ft: true }).dis).toHaveLength(1);
        expect(conditionAttackModifiers(who('A', [cond('hidden')]), who('T'), { within5ft: true }).adv).toHaveLength(1);
    });

    it('exhaustion only hampers attacks from level 3', () => {
        const at = (level?: number) => conditionAttackModifiers(
            who('A', [cond('exhausted', level ? { metadata: { level } } : {})]), who('T'), { within5ft: true }).dis.length;
        expect(at()).toBe(0);
        expect(at(1)).toBe(0);
        expect(at(2)).toBe(0);
        expect(at(3)).toBe(1);
    });

    it('homebrew registry entries (CURSED, MARKED) never fire', () => {
        const m = conditionAttackModifiers(who('A', [cond('cursed')]), who('T', [cond('marked')]), { within5ft: true });
        expect(m.adv).toEqual([]);
        expect(m.dis).toEqual([]);
    });

    it('frightened needs its source present and alive', () => {
        const scary = who('dragon');
        const dead = who('dragon', [], 0);
        const f = [cond('frightened', { sourceId: 'dragon' })];
        expect(conditionAttackModifiers(who('A', f), who('T'), { within5ft: true, participants: [scary] }).dis).toHaveLength(1);
        expect(conditionAttackModifiers(who('A', f), who('T'), { within5ft: true, participants: [dead] }).dis).toHaveLength(0);
        expect(conditionAttackModifiers(who('A', [cond('frightened')]), who('T'), { within5ft: true, participants: [] }).dis).toHaveLength(1);
    });
});

describe('condition registry fixes', () => {
    it('prone no longer sets speed 0; stunned does', () => {
        expect(CONDITION_EFFECTS[ConditionType.PRONE].speed).toBeUndefined();
        expect(CONDITION_EFFECTS[ConditionType.STUNNED].speed).toBe(0);
    });

    it("aliases 'paralysed' and 'exhaustion', and carries an exhaustion level", () => {
        expect(normalizeCondition('Paralysed', 'x')!.type).toBe('paralyzed');
        const ex = normalizeCondition({ name: 'Exhaustion', level: 3 }, 'x')!;
        expect(ex.type).toBe('exhausted');
        expect(ex.metadata?.level).toBe(3);
    });
});

describe('executeAttack applies standard conditions', () => {
    let engine: CombatEngine;
    const base = (id: string, x: number, conditions: Condition[] = []): CombatParticipant => ({
        id, name: id, initiativeBonus: 0, hp: 500, maxHp: 500, conditions, position: { x, y: 0 }, movementSpeed: 30
    });

    beforeEach(() => {
        engine = new CombatEngine('cond-mods');
        engine.startEncounter([base('ogre', 0), base('knight', 1, [cond('prone')]), base('statue', 5, [cond('paralyzed')])]);
    });

    it('rolls 2d20 against an adjacent prone target and says why', () => {
        const r = engine.executeAttack('ogre', 'knight', 5, 10, 1);
        expect(r.attackRoll!.allRolls).toHaveLength(2);
        expect(r.situational?.join(' ')).toMatch(/knight prone \(advantage\)/);
    });

    it('ranged:true makes the prone target a disadvantage', () => {
        const r = engine.executeAttack('ogre', 'knight', 5, 10, 1, undefined, false, false, undefined, undefined, undefined, undefined, { ranged: true });
        expect(r.situational?.join(' ')).toMatch(/knight prone \(disadvantage\)/);
    });

    it('ignoreConditions rolls raw', () => {
        const r = engine.executeAttack('ogre', 'knight', 5, 10, 1, undefined, false, false, undefined, undefined, undefined, undefined, { ignoreConditions: true });
        expect(r.attackRoll!.allRolls).toHaveLength(1);
        expect(r.situational).toBeUndefined();
    });

    it('a rolled hit on a paralysed target within 5 ft is a crit; beyond, it is not', () => {
        const state = engine.getState()!;
        state.participants.find(p => p.id === 'statue')!.position = { x: 1, y: 1 };
        for (let i = 0; i < 5; i++) {
            const r = engine.executeAttack('ogre', 'statue', 30, 5, '1d4');
            if (r.attackRoll!.isHit) expect(r.attackRoll!.isCrit).toBe(true);
        }
        state.participants.find(p => p.id === 'statue')!.position = { x: 6, y: 0 };
        let sawPlainHit = false;
        for (let i = 0; i < 10; i++) {
            const r = engine.executeAttack('ogre', 'statue', 30, 5, '1d4');
            if (r.attackRoll!.isHit && !r.attackRoll!.isNat20) { expect(r.attackRoll!.isCrit).toBe(false); sawPlainHit = true; }
        }
        expect(sawPlainHit).toBe(true);
    });

    it('a GM-posted hit is never upgraded, only noted', () => {
        const state = engine.getState()!;
        state.participants.find(p => p.id === 'statue')!.position = { x: 1, y: 1 };
        const r = engine.executeAttack('ogre', 'statue', 5, 10, 7, undefined, false, false, undefined, undefined, 'hit');
        expect(r.attackRoll!.isCrit).toBe(false);
        expect(r.damage).toBe(7);
        expect(r.situational?.join(' ')).toMatch(/crit/i);
    });
});

describe('effectiveSpeed honours conditions', () => {
    const speed = (conditions: Condition[]) => {
        const e = new CombatEngine('speed');
        e.startEncounter([{ id: 'a', name: 'a', initiativeBonus: 0, hp: 10, maxHp: 10, conditions, movementSpeed: 30 }]);
        return e.effectiveSpeed(e.getState()!.participants[0]);
    };
    it('grappled, restrained and stunned root; prone does not', () => {
        expect(speed([cond('grappled')])).toBe(0);
        expect(speed([cond('restrained')])).toBe(0);
        expect(speed([cond('stunned')])).toBe(0);
        expect(speed([cond('prone')])).toBe(30);
        expect(speed([cond('cursed')])).toBe(30);
    });
    it('exhaustion 2 halves speed and 5 stops it', () => {
        expect(speed([cond('exhausted', { metadata: { level: 1 } })])).toBe(30);
        expect(speed([cond('exhausted', { metadata: { level: 2 } })])).toBe(15);
        expect(speed([cond('exhausted', { metadata: { level: 5 } })])).toBe(0);
    });
});

describe('combat_action honours conditions end to end', () => {
    const ctx = { sessionId: 'cond-mods' } as any;
    const manage = async (args: Record<string, unknown>) => {
        const text = (await handleCombatManage(args, ctx)).content[0].text;
        const m = text.match(/<!-- COMBAT_MANAGE_JSON\n([\s\S]*?)\nCOMBAT_MANAGE_JSON -->/);
        return m ? JSON.parse(m[1]) : { rawText: text };
    };
    let encounterId: string;

    beforeEach(async () => {
        closeDb();
        getDb(':memory:');
        clearCombatState();
        const created = await manage({ action: 'create', seed: 'cond-e2e', participants: [
            { id: 'orc', name: 'Orc', hp: 30, maxHp: 30, initiative: 20, isEnemy: true, position: { x: 0, y: 0 } },
            { id: 'elf', name: 'Elf', hp: 30, maxHp: 30, initiative: 5, position: { x: 1, y: 0 } }
        ] });
        encounterId = created.encounterId;
    });
    afterEach(() => closeDb());

    it('ranged and ignoreConditions pass through combat_action attack', async () => {
        await manage({ action: 'add_condition', encounterId, participantId: 'elf', condition: 'prone' });
        const ranged = await handleCombatAction({ action: 'attack', encounterId, actorId: 'orc', targetId: 'elf', attackBonus: 3, dc: 12, damage: 1, ranged: true }, ctx);
        expect(ranged.content[0].text).toMatch(/Elf prone \(disadvantage\)/);
    });

    it('a grappled token cannot move even with movement left over', async () => {
        await manage({ action: 'add_condition', encounterId, participantId: 'orc', condition: 'grappled' });
        const moved = await handleCombatAction({ action: 'move', encounterId, actorId: 'orc', targetPosition: { x: 0, y: 2 } }, ctx);
        expect(moved.content[0].text).toMatch(/Insufficient movement/);
    });
});
