# 0011 — One ingest path for Create, Announce and Update, and a repair job for what the old paths dropped

**Status:** Accepted
**Date:** 2026-07-30
**Topics:** neodb, activitypub, ingestion, marks, announce, boost, update, edit, upsert, backdating, repair, watched
**Contributors:** Claude (agent decision — no human input on the technical design; the task fixed the acceptance criteria, not the implementation)

## Context

ADR 0008 built the mark store and wired it into the `Create` handler. On 2026-07-30, 27
backdated film marks were created through the NeoDB API on `@markus@minreol.dk`. All 27
federated correctly from minreol. None reached `get_watched`.

Three separate defects, all of them on this side:

1. **`Announce` had its own, lossier store.** Because `post_to_fediverse: true` was set,
   the marks reached us as boosts from the Mastodon account rather than as pushed
   `Create`s. The boost handler wrote its own row: `content_text` hard-coded to `null`, no
   BookWyrm handling, no catalogue enrichment, no mark upsert. The posts landed with the
   right timestamps and the right `tags` — and nothing downstream of them.
2. **`Update` was a patch, not an upsert.** A mark made in the minreol UI arrived as
   `Update`/`Note` (NeoDB re-sends the whole object). The handler ran `UPDATE … WHERE
   ap_id = …` against a row we did not have, matched nothing, and returned. The activity
   is in the log; the post never existed.
3. **`relatedWith` is an array when the mark has a comment.** The live payload for a mark
   with a comment is `[{type:'Status', …}, {type:'Comment', content:'…', …}]`. `isNeodbMark`
   accepted only the single-object form, so every commented mark — all 27 — was invisible
   to the mark store *and* to the local reprocess pass, whichever way it had arrived.

Any one of these alone would have hidden the batch.

## Decision

**One ingest path.** `ingestObject(obj, actorApId, {source})` in
`activitypub/handlers/create.ts` stores the object and runs every derived-data pipeline:
text, structured fields, BookWyrm extras, book/NeoDB enrichment, mark upsert. `Create`
calls it, `Announce` calls it after unwrapping the boost, `Update` calls it. A mark
produces the same row whichever way it arrives, and there is one place to change when
that stops being true.

- **`Announce` is unwrapped, not stored.** A boost carries the boosted post as a bare URI
  (Mastodon) or, occasionally, an `{id, type}` stub; both are dereferenced
  (`lib/fetch-ap-object.ts`) before ingest. The inner object is stored under **its own**
  id and attributed to **its own** `attributedTo`, so a post that is both pushed and
  boosted stays one row filed under its real author. An object that cannot be resolved to
  something with content is skipped rather than stored as a husk — storing it would also
  overwrite a good row on re-delivery.
- **`Update` is an upsert.** It updates the row if we hold one and creates it if we do
  not. Actor updates (`Person`/`Service`/…) are excluded — they are not posts and must
  never enter `objects`.
- **`relatedWith` is normalised to a list** in `lib/neodb-mark.ts`. The `Status` entry
  identifies the mark; a `Comment` entry pointing at the same catalogue item is retained
  as `comment` (and in the mark's `raw`).
- **Nullable fields refresh only when present.** The upsert's `SET` includes
  `content`/`published_at`/`url`/`in_reply_to` only when the incoming payload actually
  carries them, so a thinner re-delivery cannot blank a row that is already good.
- **A repair job rebuilds what the old paths dropped** (`jobs/repair-neodb-ingest.ts`):
  re-derive post text from the stored `raw`, upsert the mark store, enrich every
  catalogue item the stored posts tag. Marker-guarded auto-run on startup, plus a forced
  `npm run repair-neodb-ingest` and an **Admin → Import → Repair NeoDB Marks** button.

## Why repair locally instead of re-marking or re-crawling

The 27 posts were already stored, with their `raw` intact — the information was never
lost, only unused. Re-marking on NeoDB would create new federated posts and, historically,
unwanted boosts; a full outbox re-crawl would hammer minreol for data we already hold. The
job is therefore local-first: it only reaches the network for a catalogue item it has no
enriched row for, or for the rare stored post whose `raw` has no text either.

## Why the boost path is fixed even though boosts are getting rarer

`post_to_fediverse: true` is the crosspost-to-Mastodon switch, not the federation switch,
and it has since been turned off. Push delivery from minreol works and is the correct
path — this server must not depend on boosts. But boosts from *other* accounts still
arrive, and a boost handler that silently degrades every object it touches is a trap for
whatever ingests next. Unwrapping is the fix; depending on the wrapper is not.

## The traps (don't re-derive these)

- **`relatedWith` is single-or-array**, like most AP properties. So are `tag`,
  `attachment`, `url`, `attributedTo`. Anything that reads one shape only will work
  against the payloads you tested and fail against the ones you didn't.
- **Backdating is normal, not an anomaly.** A mark's `published` is the date the thing was
  watched — 2016 in this batch. Nothing in ingest, enrichment or the mark store may filter,
  clamp or sort-assume on recency; the only recency guard in the system is the mark store's
  `updated`-based idempotency, which compares stamps and never wall-clock age.
- **`get_actor_posts` returns `content_text`, not `content`.** A row can have its HTML and
  still read as `content: null` through the MCP tool. When text looks missing, check which
  column is actually empty before concluding the payload was.
- **The boost and the boosted post are different objects.** Attributing the inner object to
  the announcer files another account's post under the booster — and, for a NeoDB mark,
  puts the mark on the wrong actor in a store keyed on (item, actor).
