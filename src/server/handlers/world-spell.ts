/**
 * Item 9: a world's own spells (table_rules kind `spell`). cast_spell of a
 * name the world defines lands here instead of the SRD path: no slots, a
 * casting roll against a target on the encounter's seeded dice, signed pool
 * costs written with history, an optional unbind contest, the effects on
 * each target (saves, resistances, conditions, pools) and a miscast table
 * on a double, a failure or a fumble.
 */
import type Database from 'better-sqlite3';
import type { CombatEngine, CombatParticipant, CombatActionResult } from '../../engine/combat/engine.js';
import { normalizeCondition } from '../../engine/combat/conditions.js';
import { rollParticipantSave, toLongAbility, type ParticipantSaveResult } from '../../engine/combat/saves.js';
import { findPool, type RuleSpec, type TableRule } from '../../engine/table-rules.js';
import { applyScheduledOps } from '../../engine/scheduled-ops.js';
import { engineRoller } from '../../math/logged-d20.js';
import { edgeDistanceSquares } from '../../schema/encounter.js';
import { calculateSpellSaveDC } from '../../engine/magic/spell-validator.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { ConcentrationRepository } from '../../storage/repos/concentration.repo.js';
import { checkConcentration, breakConcentration } from '../../engine/magic/concentration.js';
import type { Character } from '../../schema/character.js';

type SpellSpec = RuleSpec<'spell'>;
type CastingRollSpec = NonNullable<SpellSpec['castingRoll']>;
type SpellEffect = SpellSpec['effects'][number];

export interface CastingTotal {
    dice: string;
    rolls: number[];
    /** Everything added to the dice: the spec's modifier, the ability, any bonus. */
    modifier: number;
    total: number;
    /** Each term, for the banner: '2d6 (3+3)', 'modifier +1', 'INT +3'. */
    parts: string[];
}

