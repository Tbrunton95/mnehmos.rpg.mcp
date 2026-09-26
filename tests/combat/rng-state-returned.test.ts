import { CombatEngine } from '../../src/engine/combat/engine.js';

/**
 * The state startEncounter and addParticipants hand back is what their
 * callers persist (combat_manage add_participant saves it directly). It must
 * carry the RNG position after the initiative rolls, or a second server that
 * loads it restarts the stream and logs the same replay keys again.
 */
const p = (id: string) => ({ id, name: id, hp: 10, maxHp: 10, initiativeBonus: 0 } as any);
const replayKeys = (e: CombatEngine) => e.drainRollRecords().map(r => `${r.origin}@${r.startDraw}`);

describe('returned combat state carries the RNG position', () => {
    it('addParticipants: a reload continues after the initiative rolls', () => {
        const a = new CombatEngine('seed-add');
        a.startEncounter([{ ...p('hero'), initiative: 15 }]);
        a.drainRollRecords();
        const state = a.addParticipants([p('boy1'), p('boy2'), p('boy3')]);
        const rolled = replayKeys(a);
        expect(rolled).toHaveLength(3);
        const b = new CombatEngine('seed-add');
        b.loadState(JSON.parse(JSON.stringify(state)));
        b.rollD20({ purpose: 'after reload' });
        const next = replayKeys(b);
        expect(next).toHaveLength(1);
        expect(rolled).not.toContain(next[0]);
    });

    it('startEncounter: a reload continues after the initiative rolls', () => {
        const a = new CombatEngine('seed-start');
        const state = a.startEncounter([p('x'), p('y')]);
        const rolled = replayKeys(a);
        expect(rolled).toHaveLength(2);
        const b = new CombatEngine('seed-start');
        b.loadState(JSON.parse(JSON.stringify(state)));
        b.rollD20({ purpose: 'after reload' });
        expect(rolled).not.toContain(replayKeys(b)[0]);
    });
});
