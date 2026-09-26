# GM Handover: RPG Engine

You run the 40k campaign through the rpg-mcp engine: start every session with `session_manage boot`, post every table roll with `outcome`, and put an `opId` on every write. The campaign's state lives in the engine, so this handover teaches the engine, not the story. The standing instructions to paste into your project are in `day-366-gm-brief.md`, beside this file.

## How it works

The engine is the campaign's memory and its referee: you describe, it checks the numbers. Characters, HP, conditions, body parts, clocks, debts, secrets, rulings and every dice roll live in its database. Nothing important should live only in your head or the chat.

- **The engine decides:** hit or miss against AC, damage and resistances, when a consequence is due, a prepared weapon's tier, a unit's volley dice, who can know a secret.
- **You decide:** what a consequence looks like, what enemies intend, what NPCs say and want, and every ruling the rules don't cover.
- **The player decides:** what Luciel does. Never narrate his choices, thoughts or words.

The table rules (the Day 366 reset) are loaded into the world. Most are enforced by the engine. The rest are principles it shows you at the start of each session, for you to play by. When the engine refuses something, it is applying a rule, not failing. Say so in the fiction and play on.

## Your first session

1. **Check the connection.** Confirm the rpg-mcp tools are available and include `table_rules`, `precedent_manage` and `knowledge_manage`. If they don't, the app is running an old engine; stop and tell the player.
2. **Find the world.** `world_manage list`, then ask the player which world is the 40k campaign. Keep its `worldId`: almost every call needs it.
3. **Read the boot packet.** `session_manage boot {worldId}`. Read all of it: what's new in the engine, the table rules and principles, each character's digest, clocks and debts coming due, open threads, live enemy intents, the last journal entries and recent rulings.
4. **One-time setup (skip it if the boot packet already lists table rules):**
    1. `table_rules import {worldId, preset: 'day-366'}`
    2. `character_manage list {worldId}`. Tag any 40k character missing from it with `character_manage update {characterId, worldId}`.
    3. Propose a band for each named combatant (Mortal, Elite Mortal, Astartes, Astartes Elite, Monster/Lord, Primarch-class) in a table. Since his apotheosis Luciel is Monster/Lord, and Greater Daemons and other Princes are his peers; keep Primarch-class for the likes of Angron. A peer is the same band or higher, so only a peer's hits flag CONSEQUENCE DUE and only a peer can be struck at a joint. Put raw strength in the numbers, not the band. Wait for the player to confirm, then write them with `character_manage update {characterId, band}`.
    4. Ask which pool the tiny status block shows, then `table_rules define {worldId, kind: 'status_block', name: 'tiny-status', spec: {corePool: '<pool>'}}`. A warning in the reply means no character carries that pool.
    5. The import also sets the world's lexicon: money reads as Thrones and the status block header as `+++`. Change either with `table_rules define {worldId, kind: 'lexicon', name: 'lexicon', spec: {currency, badge}}`.
    6. The preset's `character-fantasy` principle still calls Luciel Astartes-scale. Rewrite it for the world with `table_rules define {worldId, kind: 'principle', name: 'character-fantasy', spec: {text}}`, in words the player approves.
5. **Pick up where the story left off.** The journal entries and open threads in the boot packet are the recap. Open with a short "previously", then the scene.

Every later session is step 3, then play.

## One turn, start to finish

Luciel fights An'ggrath (Monster/Lord) on the mountain. Every fight follows this pattern.

1. **Telegraph the enemy's intent** before the player acts:
   `combat_manage set_intent {encounterId, participantId: 'angrath', intent: 'closes the thirty metres and goes for the wing'}`. It clears when An'ggrath's own turn ends.
2. **Resolve the player's declaration.** A strike at the joint of An'ggrath's sword arm is a called strike on a peer:
   `combat_action attack {encounterId, actorId: 'luciel', targetId: 'angrath', atPart: 'sword arm', calledStrike: 'arm', attackBonus: 14, damage: '3d10+9', opId: 'r4-luciel-joint'}`.
   If the table rolled physical dice, post the result instead: `outcome: 'hit'` (or `'crit'` / `'miss'`) with `damage: 27`. Never inflate `attackBonus` to force a hit.
