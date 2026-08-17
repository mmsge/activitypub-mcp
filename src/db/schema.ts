import {
  pgTable, text, uuid, timestamp, boolean, jsonb,
  bigserial, bigint, numeric, date, integer, index, uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const serverConfig = pgTable('server_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const actors = pgTable('actors', {
  id: uuid('id').primaryKey().defaultRandom(),
  apId: text('ap_id').notNull().unique(),
  handle: text('handle'),
  username: text('username'),
  domain: text('domain').notNull(),
  // Fediverse software running the origin server ('mastodon', 'pixelfed', 'bookwyrm',
  // 'loops', …), read from the server's NodeInfo. Lets callers map an account to its
  // service. Null until probed (NodeInfo unreachable or not yet backfilled).
  software: text('software'),
  displayName: text('display_name'),
  summary: text('summary'),
  iconUrl: text('icon_url'),
  publicKeyPem: text('public_key_pem').notNull(),
  inboxUrl: text('inbox_url').notNull(),
  sharedInboxUrl: text('shared_inbox_url'),
  followersUrl: text('followers_url'),
  followingUrl: text('following_url'),
  raw: jsonb('raw').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('actors_domain_idx').on(t.domain),
])

export const follows = pgTable('follows', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorApId: text('actor_ap_id').notNull().unique(),
  followActivityId: text('follow_activity_id'),
  status: text('status').notNull().default('pending'),
  followedAt: timestamp('followed_at', { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
})

export const activities = pgTable('activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  apId: text('ap_id').notNull().unique(),
  type: text('type').notNull(),
  actorApId: text('actor_ap_id').notNull(),
  objectApId: text('object_ap_id'),
  objectType: text('object_type'),
  raw: jsonb('raw').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processed: boolean('processed').notNull().default(false),
  processingError: text('processing_error'),
}, (t) => [
  index('activities_actor_idx').on(t.actorApId),
  index('activities_type_idx').on(t.type),
  index('activities_received_idx').on(t.receivedAt),
])

export const objects = pgTable('objects', {
  id: uuid('id').primaryKey().defaultRandom(),
  apId: text('ap_id').notNull().unique(),
  type: text('type').notNull(),
  actorApId: text('actor_ap_id').notNull(),
  content: text('content'),
  contentText: text('content_text'),
  summary: text('summary'),
  url: text('url'),
  inReplyTo: text('in_reply_to'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  updatedAtAp: timestamp('updated_at_ap', { withTimezone: true }),
  attachments: jsonb('attachments'),
  tags: jsonb('tags'),
  sensitive: boolean('sensitive').default(false),
  language: text('language'),
  raw: jsonb('raw').notNull(),
  searchVector: text('search_vector'),
  // Origin visibility ('public' | 'unlisted' | 'private' | 'unknown'), derived from
  // the object's ActivityStreams `to`/`cc` addressing. Generated, not written by the
  // ingest paths: all five of them rewrite `raw` through one upsert, so the column
  // recomputes on every create, edit and re-ingest and cannot drift out of step with
  // the data it describes. Only 'public' may be shown on meg.msge.no — 'unknown'
  // (no addressing we can read) deliberately is not. Mirrored by classifyVisibility()
  // in src/stream/visibility.ts. See ADR 0017.
  visibility: text('visibility').generatedAlwaysAs(
    sql`CASE
			WHEN "raw"->'to' @> '"https://www.w3.org/ns/activitystreams#Public"'::jsonb
				OR "raw"->'to' @> '"as:Public"'::jsonb
				OR "raw"->'to' @> '"Public"'::jsonb
				THEN 'public'
			WHEN "raw"->'cc' @> '"https://www.w3.org/ns/activitystreams#Public"'::jsonb
				OR "raw"->'cc' @> '"as:Public"'::jsonb
				OR "raw"->'cc' @> '"Public"'::jsonb
				THEN 'unlisted'
			WHEN "raw" ? 'to' OR "raw" ? 'cc'
				THEN 'private'
			ELSE 'unknown'
		END`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  index('objects_actor_idx').on(t.actorApId),
  index('objects_type_idx').on(t.type),
  index('objects_published_idx').on(t.publishedAt),
  index('objects_actor_published_idx').on(t.actorApId, t.publishedAt),
  index('objects_visibility_idx').on(t.visibility),
])

// Notes this actor wrote itself — the only content it ever publishes. Deliberately
// not part of `objects`: that table is the archive of *remote* posts, keyed by a
// remote actor, and every reading/music/film aggregation reads from it. Mixing our
// own output in there would quietly pollute Markus' archive.
export const localNotes = pgTable('local_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  // 'intro' — the pinned note explaining what this bot is; 'status' — a periodic
  // summary of the archive. One intro row at most; status rows accumulate.
  kind: text('kind').notNull(),
  content: text('content').notNull(),
  contentText: text('content_text').notNull(),
  // Fingerprint of the composed text. The publisher compares against it so an
  // unchanged status never posts twice and a reworded intro edits in place.
  digest: text('digest').notNull(),
  pinned: boolean('pinned').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('local_notes_published_idx').on(t.publishedAt),
  index('local_notes_kind_idx').on(t.kind),
])

export const bookwyrmObjects = pgTable('bookwyrm_objects', {
  id: uuid('id').primaryKey().defaultRandom(),
  objectApId: text('object_ap_id').notNull().unique(),
  bwType: text('bw_type').notNull(),
  bookTitle: text('book_title'),
  bookAuthor: text('book_author'),
  bookIsbn: text('book_isbn'),
  bookUrl: text('book_url'),
  rating: numeric('rating', { precision: 3, scale: 1 }),
  readingStatus: text('reading_status'),
  startDate: date('start_date'),
  finishDate: date('finish_date'),
  progress: integer('progress'),
  progressMode: text('progress_mode'),
  reviewContent: text('review_content'),
  raw: jsonb('raw').notNull(),
}, (t) => [
  index('bookwyrm_reading_status_idx').on(t.readingStatus),
  index('bookwyrm_actor_idx').on(t.objectApId),
])

// Per-edition book metadata, cached so the reading-stats aggregation has page
// counts / formats / years to roll up (the reading tools themselves derive their
// rows live from `objects`). Keyed by the BookWyrm Edition AP id — the same value
// every reading row carries as `bookwyrm_book_url` — so it joins straight onto the
// collapsed reading events. Primary source is the Edition AP object; `pageSource`
// records where `pages` ultimately came from when an ISBN fallback filled it in.
export const bookMetadata = pgTable('book_metadata', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookUrl: text('book_url').notNull().unique(), // Edition AP id — the join key
  workUrl: text('work_url'), // canonical Work id, for per-work dedup later
  title: text('title'),
  subtitle: text('subtitle'),
  // Display string, all authors joined with ", ". BookWyrm Editions carry authors
  // as AP URLs, so the enrichment job dereferences them to names at fetch time.
  author: text('author'),
  pages: integer('pages'),
  physicalFormat: text('physical_format'), // Paperback | Hardcover | GraphicNovel | AudiobookFormat | …
  isbn13: text('isbn13'),
  isbn10: text('isbn10'),
  pubYear: integer('pub_year'), // from publishedDate ?? firstPublishedDate
  language: text('language'), // normalized ISO-639-1 where known
  originalLanguage: text('original_language'),
  publisher: text('publisher'),
  series: text('series'),
  coverUrl: text('cover_url'),
  description: text('description'),
  subjects: jsonb('subjects'), // string[] — genres / subjects / categories
  pageSource: text('page_source'), // bookwyrm | review | openlibrary | googlebooks | override — source of `pages`
  isbnSource: text('isbn_source'), // bookwyrm | review | bookwyrm_object — where the resolved ISBN came from
  sourceMap: jsonb('source_map'), // { field: winning source } — provenance for every populated field
  raw: jsonb('raw').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  // Set when an admin hides the row: it stops being served by get_books/get_book_details
  // and drops out of the derived reading tools, without being deleted. A DELETE would not
  // stick — collectBookUrls re-derives its URL set from stored posts every pass and the
  // row would simply come back. See ADR 0013.
  hiddenAt: timestamp('hidden_at', { withTimezone: true }),
}, (t) => [
  index('book_metadata_book_url_idx').on(t.bookUrl),
  index('book_metadata_work_url_idx').on(t.workUrl),
  index('book_metadata_format_idx').on(t.physicalFormat),
  index('book_metadata_isbn13_idx').on(t.isbn13),
  index('book_metadata_hidden_idx').on(t.hiddenAt),
])

