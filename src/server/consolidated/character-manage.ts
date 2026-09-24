/**
 * Consolidated Character Management Tool
 *
 * Replaces 8 individual tools with a single action-based tool:
 * - create_character -> action: 'create'
 * - get_character -> action: 'get'
 * - update_character -> action: 'update'
 * - list_characters -> action: 'list'
 * - delete_character -> action: 'delete'
 * - add_xp -> action: 'add_xp'
 * - get_level_progression -> action: 'get_progression'
 * - level_up -> action: 'level_up'
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { SessionContext } from '../types.js';
import { getDb } from '../../storage/index.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { journalSnapshot } from '../utils/write-journal.js';
import * as pda from '../../render/pda.js';
import {
    CharacterOriginSchema,
    SkillProficiencySchema,
    SaveProficiencySchema,
} from '../../schema/character.js';
import { provisionStartingEquipment } from '../../services/starting-equipment.service.js';
import { CLASS_DATA, getSpellSlots, isSpellcaster } from '../../data/class-starting-data.js';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { CorpseRepository } from '../../storage/repos/corpse.repo.js';
import { ConcentrationRepository } from '../../storage/repos/concentration.repo.js';
import { RichFormatter } from '../utils/formatter.js';
import {
    CharacterOptionCategory,
    findOpen5eBackground,
    findOpen5eClass,
    findOpen5eSpecies,
    getOpen5eCatalogProvenance,
    getOpen5eCharacterOptions,
} from '../../content/open5e-catalog.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['create', 'get', 'update', 'list', 'delete', 'kill', 'add_xp', 'adjust_pool', 'get_progression', 'level_up', 'schedule_change', 'process_scheduled', 'list_scheduled', 'cancel_scheduled', 'scope_scheduled', 'scope_characters', 'get_status_block', 'options'] as const;
type CharacterAction = typeof ACTIONS[number];

const CharacterTypeSchema = z.enum(['pc', 'npc', 'enemy', 'neutral']);

const XP_TABLE: Record<number, number> = {
    1: 0, 2: 300, 3: 900, 4: 2700, 5: 6500, 6: 14000, 7: 23000, 8: 34000,
    9: 48000, 10: 64000, 11: 85000, 12: 100000, 13: 120000, 14: 140000,
    15: 165000, 16: 195000, 17: 225000, 18: 265000, 19: 305000, 20: 355000
};

const CLASS_SAVE_KEYS: Record<string, z.infer<typeof SaveProficiencySchema>> = {
    strength: 'str',
    dexterity: 'dex',
    constitution: 'con',
    intelligence: 'int',
    wisdom: 'wis',
    charisma: 'cha',
};

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb() {
    const db = getDb();
    return {
        db,
        characterRepo: new CharacterRepository(db)
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const StatsSchema = z.object({
    str: z.number().int().min(0).default(10),
    dex: z.number().int().min(0).default(10),
    con: z.number().int().min(0).default(10),
    int: z.number().int().min(0).default(10),
    wis: z.number().int().min(0).default(10),
    cha: z.number().int().min(0).default(10),
});

// FINDINGS #107: declared ABOVE CreateSchema — conditions-at-create references
// it, and a const used before declaration is a TDZ error, not a forward ref.
const conditionSchema = () => z.object({
    name: z.string(),
    duration: z.number().int().optional(),
    source: z.string().optional()
});

const CreateSchema = z.object({
    action: z.literal('create'),
    // FINDINGS #93: create-lane params — resourcePools was accepted by the
    // OUTER schema only; the create schema never had it, which is precisely
    // how the silent drop happened (tsc caught the fix reaching for it).
    resourcePools: z.record(z.object({
        current: z.number(),
        max: z.number(),
        lastRefilledAt: z.string().optional()
    })).optional().describe('Named numeric pools written AT CREATE (rads, composure, hunger…) — #93: honored now, was silently dropped'),
    conditions: z.array(conditionSchema()).optional().describe('FINDINGS #107: conditions written AT CREATE (wound clocks, THAW states…) — was the #93 anatomy repeated: outer schema accepted, create schema stripped, banner printed a clean card, and a GM could play six sessions off a condition that was never there'),
    worldId: z.string().optional().describe('FINDINGS #93: tag this character to a world — list {worldId} filters by it (nullable #91 pattern; untagged rows show everywhere)'),
    name: z.string().min(1).describe('Character name (required)'),
    class: z.string().optional().default('Adventurer'),
    race: z.string().optional().default('Human'),
    background: z.string().optional().default('Stalker'),
    alignment: z.string().optional(),
    stats: StatsSchema.optional().default({ str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }),
    hp: z.number().int().min(1).optional(),
    maxHp: z.number().int().min(1).optional(),
    ac: z.number().int().min(0).optional(),
    level: z.number().int().min(1).max(20).optional().default(1)
        .describe('Starting character level, from 1 through 20; determines class progression, features, and spell slots'),
    characterType: CharacterTypeSchema.optional().default('pc'),
    factionId: z.string().optional(),
    behavior: z.string().optional(),
    cantripsKnown: z.array(z.string()).optional().default([]),
    knownSpells: z.array(z.string()).optional().default([]),
    preparedSpells: z.array(z.string()).optional().default([]),
    resistances: z.array(z.string()).optional().default([]),
    vulnerabilities: z.array(z.string()).optional().default([]),
    immunities: z.array(z.string()).optional().default([]),
    armorProficiencies: z.array(z.string()).optional(),
    weaponProficiencies: z.array(z.string()).optional(),
    toolProficiencies: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    applySpeciesAbilityBonuses: z.boolean().optional().default(true)
        .describe('Apply source species ability bonuses exactly once; set false only when stats already include them'),
    origin: CharacterOriginSchema.optional(),
    provisionEquipment: z.boolean().optional().default(true),
    customEquipment: z.array(z.string()).optional(),
    startingGold: z.number().int().min(0).optional(),
    // FINDINGS #29 (mirror law, inner-side variant): these existed on update
    // but not create — passed at creation they were silently stripped and the
    // row wrote 0/empty under a success banner. Outer schema always carried
    // them; the strip was HERE.
    // FINDINGS #95 (R4a): old names retained so the guard can REFUSE loudly;
    // Override names are the live lane.
    perceptionBonus: z.number().int().optional(),
    stealthBonus: z.number().int().optional(),
    perceptionOverride: z.number().int().optional(),
    stealthOverride: z.number().int().optional(),
    skillProficiencies: z.array(z.string()).optional(),
    saveProficiencies: z.array(z.string()).optional(),
    expertise: z.array(z.string()).optional()
});

const GetSchema = z.object({
    action: z.literal('get'),
    characterId: z.string().describe('Character ID to retrieve')
});

const UpdateSchema = z.object({
    action: z.literal('update'),
    characterId: z.string().describe('Character ID to update'),
    // FINDINGS #88: destructive-write guard + preview (house pattern from #87)
    expectName: z.string().optional().describe('Guard: refuse unless the character\'s name matches (case-insensitive) — names who IS there on refusal'),
    preview: z.boolean().optional().describe('If true: return the would-be field changes and write NOTHING'),
    name: z.string().min(1).optional(),
    // FINDINGS #90: behavior/factionId existed on the OUTER schema and on
    // create, but not here — the startingGold anatomy: passed on update they
    // were silently stripped, and preview honestly reported 0 changes for a
    // write the caller believed in. Both lanes are real now.
    behavior: z.string().optional(),
    factionId: z.string().optional(),
    worldId: z.string().optional().describe('FINDINGS #94: claim this character to a world — the per-row path that makes list {worldId} strict filtering usable on legacy rows'),
    race: z.string().optional(),
    class: z.string().optional(),
    hp: z.number().int().min(0).optional(),
    maxHp: z.number().int().min(1).optional(),
    ac: z.number().int().min(0).optional(),
    level: z.number().int().min(1).max(20).optional()
        .describe('Character level, from 1 through 20'),
    xp: z.number().int().min(0).optional().describe('Findings #43: absolute XP set — the surgical correction verb the double-fire revert lacked. Audited like every xp write'),
    characterType: CharacterTypeSchema.optional(),
    stats: StatsSchema.partial().optional(),
    cantripsKnown: z.array(z.string()).optional(),
    knownSpells: z.array(z.string()).optional(),
    preparedSpells: z.array(z.string()).optional(),
    armorProficiencies: z.array(z.string()).optional(),
    weaponProficiencies: z.array(z.string()).optional(),
    toolProficiencies: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    conditions: z.array(conditionSchema()).optional(),
    addConditions: z.array(conditionSchema()).optional(),
    removeConditions: z.array(z.string()).optional(),
    background: z.string().optional(),
    alignment: z.string().optional(),
    origin: CharacterOriginSchema.optional(),
    skillProficiencies: z.array(z.string()).optional().describe('Skills the character is proficient in (validated against the skill enum on persist)'),
    perceptionBonus: z.number().int().optional().describe('RENAMED (#95): use perceptionOverride — this REFUSES loudly'),
    stealthBonus: z.number().int().optional().describe('RENAMED (#95): use stealthOverride — this REFUSES loudly'),
    perceptionOverride: z.number().int().optional().describe('OVERRIDES the composed WIS+prof perception column in the eavesdrop/listener layer — it does not add (#95 R4a)'),
    stealthOverride: z.number().int().optional().describe('OVERRIDES the composed DEX+prof stealth column in the eavesdrop/listener layer — it does not add (#95 R4a)'),
    saveProficiencies: z.array(z.string()).optional().describe('Saving throw proficiencies (str/dex/con/int/wis/cha)'),
    expertise: z.array(z.string()).optional().describe('Skills with double proficiency'),
    startingGold: z.number().int().min(0).optional().describe('Set currency to this exact RU amount (absolute set; for deltas use inventory_manage add_currency)'),
    resourcePools: z.record(z.object({
        current: z.number(),
        max: z.number(),
        lastRefilledAt: z.string().optional()
    })).optional().describe('Named numeric pools (rads, composure, psi...) — ONE incrementing row per pool via read-modify-write, replacing per-delta effect-ledger rows'),
    // FINDINGS #86: the composure re-spec — per-character charge/repair table.
    // DATA, NOT LOGIC: the engine stores and returns it so every chair charges
    // the same number; no resolver evaluates it (Register B stays Register B).
    composureSpec: z.record(z.unknown()).optional().describe('Per-character Composure spec: {desensitised:[categories that charge ZERO], charges:{category:amount}, repairs:{source:amount}}. Stored verbatim, returned by get. The engine never evaluates it — charges stay GM-declared on fiction')
});

const AdjustPoolSchema = z.object({
    action: z.literal('adjust_pool'),
    characterId: z.string(),
    pool: z.string().describe('Pool name (rads, composure, psi, heat, vodka_uses...) — created if absent'),
    delta: z.number().optional().default(0).describe('Amount to add (negative to subtract). Result clamps to 0..max. RETRY-UNSAFE by construction — prefer value for reconciliation'),
    // #67-F: retry ghost-writes (Tom's diagnosis) — deltas re-apply when a
    // retried generation re-executes tool calls from a discarded branch.
    // value is the retry-safe verb: absolute set, idempotent by nature.
    // Previously ACCEPTED AND DISCARDED by zod strip — the accept-then-
    // discard class, again.
    value: z.number().optional().describe('#67-F: ABSOLUTE set — pool becomes exactly this (clamped 0..max). Idempotent: safe under retry. Mutually exclusive with delta'),
    max: z.number().optional().describe('Sets/updates the pool maximum (default 100 on creation)'),
    removePool: z.boolean().optional().describe('FINDINGS #34 T2.6: delete the pool entirely — zero is not gone; this is gone'),
    reason: z.string().optional().describe('FINDINGS #111: why the pool moved — stored on the pool\'s own history (last 20 entries) when given'),
    witnesses: z.array(z.string()).optional().describe('FINDINGS #111: character ids who SAW it — the respect ledger\'s real content; stored on the pool history entry')
});

const ListSchema = z.object({
    action: z.literal('list'),
    characterType: CharacterTypeSchema.optional(),
    // FINDINGS #93: with three campaigns live, an unfiltered list returned
    // 145 rows and ate a context window. worldId matches tagged rows AND
    // legacy nulls (nulls show everywhere until claimed); limit caps output.
    worldId: z.string().optional().describe('Filter: rows tagged to this world OR untagged legacy rows'),
    limit: z.number().int().min(1).max(200).optional().describe('Cap the returned rows (names+ids beyond the cap are summarised)'),
    nativeToBastion: z.boolean().optional(),
    sourceUniverse: z.string().optional()
});

const DeleteSchema = z.object({
    action: z.literal('delete'),
    characterId: z.string().describe('Character ID to delete')
});

// ─── FINDINGS #60: THE MEND CLOCK ───
// Scheduled state changes the boot executes instead of numbers a chair
// remembers. fires_at_day is the IN-FICTION campaign day; wall-clock time is
// meaningless to the fiction (#58). writes is an ORDERED op list; every op
// clamps exactly as its live verb does and every applied write rides the
// write_audit through characterRepo.update — the audit outranks memory (#51).
const mendJsonIfString = (v: unknown) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; };

const ScheduledWriteOpSchema = z.object({
    op: z.enum(['adjust_pool', 'adjust_hp', 'adjust_max_hp', 'add_condition', 'remove_condition']),
    pool: z.string().optional().describe('Pool name (adjust_pool)'),
    delta: z.number().optional().describe('Delta (adjust_pool / adjust_hp / adjust_max_hp)'),
    max: z.number().optional().describe('Pool max update (adjust_pool)'),
    name: z.string().optional().describe('Condition name (add_condition / remove_condition)'),
    duration: z.number().optional().describe('Condition duration (add_condition)'),
    source: z.string().optional().describe('Condition source (add_condition; default "mend clock")')
});

const ScheduleChangeSchema = z.object({
    action: z.literal('schedule_change'),
    characterId: z.string().describe('Character the change fires on'),
    firesAtDay: z.number().optional().describe('IN-FICTION campaign day the change fires (fractional = time of day, e.g. 18.5). Composable with firesAtHour. OPTIONAL when firesInHours carries the arming — one of firesAtDay | firesInHours is required (#89)'),
    // FINDINGS #88: HOUR ERGONOMICS — fires_at_day was ALWAYS a REAL; nobody
    // should hand-compute 18/24. firesAtHour rides on firesAtDay; firesInHours
    // is relative to a base the caller names (currentDay [+ currentTime]).
    firesAtHour: z.number().min(0).max(24).optional().describe('Hour of the fires-at day (0–24) — stored as floor(firesAtDay) + hour/24. "Day 48 at 18:00" = firesAtDay:48, firesAtHour:18'),
    firesInHours: z.number().positive().optional().describe('Relative arming: fires N hours from the base — REQUIRES currentDay (+ optional currentTime). "back in six hours" = firesInHours:6, currentDay:47, currentTime:"14:01"'),
    currentDay: z.number().optional().describe('Base day for firesInHours (fractional ok)'),
    currentTime: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Base time HH:MM for firesInHours — combined with currentDay into a fractional base'),
    worldId: z.string().optional().describe('FINDINGS #91: scope this row to a world — process_scheduled {worldId} fires ONLY matching rows. Multi-world dbs pass it ALWAYS (KEEPER discipline §13); single-world saves may omit'),
    writes: z.preprocess(mendJsonIfString, z.array(ScheduledWriteOpSchema)).default([]).describe('Ordered ops applied when due. ARRAY param — batch law #16a: direct calls only. May be empty ONLY with event: true'),
    note: z.string().optional().describe('What this clock is ("suture out, L-forearm", "Akkuratnyy mend +1") — for events, the note IS the payload'),
    event: z.boolean().optional().describe('FINDINGS #82: GM EVENT — a clock that fires a NOTIFICATION instead of writes (NPC deliveries, deadlines, reminders). Fires through process_scheduled as 📣 GM EVENT DUE, surfaces as due at session boot. Combines with recurEveryDays for recurring reminders'),
    recurEveryDays: z.number().positive().optional().describe('FINDINGS #69: RECURRING clock — after firing, re-arms at +N days automatically. A hunger clock set once climbs forever; process_scheduled catches up every missed recurrence individually'),
    fireNow: z.boolean().optional().describe('FINDINGS #73: fire this entry IMMEDIATELY in the same call — the one-off lands in the LEDGER (row inserted, fired, applied[] reported) instead of a scattered manual pool poke. firesAtDay becomes the ledger day-stamp. Combines with recurEveryDays: the recurrence re-arms from the stamp')
});

const ProcessScheduledSchema = z.object({
    action: z.literal('process_scheduled'),
    currentDay: z.number().describe('Current IN-FICTION campaign day — all unfired rows with fires_at_day <= this apply and report'),
    currentTime: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('FINDINGS #88: current time HH:MM — combined into a fractional day so hour-clocks fire mid-day (currentDay:47 + "14:01" processes through 47.584)'),
    worldId: z.string().describe("FINDINGS #100: REQUIRED, filtered at the query. An optional filter on a destructive global write is the same bug with better manners — the SALT incident fired 35 cross-campaign events from one call. Unscoped legacy rows are counted and skipped with a warning; claim them via scope_scheduled"),
    characterId: z.string().optional().describe("FINDINGS #100: narrow further to one character's clocks. Honored at the query — before this fix the param was accepted and silently stripped"),
    preview: z.boolean().optional().describe('FINDINGS #100: dry-run — report what would fire, write NOTHING, re-arm nothing. Recurring chains may fire additional times in a live run that preview lists once')
});

const ListScheduledSchema = z.object({
    action: z.literal('list_scheduled'),
    characterId: z.string().optional().describe('Filter to one character'),
    worldId: z.string().optional().describe('FINDINGS #91: filter to one world (unscoped rows still show, world_id null)'),
    includeFired: z.boolean().optional().describe('Include already-fired rows (default false)')
});

const CancelScheduledSchema = z.object({
    action: z.literal('cancel_scheduled'),
    scheduleId: z.number().describe('Row id from schedule_change / list_scheduled — a wound that got surgical care heals on a different clock')
});

const GetStatusBlockSchema = z.object({
    action: z.literal('get_status_block'),
    characterId: z.string().describe('Character ID'),
    sessionId: z.string().optional()
});

// FINDINGS #64: the 00-schema status block, every value from a read this
// call. NAMED pool reads only — psi is never read into this payload, so
// the renderer cannot leak it even by a future caller's mistake.
async function handleGetStatusBlock(args: z.infer<typeof GetStatusBlockSchema>): Promise<object> {
    const { characterRepo } = ensureDb();
    const char = characterRepo.findById(args.characterId) as unknown as { name?: string; hp?: number; maxHp?: number; resourcePools?: Record<string, { current: number; max: number }>; currency?: { gold?: number } | string; conditions?: Array<{ name?: string; duration?: number }> } | undefined;
    if (!char) throw new Error(`Character ${args.characterId} not found`);
    const db = getDb();

    const pools = char.resourcePools || {};
    const rads = pools['rads']?.current;
    const composure = pools['composure']?.current;
    const composureMax = pools['composure']?.max;

    let weaponName: string | undefined; let weaponCondition: number | undefined;
    let weaponAttachments: Array<{ slot: string; name: string }> | undefined;
    try {
        const w = db.prepare(`SELECT i.id, i.name FROM inventory_items inv JOIN items i ON i.id = inv.item_id WHERE inv.character_id = ? AND inv.equipped = 1 AND inv.slot = 'mainhand'`).get(args.characterId) as { id: string; name: string } | undefined;
        if (w) {
            weaponName = w.name;
            const inst = db.prepare(`SELECT condition, attachments, custom_name FROM item_instances WHERE owner_character_id = ? AND template_id = ?`).get(args.characterId, w.id) as { condition?: number; attachments?: string; custom_name?: string } | undefined;
            if (inst) {
                if (typeof inst.condition === 'number') weaponCondition = inst.condition;
                if (inst.custom_name) weaponName = inst.custom_name;
                // #65-V2 (Tom's ask): mounted attachments on the glass — the
                // column was already in the row the condition read touches.
                const att = JSON.parse(inst.attachments || '{}') as Record<string, string>;
                const resolved: Array<{ slot: string; name: string }> = [];
                for (const [slot, attId] of Object.entries(att)) {
                    const it = db.prepare(`SELECT name FROM items WHERE id = ?`).get(attId) as { name?: string } | undefined;
                    resolved.push({ slot, name: it?.name ?? attId });
                }
                if (resolved.length) weaponAttachments = resolved;
            }
        }
    } catch { /* weapon line degrades to absent, never wrong */ }

    let effects: string[] = [];
    try {
        effects = (db.prepare(`SELECT name FROM custom_effects WHERE target_id = ? AND is_active = 1`).all(args.characterId) as Array<{ name: string }>).map(r => r.name);
    } catch { /* effects line degrades to absent */ }

    // World clock — the #62 honesty rule: day/time render ONLY when exactly
    // one world row exists; a scratch world never puts a wrong clock on the glass.
    let day: number | undefined; let time: string | undefined; let weather: string | undefined;
    try {
        const count = (db.prepare(`SELECT COUNT(*) AS c FROM worlds`).get() as { c: number }).c;
        if (count === 1) {
            const env = JSON.parse(((db.prepare(`SELECT environment FROM worlds`).get() as { environment?: string })?.environment) || '{}');
            day = env.day; time = env.time; weather = env.weather;
        }
    } catch { /* clock degrades to absent */ }

    // #65-V: the repo's currency mapping drops the column — read it raw.
    let gold: number | undefined;
    try {
        const cur = db.prepare(`SELECT currency FROM characters WHERE id = ?`).get(args.characterId) as { currency?: string } | undefined;
        gold = JSON.parse(cur?.currency || '{}').gold;
    } catch { /* RU line degrades to absent */ }

    return {
        success: true,
        actionType: 'get_status_block',
        characterId: args.characterId,
        characterName: char.name,
        hp: char.hp,
        maxHp: char.maxHp,
        rads, composure, composureMax,
        weaponName, weaponCondition, weaponAttachments,
        conditions: char.conditions || [],
        effects,
        gold,
        day, time, weather,
        message: `${char.name}: HP ${char.hp}/${char.maxHp}`
    };
}

