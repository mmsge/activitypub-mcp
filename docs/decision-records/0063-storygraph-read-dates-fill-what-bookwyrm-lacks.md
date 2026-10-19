# 0063 — StoryGraph read dates fill what BookWyrm lacks, and BookWyrm always wins

**Status:** Accepted
**Date:** 2026-10-19
**Topics:** storygraph, bookwyrm, reading, import, admin, cycles, rereads, mcp, rest
**Contributors:** Markus (asked & decided: the user story, CSV via admin upload, unmatched
books stored and reported, ratings left out) + Claude (proposed/implemented; pairing window,
matching rules and merge placement an agent decision)

**Affects:** `src/lib/parse-storygraph-csv.ts`, `src/lib/storygraph-reads.ts`,
`src/lib/bookwyrm-reading.ts`, `src/lib/reading-query.ts`, `src/db/schema.ts`,
`drizzle/0043_storygraph_reads.sql`, `src/jobs/import-storygraph-reads.ts`,
`src/admin/router.tsx`, `src/admin/views/import.tsx`, `src/mcp/tools/reading-events.ts`,
`src/mcp/tools/actor-reading.ts`, `src/mcp/tools/reading-pace.ts`, `src/mcp/server.ts`,
`src/rest/table.ts`, `docs/openapi.yaml`

## Context

Reading dates come from federated BookWyrm statuses (ADR 0002). A start exists only when a
"started reading" status was posted, so many books have a finish and no start, and a reread
whose start went unposted folds into one window. The MCP had starts for 2 of the 6 volumes
of *Om udregning af rumfang*; StoryGraph had all 6. *Ducks* showed a window of 2026-05-28 to
2026-05-29 on a finish dated 2024-10-02, while StoryGraph lists two reads.

StoryGraph's library export has a `Dates Read` column: every read, both ends, several ranges
per book. sidetal (ADR 0062) scrapes the reading journal, not the library, and carries
neither read ranges nor ISBNs, so there was no existing import to fix.

## Decision

**An upload at Admin → Import, against a named BookWyrm actor.** The same shape as the trips
and LinkedIn imports: the export is made by hand in a browser, and the box has no watched
directory. The actor field is prefilled from `BOOKWYRM_ACTORS` and resolved the way the
reading tools resolve `actor_handle`, so the rows are keyed on exactly the ap id
`loadCollapsedBooks` is later called with. The result page is rendered, not redirected,
because the conflicts and unmatched books are the report.

**One row per read in `storygraph_reads`, identity (actor, book_key, range_key).** `book_key`
is the ISBN-13 when the export has one, else the folded title and first author. `range_key`
is both ends of the range. The same file twice writes nothing; a reread is a second row. An
export is complete for the books it lists, so a read no longer listed for a book in the file
is deleted, and a book absent from the file is left alone (0054's rule, scoped by book
instead of by date range). Dates are DATEs stored verbatim, already the local day StoryGraph
shows (0062's rule).

**Match at import: ISBN-13 first, then normalised title with an agreeing author.** Titles
fold diacritics and punctuation, and compare both whole and without the subtitle, because
StoryGraph says *Ducks: Two Years in the Oil Sands* where BookWyrm says *Ducks*. An exact
title beats a subtitle-stripped one. Authors agree whole or by surname. A title matching
more than one book is no match: a read attached to the wrong volume of a series is worse
than one listed as unmatched. Candidates carry every Edition URL their statuses named and
every ISBN and author the metadata cache holds for those Editions. Unmatched rows are
stored and reported and invisible to the reading tools until a later import matches them.

**Merge at load, in `loadCollapsedBooks`, so every reading tool sees it.** Each read is
paired with at most one BookWyrm cycle, closest first, when their finishes (or, for an open
cycle, their starts) are within `PAIR_WINDOW_DAYS` (7). A paired cycle keeps every date it
has. StoryGraph fills a missing start or finish; a date both sides have that differs is a
conflict BookWyrm wins. A start that would land after the cycle's own finish is refused the
same way. A cycle BookWyrm says he put down keeps no finish. An unpaired read becomes a
cycle of its own. Cycles are re-ordered by where they end and re-numbered, and the book
window re-derived with the same reducers as the collapse. The shelf is BookWyrm's and is
not touched. The import runs the same merge to count starts filled and conflicts, and logs
each conflict, so the report and the tools cannot disagree.

**Every date says where it came from.** A cycle carries `startedSource`/`finishedSource`
only when StoryGraph supplied the date; absent means BookWyrm, read through
`cycleDateSources`. `get_reading_events` adds `book_started_source`, `book_finished_source`
and `book_reads` (one window per read); `get_actor_reading_status` and `get_reading_pace`
add `started_source`/`finished_source`.

**Only dates.** Ratings, reviews, moods, pace, character fields, content warnings and owned
status are in the file and are not read, and the parser does not carry them in any field.

## Consequences

- *Om udregning af rumfang I* now reports `book_started_date` 2024-03-15 from StoryGraph;
  *Ducks* returns 2024-09-29 to 2024-10-02 and 2026-05-28 to 2026-05-29. Verified against
  Postgres 16 with the migration applied, including a second, no-op run.
- A match is decided at import time. A book added to BookWyrm after the import stays
  unmatched until the next upload; re-uploading is the remedy, and it is idempotent.
- BookWyrm statuses still drive the shelf and any date they carry. If a future BookWyrm
  date contradicts StoryGraph, BookWyrm wins on the next query with no re-import.
- `get_reading_pace` measures reads StoryGraph completed, so its averages move once a file
  is imported. That is the point of the story, not a side effect.
