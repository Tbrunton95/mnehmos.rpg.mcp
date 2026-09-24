import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const W = 'world-40k';
const ctx = { sessionId: 'rules-attacks' };
const tagJson = (text: string, tag: string) => {
    const m = text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : null;
};

let encounterId: string;

async function setup(bands: { luciel?: string; karanak?: string; scion?: string }, rules = true) {
    closeDb();
    const db = getDb(':memory:');
    clearCombatState();
    const repo = new CharacterRepository(db);
    const now = new Date().toISOString();
    const mk = (id: string, name: string, hp: number, band?: string) => repo.create({ id, name, stats: { str: 20, dex: 14, con: 20, int: 10, wis: 10, cha: 10 }, hp, maxHp: hp, ac: 15, level: 10, band, createdAt: now, updatedAt: now } as any);
    mk('luciel', 'Luciel', 200, bands.luciel);
    mk('karanak', 'Karanak', 160, bands.karanak);
    mk('scion', 'Scion', 12, bands.scion);
    if (rules) await handleTableRules({ action: 'import', worldId: W, preset: 'day-366' }, ctx as any);
    const created = tagJson((await handleCombatManage({ action: 'create', worldId: W, participants: [
        { id: 'luciel', name: 'Luciel', hp: 200, maxHp: 200, initiative: 20 },
        { id: 'karanak', name: 'Karanak', hp: 160, maxHp: 160, initiative: 10, isEnemy: true },
        { id: 'scion', name: 'Scion', hp: 12, maxHp: 12, initiative: 5, isEnemy: true }
    ] }, ctx as any)).content[0].text, 'COMBAT_MANAGE');
    encounterId = created.encounterId;
}

async function attack(args: Record<string, unknown>) {
    const text = (await handleCombatAction({ action: 'attack', encounterId, actorId: 'luciel', targetId: 'karanak', ...args }, ctx as any)).content[0].text;
    const data = tagJson(text, 'COMBAT_ACTION');
    return { text, data, result: data?.actionResult ?? data?.result ?? data };
}

function token(id: string) {
    return new EncounterRepository(getDb()).loadState(encounterId)!.participants.find(p => p.id === id)! as any;
}

afterEach(() => closeDb());

describe('peer consequence', () => {
    it('a posted crit on a peer flags a consequence for the GM to name', async () => {
        await setup({ luciel: 'Astartes', karanak: 'Astartes' });
        const { text } = await attack({ outcome: 'crit', damage: 10 });
        expect(text).toMatch(/CONSEQUENCE DUE \(peer-consequence\): critical hit/);
        expect(text).toMatch(/crippled joint \/ breached plate \/ thrown out of position/);
    });

    it('a hit of 25% max HP on a peer flags one', async () => {
        await setup({ luciel: 'Astartes', karanak: 'Monster/Lord' });
        const { text } = await attack({ outcome: 'hit', damage: 40 });
        expect(text).toMatch(/CONSEQUENCE DUE .*40 damage ≥ 25% of max HP \(40\)/);
    });

    it('a smaller hit, or a hit on a lower band, flags nothing', async () => {
        await setup({ luciel: 'Astartes', karanak: 'Astartes', scion: 'Elite Mortal' });
        expect((await attack({ outcome: 'hit', damage: 39 })).text).not.toMatch(/CONSEQUENCE DUE/);
        getOrLoadEngine(ctx as any, encounterId)!.getState()!.participants.find(p => p.id === 'luciel')!.actionUsed = false;
        expect((await attack({ targetId: 'scion', outcome: 'crit', damage: 12 })).text).not.toMatch(/CONSEQUENCE DUE/);
    });

    it("under direction 'both' (the day-366 preset) a higher band maims a lower one", async () => {
        await setup({ luciel: 'Monster/Lord', karanak: 'Astartes Elite' });
        const { text, data } = await attack({ outcome: 'hit', damage: 40 });
        expect(text).toMatch(/CONSEQUENCE DUE \(peer-consequence, from above\): 40 damage/);
        expect(JSON.stringify(data)).toMatch(/"direction":"down"/);
    });

    it("direction 'up' keeps a higher band's hits unflagged", async () => {
        await setup({ luciel: 'Monster/Lord', karanak: 'Astartes Elite' });
        await handleTableRules({ action: 'define', worldId: W, kind: 'peer_consequence', name: 'peer-consequence', spec: { direction: 'up' } }, ctx as any);
        expect((await attack({ outcome: 'crit', damage: 40 })).text).not.toMatch(/CONSEQUENCE DUE/);
    });

    it('a hit that kills flags nothing, either way', async () => {
        await setup({ luciel: 'Astartes', karanak: 'Astartes' });
        expect((await attack({ outcome: 'crit', damage: 160 })).text).not.toMatch(/CONSEQUENCE DUE/);
    });

    it('says so when a band is unset, and does nothing without rules', async () => {
        await setup({ luciel: 'Astartes' });
        expect((await attack({ outcome: 'crit', damage: 10 })).text).toMatch(/RULE skipped: .*band unset for Karanak/);
        await setup({ luciel: 'Astartes', karanak: 'Astartes' }, false);
        expect((await attack({ outcome: 'crit', damage: 10 })).text).not.toMatch(/RULE|CONSEQUENCE/);
    });
});

