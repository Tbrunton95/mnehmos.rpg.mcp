/**
 * F4: part lookup, merge-on-write, and attack source resolution.
 */
import { findPart, upsertPart, setPartOn, removePartFrom, resolveAttackSource } from '../../src/engine/combat/parts.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

const khorne: any = {
    parts: [
        { name: 'right arm', kind: 'arm', state: 'intact', holds: ['axe'] },
        { name: 'left arm', kind: 'arm', state: 'intact', holds: ['whip', 'offhand'] },
        { name: 'wings', kind: 'wing', state: 'intact' }
    ],
    attacks: [
        { name: 'axe', attackBonus: 14, damage: '3d12+8', part: 'right arm', default: true },
        { name: 'whip', attackBonus: 12, damage: '2d8+6', part: 'left arm' },
        { name: 'wing buffet', attackBonus: 12, damage: '2d6+6' }
    ]
};

describe('findPart', () => {
    it('matches case-insensitively and singular to plural', () => {
        expect(findPart(khorne, 'RIGHT ARM')?.name).toBe('right arm');
        expect(findPart(khorne, 'wing')?.name).toBe('wings');
        expect(findPart(khorne, 'left arms')?.name).toBe('left arm');
        expect(findPart(khorne, 'tail')).toBeUndefined();
        expect(findPart({}, 'arm')).toBeUndefined();
    });
});

describe('upsertPart', () => {
    it('merges into the existing part, keeping its name and every field not given', () => {
        const parts = [{ name: 'Jaw', kind: 'head', state: 'latched', latchedTo: { participantId: 'luciel' }, holds: ['bite'], ac: 18 }] as any;
        const next = upsertPart(parts, { name: 'jaw', state: 'crippled', note: 'shattered' } as any);
        expect(next[0]).toEqual({ name: 'Jaw', kind: 'head', state: 'crippled', latchedTo: { participantId: 'luciel' }, holds: ['bite'], ac: 18, note: 'shattered' });
        expect(parts[0].state).toBe('latched');
    });
    it('an explicit undefined clears a field; a new name appends', () => {
        const parts = [{ name: 'jaw', kind: 'head', state: 'latched', latchedTo: { participantId: 'luciel' } }] as any;
        expect(upsertPart(parts, { name: 'jaw', state: 'intact', latchedTo: undefined } as any)[0]).toEqual({ name: 'jaw', kind: 'head', state: 'intact' });
        expect(upsertPart(parts, { name: 'tail', kind: 'other', state: 'intact' } as any)).toHaveLength(2);
    });
});

describe('resolveAttackSource', () => {
    it('using names a profile exactly or by unique prefix, and brings its part', () => {
        const r = resolveAttackSource(khorne, { using: 'whip' });
        expect(r.profile?.name).toBe('whip');
        expect(r.part?.name).toBe('left arm');
        expect(resolveAttackSource(khorne, { using: 'Wing' }).profile?.name).toBe('wing buffet');
    });
    it('weapon is an alias of using', () => {
        expect(resolveAttackSource(khorne, { weapon: 'axe' }).part?.name).toBe('right arm');
    });
    it('an unknown profile throws with the list', () => {
        expect(() => resolveAttackSource(khorne, { using: 'claw' })).toThrow(/axe, whip, wing buffet/);
    });
    it('an explicit withPart wins over the profile part', () => {
        const r = resolveAttackSource(khorne, { using: 'axe', withPart: 'left arm' });
        expect(r.profile?.name).toBe('axe');
        expect(r.part?.name).toBe('left arm');
    });
    it('withPart may name a profile', () => {
        const r = resolveAttackSource(khorne, { withPart: 'whip' });
        expect(r.profile?.name).toBe('whip');
        expect(r.part?.name).toBe('left arm');
    });
    it('without profiles, weapon or hand finds the holding part', () => {
        const noProfiles = { parts: khorne.parts };
        expect(resolveAttackSource(noProfiles, { weapon: 'whip' }).part?.name).toBe('left arm');
        expect(resolveAttackSource(noProfiles, { hand: 'offhand' }).part?.name).toBe('left arm');
        const miss = resolveAttackSource(noProfiles, { weapon: 'spear' });
        expect(miss.part).toBeUndefined();
        expect(miss.notes.join(' ')).toMatch(/spear/);
    });
    it('nothing named resolves nothing', () => {
        expect(resolveAttackSource(khorne, {})).toEqual({ notes: [] });
    });
});

