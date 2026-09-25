# 0060 — A date he does not know is not a date

**Status:** Accepted
**Date:** 2026-09-25
**Topics:** neodb, minreol, marks, watched, dates, backlog, sentinel, stream, admin
**Contributors:** Markus (asked & decided: a fixed sentinel date rather than a comment
token, the value 2000-01-01, binary known/unknown with no year level, undated marks stay
on the stream at the day they were marked, the wording "hadde sett", version 1.1.0) +
Claude (proposed the window decode, the flag column, the upsert guard fix and the
`publishedAt` leak; implemented)

**Affects:** `src/lib/neodb-mark.ts`, `src/jobs/sync-neodb-marks.ts`,
`src/jobs/repair-neodb-ingest.ts`, `src/db/schema.ts`,
`drizzle/0041_mark_watched_date_unknown.sql`, `src/mcp/tools/watched.ts`,
`src/rest/table.ts`, `src/admin/media-query.ts`, `src/admin/views/media.tsx`,
`src/stream/query.ts`, `src/stream/views/entry.tsx`, `docs/openapi.yaml`

## Context

Markus has a backlog: films and series he knows he has seen and cannot date. He wants
them in the archive. minreol will not take a mark without a date — its picker insists on
one, and a mark saved without touching it federates with `Status.published` set to now.
So an undated backlog title arrives exactly like a film watched today: it gets a real
`watched_at`, it answers `watched_year=2026`, it sorts as the newest viewing under
`sort_by=watched_at`, and the public stream card says "såg 25. september 2026". Nothing
is wrong with the data as delivered; the *meaning* is wrong, and no query can tell.

ADR 0012 made the shelf date its own column and was explicit that it is read strictly off
`Status.published` with no fallback and no normalisation. ADR 0008 made the comment a
first-class field that is never parsed. Both hold. The question was how to say "unknown"
through a system that only has a date field and a free-text field, without breaking
either promise.

Three shapes were on the table:

- A token in the comment ("udatert"). Rejected: the comment is free text that the archive
  promises never to parse, and the token would show on minreol and in `mark_comments`.
- A sentinel date. Chosen. It rides the field that already carries the fact, the comment
  stays prose, and re-dating the mark later when he does remember is an ordinary `Update`.
- Both. Rejected as two conventions to remember for one fact.

The value is **2000-01-01**, Markus's choice. The archive's oldest real shelf date is
2014 (a handful at `2014-01-01T12:00Z`, an importer placeholder), so nothing real sits
within a decade of the sentinel. Verified against the live archive on 2026-09-25: zero
marks between 1999-12-30 and 2000-01-02.

## Decision

**A mark whose `Status.published` falls on the sentinel is decoded at parse time to
`watched_at = NULL` plus `watched_date_unknown = true`.** The flag carries "unknown"; the
column never holds the sentinel. `raw` keeps the delivered instant as provenance.

- **Decode to null, not to a magic value.** Every consumer already treats a null shelf
  date as "no date": it sorts last both ways, it is left out of `watched_dates`, it
  matches no `watched_from`/`watched_to`/`watched_year` window, `max()` ignores it in the
  admin rollups. Decoding to null makes the sentinel invisible to date maths by
  construction. Keeping it in the column would have meant teaching every one of those
  expressions about the year 2000, and missing one would be silent.
- **A flag beside the null, because two nulls are not the same fact.** A mark that carried
  no date at all (a legacy row, or an origin that omits `published`) is "not told"; a mark
  dated to the sentinel is "told: unknown". `get_watched`, `get_catalogue_details` and
  `/api/v1/watched` report `watched_date_unknown` per item, true when any live mark on
  it is flagged — the complement of `watched_dates`, which lists every dated mark. With
  one mark per (item, actor) the "any" and "newest" readings only differ for an item
  marked by several actors.
- **The filter is three-way and the `false` arm subtracts.** `watched_date_unknown=true`
  selects flagged items; `false` is `NOT EXISTS` over flagged marks, so an item with no
  tracked mark survives it — the same polarity ADR 0046 chose for `exclude_status`, and
  for the same reason: absence of a mark is not information here.
- **Binary.** Known or unknown, no "seen in 2015, no idea when". A year-level convention
  needs a second signal, because `2015-01-01` is a day he might genuinely have watched
  something on. Markus already approximates to a plausible day when he knows the year.
- **The stream keeps the mark on the day it was marked, and changes the verb.** Markus
  chose this over excluding undated marks from the timeline. The lane's
  `coalesce(watched_at, published_at)` already falls back to the marking day, so ordering
  needed no change; the card did. "såg <marking day>" asserts a watch date he explicitly
  does not know, so an undated mark says **"hadde sett"** — the pluperfect is what is
  true on that day. The Atom feed's "Såg X" title is left alone; the item date there is
  metadata, and "såg" is true.
- **The admin grid shows a badge, not the fallback date.** The Watched column is exactly
  where the marking day would otherwise print as a watch day; the badge says "Date
  unknown" and keeps the marking day as its tooltip. An "undated only" checkbox narrows
  to flagged marks, and it filters on the flag, never on `watched_at IS NULL`.

