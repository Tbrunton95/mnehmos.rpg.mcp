/**
 * Play report 7 #7, lane F, adversarial review: the edges of declared
 * advantage on attacks and initiative that the lane's own tests leave open.
 *
 *  - A named source that declares nothing refuses the attack before anything
 *    is spent on any road: Help, an Action Surge, legendary actions, the bonus
 *    action, ammunition. No roll_log row; the PC turn guard still reads the
 *    turn as untouched.
 *  - A spell attack's lane is the spell's own: Spiritual Weapon is a melee
 *    spell attack in 5e (range 60 places the weapon, the swing is melee), so
 *    attack:melee fires on it and attack:ranged does not.
 *  - output_mode summary keeps an initiative row's sources and both dice (the
 *    rows are kept whole for the chair), and the refusal's teaching text.
 *  - A posted outcome checks no names, and says which it did not check.
 *  - Declared advantage cancels against Dodge; declared disadvantage against
 *    Help; a subdued reactor's opportunity attack takes declared advantage
 *    and still knocks out.
 */
import { withOperation } from '../../src/server/operation-guard.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleCombatAction } from '../../src/server/consolidated/combat-action.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { shapeReply } from '../../src/server/output-mode.js';
import { getSpell } from '../../src/engine/magic/spell-database.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { ItemRepository } from '../../src/storage/repos/item.repo.js';
import { InventoryRepository } from '../../src/storage/repos/inventory.repo.js';
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
const stored = () => new EncounterRepository(getDb()).loadState(enc)!;
const tok = (id: string) => stored().participants.find(p => p.id === id)! as any;
const patchToken = (id: string, patch: Record<string, unknown>) => {
    const repo = new EncounterRepository(getDb());
    const st = repo.loadState(enc)!;
    Object.assign(st.participants.find(p => p.id === id)!, patch);
    repo.saveState(enc, st);
    clearCombatState();
};
const rolls = (forId: string, like = '%') => {
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

const varek = (extra: Record<string, unknown> = {}) => ({ id: 'varek', name: 'Varek', hp: 30, maxHp: 30, ac: 13, initiative: 20, position: { x: 0, y: 0 }, ...extra });
const rival = (extra: Record<string, unknown> = {}) => ({ id: 'rival', name: 'Rival', hp: 300, maxHp: 300, ac: 10, initiative: 10, isEnemy: true, position: { x: 1, y: 0 }, ...extra });

async function fight(participants: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
    enc = json(await manageRaw({ action: 'create', seed: 'declared-review', participants, ...extra })).encounterId;
}
const swing = (a: Record<string, unknown> = {}) => act({ action: 'attack', actorId: 'varek', targetId: 'rival', attackBonus: 5, damage: 1, ...a });
const GOR = "'Gor Hunter' grants no advantage on melee attacks. To grant one, improvisation_manage feature_from_condition {characterId: 'varek', match: 'Gor Hunter', mechanics: [{type: 'advantage_on', value: 'attack:melee'}]}; for a one-off, use situationalAdvantage: '<reason>'.";

beforeEach(() => {
    closeDb();
    getDb(':memory:');
    clearCombatState();
    sheet('varek', 'Varek', { conditions: [{ name: 'Gor Hunter' }] });
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); });

