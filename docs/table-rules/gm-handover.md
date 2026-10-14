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

## Between sessions, and after a fight ran in chat

The Deep One campaign ran four days of fights outside the engine because its dice were seeded. They are crypto now (`docs/table-rules/dice.md`), so fights go back through `combat_manage`. For everything that drifted while they didn't:

1. **Set the day.** A world with clocks and no day gets a `CLOCK` warning at boot. Years passing between arcs is `world_manage era_jump {worldId, day, time?, label, dryRun: true}` first, then without `dryRun`: the clock corrects (no regeneration), threads park, stale scheduled rows cancel, abilities and legendary pools refill.
2. **Reconcile the sheets.** `world_manage reconcile {worldId}` names every drift with the call that fixes it: equipped items that no longer exist, duplicate attack profiles, a profile whose `item` is gone, conditions citing a superseded ruling, abilities still spent with no fight on, XP owed. Boot shows the count when it is not zero.
3. **Post the XP you said aloud.** `character_manage add_xp` needs a `reason` now. An award narrated at the table goes in at once as `award_note {characterId, amount, reason}` and lands with `post_awards {worldId}`. The status block footer shows `xp owed` until it does.
4. **Long stretches are one roll.** `improvisation_manage montage {characterId, task, dc, costs: {hardWon, costly}, hours, worldId}`: clean, hard-won or costly, the cost written, the clock moved, the line in the session log.
5. **Clocks that tick by the hour** are exposure timers: `character_manage set_exposure {characterId, name, pool, perHour, cap, thresholds: [{at, condition}]}`; every `world_manage advance` moves them and adds the condition when a threshold is crossed. `advance {fireScheduled: true}` fires due scheduled rows in the same call.
6. **Oaths, owed meetings and borders** are ledger rows with `kind: 'oath' | 'meeting' | 'border' | 'favour'` and a `consequence`; they lapse on the clock like a debt and need no amount.
7. **Damage by band** is opt-in: give the band rule `damageScale: {}` for the defaults and a Mortal's blow on a Monster/Lord halves per step while the reverse grows. Grapples and executes already scaled; attacks now can.

## After play report 2 (Varek)

- **Action Surge is an ability flag.** `abilities: [{name: 'Action Surge', grantsAction: true, perRest: 'short'}]` on the sheet. In a fight, `attack {actionSurge: true}` spends it when the action is already used; `use_ability` banks it by hand. It stays spent across fights until `rest_manage short` or `character_manage restore_ability`.
- **Surprise is on create.** `combat_manage create {…, surprised: [ids]}`; the flagged creatures lose their round-1 turn and reactions.
- **Grapple works everywhere.** No encounter: the sheets roll. A helpless target is held without a contest. `execute` reads any pin you wrote to the holder's name, and `add_condition {fromGrapple}` writes the canonical one. An execute with no damage is a coup de grâce.
- **Create is honest.** Stats you pass are final (species bonuses only on omitted stats or `applySpeciesAbilityBonuses: true`); no default background; `conditions` and `xp` on create; anything create ignores comes back in `ignoredParams`.
- **Stealth and Perception compute from the sheet.** The override columns are empty unless you set `stealthOverride`/`perceptionOverride`; boot's `skill_override_migrated` finding lists any old row the migration moved.
- **Battle Master.** `superiorityDie`, a `superiority` pool with `refresh: 'short'`, and `attack {maneuver}`; fighting styles on `fightingStyle`. Guide: `docs/table-rules/fighter.md`.
- **Friction gone.** A failed call leaves its `opId` free; `world_manage create {name}` is enough; summary replies keep ids; `environment.weather` and `environment.location` are accepted.

## After play report 3 (Harl Sluice, the apron, the herd's food)

- **Only those who fought feel a fight.** `party_manage after_battle {partyId, victory, participants: ['Varek', 'Scurv'], encounterId: ['raid-watcher', 'raid-sleeper']}`. Names or ids, one encounter or a list; everyone else is listed under `absent` and untouched. Leave both off and every member counts, as before.
- **A hand-set AC survives equipping.** `character_manage update {ac}` marks the sheet manual; equip and unequip keep it and say what the gear would give. `recomputeAc: true` on an equip, or `update {acSource: 'derived'}`, hands AC back to the gear. When a manual AC equals what the gear derives, the reply says so.
- **Stores are mouth-days in one pool.** Before linking an old pool counted in camp-days, convert it: `character_manage adjust_pool {characterId, pool: 'stores', value: 200, max: 600, label: 'Stores (mouth-days)'}`. Never link a pool in old units: the first advance would starve the herd. Then `party_manage set_upkeep {partyId, linkPool: {characterId, pool: 'stores'}, mouthsFromPool: [{characterId, pool: 'captives'}]}`; it starts from today and charges nothing before. Guide: `docs/table-rules/upkeep.md`.

## After play report 4 (the Horn-Lock throw)

- **Grapple takes advantage.** `combat_action grapple {…, advantage: true}`, or `advantageSources: ['Horn-Lock']` once Horn-Lock declares it (since play report 7 a named source must declare advantage on grapple; see below). The band or size rule still adds its own disadvantage; the two cancel to one die. A source that matches nothing, two things, or declares nothing is refused before anything is rolled.
- **A key an action doesn't use is reported, not dropped.** Every consolidated tool now returns `ignoredParams` with the nearest valid key when a call carries one, including keys the tool never declared. Read it when a call "worked" but did nothing you asked.
- **Custom items equip by slot.** `item_manage create {…, equipSlots: ['mainhand']}` (or `update {itemId, equipSlots}`); an equip refused for a missing slot prints the exact update call to run. Slots: mainhand, offhand, armor, head, feet, accessory, accessory2, accessory3.

## After play report 5 (the boulder, the Bull's shove, Brenna on the ground)

