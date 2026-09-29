import { CombatEngine } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

// Play report: breaking a hold cleared Clinched/Grappled/Restrained by name
// only, missed other conditions the hold put on, and cleared a spell's
// Restrained as if it were the grapple's. A break now clears exactly that
// holder's conditions (except Prone: escaping doesn't stand you up).
const ctx = { sessionId: 'grapple-break-hold' };
const embedded = (res: any, tag: string) => {
    const m = res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : { rawText: res.content[0].text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');
const dice = (...values: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const v of values) spy.mockReturnValueOnce(v); return spy; };

let encounterId: string;
const tok = (id: string) => (new EncounterRepository(getDb()).loadState(encounterId)!.participants as any[]).find(t => t.id === id);
const sheet = (id: string) => new CharacterRepository(getDb()).findById(id) as any;
const now = new Date().toISOString();
const mkSheet = (id: string, name: string, conditions: Array<Record<string, unknown>> = []) =>
    new CharacterRepository(getDb()).create({ id, name, stats: { str: 14, dex: 14, con: 12, int: 10, wis: 10, cha: 10 }, hp: 30, maxHp: 30, ac: 13, level: 3, conditions, createdAt: now, updatedAt: now } as any);

beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('breaking a hold clears exactly that hold', () => {
    it('a control pin then a break leaves neither Grappled nor Restrained; Prone stays; the hold\'s own extras go', async () => {
        mkSheet('marine', 'Marine');
        mkSheet('cultist', 'Cultist', [{ name: 'Choked', source: 'grapple: Marine' }]);
        const created = await manage({ action: 'create', seed: 'break-hold', participants: [
            { id: 'marine', name: 'Marine', hp: 30, maxHp: 30, initiative: 20 },
            { id: 'cultist', name: 'Cultist', hp: 30, maxHp: 30, initiative: 5, isEnemy: true, conditions: [{ name: 'Choked', source: 'grapple: marine' }] }
        ] });
        encounterId = created.encounterId;
        dice(20, 1);
        const pin = await act({ action: 'grapple', move: 'takedown', control: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(pin.hit).toBe(true);
        expect(tok('cultist').conditions.map((c: any) => String(c.type).toLowerCase()).sort()).toEqual(['choked', 'grappled', 'prone', 'restrained']);
        await manage({ action: 'next_turn', encounterId });
        dice(20, 1);
        const br = await act({ action: 'grapple', move: 'break', encounterId, actorId: 'cultist', targetId: 'marine' });
        expect(br.hit).toBe(true);
        expect(tok('cultist').conditions.map((c: any) => String(c.type).toLowerCase())).toEqual(['prone']);
        expect(sheet('cultist').conditions.map((c: any) => c.name.toLowerCase())).toEqual(['prone']);
        expect(br.conditionsRemoved.map((n: string) => n.toLowerCase()).sort()).toEqual(['choked', 'grappled', 'restrained']);
    });

    it('a spell\'s Restrained survives the break; unsourced legacy holds still clear', async () => {
        const created = await manage({ action: 'create', seed: 'break-hold-2', participants: [
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20, conditions: [
                { name: 'Clinched', source: 'grapple: brute' }, { name: 'restrained', source: 'spell: Web' }, { name: 'grappled' }
            ] },
            { id: 'brute', name: 'Brute', hp: 30, maxHp: 30, initiative: 5, isEnemy: true }
        ] });
        encounterId = created.encounterId;
        dice(20, 1);
        const br = await act({ action: 'grapple', move: 'break', encounterId, actorId: 'hero', targetId: 'brute' });
        expect(br.hit).toBe(true);
        const left = tok('hero').conditions;
        expect(left.map((c: any) => String(c.type).toLowerCase())).toEqual(['restrained']);
        expect(left[0].sourceId).toBe('spell: Web');
    });

    it('another holder\'s conditions stay', async () => {
        const created = await manage({ action: 'create', seed: 'break-hold-3', participants: [
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20, conditions: [
                { name: 'grappled', source: 'grapple: a' }, { name: 'Choked', source: 'grapple: b' }
            ] },
            { id: 'a', name: 'A', hp: 30, maxHp: 30, initiative: 5, isEnemy: true },
            { id: 'b', name: 'B', hp: 30, maxHp: 30, initiative: 4, isEnemy: true }
        ] });
        encounterId = created.encounterId;
        dice(20, 1);
        await act({ action: 'grapple', move: 'break', encounterId, actorId: 'hero', targetId: 'a' });
        expect(tok('hero').conditions.map((c: any) => c.sourceId)).toEqual(['grapple: b']);
    });
});