describe('a refused name spends nothing, on any road', () => {
    it('Help stays on the attacker and the next swing takes it', async () => {
        await fight([varek(), rival(), { id: 'ally', name: 'Ally', hp: 10, maxHp: 10, initiative: 15, position: { x: 0, y: 1 } }]);
        patchToken('varek', { helpedBy: 'ally' });
        const bad = await swing({ advantageSources: ['Gor Hunter'] });
        expect(bad.d).toMatchObject({ error: true, writes: 'none', sourceProblems: [GOR] });
        expect(tok('varek').helpedBy).toBe('ally');
        const ok = await swing();
        expect(ok.r.roll.allRolls).toHaveLength(2);
        expect(ok.r.situational).toEqual(expect.arrayContaining([expect.stringMatching(/helped by Ally/)]));
    });

    it('an Action Surge stays ready, the bonus action unused, legendary actions full, the ammunition counted', async () => {
        new ItemRepository(getDb()).create({ id: 'bolts', name: 'Crossbow bolts', type: 'misc', weight: 0, value: 0, createdAt: now(), updatedAt: now() } as any);
        new InventoryRepository(getDb()).addItem('varek', 'bolts', 5);
        await fight([
            varek({ attacksPerAction: 1, abilities: [{ name: 'Action Surge', grantsAction: true, ready: true }] }),
            rival({ legendaryActions: 3 })
        ]);
        expect((await swing()).d.error).toBeFalsy();
        const surge = await swing({ actionSurge: true, advantageSources: ['Gor Hunter'] });
        expect(surge.d).toMatchObject({ error: true, writes: 'none' });
        expect(tok('varek').abilities[0].ready).not.toBe(false);
        expect(tok('varek').extraActions ?? 0).toBe(0);
        const bonus = await swing({ bonusAction: true, advantageSources: ['Gor Hunter'] });
        expect(bonus.d).toMatchObject({ error: true, writes: 'none' });
        expect(tok('varek').bonusActionUsed).toBeFalsy();
        const shot = await swing({ ammoItemId: 'bolts', advantageSources: ['Gor Hunter'] });
        expect(shot.d).toMatchObject({ error: true, writes: 'none' });
        expect(new InventoryRepository(getDb()).getInventory('varek').items.find(i => i.itemId === 'bolts')!.quantity).toBe(5);
        const legendary = await act({ action: 'attack', actorId: 'rival', targetId: 'varek', attackBonus: 5, damage: 1, legendaryCost: 2, advantageSources: ['Wrath'] });
        expect(legendary.d).toMatchObject({ error: true, writes: 'none' });
        expect(tok('rival').legendaryActionsRemaining).toBe(3);
        // Only the one plain swing rolled.
        expect(rolls('varek', 'attack%')).toHaveLength(1);
        expect(rolls('rival', 'attack%')).toHaveLength(0);
        // The surge still answers once the name is dropped.
        const surged = await swing({ actionSurge: true });
        expect(surged.d.error).toBeFalsy();
        expect(tok('varek').abilities[0].ready).toBe(false);
    });

    it('the PC turn guard still reads the turn as untouched after a refused attack', async () => {
        await fight([varek(), rival()]);
        const bad = await swing({ advantageSources: ['Gor Hunter'] });
        expect(bad.d.writes).toBe('none');
        const adv = await manage({ action: 'advance' });
        expect(adv.error).toBe(true);
        expect(String(adv.message)).toMatch(/^TURN NOT TAKEN: Varek/);
    });

    it('output_mode summary keeps the teaching text and the call to paste', async () => {
        await fight([varek(), rival()]);
        const res = shapeReply(await actRaw({ encounterId: enc, action: 'attack', actorId: 'varek', targetId: 'rival', attackBonus: 5, damage: 1, advantageSources: ['Gor Hunter'] }), { mode: 'summary' });
        const summary = JSON.parse(res.content![0].text);
        expect(summary).toMatchObject({ error: true, writes: 'none' });
        expect(JSON.stringify(summary)).toContain(GOR);
    });
});

