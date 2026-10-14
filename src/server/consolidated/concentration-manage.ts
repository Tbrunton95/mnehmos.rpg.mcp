/**
 * Consolidated Concentration Management Tool
 *
 * Replaces 5 individual concentration tools with a single action-based tool:
 * - check_concentration_save -> action: 'check_save'
 * - break_concentration -> action: 'break'
 * - get_concentration_state -> action: 'get'
 * - check_concentration_duration -> action: 'check_duration'
 * - check_automatic_concentration_break -> action: 'check_auto'
 */

import { z } from 'zod';
import { SessionContext } from '../types.js';
import { getDb } from '../../storage/index.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { ConcentrationRepository } from '../../storage/repos/concentration.repo.js';
import { sheetConcentrationDie, saveDieLabels, concentrationSidesNote, concentrationLine, legendaryFieldsOf } from '../../engine/combat/saves.js';
import { getOrLoadEngine, liveEncounterFor, saveEncounterState } from '../handlers/combat-handlers.js';
import { EncounterRepository } from '../../storage/repos/encounter.repo.js';
import {
    concentrationRestoreProblem, fightConcentrationLegendary, restoreConcentrationRow, sheetConcentrationLegendary,
    type LegendarySave
} from '../handlers/legendary-saves.js';
import type { ConcentrationSnapshot } from '../../engine/combat/legendary-resistance.js';
import {
    checkConcentration,
    breakConcentration,
    getConcentration,
    checkConcentrationDuration,
    checkAutomaticConcentrationBreak,
} from '../../engine/magic/concentration.js';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = ['check_save', 'break', 'get', 'check_duration', 'check_auto', 'restore'] as const;
type ConcentrationAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb() {
    const db = getDb();
    return {
        characterRepo: new CharacterRepository(db),
        concentrationRepo: new ConcentrationRepository(db),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const CheckSaveSchema = z.object({
    action: z.literal('check_save'),
    characterId: z.string().describe('Character maintaining concentration'),
    damageAmount: z.number().int().min(0).describe('Damage triggering the check')
});

const BreakSchema = z.object({
    action: z.literal('break'),
    characterId: z.string().describe('Character whose concentration breaks'),
    reason: z.enum(['damage', 'incapacitated', 'death', 'new_spell', 'voluntary', 'duration'])
        .describe('Reason for breaking'),
    damageAmount: z.number().int().min(0).optional()
});

const GetSchema = z.object({
    action: z.literal('get'),
    characterId: z.string().describe('Character to query')
});

const CheckDurationSchema = z.object({
    action: z.literal('check_duration'),
    characterId: z.string().describe('Character maintaining concentration'),
    currentRound: z.number().int().min(1).describe('Current combat round')
});

const CheckAutoSchema = z.object({
    action: z.literal('check_auto'),
    characterId: z.string().describe('Character to check')
});

const RESTORE_DESCRIBE = "Lane K: put back a concentration a failed CON save broke, as it stood: the repair check_save, apply_damage or an execute off a fight print with legendaryResistanceAvailable (no encounter row can hold an offer there). spendLegendaryResistance: true spends one of the sheet's legendary resistances in the same call (refused with none left, or for a character with a live token: answer that fight's offer with combat_manage legendary_resistance {saveRef}). Refused, writing nothing, if the character has started concentrating on something else since, is at 0 HP, or has no sheet";
const RestoreSchema = z.object({
    action: z.literal('restore'),
    characterId: z.string().describe('Character whose concentration comes back'),
    spell: z.string().min(1).describe('restore: the spell it held'),
    spellLevel: z.number().int().min(0).max(9).describe('restore: the spell level it held'),
    startedAt: z.number().int().min(1).describe('restore: the round it started (kept, so its duration runs on as before)'),
    maxDuration: z.number().int().optional().describe('restore: its duration in rounds'),
    targetIds: z.array(z.string()).optional().describe("restore: the spell's targets"),
    saveDCBase: z.number().int().optional().describe('restore: its concentration DC base (default 10)'),
    spendLegendaryResistance: z.boolean().optional().describe("restore: spend one of the sheet's legendary resistances for it (the failed save becomes a success)")
}).describe(RESTORE_DESCRIBE);

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleCheckSave(args: z.infer<typeof CheckSaveSchema>, ctx?: SessionContext): Promise<object> {
    const { characterRepo, concentrationRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        throw new Error(`Character ${args.characterId} not found`);
    }

    // Seeded and logged like every other save (roll_log purpose 'concentration').
    // Play report 7 (lane H): the character's declared save:con sides and sheet
    // conditions fire by themselves ('concentration (adv: Steady Mind (save:con))').
    const result = checkConcentration(character, args.damageAmount, concentrationRepo, 0,
        sheetConcentrationDie(getDb(), character.id, 'concentration_manage'));

    // Lane K: a failed save asks legendary resistance. A character with a live
    // token answers through its fight (the token's count; the offer rides the
    // encounter row with a saveRef); off a fight the sheet's count, and the
    // restore call, since no encounter row can hold an offer.
    let legendary: LegendarySave | undefined;
    if (result.broken) {
        const held = concentrationRepo.findByCharacterId(character.id);
        const db = getDb();
        const fightId = liveEncounterFor(db, character.id);
        const engine = fightId && ctx ? getOrLoadEngine(ctx, fightId) : null;
        const inFight = !!engine && !!engine.getState()?.participants.some(p => p.id === character.id);
        if (held) {
            legendary = inFight
                ? fightConcentrationLegendary(engine!, db, character.id, fightId, held)
                : sheetConcentrationLegendary(db, character.id, held);
            // The token's count or its offer lives on the encounter row.
            if (legendary && inFight) saveEncounterState(new EncounterRepository(db), fightId!, engine!.getState()!);
        }
        if (legendary?.holds) { result.broken = false; result.reason = 'damage'; }
    }

    if (result.broken) {
        breakConcentration(
            { characterId: args.characterId, reason: 'damage', damageAmount: args.damageAmount },
            concentrationRepo,
            characterRepo
        );
    }

    const fields = legendary ? legendaryFieldsOf(legendary.fields) : {};
    const outcome = { spell: result.spell, broken: result.broken, reason: result.reason, saveRoll: result.saveRoll, saveTotal: result.saveTotal, saveDC: result.saveDC, ...saveDieLabels({ ...result, rolls: result.saveRolls }), ...fields };
    return {
        spell: result.spell,
        maintained: !result.broken,
        broken: result.broken,
        saveRoll: result.saveRoll,
        constitutionModifier: result.constitutionModifier,
        saveTotal: result.saveTotal,
        saveDC: result.saveDC,
        damageAmount: args.damageAmount,
        // Play report 7 (lane H): what put the save at advantage or disadvantage, both dice, a tagged one's hint.
        ...saveDieLabels({ ...result, rolls: result.saveRolls }),
        // Lane K: the legendary resistance spent, offered (saveRef, in a fight) or reported (the restore call, off one).
        ...fields,
        ...(legendary?.row ? { legendaryOffers: [legendary.row] } : {}),
        message: result.spell === 'none'
            ? 'Character is not concentrating on any spell.'
            : legendary
                ? `${character.name}: ${concentrationLine(outcome, '')}`
                : `${result.broken
                    ? `Concentration broken on ${result.spell}!`
                    : `Concentration maintained on ${result.spell}!`}${concentrationSidesNote(result)}`
    };
}

async function handleRestore(args: z.infer<typeof RestoreSchema>): Promise<object> {
    const db = getDb();
    const { characterRepo } = ensureDb();
    const refuse = (message: string) => ({ error: true, actionType: 'restore', writes: 'none', message: `${message}. Nothing was written.` });
    const snap: ConcentrationSnapshot = {
        spell: args.spell, spellLevel: args.spellLevel, startedAt: args.startedAt, saveDCBase: args.saveDCBase ?? 10,
        ...(args.maxDuration !== undefined ? { maxDuration: args.maxDuration } : {}),
        ...(args.targetIds?.length ? { targetIds: args.targetIds } : {})
    };
    const problem = concentrationRestoreProblem(db, args.characterId, snap);
    if (problem) return refuse(problem);
    const row = characterRepo.findById(args.characterId)!;
    let remaining: number | undefined;
    if (args.spendLegendaryResistance) {
        const fight = liveEncounterFor(db, args.characterId);
        if (fight) return refuse(`${row.name} has a token in encounter ${fight}: its legendary resistances are counted there. Answer the fight's offer with combat_manage legendary_resistance {encounterId: '${fight}', participantId: '${args.characterId}', saveRef, reason}`);
        const left = row.legendaryResistancesRemaining ?? row.legendaryResistances ?? 0;
        if (left <= 0) return refuse(`${row.name} has no legendary resistance left`);
        remaining = left - 1;
    }
    if (!restoreConcentrationRow(db, args.characterId, snap)) return refuse(`the concentration row for ${row.name} could not be written`);
    if (remaining !== undefined) characterRepo.update(args.characterId, { legendaryResistancesRemaining: remaining });
    const of = row.legendaryResistances ?? undefined;
    const lr = remaining !== undefined ? `; LR ${remaining}${of !== undefined ? `/${of}` : ''} left` : '';
    return {
        success: true, actionType: 'restore', characterId: args.characterId,
        concentrationRestored: snap,
        ...(remaining !== undefined ? { legendaryResistanceSpent: true, legendaryResistancesRemaining: remaining, ...(of !== undefined ? { of } : {}) } : {}),
        message: `${remaining !== undefined ? `👑 ${row.name} turns the failed concentration save into a success: ` : `${row.name}: `}concentration on ${snap.spell} holds again (level ${snap.spellLevel}, from round ${snap.startedAt}${snap.maxDuration !== undefined ? `, ${snap.maxDuration} rounds` : ''})${lr}`
    };
}

async function handleBreak(args: z.infer<typeof BreakSchema>): Promise<object> {
    const { characterRepo, concentrationRepo } = ensureDb();

    const result = breakConcentration(
        { characterId: args.characterId, reason: args.reason, damageAmount: args.damageAmount },
        concentrationRepo,
        characterRepo
    );

    const reasonMap: Record<string, string> = {
        damage: 'failed concentration save from damage',
        incapacitated: 'becoming incapacitated',
        death: 'character death',
        new_spell: 'casting a new concentration spell',
        voluntary: 'voluntary choice',
        duration: 'spell duration expiring',
    };

    return {
        spell: result.spell,
        reason: args.reason,
        message: result.spell === 'none'
            ? 'Character was not concentrating on any spell.'
            : `Concentration on ${result.spell} ended (${reasonMap[args.reason] || args.reason}).`
    };
}

async function handleGet(args: z.infer<typeof GetSchema>): Promise<object> {
    const { concentrationRepo } = ensureDb();

    const concentration = getConcentration(args.characterId, concentrationRepo);

    if (!concentration) {
        return {
            concentrating: false,
            message: `Character ${args.characterId} is not concentrating on any spell.`
        };
    }

    return {
        concentrating: true,
        spell: concentration.activeSpell,
        spellLevel: concentration.spellLevel,
        startedAt: concentration.startedAt,
        maxDuration: concentration.maxDuration,
        targets: concentration.targetIds || [],
        message: `Concentrating on ${concentration.activeSpell} (Level ${concentration.spellLevel})`
    };
}

async function handleCheckDuration(args: z.infer<typeof CheckDurationSchema>): Promise<object> {
    const { characterRepo, concentrationRepo } = ensureDb();

    const result = checkConcentrationDuration(
        args.characterId,
        args.currentRound,
        concentrationRepo,
        characterRepo
    );

    if (!result) {
        return {
            expired: false,
            message: 'Concentration is still within duration limit.'
        };
    }

    return {
        expired: true,
        spell: result.spell,
        message: `Concentration on ${result.spell} has exceeded its duration and has ended.`
    };
}

async function handleCheckAuto(args: z.infer<typeof CheckAutoSchema>): Promise<object> {
    const { characterRepo, concentrationRepo } = ensureDb();

    const character = characterRepo.findById(args.characterId);
    if (!character) {
        throw new Error(`Character ${args.characterId} not found`);
    }

    const result = checkAutomaticConcentrationBreak(character, concentrationRepo, characterRepo);

    if (!result) {
        return {
            broken: false,
            message: 'No automatic concentration break required.'
        };
    }

    return {
        broken: true,
        spell: result.spell,
        reason: result.reason,
        message: `Concentration on ${result.spell} automatically broken due to ${result.reason}.`
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<ConcentrationAction, ActionDefinition> = {
    check_save: {
        schema: CheckSaveSchema,
        handler: handleCheckSave,
        aliases: ['save', 'damage'],
        description: 'Roll Constitution save after taking damage'
    },
    break: {
        schema: BreakSchema,
        handler: handleBreak,
        aliases: ['end', 'stop'],
        description: 'Manually break concentration'
    },
    get: {
        schema: GetSchema,
        handler: handleGet,
        aliases: ['state', 'status', 'query'],
        description: 'Query current concentration state'
    },
    check_duration: {
        schema: CheckDurationSchema,
        handler: handleCheckDuration,
        aliases: ['duration'],
        description: 'Check if concentration exceeded duration'
    },
    check_auto: {
        schema: CheckAutoSchema,
        handler: handleCheckAuto,
        aliases: ['auto', 'conditions'],
        description: 'Check for automatic break (death/incapacitated)'
    },
    restore: {
        schema: RestoreSchema,
        handler: handleRestore,
        aliases: ['restore_concentration', 'undo_break'],
        description: "Put back a concentration a failed save broke, as it stood; spendLegendaryResistance spends one of the sheet's for it (the repair a check off a fight prints)"
    }
};

const router = createActionRouter({
    actions: ACTIONS,
    definitions,
    threshold: 0.6
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEFINITION & HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export const ConcentrationManageTool = {
    name: 'concentration_manage',
    description: `Manage spell concentration (D&D 5e rules).

🎯 WHEN TO USE:
- After damage: check_save (CON save DC = max(10, damage/2))
- After incapacitation/death: check_auto (auto-break)
- Before new concentration spell: break (new_spell reason)
- Each round: check_duration (for time-limited spells)

⚔️ COMBAT INTEGRATION:
When a concentrating character takes damage, ALWAYS call check_save!
The engine handles the CON save automatically.

🎲 DECLARED SIDES (play report 7): the CON save reads the character's own sides, as every engine save does: an untagged effect mechanic {type: 'advantage_on', value: 'save:con'} (War Caster, 'Steady Mind') rolls two d20s and keeps the higher; Exhaustion 3+ gives disadvantage; both cancel to one die. A tagged one never fires here and is named in conditionalAdvantage. The reply carries advantageSources / disadvantageSources / saveRolls; the roll log reads 'concentration (adv: Steady Mind (save:con))'.

🔮 SPELL EXAMPLES (require concentration):
Hold Person, Bless, Haste, Hex, Hunter's Mark, Spirit Guardians

👑 LEGENDARY RESISTANCE (lane K): a failed check_save by a creature with legendary resistance left asks it, as every engine save does. autoLegendaryResistance spends one (the spell holds; the sheet keeps the count); otherwise it is offered ('LR 2/3 left, spend one?'); a player character is asked, never spent for. With a live token the offer rides that fight with a saveRef: combat_manage legendary_resistance {encounterId, participantId, saveRef, reason} restores the spell as it stood. Off a fight the reply carries legendaryResistanceAvailable and the repair to paste: restore {characterId, spell, spellLevel, startedAt, maxDuration?, targetIds?, spendLegendaryResistance: true}. See docs/table-rules/legendary-resistance.md

Actions: check_save, break, get, check_duration, check_auto, restore
Aliases: save/damage→check_save, end/stop→break, state→get`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe('Action: check_save, break, get, check_duration, check_auto, restore'),
        characterId: z.string().describe('Character ID'),
        damageAmount: z.number().int().min(0).optional(),
        reason: z.enum(['damage', 'incapacitated', 'death', 'new_spell', 'voluntary', 'duration']).optional(),
        currentRound: z.number().int().min(1).optional(),
        // Lane K: restore's keys (mirror law: the outer schema carries every action's keys).
        spell: z.string().optional().describe('restore: the spell it held'),
        spellLevel: z.number().int().min(0).max(9).optional().describe('restore: the spell level it held'),
        startedAt: z.number().int().min(1).optional().describe('restore: the round it started'),
        maxDuration: z.number().int().optional().describe('restore: its duration in rounds'),
        targetIds: z.array(z.string()).optional().describe("restore: the spell's targets"),
        saveDCBase: z.number().int().optional().describe('restore: its concentration DC base (default 10)'),
        spendLegendaryResistance: z.boolean().optional().describe("restore: spend one of the sheet's legendary resistances for it")
    })
};

export async function handleConcentrationManage(args: unknown, ctx: SessionContext): Promise<McpResponse> {
    // Lane K: check_save reads the session's fight (a live token's legendary resistance).
    return router(args as Record<string, unknown>, ctx);
}
