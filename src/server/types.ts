import { z } from 'zod';
import { getTenant } from '../storage/tenant-context.js';

export interface SessionContext {
    sessionId: string;
    userId?: string;
    worldId?: string;
}

/**
 * Marks a request that carried no verified tenant.
 *
 * Only tenant-agnostic meta-tools (search_tools, load_tool_schema) legitimately
 * reach a handler this way; anything touching storage fails closed inside
 * getDb(). The value is deliberately not a plausible id — the previous
 * `'default'` fallback read like a real session and quietly pooled unrelated
 * callers into one bucket.
 */
const UNSCOPED = 'unscoped';

/**
 * Wraps a tool handler with its session context.
 *
 * The context is derived from the *verified* tenant established by the HTTP
 * transport, never from the arguments. Previously `sessionId` was read straight
 * out of the tool arguments — which are assembled from model output — so a
 * prompt-injected or hallucinated value became the request's identity. Any
 * `sessionId` a caller still sends is removed here by hand and ignored.
 *
 * Play report 4 #2: the parse is open (passthrough), not strip. A key the
 * tool's outer schema does not declare travels on to the action router,
 * which reports it as ignoredParams instead of letting it vanish under a
 * success banner. The tools without a router re-parse with their own strip
 * schema, so nothing undeclared reaches their code either way.
 */
export function withSession<T extends z.ZodType<any>>(
    schema: T,
    handler: (args: z.infer<T>, ctx: SessionContext) => Promise<any>
) {
    const open: z.ZodType<any> = typeof (schema as unknown as { passthrough?: unknown }).passthrough === 'function'
        ? (schema as unknown as { passthrough: () => z.ZodType<any> }).passthrough()
        : schema;
    return async (args: unknown) => {
        const parsed = open.parse(args);
        if (parsed && typeof parsed === 'object') delete (parsed as Record<string, unknown>).sessionId;
        const tenant = getTenant();
        const ctx: SessionContext = {
            sessionId: tenant ? `${tenant.accountId}:${tenant.campaignId}` : UNSCOPED,
            worldId: tenant?.worldId,
        };
        return handler(parsed, ctx);
    };
}
