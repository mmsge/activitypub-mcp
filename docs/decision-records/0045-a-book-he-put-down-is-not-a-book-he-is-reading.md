# 0045 — A book he put down is not a book he is reading: BookWyrm has a fourth shelf, and the archive cannot see it

**Status:** Accepted
**Date:** 2026-08-16
**Topics:** bookwyrm, reading, shelves, ingestion, store, classification, stream, framfor
**Contributors:** Markus (reported that framfor was offering him books he had stopped reading, and decided: fix it upstream at the root rather than filter locally, let the existing tombstone path carry the affected titles, and take the neighbouring cases in the same pass) + Claude (verified the fourth shelf and its disjointness, found the mis-normalisation in three places, designed the store and the completeness gate)

## Context

framfor ranks the films, books and TV Markus has already consumed. Going through the
`bok` arena he found books he had **stopped reading** being offered up in duels as if he
had finished them.

The cause was not in framfor. It was here, and in three layers.

**BookWyrm has four reading shelves, not three.** `GET /user/mvrkws/shelf/stopped-reading`
returns `200 {type: 'Shelf', name: 'Stopped Reading', totalItems: 10}`. Counted on
2026-08-16: **read 408, to-read 30, stopped-reading 10, reading 3** — union 451, pairwise
overlap 0 on all six pairs, so a book sits on exactly one. `fetchBookwyrmShelf` was
hard-typed to `'reading' | 'read' | 'to-read'`, so nothing here had ever asked for the
fourth. Two more places spelled the same three-value list out by hand, `book-identity.ts`
among them — which is why a stopped book with no Edition tag also stayed nameless in
`get_reading_pace` and `get_reading_stats`.

**The words nest, and the normaliser did not know it.** `normalizeReadingStatus` tested
`includes('reading')` before `includes('read')` — correct as far as it went — but never
tested `stopped`. `'stopped-reading'.includes('reading')` is `true`, so a stop normalised
to **`reading`**: `isStartSignal` fired and `deriveReadingCycles` opened a cycle that could
never close. The same cascade was copied into `create.ts`'s `extractReadingStatus` (the
only one that writes the value to disk) and into `readingStatusOn` in
`stream/reading-events.ts` — whose own comment said "the words nest" and then listed only
three of the four. That last copy had a visible consequence rather than a theoretical one:
a comment posted while flipping a book to stopped-reading matched the `reading` arm, so
`startSignalOn` fired and meg.msge.no rendered **"byrja å lesa"** over a post saying he had
given up.

**The archive cannot substitute for the shelf.** A stop *does* federate — a GeneratedNote
reading `"Markus 🌱 stopped reading <a …>Brief Interviews with Hideous Men</a>"`, with an
Edition tag carrying the book URL and no `readingStatus` field at all. But **only 3 of the
10 stopped books have such a note in `objects`.** This is the fact the whole design turns
on. Posts record the events that happened to be witnessed; the shelf records the current
truth. ADR 0002 chose to derive reading dates from public statuses, and that remains right
for *dates* — a date is a fact about an event. Membership is not.

## Decision

**`stopped-reading` becomes a first-class shelf**, exported once as `SHELVES` from
`fetch-bookwyrm-shelf.ts` and imported everywhere the three-value list used to be written
out. A `stopped_reading` event type, `PHRASE_STOPPED`, and the matching arm in
`readingEventTypeCondition` — including the new exclusion in its `note` arm, without which
the two overlap and the function stops being the inverse of the classifier it documents
itself as mirroring. The stopped test goes **first** in all three normalisers.

**A stop closes the open cycle and records `abandoned`, not a finish.** A start after a
stop opens a new cycle, so a book abandoned once and finished later carries both facts —
structurally a reread, which is what it is. `get_reading_pace` reports `books_abandoned`
and keeps them out of every average, the fastest/slowest picks and the overlap sweep;
abandoned cycles were already excluded by the `if (!c.finished) continue` guard, so **no
pre-existing number moves**. Excluded used to mean invisible, and giving up on a book is a
thing that happened.

**Shelf membership is stored, in its own table.** `bookwyrm_shelf_marks`, keyed unique on
`(actor_ap_id, book_url)` — a scalar, justified by the measured disjointness rather than by
analogy. Filled by `sync-bookwyrm-shelves`, on the 6-hourly reading chain and once at
startup.

Not columns on `book_metadata`, for two reasons. The shelf is **per-actor** and
`book_metadata` is the shared per-edition cache — the same line ADR 0008 drew between
`neodb_marks` and `catalog_metadata`, and ADR 0037 between `gig_attendances` and
`gig_catalog`. And `sync-book-metadata`'s upsert does `set: values`, so a `shelf` column
there would be blanked on every refresh: exactly the trap ADR 0013 records for `hidden_at`.

**The removal sweep gates on `totalItems` equality, not a percentage.** Every one of the
four shelves must fetch without a failed page *and* return exactly as many items as its
collection claimed. framfor's catalogue sync has to guess with an 80 % floor because it has
no oracle; BookWyrm publishes the expected count on the Shelf root, so settling for a
heuristic where an exact number is available would be choosing to be approximately right on
purpose. A pull that fails the gate still upserts — adding and correcting is always safe —
and removes nothing.

That gate needed `fetchBookwyrmShelf` to be able to fail at all. It used to `logger.warn`
and return a short list, which to anything reconciling membership is **indistinguishable
from a shelf that shrank**. It now reports `complete` and `totalItems`; the lossy wrapper
survives for gap-filling, where a short list costs nothing.

**No `book_stopped` stream card.** ADR 0029 designed `book_comment` as the catch-all for
exactly this, and a new kind would drag in `entryTitle`'s exhaustive switch, a route,
Nynorsk copy, lane SQL and the dedupe predicate — a second feature wearing this one's
clothes. Recorded here so it reads as a choice.

## Consequences

- `get_actor_reading_status` gains a fourth `shelf` value and a fourth `status` filter.
  `fetchLiveShelf` appends `stopped-reading` **last** on purpose: it concatenates shelves
  and only then slices to `limit`, so any earlier position would silently change what a
  default unfiltered call returns.
- The stream stops mis-rendering a stop-comment as "byrja å lesa". That is a live output
  change, and the only one this record carries.
- `bookwyrm_shelf_marks` is populated for the tracked actors only. A book with no live row
  is genuinely on no shelf **once the sync has run** — which is what makes a positive
  `shelf=read` filter safe on `/api/v1/books`, and is precisely the guarantee `neodb_marks`
  cannot offer (see 0046).
- `shelved_date` is kept and depended on by nothing: BookWyrm sends null for every item on
  every one of the four shelves, checked rather than assumed. `first_seen_at` is the only
  date this table can promise, and it dates our first sighting, not his shelving.
- The shelf sync does **not** yet enrich the 30 to-read books it now sees. Deliberate for
  this pass, so the before/after counts on the bok arena stay legible; enabling it would
  move `/api/v1/books` `total` from 424 to ~451.