- **Cover is read from the map and printed.** `combat_action attack` adds +2 (half) or +5 (three-quarters) to the AC by itself from props with a cover rating and from creatures on the line of fire, and prints `AC 12 +5 (three-quarters, boulder) = 17`. State it with `cover: 'half'` when the map is silent or wrong, `cover: 'none'` to override; `combat_manage set_cover {participantId, level, against, reason}` for a token dug in for the fight. Total cover refuses the shot before anything is spent. DEX saves take it too (`apply_damage`, `use_ability`, `lair_action`, `cast_spell`). Never add it to `dc` as well. Guide: `docs/table-rules/cover.md`.
- **Riders on area saves.** `apply_damage {…, save: {ability: 'dex', dc, onFail: {conditions: ['prone']}}}` applies the condition to every failing target in the same call; `onSuccess` the other way; `mirrorToCharacter: true` writes the sheet too.
- **Shove.** `combat_action grapple {move: 'shove', push: 10 | prone: true, save?: {ability: 'str'}, bonusAction?: true}`. The push is forced movement on the grid and stops at the first blocked square; it provokes nothing. Push 10 is a labelled house rule.
- **Goring Rush and other trigger-tied bonus attacks.** Put `bonusAction: true, requires: {dashed: true, movedAtLeast: 20}` on the profile; `dash {targetPosition}` moves in one call; the attack is refused with the exact gap when the trigger is not met.
- **Non-lethal.** `attack {nonlethal: true}` (melee only). A drop is `[KNOCKED OUT — stable]`: no death saves, no corpse, no kill credit. Healing above 0 wakes them.
- **Dying.** A named character (pc or npc row) at 0 HP is Unconscious + Prone and `DYING ✓0 ✗0`. `advance` into their slot rolls the death save itself and prints it; a nat 20 stops on them at 1 HP. `deathSaveMode: 'prompt'` (world environment or per character) holds the slot with `DEATH SAVE DUE` instead. `death_save {participantId, outcome?}` posts a table roll. A hit while down is a failure, two from 5 ft or on a crit; massive damage kills outright. Mooks still just die. Guide: `docs/table-rules/dying.md`.
- **Stabilise.** `combat_action stabilize {encounterId, actorId, targetId}`: adjacent, an action, Medicine DC 10; a healer's kit (`properties.healersKit: true`) or Spare the Dying makes it automatic. The 1 HP after 1d4 hours is filed on the world clock and fires with `world_manage advance {fireScheduled: true}`. Outside a fight `apply_damage` says DYING and prints the stabilise call.
- **Custom armour in any spelling.** `item_manage create {type: 'armor', properties: {baseAc: 13, maxDexBonus: 2}}` is stored canonically and equips at 14 on DEX 12; the equip reply explains the AC and warns when a base is unreadable, with the fix.
- **Senses and natural armour are data.** `character_manage update {senses: {darkvisionFt: 60}}`; `spatial_manage look` sees a DARKNESS room with them. `naturalArmor: {base: 12, addDex: true}` is the floor worn armour must beat.
- **Keen Smell is a trait, not a condition.** `character_manage update {skillAdvantage: [{name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent', passiveBonus: 5}], removeConditions: ['Keen Smell']}`. Tag the check: `math_manage roll_skill_check {…, context: ['scent']}`; deny it before the roll with `scene_manage set {senseDenial: {scent: '<reason>'}}`. The status block shows passive Perception (scent). Guide: `docs/table-rules/senses-and-traits.md`.
- **Two refusals now explain themselves.** `knowledge_manage record` with a bare string knower prints the knower shape and takes `knowers: ['luciel', 'vigil'], how: 'witnessed'` as a shorthand (never assuming a road; a refused knower writes no fact). `editConditions` with a `find` that lives in the source prints the exact `replaceSource` call to paste.

## After play report 6 (the scent hunt, the costs, Many-Skins' arm)

- **The montage rolls the whole skill.** `improvisation_manage montage {characterId, task, dc, skill: 'survival', context: ['scent']}` adds ability + proficiency (doubled by expertise) or the sheet's stealth/perception override, the same number `roll_skill_check` rolls, and prints the working. `ability` beside `skill` swaps the stat and keeps proficiency.
- **Costs in plain words.** `costs: {hardWon: ['Varek loses the trail for a day'], costly: [{op: 'adjust_hp', delta: -2}, 'a Gor is wounded']}`: a string is a note (journaled and shown, nothing written); objects write. A bad cost or a misspelt tier is refused before the roll and the refusal prints the shape.
- **A clock that only reminds.** `character_manage schedule_change {characterId, firesInHours, writes: [{op: 'note', text: 'the arm has healed'}]}` prints its text when it fires and writes nothing.
- **Body parts on the clock.** `schedule_change {…, writes: [{op: 'set_part', part: 'left arm', state: 'intact'}]}` writes the sheet's part and the same part on every live token when it fires; `remove_part` drops one; `latched` cannot be scheduled.

## After play report 7 (the Day 70 cone, the hounds, the subdue order, Horn-Lock)

- **An area on a unit goes model by model.** Area spells (Burning Hands, Fireball) and lair actions are areas already; `use_ability` and `apply_damage` are areas with `area: true`. Each model inside rolls its own save on the fight's dice with the token's ability modifier plus `unit.saves`; a failure takes the full damage, a success half, and a model dies when its damage meets its HP. Read `unitLines` (kept in summary mode): `Militia — 6 in the area: 5 failed, 1 saved; 31 / 15 vs 9 HP each: 6 dead, 0/6 left`. A packed unit has every model inside; a spaced one needs `modelsInArea: {'line': 2}` (read it off `combat_map aoe`), or the call is refused before anything is rolled. A rider such as `onFail: {conditions: ['prone']}` follows the models still standing. Anything that isn't an area hits one model at most. Drilled troops: `combat_manage set_unit {participantId, saves: {dex: 2}}`. Guide: `docs/table-rules/units.md`.
- **Hand-built tokens carry stats.** `participants: [{id: 'hound-1', name: 'Hound 1', hp: 11, maxHp: 11, isEnemy: true, stats: {str: 15, dex: 14}}]` (missing scores are 10; initiative takes the DEX modifier). Grapples, saves and the shove DC read them. A key create doesn't take is named in `ignoredParams` as a dotted path. Guide: `docs/table-rules/ad-hoc-tokens.md`.
- **Name the token you add.** `add_participant {encounterId, id: 'hound-2', …}`; with a creature and `count: 3`, `id: 'hound'` makes hound-1 to hound-3. An id already in the fight is refused. The reply says where the joiner falls and whether it acts this round.
- **Every token has a band.** In a banded world a token with nothing to go on takes the lowest band of the ladder the fight sits on, marked assumed: the create reply warns, `get` shows `(assumed)`, and execute, called strikes and CONSEQUENCE DUE print `(band assumed)` against it. Fix it any time with `combat_manage set_band {encounterId, participantId, band}` (from the next roll on). A band on none of the world's ladders is named at create. A world that would rather refuse: band spec `requireBand: true`.
- **Say the order.** The create reply carries `initiative[]` and `firstUp`, kept in summary mode, and the banner's 🎲 line. Read it to the table before the first turn.
- **Take them alive.** `combat_manage set_subdue {encounterId, participantId, subdue: true}`: that token's opportunity attacks and readied melee swings knock out. A shot can't be non-lethal, so a readied ranged attack under the order (a ranged profile, or `attack: {…, ranged: true}`) is refused unless it says `onSubdue: 'hold' | 'fire'`; `hold` keeps the shot and the reaction, `fire` shoots to kill and says so. Paste the call the refusal prints: it restates the whole attack. What each reaction did is in `reactionLines`, kept in summary mode. Guide: `docs/table-rules/subdue-and-mounts.md`.
- **A player's turn is never passed by accident.** `advance` past a living player character who has done nothing this turn is refused with TURN NOT TAKEN. If the player passes or holds, `advance {encounterId, confirm: true}`; if they act, resolve it first. Mounting counts as acting. A world that never wants it: `world_manage update {worldId, environment: {pcTurnGuard: 'off'}}`. Removing whoever is up brings the next slot up as an advance would. Guide: `docs/table-rules/turns.md`.
- **Advantage is declared, not named.** A condition stays prose; what changes a roll is an effect mechanic `{type: 'advantage_on', value: '<scope>', condition?: '<when-tag>'}` (scopes: `attack`, `attack:melee`, `attack:ranged`, `grapple`, `grapple:<move>`, `check:<skill>`, `check:<ability>`, `save:<ability>`, `initiative`). Untagged it fires by itself on every roll in scope: checks, saves, grapples, attacks (opportunity and readied ones too), initiative, and the saves the engine rolls (a Fireball, a breath weapon, each model of a unit, concentration, a save-ends condition, the stay-mounted save). Tagged it fires on `context: ['head-on']` or when named in `advantageSources`; rolls with no call of their own (opportunity attacks, engine saves) never fire a tagged one and say so. Restrained puts disadvantage on DEX saves by itself. A named source that declares nothing refuses the roll and prints the `feature_from_condition` call that would declare it. One-offs: `situationalAdvantage: 'downhill'`. Guide: `docs/table-rules/advantage.md`.
- **Before the next session, run `world_manage reconcile {worldId}`.** `advantage_source_undeclared` lists every condition the log shows you named as an advantage source that declares nothing now, with the call to convert it (a standard condition such as Poisoned is never converted; use `situationalDisadvantage`).
- **Horn-Lock, converted.** `improvisation_manage feature_from_condition {characterId: 'varek', match: 'Horn-Lock', mechanics: [{type: 'advantage_on', value: 'grapple', condition: 'head-on'}]}`; then `combat_action grapple {…, context: ['head-on']}` on a head-on lock. A rival that circles gets nothing from it.
- **A trait by name.** `math_manage roll_skill_check {characterId, skill: 'perception', advantageSources: ['Keen Smell']}` fires the trait as its `scent` tag on its own skills; on any other skill it is refused with the context call.
- **Skill names in any spelling.** `skill: 'sleight-of-hand'` rolls DEX with proficiency, and the reply says `skillAbility`. A skill the engine can't map rolls bare and warns; pass `ability` or define it with `table_rules {kind: 'skill'}`.
- **Riders.** `combat_manage mount {encounterId, riderId, mountId, free: true}` at set-up (half the rider's speed mid-fight, and it counts as the rider's turn). A controlled mount moves on its rider's turn with `combat_action move {actorId: <rider>}`, dashes with `dash {actorId: <mount>}`, and may only Dash, Disengage or Dodge on its own slot; a fall from a shoved mount is a DC 10 DEX save on the fight's dice.

