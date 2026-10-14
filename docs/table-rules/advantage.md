# Advantage is declared, not named

Play report 7, #7 and #8 (the owner's spec). A condition stays prose. Anything that changes a roll is declared on an effect, and the engine knows exactly which rolls it touches. Naming a source no longer grants advantage just because the name matches something on the sheet: it grants what that source declares for this roll, and nothing else.

```
improvisation_manage feature_from_condition {
  characterId: 'varek', match: 'Horn-Lock',
  mechanics: [{type: 'advantage_on', value: 'grapple', condition: 'head-on'}]
}
combat_action grapple {…, context: ['head-on']}          → Varek: advantage (Horn-Lock (head-on))
combat_action grapple {…, advantageSources: ['Horn-Lock']} → grapple (adv: Horn-Lock (head-on, named))
combat_action grapple {…}  (a rival that circles)          → one die; conditionalAdvantage names the tag
```

## One declaration surface: the effect mechanic

```
{type: 'advantage_on' | 'disadvantage_on', value: '<scope>', condition?: '<when-tag>'}
```

`value` is a scope from a fixed grammar:

| Scope | Covers |
| --- | --- |
| `attack`, `attack:melee`, `attack:ranged` | attack rolls in that lane: `combat_action attack`, opportunity attacks, readied attacks, volleys and spell attacks (see [Attacks](#attacks)) |
| `grapple`, `grapple:<move>` | the grappler's contest: any move, or one of clinch, takedown, throw, slam, control, break, shove (execute rolls no contest) |
| `check:<skill>` | that skill check, in any spelling (`check:sleight_of_hand`); an SRD skill or a skill the world defines (`table_rules {kind: 'skill'}`). `check:athletics` also covers a grapple's Athletics (and `check:acrobatics` a break's Acrobatics) |
| `check:<ability>` | ability checks with that ability and skill checks governed by it (`check:str` covers Athletics and a grapple); `check:dex` covers initiative, which is a Dexterity check in 5e |
| `save:<ability>` | that saving throw (`save:str`, `save:wis`): `math_manage roll_saving_throw` and every save the engine rolls by itself (see [Engine saves](#engine-saves)) |
| `initiative` | initiative rolls at `combat_manage create` and `add_participant` (see [Initiative](#initiative)) |

Anything else is refused when the effect is written (`apply_effect`, `edit_effect`, `replace_effect`, `feature_from_condition`; and the effects other tools write for you: a `table_rules` roll_table entry's `apply.gift` on define and import, a `knowledge_manage record` `effectOnKnower`): `writes: 'none'`, `mechanicProblems` naming the value and the accepted forms. A scope is stored in one canonical spelling (`'Check: Sleight of Hand'` is stored as `check:sleight_of_hand`). `check:<skill>` takes the 18 SRD skills, an ability, or the target's world skills; a character with no world takes any skill name.

`condition` is a **when-tag**:

- **Untagged**, the mechanic fires on every roll in its scope by itself. The breakdown reads `advantage ← Wolf Ears` and the contribution lane is ENGINE.
- **Tagged** (`condition: 'head-on'`), it fires only when the roll asserts the tag: `context: ['head-on']` on the call, or the effect named in `advantageSources`. Naming it counts as the GM asserting the circumstance holds, and the log says so: `Horn-Lock (head-on, named)` against `Horn-Lock (head-on)` for a context tag. A roll in scope without the tag gets `conditionalAdvantage: ["Horn-Lock (head-on): pass context: ['head-on'] or advantageSources: ['Horn-Lock'] when it holds"]`.

Tags match ignoring case, spaces, hyphens and underscores (`'Head On'` is `head-on`). `math_manage roll_saving_throw` and `roll_ability_check` take `context` too now; a tag that fires nothing there is reported, never swallowed, and so is one on a grapple (`contextUnfired`, and a line in `situational`: a Horn-Lock not yet converted says so instead of rolling one die in silence). `context` takes an array, one bare tag, or a JSON string of an array.

## What a name grants

`advantageSources` / `disadvantageSources` on `math_manage roll_skill_check`, `roll_ability_check`, `roll_saving_throw`, `combat_action grapple` and `combat_action attack` are matched as before (a condition's short name, full name or source; an effect's name; and now a skillAdvantage trait's name; exact beats prefix beats substring). A hit grants only when it **declares** the side for this roll:

1. **An effect** with an `advantage_on` (or `disadvantage_on`) mechanic whose scope covers the roll. A condition kept beside the feature made from it shares its name, so naming either finds the feature.
2. **A standard condition's 5e rule**: poisoned, frightened and exhaustion give disadvantage on ability checks (and so on a grapple); restrained and slowed on DEX saves; exhaustion 3 or more on saves too (a sheet condition `Exhaustion 3` carries its level). No standard condition grants advantage on a check or save. Homebrew registry entries (blessed, cursed, marked) declare nothing.
3. **A skillAdvantage trait** listing the roll's skill (#8): `advantageSources: ['Keen Smell']` on a Perception check fires as `context: ['scent']` would, that trait only, through the scene's sense denial and the wind (a denial is quoted in `deniedAdvantage` and the roll goes ahead without it). A grapple fires a trait listing Athletics (Acrobatics on a break).

Anything else **refuses the roll** before any die, calculation, log row or spend (`writes: 'none'`, `sourceProblems`), with the reason and the call that would declare it:

```
'Gor Hunter' grants no advantage on stealth. To grant one, improvisation_manage feature_from_condition
{characterId: 'varek', match: 'Gor Hunter', mechanics: [{type: 'advantage_on', value: 'check:stealth'}]};
for a one-off, use situationalAdvantage: '<reason>'.

'Keen Smell' is Varek's skillAdvantage trait for perception, survival (when: scent); this is an insight check,
so it does not apply — on a perception or survival check name it, or tag it: math_manage {action:
'roll_skill_check', characterId: 'varek', skill: 'perception', context: ['scent']}; nothing granted
```

An effect that declares the side elsewhere says where (`it declares advantage on grapple`) and prints the `edit_effect` call with its mechanics and the new one; a condition only on a token prints the `apply_effect` call; a standard condition says it declares only its 5e rules. The texts for a name that matches nothing, two things or is empty are unchanged. `math_manage` used to warn and roll on those; it now refuses, as grapple always did. A name with an apostrophe is double-quoted in the call (`match: "Hunter's Mark"`) so it parses as pasted. Under `output_mode: 'summary'` the reply keeps `sourceProblems`, `mechanicProblems` and `resolverProblems` word for word, so the call survives the small reply.

## The GM's own ruling

`situationalAdvantage: '<reason>'` / `situationalDisadvantage: '<reason>'` on the math_manage checks and saves, on grapple and on attack: the roll takes it for this call, logged as `adv: GM: <reason>` (lane SITUATIONAL) and echoed in the reply. A grapple from a direct caller with `situationalAdvantage: true` is refused (the reason is text). `advantage: true` / `disadvantage: true` still work and are logged as `GM` on math_manage now too. Use the situational form for a one-off; anything lasting belongs on an effect.

## Attacks

`combat_action attack` takes `context`, `advantageSources`, `disadvantageSources`, `situationalAdvantage` and `situationalDisadvantage`.

```
improvisation_manage apply_effect {targetId: 'varek', name: 'Bloodlust', category: 'boon', durationType: 'until_removed',
  mechanics: [{type: 'advantage_on', value: 'attack:melee'}]}
combat_action attack {actorId: 'varek', targetId: 'rival'}             → d20(4,17 adv→17); ⚖️ advantage ← Bloodlust (attack:melee)
combat_action attack {actorId: 'varek', targetId: 'archer', ranged: true} → one die: a ranged shot is not attack:melee
```

**The lane is the attack's own**, decided the way cover and fighting styles already decide it: `ranged: true | false` on the call, else the attack profile's `ranged` flag, else the grid (a target beyond the attacker's reach is a shot), else melee. `attack` covers both lanes. A spell attack's lane is the spell's own: the spell's stated kind first (Spiritual Weapon is a melee spell attack at range 60, as 5e has it), else melee for a touch or self spell (or one that reaches only 5 ft) and ranged otherwise. `cast_spell` takes no `ranged` flag.

**What fires where:**

| Road | Untagged mechanics | Tagged mechanics |
| --- | --- | --- |
| `combat_action attack` | fire by themselves | on `context: ['charging']`, or named in `advantageSources` |
| opportunity attacks (on a move) | fire by themselves, always the melee side (an opportunity attack is melee in 5e) | never: nothing asserts a tag |
| readied attacks (a move's trigger, or `trigger_readied`) | fire by themselves | never: nothing asserts a tag |
| `combat_action volley` | fire by themselves (read off the unit token's id), always the ranged side (a volley is the unit's fire, with or without a grid) | never |
| `cast_spell` spell attacks (Fire Bolt) | fire by themselves | never |

Opportunity and readied attacks resolve with nobody making a call, so they carry no context: a tagged mechanic cannot fire there. Write the mechanic untagged if it should hold on those swings too.

**Named sources** grant only what declares advantage (or disadvantage) for this attack's lane: an effect with a `<which>_on` mechanic scoped `attack` or `attack:<lane>` (naming a tagged one asserts its tag: `Horn Charge (charging, named)`), or a standard condition's 5e rule (invisible grants advantage; blinded, frightened, poisoned, prone, restrained and exhaustion 3+ disadvantage). Anything else refuses the attack before any roll, Help, surge, manoeuvre or ammunition is spent (`writes: 'none'`, `sourceProblems`):

```
'Gor Hunter' grants no advantage on melee attacks. To grant one, improvisation_manage feature_from_condition
{characterId: 'varek', match: 'Gor Hunter', mechanics: [{type: 'advantage_on', value: 'attack:melee'}]};
for a one-off, use situationalAdvantage: '<reason>'.
```

`advantage: true` still works and is labelled `GM`; `situationalAdvantage: 'downhill'` is `GM: downhill`. Every source cancels as usual against disadvantage from the attack's flags and standard conditions (prone, restrained, invisible…), Dodge, Help and crippled parts: one die. A posted `outcome` rolls nothing, so the declared sources are noted as ignored and names are not checked: the breakdown says which (`named sources not checked: posted outcome, no roll (adv: Gor Hunter)`).

**What the table sees.** The breakdown has one line per source (`advantage ← Bloodlust (attack:melee)`, `disadvantage ← GM: the fog`); the reply carries `advantageSources` / `disadvantageSources` (also on each `opportunityAttacks[]` and readied `attack` entry, and on a spell's reply), `situationalAdvantage`, `context`, and `conditionalAdvantage` naming the tag a tagged mechanic is waiting for; a tag that fired nothing for this lane is said in the breakdown. The roll log purpose names them: `attack (adv: Bloodlust (attack:melee))`, `opportunity attack (adv: …)`, `spell attack (adv: …)`; with no source it stays exactly `attack`.

## Engine saves

Most saves at the table are rolled by the engine, not by a `math_manage` call: the targets of an area, a spell, a shove. Each of those reads the saver's own declared sides, as the owner's rule says: an untagged mechanic fires on every roll in its scope by itself.

```
improvisation_manage apply_effect {targetId: 'varek', name: 'Danger Sense', category: 'boon', durationType: 'until_removed',
  mechanics: [{type: 'advantage_on', value: 'save:dex'}]}
combat_action cast_spell {actorId: 'mage', spellName: 'Fireball', targetId: 'varek'}
  → 🎲 Varek DEXTERITY save: d20(4,17) + 1 = 18 vs DC 15 [DEX +1] [d20 4, 17; adv: Danger Sense (save:dex)]
```

**Which roads.** Every save the engine rolls goes through one composition (`rollSaveDie`: under `rollParticipantSave`, under `rollCharacterSave` on the sheets outside a fight, and under the concentration roll; the engine's own end-of-turn save reads the same sides through a provider), so all of these read it:

| Road | Save |
| --- | --- |
| `combat_manage apply_damage {save}`, `use_ability {savingThrow}`, `lair_action {savingThrow}` | each target's save in the area (on the sheets too, with no fight) |
| `combat_action cast_spell` | each target's save against the spell's damage, the debuff loop (Hold Person's WIS save), a world spell's save |
| a unit token in an area | every model's save (see below) |
| `combat_action attack {maneuver}` | the trip, menacing or disarming save |
| `combat_action grapple {move: 'shove', save}` | the target's save |
| a rider pushed or knocked prone | the DC 10 DEX save to stay mounted |
| every road that checks concentration: `combat_action attack`, `cast_spell` (and a world spell), `apply_damage` / `use_ability` / `lair_action` (and `apply_damage` on the sheets), an `execute` on the sheets, `concentration_manage check_save` | a concentrating creature's CON save after damage (see [Concentration](#concentration-and-the-end-of-turn-save)) |
| `combat_manage advance` (and a surprised slot passed at `create` or `remove_participant`) | the end-of-turn save of a `durationType: 'save_ends'` condition (see below) |
| every road that runs a turn's start or end (`advance`, a surprised slot passed at `create` or `remove_participant`, the turn a natural 20 starts at `death_save`) | an ongoing effect's save and water pressure's save, read through the same provider as the end-of-turn save; a unit's models each roll with the token's sides read once ([ongoing-damage.md](ongoing-damage.md#the-save)) |

**Untagged only.** An untagged `save:<ability>` mechanic on the saver's active effects fires: two d20s, keep the higher (`advantage_on`) or the lower (`disadvantage_on`). Effects are read by the saver's id; a sheet-backed token's id is its character id. A **tagged** one never fires here, since no call carries a tag for each target (as opportunity and readied attacks carry none). The reply names it instead, so the GM can decide: `conditionalAdvantage: ["Evasive Footwork (in the open): a save the engine rolls asserts no tag, so it did not fire; write the mechanic without condition: 'in the open' if it holds on every DEX save"]`. Write the mechanic untagged if it holds on every save of that ability. `save:wis` never touches a DEX save. The older form (`{value: 1, save: 'dexterity'}`, `autoApply`) never touched an engine save and still does not.

**Conditions.** The 5e conditions' save rules apply by themselves: restrained gives disadvantage on DEX saves, and exhaustion 3 or more on every save (as before). On a sheet with no fight, a `Restrained` or `Exhaustion 3` condition counts the same. No 5e condition grants advantage on a save. Slowed's DEX rule is a registry entry 5e does not have (the Slow spell is a -2), so it fires only when the GM names it on `math_manage`.

**Cancelling.** Everything cancels as usual: Danger Sense on a restrained target is one die, and the line says so (`[d20 9; adv: Danger Sense (save:dex); dis: restrained; cancel: one die]`). A cover bonus still adds to the total. The second die comes off the fight's seeded stream like every other save die, so a seeded fight replays both.

**Units.** A unit's per-model saves read the unit token's mechanics once and apply them to every model: `Saves vs DC 13 (DEX +1 = +1; adv: Shield Drill (save:dex)): 17✓ 9✗ …`, each model's `rolls` holding both dice. A model's failed save never spends the token's legendary resistance, at advantage or not.

**What the table sees.** The roll log purpose names each source, as on every other roll: `Fire Breath save (dexterity) (adv: Danger Sense (save:dex))`, `stay mounted (DC 10 DEX) (dis: restrained)`. An area target carries `advantageSources`, `disadvantageSources`, `saveRolls` (both dice) and `conditionalAdvantage`; a spell's `saves[]`, the unit report (`unitArea` / `unitAreas`), `maneuver.save`, a shove's `save` and `mounts[].save` carry the same. Each of these replies also carries a top-level `saveSources`, one row per save that took a source or left a tagged one waiting (the stay-mounted save is the exception: its `mounts[]` row is kept whole by summary already, so the row's `line` names the sources and its `conditional` list names a tagged mechanic that waited):

```
saveSources: [{targetId: 'varek', name: 'Varek', ability: 'dexterity', rolls: [4, 17], advantage: ['Danger Sense (save:dex)']},
              {targetId: 'militia', name: 'Militia', ability: 'dexterity', models: 6, advantage: ['Shield Drill (save:dex)']}]
```

`output_mode: 'summary'` keeps `saveSources` whole, labels and both dice included. A save that took no source reads exactly as it did.

### Concentration and the end-of-turn save

Play report 7, lane H: the last two saves the engine rolled its own way now read the same sides.

**Concentration.** Every road that checks concentration rolls the CON save through one composition, so a concentrating creature's untagged `save:con` mechanic (War Caster, here `Steady Mind`) rolls two d20s and keeps the higher, and exhaustion 3 or more rolls two and keeps the lower; both cancel to one die. The dice come off the road's own stream: the fight's seeded dice in a fight, a logged d20 on the sheets (one roll_log row holding both dice). The token's conditions count in a fight, the sheet's (`Exhaustion 3`) outside one.

```
improvisation_manage apply_effect {targetId: 'cleric', name: 'Steady Mind', category: 'boon', durationType: 'until_removed',
  mechanics: [{type: 'advantage_on', value: 'save:con'}]}
combat_action attack {actorId: 'brute', targetId: 'cleric', …}
  ▌ 🧠 Cleric: Concentration on Bless: CON save 19 vs DC 10 ✓ held [d20 4, 17; adv: Steady Mind (save:con)]
```

The roll log purpose reads `concentration (adv: Steady Mind (save:con))`. The labels (`advantageSources`, `disadvantageSources`, `saveRolls`, `conditionalAdvantage`) ride the reply's concentration result: `targets[].concentration` on `apply_damage`, `use_ability` and `lair_action` (and on the sheets), `concentration` on a sheet `execute`, the reply itself on `concentration_manage check_save`, and `concentrationSaves: [{targetId, name, spell, broken, saveRoll, saveTotal, saveDC, …}]` on `combat_action attack`, `cast_spell` and a world spell, which had no concentration result before. Each such save is also a row of the top-level `saveSources`, marked `save: 'concentration on Bless'` and carrying `broken` (true: the spell ended), which `output_mode: 'summary'` keeps whole, so a summary reply says whether the spell held. A concentration save that took no source reads exactly as before: the purpose is `concentration`, and the attack, spell and world spell replies carry no concentration fields and no line, unless a legendary resistance was spent or offered on it (below).

**Legendary resistance on the concentration save** (play report 7 follow-up, lane K). A failed CON save by a creature with legendary resistance left asks the same rule as every other engine save, on all seven roads: `autoLegendaryResistance` spends one and the spell holds (`✗ failed → 👑 legendary resistance (LR 2/3 left): held`); otherwise the spell breaks and the line offers one (`✗ BROKEN ⭐ LR 3/3 left, spend one? combat_manage legendary_resistance {…, saveRef: 'con-1-hag-1', …}`); a player character is asked, never spent for. In a fight the offer's `saveRef` restores the spell as it stood; off a fight the line carries the repair, `concentration_manage restore {…}`. The concentration result, the `🧠` line and a concentration `saveSources` row carry `legendaryResisted` or `legendaryOffer`, and the reply's top-level `legendaryOffers` carries the call whole. See [legendary-resistance.md](legendary-resistance.md#concentration-saves).

A blow that drops the creature to 0 HP ends its spell outright, with no CON save, on every road. (`combat_action attack` and `cast_spell` used to roll a save there anyway, and with a source the line printed `✓ held` over a spell that had just ended.)

**The end-of-turn save of a `save_ends` condition.** At `advance` the engine rolls it itself, so the engine (which never reads the database) is handed a provider by the handlers on every `advance`, `create` and `remove_participant`. The provider returns the saver's declared sides (untagged `save:<ability>` mechanics; a tagged one as a hint) and its save modifier. The engine adds the token's own conditions' 5e rules: restrained on a DEX save, including the restrained condition being saved against, and exhaustion 3 or more. Advantage or disadvantage rolls two d20s under one purpose (`save vs restrained (adv: Danger Sense (save:dex); dis: restrained)`) and keeps the right one. The kept die plus the modifier meets the DC or it does not: plain 5e, like every other save the engine rolls, so a natural 1 or 20 means nothing special (`d20 1 + 12 = 13 vs DC 13 … ✓ saved: webbed ends`). The save used to shift a step on a natural 20 or 1; the owner dropped that rule after play report 7. A failed save offers or spends a legendary resistance like any other engine save, and a player character is asked, never spent for: see [legendary-resistance.md](legendary-resistance.md). Because the provider is passed on every advance, a fight reloaded in a new process reads it too, and a seeded fight replays both dice.

```
combat_manage create {participants: [{id: 'varek', …, conditions: [{name: 'webbed', durationType: 'save_ends', saveDC: 13, saveAbility: 'dex'}]}, …]}
combat_manage advance {…}
  ♻️ Varek's end-of-turn DEX save vs webbed: d20 17 + 1 = 18 vs DC 13 (DEX +1) ✓ saved: webbed ends [d20 4, 17; adv: Danger Sense (save:dex)]
```

**It is a 5e saving throw now.** It used to add the token's ability modifier alone, and nothing at all for a sheet-backed token with no scores on the token. It now adds what every other engine save adds: the sheet's ability modifier and its save proficiency on the world's proficiency curve (`DEX +1, save proficiency +3` at level 5), or a sheetless token's own ability modifier, as before. A unit token adds its drilled `unit.saves` bonus, as each model's area save does (`DEX +1, drilled +2`). The reply's `endOfTurnSaves` rows (on `advance`, `remove_participant`, and `create` when a surprised first slot passes) (`{participantId, name, condition, conditionId, ability, dc, rolls, natural, modifier, parts, total, saved, advantage?, disadvantage?, conditional?, legendaryResisted?, legendaryOffer?, line}`) and a turn note say what happened; every end-of-turn save gets a note now, not only one that took a source. `output_mode: 'summary'` keeps `endOfTurnSaves` whole. A pure engine with no provider (tests, direct callers) still reads the token's conditions and its ability modifier.

**Tagged mechanics** fire on neither road: no call asserts a tag for a concentration save or an end-of-turn save. The hint is in `conditionalAdvantage` (concentration) or `conditional` (an `endOfTurnSaves` row), and in the line.

What does not read them yet, because it rolls its save its own way: an aura's save (`aura_manage`) and a stunt's target save (`improvisation_manage stunt`). Both answer legendary resistance now (lane K): a stunt's failed target save spends or offers one in a fight, and an aura's failed save prints the offer without spending (the aura report writes nothing); see [legendary-resistance.md](legendary-resistance.md). Nor do engine saves apply the Dodge action's advantage on DEX saves, or the automatic STR and DEX failures of the paralysed, stunned, unconscious and petrified (the stay-mounted save already fails those outright).

## Initiative

At `combat_manage create` and `add_participant`, an untagged `initiative` mechanic on a token's active effects, or an untagged `check:dex` one (initiative is a Dexterity check in 5e), rolls the token's initiative twice and keeps the higher; a `disadvantage_on` keeps the lower; both together cancel to one die. Effects are read by the token's id: a sheet-backed token's id is its character id. A tagged one fires when the roll asserts its tag: `participants[].context` on create, `context` on add_participant (it applies to every token that call adds). A tag that fires nothing is warned (`warnings`).

```
improvisation_manage apply_effect {targetId: 'varek', name: 'Ambusher', category: 'boon', durationType: 'until_removed',
  mechanics: [{type: 'advantage_on', value: 'initiative', condition: 'ambush'}]}
combat_manage create {participants: [{id: 'varek', …, context: ['ambush']}, …]}
  → initiative: [{id: 'varek', roll: 19, modifier: 2, natural: 17, advantage: ['Ambusher (ambush)'], rolls: [17, 6]}, …]
```

The row in `initiative` (and the joiner's row on add_participant) gains `advantage` / `disadvantage` with the labels and `rolls: [a, b]` when two dice were rolled; `natural` is the kept die. Both dice are on the fight's logged dice under `initiative (adv: Ambusher (ambush))`, so a seeded fight replays them. A given `initiative` rolls nothing and ignores all of it. Standard conditions do not change initiative, as before. `output_mode: 'summary'` keeps the rows whole, the labels and both dice included.

## The older form keeps its meaning

A mechanic written before the grammar — a number (or prose) in `value`, scoped by `skill` / `save`, or flagged `autoApply` — is read exactly as before, and never touches an attack or initiative: `autoApply` ones fire by themselves through the resolver, `declaredEffects: [{name}]` applies the rest, and a named one grants when its skill/save scope fits the roll (`{type: 'advantage_on', value: 1, save: 'wisdom'}` on a WIS save, not a DEX save). Mixing the two forms on one mechanic (a scope plus `autoApply`, `skill` or `save`) is refused at write time. An `edit_effect` or `replace_effect` that re-sends a mechanic the row already holds, unchanged, passes it as it is (so the `edit_effect` call a refusal prints, which lists the effect's mechanics and adds one, pastes even over an older-form prose value); a new prose value is refused. `declaredEffects` naming an effect whose advantage is in the new grammar applies nothing and says where it lives (name it in `advantageSources`, or pass its tag).

## Converting a table

`world_manage reconcile` lists `advantage_source_undeclared`: every condition on a sheet that the roll log shows was named as a source (`grapple (adv: Horn-Lock)`) and that declares nothing for those rolls now, so the next such roll would be refused. The fix is ready to paste, one mechanic per logged scope:

```
improvisation_manage feature_from_condition {characterId: "varek", match: "Horn-Lock",
  mechanics: [{type: "advantage_on", value: "grapple"}]} — add condition: "<when-tag>" if it holds only sometimes
```

(`edit_effect` with the feature's mechanics plus the new one when a feature of that name already exists.) The finding clears once the condition is converted. It reads the log the way the next roll would: a skillAdvantage trait sharing the condition's name declares for it, and a logged skill check rolled with its skill's ability, so a feature declaring `check:str` covers a logged Athletics check. A standard condition named outside its 5e rule (`wis save (dis: Poisoned)`) is listed too, but never with a conversion call, which would take the condition and its 5e rules off the sheet: the fix is `situationalDisadvantage: '<reason>'` on such a roll, and the finding clears when the condition ends. Convert before play, not after a roll quietly loses its advantage. On Varek's sheet: Horn-Lock becomes `{advantage_on, 'grapple', condition: 'head-on'}`; Keen Smell is a trait and already declared; Thick Hide is AC, not advantage; Gor Hunter is a proficiency and grants nothing.

## Skill names (#11)

Any spelling of an SRD skill rolls its ability: `'Sleight of Hand'`, `'sleight-of-hand'`, `'SleightOfHand'` all roll DEX on `roll_skill_check`, `opposed`, stunts and the montage (one map, `SRD_SKILL_ABILITY`). The reply says which and why: `skillAbility: 'dex'`, `skillAbilitySource: 'given' | 'world' | 'srd' | 'none'`. A skill that is neither SRD nor a world skill, with no `ability` given, rolls with no ability and no proficiency and warns (`skill 'haggling' names no ability …` in `resolverProblems` and the breakdown); it used to fall back to WIS without a word. A stunt still refuses such a skill until `ability` is given.
