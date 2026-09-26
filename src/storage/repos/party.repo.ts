import Database from 'better-sqlite3';
import { 
    Party, PartySchema, 
    PartyMember, PartyMemberSchema,
    PartyWithMembers,
    PartyMemberWithCharacter,
    MemberRole,
    PartyStatus
} from '../../schema/party.js';

interface PartyRow {
    id: string;
    name: string;
    description: string | null;
    world_id: string | null;
    status: string;
    current_location: string | null;
    current_quest_id: string | null;
    formation: string;
    created_at: string;
    updated_at: string;
    last_played_at: string | null;
    position_x: number | null;
    position_y: number | null;
    current_poi: string | null;
}

interface PartyMemberRow {
    id: string;
    party_id: string;
    character_id: string;
    role: string;
    is_active: number;
    position: number | null;
    share_percentage: number;
    joined_at: string;
    notes: string | null;
    loyalty?: number | null;
    wage?: number | null;
    pay_mode?: string | null;
    unit_models?: number | null;
}

// Row returned from the join query with character data
interface PartyMemberWithCharacterRow extends PartyMemberRow {
    char_id: string;
    char_name: string;
    stats: string;
    hp: number;
    max_hp: number;
    ac: number;
    level: number;
    behavior: string | null;
    character_type: string | null;
    race: string | null;
    character_class: string | null;
}

export class PartyRepository {
    constructor(private db: Database.Database) {}
    // FINDINGS #78: party notes REMOVED by GM ruling — the #76 surfacing was
    // sound at every layer it touched, but the tool's inner UpdateSchema never
    // carried the field, so nothing ever reached this repo (family appearance
    // eight, the strip one layer above the fix). Rather than complete the
    // wire, the field is gone: no consumer, and campaign text lives in the
    // narrative layer. The parties.notes column added by the #76 self-ALTER
    // stays in existing DBs as harmless dead weight (SQLite column drops
    // aren't worth the ceremony); nothing reads or writes it.

    // ========== Party CRUD ==========

    create(party: Party): Party {
        const validated = PartySchema.parse(party);
        
        const stmt = this.db.prepare(`
            INSERT INTO parties (id, name, description, world_id, status, current_location, 
                current_quest_id, formation, position_x, position_y, current_poi, created_at, updated_at, last_played_at)
            VALUES (@id, @name, @description, @worldId, @status, @currentLocation, 
                @currentQuestId, @formation, @positionX, @positionY, @currentPOI, @createdAt, @updatedAt, @lastPlayedAt)
        `);

        stmt.run({
            id: validated.id,
            name: validated.name,
            description: validated.description || null,
            worldId: validated.worldId || null,
            status: validated.status,
            currentLocation: validated.currentLocation || null,
            currentQuestId: validated.currentQuestId || null,
            formation: validated.formation,
            positionX: validated.positionX ?? null,
            positionY: validated.positionY ?? null,
            currentPOI: validated.currentPOI || null,
            createdAt: validated.createdAt,
            updatedAt: validated.updatedAt,
            lastPlayedAt: validated.lastPlayedAt || null,
        });

        return validated;
    }

    /**
     * FINDINGS #75: canonical-id resolve — exact, then prefix (≥6 chars,
     * unique-or-nothing). Every member/position/touch method resolves through
     * this FIRST and runs its SQL against the FULL id, because #74's half-wire
     * proved findById alone resolves the parent while the member queries
     * silently return an empty roster for a short id — reported as success.
     */
    private resolveFullId(partyId: string): string | null {
        const p = this.findById(partyId);
        return p ? p.id : null;
    }

