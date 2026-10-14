/**
 * Action Router - Generic routing for consolidated MCP tools
 *
 * TIER 1 Token Efficiency Optimization
 *
 * Provides a generic framework for routing action-based tools:
 * - Parses action parameter with fuzzy matching
 * - Routes to appropriate handler based on action
 * - Handles common patterns (CRUD, domain-specific)
 * - Provides consistent response formatting
 *
 * Usage:
 *   const router = createActionRouter(ACTIONS, commonSchema, handlers);
 *   const result = await router(args);
 */

import { z } from 'zod';
import {
    matchAction,
    isGuidingError,
    formatGuidingError,
    similarity,
    MatchResult
} from './fuzzy-enum.js';
import type { SessionContext } from '../server/types.js';
import { keepsUnknownKeys, shapeOf } from './zod-shape.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Handler function for a specific action
 */
export type ActionHandler<TArgs = unknown, TResult = unknown> = (
    args: TArgs
) => Promise<TResult> | TResult;

/**
 * Definition for a single action within a consolidated tool
 *
 * Note: Handler uses 'any' for flexibility since Zod schema validates at runtime.
 * This allows typed handlers to be assigned without explicit casts.
 */
export interface ActionDefinition {
    /** Zod schema for action-specific parameters */
    schema: z.ZodType<any>;
    /** Handler function for this action (validated args from schema) */
    handler: (args: any, ctx?: SessionContext) => Promise<unknown> | unknown;
    /** Optional aliases for this action (e.g., 'new' -> 'create') */
    aliases?: string[];
    /** Description for documentation */
    description?: string;
    /**
     * Play report 2 #10 / play report 4 #2: what happens to keys the action
     * schema does not declare. 'warn' (the router's default) still runs the
     * handler but the success reply carries `ignoredParams: [...]` and a
     * message line naming each key with its nearest valid key (or the hint
     * from unknownKeyHints). 'strip' drops them silently, as Zod does — a
     * per-action opt-out for the rare action whose callers legitimately send
     * keys it never reads. Unset here, the router's own setting applies.
     */
    unknownKeys?: 'strip' | 'warn';
    /** Per-key hints for 'warn' (e.g. update-only keys sent to create). */
    unknownKeyHints?: Record<string, string>;
}

/** Transport envelope keys the outer schema carries for every action; never reported as ignored. */
const ENVELOPE_KEYS = new Set(['action', 'sessionId', 'output_mode', 'outputMode', 'fields', 'opId']);

/**
 * The keys a caller sent that the action's schema does not declare (undefined
 * values do not count). The schema is read through its preprocess / refine /
 * default wrappers; a passthrough or catchall object keeps every key, so
 * nothing is ignored there and nothing is reported.
 */
export function ignoredParamsOf(schema: z.ZodType<any>, args: Record<string, unknown>): string[] {
    const shape = shapeOf(schema);
    if (!shape || keepsUnknownKeys(schema)) return [];
    return Object.keys(args).filter(k => !ENVELOPE_KEYS.has(k) && args[k] !== undefined && !(k in shape));
}

/** The action's own parameter names, through the schema's wrappers, `action` excluded. */
function validKeysOf(schema: z.ZodType<any>): string[] {
    return Object.keys(shapeOf(schema) ?? {}).filter(k => k !== 'action');
}

/** The closest of `candidates` to `key` when it is close enough to be a misspelling (similarity ≥ 0.5). */
function nearestKey(key: string, candidates: readonly string[]): string | undefined {
    let best: { key: string; score: number } | undefined;
    for (const v of candidates) {
        const score = similarity(key, v);
        if (!best || score > best.score) best = { key: v, score };
    }
    return best && best.score >= 0.5 ? best.key : undefined;
}

/**
 * Keys the call envelope reads before any action does. The operation guard
 * takes args.worldId to stamp roll_log.world_id on every die the call rolls,
 * whether or not the action declares it — so an action that ignores it must
 * say what the envelope still did with it, not call it a near-miss.
 */
