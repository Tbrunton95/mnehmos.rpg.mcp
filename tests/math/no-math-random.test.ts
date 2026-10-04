import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Crypto dice by default means no die anywhere in the tool layer or the
 * magic engine comes from Math.random. Dice roll through loggedRoll /
 * loggedD20 (logged, crypto by default) or cryptoInt (engine fallbacks);
 * ids come from node:crypto. A new Math.random( under these trees fails here.
 */
const ROOT = join(__dirname, '..', '..');
const TREES = ['src/server', 'src/engine/magic'];

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
    }
    return out;
}

describe('no Math.random under src/server and src/engine/magic', () => {
    it('finds no Math.random( call', () => {
        const offenders: string[] = [];
        for (const tree of TREES) {
            for (const file of walk(join(ROOT, tree))) {
                const lines = readFileSync(file, 'utf8').split('\n');
                lines.forEach((line, i) => {
                    if (line.includes('Math.random(')) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
                });
            }
        }
        expect(offenders).toEqual([]);
    });
});
