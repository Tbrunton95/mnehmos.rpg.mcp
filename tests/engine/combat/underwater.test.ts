/**
 * Underwater rules (Deep One audit, request 8): speed fields on the sheet,
 * an encounter environment, and the water rules it drives.
 */
import { handleCombatManage } from '../../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../../src/server/consolidated/combat-action.js';
import { handleCharacterManage } from '../../../src/server/consolidated/character-manage.js';
import { handleTableRules } from '../../../src/server/consolidated/table-rules.js';
import { clearCombatState, getOrLoadEngine } from '../../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const W = 'world-deep';
const ctx = { sessionId: 'deep' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manage = async (args: Record<string, unknown>) => (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, r: d?.actionResult ?? d };
};
const chars = async (args: Record<string, unknown>) => tag((await handleCharacterManage(args, ctx as any)).content[0].text, 'CHARACTER_MANAGE');
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.id === id)! as any;
const row = (id: string) => new CharacterRepository(getDb()).findById(id) as any;
const freshAction = (id: string) => { getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === id)!.actionUsed = false; };

function fresh() {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    const repo = new CharacterRepository(db);
    repo.create({ id: 'diver', name: 'Diver', stats: { str: 16, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }, hp: 60, maxHp: 60, ac: 15, level: 5, speed: 30, createdAt: now, updatedAt: now } as any);
    repo.create({ id: 'eel', name: 'Eel', stats: { str: 14, dex: 16, con: 12, int: 3, wis: 10, cha: 3 }, hp: 40, maxHp: 40, ac: 13, level: 3, speed: 10, swimSpeed: 40, createdAt: now, updatedAt: now } as any);
    return db;
}

