/**
 * Play report 5 #8c: trait advantage, the owner's spec. The trait is data on
 * the sheet (skillAdvantage); a check tagged with a matching context gets
 * advantage and the log names it; an untagged check gets nothing and is told
 * the tag; a denial stated on the scene (scene-wide or per target) removes it
 * and quotes the reason; a denial set after a roll never touches that roll;
 * a scene wind plus token positions computes upwind and downwind; the status
 * block shows passive Perception and passive Perception (scent); a hide or
 * sneak against the character is compared to the scent passive unless scent
 * is denied; Survival tracking takes the same tag.
 */
import seedrandom from 'seedrandom';
import { handleMathManage, MathManageTool } from '../../src/server/consolidated/math-manage.js';
import { handleCharacterManage, CharacterManageTool } from '../../src/server/consolidated/character-manage.js';
import { handleSceneManage, SceneManageTool } from '../../src/server/consolidated/scene-manage.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleImprovisationManage, ImprovisationManageTool } from '../../src/server/consolidated/improvisation-manage.js';
import { handleTableRules, TableRulesTool } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'trait-advantage' } as any;
const W = 'moor';
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const math = async (a: Record<string, unknown>) => json(await handleMathManage(MathManageTool.inputSchema.parse(a), ctx));
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx));
const scene = async (a: Record<string, unknown>) => json(await handleSceneManage(SceneManageTool.inputSchema.parse({ worldId: W, ...a }), ctx));
const improv = async (a: Record<string, unknown>) => json(await handleImprovisationManage(ImprovisationManageTool.inputSchema.parse(a), ctx));
const KEEN_SMELL = { name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent', passiveBonus: 5, note: 'scent-based Perception; tracking by scent' };

/** A seedrandom seed whose first d20 is n (the dice draw floor(rng() * 20) + 1). */
function seedWithFirstD20(n: number): string {
    for (let i = 0; i < 5000; i++) {
        const seed = `trait-${n}-${i}`;
        if (Math.floor(seedrandom(seed)() * 20) + 1 === n) return seed;
    }
    throw new Error(`no seed for ${n}`);
}

function mkChar(id: string, name: string, over: Record<string, unknown>) {
    const now = new Date().toISOString();
    new CharacterRepository(getDb()).create({
        id, name, characterType: 'pc', level: 1, hp: 10, maxHp: 10, ac: 11, speed: 30,
        stats: { str: 10, dex: 10, con: 10, int: 10, wis: 12, cha: 10 },
        skillProficiencies: [], expertise: [], conditions: [], createdAt: now, updatedAt: now, ...over
    } as any);
    getDb().prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(W, id);
}

beforeEach(() => {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new WorldRepository(db).create({ id: W, name: 'The Moor', seed: 's', width: 20, height: 20, createdAt: now, updatedAt: now } as any);
    try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
    // Varek: WIS 12, not proficient → Perception +1, passive 11; Keen Smell → passive (scent) 16.
    mkChar('varek', 'Varek', { skillAdvantage: [KEEN_SMELL] });
    // Ratling: the one hiding, sneaking and being tracked.
    mkChar('ratling', 'Ratling', { stats: { str: 8, dex: 14, con: 10, int: 10, wis: 10, cha: 8 } });
});
afterEach(() => closeDb());

describe('the trait on the sheet', () => {
    it('skillAdvantage survives create, update and get through the outer schema; a bad shape is refused', async () => {
        const c = await char({ action: 'create', name: 'Hound', skillAdvantage: [KEEN_SMELL] });
        expect(c.skillAdvantage).toEqual([KEEN_SMELL]);
        expect((await char({ action: 'get', characterId: c.id })).skillAdvantage).toEqual([KEEN_SMELL]);
        await char({ action: 'update', characterId: c.id, skillAdvantage: [{ name: 'Stonecunning', skills: ['history'], when: 'stonework' }] });
        expect((await char({ action: 'get', characterId: c.id })).skillAdvantage).toEqual([{ name: 'Stonecunning', skills: ['history'], when: 'stonework' }]);
        expect(() => CharacterManageTool.inputSchema.parse({ action: 'update', characterId: c.id, skillAdvantage: [{ name: 'X', skills: ['history'] }] })).toThrow();
    });

    it('a species rule carries skillAdvantage onto the sheet at create', async () => {
        const rules = async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx));
        await rules({ action: 'define', kind: 'species', name: 'Gnoll', spec: { speed: 30, skillAdvantage: [KEEN_SMELL], senses: { darkvisionFt: 60 } } });
        const c = await char({ action: 'create', name: 'Yip', race: 'Gnoll', worldId: W });
        expect(new CharacterRepository(getDb()).findById(c.id)!.skillAdvantage).toEqual([KEEN_SMELL]);
    });
});

