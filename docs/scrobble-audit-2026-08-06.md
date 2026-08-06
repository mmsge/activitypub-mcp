# Scrobble audit — 6 August 2026

**Nothing was deleted, migrated or recounted.** This is a report. Every number the app
serves is unchanged, and `get_scrobble_race` still matches last.fm.com exactly. See
[ADR 0030](decision-records/0030-the-scrobble-count-is-a-mirror-not-a-judgement.md) for why
that is deliberate.

These are the **exact figures**, from `npm run scrobble-audit` against the production
database — 51,398 rows, the whole history. An earlier draft of this document carried a
sample-based estimate that was badly wrong in both directions; what it got wrong, and why,
is recorded at the end, because the sampling mistake is more reusable than the numbers.

## What is being counted

`played_at` is the moment a track **started**. The scrobbler in use submits
`track.scrobble` at track start rather than at Last.fm's threshold (half the track, or four
minutes), so a track that is started and then skipped or restarted becomes a genuine
Last.fm scrobble. Last.fm counts it; this store mirrors Last.fm; the race counts it.

A row's real play length is bounded only by the next row's `played_at`. Rows with no
successor, or one past the 15-minute session ceiling, are **unbounded**: their length is
unknowable, so they are never counted as suspect. There are 4,795 of them (9.3%).

> **Amended after the first run.** The run below counted **timestamp collisions** — rows
> sharing a `uts` with their neighbour, which is a batch submission, not a play that was cut
> short — as suspect. They now have their own bucket and are excluded from every suspect
> count. The suspect figures and the ~3 % share below are therefore **upper bounds**; the
> race conclusion is unaffected, since collisions occur on both sides. Re-run
> `npm run scrobble-audit` for the corrected figures and replace this note with them.
>
> The same run also displayed 25 zero-gap rows in its evidence table and not one of the 246
> restarts, because the ordering let collisions consume the whole limit. Restarts now get
> their own table.

## The headline: the correction is a wash

**246 sub-60-second plays are followed by the same track again** — restarts, which only a
scrobble submitted at track start can produce. The mechanism is real and confirmed.

But it barely moves the race, because it applies to **both** artists at almost the same rate.

| Threshold | Taylor suspect | Maisie suspect | gap now | gap corrected | change |
|---|---:|---:|---:|---:|---:|
| under 30 s | 295 | 272 | 228 | **205** | −23 |
| under 60 s | 312 | 331 | 228 | **247** | +19 |
| under half the estimated length | 410 | 381 | 228 | **199** | −29 |
| Last.fm's own rule, `min(half, 4 min)` | 392 | 381 | 228 | **217** | −11 |

The four thresholds **disagree on the direction**. Correcting the race makes the gap
smaller under three of them and larger under one, and every result sits within ±29 of the
reported 228. That is the answer: **the race is where it says it is.** No projection, no
milestone and no crossover date is materially wrong.

This is precisely what asking for a spectrum rather than a single verdict was for. One
threshold, quoted alone, would have read as a confident correction in whichever direction
it happened to fall.

Unbounded plays are 1,224 for Taylor against 768 for Maisie — the error bar, and it leans
slightly towards Taylor having *more* uncounted short plays rather than fewer.

## Overall

| Threshold | suspect | share | kept | unbounded | no estimate |
|---|---:|---:|---:|---:|---:|
| under 30 s | 1,175 | 2.29 % | 45,428 | 4,795 | 0 |
| under 60 s | 1,496 | 2.91 % | 45,107 | 4,795 | 0 |
| under half the estimated length | 1,544 | 3.00 % | 45,059 | 4,795 | 5,570 |
| Last.fm's own rule | 1,525 | 2.97 % | 45,078 | 4,795 | 5,570 |

The four land within 0.7 points of each other, so the answer is not sensitive to where the
line is drawn — about **3 % of the history** is a play that was cut short.

5,570 rows (10.8 %) have no trusted track length, so the two relative columns are floors.

The per-artist table shows why the relative threshold earns its place. Pikekyss has 56
plays under 60 seconds but only **2** under half their own length: those are short tracks
played in full, and the absolute thresholds misread every one of them. Michelle Ullestad is
the same shape (34 → 20).

## When it started — earlier than it looked

| Year | plays | suspect < 60 s | share |
|---|---:|---:|---:|
| 2016 | 485 | 9 | 1.86 % |
| 2017 | 133 | 1 | 0.75 % |
| 2018 | 680 | 20 | 2.94 % |
| 2019 | 1,957 | 24 | 1.23 % |
| 2020 | 2,021 | 30 | 1.48 % |
| 2021 | 1,664 | 53 | 3.19 % |
| 2022 | 4,872 | 166 | 3.41 % |
| 2023 | 18,031 | 492 | 2.73 % |
| 2024 | 11,731 | 181 | 1.54 % |
| 2025 | 3,776 | 166 | 4.40 % |
| 2026 | 6,048 | 354 | 5.85 % |

There is a background of 1–3.4 % running the entire length of the history. It does not
start in 2024; 2022 sits at 3.41 % and 2023 at 2.73 %, both higher than 2024's 1.54 %.

What is real is the **recent rise**: 4.40 % in 2025 and 5.85 % in 2026, the two highest
years on record. That is worth watching. It is a rise from a substantial baseline, not from
zero, and it is not evidence of a change in this repository — the ingest path is unchanged
since the table was added.

## Recommendation

**Fix the scrobbler if you want fewer of these rows — but not to fix the race.** The race
does not need fixing. These are real Last.fm scrobbles, they are in the public profile, and
they affect both artists about equally.

The case for changing the scrobbler is now about **data quality in general**, not about the
head-to-head: roughly 3 % of a ten-year listening history records plays that never happened,
and the rate is climbing.

There is no threshold setting to tune. Qobuz's Last.fm integration is an account-level
connection configured in its desktop/web settings, so the options are to replace it with a
local scrobbler or leave it. Worth ruling out first: Qobuz Connect can register plays from
signed-in devices that are not producing audio, so signing out of idle devices and re-running
this audit in a month is the cheapest possible test.

**No local cleanup is recommended.** Deleting rows here would leave this database disagreeing
with last.fm.com for a correction worth ±29 plays on the only number anyone is watching.

## What the earlier estimate got wrong, and why

The first version of this document estimated the corrected gap at **~555 (range 280–827)**
against a reported 228. The true range is **199–247**. The estimate was not merely imprecise
— it pointed the wrong way, and its confidence interval did not contain the answer.

Three compounding errors, all from the same root:

- **It claimed the behaviour began in 2024**, from samples reading 0 % in 2023 and mid-2024.
  The real figures are 2.73 % and 1.54 %.
- **It claimed the inflation was one-sided.** Taylor's true suspect count (295–410) is
  roughly equal to Maisie's (272–381). The sample put Taylor at 161.
- **It imputed a 10 % rate for Maisie in 2024** from 160 sampled rows. The real year is
  1.54 %.

The root cause is that the sample was drawn as **contiguous 200-row blocks**, and a
contiguous block of scrobbles is one listening session. Sessions are internally correlated:
an album played straight through contains no skips at all, an afternoon of shuffling
contains many. So each block behaved like a single observation rather than 200 independent
ones, and the Wilson intervals — which assume independent draws — were far too narrow. 2023
was sampled at 643 rows out of 18,031, in two windows that happened to be clean album runs.

The lesson is not "sample more". It is that **a time-ordered behavioural history cannot be
block-sampled** for a rate that varies by session. Either draw rows at random across the
whole span, or measure the whole thing — which, at 51,398 rows and a few seconds of query
time, was always the cheaper option.
