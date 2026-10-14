# Subdue orders and mounts

Two things play report 7 found the engine could not hold: a standing order to take an enemy alive, and a rider on a horse. Both are now token state the engine reads on every swing and every move, so the table never has to remember to apply them by hand.

## Subdue: "take them alive"

A token can carry a standing order, `subdue: true`. The order changes the swings the engine makes for the token without anyone choosing at that moment: its opportunity attacks during a move, and its readied attacks (fired by a move, or by hand with `trigger_readied`). An attack the GM calls directly is untouched; that one takes `attack {nonlethal: true}` as before.

```
combat_manage create {participants: [{id: 'gor', name: 'Gor', …, subdue: true}, …]}
combat_manage add_participant {encounterId, name: 'Grak', hp: 20, maxHp: 20, subdue: true}
combat_manage set_subdue {encounterId, participantId: 'gor', subdue: true, reason: 'Varek: alive'}
combat_manage set_subdue {encounterId, participantId: 'gor', subdue: false}
```

`set_subdue` is logged. The state view shows `🤲 subdue (take alive)` under the token and `subdue: true` in the JSON. The order is token state: it is not on the character sheet and does not carry to the next fight.

### What a melee swing does under the order

It is non-lethal, the play report 5 knockout. A target it drops to 0 HP is knocked out: Unconscious (sourced `nonlethal: <actor>`), stable, no death saves, no kill credit, no corpse. Healing above 0 wakes it. The knockout reaches the character sheet (the same Unconscious, the same source), and the reply prints:

```
💤 Bandit knocked out by Gor (stable; no death saves, no kill, no corpse). Healing above 0 wakes them
```

`opportunityAttacks[]`, `readiedTriggered[].attack` and `trigger_readied.attack` carry `knockedOut: {by, stable}` and `subdue: {mode: 'non-lethal', note}`. A blow that does not drop the target is an ordinary hit.

A player's token under the order is never rolled for. Its opportunity attack is offered with the non-lethal flag already in the call: `combat_action attack {…, reaction: true, nonlethal: true, ranged: false}` (the swing happened in reach, where the mover left it).

Two cases the order never touches:

- **A target already at 0 HP.** A subdued token does not strike it. The opportunity attack is skipped (`opportunityAttacksSkipped`, reason `subdue: … already down`), a readied attack holds, and the reaction is kept.
- **A unit.** A unit is a formation, not one body, so the order does not apply against it. The swing is lethal and says so: `subdue: n/a against a unit`.

Opportunity attacks are melee in 5e, so a bowman never takes one. The ranged case only arises with readied shots.

### A ranged readied shot is settled when it is readied

A shot cannot be non-lethal (5e: non-lethal blows are melee only), and a trigger fires with nobody choosing. So the conflict is settled at ready time. Readying a ranged attack (`attack.ranged: true`, or a profile with `ranged: true`) on a token under the order is refused, with nothing written, unless the readied attack says what the token does when the trigger comes up:

- `onSubdue: 'hold'`: the order wins. When the trigger fires the token holds fire: no shot, the reaction is not spent, and the readied shot stays armed. The reply says `held fire: subdue order; ranged can't be non-lethal`.
- `onSubdue: 'fire'`: the shot wins. It fires as an ordinary lethal attack, and the reply and the log say `subdue order overridden`. Use it for "take them alive, but if one runs for the horn, drop him".

```
combat_action ready {encounterId, actorId: 'grak', readiedAction: 'shoot the runner', trigger: 'he runs for the horn', on: 'enters_reach', attack: {using: 'crossbow', onSubdue: 'fire'}}
combat_manage set_intent {encounterId, participantId: 'grak', readied: {action, trigger, on, attack: {using: 'crossbow', onSubdue: 'hold'}}}
```

The refusal names both values and asks for one, so the GM chooses before anyone commits. For a player's token, the player chooses; the engine never decides for them. A melee readied swing needs no answer: it is non-lethal under the order (or lethal with `onSubdue: 'fire'`).

**An order that arrives after the ready.** Putting a subdue order on a token that already holds a ranged readied shot is flagged: the `set_subdue` reply carries `readiedNeedsOnSubdue` and the exact call. Until it is answered the trigger holds rather than fires, because holding cannot kill anyone by accident and firing can. A held trigger reports `awaitingOnSubdue: true` and the answer:

```
combat_manage set_subdue {encounterId, participantId: 'grak', onSubdue: 'hold' | 'fire'}
```

