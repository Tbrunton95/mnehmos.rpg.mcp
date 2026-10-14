# Units under area damage: model by model

A unit token (`unit: {models, hpPerModel, packed}`) is one token for a squad. Its HP is the pool of its models. Each model keeps its own wounds in `unit.wounded` (see [Wounds](#wounds) below), and the engine reads the models standing from that list and the pool. Before play report 7, every area took one number off that pool. Damage then flowed from one model into the next, so 31 fire over six 9-HP militia read as three dead, not six. One d20 also decided the save for the whole unit.

The owner's rule (play report 7, #1): "Each model in the area rolls its own save, and the engine rolls them on the fight's logged dice. Nobody rolls by hand."

## How an area resolves on a unit

1. **Which models are inside.** A packed unit: every live model (a 15-ft cone over a packed knot is all of them). A spaced unit: only the models whose squares the template touches. The engine cannot see inside one token, so you give the count with `modelsInArea: {'<unit id>': n}` (or a bare number for every unit target). A spaced unit with no count is refused before anything is rolled or spent, and the reply names the key to add. A count on a packed unit wins over "every model" when the template only clips it. `combat_map aoe` prints a hint per unit (see below).
2. **Roll damage once**, as for any area.
3. **Roll one save per model inside**, each against the DC, on the fight's logged dice. The roll log purpose is `'<effect> save (model n/N)'`, logged for the unit's id. The bonus is the token's ability modifier (`abilityScores`; +0 when unset) plus the unit's drilled bonus `unit.saves: {dex: 2}`, and cover as for any target. Save proficiency on the token counts too.
4. **A failed save takes the full damage, a success half** (none when the effect says a save takes nothing). Resistances apply after the save, then the band scale, per model.
5. **Any model whose damage meets or beats its current HP dies.** The most wounded models are inside first (all of a packed unit; the first `modelsInArea` of a spaced one, most wounded first). A wounded model's HP is what it has left; an unhurt one has `hpPerModel`.
6. **A model that survives keeps the wound.** The pool loses what the models took: the dead models' HP and the survivors' wounds. A militiaman who saved half against a breath is already burned when the next blast comes. The models standing afterwards are exactly the models before less the dead, and the break test reads the real count.

**An area with no save** (rubble, a lair effect with no `savingThrow`) skips step 3. Every model inside takes the full damage.

The reply carries `targets[].unitArea` (`actionResult.unitAreas` on `cast_spell`) with `modelsBefore, modelsInArea, inAreaSource: 'packed' | 'given', failed, saved, noSave?, perModel {full, half}, modelsKilled, modelsAfter, hpLost, frontHp, woundedInside?, woundedFirst?, woundsAfter, saveBonus, saves[]` and one line:

```
🎯 Militia — 6 in the cone: 3 failed, 3 saved; 12 / 6 vs 9 HP each: 3 dead, 3/6 left (3 at 3/9)
   Saves vs DC 13 (DEX +1, drilled +2 = +3): 20✓ 4✗ 18✓ 7✗ 2✗ 15✓
   Damage: 45 fire off the pool (3 models dead)
   HP: 9/54 (3 alive: 3 at 3/9)
```

The line names the wounded inside before the area, `(front 5)` for one or `(wounded first: 3 at 3/9)` for more, and the wounded left after it, `3/6 left (3 at 3/9)`. `damageTaken` on a unit is the HP that left the pool (dead and wounded alike), not the rolled figure. The target carries `wounds`, the unit's compact wound line. The save's `onFail` / `onSuccess` riders follow the result most of the models still standing inside got (a tie counts as failed), since a unit is one token. The dead take no condition: a 12-point cone that kills the three that failed and spares the three that saved lays `onSuccess`, not `onFail`, and an area that leaves none of them standing lays neither.

A model's failed save never spends the token's legendary resistance. That belongs to one creature, not to each of many bodies, so one area cannot drain it.

Every model's save reads the unit token's declared sides, read once for the whole unit (play report 7, lane G1; [advantage.md, Engine saves](advantage.md#engine-saves)): an untagged `{advantage_on | disadvantage_on, value: 'save:<ability>'}` mechanic on the token's effects (by the unit's id), restrained on a DEX save, exhaustion 3 or more. Each model then rolls two dice (`saves[].rolls`), the saves line names the source (`Saves vs DC 13 (DEX +1 = +1; adv: Shield Drill (save:dex)): …`), the unit report and the target carry `advantageSources` / `disadvantageSources`, and the reply's `saveSources` row gives the models count. The roll log has one row per model with both dice: `Fire Breath save (model 3/6) (adv: Shield Drill (save:dex))`.

When the band rule's `damageScale` scales the area and the unit's band was assumed at create (play report 7 #3), the damage line says `(band assumed)`, as every band-dependent line does.

`output_mode: 'summary'` keeps each unit's line whole in `unitLines` on `apply_damage`, `use_ability`, `lair_action` and `cast_spell`, with a due break test named: `Militia — 6 in the cone: 3 failed, 3 saved; 12 / 6 vs 9 HP each: 3 dead, 3/6 left (3 at 3/9); BREAK TEST DUE (morale 6)`.

**At the table (Day 70).** 31 fire over six 9-HP militia: a failure takes 31 and a success 15, and both kill a 9-HP man, so all six die either way. Per-model saves change the outcome only when half the damage is below a model's HP. That is when the save actually matters: 12 over the same unit kills the ones that fail (12) and leaves the ones that save on 3 (they took 6). The next blast of 3 or more finishes them, saved or not.

## Which calls are areas

| Call | Area when | Otherwise |
| --- | --- | --- |
| `cast_spell` | the spell has an `areaOfEffect` (Burning Hands, Fireball, Lightning Bolt) | one model at most (Fire Bolt) |
| `cast_spell` of a world spell | its `table_rules` spell rule has `area: {shape, size}` (Foot of Gork, Green Puke, Plague) | one model at most (Warp Lightning, the Dreaded Thirteenth Spell) |
| `combat_manage lair_action` | always, unless `area: false` | one model at most |
| `combat_manage use_ability` | `area: true`, or `modelsInArea` given | one model at most (a recharge bite) |
| `combat_manage apply_damage` | `area: true`, or `modelsInArea` given | one model at most (an off-turn bite) |
| water pressure (`environment.pressure`) | always: every live model is in the deep water | — |
| a condition's ongoing damage | written from an area: `add_condition {area: true}` or `modelsInArea`, or a rider from an area on the unit | one model at most: the most wounded, tick after tick |

Damage to a unit that is not an area takes **one model at most**, as a single weapon blow already did: the most wounded model first, capped at its HP. Below that model's HP the blow wounds it. The reply says so in `unitCap {before, after}` (`unitCaps[]` on `cast_spell`) and on a line: `one model at most: 31 → 9` (`31 → 3` when the most wounded model has 3 left). A bite never wipes a packed unit, and no overflow crosses models. Volleys and `cleave: true` on a packed unit still flow through models as before.

## Wounds

The owner's rule (play report 7 follow-up): "Track each model's wounds." Without it, any repeated damage below a model's HP was harmless forever: five pressure a round never drowned a 9-HP man, and a cloud never choked anyone.

**What is stored.** `unit.wounded` holds the current HP of each wounded live model, each below `hpPerModel`, most wounded first. Unhurt models are not listed, so a 40-model unit with three wounded carries three numbers. The pool always agrees with the list: `hp = unhurt × hpPerModel + Σ wounded`, and the models standing are `unhurt + wounded.length`. The list lives in the participant on the encounter row, so a second process reads the same wounds. It is written only while a model is wounded.

**A legacy unit** (no list, or a list out of step with the pool because something wrote HP without going through the models) reads its pool the old way: full models, and a remainder below `hpPerModel` is one wounded model.

**How each road lands on the models:**

| Road | What the models take |
| --- | --- |
| An area (`area: true`, `modelsInArea`, an area spell, a lair action) | Each model inside, most wounded first, takes its own full or half damage. It dies when that meets its HP, else keeps the wound. |
| A single blow (an attack, a non-area `apply_damage` or `use_ability`, a single-target spell, `lair_action area: false`) | The most wounded model, capped at its HP: `one model at most: 31 → 3`. Below its HP, the blow wounds it. |
| A volley, `cleave: true`, a negative `adjust_hp` | Spreads with overflow: the most wounded model first, then the unhurt, killing in order. 10 over models on 2, 5, 9 and 9 kills the 2 and the 5 and leaves a 9 on 6. |
| Water pressure (play report 7 follow-up, lane O) | Every live model takes it, each separately, with its own save when the pressure has one. Wounds add up: 3 a round kills 9-HP models in the third round. |
| Ongoing damage, single target (the default) | The most wounded model takes each tick, capped at its HP; the condition ends when that model dies. |
| Ongoing damage from an area | The models recorded inside, most wounded first, each with its own save; the count drops by the dead, and the condition ends at 0. |
| Healing (`heal`, a healing spell, regeneration, a positive `adjust_hp`) | The most wounded model first, each up to `hpPerModel`. HP left over after every wound is healed revives models (`hpPerModel` each, the last one wounded), never past full strength. |

**The wound line.** Replies show the wounded compactly, never one entry per model: `4 alive: 2 unhurt, 1 at 5/9, 1 at 2/9`. Equal wounds are grouped, so a 40-model unit reads `40 alive: 37 unhurt, 2 at 5/9, 1 at 2/9`. It appears as:
- `wounds` on the state view's `unit` (`get`), which drops the raw list; the text view's 🪖 line ends `· 2 unhurt, 1 at 5/9, 1 at 2/9`;
- the `UNIT` line after an attack or volley, and every unit target of `apply_damage`, `use_ability` and `lair_action` (`targets[].wounds` and the `HP:` line);
- `wounds` on `adjust_hp` and `set_unit`.

**Readers.** The volley tier, mob rule (morale and to-hit), nearby-ally counts, the `combat_map aoe` hint, break tests and kill credit all count the models from the list. A break test and a kill count compare the models before a write with the models after it; the count before is read back through the writes the engine made in that call, since the pool alone cannot say how many wounded models it held.

**Setting wounds by hand.** `combat_manage set_unit {participantId, wounded: [5, 2]}` sets the wounded models' HP (stored most wounded first). The live count is kept and HP moves to match: six 9-HP models with `[5, 2]` stand at 43. `wounded: []` heals every wound; `wounded: null` drops the list, so the pool reads the old way. A value at or above `hpPerModel`, or more values than models standing, is refused with `writes: 'none'`. A new `hpPerModel` resets the list (the pool's own reading at the new size); a cut in `models` that leaves the list out of step resets it too; reinforcing keeps it, since the new models arrive unhurt.

**Bringing a wounded unit in.** `create` and `add_participant` take `unit.wounded` too, and the HP given must fit it: `hp = unhurt × hpPerModel + Σ wounded`, no more models than the unit has. A list that does not fit (`hp: 54` with `wounded: [5, 2]` on six 9-HP models) is refused with `writes: 'none'`, naming the HP that fits with every model standing (`hp: 43`); it is never stored and then silently read as the pool. A unit spawned from a bestiary statblock (`creature`) starts unhurt: the statblock is a template, as its parts start intact. The `set_unit` reply, like the state view, shows the wound line (`wounds`) and leaves the raw list on the encounter row.

## World spells

Damage resolves by its shape, not by the code path that delivered it (the owner's rule after play report 7). A world spell (`table_rules` kind spell) is an area when its rule says so, with the same shape an SRD spell's `areaOfEffect` has:

```
table_rules define {worldId, kind: 'spell', name: 'Foot of Gork', spec: {…, area: {shape: 'cylinder', size: 20}}}
```

`shape` is one of cone, cube, cylinder, line or sphere, and `size` is in feet. The shape names the area on the unit's line (`6 in the cylinder: …`). The size is for the GM: which models are inside comes from `modelsInArea`, or every live model of a packed unit.

- **An area world spell** resolves a damage effect aimed at its targets exactly as Fireball does. The damage is rolled once. Each model inside rolls its own save on the fight's dice, against the effect's `dc` or, when it has none, the casting total. The unit token rolls no save of its own. Deaths are counted per model, and the break test reads the real count. The reply carries `unitAreas`, the saves line, `unitLines` (kept whole in summary), and a `saveSources` row with the models count. A concentrating unit's CON save takes the HP the area cost.
- **A spaced unit needs a count.** Pass `cast_spell {…, modelsInArea: {id: n}}`. Without it the cast is refused before any cost is paid, the casting roll is rolled or the action is spent (`writes: 'none'`).
- **An unmarked world spell** hits one model at most, as a single blow does. The reply carries `unitCaps` and the line `one model at most: 11 → 9 (Warp Lightning is not an area: give its spell rule area: {shape, size} for an area)`. A `modelsInArea` given to it is noted and not used.
- **What stays one per token.** An effect aimed at the caster (`target: 'caster'`) is a single hit, so a unit caster takes one model at most. A condition effect is one save for the token, as on the SRD road: Plague's poison goes model by model, and its Plagued rider is one CON save for the unit.
- **No legendary resistance per model.** A model's failed save never spends the token's legendary resistance.
- **Kill credit.** World spells credit no growth kills, as `cast_spell` never did. The dead are counted in `modelsKilled`.

The presets follow the owner's call. Foot of Gork (a stomp, cylinder 20), Green Puke (a line, 30) and Plague (a cloud, sphere 20) are areas. Warp Lightning (a bolt with no save) and the Dreaded Thirteenth Spell stay single-target. The Thirteenth Spell changes everyone in one unit, which is not an area shape, so it is kept single-target for now; a `targetsWholeUnit` flag is left for a later report. The data migration `2026-10-14-world-spell-areas` adds the same `area` to rows of those three names that a world imported before, wherever the stored spec has no `area` key. A spec you already gave an area, or `area: null`, is yours and is left alone. So is a spell of one of those names in a world that holds no other spell of its preset: it is your own spell, not an import, and the migration's log line names it. A stored `area` the engine cannot read is dropped when the rule is read, so the spell reads as unmarked and keeps its other defaults; `define` refuses one outright.

## Water pressure

The owner: "water pressure is an area, not a single hit. It's an environment, so every model in the deep water takes it, each separately, under the same per-model rule (and with a save per model if the effect allows one). Pooling it lets one model's death soak damage meant for the rest." (play report 7 follow-up, lane O)

At the start of a unit's turn in a water fight at or below `pressure.startsAtFt`, every live model is in the deep water, so a spaced unit needs no count. The damage is rolled once. With `pressure.save: {ability, dc, half?}` each model rolls its own save on the fight's dice, with the token's ability modifier and its drilled bonus; a success halves it (none with `half: false`), and no model's save spends the token's legendary resistance. `pressure.damageType` lets resistances apply per model. Each model then keeps its wound or dies:

```
🌊 Militia — pressure at 300 ft: 6 in the deep water, no save: 3 vs 9 HP each: 0 dead, 6/6 left (6 at 6/9)
```

Three a round kills 9-HP militia in the third round. The pooled pressure lost one model about every third round, and 20 off a pool of 54 left four standing where per model it kills all six. A unit the pressure carries through its break point owes BREAK TEST DUE on the `advance` that dealt it (`breakTests`, and `unitLines` with the test named). Details and the reply in [ongoing-damage.md](ongoing-damage.md#water-pressure).

## Ongoing damage

Ongoing damage on a unit follows its source's shape (the owner: "Burning or bleeding from a single-target hit stays on the one model it was applied to, and that model dies when it runs out. Ongoing damage from an area (a lingering cloud, a burning field) ticks per model in the area, each with its own save if the effect has one.").

- **Single target** (the default; every legacy effect with no shape): the most wounded model takes each tick, capped at its HP, the model a single blow would finish. Below its HP the tick wounds it, so the next tick finds it hurt. When it dies, the condition ends: `burning ends: the model it was on is dead`. A save against a single tick is that model's save and never spends the token's legendary resistance.
- **An area**: `add_condition {participantId, area: true, condition: {name, ongoing}}` records every live model of a packed unit; `modelsInArea: n` records n (a spaced unit needs it, refused without). A save rider from an area on the unit records the models still standing inside. Each tick takes min(recorded, standing) models, most wounded first, each with its own save, landed model by model. The count drops by the dead (and, with `onSuccess: 'end'`, by the models that saved); at 0 the condition ends.

The write road, the save, legendary resistance on a creature's tick, and the reply are in [ongoing-damage.md](ongoing-damage.md).

## Reading the count off the map

`combat_map aoe {encounterId, shape, origin, …}` now tests every square of a token's footprint, not only its top-left square. A cone over the side of a large or huge token used to miss it. Each affected token reports `cellsInside / footprint`. A unit adds `unit {packed, liveModels, modelsInArea}`: a packed unit counts every live model; a spaced unit counts its share of the squares covered, at least one. The reply also prints the record ready to pass on: `modelsInArea: {'line': 2, 'militia': 6}`. It is a hint; you decide.

## Drilled troops

`unit.saves` takes `{str, dex, con, int, wis, cha}` (long names and any case are accepted, stored short) on `create`, `add_participant` or `combat_manage set_unit {participantId, saves}`. `set_unit` replaces the block and `saves: null` clears it. An unknown key is refused.

## Kill credit

`apply_damage {actorId}` credits the actor's growth track once per model the damage killed, whether or not the unit is wiped: `growth[].modelsKilled`, `delta = perKill × models`, reason `kill: 4 × Militia`. An attack that kills one model of a standing unit credits one kill. `use_ability`, `lair_action` and `cast_spell` credit no kills, as before.
