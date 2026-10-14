# Units under area damage: model by model

A unit token (`unit: {models, hpPerModel, packed}`) is one token for a squad. Its HP is the pool of its models, and the engine reads the models standing as `ceil(hp / hpPerModel)`. Before play report 7, every area took one number off that pool. Damage then flowed from one model into the next, so 31 fire over six 9-HP militia read as three dead, not six. One d20 also decided the save for the whole unit.

The owner's rule (play report 7, #1): "Each model in the area rolls its own save, and the engine rolls them on the fight's logged dice. Nobody rolls by hand."

## How an area resolves on a unit

1. **Which models are inside.** A packed unit: every live model (a 15-ft cone over a packed knot is all of them). A spaced unit: only the models whose squares the template touches. The engine cannot see inside one token, so you give the count with `modelsInArea: {'<unit id>': n}` (or a bare number for every unit target). A spaced unit with no count is refused before anything is rolled or spent, and the reply names the key to add. A count on a packed unit wins over "every model" when the template only clips it. `combat_map aoe` prints a hint per unit (see below).
2. **Roll damage once**, as for any area.
3. **Roll one save per model inside**, each against the DC, on the fight's logged dice. The roll log purpose is `'<effect> save (model n/N)'`, logged for the unit's id. The bonus is the token's ability modifier (`abilityScores`; +0 when unset) plus the unit's drilled bonus `unit.saves: {dex: 2}`, and cover as for any target. Save proficiency on the token counts too.
4. **A failed save takes the full damage, a success half** (none when the effect says a save takes nothing). Resistances apply after the save, then the band scale, per model.
5. **Any model whose damage meets or beats its HP dies.** The front model is inside first. It may already be wounded, in which case its HP is what it has left (`hp - (models - 1) × hpPerModel`). Every other model has `hpPerModel`.
6. **The pool loses the dead models' HP.** Survivors keep theirs: a wound below a model's HP is not tracked, as in the 5e troop rules. So the models standing afterwards are exactly the models before less the dead, and the break test reads the real count.

**An area with no save** (rubble, a lair effect with no `savingThrow`) skips step 3. Every model inside takes the full damage.

The reply carries `targets[].unitArea` (`actionResult.unitAreas` on `cast_spell`) with `modelsBefore, modelsInArea, inAreaSource: 'packed' | 'given', failed, saved, noSave?, perModel {full, half}, modelsKilled, modelsAfter, hpLost, frontHp, saveBonus, saves[]` and one line:

```
🎯 Militia — 6 in the cone: 4 failed, 2 saved; 31 / 15 vs 9 HP each: 6 dead, 0/6 left
   Saves vs DC 13 (DEX +1, drilled +2 = +3): 20✓ 4✗ 7✗ 18✓ 2✗ 9✗
   Damage: 54 fire off the pool (6 models)
```

`damageTaken` on a unit is the HP that left the pool, not the rolled figure. The save's `onFail` / `onSuccess` riders follow the result most of the models still standing inside got (a tie counts as failed), since a unit is one token. The dead take no condition: a 12-point cone that kills the three that failed and spares the three that saved lays `onSuccess`, not `onFail`, and an area that leaves none of them standing lays neither.

A model's failed save never spends the token's legendary resistance. That belongs to one creature, not to each of many bodies, so one area cannot drain it.

Every model's save reads the unit token's declared sides, read once for the whole unit (play report 7, lane G1; [advantage.md, Engine saves](advantage.md#engine-saves)): an untagged `{advantage_on | disadvantage_on, value: 'save:<ability>'}` mechanic on the token's effects (by the unit's id), restrained on a DEX save, exhaustion 3 or more. Each model then rolls two dice (`saves[].rolls`), the saves line names the source (`Saves vs DC 13 (DEX +1 = +1; adv: Shield Drill (save:dex)): …`), the unit report and the target carry `advantageSources` / `disadvantageSources`, and the reply's `saveSources` row gives the models count. The roll log has one row per model with both dice: `Fire Breath save (model 3/6) (adv: Shield Drill (save:dex))`.

When the band rule's `damageScale` scales the area and the unit's band was assumed at create (play report 7 #3), the damage line says `(band assumed)`, as every band-dependent line does.

`output_mode: 'summary'` keeps each unit's line whole in `unitLines` on `apply_damage`, `use_ability`, `lair_action` and `cast_spell`, with a due break test named: `Militia — 6 in the cone: 3 failed, 3 saved; 12 / 6 vs 9 HP each: 3 dead, 3/6 left; BREAK TEST DUE (morale 6)`.

**At the table (Day 70).** 31 fire over six 9-HP militia: a failure takes 31 and a success 15, and both kill a 9-HP man, so all six die either way. Per-model saves change the outcome only when half the damage is below a model's HP. That is when the save actually matters: 12 over the same unit kills the ones that fail (12) and spares the ones that save (6).

## Which calls are areas

| Call | Area when | Otherwise |
| --- | --- | --- |
| `cast_spell` | the spell has an `areaOfEffect` (Burning Hands, Fireball, Lightning Bolt) | one model at most (Fire Bolt) |
| `combat_manage lair_action` | always, unless `area: false` | one model at most |
| `combat_manage use_ability` | `area: true`, or `modelsInArea` given | one model at most (a recharge bite) |
| `combat_manage apply_damage` | `area: true`, or `modelsInArea` given | one model at most (an off-turn bite) |

Damage to a unit that is not an area takes **one model at most**, as a single weapon blow already did. The reply says so in `unitCap {before, after}` (`unitCaps[]` on `cast_spell`) and on a line: `one model at most: 31 → 9`. A bite never wipes a packed unit, and no overflow crosses models. Volleys and `cleave: true` on a packed unit still flow through models as before. World spells (`table_rules` kind spell) carry no area flag and still take their damage off the pool.

## Reading the count off the map

`combat_map aoe {encounterId, shape, origin, …}` now tests every square of a token's footprint, not only its top-left square. A cone over the side of a large or huge token used to miss it. Each affected token reports `cellsInside / footprint`. A unit adds `unit {packed, liveModels, modelsInArea}`: a packed unit counts every live model; a spaced unit counts its share of the squares covered, at least one. The reply also prints the record ready to pass on: `modelsInArea: {'line': 2, 'militia': 6}`. It is a hint; you decide.

## Drilled troops

`unit.saves` takes `{str, dex, con, int, wis, cha}` (long names and any case are accepted, stored short) on `create`, `add_participant` or `combat_manage set_unit {participantId, saves}`. `set_unit` replaces the block and `saves: null` clears it. An unknown key is refused.

## Kill credit

`apply_damage {actorId}` credits the actor's growth track once per model the damage killed, whether or not the unit is wiped: `growth[].modelsKilled`, `delta = perKill × models`, reason `kill: 4 × Militia`. An attack that kills one model of a standing unit credits one kill. `use_ability`, `lair_action` and `cast_spell` credit no kills, as before.
