import { resolveNamedSources, loadEffectNames, sourcesField } from '../../src/engine/advantage-sources.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';

/**
 * Play report 4: the named-source resolver math_manage grew for wishlist item
 * 10 is shared with grapple. The problem texts are a contract — the
 * math_manage tests match them — so they are pinned here byte for byte.
 */
const owner = {
    ownerName: 'Kessa',
    conditions: [
        { name: 'VAUREK: the ward-sigil of the Iron Choir', source: 'Choir rite' },
        { name: 'Shaken by the Warp', source: 'daemon gaze' },
        { name: 'Shaken nerves' }
    ],
    effectNames: ['Iron Choir Blessing', 'Blessed', 'Blessed by Nurgle']
};

describe('resolveNamedSources', () => {
    it('matches a condition by its short name, full name or source, and an effect by name', () => {
        expect(resolveNamedSources(['vaurek'], 'advantage', owner)).toEqual({ labels: ['VAUREK'], problems: [] });
        expect(resolveNamedSources(['daemon gaze'], 'disadvantage', owner)).toEqual({ labels: ['Shaken by the Warp'], problems: [] });
        expect(resolveNamedSources(['iron choir blessing'], 'advantage', owner)).toEqual({ labels: ['Iron Choir Blessing'], problems: [] });
    });

    it('an exact name beats a longer name that contains it', () => {
        expect(resolveNamedSources(['Blessed'], 'advantage', owner).labels).toEqual(['Blessed']);
    });

    it('a miss, an ambiguous match and an empty text each report in the wording math_manage prints', () => {
        const miss = resolveNamedSources(['Khorne'], 'advantage', owner);
        expect(miss.labels).toEqual([]);
        expect(miss.problems).toEqual(['advantage source "Khorne" matches nothing in Kessa\'s conditions or active effects — nothing granted']);
        const amb = resolveNamedSources(['shaken'], 'disadvantage', owner);
        expect(amb.labels).toEqual([]);
        expect(amb.problems).toEqual(['disadvantage source "shaken" matches 2 conditions or effects by prefix [Shaken by the Warp | Shaken nerves] — use more of the text; nothing granted']);
        expect(resolveNamedSources([' '], 'advantage', owner).problems).toEqual(['advantage source "" is empty — nothing granted']);
    });

    it('resolves every text in order, keeping the hits and the misses apart', () => {
        const r = resolveNamedSources(['Khorne', 'vaurek', 'shaken', 'Blessed'], 'advantage', owner);
        expect(r.labels).toEqual(['VAUREK', 'Blessed']);
        expect(r.problems).toHaveLength(2);
        expect(r.problems[0]).toMatch(/^advantage source "Khorne"/);
        expect(r.problems[1]).toMatch(/^advantage source "shaken"/);
    });

    it('a condition on the token and the same one on the sheet count once', () => {
        const doubled = { ...owner, conditions: [{ name: 'Bulwark', source: 'ritual' }, { name: 'Bulwark', source: 'ritual' }] };
        expect(resolveNamedSources(['bulwark'], 'advantage', doubled)).toEqual({ labels: ['Bulwark'], problems: [] });
    });
});

describe('loadEffectNames and sourcesField', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); });
    afterEach(() => closeDb());

    it('loads only the active custom effects of that target', () => {
        const repo = new CustomEffectsRepository(getDb());
        const mk = (targetId: string, name: string) => repo.apply({
            target_id: targetId, target_type: 'character', name, description: name,
            category: 'neutral', power_level: 1, source: { type: 'unknown' },
            mechanics: [{ type: 'custom_trigger', value: name }] as never, duration: { type: 'until_removed' as never },
            triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
        } as never);
        mk('kessa', 'Iron Grip');
        mk('kessa', 'Blessed');
        mk('other', 'Not Hers');
        expect(loadEffectNames(getDb(), 'kessa').sort()).toEqual(['Blessed', 'Iron Grip']);
        expect(loadEffectNames(getDb(), 'nobody')).toEqual([]);
    });

    it('the schema field takes an array or a JSON string of one, and is a fresh instance each call', () => {
        const a = sourcesField('advantage'), b = sourcesField('advantage');
        expect(a).not.toBe(b);
        expect(a.parse(['x', 'y'])).toEqual(['x', 'y']);
        expect(a.parse('["x"]')).toEqual(['x']);
        expect(a.parse(undefined)).toBeUndefined();
        expect(a.description).toMatch(/names that grant advantage/);
        expect(sourcesField('disadvantage', 'refused outright').description).toMatch(/refused outright$/);
    });
});
