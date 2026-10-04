# Skaven of the Horned Rat: a guide for the table

An Age of Sigmar Skaven rule set for the engine, built for a Grey Seer climbing toward Verminlord. Every name and number here is the table's own homebrew; the Age of Sigmar casting values ride as the spells' 2d6 targets. Change any of it with `table_rules define`.

## Load it

```
table_rules import {worldId, preset: 'skaven-horned-rat'}
```

This adds the following to the world:

- **Bands.** Clanrat, Stormvermin, Packmaster, Warlock Engineer, Grey Seer, Verminlord, Horned Rat, lowest first, as the rule `skaven-bands`. It carries `damageScale {perStepBelow: 0.5, perStepAbove: 1.25, floor: 0.25, cap: 2}`, so damage between banded tokens is scaled by the gap: a Clanrat's spear on a Grey Seer (four steps up) does a quarter; a Verminlord's Doomglaive on a Stormvermin (four steps down) does double. Spells, heals and executes are never scaled. Results carry `bandScale {steps, multiplier, before, after}`.
- **A lexicon.** Money reads as warp-tokens, the status block badge is `≈≈`, and a failed quest says "Yes-yes, it was never-never your plan anyway."
- **The favour family** (`pool_family` named `favour`) with three pools:
  - `horned_rat_favour`: the Great Horned One's attention. The Ascension track reads it.
  - `clan_standing`: the Seer's weight in the Clan.
  - `warpstone_taint`: the warpstone in the blood. The Warpstone Hunger ladder reads it.

  The first two are jealous of each other at a half: a gain of 4 favour costs 2 standing, and a gain of 4 standing costs 2 favour (`adjust_pool {family: 'favour'}` does this). Taint is outside the jealousy. Offerings are worth: `warpstone shard` 2, `slave` 1, `rival's tail` 5, `a Clan's secret` 3, `kill` 1 (`character_manage offer`).
- **Species, class, background.** `skaven` (+2 DEX, +1 INT, speed 30, Scurry Away, Darkvision, Strength in Numbers); `grey_seer` (d6, INT and WIS saves, Arcana / Deception / Religion, INT caster of the Lore of Ruin, no slots); `Council whelp` (Insight, Persuasion, 13 warp-tokens).
- **Four forms**, each a creature rule the Ascension track or the ladder names:

  | Form | CR | Size | HP | AC | Attacks | Band |
  | --- | --- | --- | --- | --- | --- | --- |
  | Grey Seer | 7 | medium | 60 | 14 | staff | Grey Seer |
  | Verminlord Warpseer | 18 | huge | 260 | 18 | Doomglaive, Tail (3 attacks), Scry-Orb (recharge 5-6), 3 legendary actions, 3 legendary resistances, lair actions | Verminlord |
  | Verminlord Deceiver | 18 | huge | 240 | 18 | Warpstiletto, Doomstar (ranged), Shrouded in Darkness, 3 / 3 legendary | Verminlord |
  | Rat-Thing | 1 | small | 30 | 12 | bite | Clanrat |

  The Verminlord Corruptor (CR 18, 280 HP, Plaguereapers, poison immune) is in the bestiary as a foe and can be taken as a form with `set_form` if the table wants it.
- **The bestiary.**

  | Creature | CR | HP | AC | Notes | Band |
  | --- | --- | --- | --- | --- | --- |
  | Boneripper | 11 | 180 | 15 | huge; 3 attacks; four arm parts with `holds`; `warpfire projector` part (system, 30 HP, breaks at 15); Warpfire Blast (recharge 5-6) | Packmaster |
  | Clanrat tide | 5 | 160 | 12 | unit: 40 models × 4 HP, packed, break test at half, morale 6, mob rule +1 morale per 10 models and +1 to hit per 20 | Clanrat |
  | Stormvermin block | 6 | 160 | 15 | unit: 20 × 8 HP, morale 8, mob rule per 10 | Stormvermin |
  | Rat Ogor | 5 | 70 | 14 | 2 attacks, Rabid Fury (recharge 6) | Packmaster |
  | Plague Monks | 5 | 100 | 11 | unit: 20 × 5 HP, breaks at a quarter, morale 10, poison immune | Clanrat |
  | Warp Lightning Cannon | 6 | 60 | 14 | parts `cannon` (system, 40 HP, breaks at 20) and `crew` (20 HP); 6d6 force ranged; Overcharge (recharge 4-6) | Warlock Engineer |
  | Rival Grey Seer | 7 | 60 | 14 | the Lore of Ruin, unbinds | Grey Seer |
  | Verminlord Corruptor | 18 | 280 | 17 | see above | Verminlord |

