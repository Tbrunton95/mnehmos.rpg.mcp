# Party upkeep: one pool, mouth-days

A warband eats. The engine keeps the stores in **one** character pool and charges it as the world clock moves; the party row holds only the link, who eats, what a hungry day does and the last day charged. Nothing about stores is written twice.

## Units

Stores are **mouth-days**. One mouth eats 1 a day; a unit of 10 models eats 10. There is no `perDay` rate to set and nothing to convert: `stores / mouths = days left`, in whole days.

Mouths per day are counted **live** each time a day is charged:

| Who | Counts as |
| --- | --- |
| Every party member of a counted role (default: all roles) | `unitModels ?? 1` |
| Each linked mouth pool (`mouthsFromPool`) | the pool's `current` |
| `extraMouths` | the number given |

So captives taken, Turnings made and members killed change tomorrow's draw without a hand update: keep the captives in a pool and link it.

## Before you link: the old-unit warning

A stores pool kept in another unit reads wrong here and starves people early. The Varek camp kept `stores` in **camp-days for 10 mouths, max 60**; in mouth-days that is 600, not 60. Every `set_upkeep` and `muster` reply prints the linked pool against today's mouths (`200 mouth-days at 18 mouths = 11 days`) so a wrong unit shows before anyone goes hungry.

Convert first, then link:

```
character_manage adjust_pool {characterId: 'varek', pool: 'stores', value: 200, max: 600, label: 'Stores (mouth-days)'}
```

`value` is the retry-safe absolute set. Never link a pool still in old units.

## set_upkeep

```
party_manage set_upkeep {
  partyId,
  linkPool: {characterId: 'varek', pool: 'stores'},
  mouthsFromPool?: [{characterId: 'varek', pool: 'captives'}],
  extraMouths?: 0,
  countRoles?: ['leader', 'member', 'companion', 'hireling', 'prisoner', 'mount'],
  starvation?: {loyaltyDelta: -1, perDay: true},
  startDay?, clear?, worldId?
}
```

- **Needs the world clock.** The party's world must have a day set, or the call refuses with the usual hint to `world_manage update {worldId, environment: {day, time}}`. Pass `worldId` for a party that has no world (or to move it): it is written to the party, and that world's clock drives upkeep from then on.
- **Refuses a pool the character does not carry.** Both the stores pool and every mouth pool must already exist on the sheet; the refusal names the `adjust_pool` call that creates it. Nothing is written on a refusal.
- **Starts from today.** `lastDay` is set to the current clock day, never day 0, and the reply says so: *"upkeep starts from Day 47; nothing before it is charged."* The first `advance` charges only the days after it.
- **Re-running keeps the anchor.** A second `set_upkeep` on the same party (to add a mouth pool, change `extraMouths`, narrow `countRoles`) keeps `lastDay` and says *"upkeep continues from Day 49"*; pass `startDay` to move it. Omitted fields keep their stored values; `extraMouths: 0` and `countRoles: []` reset those two.
- **`clear: true`** unlinks the pool and leaves its value alone.

The reply carries `stores {characterId, pool, current, max}`, `mouths {total, members, pools: [{pool, mouths}], extra}`, `daysLeft`, `startDay`, the stored `upkeep` and a `unitsNote`.

## What a day costs, and a hungry day

Every whole day charges `mouths` from the pool, through the pool's own history (`get` shows `upkeep The Host: 3 day(s) × 18 mouths`). A day the stores cannot cover is a **starving day**: the stores go to 0 and loyalty moves by `starvation.loyaltyDelta` (default -1) for every member **except the leader and the mounts**. Prisoners and hirelings go hungry like everyone else.

- `perDay: true` (default): every starving day docks again.
- `perDay: false`: docks once when a shortfall begins, and again only after a fed day.

Loyalty is the same 0-10 number `pay` and `after_battle` move; `muster` shows `wavering` at 0.

## What advance reports

`world_manage advance` charges every party of the world whose upkeep has days to charge, **beside** the exposure timers, and reports each one:

```
upkeep: [{partyId, name, days, storesFrom, storesTo, mouths, starvedDays, loyalty: [{characterId, name, from, to}]}]
```

with a line in the message: `upkeep: The Host 200→146 (3d × 18)`, or `The Host 20→0 (2d × 18) STARVING 1d, loyalty -1 ×3`.

- A day is charged when the clock crosses midnight into it: 12 hours from 06:00 charges nothing, the next 12 charge one day. The anchor is `lastDay`, so an `advance` after a plain `update` that moved the clock charges every midnight since the last charge.
- Travel and montage time eat stores because `spatial_manage traverse {advanceClock}` and `improvisation_manage montage {hours}` go through advance; their replies carry the same lines (`clock.upkeep` on traverse, `timePassed.upkeep` on montage) and the traverse message ends `; upkeep: Kor Band 50→49 (1d × 1)`.
- **Corrections never charge.** `update {correction: true}` and `era_jump` that change the **day** move the anchor with the clock (reply `upkeepAnchored: [{partyId, name, from, to}]`, on the era_jump reply too) so a fixed clock or a jump of years starves nobody; the next advance charges only the days it crosses. A correction that leaves the day alone (weather, time of day) leaves the anchor alone: a hand tick ahead stays paid, and the midnights a plain update skipped stay owed.
- A linked pool that has since been removed charges nothing and says so in the line; re-link it or `clear`.

## By hand

`party_manage upkeep {partyId, days}` charges whole days without reading the clock and moves `lastDay` by the same count; the clock catches up to it before charging again. Use it for a stretch that passed outside `advance`. The pool itself is still adjusted with `character_manage adjust_pool` (a resupply is `{delta: +120, reason: 'the Sluice granary'}`); there is no `adjust_stores`.

## muster

`party_manage muster` adds, when upkeep is set:

```
upkeep: {stores: {characterId, pool, current, max}, mouths: {total, members, pools, extra}, daysLeft, lastDay, starving, starvation}
```

and the message ends `stores 200 mouth-days / 18 mouths = 11 days (upkeep from Day 47)`, with `STARVING` while a shortfall is running (stores under today's mouths after a starving day); a refill through `adjust_pool` ends it on the spot.
