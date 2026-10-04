/**
 * Knowledge slice — what the NPC knows, by the table's knowledge ledger.
 *
 * Reads knowledge_facts / knowledge_holders (knowledge_manage): the facts
 * this character holds, each with the road it came by, plus the world's
 * common knowledge. It closes with a standing order: on restricted or
 * secret matters the NPC states nothing beyond this list, so an agent
 * cannot know a name the table never gave it, and a rival schemes on what
 * it actually knows. Empty (null) when no fact reaches the character.
 */
import type Database from 'better-sqlite3';
import { resolveWorldId } from '../../../engine/table-rules.js';

const HEADER = '--- WHAT YOU KNOW ---';
export const KNOWLEDGE_CLOSING = 'State nothing beyond this on restricted or secret matters; if asked, deflect in character.';

type HeldRow = { key: string; statement: string; secrecy: string; how: string; from_id: string | null; note: string | null; day: number | null };
type CommonRow = { key: string; statement: string };

/** The facts a character holds, by secrecy then insertion, and the world's common facts it does not hold. */
export function knowledgeFor(db: Database.Database, characterId: string): { held: HeldRow[]; common: CommonRow[] } {
    let held: HeldRow[] = [];
    let common: CommonRow[] = [];
    try {
        held = db.prepare(`SELECT f.key, f.statement, f.secrecy, h.how, h.from_id, h.note, h.day
            FROM knowledge_holders h JOIN knowledge_facts f ON f.id = h.fact_id
            WHERE h.knower_id = ?
            ORDER BY CASE f.secrecy WHEN 'secret' THEN 0 WHEN 'restricted' THEN 1 ELSE 2 END, h.created_at, f.created_at`).all(characterId) as HeldRow[];
    } catch { return { held: [], common: [] }; }
    const worldId = resolveWorldId(db, { characterIds: [characterId] });
    if (worldId) {
        try {
            const heldKeys = new Set(held.map(h => h.key));
            common = (db.prepare(`SELECT key, statement FROM knowledge_facts WHERE world_id = ? AND secrecy = 'common' ORDER BY created_at`).all(worldId) as CommonRow[])
                .filter(c => !heldKeys.has(c.key));
        } catch { common = []; }
    }
    return { held, common };
}

function nameOf(db: Database.Database, id: string): string {
    try {
        const row = db.prepare('SELECT name FROM characters WHERE id = ?').get(id) as { name?: string } | undefined;
        return row?.name ?? id;
    } catch { return id; }
}

export function buildKnowledgeSlice(characterId: string, db: Database.Database | undefined | null): string | null {
    if (!db) return null;
    const { held, common } = knowledgeFor(db, characterId);
    if (!held.length && !common.length) return null;
    const lines: string[] = [];
    for (const h of held) {
        const road = `${h.how}${h.from_id ? ` by ${nameOf(db, h.from_id)}` : ''}${h.note ? `, ${h.note}` : ''}${h.day !== null && h.day !== undefined ? `, day ${h.day}` : ''}`;
        lines.push(`- ${h.secrecy === 'common' ? '' : `[${h.secrecy.toUpperCase()}] `}${h.statement} (${road})`);
    }
    for (const c of common) lines.push(`- ${c.statement} (common knowledge)`);
    return `${HEADER}\n${lines.join('\n')}\n${KNOWLEDGE_CLOSING}`;
}
