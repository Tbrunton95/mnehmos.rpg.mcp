import { Tools } from '../../src/server/tools.js';
import { WorldMapTool } from '../../src/server/consolidated/world-map.js';
import { LEGACY_SURFACE_POLICY } from '../../src/server/legacy-surface-policy.js';

describe('legacy tool surface policy', () => {
    it('retains only the documented world-map compatibility adapters', () => {
        expect(LEGACY_SURFACE_POLICY.mode).toBe('compatibility');
        expect(LEGACY_SURFACE_POLICY.publicSurface).toBe('consolidated');
        expect(LEGACY_SURFACE_POLICY.adapter).toBe('src/server/tools.ts');

        const legacyNames = [
            Tools.GET_WORLD_MAP_OVERVIEW.name,
            Tools.GET_REGION_MAP.name,
            Tools.GET_WORLD_TILES.name,
            Tools.APPLY_MAP_PATCH.name,
            Tools.PREVIEW_MAP_PATCH.name,
            Tools.FIND_VALID_POI_LOCATION.name,
            Tools.SUGGEST_POI_LOCATIONS.name,
        ];
        const nativeActions: readonly string[] = LEGACY_SURFACE_POLICY.nativeActions;
        const worldMapActions = Object.keys(WorldMapTool.actionSchemas ?? {})
            .filter(action => !nativeActions.includes(action));

        expect(LEGACY_SURFACE_POLICY.supportedAdapters.map(entry => entry.legacyTool))
            .toEqual(legacyNames);
        expect(LEGACY_SURFACE_POLICY.supportedAdapters.map(entry => entry.consolidatedAction))
            .toEqual(worldMapActions);
    });
});
