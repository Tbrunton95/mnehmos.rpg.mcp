# Legendary resistance on the saves the engine rolls

5e: "If the creature fails a saving throw, it can choose to succeed instead." Any saving throw counts, including the repeat save at the end of a turn against a web, a net or a hold. The engine offers it on every save it rolls through its participant save: spell saves (damage and conditions such as Hold Person), world spells, lair and area saves, `apply_damage` and `use_ability` saves, a manoeuvre's save (Trip Attack), a shove's save, the save to stay mounted, the end-of-turn save of a `save_ends` condition (play report 7 follow-up, lane L), and a creature's save against an ongoing tick or water pressure (lane O).

Lane K brought in the three saves that rolled their own way and ignored it:

- the **concentration** CON save after damage, on every road that checks it (an attack, `cast_spell`, a world spell, `apply_damage` / `use_ability` / `lair_action`, `apply_damage` and an `execute` on the sheets, `concentration_manage check_save`): [Concentration saves](#concentration-saves);
- a **stunt's target save** (`improvisation_manage stunt` with `savingThrowAbility`): [A stunt's target save](#a-stunts-target-save);
- an **aura's save** (`aura_manage process`), which is a report: [An aura's save](#an-auras-save).

It is a choice, and never automatic unless you set it to be:

| Creature | A failed save |
| --- | --- |
| `autoLegendaryResistance: true` (on the token or its sheet) | spends one by itself: the save succeeds, and the sheet keeps the count |
| no `autoLegendaryResistance` | is offered: `⭐ LR 2/3 left, spend one?`, and you decide |
| a player character (a `pc` row on the heroes' side) | is offered to the player: `⭐ Kael failed with 2/3 legendary resistance left: ask the player`. The engine never spends one for a player, `autoLegendaryResistance` or not |
| one model of a unit, in an area | none: the resistance belongs to one creature, not to each body (units.md) |

An allied `npc` row and a sheetless token are yours to run, so `autoLegendaryResistance` spends for them as it does for a monster. A unit token's own save (one save for the token's condition, such as its end-of-turn save) follows the creature rule above.

## The end-of-turn save is plain 5e

At `advance` the engine rolls the save of a `save_ends` condition itself. It adds the sheet's ability modifier and save proficiency, the creature's declared sides and its conditions' 5e rules (advantage.md). The total meets the DC or it does not, like every other save the engine rolls. A natural 1 or 20 means nothing special on a save.

```
♻️ Grimgor's end-of-turn DEX save vs webbed: d20 14 + 0 = 14 vs DC 13 (DEX +0) ✓ saved: webbed ends
```

The save used to shift a step on a natural 20 or 1 (`✗ failed on a natural 1`); that rule is gone.

## When it fails

**`autoLegendaryResistance`.** The resistance is spent, the save succeeds and the condition ends. The count is written to the creature's sheet (exact id), so the next fight doesn't give it back.

```
♻️ Grimgor's end-of-turn DEX save vs webbed: d20 2 + 0 = 2 vs DC 13 (DEX +0) ✗ failed → 👑 legendary resistance (LR 2/3 left): webbed ends
```

**Offered.** The condition stays, and the line ends with the call that spends one and ends it:

```
♻️ Grimgor's end-of-turn DEX save vs webbed: d20 2 + 0 = 2 vs DC 13 (DEX +0) ✗ failed: still webbed ⭐ LR 3/3 left, spend one? combat_manage legendary_resistance {encounterId: 'enc-1', participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', reason: 'save vs webbed'}
```

The reply carries the offer three ways:

- the `endOfTurnSaves` row: `conditionId`, and `legendaryOffer {saveRef, remaining, of, askPlayer?, call}` (or `legendaryResisted: true` when one was spent);
- a top-level `legendaryOffers` list, one row per offer: `{participantId, name, saveRef, kind: 'save_ends', condition, conditionId, remaining, of, askPlayer?, call, line}`;
- the turn note.

`output_mode: 'summary'` keeps `legendaryOffers` and `endOfTurnSaves` whole, call included. The offers ride `advance`, `remove_participant` (when it brings the next slot up), and `create` (when a surprised first slot passes).

A player character's line asks the player instead and carries the same call for when they say yes:

```
♻️ Kael's end-of-turn DEX save vs webbed: … ✗ failed: still webbed ⭐ Kael failed with 3/3 legendary resistance left: ask the player. If they spend one: combat_manage legendary_resistance {…, saveRef: 'eot-1-kael-1', …}
```

## Answering an offer: `saveRef`

```
combat_manage legendary_resistance {encounterId, participantId: 'grimgor', saveRef: 'eot-1-grimgor-1', reason: 'save vs webbed'}
  👑 Grimgor turns the failed save vs webbed into a success (save vs webbed): webbed ends; LR 2/3 left
  → {success, remaining: 2, of: 3, saveRef, conditionEnded: {id, name: 'webbed'}, mirroredToCharacter}
```

The spend turns that failed save into a success after the fact, so the `save_ends` condition ends. It is logged and the count is mirrored to the sheet.

- **Offers lapse when the creature's next turn starts.** The turn note says so: `⭐ Grimgor: the legendary resistance offer on the save vs webbed (eot-1-grimgor-1) lapsed: its turn has begun`. A slot that comes round at 0 HP (dying, knocked out) and passes lapses them too. Until then the offer is stored on the token in the encounter row, so a call from another process answers it.
- **The refusals.** An unknown, lapsed or already-answered `saveRef` is refused, and so is a condition that no longer stands (removed by hand). The refusal names the open offers and spends nothing (`writes: 'none'`).
- **Several saves in one turn.** Each failed save gets its own ref (`eot-1-grimgor-1`, `eot-1-grimgor-2`). A ref is never handed out twice in a round: once answered or lapsed it stays closed, so a concentration save that fails again after you answered the first gets `con-1-hag-2`, and pasting the first call a second time is refused instead of spending a resistance on the new offer.
- **Without `saveRef`** the verb works as before. It spends one and lowers the count, but undoes nothing. When the creature has open offers, the reply lists them as `openOffers [{saveRef, kind, condition, conditionId?, refund?}]` (kept whole by `output_mode: 'summary'`), and the message says how to undo each by hand without spending a second resistance: end a `save_ends` condition with `remove_condition {…, conditionId}`, put a concentration back with `concentration_manage restore {…}` (lane K), heal a stunt's damage or an ongoing tick back with `adjust_hp {…, delta: <refund>}` (lanes K and O).

Other saves keep their own lines: `⭐ Failed with 2 legendary resistance(s) left: the GM may spend one`, or `ask the player` for a player character. Spells, areas, `apply_damage`, `use_ability` and lair actions print it on the target's line. A spell's condition save (Hold Person), a world spell's save line, a manoeuvre's `RULE maneuver` line, a shove's breakdown and the stay-mounted line print it too, with `legendaryResistanceAvailable` and `legendaryResistanceAskPlayer` on the save in the JSON. An automatic spend on the stay-mounted save or a world spell's save reads `(legendary resistance)`. Spend one with the verb and adjust the outcome by hand. Five saves can be reversed by `saveRef`: the end-of-turn save (above), a creature's ongoing or pressure save (lane O, docs/table-rules/ongoing-damage.md), a concentration save and a stunt's target save (below).

## Concentration saves

A concentrating creature that takes damage rolls a CON save (DC 10 or half the damage). When it fails and the creature has legendary resistance left, the rule above applies, on every road.

**In a fight.** The count is the token's.

- `autoLegendaryResistance`: one is spent, the save succeeds and the spell holds. The sheet keeps the count (exact id).

  ```
  ▌ 🧠 Hag: Concentration on Hex: CON save 7 vs DC 30 ✗ failed → 👑 legendary resistance (LR 2/3 left): held
  ```

- Otherwise the spell ends and the line offers the resistance, with a `saveRef` (`con-<round>-<id>-<n>`):

  ```
  ▌ 🧠 Hag: Concentration on Hex: CON save 7 vs DC 30 ✗ BROKEN ⭐ LR 3/3 left, spend one? combat_manage legendary_resistance {encounterId: 'enc-1', participantId: 'hag', saveRef: 'con-1-hag-1', reason: 'concentration save on Hex'}
  ```

- A player character is asked: `⭐ Kael failed with 3/3 legendary resistance left: ask the player. If they spend one: …`.

The offer is stored on the token in the encounter row as kind `'concentration'`, holding the broken concentration as it stood: the spell, its level, its targets, the round it started, its duration and its DC base. Answering it puts the spell back exactly, so its duration runs on from the same round:

```
combat_manage legendary_resistance {encounterId, participantId: 'hag', saveRef: 'con-1-hag-1', reason: 'concentration save on Hex'}
  👑 Hag turns the failed concentration save on Hex into a success (concentration save on Hex): concentration on Hex holds; LR 2/3 left
  → {success, remaining: 2, of: 3, saveRef, concentrationRestored: {spell: 'Hex', spellLevel: 1, targetIds: ['kael'], startedAt: 1, maxDuration: 10, saveDCBase: 10}, mirroredToCharacter}
```

It is refused, spending and writing nothing (`writes: 'none'`), when the spell cannot come back: the creature has started concentrating on something else since (a new spell replaced it), it is at 0 HP, or it has no character sheet of its own. Like every offer, it lapses when the creature's next turn starts. Spent without `saveRef`, the reply names the restore call to paste by hand (`concentration_manage restore {…}` without the spend, since the resistance is already gone).

**What the reply carries.** The concentration result (`concentrationSaves[]` on an attack, a spell and a world spell; `targets[].concentration` on `apply_damage`, `use_ability` and `lair_action`; `concentration` on a sheet `execute`; the reply itself on `concentration_manage check_save`) gains `legendaryResisted` (with `legendaryRemaining` and `legendaryOf`) or `legendaryOffer {saveRef, remaining, of, askPlayer?, call, line}`. A concentration row of `saveSources` (one that took a declared source) carries the same two keys. The top-level `legendaryOffers` row is `{participantId, name, saveRef, kind: 'concentration', condition: 'Hex', remaining, of, askPlayer?, call, line}`, which `output_mode: 'summary'` keeps whole. A concentration save that took no source and met no resistance reads as before.

**Off a fight** (`apply_damage` or an `execute` on the sheets, `concentration_manage check_save` for a character with no live token) the count is the sheet's, and no encounter row can hold an offer.

- `autoLegendaryResistance` still spends: the sheet's count drops and the spell holds. A `pc` sheet is never spent for.
- Otherwise the spell ends and the reply reports `legendaryResistanceAvailable` (and `legendaryResistanceAskPlayer` for a `pc` sheet) with the exact repair to paste, as `legendaryOffer.call` and a top-level `legendaryOffers` row marked `noFight: true` with no `saveRef`:

  ```
  ⭐ LR 3/3 left, spend one? concentration_manage restore {characterId: 'hag', spell: 'Hex', spellLevel: 1, startedAt: 1, maxDuration: 10, targetIds: ['kael'], spendLegendaryResistance: true}
  ```

`concentration_manage restore` writes the concentration row back as given and, with `spendLegendaryResistance: true`, lowers the sheet's count in the same call. It is refused, writing nothing, when the character concentrates on something else now, is at 0 HP, has no sheet, has no resistance left, or (when spending) has a live token: a fight counts its resistances on the token, so answer the fight's offer instead.

`concentration_manage check_save` on a character with a live token answers through its fight: the token's count, and an offer with a `saveRef` stored on the encounter row.

## A stunt's target save

`improvisation_manage stunt` with `successDamage`, `targetIds` and `savingThrowAbility` / `savingThrowDc` rolls each target's save on a logged d20 (its own way: the sheet's ability modifier only). A failed save by a target with legendary resistance left:

