/**
 * Tests for consolidated world_map tool
 * Validates all 7 actions: overview, region, tiles, patch, preview, find_poi, suggest_poi
 */

import { handleWorldMap, WorldMapTool } from '../../../src/server/consolidated/world-map.js';
import { handleWorldManage } from '../../../src/server/consolidated/world-manage.js';
import { getWorldManager } from '../../../src/server/state/world-manager.js';
import { BiomeType } from '../../../src/schema/biome.js';
import { getDb } from '../../../src/storage/index.js';
import { randomUUID } from 'crypto';

process.env.NODE_ENV = 'test';

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    const jsonMatch = text.match(/<!-- WORLD_MAP_JSON\n([\s\S]*?)\nWORLD_MAP_JSON -->/);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
    }
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
    } catch {
        // Not valid JSON
    }
    return { error: 'parse_failed', rawText: text };
}

function parseWorldResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    const jsonMatch = text.match(/<!-- WORLD_MANAGE_JSON\n([\s\S]*?)\nWORLD_MANAGE_JSON -->/);
    return jsonMatch ? JSON.parse(jsonMatch[1]) : null;
}

describe('world_map consolidated tool', () => {
    let ctx: { sessionId: string };
    let testWorldId: string;

    beforeEach(async () => {
        ctx = { sessionId: `test-session-${randomUUID()}` };
        const db = getDb(':memory:');
        db.exec('DELETE FROM worlds');

        // Generate a test world
        const genResult = await handleWorldManage({
            action: 'generate',
            seed: 'map-test',
            width: 30,
            height: 30
        }, ctx);
        testWorldId = parseWorldResult(genResult).worldId;
    });

    describe('Tool Definition', () => {
        it('should have correct tool name', () => {
            expect(WorldMapTool.name).toBe('world_map');
        });

        it('should list all available actions in description', () => {
            expect(WorldMapTool.description).toContain('overview');
            expect(WorldMapTool.description).toContain('region');
            expect(WorldMapTool.description).toContain('tiles');
            expect(WorldMapTool.description).toContain('patch');
            expect(WorldMapTool.description).toContain('preview');
            expect(WorldMapTool.description).toContain('find_poi');
            expect(WorldMapTool.description).toContain('suggest_poi');
        });
    });

    describe('overview action', () => {
        it('should get world map overview', async () => {
            const result = await handleWorldMap({
                action: 'overview',
                worldId: testWorldId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('overview');
            expect(data.dimensions).toBeDefined();
        });

        it('should accept "summary" alias', async () => {
            const result = await handleWorldMap({
                action: 'summary',
                worldId: testWorldId
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('overview');
        });

        it('should restore the generated snapshot after runtime cache eviction', async () => {
            const before = parseResult(await handleWorldMap({
                action: 'overview',
                worldId: testWorldId
            }, ctx));

            expect(getWorldManager().delete(testWorldId)).toBe(true);

            const after = parseResult(await handleWorldMap({
                action: 'overview',
                worldId: testWorldId
            }, ctx));

            expect(after.success).toBe(true);
            expect(after.dimensions).toEqual(before.dimensions);
            expect(after.biomeDistribution).toEqual(before.biomeDistribution);
            expect(after.regionCount).toBe(before.regionCount);
            expect(after.structureCount).toBe(before.structureCount);
            expect(after.riverTileCount).toBe(before.riverTileCount);
        });
    });

    describe('region action', () => {
        it('should get region map', async () => {
            const result = await handleWorldMap({
                action: 'region',
                worldId: testWorldId,
                regionId: 0
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('region');
        });

        it('should accept "get_region" alias', async () => {
            const result = await handleWorldMap({
                action: 'get_region',
                worldId: testWorldId,
                regionId: 0
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('region');
        });
    });

    describe('tiles action', () => {
        it('should get world tiles', async () => {
            const result = await handleWorldMap({
                action: 'tiles',
                worldId: testWorldId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('tiles');
            expect(data.width).toBe(30);
            expect(data.height).toBe(30);
        });

        it('should accept "grid" alias', async () => {
            const result = await handleWorldMap({
                action: 'grid',
                worldId: testWorldId
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('tiles');
        });
    });

    describe('preview action', () => {
        it('should preview a patch without applying', async () => {
            const result = await handleWorldMap({
                action: 'preview',
                worldId: testWorldId,
                script: 'ADD_STRUCTURE city 15 15 "Test City"'
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('preview');
            expect(data.valid).toBeDefined();
        });

        it('should accept "dry_run" alias', async () => {
            const result = await handleWorldMap({
                action: 'dry_run',
                worldId: testWorldId,
                script: 'ADD_STRUCTURE town 10 10 "Test Town"'
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('preview');
        });
    });

    describe('patch action', () => {
        it('should apply a map patch', async () => {
            const result = await handleWorldMap({
                action: 'patch',
                worldId: testWorldId,
                script: 'ADD_STRUCTURE city 15 15 "Patch City"'
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('patch');
            // success depends on terrain validity at coords - just verify response format
            expect(typeof data.success).toBe('boolean');
        });

        it('should report invalid DSL patches as failures', async () => {
            const data = parseResult(await handleWorldMap({
                action: 'patch',
                worldId: testWorldId,
                script: 'THIS IS NOT VALID MAP DSL'
            }, ctx));

            expect(data.success).toBe(false);
        });

        it('should accept "apply" alias', async () => {
            const result = await handleWorldMap({
                action: 'apply',
                worldId: testWorldId,
                script: 'ADD_STRUCTURE town 10 10 "Apply Town"'
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('patch');
        });

        it('should restore an applied map patch after runtime cache eviction', async () => {
            const generated = getWorldManager().get(testWorldId)!;
            const replacement = generated.biomes[0][0] === BiomeType.OCEAN
                ? BiomeType.GRASSLAND
                : BiomeType.OCEAN;

            const patchResult = parseResult(await handleWorldMap({
                action: 'patch',
                worldId: testWorldId,
                script: `SET_BIOME ${replacement} 0 0`
            }, ctx));
            expect(patchResult.success).toBe(true);
            expect(patchResult.commandsExecuted).toBe(1);

            expect(getWorldManager().delete(testWorldId)).toBe(true);

            const restoredTiles = parseResult(await handleWorldMap({
                action: 'tiles',
                worldId: testWorldId
            }, ctx));
            expect(restoredTiles.success).toBe(true);
            expect(restoredTiles.biomes[restoredTiles.tiles[0][0]]).toBe(replacement);
        });
    });

    describe('region rows across a seed restore', () => {
        // A world with no durable snapshot (created before snapshots existed)
        // comes back through the seed fallback in getOrRestoreWorld. That path
        // used to write `${worldId}:${n}` region rows beside the
        // `${worldId}:region:${n}` rows generation writes, so claims, ownership
        // and region lookups split across two sets of ids for one world.
        function regionIds(worldId: string): string[] {
            return (getDb().prepare('SELECT id FROM regions WHERE world_id = ? ORDER BY id').all(worldId) as Array<{ id: string }>)
                .map(row => row.id);
        }

        async function restoreFromSeed(worldId: string) {
            expect(getWorldManager().delete(worldId)).toBe(true);
            getDb().prepare('DELETE FROM world_snapshots WHERE world_id = ?').run(worldId);
            const restored = parseResult(await handleWorldMap({ action: 'overview', worldId }, ctx));
            expect(restored.success).toBe(true);
        }

        it('keeps the generation region ids and adds no second set', async () => {
            const before = regionIds(testWorldId);
            expect(before.length).toBeGreaterThan(0);
            expect(before.every(id => id.startsWith(`${testWorldId}:region:`))).toBe(true);

            await restoreFromSeed(testWorldId);

            expect(regionIds(testWorldId)).toEqual(before);
        });

        it('adopts legacy-format region rows, keeping their ownership and claims', async () => {
            const db = getDb();
            const generatedCount = getWorldManager().get(testWorldId)!.regions.length;
            const now = new Date().toISOString();

            // The shape the old seed path left behind: legacy ids only, one of
            // them owned and claimed by a nation.
            db.prepare('DELETE FROM structures WHERE world_id = ?').run(testWorldId);
            db.prepare('DELETE FROM regions WHERE world_id = ?').run(testWorldId);
            const insertLegacy = db.prepare(`
                INSERT INTO regions (id, world_id, name, type, center_x, center_y, color, owner_nation_id, control_level, created_at, updated_at)
                VALUES (?, ?, ?, 'wilderness', 0, 0, '#888888', NULL, 0, ?, ?)
            `);
            for (let n = 0; n < generatedCount; n++) {
                insertLegacy.run(`${testWorldId}:${n}`, testWorldId, `Region ${n + 1}`, now, now);
            }
            db.prepare(`
                INSERT INTO nations (id, world_id, name, leader, ideology, created_at, updated_at)
                VALUES ('nation-duty', ?, 'Duty', 'General Voronin', 'autocracy', ?, ?)
            `).run(testWorldId, now, now);
            db.prepare('UPDATE regions SET owner_nation_id = ?, control_level = 10 WHERE id = ?')
                .run('nation-duty', `${testWorldId}:0`);
            db.prepare(`
                INSERT INTO territorial_claims (id, nation_id, region_id, claim_strength, justification, created_at)
                VALUES ('claim-duty', 'nation-duty', ?, 100, 'Duty holds Rostok', ?)
            `).run(`${testWorldId}:0`, now);

            await restoreFromSeed(testWorldId);

            const expected = Array.from({ length: generatedCount }, (_, n) => `${testWorldId}:region:${n}`).sort();
            expect(regionIds(testWorldId)).toEqual(expected);

            const owned = db.prepare('SELECT owner_nation_id AS owner, control_level AS control FROM regions WHERE id = ?')
                .get(`${testWorldId}:region:0`) as { owner: string | null; control: number };
            expect(owned).toEqual({ owner: 'nation-duty', control: 10 });

            const claim = db.prepare('SELECT region_id AS regionId FROM territorial_claims WHERE id = ?')
                .get('claim-duty') as { regionId: string } | undefined;
            expect(claim?.regionId).toBe(`${testWorldId}:region:0`);
        });
    });

    describe('find_poi action', () => {
        it('should find valid POI locations', async () => {
            const result = await handleWorldMap({
                action: 'find_poi',
                worldId: testWorldId,
                poiType: 'city',
                count: 3
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('find_poi');
        });

        it('should accept "locate" alias', async () => {
            const result = await handleWorldMap({
                action: 'locate',
                worldId: testWorldId,
                poiType: 'town'
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('find_poi');
        });
    });

    describe('suggest_poi action', () => {
        it('should suggest POI locations in batch', async () => {
            const result = await handleWorldMap({
                action: 'suggest_poi',
                worldId: testWorldId,
                requests: [
                    { poiType: 'city', count: 1 },
                    { poiType: 'town', count: 2 }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('suggest_poi');
        });

        it('should accept "batch_poi" alias', async () => {
            const result = await handleWorldMap({
                action: 'batch_poi',
                worldId: testWorldId,
                requests: [
                    { poiType: 'village', count: 1 }
                ]
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('suggest_poi');
        });
    });

    describe('fuzzy matching', () => {
        it('should auto-correct close typos', async () => {
            const result = await handleWorldMap({
                action: 'overvew',  // Typo for 'overview'
                worldId: testWorldId
            }, ctx);

            const data = parseResult(result);
            expect(data.actionType).toBe('overview');
        });

        it('should provide helpful error for unknown action', async () => {
            const result = await handleWorldMap({
                action: 'xyz',
                worldId: testWorldId
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe('invalid_action');
            expect(data.message).toContain('Unknown action');
        });
    });

    describe('output formatting', () => {
        it('should include rich text formatting', async () => {
            const result = await handleWorldMap({
                action: 'overview',
                worldId: testWorldId
            }, ctx);

            const text = result.content[0].text;
            expect(text).toContain('🗺️');
        });

        it('should embed JSON for parsing', async () => {
            const result = await handleWorldMap({
                action: 'tiles',
                worldId: testWorldId
            }, ctx);

            const text = result.content[0].text;
            expect(text).toContain('<!-- WORLD_MAP_JSON');
        });
    });
});
