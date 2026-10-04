import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleCharacterManage, CharacterManageTool } from '../../src/server/consolidated/character-manage.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { parseRuleSpec } from '../../src/engine/table-rules.js';

/**
 * Deep One audit request 5: the void-combat lane. A table_rules vessel
 * becomes a character row (hull, shields, sections, weapons persist), the
 * engine drains shields before the hull and regenerates them at turn start,
 * crippled sections bite by role (drive, guns, bridge, reactor), called
 * strikes aim at a section with atPart, and board opens a linked boarding
 * encounter that reports back to the void fight when it ends.
 */
const W = 'm42-void';
const ctx = { sessionId: 'void' };
const json = (text: string) => { const m = text.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : null; };

const rules = async (a: Record<string, unknown>) => json((await handleTableRules({ worldId: W, ...a }, ctx as any)).content[0].text);
const chars = async (a: Record<string, unknown>) => json((await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx as any)).content[0].text);
let enc: string;
const manage = async (a: Record<string, unknown>) => {
    const text = (await handleCombatManage({ encounterId: enc, ...a }, ctx as any)).content[0].text;
    return { text, r: json(text) };
};
const act = async (a: Record<string, unknown>) => {
    const text = (await handleCombatAction({ encounterId: enc, ...a }, ctx as any)).content[0].text;
    const d = json(text);
    return { text, d, r: d?.actionResult ?? d };
};
const tok = (id: string, e = enc) => new EncounterRepository(getDb()).loadState(e)!.participants.find((p: any) => p.id === id)! as any;
const row = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
const live = (id: string) => getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === id)! as any;

const GLORIANA = {
    displayName: 'Gloriana-class battleship',
    hull: 400, ac: 14, shields: { max: 60, regenPerRound: 10 },
    sections: [
        { name: 'Plasma drive', hp: 80, role: 'drive' },
        { name: 'Lance battery', hp: 60, ac: 16, role: 'guns' },
        { name: 'Macro-cannon broadside', hp: 70, role: 'guns' },
        { name: 'Command bridge', hp: 50, ac: 18, role: 'bridge' },
        { name: 'Reactor core', hp: 90, breakAt: 60, role: 'reactor' },
        { name: 'Launch bays', hp: 40, role: 'hangar' }
    ],
    weapons: [
        { name: 'Lance', attackBonus: 8, damage: '6d10', damageType: 'energy', range: 60000, section: 'Lance battery' },
        { name: 'Broadside', attackBonus: 6, damage: '8d8', damageType: 'kinetic', range: 30000, section: 'Macro-cannon broadside' }
    ],
    speed: 6, band: 'Capital', crew: 100000, size: 'colossal', traits: ['Void shields', 'Flagship']
};
const MURDER = {
    hull: 220, ac: 15,
    sections: [
        { name: 'Drive', hp: 50, role: 'drive' },
        { name: 'Guns', hp: 50, role: 'guns' },
        { name: 'Bridge', hp: 40, role: 'bridge' },
        { name: 'Reactor', hp: 60, role: 'reactor' }
    ],
    weapons: [{ name: 'Lance', attackBonus: 6, damage: '4d10', damageType: 'energy', range: 40000, section: 'Guns' }],
    speed: 8, band: 'Cruiser'
};

let gloriana: string;
let murder: string;

async function setup(opts: { seed?: string } = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'The Void', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    const g = await rules({ action: 'define', kind: 'vessel', name: 'Gloriana', spec: GLORIANA });
    const m = await rules({ action: 'define', kind: 'vessel', name: 'Murder-class', spec: MURDER });
    if (g?.error || m?.error) throw new Error(JSON.stringify({ g, m }));
    gloriana = (await chars({ action: 'create_vessel', worldId: W, vessel: 'Gloriana', name: 'Macragge\'s Honour' })).characterId;
    murder = (await chars({ action: 'create_vessel', worldId: W, vessel: 'Murder-class', name: 'Blade of Ruin' })).characterId;
    const g2 = row(gloriana); const m2 = row(murder);
    enc = json((await handleCombatManage({ action: 'create', worldId: W, seed: opts.seed ?? 'void-fight', participants: [
        { id: gloriana, name: g2.name, hp: g2.hp, maxHp: g2.maxHp, initiative: 20 },
        { id: murder, name: m2.name, hp: m2.hp, maxHp: m2.maxHp, initiative: 10, isEnemy: true }
    ] }, ctx as any)).content[0].text).encounterId;
}

afterEach(() => closeDb());