// BookWyrm shelf membership, per actor — the per-reader half of the split whose
// shared half is `book_metadata`. Same shape and same reason as neodb_marks vs
// catalog_metadata (ADR 0008): which shelf a book sits on is a fact about one
// reader; the edition's page count is a fact about the world.
//
// There is a second reason specific to books. sync-book-metadata's upsert does
// `set: values`, so any column added to that object is overwritten on every
// refresh — precisely the trap ADR 0013 records for `hidden_at`. A `shelf` column
// on book_metadata would walk into it again: a re-enrichment would blank the shelf
// and every downstream shelf filter would quietly lose the book.
//
// BookWyrm's four reading shelves are MUTUALLY EXCLUSIVE. Verified against
// @mvrkws@bookwyrm.social on 2026-08-16: read 408, to-read 30, stopped-reading 10,
// reading 3 — union 451, pairwise overlap 0 on all six pairs. So shelf is a scalar
// per (actor, book), which is why the key below is a unique pair rather than an
// (actor, book, shelf) triple.
//
// Post-derivation cannot replace this. A stop DOES federate as a GeneratedNote
// ("… stopped reading X"), but only 3 of the 10 stopped books have one in the
// archive. Posts record events that were witnessed; the shelf records the current
// truth, and only the shelf is complete.
export const bookwyrmShelfMarks = pgTable('bookwyrm_shelf_marks', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorApId: text('actor_ap_id').notNull(),
  // The Edition AP id — the same value book_metadata.book_url keys on. A shelf
  // collection's orderedItems are bare Edition objects whose `id` IS this URL, so
  // the two sides need no normalisation to line up.
  bookUrl: text('book_url').notNull(),
  // read | reading | to-read | stopped-reading, stored as BookWyrm's own URL slug —
  // verbatim rather than mapped, so a shelf added later lands in the table instead
  // of being coerced into one of these four or dropped.
  shelf: text('shelf').notNull(),
  // BookWyrm's `shelvedDate` when it sends one. As of 2026-08-16 it sends null for
  // every item on every one of the four shelves — checked, not assumed — so nothing
  // may be built on this column.
  shelvedDate: timestamp('shelved_date', { withTimezone: true }),
  // firstSeenAt survives a shelf move; syncedAt is bumped by every pull that still
  // finds the book. The pair is what makes "he put this down in March" answerable
  // at all, given shelvedDate is empty — though it dates OUR first sighting, not
  // his shelving.
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  // Set when a pull that is VERIFIED COMPLETE no longer finds the book on any of
  // the actor's shelves. Soft, like neodb_marks.deleted_at and framfor's
  // missing_since, and for the reason framfor's missing-sweep guard exists: a
  // truncated pull and an emptied shelf look identical from the database's side.
  // Here we can do better than a percentage heuristic, because BookWyrm hands us
  // the exact expected count — see the sync job's completeness gate.
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('bookwyrm_shelf_marks_actor_book_idx').on(t.actorApId, t.bookUrl),
  index('bookwyrm_shelf_marks_book_url_idx').on(t.bookUrl),
  index('bookwyrm_shelf_marks_actor_idx').on(t.actorApId),
  // The serving predicate is "a live row on shelf X", so the partial index carries
  // exactly that and not the tombstones. Same shape, same argument, as framfor's
  // items_arena_eligible.
  index('bookwyrm_shelf_marks_live_idx').on(t.shelf, t.bookUrl).where(sql`removed_at IS NULL`),
])

// Per-title metadata for every NeoDB catalog item behind a federated mark, cached
// so callers get the ids/creators/details the marks don't carry inline. A NeoDB
// mark ("finished watching …", "played …", "listened to …") federates as a plain
// Note whose only structured hook is a bare tag
// { type: "TVSeason"|"Movie"|"Album"|"Game"|"Podcast"|"Performance"|"Edition"|…,
//   href: <catalog url>, name, image } — the NeoDB catalog URL and a poster, no
// creator/year/ids. Keyed by that catalog URL (the tag href) and filled by
// sync-neodb-metadata, which dereferences the item (Accept: application/activity+json)
// for the full record. Common fields are columns; category-specific fields live in
// `details` (author/isbn/pages for book, artist/release_date/track_count for music,
// developer/platform for game, host/feed_url for podcast, playwright/venue for
// performance, …) so an unknown or newly-added category still stores cleanly.
// `sourceMap` records each field's origin ('neodb', or 'bookwyrm' for a book field
// deduped against the book_metadata cache), mirroring get_book_details. The
// screen-media analogue of book_metadata (ADR 0003); see ADR 0005 (film/TV) and
// ADR 0006 (all categories + retry + book dedup).
export const catalogMetadata = pgTable('catalog_metadata', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemUrl: text('item_url').notNull().unique(), // NeoDB catalog url — the tag href / join key
  category: text('category'), // tv | movie | book | music | game | podcast | performance | …
  itemType: text('item_type'), // AP object type: Movie | TVShow | TVSeason | TVEpisode | Edition | Album | Game | Podcast | Performance | …
  title: text('title'),
  displayTitle: text('display_title'),
  origTitle: text('orig_title'),
  description: text('description'),
  coverUrl: text('cover_url'),
  imdb: text('imdb'), // bare IMDb id, e.g. tt27579939 (film/TV only)
  imdbUrl: text('imdb_url'),
  tmdbUrl: text('tmdb_url'),
  externalResources: jsonb('external_resources'), // [{ url }]
  year: integer('year'),
  seasonNumber: integer('season_number'),
  episodeCount: integer('episode_count'),
  genre: jsonb('genre'), // string[]
  director: jsonb('director'), // string[] (film/TV; performance director lives in details)
  actors: jsonb('actors'), // string[]
  language: jsonb('language'), // string[]
  area: jsonb('area'), // string[]
  rating: numeric('rating', { precision: 3, scale: 1 }),
  parentUuid: text('parent_uuid'),
  // Category-specific fields normalized per category ({} for unknown categories).
  details: jsonb('details'),
  // string[] — distinct tag names from every stored mark referencing this item
  // (ActivityPub-supplied aliases; accumulates). NeoDB enrichment overwrites the
  // title with the localized name, so the name a mark federated with (e.g. "Conflict"
  // vs the stored "Konflikt") is retained here and searched alongside `title`.
  markTitles: jsonb('mark_titles'),
  // { field: 'neodb' | 'bookwyrm' | 'activitypub' } — provenance for every populated
  // field. 'activitypub' marks the mark-supplied `mark_titles` aliases.
  sourceMap: jsonb('source_map'),
  // For a NeoDB `book` mark whose ISBN matches a cached BookWyrm Edition: the
  // book_metadata.book_url it dedupes to (so the same physical book isn't a
  // divergent second record). Null for every non-book / unmatched item.
  bookwyrmBookUrl: text('bookwyrm_book_url'),
  raw: jsonb('raw').notNull(),
  // Enrichment bookkeeping. `enrichedAt` is the last SUCCESSFUL fetch (null until a
  // fetch succeeds) and drives the staleness window; `fetchedAt` is the last write
  // of any kind (success or recorded failure) so ordering always has a value.
  // A failed fetch records `fetchError` + bumps `fetchAttempts` instead of vanishing,
  // so it's visible and retried — never silently dropped.
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  enrichedAt: timestamp('enriched_at', { withTimezone: true }),
  fetchError: text('fetch_error'),
  fetchAttempts: integer('fetch_attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  // Set when an admin hides the row: it stops being served by get_watched and
  // get_catalogue_details, without being deleted. Deleting does not stick —
  // collectNeodbTagHrefs re-derives its URL set from the stored marks every pass, so the
  // row reappears within the enrichment cycle. Hiding is also deliberately NOT part of
  // the upsert's values object: see ADR 0013 for why adding it there would unhide the row
  // on every refresh.
  hiddenAt: timestamp('hidden_at', { withTimezone: true }),
}, (t) => [
  index('catalog_metadata_item_url_idx').on(t.itemUrl),
  index('catalog_metadata_category_idx').on(t.category),
  index('catalog_metadata_imdb_idx').on(t.imdb),
  index('catalog_metadata_bookwyrm_idx').on(t.bookwyrmBookUrl),
  index('catalog_metadata_hidden_idx').on(t.hiddenAt),
])

