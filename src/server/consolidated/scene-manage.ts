/**
 * scene_manage — DM-committed shared narrative state.
 *
 * The DM is the System; the System is the DM. set_scene commits the current
 * narrative frame to the engine. Every agent invocation auto-pulls the
 * latest scene the character is a participant in — so every party-mate
 * reads the same narration, the same engine state, the same NPC list.
 * Zero drift on shared facts. Agents contribute only their character's
 * INTENT; the DM (this tool) authors the world.
 *
 * Actions:
 *   set      — commit a new scene (DM "GM screen" voice)
 *   list     — recent scenes for a world
 *   get      — fetch one by id
 *   current  — the latest scene for a participant (debug; auto-injection
 *              uses the same query under the hood)
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { SessionContext } from '../types.js';
import { getDb } from '../../storage/index.js';
import { SceneRepository } from '../../storage/repos/scene.repo.js';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { normalizeSenseDenial, parseWind } from '../../engine/senses.js';

// Play report 5 #8c: a scene states what the senses cannot do, scene-wide
// ({scent: 'wind from the east carries everything away'}) or for one target
// ({targetId, scent: 'buried in peat-smoke'}), or an array of either. The
// preprocess normalises both shapes to [{targetId?, senses: {<sense>: reason}}];
// an entry that names no sense ({targetId} alone, a bare 'scent') is kept as
// {senses: {}} so the schema refuses it by name instead of writing an empty
// amendment; anything that is not an object or array is left for the schema
// to refuse. A fresh instance each call (outer schemas never share one).
function senseDenialEntries(v: unknown): unknown {
    if (v === undefined || v === null || typeof v !== 'object') return v;
    const items = Array.isArray(v) ? v : [v];
    return items.map(item => {
        const [entry] = normalizeSenseDenial(item);
        if (entry) return entry;
        const rec = item && typeof item === 'object' ? item as Record<string, unknown> : {};
        return { ...(typeof rec.targetId === 'string' ? { targetId: rec.targetId } : {}), senses: {} };
    });
}
const senseDenialField = () => z.preprocess(
    senseDenialEntries,
    z.array(z.object({
        targetId: z.string().optional(),
        senses: z.record(z.string().min(1)).refine(s => Object.keys(s).length > 0, { message: "names no sense: pass {scent: 'reason'} for the scene or {targetId, scent: 'reason'} for one character" })
    }))
).optional().describe("Play report 5 #8c: senses this scene denies, with the reason quoted on every tagged roll: {scent: 'wind from the east carries everything away'} for everyone, {targetId, scent: 'buried in peat-smoke'} for one character, or an array of either. A tagged check under a denial gets no trait advantage; a denial set after a roll never touches that roll. Without narration it amends the latest scene (the wind is kept); [] clears the denial");
const windField = () => z.string().min(1).optional().describe("Play report 5 #8c: the wind ('from W', 'from the north-east'). With token positions in a fight the engine computes upwind (scent carries) and downwind (carried away, denied) by itself; an explicit senseDenial overrides it. East is +x, north is -y. Without narration it amends the latest scene (its senseDenial is kept); 'still' names no compass point and so decides nothing");

const ACTIONS = ['set', 'list', 'get', 'current'] as const;
type SceneAction = typeof ACTIONS[number];

function ensureDb() {
    return getDb();
}

const SetSchema = z.object({
    action: z.literal('set'),
    worldId: z.string().describe('World/campaign ID'),
    title: z.string().optional().describe('Short scene title (e.g., "What the Hour Can Honestly Hold")'),
    whenLabel: z.string().optional().describe('In-world time label (e.g., "PD 606 · Day 1 · 00:15")'),
    placeLabel: z.string().optional().describe('In-world place label (e.g., "Vocation House Inner Chamber, Sebastopyr")'),
    narration: z.string().min(1).optional().describe('DM-authored prose for the scene — the shared world state every participant sees. Required for a new frame; omit with senseDenial or wind to amend the latest scene (its narration and participants are inherited)'),
    engineState: z.record(z.any()).optional().describe('Engine-tracked meters / hazards / flags for this moment (e.g., vas_halidani: "6412/15468", brass_nail_line: "nominal"). Free-form key/value.'),
    participants: z.array(z.string()).min(1).optional().describe('Character IDs at the table for this scene — only these characters\' agents will see this scene on invoke. Inherited from the latest scene when omitted'),
    previousSceneId: z.string().optional().describe('Optional back-pointer to the prior scene (for transcript / linked-list ordering)'),
    sceneId: z.string().optional().describe('Optional explicit scene ID (default: auto-generated UUID)'),
    senseDenial: senseDenialField(),
    wind: windField()
});

const ListSchema = z.object({
    action: z.literal('list'),
    worldId: z.string().describe('World/campaign ID'),
    limit: z.number().int().min(1).max(100).optional().default(20)
});

const GetSchema = z.object({
    action: z.literal('get'),
    sceneId: z.string().describe('Scene ID')
});

const CurrentSchema = z.object({
    action: z.literal('current'),
    worldId: z.string(),
    characterId: z.string().describe('Character whose latest participating scene to fetch')
});

async function handleSet(args: z.infer<typeof SetSchema>): Promise<object> {
    const db = ensureDb();

    const worldCheck = db.prepare('SELECT id FROM worlds WHERE id = ?').get(args.worldId);
    if (!worldCheck) {
        return {
            error: true,
            code: 'WORLD_NOT_FOUND',
            message: `World "${args.worldId}" not found. Create it first with world_manage.`,
            suggestion: `Call: world_manage action: 'create' with id: '${args.worldId}'`
        };
    }

    const repo = new SceneRepository(db);

    // Play report 5 #8c: a set with no narration amends the latest scene —
    // the GM states a denial or the wind without retyping the frame. The new
    // scene inherits what was not passed; nothing to inherit is a refusal.
    const amending = args.narration === undefined || args.participants === undefined;
    const latest = amending ? repo.listRecent(args.worldId, 1)[0] : undefined;
    const inherited: string[] = [];
    if (args.narration === undefined && args.senseDenial === undefined && args.wind === undefined) {
        return { error: true, code: 'NARRATION_REQUIRED', writes: 'none', message: 'A new scene needs narration; to amend the latest scene pass senseDenial and/or wind without it. NOTHING was written.' };
    }
    if (amending && !latest) {
        return { error: true, code: 'NOTHING_TO_AMEND', writes: 'none', message: `No scene in world "${args.worldId}" to inherit ${args.narration === undefined ? 'narration' : 'participants'} from — pass narration and participants for the first frame. NOTHING was written.` };
    }
    const narration = args.narration ?? latest!.narration;
    if (args.narration === undefined) inherited.push('narration');
    const participants = args.participants ?? latest!.participants;
    if (args.participants === undefined) inherited.push('participants');
    const inherit = <K extends 'title' | 'whenLabel' | 'placeLabel' | 'engineState'>(key: K, given: unknown) => {
        if (given !== undefined || !latest || args.narration !== undefined) return given;
        inherited.push(key);
        return latest[key];
    };
    const title = inherit('title', args.title) as string | null | undefined;
    const whenLabel = inherit('whenLabel', args.whenLabel) as string | null | undefined;
    const placeLabel = inherit('placeLabel', args.placeLabel) as string | null | undefined;
    const engineState = inherit('engineState', args.engineState) as Record<string, unknown> | undefined;
    // An amendment keeps the denial and the wind it did not restate, so a
    // denial stated after a wind still overrides that wind (the owner's spec)
    // and a wind stated after a denial does not lift it. senseDenial: []
    // clears the denial; a new frame (narration given) carries neither forward.
    const amendsSenses = args.narration === undefined && !!latest;
    const senseDenial = args.senseDenial ?? (amendsSenses ? latest!.senseDenial : []);
    if (args.senseDenial === undefined && amendsSenses && latest!.senseDenial.length) inherited.push('senseDenial');
    const wind = args.wind ?? (amendsSenses ? latest!.wind : null);
    if (args.wind === undefined && amendsSenses && latest!.wind) inherited.push('wind');

    // Verify all participants exist as characters (or NPCs sharing the characters table).
    const missing: string[] = [];
    for (const id of participants) {
        const row = db.prepare('SELECT id FROM characters WHERE id = ?').get(id);
        if (!row) missing.push(id);
    }
    if (missing.length > 0) {
        return {
            error: true,
            code: 'PARTICIPANT_NOT_FOUND',
            message: `Participant characters not found: ${missing.join(', ')}`,
            suggestion: 'Verify character IDs with character_manage action: "list" or "get".'
        };
    }
    // A denial naming a target that is not in the scene is still stored (an
    // observer outside the roster can be denied), but one naming nobody is refused.
    for (const d of args.senseDenial ?? []) {
        if (d.targetId && !db.prepare('SELECT id FROM characters WHERE id = ?').get(d.targetId)) {
            return { error: true, code: 'PARTICIPANT_NOT_FOUND', writes: 'none', message: `senseDenial targetId ${d.targetId} is not a character. NOTHING was written.` };
        }
    }
    const windNote = args.wind ? (parseWind(args.wind) ? `wind ${args.wind}` : `wind '${args.wind}' names no compass point, so positions cannot place anyone upwind or downwind of it`) : undefined;

    const scene = repo.create({
        id: args.sceneId ?? randomUUID(),
        worldId: args.worldId,
        title: title ?? null,
        whenLabel: whenLabel ?? null,
        placeLabel: placeLabel ?? null,
        narration,
        engineState: engineState ?? {},
        participants,
        previousSceneId: args.previousSceneId ?? (amending ? latest!.id : null),
        createdAt: new Date().toISOString(),
        senseDenial,
        wind
    });

    const denialText = scene.senseDenial.flatMap(d => Object.entries(d.senses).map(([sense, reason]) => `${sense}${d.targetId ? ` for ${d.targetId}` : ''}: ${reason}`));
    return {
        actionType: 'set',
        success: true,
        sceneId: scene.id,
        scene,
        ...(inherited.length ? { inherited } : {}),
        message: `Scene committed. ${scene.participants.length} participant(s) will see this on next invoke.${inherited.length ? ` Inherited ${inherited.join(', ')} from the latest scene.` : ''}${denialText.length ? ` Senses denied — ${denialText.join('; ')}.` : ''}${windNote ? ` ${windNote[0].toUpperCase()}${windNote.slice(1)}.` : ''} Rolls already made are untouched.`
    };
}

async function handleList(args: z.infer<typeof ListSchema>): Promise<object> {
    const repo = new SceneRepository(ensureDb());
    const scenes = repo.listRecent(args.worldId, args.limit);
    return { actionType: 'list', count: scenes.length, scenes };
}

async function handleGet(args: z.infer<typeof GetSchema>): Promise<object> {
    const repo = new SceneRepository(ensureDb());
    const scene = repo.findById(args.sceneId);
    if (!scene) {
        return { error: true, code: 'NOT_FOUND', message: `Scene "${args.sceneId}" not found.` };
    }
    return { actionType: 'get', scene };
}

async function handleCurrent(args: z.infer<typeof CurrentSchema>): Promise<object> {
    const repo = new SceneRepository(ensureDb());
    const scene = repo.findLatestForParticipant(args.characterId, args.worldId);
    if (!scene) {
        return {
            actionType: 'current',
            scene: null,
            message: `No scene committed yet for character ${args.characterId} in world ${args.worldId}.`
        };
    }
    return { actionType: 'current', scene };
}

const definitions: Record<SceneAction, ActionDefinition> = {
    set: {
        schema: SetSchema,
        handler: handleSet,
        aliases: ['commit', 'set_scene', 'create', 'new', 'frame', 'narrate_scene'],
        description: 'Commit a new scene — DM voice. Auto-injected into all participants\' next invoke.'
    },
    list: {
        schema: ListSchema,
        handler: handleList,
        aliases: ['recent', 'history', 'transcript'],
        description: 'List recent scenes for a world (newest-first).'
    },
    get: {
        schema: GetSchema,
        handler: handleGet,
        aliases: ['fetch', 'read'],
        description: 'Fetch a single scene by id.'
    },
    current: {
        schema: CurrentSchema,
        handler: handleCurrent,
        aliases: ['now', 'present', 'latest'],
        description: 'The latest scene a given character is a participant in (preview what their next invoke will see).'
    }
};

const router = createActionRouter({
    actions: ACTIONS,
    definitions,
    threshold: 0.6
});

export const SceneManageTool = {
    name: 'scene_manage',
    description: `Manage DM-committed shared scenes — the engine-side source of truth for "what is happening now."

🎬 SET A SCENE (DM voice):
  scene_manage action: 'set'
  - worldId, narration, participants[] required
  - title, whenLabel, placeLabel, engineState, previousSceneId optional

🎭 AUTO-INJECTION:
  After set, every participant agent's invoke will automatically include this
  scene as a system slice — same narration, same engine state, same party
  roster for everyone. Agents submit INTENT; they do not author the scene.

👃 SENSES (play report 5 #8c):
  set {senseDenial: {scent: 'wind from the east carries everything away'}} denies a sense for everyone in the scene;
  {senseDenial: {targetId, scent: 'buried in peat-smoke'}} for one character; an array mixes both. A math_manage check
  tagged context: ['scent'] under a denial gets no skillAdvantage trait and quotes the reason; the passive for that
  sense is not compared. wind: 'from W' plus token positions lets the engine place a sniffer upwind or downwind of a
  source (opposed, against). Pass senseDenial or wind WITHOUT narration to amend the latest scene (narration,
  participants, and whichever of senseDenial/wind was not restated are inherited; senseDenial: [] clears the denial;
  a denial that names no sense is refused). A new frame (narration given) carries neither forward. Rolls are
  immutable: a denial set after a roll never touches it.

⏪ AUDIT:
  - 'list' for recent scenes in a world
  - 'get' for one by id
  - 'current' to preview what a given character's next invoke will see

Actions: set, list, get, current
Aliases: commit/set_scene/frame/narrate_scene→set, recent/history→list, now/latest→current`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe('Action: set, list, get, current'),
        worldId: z.string().optional(),
        sceneId: z.string().optional(),
        characterId: z.string().optional(),
        title: z.string().optional(),
        whenLabel: z.string().optional(),
        placeLabel: z.string().optional(),
        narration: z.string().optional(),
        engineState: z.record(z.any()).optional(),
        participants: z.array(z.string()).optional(),
        previousSceneId: z.string().optional(),
        limit: z.number().optional(),
        senseDenial: senseDenialField(),
        wind: windField()
    })
};

export async function handleSceneManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    return router(args as Record<string, unknown>);
}
