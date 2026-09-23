// rename-regions.mjs — kill the "Region 1" off-by-one at the source: name the
// engine's region rows after the spine, so every banner speaks the fiction.
// Claims and IDs are untouched (FKs bind to ids, not names).
//
// RUN WITH CLAUDE DESKTOP FULLY QUIT:
//   cd C:\Users\Tom\mnehmos.rpg.mcp
//   node rename-regions.mjs
//
import Database from 'better-sqlite3';
import { join } from 'path';

const dbPath = join(process.env.APPDATA, 'rpg-mcp', 'rpg.db');
const db = new Database(dbPath);
const WORLD = 'world-pripyat-01-1786243224217';

const SPINE = {
    [`${WORLD}:0`]: 'Cordon',
    [`${WORLD}:1`]: 'Wild Territory',
    [`${WORLD}:2`]: 'Yantar',
    [`${WORLD}:3`]: 'Pripyat / NPP',
    [`${WORLD}:4`]: 'Agroprom',
    [`${WORLD}:5`]: 'Rostok',
    [`${WORLD}:6`]: 'Radar',
    [`${WORLD}:7`]: 'Red Forest',
    [`${WORLD}:8`]: 'Garbage / Dark Valley',
    [`${WORLD}:9`]: 'Army Warehouses',
};

const upd = db.prepare('UPDATE regions SET name = ? WHERE id = ?');
let n = 0;
for (const [id, name] of Object.entries(SPINE)) {
    const r = upd.run(name, id);
    if (r.changes) { console.log(`  ${id}  ->  ${name}`); n += r.changes; }
    else console.log(`  ${id}  MISSING (no row)`);
}
db.close();
console.log(`\n[rename] ${n} region(s) named after the spine. "Region 1" is dead.`);