// One row per NeoDB "mark" (a watched/read/shelved event) from a followed actor —
// the per-actor, per-item store that criterion 2 describes. A mark federates as a
// plain `Note` carrying NeoDB's Mastodon-compatible `status` extension:
//   relatedWith: { type:'Status', status:<verb>, withRegardTo:<catalog url>, updated, … }
//   tag:         { type:'Movie'|'TVSeason'|'Edition'|…, href:<catalog url>, name, image }
// The Note's prose (`content`) is human copy ("blev færdig med at se …") and is never
// scraped — every field here comes from the structured `relatedWith`/`tag`. `itemUrl`
// is the normalised catalog URL (trailing slash + `~neodb~` segment stripped), the same
// value catalog_metadata keys on, so the two join: catalog_metadata is the shared
// per-title enrichment cache, neodb_marks the per-actor mark history. Keyed unique on
// (item_url, actor_ap_id); a re-received mark upserts the existing row (guarded on
// `updated_at_ap` so an older/equal redelivery is a no-op). A Delete of the mark's Note
// tombstones the row via `deleted_at` (matched on mark_ap_id) so get_watched drops it.
// See the ingestion story / ADR 0008.
export const neodbMarks = pgTable('neodb_marks', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Normalised NeoDB catalog URL (relatedWith.withRegardTo / tag.href) — the join key
  // onto catalog_metadata.item_url.
  itemUrl: text('item_url').notNull(),
  // The marking actor (the Note's attributedTo / the delivering actor).
  actorApId: text('actor_ap_id').notNull(),
  // AP object type from the tag (Movie | TVShow | TVSeason | TVEpisode | Edition | Album
  // | Game | Podcast | Performance | …) and the NeoDB category it maps to (movie | tv |
  // book | music | game | podcast | performance | …).
  itemType: text('item_type'),
  category: text('category'),
  // Canonical shelf status mapped from the NeoDB verb (wishlist | progress | complete |
  // dropped), plus the verb verbatim so an unknown one is never lost.
  status: text('status'),
  statusRaw: text('status_raw'),
  title: text('title'), // tag.name — the name the mark federated with
  coverUrl: text('cover_url'), // tag.image
  // The user's own note on the mark (the `relatedWith` Comment entry), verbatim: free
  // text, never parsed, normalised or translated. It carries things the catalogue cannot
  // know — "Sett på kino." records where a film was seen — so it is a first-class field,
  // surfaced and filterable, not just provenance in `raw`.
  comment: text('comment'),
  // The mark Note's own id (the Delete target) and human URL, plus the origin-local post id.
  markApId: text('mark_ap_id'),
  markUrl: text('mark_url'),
  postId: text('post_id'),
  publishedAt: timestamp('published_at', { withTimezone: true }), // the mark Note's own published — when the mark was created
  updatedAtAp: timestamp('updated_at_ap', { withTimezone: true }), // relatedWith.updated — change-tracking guard
  // The shelf date — when the thing was actually watched/read/played/listened to — taken
  // strictly from the `relatedWith` Status entry's `published`. Distinct from both columns
  // above: a backdated mark is created today (`published_at`), last edited today
  // (`updated_at_ap`) and watched in 2016 (`watched_at`). Null when the mark carries none.
  watchedAt: timestamp('watched_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // set when the mark's Note is deleted
  raw: jsonb('raw'), // the relatedWith + tag we parsed, for provenance
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('neodb_marks_item_actor_idx').on(t.itemUrl, t.actorApId),
  index('neodb_marks_item_url_idx').on(t.itemUrl),
  index('neodb_marks_actor_idx').on(t.actorApId),
  index('neodb_marks_mark_ap_id_idx').on(t.markApId),
  index('neodb_marks_status_idx').on(t.status),
  // get_watched filters and sorts on the shelf date ("everything I watched in 2016").
  index('neodb_marks_watched_at_idx').on(t.watchedAt),
])

// ─── gigs (Gigowl / gigowl.social) ──────────────────────────────────────────────────
//
// The same two-part split the NeoDB tables use, for the same reason: `gig_attendances`
// is the per-actor event store (one row per person per concert — who went, what they
// wrote, which photos), and `gig_catalog` is the shared per-concert cache everything
// joins to. A concert is a fact about the world; going to it is a fact about a person.
//
// An attendance federates as a plain `Note` whose `tag` carries a `Link` named "Konsert"
// pointing at the concert's canonical URI. That URI is dereferenceable as an AS2 `Event`
// and is the join key. See ADR 0037, and Gigowl's own ADR 0006 / 0025 for the wire format.

