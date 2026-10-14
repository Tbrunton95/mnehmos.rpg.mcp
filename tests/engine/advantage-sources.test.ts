import { resolveNamedSources, loadEffectNames, sourcesField, resolveAdvantageSources, situationalField, loadEffectDeclarations, type DeclaringOwner } from '../../src/engine/advantage-sources.js';
import type { RollScope } from '../../src/engine/advantage-scope.js';
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

    it('loadEffectDeclarations reads each active effect with its mechanics', () => {
        const repo = new CustomEffectsRepository(getDb());
        repo.apply({
            target_id: 'varek', target_type: 'character', name: 'Horn-Lock', description: 'x',
            category: 'neutral', power_level: 1, source: { type: 'unknown' },
            mechanics: [{ type: 'advantage_on', value: 'grapple', condition: 'head-on' }] as never, duration: { type: 'until_removed' as never },
            triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
        } as never);
        expect(loadEffectDeclarations(getDb(), 'varek')).toEqual([{ name: 'Horn-Lock', mechanics: [{ type: 'advantage_on', value: 'grapple', condition: 'head-on' }] }]);
        expect(loadEffectDeclarations(getDb(), 'nobody')).toEqual([]);
    });

    it('situationalField is a fresh reason string each call', () => {
        const a = situationalField('advantage'), b = situationalField('advantage');
        expect(a).not.toBe(b);
        expect(a.parse(' downhill ')).toBe('downhill');
        expect(a.parse(undefined)).toBeUndefined();
        expect(() => a.parse('')).toThrow();
        expect(() => a.parse(true)).toThrow();
        expect(a.description).toMatch(/advantage \(GM: <reason>\)/);
    });
});

/**
 * Play report 7 #7 and #8, the owner's spec: a named source grants only
 * what it declares for this roll. An effect declares it by a mechanic (the
 * scope grammar, or the older skill/save form); a standard condition by its
 * 5e rules; a skillAdvantage trait for its skills. Anything else is refused
 * with the reason and the call that would declare it.
 */