- **In a fight** (the target has a token in the stunt's `encounterId`, or in a live fight when the stunt names none, as `apply_damage` routes it): the token's count, by the rule above. `autoLegendaryResistance` spends one, the save succeeds and the target takes the success's damage (half with `halfDamageOnSave`, else none). Otherwise the full damage lands and the target's row offers the resistance with a `saveRef` (`stu-<round>-<id>-<n>`), kind `'stunt'`, stored on that fight's encounter row. Answering it heals back the HP the success would have kept, on the token and on its sheet: an ogre at 5 HP that took 8 where a save would have taken 4 gets 1 HP back, not 4. A player character is asked.
- **Off a fight**: a report only. Nothing is spent, `autoLegendaryResistance` or not. The target's row carries `legendaryResistanceAvailable` and the repair to paste: `character_manage update {characterId, legendaryResistancesRemaining: <one less>, hp: <the HP a success would have left>}`.

The target rows carry `legendaryResisted` or `legendaryOffer`; the reply's `legendaryOffers` carries the call whole. The stunt's `applyCondition` is only named on a failed save, never written, so a spend changes nothing there: if you applied it by hand, take it off.

## An aura's save

`aura_manage process` is a report: it rolls each effect's save and dice and writes no damage or condition to a token. A failed save by a creature with legendary resistance left carries the offer on its row (`legendaryResistanceAvailable`, `legendaryOffer {remaining, of, askPlayer?, call, line}`) and on its line:

```
⭐ LR 3/3 left, spend one? combat_manage legendary_resistance {encounterId: 'enc-1', participantId: 'dragon', reason: 'Spirit Guardians save'} (the aura report wrote nothing: on a spend the save succeeds, so apply none of this effect)
```

Nothing is ever spent here, `autoLegendaryResistance` or not, since nothing was written that a spend could undo. A player character is asked. The call has no `saveRef`: it spends one and lowers the count, and you apply the success yourself. Each offer is also a row of the reply's top-level `legendaryOffers` (`kind: 'aura'`, `condition`: the aura's name, no `saveRef`), which `output_mode: 'summary'` keeps whole; the `effects` rows it rides collapse there.

