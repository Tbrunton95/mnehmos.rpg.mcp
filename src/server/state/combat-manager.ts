import { CombatEngine } from '../../engine/combat/engine.js';

/**
 * Engines are keyed `${sessionId}:${encounterId}`. With a sessionId, only
 * that session's engines match, so one table's combat never blocks or
 * clears another's. Without one, every engine matches (legacy callers).
 */
function inSession(key: string, sessionId?: string): boolean {
    return sessionId === undefined || key.startsWith(`${sessionId}:`);
}

export class CombatManager {
    private encounters: Map<string, CombatEngine> = new Map();

    create(id: string, engine: CombatEngine): void {
        if (this.encounters.has(id)) {
            throw new Error(`Encounter ${id} already exists`);
        }
        this.encounters.set(id, engine);
    }

    get(id: string): CombatEngine | null {
        return this.encounters.get(id) || null;
    }

    delete(id: string): boolean {
        return this.encounters.delete(id);
    }

    list(): string[] {
        return Array.from(this.encounters.keys());
    }

    clear(): void {
        this.encounters.clear();
    }

    /**
     * Check if a character is participating in any active encounter
     * Used to prevent resting during combat
     */
    isCharacterInCombat(characterId: string, sessionId?: string): boolean {
        for (const [key, engine] of this.encounters.entries()) {
            if (!inSession(key, sessionId)) continue;
            const state = engine.getState();
            if (state?.participants.some(p => p.id === characterId)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Get list of encounter IDs that a character is participating in
     * Useful for error messages
     */
    getEncountersForCharacter(characterId: string, sessionId?: string): string[] {
        const encounterIds: string[] = [];
        for (const [id, engine] of this.encounters.entries()) {
            if (!inSession(id, sessionId)) continue;
            const state = engine.getState();
            if (state?.participants.some(p => p.id === characterId)) {
                encounterIds.push(id);
            }
        }
        return encounterIds;
    }

    /**
     * Delete ALL encounters that contain a specific character
     * Used to clean up stale combat state after end_encounter
     * @returns Number of encounters deleted
     */
    deleteEncountersForCharacter(characterId: string, sessionId?: string): number {
        const toDelete: string[] = [];
        for (const [id, engine] of this.encounters.entries()) {
            if (!inSession(id, sessionId)) continue;
            const state = engine.getState();
            if (state?.participants.some(p => p.id === characterId)) {
                toDelete.push(id);
            }
        }
        
        for (const id of toDelete) {
            this.encounters.delete(id);
        }
        
        return toDelete.length;
    }
}

// Singleton for server lifetime
let instance: CombatManager | null = null;
export function getCombatManager(): CombatManager {
    if (!instance) instance = new CombatManager();
    return instance;
}