describe('resolveAdvantageSources: only what declares it', () => {
    const skill = (s: string, ability: 'str' | 'dex' | 'wis' = 'wis'): RollScope => ({ kind: 'check', skill: s, ability });
    const save = (ability: 'str' | 'dex' | 'wis'): RollScope => ({ kind: 'save', ability });
    const clinch: RollScope = { kind: 'grapple', move: 'clinch', skills: ['athletics'], abilities: ['str'] };
    const KEEN_SMELL = { name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent' };
    const varek: DeclaringOwner = {
        ownerId: 'varek', ownerName: 'Varek',
        conditions: [
            { name: 'Horn-Lock: locks horns with a rival head-on', on: 'sheet' },
            { name: 'Gor Hunter', on: 'sheet' },
            { name: 'Poisoned', source: 'bad water', on: 'sheet' },
            { name: 'restrained', source: 'grapple: hound', on: 'token' },
            { name: 'Exhaustion 3', on: 'sheet' },
            { name: 'Bulwark Stance', source: 'ritual', on: 'token' },
            { name: 'VAUREK: the ward-sigil', on: 'sheet' }
        ],
        effects: [
            { name: 'Horn-Lock', mechanics: [{ type: 'advantage_on', value: 'grapple', condition: 'head-on' }] },
            { name: 'Iron Will', mechanics: [{ type: 'advantage_on', value: 1, save: 'wisdom' }] },
            { name: 'Gor Strength', mechanics: [{ type: 'advantage_on', value: 'check:str' }] },
            { name: 'Iron Grip', mechanics: [{ type: 'custom_trigger', value: 'grip' }] },
            { name: 'VAUREK', mechanics: [{ type: 'advantage_on', value: 1, condition: 'vs Khorne', save: 'wisdom' }] }
        ],
        traits: [KEEN_SMELL, { name: 'Bull Neck', skills: ['athletics'], when: 'shove' }]
    };

    it("a tagged scoped effect named on a roll in its scope fires, and the log says the name asserted the tag", () => {
        expect(resolveAdvantageSources(['Horn-Lock'], 'advantage', varek, clinch)).toEqual({
            granted: [{ label: 'Horn-Lock (head-on, named)', lane: 'EFFECT', via: 'effect', name: 'Horn-Lock', tag: 'head-on', asserted: 'named' }],
            problems: []
        });
        const tagged = resolveAdvantageSources(['horn'], 'advantage', varek, clinch, ['head-on']);
        expect(tagged.granted.map(g => g.label)).toEqual(['Horn-Lock (head-on)']);
    });

    it('an effect declaring advantage elsewhere is refused with its scope and the edit that would declare it', () => {
        const r = resolveAdvantageSources(['Horn-Lock'], 'advantage', varek, save('wis'));
        expect(r.granted).toEqual([]);
        expect(r.problems).toEqual([`'Horn-Lock' grants no advantage on WIS saves (it declares advantage on grapple). To grant one, improvisation_manage edit_effect {targetId: 'varek', name: 'Horn-Lock', mechanics: [{"type":"advantage_on","value":"grapple","condition":"head-on"}, {type: 'advantage_on', value: 'save:wis'}]}; for a one-off, use situationalAdvantage: '<reason>'.`]);
        const grip = resolveAdvantageSources(['iron grip'], 'advantage', varek, clinch);
        expect(grip.problems).toEqual([`'Iron Grip' grants no advantage on a grapple (clinch). To grant one, improvisation_manage edit_effect {targetId: 'varek', name: 'Iron Grip', mechanics: [{"type":"custom_trigger","value":"grip"}, {type: 'advantage_on', value: 'grapple'}]}; for a one-off, use situationalAdvantage: '<reason>'.`]);
    });

    it('the older skill/save form still declares: Iron Will on a WIS save, not a DEX save', () => {
        expect(resolveAdvantageSources(['iron will'], 'advantage', varek, save('wis')).granted).toEqual([{ label: 'Iron Will', lane: 'EFFECT', via: 'effect', name: 'Iron Will' }]);
        const dex = resolveAdvantageSources(['iron will'], 'advantage', varek, save('dex'));
        expect(dex.problems[0]).toMatch(/^'Iron Will' grants no advantage on DEX saves \(it declares advantage on wisdom saves\)\./);
    });

    it("an untagged scoped effect named on a roll in scope grants under its own name (it fires anyway; the caller lists it once)", () => {
        expect(resolveAdvantageSources(['Gor Strength'], 'advantage', varek, clinch).granted).toEqual([{ label: 'Gor Strength', lane: 'ENGINE', via: 'effect', name: 'Gor Strength' }]);
    });

    it("a prose condition declares nothing: 'Gor Hunter' is refused with the conversion call", () => {
        const r = resolveAdvantageSources(['Gor Hunter'], 'advantage', varek, skill('stealth', 'dex'));
        expect(r.granted).toEqual([]);
        expect(r.problems).toEqual([`'Gor Hunter' grants no advantage on stealth. To grant one, improvisation_manage feature_from_condition {characterId: 'varek', match: 'Gor Hunter', mechanics: [{type: 'advantage_on', value: 'check:stealth'}]}; for a one-off, use situationalAdvantage: '<reason>'.`]);
        // A condition only on the token is converted by apply_effect.
        const bulwark = resolveAdvantageSources(['bulwark'], 'advantage', varek, clinch);
        expect(bulwark.problems).toEqual([`'Bulwark Stance' grants no advantage on a grapple (clinch). To grant one, improvisation_manage apply_effect {targetId: 'varek', name: 'Bulwark Stance', category: 'neutral', durationType: 'until_removed', mechanics: [{type: 'advantage_on', value: 'grapple'}]}; for a one-off, use situationalAdvantage: '<reason>'.`]);
    });

    it('a condition kept beside the feature made from it finds the feature\'s declaration', () => {
        expect(resolveAdvantageSources(['vaurek'], 'advantage', varek, save('wis')).granted).toEqual([{ label: 'VAUREK', lane: 'EFFECT', via: 'effect', name: 'VAUREK' }]);
    });

    it('standard conditions declare their 5e disadvantage: poisoned on checks, restrained on DEX saves, exhaustion 3+ on saves', () => {
        expect(resolveAdvantageSources(['poisoned'], 'disadvantage', varek, skill('perception')).granted).toEqual([{ label: 'Poisoned', lane: 'SHEET', via: 'condition', name: 'Poisoned' }]);
        expect(resolveAdvantageSources(['bad water'], 'disadvantage', varek, clinch).granted.map(g => g.label)).toEqual(['Poisoned']);
        expect(resolveAdvantageSources(['poisoned'], 'disadvantage', varek, { kind: 'check', ability: 'str' }).granted).toHaveLength(1);
        const poisonedSave = resolveAdvantageSources(['poisoned'], 'disadvantage', varek, save('wis'));
        expect(poisonedSave.problems).toEqual([`'Poisoned' grants no disadvantage on WIS saves (it declares disadvantage on attacks and ability checks). Standard conditions declare only their 5e rules; for a one-off, use situationalDisadvantage: '<reason>'.`]);
        const asAdvantage = resolveAdvantageSources(['poisoned'], 'advantage', varek, skill('perception'));
        expect(asAdvantage.problems[0]).toMatch(/^'Poisoned' grants no advantage on perception \(it declares disadvantage on attacks and ability checks\)\./);
        expect(resolveAdvantageSources(['restrained'], 'disadvantage', varek, save('dex')).granted.map(g => g.label)).toEqual(['Restrained']);
        expect(resolveAdvantageSources(['restrained'], 'disadvantage', varek, save('wis')).problems[0]).toMatch(/it declares disadvantage on attacks and DEX saves/);
        expect(resolveAdvantageSources(['exhaustion'], 'disadvantage', varek, save('wis')).granted.map(g => g.label)).toEqual(['Exhaustion 3']);
        const tired = { ...varek, conditions: [{ name: 'Exhaustion 1', on: 'sheet' as const }] };
        expect(resolveAdvantageSources(['exhaustion'], 'disadvantage', tired, save('wis')).problems).toHaveLength(1);
        expect(resolveAdvantageSources(['exhaustion'], 'disadvantage', tired, skill('perception')).granted).toHaveLength(1);
    });

    it('play report 7 #8: a skillAdvantage trait named on one of its skills fires as if its tag were given', () => {
        expect(resolveAdvantageSources(['Keen Smell'], 'advantage', varek, skill('perception')).granted).toEqual([{ label: 'Keen Smell (scent, named)', lane: 'SHEET', via: 'trait', name: 'Keen Smell', tag: 'scent', asserted: 'named' }]);
        expect(resolveAdvantageSources(['keen'], 'advantage', varek, skill('survival'), ['scent']).granted.map(g => g.label)).toEqual(['Keen Smell (scent)']);
        expect(resolveAdvantageSources(['bull neck'], 'advantage', varek, clinch).granted.map(g => g.label)).toEqual(['Bull Neck (shove, named)']);
    });

    it('a trait off its skills, on a save, on a grapple it does not cover or as disadvantage is refused with the call', () => {
        expect(resolveAdvantageSources(['Keen Smell'], 'advantage', varek, skill('insight')).problems).toEqual([
            `'Keen Smell' is Varek's skillAdvantage trait for perception, survival (when: scent); this is an insight check, so it does not apply — on a perception or survival check name it, or tag it: math_manage {action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent']}; nothing granted`
        ]);
        expect(resolveAdvantageSources(['Keen Smell'], 'advantage', varek, save('wis')).problems).toEqual([
            `'Keen Smell' is Varek's skillAdvantage trait for perception, survival (when: scent); saves and ability checks take no skill traits — roll it as math_manage {action: 'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent']}; nothing granted`
        ]);
        expect(resolveAdvantageSources(['Keen Smell'], 'advantage', varek, clinch).problems).toEqual([
            `'Keen Smell' is Varek's skillAdvantage trait for perception, survival (when: scent); a grapple rolls Athletics, so it does not apply; nothing granted`
        ]);
        expect(resolveAdvantageSources(['Keen Smell'], 'disadvantage', varek, skill('perception')).problems).toEqual([
            `'Keen Smell' is Varek's skillAdvantage trait: it grants advantage, not disadvantage; nothing granted`
        ]);
    });

    it('the miss, ambiguous and empty texts are the pinned ones', () => {
        const r = resolveAdvantageSources(['Khorne', '', 'iron'], 'advantage', varek, save('wis'));
        expect(r.problems).toEqual([
            'advantage source "Khorne" matches nothing in Varek\'s conditions or active effects — nothing granted',
            'advantage source "" is empty — nothing granted',
            'advantage source "iron" matches 2 conditions or effects by prefix [Iron Will | Iron Grip] — use more of the text; nothing granted'
        ]);
    });
});
