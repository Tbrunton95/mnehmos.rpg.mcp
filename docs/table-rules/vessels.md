# Vessels: the void-combat lane

A ship is a character row. Its hull is its HP, its sections are named parts
with a role, its weapons are attack profiles tied to the section that mounts
them, and its shields are a resource pool the engine drains before the hull.
Because it is a row, it persists across sessions like any sheet: a
battleship at 167/250 hull with a crippled drive stays that way until it is
repaired, and the next fight picks it up with `add_participant`.

Everything below is data a world defines (`table_rules` kind `vessel`) and
the engine enforces in `combat_action` and `combat_manage`.

## 1. Define a vessel rule

```json
{
  "action": "define", "worldId": "m42", "kind": "vessel", "name": "Gloriana",
  "spec": {
    "displayName": "Gloriana-class battleship",
    "hull": 400, "ac": 14,
    "shields": { "max": 60, "regenPerRound": 10 },
    "sections": [
      { "name": "Plasma drive", "hp": 80, "role": "drive" },
      { "name": "Lance battery", "hp": 60, "ac": 16, "role": "guns" },
      { "name": "Macro-cannon broadside", "hp": 70, "role": "guns" },
      { "name": "Command bridge", "hp": 50, "ac": 18, "role": "bridge" },
      { "name": "Reactor core", "hp": 90, "breakAt": 60, "role": "reactor" },
      { "name": "Launch bays", "hp": 40, "role": "hangar" }
    ],
    "weapons": [
      { "name": "Lance", "attackBonus": 8, "damage": "6d10", "damageType": "energy", "range": 60000, "section": "Lance battery" },
      { "name": "Broadside", "attackBonus": 6, "damage": "8d8", "damageType": "kinetic", "range": 30000, "section": "Macro-cannon broadside" }
    ],
    "speed": 6, "band": "Capital", "crew": 100000, "size": "colossal",
    "traits": ["Void shields", "Flagship"]
  }
}
```

| field | meaning |
|---|---|
| `hull` | hull points; becomes the row's HP and max HP |
| `ac` | the hull's AC; a section with its own `ac` is hit against that when aimed at |
| `shields.max`, `shields.regenPerRound` | the pool the engine drains first, and how much comes back at the start of the vessel's turn (default 0) |
| `sections[]` | `{name, hp, ac?, breakAt?, role}`; at least one. `role` is `drive`, `guns`, `bridge`, `reactor`, `hangar` or `other` (default `other`). `breakAt`: one aimed hit of that much severs the section outright |
| `weapons[]` | `{name, attackBonus, damage, damageType?, range?, section?}`. A weapon with a `range` fires as a ranged attack. `section` names the section that mounts it: its state applies to every shot |
| `speed` | feet (or hexes, as the table likes) per move; the token's movement speed |
| `band`, `crew`, `size`, `traits` | reference. `size` beyond the 5e categories (`colossal`) is stored as `gargantuan` with the label kept on the profile |

A weapon whose `section` names no section is refused at `create_vessel`, not
silently unmounted.

## 2. Lay a ship down: `character_manage create_vessel`

```json
{ "action": "create_vessel", "worldId": "m42", "vessel": "Gloriana", "name": "Macragge's Honour" }
```

Optional: `shields: {max, regenPerRound?}` overrides the rule's shields for
this hull; `characterType` (default `npc`, so no starting kit is provisioned).

The reply carries `characterId` and a manifest. The row:

- `hp`/`maxHp` = hull, `ac`, `band`, `race: 'vessel'`
- `parts` = the sections as kind `system`, state `intact`, with `role`, `hp`/`maxHp`, `ac`, `breakAt`
- `attacks` = the weapons, each with `part` = its section (the first is the default profile)
- `resourcePools.shields = {current: max, max}` when the rule (or the call) has shields
- `combat_profile.vessel = {regenPerRound, roles: {section: role}, speed?, crew?, sizeLabel?, traits?, networkId?}`

`combat_manage create` / `add_participant {characterId}` take it like any
character; the token hydrates `vessel`, `shields` and `movementSpeed` from
the row. Repairs between fights are ordinary sheet writes:
`character_manage update {parts: [...]}` or `combat_manage set_part
{state: 'intact', mirrorToCharacter: true}` during one; `adjust_pool
{pool: 'shields'}` for the shields.

## 3. Shields

Every point of incoming damage drains `shields.current` before the hull or
any section takes it: attacks, volleys, spells, `apply_damage`, lair and
ability damage all go through the same soak. The attack result reports
`shieldsAbsorbed` and `shields: {current, max}`; the banner shows
`[shields −60, 0/60 left]`. The row's `shields` pool follows the token
(and `adjust_pool` on the row is read back into the token at the next call).

At the start of the vessel's turn, `regenPerRound` comes back (capped at
max) and `advance` logs `shields regenerate 10 (25 → 35/60)`.

## 4. Sections and their roles

A section is a part of kind `system`. Hurt it like any part: aim at it
(`combat_action attack {atPart: 'Reactor core'}`), cripple it with a called
strike (`calledStrike` with a `called_strike` rule), or rule it directly
(`combat_manage set_part {part, state: 'crippled' | 'dead' | 'intact'}`).
A section with `hp` takes aimed damage instead of the hull and dies at 0; a
hit of `breakAt` or more severs it in one.

