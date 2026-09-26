import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const ctx = { sessionId: 'attack-profiles' };
const tag = (text: string, t: string) => { const m = text.match(new RegExp(`<!-- ${t}_JSON\\n([\\s\\S]*?)\\n${t}_JSON -->`)); return m ? JSON.parse(m[1]) : null; };
let enc: string;

const manage = async (args: Record<string, unknown>) => (await handleCombatManage({ encounterId: enc, ...args }, ctx as any)).content[0].text;
const act = async (args: Record<string, unknown>) => {
    const text = (await handleCombatAction({ action: 'attack', encounterId: enc, ...args }, ctx as any)).content[0].text;
    const d = tag(text, 'COMBAT_ACTION');
    return { text, r: d?.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const freshAction = (id: string) => { getOrLoadEngine(ctx as any, enc)!.getState()!.participants.find(p => p.id === id)!.actionUsed = false; };

const lucielAttacks = [
    { name: 'grown blade', attackBonus: 13, damage: '2d10+7', damageType: 'slashing', default: true },
    { name: 'bolt pistol', attackBonus: 9, damage: '1d10+2', damageType: 'piercing', ranged: true }
];

async function setup(opts: { lucielAttacks?: any[] } = {}) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const now = new Date().toISOString();
    new CharacterRepository(db).create({ id: 'luciel', name: 'Luciel', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 }, hp: 300, maxHp: 300, ac: 20, level: 15,
        attacks: opts.lucielAttacks ?? lucielAttacks, createdAt: now, updatedAt: now } as any);
    enc = tag((await handleCombatManage({ action: 'create', participants: [
        { id: 'luciel', name: 'Luciel', hp: 300, maxHp: 300, initiative: 30 },
        { id: 'karanak', name: 'Karanak', hp: 200, maxHp: 200, initiative: 20, isEnemy: true, ac: 5,
            parts: [{ name: 'left arm', kind: 'arm' }, { name: 'right arm', kind: 'arm' }],
            attacks: [
                { name: 'axe', attackBonus: 12, damage: '2d8+6', damageType: 'slashing', part: 'right arm' },
                { name: 'whip', attackBonus: 10, damage: '1d8+4', part: 'left arm' }
            ] }
    ] }, ctx as any)).content[0].text, 'COMBAT_MANAGE').encounterId;
}

afterEach(() => closeDb());

describe('named attack profiles', () => {
    it('the sheet profiles ride onto the token', async () => {
        await setup();
        expect(tok('luciel').attacks.map((a: any) => a.name)).toEqual(['grown blade', 'bolt pistol']);
    });

    it('using fills attack bonus, damage and damage type, and echoes the profile', async () => {
        await setup();
        const { text, r } = await act({ actorId: 'luciel', targetId: 'karanak', using: 'grown blade' });
        expect(r.roll.bonus).toBe(13);
        expect(r.attackProfile).toMatchObject({ name: 'grown blade', attackBonus: 13, damage: '2d10+7', damageType: 'slashing' });
        expect(text).toMatch(/grown blade \(\+13, 2d10\+7 slashing\)/);
        if (r.roll.hit) expect(r.damage.type).toBe('slashing');
    });

    it('a unique prefix picks the profile; weapon is an alias of using', async () => {
        await setup();
        expect((await act({ actorId: 'luciel', targetId: 'karanak', weapon: 'bolt' })).r.roll.bonus).toBe(9);
    });

    it('explicit params override the profile', async () => {
        await setup();
        const { r } = await act({ actorId: 'luciel', targetId: 'karanak', using: 'grown blade', attackBonus: 3, damage: 1, damageType: 'fire' });
        expect(r.roll.bonus).toBe(3);
        if (r.roll.hit) expect(r.damage).toMatchObject({ total: expect.any(Number), type: 'fire' });
    });

    it('an unknown profile is refused, listing the profiles, and spends nothing', async () => {
        await setup();
        const { text } = await act({ actorId: 'luciel', targetId: 'karanak', using: 'chainsword' });
        expect(text).toMatch(/No attack profile 'chainsword' \(profiles: grown blade, bolt pistol\)/);
        expect(tok('luciel').actionUsed).toBeFalsy();
    });

    it('an outcome with a dice profile rolls the profile damage', async () => {
        await setup();
        const { r } = await act({ actorId: 'luciel', targetId: 'karanak', using: 'bolt pistol', outcome: 'hit' });
        expect(r.damage.total).toBeGreaterThanOrEqual(3);
        expect(r.damage.total).toBeLessThanOrEqual(12);
        expect(r.damage.type).toBe('piercing');
    });

    it('with nothing named, the default profile replaces the STR/DEX guess', async () => {
        await setup();
        // The guess would be +7 STR +5 proficiency = +12.
        expect((await act({ actorId: 'luciel', targetId: 'karanak' })).r.roll.bonus).toBe(13);
    });

    it('a sole profile is the default even unflagged', async () => {
        await setup({ lucielAttacks: [{ name: 'fists', attackBonus: 4, damage: 3 }] });
        expect((await act({ actorId: 'luciel', targetId: 'karanak' })).r.roll.bonus).toBe(4);
    });

    it('withPart naming a profile on a creature with no such part is read as using', async () => {
        await setup();
        expect((await act({ actorId: 'luciel', targetId: 'karanak', withPart: 'bolt pistol' })).r.roll.bonus).toBe(9);
    });

    it("the profile's part carries its state: the crippled axe arm is at disadvantage, the whip arm is not", async () => {
        await setup();
        await manage({ action: 'set_part', participantId: 'karanak', part: 'right arm', state: 'crippled' });
        await manage({ action: 'advance' });
        const axe = await act({ actorId: 'karanak', targetId: 'luciel', using: 'axe' });
        expect(axe.r.roll.allRolls).toHaveLength(2);
        expect(axe.r.roll.bonus).toBe(12);
        freshAction('karanak');
        const whip = await act({ actorId: 'karanak', targetId: 'luciel', using: 'whip' });
        expect(whip.r.roll.allRolls).toHaveLength(1);
        expect(whip.r.roll.bonus).toBe(10);
    });

    it('an unknown withPart lists the parts and the named attacks', async () => {
        await setup();
        await manage({ action: 'advance' });
        const { text } = await act({ actorId: 'karanak', targetId: 'luciel', withPart: 'tail', attackBonus: 5, damage: 1 });
        expect(text).toMatch(/has no part 'tail' \(parts: left arm, right arm\); named attacks: axe, whip \(pass using\)/);
    });

    it('the state view lists the attack names', async () => {
        await setup();
        const text = await manage({ action: 'get' });
        expect(text).toMatch(/attacks: axe \+12, whip \+10/);
    });
});
