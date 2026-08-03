# 0015 — Notify a head-to-head scrobble race: exact matching, a one-way ladder, and state that only advances on a delivered push

**Status:** Accepted
**Date:** 2026-08-03
**Topics:** ntfy, notifications, lastfm, scrobbles, jobs, state, mcp-tools
**Contributors:** Markus (asked & decided: the milestone ladder shape, that the live "this song does it" alert is worth the extra polling, and the `scrobble-race` ntfy topic) + Claude (proposed and implemented the mechanism)

## Context

Maisie Peters was 374 plays behind Taylor Swift in the all-time scrobble counts and
closing at roughly 200 plays a month. Markus wanted to be told as the gap shrank —
and, specifically, to know *while a song was playing* that this was the one putting
her ahead. An alert that lands after the scrobble is a result, not a heads-up.

Everything needed was already here: `syncScrobbles()` pulls the full Last.fm history
into `scrobbles` every 60 seconds, and `fetchNowPlaying()` reads what is playing live.
The feature is a watcher over data we already hold, plus an ntfy publisher.

Four of the choices below are non-obvious enough that a later, well-meaning edit would
plausibly reverse them.

## Decisions

### Artist names are matched exactly, deliberately not with `lower()` or `ilike`

`get_scrobbles` and `get_scrobble_stats` filter artists with a substring `ilike`, and
matching that convention here would be the natural thing to do. The race uses
`eq(scrobbles.artistName, name)` instead, for two independent reasons:

- A substring match folds in "Taylor Swift feat. …" and similar credits. For a filter
  that is a feature; for a countdown that reaches zero it silently moves the finish
  line, and the alert everything else builds toward would fire against the wrong number.
- `scrobbles_artist_idx` is a plain btree on `artist_name`, so plain equality is
  index-served. Wrapping the column in `lower()` forces a sequential scan of the whole
  scrobble table — on every sync tick, forever.

The trade-off is real and accepted: if Last.fm ever emits a differently-cased or
trailing-space variant of a racer's name, those plays go uncounted. The seeding log
line prints both counts and `get_scrobble_race` shows them, so a one-off comparison
against Last.fm after configuring a race catches it.

### Milestones fire once and never re-arm

The gap is not a level indicator, it is a sequence of events. `last_milestone` only
ever ratchets downward, so the leader binge-listening back out past 25 and the
challenger closing to 22 again produces no second "25 to go". Treating the gap as a
level would let one afternoon of the leader's music replay half the ladder.

For the same reason, several rungs crossed in a single tick — a first backfill, or the
app having been down for a week — announce only the **tightest** one. Announcing "under
300" when the gap is already 95 is worse than saying nothing.

### State advances only on a delivered push

The obvious shape is: decide, persist, then notify. That permanently eats an alert
whenever the push fails — and on this box the push failing silently is not
hypothetical. `hetzner-server` ADR 0011 documents weeks of pushes 401ing unnoticed
after the shared `markus` password drifted between copies.

So `runScrobbleRace()` persists **nothing at all** on a failed publish — not even the
play counts. The next tick sees the same movement, decides the same alert, and retries,
logging `NTFY PUBLISH FAILED` each time. A password drift therefore costs a delayed
alert and a loud, greppable log line, rather than a lost one. The counts double as the
dedupe key: unchanged counts mean nothing scrobbled, so a quiet tick short-circuits
before any rule runs.

Relatedly, the job refuses to run at all when `NTFY_PASSWORD` is empty. Tracking state
while every push fails would march the ladder past milestones nobody was ever told
about, which is precisely the silent no-op ADR 0011 exists to forbid.

### `publishNtfy` posts JSON, and the race check is chained to the sync

Two smaller ones, both easy to "simplify" back:

- ntfy's header-based publish API requires ASCII header values, and track titles are
  full of curly quotes, accents and em dashes. Publishing the JSON body form keeps
  titles intact without RFC 2047 encoding games.
- `runScrobbleRace()` is called immediately after `syncScrobbles()` inside the existing
  timer rather than being given its own `setInterval`. It reacts to rows the sync just
  wrote; an independent interval would only add a window in which it reads stale counts.

### The endgame watcher calls `fetchNowPlaying` directly

`getNowPlaying()` wraps the same fetch in a 20-second in-process cache — but that cache
is a module-level singleton shared with the public `get_now_playing` tool and every
homepage caller. During the one window in the race where seconds matter, the watcher
could read a value warmed by an unrelated request. It calls `fetchNowPlaying()` instead.

The watcher polls every 30 seconds but only reaches Last.fm while the gap is within
`RACE_ENDGAME_GAP`; above it, a tick is one indexed row read and no API call. That is
what makes a short interval affordable for a race that is months away.

## Consequences

- Switching the feature on mid-race is silent: the first run seeds state and pre-marks
  every rung already passed.
- Once the challenger draws level or goes ahead, the watcher goes inert. The race is
  run; later plays are just plays.
- Last.fm scrobbles at roughly half a track's duration, so the predictive alert has
  about the first half of a song to land — a couple of polls on a three-minute track.
  When it misses, the overtake alert still arrives on the next sync.
- `get_scrobble_race` computes from `scrobbles` directly rather than from the watcher's
  state, so it answers correctly even when notifications are unconfigured, and can race
  any two artists on demand.
