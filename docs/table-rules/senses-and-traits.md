# Senses, armour and conditional traits

Play report 5 (#7, #8). Four things that used to live in prose now live as data the engine reads: what a suit of armour is, what a character sees with, how thick its hide is, and which trait fires on which kind of check. The GM states the fiction once; the dice follow it.

## Armour (#7)

One reader, `src/engine/armor.ts`, reads every spelling an armour template has carried. The canonical keys:

```
{ baseAC: 13, armorCategory: 'medium', maxDexBonus: 2, strengthRequired?: 13, stealthDisadvantage?: true }
```

A shield is `{ armorCategory: 'shield', acBonus: 2 }` and equips in the offhand. Any equipped item's `acBonus` adds to AC (magic armour, a ring).

| What was written | Read as |
| --- | --- |
| `baseAc`, `base_ac`, `BASEAC`, `armorClass`, legacy `ac` | `baseAC` |
| `maxDex`, `max_dex_bonus`, `dexCap` | `maxDexBonus` |
| `category: 'light' \| 'medium' \| 'heavy' \| 'shield'`, `armorType`, `armor_type` | `armorCategory` (the SRD's `category: 'Armor'` is not a category and is ignored) |
| `strReq`, `strength_required`, `minStr` | `strengthRequired` |
| `stealth_disadvantage`, `stealthDisadv` | `stealthDisadvantage` |

Keys match case- and underscore-insensitively, so a row stored before the fix with `baseAc` works without an update; the equip reply names the alias (`armor.aliased: {baseAc: 'baseAC'}`).

**The DEX cap** is the written `maxDexBonus`; else the category (heavy: no DEX; medium: cap 2; light: full); else the legacy tell (a Strength requirement with no category means heavy). The GM's mail shirt `{baseAc: 13, maxDexBonus: 2}` on DEX 12 equips at 14, not 11.

**item_manage create/update** rewrite the aliases to the canonical keys on the way in (`aliased` in the reply), refuse a category typo with the nearest name (`armorCategory 'medum' … nearest is 'medium'`), a base that is not a non-negative integer, or two spellings that disagree. Nothing is written on a refusal. A ring with only `acBonus` is left alone; the check applies to type `armor` and to any template carrying a definite armour key.

**Equip and unequip** reply with `armor {item, category, baseAC, dexApplied, dexCap, stealthDisadvantage, strengthRequired, meetsStrength, aliased}` and `warnings[]`, also on the message:

- an armour-slot item with no readable base: `Mail shirt is worn in the armor slot but has no readable baseAC … AC fell back to unarmoured 10 + DEX; fix: item_manage update {itemId, properties: {baseAC: <n>}, mergeProperties: true}` — never a silent fall back;
- a STR below the requirement: `STR 11 is below the 13 Chain mail requires: speed -10 ft (5e; not applied)`.

A hand-set AC (`acSource: 'manual'`) is still kept; the reply says what the gear derives and `recomputeAc: true` takes it. A legacy sheet whose stored AC equalled the old, wrong derivation now reads as hand-set and keeps its number with that hint, never a silent change.

**Stealth disadvantage.** Worn armour with `stealthDisadvantage: true` puts every Stealth check at disadvantage: `math_manage roll_skill_check stealth` and the opposed initiator (`disadvantage ← Scale mail (stealth disadvantage)` in the breakdown, lane SHEET), the eavesdrop roller (`npc_manage interact`: `speakerRolls`, `speakerDisadvantage`), and a stealth `montage`. GM advantage cancels it to one die as normal.

## Senses (#8a)

```
character_manage create | update {characterId, senses: {darkvisionFt: 60, blindsightFt?, tremorsenseFt?, truesightFt?}}
```

The field lives in the combat profile and travels everywhere the profile does: `get`, forms (a creature rule with `senses` applies them on `set_form`; `set_form 'base'` restores the sheet's), species rules (`table_rules define {kind: 'species', spec: {senses: {darkvisionFt: 60}}}` copies them at create; an SRD species with the Darkvision feature gets 60 ft and the feature leaves `unsupportedFeatureNames`), and tokens (`combat_manage create / add_participant` default from the sheet; the state view shows them).

**spatial_manage look in DARKNESS.** With no light and no sense, the room is pitch black (presence, not identity, as before). With darkvision the room comes back as dim light: `seenWith: 'darkvision 60 ft'`, `visionNote: 'darkness seen as dim light: no colour, and sight-based Perception at disadvantage'`, and the HIDDEN-exit Perception check rolls `2d20kl1`. Blindsight and truesight see the dark as it is (`seenWith: 'blindsight 30 ft'`, no penalty). Tremorsense feels movement and does not show a room. A legacy `Darkvision` condition in any case still counts (read as 60 ft). Rooms have no dimensions, so a sense of any range counts as in range.

**Status block.** `DV 60` (and `BS`, `TS`, `TRU`) ride the `SPD` row; `get_status_block` returns `senses`.

## Natural armour (#8b)

```
character_manage update {characterId, naturalArmor: {base: 12, addDex: true, maxDex?: 2}}
```

Natural armour is the floor the worn armour must beat. Unarmoured AC is the higher of `10 + DEX` and `base + DEX`; a worn suit replaces it only when its own total is higher (`Mail shirt base 13 + DEX(max 2) (beats natural armour 13)` / `natural armour 12 + DEX +1 (beats Leather 12)`); shields and every other `acBonus` add on top of whichever wins. Species rules carry it; `create` uses it for the default AC.

`update {naturalArmor}` recomputes at once: a sheet that follows its gear (`acSource: 'derived'`, or a legacy row whose AC equalled its gear) takes the new number and says `AC 11 → 13 (natural armour 12 + DEX +1)`; a hand-set AC is kept and told what the gear gives (`armorClass {derived, parts, applied}`). The Defense fighting style stays armour-only.

Varek's migration: `update {senses: {darkvisionFt: 60}, naturalArmor: {base: 12, addDex: true}, skillAdvantage: [Keen Smell], removeConditions: ['Darkvision', 'Thick Hide', 'Keen Smell']}`.

## Conditional trait advantage (#8c)

### The trait as data

```
character_manage update {characterId, skillAdvantage: [
  { name: 'Keen Smell', skills: ['perception', 'survival'], when: 'scent', passiveBonus: 5, note: 'scent-based Perception; tracking by scent' }
]}
```

The same shape covers any conditional trait: Stonecunning (`skills: ['history'], when: 'stonework'`), Keen Hearing (`when: 'hearing'`), Sure-Footed (`skills: ['acrobatics'], when: 'ice'`). A species rule may carry `skillAdvantage` too; `create` copies it.

### On the roll: the context tag

```
math_manage roll_skill_check {characterId, skill: 'perception', dc, context: ['scent']}
math_manage opposed {characterId: hider, skill: 'stealth', targetId: varek, targetSkill: 'perception', targetContext: ['scent']}
improvisation_manage montage {characterId, task, dc, skill: 'survival', context: ['scent']}
```

Any trait whose `when` matches a tag applies advantage by itself; the breakdown reads `advantage ← Keen Smell (scent)`, the reply carries `traitAdvantage: ['Keen Smell (scent)']`, and the roll log's purpose is `perception check (adv: Keen Smell (scent))`. An untagged check gets no advantage and `conditionalAdvantage` names the tag it would need. A tag on a skill the trait does not list fires nothing. Advantage and disadvantage still cancel as normal (a GM `disadvantage: true`, or stealth armour, brings it back to one die). A Survival check to follow a trail takes `context: ['scent']` the same way.

The montage rolls its notation twice and keeps the higher (`advantageRoll {rolls, kept, mode}`); with `skill` and no `ability`, the skill's 5e or world ability supplies the modifier.

### Denial, stated before the roll

```
scene_manage set {worldId, senseDenial: {scent: 'wind from the east carries everything away'}}
scene_manage set {worldId, senseDenial: {targetId: 'varek', scent: 'buried in peat-smoke'}}
scene_manage set {worldId, senseDenial: [{scent: '…'}, {targetId, hearing: '…'}]}
```

A tagged roll made while a denial stands gets no trait advantage and quotes the reason: `⚠ Keen Smell (scent) denied: wind from the east carries everything away` in the breakdown, `deniedAdvantage: [{trait, when, reason}]` in the reply. A per-target denial touches only that character; a scene-wide one touches everyone in the scene. The latest scene the character takes part in (else the world's latest) is read at roll time.

**Rolls are immutable.** A denial set after a roll never touches that roll: the roll log keeps `2d20kh1` and `(adv: Keen Smell (scent))` exactly as rolled. A later scene without the denial lifts it for later rolls.

Passing `senseDenial` or `wind` **without narration** amends the latest scene: narration, participants, title and labels are inherited and the reply says so (`inherited: ['narration', 'participants']`). The amendment also keeps whichever of `senseDenial` and `wind` it did not restate (a denial stated after a wind still overrides that wind; a wind stated after a denial does not lift it); `senseDenial: []` clears the denial. A new frame (narration given) carries neither forward. A denial that names no sense (`{targetId}` alone) is refused with nothing written. With no scene to inherit from the call is refused and nothing is written. The agent scene slice prints `WIND:` and `SENSE DENIED:` lines, so NPC agents play the same weather.

### Wind (optional)

```
scene_manage set {worldId, wind: 'from W'}
```

With a wind on the scene and both characters placed as tokens in an active fight, the engine computes the relation itself: a source **downwind** of the sniffer has its scent carried away (`Ratling is downwind of Varek (wind from W): the scent is carried away` — treated as a denial and quoted), **upwind** carries (`the scent carries`), crosswind decides nothing. Without positions the wind is noted (`wind: {from, relation: 'unknown'}`) and decides nothing. An explicit `senseDenial` always overrides the wind. Compass convention: east is +x, north is −y (map rows grow downward). `from W` / `from the north-east` / `E` / `north wind` all parse.

### Passives

`character_manage get` and `get_status_block` carry `passive: {perception: 11, senses: [{when: 'scent', trait: 'Keen Smell', value: 16, label: 'passive Perception (scent) 16'}]}`; the status block prints `PASSIVE Perception 11 · Perception (scent) 16`. The passive is `10 +` the one Perception number (the override column when set), plus the trait's `passiveBonus` (5 by default, advantage on a passive) for the sense.

**Hiding, sneaking, ambushing.** `opposed {skill: 'stealth', targetSkill: 'perception'}` compares the Stealth total to every sense passive the scene does not deny: a total below `passive Perception (scent) 16` is noticed whatever the active roll said — `passiveCheck {sense, trait, passive, vs, noticed}`, `decidedBy: 'passive Perception (scent) 16'`, winner `defender`. A denied sense reports `passiveCheck {sense, trait, denied: reason}` and the roll alone decides. `roll_skill_check stealth {against: observerId}` does the same for a hide check against a named observer: `against {observerId, passivePerception, passives, denied?, noticed, by}`.

Hide checks are compared like a DC: a Stealth total equal to the passive is not noticed by it.

### What the engine does not decide

Whether a check is scent-based is the GM's call; the tag is that call. The engine never infers a tag from the narration. Stunts (`improvisation_manage stunt`) do not read `context` in this release; roll the check through `math_manage` when a trait should fire.
