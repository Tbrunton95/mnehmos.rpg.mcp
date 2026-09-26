import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { volleyTier } from '../../src/engine/combat/units.js';

const W = 'world-40k';
const ctx = { sessionId: 'p3' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manage = async (args: Record<string, unknown>) => (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const freshAction = (id: string) => { getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === id)!.actionUsed = false; };

async function setup(extra: any[] = []) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new CharacterRepository(db).create({ id: 'luciel', name: 'Luciel', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 }, hp: 300, maxHp: 300, ac: 20, level: 15, band: 'Astartes', createdAt: now, updatedAt: now } as any);
    await handleTableRules({ action: 'import', worldId: W, preset: 'day-366' }, ctx as any);
    enc = tag((await handleCombatManage({ action: 'create', worldId: W, participants: [
        { id: 'luciel', name: 'Luciel', hp: 300, maxHp: 300, initiative: 30 },
        { id: 'karanak', name: 'Karanak', hp: 200, maxHp: 200, initiative: 20, isEnemy: true, band: 'Monster/Lord',
            parts: [{ name: 'left head', kind: 'head' }, { name: 'middle head', kind: 'head' }, { name: 'right head', kind: 'head' }] },
        ...extra
    ] }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
}

afterEach(() => closeDb());

describe('parts', () => {
    it('a latched head holds: it cannot attack, the held cannot move, and the held attacks it at advantage', async () => {
        await setup();
        const set = await manage({ action: 'set_part', participantId: 'karanak', part: 'middle head', state: 'latched', latchedTo: { participantId: 'luciel', part: 'forearm' } });
        expect(set).toMatch(/middle head intact → latched → luciel forearm/);
        // Luciel is held: speed 0 from his next turn.
        await manage({ action: 'advance' }); await manage({ action: 'advance' });
        expect(tok('luciel').movementRemaining).toBe(0);
        // Luciel attacks Karanak with advantage.
        const hit = await act({ action: 'attack', actorId: 'luciel', targetId: 'karanak', attackBonus: 5, damage: 1 });
        expect(hit.r.roll.allRolls).toHaveLength(2);
        expect(hit.text).toMatch(/latched onto Luciel \(advantage\)/);
        // The latched head is refused and nothing is spent.
        await manage({ action: 'advance' });
        const bite = await act({ action: 'attack', actorId: 'karanak', targetId: 'luciel', withPart: 'middle head', attackBonus: 5, damage: 10 });
        expect(bite.text).toMatch(/latched and cannot attack while it holds/);
        expect(tok('karanak').actionUsed).toBeFalsy();
        // The other heads still bite.
        const other = await act({ action: 'attack', actorId: 'karanak', targetId: 'luciel', withPart: 'left head', attackBonus: 5, damage: 1 });
        expect(other.r.roll.allRolls).toHaveLength(1);
    });

    it('a dead part cannot act; a crippled part attacks at disadvantage; a breached part is hit at advantage', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: 'karanak', part: 'right head', state: 'dead' });
        await manage({ action: 'set_part', participantId: 'karanak', part: 'left head', state: 'crippled', note: 'broken jaw' });
        await manage({ action: 'set_part', participantId: 'karanak', part: 'chest plate', state: 'breached', kind: 'torso' });
        const breached = await act({ action: 'attack', actorId: 'luciel', targetId: 'karanak', atPart: 'chest plate', attackBonus: 5, damage: 1 });
        expect(breached.r.roll.allRolls).toHaveLength(2);
        await manage({ action: 'advance' });
        expect((await act({ action: 'attack', actorId: 'karanak', targetId: 'luciel', withPart: 'right head', attackBonus: 5, damage: 1 })).text).toMatch(/right head is dead and cannot attack/);
        const jaw = await act({ action: 'attack', actorId: 'karanak', targetId: 'luciel', withPart: 'left head', attackBonus: 5, damage: 1 });
        expect(jaw.r.roll.allRolls).toHaveLength(2);
        expect(jaw.text).toMatch(/left head crippled \(disadvantage\)/);
    });

    it('a crippled wing halves speed; the render lists the hurt parts; mirroring writes the sheet', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: 'luciel', part: 'left wing', kind: 'wing', state: 'crippled', mirrorToCharacter: true });
        expect(new CharacterRepository(getDb()).findById('luciel')!.parts).toEqual([expect.objectContaining({ name: 'left wing', state: 'crippled' })]);
        await manage({ action: 'advance' }); await manage({ action: 'advance' });
        expect(tok('luciel').movementRemaining).toBe(15);
        expect(await manage({ action: 'get' })).toMatch(/🦴 left wing: crippled/);
        await manage({ action: 'remove_part', participantId: 'luciel', part: 'left wing', mirrorToCharacter: true });
        expect(new CharacterRepository(getDb()).findById('luciel')!.parts ?? []).toHaveLength(0);
    });

    it('CONSEQUENCE DUE suggests the set_part call for the part aimed at', async () => {
        await setup();
        const { text } = await act({ action: 'attack', actorId: 'luciel', targetId: 'karanak', atPart: 'middle head', outcome: 'crit', damage: 10 });
        expect(text).toMatch(/set_part .*part: 'middle head'/);
    });
});

