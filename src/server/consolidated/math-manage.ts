/**
 * Consolidated Math Management Tool
 * Replaces 5 separate tools: dice_roll, probability_calculate, algebra_solve, algebra_simplify, physics_projectile
 */

import { z } from 'zod';
import { createActionRouter, ActionDefinition, McpResponse } from '../../utils/action-router.js';
import { SessionContext } from '../types.js';
import { RichFormatter } from '../utils/formatter.js';
import { DiceEngine } from '../../math/dice.js';
import { freshSeed } from '../../math/seed.js';
import { ProbabilityEngine } from '../../math/probability.js';
import { AlgebraEngine } from '../../math/algebra.js';
import { PhysicsEngine } from '../../math/physics.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { loadAutoMechanics, autoSkillBonus, autoSaveBonus, applyDeclaredEffects } from '../../engine/effects-resolver.js';
import * as pda from '../../render/pda.js';
import { ExportEngine } from '../../math/export.js';
import { CalculationRepository, StoredCalculation } from '../../storage/repos/calculation.repo.js';
import { getDb } from '../../storage/index.js';
import { ExportFormatSchema } from '../../math/schemas.js';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const ACTIONS = [
    'roll', 'probability', 'solve', 'simplify', 'projectile',
    'roll_skill_check', 'roll_ability_check', 'roll_saving_throw', 'opposed', 'reroll', 'roll_pool_check'
] as const;
type MathAction = typeof ACTIONS[number];

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE HELPER
// ═══════════════════════════════════════════════════════════════════════════

function getRepo() {
    const db = getDb();
    return { repo: new CalculationRepository(db), db };
}

function logCalculationEvent(db: Database.Database, calculationId: string, type: string, sessionId?: string) {
    db.prepare(`
        INSERT INTO event_logs (type, payload, timestamp)
        VALUES (?, ?, ?)
    `).run('calculation', JSON.stringify({
        calculationId,
        calculationType: type,
        sessionId
    }), new Date().toISOString());
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const SKILL_ABILITY: Record<string, string> = {
    athletics: 'str',
    acrobatics: 'dex', sleight_of_hand: 'dex', stealth: 'dex',
    arcana: 'int', history: 'int', investigation: 'int', nature: 'int', religion: 'int',
    animal_handling: 'wis', insight: 'wis', medicine: 'wis', perception: 'wis', survival: 'wis',
    deception: 'cha', intimidation: 'cha', performance: 'cha', persuasion: 'cha'
};

const jsonIfString = (v: unknown) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; };

const DeclaredEffectRefSchema = z.object({ name: z.string(), lane: z.string().optional() });

const CheckBaseFields = {
    characterId: z.string().describe('Character making the roll'),
    dc: z.number().int().optional().describe('Difficulty class — success/failure reported when provided'),
    advantage: z.boolean().optional(),
    disadvantage: z.boolean().optional(),
    modifier: z.number().int().optional().describe('Situational GM modifier (cover, tools, circumstance) — declared, added to the total'),
    declaredModifiers: z.array(z.object({ label: z.string(), value: z.number() })).optional().describe('FINDINGS #34 T4.18: labeled declared modifiers — VALUES ARE APPLIED to the total and each prints in the breakdown by name'),
    declaredEffects: z.preprocess(jsonIfString, z.array(DeclaredEffectRefSchema)).optional().describe('FINDINGS #60 RESOLVER v2: GM declares WHICH conditional trait fires (name + lane for multi-lane traits); the ENGINE reads the row and computes the value — including tier-from-hidden-pool (valueFromPool). Missing names and ambiguous lanes report loudly and apply nothing.')
};

const RollSkillCheckSchema = z.object({
    action: z.literal('roll_skill_check'),
    skill: z.string().describe('Skill name (perception, stealth, persuasion... or any theme skill)'),
    ability: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional().describe('Governing ability — overrides the 5e default map; REQUIRED in practice for non-5e skill lists'),
    ...CheckBaseFields
});
const RollAbilityCheckSchema = z.object({
    action: z.literal('roll_ability_check'),
    ability: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']),
    ...CheckBaseFields
});
const RollSavingThrowSchema = z.object({
    action: z.literal('roll_saving_throw'),
    ability: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']),
    ...CheckBaseFields
});

// #67: OPPOSED — two full #66 compositions, one verdict. Kills the
// roll-twice-compare-by-hand pattern (grapples, stealth-vs-perception).
// Tie = status quo holds (defender), per canon.
const OpposedSchema = z.object({
    action: z.literal('opposed'),
    characterId: z.string().describe('Initiator — the one forcing the contest'),
    skill: z.string().optional().describe('Initiator skill (omit for raw ability)'),
    ability: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional().describe('Initiator ability — governs or overrides'),
    targetId: z.string().describe('Defender'),
    targetSkill: z.string().optional().describe('Defender skill'),
    targetAbility: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional().describe('Defender ability'),
    advantage: z.boolean().optional(), disadvantage: z.boolean().optional(),
    targetAdvantage: z.boolean().optional(), targetDisadvantage: z.boolean().optional(),
    modifier: z.number().int().optional().describe('Initiator situational modifier'),
    declaredModifiers: z.array(z.object({ label: z.string(), value: z.number() })).optional(),
    declaredEffects: z.preprocess(jsonIfString, z.array(DeclaredEffectRefSchema)).optional().describe('Initiator declaredEffects — engine computes')
});

function d20(advantage?: boolean, disadvantage?: boolean): { rolls: number[]; natural: number } {
    const r = () => Math.floor(Math.random() * 20) + 1;
    if (advantage && !disadvantage) { const a = r(), b = r(); return { rolls: [a, b], natural: Math.max(a, b) }; }
    if (disadvantage && !advantage) { const a = r(), b = r(); return { rolls: [a, b], natural: Math.min(a, b) }; }
    const a = r(); return { rolls: [a], natural: a };
}

function abilityMod(score: number): number { return Math.floor((score - 10) / 2); }
function profBonus(level: number): number { return Math.floor((level - 1) / 4) + 2; }

