/**
 * Play report 7 follow-up (lane L): legendary resistance on the saves the
 * engine rolls by itself.
 *
 * 5e: "If the creature fails a saving throw, it can choose to succeed
 * instead." Any saving throw counts, the repeat save at the end of a turn
 * against a web or a hold included. It is a choice, never automatic by
 * default:
 *  - autoLegendaryResistance on the creature spends one by itself;
 *  - otherwise the failed save is offered ("LR 2/3 left, spend one?") and
 *    the GM decides;
 *  - a player-controlled creature is asked, never spent for, on any road.
 *
 * legendaryOnFailedSave is the one rule: rollParticipantSave (saves.ts) and
 * the engine's end-of-turn save of a save_ends condition both ask it.
 *
 * An offer on a save the engine can reverse carries a saveRef and stays on
 * the creature (pendingLegendaryOffers, in the participant JSON on the
 * encounter row, so a second process answers it) until the creature's next
 * turn starts. combat_manage legendary_resistance {saveRef} then spends one
 * and turns the failed save into a success: a save_ends condition ends; an
 * ongoing tick (kind 'ongoing', built by lane O on this machinery) is healed
 * back by its refund, the damage the success would have avoided.
 *
 * Lane K: the saves that ignored it now ask it too. A concentration CON save
 * that fails offers kind 'concentration', carrying the broken concentration
 * as it stood (ConcentrationSnapshot), so answering restores it; a stunt's
 * target save offers kind 'stunt', whose refund heals back the damage the
 * success would have avoided.
 *
 * Pure: no database. The handlers read the sheet and mirror a spend through
 * the provider they hand the engine (SaverSides.playerDecides / onSpent).
 */
import type { CombatParticipant } from './engine.js';

/** What a failed save's legendary resistance came to: spent, offered (the count left), or nothing. */
export interface LegendaryVerdict {
    /** autoLegendaryResistance spent one: the save succeeds; this many are left. */
    resisted?: { remaining: number };
    /** Not spent: this many are left for the GM (or the player) to spend. */
    available?: number;
    /** A player-controlled creature: ask the player; the engine never spends for them. */
    askPlayer?: true;
}

/**
 * Lane K: what legendary resistance did on a failed save a result row
 * carries (a concentration save, a stunt's target save, an aura's save).
 *  - spent (autoLegendaryResistance): legendaryResisted, and the count left;
 *  - offered in a fight: legendaryOffer with its saveRef and the call;
 *  - reported where no encounter row can hold an offer (the sheets, an
 *    aura's report): legendaryResistanceAvailable, and legendaryOffer whose
 *    call is the repair to paste (no saveRef).
 */
export interface LegendaryOutcome {
    legendaryResisted?: true;
    /** After an automatic spend: the resistances left, of how many. */
    legendaryRemaining?: number;
    legendaryOf?: number;
    legendaryResistanceAvailable?: number;
    legendaryResistanceAskPlayer?: true;
    legendaryOffer?: LegendaryOfferNote;
}

/** An offer as a result row carries it: the ref (in a fight), the count, the call to paste and its ⭐ phrase. */
export interface LegendaryOfferNote {
    saveRef?: string;
    remaining: number;
    of?: number;
    askPlayer?: true;
    call: string;
    line: string;
}

/** The engine's spend (CombatEngine.useLegendaryResistance), so this module stays free of the class. */
export interface LegendarySpender {
    useLegendaryResistance(participantId: string): { success: boolean; remaining: number; error?: string };
}

/**
 * A failed save by `p`: spend a legendary resistance (autoLegendaryResistance,
 * not player-controlled), offer one (the count left; askPlayer for a player),
 * or nothing (none left, or `noLegendaryResistance`: one model of a unit
 * saving, which has none of its own). Call it only on a failed save.
 */
