import Database from 'better-sqlite3';
import { getToolContext } from '../../server/tool-context.js';
import { Character, CharacterSchema, NPC, NPCSchema } from '../../schema/character.js';
import { CharacterType } from '../../schema/party.js';

export class CharacterRepository {
    constructor(private db: Database.Database) { }

    create(character: Character | NPC): void {
        // Determine if it's an NPC or Character for validation
        const isNPC = 'factionId' in character || 'behavior' in character;
        const validChar = isNPC ? NPCSchema.parse(character) : CharacterSchema.parse(character);

        const stmt = this.db.prepare(`
      INSERT INTO characters (id, name, stats, hp, max_hp, ac, level, xp, faction_id, behavior, character_type,
                               character_class, race, spell_slots, pact_magic_slots, known_spells, prepared_spells,
                               cantrips_known, max_spell_level, concentrating_on, conditions,
                               currency,
                               legendary_actions, legendary_actions_remaining, legendary_resistances,
                              legendary_resistances_remaining, has_lair_actions, resistances, vulnerabilities, immunities,
                               current_room_id, perception_bonus, stealth_bonus, resource_pools, band, regeneration,
                               skill_proficiencies, save_proficiencies, expertise,
                               armor_proficiencies, weapon_proficiencies, tool_proficiencies, languages,
                               background, alignment, origin,
                              created_at, updated_at)
      VALUES (@id, @name, @stats, @hp, @maxHp, @ac, @level, @xp, @factionId, @behavior, @characterType,
               @characterClass, @race, @spellSlots, @pactMagicSlots, @knownSpells, @preparedSpells,
               @cantripsKnown, @maxSpellLevel, @concentratingOn, @conditions,
               @currency,
               @legendaryActions, @legendaryActionsRemaining, @legendaryResistances,
              @legendaryResistancesRemaining, @hasLairActions, @resistances, @vulnerabilities, @immunities,
               @currentRoomId, @perceptionBonus, @stealthBonus, @resourcePools, @band, @regeneration,
               @skillProficiencies, @saveProficiencies, @expertise,
               @armorProficiencies, @weaponProficiencies, @toolProficiencies, @languages,
               @background, @alignment, @origin,
              @createdAt, @updatedAt)
    `);

        stmt.run({
            id: validChar.id,
            name: validChar.name,
            stats: JSON.stringify(validChar.stats),
            hp: validChar.hp,
            maxHp: validChar.maxHp,
            ac: validChar.ac,
            level: validChar.level,
            xp: validChar.xp ?? 0,
            factionId: (validChar as NPC).factionId || null,
            behavior: (validChar as NPC).behavior || null,
            characterType: validChar.characterType || 'pc',
            // CRIT-002/006: Spellcasting fields
            characterClass: validChar.characterClass || 'fighter',
            race: validChar.race || 'Human',
            spellSlots: validChar.spellSlots ? JSON.stringify(validChar.spellSlots) : null,
            pactMagicSlots: validChar.pactMagicSlots ? JSON.stringify(validChar.pactMagicSlots) : null,
            knownSpells: JSON.stringify(validChar.knownSpells || []),
            preparedSpells: JSON.stringify(validChar.preparedSpells || []),
            cantripsKnown: JSON.stringify(validChar.cantripsKnown || []),
            maxSpellLevel: validChar.maxSpellLevel || 0,
            concentratingOn: validChar.concentratingOn || null,
            conditions: JSON.stringify(validChar.conditions || []),
            currency: JSON.stringify(validChar.currency || { gold: 0, silver: 0, copper: 0 }),
            // HIGH-007: Legendary creature fields
            legendaryActions: validChar.legendaryActions ?? null,
            legendaryActionsRemaining: validChar.legendaryActionsRemaining ?? null,
            legendaryResistances: validChar.legendaryResistances ?? null,
            legendaryResistancesRemaining: validChar.legendaryResistancesRemaining ?? null,
            hasLairActions: validChar.hasLairActions ? 1 : 0,
            resistances: JSON.stringify(validChar.resistances || []),
            vulnerabilities: JSON.stringify(validChar.vulnerabilities || []),
            immunities: JSON.stringify(validChar.immunities || []),
            // PHASE-1: Spatial awareness
            currentRoomId: validChar.currentRoomId || null,
            // PHASE-2: Social hearing mechanics skill bonuses
            perceptionBonus: validChar.perceptionBonus || 0,
            stealthBonus: validChar.stealthBonus || 0,
            // §10.3: Generalized resource pools (attentional_capacity et al.)
            resourcePools: JSON.stringify(validChar.resourcePools || {}),
            // Table rules: power band and per-round regeneration
            band: validChar.band ?? null,
            regeneration: validChar.regeneration ?? null,
            skillProficiencies: JSON.stringify(validChar.skillProficiencies || []),
            saveProficiencies: JSON.stringify(validChar.saveProficiencies || []),
            expertise: JSON.stringify(validChar.expertise || []),
            armorProficiencies: JSON.stringify(validChar.armorProficiencies || []),
            weaponProficiencies: JSON.stringify(validChar.weaponProficiencies || []),
            toolProficiencies: JSON.stringify(validChar.toolProficiencies || []),
            languages: JSON.stringify(validChar.languages || []),
            // BASTION: background, alignment, origin (silent-drop fix + world-brief enforcement)
            background: validChar.background ?? null,
            alignment: validChar.alignment ?? null,
            origin: validChar.origin ? JSON.stringify(validChar.origin) : null,
            createdAt: validChar.createdAt,
            updatedAt: validChar.updatedAt,
        });
    }

