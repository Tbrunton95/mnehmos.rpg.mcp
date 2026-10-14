# Dying: death saves, stabilising, the dead

At 0 HP a named character is **dying**, not dead. The engine tracks the saves, rolls them on its turn, counts the hits it takes while down, and runs the kill when the third failure lands. Mooks still die at 0. Play report 5, item 5.

## Who tracks death saves

| Participant | At 0 HP |
| --- | --- |
| A token with a character row of type `pc` or `npc` (named PCs, followers, recurring NPCs) | dying: death saves |
| A row with `combat_profile.deathSaves: false` | dies at 0 (opted out) |
| A row of type `enemy` or `neutral` | dies at 0 |
| A row with `deathSaves: true` (a villain worth the track) | dying |
| A quick spawn, a bestiary mook, a token with no row | dies at 0 (`💀 DEFEATED`) |
| A token created or added with `deathSaves: true` | dying, row or not |
| A unit (`unit` tokens) | never: models die |

The flag is read from the row before every action and advance, so a sheet change mid-fight takes effect at once. Set it on the sheet: `character_manage update {characterId, deathSaves: false}`; or per token: `combat_manage add_participant {…, deathSaves: true}`.

A **nonlethal** knockout (lane B) leaves the token `isStabilized`: stable, never dying. The two rules never meet.

## When the turn comes up

**Auto (default).** On `combat_manage advance` into a dying slot the engine rolls the save itself on the fight's dice, logged `forId` the creature, purpose `death save`:

| d20 | Result |
| --- | --- |
| 10 or higher | one success: `🩸 Hero: death save d20=14 — success (✓1 ✗0)`, the slot passes |
| 9 or lower | one failure, the slot passes |
| natural 1 | two failures |
| natural 20 | back to 1 HP, conscious, and **takes this turn** (advance stops on it); the sheet is written |
| third success | `💤 STABLE`: unconscious, no more saves, the slot passes silently from now on |
| third failure | `☠ DEAD`: the existing kill runs on the sheet (cause, corpse) and is printed plainly |

The notes ride `turnStartNotes`; STATE_JSON carries `deathSaves: [{participantId, roll, success, successes, failures, isStabilized, isDead}]` and `killed: [{participantId, cause, corpseId}]`.

**A save made by hand is the slot's save.** When the player rolls their own and the GM posts it (`death_save` before the advance), the engine rolls no second die when the slot comes up: the note reads `death save already made this round by hand (✓1 ✗0) — no second roll; the slot passes`, and the state view shows `deathSaveTaken` until then. A save that answers a `DEATH SAVE DUE` is that slot's own and is consumed at once; the next slot prompts again.

**Prompt.** With `deathSaveMode: 'prompt'` the engine stops on the slot instead:

```
🩸 DEATH SAVE DUE: Hero (0 HP, ✓1 ✗2) — combat_manage death_save {encounterId: '…', participantId: 'hero'}
```

