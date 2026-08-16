# 0048 — A trip is when it left and between where

**Status:** Accepted
**Date:** 2026-08-16
**Topics:** trains, viaduct, ingest, identity, dedupe, data-quality, migration
**Contributors:** Markus (reported the symptom — Torucon 2026 showing four travelled legs and four leftover planned ones — wrote the identity rule, and chose both open questions: journey out of the key, and status taking the incoming value) + Claude (agent decision on the merge ranking, the idempotency guard, the derived-cache invalidation, and on collapsing inside the migration rather than in a script)

Amends [0031](0031-a-trip-is-visible-when-it-has-departed.md), which stands. Its
diagnosis was right and its conclusion — that the lane must gate on departure time
rather than on `status` — is untouched. What no longer holds is the sentence
**"the column is write-once"**: this record is what makes `status` writable.

## Context

`train_trips` identified a trip by a SHA-256 of
`from | to | departure_local | train_code | journey`, applied with
`ON CONFLICT (dedupe_key) DO NOTHING`.

Two failures fall out of that, and both were in the live data.

**Train code is in the key and is not stable.** viaduct exports a leg with no train code
while it is planned and with one once it has been travelled. So the planned row and the
travelled row hash differently, and the same physical journey is stored twice. The same
happens between sources that name a service differently — `RER A` and `18568` for one
Paris RER leg, `S S3` and `3089` in Berlin.

**Nothing but the key is in the key, and the action is DO NOTHING.** Every other column
is therefore write-once, which is exactly what ADR 0031 recorded. A re-export cannot
correct a status, a delay, a distance or an arrival.

On 16 August 2026 the store held **165 rows for 2026 describing about 88 real legs** —
77 legs present twice. It went unnoticed because in older journeys both copies read
`Completed` and the duplication was invisible in a list. Torucon 2026 is where it
surfaced: four legs, each with one `Completed` copy and one stale `Planned` copy.

Two pairs decided how a merge has to work:

| Journey | Leg | Copy A | Copy B |
|---|---|---|---|
| Kaizershausten 26 | København → Praha | `1176 km`, no code | `1172 km`, `RJ 385` |
| Torucon 2026 | Bergen → Oslo S | `Planned`, `D 606` | `Completed`, no code |

The first says "keep the richest" is not a rule until the tiebreak is stated: both
distances are present and they disagree. The second kills the obvious shortcut of
preferring the completed row wholesale — the train code is on the *planned* copy. The
merge has to be per attribute, with the status settled separately.

## Decision

**A trip is `(from_station, to_station, departure_at)`.** A unique index says so, and
the import upserts onto it. Train code, operator, distance, travel class, delay and
journey are attributes of a trip, not part of it.

**`departure_at`, not `departure_local`.** It is `timestamptz` — the absolute instant,
computed at insert from the wall clock and the origin's IANA zone. That is the single
explicit timezone the comparison happens in, so two exports cannot split one trip on an
offset difference. The wall clock would have been immune to the origin *changing* which
zone it names, which `departure_at` is not; the instant won because it is the thing that
is actually the same about the same departure, and because every duplicate pair in the
store already agreed on it exactly. The residual risk is narrow and specific — the parser
assumes `UTC` when the export names no `from_station_tz`, and an export that stopped
emitting that column would shift every instant — so `TripRow.tzAssumed` now carries it
and the importer warns rather than assuming quietly.

**Journey is not in the key.** Markus' call. It means renaming a journey between exports
updates the leg instead of duplicating it, which is the behaviour the identity rule
implies. Two legs cannot share an instant and both stations without being the same leg.

**On a match, an incoming value wins; an incoming null defers.** `coalesce(excluded.c,
stored.c)` for every attribute, so an export that happens not to name the operator leaves
the stored one alone. `status` follows the same rule rather than a special one — also
Markus' call, and the literal reading of the story. The accepted cost is that
re-importing an older, still-`Planned` export would pull a travelled leg back to
`Planned`; the alternative considered was a never-downgrade rank, and it was not taken.

Three columns do not follow the plain rule:

- **Amenities** (`cycling`, `wifi`, `dining_car`, `night`, `replacement`, `reservation`)
  are `NOT NULL DEFAULT false`, so an absent flag is indistinguishable from a denied one
  and there is no null to coalesce through. They OR.
