import type { ReasoningEffort } from './types.js';

/**
 * Reasoning models consume completion budget for hidden reasoning as well as
 * visible text. Provider model identifiers may be namespaced (for example
 * `openai/gpt-5.6-luna` when routed through OpenRouter), so normalize the
 * optional namespace before checking the family.
 */
export function isReasoningModel(model: string): boolean {
    const normalized = model.toLowerCase().replace(/^[^/]+\//, '');
    return normalized.startsWith('o1')
        || normalized.startsWith('o3')
        || normalized.startsWith('o4')
        || normalized.startsWith('gpt-5');
}

/**
 * Whether a reasoning model accepts this `reasoning_effort`. OpenAI API
 * reference: models before gpt-5.1 (the o-series, the original
 * gpt-5/-mini/-nano) do not support `none`, and `xhigh` arrives after
 * gpt-5.1-codex-max (gpt-5.2 on). Either one sent to a model that lacks it is
 * an HTTP 400 on every call. Non-reasoning models never receive the field, so
 * they place no restriction here.
 */
export function supportsReasoningEffort(model: string, effort: ReasoningEffort): boolean {
    if (!isReasoningModel(model) || (effort !== 'none' && effort !== 'xhigh')) return true;
    const normalized = model.toLowerCase().replace(/^[^/]+\//, '');
    const version = /^gpt-(\d+)(?:\.(\d+))?/.exec(normalized);
    if (!version) return false; // o-series
    const [major, minor] = [Number(version[1]), Number(version[2] ?? 0)];
    return major > 5 || minor >= (effort === 'none' ? 1 : 2);
}

/**
 * The effort to request from `model`: `effort` when the model accepts it, else
 * the nearest one it does. `xhigh` steps down to `high`; `none` falls back to
 * null — no effort sent, so the model reasons at its default and gets the
 * default completion floor (the pre-'none' ladder behaviour).
 */
export function effortForModel(model: string, effort: ReasoningEffort | null): ReasoningEffort | null {
    if (effort === null || supportsReasoningEffort(model, effort)) return effort;
    return effort === 'xhigh' ? 'high' : null;
}

/**
 * `max_completion_tokens` caps hidden reasoning and visible output together.
 * A chat-sized ceiling can therefore produce an empty response before the
 * model has any room left to speak. The floor is only a minimum request; the
 * provider still bills the actual completion usage.
 *
 * `none` spends no hidden reasoning, so it needs no floor: the caller's cap
 * passes through and the preflight budget gate has nothing extra to fund.
 * resolveCompetency only lets `none` reach a model that accepts it
 * (effortForModel); anything older gets null and the medium floor.
 */
export const REASONING_COMPLETION_FLOOR: Record<ReasoningEffort, number> = {
    none: 0,
    low: 4096,
    medium: 8192,
    high: 16384,
    xhigh: 32768
};

export function reasoningCompletionFloor(effort?: ReasoningEffort | null): number {
    return effort ? REASONING_COMPLETION_FLOOR[effort] : REASONING_COMPLETION_FLOOR.medium;
}
