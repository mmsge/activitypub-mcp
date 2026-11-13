# 0077 — a gone item keeps its record, and TMDB refines from the stored row

**Status:** Accepted
**Date:** 2026-11-13
**Topics:** neodb, catalogue, enrichment, tmdb
**Contributors:** Markus (spotted the 404 flood during the first `refine-tmdb` run, asked for
the fix) + Claude (proposed and implemented)

**Affects:** `src/jobs/refine-tmdb.ts`, `src/jobs/sync-neodb-metadata.ts`,
`src/lib/fetch-neodb-item.ts`, `src/db/schema.ts`, `drizzle/0050_catalog_source_gone.sql`

## Context

The first `npm run refine-tmdb` on the box (ADR 0076) went through `enrichOne`, which
re-fetches each item from NeoDB before asking TMDB. minreol.dk now answers 404 for every
item and 500 for its front page. So each MinReol item cost one request to somebody else's
server, was not refined (the TMDB step only ran after a successful NeoDB fetch), and was
left with a `fetch_error`. A row with an error is never fresh, so the periodic sync would
then ask minreol.dk for every one of them again on every pass.

## Decision

**The refiner reads the stored row.** Everything it needs (the TMDB link, the item's kind)
and every field it falls back to are already in `catalog_metadata`. `refineOwedItems` and
`npm run refine-tmdb` now ask TMDB only. The periodic sync no longer treats an owed row as
stale: it runs the stored-row refine after its NeoDB batch, bounded like the batch. A row
NeoDB does re-fetch is still refined inside `enrichOne`, as before.

**A NeoDB 404 on a row that already has its data is a stamp, not an error.**
`source_gone_at` is set, `fetch_error` cleared, and the stored record stands. The row
counts as fresh for `NEODB_STALE_DAYS` from that answer, so a dropped item is asked about
once a window rather than every pass, and it is not listed as a failed enrichment. A later
successful fetch clears the stamp. A 404 on a row that never enriched stays an ordinary
failure, since there is no record to keep.

## Consequences

- `refine-tmdb` sends no requests to any NeoDB instance, and refines the MinReol rows too.
- The rows the first run left with a `fetch_error` are re-asked once on the next sync pass,
  get their 404 again and are stamped. Or stamp them directly with the SQL in the PR.
- Other failures (timeouts, 5xx) on an enriched row are still retried every pass, as before.
