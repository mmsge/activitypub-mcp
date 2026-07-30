# 0011 — One ingest path for Create, Announce and Update, and a repair job for what the old paths dropped

**Status:** Accepted
**Date:** 2026-07-30
**Topics:** neodb, activitypub, ingestion, marks, announce, boost, update, edit, upsert, backdating, repair, watched, comments
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
- **The mark's comment is a first-class field.** `neodb_marks.comment`, surfaced as
  `mark_comments` on `get_watched` and `get_catalogue_details` and filterable with
  `mark_comment` (case-insensitive substring). Backfilled for rows that predate the
  column by a dedicated pass, because `upsertNeodbMark` deliberately no-ops on an
  unchanged mark and would leave the column null forever.
- **An `Undo`/`Announce` removes nothing.** Un-boosting is a Mastodon-side timeline
  action; the mark on NeoDB is untouched, so the post and its mark stay ingested. The
  27 undos at 16:27–16:30Z were a manual cleanup of unwanted boosts, not a retraction.
  Only a `Delete` of the mark's own `Note` tombstones a mark (ADR 0008).
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

## Why the comment is stored verbatim, and plural

Every film in the 2016 backfill carries a comment recording the medium — "Sett på kino."
(26 of 42), "Sett på Altibox." (8), "Sett på Netflix." (4), plus Viasat, Vimeo and C More
— taken from the source spreadsheet, and the 2015/2014 batches will carry the same.
Without the field, "which films did I see at the cinema in 2016" is unanswerable from
data we already hold.

- **Free text, never an enum.** The medium pattern is a coincidence of these batches;
  future marks carry ordinary prose. Parsing it into categories would encode an accident
  of one import as a schema, and silently drop everything that doesn't fit.
- **Never normalised, translated or stripped.** The text is Nynorsk and user-facing.
  "Sett på kino." is correct as written, full stop included; it is stored and returned
  byte-for-byte.
- **Plural on the read side**, following `mark_titles`: an item can be marked more than
  once — re-marked over time, or marked by a second actor — so `mark_comments` is an
  array of the distinct comments across the item's live marks, newest mark first, with
  tombstoned marks excluded. `[]` when there are none.
- **Read live off `neodb_marks`, not materialised** onto the catalogue row. `mark_titles`
  needs materialising because NeoDB's enrichment overwrites the title it is retaining;
  a comment has no such competitor, so a join is simpler and cannot go stale.

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
- **Drizzle qualifies a column reference in `WHERE` but not in a select-list expression.**
  `${catalogMetadata.itemUrl}` renders as `"catalog_metadata"."item_url"` in a condition
  and as a bare `"item_url"` inside a `sql` expression in the select list — where, in a
  correlated subquery over `neodb_marks`, it binds to *that* table's column instead. The
  result is an always-true self-comparison: no error, right-looking response shape, and
  every row handed every other row's data. `markCommentsExpr` writes the correlation
  table-qualified by hand, and a test asserts the rendered SQL.
- **A column added to `neodb_marks` needs its own backfill.** `upsertNeodbMark` overwrites
  only on a strictly-newer `updated` stamp, so replaying stored marks — the obvious way to
  populate a new column — is a deliberate no-op for every unchanged mark.