- **Arrival** moves as a unit — `arrival_local`, `arrival_at` and `to_tz` all keyed on
  the incoming `arrival_at` being present — so the wall clock, the instant and the zone
  it was computed in can never come from different exports and disagree.
- **`raw`** follows the newest export. It documents where the current status came from;
  a spliced-together `raw` would describe no export that was ever delivered.

**A repeat import writes nothing.** The `DO UPDATE` carries a `WHERE` built from the same
pass that builds the `SET`, comparing each resulting value to the stored one with
`IS DISTINCT FROM`. Without it, re-importing an unchanged export would rewrite every row
with its own values — no visible difference, but not the no-op the import claims to be.

**Every write is logged, one line per row.** `RETURNING (xmax = 0)` distinguishes a tuple
this statement inserted from one it updated, which is the only way to tell an insert from
a match after the fact. An insert that should have been a match is the failure this
change is guarding against, and it is only cheap to spot if it was logged.

**The collapse of the existing 77 duplicates lives in migration
`0035_a_trip_is_when_and_between_where`, not in a script.** Migrations run at container
start, so a migration that only added the unique index would abort the boot of any
database still holding a pair. Within each group the rows are ranked by *most advanced
status, then having a train code, then most recently imported*, and each column takes the
first non-null value in that order — which yields `Completed` + `D 606` for the Torucon
leg and `1172 km` + `RJ 385` for the Kaizershausten one. `status` is the most advanced
anywhere in the group regardless of which row won, so a `Planned` copy cannot pull a
travelled leg back. Unlike the live import, the migration leaves `raw` alone: provenance
that has been edited is not provenance, the rule `src/jobs/rebase-gig-origin.ts` records.

## Consequences

- `train_trips.dedupe_key` and `train_trips_dedupe_idx` are **dropped**. Keeping the hash
  beside the tuple would leave two contradictory notions of identity in one table, which
  is the foot-gun ADR 0031 flagged when it noted that a future `Cancelled` status "would
  need the dedupe key fixed first". Nothing outside the import ever read the column.
- `train_trips_pre_dedupe` is a **full** copy of the table as it stood before the
  collapse — not just the doomed rows, because the survivors are mutated too and only a
  whole copy makes the pre-state recoverable. It is deliberately absent from
  `src/db/schema.ts`; a later migration should drop it once the result is confirmed.
- **A merged trip's cached route is dropped, in both the migration and the import.**
  `resolveTripLines` only revisits a trip whose `trip_routes` row is missing or predates
  the current registry version (ADR 0035), so a refreshed `distance_km` would otherwise
  leave `scale_factor` and the per-line kilometres scaled against a distance that no
  longer exists. Nothing else in the system would ever have recomputed them.
- `linkTripPosts()` now runs after an update as well as an insert, because a refreshed
  arrival moves the trip's window (ADR 0023).
- `TripImportResult` gains `updated` and renames `skipped` to `unchanged`; the admin
  import result page shows the count only for the trips importer, which is the only one
  that matches and refreshes in place.
- `get_train_stats` and `get_train_trips` need no change — they aggregate rows, and there
  is now one row per leg. The `upcoming` card's unfiltered `status = 'Planned'` read,
  which ADR 0031 flagged as the one place a frozen status was still trusted, becomes
  correct for the first time now that the column can move.
- The parser has a test for the first time (`src/lib/parse-trips-csv.test.ts`), and the
  upsert's shape is asserted as rendered SQL (`src/admin/import-trips.test.ts`) in the
  style of `media-query.test.ts` — including that every column the `SET` writes appears
  in the idempotency guard and nothing beyond them, so the two cannot drift apart.
- Verified before shipping against a throwaway PostgreSQL 16 with the production
  duplicate shapes seeded: 14 rows collapse to 8, Torucon reads `Completed` + `D 606`,
  Røros is untouched, and the index then refuses a second copy. The import round-trip was
  run the same way — six planned legs insert, re-import writes nothing, the travelled
  export updates all six in place without inserting, a blank operator does not erase the
  stored one, and `RER A` → `18568` updates rather than duplicating.
