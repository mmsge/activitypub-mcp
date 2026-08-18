# 0052 — The race state keeps its columns and gains a key

**Status:** Accepted
**Date:** 2026-08-18
**Topics:** scrobbles, race, notifications, database, migrations, backfill
**Contributors:** Markus (asked & decided: take the intent of the proposed table and fit it to the current picture, rather than adopting its DDL) + Claude (agent decision on the in-place migration, the synthetic legacy ids, the kept-nullable artist columns and the crossover reconstruction)

Extends [0022](0022-configurable-endgame-countdown-band.md), which stands, and depends
on [0051](0051-a-race-side-is-an-entity-and-a-race-is-a-file.md).

**Affects:** `drizzle/0038_race_state_per_race.sql`, `src/db/schema.ts`,
`src/lib/race-store.ts`, `src/lib/race-backfill.ts`, `src/jobs/scrobble-race.ts`

## Context

`scrobble_race_state` held one row per **artist pairing**, keyed on
`(leader_artist, challenger_artist)`. Once a side can be an album and several races run at
once, that key cannot name a row: two album sides by the same artist collapse to the same
pair, and there is no pairing at all for a track race.

The brief for this work proposed replacing the table with four columns —
`race_id`, `last_milestone`, `endgame_armed boolean`, `overtaken_at`.

## Decision

**Key the existing table on `race_id`, rename it to `race_state`, and keep every column.**

Each column the proposed DDL dropped is doing work, and each looks droppable:

| Column | What it does | Symptom if dropped |
|---|---|---|
| `leader_plays` / `challenger_plays` | the "nothing scrobbled since we last looked" short-circuit | every 60-second tick re-decides; endgame per-play alerts re-fire forever |
| `last_announced_gap` | per-play dedupe inside the band, *and* the `widened` test behind the "Back to 12" alert | the same gap re-announces; the leader-answered alert never fires |
| `endgame_armed_at` | a **latch with a timestamp** (record 0022) | as a boolean level it flickers off when the leader scrobbles twice — the exact thing 0022 forbids |
| `last_nowplaying_key` / `_at` | the 15-minute re-arm window | a four-minute song alerts on every 30-second poll |

`endgame_armed` remains in the *response*, derived from whether the timestamp is set. The
API shape the brief asked for is preserved; the storage behind it is not flattened to match.

The migration backfills `race_id = 'maisie-vs-taylor'` for the Taylor/Maisie row and stamps
`overtaken_at = 2026-08-13T10:55:40Z` where null. That value **cannot be computed later**:
the race is `archived`, the notifier skips archived races, so the reconstruction below never
runs for it. Any other pairing gets `legacy:<leader> vs <challenger>` rather than being
deleted — a row here is a record of which milestones were already announced to somebody's
phone, and losing one replays them.

`leader_artist` and `challenger_artist` are kept **nullable and no longer written**, for one
release. They are the only record of where a migrated row came from if `races.json` turns
out to disagree with what was actually being watched.

`saveRaceState`'s partial `onConflictDoUpdate` is unchanged and must stay: it is what keeps
the race job and the now-playing job from clobbering each other's columns, and both of them
now loop, so it matters more than it did.

## The crossover is where the lead changed, not where we noticed

A race is usually added to `races.json` *because* it is close, which often means after it
has already turned. On that first sighting `decideRaceAlert` seeds `overtakenAt` from the
challenger's **latest** play — which is not the crossover, it is wherever the archive
happens to end.

So ask the archive instead. `findCrossover` walks both sides' plays oldest first, keeps
running totals, and returns the first play after which the challenger is **strictly** ahead
— strictly, matching `decideRaceAlert`'s `gap < 0`, because a dead heat is not a win
(record 0016) and a backfill that disagreed with the live decision would write a result the
notifier would never have produced. When the lead changes hands more than once, the *first*
crossing is the answer, the same rule `overtaken_at` itself follows.

The rows are ordered on four columns — `played_at`, `uts`, `artist_name`, `track_name` —
because ties on `played_at` are real here (the same song three times inside a minute is
ordinary listening, and `scrobbles_dedupe_idx` is `(played_at, track_name, artist_name)`).
Without a total order the reconstructed timestamp would differ between runs.

It costs two index-ordered scans of three columns — about 20,000 rows for the artist race —
and runs once per race, only at seed and only when the challenger is already ahead. A
`logger.warn` past 200,000 rows makes it visible if a future entity ever matches half the
archive instead.

## Consequences

- An `overtaken_at` already set is never re-fired and never cleared. A challenger who falls
  back behind after winning leaves the race resolved and nothing re-arms — asserted at both
  the decision layer and the job layer.
- `loadRaceStates(ids)` is new: the two looping jobs read every race's state in one query
  rather than one per race.
- The migration is idempotent — re-running it changes nothing — but it is **not reversible**
  past the rename. Verify it against a copy of the production dump before deploying.
