# 0005 — Enrich NeoDB film/TV catalog metadata on ingest

**Status:** Accepted
**Date:** 2026-07-23
**Topics:** neodb, activitypub, film, tv, metadata, enrichment, derived-data
**Contributors:** Markus (asked & decided: capture the external ids — "is there more? like imdb link" → "do it") + Claude (proposed/implemented; table shape, dereference-the-tag approach and the get_watched tool were agent decisions)

## Context

The server now follows Markus's NeoDB account (`@markus@minreol.dk`, films/TV). A
NeoDB mark federates as a plain `Note` — e.g. *"finished watching Conflict"* —
whose only structured hook is a **bare tag**:

```json
{ "type": "TVSeason", "href": "https://minreol.dk/tv/season/2mHcVZbJprJFqdIYBwnjTU",
  "name": "Conflict", "image": "https://minreol.dk/m/item/…jpg" }
```

That carries the NeoDB catalog URL and a poster, and nothing else — no IMDb id, no
TMDB link, no year/episode-count. The external ids exist, but one hop away: fetching
the tag `href` with an ActivityStreams `Accept` header returns the full catalog
record (`imdb: "tt27579939"`, `external_resources: [{ url: <tmdb> }]`, description,
`episode_count`, …). This is the same shape of gap the book side had before ADR
0003, where BookWyrm notes federate a bare Edition link and a background pipeline
dereferences it into cached metadata.

## Decision

**Mirror the book-metadata pipeline (ADR 0003) for NeoDB film/TV.** A new
`catalog_metadata` table, keyed by the NeoDB catalog URL (the tag `href` — the same
value every mark carries), is filled by `sync-neodb-metadata.ts`:

- **On ingest:** `handleCreate` collects tag hrefs whose `type` is one of
  `NEODB_SCREEN_TAG_TYPES` (`Movie`, `TVShow`, `TVSeason`, `TVEpisode`) and
  fire-and-forget-queues each for enrichment (`queueNeodbEnrichment`), exactly like
  the Edition enrichment beside it. Never blocks inbox handling.
- **Periodically (6h) + on startup:** `syncNeodbMetadata` collects every referenced
  catalog URL from stored marks and (re)fetches any that are missing or stale
  (>30 days), bounded to 200/pass.
- `fetchNeodbItem` dereferences the URL; the pure `mapNeodbItem` maps the JSON to
  columns, resolving the IMDb id (direct `imdb`, or parsed out of an
  `imdb.com/title/…` external resource) and the TMDB link.
- The cache is exposed via the `get_watched` MCP tool + `/api/v1/watched` REST
  endpoint (paginated, filterable by title/category/item_type/genre/imdb),
  parallel to `get_books`.

**Books are deliberately excluded** (`Edition` is not in `NEODB_SCREEN_TAG_TYPES`):
NeoDB books federate as `Edition` too, and the BookWyrm book-metadata pipeline
already owns that type. Keeping the type sets disjoint stops the two pipelines from
fighting over the same rows.

## The traps (don't re-derive these)

- **The federated mark has no external ids — only the catalog URL + poster.** IMDb
  and TMDB live on the catalog item behind the tag `href`, reachable only by
  dereferencing it. Any "why isn't the IMDb id stored?" starts here: it was never in
  the `Note`.
- **NeoDB serves the rich catalog JSON via content negotiation.** The tag `href`
  is an HTML page in a browser; request it with `Accept: application/activity+json`
  (what `fetchNeodbItem` sends) to get `imdb`/`external_resources`/etc. Its
  `api_url` is a second option, not required.
- **Enrichment is best-effort and derived — never authoritative.** A fetch failure
  yields no row; the periodic sync retries. The mark itself (via `get_actor_posts`)
  remains the ground truth for *what/when* was watched; `catalog_metadata` only adds
  the reference data.
