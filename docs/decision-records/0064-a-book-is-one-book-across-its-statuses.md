# 0064 — A book is one book across its statuses, however each one names it

**Status:** Accepted
**Date:** 2026-10-19
**Topics:** bookwyrm, reading, collapse, cycles, storygraph, matching
**Contributors:** Markus (ran the first live StoryGraph import and reported the result) +
Claude (diagnosed and implemented)

**Affects:** `src/lib/bookwyrm-reading.ts`, `src/jobs/import-storygraph-reads.ts`

## Context

The first live StoryGraph import (ADR 0063) matched 170 of 416 books with reads, filled 0
starts and left *Ducks*, *Slags* and *Om udregning af rumfang II* unmatched, although all
three are on BookWyrm with title, author and ISBN cached.

The cause was older than the import. `collapseReadingEvents` keyed each status on
`normalizeTitle(title) || url`. A generatednote ("started reading *Hysj*") carries the title
and the Edition URL; a comment or review often carries only the URL (`inReplyToBook`). So
one book became two collapsed rows: a title-keyed half holding the start and a URL-keyed
half holding the finish. Every reading tool already showed *Hysj* as finished with no start
on one row and started but never finished on the other, depending on which the lookup hit.
The import then saw two candidates with the same title (the URL-keyed half takes its title
from the metadata cache) and, as ADR 0063 requires, matched neither; where it did match, it
often landed on the half without the finish, so no start was ever filled.

## Decision

**Key a book on the union of every title and URL its statuses use.** A status naming both
links them; the key is the group's first title, else its URL, which is exactly
`normalizeTitle(title) || url` on the collapsed row, so `collapseKey` and every lookup keep
working unchanged. Two editions sharing a title still merge, as before.

**A conflict row names the book by StoryGraph's title** when BookWyrm never gave one, rather
than printing "—".

## Consequences

- Books that showed a finish without a start because the start sat on the other half now
  carry both, in every reading tool, with no import involved.
- Stored `matched_key` values from imports before this fix point at the split keys. Re-upload
  the export once after deploying: the import is idempotent and rewrites them in place.
- Remaining conflicts are mostly a day apart: a "read" comment posted the morning after the
  night StoryGraph files. BookWyrm wins, as ADR 0063 decided.