export function legendaryOnFailedSave(
    engine: LegendarySpender,
    p: Pick<CombatParticipant, 'id' | 'legendaryResistancesRemaining' | 'autoLegendaryResistance'>,
    opts: { noLegendaryResistance?: boolean; playerDecides?: boolean } = {}
): LegendaryVerdict {
    if (opts.noLegendaryResistance) return {};
    const remaining = p.legendaryResistancesRemaining ?? 0;
    if (remaining <= 0) return {};
    if (opts.playerDecides) return { available: remaining, askPlayer: true };
    if (p.autoLegendaryResistance) {
        const spent = engine.useLegendaryResistance(p.id);
        return spent.success ? { resisted: { remaining: spent.remaining } } : {};
    }
    return { available: remaining };
}

/**
 * Lane K: a concentration a failed CON save broke, as its concentration row
 * stood, so an answered offer puts it back exactly (spell, level, targets,
 * the round it started, its duration, its DC base).
 */
export interface ConcentrationSnapshot {
    spell: string;
    spellLevel: number;
    targetIds?: string[];
    startedAt: number;
    maxDuration?: number;
    saveDCBase: number;
}

/**
 * An offered legendary resistance the GM can still answer with saveRef. It
 * lapses when the creature's next turn starts.
 *  - 'save_ends': a save_ends condition's end-of-turn save failed; answering
 *    ends the condition (conditionId).
 *  - 'ongoing' (lane O): an ongoing effect's save failed and its damage
 *    landed; answering heals `refund` back (the damage a success would have
 *    avoided: all of it, or half for a half-on-success save).
 *  - 'concentration' (lane K): a concentration CON save failed and the spell
 *    ended; answering restores `concentration` as it stood.
 *  - 'stunt' (lane K): a stunt's target save failed and its damage landed;
 *    answering heals `refund` back, on the token and its sheet.
 */
export interface PendingLegendaryOffer {
    ref: string;
    kind: 'save_ends' | 'ongoing' | 'concentration' | 'stunt';
    /** The condition the save was against (save_ends, ongoing); a concentration or stunt offer has none. */
    conditionId?: string;
    /** What the save was against, for the reply: the condition ('webbed'), the spell held ('Hex'), the stunt ('kick the brazier'). */
    condition: string;
    /** The round the save was rolled in. */
    round: number;
    /** kind 'ongoing' and 'stunt': HP healed back when the offer is answered. */
    refund?: number;
    /** Lane O: kind 'ongoing' with onSuccess 'end': the success would also have ended the condition. */
    endsCondition?: true;
    /** kind 'concentration': the concentration the failed save broke, restored when the offer is answered. */
    concentration?: ConcentrationSnapshot;
}

/** Lane K: which save an offer answers, for its call's reason and the replies ('save vs webbed', 'concentration save on Hex'). */
export function offerSaveLabel(o: Pick<PendingLegendaryOffer, 'kind' | 'condition'>): string {
    if (o.kind === 'concentration') return `concentration save on ${o.condition}`;
    if (o.kind === 'stunt') return `save vs the stunt (${o.condition})`;
    return `save vs ${o.condition}`;
}

/** An offer as a reply row (the top-level legendaryOffers, kept whole by output_mode summary). */
export interface LegendaryOfferRow {
    participantId: string;
    name: string;
    saveRef: string;
    kind: PendingLegendaryOffer['kind'];
    condition: string;
    conditionId?: string;
    remaining: number;
    of?: number;
    /** A player-controlled creature: ask the player. */
    askPlayer?: true;
    /** Lane O: kind 'ongoing': the HP the spend heals back (what the success would have avoided). */
    refund?: number;
    /** The call to paste: combat_manage legendary_resistance {…, saveRef}. */
    call: string;
    line: string;
}

const quote = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** The call that answers an offer. */
export function legendaryOfferCall(encounterId: string, participantId: string, saveRef: string, reason: string): string {
    return `combat_manage legendary_resistance {encounterId: '${quote(encounterId)}', participantId: '${quote(participantId)}', saveRef: '${quote(saveRef)}', reason: '${quote(reason)}'}`;
}

/**
 * The next free ref for `p` this round: '<prefix>-<round>-<id>-<n>' ('eot-2-boss-1'; lane O: 'ong-…'; lane K: 'con-…' a concentration save, 'stu-…' a stunt's).
 * Lane K review: a ref answered or lapsed this round is never handed out again
 * (closedLegendaryRefs), so a repeated or stale answer call is refused rather
 * than spending a resistance on a later offer (a concentration save can fail
 * several times a round).
 */