describe("a spell attack's lane is the spell's own", () => {
    it('Spiritual Weapon is a melee spell attack: attack:melee fires, attack:ranged does not', async () => {
        expect(getSpell('Spiritual Weapon')!.spellAttack).toBe('melee');
        sheet('cler', 'Cleric', {
            stats: { str: 10, dex: 10, con: 12, int: 10, wis: 18, cha: 10 }, level: 5, characterClass: 'cleric',
            knownSpells: ['Spiritual Weapon'], preparedSpells: ['Spiritual Weapon'],
            spellSlots: { level1: { current: 4, max: 4 }, level2: { current: 3, max: 3 }, level3: { current: 2, max: 2 } }, maxSpellLevel: 3
        });
        effect('cler', 'Holy Wrath', [{ type: 'advantage_on', value: 'attack:melee' }]);
        effect('cler', 'Far Sight', [{ type: 'advantage_on', value: 'attack:ranged' }]);
        await fight([
            { id: 'cler', name: 'Cleric', hp: 20, maxHp: 20, initiative: 20, position: { x: 0, y: 5 } },
            { id: 'grot', name: 'Grot', hp: 200, maxHp: 200, initiative: 10, isEnemy: true, ac: 12, position: { x: 6, y: 5 } }
        ]);
        const { d, r } = await act({ action: 'cast_spell', actorId: 'cler', spellName: 'Spiritual Weapon', targetId: 'grot', slotLevel: 2 });
        expect(d.error).toBeFalsy();
        expect(r.advantageSources).toEqual(['Holy Wrath (attack:melee)']);
        expect(rolls('cler', 'spell attack%')[0].purpose).toBe('spell attack (adv: Holy Wrath (attack:melee))');
    });
});

describe('output_mode summary keeps declared initiative', () => {
    it('create: the row keeps advantage and both dice, equal to the full row', async () => {
        effect('varek', 'Alert', [{ type: 'advantage_on', value: 'initiative' }]);
        const res = await manageRaw({ action: 'create', seed: 'summary-init', participants: [varek({ initiative: undefined, initiativeBonus: 2 }), rival()] });
        const full = json(res);
        const summary = JSON.parse(shapeReply(res as any, { mode: 'summary' }).content![0].text);
        const row = summary.initiative.find((r: any) => r.id === 'varek');
        expect(row.advantage).toEqual(['Alert (initiative)']);
        expect(row.rolls).toHaveLength(2);
        expect(summary.initiative).toEqual(full.initiative);
    });

    it('add_participant: the joiner row keeps them too', async () => {
        effect('varek', 'Slow Start', [{ type: 'disadvantage_on', value: 'check:dex' }]);
        await fight([rival()]);
        const res = await manageRaw({ encounterId: enc, action: 'add_participant', characterId: 'varek' });
        const full = json(res);
        const summary = JSON.parse(shapeReply(res as any, { mode: 'summary' }).content![0].text);
        expect(summary.initiative[0].disadvantage).toEqual(['Slow Start (check:dex)']);
        expect(summary.initiative[0].rolls).toHaveLength(2);
        expect(summary.initiative).toEqual(full.initiative);
    });
});

describe('a posted outcome', () => {
    it('checks no names, and says which it did not check', async () => {
        await fight([varek(), rival()]);
        const { d, r } = await swing({ outcome: 'hit', damage: 3, advantageSources: ['Gor Hunter'], disadvantageSources: ['Khorne'] });
        expect(d.error).toBeFalsy();
        expect(r.advantageSources).toBeUndefined();
        expect(r.situational).toEqual(expect.arrayContaining([
            'named sources not checked: posted outcome, no roll (adv: Gor Hunter; dis: Khorne)'
        ]));
        expect(tok('rival').hp).toBe(297);
    });
});

