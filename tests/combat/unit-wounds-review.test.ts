/**
 * Play report 7 follow-up, lane W review: the wound list on the roads that
 * bring a unit into a fight, and the replies that echo it.
 *
 *  - create and add_participant take unit.wounded through UnitSchema. A list
 *    that cannot stand beside the HP given (a value at hpPerModel, more
 *    wounded than models, or hp ≠ unhurt × hpPerModel + Σ wounded) used to
 *    be stored and then silently read as the pool: the GM's wounds vanished.
 *    It is refused with writes 'none', naming the HP that fits.
 *  - A bestiary statblock is a template ("never a record of the last
 *    fight"): a unit spawned from one starts unhurt, as its parts start
 *    intact.
 *  - The owner: "the reply should show wounded models compactly … without
 *    listing every model in a big unit". set_unit's reply carries the wound
 *    line, not the raw list, as the state view does.
 */
import { liveModels, woundLine } from '../../src/engine/combat/units.js';
import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { shapeReply } from '../../src/server/output-mode.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'unscoped' };
const W = 'blackcrown';
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guarded = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
let enc: string | undefined;
const manage = async (args: Record<string, unknown>) => {
    const text = (await guarded(CombatManageTool.inputSchema.parse({ ...(enc ? { encounterId: enc } : {}), ...args }))).content[0].text;
    return tag(text, 'COMBAT_MANAGE') ?? { rawText: text };
};
const tokens = () => new EncounterRepository(getDb()).loadState(enc!)!.participants as any[];
const encounterCount = () => (getDb().prepare('SELECT COUNT(*) AS n FROM encounters').get() as { n: number }).n;

const HERO = { id: 'hero', name: 'Hero', hp: 40, maxHp: 40, initiative: 60 };
const militia = (hp: number, wounded?: number[]) => ({
    id: 'militia', name: 'Militia', hp, maxHp: 54, initiative: 5, isEnemy: true, ac: 11,
    unit: { models: 6, hpPerModel: 9, packed: true, ...(wounded ? { wounded } : {}) }
});

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    enc = undefined;
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
});
afterEach(() => { closeDb(); });

describe('create takes a wound list only when it fits the HP (lane W review)', () => {
    it('a list out of step with hp is refused, naming the HP that fits; nothing is written', async () => {
        const r = await manage({ action: 'create', worldId: W, participants: [HERO, militia(54, [5, 2])] });
        expect(r).toMatchObject({ error: true, writes: 'none' });
        expect(r.message).toMatch(/participants\[1\] \(Militia\)/);
        expect(r.message).toMatch(/unit\.wounded \[5, 2\] does not fit hp 54/);
        expect(r.message).toMatch(/hp: 43/);
        expect(encounterCount()).toBe(0);
    });

    it('a value at hpPerModel, or more wounded than models, is refused', async () => {
        const high = await manage({ action: 'create', worldId: W, participants: [HERO, militia(54, [9])] });
        expect(high).toMatchObject({ error: true, writes: 'none' });
        expect(high.message).toMatch(/below hpPerModel \(9\)/);
        const many = await manage({ action: 'create', worldId: W, participants: [HERO, militia(7, [1, 1, 1, 1, 1, 1, 1])] });
        expect(many).toMatchObject({ error: true, writes: 'none' });
        expect(many.message).toMatch(/7 wounded models but the unit has 6/);
        expect(encounterCount()).toBe(0);
    });

    it('a list that fits lands, and the unit reads it', async () => {
        const r = await manage({ action: 'create', worldId: W, participants: [HERO, militia(43, [5, 2])] });
        expect(r.error).toBeUndefined();
        enc = r.encounterId;
        const m = tokens().find(p => p.id === 'militia');
        expect(liveModels(m)).toBe(6);
        expect(woundLine(m)).toBe('6 alive: 4 unhurt, 1 at 5/9, 1 at 2/9');
    });
});