export function nextOfferRef(p: Pick<CombatParticipant, 'id' | 'pendingLegendaryOffers' | 'closedLegendaryRefs'>, prefix: 'eot' | 'ong' | 'con' | 'stu', round: number): string {
    const stem = `${prefix}-${round}-${p.id}-`;
    const taken = new Set([...(p.pendingLegendaryOffers ?? []).map(o => o.ref), ...(p.closedLegendaryRefs ?? [])]);
    let n = 1;
    while (taken.has(`${stem}${n}`)) n++;
    return `${stem}${n}`;
}

/** The round a ref was offered in ('con-3-hag-1' → 3). */
const refRound = (ref: string): number => Number(/^[a-z]+-(\d+)-/.exec(ref)?.[1] ?? 0);

/**
 * Lane K review: remember refs that can no longer be answered (answered or
 * lapsed), so nextOfferRef skips them. Refs carry their round, so only this
 * round's can collide: older ones are dropped as newer ones close.
 */
function closeLegendaryRefs(p: CombatParticipant, offers: PendingLegendaryOffer[]): void {
    if (!offers.length) return;
    const newest = Math.max(...offers.map(o => o.round));
    const kept = (p.closedLegendaryRefs ?? []).filter(r => refRound(r) >= newest);
    p.closedLegendaryRefs = [...kept, ...offers.filter(o => o.round >= newest).map(o => o.ref)];
}

/**
 * The offer's phrase, after the save line: the GM's "LR 2/3 left, spend
 * one?" or, for a player-controlled creature, "Kael failed with 2/3
 * legendary resistance left: ask the player", then the call.
 */
export function legendaryOfferPhrase(name: string, remaining: number, of: number | undefined, askPlayer: boolean, call: string): string {
    const count = `${remaining}/${of ?? remaining}`;
    return askPlayer
        ? `⭐ ${name} failed with ${count} legendary resistance left: ask the player. If they spend one: ${call}`
        : `⭐ LR ${count} left, spend one? ${call}`;
}

/**
 * Record an offer on the creature and build its reply row. `line` is the
 * offer's own line ('⭐ Grimgor: LR 3/3 left, spend one? …').
 */
export function recordLegendaryOffer(
    p: CombatParticipant,
    offer: Omit<PendingLegendaryOffer, 'ref'> & { ref: string },
    remaining: number,
    askPlayer: boolean,
    encounterId: string | undefined
): LegendaryOfferRow {
    p.pendingLegendaryOffers = [...(p.pendingLegendaryOffers ?? []), offer];
    const call = legendaryOfferCall(encounterId ?? '<encounterId>', p.id, offer.ref, offerSaveLabel(offer));
    const of = p.legendaryResistances;
    const phrase = legendaryOfferPhrase(p.name, remaining, of, askPlayer, call);
    return {
        participantId: p.id, name: p.name, saveRef: offer.ref, kind: offer.kind,
        condition: offer.condition, ...(offer.conditionId !== undefined ? { conditionId: offer.conditionId } : {}),
        remaining, ...(of !== undefined ? { of } : {}),
        ...(askPlayer ? { askPlayer: true as const } : {}),
        ...(offer.refund !== undefined ? { refund: offer.refund } : {}),
        call,
        line: askPlayer ? phrase : phrase.replace(/^⭐ /, `⭐ ${p.name}: `)
    };
}

/** The creature's turn has begun: its open offers lapse. Returns what lapsed. */
export function expireLegendaryOffers(p: CombatParticipant): PendingLegendaryOffer[] {
    const lapsed = p.pendingLegendaryOffers ?? [];
    if (lapsed.length) delete p.pendingLegendaryOffers;
    closeLegendaryRefs(p, lapsed);
    return lapsed;
}

/**
 * Why `ref` cannot be answered on `p`, before anything is spent (undefined:
 * it can): no such open offer (offers lapse when the creature's next turn
 * starts), or a save_ends condition that no longer stands.
 */
