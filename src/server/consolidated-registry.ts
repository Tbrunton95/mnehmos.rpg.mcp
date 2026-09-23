/**
 * Consolidated Tool Registry for v1.0 Clean-Break Release
 *
 * Registers only the 28 consolidated tools (85% reduction from 195 tools).
 * Each tool uses action-based routing with fuzzy matching and guiding errors.
 */

import { ToolMetadata, ToolCategory, ToolRegistry } from './tool-metadata.js';
import { ConsolidatedTools } from './consolidated/index.js';
import { SessionContext } from './types.js';
import { setToolContext } from './tool-context.js';

// ═══════════════════════════════════════════════════════════════════════════
// METADATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function meta(
    name: string,
    description: string,
    category: ToolCategory,
    keywords: string[],
    capabilities: string[],
    contextAware: boolean = false,
    estimatedTokenCost: 'low' | 'medium' | 'high' | 'variable' = 'medium',
    deferLoading: boolean = true
): ToolMetadata {
    return {
        name,
        description,
        category,
        keywords,
        capabilities,
        contextAware,
        estimatedTokenCost,
        usageExample: `${name}({ action: '...' })`,
        deferLoading
    };
}

// Map tool names to categories
const TOOL_CATEGORIES: Record<string, ToolCategory> = {
    secret_manage: 'secret',
    rest_manage: 'rest',
    concentration_manage: 'concentration',
    narrative_manage: 'narrative',
    scroll_manage: 'scroll',
    character_manage: 'character',
    party_manage: 'party',
    item_manage: 'inventory',
    inventory_manage: 'inventory',
    corpse_manage: 'corpse',
    combat_manage: 'combat',
    combat_action: 'combat',
    combat_map: 'combat',
    world_manage: 'world',
    world_map: 'world',
    spatial_manage: 'spatial',
    quest_manage: 'quest',
    npc_manage: 'npc',
    aura_manage: 'aura',
    theft_manage: 'theft',
    improvisation_manage: 'improvisation',
    math_manage: 'math',
    strategy_manage: 'strategy',
    turn_manage: 'turn-management',
    spawn_manage: 'world',
    session_manage: 'meta',
    travel_manage: 'party',
    batch_manage: 'meta',
    agent_manage: 'agent',
    perception_manage: 'meta',
    scene_manage: 'narrative',
    hull_manage: 'world',
    siege_manage: 'world',
    container_manage: 'inventory',
    horde_manage: 'world',
};

// Map tool names to keywords
const TOOL_KEYWORDS: Record<string, string[]> = {
    secret_manage: ['secret', 'dm', 'hidden', 'mystery', 'reveal', 'clue'],
    rest_manage: ['rest', 'long', 'short', 'heal', 'recovery', 'hit dice'],
    concentration_manage: ['concentration', 'spell', 'save', 'break', 'maintain'],
    narrative_manage: ['narrative', 'story', 'note', 'journal', 'log'],
    scroll_manage: ['scroll', 'spell', 'use', 'create', 'identify', 'arcana'],
    character_manage: ['character', 'pc', 'npc', 'create', 'update', 'stats', 'level'],
    party_manage: ['party', 'group', 'member', 'leader', 'formation', 'gold'],
    item_manage: ['item', 'weapon', 'armor', 'gear', 'equipment', 'create'],
    inventory_manage: ['inventory', 'give', 'take', 'equip', 'use', 'transfer'],
    corpse_manage: ['corpse', 'loot', 'harvest', 'decay', 'body', 'death'],
    combat_manage: ['combat', 'encounter', 'initiative', 'turn', 'end', 'start'],
    combat_action: ['attack', 'cast', 'move', 'action', 'damage', 'heal'],
    combat_map: ['map', 'terrain', 'grid', 'aoe', 'position', 'tactical'],
    world_manage: ['world', 'generate', 'seed', 'terrain', 'biome'],
    world_map: ['map', 'overview', 'region', 'patch', 'tiles'],
    spatial_manage: ['room', 'look', 'move', 'exits', 'dungeon', 'space'],
    quest_manage: ['quest', 'objective', 'assign', 'complete', 'reward'],
    npc_manage: ['npc', 'relationship', 'memory', 'conversation', 'social'],
    aura_manage: ['aura', 'effect', 'radius', 'buff', 'debuff', 'area'],
    theft_manage: ['theft', 'steal', 'fence', 'crime', 'recognition', 'heat'],
    improvisation_manage: ['stunt', 'improvise', 'creative', 'effect', 'homebrew'],
    math_manage: ['dice', 'roll', 'probability', 'algebra', 'physics', 'math'],
    strategy_manage: ['nation', 'alliance', 'territory', 'strategy', 'diplomacy'],
    turn_manage: ['turn', 'phase', 'ready', 'poll', 'results', 'async'],
    spawn_manage: ['spawn', 'create', 'encounter', 'location', 'tactical'],
    session_manage: ['session', 'initialize', 'context', 'start', 'resume'],
    travel_manage: ['travel', 'move', 'rest', 'loot', 'journey', 'party'],
    batch_manage: ['batch', 'bulk', 'create', 'workflow', 'template'],
    agent_manage: ['agent', 'llm', 'npc', 'ai', 'persona', 'invoke', 'prompt', 'memory', 'autonomous'],
    perception_manage: ['perception', 'hazard', 'control', 'safety', 'sight', 'blind-spot', 'attention', 'operator'],
    scene_manage: ['scene', 'set_scene', 'frame', 'dm', 'narration', 'shared', 'state', 'context'],
    hull_manage: ['hull', 'station', 'pressure', 'vent', 'power', 'atmosphere', 'life-support', 'section', 'keeper'],
    siege_manage: ['siege', 'compound', 'zone', 'barricade', 'wall', 'supplies', 'fortify', 'survival', 'zombie'],
    container_manage: ['container', 'stash', 'cache', 'safe', 'backpack', 'boot', 'storage', 'put', 'take'],
    horde_manage: ['horde', 'zombie', 'mass', 'noise', 'swarm', 'press', 'attraction', 'drift', 'walker'],
};

