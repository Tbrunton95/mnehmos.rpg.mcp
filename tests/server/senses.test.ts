/**
 * Play report 5 #8a: senses as data. combat_profile.senses {darkvisionFt,
 * blindsightFt, tremorsenseFt, truesightFt} lives on the sheet (create,
 * update, get, species rules, forms, tokens); spatial look reads it in a
 * DARKNESS room (darkness seen as dim light: the room comes back, sight-based
 * Perception at disadvantage for darkvision only); the status block shows DV
 * 60 on the speed row. A legacy 'Darkvision' condition in any case still
 * counts, so sheets written before the field see too.
 */
import { handleCharacterManage, CharacterManageTool } from '../../src/server/consolidated/character-manage.js';
import { handleTableRules, TableRulesTool } from '../../src/server/consolidated/table-rules.js';
import { handleCombatManage } from '../../src/server/consolidated/combat-manage.js';
import { handleLookAtSurroundings, handleMoveCharacterToRoom } from '../../src/server/handlers/spatial-handlers.js';
import { clearCombatState } from '../../src/server/handlers/combat-handlers.js';
import { SpatialRepository } from '../../src/storage/repos/spatial.repo.js';
import { CharacterRepository } from '../../src/storage/repos/character.repo.js';
import { WorldRepository } from '../../src/storage/repos/world.repo.js';
import { closeDb, getDb } from '../../src/storage/index.js';
import { hydrateExtras } from '../../src/engine/combat/participant-extras.js';
import { FORM_KEYS, sheetFromCreature } from '../../src/engine/forms.js';
import { parseRuleSpec } from '../../src/engine/table-rules.js';
import { randomUUID } from 'crypto';

process.env.NODE_ENV = 'test';

const ctx = { sessionId: 'senses' } as any;
const json = (res: any) => { const t = res.content[0].text; const m = t.match(/<!-- ([A-Z_]+JSON)\n([\s\S]*?)\n\1 -->/); return m ? JSON.parse(m[2]) : JSON.parse(t); };
const text = (res: any) => res.content[0].text as string;
const char = async (a: Record<string, unknown>) => json(await handleCharacterManage(CharacterManageTool.inputSchema.parse(a), ctx));
const sheet = (id: string) => new CharacterRepository(getDb()).findById(id)! as any;
const W = 'under';

function world() {
    const now = new Date().toISOString();
    new WorldRepository(getDb()).create({ id: W, name: 'Under', seed: 's', width: 10, height: 10, createdAt: now, updatedAt: now } as any);
    return async (a: Record<string, unknown>) => json(await handleTableRules(TableRulesTool.inputSchema.parse({ worldId: W, ...a }), ctx));
}

function darkRoom(exits: Array<Record<string, unknown>> = []) {
    const id = randomUUID();
    const now = new Date().toISOString();
    new SpatialRepository(getDb()).create({
        id, name: 'Dark Cave', baseDescription: 'A cold cave where no light reaches the walls.', biomeContext: 'cavern',
        atmospherics: ['DARKNESS'], exits: exits as any, entityIds: [], createdAt: now, updatedAt: now, visitedCount: 0, lastVisitedAt: undefined
    } as any);
    return id;
}

async function observer(over: Record<string, unknown>, roomId: string) {
    const id = randomUUID();
    const now = new Date().toISOString();
    new CharacterRepository(getDb()).create({
        id, name: 'Watcher', stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: 10, maxHp: 10, ac: 10, level: 1,
        characterType: 'pc', characterClass: 'fighter', conditions: [], createdAt: now, updatedAt: now, ...over
    } as any);
    await handleMoveCharacterToRoom({ characterId: id, roomId }, ctx);
    return id;
}

const look = async (observerId: string) => JSON.parse(text(await handleLookAtSurroundings({ observerId }, ctx)));
const perceptionRolls = (forId: string) => (getDb().prepare("SELECT expression FROM roll_log WHERE for_id = ? AND purpose = 'perception'").all(forId) as Array<{ expression: string }>).map(r => r.expression);

