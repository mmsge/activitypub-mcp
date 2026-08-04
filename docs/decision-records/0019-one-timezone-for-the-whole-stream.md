# 0019 — One timezone for the whole stream: every bucket is an Oslo bucket

- **Status:** Accepted
- **Date:** 2026-08-04
- **Contributors:** Claude (agent decision — no human input on the technical choice; found while reviewing `/arkiv` against the dates the page prints)
- **Affects:** `src/stream/event-date.ts`, `src/stream/facets.ts`, `src/stream/query.ts`
- **Topics:** timezones, stream, archive, postgres, dates

## Context

`meg.msge.no` renders every date in `Europe/Oslo` — `entry.tsx` formats with
`timeZone: 'Europe/Oslo'`, and the music lane's whole reason for existing is a digest
per *Oslo* day, computed as
`date_trunc('day', s.played_at AT TIME ZONE 'Europe/Oslo')`. ADR 0018 established
that: the stream says what Markus did, and he did it in Norway.

`archiveRange` bounded `/arkiv/YYYY/MM` in UTC, and carried a comment justifying it —
that the stream's dates are a mix of real timestamps and day-precision strings
normalised to UTC midnight, so the month boundary should be UTC too, and Oslo
boundaries would "pull the last hour of the previous month into the page in summer".

The second half of that is the bug described as if it were the fix. In summer the
last two hours of a UTC month are already the next month in Oslo, so:

- a post at `2026-06-30T23:30Z` printed **"1. juli"** and was served from
  `/arkiv/2026/06`;
- a post at `2025-12-31T23:30Z` printed **"1. januar 2026"** and lived in
  `/arkiv/2025/12`;
- worst, the music lane's `event_at` *is* Oslo midnight, so the scrobble digest for
  the 1st of every month fell into the month before — every month, all year, not
  just at the DST edges.

`loadArchiveMonths`, which builds the sitemap, had the matching defect from the other
direction: `date_trunc('month', ts)` on a `timestamptz` uses the session `TimeZone`,
UTC in the container. So the list of months and the pages those months link to were
computed on two different calendars.

## Decision

**The stream has one timezone, and every bucket boundary uses it.** `Europe/Oslo` is
already the constant `STREAM_TIMEZONE`; the archive now bounds on Oslo months via a
new `osloMonthStart(year, month)`, and `loadArchiveMonths` truncates with
`AT TIME ZONE 'Europe/Oslo'` to match.

The rule to apply next time: **a bucket must be computed in the timezone its label is
rendered in.** The page prints "1. juli"; the month containing it must therefore be
July. No amount of internal consistency in UTC makes up for the archive disagreeing
with the date printed on the entry inside it.

The old comment's premise was sound and its conclusion did not follow. Garden dates
really are day-precision strings normalised to UTC midnight — and they land in the
right Oslo month anyway, because Oslo is *east* of UTC: its month opens before the
UTC month does, so every UTC midnight inside the calendar month falls inside the Oslo
window. The two never conflicted.

`osloMonthStart` derives the offset through `Intl` rather than assuming +01:00 or
+02:00, and re-checks once in case a first guess lands on the far side of a DST
transition. Month boundaries never do — Norway switches at 02:00/03:00 on a Sunday,
never at midnight on the 1st — but the function should not silently depend on that.

`loadArchiveMonths` also stopped listing future months. PR #67 removed future-dated
rows from every lane (viaduct.world imports *planned* journeys), which left the
sitemap advertising `/arkiv/2026/10` for a page deliberately rendered empty.

## Consequences

- Some entries move one month in the archive. Nothing is lost or duplicated: the
  months are half-open and adjacent bounds still meet exactly, which is asserted for
  all twelve months plus the year roll.
- The sitemap's month list and the archive pages now agree by construction. They are
  still computed by two different mechanisms — TypeScript and SQL — which is a
  standing risk, mitigated by both naming `Europe/Oslo` explicitly rather than
  relying on a session default.
- One known gap remains, documented at `loadArchiveMonths`: `objects` is bucketed by
  `published_at`, while the reading lane dates a book by its
  `startedDate`/`finishedDate`. A book finished in 2016 and posted in 2024 appears on
  `/arkiv/2016/…` without that month being listed. The sitemap is therefore
  incomplete, never wrong, and the page stays reachable.
- Everything here was verified by *executing* the queries against a Postgres 16 with
  all 22 migrations applied and rows seeded either side of a boundary, not by
  asserting on SQL strings. PR #66 is why.