// Map tool names to capabilities
const TOOL_CAPABILITIES: Record<string, string[]> = {
    secret_manage: ['Create/manage DM secrets', 'Reveal conditions', 'Leak detection'],
    rest_manage: ['Long/short rest processing', 'HP restoration', 'Hit dice management'],
    concentration_manage: ['Concentration checks', 'Break concentration', 'Duration tracking'],
    narrative_manage: ['Story notes', 'Search history', 'Context retrieval'],
    scroll_manage: ['Use scrolls', 'Create scrolls', 'Check usability'],
    character_manage: ['CRUD characters', 'Level up', 'Stats management'],
    party_manage: ['Party management', 'Member operations', 'Treasury'],
    item_manage: ['Item templates', 'CRUD items', 'Item search'],
    inventory_manage: ['Give/take items', 'Equip/use', 'Transfer between characters'],
    corpse_manage: ['Loot corpses', 'Harvest materials', 'Decay management'],
    combat_manage: ['Start/end encounters', 'Initiative', 'Death saves'],
    combat_action: ['Attacks', 'Spell casting', 'Movement', 'Standard actions'],
    combat_map: ['Terrain management', 'AoE calculation', 'Grid operations'],
    world_manage: ['World generation', 'State queries', 'Environment updates'],
    world_map: ['Map overview', 'Region details', 'Tile patching'],
    spatial_manage: ['Room generation', 'Movement', 'Exit management'],
    quest_manage: ['Quest lifecycle', 'Objectives', 'Rewards'],
    npc_manage: ['Relationships', 'Memory', 'Social interactions'],
    aura_manage: ['Create auras', 'Effect processing', 'Expiration'],
    theft_manage: ['Theft attempts', 'Fence operations', 'Heat tracking'],
    improvisation_manage: ['Stunts', 'Custom effects', 'Arcane synthesis'],
    math_manage: ['Dice rolling', 'Probability', 'Math operations'],
    strategy_manage: ['Nation management', 'Diplomacy', 'Territory'],
    turn_manage: ['Turn phases', 'Action submission', 'Result polling'],
    spawn_manage: ['Spawn characters', 'Create locations', 'Generate encounters'],
    session_manage: ['Session initialization', 'Context loading'],
    travel_manage: ['Party travel', 'Encounter looting', 'Camp/rest'],
    batch_manage: ['Bulk character creation', 'Workflows', 'Templates'],
    agent_manage: ['LLM-driven NPC minds', 'Modular prompt slices', 'Plain-text intent declarations', 'Auto-invoke on initiative'],
    perception_manage: ['Hierarchy-of-Controls hazard scanning', 'Attentional-capacity metering', 'Blind-spot detection (§3.5)', 'Disposition discipline'],
    scene_manage: ['DM-committed shared scenes', 'Auto-injected into agent prompts', 'Engine-side source of truth for "what is happening now"'],
    hull_manage: ['Station sections: pressure/atmosphere/integrity/power', 'Power budget sum-vs-generation', 'Venting with Register-B occupant resolution', 'Life-support decay clock'],
    siege_manage: ['Fortified-compound zones (hull_manage alias)', 'Generator budget and dark zones', 'Zone sacrifice with occupant enumeration', 'Supply pool decay'],
    container_manage: ['Things inside things: stashes, safes, caches, boots', 'put/take moves real inventory rows', 'Locked/hidden/trapped flags', 'Capacity or unlimited'],
    horde_manage: ['Mass entities: one object, not N combatants', 'Noise as a place-owned decaying value', 'Drift toward the loudest pull', 'resolve_press: how many reach the wall'],
};

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRY BUILDER
// ═══════════════════════════════════════════════════════════════════════════

let cachedRegistry: ToolRegistry | null = null;

export function buildConsolidatedRegistry(): ToolRegistry {
    if (cachedRegistry) return cachedRegistry;

    cachedRegistry = {};

    for (const { tool, handler } of ConsolidatedTools) {
        const name = tool.name;
        const category = TOOL_CATEGORIES[name] || 'meta';
        const keywords = TOOL_KEYWORDS[name] || [name];
        const capabilities = TOOL_CAPABILITIES[name] || [];

        cachedRegistry[name] = {
            metadata: meta(
                name,
                tool.description,
                category,
                keywords,
                capabilities,
                false,  // contextAware
                'medium',  // estimatedTokenCost
                true  // deferLoading
            ),
            schema: tool.inputSchema,
            actionSchemas: (tool as { actionSchemas?: unknown }).actionSchemas,
            handler: (async (args: unknown, ctx: SessionContext) => {
                // FINDINGS #34 T1.4: stamp every dispatch so state-writing
                // repos can attribute their writes. Ghost writes end here.
                const action = (args as { action?: string })?.action;
                setToolContext(action ? `${name}.${action}` : name);
                return (handler as (a: unknown, c: SessionContext) => Promise<unknown>)(args, ctx);
            }) as (args: unknown, ctx: SessionContext) => Promise<any>
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
    const registry = buildConsolidatedRegistry();
    return Object.values(registry).map(entry => entry.metadata);
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
    const registry = buildConsolidatedRegistry();
    return registry[name] || null;
}
