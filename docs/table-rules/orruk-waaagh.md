# Orruk Waaagh!: a guide for the table

A homebrew greenskin rule set for the engine, in the spirit of the Orruk warclans. Every name and number here is the table's own; change any of it with `table_rules define`.

## Load it

```
table_rules import {worldId, preset: 'orruk-waaagh'}
```

This adds the following to the world:

- **Gorkamorka**, a `pool_family` with the pools `gork` and `mork`. They are one god with two faces, so neither is jealous of the other. Offerings are worth: `kill` 1, `big kill` 3, `loot` 1.
- **A lexicon.** Money reads as teef, and the status block badge is `WAAAGH!`.
- **Two species.** Orruk (+2 STR, +1 CON, medium) and Grot (+2 DEX, small).
- **Four classes.**
  - Brute: d12 hit die.
  - Ardboy: d10.
  - Wurrgog Prophet: d8.
  - Weirdnob Shaman: d8.

  The two casters use world spells, so they need no slots.
- **Bands.** Grot, Boy, Brute, Boss and Warboss, lowest first.
  The rule is named `orruk-bands`. A world can hold it beside another band rule (day-366 brings `bands`). Where two bands are compared (growth per band above, peer consequences, called strikes, cleave, grapples and executions), the engine reads the first enabled band rule whose order holds both bands, so an Orruk fight uses the Orruk ladder. Two bands that share no ladder cannot be ranked: the per-band growth bonus is 0 and band checks treat them as unset.
- **Four creatures.** Each is a statblock to fight and also a form to grow into.

  | Creature | CR | Size | HP | AC | Attacks | Band |
  | --- | --- | --- | --- | --- | --- | --- |
  | Orruk Ardboy | 1 | medium | 22 | 15 | choppa | Boy |
  | Orruk Brute | 3 | medium | 52 | 16 | 2 attacks | Brute |
  | Orruk Megaboss | 8 | large | 136 | 18 | 3 attacks, Waaagh! (recharge 5) | Boss |
  | Great Warboss | 13 | huge | 230 | 19 | 3 attacks, Waaagh! (recharge 5), 3 legendary actions, 2 legendary resistances | Warboss |

- **The Getting Bigga growth track.** It uses the pool `growth`: +1 per kill, +1 more per band step the victim stands at or above the killer, and +2 per victory. Its steps are Orruk Brute at 10, Orruk Megaboss at 30 and Great Warboss at 60.
- **The Waaagh! Overload table** (2d6):
  - **2-4, Da Jolt.** The caster is Stunned for a round, on the sheet and on the token.
  - **5-9, Green Puke.** Allies within 10 ft take 1d6 acid. The GM applies this damage.
  - **10-12, Wot a Rush.** Nothing happens.
- **Three spells.**
  - **Foot of Gork.** Casting roll 2d6, target 7. It deals 4d6 bludgeoning, with a DEX save for half. On a double it rolls the Waaagh! Overload table. It gets +1 per 3 Orruks within 40 ft (maximum +4), and at +4 it overloads.
  - **Green Puke.** Target 6. It deals 2d6 acid, with a DEX save for half.
  - **Mighty Waaagh!** Target 8. It gives the caster +2 `waaagh`.
- **Three principles** that the boot packet shows.

## Making the heroes

A character starts as an Orruk of a class. Their size comes from a form, and the growth pool drives when they move up. Give every Orruk the pool once:

```
character_manage adjust_pool {characterId, pool: 'growth', value: 0, max: 100, show: true}
```

With `show: true`, the pool appears in the boot digest and on the status block.

### Grimgor (a Megaboss who is all fight)

```
character_manage create {worldId, name: 'Grimgor', race: 'Orruk', class: 'Brute', level: 8, stats: {...}}
character_manage adjust_pool {characterId, pool: 'growth', value: 30, max: 100, show: true}
character_manage set_form {characterId, form: 'Orruk Megaboss'}
```

The form gives Grimgor the Megaboss statline, including the `Waaagh!` ability with recharge 5. His own sheet stays in `form.base`, and `set_form {form: 'base'}` returns to it. He reaches Great Warboss at 60 growth.

### Wurrzag (a Wurrgog Prophet)

```
character_manage create {worldId, name: 'Wurrzag', race: 'Orruk', class: 'Wurrgog Prophet', level: 6, stats: {..., wis: 16}}
character_manage adjust_pool {characterId, pool: 'waaagh', value: 0, max: 10, show: true}
```

Wurrzag casts with `combat_action cast_spell {spellName: 'Foot of Gork', targetId}`. The more boyz stand around him, the higher his total. At +4 he also rolls on Waaagh! Overload. Mighty Waaagh! fills his `waaagh` pool, which is yours to spend in the fiction.

### Azhag (a warboss with a kunnin' streak)

```
character_manage create {worldId, name: 'Azhag', race: 'Orruk', class: 'Weirdnob Shaman', level: 10, stats: {...}}
character_manage adjust_pool {characterId, pool: 'growth', value: 60, max: 100, show: true}
character_manage set_form {characterId, form: 'Great Warboss'}
```

A shaman in a Warboss's body keeps his class and can still cast Green Puke and Mighty Waaagh!.

## In a fight

- **Mobs of boyz.**
  1. Bring them in with `combat_manage add_participant {encounterId, creature: 'Orruk Ardboy', count: 6, isEnemy: false}`. They carry `species: 'Orruk'`, so spells and battle cries count them.
  2. A mob as one token is a unit: pass `unit: {models: 10, hpPerModel: 22, morale: 5, mobRule: {per: 5, maxBonus: 3, attackBonusPer: 10}}`.
  3. Mob rule adds morale for every 5 boyz still standing. It shows on BREAK TEST DUE. It also adds +1 to hit per 10 boyz.
  4. Add `nearby: {range: 30, match: {species: 'Orruk'}}` to count other mobs close by.
- **The Waaagh! call.** On his turn, the boss calls:

  ```
  combat_manage battle_cry {encounterId, participantId, ability: 'Waaagh!', match: {species: 'Orruk'}, attackAdvantage: true, damageBonus: '1d4', speedBonus: 10, moraleBonus: 2}
  ```

  - Every Orruk within 60 ft, the boss included, attacks with advantage and adds 1d4 damage (rolled on the fight's dice). They also gain 10 ft of speed and +2 morale.
  - It lasts until the start of the boss's next turn. `rounds: 2` makes it last longer.
  - The ability is spent. It recharges on a 5 or 6 at the start of his turn, and a second call before then is refused.
  - `actionCost: 'bonus'` or `'action'` makes the call cost part of his turn.
- **Getting bigga.**
  - When an Orruk with a `growth` pool kills something, the attack reply shows a GROWTH line. The pool gains 1, 2 for a victim of his own band, and 3 for one a band bigger.
  - After the fight, `party_manage after_battle {partyId, victory: true}` gives every survivor +2.
  - When the pool crosses a step, the reply carries `growthReady` with the `set_form` call.
  - The engine never makes the call itself. Growing is the player's choice: offer it, and make the call when they say so.
