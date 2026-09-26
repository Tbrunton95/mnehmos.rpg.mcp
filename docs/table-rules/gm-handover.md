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
| A recurring monster's statline, once | `character_manage update {characterId, ...}` with the same fields; tokens joined by id start with it |
| Multiattack | `attacksPerAction: N` on the statline, then one `combat_action attack` per swing (`attack 1/2`, `2/2`) |
| A legendary action off its turn | attack with `legendaryCost: N`; otherwise `combat_manage legendary_action {participantId, cost?, description}` |
| Spend a legendary resistance by hand | `combat_manage legendary_resistance {participantId, reason}` |
| Opportunity attack or readied swing | NPC opportunity attacks roll on the move; a PC's comes back in `opportunityAttacksAvailable` with the call to make (`reaction: true` on the attack) |
| Ready an attack that fires itself | `combat_action ready {readiedAction, trigger, on: 'enters_reach' \| 'leaves_reach', watch, attack: {using?}}`; free-text readied actions fire with `combat_manage trigger_readied {participantId, targetId?}` (spends the reaction, rolls a stored attack) |
| Grab, pin, throw or finish unarmed | `combat_action grapple {encounterId, actorId, targetId, move}` (one attack; band and size disadvantage are automatic); `control: true` pins; `move: 'execute'` finishes a pinned lower-band foe; `move: 'break'` escapes the holder named in targetId |
| A saving throw, with advantage from a condition or feature | `math_manage roll_saving_throw {characterId, ability, dc, advantageSources: ['VAUREK']}` (logged as `wis save (adv: VAUREK)`) |
| A boss burns legendary resistance on failed saves by itself | add `autoLegendaryResistance: true` to its statline; without it, a failed save reports how many are left |
| Squad fires / is suppressed | `combat_action volley`; `combat_manage set_unit` |
| Cut through a packed lower-band squad | add `cleave: true` |
| Enemy telegraphs | `combat_manage set_intent`; readied actions then `trigger_readied` |
| HP is wrong | `combat_manage adjust_hp {value \| delta, reason}` |
| Conditions mid-fight | `combat_manage add_condition {condition \| name}` / `remove_condition {condition \| name \| conditionId}`; standard conditions set adv/dis/auto-crit themselves (`ranged`, `ignoreConditions` on attacks) |
| Turn prose into a feature | `improvisation_manage feature_from_condition` / `edit_effect` |
| A ruling or an invention | `precedent_manage record` / `search` |
| Who knows a secret | `knowledge_manage record` / `learn` / `can_know` |
| Debts and deferred prices | `ledger_manage create` |
| Souls taken or spent | `character_manage adjust_pool {characterId, pool: 'souls', delta, reason}` |
| Souls owed to a god | `ledger_manage create {worldId, debtor, creditor, amount, currency: 'souls', dueDay, consequence}` |
| Time passes | `world_manage update {worldId, environment}` |
| Did a timed-out call apply? | `session_manage op_status {forOpId}` |
| Check a past roll | `session_manage rolls {forId \| encounterId \| forOpId}` |
