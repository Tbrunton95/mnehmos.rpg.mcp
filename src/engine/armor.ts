/**
 * Armour (play report 5 #7, #8b).
 *
 * One reader for every spelling an armour template has carried: the engine's
 * `baseAC`, the starter kit's legacy `ac`, the SRD catalog's `armorCategory`
 * and `addDexterityModifier`, and the GM's own `baseAc` / `base_ac` /
 * `maxDex` / `armorType`. Keys are matched case- and underscore-insensitively,
 * so a row already stored with `baseAc` works without an update; item_manage
 * rewrites the aliases to the canonical keys on the way in.
 *
 * The DEX cap comes from the written cap first, else from the category (heavy:
 * none; medium: 2; light: full), else from the legacy heavy-armour tell (a
 * Strength requirement with no cap). An armour-slot item with no readable base
 * is a warning that prints the fix, never a silent fall back to unarmoured.
 *
 * #8b: natural armour (`combat_profile.naturalArmor`) is the floor: unarmoured
 * is the higher of 10 + DEX and base + DEX; worn armour must beat it. Shields
 * and every other equipped acBonus add on top of whichever wins.
 */
import type Database from 'better-sqlite3';
import { similarity } from '../utils/fuzzy-enum.js';

export const ARMOR_CATEGORIES = ['light', 'medium', 'heavy', 'shield'] as const;
export type ArmorCategory = typeof ARMOR_CATEGORIES[number];

/** The canonical armour keys item_manage writes and deriveArmorClass reads. */
export const ARMOR_CANONICAL_KEYS = ['baseAC', 'armorCategory', 'maxDexBonus', 'strengthRequired', 'stealthDisadvantage', 'acBonus'] as const;
export type ArmorKey = typeof ARMOR_CANONICAL_KEYS[number];

/** Spellings, normalised (lower case, no underscores, spaces or hyphens), to the canonical key. */
const ALIASES: Record<string, ArmorKey> = {
    baseac: 'baseAC', ac: 'baseAC', armorclass: 'baseAC', armourclass: 'baseAC', basearmorclass: 'baseAC', basearmourclass: 'baseAC',
    maxdexbonus: 'maxDexBonus', maxdex: 'maxDexBonus', maxdexmod: 'maxDexBonus', maxdexmodifier: 'maxDexBonus', dexcap: 'maxDexBonus', dexmax: 'maxDexBonus',
    armorcategory: 'armorCategory', armourcategory: 'armorCategory', category: 'armorCategory', armortype: 'armorCategory', armourtype: 'armorCategory',
    strengthrequired: 'strengthRequired', strrequired: 'strengthRequired', strreq: 'strengthRequired', minstr: 'strengthRequired', minstrength: 'strengthRequired',
    strengthrequirement: 'strengthRequired', requiredstrength: 'strengthRequired',
    stealthdisadvantage: 'stealthDisadvantage', stealthdisadv: 'stealthDisadvantage', stealthpenalty: 'stealthDisadvantage',
    acbonus: 'acBonus', bonusac: 'acBonus', armorbonus: 'acBonus', armourbonus: 'acBonus'
};

/** Keys kept in place when canonicalising: SRD catalog fields other readers expect. Mirrored, never renamed. */
const KEEP_IN_PLACE = new Set(['ac', 'category']);

/** The keys whose presence marks a property set as armour (a bare `ac` or `category` alone does not). */
const DEFINITE_ARMOR_KEYS = new Set<ArmorKey>(['baseAC', 'armorCategory', 'maxDexBonus', 'strengthRequired', 'stealthDisadvantage']);

const normKey = (k: string) => k.toLowerCase().replace(/[_\s-]/g, '');

export interface ArmorProps {
    baseAC?: number;
    armorCategory?: ArmorCategory;
    maxDexBonus?: number;
    strengthRequired?: number;
    stealthDisadvantage?: boolean;
    acBonus?: number;
    /** false when the template says the armour adds no DEX (the SRD's addDexterityModifier). */
    addDex?: boolean;
    /** Alias spellings found on the row, by the canonical key each stood for. */
    aliased: Record<string, string>;
}

function asNumber(v: unknown): number | undefined {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return undefined;
}

function asBoolean(v: unknown): boolean | undefined {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true' || s === 'yes') return true;
        if (s === 'false' || s === 'no') return false;
    }
    return undefined;
}

