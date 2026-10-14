import {
    parseAdvantageScope, scopeCovers, scopedMechanic, validateAdvantageMechanics, scopedAdvantage,
    rollPhrase, suggestedScope, SCOPE_GRAPPLE_MOVES, SCOPE_GRAMMAR, type RollScope
} from '../../src/engine/advantage-scope.js';
import { autoAdvantage, applyDeclaredEffects, loadAutoMechanics, type AutoApplication } from '../../src/engine/effects-resolver.js';
import { loadEffectDeclarations } from '../../src/engine/advantage-sources.js';
import { CustomEffectsRepository } from '../../src/storage/repos/custom-effects.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { CombatActionTool } from '../../src/server/consolidated/combat-action.js';

/**
 * Play report 7 #7, the owner's spec: anything that changes a roll is
 * declared on an effect, as {type: 'advantage_on' | 'disadvantage_on',
 * value: '<scope>', condition: '<when-tag>'}. The scope grammar is fixed;
 * anything outside it is refused at write time naming the accepted forms. A
 * tagged mechanic fires only when the roll asserts its tag; an untagged one
 * fires on every roll in its scope. Mechanics written before the grammar
 * (a number in value, scoped by skill/save, autoApply) keep their meaning.
 */
const grapple = (move: string): RollScope => move === 'break'
    ? { kind: 'grapple', move, skills: ['athletics', 'acrobatics'], abilities: ['str', 'dex'] }
    : { kind: 'grapple', move, skills: ['athletics'], abilities: ['str'] };

describe('the scope grammar', () => {
    it('accepts every form, folding case and spacing to one canonical text', () => {
        const ok = (v: string) => { const r = parseAdvantageScope(v); if (!r.ok) throw new Error(r.problem); return r.text; };
        expect(ok('attack')).toBe('attack');
        expect(ok('Attack:Melee')).toBe('attack:melee');
        expect(ok('attack: ranged')).toBe('attack:ranged');
        expect(ok('grapple')).toBe('grapple');
        expect(ok('grapple:control')).toBe('grapple:control');
        expect(ok('GRAPPLE : Clinch')).toBe('grapple:clinch');
        expect(ok('check:athletics')).toBe('check:athletics');
        expect(ok('check:Sleight of Hand')).toBe('check:sleight_of_hand');
        expect(ok('check:sleight-of-hand')).toBe('check:sleight_of_hand');
        expect(ok('check:str')).toBe('check:str');
        expect(ok('check:Strength')).toBe('check:str');
        expect(ok('save:str')).toBe('save:str');
        expect(ok('save:Wisdom')).toBe('save:wis');
        expect(ok('initiative')).toBe('initiative');
    });

    it('refuses anything outside the grammar, naming the accepted forms', () => {
        for (const bad of ['stealth', 'attack:thrown', 'save', 'save:luck', 'check', 'grapple:hug', 'yes', 'initiative:dex', '']) {
            const r = parseAdvantageScope(bad);
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.problem).toContain(SCOPE_GRAMMAR);
        }
        const exec = parseAdvantageScope('grapple:execute');
        expect(exec.ok).toBe(false);
        if (!exec.ok) expect(exec.problem).toMatch(/execute rolls no contest/);
    });

    it('a check on a skill that is neither SRD nor an ability needs the world to define it', () => {
        const lenient = parseAdvantageScope('check:Waaagh Lore');
        expect(lenient.ok).toBe(true);
        const refused = parseAdvantageScope('check:haggling', { worldSkills: ['Waaagh Lore'] });
        expect(refused.ok).toBe(false);
        if (!refused.ok) {
            expect(refused.problem).toMatch(/'haggling' is not an SRD skill, an ability or a skill this world defines/);
            expect(refused.problem).toMatch(/Waaagh Lore/);
        }
        const world = parseAdvantageScope('check:waaagh-lore', { worldSkills: ['Waaagh Lore'] });
        expect(world.ok && world.text).toBe('check:waaagh_lore');
    });

    it('grapple moves are the grapple action\'s rolled moves (execute rolls none)', () => {
        const actionMoves = (CombatActionTool.actionSchemas.grapple.schema as any).shape.move.unwrap().options as string[];
        expect([...SCOPE_GRAPPLE_MOVES].sort()).toEqual(actionMoves.filter(m => m !== 'execute').sort());
    });
});

