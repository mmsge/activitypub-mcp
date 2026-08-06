# 0029 — The scrobble count is a mirror of Last.fm, not a judgement: audit the short plays, change nothing

- **Status:** Accepted
- **Date:** 2026-08-06
- **Contributors:** Markus (reported the symptom; asked & decided: report only — no count changes anywhere, ingest stays a faithful mirror of Last.fm — and asked for a spectrum of thresholds rather than one verdict, so the sensitivity of the corrected gap stays visible) + Claude (agent decision on the technical diagnosis: traced the reported bug, established it is not in this codebase, and located the real cause upstream; proposed and implemented the audit, the now-playing result type and the boundary wording)
- **Affects:** `src/lib/scrobble-audit.ts`, `src/jobs/scrobble-audit.ts`, `scripts/scrobble-audit.ts`, `src/lib/fetch-lastfm.ts`, `src/mcp/tools/now-playing.ts`, `src/jobs/scrobble-race-nowplaying.ts`, `src/lib/scrobble-race.ts`, `src/mcp/tools/scrobble-race.ts`, `src/db/schema.ts`
- **Topics:** lastfm, scrobbles, ingest, data-quality, audit, notifications, ntfy

Amends [0016](0016-arm-the-race-one-play-early.md), which stands.

## Context

On 2026-08-06 the scrobble-race alert fired at 13:04 Oslo — *"250 to go — Maisie Peters
10,189 · Taylor Swift 10,439. Under 250 for the first time. Last play: 'Old Fashioned'"* —
while Markus was a few seconds into that track. The newest stored row was
`2026-08-06T11:03:50Z`, about ten seconds before the push. Last.fm's own scrobble
threshold for a 3m05 track would not have been met until `11:05:22Z`.

The obvious reading is that the ingest path persists Last.fm's live `nowplaying` entry as
a scrobble row, stamped with the poll time. **That reading is wrong**, and this record
exists mostly so nobody spends another day rediscovering it.

## The now-playing entry never becomes a row

`mapTrack` in `src/lib/fetch-lastfm.ts` has guarded it since the table was added, twice
over — the explicit attribute, and the missing `date` as a fallback:

```ts
const date = track.date as AnyObject | undefined
// The "now playing" entry has no date — skip it; it isn't a scrobble yet.
if ((track['@attr'] as AnyObject)?.nowplaying === 'true' || !date) return null
```

`playedAt` comes from `date.uts`; nothing in the ingest path reads the clock.
`syncScrobbles` inserts only what that mapper returns, `onConflictDoNothing()` against
`scrobbles_dedupe_idx (played_at, track_name, artist_name)`, so re-polling cannot
duplicate. None of this needed changing. What it needed — and now has — is
`src/lib/fetch-lastfm.test.ts`, which did not exist: the only Last.fm parsing code in the
repo had no unit coverage at all, which is precisely why the question could only be
settled by data forensics.

## The real cause is upstream, and it is not going away

Markus' scrobbler submits `track.scrobble` at track **start**, carrying the start time.
Last.fm accepts it, counts it, and serves it back in the dated list within seconds. A
track that is started and abandoned is therefore a genuine Last.fm scrobble.

The tell is a restart, from the live store on 2026-08-05:

| Time (UTC) | Track | Gap to next row |
|---|---|---|
| 15:04:51 | Mary Janes | 237 s — a full play |
| 15:08:48 | Mary Janes | **15 s** |
| 15:09:03 | Mary Janes | **1 s** |
| 15:09:04 | Mary Janes | 99 s |
| 15:10:43 | qUeStIoNs | 187 s |

Four rows for one song in six minutes. Same shape at 16:34:27 (`Kingmaker`, 32 s, then a
different track) and 15:51:13 (`My Regards`, 49 s). Sub-60-second inter-scrobble gaps,
200 consecutive rows sampled per window:

| May 23 | May 24 | Dec 24 | Feb 25 | May 25 | Sep 25 | Jan 26 | Aug 26 |
|---|---|---|---|---|---|---|---|
| 0.0 % | 0.0 % | 1.0 % | 0.5 % | 2.0 % | 2.0 % | 4.5 % | 7.0 % |

The behaviour appears around late 2024 and grows. It correlates with no change in this
repo, and it is not artist-specific — the Sep 2025 sample contains a sub-60 s Taylor Swift
row. It is nonetheless one-sided *in effect*: since 2024-06-01 Taylor Swift has 220 plays
against Maisie Peters' 3,589, so nearly all of the leader's total was banked before the
scrobbler changed.

Two further reported symptoms were not defects. A row that appeared to be missing at
`11:06:55Z` had simply not synced yet (the sync runs every 60 s; the check was at
`11:07:19Z`), and playback had not stopped — rows continue to `11:19:57Z`.

## Decision — ingest stays a faithful mirror

No dedupe rule, no minimum-play filter, no new column, no migration, no tool parameter
that changes a count. `get_scrobble_race` is byte-identical after this change.

