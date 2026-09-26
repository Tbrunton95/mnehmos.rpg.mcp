import { ToolContract, ToolCategory, ToolMetadata } from '../tool-metadata.js';
import { SessionContext } from '../types.js';
import { setToolContext } from '../tool-context.js';

interface ToolDescriptor {
    category: ToolCategory;
    keywords: string[];
    capabilities: string[];
    contextAware?: boolean;
    estimatedTokenCost?: ToolMetadata['estimatedTokenCost'];
    deferLoading?: boolean;
}

/**
 * One authoritative descriptor table used only while constructing contracts.
 * The registry never maintains a parallel category/keyword/capability map.
 */
const TOOL_DESCRIPTORS: Readonly<Record<string, ToolDescriptor>> = {
    secret_manage: { category: 'secret', keywords: ['secret', 'dm', 'hidden', 'mystery', 'reveal', 'clue'], capabilities: ['Create/manage DM secrets', 'Reveal conditions', 'Leak detection'] },
    rest_manage: { category: 'rest', keywords: ['rest', 'long', 'short', 'heal', 'recovery', 'hit dice'], capabilities: ['Long/short rest processing', 'HP restoration', 'Hit dice management'] },
    concentration_manage: { category: 'concentration', keywords: ['concentration', 'spell', 'save', 'break', 'maintain'], capabilities: ['Concentration checks', 'Break concentration', 'Duration tracking'] },
    narrative_manage: { category: 'narrative', keywords: ['narrative', 'story', 'note', 'journal', 'log'], capabilities: ['Story notes', 'Search history', 'Context retrieval'] },
    scroll_manage: { category: 'scroll', keywords: ['scroll', 'spell', 'use', 'create', 'identify', 'arcana'], capabilities: ['Use scrolls', 'Create scrolls', 'Check usability'] },
    character_manage: { category: 'character', keywords: ['character', 'pc', 'npc', 'create', 'update', 'stats', 'level', 'spell', 'spells', 'prepare', 'prepared', 'spellbook', 'cantrip', 'slots'], capabilities: ['CRUD characters', 'Level up', 'Stats management', 'Known/prepared spell management', 'Class spell-slot progression'] },
    party_manage: { category: 'party', keywords: ['party', 'group', 'member', 'leader', 'formation', 'gold'], capabilities: ['Party management', 'Member operations', 'Treasury'] },
    item_manage: { category: 'inventory', keywords: ['item', 'weapon', 'armor', 'gear', 'equipment', 'create'], capabilities: ['Item templates', 'CRUD items', 'Item search'] },
    inventory_manage: { category: 'inventory', keywords: ['inventory', 'give', 'take', 'equip', 'use', 'transfer'], capabilities: ['Give/take items', 'Equip/use', 'Transfer between characters'] },
    corpse_manage: { category: 'corpse', keywords: ['corpse', 'loot', 'harvest', 'decay', 'body', 'death'], capabilities: ['Loot corpses', 'Harvest materials', 'Decay management'] },
    combat_manage: { category: 'combat', keywords: ['combat', 'encounter', 'initiative', 'turn', 'end', 'start'], capabilities: ['Start/end encounters', 'Initiative', 'Death saves'] },
    combat_action: { category: 'combat', keywords: ['attack', 'cast', 'move', 'action', 'damage', 'heal'], capabilities: ['Attacks', 'Spell casting', 'Movement', 'Standard actions'] },
    combat_map: { category: 'combat', keywords: ['map', 'terrain', 'grid', 'aoe', 'position', 'tactical'], capabilities: ['Terrain management', 'AoE calculation', 'Grid operations'] },
    world_manage: { category: 'world', keywords: ['world', 'generate', 'seed', 'terrain', 'biome'], capabilities: ['World generation', 'State queries', 'Environment updates'] },
    world_map: { category: 'world', keywords: ['map', 'overview', 'region', 'patch', 'tiles'], capabilities: ['Map overview', 'Region details', 'Tile patching'] },
    spatial_manage: { category: 'spatial', keywords: ['room', 'look', 'move', 'exits', 'dungeon', 'space'], capabilities: ['Room generation', 'Movement', 'Exit management'] },
    quest_manage: { category: 'quest', keywords: ['quest', 'objective', 'assign', 'complete', 'reward'], capabilities: ['Quest lifecycle', 'Objectives', 'Rewards'] },
    npc_manage: { category: 'npc', keywords: ['npc', 'relationship', 'memory', 'conversation', 'social'], capabilities: ['Relationships', 'Memory', 'Social interactions'] },
    aura_manage: { category: 'aura', keywords: ['aura', 'effect', 'radius', 'buff', 'debuff', 'area'], capabilities: ['Create auras', 'Effect processing', 'Expiration'] },
    theft_manage: { category: 'theft', keywords: ['theft', 'steal', 'fence', 'crime', 'recognition', 'heat'], capabilities: ['Theft attempts', 'Fence operations', 'Heat tracking'] },
    improvisation_manage: { category: 'improvisation', keywords: ['stunt', 'improvise', 'creative', 'effect', 'homebrew'], capabilities: ['Stunts', 'Custom effects', 'Arcane synthesis'] },
    math_manage: { category: 'math', keywords: ['dice', 'roll', 'probability', 'algebra', 'physics', 'math', 'save', 'saving throw', 'check', 'skill'], capabilities: ['Dice rolling', 'Saving throws', 'Skill and ability checks', 'Probability', 'Math operations'] },
    strategy_manage: { category: 'strategy', keywords: ['nation', 'alliance', 'territory', 'strategy', 'diplomacy'], capabilities: ['Nation management', 'Diplomacy', 'Territory'] },
    turn_manage: { category: 'turn-management', keywords: ['turn', 'phase', 'ready', 'poll', 'results', 'async'], capabilities: ['Turn phases', 'Action submission', 'Result polling'] },
    spawn_manage: { category: 'world', keywords: ['spawn', 'create', 'encounter', 'location', 'tactical'], capabilities: ['Spawn characters', 'Create locations', 'Generate encounters'] },
    session_manage: { category: 'meta', keywords: ['session', 'initialize', 'context', 'start', 'resume'], capabilities: ['Session initialization', 'Context loading'] },
    travel_manage: { category: 'party', keywords: ['travel', 'move', 'rest', 'loot', 'journey', 'party'], capabilities: ['Party travel', 'Encounter looting', 'Camp/rest'] },
    batch_manage: { category: 'meta', keywords: ['batch', 'bulk', 'create', 'workflow', 'template'], capabilities: ['Bulk character creation', 'Workflows', 'Templates'] },
    agent_manage: { category: 'agent', keywords: ['agent', 'llm', 'npc', 'ai', 'persona', 'invoke', 'prompt', 'memory', 'autonomous'], capabilities: ['LLM-driven NPC minds', 'Modular prompt slices', 'Plain-text intent declarations', 'Auto-invoke on initiative'] },
    perception_manage: { category: 'meta', keywords: ['perception', 'hazard', 'control', 'safety', 'sight', 'blind-spot', 'attention', 'operator'], capabilities: ['Hierarchy-of-Controls hazard scanning', 'Attentional-capacity metering', 'Blind-spot detection (§3.5)', 'Disposition discipline'] },
    scene_manage: { category: 'narrative', keywords: ['scene', 'set_scene', 'frame', 'dm', 'narration', 'shared', 'state', 'context'], capabilities: ['DM-committed shared scenes', 'Auto-injected into agent prompts', 'Engine-side source of truth for "what is happening now"'] },
    // Campaign-layer tools (FINDINGS #92/#93/#99). Hull/siege/container/horde
    // metadata is carried over from the pre-contract registry; vehicle, ledger
    // and comms had none there and are described from their tool text.
    hull_manage: { category: 'world', keywords: ['hull', 'station', 'pressure', 'vent', 'power', 'atmosphere', 'life-support', 'section', 'keeper'], capabilities: ['Station sections: pressure/atmosphere/integrity/power', 'Power budget sum-vs-generation', 'Venting with Register-B occupant resolution', 'Life-support decay clock'] },
    siege_manage: { category: 'world', keywords: ['siege', 'compound', 'zone', 'barricade', 'wall', 'supplies', 'fortify', 'survival', 'zombie'], capabilities: ['Fortified-compound zones (hull_manage alias)', 'Generator budget and dark zones', 'Zone sacrifice with occupant enumeration', 'Supply pool decay'] },
    container_manage: { category: 'inventory', keywords: ['container', 'stash', 'cache', 'safe', 'backpack', 'boot', 'storage', 'put', 'take'], capabilities: ['Things inside things: stashes, safes, caches, boots', 'put/take moves real inventory rows', 'Locked/hidden/trapped flags', 'Capacity or unlimited'] },
    horde_manage: { category: 'world', keywords: ['horde', 'zombie', 'mass', 'noise', 'swarm', 'press', 'attraction', 'drift', 'walker'], capabilities: ['Mass entities: one object, not N combatants', 'Noise as a place-owned decaying value', 'Drift toward the loudest pull', 'resolve_press: how many reach the wall'] },
    vehicle_manage: { category: 'inventory', keywords: ['vehicle', 'car', 'plate', 'registration', 'defect', 'known', 'crime'], capabilities: ['Vehicles as rows: plate, registeredTo, status', 'Defects that can draw a lawful stop', 'Who can identify the vehicle and why', 'Cavities via container_manage'] },
    ledger_manage: { category: 'meta', keywords: ['ledger', 'debt', 'loan', 'due', 'settle', 'default', 'counterparty', 'crime'], capabilities: ['Debts with due dates and counterparties', 'Clock-driven status: pending → due → lapsed', 'process_due walks the in-fiction clock', 'settle/default as GM verbs'] },
    comms_manage: { category: 'npc', keywords: ['comms', 'phone', 'sim', 'contact', 'burner', 'reachable', 'handset', 'crime'], capabilities: ['Handset and SIM rows', 'Directional contact graph', 'Burn/swap/split SIMs', 'reachable(A→B) attribution checks'] },
    table_rules: { category: 'meta', keywords: ['rules', 'house', 'table', 'band', 'peer', 'called', 'strike', 'prepared', 'milestone', 'principle', 'homebrew'], capabilities: ['World house rules stored as data', 'Bands and peer consequences flagged on hits', 'Called strikes cripple limbs; prepared assets report tiers', 'Milestone XP, tiny status blocks, principles at boot'] },
    precedent_manage: { category: 'meta', keywords: ['precedent', 'ruling', 'invention', 'continuity', 'canon', 'decided', 'lookup'], capabilities: ['Rulings and inventions as dated, searchable records', 'Scope and tags for lookup', 'Supersede keeps the old ruling and points to the new'] },
    knowledge_manage: { category: 'npc', keywords: ['knowledge', 'secret', 'true name', 'who knows', 'rumour', 'investigation', 'told', 'witnessed'], capabilities: ['Who knows each fact and how they learned it', 'can_know before an NPC states a fact', 'Telling needs a teller who knows', 'Facts can grant effects to whoever knows them'] },
};