describe('which rolls a scope covers', () => {
    const cases: Array<[string, RollScope, boolean]> = [
        ['grapple', grapple('clinch'), true],
        ['grapple:control', grapple('control'), true],
        ['grapple:control', grapple('clinch'), false],
        ['check:athletics', grapple('clinch'), true],
        ['check:acrobatics', grapple('clinch'), false],
        ['check:acrobatics', grapple('break'), true],
        ['check:str', grapple('takedown'), true],
        ['check:dex', grapple('takedown'), false],
        ['check:str', { kind: 'check', skill: 'athletics', ability: 'str' }, true],
        ['check:str', { kind: 'check', skill: 'athletics', ability: 'dex' }, false],
        ['check:str', { kind: 'check', ability: 'str' }, true],
        ['check:athletics', { kind: 'check', ability: 'str' }, false],
        ['check:sleight_of_hand', { kind: 'check', skill: 'sleight_of_hand', ability: 'dex' }, true],
        ['check:stealth', { kind: 'check', skill: 'perception', ability: 'wis' }, false],
        ['save:dex', { kind: 'save', ability: 'dex' }, true],
        ['save:dex', { kind: 'save', ability: 'wis' }, false],
        ['save:dex', { kind: 'check', ability: 'dex' }, false],
        ['check:dex', { kind: 'save', ability: 'dex' }, false],
        ['attack', { kind: 'attack', range: 'melee' }, true],
        ['attack:ranged', { kind: 'attack', range: 'melee' }, false],
        ['attack:melee', { kind: 'attack', range: 'melee' }, true],
        ['attack', grapple('clinch'), false],
        ['grapple', { kind: 'attack', range: 'melee' }, false],
        ['initiative', { kind: 'initiative' }, true],
        // 5e: initiative is a Dexterity check.
        ['check:dex', { kind: 'initiative' }, true],
        ['check:str', { kind: 'initiative' }, false],
        ['initiative', { kind: 'check', ability: 'dex' }, false]
    ];
    it.each(cases)('%s on %j → %s', (value, roll, want) => {
        const r = parseAdvantageScope(value);
        expect(r.ok).toBe(true);
        if (r.ok) expect(scopeCovers(r.scope, roll)).toBe(want);
    });

    it('a roll is phrased for refusals and offers the scope that would cover it', () => {
        expect(rollPhrase({ kind: 'check', skill: 'stealth', ability: 'dex' })).toBe('stealth');
        expect(rollPhrase({ kind: 'check', ability: 'str' })).toBe('STR checks');
        expect(rollPhrase({ kind: 'save', ability: 'wis' })).toBe('WIS saves');
        expect(rollPhrase(grapple('clinch'))).toBe('a grapple (clinch)');
        expect(suggestedScope({ kind: 'check', skill: 'sleight_of_hand', ability: 'dex' })).toBe('check:sleight_of_hand');
        expect(suggestedScope({ kind: 'check', ability: 'str' })).toBe('check:str');
        expect(suggestedScope({ kind: 'save', ability: 'wis' })).toBe('save:wis');
        expect(suggestedScope(grapple('clinch'))).toBe('grapple');
    });
});

