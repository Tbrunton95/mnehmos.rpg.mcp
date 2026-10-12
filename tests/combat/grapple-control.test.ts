import { CombatEngine } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const ctx = { sessionId: 'grapple-control' };
const embedded = (res: any, tag: string) => {
    const m = res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`));
    return m ? JSON.parse(m[1]) : { rawText: res.content[0].text };
};
const manage = async (args: Record<string, unknown>) => embedded(await handleCombatManage(args, ctx as any), 'COMBAT_MANAGE');
const act = async (args: Record<string, unknown>) => embedded(await handleCombatAction(args, ctx as any), 'COMBAT_ACTION');

/** Queue the next engine d20s (actor first, then defender). */
const dice = (...values: number[]) => {
    const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
    for (const v of values) spy.mockReturnValueOnce(v);
    return spy;
};

/**
 * Item 5: grapple in one call on the fight's dice. Tokens without sheets can
 * grapple, band and size set disadvantage by themselves, size limits who can
 * be held or thrown, control: true pins instead of hurting, execute finishes
 * a pinned lower-band foe, and break escapes one holder.
 */
describe('one-call grapple', () => {
    let encounterId: string;
    const tokens = () => new EncounterRepository(getDb()).loadState(encounterId)!.participants as any[];
    const tok = (id: string) => tokens().find(t => t.id === id);

    const fight = async (participants: Array<Record<string, unknown>>) => {
        const created = await manage({ action: 'create', seed: 'grapple-control', participants });
        encounterId = created.encounterId;
    };

    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('tokens without character rows grapple on engine dice and spend the attack', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20 },
            { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ]);
        const spy = dice(18, 4);
        const res = await act({ action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(res.hit).toBe(true);
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'grapple', forId: 'marine', targetId: 'cultist' }));
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'grapple', forId: 'cultist', targetId: 'marine' }));
        expect(tok('cultist').conditions.map((c: any) => c.type).sort()).toEqual(['grappled', 'prone']);
        expect(tok('cultist').conditions[0].sourceId).toBe('grapple: marine');
        expect(tok('marine').actionUsed).toBe(true);
        // The attack is spent: a second grapple this turn is refused and writes nothing.
        const again = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(again.error).toBeTruthy();
        expect(String(again.message ?? again.rawText)).toMatch(/already used/i);
    });

    it('grapple {actionSurge: true} reopens a spent action from a grantsAction ability and reports the spend', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, abilities: [{ name: 'Action Surge', grantsAction: true }] },
            { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ]);
        dice(18, 4);
        expect((await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' })).hit).toBe(true);
        // The action is spent; without the surge the second move is refused and the surge stays ready.
        const plain = await act({ action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(plain.error).toBeTruthy();
        expect(tok('marine').abilities[0].ready).toBe(true);
        dice(18, 4);
        const surged = await act({ action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist', actionSurge: true });
        expect(surged.error).toBeFalsy();
        expect(surged.hit).toBe(true);
        expect(surged.actionSurge).toMatchObject({ spent: true, ability: 'Action Surge', source: 'token' });
        expect(surged.actionSpent).toBe('action');
        expect(String(surged.message)).toMatch(/^⚡ Action Surge spent — /);
        expect(tok('marine').abilities[0].ready).toBe(false);
        expect(tok('marine').extraActions).toBe(0);
        // Clinched is a custom condition kept verbatim; the takedown adds the standard two.
        expect(tok('cultist').conditions.map((c: any) => c.type).sort()).toEqual(['Clinched', 'grappled', 'prone']);
        // Spent now: a third move with the flag is refused, writes nothing.
        const third = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', actionSurge: true });
        expect(third.error).toBeTruthy();
        expect(third.writes).toBe('none');
        expect(String(third.message)).toMatch(/Action Surge is spent/);
    });

    it('a lost grapple still spends the attack and saves the dice position', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20 },
            { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ]);
        const before = JSON.stringify((new EncounterRepository(getDb()).loadState(encounterId) as any).rngState);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(tok('marine').actionUsed).toBe(true);
        expect(JSON.stringify((new EncounterRepository(getDb()).loadState(encounterId) as any).rngState)).not.toBe(before);
    });

    it('the lower band rolls at disadvantage, once, with the reason printed', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, band: 'Astartes' },
            { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true, band: 'Mortal', size: 'small' }
        ]);
        dice(5, 20, 3);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.rolls.defender).toEqual([20, 3]);
        expect(res.rolls.actor).toEqual([5]);
        expect(res.situational).toHaveLength(1);
        expect(res.situational[0]).toMatch(/Cultist.*disadvantage.*lower band.*smaller/);
    });

    it('a smaller escaper breaks at disadvantage', async () => {
        await fight([
            { id: 'imp', name: 'Imp', hp: 10, maxHp: 10, initiative: 20, size: 'small', conditions: [{ name: 'grappled', source: 'grapple: ogre' }] },
            { id: 'ogre', name: 'Ogre', hp: 60, maxHp: 60, initiative: 5, isEnemy: true, size: 'large' }
        ]);
        dice(15, 2, 1);
        const res = await act({ action: 'grapple', move: 'break', encounterId, actorId: 'imp', targetId: 'ogre' });
        expect(res.rolls.actor).toEqual([15, 2]);
        expect(res.situational[0]).toMatch(/Imp.*smaller/);
    });

    it('refuses a target more than one size larger, and a throw of anything larger', async () => {
        await fight([
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20 },
            { id: 'giant', name: 'Giant', hp: 100, maxHp: 100, initiative: 5, isEnemy: true, size: 'huge' },
            { id: 'ogre', name: 'Ogre', hp: 60, maxHp: 60, initiative: 4, isEnemy: true, size: 'large' }
        ]);
        const huge = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'hero', targetId: 'giant' });
        expect(huge.error).toBeTruthy();
        expect(String(huge.message ?? huge.rawText)).toMatch(/huge.*medium|too large|more than one size/i);
        const thrown = await act({ action: 'grapple', move: 'throw', encounterId, actorId: 'hero', targetId: 'ogre' });
        expect(thrown.error).toBeTruthy();
        expect(tok('hero').actionUsed).toBeFalsy();
        // One size up is a legal grapple (the smaller hero rolls at disadvantage).
        dice(20, 20, 1);
        expect((await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'hero', targetId: 'ogre' })).hit).toBe(true);
    });

    it('control: true pins (Grappled + Restrained) with no surface damage', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20 },
            { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ]);
        dice(20, 1);
        const res = await act({ action: 'grapple', move: 'slam', control: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.controlled).toBe(true);
        expect(res.surfaceDamage).toBeUndefined();
        expect(tok('cultist').conditions.map((c: any) => c.type)).toEqual(expect.arrayContaining(['grappled', 'restrained']));
        expect(tok('cultist').hp).toBe(10);
    });

    it('throw without control rolls surface damage on the fight dice', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20 },
            { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ]);
        dice(20, 1);
        const surface = vi.spyOn(CombatEngine.prototype, 'rollDice');
        const res = await act({ action: 'grapple', move: 'throw', surface: 'concrete', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.surfaceDamage).toBeGreaterThanOrEqual(1);
        expect(res.damageDetail).toMatch(/d6/);
        expect(surface).toHaveBeenCalledWith('2d6', expect.objectContaining({ forId: 'marine', targetId: 'cultist' }));
    });

    it('execute finishes a foe this actor pinned, of a lower band, as a posted crit', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, band: 'Astartes', attacksPerAction: 2 },
            { id: 'cultist', name: 'Cultist', hp: 14, maxHp: 14, initiative: 5, isEnemy: true, band: 'Mortal' }
        ]);
        // Not pinned yet: refused.
        const early = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(early.error).toBeTruthy();
        expect(String(early.message ?? early.rawText)).toMatch(/pinned|restrained/i);
        dice(20, 1, 1);
        await act({ action: 'grapple', move: 'control', control: true, encounterId, actorId: 'marine', targetId: 'cultist' });
        const res = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(tok('cultist').hp).toBe(0);
        expect(res.execute).toBeTruthy();
    });

    it('execute is refused against a peer or when bands are unset', async () => {
        await fight([
            { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, band: 'Astartes', attacksPerAction: 3 },
            { id: 'rival', name: 'Rival', hp: 60, maxHp: 60, initiative: 5, isEnemy: true, band: 'Astartes',
                conditions: [{ name: 'restrained', source: 'grapple: marine' }] },
            { id: 'thrall', name: 'Thrall', hp: 10, maxHp: 10, initiative: 4, isEnemy: true,
                conditions: [{ name: 'restrained', source: 'grapple: marine' }] }
        ]);
        const peer = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'rival' });
        expect(String(peer.message ?? peer.rawText)).toMatch(/lower band/i);
        const unset = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'thrall' });
        expect(String(unset.message ?? unset.rawText)).toMatch(/band.*unset|unset/i);
        expect(tok('rival').hp).toBe(60);
    });

    it('break with a targetId escapes only that holder; the escaper uses Acrobatics', async () => {
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        repo.create({ id: 'luciel', name: 'Luciel', stats: { str: 10, dex: 18, con: 12, int: 10, wis: 10, cha: 10 }, hp: 40, maxHp: 40, ac: 15, level: 5,
            skillProficiencies: ['acrobatics'], createdAt: now, updatedAt: now } as any);
        await fight([
            { id: 'luciel', name: 'Luciel', hp: 40, maxHp: 40, initiative: 20, conditions: [
                { name: 'grappled', source: 'grapple: a' }, { name: 'restrained', source: 'grapple: b' }
            ] },
            { id: 'a', name: 'A', hp: 20, maxHp: 20, initiative: 5, isEnemy: true },
            { id: 'b', name: 'B', hp: 20, maxHp: 20, initiative: 4, isEnemy: true }
        ]);
        dice(10, 10);
        const res = await act({ action: 'grapple', move: 'break', encounterId, actorId: 'luciel', targetId: 'a' });
        // d20 10 + DEX 4 + prof 3 = 17 vs d20 10 + 0.
        expect(res.breakdown).toMatch(/\+3prof/);
        expect(res.hit).toBe(true);
        expect(tok('luciel').conditions.map((c: any) => c.sourceId)).toEqual(['grapple: b']);
    });

    it('without an encounter, sheets still grapple on logged seeded dice', async () => {
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        for (const [id, name] of [['luciel', 'Luciel'], ['foe', 'Foe']]) {
            repo.create({ id, name, stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 50, maxHp: 50, ac: 14, level: 5, createdAt: now, updatedAt: now } as any);
        }
        const res = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe' });
        expect(res.error).toBeFalsy();
        const logged = getDb().prepare("SELECT for_id FROM roll_log WHERE purpose = 'grapple' ORDER BY for_id").all() as Array<{ for_id: string }>;
        expect(logged.map(r => r.for_id)).toEqual(['foe', 'luciel']);
        if (res.hit) expect(repo.findById('foe')!.conditions).toEqual([expect.objectContaining({ name: 'Clinched', source: 'grapple: luciel' })]);
        const none = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'nobody' });
        expect(String(none.message)).toMatch(/No character nobody/);
    });
});

/**
 * Play report 2, item 2: a pin was recognised only with the exact source
 * 'grapple: <actor id>'. The source may now be the canonical form, a
 * prefixed one ('pinned by Marine') or the bare id or name; Pinned is a
 * pin; a pin written on the sheet alone still counts (pinFrom 'sheet').
 */
describe('pin recognition (execute)', () => {
    let encounterId: string;
    const tokens = () => new EncounterRepository(getDb()).loadState(encounterId)!.participants as any[];
    const tok = (id: string) => tokens().find(t => t.id === id);
    const fight = async (participants: Array<Record<string, unknown>>) => {
        const created = await manage({ action: 'create', seed: 'pin-recognition', participants });
        encounterId = created.encounterId;
    };
    const marine = { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, band: 'Astartes', attacksPerAction: 2 };

    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it.each([
        [{ name: 'restrained', source: 'Marine' }],
        [{ name: 'restrained', source: 'grapple:marine' }],
        [{ name: 'restrained', source: 'marine' }],
        [{ name: 'Pinned', source: 'Marine' }],
        [{ name: 'Pinned', source: 'pinned by Marine' }]
    ])('a token pinned with source %j is executed', async (pin) => {
        await fight([marine, { id: 'cultist', name: 'Cultist', hp: 14, maxHp: 14, initiative: 5, isEnemy: true, band: 'Mortal', conditions: [pin] }]);
        const res = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(res.pinFrom).toBe('token');
        expect(tok('cultist').hp).toBe(0);
    });

    it('Grappled by the actor plus Prone from anyone is a pin', async () => {
        await fight([marine, { id: 'cultist', name: 'Cultist', hp: 14, maxHp: 14, initiative: 5, isEnemy: true, band: 'Mortal',
            conditions: [{ name: 'grappled', source: 'Marine' }, { name: 'prone', source: 'tripwire' }] }]);
        const res = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(tok('cultist').hp).toBe(0);
    });

    it('Grappled without Prone is refused, listing what was found and what is needed', async () => {
        await fight([marine, { id: 'cultist', name: 'Cultist', hp: 14, maxHp: 14, initiative: 5, isEnemy: true, band: 'Mortal',
            conditions: [{ name: 'grappled', source: 'Marine' }] }]);
        const res = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeTruthy();
        expect(res.writes).toBe('none');
        expect(String(res.message)).toMatch(/found grappled \(source 'Marine'\)/i);
        expect(String(res.message)).toMatch(/Restrained\/Pinned, or Grappled \+ Prone/);
        expect(String(res.message)).toMatch(/sourced to Marine/);
        expect(tok('cultist').hp).toBe(14);
    });

    it("someone else's pin, or a spell's Restrained, is not this actor's", async () => {
        await fight([marine,
            { id: 'brute', name: 'Brute', hp: 60, maxHp: 60, initiative: 10, band: 'Astartes' },
            { id: 'cultist', name: 'Cultist', hp: 14, maxHp: 14, initiative: 5, isEnemy: true, band: 'Mortal',
                conditions: [{ name: 'restrained', source: 'Brute' }, { name: 'restrained', source: 'spell: Web' }] }]);
        const res = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeTruthy();
        expect(String(res.message)).toMatch(/found restrained \(source 'Brute'\)/i);
        expect(tok('cultist').hp).toBe(14);
    });

    it('a pin that exists only on the sheet counts while the fight runs (pinFrom sheet)', async () => {
        const repo = new CharacterRepository(getDb());
        const now = new Date().toISOString();
        repo.create({ id: 'marine', name: 'Marine', stats: { str: 18, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, hp: 60, maxHp: 60, ac: 18, level: 8, band: 'Astartes', createdAt: now, updatedAt: now } as any);
        repo.create({ id: 'cultist', name: 'Cultist', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 14, maxHp: 14, ac: 10, level: 1, band: 'Mortal',
            conditions: [{ name: 'Restrained', source: 'grapple: marine' }], createdAt: now, updatedAt: now } as any);
        await fight([marine, { id: 'cultist', name: 'Cultist', hp: 14, maxHp: 14, initiative: 5, isEnemy: true, band: 'Mortal' }]);
        expect(tok('cultist').conditions).toEqual([]);
        const res = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(res.pinFrom).toBe('sheet');
        expect(tok('cultist').hp).toBe(0);
    });
});

/**
 * Play report 2, item 3: an unconscious target still rolled its Athletics
 * against the grapple, and there was no way to post a grapple result the
 * table had already resolved. A helpless target (unconscious, asleep,
 * incapacitated, paralysed, stunned, petrified or at 0 HP) is held without
 * a contest (house ruling), and outcome win|lose posts the result; neither
 * rolls, both still spend the attack.
 */
describe('helpless targets and posted grapple results', () => {
    let encounterId: string;
    const tokens = () => new EncounterRepository(getDb()).loadState(encounterId)!.participants as any[];
    const tok = (id: string) => tokens().find(t => t.id === id);
    const fight = async (participants: Array<Record<string, unknown>>) => {
        const created = await manage({ action: 'create', seed: 'helpless', participants });
        encounterId = created.encounterId;
    };
    const marine = { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20 };
    // roll_log is created on the first logged roll: no table means no roll.
    const grappleRolls = () => { try { return (getDb().prepare("SELECT COUNT(*) AS n FROM roll_log WHERE purpose = 'grapple'").get() as { n: number }).n; } catch { return 0; } };
    const mkSheet = (id: string, name: string, extra: Record<string, unknown> = {}) => {
        const now = new Date().toISOString();
        new CharacterRepository(getDb()).create({ id, name, stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 50, maxHp: 50, ac: 14, level: 5, createdAt: now, updatedAt: now, ...extra } as any);
    };

    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('an unconscious token is held with no d20; the attack is still spent', async () => {
        await fight([marine, { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true, conditions: ['unconscious'] }]);
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const res = await act({ action: 'grapple', move: 'control', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeFalsy();
        expect(spy).not.toHaveBeenCalled();
        expect(res.hit).toBe(true);
        expect(res.autoWin.reason).toMatch(/Cultist is unconscious/);
        expect(res.rolls).toBeUndefined();
        expect(res.margin).toBeUndefined();
        expect(res.breakdown).toMatch(/auto-win.*no contest rolled/);
        expect(tok('cultist').conditions.map((c: any) => c.type)).toEqual(expect.arrayContaining(['unconscious', 'restrained']));
        expect(tok('marine').actionUsed).toBe(true);
    });

    it('a helpless actor cannot grapple: a custom Asleep the engine does not know is refused, nothing spent', async () => {
        await fight([{ ...marine, conditions: ['Asleep'] }, { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true, conditions: ['unconscious'] }]);
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.error).toBeTruthy();
        expect(res.writes).toBe('none');
        expect(String(res.message)).toMatch(/Marine cannot grapple now: Marine is Asleep/);
        expect(res.autoWin).toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
        expect(tok('marine').attacksMade ?? 0).toBe(0);
        expect(tok('marine').actionUsed).toBeFalsy();
        expect(tok('cultist').conditions.map((c: any) => c.type)).toEqual(['unconscious']);
    });

    it('a target at 0 HP is helpless too', async () => {
        await fight([marine, { id: 'cultist', name: 'Cultist', hp: 0, maxHp: 10, initiative: 5, isEnemy: true }]);
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.hit).toBe(true);
        expect(res.autoWin.reason).toMatch(/at 0 HP/);
        expect(spy).not.toHaveBeenCalled();
    });

    it('a stale Unconscious on the sheet does not help against an awake token: the contest is rolled', async () => {
        mkSheet('marine', 'Marine');
        mkSheet('cultist', 'Cultist', { hp: 10, maxHp: 10, conditions: [{ name: 'Unconscious', source: 'last scene' }] });
        await fight([marine, { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }]);
        const spy = dice(18, 4);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.autoWin).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(2);
        expect(res.rolls).toEqual({ actor: [18], defender: [4] });
    });

    it.each(['Asleep', 'Paralysed', 'Stunned'])('a sheet-only %s target is held without an encounter and no grapple roll is logged', async (cond) => {
        mkSheet('luciel', 'Luciel');
        mkSheet('foe', 'Foe', { conditions: [{ name: cond }] });
        const res = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe' });
        expect(res.error).toBeFalsy();
        expect(res.hit).toBe(true);
        expect(res.autoWin.reason).toBe(`Foe is ${cond}`);
        expect(grappleRolls()).toBe(0);
        const names = new CharacterRepository(getDb()).findById('foe')!.conditions.map((c: any) => c.name);
        expect(names).toEqual(expect.arrayContaining([cond, 'Clinched']));
    });

    it("outcome 'win' applies the hold and 'lose' writes none; neither rolls, both spend the attack", async () => {
        await fight([{ ...marine, attacksPerAction: 2 }, { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }]);
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const lose = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', outcome: 'lose' });
        expect(lose.error).toBeFalsy();
        expect(lose.hit).toBe(false);
        expect(lose.posted).toBe(true);
        expect(lose.outcome).toBe('lose');
        expect(lose.breakdown).toMatch(/posted by the GM: LOSE/);
        expect(tok('cultist').conditions).toEqual([]);
        expect(tok('marine').attacksMade).toBe(1);
        expect(lose.actionSpent).toBe('attack 1/2');
        const win = await act({ action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist', outcome: 'win' });
        expect(win.hit).toBe(true);
        expect(win.posted).toBe(true);
        expect(win.autoWin).toBeUndefined();
        expect(tok('cultist').conditions.map((c: any) => c.type).sort()).toEqual(['grappled', 'prone']);
        expect(tok('marine').actionUsed).toBe(true);
        expect(spy).not.toHaveBeenCalled();
    });

    it('a posted throw takes the surface damage the GM rolled, or rolls the dice given', async () => {
        await fight([{ ...marine, attacksPerAction: 2 }, { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }]);
        const d20 = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const posted = await act({ action: 'grapple', move: 'throw', encounterId, actorId: 'marine', targetId: 'cultist', outcome: 'win', damage: 3 });
        expect(posted.surfaceDamage).toBe(3);
        expect(posted.damageDetail).toMatch(/posted/);
        const surface = vi.spyOn(CombatEngine.prototype, 'rollDice');
        const rolled = await act({ action: 'grapple', move: 'slam', encounterId, actorId: 'marine', targetId: 'cultist', outcome: 'win', damage: '1d6' });
        expect(surface).toHaveBeenCalledWith('1d6', expect.objectContaining({ purpose: 'grapple slam surface', forId: 'marine' }));
        expect(rolled.surfaceDamage).toBeGreaterThanOrEqual(1);
        expect(rolled.surfaceDamage).toBeLessThanOrEqual(6);
        expect(d20).not.toHaveBeenCalled();
        // Bad dice: refused before anything is written.
        const bad = await act({ action: 'grapple', move: 'slam', encounterId, actorId: 'marine', targetId: 'cultist', outcome: 'win', damage: 'lots' });
        expect(bad.error).toBeTruthy();
        expect(bad.writes).toBe('none');
    });

    it('the outer schema takes win|lose; attack keeps hit|crit|miss; execute refuses lose', async () => {
        expect(() => CombatActionTool.inputSchema.parse({ action: 'grapple', encounterId: 'e', actorId: 'a', targetId: 'b', move: 'clinch', outcome: 'win' })).not.toThrow();
        expect(() => CombatActionTool.inputSchema.parse({ action: 'grapple', encounterId: 'e', actorId: 'a', targetId: 'b', move: 'clinch', outcome: 'lose' })).not.toThrow();
        await fight([{ ...marine, band: 'Astartes' }, { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true, band: 'Mortal', conditions: [{ name: 'restrained', source: 'Marine' }] }]);
        const atk = await act({ action: 'attack', encounterId, actorId: 'marine', targetId: 'cultist', outcome: 'win', damage: 3 });
        expect(atk.error).toBeTruthy();
        expect(tok('cultist').hp).toBe(10);
        const ex = await act({ action: 'grapple', move: 'execute', encounterId, actorId: 'marine', targetId: 'cultist', outcome: 'lose' });
        expect(ex.error).toBeTruthy();
        expect(ex.writes).toBe('none');
        expect(String(ex.message)).toMatch(/not contested/i);
        expect(tok('cultist').hp).toBe(10);
    });

    it('the description owns the house ruling', () => {
        expect(CombatActionTool.description).toMatch(/helpless/i);
        expect(CombatActionTool.description).toMatch(/house ruling/i);
        expect(CombatActionTool.description).toMatch(/win\|lose/);
    });
});

/**
 * Play report 2, item 4: the outer schema demanded encounterId while the
 * handler treated it as optional, so a real MCP caller could never reach the
 * sheet path and sent placeholders like 'none'. Grapple is the one action
 * that works without it; with none, two tokens in one live fight are routed
 * there (apply_damage's rule), and the sheet proficiency reads the world's
 * curve and expertise.
 */
describe('grapple without an encounter (item 4)', () => {
    const W = 'grapple-world';
    const grappleRolls = () => { try { return (getDb().prepare("SELECT COUNT(*) AS n FROM roll_log WHERE purpose = 'grapple'").get() as { n: number }).n; } catch { return 0; } };
    const mkSheet = (id: string, name: string, extra: Record<string, unknown> = {}) => {
        const now = new Date().toISOString();
        new CharacterRepository(getDb()).create({ id, name, stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 50, maxHp: 50, ac: 14, level: 5, skillProficiencies: ['Athletics'], createdAt: now, updatedAt: now, ...extra } as any);
    };

    beforeEach(() => {
        closeDb(); clearCombatState();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'Grapple', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        mkSheet('luciel', 'Luciel');
        mkSheet('foe', 'Foe');
    });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('the outer schema no longer demands encounterId for grapple; engine actions still do', async () => {
        expect(() => CombatActionTool.inputSchema.parse({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe' })).not.toThrow();
        const atk = await act({ action: 'attack', actorId: 'luciel', targetId: 'foe', outcome: 'hit', damage: 3 });
        expect(atk.error).toBeTruthy();
        expect(JSON.stringify(atk)).toMatch(/encounterId/);
        expect(new CharacterRepository(getDb()).findById('foe')!.hp).toBe(50);
    });

    it("a placeholder encounterId ('none', 'null', 'n/a') takes the sheet path", async () => {
        for (const ph of ['none', 'null', 'N/A', '-']) {
            const res = await act({ action: 'grapple', move: 'clinch', encounterId: ph, actorId: 'luciel', targetId: 'foe' });
            expect(res.error).toBeFalsy();
            expect(res.encounterId).toBeUndefined();
        }
        expect(grappleRolls()).toBe(8);
    });

    it('reaches the sheet path through the operation guard and the outer schema (the MCP boundary)', async () => {
        const bound = withOperation('combat_action', (a: any) => handleCombatAction(CombatActionTool.inputSchema.parse(a), ctx as any));
        const res = embedded(await bound({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe' }, undefined as any), 'COMBAT_ACTION');
        expect(res.error).toBeFalsy();
        expect(res.breakdown).toMatch(/\+3prof/);
        expect(grappleRolls()).toBe(2);
    });

    it('with no encounterId, two tokens in one live fight are routed to it', async () => {
        const created = await manage({ action: 'create', seed: 'routed', participants: [
            { id: 'luciel', name: 'Luciel', hp: 50, maxHp: 50, initiative: 20 },
            { id: 'foe', name: 'Foe', hp: 50, maxHp: 50, initiative: 5, isEnemy: true }
        ] });
        dice(20, 1);
        const res = await act({ action: 'grapple', move: 'takedown', actorId: 'luciel', targetId: 'foe' });
        expect(res.error).toBeFalsy();
        expect(res.routedToEncounter).toBe(true);
        expect(res.encounterId).toBe(created.encounterId);
        expect(res.encounterTokensUpdated).toBe(true);
        const tokens = new EncounterRepository(getDb()).loadState(created.encounterId)!.participants as any[];
        expect(tokens.find(t => t.id === 'foe').conditions.map((c: any) => c.type).sort()).toEqual(['grappled', 'prone']);
        expect(tokens.find(t => t.id === 'luciel').actionUsed).toBe(true);
        expect(grappleRolls()).toBe(0);
    });

    it('refuses, writing nothing, when only one side is in a fight or they are in different fights', async () => {
        const first = await manage({ action: 'create', seed: 'split-1', participants: [
            { id: 'luciel', name: 'Luciel', hp: 50, maxHp: 50, initiative: 20 },
            { id: 'stranger', name: 'Stranger', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ] });
        const one = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe' });
        expect(one.error).toBeTruthy();
        expect(one.writes).toBe('none');
        expect(String(one.message)).toMatch(new RegExp(`luciel.*${first.encounterId}`));
        expect(String(one.message)).toMatch(/foe.*no fight/);
        const second = await manage({ action: 'create', seed: 'split-2', participants: [
            { id: 'foe', name: 'Foe', hp: 50, maxHp: 50, initiative: 20 },
            { id: 'other', name: 'Other', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }
        ] });
        const two = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe' });
        expect(two.error).toBeTruthy();
        expect(two.writes).toBe('none');
        expect(String(two.message)).toMatch(new RegExp(`foe.*${second.encounterId}`));
        expect(grappleRolls()).toBe(0);
        expect(new CharacterRepository(getDb()).findById('foe')!.conditions).toEqual([]);
    });

    it("sheet proficiency reads the world's progression curve and doubles for expertise", async () => {
        await handleTableRules({ action: 'define', worldId: W, kind: 'progression', name: 'curve', spec: { mode: 'milestone', profBonus: [5, 5, 5, 5, 5, 5] } }, ctx as any);
        const flat = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe' });
        expect(flat.breakdown).toMatch(/Luciel d20\(\d+\)\+3stat\+5prof/);
        expect(flat.breakdown).toMatch(/Foe d20\(\d+\)\+3stat\+5prof/);
        new CharacterRepository(getDb()).update('luciel', { expertise: ['athletics'] } as never);
        const expert = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe' });
        expect(expert.breakdown).toMatch(/Luciel d20\(\d+\)\+3stat\+10prof \(expertise\)/);
    });

    it('a helpless actor cannot grapple on the sheets either: refused, nothing written, no roll logged', async () => {
        // In a fight the engine refuses an incapacitated actor; the sheet path must not be the way round it.
        const repo = new CharacterRepository(getDb());
        repo.update('luciel', { conditions: [{ name: 'Unconscious' }] } as never);
        const asleep = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe' });
        expect(asleep.error).toBeTruthy();
        expect(asleep.writes).toBe('none');
        expect(String(asleep.message)).toMatch(/Luciel cannot grapple now: Luciel is Unconscious/);
        // Two helpless creatures: no auto-win for the one who called first.
        repo.update('foe', { conditions: [{ name: 'Stunned' }] } as never);
        const both = await act({ action: 'grapple', move: 'control', actorId: 'luciel', targetId: 'foe' });
        expect(both.error).toBeTruthy();
        expect(both.autoWin).toBeUndefined();
        // At 0 HP too, and the escaper of a break alike.
        repo.update('luciel', { conditions: [], hp: 0 } as never);
        const down = await act({ action: 'grapple', move: 'break', actorId: 'luciel', targetId: 'foe' });
        expect(down.error).toBeTruthy();
        expect(down.writes).toBe('none');
        expect(String(down.message)).toMatch(/Luciel is at 0 HP/);
        expect(grappleRolls()).toBe(0);
        expect(repo.findById('foe')!.conditions.map((c: any) => c.name)).toEqual(['Stunned']);
    });
});