describe('cancellation and the other lanes', () => {
    it('declared advantage against a dodging target is one die; declared disadvantage against Help is one die', async () => {
        effect('varek', 'Bloodlust', [{ type: 'advantage_on', value: 'attack:melee' }]);
        await fight([varek({ attacksPerAction: 4 }), rival(), { id: 'ally', name: 'Ally', hp: 10, maxHp: 10, initiative: 15, position: { x: 0, y: 1 } }]);
        patchToken('rival', { isDodging: true });
        const dodged = await swing();
        expect(dodged.r.roll.allRolls).toHaveLength(1);
        expect(dodged.r.advantageSources).toEqual(['Bloodlust (attack:melee)']);
        patchToken('rival', { isDodging: false });
        patchToken('varek', { helpedBy: 'ally' });
        const helped = await swing({ situationalDisadvantage: 'the fog' });
        // Help and Bloodlust on one side, the fog on the other: one die.
        expect(helped.r.roll.allRolls).toHaveLength(1);
        expect(helped.r.disadvantageSources).toEqual(['GM: the fog']);
    });

    it('an opportunity attack is melee: it reads attack:melee even when its profile reaches less than the token (no attack:ranged)', async () => {
        effect('ogre', 'Brute', [{ type: 'advantage_on', value: 'attack:melee' }]);
        effect('ogre', 'Eagle Eye', [{ type: 'advantage_on', value: 'attack:ranged' }]);
        await fight([
            { id: 'hero', name: 'Hero', hp: 300, maxHp: 300, ac: 5, initiative: 20, position: { x: 2, y: 0 } },
            // A 10-ft reach on the token, a 5-ft fist as its default swing.
            { id: 'ogre', name: 'Ogre', hp: 300, maxHp: 300, ac: 10, initiative: 10, isEnemy: true, reach: 10, attacks: [{ name: 'Fist', attackBonus: 15, damage: '1', reachFt: 5, default: true }], position: { x: 0, y: 0 } }
        ]);
        const { r } = await act({ action: 'move', actorId: 'hero', targetPosition: { x: 5, y: 0 } });
        expect(r.opportunityAttacks).toHaveLength(1);
        expect(r.opportunityAttacks[0].advantageSources).toEqual(['Brute (attack:melee)']);
    });

    it('a volley is fire: with no grid it reads attack:ranged, never attack:melee', async () => {
        effect('scions', 'Drilled Volleys', [{ type: 'advantage_on', value: 'attack:ranged' }]);
        effect('scions', 'Spear Wall', [{ type: 'disadvantage_on', value: 'attack:melee' }]);
        await fight([
            { id: 'scions', name: 'Scions', hp: 50, maxHp: 50, initiative: 25, unit: { models: 10, hpPerModel: 5, packed: true, attackBonus: 6 } },
            { id: 'raiders', name: 'Raiders', hp: 300, maxHp: 300, ac: 10, initiative: 5, isEnemy: true }
        ]);
        const v = await act({ action: 'volley', actorId: 'scions', targetId: 'raiders' });
        expect(v.d.error).toBeFalsy();
        expect(v.r.advantageSources).toEqual(['Drilled Volleys (attack:ranged)']);
        expect(v.r.disadvantageSources).toBeUndefined();
        expect(v.r.roll.allRolls).toHaveLength(2);
    });

    it("a subdued reactor's opportunity attack takes declared advantage and still knocks out", async () => {
        effect('gob', 'Bloodlust', [{ type: 'advantage_on', value: 'attack:melee' }]);
        await fight([
            { id: 'hero', name: 'Hero', hp: 3, maxHp: 30, ac: 5, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'gob', name: 'Goblin', hp: 300, maxHp: 300, ac: 10, initiative: 10, isEnemy: true, attackBonus: 15, attackDamage: '10', subdue: true, position: { x: 1, y: 0 } }
        ]);
        const { r } = await act({ action: 'move', actorId: 'hero', targetPosition: { x: -3, y: 0 } });
        const oa = r.opportunityAttacks[0];
        expect(oa.allRolls).toHaveLength(2);
        expect(oa.advantageSources).toEqual(['Bloodlust (attack:melee)']);
        expect(oa.subdue.mode).toBe('non-lethal');
        expect(oa.knockedOut).toMatchObject({ by: 'gob', stable: true });
        expect(rolls('gob', 'opportunity attack%')[0].purpose).toBe('opportunity attack (adv: Bloodlust (attack:melee))');
    });
});
