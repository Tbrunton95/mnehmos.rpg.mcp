import { CombatEngine } from '../../src/engine/combat/engine.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { clearCombatState, handleExecuteCombatAction } from '../../src/server/handlers/combat-handlers.js';
import { EncounterRepository } from '../../src/storage/repos/encounter.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import {
    SIZE_ORDER, SIZE_TABLE, sizeRank, effectiveReachFt, footprintCells, edgeDistanceSquares
} from '../../src/schema/encounter.js';

const ctx = { sessionId: 'size' };
const json = (res: any, tag: string) => JSON.parse(res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`))![1]);

/**
 * Item 6: size was carried on tokens but nothing read it. It now drives
 * reach (opportunity attacks), the squares a creature fills (movement) and
 * travels from creature presets through spawn_quick_enemy.
 */
describe('size module', () => {
    it('ranks sizes and reads the table', () => {
        expect(SIZE_ORDER[0]).toBe('tiny');
        expect(sizeRank('large')).toBeGreaterThan(sizeRank('medium'));
        expect(sizeRank(undefined)).toBe(sizeRank('medium'));
        expect(sizeRank('LARGE')).toBe(sizeRank('large'));
        expect(SIZE_TABLE.huge).toEqual({ squares: 3, reachFt: 10 });
        expect(SIZE_TABLE.large.squares).toBe(2);
    });

    it('reach: attack profile beats token reach beats size', () => {
        expect(effectiveReachFt({})).toBe(5);
        expect(effectiveReachFt({ size: 'huge' })).toBe(10);
        expect(effectiveReachFt({ size: 'huge', reach: 15 })).toBe(15);
        expect(effectiveReachFt({ size: 'medium', reach: 10 }, { reachFt: 20 })).toBe(20);
    });

    it('footprint cells and edge distance between footprints', () => {
        expect(footprintCells({ position: { x: 5, y: 5 }, size: 'large' })).toEqual([
            { x: 5, y: 5 }, { x: 6, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }
        ]);
        expect(footprintCells({ position: { x: 1, y: 1 } })).toEqual([{ x: 1, y: 1 }]);
        expect(footprintCells({})).toEqual([]);
        const ogre = { position: { x: 0, y: 0 }, size: 'large' as const };
        expect(edgeDistanceSquares(ogre, { position: { x: 2, y: 0 } })).toBe(1);
        expect(edgeDistanceSquares(ogre, { position: { x: 3, y: 1 } })).toBe(2);
        expect(edgeDistanceSquares({ position: { x: 0, y: 0 } }, { position: { x: 1, y: 1 } })).toBe(1);
    });
});

describe('opportunity attacks read reach and footprint', () => {
    const fight = (attacker: Record<string, unknown>) => {
        const e = new CombatEngine('oa-size');
        e.startEncounter([
            { id: 'brute', name: 'Brute', initiativeBonus: 0, hp: 100, maxHp: 100, conditions: [], isEnemy: true, position: { x: 0, y: 0 }, ...attacker },
            { id: 'hero', name: 'Hero', initiativeBonus: 0, hp: 100, maxHp: 100, conditions: [], isEnemy: false }
        ] as any);
        return e;
    };

    it('a large creature threatens from its whole footprint', () => {
        // Large at (0,0) fills x 0-1: (2,0) is adjacent to its edge.
        expect(fight({ size: 'large' }).getOpportunityAttackers('hero', { x: 2, y: 0 }, { x: 3, y: 0 }).map(p => p.id)).toEqual(['brute']);
        // A medium creature at (0,0) never threatened (2,0).
        expect(fight({}).getOpportunityAttackers('hero', { x: 2, y: 0 }, { x: 3, y: 0 })).toEqual([]);
    });

    it('a huge creature reaches 10 ft; a reach override counts', () => {
        // Huge fills x 0-2: (4,1) is 2 squares (10 ft) from its edge.
        expect(fight({ size: 'huge' }).getOpportunityAttackers('hero', { x: 4, y: 1 }, { x: 6, y: 1 }).map(p => p.id)).toEqual(['brute']);
        expect(fight({ reach: 10 }).getOpportunityAttackers('hero', { x: 2, y: 0 }, { x: 3, y: 0 }).map(p => p.id)).toEqual(['brute']);
        // Still within 10 ft at the end: no attack.
        expect(fight({ reach: 10 }).getOpportunityAttackers('hero', { x: 1, y: 0 }, { x: 2, y: 0 })).toEqual([]);
    });

    it('medium creatures keep the old adjacency', () => {
        expect(fight({}).getOpportunityAttackers('hero', { x: 1, y: 1 }, { x: 3, y: 1 }).map(p => p.id)).toEqual(['brute']);
    });
});

describe('footprints block movement', () => {
    let encounterId: string;
    beforeEach(async () => {
        closeDb(); getDb(':memory:'); clearCombatState();
        const created = json(await handleCombatManage({ action: 'create', seed: 'size-move', participants: [
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20, position: { x: 0, y: 0 } },
            { id: 'ogre', name: 'Ogre', hp: 60, maxHp: 60, initiative: 5, isEnemy: true, size: 'large', position: { x: 5, y: 5 } },
            { id: 'giant', name: 'Giant', hp: 90, maxHp: 90, initiative: 4, isEnemy: true, size: 'large', position: { x: 0, y: 5 } }
        ] }, ctx as any), 'COMBAT_MANAGE');
        encounterId = created.encounterId;
    });
    afterEach(() => closeDb());

    const pos = (id: string) => (new EncounterRepository(getDb()).loadState(encounterId)!.participants as any[]).find(p => p.id === id).position;

    it('a square inside a large token is blocked', async () => {
        const res = await handleExecuteCombatAction({ encounterId, action: 'move', actorId: 'hero', targetPosition: { x: 1, y: 1 } }, ctx as any);
        expect(res.content[0].text).toMatch(/moved|Moved/);
        const blocked = await handleExecuteCombatAction({ encounterId, action: 'move', actorId: 'hero', targetPosition: { x: 1, y: 6 } }, ctx as any);
        expect(blocked.content[0].text).toMatch(/blocked/i);
        expect(pos('hero')).toEqual({ x: 1, y: 1 });
    });

    it("a large mover's whole destination footprint must be clear", async () => {
        // Ogre to (1,5) would fill x 1-2, y 5-6 — overlapping the giant at x 0-1.
        const res = await handleExecuteCombatAction({ encounterId, action: 'move', actorId: 'ogre', targetPosition: { x: 1, y: 5 } }, ctx as any);
        expect(res.content[0].text).toMatch(/blocked/i);
        expect(pos('ogre')).toEqual({ x: 5, y: 5 });
        const ok = await handleExecuteCombatAction({ encounterId, action: 'move', actorId: 'ogre', targetPosition: { x: 3, y: 5 } }, ctx as any);
        expect(ok.content[0].text).not.toMatch(/blocked/i);
        expect(pos('ogre')).toEqual({ x: 3, y: 5 });
    });
});

describe('spawn_quick_enemy carries size, speed, damage type and CR', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => closeDb());

    it('a large preset lands as a large token', async () => {
        const res = json(await handleCombatManage({ action: 'spawn_quick_enemy', creature: 'chimera', seed: 'spawn-size' }, ctx as any), 'COMBAT_MANAGE');
        const tok = (new EncounterRepository(getDb()).loadState(res.encounterId)!.participants as any[])[0];
        expect(tok).toMatchObject({ size: 'large', movementSpeed: 50, cr: expect.any(Number) });
        expect(typeof tok.attackDamageType).toBe('string');
    });

    it('appending to an existing encounter carries them too, spaced by footprint', async () => {
        const created = json(await handleCombatManage({ action: 'create', seed: 'spawn-append', participants: [
            { id: 'hero', name: 'Hero', hp: 30, maxHp: 30, initiative: 20 }
        ] }, ctx as any), 'COMBAT_MANAGE');
        await handleCombatManage({ action: 'spawn_quick_enemy', creature: 'pseudogiant', count: 2, encounterId: created.encounterId, position: { x: 10, y: 10 } }, ctx as any);
        const toks = (new EncounterRepository(getDb()).loadState(created.encounterId)!.participants as any[]).filter(p => p.id !== 'hero');
        expect(toks).toHaveLength(2);
        for (const t of toks) expect(t).toMatchObject({ size: 'large', movementSpeed: 30, cr: 5, attackDamageType: 'bludgeoning' });
    });
});