// One row per attendance from a followed actor, keyed unique on (concert_url, actor_ap_id).
// A re-received attendance upserts, guarded on a strictly-newer `updated_at_ap`; a Delete
// of the Note tombstones the row via `deleted_at`.
export const gigAttendances = pgTable('gig_attendances', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Normalised Gigowl concert URL — the join key onto gig_catalog.concert_url.
  concertUrl: text('concert_url').notNull(),
  actorApId: text('actor_ap_id').notNull(),
  // interested | going | attended, plus the verb verbatim so an unknown one is never lost.
  status: text('status'),
  statusRaw: text('status_raw'),
  // Where `status` came from: 'tag' (the explicit Oppmøte/Attendance Link tag), 'property'
  // (samklang:attendanceStatus, present only on a dereferenced Note) or 'template' (an
  // exact prefix match on the generated opening line, in either of the two languages the
  // origin has generated it in — the only source the attendances delivered before Gigowl's
  // ADR 0026 have). Null when none of the three yielded anything, which is deliberately
  // preferred over a guess.
  statusSource: text('status_source'),
  // The write-up, verbatim: free text, never parsed, normalised or translated.
  review: text('review'),
  contentWarning: text('content_warning'),
  hashtags: jsonb('hashtags'), // string[] — '#konsert' plus one per headliner
  photos: jsonb('photos'), // [{ url, mediaType, altText, width, height }]
  noteApId: text('note_ap_id'), // the attendance Note's id — the Delete target
  noteUrl: text('note_url'),
  postId: text('post_id'),
  // The Note's own `published`. Gigowl sets it to the attendance's updatedAt, so this is
  // when the gig was LOGGED, never when it happened — a 2022 gig entered in 2026
  // publishes in 2026. The night itself is gig_catalog.gig_date. Do not conflate them.
  publishedAt: timestamp('published_at', { withTimezone: true }),
  updatedAtAp: timestamp('updated_at_ap', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  raw: jsonb('raw'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('gig_attendances_concert_actor_idx').on(t.concertUrl, t.actorApId),
  index('gig_attendances_concert_idx').on(t.concertUrl),
  index('gig_attendances_actor_idx').on(t.actorApId),
  index('gig_attendances_note_ap_id_idx').on(t.noteApId),
  index('gig_attendances_status_idx').on(t.status),
])

// The per-concert cache, keyed by the concert's canonical URL. Filled by
// sync-gig-metadata, which dereferences the concert as ActivityPub (never with an Accept
// header containing text/html — Gigowl answers HTML for anything ambiguous) and merges the
// schema.org MusicEvent from the page as a fallback for an origin older than Gigowl's
// ADR 0026. `sourceMap` records each field's origin, mirroring catalog_metadata.
export const gigCatalog = pgTable('gig_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  concertUrl: text('concert_url').notNull().unique(),
  title: text('title'), // the composite "Artist, Venue, City, DATE" the origin renders
  // The night of the gig. Always present once enriched, unlike `startAt`: the AP Event
  // omits its startTime entirely unless the venue has an IANA zone AND the concert a
  // start time, which most of the archive does not. This is the sort and filter key.
  gigDate: date('gig_date'),
  startAt: timestamp('start_at', { withTimezone: true }),
  doorsTime: text('doors_time'), // local wall clock, in the venue's zone
  // scheduled | cancelled | postponed | completed. 'completed' has no schema.org
  // equivalent, so it is readable only from the ActivityPub representation.
  concertStatus: text('concert_status'),
  tourName: text('tour_name'),
  festivalName: text('festival_name'),
  notes: text('notes'),
  venueUrl: text('venue_url'), // join key onto gig_venues.venue_url
  // Denormalised from the venue so the common filters ("gigs in Bergen") need no join.
  venueName: text('venue_name'),
  venueCity: text('venue_city'),
  venueCountry: text('venue_country'),
  // [{ artistUrl, name, role, position }] — role is headliner | opener | guest.
  lineup: jsonb('lineup'),
  // string[] of the lineup names, flat, so "every gig I saw Motorpsycho at" is one ILIKE
  // over a jsonb array rather than a join through gig_artists. The mark_titles trick.
  artistNames: jsonb('artist_names'),
  // [{ id, artist, entries: [{ position, setNumber, isEncore, songTitle, isCover,
  // coverOfArtist, note }] }]. Empty until the origin serves them (Gigowl ADR 0026).
  setlists: jsonb('setlists'),
  songCount: integer('song_count'),
  details: jsonb('details'),
  sourceMap: jsonb('source_map'), // { field: 'samklang-ap' | 'samklang-jsonld' }
  raw: jsonb('raw'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  enrichedAt: timestamp('enriched_at', { withTimezone: true }),
  fetchError: text('fetch_error'),
  fetchAttempts: integer('fetch_attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  // Set when an admin hides the row. Deliberately NOT part of the enrichment upsert's
  // values object — including it there would unhide the row on every refresh (ADR 0013).
  hiddenAt: timestamp('hidden_at', { withTimezone: true }),
}, (t) => [
  index('gig_catalog_gig_date_idx').on(t.gigDate),
  index('gig_catalog_venue_idx').on(t.venueUrl),
  index('gig_catalog_city_idx').on(t.venueCity),
  index('gig_catalog_hidden_idx').on(t.hiddenAt),
])

// The artist cache. Its own table rather than only the `lineup` blob because an artist is
// shared across every gig they played, and their external ids (MusicBrainz, Wikidata) are
// what let a gig join up with the scrobble and NeoDB data already here.
export const gigArtists = pgTable('gig_artists', {
  id: uuid('id').primaryKey().defaultRandom(),
  artistUrl: text('artist_url').notNull().unique(),
  name: text('name'),
  sortName: text('sort_name'),
  disambiguation: text('disambiguation'),
  artistType: text('artist_type'), // person | group | other
  country: text('country'),
  mbid: text('mbid'),
  wikidataQid: text('wikidata_qid'),
  beginYear: integer('begin_year'),
  endYear: integer('end_year'),
  imageUrl: text('image_url'),
  imageAttribution: text('image_attribution'),
  sourceMap: jsonb('source_map'),
  raw: jsonb('raw'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  enrichedAt: timestamp('enriched_at', { withTimezone: true }),
  fetchError: text('fetch_error'),
  fetchAttempts: integer('fetch_attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
}, (t) => [
  index('gig_artists_name_idx').on(t.name),
  index('gig_artists_mbid_idx').on(t.mbid),
])

// The venue cache. Same shape, same reasons.
export const gigVenues = pgTable('gig_venues', {
  id: uuid('id').primaryKey().defaultRandom(),
  venueUrl: text('venue_url').notNull().unique(),
  name: text('name'),
  aka: jsonb('aka'), // string[] — venues get renamed by sponsors
  city: text('city'),
  country: text('country'), // ISO 3166-1 alpha-2
  latitude: numeric('latitude'),
  longitude: numeric('longitude'),
  capacity: integer('capacity'),
  timezone: text('timezone'), // IANA
  wikidataQid: text('wikidata_qid'),
  // The origin's "venue not announced yet" placeholder. A gig at one has a genuinely
  // unknown venue, which is a different thing from missing data.
  isPlaceholder: boolean('is_placeholder').notNull().default(false),
  sourceMap: jsonb('source_map'),
  raw: jsonb('raw'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  enrichedAt: timestamp('enriched_at', { withTimezone: true }),
  fetchError: text('fetch_error'),
  fetchAttempts: integer('fetch_attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
}, (t) => [
  index('gig_venues_name_idx').on(t.name),
  index('gig_venues_city_idx').on(t.city),
])

// Full markdown bodies of the markus.plus "Tankehav" notes, fetched from Obsidian
// Publish's /access/ endpoint by sync-garden-content. The origin is flaky (500s on
// edge-cache misses have been observed for extended periods), so content persists
// here and only a successful 200 ever overwrites it; failures just record
// fetch_error and are retried on later cycles.
export const gardenNotes = pgTable('garden_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourcePath: text('source_path').notNull().unique(), // vault path == cache-doc key, e.g. "_publish/Personleg/Om meg.md"
  path: text('path').notNull(), // permalink path, e.g. "/meg"; "/" for the home note
  title: text('title').notNull(),
  content: text('content'), // raw markdown incl. frontmatter; null until first successful fetch
  // The note's own date and tags, from its `dato`/`modified`/`anskaffet` frontmatter.
  // Text, not `date`: these are hand-written and of varying precision ("2024",
  // "2024-03-11"), and many notes carry none at all. The public stream parses what it
  // can and skips what it cannot — an unparseable value must never block the sync.
  noteDate: text('note_date'),
  noteTags: jsonb('note_tags'), // string[] — frontmatter tags, '#' stripped
  // The `bookwyrm` frontmatter field on a book review: the BookWyrm Edition URL,
  // i.e. book_metadata.book_url. Stored so the date derivation is a column join.
  bookUrl: text('book_url'),
  // A date recovered from that book's reading events for a note that carries none
  // of its own (jobs/derive-garden-dates.ts). Kept apart from note_date on purpose:
  // one is what the note says, the other is what we worked out, and the page says
  // which. Merging them would make the provenance unrecoverable.
  derivedDate: timestamp('derived_date', { withTimezone: true }),
  etag: text('etag'), // verbatim ETag header from the last 200
  lastModified: text('last_modified'), // verbatim Last-Modified header from the last 200
  fetchedAt: timestamp('fetched_at', { withTimezone: true }), // last successful content fetch (200)
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }), // last attempt of any outcome (200/304/failure)
  fetchError: text('fetch_error'), // last failure ("HTTP 500", network message); null after 200/304
  failCount: integer('fail_count').notNull().default(0), // consecutive failures; reset on 200/304
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // set when the note leaves the cache doc; cleared on return
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('garden_notes_path_idx').on(t.path),
  index('garden_notes_note_date_idx').on(t.noteDate),
  index('garden_notes_book_url_idx').on(t.bookUrl),
  index('garden_notes_derived_date_idx').on(t.derivedDate),
])

export const deliveryQueue = pgTable('delivery_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  inboxUrl: text('inbox_url').notNull(),
  payload: jsonb('payload').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('delivery_queue_next_attempt_idx').on(t.nextAttemptAt),
])

export const activityLog = pgTable('activity_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  direction: text('direction').notNull(),
  method: text('method').notNull(),
  url: text('url').notNull(),
  requestHeaders: jsonb('request_headers'),
  requestBody: text('request_body'),
  responseStatus: integer('response_status'),
  responseBody: text('response_body'),
  signatureValid: boolean('signature_valid'),
  error: text('error'),
  actorApId: text('actor_ap_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('activity_log_created_idx').on(t.createdAt),
  index('activity_log_actor_idx').on(t.actorApId),
  index('activity_log_direction_idx').on(t.direction),
])

/**
 * One play, mirrored from Last.fm's user.getrecenttracks.
 *
 * `played_at` (and its raw `uts`) is the moment the track **started**, per the
 * scrobbler that submitted it — not the submission time and not our poll time. So a
 * row's real play length is bounded by the NEXT row's `played_at`, and nothing on the
 * row itself says how long it actually played.
 *
 * This table is deliberately a faithful mirror: whatever Last.fm counts, it counts.
 * A scrobbler that submits at track start turns restarts and skips into ordinary
 * scrobbles, which is why the same song can appear three times in sixteen seconds.
 * Those rows are upstream truth, not ingest noise — see `scrobble-audit` for how to
 * measure them, and decision record 0030 for why they are not filtered out here.
 */
export const scrobbles = pgTable('scrobbles', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackName: text('track_name').notNull(),
  artistName: text('artist_name').notNull(),
  artistMbid: text('artist_mbid'),
  albumName: text('album_name'),
  albumMbid: text('album_mbid'),
  trackMbid: text('track_mbid'),
  trackUrl: text('track_url'),
  imageUrl: text('image_url'),
  playedAt: timestamp('played_at', { withTimezone: true }).notNull(),
  uts: bigint('uts', { mode: 'number' }).notNull(),
  loved: boolean('loved').notNull().default(false),
  raw: jsonb('raw').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('scrobbles_played_idx').on(t.playedAt),
  index('scrobbles_artist_idx').on(t.artistName),
  index('scrobbles_album_idx').on(t.albumName),
  index('scrobbles_track_idx').on(t.trackName),
  index('scrobbles_uts_idx').on(t.uts),
  // Last.fm has no stable scrobble id; this composite is the dedupe key.
  uniqueIndex('scrobbles_dedupe_idx').on(t.playedAt, t.trackName, t.artistName),
])

// Watcher state for the head-to-head scrobble race (see src/lib/scrobble-race.ts).
// One row per artist pairing, so re-pointing RACE_* at a different pair starts a
// fresh race instead of inheriting the old one's fired milestones.
export const scrobbleRaceState = pgTable('scrobble_race_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  leaderArtist: text('leader_artist').notNull(),
  challengerArtist: text('challenger_artist').notNull(),
  leaderPlays: integer('leader_plays').notNull(),
  challengerPlays: integer('challenger_plays').notNull(),
  // Tightest milestone already announced. Ratchets downward only — the leader
  // pulling ahead again must not re-announce a milestone already spent.
  lastMilestone: integer('last_milestone'),
  // Gap at the last per-play (endgame) alert, so a sync with nothing new stays quiet.
  lastAnnouncedGap: integer('last_announced_gap'),
  // When the gap was first observed inside the countdown band (RACE_COUNTDOWN_GAP).
  // Latches: once set it never clears, so the leader pulling back out of the band does
  // not report the race as no longer in its endgame. Surfaced as endgame_armed.
  endgameArmedAt: timestamp('endgame_armed_at', { withTimezone: true }),
  // Set once, when the challenger draws level or goes ahead. Its presence makes the
  // watcher inert: the race is run, and later plays are just plays.
  overtakenAt: timestamp('overtaken_at', { withTimezone: true }),
  // The now-playing track the predictive alert already fired for, so a four-minute
  // song doesn't produce an alert on every poll. The timestamp re-arms it after a
  // while, so genuinely putting the same song on again does alert again.
  lastNowPlayingKey: text('last_nowplaying_key'),
  lastNowPlayingAt: timestamp('last_nowplaying_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('scrobble_race_pair_idx').on(t.leaderArtist, t.challengerArtist),
])

/**
 * One YouTube watch event, ingested from a Google Takeout-shaped `watch-history.json`.
 *
 * **`watched_at_local` is the authority; `watched_at` is derived.** The source records a
 * bare local wall clock — Europe/Oslo, no offset, minute resolution, seconds always `00`.
 * A naive parse would read it as UTC and shift every row by an hour or two, so the wall
 * clock is stored verbatim in a `timestamp` (no tz) and the instant is computed from it at
 * insert with `AT TIME ZONE 'Europe/Oslo'`, the same two-column shape `train_trips` uses
 * for `departure_local` / `departure_at`. Calendar work (year/month/hour-of-day buckets,
 * `from`/`to`/`year` filters) reads the local column so a bucket is never offset-shifted;
 * ordering and keyset pagination read the instant. See decision record 0047.
 *
 * The source carries no offset, so a watch in the repeated hour of the autumn fall-back
 * resolves to the earlier instant. That costs at most one collapsed row per year, and only
 * if the same video was watched twice inside that repeated minute.
 *
 * **`duration_seconds` is the VIDEO's length, not how much of it was watched.** Neither
 * Takeout nor My Activity records watch duration anywhere — only that the video was
 * opened. Every "hours watched" figure derived from this column is a strict upper bound,
 * which is why `get_youtube_stats` returns three differently-qualified estimates rather
 * than one number.
 *
 * **`unresolved` is terminal.** It marks a deleted, private or otherwise unavailable video
 * — no title, no channel — and a future enrichment pass must never retry these, or it will
 * spend its quota on ~11 % of the archive forever.
 *
 * Deliberately NOT the place for enrichment. Category, tags and canonical channel metadata
 * are properties of a video, of which there are ~92k behind ~96k watches; they belong in a
 * future `youtube_videos` table keyed on `video_id` and joined at query time, not
 * denormalised across every watch row. `video_id` is indexed to be that join key.
 */
export const youtubeWatches = pgTable('youtube_watches', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Which Google account watched it. Plain text, not an enum: a third account must not
  // need a migration.
  account: text('account').notNull(),
  videoId: text('video_id').notNull(), // the 11-char id — the video's identity
  videoUrl: text('video_url').notNull(), // `titleUrl` verbatim
  watchedAtLocal: timestamp('watched_at_local').notNull(),
  watchedAt: timestamp('watched_at', { withTimezone: true }).notNull(),
  title: text('title'), // "Watched " prefix stripped; null when unresolved
  channelName: text('channel_name'), // null when unresolved
  channelId: text('channel_id'), // UC… from the subtitle URL; null for @handle URLs
  durationSeconds: integer('duration_seconds'),
  unresolved: boolean('unresolved').notNull().default(false),
  // Provenance: 'myactivity-console' for the My Activity scrape, something else for a
  // real Takeout export. Kept verbatim so a merged file's rows stay distinguishable.
  source: text('source').notNull(),
  raw: jsonb('raw').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('youtube_watches_watched_idx').on(t.watchedAt),
  index('youtube_watches_watched_local_idx').on(t.watchedAtLocal),
  index('youtube_watches_account_idx').on(t.account),
  index('youtube_watches_channel_idx').on(t.channelId),
  index('youtube_watches_channel_name_idx').on(t.channelName),
  index('youtube_watches_video_idx').on(t.videoId),
  index('youtube_watches_duration_idx').on(t.durationSeconds),
  // Takeout has no watch id, so (account, video, wall-clock minute) is the natural key.
  // All three parts are load-bearing: a video is legitimately rewatched (one of them 24
  // times), a single minute legitimately holds up to 31 DIFFERENT videos because minute
  // resolution plus rapid Shorts scrolling collide, and two accounts can hold the same
  // video in the same minute. Dropping any part of the key discards real watch events.
  uniqueIndex('youtube_watches_dedupe_idx').on(t.account, t.videoId, t.watchedAtLocal),
])