and `advance` is refused (`writes: 'none'`) until the save is rolled or posted. A natural 20 that answers it brings the creature back at 1 HP and starts its turn there (fresh action, movement and reaction; play report 7 #6), so its first swing is not refused with the economy left from the turn it dropped. See [turns.md](turns.md). Set it per world (`world_manage update {worldId, environment: {deathSaveMode: 'prompt'}}`) or per character (`character_manage update {characterId, deathSaveMode: 'prompt'}`); a character's own mode wins over the world's.

## death_save

```
combat_manage death_save {encounterId, participantId}
combat_manage death_save {encounterId, participantId, outcome: 'nat20'}
```

`participantId` is the token id (`characterId` still works as an alias; both given and different is refused). `outcome` posts a result the table rolled — `success | failure | nat20 | nat1`, also `pass`/`fail`, `'natural 20'`, or the natural die 1–20 — and rolls no d20. A natural 20 writes 1 HP to the sheet (the next sync no longer reverts it) and wakes it: the dying Unconscious and Prone come off the row, and so does a knockout's Unconscious on a token that was knocked out earlier and then hit lethally. A third failure kills through `character_manage kill`.

## Damage and healing at 0 HP

| Event | Effect |
| --- | --- |
| Dropped to 0 (tracked) | Unconscious + Prone, source `dying`, on the token and mirrored to the sheet; `[DYING ✓0 ✗0]` |
| A hit while down | one failed save |
| A crit, or any melee hit (within 5 ft: the unconscious are auto-crit anyway) | two failed saves |
| Damage to a stable creature | dying again, with the failure |
| Massive damage: leftover past 0 ≥ max HP — the dropping blow included | dead outright, `☠ DEAD (massive damage)` |
| Any healing above 0 (engine heal, a spell, `adjust_hp`, a hand `update {hp}`) | both counters clear, the dying Unconscious comes off, consciousness returns; prone stays until they stand |
| A long rest | the dying conditions and a Stable marker come off the sheet |

**One rule for every road that heals a sheet above 0.** The character repository strips the dying marks (Unconscious/Prone sourced `dying`, `Stable`) from any HP write that takes a sheet from 0 to above it unless that call sets `conditions` itself: a potion (`inventory_manage use`), a healing spell's write-back, the stabilised creature's 1d4-hour return (the fired row's `applied` lists `wakes: …`), a hand `update {hp}`, the token sync after a natural 20. A sheet put to 0 by hand (`update {hp: 0}`) drops its live token like a blow would: unconscious, prone, counters fresh, at the next combat call.

**Every road that drops a tracked token follows through.** `combat_action attack` (volleys included), an opportunity attack or a readied attack a move fires, `combat_manage trigger_readied`, `cast_spell` (the SRD path and a world's own spells), `apply_damage`, `use_ability` and `lair_action` all mirror the drop to the sheet and run the kill on a death. Each reports `dying: {dropped, failuresAdded, failures, dead, instantDeath}` per target; an attack-shaped result (attack, opportunity, readied, `trigger_readied`) carries one `killed` record, a spell or area result a `killed` list.

## Stabilising

```
combat_action stabilize {encounterId, actorId, targetId}
```

The healer must be **adjacent** (within 5 ft) and spends the **action**. A Wisdom (Medicine) check **DC 10** is rolled on the fight's dice with the sheet's WIS + proficiency (`medicineBonus` overrides). Automatic success:

- a **healer's kit** in the actor's inventory — `properties.healersKit: true`, or a name like "Healer's Kit" — spends one use (counted on the item instance from the template's `uses`, default 10); `useKit: false` keeps it and rolls;
- **Spare the Dying** as a cantrip, known spell or ability on the sheet (or an ability/tag named `stabilizes`).

Success: `💤 STABLE` — unconscious, no more saves, counters cleared. The engine rolls **1d4 hours** and files the return to 1 HP as a scheduled change on the world clock (`adjust_hp +1`, note `stable: regains 1 HP`); `world_manage advance {hours, fireScheduled: true}` or `character_manage process_scheduled` fires it. Without a world clock the reply says so and gives the hours.

A failed check still spends the action. Refused before anything is spent: not adjacent, action already used, target above 0 HP, dead, or already stable.

## Outside a fight

`combat_manage apply_damage {targetIds, dice, source}` with no encounter on a tracked sheet dropped to 0 writes Unconscious + Prone (source `dying`) and says:

```
🩸 DYING — stabilise: combat_action stabilize {actorId: '<healer>', targetId: 'hero'}
```

No saves are rolled round by round out of a fight. Massive damage kills the sheet with a corpse — on the dropping blow (leftover past 0 ≥ max HP) and on a sheet already at 0 (the whole blow counts). A lesser blow on a sheet already down keeps it `DYING`; on a `Stable` sheet it takes the marker off (`was stable: the blow makes it dying again`, `wasStable: true`). A sheet that already has a corpse reads `DEAD` and nothing is tracked. `combat_action stabilize {actorId, targetId}` with no encounter runs on the sheets: Medicine on logged dice, `Stable` written to the row, the 1d4 hours filed the same way.

## Where it shows

- Token line and `combat_manage get`: `🩸 DYING ✓1 ✗2`, `💤 STABLE`, `☠ DEAD`; mooks keep `💀 DEFEATED`. A held slot reads `DEATH SAVE DUE`.
- STATE_JSON per participant: `deathSaves: {successes, failures, status, label}`, `isDead`, `isStabilized`, `deathSaveDue`, `deathSaveTaken` (a save made by hand, waiting for the slot).
- `character_manage get_status_block`: `dying: {status, successes, failures, label}` from the live token, or from the sheet's own conditions when there is no fight.

## Decisions

- `npc` rows count as named; a location NPC that joins a fight can be opted out with `deathSaves: false`.
- A melee hit on an unconscious target from 5 ft counts two failures whether rolled (auto-crit) or posted (`outcome: 'hit'`).
- Healing wakes but does not stand you up: prone stays, as 5e has it.
- Death saves roll only in a fight; outside one the table stabilises or heals.
- A death save posted before the slot is that slot's save (the player rolled their own); the engine never rolls a second one in the same round.
- `killed` keeps the shape of the result it rides: one record on attack-shaped results, a list on spells and area effects.
