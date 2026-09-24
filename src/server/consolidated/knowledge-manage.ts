/**
 * KNOWLEDGE_MANAGE — who knows what, and how they came to know it.
 *
 * Before a character states a fact, the table asks what that character's
 * road to knowing it is. Each fact records its knowers and each knower's
 * road: witnessed it, was told (by whom), holds it by position, deduced it,
 * read it, or heard it as rumour. Telling needs a teller who knows. A fact
 * can carry an effect on whoever knows it (Oszaverek holding Ithraes strips
 * the collar's disadvantage from his powers), applied when they learn it and
 * removed if they forget it.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { SessionContext } from '../types.js';
import { CustomEffectsRepository } from '../../storage/repos/custom-effects.repo.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { EffectMechanicSchema } from '../../schema/improvisation.js';

const ACTIONS = ['record', 'learn', 'who_knows', 'what_knows', 'can_know', 'forget', 'list'] as const;
const ROADS = ['witnessed', 'told', 'position', 'deduced', 'read', 'rumour'] as const;

const EffectOnKnowerSchema = z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    mechanics: z.array(EffectMechanicSchema).default([])
});

const KnowledgeInputSchema = z.object({
    action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
    worldId: z.string().describe('REQUIRED: knowledge is world-scoped'),
    key: z.string().optional().describe("A short handle for the fact ('ithraes-true-name', 'oszaverek-quarter')"),
    statement: z.string().optional().describe("record: the fact ('Ithraes is Oszaverek\\'s true name')"),
    secrecy: z.enum(['secret', 'restricted', 'common']).optional().describe('record: how guarded the fact is (default secret)'),
    effectOnKnower: EffectOnKnowerSchema.optional().describe('record: an effect every knower gains while they know it (applied on learn, removed on forget)'),
    knowerId: z.string().optional().describe('learn / what_knows / can_know / forget: the character or NPC id'),
    knowerName: z.string().optional().describe('learn: display name when the knower has no character row'),
    how: z.enum(ROADS).optional().describe('learn: witnessed | told | position | deduced | read | rumour'),
    fromId: z.string().optional().describe('learn how=told: who told them (must know it already)'),
    note: z.string().optional().describe('learn: how exactly ("overheard in the Oszaverek quarter")'),
    day: z.number().optional().describe('learn: in-fiction day'),
    knowers: z.array(z.object({
        id: z.string(), name: z.string().optional(), how: z.enum(ROADS), fromId: z.string().optional(), note: z.string().optional(), day: z.number().optional()
    })).optional().describe('record: who knows it from the start'),
    sessionId: z.string().optional()
});

type Input = z.infer<typeof KnowledgeInputSchema>;
type FactRow = { id: string; world_id: string; key: string; statement: string; secrecy: string; effect: string | null; created_at: string };
type HolderRow = { fact_id: string; knower_id: string; knower_name: string | null; how: string; from_id: string | null; note: string | null; day: number | null; created_at: string };

function kdb() {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_facts (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL, key TEXT NOT NULL,
        statement TEXT NOT NULL, secrecy TEXT NOT NULL DEFAULT 'secret',
        effect TEXT, created_at TEXT NOT NULL, UNIQUE(world_id, key));
    CREATE TABLE IF NOT EXISTS knowledge_holders (
        fact_id TEXT NOT NULL, knower_id TEXT NOT NULL, knower_name TEXT,
        how TEXT NOT NULL, from_id TEXT, note TEXT, day REAL, created_at TEXT NOT NULL,
        PRIMARY KEY (fact_id, knower_id));`);
    return db;
}

function nameOf(id: string): string {
    try { return new CharacterRepository(getDb()).findById(id)?.name ?? id; } catch { return id; }
}

function road(h: HolderRow): string {
    return `${h.knower_name ?? nameOf(h.knower_id)}: ${h.how}${h.from_id ? ` by ${nameOf(h.from_id)}` : ''}${h.note ? ` (${h.note})` : ''}${h.day !== null ? `, day ${h.day}` : ''}`;
}

/** Apply or remove a fact's effect on one knower (characters and NPCs with rows only). */
function syncEffect(fact: FactRow, knowerId: string, op: 'apply' | 'remove'): string | undefined {
    if (!fact.effect) return undefined;
    const char = new CharacterRepository(getDb()).findById(knowerId);
    if (!char) return undefined;
    const effect = JSON.parse(fact.effect) as z.infer<typeof EffectOnKnowerSchema>;
    const repo = new CustomEffectsRepository(getDb());
    const targetType = (char as { characterType?: string }).characterType === 'pc' ? 'character' : 'npc';
    if (op === 'remove') { repo.removeByName(char.id, targetType, effect.name); return `removed ${effect.name}`; }
    repo.apply({
        target_id: char.id, target_type: targetType, name: effect.name, description: effect.description,
        source: { type: 'unknown', entity_id: `knowledge:${fact.key}`, entity_name: `knows ${fact.key}` },
        category: 'neutral', power_level: 1, mechanics: effect.mechanics,
        duration: { type: 'until_removed' }, triggers: [], removal_conditions: [], stackable: false, max_stacks: 1
    } as never);
    return `applied ${effect.name}`;
}

