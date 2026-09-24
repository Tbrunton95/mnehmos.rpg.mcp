import { handleCreateEncounter, handleExecuteCombatAction, handleGetEncounterState, handleAdvanceTurn, clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const ctx = { sessionId: 'resolved-hit' };

function stateOf(text: string): any {
    const m = text.match(/<!-- STATE_JSON\n([\s\S]*?)\nSTATE_JSON -->/);
    if (!m) throw new Error('no STATE_JSON');
    return JSON.parse(m[1]);
}

async function encounter(seed: string, targetExtras: Record<string, unknown> = {}) {
    const created = await handleCreateEncounter({
        seed,
        participants: [
            { id: 'luciel', name: 'Luciel', hp: 300, maxHp: 300, initiative: 20 },
            { id: 'orsolan', name: 'Orsolan', hp: 500, maxHp: 500, initiative: 5, isEnemy: true, ...targetExtras }
        ]
    }, ctx as any);
    return created.content[0].text.match(/Encounter ID: (encounter-[^\n]+)/)![1];
}

async function targetHp(encounterId: string) {
    const s = stateOf((await handleGetEncounterState({ encounterId }, ctx as any)).content[0].text);
    return s.participants.find((p: any) => p.id === 'orsolan').hp;
}

/**
 * Field report: posting a pre-rolled result as a fixed damage number (with
 * attackBonus +50 to force the hit) still rolled the engine's own d20, and a
 * natural 20 doubled the posted number: 16 became 32 on the Justicar, 111
 * became 222 on Orsolan. A natural 1 would have missed despite +50.
 */
describe('externally resolved attacks (outcome)', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => closeDb());

    it('applies a posted crit of 111 as exactly 111, whatever the dice would say', async () => {
        for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
            clearCombatState();
            const id = await encounter(seed);
            await handleExecuteCombatAction({ encounterId: id, action: 'attack', actorId: 'luciel', targetId: 'orsolan', outcome: 'crit', damage: 111 }, ctx as any);
            expect(await targetHp(id)).toBe(500 - 111);
        }
    });

    it('applies a posted hit as posted and a posted miss as nothing', async () => {
        const id = await encounter('hit-miss');
        await handleExecuteCombatAction({ encounterId: id, action: 'attack', actorId: 'luciel', targetId: 'orsolan', outcome: 'hit', damage: 16 }, ctx as any);
        expect(await targetHp(id)).toBe(484);
        // Posted attacks still spend the action: come round to Luciel again.
        await handleAdvanceTurn({ encounterId: id }, ctx as any);
        await handleAdvanceTurn({ encounterId: id }, ctx as any);
        await handleExecuteCombatAction({ encounterId: id, action: 'attack', actorId: 'luciel', targetId: 'orsolan', outcome: 'miss', damage: 40 }, ctx as any);
        expect(await targetHp(id)).toBe(484);
    });

    it('still applies resistances to a posted hit', async () => {
        const id = await encounter('resist', { resistances: ['fire'] });
        await handleExecuteCombatAction({ encounterId: id, action: 'attack', actorId: 'luciel', targetId: 'orsolan', outcome: 'hit', damage: 40, damageType: 'fire' }, ctx as any);
        expect(await targetHp(id)).toBe(480);
    });

    it('refuses a posted hit with no damage', async () => {
        const id = await encounter('no-dmg');
        const res = await handleExecuteCombatAction({ encounterId: id, action: 'attack', actorId: 'luciel', targetId: 'orsolan', outcome: 'hit' }, ctx as any)
            .then(r => r.content[0].text, (e: Error) => e.message);
        expect(res).toMatch(/damage/i);
        expect(await targetHp(id)).toBe(500);
    });

    it('says the result was posted, with no engine d20 on the banner', async () => {
        const id = await encounter('banner');
        const text = (await handleExecuteCombatAction({ encounterId: id, action: 'attack', actorId: 'luciel', targetId: 'orsolan', outcome: 'crit', damage: 111 }, ctx as any)).content[0].text;
        expect(text).toMatch(/GM RESULT/);
        expect(text).not.toMatch(/d20\[/);
    });
});

describe('crit damage doubles dice, never the modifier or a flat number', () => {
    function engine() {
        const e = new CombatEngine('crit-math');
        e.startEncounter([
            { id: 'a', name: 'A', initiativeBonus: 0, hp: 100, maxHp: 100, conditions: [] },
            { id: 'b', name: 'B', initiativeBonus: 0, hp: 100, maxHp: 100, conditions: [] }
        ] as any);
        return e;
    }

    it('1d1+5 on a crit is 1+1+5 = 7, not (1+5)*2 = 12', () => {
        const r = engine().executeAttack('a', 'b', 0, 10, '1d1+5', undefined, false, false, undefined, undefined, 'crit');
        expect(r.damage).toBe(7);
    });

    it('a flat number is never doubled', () => {
        const r = engine().executeAttack('a', 'b', 0, 10, 16, undefined, false, false, undefined, undefined, 'crit');
        expect(r.damage).toBe(16);
    });
});