`set_subdue {onSubdue}` writes the answer onto the readied attack, where `ready` would have put it; on a token holding no readied attack (and with no `subdue` change) it is refused with nothing written. The answer can also ride on the firing call: `trigger_readied {participantId, targetId, attack: {onSubdue: 'fire'}}` fires the stored shot with its own weapon (an attack carrying only `onSubdue` answers for the stored one; it does not replace it). A readied action stored without an attack and fired by hand with a ranged one (`trigger_readied {attack: {using: 'crossbow'}}`) holds the same way until the call itself names `attack.onSubdue`. A shot whose profile does not say it is ranged, but which the grid reads as one when it fires (the target beyond reach), also holds until answered.

The engine does not invent half-measures such as "drops to 1 HP instead". 5e has no such rule. A ranged called strike at a runner's leg is a fair "take him alive" tactic at the table, but it can still kill, so it is fired with `onSubdue: 'fire'` and owned as a lethal shot.

The state view tags readied lines under the order: `(non-lethal)`, `(hold if ranged)`, `(subdue order overridden: fires to kill)`, or `(holds fire: subdue order, onSubdue unanswered)`.

### A readied attack says whether it is a shot: `attack.ranged`

A readied attack used to be ranged only through a named profile. `attack: {attackBonus: 5, damage: '1d8', ranged: true}` lost the flag, so the ready-time refusal never fired and the shot fell back to the grid when it went off. The readied attack now carries its own lane:

```
combat_action ready {encounterId, actorId: 'grak', readiedAction: 'shoot the runner', trigger: 'he runs for the horn', on: 'enters_reach', attack: {attackBonus: 5, damage: '1d8', ranged: true, onSubdue: 'hold'}}
combat_manage set_intent {encounterId, participantId: 'grak', readied: {action, trigger, on, attack: {using: 'spear', ranged: true, onSubdue: 'fire'}}}
combat_manage trigger_readied {encounterId, participantId: 'grak', targetId: 'runner', attack: {ranged: true}}
```

- **At ready time** the flag decides first, then the profile's: `ranged: true` under the order without `onSubdue` is refused with nothing written, exactly as a crossbow profile is. `ranged: false` on a crossbow profile is a melee swing (a crossbow butt), non-lethal under the order, and needs no answer.
- **When it fires** the flag decides first, then the profile, then the grid. A shot readied with `ranged: true` holds under the order even when the runner comes up adjacent, where the grid alone would call it a swing.
- **A flag that disagrees with its named profile wins and says so**: the `ready` and `set_intent` replies carry `rangedOverride {profile, profileRanged, ranged, note}` and the note in the message (`attack.ranged: true overrides the spear profile (not marked ranged): this readied attack is a ranged shot`); when it fires, the shot's breakdown and `situational` repeat it, its reaction line ends `; attack.ranged: true overrides the spear profile`, and a `trigger_readied` reply carries `rangedOverride` too.
- **It is stored** on the readied attack and survives a new process. The state view's readied line shows it: `⏳ readied: shoot the runner when he runs for the horn [ranged] (hold if ranged)`, `[melee]` for `ranged: false`, and `[ranged: overrides the spear profile]` when it disagrees.
- On `trigger_readied`, an attack carrying only `ranged` and/or `onSubdue` amends the stored shot (its weapon kept); any other key restates the attack, as before.
- **The refusal's call restates the whole attack.** Refused under the order, `ready` and `set_intent` name the call to paste with every key the attack carried and the answer to choose: `attack: {attackBonus: 5, damage: '1d8', ranged: true, onSubdue: 'hold' | 'fire'}` (a profile-named shot: `attack: {using: 'crossbow', onSubdue: 'hold' | 'fire'}`). A `trigger_readied` held because the attack passed on that call is ranged (restated, or `attack: {ranged: true}`) answers with that call again plus `onSubdue`, not `set_subdue`: `set_subdue` writes onto the stored shot only, which may not be ranged, and refuses when no attack is stored.
- **A key the readied attack does not take is named, never stored.** `attack: {attackBonus: 5, damage: '1d8', rnaged: true}` used to lose the misspelt key in silence, so under the order the ready went through as a swing. `ready`, `set_intent` (`readied.attack`) and `trigger_readied` now keep it past the tool boundary, leave it out of what they store or roll, and return it in `ignoredParams` (`attack.rnaged`, `readied.attack.rnaged`) with the nearest valid key in the message (`attack.rnaged — nearest valid key 'ranged'`); the rest of the call still applies.

