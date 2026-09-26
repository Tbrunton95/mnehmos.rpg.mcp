import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

// Item 4: a part can carry its own AC, HP and a break threshold (a collar
// chain, a shield, a plate). Aimed damage lands on the part, not the body.
const W = 'world-40k';
const ctx = { sessionId: 'armour' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manage = async (args: Record<string, unknown>) => (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const part = (id: string, name: string) => tok(id).parts.find((p: any) => p.name === name);

async function setup() {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new CharacterRepository(db).create({ id: 'luciel', name: 'Luciel', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 }, hp: 300, maxHp: 300, ac: 20, level: 15, band: 'Astartes', createdAt: now, updatedAt: now } as any);
    await handleTableRules({ action: 'import', worldId: W, preset: 'day-366' }, ctx as any);
    enc = tag((await handleCombatManage({ action: 'create', worldId: W, participants: [
        { id: 'luciel', name: 'Luciel', hp: 300, maxHp: 300, initiative: 30, band: 'Astartes' },
        { id: 'khorne', name: 'Khornate', hp: 200, maxHp: 200, ac: 18, initiative: 20, isEnemy: true, band: 'Astartes' },
        { id: 'hound', name: 'Flesh Hound', hp: 60, maxHp: 60, initiative: 10, isEnemy: true }
    ] }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
    // Khorne setup from the field report: the collar chain holds the hound.
    await manage({ action: 'set_part', participantId: 'khorne', part: 'collar chain', kind: 'other', state: 'latched', latchedTo: { participantId: 'hound' }, ac: 22, breakAt: 30 });
}

afterEach(() => closeDb());

describe('part armour', () => {
    it('set_part stores ac/hp/maxHp/breakAt and a state change keeps them', async () => {
        await setup();
        expect(part('khorne', 'collar chain')).toMatchObject({ ac: 22, breakAt: 30, state: 'latched' });
        await manage({ action: 'set_part', participantId: 'khorne', part: 'shield', kind: 'arm', state: 'intact', hp: 20 });
        expect(part('khorne', 'shield')).toMatchObject({ hp: 20, maxHp: 20 });
        await manage({ action: 'set_part', participantId: 'khorne', part: 'shield', state: 'breached' });
        expect(part('khorne', 'shield')).toMatchObject({ hp: 20, maxHp: 20, state: 'breached' });
        // Survives a reload from the DB.
        clearCombatState();
        expect(part('khorne', 'collar chain')).toMatchObject({ ac: 22, breakAt: 30 });
    });

    it("aiming at a part with ac uses the part's AC; a dc given still wins", async () => {
        await setup();
        const aimed = await act({ action: 'attack', actorId: 'luciel', targetId: 'khorne', atPart: 'collar chain', attackBonus: 5, damage: 1 });
        expect(aimed.r.roll.targetAc).toBe(22);
        await manage({ action: 'advance' }); await manage({ action: 'advance' }); await manage({ action: 'advance' });
        const body = await act({ action: 'attack', actorId: 'luciel', targetId: 'khorne', attackBonus: 5, damage: 1 });
        expect(body.r.roll.targetAc).toBe(18);
        await manage({ action: 'advance' }); await manage({ action: 'advance' }); await manage({ action: 'advance' });
        const given = await act({ action: 'attack', actorId: 'luciel', targetId: 'khorne', atPart: 'collar chain', attackBonus: 5, damage: 1, dc: 12 });
        expect(given.r.roll.targetAc).toBe(12);
    });

    it('a hit under breakAt leaves the body and the chain whole', async () => {
        await setup();
        const { text, r } = await act({ action: 'attack', actorId: 'luciel', targetId: 'khorne', atPart: 'collar chain', outcome: 'hit', damage: 12 });
        expect(r.partHit).toMatchObject({ name: 'collar chain', damage: 12, broken: false, state: 'latched' });
        expect(r.damage.total).toBe(0);
        expect(tok('khorne').hp).toBe(200);
        expect(part('khorne', 'collar chain').latchedTo).toEqual({ participantId: 'hound' });
        expect(text).toMatch(/collar chain/);
    });

    it('30+ severs the chain and releases what it held and what held it', async () => {
        await setup();
        // The hound's jaws are latched onto the chain too.
        await manage({ action: 'set_part', participantId: 'hound', part: 'jaws', kind: 'head', state: 'latched', latchedTo: { participantId: 'khorne', part: 'collar chain' } });
        const { text, r } = await act({ action: 'attack', actorId: 'luciel', targetId: 'khorne', atPart: 'collar chain', outcome: 'hit', damage: 31 });
        expect(r.partHit).toMatchObject({ name: 'collar chain', damage: 31, broken: true, state: 'dead' });
        expect(tok('khorne').hp).toBe(200);
        const chain = part('khorne', 'collar chain');
        expect(chain.state).toBe('dead');
        expect(chain.latchedTo).toBeUndefined();
        expect(chain.note).toMatch(/severed/);
        expect(part('hound', 'jaws')).toMatchObject({ state: 'intact' });
        expect(part('hound', 'jaws').latchedTo).toBeUndefined();
        expect(text).toMatch(/severed/i);
    });

    it('a part with hp counts down and breaks at 0', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: 'khorne', part: 'shield', kind: 'arm', state: 'intact', hp: 20 });
        const first = await act({ action: 'attack', actorId: 'luciel', targetId: 'khorne', atPart: 'shield', outcome: 'hit', damage: 15 });
        expect(first.r.partHit).toMatchObject({ hpBefore: 20, hpAfter: 5, broken: false, state: 'intact' });
        await manage({ action: 'advance' }); await manage({ action: 'advance' }); await manage({ action: 'advance' });
        const second = await act({ action: 'attack', actorId: 'luciel', targetId: 'khorne', atPart: 'shield', outcome: 'hit', damage: 10 });
        expect(second.r.partHit).toMatchObject({ hpBefore: 5, hpAfter: 0, broken: true, state: 'dead' });
        expect(tok('khorne').hp).toBe(200);
    });

    it('a part hit writes no HP to the sheet and raises no CONSEQUENCE DUE, even on a peer crit', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: 'luciel', part: 'pauldron', kind: 'torso', state: 'intact', hp: 40 });
        await manage({ action: 'advance' });
        const { text, r } = await act({ action: 'attack', actorId: 'khorne', targetId: 'luciel', atPart: 'pauldron', outcome: 'crit', damage: 25 });
        expect(r.partHit).toMatchObject({ hpAfter: 15 });
        expect(r.consequenceDue).toBeUndefined();
        expect(text).not.toMatch(/CONSEQUENCE DUE/);
        expect(new CharacterRepository(getDb()).findById('luciel')!.hp).toBe(300);
        expect(tok('luciel').hp).toBe(300);
    });

    it('a called strike on an armoured part keeps its ac and breakAt', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: 'khorne', part: 'left arm', kind: 'arm', state: 'intact', ac: 20 });
        await act({ action: 'attack', actorId: 'luciel', targetId: 'khorne', calledStrike: 'arm', atPart: 'left arm', outcome: 'hit', damage: 5 });
        expect(part('khorne', 'left arm')).toMatchObject({ state: 'crippled', ac: 20 });
    });

    it('the render shows part ac and hp even when intact', async () => {
        await setup();
        await manage({ action: 'set_part', participantId: 'khorne', part: 'shield', kind: 'arm', state: 'intact', hp: 20, ac: 19 });
        const text = await manage({ action: 'get' });
        expect(text).toMatch(/shield: intact AC 19 20\/20 HP/);
        expect(text).toMatch(/collar chain: latched.*AC 22.*breaks at 30/);
    });
});
