# 0076 — English metadata for film and TV from TMDB

**Status:** Accepted
**Date:** 2026-11-13
**Topics:** neodb, catalogue, enrichment, tmdb
**Contributors:** Markus (user story; reuse Streaming Guide's TMDB key; film and TV only) +
Claude (proposed and implemented)

**Affects:** `src/lib/tmdb-refine.ts`, `src/jobs/sync-neodb-metadata.ts`,
`src/jobs/refine-tmdb.ts`, `src/config.ts`, `src/db/schema.ts`,
`drizzle/0049_catalog_tmdb_refiner.sql`

## Context

Since the move to neodb.social (ADR 0075), film and TV items arrive with director, actors
and description in Chinese, because that catalogue often takes them from Douban. Titles,
links and dates are fine, and almost every such item carries a TMDB link.

## Decision

**Every film and TV item with a TMDB link is re-read from the TMDB API in `en-US`**,
inside `enrichOne`, after NeoDB and before the upsert. Title, original title, year,
description, genres, directors and the top 10 billed actors come from TMDB where it has
them. NeoDB's values stay as the fallback for any field TMDB leaves empty, and every field
TMDB set says `tmdb` in `source_map`.

**A season reads the season and the show.** The season gives its name, overview, air date,
episodes and aggregate credits. The show gives genres and creators (`details.creators`),
which TMDB keeps only on the show. Season number and episode count follow TMDB when it
disagrees, and the disagreement is logged.

**Only a link naming the item's own kind is used**, through the same `tmdbKey` the work
grouping uses. A season carrying the show's link is left alone rather than given the
show's metadata.

**Never blocking.** A failed or rate-limited call stores NeoDB's values with `tmdb_error`
and counts `tmdb_attempts` up. The periodic sync treats a row TMDB still owes as not fresh
and retries it, up to 5 attempts. A 404 spends them all at once. Every pass writes
`tmdb_refined_at`, so a pass that did not refine clears a claim NeoDB's values have just
overwritten.

**One credential.** `TMDB_API_TOKEN` is Streaming Guide's key, a v4 token (sent as Bearer)
or a v3 key (sent as `api_key`). Blank disables the refiner.

**Backfill.** The periodic sync refines owed rows 200 a pass, CJK-bearing rows first, so the
neodb.social items go before the MinReol ones. `npm run refine-tmdb` does all of them at
once and is safe to re-run.

## Consequences

- Credits and descriptions read in English whichever instance the mark came from.
- Plays, books, music and anything else without a TMDB link are untouched.
- The archive now calls `api.themoviedb.org`: two requests for a season, one otherwise.
  The box's Streaming Guide shares the key and so the rate limit.
