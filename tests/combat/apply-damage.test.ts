import { handleCombatManage, CombatManageTool } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { ConcentrationRepository } from '../../src/storage/repos/concentration.repo.js';
import { queryRolls } from '../../src/storage/roll-log.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { damageWithModifiers } from '../../src/engine/combat/damage-modifiers.js';
import { rollCharacterSave } from '../../src/engine/combat/saves.js';

/**
 * Play report: there was no damage lane without an actor. adjust_hp takes a
 * fixed number; attacks and use_ability spend an action; outside a fight
 * there was nothing. combat_manage apply_damage {targetIds, dice, source,
 * damageType?, save?} rolls once on logged dice, saves per target, applies
 * resistances, checks concentration and break tests, and never touches the
 * action economy.
 */
// The operation guard flushes engine dice for the unscoped session key.
const ctx = { sessionId: 'unscoped' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const guarded = withOperation('combat_manage', (a) => handleCombatManage(a, ctx as any));
const manage = async (args: Record<string, unknown>) => {
    const text = (await guarded(CombatManageTool.inputSchema.parse(args))).content[0].text;
    return tag(text, 'COMBAT_MANAGE') ?? { rawText: text };
};
const now = () => new Date().toISOString();
let enc: string;
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;

beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('damage helpers', () => {
    it('damageWithModifiers is the one resistance rule', () => {
        const t = { resistances: ['Fire'], immunities: ['poison'], vulnerabilities: ['cold'] };
        expect(damageWithModifiers(11, 'fire', t)).toEqual({ finalDamage: 5, modifier: 'resistant' });
        expect(damageWithModifiers(11, 'POISON', t)).toEqual({ finalDamage: 0, modifier: 'immune' });
        expect(damageWithModifiers(11, 'cold', t)).toEqual({ finalDamage: 22, modifier: 'vulnerable' });
        expect(damageWithModifiers(11, undefined, t)).toEqual({ finalDamage: 11, modifier: 'normal' });
    });

    it('rollCharacterSave adds the sheet modifier and proficiency on a logged d20', () => {
        new CharacterRepository(getDb()).create({ id: 'rogue', name: 'Rogue', stats: { str: 10, dex: 18, con: 10, int: 10, wis: 10, cha: 10 }, hp: 20, maxHp: 20, ac: 14, level: 5, saveProficiencies: ['dexterity'], createdAt: now(), updatedAt: now() } as any);
        const row = new CharacterRepository(getDb()).findById('rogue')!;
        const s = rollCharacterSave(getDb(), row, 'dex', 15, { purpose: 'trap save' });
        expect(s.modifier).toBe(7);
        expect(s.total).toBe(s.natural + 7);
        expect(queryRolls(getDb(), { forId: 'rogue', limit: 5 }).find((r: any) => r.purpose === 'trap save')).toBeTruthy();
    });
});

describe('combat_manage apply_damage in an encounter', () => {
    const setup = async () => {
        const created = await manage({ action: 'create', seed: 'apply-damage', participants: [
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20 },
            { id: 'ardboyz', name: 'Ardboyz', hp: 55, maxHp: 100, initiative: 10, isEnemy: true, ac: 10,
                unit: { models: 20, hpPerModel: 5, packed: true, attackBonus: 4, morale: 7 } }
        ] });
        enc = created.encounterId;
    };

    it('posts 6d10 on a unit whose action is spent: logged, break test fires, no economy touched', async () => {
        await setup();
        // Spend the unit's action as if it had acted.
        const st = new EncounterRepository(getDb()).loadState(enc)!;
        (st.participants.find(p => p.id === 'ardboyz') as any).actionUsed = true;
        new EncounterRepository(getDb()).saveState(enc, st);
        clearCombatState();
        const r = await manage({ action: 'apply_damage', encounterId: enc, targetIds: ['ardboyz'], dice: '6d10', damageType: 'fire', source: 'burning rubble' });
        expect(r.success).toBe(true);
        expect(r.damageRolls).toHaveLength(6);
        // 55 HP (11 of 20 models) less 6..54 lands at or below half and still standing.
        expect(r.targets[0]).toMatchObject({ targetId: 'ardboyz', damageTaken: r.damageRolled, hpAfter: 55 - r.damageRolled });
        expect(r.breakTests?.[0]).toMatchObject({ participantId: 'ardboyz', maxModels: 20 });
        expect(r.message).toMatch(/BREAK TEST DUE/);
        expect(tok('ardboyz').hp).toBe(55 - r.damageRolled);
        expect(tok('ardboyz').actionUsed).toBe(true);
        expect(tok('hero').actionUsed).toBeFalsy();
        const logged = queryRolls(getDb(), { encounterId: enc, limit: 20 }).find((x: any) => x.purpose === 'damage: burning rubble');
        expect(logged).toBeTruthy();
    });

    it('rolls a real 6d10 on the encounter stream and logs every die', async () => {
        await setup();
        const r = await manage({ action: 'apply_damage', encounterId: enc, targetIds: ['ardboyz'], dice: '6d10', source: 'rockfall' });
        expect(r.damageRolls).toHaveLength(6);
        const logged = queryRolls(getDb(), { encounterId: enc, limit: 20 }).find((x: any) => x.purpose === 'damage: rockfall') as any;
        expect(logged.dice).toHaveLength(6);
        expect(logged.result).toBe(r.damageRolled);
    });

    it('a sheet-backed target saves for half, resistances apply, HP writes through, concentration is checked', async () => {
        const repo = new CharacterRepository(getDb());
        repo.create({ id: 'cleric', name: 'Cleric', stats: { str: 10, dex: 10, con: 14, int: 10, wis: 16, cha: 10 }, hp: 40, maxHp: 40, ac: 16, level: 5, resistances: ['fire'], createdAt: now(), updatedAt: now() } as any);
        new ConcentrationRepository(getDb()).create({ characterId: 'cleric', activeSpell: 'Bless', spellLevel: 1, targetIds: [], startedAt: 1, maxDuration: 10, saveDCBase: 10 } as any);
        const created = await manage({ action: 'create', seed: 'apply-damage-2', participants: [
            { id: 'cleric', name: 'Cleric', hp: 40, maxHp: 40, initiative: 20, resistances: ['fire'] },
            { id: 'imp', name: 'Imp', hp: 10, maxHp: 10, initiative: 10, isEnemy: true }
        ] });
        enc = created.encounterId;
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20').mockReturnValue(20);
        const r = await manage({ action: 'apply_damage', encounterId: enc, targetIds: ['cleric'], dice: 20, damageType: 'fire', source: 'lava vent', save: { ability: 'dex', dc: 12 } });
        // Saved: 20 -> 10, resistant: 10 -> 5.
        expect(r.targets[0]).toMatchObject({ saved: true, damageTaken: 5, hpAfter: 35 });
        expect(repo.findById('cleric')!.hp).toBe(35);
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'concentration', forId: 'cleric' }));
        expect(r.targets[0].concentration).toMatchObject({ spell: 'Bless', broken: false });
    });

    it('refuses an unknown target and writes nothing', async () => {
        await setup();
        const r = await manage({ action: 'apply_damage', encounterId: enc, targetIds: ['ardboyz', 'ghost'], dice: '2d6', source: 'x' });
        expect(r.error).toBe(true);
        expect(r.writes).toBe('none');
        expect(tok('ardboyz').hp).toBe(55);
    });

    it('lair_action gains the break test through the shared resolver', async () => {
        const created = await manage({ action: 'create', seed: 'apply-damage-lair', participants: [
            { id: 'dragon', name: 'Dragon', hp: 200, maxHp: 200, initiative: 10, hasLairActions: true },
            { id: 'ardboyz', name: 'Ardboyz', hp: 50, maxHp: 50, initiative: 5, isEnemy: true, unit: { models: 10, hpPerModel: 5, packed: true, attackBonus: 4, morale: 7 } }
        ] });
        enc = created.encounterId;
        const text = (await guarded({ action: 'lair_action', encounterId: enc, actionDescription: 'the roof falls', targetIds: ['ardboyz'], damage: 30 })).content[0].text;
        expect(text).toMatch(/BREAK TEST DUE/);
    });
});

