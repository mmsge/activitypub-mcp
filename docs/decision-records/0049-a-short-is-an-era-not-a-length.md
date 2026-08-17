# 0049 — A Short is an era, not a length

**Status:** Accepted
**Date:** 2026-08-17
**Topics:** youtube, classification, enrichment, jobs, data-quality, provenance, rate-limiting
**Contributors:** Markus (asked & decided: an in-process scheduled job rather than a Podman Quadlet unit, stage 1 built but left unarmed, the ambiguous band left null rather than gaining a fifth `heuristic` method, and re-pointing the existing `shorts` filter rather than adding a second one) + Claude (agent decision on the funnel's shape, the two null states, doing stage 0 in TypeScript rather than SQL, the video-level duration, and the implementation)

Builds on [0047](0047-the-wall-clock-is-the-authority-and-the-hours-are-an-upper-bound.md), which
stands. That record introduced `duration < 180s` as an explicitly labelled heuristic and said
so in every response. This one replaces the rule without changing that posture: the flag is
still derived, still labelled, and now also carries how it was derived.

**Affects:** `src/lib/youtube-shorts.ts`, `src/lib/fetch-youtube-videos.ts`,
`src/lib/probe-youtube-short.ts`, `src/jobs/classify-youtube-shorts.ts`,
`src/mcp/tools/youtube-watches.ts`, `src/db/schema.ts`,
`drizzle/0036_youtube_shorts_classification.sql`, `scripts/classify-youtube-shorts.ts`

## Context

There is no Shorts flag anywhere in the watch archive. All 96,515 rows carry a `/watch?v=`
URL and not one carries `/shorts/`. That is not a collection failure — My Activity does not
distinguish the two either, so nothing was lost on the way in. Aspect ratio, the one
unambiguous signal, is not exposed by the Data API. Duration is the only proxy available,
and ADR 0047 shipped it as a flat `duration < 180s` test with the caveat attached.

The flat test is wrong in two known directions:

- **Shorts did not exist before roughly September 2020.** Nothing uploaded earlier can be
  one, whatever its length.
- **The ceiling was 60 seconds until 15 October 2024**, and 3 minutes after. A 90-second
  video uploaded in 2023 is therefore not a Short, though a flat 180-second rule calls it one.

Across this archive the flat rule mislabels about **5,950 of the 59,012 rows it catches**,
roughly 10%.

**The subtlety that decided the whole design: the archive holds the date each video was
WATCHED, not when it was UPLOADED.** The era rules are only sound against the upload date. A
45-second video watched in 2025 could have been uploaded in 2013. A watch date bounds the
upload date from *above* and never from below, which yields certainty in exactly one
direction — something watched before September 2020 cannot be a Short — and nothing at all
in the other.

## Decision

**Classification is per video, tri-state, and carries its provenance.** A new
`youtube_videos` table, keyed on `video_id`, which is the table `0034` reserved
`youtube_watches_video_idx` for and explicitly declined to denormalise onto the watch rows.
92,292 videos behind 96,515 watches; 3,530 videos were watched more than once, so a
per-watch flag would be both redundant and able to contradict itself.

`is_short` is `true` / `false` / null, and `is_short_method` names the evidence:
`duration_rule`, `api_metadata`, `probe`, or `unclassifiable`. The point is not
bookkeeping — it is that a later run can upgrade a guess to a verified answer, and that the
stats can say "of the ones we actually know" without pretending.

**Three stages, cheapest first.** Real counts over the 92,292 distinct videos:

```
10,741  11.6%  no duration           -> unknown, terminal
17,940  19.4%  watched pre 2020-09   -> false, certain
12,008  13.0%  over the era limit    -> false, certain
51,603  55.9%  everything else       -> still ambiguous
```

A third of the archive is decided before a single request leaves the box. Stage 1 is
`videos.list(part=snippet,contentDetails)` — **50 ids per call, one quota unit per call**,
so the entire backlog is about 1,846 units against a 10,000/day allowance and fits inside a
day. It yields `snippet.publishedAt`, the real upload date, which makes the same rules exact
rather than bounded. Stage 2 requests `https://www.youtube.com/shorts/<id>`: a real Short
stays there, anything else redirects to `/watch?v=`.

### The traps (don't re-derive these)

**The offline rule keys on the EARLIEST watch, not the latest.** Only the earliest watch is
a sound upper bound on the upload date. Keying on the most recent one would let a video
first watched in 2019 and rewatched in 2025 escape the date rule entirely, which is a real
shape in this archive — 3,530 videos were watched more than once.

**Stage 1 can only ever return `false`.** Nothing YouTube serves as metadata proves a video
*is* a Short; there is no flag and no aspect ratio. Stage 1 earns its keep by shrinking the
band the probe has to walk, not by answering it. A confirmed Short can only ever come from
`probe`, and any future stage that starts emitting `is_short = true` from metadata is wrong.

**The two null states are different, and conflating them is the expensive mistake.**
`is_short_method = 'unclassifiable'` is terminal: no duration, no working URL, nothing will
ever decide it. That is the same population `youtube_watches.unresolved` marks, and retrying
it would spend the daily quota re-discovering that 11% of the archive is still dead. A null
*method* means merely pending. Both work queues are partial indexes over those predicates,
so a terminal row is not in the index at all and no query can select it by accident.
Exhausting `is_short_attempts` is deliberately a third thing again — the row keeps a null
method and is simply not selected, so re-arming it is a matter of resetting a counter rather
than reasoning about which nulls are real.

**`is_short_checked_at` records that a video was EXAMINED, which is not the same fact as
having been DECIDED.** Stage 0 sets it even when it has no verdict. Without that
distinction, every subsequent run would re-examine the entire 51,603-video ambiguous band
forever, and "running it twice does nothing the second time" would be false.

**Stage 0 classifies in TypeScript, not in a SQL `CASE`.** The rule then exists once, in a
pure module CI can assert — CI has no Postgres — with no second copy in SQL to drift from
it. It also means the dry run executes the same code path as the write and therefore
genuinely predicts it. The cost is one pass over ~92k small rows, measured at 1.3 seconds,
and only ever paid once per video.

**Stage 0 is driven FROM `youtube_watches`, left-joined to `youtube_videos`.** The watches
say which videos exist; the videos table only holds verdicts. Selecting from the videos
table instead made the dry run report zeros on a fresh database, because a dry run must not
seed rows either — caught in testing, and exactly the shape of "reports the funnel without
writing anything" being quietly false.

**A video's duration is a property of the video, so it is stored on the video.** Watch rows
of one video can disagree: one entry scraped a duration and another did not, which is the
state about 231 rows of the archive are in. The served flag falls back to the flat heuristic
for anything not yet classified, and reading the watch row's duration for that made two
watches of the same video answer differently. Stage 0 now seeds `youtube_videos.duration_seconds`
from `max()` over the video's own watch rows, guarded on `IS NULL` so stage 1's authoritative
value is never overwritten.

**`exclude` uses `IS NOT TRUE`, not `<> true`.** Three-valued logic is the entire point of
the filter: `NULL <> true` is NULL, which no `WHERE` clause keeps, so the obvious spelling
would silently drop every unknown row from a filter documented to keep them.

**The pending queue is ordered in SQL by fewest attempts first.** `sync-neodb-metadata.ts`
builds its todo list by subtracting fresh rows from an unordered set, which means a
permanently-failing prefix longer than the per-run cap is retried on every pass forever
while everything behind it starves. `sync-stations.ts` does it the right way and so does
this.

**Quota exhaustion must not count against the ids in flight.** A 403 carrying
`quotaExceeded` stops the stage; it does not bump `is_short_attempts`, because doing so
would eventually give up on videos nothing was ever actually asked about.

**The probe deliberately sends an `Accept` header naming `text/html`** — the exact opposite
of the rule that governs the Gigowl origin (see `CLAUDE.md`). Here we want the response a
browser would get, because it is a browser's redirect behaviour that carries the answer. It
also uses `redirect: 'manual'`: following the redirect would discard the only signal there
is and make every video look like a 200.

**Stage 2 cannot be hurried.** YouTube returned HTTP 429 after **two** requests. Not two
thousand. Single concurrency, seconds between requests, exponential backoff, and a run that
spans days. At one request every two seconds the current ambiguous band alone is about 29
hours. It is therefore off by default and separately switchable, so the decision to spend
that time can be made after seeing the residual rather than before.

## Consequences

- The existing `shorts` filter is **re-pointed**, not duplicated: same parameter, same three
  values, now reading the classification and falling back to the flat rule only for videos
  the job has not reached. Behaviour on an unclassified archive is unchanged, so this is
  safe to deploy before the job has ever run, and it improves monotonically after.
- Because a caller cannot tell a verdict from a guess by `is_short` alone, both tools say so:
  each row carries `is_short_method` and `is_short_source`, and `shorts_split` splits its
  headline totals into `known_*` and `guessed_*` with a `by_method` breakdown. The tool
  descriptions state that the flag is derived by this server, which is the only place that
  caveat reliably reaches an LLM.
- `excluding_shorts_hours` now reads the resolved flag, so a 90-second video from 2023
  counts as the long-form it is rather than being discarded as a Short it never was.
- `unknown_duration` in `shorts_split` is derived from the resolved split rather than by
  subtracting `rows_without_duration`, a WATCH count, from a video-level figure — that
  subtraction double-counted the duration disagreement above and reported 1 where the truth
  was 0.
- Stage 1's metadata (upload date, authoritative duration, title, channel, category) is
  persisted rather than thrown away. Classification needs two of those fields; the call
  returns the rest for free and the year-in-review work will want them.
- Scheduling is an in-process `setInterval` plus `npm run classify-youtube-shorts`, matching
  the other ~17 jobs in this service. `linjeskift`'s timer-driven Podman Quadlet units were
  the stated precedent, but that is a different service on the same box; this one is Docker
  Compose, and a Quadlet unit here would have needed its own image and its own copy of
  `DATABASE_URL`. Markus' call once the mismatch was pointed out.
- The ambiguous band stays `is_short = NULL, is_short_method = NULL` rather than gaining a
  fifth `heuristic` method. Also Markus' call. The accepted cost is that "awaiting stage 1"
  and "settled as a heuristic guess" are the same stored state; the benefit is that
  "decided" and "not decided" remain cleanly separable, and the API reports the guess
  honestly either way.
- `drizzle/meta/` holds snapshots only up to `0019`, so `npm run db:generate` diffs against
  a 16-version-stale baseline and emits sixteen migrations' worth of duplicate DDL. `0036`
  is hand-written in the house style like every migration since `0012`, but its regenerated
  snapshot is kept, which repairs `db:generate` for whoever runs it next.
- Verified before shipping against a throwaway PostgreSQL 16 seeded with a synthetic archive
  of the same shape and the same totals as production: the dry run reports
  10,741 / 17,940 / 12,008 / 51,603 and writes zero rows; a real run stores 29,948
  `duration_rule`, 10,741 `unclassifiable` and 51,603 pending; a second run examines nothing
  and leaves the table byte-identical under an md5 of its whole state; losing 5,000 writes
  mid-run re-does exactly those 5,000; no `unclassifiable` row is ever selectable; and three
  newly imported watches are picked up by the same job with no special casing. End to end
  against live YouTube, `fwLsCgibGw4` (553s, Palindrome Ages) settles offline as
  `false`/`duration_rule` and `oijqsP5wizI` (7s) survives to stage 2, where the probe
  confirms it `true`/`probe`.

## Not done here

The year-in-review pages, and any *use* of the stage 1 metadata beyond classification — it
is persisted, not consumed. No admin surface for the classification: `Admin → Media →
YouTube` is a channel rollup and the classification is per video, so it would need its own
view rather than a column.