const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`;
const abilityMod = (score: number) => Math.floor((score - 10) / 2);

/** The caster's modifier for a short ability: the sheet first, then the token's scores. */
function casterAbilityMod(caster: CombatParticipant, char: Pick<Character, 'stats'> | null, ability: string): number {
    const short = ability.toLowerCase().slice(0, 3);
    const fromSheet = (char?.stats as Record<string, number> | undefined)?.[short];
    if (typeof fromSheet === 'number') return abilityMod(fromSheet);
    const long = toLongAbility(short);
    const fromToken = long ? (caster.abilityScores as Record<string, number> | undefined)?.[long] : undefined;
    return typeof fromToken === 'number' ? abilityMod(fromToken) : 0;
}

/**
 * The casting roll: the dice on the encounter's stream, plus the spec's
 * modifier, the caster's ability, and any extra bonuses (each labelled).
 * Later bonuses (a nearby-allies count) pass through `extra`, so the total
 * and its parts stay one sum.
 */
export function computeCastingTotal(
    engine: Pick<CombatEngine, 'rollDice'>,
    castingRoll: CastingRollSpec,
    caster: CombatParticipant,
    char: Pick<Character, 'stats'> | null,
    tag: string,
    extra: Array<{ label: string; value: number }> = []
): CastingTotal {
    const r = engine.rollDice(castingRoll.dice, { purpose: tag, forId: caster.id });
    const bonuses: Array<{ label: string; value: number }> = [];
    if (castingRoll.modifier) bonuses.push({ label: 'modifier', value: castingRoll.modifier });
    if (castingRoll.ability) bonuses.push({ label: castingRoll.ability.toUpperCase(), value: casterAbilityMod(caster, char, castingRoll.ability) });
    bonuses.push(...extra);
    // A dice notation with its own flat term ('2d6+1') already carries it in total.
    const flatInDice = r.total - r.rolls.reduce((a, b) => a + b, 0);
    const modifier = bonuses.reduce((a, b) => a + b.value, 0);
    return {
        dice: castingRoll.dice,
        rolls: r.rolls,
        modifier,
        total: r.rolls.reduce((a, b) => a + b, 0) + flatInDice + modifier,
        parts: [`${castingRoll.dice} (${r.rolls.join('+')})`, ...bonuses.map(b => `${b.label} ${signed(b.value)}`)]
    };
}

/** A double: two or more dice showing the same face. */
export function isDouble(rolls: number[]): boolean {
    const faces = rolls.map(Math.abs);
    return faces.length >= 2 && new Set(faces).size < faces.length;
}

/** A fumble: every die a 1. */
export function isFumble(rolls: number[]): boolean {
    return rolls.length > 0 && rolls.every(r => Math.abs(r) === 1);
}

function nameKey(s: string): string { return s.toLowerCase().replace(/[\s_-]+/g, ''); }

export interface CastWorldSpellInput {
    engine: CombatEngine;
    db: Database.Database;
    rule: TableRule<'spell'>;
    worldId: string;
    actorId: string;
    targetIds: string[];
    unbinderId?: string;
    damage?: number | string;
}

interface EffectResult {
    type: SpellEffect['type'];
    targetId: string;
    name: string;
    rolled?: number;
    dc?: number;
    save?: ParticipantSaveResult;
    saved?: boolean;
    damage?: number;
    damageModifier?: string;
    healing?: number;
    condition?: string;
    pool?: string;
    line?: string;
    hpBefore?: number;
    hpAfter?: number;
    defeated?: boolean;
}

/**
 * Cast a world spell. Every refusal (unknown spell, incapacitated caster, a
 * spend it cannot pay, a used action) throws before anything is written or
 * rolled. Returns the banner and the action result; the caller saves state.
 */
export async function castWorldSpell(input: CastWorldSpellInput): Promise<{ output: string; result: CombatActionResult }> {
    const { engine, db, rule, worldId, actorId } = input;
    const spec = rule.spec as SpellSpec;
    const name = spec.displayName ?? rule.name;
    const state = engine.getState();
    if (!state) throw new Error('No combat state');
    const actor = state.participants.find(p => p.id === actorId);
    if (!actor) throw new Error(`Actor ${actorId} not found`);
    if (input.damage !== undefined && input.damage !== 0) {
        throw new Error('damage parameter not allowed for cast_spell - damage is calculated from spell');
    }

    const charRepo = new CharacterRepository(db);
    let char: Character | null = null;
    try { char = charRepo.findById(actorId); } catch { /* token-only caster */ }

    // ── Refusals: nothing written, nothing rolled ──
    if (!spec.known) {
        const known = [...(char?.knownSpells ?? []), ...(char?.cantripsKnown ?? [])].some(k => nameKey(k) === nameKey(rule.name));
        if (!known) throw new Error(`${actor.name} does not know ${name} (a world spell with known: false needs it in knownSpells)`);
    }
    if (!engine.canTakeActions(actorId)) throw new Error(`${actor.name} is incapacitated and cannot cast ${name}`);
    const actionType = spec.castingTime ?? 'action';
    const economy = engine.validateActionEconomy(actorId, actionType);
    if (!economy.valid) throw new Error(economy.error);

    let unbinder: CombatParticipant | undefined;
    if (input.unbinderId) {
        if (spec.contestedBy !== 'unbind' || !spec.castingRoll) throw new Error(`${name} cannot be unbound (its spell rule has no contestedBy: 'unbind' and casting roll)`);
        unbinder = state.participants.find(p => p.id === input.unbinderId);
        if (!unbinder) throw new Error(`Unbinder ${input.unbinderId} not found in this encounter`);
        if (unbinder.hp <= 0 || !engine.canTakeActions(unbinder.id)) throw new Error(`${unbinder.name} cannot unbind (down or incapacitated)`);
    }

    const targets: CombatParticipant[] = [];
    for (const tid of input.targetIds) {
        const t = state.participants.find(p => p.id === tid);
        if (!t) throw new Error(`Target ${tid} not found`);
        if (spec.range !== undefined && actor.position && t.position) {
            const ft = edgeDistanceSquares(actor, t) * 5;
            if (ft > spec.range) throw new Error(`${t.name} is ${ft} ft away; ${name} reaches ${spec.range} ft`);
        }
        targets.push(t);
    }

    const reason = `cast ${name}`;
    const costOps: Array<{ op: 'adjust_pool'; pool: string; delta: number }> = [];
    if (spec.cost.length) {
        if (!char) throw new Error(`${name} has a cost and ${actor.name} has no character sheet to pay it from`);
        const running: Record<string, number> = {};
        for (const c of spec.cost) {
            const found = findPool(char.resourcePools as Record<string, { current: number }> | undefined, c.pool);
            const key = found?.key ?? c.pool;
            const current = running[key] ?? found?.pool.current ?? 0;
            if (c.delta < 0 && current + c.delta < 0) {
                throw new Error(`${actor.name} cannot pay ${name}: ${key} ${current} is short of ${-c.delta}`);
            }
            running[key] = current + c.delta;
            costOps.push({ op: 'adjust_pool', pool: key, delta: c.delta });
        }
    }

    // ── Costs: paid whether or not the cast succeeds ──
    let costLines: string[] = [];
    if (costOps.length && char) {
        const { applied, updates } = applyScheduledOps(char, costOps, { reason });
        charRepo.update(char.id, updates as never);
        costLines = applied;
        char = charRepo.findById(char.id);
    }

    // ── Casting roll ──
    const casting = spec.castingRoll ? computeCastingTotal(engine, spec.castingRoll, actor, char, reason) : undefined;
    const success = casting ? casting.total >= spec.castingRoll!.target : true;
    const double = casting ? isDouble(casting.rolls) : false;
    const fumble = casting ? isFumble(casting.rolls) : false;

    // ── Unbind: the unbinder rolls the same dice; a higher total stops it ──
    let unbind: { unbinderId: string; name: string; dice: string; rolls: number[]; total: number; unbound: boolean } | undefined;
    if (unbinder && casting && success) {
        const r = engine.rollDice(casting.dice, { purpose: `unbind ${name}`, forId: unbinder.id, targetId: actorId });
        unbind = { unbinderId: unbinder.id, name: unbinder.name, dice: casting.dice, rolls: r.rolls, total: r.total, unbound: r.total > casting.total };
    }
    const lands = success && !unbind?.unbound;

    // ── Effects ──
    const effects: EffectResult[] = [];
    const notes: string[] = [];
    if (lands) {
        const fallbackDc = casting?.total ?? (char ? (char.spellSaveDC || calculateSpellSaveDC(char)) : 10);
        const concentrationRepo = new ConcentrationRepository(db);
        for (const effect of spec.effects) {
            const recipients = effect.target === 'caster' ? [actor] : targets;
            if (!recipients.length) { notes.push(`${effect.type} effect: no target named`); continue; }
            const rolled = (effect.type === 'damage' || effect.type === 'healing')
                ? engine.rollDice(effect.dice!, { purpose: `${name} ${effect.type}`, forId: actorId })
                : undefined;
            for (const tp of recipients) {
                const out: EffectResult = { type: effect.type, targetId: tp.id, name: tp.name };
                let saved = false;
                if (effect.save && effect.type !== 'healing') {
                    const dc = effect.save.dc ?? fallbackDc;
                    const save = rollParticipantSave(engine, db, tp, effect.save.ability, dc, {
                        purpose: `${toLongAbility(effect.save.ability) ?? effect.save.ability} save vs ${name}`
                    });
                    saved = save.saved;
                    Object.assign(out, { dc, save, saved });
                }
                if (effect.type === 'damage') {
                    let dmg = rolled!.total;
                    out.rolled = dmg;
                    if (saved) dmg = effect.saveEffect === 'half' ? Math.floor(dmg / 2) : 0;
                    const typed = engine.calculateDamageWithModifiers(dmg, effect.damageType ?? 'force', tp);
                    dmg = typed.finalDamage;
                    out.hpBefore = tp.hp;
                    if (dmg > 0) engine.applyDamage(tp.id, dmg);
                    const after = engine.getState()?.participants.find(p => p.id === tp.id);
                    out.hpAfter = after?.hp ?? 0;
                    out.defeated = out.hpAfter <= 0;
                    out.damage = dmg;
                    out.damageModifier = typed.modifier;
                    if (dmg > 0) {
                        const tc = charRepo.findById(tp.id);
                        if (tc) {
                            charRepo.update(tp.id, { hp: out.hpAfter });
                            if (concentrationRepo.isConcentrating(tp.id)) {
                                if (out.defeated) breakConcentration({ characterId: tp.id, reason: 'death' }, concentrationRepo, charRepo);
                                else {
                                    const check = checkConcentration(tc, dmg, concentrationRepo, 0, () => engine.rollD20({ purpose: 'concentration', forId: tp.id }));
                                    if (check.broken) breakConcentration({ characterId: tp.id, reason: 'damage', damageAmount: dmg }, concentrationRepo, charRepo);
                                }
                            }
                        }
                    }
                    out.line = `💥 ${tp.name}: ${dmg} ${effect.damageType ?? 'force'}${typed.modifier !== 'normal' ? ` (${typed.modifier})` : ''} | ${out.hpBefore} → ${out.hpAfter} HP${out.defeated ? ' 💀 DEFEATED' : ''}`;
                } else if (effect.type === 'healing') {
                    out.rolled = rolled!.total;
                    out.hpBefore = tp.hp;
                    engine.executeHeal(actorId, tp.id, rolled!.total);
                    out.hpAfter = engine.getState()?.participants.find(p => p.id === tp.id)?.hp ?? tp.hp;
                    out.healing = out.hpAfter - out.hpBefore;
                    if (charRepo.findById(tp.id)) charRepo.update(tp.id, { hp: out.hpAfter });
                    out.line = `💚 ${tp.name}: +${out.healing} HP | ${out.hpBefore} → ${out.hpAfter}`;
                } else if (effect.type === 'condition') {
                    if (!saved) {
                        const norm = normalizeCondition({
                            name: effect.condition!, sourceId: actorId,
                            ...(effect.duration !== undefined ? { duration: effect.duration } : {}),
                            ...(effect.save ? { saveDC: out.dc, saveAbility: effect.save.ability } : {})
                        } as never, tp.id);
                        if (norm) {
                            const { id: _drop, ...rest } = norm;
                            const applied = engine.applyCondition(tp.id, rest);
                            out.condition = applied.type;
                            out.line = `🔗 ${tp.name} is ${applied.type} (${name})`;
                        }
                    } else out.line = `🛡️ ${tp.name} resists ${effect.condition}`;
                } else if (effect.type === 'pool') {
                    const tc = charRepo.findById(tp.id);
                    if (!tc) { notes.push(`${tp.name} has no character sheet: pool ${effect.pool} unchanged`); continue; }
                    const key = findPool(tc.resourcePools as Record<string, unknown> | undefined, effect.pool!)?.key ?? effect.pool!;
                    const { applied, updates } = applyScheduledOps(tc, [{ op: 'adjust_pool', pool: key, delta: effect.delta! }], { reason: `${name} (cast by ${actor.name})` });
                    charRepo.update(tp.id, updates as never);
                    out.pool = key;
                    out.line = `🔮 ${tp.name} ${applied.join(', ')}`;
                    if (tp.id === actorId) char = charRepo.findById(actorId);
                }
                if (out.save) {
                    const s = out.save;
                    out.line = `🎲 ${tp.name} ${s.ability.toUpperCase()} save: d20(${s.rolls.join(',')}) ${s.modifier >= 0 ? '+' : '-'} ${Math.abs(s.modifier)} = ${s.total} vs DC ${out.dc} [${s.saved ? 'PASS' : 'FAIL'}]${out.line ? `\n   ${out.line}` : ''}`;
                }
                effects.push(out);
            }
        }
    }

    // ── Miscast ──
    let miscast: Record<string, unknown> | undefined;
    if (casting && spec.miscast) {
        const on = spec.miscast.on;
        const trigger = on === 'double' ? double : on === 'fumble' ? fumble : !success;
        if (trigger) {
            const hpBefore = char?.hp;
            const { rollAndApply } = await import('../roll-table-apply.js');
            const r = await rollAndApply(db, {
                worldId, name: spec.miscast.table, characterId: char?.id, apply: !!char,
                roller: engineRoller(engine, { forId: actorId })
            });
            miscast = { on, table: spec.miscast.table, ...r };
            // A table write to the caster's HP reaches the token too.
            const fresh = char ? charRepo.findById(char.id) : null;
            if (fresh && hpBefore !== undefined && fresh.hp !== hpBefore) {
                const tok = engine.getState()?.participants.find(p => p.id === actorId);
                if (tok) tok.hp = Math.min(tok.maxHp, Math.max(0, fresh.hp));
            }
        }
    }

    engine.commitAction(actorId, actionType);

    // ── Banner ──
    let output = `\n┌─────────────────────────────────────────┐\n│ ✨ ${name.toUpperCase()} (world spell)\n└─────────────────────────────────────────┘\n\n${actor.name} casts ${name}!\n`;
    if (costLines.length) output += `💠 Cost: ${costLines.join(', ')}\n`;
    if (casting) {
        output += `🎲 Casting: ${casting.parts.join(' ')} = ${casting.total} vs ${spec.castingRoll!.target} [${success ? 'CAST' : 'FAILED'}]${double ? ' (double)' : ''}${fumble ? ' (fumble)' : ''}\n`;
    }
    if (unbind) output += `🚫 ${unbind.name} tries to unbind: ${unbind.dice} (${unbind.rolls.join('+')}) = ${unbind.total} vs ${casting!.total} [${unbind.unbound ? 'UNBOUND' : 'FAILS'}]\n`;
    for (const e of effects) if (e.line) output += `${e.line}\n`;
    if (notes.length) output += `(${notes.join('; ')})\n`;
    if (miscast) output += `\n⚠️ MISCAST (${String(miscast.on)}): ${String(miscast.message ?? miscast.text ?? '')}\n`;
    const totalDamage = effects.reduce((a, e) => a + (e.damage ?? 0), 0);
    const totalHealing = effects.reduce((a, e) => a + (e.healing ?? 0), 0);
    output += `\n[WORLD SPELL: ${name}, ${lands ? 'CAST' : unbind?.unbound ? 'UNBOUND' : 'FAILED'}, DMG: ${totalDamage}, HEAL: ${totalHealing}]`;

    const first = effects.find(e => e.hpBefore !== undefined);
    const firstTarget = first ? state.participants.find(p => p.id === first.targetId) : undefined;
    const result = {
        type: 'attack',
        success: lands,
        actor: { id: actor.id, name: actor.name },
        target: first && firstTarget
            ? { id: first.targetId, name: first.name, hpBefore: first.hpBefore!, hpAfter: first.hpAfter!, maxHp: firstTarget.maxHp }
            : { id: 'none', name: 'none', hpBefore: 0, hpAfter: 0, maxHp: 0 },
        defeated: !!first?.defeated,
        message: `${actor.name} cast ${name}${lands ? '' : unbind?.unbound ? ' (unbound)' : ' (failed)'}`,
        damage: totalDamage || undefined,
        healAmount: totalHealing || undefined,
        detailedBreakdown: output,
        worldSpell: {
            name, rule: rule.name,
            ...(casting ? { casting: { ...casting, target: spec.castingRoll!.target, success, double, fumble } } : {}),
            costs: costLines,
            ...(unbind ? { unbind } : {}),
            effects: effects.map(({ line: _l, ...e }) => e),
            ...(miscast ? { miscast } : {}),
            ...(notes.length ? { notes } : {})
        }
    } as unknown as CombatActionResult;
    const saves = effects.filter(e => e.save).map(e => ({ id: e.targetId, name: e.name, ...e.save! }));
    if (saves.length) (result as { saves?: unknown }).saves = saves;
    const conditionsApplied = effects.filter(e => e.condition).map(e => ({ id: e.targetId, name: e.name, condition: e.condition }));
    if (conditionsApplied.length) (result as { conditionsApplied?: unknown }).conditionsApplied = conditionsApplied;
    return { output, result };
}
