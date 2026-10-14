# Turns: the PC turn guard, passing a turn, off-turn actions

A player character's turn is the player's. The engine will not pass it silently: `combat_manage advance` refuses to leave the slot of a player character who has done nothing this turn, and the GM passes it with one word when the player passes or holds. Play report 7, item 6 (Blackcrown, Day 89).

## TURN NOT TAKEN

`advance` is refused, with nothing written (`writes: 'none'`), when the slot that is up belongs to a **living player character who can act and whose turn is untouched**:

```
TURN NOT TAKEN: Kael (player character) has used no action, bonus action or movement this turn. advance refused; nothing was written. If the player passes or holds, call combat_manage advance {encounterId: '…', confirm: true} (alias skipTurn: true); if the player acts, resolve that first.
```

The reply also carries the same facts as data, so `output_mode: 'summary'` keeps them: `turnNotTaken {participantId, name, round}` and `confirmCall` (the exact call above).

A **player character** is a token with a character row of type `pc` (the default type) on the heroes' side (`isEnemy` not set).

A turn is **untouched** when the token has used no action, bonus action, attack, movement, Dash, Disengage, banked extra action (Action Surge) or spell this turn, and has taken no other combat action. Anything below touches it:

| Touches the turn | Does not |
| --- | --- |
| any `combat_action` (attack, move, dash, disengage, dodge, help, ready, heal, cast_spell, volley, grapple, stabilize) | a readied action left from an earlier turn |
| a theatre-of-mind placement (`move` on a token with no position) | a skill check rolled through `math_manage` |
| `use_ability`, including a free one (`actionCost: 'none'`) | the GM changing the token (`add_condition`, `adjust_hp`, `set_cover`) |
| `battle_cry`, including a free one | a reaction taken on someone else's turn before this one |
| `set_intent` with a `readied` action | `set_intent` with only intent text |
| `mount` / `dismount` on the rider's own turn (half its speed) | `mount` / `dismount` with `free: true` (setting the scene, a correction) |
| a controlled mount's Dash, Disengage or Dodge on its rider's turn (the rider's word) | a move refused before a step (blocked, no path, not enough movement) |

The flag that records "any other combat action" is `actedThisTurn` on the token; it clears at the token's turn start with the rest of its economy.

## Passing the turn

```
combat_manage advance {encounterId, confirm: true}
combat_manage advance {encounterId, skipTurn: true}      (the same call)
```

The turn passes as any advance would. The reply carries `skippedTurn {participantId, name, round}` and a line:

```
⏭ TURN PASSED: Kael (player character) took no action, bonus action or movement; the GM passed the turn (confirm).
```

and the combat log gets a `skip_turn` row (actor GM, target the character). `confirm` on a turn that was taken, or on a slot the guard never holds, changes nothing.

## Never held

| Slot | Why |
| --- | --- |
| LAIR | not a creature |
| HP 0 (dying, stable, knocked out, dead) | nothing to take; a prompt-mode `DEATH SAVE DUE` still refuses first |
| incapacitated (stunned, paralysed, unconscious, petrified) | cannot act |
| surprised | its slot passes inside the advance |
| a controlled mount | its slot passes inside the advance (it acts on its rider's turn) |
| an enemy (`isEnemy`), even with a pc row | the GM's |
| an `npc`, `enemy` or `neutral` row | the GM's |
| a token with no character row | the GM's |
| a token an agent plays (`agent_manage`, `auto_on_turn`, active) | the agent's |

A world that does not want the guard turns it off: `world_manage update {worldId, environment: {pcTurnGuard: 'off'}}` (`'on'`, or unset, is the default).

## A late action, off the actor's turn

The engine does not refuse an action taken off the actor's turn (reactions and late corrections need it), but it says so, in prose and in the JSON:

- The action's reply carries `offTurn {actorId, activeId, activeName}` beside the `off_turn_action` warning line. A controlled mount acting on its rider's turn is on its turn: no warning, no `offTurn`.
- When the action is already spent, the refusal says why: `Action already used this turn — it is Gor's turn: Kael's turn has ended (advance passed it); its action and attacks come back at the start of its next turn`. That holds for a token whose slot came earlier this round, and from round 2 on for one later in the order (the advance into this round passed its slot). Only a round-1 token whose first turn is still to come is told its action was spent off-turn. On its own turn the refusal reads as it always did.

## Turn starts outside an advance

Two paths land on a slot without an advance; both now start that turn (fresh action, bonus action, movement and reaction; regeneration, recharge and fading buffs as an advance runs them):

- **A natural 20 answering DEATH SAVE DUE** (prompt mode): the advance stopped on the slot at 0 HP and ran no turn start. The reply says `takes this turn` and carries `turnStarted: true`. A natural 20 rolled before the slot comes up needs nothing: the creature is back at 1 HP and the advance starts its turn as usual.
- **remove_participant of the actor that is up**: the next slot comes up exactly as an advance brings it up, without an end of turn for the creature that left: a surprised slot passes (round 1), a dying slot rolls its death save (prompt mode: `DEATH SAVE DUE`, and advance is refused until it is rolled), a controlled mount's slot passes; removing the last slot opens the next round. The new actor's turn starts. The reply carries `round`, `turnStartNotes`, `deathSaves`, `deathSaveDue` and `killed` as an advance does, and says who is up.

Both run the turn start's damage too (play report 7 follow-up, lane O): water pressure and a condition's ongoing damage tick there, with their saves read through the same provider as on an advance, and the reply carries `turnDamage`, `unitLines`, `breakTests` and `legendaryOffers` as an advance does ([ongoing-damage.md](ongoing-damage.md#what-the-reply-carries)).