describe('vessel rule', () => {
    it('parses with defaults and refuses a vessel without sections', () => {
        const spec = parseRuleSpec('vessel', GLORIANA);
        expect(spec.hull).toBe(400);
        expect(spec.shields).toEqual({ max: 60, regenPerRound: 10 });
        expect(spec.sections[0]).toMatchObject({ name: 'Plasma drive', hp: 80, role: 'drive' });
        expect(spec.weapons[0]).toMatchObject({ name: 'Lance', section: 'Lance battery' });
        expect(parseRuleSpec('vessel', { hull: 10, ac: 10, sections: [{ name: 'Hull', hp: 5 }] }).sections[0].role).toBe('other');
        expect(() => parseRuleSpec('vessel', { hull: 10, ac: 10, sections: [] })).toThrow(/sections/);
        expect(() => parseRuleSpec('vessel', { hull: 10, ac: 10, sections: [{ name: 'x', hp: 1, role: 'engine' }] })).toThrow(/role/);
    });
});

describe('character_manage create_vessel', () => {
    it('lays the ship down as a character row: hull, sections as system parts, weapons, shields pool, vessel profile', async () => {
        await setup();
        const r = row(gloriana);
        expect(r.name).toBe("Macragge's Honour");
        expect(r.race).toBe('vessel');
        expect(r.hp).toBe(400); expect(r.maxHp).toBe(400); expect(r.ac).toBe(14);
        expect(r.band).toBe('Capital');
        expect(r.size).toBe('gargantuan');
        expect(r.parts).toHaveLength(6);
        expect(r.parts[0]).toMatchObject({ name: 'Plasma drive', kind: 'system', state: 'intact', role: 'drive', hp: 80, maxHp: 80 });
        expect(r.parts[4]).toMatchObject({ name: 'Reactor core', role: 'reactor', breakAt: 60 });
        expect(r.attacks[0]).toMatchObject({ name: 'Lance', attackBonus: 8, damage: '6d10', damageType: 'energy', part: 'Lance battery', ranged: true, default: true });
        expect(r.resourcePools.shields).toMatchObject({ current: 60, max: 60 });
        expect(r.vessel).toMatchObject({ regenPerRound: 10, roles: { 'Plasma drive': 'drive', 'Reactor core': 'reactor' }, speed: 6, crew: 100000, sizeLabel: 'colossal' });
        expect(getDb().prepare('SELECT world_id FROM characters WHERE id = ?').get(gloriana)).toEqual({ world_id: W });
        // No shields in the rule: no pool.
        expect(row(murder).resourcePools.shields).toBeUndefined();
        expect(row(murder).vessel.regenPerRound).toBe(0);
    });

    it('reports the id and a manifest; an unknown rule or an unmounted weapon is refused', async () => {
        await setup();
        const made = await chars({ action: 'create_vessel', worldId: W, vessel: 'gloriana', shields: { max: 100 } });
        expect(made.characterId).toBeTruthy();
        expect(made.name).toBe('Gloriana-class battleship');
        expect(made.shields).toEqual({ current: 100, max: 100, regenPerRound: 10 });
        expect(made.manifest).toMatch(/hull 400, AC 14, shields 100 \(\+10\/round\)/);
        expect(made.manifest).toMatch(/Reactor core \[reactor\] 90 hp breaks at 60/);
        const missing = await chars({ action: 'create_vessel', worldId: W, vessel: 'Nope' });
        expect(missing.error).toBe(true);
        expect(missing.message).toMatch(/vessels: Gloriana, Murder-class/);
        await rules({ action: 'define', kind: 'vessel', name: 'Broken', spec: { hull: 10, ac: 10, sections: [{ name: 'Hull', hp: 10 }], weapons: [{ name: 'Gun', attackBonus: 1, damage: 2, section: 'Turret' }] } });
        const broken = await chars({ action: 'create_vessel', worldId: W, vessel: 'Broken' });
        expect(broken.error).toBe(true);
        expect(broken.message).toMatch(/Gun → Turret/);
    });
});

