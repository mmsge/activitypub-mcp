import {
  pgTable, text, uuid, timestamp, boolean, jsonb,
  bigserial, numeric, date, integer, index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// source values used in actors and objects
export type PostSource = 'activitypub' | 'linkedin'

export const serverConfig = pgTable('server_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const actors = pgTable('actors', {
  id: uuid('id').primaryKey().defaultRandom(),
  // For ActivityPub actors this is the AP URL; for LinkedIn actors this is the member URN (urn:li:person:…)
  apId: text('ap_id').notNull().unique(),
  source: text('source').notNull().default('activitypub'),
  handle: text('handle'),
  username: text('username'),
  domain: text('domain'),
  displayName: text('display_name'),
  summary: text('summary'),
  iconUrl: text('icon_url'),
  profileUrl: text('profile_url'), // canonical public profile URL (e.g. linkedin.com/in/…)
  publicKeyPem: text('public_key_pem'), // AP-only; null for LinkedIn actors
  inboxUrl: text('inbox_url'), // AP-only; null for LinkedIn actors
  sharedInboxUrl: text('shared_inbox_url'),
  followersUrl: text('followers_url'),
  followingUrl: text('following_url'),
  raw: jsonb('raw').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('actors_domain_idx').on(t.domain),
  index('actors_source_idx').on(t.source),
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
  // For LinkedIn objects, actorApId holds the member URN (urn:li:person:…)
  source: text('source').notNull().default('activitypub'),
  sourceExternalId: text('source_external_id'), // e.g. LinkedIn share URN (urn:li:share:…)
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
  index('objects_source_idx').on(t.source, t.actorApId, t.publishedAt),
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

export const adminSessions = pgTable('admin_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Stores the OAuth tokens for the single connected LinkedIn member account.
// Tokens (accessToken, refreshToken) are encrypted with AES-256-GCM using a
// key derived from SESSION_SECRET via PBKDF2.
export const linkedinAuth = pgTable('linkedin_auth', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberUrn: text('member_urn').notNull().unique(), // urn:li:person:…
  // Encrypted token blobs (base64 of iv:authTag:ciphertext)
  accessTokenEnc: text('access_token_enc').notNull(),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }).notNull(),
  refreshTokenEnc: text('refresh_token_enc'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scopes: text('scopes').notNull().default(''),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Tracks locally-hosted media files (images, videos, PDFs) downloaded from LinkedIn.
export const media = pgTable('media', {
  id: uuid('id').primaryKey().defaultRandom(),
  hash: text('hash').notNull().unique(), // sha256 of file bytes (hex)
  mimeType: text('mime_type').notNull(),
  bytes: integer('bytes').notNull(),
  sourceUrl: text('source_url'), // original LinkedIn CDN URL
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('media_hash_idx').on(t.hash),
])