const ENVELOPE_KEY_NOTES: Record<string, (action: string) => string> = {
    worldId: action => `not among ${action}'s parameters; it only stamps this call's dice log (roll_log.world_id)`
};

/** `key — <hint>` / `key — <envelope note>` / `key — nearest valid key 'x'` / `key — no close match among <action>'s parameters`. */
function describeKey(action: string, key: string, valid: readonly string[], hints: Record<string, string>): string {
    if (hints[key]) return `${key} — ${hints[key]}`;
    if (ENVELOPE_KEY_NOTES[key]) return `${key} — ${ENVELOPE_KEY_NOTES[key](action)}`;
    const near = nearestKey(key, valid);
    return near ? `${key} — nearest valid key '${near}'` : `${key} — no close match among ${action}'s parameters`;
}

/** One line naming each ignored key and the nearest valid key, or the action's own hint for it. */
export function describeIgnoredParams(action: string, ignored: string[], schema: z.ZodType<any>, hints: Record<string, string> = {}): string {
    const valid = validKeysOf(schema);
    const parts = ignored.map(key => describeKey(action, key, valid, hints));
    return `Ignored params (not ${action} parameters; nothing was written for them): ${parts.join('; ')}.`;
}

/**
 * Play report 7 #2: the note for keys a handler dropped inside a nested
 * object (create's participants[]): each dotted path with its own hint, else
 * the nearest valid key of that object, else no close match. The handler
 * puts the paths in ignoredParams; the router merges its own after them.
 */
export function describeNestedIgnored(where: string, entries: Array<{ path: string; key: string; hint?: string }>, validKeys: readonly string[]): string {
    const parts = entries.map(e => {
        if (e.hint) return `${e.path} — ${e.hint}`;
        const near = nearestKey(e.key, validKeys);
        return near ? `${e.path} — nearest valid key '${near}'` : `${e.path} — no close match among ${where} keys`;
    });
    return `Ignored params (not ${where} keys; nothing was written for them): ${parts.join('; ')}.`;
}

export interface ActionSchemaDocumentation {
    [action: string]: {
        schema: z.ZodType<any>;
        aliases: string[];
        description?: string;
    };
}

export interface ActionRouter {
    (args: Record<string, unknown>, ctx?: SessionContext): Promise<McpResponse>;
    actionSchemas: ActionSchemaDocumentation;
}

/**
 * Configuration for the action router
 */
export interface ActionRouterConfig<TActions extends string> {
    /** Valid action names */
    actions: readonly TActions[];
    /** Action definitions with handlers */
    definitions: Record<TActions, ActionDefinition>;
    /** Global alias map (optional, built from definitions if not provided) */
    aliases?: Record<string, TActions>;
    /** Minimum similarity for fuzzy matching (default: 0.6) */
    threshold?: number;
    /**
     * Play report 4 #2: the default for every action that sets no
     * `unknownKeys` of its own. 'warn' unless the tool says otherwise — a key
     * an action does not declare is reported on the reply, never dropped in
     * silence.
     */
    unknownKeys?: 'strip' | 'warn';
}

/**
 * MCP-formatted response
 */
export interface McpResponse {
    content: Array<{ type: 'text'; text: string }>;
}

/**
 * Enhanced result with fuzzy match metadata
 */
