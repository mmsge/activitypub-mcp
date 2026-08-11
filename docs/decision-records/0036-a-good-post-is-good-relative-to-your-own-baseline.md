# 0036 — A good post is good relative to your own baseline: a percentile ladder, a hard floor, and a high-water mark an un-favourite cannot lower

- **Status:** Accepted
- **Date:** 2026-08-11
- **Contributors:** Markus (asked for the feature and decided: that the bar is his own baseline rather than fixed numbers, the fav/boost/reply weighting, the three-rung ladder plus a daily digest, the fast lane for young posts, that every post the bot holds counts regardless of visibility, and that the digest lands in the evening on the same topic) + Claude (agent decision on the technical shape: the peak-score rule, the silent seed, the two guards against a quiet baseline, the strict-ordering of the rungs, the runner-up comparison, and the weights fingerprint)
- **Affects:** `src/lib/post-breakout.ts`, `src/lib/breakout-store.ts`, `src/jobs/post-breakout.ts`, `src/jobs/breakout-fast-lane.ts`, `src/jobs/breakout-digest.ts`, `src/mcp/tools/post-breakouts.ts`, `src/admin/views/breakouts.tsx`, `drizzle/0029_post_breakout_state.sql`
- **Topics:** ntfy, notifications, engagement, activitypub, jobs, state, mcp-tools

## Context

Markus posts from three accounts — `@markus@skvip.lol`, `@markus@pixelfed.babb.no` and
`@mvrkws@bookwyrm.social` — and only ever learned that a post had done well by opening
the app and noticing. He wanted to be told while it was still happening.

Everything needed was already here. `sampleEngagement()` has been snapshotting
favourites/boosts/replies for every followed actor's recent posts hourly into
`engagement_snapshots`, and `publishNtfy()` has been pushing to `n.msge.no` for the
scrobble race since record 0015. The feature is a watcher over data we already hold plus
a publisher we already have — the same sentence that opens 0015, and the same shape:
a pure decide function, a latching state row, and a job that persists nothing on a
failed push.

What is genuinely new is the *judgement*. "Did particularly well" has no absolute
meaning: 24 favourites is a quiet day for some accounts and a personal best for others,
and Markus' own reach changes over time. The bar therefore has to be his own history.

Eleven of the choices below are non-obvious enough that a later, well-meaning edit would
plausibly reverse them.

## Decisions

### The bar is per-account, and the score is weighted

`score = favourites·1 + reblogs·3 + replies·2`. A boost puts the post in front of an
audience that was not already there; a reply costs real effort; a favourite is one tap.

Percentiles are computed **per actor**, never pooled. A pixelfed photo and a Mastodon
toot draw on different audiences on different software, and pooling them would let the
busiest account set the bar for the quietest — which in practice means the quiet accounts
would never fire and the busy one would fire constantly.

### Two guards against a quiet baseline, and one alone is not enough

A percentile is relative, which is the point, and also the hazard: after a quiet
fortnight `percentile_cont(0.9)` can legitimately be **2**, and a two-favourite post is
not a compliment.

- `BREAKOUT_MIN_SCORE` (default 10) is an absolute floor. Every rung is lifted to at
  least it. "Better than your usual" also has to mean *something happened*.
- `BREAKOUT_MIN_POSTS` (default 20) refuses to arm an account at all below that many
  scored posts in the window. A p99 over eight posts is "best of eight" wearing a
  statistician's hat.

Neither guard subsumes the other: the floor does not help an account with six
high-engagement posts, and the population gate does not help an account with two hundred
quiet ones.

The rungs are also forced **strictly apart** (`p99 > p90`, `best > p99`). On a flat
population `percentile_cont(0.9)` and `percentile_cont(0.99)` can land on the same
number, and colliding rungs would mean a post crossed both at once — permanently making
the middle rung unreachable. Percentiles are rounded **up**, so a p90 of 23.4 fires at
24 and the number quoted in the push is the number that was cleared.

### The ladder is judged on the PEAK score, not the latest one

