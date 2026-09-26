import { handleTableRules, TableRulesTool } from '../../../src/server/consolidated/table-rules.js';
import { handleSessionManage } from '../../../src/server/consolidated/session-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../../src/server/consolidated/character-manage.js';
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../../src/server/operation-guard.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';
import { queryRolls } from '../../../src/storage/roll-log.js';
import { RULE_PRESETS } from '../../../src/data/table-rules/day-366.js';
import { ORRUK_WAAAGH_PRESET } from '../../../src/data/table-rules/orruk-waaagh.js';
import { listRules, parseRuleSpec, type RuleKind } from '../../../src/engine/table-rules.js';

/**
 * The 'orruk-waaagh' preset: Gorkamorka favour, teef, Orruk and Grot
 * species, the Brute, Ardboy, Wurrgog Prophet and Weirdnob Shaman classes,
 * forms from Ardboy up to Great Warboss, the Getting Bigga track, the
 * Waaagh! Overload table and three homebrew spells.
 */
const W = 'da-world';
const ctx = { sessionId: 'unscoped' };
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx as any));
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any));

beforeEach(() => {
    closeDb(); clearCombatState();
    const db = getDb(':memory:');
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Da World', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('the orruk-waaagh preset', () => {
    it('is registered and every entry parses', () => {
        expect(RULE_PRESETS['orruk-waaagh']).toBe(ORRUK_WAAAGH_PRESET);
        for (const e of ORRUK_WAAAGH_PRESET) expect(() => parseRuleSpec(e.kind as RuleKind, e.spec)).not.toThrow();
        const steps = (ORRUK_WAAAGH_PRESET.find(e => e.kind === 'growth_track')!.spec as any).steps;
        expect(steps.map((s: any) => [s.at, s.form])).toEqual([[10, 'Orruk Brute'], [30, 'Orruk Megaboss'], [60, 'Great Warboss']]);
        // Every step names a creature the preset defines.
        const creatures = ORRUK_WAAAGH_PRESET.filter(e => e.kind === 'creature').map(e => e.name);
        for (const s of steps) expect(creatures).toContain(s.form);
        expect(TableRulesTool.description).toMatch(/orruk-waaagh/);
    });

    it('imports every rule, and boot lists the data kinds', async () => {
        const r = await rules({ action: 'import', preset: 'orruk-waaagh' });
        expect(r).toMatchObject({ success: true, created: ORRUK_WAAAGH_PRESET.length });
        const kinds = new Set(listRules(getDb(), W).map(x => x.kind));
        for (const k of ['pool_family', 'lexicon', 'species', 'char_class', 'growth_track', 'creature', 'roll_table', 'spell', 'principle', 'band']) expect(kinds.has(k as any)).toBe(true);
        const boot = json(await handleSessionManage({ action: 'boot', worldId: W }, ctx as any));
        expect(boot.tableRules.bestiary).toBe(4);
        expect(boot.tableRules.data).toMatchObject({ species: 2, char_class: 4, growth_track: 1, spell: 3, roll_table: 1, pool_family: 1 });
        expect(boot.tableRules.principles.some((p: string) => /bigga/i.test(p))).toBe(true);
    });

    it('a Wurrgog Prophet casts Foot of Gork with the boyz around him, logged', async () => {
        await rules({ action: 'import', preset: 'orruk-waaagh' });
        const w = await char({ action: 'create', worldId: W, name: 'Wurrzag', race: 'Orruk', class: 'Wurrgog Prophet', level: 5, provisionEquipment: false, stats: { str: 14, dex: 10, con: 14, int: 10, wis: 16, cha: 12 } });
        const wid = w.id ?? w.character?.id ?? w.characterId;
        expect(wid).toBeTruthy();
        getDb().prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(W, wid);
        const created = json(await handleCombatManage({ action: 'create', worldId: W, participants: [
            { id: wid, name: 'Wurrzag', hp: 40, maxHp: 40, initiative: 30, position: { x: 0, y: 0 } },
            { id: 'elf', name: 'Elf', hp: 80, maxHp: 80, ac: 10, isEnemy: true, initiative: 1, position: { x: 6, y: 0 } }
        ] }, ctx as any));
        const enc = created.encounterId;
        const add = json(await handleCombatManage({ action: 'add_participant', encounterId: enc, creature: 'Orruk Ardboy', count: 6, isEnemy: false, position: { x: 1, y: 1 } }, ctx as any));
        expect(add.success).toBe(true);
        const cast = withOperation('combat_action', (a: any) => handleCombatAction(a, ctx as any));
        const text = (await cast({ action: 'cast_spell', encounterId: enc, actorId: wid, spellName: 'Foot of Gork', targetId: 'elf' })).content[0].text;
        const ar = JSON.parse(text.match(/<!-- COMBAT_ACTION_JSON\n([\s\S]*?)\nCOMBAT_ACTION_JSON -->/)![1]).actionResult;
        // Six Ardboyz (species Orruk from the bestiary) spaced 10 ft apart from
        // x=1: the four within 40 ft count, per 3 → +1 on the 2d6.
        expect(ar.worldSpell.nearbyBonus).toMatchObject({ count: 4, bonus: 1, overload: false });
        const c = ar.worldSpell.casting;
        expect(c.total).toBe(c.rolls[0] + c.rolls[1] + 1);
        expect(c.success).toBe(c.total >= 7);
        expect(queryRolls(getDb(), { encounterId: enc, limit: 50 }).some((x: any) => x.purpose === 'cast Foot of Gork')).toBe(true);
    });
});