- **Four tables**, **nine spells** and **three principles**, below.

## The two ladders

Both are `growth_track` rules. A track feeds a pool and watches it cross steps.

### Ascension (`horned_rat_favour`)

+1 per kill, +1 more per band step the victim stands at or above the Seer (a Verminlord kill is worth +3 to a Grey Seer), +2 per victory (`party_manage after_battle {victory: true}`). Offerings and `adjust_pool` move it too.

| At | Step | How it lands |
| --- | --- | --- |
| 20 | condition **Grey Seer (ascendant)** | auto: on the sheet (and the live token) the moment the pool reaches 20 |
| 50 | form **Verminlord Warpseer** | offered: the result carries `growthReady {form, call}`; the player makes the `set_form` call or does not |
| 100 | form **Verminlord Deceiver** | offered |

A form that is offered is never taken by the engine. The Seer who stays a Seer at 50 keeps the offer open; a later crossing does not repeat it unless the pool falls below and climbs again.

### Warpstone Hunger (`warpstone_taint`)

Every rung is `auto`: the ladder is an addiction, not a choice. Taint climbs by the `(warpstone)` spell variants (+1 each), by a warpstone boost's side effect (+1), by the Warp Lightning Miscast table (+2 when the lightning earths), by the Horned Rat's Judgement and Mutation tables, and by `adjust_pool` when the Seer eats a shard at the table.

| At | Rung |
| --- | --- |
| 3 | condition **Twitching** (hands shake: disadvantage on Sleight of Hand and on holding concentration) |
| 6 | condition **Burning Eyes** (eyes glow green in the dark: Stealth at disadvantage against anyone who can see them) |
| 10 | roll the **Mutation** table for the Seer and apply what it says |
| 15 | form **Rat-Thing**: the warpstone has eaten the Seer |

Each rung fires once per character. The pool remembers it (`resourcePools.warpstone_taint.growthApplied: ['Warpstone Hunger@3', ...]`), so purging taint and relapsing does not twitch twice. The condition's `source` carries the rung and its effect text, so the status block and `get` say why it is there. To take a rung back, remove the condition by hand and, if the table wants it to be able to fire again, edit the pool's `growthApplied` with `character_manage update`.

Every path that moves a pool runs the check: `adjust_pool`, `offer`, kill and victory credit, roll_table writes, spell costs, and boosts. The result carries `growthApplied[]` (rungs that fired, each with its condition, table result or form) and `growthReady` (the highest offered step). A track may set `direction: 'down'` or `'both'` to fire on the way down as well (a withdrawal ladder); the preset's tracks fire upward.

## Running a tide

A Clanrat tide is one token: one initiative, one move, one action, a volley whose dice follow the models standing (4d6 at three quarters, 3d6 at half, 2d6 at a quarter, 1d6 below).

```
combat_manage add_participant {encounterId, creature: 'Clanrat tide', isEnemy: true, position: {x, y}}
combat_action volley {encounterId, actorId: <tide>, targetId}
```

- **Casualties come from HP.** 160 HP is 40 models at 4 each; `liveModels = ceil(hp / 4)`. Any damage, cleave included, moves the volley tier.
- **Mob rule.** +1 morale per 10 live models and +1 to hit per 20. Forty rats hit at +3 +2 and test at morale 6 +4; ten rats hit at +3 and test at 6 +1.
- **Break test.** Dropping through half the models (`breakAt: 0.5`) prints `BREAK TEST DUE` with the morale total. The GM rolls it; on a failure, `combat_manage set_unit {participantId, routed: true}`. A routed tide cannot volley and owes no more tests; `routed: false` rallies it.
- **Reinforce.** A second tide joins the first: `combat_manage set_unit {participantId, models: 50, reason: 'Clan Mors sends more'}`. The ten new models arrive at full HP each (+40 HP, maximum 200); the result carries `reinforced {modelsBefore, models, added, lost, hpPerModel, hpBefore, hp, maxHpBefore, maxHp, liveModels}`. Lowering `models` clamps HP to the new maximum; `hpPerModel` moves the maximum (models × hpPerModel) and clamps HP. Mob rule, morale and `breakAt` survive the change.
- **Band scale.** A tide (Clanrat) volleying a Grey Seer does a quarter damage under `damageScale` (four steps up, floored at 0.25); its volley against Stormvermin does half. A Verminlord's Tail through a tide does double, which is how a daemon wades through rats.