3. **Read the lines under the result.** `RULE ... crippled until repaired` is already applied. `CONSEQUENCE DUE ...` asks you to name one (`from above` means a higher band maimed a lower one; a killing blow and a hit on a unit never flag): pick what the fiction earns from where the blow landed, then record it with `combat_manage set_part {encounterId, participantId: 'angrath', part: 'breastplate', state: 'breached', opId: 'r4-consequence'}`.
4. **Record any ruling:** `precedent_manage record {worldId, kind: 'ruling', statement: 'A crippled daemon limb drops what it holds', scope: 'called strikes'}`.
5. **Record who learned something:** `knowledge_manage record {worldId, key: 'angrath-wounded', statement: "Luciel crippled An'ggrath's sword arm", knowers: [{id: 'inquisitor', how: 'witnessed', day: 367}]}`.
6. **Advance the turn:** `combat_manage advance {encounterId, opId: 'r4-advance'}`.

When several steps must land together, send them as one `batch_manage execute_sequence {atomic: true, steps}`. If any step fails, none apply. A step with an array param (a precedent's `tags`, a knowledge record's `knowers`) is refused inside a batch, so make those calls directly.

## Never do these

- **Never fake a result with a huge `attackBonus`.** Post it with `outcome`.
- **Never pass `seed` to a roll.** A fixed seed replays identical dice.
- **Never retry a timed-out write with a new `opId` or none.** Retry with the same `opId`, or check `session_manage op_status {forOpId}`.
- **Never fix HP by healing or damaging.** Use `combat_manage adjust_hp {value | delta, reason}`.
- **Never remove and re-add a condition to change its text.** Use `editConditions`, or `feature_from_condition`.
- **Never let an NPC state a fact without a road to it.** Ask `knowledge_manage can_know` first.
- **Never rule on something twice from memory.** `precedent_manage search` first.
- **Never batch a call that carries an array.** Precedents with `tags` and knowledge records with `knowers` go as direct calls; inside `batch_manage` they are refused, and an atomic batch then undoes its earlier steps.
- **Never narrate Luciel's choices, thoughts or words.**
- **Never work around a refusal.** It is a rule; say so in the fiction.
- **Never read whole sheets when you need two numbers.** Add `fields: ['hp', 'conditions']` or `output_mode: 'summary'`.

## Quick reference

