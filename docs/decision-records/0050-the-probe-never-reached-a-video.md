# 0050 — The probe never reached a video, and stage 1 kept asking answered questions

**Status:** Accepted
**Date:** 2026-08-17
**Topics:** youtube, classification, probing, consent, quota, jobs, observability
**Contributors:** Claude (agent decision — no human input on the technical choice; Markus ran the measurements on the box that made the diagnosis possible)

Amends [0049](0049-a-short-is-an-era-not-a-length.md), which stands. Everything it decided
holds; this records what the first production run of stage 2 revealed, and two things that
were wrong in the shipped job.

**Affects:** `src/lib/probe-youtube-short.ts`, `src/jobs/classify-youtube-shorts.ts`,
`scripts/classify-youtube-shorts.ts`, `drizzle/0037_reset_consent_blocked_probes.sql`

## Context

The first 200-probe sample from the box returned **200 probes, 0 Short, 0 not, 200 errors**,
and the rate-limit circuit breaker never tripped — so none of them were 429s. ADR 0049 had
braced for throttling, since YouTube 429'd after two requests during investigation. This was
not that.

`is_short_error` held the answer, and the reason it took a query to find it is the second
finding below:

```
unexpected redirect to https://consent.youtube.com/m?continue=…%2Fshorts%2F--E_y9f4ORc…&gl=FI
```

Measured from the box, three ways, on the two videos ADR 0049 names:

| Cookie | `oijqsP5wizI` (a Short) | `fwLsCgibGw4` (not one) |
|---|---|---|
| *none* | 302 → consent.youtube.com | 302 → consent.youtube.com |
| `CONSENT=YES+cb` | 302 → consent.youtube.com | 302 → consent.youtube.com |
| **`SOCS=CAI`** | **200** | **303 → /watch?v=…** |

## Decision

**Send `SOCS=CAI` on every probe.** It is the cookie YouTube sets once its consent dialog
has been answered, and it is what yt-dlp sends for the same reason. Nothing is circumvented
but a banner: this is a cookie-consent screen, not authentication, and the pages behind it
are public either way.

**Stage 1 must never re-ask about a video `videos.list` has already answered.** Its queue now
carries `AND api_fetched_at IS NULL`.

**Record the redirect HOST, not the whole Location.**

**Emit progress from the network stages**, through an optional `onProgress` callback the CLI
wires up and the scheduled run leaves undefined.

**`0037` hands back the attempts the consent wall consumed**, scoped to rows whose error
names `consent.youtube.com`, so a genuine 404 keeps its attempt. Data repair in a migration
rather than a script, per ADR 0048: migrations run at container start, so the reclaim lands
in the same deploy as the cookie that makes it useful.

### The traps (don't re-derive these)

**This bug cannot reproduce off the affected network.** Probing by hand from a non-EU
address returns 200 and 303 with no cookie at all — which is exactly how it shipped broken.
The pre-merge verification was real, and it was run from somewhere that never sees the thing
that breaks it. A network-dependent behaviour is only verified from the network that will
run it.

**`CONSENT=YES+cb` is dead.** It was the well-known bypass and it is now answered with the
consent wall like sending nothing at all. Do not "restore" it as a fallback; it would look
like belt and braces and be neither.

**A successful fetch resets `is_short_attempts` to 0, and the queue orders by attempts
ascending — so the rows stage 1 could not settle sort FIRST, forever.** Every scheduled pass
therefore spent its entire cap re-asking the same head of the list. In production: 200 calls,
10,000 videos, **0 settled, 0 missing**, 200 quota units for nothing, four times a day. The
ordering that ADR 0049 introduced to prevent starvation is what caused this, which is why
the fix is a predicate on `api_fetched_at` and not a change to the ordering.

**A high-cardinality error string hides a single cause.** The full Location carries a
`continue=` parameter holding the video id, so 200 identical failures were stored as 200
distinct strings, and `GROUP BY is_short_error` returned a page of rows each reading `1`.
One systematic cause looked like scattered noise. An error column is only diagnostic if
identical failures produce identical text.

**A job whose only output is a closing summary is indistinguishable from a hang.** The
drain took minutes in silence and the reasonable question was whether it had died. The
scheduled run genuinely wants one line; the manual one does not, and that is a property of
the caller rather than of the job.

## Consequences

- Stage 2 is viable from the box. Verified end to end after the change: `oijqsP5wizI` →
  `true`/`probe`, `fwLsCgibGw4` → `false`/`probe`, zero errors.
- Stage 1 now has nothing to do once the backlog is drained, which is the correct resting
  state. Re-asking about a video means clearing its `api_fetched_at`.
- Videos absent from `videos.list` — deleted or private — are also not re-asked, since they
  carry `api_fetched_at`. That is deliberate: `api_missing` records the answer, and the
  alternative is spending quota forever on videos that are gone.
- The 200 consent-blocked rows return to the queue at zero attempts, so the sample that
  produced no information also costs none.
- The probe's failure modes remain non-verdicts throughout. 200 consecutive failures produced
  **zero** wrong answers, because an unrecognised redirect is recorded and never read as a
  Short. That rule is what kept a network problem from becoming 200 corrupt rows.
