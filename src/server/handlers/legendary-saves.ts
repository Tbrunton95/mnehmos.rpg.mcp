/**
 * Play report 7 follow-up (lane K): legendary resistance on the saves that
 * still ignored it. Lane L gave the participant save and the end-of-turn
 * save one rule (legendaryOnFailedSave); these are the rolls that never went
 * through it:
 *
 *  - the concentration CON save, on its seven roads (an attack, cast_spell,
 *    an area through resolveAreaSave, a world spell, apply_damage on the
 *    sheets, an execute on the sheets, concentration_manage check_save);
 *  - a stunt's target save (improvisation_manage stunt);
 *  - an aura's save (aura_manage process, a report that writes nothing).
 *
 * The rule is lane L's: autoLegendaryResistance spends one (the save
 * succeeds; the count is mirrored to the sheet by exact id); otherwise the
 * failed save is offered ('LR 2/3 left, spend one?' with the call); a
 * player-controlled creature is asked and never spent for.
 *
 * In a fight the offer is reversible: it rides the creature's token in the
 * encounter row (pendingLegendaryOffers) with a saveRef, as kind
 * 'concentration' (a snapshot of the broken concentration, restored when
 * answered) or 'stunt' (the damage a success would have avoided, healed
 * back). Off a fight no encounter row can hold an offer: the reply reports
 * legendaryResistanceAvailable with the exact repair call instead
 * (concentration_manage restore, or character_manage update), and an
 * automatic spend still works on the sheet for concentration.
 *
 * Handler layer: these read and write the database; the engine never does.
 */
import type Database from 'better-sqlite3';
import type { CombatEngine, CombatParticipant } from '../../engine/combat/engine.js';
import {
    legendaryOnFailedSave, legendaryOfferPhrase, nextOfferRef, recordLegendaryOffer,
    type ConcentrationSnapshot, type LegendaryOfferRow, type LegendaryOutcome, type PendingLegendaryOffer
} from '../../engine/combat/legendary-resistance.js';
import { isPlayerControlled, mirrorLegendaryToSheet } from '../../engine/combat/saves.js';
import { CharacterRepository } from '../../storage/repos/character.repo.js';
import { ConcentrationRepository } from '../../storage/repos/concentration.repo.js';
import { ConcentrationStateSchema, type ConcentrationState } from '../../schema/concentration.js';

/**
 * A row of the reply's top-level legendaryOffers: an offer in a fight
 * (saveRef), or off a fight the repair (no saveRef). Lane K review: an aura's
 * report offers kind 'aura' (no saveRef: the spend undoes nothing written).
 */
export type LegendaryReplyRow = Omit<LegendaryOfferRow, 'saveRef' | 'kind'> & { saveRef?: string; kind: LegendaryOfferRow['kind'] | 'aura'; noFight?: true };

/** What a failed save's legendary resistance came to on one road. */
export interface LegendarySave {
    /** A resistance was spent: the failed save succeeds. */
    holds?: true;
    /** The fields the result row carries (legendaryResisted, legendaryOffer, legendaryResistanceAvailable …). */
    fields: LegendaryOutcome;
    /** The top-level legendaryOffers row (an offer, or a repair off the fight). */
    row?: LegendaryReplyRow;
}

const quote = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** The concentration row as it stands, for an offer that can put it back. */
export function concentrationSnapshot(row: ConcentrationState): ConcentrationSnapshot {
    return {
        spell: row.activeSpell,
        spellLevel: row.spellLevel,
        ...(row.targetIds ? { targetIds: [...row.targetIds] } : {}),
        startedAt: row.startedAt,
        ...(row.maxDuration !== undefined ? { maxDuration: row.maxDuration } : {}),
        saveDCBase: row.saveDCBase
    };
}

/**
 * The repair off a fight: concentration_manage restore with the snapshot,
 * spending the resistance from the sheet in the same call (spend: false
 * when it was already spent by hand).
 */
