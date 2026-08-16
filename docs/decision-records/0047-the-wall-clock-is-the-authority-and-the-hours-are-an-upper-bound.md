# 0047 — The wall clock is the authority, and every hours figure is an upper bound

- **Status:** Accepted
- **Date:** 2026-08-16
- **Contributors:** Markus (asked for watch history as a first-class source, named the tools to avoid the `get_watched` collision, chose the MCP + REST + admin scope, chose `JSON.parse` over a streaming dependency, and chose channel identity by id) + Claude (agent decisions: the two-column timestamp split and which column each concern reads, the three-part dedupe key, the three watch-time estimates, the unknown-duration bucket, and keeping enrichment out of this table)
- **Affects:** `src/db/schema.ts`, `drizzle/0034_youtube_watches.sql`, `src/lib/parse-youtube-takeout.ts`, `src/jobs/import-youtube-watches.ts`, `src/mcp/tools/youtube-watches.ts`, `src/rest/table.ts`, `src/admin/media-query.ts`
- **Topics:** youtube, ingest, timezones, storage, mcp, honesty

## Context

96,515 YouTube watch events, 2010-10-15 to 2026-08-16, across two Google accounts. The
export is shaped like Google Takeout's `watch-history.json` so that one ingest path serves
both it and any real Takeout later.

It is the largest time series this server holds, and it is also the one most likely to
produce a confident wrong answer, because three of its properties look like something they
are not.

**`time` looks like an ISO timestamp and is not one.** It is a bare local wall clock —
Europe/Oslo, no offset, minute resolution, seconds always `00`. `new Date("2026-08-16T18:08:00")`
in a UTC container reads it as 18:08Z, and the row silently moves two hours. Nothing about
the data announces this; every row still looks plausible afterwards.

**`durationSeconds` looks like time watched and is not.** It is the video's own length,
scraped from the page. Neither Takeout nor My Activity records how much of a video was
watched — only that it was opened. There is no watch duration anywhere in this dataset, and
no amount of care with the arithmetic creates one.

**A repeated timestamp looks like a duplicate and usually is not.** 15,782 timestamps carry
more than one entry for the same account, up to 31 in a single minute, because minute
resolution and rapid Shorts scrolling collide. Separately, 3,530 videos were watched more
than once, one of them 24 times. And the two accounts overlap in time rather than
succeeding one another, so the same video can sit at the same minute under both.

The rest of the shape matters for the same reason: 10,962 rows (11.4%) are unresolved —
deleted or private videos with no title and no channel — and 69% of the rows that do carry
a duration are under 180 seconds.

## Decision

### Store the wall clock, derive the instant

`youtube_watches` carries two timestamps, and **`watched_at_local` (a `timestamp` without
time zone) is the authority**. It holds the source string verbatim. `watched_at`
(`timestamptz`) is computed from it at insert with `AT TIME ZONE 'Europe/Oslo'` named
explicitly, because the container's session `TimeZone` is UTC and an unqualified cast would
store the wrong instant.

This is not a new pattern — `train_trips` has stored `departure_local` beside
`departure_at` since the CSV importer landed, for the same reason.

Which column each concern reads is the substance of this record:

| Concern | Column |
|---|---|
| unique / dedupe key | `watched_at_local` |
| `year`, `from`, `to` filters | `watched_at_local` |
| `group_by` year / month / hour_of_day | `watched_at_local` |
| `ORDER BY` and the keyset cursor | `watched_at` |

Calendar work reads the local column so that a bucket needs **no `AT TIME ZONE` at all**,
which is the only way to be certain it was not applied twice — the classic way to end up an
hour out, and the trap ADR 0019 exists to name. It also means `year=2025` reproduces the
source's own per-year counts exactly, rather than misfiling the hours either side of New
Year. Ordering reads the instant because the shared keyset helpers in
`src/mcp/tools/pagination.ts` bind their cursor with an explicit `::timestamptz` cast, and
`ORDER BY` must mirror that `WHERE` exactly or the traversal silently skips or repeats rows.
`train-trips.ts` already orders on the instant while storing both, so the helpers needed no
change.

`from`/`to` are cast `::timestamp`, which makes Postgres discard any offset a caller
appends. That is deliberate and documented in the tool descriptions: these bounds are local
wall-clock time, because that is what the archive records.

The parser refuses a `time` carrying an offset or a trailing `Z` rather than stripping it.
Such a value is not the local wall clock this pipeline is built on, and silently dropping
the offset would move the row by an unknown amount.

**The accepted loss.** The source carries no offset, so a watch inside the repeated hour of
the autumn fall-back resolves to the earlier of the two possible instants. Verified against
PostgreSQL 16: `'2026-10-25T02:30:00'::timestamp AT TIME ZONE 'Europe/Oslo'` yields
`01:30Z`, the CEST reading. It costs at most one collapsed row per year, and only if the
same video was watched twice inside that repeated minute. Keying the unique index on
`watched_at_local` rather than the instant keeps the constraint itself immune to the
question: it is the source's own key, byte for byte.

### The dedupe key is all three parts

