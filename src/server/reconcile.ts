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
import { signed, skillKey, srdSkillAbility, type ShortAbility } from '../engine/skill-modifier.js';
import { resolveAdvantageSources, loadEffectDeclarations, standardConditionRules } from '../engine/advantage-sources.js';
import { worldSkillAbility } from '../engine/table-rules.js';
import type { SkillAdvantageTrait } from '../engine/senses.js';
import { suggestedScope, abilityOf, type RollScope } from '../engine/advantage-scope.js';

export const RECONCILE_KINDS = [
    'equipped_missing',
    'attack_duplicate',
    'attack_item_missing',
    'condition_stale_precedent',
    'ability_spent_outside_combat',
    'legendary_depleted_outside_combat',
    'xp_unposted',
    'skill_override_migrated',
    'advantage_source_undeclared'
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
type Ability = { name?: string; ready?: boolean; perRest?: 'short' | 'long' };
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

/** Every active encounter row with the token ids it holds (the database is tenant-scoped already). */
function activeEncounterTokens(db: Database.Database): Array<{ id: string; tokenIds: string[] }> {
    const rows = tryRows(() => db.prepare("SELECT id, tokens FROM encounters WHERE status = 'active'").all() as Array<{ id: string; tokens: string }>);
    return rows.map(r => ({
        id: r.id,
        tokenIds: parseJson<Array<{ id?: string }>>(r.tokens, []).map(t => t?.id).filter((id): id is string => typeof id === 'string')
    }));
}

/** Ids of characters standing in an active encounter (token id = character id). */
function charactersInLiveCombat(db: Database.Database, ids: string[]): Set<string> {
    const live = new Set<string>();
    if (!ids.length) return live;
    const want = new Set(ids);
    for (const enc of activeEncounterTokens(db)) {
        for (const id of enc.tokenIds) if (want.has(id)) live.add(id);
    }
    return live;
}

/**
 * Item 18: the active encounters this character is a token in, by id. The
 * rest guard reads this instead of the in-memory combat manager, which the
 * operation guard evicts before every call. A paused or completed encounter
 * does not count.
 */
export function liveEncountersFor(db: Database.Database, characterId: string): string[] {
    return activeEncounterTokens(db).filter(enc => enc.tokenIds.includes(characterId)).map(enc => enc.id);
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

/**
 * A logged purpose read back ('wis save (adv: VAUREK)', 'grapple (adv: GM,
 * Horn-Lock; dis: lower band)'): the roll it was, in the scope grammar's
 * terms, and the text of each side's source list.
 */
function purposeSources(purpose: string, abilityOfSkill: (skill: string) => ShortAbility | undefined): { roll?: RollScope; adv: string; dis: string } {
    const m = /^(.*?) \(((?:adv|dis): .*)\)$/.exec(purpose.trim());
    if (!m) return { adv: '', dis: '' };
    const base = m[1].trim().toLowerCase();
    let adv = '', dis = '';
    for (const seg of m[2].split('; ')) {
        if (seg.startsWith('adv: ')) adv = seg.slice(5);
        else if (seg.startsWith('dis: ')) dis = seg.slice(5);
    }
    let roll: RollScope | undefined;
    const save = /^(\w+) save$/.exec(base);
    const checkOf = /^(.+) check$/.exec(base);
    if (base === 'grapple') roll = { kind: 'grapple', move: 'clinch', skills: ['athletics'], abilities: ['str'] };
    else if (save && abilityOf(save[1])) roll = { kind: 'save', ability: abilityOf(save[1])! };
    // A skill check rolled with its skill's ability (the world's, else the
    // SRD map), so check:str covers a logged Athletics check as the roll did.
    else if (checkOf) roll = abilityOf(checkOf[1]) ? { kind: 'check', ability: abilityOf(checkOf[1]) } : { kind: 'check', skill: skillKey(checkOf[1]), ability: abilityOfSkill(checkOf[1]) };
    return { roll, adv, dis };
}

/** Whether a source list ('GM, Horn-Lock', 'Keen Smell (scent)') names this label as one of its entries. */
function listsLabel(side: string, label: string): boolean {
    const s = side.toLowerCase(), l = label.toLowerCase();
    if (!s || !l) return false;
    return s === l || s.startsWith(`${l}, `) || s.startsWith(`${l} (`) || s.includes(`, ${l}, `) || s.includes(`, ${l} (`) || s.endsWith(`, ${l}`);
}

/**
 * Play report 7 #7: the sheet's conditions the roll log shows were named as
 * a source, which declare nothing for those rolls now (the resolver the
 * rolls use decides), with the call that declares them.
 */
function undeclaredSources(db: Database.Database, c: CharRow, worldId: string): Array<{ detail: string; fix: string }> {
    const conditions = parseJson<Condition[]>(c.conditions, []).filter(x => x && typeof x.name === 'string');
    if (!conditions.length) return [];
    const abilityOfSkill = (skill: string) => worldSkillAbility(db, worldId, skill) ?? srdSkillAbility(skill);
    const purposes = tryRows(() => db.prepare("SELECT purpose FROM roll_log WHERE for_id = ? AND (purpose LIKE '%(adv: %' OR purpose LIKE '%(dis: %' OR purpose LIKE '%; dis: %') ORDER BY rowid").all(c.id) as Array<{ purpose: string }>).map(r => purposeSources(r.purpose, abilityOfSkill)).filter(p => p.roll);
    if (!purposes.length) return [];
    const effects = loadEffectDeclarations(db, c.id);
    // The roll's own candidates: a skillAdvantage trait sharing a condition's name declares for it.
    const traits = parseJson<{ skillAdvantage?: SkillAdvantageTrait[] }>(c.combat_profile, {}).skillAdvantage;
    const owner = { ownerId: c.id, ownerName: c.name, conditions: conditions.map(x => ({ name: x.name!, source: x.source, on: 'sheet' as const })), effects, traits: Array.isArray(traits) ? traits : [] };
    const out: Array<{ detail: string; fix: string }> = [];
    const names = [...new Set(conditions.map(x => (x.name!.split(':')[0].trim() || x.name!).slice(0, 60)))];
    for (const name of names) {
        let rolls = 0;
        const sides = new Set<'advantage' | 'disadvantage'>();
        const wants: Array<{ which: 'advantage' | 'disadvantage'; scope: string }> = [];
        for (const p of purposes) {
            for (const [which, side] of [['advantage', p.adv], ['disadvantage', p.dis]] as const) {
                if (!listsLabel(side, name)) continue;
                const r = resolveAdvantageSources([name], which, owner, p.roll!);
                if (!r.problems.length) continue;
                rolls++;
                sides.add(which);
                const scope = suggestedScope(p.roll!);
                if (!wants.some(w => w.which === which && w.scope === scope)) wants.push({ which, scope });
            }
        }
        if (!rolls) continue;
        const as = sides.size === 2 ? 'an advantage and disadvantage' : sides.has('advantage') ? 'an advantage' : 'a disadvantage';
        const named = `condition '${name}' was named as ${as} source in ${rolls} logged roll${rolls === 1 ? '' : 's'} (${[...new Set(wants.map(w => w.scope))].join(', ')}) and declares nothing for ${rolls === 1 ? 'it' : 'them'} now: the next one is refused`;
        // A standard condition is never converted: a feature made from it
        // would take the condition, and its 5e rules, off the sheet.
        const std = conditions.filter(x => (x.name!.split(':')[0].trim() || x.name!).slice(0, 60) === name).map(x => standardConditionRules(x.name!)).find(Boolean);
        if (std) {
            const which = [...sides].map(w => `situational${w === 'advantage' ? 'Advantage' : 'Disadvantage'}: '<reason>'`).join(' or ');
            out.push({
                detail: `${named} — a standard condition: it declares only its 5e rules (${std.join('; ') || 'none on a roll'})`,
                fix: `pass ${which} on such a roll instead of naming '${name}'; do not convert it: a feature made from it would take '${name}' and its 5e rules off the sheet. The finding clears when the condition ends`
            });
            continue;
        }
        const added = wants.map(w => `{type: "${w.which}_on", value: "${w.scope}"}`);
        const feature = effects.find(e => e.name.toLowerCase() === name.toLowerCase());
        const fix = feature
            ? `improvisation_manage edit_effect {targetId: ${JSON.stringify(c.id)}, name: ${JSON.stringify(feature.name)}, mechanics: [${[...feature.mechanics.map(m => JSON.stringify(m)), ...added].join(', ')}]}`
            : `improvisation_manage feature_from_condition {characterId: ${JSON.stringify(c.id)}, match: ${JSON.stringify(name)}, mechanics: [${added.join(', ')}]}`;
        out.push({
            detail: named,
            fix: `${fix} — add condition: "<when-tag>" if it holds only sometimes`
        });
    }
    return out;
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

        // 5/6. Spent ability state with no fight to spend it in. A perRest
        // ability (item 18) waits for rest_manage: spent between fights is
        // the rule working, not drift.
        if (!live.has(c.id)) {
            const spent = (Array.isArray(profile.abilities) ? profile.abilities : []).filter(a => a && a.ready === false && !a.perRest);
            if (spent.length) {
                const names = spent.map(a => a.name ?? '?');
                push('ability_spent_outside_combat', `${names.join(', ')} ready:false with no live encounter`,
                    `character_manage restore_ability {characterId: "${c.id}", ${names.length === 1 ? `name: "${names[0]}"` : 'all: true'}}${names.length === 1 ? '' : ` (or name: "${names[0]}" for one)`}`);
            }
            const la = c.legendary_actions, lar = c.legendary_actions_remaining;
            const lr = c.legendary_resistances, lrr = c.legendary_resistances_remaining;
            const parts: string[] = [];
            const fixes: string[] = [];
            if (la !== null && la !== undefined && lar !== null && lar !== undefined && lar < la) { parts.push(`legendary actions ${lar}/${la}`); fixes.push(`legendaryActionsRemaining: ${la}`); }
            if (lr !== null && lr !== undefined && lrr !== null && lrr !== undefined && lrr < lr) { parts.push(`legendary resistances ${lrr}/${lr}`); fixes.push(`legendaryResistancesRemaining: ${lr}`); }
            if (parts.length) {
                // Item 18: a long rest restores resistances (actions reset per round, so update is the only fix for those).
                const restHint = lr !== null && lr !== undefined && lrr !== null && lrr !== undefined && lrr < lr ? ' (rest_manage long also restores legendary resistances)' : '';
                push('legendary_depleted_outside_combat', `${parts.join(', ')} with no live encounter`,
                    `character_manage update {characterId: "${c.id}", ${fixes.join(', ')}}${restHint}`);
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

        // 8. Play report 2 #5: a stealth/perception column the 2026-10-11
        // migration moved (a born-0 default nulled, a legacy additive bonus
        // folded into an override), until the GM acknowledges or restores it.
        const ledger = tryRows(() => db.prepare('SELECT skill, before, after, computed, kind FROM skill_override_migrations WHERE character_id = ? AND acknowledged = 0 ORDER BY id').all(c.id) as Array<{ skill: string; before: number | null; after: number | null; computed: number | null; kind: string }>);
        // A column back at its old number (restored by any writer) is a move
        // undone: no longer a finding. A column moved elsewhere — the #67-F
        // offset sync tracks stat changes on a non-null column without anyone
        // deciding — stays listed, with the live number. An explicit
        // stealthOverride/perceptionOverride update acknowledges its row itself
        // (character_manage). Reconcile writes nothing here.
        const columnsNow = ledger.length
            ? tryRows(() => [db.prepare('SELECT stealth_bonus AS stealth, perception_bonus AS perception FROM characters WHERE id = ?').get(c.id) as { stealth: number | null; perception: number | null } | undefined]).find(Boolean)
            : undefined;
        for (const m of ledger) {
            const current = columnsNow ? ((columnsNow as Record<string, number | null>)[m.skill] ?? null) : (m.after ?? null);
            if (current === (m.before ?? null)) continue;
            const fmt = (v: number | null) => v === null ? 'null' : signed(v);
            const now = current !== (m.after ?? null) ? `; now ${fmt(current)}` : '';
            const why = m.kind === 'default_to_null' ? 'a 0 nobody wrote; the sheet computes it now' : 'legacy additive bonus folded into an override';
            push('skill_override_migrated', `${m.skill} ${signed(m.before ?? 0)} -> ${fmt(m.after)} (computed ${signed(m.computed ?? 0)}; ${why}${now})`,
                `character_manage update {characterId: "${c.id}", ${m.skill}Override: ${m.before ?? 0}} restores the old number, or world_manage reconcile {worldId: "${worldId}", acknowledge: ["skill_override_migrated"]} accepts the move`);
        }
    }

    // 9. Play report 7 #7: prose conditions the roll log shows were named as
    // advantage (or disadvantage) sources, which declare nothing now — the
    // next roll that names them is refused. Converted before play, not after.
    for (const c of chars) {
        for (const f of undeclaredSources(db, c, worldId)) findings.push({ kind: 'advantage_source_undeclared', characterId: c.id, characterName: c.name, ...f });
    }

    const byKind: Partial<Record<ReconcileKind, number>> = {};
    for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    return { worldId, ...(characterId ? { characterId } : {}), scope, count: findings.length, findings, byKind };
}

/** One line per finding, for boot and the tool's text output. */
export function reconcileLine(f: ReconcileFinding): string {
    return `${f.characterName}: [${f.kind}] ${f.detail}`;
}

/** The kinds a GM can acknowledge (the one write reconcile makes). */
export const ACKNOWLEDGEABLE_KINDS: readonly ReconcileKind[] = ['skill_override_migrated'];

/**
 * Mark findings as seen so they stop appearing: for skill_override_migrated,
 * the migration ledger rows of this world's characters (or one character).
 * Returns how many rows each kind marked. Other kinds have nothing to mark;
 * their findings clear when the sheet is fixed.
 */
export function acknowledgeFindings(db: Database.Database, worldId: string, kinds: readonly ReconcileKind[], characterId?: string): Partial<Record<ReconcileKind, number>> {
    const out: Partial<Record<ReconcileKind, number>> = {};
    if (!kinds.includes('skill_override_migrated')) return out;
    const ids = loadCharacters(db, worldId, characterId).rows.map(c => c.id);
    let n = 0;
    try {
        const stmt = db.prepare('UPDATE skill_override_migrations SET acknowledged = 1 WHERE acknowledged = 0 AND character_id = ?');
        for (const id of ids) n += stmt.run(id).changes;
    } catch { /* no ledger table on this db: nothing to acknowledge */ }
    out.skill_override_migrated = n;
    return out;
}
