import { matchUniqueLabel } from '../../src/utils/match-label.js';

const c = (label: string, ...texts: string[]) => ({ label, texts: texts.length ? texts : [label], value: label });

describe('matchUniqueLabel', () => {
    it('an exact name beats a longer name that starts with it', () => {
        const r = matchUniqueLabel([c('Blessed by Nurgle'), c('Blessed')], 'blessed');
        expect(r).toEqual({ tier: 'exact', match: 'Blessed' });
    });

    it('a prefix beats a substring', () => {
        const r = matchUniqueLabel([c('Old Shaken'), c('Shaken nerves')], 'shaken');
        expect(r).toEqual({ tier: 'prefix', match: 'Shaken nerves' });
    });

    it('falls back to a substring', () => {
        expect(matchUniqueLabel([c('Mark of Khorne')], 'khorne')).toEqual({ tier: 'substring', match: 'Mark of Khorne' });
    });

    it('two hits on the deciding tier are ambiguous and name the tier', () => {
        const r = matchUniqueLabel([c('Shaken by the Warp'), c('Shaken nerves')], 'Shaken');
        expect(r).toEqual({ tier: 'prefix', ambiguous: ['Shaken by the Warp', 'Shaken nerves'] });
    });

    it('any text of a candidate counts, and one label counts once', () => {
        const r = matchUniqueLabel([c('VAUREK', 'VAUREK', 'VAUREK: the ward', 'Choir rite'), c('VAUREK')], 'choir rite');
        expect(r).toEqual({ tier: 'exact', match: 'VAUREK' });
        expect(matchUniqueLabel([c('A', 'x'), c('a', 'y')], 'x')).toEqual({ tier: 'exact', match: 'A' });
    });

    it('nothing matching says none', () => {
        expect(matchUniqueLabel([c('Blessed')], 'cursed')).toEqual({ none: true });
        expect(matchUniqueLabel([c('Blessed')], '  ')).toEqual({ none: true });
    });
});
