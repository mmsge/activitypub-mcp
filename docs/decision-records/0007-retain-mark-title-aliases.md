# 0007 — Retain the mark's tag name as a catalogue alias, so a title is findable by the name it federated with

**Status:** Accepted
**Date:** 2026-07-23
**Topics:** neodb, activitypub, metadata, enrichment, derived-data, catalogue, search, aliases, provenance, i18n
**Contributors:** Markus (asked & decided: aliases **accumulate** across marks rather than keeping only the most recent) + Claude (proposed the design and implemented it)

## Context

A federated mark from `@markus@minreol.dk` carries a tag `{ type, href, name }`, where
`name` is the title as the mark federated it — e.g. **`Conflict`**. NeoDB enrichment
(ADR 0005/0006) then dereferences the `href` and overwrites `catalog_metadata.title`
(and `display_title`) with NeoDB's **localized** name — **`Konflikt`**. Only the enriched
value is stored; the name the mark actually used is discarded, surviving only inside the
`objects.tags` JSONB blob, which nothing reconciles with the catalogue row.

So `get_watched(title="Conflict")` returned `total: 0` even though the row exists
(`https://minreol.dk/tv/season/2mHcVZbJprJFqdIYBwnjTU`, imdb `tt27579939`). `orig_title`
was null here, so it didn't bridge the gap either. A consumer searching for what they
actually watched, by the name they saw, got nothing.

This is about **retaining the name that arrived**, not translating or normalising titles
across languages (explicitly out of scope — we don't try to decide which name is canonical).

## Decision

**Persist the mark-supplied name(s) as an accumulating alias list on the catalogue row,
and search across it alongside `title`.**

- **New `catalog_metadata.mark_titles` (jsonb `string[]`)** holds the distinct, non-empty
  tag `name`s from every stored mark whose tag `href` is this row's `item_url`, following
  the table's existing multi-value convention (`genre`/`actors`/`language`).
- **Aliases accumulate** (Markus's call): every distinct name any mark ever used is kept,
  not just the latest. This is the safer choice for a catalogue spanning several federated
  sources — a re-federation under a third name *adds* a third alias rather than clobbering
  the earlier ones.
- **Derived from `objects`, not threaded through enrichment.** `mark_titles` is a pure
  projection of the mark names already in `objects.tags`: `markTitlesForUrl(itemUrl)`
  unions `extractMarkTitles` across every stored mark tagging that href. "Accumulate" then
  falls out for free, and there is no second write path to keep in sync.
- **Provenance:** when a row has aliases, `source_map.mark_titles = 'activitypub'`,
  distinguishing the alias origin from the NeoDB (`'neodb'`) / BookWyrm (`'bookwyrm'`)
  fields. Surfaced (with `mark_titles`) via `get_catalogue_details`; `mark_titles` is also
  added to `get_watched`.
- **Matching** in `get_watched` / `get_catalogue_details` becomes
  `title ILIKE %q% OR (any mark_titles element ILIKE %q%)` — still case-insensitive and
  partial (reusing the jsonb-array `EXISTS` pattern the `genre` filter already uses).
- **Maintenance is three-pronged** so an alias is never stranded: enrichment's upsert seeds
  `mark_titles` when it creates/refreshes a row; on-ingest (`handleCreate`) recomputes it
  for each referenced item so a later mark accumulates immediately; the 6-hourly sync
  reconciles every referenced URL (local-only, independent of NeoDB staleness). Existing
  rows are seeded once by the 0013 migration's backfill (and a marker-guarded startup
  backfill), so the Conflict/Konflikt row is fixed on deploy.

## Why derive from `objects` instead of threading the tag name through enrichment

Enrichment is keyed only by `item_url`. The on-ingest path **early-returns** for an
already-enriched row (`enrichIfNeeded`), and the periodic sync **skips fresh rows** — so a
*new* alias arriving on an existing, still-fresh row would never be picked up if we only
wrote the name at enrichment time. Recomputing from `objects.tags` sidesteps all of that:
it's a cheap local query (no NeoDB fetch), correct for both first-create and later
accumulation, and the one-time backfill is just the same recompute over existing rows.
The mark object is always inserted into `objects` before enrichment/alias sync runs, so the
name is available.

## The traps (don't re-derive these)

- **The mark's tag `name` and the row's `title`/`display_title` come from different sources
  and legitimately differ in language.** The tag name is whatever the marking instance
  embedded in the Note; `title`/`display_title`/`orig_title` come from separately
  dereferencing the catalog item. Never assume they match — that assumption is exactly what
  hid the row.
- **`mark_titles` is derived, best-effort reference data — not authoritative.** The mark
  (`get_actor_posts`) stays ground truth for *what/when*; `mark_titles` only makes the row
  findable by a name that was otherwise lost. It reflects the marks currently in `objects`,
  so a deleted mark's name can drop out — that's intended.
- **Only `title` was ever searched** — `display_title`/`orig_title` are populated but not
  matched, and are left that way here. This ADR adds `mark_titles` to the match, nothing
  else; broadening to the other title columns is a separate decision.
