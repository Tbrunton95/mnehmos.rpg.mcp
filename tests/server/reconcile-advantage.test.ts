/**
 * Play report 7 #7, the owner's migration: "world_manage reconcile gets a
 * finding, advantage_source_undeclared, listing every condition that the
 * roll log shows was named as an advantage source but now declares nothing,
 * with the conversion call ready to paste. A table converts these before
 * play, not after a roll quietly loses its advantage."
 */
import { handleWorldManage, WorldManageTool } from '../../src/server/consolidated/world-manage.js';
import { handleImprovisationManage, ImprovisationManageTool } from '../../src/server/consolidated/improvisation-manage.js';
import { handleMathManage, MathManageTool } from '../../src/server/consolidated/math-manage.js';
import { reconcileWorld, RECONCILE_KINDS, ACKNOWLEDGEABLE_KINDS } from '../../src/server/reconcile.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { recordRolls } from '../../src/storage/roll-log.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const W = 'blackcrown';
const ctx = { sessionId: 'reconcile-advantage' } as any;
const tag = (res: any, t: string) => JSON.parse(res.content[0].text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`))![1]);
const world = async (a: Record<string, unknown>) => tag(await handleWorldManage(WorldManageTool.inputSchema.parse(a), ctx), 'WORLD_MANAGE');
const improv = async (a: Record<string, unknown>) => tag(await withOperation('improvisation_manage', (x: any) => handleImprovisationManage(ImprovisationManageTool.inputSchema.parse(x), ctx))(a), 'IMPROVISATION_MANAGE');
const math = async (a: Record<string, unknown>) => tag(await withOperation('math_manage', (x: any) => handleMathManage(MathManageTool.inputSchema.parse(x), ctx))(a), 'MATH_MANAGE');
const logged = (forId: string, ...purposes: string[]) => recordRolls(getDb(), purposes.map(purpose => ({ purpose, forId, dice: [{ sides: 20, value: 10 }], result: 10, replay: null })), { tool: 'test' });
const undeclared = (r: { findings: Array<{ kind: string }> }) => r.findings.filter(f => f.kind === 'advantage_source_undeclared');

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Blackcrown', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    new CharacterRepository(db).create({
        id: 'varek', name: 'Varek', characterType: 'pc', stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 }, hp: 20, maxHp: 20, ac: 13, level: 3,
        conditions: [{ name: 'Horn-Lock: locks horns with a rival head-on', source: 'Gor heritage' }, { name: 'Gor Hunter' }, { name: 'Poisoned', source: 'bad water' }, { name: 'Thick Hide' }],
        createdAt: now, updatedAt: now
    } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    db.prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(W, 'varek');
    // The roll log of the sessions before the grammar: prose conditions named as sources.
    logged('varek',
        'grapple (adv: Horn-Lock)',
        'grapple (adv: GM, Horn-Lock; dis: lower band)',
        'stealth check (adv: Gor Hunter)',
        'perception check (dis: Poisoned)',
        'perception check (adv: Keen Smell (scent))',
        'grapple');
});
afterEach(() => closeDb());

describe('reconcile: advantage_source_undeclared (play report 7 #7)', () => {
    it('is a reconcile kind, and is not acknowledged away: it clears when the condition is converted', () => {
        expect(RECONCILE_KINDS).toContain('advantage_source_undeclared');
        expect(ACKNOWLEDGEABLE_KINDS).not.toContain('advantage_source_undeclared');
    });

    it('lists each prose condition the log named as a source, with the conversion call ready to paste', async () => {
        const r = await world({ action: 'reconcile', worldId: W });
        const found = undeclared(r);
        expect(found).toEqual([
            {
                kind: 'advantage_source_undeclared', characterId: 'varek', characterName: 'Varek',
                detail: "condition 'Horn-Lock' was named as an advantage source in 2 logged rolls (grapple) and declares nothing for them now: the next one is refused",
                fix: `improvisation_manage feature_from_condition {characterId: "varek", match: "Horn-Lock", mechanics: [{type: "advantage_on", value: "grapple"}]} — add condition: "<when-tag>" if it holds only sometimes`
            },
            {
                kind: 'advantage_source_undeclared', characterId: 'varek', characterName: 'Varek',
                detail: "condition 'Gor Hunter' was named as an advantage source in 1 logged roll (check:stealth) and declares nothing for it now: the next one is refused",
                fix: `improvisation_manage feature_from_condition {characterId: "varek", match: "Gor Hunter", mechanics: [{type: "advantage_on", value: "check:stealth"}]} — add condition: "<when-tag>" if it holds only sometimes`
            }
        ]);
        // Poisoned declares its 5e disadvantage; Keen Smell is a trait, not a condition; Thick Hide was never named.
        expect(JSON.stringify(found)).not.toMatch(/Poisoned|Keen Smell|Thick Hide/);
        expect(r.message ?? '').not.toMatch(/^Now:/);
    });

    it('a converted condition drops out; one declared for another roll stays listed for the roll it was named on', async () => {
        await improv({ action: 'feature_from_condition', characterId: 'varek', match: 'Horn-Lock', mechanics: [{ type: 'advantage_on', value: 'grapple', condition: 'head-on' }] });
        await improv({ action: 'feature_from_condition', characterId: 'varek', match: 'Gor Hunter', keepCondition: true, mechanics: [{ type: 'advantage_on', value: 'check:perception' }] });
        const r = reconcileWorld(getDb(), W);
        const found = undeclared(r);
        expect(found).toHaveLength(1);
        expect((found[0] as any).detail).toMatch(/^condition 'Gor Hunter' .*\(check:stealth\)/);
        await improv({ action: 'edit_effect', targetId: 'varek', name: 'Gor Hunter', mechanics: [{ type: 'advantage_on', value: 'check:perception' }, { type: 'advantage_on', value: 'check:stealth', condition: 'tracking prey' }] });
        expect(undeclared(reconcileWorld(getDb(), W))).toEqual([]);
    });

    // Review (play report 7, lane E): the finding must name exactly what the next roll would refuse.
    it("a condition beside a skillAdvantage trait of the same name is not listed: the trait declares it, as the roll's own resolver says", async () => {
        const repo = new CharacterRepository(getDb());
        repo.update('varek', { conditions: [{ name: 'Keen Smell: the Gor nose' }], skillAdvantage: [{ name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent' }] } as never);
        logged('varek', 'perception check (adv: Keen Smell)');
        const roll = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', advantageSources: ['Keen Smell'], seed: 'keen' });
        expect(roll.advantageSources).toEqual(['Keen Smell (scent, named)']);
        expect(undeclared(reconcileWorld(getDb(), W))).toEqual([]);
    });

    it('a feature declaring check:str covers a logged Athletics check (STR), as the roll does', async () => {
        await improv({ action: 'feature_from_condition', characterId: 'varek', match: 'Gor Hunter', keepCondition: true, mechanics: [{ type: 'advantage_on', value: 'check:str' }] });
        getDb().prepare('DELETE FROM roll_log').run();
        logged('varek', 'athletics check (adv: Gor Hunter)', 'Athletics check (adv: Gor Hunter)');
        const roll = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'athletics', advantageSources: ['Gor Hunter'], seed: 'str' });
        expect(roll.advantageSources).toEqual(['Gor Hunter']);
        expect(undeclared(reconcileWorld(getDb(), W))).toEqual([]);
    });

    it('a standard condition named outside its 5e rule is listed without a call that would turn it into prose', async () => {
        getDb().prepare('DELETE FROM roll_log').run();
        logged('varek', 'wis save (dis: Poisoned)');
        const found = undeclared(reconcileWorld(getDb(), W)) as Array<{ detail: string; fix: string }>;
        expect(found).toHaveLength(1);
        expect(found[0].detail).toMatch(/^condition 'Poisoned' was named as a disadvantage source in 1 logged roll \(save:wis\)/);
        expect(found[0].detail).toMatch(/standard condition: it declares only its 5e rules \(disadvantage on attacks and ability checks\)/);
        expect(found[0].fix).not.toMatch(/feature_from_condition|edit_effect/);
        expect(found[0].fix).toMatch(/situationalDisadvantage: '<reason>'/);
    });

    it('the conversion call pastes as it is printed, and the next roll that names the condition fires', async () => {
        const found = undeclared(reconcileWorld(getDb(), W)) as Array<{ detail: string; fix: string }>;
        const hunter = found.find(f => /Gor Hunter/.test(f.detail))!;
        const m = /^improvisation_manage (feature_from_condition|edit_effect) (\{.*\})/.exec(hunter.fix)!;
        const args = Function(`return (${m[2]})`)();
        const conv = await improv({ action: m[1], ...args });
        expect(conv.success).toBe(true);
        const roll = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'stealth', advantageSources: ['Gor Hunter'], seed: 'pasted' });
        expect(roll.error).toBeFalsy();
        expect(roll.advantageSources).toEqual(['Gor Hunter']);
        expect(undeclared(reconcileWorld(getDb(), W)).map((f: any) => f.detail).join(' ')).not.toMatch(/Gor Hunter/);
    });
});
