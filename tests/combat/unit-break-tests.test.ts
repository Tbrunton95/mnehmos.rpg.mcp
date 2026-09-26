import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleTableRules, TableRulesTool } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { breakTestDue, describeUnit, DEFAULT_BREAK_AT } from '../../src/engine/combat/units.js';
import { UnitSchema } from '../../src/schema/token-extras.js';
import { getInitialSpellSlots, getMaxSpellLevel } from '../../src/engine/magic/spell-validator.js';

/**
 * Item 12: unit break tests. A unit that drops through its breakAt fraction
 * of models (default half) owes a break test: the engine flags BREAK TEST
 * DUE with the unit's morale; the GM rolls it and routs the unit with
 * set_unit {routed: true}. A routed unit cannot volley.
 */
const W = 'break-world';
const ctx = { sessionId: 'brk' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manage = async (args: Record<string, unknown>) => {
    const text = (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    return { text, r: tag(text, 'COMBAT_MANAGE') };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;

const unit = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: id[0].toUpperCase() + id.slice(1), hp: 50, maxHp: 50, initiative: 10, isEnemy: true, ac: 10,
    unit: { models: 10, hpPerModel: 5, packed: true, attackBonus: 4, morale: 7, ...extra }
});

async function setup(extra: any[] = []) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Break', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    new CharacterRepository(db).create({
        id: 'mage', name: 'Mage', characterClass: 'wizard', stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
        hp: 30, maxHp: 30, ac: 12, level: 5, spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: getMaxSpellLevel('wizard' as any, 5),
        knownSpells: ['Fireball'], preparedSpells: ['Fireball'], createdAt: now, updatedAt: now
    } as any);
    enc = tag((await handleCombatManage({ action: 'create', worldId: W, participants: [
        { id: 'mage', name: 'Mage', hp: 30, maxHp: 30, initiative: 30 },
        unit('scions'),
        ...extra
    ] }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
}

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('breakTestDue', () => {
    const p = (hp: number, u: Record<string, unknown> = {}): any => ({ id: 'u', name: 'U', hp, unit: { models: 10, hpPerModel: 5, packed: true, attackBonus: 0, ...u } });

    it('is due only when the unit crosses its breakAt fraction and still stands', () => {
        expect(DEFAULT_BREAK_AT).toBe(0.5);
        expect(breakTestDue(p(25), 50)).toMatchObject({ modelsBefore: 10, modelsAfter: 5, maxModels: 10, breakAt: 0.5 });
        expect(breakTestDue(p(30), 50)).toBeNull();            // 6/10: above half
        expect(breakTestDue(p(20), 25)).toBeNull();            // already below
        expect(breakTestDue(p(0), 50)).toBeNull();             // wiped out
        expect(breakTestDue(p(25, { routed: true }), 50)).toBeNull();
        expect(breakTestDue(p(35, { breakAt: 0.75 }), 50)).toMatchObject({ breakAt: 0.75, modelsAfter: 7 });
        expect(breakTestDue({ id: 'x', name: 'X', hp: 5 } as any, 50)).toBeNull();
    });

    it('carries the morale and any bonus as one sum, and names the rout call', () => {
        const due = breakTestDue(p(25, { morale: 7 }), 50, { moraleBonus: [{ label: 'banner', value: 1 }] })!;
        expect(due).toMatchObject({ morale: 7, moraleBonus: 1, moraleTotal: 8 });
        expect(due.line).toMatch(/^BREAK TEST DUE: U fell to 5\/10 models/);
        expect(due.line).toMatch(/morale 7 \+1 \(banner\) = 8/);
        expect(due.line).toMatch(/set_unit \{participantId: 'u', routed: true\}/);
        expect(breakTestDue(p(25), 50)!.line).toMatch(/morale unset/);
    });

    it('describeUnit shows ROUTED', () => {
        expect(describeUnit(p(25, { routed: true }))).toMatch(/ROUTED/);
        expect(describeUnit(p(25))).not.toMatch(/ROUTED/);
    });

    it('the schema takes morale, breakAt and routed without defaults', () => {
        const u = UnitSchema.parse({ models: 10, hpPerModel: 5 });
        expect(u).not.toHaveProperty('morale');
        expect(u).not.toHaveProperty('breakAt');
        expect(u).not.toHaveProperty('routed');
        expect(UnitSchema.parse({ models: 10, hpPerModel: 5, morale: 6, breakAt: 0.25, routed: true })).toMatchObject({ morale: 6, breakAt: 0.25, routed: true });
        expect(() => UnitSchema.parse({ models: 10, hpPerModel: 5, breakAt: 1 })).toThrow();
        expect(() => UnitSchema.parse({ models: 10, hpPerModel: 5, breakAt: 0 })).toThrow();
    });
});

describe('break tests in play', () => {
    it('an attack that halves a unit flags BREAK TEST DUE', async () => {
        await setup();
        // 6/10 standing: no test yet. A single hit takes one model at most.
        expect((await manage({ action: 'adjust_hp', participantId: 'scions', delta: -20, reason: 'earlier losses' })).r.breakTest).toBeUndefined();
        const hit = await act({ action: 'attack', actorId: 'mage', targetId: 'scions', outcome: 'hit', damage: 10 });
        expect(hit.text).toMatch(/BREAK TEST DUE: Scions fell to 5\/10 models/);
        expect(hit.r.breakTests[0]).toMatchObject({ participantId: 'scions', morale: 7, modelsAfter: 5 });
        // Further losses below half owe no second test.
        const again = await manage({ action: 'adjust_hp', participantId: 'scions', delta: -5, reason: 'stray shot' });
        expect(again.r.breakTest).toBeUndefined();
    });

    it("a volley at a unit flags it too", async () => {
        await setup([unit('guard', { attackBonus: 20 })]);
        const v = await act({ action: 'volley', actorId: 'guard', targetId: 'scions', outcome: 'hit', damage: 30 });
        expect(v.text).toMatch(/BREAK TEST DUE: Scions/);
    });

    it('adjust_hp that crosses the line flags it', async () => {
        await setup();
        const r = await manage({ action: 'adjust_hp', participantId: 'scions', delta: -26, reason: 'artillery' });
        expect(r.r.breakTest).toMatchObject({ participantId: 'scions', modelsAfter: 5 });
        expect(r.text).toMatch(/BREAK TEST DUE/);
    });

    it('an SRD spell that halves a unit flags it', async () => {
        await setup();
        const orig = CombatEngine.prototype.rollDice;
        vi.spyOn(CombatEngine.prototype, 'rollDice').mockImplementation(function (this: CombatEngine, n: string, t: any) {
            if (/^8d6$/.test(n)) return { notation: n, rolls: [5, 5, 5, 5, 5, 5, 0, 0], diceTotal: 30, modifier: 0, total: 30 };
            return orig.call(this, n, t);
        });
        vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(1);
        const r = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Fireball', targetIds: ['scions'] });
        expect(r.text).toMatch(/BREAK TEST DUE: Scions/);
        expect(r.r.breakTests?.[0]).toMatchObject({ participantId: 'scions' });
    });

    it('a world spell that halves a unit flags it', async () => {
        await setup();
        try { getDb().exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
        getDb().prepare('UPDATE characters SET world_id = ?').run(W);
        await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, action: 'define', kind: 'spell', name: 'Quake', spec: { effects: [{ type: 'damage', dice: '30' }] } }), ctx as any);
        const r = await act({ action: 'cast_spell', actorId: 'mage', spellName: 'Quake', targetId: 'scions' });
        expect(r.text).toMatch(/BREAK TEST DUE: Scions/);
        expect(r.r.breakTests?.[0]).toMatchObject({ participantId: 'scions' });
    });

    it('set_unit routs, sets morale and breakAt; a routed unit cannot volley', async () => {
        await setup([unit('guard')]);
        const s = await manage({ action: 'set_unit', participantId: 'guard', routed: true, morale: 5, breakAt: 0.25 });
        expect(s.r.unit).toMatchObject({ routed: true, morale: 5, breakAt: 0.25 });
        expect(s.text).toMatch(/ROUTED/);
        expect(tok('guard').unit).toMatchObject({ routed: true, morale: 5, breakAt: 0.25 });
        const v = await act({ action: 'volley', actorId: 'guard', targetId: 'scions', outcome: 'hit' });
        expect(v.text).toMatch(/routed/i);
        expect(tok('scions').hp).toBe(50);
        expect(tok('guard').actionUsed).toBeFalsy();
        // Rallied, it fires again.
        await manage({ action: 'set_unit', participantId: 'guard', routed: false });
        const ok = await act({ action: 'volley', actorId: 'guard', targetId: 'scions', outcome: 'hit' });
        expect(tok('scions').hp).toBeLessThan(50);
        expect(ok.text).not.toMatch(/is routed/i);
    });
});
