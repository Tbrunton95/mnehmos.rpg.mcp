/**
 * A world's lexicon: the 40k table reads Thrones and a +++ header where the
 * STALKER campaign reads RU and the ПДА badge. A world without the rule keeps
 * the STALKER words.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleCharacterManage } from '../../../src/server/consolidated/character-manage.js';
import { handleInventoryManage } from '../../../src/server/consolidated/inventory-manage.js';
import { handleTableRules } from '../../../src/server/consolidated/table-rules.js';
import { handleLedgerManage } from '../../../src/server/consolidated/ledger-manage.js';
import { handleQuestManage } from '../../../src/server/consolidated/quest-manage.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../../src/storage/index.js';

const ctx = { sessionId: 'lexicon' } as any;
const W = 'kalmis';
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const json = (r: { content: Array<{ text: string }> }, tag: string) =>
    JSON.parse(text(r).match(new RegExp(`<!-- ${tag}_JSON\\n([\\s\\S]*?)\\n${tag}_JSON -->`))![1]);

describe('world lexicon', () => {
    beforeEach(async () => {
        closeDb();
        const db = getDb(':memory:');
        const now = new Date().toISOString();
        new WorldRepository(db).create({ id: W, name: 'KALMIS', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
        new CharacterRepository(db).create({
            id: 'luciel', name: 'Luciel', stats: { str: 24, dex: 14, con: 20, int: 12, wis: 12, cha: 16 },
            hp: 150, maxHp: 200, ac: 20, level: 1, createdAt: now, updatedAt: now
        } as any);
        await handleCharacterManage({ action: 'update', characterId: 'luciel', worldId: W }, ctx);
        await handleInventoryManage({ action: 'add_currency', characterId: 'luciel', amount: 40 }, ctx);
    });
    afterEach(() => closeDb());

    it('without a lexicon the STALKER words stay', async () => {
        const got = json(await handleCharacterManage({ action: 'get', characterId: 'luciel' }, ctx), 'CHARACTER_MANAGE');
        expect(got.currencyNote).toBe('RU 40');
        const block = text(await handleCharacterManage({ action: 'get_status_block', characterId: 'luciel' }, ctx));
        expect(block).toMatch(/ПДА/);
        expect(block).toMatch(/RU/);
    });

    it('the day-366 preset reads Thrones and drops the Zone', async () => {
        await handleTableRules({ action: 'import', worldId: W, preset: 'day-366' }, ctx);

        const getRes = await handleCharacterManage({ action: 'get', characterId: 'luciel' }, ctx);
        expect(json(getRes, 'CHARACTER_MANAGE').currencyNote).toBe('Thrones 40');
        expect(text(getRes)).toMatch(/Thrones/);
        expect(text(getRes)).not.toMatch(/\bRU\b/);

        const block = text(await handleCharacterManage({ action: 'get_status_block', characterId: 'luciel' }, ctx));
        expect(block).not.toMatch(/ПДА/);
        expect(block).toMatch(/\+\+\+/);

        const pay = json(await handleInventoryManage({ action: 'add_currency', characterId: 'luciel', amount: 2.5 }, ctx), 'INVENTORY_MANAGE');
        expect(pay.message).toMatch(/42\.5 Thrones/);

        const inv = text(await handleInventoryManage({ action: 'get', characterId: 'luciel' }, ctx));
        expect(inv).toMatch(/Thrones/);
        expect(inv).not.toMatch(/\bRU\b/);

        const debt = json(await handleLedgerManage({ action: 'create', worldId: W, debtor: 'Luciel', creditor: 'the Blood God', amount: 1 }, ctx), 'LEDGER_MANAGE');
        expect(debt.message).toMatch(/Thrones/);

        const q = json(await handleQuestManage({ action: 'create', name: 'Take the mountain', description: 'x', worldId: W, objectives: [] }, ctx), 'QUEST_MANAGE');
        const questId = q.id ?? q.questId ?? q.quest?.id;
        await handleQuestManage({ action: 'assign', questId, characterId: 'luciel' }, ctx);
        const failed = json(await handleQuestManage({ action: 'fail', questId, characterId: 'luciel' }, ctx), 'QUEST_MANAGE');
        expect(failed.message).not.toMatch(/Zone/);
    });

    it('a world can name its own currency', async () => {
        await handleTableRules({ action: 'define', worldId: W, kind: 'lexicon', name: 'lexicon', spec: { currency: 'souls' } }, ctx);
        const got = json(await handleCharacterManage({ action: 'get', characterId: 'luciel' }, ctx), 'CHARACTER_MANAGE');
        expect(got.currencyNote).toBe('souls 40');
        expect(got.currencyLabel).toBe('souls');
    });
});