describe('senses (play report 5 #8a)', () => {
    beforeEach(() => { closeDb(); getDb(':memory:'); clearCombatState(); });
    afterEach(() => closeDb());

    it('senses survive create, update and get through the outer schema; an unknown sense is refused', async () => {
        const c = await char({ action: 'create', name: 'Varek', senses: { darkvisionFt: 60 } });
        expect(c.senses).toEqual({ darkvisionFt: 60 });
        expect((await char({ action: 'get', characterId: c.id })).senses).toEqual({ darkvisionFt: 60 });
        await char({ action: 'update', characterId: c.id, senses: { darkvisionFt: 60, blindsightFt: 10 } });
        expect(sheet(c.id).senses).toEqual({ darkvisionFt: 60, blindsightFt: 10 });
        expect(() => CharacterManageTool.inputSchema.parse({ action: 'update', characterId: c.id, senses: { xray: 30 } })).toThrow();
        expect(() => CharacterManageTool.inputSchema.parse({ action: 'update', characterId: c.id, senses: { darkvisionFt: -5 } })).toThrow();
    });

    it('a world species rule with senses writes them at create; an SRD species with Darkvision gets 60 ft and the feature leaves unsupportedFeatureNames', async () => {
        const rules = world();
        await rules({ action: 'define', kind: 'species', name: 'Skaven', spec: { speed: 30, senses: { darkvisionFt: 60 }, traits: ['Scurry Away', 'Darkvision'] } });
        const rat = await char({ action: 'create', name: 'Queek', race: 'Skaven', worldId: W });
        expect(sheet(rat.id).senses).toEqual({ darkvisionFt: 60 });
        expect(rat._rules.species).toMatchObject({ world: true, name: 'Skaven', senses: { darkvisionFt: 60 } });

        const elf = await char({ action: 'create', name: 'Ael', race: 'Elf' });
        expect(sheet(elf.id).senses).toEqual({ darkvisionFt: 60 });
        expect(elf._rules.species.appliedMechanics).toContain('senses');
        expect(elf._rules.species.unsupportedFeatureNames).not.toContain('Darkvision');

        // The caller's own senses win over the species.
        const owl = await char({ action: 'create', name: 'Owl', race: 'Elf', senses: { darkvisionFt: 120 } });
        expect(sheet(owl.id).senses).toEqual({ darkvisionFt: 120 });
        const human = await char({ action: 'create', name: 'Tam', race: 'Human' });
        expect(sheet(human.id).senses).toBeUndefined();
    });

    describe('spatial look in DARKNESS', () => {
        const hiddenExit = { direction: 'north', targetNodeId: randomUUID(), type: 'HIDDEN', dc: 10 };

        it('darkvision sees the room as dim light: the room comes back, and the HIDDEN-exit Perception rolls at disadvantage', async () => {
            const room = darkRoom([hiddenExit]);
            const id = await observer({ senses: { darkvisionFt: 60 } }, room);
            const seen = await look(id);
            expect(seen.success).toBe(true);
            expect(seen.roomName).toBe('Dark Cave');
            expect(seen.detailWithheldBy).toBeUndefined();
            expect(seen.seenWith).toBe('darkvision 60 ft');
            expect(seen.visionNote).toMatch(/dim light/);
            expect(seen.visionNote).toMatch(/disadvantage/);
            expect(seen.description).not.toContain("can't see");
            expect(perceptionRolls(id)).toEqual(['2d20kl1']);
        });

        it('blindsight sees it without the dim-light penalty; truesight too', async () => {
            const room = darkRoom([hiddenExit]);
            const bat = await observer({ senses: { blindsightFt: 30 } }, room);
            const seen = await look(bat);
            expect(seen.success).toBe(true);
            expect(seen.seenWith).toBe('blindsight 30 ft');
            expect(seen.visionNote).not.toMatch(/disadvantage/);
            expect(perceptionRolls(bat)).toEqual(['1d20']);
            const seer = await observer({ senses: { truesightFt: 60 } }, room);
            expect((await look(seer)).seenWith).toBe('truesight 60 ft');
        });

        it("a legacy 'Darkvision' condition in any case still sees; no sense and no light stays pitch black", async () => {
            const room = darkRoom();
            const legacy = await observer({ conditions: [{ name: 'Darkvision' }] }, room);
            const seen = await look(legacy);
            expect(seen.success).toBe(true);
            expect(seen.seenWith).toBe('darkvision 60 ft (condition)');
            const blind = await observer({}, room);
            const dark = await look(blind);
            expect(dark.description).toContain("can't see");
            expect(dark.detailWithheldBy).toBe('DARKNESS');
        });
    });

    it('the status block carries the senses and renders DV 60 on the speed row', async () => {
        const c = await char({ action: 'create', name: 'Varek', speed: 30, senses: { darkvisionFt: 60, tremorsenseFt: 10 } });
        const res = await handleCharacterManage({ action: 'get_status_block', characterId: c.id }, ctx);
        const data = json(res);
        expect(data.senses).toEqual({ darkvisionFt: 60, tremorsenseFt: 10 });
        const banner = text(res).split('<!--')[0];
        expect(banner).toMatch(/SPD 30/);
        expect(banner).toMatch(/DV 60/);
        expect(banner).toMatch(/TS 10/);
    });

    it('forms: a creature rule with senses applies them on set_form and the base comes back on revert', async () => {
        expect(FORM_KEYS).toContain('senses');
        expect(sheetFromCreature(parseRuleSpec('creature', { hp: 30, ac: 12, senses: { blindsightFt: 30 } })).senses).toEqual({ blindsightFt: 30 });
        const rules = world();
        await rules({ action: 'define', kind: 'creature', name: 'Bat', spec: { hp: 30, ac: 12, senses: { blindsightFt: 30 } } });
        const c = await char({ action: 'create', name: 'Varek', worldId: W, senses: { darkvisionFt: 60 } });
        await char({ action: 'set_form', characterId: c.id, form: 'Bat' });
        expect(sheet(c.id).senses).toEqual({ blindsightFt: 30 });
        await char({ action: 'set_form', characterId: c.id, form: 'base' });
        expect(sheet(c.id).senses).toEqual({ darkvisionFt: 60 });
    });

    it('tokens hydrate senses from the sheet and the state view shows them', async () => {
        expect(hydrateExtras({}, { senses: { darkvisionFt: 60 } } as any)).toEqual({ senses: { darkvisionFt: 60 } });
        expect(hydrateExtras({ senses: { blindsightFt: 10 } } as any, { senses: { darkvisionFt: 60 } } as any)).toEqual({ senses: { blindsightFt: 10 } });
        const c = await char({ action: 'create', name: 'Varek', senses: { darkvisionFt: 60 } });
        const enc = json(await handleCombatManage({ action: 'create', participants: [
            { id: c.id, name: 'Varek', initiativeBonus: 0, hp: 10, maxHp: 10 },
            { id: 'rat', name: 'Rat', initiativeBonus: 0, hp: 5, maxHp: 5, isEnemy: true, senses: { darkvisionFt: 30 } }
        ] }, ctx));
        const encounterId = enc.encounterId ?? enc.id;
        const tokens = JSON.parse((getDb().prepare('SELECT tokens FROM encounters WHERE id = ?').get(encounterId) as any).tokens) as any[];
        expect(tokens.find(t => t.id === c.id).senses).toEqual({ darkvisionFt: 60 });
        expect(tokens.find(t => t.id === 'rat').senses).toEqual({ darkvisionFt: 30 });
        const state = json(await handleCombatManage({ action: 'get', encounterId }, ctx));
        expect(state.participants.find((p: any) => p.id === c.id).senses).toEqual({ darkvisionFt: 60 });
    });
});
