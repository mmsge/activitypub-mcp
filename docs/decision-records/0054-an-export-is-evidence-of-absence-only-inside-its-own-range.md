# 0054 — An export is evidence of absence only inside its own range

**Status:** Accepted
**Date:** 2026-08-20
**Topics:** trains, viaduct, import, deletion, data-quality, safety, configuration

**Contributors:** Markus (reported the symptom — a phantom `Oslo S → Hamar` 07:34 leg
sitting beside the real 06:34 one — and decided all three of: the two-step confirm on
the result page rather than a checkbox on the form, the 20% / ≤3 threshold, and that a
pruned trip is recorded as a log line rather than an archive table) + Claude (agent
decision on the coverage window, the plan/apply split, the canonical UTC text key, and
the window-population gate on the floor)

**Affects:** `src/lib/trip-prune.ts`, `src/admin/prune-trips.ts`, `src/admin/import.ts`,
`src/admin/router.tsx`, `src/admin/views/import.tsx`, `src/config.ts`,
`src/lib/trip-webhook.ts`

Extends [0048](0048-a-trip-is-when-it-left-and-between-where.md) and
[0053](0053-the-import-wakes-the-profile-it-feeds.md), both of which stand.

## Context

[0048](0048-a-trip-is-when-it-left-and-between-where.md) made a trip an identity —
`(from_station, to_station, departure_at)` — and made a re-export *improve* a stored
trip instead of duplicating it. It said nothing about absence, because absence had
never been a signal. The importer inserts and updates, and has no third verb.

So viaduct is only half a source of truth. Delete a leg there, or correct its departure
time, and the stored row survives forever — and because a corrected row lands on a
different identity tuple, it arrives *beside* the old one rather than replacing it.
Read out of the archive on the day this was written:

| departure (UTC) | local | from → to | journey | status | km |
|---|---|---|---|---|---|
| `2026-08-20T04:34Z` | 06:34 | Oslo S → Hamar | Røros 2026 | Planned | 125 |
| `2026-08-20T05:34Z` | **07:34** | Oslo S → Hamar | Røros 2026 | Planned | 125 |

The 07:34 leg does not exist in viaduct. It does three things, and only the first is
merely a wrong number:

- It inflates trip count and distance, and appears on the journey pages.
- `trip_posts.object_ap_id` is unique — one trip per post (0023) — so of the two legs
  exactly one gets the togselfie. The matcher prefers `aboard` over an edge, and a post
  made at 08:00 is `aboard` the phantom while merely *alighting* the real leg. The
  phantom takes it.
- `bartenderen` renders `Neste togtur` from this table (0053). A phantom **future** leg
  is precisely the row it advertises.

**A CSV carries no tombstones.** Absence is the only deletion signal there is — and
absence only means anything where the file has coverage, because a filtered or
truncated export is nothing *but* absence. That asymmetry is what every rule below is
built around.

## Decision

**The window is the export's own range.** Only a trip departing between the earliest
and latest departure *in the file* is eligible. `pruneWindow()` is a pure function of
the file and nothing else — no stored row can widen it — and the stored read is bounded
by what it returns, so a partial export cannot reach a single trip outside what it
describes. The 2025 Bergen → Oslo S leg is untouchable by an export covering one day in
August, however absent it is from that file.

**The importer never deletes, and cannot be asked to.** `importTrainTrips()` plans a
prune on every run and applies none. Applying one is `applyTripPrune()`, which only
`POST /admin/import/trips/prune` reaches. "A plain import writes exactly what it wrote
before this record" is therefore a property of the call graph rather than of a boolean
nobody can see from the call site — which is what a `{ prune: true }` option would have
been.

**Two steps, not a checkbox.** Markus' call. The import reports; the result page lists
every candidate with its stations, departure, journey, train code, status and distance;
a confirm button posts them back. The ids and the range are client-supplied, so
everything the page claimed is re-established server-side before anything is deleted:
each trip must still be stored inside the posted range, must not have been stored
*after* the plan was drawn (`derivedAt` — the leg re-added in viaduct between the two
clicks was never on the page the admin read), and the threshold is re-applied against
the window as it stands now. The posted list can therefore only ever *narrow* what
goes. A refusal renders no confirm form at all: a button beside the explanation would
make the threshold advisory.

**The threshold is a share of the window, with a floor that needs a populated one.**
`TRIP_PRUNE_MAX_SHARE` (0.2), `TRIP_PRUNE_MIN_CANDIDATES` (3),
`TRIP_PRUNE_MIN_WINDOW` (10). Refuse when the candidates exceed the share, unless the
window holds at least `MIN_WINDOW` trips and the count is within the floor. Strictly
more refuses, so 20 of 100 passes and 21 does not.

The gate on the floor is the part that is not obvious, and it was nearly not there.
Markus chose "20%, floor of 3" so a narrow correction would not be blocked by its own
small denominator — but a narrow window is exactly where a *filtered* export looks
identical to a correction. Export one journey's two legs over a window that also holds
two legs the filter omitted, and 2 of 4 is half the window, waved through on the
strength of `2 ≤ 3`. Meanwhile the case that motivated all of this needs no floor at
all: against a full export the window holds ~230 trips and one deletion is 0.4%. So the
floor applies only where "3" is genuinely a small number.