Last.fm is the system of record, and the race is a race against a number anyone can read
on last.fm.com. A local count that disagrees with it is not a better truth, it is a second
one — and the first question about every future discrepancy would become "which of our two
numbers is this?". Markus' call.

## Decision — the audit reports a spectrum, not a verdict

`npm run scrobble-audit` classifies every play at four thresholds — under 30 s, under
60 s, under half the track's estimated length, and Last.fm's own rule of
`min(half, 4 min)` — per artist, per year, with the corrected head-to-head at each. One
number would hide how much the answer depends on where the line is drawn. Markus' call.

A bare "under 4 minutes" threshold is deliberately **absent**. Last.fm's rule is half the
track *or* four minutes, whichever comes first; a flat 240 s would flag every complete
play of an ordinary three-minute song. That is the easiest way to misread the rule.

A play's length is bounded only by the next row's `played_at`. Where there is no next row,
or it is past a 15-minute session ceiling, the play is reported as **unbounded** and is
never counted as suspect — it may have run to the end or been abandoned after eight
seconds, and nothing available can tell which.

## Decision — the duration estimate refuses to guess

Track length is `percentile_disc(0.9)` over that track's in-ceiling gaps: a track played
to the end contributes its own length, restarts contribute less, so the upper tail is the
track, and the 0.9 trims session breaks that squeaked under the ceiling.

It is trusted only at **≥ 10** in-ceiling observations, and only inside 30–900 s. The
minimum matters and is easy to "simplify" away: at n ≤ 10 the 0.9 percentile *is* the
largest observation, so one long gap would set the entire estimate. Below the threshold the
play is `no-estimate` and counted as **kept**, never as suspect. No corpus-median fallback
— an invented duration could only inflate the suspect count, which is the one direction
this audit must not err in.

The whole job runs inside `SET TRANSACTION READ ONLY`, so it cannot write even by
accident, and one snapshot serves every figure it prints.

## Decision — "nothing playing" and "upstream failed" stop being one value

`fetchNowPlaying` returned `null` for a network error, a non-OK status, a Last.fm error
body *and* genuinely-nothing-playing; `get_now_playing` then cached that conflated
`{ nowPlaying: false }` for twenty seconds. One failed request manufactured a window of
"nothing is playing" out of nothing. This is the same silence ADR 0016 called out, closed
at the source.

`fetchNowPlaying` now returns `{ ok: true, track }` or `{ ok: false, reason }`, and the
tool has three states: `true`, `false`, and `null` with an `error`. `null` rather than
`false` with an extra field, so a consumer writing `if (!res.nowPlaying)` cannot read an
outage as silence. Failures are never cached. The race's now-playing watcher treats a
failed read as "no alert this tick" and logs why, rather than passing it on as `null`.

Worth stating plainly, because it will look like a regression otherwise: on this account
`get_now_playing` is permanently `false` mid-song, because the scrobbler never sends
`track.updateNowPlaying`. That is an honest read of an upstream with nothing to report —
and it is exactly why the two cases had to become distinguishable.

## Decision — the milestone comparison stays inclusive; the copy changes

`tightestCrossed` uses `gap <= m`: a rung is crossed **on** the number. That is deliberate
and pinned by a test (*"stays quiet one play above a rung and fires exactly on it"*), and
making it strict would delay every alert by one play. So the body was the wrong half to
defend: at a gap of exactly 250, "Under 250 for the first time" is simply false, however
correct the "250 to go" title is. `milestoneReach` now says *At 250* on the number and
*Under 250* below it.

An existing test asserted `Under 75 for the first time` at a gap of exactly 75 — the bug
was pinned as correct behaviour, which is why it survived.

The other messages were audited and left alone: the endgame per-play alert, the
leader-answered alert, the two armed rungs and the overtake message all quote the actual
gap or test exact equality (`gap === 0`, `gap === 1`) rather than asserting a threshold.
There is no second instance of this bug to find.

Separately, `get_scrobble_race`'s `next_milestone` was a *second, independent* comparison
(`m < gap`) for the same question the notifier answers with `tightestCrossed`, and the two
had drifted: at a gap of exactly 250 the tool reported the next rung as 200 while the
notifier was about to fire 250. It is now derived from `tightestCrossed`, so there is one
predicate rather than two that agree by coincidence.

## Consequences

- No count anywhere changes. `get_scrobble_race` and `get_scrobble_stats` continue to
  match last.fm.com exactly, which is the point.
- Acting on the audit means changing the **scrobbler**, not this store. Deleting rows here
  would leave the local total disagreeing with Last.fm while the underlying submissions
  carried on.
- The sub-60-second share is *rising*, so the audit is worth re-running rather than
  treating as a one-off answer.
- `get_now_playing` gains a third response state. Consumers testing truthiness are
  unaffected; consumers testing `=== false` will now miss the failure case, which is the
  intended behaviour change.
- The overtake copy says "your new all-time #1", which is true only because the configured
  leader happens to be the actual chart-topper. A head-to-head is not the whole chart. Not
  worth a change now; worth knowing if a third artist ever sits above both.
