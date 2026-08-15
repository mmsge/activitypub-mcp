# 0039 — A clean run that explains nothing is not observability: keep the response, probe a control

- **Status:** Accepted
- **Date:** 2026-08-15
- **Contributors:** Markus (reported that LinkedIn post content never arrives, supplied the `source_health` readout and the observation that the rows must be coming from the metrics importer rather than the poller, asked the six questions this record answers, and asked specifically for a way to trigger one poll by hand rather than waiting out the 168-hour interval) + Claude (agent decisions: traced `awaiting_data` back to `last_data_at IS NULL` and established that it carried no auth evidence at all, found that `last_status`/`last_error` are only ever written by `recordFailure`, chose the control-domain probe over a new state, chose to store the trace beside the failure-only columns rather than widen them, added the join-overlap counter, and established from a live probe that a refused token cannot have been the last attempt's outcome)
- **Affects:** `src/lib/fetch-linkedin-snapshot.ts`, `src/lib/source-health.ts`, `src/lib/linkedin-join.ts`, `src/jobs/sync-linkedin-posts.ts`, `src/mcp/tools/linkedin-stats.ts`, `src/admin/views/dashboard.tsx`, `src/lib/linkedin-probe.ts`, `scripts/probe-linkedin-snapshot.ts`, `drizzle/0032_source_attempt_trace.sql`
- **Topics:** linkedin, ingest, observability, staleness, data-quality, diagnostics

Amends [0033](0033-linkedin-as-a-source-two-halves-joined-on-the-post-id.md) and
[0034](0034-a-successful-empty-crawl-is-not-a-healthy-one.md), both of which stand.

## Context

Five days after ADR 0034 added `last_data_at`, the LinkedIn source was still empty and
still could not say why. `get_linkedin_stats` reported:

```
token_status: "awaiting_data"     last_data_at: null
last_success_at: 2026-08-14…      last_error: null
last_attempt_at: 2026-08-14…      last_status: null
                                  consecutive_failures: 0
```

Fifty posts, twenty-seven with metrics, every one of them `has_content: false` — so the
rows were entirely `linkedin_post_metrics`, the union in `MERGED` doing its job, and
`linkedin_posts` was empty. The job ran, reported success, and had never written a row.

ADR 0034 called this normal and said it would clear itself. Five days on, that reading is
no longer available, and the state model has a second problem the first one hid:

**`awaiting_data` was derived entirely from `last_data_at IS NULL`.** Read
`deriveTokenStatus`: the only auth input is `lastStatus === 401 || 403`, and `lastStatus`
is written **only by `recordFailure`**. A run that never fails never writes it. So the
badge said "waiting" on the strength of no evidence whatsoever — it was not a statement
about the token, it was a statement about a column being null, and it would have read
exactly the same if the token had been dead the whole time.

**And `last_success_at` meant almost nothing.** A crawl "succeeded" if it terminated
without an error, and the terminator is a 404 whose body says `No data found` — the same
404 LinkedIn returns for a domain it has not collated yet (0034's finding). The status and
the body of that response were logged at `warn` and then dropped. Nothing was stored. So
of the several things a successful-and-empty run could have been — the archive not built,
one domain not collated, a token refused with a body that happened to match, a 200 with an
empty `snapshotData` — the stored row could not distinguish any of them, and the interval
is 168 hours, so there was nothing to look at and no way to look sooner.

The honest summary is that this source had **no observability at all in the only state it
had ever been in**. Everything 0033 and 0034 built reports on failures; this source has
never had one.

## Decision

Three changes. None of them adds a state; all of them add evidence.

### 1. The response is stored on every attempt, not only on failures

`fetchSnapshotPage` now returns a `trace` on all three outcomes — URL, HTTP status, body,
LinkedIn's `x-li-uuid` request id, duration — and `source_sync_state` grows
`last_http_status`, `last_http_body` and `last_note`, written by `recordSuccess` as well
as `recordFailure`.

`last_status` and `last_error` are deliberately **not** widened to carry this.
`deriveTokenStatus` reads `lastStatus` to decide `unauthorized`, so putting a healthy
end-of-crawl 404 there would turn every completed crawl into a refused token. The two
columns answer different questions — "did it fail, and how" versus "what actually came
back" — and only the first may drive the badge.

`last_note` is one line of prose: what the run concluded and on what evidence. It is what
a human reads first, and it is on the dashboard, in `get_linkedin_stats`, and in
`npm run sync-linkedin`'s output.

### 2. An empty crawl asks a control domain before calling itself a success

The classification is lossy because the API is: "not collated yet" and "you have paged
past the end" are byte-identical, and no amount of care with one response separates them.
0034 concluded, correctly, that the distinction has to be stored rather than derived. What
it did not do is *ask a second question*.

So when the crawl of `MEMBER_SHARE_INFO` comes back with nothing, the job now fetches
`PROFILE` — one extra request, on a run that found nothing anyway — and the pair of
answers is what gets recorded:

| `PROFILE` | Verdict | Recorded as |
|---|---|---|
| 200 with records | token, scope and consent are all good; this domain is genuinely not collated | success, with the evidence in `last_note` |
| 401 / 403 | the token is refused | **failure** — badge red, `unauthorized`, ntfy fires |
| also empty | the whole snapshot is missing, not one slow domain | success, but named as the different problem it is |
| other error | inconclusive | success, and says so rather than guessing |

`PROFILE` is the right control precisely because of 0034's probe: the observed seam was
profile-shaped domains answering 200 while every activity-shaped one answered 404. It is
the earliest thing LinkedIn collates, so its silence means something quite different from
`MEMBER_SHARE_INFO`'s.

The consequence that matters: **a refused token can no longer hide inside `awaiting_data`.**
That was previously possible and is the failure ADR 0033's whole health model exists to
prevent — it prevented it for the crawl and left the door open one classification below.

### 3. A hand-runnable probe, and a join-overlap counter

`npm run probe-linkedin` asks the controls, the target and the activity domains in one
pass and prints status, item count, derived post keys, a verdict, and the raw bodies. It
is the curl loop from 0034, kept. Read-only, never prints the token, exits non-zero on a
401/403.

Separately: the join is a numeric id extracted from each source's own URL spelling
(0033), which is right, and has one silent failure — LinkedIn's `share`, `ugcPost` and
`activity` URNs are not guaranteed to carry the same number for the same post, and the
stored export URLs use two of those three forms. If the snapshot ever emits ids from a
different namespace, both tables fill and nothing joins, with every query still returning
rows. `linkedinJoinHealth()` counts the overlap; `matched: 0` against non-zero counts on
both sides is named as `JOIN BROKEN` rather than left to look like a backlog.

## Consequences

- **The reported outage can now be narrowed without the token.** Probing the live
  endpoint with a deliberately invalid token returns
  `{"status":401,"serviceErrorCode":65600,"code":"INVALID_ACCESS_TOKEN","message":"Invalid access token"}` —
  a body that does **not** match the no-data terminator. So a refused token has always
  been classified as an error and recorded through `recordFailure`, and the reported
  `consecutive_failures: 0` with `last_error: null` therefore means the last attempt
  genuinely terminated on end-of-data, not on a 401 in disguise. **Auth was not the
  failing stage at the last attempt**; LinkedIn accepted the request and declined to
  hand over `MEMBER_SHARE_INFO`. That is a fetch-stage failure upstream of us.
- The fetch is otherwise correct on every documented constraint — endpoint, `202312`,
  `q=criteria`, `domain=MEMBER_SHARE_INFO` (exact case), page-index paging — and the docs
  list **no separate archive-request call** for the Member product: the snapshot is
  created at the moment of consent, so there is no second leg missing. The parse is
  correct on the record shapes LinkedIn documents and keeps `raw` for the ones it does
  not. Both remain *unfalsified* rather than proven, because no record has ever reached
  either of them — which is exactly what the probe's key-derivation column settles the
  moment one does.
- Five days of `404` on the activity domains while the profile ones answer is past the
  point where "collating" is the comfortable reading. 0034's advice not to re-mint still
  holds — re-consenting can restart the collation — but the *other* half of that advice,
  the DMA support form, is now the indicated action, and `x-li-uuid` is captured so the
  ticket can quote a request id.
- `awaiting_data` keeps its meaning and its blue badge. It is no longer the *only* thing
  said about that state: the note beside it now says whether the token was verified.
- One extra request per empty run, and none on a run that found data.
- Every other poller inherits the columns for free — `source_sync_state` is keyed by
  source slug (0033) and only `linkedin` writes to it today.
- `last_http_body` is clipped to 4 kB on write and the in-memory trace to 2 kB, so a
  stray HTML error page cannot bloat the row. `probeSnapshotDomain` returns the body
  untruncated, because for the probe the whole thing is the point.