describe('scoped mechanics and the older form', () => {
    it('only a scope string with no skill, save or autoApply reads as the new grammar', () => {
        expect(scopedMechanic({ type: 'advantage_on', value: 'grapple', condition: 'head-on' })).toMatchObject({ which: 'advantage', text: 'grapple', tag: 'head-on' });
        expect(scopedMechanic({ type: 'disadvantage_on', value: 'save:dex' })).toMatchObject({ which: 'disadvantage', text: 'save:dex' });
        expect(scopedMechanic({ type: 'advantage_on', value: 'check:perception', condition: '' })?.tag).toBeUndefined();
        // The older form, exactly as stored before the grammar:
        expect(scopedMechanic({ type: 'advantage_on', value: 1, save: 'wisdom', autoApply: true })).toBeUndefined();
        expect(scopedMechanic({ type: 'advantage_on', value: 'yes', save: 'wisdom', autoApply: true })).toBeUndefined();
        expect(scopedMechanic({ type: 'advantage_on', value: 1, condition: 'vs Khorne' })).toBeUndefined();
        expect(scopedMechanic({ type: 'advantage_on', value: 'check:stealth', autoApply: true })).toBeUndefined();
        expect(scopedMechanic({ type: 'skill_bonus', value: 'check:stealth' })).toBeUndefined();
    });

    it('write-time validation: scopes are canonicalised, bad scopes and mixed forms refused, the older form untouched', () => {
        const ok = validateAdvantageMechanics([
            { type: 'advantage_on', value: 'Grapple', condition: 'head-on' },
            { type: 'disadvantage_on', value: 'save: Dexterity' },
            { type: 'advantage_on', value: 1, save: 'wisdom', autoApply: true },
            { type: 'advantage_on', value: 'yes', skill: 'stealth' },
            { type: 'skill_bonus', value: 2, skill: 'stealth' }
        ]);
        expect(ok.problems).toEqual([]);
        expect(ok.mechanics).toEqual([
            { type: 'advantage_on', value: 'grapple', condition: 'head-on' },
            { type: 'disadvantage_on', value: 'save:dex' },
            { type: 'advantage_on', value: 1, save: 'wisdom', autoApply: true },
            { type: 'advantage_on', value: 'yes', skill: 'stealth' },
            { type: 'skill_bonus', value: 2, skill: 'stealth' }
        ]);
        const bad = validateAdvantageMechanics([{ type: 'advantage_on', value: 'stealth checks' }]);
        expect(bad.problems).toHaveLength(1);
        expect(bad.problems[0]).toMatch(/^mechanics\[0\]: advantage_on value 'stealth checks' is not a scope/);
        expect(bad.problems[0]).toContain(SCOPE_GRAMMAR);
        const mixed = validateAdvantageMechanics([{ type: 'advantage_on', value: 'check:stealth', autoApply: true }, { type: 'disadvantage_on', value: 'save:dex', save: 'dexterity' }]);
        expect(mixed.problems).toHaveLength(2);
        expect(mixed.problems[0]).toMatch(/mechanics\[0\]: advantage_on value 'check:stealth' is a scope; autoApply belongs to the older form/);
        expect(mixed.problems[1]).toMatch(/mechanics\[1\].*save belongs to the older form/);
        const world = validateAdvantageMechanics([{ type: 'advantage_on', value: 'check:haggling' }], { worldSkills: [] });
        expect(world.problems[0]).toMatch(/'haggling' is not an SRD skill/);
    });

    it('untagged scoped mechanics fire on every roll in scope; tagged ones only on their tag', () => {
        const effects = [
            { name: 'Horn-Lock', mechanics: [{ type: 'advantage_on', value: 'grapple', condition: 'head-on' }] },
            { name: 'Gor Strength', mechanics: [{ type: 'advantage_on', value: 'check:str' }] },
            { name: 'Bad Knee', mechanics: [{ type: 'disadvantage_on', value: 'check:acrobatics' }] },
            { name: 'Old Charm', mechanics: [{ type: 'advantage_on', value: 1, condition: 'vs Khorne' }] }
        ];
        const bare = scopedAdvantage(effects, 'advantage', grapple('clinch'), []);
        expect(bare.fired).toEqual([{ label: 'Gor Strength', lane: 'ENGINE', effect: 'Gor Strength' }]);
        expect(bare.gated).toEqual([{ effect: 'Horn-Lock', tag: 'head-on', scope: 'grapple' }]);
        const headOn = scopedAdvantage(effects, 'advantage', grapple('clinch'), ['Head On']);
        expect(headOn.fired.map(f => f.label)).toEqual(['Horn-Lock (head-on)', 'Gor Strength']);
        expect(headOn.fired[0]).toMatchObject({ lane: 'EFFECT', tag: 'head-on' });
        expect(scopedAdvantage(effects, 'disadvantage', grapple('break'), []).fired.map(f => f.label)).toEqual(['Bad Knee']);
        expect(scopedAdvantage(effects, 'disadvantage', grapple('clinch'), []).fired).toEqual([]);
        expect(scopedAdvantage(effects, 'advantage', { kind: 'save', ability: 'str' }, ['head-on']).fired).toEqual([]);
    });
});

/**
 * The legacy fixtures (tests/engine/effects-resolver-advantage.test.ts and
 * math-saving-throw.test.ts) through the resolver after the grammar landed:
 * none of them reads as a scope, and autoAdvantage / applyDeclaredEffects
 * give exactly what they gave before, also beside a scoped mechanic.
 */