type ToolShape = {
    name: string;
    description: string;
    inputSchema: any;
    actionSchemas?: any;
};

type ToolHandler = Function;

/** Construct the single source-of-truth contract consumed by the registry. */
export function defineToolContract(tool: ToolShape, handler: ToolHandler): ToolContract {
    const descriptor = TOOL_DESCRIPTORS[tool.name];
    if (!descriptor) {
        throw new Error(`Missing consolidated tool descriptor for ${tool.name}`);
    }

    const metadata: ToolMetadata = {
        name: tool.name,
        description: tool.description,
        category: descriptor.category,
        keywords: descriptor.keywords,
        capabilities: descriptor.capabilities,
        contextAware: descriptor.contextAware ?? false,
        estimatedTokenCost: descriptor.estimatedTokenCost ?? 'medium',
        usageExample: `${tool.name}({ action: '...' })`,
        deferLoading: descriptor.deferLoading ?? true,
    };

    const name = tool.name;
    const dispatch = handler as (args: unknown, ctx: SessionContext) => Promise<unknown>;

    return {
        ...tool,
        metadata,
        schema: tool.inputSchema,
        actionSchemas: tool.actionSchemas,
        handler: (async (args: unknown, ctx: SessionContext) => {
            // FINDINGS #34 T1.4: stamp every dispatch so state-writing
            // repos can attribute their writes. Ghost writes end here.
            const action = (args as { action?: string })?.action;
            setToolContext(action ? `${name}.${action}` : name);
            return dispatch(args, ctx);
        }) as ToolContract['handler'],
    };
}

export function getToolDescriptors(): Readonly<Record<string, ToolDescriptor>> {
    return TOOL_DESCRIPTORS;
}
