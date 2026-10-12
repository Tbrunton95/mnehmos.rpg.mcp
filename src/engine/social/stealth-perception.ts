/**
 * PHASE-2: Social Hearing Mechanics - Stealth vs Perception Opposed Rolls
 *
 * Implements D&D 5e-style opposed checks for eavesdropping detection:
 * - Speaker rolls Stealth (d20 + the sheet's stealth modifier)
 * - Listener rolls Perception (d20 + the sheet's perception modifier)
 * - If listener's total >= speaker's total, they hear the conversation
 *
 * Play report 2 #5: the modifiers are the ONE skill number per character
 * (src/engine/skill-modifier.ts): DEX/WIS + proficiency from the sheet, or
 * the stealthBonus/perceptionBonus override when the column holds a number
 * (0 included). An override replaces the computed value; it never adds.
 *
 * Dice: this module rolls nothing itself. The caller injects the d20 (a
 * logged roller, so every eavesdrop die lands in roll_log with its audit
 * key) — see npc_manage interact.
 */

import { Character, NPC } from '../../schema/character.js';
import { srdProfBonus } from '../progression.js';
import { skillModifier, type SkillSource } from '../skill-modifier.js';

export interface OpposedRollResult {
    // Speaker (trying to be stealthy)
    speakerRoll: number;           // Raw d20 roll
    speakerModifier: number;       // The sheet's stealth modifier (computed or override)
    speakerSource: SkillSource;
    speakerTotal: number;          // Roll + modifier

    // Listener (trying to perceive)
    listenerRoll: number;          // Raw d20 roll
    listenerModifier: number;      // The sheet's perception modifier (computed or override) + environment
    listenerSource: SkillSource;
    listenerTotal: number;         // Roll + modifier

    // Result
    success: boolean;              // Did listener hear it?
    margin: number;                // How much they beat/missed by
}

export interface OpposedRollOptions {
    /** Proficiency bonus by level: the world's progression curve. SRD when omitted. */
    profBonus?: (level: number) => number;
    /** The d20 for each side, tagged with its purpose and the roller's id. The caller logs it (roll_log). */
    roll: (purpose: 'stealth' | 'perception', forId: string) => number;
}

/**
 * Calculate ability modifier from ability score (D&D 5e formula)
 *
 * @param abilityScore - Ability score (1-30, typically 3-20)
 * @returns Modifier (-5 to +10 typically)
 */
export function getModifier(abilityScore: number): number {
    return Math.floor((abilityScore - 10) / 2);
}

/**
 * Perform a Stealth vs Perception opposed roll
 *
 * Speaker tries to hide their conversation (Stealth check)
 * Listener tries to overhear (Perception check)
 *
 * @param speaker - Character attempting stealth
 * @param listener - Character attempting perception
 * @param environmentModifier - Optional modifier from environment (e.g., -5 for noisy tavern)
 * @param opts - The injected d20 roller and the world's proficiency curve
 * @returns Detailed result of the opposed roll
 */
export function rollStealthVsPerception(
    speaker: Character | NPC,
    listener: Character | NPC,
    environmentModifier: number = 0,
    opts: OpposedRollOptions
): OpposedRollResult {
    const profBonus = opts.profBonus ?? srdProfBonus;

    // Speaker's Stealth check: the same number roll_skill_check rolls.
    const stealth = skillModifier(speaker, 'stealth', 'dex', profBonus(speaker.level));
    const speakerRoll = opts.roll('stealth', speaker.id);
    const speakerModifier = stealth.value;
    const speakerTotal = speakerRoll + speakerModifier;

    // Listener's Perception check
    const perception = skillModifier(listener, 'perception', 'wis', profBonus(listener.level));
    const listenerRoll = opts.roll('perception', listener.id);
    const listenerModifier = perception.value + environmentModifier;
    const listenerTotal = listenerRoll + listenerModifier;

    // Listener succeeds if their total >= speaker's total
    const success = listenerTotal >= speakerTotal;
    const margin = listenerTotal - speakerTotal;

    return {
        speakerRoll,
        speakerModifier,
        speakerSource: stealth.source,
        speakerTotal,
        listenerRoll,
        listenerModifier,
        listenerSource: perception.source,
        listenerTotal,
        success,
        margin
    };
}

/**
 * Determine environment modifier based on atmospherics
 *
 * @param atmospherics - Room atmospheric effects
 * @returns Modifier to apply to Perception checks
 */
export function getEnvironmentModifier(atmospherics: string[]): number {
    let modifier = 0;

    // SILENCE makes it easier to hear (no background noise)
    if (atmospherics.includes('SILENCE')) {
        modifier += 5;
    }

    // FOG doesn't affect hearing (visual only)
    // DARKNESS doesn't affect hearing
    // ANTIMAGIC doesn't affect natural hearing

    return modifier;
}

/**
 * Check if character is deafened (cannot hear)
 *
 * @param character - Character to check
 * @returns true if character cannot hear
 */
export function isDeafened(character: Character | NPC): boolean {
    return character.conditions?.some(c => c.name === 'DEAFENED') || false;
}

/**
 * Batch process opposed rolls for multiple listeners
 *
 * Optimized for scenarios where one speaker is heard by many listeners
 *
 * @param speaker - The character speaking
 * @param listeners - Array of characters trying to hear
 * @param environmentModifier - Modifier from environment
 * @param opts - The injected d20 roller and the world's proficiency curve
 * @returns Map of listenerId -> OpposedRollResult
 */
export function batchRollStealthVsPerception(
    speaker: Character | NPC,
    listeners: Array<Character | NPC>,
    environmentModifier: number = 0,
    opts: OpposedRollOptions
): Map<string, OpposedRollResult> {
    const results = new Map<string, OpposedRollResult>();

    for (const listener of listeners) {
        // Skip deafened listeners
        if (isDeafened(listener)) {
            continue;
        }

        const result = rollStealthVsPerception(speaker, listener, environmentModifier, opts);
        results.set(listener.id, result);
    }

    return results;
}
