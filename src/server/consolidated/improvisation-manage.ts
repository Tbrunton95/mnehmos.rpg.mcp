/**
 * Consolidated Improvisation Management Tool
 * Replaces 8 separate tools for stunts, custom effects, and arcane synthesis:
 * resolve_improvised_stunt, apply_custom_effect, get_custom_effects, remove_custom_effect,
 * process_effect_triggers, advance_effect_durations, attempt_arcane_synthesis, get_synthesized_spells
 */

import { z } from 'zod';
import seedrandom from 'seedrandom';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import * as pda from '../../render/pda.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import { getDb } from '../../storage/index.js';
import { CustomEffectsRepository } from '../../storage/repos/custom-effects.repo.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import {
    WILD_SURGE_TABLE,
    SKILL_TO_ABILITY,
    MechanicTypeSchema,
    SkillName,
    TriggerEvent,
    ActorType
} from '../../schema/improvisation.js';
import { loadAutoMechanics, autoSkillBonus, applyDeclaredEffects } from '../../engine/effects-resolver.js';
import { freshSeed } from '../../math/seed.js';
import { getOrLoadEngine, syncParticipantHpFromDb } from '../handlers/combat-handlers.js';
import { EncounterRepository } from '../../storage/repos/encounter.repo.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = [
    'stunt', 'apply_effect', 'get_effects', 'remove_effect', 'replace_effect',
    'process_triggers', 'advance_durations', 'synthesize', 'get_spellbook'
] as const;
type ImprovisationAction = typeof ACTIONS[number];

const SkillEnum = z.enum([
    'acrobatics', 'animal_handling', 'arcana', 'athletics', 'deception',
    'history', 'insight', 'intimidation', 'investigation', 'medicine',
    'nature', 'perception', 'performance', 'persuasion', 'religion',
    'sleight_of_hand', 'stealth', 'survival'
]);

const DamageTypeEnum = z.enum([
    'bludgeoning', 'piercing', 'slashing', 'fire', 'cold', 'lightning',
    'thunder', 'poison', 'acid', 'necrotic', 'radiant', 'force', 'psychic'
]);

const optionalText = () => z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().optional()
);

const optionalDamageType = () => z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    DamageTypeEnum.optional()
);

const defaultText = (fallback: string) => z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().default(fallback)
);

const SchoolEnum = z.enum([
    'abjuration', 'conjuration', 'divination', 'enchantment',
    'evocation', 'illusion', 'necromancy', 'transmutation'
]);

const TriggerEventEnum = z.enum([
    'always_active', 'start_of_turn', 'end_of_turn',
    'on_attack', 'on_hit', 'on_miss',
    'on_damage_taken', 'on_heal', 'on_rest',
    'on_spell_cast', 'on_death'
]);

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function ensureDb() {
    const db = getDb();
    const effectsRepo = new CustomEffectsRepository(db);
    const charRepo = new CharacterRepository(db);
    return { db, effectsRepo, charRepo };
}

// FINDINGS #75: the custom_effects table is keyed by FULL character id — a
// prefix-resolved caller passing the short form gets an empty result reported
// as success. Canonicalize at handler entry; the full id is the only id that
// touches SQL.
function canonicalTargetId(charRepo: CharacterRepository, targetId: string): string {
    return charRepo.findById(targetId)?.id ?? targetId;
}

// ═══════════════════════════════════════════════════════════════════════════
// DICE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function rollDice(notation: string, rng?: seedrandom.PRNG, crit = false): { total: number; rolls: number[]; notation: string } {
    const trimmed = notation.trim();
    // A plain number is a posted total: applied as given, never doubled.
    if (/^\d+$/.test(trimmed)) return { total: parseInt(trimmed, 10), rolls: [], notation: trimmed };
    const match = trimmed.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
    if (!match) throw new Error(`Invalid dice notation: ${notation}`);

    // A crit rolls the dice twice; the flat modifier is added once.
    const count = parseInt(match[1], 10) * (crit ? 2 : 1);
    const sides = parseInt(match[2], 10);
    const modifier = match[3] ? parseInt(match[3], 10) : 0;
    const rolls: number[] = [];
    const random = rng || Math.random;

    for (let i = 0; i < count; i++) {
        rolls.push(Math.floor(random() * sides) + 1);
    }

    return {
        total: Math.max(0, rolls.reduce((a, b) => a + b, 0) + modifier),
        rolls,
        notation
    };
}

function rollD20(advantage?: boolean, disadvantage?: boolean, rng?: seedrandom.PRNG): { roll: number; rolls: number[] } {
    const random = rng || Math.random;
    const roll1 = Math.floor(random() * 20) + 1;

    if (!advantage && !disadvantage) return { roll: roll1, rolls: [roll1] };

    const roll2 = Math.floor(random() * 20) + 1;

    if (advantage && !disadvantage) return { roll: Math.max(roll1, roll2), rolls: [roll1, roll2] };
    if (disadvantage && !advantage) return { roll: Math.min(roll1, roll2), rolls: [roll1, roll2] };
    return { roll: roll1, rolls: [roll1] };
}

function getSkillModifier(stats: Record<string, number>, skill: SkillName): number {
    const ability = SKILL_TO_ABILITY[skill];
    const abilityScore = stats[ability.substring(0, 3)] ?? stats[ability] ?? 10;
    return Math.floor((abilityScore - 10) / 2);
}

function getAbilityModifier(score: number): number {
    return Math.floor((score - 10) / 2);
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const StuntSchema = z.object({
    action: z.literal('stunt'),
    encounterId: z.string().optional(),
    actorId: z.string(),
    actorType: z.enum(['character', 'npc']).default('character'),
    targetIds: z.array(z.string()).optional(),
    targetTypes: z.array(z.enum(['character', 'npc'])).optional(),
    narrativeIntent: defaultText('Improvised action')
        .describe('What the character is attempting; defaults to a generic improvised action'),
    skill: SkillEnum,
    dc: z.number().int().min(5).max(35),
    advantage: z.boolean().optional(),
    disadvantage: z.boolean().optional(),
    // #66-S: stunts adopt the #66 roll composition — the same three channels
    // the character rolls carry. Mirror law: outer flat schema carries these too.
    modifier: z.number().optional().describe('Situational bonus GM passes this call (cover, footing) — SITUATIONAL lane, summed'),
    declaredModifiers: z.array(z.object({ label: z.string(), value: z.number() })).optional().describe('Itemized situational — summed unless colliding with declaredEffects (guard)'),
    declaredEffects: z.array(z.object({ name: z.string(), lane: z.string().optional() })).optional().describe('RESOLVER v2: GM names the conditional trait; engine computes the value'),
    actionCost: z.enum(['action', 'bonus_action', 'reaction', 'free']).default('action'),
    effectType: z.enum(['none', 'damage']).optional()
        .describe('Stunt effect: none for a normal check, damage when damage dice are supplied'),
    successDamage: optionalText()
        .describe('Optional damage dice for a successful stunt; omit for non-damaging checks'),
    failureDamage: optionalText()
        .describe('Optional self-damage dice on a critical failure'),
    damageType: optionalDamageType(),
    applyCondition: optionalText(),
    savingThrowAbility: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional(),
    savingThrowDc: z.number().int().optional(),
    halfDamageOnSave: z.boolean().optional(),
    xpAward: z.number().int().optional().describe('FINDINGS #34 T4.17: XP credited to the actor on resolution')
}).superRefine((args, ctx) => {
    const hasDamageFields = Boolean(args.successDamage || args.failureDamage);
    if (args.effectType === 'damage' && !hasDamageFields) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['successDamage'],
            message: 'A damage stunt requires successDamage or failureDamage dice'
        });
    }
    if (args.effectType === 'none' && hasDamageFields) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['effectType'],
            message: 'A non-damaging stunt must omit damage fields'
        });
    }
    if (args.successDamage && (!args.targetIds || args.targetIds.length === 0)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['targetIds'],
            message: 'targetIds is required when successDamage is supplied so damage can be committed to state'
        });
    }
});