    findById(id: string): Character | NPC | null {
        const stmt = this.db.prepare('SELECT * FROM characters WHERE id = ?');
        const row = stmt.get(id) as CharacterRow | undefined;

        if (!row) {
            // FINDINGS #70: truncated-UUID rescue — exact miss falls through to
            // a prefix match, ≥6 chars, resolving ONLY on exactly one hit.
            // Unique-or-nothing makes this safe on the write paths too: an
            // ambiguous prefix stays not-found, never a guess.
            if (id.length >= 6 && id.length < 36) {
                const hits = this.db.prepare('SELECT * FROM characters WHERE id LIKE ? LIMIT 2').all(`${id}%`) as CharacterRow[];
                if (hits.length === 1) return this.rowToCharacter(hits[0]);
            }
            return null;
        }
        return this.rowToCharacter(row);
    }

    findAll(filters?: { characterType?: CharacterType }): (Character | NPC)[] {
        let query = 'SELECT * FROM characters';
        const params: any[] = [];

        if (filters?.characterType) {
            query += ' WHERE character_type = ?';
            params.push(filters.characterType);
        }

        const stmt = this.db.prepare(query);
        const rows = stmt.all(...params) as CharacterRow[];
        return rows.map(row => this.rowToCharacter(row));
    }

    findByType(characterType: CharacterType): (Character | NPC)[] {
        const stmt = this.db.prepare('SELECT * FROM characters WHERE character_type = ?');
        const rows = stmt.all(characterType) as CharacterRow[];
        return rows.map(row => this.rowToCharacter(row));
    }

