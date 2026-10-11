# The fighter: styles, manoeuvres, rests

A 5e Battle Master is three things to the engine: a fighting style the sheet carries, a superiority die paid from a pool, and abilities that come back on a rest. All three live on the character sheet; a token made from the sheet inherits them. Nothing here is rolled in chat.

## Setting one up

```
character_manage update {characterId, fightingStyle: 'great_weapon', superiorityDie: '1d8', maneuverAbility: 'str',
  attacks: [{name: 'greatsword', attackBonus: 7, damage: '2d6+4', damageType: 'slashing', twoHanded: true, default: true},
            {name: 'longbow', attackBonus: 5, damage: '1d8+2', damageType: 'piercing', ranged: true}],
  abilities: [{name: 'Second Wind', perRest: 'short', actionCost: 'bonus'}, {name: 'Action Surge', grantsAction: true, perRest: 'short'}, {name: 'Indomitable', perRest: 'long'}]}
character_manage adjust_pool {characterId, pool: 'superiority', value: 4, max: 4, refresh: 'short'}
```

`maneuverAbility` is optional: unset, the save DC uses the higher of STR and DEX. Profiles need `ranged: true` on a bow and `twoHanded: true` on a great weapon; the engine reads the grid when `ranged` is unset (a shot from beyond the attacker's reach is ranged), else it treats the swing as melee.

## Fighting styles (`fightingStyle`)

| style | when | what the engine does |
| --- | --- | --- |
| `archery` | a ranged attack | +2 to hit (`roll.bonus` includes it) |
| `great_weapon` | a two-handed melee hit | weapon dice of 1 or 2 are rerolled once, crit dice included; `fightingStyle.rerolls` lists them and roll_log has a `damage reroll (great weapon fighting)` row |
| `dueling` | a one-handed melee hit (not `twoHanded`, not `hand: 'offhand'`, no weapon equipped in the offhand slot; a shield is fine) | +2 damage before resistance |
| `defense` | the target's style, while it wears equipped armour | +1 to a derived AC (token or sheet). Never on a `dc` the GM passed or an aimed part's own AC |

A posted `outcome` takes no style. The result's `fightingStyle {style, applied, note}` says when a style did not fit (`applied: false`) and why.

Great weapon fighting rerolls weapon dice only. A superiority die, a buff's dice and flat lanes are never rerolled (the 2024 ruling).

**Defense counts once.** The engine adds it at attack time when the AC it uses was derived from the sheet or token. If the sheet's `ac` already includes the +1, do not set `defense`, or pass `dc` on the swing.

`two_weapon` is not a style here: the engine never subtracted the off-hand modifier, so there is nothing for it to lift.

## Manoeuvres (`combat_action attack {maneuver}`)

The sheet needs `superiorityDie` and a `superiority` pool (`superiority_dice` and `superiority dice` are read too). A missing die or pool, an empty pool, a posted `outcome`, a volley or a cleave are refused before any die is rolled, with `writes: 'none'`.

| manoeuvre | the die goes to | the target | on a failed save |
| --- | --- | --- | --- |
| `trip` | damage on a hit | STR save | prone (a target above Large takes the die but stays up) |
| `menacing` | damage on a hit | WIS save | frightened of the attacker until the end of the attacker's next turn |
| `disarming` | damage on a hit | STR save | drops `maneuverItem` (else the first item in the part's `holds`); it lands as a prop at the target's feet and the sheet's parts follow |
| `precision` | the attack roll | — | — |
| `riposte` | damage on a hit | — | — |

Save DC = 8 + proficiency + the manoeuvre ability's modifier. The die is doubled on a crit like any damage die. A hit that drops the target rolls no save: the body is neither tripped, frightened nor disarmed by the engine (`maneuver.applied.note` says so; the GM narrates what falls with it), and the die is still spent.

**When the die is spent.** trip, menacing, disarming and riposte spend it when the attack hits; a miss costs nothing. precision spends it when it is rolled: the engine rolls it only on a miss the die could turn (missed by no more than the die's maximum) and never on a natural 1, then folds it into `roll.bonus` and `roll.total` so the banner still adds up (`maneuver.turnedHit`). A rolled precision die that still misses is spent.

**Riposte** is a reaction: pass `reaction: true`. It needs a melee miss by the target against you this round (the token remembers `lastMeleeMisses` for the round) and a melee weapon.

The pool debit lands on the pool's history with the reason (`superiority die (trip) vs Orc`); the result carries `maneuver {name, die, roll, spent, pool: {before, after}, dc?, save?, applied?}`; roll_log has `superiority die (<name>)` and `<name> save vs <attacker>` rows.

Prone and frightened land on the token, not the sheet, as spell debuffs do. The fright ends at the end of the attacker's next turn whether or not the attacker is still standing; if the attacker is down at the bearer's own turn start, it ends then.

## Rests

`rest_manage short` refills every pool with `refresh: 'short'` and readies every `perRest: 'short'` ability; `rest_manage long` does both policies and restores legendary resistances. `travel_manage rest` does the same per party member. A rest is refused while the character is a token in an active encounter row (`combat_manage end` first). Hit dice keep their label and history.

Spending in a fight reaches the sheet: `combat_manage use_ability`, `battle_cry` and `combat_action attack {actionSurge}` mark a `perRest` ability spent on the token and the sheet, so the next fight starts with it spent until a rest (`character_manage restore_ability` is the manual override). A spent sheet ability stays spent when a fight is created with the statline resent, unless the caller sets `ready: true` on it.

## The audit

```
session_manage rolls {encounterId, purpose: 'superiority'}
```

lists every superiority die of the fight; `character_manage get` shows the pool's history. `world_manage reconcile` does not flag a spent `perRest` ability between fights: that is the rule working.
