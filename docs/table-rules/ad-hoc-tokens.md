# Ad-hoc tokens: stats, ids, bands and the initiative order

Play report 7, items 2, 3, 4 and 9. A token built by hand at `combat_manage create` or `add_participant` (the hounds, the militia, the bargemen) carries the numbers the GM gives it, answers to the id the GM gives it, gets its band the moment it is created, and the create reply says the order the fight runs in.

## Ability scores (#2)

`create` participants and `add_participant` take either spelling:

```
stats: {str: 15, dex: 14}                 the sheet's short keys
abilityScores: {strength: 15, DEX: 14}    long or short keys, any case
```

- Missing scores are 10. On `add_participant {creature}` the scores sent override the creature's own, one by one; the rest stay the statline's.
- `initiativeBonus` defaults to the DEX modifier when scores are given and it is not (a creature keeps its own unless DEX is sent).
- An unknown key (`agi`) is refused with the six valid ones, and one ability given two different values (`stats {str: 15}` beside `abilityScores {strength: 13}`) is refused. Nothing is written either way (`writes: 'none'`).
- A sheet-backed token (a `characterId`, or a create participant whose id is a character row) keeps its sheet's scores. The reply's `warnings` says so and names `character_manage update {characterId, stats}`.
- Grapple contests, saves, the shove DC and the attack and AC fallbacks read them. Hounds built with `stats: {str: 15}` contest a grapple at +2.
- The create reply echoes `abilityScores` on each participant that was given them; `add_participant` echoes them on `participant`.
- A participant key create does not take (`str` beside `stats`, `speed`) is named as a dotted path in `ignoredParams` (`participants[1].str — an ability score: pass stats: {str: …}`), and the banner prints the note once.

## Token ids (#4)

`add_participant {id: 'hound-1', …}` names the token later calls use (default `token-xxxxxxxx`): letters, digits, `_ . : -`, 64 at most. Refused, with nothing written, when the id:

- is already in this encounter;
- is `LAIR` (the lair's turn-order slot);
- is a character row's id and `characterId` is absent (the row would sync to the token: HP, saves, death). Pass `characterId` to bring the sheet in;
- differs from the `characterId` given (a sheet-backed token's id is its character id).

`add_participant {creature, count: 3, id: 'rat'}` makes `rat-1`, `rat-2`, `rat-3`. A `characterId` already in the fight is refused instead of doubling the token, and `create` refuses two participants with one id, or one named `LAIR`.

## Bands (#3)

A token gets its band the moment it is created, in this order:

1. An explicit `band` on the token.
2. Inherited: a `characterId` takes the sheet's band, a `creature` the bestiary entry's, a `spawn_quick_enemy` preset its own.
3. Nothing to go on: the world's lowest band, marked assumed. That is the first entry of the band ladder the fight's bands sit on: the band rule holding every band the fight already carries (the tokens already in it, and the new ones' own or their sheets'), the same ladder the band checks read; else the world's first band rule by name. In a world that imported both day-366's `bands` and orruk-waaagh's `orruk-bands`, an orruk fight's ad-hoc grots are assumed `Grot` and the Boss can execute one; a fight with Astartes and orruks in it falls back to `bands` (`Mortal`), and the warning names the other ladder.

The reply names every assumed token: `bandAssumed: [{id, name, band}]` and a warning line, `3 tokens have no band; assumed Mortal: Hound ×3. Set band if they're stronger: combat_manage set_band {…}`. The state view shows `🏷 band Mortal (assumed)` and `bandAssumed: true` until someone sets it.

A sheet with no band is never assumed (a named character is not guessed); the reply names it with the fix, `character_manage update {characterId, band}` or `set_band` for this fight.

A band (given, or from the sheet) that is on none of the world's ladders (`'Mortel'`) can never be ranked; the reply names it before play, with every ladder and the `set_band` call, instead of execute finding out mid-fight.

Every band-dependent result against an assumed token prints `(band assumed)`: execute, a called strike, CONSEQUENCE DUE, cleave, grapple's lower-band disadvantage, band-scaled damage (a unit under an area included: `×1.5625 band per model (6 → 9) (band assumed)`) and the per-band growth credit (even when the step added nothing: a higher real band would have paid more). A wrong assumption is visible the first time it matters.

Nothing is assumed in a world with no band rule, or when no world resolves. A world that would rather refuse sets `table_rules define {kind: 'band', name, spec: {order, requireBand: true}}`: create, add_participant and spawn_quick_enemy then refuse an unbanded ad-hoc token, naming the ladder and the fix.

`combat_manage set_band {encounterId, participantId, band, reason?}` changes a token's band mid-fight. The band must be on one of the world's ladders (any case); an unknown one is refused, naming the order (every ladder, when the world has several). It applies from the next roll on, never to one already made, clears the assumed mark and is logged. Every band refusal (execute, called strike, cleave) names the `set_band` call. When both bands are set but no one ladder holds them both, the refusal says so (`Gorrakh (Boss) and Hound 1 (Mortal, assumed) share no band ladder in this world`) instead of calling a band unset, and the order it prints is the other side's ladder, so the `set_band` it names moves the token onto it.

The engine never infers a band from HP, CR or size.

## The initiative order (#9)

`create` (and `spawn_quick_enemy`, which shares its path) replies:

```
initiative: [{id, name, roll, modifier, natural?, given?, surprised?}]   turn order; LAIR is {id: 'LAIR', roll: 20, lair: true}
firstUp:    {id, name, roll}                                            after any surprised slot has passed
🎲 Initiative: Gor 19 · Mira 14 (given) · Hound 1 9 — FIRST UP: Gor. Tell the table the order before resolving the first turn.
```

`natural` is the d20 (roll minus modifier); a pre-rolled initiative is `given` and has none. `output_mode: 'summary'` keeps `initiative`, `firstUp` and `warnings` whole (25 rows at most, the rest counted); a `fields` projection gets them only when asked.

`add_participant` (and a spawn into a running fight) reports each joiner's `initiative: [{id, name, roll, modifier, natural, position, of, firstRound}]` and says it in the message: `initiative 14 (d20 13 +1), 2nd of 3 in the order, acts this round`. The order keeps the current turn where it is, so a joiner whose slot sits before the current actor's first acts next round: `…, first turn in round 3 (its slot has passed this round)`.