export function concentrationRestoreCall(characterId: string, snap: ConcentrationSnapshot, spend = true): string {
    const parts = [
        `characterId: '${quote(characterId)}'`, `spell: '${quote(snap.spell)}'`, `spellLevel: ${snap.spellLevel}`, `startedAt: ${snap.startedAt}`,
        ...(snap.maxDuration !== undefined ? [`maxDuration: ${snap.maxDuration}`] : []),
        ...(snap.targetIds?.length ? [`targetIds: [${snap.targetIds.map(t => `'${quote(t)}'`).join(', ')}]`] : []),
        ...(snap.saveDCBase !== 10 ? [`saveDCBase: ${snap.saveDCBase}`] : []),
        ...(spend ? ['spendLegendaryResistance: true'] : [])
    ];
    return `concentration_manage restore {${parts.join(', ')}}`;
}

/**
 * Why the concentration in `snap` cannot come back on `characterId`
 * (undefined: it can): no sheet of its own (the concentration row hangs off
 * it), a spell it has started concentrating on since, 0 HP, a snapshot the
 * table cannot hold. Read before anything is spent.
 */
export function concentrationRestoreProblem(db: Database.Database, characterId: string, snap: ConcentrationSnapshot | undefined, opts: { hp?: number } = {}): string | undefined {
    if (!snap) return 'no concentration to restore';
    const row = new CharacterRepository(db).findById(characterId);
    if (!row || row.id !== characterId) return `${characterId} has no character sheet of its own, so its concentration on ${snap.spell} cannot be restored`;
    const now = new ConcentrationRepository(db).findByCharacterId(characterId);
    if (now) return `${row.name} has started concentrating on ${now.activeSpell} since the save, so ${snap.spell} cannot come back`;
    if ((opts.hp ?? row.hp) <= 0) return `${row.name} is at 0 HP, so concentration on ${snap.spell} cannot hold`;
    const valid = ConcentrationStateSchema.safeParse({
        characterId, activeSpell: snap.spell, spellLevel: snap.spellLevel, targetIds: snap.targetIds,
        startedAt: snap.startedAt, maxDuration: snap.maxDuration, saveDCBase: snap.saveDCBase
    });
    if (!valid.success) return `the concentration on ${snap.spell} is not one the table can hold (${valid.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')})`;
    return undefined;
}

/** Put the concentration back as it stood: the row, and the sheet's concentratingOn. Check concentrationRestoreProblem first. */
export function restoreConcentrationRow(db: Database.Database, characterId: string, snap: ConcentrationSnapshot): boolean {
    try {
        // Lane K review: both rows or neither, so a refusal after a failed write still wrote nothing.
        db.transaction(() => {
            new ConcentrationRepository(db).create({
                characterId, activeSpell: snap.spell, spellLevel: snap.spellLevel, targetIds: snap.targetIds,
                startedAt: snap.startedAt, maxDuration: snap.maxDuration, saveDCBase: snap.saveDCBase
            });
            new CharacterRepository(db).update(characterId, { concentratingOn: snap.spell });
        })();
        return true;
    } catch {
        return false;
    }
}

/**
 * A failed save in a fight by token `saverId`: lane L's rule on the token's
 * count. Spent: the sheet is mirrored by exact id. Offered: the offer rides
 * the token (pendingLegendaryOffers, saved with the encounter row by the
 * caller) with a saveRef and the call naming `encounterId`.
 */
