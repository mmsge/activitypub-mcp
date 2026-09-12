# 0059 — A day is the day you lived

**Status:** Accepted
**Date:** 2026-09-12
**Topics:** scrobbles, timezones, api, mcp, aggregates

**Contributors:** Markus (asked & decided: the tool's shape and parameters, a keyed REST
endpoint rather than a public route, per-surface defaults, the repo's path convention,
endpoint only for now) + Claude (proposed the pure/SQL split, the clamped range in place
of a range limit, the fold-key and `plays` semantics, and implemented)

**Affects:** `src/lib/scrobble-timeline.ts`, `src/mcp/tools/scrobble-timeline.ts`,
`src/lib/local-bound.ts`, `src/mcp/tools/scrobbles.ts`, `src/mcp/server.ts`,
`src/rest/table.ts`

## Context

52,662 scrobbles, 2016-01-15 to now, and no way to ask what the listening looked like
*over time*.

`get_scrobbles` returns rows. A sample of 200 covered six days, so a full sweep at that
density is roughly 260 paginated calls — enough to exhaust a context budget before
answering anything. `get_scrobble_stats` aggregates, but it collapses the whole range into
a single ranking: it can say Maisie Peters is first with 11,029 plays and cannot say which
months those plays were in.

The obvious shortcut was a `group_by: "day"` on the stats tool. It does not work, and the
reason is worth writing down: `group_by` there selects **the entity being ranked**. A day
is not an entity, it is a bucketing axis, and the question wants both at once — plays per
day, broken down per artist. One parameter cannot carry two orthogonal things, so this is
a second tool rather than a fourth enum value on an existing one.

## Decision

`get_scrobble_timeline`, and `/api/v1/scrobble-timeline` beside it.

### A bucket is a local calendar period

`played_at` is stored UTC. Bucketing on the UTC date is wrong here, not merely imprecise:
Norway runs UTC+2 in summer, so everything from 22:00 local onwards falls on the following
UTC day. Bucket on UTC and a summer evening's listening is filed against tomorrow, for
half the year, every year.

What makes it worth an ADR is that the error is invisible. No query fails, no count is
lost, no total moves. The plays are all there, one day to the right, in exactly the
aggregate whose job is to hide individual rows. So the grouping is
`date_trunc($bucket, played_at AT TIME ZONE $timezone)` — the same rule `musicLane()`
already applies to the public stream's daily digests, and the one ADR 0047 settled for the
YouTube archive's wall-clock timestamps.

`timezone` is a parameter rather than a constant so the series can be cut elsewhere, but
its default is `Europe/Oslo` because that is where the listening happened.

### The timezone is bound, and validated before the query

`timezone` is caller-supplied text that ends up inside a SQL expression, so it is a bound
parameter and never interpolated. `src/mcp/tools/scrobble-timeline.test.ts` asserts the
rendered statement does not contain the zone and the parameter list does — that assertion
is the injection guard, not a style check.

An unknown zone is rejected by a zod `.refine()` before a connection is opened, which
through REST is a 400 naming the parameter rather than a Postgres error surfacing as an
opaque 500. The check is `Intl.DateTimeFormat`, deliberately not
`Intl.supportedValuesOf('timeZone')`: that list enumerates canonical names only, so
`US/Pacific`, `Asia/Calcutta` and `Europe/Kiev` would have been refused despite both ICU
and Postgres accepting all three.

### The timezone rule lives in the SQL, and nowhere else

Silent buckets are emitted rather than left for a client to reconstruct, which means
enumerating every day, week or month in the range. That enumeration is pure calendar
arithmetic over `YYYY-MM-DD` strings and touches no timezone at all: the range endpoints
come out of SQL already reduced to local dates, and stepping a date string forward one
day, one week or one month needs no zone.

This is the point. A JS implementation of "which local day is this instant in" would be a
second authority on the only rule that matters here, and two authorities on a rule that is
+01:00 half the year and +02:00 the other half disagree twice a year about two hours of
listening — the exact failure the decision above exists to prevent.

The consequence is that everything except the `GROUP BY` is pure, which is also what makes
it testable: this repo has no test database, so logic that lived in the handler could not
be tested at all.

### The range is clamped, not limited

A caller asking `from=1900-01-01` with day buckets would ask for 46,000 rows of
pre-Last.fm silence. The first design rejected that with an error. The better answer is to
intersect the request with what the archive can actually answer: `from` is pulled forward
to the first day with matching scrobbles, `to` pushed back to today.

So there is no limit to trip over and no new error path. `to` is clamped to today and
**not** to the last day with data, because trailing zero buckets are the answer to "has he
stopped listening?" — the future is silence we have no business reporting, the last three
days are not.

### `plays` is the true total; `top` is precomputed; `Other` is declared

Three response decisions that each prevent a specific wrong answer:

- **`plays` on a bucket counts every scrobble in it** and does not move with `top_n` or
  `min_plays`. A `plays` that shrank with a display parameter would make two calls
  incomparable, which defeats the purpose of a series. `min_plays` therefore *drops* the
  long tail instead of folding it — folding would put the whole tail straight back as one
  large bar — and that is the single case where `entities` sums to less than `plays`.
- **`top` is picked from the raw counts**, so "who won this day" needs no client-side scan,
  never changes with `top_n`, and can never be the overflow row (whose summed total
  routinely outranks every individual entity). Ties resolve by range-wide plays, then
  byte-wise on the key, so the answer is stable between calls and between machines.
