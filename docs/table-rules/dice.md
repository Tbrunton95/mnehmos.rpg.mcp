# Dice: crypto by default, seeded on request

Every die the engine rolls comes from `crypto.randomInt` unless a call passes `seed`. That covers encounters (initiative, attacks, recharge, saves), `combat_manage` quick spawns and `apply_damage`, `math_manage roll / check / reroll / pool`, concentration, stunts, synthesis, rests, potions, travel events, theft, perception, auras and random encounters. Nothing in the tool layer uses `Math.random`, and a test fails the build if any comes back.

## Reading a roll

Every roll lands in the roll log with who it was for, why, the dice, the result, a `source` and an audit key:

| source | audit key | meaning |
| --- | --- | --- |
| `crypto` | `crypto:<8 hex>` | drawn from the OS entropy source; unique per roll, never replayable |
| `seeded` | `<seed>` or `<origin>@<draw>` | a deterministic stream; the same key replays the same dice |

Encounter and math replies say which they used: `dice: 'crypto'` or `dice: 'seeded:<seed>'`.

## When to seed

Pass `seed` only when you want an exact replay: a test, an audit of a disputed fight, a demo. A crypto audit key passed back as a seed is refused, because it cannot be replayed. In play, never seed.

## The fairness audit in one call

```
session_manage rolls {worldId, stats: true, since?: '2026-10-01', purpose?: 'attack', source?: 'crypto'}
```

returns the d20 faces, `count`, `mean` (expect 10.5), `nat20`, `nat1`, `chi2` against the 95% cutoff `30.144`, and `biased: true | false`. The Deep One audit did this by hand across 1,155 faces; now it is a read.

Other filters: `forId`, `encounterId`, `forOpId`, `purpose` (case-insensitive match), `limit` (default 20, max 200).

## Two processes, one database

Claude Desktop runs two engine processes on one campaign database. Every call takes the write lock and reads the encounter fresh, so the two never roll the same dice. In crypto mode the audit keys are unique across both; in seeded mode each process advances the same stream from the stored position. `tests/server/operation-guard-multiprocess.test.ts` proves both.