async function handleCharacterRoll(
    kind: 'skill' | 'ability' | 'save',
    args: { characterId: string; skill?: string; ability?: string; dc?: number; advantage?: boolean; disadvantage?: boolean; modifier?: number }
): Promise<object> {
    const db = getDb();
    const charRepo = new CharacterRepository(db);
    const char = charRepo.findById(args.characterId);
    if (!char) return { error: true, message: `Character ${args.characterId} not found` };
    // FINDINGS #75: canonicalize IMMEDIATELY — #74's smoke roll resolved the
    // character via prefix and then fed the RAW short id into the effects
    // query, which matched nothing: Psar's Hand silently missing from a
    // survival roll reported green. The full id is the only id that touches
    // SQL from here down.
    const charId = char.id;
    args = { ...args, characterId: charId };

    const stats = char.stats as Record<string, number>;
    // FINDINGS #104: membership tests below were CASE-SENSITIVE while sheets
    // store human-cased names ("Acrobatics") — proficiency and expertise were
    // silently ABSENT on every roll for any capitalized sheet (the HARENA
    // campaign rolled light by prof for four sessions; expertise skills by
    // double). Normalize both sides: case-fold, strip spaces/underscores.
    const normOne = (s: string) => s.toLowerCase().replace(/[ _]/g, '');
    const normHas = (xs: string[], s: string) => xs.some(x => normOne(x) === normOne(s));
    const autoApplied: import('../../engine/effects-resolver.js').AutoApplication[] = [];
    const mechs = loadAutoMechanics(db, args.characterId);
    const breakdown: string[] = [];
    // #66: structured contributions — every summed number carries a lane.
    // SHEET (stat/prof) · ENGINE (unconditional trait) · EFFECT (declared,
    // engine-computed) · SITUATIONAL (GM-passed this call). DECLARED rows
    // are audit-only ON THE ATTACK PATH; on math rolls declaredModifiers
    // have always SUMMED (they are the situational itemization here) —
    // the lane column now states that per-path truth.
    const contributions: Array<{ label: string; value: number; lane: string; source?: string }> = [];
    let bonus = 0;

    if (kind === 'skill') {
        const skill = (args.skill || '').toLowerCase().replace(/ /g, '_');
        const ability = args.ability || SKILL_ABILITY[skill] || 'wis';
        const mod = abilityMod(stats[ability] ?? 10);
        // #67-E: stealth/perception COLUMNS are authoritative when present.
        // The eavesdrop listener layer already rolls these columns (Findings
        // #6); until now a contested stealth check composed DEX+prof instead —
        // two disagreeing stealth numbers per character. One number now: the
        // column displaces the composition and the block discloses it.
        const colName = skill === 'stealth' ? 'stealth_bonus' : skill === 'perception' ? 'perception_bonus' : null;
        let colVal: number | null = null;
        if (colName) {
            const r = db.prepare(`SELECT ${colName} AS v FROM characters WHERE id = ?`).get(args.characterId) as { v?: number | null } | undefined;
            if (typeof r?.v === 'number') colVal = r.v;
        }
        if (colVal !== null) {
            bonus += colVal;
            breakdown.push(`${skill} column ${colVal >= 0 ? '+' : ''}${colVal} (authoritative — the same number the listener layer rolls)`);
            contributions.push({ label: `${skill}Bonus column`, value: colVal, lane: 'SHEET', source: colName ?? undefined });
            const skills0 = (char as { skillProficiencies?: string[] }).skillProficiencies || [];
            const composed = mod + (normHas(skills0, skill) ? profBonus(char.level) : 0);
            if (composed !== colVal)
                breakdown.push(`⚠ ${skill} column (${colVal >= 0 ? '+' : ''}${colVal}) displaces composed ${ability.toUpperCase()}+prof (${composed >= 0 ? '+' : ''}${composed}) — one ${skill} number per character`);
        } else {
        bonus += mod; breakdown.push(`${ability.toUpperCase()} ${mod >= 0 ? '+' : ''}${mod}`);
        contributions.push({ label: `${ability.toUpperCase()} modifier`, value: mod, lane: 'SHEET', source: ability });
        const skills = (char as { skillProficiencies?: string[] }).skillProficiencies || [];
        const expertise = (char as { expertise?: string[] }).expertise || [];
        if (normHas(expertise, skill)) {
            const p = profBonus(char.level) * 2; bonus += p; breakdown.push(`expertise +${p}`);
            contributions.push({ label: 'expertise', value: p, lane: 'SHEET' });
        } else if (normHas(skills, skill)) {
            const p = profBonus(char.level); bonus += p; breakdown.push(`proficiency +${p}`);
            contributions.push({ label: 'proficiency', value: p, lane: 'SHEET' });
        }
        }
        bonus += autoSkillBonus(mechs, skill, autoApplied);
    } else if (kind === 'ability') {
        const mod = abilityMod(stats[args.ability!] ?? 10);
        bonus += mod; breakdown.push(`${args.ability!.toUpperCase()} ${mod >= 0 ? '+' : ''}${mod}`);
        contributions.push({ label: `${args.ability!.toUpperCase()} modifier`, value: mod, lane: 'SHEET', source: args.ability });
    } else {
        const mod = abilityMod(stats[args.ability!] ?? 10);
        bonus += mod; breakdown.push(`${args.ability!.toUpperCase()} ${mod >= 0 ? '+' : ''}${mod}`);
        contributions.push({ label: `${args.ability!.toUpperCase()} modifier`, value: mod, lane: 'SHEET', source: args.ability });
        const saves = (char as { saveProficiencies?: string[] }).saveProficiencies || [];
        const longNames: Record<string, string> = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
        if (normHas(saves, args.ability!) || normHas(saves, longNames[args.ability!] ?? '')) {
            const p = profBonus(char.level); bonus += p; breakdown.push(`save proficiency +${p}`);
            contributions.push({ label: 'save proficiency', value: p, lane: 'SHEET' });
        }
        bonus += autoSaveBonus(mechs, longNames[args.ability!], autoApplied);
    }

    // ─── RESOLVER v2 (FINDINGS #60): declared-effects channel — the GM names
    // the conditional trait; the engine computes its value from the row
    // (fixed or pool-derived) and applies it. Problems report loudly.
    const dRefs = (args as { declaredEffects?: Array<{ name: string; lane?: string }> }).declaredEffects ?? [];
    const resolverProblems: string[] = [];
    if (dRefs.length) {
        const wantType = kind === 'save' ? 'saving_throw_bonus' : 'skill_bonus';
        // FINDINGS #101: name the domain so skill/save-scoped mechanics refuse
        // the wrong roll loudly instead of summing silently.
        const longNames: Record<string, string> = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
        const domain = kind === 'save' ? (longNames[args.ability!] ?? args.ability) : kind === 'skill' ? args.skill : args.ability;
        const res = applyDeclaredEffects(db, args.characterId, dRefs, wantType, autoApplied, domain);
        bonus += res.total;
        resolverProblems.push(...res.problems);
    }

    // #66-V DOUBLE-COUNT GUARD, third collision lane (caught live by the
    // disclosure block on its first probe): an UNCONDITIONAL trait the
    // resolver already auto-applied must not sum again when the GM also
    // declares it. Counted once, from the auto-apply; the declared copy is
    // backed out and the block says so.
    const autoNames = new Set(autoApplied.filter(a => !a.declared).map(a => a.effect.toLowerCase()));
    for (let i = autoApplied.length - 1; i >= 0; i--) {
        const a = autoApplied[i];
        if (a.declared && autoNames.has(a.effect.toLowerCase())) {
            bonus -= a.value;
            autoApplied.splice(i, 1);
            resolverProblems.push(`DOUBLE-COUNT GUARD: "${a.effect}" is unconditional and was already auto-applied by the resolver (ENGINE lane). The declaredEffects copy was NOT summed. Declare only conditional traits.`);
        }
    }

    for (const a of autoApplied) breakdown.push(`${a.effect} ${a.value >= 0 ? '+' : ''}${a.value}${a.declared ? ' (declared, engine-computed)' : ''}`);
    for (const a of autoApplied) contributions.push({ label: a.effect, value: a.value, lane: a.declared ? 'EFFECT' : 'ENGINE' });
    for (const p of resolverProblems) breakdown.push(`⚠ ${p}`);
    if (args.modifier) { bonus += args.modifier; breakdown.push(`situational ${args.modifier >= 0 ? '+' : ''}${args.modifier}`); contributions.push({ label: 'GM modifier', value: args.modifier, lane: 'SITUATIONAL' }); }
    // #66 DOUBLE-COUNT GUARD (real math on this path): declaredModifiers SUM
    // here — if a label matches a declaredEffects-applied trait name, the
    // engine already applied it. Skip the sum, keep the audit row, and warn.
    const appliedNames = new Set(autoApplied.filter(a => a.declared).map(a => a.effect.toLowerCase()));
    for (const d of (args as { declaredModifiers?: Array<{ label: string; value: number }> }).declaredModifiers ?? []) {
        if (appliedNames.has(d.label.toLowerCase())) {
            const warn = `DOUBLE-COUNT GUARD: "${d.label}" arrived via declaredEffects (engine-computed, applied) AND declaredModifiers. Counted ONCE, from declaredEffects; the declaredModifiers copy was NOT summed. Pass a trait through one lane only.`;
            resolverProblems.push(warn); breakdown.push(`⚠ ${warn}`);
            contributions.push({ label: `${d.label} (ignored — guard)`, value: d.value, lane: 'DECLARED' });
            continue;
        }
        bonus += d.value; breakdown.push(`${d.label} ${d.value >= 0 ? '+' : ''}${d.value} (declared)`);
        contributions.push({ label: d.label, value: d.value, lane: 'SITUATIONAL' });
    }

    const roll = d20(args.advantage, args.disadvantage);
    const total = roll.natural + bonus;
    const success = args.dc !== undefined ? total >= args.dc : undefined;

    // FINDINGS #69: the trio persists like raw rolls, so reroll can supersede
    // them. Metadata carries the character bonus — a reroll of a skill check
    // re-rolls the DIE and re-applies the stored bonus, not a naked d20.
    const calcId = randomUUID();
    try {
        new CalculationRepository(db).create({
            id: calcId,
            input: args.advantage && !args.disadvantage ? '2d20kh1' : args.disadvantage && !args.advantage ? '2d20kl1' : '1d20',
            result: roll.natural,
            steps: [`${kind}:${args.skill ?? args.ability ?? ''}`, `natural ${roll.natural}`, `bonus ${bonus}`, `total ${total}`],
            timestamp: new Date().toISOString(),
            metadata: { characterRoll: { kind, characterId: args.characterId, skill: args.skill, ability: args.ability, bonus, breakdown, dc: args.dc, total } }
        });
    } catch { /* persistence is audit sugar — the roll stands regardless */ }

    return {
        success: true,
        calculationId: calcId,
        actionType: `roll_${kind === 'save' ? 'saving_throw' : kind + '_check'}`,
        characterId: args.characterId,
        characterName: char.name,
        skill: args.skill,
        ability: args.ability,
        rolls: roll.rolls,
        natural: roll.natural,
        bonus,
        total,
        breakdown,
        contributions,
        autoApplied,
        resolverProblems: resolverProblems.length ? resolverProblems : undefined,
        dc: args.dc,
        outcome: success === undefined ? 'no DC set' : success ? 'SUCCESS' : 'FAILURE',
        message: `${char.name} ${kind === 'save' ? `${args.ability!.toUpperCase()} save` : (args.skill || args.ability)}: d20(${roll.rolls.join(',')})=${roll.natural} + ${bonus} = ${total}${args.dc !== undefined ? ` vs DC ${args.dc} — ${success ? 'SUCCESS' : 'FAILURE'}` : ''}`
    };
}

