import { CombatEngine } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction, CombatActionTool } from '../../src/server/consolidated/combat-action.js';
import { handleTableRules } from '../../src/server/consolidated/table-rules.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { withOperation } from '../../src/server/operation-guard.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
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

    it('a helpless actor with actionSurge: true is refused BEFORE the surge is spent (token and sheet untouched)', async () => {
        // Play report 4, side bug: the surge was granted and the ability marked
        // spent (sheet mirrored) before the helpless-actor refusal that claimed
        // writes: 'none'. The refusal comes first now.
        mkSheet('marine', 'Marine', { abilities: [{ name: 'Action Surge', grantsAction: true, ready: true }] });
        await fight([{ ...marine, abilities: [{ name: 'Action Surge', grantsAction: true }] }, { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true }]);
        dice(18, 4);
        expect((await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' })).hit).toBe(true);
        // The action is spent; now the marine is knocked out by a custom condition the engine does not know.
        await manage({ action: 'add_condition', encounterId, participantId: 'marine', name: 'Asleep' });
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const res = await act({ action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist', actionSurge: true });
        expect(res.error).toBeTruthy();
        expect(res.writes).toBe('none');
        expect(String(res.message)).toMatch(/Marine cannot grapple now: Marine is Asleep/);
        expect(res.actionSurge).toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
        const live = getOrLoadEngine(ctx as any, encounterId)!.getState()!.participants.find(p => p.id === 'marine') as any;
        expect(live.abilities[0].ready).toBe(true);
        expect(live.extraActions ?? 0).toBe(0);
        expect(new CharacterRepository(getDb()).findById('marine')!.abilities![0].ready).toBe(true);
        expect(tok('cultist').conditions.map((c: any) => c.type)).toEqual(['Clinched']);
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

/**
 * Play report 4, item 1: `grapple {advantage: true}` rolled one d20 and said
 * nothing. The actor's roll mode now comes from the GM's flag, the automatic
 * band/size rule and named sources (advantageSources / disadvantageSources,
 * matched against the actor's token conditions, sheet conditions and active
 * effects, math_manage's vocabulary); both present cancel to one die. The
 * defender keeps only its automatic disadvantage. A bad source is refused
 * before any roll or spend — a grapple writes.
 */
describe('grapple honours advantage (play report 4)', () => {
    let encounterId: string;
    const tokens = () => new EncounterRepository(getDb()).loadState(encounterId)!.participants as any[];
    const tok = (id: string) => tokens().find(t => t.id === id);
    const fight = async (participants: Array<Record<string, unknown>>) => {
        const created = await manage({ action: 'create', seed: 'grapple-advantage', participants });
        encounterId = created.encounterId;
    };
    const marine = { id: 'marine', name: 'Marine', hp: 60, maxHp: 60, initiative: 20, attacksPerAction: 4 };
    const cultist = { id: 'cultist', name: 'Cultist', hp: 10, maxHp: 10, initiative: 5, isEnemy: true };
    const mkSheet = (id: string, name: string, extra: Record<string, unknown> = {}) => {
        const now = new Date().toISOString();
        new CharacterRepository(getDb()).create({ id, name, stats: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, hp: 50, maxHp: 50, ac: 14, level: 5, createdAt: now, updatedAt: now, ...extra } as any);
    };
    const effect = (targetId: string, name: string) => new CustomEffectsRepository(getDb()).apply({
        target_id: targetId, target_type: 'character', name, description: name,
        category: 'neutral', power_level: 1, source: { type: 'unknown' },
        mechanics: [{ type: 'custom_trigger', value: name }] as never, duration: { type: 'until_removed' as never },
        triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
    } as never);
    const rollLog = () => { try { return getDb().prepare('SELECT for_id, purpose, expression FROM roll_log WHERE purpose LIKE ? ORDER BY rowid').all('grapple%') as Array<{ for_id: string; purpose: string; expression: string }>; } catch { return []; } };

    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { vi.restoreAllMocks(); closeDb(); });

    it('advantage: true rolls two d20 for the actor, keeps the high die, names the GM and logs the reason in the purpose', async () => {
        await fight([marine, cultist]);
        const spy = dice(5, 18, 9);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantage: true });
        expect(res.error).toBeFalsy();
        expect(res.rolls).toEqual({ actor: [5, 18], defender: [9] });
        expect(res.margin).toBe(9);
        expect(res.hit).toBe(true);
        expect(res.breakdown).toMatch(/Marine d20\(5,18 adv → 18\)/);
        expect(res.situational).toEqual(['Marine: advantage (GM)']);
        expect(res.rollMode).toEqual({ actor: 'advantage', defender: 'normal' });
        expect(spy).toHaveBeenCalledTimes(3);
        expect(spy).toHaveBeenNthCalledWith(1, expect.objectContaining({ purpose: 'grapple (adv: GM)', forId: 'marine', targetId: 'cultist' }));
        expect(spy).toHaveBeenNthCalledWith(2, expect.objectContaining({ purpose: 'grapple (adv: GM)', forId: 'marine' }));
        expect(spy).toHaveBeenNthCalledWith(3, expect.objectContaining({ purpose: 'grapple', forId: 'cultist', targetId: 'marine' }));
    });

    it('disadvantage: true rolls two and keeps the low die', async () => {
        await fight([marine, cultist]);
        const spy = dice(15, 3, 10);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', disadvantage: true });
        expect(res.rolls).toEqual({ actor: [15, 3], defender: [10] });
        expect(res.hit).toBe(false);
        expect(res.breakdown).toMatch(/Marine d20\(15,3 dis → 3\)/);
        expect(res.situational).toEqual(['Marine: disadvantage (GM)']);
        expect(res.rollMode).toEqual({ actor: 'disadvantage', defender: 'normal' });
        expect(spy).toHaveBeenNthCalledWith(1, expect.objectContaining({ purpose: 'grapple (dis: GM)', forId: 'marine' }));
    });

    it("the GM's advantage and the automatic band disadvantage cancel to one die; the defender is unchanged", async () => {
        await fight([{ ...marine, band: 'Mortal' }, { ...cultist, band: 'Astartes' }]);
        const spy = dice(7, 12);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantage: true });
        expect(res.rolls).toEqual({ actor: [7], defender: [12] });
        expect(res.rollMode).toEqual({ actor: 'cancelled', defender: 'normal' });
        expect(res.situational).toHaveLength(1);
        expect(res.situational[0]).toMatch(/^Marine: advantage and disadvantage cancel.*adv: GM.*dis: lower band \(Mortal vs Astartes\)/);
        expect(res.breakdown).toMatch(/Marine d20\(7\)/);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenNthCalledWith(1, expect.objectContaining({ purpose: 'grapple (adv: GM; dis: lower band)', forId: 'marine' }));
        expect(spy).toHaveBeenNthCalledWith(2, expect.objectContaining({ purpose: 'grapple', forId: 'cultist' }));
    });

    it('the automatic rule still reads in the purpose and the line when it stands alone', async () => {
        await fight([{ ...marine, band: 'Astartes' }, { ...cultist, band: 'Mortal', size: 'small' }]);
        const spy = dice(5, 20, 3);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' });
        expect(res.rolls).toEqual({ actor: [5], defender: [20, 3] });
        expect(res.rollMode).toEqual({ actor: 'normal', defender: 'disadvantage' });
        expect(res.situational).toEqual(['Cultist: disadvantage (lower band (Mortal vs Astartes); smaller (small vs medium))']);
        expect(spy).toHaveBeenNthCalledWith(1, expect.objectContaining({ purpose: 'grapple', forId: 'marine' }));
        expect(spy).toHaveBeenNthCalledWith(2, expect.objectContaining({ purpose: 'grapple (dis: lower band, smaller)', forId: 'cultist' }));
    });

    it('advantage: false alone is one straight die; advantage with disadvantage cancels', async () => {
        await fight([marine, cultist]);
        dice(11, 4);
        const plain = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantage: false });
        expect(plain.rolls).toEqual({ actor: [11], defender: [4] });
        expect(plain.rollMode).toEqual({ actor: 'normal', defender: 'normal' });
        expect(plain.situational).toBeUndefined();
        dice(11, 4);
        const both = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantage: true, disadvantage: true });
        expect(both.rolls).toEqual({ actor: [11], defender: [4] });
        expect(both.rollMode.actor).toBe('cancelled');
        expect(both.situational[0]).toMatch(/Marine: advantage and disadvantage cancel.*adv: GM; dis: GM/);
    });

    it("sources resolve against the actor's token conditions, sheet conditions and active custom effects", async () => {
        mkSheet('marine', 'Marine', { conditions: [{ name: 'Blessed', source: 'chaplain' }] });
        effect('marine', 'Iron Grip');
        await fight([{ ...marine, conditions: [{ name: 'Bulwark Stance', source: 'ritual' }] }, cultist]);
        // A token condition, by a substring of its name.
        let spy = dice(5, 18, 9);
        const token = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantageSources: ['bulwark'] });
        expect(token.error).toBeFalsy();
        expect(token.rolls.actor).toEqual([5, 18]);
        expect(token.advantageSources).toEqual(['Bulwark Stance']);
        expect(token.situational).toEqual(['Marine: advantage (Bulwark Stance)']);
        expect(spy).toHaveBeenNthCalledWith(1, expect.objectContaining({ purpose: 'grapple (adv: Bulwark Stance)' }));
        // A sheet condition, by its source text; with the GM's flag the GM reads first.
        spy = dice(5, 18, 9);
        const sheet = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantage: true, advantageSources: ['chaplain'] });
        expect(sheet.advantageSources).toEqual(['Blessed']);
        expect(sheet.situational).toEqual(['Marine: advantage (GM; Blessed)']);
        expect(spy).toHaveBeenNthCalledWith(1, expect.objectContaining({ purpose: 'grapple (adv: GM, Blessed)' }));
        // A custom effect for advantage and a condition for disadvantage cancel.
        spy = dice(7, 12);
        const both = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantageSources: ['iron grip'], disadvantageSources: ['ritual'] });
        expect(both.rolls).toEqual({ actor: [7], defender: [12] });
        expect(both.rollMode.actor).toBe('cancelled');
        expect(both.advantageSources).toEqual(['Iron Grip']);
        expect(both.disadvantageSources).toEqual(['Bulwark Stance']);
        expect(spy).toHaveBeenNthCalledWith(1, expect.objectContaining({ purpose: 'grapple (adv: Iron Grip; dis: Bulwark Stance)' }));
        // A disadvantage source alone keeps the low die.
        dice(15, 3, 10);
        const dis = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', disadvantageSources: ['Iron Grip'] });
        expect(dis.rolls.actor).toEqual([15, 3]);
        expect(dis.rollMode.actor).toBe('disadvantage');
        expect(dis.situational).toEqual(['Marine: disadvantage (Iron Grip)']);
    });

    it('a source that matches nothing, or two things, is refused before any roll or spend', async () => {
        await fight([{ ...marine, conditions: [{ name: 'Shaken by the Warp' }, { name: 'Shaken nerves' }] }, cultist]);
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const miss = await act({ action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist', advantageSources: ['Khorne'] });
        expect(miss.error).toBeTruthy();
        expect(miss.writes).toBe('none');
        expect(String(miss.message)).toMatch(/advantage source "Khorne" matches nothing in Marine's conditions or active effects/);
        const amb = await act({ action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist', advantage: true, disadvantageSources: ['shaken'] });
        expect(amb.error).toBeTruthy();
        expect(amb.writes).toBe('none');
        expect(String(amb.message)).toMatch(/disadvantage source "shaken" matches 2 conditions or effects by prefix \[Shaken by the Warp \| Shaken nerves\]/);
        // Several problems print together.
        const two = await act({ action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist', advantageSources: ['Khorne', ''], disadvantageSources: ['shaken'] });
        expect(String(two.message)).toMatch(/Khorne.*is empty.*shaken/);
        expect(spy).not.toHaveBeenCalled();
        expect(tok('marine').attacksMade ?? 0).toBe(0);
        expect(tok('marine').actionUsed).toBeFalsy();
        expect(tok('cultist').conditions).toEqual([]);
    });

    it('a bad source with actionSurge: true spends nothing either', async () => {
        await fight([{ ...marine, attacksPerAction: 1, abilities: [{ name: 'Action Surge', grantsAction: true }] }, cultist]);
        dice(18, 4);
        expect((await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist' })).hit).toBe(true);
        const res = await act({ action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist', actionSurge: true, advantageSources: ['Khorne'] });
        expect(res.error).toBeTruthy();
        expect(res.writes).toBe('none');
        expect(getOrLoadEngine(ctx as any, encounterId)!.getState()!.participants.find(p => p.id === 'marine')!.abilities![0].ready).toBe(true);
    });

    it("on the sheets, advantage logs 2d20kh1 under the reasoned purpose; the defender's die stays 1d20 'grapple'", async () => {
        mkSheet('luciel', 'Luciel');
        mkSheet('foe', 'Foe');
        const adv = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe', advantage: true });
        expect(adv.error).toBeFalsy();
        expect(adv.rolls.actor).toHaveLength(2);
        expect(adv.rolls.defender).toHaveLength(1);
        expect(adv.breakdown).toMatch(new RegExp(`Luciel d20\\(${adv.rolls.actor.join(',')} adv → ${Math.max(...adv.rolls.actor)}\\)\\+3stat\\+0prof = ${Math.max(...adv.rolls.actor) + 3}`));
        expect(adv.rollMode).toEqual({ actor: 'advantage', defender: 'normal' });
        let log = rollLog();
        expect(log.find(r => r.for_id === 'luciel')).toEqual({ for_id: 'luciel', purpose: 'grapple (adv: GM)', expression: '2d20kh1' });
        expect(log.find(r => r.for_id === 'foe')).toEqual({ for_id: 'foe', purpose: 'grapple', expression: '1d20' });
        const dis = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe', disadvantage: true });
        expect(dis.rolls.actor).toHaveLength(2);
        log = rollLog().filter(r => r.for_id === 'luciel');
        expect(log[1]).toEqual({ for_id: 'luciel', purpose: 'grapple (dis: GM)', expression: '2d20kl1' });
        // A sheet condition names a source without an encounter too.
        new CharacterRepository(getDb()).update('luciel', { conditions: [{ name: 'Bulwark', source: 'ritual' }] } as never);
        const src = await act({ action: 'grapple', move: 'clinch', actorId: 'luciel', targetId: 'foe', advantageSources: ['bulwark'] });
        expect(src.advantageSources).toEqual(['Bulwark']);
        expect(rollLog().filter(r => r.for_id === 'luciel')[2].purpose).toBe('grapple (adv: Bulwark)');
    });

    it('a posted outcome or a helpless target rolls no contest: the flag and the sources are noted as ignored, not checked', async () => {
        await fight([marine, { ...cultist, conditions: ['unconscious'] }]);
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const posted = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', outcome: 'win', advantage: true });
        expect(posted.error).toBeFalsy();
        expect(posted.hit).toBe(true);
        expect(posted.rollMode).toBeUndefined();
        expect(posted.situational).toEqual(['advantage ignored: no contest rolled']);
        const auto = await act({ action: 'grapple', move: 'takedown', encounterId, actorId: 'marine', targetId: 'cultist', advantageSources: ['Khorne'], disadvantage: true });
        expect(auto.error).toBeFalsy();
        expect(auto.autoWin.reason).toMatch(/unconscious/);
        expect(auto.advantageSources).toBeUndefined();
        expect(auto.situational).toEqual(['advantage ignored: no contest rolled', 'disadvantage ignored: no contest rolled']);
        expect(spy).not.toHaveBeenCalled();
    });

    it('the outer schema and the grapple action schema carry the source params; the description owns them', () => {
        const parsed = CombatActionTool.inputSchema.parse({ action: 'grapple', actorId: 'a', targetId: 'b', move: 'clinch', advantage: true, advantageSources: ['x'], disadvantageSources: '["y"]' });
        expect(parsed.advantageSources).toEqual(['x']);
        expect(parsed.disadvantageSources).toEqual(['y']);
        const grapple = CombatActionTool.actionSchemas.grapple;
        expect(grapple).toBeDefined();
        expect(grapple.aliases).toEqual(expect.arrayContaining(['clinch', 'takedown', 'slam', 'break_grapple']));
        const keys = Object.keys((grapple.schema as any).shape);
        expect(keys).toEqual(expect.arrayContaining(['action', 'encounterId', 'actorId', 'targetId', 'move', 'surface', 'control', 'outcome', 'damage', 'damageType', 'modifier', 'actionSurge', 'advantage', 'disadvantage', 'advantageSources', 'disadvantageSources']));
        // Every grapple key is mirrored on the outer schema.
        const outer = Object.keys((CombatActionTool.inputSchema as any).shape);
        for (const k of keys) expect(outer).toContain(k);
        expect(CombatActionTool.description).toMatch(/advantageSources/);
        expect(CombatActionTool.description).toMatch(/grapple.*advantage/i);
    });

    it('a key grapple does not use comes back in ignoredParams with the nearest valid key; a refusal carries none', async () => {
        await fight([marine, cultist]);
        dice(18, 4);
        const res = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', modifer: 2 });
        expect(res.error).toBeFalsy();
        expect(res.hit).toBe(true);
        expect(res.ignoredParams).toEqual(['modifer']);
        expect(String(res.message)).toMatch(/Ignored params \(not grapple parameters; nothing was written for them\): modifer — nearest valid key 'modifier'/);
        const refused = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantageSources: ['Khorne'], modifer: 2 });
        expect(refused.error).toBeTruthy();
        expect(refused.ignoredParams).toBeUndefined();
    });

    it('grapple without a move is refused with the move list and writes nothing; the schema promises no default it does not give', async () => {
        await fight([marine, cultist]);
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const none = await act({ action: 'grapple', encounterId, actorId: 'marine', targetId: 'cultist', advantage: true });
        expect(none.error).toBe(true);
        expect(none.writes).toBe('none');
        expect(String(none.message)).toMatch(/grapple needs move: clinch \| takedown \| throw \| slam \| control \| break \| execute/);
        expect(spy).not.toHaveBeenCalled();
        expect(tok('marine').attacksMade ?? 0).toBe(0);
        // The action aliases name the move themselves, and the GM's flag rides along.
        dice(5, 18, 9);
        const alias = await act({ action: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantage: true });
        expect(alias.move).toBe('clinch');
        expect(alias.rolls.actor).toEqual([5, 18]);
        const moveField = (CombatActionTool.actionSchemas.grapple.schema as any).shape.move;
        expect(String(moveField.description)).not.toMatch(/default/i);
    });

    it("a flag that is not a boolean is refused before anything is rolled or spent — never read as 'no advantage'", async () => {
        // Over MCP the outer schema refuses a string here; batch_manage and
        // direct callers hand the raw value to the handler, where
        // `'true' === true` is false and the call used to roll one plain die.
        await fight([marine, cultist]);
        const spy = vi.spyOn(CombatEngine.prototype, 'rollD20');
        const str = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantage: 'true' });
        expect(str.error).toBe(true);
        expect(str.writes).toBe('none');
        expect(String(str.message)).toMatch(/advantage must be true or false, not "true"/);
        const num = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', disadvantage: 1 });
        expect(num.error).toBe(true);
        expect(num.writes).toBe('none');
        expect(String(num.message)).toMatch(/disadvantage must be true or false, not 1/);
        expect(spy).not.toHaveBeenCalled();
        expect(tok('marine').attacksMade ?? 0).toBe(0);
        expect(tok('cultist').conditions).toEqual([]);
        // null is an unset flag, as it is everywhere else in the handler.
        dice(11, 4);
        const nul = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantage: null, disadvantage: null });
        expect(nul.error).toBeFalsy();
        expect(nul.rollMode).toEqual({ actor: 'normal', defender: 'normal' });
    });

    it('a direct caller (batch_manage) may hand the sources over as a JSON string or one bare name; the outer schema has not run for it', async () => {
        await fight([{ ...marine, conditions: [{ name: 'Bulwark Stance', source: 'ritual' }] }, cultist]);
        dice(5, 18, 9);
        const json = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', advantageSources: '["bulwark"]' });
        expect(json.error).toBeFalsy();
        expect(json.advantageSources).toEqual(['Bulwark Stance']);
        expect(json.rolls.actor).toEqual([5, 18]);
        dice(15, 3, 10);
        const bare = await act({ action: 'grapple', move: 'clinch', encounterId, actorId: 'marine', targetId: 'cultist', disadvantageSources: 'ritual' });
        expect(bare.error).toBeFalsy();
        expect(bare.disadvantageSources).toEqual(['Bulwark Stance']);
        expect(bare.rolls.actor).toEqual([15, 3]);
    });
});
