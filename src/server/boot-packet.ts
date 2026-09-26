/**
 * The session boot packet: everything the GM reads before play, in one call.
 * What's new in the engine, the table rules, a digest of each player
 * character (HP, core pool, hurt parts, lasting conditions, features with
 * the engine-applied ones marked and the rest as reminders), clocks coming
 * due, open threads, live telegraphs, the last journal entries and the
 * latest precedents. Every section degrades to absent when its table is
 * missing; a packet never fails because one source is empty.
 */
import { getDb } from '../storage/index.js';
import { CustomEffectsRepository } from '../storage/repos/custom-effects.repo.js';
import { CharacterRepository } from '../storage/repos/character.repo.js';
import { loadRule, findPool, conditionsForDisplay } from '../engine/table-rules.js';
import { recentPrecedents } from './consolidated/precedent-manage.js';
import { readWorldClock } from '../engine/world-clock.js';
import type { Character } from '../schema/character.js';

export interface BootPacket {
    worldId: string;
    day: number | null;
    /** 'HH:MM' when the world keeps a time. */
    time?: string;
    characters: Array<Record<string, unknown>>;
    clocks: Array<Record<string, unknown>>;
    threads: Array<{ id: string; text: string }>;
    telegraphs: Array<{ encounterId: string; name: string; intent?: string; readied?: string }>;
    journal: Array<{ type: string; text: string; at: string }>;
    precedents: Array<{ kind: string; statement: string; scope: string | null }>;
}