/**
 * One row per distinct VIDEO behind the watch history — the table `youtube_watches`
 * reserved its `video_id` index for. ~92k rows behind ~96k watches; 3,530 videos were
 * watched more than once, so a per-watch flag would be both redundant and inconsistent.
 *
 * It exists to answer one question the archive cannot: is this a Short? See ADR 0049 for
 * the rules; the short version is that a flat "under three minutes" test mislabels about
 * 10 % of what it catches, because Shorts did not exist before September 2020 and the
 * ceiling was 60 seconds until 15 October 2024.
 *
 * **The classification is tri-state with provenance, and the two null states are not the
 * same thing.** `is_short_method` is what tells them apart:
 *
 *   | `is_short`     | `is_short_method` | meaning                                        |
 *   |----------------|-------------------|------------------------------------------------|
 *   | `false`        | `duration_rule`   | certain, decided offline from duration + date  |
 *   | `false`        | `api_metadata`    | certain, decided against the real upload date  |
 *   | `true`/`false` | `probe`           | verified against YouTube                        |
 *   | `null`         | `unclassifiable`  | **terminal** — no duration, no working URL      |
 *   | `null`         | `null`            | pending — still ambiguous, awaiting a stage     |
 *
 * `unclassifiable` covers the ~10.7k deleted and private videos and must NEVER be retried:
 * that is the same terminal rule `youtube_watches.unresolved` records, and reopening it
 * would spend the daily quota re-asking about 11 % of the archive forever. Exhausting
 * `is_short_attempts` is deliberately NOT the same state — a fetch that kept failing keeps
 * a null method and is simply not selected, so re-arming it is a matter of resetting the
 * counter rather than reasoning about which nulls are real.
 *
 * The bookkeeping columns mirror `catalog_metadata`'s (`fetched_at` / `fetch_attempts` /
 * `fetch_error`) rather than inventing a second convention, but the work queue is selected
 * in SQL ordered by fewest attempts first, the way `sync-stations.ts` does it. The NeoDB
 * job's JS-side set difference over an unordered list can starve — a permanently-failing
 * prefix is retried forever while the rest never come up — and that must not be copied.
 *
 * The stage 1 metadata below is persisted rather than thrown away. Classification only
 * needs `published_at` and `duration_seconds`, but the call returns the rest for free and
 * the year-in-review work will want it.
 */