describe('roll_skill_check with a context tag', () => {
    it("a scent-tagged Perception check rolls 2d20kh1 and the log names 'Keen Smell (scent)'", async () => {
        const r = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', dc: 12, context: ['scent'] });
        expect(r.success).toBe(true);
        expect(r.rolls).toHaveLength(2);
        expect(r.natural).toBe(Math.max(...r.rolls));
        expect(r.advantageSources).toEqual(['Keen Smell (scent)']);
        expect(r.traitAdvantage).toEqual(['Keen Smell (scent)']);
        expect(r.breakdown).toContain('advantage ← Keen Smell (scent)');
        expect(r.context).toEqual(['scent']);
        const row = getDb().prepare('SELECT purpose, expression FROM roll_log WHERE id = ?').get(r.rollId) as { purpose: string; expression: string };
        expect(row.purpose).toBe('perception check (adv: Keen Smell (scent))');
        expect(row.expression).toBe('2d20kh1');
    });

    it('an untagged check gets no advantage and is told the tag; a string context is accepted', async () => {
        const plain = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception' });
        expect(plain.rolls).toHaveLength(1);
        expect(plain.advantageSources).toBeUndefined();
        expect(plain.conditionalAdvantage).toEqual(["Keen Smell (scent): pass context: ['scent'] when the check is scent-based"]);
        const other = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['sight'] });
        expect(other.rolls).toHaveLength(1);
        const str = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: 'scent' });
        expect(str.rolls).toHaveLength(2);
    });

    it('a Survival check to follow a trail takes the same tag; Insight with the tag gets nothing', async () => {
        const track = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'survival', context: ['scent'] });
        expect(track.advantageSources).toEqual(['Keen Smell (scent)']);
        const insight = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'insight', context: ['scent'] });
        expect(insight.rolls).toHaveLength(1);
        expect(insight.conditionalAdvantage).toBeUndefined();
    });

    it('a GM disadvantage cancels the trait advantage to one die, as normal', async () => {
        const r = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent'], disadvantage: true });
        expect(r.rolls).toHaveLength(1);
        expect(r.advantageSources).toEqual(['Keen Smell (scent)']);
    });

    it('seed replays the die, so a table can check a check', async () => {
        const a = await math({ action: 'roll_skill_check', characterId: 'ratling', skill: 'stealth', seed: seedWithFirstD20(12) });
        expect(a.natural).toBe(12);
        expect(a.dice).toBe(`seeded:${seedWithFirstD20(12)}`);
    });

    it('against on a check that is not Stealth, and context on an ability check or a save, are reported as not applied, never swallowed', async () => {
        const perception = await math({ action: 'roll_skill_check', characterId: 'ratling', skill: 'perception', against: 'varek' });
        expect(perception.against).toBeUndefined();
        expect(perception.resolverProblems.join(' ')).toMatch(/against.*Stealth only/i);
        expect(perception.breakdown.join(' ')).toMatch(/against/);
        const ability = await math({ action: 'roll_ability_check', characterId: 'varek', ability: 'wis', context: ['scent'] });
        expect(ability.rolls).toHaveLength(1);
        expect(ability.resolverProblems.join(' ')).toMatch(/context.*skill check/i);
        const save = await math({ action: 'roll_saving_throw', characterId: 'varek', ability: 'wis', context: ['scent'] });
        expect(save.rolls).toHaveLength(1);
        expect(save.resolverProblems.join(' ')).toMatch(/context.*skill check/i);
    });
});

