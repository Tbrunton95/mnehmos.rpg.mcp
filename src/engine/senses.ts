/**
 * Senses and trait advantage (play report 5 #8c, the owner's spec).
 *
 * A conditional trait is data on the sheet, not a prose condition:
 *   skillAdvantage: [{ name: 'Keen Smell', skills: ['perception', 'survival'],
 *                      when: 'scent', passiveBonus: 5, note: '...' }]
 * A check tagged with a context that matches `when` gets advantage and the
 * log names it; an untagged check gets nothing and is told the tag. A sense
 * denial stated on the scene (scene-wide, or for one target) switches the
 * trait off with the reason quoted. A scene wind plus two token positions
 * says whether a scent source is upwind (carries), downwind (carried away)
 * or crosswind of a sniffer. Passives are 10 + the one skill number, plus
 * the trait's passiveBonus (5 by default, 5e's advantage-on-a-passive) for
 * the sense.
 *
 * Rolls are immutable: a denial set after a roll never touches that roll.
 */
import type Database from 'better-sqlite3';
import { skillModifier, normSkill, type SkillSheet } from './skill-modifier.js';

export interface SkillAdvantageTrait {
    name: string;
    skills: string[];
    when: string;
    passiveBonus?: number;
    note?: string;
}

export interface MatchedTrait { name: string; when: string; label: string; passiveBonus?: number }

/** 'Scent' == 'scent' == ' SCENT '. */
export const normTag = (t: string) => t.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

/**
 * The traits a tagged check fires (`applied`) and the ones it would have
 * fired with the right tag (`gated`), for the skill rolled.
 */
export function matchSkillAdvantage(traits: SkillAdvantageTrait[] | null | undefined, skill: string, context: string[] | null | undefined): { applied: MatchedTrait[]; gated: MatchedTrait[] } {
    const applied: MatchedTrait[] = [];
    const gated: MatchedTrait[] = [];
    if (!traits?.length) return { applied, gated };
    const want = normSkill(skill);
    const tags = new Set((context ?? []).map(normTag));
    for (const t of traits) {
        if (!t || typeof t.name !== 'string' || typeof t.when !== 'string' || !Array.isArray(t.skills)) continue;
        if (!t.skills.some(s => normSkill(String(s)) === want)) continue;
        const m: MatchedTrait = { name: t.name, when: t.when, label: `${t.name} (${t.when})`, ...(typeof t.passiveBonus === 'number' ? { passiveBonus: t.passiveBonus } : {}) };
        (tags.has(normTag(t.when)) ? applied : gated).push(m);
    }
    return { applied, gated };
}

// ─── Sense denial ───

export interface SenseDenialEntry {
    /** The one character it applies to; absent = the whole scene. */
    targetId?: string;
    /** sense tag → the stated reason. */
    senses: Record<string, string>;
}

/**
 * The two shapes the GM states: {scent: 'reason'} for the scene, or
 * {targetId, scent: 'reason'} for one target, or an array of either.
 */
export function normalizeSenseDenial(input: unknown): SenseDenialEntry[] {
    if (input === null || input === undefined) return [];
    const items = Array.isArray(input) ? input : [input];
    const out: SenseDenialEntry[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        // Already normalised ({targetId?, senses}) passes through.
        const rec = item as Record<string, unknown>;
        if (rec.senses && typeof rec.senses === 'object') {
            const senses = Object.fromEntries(Object.entries(rec.senses as Record<string, unknown>).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v as string]));
            if (Object.keys(senses).length) out.push({ ...(typeof rec.targetId === 'string' ? { targetId: rec.targetId } : {}), senses });
            continue;
        }
        const senses: Record<string, string> = {};
        for (const [k, v] of Object.entries(rec)) {
            if (k === 'targetId') continue;
            if (typeof v === 'string' && v.trim()) senses[k] = v;
        }
        if (!Object.keys(senses).length) continue;
        out.push({ ...(typeof rec.targetId === 'string' ? { targetId: rec.targetId } : {}), senses });
    }
    return out;
}