describe('legacy advantage mechanics keep their exact behaviour', () => {
    function effect(name: string, mechanics: unknown[]) {
        new CustomEffectsRepository(getDb()).apply({
            target_id: 'vex', target_type: 'character', name, description: name,
            category: 'neutral', power_level: 1, source: { type: 'unknown' },
            mechanics: mechanics as never, duration: { type: 'until_removed' as never },
            triggers: [], removal_conditions: [{ type: 'duration_expires' as const }], stackable: false, max_stacks: 1
        } as never);
    }
    const LEGACY: Array<[string, unknown[]]> = [
        ['Iron Will', [{ type: 'advantage_on', value: 1, save: 'wisdom', autoApply: true }]],
        ['Clumsy', [{ type: 'disadvantage_on', value: 1, skill: 'acrobatics', autoApply: true }]],
        ['Keen Nose', [{ type: 'advantage_on', value: 1, condition: 'perception', autoApply: true }]],
        ['Vs Khorne', [{ type: 'advantage_on', value: 1, condition: 'vs Khorne' }]],
        ['Blessed', [{ type: 'advantage_on', value: 'yes', save: 'wisdom', autoApply: true }]],
        ['VAUREK', [{ type: 'advantage_on', value: 1, condition: 'vs Khorne', save: 'wisdom' }]],
        ['Hexed', [{ type: 'disadvantage_on', value: 1, skill: 'stealth' }]],
        ['Oathbound', [{ type: 'advantage_on', value: 1, condition: 'vs Khorne' }]]
    ];
    beforeEach(() => { closeDb(); getDb(':memory:'); for (const [n, m] of LEGACY) effect(n, m); });
    afterEach(() => closeDb());

    const run = () => {
        const mechs = loadAutoMechanics(getDb(), 'vex');
        const auto = (kind: 'save' | 'skill', domain: string) => { const o = { adv: [] as string[], dis: [] as string[] }; autoAdvantage(mechs, kind, domain, o); return o; };
        const declared = (name: string, want: string, domain: string) => { const applied: AutoApplication[] = []; const r = applyDeclaredEffects(getDb(), 'vex', [{ name }], want, applied, domain); return { ...r, applied }; };
        return {
            wis: auto('save', 'wisdom'), dex: auto('save', 'dexterity'), acro: auto('skill', 'acrobatics'), perc: auto('skill', 'perception'), stealth: auto('skill', 'stealth'),
            vaurekWis: declared('VAUREK', 'saving_throw_bonus', 'wisdom'), vaurekDex: declared('VAUREK', 'saving_throw_bonus', 'dexterity'),
            hexed: declared('Hexed', 'skill_bonus', 'stealth'), oath: declared('Oathbound', 'saving_throw_bonus', 'dexterity')
        };
    };

    it('none of the fixtures reads as a scope', () => {
        const decl = loadEffectDeclarations(getDb(), 'vex');
        expect(decl.map(d => d.name).sort()).toEqual(LEGACY.map(([n]) => n).sort());
        for (const d of decl) for (const m of d.mechanics) expect(scopedMechanic(m)).toBeUndefined();
        expect(scopedAdvantage(decl, 'advantage', { kind: 'save', ability: 'wis' }, ['vs Khorne']).fired).toEqual([]);
    });

    it('autoAdvantage and applyDeclaredEffects give what they gave before, and still do beside scoped mechanics', () => {
        const before = run();
        expect(before.wis).toEqual({ adv: ['Iron Will', 'Blessed'], dis: [] });
        expect(before.dex).toEqual({ adv: [], dis: [] });
        expect(before.acro).toEqual({ adv: [], dis: ['Clumsy'] });
        expect(before.perc.adv).toEqual(['Keen Nose']);
        expect(before.vaurekWis).toMatchObject({ total: 0, problems: [], advantage: ['VAUREK (vs Khorne)'], disadvantage: [], applied: [] });
        expect(before.vaurekDex.advantage).toEqual([]);
        expect(before.vaurekDex.problems).toHaveLength(1);
        expect(before.hexed).toMatchObject({ disadvantage: ['Hexed'], problems: [] });
        expect(before.oath).toMatchObject({ advantage: ['Oathbound (vs Khorne)'], problems: [] });
        // A scoped mechanic on the same sheet changes none of it.
        effect('Horn-Lock', [{ type: 'advantage_on', value: 'grapple', condition: 'head-on' }]);
        effect('Gor Strength', [{ type: 'advantage_on', value: 'check:str' }]);
        effect('Nimble', [{ type: 'advantage_on', value: 'save:dex' }]);
        expect(run()).toEqual(before);
    });

    it('declaredEffects naming a scoped effect says where its advantage lives and applies nothing', () => {
        effect('Horn-Lock', [{ type: 'advantage_on', value: 'grapple', condition: 'head-on' }]);
        const r = applyDeclaredEffects(getDb(), 'vex', [{ name: 'Horn-Lock' }], 'skill_bonus', [], 'athletics');
        expect(r.advantage).toEqual([]);
        expect(r.problems).toEqual(["declared effect \"Horn-Lock\" declares its advantage by scope (grapple, when head-on): name it in advantageSources or pass context: ['head-on'] — nothing applied through declaredEffects"]);
    });
});