describe('called strikes on parts, and the arm that swings', () => {
    it('a called strike on a latched head keeps its hold and kind', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: 'karanak', part: 'middle head', state: 'latched', latchedTo: { participantId: 'luciel', part: 'forearm' } });
        const { text } = await act({ action: 'attack', actorId: 'luciel', targetId: 'karanak', calledStrike: 'middle head', outcome: 'hit', damage: 5 });
        expect(text).toMatch(/Karanak's middle head crippled/);
        const head = tok('karanak').parts.find((p: any) => p.name === 'middle head');
        expect(head).toMatchObject({ kind: 'head', state: 'crippled', latchedTo: { participantId: 'luciel', part: 'forearm' } });
    });

    it('set_part records what a part holds, and keeps it across a state change', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: 'karanak', part: 'left arm', kind: 'arm', state: 'intact', holds: ['whip'] });
        await manage({ action: 'set_part', participantId: 'karanak', part: 'left arm', state: 'crippled' });
        expect(tok('karanak').parts.find((p: any) => p.name === 'left arm')).toMatchObject({ kind: 'arm', state: 'crippled', holds: ['whip'] });
    });

    it('the crippled-arm penalty follows the weapon: the whip arm is fine, the axe arm is not', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: 'karanak', part: 'left arm', kind: 'arm', state: 'intact', holds: ['whip'] });
        await manage({ action: 'set_part', participantId: 'karanak', part: 'right arm', kind: 'arm', state: 'crippled', holds: ['axe'] });
        await manage({ action: 'advance' });
        const whip = await act({ action: 'attack', actorId: 'karanak', targetId: 'luciel', weapon: 'whip', attackBonus: 5, damage: 1 });
        expect(whip.r.roll.allRolls).toHaveLength(1);
        freshAction('karanak');
        const axe = await act({ action: 'attack', actorId: 'karanak', targetId: 'luciel', weapon: 'axe', attackBonus: 5, damage: 1 });
        expect(axe.r.roll.allRolls).toHaveLength(2);
        expect(axe.text).toMatch(/right arm crippled \(disadvantage\)/);
        // Nothing named: an intact arm exists, so no blanket penalty; a note says which arm was assumed.
        freshAction('karanak');
        const bare = await act({ action: 'attack', actorId: 'karanak', targetId: 'luciel', attackBonus: 5, damage: 1 });
        expect(bare.r.roll.allRolls).toHaveLength(1);
        expect(bare.text).toMatch(/assumed left arm/);
    });
});