function asCategory(v: unknown): ArmorCategory | undefined {
    if (typeof v !== 'string') return undefined;
    const s = v.trim().toLowerCase();
    return (ARMOR_CATEGORIES as readonly string[]).includes(s) ? s as ArmorCategory : undefined;
}

/** The nearest armour category to a misspelt one, or undefined when nothing is close. */
export function nearestArmorCategory(value: string): ArmorCategory | undefined {
    let best: { cat: ArmorCategory; score: number } | undefined;
    for (const cat of ARMOR_CATEGORIES) {
        const score = similarity(value.toLowerCase(), cat);
        if (!best || score > best.score) best = { cat, score };
    }
    return best && best.score >= 0.5 ? best.cat : undefined;
}

/**
 * Read the armour keys off a property set, whatever their spelling. A
 * canonical key wins over an alias of the same thing (baseAC over ac); an
 * SRD `category: 'Armor'` is not a category and is ignored.
 */
export function readArmorProps(props: Record<string, unknown> | null | undefined): ArmorProps {
    const out: ArmorProps = { aliased: {} };
    const seenCanonical = new Set<ArmorKey>();
    const entries = Object.entries(props ?? {});
    // Canonical spellings first, so an alias never displaces them.
    const ordered = [...entries.filter(([k]) => (ARMOR_CANONICAL_KEYS as readonly string[]).includes(k)), ...entries.filter(([k]) => !(ARMOR_CANONICAL_KEYS as readonly string[]).includes(k))];
    for (const [key, value] of ordered) {
        const canonical = ALIASES[normKey(key)];
        if (!canonical) continue;
        const isCanonical = key === canonical;
        if (seenCanonical.has(canonical)) continue;
        let read = false;
        switch (canonical) {
            case 'baseAC': { const n = asNumber(value); if (n !== undefined) { out.baseAC = n; read = true; } break; }
            case 'maxDexBonus': { const n = asNumber(value); if (n !== undefined) { out.maxDexBonus = n; read = true; } break; }
            case 'strengthRequired': { const n = asNumber(value); if (n !== undefined) { out.strengthRequired = n; read = true; } break; }
            case 'acBonus': { const n = asNumber(value); if (n !== undefined) { out.acBonus = n; read = true; } break; }
            case 'stealthDisadvantage': { const b = asBoolean(value); if (b !== undefined) { out.stealthDisadvantage = b; read = true; } break; }
            case 'armorCategory': {
                const c = asCategory(value);
                // SRD rows write category: 'Armor' | 'Shield' | 'Weapon'...: only a real category counts.
                if (c) { out.armorCategory = c; read = true; }
                break;
            }
        }
        if (!read) continue;
        seenCanonical.add(canonical);
        if (!isCanonical) out.aliased[key] = canonical;
    }
    const addDex = asBoolean((props ?? {}).addDexterityModifier);
    if (addDex !== undefined) out.addDex = addDex;
    return out;
}

/**
 * The DEX cap for a worn armour: the written cap, else the category (heavy 0,
 * medium 2, light full), else the legacy tell (a Strength requirement with no
 * category means heavy). Infinity means the full modifier applies.
 */
export function dexCapFor(p: ArmorProps): number {
    if (typeof p.maxDexBonus === 'number') return p.maxDexBonus;
    if (p.addDex === false) return 0;
    if (p.armorCategory === 'heavy') return 0;
    if (p.armorCategory === 'medium') return 2;
    if (p.armorCategory === 'light') return Infinity;
    if (p.armorCategory === undefined && typeof p.strengthRequired === 'number') return 0;
    return Infinity;
}

/** True when a property set carries a definite armour key (in any spelling). */
export function hasArmorProps(props: Record<string, unknown> | null | undefined): boolean {
    return Object.keys(props ?? {}).some(k => { const c = ALIASES[normKey(k)]; return c !== undefined && DEFINITE_ARMOR_KEYS.has(c); });
}

export interface CanonicalArmorResult {
    properties: Record<string, unknown>;
    aliased: Record<string, string>;
    problems: string[];
}

/**
 * The write-side rewrite (item_manage create/update): alias spellings move to
 * the canonical keys, numbers are checked, a category typo is refused with the
 * nearest name, and two spellings of one key that disagree are refused. `ac`
 * and `category` (SRD catalog fields) stay in place and are mirrored.
 */
