import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { FORM_KEYS, sheetFromCreature, snapshotBase, nextHp } from '../../../src/engine/forms.js';
import { parseRuleSpec } from '../../../src/engine/table-rules.js';

/**
 * Item 2: forms. Any creature rule (or built-in preset) is a form the
 * character can take: set_form swaps the statline, keeps the base in the
 * sheet, and set_form 'base' puts it back. Live tokens follow.
 */
const W = 'realm-of-chaos';
const ctx = { sessionId: 'forms' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));
const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx as any));
const sheet = () => new CharacterRepository(getDb()).findById('vex')! as any;

const PRINCE = {
    displayName: 'Daemon Prince', hp: 180, ac: 19, size: 'huge', reach: 10,
    stats: { str: 24, con: 22 }, attacksPerAction: 3,
    attacks: [{ name: 'hellforged blade', attackBonus: 12, damage: '3d10+7', damageType: 'slashing', default: true }],
    resistances: ['fire'], immunities: ['poison'], regeneration: 10, band: 'Monster/Lord', cr: 15,
    legendaryActions: 3, legendaryResistances: 2
};
const SPAWN = { hp: 60, ac: 12, attackBonus: 6, attackDamage: '2d8+4', attackDamageType: 'bludgeoning', stats: { str: 18, int: 3 } };

describe('forms (pure)', () => {
    it('sheetFromCreature turns a single attack into one default profile', () => {
        const s = sheetFromCreature(parseRuleSpec('creature', SPAWN));
        expect(s).toMatchObject({ hp: 60, maxHp: 60, ac: 12, stats: { str: 18, int: 3 } });
        expect(s.attacks).toEqual([{ name: 'attack', attackBonus: 6, damage: '2d8+4', damageType: 'bludgeoning', default: true }]);
    });

    it('nextHp by mode', () => {
        expect(nextHp('keep_fraction', 15, 30, 180)).toBe(90);
        expect(nextHp('full', 15, 30, 180)).toBe(180);
        expect(nextHp('keep', 15, 30, 180)).toBe(15);
        expect(nextHp('keep', 150, 180, 30)).toBe(30);
        expect(nextHp('keep_fraction', 0, 30, 180)).toBe(0);
        expect(nextHp('keep_fraction', 1, 180, 30)).toBe(1);
    });

    it('every FORM_KEY survives the repository round trip', () => {
        closeDb();
        const now = new Date().toISOString();
        const repo = new CharacterRepository(getDb(':memory:'));
        repo.create({ id: 'rt', name: 'RT', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 5, maxHp: 5, ac: 10, level: 1, createdAt: now, updatedAt: now } as any);
        const s = sheetFromCreature(parseRuleSpec('creature', { ...PRINCE, stats: { str: 24, dex: 10, con: 22, int: 10, wis: 10, cha: 10 }, abilities: [{ name: 'Warp Breath', recharge: 5 }], vulnerabilities: ['cold'], parts: [{ name: 'wing', kind: 'wing' }] }));
        repo.update('rt', s as any);
        const got = repo.findById('rt') as any;
        for (const k of FORM_KEYS) expect({ k, v: got[k] }).toEqual({ k, v: (s as any)[k] });
        const base = snapshotBase(got);
        repo.update('rt', { form: { name: 'x', since: now, base } } as any);
        expect((repo.findById('rt') as any).form).toMatchObject({ name: 'x', base: { hp: 180, ac: 19 } });
        closeDb();
    });
});