describe('combat_manage apply_damage with no encounter', () => {
    const mk = (id: string, extra: Record<string, unknown> = {}) => new CharacterRepository(getDb()).create({
        id, name: id[0].toUpperCase() + id.slice(1), stats: { str: 10, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, hp: 30, maxHp: 30, ac: 12, level: 3, createdAt: now(), updatedAt: now(), ...extra
    } as any);

    it('a bite: rolled on logged dice, save halves, HP written to the sheet', async () => {
        mk('marcus', { stats: { str: 10, dex: 30, con: 12, int: 10, wis: 10, cha: 10 } });
        const r = await manage({ action: 'apply_damage', targetIds: ['marcus'], dice: '2d6+10', damageType: 'piercing', source: "An'ggrath bite", save: { ability: 'dex', dc: 5 } });
        expect(r.success).toBe(true);
        expect(r.encounterId).toBeUndefined();
        const t = r.targets[0];
        // DEX 30 (+10) against DC 5 always saves.
        expect(t.saved).toBe(true);
        expect(t.damageTaken).toBe(Math.floor(r.damageRolled / 2));
        expect(new CharacterRepository(getDb()).findById('marcus')!.hp).toBe(30 - t.damageTaken);
        const rolls = queryRolls(getDb(), { limit: 20 }) as any[];
        const dmg = rolls.find(x => x.purpose === "damage: An'ggrath bite");
        expect(dmg).toBeTruthy();
        expect(dmg.result).toBe(r.damageRolled);
        expect(rolls.find(x => x.for_id === 'marcus' && /save/.test(String(x.purpose)))).toBeTruthy();
    });

    it('a failed save takes it all; resistance halves; 0 HP breaks concentration', async () => {
        mk('luciel', { resistances: ['necrotic'], hp: 4, stats: { str: 10, dex: 1, con: 12, int: 10, wis: 10, cha: 10 } });
        new ConcentrationRepository(getDb()).create({ characterId: 'luciel', activeSpell: 'Hex', spellLevel: 1, targetIds: [], startedAt: 1, maxDuration: 10, saveDCBase: 10 } as any);
        const r = await manage({ action: 'apply_damage', targetIds: ['luciel'], dice: 20, damageType: 'necrotic', source: 'grave cold', save: { ability: 'dex', dc: 30 } });
        expect(r.targets[0]).toMatchObject({ saved: false, damageTaken: 10, hpAfter: 0, defeated: true });
        expect(new ConcentrationRepository(getDb()).isConcentrating('luciel')).toBe(false);
    });

    it('a character with a live token is routed through that encounter', async () => {
        mk('hero');
        const created = await manage({ action: 'create', seed: 'routed', participants: [
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20 },
            { id: 'imp', name: 'Imp', hp: 10, maxHp: 10, initiative: 10, isEnemy: true }
        ] });
        enc = created.encounterId;
        const r = await manage({ action: 'apply_damage', targetIds: ['hero'], dice: 7, source: 'falling beam' });
        expect(r).toMatchObject({ success: true, encounterId: enc, routedToEncounter: true });
        expect(tok('hero').hp).toBe(23);
        expect(new CharacterRepository(getDb()).findById('hero')!.hp).toBe(23);
    });

    it('refuses a missing character and a bad notation, writing nothing', async () => {
        mk('hero');
        const a = await manage({ action: 'apply_damage', targetIds: ['hero', 'nobody'], dice: 5, source: 'x' });
        expect(a).toMatchObject({ error: true, writes: 'none' });
        const b = await manage({ action: 'apply_damage', targetIds: ['hero'], dice: '2d', source: 'x' });
        expect(b).toMatchObject({ error: true, writes: 'none' });
        expect(new CharacterRepository(getDb()).findById('hero')!.hp).toBe(30);
    });
});