export function canonicalArmorProps(props: Record<string, unknown>): CanonicalArmorResult {
    const out: Record<string, unknown> = { ...props };
    const aliased: Record<string, string> = {};
    const problems: string[] = [];
    const firstSpelling: Partial<Record<ArmorKey, { key: string; value: unknown }>> = {};

    const check = (canonical: ArmorKey, key: string, raw: unknown): unknown => {
        switch (canonical) {
            case 'baseAC': case 'maxDexBonus': case 'strengthRequired': {
                const n = asNumber(raw);
                if (n === undefined || !Number.isInteger(n) || n < 0) { problems.push(`${key === canonical ? canonical : `${key} (${canonical})`} must be a non-negative integer, got ${JSON.stringify(raw)}`); return undefined; }
                return n;
            }
            case 'acBonus': {
                const n = asNumber(raw);
                if (n === undefined || !Number.isInteger(n)) { problems.push(`${key === canonical ? canonical : `${key} (${canonical})`} must be an integer, got ${JSON.stringify(raw)}`); return undefined; }
                return n;
            }
            case 'stealthDisadvantage': {
                const b = asBoolean(raw);
                if (b === undefined) { problems.push(`${key} must be true or false, got ${JSON.stringify(raw)}`); return undefined; }
                return b;
            }
            case 'armorCategory': {
                const c = asCategory(raw);
                if (c) return c;
                // category: 'Armor' (SRD) is not a category: leave it alone.
                if (key === 'category') return undefined;
                const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
                const near = typeof raw === 'string' ? nearestArmorCategory(raw) : undefined;
                problems.push(`armorCategory '${text}' is not one of ${ARMOR_CATEGORIES.join(', ')}${near ? ` — nearest is '${near}'` : ''}`);
                return undefined;
            }
        }
    };

    // Canonical spellings first so they own the slot; aliases follow.
    const keys = Object.keys(props);
    const ordered = [...keys.filter(k => (ARMOR_CANONICAL_KEYS as readonly string[]).includes(k)), ...keys.filter(k => !(ARMOR_CANONICAL_KEYS as readonly string[]).includes(k))];
    for (const key of ordered) {
        const canonical = ALIASES[normKey(key)];
        if (!canonical) continue;
        const raw = props[key];
        if (raw === null || raw === undefined) continue;
        const value = check(canonical, key, raw);
        if (value === undefined) continue;
        const first = firstSpelling[canonical];
        if (first && first.value !== value) {
            problems.push(`${first.key} ${JSON.stringify(first.value)} and ${key} ${JSON.stringify(raw)} disagree — pass one of them`);
            continue;
        }
        if (!first) firstSpelling[canonical] = { key, value };
        if (key === canonical) { out[canonical] = value; continue; }
        // An alias: write the canonical key; drop the alias unless it is a catalog field.
        if (!(canonical in out) || out[canonical] === undefined) { out[canonical] = value; aliased[key] = canonical; }
        if (!KEEP_IN_PLACE.has(key)) delete out[key];
    }
    return { properties: out, aliased, problems };
}

/** Where an armour-typed template equips by default: a shield in the offhand, body armour in the armor slot. */
export function defaultArmorSlots(props: Record<string, unknown> | null | undefined): string[] {
    const p = readArmorProps(props);
    if (p.armorCategory === 'shield') return ['offhand'];
    if (p.armorCategory) return ['armor'];
    if (p.baseAC !== undefined) return ['armor'];
    // Legacy heuristic: an acBonus-only armour item is a shield.
    return typeof p.acBonus === 'number' ? ['offhand'] : ['armor'];
}

// ─── Composition ───

export interface NaturalArmor { base: number; addDex?: boolean; maxDex?: number }

export interface ArmorSheet {
    dexMod: number;
    strength?: number;
    naturalArmor?: NaturalArmor | null;
}

export interface EquippedRow {
    slot: string | null;
    itemId?: string;
    name?: string;
    properties?: Record<string, unknown> | null;
}

export interface WornArmorReport {
    item: string;
    itemId?: string;
    category?: ArmorCategory;
    baseAC: number;
    dexApplied: number;
    /** null: the full modifier applies. */
    dexCap: number | null;
    stealthDisadvantage: boolean;
    strengthRequired?: number;
    meetsStrength?: boolean;
    aliased: Record<string, string>;
}