`UNIQUE (account, video_id, watched_at_local)`. Every part is load-bearing, and the counts
above say why: drop the timestamp and 3,530 rewatched videos collapse; drop the video id
and up to 31 genuinely different videos per minute collapse; drop the account and every
video watched by both accounts in the same minute collapses. The import is idempotent by
this key — `ON CONFLICT DO NOTHING`, never an update, because a second sighting of the same
triple is the same event seen twice, not a correction.

### Never return one number for time watched

`get_youtube_stats` returns **three** estimates in every response, plus their coverage:

- `raw_hours` — sum of full video lengths. Counts an eight-hour livestream left open for
  two minutes as eight hours.
- `capped_20min_hours` — each row capped at 20 minutes. The least-bad figure for anything
  resembling "time spent".
- `excluding_shorts_hours` — only videos of 180s or more.

All three are upper bounds on a quantity the data does not contain. `duration_coverage_pct`
reports what share of the matching rows had a length at all (~89% archive-wide); the rest
contribute zero, so the true figure is not merely lower than these — it is unmeasurable.

Returning one number would be choosing to be wrong in one particular way and hiding that
the choice was made. Three figures that disagree are self-documenting.

### An unknown duration is unknown

Shorts have no flag anywhere in Takeout or the API, so `duration < 180s` is a heuristic and
is named as one. Rows with **no** duration are a third state, never folded into either
side:

- `shorts=only` requires a *known* sub-threshold duration.
- `shorts=exclude` drops known Shorts but **keeps** rows with no duration, because an
  unknown duration is not evidence of long form.
- `is_short` is `null`, not `false`, when the duration is unknown.
- `shorts_split` reports `unknown_duration` as its own bucket.

### Say what the numbers exclude

Unresolved rows are included by default — they are real watch events, and hiding them would
make every total disagree with the archive. But they carry no channel, so no channel
ranking can contain them. Rather than let the ranking imply full coverage,
`group_by='channel'` returns `excluded_from_ranking` stating exactly how many watches were
left out, and every response carries `unresolved_watches` and `watches_without_channel`.

`distinct_channels` counts channel **ids**, with `distinct_channel_names` beside it. A
channel that renamed has one id and two names; counting by name would split it, and would
merge two channels that share a name. The two numbers answer different questions and both
are reported so neither looks like a typo.

### Enrichment stays out of this table

Category, tags and canonical channel metadata are properties of a *video*, of which there
are ~92k behind ~96k watches. Denormalising them here would mean rewriting every watch row
to set a field that varies per video. They belong in a future `youtube_videos` table keyed
on `video_id` and joined at query time; `video_id` is indexed to be that join key.

`unresolved` is **terminal**. A backfill that retried those 10,962 dead videos would spend
its daily quota rediscovering that they are still dead, every day, forever.

## Consequences

- The importer is a manual command, `npm run import-youtube-watches -- <path>`, not a
  scheduled job: there is no API to poll, only a file that is exported by hand. It reads
  and `JSON.parse`s the whole file (~500–600 MB of heap for the 46 MB archive), which is
  why it is deliberate rather than part of a deploy. The script header records the
  `NODE_OPTIONS=--max-old-space-size` escape hatch. Adding a streaming JSON parser would
  have been this repository's first, for a one-off command, and was not worth the
  dependency.
- Nothing is dropped silently. Every entry becomes a row or a named problem, the script
  prints the breakdown by reason with examples, and it exits non-zero when anything was
  rejected — a malformed file cannot read as a clean import.
- The 186-entry sample the work was developed against is **not** committed. This repository
  is public and the watch history is private; the parser tests use synthetic entries of the
  same shape, and `scripts/youtube-import-verify.ts` checks the real numbers wherever the
  archive actually lives.
- Watch history is deliberately absent from the public `meg.msge.no` stream. It is served
  only over API-key-gated REST and the authenticated admin UI.
- `get_watched` is untouched. It serves the NeoDB catalogue of things Markus *marked*;
  this serves what he *opened*, most of which was never marked anywhere. Both tool
  descriptions say so, because the names are close enough to invite the conflation.
- **Settled by the first full import:** the archive's 25,417 distinct channels is the
  count **by name**. The real archive holds 25,510 distinct channel *ids* against 25,417
  distinct *names* — so 93 channels share a display name with another channel, and
  counting by name merges them. Note the direction: this is not the rename case the
  storage was designed around (which would give more names than ids), it is collision.
  Both counts stay: the tools report `distinct_channels` on the id, which is the better
  identity, with `distinct_channel_names` beside it, and the verify script asserts both so
  the 93-channel gap cannot drift unnoticed.
- **Also found on the first import:** the archive contains watch entries whose `titleUrl`
  is a *search results* page wrapping a `youtu.be` short link
  (`…/results?search_query=https://youtu.be/<id>%3Fsi%3D…`). The brief for this work named
  only `?v=` and `/shorts/`, so the first run rejected two rows and came out two watches,
  two unresolved rows and one distinct video short of the source — the rejections were
  visible precisely because nothing is dropped silently. `extractVideoId` now also reads
  the `youtu.be` form, unanchored so a nested link resolves, with `?v=` still tried first
  so an ordinary watch URL cannot be misread by the loose branch.
