import seedrandom from 'seedrandom';
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleMathManage } from '../../src/server/consolidated/math-manage.js';
import { handleSessionManage } from '../../src/server/consolidated/session-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatRNG } from '../../src/engine/combat/rng.js';
import { DiceEngine } from '../../src/math/dice.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const ctx = { sessionId: 'unscoped' };
const g = (tool: string, h: (a: any, c: any) => Promise<any>) => withOperation(tool, (args) => h(args, ctx));
const manage = g('combat_manage', handleCombatManage);
const action = g('combat_action', handleCombatAction);
const math = g('math_manage', handleMathManage);
const session = g('session_manage', handleSessionManage);
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };

/**
 * Field report, tier 1: every roll stored with an id, its inputs, its seed
 * and who it was for, and replayable a month later.
 */
describe('roll log', () => {
    beforeEach(() => {
        closeDb(); getDb(':memory:'); clearCombatState();
        const now = new Date().toISOString();
        new CharacterRepository(getDb()).create({ id: 'fury', name: 'Fury', stats: { str: 10, dex: 16, con: 10, int: 10, wis: 12, cha: 10 }, hp: 20, maxHp: 20, ac: 14, level: 3, createdAt: now, updatedAt: now } as any);
    });
    afterEach(() => closeDb());

    it('combat dice are logged per purpose with an op id, and replay from origin@draw', async () => {
        const enc = json(await manage({ action: 'create', seed: 'vorago', participants: [
            { id: 'turret', name: 'Turret', hp: 50, maxHp: 50, initiative: 20 },
            { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 5, ac: 10 }
        ] }, {})).encounterId;
        await action({ action: 'attack', encounterId: enc, actorId: 'turret', targetId: 'luciel', attackBonus: 30, damage: '4d10', opId: 'turret-1' }, {});
        const rolls = json(await session({ action: 'rolls', encounterId: enc, limit: 10 }, {})).rolls;
        const attack = rolls.find((r: any) => r.purpose === 'attack');
        const damage = rolls.find((r: any) => r.purpose === 'damage');
        expect(attack).toMatchObject({ for_id: 'turret', target_id: 'luciel', op_id: 'turret-1', tool: 'combat_action' });
        expect(damage.dice.length).toBeGreaterThanOrEqual(4);
        // Replay: reseed the encounter stream and skip to the recorded draw.
        const [origin, draw] = String(damage.replay).split('@');
        const replay = new CombatRNG(origin);
        for (let i = 0; i < Number(draw); i++) replay.d20(0);
        const redo = damage.dice.map((d: any) => replay.roll(`1d${d.sides}`));
        expect(redo).toEqual(damage.dice.map((d: any) => d.value));
    });

    it('math rolls and checks are logged with who they were for and a replayable seed', async () => {
        const r = json(await math({ action: 'roll', expression: '3d6', forId: 'fury', purpose: 'Fury stoop damage' }, {}));
        const s = json(await math({ action: 'roll_saving_throw', characterId: 'fury', ability: 'dex', dc: 15 }, {}));
        const log = json(await session({ action: 'rolls', forId: 'fury' }, {})).rolls;
        expect(log.map((x: any) => x.purpose)).toEqual(expect.arrayContaining(['Fury stoop damage', 'dex save']));
        const dmg = log.find((x: any) => x.purpose === 'Fury stoop damage');
        expect(new DiceEngine(dmg.replay).roll('3d6').result).toBe(r.total);
        const save = log.find((x: any) => x.purpose === 'dex save');
        expect(Math.floor(seedrandom(save.replay)() * 20) + 1).toBe(s.natural);
        expect(save.id).toBe(s.rollId);
    });

    it('a rolled-back call leaves no roll behind', async () => {
        const enc = json(await manage({ action: 'create', participants: [
            { id: 'a', name: 'A', hp: 10, maxHp: 10, initiative: 20 }, { id: 'b', name: 'B', hp: 10, maxHp: 10, initiative: 5 }
        ] }, {})).encounterId;
        await session({ action: 'rolls', encounterId: enc }, {});
        const before = json(await session({ action: 'rolls', encounterId: enc, limit: 200 }, {})).count;
        await action({ action: 'attack', encounterId: enc, actorId: 'a', targetId: 'nobody', attackBonus: 5, damage: 3 }, {});
        expect(json(await session({ action: 'rolls', encounterId: enc, limit: 200 }, {})).count).toBe(before);
    });
});
