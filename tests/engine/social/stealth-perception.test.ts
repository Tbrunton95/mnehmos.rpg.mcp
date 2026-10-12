import { rollStealthVsPerception, batchRollStealthVsPerception } from '../../../src/engine/social/stealth-perception.js';

/**
 * Play report 2 #5: the eavesdrop layer rolls the same stealth/perception
 * number as roll_skill_check — an override replaces DEX/WIS + proficiency,
 * it never adds to it — and every d20 comes from the caller's logged roller.
 */
const sheet = (over: Record<string, unknown>) => ({
    id: 'x', name: 'X', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 10, level: 5,
    skillProficiencies: [] as string[], expertise: [] as string[], conditions: [] as Array<{ name: string }>, ...over
}) as any;

describe('rollStealthVsPerception', () => {
    const roll = () => 10;

    it('computes DEX + proficiency and WIS + proficiency from the sheets when the columns are null', () => {
        const speaker = sheet({ id: 's', stats: { str: 10, dex: 16, con: 10, int: 10, wis: 10, cha: 10 }, skillProficiencies: ['Stealth'], stealthBonus: null });
        const listener = sheet({ id: 'l', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 14, cha: 10 }, skillProficiencies: ['perception'] });
        const r = rollStealthVsPerception(speaker, listener, 0, { roll });
        expect(r.speakerModifier).toBe(6);   // +3 DEX, +3 prof at level 5
        expect(r.speakerSource).toBe('computed');
        expect(r.listenerModifier).toBe(5);  // +2 WIS, +3 prof
        expect(r.listenerSource).toBe('computed');
        expect(r.speakerTotal).toBe(16);
        expect(r.listenerTotal).toBe(15);
        expect(r.success).toBe(false);
        expect(r.margin).toBe(-1);
    });

    it('an override replaces the computed number; it does not add to it', () => {
        const speaker = sheet({ id: 's', stats: { str: 10, dex: 16, con: 10, int: 10, wis: 10, cha: 10 }, skillProficiencies: ['Stealth'], stealthBonus: 9 });
        const listener = sheet({ id: 'l', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 18, cha: 10 }, perceptionBonus: 0 });
        const r = rollStealthVsPerception(speaker, listener, 2, { roll });
        expect(r.speakerModifier).toBe(9);
        expect(r.speakerSource).toBe('override');
        expect(r.listenerModifier).toBe(2);  // override 0, plus the environment +2
        expect(r.listenerSource).toBe('override');
    });

    it('honours the world proficiency curve and tags each die for the caller', () => {
        const purposes: string[] = [];
        const speaker = sheet({ id: 's', skillProficiencies: ['stealth'] });
        const listener = sheet({ id: 'l', skillProficiencies: ['perception'] });
        const r = rollStealthVsPerception(speaker, listener, 0, {
            profBonus: () => 5,
            roll: (purpose, forId) => { purposes.push(`${purpose}:${forId}`); return purpose === 'stealth' ? 3 : 17; }
        });
        expect(r.speakerModifier).toBe(5);
        expect(r.listenerModifier).toBe(5);
        expect(r.speakerRoll).toBe(3);
        expect(r.listenerRoll).toBe(17);
        expect(purposes).toEqual(['stealth:s', 'perception:l']);
    });

    it('batch skips deafened listeners and forwards the roller', () => {
        const speaker = sheet({ id: 's' });
        const deaf = sheet({ id: 'd', conditions: [{ name: 'DEAFENED' }] });
        const hearing = sheet({ id: 'h' });
        const out = batchRollStealthVsPerception(speaker, [deaf, hearing], 0, { roll });
        expect([...out.keys()]).toEqual(['h']);
        expect(out.get('h')!.success).toBe(true);
    });
});
