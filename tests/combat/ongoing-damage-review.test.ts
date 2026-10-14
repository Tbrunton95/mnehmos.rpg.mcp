/**
 * Play report 7 follow-up, lane O review: probes on the roads the build
 * reaches (two processes, legendary resistance on a sheet, area riders on
 * every area road, the create road).
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine, type CombatParticipant } from '../../src/engine/combat/engine.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

process.env.NODE_ENV = 'test';

const d20s = (...v: number[]) => { const spy = vi.spyOn(CombatEngine.prototype, 'rollD20'); for (const x of v) spy.mockReturnValueOnce(x); return spy; };
const ctx = { sessionId: 'unscoped' };
const embed = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guarded = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
let enc: string;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guarded(CombatManageTool.inputSchema.parse({ encounterId: enc, ...args }))).content[0].text;
    return { text, r: embed(text, 'COMBAT_MANAGE') ?? embed(text, 'STATE') ?? (text.trim().startsWith('{') ? JSON.parse(text) : { rawText: text }) };
};
const advance = () => manage({ action: 'advance', confirm: true });
const tok = (id: string) => (new EncounterRepository(getDb()).loadState(enc)!.participants as CombatParticipant[]).find(p => p.id === id)! as any;
const now = () => new Date().toISOString();
const create = async (participants: unknown[], seed = 'o-review', extra: Record<string, unknown> = {}) => {
    const { r } = await manage({ action: 'create', seed, participants, ...extra });
    enc = r.encounterId;
    expect(enc).toBeTruthy();
    return r;
};
const H_DRAKE = { id: 'drake', name: 'Drake', hp: 120, maxHp: 120, initiative: 20, isEnemy: false, position: { x: 0, y: 0 } };
const H_MILITIA = (over: Record<string, unknown> = {}) => ({ id: 'militia', name: 'Militia', hp: 54, maxHp: 54, initiative: 5, isEnemy: true, position: { x: 5, y: 5 }, unit: { models: 6, hpPerModel: 9, packed: true, morale: 6 }, ...over });

describe('lane O review probes', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('an area condition written in one process ticks per model in the next', async () => {
        await create([H_DRAKE, H_MILITIA()]);
        await manage({ action: 'add_condition', participantId: 'militia', modelsInArea: 4, condition: { name: 'choking', ongoing: { damage: 3, when: 'start' } } });
        clearCombatState();
        const { r } = await advance();
        expect(r.turnDamage[0]).toMatchObject({ shape: 'area', hpAfter: 42 });
        expect(tok('militia').unit.wounded).toEqual([6, 6, 6, 6]);
    });

    it('a player character with autoLegendaryResistance is asked on a tick save, never spent for; the sheet keeps its count', async () => {
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'kael', name: 'Kael', characterType: 'pc', level: 5, hp: 30, maxHp: 30, ac: 12, legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: true, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, conditions: [], createdAt: now(), updatedAt: now() } as any);
        await create([H_DRAKE, { id: 'kael', name: 'Kael', hp: 30, maxHp: 30, initiative: 5, isEnemy: false, autoLegendaryResistance: true, conditions: [{ name: 'burning', ongoing: { damage: 6, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 30 } } }] }]);
        const { r } = await advance();
        expect(r.turnDamage[0]).toMatchObject({ participantId: 'kael', damage: 6, legendaryOffer: { askPlayer: true, refund: 6 } });
        expect(r.turnDamage[0].legendaryResisted).toBeUndefined();
        expect(tok('kael').legendaryResistancesRemaining).toBe(3);
    });

    it('an NPC with autoLegendaryResistance spends one on a tick save: the sheet count follows', async () => {
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'boss', name: 'Grimgor', characterType: 'npc', level: 10, hp: 120, maxHp: 120, ac: 17, legendaryResistances: 3, legendaryResistancesRemaining: 3, autoLegendaryResistance: true, stats: { str: 18, dex: 10, con: 18, int: 10, wis: 10, cha: 10 }, conditions: [], createdAt: now(), updatedAt: now() } as any);
        await create([H_DRAKE, { id: 'boss', name: 'Grimgor', hp: 120, maxHp: 120, initiative: 5, isEnemy: true, conditions: [{ name: 'burning', ongoing: { damage: 10, damageType: 'fire', when: 'start', save: { ability: 'dex', dc: 30, onSuccess: 'half' } } }] }]);
        clearCombatState();
        const { r } = await advance();
        expect(r.turnDamage[0]).toMatchObject({ participantId: 'boss', damage: 5, legendaryResisted: true });
        expect(tok('boss').legendaryResistancesRemaining).toBe(2);
        expect((repo.findById('boss') as any).legendaryResistancesRemaining).toBe(2);
    });

    it('a lair action\'s rider on a unit stamps the area; use_ability with area does too', async () => {
        await create([{ ...H_DRAKE, abilities: [{ name: 'Spit' }] }, H_MILITIA()]);
        const rider = { conditions: [{ name: 'acid pool', ongoing: { damage: 2, damageType: 'acid', when: 'start' } }] };
        d20s(2, 2, 2, 2, 2, 2);
        const used = await manage({ action: 'use_ability', participantId: 'drake', ability: 'Spit', targetIds: ['militia'], damage: 1, damageType: 'acid', modelsInArea: 3, savingThrow: { ability: 'dex', dc: 15, onFail: rider } });
        expect(used.r.error, JSON.stringify(used.r)).toBeFalsy();
        expect(tok('militia').conditions.find((c: any) => c.type === 'acid pool')?.ongoingEffects?.[0]?.shape).toEqual({ kind: 'area', models: 3 });
    });
});

describe('lane O review: no die is drawn twice after a tick\'s concentration save', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('the stored RNG position counts the concentration die a tick rolled (advance)', async () => {
        const { ConcentrationRepository } = await import('../../src/storage/repos/concentration.repo.js');
        const { startConcentration } = await import('../../src/engine/magic/concentration.js');
        const { queryRolls } = await import('../../src/storage/roll-log.js');
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'mage', name: 'Mage', characterType: 'pc', level: 5, hp: 200, maxHp: 200, ac: 12, stats: { str: 8, dex: 12, con: 10, int: 16, wis: 10, cha: 10 }, conditions: [], createdAt: now(), updatedAt: now() } as any);
        startConcentration('mage', 'Bless', 1, 1, 10, ['mage'], new ConcentrationRepository(getDb()), repo);
        await create([H_DRAKE, { id: 'mage', name: 'Mage', hp: 200, maxHp: 200, initiative: 5, isEnemy: false, conditions: [{ name: 'burning', ongoing: { damage: '1d6', damageType: 'fire', when: 'start' } }] }], 'o-conc-draw');
        await advance(); // the mage's turn starts: burning ticks, Bless's CON save rolls
        await advance(); // the drake's
        await advance(); // the mage's again: the tick's die
        const rolls = queryRolls(getDb(), { limit: 200 }).filter(r => r.replay && String(r.replay).includes('@'));
        const draws = rolls.map(r => String(r.replay));
        expect(new Set(draws).size, draws.join(', ')).toBe(draws.length);
    });
});

describe('lane O review: no die is drawn twice after a tick\'s concentration save (remove_participant)', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('the stored RNG position counts the concentration die a tick rolled when remove_participant brings the slot up', async () => {
        const { ConcentrationRepository } = await import('../../src/storage/repos/concentration.repo.js');
        const { startConcentration } = await import('../../src/engine/magic/concentration.js');
        const { queryRolls } = await import('../../src/storage/roll-log.js');
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'mage', name: 'Mage', characterType: 'pc', level: 5, hp: 200, maxHp: 200, ac: 12, stats: { str: 8, dex: 12, con: 10, int: 16, wis: 10, cha: 10 }, conditions: [], createdAt: now(), updatedAt: now() } as any);
        startConcentration('mage', 'Bless', 1, 1, 10, ['mage'], new ConcentrationRepository(getDb()), repo);
        await create([{ id: 'scout', name: 'Scout', hp: 10, maxHp: 10, initiative: 25, isEnemy: true }, H_DRAKE, { id: 'mage', name: 'Mage', hp: 200, maxHp: 200, initiative: 5, isEnemy: false, conditions: [{ name: 'burning', ongoing: { damage: '1d6', damageType: 'fire', when: 'start' } }] }], 'o-conc-remove');
        await advance(); // the scout's turn ends; the drake's starts
        const { r } = await manage({ action: 'remove_participant', participantId: 'drake' }); // the mage comes up: burning ticks, Bless's CON save rolls
        expect(r.turnDamage?.[0]?.concentration).toBeDefined();
        await advance(); // the scout's
        await advance(); // the mage's again: the tick's die
        const draws = queryRolls(getDb(), { limit: 200 }).filter(x => x.replay && String(x.replay).includes('@')).map(x => String(x.replay));
        expect(new Set(draws).size, draws.join(', ')).toBe(draws.length);
    });
});

describe('lane O review: a controlled mount ticks on its rider\'s turn', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('pressure that drops the mount at its rider\'s turn start throws the rider, in the advance reply', async () => {
        await create([
            { id: 'scout', name: 'Scout', hp: 10, maxHp: 10, initiative: 25, isEnemy: true, tags: ['aquatic'], position: { x: 9, y: 9 } },
            { id: 'kael', name: 'Kael', hp: 30, maxHp: 30, initiative: 20, isEnemy: false, tags: ['aquatic'], position: { x: 0, y: 0 } },
            { id: 'horse', name: 'Warhorse', hp: 5, maxHp: 19, initiative: 15, size: 'large', movementSpeed: 60, position: { x: 1, y: 0 } }
        ], 'o-mount', { environment: { medium: 'water', depthFt: 300, pressure: { startsAtFt: 100, damagePerRound: 8 } } });
        await manage({ action: 'mount', riderId: 'kael', mountId: 'horse', free: true });
        const { r } = await advance(); // the scout's turn ends; Kael's starts, and the horse's with it
        expect(r.turnDamage).toEqual([expect.objectContaining({ participantId: 'horse', source: 'pressure', hpAfter: 0 })]);
        expect(r.mounts?.length, JSON.stringify(Object.keys(r))).toBeGreaterThan(0);
        expect(tok('kael').mountedOn).toBeUndefined();
    });
});
