# 0062 — StoryGraph pages come from sidetal, and a journal day is already local

**Status:** Accepted
**Date:** 2026-10-04
**Topics:** storygraph, sidetal, reading, pages, journal, timeline, sync, source-health, rest, mcp
**Contributors:** Markus (asked & decided: pull from sidetal, tool shapes per the Sidetal plan) +
Claude (implemented)

**Affects:** `src/config.ts`, `.env.example`, `src/db/schema.ts`,
`drizzle/0042_storygraph_journal.sql`, `src/lib/fetch-storygraph.ts`,
`src/jobs/sync-storygraph.ts`, `src/jobs/scheduler.ts`, `src/index.ts`,
`scripts/sync-storygraph.ts`, `src/lib/source-health.ts`, `src/lib/pages-timeline.ts`,
`src/mcp/tools/pages-timeline.ts`, `src/mcp/tools/journal-entries.ts`, `src/mcp/server.ts`,
`src/rest/table.ts`, `docs/openapi.yaml`

## Context

BookWyrm tells this service which books Markus read and when he started and finished them
(ADR 0002, 0045). It cannot say how much he read on a given day. StoryGraph's reading
journal can: every progress update records the pages read in that update and the day it
belongs to. StoryGraph has no API, so **sidetal** (`mmsge/storygraph-leser`) scrapes the
journal nightly into SQLite and serves it as bearer-token JSON on the same box
(`172.18.0.1:4008`). sidetal's ADR 0002 settles the direction: the bot pulls, the way every
other source here is a `setInterval` pull job, and sidetal stays a dumb server that knows
nothing about its consumers.

Two properties of that data decide most of what follows:

- **The journal date is already a local calendar day.** StoryGraph shows Markus a day, and
  sidetal stores that day. There is no instant behind it to convert. This is the inverse of
  the scrobble timeline (ADR 0059), where `played_at` is a UTC instant and the local day has
  to be computed: there, forgetting the zone files summer evenings a day late; here, *adding*
  one does the same thing, because the conversion has already happened once.
- **`pages_read` is StoryGraph's own per-update delta.** `pages_total` is a position, and
  positions go backwards when an edition changes or a mistake is corrected. A day computed
  as "position tonight minus position last night" turns one correction into a spike or a
  negative day; summing StoryGraph's deltas does not.

sidetal was not deployed when this was written.

## Decision

**Pull, incrementally, with the cursor derived from the data.** `sync-storygraph` asks
`/api/v1/entries?since_updated=<max(source_updated_at) − 1s>` and follows `next_cursor`
until it is null, then fetches `/api/v1/books` whole (it is small). `since_updated` is
exclusive and, when given, also returns soft-deleted rows — so a deletion upstream arrives
as an ordinary row with `deleted_at` set, and is kept and filtered rather than lost. The
one-second overlap exists because a nightly scrape stamps many rows with one instant: a run
that dies between two pages splitting such a tie would otherwise skip the rest of it
forever. Re-reading is an upsert; an upsert only ever moves a row forward in sidetal time
(`excluded.source_updated_at >= source_updated_at`), and never rewrites `first_seen_at`.
No state row holds the cursor; the table is the cursor.

**Failures are failures.** The fetcher is shaped like `fetch-linkedin-snapshot.ts`: every
response is data or an error carrying its trace, and a 401, a 503, a timeout or a 200 that
is not the contract never becomes an empty page — because an empty page is how a run ends,
and a reading journal is quiet often enough that a dead token would look like a quiet week.
Health goes in `source_sync_state` under `storygraph`, so a 401/403 is one latched ntfy
push, and `npm run sync-storygraph` prints the verdict and exits non-zero on failure.

**Store the date as a DATE, verbatim, and never pass it through a zone.** `entry_date` is a
Postgres `date` in drizzle string mode, written as the `YYYY-MM-DD` sidetal sent; a value
that is not shaped like that is stored as undated, never guessed at. The timeline SQL
buckets `date_trunc($bucket, entry_date::timestamp)` — through `timestamp` **without** time
zone, because `date_trunc` and `to_char` have no `date` overloads and a bare date resolves
to their `timestamptz` variants, which read the session TimeZone. Tests render every
fragment and refuse `AT TIME ZONE`; the change was also run against Postgres with the
session zone set to `Pacific/Kiritimati` (+14) and every day came back unchanged. The one
zone question left is "today", which clamps the range: that is an instant, so it is
`osloDay(now)` in JS.

**A day's pages are SUM(pages_read) over its live, dated entries with a page count.**
Started/finished markers and percent-only updates carry no `pages_read` and contribute
nothing; neither do undated or deleted entries. They are all stored, and
`get_journal_entries` serves them.

**`get_pages_timeline` is the scrobble timeline's shape, without the timezone.** Buckets by
day, week (Monday) or month; each carries its true `pages`, `entries`, `active_days`,
`active_books`, a precomputed `top` book from the raw sums, and the per-book breakdown
folded to `top_n` under a reported `other_key`. Book metadata (id, title, authors, edition
pages, range-wide figures) is hoisted. Books are keyed by title, and two different books
sharing one get an id suffix rather than merging. Empty buckets are emitted by default: a
day without reading is signal. The range is clamped to the first day with pages and to
today. MCP defaults to `week`/`5`, REST to `day`/`0` — the ADR 0059 convention, pinned in a
test in both directions.

**`get_journal_entries` is the raw rows**, newest day first and undated last, keyset-paged.
The shared cursor helper keys on a `timestamptz`, and casting a DATE to one would pull the
session zone back in, so this cursor carries the date as a date and reuses
`InvalidCursorError` so a bad token is a 400.

**Deploy-then-arm.** Blank `STORYGRAPH_API_URL` or `STORYGRAPH_API_TOKEN` disables the job
at registration and inside it, so this ships before sidetal exists.

## Consequences

- Nothing has run against a live sidetal yet. Arming it is: set `STORYGRAPH_API_URL` and
  `STORYGRAPH_API_TOKEN` in `/srv/bot/.env`, redeploy, run `npm run sync-storygraph`.
- The page figures are only as good as StoryGraph's own deltas. If Markus logs a day's
  reading as one jump the next morning, it lands on the day StoryGraph files it under.
- A negative `pages_read` (a correction) is summed like any other, so a day can be below
  zero. It never leads a bucket and does not count as an active day.
- `itemsLastRun` for this source counts entries *and* books upserted, so an idle night still
  reports rows and `recordSuccess`' "returned nothing although it has before" warning keeps
  meaning "sidetal served nothing at all". The stored note carries the split.
