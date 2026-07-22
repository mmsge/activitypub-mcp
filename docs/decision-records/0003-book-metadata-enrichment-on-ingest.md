# 0003 — Enrich book metadata on ingest (plus periodic backfill), and let every reading tool read the cache

**Status:** Accepted
**Date:** 2026-07-22
**Topics:** bookwyrm, reading, book-metadata, enrichment, caching
**Contributors:** Claude (agent decision — no human input on the technical choice; the user story reporting the symptoms was the trigger)

## Context

A real session ("how fast did I read the Dungeon Crawler Carl books?") needed
four tool calls and manual cross-referencing because three tools disagreed
about the same books:

1. `get_reading_pace` returned `title: null` / `author: null` for most cycles —
   only bare `bookwyrm.social/book/NNN` URLs were usable.
2. `get_reading_stats` with `author: "Dinniman"` returned zero books even
   though `get_actor_reading_status` showed "Matt Dinniman" on four finished
   books.
3. `search_actor_content` with "Dungeon Crawler" returned zero results despite
   six matching public statuses being stored.

Root causes were three distinct bugs that presented as one "metadata lag":

- **Books whose statuses were all comments collapse without a name.** BookWyrm
  comments/reviews reference the book only via `inReplyToBook` (a URL) — no
  Edition tag, no title. A book started and finished purely through comments
  groups by URL with `title: null`, and pace/stats displayed only what the
  collapse produced.
- **`book_metadata` had no `author` column at all**, so the stats `author:`
  filter could only ever match authors parsed out of status attachments —
  which comments don't carry. The live shelf path resolves authors by
  dereferencing the Edition's author AP objects; the cache never did.
- **The search used Postgres `LIKE` (case-sensitive) on a lowercased term**, so
  any capitalized content ("Dungeon Crawler Carl") could never match. The
  comment above the code said ILIKE; the code said `like`. Separately,
  `object_types` was filtered *after* `limit`, silently dropping matches.

## Decision

**Enrichment is triggered on ingest *and* by the existing periodic backfill —
both, not either.** When `handleCreate` ingests any object referencing an
Edition URL (via `inReplyToBook`, an Edition tag href, or a nested `book`)
that is not yet in `book_metadata`, it queues a fire-and-forget enrichment
(`queueBookMetadataEnrichment` in `src/jobs/sync-book-metadata.ts`): a
process-lifetime attempted-set dedupes bursts, a promise chain serializes
fetches so an outbox backfill can't stampede BookWyrm, and failures are simply
left for the 6-hourly `syncBookMetadata` pass, which already retries every
referenced-but-uncached URL. The periodic pass remains the completeness
guarantee; the ingest trigger is the freshness guarantee. Neither blocks inbox
handling.

**The cache now stores `author`** (all authors, `", "`-joined), resolved from
the Edition's author AP objects with review/OpenLibrary/Google Books as
gap-fillers — the same precedence as every other field, recorded in
`sourceMap`.

**Every reading tool resolves book identity the same way:** cache title/author
first (canonical Edition values), the parsed status fields next, and — only
for books that still have no title at all — one live shelf fetch merged by
Edition URL (`fillNamesFromLiveShelf` in `src/lib/book-identity.ts`, no-op and
no network in the common case). `get_actor_reading_status` keeps its live-first
semantics and only gap-fills from the cache.

## The traps (don't re-derive these)

- **Postgres `LIKE` is case-sensitive; `ILIKE` is not.** Lowercasing the term
  does nothing when the column keeps its case. If a substring search "returns
  nothing that obviously exists", check the operator before the data.
- **Filtering in memory after a SQL `LIMIT` silently drops matches.** Any
  filter must live in the WHERE clause or the page is wrong.
- **Existing cache rows only refresh when 30-day-stale.** After deploying a new
  cache column, set `BOOKMETA_BACKFILL=true` for one pass (then unset it) or
  the column stays null for up-to-30 days on already-cached books.
- **Comments carry no Edition tag** — never assume a stored status has a title;
  the URL is the only reliable join key.

## Consequences

- "How fast did I read series X?" is one `get_reading_pace` call: every cycle
  carries a resolvable title/author as soon as the book's Edition has been
  enriched — which now happens minutes after the first status about it, not up
  to 6 hours + 30 days later.
- A brand-new book seen mid-session may still race its enrichment; the live
  shelf fallback covers exactly that window.
- The ingest trigger adds one guarded SELECT per book-referencing object —
  negligible against the existing per-object writes.
