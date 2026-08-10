# 0033 — LinkedIn as a source: two halves joined on the post id, metrics kept append-only

- **Status:** Accepted
- **Date:** 2026-08-10
- **Contributors:** Markus (wrote the user story, supplied the LinkedIn knowledge that is not in any doc — the two-source split, the two-block TOP POSTS layout, the windowed-accumulation nature of the exported impressions, and the instruction to treat the manual export as deliberate rather than a stopgap; chose the upload endpoint over a watched directory, hooks over pulling the adjacent DMA domains, and REST-with-public-only over MCP-only) + Claude (agent decisions: verified the API constraints against Microsoft Learn, found that the two sources do not emit the same URL string and introduced the derived post key, found that the adjacent DMA domains record outbound activity rather than received engagement, chose the three-way fetch result over the repo's collapse-to-empty convention, designed `source_sync_state`, and picked ExcelJS)
- **Affects:** `src/lib/fetch-linkedin-snapshot.ts`, `src/lib/linkedin-url.ts`, `src/lib/linkedin-keys.ts`, `src/lib/parse-linkedin-export.ts`, `src/lib/source-health.ts`, `src/jobs/sync-linkedin-posts.ts`, `src/mcp/tools/linkedin-posts.ts`, `src/mcp/tools/linkedin-stats.ts`, `src/admin/import.ts`, `drizzle/0026_linkedin.sql`
- **Topics:** linkedin, ingest, analytics, data-quality, api, staleness

## Context

Markus' LinkedIn engagement log was a hand-maintained JSON file bundled inside the
`linkedin-post-timing` skill. Each month he exported an `.xlsx` from LinkedIn, joined
its TOP POSTS sheet by hand, and rewrote the file. Everything downstream — including
the weekday ranking quoted in that skill's `timing-strategy.md` — was a frozen snapshot
of whatever the last manual pass produced, with a note telling the reader to re-derive
it after the next export.

LinkedIn is unusual among this repo's sources in that **no single upstream has the whole
picture**:

- **Content** is available through the DMA Member Data Portability (Member) product —
  a Digital Markets Act compliance obligation. It carries what he posted: date, URL,
  commentary, visibility, attached link, reshare flag.
- **Performance** is not. Impressions and engagement rate sit behind
  `r_member_postAnalytics`, inside the partner-gated Community Management product, to
  which he has no route. The only way he can obtain them is the analytics dashboard's
  `.xlsx` export, by hand, monthly.

The manual half is therefore permanent, and designing it away was explicitly out of
scope. So was regenerating the skill's log from the new tools — that is a separate
change, once this is live and verified.

## Decision

Ingest both halves, join them on a derived post id, and expose the result through three
MCP tools. Six choices are load-bearing.

### 1. The join key is a derived post id, not the URL

The user story said the post URL is the join key and that no URN mapping is required.
The second half is true — nothing here needs a lookup — but the two sources do not spell
the URL the same way. The existing engagement log, built from `.xlsx` exports, holds:

```
https://www.linkedin.com/posts/markus-mg_ki-buzzwords-ugcPost-7462903540748034050-dUyv
```

while that log's own template documents the API's form:

```
https://www.linkedin.com/feed/update/urn:li:activity:7462903540748034050
```

Both embed the same numeric id. `canonicalPostKey()` extracts it; each source's URL is
stored verbatim beside it. This is string canonicalisation, not URN resolution: no call,
no mapping table. If the two forms ever agree it costs nothing, and while they do not it
is the difference between the feature working and joining zero rows in silence.

### 2. Metrics are append-only, one row per post per export

The exported impressions are a **windowed accumulation, not a lifetime total**. Two
exports of the same post are therefore two different observations, not an old value and
a corrected one. Overwriting would discard the difference between them — which is the
reach-decay curve, and the most useful thing in the file. Idempotency comes from a unique
index on `(post_key, export_date)` rather than from an upsert.

The export date is derived from the file's own daily series (its last day), never typed
by the uploader: a form field would let one file import twice under two keys and defeat
the index it exists to satisfy.

`linkedin_post_metrics` deliberately has **no foreign key** to `linkedin_posts`. Metric
rows can arrive for a post the poller has not reached, and a foreign key would reject
exactly those rows. `posted_on` is duplicated onto the metric row so such a post still
has a weekday before the poller backfills its text, and the read tools take the union of
both key sets rather than either table alone.

### 3. Three named constraints on the snapshot endpoint

All three are documented by LinkedIn and all three punish the obvious implementation:

- **`Linkedin-Version: 202312` is the only accepted value.** It does not track the
  monthly DMA version numbers, which announce products and domains rather than endpoint
  versions. Anything else is `426 NONEXISTENT_VERSION`. It is a module constant, not an
  env var, so it cannot be helpfully bumped.
- **`start` is a page index, not a record offset.** LinkedIn's own samples show
  `{start: 0, count: 10}` linking to `start=1`, then `start=2`. Advancing by `count` —
  the reflex for every other paginated REST API — would read page 0, then page 10.
- **`paging.total` under-reports**, because some data is assembled offline. The crawl
  terminates on the documented "No data found for this memberId" message or an empty
  `snapshotData`, never on `total`.

### 4. The fetcher distinguishes "finished" from "broken"

`src/lib/fetch-lastfm.ts` collapses every failure to an empty page, and says so
deliberately. That is right for a caller that stops when a page comes back empty — but
here an empty page is *also* the end-of-crawl signal. Collapsing the two would make an
expired token indistinguishable from a completed crawl: the poller would stop at page 0,
record a clean sync, and the archive would quietly stop growing.

So `fetchSnapshotPage` returns `data | end | error`, and only `end` counts as success.
The end-of-data check runs *before* the status check, because the terminator arrives as
an error response — testing status first would report the natural end of every
successful crawl as a failure.

### 5. Ingest health is stored, because `max(timestamp)` cannot answer the question

Every other source here answers "is this still working?" as `max(data timestamp)`, which
conflates "the poller is broken" with "nothing happened". That is fine for Last.fm: a
dead key shows up as silence within the hour against a source that produces rows daily.

It is not fine here. The poller runs weekly, Markus posts perhaps twice a week, and the
token is minted by hand through an EEA-gated flow with an expiry LinkedIn does not
document. A dead token and a quiet fortnight are the same picture from the data alone.

`source_sync_state` records attempt, success, error, status and a failure count, keyed
by source slug so the other pollers can adopt it later without a migration. From it,
`deriveTokenStatus` yields `ok` / `stale` / `unauthorized` / `never_run`. The four are
all distinct and none collapses into another — in particular a source can hold perfectly
good data *and* a failing refresh, which is `stale`, not `unauthorized`: the stored
snapshot stays valid long after the token that fetched it dies. `stale` is derived from
time since the last success, never from an assumed token lifetime, because any lifetime
we assumed would be a guess presented as a fact.

It surfaces three ways, none of which is a log: a badge on the admin dashboard, a
`source_health` block on `get_linkedin_stats`, and one ntfy push on the transition into
a refused token — latched, so a weekly poller alerts once per outage rather than training
its reader to ignore it (hetzner-server ADR 0011).

### 6. The TOP POSTS sheet is two rankings, and the join is on URL

The sheet prints two independent rankings side by side: one by engagements (~14 rows
deep), one by impressions (~50). A post sits at a different row position in each, so
reading it as one table pairs every post's impressions with a different post's
engagements — plausible numbers, wrong post, no error anywhere. The parser derives the
blocks from the header row rather than hardcoding two blocks at fixed columns, walks each
to its own depth, and merges into a map keyed by post id.

A post present only in the impressions block gets `engagements: null`, never a guess.
Formula cells are read through their cached result, so a formula string never lands where
a number belongs.

## Consequences

- The engagement log becomes a derived export. Regenerating the skill's copy from these
  tools is deliberately left for a separate change.
- `exceljs` is a new runtime dependency (~22 MB unpacked, ~9 transitive). Chosen over the
  lighter `read-excel-file` because its formula semantics are documented and explicit —
  a formula cell is `{ formula, result }` — which makes "resolve formulas, do not store
  formula strings" a line of code that can be pointed at and tested. `xlsx` on npm was
  ruled out (stale at 0.18.5; SheetJS moved distribution off npm) and `node-xlsx` with
  it, since it fetches SheetJS from a CDN tarball at install time, which a proxied
  Docker build cannot do.
- REST serves publicly-visible LinkedIn posts only, applying ADR 0026's rule to this
  source's own vocabulary. LinkedIn is inconsistent between surfaces — the UGC API uses
  ANYONE/CONNECTIONS/LOGGED_IN, the data export writes the field name MEMBER_NETWORK for
  the widest setting — so the allowlist covers the forms that mean "anyone can see this"
  and **fails closed** on anything else, including an absent value. Consequence worth
  knowing: if an export ever uses a token not on that list, the REST endpoints will
  return fewer rows than MCP does. The raw value is visible through MCP, so the fix is
  one query away rather than a mystery.
- The adjacent DMA domains (`ALL_COMMENTS`, `ALL_LIKES`, `INSTANT_REPOSTS`, `ALL_VOTES`)
  are left as hooks. Not merely to save work: their documentation says they record
  activity the member *performed* — "Comments you've made", "the reaction type a member
  has made to a post" — so they are outbound activity, not engagement received. They
  cannot supply the reaction/comment/reshare split the `.xlsx` lacks, which was the one
  reason to want them. Adding one later is a table and a call to `crawlDomain()`.
- The Changelog API stays unused: a 28-day window that starts empty at consent can
  neither backfill nor survive a fortnight of downtime. The snapshot being historical and
  complete on every call is what lets the poller be dumb, idempotent, and weekly.
- Weekday buckets are computed in `Europe/Oslo` (ADR 0019). On a UTC container a post
  published at 00:30 CEST is a Sunday post, which would move real posts into the wrong
  bucket — the exact number this work exists to make trustworthy.
