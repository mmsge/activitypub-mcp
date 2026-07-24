# 0008 — Ingest NeoDB marks into a dedicated per-actor store, keyed on (item, actor), joined to the catalogue cache

**Status:** Accepted
**Date:** 2026-07-24
**Topics:** neodb, activitypub, ingestion, marks, watched, reading, store, idempotency, delete, backfill, catalogue, provenance
**Contributors:** Claude (agent decision — no human input on the technical design; the task fixed the acceptance criteria, not the schema)

## Context

The server follows `@markus@minreol.dk` and receives its activities. A NeoDB "mark"
(watched/read/shelved) federates as a plain `Note` carrying NeoDB's Mastodon-compatible
`status` extension:

```json
"relatedWith": { "type": "Status", "status": "complete",
                 "withRegardTo": "https://minreol.dk/movie/…", "published", "updated" },
"tag":         { "type": "Movie", "href": "https://minreol.dk/movie/…", "name", "image" }
```

The marks arrived and were stored raw, but `get_watched` returned only two TV seasons — the
two most recent, which happened to be enriched on-ingest — while ~29 film/TV marks that
federated correctly never surfaced. The catalogue cache (`catalog_metadata`, ADR 0005/0006)
is keyed by `item_url` only and holds per-**title** reference data; it records nothing about
*who* marked an item, *what status*, or *when*. So there was nowhere the mark's own facts
(actor, shelf status, watched date, the Note id) could live, and no reliable trigger turning
a received mark into a durable watched entry.

The `content` prose ("blev færdig med at se …") is human copy and must never be scraped for
the title — the structured `tag`/`relatedWith` carry everything.

## Decision

**Add a dedicated `neodb_marks` table — the per-actor mark store — and keep `catalog_metadata`
as the shared per-title enrichment cache the two join on.**

- **New table `neodb_marks`**, unique on **(`item_url`, `actor_ap_id`)**. Each row captures the
  mark's own facts: normalised `item_url`, actor, `item_type` + mapped `category`, `status`
  (mapped verb) + `status_raw` (verbatim), `title`/`cover_url` (from `tag`), `mark_ap_id` +
  `mark_url` + `post_id`, `published_at` (the watched/read date), `updated_at_ap` (change
  tracking), and `deleted_at` (tombstone).
- **Detection is structural (criterion 1):** a `Note` is a mark iff `relatedWith.type == "Status"`
  and `relatedWith.withRegardTo` is present. Ordinary Notes have no `relatedWith` and fall
  straight through the existing ingest untouched — no regression to normal post handling.
- **The item URL is the join key.** `withRegardTo`, the `tag.href`, and the `~neodb~` link in the
  prose all normalise (strip `/~neodb~`, strip trailing slash) to the same value
  `catalog_metadata` keys on — so a mark and its enriched title line up.
- **Upsert is `updated`-guarded (criterion 4).** On conflict, overwrite only when the incoming
  `updated` is strictly newer (or either side lacks one); older/equal is a no-op. Marks get
  re-sent as delete+recreate during backfills, and this stops a burst of repeats from churning
  the row. A qualifying upsert also clears any tombstone (a recreate revives the entry).
- **Delete tombstones (criterion 5).** minreol sends `Delete` → `Note` directly; the handler
  soft-deletes every `neodb_marks` row whose `mark_ap_id` matches, so the mark's history stays
  auditable and a recreate can revive it.
- **`get_watched` stays catalogue-shaped but respects tombstones.** It still reads
  `catalog_metadata` (so ingested films appear with the *same* fields as the reference TV
  seasons), with one added filter: hide an item once **every** mark for it is tombstoned. Items
  we track no mark for are grandfathered in, so the filter never hides a title with no delete
  behind it.
- **Backfill is two-pass (criterion 7):** reprocess already-stored `objects` locally, then top up
  from each discovered mark-actor's live outbox (which carries the full status/timestamp history
  even for marks whose stored raw predates the extension). Marker-guarded auto-run on startup,
  plus a forced `npm run backfill-neodb-marks`.

## Why a new table instead of extending `catalog_metadata`

`catalog_metadata` is per-**title**, keyed by `item_url` alone, and deliberately holds no
actor/status/date. The mark facts are inherently per-**(actor, item)** and multi-valued over
time (status changes, re-marks). Bolting actor/status/dates onto the catalogue row would break
its single-row-per-title contract and conflate two different lifecycles (a shared reference cache
vs. one person's mark history). Keeping them separate and joining on the normalised URL preserves
both: enrichment (ADR 0005/0006) and alias retention (ADR 0007) keep working unchanged, and
`get_watched` gains deletion-awareness without changing its output shape.

## Why `get_watched` keeps reading the catalogue cache

The acceptance criteria pin the output to "the same fields it already returns for the natively-
marked items" — i.e. the enriched catalogue shape (`display_title`, `cover_url`, `category`, IMDb/
TMDB, …), which lives in `catalog_metadata`, not in the mark. Every catalogue row exists *because*
of a mark (enrichment is triggered by ingest), so the catalogue set already is "watched items";
the only gap was (a) marks that never reached enrichment — closed by upserting + enqueuing
enrichment on every detected mark and by the outbox backfill — and (b) deletions — closed by the
tombstone filter. Surfacing `status`/dates directly in `get_watched` was left out to avoid
changing the established shape; that data lives in `neodb_marks` for callers that want it.

## The traps (don't re-derive these)

- **Never scrape `content` for the title.** It's localized human prose; the title is `tag.name`,
  the item is `relatedWith.withRegardTo` / `tag.href`. Working off the prose is exactly the shape
  mismatch that hid the marks.
- **Normalise the item URL before using it as a key.** `withRegardTo` (`…/movie/<id>`), `tag.href`
  (same), and the `~neodb~` content link must collapse to one value or the mark won't join its
  catalogue row and the unique key won't dedupe.
- **Idempotency is on `updated`, not on receipt.** Re-receiving a mark (redelivery, outbox
  re-crawl, delete+recreate) must not duplicate or churn. Overwrite strictly-newer only; older/
  equal is a no-op — including for the tombstone, so a stale redelivery can't silently un-delete.
- **`get_watched`'s filter grandfathers untracked items.** It hides an item only when it *has*
  marks and *all* are deleted — never when it has no tracked mark — so pre-existing enriched rows
  are never made to vanish by the new table.