describe('called strikes (Measure of a Body)', () => {
    it('a hit at the leg cripples it: half speed from the next turn, on token and sheet', async () => {
        await setup({ luciel: 'Astartes', karanak: 'Astartes' });
        const { text } = await attack({ outcome: 'hit', damage: 5, calledStrike: 'leg' });
        expect(text).toMatch(/RULE measure-of-a-body: Karanak's leg crippled until repaired/);
        // A called-strike hit cripples without the 25% threshold.
        expect(text).not.toMatch(/CONSEQUENCE DUE/);
        expect(token('karanak').parts).toEqual([expect.objectContaining({ name: 'leg', kind: 'leg', state: 'crippled' })]);
        expect(new CharacterRepository(getDb()).findById('karanak')!.parts).toEqual([expect.objectContaining({ name: 'leg', state: 'crippled' })]);
        await handleCombatManage({ action: 'advance', encounterId }, ctx as any);
        expect(token('karanak').movementRemaining).toBe(15);
    });

    it('a crippled arm puts its attacks at disadvantage unless the good arm attacks', async () => {
        await setup({ luciel: 'Astartes', karanak: 'Astartes' });
        await attack({ outcome: 'hit', damage: 5, calledStrike: 'arm' });
        await handleCombatManage({ action: 'advance', encounterId }, ctx as any);
        const hampered = await attack({ actorId: 'karanak', targetId: 'luciel', attackBonus: 5, damage: 1 });
        expect(hampered.result.roll.allRolls).toHaveLength(2);
        getOrLoadEngine(ctx as any, encounterId)!.getState()!.participants.find(p => p.id === 'karanak')!.actionUsed = false;
        const goodArm = await attack({ actorId: 'karanak', targetId: 'luciel', attackBonus: 5, damage: 1, unaffectedLimb: true });
        expect(goodArm.result.roll.allRolls).toHaveLength(1);
    });

    it('is refused against a lower band and spends nothing', async () => {
        await setup({ luciel: 'Astartes', karanak: 'Astartes', scion: 'Mortal' });
        const { text } = await attack({ targetId: 'scion', outcome: 'hit', damage: 5, calledStrike: 'leg' });
        expect(text).toMatch(/below Luciel/);
        expect(token('luciel').actionUsed).toBeFalsy();
    });

    it('a miss cripples nothing', async () => {
        await setup({ luciel: 'Astartes', karanak: 'Astartes' });
        const { text } = await attack({ outcome: 'miss', calledStrike: 'leg' });
        expect(text).toMatch(/called strike at the leg missed/);
        expect(token('karanak').parts ?? []).toHaveLength(0);
    });
});

describe('prepared anti-armour', () => {
    const tier = async (args: Record<string, unknown>) => (await attack({ preparedAsset: 'prepared-anti-armour', ...args })).result.preparedEffectDue;

    it('a miss still lands: the GM names breach, displacement or cover', async () => {
        await setup({});
        const t = await tier({ outcome: 'miss' });
        expect(t.tier).toBe('miss');
        expect(t.effectDue).toEqual(['breach', 'displacement', 'forced into cover']);
    });

    it('a hit adds a crippled system; a posted crit is catastrophic', async () => {
        await setup({});
        expect((await tier({ outcome: 'hit', damage: 20 })).effectDue).toEqual(['crippled system']);
        getOrLoadEngine(ctx as any, encounterId)!.getState()!.participants.find(p => p.id === 'luciel')!.actionUsed = false;
        expect((await tier({ outcome: 'crit', damage: 20 })).tier).toBe('catastrophic');
    });

    it('a rolled hit by 10 or more is catastrophic', async () => {
        await setup({});
        // +40 against AC 15: every non-1 lands at least 10 over.
        const t = await tier({ attackBonus: 40, damage: 1 });
        if (t.tier !== 'miss') expect(t.tier).toBe('catastrophic');
    });

    it('an unknown asset rule is refused', async () => {
        await setup({});
        expect((await attack({ preparedAsset: 'lascannon', outcome: 'hit', damage: 1 })).text).toMatch(/No enabled prepared_asset rule named 'lascannon'/);
    });
});