describe('sense denial on the scene', () => {
    const narrate = (extra: Record<string, unknown>) => scene({ action: 'set', narration: 'Peat smoke hangs over the moor.', participants: ['varek', 'ratling'], ...extra });

    it('a scene-wide denial removes the advantage and quotes the reason', async () => {
        const s = await narrate({ senseDenial: { scent: 'wind from the east carries everything away' } });
        expect(s.success).toBe(true);
        expect(s.scene.senseDenial).toEqual([{ senses: { scent: 'wind from the east carries everything away' } }]);
        const r = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent'] });
        expect(r.rolls).toHaveLength(1);
        expect(r.advantageSources).toBeUndefined();
        expect(r.deniedAdvantage).toEqual([{ trait: 'Keen Smell', when: 'scent', reason: 'wind from the east carries everything away' }]);
        expect(r.breakdown).toContain('⚠ Keen Smell (scent) denied: wind from the east carries everything away');
    });

    it('a per-target denial touches only that target; another tagged sniffer keeps the advantage', async () => {
        mkChar('hound', 'Hound', { skillAdvantage: [KEEN_SMELL] });
        await scene({ action: 'set', narration: 'Peat smoke.', participants: ['varek', 'ratling', 'hound'], senseDenial: { targetId: 'varek', scent: 'buried in peat-smoke' } });
        const varek = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent'] });
        expect(varek.rolls).toHaveLength(1);
        expect(varek.deniedAdvantage[0].reason).toBe('buried in peat-smoke');
        const hound = await math({ action: 'roll_skill_check', characterId: 'hound', skill: 'perception', context: ['scent'] });
        expect(hound.rolls).toHaveLength(2);
    });

    it('a denial set after a roll never touches that roll (rolls are immutable); a later scene without the denial lifts it', async () => {
        const before = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent'] });
        expect(before.rolls).toHaveLength(2);
        await narrate({ senseDenial: { scent: 'the wind turns' } });
        const row = getDb().prepare('SELECT purpose, expression FROM roll_log WHERE id = ?').get(before.rollId) as { purpose: string; expression: string };
        expect(row).toEqual({ purpose: 'perception check (adv: Keen Smell (scent))', expression: '2d20kh1' });
        const during = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent'] });
        expect(during.rolls).toHaveLength(1);
        await narrate({});
        const after = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent'] });
        expect(after.rolls).toHaveLength(2);
    });

    it('set with only senseDenial amends the latest scene: narration and participants are inherited and the reply says so', async () => {
        await narrate({ title: 'The moor at dusk' });
        const s = await scene({ action: 'set', senseDenial: { scent: 'rain' }, wind: 'from W' });
        expect(s.success).toBe(true);
        expect(s.inherited).toEqual(expect.arrayContaining(['narration', 'participants']));
        expect(s.scene.narration).toBe('Peat smoke hangs over the moor.');
        expect(s.scene.participants).toEqual(['varek', 'ratling']);
        expect(s.scene.wind).toBe('from W');
        expect(s.scene.senseDenial).toEqual([{ senses: { scent: 'rain' } }]);
        const none = await scene({ action: 'set', worldId: 'elsewhere-' + Date.now(), senseDenial: { scent: 'x' } });
        expect(none.error).toBe(true);
    });

    it('an amendment keeps what it did not restate: a denial after a wind keeps the wind, a wind after a denial keeps the denial; senseDenial: [] clears it', async () => {
        await narrate({ wind: 'from W' });
        const denied = await scene({ action: 'set', senseDenial: { scent: 'peat-smoke' } });
        expect(denied.scene.wind).toBe('from W');
        expect(denied.inherited).toEqual(expect.arrayContaining(['wind']));
        const turned = await scene({ action: 'set', wind: 'from E' });
        expect(turned.scene.senseDenial).toEqual([{ senses: { scent: 'peat-smoke' } }]);
        expect(turned.scene.wind).toBe('from E');
        expect(turned.inherited).toEqual(expect.arrayContaining(['senseDenial']));
        // The roll sees both: the explicit denial still overrides the wind.
        const r = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent'] });
        expect(r.deniedAdvantage[0].reason).toBe('peat-smoke');
        const cleared = await scene({ action: 'set', senseDenial: [] });
        expect(cleared.scene.senseDenial).toEqual([]);
        expect(cleared.scene.wind).toBe('from E');
        expect(cleared.inherited).not.toEqual(expect.arrayContaining(['senseDenial']));
        const free = await math({ action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent'] });
        expect(free.rolls).toHaveLength(2);
        // A new frame (narration given) does not carry the old wind or denial forward.
        await scene({ action: 'set', senseDenial: { scent: 'rain' } });
        const fresh = await narrate({});
        expect(fresh.scene.senseDenial).toEqual([]);
        expect(fresh.scene.wind).toBeNull();
    });

    it('a denial that names no sense is refused with nothing written, at the outer schema and at the handler', async () => {
        await narrate({});
        const before = (getDb().prepare('SELECT COUNT(*) AS n FROM scenes').get() as { n: number }).n;
        // The outer mirror (what the SDK validates against) refuses by name.
        const outer = SceneManageTool.inputSchema.safeParse({ action: 'set', worldId: W, senseDenial: { targetId: 'varek' } });
        expect(outer.success).toBe(false);
        expect(JSON.stringify(outer.success ? null : outer.error.issues)).toMatch(/names no sense/);
        // The handler's own parse refuses the same way, with writes: 'none'.
        for (const senseDenial of [{ targetId: 'varek' }, ['scent'], [{ scent: 'ok' }, { targetId: 'varek' }]]) {
            const r = json(await handleSceneManage({ action: 'set', worldId: W, senseDenial }, ctx));
            expect(r.error, JSON.stringify(senseDenial)).toBeTruthy();
            expect(JSON.stringify(r)).toMatch(/names no sense/);
            expect(r.writes).toBe('none');
        }
        expect((getDb().prepare('SELECT COUNT(*) AS n FROM scenes').get() as { n: number }).n).toBe(before);
    });
});

describe('wind and positions', () => {
    async function fight(ratlingX: number) {
        const enc = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'varek', name: 'Varek', initiativeBonus: 0, hp: 10, maxHp: 10, position: { x: 5, y: 5 } },
            { id: 'ratling', name: 'Ratling', initiativeBonus: 0, hp: 10, maxHp: 10, isEnemy: true, position: { x: ratlingX, y: 5 } }
        ] }, ctx));
        return enc.encounterId as string;
    }
    const narrate = (extra: Record<string, unknown>) => scene({ action: 'set', narration: 'Wind over the moor.', participants: ['varek', 'ratling'], ...extra });

    it('a west wind carries the scent of a ratling east of Varek away: downwind, no advantage, reason quoted; west of him the scent carries', async () => {
        await narrate({ wind: 'from W' });
        await fight(9);
        const down = await math({ action: 'opposed', characterId: 'ratling', skill: 'stealth', targetId: 'varek', targetSkill: 'perception', targetContext: ['scent'] });
        expect(down.defender.rolls).toHaveLength(1);
        expect(down.defender.deniedAdvantage[0].reason).toBe('Ratling is downwind of Varek (wind from W): the scent is carried away');
        expect(down.wind).toMatchObject({ from: 'W', relation: 'downwind' });
        expect(down.passiveCheck).toMatchObject({ sense: 'scent', denied: 'Ratling is downwind of Varek (wind from W): the scent is carried away' });
        clearCombatState();
        closeDb(); getDb(':memory:');
    });

    it('east wind: the ratling east of Varek is upwind, the scent carries and the advantage stands; an explicit denial overrides the wind', async () => {
        await narrate({ wind: 'from E' });
        await fight(9);
        const up = await math({ action: 'opposed', characterId: 'ratling', skill: 'stealth', targetId: 'varek', targetSkill: 'perception', targetContext: ['scent'] });
        expect(up.defender.rolls).toHaveLength(2);
        expect(up.wind).toMatchObject({ from: 'E', relation: 'upwind' });
        await narrate({ wind: 'from E', senseDenial: { scent: 'peat-smoke everywhere' } });
        const denied = await math({ action: 'opposed', characterId: 'ratling', skill: 'stealth', targetId: 'varek', targetSkill: 'perception', targetContext: ['scent'] });
        expect(denied.defender.rolls).toHaveLength(1);
        expect(denied.defender.deniedAdvantage[0].reason).toBe('peat-smoke everywhere');
    });

    it('without positions the wind is noted but decides nothing', async () => {
        await narrate({ wind: 'from W' });
        const r = await math({ action: 'opposed', characterId: 'ratling', skill: 'stealth', targetId: 'varek', targetSkill: 'perception', targetContext: ['scent'] });
        expect(r.defender.rolls).toHaveLength(2);
        expect(r.wind).toMatchObject({ from: 'W', relation: 'unknown' });
    });
});