Stormvermin and Plague Monks run the same way: 20 models each, heavier per model, and Plague Monks only test at a quarter.

## Boneripper parts

The Boneripper is a `parts` statblock: four arms (each with `holds`, so an attack naming the weapon swings with that arm, and a crippled arm's attacks are at disadvantage) and a `warpfire projector` system part with its own HP.

```
combat_action attack {encounterId, actorId, targetId: <boneripper>, atPart: 'warpfire projector'}
```

- Aimed damage lands on the part (30 HP). At 0 it is crippled: no Warpfire Blast. One aimed hit of 15 or more breaks it outright (`breakAt: 15`, an integer damage threshold on parts, not a fraction). The GM then detonates it on the Boneripper (the note says 4d6 fire).
- `combat_manage set_part {participantId, part: 'upper right arm', state: 'crippled'}` cripples the arm that holds the crushing fist; the fist swings at disadvantage.
- Warpfire Blast is a limited ability with `recharge: 5`: it is spent with `combat_manage use_ability` and recharges on a 5-6 at the start of the Boneripper's turn.

The Warp Lightning Cannon works the same way with `cannon` (40 HP, breaks at 20) and `crew` (20 HP) parts.

## Casting: the Lore of Ruin

All nine spells are world spells: a 2d6 casting roll plus the Seer's INT modifier against the Age of Sigmar casting value, no slots, `contestedBy: 'unbind'` (a rival rolls the same 2d6 as `unbinderId`; higher stops it), and `miscast {on: 'double', table: 'Warp Lightning Miscast'}`.

| Spell | Target | Effect |
| --- | --- | --- |
| Warp Lightning | 5 | 2d6 force, 60 ft |
| Skitterleap | 6 | condition Skitterleaped, 1 round |
| Wither | 6 | condition Withered, 3 rounds, CON save |
| Death Frenzy | 7 | condition Death Frenzy on the target (a buff on a tide) , 3 rounds |
| Plague | 7 | 2d6 poison, CON save half, and Plagued (3 rounds, CON save) |
| Curse of the Horned Rat | 8 | condition Cursed by the Horned Rat, 3 rounds, WIS save |
| Dreaded Thirteenth Spell | 8 | 6d6 force, CON save half |
| Warp Lightning (warpstone) | 5 | +2 on the roll, 3d6 force; costs `warpstone -1, warpstone_taint +1` |
| Dreaded Thirteenth Spell (warpstone) | 8 | +2 on the roll, 8d6 force; costs `warpstone -1, warpstone_taint +1` |

```
combat_action cast_spell {encounterId, actorId, spellName: 'Warp Lightning', targetId}
combat_action cast_spell {encounterId, actorId, spellName: 'Dreaded Thirteenth Spell', targetId, unbinderId: <rival seer>}
```

### The warpstone boost

Any casting roll can be fed a token. The Seer needs a `warpstone` pool (`adjust_pool {pool: 'warpstone', value: 3, max: 13, show: true}`):

```
combat_action cast_spell {encounterId, actorId, spellName: 'Warp Lightning', targetId,
  boost: {pool: 'warpstone', delta: -1, modifier: 2, extraDice: '1d6', sideEffect: [{pool: 'warpstone_taint', delta: 1}]}}
```

- The spend is refused before anything is rolled or written when the pool cannot pay (`cannot pay the boost on Warp Lightning: warpstone 0 is short of 1`). `boost` needs `modifier` and/or `extraDice`.
- The modifier and the extra dice join the casting total; the banner shows `boost 1d6 (4) +4 boost +2`. The double and fumble checks read the 2d6 only.
- Side effects are paid with the boost, and every pool moved (the cost, the boost, the side effects) runs the growth check, so the taint that comes with the token can fire a rung in the same cast. The result carries `worldSpell.boost {pool, delta, modifier, extraDice, extraRolls, bonus, sideEffect}` and `worldSpell.growthApplied` / `growthReady`.
- The `(warpstone)` variants are the fixed-price version of the same thing: `cost` does the spend, the spell's own `modifier: 2` does the boost.

### The Warp Lightning Miscast table (2d6 + taint ÷ 3)

The table reads `modifierPool: 'warpstone_taint'` with `poolDivisor: 3`: at 9 taint the 2d6 is +3, so a tainted Seer miscasts worse.

| 2d6 | Result |
| --- | --- |
| 2-5 | Fizzles. Green sparks and burnt fur. |
| 6-9 | The warp lightning earths through the caster: 11 force written (2d10 if the GM prefers to roll it) and `warpstone_taint +2`. The HP write reaches the live token. |
| 10-12 | A Gnawhole opens: chain to the **Gnawhole** table (1-2 swallowed and spat out, Displaced and -5 HP; 3-4 something comes out of it; 5-6 it closes). |

The other tables: **Horned Rat's Judgement** (d20, self-applying: 1 devoured, a terminal kill; 2-5 Marked and taint +3; 6-10 indifference; 11-15 the Verminous Cunning gift; 16-19 the Horned Rat's Gaze gift (+1 AC) and favour +3; 20 Chosen and favour +10) is rolled by the table when the Seer calls on the god, `table_rules roll {worldId, name: "Horned Rat's Judgement", characterId}`; **Mutation** (d6: extra tail, Warpstone Eyes, Chitin (+1 AC gift), Crippled Hand, Warpstone Hunger (+1 taint), or a chain to the Judgement) is the ladder's rung at 10.