## After play report 7's answers (save-ends, legendary resistance, wounds, world-spell areas, pressure, ongoing damage)

- **The end-of-turn save is plain 5e.** A `save_ends` condition's save is the total against the DC; a natural 1 or 20 means nothing special.
- **Legendary resistance on every save the engine rolls.** `autoLegendaryResistance: true` spends one by itself. Otherwise the failed save's line offers one (`⭐ LR 3/3 left, spend one?`) with the call to paste: `combat_manage legendary_resistance {encounterId, participantId, saveRef, reason}`. With `saveRef` the spend undoes the failure: the web ends, a broken concentration comes back as it stood, an ongoing tick's or a stunt's damage is healed back. Offers lapse at the creature's next turn. A player character is asked, never spent for. Guide: `docs/table-rules/legendary-resistance.md`.
- **A unit's models keep their wounds.** Repeated damage adds up; a model dies when its total meets its HP. A single blow finishes the most wounded model. Replies show `4 alive: 2 unhurt, 1 at 5/9, 1 at 2/9`. Set wounds by hand with `combat_manage set_unit {participantId, wounded: [5, 2]}`. Guide: `docs/table-rules/units.md`.
- **World spells have a shape.** A spell rule with `area: {shape, size}` goes model by model on a unit, like Fireball; an unmarked one hits one model at most. Foot of Gork, Green Puke and Plague are areas (existing worlds are patched); Warp Lightning and the Dreaded Thirteenth Spell stay single-target.
- **Water pressure and ongoing damage resolve by their shape.** Pressure hits every model of a unit in the deep water separately (`pressure.save` gives each a save). Write burning or bleeding with `combat_manage add_condition {…, condition: {name: 'burning', ongoing: {damage: '1d6', damageType: 'fire', when: 'start', save?: {ability, dc, onSuccess?}}}}`; from an area add `area: true` or `modelsInArea`, and a save rider from an area on a unit records its models itself. Every tick is rolled, logged and printed, and owes its break test, its concentration save and its deaths. Guide: `docs/table-rules/ongoing-damage.md`.

## Never do these