describe('passives: the sheet, the status block, and the hide check against him', () => {
    it('get and get_status_block show passive Perception 11 and passive Perception (scent) 16', async () => {
        const sheet = await char({ action: 'get', characterId: 'varek' });
        expect(sheet.passive).toEqual({ perception: 11, senses: [{ when: 'scent', trait: 'Keen Smell', value: 16, label: 'passive Perception (scent) 16' }] });
        const res = await handleCharacterManage({ action: 'get_status_block', characterId: 'varek' }, ctx);
        const data = json(res);
        expect(data.passive).toMatchObject({ perception: 11 });
        const banner = (res.content[0].text as string).split('<!--')[0];
        expect(banner).toMatch(/PASSIVE Perception 11/);
        expect(banner).toMatch(/Perception \(scent\) 16/);
    });

    it('opposed: a sneak the active Perception roll would miss is still caught by the scent passive; the winner says so', async () => {
        // Stealth total is at most 10 (override -10): the active roll may lose, the scent passive 16 never does.
        new CharacterRepository(getDb()).update('ratling', { stealthBonus: -10 } as any);
        const r = await math({ action: 'opposed', characterId: 'ratling', skill: 'stealth', targetId: 'varek', targetSkill: 'perception' });
        expect(r.passiveCheck).toMatchObject({ sense: 'scent', trait: 'Keen Smell', passive: 16, noticed: true });
        expect(r.passiveCheck.vs).toBe(r.initiator.total);
        expect(r.winner).toBe('defender');
        expect(r.decidedBy).toBe('passive Perception (scent) 16');
        expect(r.message).toContain('passive Perception (scent) 16');
    });

    it('opposed: a stealth total above the scent passive is not caught by it; the roll decides', async () => {
        new CharacterRepository(getDb()).update('ratling', { stealthBonus: 25 } as any);
        const r = await math({ action: 'opposed', characterId: 'ratling', skill: 'stealth', targetId: 'varek', targetSkill: 'perception' });
        expect(r.passiveCheck).toMatchObject({ sense: 'scent', passive: 16, noticed: false });
        expect(r.winner).toBe('initiator');
        expect(r.decidedBy).toBeUndefined();
    });

    it('opposed: a denied scent has no passive to compare against', async () => {
        new CharacterRepository(getDb()).update('ratling', { stealthBonus: -10 } as any);
        await scene({ action: 'set', narration: 'Smoke.', participants: ['varek', 'ratling'], senseDenial: { scent: 'peat-smoke' } });
        const r = await math({ action: 'opposed', characterId: 'ratling', skill: 'stealth', targetId: 'varek', targetSkill: 'perception' });
        expect(r.passiveCheck).toEqual({ sense: 'scent', trait: 'Keen Smell', denied: 'peat-smoke' });
        expect(r.decidedBy).toBeUndefined();
    });

    it("roll_skill_check stealth {against} compares the total to the observer's passives: 12 beats passive Perception 10 but not passive (scent) 15", async () => {
        new CharacterRepository(getDb()).update('varek', { stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } } as any);
        const r = await math({ action: 'roll_skill_check', characterId: 'ratling', skill: 'stealth', against: 'varek', seed: seedWithFirstD20(10) });
        expect(r.total).toBe(12);
        expect(r.against).toMatchObject({ observerId: 'varek', observerName: 'Varek', passivePerception: 10, noticed: true, by: 'passive Perception (scent) 15' });
        expect(r.against.passives).toEqual([{ when: 'scent', trait: 'Keen Smell', value: 15, label: 'passive Perception (scent) 15' }]);
        expect(r.message).toContain("noticed by Varek's passive Perception (scent) 15");
        await scene({ action: 'set', narration: 'Smoke.', participants: ['varek', 'ratling'], senseDenial: { scent: 'peat-smoke' } });
        const hidden = await math({ action: 'roll_skill_check', characterId: 'ratling', skill: 'stealth', against: 'varek', seed: seedWithFirstD20(10) });
        expect(hidden.against).toMatchObject({ noticed: false, denied: [{ when: 'scent', reason: 'peat-smoke' }] });
    });
});