    /**
     * FINDINGS #76: THE RESIDUAL — characterId gets the same law as partyId.
     * The #75 sweep canonicalised the party side of every member operation and
     * left the character side raw: prefix party + prefix character refused
     * loudly ('Member not found in party') — the honest failure shape, but
     * still a failure. Characters table, exact then prefix, ≥6 chars,
     * unique-or-nothing.
     */
    private resolveCharacterId(characterId: string): string {
        const exact = this.db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId) as { id: string } | undefined;
        if (exact) return exact.id;
        if (characterId.length >= 6 && characterId.length < 36) {
            const hits = this.db.prepare('SELECT id FROM characters WHERE id LIKE ? LIMIT 2').all(`${characterId}%`) as { id: string }[];
            if (hits.length === 1) return hits[0].id;
        }
        return characterId;
    }

    findById(id: string): Party | null {
        const stmt = this.db.prepare('SELECT * FROM parties WHERE id = ?');
        const row = stmt.get(id) as PartyRow | undefined;
        
        if (!row) {
            // FINDINGS #70: truncated-UUID rescue — the 8-char short forms in
            // every handoff block resolve when unambiguous. ≥6 chars, exactly
            // one match or nothing; two hits stay not-found, never a guess.
            // Lives in findById so getPartyWithMembers and every tool routed
            // through it (party_manage, travel, combat includeParty) inherit.
            if (id.length >= 6 && id.length < 36) {
                const hits = this.db.prepare('SELECT * FROM parties WHERE id LIKE ? LIMIT 2').all(`${id}%`) as PartyRow[];
                if (hits.length === 1) return this.rowToParty(hits[0]);
            }
            return null;
        }
        return this.rowToParty(row);
    }

    findAll(filters?: { status?: PartyStatus; worldId?: string }): Party[] {
        let query = 'SELECT * FROM parties WHERE 1=1';
        const params: any[] = [];

        if (filters?.status) {
            query += ' AND status = ?';
            params.push(filters.status);
        }
        if (filters?.worldId) {
            query += ' AND world_id = ?';
            params.push(filters.worldId);
        }

        query += ' ORDER BY last_played_at DESC NULLS LAST, updated_at DESC';

        const stmt = this.db.prepare(query);
        const rows = stmt.all(...params) as PartyRow[];
        return rows.map(row => this.rowToParty(row));
    }

    update(id: string, updates: Partial<Party>): Party | null {
        const existing = this.findById(id);
        if (!existing) return null;

        const updated = {
            ...existing,
            ...updates,
            updatedAt: new Date().toISOString()
        };

        const validated = PartySchema.parse(updated);

        const stmt = this.db.prepare(`
            UPDATE parties SET 
                name = ?, description = ?, world_id = ?, status = ?, 
                current_location = ?, current_quest_id = ?, formation = ?,
                position_x = ?, position_y = ?, current_poi = ?,
                updated_at = ?, last_played_at = ?
            WHERE id = ?
        `);

        stmt.run(
            validated.name,
            validated.description || null,
            validated.worldId || null,
            validated.status,
            validated.currentLocation || null,
            validated.currentQuestId || null,
            validated.formation,
            validated.positionX ?? null,
            validated.positionY ?? null,
            validated.currentPOI || null,
            validated.updatedAt,
            validated.lastPlayedAt || null,
            // FINDINGS #75-A: existing.id, never the raw argument — a
            // prefix-called update matched zero rows and returned the merged
            // object AS IF WRITTEN. Accept-then-discard, write-shaped.
            existing.id
        );

        return validated;
    }

    delete(id: string): boolean {
        const stmt = this.db.prepare('DELETE FROM parties WHERE id = ?');
        const result = stmt.run(this.resolveFullId(id) ?? id);
        return result.changes > 0;
    }

    // ========== Party Members ==========

    addMember(member: PartyMember): PartyMember {
        const validated = PartyMemberSchema.parse({
            ...member,
            partyId: this.resolveFullId(member.partyId) ?? member.partyId,
            characterId: this.resolveCharacterId(member.characterId)
        });

        const stmt = this.db.prepare(`
            INSERT INTO party_members (id, party_id, character_id, role, is_active, 
                position, share_percentage, joined_at, notes, loyalty, wage, pay_mode, unit_models)
            VALUES (@id, @partyId, @characterId, @role, @isActive, 
                @position, @sharePercentage, @joinedAt, @notes, @loyalty, @wage, @payMode, @unitModels)
        `);

        stmt.run({
            id: validated.id,
            partyId: validated.partyId,
            characterId: validated.characterId,
            role: validated.role,
            isActive: validated.isActive ? 1 : 0,
            position: validated.position ?? null,
            sharePercentage: validated.sharePercentage,
            joinedAt: validated.joinedAt,
            notes: validated.notes || null,
            loyalty: validated.loyalty ?? null,
            wage: validated.wage ?? null,
            payMode: validated.payMode ?? null,
            unitModels: validated.unitModels ?? null,
        });

        return validated;
    }

    removeMember(partyId: string, characterId: string): boolean {
        const pid = this.resolveFullId(partyId) ?? partyId;
        const stmt = this.db.prepare(
            'DELETE FROM party_members WHERE party_id = ? AND character_id = ?'
        );
        const result = stmt.run(pid, this.resolveCharacterId(characterId));
        return result.changes > 0;
    }

    updateMember(partyId: string, characterId: string, updates: Partial<PartyMember>): PartyMember | null {
        // FINDINGS #75-A: findMember resolves the prefix, so the read SUCCEEDS —
        // then the UPDATE ran against the raw argument, matched zero rows, and
        // returned the merged object as if written. Resolve once, write with it.
        // FINDINGS #76: both halves of the key resolve now.
        const pid = this.resolveFullId(partyId) ?? partyId;
        const cid = this.resolveCharacterId(characterId);
        const existing = this.findMember(pid, cid);
        if (!existing) return null;

        const updated = {
            ...existing,
            ...updates,
        };

        const stmt = this.db.prepare(`
            UPDATE party_members SET 
                role = ?, is_active = ?, position = ?, 
                share_percentage = ?, notes = ?,
                loyalty = ?, wage = ?, pay_mode = ?, unit_models = ?
            WHERE party_id = ? AND character_id = ?
        `);

        stmt.run(
            updated.role,
            updated.isActive ? 1 : 0,
            updated.position ?? null,
            updated.sharePercentage,
            updated.notes || null,
            updated.loyalty ?? null,
            updated.wage ?? null,
            updated.payMode ?? null,
            updated.unitModels ?? null,
            pid,
            cid
        );

        return updated;
    }

    findMember(partyId: string, characterId: string): PartyMember | null {
        const stmt = this.db.prepare(
            'SELECT * FROM party_members WHERE party_id = ? AND character_id = ?'
        );
        const row = stmt.get(this.resolveFullId(partyId) ?? partyId, this.resolveCharacterId(characterId)) as PartyMemberRow | undefined;
        
        if (!row) return null;
        return this.rowToMember(row);
    }

    findMembersByParty(partyId: string): PartyMember[] {
        const stmt = this.db.prepare(
            'SELECT * FROM party_members WHERE party_id = ? ORDER BY position ASC NULLS LAST, joined_at ASC'
        );
        const rows = stmt.all(this.resolveFullId(partyId) ?? partyId) as PartyMemberRow[];
        return rows.map(row => this.rowToMember(row));
    }

    findPartiesByCharacter(characterId: string): Party[] {
        const cid = this.resolveCharacterId(characterId);
        const stmt = this.db.prepare(`
            SELECT p.* FROM parties p
            INNER JOIN party_members pm ON p.id = pm.party_id
            WHERE pm.character_id = ?
            ORDER BY p.last_played_at DESC NULLS LAST
        `);
        const rows = stmt.all(cid) as PartyRow[];
        return rows.map(row => this.rowToParty(row));
    }

    // ========== Complex Queries ==========

    setLeader(partyId: string, characterId: string): boolean {
        const pid = this.resolveFullId(partyId) ?? partyId;
        const cid = this.resolveCharacterId(characterId);
        // First, demote any existing leader to member
        this.db.prepare(`
            UPDATE party_members SET role = 'member' 
            WHERE party_id = ? AND role = 'leader'
        `).run(pid);

        // Promote new leader
        const stmt = this.db.prepare(`
            UPDATE party_members SET role = 'leader' 
            WHERE party_id = ? AND character_id = ?
        `);
        const result = stmt.run(pid, cid);
        return result.changes > 0;
    }

    setActiveCharacter(partyId: string, characterId: string): boolean {
        const pid = this.resolveFullId(partyId) ?? partyId;
        const cid = this.resolveCharacterId(characterId);
        // First, clear any existing active character
        this.db.prepare(`
            UPDATE party_members SET is_active = 0 
            WHERE party_id = ? AND is_active = 1
        `).run(pid);

        // Set new active character
        const stmt = this.db.prepare(`
            UPDATE party_members SET is_active = 1 
            WHERE party_id = ? AND character_id = ?
        `);
        const result = stmt.run(pid, cid);
        return result.changes > 0;
    }

    getPartyWithMembers(partyId: string): PartyWithMembers | null {
        const party = this.findById(partyId);
        if (!party) return null;
        // FINDINGS #75: the member query runs against party.id — the RESOLVED
        // full id — never the raw argument. The half-wire (resolved parent,
        // silently empty roster, reported success) is structurally dead.

        // Get all members with their character data
        const stmt = this.db.prepare(`
            SELECT 
                pm.id, pm.party_id, pm.character_id, pm.role, pm.is_active, 
                pm.position, pm.share_percentage, pm.joined_at, pm.notes,
                pm.loyalty, pm.wage, pm.pay_mode, pm.unit_models,
                c.id as char_id, c.name as char_name, c.stats, c.hp, c.max_hp, 
                c.ac, c.level, c.behavior, c.character_type, c.race, c.character_class
            FROM party_members pm
            INNER JOIN characters c ON pm.character_id = c.id
            WHERE pm.party_id = ?
            ORDER BY 
                CASE pm.role WHEN 'leader' THEN 0 ELSE 1 END,
                pm.position ASC NULLS LAST,
                pm.joined_at ASC
        `);

        const rows = stmt.all(party.id) as PartyMemberWithCharacterRow[];
        
        const members: PartyMemberWithCharacter[] = rows.map(row => ({
            id: row.id,
            partyId: row.party_id,
            characterId: row.character_id,
            role: row.role as MemberRole,
            isActive: row.is_active === 1,
            position: row.position ?? undefined,
            sharePercentage: row.share_percentage,
            joinedAt: row.joined_at,
            notes: row.notes ?? undefined,
            ...(row.loyalty != null ? { loyalty: row.loyalty } : {}),
            ...(row.wage != null ? { wage: row.wage } : {}),
            ...(row.pay_mode != null ? { payMode: row.pay_mode as 'wage' | 'share' | 'none' } : {}),
            ...(row.unit_models != null ? { unitModels: row.unit_models } : {}),
            character: {
                id: row.char_id,
                name: row.char_name,
                hp: row.hp,
                maxHp: row.max_hp,
                ac: row.ac,
                level: row.level,
                stats: JSON.parse(row.stats),
                behavior: row.behavior ?? undefined,
                characterType: (row.character_type as any) ?? undefined,
                race: row.race ?? undefined,
                class: row.character_class ?? undefined,
            }
        }));

        const leader = members.find(m => m.role === 'leader');
        const activeCharacter = members.find(m => m.isActive);

        return {
            ...party,
            members,
            leader,
            activeCharacter,
            memberCount: members.length,
        };
    }

    getUnassignedCharacters(excludeTypes?: string[]): { id: string; name: string; level: number; characterType: string | null; race: string | null; class: string | null }[] {
        let query = `
            SELECT c.id, c.name, c.level, c.character_type as characterType, c.race, c.character_class as class
            FROM characters c
            LEFT JOIN party_members pm ON c.id = pm.character_id
            WHERE pm.id IS NULL
        `;
        
        const params: any[] = [];
        
        if (excludeTypes && excludeTypes.length > 0) {
            query += ` AND (c.character_type IS NULL OR c.character_type NOT IN (${excludeTypes.map(() => '?').join(', ')}))`;
            params.push(...excludeTypes);
        }
        
        query += ' ORDER BY c.name ASC';

        const stmt = this.db.prepare(query);
        return stmt.all(...params) as { id: string; name: string; level: number; characterType: string | null; race: string | null; class: string | null }[];
    }

    // ========== Touch for activity tracking ==========

    touchParty(partyId: string): void {
        const now = new Date().toISOString();
        this.db.prepare(`
            UPDATE parties SET last_played_at = ?, updated_at = ? WHERE id = ?
        `).run(now, now, this.resolveFullId(partyId) ?? partyId);
    }

    // ========== Party Position Management ==========

    updatePartyPosition(
        partyId: string,
        x: number,
        y: number,
        locationName: string,
        poiId?: string
    ): Party | null {
        // FINDINGS #73: this method ran raw SQL by exact id and BYPASSED
        // findById — so the #70 prefix rescue never applied to move/travel.
        // Resolve first (exact-or-prefix), then write against the full id.
        const resolved = this.findById(partyId);
        if (!resolved) {
            throw new Error(`Party not found: ${partyId}`);
        }
        const stmt = this.db.prepare(`
            UPDATE parties 
            SET position_x = ?, position_y = ?, current_location = ?, 
                current_poi = ?, updated_at = ?
            WHERE id = ?
            RETURNING *
        `);

        const result = stmt.get(x, y, locationName, poiId || null, new Date().toISOString(), resolved.id) as PartyRow | undefined;
        
        if (!result) {
            throw new Error(`Party not found: ${partyId}`);
        }

        return this.rowToParty(result);
    }

    getPartyPosition(partyId: string): { x: number; y: number; locationName: string; poiId?: string } | null {
        // FINDINGS #73: resolve exact-or-prefix before the raw-SQL read.
        const resolved = this.findById(partyId);
        if (!resolved) return null;
        const stmt = this.db.prepare(`
            SELECT position_x, position_y, current_location, current_poi
            FROM parties
            WHERE id = ?
        `);

        const result = stmt.get(resolved.id) as any;
        if (!result || result.position_x === null) {
            return null;
        }

        return {
            x: result.position_x,
            y: result.position_y,
            locationName: result.current_location || 'Unknown Location',
            poiId: result.current_poi || undefined,
        };
    }

    getPartiesWithPositions(worldId: string): Array<Party & { position: { x: number; y: number; locationName: string; poiId?: string } }> {
        const stmt = this.db.prepare(`
            SELECT * FROM parties
            WHERE world_id = ? AND position_x IS NOT NULL
            ORDER BY updated_at DESC
        `);

        const results = stmt.all(worldId) as PartyRow[];

        return results.map((row) => ({
            ...this.rowToParty(row),
            position: {
                x: row.position_x || 0,
                y: row.position_y || 0,
                locationName: row.current_location || 'Unknown Location',
                poiId: row.current_poi || undefined,
            },
        }));
    }

    getPartiesNearPosition(
        worldId: string,
        x: number,
        y: number,
        radiusSquares: number = 3
    ): Party[] {
        const stmt = this.db.prepare(`
            SELECT * FROM parties
            WHERE world_id = ?
                AND position_x IS NOT NULL
                AND ABS(position_x - ?) <= ?
                AND ABS(position_y - ?) <= ?
            ORDER BY (position_x - ?) * (position_x - ?) +
                     (position_y - ?) * (position_y - ?)
        `);

        const results = stmt.all(worldId, x, radiusSquares, y, radiusSquares, x, x, y, y) as PartyRow[];

        return results.map(row => this.rowToParty(row));
    }

    // ========== Row converters ==========

    private rowToParty(row: PartyRow): Party {
        return PartySchema.parse({
            id: row.id,
            name: row.name,
            description: row.description ?? undefined,
            worldId: row.world_id ?? undefined,
            status: row.status,
            currentLocation: row.current_location ?? undefined,
            currentQuestId: row.current_quest_id ?? undefined,
            formation: row.formation,
            positionX: (row as any).position_x ?? undefined,
            positionY: (row as any).position_y ?? undefined,
            currentPOI: (row as any).current_poi ?? undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastPlayedAt: row.last_played_at ?? undefined,
        });
    }

    private rowToMember(row: PartyMemberRow): PartyMember {
        return PartyMemberSchema.parse({
            id: row.id,
            partyId: row.party_id,
            characterId: row.character_id,
            role: row.role,
            isActive: row.is_active === 1,
            position: row.position ?? undefined,
            sharePercentage: row.share_percentage,
            joinedAt: row.joined_at,
            notes: row.notes ?? undefined,
            ...(row.loyalty != null ? { loyalty: row.loyalty } : {}),
            ...(row.wage != null ? { wage: row.wage } : {}),
            ...(row.pay_mode != null ? { payMode: row.pay_mode } : {}),
            ...(row.unit_models != null ? { unitModels: row.unit_models } : {}),
        });
    }
}