const AddXpSchema = z.object({
    action: z.literal('add_xp'),
    characterId: z.string().describe('Character ID'),
    amount: z.number().int().describe('XP delta. Findings #43: negatives allowed for corrections (double-fire reverts), result clamps at 0 — XP is no longer a ratchet')
});

const GetProgressionSchema = z.object({
    action: z.literal('get_progression'),
    level: z.number().int().min(1).max(20).optional().describe('Level to check progression for (table lookup mode)'),
    characterId: z.string().optional().describe('Findings #35: character mode — reads the row and reports current XP vs thresholds')
});

const LevelUpSchema = z.object({
    action: z.literal('level_up'),
    characterId: z.string().describe('Character ID'),
    hpIncrease: z.number().int().min(0).optional(),
    targetLevel: z.number().int().min(2).max(20).optional()
});

const OptionCategorySchema = z.enum(['all', 'classes', 'species', 'backgrounds', 'skills', 'languages', 'alignments']);

const OptionsSchema = z.object({
    action: z.literal('options'),
    category: OptionCategorySchema.optional().default('all'),
    query: z.string().optional().describe('Optional case-insensitive name filter')
});

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert spell slots from the zero-indexed array returned by getSpellSlots
 * (slots[0] = level-1 slot count, slots[1] = level-2, …) into the object
 * shape persisted on the character row.
 *
 * NOTE: This fix is duplicated in PR #54 (issue #44). It must land here too,
 * or every wizard/cleric this PR persists will be off by one slot level.
 */
function convertSpellSlotsToObject(slots: number[] | null) {
    if (!slots || slots.length === 0) return undefined;

    return {
        level1: { current: slots[0] || 0, max: slots[0] || 0 },
        level2: { current: slots[1] || 0, max: slots[1] || 0 },
        level3: { current: slots[2] || 0, max: slots[2] || 0 },
        level4: { current: slots[3] || 0, max: slots[3] || 0 },
        level5: { current: slots[4] || 0, max: slots[4] || 0 },
        level6: { current: slots[5] || 0, max: slots[5] || 0 },
        level7: { current: slots[6] || 0, max: slots[6] || 0 },
        level8: { current: slots[7] || 0, max: slots[7] || 0 },
        level9: { current: slots[8] || 0, max: slots[8] || 0 }
    };
}

function uniqueStrings(...groups: Array<readonly string[] | undefined>): string[] {
    const values = new Map<string, string>();
    for (const group of groups) {
        for (const value of group ?? []) {
            const trimmed = value.trim();
            if (trimmed) values.set(trimmed.toLowerCase(), trimmed);
        }
    }
    return [...values.values()];
}

function validateWizardPreparedSpells(
    characterClass: string | null | undefined,
    knownSpells: readonly string[] | undefined,
    preparedSpells: readonly string[] | undefined,
): void {
    if ((characterClass ?? '').trim().toLowerCase() !== 'wizard') return;

    const spellbook = new Set((knownSpells ?? []).map((spell) => spell.trim().toLowerCase()));
    const missing = [...new Set((preparedSpells ?? [])
        .filter((spell) => !spellbook.has(spell.trim().toLowerCase())))];
    if (missing.length > 0) {
        throw new Error(`Wizard prepared spells must be present in knownSpells (spellbook): ${missing.join(', ')}`);
    }
}

function validSkillProficiencies(values: readonly string[] | undefined): Array<z.infer<typeof SkillProficiencySchema>> {
    return (values ?? []).flatMap((value) => {
        const parsed = SkillProficiencySchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
    });
}

function initialHitPoints(hitDie: number, constitutionModifier: number, level: number): number {
    const firstLevel = Math.max(1, hitDie + constitutionModifier);
    const laterLevel = Math.max(1, Math.floor(hitDie / 2) + 1 + constitutionModifier);
    return firstLevel + Math.max(0, level - 1) * laterLevel;
}