`engagement_snapshots` says so in its own comment: counts go down, and negative deltas
there are correct rather than corruption. Every score in this feature — the candidate's,
and every post's contribution to the baseline — is therefore
`max(…)` over that post's whole snapshot history.

This is a deliberate divergence from `get_actor_engagement_trends`, which uses
`LEFT JOIN LATERAL … ORDER BY sampled_at DESC LIMIT 1` and is right to: it is charting
what posts look like *now*. This module is deciding whether something has ever been
exceptional. Reading the latest snapshot instead would mean:

- one un-favourite on the record holder quietly lowers the bar every future post is
  measured against;
- a post could "beat a personal best" it never actually beat;
- a post that reached p99 and settled back under it would re-fire on the way up again.

A pleasant second-order consequence: because the peak is *derived* from an append-only
table rather than stored, the job can persist nothing at all on a failed push and still
recompute the identical decision next tick.

### A post is never asked to beat itself

The record rung compares against `max(score)` over the actor's **other** posts —
`second_best` when the candidate already holds the record, `best` otherwise. Without it
the current record holder could never be told it had extended its own record, and worse,
would be compared against a number it had itself just set.

### The first sighting of a post is silent

`decideBreakout` returns `kind: 'seeded'` with **no message** when there is no prior
state, recording the rung the post has already reached without stamping a time on it.

This is the only thing standing between switching the feature on and replaying a year of
history into his phone in one minute. It is 0015's "switching it on mid-race is silent"
property, and it is why `rung` and the three `*_at` columns are stored separately: `rung`
answers "is this rung spent?", the stamps answer "was anyone ever told?". A single
column cannot answer both, and the digest needs the second question — otherwise the
evening after a deploy would report the entire archive as today's news.

For the same reason, an account whose baseline is **not established** has nothing
written for it at all, not even a seed. Seeding there would spend the ladder against a
bar we do not believe in, and those posts could then never announce once the account did
establish.

### Only the furthest rung fires

A post that jumps straight past the record announces the record, not the p90 it passed
on the way. The intermediate rungs are spent, not announced. Saying "over your p90" about
a post that has just taken the record is worse than saying nothing — 0015's ladder rule,
restated for three rungs instead of eleven.

### State advances only on a delivered push, per post

Inherited verbatim from 0015, and restated here because it is the first thing a "tidy
this up: decide, persist, then notify" refactor would break. If `notify()` returns false,
**nothing is written for that post** — not even the score. The next tick recomputes the
same peak, decides the same rung and retries.

Per post, deliberately: one post's push failing must not stall the rest of the run.

Both jobs also refuse to run when `NTFY_PASSWORD` is empty. Advancing rungs while every
push 401s would march the ladder past alerts nobody was ever told about — the silent
no-op hetzner-server ADR 0011 exists to forbid, after weeks of pushes failing unnoticed
when the shared `markus` password drifted.

### Its own ntfy topic

`NTFY_TOPIC_BREAKOUT`, default `tut-treff`, passed as `publishNtfy`'s second argument —
the parameter exists for exactly this. Sharing `scrobble-race` would mean muting the
countdown also mutes the post alerts, and the two say completely different things: one of
them ends, the other is permanent.

### Two cadences, one decision path

The hourly pass is chained to `sampleEngagement()` inside its existing timer and spends
**zero** remote API calls — it reads the rows the sampler just wrote. Same argument 0015
gives for chaining the race to the scrobble sync: an independent interval would only add
a window in which it reads stale counts.

The fast lane is the sole part of the feature that talks to remote instances. It exists
because a post that takes off does so in its first hours, and being up to an hour late
turns "this is happening" into "this happened". It is bounded per actor per tick
(`BREAKOUT_FAST_LANE_MAX_POSTS`, default 10), skips posts already at the top rung, and
costs nothing on a day he has not posted.

The two lanes deliberately overlap on young posts and need no coordination:
`skip_unchanged` writes no snapshot when counts have not moved, and the `rung` latch
makes a second decision a no-op. If the remote cost ever needs trimming, cut
`MAX_POSTS` rather than lengthening the interval — the value is entirely in the first
hours.

### The digest decides for itself whether it is due, and a quiet day is silent

