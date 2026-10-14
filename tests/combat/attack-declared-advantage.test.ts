/**
 * Play report 7 #7, second phase (lane F): declared advantage on attack rolls.
 *
 * The owner's spec: "A condition stays prose. Anything that changes a roll
 * should be declared on an effect." Lane E made the grammar (attack,
 * attack:melee, attack:ranged) and wired checks, saves and grapple; here the
 * attack roads read it. An untagged attack / attack:<lane> mechanic on the
 * attacker's active effects fires by itself on combat_action attack,
 * opportunity attacks, readied attacks (move-triggered and trigger_readied),
 * volleys and spell attacks; a tagged one fires on the attack call's context
 * or when named in advantageSources (readied and opportunity attacks carry no
 * context, so a tagged one never fires there). The lane is the attack's own:
 * the profile's ranged flag, else the grid distance against reach. A named
 * source that declares nothing for this attack is refused before anything is
 * rolled or spent, with lane E's teaching text. Every source is named in the
 * breakdown, the reply and the roll log.
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState, getOrLoadEngine } from '../../src/server/handlers/combat-handlers.js';
import { CombatEngine } from '../../src/engine/combat/engine.js';
import { getInitialSpellSlots } from '../../src/engine/magic/spell-validator.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

process.env.NODE_ENV = 'test';

// The operation guard writes a session's combat dice to roll_log; outside a tenant that session is 'unscoped'.
const ctx = { sessionId: 'unscoped' } as any;
const json = (res: any) => {
    const t = res.content[0].text as string;
    const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/);
    return m ? { ...JSON.parse(m[2]), rawText: t } : { ...JSON.parse(t), rawText: t };
};
const manageRaw = withOperation('combat_manage', (a: any) => handleCombatManage(a, ctx));
const actRaw = withOperation('combat_action', (a: any) => handleCombatAction(a, ctx));
let enc: string;
const manage = async (a: Record<string, unknown>) => json(await manageRaw({ encounterId: enc, ...a }));
const act = async (a: Record<string, unknown>) => {
    const d = json(await actRaw({ encounterId: enc, ...a }));
    return { d, r: d.actionResult ?? d };
};
const tok = (id: string) => new EncounterRepository(getDb()).loadState(enc)!.participants.find(p => p.id === id)! as any;
const live = (id: string) => getOrLoadEngine(ctx, enc)!.getState()!.participants.find(p => p.id === id)! as any;
const rolls = (forId: string, like = 'attack%') => {
    try {
        return (getDb().prepare('SELECT purpose, dice FROM roll_log WHERE for_id = ? AND purpose LIKE ? ORDER BY rowid').all(forId, like) as Array<{ purpose: string; dice: string }>)
            .map(r => ({ purpose: r.purpose, dice: JSON.parse(r.dice) as Array<{ sides: number; value: number }> }));
    } catch { return []; }
};

const now = () => new Date().toISOString();
function sheet(id: string, name: string, over: Record<string, unknown> = {}) {
    new CharacterRepository(getDb()).create({
        id, name, characterType: 'pc', level: 3, hp: 30, maxHp: 30, ac: 13,
        stats: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 },
        conditions: [], createdAt: now(), updatedAt: now(), ...over
    } as any);
}
function effect(targetId: string, name: string, mechanics: unknown[]) {
    new CustomEffectsRepository(getDb()).apply({
        target_id: targetId, target_type: 'character', name, description: name,
        category: 'neutral', power_level: 1, source: { type: 'unknown' },
        mechanics: mechanics as never, duration: { type: 'until_removed' as never },
        triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
    } as never);
}

const varek = (extra: Record<string, unknown> = {}) => ({ id: 'varek', name: 'Varek', hp: 30, maxHp: 30, ac: 13, initiative: 20, attacksPerAction: 8, position: { x: 0, y: 0 }, ...extra });
const rival = (extra: Record<string, unknown> = {}) => ({ id: 'rival', name: 'Rival', hp: 300, maxHp: 300, ac: 10, initiative: 10, isEnemy: true, position: { x: 1, y: 0 }, ...extra });
const archer = (extra: Record<string, unknown> = {}) => ({ id: 'archer', name: 'Far Archer', hp: 300, maxHp: 300, ac: 10, initiative: 5, isEnemy: true, position: { x: 8, y: 0 }, ...extra });

async function fight(participants: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
    enc = json(await manageRaw({ action: 'create', seed: 'declared-attacks', participants, ...extra })).encounterId;
}
const swing = (a: Record<string, unknown> = {}) => act({ action: 'attack', actorId: 'varek', targetId: 'rival', attackBonus: 5, damage: 1, ...a });
const shoot = (a: Record<string, unknown> = {}) => act({ action: 'attack', actorId: 'varek', targetId: 'archer', attackBonus: 5, damage: 1, ...a });

beforeEach(() => {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    sheet('varek', 'Varek', { conditions: [{ name: 'Gor Hunter' }, { name: 'Horn-Lock: locks horns with a rival head-on', source: 'Gor heritage' }] });
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('engine: partOpts.declared is read for the attack\'s own lane', () => {
    const engine = () => {
        const e = new CombatEngine('declared-engine');
        e.startEncounter([
            { id: 'a', name: 'A', initiativeBonus: 0, initiative: 20, hp: 30, maxHp: 30, conditions: [], position: { x: 0, y: 0 } },
            { id: 'b', name: 'B', initiativeBonus: 0, initiative: 10, hp: 300, maxHp: 300, ac: 10, conditions: [], isEnemy: true, position: { x: 1, y: 0 } },
            { id: 'c', name: 'C', initiativeBonus: 0, initiative: 5, hp: 300, maxHp: 300, ac: 10, conditions: [], isEnemy: true, position: { x: 9, y: 0 } }
        ] as any);
        e.drainRollRecords();
        return e;
    };
    const declared = { melee: { advantage: ['Bloodlust (attack:melee)'], disadvantage: [] }, ranged: { advantage: [], disadvantage: ['Bad Eye (attack:ranged)'] } };

    it('a melee swing takes the melee side: two dice, the line, the purpose and the reply', () => {
        const e = engine();
        const r = e.executeAttack('a', 'b', 5, 10, 1, undefined, false, false, undefined, undefined, undefined, undefined, { declared });
        expect((r.attackRoll as any).allRolls).toHaveLength(2);
        expect(r.attackRoll!.roll).toBe(Math.max(...(r.attackRoll as any).allRolls));
        expect(r.situational).toContain('advantage ← Bloodlust (attack:melee)');
        expect((r as any).advantageSources).toEqual(['Bloodlust (attack:melee)']);
        expect((r as any).disadvantageSources).toBeUndefined();
        expect(e.drainRollRecords().find(x => x.forId === 'a' && x.purpose.startsWith('attack'))!.purpose).toBe('attack (adv: Bloodlust (attack:melee))');
    });

    it('a shot from beyond reach takes the ranged side; an explicit ranged flag does too', () => {
        const e = engine();
        const far = e.executeAttack('a', 'c', 5, 10, 1, undefined, false, false, undefined, undefined, undefined, undefined, { declared });
        expect((far.attackRoll as any).allRolls).toHaveLength(2);
        expect(far.attackRoll!.roll).toBe(Math.min(...(far.attackRoll as any).allRolls));
        expect((far as any).disadvantageSources).toEqual(['Bad Eye (attack:ranged)']);
        expect(far.situational).toContain('disadvantage ← Bad Eye (attack:ranged)');
        const flagged = e.executeAttack('a', 'b', 5, 10, 1, undefined, false, false, undefined, undefined, undefined, undefined, { declared, ranged: true });
        expect((flagged as any).disadvantageSources).toEqual(['Bad Eye (attack:ranged)']);
        expect((flagged as any).advantageSources).toBeUndefined();
    });

    it('no declared sources: the purpose stays exactly attack', () => {
        const e = engine();
        e.executeAttack('a', 'b', 5, 10, 1);
        expect(e.drainRollRecords().filter(x => x.forId === 'a').map(x => x.purpose)).toContain('attack');
    });
});

describe('combat_action attack: untagged mechanics fire on their lane', () => {
    it('attack:melee fires on a melee swing and not on a ranged shot', async () => {
        effect('varek', 'Bloodlust', [{ type: 'advantage_on', value: 'attack:melee' }]);
        await fight([varek(), rival(), archer()]);
        const melee = await swing();
        expect(melee.r.roll.allRolls).toHaveLength(2);
        expect(melee.r.roll.die).toBe(Math.max(...melee.r.roll.allRolls));
        expect(melee.r.advantageSources).toEqual(['Bloodlust (attack:melee)']);
        expect(melee.r.situational).toContain('advantage ← Bloodlust (attack:melee)');
        expect(melee.d.rawText).toContain('advantage ← Bloodlust (attack:melee)');
        expect(rolls('varek')[0]).toMatchObject({ purpose: 'attack (adv: Bloodlust (attack:melee))' });
        expect(rolls('varek')[0].dice).toHaveLength(2);
        const ranged = await shoot();
        expect(ranged.r.roll.allRolls).toHaveLength(1);
        expect(ranged.r.advantageSources).toBeUndefined();
        expect(rolls('varek')[1].purpose).toBe('attack');
        // The explicit flag picks the lane too: a thrown spear at the man beside him.
        const thrown = await swing({ ranged: true });
        expect(thrown.r.roll.allRolls).toHaveLength(1);
    });

    it('attack:ranged fires on a ranged shot and not on a melee swing; a profile\'s ranged flag decides the lane', async () => {
        effect('varek', 'Hawk Eye', [{ type: 'advantage_on', value: 'attack:ranged' }]);
        await fight([varek({ attacks: [{ name: 'javelin', attackBonus: 5, damage: '1', ranged: true }, { name: 'axe', attackBonus: 5, damage: '1', default: true }] }), rival(), archer()]);
        const ranged = await shoot();
        expect(ranged.r.roll.allRolls).toHaveLength(2);
        expect(ranged.r.advantageSources).toEqual(['Hawk Eye (attack:ranged)']);
        const melee = await swing();
        expect(melee.r.roll.allRolls).toHaveLength(1);
        expect(melee.r.advantageSources).toBeUndefined();
        const javelin = await act({ action: 'attack', actorId: 'varek', targetId: 'rival', using: 'javelin' });
        expect(javelin.r.roll.allRolls).toHaveLength(2);
        expect(javelin.r.advantageSources).toEqual(['Hawk Eye (attack:ranged)']);
    });

    it('a plain attack scope covers both lanes; a disadvantage mechanic keeps the low die', async () => {
        effect('varek', 'Battle Trance', [{ type: 'advantage_on', value: 'attack' }]);
        effect('varek', 'Smoke in the Eyes', [{ type: 'disadvantage_on', value: 'attack:ranged' }]);
        await fight([varek(), rival(), archer()]);
        expect((await swing()).r.advantageSources).toEqual(['Battle Trance (attack)']);
        const shot = await shoot();
        // Advantage and disadvantage cancel: one die, both named.
        expect(shot.r.roll.allRolls).toHaveLength(1);
        expect(shot.r.advantageSources).toEqual(['Battle Trance (attack)']);
        expect(shot.r.disadvantageSources).toEqual(['Smoke in the Eyes (attack:ranged)']);
        expect(rolls('varek')[1].purpose).toBe('attack (adv: Battle Trance (attack); dis: Smoke in the Eyes (attack:ranged))');
    });
});

describe('combat_action attack: tags, names, the GM and refusals', () => {
    it('a tagged mechanic fires on context and by name, not without; the reply names the tag', async () => {
        effect('varek', 'Horn Charge', [{ type: 'advantage_on', value: 'attack:melee', condition: 'charging' }]);
        await fight([varek(), rival(), archer()]);
        const bare = await swing();
        expect(bare.r.roll.allRolls).toHaveLength(1);
        expect(bare.r.advantageSources).toBeUndefined();
        expect(bare.r.conditionalAdvantage).toEqual(["Horn Charge (charging): pass context: ['charging'] or advantageSources: ['Horn Charge'] when it holds"]);
        const tagged = await swing({ context: ['Charging'] });
        expect(tagged.r.roll.allRolls).toHaveLength(2);
        expect(tagged.r.advantageSources).toEqual(['Horn Charge (charging)']);
        expect(tagged.r.context).toEqual(['Charging']);
        expect(tagged.r.conditionalAdvantage).toBeUndefined();
        const named = await swing({ advantageSources: ['horn charge'] });
        expect(named.r.roll.allRolls).toHaveLength(2);
        expect(named.r.advantageSources).toEqual(['Horn Charge (charging, named)']);
        expect(rolls('varek').map(r => r.purpose)).toEqual(['attack', 'attack (adv: Horn Charge (charging))', 'attack (adv: Horn Charge (charging, named))']);
        // The tag is a melee one: a shot with the tag gets nothing, and says the tag fired nothing.
        const shot = await shoot({ context: ['charging'] });
        expect(shot.r.roll.allRolls).toHaveLength(1);
        expect(shot.r.situational).toEqual(expect.arrayContaining([expect.stringMatching(/context \[charging\] fired nothing on this ranged attack/)]));
    });

    it('naming an untagged mechanic that already fires adds nothing twice', async () => {
        effect('varek', 'Bloodlust', [{ type: 'advantage_on', value: 'attack:melee' }]);
        await fight([varek(), rival(), archer()]);
        const r = (await swing({ advantageSources: ['Bloodlust'] })).r;
        expect(r.roll.allRolls).toHaveLength(2);
        expect(r.advantageSources).toEqual(['Bloodlust (attack:melee)']);
        expect(r.situational.filter((l: string) => l.startsWith('advantage ←'))).toEqual(['advantage ← Bloodlust (attack:melee)']);
    });

    it('a named prose condition is refused with the teaching text; nothing is rolled or spent', async () => {
        await fight([varek({ attacksPerAction: 1 }), rival(), archer()]);
        const spy = vi.spyOn(CombatEngine.prototype, 'executeAttack');
        const bad = await swing({ advantageSources: ['Gor Hunter'] });
        expect(bad.d.error).toBe(true);
        expect(bad.d.writes).toBe('none');
        expect(bad.d.sourceProblems).toEqual([
            "'Gor Hunter' grants no advantage on melee attacks. To grant one, improvisation_manage feature_from_condition {characterId: 'varek', match: 'Gor Hunter', mechanics: [{type: 'advantage_on', value: 'attack:melee'}]}; for a one-off, use situationalAdvantage: '<reason>'."
        ]);
        expect(String(bad.d.message)).toMatch(/Nothing was rolled or spent/);
        expect(spy).not.toHaveBeenCalled();
        expect(rolls('varek')).toEqual([]);
        expect(tok('rival').hp).toBe(300);
        expect(live('varek').actionUsed).toBeFalsy();
        // The one attack of the action is still there.
        const ok = await swing();
        expect(ok.d.error).toBeFalsy();
        expect(ok.r.roll.allRolls).toHaveLength(1);
    });

    it('a name that matches nothing, or an effect scoped elsewhere, is refused the same way', async () => {
        effect('varek', 'Hawk Eye', [{ type: 'advantage_on', value: 'attack:ranged' }]);
        await fight([varek(), rival(), archer()]);
        const miss = await swing({ advantageSources: ['Khorne'] });
        expect(miss.d.writes).toBe('none');
        expect(miss.d.sourceProblems).toEqual(['advantage source "Khorne" matches nothing in Varek\'s conditions or active effects — nothing granted']);
        const elsewhere = await swing({ advantageSources: ['Hawk Eye'] });
        expect(elsewhere.d.writes).toBe('none');
        expect(elsewhere.d.sourceProblems[0]).toMatch(/^'Hawk Eye' grants no advantage on melee attacks \(it declares advantage on attack:ranged\)\. To grant one, improvisation_manage edit_effect \{targetId: 'varek', name: 'Hawk Eye'/);
        expect(rolls('varek')).toEqual([]);
    });

    it('situationalAdvantage is logged GM: <reason>; advantage: true is GM; disadvantageSources names a declaring condition', async () => {
        await fight([varek(), rival(), archer()]);
        const downhill = await swing({ situationalAdvantage: 'downhill' });
        expect(downhill.r.roll.allRolls).toHaveLength(2);
        expect(downhill.r.advantageSources).toEqual(['GM: downhill']);
        expect(downhill.r.situationalAdvantage).toBe('downhill');
        expect(downhill.r.situational).toContain('advantage ← GM: downhill');
        const gm = await swing({ advantage: true });
        expect(gm.r.advantageSources).toEqual(['GM']);
        const fog = await swing({ situationalDisadvantage: 'the fog' });
        expect(fog.r.roll.allRolls).toHaveLength(2);
        expect(fog.r.roll.die).toBe(Math.min(...fog.r.roll.allRolls));
        expect(fog.r.disadvantageSources).toEqual(['GM: the fog']);
        expect(rolls('varek').map(r => r.purpose)).toEqual(['attack (adv: GM: downhill)', 'attack (adv: GM)', 'attack (dis: GM: the fog)']);
    });

    it('declared advantage cancels against disadvantage from a condition: one die, both named', async () => {
        effect('varek', 'Bloodlust', [{ type: 'advantage_on', value: 'attack:melee' }]);
        await fight([varek({ conditions: ['poisoned'] }), rival(), archer()]);
        const r = (await swing()).r;
        expect(r.roll.allRolls).toHaveLength(1);
        expect(r.advantageSources).toEqual(['Bloodlust (attack:melee)']);
        expect(r.situational).toContain('advantage ← Bloodlust (attack:melee)');
        expect(r.situational.join(' | ')).toMatch(/poisoned/i);
        // A standard condition named as a source grants its 5e rule (and only that).
        const named = await swing({ disadvantageSources: ['poisoned'] });
        expect(named.r.disadvantageSources).toEqual(['Poisoned']);
    });

    it('the older advantage form does not touch attacks, by itself or by name', async () => {
        effect('varek', 'Old Fury', [{ type: 'advantage_on', value: 1, autoApply: true }, { type: 'advantage_on', value: 1, skill: 'athletics' }]);
        await fight([varek(), rival(), archer()]);
        const r = (await swing()).r;
        expect(r.roll.allRolls).toHaveLength(1);
        expect(r.advantageSources).toBeUndefined();
        expect(rolls('varek')[0].purpose).toBe('attack');
        const named = await swing({ advantageSources: ['Old Fury'] });
        expect(named.d.writes).toBe('none');
        expect(named.d.sourceProblems[0]).toMatch(/^'Old Fury' grants no advantage on melee attacks/);
    });

    it('a posted outcome rolls nothing, so declared advantage is noted as ignored', async () => {
        effect('varek', 'Bloodlust', [{ type: 'advantage_on', value: 'attack:melee' }]);
        await fight([varek(), rival(), archer()]);
        const r = (await swing({ outcome: 'hit', damage: 3 })).r;
        expect(r.advantageSources).toBeUndefined();
        expect(r.situational).toEqual(expect.arrayContaining([expect.stringMatching(/declared advantage ignored: posted outcome/)]));
    });
});

describe('reactions, volleys and spells read untagged mechanics', () => {
    const WALLS = ['1,-1', '2,-1', '3,-1', '1,1', '3,1'];
    const hero = (extra: Record<string, unknown> = {}) => ({ id: 'hero', name: 'Hero', hp: 300, maxHp: 300, ac: 10, initiative: 20, position: { x: 0, y: 0 }, ...extra });
    const gob = (extra: Record<string, unknown> = {}) => ({ id: 'gob', name: 'Goblin', hp: 300, maxHp: 300, ac: 10, initiative: 10, isEnemy: true, attackBonus: 5, attackDamage: '1d1', position: { x: 2, y: 1 }, ...extra });

    it('an opportunity attack during a move picks up an untagged mechanic; a tagged one never fires there', async () => {
        effect('gob', 'Bloodlust', [{ type: 'advantage_on', value: 'attack:melee' }]);
        effect('gob', 'Ambush Strike', [{ type: 'advantage_on', value: 'attack', condition: 'ambush' }]);
        await fight([hero(), gob()], { terrain: { obstacles: WALLS } });
        const { r } = await act({ action: 'move', actorId: 'hero', targetPosition: { x: 4, y: 0 } });
        expect(r.opportunityAttacks).toHaveLength(1);
        expect(r.opportunityAttacks[0].allRolls).toHaveLength(2);
        expect(r.opportunityAttacks[0].advantageSources).toEqual(['Bloodlust (attack:melee)']);
        expect(rolls('gob', 'opportunity attack%')[0].purpose).toBe('opportunity attack (adv: Bloodlust (attack:melee))');
    });

    it('a move-triggered readied attack picks up an untagged mechanic, a tagged one does not', async () => {
        effect('hero', 'Bloodlust', [{ type: 'advantage_on', value: 'attack:melee' }]);
        effect('hero', 'Ambush Strike', [{ type: 'advantage_on', value: 'attack', condition: 'ambush' }]);
        await fight([hero(), gob({ position: { x: 4, y: 0 } })]);
        await manage({ action: 'set_intent', participantId: 'hero', readied: { action: 'axe the goblin', trigger: 'it comes close', on: 'enters_reach', watch: 'gob', attack: { attackBonus: 5, damage: '1d1' } } });
        const { r } = await act({ action: 'move', actorId: 'gob', targetPosition: { x: 1, y: 0 } });
        expect(r.readiedTriggered[0]).toMatchObject({ participantId: 'hero', fired: true });
        expect(r.readiedTriggered[0].attack.allRolls).toHaveLength(2);
        expect(r.readiedTriggered[0].attack.advantageSources).toEqual(['Bloodlust (attack:melee)']);
    });

    it('trigger_readied rolls the stored attack with the declared mechanic', async () => {
        effect('hero', 'Hawk Eye', [{ type: 'advantage_on', value: 'attack:ranged' }]);
        await fight([hero({ attacks: [{ name: 'bow', attackBonus: 5, damage: '1d1', ranged: true }] }), gob({ position: { x: 1, y: 0 } })]);
        await manage({ action: 'set_intent', participantId: 'hero', readied: { action: 'loose', trigger: 'it moves', attack: { using: 'bow' } } });
        const d = await manage({ action: 'trigger_readied', participantId: 'hero', targetId: 'gob' });
        expect(d.success).toBe(true);
        expect(d.attack.allRolls).toHaveLength(2);
        expect(d.attack.advantageSources).toEqual(['Hawk Eye (attack:ranged)']);
    });

    it('a volley reads the unit token\'s untagged mechanic for its lane', async () => {
        effect('scions', 'Drilled Volleys', [{ type: 'advantage_on', value: 'attack:ranged' }]);
        await fight([
            { id: 'scions', name: 'Scions', hp: 50, maxHp: 50, initiative: 25, position: { x: 0, y: 3 }, unit: { models: 10, hpPerModel: 5, packed: true, attackBonus: 6 } },
            archer()
        ]);
        const v = await act({ action: 'volley', actorId: 'scions', targetId: 'archer' });
        expect(v.d.error).toBeFalsy();
        expect(v.r.roll.allRolls).toHaveLength(2);
        expect(v.r.advantageSources).toEqual(['Drilled Volleys (attack:ranged)']);
    });

    it('a spell attack (Fire Bolt, a ranged spell attack) reads attack:ranged, not attack:melee', async () => {
        sheet('wiz', 'Wizard', {
            stats: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 }, level: 5, characterClass: 'wizard',
            knownSpells: ['Fireball'], preparedSpells: ['Fireball'], cantripsKnown: ['Fire Bolt'],
            spellSlots: getInitialSpellSlots('wizard' as any, 5), maxSpellLevel: 3
        });
        effect('wiz', 'Arcane Focus', [{ type: 'advantage_on', value: 'attack:ranged' }]);
        effect('wiz', 'Shocking Hands', [{ type: 'advantage_on', value: 'attack:melee' }]);
        await fight([
            { id: 'wiz', name: 'Wizard', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 5 } },
            { id: 'grot', name: 'Grot', hp: 200, maxHp: 200, initiative: 10, isEnemy: true, ac: 12, position: { x: 6, y: 5 } }
        ]);
        const { d, r } = await act({ action: 'cast_spell', actorId: 'wiz', spellName: 'Fire Bolt', targetId: 'grot' });
        expect(d.error).toBeFalsy();
        expect(r.advantageSources).toEqual(['Arcane Focus (attack:ranged)']);
        expect(r.situational).toContain('advantage ← Arcane Focus (attack:ranged)');
        const logged = rolls('wiz', 'spell attack%');
        expect(logged[0].purpose).toBe('spell attack (adv: Arcane Focus (attack:ranged))');
        expect(logged[0].dice).toHaveLength(2);
    });
});
