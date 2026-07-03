import type { ZodObject } from 'zod'
import { getActorPostsSchema, getActorPosts } from '../mcp/tools/actor-posts.js'
import { getActorReadingStatusSchema, getActorReadingStatus } from '../mcp/tools/actor-reading.js'
import { getActorMediaSchema, getActorMedia } from '../mcp/tools/actor-media.js'
import { searchActorContentSchema, searchActorContent } from '../mcp/tools/actor-search.js'
import { getFollowsSchema, getFollows } from '../mcp/tools/follows.js'
import {
  getActivityStatsSchema, getActivityStats,
  getRecentActivitiesSchema, getRecentActivities,
} from '../mcp/tools/activity-stats.js'
import { getReadingEventsSchema, getReadingEvents } from '../mcp/tools/reading-events.js'
import { getReadingStatsSchema, getReadingStats } from '../mcp/tools/reading-stats.js'
import {
  getScrobblesSchema, getScrobbles,
  getScrobbleStatsSchema, getScrobbleStats,
} from '../mcp/tools/scrobbles.js'
import { getNowPlayingSchema, getNowPlaying } from '../mcp/tools/now-playing.js'
import {
  getTrainTripsSchema, getTrainTrips,
  getTrainStatsSchema, getTrainStats,
} from '../mcp/tools/train-trips.js'
import { getGardenPagesSchema, getGardenPages } from '../mcp/tools/garden-pages.js'
import { getGardenPageSchema, getGardenPage } from '../mcp/tools/garden-page.js'
import { getBookDetailsSchema, getBookDetails } from '../mcp/tools/book-details.js'
import { getBooksSchema, getBooks } from '../mcp/tools/books.js'
import {
  getHashtagStatsSchema, getHashtagStats,
  getHashtagTrendsSchema, getHashtagTrends,
} from '../mcp/tools/hashtag-stats.js'
import {
  getEngagementSchema, getEngagement,
  getEngagementTrendsSchema, getEngagementTrends,
} from '../mcp/tools/engagement.js'

/**
 * One row per MCP tool. Each REST endpoint reuses the exact same (schema, handler)
 * pair the MCP server wraps in `src/mcp/server.ts`, so REST and MCP return identical
 * data. `numbers`/`booleans`/`arrays` tell the GET coercion layer which query-string
 * params need converting from strings (the QUERY/POST JSON body needs none).
 *
 * REST path rule: the MCP tool name with `_`→`-`, dropping a leading `get_`.
 */
export type RestEndpoint = {
  path: string
  name: string
  description: string
  schema: ZodObject<any>
  handler: (input: any) => Promise<unknown>
  numbers: string[]
  booleans: string[]
  arrays: string[]
}

