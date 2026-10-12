/**
 * One-time data upgrades. Schema migrations add tables and columns; these
 * rewrite old rows into new shapes (a mid-campaign overhaul upgrades what is
 * already there instead of leaving it half-compatible). Each runs once per
 * database and is recorded in data_migrations.
 */
import type Database from 'better-sqlite3';
import { computedSkillModifier, OVERRIDE_SKILLS } from '../engine/skill-modifier.js';
import { worldProgression } from '../engine/progression.js';
import { DAY_366_PRESET } from '../data/table-rules/day-366.js';

export const DAY_366_PRINCIPLE_TEXT_MIGRATION_ID = '2026-10-11-day-366-principle-text';

/**
 * The day-366 principle texts as the preset shipped them before play report 2
 * (item 11): a table character's name and setting vocabulary in a shared,
 * importable preset. The migration rewrites a stored text ONLY when it still
 * equals one of these byte for byte; a GM's edit is never touched.
 */
export const DAY_366_OLD_PRINCIPLE_TEXTS: Record<string, string> = {
    'character-fantasy': 'Luciel is an Astartes-scale warlord who dominates ordinary mortals physically. Peer transhumans are serious fights capable of maiming him. Chaos offers genuine shortcuts to power that become increasingly difficult to refuse. If a mechanic repeatedly contradicts these, change the mechanic.',
    'mortal-units': 'Mortal units: one initiative, one move, one action; fixed volley tiers (healthy Scions 3d6-4d6; reduced by casualties, suppression, melee, broken formation); size affects staying power, area, lanes, splitting, suppression, objectives, not dice.',
    'npcs-are-characters': 'NPCs are characters, not consultants; no conscience chorus; no italic thoughts grading Luciel.'
};

export interface DataMigration {
    id: string;
    description: string;
    run(db: Database.Database): string;
}

const CRIPPLE = /^crippled:(leg|arm|wing|head)$/i;

export const SKILL_OVERRIDE_MIGRATION_ID = '2026-10-11-skill-overrides';