async function route(args: unknown): Promise<Record<string, unknown>> {
    const input: Input = KnowledgeInputSchema.parse(args);
    const db = kdb();
    const now = new Date().toISOString();
    const fact = (key?: string) => key ? db.prepare('SELECT * FROM knowledge_facts WHERE world_id = ? AND key = ?').get(input.worldId, key) as FactRow | undefined : undefined;
    const holders = (f: FactRow) => db.prepare('SELECT * FROM knowledge_holders WHERE fact_id = ? ORDER BY created_at').all(f.id) as HolderRow[];
    const holderOf = (f: FactRow, id: string) => db.prepare('SELECT * FROM knowledge_holders WHERE fact_id = ? AND knower_id = ?').get(f.id, id) as HolderRow | undefined;

    const addHolder = (f: FactRow, k: { id: string; name?: string; how: string; fromId?: string; note?: string; day?: number }): string | undefined => {
        if (k.how === 'told') {
            if (!k.fromId) throw new Error(`told needs fromId: who told ${k.name ?? nameOf(k.id)}?`);
            if (!holderOf(f, k.fromId)) throw new Error(`${nameOf(k.fromId)} does not know '${f.key}', so could not have told ${k.name ?? nameOf(k.id)}. Nothing was written.`);
        }
        db.prepare(`INSERT INTO knowledge_holders (fact_id, knower_id, knower_name, how, from_id, note, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(fact_id, knower_id) DO UPDATE SET how = excluded.how, from_id = excluded.from_id, note = excluded.note, day = excluded.day`)
            .run(f.id, k.id, k.name ?? null, k.how, k.fromId ?? null, k.note ?? null, k.day ?? null, now);
        return syncEffect(f, k.id, 'apply');
    };

    switch (input.action) {
        case 'record': case 'add': {
            if (!input.key || !input.statement) return { error: true, message: 'record needs key and statement' };
            if (fact(input.key)) return { error: true, message: `'${input.key}' already exists in this world; use learn to add knowers` };
            db.prepare('INSERT INTO knowledge_facts (id, world_id, key, statement, secrecy, effect, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(`fact-${randomUUID().slice(0, 8)}`, input.worldId, input.key, input.statement, input.secrecy ?? 'secret', input.effectOnKnower ? JSON.stringify(input.effectOnKnower) : null, now);
            const f = fact(input.key)!;
            const effects = (input.knowers ?? []).map(k => addHolder(f, k)).filter(Boolean);
            return { success: true, actionType: 'record', key: f.key, statement: f.statement, secrecy: f.secrecy, knowers: holders(f).map(road), effects, message: `Recorded '${f.key}' with ${holders(f).length} knower(s)` };
        }
        case 'learn': case 'tell': {
            const f = fact(input.key);
            if (!f) return { error: true, message: `No fact '${input.key}' in this world` };
            if (!input.knowerId || !input.how) return { error: true, message: 'learn needs knowerId and how (witnessed | told | position | deduced | read | rumour)' };
            const effect = addHolder(f, { id: input.knowerId, name: input.knowerName, how: input.how, fromId: input.fromId, note: input.note, day: input.day });
            const h = holderOf(f, input.knowerId)!;
            return { success: true, actionType: 'learn', key: f.key, knower: input.knowerId, road: road(h), effect, message: `${road(h)} now knows '${f.key}'` };
        }
        case 'who_knows': {
            const f = fact(input.key);
            if (!f) return { error: true, message: `No fact '${input.key}' in this world` };
            const hs = holders(f);
            return { success: true, actionType: 'who_knows', key: f.key, statement: f.statement, secrecy: f.secrecy, count: hs.length, knowers: hs.map(h => ({ id: h.knower_id, road: road(h) })), message: `${hs.length} know '${f.key}'` };
        }
        case 'what_knows': case 'known_by': {
            if (!input.knowerId) return { error: true, message: 'what_knows needs knowerId' };
            const rows = db.prepare(`SELECT f.key, f.statement, f.secrecy, h.* FROM knowledge_holders h JOIN knowledge_facts f ON f.id = h.fact_id
                                     WHERE f.world_id = ? AND h.knower_id = ? ORDER BY h.created_at`).all(input.worldId, input.knowerId) as Array<HolderRow & { key: string; statement: string; secrecy: string }>;
            return { success: true, actionType: 'what_knows', knower: input.knowerId, count: rows.length, facts: rows.map(r => ({ key: r.key, statement: r.statement, secrecy: r.secrecy, road: road(r) })), message: `${nameOf(input.knowerId)} knows ${rows.length} fact(s)` };
        }
        case 'can_know': case 'check': {
            const f = fact(input.key);
            if (!f) return { error: true, message: `No fact '${input.key}' in this world` };
            if (!input.knowerId) return { error: true, message: 'can_know needs knowerId' };
            const h = holderOf(f, input.knowerId);
            const common = f.secrecy === 'common';
            return {
                success: true, actionType: 'can_know', key: f.key, knower: input.knowerId, knows: !!h || common,
                road: h ? road(h) : common ? 'common knowledge' : null,
                message: h ? `Yes: ${road(h)}` : common ? 'Yes: common knowledge' : `No: ${nameOf(input.knowerId)} has no road to '${f.key}'. They cannot state it.`
            };
        }
        case 'forget': {
            const f = fact(input.key);
            if (!f || !input.knowerId) return { error: true, message: 'forget needs an existing key and knowerId' };
            const gone = db.prepare('DELETE FROM knowledge_holders WHERE fact_id = ? AND knower_id = ?').run(f.id, input.knowerId).changes;
            if (!gone) return { error: true, message: `${nameOf(input.knowerId)} does not know '${f.key}'` };
            const effect = syncEffect(f, input.knowerId, 'remove');
            return { success: true, actionType: 'forget', key: f.key, knower: input.knowerId, effect, message: `${nameOf(input.knowerId)} no longer knows '${f.key}'` };
        }
        case 'list': {
            const facts = db.prepare('SELECT * FROM knowledge_facts WHERE world_id = ? ORDER BY created_at').all(input.worldId) as FactRow[];
            return { success: true, actionType: 'list', count: facts.length, facts: facts.map(f => ({ key: f.key, statement: f.statement, secrecy: f.secrecy, knowers: holders(f).length })), message: `${facts.length} fact(s)` };
        }
    }
    return { error: true, message: `Unknown action '${input.action}': ${ACTIONS.join(', ')}` };
}

export async function handleKnowledgeManage(args: unknown, _ctx: SessionContext): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        const result = await route(args);
        let output = result.error ? RichFormatter.error(String(result.message)) : RichFormatter.header(`Knowledge: ${String(result.actionType)}`, '🕯️') + (result.message ? RichFormatter.alert(String(result.message), 'info') : '');
        output += RichFormatter.embedJson(result, 'KNOWLEDGE_MANAGE');
        return { content: [{ type: 'text', text: output }] };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: RichFormatter.error(msg) + RichFormatter.embedJson({ error: true, message: msg, writes: 'none' }, 'KNOWLEDGE_MANAGE') }] };
    }
}

export const KnowledgeManageTool = {
    name: 'knowledge_manage',
    description: `Who knows what, and how they came to know it. Ask can_know before any character states a fact.

Actions: record, learn, who_knows, what_knows, can_know, forget, list
- record {worldId, key, statement, secrecy?, effectOnKnower?, knowers?}: a fact and who knows it from the start.
- learn {worldId, key, knowerId, how: witnessed | told | position | deduced | read | rumour, fromId?, note?, day?}: told needs a teller who already knows (refused otherwise).
- can_know {worldId, key, knowerId}: yes with the road, or "no road: they cannot state it".
- who_knows {key} / what_knows {knowerId}: the spread of a secret, or one character's journal of what they know.
- effectOnKnower {name, description, mechanics}: applied to each knower on learn (mechanics with autoApply feed rolls), removed on forget.
worldId REQUIRED on every call.`,
    inputSchema: KnowledgeInputSchema,
    actionSchemas: Object.fromEntries(ACTIONS.map(a => [a, { schema: KnowledgeInputSchema, aliases: [] as string[] }]))
};
