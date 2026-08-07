# 0031 — A trip is visible when it has departed, not when the export says Completed

- **Status:** Accepted
- **Date:** 2026-08-07
- **Contributors:** Markus (reported the symptom: not all his train trips show on the Tog stream) + Claude (agent decision throughout — no human input on the technical choice: diagnosed the `status` predicate against the live site and the live store, established that the import's dedupe key omits `status` so the column can never be corrected by re-export, chose departure time as the single gate, and rewrote the lane test to pin it)
- **Affects:** `src/stream/lanes.ts`, `src/stream/lanes.test.ts`
- **Topics:** trains, stream, ingest, data-quality, filtering

Amends [0018](0018-publish-the-archive-as-a-public-stream.md) and
[0027](0027-read-a-journey-forwards-in-chapters.md), both of which stand.

## Context

`meg.msge.no/kjelde/tog` served 216 of the 229 trips in `train_trips`. Its newest card
was **14 June 2026** — 54 days stale — while Markus was mid-journey on Torucon 2026,
having taken the Bergen → Oslo S night train on 6 August and Oslo S → Trondheim on the
morning of the 7th. Neither leg appeared.

The 13 missing rows were exactly the ones with `status = 'Planned'`. Nothing else was
wrong: walking every `?etter=` page returned 216 cards, so the keyset pagination was
whole and the import dedupe had dropped nothing.

The lane held two predicates:

```sql
t.status IS DISTINCT FROM 'Planned'   -- "A planned journey is intent, not activity"
t.departure_at <= now()               -- notFuture()
```

The tell was that the two trip surfaces already disagreed. `loadJourneys` /
`loadJourney` gate on `departure_at <= now()` alone and never look at `status`, so
`/reise/torucon-2026` was live and listing both legs with their posts attached, while
`/kjelde/tog` behaved as though the journey had not happened.

## Status is a snapshot, not a state

The reason a stale status never heals is not visible from the lane, and this is the
part worth writing down.

`train_trips.status` comes from a viaduct.world CSV export. viaduct only flips a leg to
`Completed` on the *next* export — so a leg imported before departure arrives as
`Planned`. That much is merely stale. What makes it permanent is the import:

```ts
// parse-trips-csv.ts
const dedupeKey = createHash('sha256')
  .update([fromStation, toStation, departureLocal, trainCode ?? '', r.journey ?? ''].join('|'))
  .digest('hex')

// admin/import.ts
.onConflictDoNothing({ target: trainTrips.dedupeKey })
```

`status` is not in the key. Re-exporting after the journey produces the *same* key, hits
the conflict, and writes nothing. **The column is write-once**: whatever the CSV said
the first time a leg was seen is what it says forever, and no supported path can change
it. Excluding `Planned` was therefore not a stale filter but a permanent blacklist of 13
real journeys — one that would have grown with every import made before departure.

So "just re-export from viaduct" was never a fix. Anyone reaching for it will find the
insert silently doing nothing.

## The wishlist analogy was the trap

The deleted comment said the exclusion was "the same call as NeoDB wishlists", pointing
at `marksLane`'s `m.status IS DISTINCT FROM 'wishlist'`. That reads as principled and is
how the predicate would survive review. It is not the same call:

- A NeoDB shelf status is authored by Markus and **upserted live** on every
  Create/Announce/Update (ADR 0011). It tracks reality.
- A viaduct status is a **frozen snapshot** of one CSV row, unreachable by any later
  write.

Filtering on a field that updates itself is sound. Filtering on one that cannot is a
blacklist wearing a filter's clothes. `marksLane` is left alone.

## Decision — departure time is the only gate

The `Planned` predicate is removed from `tripsLane`, leaving `notFuture` as the sole
gate. This is not a loosening: `notFuture` is already what stopped "three months of
trips he has not taken" from leading the front page, which is the job the status
predicate appeared to be doing. It was redundant for future trips and wrong for departed
ones.

A trip is activity once it has left the platform. That is a fact about the clock, and the
clock is the thing to ask.

## Consequences

- `/`, `/kjelde/tog`, `/type/trip`, `/arkiv/:year/:month`, `/feed.atom` and
  `/sitemap.xml` are all fed by this one lane and are fixed together. Journey pages were
  never broken and do not change — the two surfaces now agree, which is the real
  acceptance criterion.
- Future trips are still hidden. The 8–30 October `Kaizershausten 26` legs stay off the
  page until they depart, one leg at a time.
- The store holds exactly two statuses (216 `Completed` + 13 `Planned` = 229). There is
  no `Cancelled`, so nothing abandoned can resurface. **If a `Cancelled` ever appears in
  an export it needs its own predicate — not a revived `Planned` one**, and it would need
  the dedupe key fixed first, or it could never be recorded either.
- The lane test no longer asserts the string it used to; it asserts that the lane never
  reads `status` at all. Blunt on purpose: on a lane whose only table is `train_trips`,
  that is the strongest thing a rendered-SQL assertion can say.
- `getTrainStats`'s "next upcoming trip" still pairs `status = 'Planned'` with
  `departure_at >= now()`. Harmless today — write-once means a future leg really is
  `Planned` — but it is the same shape, and if it ever misses a trip this is why. Left
  untouched deliberately; it is an MCP query surface, not the stream.
