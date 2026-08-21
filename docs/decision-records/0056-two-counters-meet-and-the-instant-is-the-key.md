# 0056 — Two counters meet, and the instant is the key

**Status:** Accepted
**Date:** 2026-08-21
**Topics:** trains, scrobbles, notifications, watchers, idempotency, backfill

**Contributors:** Markus (asked & decided: one push carrying the window duration rather
than two; its own ntfy topic, on by default; announce the 2020 meeting once rather than
seeding in silence) + Claude (proposed and implemented the model, the departed-leg rule,
the dedupe key and the retry queue)

**Affects:** `src/lib/convergence.ts`, `src/lib/convergence-store.ts`,
`src/jobs/convergence.ts`, `src/mcp/tools/convergence.ts`, `src/db/schema.ts`,
`drizzle/0039_convergence_watch.sql`, `src/admin/router.tsx`, `src/jobs/scheduler.ts`

## Context

Two monotonic counters run over the same decade of this archive: `total_scrobbles`, one
row per Last.fm play, and `total_km`, whole kilometres per train leg imported from
viaduct. They are close — 51,959 against 49,914 the day this was written — and they have
met exactly once, on 2020-01-11 at 3,298 each.

That meeting lasted **three minutes and ten seconds**, and nobody noticed. It was found
months later by asking an agent. Kilometres close the gap at roughly 35 a day, so the
next meeting is one long train ride away.

A three-minute window is the whole problem. Nothing on a daily or hourly timer can see
it, and the notification has to name what caused it while the answer is still in front
of you rather than reconstructed afterwards.

## Decision

### The model: one signed quantity over a merged timeline

`d(t) = km(t) − scrobbles(t)`. A scrobble moves it by −1 at its `played_at`; a departed
leg moves it by `+distance_km` at its `departure_at`, in a lump of up to 1,176. Two
properties fall out of that asymmetry, and the rest of the design is downstream of them:

**A scrobble can never flip the sign without landing on zero.** It steps by exactly one,
so it always visits `d = 0` on the way past. Every *crossover* — a flip that skips zero —
is therefore caused by a kilometre lump. Equality can be caused by either side. This is
why leaving an equality window is not a second crossing: `before === 0` is the
resolution of something already announced, not news.

**Equality is a window, not an instant.** It opens on the event that lands `d = 0` and
closes on the next event that moves it off. Both ends are facts the archive already
holds, which is why "3 min 10 s" is recoverable and worth putting in the body.

### The dedupe key is `(kind, occurred_at)`, not a row id

`convergence_events` is the "already announced" bookkeeping, and its unique index is the
enforcement: insert `ON CONFLICT DO NOTHING`, and a crossing recomputed from the same
data lands on the same key and inserts nothing.

Keyed on a row id it would not work. A leg re-imported from a fresh viaduct export gets
a new uuid for the same journey (the identity is `from_station, to_station, departure_at`
— ADR 0048, not the uuid), and the post-import walk re-derives every crossing from
scratch. Both would read as new. **The instant is what the crossing is.**

`occurred_at` is the causing event's own timestamp and never the moment the watcher
looked. A backfilled export can put a crossing years in the past; `historical` is what
turns the copy into the past tense and makes the push name a date rather than a
discovery.

### A leg counts from when it departed, not from `status = 'Completed'`

The status column looks like the obvious filter. It is the same trap ADR 0031 recorded:
viaduct freezes `Planned` on any row imported once and never re-exported, and filtering
on it hid 13 real journeys from the public stream. Two legs in the archive today — 397 km
— are departed and still marked `Planned`.

This is not a rounding difference. At 35 km a day, 397 km is a week and a half: the two
filters project the next meeting onto different trains. `departure_at <= now()` is what
"Completed, **or** departed" means, and it is also why a crossing can happen with no
ingest of any kind to react to — a train departing moves the counter on a clock, so the
watcher evaluates on every tick rather than only when the sync wrote something.

Kilometres are compared **as stored**, whole per leg. The push says so in one line,
because "exactly equal" is only exact at that resolution.

### Two evaluation paths, one pure function

The 60-second tick resumes from a watermark and folds in the handful of events since.
The trip import and the trip prune recompute from zero.

The asymmetry is not an optimisation detail, it is a correctness rule. **The watermark is
valid for scrobbles and not for legs.** `sync-scrobbles` cursors on `max(uts) + 1`, so it
can never ingest a play older than the newest one stored — the scrobble stream is strictly
append-at-the-end and has no prune. A viaduct import can insert, correct or delete a leg
at any date, and every kilometre it changes shifts `d` for every event after it. So the
import path cannot trust the cursor, and the tick does not need to walk 52,000 rows a
minute to avoid a hazard that cannot happen.

Both paths call the same `findCrossings`, so the tail can never disagree with the whole.

### The row is written before the push and stamped after it

`notified_at` makes `convergence_events` a queue, not just a ledger. A crossing is owed a
notification until it is stamped, so a 401, a timeout or a crash between the insert and
the broker leaves it owed and the next run pays it — and the watermark deliberately does
not advance on a failed push either.

This is the shape hetzner-server ADR 0011 argues for, and it matters more here than in
the race watcher. There, a missed rung costs one alert and the ladder moves on. Here the
row *is* the "already told you" mark, so a crossing recorded while the push was failing
could never be announced afterwards. For the same reason the watcher refuses to run at
all without `NTFY_PASSWORD` rather than recording state it can never announce.

### Several discoveries collapse into one push

Only a backfill produces more than one new crossing at a time: a corrected leg distance
shifts every later crossing in time, so the walk rediscovers them at new instants.
Announcing each individually would be a burst of pushes about one edit to one CSV row.
One summary names the count, the span and the current standing.

## Alternatives considered

**Recompute everything on every tick.** ~52,000 rows is well under a second, and it
would delete the fast path outright. Rejected because it is a full scan every 60 seconds
forever to guard against a hazard — a leg landing behind the watermark — that only ever
arrives through an import we already hook.

**Key the crossing on the causing row's id.** Simpler to write, and wrong for both
sides: trip uuids do not survive a re-import, and the recompute re-derives crossings
rather than reading stored ones.

**A second push when an equality window closes.** Markus was asked and chose one. The
duration goes in the body when it is already known, and a window still open pushes
without it and never pushes again — the close is recorded, not announced.

**Seed the first run in silence,** the way `BREAKOUT_ENABLED` does. Markus was asked and
chose to announce the 2020 meeting once. The breakout rule exists to stop a percentile
ladder replaying an archive of hundreds of posts; here the archive holds exactly one
crossing, and it is the point of the feature rather than noise. The threshold that marks
a crossing historical is the walk's own end on a first run, so it arrives in the past
tense with its three minutes and ten seconds attached.

## Consequences

- `get_convergence` and `GET /api/v1/convergence` read totals from the two archives, not
  from `convergence_state` — that row is the watcher's cursor, and quoting it would
  report whatever the watcher last managed rather than what is stored.
- A leg pruned after a crossing was announced leaves the crossing recorded and no longer
  derivable. That is deliberate: the event log records what was true, and the recompute
  simply stops producing it.
- The projection is arithmetic on trailing rates, not a promise. It is in the read
  surface and never in a push — a heads-up as the gap narrows was explicitly out of
  scope.
