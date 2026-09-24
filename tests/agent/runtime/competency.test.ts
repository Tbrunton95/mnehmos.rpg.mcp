import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
    resolveCompetency,
    loadCompetencyLadder,
    validateOverride,
    ReasoningEffortSchema
} from '../../../src/agent/runtime/competency';
import { ReasoningEffortSchema as StoredReasoningEffortSchema } from '../../../src/schema/agent';

describe('competency mapping', () => {
    it('loads the canonical INT ladder from content config', () => {
        const ladder = loadCompetencyLadder();
        expect(ladder).toHaveLength(20);
        expect(ladder[0].int).toBe(1);
        expect(ladder[19].int).toBe(20);
    });

    // docs/bastion/07-competency-mapping.md "The active ladder (post-2026-06-02
    // override)": one model at every INT, depth carried by reasoning_effort.
    it('maps every INT score to the active ladder (gpt-5.5, effort by INT)', () => {
        const expected = [
            [1, 'none'], [2, 'none'], [3, 'none'], [4, 'none'], [5, 'none'], [6, 'none'],
            [7, 'low'], [8, 'low'], [9, 'low'], [10, 'low'],
            [11, 'medium'], [12, 'medium'], [13, 'medium'], [14, 'medium'],
            [15, 'high'], [16, 'high'], [17, 'high'], [18, 'high'],
            [19, 'xhigh'], [20, 'xhigh']
        ] as const;

        for (const [intStat, reasoningEffort] of expected) {
            expect(resolveCompetency(intStat)).toMatchObject({
                int: intStat,
                model: 'gpt-5.5',
                reasoningEffort,
                source: 'stat_derived'
            });
        }
    });

    it('keeps the two ReasoningEffort schemas in lockstep (ladder vs stored rows)', () => {
        expect(ReasoningEffortSchema.options).toEqual(StoredReasoningEffortSchema.options);
        expect(ReasoningEffortSchema.options).toContain('none');
    });

    it('rejects pro model variants in the ladder file', () => {
        const raw = readFileSync(resolve('config/competency-ladder.json'), 'utf8');
        expect(raw.toLowerCase()).not.toMatch(/-pro\b/);
    });

    it('clamps out-of-range INT to the nearest canonical rung', () => {
        expect(resolveCompetency(0).int).toBe(1);
        expect(resolveCompetency(30).int).toBe(20);
    });

    it('applies partial overrides and records override source', () => {
        expect(resolveCompetency(10, { reasoningEffort: 'high' })).toMatchObject({
            model: 'gpt-5.5',
            reasoningEffort: 'high',
            source: 'override'
        });
        expect(resolveCompetency(10, { model: 'gpt-4.1' })).toMatchObject({
            model: 'gpt-4.1',
            reasoningEffort: 'low',
            source: 'override'
        });
        expect(resolveCompetency(10, {
            model: 'openai/gpt-5.6-luna',
            reasoningEffort: 'medium'
        })).toMatchObject({
            model: 'openai/gpt-5.6-luna',
            reasoningEffort: 'medium',
            source: 'override'
        });
    });

    // FINDINGS #98: strict on write, lenient on read. A stored -pro override
    // degrades to the INT ladder with overrideError instead of throwing; the
    // write path refuses it via validateOverride.
    it('degrades a stored pro override to the INT ladder instead of throwing', () => {
        const resolved = resolveCompetency(20, { model: 'gpt-5.5-pro' });
        expect(resolved).toMatchObject({
            int: 20,
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
            source: 'stat_derived'
        });
        expect(resolved.overrideError).toMatch(/gpt-5\.5-pro/);
        expect(resolved.overrideError).toMatch(/no-pro-model/);
    });

    // The active ladder's 'none' (INT 1–6) and 'xhigh' (INT 19–20) are gpt-5.5
    // efforts. A model-only override inherits them; a reasoning model that
    // predates them (o-series, gpt-5/-mini/-nano) answers HTTP 400 to each, so
    // the resolver requests the nearest effort that model accepts.
    it('does not hand an inherited "none" to a reasoning model older than gpt-5.1', () => {
        for (const model of ['gpt-5-nano', 'gpt-5-mini', 'gpt-5', 'o3', 'openai/o4-mini']) {
            const resolved = resolveCompetency(4, { model });
            expect(resolved).toMatchObject({ model, reasoningEffort: null, source: 'override' });
            expect(resolved.overrideError).toBeUndefined();
        }
        expect(resolveCompetency(4, { model: 'gpt-5.1' }).reasoningEffort).toBe('none');
        expect(resolveCompetency(4, { model: 'openai/gpt-5.6-luna' }).reasoningEffort).toBe('none');
    });

    it('steps an inherited "xhigh" down to "high" for a model that lacks it', () => {
        for (const model of ['o3', 'gpt-5-mini', 'gpt-5.1']) {
            const resolved = resolveCompetency(19, { model });
            expect(resolved).toMatchObject({ model, reasoningEffort: 'high', source: 'override' });
            expect(resolved.overrideError).toBeUndefined();
        }
        expect(resolveCompetency(19, { model: 'gpt-5.4' }).reasoningEffort).toBe('xhigh');
    });

    it('leaves the effort alone for a non-reasoning model (it is never sent)', () => {
        expect(resolveCompetency(4, { model: 'gpt-4.1' }).reasoningEffort).toBe('none');
        expect(resolveCompetency(19, { model: 'gpt-4.1' }).reasoningEffort).toBe('xhigh');
    });

    // FINDINGS #98 again: an explicit pair the model cannot take is refused on
    // write, and a stored one loads, requests what the model takes, and says so.
    it('degrades a stored explicit effort the model cannot take, with overrideError', () => {
        const resolved = resolveCompetency(12, { model: 'o3', reasoningEffort: 'none' });
        expect(resolved).toMatchObject({ model: 'o3', reasoningEffort: null, source: 'override' });
        expect(resolved.overrideError).toMatch(/"none"[\s\S]*"o3"/);
        expect(resolveCompetency(12, { model: 'gpt-5-mini', reasoningEffort: 'xhigh' }))
            .toMatchObject({ reasoningEffort: 'high', source: 'override' });
    });

    it('refuses an explicit effort the override model cannot take on write', () => {
        expect(validateOverride({ model: 'o3', reasoningEffort: 'none' })).toMatch(/"none"[\s\S]*"o3"/);
        expect(validateOverride({ model: 'gpt-5-nano', reasoningEffort: 'none' })).toMatch(/"none"/);
        expect(validateOverride({ model: 'gpt-5-mini', reasoningEffort: 'xhigh' })).toMatch(/"xhigh"/);
        expect(validateOverride({ model: 'gpt-5-nano' })).toBeNull();
        expect(validateOverride({ model: 'gpt-5.5', reasoningEffort: 'none' })).toBeNull();
        expect(validateOverride({ model: 'o3', reasoningEffort: null })).toBeNull();
    });

    it('refuses pro model variants on write', () => {
        expect(validateOverride({ model: 'gpt-5.5-pro' })).toMatch(/refused[\s\S]*-pro/);
        expect(validateOverride({ model: 'gpt-5.5' })).toBeNull();
        expect(validateOverride({ reasoningEffort: 'none' })).toBeNull();
        expect(validateOverride(null)).toBeNull();
    });
});