export interface EnhancedResult<T> {
    result: T;
    _meta?: {
        fuzzyMatch?: {
            requested: string;
            resolved: string;
            similarity: number;
        };
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER FACTORY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create an action router for a consolidated tool
 *
 * @example
 * const router = createActionRouter({
 *     actions: ['create', 'get', 'update', 'delete', 'list'] as const,
 *     definitions: {
 *         create: {
 *             schema: z.object({ name: z.string() }),
 *             handler: async (args) => createEntity(args),
 *             aliases: ['new', 'add']
 *         },
 *         get: {
 *             schema: z.object({ id: z.string() }),
 *             handler: async (args) => getEntity(args.id)
 *         },
 *         // ...
 *     }
 * });
 *
 * // Later in tool handler:
 * const result = await router({ action: 'new', name: 'Test' });
 */
export function createActionRouter<TActions extends string>(
    config: ActionRouterConfig<TActions>
): ActionRouter {
    const { actions, definitions, threshold = 0.6, unknownKeys: defaultUnknownKeys = 'warn' } = config;

    // Build alias map from definitions if not provided
    const aliasMap: Record<string, TActions> = config.aliases ?? {};
    if (!config.aliases) {
        for (const [action, def] of Object.entries(definitions) as Array<[TActions, ActionDefinition]>) {
            if (def.aliases) {
                for (const alias of def.aliases) {
                    aliasMap[alias.toLowerCase()] = action;
                }
            }
        }
    }

    const route = async function route(args: Record<string, unknown>, ctx?: SessionContext): Promise<McpResponse> {
        // ─────────────────────────────────────────────────────────────────────
        // STEP 1: Extract and validate action
        // ─────────────────────────────────────────────────────────────────────
        const rawAction = args.action;
        if (typeof rawAction !== 'string') {
            return formatMcpError('Missing or invalid "action" parameter', {
                received: typeof rawAction,
                expected: 'string',
                validActions: [...actions]
            });
        }

        // ─────────────────────────────────────────────────────────────────────
        // STEP 2: Match action with fuzzy logic
        // ─────────────────────────────────────────────────────────────────────
        const matchResult = matchAction(rawAction, actions, aliasMap, threshold);

        if (isGuidingError(matchResult)) {
            return formatGuidingError(matchResult);
        }

        const action = matchResult.matched;
        const definition = definitions[action];

        if (!definition) {
            return formatMcpError(`No handler defined for action: ${action}`, {
                action
            });
        }

        // ─────────────────────────────────────────────────────────────────────
        // STEP 3: Parse action-specific args (with resolved action)
        // ─────────────────────────────────────────────────────────────────────
        // Replace the raw action with the resolved action for schema validation
        const argsWithResolvedAction = { ...args, action };
        const parseResult = definition.schema.safeParse(argsWithResolvedAction);

        if (!parseResult.success) {
            return formatValidationError(action, parseResult.error, { schema: definition.schema, args, hints: definition.unknownKeyHints });
        }

        // ─────────────────────────────────────────────────────────────────────
        // STEP 4: Execute handler
        // ─────────────────────────────────────────────────────────────────────
        try {
            const result = await definition.handler(parseResult.data, ctx);

            // ─────────────────────────────────────────────────────────────────
            // STEP 5: Format response with optional fuzzy match metadata
            // ─────────────────────────────────────────────────────────────────
            // Play report 2 #10 / play report 4 #2: every action says which keys
            // it dropped — loudly, on the success reply, with the nearest valid
            // key — unless it, or its router, opted out with 'strip'.
            // Play report 7 #2: keys the handler reported itself (nested
            // participant keys) stay; the router's top-level keys follow, each
            // listed and noted once (review: a key the handler already named
            // is not repeated).
            const ownRaw = typeof result === 'object' && result !== null ? (result as { ignoredParams?: unknown }).ignoredParams : undefined;
            const own = Array.isArray(ownRaw) ? ownRaw : [];
            const ignored = ((definition.unknownKeys ?? defaultUnknownKeys) === 'warn' ? ignoredParamsOf(definition.schema, args) : [])
                .filter(k => !own.includes(k));
            if (ignored.length && typeof result === 'object' && result !== null && !('content' in result) && !(result as { error?: unknown }).error) {
                const note = describeIgnoredParams(action, ignored, definition.schema, definition.unknownKeyHints);
                const prior = (result as { message?: unknown }).message;
                return formatMcpSuccess({
                    ...(result as Record<string, unknown>),
                    ignoredParams: [...own, ...ignored],
                    message: typeof prior === 'string' && prior ? `${prior.replace(/\.?\s*$/, '')}. ${note}` : note
                }, matchResult);
            }
            return formatMcpSuccess(result, matchResult);
        } catch (error) {
            // FINDINGS #64: the throw site may assert write-freedom by setting
            // .writes = 'none' on the Error — the claim travels; the formatter
            // prints NO WRITE iff it arrives.
            return formatMcpError(
                error instanceof Error ? error.message : String(error),
                { action, args, ...((error as { writes?: string })?.writes ? { writes: (error as { writes?: string }).writes } : {}) }
            );
        }
    };

    route.actionSchemas = createActionSchemaDocumentation(definitions);
    return route;
}

export function createActionSchemaDocumentation<TActions extends string>(
    definitions: Record<TActions, ActionDefinition>
): ActionSchemaDocumentation {
    return Object.fromEntries(
        Object.entries(definitions).map(([action, definition]) => [
            action,
            {
                schema: (definition as ActionDefinition).schema,
                aliases: (definition as ActionDefinition).aliases || [],
                description: (definition as ActionDefinition).description
            }
        ])
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCRIMINATED UNION ROUTER (ALTERNATIVE PATTERN)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a router using Zod discriminated unions
 *
 * This approach uses Zod's discriminatedUnion for compile-time type safety.
 * Better for complex tools where each action has very different schemas.
 *
 * @example
 * const schema = z.discriminatedUnion('action', [
 *     z.object({ action: z.literal('create'), name: z.string() }),
 *     z.object({ action: z.literal('get'), id: z.string() }),
 * ]);
 *
 * const router = createDiscriminatedRouter(schema, {
 *     create: async (args) => { ... },
 *     get: async (args) => { ... },
 * });
 */
export function createDiscriminatedRouter<TSchema extends z.ZodSchema>(
    schema: TSchema,
    handlers: Record<string, ActionHandler>
): (args: unknown) => Promise<McpResponse> {
    return async function route(args: unknown): Promise<McpResponse> {
        // Parse and validate
        const parseResult = schema.safeParse(args);

        if (!parseResult.success) {
            return formatValidationError('unknown', parseResult.error);
        }

        const parsed = parseResult.data as { action: string };
        const handler = handlers[parsed.action];

        if (!handler) {
            return formatMcpError(`No handler for action: ${parsed.action}`, {});
        }

        try {
            const result = await handler(parsed);
            return formatMcpSuccess(result, { matched: parsed.action, exact: true, similarity: 1 });
        } catch (error) {
            return formatMcpError(
                error instanceof Error ? error.message : String(error),
                { action: parsed.action, ...((error as { writes?: string })?.writes ? { writes: (error as { writes?: string }).writes } : {}) }
            );
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE FORMATTERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format a successful result as MCP response
 */
export function formatMcpSuccess(
    result: unknown,
    matchInfo?: MatchResult<string>
): McpResponse {
    // If result is already an MCP response, return it
    if (
        typeof result === 'object' &&
        result !== null &&
        'content' in result &&
        Array.isArray((result as McpResponse).content)
    ) {
        // Add fuzzy match metadata if not exact
        if (matchInfo && !matchInfo.exact) {
            const content = (result as McpResponse).content;
            if (content.length > 0 && content[0].type === 'text') {
                try {
                    const data = JSON.parse(content[0].text);
                    data._fuzzyMatch = {
                        requested: matchInfo.matched, // Original would need to be passed
                        resolved: matchInfo.matched,
                        similarity: Math.round(matchInfo.similarity * 100)
                    };
                    content[0].text = JSON.stringify(data, null, 2);
                } catch {
                    // Not JSON, leave as-is
                }
            }
        }
        return result as McpResponse;
    }

    // Format as JSON
    const output: Record<string, unknown> = typeof result === 'object' && result !== null
        ? { ...result as Record<string, unknown> }
        : { result };

    // Add fuzzy match info if not exact match
    if (matchInfo && !matchInfo.exact) {
        output._fuzzyMatch = {
            resolved: matchInfo.matched,
            similarity: Math.round(matchInfo.similarity * 100)
        };
    }

    return {
        content: [{
            type: 'text',
            text: JSON.stringify(output, null, 2)
        }]
    };
}

/**
 * Format an error as MCP response
 */
export function formatMcpError(
    message: string,
    details: Record<string, unknown>
): McpResponse {
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                error: true,
                message,
                ...details
            }, null, 2)
        }]
    };
}

/**
 * Format a Zod validation error as MCP response with helpful details.
 *
 * Play report 4 #2: given the action's schema and the raw args, the reply
 * also names the keys the schema does not declare (`unknownParams`, each
 * with its nearest valid key or the action's hint), and a missing required
 * key whose misspelt twin was sent says so on its own issue — the two
 * halves of "nmae instead of name" meet in one message.
 */
export function formatValidationError(
    action: string,
    error: z.ZodError,
    context?: { schema: z.ZodType<any>; args: Record<string, unknown>; hints?: Record<string, string> }
): McpResponse {
    const issues = error.issues.map(issue => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
        code: issue.code
    }));

