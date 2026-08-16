# 0046 — Serve the mark's status, and subtract rather than select

**Status:** Accepted
**Date:** 2026-08-16
**Topics:** neodb, marks, get_watched, rest, filters, framfor
**Contributors:** Markus (asked for the film/TV side to be covered in the same pass as the books) + Claude (agent decision on the shape, and on the polarity)

## Context

ADR 0008 introduced `neodb_marks.status` — `wishlist | progress | complete | dropped`,
mapped from the NeoDB verb, with `status_raw` kept verbatim beside it and an index on the
column. It then wrote down, explicitly:

> Surfacing `status`/dates directly in `get_watched` was left out to avoid changing the
> established shape; that data lives in `neodb_marks` for callers that want it.

The dates half of that was reversed by ADR 0012, which surfaced `watched_at`. The status
half never was. So for as long as the mark store has existed, `dropped` has been parsed,
mapped, indexed, written to Postgres — and **never read back by anything**. There is a
`neodb_marks_status_idx` serving zero queries.

The cost showed up downstream. framfor's `film` and `tv` arenas are fed from
`/api/v1/watched`, so a film Markus walked out of arrived indistinguishable from one he
loved, exactly as the abandoned books did on the BookWyrm side (ADR 0045). Same class of
bug, different pipeline, and the fix for one is only half a fix.

## Decision

**Surface it, additively.** `status` (the newest live mark's canonical value),
`status_raw` (NeoDB's verb verbatim) and `statuses` (every live mark's status, newest
first) on every `get_watched` and `get_catalogue_details` row. Plural for the same reason
`mark_titles` / `mark_comments` / `watched_dates` are plural: an item can be marked more
than once, and a re-mark is exactly how `progress` becomes `complete`. No field removed, no
default filter added — the established shape ADR 0008 was protecting is intact.

**Two filters, and they are deliberately asymmetric with the book shelf.**

- `status` is **positive**: only items whose newest live mark carries that value.
- `exclude_status` is **negative**: drop items whose newest live mark carries any of these,
  and **keep items with no tracked mark**.

The asymmetry is the substance of this record. On the BookWyrm side, `shelf=read` is a
positive filter and unknown membership is correctly excluded, because the shelf table is
rebuilt from all four live shelves on every pass — absence from it is information.

`neodb_marks` offers no such guarantee, and `buildConditions` already says so. Its
tombstone clause carries this comment:

> items we track no mark for (enriched by a path that predates the mark store) are
> grandfathered in, so this never hides a title that has no delete behind it.

Absence of a mark here means "we do not know", not "not finished". So a caller wanting
*only what was actually finished* must **subtract what is positively known to be
unfinished**, not select what is positively known to be finished. The failure modes are not
symmetric: a false negative is one dropped film staying in a ranking list, a false positive
is every grandfathered title vanishing at once — which is precisely the catastrophe
framfor's own missing-sweep floor exists to prevent.

framfor therefore uses `exclude_status=dropped,progress` for film and TV, while using
`shelf=read` for books. The two look inconsistent side by side and are not: they follow the
completeness guarantee of the store behind each.

## Consequences

- `exclude_status` is registered in the REST table's `arrays`, so
  `?exclude_status=dropped,progress` splits in `coerceQuery`.
- Both correlations are written **table-qualified by hand** against
  `catalog_metadata.item_url`, with a test pinning it. A bare `item_url` inside a
  select-list expression binds to `neodb_marks`' own column — Drizzle qualifies in WHERE
  but not there — and becomes an always-true self-comparison that hands every row every
  mark in the table. The same trap `markCommentsExpr` has documented since ADR 0008.
- A test asserts `MARK_STATUS_MAP`'s key set equals the filter enum, so a fifth NeoDB verb
  fails a test rather than quietly landing in the database and being unfilterable — the
  state `dropped` itself was in until now.
- Before pointing framfor at `exclude_status`, measure `(dropped + in_progress)` as a share
  of each category. If it exceeds 20 % the catalogue-sync floor will refuse the first
  sweep. `tv` is the plausible one — being midway through a series is a normal state — and
  the softer answer there is to exclude only `dropped` at first and add `progress` as a
  second step.
- This supersedes, in spirit, one sentence of ADR 0008. That record stays as written; this
  is the note that the sentence no longer holds.
