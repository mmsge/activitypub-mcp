import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getActorPostsSchema, getActorPosts } from './tools/actor-posts.js'
import { getActorReadingStatusSchema, getActorReadingStatus } from './tools/actor-reading.js'
import { getActorMediaSchema, getActorMedia } from './tools/actor-media.js'
import { searchActorContentSchema, searchActorContent } from './tools/actor-search.js'
import { getFollowsSchema, getFollows } from './tools/follows.js'
import { getActivityStatsSchema, getActivityStats, getRecentActivitiesSchema, getRecentActivities } from './tools/activity-stats.js'
import { getReadingEventsSchema, getReadingEvents } from './tools/reading-events.js'
import { getReadingStatsSchema, getReadingStats } from './tools/reading-stats.js'
import { getScrobblesSchema, getScrobbles, getScrobbleStatsSchema, getScrobbleStats } from './tools/scrobbles.js'
import { getNowPlayingSchema, getNowPlaying } from './tools/now-playing.js'
import { getTrainTripsSchema, getTrainTrips, getTrainStatsSchema, getTrainStats } from './tools/train-trips.js'
import { getGardenPagesSchema, getGardenPages } from './tools/garden-pages.js'
import { getGardenPageSchema, getGardenPage } from './tools/garden-page.js'
import { getBookDetailsSchema, getBookDetails } from './tools/book-details.js'
import { getBooksSchema, getBooks } from './tools/books.js'
import { getHashtagStatsSchema, getHashtagStats, getHashtagTrendsSchema, getHashtagTrends } from './tools/hashtag-stats.js'
import { getEngagementSchema, getEngagement, getEngagementTrendsSchema, getEngagementTrends } from './tools/engagement.js'
import { getActorEngagementTrendsSchema, getActorEngagementTrends } from './tools/actor-engagement-trends.js'

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'activitypub-mcp',
    version: '1.0.0',
  })

  server.tool(
    'get_actor_posts',
    "Get posts from a specific ActivityPub actor. Defaults to newest-first; set sort_order='asc' with limit=1 to fetch the actor's earliest post in one call, and follow the next_cursor token for deep traversal.",
    getActorPostsSchema.shape,
    async (input) => {
      const result = await getActorPosts(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_actor_reading_status',
    "Get BookWyrm reading status for an actor by querying the live shelf (use_live: true, default) or local DB. With use_live: false, shelves (reading/read/to-read) are derived from the actor's stored reading note posts, collapsed to one row per book; ratings only appear if a federated review/rating carried one. Cover, pages and language are backfilled from the cached book_metadata where that book has been enriched (so offline rows now carry covers for enriched books; the live shelf is still ground truth for cover art). Returns title, authors, cover, shelf, started_date, finished_date, rating, bookwyrm_book_url, pages, and language per book.",
    getActorReadingStatusSchema.shape,
    async (input) => {
      const result = await getActorReadingStatus(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_actor_media',
    'Get posts with image or video attachments from an actor',
    getActorMediaSchema.shape,
    async (input) => {
      const result = await getActorMedia(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'search_actor_content',
    'Full-text search across all stored posts from an actor or all followed actors',
    searchActorContentSchema.shape,
    async (input) => {
      const result = await searchActorContent(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_follows',
    'List the actors this server is following, with follow status',
    getFollowsSchema.shape,
    async (input) => {
      const result = await getFollows(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_activity_stats',
    'Get aggregate statistics about stored posts — counts by type, with attachments, etc.',
    getActivityStatsSchema.shape,
    async (input) => {
      const result = await getActivityStats(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_recent_activities',
    'Get the most recently received ActivityPub activities as a feed',
    getRecentActivitiesSchema.shape,
    async (input) => {
      const result = await getRecentActivities(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_reading_events',
    "Get BookWyrm reading events for an actor, derived from stored note posts with a normalized event_type field: started_reading, finished_reading, review, rating, comment, note, shelved. The `rating` event_type requires BookWyrm to federate a standalone /rating/ activity (many actors never produce these); an inline rating on a review is surfaced on that event's `rating` field. Useful for building a reading timeline or finding when a book was started vs finished. Defaults to newest-first; set sort_order='asc' with limit=1 to fetch the earliest reading event in one call, and follow the next_cursor token for deep traversal.",
    getReadingEventsSchema.shape,
    async (input) => {
      const result = await getReadingEvents(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_reading_stats',
    "Aggregate reading statistics for an actor's BookWyrm books: total/average/median page counts, reading span, ratings distribution, and a per-format breakdown, with a top-N breakdown by year, month, format, author, or rating. Page/format/year data comes from cached BookWyrm Edition metadata; finish dates from the actor's finished-reading posts. Defaults to the \"read\" shelf and group_by=year; filter by year/from/to (on finish date), format, author, or rating. Page averages are reported over books with known page counts (see pages_coverage), and avg_pages_prose excludes comics/graphic novels and audiobooks so a comics-heavy span doesn't skew the prose number.",
    getReadingStatsSchema.shape,
    async (input) => {
      const result = await getReadingStats(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_scrobbles',
    "Query the locally-stored Last.fm scrobble history. Filter by artist, album, or track (case-insensitive partial match) and/or a played-at time window (from/to/since, ISO datetimes). Defaults to newest-first; set sort_order='asc' with limit=1 to fetch the earliest matching scrobble in one call. For deep traversal, follow the next_cursor token instead of incrementing page.",
    getScrobblesSchema.shape,
    async (input) => {
      const result = await getScrobbles(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_scrobble_stats',
    "Aggregate metrics over the stored Last.fm scrobbles: total play count, listening span (first/last played), and top artists, albums, or tracks by play count. Accepts the same artist/album/track filters as get_scrobbles — when filtered, total_scrobbles and first_played_at/last_played_at reflect only matching rows, so e.g. an artist's first play is answerable in a single call. Optionally bounded by a from/to time window.",
    getScrobbleStatsSchema.shape,
    async (input) => {
      const result = await getScrobbleStats(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_now_playing',
    "Get the Last.fm user's currently-playing track as a live read (not a stored scrobble). Returns { nowPlaying: true, track, artist, album, image, url } when something is playing, or { nowPlaying: false } otherwise.",
    getNowPlayingSchema.shape,
    async (input) => {
      const result = await getNowPlaying(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_train_trips',
    "Query the locally-stored train travel history (imported from viaduct.world CSV exports). Filter by station (origin or destination), journey name, operator, mode (Train/Ferry), status (Completed/Planned), tag, year, or a departure time window. Defaults to newest-first; set sort_order='asc' with limit=1 for the earliest matching trip, and follow next_cursor for deep traversal.",
    getTrainTripsSchema.shape,
    async (input) => {
      const result = await getTrainTrips(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_train_stats',
    "Aggregate metrics over the stored train trips: total trip count, total distance (km), total time aboard, distinct stations/operators/journeys, and travel span (first/last departure). Accepts the same journey/operator/mode/status/tag filters plus a year scope (defaults to all-time). Returns a top-N breakdown by journey, operator, mode, or year, and the next upcoming planned trip.",
    getTrainStatsSchema.shape,
    async (input) => {
      const result = await getTrainStats(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_garden_pages',
    'Get pages from the markus.plus "Tankehav" digital garden (an Obsidian Publish site): title, url, section, excerpt, image and an optional date per page, plus a section roll-up. Filter by section; dated pages sort by date, undated pages sort after alphabetically. Set include_content=true to also receive each page\'s full markdown text (content, frontmatter stripped; null when not yet synced — content_missing reports coverage). For a single page\'s full text (including the home page, path "/", which this list omits) use get_garden_page.',
    getGardenPagesSchema.shape,
    async (input) => {
      const result = await getGardenPages(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_garden_page',
    'Get one markus.plus "Tankehav" garden page with its full markdown text, resolved by path (the permalink, e.g. "/reisar/interrail/2025"; "/" is the home page) or url. Returns title, url, path, section, description, image, date, tags, plus content (the complete note body as markdown, frontmatter stripped) and content_fetched_at. Content is served from a local cache synced every 6h from Obsidian Publish; a missing page is fetched live once. content is null with content_error set if the source is currently unreachable.',
    getGardenPageSchema.shape,
    async (input) => {
      const result = await getGardenPage(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_book_details',
    "Get full enriched metadata for one BookWyrm book from the local cache, resolved by book_url (the Edition AP id), isbn (13 or 10), or a partial title. Returns title, subtitle, series, authors-independent fields like pages, physical_format, isbn13/isbn10, pub_year, language and original_language, publisher, cover_url, description, and subjects — each matched to the edition's resolved ISBN. isbn_source/page_source/source_map record where each value came from (bookwyrm Edition, markus.plus review, OpenLibrary, or Google Books).",
    getBookDetailsSchema.shape,
    async (input) => {
      const result = await getBookDetails(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_books',
    "Browse all cached BookWyrm book metadata as a paginated catalogue. Returns compact rows (book_url, title, subtitle, series, pages, physical_format, isbn13/isbn10, pub_year, language, publisher, cover_url, fetched_at) — call get_book_details for the full record (description, subjects, provenance) of one book. Filter by title (partial match), format, or language. Most-recently-enriched first by default (sort_order='asc' for oldest first). Each response carries `total` (matching books across all pages) and a `next_cursor` token; pass it back as `cursor` for deep traversal, or use the legacy offset `page`.",
    getBooksSchema.shape,
    async (input) => {
      const result = await getBooks(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_hashtag_stats',
    "Aggregate hashtag usage across stored posts to surface which hashtags an actor uses and how. Scoped by default to your own posts (the configured OWNER_ACTOR) when no actor_handle is given; pass actor_handle to inspect another actor, or a tag to restrict the snapshot to posts carrying that hashtag. Optionally bounded by a from/to/since time window. Returns totals (total_hashtag_uses, distinct_hashtags), a posts-with-hashtags ratio (posts_total, posts_with_hashtags, posts_with_hashtags_pct, avg_hashtags_per_post), top_hashtags with per-tag first_used/last_used, and top_cooccurring_pairs (hashtags frequently used together). Use get_hashtag_trends for usage over time.",
    getHashtagStatsSchema.shape,
    async (input) => {
      const result = await getHashtagStats(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_hashtag_trends',
    "Track hashtag usage over time as a time series. Scoped by default to your own posts (the configured OWNER_ACTOR) when no actor_handle is given. Bucket by group_by=week|month|year (default month) over an optional from/to/since window. Without a tag, each series point reports total hashtag uses and distinct_hashtags for that period; pass a specific tag to chart just that hashtag's count per period. Series runs oldest → newest.",
    getHashtagTrendsSchema.shape,
    async (input) => {
      const result = await getHashtagTrends(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_engagement',
    "Fetch CURRENT favourite/boost/reply counts for one or more public statuses, read live from each status's origin instance (Mastodon REST API first, ActivityPub collection totals as fallback — source: 'ap' counts can under-report). Accepts permalinks (https://host/@user/id), AP object ids, or bare numeric ids (resolved against OWNER_INSTANCE). Each successful read is snapshotted to the engagement_snapshots table (disable with snapshot: false; skip_unchanged: true suppresses writes identical to the latest snapshot), so repeated calls build the history behind get_engagement_trends. Failures are per-item — one dead status never fails the batch. Counts are eventually-consistent and can go DOWN over time.",
    getEngagementSchema.shape,
    async (input) => {
      const result = await getEngagement(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_engagement_trends',
    "Read a status's stored engagement history back as a time series (the read side of get_engagement's snapshots — a status must have been sampled at least once). Buckets snapshots by group_by=hour|day|week|month (default day) over an optional from/to/since window; each bucket carries the latest counts observed in it plus the delta vs the previous bucket (deltas can be negative — un-favourites and undone boosts are real). metric=favourites|reblogs|replies narrows the series to {value, delta} points; 'all' (default) returns every count. Series runs oldest → newest. Note: buckets mixing source: 'rest' and 'ap' snapshots can jitter, as AP collection totals may under-report.",
    getEngagementTrendsSchema.shape,
    async (input) => {
      const result = await getEngagementTrends(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_actor_engagement_trends',
    "Chart engagement (favourites/reblogs/replies) aggregated into time buckets across an actor's posts — the actor-scoped sibling of get_engagement_trends. Joins each qualifying post to its LATEST engagement snapshot and buckets by the post's PUBLISHED date (group_by=day|week|month, default day). By default aggregates across ALL followed actors (every account this server follows — i.e. all your accounts across services); pass actor_handle to narrow to one account. metric=favourites|reblogs|replies|all (default favourites); aggregate=mean|sum|median|max (default mean — 'mean' answers avg-per-post, 'sum' answers total reach). exclude_replies (default true) drops posts with a non-null in_reply_to; object_types (default [\"Note\",\"Question\"]) excludes boosts/announces — widen it (e.g. add \"Image\"/\"Video\") to include photo/video services. Bound by from/to/since on published_at. Each bucket carries post_count plus value/sum/min/max; empty buckets are omitted (client can zero-fill). A `coverage` block reports how many in-window posts actually have a snapshot — posts must be sampled by get_engagement (the background sampler snapshots all followed actors) first, and only sampled posts contribute to the aggregate. Series runs oldest → newest. Counts are eventually-consistent and can go down; AP-collection totals can under-report.",
    getActorEngagementTrendsSchema.shape,
    async (input) => {
      const result = await getActorEngagementTrends(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  return server
}