## Ascension steps in play

1. Give the Seer the pools once: `adjust_pool {pool: 'horned_rat_favour', value: 0, max: 200, show: true}`, `clan_standing` likewise, `warpstone_taint {value: 0, max: 100, show: true}`, `warpstone {value: 3, max: 13}`.
2. Kills in `combat_action` credit the Ascension track; the result's `growth` line says `GROWTH Ascension: horned_rat_favour 18 → 21; fired 20: Grey Seer (ascendant)`.
3. At 50 the result says `ready for Verminlord Warpseer: character_manage set_form {...}`. The player decides. `set_form` swaps the sheet (HP by `hpMode`, default keep the fraction), pushes the statblock to live tokens, and `set_form 'base'` puts it down.
4. The Horned Rat is jealous of the Clan: `offer {what: "rival's tail", to: 'horned_rat_favour'}` gives +5 favour and costs 2.5 standing (rounded). A Seer who wants both keeps two ledgers of favours owed, which is what the principles are for.

## Rival seers as agents

A rival Grey Seer is an NPC the table runs through `agent_manage`. Bind an agent to its character row; its prompt gets a **knowledge** slice built from `knowledge_manage`:

```
knowledge_manage record {worldId, key: 'shard-cache', statement: 'The warpstone cache is under the third gnawhole', secrecy: 'restricted', knowers: [{id: <namar>, how: 'witnessed'}]}
knowledge_manage learn {worldId, key: 'shard-cache', knowerId: <tesk>, how: 'told', fromId: <namar>, note: 'overheard at the Council'}
knowledge_manage record {worldId, key: 'council-sits', statement: 'The Council of Thirteen sits at the new moon', secrecy: 'common'}
agent_manage preview_prompt {agentId}
```

Tesk's system prompt then carries:

```
--- WHAT YOU KNOW ---
- [RESTRICTED] The warpstone cache is under the third gnawhole (told by Namar, overheard at the Council)
- The Council of Thirteen sits at the new moon (common knowledge)
State nothing beyond this on restricted or secret matters; if asked, deflect in character.
```

Namar's true name, a `secret` fact only Namar holds, never reaches Tesk's prompt, so Tesk cannot know Namar; a rival schemes on what it actually knows. The slice sits after the agent's private `secrets` and before `character_state`, and is skipped when the character holds no facts and the world has no common ones. In a fight, the rival casts through the same `cast_spell` with `unbinderId` against the player's spells.

## Principles (shown at boot)

- **Scheme.** Every Skaven has a plan that profits them at a rival's expense; the GM plays each NPC's plan, never a conscience.
- **Blame.** When a plan fails, a Skaven names a culprit before the dust settles; a failure costs `clan_standing` unless someone else is made to carry it.
- **Flee.** Running is not a failure. The Horned Rat rewards the survivor, not the martyr.