    update(id: string, updates: Partial<Character | NPC>): Character | NPC | null {
        const existing = this.findById(id);
        if (!existing) return null;
        // FINDINGS #77: existing.id from here down — the resolve must propagate.
        // The raw argument previously fed BOTH the audit rows and the UPDATE's
        // WHERE: a prefix call wrote an audit trail for a transition that never
        // happened, then matched zero rows and returned the merged object as if
        // written. The audit logging the lie is the worst family variant found.
        const canonicalId = existing.id;

        const updated = {
            ...existing,
            ...updates,
            updatedAt: new Date().toISOString()
        };

        // FINDINGS #34 T1.4: attribute every HP / pool write to its tool.
        try {
            const auditStmt = this.db.prepare(
                `INSERT INTO write_audit (character_id, field, old_value, new_value, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`
            );
            const src = getToolContext();
            const now = new Date().toISOString();
            if (updates.hp !== undefined && updates.hp !== existing.hp) {
                auditStmt.run(canonicalId, 'hp', String(existing.hp), String(updates.hp), src, now);
            }
            if (updates.maxHp !== undefined && updates.maxHp !== existing.maxHp) {
                auditStmt.run(canonicalId, 'maxHp', String(existing.maxHp), String(updates.maxHp), src, now);
            }
            // Findings #35: XP and level join the audited set — XP has drifted before.
            const updXp = (updates as { xp?: number }).xp;
            const exXp = (existing as { xp?: number }).xp ?? 0;
            if (updXp !== undefined && updXp !== exXp) {
                auditStmt.run(canonicalId, 'xp', String(exXp), String(updXp), src, now);
            }
            if (updates.level !== undefined && updates.level !== existing.level) {
                auditStmt.run(canonicalId, 'level', String(existing.level), String(updates.level), src, now);
            }
            const newPools = (updates as { resourcePools?: Record<string, { current: number; max: number }> }).resourcePools;
            const oldPools = (existing as { resourcePools?: Record<string, { current: number; max: number }> }).resourcePools || {};
            if (newPools) {
                for (const [pool, val] of Object.entries(newPools)) {
                    const before = oldPools[pool];
                    if (!before || before.current !== val.current || before.max !== val.max) {
                        auditStmt.run(canonicalId, `pool:${pool}`, before ? `${before.current}/${before.max}` : 'absent', `${val.current}/${val.max}`, src, now);
                    }
                }
                for (const pool of Object.keys(oldPools)) {
                    if (!(pool in newPools)) auditStmt.run(canonicalId, `pool:${pool}`, `${oldPools[pool].current}/${oldPools[pool].max}`, 'DELETED', src, now);
                }
            }
        } catch { /* audit must never block the write (table may predate migration) */ }

        // Validate
        const isNPC = 'factionId' in updated || 'behavior' in updated;
        const validChar = isNPC ? NPCSchema.parse(updated) : CharacterSchema.parse(updated);

        const stmt = this.db.prepare(`
            UPDATE characters
            SET name = ?, stats = ?, hp = ?, max_hp = ?, ac = ?, level = ?, xp = ?,
                faction_id = ?, behavior = ?, character_type = ?,
                 character_class = ?, race = ?, spell_slots = ?, pact_magic_slots = ?,
                 known_spells = ?, prepared_spells = ?, cantrips_known = ?,
                 max_spell_level = ?, concentrating_on = ?, conditions = ?,
                 currency = ?,
                 legendary_actions = ?, legendary_actions_remaining = ?,
                legendary_resistances = ?, legendary_resistances_remaining = ?,
                 has_lair_actions = ?, resistances = ?, vulnerabilities = ?, immunities = ?,
                 current_room_id = ?, perception_bonus = ?, stealth_bonus = ?,
                 resource_pools = ?, band = ?, regeneration = ?,
                 skill_proficiencies = ?, save_proficiencies = ?, expertise = ?,
                 armor_proficiencies = ?, weapon_proficiencies = ?, tool_proficiencies = ?, languages = ?,
                 background = ?, alignment = ?, origin = ?,
                updated_at = ?
            WHERE id = ?
        `);

        stmt.run(
            validChar.name,
            JSON.stringify(validChar.stats),
            validChar.hp,
            validChar.maxHp,
            validChar.ac,
            validChar.level,
            validChar.xp ?? 0,
            (validChar as NPC).factionId || null,
            (validChar as NPC).behavior || null,
            validChar.characterType || 'pc',
            // CRIT-002/006: Spellcasting fields
            validChar.characterClass || 'fighter',
            validChar.race || 'Human',
            validChar.spellSlots ? JSON.stringify(validChar.spellSlots) : null,
            validChar.pactMagicSlots ? JSON.stringify(validChar.pactMagicSlots) : null,
            JSON.stringify(validChar.knownSpells || []),
            JSON.stringify(validChar.preparedSpells || []),
            JSON.stringify(validChar.cantripsKnown || []),
            validChar.maxSpellLevel || 0,
            validChar.concentratingOn || null,
            JSON.stringify(validChar.conditions || []),
            JSON.stringify(validChar.currency || { gold: 0, silver: 0, copper: 0 }),
            // HIGH-007: Legendary creature fields
            validChar.legendaryActions ?? null,
            validChar.legendaryActionsRemaining ?? null,
            validChar.legendaryResistances ?? null,
            validChar.legendaryResistancesRemaining ?? null,
            validChar.hasLairActions ? 1 : 0,
            JSON.stringify(validChar.resistances || []),
            JSON.stringify(validChar.vulnerabilities || []),
            JSON.stringify(validChar.immunities || []),
            // PHASE-1: Spatial awareness
            validChar.currentRoomId || null,
            // PHASE-2: Social hearing mechanics skill bonuses
            validChar.perceptionBonus || 0,
            validChar.stealthBonus || 0,
            // §10.3: Generalized resource pools
            JSON.stringify(validChar.resourcePools || {}),
            validChar.band ?? null,
            validChar.regeneration ?? null,
            JSON.stringify(validChar.skillProficiencies || []),
            JSON.stringify(validChar.saveProficiencies || []),
            JSON.stringify(validChar.expertise || []),
            JSON.stringify(validChar.armorProficiencies || []),
            JSON.stringify(validChar.weaponProficiencies || []),
            JSON.stringify(validChar.toolProficiencies || []),
            JSON.stringify(validChar.languages || []),
            // BASTION: background, alignment, origin
            validChar.background ?? null,
            validChar.alignment ?? null,
            validChar.origin ? JSON.stringify(validChar.origin) : null,
            validChar.updatedAt,
            canonicalId
        );

        return validChar;
    }