export const youtubeVideos = pgTable('youtube_videos', {
  videoId: text('video_id').primaryKey(), // the 11-char id — matches youtube_watches.video_id
  // Tri-state. Nullable boolean rather than an enum because the tools already serve
  // `is_short` as boolean | null and a third representation would be one too many.
  isShort: boolean('is_short'),
  isShortMethod: text('is_short_method'), // duration_rule | api_metadata | probe | unclassifiable
  // Last time ANY stage looked at this row, verdict or not. Null means never examined, which
  // is how stage 0 finds its work — so a video arriving in a future import is picked up with
  // no special casing, and a second run over a settled archive reads an empty index.
  isShortCheckedAt: timestamp('is_short_checked_at', { withTimezone: true }),
  isShortAttempts: integer('is_short_attempts').notNull().default(0),
  isShortError: text('is_short_error'),

  // ── videos.list(part=snippet,contentDetails) ──────────────────────────────────
  // The real upload date. This is the whole reason stage 1 works: the archive knows when a
  // video was WATCHED, and only the upload date makes the era rules exact rather than
  // bounded from above.
  publishedAt: timestamp('published_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds'), // authoritative, from contentDetails
  title: text('title'),
  channelId: text('channel_id'),
  channelTitle: text('channel_title'),
  categoryId: text('category_id'),
  apiFetchedAt: timestamp('api_fetched_at', { withTimezone: true }),
  // videos.list returned no entry for this id: deleted, private, or region-blocked. The API
  // omits such ids silently rather than erroring, so absence from the response is the only
  // signal, and it has to be recorded or the id looks merely unfetched.
  apiMissing: boolean('api_missing').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('youtube_videos_is_short_idx').on(t.isShort),
  index('youtube_videos_method_idx').on(t.isShortMethod),
  // Stage 0's work queue: everything never examined. Partial, so it is empty once the
  // archive is settled and "safe to run when there is nothing to do" costs one index probe.
  index('youtube_videos_unexamined_idx').on(t.videoId).where(sql`${t.isShortCheckedAt} IS NULL`),
  // Stage 1 and 2's work queue: everything without a verdict, fewest attempts first. The
  // partial predicate is what makes "never retry the unclassifiable" free rather than a
  // condition someone could forget to write.
  index('youtube_videos_pending_idx').on(t.isShortAttempts, t.videoId).where(sql`${t.isShortMethod} IS NULL`),
])

// Point-in-time favourite/boost/reply counts for public statuses, read live from
// each status's ORIGIN instance by the get_engagement tool (REST /api/v1/statuses/:id
// first, ActivityPub collection totals as fallback). One row per successful read,
// unless skip_unchanged suppressed a write identical to the latest row. Counts are
// eventually-consistent and can go DOWN (un-favourite / undo-boost) — negative
// deltas between snapshots are correct, not corruption.
export const engagementSnapshots = pgTable('engagement_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  statusApId: text('status_ap_id').notNull(), // canonical AP object id (REST `uri` / AP `id`)
  statusId: text('status_id').notNull(), // origin-local id (Mastodon snowflake, GtS ULID, …)
  origin: text('origin').notNull(), // origin hostname, lowercase
  favourites: integer('favourites').notNull(),
  reblogs: integer('reblogs').notNull(),
  replies: integer('replies').notNull(),
  quotes: integer('quotes'), // null when the origin doesn't report quotes_count
  source: text('source').notNull(), // 'rest' | 'ap' — AP-sourced counts can under-report
  sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('engagement_snapshots_status_sampled_idx').on(t.statusApId, t.sampledAt),
  // Secondary match key: every ref form (permalink / AP id / bare id) normalises to
  // (origin, status_id) offline, so trends can find rows even when the canonical AP
  // id can't be re-synthesized from the caller's ref (non-Mastodon software).
  index('engagement_snapshots_origin_status_idx').on(t.origin, t.statusId),
])

// Per-post state for the breakout notifier: which posts have been announced as doing
// unusually well, and how far up the ladder each one got. See decision record 0036.
//
// One row per post, not per (post, rung) — the rungs are a ladder, and `rung` only
// ever ratchets upward, so a post that has already taken the record cannot announce
// "past your p90" again however the numbers move afterwards.
//
// Four things here would look like dead weight to a later cleanup, and all four are
// load-bearing:
//
//   `peakScore`, not `score`, is what the ladder is evaluated against. Engagement
//   counts go DOWN — engagement_snapshots says so in its own comment — and an
//   un-favourite must not be able to un-fire a rung, re-arm one, or lower the personal
//   best every other post is measured against. `score` is still stored because the
//   divergence between "doing now" and "peaked at" is the interesting part.
//
//   the three *At columns are nullable, and stay NULL when a rung was pre-marked at
//   SEED time rather than announced. That distinction is the only reason switching the
//   feature on does not replay a year of history into his phone: the first sighting of
//   a post records where it already is and says nothing.
//
//   `weightsKey` fingerprints the BREAKOUT_WEIGHT_* values. Changing a weight
//   re-scores the whole archive at once; comparing the key lets that be a silent
//   re-seed instead of fifty posts appearing to break out in the same minute.
//
//   there is no foreign key to objects.ap_id, matching engagement_snapshots: a
//   delete-and-re-ingest cycle must not cascade away a latch.
export const postBreakoutState = pgTable('post_breakout_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  statusApId: text('status_ap_id').notNull().unique(),
  actorApId: text('actor_ap_id').notNull(),
  /** Latest observed score. Doubles as the dedupe key: an unchanged tick short-circuits. */
  score: integer('score').notNull(),
  /** High-water mark. Monotone up — this is what the rungs are judged against. */
  peakScore: integer('peak_score').notNull(),
  /** null | 'p90' | 'p99' | 'best'. One-way; only the furthest rung is ever announced. */
  rung: text('rung'),
  /** Score at which `rung` was reached, so the digest quotes what was announced. */
  rungScore: integer('rung_score'),
  // When each rung was ANNOUNCED. NULL means "never announced" — either not reached,
  // or reached before this post was first seen (pre-marked at seed time).
  p90At: timestamp('p90_at', { withTimezone: true }),
  p99At: timestamp('p99_at', { withTimezone: true }),
  bestAt: timestamp('best_at', { withTimezone: true }),
  weightsKey: text('weights_key').notNull(),
  seededAt: timestamp('seeded_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // "what crossed a rung today" (the digest) and the per-account admin table.
  index('post_breakout_actor_idx').on(t.actorApId, t.updatedAt),
])

