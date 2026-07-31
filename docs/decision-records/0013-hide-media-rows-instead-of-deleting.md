# 0013 — Hide catalogue rows with `hidden_at` instead of deleting them, and default every public tool to excluding them

**Status:** Accepted
**Date:** 2026-07-31
**Topics:** admin, media, catalogue, hiding, soft-delete, enrichment, mcp-tools, rest-api, books, watched
**Contributors:** Markus (asked & decided: hidden rows must disappear from what the server serves, with an explicit opt-in to see them again; no field editing) + Claude (proposed/implemented)

## Context

The new `/admin/media` page (PR #61) finally made the media stores visible: books,
film/TV viewings, other catalogue items, scrobbles. Being able to *see* them immediately
raised the next question — what to do about a row that is wrong.

The catalogue is not hand-curated. `catalog_metadata` is filled by dereferencing whatever
NeoDB URL a mark happened to tag, and `book_metadata` by dereferencing a BookWyrm Edition.
When NeoDB's own record is wrong, or a mark points at the wrong catalogue entry, or a stub
exists only because a fetch failed years ago, the bad row is served — by `get_watched`, by
`get_books`, by `/api/v1`, and therefore to every agent reading this server.

Markus's decision was to have no field editing at all: hide the bad record and, if the
upstream data has since improved, re-enrich it. That keeps the catalogue a faithful cache
of upstream rather than a fork of it, and leaves exactly one editorial verb to design.

## Decision

- **Hide with a `hidden_at` timestamp on `catalog_metadata` and `book_metadata`.** Not a
  delete, not a `hidden` boolean — a timestamp, so "when did I hide this" survives.
- **Hidden rows are excluded by default from every public read**, with
  `include_hidden: true` to opt back in.
- **Hiding acts on the catalogue entry, not on a mark or a post.**
- **The reading tools drop a hidden book entirely**, rather than merely losing its metadata.
- **Nothing is editable.** The admin can hide, unhide, and re-enrich. That is the whole
  surface.

## Why delete does not work

A `DELETE FROM catalog_metadata` looks like the obvious implementation and is undone
within six hours, silently, with no error anywhere.

Both enrichment jobs re-derive their work list from the *stored posts and marks*, not from
the metadata table:

- `collectNeodbTagHrefs` / `collectItemUrls` in `src/jobs/sync-neodb-metadata.ts` walk
  every stored mark's `tag.href`.
- `collectBookUrls` in `src/jobs/sync-book-metadata.ts` walks `bookwyrm_objects.book_url`,
  Edition tag hrefs on `objects`, and `inReplyToBook`.

Anything referenced by a stored mark is therefore re-queued on the next pass and the row
comes straight back — with the same wrong data that motivated deleting it. Deleting the
*mark* instead is worse: it destroys the record that the thing was watched, which is the
data this server exists to keep, and a second mark on the same item would resurrect the
catalogue row anyway.

So the flag has to live on the metadata cache, and it has to be something enrichment does
not touch.

## Why hiding is API-visible rather than admin-only

An admin-only flag would have been safer and useless. The reason to hide a record is that
it is wrong, and "wrong" matters precisely at the point where something reads it. A row
greyed out in the admin UI but still returned by `get_watched` has not been dealt with;
it has been annotated.

`include_hidden` follows the `include_unenriched` precedent from ADR 0006: the default
changes, the capability does not go away, and no caller loses access to anything — they
just have to ask.

## Why the reading tools drop the book instead of filtering the join

`get_reading_stats`, `get_reading_pace` and `get_actor_reading_status` do **not** list from
`book_metadata`. They derive the book list from stored posts (ADR 0002) and use the table
only as a metadata lookup keyed by Edition URL.

The natural-looking change — adding `hidden_at IS NULL` to that lookup's `inArray` — is
wrong in a way that produces no error. The book stays in the derived list and is still
counted in `total_books`, but arrives with null pages, format and author. `avg_pages`,
`avg_pages_prose` and `pages_coverage` all shift, and the book shows up on the shelf as a
nameless row. Hiding a book would silently corrupt the statistics instead of removing it
from them.

So `hiddenBookUrls()` is applied to the *collapsed set* before the join
(`src/lib/hidden.ts`). A book with no `book_metadata` row cannot be hidden at all — there
is nothing to carry the flag — which is correct: hiding is an act on a catalogue entry,
and an entry the catalogue has never seen has none.

## The traps (don't re-derive these)

- **`set: values` in both upserts rewrites every key it carries.**
  `upsertCatalogMetadata` and `upsertBookMetadata` build an explicit `values` object and
  pass it as both the insert and the conflict-update set. Adding `hiddenAt` to that object
  — the obvious way to "keep the row in sync" — would unhide an admin-hidden row on the
  next enrichment pass, with no error and nothing in the logs. The builders are extracted
  as `catalogUpsertValues` / `bookUpsertValues` for no reason other than letting a test
  assert `hiddenAt` is not among their keys. Do not add it.
- **A REST boolean that is missing from `table.ts`'s `booleans` array 400s on GET and
  works on POST.** `coerceQuery` only converts params it is told about; an unlisted
  `include_hidden=true` arrives at zod as the *string* `"true"` and fails validation —
  while the POST/QUERY path (JSON body, no coercion) is fine. Test with GET, or the bug is
  invisible. Seven endpoints needed the entry; a test now pins all seven.
- **`hidden_at IS NULL` cannot be served by an index, so the indexes are partial.**
  Hidden rows are the rare case; a plain btree over a mostly-NULL column earns nothing on
  the hot path. `WHERE hidden_at IS NOT NULL` keeps the admin's "hidden only" view cheap
  and the index tiny.
- **Hiding must also apply to the single-item lookups.** `get_book_details` and
  `get_catalogue_details` resolve by exact URL/ISBN, so filtering only the *listings*
  would leave a hidden row perfectly reachable by anyone who already had its id.
- **The admin must NOT inherit the default.** `/admin/media` passes `include_hidden: true`
  into the shared filter builder. Reusing `get_books`'s conditions verbatim would hide the
  hidden rows from the one screen whose job is reviewing and undoing them.
- **The Watched grid's row id is a mark id, not a catalogue id.** Its hide button posts
  `kind=catalogUrl` with the catalogue URL, because hiding one viewing of a film is not a
  thing — the editorial act is on the title.
