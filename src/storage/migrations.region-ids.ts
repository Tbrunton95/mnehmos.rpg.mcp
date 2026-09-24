import type Database from 'better-sqlite3';
import { generatedRegionRowId } from './repos/region.repo.js';

/**
 * Region rows once carried two id formats. Generation writes
 * `${worldId}:region:${n}`; the seed-restore path in server/tools.ts wrote
 * `${worldId}:${n}` for worlds that predate durable snapshots. A generated
 * world restored that way got both sets, and a campaign that only ever came
 * through the restore path (pripyat) holds only the legacy set — with nation
 * ownership and territorial claims pointing at it.
 *
 * Each legacy row is renamed to the generation id, or folded into the
 * generation row when one already exists (that row keeps its owner if it has
 * one; a nation's duplicate claim on it is dropped). Every column that
 * foreign-keys regions(id), and every plain `region_id` column (structures,
 * corpses), moves with the row. The new row is written before references move
 * and the legacy row deleted after, so ON DELETE CASCADE never reaches a claim.
 *
 * One transaction per world; a second run finds nothing to do. Throws on
 * failure, leaving that world's rows untouched. Returns rows moved.
 */
export function canonicalizeLegacyRegionIds(db: Database.Database, worldId: string): number {
    const prefix = `${worldId}:`;
    const legacyIds = (db.prepare('SELECT id FROM regions WHERE world_id = ?').all(worldId) as Array<{ id: string }>)
        .map(row => row.id)
        .filter(id => id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)));
    if (legacyIds.length === 0) return 0;

    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const regionColumns = (db.pragma('table_info(regions)') as Array<{ name: string }>).map(col => col.name);
    const copyRow = db.prepare(`
        INSERT INTO regions (${regionColumns.map(quote).join(', ')})
        SELECT ${regionColumns.map(col => (col === 'id' ? '?' : quote(col))).join(', ')} FROM regions WHERE id = ?
    `);
    const repoint = regionReferenceColumns(db).map(({ table, column }) =>
        db.prepare(`UPDATE ${quote(table)} SET ${quote(column)} = ? WHERE ${quote(column)} = ?`));
    const findRow = db.prepare('SELECT owner_nation_id AS owner, control_level AS control FROM regions WHERE id = ?');
    const adoptOwner = db.prepare('UPDATE regions SET owner_nation_id = ?, control_level = ? WHERE id = ? AND owner_nation_id IS NULL');
    const dropDuplicateClaims = db.prepare(`
        DELETE FROM territorial_claims
        WHERE region_id = ? AND nation_id IN (SELECT nation_id FROM territorial_claims WHERE region_id = ?)
    `);
    const deleteRow = db.prepare('DELETE FROM regions WHERE id = ?');

    db.transaction(() => {
        for (const legacyId of legacyIds) {
            const canonicalId = generatedRegionRowId(worldId, legacyId.slice(prefix.length));
            if (!findRow.get(canonicalId)) {
                copyRow.run(canonicalId, legacyId);
            } else {
                const legacy = findRow.get(legacyId) as { owner: string | null; control: number };
                if (legacy.owner) adoptOwner.run(legacy.owner, legacy.control, canonicalId);
                dropDuplicateClaims.run(legacyId, canonicalId);
            }
            for (const statement of repoint) statement.run(canonicalId, legacyId);
            deleteRow.run(legacyId);
        }
    })();
    return legacyIds.length;
}

/** Every (table, column) that holds a regions.id, declared foreign key or not. */
function regionReferenceColumns(db: Database.Database): Array<{ table: string; column: string }> {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
        .map(row => row.name)
        .filter(name => name !== 'regions');
    const found = new Map<string, { table: string; column: string }>();
    for (const table of tables) {
        const escaped = table.replace(/"/g, '""');
        for (const fk of db.pragma(`foreign_key_list("${escaped}")`) as Array<{ table: string; from: string }>) {
            if (fk.table === 'regions') found.set(`${table}.${fk.from}`, { table, column: fk.from });
        }
        for (const col of db.pragma(`table_info("${escaped}")`) as Array<{ name: string }>) {
            if (col.name === 'region_id') found.set(`${table}.region_id`, { table, column: 'region_id' });
        }
    }
    return [...found.values()];
}

/** Startup pass over every world; a world that fails is logged and left as it was. */
export function migrateLegacyRegionIds(db: Database.Database): void {
    const worldIds = (db.prepare('SELECT DISTINCT world_id AS worldId FROM regions').all() as Array<{ worldId: string }>)
        .map(row => row.worldId);
    for (const worldId of worldIds) {
        try {
            const moved = canonicalizeLegacyRegionIds(db, worldId);
            if (moved > 0) {
                console.error(`[Migration] Moved ${moved} legacy region id(s) to ${generatedRegionRowId(worldId, '<n>')}`);
            }
        } catch (e) {
            console.error(`[Migration] Legacy region ids for world ${worldId} left as-is:`, (e as Error).message);
        }
    }
}