    let hint = 'Check the parameter types and required fields';
    const unknown = context ? ignoredParamsOf(context.schema, context.args) : [];
    if (unknown.length) {
        for (const issue of issues) {
            if (issue.code !== 'invalid_type' || issue.message !== 'Required' || issue.path === '(root)' || issue.path.includes('.')) continue;
            const twin = nearestKey(issue.path, unknown);
            if (twin) issue.message = `Required — you sent '${twin}'; did you mean '${issue.path}'?`;
        }
        const valid = validKeysOf(context!.schema);
        hint += `. Unknown keys (not ${action} parameters): ${unknown.map(k => describeKey(action, k, valid, context!.hints ?? {})).join('; ')}.`;
    }

    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                error: 'validation_error',
                action,
                message: `Validation failed for action "${action}"`,
                issues,
                ...(unknown.length ? { unknownParams: unknown } : {}),
                hint,
                // FINDINGS #64: validation precedes the handler by construction —
                // the throw site can prove write-freedom, so it asserts it.
                writes: 'none'
            }, null, 2)
        }]
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Build action description for tool schema
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate description text for the 'action' parameter
 * Includes all valid actions and their aliases
 */
export function buildActionDescription<TActions extends string>(
    actions: readonly TActions[],
    definitions: Record<TActions, ActionDefinition>
): string {
    const parts = [`Action to perform: ${actions.join(', ')}`];

    // Collect aliases
    const aliasLines: string[] = [];
    for (const [action, def] of Object.entries(definitions) as Array<[TActions, ActionDefinition]>) {
        if (def.aliases && def.aliases.length > 0) {
            aliasLines.push(`${def.aliases.join('/')} -> ${action}`);
        }
    }

    if (aliasLines.length > 0) {
        parts.push(`Aliases: ${aliasLines.join(', ')}`);
    }

    return parts.join('. ');
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPE HELPERS FOR CONSOLIDATED TOOL SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create the base schema for a consolidated tool
 * Includes the action parameter with description
 */
export function createConsolidatedSchema<TActions extends string>(
    actions: readonly TActions[],
    definitions: Record<TActions, ActionDefinition>
): z.ZodObject<{ action: z.ZodString }> {
    return z.object({
        action: z.string().describe(buildActionDescription(actions, definitions))
    });
}

/**
 * Merge common schema with action-specific schema
 * Useful for building the full input schema for documentation
 */
export function mergeSchemas(
    common: z.AnyZodObject,
    specific: z.AnyZodObject
): z.AnyZodObject {
    return common.merge(specific);
}
