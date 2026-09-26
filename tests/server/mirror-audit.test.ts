/**
 * The mirror law: every inner action param must also be on the tool's outer
 * inputSchema, or MCP clients strip it before it reaches the router.
 */
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
});
