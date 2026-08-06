# Scrobble audit — 6 August 2026

**Nothing was deleted, migrated or recounted.** This is a report. Every number the app
serves is unchanged, and `get_scrobble_race` still matches last.fm.com exactly. See
[ADR 0030](decision-records/0030-the-scrobble-count-is-a-mirror-not-a-judgement.md) for why
that is deliberate.

## What is being counted

`played_at` is the moment a track **started**. The scrobbler in use submits
`track.scrobble` at track start rather than at Last.fm's threshold (half the track, or four
minutes), so a track that is started and then skipped or restarted becomes a genuine
Last.fm scrobble. Last.fm counts it; this store mirrors Last.fm; the race counts it.

A row's real play length is bounded only by the next row's `played_at`. So the question
"did this play qualify?" is answerable from the gap to the next row — and only that.

## Method, and what it cannot tell you

The exact figures come from running the committed audit against the production database:

```bash
ssh msge 'cd /srv/bot && docker compose exec -T app npm run scrobble-audit'
```

That was not possible from where this report was written (no SSH client, and the REST API
requires a key), so the numbers below are an **estimate** from a large stratified sample
pulled through the `get_scrobbles` MCP tool: **8,529 of 51,386 rows (16.6 %)**, covering
every year from 2016 to 2026, loaded into a local Postgres and passed through the same
`src/lib/scrobble-audit.ts` classifier the script uses. Ranges are 95 % Wilson intervals on
the sampled rate, scaled by exact per-era play counts from `get_scrobble_stats`.

Three limits worth stating plainly:

- The sample is 39 contiguous blocks, not one run. Rows at a block edge have no known
  successor and are classified **unbounded** — never suspect. That makes every figure here
  a **floor**, not a ceiling.
- Track-length estimates need ≥ 10 observations of the same track. In a 16 % sample most
  tracks do not reach that, so 3,529 rows fall to `no-estimate` and the two
  length-relative thresholds are badly under-populated. **Only the `<30 s` and `<60 s`
  columns are trustworthy at this sample size.** On the full history the relative
  thresholds would be the more meaningful ones.
- Where an artist's own sample in an era is under 20 rows the rate is imputed, and marked
  as such below.

## Where the plays are

This is the finding that makes the distortion one-sided, and it is not about the bug at
all — it is about when each artist was listened to.

| Era | Taylor Swift | Maisie Peters |
|---|---:|---:|
| before 2024 | 10,214 | 4,259 |
| 2024 | 30 | 2,450 |
| 2025 | 109 | 676 |
| 2026 (to 6 Aug) | 86 | 2,820 |
| **total** | **10,439** | **10,205** |

97.8 % of the leader's plays were banked before 2024. 57.3 % of the challenger's were not.
Exposure to the affected period is 225 plays against 5,946 — a factor of 26.

## When it started

Sub-60-second gaps per Oslo year, from the sample, split by whether the *next* scrobble
repeats the same track. A repeat is a **restart**, and a restart can only be produced by a
scrobble submitted at track start — it is the unambiguous signature.

| Year | sampled | < 60 s | of which restarts | share |
|---|---:|---:|---:|---:|
| 2016 | 485 | 9 | 8 | 1.86 % |
| 2017 | 133 | 1 | 0 | 0.75 % |
| 2018 | 200 | 6 | 0 | 3.00 % |
| 2019 | 398 | 5 | 0 | 1.26 % |
| 2020 | 402 | 4 | 0 | 1.00 % |
| 2021 | 400 | 7 | 0 | 1.75 % |
| 2022 | 400 | 3 | 0 | 0.75 % |
| 2023 | 643 | 1 | 0 | 0.16 % |
| 2024 | 1,557 | 34 | 1 | 2.18 % |
| 2025 | 1,893 | 77 | 25 | 4.07 % |
| 2026 | 2,018 | 131 | 49 | 6.49 % |

Two different things are visible here, and conflating them would overstate the case.

**The old one, 2017–2023.** A low background of short gaps, almost all under five seconds,
almost none of them restarts. Consecutive *different* tracks landing within five seconds of
each other is a batch or offline flush, not a skip. It runs at roughly 1 % and shows no
trend.

**The new one, from 2024.** Restarts appear — 1 in 2024, 25 in 2025, 49 in 2026 — and the
overall short-gap share triples. This is the scrobble-at-start behaviour, and it is
**growing**: 2.18 % → 4.07 % → 6.49 %.

It does not predate any change in this repository. The ingest path has been unchanged since
the `scrobbles` table was added, and the guard that drops Last.fm's live `nowplaying` entry
has been there the whole time.

## The head-to-head

Raw, as `get_scrobble_race` reports it at 2026-08-06T11:56Z:

**Taylor Swift 10,439 · Maisie Peters 10,205 · gap 234.**

Estimated plays that never met Last.fm's own threshold, `< 60 s`:

| Artist | Era | plays | sampled | rate | estimated suspect |
|---|---|---:|---:|---:|---|
| Taylor Swift | before 2024 | 10,214 | 727 | 1.51 % | 155 [87–275] |
| Taylor Swift | 2024 | 30 | 4 | 2.94 % *(imputed)* | 1 |
| Taylor Swift | 2025 | 109 | 76 | 2.63 % | 3 [1–10] |
| Taylor Swift | 2026 | 86 | 34 | 2.94 % | 3 [0–13] |
| **Taylor Swift** | **all** | **10,439** | **841** | | **161 [89–298]** |
| Maisie Peters | before 2024 | 4,259 | 6 | 1.18 % *(imputed, pooled)* | 50 |
| Maisie Peters | 2024 | 2,450 | 160 | 10.00 % | 245 [153–383] |
| Maisie Peters | 2025 | 676 | 312 | 5.13 % | 35 [22–55] |
| Maisie Peters | 2026 | 2,820 | 1,130 | 5.40 % | 152 [119–194] |
| **Maisie Peters** | **all** | **10,205** | **1,608** | | **482 [344–682]** |

| | Taylor Swift | Maisie Peters | gap |
|---|---:|---:|---:|
| as reported | 10,439 | 10,205 | **234** |
| restart rows only (hard floor) | 10,439 | 10,131 | **308** |
| less plays under 60 s | 10,278 | 9,723 | **555** *(range 280–827)* |

The restart-only line counts nothing but same-track repeats inside 60 seconds — the one
category that cannot be anything else. Zero were seen on the leader's side in any era.

**The headline: the race is roughly twice as far from its finish as the notifier says.** A
gap reported as 234 is, on this estimate, somewhere between 280 and 827 real plays, most
likely around 550. The pace figure is inflated the same way — the challenger's plays/day is
built from the same rows — so the projected crossover date is biased early on both terms at
once.

## Recommendation

**Fix the scrobbler, not the store.** These rows are real Last.fm scrobbles: they are in
Markus' public profile, they count towards his Last.fm charts, and they will keep arriving.
Deleting them here would leave this database disagreeing with last.fm.com while the
submissions carried on, and every future discrepancy would start with "which of our two
numbers is this?".

The durable fix is in whatever client is scrobbling — either a setting to submit at the
threshold rather than at track start, or a different client. Worth checking what it is
before anything else; the audit says *what* is happening, not *which player* is doing it.

If a local correction is ever wanted anyway, the least destructive form is a derived
`counts_as_play` flag computed from the successor gap, with every existing count left on
the raw rows and the flag exposed as an opt-in filter. That is deliberately **not**
implemented — see ADR 0030.

Two things to do regardless, both cheap:

- Run the committed script on the box for exact figures rather than this estimate.
- Re-run it periodically. The rate is rising, so a number measured today is not the number
  next year.