describe('unit tokens', () => {
    const scions = { id: 'scions', name: 'Scions', hp: 50, maxHp: 50, initiative: 25, isEnemy: true, band: 'Elite Mortal',
        unit: { models: 10, hpPerModel: 5, packed: true, attackBonus: 6 } };

    it('the tier follows casualties and each state drops it one step', () => {
        const p: any = { hp: 50, unit: { models: 10, hpPerModel: 5, packed: true, attackBonus: 0 } };
        expect(volleyTier(p)!.dice).toBe('4d6');
        p.hp = 35; expect(volleyTier(p)!.dice).toBe('3d6');
        p.unit.suppressed = true; expect(volleyTier(p)!.dice).toBe('2d6');
        p.unit.inMelee = true; p.unit.brokenFormation = true; expect(volleyTier(p)!.dice).toBe('1d6');
        p.hp = 0; expect(volleyTier(p)!.dice).toBeNull();
    });

    it('a volley rolls one d20 against AC and the tier dice, and names the tier', async () => {
        await setup([scions]);
        const v = await act({ action: 'volley', actorId: 'scions', targetId: 'luciel', outcome: 'hit' });
        expect(v.text).toMatch(/VOLLEY 4d6 \(10\/10 models\)/);
        await manage({ action: 'set_unit', participantId: 'scions', suppressed: true });
        freshAction('scions');
        expect((await act({ action: 'volley', actorId: 'scions', targetId: 'luciel', outcome: 'hit' })).text).toMatch(/VOLLEY 3d6 \(10\/10 models, suppressed −1\)/);
    });

    it('one blow kills one model; cleave on a packed lower band goes through and moves the tier at once', async () => {
        await setup([scions]);
        const one = await act({ action: 'attack', actorId: 'luciel', targetId: 'scions', outcome: 'hit', damage: 30 });
        expect(one.text).toMatch(/one model at most: 30 → 5/);
        expect(tok('scions').hp).toBe(45);
        freshAction('luciel');
        const cleave = await act({ action: 'attack', actorId: 'luciel', targetId: 'scions', outcome: 'hit', damage: 25, cleave: true });
        expect(tok('scions').hp).toBe(20);
        // 4 of 10 standing is under half: the tier drops to 2d6 at once.
        expect(cleave.text).toMatch(/UNIT Scions: ×4\/10 packed · volley 2d6/);
    });

    it('cleave is refused on spaced units and peers; called strikes are refused on units', async () => {
        await setup([{ ...scions, unit: { ...scions.unit, packed: false } }]);
        expect((await act({ action: 'attack', actorId: 'luciel', targetId: 'scions', outcome: 'hit', damage: 20, cleave: true })).text).toMatch(/spacing prevents cleave/);
        expect((await act({ action: 'attack', actorId: 'luciel', targetId: 'scions', outcome: 'hit', damage: 5, calledStrike: 'leg' })).text).toMatch(/single opponent; Scions is a unit/);
        await setup([{ ...scions, band: 'Astartes' }]);
        expect((await act({ action: 'attack', actorId: 'luciel', targetId: 'scions', outcome: 'hit', damage: 20, cleave: true })).text).toMatch(/Never cleave peers/);
    });
});

describe('intent and readied actions', () => {
    it('intent shows, then clears when that creature\'s turn ends; readied stays until triggered', async () => {
        await setup();
        await manage({ action: 'set_intent', participantId: 'karanak', intent: 'charges the wing, then breaks the relay', readied: { action: 'melta the lane', trigger: 'Knight D crosses the open cross' } });
        expect(await manage({ action: 'get' })).toMatch(/⚑ intent: charges the wing/);
        await manage({ action: 'advance' }); // Luciel -> Karanak
        expect(tok('karanak').intent).toBe('charges the wing, then breaks the relay');
        await manage({ action: 'advance' }); // Karanak's turn ends
        expect(tok('karanak').intent).toBeUndefined();
        expect(tok('karanak').readied).toMatchObject({ action: 'melta the lane' });
        const fired = await manage({ action: 'trigger_readied', participantId: 'karanak' });
        expect(fired).toMatch(/melta the lane fires/);
        expect(tok('karanak').readied).toBeUndefined();
    });
});