describe('montage with a context tag', () => {
    it('a scent-tagged Survival montage rolls twice and keeps the higher, naming the trait; a denial removes it', async () => {
        const r = await improv({ action: 'montage', characterId: 'varek', task: 'follow the ratling trail across the moor', dc: 10, skill: 'survival', context: ['scent'], seed: 'montage-5' });
        expect(r.success).toBe(true);
        expect(r.advantageSources).toEqual(['Keen Smell (scent)']);
        expect(r.advantageRoll).toMatchObject({ kept: r.roll });
        expect(r.advantageRoll.rolls).toHaveLength(2);
        expect(r.roll).toBe(Math.max(...r.advantageRoll.rolls));
        expect(r.breakdown[0]).toContain('2 dice, higher kept');
        await scene({ action: 'set', narration: 'Smoke.', participants: ['varek'], senseDenial: { scent: 'peat-smoke' } });
        const d = await improv({ action: 'montage', characterId: 'varek', task: 'follow the trail', dc: 10, skill: 'survival', context: ['scent'], seed: 'montage-5' });
        expect(d.advantageSources).toBeUndefined();
        expect(d.deniedAdvantage).toEqual([{ trait: 'Keen Smell', when: 'scent', reason: 'peat-smoke' }]);
        expect(d.roll).toBe(3);
    });

    it("with skill and no ability the skill's ability supplies the modifier; a skill the engine cannot map says so instead of rolling +0 in silence", async () => {
        const surv = await improv({ action: 'montage', characterId: 'varek', task: 'track', dc: 10, skill: 'survival', seed: 'montage-6' });
        expect(surv.abilityModifier).toBe(1);
        expect(surv.breakdown).toContain('wis +1');
        expect(surv.warnings).toBeUndefined();
        const unknown = await improv({ action: 'montage', characterId: 'varek', task: 'track', dc: 10, skill: 'tracking', seed: 'montage-6' });
        expect(unknown.abilityModifier).toBe(0);
        expect(unknown.warnings).toHaveLength(1);
        expect(unknown.warnings[0]).toMatch(/skill 'tracking' names no ability/);
        expect(unknown.breakdown.join(' ')).toMatch(/names no ability/);
        // Stealth in stealthDisadvantage armour with a tagged stealth trait: the two cancel to one die.
        await char({ action: 'update', characterId: 'varek', skillAdvantage: [KEEN_SMELL, { name: 'Shadow Step', skills: ['stealth'], when: 'dim' }] });
        const { handleItemManage } = await import('../../src/server/consolidated/item-manage.js');
        const { handleInventoryManage } = await import('../../src/server/consolidated/inventory-manage.js');
        const scale = json(await handleItemManage({ action: 'create', name: 'Scale mail', type: 'armor', weight: 45, value: 50, properties: { baseAC: 14, armorCategory: 'medium', stealthDisadvantage: true } }, ctx)).item.id;
        await handleInventoryManage({ action: 'give', characterId: 'varek', itemId: scale, quantity: 1 }, ctx);
        await handleInventoryManage({ action: 'equip', characterId: 'varek', itemId: scale, slot: 'armor' }, ctx);
        const armoured = await improv({ action: 'montage', characterId: 'varek', task: 'sneak past the camp', dc: 10, skill: 'stealth', seed: 'montage-6' });
        expect(armoured.advantageRoll).toMatchObject({ mode: 'lower kept' });
        expect(armoured.disadvantageSources).toEqual(['Scale mail (stealth disadvantage)']);
        const cancelled = await improv({ action: 'montage', characterId: 'varek', task: 'sneak past the camp', dc: 10, skill: 'stealth', context: ['dim'], seed: 'montage-6' });
        expect(cancelled.advantageRoll).toBeUndefined();
        expect(cancelled.rolls).toHaveLength(1);
        expect(cancelled.advantageSources).toEqual(['Shadow Step (dim)']);
        expect(cancelled.disadvantageSources).toEqual(['Scale mail (stealth disadvantage)']);
    });
});
