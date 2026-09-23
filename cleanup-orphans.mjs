// cleanup-orphans.mjs — one-shot DB hygiene for Escape from Pripyat.
// Deletes rows pointing at characters that no longer exist (wipe residue,
// the poisoned-trait orphan, scratch-test leftovers).
//
// RUN WITH CLAUDE DESKTOP FULLY QUIT:
//   cd C:\Users\Tom\mnehmos.rpg.mcp
//   node cleanup-orphans.mjs
//
import Database from 'better-sqlite3';
import { join } from 'path';

const dbPath = join(process.env.APPDATA, 'rpg-mcp', 'rpg.db');
const db = new Database(dbPath);
console.log(`[cleanup] ${dbPath}\n`);

const sweeps = [
    ['custom_effects', 'target_id'],
    ['inventory_items', 'character_id'],
    ['npc_relationships', 'npc_id'],
    ['npc_relationships', 'character_id'],
    ['auras', 'owner_id'],
];

let total = 0;

// Probe corpses with no world (parked at 0,0, unreachable) — sweep them and
// their inventory rows.
try {
    const ghosts = db.prepare("SELECT id, character_name FROM corpses WHERE world_id IS NULL").all();
    for (const g of ghosts) console.log(`  GHOST corpse ${g.id} (${g.character_name}) — null worldId`);
    if (ghosts.length) {
        db.prepare("DELETE FROM corpse_inventory WHERE corpse_id IN (SELECT id FROM corpses WHERE world_id IS NULL)").run();
        const r = db.prepare("DELETE FROM corpses WHERE world_id IS NULL").run();
        console.log(`corpses (null world): deleted ${r.changes}`);
        total += r.changes;
    } else {
        console.log('corpses (null world): clean');
    }
} catch (e) {
    console.log(`corpses (null world): skipped (${e.message.split('\n')[0]})`);
}

for (const [table, col] of sweeps) {
    try {
        const orphans = db.prepare(
            `SELECT rowid, * FROM ${table} WHERE ${col} IS NOT NULL
             AND ${col} NOT IN (SELECT id FROM characters)`
        ).all();
        if (orphans.length === 0) {
            console.log(`${table}.${col}: clean`);
            continue;
        }
        for (const o of orphans) {
            const label = o.name || o.item_id || o.id || o.rowid;
            console.log(`  ORPHAN ${table}.${col} -> ${label} (dead ref ${o[col]})`);
        }
        const r = db.prepare(
            `DELETE FROM ${table} WHERE ${col} IS NOT NULL
             AND ${col} NOT IN (SELECT id FROM characters)`
        ).run();
        console.log(`${table}.${col}: deleted ${r.changes}`);
        total += r.changes;
    } catch (e) {
        console.log(`${table}.${col}: skipped (${e.message.split('\n')[0]})`);
    }
}

db.close();
console.log(`\n[cleanup] done — ${total} orphaned row(s) removed.`);