describe('character_manage set_form', () => {
    beforeEach(async () => {
        closeDb(); clearCombatState();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Realm', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        new CharacterRepository(db).create({
            id: 'vex', name: 'Vex', characterType: 'pc', stats: { str: 14, dex: 16, con: 12, int: 10, wis: 10, cha: 14 }, hp: 15, maxHp: 30, ac: 15, level: 6,
            attacks: [{ name: 'sword', attackBonus: 6, damage: '1d8+3' }], resistances: [], createdAt: now, updatedAt: now
        } as any);
        try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
        db.prepare('UPDATE characters SET world_id = ?').run(W);
        await rules({ action: 'define', kind: 'creature', name: 'Daemon Prince', spec: PRINCE });
        await rules({ action: 'define', kind: 'creature', name: 'Chaos Spawn', spec: SPAWN });
    });
    afterEach(() => closeDb());

    it('takes a form, keeping the HP fraction, and reverts to base', async () => {
        const r = await char({ action: 'set_form', characterId: 'vex', form: 'daemon prince' });
        expect(r).toMatchObject({ success: true, form: 'Daemon Prince', hp: 90, maxHp: 180 });
        const s = sheet();
        expect(s).toMatchObject({ hp: 90, maxHp: 180, ac: 19, size: 'huge', reach: 10, attacksPerAction: 3, regeneration: 10, band: 'Monster/Lord', cr: 15, resistances: ['fire'] });
        expect(s.stats).toMatchObject({ str: 24, con: 22, dex: 16 });
        expect(s.form).toMatchObject({ name: 'Daemon Prince', base: { maxHp: 30, ac: 15 } });

        const back = await char({ action: 'set_form', characterId: 'vex', form: 'base', hpMode: 'keep_fraction' });
        expect(back).toMatchObject({ success: true, form: 'base', hp: 15, maxHp: 30 });
        const b = sheet();
        expect(b).toMatchObject({ hp: 15, maxHp: 30, ac: 15, resistances: [] });
        expect(b.form).toBeUndefined();
        expect(b.size).toBeUndefined();
        expect(b.regeneration).toBeUndefined();
        expect(b.attacks).toEqual([{ name: 'sword', attackBonus: 6, damage: '1d8+3' }]);
        expect(b.stats).toEqual({ str: 14, dex: 16, con: 12, int: 10, wis: 10, cha: 14 });
    });

    it('form to form keeps the original base; hpMode full', async () => {
        await char({ action: 'set_form', characterId: 'vex', form: 'Chaos Spawn' });
        const r = await char({ action: 'set_form', characterId: 'vex', form: 'Daemon Prince', hpMode: 'full' });
        expect(r.hp).toBe(180);
        expect(sheet().form.base).toMatchObject({ maxHp: 30, ac: 15 });
        await char({ action: 'set_form', characterId: 'vex', form: 'base', hpMode: 'full' });
        expect(sheet()).toMatchObject({ hp: 30, maxHp: 30, ac: 15 });
    });

    it('a built-in preset is a form; an unknown form and base without a form are refused', async () => {
        const r = await char({ action: 'set_form', characterId: 'vex', form: 'goblin' });
        expect(r).toMatchObject({ success: true, form: 'Goblin', maxHp: 7, source: 'preset' });
        expect(sheet()).toMatchObject({ maxHp: 7, stats: { str: 8, dex: 14 } });
        await char({ action: 'set_form', characterId: 'vex', form: 'base' });
        const bad = await char({ action: 'set_form', characterId: 'vex', form: 'Nothing Real' });
        expect(bad).toMatchObject({ error: true, writes: 'none' });
        const none = await char({ action: 'set_form', characterId: 'vex', form: 'base' });
        expect(none).toMatchObject({ error: true, writes: 'none' });
    });

    it('a live token takes the form and comes back', async () => {
        const enc = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'vex', name: 'Vex', hp: 15, maxHp: 30, initiative: 20 },
            { id: 'x', name: 'X', hp: 10, maxHp: 10, initiative: 1 }
        ] }, ctx as any)).encounterId;
        const r = await char({ action: 'set_form', characterId: 'vex', form: 'Daemon Prince' });
        expect(r.liveTokens).toEqual([enc]);
        const tok = () => (JSON.parse((getDb().prepare('SELECT tokens FROM encounters WHERE id = ?').get(enc) as any).tokens) as any[]).find(t => t.id === 'vex');
        expect(tok()).toMatchObject({ hp: 90, maxHp: 180, ac: 19, size: 'huge', attacksPerAction: 3, name: 'Vex' });
        const state = json(await handleCombatManage({ action: 'get', encounterId: enc }, ctx as any));
        expect(JSON.stringify(state)).toMatch(/"ac":19/);
        await char({ action: 'set_form', characterId: 'vex', form: 'base' });
        expect(tok()).toMatchObject({ hp: 15, maxHp: 30, ac: 15 });
        expect(tok().size ?? 'medium').toBe('medium');
    });
});
