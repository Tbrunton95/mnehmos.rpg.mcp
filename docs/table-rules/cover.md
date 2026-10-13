# Cover: three sources, one best value, never a sum

5e cover, as the engine applies it (play report 5, #1). Half cover is +2, three-quarters +5, to AC against every attack roll and to a DEX save against an effect that starts on the far side of it. Total cover cannot be targeted directly. Cover never stacks: the single best source counts. Every result prints the arithmetic, so a disputed number can be read back from the reply:

```
AC 12 +5 (three-quarters, boulder) = 17
DEX save 10 +3 +2 (half, Grot (creature)) = 15 vs DC 13
refused: total cover (rubble crest) from fg-crossbows: Varek cannot be targeted directly. Nothing was rolled or spent.
```

## How the engine knows

In priority order, an explicit value always winning:

1. **Stated on the call.** `cover: 'none' | 'half' | 'three-quarters' | 'total'` on `combat_action attack`, `volley` and `cast_spell` (on a spell it is every named target's default, through `targetId` or `targetIds`; `coverByTarget: {id: kind}` overrides one). On `combat_manage apply_damage`, `use_ability`, `lair_action` and `trigger_readied` the key is `cover: {targetId: kind}` (a bare kind applies to every target). The prop spellings `three_quarter` and `full` are accepted. Pass `'none'` to override what the map would compute. Never fold cover into `dc` or `declaredModifiers` as well, or it counts twice.
2. **Standing cover on the token.** `combat_manage set_cover {encounterId, participantId, level, against?, reason?}`:
   - `against: ['fg-handguns', 'fg-crossbows']` protects against those attackers (ids or names, any case);
   - `against: {direction: 'west'}` protects against attackers to the west of the token, read from both positions (a cardinal takes the 90° arc about its axis; `northwest` the quadrant; `w`/`nw` shorthand works);
   - unset protects against everyone.
   It stays until `clear_cover`. The reason (`'rubble crest'`) is what every line and refusal prints. `attack {breaksCover: true}` (or a profile flagged `breaksCover`) drops the attacker's own standing cover for the rest of the round: a charge out of the rubble leaves the rubble behind. The state view shows `🛡 cover: three-quarters against fg-crossbows (rubble crest)` and `[broken this round]`.
3. **Computed from the map.** Along the line of fire between the two tokens' anchor squares (Bresenham), a prop placed with a cover rating (`combat_map place_prop {cover: 'half' | 'three_quarter' | 'full'}`) gives its rating, and any living creature standing on the line gives half cover, friend or foe. The prop's square is read as `place_prop` stored it: `'3,5'`, `'3, 5'` and `'3,5,0'` (an elevation) all stand on (3, 5). Neither token's own footprint counts. Adjacent squares have nothing between them. Terrain obstacles are not read: a wall that should block a shot is a prop with `cover: 'full'`.

Between standing and computed, the best single source wins (a GM who set half cover behind sandbags still gets three-quarters from the boulder in the way). The reply names the source and where it came from: `cover: {kind, acBonus, acBefore, acAfter, source, via: 'call' | 'standing' | 'computed'}`.

## Where it applies

| Roll | Where | What happens |
| --- | --- | --- |
| Attack rolls | `attack`, `volley`, `attack {legendaryCost}`, `attack {reaction: true}` (a PC's opportunity attack), NPC opportunity attacks during a move, readied attacks (`trigger_readied`, or fired by a move) | AC +2 / +5, printed in the breakdown; the roll compares against the raised AC |
| Spell attacks | `cast_spell` (Fire Bolt) | the target AC is raised the same way |
| DEX saves | `apply_damage {save: {ability: 'dex'}}`, `use_ability` and `lair_action` with a DEX `savingThrow`, `cast_spell` save spells (Fireball) | +2 / +5 on the save, printed; a STR or CON save takes nothing and the reply says `cover adds to DEX saves only` |
| Total cover | a targeted attack, or a spell that chooses its creatures (Fire Bolt, Hold Person, Bless: `targetType` creature or creatures), whether the target came through `targetId` or `targetIds` | refused with `writes: 'none'` before Help, an Action Surge, a manoeuvre die, a slot or ammo is spent: `refused: total cover (<source>) from <attacker>: <target> cannot be targeted directly` |
| Total cover | an area effect (`apply_damage`, `use_ability`, `lair_action`, a `cast_spell` AoE) | the target is skipped with `unaffected: total cover (<source>)`; the engine cannot judge whether the area got around the obstruction, so pass `cover: {id: 'none'}` (or `coverByTarget`) when it did |
| A posted outcome | `attack {outcome}` | no d20 is rolled, so the cover is reported as `ignored: 'posted outcome…'`; total still refuses |
| An NPC opportunity attack with no shot | a move past a reactor the mover has total cover against | skipped with a line; the reaction is kept, the move completes |

For area effects the engine reads map cover from the effect's origin: the breather for `use_ability`, the actor's token for `apply_damage {actorId}`. A lair action has no origin, so only a stated value applies. The sheet path (`apply_damage` with no encounter) has no map: only the stated value applies.

## Features that ignore cover

`ignoreCover: 'half-and-three-quarters' | 'all'` on an attack profile applies whenever that profile swings (`attack {using: 'sharpshooter rifle'}`); total cover still refuses unless `'all'`. On the sheet, `character_manage create/update {ignoreCover}` is a combat-profile field that rides onto the token: a bare value covers every attack, or scope it — `{ranged: 'half-and-three-quarters'}` is Sharpshooter, `{spells: 'half-and-three-quarters'}` is Spell Sniper, `melee` the third lane. The reply reports what was lifted: `cover: {kind: 'none', ignored: {kind: 'three-quarters', source: 'boulder', by: 'half-and-three-quarters'}}` and the line `Varek ignores three-quarters cover (boulder)`. A readied attack (`trigger_readied`) and an opportunity attack honour the same profile or sheet scope, with or without a stated cover.

## Hiding

You cannot hide from a creature that sees you clearly. The state view (`combat_manage get`) marks who a token could attempt a Hide from, and why, as a report, never a roll:

```
🫥 can hide from Grot (three-quarters cover (rubble crest)), Orc (darkness (Orc has no darkvision))
```

The reasons are standing or computed cover of three-quarters or better against that observer, a `heavily obscured` condition on the token, or `set_environment {environment: {light: 'darkness'}}` (it replaces the whole environment, so pass `medium` again in a water fight) against an observer without darkvision (`senses.darkvisionFt` on the token, or a `DARKVISION` condition). The JSON carries `canHide: [{from, reason}]`. The Stealth check is still the GM's call.

## Calls

```
combat_action attack {encounterId, actorId, targetId, cover: 'half'}
combat_action attack {encounterId, actorId, targetId, using: 'chainsword', breaksCover: true}
combat_action cast_spell {encounterId, actorId, spellName: 'Fireball', targetIds: ['grot', 'orc'], slotLevel: 3, coverByTarget: {grot: 'half', orc: 'none'}}
combat_manage set_cover {encounterId, participantId: 'varek', level: 'three-quarters', against: ['fg-handguns', 'fg-crossbows'], reason: 'rubble crest'}
combat_manage set_cover {encounterId, participantId: 'varek', level: 'half', against: {direction: 'west'}}
combat_manage clear_cover {encounterId, participantId: 'varek'}
combat_manage apply_damage {encounterId, targetIds: ['grot'], dice: '6d6', damageType: 'fire', source: 'frag grenade', save: {ability: 'dex', dc: 13}, cover: {grot: 'half'}}
combat_manage use_ability {encounterId, participantId: 'dragon', ability: 'Fire Breath', targetIds: [...], damage: '12d6', savingThrow: {ability: 'dex', dc: 18}, cover: {varek: 'none'}}
character_manage update {characterId, ignoreCover: {ranged: 'half-and-three-quarters'}}
```

## Riders on area saves (play report 5, #6)

`apply_damage.save.onFail` / `onSuccess` (and `savingThrow.onFail` / `onSuccess` on `use_ability` and `lair_action`) carry `{conditions: [...], mirrorToCharacter?}`. Each condition is a name (`'prone'`) or `{name, duration?, durationType?, source?, saveDC?, saveAbility?, level?}`; it lands on every target with that result, a same-type condition replaced rather than stacked, sourced to `'<effect> (failed save)'` or `'(saved)'` unless the entry names its own source. The token only by default; `mirrorToCharacter: true` writes the sheet too, and the sheet path (no encounter) always writes the row. Unknown names (`'Buried'`) are kept as custom conditions with no mechanics; pair them with `'restrained'` when the mechanics should apply. The reply carries `conditionsApplied` per target and a `Conditions:` line; a target behind total cover receives nothing.

```
combat_manage apply_damage {encounterId, targetIds: ['hero', 'grot'], dice: '4d10', damageType: 'bludgeoning', source: 'rockslide',
  save: {ability: 'dex', dc: 15, onFail: {conditions: ['prone', {name: 'Buried', source: 'rockslide'}], mirrorToCharacter: true}}}
```

A condition object with a typo key, or `durationType: 'save_ends'` without its DC and ability, is refused before any die is rolled (`writes: 'none'`).