const ApplyEffectSchema = z.object({
    action: z.literal('apply_effect'),
    targetId: z.string().describe('ID of the character/npc the effect is applied to'),
    targetType: z.enum(['character', 'npc']).optional().default('character'),
    name: z.string().describe('Effect name shown on the sheet, e.g. "Blessing of the Forge"'),
    description: z.string().optional().describe('Human-readable flavor text. NOTE: per-mechanic detail goes in mechanics[], not here'),
    category: z.enum(['boon', 'curse', 'neutral', 'transformative']),
    powerLevel: z.number().int().min(1).max(5).default(1).describe('1=minor (+1, hours) .. 5=reality-warping (permanent)'),
    sourceType: z.enum(['divine', 'arcane', 'natural', 'cursed', 'psionic', 'unknown']).default('unknown'),
    sourceEntityName: z.string().optional(),
    mechanics: z.array(z.object({
        type: z.string().describe('Canonical: attack_bonus, damage_bonus, ac_bonus, damage_resistance, saving_throw_bonus, skill_bonus, advantage_on, disadvantage_on — #96: obvious words (advantage, resistance, immunity, attack, damage, ac, save, skill) auto-normalize to these at write time'),
        value: z.union([z.string(), z.number()]).optional().describe('Fixed value — optional when valueFromPool is present (FINDINGS #60)'),
        condition: z.string().optional(),
        autoApply: z.boolean().optional().describe('RESOLVER OPT-IN: engine consumes this mechanic at call time'),
        valueFromPool: z.object({
            pool: z.string(),
            per: z.number().optional(),
            offset: z.number().optional(),
            negate: z.boolean().optional(),
            min: z.number().optional(),
            max: z.number().optional()
        }).optional().describe('FINDINGS #60 RESOLVER v2: value computed at consumption time — floor(pool.current/per), negate, +offset, clamp [min,max]. Pool arithmetic hidden in breakdowns by default'),
        skill: z.string().optional().describe('FINDINGS #101: which skill a skill_bonus scopes to (e.g. acrobatics) — the resolver and every reader need this to keep a skill trait out of unrelated lanes. Silently stripped before #101'),
        save: z.string().optional().describe('FINDINGS #101: which save a saving_throw_bonus scopes to'),
        damageType: z.string().optional().describe('FINDINGS #101: which damage type a resistance or damage bonus scopes to'),
        lane: z.string().optional().describe('FINDINGS #101: chair-side audit tag (e.g. TRAIT, SITUATIONAL) — stored verbatim, printed in reads'),
        note: z.string().optional().describe('FINDINGS #101: free annotation — stored verbatim'),
        hidePool: z.boolean().optional().describe('Default true for pool-derived values (psi law); false opts into printing arithmetic'),
        valueFromProficiency: z.literal(true).optional().describe('FINDINGS #71: value computed at consumption time as the ACTOR\'S proficiency bonus, floor((level-1)/4)+2 — level-scaling traits (Odinets). Mutually sufficient with value/valueFromPool')
    }).passthrough().refine(m => m.value !== undefined || m.valueFromPool !== undefined || m.valueFromProficiency === true, { message: 'mechanic needs value, valueFromPool, or valueFromProficiency — a mechanic with none is a silent zero' })), // FINDINGS #101: passthrough — mechanic keys are NEVER silently stripped again (the #100 zod-strip family, second victim)
    durationType: z.enum(['rounds', 'minutes', 'hours', 'days', 'permanent', 'until_removed']),
    durationValue: z.number().int().optional().describe('Magnitude for timed durations; ignored for permanent/until_removed'),
    triggers: z.array(z.object({
        event: TriggerEventEnum,
        condition: z.string().optional()
    })).optional().describe('When mechanics fire. Defaults to always_active if omitted')
});

const GetEffectsSchema = z.object({
    action: z.literal('get_effects'),
    targetId: z.string(),
    targetType: z.enum(['character', 'npc']).optional().default('character'),
    category: z.enum(['boon', 'curse', 'neutral', 'transformative']).optional(),
    sourceType: z.enum(['divine', 'arcane', 'natural', 'cursed', 'psionic', 'unknown']).optional(),
    includeInactive: z.boolean().optional().default(false)
});

const RemoveEffectSchema = z.object({
    action: z.literal('remove_effect'),
    effectId: z.number().int().optional(),
    targetId: z.string().optional(),
    targetType: z.enum(['character', 'npc']).optional(),
    effectName: z.string().optional()
});

// FINDINGS #71: remove-then-apply is an exposure window — a validation
// refusal on the apply side left a PC missing a trait for ninety seconds,
// live. replace_effect does both inside ONE transaction: the new payload
// validates at the schema boundary BEFORE anything is touched, and the
// delete+insert commit together or not at all.
const ReplaceEffectSchema = ApplyEffectSchema.omit({ action: true }).extend({
    action: z.literal('replace_effect'),
    effectId: z.number().int().optional().describe('Row id of the OLD effect to replace. Omit to resolve by name'),
    effectName: z.string().optional().describe('Name of the OLD row; defaults to the NEW payload\'s name — the re-apply-with-new-mechanics case')
});

const ProcessTriggersSchema = z.object({
    action: z.literal('process_triggers'),
    targetId: z.string(),
    targetType: z.enum(['character', 'npc']).optional().default('character'),
    event: TriggerEventEnum,
    context: z.record(z.any()).optional()
});

const AdvanceDurationsSchema = z.object({
    action: z.literal('advance_durations'),
    targetId: z.string(),
    targetType: z.enum(['character', 'npc']).optional().default('character'),
    rounds: z.number().int().min(1).default(1)
});

