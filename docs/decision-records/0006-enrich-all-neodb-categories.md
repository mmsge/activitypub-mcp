# 0006 — Enrich every NeoDB category, with retry and BookWyrm book dedup

**Status:** Accepted
**Date:** 2026-07-23
**Topics:** neodb, activitypub, metadata, enrichment, derived-data, music, game, podcast, performance, book, dedup, retry
**Contributors:** Claude (agent decision — no human input on the technical choices; extends ADR 0005, and resolves that story's open question about book/BookWyrm overlap on its own)

## Context

ADR 0005 built the `catalog_metadata` pipeline but only for **film/TV** — the tag
types `Movie`/`TVShow`/`TVSeason`/`TVEpisode`, mapped to a fixed set of columns
(imdb, tmdb, season_number, …). Markus also marks **music, games, podcasts, stage
performances and books** on the same NeoDB account (`@markus@minreol.dk`), and each
federates the identical bare-tag shape — only the `type` and the catalog `href`
differ. Those marks landed in `objects` but had no accessor, and the `get_watched`
cache was empty anyway (`total: 0`) — see the trap below.

Every category's rich record is one hop behind the tag `href`, in NeoDB's
`application/activity+json` representation, but the field names diverge per category:
books carry `author`/`isbn`/`pages`/`pub_house`, albums `artist`/`release_date`/
`track_list`/`barcode`, games `developer`/`publisher`/`platform`, podcasts
`host` + an RSS feed external resource, performances `playwright`/`director`/
`location`/`opening_date`.

## Decision

**Generalise the ADR 0005 pipeline to all categories** rather than add a table per
medium.

- **Common fields stay columns** (title, display_title, orig_title, year, cover_url,
  description, genre, language, area, rating, external_resources, fetched_at); the
  **film/TV columns stay** (get_watched surfaces them); **category-specific fields go
  in a `details` jsonb** (book → author/isbn/pages/publisher; music → artist/
  release_date/track_count/barcode; game → developer/publisher/platform; podcast →
  host/feed_url; performance → playwright/director/troupe/venue/opening_date). An
  **unknown or newly-added category** is stored with the common fields + `raw` and an
  empty `details` — it never fails ingest.
- **`source_map` (jsonb)** records every populated field's origin (`neodb`, or
  `bookwyrm` for a deduped book field), mirroring `get_book_details`.
- **Failures are recorded, not dropped.** A fetch that yields no JSON writes/updates a
  row with `fetch_error` + bumps `fetch_attempts` (leaving any prior good data and
  `enriched_at` intact), so it's visible via `get_catalogue_details` /
  `include_unenriched` and retried. `enriched_at` (last *success*) drives the
  configurable staleness window (`NEODB_STALE_DAYS`, default 30); `NEODB_BACKFILL`
  (or a `force` arg) re-enriches everything once, so existing rows aren't stranded on
  the old film-only shape.
- **Books dedupe against the BookWyrm cache** (this resolves ADR 0005's story's open
  question). A NeoDB `book` mark keeps its own `catalog_metadata` row (keyed by
  `item_url` like every category) but, when its ISBN matches a cached
  `book_metadata` Edition, links to it via `bookwyrm_book_url` and mirrors BookWyrm's
  authoritative author/pages/publisher/cover/description/year (marked `bookwyrm` in
  `source_map`). The two histories stay distinct; the reference data is shared, not
  duplicated. NeoDB `Edition` hrefs are told apart from BookWyrm ones by URL shape
  (`isNeodbBookUrl`: NeoDB ids are base62, BookWyrm ids numeric), so each book routes
  to exactly one pipeline.
- Exposed through the **same `get_watched`** tool/REST endpoint (now all categories,
  filter by `category`) plus a new **`get_catalogue_details`** sibling (one item's
  full record + `source_map` + failure status), parallel to get_books/get_book_details.

This **reverses ADR 0005's "books are deliberately excluded"** sub-decision; the rest
of 0005 (dereference the tag, cache keyed by the href, on-ingest + 6h sync) stands.

## The traps (don't re-derive these)

- **The old Accept header returned HTML, so the cache was silently empty (`total: 0`).**
  minreol.dk content-negotiates `application/activity+json, application/ld+json;
  profile="…"` (the ADR-0005 header) to the **HTML page**, not JSON — so `res.json()`
  threw on `<!DOCTYPE html>`, every enrichment failed, and nothing was ever cached.
  A **single** `Accept: application/activity+json` returns the JSON. If a NeoDB fetch
  ever yields nothing, check the exact header bytes first.
- **Field names differ per category, and differ from NeoDB's REST/`api_url` shape.**
  The AP view gives `pub_house` (not `publisher`), `actor` (not `actors`), `area`/
  `year` for film, `location` for a performance venue, and `track_list` as a newline
  string (track_count is derived by counting numbered lines). Newer NeoDB builds
  (neodb.social) instead expose a `credits[]` array — minreol.dk does not; map the
  minreol shape.
- **Enrichment is derived and best-effort — never authoritative.** The mark itself
  (`get_actor_posts`) stays ground truth for *what/when*; `catalog_metadata` only adds
  the reference data behind it, and a failed fetch is a retryable row, not a gap.