## Ongoing damage and water pressure

Lane O built ongoing damage on the same offer ([ongoing-damage.md](ongoing-damage.md)). An ongoing effect with a save, and water pressure with a save, use this plain-5e save on a creature, and legendary resistance answers it the same way: `autoLegendaryResistance` spends one (the tick deals what a success deals), otherwise the damage lands and the failed save is offered as kind `'ongoing'`, with a `saveRef` of its own (`'ong-<round>-<id>-<n>'`) and a `refund`, the HP the success would have saved. A player character is asked, never spent for.

```
🔥 Grimgor — burning (start of turn): DEX save d20 2 + 0 = 2 vs DC 15 (DEX +0) ✗ failed: 5 fire, HP 118 → 113/120 ⭐ LR 2/3 left, spend one? combat_manage legendary_resistance {encounterId: 'enc-1', participantId: 'grimgor', saveRef: 'ong-2-grimgor-1', reason: 'save vs burning'}
combat_manage legendary_resistance {…, saveRef: 'ong-2-grimgor-1', reason: 'save vs burning'}
  👑 Grimgor turns the failed save vs burning into a success (save vs burning): 5 HP back; LR 1/3 left
```

The refund is healed back on the token and written to the sheet. With `onSuccess: 'end'` the answer ends the condition too. The row in `legendaryOffers` and the tick's `turnDamage` row carry the `refund`. A pressure offer names `water pressure`. A creature the tick killed is refused: its kill has run. One model of a unit saving against a tick or pressure never spends or offers the token's resistance.