**Identity is compared as canonical UTC text, rendered by Postgres on both sides.**
`departure_at` is an instant derived from a wall clock and an IANA zone, and 0048 is
emphatic that the derivation lives in Postgres — so the incoming side is resolved by a
query too, and both sides go through `to_char(… at time zone 'UTC', 'YYYY-MM-DD
HH24:MI:SS')`. A `Date` on one side and a timestamptz literal on the other would not
fail loudly; it would make *every* stored trip read as absent. And the obvious repair
is itself unsound: a Postgres timestamptz literal is not ISO-8601, so `new Date()` on
one is implementation-defined.

That resolution query has to exist. It cannot be salvaged from the upsert's
`RETURNING`, because 0048's idempotency guard means an unchanged row is not returned at
all — which is precisely the re-import case the prune has to handle. Its parameters are
cast **inside** each `VALUES` row: Postgres resolves the rowtype before the outer
select's casts and postgres-js sends strings with no type OID, so casting outside is
the classic *failed to determine data type of parameter $1*.

**The log line is the record.** Markus' call: no archive table and no schema change, so
one `info` line per pruned trip carries its id, both stations, the departure instant and
wall clock, the arrival, journey, train code, status, distance, when it was first
stored, and the posts it was holding — enough to re-enter it by hand. It is logged from
the delete's `RETURNING`, not from the read a moment earlier, so it describes the row
that went rather than the row that was intended. Candidates are logged on the *report*
run too: the page is one route away from being closed and forgotten.

**Posts are re-bound, never orphaned or deleted.** `trip_posts.trip_id` already
cascades, so the link goes with the trip; `linkTripPosts()` then re-derives and the
togselfie lands on the leg it was actually made on. `objects` is untouched throughout —
only the derived link moves, which is the separation 0023 drew.

**The webhook counts deletions.** `notifyTripsChanged(deleted)` on the confirm, and
still `inserted + updated` on the report, which deleted nothing. 0053's fire-on-change
rule is unchanged; what changes is that a prune is the case it matters most for, since
the row removed is very often the one `bartenderen` is currently advertising.

**A by-product: the in-file dedupe now keys on the identity rather than a proxy for
it.** It keyed on `(from, to, departure_local, from_tz)`, whose comment claimed to be
"the identity tuple spelled in the columns the CSV actually carries". It was not. Two
rows spelling one instant differently — `07:34 Europe/Oslo` and `05:34 UTC` — survived
that key, collided on the conflict target, and Postgres would kill the whole statement
with *"ON CONFLICT DO UPDATE command cannot affect row a second time"*. Resolving the
instants first makes the real key available, so the fix is free.

## Consequences

- **A leg deleted at the earliest or latest departure in an export is unprunable.**
  Removing it shrinks the next export's range past itself, so it falls outside its own
  coverage. Inherent to the window rule, not a bug; it goes when an export whose range
  covers it arrives.
- **The log is the only record, so log retention is now the retention policy for
  deleted trips.** On the box that is 30 days of raw lines.
- **The delete and the re-derivation are not atomic, and must not be.**
  `linkTripPosts()` calls `getDb()` itself, so a transaction here would run it on
  another pooled connection that cannot see the uncommitted delete — worse than having
  none. A post is therefore briefly unbound. The apply path re-reads exactly the posts
  the cascade released and logs any the re-derivation did not claim, which is what
  makes the gap visible rather than silent.
- **A post that matched only the pruned trip becomes correctly unbound.** That is the
  right answer, not an orphan: it was on a train that never existed.
- **`stations` and `station_weather` are not collected by a prune.** They have no
  foreign key to trips, are keyed by name, shared between legs, and `sync-stations` is
  additive. A station only the phantom visited simply stays.
- **A filtered export is now a dangerous input in a way it was not before.** The
  threshold is the first defence and the two-step confirm is the second. Nothing stops
  an admin confirming a plan they did not read.
- **`ImportResultPage` loses its `updated` prop and `/admin/import/result` its `updated`
  query parameter.** The trips importer was their only writer and now renders its own
  page, for the reason the watch-history importer does (0047): a list is the substance
  of this report and will not survive a query string.
- Verified before shipping against a throwaway PostgreSQL 16 with all migrations and
  the live case seeded — the real 06:34 leg, the phantom 07:34 one, a 2025 leg well
  outside every window, and a togselfie the phantom was holding. An export without the
  phantom inserts and updates nothing and names exactly it; the confirm removes it and
  the togselfie moves to the real leg without the post being touched; the 2025 leg
  survives; re-importing the same export writes nothing and proposes nothing; a
  deliberately narrow two-leg export is refused with its reason and deletes nothing,
  through the apply path as well as the report; and a confirm replayed from a plan drawn
  before the leg was re-added declines it instead of deleting it.