/** The ledger of every stealth/perception column the migration moved; reconcile reads it until acknowledged. */
export function ensureSkillOverrideMigrationsTable(db: Database.Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS skill_override_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL,
        character_name TEXT,
        world_id TEXT,
        skill TEXT NOT NULL,
        before INTEGER,
        after INTEGER,
        computed INTEGER,
        kind TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_override_migrations_char ON skill_override_migrations(character_id, acknowledged);`);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Explicit override writes in the journal: calls that succeeded (audit_logs
 * details.success === true) whose args carry stealthOverride/perceptionOverride
 * or the older stealthBonus/perceptionBonus names, plus write_audit rows for
 * those fields. A refused call is logged too (success false) and is NOT
 * evidence. The audit wrapper sits at tool registration, so a write made
 * through a batch_manage execute_sequence step is journaled under
 * batch_manage with the override nested in steps[].args: every action's row
 * is read and its args walked. Keys are the ids as the journal has them: the
 * node's own characterId (possibly a #70 prefix) or, for a create, every uuid
 * and "ID: <id>" line in the reply text.
 */
const OVERRIDE_ARG_KEYS: Array<[string, 'stealth' | 'perception']> = [
    ['stealthOverride', 'stealth'], ['stealthBonus', 'stealth'], ['perceptionOverride', 'perception'], ['perceptionBonus', 'perception']
];

function explicitOverrideWrites(db: Database.Database): Array<{ key: string; skill: 'stealth' | 'perception' }> {
    const out: Array<{ key: string; skill: 'stealth' | 'perception' }> = [];
    const add = (key: unknown, skill: 'stealth' | 'perception') => { if (typeof key === 'string' && key.length >= 6) out.push({ key, skill }); };
    const idsInReply = (result: unknown): string[] => {
        const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
        const keys = new Set<string>();
        for (const m of text.match(UUID_RE) ?? []) keys.add(m.toLowerCase());
        // Test doubles and short ids: an "ID: <id>" line in the reply.
        for (const m of text.matchAll(/\bID\b\W*([A-Za-z0-9_-]{6,})/g)) keys.add(m[1]);
        return [...keys];
    };
    // Every object in the args tree (batch steps nest the real call) that names an override.
    const walk = (node: unknown, result: unknown, depth: number): void => {
        if (depth > 6 || node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const item of node) walk(item, result, depth + 1); return; }
        const obj = node as Record<string, unknown>;
        const skills = new Set<'stealth' | 'perception'>();
        for (const [k, skill] of OVERRIDE_ARG_KEYS) if (typeof obj[k] === 'number') skills.add(skill);
        if (skills.size) {
            const keys = typeof obj.characterId === 'string' ? [obj.characterId] : idsInReply(result);
            for (const k of keys) for (const s of skills) add(k, s);
        }
        for (const child of Object.values(obj)) if (child && typeof child === 'object') walk(child, result, depth + 1);
    };
    try {
        const rows = db.prepare(`SELECT details FROM audit_logs
            WHERE details LIKE '%Override%' OR details LIKE '%stealthBonus%' OR details LIKE '%perceptionBonus%'`).all() as Array<{ details: string | null }>;
        for (const r of rows) {
            let d: { args?: unknown; result?: unknown; success?: unknown };
            try { d = JSON.parse(r.details ?? ''); } catch { continue; }
            if (d?.success !== true || !d.args) continue;
            walk(d.args, d.result, 0);
        }
    } catch { /* no audit_logs on this db */ }
    try {
        const rows = db.prepare(`SELECT character_id, field FROM write_audit WHERE field IN ('stealthBonus', 'perceptionBonus', 'stealthOverride', 'perceptionOverride', 'stealth_bonus', 'perception_bonus')`).all() as Array<{ character_id: string; field: string }>;
        for (const r of rows) add(r.character_id, /stealth/i.test(r.field) ? 'stealth' : 'perception');
    } catch { /* no write_audit on this db */ }
    return out;
}

export const DATA_MIGRATIONS: DataMigration[] = [
    {
        id: '2026-09-24-crippled-conditions-to-parts',
        description: "Called strikes now cripple a named part: old 'crippled:<limb>' character conditions become crippled parts",
        run(db) {
            const cols = db.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>;
            if (!cols.some(c => c.name === 'parts')) return 'no parts column';
            const rows = db.prepare("SELECT id, conditions, parts FROM characters WHERE conditions LIKE '%crippled:%'").all() as Array<{ id: string; conditions: string | null; parts: string | null }>;
            const write = db.prepare('UPDATE characters SET conditions = ?, parts = ? WHERE id = ?');
            let moved = 0;
            for (const r of rows) {
                const conds = JSON.parse(r.conditions || '[]') as Array<{ name: string; source?: string }>;
                const parts = JSON.parse(r.parts || '[]') as Array<{ name: string; kind: string; state: string; note?: string }>;
                const keep = conds.filter(c => {
                    const m = String(c.name ?? '').match(CRIPPLE);
                    if (!m) return true;
                    const limb = m[1].toLowerCase();
                    if (!parts.some(p => p.name.toLowerCase() === limb)) parts.push({ name: limb, kind: limb, state: 'crippled', note: c.source ?? 'called strike (migrated)' });
                    moved++;
                    return false;
                });
                write.run(JSON.stringify(keep), JSON.stringify(parts), r.id);
            }
            return `${moved} condition(s) moved to parts`;
        }
    },
    {
        id: SKILL_OVERRIDE_MIGRATION_ID,
        description: 'Stealth/perception columns are tri-state overrides (play report 2 #5): a 0 nobody wrote becomes NULL (computed from the sheet); a non-zero value nobody wrote was a legacy additive bonus and becomes computed + value; an override the journal shows was written explicitly stays. Every move is a reconcile finding (skill_override_migrated) until acknowledged',
        run(db) {
            const cols = new Set((db.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>).map(c => c.name));
            if (!cols.has('stealth_bonus') || !cols.has('perception_bonus')) return 'no override columns';
            ensureSkillOverrideMigrationsTable(db);
            const hasWorld = cols.has('world_id');
            type Row = { id: string; name: string; world_id: string | null; stats: string | null; level: number | null; skill_proficiencies: string | null; expertise: string | null; stealth_bonus: number | null; perception_bonus: number | null };
            const rows = db.prepare(`SELECT id, name, ${hasWorld ? 'world_id' : 'NULL AS world_id'}, stats, level, skill_proficiencies, ${cols.has('expertise') ? 'expertise' : 'NULL AS expertise'}, stealth_bonus, perception_bonus FROM characters`).all() as Row[];
            const explicit = explicitOverrideWrites(db);
            const hasExplicit = (id: string, skill: 'stealth' | 'perception') =>
                explicit.some(e => e.skill === skill && (e.key === id || (e.key.length < id.length && id.startsWith(e.key))));
            const progressions = new Map<string, ReturnType<typeof worldProgression>>();
            const profFor = (worldId: string | null, level: number) => {
                const key = worldId ?? '';
                if (!progressions.has(key)) {
                    try { progressions.set(key, worldProgression(db, worldId)); } catch { progressions.set(key, worldProgression(db, null)); }
                }
                return progressions.get(key)!.profBonus(level);
            };
            const parse = <T>(raw: string | null, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
            const write = db.prepare('UPDATE characters SET stealth_bonus = CASE WHEN ? = \'stealth\' THEN ? ELSE stealth_bonus END, perception_bonus = CASE WHEN ? = \'perception\' THEN ? ELSE perception_bonus END WHERE id = ?');
            const record = db.prepare('INSERT INTO skill_override_migrations (character_id, character_name, world_id, skill, before, after, computed, kind, acknowledged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)');
            const now = new Date().toISOString();
            let nulled = 0, nulledListed = 0, folded = 0, kept = 0;
            for (const r of rows) {
                const sheet = { stats: parse<Record<string, number>>(r.stats, {}), level: r.level ?? 1, skillProficiencies: parse<string[]>(r.skill_proficiencies, []), expertise: parse<string[]>(r.expertise, []) };
                for (const skill of ['stealth', 'perception'] as const) {
                    const stored = skill === 'stealth' ? r.stealth_bonus : r.perception_bonus;
                    if (stored === null || stored === undefined) continue;
                    if (hasExplicit(r.id, skill)) { kept++; continue; }
                    const computed = computedSkillModifier(sheet, skill, OVERRIDE_SKILLS[skill].ability, profFor(r.world_id, sheet.level)).value;
                    if (stored === 0) {
                        write.run(skill, null, skill, null, r.id);
                        nulled++;
                        // Listed only where the roll changes: a computed 0 rolls the same as the old 0.
                        if (computed !== 0) { record.run(r.id, r.name, r.world_id, skill, 0, null, computed, 'default_to_null', now); nulledListed++; }
                    } else {
                        const after = computed + stored;
                        write.run(skill, after, skill, after, r.id);
                        record.run(r.id, r.name, r.world_id, skill, stored, after, computed, 'bonus_to_override', now);
                        folded++;
                    }
                }
            }
            return `${nulled} default 0 → null (${nulledListed} listed where the computed value differs), ${folded} legacy bonus → computed + bonus, ${kept} explicit override(s) kept; world_manage reconcile lists them as skill_override_migrated`;
        }
    },
    {
        id: DAY_366_PRINCIPLE_TEXT_MIGRATION_ID,
        description: "The day-366 preset's principle texts no longer name a table character or its setting's units: already-imported worlds get the generic text where theirs still equals the old preset text byte for byte (a GM's rewrite is untouched)",
        run(db) {
            let tableRules: Array<{ id: string; name: string; spec: string | null }>;
            try {
                tableRules = db.prepare("SELECT id, name, spec FROM table_rules WHERE kind = 'principle' AND name IN ('character-fantasy', 'mortal-units', 'npcs-are-characters')").all() as typeof tableRules;
            } catch { return 'no table_rules'; }
            const current = new Map(DAY_366_PRESET.filter(e => e.kind === 'principle').map(e => [e.name, String((e.spec as { text?: unknown }).text ?? '')]));
            const write = db.prepare('UPDATE table_rules SET spec = ?, updated_at = ? WHERE id = ?');
            const now = new Date().toISOString();
            const touched: string[] = [];
            for (const r of tableRules) {
                const oldText = DAY_366_OLD_PRINCIPLE_TEXTS[r.name];
                const newText = current.get(r.name);
                if (!oldText || !newText) continue;
                let spec: Record<string, unknown>;
                try { spec = JSON.parse(r.spec ?? '{}'); } catch { continue; }
                if (spec.text !== oldText) continue;
                write.run(JSON.stringify({ ...spec, text: newText }), now, r.id);
                touched.push(r.name);
            }
            return touched.length ? `${touched.length} principle text(s) generalised: ${touched.join(', ')}` : 'no old preset text found';
        }
    }
];

export function ensureMetaTables(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS data_migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL,
            detail TEXT
        );
        CREATE TABLE IF NOT EXISTS engine_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);
}

/** Run every data migration this database has not had yet, each in its own transaction. */
export function runDataMigrations(db: Database.Database): Array<{ id: string; detail: string }> {
    ensureMetaTables(db);
    const done = new Set((db.prepare('SELECT id FROM data_migrations').all() as Array<{ id: string }>).map(r => r.id));
    const applied: Array<{ id: string; detail: string }> = [];
    for (const m of DATA_MIGRATIONS) {
        if (done.has(m.id)) continue;
        db.transaction(() => {
            const detail = m.run(db);
            db.prepare('INSERT INTO data_migrations (id, applied_at, detail) VALUES (?, ?, ?)').run(m.id, new Date().toISOString(), detail);
            applied.push({ id: m.id, detail });
        })();
        console.error(`[Migration] Data: ${m.id}: ${applied[applied.length - 1]?.detail}`);
    }
    return applied;
}

export function getMeta(db: Database.Database, key: string): string | null {
    ensureMetaTables(db);
    return (db.prepare('SELECT value FROM engine_meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value ?? null;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
    ensureMetaTables(db);
    db.prepare('INSERT INTO engine_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
