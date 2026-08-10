# 0034 — A successful empty crawl is not a healthy one: store when data last arrived

- **Status:** Accepted
- **Date:** 2026-08-10
- **Contributors:** Markus (deployed the source, minted the token, reported that it "doesn't seem to work" after several attempts, ran the domain probe that produced the evidence below, and chose to add the state rather than leave it) + Claude (agent decision on the technical shape: diagnosed the terminator collision, established that the distinction cannot be derived and must be stored, chose `last_data_at` over a row count, and put `stale` ahead of `awaiting_data`)
- **Affects:** `src/lib/source-health.ts`, `src/admin/views/ui.tsx`, `src/admin/views/dashboard.tsx`, `src/mcp/tools/linkedin-stats.ts`, `drizzle/0027_source_last_data_at.sql`
- **Topics:** linkedin, ingest, staleness, observability, data-quality

Amends [0033](0033-linkedin-as-a-source-two-halves-joined-on-the-post-id.md), which stands.

## Context

The LinkedIn source went live and the poller authenticated fine. It also returned
nothing, run after run, and **the system could not say why**. The dashboard showed a
green `OK` badge; the only hint that anything was outstanding was a `Posts: 0` counter in
the tile beside it. Establishing what was actually happening took a hand-written `curl`
loop over eight snapshot domains.

That probe, run about three hours after the token was minted, is the evidence worth
keeping:

| 200 | 404 `No data found for this domain and memberId` |
|---|---|
| `PROFILE`, `REGISTRATION`, `RICH_MEDIA` | `MEMBER_SHARE_INFO`, `ARTICLES`, `ALL_LIKES`, `ALL_COMMENTS`, `INSTANT_REPOSTS` |

Every 404 is activity data; every 200 is profile or asset data. Five simultaneous
failures along one seam is not five faults, it is one upstream job that has not
finished — and it rules out the diagnoses that look plausible from a single 404 (wrong
scope, wrong app, wrong company page, a uniquely broken domain), all of which would
present as 401/403 or as an isolated failure. LinkedIn's only statement on the matter is
that *"data for certain domains will be available sooner than others, depending on the
effort required by LinkedIn to collate this data"*, with no timing published anywhere.

**The obvious reading — that the poller was broken — was wrong, and so was the
system's.** The poller was correct. The state model was not.

### Why the two are indistinguishable

ADR 0033 established that the crawl terminates on the documented no-data message rather
than on `paging.total`, because that count under-reports. The trap is that LinkedIn uses
**the same response for two different things**:

- *"you have paged past the end of this domain's data"* — the normal end of every
  successful crawl, and
- *"this domain has not been collated yet"* — a domain that will have data later.

Both are `404` with a `No data found …` body. A first run against a not-yet-ready domain
is therefore byte-identical to a completed crawl, and correctly records a clean success
with zero rows. Nothing in the response distinguishes them, so nothing inferred from the
response can either.

## Decision

Store the distinction: a nullable `source_sync_state.last_data_at`, set only by a run
that actually returned at least one row. `NULL` means the source has never once produced
data.

That yields a fifth state:

```
never_run      no attempt and no success
unauthorized   lastStatus 401/403, or never once succeeded
stale          no success within 2× the poll interval
awaiting_data  succeeding, but has NEVER received a row      ← new
ok             otherwise
```

**`stale` is checked before `awaiting_data`.** Both can be true at once — a source that
never got data and has also stopped running. "Stale" is the more actionable of the two,
and "awaiting" would wrongly imply something is still trying.

**It cannot be derived from `items_last_run`.** That column holds only the most recent
run, so a source that ingested 31 posts last week and none today would classify as
`awaiting_data` — precisely backwards. Nor from `count(linkedin_posts)`:
`source_sync_state` is keyed by source slug so other pollers can adopt it, and reaching
into one source's tables to compute its own health would forfeit that.

**`last_data_at` must be absent from the update object on an empty run, not set to
null.** The upsert does `set: successSet(...)`, so any key present is rewritten every
time; writing it unconditionally would erase the evidence the first time a run
legitimately came back empty, flipping a healthy source to a permanent `awaiting_data`.
This is the third instance of the same trap in this codebase — ADR 0013 records it for
`hiddenAt`, ADR 0033 for `firstSeenAt` — so the set object is extracted and exported
purely so a test can assert the omission.

The badge is **blue, labelled "Awaiting data"**. Deliberately not yellow: yellow is
`Stale`, which means the opposite (the job has stopped), and blue already reads as
"nothing yet" on `EnrichBadge`'s `Pending`.

## Consequences

- The column also detects the inverse, which is the more worrying case: a run returning
  zero rows when `last_data_at` is already set. Because the snapshot is historical and
  complete on every call rather than a feed of changes, that means the upstream stopped
  serving data we know it once had — not that nothing happened since last time. Logged as
  a warning, not alerted: it is rare, ambiguous, and the stored rows are untouched either
  way.
- `last_data_at` is independently useful on its own terms. "Posts last actually arrived
  three weeks ago" is a different fact from "the job ran an hour ago", and only the first
  says whether the archive is still growing. It is exposed on `get_linkedin_stats`.
- `get_linkedin_stats`'s description had to be corrected, not merely extended: it said
  "if it is not `ok`, these numbers stopped moving at `last_success_at`". Under
  `awaiting_data` the numbers never *started*, and a consumer reading a thin result as a
  downturn would draw exactly the wrong conclusion. The description is what the
  `linkedin-post-timing` skill reads, so the sentence had to distinguish a feed that
  stalled from one that has not begun.
- **Re-minting the token is the wrong reflex**, and is now said so in the README and on
  the dashboard. LinkedIn creates the snapshot *at the moment of consent*, so a fresh
  consent plausibly restarts the collation rather than skipping ahead — the one action a
  frustrated operator is most likely to take is the one that could set the clock back.
- The four existing states are unchanged and their tests pass untouched. If one of them
  flips, the ordering in `deriveTokenStatus` is wrong.
