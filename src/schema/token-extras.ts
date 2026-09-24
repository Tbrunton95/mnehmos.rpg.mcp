/**
 * Token extras from the 40k field report: named body parts with states,
 * mortal units as one token, and telegraphed intent / readied actions.
 */
import { z } from 'zod';

export const PART_KINDS = ['head', 'arm', 'leg', 'wing', 'torso', 'system', 'other'] as const;
export const PART_STATES = ['intact', 'crippled', 'dead', 'latched', 'breached'] as const;

export const PartSchema = z.object({
    name: z.string().min(1).describe("The part's name ('middle head', 'left elbow', 'front plate')"),
    kind: z.enum(PART_KINDS).default('other').describe('leg or wing halves speed when crippled'),
    state: z.enum(PART_STATES).default('intact'),
    latchedTo: z.object({
        participantId: z.string(),
        part: z.string().optional()
    }).optional().describe('latched: who (and which part) this part holds'),
    note: z.string().optional()
});
export type Part = z.infer<typeof PartSchema>;

export const UnitTierSchema = z.object({
    minFraction: z.number().min(0).max(1).describe('Fraction of models still standing for this tier'),
    dice: z.string().min(1).describe("Volley damage at this tier ('4d6')")
});

export const UnitSchema = z.object({
    models: z.number().int().min(1).describe('Models at full strength'),
    hpPerModel: z.number().int().min(1),
    packed: z.boolean().default(false).describe('Packed units can be cleaved; spaced ones cannot'),
    attackBonus: z.number().int().default(0).describe('Volley attack bonus against AC'),
    tiers: z.array(UnitTierSchema).min(1).optional().describe('Highest first. Default 4d6 ≥75%, 3d6 ≥50%, 2d6 ≥25%, 1d6 below'),
    suppressed: z.boolean().optional(),
    inMelee: z.boolean().optional(),
    brokenFormation: z.boolean().optional()
});
export type Unit = z.infer<typeof UnitSchema>;

export const ReadiedSchema = z.object({
    action: z.string().min(1),
    trigger: z.string().min(1)
});
export type Readied = z.infer<typeof ReadiedSchema>;