export function fightLegendary(
    engine: CombatEngine,
    db: Database.Database | undefined,
    saverId: string,
    encounterId: string | undefined,
    offer: { kind: Extract<PendingLegendaryOffer['kind'], 'concentration' | 'stunt'>; condition: string; refund?: number; concentration?: ConcentrationSnapshot }
): LegendarySave | undefined {
    const state = engine.getState();
    const p = state?.participants.find(x => x.id === saverId);
    if (!p || (p.legendaryResistancesRemaining ?? 0) <= 0) return undefined;
    const verdict = legendaryOnFailedSave(engine, p, { playerDecides: isPlayerControlled(db, p) });
    if (verdict.resisted) {
        // Resistances last the day: the sheet keeps the count; a mirror that cannot write leaves the save as rolled.
        try { mirrorLegendaryToSheet(db, p.id, verdict.resisted.remaining); } catch { /* no sheet */ }
        return {
            holds: true,
            fields: { legendaryResisted: true, legendaryRemaining: verdict.resisted.remaining, ...(p.legendaryResistances !== undefined ? { legendaryOf: p.legendaryResistances } : {}) }
        };
    }
    if (!verdict.available) return undefined;
    const round = state?.round ?? 1;
    const row = recordLegendaryOffer(p, {
        ref: nextOfferRef(p, offer.kind === 'concentration' ? 'con' : 'stu', round), kind: offer.kind, condition: offer.condition, round,
        ...(offer.refund !== undefined ? { refund: offer.refund } : {}),
        ...(offer.concentration ? { concentration: offer.concentration } : {})
    }, verdict.available, !!verdict.askPlayer, encounterId ?? engine.encounterId);
    return {
        fields: {
            legendaryOffer: {
                saveRef: row.saveRef, remaining: row.remaining, ...(row.of !== undefined ? { of: row.of } : {}),
                ...(row.askPlayer ? { askPlayer: true as const } : {}), call: row.call,
                line: legendaryOfferPhrase(p.name, row.remaining, row.of, !!row.askPlayer, row.call)
            }
        },
        row
    };
}

/** A failed concentration save in a fight: spend (the spell holds) or offer with a snapshot of the row. */
export function fightConcentrationLegendary(engine: CombatEngine, db: Database.Database | undefined, saverId: string, encounterId: string | undefined, held: ConcentrationState): LegendarySave | undefined {
    return fightLegendary(engine, db, saverId, encounterId, { kind: 'concentration', condition: held.activeSpell, concentration: concentrationSnapshot(held) });
}

/**
 * A failed save off a fight, on the sheet's own count: autoLegendaryResistance
 * spends from the sheet when `spend` allows it (a player character never);
 * otherwise the count and the repair to paste are reported, since no
 * encounter row can hold an offer.
 */
export function sheetLegendary(
    db: Database.Database,
    characterId: string,
    opts: { kind: PendingLegendaryOffer['kind']; condition: string; spend: boolean; repair: (remaining: number) => string }
): LegendarySave | undefined {
    const repo = new CharacterRepository(db);
    const row = repo.findById(characterId);
    if (!row || row.id !== characterId) return undefined;
    const of = row.legendaryResistances ?? undefined;
    const remaining = row.legendaryResistancesRemaining ?? of ?? 0;
    if (remaining <= 0) return undefined;
    // Off a fight there is no side: a pc row is the player's.
    const askPlayer = (row.characterType ?? 'pc') === 'pc';
    if (opts.spend && row.autoLegendaryResistance && !askPlayer) {
        repo.update(characterId, { legendaryResistancesRemaining: remaining - 1 });
        return { holds: true, fields: { legendaryResisted: true, legendaryRemaining: remaining - 1, ...(of !== undefined ? { legendaryOf: of } : {}) } };
    }
    const call = opts.repair(remaining);
    const line = legendaryOfferPhrase(row.name, remaining, of, askPlayer, call);
    return {
        fields: {
            legendaryResistanceAvailable: remaining,
            ...(askPlayer ? { legendaryResistanceAskPlayer: true as const } : {}),
            legendaryOffer: { remaining, ...(of !== undefined ? { of } : {}), ...(askPlayer ? { askPlayer: true as const } : {}), call, line }
        },
        row: {
            participantId: characterId, name: row.name, kind: opts.kind, condition: opts.condition, remaining,
            ...(of !== undefined ? { of } : {}), ...(askPlayer ? { askPlayer: true as const } : {}),
            call, line: askPlayer ? line : line.replace(/^⭐ /, `⭐ ${row.name}: `), noFight: true
        }
    };
}