/** The stated reason a sense is denied for this character: a target entry first, then the scene's. */
export function denialFor(entries: SenseDenialEntry[] | null | undefined, characterId: string, tag: string): string | undefined {
    if (!entries?.length) return undefined;
    const want = normTag(tag);
    const find = (e: SenseDenialEntry) => Object.entries(e.senses).find(([k]) => normTag(k) === want)?.[1];
    for (const e of entries) if (e.targetId === characterId) { const r = find(e); if (r) return r; }
    for (const e of entries) if (!e.targetId) { const r = find(e); if (r) return r; }
    return undefined;
}

// ─── Wind ───

export interface Wind { from: string; travel: { x: number; y: number } }
export type WindRelation = 'upwind' | 'downwind' | 'crosswind';

/** Compass points as the direction the wind comes FROM; east is +x, north is -y (map rows grow downward). */
const COMPASS: Record<string, { x: number; y: number }> = {
    N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, E: { x: 1, y: 0 }, W: { x: -1, y: 0 },
    NE: { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, NW: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
    SE: { x: Math.SQRT1_2, y: Math.SQRT1_2 }, SW: { x: -Math.SQRT1_2, y: Math.SQRT1_2 }
};
const WORDS: Record<string, string> = { north: 'N', south: 'S', east: 'E', west: 'W', northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW' };

/**
 * 'from W', 'from the north-east', 'E', 'north wind' → the point the wind
 * comes from and the unit vector it travels along. Undefined when no point
 * can be read ('still', '').
 */
export function parseWind(text: string | null | undefined): Wind | undefined {
    if (!text) return undefined;
    const s = text.trim().toLowerCase().replace(/[-_]/g, '');
    const m = s.match(/\b(northeast|northwest|southeast|southwest|north|south|east|west|ne|nw|se|sw|n|s|e|w)\b/);
    if (!m) return undefined;
    const from = WORDS[m[1]] ?? m[1].toUpperCase();
    const origin = COMPASS[from];
    if (!origin) return undefined;
    // The wind travels away from where it comes from.
    const travel = { x: -origin.x === 0 ? 0 : -origin.x, y: -origin.y === 0 ? 0 : -origin.y };
    return { from, travel };
}

/**
 * Where a scent source stands relative to a sniffer in this wind: upwind
 * (the wind carries its scent to the sniffer), downwind (carried away),
 * crosswind (neither, within 60° of square-on) or the same square.
 */
export function windRelation(wind: Wind, sniffer: { x: number; y: number }, source: { x: number; y: number }): WindRelation {
    const dx = source.x - sniffer.x, dy = source.y - sniffer.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return 'crosswind';
    const cos = (dx * wind.travel.x + dy * wind.travel.y) / len;
    if (cos <= -0.5) return 'upwind';
    if (cos >= 0.5) return 'downwind';
    return 'crosswind';
}

/** The position of a character's token in the active encounters it is in (the first found), else undefined. */
export function tokenPosition(db: Database.Database, characterId: string): { x: number; y: number } | undefined {
    try {
        const rows = db.prepare("SELECT tokens FROM encounters WHERE status = 'active' AND tokens LIKE ?").all(`%"${characterId}"%`) as Array<{ tokens: string }>;
        for (const r of rows) {
            const tok = (JSON.parse(r.tokens) as Array<{ id: string; position?: { x: number; y: number } }>).find(t => t.id === characterId);
            if (tok?.position && typeof tok.position.x === 'number' && typeof tok.position.y === 'number') return { x: tok.position.x, y: tok.position.y };
        }
    } catch { /* no encounters table */ }
    return undefined;
}

// ─── Passives ───

export interface SensePassive { when: string; trait: string; value: number; label: string }

type PassiveSheet = SkillSheet & { skillAdvantage?: SkillAdvantageTrait[] | null };

/** 10 + the one Perception number (override or WIS + proficiency). */
export function passivePerception(sheet: PassiveSheet, profBonus: number): number {
    return 10 + skillModifier(sheet, 'perception', 'wis', profBonus).value;
}

/** One passive per Perception trait with a `when`: the plain passive plus the trait's passiveBonus (5 by default). */
export function sensePassives(sheet: PassiveSheet, profBonus: number): SensePassive[] {
    const base = passivePerception(sheet, profBonus);
    const out: SensePassive[] = [];
    for (const t of sheet.skillAdvantage ?? []) {
        if (!t || typeof t.when !== 'string' || !Array.isArray(t.skills) || !t.skills.some(s => normSkill(String(s)) === 'perception')) continue;
        const value = base + (typeof t.passiveBonus === 'number' ? t.passiveBonus : 5);
        out.push({ when: t.when, trait: t.name, value, label: `passive Perception (${t.when}) ${value}` });
    }
    return out;
}

// ─── The scene's denial and wind, read for a roll ───

export interface SceneSenses { senseDenial: SenseDenialEntry[]; wind?: string; sceneId?: string }

/**
 * The denial and wind in force for a character: the latest scene it takes
 * part in, else the world's latest scene. Read at roll time only, so a
 * later scene never touches an earlier roll.
 */
export function sceneSensesFor(db: Database.Database, characterId: string, worldId: string | null | undefined): SceneSenses {
    const empty: SceneSenses = { senseDenial: [] };
    if (!worldId) return empty;
    try {
        const cols = (db.prepare('PRAGMA table_info(scenes)').all() as Array<{ name: string }>).map(c => c.name);
        if (!cols.includes('sense_denial')) return empty;
        const own = db.prepare('SELECT id, sense_denial, wind FROM scenes WHERE world_id = ? AND participants LIKE ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(worldId, `%"${characterId}"%`) as { id: string; sense_denial: string | null; wind: string | null } | undefined;
        const row = own ?? db.prepare('SELECT id, sense_denial, wind FROM scenes WHERE world_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(worldId) as { id: string; sense_denial: string | null; wind: string | null } | undefined;
        if (!row) return empty;
        let senseDenial: SenseDenialEntry[] = [];
        if (row.sense_denial) { try { senseDenial = normalizeSenseDenial(JSON.parse(row.sense_denial)); } catch { senseDenial = []; } }
        return { senseDenial, ...(row.wind ? { wind: row.wind } : {}), sceneId: row.id };
    } catch { return empty; }
}

export interface WindCall { from: string; relation: WindRelation | 'unknown'; note: string }

/**
 * What the scene's wind says about a sniffer smelling a source: a denial
 * reason when the source is downwind, a note otherwise, 'unknown' when a
 * position is missing. Explicit denials override it (the caller checks
 * denialFor first).
 */
export function windCall(wind: Wind, sniffer: { id: string; name: string; position?: { x: number; y: number } }, source: { id: string; name: string; position?: { x: number; y: number } }): WindCall & { denied?: string } {
    if (!sniffer.position || !source.position) {
        return { from: wind.from, relation: 'unknown', note: `wind from ${wind.from}; no token positions for ${sniffer.name} and ${source.name}, so it decides nothing` };
    }
    const relation = windRelation(wind, sniffer.position, source.position);
    if (relation === 'downwind') {
        const note = `${source.name} is downwind of ${sniffer.name} (wind from ${wind.from}): the scent is carried away`;
        return { from: wind.from, relation, note, denied: note };
    }
    if (relation === 'upwind') return { from: wind.from, relation, note: `${source.name} is upwind of ${sniffer.name} (wind from ${wind.from}): the scent carries` };
    return { from: wind.from, relation, note: `${source.name} is crosswind of ${sniffer.name} (wind from ${wind.from}): the wind decides nothing` };
}
