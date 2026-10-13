/**
 * Scene repository — DM-committed shared narrative frames.
 *
 * A scene is the engine-side source of truth for "what is happening now"
 * across all participants. Agent invocations auto-inject the latest scene
 * the character is a participant in, so every party-mate reads the same
 * narration, the same engine state, the same NPC list. Zero drift on
 * shared facts; agents contribute only their character's INTENT.
 *
 * Append-only in spirit: DM advances by calling set_scene with a new id;
 * old scenes remain for transcript and audit.
 */

import Database from 'better-sqlite3';
import { normalizeSenseDenial, type SenseDenialEntry } from '../../engine/senses.js';

export interface SceneRow {
    id: string;
    world_id: string;
    title: string | null;
    when_label: string | null;
    place_label: string | null;
    narration: string;
    engine_state: string;
    participants: string;
    previous_scene_id: string | null;
    created_at: string;
    /** Play report 5 #8c: JSON [{targetId?, senses: {scent: reason}}]. */
    sense_denial?: string | null;
    /** Play report 5 #8c: 'from W'. */
    wind?: string | null;
}

export interface Scene {
    id: string;
    worldId: string;
    title: string | null;
    whenLabel: string | null;
    placeLabel: string | null;
    narration: string;
    engineState: Record<string, unknown>;
    participants: string[];
    previousSceneId: string | null;
    createdAt: string;
    /** Play report 5 #8c: senses the scene denies, scene-wide or per target, with the stated reason. */
    senseDenial: SenseDenialEntry[];
    /** Play report 5 #8c: the wind ('from W'); with token positions the engine computes upwind and downwind. */
    wind: string | null;
}

export interface CreateSceneInput {
    id: string;
    worldId: string;
    title?: string | null;
    whenLabel?: string | null;
    placeLabel?: string | null;
    narration: string;
    engineState?: Record<string, unknown>;
    participants: string[];
    previousSceneId?: string | null;
    createdAt: string;
    senseDenial?: SenseDenialEntry[];
    wind?: string | null;
}

function rowToScene(row: SceneRow): Scene {
    let senseDenial: SenseDenialEntry[] = [];
    if (row.sense_denial) { try { senseDenial = normalizeSenseDenial(JSON.parse(row.sense_denial)); } catch { senseDenial = []; } }
    return {
        id: row.id,
        worldId: row.world_id,
        title: row.title,
        whenLabel: row.when_label,
        placeLabel: row.place_label,
        narration: row.narration,
        engineState: row.engine_state ? JSON.parse(row.engine_state) : {},
        participants: row.participants ? JSON.parse(row.participants) : [],
        previousSceneId: row.previous_scene_id,
        createdAt: row.created_at,
        senseDenial,
        wind: row.wind ?? null
    };
}

export class SceneRepository {
    constructor(private db: Database.Database) {}

    create(input: CreateSceneInput): Scene {
        this.db.prepare(`
            INSERT INTO scenes (id, world_id, title, when_label, place_label, narration, engine_state, participants, previous_scene_id, created_at, sense_denial, wind)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            input.id,
            input.worldId,
            input.title ?? null,
            input.whenLabel ?? null,
            input.placeLabel ?? null,
            input.narration,
            JSON.stringify(input.engineState ?? {}),
            JSON.stringify(input.participants),
            input.previousSceneId ?? null,
            input.createdAt,
            input.senseDenial?.length ? JSON.stringify(input.senseDenial) : null,
            input.wind ?? null
        );
        return this.findById(input.id)!;
    }

    findById(id: string): Scene | null {
        const row = this.db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as SceneRow | undefined;
        return row ? rowToScene(row) : null;
    }

    /**
     * Latest scene a given character participates in (across all worlds — characters
     * are typically bound to one world via party/region but we don't require it here).
     * Used by the prompt composer to inject the current scene as a system slice.
     * Returns null if the character has never been a participant.
     *
     * If worldId is provided, scopes the lookup to that world.
     */
    findLatestForParticipant(characterId: string, worldId?: string): Scene | null {
        const scenes = this.listLatestForParticipant(characterId, 1, worldId);
        return scenes[0] ?? null;
    }

    /**
     * Same as findLatestForParticipant but returns up to N most recent (newest-first).
     * Used when the DM wants to inject a short prior-context window.
     */
    listLatestForParticipant(characterId: string, limit: number, worldId?: string): Scene[] {
        // We over-fetch and filter, because the LIKE match on a JSON array is coarse:
        // "abc123" in participants ["abc12345..."] would falsely match. Fetch a few
        // extra and verify each scene's participants[] actually contains the id.
        const overFetch = Math.max(limit * 3, 10);
        let rows: SceneRow[];
        if (worldId) {
            rows = this.db.prepare(`
                SELECT * FROM scenes
                WHERE world_id = ?
                  AND participants LIKE ?
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
            `).all(worldId, `%"${characterId}"%`, overFetch) as SceneRow[];
        } else {
            rows = this.db.prepare(`
                SELECT * FROM scenes
                WHERE participants LIKE ?
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
            `).all(`%"${characterId}"%`, overFetch) as SceneRow[];
        }
        return rows
            .map(rowToScene)
            .filter(s => s.participants.includes(characterId))
            .slice(0, limit);
    }

    listRecent(worldId: string, limit: number): Scene[] {
        const rows = this.db.prepare(`
            SELECT * FROM scenes
            WHERE world_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
        `).all(worldId, limit) as SceneRow[];
        return rows.map(rowToScene);
    }
}