export function legendaryOfferProblem(p: CombatParticipant, ref: string): string | undefined {
    const open = p.pendingLegendaryOffers ?? [];
    const offer = open.find(o => o.ref === ref);
    if (!offer) {
        // Lane K review: an answered or lapsed ref is named as such.
        const closed = (p.closedLegendaryRefs ?? []).includes(ref) ? ': it was already answered or has lapsed' : '';
        return `${p.name} has no open legendary resistance offer ${ref}${closed} (offers lapse when its next turn starts) — open: ${open.map(o => `${o.ref} (${offerSaveLabel(o)})`).join(', ') || 'none'}. Nothing spent.`;
    }
    if (offer.kind === 'save_ends' && !p.conditions.some(c => c.id === offer.conditionId)) {
        return `${offer.condition} no longer stands on ${p.name} (offer ${ref}): nothing to undo. Nothing spent.`;
    }
    // Lane O: a tick that killed the creature has run its kill on the sheet; a refund cannot undo a death.
    if (offer.kind === 'ongoing' && p.isDead) {
        return `${p.name} is dead (offer ${ref}, save vs ${offer.condition}): the kill has run, and healing cannot undo it. Nothing spent.`;
    }
    // Lane K: the concentration row lives in the database; the handler checks it can come back (concentrationRestoreProblem).
    if (offer.kind === 'concentration' && !offer.concentration) {
        return `The offer ${ref} holds no concentration to restore. Nothing spent.`;
    }
    return undefined;
}

/**
 * The engine's reversals (CombatEngine.removeCondition / heal). Lane K: the
 * handler adds restoreConcentration, which writes the concentration row back
 * (the engine never reads or writes the database).
 */
export interface LegendaryReverser {
    removeCondition(participantId: string, conditionId: string): boolean;
    heal(participantId: string, amount: number): void;
    restoreConcentration?(participantId: string, snapshot: ConcentrationSnapshot): boolean;
}

/** What answering an offer undid. */
export interface LegendaryAnswer {
    offer: PendingLegendaryOffer;
    /** kind 'save_ends': the condition the success ended. */
    conditionEnded?: { id: string; name: string };
    /** kind 'ongoing' (lane O) and 'stunt' (lane K): HP healed back. */
    refunded?: number;
    /** kind 'concentration' (lane K): the concentration put back as it stood. */
    concentrationRestored?: ConcentrationSnapshot;
}

/**
 * Turn the offered failed save into a success, after the resistance has been
 * spent: the offer leaves the creature; a save_ends condition ends; an
 * ongoing tick's refund is healed back. Call legendaryOfferProblem first.
 */
export function answerLegendaryOffer(engine: LegendaryReverser, p: CombatParticipant, ref: string): LegendaryAnswer | undefined {
    const offer = (p.pendingLegendaryOffers ?? []).find(o => o.ref === ref);
    if (!offer) return undefined;
    const rest = (p.pendingLegendaryOffers ?? []).filter(o => o !== offer);
    if (rest.length) p.pendingLegendaryOffers = rest; else delete p.pendingLegendaryOffers;
    closeLegendaryRefs(p, [offer]);
    if (offer.kind === 'save_ends') {
        return offer.conditionId && engine.removeCondition(p.id, offer.conditionId)
            ? { offer, conditionEnded: { id: offer.conditionId, name: offer.condition } }
            : { offer };
    }
    // Lane K: the success would have kept the concentration.
    if (offer.kind === 'concentration') {
        return offer.concentration && engine.restoreConcentration?.(p.id, offer.concentration)
            ? { offer, concentrationRestored: offer.concentration }
            : { offer };
    }
    // kind 'ongoing' (lane O) and 'stunt' (lane K): the success would have avoided `refund` damage,
    // and an ongoing effect with onSuccess 'end' would have ended the condition too.
    const conditionEnded = offer.endsCondition && offer.conditionId && engine.removeCondition(p.id, offer.conditionId)
        ? { conditionEnded: { id: offer.conditionId, name: offer.condition } }
        : {};
    if (offer.refund && offer.refund > 0) {
        engine.heal(p.id, offer.refund);
        return { offer, refunded: offer.refund, ...conditionEnded };
    }
    return { offer, ...conditionEnded };
}