export const adminSessions = pgTable('admin_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Train journeys exported from viaduct.world (no live API — imported from CSV via /admin).
export const trainTrips = pgTable('train_trips', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromStation: text('from_station').notNull(),
  toStation: text('to_station').notNull(),
  journey: text('journey'),
  trainCode: text('train_code'),
  lineNumber: text('line_number'),
  trainName: text('train_name'),
  operator: text('operator'),
  mode: text('mode'), // Train, Ferry, …
  travelClass: text('travel_class'),
  seatType: text('seat_type'),
  seat: text('seat'),
  coach: text('coach'),
  reason: text('reason'),
  continent: text('continent'),
  notes: text('notes'),
  ticket: text('ticket'),
  // Local wall-clock departure/arrival (date + time) plus the IANA zone they were
  // recorded in. The absolute instants below are derived from these at insert time.
  departureLocal: timestamp('departure_local').notNull(),
  arrivalLocal: timestamp('arrival_local'),
  fromTz: text('from_tz'),
  toTz: text('to_tz'),
  departureAt: timestamp('departure_at', { withTimezone: true }).notNull(),
  arrivalAt: timestamp('arrival_at', { withTimezone: true }),
  distanceKm: integer('distance_km'),
  delay: integer('delay'),
  departureDelay: integer('departure_delay'),
  price: numeric('price'),
  savings: numeric('savings'),
  currency: text('currency'),
  cycling: boolean('cycling').notNull().default(false),
  wifi: boolean('wifi').notNull().default(false),
  diningCar: boolean('dining_car').notNull().default(false),
  night: boolean('night').notNull().default(false),
  replacement: boolean('replacement').notNull().default(false),
  reservation: boolean('reservation').notNull().default(false),
  status: text('status'), // Completed, Planned
  tags: text('tags').array(),
  // The most recent export row this trip was seen in. Not a merge of every export:
  // attributes are coalesced across re-imports, so `raw` documents where the current
  // status came from rather than describing the row field by field.
  raw: jsonb('raw').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('train_trips_departure_idx').on(t.departureAt),
  index('train_trips_status_idx').on(t.status),
  index('train_trips_journey_idx').on(t.journey),
  index('train_trips_operator_idx').on(t.operator),
  // A trip IS when it left and between where — viaduct CSV rows carry no stable id,
  // and train code is an attribute of the trip, not part of it: the same leg exports
  // without a code while planned and with one once travelled, and two sources name the
  // same service differently ("RER A" vs "18568"). Putting it in the key is what made
  // one journey two rows. `departure_at` is the absolute instant, so the comparison
  // happens in one explicit timezone. See ADR 0048.
  uniqueIndex('train_trips_identity_idx').on(t.fromStation, t.toStation, t.departureAt),
])

// Which trip a post was made on — derived, never ingested. Nothing in either side
// links them: the only key is time, and it is a sound one because `published_at`
// and `departure_at`/`arrival_at` are all timestamptz. Measured against the live
// archive, togselfies land within seconds of their trip's departure, so the join
// is tight enough to be worth storing. Kept off both tables for the reason ADR
// 0020 kept `derived_date` off `note_date`: re-tuning the match must not become
// indistinguishable from ingested fact. See ADR 0023 and src/lib/trip-window.ts.
export const tripPosts = pgTable('trip_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').notNull().references(() => trainTrips.id, { onDelete: 'cascade' }),
  // `onUpdate: 'cascade'` because the parent key is a REMOTE identifier, and remote
  // identifiers move: Gigowl renamed every one of its Notes when it changed address
  // (ADR 0038), and without this the rebase could not touch `objects` at all — the FK
  // refused the parent update and the archive was left half-moved. The link is derived
  // from a time window, so it belongs to whatever that post is now called.
  objectApId: text('object_ap_id')
    .notNull()
    .references(() => objects.apId, { onDelete: 'cascade', onUpdate: 'cascade' }),
  // 'boarding' | 'aboard' | 'alighting' — see TripRelation.
  relation: text('relation').notNull(),
  // Signed seconds from departure; negative while still boarding. Stored so a
  // consumer can judge the match instead of trusting the label alone.
  offsetSeconds: integer('offset_seconds').notNull(),
  derivedAt: timestamp('derived_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One trip per post: consecutive legs overlap at the edges, but "which train was
  // I on" has one answer. The matcher's ranking is total, so it is a stable one.
  uniqueIndex('trip_posts_object_idx').on(t.objectApId),
  index('trip_posts_trip_idx').on(t.tripId),
  index('trip_posts_relation_idx').on(t.relation),
])

// The stations the trips pass through, geocoded once, and the weather there on
// the days Markus was travelling. Two tables because they fail separately: a
// station that will not geocode should not keep asking for weather, and a weather
// outage should not cost us the coordinates. See ADR 0028.
export const stations = pgTable('stations', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Exactly as it appears in `train_trips.from_station`/`to_station`. */
  name: text('name').notNull(),
  latitude: numeric('latitude'),
  longitude: numeric('longitude'),
  /** What the geocoder actually matched — so a wrong hit is visible, not silent. */
  displayName: text('display_name'),
  countryCode: text('country_code'),
  /** 'nominatim' | 'manual'. A manual row is never re-geocoded. */
  source: text('source').notNull().default('nominatim'),
  geocodedAt: timestamp('geocoded_at', { withTimezone: true }),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('stations_name_idx').on(t.name),
  index('stations_geocoded_idx').on(t.geocodedAt),
])

// Daily weather at one station on one date, from Open-Meteo's ERA5 archive.
// Aggregates only: the question is "what was it like that day", not an hourly trace.
export const stationWeather = pgTable('station_weather', {
  id: uuid('id').primaryKey().defaultRandom(),
  stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  tempMaxC: numeric('temp_max_c'),
  tempMinC: numeric('temp_min_c'),
  tempMeanC: numeric('temp_mean_c'),
  precipitationMm: numeric('precipitation_mm'),
  snowfallCm: numeric('snowfall_cm'),
  windMaxKmh: numeric('wind_max_kmh'),
  /** WMO code (0 clear … 75 heavy snow); rendered by lib/weather-code.ts. */
  weatherCode: integer('weather_code'),
  source: text('source').notNull().default('open-meteo'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('station_weather_station_date_idx').on(t.stationId, t.date),
  index('station_weather_date_idx').on(t.date),
])

// Which named railway lines a trip ran on, and how far along each.
//
// Derived, never ingested — the same reasoning that kept `trip_posts` off both of
// its parent tables (ADR 0023). The *curation* (which lines exist, where their
// kilometre posts fall, which routings are pinned) lives in git as
// `src/lib/railway-registry.ts`; only the arithmetic it produces is stored. That
// keeps re-curating the registry from becoming indistinguishable from fact, and it
// means a line's definition is reviewed as code rather than edited in place.
//
// Two tables because a trip that resolved to nothing and a trip that has not been
// resolved yet are different answers, and only a per-trip row can tell them apart.
// That distinction is the whole basis of the coverage reporting. See ADR 0035.
export const tripRoutes = pgTable('trip_routes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').notNull().references(() => trainTrips.id, { onDelete: 'cascade' }),
  /** 'resolved' | 'ambiguous' | 'unresolved'. */
  status: text('status').notNull(),
  /**
   * The one explanation field. Why an unresolved trip could not be placed and which
   * candidates tied for an ambiguous one — or, when curation placed it, the pinned
   * routing's justification. A number that came from an override must say so.
   */
  reason: text('reason'),
  /** 'kmposts' | 'override_pair' | 'override_trip'. */
  method: text('method'),
  /** Sum of the registry spans before scaling — the unscaled arithmetic. */
  rawKm: numeric('raw_km'),
  /**
   * `distance_km / raw_km`. Stored rather than applied silently: the registry's
   * kilometre posts and viaduct's recorded distance are two different measurements,
   * and how far apart they are is exactly what says whether to trust the split.
   */
  scaleFactor: numeric('scale_factor'),
  /** Hash of the registry + overrides this row was computed from; stale ⇒ recompute. */
  registryVersion: text('registry_version').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('trip_routes_trip_idx').on(t.tripId),
  index('trip_routes_status_idx').on(t.status),
  index('trip_routes_version_idx').on(t.registryVersion),
])