const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}…` : s;

function tryAll<T>(fn: () => T[]): T[] {
    try { return fn(); } catch { return []; }
}

function digest(char: Character, worldId: string): Record<string, unknown> {
    const db = getDb();
    const pools = (char.resourcePools ?? {}) as Record<string, { current: number; max: number }>;
    const core = findPool(pools, loadRule(db, worldId, 'status_block')?.spec.corePool);
    const effectsRepo = new CustomEffectsRepository(db);
    const effects = [...tryAll(() => effectsRepo.getEffectsOnTarget(char.id, 'character', { is_active: true })),
        ...tryAll(() => effectsRepo.getEffectsOnTarget(char.id, 'npc', { is_active: true }))];
    const conditions = (char.conditions ?? []) as Array<{ name: string; pinned?: boolean }>;
    return {
        id: char.id,
        name: char.name,
        hp: `${char.hp}/${char.maxHp}`,
        ...(char.band ? { band: char.band } : {}),
        ...(core ? { [core.key]: `${core.pool.current}/${core.pool.max}` } : {}),
        ...(char.parts?.some(p => p.state !== 'intact') ? { parts: char.parts.filter(p => p.state !== 'intact').map(p => `${p.name}: ${p.state}`) } : {}),
        conditions: { count: conditions.length, first: conditionsForDisplay(conditions, 5).map(c => clip(c.name, 100)) },
        features: effects.map(e => {
            const auto = e.mechanics.some(m => (m as { autoApply?: boolean }).autoApply);
            const when = e.triggers.filter(t => t.event !== 'always_active').map(t => `${t.event}${t.condition ? ` (${t.condition})` : ''}`);
            return {
                name: e.name,
                engine: auto ? 'applied by the engine' : 'reminder',
                ...(when.length ? { when } : {}),
                ...(e.cost ? { cost: e.cost } : {}),
                ...(!auto && e.description ? { text: clip(e.description, 160) } : {})
            };
        })
    };
}

export function buildBootPacket(worldId: string, characterIds?: string[], journalLimit = 5): BootPacket {
    const db = getDb();
    const charRepo = new CharacterRepository(db);

    // Item 14: the shared clock reader (legacy currentDay rows included).
    // Scheduled rows compare against the fractional clock, debts the day.
    const clock = readWorldClock(db, worldId);
    const day: number | null = clock?.day ?? null;
    const at: number | null = clock?.at ?? null;

    const ids = characterIds?.length ? characterIds : tryAll(() =>
        (db.prepare("SELECT id FROM characters WHERE world_id = ? AND character_type = 'pc'").all(worldId) as Array<{ id: string }>).map(r => r.id));
    const characters = ids.map(id => charRepo.findById(id)).filter((c): c is Character => !!c).map(c => digest(c, worldId));

    const clocks: Array<Record<string, unknown>> = [
        ...tryAll(() => (db.prepare(`SELECT s.fires_at_day AS day, s.note, c.name AS who FROM scheduled_state_changes s JOIN characters c ON c.id = s.character_id
                                     WHERE s.fired = 0 AND c.world_id = ? ORDER BY s.fires_at_day LIMIT 8`).all(worldId) as Array<{ day: number; note: string | null; who: string }>)
            .map(r => ({ kind: 'scheduled', day: r.day, due: at !== null && r.day <= at, what: `${r.who}: ${r.note ?? '(no note)'}` }))),
        ...tryAll(() => (db.prepare(`SELECT debtor, creditor, amount, currency, due_day, status, consequence FROM ledger_debts
                                     WHERE world_id = ? AND status IN ('pending', 'due', 'lapsed') ORDER BY COALESCE(due_day, 1e9) LIMIT 8`).all(worldId) as Array<Record<string, unknown>>)
            .map(r => ({ kind: 'debt', day: r.due_day, status: r.status, due: day !== null && typeof r.due_day === 'number' && r.due_day <= day, what: `${r.debtor} owes ${r.creditor} ${r.currency}${r.amount}${r.consequence ? `; if not: ${r.consequence}` : ''}` })))
    ];

    const threads = tryAll(() => (db.prepare(`SELECT id, content FROM narrative_notes WHERE world_id = ? AND type = 'plot_thread' AND status = 'active'
                                             ORDER BY updated_at DESC LIMIT 8`).all(worldId) as Array<{ id: string; content: string }>)
        .map(r => ({ id: r.id, text: clip(r.content, 160) })));

    const telegraphs = tryAll(() => (db.prepare("SELECT id, tokens FROM encounters WHERE status = 'active' AND world_id = ?").all(worldId) as Array<{ id: string; tokens: string }>)
        .flatMap(e => (JSON.parse(e.tokens) as Array<{ name: string; intent?: string; readied?: { action: string; trigger: string } }>)
            .filter(t => t.intent || t.readied)
            .map(t => ({ encounterId: e.id, name: t.name, ...(t.intent ? { intent: t.intent } : {}), ...(t.readied ? { readied: `${t.readied.action} when ${t.readied.trigger}` } : {}) }))));

    const journal = tryAll(() => (db.prepare(`SELECT type, content, created_at FROM narrative_notes WHERE world_id = ? AND type IN ('session_log', 'canonical_moment')
                                             ORDER BY created_at DESC LIMIT ?`).all(worldId, journalLimit) as Array<{ type: string; content: string; created_at: string }>)
        .map(r => ({ type: r.type, text: clip(r.content, 240), at: r.created_at })));

    const precedents = recentPrecedents(worldId, 5).map(p => ({ kind: p.kind, statement: p.statement, scope: p.scope }));

    return { worldId, day, ...(clock?.time ? { time: clock.time } : {}), characters, clocks, threads, telegraphs, journal, precedents };
}

export function renderBootPacket(p: BootPacket): string {
    let out = '';
    const section = (title: string) => `\n## ${title}\n`;
    if (p.characters.length) {
        out += section('Characters');
        for (const c of p.characters) {
            const pool = Object.entries(c).find(([k]) => !['id', 'name', 'hp', 'band', 'parts', 'conditions', 'features'].includes(k));
            out += `• ${c.name}: HP ${c.hp}${c.band ? ` · ${c.band}` : ''}${pool ? ` · ${pool[0].toUpperCase()} ${pool[1]}` : ''}\n`;
            if (Array.isArray(c.parts)) out += `  parts: ${(c.parts as string[]).join(' · ')}\n`;
            const conds = c.conditions as { count: number; first: string[] };
            if (conds.count) out += `  conditions (${conds.count}): ${conds.first.join(' | ')}${conds.count > conds.first.length ? ' | …' : ''}\n`;
            for (const f of c.features as Array<Record<string, unknown>>) {
                out += `  ${f.engine === 'reminder' ? '◇' : '◆'} ${f.name}${f.when ? ` [${(f.when as string[]).join(', ')}]` : ''}${f.cost ? ` cost: ${f.cost}` : ''}${f.text ? `: ${f.text}` : ''}\n`;
            }
        }
    }
    if (p.clocks.length) {
        out += section(`Clocks${p.day !== null ? ` (day ${p.day}${p.time ? `, ${p.time}` : ''})` : ''}`);
        for (const c of p.clocks) out += `• ${c.due || c.status === 'due' || c.status === 'lapsed' ? 'DUE ' : ''}${c.kind === 'debt' ? `[${c.status}] ` : ''}${c.day !== null && c.day !== undefined ? `day ${c.day}: ` : ''}${c.what}\n`;
    }
    if (p.telegraphs.length) {
        out += section('Live telegraphs');
        for (const t of p.telegraphs) out += `• ${t.name}${t.intent ? ` ⚑ ${t.intent}` : ''}${t.readied ? ` ⏳ ${t.readied}` : ''}\n`;
    }
    if (p.threads.length) { out += section('Open threads'); for (const t of p.threads) out += `• ${t.text}\n`; }
    if (p.journal.length) { out += section('Last journal entries'); for (const j of p.journal) out += `• [${j.type}] ${j.text}\n`; }
    if (p.precedents.length) { out += section('Recent precedents'); for (const r of p.precedents) out += `• [${r.kind}${r.scope ? ` · ${r.scope}` : ''}] ${r.statement}\n`; }
    return out || '\n(nothing recorded for this world yet)\n';
}
