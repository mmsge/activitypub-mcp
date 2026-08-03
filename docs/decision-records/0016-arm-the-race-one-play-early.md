# 0016 — Arm the decisive race alerts one play early, and never treat a dead heat as the finish

**Status:** Accepted
**Date:** 2026-08-03
**Topics:** ntfy, notifications, lastfm, scrobbles, jobs
**Contributors:** Markus (asked & decided: solve it in the alert copy rather than by changing his scrobbler) + Claude (found both faults, proposed and implemented)

Amends [0015](0015-scrobble-race-notifications.md), which stands otherwise.

## Context

0015 built the scrobble-race watcher, whose headline feature was a live alert naming the
track playing *right now* as the one about to take the lead. On the first deployment that
alert never fired, and chasing it turned up two separate faults.

## The trap: scrobbling works, now-playing doesn't

The live alert reads Last.fm's now-playing entry. Twenty-four consecutive polls over four
minutes returned no now-playing entry at all — while music was demonstrably playing, and
while scrobbles for those very tracks were landing correctly a minute or two later.

`track.updateNowPlaying` is a **separate API submission** from the scrobble. A player can
scrobble flawlessly for years and never make that call, and nothing about the scrobble
history reveals it. Worse, the failure is silent in both directions: `fetchNowPlaying()`
returns `null` for "nothing playing" and for "this setup never reports", so the watcher
polls forever and logs nothing.

The design assumed the feed existed because `get_now_playing` existed in the codebase.
Having a function that reads a signal is not evidence that anything produces it.

## Decisions

### The decisive alerts fire one play early, off scrobbles alone

A scrobbler tells you what *finished*, never what is about to start. So the only honest
way to say "this one wins it" without a now-playing feed is to say it before the play:

- **gap 1** — "One more play levels it."
- **gap 0** — "Whatever track you play next takes the all-time #1. Choose it."

Both at max priority. This is arguably better than the original: it arrives while you are
choosing the song rather than a minute into it.

The live now-playing variant is kept but **`RACE_ENDGAME_GAP` now defaults to 0**, with
the prerequisite documented in `config.ts` and `.env.example`: verify `get_now_playing`
returns `nowPlaying: true` before enabling it, or the job polls Last.fm indefinitely for
a signal that never comes.

### A dead heat is not the finish

The original branch was `if (gap <= 0)`, which set `overtakenAt` and made the watcher
permanently inert. At a dead heat that is exactly wrong: level is not ahead. The watcher
would have announced "10,439 all" and then gone silent **through the actual overtake** —
swallowing the one alert the entire feature exists to deliver.

The finish is now `gap < 0` alone. A dead heat is its own alert, the watcher stays live,
and if the leader answers back and is caught again, the arming alert re-fires. Seeding
follows the same rule.

This one is worth guarding rather than remembering: `scrobble-race.test.ts` pins the
sequence 1 → 0 → −1 end to end and asserts `overtakenAt` stays null at level.

## Consequences

- The feature works on any setup that scrobbles at all, which is the realistic baseline.
- Anyone enabling `RACE_ENDGAME_GAP` must check the now-playing feed first. If a future
  scrobbler does provide it, the live alert still works and complements the armed ones.
- `checkRaceNowPlaying` returns silently at every guard, so logs cannot say which
  condition bailed. That cost real time to diagnose here; a future change should log the
  disarm reason once rather than per poll.
