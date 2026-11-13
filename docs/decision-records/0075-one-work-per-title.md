# 0075 — one work per title, whichever instance marked it

**Status:** Accepted
**Date:** 2026-11-13
**Topics:** neodb, catalogue, get_watched
**Contributors:** Markus (user story, chose a stored work id over a read-time merge) +
Claude (proposed and implemented)

**Affects:** `src/lib/work-key.ts`, `src/jobs/backfill-work-keys.ts`,
`src/jobs/sync-neodb-metadata.ts`, `src/mcp/tools/watched.ts`, `src/db/schema.ts`,
`drizzle/0048_catalog_work_key.sql`

## Context

Markus moved from MinReol (`minreol.dk`) to `neodb.social` on 13 November 2026. Both are
NeoDB instances, and each gives the same title its own catalogue URL. `catalog_metadata`
is keyed on that URL and `neodb_marks` on `(item_url, actor_ap_id)`, so Vision Quest
season 1 became two rows: *progress* from MinReol on 21 October, *complete* from
neodb.social on 13 November. Both carry `themoviedb.org/tv/213375/season/1`.

## Decision

**A stored `work_key` on every catalogue row.** Rows sharing a TMDB link, or an IMDb id
when both are films or both are whole shows, share a key. The key is `tmdb:…` or
`imdb:…`, or `url:<item_url>` for a row with nothing to match on. Nothing merges on title.

**The season rule.** NeoDB often gives a season the show's IMDb id. A season therefore
never matches on IMDb, only on a TMDB link naming its own season, and a show only on one
naming no season. Without this, season 1, season 2 and the show fold into one row.

**Written, not derived at read time.** The enrichment upsert joins a new row to a stored
twin (`resolveWorkKey`). A union-find over the whole table (`assignWorkKeys`) runs at the
end of every metadata sync pass and as `npm run backfill-work-keys`. It is deterministic
for a given set of rows, so a second run writes nothing. It is also what folds two works
together when a later row bridges them, which the per-row upsert cannot see.

**Reads group on it.** Every mark expression in `get_watched` and
`get_catalogue_details` correlates on the work's instance URLs, not the row's own. So
`status` comes from the newest mark across instances, and `watched_dates` and
`mark_comments` merge newest first with duplicates collapsed. One row stands for each
work: an enriched member beats a stub, then the lowest item URL wins. It is deliberately
not "most recently enriched", because twins refresh on separate clocks and the served row
would swap every few days. Rows carry `work_key` and `item_urls` (every instance URL,
oldest enrichment first), and either instance's URL resolves to the same answer.

## Consequences

- The first sync pass after deploy merges the duplicates already stored. Running
  `npm run backfill-work-keys` merges them at once.
- The served row's catalogue fields come from one instance. Until the TMDB refiner lands,
  that can be the Chinese neodb.social metadata (the refiner is the second half of the
  same story).
- The admin media views and the public stream are mark-centric and unchanged: a mark is
  still an event on the instance it was made on.