/** A failed concentration save off a fight: spend from the sheet (the spell holds), or report the restore call. */
export function sheetConcentrationLegendary(db: Database.Database, characterId: string, held: ConcentrationState): LegendarySave | undefined {
    const snap = concentrationSnapshot(held);
    return sheetLegendary(db, characterId, { kind: 'concentration', condition: held.activeSpell, spend: true, repair: () => concentrationRestoreCall(characterId, snap) });
}

/**
 * The hook concentrationAfterDamage asks on a failed save: in a fight (an
 * engine holding the token) the token's rule and a reversible offer; off a
 * fight the sheet's. Each offer or report is pushed to `rows` for the
 * reply's top-level legendaryOffers.
 */
export function concentrationLegendaryHook(
    db: Database.Database,
    characterId: string,
    rows: LegendaryReplyRow[],
    fight?: { engine: CombatEngine; encounterId: string | undefined }
): (held: ConcentrationState) => (LegendaryOutcome & { holds?: boolean }) | undefined {
    return (held) => {
        const r = fight && fight.engine.getState()?.participants.some(p => p.id === characterId)
            ? fightConcentrationLegendary(fight.engine, db, characterId, fight.encounterId, held)
            : sheetConcentrationLegendary(db, characterId, held);
        if (!r) return undefined;
        if (r.row) rows.push(r.row);
        return { ...r.fields, ...(r.holds ? { holds: true } : {}) };
    };
}

/**
 * An aura's failed save (aura_manage process reports and writes nothing):
 * the offer text on the row. Nothing is ever spent here, autoLegendaryResistance
 * or not, since no damage or condition was written that a spend could undo.
 */
export function auraLegendaryNote(db: Database.Database | undefined, token: Pick<CombatParticipant, 'id' | 'name' | 'isEnemy' | 'legendaryResistances' | 'legendaryResistancesRemaining'>, encounterId: string, auraName: string): LegendaryOutcome | undefined {
    const remaining = token.legendaryResistancesRemaining ?? token.legendaryResistances ?? 0;
    if (remaining <= 0) return undefined;
    const askPlayer = isPlayerControlled(db, token);
    const of = token.legendaryResistances;
    const call = `combat_manage legendary_resistance {encounterId: '${quote(encounterId)}', participantId: '${quote(token.id)}', reason: '${quote(`${auraName} save`)}'}`;
    const line = `${legendaryOfferPhrase(token.name, remaining, of, askPlayer, call)} (the aura report wrote nothing: on a spend the save succeeds, so apply none of this effect)`;
    return {
        legendaryResistanceAvailable: remaining,
        ...(askPlayer ? { legendaryResistanceAskPlayer: true as const } : {}),
        legendaryOffer: { remaining, ...(of !== undefined ? { of } : {}), ...(askPlayer ? { askPlayer: true as const } : {}), call, line }
    };
}

/**
 * Lane K review: an aura offer as a top-level legendaryOffers row, which
 * output_mode summary keeps whole (the effect rows it rides collapse there).
 */
export function auraLegendaryRow(token: Pick<CombatParticipant, 'id' | 'name'>, auraName: string, note: LegendaryOutcome): LegendaryReplyRow | undefined {
    const o = note.legendaryOffer;
    if (!o) return undefined;
    return {
        participantId: token.id, name: token.name, kind: 'aura', condition: auraName, remaining: o.remaining,
        ...(o.of !== undefined ? { of: o.of } : {}), ...(o.askPlayer ? { askPlayer: true as const } : {}),
        call: o.call, line: o.askPlayer ? o.line : o.line.replace(/^⭐ /, `⭐ ${token.name}: `)
    };
}
