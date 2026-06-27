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
}, (t) => [
  index('book_metadata_book_url_idx').on(t.bookUrl),
  index('book_metadata_work_url_idx').on(t.workUrl),
  index('book_metadata_format_idx').on(t.physicalFormat),
  index('book_metadata_isbn13_idx').on(t.isbn13),
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
