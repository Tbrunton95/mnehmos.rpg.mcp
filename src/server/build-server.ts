/**
 * The McpServer with every tool registered — the one place the protocol
 * boundary is drawn. Lives apart from index.ts (which starts a transport on
 * import) so tests can connect a Client to it in memory.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MetaTools, handleSearchTools, handleLoadToolSchema } from './meta-tools.js';
import { buildConsolidatedRegistry } from './consolidated-registry.js';
import { registerEventTools } from './events.js';
import { withSession } from './types.js';
import { withOperation } from './operation-guard.js';
import { schemaShape } from './schema-shape.js';
import { noteIgnoredParams, shapeReply } from './output-mode.js';
import type { PubSub } from '../engine/pubsub.js';
import type { AuditLogger } from './audit.js';

type ToolReply = { content?: Array<{ type: string; text: string }> };
type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolReply>;

/**
 * Builds a fresh McpServer with every tool registered. Cheap (no I/O) —
 * safe to call once for the long-lived stdio/tcp/unix/websocket transports,
 * or per-request for the stateless HTTP transport, which requires a new
 * McpServer + StreamableHTTPServerTransport pair per request (the SDK
 * throws "Stateless transport cannot be reused across requests" otherwise).
 * `pubsub` and `auditLogger` are app-level singletons shared across calls —
 * only the protocol-level McpServer/tool-registration wrapper is rebuilt.
 */
export function buildServer(pubsub: PubSub, auditLogger: AuditLogger): McpServer {
  const server = new McpServer({
    name: 'rpg-mcp',
    version: '1.0.3'
  });

  registerEventTools(server, pubsub);

  server.tool(
    MetaTools.SEARCH_TOOLS.name,
    MetaTools.SEARCH_TOOLS.description,
    MetaTools.SEARCH_TOOLS.inputSchema.extend({ sessionId: z.string().optional() }).shape,
    auditLogger.wrapHandler(MetaTools.SEARCH_TOOLS.name, withSession(MetaTools.SEARCH_TOOLS.inputSchema, handleSearchTools))
  );

  server.tool(
    MetaTools.LOAD_TOOL_SCHEMA.name,
    MetaTools.LOAD_TOOL_SCHEMA.description,
    MetaTools.LOAD_TOOL_SCHEMA.inputSchema.extend({ sessionId: z.string().optional() }).shape,
    auditLogger.wrapHandler(MetaTools.LOAD_TOOL_SCHEMA.name, withSession(MetaTools.LOAD_TOOL_SCHEMA.inputSchema, handleLoadToolSchema))
  );

  const registry = buildConsolidatedRegistry();
  const toolCount = Object.keys(registry).length;
  // output_mode rides the same envelope as sessionId so the SDK's input
  // validation keeps it long enough for withOutputMode to see it.
  const envelopeShape = {
    sessionId: z.string().optional(),
    output_mode: z.enum(['json', 'banner', 'summary']).optional(),
    opId: z.string().optional(),
    fields: z.array(z.string()).optional()
  };
  const sessionIdSchema = z.object(envelopeShape);

  // FINDINGS #88: output_mode:'json' — ONE wrapper, every consolidated tool.
  // The banner is already rendered FROM the embedded JSON everywhere (the
  // #20/#61/#66 family closed the render divergence); this strips it for
  // chairs that want only the data. Banner mode is untouched default.
  const withOutputMode = (handler: ToolHandler): ToolHandler =>
    async (args, extra) => {
      const mode = args?.output_mode ?? args?.outputMode;
      const fields = Array.isArray(args?.fields) ? (args.fields as unknown[]).map(String) : undefined;
      if (args) { delete args.output_mode; delete args.outputMode; delete args.fields; }
      // Play report 4 #2: a banner that never prints `message` still shows
      // the keys the action ignored — one warning line before the embed.
      const res = noteIgnoredParams(await handler(args, extra));
      // Item 17: shapeReply also reads bare-JSON replies (narrative_manage),
      // which have no embed and were returned whole before.
      return shapeReply(res, { mode, fields });
    };

  for (const [toolName, entry] of Object.entries(registry)) {
    // Handle all Zod schema types (object, omit, pick, etc.)
    // .extend() only works on z.object(), so we use .and() which works universally
    let extendedSchema: any;
    if (typeof entry.schema.extend === 'function') {
      // Standard z.object() - use .extend() for best performance
      extendedSchema = entry.schema.extend(envelopeShape);
    } else if (typeof entry.schema.and === 'function') {
      // .omit(), .pick(), or other transformed schemas - use .and()
      extendedSchema = entry.schema.and(sessionIdSchema);
    } else {
      // Fallback: wrap in intersection
      extendedSchema = z.intersection(entry.schema, sessionIdSchema);
    }

    // Play report 4 #2: the SDK validates every tools/call against this
    // schema. As a default-strip z.object it dropped each key the outer
    // schema lacked before the action router could see it, so a misspelt
    // param vanished under a success banner. Passthrough keeps the keys for
    // the router to report as ignoredParams (withSession keeps its own parse
    // open too and removes sessionId itself); tools/list now advertises
    // additionalProperties: true. registerTool, not the deprecated tool():
    // that overload takes raw shapes only and throws on a ZodObject. Never
    // pass the .and() intersection here — the SDK normalises it to undefined
    // and tools/list would advertise an empty schema.
    server.registerTool(
      toolName,
      {
        description: entry.metadata.description,
        inputSchema: z.object(schemaShape(extendedSchema)).passthrough()
      },
      withOutputMode(withOperation(toolName, auditLogger.wrapHandler(
        toolName,
        withSession(entry.schema, entry.handler as any)
      ) as ToolHandler)) as any
    );
  }

  console.error(`[Server] Registered ${toolCount} tools with minimal schemas`);
  console.error(`[Server] Meta-tools: search_tools, load_tool_schema`);

  return server;
}