const RollSchema = z.object({
    action: z.literal('roll'),
    expression: z.string().describe('Dice notation: 2d6+3, 4d6dl1, 2d20kh1, 2d6!'),
    successThreshold: z.number().int().optional().describe('Dice-pool mode (WoD/Shadowrun-likes): count individual dice >= this value as successes; result gains successes/botches fields'),
    // #66-B (bug: outer schema advertised dc; inner strip silently discarded
    // it — a raw roll with a target evaluated nothing). dc now lands.
    dc: z.number().optional().describe('Optional target: total >= dc evaluates SUCCESS/FAILURE; absent = NO TARGET SET'),
    seed: z.string().optional(),
    exportFormat: ExportFormatSchema.optional().default('json')
});

const ProbabilitySchema = z.object({
    action: z.literal('probability'),
    expression: z.string().describe('Dice expression to analyze'),
    target: z.number().int().describe('Target value to compare against'),
    comparison: z.enum(['gte', 'lte', 'eq', 'gt', 'lt']).default('gte'),
    exportFormat: ExportFormatSchema.optional().default('plaintext')
});

const SolveSchema = z.object({
    action: z.literal('solve'),
    equation: z.string().describe('Algebraic equation to solve'),
    variable: z.string().optional().default('x'),
    exportFormat: ExportFormatSchema.optional().default('plaintext')
});

const SimplifySchema = z.object({
    action: z.literal('simplify'),
    expression: z.string().describe('Algebraic expression to simplify'),
    exportFormat: ExportFormatSchema.optional().default('plaintext')
});

