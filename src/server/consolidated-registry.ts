/**
 * Consolidated Tool Registry for v1.0 Clean-Break Release.
 *
 * The registry is deliberately a projection of the ToolContract objects in
 * consolidated/index.ts.  It does not maintain a second metadata map.
 */

import { ToolMetadata, ToolCategory, ToolRegistry } from './tool-metadata.js';
import { ConsolidatedTools } from './consolidated/index.js';
import { shapeOf } from '../utils/zod-shape.js';

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
// The object behind a z.preprocess / refine wrapper (world_manage update and
// advance are preprocess-wrapped): their keys are inner params like any other,
// and a client strips them just the same when the outer schema lacks them.
// shapeOf lives in utils/zod-shape.ts so the action router reads the same way.

export function mirrorAuditMissing(registry: ToolRegistry): Record<string, string[]> {
    const drift: Record<string, string[]> = {};
    for (const [name, entry] of Object.entries(registry)) {
        const outerShape = shapeOf(entry.schema);
        const actionSchemas = entry.actionSchemas as Record<string, { schema?: unknown }> | undefined;
        if (!outerShape || !actionSchemas) continue;
        const outerKeys = new Set(Object.keys(outerShape));
        const missing = new Set<string>();
        for (const def of Object.values(actionSchemas)) {
            const innerShape = shapeOf(def?.schema);
            if (!innerShape) continue;
            for (const k of Object.keys(innerShape)) {
                if (k !== 'action' && !outerKeys.has(k)) missing.add(k);
            }
        }
        if (missing.size > 0) drift[name] = [...missing].sort();
    }
    return drift;
}

function runBootMirrorAudit(registry: ToolRegistry): void {
    for (const [name, missing] of Object.entries(mirrorAuditMissing(registry))) {
        console.error(`[MIRROR AUDIT] ${name}: outer inputSchema missing inner params: ${missing.join(', ')} — clients WILL strip these (Findings #14/#27/#33)`);
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