export interface ArmorClassReport {
    ac: number;
    parts: string[];
    warnings: string[];
    armor?: WornArmorReport;
    natural?: { base: number; dexApplied: number; ac: number };
    unreadableArmor?: { item: string; itemId?: string };
}

const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`;

/**
 * The AC from a sheet's DEX, STR and natural armour and its equipped rows.
 * Pure: deriveArmorClass reads the database and calls this.
 */
export function composeArmorClass(sheet: ArmorSheet, equipped: EquippedRow[]): ArmorClassReport {
    const { dexMod } = sheet;
    const warnings: string[] = [];
    let base = 10 + dexMod;
    let baseDesc = `unarmored 10 + DEX ${signed(dexMod)}`;
    let natural: ArmorClassReport['natural'];
    if (sheet.naturalArmor && typeof sheet.naturalArmor.base === 'number') {
        const na = sheet.naturalArmor;
        const cap = na.addDex === false ? 0 : (typeof na.maxDex === 'number' ? na.maxDex : Infinity);
        const dexApplied = cap > 0 ? Math.min(dexMod, cap) : 0;
        natural = { base: na.base, dexApplied, ac: na.base + dexApplied };
        const naturalDesc = `natural armour ${na.base}${cap === 0 ? ' (no DEX)' : cap === Infinity ? ` + DEX ${signed(dexApplied)}` : ` + DEX(max ${cap})`}`;
        if (natural.ac >= base) { base = natural.ac; baseDesc = naturalDesc; }
    }
    const floorDesc = baseDesc;

    let armor: WornArmorReport | undefined;
    let unreadableArmor: ArmorClassReport['unreadableArmor'];
    let bonus = 0;
    const bonusParts: string[] = [];
    for (const row of equipped) {
        const name = row.name ?? row.itemId ?? 'item';
        const p = readArmorProps(row.properties);
        if (row.slot === 'armor' && !armor && !unreadableArmor) {
            if (p.baseAC === undefined) {
                unreadableArmor = { item: name, ...(row.itemId ? { itemId: row.itemId } : {}) };
                const keys = Object.keys(row.properties ?? {});
                const fellBackTo = natural && natural.ac >= 10 + dexMod ? `natural armour ${natural.ac}` : 'unarmoured 10 + DEX';
                warnings.push(`${name} is worn in the armor slot but has no readable baseAC (properties: ${keys.length ? keys.join(', ') : 'none'}) — AC fell back to ${fellBackTo}; fix: item_manage update {itemId: '${row.itemId ?? '<itemId>'}', properties: {baseAC: <n>}, mergeProperties: true}`);
            } else {
                const cap = dexCapFor(p);
                const dexApplied = cap > 0 ? Math.min(dexMod, cap) : 0;
                const wornAc = p.baseAC + dexApplied;
                const wornDesc = `${name} base ${p.baseAC}${cap === 0 ? ' (no DEX)' : cap === Infinity ? ' + DEX' : ` + DEX(max ${cap})`}`;
                const meetsStrength = typeof p.strengthRequired === 'number' && typeof sheet.strength === 'number' ? sheet.strength >= p.strengthRequired : undefined;
                armor = {
                    item: name, ...(row.itemId ? { itemId: row.itemId } : {}),
                    ...(p.armorCategory ? { category: p.armorCategory } : {}),
                    baseAC: p.baseAC, dexApplied, dexCap: cap === Infinity ? null : cap,
                    stealthDisadvantage: p.stealthDisadvantage === true,
                    ...(typeof p.strengthRequired === 'number' ? { strengthRequired: p.strengthRequired } : {}),
                    ...(meetsStrength !== undefined ? { meetsStrength } : {}),
                    aliased: p.aliased
                };
                if (natural) {
                    // #8b: the higher of worn and natural armour.
                    if (wornAc >= natural.ac) { base = wornAc; baseDesc = `${wornDesc} (beats natural armour ${natural.ac})`; }
                    else { base = natural.ac; baseDesc = `${floorDesc} (beats ${name} ${wornAc})`; }
                } else {
                    // Worn armor replaces the unarmored base (5e), even when lower.
                    base = wornAc; baseDesc = wornDesc;
                }
                if (meetsStrength === false) warnings.push(`STR ${sheet.strength} is below the ${p.strengthRequired} ${name} requires: speed -10 ft (5e; not applied)`);
            }
        }
        // acBonus stacks from every equipped item, magic armor included.
        if (typeof p.acBonus === 'number' && p.acBonus !== 0) {
            bonus += p.acBonus;
            bonusParts.push(`${name} ${signed(p.acBonus)}`);
        }
    }
    return {
        ac: base + bonus,
        parts: [baseDesc, ...bonusParts],
        warnings,
        ...(armor ? { armor } : {}),
        ...(natural ? { natural } : {}),
        ...(unreadableArmor ? { unreadableArmor } : {})
    };
}

// ─── Database readers ───

type SheetRow = { stats?: Record<string, number>; naturalArmor?: NaturalArmor | null } | null | undefined;

function readSheet(db: Database.Database, characterId: string): SheetRow {
    try {
        const row = db.prepare('SELECT stats, combat_profile FROM characters WHERE id = ?').get(characterId) as { stats?: string; combat_profile?: string | null } | undefined;
        if (!row) return null;
        const stats = row.stats ? JSON.parse(row.stats) as Record<string, number> : {};
        let naturalArmor: NaturalArmor | null | undefined;
        if (row.combat_profile) {
            try { naturalArmor = (JSON.parse(row.combat_profile) as { naturalArmor?: NaturalArmor }).naturalArmor; } catch { /* ignore */ }
        }
        return { stats, naturalArmor };
    } catch { return null; }
}

/** The character's equipped rows with each template's name and properties. */
export function equippedRows(db: Database.Database, characterId: string): EquippedRow[] {
    try {
        // Body armour first, then the hands, head, feet and accessories: the
        // parts list reads the same whatever order the rows were written in.
        const rows = db.prepare(`SELECT ii.item_id AS itemId, ii.slot AS slot, i.name AS name, i.properties AS properties
            FROM inventory_items ii LEFT JOIN items i ON i.id = ii.item_id
            WHERE ii.character_id = ? AND ii.equipped = 1
            ORDER BY CASE ii.slot WHEN 'armor' THEN 0 WHEN 'offhand' THEN 1 WHEN 'mainhand' THEN 2 WHEN 'head' THEN 3 WHEN 'feet' THEN 4 ELSE 5 END, ii.slot, ii.rowid`).all(characterId) as Array<{ itemId: string; slot: string | null; name: string | null; properties: string | null }>;
        return rows.map(r => {
            let properties: Record<string, unknown> | null = null;
            if (r.properties) { try { properties = JSON.parse(r.properties); } catch { properties = null; } }
            return { slot: r.slot, itemId: r.itemId, name: r.name ?? undefined, properties };
        });
    } catch { return []; }
}

/**
 * FINDINGS #69: ONE armor-class derivation, used by equip AND unequip (and by
 * character_manage when natural armour changes). Armour-slot base + capped
 * DEX, or the higher of that and natural armour, else unarmoured 10 + DEX;
 * PLUS every other equipped item's acBonus (head, offhand shield, accessory).
 */
export function deriveArmorClass(db: Database.Database, characterId: string): ArmorClassReport {
    const sheet = readSheet(db, characterId);
    const stats = sheet?.stats ?? {};
    const dexMod = Math.floor(((stats.dex ?? 10) - 10) / 2);
    return composeArmorClass({ dexMod, strength: typeof stats.str === 'number' ? stats.str : undefined, naturalArmor: sheet?.naturalArmor }, equippedRows(db, characterId));
}

export interface WornArmour { itemId: string; name: string; props: ArmorProps }

/** The equipped inventory row in the armor slot (a shield is not armour), with its armour props read. */
export function wornArmour(db: Database.Database, characterId: string): WornArmour | null {
    const row = equippedRows(db, characterId).find(r => r.slot === 'armor');
    if (!row) return null;
    return { itemId: row.itemId ?? '', name: row.name ?? row.itemId ?? 'armour', props: readArmorProps(row.properties) };
}

/** The worn armour that puts Stealth at disadvantage, or null. */
export function armourStealthDisadvantage(db: Database.Database, characterId: string): { name: string; itemId: string } | null {
    const worn = wornArmour(db, characterId);
    return worn && worn.props.stealthDisadvantage === true ? { name: worn.name, itemId: worn.itemId } : null;
}
