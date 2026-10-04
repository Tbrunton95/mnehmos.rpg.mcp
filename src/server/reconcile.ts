/**
 * Deep One audit request 4: SHEET RECONCILIATION. Four days of fights run in
 * chat left sheets that disagree with themselves — a sword equipped that was
 * sold, two "greataxe" profiles, a condition citing a ruling that has since
 * been overruled, a recharge ability still spent a week after the fight.
 * `world_manage reconcile` names each drift as a finding with the tool call
 * that fixes it; boot shows the count. Read-only: fixing stays a decision.
 * Every lane is defensive — a missing table or column is an empty lane.
 */
import type Database from 'better-sqlite3';

export const RECONCILE_KINDS = [
    'equipped_missing',
    'attack_duplicate',
    'attack_item_missing',
    'condition_stale_precedent',
    'ability_spent_outside_combat',
    'legendary_depleted_outside_combat',
    'xp_unposted'
] as const;
export type ReconcileKind = typeof RECONCILE_KINDS[number];

export interface ReconcileFinding {
    kind: ReconcileKind;
    characterId: string;
    characterName: string;
    detail: string;
    /** The tool call that clears it. */
    fix: string;
}

export interface ReconcileReport {
    worldId: string;
    characterId?: string;
    /** 'world' when characters carry world_id; 'all-characters' when the column is absent (older db). */
    scope: 'world' | 'all-characters';
    count: number;
    findings: ReconcileFinding[];
    byKind: Partial<Record<ReconcileKind, number>>;
}

type CharRow = {
    id: string; name: string; conditions: string | null; combat_profile: string | null;
    legendary_actions: number | null; legendary_actions_remaining: number | null;
    legendary_resistances: number | null; legendary_resistances_remaining: number | null;
};
type Attack = { name?: string; item?: string };
type Ability = { name?: string; ready?: boolean };
type Condition = { name?: string; source?: string; note?: string };

/** Precedent ids as the ledger mints them: prec-<8 hex>. */
export const PRECEDENT_ID_RE = /\bprec-[0-9a-f]{8}\b/gi;

const tryRows = <T>(fn: () => T[]): T[] => { try { return fn(); } catch { return []; } };
const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
};

function tableExists(db: Database.Database, name: string): boolean {
    try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
}

/** Characters the reconcile reads: the world's, or one of them. */
function loadCharacters(db: Database.Database, worldId: string, characterId?: string): { rows: CharRow[]; scope: ReconcileReport['scope'] } {
    const cols = 'id, name, conditions, combat_profile, legendary_actions, legendary_actions_remaining, legendary_resistances, legendary_resistances_remaining';
    try {
        const rows = (characterId
            ? db.prepare(`SELECT ${cols} FROM characters WHERE id = ? AND (world_id = ? OR world_id IS NULL)`).all(characterId, worldId)
            : db.prepare(`SELECT ${cols} FROM characters WHERE world_id = ?`).all(worldId)) as CharRow[];
        return { rows, scope: 'world' };
    } catch {
        // No world_id on characters yet (the #103 migration queue): read them all, and say so.
        const rows = tryRows(() => (characterId
            ? db.prepare(`SELECT ${cols} FROM characters WHERE id = ?`).all(characterId)
            : db.prepare(`SELECT ${cols} FROM characters`).all()) as CharRow[]);
        return { rows, scope: 'all-characters' };
    }
}

/** Ids of characters standing in an active encounter (token id = character id). */
function charactersInLiveCombat(db: Database.Database, ids: string[]): Set<string> {
    const live = new Set<string>();
    if (!ids.length) return live;
    const want = new Set(ids);
    const rows = tryRows(() => db.prepare("SELECT tokens FROM encounters WHERE status = 'active'").all() as Array<{ tokens: string }>);
    for (const r of rows) {
        for (const t of parseJson<Array<{ id?: string }>>(r.tokens, [])) {
            if (t && typeof t.id === 'string' && want.has(t.id)) live.add(t.id);
        }
    }
    return live;
}

