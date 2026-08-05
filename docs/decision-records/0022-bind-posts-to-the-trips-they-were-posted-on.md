# 0022 — Bind posts to the trips they were posted on, in a derived link table

- **Status:** Accepted
- **Date:** 2026-08-05
- **Contributors:** Markus (asked what cross-joins the stored data already supports, and chose to build the trip↔post join first) + Claude (measured the alignment against the live archive, proposed the link table, implemented the derivation)
- **Affects:** `drizzle/0023_trip_posts.sql`, `src/db/schema.ts`, `src/lib/trip-window.ts`, `src/jobs/link-trip-posts.ts`, `src/mcp/tools/trip-posts.ts`, `src/jobs/scheduler.ts`
- **Topics:** trains, posts, joins, derivation, provenance, postgres

## Context

The archive holds six ActivityPub sources plus three local ones, and they share a
single timeline — but nothing joins them. The train trips (229 of them, 53,455 km,
625 hours aboard, imported from viaduct.world CSV exports) and the posts (5,096,
1,385 carrying hashtags) sit in separate tables with no relation, even though a
large fraction of the posts were written *on* those trips.

Measured against the live archive before building anything, the alignment is not
approximate:

| Togselfie posted | Trip | Δ |
|---|---|---|
| 2026-06-04 17:00:41 | København H → Malmö C, dep 16:59 | +1m41s |
| 2026-06-04 18:09:39 | Malmö C → Göteborg, dep 18:04 | +5m39s |
| 2026-06-05 06:10:14 | Göteborg → Oslo S, dep 06:10 | **+14s** |
| 2026-06-14 14:54:23 | Arna → Bergen, arr 14:54 | +23s |

Four of four inside six minutes. The `#togselfie` habit is already a check-in
stream — a photo taken on the platform at the moment of departure — it simply is
not recorded as one. Binding it to the trip gives every one of those posts a
station, an operator, a rolling-stock class, a distance and a delay that nobody
had to type.

Two findings shaped the design:

- **The join is temporal, not semantic.** There is no id, geotag or text field
  linking a post to a trip. `objects.published_at` and
  `train_trips.departure_at`/`arrival_at` are all `timestamptz` — absolute
  instants — so the comparison is sound across the 115 stations and the several
  timezones the trips span. It is the *only* key available.
- **Music is not part of this join.** Every trip window sampled returned zero
  scrobbles: on 2026-06-05 Markus played 18 tracks before the 10:03 departure,
  nothing across seven hours of Bergensbanen, and resumed at 18:13 after the
  17:08 arrival — while posting a togselfie at 14:01, mid-journey. Connectivity
  is not the explanation; he does not play music aboard. A `trip_scrobbles`
  table would be an empty table, so this record does not create one.

## Decision

**Derive the link into its own table, `trip_posts`, and never write it back onto
either side.**

A row says: this post was made `boarding` / `aboard` / `alighting` this trip,
`offset_seconds` from its departure. `train_trips` and `objects` are untouched —
the same separation ADR 0020 drew between `note_date` and `derived_date`, for the
same reason. A post's `published_at` is what Mastodon recorded; the trip it
belongs to is what we worked out, and a later change to the matching rules must
not be indistinguishable from ingested fact.

Four rules keep the derivation honest:

- **One trip per post.** `object_ap_id` is unique. Consecutive legs overlap at the
  edges (Roskilde→Næstved arrives 17:01, Næstved→København departs 17:10 — a post
  at 17:05 is in both windows), so the matcher ranks candidates: `aboard` beats an
  edge, then the smallest gap wins, then the earlier departure, then the id. The
  question "which train was I on" has one answer, and the ranking is total so it
  is always the same answer.
- **Only Markus' own accounts.** The candidate posts come from
  `resolveActorIds()` — the STREAM_SOURCES allowlist — not from `objects` at
  large. `objects` is not "Markus' posts": the Announce handler files a boosted
  post under its *original author*, so an unscoped join would bind a stranger's
  post to Markus' train.
- **Windows are 30 minutes, and stated.** `boarding` is the 30 minutes before
  departure (platform time), `alighting` the 30 minutes after arrival. They are
  constants in `trip-window.ts`, exported so the tests and the ADR quote the same
  numbers rather than two drifting copies.
- **An unknown arrival never invents a duration.** `arrival_at` is nullable. Where
  it is null the trip matches `boarding`, and `aboard` only for the 30 minutes
  after departure — because immediately after departure he is certainly aboard,
  and beyond that we do not know. It never produces `alighting`, since there is no
  arrival to be after.

Visibility is deliberately **not** filtered here. Unlike ADR 0020, where the
derived date became a public fact on meg.msge.no, a link row publishes nothing on
its own; the archive already stores private posts in `objects`. Any public surface
built on this table must apply `publicOnlyOn` itself, exactly as the existing
lanes do.

## Consequences

- Every trip gains its posts and every post gains a journey, retroactively, across
  the whole 2016–2026 span. `get_trip_posts` answers both directions.
- The derivation is idempotent and diff-based: it computes the desired link set,
  compares it to the stored one, and inserts/updates/deletes only what changed. A
  second run reports zeroes. Re-importing the trip CSV or re-ingesting a post
  re-derives cleanly.
- It runs hourly and after a trip import, both of which can move links — a trip
  whose arrival time is corrected re-classifies the posts around it.
- Changing `BOARDING_LEAD_MS` or `ALIGHTING_TRAIL_MS` silently re-classifies
  history. That is the cost of a tuned window; it is why they are two named
  constants in one file and not literals at three call sites.
- A post made on a platform between two legs binds to whichever is nearer, which
  can read oddly for a long connection — it will say `alighting` the arriving
  train rather than `boarding` the departing one when the gap is asymmetric. The
  offset is stored, so a consumer that cares can tell.
- The matching is a pure function over `(postAt, trips[])`, unit-tested against
  the four real alignments above plus the overlap, null-arrival and
  no-match cases. The DB layer only loads, diffs and writes.
- **Every statement goes through the query builder, not a raw `sql` template.**
  The first cut of the job wrote `db.execute(sql\`… actor_ap_id = ANY(${ids})\`)`,
  which is wrong twice over and passes review both times: drizzle flattens the
  array into positional parameters, so `ANY($3)` binds only the *first* actor —
  correct-looking for a one-account allowlist and silently wrong for the real
  six — and postgres-js rejects a bare `Date` parameter outright. Both were
  caught by executing the job against Postgres 16 with all 24 migrations and real
  fixtures, not by the unit tests, which passed throughout. Same lesson as PR #66,
  a different mechanism.

## Not done here

- **Reconciling the journey's two names.** `train_trips.journey` is the private
  CSV name ("NDC Copenhagen 2026", "Sjælland rundt"); the hashtags are the public
  ones (`#kodetoget`, `#nordsjællandrundt`), and their windows bracket the trips
  cleanly. Joining them deserves its own record and its own table.
- **Weather at the station.** 115 distinct stations, geocoded once, against
  Open-Meteo's keyless archive. It is the only item in this line of work that
  needs an external call, and it should not ride along with a pure derivation.