// One row per (trip, line): the portion of that trip which ran on that line.
// `line_slug` is text rather than a foreign key because the registry is a code
// module, not a table — a slug that disappears from the registry is a curation
// change, and the resolver rewrites these rows wholesale when it does.
export const tripLineLegs = pgTable('trip_line_legs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').notNull().references(() => trainTrips.id, { onDelete: 'cascade' }),
  lineSlug: text('line_slug').notNull(),
  /** Scaled so the per-line sum equals the trip's recorded `distance_km`. */
  onLineKm: numeric('on_line_km').notNull(),
  /** Prorated by distance share — the trip store holds no intermediate timings. */
  onLineSeconds: integer('on_line_seconds'),
  /** True when this leg traversed a named crossing end to end. */
  crossed: boolean('crossed').notNull().default(false),
}, (t) => [
  uniqueIndex('trip_line_legs_trip_line_idx').on(t.tripId, t.lineSlug),
  index('trip_line_legs_line_idx').on(t.lineSlug),
  index('trip_line_legs_crossed_idx').on(t.crossed),
])

// ---------------------------------------------------------------------------
// LinkedIn. Two sources that never meet upstream: post *content* comes from the
// DMA Member Snapshot API (polled), post *performance* from an .xlsx Markus
// exports by hand each month (uploaded via /admin). Impressions and engagement
// rate sit behind `r_member_postAnalytics` in the partner-gated Community
// Management product, which he has no access to — the manual export is the
// design, not a stopgap. See ADR 0033.
// ---------------------------------------------------------------------------

// One row per post, upserted by the poller from MEMBER_SHARE_INFO.
export const linkedinPosts = pgTable('linkedin_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The join key between the two sources: the numeric activity/ugcPost id, pulled
  // out of whatever URL form the source used. The API emits
  // `/feed/update/urn:li:activity:<id>` and the export emits
  // `/posts/<slug>-ugcPost-<id>-<hash>` — different strings, same post. Joining on
  // the raw URL would silently match nothing. See src/lib/linkedin-url.ts.
  postKey: text('post_key').notNull(),
  /** Exactly as the poller received it; the export's form is kept on the metric row. */
  postUrl: text('post_url').notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  commentary: text('commentary'),
  /** LinkedIn's own visibility string (PUBLIC, CONNECTIONS, …). Gates the REST surface. */
  visibility: text('visibility'),
  /** The link attached to the post, if any — not the post's own URL. */
  sharedUrl: text('shared_url'),
  isReshare: boolean('is_reshare').notNull().default(false),
  // The untouched snapshotData entry. LinkedIn does not document the key names for
  // MEMBER_SHARE_INFO (only PROFILE is sampled) and can rename them without an
  // endpoint version bump, so keeping the original makes a rename a re-parse over
  // stored rows instead of a re-fetch behind a token that may have expired.
  raw: jsonb('raw').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('linkedin_posts_key_idx').on(t.postKey),
  index('linkedin_posts_posted_idx').on(t.postedAt),
  index('linkedin_posts_visibility_idx').on(t.visibility),
])

// Performance numbers, one row per post per export. APPEND-ONLY, never updated.
//
// The export's impressions are a windowed accumulation, not a lifetime total, so
// two exports of the same post are two genuinely different observations rather
// than an old and a corrected value. Overwriting would throw away the difference;
// keeping both yields the reach-decay series for free.
//
// Deliberately NOT a foreign key to linkedin_posts: a metric row may arrive for a
// post the poller has not seen yet, and a FK would reject exactly those rows.
// `postedOn` is carried here as well so such a post still has a weekday before the
// poller backfills it.
export const linkedinPostMetrics = pgTable('linkedin_post_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  postKey: text('post_key').notNull(),
  /** The URL as the .xlsx spelled it — usually a different form to the poller's. */
  postUrl: text('post_url').notNull(),
  // Derived from the export's own daily series (its last day), never supplied by
  // the uploader: a form field would let one file import twice under two keys.
  exportDate: date('export_date').notNull(),
  windowStart: date('window_start'),
  windowEnd: date('window_end'),
  /** Publish date from the sheet. Date-only — the export carries no publish time. */
  postedOn: date('posted_on'),
  impressions: integer('impressions'),
  /** Null when the post appeared only in the impressions block. Never a guess. */
  engagements: integer('engagements'),
  raw: jsonb('raw').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Re-importing the same file must be a no-op; this is that guarantee.
  uniqueIndex('linkedin_post_metrics_dedupe_idx').on(t.postKey, t.exportDate),
  index('linkedin_post_metrics_posted_idx').on(t.postedOn),
])

// Per-source ingest health, so "is this source still working" is answerable
// without reading logs.
//
// Every other source in this repo answers that question as `max(data timestamp)`,
// which cannot tell "the poller is broken" from "nothing happened" — fine for
// Last.fm, where a dead key shows up as silence within the hour, but not for a
// weekly poller behind a hand-minted token of unknown lifetime. Keyed by source
// slug rather than being a LinkedIn singleton so the other jobs can adopt it
// later without a migration; only 'linkedin' writes to it today.
export const sourceSyncState = pgTable('source_sync_state', {
  source: text('source').primaryKey(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  /** Last run that actually completed. Stays put while a broken token retries. */
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  // Last run that actually returned a row — a different question from whether the
  // run completed, because the DMA endpoint spells "you have reached the end" and
  // "this domain is not collated yet" with the same 404 body. NULL means this source
  // has never once returned data, which is what separates "waiting for upstream"
  // from "working". Not derivable from `itemsLastRun`, which holds only the most
  // recent run. See ADR 0034.
  lastDataAt: timestamp('last_data_at', { withTimezone: true }),
  lastError: text('last_error'),
  /** HTTP status of the last *failure* — 401/403 is what makes a token "expired". */
  lastStatus: integer('last_status'),
  // The terminal response of the last attempt, whatever it was classified as —
  // written on success too, which `lastStatus`/`lastError` deliberately are not.
  // A source whose every run succeeds and returns nothing used to leave those two
  // NULL forever, which is exactly the LinkedIn snapshot's steady state and the one
  // place the evidence is most wanted. 0 means no response arrived at all.
  // See ADR 0039.
  lastHttpStatus: integer('last_http_status'),
  /** That response's body, clipped. LinkedIn's error envelope is the diagnosis. */
  lastHttpBody: text('last_http_body'),
  /** One line saying what the run concluded and on what evidence. Read this first. */
  lastNote: text('last_note'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  itemsLastRun: integer('items_last_run'),
  /** Latch for the failure push, so a weekly poller alerts once and not forever. */
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// OAuth 2.1 (MCP authorization). These back the OAuth flow that lets browser /
// mobile MCP clients (e.g. claude.ai connectors, which only speak OAuth, not a
// static bearer header) authenticate against /mcp. The "user" login step reuses
// the admin password (ADMIN_PASSWORD_HASH); see src/oauth/.
// ---------------------------------------------------------------------------

// Clients created via Dynamic Client Registration (RFC 7591). claude.ai
// registers a fresh client per connection, so rows accumulate — that's expected.
export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  // Null for public clients (token_endpoint_auth_method = 'none'), which is what
  // PKCE-based connectors use. Set (random hex) for confidential clients.
  clientSecret: text('client_secret'),
  redirectUris: jsonb('redirect_uris').notNull(), // string[]
  clientName: text('client_name'),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('client_secret_basic'),
  grantTypes: jsonb('grant_types'), // string[]
  responseTypes: jsonb('response_types'), // string[]
  scope: text('scope'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Short-lived authorization codes (PKCE). The code itself is never stored — only
// its sha256 hash — mirroring how admin_sessions handles session tokens.
export const oauthAuthCodes = pgTable('oauth_auth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(), // S256 challenge
  scope: text('scope'),
  resource: text('resource'), // RFC 8707 resource indicator, if supplied
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('oauth_auth_codes_expires_idx').on(t.expiresAt),
])

// Access and refresh tokens, sha256-hashed. `type` is 'access' or 'refresh'.
export const oauthTokens = pgTable('oauth_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  type: text('type').notNull(),
  clientId: text('client_id').notNull(),
  scope: text('scope'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('oauth_tokens_client_idx').on(t.clientId),
  index('oauth_tokens_expires_idx').on(t.expiresAt),
])
