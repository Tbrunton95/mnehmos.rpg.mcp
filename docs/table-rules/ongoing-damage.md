# Ongoing damage and water pressure: damage by its shape

The owner's rule after play report 7: "damage resolves by its shape, not by which code path delivered it."

- **Water pressure is an area, not a single hit.** It is an environment, so every model in the deep water takes it, each separately, under the same per-model rule, with a save per model when the pressure allows one. Pooling it let one model's death soak damage meant for the rest.
- **Ongoing damage follows its source's shape.** Burning or bleeding from a single-target hit stays on the one model it was applied to, and that model dies when it runs out. Ongoing damage from an area (a lingering cloud, a burning field) ticks per model in the area, each with its own save if the effect has one.
- **An ongoing effect with a save uses the plain-5e save** (the total against the DC; a natural 1 or 20 means nothing), and legendary resistance is offered on it the same way as on every other save the engine rolls ([legendary-resistance.md](legendary-resistance.md)).

Before this, no tool could write ongoing damage at all, the two tick loops were silent, and both pressure and ticks took the whole amount off a unit's pool. With lane W's wounds ([units.md](units.md#wounds)) repeated damage now adds up: five pressure a round drowns a 9-HP man in two rounds.

## Writing ongoing damage

A condition carries it as `ongoing`, one effect or a list:

```
combat_manage add_condition {encounterId, participantId: 'grimgor', condition: {name: 'burning',
  ongoing: {damage: '1d6', damageType: 'fire', when: 'start', save: {ability: 'dex', dc: 15}}}}
  → Grimgor: +burning — ongoing: 1d6 fire at the start of its turn, DEX save DC 15 (none on a success) (single target)
```

| Field | |
| --- | --- |
| `damage` | Required. A whole number, or dice (`'1d6'`, `'2d4+1'`). Rolled once per tick on the fight's logged dice. |
| `damageType` | Resistances, immunities and vulnerabilities read it. |
| `when` | Required: `'start'` or `'end'` of the bearer's turn. |
| `save` | `{ability, dc, onSuccess?}`. `onSuccess`: `'none'` (the default: a success takes no damage that tick), `'half'`, or `'end'` (no damage, and the condition ends). |

The same key rides three roads:

- **`add_condition`**, with `area?: true` and `modelsInArea?` (below).
- **A save's riders**: `apply_damage {save: {onFail: {conditions: [{name, ongoing}]}}}`, and the same `onFail` / `onSuccess` on `use_ability` and `lair_action`.
- **`create`**: a participant's `conditions: [{name, ongoing}]`. The create road's old refusal of a raw `ongoingEffects` key stands.

A bad dice expression, a missing `when` or `damage`, or a save with no ability or DC is refused with the field named, and nothing is written. The reply carries `ongoing`, one line per effect (kept by `output_mode: 'summary'`), and the condition with its `ongoingEffects`, each carrying its `shape`.

On a character sheet outside a fight (`apply_damage` with no encounter) a rider writes the condition's name only, and the reply says its ongoing damage ticks only on a token in a fight.

## The shape

Every road stamps the effect's shape when it writes it:

| Road | Shape |
| --- | --- |
| `add_condition` with no `area` or `modelsInArea` | single |
| `add_condition {area: true}` on a packed unit | area: every live model |
| `add_condition {modelsInArea: n}` (or `{id: n}`) on a unit | area: n models (at most the models standing) |
| `add_condition {area: true}` on a spaced unit with no count | refused before anything is written, naming the key to add (`writes: 'none'`, `modelsInAreaNeeded`) |
| a rider from an area on a unit (`apply_damage {area}`, `use_ability {area}`, a lair action) | area: the models still standing inside |
| a rider from any other road, any rider on a creature that is not a unit, `create` | single |

A creature that is not a unit is one body, so the shape changes nothing for it (`add_condition {area}` on one says so in `notes`). A legacy effect with no shape counts as single.

## How a tick lands

| Bearer | What happens each tick |
| --- | --- |
| A creature | Its own save if the effect has one; a failure offers or spends legendary resistance; then resistances, then the HP. |
| A unit, single | The most wounded model takes it, capped at that model's HP: the model a single blow would finish. Its save is one model's, so it never spends the token's legendary resistance. When that model dies, the condition ends. |
| A unit, area | The models recorded inside (at most those standing), most wounded first. Each rolls its own save, and each takes the full damage, half, or nothing by its result and `onSuccess`. Resistances apply per model, then lane W lands it model by model: a model dies when the damage meets its current HP, otherwise it keeps the wound. The count drops by the models killed (and, with `onSuccess: 'end'`, by the models that saved). At 0 the condition ends. No model's save spends the token's legendary resistance. |

Model identity is not tracked. The most-wounded-first order stands in for it: a single-target burn lands on the most wounded model each turn, the same model while nothing else hurts the unit more.

Every tick is rolled once on the fight's logged dice (roll log purpose `ongoing <condition>`), and every save too (`ongoing <condition> save (dexterity)`, `… (model 3/6)` on a unit, `… (most wounded model)` on a single tick). It prints a turn note and a `turnDamage` row:

```
🔥 Orc — burning (start of turn): 3 fire, HP 15 → 12/15
🔥 Grimgor — burning (start of turn): DEX save d20 2 + 0 = 2 vs DC 15 (DEX +0) ✗ failed: 5 fire, HP 118 → 113/120 ⭐ LR 2/3 left, spend one? combat_manage legendary_resistance {encounterId: 'enc-1', participantId: 'grimgor', saveRef: 'ong-2-grimgor-1', reason: 'save vs burning'}
🔥 Militia — burning (start of turn): 6 fire on the most wounded model (one model at most: 6 → 5): 1 dead, 5/6 left; burning ends: the model it was on is dead
🔥 Militia — choking cloud (start of turn): 6 in the area: 3 failed, 3 saved; 4 / 0 vs 9 HP each: 0 dead, 6/6 left (3 unhurt, 3 at 5/9)
   Saves vs DC 12 (CON +0, drilled +1 = +1): 15✓ 4✗ 12✓ 3✗ 18✓ 9✗
```

A success with `onSuccess: 'end'` reads `✓ saved: no damage; burning ends`, and an area whose count dropped reads `; the area now covers 2`. A tick at the end of the turn reads `(end of turn)`. When a tick ends its condition, no end-of-turn save is rolled for it afterwards. A legacy healing effect still heals, with a note: `💚 Troll — regrowth (start of turn): regains 5, HP 40 → 45/90`.

## The save

It is the plain-5e save the engine rolls everywhere else: the total meets the DC or it does not. It reads what the save-ends save reads, through the handlers' provider: the sheet's ability modifier and save proficiency (a sheetless token: its own ability modifier), the saver's untagged `save:<ability>` mechanics, its conditions' 5e rules (restrained on a DEX save, exhaustion 3 or more) and a unit's drilled `unit.saves` bonus ([advantage.md, Engine saves](advantage.md#engine-saves)). A seeded fight replays every die, and a fight reloaded in another process rolls the same way: the provider is handed to the engine on every road that runs a turn.

## Legendary resistance on a tick

A creature's failed tick save follows the one rule ([legendary-resistance.md](legendary-resistance.md)):

- **`autoLegendaryResistance`**: one is spent, the save succeeds, the tick deals what a success deals: `✗ failed → 👑 legendary resistance (LR 2/3 left): no damage`. The sheet keeps the count.
- **Otherwise it is offered.** The damage lands, and the line ends with the call. The offer is of kind `'ongoing'`, with a `saveRef` (`'ong-<round>-<id>-<n>'`) and a `refund`: the HP the success would have saved (all of it, or the difference from half on a `'half'` save).
- **A player character** is asked, never spent for: `⭐ Kael failed with 3/3 legendary resistance left: ask the player. If they spend one: …`.

Answering it:

```
combat_manage legendary_resistance {encounterId, participantId: 'grimgor', saveRef: 'ong-2-grimgor-1', reason: 'save vs burning'}
  👑 Grimgor turns the failed save vs burning into a success (save vs burning): 5 HP back; LR 1/3 left
  → {success, remaining: 1, of: 3, saveRef, refunded: 5, hp: 118, mirroredToCharacter}
```

The refund is written to the sheet too, so the next call's sheet sync keeps it. A refund that lifts the creature off 0 HP wakes it (the dying Unconscious and Prone come off the token and the sheet). With `onSuccess: 'end'`, answering also ends the condition (`conditionEnded`). The offer lapses when the creature's next turn starts, as every offer does. A creature the tick killed is refused: its kill has run. Answering does not undo a concentration save the tick's full damage already broke: the spell stays ended, so restore it by hand if the success would have spared it.

## Water pressure

`environment.pressure` gains a damage type and a save:

```
combat_manage set_environment {encounterId, environment: {medium: 'water', depthFt: 300,
  pressure: {startsAtFt: 100, damagePerRound: 5, damageType: 'bludgeoning', save: {ability: 'con', dc: 12, half?: true}}}}
```

`half` defaults to true; `half: false` means a success takes none. A token tagged with `unlessTag` (else the swim tag) is spared, as before. It still fires at the start of each token's turn, on every road that starts one: `advance`, a surprised slot passed at `create` or `remove_participant` (the medium is known before the first slot passes), the turn a natural 20 starts at `death_save`, and a controlled mount's turn with its rider's.

- **On a unit**, every live model is in the deep water (the whole field is water, so a spaced unit needs no count). Each takes the damage separately, with its own save when the pressure has one, under lane W's wounds:

```
🌊 Militia — pressure at 300 ft: 6 in the deep water, no save: 3 vs 9 HP each: 0 dead, 6/6 left (6 at 6/9)
🌊 Militia — pressure at 300 ft: 6 in the deep water: 3 failed, 3 saved; 5 / 2 vs 9 HP each (wounded first: 3 at 5/9): 1 dead, 5/6 left (1 at 7/9, 2 at 4/9, 2 at 3/9)
   Saves vs DC 12 (CON +0, drilled +1 = +1): 20✓ 1✗ 20✓ 1✗ 20✓ 1✗
```

  Three pressure a round on 9-HP militia: 6/9 each after one round, 3/9 after two, all dead after three. The old pool lost one model about every third round.
- **On any other token** it is one save, with legendary resistance offered or spent as on a tick (kind `'ongoing'`, condition `water pressure`; the refund is half on a halving save). The old line stands for a plain tick:

```
🌊 Diver takes 5 pressure damage at 300 ft (60 → 55/60)
🌊 Grimgor takes 2 pressure damage (bludgeoning) at 300 ft (120 → 118/120) — CON save d20 15 + 0 = 15 vs DC 12 (CON +0) ✓ saved (half)
```

## What the reply carries

Every reply that runs a turn's start or end (`advance`, `create` when a surprised first slot passes, `remove_participant` when it brings the next slot up, and `death_save` when a natural 20 starts the creature's turn) carries:

- **`turnDamage`**, one row per tick: `{participantId, name, source: 'pressure' | 'ongoing', condition?, conditionId?, when, shape: 'single' | 'area', rolled, damageType?, damage, hpBefore, hpAfter, save?, unitArea?, unitCap?, modelsBefore?, modelsAfter?, modelsKilled?, modelsInArea?, wounds?, conditionEnded?, legendaryResisted?, legendaryOffer?, dying?, concentration?, line}`. For a creature `damage` is what the tick dealt after its save and resistances; for a unit it is the HP that left the pool.
- **`unitLines`**: each unit's line, with `; BREAK TEST DUE (morale 6)` on the tick that owes it.
- **`breakTests`**: a unit the ticks carried through its break point owes one, as any damage does. It is read from the unit's model count before its first tick, so two ticks that cross the line between them owe one test. The line prints too: `BREAK TEST DUE: Militia fell to 2/6 models (break at 50%): morale 6. Roll it; on a failure combat_manage set_unit {participantId: 'militia', routed: true}`.
- **`legendaryOffers`**, as for the save-ends save.
- **`killed`**: a tick that drops a tracked creature marks its sheet dying (Unconscious and Prone). A tick that kills one, by massive damage or a third failure at 0, runs the kill on the sheet with a corpse: `☠ Vex is dead (burning (massive damage))`. On `death_save` these are in `turnDamageKilled`.
- **Concentration.** A tick is damage, so a concentrating creature makes its CON save on the fight's dice, with its declared sides. A tick that drops it to 0 ends the spell. The row carries `concentration`, and the line reads `Concentration on Bless: CON save 2 vs DC 10 ✗ BROKEN`. The save rolls on the damage as it landed, before any legendary resistance offer is answered. Its die counts in the fight's stored dice position, so the next call, in this process or another, draws the next die.

`output_mode: 'summary'` keeps `turnDamage` (each row's scalar fields, its line up to 2000 characters, call included), `unitLines` and `legendaryOffers` whole.

## Not yet

- The state view (`get`) lists a condition by name. The shape and the area's count are on the condition in the encounter row, in `add_condition`'s reply and in each `turnDamage` row.
- A spell's or a world spell's condition effect writes the name only, with no ongoing damage. Auras (`aura_manage process`) still report damage without writing it.
- A `targetsWholeUnit` flag, for an effect on everyone in one unit that is not an area shape, is left for a later report ([units.md, World spells](units.md#world-spells)).
