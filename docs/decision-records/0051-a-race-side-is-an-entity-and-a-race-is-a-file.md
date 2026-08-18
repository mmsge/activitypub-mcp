# 0051 — A race side is an entity, and a race is a file

**Status:** Accepted
**Date:** 2026-08-18
**Topics:** scrobbles, race, configuration, notifications, mcp, rest-api, matching
**Contributors:** Markus (asked & decided: `races.json` rather than the briefed `races.toml`) + Claude (agent decision on the entity model, the list-valued album/track sides, the exact-match rule, the label derivation, the resolution order and the implementation)

**Affects:** `races.json`, `src/lib/race-entity.ts`, `src/lib/races-config.ts`,
`src/lib/race-store.ts`, `src/lib/scrobble-race.ts`, `src/mcp/tools/scrobble-race.ts`,
`src/mcp/tools/scrobble-races.ts`, `src/jobs/scrobble-race.ts`,
`src/jobs/scrobble-race-nowplaying.ts`, `src/config.ts`, `Dockerfile`

## Context

The head-to-head race (records [0015](0015-scrobble-race-notifications.md),
[0016](0016-arm-the-race-one-play-early.md),
[0022](0022-configurable-endgame-countdown-band.md)) was two environment variables,
`RACE_LEADER_ARTIST` and `RACE_CHALLENGER_ARTIST`. Two strings can express exactly one
thing: one race, between two artists.

That race is over — Maisie Peters passed Taylor Swift on 2026-08-13 — and the next one is
not artist-shaped. *The Good Witch* vs *Florescence* is **one artist's two records**, and
its crossover lands around 22 August 2026. There is no pair of artist names that says that,
and no second pair of variables that could hold a second race.

## Decision

**A side of a race is an entity, not a name.** Three types, all matched exactly:

| `type` | Required keys | Matches |
|---|---|---|
| `artist` | `artist` | that artist |
| `album` | `artist`, `albums` (list) | that artist AND an album in the list |
| `track` | `artist`, `tracks` (list) | that artist AND a track in the list |

**`albums` and `tracks` are lists, and that is the point.** Last.fm files a single under
its own album name, so `The Good Witch` and `Lost The Breakup` are two album rows for one
campaign. A list folds them into one side with no code change, and one row matches once
however many of the names it could have matched — so a multi-name side sums its parts
without double counting. That is a property of `IN`, not of a dedupe step, and it is why
the query is `album_name in (…)` and never a sum of per-name counts: the sum gives the same
answer today and silently double counts the moment two names overlap.

**Matching stays exact**, against `get_scrobble_stats`, which does a substring `ilike`.
Both halves of the reason still hold and both are easy to "fix" back:

- A countdown that reaches zero must not have its finish line moved by a stray
  "Taylor Swift feat. …" credit.
- `scrobbles_artist_idx` is a plain btree on `artist_name`. Plain equality is index-served;
  `lower()` or `ilike` would seq-scan the whole table on every 60-second sync tick, forever.

**Races live in `races.json` at the repo root**, loaded once at startup, path overridable
with `RACES_CONFIG_PATH`. Several races run at once, each with its own `topic`,
`milestones`, `endgame_gap` and `nowplaying_gap`; the old `RACE_*` and `NTFY_TOPIC` env
values became the defaults a race inherits when it states none. `archived: true` means the
race is resolved — still queryable, skipped by both notifier jobs.

**JSON, not the briefed TOML.** The brief said to load `races.toml` with `tomllib`, which is
Python; this is a Hono + TypeScript service with no TOML parser and no `.toml` file anywhere.
`JSON.parse` plus zod is what every other setting here already uses, so the file schema is
the brief's, unchanged, with no new runtime dependency. Markus chose this.

**A bad file exits the process.** `getRaces()` is called early in `src/index.ts`, before the
`syncScrobbles()` / `runScrobbleRace()` block — which catches and logs. A broken file reached
lazily from inside that block would come out as one warning line and the service would boot
looking perfectly healthy with nothing being watched.

**Resolution order for `get_scrobble_race`**, in a pure `resolveRace()`:

1. `race_id` names a configured race.
2. `leader` and `challenger` as objects build an ad-hoc race.
3. `leader` and `challenger` as bare strings are two artists — the pre-existing behaviour.
   This is **not a separate branch**: a string becomes an artist entity and rule 2 handles
   it, which is what makes "unchanged" a structural property rather than a promise.
4. Nothing given falls back to the first unresolved configured race — unless the deprecated
   `RACE_*_ARTIST` pair is still set, which wins for one release and logs a warning.

Passing only one side has always been allowed (the other came from the env pair) and still
is: the missing side comes from whatever rule 4 resolves.

## Consequences

- `list_scrobble_races` is new, and answers with **standings**, not just ids and titles —
  "which race do I want?" is rarely settled by a name. One count query per race and *one*
  batched state read.
- Two things gained an `entity` echo: both sides of `get_scrobble_race`, and every side in
  the list. `leader.artist` and `leader.plays` still mean what they meant, so an existing
  caller is untouched.
- **`RaceSnapshot.leaderArtist` became `leaderLabel`.** The decision logic renders that
  string into every alert, and for an album race it is a record, not an artist. Same for
  `decideNowPlayingAlert`, which now takes sides rather than two artist names.
- **`Dockerfile` gained `COPY races.json ./`.** Without it the image boots, finds no races,
  and the whole feature disappears — which looks exactly like it working. This is the single
  most likely way to ship this broken.
- **A live now-playing read of an album side needs Last.fm to report the album**, and many
  scrobblers omit it on `track.updateNowPlaying`. No album, no alert. There is deliberately
  no artist-only fallback: both sides of `good-witch-vs-florescence` are Maisie Peters, so
  the fallback would fire "this song wins it" for a track off the *other* side of the race.
  The scrobble-side rungs at gap 1 and 0 cover the same ground (record 0016).
- Two overlapping sides are now expressible, so the loader rejects a race against itself and
  warns when one side is a whole artist and the other a subset of it — that race's gap can
  only ever widen.
- **Deploy step, not a code change:** remove `RACE_LEADER_ARTIST` and
  `RACE_CHALLENGER_ARTIST` from `/srv/bot/.env`, and subscribe the phone to any new topic.
  A race publishing correctly to a topic nobody is listening to is indistinguishable from a
  broken feature — the failure mode hetzner-server ADR 0011 exists to forbid.
- There is no Postgres in this repo's tests, so `matchesEntity` is a *model* of
  `entityCondition`, not a proof of it. They live in one file, are tested together over the
  same fixture, and the SQL half is additionally asserted on its rendered text — which
  catches a drift, but only makes one conspicuous rather than impossible.
