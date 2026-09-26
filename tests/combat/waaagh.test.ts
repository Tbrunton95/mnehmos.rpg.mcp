import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleTableRules, TableRulesTool } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { getCombatManager } from '../../src/server/state/combat-manager.js';
import { nearbyAllies } from '../../src/engine/combat/nearby.js';
import { moraleModifiers } from '../../src/engine/combat/units.js';
import { UnitSchema } from '../../src/schema/token-extras.js';

/**
 * The Orruk mechanics, setting-neutral: Waaagh! energy (a spell's casting
 * roll grows with the allies around the caster and can overload into its
 * miscast table), the Waaagh! call (combat_manage battle_cry buffs every
 * matching ally in range until the caller's next turn) and mob rule (a
 * unit's morale and to-hit grow with its models).
 */
const W = 'waaagh-world';
const ctx = { sessionId: 'unscoped' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const cm = withOperation('combat_manage', (a: any) => handleCombatManage(a, ctx as any));
const ca = withOperation('combat_action', (a: any) => handleCombatAction(a, ctx as any));
const manage = async (args: Record<string, unknown>) => {
    const text = (await cm({ encounterId: enc, ...args })).content[0].text;
    return { text, r: tag(text, 'COMBAT_MANAGE') };
};
const act = async (args: Record<string, unknown>) => {
    const text = (await ca({ encounterId: enc, ...args })).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, r: d?.actionResult ?? d };
};
const rules = (args: Record<string, unknown>) => handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...args }), ctx as any);
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;
const engine = () => getCombatManager().get(`${ctx.sessionId}:${enc}`)!;

const scores = { strength: 16, dexterity: 10, constitution: 14, intelligence: 8, wisdom: 10, charisma: 10 };
const orruk = (id: string, x: number, extra: Record<string, unknown> = {}) => ({
    id, name: id[0].toUpperCase() + id.slice(1), hp: 20, maxHp: 20, ac: 12, initiative: 5, species: 'Orruk', position: { x, y: 0 }, abilityScores: scores, ...extra
});

/** Fix the casting dice (tags starting 'cast '); every other roll stays live and logged. */
function fixCasting(rolls: number[]) {
    const orig = CombatEngine.prototype.rollDice;
    vi.spyOn(CombatEngine.prototype, 'rollDice').mockImplementation(function (this: CombatEngine, notation: string, t: any) {
        if (t.purpose.startsWith('cast ')) {
            const total = rolls.reduce((a, b) => a + b, 0);
            return { notation, rolls, diceTotal: total, modifier: 0, total };
        }
        return orig.call(this, notation, t);
    });
}