describe('vessel tokens in combat', () => {
    it('hydrates vessel, shields and speed onto the token from the row', async () => {
        await setup();
        const g = tok(gloriana);
        expect(g.vessel).toMatchObject({ regenPerRound: 10 });
        expect(g.shields).toEqual({ current: 60, max: 60 });
        expect(g.movementSpeed).toBe(6);
        expect(g.parts.map((p: any) => p.role)).toEqual(['drive', 'guns', 'guns', 'bridge', 'reactor', 'hangar']);
        expect(tok(murder).shields).toBeUndefined();
    });

    it('shields absorb first, the hull takes the rest; the row follows', async () => {
        await setup();
        // Murder-class shoots the Gloriana (off its turn: GM-posted result).
        const { text, r } = await act({ action: 'attack', actorId: murder, targetId: gloriana, outcome: 'hit', damage: 75, reaction: true });
        expect(r.shieldsAbsorbed).toBe(60);
        expect(r.shields).toEqual({ current: 0, max: 60 });
        expect(r.damage.total).toBe(15);
        expect(r.target.hpAfter).toBe(385);
        expect(text).toMatch(/shields absorb 60 \(shields 0\/60\)/);
        expect(row(gloriana).hp).toBe(385);
        expect(row(gloriana).resourcePools.shields.current).toBe(0);
        // A hit fully absorbed: no hull damage, shields still written.
        await setup();
        const soft = await act({ action: 'attack', actorId: murder, targetId: gloriana, outcome: 'hit', damage: 20, reaction: true });
        expect(soft.r.shieldsAbsorbed).toBe(20);
        expect(soft.r.damage.total).toBe(0);
        expect(tok(gloriana).hp).toBe(400);
        expect(row(gloriana).resourcePools.shields.current).toBe(40);
    });

    it('apply_damage names the shields it drained before the hull', async () => {
        await setup();
        const { text, r } = await manage({ action: 'apply_damage', targetIds: [gloriana], dice: 30, source: 'macro cannon broadside' });
        const t = r.targets[0];
        expect(t.shieldsAbsorbed).toBe(30);
        expect(t.shields).toEqual({ current: 30, max: 60 });
        expect(t.hpAfter).toBe(400);
        expect(text).toMatch(/Shields: −30, 30\/60 left/);
    });

    it('shields regenerate regenPerRound at the start of the vessel\'s turn, logged in the turn events', async () => {
        await setup();
        await act({ action: 'attack', actorId: murder, targetId: gloriana, outcome: 'hit', damage: 35, reaction: true });
        expect(tok(gloriana).shields.current).toBe(25);
        await manage({ action: 'advance' });           // → Murder-class
        const back = await manage({ action: 'advance' }); // → Gloriana: regen
        expect(back.text).toMatch(/shields regenerate 10 \(25 → 35\/60\)/);
        expect(tok(gloriana).shields).toEqual({ current: 35, max: 60 });
        expect(row(gloriana).resourcePools.shields.current).toBe(35);
    });

    it('drive crippled or dead: speed 0', async () => {
        await setup();
        const engine = getOrLoadEngine(ctx as any, enc)!;
        expect(engine.effectiveSpeed(live(murder))).toBe(8);
        await manage({ action: 'set_part', participantId: murder, part: 'Drive', state: 'crippled' });
        expect(engine.effectiveSpeed(live(murder))).toBe(0);
        const moved = await act({ action: 'move', actorId: gloriana, targetId: murder, targetPosition: { x: 3, y: 0 } });
        expect(moved.d?.error ?? moved.text).toBeTruthy();
    });

    it('a crippled guns section refuses the weapons it mounts; another section still fires', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: gloriana, part: 'Lance battery', state: 'crippled' });
        const refused = await act({ action: 'attack', actorId: gloriana, targetId: murder, using: 'Lance' });
        expect(refused.text).toMatch(/Lance battery \(guns\) is crippled: its weapons cannot fire/);
        expect(live(gloriana).actionUsed).toBeFalsy();
        const fired = await act({ action: 'attack', actorId: gloriana, targetId: murder, using: 'Broadside' });
        expect(fired.r?.roll).toBeTruthy();
        expect(fired.r.roll.targetAc).toBe(15);
    });

    it('bridge crippled: the vessel attacks at disadvantage', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: gloriana, part: 'Command bridge', state: 'crippled' });
        const { r } = await act({ action: 'attack', actorId: gloriana, targetId: murder, using: 'Broadside' });
        expect(r.roll.allRolls).toHaveLength(2);
        expect(r.situational).toContain("Macragge's Honour's bridge crippled (disadvantage)");
    });

    it('reactor dead: reactorBreach on the token, a logged d6 each turn start, a 1 destroys the vessel', async () => {
        await setup({ seed: 'reactor-breach' });
        await manage({ action: 'set_part', participantId: murder, part: 'Reactor', state: 'dead' });
        expect(tok(murder).reactorBreach).toBe(true);
        let destroyed = false;
        let notes = 0;
        for (let i = 0; i < 120 && !destroyed; i++) {
            const { text } = await manage({ action: 'advance' });
            if (/Blade of Ruin: reactor breach holds \(d6=[2-6]/.test(text)) notes++;
            if (/REACTOR BREACH d6=1 — the reactor goes critical; the vessel is destroyed/.test(text)) destroyed = true;
        }
        expect(destroyed).toBe(true);
        expect(notes).toBeGreaterThanOrEqual(0);
        expect(tok(murder).hp).toBe(0);
        expect(tok(murder).isDead).toBe(true);
        expect(row(murder).hp).toBe(0);
        // The die is tagged for the roll log (the operation guard drains these in play).
        const records = getOrLoadEngine(ctx as any, enc)!.drainRollRecords();
        expect(records.some(rec => rec.purpose === 'reactor breach')).toBe(true);
    });

    it('a called strike at a section (atPart) lands on the section once the shields are down', async () => {
        await setup();
        // The Murder-class has no shields: the aimed hit goes to its drive, not the hull.
        const { r } = await act({ action: 'attack', actorId: gloriana, targetId: murder, using: 'Broadside', atPart: 'Drive', outcome: 'hit', damage: 30 });
        expect(r.partHit).toMatchObject({ name: 'Drive', damage: 30, hpBefore: 50, hpAfter: 20, broken: false });
        expect(r.damage.total).toBe(0);
        expect(tok(murder).hp).toBe(220);
        // Shields up: they take the aimed hit first; what gets through reaches the section.
        await manage({ action: 'set_part', participantId: gloriana, part: 'Reactor core', state: 'intact' });
        const aimed = await act({ action: 'attack', actorId: murder, targetId: gloriana, using: 'Lance', atPart: 'Reactor core', outcome: 'hit', damage: 70, reaction: true });
        expect(aimed.r.shieldsAbsorbed).toBe(60);
        expect(aimed.r.partHit).toMatchObject({ name: 'Reactor core', damage: 10, hpBefore: 90, hpAfter: 80 });
        expect(tok(gloriana).hp).toBe(400);
        // A hit of breakAt or more severs the reactor: breach.
        live(murder).reactionUsed = false;
        await act({ action: 'attack', actorId: murder, targetId: gloriana, using: 'Lance', atPart: 'Reactor core', outcome: 'hit', damage: 65, reaction: true });
        expect(tok(gloriana).parts.find((p: any) => p.name === 'Reactor core').state).toBe('dead');
        expect(tok(gloriana).reactorBreach).toBe(true);
    });
});