| Moment | Call |
| --- | --- |
| Session start | `session_manage boot {worldId}` |
| The table rolled dice | `combat_action attack {..., outcome, damage}` |
| Strike at a joint of a peer | add `calledStrike: 'leg' \| 'arm' \| '<any part it has>'` and `atPart` |
| Swing a named attack | add `using: 'grown blade'` (or `weapon`); it fills bonus, damage, type and the part that swings |
| Say what a part wields | `combat_manage set_part {part, state, holds: ['whip']}` |
| Armour a chain, shield or plate | `combat_manage set_part {part, state, ac, hp? \| breakAt?}`, then attack with `atPart`: it hits the part, not the body; a break severs it |
| Prepared weapon fires on its trigger | add `preparedAsset: 'prepared-anti-armour'` |
| A head, limb or plate changes state | `combat_manage set_part {part, state}` |
| A monster's full statline | `combat_manage create` / `add_participant` with `size`, `reach`, `attacksPerAction`, `attacks`, `abilities`, `legendaryActions`, `legendaryResistances`, `hasLairActions`, `cr` |
| Save a monster to the world's bestiary | `table_rules define {worldId, kind: 'creature', name, spec}` (or `fromToken {encounterId, participantId}` / `fromCharacterId`) |
| Roll a house table (omens, the Eye of the Gods) | `table_rules roll {worldId, name, characterId?, modifier?}` on a `roll_table` rule; the entry's `chain` rolls the next table |
| Move a god's favour (jealousy applies) | `character_manage adjust_pool {characterId, pool, delta, family, reason}` on a `pool_family` rule; returns `rivals[]` |
| Transform a character (daemonhood, spawndom) | `character_manage set_form {characterId, form, hpMode?}`; `form: 'base'` reverts |
| Roll the Eye of the Gods and apply it | `table_rules roll {worldId, name, characterId}` on entries with `apply` (gift, condition, writes, form, terminal kill); `apply: false` previews |
| Make an offering to a god | `character_manage offer {characterId, family, pool, offering: item \| kill \| deed, itemId?, quantity?, victimId?, deed?, value?, answerTable?}` |
| Found or run a cult | `congregation_manage create {worldId, name, god, founderId, size, zeal?, family?}`; `tend`, `strike {losses?, zealDelta?}`, `purge`; `process_weekly {worldId}` when advance shows `dueNow.congregations` |
| Realmgate, toll bridge, portcullis | `spatial_manage gate_create {name, fromRoomId, toRoomId, direction, travelHours?, toll?: {gold}, holder?}`; `traverse {gateId, characterId, advanceClock?}`; `set_gate {gateId, status: open \| closed, holder?}`; `gate_list {worldId?, roomId?}` |
| A Waaagh! (battle cry) | `combat_manage battle_cry {participantId, ability?: 'Waaagh!', match?: {species: 'Orruk'}, range?: 60, rounds?: 1, attackAdvantage?, damageBonus?, speedBonus?, moraleBonus?, actionCost?}`; lasts until the start of the caller's next turn |
| A mob that grows braver with numbers | `combat_manage set_unit {participantId, mobRule: {per, maxBonus?, attackBonusPer?, nearby?: {range, match}}}` |
| An Orruk gets bigga | kills and after_battle victories feed the growth pool; when a reply shows `growthReady`, offer its `call` (`character_manage set_form`) to the player |
| Run a warband | `party_manage muster {partyId}`; `pay {partyId, payerId?, amount?}`; `after_battle {partyId, victory, casualties?: [{characterId, models?, dead?}], recruits?}`; members take `loyalty`, `wage`, `payMode`, `unitModels` |
| A world's own class, species, background, skill | `table_rules define {kind: char_class \| species \| background \| skill, name, spec}`; `character_manage create` reads them first; `options {worldId}`; `casting: {as: 'wizard'}` casts SRD spells as a wizard |
| Levels past 20, a custom XP table or curve | `table_rules define {kind: progression, spec: {maxLevel: null \| N, xpThresholds?, profBonus?, mode?}}` |
| A world's own spell (warp, winds of magic) | `table_rules define {kind: spell, spec: {castingRoll: {target}, cost?, effects, miscast?: {on, table}, contestedBy?: 'unbind'}}`; `combat_action cast_spell {spellName, targetId, unbinderId?}` |
| A unit breaks and runs | watch for BREAK TEST DUE; `combat_manage set_unit {participantId, routed: true}` on a failed test (`morale`, `breakAt` set there too; `routed: false` rallies) |
| Loot a body | `corpse_manage generate_loot {corpseId, creatureType}` (logged; `seed` replays) |
| Spawn from the bestiary | `combat_manage spawn_quick_enemy {creature, count, worldId}` or `add_participant {encounterId, creature, count}` |
| A recurring monster's statline, once | `character_manage update {characterId, ...}` with the same fields; tokens joined by id start with it |
| Multiattack | `attacksPerAction: N` on the statline, then one `combat_action attack` per swing (`attack 1/2`, `2/2`) |
| A legendary action off its turn | attack with `legendaryCost: N`; otherwise `combat_manage legendary_action {participantId, cost?, description}` |
| Breath weapon or other limited ability | `combat_manage use_ability {participantId, ability, targetIds, damage: '12d6', damageType, savingThrow: {ability, dc}}`; recharge rolls itself at its turn start |
| Lair action | `combat_manage lair_action {actionDescription, targetIds?, damage?: number \| dice, savingThrow?}` on the LAIR slot, once per round |
| How hard is this fight? | `combat_manage budget {partyLevels \| partyId, creatures: [{creature, count}] \| encounterId}` (read-only) |
| Spend a legendary resistance by hand | `combat_manage legendary_resistance {participantId, reason}` |
| Opportunity attack or readied swing | NPC opportunity attacks roll on the move; a PC's comes back in `opportunityAttacksAvailable` with the call to make (`reaction: true` on the attack) |
| Ready an attack that fires itself | `combat_action ready {readiedAction, trigger, on: 'enters_reach' \| 'leaves_reach', watch, attack: {using?}}`; free-text readied actions fire with `combat_manage trigger_readied {participantId, targetId?}` (spends the reaction, rolls a stored attack) |
| Grab, pin, throw or finish unarmed | `combat_action grapple {encounterId, actorId, targetId, move}` (one attack; band and size disadvantage are automatic); `control: true` pins; `move: 'execute'` finishes a pinned lower-band foe; `move: 'break'` escapes the holder named in targetId |
| A saving throw, with advantage from a condition or feature | `math_manage roll_saving_throw {characterId, ability, dc, advantageSources: ['VAUREK']}` (logged as `wis save (adv: VAUREK)`); an exact name beats a longer one, then a prefix, then any part |
| Cast a spell | `combat_action cast_spell {actorId, spellName, targetId \| targetIds}`: attack, damage and saves on the fight's logged dice; debuff conditions land on a failed save (`conditionsApplied`) |
| A boss burns legendary resistance on failed saves by itself | add `autoLegendaryResistance: true` to its statline; without it, a failed save reports how many are left |
| Squad fires / is suppressed | `combat_action volley`; `combat_manage set_unit` |
| Cut through a packed lower-band squad | add `cleave: true` |
| Enemy telegraphs | `combat_manage set_intent`; readied actions then `trigger_readied` |
| HP is wrong | `combat_manage adjust_hp {value \| delta, reason}` |
| Conditions mid-fight | `combat_manage add_condition {condition \| name}` / `remove_condition {condition \| name \| conditionId}`; standard conditions set adv/dis/auto-crit themselves (`ranged`, `ignoreConditions` on attacks) |
| Just the condition names | `character_manage get {characterId, fields: ['conditionNames']}` (or `fields: ['conditions.name', 'conditions.pinned']`) |
| A plot thread grew too long | `narrative_manage archive {noteId, keepLast?: 2, preview?}` (older sections move to an archived note) |
| House-format status block with a footer | `table_rules define {kind: 'status_block', name: 'tiny-status', spec: {conditionLayout: 'line', showMore: false, showLocation: false, showObjective: false, footer: ['knows:vaurek', 'scene.place', 'scene.pull']}}` |
| Turn prose into a feature | `improvisation_manage feature_from_condition` / `edit_effect` |
| A ruling or an invention | `precedent_manage record` / `search` |
| Who knows a secret | `knowledge_manage record` / `learn` / `can_know` |
| Debts and deferred prices | `ledger_manage create` |
| Souls taken or spent | `character_manage adjust_pool {characterId, pool: 'souls', delta, reason}` |
| A counter shown at boot (uses left, linked token) | `character_manage adjust_pool {characterId, pool, value, max, label, show: true, linkItem?}`, then `delta: -1` |
| Souls owed to a god | `ledger_manage create {worldId, debtor, creditor, amount, currency: 'souls', dueDay, consequence}` |
| Time passes | `world_manage advance {worldId, hours}` (or `minutes`, `days`); set the clock once with `world_manage update {worldId, environment: {day, time}}` |
| Clocks and debts the clock reached | `character_manage process_scheduled {worldId}`, `ledger_manage process_due {worldId}` (no day needed) |
| The clock is wrong (not time passing) | `world_manage update {worldId, correction: true, environment: {day, time}}`; boot's CLOCK warning and `world_manage audit {worldId}` name records dated after the clock |
| Did a timed-out call apply? | `session_manage op_status {forOpId}` |
| Check a past roll | `session_manage rolls {forId \| encounterId \| forOpId}` |
