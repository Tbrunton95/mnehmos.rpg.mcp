import { z } from 'zod';

/**
 * Concentration state for a character actively maintaining a concentration spell
 */
export const ConcentrationStateSchema = z.object({
    characterId: z.string(),
    activeSpell: z.string(), // Spell name
    spellLevel: z.number().int().min(0).max(9),
    targetIds: z.array(z.string()).optional(), // Targets affected by the spell
    startedAt: z.number().int().min(1), // Round number when concentration started
    maxDuration: z.number().int().optional(), // Maximum rounds (null = indefinite)
    saveDCBase: z.number().int().default(10), // Base DC for concentration saves (min 10 or half damage)
});

export type ConcentrationState = z.infer<typeof ConcentrationStateSchema>;

/**
 * Result of a concentration check (saving throw)
 */
export const ConcentrationCheckResultSchema = z.object({
    characterId: z.string(),
    spell: z.string(),
    broken: z.boolean(),
    reason: z.enum(['damage', 'incapacitated', 'death', 'new_spell', 'voluntary', 'duration', 'failed_save']),
    saveRoll: z.number().int().optional(), // d20 roll result
    saveDC: z.number().int().optional(), // DC of the save
    saveTotal: z.number().int().optional(), // Roll + modifier
    damageAmount: z.number().int().optional(), // Damage that triggered the check
    constitutionModifier: z.number().int().optional(),
    // Play report 7 (lane H): what put the CON save at advantage or disadvantage
    // (an untagged save:con mechanic, exhaustion 3+), both dice when two were
    // rolled, and a tagged mechanic's hint. Absent for a save that took none.
    advantageSources: z.array(z.string()).optional(),
    disadvantageSources: z.array(z.string()).optional(),
    saveRolls: z.array(z.number().int()).optional(),
    conditionalAdvantage: z.array(z.string()).optional(),
    conditionalDisadvantage: z.array(z.string()).optional(),
});

export type ConcentrationCheckResult = z.infer<typeof ConcentrationCheckResultSchema>;

/**
 * Request to break concentration (manual or automatic)
 */
export const BreakConcentrationRequestSchema = z.object({
    characterId: z.string(),
    reason: z.enum(['damage', 'incapacitated', 'death', 'new_spell', 'voluntary', 'duration']),
    damageAmount: z.number().int().optional(), // Required if reason is 'damage'
});

export type BreakConcentrationRequest = z.infer<typeof BreakConcentrationRequestSchema>;
