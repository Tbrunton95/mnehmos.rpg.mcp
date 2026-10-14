/**
 * Play report 7, item 6: the PC turn guard.
 *
 * Blackcrown, Day 89: the GM advanced past a player character's slot before
 * the player had done anything, and the late swing then ran off-turn and was
 * refused with "Action already used this turn" and nothing saying the turn
 * had ended. combat_manage advance now refuses to pass a living player
 * character whose turn is untouched, unless the GM confirms the pass; and an
 * off-turn economy refusal says whose turn it is and that the actor's has
 * ended. The pure pieces live here; the handler reads the sheet, the agent
 * and the world.
 */
import type { CombatParticipant, CombatState } from './engine.js';
import { isControlledMount } from './mounts.js';

/**
 * True when it is this token's turn: its own slot is up, or it is a
 * controlled mount whose rider's slot is up (play report 7 #10: it acts on
 * its rider's turn, and its own slot passes).
 */
export function onActiveTurn(state: CombatState, participantId: string): boolean {
    const activeId = state.turnOrder[state.currentTurnIndex];
    if (!activeId) return false;
    if (activeId === participantId) return true;
    const p = state.participants.find(x => x.id === participantId);
    return !!p && p.controlledBy === activeId && isControlledMount(state, p);
}

/**
 * True when the token has done nothing this turn: no action, bonus action,
 * attack, movement, Dash, Disengage, banked extra action, spell, and no other
 * combat action logged against it (actedThisTurn: any combat_action, a free
 * battle cry or ability, a theatre-of-mind placement, a readied action set
 * this turn). A readied action left from an earlier turn does not count.
 */
export function turnUntouched(p: CombatParticipant): boolean {
    return !p.actionUsed
        && !p.bonusActionUsed
        && !(p.attacksMade ?? 0)
        && !(p.movedThisTurn ?? 0)
        && !(p.dashes ?? 0)
        && !p.hasDashed
        && !p.hasDisengaged
        && !(p.extraActions ?? 0)
        && Object.keys(p.spellsCast ?? {}).length === 0
        && !p.actedThisTurn;
}

/** The exact call that passes an untouched player character's turn. */
export function confirmAdvanceCall(encounterId: string): string {
    return `combat_manage advance {encounterId: '${encounterId}', confirm: true}`;
}

/** TURN NOT TAKEN: the refusal advance gives for an untouched player character. */
export function turnNotTakenMessage(name: string, encounterId: string): string {
    return `TURN NOT TAKEN: ${name} (player character) has used no action, bonus action or movement this turn. advance refused; nothing was written. If the player passes or holds, call ${confirmAdvanceCall(encounterId)} (alias skipTurn: true); if the player acts, resolve that first.`;
}

/** The ⏭ line a confirmed pass prints. */
export function turnPassedLine(name: string): string {
    return `⏭ TURN PASSED: ${name} (player character) took no action, bonus action or movement; the GM passed the turn (confirm).`;
}

/**
 * Off-turn clarity for a spent action or bonus action: whose turn it is and
 * why the economy is spent. undefined on the actor's own turn (the refusal
 * reads as it always did).
 */
export function offTurnEconomyNote(state: CombatState, participantId: string, what: 'action' | 'bonus'): string | undefined {
    const activeId = state.turnOrder[state.currentTurnIndex];
    if (!activeId || onActiveTurn(state, participantId)) return undefined;
    const actor = state.participants.find(p => p.id === participantId);
    if (!actor) return undefined;
    // Play report 7 #10 (review): a controlled mount acts on its rider's turn, so that turn is its own.
    if (actor.controlledBy && actor.controlledBy === activeId && isControlledMount(state, actor)) return undefined;
    const active = activeId === 'LAIR' ? 'the LAIR slot' : `${state.participants.find(p => p.id === activeId)?.name ?? activeId}'s turn`;
    const slot = state.turnOrder.indexOf(participantId);
    // Its turn has ended when its slot came earlier this round, or in any
    // round after the first (the advance into this round passed its slot
    // last round). Only a round-1 slot still to come has had no turn yet.
    const passed = slot >= 0 && (slot < state.currentTurnIndex || state.round > 1);
    const why = passed
        ? `${actor.name}'s turn has ended (advance passed it)`
        : `${actor.name}'s turn is still to come this round, and its ${what === 'bonus' ? 'bonus action' : 'action'} was spent off-turn`;
    const back = what === 'bonus' ? 'its bonus action comes back' : 'its action and attacks come back';
    return `it is ${active}: ${why}; ${back} at the start of its next turn`;
}