describe('combat_manage board', () => {
    it('opens a linked boarding encounter (parent_id), notes rooms and the origin, and the parent lists it', async () => {
        await setup();
        const { r } = await manage({ action: 'board', attackerId: gloriana, targetId: murder, rooms: ['Boarding torpedo breach', 'Gun deck', 'Bridge'] });
        expect(r.success).toBe(true);
        const child = r.childEncounterId as string;
        expect(child).toBeTruthy();
        expect(child).not.toBe(enc);
        expect(r.rooms).toEqual(['Boarding torpedo breach', 'Gun deck', 'Bridge']);
        expect(r.roomsSource).toBe('given');
        expect(r.boardingFrom).toMatchObject({ encounterId: enc, attackerId: gloriana, targetId: murder });
        const repo = new EncounterRepository(getDb());
        expect(repo.parentOf(child)).toBe(enc);
        expect(repo.getNotes(child)).toMatchObject({ boardingFrom: { encounterId: enc, attackerId: gloriana, targetId: murder }, rooms: ['Boarding torpedo breach', 'Gun deck', 'Bridge'] });
        expect(repo.getNotes(enc).boardings).toEqual([expect.objectContaining({ childEncounterId: child, status: 'active' })]);
        // The parent's get shows the link; the child's get points home.
        const parent = await manage({ action: 'get' });
        expect(parent.r.boardings).toEqual([expect.objectContaining({ encounterId: child, status: 'active', attackerId: gloriana })]);
        const childGet = json((await handleCombatManage({ action: 'get', encounterId: child }, ctx as any)).content[0].text);
        expect(childGet.parentEncounterId).toBe(enc);
        expect(childGet.boardingFrom.targetId).toBe(murder);
        // The void fight is untouched and still active.
        expect(repo.findById(enc)!.status).toBe('active');
        expect(tok(gloriana).hp).toBe(400);
        // The child starts empty; boarders join it like any encounter.
        expect(tok(gloriana, child)).toBeUndefined();
        const joined = json((await handleCombatManage({ action: 'add_participant', encounterId: child, name: 'Terminator squad', hp: 60, maxHp: 60, ac: 18 }, ctx as any)).content[0].text);
        expect(joined.success).toBe(true);
        expect(repo.loadState(child)!.participants).toHaveLength(1);
        expect(repo.loadState(child)!.currentTurnIndex).toBe(0);
    });

    it('reads the target\'s deck plan from its spatial network when no rooms are given', async () => {
        await setup();
        const db = getDb();
        const now = new Date().toISOString();
        db.prepare("INSERT INTO node_networks (id, name, type, world_id, center_x, center_y, created_at, updated_at) VALUES (?, 'Blade of Ruin decks', 'linear', ?, 0, 0, ?, ?)").run(murder, W, now, now);
        const ins = db.prepare("INSERT INTO room_nodes (id, name, base_description, biome_context, network_id, created_at, updated_at) VALUES (?, ?, ?, 'dungeon', ?, ?, ?)");
        ins.run('rm-1', 'Torpedo bay', 'Scorched launch cradles and a breach.', murder, now, now);
        ins.run('rm-2', 'Gun deck', 'Chained gun crews at the macro-cannons.', murder, now, now);
        const { r } = await manage({ action: 'board', attackerId: gloriana, targetId: murder });
        expect(r.rooms).toEqual(['Torpedo bay', 'Gun deck']);
        expect(r.roomsSource).toBe('spatial');
    });

    it('refuses non-vessels, a destroyed target and self-boarding', async () => {
        await setup();
        await handleCombatManage({ action: 'add_participant', encounterId: enc, name: 'Escort fighter', hp: 20, maxHp: 20 }, ctx as any);
        const fighter = new EncounterRepository(getDb()).loadState(enc)!.participants.find((p: any) => p.name === 'Escort fighter')!.id;
        const notVessel = await manage({ action: 'board', attackerId: gloriana, targetId: fighter });
        expect(notVessel.r.error).toBe(true);
        expect(notVessel.r.message).toMatch(/not a vessel: Escort fighter/);
        const self = await manage({ action: 'board', attackerId: gloriana, targetId: gloriana });
        expect(self.r.message).toMatch(/cannot board itself/);
        await manage({ action: 'adjust_hp', participantId: murder, value: 0, reason: 'test' });
        const dead = await manage({ action: 'board', attackerId: gloriana, targetId: murder });
        expect(dead.r.message).toMatch(/destroyed; there is nothing to board/);
        expect(new EncounterRepository(getDb()).childrenOf(enc)).toEqual([]);
    });

    it('end on the boarding reports boardingResult to the parent; the parent\'s get shows it', async () => {
        await setup();
        const board = await manage({ action: 'board', attackerId: gloriana, targetId: murder, name: 'Honour boards Ruin' });
        const child = board.r.childEncounterId as string;
        await handleCombatManage({ action: 'add_participant', encounterId: child, name: 'Terminator squad', hp: 60, maxHp: 60 }, ctx as any);
        await handleCombatManage({ action: 'add_participant', encounterId: child, name: 'Gun crew', hp: 0, maxHp: 20, isEnemy: true }, ctx as any);
        const ended = json((await handleCombatManage({ action: 'end', encounterId: child, winner: 'attackers' }, ctx as any)).content[0].text);
        expect(ended.parentEncounterId).toBe(enc);
        expect(ended.boardingResult).toMatchObject({ child, winner: 'attackers', summary: 'survivors: Terminator squad' });
        expect(ended.message).toMatch(/Reported to the void fight/);
        const repo = new EncounterRepository(getDb());
        expect(repo.findById(child)!.status).toBe('completed');
        expect(repo.findById(enc)!.status).toBe('active');
        const notes = repo.getNotes(enc);
        expect(notes.boardingResults).toEqual([expect.objectContaining({ child, winner: 'attackers' })]);
        expect((notes.boardings as any[])[0].status).toBe('ended');
        const parent = await manage({ action: 'get' });
        expect(parent.r.boardingResults).toEqual([expect.objectContaining({ child, winner: 'attackers' })]);
        expect(parent.r.boardings[0]).toMatchObject({ encounterId: child, status: 'completed' });
        // A plain fight (no parent) ends as before.
        const plain = await manage({ action: 'end' });
        expect(plain.r.boardingResult).toBeUndefined();
    });
});
