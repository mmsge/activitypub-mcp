# 0001 — Refresh structured fields (tags/attachments) when a post is edited

**Status:** Accepted
**Date:** 2026-07-19
**Topics:** activitypub, ingestion, hashtags, edits
**Contributors:** Claude (agent decision — no human input on the technical choice; Markus only reported the symptom)

## Context

`@markus@skvip.lol` posts `#TogSelfie` train selfies, and msge.no/togselfie is
built from the bot's `/actor-posts?tag=togselfie` filter. Several posts that
carry `#TogSelfie` in Mastodon's own hashtag timeline were missing from the
gallery.

The `tag=` filter (`hashtagCondition` in `mcp/tools/actor-posts.ts`) matches on
the stored **structured** `tags` JSONB, not the post text — the correct thing to
do, since structured tags are ActivityPub's authoritative hashtag list. The
missing posts *were* stored, and their text carried `#TogSelfie`, but their
`tags` array did not.

## The trap

Markus had gone back and **edited** older posts to add `#TogSelfie` after the
fact (he said so in a post: "eg har gått tilbake og gjeve dei alle passande
emneknaggar"). An edit federates as an `Update` activity. But:

- `handleUpdate` refreshed `content`/`contentText`/`summary`/`raw` and **left
  `tags` and `attachments` frozen** at their first-seen values.
- `handleCreate`'s `onConflictDoUpdate` had the same blind spot, so a
  re-delivery or outbox re-crawl couldn't repair a row either.

Net effect: an edited post's *text* gained the hashtag while its *structured
`tags`* did not, so the `tag=` filter never returned it. The failure is silent
and easy to reintroduce — anyone adding a field to the insert who forgets the
update path recreates it.

## Decision

1. Re-derive **every mutable structured field** (`tags`, `attachments`,
   `sensitive`, `language`) from the edited object in `handleUpdate`, and refresh
   the same fields in `handleCreate`'s conflict path.
2. Extract the field derivation into `lib/object-fields.ts` so the create,
   update, announce, and backfill paths share one implementation and cannot
   drift.
3. Repair already-stale rows with a one-time, marker-guarded backfill
   (`jobs/backfill-tags.ts`) that re-derives `tags`/`attachments` from each
   row's `raw` jsonb — `raw` is overwritten on every edit, so it already holds
   the current hashtags. Mirrors the existing `backfill-content-text` job.

## Consequences

- Edited posts now keep correct structured metadata, so hashtag/media filters
  stay in sync with the post text.
- No consumer change was needed: msge.no already re-checks the tag structurally;
  once the bot's `tags` are correct, the gallery fills in.
- The backfill runs once per box (server_config marker `tags_attachments_backfill_v1`).