export const endpoints: RestEndpoint[] = [
  {
    path: '/actor-posts',
    name: 'get_actor_posts',
    description: "Get posts from a specific ActivityPub actor. Defaults to newest-first; set sort_order=asc with limit=1 for the earliest post, and follow next_cursor for deep traversal.",
    schema: getActorPostsSchema,
    handler: getActorPosts,
    numbers: ['limit'],
    booleans: [],
    arrays: ['object_types'],
  },
  {
    path: '/actor-reading-status',
    name: 'get_actor_reading_status',
    description: 'Get BookWyrm reading status for an actor by querying the live shelf (use_live: true, default) or local DB. With use_live: false, shelves (reading/read/to-read) are derived from the actor\'s stored reading note posts; ratings appear only when a federated review/rating carried one. Cover, pages and language are backfilled from the cached book_metadata for enriched books (so offline rows now carry covers where the book has been enriched; the live shelf remains ground truth for cover art). Returns title, authors, cover, shelf, started_date, finished_date, rating, bookwyrm_book_url, pages, and language per book.',
    schema: getActorReadingStatusSchema,
    handler: getActorReadingStatus,
    numbers: ['limit'],
    booleans: ['use_live'],
    arrays: [],
  },
  {
    path: '/actor-media',
    name: 'get_actor_media',
    description: 'Get posts with image or video attachments from an actor',
    schema: getActorMediaSchema,
    handler: getActorMedia,
    numbers: ['limit'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/search-actor-content',
    name: 'search_actor_content',
    description: 'Full-text search across all stored posts from an actor or all followed actors',
    schema: searchActorContentSchema,
    handler: searchActorContent,
    numbers: ['limit'],
    booleans: [],
    arrays: ['object_types'],
  },
  {
    path: '/follows',
    name: 'get_follows',
    description: 'List the actors this server is following, with follow status',
    schema: getFollowsSchema,
    handler: getFollows,
    numbers: [],
    booleans: [],
    arrays: [],
  },
  {
    path: '/activity-stats',
    name: 'get_activity_stats',
    description: 'Get aggregate statistics about stored posts — counts by type, with attachments, etc.',
    schema: getActivityStatsSchema,
    handler: getActivityStats,
    numbers: [],
    booleans: [],
    arrays: [],
  },
  {
    path: '/recent-activities',
    name: 'get_recent_activities',
    description: 'Get the most recently received ActivityPub activities as a feed',
    schema: getRecentActivitiesSchema,
    handler: getRecentActivities,
    numbers: ['limit'],
    booleans: [],
    arrays: ['types'],
  },
  {
    path: '/reading-events',
    name: 'get_reading_events',
    description: 'Get BookWyrm reading events for an actor, derived from stored note posts with a normalized event_type field: started_reading, finished_reading, review, rating, comment, note, shelved. Defaults to newest-first; set sort_order=asc with limit=1 for the earliest event, and follow next_cursor for deep traversal.',
    schema: getReadingEventsSchema,
    handler: getReadingEvents,
    numbers: ['limit'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/reading-stats',
    name: 'get_reading_stats',
    description: "Aggregate reading statistics for an actor's BookWyrm books: total/average/median page counts, reading span, ratings distribution, a per-format breakdown, and a top-N breakdown by year, month, format, author, or rating. Defaults to the read shelf and group_by=year; filter by year/from/to (on finish date), format, author, or rating. Page averages report coverage (pages_coverage), and avg_pages_prose excludes comics and audiobooks.",
    schema: getReadingStatsSchema,
    handler: getReadingStats,
    numbers: ['limit', 'year', 'rating'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/scrobbles',
    name: 'get_scrobbles',
    description: 'Query the locally-stored Last.fm scrobble history. Filter by artist, album, or track (case-insensitive partial match) and/or a played-at time window (from/to/since, ISO datetimes). Returns scrobbles newest-first by default; pass sort_order=asc with limit=1 to get the earliest match, and paginate deeply via the next_cursor token.',
    schema: getScrobblesSchema,
    handler: getScrobbles,
    numbers: ['limit', 'page'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/scrobble-stats',
    name: 'get_scrobble_stats',
    description: 'Aggregate metrics over the stored Last.fm scrobbles: total play count, listening span (first/last played), and top artists, albums, or tracks by play count. Accepts the same artist/album/track filters as /scrobbles, so first_played_at/last_played_at/total_scrobbles can be scoped to one artist. Optionally bounded by a from/to time window.',
    schema: getScrobbleStatsSchema,
    handler: getScrobbleStats,
    numbers: ['limit'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/now-playing',
    name: 'get_now_playing',
    description: "Get the Last.fm user's currently-playing track as a live read (not a stored scrobble). Returns { nowPlaying: true, track, artist, album, image, url } when something is playing, or { nowPlaying: false } otherwise.",
    schema: getNowPlayingSchema,
    handler: getNowPlaying,
    numbers: [],
    booleans: [],
    arrays: [],
  },
  {
    path: '/train-trips',
    name: 'get_train_trips',
    description: 'Query the locally-stored train travel history (imported from viaduct.world CSV exports). Filter by station (origin or destination), journey, operator, mode, status, tag, year, or a departure time window. Newest-first by default; pass sort_order=asc with limit=1 for the earliest match, and paginate deeply via next_cursor.',
    schema: getTrainTripsSchema,
    handler: getTrainTrips,
    numbers: ['limit', 'page', 'year'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/train-stats',
    name: 'get_train_stats',
    description: 'Aggregate metrics over the stored train trips: total count, total km, total time aboard, distinct stations/operators/journeys, travel span, a top-N breakdown (by journey, operator, mode, or year), and the next upcoming planned trip. Accepts journey/operator/mode/status/tag filters and a year scope.',
    schema: getTrainStatsSchema,
    handler: getTrainStats,
    numbers: ['limit', 'year'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/garden-pages',
    name: 'get_garden_pages',
    description: 'Get pages from the markus.plus "Tankehav" digital garden (an Obsidian Publish site): title, url, section, excerpt, image and an optional date per page, plus a section roll-up. Filter by section; dated pages sort by date, undated pages sort after alphabetically. Set include_content=true to also receive each page\'s full markdown text (content, frontmatter stripped; null when not yet synced — content_missing reports coverage). For a single page\'s full text (including the home page, path "/", which this list omits) use /garden-page.',
    schema: getGardenPagesSchema,
    handler: getGardenPages,
    numbers: ['limit'],
    booleans: ['include_content'],
    arrays: [],
  },
  {
    path: '/garden-page',
    name: 'get_garden_page',
    description: 'Get one markus.plus "Tankehav" garden page with its full markdown text, resolved by path (the permalink, e.g. "/reisar/interrail/2025"; "/" is the home page) or url. Returns title, url, path, section, description, image, date, tags, plus content (the complete note body as markdown, frontmatter stripped) and content_fetched_at. Content is served from a local cache synced every 6h from Obsidian Publish; a missing page is fetched live once. content is null with content_error set if the source is currently unreachable.',
    schema: getGardenPageSchema,
    handler: getGardenPage,
    numbers: [],
    booleans: [],
    arrays: [],
  },
  {
    path: '/book-details',
    name: 'get_book_details',
    description: "Get full enriched metadata for one BookWyrm book from the local cache, resolved by book_url (the Edition AP id), isbn (13 or 10), or a partial title. Returns title, subtitle, series, pages, physical_format, isbn13/isbn10, pub_year, language, original_language, publisher, cover_url, description, and subjects — each matched to the edition's resolved ISBN, with isbn_source/page_source/source_map provenance.",
    schema: getBookDetailsSchema,
    handler: getBookDetails,
    numbers: [],
    booleans: [],
    arrays: [],
  },
  {
    path: '/books',
    name: 'get_books',
    description: "Browse all cached BookWyrm book metadata as a paginated catalogue. Returns compact rows (book_url, title, subtitle, series, pages, physical_format, isbn13/isbn10, pub_year, language, publisher, cover_url, fetched_at) — call get_book_details for the full record (description, subjects, provenance) of one book. Filter by title (partial match), format, or language. Most-recently-enriched first by default (sort_order='asc' for oldest first). Each response carries `total` (matching books across all pages) and a `next_cursor` token; pass it back as `cursor` for deep traversal, or use the legacy offset `page`.",
    schema: getBooksSchema,
    handler: getBooks,
    numbers: ['limit', 'page'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/hashtag-stats',
    name: 'get_hashtag_stats',
    description: "Aggregate hashtag usage across stored posts to surface which hashtags an actor uses and how. Scoped by default to your own posts (the configured OWNER_ACTOR) when no actor_handle is given; pass actor_handle to inspect another actor, or a tag to restrict the snapshot to posts carrying that hashtag. Optionally bounded by a from/to/since time window. Returns totals (total_hashtag_uses, distinct_hashtags), a posts-with-hashtags ratio (posts_total, posts_with_hashtags, posts_with_hashtags_pct, avg_hashtags_per_post), top_hashtags with per-tag first_used/last_used, and top_cooccurring_pairs (hashtags frequently used together). Use /hashtag-trends for usage over time.",
    schema: getHashtagStatsSchema,
    handler: getHashtagStats,
    numbers: ['limit'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/hashtag-trends',
    name: 'get_hashtag_trends',
    description: "Track hashtag usage over time as a time series. Scoped by default to your own posts (the configured OWNER_ACTOR) when no actor_handle is given. Bucket by group_by=week|month|year (default month) over an optional from/to/since window. Without a tag, each series point reports total hashtag uses and distinct_hashtags for that period; pass a specific tag to chart just that hashtag's count per period. Series runs oldest → newest.",
    schema: getHashtagTrendsSchema,
    handler: getHashtagTrends,
    numbers: ['limit'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/engagement',
    name: 'get_engagement',
    description: "Fetch CURRENT favourite/boost/reply counts for one or more public statuses, read live from each status's origin instance (Mastodon REST first, ActivityPub totals as fallback). Accepts permalinks, AP object ids, or bare numeric ids (OWNER_INSTANCE). NOTE: unless snapshot=false, every call — including GET — writes a snapshot row per status; skip_unchanged=true suppresses writes identical to the latest snapshot. Failures are per-item, never the whole batch.",
    schema: getEngagementSchema,
    handler: getEngagement,
    numbers: [],
    booleans: ['snapshot', 'skip_unchanged'],
    arrays: ['statuses'],
  },
  {
    path: '/engagement-trends',
    name: 'get_engagement_trends',
    description: "Read a status's stored engagement history as a time series (needs at least one prior get_engagement sample). Buckets by group_by=hour|day|week|month (default day) over an optional from/to/since window; each bucket carries the latest observed counts plus the delta vs the previous bucket (negative deltas are real: un-favourites happen). metric narrows to {value, delta} points. Series runs oldest → newest.",
    schema: getEngagementTrendsSchema,
    handler: getEngagementTrends,
    numbers: ['limit'],
    booleans: [],
    arrays: [],
  },
]