## What each reaction did, in one line: `reactionLines`

The JSON rows of a move's reactions (`opportunityAttacks`, `opportunityAttacksAvailable`, `opportunityAttacksSkipped`, `readiedTriggered`) stay as they are. Under `output_mode: 'summary'` they shrink to id handles, so a knockout, a held shot, an override, a hit and its damage, or a rider struck used to survive only in the first 300 characters of `rawText`. Every reply that resolves reactions now carries a top-level `reactionLines: string[]`, one short, complete line per reaction, and summary keeps them whole (cut at 2000 characters, not 300, so a call in them still pastes):

```
⚡ Grak → Runner: OA hit 21 vs AC 12, 7 piercing, knocked out (subdue)
⚡ Grak → Runner: OA miss 9 vs AC 12
⚡ Orc → Kael (riding Warhorse; could strike the mount): OA hit 15 vs AC 16, 6 slashing (HP 24)
⚡ Kael may strike Runner (OA; the player decides; subdue order: non-lethal): combat_action attack {encounterId: '…', actorId: 'kael', targetId: 'runner', reaction: true, nonlethal: true, ranged: false}
⏸ Grak holds fire: subdue order; ranged can't be non-lethal (reaction kept)
⏸ Grak holds fire: subdue order; ranged can't be non-lethal (reaction kept); onSubdue unanswered: combat_manage set_subdue {encounterId: '…', participantId: 'grak', onSubdue: 'hold' | 'fire'}
⏸ Grak does not strike Runner: already down (subdue order; reaction kept)
⏳ Grak → Runner: readied hit 25 vs AC 12, 11 piercing, killed; subdue order overridden
⏳ Grak → Runner: readied hit 19 vs AC 12, 6 piercing (HP 44); attack.ranged: true overrides the spear profile
⏳ Grak's readied action triggers (shout the alarm): combat_manage trigger_readied {encounterId: '…', participantId: 'grak'}
```

The roads that carry them: `combat_action move` (a controlled mount's move carrying its rider included), `dash {targetPosition}` (the move it runs), and `combat_manage trigger_readied`. A miss on a natural 1 says `miss (nat 1)`, since its total can beat the AC.

## Mounts

```
combat_manage mount {encounterId, riderId: 'kael', mountId: 'warhorse', controlled?: true, free?: true}
combat_manage dismount {encounterId, riderId: 'kael', position?: {x, y}, free?: true}
```

A rider stands on its mount's anchor square while mounted. The link lives on the tokens: `mountedOn` on the rider, `riderId` and `controlledBy` on the mount. It persists with the encounter and shows in the state view as `🐎 riding Warhorse (controlled)` and `🐎 ridden by Kael`.

### Mounting and dismounting

Mounting is refused, with nothing written, when:

- the rider and the mount are the same token, or either is unknown;
- either is already linked, or either is a unit;
- the mount is not at least one size larger than the rider (5e);
- either is at 0 HP, the rider cannot act, or either is prone (stand up first);
- they are not within 5 ft of each other.

Mid-fight, mounting is movement on the rider's own turn and costs half its speed (5e). With less than that left it is refused: `needs 15 ft, 10 left`. `free: true` is for setting the scene (the rider starts the fight mounted): no movement, any turn.

Dismounting costs half the rider's speed on its own turn too, and puts the rider on a free square within 5 ft of the mount: the one named in `position`, else the nearest. A named square on the mount itself, further than 5 ft, or occupied is refused. `free: true` is a GM correction.

### Controlled and independent mounts

**Controlled** (the default, `controlled: true`). The mount moves on its rider's turn (5e: its initiative changes to match the rider's).

