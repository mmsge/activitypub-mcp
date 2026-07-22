# 0002 — Derive reading dates from public ActivityPub statuses, not authenticated BookWyrm access

**Status:** Accepted
**Date:** 2026-07-22
**Topics:** bookwyrm, reading, activitypub, derived-data
**Contributors:** Markus (asked & decided: public AP only, instance-agnostic) + Claude (proposed/implemented; cycle semantics an agent decision)

## Context

The reading tools returned `started_date`/`finished_date`/`rating` as null on
every book. BookWyrm does **not** federate exact ReadThrough dates or page
progress over public ActivityPub — shelf collections are bare Edition objects,
and the only dated signals are the actor's public statuses. The live-shelf path
also cross-referenced `bookwyrm_objects` rows (`ReadThrough`/`Rating` types)
that only exist under full-flavor federation, which federated data never
produces — so it could never find anything.

Real alternatives existed: authenticated access to the instance (session-cookie
reads like bokstrek in `mmsge/bok-skvip-lol`, or BookWyrm's CSV export, both of
which carry exact ReadThrough dates) versus deriving dates from the public
statuses we already store.

## Decision

**Public ActivityPub only, derived at query time.** Markus chose no credentials:
the MCP must work against any BookWyrm account (today `@mvrkws@bookwyrm.social`,
maybe `bok.skvip.lol` later) without storing a session or token. Dates are
day-granularity approximations derived from the stored statuses:

- a status with `readingStatus: "reading"` starts a book; a `"read"` status —
  or **any review** — finishes it (posting a review implies the book was read).
- consecutive start→finish signals form **reading cycles**
  (`deriveReadingCycles` in `src/lib/bookwyrm-reading.ts`): a second start after
  a finish opens a reread; a finish signal with no new start in between is a
  post-finish comment and is ignored, so it can't drag the finish date later.
- everything reads `objects.raw` at query time — no schema change, no backfill;
  history reclassifies retroactively on deploy.

## The traps (don't re-derive these)

- **BookWyrm's "pure" serialization keeps the reading fields.** Pure output only
  overrides `content`/`name`/`type`/`attachment`; `readingStatus`, `rating`,
  `inReplyToBook`, `quote`, `progress` all survive on the plain `Note`/`Article`
  objects. Everything here works from pure serialization.
- **The BookWyrm User-Agent trick is NOT load-bearing.** A UA matching
  `\(BookWyrm/x.y.z;` normally unlocks native types (`Comment`/`Review`/
  `Quotation`), but bookwyrm.social's edge cache doesn't vary on User-Agent, so
  you get the cached pure JSON regardless. We send the UA anyway
  (`src/lib/bookwyrm-fetch.ts`) — polite identification, and a self-hosted
  instance without that cache will serve full flavor — but no feature may
  depend on it.
- **Exact ReadThrough dates and page progress are unreachable on this path.**
  If day granularity ever stops being enough, the recorded alternative is
  authenticated access (bokstrek-style session or CSV export sync), which is a
  new decision superseding this one.
