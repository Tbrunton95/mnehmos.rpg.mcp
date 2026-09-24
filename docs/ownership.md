# Who owns each number

Every value has one owner, the place that is right when two disagree, and named sync points. Use this when a sheet and an encounter token seem to disagree.

| Value | Owner | Sync points |
|---|---|---|
| HP, max HP (characters) | The character sheet (`characters` row) | Before every combat action the token reads HP from the sheet; after it, the token's HP is written back. `character_manage update {hp}` mid-fight is picked up by the next action. `combat_manage adjust_hp` writes both. |
| HP (ad-hoc tokens, units) | The encounter token | None: there is no sheet. Unit casualties are derived from this HP. |
| Combat conditions | The encounter token | Tokens and sheets are separate. `add_condition` / `remove_condition` take `mirrorToCharacter`; `add_participant` takes `importRowConditions`. Token conditions expire by turn and save; sheet conditions never tick. |
| Lasting conditions (wounds, oaths, taints) | The character sheet | Edit with `character_manage update` (`addConditions`, `removeConditions`, `editConditions`). |
| Parts (crippled, dead, latched, breached) | The encounter token | `set_part` / `remove_part` with `mirrorToCharacter` write the sheet; a token joining a fight starts from the sheet's parts. Called strikes write both. |
| Band, regeneration | The character sheet | Copied onto the token when it joins a fight. |
| Intent, readied actions, unit flags | The encounter token | Never on the sheet. Intent clears when that creature's turn ends. |
| Pools (RESOLVE, CORRUPTION…), XP, level, inventory, currency | The character sheet | Not on tokens. |
| Dice | The roll log | Every roll is stored with a replay key (`session_manage rolls`). |
| Table rules | `table_rules` rows per world | Read at the moment an attack or check needs them. |

`character_manage get` lists `liveEncounters` when the character has a token in an active fight, with the token's HP, conditions and parts, so both sides of a sync are visible in one read.

Every tool call applies fully or not at all (a failed call leaves no writes), and `opId` makes retries safe. See the changelog (`session_manage changelog`).
