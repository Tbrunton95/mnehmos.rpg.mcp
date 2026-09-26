/**
 * Item 12: a world's bestiary. A statblock saved once as a table_rules
 * 'creature' spawns by name in every fight after, with its regeneration,
 * parts, band and attacks intact.
 */
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { handleSessionManage } from '../../src/server/consolidated/session-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { resolveCreature, creatureToParticipant } from '../../src/engine/table-rules.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const W = 'vorago';
const ctx = { sessionId: 'bestiary' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
const manage = async (args: Record<string, unknown>) => tag((await handleCombatManage(args, ctx as any)).content[0].text, 'COMBAT_MANAGE');
const rules = async (args: Record<string, unknown>) => tag((await handleTableRules({ worldId: W, ...args }, ctx as any)).content[0].text, 'TABLE_RULES');
const tokens = (enc: string) => new EncounterRepository(getDb()).loadState(enc)!.participants as any[];

const CHAOS_SPAWN = {
    displayName: 'Chaos Spawn',
    hp: 120, ac: 12,
    stats: { str: 22, dex: 10, con: 22, int: 2, wis: 8, cha: 2 },
    band: 'Monster/Lord',
    regeneration: 10,
    size: 'large',
    cr: 8,
    attacks: [{ name: 'maw', attackBonus: 9, damage: '3d8+6', damageType: 'piercing', default: true }],
    parts: [{ name: 'tentacle', kind: 'arm', state: 'crippled', hp: 20 }],
    abilities: [{ name: 'Warp Spew', recharge: 5, ready: false }],
    resistances: ['necrotic'],
    traits: ['Mutating flesh']
};

beforeEach(async () => {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'Vorago', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    await rules({ action: 'define', kind: 'creature', name: 'Chaos Spawn', spec: CHAOS_SPAWN });
});
afterEach(() => closeDb());

describe('creature rules', () => {
    it('resolveCreature finds the world entry by any case, else the built-in preset', () => {
        const world = resolveCreature(getDb(), W, 'chaos spawn')!;
        expect(world.source).toBe('world');
        expect(world.spec.hp).toBe(120);
        const preset = resolveCreature(getDb(), W, 'goblin')!;
        expect(preset.source).toBe('preset');
        expect(preset.spec.ac).toBeGreaterThan(0);
        expect(resolveCreature(getDb(), W, 'no such beast')).toBeNull();
    });

    it('creatureToParticipant resets parts and abilities per token and fills the attack', () => {
        const spec = resolveCreature(getDb(), W, 'Chaos Spawn')!.spec;
        const p = creatureToParticipant(spec, { id: 'x', name: 'Spawn A', isEnemy: true }) as any;
        expect(p).toMatchObject({ id: 'x', name: 'Spawn A', hp: 120, maxHp: 120, ac: 12, band: 'Monster/Lord', regeneration: 10, size: 'large', cr: 8, isEnemy: true });
        expect(p.attackDamage).toBe('3d8+6');
        expect(p.attackBonus).toBe(9);
        expect(p.parts[0]).toMatchObject({ name: 'tentacle', state: 'intact', hp: 20 });
        expect(p.abilities[0].ready).toBe(true);
        expect(p.abilityScores.strength).toBe(22);
        // The spec itself is untouched: the next token starts fresh too.
        expect(spec.parts![0].state).toBe('crippled');
    });

    it('a world entry beats the built-in namesake', async () => {
        await rules({ action: 'define', kind: 'creature', name: 'Chimera', spec: { hp: 300, ac: 19 } });
        expect(resolveCreature(getDb(), W, 'chimera')!.spec.hp).toBe(300);
    });
});

describe('spawn_quick_enemy {creature, worldId}', () => {
    it('spawns the world creature with everything on its tokens, stored from create', async () => {
        const r = await manage({ action: 'spawn_quick_enemy', creature: 'Chaos Spawn', count: 2, worldId: W });
        expect(r.error).toBeFalsy();
        const spawns = tokens(r.encounterId).filter(p => p.isEnemy);
        expect(spawns.map(p => p.name).sort()).toEqual(['Chaos Spawn 1', 'Chaos Spawn 2']);
        for (const s of spawns) {
            expect(s).toMatchObject({ hp: 120, maxHp: 120, ac: 12, band: 'Monster/Lord', regeneration: 10, size: 'large', attackDamage: '3d8+6', attackBonus: 9 });
            expect(s.parts[0].state).toBe('intact');
            expect(s.attacks[0].name).toBe('maw');
            expect(s.abilityScores.constitution).toBe(22);
        }
        const row = getDb().prepare('SELECT world_id FROM encounters WHERE id = ?').get(r.encounterId) as { world_id: string };
        expect(row.world_id).toBe(W);
        expect(r.creatureStats).toMatchObject({ name: 'Chaos Spawn', hp: 120, ac: 12, cr: 8 });
    });

    it('built-in presets still spawn as before', async () => {
        const r = await manage({ action: 'spawn_quick_enemy', creature: 'goblin', count: 1 });
        expect(r.error).toBeFalsy();
        expect(tokens(r.encounterId).find(p => p.isEnemy)!.name).toBe('Goblin');
    });

    it('an unknown creature is refused with the list', async () => {
        const r = await manage({ action: 'spawn_quick_enemy', creature: 'Carnifex', worldId: W });
        expect(r.error).toBe(true);
        expect(r.message).toMatch(/Unknown creature/);
    });
});

describe('add_participant {creature, count}', () => {
    async function fight() {
        const now = new Date().toISOString();
        new CharacterRepository(getDb()).create({ id: 'luciel', name: 'Luciel', stats: { str: 20, dex: 14, con: 18, int: 10, wis: 12, cha: 14 }, hp: 200, maxHp: 200, ac: 20, level: 15, createdAt: now, updatedAt: now } as any);
        const r = await manage({ action: 'create', worldId: W, participants: [{ id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 15 }] });
        return r.encounterId as string;
    }

    it('adds count hostile tokens from the encounter world bestiary', async () => {
        const enc = await fight();
        const r = await manage({ action: 'add_participant', encounterId: enc, creature: 'chaos spawn', count: 2 });
        expect(r.error).toBeFalsy();
        expect(r.participants).toHaveLength(2);
        const spawns = tokens(enc).filter(p => p.isEnemy);
        expect(spawns).toHaveLength(2);
        expect(spawns[0]).toMatchObject({ regeneration: 10, band: 'Monster/Lord', maxHp: 120 });
    });

    it('explicit params beat the template', async () => {
        const enc = await fight();
        await manage({ action: 'add_participant', encounterId: enc, creature: 'Chaos Spawn', name: 'Runt', hp: 40, ac: 10, isEnemy: false });
        const runt = tokens(enc).find(p => p.name === 'Runt')!;
        expect(runt).toMatchObject({ hp: 40, ac: 10, regeneration: 10, isEnemy: false });
    });

    it('refuses an unknown creature', async () => {
        const enc = await fight();
        const r = await manage({ action: 'add_participant', encounterId: enc, creature: 'Carnifex' });
        expect(r.error).toBe(true);
        expect(r.message).toMatch(/Carnifex/);
    });
});

describe('table_rules define creature from a live token or a sheet', () => {
    it('fromToken captures the statline and the given spec is merged on top', async () => {
        const created = await manage({ action: 'create', participants: [
            { id: 'karanak', name: 'Karanak', hp: 90, maxHp: 200, initiative: 30, isEnemy: true, ac: 17, band: 'Monster/Lord', attacksPerAction: 2,
                attacks: [{ name: 'axe', attackBonus: 12, damage: '2d8+6', part: 'right arm' }], parts: [{ name: 'right arm', kind: 'arm', state: 'crippled' }] },
            { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 10 }
        ] });
        const r = await rules({ action: 'define', kind: 'creature', name: 'Karanak', fromToken: { encounterId: created.encounterId, participantId: 'karanak' }, spec: { cr: 20 } });
        expect(r.error).toBeFalsy();
        expect(r.rule.spec).toMatchObject({ hp: 200, maxHp: 200, ac: 17, band: 'Monster/Lord', attacksPerAction: 2, cr: 20 });
        expect(r.rule.spec.attacks[0].name).toBe('axe');
        const spawned = await manage({ action: 'spawn_quick_enemy', creature: 'Karanak', worldId: W });
        const k = tokens(spawned.encounterId).find(p => p.isEnemy)!;
        expect(k).toMatchObject({ hp: 200, ac: 17, attacksPerAction: 2 });
        expect(k.parts[0].state).toBe('intact');
    });

    it('fromCharacterId captures the sheet', async () => {
        const now = new Date().toISOString();
        new CharacterRepository(getDb()).create({ id: 'horrun', name: 'Horrun', stats: { str: 26, dex: 12, con: 24, int: 8, wis: 10, cha: 12 }, hp: 50, maxHp: 250, ac: 18, level: 12, regeneration: 5, band: 'Monster/Lord', createdAt: now, updatedAt: now } as any);
        const r = await rules({ action: 'define', kind: 'creature', name: 'Horrun', fromCharacterId: 'horrun' });
        expect(r.error).toBeFalsy();
        expect(r.rule.spec).toMatchObject({ hp: 250, ac: 18, regeneration: 5, band: 'Monster/Lord', stats: { str: 26 } });
    });

    it('fromToken on another kind is refused', async () => {
        const r = await rules({ action: 'define', kind: 'band', name: 'b', fromCharacterId: 'x' });
        expect(r.error).toBe(true);
    });
});

describe('session boot', () => {
    it('lists creatures as a bestiary count, never as enforced rules', async () => {
        await rules({ action: 'define', kind: 'progression', name: 'xp' });
        const res = await handleSessionManage({ action: 'boot', worldId: W }, ctx as any);
        const p = tag(res.content[0].text, 'SESSION_MANAGE');
        expect(p.tableRules.enforced.map((r: any) => r.kind)).not.toContain('creature');
        expect(p.tableRules.bestiary).toBe(1);
        expect(res.content[0].text).toMatch(/Bestiary: 1 creature/);
    });
});
