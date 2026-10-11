/**
 * The mirror law: every inner action param must also be on the tool's outer
 * inputSchema, or MCP clients strip it before it reaches the router.
 */
import { z } from 'zod';
import { buildConsolidatedRegistry, mirrorAuditMissing } from '../../src/server/consolidated-registry.js';

const TOUCHED = ['combat_action', 'combat_manage', 'character_manage', 'math_manage', 'world_manage', 'narrative_manage', 'table_rules', 'corpse_manage', 'spatial_manage', 'party_manage', 'improvisation_manage', 'congregation_manage'];

describe('mirror audit', () => {
    it('has no drift on the tools the wishlist touches', () => {
        const drift = mirrorAuditMissing(buildConsolidatedRegistry());
        for (const name of TOUCHED) expect({ name, missing: drift[name] ?? [] }).toEqual({ name, missing: [] });
    });

    it('still registers 42 consolidated tools', () => {
        expect(Object.keys(buildConsolidatedRegistry())).toHaveLength(42);
    });

    // Play report 2, #14 review: world_manage update and advance are
    // z.preprocess-wrapped, so their shape sat behind a ZodEffects and the
    // audit skipped them. A wrapped action schema is audited like a bare one.
    it('sees through a preprocess-wrapped action schema', () => {
        const registry = {
            probe_tool: {
                schema: z.object({ action: z.string(), worldId: z.string().optional() }),
                actionSchemas: {
                    update: { schema: z.preprocess(v => v, z.object({ action: z.literal('update'), worldId: z.string(), environment: z.any() })) },
                    plain: { schema: z.object({ action: z.literal('plain'), worldId: z.string() }) }
                }
            }
        };
        expect(mirrorAuditMissing(registry as any)).toEqual({ probe_tool: ['environment'] });
    });
});
