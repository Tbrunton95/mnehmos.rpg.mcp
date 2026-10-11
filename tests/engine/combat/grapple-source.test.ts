import { describe, it, expect } from 'vitest';
import { sourceNamesHolder, holderMatch, grappleSource, HOLD_CONDITIONS, PIN_CONDITIONS, HELPLESS_CONDITIONS, helplessReason } from '../../../src/engine/combat/conditions.js';

/**
 * Play report 2, item 2: a pin was recognised only when its source was
 * exactly 'grapple: <actor id>'. One shared matcher now reads every way a
 * GM writes the holder: the canonical source, a prefixed one ('pinned by
 * Marine'), or the bare id or name. The whole remainder must name the
 * holder; a substring never does.
 */
const marine = { id: 'marine-uuid', name: 'Marine' };

describe('sourceNamesHolder', () => {
    it.each([
        'grapple: marine-uuid', 'grapple:marine-uuid', 'grapple: Marine', 'GRAPPLE: MARINE',
        'grappled by Marine', 'Grappled by marine-uuid', 'pinned by Marine', 'held by Marine', 'grabbed by Marine',
        'held: Marine', 'grapple - Marine', 'grapple – marine-uuid',
        'Marine', 'marine', 'marine-uuid', '  Marine  '
    ])("names the holder: '%s'", (source) => {
        expect(sourceNamesHolder(source, marine)).toBe(true);
    });

    it.each([
        'spell: Web', 'Marines', 'the Marine', 'grapple: Marine 2', 'grapple: marine-uuid-2', 'Marine grapple',
        'Brute', 'grapple: brute', '', '   '
    ])("does not name the holder: '%s'", (source) => {
        expect(sourceNamesHolder(source, marine)).toBe(false);
    });

    it('an undefined source names nobody', () => {
        expect(sourceNamesHolder(undefined, marine)).toBe(false);
    });

    it('a holder whose name begins with a prefix word still matches its own bare name', () => {
        expect(sourceNamesHolder('Held Thorsson', { id: 'x', name: 'Held Thorsson' })).toBe(true);
        expect(sourceNamesHolder('Grappler', { id: 'y', name: 'Grappler' })).toBe(true);
        expect(sourceNamesHolder('grapple: Held Thorsson', { id: 'x', name: 'Held Thorsson' })).toBe(true);
        // ... and does not match someone it only shares the prefix word with.
        expect(sourceNamesHolder('Held Thorsson', { id: 'z', name: 'Thorsson' })).toBe(true);
        expect(sourceNamesHolder('Held Thorsson', { id: 'w', name: 'Held' })).toBe(false);
    });

    it('holderMatch tells a prefixed source from a bare one', () => {
        expect(holderMatch('grapple: marine-uuid', marine)).toBe('prefixed');
        expect(holderMatch('pinned by Marine', marine)).toBe('prefixed');
        expect(holderMatch('Marine', marine)).toBe('bare');
        expect(holderMatch('marine-uuid', marine)).toBe('bare');
        expect(holderMatch('Held Thorsson', { id: 'x', name: 'Held Thorsson' })).toBe('bare');
        expect(holderMatch('spell: Web', marine)).toBeNull();
        expect(holderMatch(undefined, marine)).toBeNull();
    });

    it('grappleSource writes the canonical form the engine reads back', () => {
        expect(grappleSource('marine-uuid')).toBe('grapple: marine-uuid');
        expect(sourceNamesHolder(grappleSource(marine.id), marine)).toBe(true);
    });

    it('the hold and pin lists', () => {
        expect([...HOLD_CONDITIONS]).toEqual(['clinched', 'grappled', 'restrained', 'pinned']);
        expect([...PIN_CONDITIONS]).toEqual(['restrained', 'pinned']);
    });
});

describe('helplessReason (item 3)', () => {
    it('names the helpless condition with its own label, or 0 HP', () => {
        expect(HELPLESS_CONDITIONS).toEqual(expect.arrayContaining(['unconscious', 'asleep', 'incapacitated', 'paralyzed', 'paralysed', 'stunned', 'petrified']));
        expect(helplessReason({ name: 'Cultist', hp: 10, conditions: [{ type: 'unconscious' }] })).toBe('Cultist is unconscious');
        expect(helplessReason({ name: 'Cultist', hp: 10, conditions: [{ name: 'Asleep' }] })).toBe('Cultist is Asleep');
        expect(helplessReason({ name: 'Cultist', hp: 10, conditions: [{ name: 'Paralysed' }] })).toBe('Cultist is Paralysed');
        expect(helplessReason({ name: 'Cultist', hp: 0, conditions: [] })).toBe('Cultist is at 0 HP');
        expect(helplessReason({ name: 'Cultist', conditions: [{ type: 'prone' }, { type: 'grappled' }] })).toBeUndefined();
        expect(helplessReason({ name: 'Cultist', hp: 5 })).toBeUndefined();
    });
});
