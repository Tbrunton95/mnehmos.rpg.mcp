import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const ctx = { sessionId: 'multiattack' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manage = async (args: Record<string, unknown>) => (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ action: 'attack', encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;

async function setup(karanak: Record<string, unknown> = {}) {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    enc = tag((await handleCombatManage({ action: 'create', participants: [
        { id: 'karanak', name: 'Karanak', hp: 200, maxHp: 200, initiative: 30, isEnemy: true, ac: 12,
            parts: [{ name: 'left arm', kind: 'arm' }, { name: 'right arm', kind: 'arm' }],
            attacks: [
                { name: 'axe', attackBonus: 12, damage: '2d8+6', damageType: 'slashing', part: 'right arm' },
                { name: 'whip', attackBonus: 10, damage: '1d8+4', part: 'left arm' }
            ], attacksPerAction: 2, ...karanak },
        { id: 'luciel', name: 'Luciel', hp: 300, maxHp: 300, initiative: 20, ac: 5 }
    ] }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
}

afterEach(() => closeDb());

describe('multiattack: attacksPerAction', () => {
    it('two swings in one Attack action, a third refused', async () => {
        await setup();
        const first = await act({ actorId: 'karanak', targetId: 'luciel', using: 'axe' });
        expect(first.r.multiattack).toEqual({ made: 1, of: 2 });
        expect(first.text).toMatch(/attack 1\/2/);
        const second = await act({ actorId: 'karanak', targetId: 'luciel', using: 'whip' });
        expect(second.r.multiattack).toEqual({ made: 2, of: 2 });
        expect(second.text).toMatch(/attack 2\/2/);
        const third = await act({ actorId: 'karanak', targetId: 'luciel', using: 'axe' });
        expect(third.text).toMatch(/Action already used this turn \(attacks 2\/2\)/);
        expect(tok('karanak').attacksMade).toBe(2);
    });

    it('a token without attacksPerAction keeps one attack per action', async () => {
        await setup({ attacksPerAction: undefined });
        const first = await act({ actorId: 'karanak', targetId: 'luciel', using: 'axe' });
        expect(first.r.multiattack).toBeUndefined();
        const second = await act({ actorId: 'karanak', targetId: 'luciel', using: 'whip' });
        expect(second.text).toMatch(/Action already used this turn/);
    });

    it('a Dash after a partial multiattack is refused', async () => {
        await setup();
        await act({ actorId: 'karanak', targetId: 'luciel', using: 'axe' });
        const text = (await handleCombatAction({ action: 'dash', encounterId: enc, actorId: 'karanak' }, ctx as any)).content[0].text;
        expect(text).toMatch(/Action already used this turn/);
    });

    it('an attack after a Dash is refused', async () => {
        await setup();
        await handleCombatAction({ action: 'dash', encounterId: enc, actorId: 'karanak' }, ctx as any);
        expect((await act({ actorId: 'karanak', targetId: 'luciel', using: 'axe' })).text).toMatch(/Action already used this turn/);
    });

    it('the count survives a reload and resets on the next turn', async () => {
        await setup();
        await act({ actorId: 'karanak', targetId: 'luciel', using: 'axe' });
        clearCombatState();
        expect(getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === 'karanak')!.attacksMade).toBe(1);
        expect((await act({ actorId: 'karanak', targetId: 'luciel', using: 'whip' })).r.multiattack).toEqual({ made: 2, of: 2 });
        await manage({ action: 'advance' });
        await manage({ action: 'advance' });
        expect(tok('karanak').attacksMade).toBe(0);
        expect((await act({ actorId: 'karanak', targetId: 'luciel', using: 'axe' })).r.multiattack).toEqual({ made: 1, of: 2 });
    });

    it('axe then whip with the axe arm crippled: the whip has no disadvantage, a third attack is refused', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: 'karanak', part: 'right arm', state: 'crippled' });
        const axe = await act({ actorId: 'karanak', targetId: 'luciel', using: 'axe' });
        expect(axe.r.roll.allRolls).toHaveLength(2);
        const whip = await act({ actorId: 'karanak', targetId: 'luciel', using: 'whip' });
        expect(whip.r.roll.allRolls).toHaveLength(1);
        expect((await act({ actorId: 'karanak', targetId: 'luciel', using: 'whip' })).text).toMatch(/Action already used/);
    });

    it('the state view shows the attacks used', async () => {
        await setup();
        await act({ actorId: 'karanak', targetId: 'luciel', using: 'axe' });
        const text = await manage({ action: 'get' });
        expect(text).toMatch(/attacks 1\/2/);
        const karanak = tag(text, 'COMBAT_MANAGE');
        const json = JSON.stringify(karanak);
        expect(json).toMatch(/"attacksPerAction":2/);
        expect(json).toMatch(/"attacksMade":1/);
    });
});

describe('multiattack: engine', () => {
    it('validateAttackEconomy and commitAttack count swings; resetTurnResources zeroes them', () => {
        const engine = new CombatEngine('ma-engine');
        engine.startEncounter([
            { id: 'a', name: 'A', initiativeBonus: 0, initiative: 20, hp: 10, maxHp: 10, conditions: [], attacksPerAction: 3 } as any,
            { id: 'b', name: 'B', initiativeBonus: 0, initiative: 10, hp: 10, maxHp: 10, conditions: [] } as any
        ]);
        for (let i = 0; i < 3; i++) {
            expect(engine.validateAttackEconomy('a').valid).toBe(true);
            engine.commitAttack('a');
        }
        expect(engine.validateAttackEconomy('a').valid).toBe(false);
        expect(engine.validateActionEconomy('a', 'action').valid).toBe(false);
        engine.nextTurnWithConditions();
        engine.nextTurnWithConditions();
        const a = engine.getState()!.participants.find(p => p.id === 'a')!;
        expect(a.attacksMade).toBe(0);
    });
});

describe('multiattack: presets', () => {
    it('presets whose traits say Multiattack carry attacksPerAction', async () => {
        const { CREATURE_PRESETS } = await import('../../src/data/creature-presets.js');
        expect(CREATURE_PRESETS.troll.attacksPerAction).toBe(3);
        expect(CREATURE_PRESETS.owlbear.attacksPerAction).toBe(2);
        expect(CREATURE_PRESETS.goblin.attacksPerAction).toBeUndefined();
    });

    it('spawn_quick_enemy and a name-matched create both give the token the count', async () => {
        closeDb();
        getDb(':memory:');
        clearCombatState();
        const spawned = tag((await handleCombatManage({ action: 'spawn_quick_enemy', creature: 'troll' }, ctx as any)).content[0].text, 'COMBAT_MANAGE');
        enc = spawned.encounterId;
        expect(new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.isEnemy)!.attacksPerAction).toBe(3);
        enc = tag((await handleCombatManage({ action: 'create', participants: [
            { id: 'o1', name: 'Owlbear', hp: 59, maxHp: 59, initiative: 10, isEnemy: true }
        ] }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
        expect(tok('o1').attacksPerAction).toBe(2);
    });
});