- **The overflow key is reported as `other_key`.** It is `Other` unless a real entity is
  already called that, in which case it steps aside. Silently merging an actual artist
  named "Other" into the overflow row is indistinguishable from the response, so the key
  moves and the envelope says where it went.

Album and track entities are keyed `"<artist> – <name>"` because `get_scrobble_stats`
groups those by `(artist, name)` precisely so same-titled records by different artists do
not merge; a timeline keyed on bare names would undo that. Each entity also carries
`artist` and `name` as fields, so the key is an identity and never needs parsing back
apart.

### The two surfaces differ in two defaults, and nothing else

The full archive at daily resolution with every entity measures 3,894 buckets and ~1.2 MB
— fine for a browser, useless in a chat context. So MCP defaults to `bucket: 'month'` and
`top_n: 12`, and REST to `bucket: 'day'` and `top_n: 0`.

Those defaults were not enough on their own. A capped call still returned the whole
range-wide `entities` block, and at 2,405 artists that was 262 KB of a 275 KB monthly
answer — the default whose entire job is to fit in a chat context, defeated by the part of
the response that was supposed to make it small. So `entities` lists only the entities
some bucket actually shows: every one of them at `top_n: 0`, which leaves the chart's case
untouched, and 25 of them for the monthly top-12, which brings that answer to 41 KB.
`totals` is computed before the filter, so it still describes the whole range.

`src/rest/table.ts` asserts that REST and MCP return identical data except for visibility
(ADR 0026). That still holds: ADR 0026 is about what a surface may **see**, and this is
about what it assumes when a parameter is **omitted**. Pass `bucket` and `top_n`
explicitly and the two answer identically. One core schema, one handler, two `.extend()`
calls — and both default sets are pinned in tests so a refactor that unifies them fails
rather than quietly changing what a bare call returns.

## Consequences

- The daily series is answerable in one call instead of ~260, and a bare MCP call returns a
  monthly top-12 at ~41 KB rather than the 1.2 MB the full daily series costs.
- Measured against a 52,962-row fixture matching the real archive's concentration (the
  top two artists are 41% of all plays, the top twenty 82%): 126 ms for the MCP default,
  256 ms for the full daily series, 710 ms and ~8.5 MB for the widest thing anyone can
  ask for (`bucket=day, group_by=track, top_n=0`), and 53-57 ms once a filter or a
  one-year window narrows it. A flat distribution — every artist played equally — costs
  roughly three times as much payload, so these figures are the realistic case rather
  than the best one.
- Three queries per call over one `WHERE`: archive bounds, the flat bucket×entity
  aggregate, and the range-wide per-entity rollup carrying the representative image. The
  image is hoisted out of the buckets because repeating a Last.fm URL across thousands of
  days is most of the payload for none of the information.
- **No new index.** An expression index on `((played_at AT TIME ZONE 'Europe/Oslo')::date,
  artist_name)` cannot be matched by the planner when the zone is a bound parameter, and a
  full-range call aggregates every row regardless. The existing `scrobbles_played_idx`
  serves the windowed case; the window predicate is deliberately written against
  `played_at` itself rather than the converted expression so it can.
- `LOCAL_BOUND_RE` moved out of `get_youtube_watches` into `src/lib/local-bound.ts`. Two
  tools now need the same shape rule for a hand-written bound and do different things with
  the value: that tool keeps the time of day, this one reduces the bound to a date.
- `buildConditions` in `src/mcp/tools/scrobbles.ts` is exported, so all three scrobble
  tools share one definition of what `artist=maisie` means. Its `from`/`to` arms are not
  reused here — there they are ISO datetimes compared against `played_at` directly, here
  they are local calendar dates needing conversion to instants first.
- What CI cannot check, it does not pretend to. There is no test database, so the SQL's
  *shape* is pinned on the rendered statement and its *behaviour* is verified against real
  Postgres in the PR body — the division `garden-date-sql.test.ts` already documents.

## Rules not to "simplify" back

- **Bucket on local time, never the UTC date.** The plays are all still there, one day to
  the right, for half the year. Nothing fails and no total moves, which is why this needs
  writing down rather than noticing.
- **The zone is a bound parameter and validated first.** It is caller text reaching a SQL
  expression. A 400 from a `.refine()`, never a Postgres error dressed up as a 500.
- **Bucket enumeration carries no timezone.** The range arrives from SQL as local dates
  and stepping a date string is pure calendar arithmetic. A second timezone implementation
  in JS is the drift the first rule exists to prevent.
- **`plays` is the bucket total and does not move with `min_plays` or `top_n`.** Otherwise
  two calls with different display parameters return series that cannot be compared.
- **`min_plays` drops; `top_n` folds.** Folding the tail `min_plays` removed puts it back
  as one large bar, which is the opposite of what was asked for.
- **`top` comes from the raw counts.** It must not be the overflow row, and it must not
  change when a display parameter does.
- **`Other` is declared, not assumed.** A real entity of that name would otherwise be
  absorbed into the overflow row with nothing in the response to show it.
- **Album and track keys carry the artist.** Bare names merge same-titled records by
  different artists, which `get_scrobble_stats` already refuses to do.
- **`to` is clamped to today, not to the last day with data.** Trailing zero buckets are
  the answer to whether he has stopped listening.
- **The two default sets are the only divergence between MCP and REST.** One handler, one
  core schema. Anything else that differs is a bug, not a second exception.