async function fight(extra: Record<string, unknown> = {}, participants?: unknown[]) {
    enc = tag((await handleCombatManage({ action: 'create', seed: 'deep-1', worldId: W, participants: participants ?? [
        { id: 'diver', name: 'Diver', hp: 60, maxHp: 60, initiative: 30, position: { x: 2, y: 2 } },
        { id: 'eel', name: 'Eel', hp: 40, maxHp: 40, initiative: 20, isEnemy: true, tags: ['aquatic'], position: { x: 3, y: 2 } }
    ], ...extra }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
}

afterEach(() => closeDb());

describe('speed fields on the character row', () => {
    it('persist in combat_profile, read back, and update through character_manage', async () => {
        fresh();
        expect(row('eel')).toMatchObject({ speed: 10, swimSpeed: 40 });
        const raw = getDb().prepare('SELECT combat_profile FROM characters WHERE id = ?').get('eel') as { combat_profile: string };
        expect(JSON.parse(raw.combat_profile)).toMatchObject({ speed: 10, swimSpeed: 40 });
        await handleCharacterManage({ action: 'update', characterId: 'diver', swimSpeed: 20, flySpeed: 0 }, ctx as any);
        expect(row('diver')).toMatchObject({ speed: 30, swimSpeed: 20, flySpeed: 0 });
    });

    it('a species rule speed is stored at create', async () => {
        fresh();
        await handleTableRules({ action: 'define', worldId: W, kind: 'species', name: 'Merrow', spec: { size: 'large', speed: 10, swimSpeed: 40 } }, ctx as any);
        const made = await chars({ action: 'create', worldId: W, name: 'Thessaly', race: 'Merrow', class: 'fighter' });
        const id = made.character?.id ?? made.characterId ?? made.id;
        expect(row(id)).toMatchObject({ speed: 10, swimSpeed: 40 });
    });

    it('hydrates token movementSpeed and swimSpeed from the row', async () => {
        fresh();
        await fight();
        expect(tok('diver').movementSpeed).toBe(30);
        expect(tok('eel')).toMatchObject({ movementSpeed: 10, swimSpeed: 40 });
    });

    it('the status block shows spd / swim', async () => {
        fresh();
        const text = (await handleCharacterManage({ action: 'get_status_block', characterId: 'eel' }, ctx as any)).content[0].text;
        expect(text).toMatch(/SPD\s+10 \/ swim 40/);
        const d = tag(text, 'CHARACTER_MANAGE');
        expect(d).toMatchObject({ speed: 10, swimSpeed: 40 });
    });

    it('set_form carries speed, swimSpeed and flySpeed and puts them down with the form', async () => {
        fresh();
        await handleTableRules({ action: 'define', worldId: W, kind: 'creature', name: 'Giant Shark', spec: { hp: 90, ac: 13, stats: { str: 23 }, movementSpeed: 0, swimSpeed: 50, attack: { name: 'bite', damage: '3d10+6', damageType: 'piercing', toHit: 9 } } }, ctx as any);
        await fight();
        await handleCharacterManage({ action: 'set_form', characterId: 'diver', form: 'Giant Shark', worldId: W }, ctx as any);
        expect(row('diver')).toMatchObject({ speed: 0, swimSpeed: 50 });
        expect(tok('diver')).toMatchObject({ movementSpeed: 0, swimSpeed: 50 });
        await handleCharacterManage({ action: 'set_form', characterId: 'diver', form: 'base' }, ctx as any);
        expect(row('diver').speed).toBe(30);
        expect(row('diver').swimSpeed).toBeUndefined();
        expect(tok('diver').movementSpeed).toBe(30);
        expect(tok('diver').swimSpeed).toBeUndefined();
    });
});

describe('encounter environment', () => {
    it('is accepted on create, persisted, shown on get, and changed by set_environment', async () => {
        fresh();
        await fight({ environment: { medium: 'water', depthFt: 40 } });
        const saved = new EncounterRepository(getDb()).loadState(enc)!;
        expect(saved.environment).toMatchObject({ medium: 'water', depthFt: 40 });
        const got = await manage({ action: 'get' });
        expect(got).toContain('⟨water · 40 ft⟩');
        expect(tag(got, 'COMBAT_MANAGE').environment.medium).toBe('water');
        const set = await manage({ action: 'set_environment', environment: { medium: 'air' } });
        expect(tag(set, 'COMBAT_MANAGE')).toMatchObject({ success: true, environment: { medium: 'air' } });
        expect(new EncounterRepository(getDb()).loadState(enc)!.environment.medium).toBe('air');
        clearCombatState();
        expect(await manage({ action: 'get' })).not.toContain('⟨water');
    });

    it('refuses ranged attacks in water unless rangedAllowed, spending nothing', async () => {
        fresh();
        await fight({ environment: { medium: 'water' } });
        const shot = await act({ action: 'attack', actorId: 'diver', targetId: 'eel', attackBonus: 5, damage: 1, damageType: 'piercing', ranged: true });
        expect(shot.text).toMatch(/ranged attack.*underwater|underwater.*ranged/i);
        expect(tok('diver').actionUsed).toBeFalsy();
        await manage({ action: 'set_environment', environment: { medium: 'water', rangedAllowed: true } });
        const ok = await act({ action: 'attack', actorId: 'diver', targetId: 'eel', attackBonus: 5, damage: 1, damageType: 'piercing', ranged: true });
        expect(ok.r.roll.allRolls).toHaveLength(1);
    });

    it('melee at disadvantage in water, waived for piercing damage and for the swim tag', async () => {
        fresh();
        await fight({ environment: { medium: 'water' } });
        const slash = await act({ action: 'attack', actorId: 'diver', targetId: 'eel', attackBonus: 5, damage: 1, damageType: 'slashing' });
        expect(slash.r.roll.allRolls).toHaveLength(2);
        expect(slash.text).toMatch(/underwater \(disadvantage/);
        freshAction('diver');
        const stab = await act({ action: 'attack', actorId: 'diver', targetId: 'eel', attackBonus: 5, damage: 1, damageType: 'piercing' });
        expect(stab.r.roll.allRolls).toHaveLength(1);
        await manage({ action: 'advance' });
        const bite = await act({ action: 'attack', actorId: 'eel', targetId: 'diver', attackBonus: 5, damage: 1, damageType: 'slashing' });
        expect(bite.r.roll.allRolls).toHaveLength(1);
    });

    it('movement budget is swimSpeed, else half speed', async () => {
        fresh();
        await fight({ environment: { medium: 'water' } });
        await manage({ action: 'advance' });
        expect(tok('eel').movementRemaining).toBe(40);
        await manage({ action: 'advance' });
        expect(tok('diver').movementRemaining).toBe(15);
    });

    it('applies pressure damage at the start of a turn below the threshold, unless tagged', async () => {
        fresh();
        await fight({ environment: { medium: 'water', depthFt: 300, pressure: { startsAtFt: 100, damagePerRound: 5 } } });
        // The eel carries the swim tag: pressure-adapted by default.
        let text = await manage({ action: 'advance' });
        expect(text).not.toMatch(/takes \d+ pressure damage/);
        expect(tok('eel').hp).toBe(40);
        text = await manage({ action: 'advance' });
        expect(text).toMatch(/Diver takes 5 pressure damage at 300 ft/);
        expect(tok('diver').hp).toBe(55);
    });

    it('rolls dice pressure damage, and unlessTag names who is spared', async () => {
        fresh();
        await fight({ environment: { medium: 'water', depthFt: 300, pressure: { startsAtFt: 100, damagePerRound: '1d4', unlessTag: 'pressure-proof' } } });
        await manage({ action: 'advance' });
        expect(tok('eel').hp).toBeLessThan(40);
        expect(tok('eel').hp).toBeGreaterThanOrEqual(36);
    });

    it('an air encounter is unaffected', async () => {
        fresh();
        await fight();
        const shot = await act({ action: 'attack', actorId: 'diver', targetId: 'eel', attackBonus: 5, damage: 1, damageType: 'slashing', ranged: true });
        expect(shot.r.roll.allRolls).toHaveLength(1);
        await manage({ action: 'advance' }); await manage({ action: 'advance' });
        expect(tok('diver').movementRemaining).toBe(30);
    });

    it('a token on a water cell in an air encounter swims', async () => {
        fresh();
        await fight({ terrain: { obstacles: [], water: ['2,2'] } });
        const slash = await act({ action: 'attack', actorId: 'diver', targetId: 'eel', attackBonus: 5, damage: 1, damageType: 'slashing' });
        expect(slash.r.roll.allRolls).toHaveLength(2);
        freshAction('diver');
        const shot = await act({ action: 'attack', actorId: 'diver', targetId: 'eel', attackBonus: 5, damage: 1, damageType: 'piercing', ranged: true });
        expect(shot.text).toMatch(/underwater/i);
        await manage({ action: 'advance' }); await manage({ action: 'advance' });
        expect(tok('diver').movementRemaining).toBe(15);
    });
});