const ProjectileSchema = z.object({
    action: z.literal('projectile'),
    velocity: z.number().describe('Initial velocity in m/s'),
    angle: z.number().describe('Launch angle in degrees'),
    height: z.number().optional().default(0).describe('Initial height in meters'),
    gravity: z.number().optional().default(9.81).describe('Gravity acceleration'),
    exportFormat: ExportFormatSchema.optional().default('plaintext')
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// #67: OPPOSED — both sides run the FULL handleCharacterRoll composition
// (SHEET + ENGINE traits + EFFECT declaredEffects + SITUATIONAL + all guard
// lanes), then one verdict. No dc on either side — the other roll IS the dc.
async function handleOpposed(args: z.infer<typeof OpposedSchema>): Promise<object> {
    const iKind = args.skill ? 'skill' : 'ability';
    const initiator = await handleCharacterRoll(iKind, {
        characterId: args.characterId, skill: args.skill, ability: args.ability ?? (args.skill ? undefined : 'str'),
        advantage: args.advantage, disadvantage: args.disadvantage,
        modifier: args.modifier,
        declaredModifiers: args.declaredModifiers as never, declaredEffects: args.declaredEffects as never
    } as Parameters<typeof handleCharacterRoll>[1]);
    if ((initiator as { error?: boolean }).error) return initiator;

    const tKind = args.targetSkill ? 'skill' : 'ability';
    const defender = await handleCharacterRoll(tKind, {
        characterId: args.targetId, skill: args.targetSkill, ability: args.targetAbility ?? (args.targetSkill ? undefined : 'str'),
        advantage: args.targetAdvantage, disadvantage: args.targetDisadvantage
    } as Parameters<typeof handleCharacterRoll>[1]);
    if ((defender as { error?: boolean }).error) return defender;

    const i = initiator as { total?: number; characterName?: string };
    const d = defender as { total?: number; characterName?: string };
    const margin = (i.total ?? 0) - (d.total ?? 0);
    const winner = margin > 0 ? 'initiator' : margin < 0 ? 'defender' : 'tie';
    return {
        success: true,
        actionType: 'opposed',
        initiator, defender,
        winner,
        winnerId: winner === 'initiator' ? args.characterId : winner === 'defender' ? args.targetId : null,
        winnerName: winner === 'initiator' ? i.characterName : winner === 'defender' ? d.characterName : null,
        margin: Math.abs(margin),
        statusQuoHolds: winner !== 'initiator',
        message: winner === 'tie'
            ? `OPPOSED: ${i.characterName} ${i.total} vs ${d.characterName} ${d.total} — TIE, status quo holds`
            : `OPPOSED: ${winner === 'initiator' ? i.characterName : d.characterName} wins by ${Math.abs(margin)} (${i.total} vs ${d.total})`
    };
}

// #67-F: DECLARED REROLL — Tom's ask. Retry-as-reroll re-executes writes and
// leaves no record; a declared reroll is honest table practice. Budget: pool
// 'rerolls' on the character — seeded at 10/10 on first use, spent 1 per
// reroll, GM credits more via adjust_pool (earnable). Re-runs the stored
// expression with a FRESH seed; both results returned; new calc's metadata
// records supersedes: originalId.
const RerollSchema = z.object({
    action: z.literal('reroll'),
    calculationId: z.string().describe('The stored roll to supersede (calc id from any raw-roll block)'),
    characterId: z.string().describe('Whose reroll budget pays — pool \'rerolls\', seeded 10/10 on first use'),
    dc: z.number().optional().describe('Optional target for the new roll')
});

async function handleReroll(args: z.infer<typeof RerollSchema>, sessionId?: string): Promise<object> {
    const { repo, db } = getRepo();
    const original = repo.findById(args.calculationId);
    if (!original) return { error: true, actionType: 'reroll', message: `Calculation ${args.calculationId} not found`, writes: 'none' };

    // Budget check BEFORE any write — a refused reroll costs nothing (#59).
    const charRepo = new CharacterRepository(db);
    const char = charRepo.findById(args.characterId);
    if (!char) return { error: true, actionType: 'reroll', message: `Character ${args.characterId} not found`, writes: 'none' };
    const pools = { ...((char as { resourcePools?: Record<string, { current: number; max: number }> }).resourcePools || {}) };
    const budget = pools['rerolls'] ?? { current: 10, max: 10 };
    if (budget.current <= 0) {
        return { error: true, actionType: 'reroll', message: `No rerolls left (0/${budget.max}). Earn more — the GM credits pool 'rerolls'.`, rerollsLeft: 0, writes: 'none' };
    }

    const rerollSeed = freshSeed('reroll');
    const engine = new DiceEngine(rerollSeed);
    const result = engine.roll(original.input);

    pools['rerolls'] = { ...budget, current: budget.current - 1 };
    charRepo.update(args.characterId, { resourcePools: pools } as never);

    // FINDINGS #69: a superseded TRIO roll carries its character bonus in
    // metadata.characterRoll — re-apply it so a rerolled skill check stays a
    // skill check, not a naked d20 compared to a full-check DC.
    const cr = (original.metadata as { characterRoll?: { bonus?: number; breakdown?: string[]; kind?: string; skill?: string; ability?: string; dc?: number } } | undefined)?.characterRoll;
    const rerollBonus = cr?.bonus ?? 0;
    const rerollTotal = Number(result.result) + rerollBonus;
    const effectiveDc = args.dc ?? cr?.dc;

    const calculation: StoredCalculation = {
        id: randomUUID(),
        sessionId,
        ...result,
        seed: rerollSeed,
        metadata: { ...(result.metadata as object ?? {}), supersedes: args.calculationId, ...(cr ? { characterRoll: { ...cr, total: rerollTotal } } : {}) }
    } as StoredCalculation;
    repo.create(calculation);

    return {
        success: true,
        actionType: 'reroll',
        expression: original.input,
        original: { calculationId: original.id, total: original.result, superseded: true },
        natural: Number(result.result),
        bonus: rerollBonus,
        ...(cr?.breakdown ? { breakdown: cr.breakdown } : {}),
        ...(cr ? { characterRoll: { kind: cr.kind, skill: cr.skill, ability: cr.ability } } : {}),
        total: rerollTotal,
        rolls: result.steps,
        ...(effectiveDc !== undefined && { dc: effectiveDc, outcome: rerollTotal >= effectiveDc ? 'SUCCESS' : 'FAILURE' }),
        seed: rerollSeed,
        calculationId: calculation.id,
        rerollsLeft: budget.current - 1,
        message: `REROLL: ${original.input}${cr ? ` (${cr.kind}${cr.skill ? ':' + cr.skill : cr.ability ? ':' + cr.ability : ''})` : ''} — was ${original.result} (superseded), now ${result.result}${rerollBonus ? ` + ${rerollBonus} = ${rerollTotal}` : ''}. ${budget.current - 1}/${budget.max} rerolls left.`
    };
}

// #67-W: STORYTELLER POOL CHECK — the World of Darkness lane. The engine
// rolls Nd10, counts successes vs difficulty, cancels on ones (classic),
// declares botch (zero net successes with ones showing), doubles 10s on
// specialty. Dots may be passed as numbers (GM reads the sheet — Register B,
// same split as travel rads) or as stat-key strings resolved off the row.
const PoolCheckSchema = z.object({
    action: z.literal('roll_pool_check'),
    characterId: z.string().optional().describe('For name/provenance and stat-key resolution'),
    poolLabel: z.string().optional().describe('What is being rolled — "Dexterity + Brawl", "Rage", "Perception + Alertness"'),
    attribute: z.union([z.number().int().min(0), z.string()]).optional().describe('Attribute dots (number) or stat key to resolve'),
    ability: z.union([z.number().int().min(0), z.string()]).optional().describe('Ability dots (number) or stat key to resolve'),
    poolModifier: z.number().int().optional().default(0).describe('Situational dice added/removed (wound penalties, equipment)'),
    difficulty: z.number().int().min(2).max(10).optional().default(6),
    specialty: z.boolean().optional().default(false).describe('10s count as two successes'),
    cancelOnes: z.boolean().optional().default(true).describe('Classic botch rules: 1s cancel successes; false = 1s only botch on zero'),
    willpowerAuto: z.boolean().optional().default(false).describe('+1 automatic success (GM decrements the willpower pool separately — adjust_pool)'),
    seed: z.string().optional()
});

async function handlePoolCheck(args: z.infer<typeof PoolCheckSchema>, sessionId?: string): Promise<object> {
    const { repo, db } = getRepo();
    let characterName: string | undefined;
    const resolveDots = (v: number | string | undefined): number => {
        if (typeof v === 'number') return v;
        // FINDINGS #110 ROOT: the transport stringifies `attribute` ("3") while
        // `ability` arrives numeric; a numeric string with no characterId fell
        // through to 0. Numeric strings are DOTS, full stop — parsed before the
        // stat-key branch (the #104 normalization spirit: inputs normalize).
        if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return parseInt(v, 10);
        if (typeof v === 'string' && args.characterId) {
            const charRepo = new CharacterRepository(db);
            const c = charRepo.findById(args.characterId);
            characterName = c?.name ?? characterName;
            const stats = (c?.stats ?? {}) as Record<string, number>;
            const hit = stats[v] ?? stats[v.toLowerCase()];
            if (typeof hit === 'number') return hit;
        }
        return 0;
    };
    if (args.characterId && !characterName) {
        const c = new CharacterRepository(db).findById(args.characterId);
        characterName = c?.name;
    }
    // FINDINGS #110: compose with DISCLOSURE — the pool prints its own arithmetic
    // (attribute + ability + modifier) and echoes the keys it received. Live
    // probe showed `attribute` dropped by name somewhere upstream (3+2 rolled 2
    // dice; 4+0 refused as zero) while schema, router, and composition all read
    // correct on disk — the #108 pattern: instrument, don't theorize.
    const attrDots = resolveDots(args.attribute);
    const abilDots = resolveDots(args.ability);
    const modDots = args.poolModifier ?? 0;
    const composition = { attribute: attrDots, ability: abilDots, modifier: modDots, receivedKeys: Object.keys(args as object) };
    const poolSize = Math.max(0, attrDots + abilDots + modDots);
    if (poolSize === 0) {
        return { error: true, actionType: 'roll_pool_check', message: 'Pool composed to 0 dice — pass dots as numbers or resolvable stat keys (chance die rules ride a later wave)', composition, writes: 'none' };
    }
    const poolSeed = args.seed ?? freshSeed('pool');
    const engine = new DiceEngine(poolSeed);
    const result = engine.roll(`${poolSize}d10`);
    const dice: number[] = ((result.metadata as { rolls?: number[] } | undefined)?.rolls ?? []);
    const tens = dice.filter(d => d === 10).length;
    const ones = dice.filter(d => d === 1).length;
    const base = dice.filter(d => d >= args.difficulty).length + (args.specialty ? tens : 0);
    const cancelled = args.cancelOnes ? Math.min(ones, base) : 0;
    let successes = base - cancelled + (args.willpowerAuto ? 1 : 0);
    const botch = base === 0 && ones > 0 && !args.willpowerAuto;
    if (botch) successes = 0;

    const calculation: StoredCalculation = {
        id: randomUUID(), sessionId, ...result, seed: poolSeed,
        metadata: { ...(result.metadata as object ?? {}), storyteller: { difficulty: args.difficulty, successes, botch } }
    } as StoredCalculation;
    repo.create(calculation);

    return {
        success: true,
        actionType: 'roll_pool_check',
        characterId: args.characterId,
        characterName,
        poolLabel: args.poolLabel ?? 'pool',
        poolSize,
        composition,
        difficulty: args.difficulty,
        dice,
        successesRaw: base,
        onesCancelled: cancelled,
        successes,
        botch,
        specialty: args.specialty || undefined,
        willpowerAuto: args.willpowerAuto || undefined,
        seed: poolSeed,
        calculationId: calculation.id,
        message: botch
            ? `${args.poolLabel ?? 'Pool'} ${poolSize}d10 vs ${args.difficulty}: BOTCH (${ones} one${ones > 1 ? 's' : ''}, zero successes)`
            : `${args.poolLabel ?? 'Pool'} ${poolSize}d10 vs ${args.difficulty}: ${successes} success${successes === 1 ? '' : 'es'}`
    };
}

async function handleRoll(args: z.infer<typeof RollSchema>, sessionId?: string): Promise<object> {
    const { repo, db } = getRepo();
    const engine = new DiceEngine(args.seed);
    const exporter = new ExportEngine();

    const result = engine.roll(args.expression);

    // Dice-pool mode (theme-agnostic layer): count successes among the
    // individual dice — the resolution primitive for WoD/Shadowrun-likes.
    let poolResult: { successes: number; botches: number; dice: number[] } | undefined;
    if (args.successThreshold !== undefined) {
        const dice: number[] = (result.metadata as { rolls?: number[] } | undefined)?.rolls ?? [];
        poolResult = {
            successes: dice.filter(d => d >= args.successThreshold!).length,
            botches: dice.filter(d => d === 1).length,
            dice
        };
    }

    const calculation: StoredCalculation = {
        id: randomUUID(),
        sessionId,
        ...result,
        seed: args.seed || result.seed
    };

    repo.create(calculation);
    logCalculationEvent(db, calculation.id, 'dice_roll', sessionId);

    return {
        success: true,
        actionType: 'roll',
        expression: args.expression,
        total: result.result,
        rolls: result.steps,
        // #66-B: dc on the roll path — outcome evaluates only when a target
        // was passed; absent dc stays NO TARGET SET by design.
        ...(args.dc !== undefined && {
            dc: args.dc,
            outcome: Number(result.result) >= args.dc ? 'SUCCESS' : 'FAILURE'
        }),
        // FINDINGS #62-V: the raw roll was the ONE payload in the engine without
        // a message field — batch step lines and the PDA default fell back to a
        // bare 'Success' and a nat 20 rolled invisible. House standard now holds.
        message: `${args.expression} = ${result.result}`,
        ...(poolResult && {
            successThreshold: args.successThreshold,
            successes: poolResult.successes,
            botches: poolResult.botches,
            dice: poolResult.dice
        }),
        seed: calculation.seed,
        calculationId: calculation.id,
        formatted: exporter.export(calculation, args.exportFormat)
    };
}

async function handleProbability(args: z.infer<typeof ProbabilitySchema>, sessionId?: string): Promise<object> {
    const { repo, db } = getRepo();
    const engine = new ProbabilityEngine();
    const exporter = new ExportEngine();

    const prob = engine.calculateProbability(args.expression, args.target, args.comparison);
    const ev = engine.expectedValue(args.expression);

    const calculation: StoredCalculation = {
        id: randomUUID(),
        sessionId,
        input: JSON.stringify(args),
        result: prob,
        steps: [
            `Probability (${args.comparison} ${args.target}): ${(prob * 100).toFixed(2)}%`,
            `Expected Value: ${ev.toFixed(2)}`
        ],
        timestamp: new Date().toISOString(),
        metadata: { type: 'probability', probability: prob, expectedValue: ev }
    };

    repo.create(calculation);
    logCalculationEvent(db, calculation.id, 'probability', sessionId);

    return {
        success: true,
        actionType: 'probability',
        expression: args.expression,
        target: args.target,
        comparison: args.comparison,
        probability: prob,
        probabilityPercent: `${(prob * 100).toFixed(2)}%`,
        expectedValue: ev,
        calculationId: calculation.id,
        formatted: exporter.export(calculation, args.exportFormat)
    };
}

async function handleSolve(args: z.infer<typeof SolveSchema>, sessionId?: string): Promise<object> {
    const { repo, db } = getRepo();
    const engine = new AlgebraEngine();
    const exporter = new ExportEngine();

    const result = engine.solve(args.equation, args.variable || 'x');

    const calculation: StoredCalculation = {
        id: randomUUID(),
        sessionId,
        ...result
    };

    repo.create(calculation);
    logCalculationEvent(db, calculation.id, 'algebra_solve', sessionId);

    return {
        success: true,
        actionType: 'solve',
        equation: args.equation,
        variable: args.variable,
        solution: result.result,
        steps: result.steps,
        calculationId: calculation.id,
        formatted: exporter.export(calculation, args.exportFormat)
    };
}

async function handleSimplify(args: z.infer<typeof SimplifySchema>, sessionId?: string): Promise<object> {
    const { repo, db } = getRepo();
    const engine = new AlgebraEngine();
    const exporter = new ExportEngine();

    const result = engine.simplify(args.expression);

    const calculation: StoredCalculation = {
        id: randomUUID(),
        sessionId,
        ...result
    };

    repo.create(calculation);
    logCalculationEvent(db, calculation.id, 'algebra_simplify', sessionId);

    return {
        success: true,
        actionType: 'simplify',
        input: args.expression,
        simplified: result.result,
        steps: result.steps,
        calculationId: calculation.id,
        formatted: exporter.export(calculation, args.exportFormat)
    };
}

async function handleProjectile(args: z.infer<typeof ProjectileSchema>, sessionId?: string): Promise<object> {
    const { repo, db } = getRepo();
    const engine = new PhysicsEngine();
    const exporter = new ExportEngine();

    const result = engine.projectile(args.velocity, args.angle, args.gravity || 9.81, 10, args.height);

    const calculation: StoredCalculation = {
        id: randomUUID(),
        sessionId,
        ...result
    };

    repo.create(calculation);
    logCalculationEvent(db, calculation.id, 'physics_projectile', sessionId);

    return {
        success: true,
        actionType: 'projectile',
        velocity: args.velocity,
        angle: args.angle,
        height: args.height,
        gravity: args.gravity,
        trajectory: result.metadata?.trajectory,
        maxHeight: result.metadata?.maxHeight,
        range: result.metadata?.range,
        timeOfFlight: result.metadata?.timeOfFlight,
        calculationId: calculation.id,
        formatted: exporter.export(calculation, args.exportFormat)
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const definitions: Record<MathAction, ActionDefinition> = {
    roll: {
        schema: RollSchema,
        handler: async (args) => handleRoll(args as z.infer<typeof RollSchema>),
        aliases: ['dice', 'dice_roll', 'd20', 'throw'],
        description: 'Roll dice using standard notation'
    },
    roll_skill_check: {
        schema: RollSkillCheckSchema,
        handler: async (args) => handleCharacterRoll('skill', args as z.infer<typeof RollSkillCheckSchema>),
        aliases: ['skill_check', 'skill'],
        description: 'Roll a skill check for a character — d20 + ability mod + proficiency/expertise + autoApply skill_bonus traits'
    },
    roll_ability_check: {
        schema: RollAbilityCheckSchema,
        handler: async (args) => handleCharacterRoll('ability', args as z.infer<typeof RollAbilityCheckSchema>),
        aliases: ['ability_check'],
        description: 'Roll a raw ability check for a character — d20 + ability mod'
    },
    roll_saving_throw: {
        schema: RollSavingThrowSchema,
        handler: async (args) => handleCharacterRoll('save', args as z.infer<typeof RollSavingThrowSchema>),
        aliases: ['saving_throw', 'save'],
        description: 'Roll a saving throw for a character — d20 + ability mod + save proficiency + autoApply saving_throw_bonus traits'
    },
    opposed: {
        schema: OpposedSchema,
        handler: async (args) => handleOpposed(args as z.infer<typeof OpposedSchema>),
        aliases: ['opposed_check', 'contest', 'versus'],
        description: '#67: Opposed check — two full character-roll compositions (traits, lanes, guards) and one verdict: winner, margin. Tie = status quo (defender holds)'
    },
    reroll: {
        schema: RerollSchema,
        handler: async (args, ctx) => handleReroll(args as z.infer<typeof RerollSchema>, (ctx as SessionContext | undefined)?.sessionId),
        aliases: ['re_roll', 'again'],
        description: '#67-F: Declared reroll of a stored roll — fresh seed, original marked superseded, both results returned. Costs 1 from pool \'rerolls\' (10/10 on first use; GM credits more). A refused reroll writes nothing'
    },
    roll_pool_check: {
        schema: PoolCheckSchema,
        handler: async (args, ctx) => handlePoolCheck(args as z.infer<typeof PoolCheckSchema>, (ctx as SessionContext | undefined)?.sessionId),
        aliases: ['pool_check', 'storyteller', 'wod_roll'],
        description: '#67-W: Storyteller/WoD pool — (attribute+ability+modifier)d10 vs difficulty; engine counts successes, cancels on ones (classic), declares BOTCH, doubles 10s on specialty; +1 auto success on willpower flag (spend the pool separately)'
    },
    probability: {
        schema: ProbabilitySchema,
        handler: async (args) => handleProbability(args as z.infer<typeof ProbabilitySchema>),
        aliases: ['prob', 'calculate_probability', 'odds', 'chance'],
        description: 'Calculate dice roll probabilities'
    },
    solve: {
        schema: SolveSchema,
        handler: async (args) => handleSolve(args as z.infer<typeof SolveSchema>),
        aliases: ['algebra_solve', 'equation', 'solve_equation'],
        description: 'Solve algebraic equations'
    },
    simplify: {
        schema: SimplifySchema,
        handler: async (args) => handleSimplify(args as z.infer<typeof SimplifySchema>),
        aliases: ['algebra_simplify', 'reduce', 'simplify_expression'],
        description: 'Simplify algebraic expressions'
    },
    projectile: {
        schema: ProjectileSchema,
        handler: async (args) => handleProjectile(args as z.infer<typeof ProjectileSchema>),
        aliases: ['physics', 'physics_projectile', 'trajectory', 'launch'],
        description: 'Calculate projectile motion trajectory'
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

export const MathManageTool = {
    name: 'math_manage',
    description: `Mathematical operations for RPG mechanics.

⚠️ REDIRECT - DO NOT USE FOR:
- Attack rolls → Use combat_action { action: "attack" }
- Spell damage → Use combat_action { action: "cast_spell" }
- Ability or skill checks → Use improvisation_manage { action: "stunt", actorId, skill, dc, effectType: "none" }
- Saving throws → Use the combat/effect tool that requires the save; there is no standalone roll_saving_throw tool on this MCP surface

The DM chooses the appropriate skill and DC, and the stunt action rolls the d20 and applies the character's skill modifier automatically. Do not invent or call roll_skill_check, roll_ability_check, or roll_saving_throw; those tools are not registered here.

🎲 DICE ROLLING (roll) - Use ONLY for:
- Stat generation (4d6dl1)
- Random tables/loot
- NPC behavior/morale rolls
- Weather/random encounters
- Anything without character stat bonuses

Standard notation plus special modifiers:
- 2d6+3: Basic roll with modifier
- 4d6dl1: Drop lowest 1 (stat generation)
- 2d20kh1: Keep highest 1 (advantage)
- 2d6!: Exploding dice (reroll on max)
- 8d6r1: Reroll 1s once

📊 PROBABILITY (probability):
Calculate odds before important rolls:
- target: Number to hit
- comparison: gte|lte|eq|gt|lt

🧮 ALGEBRA (solve, simplify):
- solve: Find variable value (damage = base + modifier)
- simplify: Reduce expressions

🏹 PROJECTILE PHYSICS:
Calculate ranged attack trajectories:
- velocity: Initial speed (ft/s)
- angle: Launch angle (degrees)
- height: Initial height (ft)
- gravity: Default 32.2 ft/s²

Actions: roll, probability, solve, simplify, projectile, roll_skill_check, roll_ability_check, roll_saving_throw`,
    actionSchemas: router.actionSchemas,
    inputSchema: z.object({
        action: z.string().describe(`Action: ${ACTIONS.join(', ')}`),
        // Roll params
        expression: z.string().optional(),
        seed: z.string().optional(),
        successThreshold: z.number().optional().describe('Dice-pool mode: count dice >= this as successes'),
        // Probability params
        target: z.number().optional(),
        comparison: z.enum(['gte', 'lte', 'eq', 'gt', 'lt']).optional(),
        // Solve params
        equation: z.string().optional(),
        variable: z.string().optional(),
        // Projectile params
        velocity: z.number().optional(),
        angle: z.number().optional(),
        height: z.number().optional(),
        gravity: z.number().optional(),
        // Character roll params (roll_skill_check / roll_ability_check / roll_saving_throw)
        // FINDINGS #14 MIRROR LAW, fourth strike: params absent here are stripped
        // client-side in EVERY session, fresh or stale. Outer and inner must agree.
        characterId: z.string().optional(),
        skill: z.string().optional(),
        ability: z.union([z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']), z.string(), z.number()]).optional().describe('5e rolls: str|dex|con|int|wis|cha · roll_pool_check: ability dots (number) or stat key'),
        dc: z.number().optional(),
        advantage: z.boolean().optional(),
        disadvantage: z.boolean().optional(),
        modifier: z.number().optional(),
        declaredModifiers: z.array(z.object({ label: z.string(), value: z.number() })).optional(),
        // FINDINGS #60 (mirror law): declaredEffects — absent here means stripped
        // in every session; outer and inner must agree.
        declaredEffects: z.preprocess(jsonIfString, z.array(z.object({ name: z.string(), lane: z.string().optional() }))).optional().describe('RESOLVER v2: [{name, lane?}] — GM declares the conditional trait; engine computes the value (incl. valueFromPool)'),
        // #67 mirror law: opposed-check params.
        targetId: z.string().optional().describe('opposed: defender characterId'),
        targetSkill: z.string().optional().describe('opposed: defender skill'),
        targetAbility: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']).optional().describe('opposed: defender ability'),
        targetAdvantage: z.boolean().optional(),
        targetDisadvantage: z.boolean().optional(),
        // #67-F mirror law: reroll param.
        calculationId: z.string().optional().describe('reroll: stored roll id to supersede'),
        // #67-W mirror law: Storyteller pool params.
        poolLabel: z.string().optional().describe('roll_pool_check: what is rolled, e.g. "Dexterity + Brawl"'),
        attribute: z.union([z.number(), z.string()]).optional().describe('roll_pool_check: attribute dots or stat key'),
        poolModifier: z.number().optional().describe('roll_pool_check: situational dice (wound penalties, equipment)'),
        difficulty: z.number().optional().describe('roll_pool_check: target number per die (default 6)'),
        specialty: z.boolean().optional().describe('roll_pool_check: 10s count double'),
        cancelOnes: z.boolean().optional().describe('roll_pool_check: classic ones-cancel (default true)'),
        willpowerAuto: z.boolean().optional().describe('roll_pool_check: +1 auto success (spend willpower via adjust_pool)'),
        // Common
        exportFormat: z.enum(['json', 'plaintext', 'markdown', 'latex']).optional()
    })
};

export async function handleMathManage(args: unknown, ctx: SessionContext): Promise<McpResponse> {
    // Pass sessionId to handlers
    const argsWithSession = { ...(args as Record<string, unknown>), sessionId: ctx.sessionId };

    const result = await router(argsWithSession);
    const parsed = JSON.parse(result.content[0].text);

    let output = '';

    if (parsed.error) {
        // FINDINGS #62: refusals render as ОТКАЗ with the NO WRITE stamp —
        // unconditionally true here: math_manage never writes anything.
        // #62-V: the legacy suggestions loop read s.action (field is s.value)
        // and printed 'undefined'; the refuse() message line already carries
        // the suggestions inline — the loop dies.
        output = pda.refuse(parsed.message || 'Unknown error');
    } else {
        switch (parsed.actionType) {
            case 'roll':
                // #66: a raw roll must never be mistakable for a pass.
                output = pda.renderRawRoll(parsed);
                break;

            // #66: the three character rolls render the full disclosure block —
            // outcome first, lane-itemized contributions, margin, provenance.
            case 'roll_skill_check':
            case 'roll_ability_check':
            case 'roll_saving_throw':
                output = pda.renderCheck(parsed);
                // FINDINGS #104: resolver problems ESCALATE out of the body — a
                // zeroed trait or refused domain must never hide inside a green
                // banner (the chair read past two of them; this block is why
                // they were caught at all, so make it unmissable).
                if (parsed.resolverProblems?.length) {
                    output += RichFormatter.alert(`RESOLVER: ${parsed.resolverProblems.join(' ▸ ')}`, 'warning');
                }
                break;

            case 'opposed': {
                output = pda.renderOpposed(parsed);
                // FINDINGS #104: opposed resolves TWO sheets — surface both sides' problems.
                const oppProbs = [...(parsed.initiator?.resolverProblems ?? []), ...(parsed.defender?.resolverProblems ?? [])];
                if (oppProbs.length) {
                    output += RichFormatter.alert(`RESOLVER: ${oppProbs.join(' ▸ ')}`, 'warning');
                }
                break;
            }

            case 'reroll':
                output = pda.renderRawRoll(parsed);
                // FINDINGS #71 (cosmetic defect from the #69 verify): a trio
                // supersede rendered as a bare raw roll — arithmetic right,
                // presentation wrong. The corrective lines print the check
                // composition whenever characterRoll metadata rode along.
                if (parsed.characterRoll) {
                    const cr = parsed.characterRoll;
                    const what = cr.skill ? `${cr.kind}:${cr.skill}` : cr.ability ? `${cr.kind}:${cr.ability}` : cr.kind;
                    output += `▌ ${what} reroll — natural ${parsed.natural} + bonus ${parsed.bonus} = ${parsed.total}\n`;
                    if (Array.isArray(parsed.breakdown) && parsed.breakdown.length) {
                        output += `▌ ${parsed.breakdown.join(' · ')}\n`;
                    }
                }
                output += `▌ superseded: ${parsed.original?.calculationId?.slice(0, 8)} (was ${parsed.original?.total}) · rerolls left ${parsed.rerollsLeft}\n`;
                break;

            case 'roll_pool_check':
                output = pda.renderPoolCheck(parsed);
                break;

            case 'probability':
                output = RichFormatter.header('Probability', '');
                output += RichFormatter.keyValue({
                    'Expression': parsed.expression,
                    'Target': `${parsed.comparison} ${parsed.target}`,
                    'Probability': parsed.probabilityPercent,
                    'Expected Value': parsed.expectedValue?.toFixed(2)
                });
                break;

            case 'solve':
                output = RichFormatter.header('Equation Solved', '');
                output += RichFormatter.keyValue({
                    'Equation': parsed.equation,
                    'Variable': parsed.variable,
                    'Solution': parsed.solution
                });
                if (parsed.steps?.length) {
                    output += '\nSteps:\n';
                    parsed.steps.forEach((s: string) => output += `  ${s}\n`);
                }
                break;

            case 'simplify':
                output = RichFormatter.header('Simplified', '');
                output += RichFormatter.keyValue({
                    'Input': parsed.input,
                    'Simplified': parsed.simplified
                });
                break;

            case 'projectile':
                output = RichFormatter.header('Projectile Motion', '');
                output += RichFormatter.keyValue({
                    'Velocity': `${parsed.velocity} m/s`,
                    'Angle': `${parsed.angle}°`,
                    'Max Height': parsed.maxHeight?.toFixed(2) + ' m',
                    'Range': parsed.range?.toFixed(2) + ' m',
                    'Time of Flight': parsed.timeOfFlight?.toFixed(2) + ' s'
                });
                break;

            case 'roll_skill_check':
            case 'roll_ability_check':
            case 'roll_saving_throw':
                // FINDINGS #62: PDA kernel — the banner is a pure function of the
                // embedded JSON (supersedes the #61 inline case same-day; #35
                // family structurally dead for these actions).
                output = pda.renderCheck(parsed);
                break;

            default:
                // FINDINGS #62: the honest fallback — an unknown actionType can
                // never render an empty banner again.
                output = parsed.formatted
                    ? RichFormatter.header('Math', '') + parsed.formatted + '\n'
                    : pda.renderDefault(parsed);
        }
    }

    output += RichFormatter.embedJson(parsed, 'MATH_MANAGE');

    return {
        content: [{
            type: 'text' as const,
            text: output
        }]
    };
}
