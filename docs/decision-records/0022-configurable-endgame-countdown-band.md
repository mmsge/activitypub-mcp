# 0022 — Make the endgame countdown band explicit, and let `endgame_*` mean it

**Status:** Accepted
**Date:** 2026-08-05
**Topics:** ntfy, notifications, lastfm, scrobbles, jobs, state, mcp-tools, naming
**Contributors:** Markus (asked & decided: repurposing the `endgame_*` fields rather than adding new ones, keeping the leader-answered alert, the band's default of 10, and that re-entry may resend) + Claude (found the naming collision, proposed and implemented)

Amends [0015](0015-scrobble-race-notifications.md) and [0016](0016-arm-the-race-one-play-early.md), which stand otherwise.

## Context

A request arrived for a per-play countdown through the final stretch of the scrobble
race, on the evidence that `get_scrobble_race` reported `endgame_gap: 0` and
`endgame_armed: false` — so, it reasoned, nothing could fire between the last milestone
(250) and the overtake itself.

The countdown already existed and had since 0015. What did not exist was any way to
tell that from the output.

## The trap: one name, two features

`RACE_ENDGAME_GAP` governed the **live now-playing watcher** — the predictive alert that
names the track playing right now — which 0016 turned off by default because the
scrobbler never sends Last.fm's `track.updateNowPlaying`. That is the 0 in the output.

The **per-play countdown** was a different thing entirely, and was not configured at all.
It ran below a "fine zone" computed as `Math.min(...milestones)`: an emergent property of
the milestone list, 10 with the default ladder. So the countdown's threshold was a
side-effect of the last rung of an unrelated setting, invisible in the output, and
impossible to widen without inventing a milestone you did not want announced.

Two knobs, one word, and the output surfaced the disabled one. A reader with the tool
response in front of them could reach a confident, precise, wrong conclusion about which
alerts the system was capable of sending — which is worse than an obviously missing
field, because nothing prompts them to check.

## Decisions

### The band becomes `RACE_COUNTDOWN_GAP`, and `endgame_*` reports it

The countdown band is now its own setting, defaulting to 10 so the deploy changes no
behaviour. `get_scrobble_race` reports it as `endgame_gap`, and the now-playing threshold
is renamed `RACE_NOWPLAYING_GAP` and surfaced separately as `nowplaying_gap`.

Repurposing a published field rather than adding `countdown_gap` alongside it was the
deliberate choice. `endgame_gap` read 0 and `endgame_armed` read false in every response
ever served, so no consumer had learned to depend on their meaning; and "endgame" is
plainly the better word for the countdown than for a watcher that has never once fired.
The alternative left two similarly-named knobs side by side and preserved the exact
confusion this record exists to remove.

### The band gates the countdown, never the finish

The obvious implementation makes every endgame alert conditional on `gap <= band`. That
would mean `RACE_COUNTDOWN_GAP=0` — documented as "no countdown alerts" — also silently
disabling the gap-1 and gap-0 alerts, which are the whole of 0016 and the only alerts
that work without a now-playing feed.

So the condition is `gap <= 1 || gap <= countdownGap`. The three decisive alerts — one
more levels it, the next track takes it, and the overtake — fire at any band including 0.
The band governs only the generic "N to go" countdown between the ladder and the finish.
Setting it to 0 buys you the ladder plus the finish, not silence.

### `endgame_armed` is a latch, not a level

It was computed live, as `gap >= 0 && gap <= threshold`. Read as a level it flickers: the
leader scrobbling twice reports a race that has demonstrably reached its endgame as no
longer in one, and nothing anywhere records that it ever got there.

It is now a stored timestamp, `endgame_armed_at`, set on the first observation at or
inside the band and never cleared — not by the leader pulling away, not by the overtake.
The latch is deliberately also advanced on a tick where nothing scrobbled, so widening
the band shows up on the next poll rather than waiting for a play that may be hours off.
That costs no extra write: the job already persists state on every silent tick.

### `overtaken_at` is when the track played, not when we noticed

It was stamped `now` — the moment the sync ran. With a 60-second poll those differ by up
to a minute, and of the two the ingest clock is the one detail about the moment worth
nothing. It is now the `playedAt` of the play that pushed the gap negative, which is
unambiguously the latest challenger play: that branch is only reachable on changed counts.
It still writes exactly once, guarded by the existing `if (prev.overtakenAt)` short-circuit.

## Consequences

- Deploying changes no behaviour. The band defaults to the 10 it was already computing,
  and the current race (gap 297) is nowhere near it.
- `endgame_armed` stays false until the race genuinely reaches the band, and then stays
  true forever. It is a statement about the race's history, not its current position.
- Widening the band is now a one-line `.env` edit and a restart, which is what makes the
  known 15–20 second alert latency tolerable: buy margin with a wider band rather than
  by chasing the scrobbler's timing.
- A leader scrobble inside the band still fires its own `leader-answered` alert. It is
  distinct from a countdown alert in tag, priority and wording, and was kept deliberately
  rather than being read out of existence by the "only challenger plays notify" framing.
- Re-entering the band after the gap widens past it re-announces, because the milestone
  and no-op branches still clear `lastAnnouncedGap`. Accepted: the leader has been static
  for days, and a duplicate at the sharp end costs less than a silence.
- `decideRaceAlert` takes the band as a **fifth** parameter, after `now`, purely so the
  existing call sites keep working. It defaults to `Math.min(...milestones)`, the old
  derivation, so anything that omits it behaves exactly as before — which is what lets
  the pre-existing tests stand unmodified as evidence the refactor was behaviour-preserving.
