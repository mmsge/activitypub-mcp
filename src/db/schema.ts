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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  index('objects_actor_idx').on(t.actorApId),
  index('objects_type_idx').on(t.type),
  index('objects_published_idx').on(t.publishedAt),
  index('objects_actor_published_idx').on(t.actorApId, t.publishedAt),
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
  raw: jsonb('raw').notNull(),
  // Stable content hash of the trip's identifying fields; the import dedupe key.
  dedupeKey: text('dedupe_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('train_trips_departure_idx').on(t.departureAt),
  index('train_trips_status_idx').on(t.status),
  index('train_trips_journey_idx').on(t.journey),
  index('train_trips_operator_idx').on(t.operator),
  // Viaduct CSV rows carry no stable id; this hash is the re-import dedupe key.
  uniqueIndex('train_trips_dedupe_idx').on(t.dedupeKey),
])

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
