/**
 * Consolidated Tool Registry for v1.0 Clean-Break Release.
 *
 * The registry is deliberately a projection of the ToolContract objects in
 * consolidated/index.ts.  It does not maintain a second metadata map.
 */

import { ToolMetadata, ToolCategory, ToolRegistry } from './tool-metadata.js';
import { ConsolidatedTools } from './consolidated/index.js';

let cachedRegistry: ToolRegistry | null = null;

export function buildConsolidatedRegistry(): ToolRegistry {
    if (cachedRegistry) return cachedRegistry;

    cachedRegistry = {};
    for (const contract of ConsolidatedTools) {
        cachedRegistry[contract.name] = {
            metadata: contract.metadata,
            schema: contract.schema,
            actionSchemas: contract.actionSchemas,
            handler: contract.handler,
        };
    }

    runBootMirrorAudit(cachedRegistry);
    return cachedRegistry;
}

/**
 * FINDINGS #34 T4.19 (interim form): the mirror law has six casualties.
 * Until outer schemas are auto-generated, audit them at every boot and
 * shout about drift where it cannot be missed.
 */
function runBootMirrorAudit(registry: ToolRegistry): void {
    for (const [name, entry] of Object.entries(registry)) {
        const outerShape = (entry.schema as { shape?: Record<string, unknown> }).shape;
        const actionSchemas = entry.actionSchemas as Record<string, { schema?: { shape?: Record<string, unknown> } }> | undefined;
        if (!outerShape || !actionSchemas) continue;
        const outerKeys = new Set(Object.keys(outerShape));
        const missing = new Set<string>();
        for (const def of Object.values(actionSchemas)) {
            const innerShape = def?.schema?.shape;
            if (!innerShape) continue;
            for (const k of Object.keys(innerShape)) {
                if (k !== 'action' && !outerKeys.has(k)) missing.add(k);
            }
        }
        if (missing.size > 0) {
            console.error(`[MIRROR AUDIT] ${name}: outer inputSchema missing inner params: ${[...missing].sort().join(', ')} — clients WILL strip these (Findings #14/#27/#33)`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// METADATA ACCESS FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export function getAllConsolidatedToolMetadata(): ToolMetadata[] {
    return Object.values(buildConsolidatedRegistry()).map(entry => entry.metadata);
}

export function getConsolidatedToolCategories(): ToolCategory[] {
    return [
        'world', 'combat', 'character', 'inventory', 'quest', 'party',
        'math', 'strategy', 'secret', 'concentration', 'rest', 'scroll',
        'aura', 'npc', 'spatial', 'theft', 'corpse', 'improvisation',
        'turn-management', 'meta', 'narrative', 'agent'
    ];
}

export function getConsolidatedToolByName(name: string) {
    return buildConsolidatedRegistry()[name] || null;
}