async function setup(participants: any[]) {
    closeDb();
    clearCombatState();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Waaagh', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    new CharacterRepository(db).create({
        id: 'wurrzag', name: 'Wurrzag', race: 'Orruk', characterClass: 'Wurrgog Prophet',
        stats: { str: 14, dex: 10, con: 14, int: 10, wis: 16, cha: 12 }, hp: 40, maxHp: 40, ac: 13, level: 6,
        createdAt: now, updatedAt: now
    } as any);
    db.prepare('UPDATE characters SET world_id = ?').run(W);
    enc = tag((await handleCombatManage(CombatManageTool.inputSchema.parse({ action: 'create', worldId: W, seed: 'waaagh-seed', participants }), ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
}

afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('Waaagh! energy: bonusFromNearby on a world spell', () => {
    const boyz = (n: number, x0 = 1) => Array.from({ length: n }, (_, i) => orruk(`boy${i + 1}`, x0 + i));
    const distractors = [
        orruk('farboy', 20),                                              // 100 ft: out of range
        orruk('grot', 2, { species: 'Grot', position: { x: 2, y: 1 } }),  // in range, wrong species
        orruk('enemyboy', 3, { isEnemy: true, position: { x: 3, y: 1 } }), // in range, not an ally
        orruk('deadboy', 4, { hp: 0, position: { x: 4, y: 1 } })          // down
    ];
    const caster = { id: 'wurrzag', name: 'Wurrzag', hp: 40, maxHp: 40, initiative: 30, position: { x: 0, y: 0 } };
    const target = { id: 'elf', name: 'Elf', hp: 60, maxHp: 60, ac: 10, isEnemy: true, initiative: 1, position: { x: 5, y: 3 }, abilityScores: { ...scores, dexterity: 1 } };

    beforeEach(() => undefined);

    it('counts only live, matching allies in range, units by their models, and caps the bonus', async () => {
        await setup([caster, target, ...boyz(7), ...distractors]);
        const state = engine().getState()!;
        const me = state.participants.find(p => p.id === 'wurrzag')!;
        const speciesOf = (p: any) => p.id === 'wurrzag' ? 'Orruk' : undefined;
        expect(nearbyAllies(state.participants, me, { range: 40, match: { species: 'orruk' } }, speciesOf).count).toBe(7);
        expect(nearbyAllies(state.participants, me, { range: 40, match: {} }, speciesOf).count).toBe(8); // the grot joins
        expect(nearbyAllies(state.participants, me, { range: 40, match: { nameIncludes: 'boy1' } }, speciesOf).count).toBe(1);

        await rules({ action: 'define', kind: 'spell', name: 'Foot of Gork', spec: {
            castingRoll: { target: 7, bonusFromNearby: { range: 40, per: 3, max: 4, match: { species: 'Orruk' }, overloadAt: 4 } },
            effects: [{ type: 'damage', dice: '4d6', damageType: 'bludgeoning' }]
        } });
        fixCasting([2, 3]);
        const r = await act({ action: 'cast_spell', actorId: 'wurrzag', spellName: 'Foot of Gork', targetId: 'elf' });
        expect(r.r.worldSpell.nearbyBonus).toMatchObject({ count: 7, bonus: 2, overload: false });
        expect(r.r.worldSpell.casting).toMatchObject({ rolls: [2, 3], total: 7, success: true });
        expect(r.text).toMatch(/nearby.*\+2/);
    });

    it('a unit counts its live models; at overloadAt the miscast table rolls', async () => {
        const mob = orruk('mob', 2, { hp: 50, maxHp: 50, position: { x: 2, y: 2 }, unit: { models: 10, hpPerModel: 5 } });
        await setup([caster, target, ...boyz(4), mob]);
        await rules({ action: 'define', kind: 'roll_table', name: 'Waaagh! Overload', spec: { dice: '2d6', entries: [
            { min: 2, max: 12, text: 'Da Jolt', apply: { condition: { name: 'Stunned', duration: 1 } } }
        ] } });
        await rules({ action: 'define', kind: 'spell', name: 'Foot of Gork', spec: {
            castingRoll: { target: 7, bonusFromNearby: { range: 40, per: 3, max: 4, match: { species: 'Orruk' }, overloadAt: 4 } },
            effects: [{ type: 'damage', dice: '4d6', damageType: 'bludgeoning' }],
            miscast: { on: 'double', table: 'Waaagh! Overload' }
        } });
        fixCasting([2, 5]);
        const r = await act({ action: 'cast_spell', actorId: 'wurrzag', spellName: 'Foot of Gork', targetId: 'elf' });
        // 4 boyz + 10 models = 14 → floor(14/3) = 4, capped at 4: overload.
        expect(r.r.worldSpell.nearbyBonus).toMatchObject({ count: 14, bonus: 4, overload: true });
        expect(r.r.worldSpell.casting.total).toBe(11);
        expect(r.r.worldSpell.miscast).toMatchObject({ on: 'overload', table: 'Waaagh! Overload' });
        expect(queryRolls(getDb(), { encounterId: enc, limit: 50 }).some((x: any) => x.purpose === 'table Waaagh! Overload')).toBe(true);
        // Da Jolt reaches the caster's token as well as the sheet.
        expect(tok('wurrzag').conditions.some((c: any) => /stunned/i.test(c.type ?? c.name))).toBe(true);
    });
});

describe('the Waaagh! call: combat_manage battle_cry', () => {
    const boss = orruk('grimgor', 0, { initiative: 30, abilities: [{ name: 'Waaagh!', recharge: 5 }], hp: 100, maxHp: 100 });
    const lineup = () => [
        boss,
        orruk('boy', 1, { initiative: 20 }),
        orruk('grot', 2, { initiative: 15, species: 'Grot' }),
        orruk('farboy', 30, { initiative: 14 }),
        { id: 'elf', name: 'Elf', hp: 200, maxHp: 200, ac: 1, isEnemy: true, initiative: 10, position: { x: 1, y: 1 }, abilityScores: scores }
    ];

    it('buffs every matching ally in range, the caller too, and spends the ability', async () => {
        await setup(lineup());
        const moveBefore = tok('grimgor').movementRemaining ?? 30;
        const r = await manage({ action: 'battle_cry', participantId: 'grimgor', ability: 'Waaagh!', match: { species: 'Orruk' }, attackAdvantage: true, damageBonus: '1d4', speedBonus: 10, moraleBonus: 2 });
        expect(r.r).toMatchObject({ success: true, actionType: 'battle_cry' });
        expect(r.r.recipients.map((x: any) => x.id).sort()).toEqual(['boy', 'grimgor']);
        expect(tok('boy').buffs[0]).toMatchObject({ name: 'Waaagh!', sourceId: 'grimgor', untilRound: 1, attackAdvantage: true, damageBonus: '1d4', speedBonus: 10, moraleBonus: 2 });
        expect(tok('grot').buffs ?? []).toEqual([]);
        expect(tok('farboy').buffs ?? []).toEqual([]);
        expect(tok('elf').buffs ?? []).toEqual([]);
        expect(tok('grimgor').abilities[0].ready).toBe(false);
        expect(tok('grimgor').movementRemaining).toBe(moveBefore + 10);
        expect(engine().effectiveSpeed(engine().getState()!.participants.find(p => p.id === 'boy')!)).toBe(40);
        // Spent: a second call is refused and writes nothing.
        const again = await manage({ action: 'battle_cry', participantId: 'grimgor', ability: 'Waaagh!', attackAdvantage: true });
        expect(again.r.error).toBe(true);
        expect(CombatManageTool.inputSchema.shape.damageBonus).toBeDefined();
        expect(CombatManageTool.inputSchema.shape.match).toBeDefined();
    });

    it('a buffed attack rolls with advantage and adds the bonus dice on the logged stream', async () => {
        await setup(lineup());
        await manage({ action: 'battle_cry', participantId: 'grimgor', attackAdvantage: true, damageBonus: 3, match: { species: 'Orruk' } });
        const a = await act({ action: 'attack', actorId: 'grimgor', targetId: 'elf', attackBonus: 30, damage: '1d6' });
        expect(a.r.roll.allRolls).toHaveLength(2);
        expect(a.r.situational.some((s: string) => /Waaagh! \(advantage\)/.test(s))).toBe(true);
        expect(a.r.situational.some((s: string) => /Waaagh! \+3 damage/.test(s))).toBe(true);
        expect(a.r.damage.total).toBeGreaterThanOrEqual(4);

        await setup(lineup());
        await manage({ action: 'battle_cry', participantId: 'grimgor', damageBonus: '1d4', match: { species: 'Orruk' } });
        await act({ action: 'attack', actorId: 'grimgor', targetId: 'elf', attackBonus: 30, damage: '1d6' });
        expect(queryRolls(getDb(), { encounterId: enc, limit: 50 }).some((x: any) => x.purpose === 'Waaagh! damage')).toBe(true);
    });

    it("expires at the start of the caller's next turn, with a note", async () => {
        await setup(lineup());
        await manage({ action: 'battle_cry', participantId: 'grimgor', attackAdvantage: true, match: { species: 'Orruk' } });
        // boy, grot, farboy, elf, then grimgor in round 2.
        for (let i = 0; i < 4; i++) await manage({ action: 'advance' });
        expect(tok('boy').buffs).toHaveLength(1);
        const back = await manage({ action: 'advance' });
        expect(back.text).toMatch(/Waaagh! fades/);
        expect(tok('boy').buffs ?? []).toEqual([]);
        expect(tok('grimgor').buffs ?? []).toEqual([]);
    });

    it('refuses a call with nothing in it, or an ability the caller lacks', async () => {
        await setup(lineup());
        expect((await manage({ action: 'battle_cry', participantId: 'grimgor' })).r.error).toBe(true);
        expect((await manage({ action: 'battle_cry', participantId: 'boy', ability: 'Waaagh!', attackAdvantage: true })).r.error).toBe(true);
        expect(tok('boy').buffs ?? []).toEqual([]);
    });
});

describe('mob rule', () => {
    const unitTok = (id: string, x: number, unit: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        orruk(id, x, { hp: 100, maxHp: 100, unit: { models: 20, hpPerModel: 5, morale: 5, ...unit }, ...extra });

    it('the schema takes mobRule', () => {
        expect(UnitSchema.parse({ models: 10, hpPerModel: 5, mobRule: { per: 5, maxBonus: 3, attackBonusPer: 10, nearby: { range: 30, match: { species: 'Orruk' } } } }).mobRule).toMatchObject({ per: 5, maxBonus: 3 });
        expect(() => UnitSchema.parse({ models: 10, hpPerModel: 5, mobRule: { per: 0 } })).toThrow();
    });

    it('adds live models (and nearby allied units) to the break test, capped', async () => {
        await setup([
            unitTok('mob', 0, { mobRule: { per: 5, maxBonus: 3 } }, { initiative: 20 }),
            { id: 'elf', name: 'Elf', hp: 50, maxHp: 50, ac: 10, isEnemy: true, initiative: 1, position: { x: 9, y: 9 } }
        ]);
        const r = await manage({ action: 'adjust_hp', participantId: 'mob', value: 50, reason: 'arrows' });
        expect(r.r.breakTest.modifiers).toEqual([{ label: 'mob rule (10 models)', value: 2 }]);
        expect(r.r.breakTest).toMatchObject({ moraleBonus: 2, moraleTotal: 7 });
        expect(r.text).toMatch(/\+2 \(mob rule/);

        await setup([
            unitTok('mob', 0, { mobRule: { per: 5, maxBonus: 3, nearby: { range: 30, match: { species: 'Orruk' } } } }, { initiative: 20 }),
            unitTok('mob2', 2, { models: 10, hpPerModel: 5 }, { hp: 50, maxHp: 50 }),
            unitTok('farmob', 40, {}),
            { id: 'elf', name: 'Elf', hp: 50, maxHp: 50, ac: 10, isEnemy: true, initiative: 1, position: { x: 9, y: 9 } }
        ]);
        const n = await manage({ action: 'adjust_hp', participantId: 'mob', value: 50, reason: 'arrows' });
        // 10 own + 10 nearby = 20 → 4, capped at 3.
        expect(n.r.breakTest.modifiers[0]).toMatchObject({ value: 3 });
        expect(n.r.breakTest.modifiers[0].label).toMatch(/20 models/);
    });

    it('a battle cry moraleBonus joins the break test', async () => {
        await setup([
            unitTok('mob', 0, {}, { initiative: 20 }),
            orruk('boss', 1, { initiative: 30 }),
            { id: 'elf', name: 'Elf', hp: 50, maxHp: 50, ac: 10, isEnemy: true, initiative: 1, position: { x: 9, y: 9 } }
        ]);
        await manage({ action: 'battle_cry', participantId: 'boss', moraleBonus: 2, match: { species: 'Orruk' } });
        const r = await manage({ action: 'adjust_hp', participantId: 'mob', value: 50, reason: 'arrows' });
        expect(r.r.breakTest.modifiers).toEqual([{ label: 'Waaagh!', value: 2 }]);
        const state = engine().getState()!;
        expect(moraleModifiers(state.participants.find(p => p.id === 'mob')!, state.participants)).toEqual([{ label: 'Waaagh!', value: 2 }]);
    });

    it('attackBonusPer adds to hit per models standing', async () => {
        await setup([
            unitTok('mob', 0, { mobRule: { per: 5, attackBonusPer: 10 } }, { initiative: 20 }),
            { id: 'elf', name: 'Elf', hp: 500, maxHp: 500, ac: 10, isEnemy: true, initiative: 1, position: { x: 1, y: 0 } }
        ]);
        const a = await act({ action: 'attack', actorId: 'mob', targetId: 'elf', attackBonus: 3, damage: 1 });
        expect(a.r.roll.bonus).toBe(5);
        expect(a.r.roll.total - a.r.roll.die).toBe(5);
        expect(a.r.situational.some((s: string) => /mob rule \+2 to hit \(20 models\)/.test(s))).toBe(true);
    });
});