The engine reads the sections by role:

| role | crippled | dead |
|---|---|---|
| `drive` | speed 0 (adrift; `move` and `dash` refused) | speed 0 |
| `guns` | every weapon mounted on it is refused (`... (guns) is crippled: its weapons cannot fire`); other sections' weapons fire | same |
| `bridge` | the vessel's attack rolls are at disadvantage | same |
| `reactor` | nothing yet | `reactorBreach: true` on the token; at each of its turn starts a logged d6 (purpose `reactor breach`): a 1 destroys the vessel (hull 0, dead). `advance` logs the die either way. Repairing the section (`set_part state: intact`) contains the breach |
| `hangar`, `other` | reference for the GM (launch no fighters, lose a cargo hold) | same |

Several sections may share a role (two gun decks): the worst state of the
role counts for the bridge and the drive, and a weapon's own section
counts for the guns.

## 5. Called strikes at a section

`combat_action attack {actorId, targetId, using: 'Lance', atPart: 'Drive'}`
aims the shot. A section with its own `ac` is rolled against that AC. On a
hit, the shields soak first; what gets through lands on the section
(`partHit {name, damage, hpBefore, hpAfter, broken}`) and the hull is
untouched. With a `called_strike` rule, `calledStrike: 'Drive'` cripples the
section on a hit without the roll penalty, as for any part.

## 6. Boarding: `combat_manage board`

```json
{ "action": "board", "encounterId": "<void fight>", "attackerId": "<Gloriana token>", "targetId": "<Murder-class token>",
  "rooms": ["Torpedo breach", "Gun deck", "Bridge"], "name": "Honour boards Ruin" }
```

Both tokens must be vessels in the fight, and the target must still have
hull. The call opens a NEW encounter for the boarding party, linked to the
void fight by `encounters.parent_id`, and leaves the void fight running:

- the child's notes carry `boardingFrom {encounterId, attackerId, targetId}` and `rooms`;
- the parent's notes carry `boardings: [{childEncounterId, name, attackerId, targetId, rooms, status}]`;
- `rooms` defaults to the target's deck plan when it has one: the `room_nodes`
  of the spatial network whose id is `vessel.networkId`, else the vessel's
  character id (build one with `spatial_manage` and set `networkId` on the
  profile). Otherwise pass `rooms`, or none.

The child starts with no participants: add boarders and defenders with
`add_participant {encounterId: <child>, characterId | creature | name}` and
fight it as any encounter. `get` on the parent lists `boardings` (and
`boardingResults`); `get` on the child shows `parentEncounterId` and
`boardingFrom`.

`combat_manage end {encounterId: <child>, winner?, summary?}` ends the
boarding and appends `boardingResult {child, winner?, summary}` to the
parent's notes (the summary defaults to the survivors). Ending the parent
does not end its boardings.

## 7. Example: Gloriana vs Murder-class

```
table_rules define {worldId, kind: 'vessel', name: 'Gloriana', spec: …}         (above)
table_rules define {worldId, kind: 'vessel', name: 'Murder-class', spec: {hull: 220, ac: 15,
    sections: [{name: 'Drive', hp: 50, role: 'drive'}, {name: 'Guns', hp: 50, role: 'guns'},
               {name: 'Bridge', hp: 40, role: 'bridge'}, {name: 'Reactor', hp: 60, role: 'reactor'}],
    weapons: [{name: 'Lance', attackBonus: 6, damage: '4d10', damageType: 'energy', range: 40000, section: 'Guns'}],
    speed: 8, band: 'Cruiser'}}
character_manage create_vessel {worldId, vessel: 'Gloriana', name: "Macragge's Honour"}   → G
character_manage create_vessel {worldId, vessel: 'Murder-class', name: 'Blade of Ruin'}   → M
combat_manage create {worldId, participants: [{id: G, …}, {id: M, …, isEnemy: true}]}      → E

combat_action attack {E, actorId: M, targetId: G, using: 'Lance'}
    HIT 38 → shields absorb 38 (shields 22/60); hull untouched
combat_action attack {E, actorId: G, targetId: M, using: 'Broadside', atPart: 'Drive'}
    HIT 27 → Drive 50 → 23 (body untouched)
combat_manage advance ×2
    ♻️ Macragge's Honour: shields regenerate 10 (22 → 32/60)
combat_action attack {E, actorId: G, targetId: M, using: 'Lance', calledStrike: 'Drive'}
    RULE called_strike: Blade of Ruin's Drive crippled → speed 0, adrift
combat_action attack {E, actorId: G, targetId: M, using: 'Broadside', atPart: 'Reactor'}
    … Reactor dies → reactorBreach; each of its turns: ♻️ Blade of Ruin: reactor breach holds (d6=4, a 1 destroys it)
combat_manage board {E, attackerId: G, targetId: M, rooms: ['Torpedo breach', 'Gun deck', 'Bridge']}
    → child B, linked to E
combat_manage add_participant {B, characterId: <Terminator sergeant>} … fight the decks …
combat_manage end {B, winner: 'attackers', summary: 'the bridge is taken; the reactor is scuttled'}
    → E notes: boardingResult {child: B, winner: 'attackers', summary}
```