const SynthesizeSchema = z.object({
    action: z.literal('synthesize'),
    casterId: z.string(),
    casterType: z.enum(['character', 'npc']).default('character'),
    narrativeIntent: z.string(),
    proposedName: z.string().optional(),
    estimatedLevel: z.number().int().min(1).max(9),
    school: SchoolEnum,
    effectType: z.enum(['damage', 'healing', 'status', 'utility', 'control', 'summoning']),
    effectDice: z.string().optional(),
    damageType: DamageTypeEnum.optional(),
    condition: z.string().optional(),
    targetingType: z.enum(['self', 'single', 'multiple', 'area', 'line', 'cone']),
    targetingRange: z.number().int().min(0),
    areaSize: z.number().int().optional(),
    maxTargets: z.number().int().optional(),
    savingThrowAbility: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional(),
    savingThrowEffect: z.enum(['negates', 'half_damage', 'partial']).optional(),
    verbal: z.boolean().default(true),
    somatic: z.boolean().default(true),
    materialValue: z.number().int().optional(),
    concentration: z.boolean().default(false),
    duration: z.string().default('instantaneous'),
    encounterId: z.string().optional(),
    circumstanceModifiers: z.array(z.string()).optional()
});

const GetSpellbookSchema = z.object({
    action: z.literal('get_spellbook'),
    characterId: z.string(),
    school: SchoolEnum.optional()
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// FINDINGS #96 (GAP 6): the obvious words normalize to the canonical types
// the resolver actually consumes — 'advantage' stored verbatim was a silent
// zero (stored, never matched). Write-time normalization; unknown types
// still store (Register B free-text stays legal) but the common vocabulary
// lands on the rails.
const MECHANIC_TYPE_ALIASES: Record<string, string> = {
    advantage: 'advantage_on', disadvantage: 'disadvantage_on',
    resistance: 'damage_resistance', resist: 'damage_resistance',
    immunity: 'damage_immunity', immune: 'damage_immunity',
    attack: 'attack_bonus', damage: 'damage_bonus',
    ac: 'ac_bonus', armor: 'ac_bonus', armour: 'ac_bonus',
    save: 'saving_throw_bonus', saves: 'saving_throw_bonus', saving_throw: 'saving_throw_bonus',
    skill: 'skill_bonus'
};
function normalizeMechanics<T extends { type: string }>(mechanics: T[] | undefined): T[] | undefined {
    return mechanics?.map(m => {
        const key = m.type.toLowerCase().trim();
        return MECHANIC_TYPE_ALIASES[key] ? { ...m, type: MECHANIC_TYPE_ALIASES[key] } : m;
    });
}

async function handleStunt(args: z.infer<typeof StuntSchema>, ctx?: SessionContext): Promise<object> {
    const { db, charRepo } = ensureDb();
    const seed = freshSeed(`stunt-${args.encounterId || 'free'}-${args.actorId}`);
    const rng = seedrandom(seed);

    // Validate every damage target before rolling or mutating any target. This
    // keeps a multi-target stunt atomic and prevents a successful response from
    // claiming damage that was never committed.
    const damageTargets = args.successDamage && args.targetIds
        ? args.targetIds.map((targetId) => charRepo.findById(targetId))
        : [];
    if (args.successDamage) {
        const missingTargetIds = (args.targetIds ?? []).filter((_, index) => !damageTargets[index]);
        if (missingTargetIds.length > 0) {
            throw new Error(`Damage target(s) not found: ${missingTargetIds.join(', ')}`);
        }
    }

    let skillModifier = 0;
    let actorName = 'Actor';
    // FINDINGS #49 (#48 fix): stunt now computes like roll_skill_check —
    // ability mod + proficiency + expertise — and SHOWS ITS WORKING. Twenty
    // stunts under-rolled by the proficiency bonus because the modifier was
    // a bare number nobody could audit. A roller prints its arithmetic.
    const modifierBreakdown: string[] = [];
    // #66-S: structured contributions — identical lane grammar to the
    // character rolls (#66). SHEET below; ENGINE/EFFECT/SITUATIONAL follow.
    const contributions: Array<{ label: string; value: number; lane: string; source?: string }> = [];
    try {
        const actor = charRepo.findById(args.actorId);
        if (actor?.stats) {
            actorName = actor.name;
            const abilityPart = getSkillModifier(actor.stats as Record<string, number>, args.skill);
            const skillKey = (args.skill || '').toLowerCase().replace(/ /g, '_');
            // #67-E: stealth/perception columns are authoritative on stunts too —
            // same displacement rule as roll_skill_check; one number per character.
            const colName = skillKey === 'stealth' ? 'stealth_bonus' : skillKey === 'perception' ? 'perception_bonus' : null;
            let colVal: number | null = null;
            if (colName) {
                const r = db.prepare(`SELECT ${colName} AS v FROM characters WHERE id = ?`).get(args.actorId) as { v?: number | null } | undefined;
                if (typeof r?.v === 'number') colVal = r.v;
            }
            if (colVal !== null) {
                skillModifier = colVal;
                modifierBreakdown.push(`${skillKey} column ${colVal >= 0 ? '+' : ''}${colVal} (authoritative)`);
                contributions.push({ label: `${skillKey}Bonus column`, value: colVal, lane: 'SHEET', source: colName ?? undefined });
            } else {
            skillModifier = abilityPart;
            modifierBreakdown.push(`ability ${abilityPart >= 0 ? '+' : ''}${abilityPart}`);
            contributions.push({ label: 'ability modifier', value: abilityPart, lane: 'SHEET', source: args.skill });
            const skills = (actor as { skillProficiencies?: string[] }).skillProficiencies || [];
            const expertise = (actor as { expertise?: string[] }).expertise || [];
            const prof = Math.floor((actor.level - 1) / 4) + 2;
            // FINDINGS #104-D: the SAME case-sensitivity hole #104 closed in
            // math_manage survived here — the stunt lane composed its own
            // membership tests. Normalize both sides (case-fold, strip
            // spaces/underscores); the pattern is fixed everywhere it exists,
            // not just where it was caught.
            const normOne = (s: string) => s.toLowerCase().replace(/[ _]/g, '');
            const normHas = (xs: string[], s: string) => xs.some(x => normOne(x) === normOne(s));
            if (normHas(expertise, skillKey)) {
                skillModifier += prof * 2;
                modifierBreakdown.push(`expertise +${prof * 2}`);
                contributions.push({ label: 'expertise', value: prof * 2, lane: 'SHEET' });
            } else if (normHas(skills, skillKey)) {
                skillModifier += prof;
                modifierBreakdown.push(`proficiency +${prof}`);
                contributions.push({ label: 'proficiency', value: prof, lane: 'SHEET' });
            }
            }
        }
    } catch { /* use defaults */ }

    // #66-S: stunts stop being blind to the sheet's traits — identical
    // composition to roll_skill_check: resolver auto-apply (ENGINE),
    // declaredEffects (EFFECT), modifier/declaredModifiers (SITUATIONAL),
    // all three double-count guard lanes. Wrapped: a stunt on a flavor NPC
    // with no effect rows must never throw.
    const autoApplied: import('../../engine/effects-resolver.js').AutoApplication[] = [];
    const resolverProblems: string[] = [];
    try {
        const skillKey = (args.skill || '').toLowerCase().replace(/ /g, '_');
        const mechs = loadAutoMechanics(db, args.actorId);
        skillModifier += autoSkillBonus(mechs, skillKey, autoApplied);
        const dRefs = args.declaredEffects ?? [];
        if (dRefs.length) {
            const res = applyDeclaredEffects(db, args.actorId, dRefs, 'skill_bonus', autoApplied);
            skillModifier += res.total;
            resolverProblems.push(...res.problems);
        }
        // Guard lane 3 (#66-V): declared copy of an auto-applied unconditional
        // backs out, warns loud.
        const autoNames = new Set(autoApplied.filter(a => !a.declared).map(a => a.effect.toLowerCase()));
        for (let i = autoApplied.length - 1; i >= 0; i--) {
            const a = autoApplied[i];
            if (a.declared && autoNames.has(a.effect.toLowerCase())) {
                skillModifier -= a.value;
                autoApplied.splice(i, 1);
                resolverProblems.push(`DOUBLE-COUNT GUARD: "${a.effect}" is unconditional and was already auto-applied by the resolver (ENGINE lane). The declaredEffects copy was NOT summed. Declare only conditional traits.`);
            }
        }
    } catch { /* actor without effect rows — stunt proceeds on SHEET alone */ }
    for (const a of autoApplied) {
        modifierBreakdown.push(`${a.effect} ${a.value >= 0 ? '+' : ''}${a.value}${a.declared ? ' (declared, engine-computed)' : ''}`);
        contributions.push({ label: a.effect, value: a.value, lane: a.declared ? 'EFFECT' : 'ENGINE' });
    }
    for (const p of resolverProblems) modifierBreakdown.push(`⚠ ${p}`);
    if (args.modifier) {
        skillModifier += args.modifier;
        modifierBreakdown.push(`situational ${args.modifier >= 0 ? '+' : ''}${args.modifier}`);
        contributions.push({ label: 'GM modifier', value: args.modifier, lane: 'SITUATIONAL' });
    }
    // Guard lane 1 (#66): declaredModifiers sum here (situational itemization)
    // unless colliding with a declaredEffects-applied name.
    const appliedNames = new Set(autoApplied.filter(a => a.declared).map(a => a.effect.toLowerCase()));
    for (const d of args.declaredModifiers ?? []) {
        if (appliedNames.has(d.label.toLowerCase())) {
            const warn = `DOUBLE-COUNT GUARD: "${d.label}" arrived via declaredEffects (engine-computed, applied) AND declaredModifiers. Counted ONCE, from declaredEffects; the declaredModifiers copy was NOT summed. Pass a trait through one lane only.`;
            resolverProblems.push(warn); modifierBreakdown.push(`⚠ ${warn}`);
            contributions.push({ label: `${d.label} (ignored — guard)`, value: d.value, lane: 'DECLARED' });
            continue;
        }
        skillModifier += d.value;
        modifierBreakdown.push(`${d.label} ${d.value >= 0 ? '+' : ''}${d.value} (declared)`);
        contributions.push({ label: d.label, value: d.value, lane: 'SITUATIONAL' });
    }

    const d20Result = rollD20(args.advantage, args.disadvantage, rng);
    const total = d20Result.roll + skillModifier;
    const isNat20 = d20Result.roll === 20;
    const isNat1 = d20Result.roll === 1;
    const beatDC = total >= args.dc;
    // A crit is the natural 20, nothing else. Beating the DC by 10 used to
    // crit too, which made any high-modifier character crit on most stunts.
    const criticalSuccess = isNat20;
    const criticalFailure = isNat1;
    const success = isNat20 || (beatDC && !isNat1);

    // FINDINGS #34 T4.17: stunt XP hook — the attempt is the lesson.
    // FINDINGS #51 (#50): any XP this call writes is REPORTED in JSON and
    // banner both — a tool that mutates persistent state says so in its own
    // output. The audit proved the engine never invents an award (no default
    // exists); this line makes a caller-supplied one impossible to miss.
    let xpAwarded: number | undefined;
    if (args.xpAward) {
        try {
            const xrow = charRepo.findById(args.actorId);
            if (xrow) {
                charRepo.update(args.actorId, { xp: ((xrow as { xp?: number }).xp ?? 0) + args.xpAward } as Partial<import('../../schema/character.js').Character>);
                xpAwarded = args.xpAward;
            }
        } catch { /* non-blocking */ }
    }

    const result: Record<string, unknown> = {
        success,
        resolution: success ? 'success' : 'failure',
        actionType: 'stunt',
        narrativeIntent: args.narrativeIntent,
        roll: d20Result.roll,
        rolls: d20Result.rolls,
        modifier: skillModifier,
        modifierBreakdown,
        xpAwarded,
        total,
        dc: args.dc,
        criticalSuccess,
        criticalFailure,
        skill: args.skill,
        actor: actorName,
        // FINDINGS #63: harmonized to house-standard field names (natural/bonus/
        // breakdown/outcome/characterName/message) so the PDA check grammar and
        // batch step lines consume stunts like every other roll. Old fields kept.
        natural: d20Result.roll,
        bonus: skillModifier,
        breakdown: modifierBreakdown,
        // #66-S: lane disclosure — renderCheck consumes these directly.
        contributions,
        autoApplied,
        resolverProblems: resolverProblems.length ? resolverProblems : undefined,
        outcome: success ? 'SUCCESS' : 'FAILURE',
        characterName: actorName,
        message: `${actorName} stunt (${args.skill}): d20(${d20Result.roll})=${d20Result.roll} + ${skillModifier} = ${total} vs DC ${args.dc} — ${success ? 'SUCCESS' : 'FAILURE'}`,
        effectType: args.effectType ?? (args.successDamage || args.failureDamage ? 'damage' : 'none')
    };

    if (success && args.successDamage) {
        const damageRoll = rollDice(args.successDamage, rng, criticalSuccess);
        result.damage = damageRoll.total;
        result.damageRolls = damageRoll.rolls;
        result.damageType = args.damageType || 'bludgeoning';

        if (args.targetIds) {
            const targets: Array<{
                id: string;
                damage: number;
                saved: boolean;
                save?: { natural: number; modifier: number; total: number; dc: number };
                condition?: string;
                applied: boolean;
                hpBefore?: number;
                hpAfter?: number;
            }> = [];
            for (let i = 0; i < args.targetIds.length; i++) {
                let targetDamage = result.damage as number;
                let saved = false;
                let save: { natural: number; modifier: number; total: number; dc: number } | undefined;

                if (args.savingThrowAbility && args.savingThrowDc) {
                    const saveStats = (damageTargets[i]?.stats ?? {}) as Record<string, number>;
                    const saveMod = Math.floor(((saveStats[args.savingThrowAbility] ?? 10) - 10) / 2);
                    const saveRoll = Math.floor(rng() * 20) + 1;
                    saved = saveRoll + saveMod >= args.savingThrowDc;
                    save = { natural: saveRoll, modifier: saveMod, total: saveRoll + saveMod, dc: args.savingThrowDc };
                    if (saved && args.halfDamageOnSave) targetDamage = Math.floor(targetDamage / 2);
                    else if (saved) targetDamage = 0;
                }

                const target = damageTargets[i];
                const hpBefore = target?.hp;
                const hpAfter = target ? Math.max(0, target.hp - targetDamage) : undefined;

                targets.push({
                    id: args.targetIds[i],
                    damage: targetDamage,
                    saved,
                    save,
                    condition: !saved && args.applyCondition ? args.applyCondition : undefined,
                    applied: Boolean(target),
                    hpBefore,
                    hpAfter
                });
            }
            const commitDamage = db.transaction(() => {
                for (const target of targets) {
                    if (target.hpBefore !== undefined && target.hpAfter !== undefined && target.hpAfter !== target.hpBefore) {
                        charRepo.update(target.id, { hp: target.hpAfter } as any);
                    }
                }
            });
            commitDamage();
            result.targets = targets;

            // Put the damage on the encounter sheet as well, so the next
            // combat action doesn't read a stale token.
            if (args.encounterId && ctx) {
                const engine = getOrLoadEngine(ctx, args.encounterId);
                const state = engine?.getState();
                if (state) {
                    syncParticipantHpFromDb(state);
                    new EncounterRepository(db).saveState(args.encounterId, state);
                    result.encounterTokensUpdated = true;
                }
            }
        }
    } else if (!success && criticalFailure && args.failureDamage) {
        const selfDamage = rollDice(args.failureDamage, rng);
        result.selfDamage = selfDamage.total;
    }

    return result;
}

async function handleApplyEffect(args: z.infer<typeof ApplyEffectSchema>): Promise<object> {
    const { effectsRepo, charRepo } = ensureDb();
    const callStarted = new Date().toISOString();
    const targetId = canonicalTargetId(charRepo, args.targetId);

    const effect = effectsRepo.apply({
        target_id: targetId,
        target_type: args.targetType,
        name: args.name,
        description: args.description || `${args.category} effect: ${args.name}`,
        category: args.category,
        power_level: args.powerLevel,
        source: { type: args.sourceType, entity_name: args.sourceEntityName },
        mechanics: normalizeMechanics(args.mechanics) as any,
        duration: { type: args.durationType as any, value: args.durationValue },
        triggers: args.triggers?.map(t => ({ event: t.event as any, condition: t.condition })) || [],
        removal_conditions: [{ type: 'duration_expires' as const }],
        stackable: false,
        max_stacks: 1
    });

    // NAME-COLLISION HONESTY: apply() on an existing non-stackable name
    // refreshes duration and returns the OLD row — new mechanics/description
    // are DISCARDED. Silent before; unmistakable now.
    const refreshedExisting = effect.created_at < callStarted;

    return {
        success: true,
        actionType: 'apply_effect',
        effect,
        refreshedExisting,
        ...(refreshedExisting && {
            warning: `An effect named "${args.name}" already exists on this target — its duration was refreshed and your NEW mechanics/description were DISCARDED. Effect names are identity: use a unique name (ledger-style numbering), or remove_effect first.`
        }),
        message: refreshedExisting
            ? `Existing effect "${args.name}" refreshed (new content discarded)`
            : `Effect "${args.name}" applied to ${args.targetId}`
    };
}

async function handleGetEffects(args: z.infer<typeof GetEffectsSchema>): Promise<object> {
    const { effectsRepo, charRepo } = ensureDb();

    const effects = effectsRepo.getEffectsOnTarget(
        canonicalTargetId(charRepo, args.targetId),
        args.targetType as ActorType,
        {
            category: args.category,
            source_type: args.sourceType,
            is_active: args.includeInactive ? undefined : true
        }
    );

    return {
        success: true,
        actionType: 'get_effects',
        targetId: args.targetId,
        count: effects.length,
        boons: effects.filter(e => e.category === 'boon'),
        curses: effects.filter(e => e.category === 'curse'),
        other: effects.filter(e => e.category !== 'boon' && e.category !== 'curse'),
        effects
    };
}

async function handleRemoveEffect(args: z.infer<typeof RemoveEffectSchema>): Promise<object> {
    if (args.effectId === undefined && !(args.targetId && args.targetType && args.effectName)) {
        return { error: true, message: 'Must provide either effectId or (targetId, targetType, effectName)' };
    }

    const { effectsRepo } = ensureDb();
    let removed = false;
    let effectName = '';

    if (args.effectId !== undefined) {
        const effect = effectsRepo.findById(args.effectId);
        effectName = effect?.name || `ID ${args.effectId}`;
        removed = effectsRepo.remove(args.effectId);
    } else if (args.targetId && args.targetType && args.effectName) {
        effectName = args.effectName;
        const { charRepo } = ensureDb();
        removed = effectsRepo.removeByName(canonicalTargetId(charRepo, args.targetId), args.targetType as ActorType, args.effectName);
    }

    return {
        success: removed,
        actionType: 'remove_effect',
        effectName,
        message: removed ? `Effect "${effectName}" removed` : `Effect "${effectName}" not found`
    };
}

async function handleReplaceEffect(args: z.infer<typeof ReplaceEffectSchema>): Promise<object> {
    const { db, effectsRepo, charRepo } = ensureDb();
    const targetId = canonicalTargetId(charRepo, args.targetId);

    // Resolve the OLD row first. The NEW payload already passed schema
    // validation (incl. the silent-zero mechanic guard) before this handler
    // ran — so a bad payload refused with the old row UNTOUCHED.
    let old: ReturnType<CustomEffectsRepository['findById']> = null;
    if (args.effectId !== undefined) {
        old = effectsRepo.findById(args.effectId);
    } else {
        const wantName = (args.effectName ?? args.name).toLowerCase();
        old = effectsRepo.getEffectsOnTarget(targetId, args.targetType as ActorType, {})
            .find(e => e.name.toLowerCase() === wantName) ?? null;
    }
    if (!old) {
        return {
            error: true,
            actionType: 'replace_effect',
            message: `replace_effect: old row not found (${args.effectId ?? args.effectName ?? args.name}) — nothing removed, nothing applied. Use apply_effect for a fresh row.`,
            writes: 'none'
        };
    }

    // Atomic swap — better-sqlite3 transaction: both writes or neither.
    const swap = db.transaction(() => {
        effectsRepo.remove(old!.id);
        return effectsRepo.apply({
            target_id: targetId,
            target_type: args.targetType,
            name: args.name,
            description: args.description || `${args.category} effect: ${args.name}`,
            category: args.category,
            power_level: args.powerLevel,
            source: { type: args.sourceType, entity_name: args.sourceEntityName },
            mechanics: normalizeMechanics(args.mechanics) as any,
            duration: { type: args.durationType as any, value: args.durationValue },
            triggers: args.triggers?.map(t => ({ event: t.event as any, condition: t.condition })) || [],
            removal_conditions: [{ type: 'duration_expires' as const }],
            stackable: false,
            max_stacks: 1
        });
    });
    const effect = swap();

    return {
        success: true,
        actionType: 'replace_effect',
        replacedId: old.id,
        replacedName: old.name,
        effect,
        message: `Effect "${old.name}" (row ${old.id}) replaced atomically → row ${effect.id} "${args.name}". No exposure window.`
    };
}

async function handleProcessTriggers(args: z.infer<typeof ProcessTriggersSchema>): Promise<object> {
    const { effectsRepo } = ensureDb();

    const triggeredEffects = effectsRepo.getEffectsByTrigger(
        args.targetId,
        args.targetType as ActorType,
        args.event as TriggerEvent
    );

    return {
        success: true,
        actionType: 'process_triggers',
        event: args.event,
        targetId: args.targetId,
        triggeredCount: triggeredEffects.length,
        effects: triggeredEffects.map(e => ({
            name: e.name,
            mechanics: e.mechanics
        }))
    };
}

async function handleAdvanceDurations(args: z.infer<typeof AdvanceDurationsSchema>): Promise<object> {
    const { effectsRepo } = ensureDb();

    const { advanced, expired } = effectsRepo.advanceRounds(
        args.targetId,
        args.targetType as ActorType,
        args.rounds
    );

    const cleanedUp = effectsRepo.cleanupExpired(args.targetId); // FINDINGS #102: scoped to the advanced target — global reaping is dead

    return {
        success: true,
        actionType: 'advance_durations',
        rounds: args.rounds,
        expiredCount: expired.length,
        expiredEffects: expired.map(e => e.name),
        remainingCount: advanced.length,
        remainingEffects: advanced.map(e => ({
            name: e.name,
            roundsRemaining: e.rounds_remaining
        })),
        cleanedUp
    };
}

async function handleSynthesize(args: z.infer<typeof SynthesizeSchema>): Promise<object> {
    const { db, charRepo } = ensureDb();
    const seed = freshSeed(`synthesis-${args.casterId}`);
    const rng = seedrandom(seed);

    let spellcastingModifier = 0;
    let casterName = 'Caster';
    let knownSpells: string[] = [];

    try {
        const caster = charRepo.findById(args.casterId);
        if (caster) {
            casterName = caster.name;
            knownSpells = caster.knownSpells || [];
            const stats = caster.stats as Record<string, number>;
            const intScore = stats.int ?? stats.intelligence ?? 10;
            spellcastingModifier = getAbilityModifier(intScore);
            const profBonus = Math.floor((caster.level || 1) / 4) + 2;
            spellcastingModifier += profBonus;
        }
    } catch { /* use defaults */ }

    // Calculate DC
    let dc = 10 + (args.estimatedLevel * 2);
    const dcBreakdown: Record<string, number> = {
        base: 10,
        spellLevel: args.estimatedLevel * 2
    };

    if (args.encounterId) {
        dc += 2;
        dcBreakdown.inCombat = 2;
    }

    const hasRelatedSpell = knownSpells.some(spell =>
        spell.toLowerCase().includes(args.school) ||
        spell.toLowerCase().includes(args.effectType)
    );

    if (!hasRelatedSpell) {
        dc += 3;
        dcBreakdown.novelEffect = 3;
    } else {
        dc -= 2;
        dcBreakdown.relatedSpell = -2;
    }

    if (args.materialValue) {
        const reduction = Math.min(5, Math.floor(args.materialValue / 100));
        dc -= reduction;
        dcBreakdown.materialReduction = -reduction;
    }

    if (args.circumstanceModifiers) {
        for (const modifier of args.circumstanceModifiers) {
            const lowerMod = modifier.toLowerCase();
            if (lowerMod.includes('ley line') || lowerMod.includes('magical nexus')) {
                dc -= 3;
                dcBreakdown.leyLine = -3;
            }
            if (lowerMod.includes('blood moon') || lowerMod.includes('eclipse')) {
                dc -= 2;
                dcBreakdown.celestialEvent = -2;
            }
            if (lowerMod.includes('desperation') || lowerMod.includes('urgency')) {
                dc += 2;
                dcBreakdown.desperation = 2;
            }
        }
    }

    const d20Roll = Math.floor(rng() * 20) + 1;
    const total = d20Roll + spellcastingModifier;
    const isNat20 = d20Roll === 20;
    const isNat1 = d20Roll === 1;
    const margin = total - dc;

    let outcome: string;
    if (isNat20 || margin >= 10) outcome = 'mastery';
    else if (total >= dc) outcome = 'success';
    else if (margin >= -5) outcome = 'fizzle';
    else if (isNat1 || margin <= -10) outcome = 'catastrophic';
    else outcome = 'backfire';

    const spellName = args.proposedName || `${casterName}'s ${args.school} ${args.effectType}`;
    const result: Record<string, unknown> = {
        success: outcome === 'mastery' || outcome === 'success',
        actionType: 'synthesize',
        outcome,
        roll: d20Roll,
        modifier: spellcastingModifier,
        total,
        dc,
        dcBreakdown,
        spellName,
        spellMastered: outcome === 'mastery',
        spellSlotConsumed: outcome !== 'mastery'
    };

    if (outcome === 'mastery' || outcome === 'success') {
        if (args.effectDice) {
            const effectRoll = rollDice(args.effectDice, rng);
            if (args.effectType === 'damage') result.damage = effectRoll.total;
            else if (args.effectType === 'healing') result.healing = effectRoll.total;
        }

        if (outcome === 'mastery') {
            // Save to spellbook
            try {
                const stmt = db.prepare(`
                    INSERT INTO synthesized_spells (
                        character_id, name, level, school, effect_type, effect_dice, damage_type,
                        targeting_type, targeting_range, targeting_area_size, targeting_max_targets,
                        saving_throw_ability, saving_throw_effect,
                        components_verbal, components_somatic, components_material,
                        concentration, duration, synthesis_dc, created_at, mastered_at, times_cast
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                stmt.run(
                    args.casterId, spellName, args.estimatedLevel, args.school, args.effectType,
                    args.effectDice || null, args.damageType || null,
                    args.targetingType, args.targetingRange, args.areaSize || null, args.maxTargets || null,
                    args.savingThrowAbility || null, args.savingThrowEffect || null,
                    args.verbal ? 1 : 0, args.somatic ? 1 : 0, args.materialValue ? `{"value": ${args.materialValue}}` : null,
                    args.concentration ? 1 : 0, args.duration, dc,
                    new Date().toISOString(), new Date().toISOString(), 1
                );
                result.addedToSpellbook = true;
            } catch { result.addedToSpellbook = false; }
        }
    } else if (outcome === 'backfire') {
        const backfireDamage = rollDice(`${args.estimatedLevel}d6`, rng);
        result.backfireDamage = backfireDamage.total;
    } else if (outcome === 'catastrophic') {
        const surgeRoll = Math.floor(rng() * 20) + 1;
        const wildSurge = WILD_SURGE_TABLE.find(ws => ws.roll === surgeRoll) || WILD_SURGE_TABLE[0];
        result.wildSurge = wildSurge;
    }

    return result;
}

async function handleGetSpellbook(args: z.infer<typeof GetSpellbookSchema>): Promise<object> {
    const { db } = ensureDb();

    let query = 'SELECT * FROM synthesized_spells WHERE character_id = ?';
    const params: (string | number)[] = [args.characterId];

    if (args.school) {
        query += ' AND school = ?';
        params.push(args.school);
    }
    query += ' ORDER BY level, name';

    const stmt = db.prepare(query);
    const rows = stmt.all(...params) as any[];

    const byLevel: Record<number, any[]> = {};
    for (const row of rows) {
        if (!byLevel[row.level]) byLevel[row.level] = [];
        byLevel[row.level].push(row);
    }

    return {
        success: true,
        actionType: 'get_spellbook',
        characterId: args.characterId,
        count: rows.length,
        spellsByLevel: byLevel,
        spells: rows
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<ImprovisationAction, ActionDefinition> = {
    stunt: {
        schema: StuntSchema,
        handler: handleStunt,
        aliases: ['resolve_stunt', 'rule_of_cool', 'improvise'],
        description: 'Resolve an improvised action using Rule of Cool'
    },
    apply_effect: {
        schema: ApplyEffectSchema,
        handler: handleApplyEffect,
        aliases: ['add_effect', 'boon', 'curse'],
        description: 'Apply a custom effect (boon/curse). Required: targetId, targetType, name, category, durationType, and mechanics[] where each is {type (closed enum), value (number|string), condition?}'
    },
    get_effects: {
        schema: GetEffectsSchema,
        handler: handleGetEffects,
        aliases: ['list_effects', 'effects'],
        description: 'Get all effects on a target'
    },
    remove_effect: {
        schema: RemoveEffectSchema,
        handler: handleRemoveEffect,
        aliases: ['delete_effect', 'dispel'],
        description: 'Remove a custom effect'
    },
    replace_effect: {
        schema: ReplaceEffectSchema,
        handler: handleReplaceEffect,
        aliases: ['swap_effect', 'update_effect', 'reapply'],
        description: 'FINDINGS #71: atomically remove an old effect row and apply its replacement in one transaction — no exposure window, validation refusal touches nothing'
    },
    process_triggers: {
        schema: ProcessTriggersSchema,
        handler: handleProcessTriggers,
        aliases: ['fire_triggers', 'triggers'],
        description: 'Process effect triggers for an event'
    },
    advance_durations: {
        schema: AdvanceDurationsSchema,
        handler: handleAdvanceDurations,
        aliases: ['tick_effects', 'advance'],
        description: 'Advance effect durations by rounds'
    },
    synthesize: {
        schema: SynthesizeSchema,
        handler: handleSynthesize,
        aliases: ['arcane_synthesis', 'create_spell'],
        description: 'Attempt to create a spell on the fly'
    },
    get_spellbook: {
        schema: GetSpellbookSchema,
        handler: handleGetSpellbook,
        aliases: ['synthesized_spells', 'spellbook'],
        description: 'Get synthesized spells for a character'
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

export const ImprovisationManageTool = {
    name: 'improvisation_manage',
    description: `Manage improvised actions, custom effects, and arcane synthesis.
Actions: stunt, apply_effect, get_effects, remove_effect, replace_effect, process_triggers, advance_durations, synthesize, get_spellbook
Aliases: rule_of_cool->stunt, boon/curse->apply_effect, dispel->remove_effect, swap_effect/update_effect->replace_effect, arcane_synthesis->synthesize

STUNT (Rule of Cool):
- DC 5-30 based on difficulty
- Supports advantage/disadvantage
- Critical success doubles damage
- Critical failure can cause self-damage
- Use effectType: "none" (or omit it) for a non-damaging check; omit successDamage, failureDamage, and damageType, e.g. { action: "stunt", actorId: "char_1", skill: "investigation", dc: 12, effectType: "none" }
- Use effectType: "damage" with successDamage/failureDamage when the stunt should cause harm
- If successDamage is supplied, targetIds is required and every target must exist; the committed HP changes are returned in targets[]

CUSTOM EFFECTS (apply_effect):
- Required: targetId, targetType, name, category, mechanics[], durationType
- mechanics[] = { type, value, condition? } — type is a CLOSED ENUM, value is a number (bonuses) or string (typed effects like "fire")
- type ∈ ${MechanicTypeSchema.options.join(', ')}
- Categories: boon, curse, neutral, transformative | Power levels 1-5 | Duration types: rounds, minutes, hours, days, permanent, until_removed
- Use custom_trigger (value 1) for narrative-only effects with no numeric rider
- Example: { action: "apply_effect", targetId: "char_1", targetType: "character", name: "Forge Blessing", category: "boon", powerLevel: 2, durationType: "until_removed", mechanics: [{ type: "attack_bonus", value: 2, condition: "melee" }, { type: "damage_resistance", value: "fire" }] }

ARCANE SYNTHESIS:
- DC = 10 + (spell level x 2) + modifiers
- Outcomes: mastery (learned!), success, fizzle, backfire, catastrophic
- Mastery permanently adds spell to spellbook`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        // Stunt params
        encounterId: z.string().optional(),
        actorId: z.string().optional(),
        actorType: z.enum(['character', 'npc']).optional(),
        targetIds: z.array(z.string()).optional(),
        targetTypes: z.array(z.enum(['character', 'npc'])).optional(),
        narrativeIntent: z.string().optional(),
        skill: z.string().optional(),
        dc: z.number().optional(),
        xpAward: z.number().optional().describe('XP credited to the actor (stunt)'),
        advantage: z.boolean().optional(),
        disadvantage: z.boolean().optional(),
        // #66-S mirror law: stunt roll-composition channels on the outer flat schema.
        modifier: z.number().optional().describe('Stunt: situational bonus (cover, footing) — SITUATIONAL lane, summed'),
        declaredModifiers: z.array(z.object({ label: z.string(), value: z.number() })).optional().describe('Stunt: itemized situational — summed unless colliding with declaredEffects (guard)'),
        declaredEffects: z.array(z.object({ name: z.string(), lane: z.string().optional() })).optional().describe('RESOLVER v2 on stunts: GM names the conditional trait; engine computes the value'),
        actionCost: z.string().optional(),
        effectType: z.string().optional().describe('stunt: none or damage; synthesize: damage, healing, status, utility, control, or summoning'),
        successDamage: z.string().optional(),
        failureDamage: z.string().optional(),
        damageType: z.string().optional(),
        applyCondition: z.string().optional(),
        savingThrowAbility: z.string().optional(),
        savingThrowDc: z.number().optional(),
        halfDamageOnSave: z.boolean().optional(),
        // Effect params
        targetId: z.string().optional(),
        targetType: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        category: z.string().optional(),
        powerLevel: z.number().optional(),
        sourceType: z.string().optional(),
        sourceEntityName: z.string().optional(),
        mechanics: z.array(z.any()).optional().describe('apply_effect: array of {type, value, condition?}. type is a closed enum (attack_bonus, damage_bonus, ac_bonus, saving_throw_bonus, skill_bonus, advantage_on, disadvantage_on, damage_resistance, damage_vulnerability, damage_immunity, damage_over_time, healing_over_time, extra_action, prevent_action, movement_modifier, sense_granted, sense_removed, speak_language, cannot_speak, custom_trigger). value is number for bonuses or string for typed effects'),
        durationType: z.string().optional(),
        durationValue: z.number().optional(),
        triggers: z.array(z.any()).optional().describe('apply_effect: array of {event, condition?}. event is a closed enum (always_active, start_of_turn, end_of_turn, on_attack, on_hit, on_miss, on_damage_taken, on_heal, on_rest, on_spell_cast, on_death)'),
        effectId: z.number().optional(),
        effectName: z.string().optional(),
        includeInactive: z.boolean().optional(),
        event: z.string().optional(),
        context: z.record(z.any()).optional(),
        rounds: z.number().optional(),
        // Synthesis params
        casterId: z.string().optional(),
        casterType: z.string().optional(),
        proposedName: z.string().optional(),
        estimatedLevel: z.number().optional(),
        school: z.string().optional(),
        effectDice: z.string().optional(),
        condition: z.string().optional(),
        targetingType: z.string().optional(),
        targetingRange: z.number().optional(),
        areaSize: z.number().optional(),
        maxTargets: z.number().optional(),
        savingThrowEffect: z.string().optional(),
        verbal: z.boolean().optional(),
        somatic: z.boolean().optional(),
        materialValue: z.number().optional(),
        concentration: z.boolean().optional(),
        duration: z.string().optional(),
        circumstanceModifiers: z.array(z.string()).optional(),
        characterId: z.string().optional()
    })
};

export async function handleImprovisationManage(args: unknown, ctx: SessionContext): Promise<McpResponse> {
    const result = await router(args as Record<string, unknown>, ctx);
    const parsed = JSON.parse(result.content[0].text);

    let output = '';

    if (parsed.error) {
        output = RichFormatter.header('Error', '');
        output += RichFormatter.alert(parsed.message || 'Unknown error', 'error');
        if (parsed.suggestions) {
            output += '\n**Did you mean:**\n';
            parsed.suggestions.forEach((s: { value: string; similarity: number }) => {
                output += `  - ${s.value} (${s.similarity}% match)\n`;
            });
        }
    } else {
        switch (parsed.actionType) {
            case 'stunt':
                // FINDINGS #63 (PDA Wave B): stunts render in the check grammar.
                output = pda.renderCheck(parsed);
                if (parsed.damage) output += `▌ ⌁ ${parsed.damage} ${parsed.damageType ?? ''}\n`;
                if (parsed.selfDamage) output += `▌ ⌁ backfire ${parsed.selfDamage}\n`;
                if (parsed.xpAwarded) output += `▌ xp +${parsed.xpAwarded} (written to the sheet by this call)\n`;
                break;

            case 'apply_effect':
                output = RichFormatter.header('Effect Applied', '');
                output += RichFormatter.keyValue({
                    'Name': parsed.effect?.name,
                    'Category': parsed.effect?.category,
                    'Power Level': parsed.effect?.power_level
                });
                break;

            case 'get_effects':
                output = RichFormatter.header(`Effects on ${parsed.targetId}`, '');
                output += `Total: ${parsed.count}\n`;
                if (parsed.boons?.length) {
                    output += '\nBoons:\n';
                    parsed.boons.forEach((e: { name: string }) => output += `  - ${e.name}\n`);
                }
                if (parsed.curses?.length) {
                    output += '\nCurses:\n';
                    parsed.curses.forEach((e: { name: string }) => output += `  - ${e.name}\n`);
                }
                break;

            case 'remove_effect':
                output = RichFormatter.header('Effect Removal', '');
                output += parsed.success ? `Removed: ${parsed.effectName}\n` : `Not found: ${parsed.effectName}\n`;
                break;

            case 'process_triggers':
                output = RichFormatter.header(`Triggers: ${parsed.event}`, '');
                output += `${parsed.triggeredCount} effect(s) triggered\n`;
                if (parsed.effects?.length) {
                    parsed.effects.forEach((e: { name: string }) => output += `  - ${e.name}\n`);
                }
                break;

            case 'advance_durations':
                output = RichFormatter.header('Durations Advanced', '');
                output += `Advanced ${parsed.rounds} round(s)\n`;
                if (parsed.expiredEffects?.length) {
                    output += `\nExpired: ${parsed.expiredEffects.join(', ')}\n`;
                }
                break;

            case 'synthesize':
                output = RichFormatter.header('Arcane Synthesis', '');
                output += RichFormatter.keyValue({
                    'Spell': parsed.spellName,
                    'Roll': `${parsed.roll} + ${parsed.modifier} = ${parsed.total}`,
                    'DC': parsed.dc,
                    'Outcome': parsed.outcome.toUpperCase()
                });
                if (parsed.spellMastered) output += '\nSpell mastered and added to spellbook!\n';
                if (parsed.damage) output += `\nDamage: ${parsed.damage}\n`;
                if (parsed.healing) output += `\nHealing: ${parsed.healing}\n`;
                if (parsed.backfireDamage) output += `\nBackfire damage: ${parsed.backfireDamage}\n`;
                if (parsed.wildSurge) output += `\nWILD SURGE: ${parsed.wildSurge.name} - ${parsed.wildSurge.effect}\n`;
                break;

            case 'get_spellbook':
                output = RichFormatter.header('Synthesized Spellbook', '');
                output += `Total spells: ${parsed.count}\n`;
                if (parsed.spellsByLevel) {
                    for (const [level, spells] of Object.entries(parsed.spellsByLevel as Record<string, Array<{ name: string; school: string }>>)) {
                        output += `\nLevel ${level}:\n`;
                        spells.forEach((s: { name: string; school: string }) => output += `  - ${s.name} (${s.school})\n`);
                    }
                }
                break;

            default:
                output = RichFormatter.header('Improvisation', '');
                if (parsed.message) output += parsed.message + '\n';
        }
    }

    output += RichFormatter.embedJson(parsed, 'IMPROVISATION_MANAGE');

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}