- `combat_action move {actorId: rider}` moves the mount, spending the mount's movement. The rider moves free and is carried along. A Dash by the mount (`dash {actorId: mount}`) widens the budget. The rider's own Dash does not: `dash {actorId: rider, targetPosition}` is refused with nothing spent and names the mount's Dash, and a plain `dash {actorId: rider}` stands with a note (its doubled movement counts once it dismounts).
- Mounting or dismounting mid-fight counts as the rider's turn taken, so the PC turn guard lets `advance` pass. A `free: true` mount is the GM setting the scene and does not.
- The mount's feet count toward the rider's own `movedThisTurn` / `movedSinceDash`, so a mounted charge meets an attack's `requires.movedAtLeast`.
- `move {actorId: mount}` works the same way.
- The mount's own slot passes on advance with a note: `🐎 Warhorse moves on Kael's turn (controlled mount): its own slot passes`. Its turn starts and ends with the rider's: movement, reaction, durations, regeneration. `remove_participant` of the actor that is up passes the slot the same way when the next one is a controlled mount.
- It may only Dash, Disengage or Dodge (and move). `attack`, `cast_spell`, `heal`, `help`, `ready`, `grapple` and `stabilize` from a controlled mount are refused with nothing spent, and so are a `use_ability` or `battle_cry` that costs its action or bonus action (a free one stands). A reaction (an opportunity attack) is not an action and stays allowed.

**Independent** (`controlled: false`). For an intelligent mount, or one that will not take orders. It keeps its own turn and moves itself (`move {actorId: mount}`), carrying the rider. The rider cannot move it: `move {actorId: rider}` is refused with "dismount first".

### Reactions against a rider and its mount

Opportunity attacks come from the mount's path, once per reactor. A reactor hostile to either the mount or its rider is provoked, so an enemy rider on a mount left without `isEnemy` still draws the swing. They strike the rider by default (a reactor hostile to the mount alone strikes the mount), from the mount square nearest the reactor, because the rider fills the mount's space. 5e lets the attacker choose rider or mount; the line says so (`could target the Warhorse instead`) and the GM can move the damage with `adjust_hp`. A player's reactor is offered the rider with `(or the mount: targetId …)`. Readied triggers are checked for both: one watching the rider (by id, name or `enemy`) strikes the rider, one watching the mount strikes the mount, and a reactor fires once.

A rider and its mount never block each other's movement, never stop each other's forced movement, and never give each other cover. A rider never takes an opportunity attack against its own mount.

### Falls

The DC 10 Dexterity save to stay mounted (5e) is rolled on the fight's logged dice:

- **The mount is moved against its will.** A shoved mount carries its rider, who saves.
- **The rider is knocked prone while mounted.** This covers a prone shove, a takedown or throw, a trip, or `add_condition prone`. On a success the rider keeps the saddle and is not prone.

An unconscious, stunned, paralysed or petrified rider fails outright. On a failure the rider is dismounted and lands prone on a free square within 5 ft of the mount.

The save reads the rider's own declared sides as every engine save does (play report 7, lane G1; [advantage.md, Engine saves](advantage.md#engine-saves)): an untagged `save:dex` mechanic (Danger Sense) rolls two dice and keeps the higher, restrained or exhaustion 3+ puts it at disadvantage, and both cancel. `mounts[].save` carries `rolls`, `advantageSources` / `disadvantageSources`, and the line names them: `DEX save d20=16+1 = 17 vs DC 10 — stays mounted [d20 3, 16; adv: Danger Sense (save:dex)]`. A tagged `save:dex` mechanic never fires here (the save asserts no tag); the line ends `conditional: Saddle Sense (mounted): …` and the row carries it in `conditional`, which `output_mode: 'summary'` keeps.

Without a save:

- **The mount drops to 0 HP, is knocked prone, or leaves the fight** (`remove_participant`). The rider is dismounted and lands prone. 5e lets it spend its reaction to land on its feet; the reply says so and the GM removes the prone.
- **The rider drops to 0 HP.** It falls.
- **The rider is shoved.** It is pushed off the mount.

A rider lands on the board: a fight with no grid of its own uses the default 0 to 100 board, the one a reloaded encounter reads, so the same fall lands on the same square in any process.

Every such event comes back in `mounts: [{riderId, mountId, cause, fell, prone?, at?, save?}]` with a line, and the reply's `participants` show the pair as they stand after the fall:

```
🐎 Kael falls from Warhorse (Warhorse moved against its will (forced movement)): DEX save d20=2+0 = 2 vs DC 10 — fails — prone at (8, 2)
🐎 Kael is thrown as Warhorse drops (0 HP): dismounted, prone at (0, 0).
```

### Known limits

- Reach and distance to a rider outside a reaction are measured from the rider's own square (the mount's anchor), so they are slightly short for a Large or bigger mount. Opportunity attacks and readied triggers during a move use the mount's whole footprint.
- Difficult terrain is not charged for anyone, mounted or not.
- Mounted-combat feats (Mounted Combatant) are not modelled; apply them as the GM.
