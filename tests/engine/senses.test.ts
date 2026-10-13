/**
 * Play report 5 #8c: the pure half of trait advantage. A skillAdvantage trait
 * is data on the sheet ({name, skills, when, passiveBonus?, note?}); a check
 * tagged with a context that matches `when` gets advantage; a sense denial on
 * the scene (scene-wide or per target) switches it off with a reason; a scene
 * wind plus two positions says whether a source is upwind, downwind or
 * crosswind of a sniffer; passives are 10 + the modifier (+ passiveBonus for
 * the sense).
 */
import {
    matchSkillAdvantage, normalizeSenseDenial, denialFor, parseWind, windRelation, passivePerception, sensePassives
} from '../../src/engine/senses.js';

const traits = [
    { name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent', passiveBonus: 5, note: 'scent-based Perception; tracking by scent' },
    { name: 'Stonecunning', skills: ['history'], when: 'stonework' },
    { name: 'Sure-Footed', skills: ['Acrobatics'], when: 'ice' }
];

describe('matchSkillAdvantage: a tagged check fires the trait, an untagged one is only hinted', () => {
    it('perception tagged scent applies Keen Smell with its label', () => {
        const m = matchSkillAdvantage(traits, 'perception', ['scent']);
        expect(m.applied).toEqual([{ name: 'Keen Smell', when: 'scent', label: 'Keen Smell (scent)', passiveBonus: 5 }]);
        expect(m.gated).toEqual([]);
    });
    it('an untagged perception check applies nothing and names the gated trait', () => {
        const m = matchSkillAdvantage(traits, 'perception', []);
        expect(m.applied).toEqual([]);
        expect(m.gated.map(g => g.label)).toEqual(['Keen Smell (scent)']);
    });
    it('tags and skills are case- and separator-insensitive', () => {
        expect(matchSkillAdvantage(traits, 'Perception', ['Scent']).applied).toHaveLength(1);
        expect(matchSkillAdvantage(traits, 'acrobatics', ['ICE']).applied[0].name).toBe('Sure-Footed');
        expect(matchSkillAdvantage(traits, 'sleight of hand', ['scent']).applied).toEqual([]);
    });
    it('the same tag on another skill the trait does not list fires nothing', () => {
        expect(matchSkillAdvantage(traits, 'insight', ['scent'])).toEqual({ applied: [], gated: [] });
        expect(matchSkillAdvantage(traits, 'survival', ['scent']).applied[0].name).toBe('Keen Smell');
        expect(matchSkillAdvantage(traits, 'history', ['stonework']).applied[0].label).toBe('Stonecunning (stonework)');
    });
    it('no traits, no context, undefined: nothing', () => {
        expect(matchSkillAdvantage(undefined, 'perception', ['scent'])).toEqual({ applied: [], gated: [] });
        expect(matchSkillAdvantage(traits, 'perception', undefined).applied).toEqual([]);
    });
});

describe('normalizeSenseDenial: the two shapes the GM states', () => {
    it('a scene-wide object', () => {
        expect(normalizeSenseDenial({ scent: 'wind from the east carries everything away' })).toEqual([{ senses: { scent: 'wind from the east carries everything away' } }]);
    });
    it('one target', () => {
        expect(normalizeSenseDenial({ targetId: 'varek', scent: 'buried in peat-smoke' })).toEqual([{ targetId: 'varek', senses: { scent: 'buried in peat-smoke' } }]);
    });
    it('an array of either; empty and absent are no denial', () => {
        expect(normalizeSenseDenial([{ scent: 'a' }, { targetId: 'v', hearing: 'b', scent: 'c' }])).toEqual([
            { senses: { scent: 'a' } }, { targetId: 'v', senses: { hearing: 'b', scent: 'c' } }
        ]);
        expect(normalizeSenseDenial(undefined)).toEqual([]);
        expect(normalizeSenseDenial(null)).toEqual([]);
        expect(normalizeSenseDenial({})).toEqual([]);
    });
});

describe('denialFor: a target entry beats a scene-wide one; tags are case-insensitive', () => {
    const entries = normalizeSenseDenial([{ scent: 'the wind is wrong' }, { targetId: 'varek', scent: 'peat-smoke', hearing: 'ringing ears' }]);
    it('names the reason', () => {
        expect(denialFor(entries, 'varek', 'scent')).toBe('peat-smoke');
        expect(denialFor(entries, 'orla', 'Scent')).toBe('the wind is wrong');
        expect(denialFor(entries, 'varek', 'hearing')).toBe('ringing ears');
        expect(denialFor(entries, 'orla', 'hearing')).toBeUndefined();
        expect(denialFor([], 'varek', 'scent')).toBeUndefined();
    });
});

describe('parseWind and windRelation: east is +x, north is -y (map rows grow downward)', () => {
    it("parses 'from W', 'from the north-east', 'E', 'west wind' and refuses nonsense", () => {
        expect(parseWind('from W')).toEqual({ from: 'W', travel: { x: 1, y: 0 } });
        expect(parseWind('from the north-east')!.from).toBe('NE');
        expect(parseWind('from the north-east')!.travel.x).toBeCloseTo(-Math.SQRT1_2);
        expect(parseWind('from the north-east')!.travel.y).toBeCloseTo(Math.SQRT1_2);
        expect(parseWind('E')).toEqual({ from: 'E', travel: { x: -1, y: 0 } });
        expect(parseWind('north wind')).toEqual({ from: 'N', travel: { x: 0, y: 1 } });
        expect(parseWind('still')).toBeUndefined();
        expect(parseWind('')).toBeUndefined();
    });
    it('a source east of the sniffer in a west wind is downwind (its scent is carried away); west of it is upwind; north of it is crosswind', () => {
        const wind = parseWind('from W')!;
        expect(windRelation(wind, { x: 0, y: 0 }, { x: 4, y: 0 })).toBe('downwind');
        expect(windRelation(wind, { x: 0, y: 0 }, { x: -4, y: 0 })).toBe('upwind');
        expect(windRelation(wind, { x: 0, y: 0 }, { x: 0, y: 4 })).toBe('crosswind');
        expect(windRelation(wind, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe('crosswind');
    });
});

describe('passives', () => {
    const sheet = { stats: { str: 10, dex: 10, con: 10, int: 10, wis: 12, cha: 10 }, level: 1, skillProficiencies: [], expertise: [], skillAdvantage: traits } as any;
    it('passive Perception is 10 + the one perception number; the sense passive adds the trait bonus (default 5)', () => {
        expect(passivePerception(sheet, 2)).toBe(11);
        expect(sensePassives(sheet, 2)).toEqual([{ when: 'scent', trait: 'Keen Smell', value: 16, label: 'passive Perception (scent) 16' }]);
        const noBonus = { ...sheet, skillAdvantage: [{ name: 'Keen Hearing', skills: ['perception'], when: 'hearing' }] };
        expect(sensePassives(noBonus, 2)).toEqual([{ when: 'hearing', trait: 'Keen Hearing', value: 16, label: 'passive Perception (hearing) 16' }]);
        expect(sensePassives({ ...sheet, skillAdvantage: undefined }, 2)).toEqual([]);
    });
    it('an override column replaces the computed perception in the passive too', () => {
        expect(passivePerception({ ...sheet, perceptionBonus: 7 }, 2)).toBe(17);
    });
});
