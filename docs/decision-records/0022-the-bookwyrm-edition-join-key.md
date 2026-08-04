# 0022 — The BookWyrm edition join key comes from the object, and must be normalised

- **Status:** Accepted
- **Date:** 2026-08-04
- **Contributors:** Claude (agent decision — no human input on the technical choice; found by Markus deploying ADR 0020's work and reading the log line it prints)
- **Affects:** `src/stream/book-url-sql.ts`, `src/jobs/derive-garden-dates.ts`
- **Topics:** bookwyrm, joins, stream, garden, incident, postgres

## Context

ADR 0020 recovers dates for undated markus.plus book reviews by joining each note's
`bookwyrm` frontmatter URL against Markus' own BookWyrm reading events. It shipped
with unit tests passing, a typecheck clean, and an end-to-end run against a real
Postgres covering seven fixtures including the fail-closed case.

On the box it recovered **zero** dates. The first sync after deploy logged
`dates_recovered: 0, still_undated: 281` — every single undated note, untouched.

Two independent defects, either of which alone was fatal.

**1. It joined `bookwyrm_objects.book_url`.** That column is written by the ingest
path and is not reliable. Nothing else in this codebase trusts it: `hydrateBooks` in
`query.ts` derives the edition from the AP object instead — `inReplyToBook` for
reviews and comments, the `Edition` tag for BookWyrm's generated start/finish notes —
and the MCP's reading tools compute it the same way at read time. The derivation was
the only consumer reading the column, and the tests passed because the fixture
populated it by hand. The fixture encoded the assumption instead of testing it.

**2. It compared un-normalised URLs.** BookWyrm serves an edition under two shapes:

    https://bookwyrm.social/book/1510472
    https://bookwyrm.social/book/1510472/s/septologien

Federated posts carry the bare form. Markus' hand-written frontmatter carries
whichever the URL bar was showing when he copied it — **96 of his 241 book reviews
have the slug**. An equality join between the two matches by luck.

## Decision

**The edition of a stored post is derived from the AP object, in one place.**
`bookUrlOn(objAlias, bwAlias?)` in `src/stream/book-url-sql.ts`:
`inReplyToBook`, then the `Edition` tag, then `bookwyrm_objects.book_url` as a last
fallback rather than a first choice. Anything needing the edition of a post uses
this rather than inventing a fourth way.

**Both sides of any edition join are normalised** to the bare
`https://host/book/<id>` form, by `normalizeBookUrl` in SQL and
`normalizeBookUrlText` in TypeScript.

The `Edition` tag lookup guards `jsonb_array_elements` on `jsonb_typeof(...) =
'array'`. `tag` is absent on plenty of objects and the function raises on a scalar,
which would fail the whole statement rather than one row.

## Consequences

- The derivation recovers dates again. On the fixture reproducing production's shape
  — `bookwyrm_objects.book_url` NULL throughout, one bare URL, one slug URL — the old
  code recovers 0 and the new code recovers both, with a followers-only review still
  refused.
- **The lesson worth keeping is about the fixture, not the join.** Every test passed
  because the test data was built from the same wrong belief as the code. Running the
  query against a real database is not sufficient if the rows in it were invented to
  match. Where a join key has a canonical source elsewhere in the codebase, the
  fixture should be shaped like production — or better, the code should use the
  source the rest of the codebase already trusts, which is a question that can be
  answered by reading rather than by testing.
- The counter that caught this (`dates_recovered` / `still_undated`, logged on every
  garden sync) was added in ADR 0020 for exactly this purpose and did its job on the
  first run after deploy. Silent derivations should log what they derived.
- Normalisation is idempotent and passes through non-edition URLs unchanged, so it is
  safe to apply anywhere an edition URL is handled.
