# 0037 — Ingest Gigowl attendances into a per-actor store joined to a per-concert catalogue

**Status:** Accepted
**Date:** 2026-08-11
**Topics:** samklang, gigowl, activitypub, ingestion, gigs, concerts, setlists, store, enrichment, backfill, stream
**Contributors:** Claude (agent decision on the technical design; Markus asked for the two services to understand each other and chose to change both sides rather than only this one)

## Context

This server has followed `@markus@samklang.msge.no` since 2026-08-10 and had all 29
attendance Notes sitting in `objects` with their tags intact. None of it was legible:
`src/stream/sources.ts` wired `samklang` to the plain `posts` lane, so a gig read as a
Nynorsk sentence with a link in it. "Which gigs did I go to in 2023", "how many times have
I seen Motorpsycho", "what did they play" were all unanswerable from data already held.

Books, films and TV get the full treatment — a per-actor event store, a per-title
enrichment cache, MCP tools, REST endpoints, an admin tab and a stream card. Gigs got none.

An attendance federates as an ordinary `Create`/`Note` (Gigowl's ADR 0006 — `Join` renders
as nothing on Mastodon, so the structure rides in tags instead):

```json
"tag": [{ "type": "Link", "href": "…/konsert/<ULID>",
          "mediaType": "application/activity+json", "name": "Konsert" },
        { "type": "Hashtag", "name": "#konsert" }]
```

Two things were missing from the wire entirely: the RSVP state (interested/going/attended)
existed only in the generated Nynorsk opening sentence, and setlists did not federate at
all. Both were fixed on the origin at the same time (Gigowl's ADR 0026), which is why the
parser has a precedence chain rather than a single source.

## Decision

**Two tables, mirroring `neodb_marks` + `catalog_metadata`** (ADR 0008), plus caches for
the two catalogue entities a gig references.

- **`gig_attendances`** — the per-actor store, unique on **(`concert_url`, `actor_ap_id`)**:
  status + `status_source`, the write-up, the content warning, photos, hashtags, the Note's
  id/url/post id, `published_at`, `updated_at_ap`, `deleted_at`.
- **`gig_catalog`** — the shared per-concert cache, keyed on the normalised concert URL,
  with the date, status, tour/festival, notes, the venue denormalised for filtering, the
  line-up, the setlists and the usual `fetchedAt`/`enrichedAt`/`fetchError`/`fetchAttempts`
  bookkeeping plus `hiddenAt`.
- **`gig_artists` and `gig_venues`** — one row per catalogue entity, so an artist is shared
  across every gig they played and their MusicBrainz/Wikidata ids are available to join
  against the scrobble and NeoDB data already here.
- **Detection is structural.** A Note is an attendance iff its `tag` carries a `Link` named
  "Konsert" (or "Concert") with an href. An ordinary Note has no such tag and falls straight
  through to normal post ingestion, exactly as a non-mark Note does.
- **One ingest path, unchanged.** A single branch in `ingestObject`, beside the
  `isNeodbMark` block, so `Create`, `Announce` and `Update` all produce the same row
  (ADR 0011). `Delete` tombstones by Note id.
- **Enrichment dereferences the concert as ActivityPub**, then its venue and its artists,
  merging the page's schema.org `MusicEvent` only for fields the ActivityPub document left
  out. `source_map` records which half each field came from.
- **A local-first backfill** (`jobs/backfill-gigs.ts`) rebuilds the store from posts already
  stored, marker-guarded on startup plus `npm run backfill-gigs` and an admin button.
- **`get_gigs` / `get_gig_details` / `get_gig_stats`**, mirrored to REST, an admin tab, and
  the stream's own `gigs` lane with a `gig` card.

## Why the prose is read at all, when ADR 0008 says never to

ADR 0008's rule is that a mark's `content` is localized human copy and the title must come
from the structured `tag`. That rule stands and is not weakened here. What the gig parser
reads from `content` is different in kind:

- **The content is machine-generated from a template this project's sibling repo owns**
  (`konsert-activitypub/src/federation/note.ts`), not written by a person. It is four
  blocks — opening, write-up, link, hashtags — joined by a blank line, one `<p>` each.
- **It is read for exactly two things, both structural.** The RSVP state, by exact prefix
  match against the three generated openings; and which blocks are *not* the write-up, so
  the write-up is what remains. The link block is identified by equality with the concert
  URL and the hashtag block by its `class="hashtag"` anchors — nothing is matched on what
  it says.
- **It is a bridge, and it loses.** `resolveGigStatus` prefers the explicit `Oppmøte` Link
  tag, then `samklang:attendanceStatus`, and only then the prose. `status_source` records
  which won, so a caller can tell a stated fact from a derived one. Every attendance
  delivered before Gigowl's ADR 0026 has nothing else.
- **The title, artists, venue and date never come from it.** Those come from enrichment,
  which dereferences the concert.

An unrecognised opening yields `null`, never a guess: recording "wanted to go" as "went"
is worse than recording nothing.

## Why the gig date is a column of its own, separate from the start time

The origin omits the `Event`'s `startTime` entirely unless the venue has an IANA timezone
*and* the concert has a start time — true for a minority of a backfilled archive. A date
present for every gig is worth more than an instant present for a third of them, so
`gig_date` is authoritative for ordering and `start_at` is the precision when it exists.

## The traps (don't re-derive these)

- **`published` is when the gig was LOGGED, not when it happened.** The origin stamps a Note
  with the attendance's `updatedAt`, so an archive imported in one afternoon has 29 posts
  from that afternoon describing a decade of concerts. `gig_date` is the night;
  `logged_at` is the paperwork. Sorting a gig log by the post date buries the history under
  the day it was typed up — which is why `get_gigs` defaults to `gig_date` and the stream
  lane orders on it.
- **Never send an `Accept` header containing `text/html`.** The origin's `wantsActivityJson`
  returns HTML for *anything* mentioning it, deliberately, so a browser-ish header silently
  yields `<!DOCTYPE html>` and looks exactly like "this origin has no ActivityPub
  representation". `fetchApJson` says so in the error message for that reason.
- **`Event.tag` is a bare string with one artist and an array with several.** So are `tag`,
  `attachment` and `url` on most implementations. Anything reading one shape passes its
  tests and fails on real data.
- **Drizzle does not qualify a column reference in a select-list expression.** A correlated
  subquery written `a.concert_url = ${gigCatalog.concertUrl}` renders the right-hand side
  bare, where it binds to `gig_attendances.concert_url` — an always-true self-comparison
  with no error and a plausible response shape. This shipped once in `get_watched`'s
  `mark_comments` (ADR 0011) and shipped again here in `get_gig_stats`'s `gigs_with_review`,
  which reported every gig as having a write-up. Every such join is written table-qualified
  by hand and a test asserts the rendered SQL.
- **`hiddenAt` must stay out of the enrichment upsert's values object**, or every pass
  unhides the row (ADR 0013).
- **`song_count: null` means nobody recorded a setlist**, which is not the same as a gig
  with no songs. `top_songs` and `songs_played` are therefore "songs I have a record of",
  never "songs I heard", and both surfaces say so.
- **A column added to `gig_attendances` needs its own backfill.** The upsert overwrites only
  on a strictly-newer `updated_at_ap`, so replaying stored attendances — the obvious way to
  populate a new column — is a deliberate no-op for every unchanged row. The two null-fill
  exceptions (`status`, `review`) exist precisely because those two had to be fillable
  after the fact.
- **Moving `samklang` off the `posts` lane is load-bearing.** Lanes are disjoint by actor;
  leaving it on both would publish every gig twice in the merged stream.
