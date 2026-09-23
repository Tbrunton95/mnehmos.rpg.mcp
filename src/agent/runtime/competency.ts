import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { z } from 'zod';

export const ReasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const CompetencySourceSchema = z.enum(['stat_derived', 'override']);
export type CompetencySource = z.infer<typeof CompetencySourceSchema>;

export const CompetencyOverrideSchema = z.object({
    model: z.string().min(1).optional(),
    reasoningEffort: ReasoningEffortSchema.nullable().optional()
});
export type CompetencyOverride = z.infer<typeof CompetencyOverrideSchema>;

const CompetencyLadderEntrySchema = z.object({
    int: z.number().int().min(1).max(20),
    tier: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: ReasoningEffortSchema.nullable()
});
export type CompetencyLadderEntry = z.infer<typeof CompetencyLadderEntrySchema>;

export interface ResolvedCompetency extends CompetencyLadderEntry {
    source: CompetencySource;
    overrideError?: string;
}

const LADDER_PATH = fileURLToPath(new URL('../../../config/competency-ladder.json', import.meta.url));

function assertNoProModel(model: string): void {
    if (/-pro\b/i.test(model)) {
        throw new Error(`Competency model "${model}" violates the no-pro-model rule`);
    }
}

function validateLadder(ladder: CompetencyLadderEntry[]): CompetencyLadderEntry[] {
    if (ladder.length !== 20) {
        throw new Error(`Competency ladder must contain 20 rows, found ${ladder.length}`);
    }

    for (let index = 0; index < ladder.length; index++) {
        const expectedInt = index + 1;
        const entry = ladder[index];
        if (entry.int !== expectedInt) {
            throw new Error(`Competency ladder row ${index} must map INT ${expectedInt}`);
        }
        assertNoProModel(entry.model);
    }

    return ladder;
}

export function loadCompetencyLadder(path = LADDER_PATH): CompetencyLadderEntry[] {
    const raw = readFileSync(path, 'utf8');
    const parsed = z.array(CompetencyLadderEntrySchema).parse(JSON.parse(raw));
    return validateLadder(parsed);
}

function clampInt(intStat: number): number {
    if (!Number.isFinite(intStat)) return 1;
    return Math.min(20, Math.max(1, Math.trunc(intStat)));
}

export function resolveCompetency(
    intStat: number,
    override?: CompetencyOverride | null
): ResolvedCompetency {
    const int = clampInt(intStat);
    const entry = loadCompetencyLadder()[int - 1];
    const hasOverride = override !== null && override !== undefined
        && (override.model !== undefined || override.reasoningEffort !== undefined);

    // FINDINGS #98 (KEEPER 1.1): STRICT ON WRITE, LENIENT ON READ. A stored
    // override that violates the model rule used to THROW here — and since
    // every get/list/invoke/update/delete loads the row through this resolve,
    // one bad write bricked the agent with no tool-side recovery. Now a bad
    // override DEGRADES to the INT ladder with overrideError attached; the
    // write path refuses bad overrides before persisting (validateOverride).
    const model = override?.model ?? entry.model;
    try {
        assertNoProModel(model);
    } catch (e) {
        return {
            ...entry,
            int,
            source: 'stat_derived',
            overrideError: `stored override model "${override?.model}" is invalid (${e instanceof Error ? e.message : String(e)}) — serving the INT-ladder model; clear or fix via agent_manage update {competencyOverride}`
        };
    }

    return {
        ...entry,
        int,
        model,
        reasoningEffort: override?.reasoningEffort !== undefined
            ? override.reasoningEffort
            : entry.reasoningEffort,
        source: hasOverride ? 'override' : 'stat_derived'
    };
}

// FINDINGS #98: the WRITE-SIDE gate — call BEFORE persisting an override.
// Returns null when valid, or an honest error naming the actual rule and the
// ladder's known-good models (the allowlist was previously discoverable only
// by trial and error, and trial and error is how rows got bricked).
export function validateOverride(override?: CompetencyOverride | null): string | null {
    if (!override || override.model === undefined) return null;
    try {
        assertNoProModel(override.model);
        return null;
    } catch {
        const known = [...new Set(loadCompetencyLadder().map(e => e.model))].join(', ');
        return `Model "${override.model}" is refused (rule: no -pro model variants). Known-good ladder models: ${known}. Test any other string on a disposable agent before a live one.`;
    }
}