    delete(id: string): boolean {
        // FINDINGS #77: resolve before deleting — the raw id no-opped both the
        // instance cleanup and the delete on a prefix call.
        const existing = this.findById(id);
        if (!existing) return false;
        // FINDINGS #59: instance rows are per-owner state and die with the row.
        // Corpse/loot flows re-home instances BEFORE anyone deletes; a straight
        // admin delete otherwise strands orphans (the #59 probe did exactly this).
        try {
            this.db.prepare('DELETE FROM item_instances WHERE owner_character_id = ?').run(existing.id);
        } catch { /* instances table absent pre-migration — nothing to clean */ }
        const stmt = this.db.prepare('DELETE FROM characters WHERE id = ?');
        const result = stmt.run(existing.id);
        return result.changes > 0;
    }

    private rowToCharacter(row: CharacterRow): Character | NPC {
        const base = {
            id: row.id,
            name: row.name,
            stats: JSON.parse(row.stats),
            hp: row.hp,
            maxHp: row.max_hp,
            ac: row.ac,
            level: row.level,
            xp: row.xp ?? 0,
            characterType: (row.character_type as CharacterType) || 'pc',
            // CRIT-002/006: Spellcasting fields
            characterClass: row.character_class || 'fighter',
            race: row.race || 'Human',
            spellSlots: row.spell_slots ? JSON.parse(row.spell_slots) : undefined,
            pactMagicSlots: row.pact_magic_slots ? JSON.parse(row.pact_magic_slots) : undefined,
            knownSpells: row.known_spells ? JSON.parse(row.known_spells) : [],
            preparedSpells: row.prepared_spells ? JSON.parse(row.prepared_spells) : [],
            cantripsKnown: row.cantrips_known ? JSON.parse(row.cantrips_known) : [],
            maxSpellLevel: row.max_spell_level || 0,
            concentratingOn: row.concentrating_on || null,
            conditions: row.conditions ? JSON.parse(row.conditions) : [],
            currency: row.currency ? JSON.parse(row.currency) : { gold: 0, silver: 0, copper: 0 },
            // HIGH-007: Legendary creature fields
            legendaryActions: row.legendary_actions ?? undefined,
            legendaryActionsRemaining: row.legendary_actions_remaining ?? undefined,
            legendaryResistances: row.legendary_resistances ?? undefined,
            legendaryResistancesRemaining: row.legendary_resistances_remaining ?? undefined,
            hasLairActions: row.has_lair_actions === 1,
            resistances: row.resistances ? JSON.parse(row.resistances) : [],
            vulnerabilities: row.vulnerabilities ? JSON.parse(row.vulnerabilities) : [],
            immunities: row.immunities ? JSON.parse(row.immunities) : [],
            // PHASE-1: Spatial awareness
            currentRoomId: row.current_room_id || undefined,
            // PHASE-2: Social hearing mechanics skill bonuses
            perceptionBonus: row.perception_bonus ?? 0,
            stealthBonus: row.stealth_bonus ?? 0,
            // §10.3: Generalized resource pools (attentional_capacity et al.)
            resourcePools: row.resource_pools ? JSON.parse(row.resource_pools) : {},
            band: row.band ?? undefined,
            regeneration: row.regeneration ?? undefined,
            skillProficiencies: row.skill_proficiencies ? JSON.parse(row.skill_proficiencies) : [],
            saveProficiencies: row.save_proficiencies ? JSON.parse(row.save_proficiencies) : [],
            expertise: row.expertise ? JSON.parse(row.expertise) : [],
            armorProficiencies: row.armor_proficiencies ? JSON.parse(row.armor_proficiencies) : [],
            weaponProficiencies: row.weapon_proficiencies ? JSON.parse(row.weapon_proficiencies) : [],
            toolProficiencies: row.tool_proficiencies ? JSON.parse(row.tool_proficiencies) : [],
            languages: row.languages ? JSON.parse(row.languages) : [],
            background: row.background || undefined,
            alignment: row.alignment || undefined,
            origin: row.origin ? JSON.parse(row.origin) : undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };

        if (row.faction_id || row.behavior) {
            return NPCSchema.parse({
                ...base,
                factionId: row.faction_id || undefined,
                behavior: row.behavior || undefined,
            });
        }

        return CharacterSchema.parse(base);
    }
}