/** Every name an attack profile's `item` may legitimately use: template names and ids, instance names and ids. */
function inventoryNames(db: Database.Database, characterId: string): Set<string> {
    const names = new Set<string>();
    const add = (s: unknown) => { if (typeof s === 'string' && s.trim()) names.add(s.trim().toLowerCase()); };
    for (const r of tryRows(() => db.prepare('SELECT ii.item_id, i.name FROM inventory_items ii LEFT JOIN items i ON i.id = ii.item_id WHERE ii.character_id = ? AND ii.quantity > 0').all(characterId) as Array<{ item_id: string; name: string | null }>)) {
        add(r.item_id); add(r.name);
    }
    for (const r of tryRows(() => db.prepare('SELECT inst.id, inst.custom_name, i.name FROM item_instances inst LEFT JOIN items i ON i.id = inst.template_id WHERE inst.owner_character_id = ?').all(characterId) as Array<{ id: string; custom_name: string | null; name: string | null }>)) {
        add(r.id); add(r.custom_name); add(r.name);
    }
    return names;
}

export function reconcileWorld(db: Database.Database, worldId: string, characterId?: string): ReconcileReport {
    const findings: ReconcileFinding[] = [];
    const { rows: chars, scope } = loadCharacters(db, worldId, characterId);
    const live = charactersInLiveCombat(db, chars.map(c => c.id));
    const precedentCache = new Map<string, { superseded_by: string | null } | undefined>();
    const lookupPrecedent = (id: string) => {
        const key = id.toLowerCase();
        if (!precedentCache.has(key)) {
            precedentCache.set(key, (() => { try { return db.prepare('SELECT superseded_by FROM precedents WHERE LOWER(id) = ?').get(key) as { superseded_by: string | null } | undefined; } catch { return undefined; } })());
        }
        return precedentCache.get(key);
    };
    const hasAwards = tableExists(db, 'xp_awards');

    for (const c of chars) {
        const push = (kind: ReconcileKind, detail: string, fix: string) => findings.push({ kind, characterId: c.id, characterName: c.name, detail, fix });

        // 1. Equipped rows with nothing behind them.
        for (const r of tryRows(() => db.prepare('SELECT ii.item_id, ii.quantity, ii.slot, i.name FROM inventory_items ii LEFT JOIN items i ON i.id = ii.item_id WHERE ii.character_id = ? AND ii.equipped = 1 AND (ii.quantity <= 0 OR i.id IS NULL)').all(c.id) as Array<{ item_id: string; quantity: number; slot: string | null; name: string | null }>)) {
            const why = r.name === null ? 'its item row no longer exists' : `quantity ${r.quantity}`;
            push('equipped_missing', `${r.name ?? r.item_id} equipped${r.slot ? ` in ${r.slot}` : ''} but ${why}`,
                `inventory_manage unequip {characterId: "${c.id}", itemId: "${r.item_id}"}${r.name === null ? ` then inventory_manage remove {characterId: "${c.id}", itemId: "${r.item_id}"}` : ''}`);
        }

        // 2/3. Attack profiles: duplicate names, items the character does not hold.
        const profile = parseJson<{ attacks?: Attack[]; abilities?: Ability[] }>(c.combat_profile, {});
        const attacks = Array.isArray(profile.attacks) ? profile.attacks.filter(a => a && typeof a.name === 'string') : [];
        if (attacks.length) {
            const seen = new Map<string, number>();
            for (const a of attacks) seen.set(a.name!.trim().toLowerCase(), (seen.get(a.name!.trim().toLowerCase()) ?? 0) + 1);
            for (const [name, n] of seen) {
                if (n > 1) push('attack_duplicate', `${n} attack profiles named '${name}' — attack {using: '${name}'} is ambiguous`,
                    `character_manage update {characterId: "${c.id}", attacks: [...]} resending the list with one '${name}' (or distinct names)`);
            }
            const held = attacks.some(a => typeof a.item === 'string' && a.item.trim()) ? inventoryNames(db, c.id) : null;
            if (held) {
                for (const a of attacks) {
                    if (typeof a.item !== 'string' || !a.item.trim()) continue;
                    if (!held.has(a.item.trim().toLowerCase())) {
                        push('attack_item_missing', `attack '${a.name}' swings '${a.item}', which is not in the inventory`,
                            `inventory_manage give {characterId: "${c.id}", itemId: <id of '${a.item}'>} if it was never recorded, or character_manage update {characterId: "${c.id}", attacks: [...]} dropping the profile`);
                    }
                }
            }
        }

        // 4. Conditions citing a precedent that is gone or overruled.
        for (const cond of parseJson<Condition[]>(c.conditions, [])) {
            if (!cond) continue;
            const cited = new Set<string>();
            for (const field of [cond.source, cond.note]) {
                if (typeof field !== 'string') continue;
                for (const m of field.match(PRECEDENT_ID_RE) ?? []) cited.add(m);
            }
            for (const id of cited) {
                const row = lookupPrecedent(id);
                if (row && !row.superseded_by) continue;
                const state = row ? `superseded by ${row.superseded_by}` : 'not in the precedent ledger';
                push('condition_stale_precedent', `condition '${cond.name ?? '?'}' cites ${id}, which is ${state}`,
                    row
                        ? `character_manage update {characterId: "${c.id}", editConditions: [{match: "${cond.name ?? ''}", replaceSource: {find: "${id}", with: "${row.superseded_by}"}}]} after reading precedent_manage get {precedentId: "${row.superseded_by}"}`
                        : `character_manage update {characterId: "${c.id}", editConditions: [{match: "${cond.name ?? ''}", source: "<current ruling>"}]} or removeConditions: ["${cond.name ?? ''}"]`);
            }
        }

        // 5/6. Spent ability state with no fight to spend it in.
        if (!live.has(c.id)) {
            const spent = (Array.isArray(profile.abilities) ? profile.abilities : []).filter(a => a && a.ready === false);
            if (spent.length) {
                const names = spent.map(a => a.name ?? '?');
                push('ability_spent_outside_combat', `${names.join(', ')} ready:false with no live encounter`,
                    `character_manage update {characterId: "${c.id}", abilities: [...]} with ready: true (rest_manage long resets them too)`);
            }
            const la = c.legendary_actions, lar = c.legendary_actions_remaining;
            const lr = c.legendary_resistances, lrr = c.legendary_resistances_remaining;
            const parts: string[] = [];
            const fixes: string[] = [];
            if (la !== null && la !== undefined && lar !== null && lar !== undefined && lar < la) { parts.push(`legendary actions ${lar}/${la}`); fixes.push(`legendaryActionsRemaining: ${la}`); }
            if (lr !== null && lr !== undefined && lrr !== null && lrr !== undefined && lrr < lr) { parts.push(`legendary resistances ${lrr}/${lr}`); fixes.push(`legendaryResistancesRemaining: ${lr}`); }
            if (parts.length) {
                push('legendary_depleted_outside_combat', `${parts.join(', ')} with no live encounter`,
                    `character_manage update {characterId: "${c.id}", ${fixes.join(', ')}}`);
            }
        }

        // 7. Awards narrated but never posted (only when the ledger table exists).
        if (hasAwards) {
            const row = (() => { try { return db.prepare('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM xp_awards WHERE character_id = ? AND posted = 0').get(c.id) as { total: number; n: number }; } catch { return undefined; } })();
            if (row && row.n > 0) {
                push('xp_unposted', `${row.n} award(s) totalling ${row.total} XP narrated but not posted`,
                    `character_manage post_awards {characterId: "${c.id}"}`);
            }
        }
    }

    const byKind: Partial<Record<ReconcileKind, number>> = {};
    for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    return { worldId, ...(characterId ? { characterId } : {}), scope, count: findings.length, findings, byKind };
}

/** One line per finding, for boot and the tool's text output. */
export function reconcileLine(f: ReconcileFinding): string {
    return `${f.characterName}: [${f.kind}] ${f.detail}`;
}