describe('set_part merges', () => {
    const ctx = { sessionId: 'f4' } as any;
    const json = (res: any, tag: string) => JSON.parse(res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`))![1]);
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => { closeDb(); clearCombatState(); });

    it('keeps holds, ac and latchedTo across a state change', async () => {
        const enc = json(await handleCombatManage({ action: 'create', participants: [
            { id: 'luciel', name: 'Luciel', hp: 300, maxHp: 300, initiative: 25 },
            { id: 'k', name: 'K', hp: 300, maxHp: 300, initiative: 5, isEnemy: true, parts: [
                { name: 'left arm', kind: 'arm', holds: ['whip'], ac: 20 },
                { name: 'jaw', kind: 'head', state: 'latched', latchedTo: { participantId: 'luciel' } }
            ] }
        ] }, ctx), 'COMBAT_MANAGE').encounterId;
        await handleCombatManage({ action: 'set_part', encounterId: enc, participantId: 'k', part: 'left arm', state: 'crippled' }, ctx);
        await handleCombatManage({ action: 'set_part', encounterId: enc, participantId: 'k', part: 'jaw', state: 'latched', note: 'grinding' }, ctx);
        const parts = (new EncounterRepository(getDb()).loadState(enc)!.participants as any[]).find(t => t.id === 'k').parts;
        expect(parts.find((p: any) => p.name === 'left arm')).toMatchObject({ kind: 'arm', state: 'crippled', holds: ['whip'], ac: 20 });
        expect(parts.find((p: any) => p.name === 'jaw')).toMatchObject({ state: 'latched', latchedTo: { participantId: 'luciel' }, note: 'grinding' });
        await handleCombatManage({ action: 'set_part', encounterId: enc, participantId: 'k', part: 'jaw', state: 'intact' }, ctx);
        const jaw = (new EncounterRepository(getDb()).loadState(enc)!.participants as any[]).find(t => t.id === 'k').parts.find((p: any) => p.name === 'jaw');
        expect(jaw.latchedTo).toBeUndefined();
    });
});

// Play report 6 #3: the token handler's merge rules, pure, so a scheduled
// set_part / remove_part can write the sheet and replay onto live tokens.
describe('setPartOn', () => {
    it('a new part takes the state given, kind other unless named; maxHp defaults to max(1, hp) when hp is first set', () => {
        const a = setPartOn([], { part: 'left arm', state: 'crippled' });
        expect(a.prev).toBeUndefined();
        expect(a.next).toEqual({ name: 'left arm', kind: 'other', state: 'crippled' });
        expect(a.parts).toEqual([a.next]);
        expect(setPartOn([], { part: 'left arm', state: 'crippled', kind: 'arm' }).next.kind).toBe('arm');
        expect(setPartOn([], { part: 'collar chain', state: 'intact', hp: 0 }).next).toMatchObject({ hp: 0, maxHp: 1 });
        expect(setPartOn([], { part: 'collar chain', state: 'intact', hp: 12 }).next).toMatchObject({ hp: 12, maxHp: 12 });
        expect(setPartOn([], { part: 'collar chain', state: 'intact', hp: 12, maxHp: 30 }).next).toMatchObject({ hp: 12, maxHp: 30 });
    });

    it('merges into the existing part by trimmed, case-insensitive name: kind, holds, ac, note and maxHp survive a state change', () => {
        const parts = [{ name: 'Left Arm', kind: 'arm', state: 'crippled', holds: ['claw'], ac: 15, note: 'torn', hp: 3, maxHp: 20 }] as any;
        const r = setPartOn(parts, { part: ' left arm ', state: 'intact' });
        expect(r.prev?.state).toBe('crippled');
        expect(r.next).toEqual({ name: 'Left Arm', kind: 'arm', state: 'intact', holds: ['claw'], ac: 15, note: 'torn', hp: 3, maxHp: 20 });
        expect(r.parts).toHaveLength(1);
        expect(parts[0].state).toBe('crippled');
        // hp given on a part that already has maxHp keeps that maxHp; the fields given replace.
        const h = setPartOn(parts, { part: 'left arm', state: 'intact', hp: 5, holds: ['claw', 'shield'], note: 'knitted' });
        expect(h.next).toMatchObject({ hp: 5, maxHp: 20, holds: ['claw', 'shield'], note: 'knitted', kind: 'arm' });
        // No singular/plural matching here: 'left arms' is a new part.
        expect(setPartOn(parts, { part: 'left arms', state: 'intact' }).parts).toHaveLength(2);
    });

    it('latchedTo lives only while latched: leaving latched drops it, staying latched keeps the previous hold, a new hold replaces it', () => {
        const parts = [{ name: 'jaw', kind: 'head', state: 'latched', latchedTo: { participantId: 'luciel', part: 'forearm' } }] as any;
        expect(setPartOn(parts, { part: 'jaw', state: 'crippled' }).next).toEqual({ name: 'jaw', kind: 'head', state: 'crippled' });
        expect(setPartOn(parts, { part: 'jaw', state: 'latched', note: 'tighter' }).next).toMatchObject({ state: 'latched', latchedTo: { participantId: 'luciel', part: 'forearm' }, note: 'tighter' });
        expect(setPartOn(parts, { part: 'jaw', state: 'latched', latchedTo: { participantId: 'orla' } }).next.latchedTo).toEqual({ participantId: 'orla' });
        // A hold passed with any other state is not kept.
        expect(setPartOn([], { part: 'jaw', state: 'intact', latchedTo: { participantId: 'orla' } }).next).toEqual({ name: 'jaw', kind: 'other', state: 'intact' });
    });
});

describe('removePartFrom', () => {
    it('removes by trimmed, case-insensitive name and returns what went; a name not present removes nothing', () => {
        const parts = [{ name: 'Left Arm', kind: 'arm', state: 'intact' }, { name: 'tail', kind: 'other', state: 'crippled' }] as any;
        const r = removePartFrom(parts, ' left arm ');
        expect(r.removed?.name).toBe('Left Arm');
        expect(r.parts.map((p: any) => p.name)).toEqual(['tail']);
        expect(parts).toHaveLength(2);
        const miss = removePartFrom(parts, 'left arms');
        expect(miss.removed).toBeUndefined();
        expect(miss.parts).toHaveLength(2);
    });
});