- **Never fake a result with a huge `attackBonus`.** Post it with `outcome`.
- **Never pass `seed` to a roll.** Dice are crypto by default; a seed replays identical dice and is for audits only.
- **Never retry a timed-out write with a new `opId` or none.** Retry with the same `opId`, or check `session_manage op_status {forOpId}`.
- **Never fix HP by healing or damaging.** Use `combat_manage adjust_hp {value | delta, reason}`.
- **Never remove and re-add a condition to change its text.** Use `editConditions`, or `feature_from_condition`.
- **Never let an NPC state a fact without a road to it.** Ask `knowledge_manage can_know` first.
- **Never rule on something twice from memory.** `precedent_manage search` first.
- **Never batch a call that carries an array.** Precedents with `tags` and knowledge records with `knowers` go as direct calls; inside `batch_manage` they are refused, and an atomic batch then undoes its earlier steps.
- **Never narrate Luciel's choices, thoughts or words.**
- **Never work around a refusal.** It is a rule; say so in the fiction.
- **Never read whole sheets when you need two numbers.** Add `fields: ['hp', 'conditions']` or `output_mode: 'summary'`.
- **Never add cover to `dc` or `declaredModifiers` as well.** Pass `cover` once, or let the map decide; the breakdown prints the arithmetic either way.
- **Never kill a knocked-out or dying character by hand.** Three failed saves or massive damage run the kill; a knockout is stable until healed or hit again.
- **Never count a unit's dead by hand after an area.** Pass `area: true` (or cast the area spell) and read `unitLines`; the engine rolls each model's save.
- **Never pass `confirm: true` on TURN NOT TAKEN without the player's word.** It passes their turn; ask first.
- **Never name a prose condition in `advantageSources` and expect it to work.** Declare it once with `feature_from_condition`; for a one-off, `situationalAdvantage: '<reason>'`.

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
| A Waaagh! (battle cry) | `combat_manage battle_cry {participantId, ability?: 'Waaagh!', match?: {species: 'Orruk'}, range?: 60, rounds?: 1, attackAdvantage?, damageBonus?, speedBonus?, moraleBonus?, actionCost?}`; lasts until the start of the caller's next turn. actionCost none (default) is free and may be called out of turn; action or bonus only on the caller's turn |
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
| Spend a legendary resistance by hand | `combat_manage legendary_resistance {encounterId, participantId, reason, saveRef?}`: with the `saveRef` an offered save printed, the spend undoes the failure (a condition ends, a concentration comes back, a tick's or stunt's damage is healed); without it only the count drops |
| Opportunity attack or readied swing | NPC opportunity attacks roll on the move; a PC's comes back in `opportunityAttacksAvailable` with the call to make (`reaction: true` on the attack) |
| Ready an attack that fires itself | `combat_action ready {readiedAction, trigger, on: 'enters_reach' \| 'leaves_reach', watch, attack: {using?}}`; free-text readied actions fire with `combat_manage trigger_readied {participantId, targetId?}` (spends the reaction, rolls a stored attack) |
| Grab, pin, throw or finish unarmed | `combat_action grapple {encounterId, actorId, targetId, move}` (one attack; band and size disadvantage are automatic); `control: true` pins; `move: 'execute'` finishes a pinned lower-band foe; `move: 'break'` escapes the holder named in targetId (clears that hold's conditions; Prone and a spell's Restrained stay) |
| A saving throw, with advantage from a condition or feature | `math_manage roll_saving_throw {characterId, ability, dc, advantageSources: ['VAUREK']}` (logged as `wis save (adv: VAUREK)`) where VAUREK declares it: an effect mechanic `{type: 'advantage_on', value: 'save:wis'}` or the older `{value: 1, save: 'wisdom'}` form. A source that declares nothing is refused with the `feature_from_condition` call that would declare it; a one-off is `situationalAdvantage: '<reason>'`. An exact name beats a longer one, then a prefix, then any part |
| Cast a spell | `combat_action cast_spell {actorId, spellName, targetId \| targetIds}`: attack, damage and saves on the fight's logged dice; debuff conditions land on a failed save (`conditionsApplied`) |
| A boss burns legendary resistance on failed saves by itself | add `autoLegendaryResistance: true` to its statline; without it, a failed save offers one with the call to paste. A player character is always asked, never spent for |
| Squad fires / is suppressed | `combat_action volley`; `combat_manage set_unit` |
| Cut through a packed lower-band squad | add `cleave: true` |
| Enemy telegraphs | `combat_manage set_intent`; readied actions then `trigger_readied` |
| Damage with no attacker (hazard, trap, an off-turn bite) | `combat_manage apply_damage {encounterId?, targetIds, dice: '6d10', source, damageType?, save?: {ability, dc}}`; no action spent; without encounterId it writes to the sheets |
| HP is wrong | `combat_manage adjust_hp {value \| delta, reason}` |
| Conditions mid-fight | `combat_manage add_condition {condition \| name}` / `remove_condition {condition \| name \| conditionId}`; standard conditions set adv/dis/auto-crit themselves (`ranged`, `ignoreConditions` on attacks) |
| Just the condition names | `character_manage get {characterId, fields: ['conditionNames']}` (or `fields: ['conditions.name', 'conditions.pinned']`) |
| A plot thread grew too long | `narrative_manage archive {noteId, keepLast?: 2, preview?}` (older sections move to an archived note) |
| House-format status block with a footer | `table_rules define {kind: 'status_block', name: 'tiny-status', spec: {conditionLayout: 'line', showMore: false, showLocation: false, showObjective: false, footer: ['knows:vaurek', 'scene.place', 'scene.pull']}}` |
| Turn prose into a feature | `improvisation_manage feature_from_condition` / `edit_effect` |
| A ruling or an invention | `precedent_manage record` / `search` |
| Who knows a secret | `knowledge_manage record` / `learn` / `can_know` |
| Debts and deferred prices | `ledger_manage create` |
| Carry capacity | STR x 15, x2 Large, x4 Huge, x8 Gargantuan, x1/2 Tiny from the sheet's size; a `carry_capacity` pool overrides it |
| Souls taken or spent | `character_manage adjust_pool {characterId, pool: 'souls', delta, reason}` |
| A counter shown at boot (uses left, linked token) | `character_manage adjust_pool {characterId, pool, value, max, label, show: true, linkItem?}`, then `delta: -1` |
| Souls owed to a god | `ledger_manage create {worldId, debtor, creditor, amount, currency: 'souls', dueDay, consequence}` |
| Time passes | `world_manage advance {worldId, hours}` (or `minutes`, `days`); set the clock once with `world_manage update {worldId, environment: {day, time}}` |
| Clocks and debts the clock reached | `character_manage process_scheduled {worldId}`, `ledger_manage process_due {worldId}` (no day needed) |
| Untagged scheduled rows (`unscopedOwnerUnknown`) | `character_manage scope_scheduled {worldId: <its own world>, scheduleIds: [...], preview?}`; another world's rows are refused by name |
| The clock is wrong (not time passing) | `world_manage update {worldId, correction: true, environment: {day, time}}`; boot's CLOCK warning and `world_manage audit {worldId}` name records dated after the clock |
| Did a timed-out call apply? | `session_manage op_status {forOpId}` |
| A free roll with several dice terms | `math_manage roll {expression: '6d10+3d10', purpose, forId?}` (logged, every die listed) |
| Check a past roll | `session_manage rolls {forId \| encounterId \| forOpId}` |
| Years pass between arcs | `world_manage era_jump {worldId, day, label, dryRun?}` |
| After fights ran in chat | `world_manage reconcile {worldId}`; fix each finding with the call it names |
| XP said aloud, not yet applied | `character_manage award_note {characterId, amount, reason}` then `post_awards {worldId}` |
| Forty-eight cells, one roll | `improvisation_manage montage {characterId, task, dc, skill?, context?, costs?: {hardWon: [...], costly: [...]}, hours, worldId}`: one logged die, skill modifier applied, tiers clean / hard-won / costly; costs are op objects or plain-text notes |
| Hours of exposure | `character_manage set_exposure {characterId, name, pool, perHour, cap, thresholds}`; `world_manage advance` ticks it |
| An oath or an owed meeting | `ledger_manage create {worldId, kind: 'oath' \| 'meeting' \| 'border' \| 'favour', debtor, creditor, consequence, dueDay?}` |
| A fight in the water | `combat_manage create {..., environment: {medium: 'water', depthFt}}` or `set_environment`; give swimmers `swimSpeed` and the tag `aquatic` |
| A Skaven campaign | `table_rules import {worldId, preset: 'skaven-horned-rat'}`; guide in `skaven-horned-rat.md` |
| Spend a warpstone token on a cast | `combat_action cast_spell {..., boost: {pool: 'warpstone', delta: -1, modifier: 2, sideEffect: [{pool: 'warpstone_taint', delta: 1}]}}` |
| Reinforce a unit | `combat_manage set_unit {encounterId, participantId, models}` |
| A ship in the fight | `table_rules define {kind: 'vessel', ...}` then `character_manage create_vessel {worldId, vessel, name}`; strike a section with `atPart`; `combat_manage board {encounterId, attackerId, targetId}` for the boarding (`vessels.md`) |
| Is the d20 fair? | `session_manage rolls {worldId, stats: true}` |
| Damage with no attacker, or from a named one | `combat_manage apply_damage {targetIds, dice, source, actorId?}` |
| Spend Action Surge mid-swing (the action is already used) | `combat_action attack {..., actionSurge: true \| 'Action Surge'}` (grapple too); a no-op while the action is free |
| Bank the surge by hand, then act | `combat_manage use_ability {encounterId, participantId, ability: 'Action Surge'}` on its own turn (ability needs `grantsAction: true`); any ability spends its `actionCost` (action \| bonus \| reaction \| none) |
| Ambush: foes caught flat-footed | `combat_manage create {..., surprised: ['gob-1']}` or `set_surprised {encounterId, participantIds, reason?}` before their round-1 turn; `surprised: false` clears |
| Mark a sheet ability spent / ready | `character_manage spend_ability {characterId, name, reason?}` / `restore_ability {characterId, name \| all: true}` (bookkeeping; reaches live tokens by name) |
| Mark a hold so execute and break see it | `combat_manage add_condition {encounterId, participantId, condition: 'restrained', fromGrapple: <holder id or name>}` writes source 'grapple: <holder id>' (reply heldBy); or write the source yourself as the holder's id or name, 'grapple: <id>', 'pinned by <name>' |
| Grapple a helpless target, or post a grapple the table resolved | `combat_action grapple {encounterId?, actorId, targetId, move}` needs no roll against an unconscious/asleep/incapacitated/paralysed/stunned/petrified/0-HP target (autoWin.reason); `outcome: 'win' | 'lose'` posts the result (no d20, attack spent; with a win, `damage` is the throw/slam surface damage) |
| Grapple outside a fight | `combat_action grapple {actorId, targetId, move}` with no encounterId: sheets, logged dice, world prof curve + expertise; two live tokens in one fight are routed there (routedToEncounter) |
| Finish a pinned lower-band foe on the sheets | `combat_action grapple {actorId, targetId, move: 'execute', damage?, damageType?}`: no damage = coup de grâce (its HP, defences bypassed); a number or dice (crit, doubled) respects resistances; at 0 HP the kill makes a corpse (writesTo 'sheet', killed, corpseId, growth) |
| Credit a kill made through the damage lane | `combat_manage apply_damage {encounterId?, targetIds, dice, source, actorId}`: each target dropped to 0 credits the actor's growth track (growth[], ⬆ GROWTH line) |
| A character's Stealth or Perception looks wrong | math_manage roll_skill_check {characterId, skill} — the breakdown says computed (DEX/WIS + proficiency) or override; character_manage update {characterId, stealthOverride: null} clears an override, {stealthOverride: 0} is an authoritative zero |
| Boot says RECONCILE with skill_override_migrated | world_manage reconcile {worldId} lists each moved column (old -> new, computed value); character_manage update {characterId, stealthOverride: <old>} restores it, or world_manage reconcile {worldId, acknowledge: ["skill_override_migrated"]} accepts the moves (characterId scopes it to one sheet) |
| Create with rolled or point-buy scores | character_manage create {stats, applySpeciesAbilityBonuses: true} adds the species bonuses; stats alone are taken as final; omit stats for 10s + bonuses — statsNote says which |
| Clear a character's background | character_manage update {characterId, background: null} |
| Create with a wound clock or starting XP | character_manage create {conditions | addConditions, xp}; a key create does not take comes back in ignoredParams with the nearest valid key or the update-only hint |
| Re-import a preset without losing a rewritten principle | table_rules import {worldId, preset} keeps your principles (kept: n); {overwrite: true} replaces them |
| A call failed validation or named a wrong action and you sent an opId | resend the corrected call with the same opId — the reply said 'op <id> NOT applied (error) — opId still free' |
| You want to know whether an opId ever applied | session_manage op_status {forOpId} — a preview (writes: 'none') or an error reply reads 'did not apply' |
| A new world, no seed in mind | world_manage create {name} — seed generated (8 hex, echoed as seed, seedGenerated: true), 100x100; pass seed/width/height to choose |
| Set the weather or where the party is | world_manage update {worldId, environment: {weatherConditions: 'sleet', location: 'Vorago docks'}} — weather, currentLocation and place are accepted aliases; the reply's aliased lists renames |
| You misspelt an environment key | the refusal names the nearest accepted key and the full list; nothing was written |
| You need ids out of a summary reply | output_mode: 'summary' keeps id-like keys and short names of oversized objects and lists (25 rows a list, 50 a reply, then {_more}); _op carries the guard's op line |
| Where and when, before play | session_manage boot — first line 'Now: Day 47, 06:00 · era … · sleet · at …'; the full status block shows an AT row, get_context world has weather and location |
| Mark a pool to refill on a rest | `character_manage adjust_pool {characterId, pool: 'superiority', value: 4, max: 4, refresh: 'short' \| 'long' \| 'none'}` |
| An ability that comes back on a rest | `character_manage update {abilities: [{name: 'Second Wind', perRest: 'short' \| 'long', actionCost?}]}`; `use_ability` / `battle_cry` / `attack {actionSurge}` spend it on the token and the sheet |
| Rest one character | `rest_manage short \| long {characterId}`: pools by `refresh`, `perRest` abilities, legendary resistances (long), slots; refused while a token in an active encounter (`combat_manage end` first) |
| Rest the party | `travel_manage rest {partyId, restType: 'long' \| 'short'}`: the same per member (`members[].refilled`) |
| Give a fighter a style | `character_manage update {fightingStyle: 'great_weapon' \| 'dueling' \| 'archery' \| 'defense'}`; profiles carry `twoHanded` and `ranged`; one swing: `attack {twoHanded: true}` |
| Set up a Battle Master | `character_manage update {superiorityDie: '1d8', maneuverAbility?: 'str' \| 'dex'}` + `adjust_pool {pool: 'superiority', value: 4, max: 4, refresh: 'short'}` |
| Trip, menace or disarm on a hit | `combat_action attack {actorId, targetId, maneuver: 'trip' \| 'menacing' \| 'disarming', maneuverItem?}` |
| Turn a near miss | `combat_action attack {..., maneuver: 'precision'}` (rolled only on a miss within the die; a natural 1 is never turned) |
| Answer a melee miss | `combat_action attack {..., maneuver: 'riposte', reaction: true}` |
| Audit the superiority dice | `session_manage rolls {encounterId, purpose: 'superiority'}`; the pool's history on `character_manage get` |
| Book a fight only those who fought should feel | `party_manage after_battle {partyId, victory, participants: ['Varek', 'mira-0a1b'], encounterId: ['raid-gate', 'raid-hall']}` — ids or names (case-insensitive) and/or the fight's encounter ids (a raid run as several fights takes a list; boardings count under their parent); the reply's `absent` lists who was left untouched. Leave both off and every member counts, and the reply says so |
| A member was removed mid-fight, or a prisoner should feel the loss | prisoners are never tokens and `remove_participant` strips the token, so with `encounterId` both read as absent: name them in `participants` (ids or names) alongside the encounter ids; the two are unioned |
| after_battle refuses a participant | an unknown name or id, a non-member, or a name two members share (the reply names both ids): pass the character id; nothing was written. A missing encounter, or one with no member token (nor in its boardings), is refused the same way: drop it or name who fought in `participants` |
| A character's AC was set by hand (stat block, house rule) and gear is equipped or removed | `character_manage update {characterId, ac: 17}` marks it hand-set; `inventory_manage equip/unequip` then keep 17 and acChange says what the gear gives. Nothing to pass. |
| You want the gear to drive the AC after all | `inventory_manage equip {characterId, itemId, slot, recomputeAc: true}` (or unequip) takes the derived value and sets acSource 'derived'; or `character_manage update {characterId, acSource: 'derived'}` to switch without touching gear (number changes at the next equip/unequip). |
| The reply says acMatchesDerived: true | The hand-set AC equals what the gear derives; pass `recomputeAc: true` on the next equip/unequip, or `update {acSource: 'derived'}`, to let gear drive it and stop the sheet staying manual by accident. |
| A legacy sheet (made before acSource existed) is equipped for the first time | It follows gear only if its stored AC equals what the gear derived before the change; otherwise it is kept and stamped manual. Read `ac.source` in the reply; `recomputeAc: true` if the kept value was never meant to be hand-set. |
| A token made before a hand-set AC change is still in a fight | Live tokens keep the AC they were made with; `combat_manage update_participant {ac}` on the token if it must change mid-fight. |
| Link the camp's stores to upkeep | FIRST convert the pool to mouth-days: `character_manage adjust_pool {characterId, pool: 'stores', value: 200, max: 600, label: 'Stores (mouth-days)'}` (the old pool was camp-days for 10 mouths, max 60; never link a pool in old units), THEN `party_manage set_upkeep {partyId, linkPool: {characterId, pool: 'stores'}, mouthsFromPool?: [{characterId, pool: 'captives'}], extraMouths?, countRoles?, starvation?: {loyaltyDelta: -1, perDay: true}}`; the reply says "upkeep starts from Day N; nothing before it is charged" and prints stores against mouths as days left — check that number before moving on |
| Days pass (advance, travel, montage) | `world_manage advance {worldId, days}` charges every midnight crossed; read `upkeep[]` (stores from→to, mouths, starvedDays, loyalty hits). A starving day sets stores to 0 and docks loyalty from everyone but the leader and mounts |
| Resupply, loot or spoilage | `character_manage adjust_pool {characterId, pool: 'stores', delta: +120, reason}` on the linked pool; there is no adjust_stores |
| How long will the stores last? | `party_manage muster {partyId}` → `upkeep.daysLeft`, the mouth breakdown (members, each mouth pool, extra) and `starving` |
| Captives taken or freed, a unit shrinks | nothing to do: mouth pools and unitModels are read live at the next charge |
| Time passed outside advance | `party_manage upkeep {partyId, days}` charges by hand; the clock catches up to it before charging again |
| Fixing a wrong clock or jumping an era | `world_manage update {worldId, correction: true, environment: {day, time}}` / `era_jump` charge nothing and move the upkeep anchor (reply `upkeepAnchored[]`); a plain `update` that moves the clock is caught up by the next advance |
| Stop tracking stores | `party_manage set_upkeep {partyId, clear: true}` (the pool keeps its value) |
| A grapple with advantage the table ruled | `combat_action grapple {encounterId, actorId, targetId, move, advantage: true}` — two d20 keep high for the grappler, situational 'Marine: advantage (GM)', logged as `grapple (adv: GM)`; `disadvantage: true` keeps the low die |
| A grapple with advantage from something on the grappler | `combat_action grapple {…, advantageSources: ['Horn-Lock']}` (or `disadvantageSources`): the named effect or condition must declare `advantage_on` with `value: 'grapple'` (or `grapple:<move>`, `check:athletics`, `check:str`), a skillAdvantage trait must list Athletics, or a standard condition's 5e rule must apply; a tagged mechanic fires on `context: ['head-on']` too. A name that matches nothing, two things, or declares nothing is refused before anything is rolled or spent, with the call that would declare it |
| The GM's advantage against the band/size rule | `grapple {…, advantage: true}` on a lower-band or smaller grappler rolls one die (`rollMode.actor: 'cancelled'`, the line says both); the defender keeps only its own automatic disadvantage |
| Which die was kept and why | reply `rollMode {actor, defender}`, `advantageSources`, `disadvantageSources`, `situational[]`; `session_manage rolls {forId}` shows `grapple (adv: GM, Horn-Lock (head-on, named); dis: lower band)` and `2d20kh1` / `2d20kl1` on the sheet path |
| A straight attack roll with the flag spelled out | `combat_action attack {…, advantage: false}` (or volley) rolls one d20 — it used to roll at disadvantage |
| Make a misc item wearable | `item_manage create {name, type: 'misc', equipSlots: ['accessory']}`, or later `item_manage update {itemId, equipSlots: ['accessory']}` (the other properties are kept; no mergeProperties needed). `equipSlots: []` hands the slots back to the type defaults. Slots: mainhand, offhand, armor, head, feet, accessory, accessory2, accessory3 |
| Equip is refused for the slot | the reply's `fix.args` is the exact `item_manage update {itemId: '<real id>', equipSlots: [...]}` to run, then equip again; nothing was written. A weapon tried in `armor` gets `['mainhand', 'offhand', 'armor']`; the `properties: {equipSlots: [...]}, mergeProperties: true` form is printed as the alternative |
| Edit one property on a template | `item_manage update {itemId, properties: {key: value}, mergeProperties: true}` keeps the rest (a key set to null is deleted; `propertyMerge.preservedKeys` lists what survived). Without `mergeProperties` the stored set is replaced wholesale. `preview: true` shows the diff and writes nothing |
| A slot is misspelt | `properties.equipSlots: ['mainhnd']` is refused with the nearest slot and nothing written; a top-level `equipSlots` typo fails validation with the full slot list |
| A reply shows ⚠️ Ignored params | re-send with the key the line names (`nearest valid key 'weight'`); the write already happened without it |
| A validation error names a key you did not send | read `unknownParams` and the issue's "you sent 'nmae'; did you mean 'name'?" — nothing was written |
| Chair wants only two fields but must still see dropped keys | `any_tool {..., fields: ['worldId']}` — `ignoredParams` rides along with success/error/actionType/message |
| An action should accept stray keys quietly (rare) | set `unknownKeys: 'strip'` on that action's definition (or on its createActionRouter config) |
| A shot at a foe behind a boulder, a wall or another creature | `combat_action attack {encounterId, actorId, targetId}` reads the map's cover (`AC 12 +5 (three-quarters, boulder) = 17`); `cover: 'half'` when the map is silent, `cover: 'none'` to override |
| A token digs in behind rubble for the fight | `combat_manage set_cover {encounterId, participantId, level: 'three-quarters', against: ['fg-handguns'] or {direction: 'west'}, reason}`; `clear_cover` when it leaves; `attack {breaksCover: true}` when it charges out |
| Nothing can reach the target (closed door, full wall) | the engine refuses (`refused: total cover (rubble crest) from fg-crossbows … Nothing was rolled or spent`); for an area that gets round it pass `cover: {id: 'none'}` (`coverByTarget` on `cast_spell`) |
| A breath weapon, rockslide or Fireball against covered targets | `combat_manage apply_damage / use_ability / lair_action {…, save: {ability: 'dex', dc}, cover: {grot: 'half'}}`, `cast_spell {…, coverByTarget}`: +2/+5 on the DEX save, printed |
| A Sharpshooter or Spell Sniper on the sheet | `character_manage update {characterId, ignoreCover: {ranged: 'half-and-three-quarters'}}` or `{spells: …}`; or `ignoreCover` on the attack profile |
| The player asks whether they can hide | `combat_manage get` prints `🫥 can hide from Grot (…)` per token; `set_environment {light: 'darkness'}` for a dark room (darkvision tokens still see) |
| A failed save should knock them prone or bury them | `combat_manage apply_damage {…, save: {ability: 'dex', dc: 15, onFail: {conditions: ['prone', {name: 'Buried', source: 'rockslide'}], mirrorToCharacter: true}}}` |
| A shove pushes the foe back | `combat_action grapple {action: 'grapple', move: 'shove', encounterId, actorId, targetId, push: 10}` (`prone: true` to floor it instead); reply `pushed {feet, from, to, stoppedBy?}` |
| A shove by STR save (Hammering Horns, Shield Master) | `combat_action grapple {move: 'shove', …, save: {ability: 'str'}, bonusAction: true}`; dc defaults to 8 + prof + STR |
| Goring Rush after a charge | `combat_action dash {encounterId, actorId, targetPosition: {x, y}}` then `attack {…, using: 'Goring Rush'}` with `bonusAction: true, requires: {dashed: true, movedAtLeast: 20}` on the profile; a refusal names the gap |
| Knock a foe out instead of killing | `combat_action attack {…, nonlethal: true}` (melee only); `[KNOCKED OUT — stable]`, no death saves, no corpse; `heal` or `adjust_hp` above 0 wakes them (`woke`) |
| A named character drops to 0 HP | nothing: Unconscious + Prone and `[DYING ✓0 ✗0]` are applied; `combat_manage get` shows 🩸 DYING ✓s ✗f |
| Their turn comes up | `combat_manage advance {encounterId}` rolls and prints the save; a nat 20 stops on them at 1 HP. Prompt mode: `death_save {encounterId, participantId}` first |
| The table rolled the save itself | `combat_manage death_save {encounterId, participantId, outcome: 'nat20' \| 'success' \| 'failure' \| 'nat1' \| 1-20}` |
| A healer reaches the body | `combat_action stabilize {encounterId, actorId, targetId}` (adjacent, action, Medicine DC 10; kit or Spare the Dying automatic); the 1 HP fires with `world_manage advance {worldId, hours, fireScheduled: true}` |
| Someone is dropped outside a fight | `combat_manage apply_damage {targetIds, dice, source}` says DYING; then `combat_action stabilize {actorId, targetId}` or heal above 0 |
| Hold the slot instead of auto-rolling | `world_manage update {worldId, environment: {deathSaveMode: 'prompt'}}`; per character `character_manage update {characterId, deathSaveMode: 'prompt'}`; `deathSaves: false` makes a location NPC just die at 0 |
| A GM types baseAc on a mail shirt | `item_manage create {name, type: 'armor', properties: {baseAc: 13, maxDexBonus: 2}}` is stored as baseAC (`aliased` in the reply); `inventory_manage equip` derives 14 on DEX 12 and explains it |
| Sneaking in scale mail | `math_manage roll_skill_check {characterId, skill: 'stealth'}` rolls at disadvantage by itself, named in the breakdown |
| A character sees in the dark | `character_manage update {characterId, senses: {darkvisionFt: 60}}`; `spatial_manage look` returns a DARKNESS room as dim light (`seenWith`, `visionNote`) |
| A thick hide | `character_manage update {characterId, naturalArmor: {base: 12, addDex: true}}`; worn armour must beat it, shields add on top |
| Keen Smell as a trait | `character_manage update {characterId, skillAdvantage: [{name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent', passiveBonus: 5}], removeConditions: ['Keen Smell']}` |
| A scent-based check, or tracking by scent | `math_manage roll_skill_check {characterId, skill: 'perception' \| 'survival', dc, context: ['scent']}`; `improvisation_manage montage {…, skill: 'survival', context: ['scent']}` |
| The wind is wrong, or smoke fills the hollow | `scene_manage set {worldId, senseDenial: {scent: 'wind from the east carries everything away'}}` (scene-wide) or `{targetId, scent: 'buried in peat-smoke'}`; `wind: 'from W'` lets the engine place upwind and downwind |
| Someone sneaks past Varek | `math_manage opposed {characterId: hider, skill: 'stealth', targetId: 'varek', targetSkill: 'perception'}`: a Stealth total below passive Perception (scent) 16 is noticed unless scent is denied |
| Record a fact several people saw | `knowledge_manage record {worldId, key, statement, knowers: ['luciel', 'inquisitor'], how: 'witnessed'}` (bare ids share the top-level how; a knower object's own how wins; told takes `fromId`) |
| A condition edit is refused as 'not in the name' | read the refusal: it prints the `replaceSource` (or `replace`) call that hits, with your match and with; a case-only miss shows the casing that is there |
| Edit text that lives in a condition's source | `character_manage update {characterId, editConditions: [{match: 'oath', replaceSource: {find: 'Karanak', with: 'the Mouth'}}]}` (match reads names only; find is case-sensitive) |
| A proficient skill over a long task | `improvisation_manage montage {characterId, task, dc, skill: 'survival', context?: ['scent']}` adds ability + proficiency (doubled by expertise) or the sheet's stealth/perception override and prints the working; `ability` beside `skill` swaps the stat and keeps proficiency |
| Montage and roll_skill_check disagree | both read the same sheet number; compare `breakdown` on each. Only auto-apply effect bonuses differ: roll_skill_check applies them, montage takes them as `modifier` |
| A montage cost in plain words | `costs: {hardWon: ['Varek loses the trail for a day'], costly: [{op: 'adjust_hp', delta: -4}, 'a Gor is wounded']}`: a string is a note (in applied[], the journal line and the message; nothing written); a bad cost or a misspelt tier is refused before the roll with the shape |
| A reminder that fires on a day | `character_manage schedule_change {characterId, firesAtDay \| firesInHours, writes: [{op: 'note', text: 'the arm has healed'}], note?}`: prints its text on `process_scheduled`, `world_manage advance {fireScheduled: true}` or `fireNow: true`, writes nothing, mixes with real writes |
| A wound heals on a clock (Many-Skins' arm knits in three days) | `character_manage schedule_change {characterId, worldId, firesInHours: 72, writes: [{op: 'set_part', part: 'left arm', state: 'intact'}], note: 'the arm knits'}`; it fires on `world_manage advance {fireScheduled: true}` or `process_scheduled`, writing the sheet and the token in every live fight (the applied line names the encounters) |
| Heal or cripple a part this instant, sheet and fight together | `character_manage schedule_change {characterId, worldId, firesAtDay, fireNow: true, writes: [{op: 'set_part', part, state, kind?, holds?, hp?}]}`; `{op: 'remove_part', part}` drops a part; `latched` is refused (use `combat_manage set_part` on the token) |
| A montage or a table costs a limb | `improvisation_manage montage {…, costs: {costly: [{op: 'set_part', part: 'left arm', state: 'crippled'}]}}`; `table_rules define {kind: 'roll_table', spec: {entries: [{text, apply: {writes: [{op: 'set_part', part, state}]}}]}}` then `roll {name, characterId}` |
| A breath, cone or blast hits a unit token | `combat_manage use_ability {…, savingThrow: {ability: 'dex', dc}, area: true}` or `apply_damage {…, area: true}` (area spells and lair actions are areas already): each model saves on the fight's dice; read `unitLines` |
| An area clips a spaced unit | `combat_map aoe {encounterId, shape, origin, …}` prints `modelsInArea: {'line': 2}`; pass it on the damage call. Without it the call is refused before anything is rolled or spent |
| Drilled troops save better than their stats | `combat_manage set_unit {encounterId, participantId, saves: {dex: 2}}` (or `unit: {…, saves}` on create); `saves: null` clears |
| A bite or a single bolt on a unit | no `area`: one model at most (`unitCap`, 'one model at most: 31 → 9') |
| Hand-built hounds with real strength | `combat_manage create {participants: [{id: 'hound-1', name: 'Hound 1', hp: 11, maxHp: 11, isEnemy: true, stats: {str: 15, dex: 14}}]}` |
| A reinforcement you can name | `combat_manage add_participant {encounterId, id: 'hound-2', name, hp, maxHp, stats?}`; with `creature` and `count: 3`, `id: 'hound'` makes hound-1 … hound-3 |
| A token is stronger than its assumed band | `combat_manage set_band {encounterId, participantId, band, reason?}` (from the next roll on; clears the assumed mark) |
| A world that refuses unbanded tokens | `table_rules define {worldId, kind: 'band', name, spec: {order: [...], requireBand: true}}` |
| Tell the table the order | `combat_manage create` → `initiative[]` and `firstUp` (kept in summary); the banner's 🎲 line |
| Advance is refused with TURN NOT TAKEN and the player passes or holds | `combat_manage advance {encounterId, confirm: true}` (alias `skipTurn: true`); the reply's `confirmCall` holds the exact call |
| A table that never wants the turn guard | `world_manage update {worldId, environment: {pcTurnGuard: 'off'}}` |
| The actor that is up flees or is banished | `combat_manage remove_participant {encounterId, participantId}`: the next slot comes up as with advance; read `deathSaveDue` |
| Order a token to take them alive | `combat_manage set_subdue {encounterId, participantId, subdue: true, reason?}` (`false` lifts it; create and add_participant take `subdue: true`) |
| Ready a ranged shot under a subdue order | `combat_action ready {encounterId, actorId, readiedAction, trigger, on?, attack: {using: 'crossbow' \| ranged: true, onSubdue: 'hold' \| 'fire'}}` |
| A held readied shot, the GM says shoot | `combat_manage trigger_readied {encounterId, participantId, targetId, attack: {onSubdue: 'fire'}}` (the stored shot fires with its own weapon) |
| What each opportunity attack or readied shot did, on summary | read `reactionLines` (knockouts, held fire, overrides, a player's offered call) |
| Start the fight mounted | `combat_manage mount {encounterId, riderId, mountId, free: true}` (mid-fight: half the rider's speed, on its turn) |
| Ride a controlled mount | `combat_action move {encounterId, actorId: <rider>, targetPosition}`; `dash {encounterId, actorId: <mount>, targetPosition}` for more ground |
| Declare a trait's advantage once (Horn-Lock) | `improvisation_manage feature_from_condition {characterId, match: 'Horn-Lock', mechanics: [{type: 'advantage_on', value: 'grapple', condition: 'head-on'}]}` |
| A head-on lock | `combat_action grapple {…, context: ['head-on']}` or `{…, advantageSources: ['Horn-Lock']}` (logged 'Horn-Lock (head-on, named)') |
| A trait gives advantage on every melee swing | `improvisation_manage apply_effect {targetId, name: 'Bloodlust', category: 'boon', durationType: 'until_removed', mechanics: [{type: 'advantage_on', value: 'attack:melee'}]}` (fires on opportunity and readied swings too) |
| Danger Sense against a Fireball or a breath | `apply_effect {…, mechanics: [{type: 'advantage_on', value: 'save:dex'}]}` once; every save the engine rolls reads it (`saveSources`) |
| A creature acts first in an ambush | mechanics `[{type: 'advantage_on', value: 'initiative', condition: 'ambush'}]`; `combat_manage create {participants: [{…, context: ['ambush']}]}` |
| The GM's one-off ruling | `situationalAdvantage: 'downhill'` (or `situationalDisadvantage`) on a check, save, grapple or attack; logged `GM: downhill` |
| A named source was refused | read `sourceProblems`: paste the `feature_from_condition` / `edit_effect` call it prints, or use `situationalAdvantage` |
| Find conditions to convert before play | `world_manage reconcile {worldId}` → `advantage_source_undeclared` (fix ready to paste) |
| A trait by name | `math_manage roll_skill_check {characterId, skill: 'perception', advantageSources: ['Keen Smell']}` |
| A skill in any spelling | `math_manage roll_skill_check {characterId, skill: 'sleight-of-hand'}` → `skillAbility: 'dex'`; a theme skill takes `ability: 'cha'` or `table_rules {kind: 'skill'}` |
| A concentrating caster with War Caster or a steadying trait | `apply_effect {…, mechanics: [{type: 'advantage_on', value: 'save:con'}]}`: every concentration save after damage rolls two dice; the concentration result and `saveSources` name it |
| A hold, web or poison shaken off at the end of the turn | `combat_manage add_condition {encounterId, participantId, condition: {name: 'restrained', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex'}}`: advance rolls it as a plain 5e saving throw (ability, save proficiency, restrained's own DEX disadvantage, declared sides; legendary resistance spent or offered with `saveRef`); read `endOfTurnSaves` |
| A legendary caster fails its concentration save | auto spends by itself (the spell holds); otherwise paste the 🧠 line's `combat_manage legendary_resistance {…, saveRef: 'con-…'}`: the spell comes back as it stood. Off a fight, paste the printed `concentration_manage restore {…, spendLegendaryResistance: true}` |
| Set a unit's wounds by hand | `combat_manage set_unit {encounterId, participantId, wounded: [5, 2]}` (`[]` heals every wound; HP moves to match) |
| Make a world spell an area | `table_rules define {worldId, kind: 'spell', name, spec: {…, area: {shape: 'cone' \| 'cube' \| 'cylinder' \| 'line' \| 'sphere', size: 20}}}`; a spaced unit target needs `cast_spell {…, modelsInArea}` |
| Burning, bleeding or a lingering cloud | `combat_manage add_condition {encounterId, participantId, condition: {name: 'burning', ongoing: {damage: '1d6', damageType: 'fire', when: 'start', save?: {ability: 'dex', dc: 13, onSuccess?: 'none' \| 'half' \| 'end'}}}}` (on a unit: `area: true` or `modelsInArea: n` for a cloud); read `turnDamage` |
| Deep water that crushes, with a save | `combat_manage set_environment {encounterId, environment: {medium: 'water', depthFt, pressure: {startsAtFt, damagePerRound, damageType?, save?: {ability: 'con', dc, half?}}}}` |
| A boss failed an ongoing tick's save | `combat_manage legendary_resistance {encounterId, participantId, saveRef: 'ong-…', reason}`: the damage the success would have avoided is healed back |