function levelUpHitPointRule(character: {
    characterClass?: string | null;
    race?: string | null;
    stats: { con: number };
}, levelsGained: number) {
    const className = character.characterClass || 'Adventurer';
    const classSource = findOpen5eClass(className);
    const classData = CLASS_DATA[className.trim().toLowerCase().replace(/^srd[-_:]/, '')];
    const hitDie = classSource?.hitDie
        ?? Number.parseInt(classData?.hitDice.replace('d', '') ?? '8', 10);
    const constitutionModifier = Math.floor((character.stats.con - 10) / 2);
    const hitDieIncrease = Math.max(1, Math.floor(hitDie / 2) + 1 + constitutionModifier);
    const speciesSource = character.race ? findOpen5eSpecies(character.race) : undefined;
    const speciesMaxHpPerLevel = speciesSource?.mechanics
        .filter((mechanic) => mechanic.type === 'max_hp_per_level')
        .reduce((total, mechanic) => total + mechanic.value, 0) ?? 0;
    const hpPerLevel = hitDieIncrease + speciesMaxHpPerLevel;

    return {
        mode: 'average' as const,
        levelsGained,
        hitDie,
        constitutionModifier,
        speciesMaxHpPerLevel,
        hpPerLevel,
        hpIncrease: hpPerLevel * levelsGained,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

export { CreateSchema as CharacterCreateSchema };

export async function handleCreate(args: z.infer<typeof CreateSchema>): Promise<object> {
    const { db, characterRepo } = ensureDb();
    // FINDINGS #95 (RULING R4a): the rename window. perceptionBonus/stealthBonus
    // OVERRIDE the composed skill columns — they never added — and the old
    // names now HARD-REFUSE naming the new ones. A silent accept after the
    // rename would be the same defect with a new label (Tom's condition).
    if ((args as Record<string, unknown>).perceptionBonus !== undefined || (args as Record<string, unknown>).stealthBonus !== undefined) {
        throw new Error('RENAMED (#95): perceptionBonus/stealthBonus are now perceptionOverride/stealthOverride — they OVERRIDE the composed WIS/DEX+proficiency column, they do not add to it. Re-issue with the new name. Nothing was written.');
    }
    const now = new Date().toISOString();
    const classSource = findOpen5eClass(args.class || 'Adventurer');
    const speciesSource = findOpen5eSpecies(args.race || 'Human');
    const backgroundSource = args.background ? findOpen5eBackground(args.background) : undefined;
    const className = classSource?.name ?? args.class ?? 'Adventurer';
    const raceName = speciesSource?.name ?? args.race ?? 'Human';
    const backgroundName = backgroundSource?.name ?? args.background;
    const classData = CLASS_DATA[className.trim().toLowerCase().replace(/^srd[-_:]/, '')];
    const legacyClassSaves = classData?.savingThrows
        .map((ability) => CLASS_SAVE_KEYS[ability])
        .filter((ability): ability is z.infer<typeof SaveProficiencySchema> => Boolean(ability)) ?? [];
    const classSaveProficiencies = classSource?.savingThrows ?? legacyClassSaves;
    const backgroundSkills = validSkillProficiencies(backgroundSource?.skillProficiencies);

    const stats = { ...(args.stats ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }) };
    const speciesAbilityBonusesApplied = Boolean(args.applySpeciesAbilityBonuses && speciesSource);
    if (speciesAbilityBonusesApplied && speciesSource) {
        for (const ability of Object.keys(speciesSource.abilityBonuses) as Array<keyof typeof stats>) {
            stats[ability] += speciesSource.abilityBonuses[ability];
        }
    }

    // Source-backed classes own hit-die HP. Custom classes retain the d8 fallback.
    const conModifier = Math.floor((stats.con - 10) / 2);
    const hitDie = classSource?.hitDie ?? Number.parseInt(classData?.hitDice.replace('d', '') ?? '8', 10);
    const level = args.level ?? 1;
    const speciesMaxHpBonus = speciesSource?.mechanics
        .filter((mechanic) => mechanic.type === 'max_hp_per_level')
        .reduce((total, mechanic) => total + mechanic.value * level, 0) ?? 0;
    const baseHp = initialHitPoints(hitDie, conModifier, level);
    const derivedMaxHp = baseHp + speciesMaxHpBonus;
    const hp = args.hp ?? derivedMaxHp;
    const maxHp = args.maxHp ?? Math.max(hp, derivedMaxHp);
    const characterId = randomUUID();

    const supportedSpeciesMechanics = new Set(['max_hp_per_level']);
    const appliedSpeciesMechanics = [
        ...(speciesAbilityBonusesApplied ? ['ability_score_increases'] : []),
        ...(speciesSource?.languages.length ? ['fixed_languages'] : []),
        ...(speciesMaxHpBonus > 0 && args.maxHp === undefined ? ['max_hp_per_level'] : [])
    ];
    const deferredSpeciesMechanics = [
        ...(!speciesAbilityBonusesApplied && speciesSource ? ['ability_score_increases'] : []),
        ...(speciesMaxHpBonus > 0 && args.maxHp !== undefined ? ['max_hp_per_level:maxHp_override'] : [])
    ];
    const unsupportedSpeciesFeatures = (speciesSource?.featureNames ?? [])
        .filter((featureName) => !supportedSpeciesMechanics.has(featureName === 'Dwarven Toughness' ? 'max_hp_per_level' : featureName));

    // Build the base character record from args. The character row MUST be
    // inserted before provisioning runs, otherwise inventory_items.character_id
    // FK fails when the provisioner tries to grant starting equipment.
    const character: Record<string, unknown> = {
        id: characterId,
        name: args.name,
        race: raceName,
        background: backgroundName,
        alignment: args.alignment,
        origin: args.origin,
        characterClass: className,
        stats,
        hp,
        maxHp,
        ac: args.ac ?? 10 + Math.floor((stats.dex - 10) / 2),
        level,
        characterType: args.characterType ?? 'pc',
        factionId: args.factionId,
        behavior: args.behavior,
        knownSpells: args.knownSpells || [],
        cantripsKnown: args.cantripsKnown || [],
        // Known spells are immediately usable after creation unless the caller
        // explicitly supplies a prepared list.
        preparedSpells: args.preparedSpells?.length
            ? [...args.preparedSpells]
            : [...(args.knownSpells || [])],
        skillProficiencies: uniqueStrings(backgroundSkills, args.skillProficiencies),
        saveProficiencies: args.saveProficiencies ?? classSaveProficiencies,
        expertise: args.expertise || [],
        armorProficiencies: args.armorProficiencies ?? classSource?.armorProficiencies ?? classData?.armorProficiencies ?? [],
        weaponProficiencies: args.weaponProficiencies ?? classSource?.weaponProficiencies ?? classData?.weaponProficiencies ?? [],
        toolProficiencies: uniqueStrings(backgroundSource?.toolProficiencies, args.toolProficiencies),
        languages: uniqueStrings(speciesSource?.languages, backgroundSource?.fixedLanguages, args.languages),
        resistances: args.resistances || [],
        vulnerabilities: args.vulnerabilities || [],
        immunities: args.immunities || [],
        perceptionBonus: args.perceptionOverride ?? 0,
        stealthBonus: args.stealthOverride ?? 0,
        // FINDINGS #93: resourcePools was accepted by BOTH schemas and never
        // read by the payload — the #33/#59/#90 anatomy on the worst possible
        // verb: a create whose banner said it worked. Honored now.
        resourcePools: args.resourcePools || {},
        // FINDINGS #107: conditions at create — the repo INSERT always had the
        // column; the schema and this mapping were the strippers.
        conditions: args.conditions || [],
        spellSlots: undefined,
        pactMagicSlots: undefined,
        xp: 0,
        createdAt: now,
        updatedAt: now
    };

    characterRepo.create(character as any);

    // FINDINGS #93: world tag — characters were global rows; with three live
    // campaigns, list without a filter blew a context window. Nullable, like
    // the scheduler's #91 column; old rows stay null and show everywhere.
    if (args.worldId) {
        try { getDb().exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
        try { getDb().prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(args.worldId, character.id); } catch { /* pre-migration db */ }
    }

    // Now safe to provision: character row exists, so FK on inventory_items.character_id resolves.
    let provisioningResult = null;
    const shouldProvision = args.provisionEquipment !== false &&
        (args.characterType === 'pc' || args.characterType === undefined);

    if (shouldProvision) {
        provisioningResult = provisionStartingEquipment(
            db,
            characterId,
            className,
            args.level ?? 1,
            {
                customEquipment: args.customEquipment,
                customSpells: args.knownSpells?.length ? args.knownSpells : undefined,
                startingGold: args.startingGold ?? (backgroundSource
                    ? backgroundSource.startingCurrencyCopper / 100
                    : undefined),
                additionalEquipmentSourceKeys: backgroundSource?.startingItemSourceKeys
            }
        );

        // Roll spell-related fields from provisioning into the in-memory record
        // and persist via update so the character row stays consistent.
        character.knownSpells = provisioningResult.spellsGranted.length
            ? [...new Set([...(args.knownSpells || []), ...provisioningResult.spellsGranted])]
            : args.knownSpells || [];
        character.preparedSpells = args.preparedSpells?.length
            ? [...new Set(args.preparedSpells)]
            : [...new Set(character.knownSpells as string[])];
        character.cantripsKnown = args.cantripsKnown?.length
            ? [...new Set(args.cantripsKnown)]
            : provisioningResult.cantripsGranted || [];
        character.spellSlots = convertSpellSlotsToObject(provisioningResult.spellSlots ?? null);
        character.pactMagicSlots = provisioningResult.pactMagicSlots || undefined;

        characterRepo.update(characterId, {
            knownSpells: character.knownSpells as string[],
            preparedSpells: character.preparedSpells as string[],
            cantripsKnown: character.cantripsKnown as string[],
            spellSlots: character.spellSlots,
            pactMagicSlots: character.pactMagicSlots
        } as any);
    } else if (args.startingGold !== undefined) {
        // Findings #40: startingGold rode the provisioning path and was
        // discarded with the kit when provisionEquipment was false. The #38
        // fix then failed SILENTLY — it wrote to a phantom 'inventories'
        // table (the store is characters.currency; there is no inventories
        // table), and its catch-block ate the error: the GM's #35 lesson,
        // reproduced by the engineer within three days. One honest UPDATE,
        // and the catch now REPORTS instead of swallowing.
        try {
            db.prepare('UPDATE characters SET currency = ? WHERE id = ?')
                .run(JSON.stringify({ gold: args.startingGold, silver: 0, copper: 0 }), characterId);
        } catch (goldErr) {
            (character as unknown as Record<string, unknown>)._startingGoldError =
                `startingGold write failed: ${(goldErr as Error).message}`;
        }
    }

    const provenance = getOpen5eCatalogProvenance();
    const response: Record<string, unknown> = {
        ...character,
        success: true,
        _rules: {
            rulesVersion: provenance.rulesVersion,
            sourcePackHash: provenance.packHash,
            class: classSource ? {
                sourceKey: classSource.sourceKey,
                contentKey: classSource.contentKey,
                hitDie: classSource.hitDie,
                skillChoice: classSource.skillChoice,
                levelOneFeatures: classSource.levelOneFeatures
            } : { custom: true, name: className },
            species: speciesSource ? {
                sourceKey: speciesSource.sourceKey,
                contentKey: speciesSource.contentKey,
                speedFeet: speciesSource.speedFeet,
                abilityBonuses: speciesSource.abilityBonuses,
                abilityBonusesApplied: speciesAbilityBonusesApplied,
                languageChoiceCount: speciesSource.languageChoiceCount,
                featureNames: speciesSource.featureNames,
                appliedMechanics: appliedSpeciesMechanics,
                deferredMechanics: deferredSpeciesMechanics,
                unsupportedFeatureNames: unsupportedSpeciesFeatures,
                maxHpBonus: speciesMaxHpBonus
            } : { custom: true, name: raceName },
            background: backgroundSource ? {
                sourceKey: backgroundSource.sourceKey,
                contentKey: backgroundSource.contentKey,
                languageChoiceCount: backgroundSource.languageChoiceCount,
                startingEquipmentDescription: backgroundSource.startingEquipmentDescription,
                appliedMechanics: [
                    ...(backgroundSource.skillProficiencies.length ? ['fixed_skill_proficiencies'] : []),
                    ...(backgroundSource.fixedLanguages.length ? ['fixed_languages'] : [])
                ],
                deferredMechanics: [
                    ...(backgroundSource.skillChoice ? ['skill_choice'] : []),
                    ...(backgroundSource.languageChoiceCount > 0 ? ['language_choice'] : []),
                    ...(backgroundSource.toolChoice ? ['tool_choice'] : [])
                ]
            } : backgroundName ? { custom: true, name: backgroundName } : null
        }
    };
    if (provisioningResult) {
        response._provisioning = {
            equipmentGranted: provisioningResult.itemsGranted,
            spellsGranted: provisioningResult.spellsGranted,
            cantripsGranted: provisioningResult.cantripsGranted,
            startingGold: provisioningResult.startingGold,
            errors: provisioningResult.errors.length > 0 ? provisioningResult.errors : undefined
        };
    }

    return {
        ...response,
        message: `Created character: ${character.name}`
    };
}

async function handleGet(args: z.infer<typeof GetSchema>): Promise<object> {
    const { characterRepo } = ensureDb();
    const character = characterRepo.findById(args.characterId);

    if (!character) {
        throw new Error(`Character ${args.characterId} not found`);
    }
    // FINDINGS #77: canonicalize — the sheet enrichments below (weapon,
    // instances, effects, currency) are raw SQL keyed by full id; a prefix
    // call silently returned a sheet missing those sections.
    args = { ...args, characterId: character.id };

    // FINDINGS #34 T2.5: currency belongs on the sheet read — the RU is
    // provable the same way the rads are.
    const db = getDb();
    let currency: Record<string, number> | undefined;
    try {
        // Currency lives on characters.currency as JSON (Findings #35 — the
        // first cut queried a nonexistent inventories table and the catch
        // swallowed it; RU was unprovable while lastWrites worked fine).
        const row = db.prepare('SELECT currency FROM characters WHERE id = ?').get(args.characterId) as { currency: string | null } | undefined;
        if (row?.currency) currency = JSON.parse(row.currency);
    } catch { /* malformed currency JSON */ }

    // FINDINGS #34 T1.4: surface the write trail — the last 8 attributed
    // writes to HP and pools, so ghost writes name their authors.
    let lastWrites: Array<Record<string, unknown>> | undefined;
    try {
        lastWrites = db.prepare(
            'SELECT field, old_value AS oldValue, new_value AS newValue, source, created_at AS at FROM write_audit WHERE character_id = ? ORDER BY id DESC LIMIT 8'
        ).all(args.characterId) as Array<Record<string, unknown>>;
    } catch { /* table may predate migration */ }

    // FINDINGS #86: composure spec rides the sheet read — the whole point is
    // that two chairs charge the same number without re-deriving from a note.
    let composureSpec: Record<string, unknown> | undefined;
    try {
        const row = db.prepare('SELECT composure_spec FROM characters WHERE id = ?').get(args.characterId) as { composure_spec: string | null } | undefined;
        if (row?.composure_spec) composureSpec = JSON.parse(row.composure_spec);
    } catch { /* column predates #86 — no spec filed */ }

    return { ...character, currency, currencyNote: currency ? `RU ${currency.gold ?? 0}` : undefined, lastWrites, composureSpec };
}

async function handleUpdate(args: z.infer<typeof UpdateSchema>): Promise<object> {
    const { characterRepo } = ensureDb();
    // FINDINGS #77: canonicalize at entry — this handler mixes repo calls
    // (healed internally) with raw SQL (currency write, bonus-column reads)
    // that the repo cannot heal. The full id is the only id used below.
    const character = characterRepo.findById(args.characterId);
    if (!character) {
        throw new Error(`Character ${args.characterId} not found`);
    }
    // FINDINGS #88: guard before ANY write path (repo or raw SQL).
    if (args.expectName !== undefined && character.name.toLowerCase() !== args.expectName.toLowerCase()) {
        throw new Error(`GUARD REFUSAL: character ${args.characterId} is "${character.name}", not "${args.expectName}" — NOTHING was written.`);
    }
    args = { ...args, characterId: character.id };

    validateWizardPreparedSpells(
        args.class ?? character.characterClass,
        args.knownSpells ?? character.knownSpells,
        args.preparedSpells ?? character.preparedSpells,
    );

    const updateData: Record<string, unknown> = {};

    // Map fields
    if (args.name !== undefined) updateData.name = args.name;
    if (args.race !== undefined) updateData.race = args.race;
    if (args.class !== undefined) updateData.characterClass = args.class;
    if (args.hp !== undefined) updateData.hp = args.hp;
    if (args.maxHp !== undefined) updateData.maxHp = args.maxHp;
    if (args.ac !== undefined) updateData.ac = args.ac;
    if (args.level !== undefined) updateData.level = args.level;
    if (args.xp !== undefined) updateData.xp = args.xp;   // Findings #43: the correction verb
    if (args.characterType !== undefined) updateData.characterType = args.characterType;
    if (args.background !== undefined) updateData.background = args.background;
    if (args.behavior !== undefined) updateData.behavior = args.behavior;
    if (args.factionId !== undefined) updateData.factionId = args.factionId;
    if (args.alignment !== undefined) updateData.alignment = args.alignment;
    if (args.origin !== undefined) updateData.origin = args.origin;
    if (args.stats !== undefined) updateData.stats = args.stats;
    if (args.cantripsKnown !== undefined) updateData.cantripsKnown = args.cantripsKnown;
    if (args.knownSpells !== undefined) updateData.knownSpells = args.knownSpells;
    if (args.preparedSpells !== undefined) updateData.preparedSpells = args.preparedSpells;
    if (args.skillProficiencies !== undefined) updateData.skillProficiencies = args.skillProficiencies;
    if (args.saveProficiencies !== undefined) updateData.saveProficiencies = args.saveProficiencies;
    if (args.expertise !== undefined) updateData.expertise = args.expertise;
    if (args.armorProficiencies !== undefined) updateData.armorProficiencies = args.armorProficiencies;
    if (args.weaponProficiencies !== undefined) updateData.weaponProficiencies = args.weaponProficiencies;
    if (args.toolProficiencies !== undefined) updateData.toolProficiencies = args.toolProficiencies;
    if (args.languages !== undefined) updateData.languages = args.languages;
    // FINDINGS #95 (RULING R4a): rename guard on the update lane too.
    if ((args as Record<string, unknown>).perceptionBonus !== undefined || (args as Record<string, unknown>).stealthBonus !== undefined) {
        throw new Error('RENAMED (#95): perceptionBonus/stealthBonus are now perceptionOverride/stealthOverride — they OVERRIDE the composed skill column, they do not add. Re-issue with the new name. Nothing was written.');
    }
    if (args.perceptionOverride !== undefined) updateData.perceptionBonus = args.perceptionOverride;
    if (args.stealthOverride !== undefined) updateData.stealthBonus = args.stealthOverride;
    if (args.resourcePools !== undefined) updateData.resourcePools = args.resourcePools;

    // FINDINGS #88: preview lane — the diff of mapped fields, zero writes.
    // Runs before column sync and the raw-SQL lanes (startingGold,
    // composureSpec) so NOTHING below this line executes on a preview.
    if (args.preview) {
        const current = characterRepo.findById(args.characterId) as unknown as Record<string, unknown>;
        const wouldChange: Record<string, { from: unknown; to: unknown }> = {};
        for (const [k, v] of Object.entries(updateData)) wouldChange[k] = { from: current?.[k], to: v };
        if (args.startingGold !== undefined) wouldChange.currency = { from: current?.currency, to: { gold: args.startingGold } };
        if (args.composureSpec !== undefined) wouldChange.composureSpec = { from: '(stored)', to: args.composureSpec };
        if (args.conditions !== undefined || args.addConditions !== undefined || args.removeConditions !== undefined) wouldChange.conditions = { from: current?.conditions, to: '(per conditions/addConditions/removeConditions rules)' };
        return {
            success: true,
            preview: true,
            characterId: args.characterId,
            wouldChange,
            message: `PREVIEW ONLY — nothing written. ${Object.keys(wouldChange).length} field(s) would change. (Bonus-column sync not simulated — it derives from stats/level at write time.)`
        };
    }

    // #67-F fix 4: BONUS COLUMNS ARE UNSYNCED CACHES. #67-E made
    // stealth_bonus/perception_bonus authoritative in checks; nothing kept
    // them current — Maksim's perception column stayed 3 while WIS hit 14
    // (composed +4), making the authoritative fix WORSE than composition.
    // OFFSET-PRESERVING SYNC: when this update touches stats, level, or
    // skillProficiencies (and does not itself set the column), recompute
    // newColumn = newComposed + (oldColumn − oldComposed). Hand-set monster
    // columns (Kroshka +7) keep their offset and TRACK stat changes instead
    // of being clobbered; default columns follow the sheet exactly.
    let columnSync: Record<string, { from: number; to: number; offset: number }> | undefined;
    if (args.stats !== undefined || args.level !== undefined || args.skillProficiencies !== undefined) {
        const old = characterRepo.findById(args.characterId);
        if (old) {
            const oldStats = old.stats as Record<string, number>;
            const newStats = (args.stats ?? oldStats) as Record<string, number>;
            const oldLevel = old.level, newLevel = args.level ?? old.level;
            const oldSkills = (old as { skillProficiencies?: string[] }).skillProficiencies || [];
            const newSkills = args.skillProficiencies ?? oldSkills;
            const m = (s: number) => Math.floor((s - 10) / 2);
            const pb = (l: number) => Math.floor((l - 1) / 4) + 2;
            const compose = (ability: 'dex' | 'wis', skill: string, stats: Record<string, number>, lvl: number, skills: string[]) =>
                m(stats[ability] ?? 10) + (skills.includes(skill) ? pb(lvl) : 0);
            const oldRow = getDb().prepare('SELECT stealth_bonus AS s, perception_bonus AS p FROM characters WHERE id = ?').get(args.characterId) as { s?: number | null; p?: number | null } | undefined;
            const sync = (colVal: number | null | undefined, ability: 'dex' | 'wis', skill: string): { from: number; to: number; offset: number } | null => {
                if (typeof colVal !== 'number') return null; // never-set columns stay unset
                const oldComposed = compose(ability, skill, oldStats, oldLevel, oldSkills);
                const newComposed = compose(ability, skill, newStats, newLevel, newSkills);
                const offset = colVal - oldComposed;
                const to = newComposed + offset;
                return to !== colVal ? { from: colVal, to, offset } : null;
            };
            // FINDINGS #111: the #95 rename missed its own guard — these checked the
            // OLD names (which now refuse, so were always undefined), so an explicit
            // override passed WITH a stat change was overwritten by offset-preserve
            // math (WIS 15→17 + override 5 → column 6). An explicit override is
            // ABSOLUTE: when passed, the sync for that column does not run.
            const sSync = args.stealthOverride === undefined ? sync(oldRow?.s, 'dex', 'stealth') : null;
            const pSync = args.perceptionOverride === undefined ? sync(oldRow?.p, 'wis', 'perception') : null;
            if (sSync) { updateData.stealthBonus = sSync.to; (columnSync ??= {}).stealth_bonus = sSync; }
            if (pSync) { updateData.perceptionBonus = pSync.to; (columnSync ??= {}).perception_bonus = pSync; }
        }
    }

    // Previously accepted by the outer schema, stripped by this one, and
    // silently dropped — a success-banner no-op. Now an absolute RU set.
    // FINDINGS #94: the per-row world claim — strict list filtering's other half.
    if (args.worldId !== undefined) {
        try { getDb().exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
        try { getDb().prepare('UPDATE characters SET world_id = ? WHERE id = ?').run(args.worldId, args.characterId); } catch { /* pre-migration */ }
    }

    if (args.startingGold !== undefined) {
        getDb().prepare('UPDATE characters SET currency = ? WHERE id = ?')
            .run(JSON.stringify({ gold: args.startingGold, silver: 0, copper: 0 }), args.characterId);
    }

    // FINDINGS #86: composure spec — raw column write (not a repo field), same
    // lane as currency above. Guarded ALTER births the column on first use.
    if (args.composureSpec !== undefined) {
        const cdb = getDb();
        try { cdb.exec('ALTER TABLE characters ADD COLUMN composure_spec TEXT'); } catch { /* column exists */ }
        cdb.prepare('UPDATE characters SET composure_spec = ? WHERE id = ?')
            .run(JSON.stringify(args.composureSpec), args.characterId);
    }

    // Handle conditions
    if (args.conditions !== undefined) {
        updateData.conditions = args.conditions;
    } else if (args.addConditions !== undefined || args.removeConditions !== undefined) {
        let currentConditions: Array<{ name: string; duration?: number; source?: string }> =
            (character as any).conditions || [];

        if (args.removeConditions?.length) {
            const toRemove = new Set(args.removeConditions.map(n => n.toLowerCase()));
            currentConditions = currentConditions.filter(c => !toRemove.has(c.name.toLowerCase()));
        }

        if (args.addConditions?.length) {
            for (const newCond of args.addConditions) {
                const existingIdx = currentConditions.findIndex(
                    c => c.name.toLowerCase() === newCond.name.toLowerCase()
                );
                if (existingIdx >= 0) {
                    currentConditions[existingIdx] = { ...currentConditions[existingIdx], ...newCond };
                } else {
                    currentConditions.push(newCond);
                }
            }
        }

        updateData.conditions = currentConditions;
    }

    const updated = characterRepo.update(args.characterId, updateData);
    if (!updated) {
        throw new Error(`Failed to update character: ${args.characterId}`);
    }

    return {
        ...updated,
        success: true,
        ...(columnSync && { columnSync }),
        message: `Character updated successfully${columnSync ? ` — column sync: ${Object.entries(columnSync).map(([k, v]) => `${k} ${v.from}→${v.to} (offset ${v.offset >= 0 ? '+' : ''}${v.offset} preserved)`).join(', ')}` : ''}`
    };
}

async function handleList(args: z.infer<typeof ListSchema>): Promise<object> {
    const { characterRepo } = ensureDb();
    let characters = characterRepo.findAll({
        characterType: args.characterType
    });

    // FINDINGS #94: STRICT world filter — #93's tagged-or-null semantics were
    // wrong for list (verify pass: 147 rows passed as "filtered"). Scheduler
    // nulls were a transition state; character nulls are four campaigns of
    // legacy rows that will never bulk-claim. Strict match + honest untagged
    // count + the per-row claim path (update {worldId}).
    if (args.worldId !== undefined) {
        let tagged = new Map<string, string | null>();
        let columnExists = true;
        try {
            const rows = getDb().prepare('SELECT id, world_id FROM characters').all() as Array<{ id: string; world_id: string | null }>;
            tagged = new Map(rows.map(r => [r.id, r.world_id]));
        } catch { columnExists = false; }
        if (columnExists) {
            const before = characters.length;
            characters = characters.filter(c => tagged.get((c as { id: string }).id) === args.worldId);
            const untagged = [...tagged.values()].filter(v => v === null).length;
            (args as Record<string, unknown>).__untaggedNote = `${characters.length} of ${before} rows tagged to this world; ${untagged} untagged legacy row(s) EXCLUDED — claim per row via character update {worldId}, or list without worldId for everything`;
        }
    }

    if (args.nativeToBastion !== undefined) {
        characters = characters.filter(character => character.origin?.native === args.nativeToBastion);
    }
    if (args.sourceUniverse !== undefined) {
        characters = characters.filter(character => character.origin?.universe === args.sourceUniverse);
    }

    const total = characters.length;
    let truncated: Array<{ id: string; name: string }> | undefined;
    if (args.limit !== undefined && characters.length > args.limit) {
        truncated = characters.slice(args.limit).map(c => ({ id: (c as { id: string }).id, name: (c as { name: string }).name }));
        characters = characters.slice(0, args.limit);
    }

    return {
        characters,
        count: characters.length,
        totalMatching: total,
        ...(args.worldId !== undefined ? { worldId: args.worldId, ...((args as Record<string, unknown>).__untaggedNote ? { untaggedNote: (args as Record<string, unknown>).__untaggedNote } : {}) } : {}),
        ...(truncated ? { beyondLimit: truncated, limitNote: `${truncated.length} further row(s) as id+name only — raise limit or narrow the filter for full rows` } : {}),
        filter: args.worldId !== undefined ? `world:${args.worldId}${args.characterType ? ` + ${args.characterType}` : ''}` : (args.characterType || 'all')
    };
}

async function handleDelete(args: z.infer<typeof DeleteSchema>): Promise<object> {
    const { db } = ensureDb();
    // FINDINGS #94: the MORE dangerous delete finally gets the journal the
    // item delete already had — the row can come back whole via revert.
    const journalId = journalSnapshot(db, 'characters', args.characterId, 'delete', 'character_manage delete');
    const stmt = db.prepare('DELETE FROM characters WHERE id = ?');
    const r = stmt.run(args.characterId);

    return {
        success: true,
        characterId: args.characterId,
        deleted: r.changes > 0,
        ...(journalId !== null ? { journalId, revertable: `session_manage revert {writeId:${journalId}}` } : { note: 'row did not exist — nothing journaled, nothing deleted' }),
        message: r.changes > 0 ? `Character deleted — revertable: session_manage revert {writeId:${journalId}}` : 'No such character — nothing deleted'
    };
}

// #67: KILL — death as an EVENT, not a state write pretending to be one.
// One verb: HP → 0, concentration breaks, corpse row born. The GM stops
// hand-building corpses; the fiction gets one call for 'this thing is dead'.
const KillSchema = z.object({
    action: z.literal('kill'),
    characterId: z.string(),
    cause: z.string().optional().describe('What killed it — written to the return, canon for the wall map'),
    encounterId: z.string().optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    worldId: z.string().optional(),
    createCorpse: z.boolean().optional().default(true).describe('false = death without a body (dissolved, vaporised, taken)'),
    currency: z.record(z.number()).optional().describe('Currency on the corpse (e.g. {gold: 150})')
});

async function handleKill(args: z.infer<typeof KillSchema>): Promise<object> {
    const { db, characterRepo } = ensureDb();
    const char = characterRepo.findById(args.characterId);
    if (!char) return { error: true, message: `Character ${args.characterId} not found`, writes: 'none' };
    // FINDINGS #77: canonicalize — concentration deletes and corpse writes
    // below are raw SQL; a prefix kill would zero HP (repo-healed) and then
    // leave concentration standing on the full id.
    args = { ...args, characterId: char.id };

    const hpBefore = char.hp;
    characterRepo.update(args.characterId, { hp: 0 });

    // Concentration dies with the concentrator — and any thrall comes loose.
    let concentrationBroken: string | undefined;
    try {
        const conRepo = new ConcentrationRepository(db) as unknown as {
            isConcentrating(id: string): boolean;
            getActive?: (id: string) => { spellName?: string } | undefined;
        };
        if (conRepo.isConcentrating(args.characterId)) {
            const active = conRepo.getActive?.(args.characterId);
            db.prepare('DELETE FROM concentration WHERE character_id = ?').run(args.characterId);
            concentrationBroken = active?.spellName ?? 'active effect';
        }
    } catch { /* no concentration table state — nothing to break */ }

    let corpse: { id: string } | undefined;
    if (args.createCorpse !== false) {
        const corpseRepo = new CorpseRepository(db);
        corpse = corpseRepo.createFromDeath(
            args.characterId,
            char.name,
            (char.characterType ?? 'npc') as 'pc' | 'npc' | 'enemy' | 'neutral',
            {
                encounterId: args.encounterId,
                position: args.position,
                worldId: args.worldId,
                currency: args.currency as { gold?: number } | undefined
            }
        );
    }

    return {
        success: true,
        actionType: 'kill',
        characterId: args.characterId,
        characterName: char.name,
        hpBefore,
        hp: 0,
        defeated: true,
        cause: args.cause,
        concentrationBroken,
        corpseId: corpse?.id,
        corpseCreated: !!corpse,
        message: `${char.name} is dead${args.cause ? ` — ${args.cause}` : ''}.${corpse ? ` Corpse ${corpse.id.slice(0, 8)} on the ground.` : ' No body.'}${concentrationBroken ? ` Concentration broken (${concentrationBroken}).` : ''}`
    };
}

async function handleAdjustPool(args: z.infer<typeof AdjustPoolSchema>): Promise<object> {
    const { characterRepo } = ensureDb();
    const char = characterRepo.findById(args.characterId);
    if (!char) throw new Error(`Character ${args.characterId} not found`);
    // FINDINGS #77: canonicalize — the result echoes characterId and the GM
    // reads that echo as the tell for whether resolution propagated.
    args = { ...args, characterId: char.id };

    const pools = { ...((char as { resourcePools?: Record<string, { current: number; max: number; lastRefilledAt?: string }> }).resourcePools || {}) };

    // FINDINGS #34 T2.6: pool deletion — a traded rifle's condition pool
    // should not haunt its old owner at zero forever.
    if (args.removePool) {
        if (!(args.pool in pools)) {
            return Promise.resolve({ success: true, actionType: 'adjust_pool', characterId: args.characterId, pool: args.pool, removed: false, message: `Pool "${args.pool}" did not exist — nothing to remove.` });
        }
        const last = pools[args.pool];
        delete pools[args.pool];
        characterRepo.update(args.characterId, { resourcePools: pools } as Partial<import('../../schema/character.js').Character>);
        return Promise.resolve({ success: true, actionType: 'adjust_pool', characterId: args.characterId, pool: args.pool, removed: true, lastValue: `${last.current}/${last.max}`, message: `Pool "${args.pool}" removed (was ${last.current}/${last.max}).` });
    }

    const existing = pools[args.pool] || { current: 0, max: args.max ?? 100 };
    const max = args.max ?? existing.max;
    const before = existing.current;
    // #67-F: value (absolute) beats delta; passing both is ambiguity — refused.
    if (args.value !== undefined && args.delta !== undefined && args.delta !== 0) {
        return { error: true, actionType: 'adjust_pool', message: 'Pass value (absolute, retry-safe) OR delta (relative), not both.', writes: 'none' };
    }
    const current = args.value !== undefined
        ? Math.min(max, Math.max(0, args.value))
        : Math.min(max, Math.max(0, before + args.delta));
    pools[args.pool] = { ...existing, current, max };
    // FINDINGS #111: the witness ledger. A respect number is not the fiction —
    // WHO SAW is. When a reason or witnesses ride the call, the pool keeps its
    // own history (capped at 20) so `get` answers "who knows this man's name
    // and why" without a new table. Silent ticks (hunger clocks) write nothing.
    if (args.reason || args.witnesses?.length) {
        const entry = { at: new Date().toISOString(), from: before, to: current, ...(args.value !== undefined ? { set: args.value } : { delta: args.delta }), ...(args.reason ? { reason: args.reason } : {}), ...(args.witnesses?.length ? { witnesses: args.witnesses } : {}) };
        const hist = ((pools[args.pool] as { history?: unknown[] }).history ?? []).concat([entry]).slice(-20);
        (pools[args.pool] as { history?: unknown[] }).history = hist;
    }

    characterRepo.update(args.characterId, { resourcePools: pools } as Partial<import('../../schema/character.js').Character>);

    return {
        success: true,
        actionType: 'adjust_pool',
        characterId: args.characterId,
        characterName: char.name,
        pool: args.pool,
        before,
        mode: args.value !== undefined ? 'set' : 'delta',
        ...(args.value !== undefined ? { requested: args.value } : { delta: args.delta }),
        current,
        max,
        // FINDINGS #99: value-mode used to compute before + undefined → NaN ≠ current
        // → clamped:true on every absolute set. Mode-aware now.
        clamped: args.value !== undefined ? args.value !== current : before + (args.delta ?? 0) !== current,
        ...(args.witnesses?.length ? { witnesses: args.witnesses } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
        message: `${args.pool}: ${before} -> ${current} (of ${max})${args.value !== undefined ? ' [set]' : ''}${args.witnesses?.length ? ` — witnessed by ${args.witnesses.length}` : ''}`
    };
}

// ─── FINDINGS #60: THE MEND CLOCK — handlers ───
function ensureScheduleTable(db: ReturnType<typeof getDb>): void {
    // Belt-and-braces lazy create (the #57 pattern): the migration carries the
    // table, but a handler must never assume the migration has re-run.
    db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_state_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      fires_at_day REAL NOT NULL,
      writes TEXT NOT NULL DEFAULT '[]',
      note TEXT,
      fired INTEGER NOT NULL DEFAULT 0,
      fired_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_changes_due ON scheduled_state_changes(fired, fires_at_day);
    CREATE INDEX IF NOT EXISTS idx_scheduled_changes_char ON scheduled_state_changes(character_id);
    `);
    // FINDINGS #69: recurring clocks — column added post-launch; the table is
    // live, so ALTER with a guard instead of a migration ceremony.
    try { db.exec('ALTER TABLE scheduled_state_changes ADD COLUMN recur_every_days REAL'); } catch { /* column exists */ }
    // FINDINGS #82: events — a clock with no writes, just a note that fires.
    // The column distinguishes an event row from a malformed one, so the
    // '⚠ writes empty' honesty stays intact for genuine malformations.
    try { db.exec('ALTER TABLE scheduled_state_changes ADD COLUMN is_event INTEGER NOT NULL DEFAULT 0'); } catch { /* column exists */ }
    // FINDINGS #91: WORLD SCOPING — two campaigns share the db but run
    // DIFFERENT CLOCKS. Without scope, the first PSAR boot after a second
    // world seeds would fire every young-world row up to Day 47 in one call.
    // Nullable: legacy rows are unscoped until claimed via scope_scheduled.
    try { db.exec('ALTER TABLE scheduled_state_changes ADD COLUMN world_id TEXT'); } catch { /* column exists */ }
}

type ScheduledWriteOp = z.infer<typeof ScheduledWriteOpSchema>;
type ScheduleRow = { id: number; character_id: string; fires_at_day: number; writes: string; note: string | null; fired: number; fired_at: string | null; created_at: string; recur_every_days: number | null; is_event?: number | null; world_id?: string | null };

// FINDINGS #73: op application EXTRACTED — one arithmetic shared by
// process_scheduled and schedule_change fireNow, so a named one-off lands in
// the same ledger with the same math as the recurring clocks. Kroshka's
// exertion adds stop being scattered manual pokes.
function applyScheduledOps(
    char: { hp: number; maxHp: number },
    ops: ScheduledWriteOp[]
): { applied: string[]; updates: Record<string, unknown> } {
    const applied: string[] = [];
    const pools = { ...((char as { resourcePools?: Record<string, { current: number; max: number; lastRefilledAt?: string }> }).resourcePools || {}) };
    let conditions = [...(((char as { conditions?: Array<{ name: string; duration?: number; source?: string }> }).conditions) || [])];
    let hp = char.hp, maxHp = char.maxHp;
    let poolsTouched = false, condsTouched = false, hpTouched = false, maxHpTouched = false;
    for (const op of ops) {
        switch (op.op) {
            case 'adjust_pool': {
                if (!op.pool) { applied.push('⚠ adjust_pool op missing pool name — skipped'); break; }
                const existing = pools[op.pool] || { current: 0, max: op.max ?? 100 };
                const pmax = op.max ?? existing.max;
                const before = existing.current;
                const current = Math.min(pmax, Math.max(0, before + (op.delta ?? 0)));
                pools[op.pool] = { ...existing, current, max: pmax };
                poolsTouched = true;
                applied.push(`${op.pool}: ${before} → ${current} (of ${pmax})`);
                break;
            }
            case 'adjust_hp': {
                const before = hp;
                hp = Math.min(maxHp, Math.max(0, hp + (op.delta ?? 0)));
                if (hp !== before) hpTouched = true;
                applied.push(`hp: ${before} → ${hp}`);
                break;
            }
            case 'adjust_max_hp': {
                const beforeM = maxHp;
                maxHp = Math.max(1, maxHp + (op.delta ?? 0));
                if (hp > maxHp) { hp = maxHp; hpTouched = true; }
                if (maxHp !== beforeM) maxHpTouched = true;
                applied.push(`maxHp: ${beforeM} → ${maxHp}`);
                break;
            }
            case 'add_condition': {
                if (!op.name) { applied.push('⚠ add_condition op missing name — skipped'); break; }
                if (conditions.some(c => c.name === op.name)) { applied.push(`condition "${op.name}" already present — skipped`); break; }
                conditions.push({ name: op.name, ...(op.duration !== undefined ? { duration: op.duration } : {}), source: op.source ?? 'mend clock' });
                condsTouched = true;
                applied.push(`+condition ${op.name}`);
                break;
            }
            case 'remove_condition': {
                if (!op.name) { applied.push('⚠ remove_condition op missing name — skipped'); break; }
                const beforeLen = conditions.length;
                conditions = conditions.filter(c => c.name !== op.name);
                if (conditions.length !== beforeLen) { condsTouched = true; applied.push(`−condition ${op.name}`); }
                else applied.push(`condition "${op.name}" not present — skipped`);
                break;
            }
        }
    }
    if (ops.length === 0) applied.push('⚠ writes JSON empty or malformed — nothing applied');
    const updates: Record<string, unknown> = {};
    if (poolsTouched) updates.resourcePools = pools;
    if (condsTouched) updates.conditions = conditions;
    if (hpTouched) updates.hp = hp;
    if (maxHpTouched) updates.maxHp = maxHp;
    return { applied, updates };
}

// FINDINGS #89: fractional days print as a clock — 47.5993 is "Day 47, 14:23",
// not "Day 47". The banner truncation hid the very hours #88 added.
function dayClock(d: number): string {
    const frac = d - Math.floor(d);
    if (frac < 1 / 1440) return `Day ${Math.floor(d)}`;
    const mins = Math.round(frac * 1440);
    return `Day ${Math.floor(d)}, ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

async function handleScheduleChange(args: z.infer<typeof ScheduleChangeSchema>): Promise<object> {
    const { db, characterRepo } = ensureDb();
    ensureScheduleTable(db);
    const char = characterRepo.findById(args.characterId);
    if (!char) throw new Error(`Character ${args.characterId} not found — a clock needs a body to fire on`);
    // FINDINGS #77: canonicalize BEFORE the ledger INSERT — row 14 stored the
    // raw short id as character_id while the lister displayed the resolved
    // name over it. The full id is the only id that touches SQL.
    args = { ...args, characterId: char.id };
    // FINDINGS #82: refuse-not-fake — an empty clock with no event flag would
    // fire nothing and report having fired; that row must never exist.
    if ((!args.writes || args.writes.length === 0) && !args.event) {
        throw new Error(`schedule_change with empty writes needs event: true — a clock that writes nothing is either a GM EVENT (say so) or a mistake (refused). Nothing was inserted.`);
    }
    const now = new Date().toISOString();
    // FINDINGS #88: resolve the hour lanes into ONE fractional day before any
    // insert — the recurrence re-arm and the fireNow stamp both ride it.
    // FINDINGS #89: firesAtDay is optional at the schema now — the validator
    // refused the very lanes #88 added. Coherence is enforced HERE, loudly:
    // firesAtDay (±firesAtHour) OR firesInHours+currentDay; anything else
    // refuses with the recipe. firesInHours overrides firesAtDay when both
    // are passed (the dummy-day workaround stays legal).
    let firesAt: number;
    if (args.firesInHours !== undefined) {
        if (args.currentDay === undefined) {
            throw new Error('firesInHours needs a base: pass currentDay (and optionally currentTime "HH:MM"). Nothing was inserted.');
        }
        let base = args.currentDay;
        if (args.currentTime) {
            const [h, m] = args.currentTime.split(':').map(Number);
            base = Math.floor(args.currentDay) + (h * 60 + m) / 1440;
        }
        firesAt = base + args.firesInHours / 24;
    } else if (args.firesAtDay !== undefined) {
        firesAt = args.firesAtHour !== undefined ? Math.floor(args.firesAtDay) + args.firesAtHour / 24 : args.firesAtDay;
    } else {
        throw new Error('schedule_change needs a firing time: pass firesAtDay (optionally with firesAtHour), OR firesInHours with currentDay (+currentTime). firesAtHour alone has no day to ride on. Nothing was inserted.');
    }
    const info = db.prepare('INSERT INTO scheduled_state_changes (character_id, fires_at_day, writes, note, created_at, recur_every_days, is_event, world_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(args.characterId, firesAt, JSON.stringify(args.writes), args.note ?? null, now, args.recurEveryDays ?? null, args.event ? 1 : 0, args.worldId ?? null);

    // FINDINGS #73: named one-off — fire in the same call, land in the ledger.
    // Same op arithmetic as the processor; a recurring row fired now re-arms
    // exactly as it would from process_scheduled.
    let firedNowApplied: string[] | null = null;
    if (args.fireNow) {
        let applied: string[];
        if (args.event) {
            // FINDINGS #82: an event fired now is just its notification.
            applied = [`📣 GM EVENT${args.note ? `: ${args.note}` : ''} (fired immediately)`];
        } else {
            const opResult = applyScheduledOps(char, args.writes as ScheduledWriteOp[]);
            applied = opResult.applied;
            const updates = opResult.updates;
            if (Object.keys(updates).length) {
                // FINDINGS #77: the FIRED NOW report derives from the STORE's answer,
                // not the input arithmetic — a null here leaves the row unfired and
                // throws loud instead of fabricating a transition (#76's 0→7 on a
                // pool that never existed).
                const written = characterRepo.update(args.characterId, updates as Partial<import('../../schema/character.js').Character>);
                if (!written) throw new Error(`fireNow write FAILED for ${args.characterId} — ledger row ${info.lastInsertRowid} left unfired, nothing applied`);
            }
        }
        db.prepare('UPDATE scheduled_state_changes SET fired = 1, fired_at = ? WHERE id = ?').run(now, Number(info.lastInsertRowid));
        if (args.recurEveryDays && args.recurEveryDays > 0) {
            db.prepare('INSERT INTO scheduled_state_changes (character_id, fires_at_day, writes, note, created_at, recur_every_days, is_event, world_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(args.characterId, firesAt + args.recurEveryDays, JSON.stringify(args.writes), args.note ?? null, now, args.recurEveryDays, args.event ? 1 : 0, args.worldId ?? null);
        }
        firedNowApplied = applied;
    }
    return {
        success: true,
        actionType: 'schedule_change',
        ...(firedNowApplied ? { firedNow: true, applied: firedNowApplied } : {}),
        scheduleId: Number(info.lastInsertRowid),
        kind: args.event ? 'event' : 'clock',
        characterId: args.characterId,
        characterName: char.name,
        firesAtDay: firesAt,
        firesAtClock: dayClock(firesAt),
        ops: args.writes.length,
        note: args.note ?? null,
        recurEveryDays: args.recurEveryDays ?? null,
        message: firedNowApplied
            ? `FIRED NOW for ${char.name} (ledger ${dayClock(firesAt)}${args.note ? `: ${args.note}` : ''}, id ${info.lastInsertRowid}) — ${firedNowApplied.join('; ')}${args.recurEveryDays ? ` · recurs every ${args.recurEveryDays}d` : ''}`
            : `${args.event ? 'EVENT scheduled' : 'Scheduled'} for ${char.name} — fires ${dayClock(firesAt)}${args.recurEveryDays ? `, then every ${args.recurEveryDays} day${args.recurEveryDays === 1 ? '' : 's'} (recurring)` : ''}${args.note ? `: ${args.note}` : ''} (${args.event ? 'GM event, no writes' : `${args.writes.length} op${args.writes.length === 1 ? '' : 's'}`}, id ${info.lastInsertRowid})`
    };
}

async function handleProcessScheduled(args: z.infer<typeof ProcessScheduledSchema>): Promise<object> {
    const { db, characterRepo } = ensureDb();
    ensureScheduleTable(db);
    const now = new Date().toISOString();
    // FINDINGS #88: fractionalize the clock — hour-clocks fire mid-day.
    let effectiveDay = args.currentDay;
    if (args.currentTime) {
        const [h, m] = args.currentTime.split(':').map(Number);
        effectiveDay = Math.floor(args.currentDay) + (h * 60 + m) / 1440;
    }
    const results: Array<Record<string, unknown>> = [];
    // FINDINGS #100: worldId is REQUIRED at the schema and filtered here — an
    // optional filter on this, the one genuinely destructive global write in
    // the toolkit, was the SALT incident (cross-campaign fires + an HP write
    // onto another table's PC). characterId now genuinely narrows.
    let scopeSql = ' AND world_id = ?';
    const scopeParams: unknown[] = [args.worldId];
    if (args.characterId) { scopeSql += ' AND character_id = ?'; scopeParams.push(args.characterId); }
    let skippedUnscoped = 0;
    {
        const s = db.prepare('SELECT COUNT(*) AS n FROM scheduled_state_changes WHERE fired = 0 AND fires_at_day <= ? AND world_id IS NULL').get(effectiveDay) as { n: number };
        skippedUnscoped = s.n;
    }
    // FINDINGS #69: recurring clocks re-arm on fire, and the processor LOOPS
    // until nothing is due — five missed days of a daily hunger clock fire
    // FIVE TIMES, each its own row in results, not one collapsed tick.
    // The pass guard only trips on a pathological backlog and says so.
    let passes = 0;
    let due = db.prepare(`SELECT * FROM scheduled_state_changes WHERE fired = 0 AND fires_at_day <= ?${scopeSql} ORDER BY fires_at_day, id`).all(effectiveDay, ...scopeParams) as ScheduleRow[];
    // FINDINGS #100: preview — the dry-run lane. Reports the first-pass due set
    // and writes NOTHING; recurring chains that would walk forward in a live
    // run are flagged, not simulated.
    if (args.preview) {
        const wouldFire = due.map(r => ({ scheduleId: r.id, kind: (r.is_event ?? 0) === 1 ? 'event' : 'clock', characterId: r.character_id, characterName: characterRepo.findById(r.character_id)?.name ?? '(deleted)', firesAtDay: r.fires_at_day, note: r.note, recurEveryDays: r.recur_every_days ?? null }));
        const chains = wouldFire.filter(w => w.recurEveryDays).length;
        return {
            success: true, actionType: 'process_scheduled', preview: true, writes: 'none',
            currentDay: args.currentDay, ...(args.currentTime ? { currentTime: args.currentTime, effectiveDay } : {}),
            worldId: args.worldId, ...(args.characterId ? { characterId: args.characterId } : {}),
            ...(skippedUnscoped > 0 ? { skippedUnscoped } : {}),
            wouldFireCount: wouldFire.length, wouldFire,
            message: wouldFire.length === 0
                ? `Preview: nothing due at Day ${args.currentDay} — no writes.`
                : `Preview: ${wouldFire.length} row(s) due at Day ${args.currentDay} — NOTHING written.${chains ? ` ${chains} recurring chain(s) may fire additional times in a live run.` : ''}`
        };
    }
    while (due.length > 0 && passes < 400) {
        passes++;
    for (const row of due) {
        const char = characterRepo.findById(row.character_id);
        if (!char) {
            // Never silent (#40): the row fires into a missing body — mark and report.
            db.prepare('UPDATE scheduled_state_changes SET fired = 1, fired_at = ? WHERE id = ?').run(now, row.id);
            results.push({ scheduleId: row.id, characterId: row.character_id, firesAtDay: row.fires_at_day, note: row.note, applied: [], skipped: 'character no longer exists — clock retired unfired' });
            continue;
        }
        let ops: ScheduledWriteOp[] = [];
        try { ops = JSON.parse(row.writes || '[]') as ScheduledWriteOp[]; } catch { /* malformed — reported below */ }
        // FINDINGS #82: event rows fire a NOTIFICATION, not writes — the GM's
        // NPC-delivery timers. Marked fired and re-armed like any clock.
        // FINDINGS #73: shared op application — one arithmetic for clocks and one-offs.
        const isEvent = (row.is_event ?? 0) === 1;
        const { applied, updates } = isEvent
            ? { applied: [`📣 GM EVENT DUE${row.note ? `: ${row.note}` : ''}`], updates: {} as Record<string, unknown> }
            : applyScheduledOps(char, ops);
        if (Object.keys(updates).length) characterRepo.update(row.character_id, updates as Partial<import('../../schema/character.js').Character>);
        db.prepare('UPDATE scheduled_state_changes SET fired = 1, fired_at = ? WHERE id = ?').run(now, row.id);
        // FINDINGS #69: a recurring clock re-arms itself the moment it fires —
        // the next row inherits writes, note, and recurrence. The loop above
        // catches it this same call if it's already due.
        let rearmedAs: number | null = null;
        if (row.recur_every_days && row.recur_every_days > 0) {
            const next = db.prepare('INSERT INTO scheduled_state_changes (character_id, fires_at_day, writes, note, created_at, recur_every_days, is_event, world_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(row.character_id, row.fires_at_day + row.recur_every_days, row.writes, row.note, now, row.recur_every_days, row.is_event ?? 0, row.world_id ?? null);
            rearmedAs = Number(next.lastInsertRowid);
        }
        results.push({ scheduleId: row.id, kind: (row.is_event ?? 0) === 1 ? 'event' : 'clock', characterId: row.character_id, characterName: char.name, firesAtDay: row.fires_at_day, note: row.note, applied, ...(rearmedAs !== null ? { recurring: true, rearmedAs, nextFiresAtDay: row.fires_at_day + (row.recur_every_days ?? 0) } : {}) });
    }
    due = db.prepare(`SELECT * FROM scheduled_state_changes WHERE fired = 0 AND fires_at_day <= ?${scopeSql} ORDER BY fires_at_day, id`).all(effectiveDay, ...scopeParams) as ScheduleRow[];
    }
    const backlogWarning = passes >= 400 && due.length > 0
        ? `⚠ pass guard tripped at ${passes} passes with ${due.length} row(s) still due — a recurrence is probably misconfigured (interval too small for the day jump). Remaining rows fire on the next process_scheduled.`
        : undefined;
    return {
        success: true,
        actionType: 'process_scheduled',
        currentDay: args.currentDay,
        ...(args.currentTime ? { currentTime: args.currentTime, effectiveDay } : {}),
        ...(args.worldId ? { worldId: args.worldId } : {}),
        ...(args.characterId ? { characterId: args.characterId } : {}),
        ...(skippedUnscoped > 0 ? { skippedUnscoped, scopeWarning: `⚠ ${skippedUnscoped} UNSCOPED row(s) due but NOT fired — claim them into their world: scope_scheduled {worldId} stamps all unscoped rows (#91/#100; global unscoped processing is retired)` } : {}),
        firedCount: results.length,
        results,
        ...(backlogWarning ? { backlogWarning } : {}),
        message: results.length === 0
            ? `Mend clock: nothing due at Day ${args.currentDay}.`
            : `Mend clock: ${results.length} change${results.length === 1 ? '' : 's'} fired at Day ${args.currentDay}.${backlogWarning ? ' ' + backlogWarning : ''}`
    };
}

async function handleListScheduled(args: z.infer<typeof ListScheduledSchema>): Promise<object> {
    const { db, characterRepo } = ensureDb();
    ensureScheduleTable(db);
    let sql = 'SELECT * FROM scheduled_state_changes';
    const where: string[] = [];
    const params: unknown[] = [];
    // FINDINGS #91: list respects world scope; unscoped rows still show (null)
    // so the claim debt stays visible.
    if (args.worldId) { where.push('(world_id = ? OR world_id IS NULL)'); params.push(args.worldId); }
    if (!args.includeFired) where.push('fired = 0');
    if (args.characterId) { where.push('character_id = ?'); params.push(characterRepo.findById(args.characterId)?.id ?? args.characterId); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY fires_at_day, id';
    const rows = db.prepare(sql).all(...params) as ScheduleRow[];
    const nameCache = new Map<string, string>();
    const scheduled = rows.map(r => {
        if (!nameCache.has(r.character_id)) nameCache.set(r.character_id, characterRepo.findById(r.character_id)?.name ?? '(deleted)');
        let opsCount = 0; try { opsCount = (JSON.parse(r.writes || '[]') as unknown[]).length; } catch { /* reported as 0 */ }
        return { scheduleId: r.id, kind: (r.is_event ?? 0) === 1 ? 'event' : 'clock', characterId: r.character_id, characterName: nameCache.get(r.character_id), firesAtDay: r.fires_at_day, ops: opsCount, note: r.note, recurEveryDays: r.recur_every_days ?? null, worldId: r.world_id ?? null, fired: r.fired === 1, firedAt: r.fired_at, writes: r.writes };
    });
    return { success: true, actionType: 'list_scheduled', count: scheduled.length, scheduled, message: `${scheduled.length} scheduled change${scheduled.length === 1 ? '' : 's'}${args.characterId ? ' for that character' : ''}${args.includeFired ? ' (incl. fired)' : ''}` };
}

async function handleCancelScheduled(args: z.infer<typeof CancelScheduledSchema>): Promise<object> {
    const { db } = ensureDb();
    ensureScheduleTable(db);
    const row = db.prepare('SELECT * FROM scheduled_state_changes WHERE id = ?').get(args.scheduleId) as ScheduleRow | undefined;
    if (!row) return { error: true, actionType: 'cancel_scheduled', message: `No scheduled change with id ${args.scheduleId}` };
    if (row.fired === 1) return { error: true, actionType: 'cancel_scheduled', message: `Scheduled change ${args.scheduleId} already fired at ${row.fired_at} — fired clocks cannot be cancelled; write a correcting clock instead` };
    db.prepare('DELETE FROM scheduled_state_changes WHERE id = ?').run(args.scheduleId);
    return { success: true, actionType: 'cancel_scheduled', scheduleId: args.scheduleId, note: row.note, firesAtDay: row.fires_at_day, message: `Cancelled scheduled change ${args.scheduleId}${row.note ? ` (${row.note})` : ''} — was due Day ${row.fires_at_day}` };
}

async function handleAddXp(args: z.infer<typeof AddXpSchema>): Promise<object> {
    const { characterRepo } = ensureDb();
    const char = characterRepo.findById(args.characterId);

    if (!char) {
        throw new Error(`Character ${args.characterId} not found`);
    }

    const currentXp = char.xp ?? 0;
    const newXp = Math.max(0, currentXp + args.amount);   // Findings #43: corrections floor at 0
    const currentLevel = char.level;
    const nextLevelXp = XP_TABLE[currentLevel + 1];
    const canLevelUp = nextLevelXp !== undefined && newXp >= nextLevelXp;

    characterRepo.update(char.id, { xp: newXp });

    return {
        characterId: char.id,
        name: char.name,
        oldXp: currentXp,
        newXp,
        level: currentLevel,
        canLevelUp,
        nextLevelXp: nextLevelXp || null,
        message: canLevelUp
            ? `Added ${args.amount} XP. Total: ${newXp}. LEVEL UP AVAILABLE for Level ${currentLevel + 1}!`
            : `Added ${args.amount} XP. Total: ${newXp}.`
    };
}

async function handleGetProgression(args: z.infer<typeof GetProgressionSchema>): Promise<object> {
    // Findings #35: character mode — the tool was a static table lookup that
    // required an undocumented level and ignored characterId entirely.
    if (args.characterId && args.level === undefined) {
        const { characterRepo } = ensureDb();
        const char = characterRepo.findById(args.characterId);
        if (!char) throw new Error(`Character ${args.characterId} not found`);
        const lvl = (char as { level: number }).level;
        const xp = (char as { xp?: number }).xp ?? 0;
        const nextXp = lvl >= 20 ? null : XP_TABLE[lvl + 1];
        return {
            characterId: args.characterId,
            name: char.name,
            level: lvl,
            xp,
            xpForNextLevel: nextXp,
            xpToNext: nextXp === null ? null : Math.max(0, nextXp - xp),
            readyToLevel: nextXp !== null && xp >= nextXp
        };
    }
    if (args.level === undefined) {
        throw new Error('Pass characterId (character mode) or level (table mode)');
    }
    const level = args.level;

    if (level >= 20) {
        return {
            level: 20,
            maxLevel: true,
            xpForCurrentLevel: XP_TABLE[20]
        };
    }

    const currentXpBase = XP_TABLE[level];
    const nextLevelXp = XP_TABLE[level + 1];

    return {
        level,
        xpRequiredForLevel: currentXpBase,
        xpForNextLevel: nextLevelXp,
        xpToNext: nextLevelXp - currentXpBase
    };
}

async function handleLevelUp(args: z.infer<typeof LevelUpSchema>): Promise<object> {
    const { characterRepo } = ensureDb();
    const char = characterRepo.findById(args.characterId);

    if (!char) {
        throw new Error(`Character ${args.characterId} not found`);
    }

    const currentLevel = char.level;
    const targetLevel = args.targetLevel || (currentLevel + 1);

    if (targetLevel <= currentLevel) {
        throw new Error(`Target level ${targetLevel} must be greater than current level ${currentLevel}`);
    }

    const levelsGained = targetLevel - currentLevel;
    const hpRule = levelUpHitPointRule(char, levelsGained);
    // Omitted HP uses the engine's deterministic average progression. Treat an
    // explicit zero the same way: zero is not a legal ordinary D&D level-up
    // increment, and silently persisting it was the defect this action exposed.
    const hpIncrease = args.hpIncrease && args.hpIncrease > 0
        ? args.hpIncrease
        : hpRule.hpIncrease;
    const hpProvenance = args.hpIncrease && args.hpIncrease > 0
        ? { mode: 'explicit' as const, levelsGained, hpIncrease }
        : hpRule;
    const updates: Record<string, unknown> = {
        level: targetLevel,
        maxHp: (char.maxHp || 0) + hpIncrease,
        hp: (char.hp || 0) + hpIncrease,
    };

    // Recompute spell slots for the new level. Without this, level_up would
    // not grant the new caster slots a player earned with the level. Mirrors
    // the create-time path through convertSpellSlotsToObject.
    const className = char.characterClass;
    if (className && isSpellcaster(className)) {
        const slots = getSpellSlots(className, targetLevel);
        const next = convertSpellSlotsToObject(slots);
        if (next) updates.spellSlots = next;
    }

    characterRepo.update(char.id, updates);

    return {
        characterId: char.id,
        name: char.name,
        oldLevel: currentLevel,
        newLevel: targetLevel,
        hpIncrease,
        hpProvenance,
        newMaxHp: updates.maxHp ?? char.maxHp,
        spellSlots: updates.spellSlots,
        message: `Leveled up to ${targetLevel}!`
    };
}

async function handleOptions(args: z.infer<typeof OptionsSchema>): Promise<object> {
    const catalog = getOpen5eCharacterOptions(args.category as CharacterOptionCategory, args.query);
    // #67-D: provisioning classes read from CLASS_DATA — single source, never
    // a hardcoded list. PC-gate rule stated where the caller will see it.
    const provisioningClasses = Object.entries(CLASS_DATA).map(([key, d]) => ({
        class: key,
        hitDie: (d as { hitDie?: number }).hitDie,
        spellcaster: isSpellcaster(key)
    }));
    return {
        ...catalog,
        provisioningClasses,
        provisioningRule: "Kit key goes in class:, never background:. Provisioning fires ONLY for characterType 'pc' or omitted (PC-gate). Companions: create with class set + characterType OMITTED, then update characterType."
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<CharacterAction, ActionDefinition> = {
    create: {
        schema: CreateSchema,
        handler: handleCreate,
        aliases: ['new', 'add', 'spawn'],
        description: 'Create a new character'
    },
    get: {
        schema: GetSchema,
        handler: handleGet,
        aliases: ['fetch', 'find', 'retrieve'],
        description: 'Get character by ID'
    },
    update: {
        schema: UpdateSchema,
        handler: handleUpdate,
        aliases: ['modify', 'edit', 'set'],
        description: 'Update character properties'
    },
    list: {
        schema: ListSchema,
        handler: handleList,
        aliases: ['all', 'query', 'search'],
        description: 'List all characters'
    },
    delete: {
        schema: DeleteSchema,
        handler: handleDelete,
        aliases: ['remove', 'destroy'],
        description: 'Delete a character'
    },
    kill: {
        schema: KillSchema,
        handler: handleKill,
        aliases: ['die', 'slay', 'dead'],
        description: '#67: Death as an event — HP to 0, defeated flag, concentration broken, corpse row auto-created (createCorpse:false for deaths without a body)'
    },
    adjust_pool: {
        schema: AdjustPoolSchema,
        handler: handleAdjustPool,
        aliases: ['pool', 'pool_delta'],
        description: 'Adjust a named resource pool by a delta (rads, composure, heat...) with 0..max clamping'
    },
    schedule_change: {
        schema: ScheduleChangeSchema,
        handler: handleScheduleChange,
        aliases: ['schedule', 'mend', 'schedule_write'],
        description: 'FINDINGS #60 MEND CLOCK: schedule state changes (pools, hp, maxHp, conditions) to fire at an in-fiction day — the boot executes them instead of a chair remembering them'
    },
    process_scheduled: {
        schema: ProcessScheduledSchema,
        handler: handleProcessScheduled,
        aliases: ['advance_clock', 'boot_clock', 'process_clock'],
        description: 'FINDINGS #60 MEND CLOCK boot processor: apply and report every unfired change due at/before the given in-fiction day'
    },
    list_scheduled: {
        schema: ListScheduledSchema,
        handler: handleListScheduled,
        aliases: ['scheduled', 'clocks'],
        description: 'List scheduled state changes (unfired by default)'
    },
    cancel_scheduled: {
        schema: CancelScheduledSchema,
        handler: handleCancelScheduled,
        aliases: ['unschedule', 'cancel_clock'],
        description: 'Cancel an unfired scheduled change by id (surgical care re-clocks a wound)'
    },
    scope_scheduled: {
        schema: z.object({
            action: z.literal('scope_scheduled'),
            worldId: z.string().describe('World to stamp onto unscoped rows'),
            scheduleId: z.number().int().optional().describe('Scope ONE row by id instead of all unscoped')
        }),
        handler: async (args: { action: 'scope_scheduled'; worldId: string; scheduleId?: number }) => {
            const { db } = ensureDb();
            ensureScheduleTable(db);
            // FINDINGS #91: the claim verb — legacy rows predate world scoping;
            // this stamps them ONCE, explicitly, counts from the store. Run it
            // for the elder campaign BEFORE a second world seeds its first clock.
            const r = args.scheduleId !== undefined
                ? db.prepare('UPDATE scheduled_state_changes SET world_id = ? WHERE id = ? AND world_id IS NULL').run(args.worldId, args.scheduleId)
                : db.prepare('UPDATE scheduled_state_changes SET world_id = ? WHERE world_id IS NULL').run(args.worldId);
            return {
                success: true,
                actionType: 'scope_scheduled',
                worldId: args.worldId,
                ...(args.scheduleId !== undefined ? { scheduleId: args.scheduleId } : {}),
                rowsScoped: r.changes,
                message: r.changes === 0
                    ? `No unscoped rows${args.scheduleId !== undefined ? ` matching id ${args.scheduleId}` : ''} — nothing stamped (already scoped rows are never restamped).`
                    : `${r.changes} row(s) stamped to world ${args.worldId}. Boot calls for this world should now pass worldId on process_scheduled.`
            };
        },
        aliases: ['claim_scheduled', 'stamp_scheduled'],
        description: 'FINDINGS #91: stamp unscoped scheduler rows with a worldId — the one-time migration verb for multi-world dbs. Never restamps an already-scoped row'
    },
    scope_characters: {
        schema: z.object({
            action: z.literal('scope_characters'),
            worldId: z.string().describe('The world claiming the rows'),
            characterIds: z.array(z.string()).optional().describe('Explicit character ids to claim'),
            viaParties: z.boolean().optional().describe('Auto-claim every member of every party already tagged to this world (the join does the work)'),
            preview: z.boolean().optional().describe('Report the would-be claims and refusals, write NOTHING')
        }),
        handler: async (args: { action: 'scope_characters'; worldId: string; characterIds?: string[]; viaParties?: boolean; preview?: boolean }) => {
            const { db } = ensureDb();
            // FINDINGS #105: the characters claim verb. UNLIKE scope_scheduled
            // there is NO claim-all lane — four campaigns of legacy rows share
            // this table, and a blanket stamp is the #100 bug wearing a
            // migration's coat. Claims come from explicit ids or the party
            // join; rows owned by ANOTHER world are REFUSED by name, never
            // stolen; already-claimed-here rows are counted as noops.
            try { db.exec('ALTER TABLE characters ADD COLUMN world_id TEXT'); } catch { /* exists */ }
            if (!args.characterIds?.length && !args.viaParties) {
                return { error: true, actionType: 'scope_characters', writes: 'none', message: 'Refused: pass characterIds and/or viaParties:true — there is deliberately no claim-all lane for characters (#105; four campaigns share this table).' };
            }
            const wanted = new Set<string>(args.characterIds ?? []);
            if (args.viaParties) {
                try {
                    const rows = db.prepare('SELECT DISTINCT pm.character_id AS id FROM party_members pm JOIN parties p ON pm.party_id = p.id WHERE p.world_id = ?').all(args.worldId) as Array<{ id: string }>;
                    for (const r of rows) wanted.add(r.id);
                } catch { /* parties table lacks world_id on this db — explicit ids still work */ }
            }
            const claims: string[] = []; const noops: string[] = []; const refusedOtherWorld: Array<{ id: string; name: string; ownedBy: string }> = []; const missing: string[] = [];
            for (const id of wanted) {
                const row = db.prepare('SELECT id, name, world_id FROM characters WHERE id = ?').get(id) as { id: string; name: string; world_id: string | null } | undefined;
                if (!row) { missing.push(id); continue; }
                if (row.world_id === args.worldId) { noops.push(row.name); continue; }
                if (row.world_id) { refusedOtherWorld.push({ id: row.id, name: row.name, ownedBy: row.world_id }); continue; }
                claims.push(id);
            }
            let stamped = 0;
            if (!args.preview && claims.length) {
                const stmt = db.prepare('UPDATE characters SET world_id = ? WHERE id = ? AND world_id IS NULL');
                for (const id of claims) stamped += stmt.run(args.worldId, id).changes;
            }
            return {
                success: true,
                actionType: 'scope_characters',
                worldId: args.worldId,
                preview: !!args.preview,
                candidates: wanted.size,
                ...(args.preview ? { wouldClaim: claims.length } : { rowsScoped: stamped }),
                alreadyThisWorld: noops.length,
                ...(refusedOtherWorld.length ? { refusedOtherWorld } : {}),
                ...(missing.length ? { missingIds: missing } : {}),
                message: args.preview
                    ? `PREVIEW — would claim ${claims.length} of ${wanted.size} candidate(s) for ${args.worldId}; ${noops.length} already claimed here; ${refusedOtherWorld.length} owned by another world (refused); ${missing.length} missing. Nothing written.`
                    : `${stamped} row(s) claimed for ${args.worldId}; ${noops.length} already here; ${refusedOtherWorld.length} owned by another world (REFUSED by name — never stolen); ${missing.length} missing id(s).`
            };
        },
        aliases: ['claim_characters', 'stamp_characters'],
        description: 'FINDINGS #105: claim legacy character rows into a world — explicit ids and/or the party join. No claim-all lane by design; rows owned by another world are refused by name'
    },
    get_status_block: {
        schema: GetStatusBlockSchema,
        handler: handleGetStatusBlock,
        aliases: ['status_block', 'status', 'sostoyanie'],
        description: 'FINDINGS #64: the 00-schema status block from reads — HP, dosimeter, composure, weapon condition, wounds, effects, RU, world clock. Psi structurally absent.'
    },
    add_xp: {
        schema: AddXpSchema,
        handler: handleAddXp,
        aliases: ['xp', 'award_xp', 'grant_xp'],
        description: 'Add XP to a character'
    },
    get_progression: {
        schema: GetProgressionSchema,
        handler: handleGetProgression,
        aliases: ['progression', 'xp_table', 'level_info'],
        description: 'Get XP requirements for a level'
    },
    level_up: {
        schema: LevelUpSchema,
        handler: handleLevelUp,
        aliases: ['levelup', 'advance'],
        description: 'Level up a character'
    },
    options: {
        schema: OptionsSchema,
        handler: handleOptions,
        aliases: ['creation_options', 'catalog', 'classes'],
        description: 'Read pinned SRD character-creation options and exact mechanics, plus every provisioning class from CLASS_DATA (#67-D) with the PC-gate rule'
    }
};

const router = createActionRouter({
    actions: ACTIONS,
    definitions,
    threshold: 0.6
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEFINITION & HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export const CharacterManageTool = {
    name: 'character_manage',
    description: `Manage characters and progression.

👤 CHARACTER LIFECYCLE:
1. create - Define character with class/race/stats (auto-provisions equipment)
2. options - Read pinned SRD classes, species, backgrounds, skills, languages, or alignments
3. get/update - View or modify properties
4. add_xp/level_up - Advance character progression

⚔️ FOR COMBAT:
- Characters need HP, AC, stats for combat participation
- Use combat_manage to add characters to encounters

📦 EQUIPMENT NOTE:
- provisionEquipment: true (default) auto-grants starting equipment
- For custom items, create with item_manage first, then use inventory_manage

✨ SPELLCASTING:
- cantripsKnown, knownSpells, and preparedSpells are durable character fields.
- Bard, Ranger, Sorcerer, and Warlock cast leveled spells from knownSpells; daily preparation is not used.
- Cleric, Druid, and Paladin cast leveled spells from preparedSpells.
- Wizards keep leveled spells in knownSpells as their spellbook and cast only preparedSpells.
- Class and level determine available spell levels and slot progression; spell casting validates the saved choices and consumes the authoritative slots.
- Use character_manage.update to change a character's durable spell choices. Do not invent spell names, slots, or class progression.

Actions: ${ACTIONS.join(', ')}
Aliases: new/add/spawn->create, fetch/find->get, modify/edit->update`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        // #67 mirror law: kill params.
        cause: z.string().optional().describe('kill: what killed it — canon for the wall map'),
        createCorpse: z.boolean().optional().describe('kill: false = death without a body (default true)'),
        encounterId: z.string().optional().describe('kill: encounter the corpse lands in'),
        position: z.object({ x: z.number(), y: z.number() }).optional().describe('kill: corpse position'),
        worldId: z.string().optional().describe('kill: world for the corpse row'),
        currency: z.record(z.number()).optional().describe('kill: currency on the corpse (e.g. {gold: 150})'),
        // Create fields
        name: z.string().optional(),
        class: z.string().optional(),
        race: z.string().optional(),
        background: z.string().optional(),
        alignment: z.string().optional(),
        origin: CharacterOriginSchema.optional(),
        stats: StatsSchema.optional(),
        hp: z.number().int().optional(),
        maxHp: z.number().int().optional(),
        ac: z.number().int().optional(),
        level: z.number().int().min(1).max(20).optional().describe('Character level from 1 through 20'),
        xp: z.number().optional().describe('Absolute XP set (update) — Findings #43'),
        characterType: CharacterTypeSchema.optional(),
        factionId: z.string().optional(),
        behavior: z.string().optional(),
        cantripsKnown: z.array(z.string()).optional().describe('Persisted cantrips the character knows'),
        knownSpells: z.array(z.string()).optional().describe('Persisted known spells; for Wizards this is the spellbook'),
        preparedSpells: z.array(z.string()).optional().describe('Persisted leveled spells currently prepared'),
        armorProficiencies: z.array(z.string()).optional(),
        weaponProficiencies: z.array(z.string()).optional(),
        toolProficiencies: z.array(z.string()).optional(),
        languages: z.array(z.string()).optional(),
        applySpeciesAbilityBonuses: z.boolean().optional(),
        resistances: z.array(z.string()).optional(),
        vulnerabilities: z.array(z.string()).optional(),
        immunities: z.array(z.string()).optional(),
        provisionEquipment: z.boolean().optional(),
        customEquipment: z.array(z.string()).optional(),
        startingGold: z.number().int().optional(),
        // Sheet fields (update) — MUST mirror UpdateSchema: this outer schema
        // strips unknown keys, so any param missing here dies silently at the
        // tool boundary (the startingGold no-op's anatomy, mirrored).
        resourcePools: z.record(z.object({
            current: z.number(),
            max: z.number(),
            lastRefilledAt: z.string().optional()
        })).optional(),
        composureSpec: z.record(z.unknown()).optional().describe('FINDINGS #86 (mirror): per-character Composure charge/repair table — {desensitised[], charges{}, repairs{}}; stored verbatim, returned by get, never engine-evaluated'),
        // FINDINGS #88 (mirror law): guard/preview + hour-clock params
        expectName: z.string().optional().describe('update guard: refuse unless the name matches (case-insensitive)'),
        preview: z.boolean().optional().describe('update: return the would-be changes, write NOTHING'),
        characterIds: z.array(z.string()).optional().describe('FINDINGS #105 (mirror): scope_characters — explicit rows to claim'),
        viaParties: z.boolean().optional().describe('FINDINGS #105 (mirror): scope_characters — auto-claim members of parties tagged to this world'),
        reason: z.string().optional().describe('FINDINGS #111 (mirror): adjust_pool — why; stored on the pool history'),
        witnesses: z.array(z.string()).optional().describe('FINDINGS #111 (mirror): adjust_pool — who saw; stored on the pool history'),
        firesAtHour: z.number().optional().describe('schedule_change: hour of the fires-at day (0–24)'),
        firesInHours: z.number().optional().describe('schedule_change: fires N hours from currentDay(+currentTime)'),
        limit: z.number().int().optional().describe('list #93: cap returned rows'),
        currentTime: z.string().optional().describe('schedule_change/process_scheduled: HH:MM — fractionalizes the day'),
        skillProficiencies: z.array(z.string()).optional(),
        saveProficiencies: z.array(z.string()).optional(),
        expertise: z.array(z.string()).optional(),
        perceptionBonus: z.number().int().optional().describe('RENAMED (#95): use perceptionOverride — REFUSES loudly'),
        stealthBonus: z.number().int().optional().describe('RENAMED (#95): use stealthOverride — REFUSES loudly'),
        perceptionOverride: z.number().int().optional().describe('#95 R4a: OVERRIDES composed WIS+prof in the eavesdrop layer — does not add'),
        stealthOverride: z.number().int().optional().describe('#95 R4a: OVERRIDES composed DEX+prof in the eavesdrop layer — does not add'),
        // adjust_pool fields
        pool: z.string().optional(),
        removePool: z.boolean().optional().describe('Delete the pool entirely (adjust_pool)'),
        delta: z.number().optional(),
        value: z.number().optional().describe('adjust_pool #67-F: ABSOLUTE set (retry-safe) — mutually exclusive with delta'),
        max: z.number().optional(),
        // Get/Update/Delete fields
        characterId: z.string().optional(),
        // Update condition fields
        conditions: z.array(conditionSchema()).optional(),
        addConditions: z.array(conditionSchema()).optional(),
        removeConditions: z.array(z.string()).optional(),
        // Add XP field
        amount: z.number().int().optional(),
        // FINDINGS #60 (mirror law): MEND CLOCK params — absent here means
        // stripped in every session; outer and inner must agree.
        firesAtDay: z.number().optional().describe('MEND CLOCK: in-fiction day the change fires (schedule_change)'),
        recurEveryDays: z.number().optional().describe('FINDINGS #69 (mirror): recurring clock — re-arms at +N days after each fire; process_scheduled catches up missed recurrences individually'),
        fireNow: z.boolean().optional().describe('FINDINGS #73 (mirror): fire the entry immediately in the same call — ledger one-off, applied[] reported'),
        event: z.boolean().optional().describe('FINDINGS #82 (mirror): GM EVENT — a clock that fires a notification instead of writes; empty writes allowed with this flag'),
        writes: z.preprocess(mendJsonIfString, z.array(ScheduledWriteOpSchema)).optional().describe('MEND CLOCK: ordered ops (schedule_change). ARRAY — direct calls only per batch law #16a'),
        note: z.string().optional().describe('MEND CLOCK: what this clock is (schedule_change)'),
        currentDay: z.number().optional().describe('MEND CLOCK: current in-fiction day (process_scheduled)'),
        scheduleId: z.number().optional().describe('MEND CLOCK: row id (cancel_scheduled)'),
        includeFired: z.boolean().optional().describe('MEND CLOCK: include fired rows (list_scheduled)'),
        // Level up fields
        hpIncrease: z.number().int().optional(),
        targetLevel: z.number().int().optional(),
        nativeToBastion: z.boolean().optional(),
        sourceUniverse: z.string().optional(),
        category: OptionCategorySchema.optional(),
        query: z.string().optional()
    })
};

export async function handleCharacterManage(args: unknown, _ctx: SessionContext): Promise<McpResponse> {
    const response = await router(args as Record<string, unknown>);

    // Parse the JSON response to add ASCII formatting
    try {
        const jsonText = response.content[0]?.text;
        if (!jsonText) return response;

        const data = JSON.parse(jsonText);
        const action = (args as Record<string, unknown>).action as string;

        let output = '';

        // Check for any error type (boolean true or string error codes)
        const hasError = data.error === true || typeof data.error === 'string';

        if (hasError) {
            output = RichFormatter.header('Character Error', '❌');
            output += RichFormatter.alert(data.message || 'Unknown error', 'error');
            if (data.issues) {
                output += RichFormatter.section('Validation Issues');
                output += RichFormatter.list(data.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`));
            }
            if (data.suggestions) {
                output += RichFormatter.section('Suggestions');
                output += RichFormatter.list(data.suggestions.map((s: string | { value: string; similarity: number }) =>
                    typeof s === 'string' ? s : `${s.value} (${Math.round(s.similarity * 100)}%)`
                ));
            }
        } else if (action === 'options' || action === 'creation_options' || action === 'catalog' || action === 'classes') {
            output = RichFormatter.header('Character Creation Options', 'ðŸ“š');
            output += RichFormatter.keyValue({
                'Rules': data.provenance?.rulesVersion,
                'Classes': data.classes?.length ?? 0,
                'Species': data.species?.length ?? 0,
                'Backgrounds': data.backgrounds?.length ?? 0,
                'Skills': data.skills?.length ?? 0,
                'Languages': data.languages?.length ?? 0,
                'Alignments': data.alignments?.length ?? 0
            });
            output += RichFormatter.alert('Custom options remain supported; listed options carry pinned SRD mechanics.', 'info');
            if (data.provisioningClasses?.length) {
                output += RichFormatter.section('Provisioning Classes');
                output += RichFormatter.list(data.provisioningClasses.map((c: { class: string; hitDie?: number; spellcaster?: boolean }) => `${c.class} (d${c.hitDie ?? '?'}${c.spellcaster ? ', caster' : ''})`));
                output += RichFormatter.alert(String(data.provisioningRule), 'info');
            }
        } else if (action === 'create' || action === 'new' || action === 'add' || action === 'spawn') {
            output = RichFormatter.header(`Character Created: ${data.name}`, '👤');
            output += RichFormatter.keyValue({
                'ID': data.id,
                'Name': data.name,
                'Race': data.race || 'Unknown',
                'Class': data.characterClass || 'Adventurer',
                'Level': data.level || 1,
                'Type': data.characterType || 'pc'
            });
            output += RichFormatter.section('Stats');
            if (data.stats) {
                const stats = data.stats;
                output += `STR: ${stats.str} | DEX: ${stats.dex} | CON: ${stats.con}\n`;
                output += `INT: ${stats.int} | WIS: ${stats.wis} | CHA: ${stats.cha}\n`;
            }
            output += RichFormatter.section('Combat');
            output += RichFormatter.keyValue({
                'HP': `${data.hp}/${data.maxHp}`,
                'AC': data.ac || 10
            });
            if (data._provisioning) {
                output += RichFormatter.section('Starting Equipment');
                if (data._provisioning.equipmentGranted?.length) {
                    output += RichFormatter.list(data._provisioning.equipmentGranted);
                }
                if (data._provisioning.spellsGranted?.length) {
                    output += `Spells: ${data._provisioning.spellsGranted.join(', ')}\n`;
                }
            }
        } else if (action === 'get' || action === 'fetch' || action === 'find') {
            output = RichFormatter.header(`${data.name}`, '👤');
            output += RichFormatter.keyValue({
                'ID': data.id,
                'Race': data.race || 'Unknown',
                'Class': data.characterClass || 'Adventurer',
                'Level': data.level || 1,
                'XP': data.xp || 0,
                'Type': data.characterType || 'pc'
            });
            output += RichFormatter.section('Stats');
            if (data.stats) {
                const stats = data.stats;
                output += `STR: ${stats.str} | DEX: ${stats.dex} | CON: ${stats.con}\n`;
                output += `INT: ${stats.int} | WIS: ${stats.wis} | CHA: ${stats.cha}\n`;
            }
            output += RichFormatter.section('Combat');
            output += RichFormatter.keyValue({
                'HP': `${data.hp}/${data.maxHp}`,
                'AC': data.ac || 10,
                // Findings #35: banner AND JSON, always.
                ...(data.currency ? { 'RU': data.currency.gold ?? 0 } : {})
            });
            if (data.conditions?.length) {
                output += RichFormatter.section('Conditions');
                output += RichFormatter.list(data.conditions.map((c: string | { name: string }) => typeof c === 'string' ? c : c.name));
            }
            if (data.lastWrites?.length) {
                output += RichFormatter.section('Recent Writes');
                data.lastWrites.slice(0, 4).forEach((w: { field: string; oldValue: string; newValue: string; source: string }) => {
                    output += `• ${w.field}: ${w.oldValue} → ${w.newValue} (${w.source})\n`;
                });
            }
        } else if (action === 'list' || action === 'all' || action === 'query') {
            output = RichFormatter.header(`Characters (${data.count})`, '👥');
            if (data.filter && data.filter !== 'all') {
                output += `*Filtered by: ${data.filter}*\n\n`;
            }
            if (data.characters?.length) {
                const rows = data.characters.map((c: { name: string; characterClass?: string; level?: number; hp: number; maxHp: number; characterType?: string }) => [
                    c.name,
                    c.characterClass || 'Adventurer',
                    `Lv${c.level || 1}`,
                    `${c.hp}/${c.maxHp}`,
                    c.characterType || 'pc'
                ]);
                output += RichFormatter.table(['Name', 'Class', 'Level', 'HP', 'Type'], rows);
            } else {
                output += '*No characters found*\n';
            }
        } else if (action === 'update' || action === 'modify' || action === 'edit') {
            output = RichFormatter.header(`Character Updated: ${data.name}`, '✏️');
            output += data.message + '\n';
        } else if (action === 'delete' || action === 'remove') {
            output = RichFormatter.header('Character Deleted', '🗑️');
            output += `ID: ${data.characterId}\n`;
        } else if (action === 'add_xp' || action === 'xp') {
            output = RichFormatter.header(`XP Added: ${data.name}`, '⭐');
            output += RichFormatter.keyValue({
                'Previous XP': data.oldXp,
                'Added': data.newXp - data.oldXp,
                'Total XP': data.newXp,
                'Current Level': data.level
            });
            if (data.canLevelUp) {
                output += RichFormatter.alert('LEVEL UP AVAILABLE!', 'success');
            } else if (data.nextLevelXp) {
                output += `*${data.nextLevelXp - data.newXp} XP until Level ${data.level + 1}*\n`;
            }
        } else if (action === 'get_progression' || action === 'progression') {
            // Findings #35: character mode has its own banner — the table-mode
            // keys printed undefined and made characterId look ignored.
            if (data.characterId) {
                output = RichFormatter.header(`${data.name} — Level ${data.level}`, '📊');
                output += RichFormatter.keyValue({
                    'XP': data.xp,
                    'Next level at': data.xpForNextLevel ?? 'MAX',
                    'XP to next': data.xpToNext ?? '—'
                });
                if (data.readyToLevel) output += RichFormatter.alert('LEVEL UP AVAILABLE!', 'success');
            } else if (data.maxLevel) {
                output = RichFormatter.header(`Level ${data.level} Progression`, '📊');
                output += '*Maximum level reached!*\n';
            } else {
                output = RichFormatter.header(`Level ${data.level} Progression`, '📊');
                output += RichFormatter.keyValue({
                    'XP for this level': data.xpRequiredForLevel,
                    'XP for next level': data.xpForNextLevel,
                    'XP needed': data.xpToNext
                });
            }
        } else if (action === 'level_up' || action === 'levelup') {
            output = RichFormatter.header(`${data.name} Leveled Up!`, '🎉');
            output += RichFormatter.keyValue({
                'Previous Level': data.oldLevel,
                'New Level': data.newLevel,
                'HP Increase': data.hpIncrease || 0,
                'New Max HP': data.newMaxHp
            });
        } else if (data.actionType === 'get_status_block') {
            // FINDINGS #64: СОСТОЯНИЕ — strip + block, every value from a read.
            output = pda.renderStatusBlock(data as Parameters<typeof pda.renderStatusBlock>[0]);
        } else if (data.actionType === 'adjust_pool') {
            // FINDINGS #62: ЖУРНАЛ via the PDA kernel — the psi guard lives at
            // renderPoolLine, not here. Hidden pools render as 'entry accepted'.
            output = data.removed !== undefined
                ? pda.renderDefault(data)
                : pda.renderLedger(data);
        } else if (data.actionType === 'schedule_change') {
            output = RichFormatter.header('Mend Clock — Scheduled', '⏳');
            output += `${data.message}\n`;
        } else if (data.actionType === 'process_scheduled') {
            // FINDINGS #63 (PDA Wave B): ЧАСЫ — the boot voice in rail; the psi
            // guard on applied strings lives in renderClock.
            output = pda.renderClock(data as Parameters<typeof pda.renderClock>[0]);
        } else if (data.actionType === 'list_scheduled') {
            output = RichFormatter.header(`Mend Clock — ${data.count} scheduled`, '⏳');
            const rows = data.scheduled as Array<{ scheduleId: number; characterName?: string; firesAtDay: number; ops: number; note: string | null; fired: boolean }> | undefined;
            if (rows?.length) {
                for (const r of rows) output += `• #${r.scheduleId} — Day ${r.firesAtDay} — ${r.characterName ?? '(deleted)'}${r.note ? `: ${r.note}` : ''} (${r.ops} op${r.ops === 1 ? '' : 's'})${r.fired ? ' [FIRED]' : ''}\n`;
            } else {
                output += '*Nothing scheduled*\n';
            }
        } else if (data.actionType === 'cancel_scheduled') {
            output = RichFormatter.header('Mend Clock — Cancelled', '⏳');
            output += `${data.message}\n`;
        } else {
            // Fallback for unknown actions
            output = RichFormatter.header('Character Operation', '👤');
            output += JSON.stringify(data, null, 2) + '\n';
        }

        // Embed JSON for programmatic access
        output += RichFormatter.embedJson(data, 'CHARACTER_MANAGE');

        return { content: [{ type: 'text', text: output }] };
    } catch {
        // If JSON parsing fails, return original response
        return response;
    }
}