interface CharacterRow {
    id: string;
    name: string;
    stats: string;
    hp: number;
    max_hp: number;
    ac: number;
    level: number;
    xp: number | null;
    faction_id: string | null;
    behavior: string | null;
    character_type: string | null;
    // CRIT-002/006: Spellcasting columns
    character_class: string | null;
    race: string | null;
    spell_slots: string | null;
    pact_magic_slots: string | null;
    known_spells: string | null;
    prepared_spells: string | null;
    cantrips_known: string | null;
    max_spell_level: number | null;
    concentrating_on: string | null;
    conditions: string | null;
    currency: string | null;
    // HIGH-007: Legendary creature columns
    legendary_actions: number | null;
    legendary_actions_remaining: number | null;
    legendary_resistances: number | null;
    legendary_resistances_remaining: number | null;
    has_lair_actions: number | null;
    resistances: string | null;
    vulnerabilities: string | null;
    immunities: string | null;
    // PHASE-1: Spatial awareness
    current_room_id: string | null;
    // PHASE-2: Social hearing mechanics skill bonuses
    perception_bonus: number | null;
    stealth_bonus: number | null;
    // §10.3: Generalized resource pools
    resource_pools: string | null;
    band?: string | null;
    regeneration?: number | null;
    skill_proficiencies: string | null;
    save_proficiencies: string | null;
    expertise: string | null;
    armor_proficiencies: string | null;
    weapon_proficiencies: string | null;
    tool_proficiencies: string | null;
    languages: string | null;
    background: string | null;
    alignment: string | null;
    origin: string | null;
    created_at: string;
    updated_at: string;
}