No cron: the digest runs on every hourly tick and checks, the model
`publishStatusNote` already uses. Its cursor is a `server_config` row — one timestamp
does not deserve a table.

The day key is computed in **Europe/Oslo via `Intl`, never by UTC arithmetic**. Oslo is
UTC+1 or UTC+2 depending on the month, so a UTC key would skip or double the digest twice
a year. Record 0019's rule — a bucket is computed in the timezone its label is read in.

**A day with nothing to report sends no push at all**, and still advances the cursor.
This is the one place state moves without a delivered push, and it is not a hole in the
rule above: the cursor is advancing past *nothing to deliver*, not past an undelivered
alert. A composed digest that fails to publish leaves the cursor alone and retries the
same evening, exactly like a per-post alert. The reason for the silence is that a nightly
"ingenting skjedde i dag" trains you to mute the topic, which costs you the alerts that
matter.

### Weights are part of the persisted state

`weights_key` fingerprints `BREAKOUT_WEIGHT_*` on every row. Changing one weight
re-scores the whole archive in a single tick, which without the guard reads as fifty
posts breaking out in the same minute. A key mismatch is treated as a first sighting:
recompute, pre-mark, persist, say nothing. Earlier `*_at` stamps are preserved, so the
history is not lost — only not re-announced.

### No visibility filter — Markus' call, with a cost

Every post the bot holds is in the population, followers-only and unlisted alongside
public. The cost, accepted: a followers-only post is measured against a bar set mostly by
public posts, so it will rarely clear one. `visibility` is carried onto every row in the
tool and the admin table so that stays visible rather than mysterious.

The REST endpoint is a separate question and is bound to `publicOnly` like every other
endpoint serving post rows (record 0026) — so its percentiles are computed over public
posts alone and can legitimately differ from the MCP tool's. The endpoint description
says so.

### The push copy is Nynorsk, diverging from the scrobble race

Every user-facing string this codebase composes is already Nynorsk —
`composeIntro`/`composeStatus` in `publish-status-note.ts`, which even formats its dates
`nn-NO`. The scrobble race's copy is English and is the outlier; it is left alone here
rather than migrated, because that is a cosmetic change with its own test churn and no
connection to this feature. `publishNtfy` posts a JSON body precisely so titles carrying
`å`/`ø`/`æ` survive, so there is no technical cost to the choice.

## Consequences

- Switching the feature on is silent by construction. The first pass seeds every tracked
  post; the second onward is live. `BREAKOUT_ENABLED` is off by default, so the code can
  be deployed and inspected at `/admin/breakouts` days before anything is armed.
- `get_post_breakouts` computes baselines, thresholds and `armed` **live from the
  archive** rather than from the notifier's state, so it answers correctly even when
  notifications are unconfigured. `armed` non-empty with nothing arriving on the phone
  means the push is failing, not that nothing qualifies — that distinction is the whole
  reason the field exists, and the admin page leads with it.
- **The sampler's window is the feature's horizon.** `sampleEngagement()` tracks the
  most recent `ENGAGEMENT_SAMPLE_RECENT_POSTS` (default 20) posts per actor, so a post
  that goes viral after twenty newer ones have been published has stopped being sampled
  and can no longer break out. Accepted: the alternative is re-reading the whole archive
  hourly against three remote instances.
- **BookWyrm may never establish a baseline.** `fetchEngagement` falls back to AP
  collection totals when the Mastodon REST shape is absent, and `extractApCounts` can
  report `'unsupported'`. If bookwyrm.social yields no counts, that account simply never
  fires. The design makes this *visible* — `established: false` with a reason, and a
  yellow badge on the admin page — rather than silent, which is the most that can be done
  from this side.
- The bar drifts upward over a good year: each breakout is itself in the window, raising
  the percentile for the next one. That is what "relative to your current baseline"
  means, and it is why the record rung is deliberately *not* windowed — there is always
  one rung that cannot drift.
- A baseline read once via REST and once via AP takes its peak from whichever reported
  more, so it is quietly "the most generous reading we ever got". Within one account the
  origin is constant, so this only bites if an instance changes what it exposes.
