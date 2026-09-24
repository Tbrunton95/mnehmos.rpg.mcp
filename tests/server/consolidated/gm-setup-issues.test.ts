/**
 * Issues a GM hit during KALMIS setup: decimal gold broke every read of the
 * row, batched steps with array params were refused without saying where,
 * and a character's world tag could not be read back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleCharacterManage } from '../../../src/server/consolidated/character-manage.js';
import { handleInventoryManage } from '../../../src/server/consolidated/inventory-manage.js';
import { handleBatchManage } from '../../../src/server/consolidated/batch-manage.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const ctx = { sessionId: 'gm-setup' } as any;
const W = 'kalmis';
const json = (res: { content: Array<{ text: string }> }, tag: string) =>
    JSON.parse(res.content[0].text.match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`))![1]);

describe('GM setup issues', () => {
    beforeEach(() => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'KALMIS', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        const repo = new CharacterRepository(db);
        for (const id of ['luciel', 'drifter']) {
            repo.create({
                id, name: id, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
                hp: 10, maxHp: 10, ac: 10, level: 1, createdAt: now, updatedAt: now
            } as any);
        }
    });
    afterEach(() => closeDb());

    it('decimal gold keeps the row readable, listable and writable', async () => {
        await handleCharacterManage({ action: 'update', characterId: 'luciel', worldId: W }, ctx);
        await handleInventoryManage({ action: 'add_currency', characterId: 'luciel', amount: 2.5 }, ctx);

        const got = json(await handleCharacterManage({ action: 'get', characterId: 'luciel' }, ctx), 'CHARACTER_MANAGE');
        expect(got.error).toBeUndefined();
        expect(got.currency.gold).toBe(2.5);

        const list = json(await handleCharacterManage({ action: 'list', worldId: W }, ctx), 'CHARACTER_MANAGE');
        expect(list.error).toBeUndefined();
        expect(JSON.stringify(list)).toMatch(/luciel/);

        const upd = json(await handleCharacterManage({ action: 'update', characterId: 'luciel', hp: 9 }, ctx), 'CHARACTER_MANAGE');
        expect(upd.error).toBeUndefined();
    });

    it('get carries the world tag, null when untagged', async () => {
        await handleCharacterManage({ action: 'update', characterId: 'luciel', worldId: W }, ctx);
        const tagged = json(await handleCharacterManage({ action: 'get', characterId: 'luciel' }, ctx), 'CHARACTER_MANAGE');
        expect(tagged.worldId).toBe(W);
        const untagged = json(await handleCharacterManage({ action: 'get', characterId: 'drifter' }, ctx), 'CHARACTER_MANAGE');
        expect(untagged.worldId).toBeNull();
    });

    it('batch runs precedent, knowledge and table_rules steps', async () => {
        const res = json(await handleBatchManage({ action: 'execute_sequence', atomic: true, steps: [
            { tool: 'precedent_manage', args: { action: 'record', worldId: W, kind: 'ruling', statement: "Flight is the Warp's", scope: 'flight' } },
            { tool: 'knowledge_manage', args: { action: 'record', worldId: W, key: 'name-quarter-1', statement: 'The first quarter of the name' } },
            { tool: 'table_rules', args: { action: 'import', worldId: W, preset: 'day-366' } }
        ] }, ctx), 'BATCH_MANAGE');
        expect(res.successCount).toBe(3);
    });

    it('a batched array param is refused naming the tool, the action and the rollback', async () => {
        const res = json(await handleBatchManage({ action: 'execute_sequence', atomic: true, steps: [
            { tool: 'precedent_manage', args: { action: 'record', worldId: W, kind: 'ruling', statement: 'x', tags: ['flight'] } }
        ] }, ctx), 'BATCH_MANAGE');
        const err = String(res.steps[0].error);
        expect(err).toMatch(/precedent_manage record/);
        expect(err).toMatch(/tags/);
        expect(err).toMatch(/call precedent_manage directly/);
    });
});