describe('add_participant takes a wound list only when it fits the HP (lane W review)', () => {
    it('an ad-hoc unit whose list does not fit is refused; the fight is untouched', async () => {
        enc = (await manage({ action: 'create', worldId: W, participants: [HERO] })).encounterId;
        const before = JSON.stringify(new EncounterRepository(getDb()).loadState(enc!));
        const r = await manage({ action: 'add_participant', name: 'Pikes', hp: 40, maxHp: 40, isEnemy: true, unit: { models: 4, hpPerModel: 10, packed: true, wounded: [3] } });
        expect(r).toMatchObject({ error: true, writes: 'none' });
        expect(r.message).toMatch(/unit\.wounded \[3\] does not fit hp 40/);
        expect(r.message).toMatch(/hp: 33/);
        expect(JSON.stringify(new EncounterRepository(getDb()).loadState(enc!))).toBe(before);
        expect(tokens().some(p => p.name === 'Pikes')).toBe(false);
    });

    it('a unit spawned from a bestiary statblock starts unhurt: the statblock is a template', async () => {
        const def = await handleTableRules({ action: 'define', worldId: W, kind: 'creature', name: 'Battered Levy', spec: { hp: 36, ac: 11, unit: { models: 4, hpPerModel: 9, packed: true, wounded: [3] } } }, ctx as any);
        expect(def.content[0].text).not.toContain('"error":true');
        enc = (await manage({ action: 'create', worldId: W, participants: [HERO] })).encounterId;
        const r = await manage({ action: 'add_participant', creature: 'Battered Levy' });
        expect(r.error).toBeUndefined();
        const levy = tokens().find(p => p.name === 'Battered Levy');
        expect(levy.hp).toBe(36);
        expect(levy.unit.wounded).toBeUndefined();
        expect(woundLine(levy)).toBe('4 alive: 4 unhurt');
    });
});

describe("output_mode 'summary' keeps a wound-bearing unit line whole (lane W review)", () => {
    it('a big unit with many distinct wounds still shows its BREAK TEST DUE in summary', async () => {
        enc = (await manage({ action: 'create', worldId: W, participants: [HERO, {
            id: 'block', name: 'Stormvermin block of Clan Rictus', hp: 480, maxHp: 480, initiative: 5, isEnemy: true,
            unit: { models: 40, hpPerModel: 12, packed: true, morale: 8 }
        }] })).encounterId;
        // Twenty models on 1-3 (they die to 3), eight on 4-11 (they survive on 1-8), twelve unhurt.
        const wounded = [...Array(7).fill(1), ...Array(7).fill(2), ...Array(6).fill(3), 4, 5, 6, 7, 8, 9, 10, 11];
        expect((await manage({ action: 'set_unit', participantId: 'block', wounded })).success).toBe(true);
        const res = await guarded(CombatManageTool.inputSchema.parse({ encounterId: enc, action: 'apply_damage', targetIds: ['block'], dice: 3, source: 'shrapnel', area: true }));
        const s = JSON.parse(shapeReply(res, { mode: 'summary' }).content![0].text);
        expect(s.unitLines).toHaveLength(1);
        const line = s.unitLines[0] as string;
        // The wound groups before and after push the line past 300 characters; it is kept whole.
        expect(line.length).toBeGreaterThan(300);
        expect(line).not.toMatch(/… \(\d+ chars\)/);
        expect(line).toMatch(/20 dead, 20\/40 left \(12 at 9\/12, .*\); BREAK TEST DUE \(morale 8\)$/);
    });
});

describe("set_unit's reply shows the wounds compactly, not every model (lane W review)", () => {
    it('a 40-model unit with many wounded: the reply carries the wound line and no raw list', async () => {
        enc = (await manage({ action: 'create', worldId: W, participants: [HERO, {
            id: 'tide', name: 'Tide', hp: 160, maxHp: 160, initiative: 5, isEnemy: true,
            unit: { models: 40, hpPerModel: 4, packed: true }
        }] })).encounterId;
        // Every model takes 1 or 2: thirty models wounded.
        const wounded = [...Array(15).fill(2), ...Array(15).fill(3)];
        const set = await manage({ action: 'set_unit', participantId: 'tide', wounded });
        expect(set.success).toBe(true);
        expect(set.wounds).toBe('40 alive: 10 unhurt, 15 at 3/4, 15 at 2/4');
        expect(set.unit).not.toHaveProperty('wounded');
        expect(set.unit).toMatchObject({ models: 40, hpPerModel: 4, packed: true });
        // A later flag change on the same unit does not list them either.
        const flag = await manage({ action: 'set_unit', participantId: 'tide', suppressed: true });
        expect(flag.unit).not.toHaveProperty('wounded');
        expect(flag.wounds).toBe('40 alive: 10 unhurt, 15 at 3/4, 15 at 2/4');
        // The row still holds the list.
        expect(tokens().find(p => p.id === 'tide').unit.wounded).toHaveLength(30);
    });
});