## The window

The sentinel is matched on a **±1 day window around the instant**,
`[1999-12-31T00:00:00Z, 2000-01-03T00:00:00Z)`, not on a calendar day in any one zone.

ADR 0012 recorded that shelf dates arrive in two shapes: our importer's clean
`2000-01-01T12:00:00+00:00`, and minreol's own picker's local-midnight form with a
mean-solar-time offset, e.g. `1999-12-31T22:00:00+00:53`. That second one is 21:07 UTC
on 31 December and 22:07 in Oslo on 31 December — so a UTC-day check misses it, and an
Oslo-day check misses it too. Every real offset from −12 to +14 for "2000-01-01, any time
of day" lands inside the window, with room to spare, and there is nothing real for the
window to swallow. Widening it costs nothing; narrowing it to a single day would have
missed the picker's own shape, silently, on the very first mark Markus made by hand.

The two bounds live once, as `SENTINEL_WINDOW` in `neodb-mark.ts`. The pure decoder,
the backfill SQL and the migration are all built from those strings, and a test reads the
migration file to assert it carries the same two, so the three cannot drift.

## The `Create` that comes first, and the arm that would undo the decode

ADR 0012 documented that minreol federates a backdated mark as a `Create` carrying
today's date and then, moments later, an `Update` carrying the chosen one. The upsert
overwrites on a strictly newer `updated` stamp, and ADR 0012 added a monotone null-fill
arm — a stored row with no shelf date accepts one even from an equal-stamped redelivery —
so a date could never be stranded by a tie.

With the sentinel decoded to null, that arm becomes the bug. The stored row is *meant* to
be null. A redelivery of the original `Create` carries a real date (today) against a null
column, qualifies, and refills it: a deliberate unknown becomes "watched today", with the
stamp going backwards too. This is not a corner case: `objects.raw` is last-write-wins
and `reprocessStoredMarks` replays whatever it holds, so the repair job itself can feed
the stale `Create` back in.

So the null-fill arm now requires `NOT neodb_marks.watched_date_unknown`. A fifth arm
mirrors the tie rule in the sentinel's direction — an equal-stamped delivery that carries
the sentinel wins over an unflagged row — and it is safe because a `Create` never carries
the sentinel. `watched_date_unknown` rides `values` like every other column, so a newer
`Update` in either direction (sentinel → real date, real date → sentinel) overwrites both
the column and the flag together. The guard is exported as `MARK_UPSERT_GUARD` and its
rendered SQL is pinned.

## Backfill, and why the one-off rides the migration

Two passes touch existing rows, and their order matters:

1. `WATCHED_AT_BACKFILL` (ADR 0012) fills a null `watched_at` from `raw`. The sentinel
   is still in `raw`, so it now skips flagged rows — otherwise every forced repair would
   read the sentinel straight back into the column and undo the decode.
2. `UNKNOWN_DATE_BACKFILL` turns a `watched_at` inside the window into null + flag,
   idempotently (`WHERE NOT watched_date_unknown`). It runs from `repairNeodbIngest()`
   directly after the fill, so a forced repair stays consistent.

The one-off decode of rows already stored rides the migration that adds the column, not
the repair marker. The marker (`neodb_ingest_repair_v2`) was deliberately *not* bumped:
a `_v3` would re-run the whole repair on the next boot, including up to 500 origin
refetches and an enrichment pass, to decode a column that is verified empty. Migrations
run at container start (the 0037 precedent), which is exactly the moment this needs.

## One more leak

`parseNeodbMark` fills `publishedAt` — the Note's own post timestamp — from
`Status.published` when the Note has no `published` of its own. With the sentinel there,
a Note without its own `published` would be filed in January 2000 as the day it was
marked, and the stream would place it there. The fallback now hands over nothing when the
Status carries the sentinel; null is the honest answer.

## The traps (don't re-derive these)

- **A single calendar day is the wrong shape for the sentinel.** The picker's own form,
  `1999-12-31T22:00:00+00:53`, is on 31 December in both UTC and Oslo. Match the window.
- **"0 rows decoded" on deploy is the correct result.** Every other backfill on this
  table (ADR 0011, 0012) taught that zero deserves suspicion; here the archive was
  verified empty in the window on 2026-09-25, and the suspicious number would be anything
  else. Do not "fix" the migration until it fills something.
- **`2014-01-01T12:00Z` is a placeholder, not the sentinel.** Several real marks carry it
  from the first import. The rule is about the year 2000 and nothing else.
- **The null-fill arm must check the flag.** Without it, the stale `Create` in
  `objects.raw` turns "unknown" back into "today" on the next repair, with no error.
- **Fill, then decode.** The other order would leave a freshly-filled sentinel in the
  column until the next run.
- **The stream's ordering was never the problem.** `coalesce(watched_at, published_at)`
  already places an undated mark on the marking day; the fix is the verb on the card.
- **Do not add the flag to `catalog_metadata`.** It is a fact about the mark, read live
  off `neodb_marks` like `watched_dates`; materialising it would go stale against the
  mark the same way ADR 0011 warned about for comments.
