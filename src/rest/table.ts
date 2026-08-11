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
import { getReadingPaceSchema, getReadingPace } from '../mcp/tools/reading-pace.js'
import {
  getScrobblesSchema, getScrobbles,
  getScrobbleStatsSchema, getScrobbleStats,
} from '../mcp/tools/scrobbles.js'
import { getNowPlayingSchema, getNowPlaying } from '../mcp/tools/now-playing.js'
import {
  getTrainTripsSchema, getTrainTrips,
  getTrainStatsSchema, getTrainStats,
} from '../mcp/tools/train-trips.js'
import { getTripPostsSchema, getTripPosts } from '../mcp/tools/trip-posts.js'
import { getTripWeatherSchema, getTripWeather } from '../mcp/tools/trip-weather.js'
import {
  listRailwayLinesSchema, listRailwayLines,
  getLineStatsSchema, getLineStats,
  getLineTripsSchema, getLineTrips,
} from '../mcp/tools/railway-lines.js'
import { publicOnly } from '../mcp/tools/scope.js'
import { getGardenPagesSchema, getGardenPages } from '../mcp/tools/garden-pages.js'
import { getGardenPageSchema, getGardenPage } from '../mcp/tools/garden-page.js'
import { getBookDetailsSchema, getBookDetails } from '../mcp/tools/book-details.js'
import { getBooksSchema, getBooks } from '../mcp/tools/books.js'
import { getWatchedSchema, getWatched, getCatalogueDetailsSchema, getCatalogueDetails } from '../mcp/tools/watched.js'
import { getGigsSchema, getGigs, getGigDetailsSchema, getGigDetails, getGigStatsSchema, getGigStats } from '../mcp/tools/gigs.js'
import {
  getHashtagStatsSchema, getHashtagStats,
  getHashtagTrendsSchema, getHashtagTrends,
} from '../mcp/tools/hashtag-stats.js'
import { getScrobbleRaceSchema, getScrobbleRace } from '../mcp/tools/scrobble-race.js'
import { getPostBreakoutsSchema, getPostBreakouts } from '../mcp/tools/post-breakouts.js'
import {
  getEngagementSchema, getEngagement,
  getEngagementTrendsSchema, getEngagementTrends,
} from '../mcp/tools/engagement.js'
import {
  getLinkedinPostsSchema, getLinkedinPosts,
  getLinkedinPostSchema, getLinkedinPost,
} from '../mcp/tools/linkedin-posts.js'
import { getLinkedinStatsSchema, getLinkedinStats } from '../mcp/tools/linkedin-stats.js'

/**
 * One row per MCP tool. Each REST endpoint reuses the same (schema, handler) pair
 * the MCP server wraps in `src/mcp/server.ts`. `numbers`/`booleans`/`arrays` tell
 * the GET coercion layer which query-string params need converting from strings
 * (the QUERY/POST JSON body needs none).
 *
 * REST path rule: the MCP tool name with `_`→`-`, dropping a leading `get_`.
 *
 * **REST and MCP return identical data except for visibility.** Every endpoint that
 * serves post rows is wrapped in `publicOnly(...)`, which pins it to posts the
 * origin marked public; the MCP tool is unwrapped and sees the whole archive. That
 * is deliberate and is the one place the two surfaces diverge — MCP is Markus
 * reading his own archive, REST is what other sites republish. See ADR 0026.
 *
 * A new endpoint that returns post rows must be wrapped too. The choice is meant to
 * be visible here rather than remembered inside each handler.
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
    handler: publicOnly(getActorPosts),
    numbers: ['limit'],
    booleans: [],
    arrays: ['object_types'],
  },
  {
    path: '/actor-reading-status',
    name: 'get_actor_reading_status',
    description: 'Get BookWyrm reading status for an actor by querying the live shelf (use_live: true, default) or local DB. BookWyrm shelf collections are bare Edition objects, so BOTH modes derive started_date/finished_date/rating from the actor\'s stored public statuses (day granularity; a "read" comment or a review marks the finish) — live mode merges those onto the authoritative shelf rows by Edition URL (title fallback) and adds shelved_date when present. Cover, pages and language are backfilled from the cached book_metadata for enriched books (the live shelf remains ground truth for cover art). Returns title, authors, cover, shelf, started_date, finished_date, rating, bookwyrm_book_url, pages, language, and shelved_date per book.',
    schema: getActorReadingStatusSchema,
    handler: getActorReadingStatus,
    numbers: ['limit'],
    booleans: ['use_live', 'include_hidden'],
    arrays: [],
  },
  {
    path: '/actor-media',
    name: 'get_actor_media',
    description: 'Get posts with image or video attachments from an actor',
    schema: getActorMediaSchema,
    handler: publicOnly(getActorMedia),
    numbers: ['limit'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/search-actor-content',
    name: 'search_actor_content',
    description: 'Full-text search across all stored posts from an actor or all followed actors',
    schema: searchActorContentSchema,
    handler: publicOnly(searchActorContent),
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
    description: 'Get BookWyrm reading events for an actor, derived from stored note posts with a normalized event_type field: started_reading, finished_reading, review, rating, comment, quotation, note, shelved. Events carry derived signal dates (started_date/finished_date), the book\'s overall window (book_started_date/book_finished_date), inline rating, review_title, quote (for quotations), and progress/progress_mode when present. Defaults to newest-first; set sort_order=asc with limit=1 for the earliest event, and follow next_cursor for deep traversal.',
    schema: getReadingEventsSchema,
    handler: getReadingEvents,
    numbers: ['limit'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/reading-stats',
    name: 'get_reading_stats',
    description: "Aggregate reading statistics for an actor's BookWyrm books: total/average/median page counts, reading span, ratings distribution, a per-format breakdown, and a top-N breakdown by year, month, format, author, rating, series, or subject (subject is multi-valued: a book counts once per subject). Defaults to the read shelf and group_by=year; filter by year/from/to (on finish date), format, author, or rating. Page averages report coverage (pages_coverage), and avg_pages_prose excludes comics and audiobooks.",
    schema: getReadingStatsSchema,
    handler: getReadingStats,
    numbers: ['limit', 'year', 'rating'],
    booleans: ['include_hidden'],
    arrays: [],
  },
  {
    path: '/reading-pace',
    name: 'get_reading_pace',
    description: "Reading pace and session analytics over derived start→finish reading cycles (day granularity, from public statuses): per finished cycle days_to_finish and pages_per_day, reread detection, overlap periods where 2+ books were open at once, and summary aggregates (avg/median days to finish, avg pages/day, fastest/slowest, max concurrent books, start_coverage). Filter by year/from/to on the cycle's finish date; sort=finished (default) | fastest | slowest.",
    schema: getReadingPaceSchema,
    handler: getReadingPace,
    numbers: ['limit', 'year'],
    booleans: ['include_hidden'],
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
    path: '/scrobble-race',
    name: 'get_scrobble_race',
    description: 'Head-to-head standings between two artists in the scrobble history: exact all-time play counts, the gap, plays needed to level and to overtake, plays/day over a trailing window, and a projected crossover date. Defaults to the configured race; pass leader/challenger to race any two artists. Artist names are matched EXACTLY here, unlike /scrobble-stats.',
    schema: getScrobbleRaceSchema,
    handler: getScrobbleRace,
    numbers: ['pace_days'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/post-breakouts',
    name: 'get_post_breakouts',
    description: "The state of the post-breakout notifier: for each watched account, where its own engagement bar sits (median / p90 / p99 over a rolling window, plus the all-time record), the thresholds a post must reach, which posts are armed to fire right now, and which have already been announced. A post's score is favourites*1 + reblogs*3 + replies*2 (configurable) and is always its PEAK across the whole snapshot history, never the latest reading. Computed live from the archive rather than from the notifier's state, so it answers correctly even when notifications are unconfigured. NOTE: this endpoint is public-only, so the percentiles and lists here are computed over public posts alone and can differ from the MCP tool's, which sees the whole archive.",
    schema: getPostBreakoutsSchema,
    // Carries post text and URLs, so it is bound to the public-only scope like every
    // other REST endpoint that serves post rows. See ADR 0026.
    handler: publicOnly(getPostBreakouts),
    numbers: ['days', 'limit'],
    booleans: [],
    arrays: [],
  },
  {
    path: '/now-playing',
    name: 'get_now_playing',
    description: "Get the Last.fm user's currently-playing track as a live read (not a stored scrobble). Returns { nowPlaying: true, track, artist, album, image, url } when something is playing, { nowPlaying: false } when Last.fm answered and nothing is, and { nowPlaying: null, error } when the upstream read failed or Last.fm is not configured — an outage is never reported as silence. Note this stays false mid-song for a scrobbler that never sends track.updateNowPlaying, which is the common case here.",
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
    path: '/trip-posts',
    name: 'get_trip_posts',
    description: 'The posts made on a given train trip, and the trip a given post was made on — a derived join between the viaduct.world trips and the archived posts, matched on time. Each row carries the post plus its trip\'s stations, operator, rolling stock, distance and delay, and how the post relates to the trip: boarding (the 30 min before departure), aboard, or alighting (the 30 min after arrival). Filter by journey, station, operator, relation, hashtag (e.g. tag=togselfie), year or time window; with_media_only=true narrows to posts carrying an image or video.',
    schema: getTripPostsSchema,
    handler: publicOnly(getTripPosts),
    numbers: ['limit', 'page', 'year'],
    booleans: ['with_media_only'],
    arrays: [],
  },
  {
    path: '/trip-weather',
    name: 'get_trip_weather',
    description: "The weather Markus travelled through: each train trip joined to the conditions at its origin on the departure date and its destination on the arrival date, from Open-Meteo's ERA5 archive. Filter by journey, station, operator, year, time window, condition (Nynorsk: snø/regn/klårvêr…), or a temperature range; with_weather_only drops trips with nothing on record. Every response states coverage.",
    schema: getTripWeatherSchema,
    handler: getTripWeather,
    numbers: ['limit', 'page', 'year', 'min_temp', 'max_temp'],
    booleans: ['with_weather_only'],
    arrays: [],
  },
  {
    path: '/railway-lines',
    name: 'list_railway_lines',
    description: 'Every named railway line and fixed link the archive knows about: canonical name, aliases, countries, registry length, and whether Markus has travelled it — with trip count, on-line kilometres, crossing count and first/last traversal for the ones he has. Filter by kind (line/crossing), country code, travelled true/false, or a free-text name search. The registry is curated by hand rather than derived from OpenStreetMap.',
    schema: listRailwayLinesSchema,
    handler: listRailwayLines,
    numbers: ['limit'],
    booleans: ['travelled'],
    arrays: [],
  },
  {
    path: '/line-stats',
    name: 'get_line_stats',
    description: 'Aggregates for one named railway line or crossing: trips, on-line kilometres, time aboard, first and last traversal, and a breakdown by year, operator or journey. For a bridge or tunnel it returns a crossing count — each traversal counted once, in either direction. Names resolve through aliases, case and diacritics, and an unknown name comes back with the closest matches. Trips that have not departed are excluded from the totals and listed separately under "upcoming". Every response states coverage and names any pinned routing behind the numbers.',
    schema: getLineStatsSchema,
    handler: getLineStats,
    numbers: ['limit', 'year'],
    booleans: ['include_planned'],
    arrays: [],
  },
  {
    path: '/line-trips',
    name: 'get_line_trips',
    description: "The individual legs that touched a named line or crossing, each with its prorated on-line distance and duration, its share of the whole trip, and how the routing was decided — so the totals from /line-stats can be audited leg by leg. Rows carry the unscaled registry kilometres and the scale factor applied to reach the trip's recorded distance, plus the reason for any pinned routing.",
    schema: getLineTripsSchema,
    handler: getLineTrips,
    numbers: ['limit', 'page', 'year'],
    booleans: ['include_planned'],
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
    description: "Get full enriched metadata for one BookWyrm book from the local cache, resolved by book_url (the Edition AP id), isbn (13 or 10), or a partial title. Returns title, subtitle, author, series, pages, physical_format, isbn13/isbn10, pub_year, language, original_language, publisher, cover_url, description, and subjects — each matched to the edition's resolved ISBN, with isbn_source/page_source/source_map provenance.",
    schema: getBookDetailsSchema,
    handler: getBookDetails,
    numbers: [],
    booleans: ['include_hidden'],
    arrays: [],
  },
  {
    path: '/books',
    name: 'get_books',
    description: "Browse all cached BookWyrm book metadata as a paginated catalogue. Returns compact rows (book_url, title, subtitle, author, series, pages, physical_format, isbn13/isbn10, pub_year, language, publisher, cover_url, subjects, fetched_at) — call get_book_details for the full record (description, provenance) of one book. Filter by title (partial match), author (partial match), format, language, series (partial match), or subject (partial match against any subject/genre). Most-recently-enriched first by default (sort_order='asc' for oldest first). Each response carries `total` (matching books across all pages) and a `next_cursor` token; pass it back as `cursor` for deep traversal, or use the legacy offset `page`.",
    schema: getBooksSchema,
    handler: getBooks,
    numbers: ['limit', 'page'],
    booleans: ['include_hidden'],
    arrays: [],
  },
  {
    path: '/watched',
    name: 'get_watched',
    description: "Browse the cached NeoDB catalogue (ALL categories) as a paginated table — every item behind this server's stored NeoDB marks, enriched from the linked catalog item. Filter by `category`: tv, movie, book, music, game, podcast, performance. Common fields on every row (item_url, category, item_type, title/display_title/orig_title, year, cover_url, description, genre, language, area, rating, external_resources, fetched_at); film/TV columns (season_number, episode_count, imdb/imdb_url, tmdb_url, director, actors); and a per-category `details` object (book author/isbn/pages/publisher + bookwyrm_book_url; music artist/release_date/track_count/barcode; game developer/publisher/platform; podcast host/feed_url; performance playwright/director/troupe/venue/opening_date). Every row also carries mark_comments (the note(s) the mark(s) carried, verbatim and unparsed, newest first) and the shelf date: watched_at (when it was actually watched/read/played/listened to — NOT the post timestamp; the newest date when an item was marked more than once) plus watched_dates (every distinct date, newest first). Filter by title/category/item_type/genre/mark_comment (partial) or exact imdb id; narrow to a period with watched_from/watched_to (YYYY-MM-DD, UTC, both ends inclusive) or watched_year=2016 sugar; include_unenriched=true also returns pending/failed rows. sort_by=watched_at orders by the shelf date (sort_order=asc for oldest first) — the default sort_by=fetched_at is enrichment time, which for a backfilled import is just the order the import ran in. Carries `total` and `next_cursor` (or legacy offset `page`). Use /catalogue-details for one item's full record + provenance.",
    schema: getWatchedSchema,
    handler: getWatched,
    numbers: ['limit', 'page', 'watched_year'],
    booleans: ['include_unenriched', 'include_hidden'],
    arrays: [],
  },
  {
    path: '/catalogue-details',
    name: 'get_catalogue_details',
    description: "Get one NeoDB catalogue item's full cached record, resolved by item_url (exact) or a partial title (pass category to disambiguate). Returns the common fields, mark_comments (the note(s) the mark(s) carried, verbatim), watched_at/watched_dates (the shelf date(s) — when it was watched/read/played, not when the mark was posted), film/TV columns, and the category-specific `details` object, plus bookwyrm_book_url (book↔BookWyrm dedup link), source_map (per-field 'neodb'|'bookwyrm' provenance), and enrichment status (fetched_at, fetch_error, fetch_attempts, last_attempt_at). The catalogue sibling of /book-details.",
    schema: getCatalogueDetailsSchema,
    handler: getCatalogueDetails,
    numbers: [],
    booleans: ['include_hidden'],
    arrays: [],
  },
  {
    path: '/gigs',
    name: 'get_gigs',
    description: "Browse the concert log as a paginated table — every gig behind this server's stored Gigowl (samklang.msge.no) attendances, enriched from the linked concert record. Each row: concert_url, title, gig_date, start_at, doors_time, concert_status, tour_name, festival_name, notes, a venue object (url/name/city/country), lineup (artistUrl, name, role — headliner/opener/guest — position), artist_names, rsvp_status + status_source, reviews (write-ups, verbatim, newest first), photos with alt text, song_count, logged_at, fetched_at. TWO DATES, NEVER INTERCHANGEABLE: gig_date is the night of the gig (the default sort, newest first); logged_at is when the attendance was posted, which for an imported archive says nothing about when anything happened. status_source tells you whether the RSVP state was published as data by the origin ('tag'/'property') or read off the generated opening sentence ('template'). Filter by artist/venue/city/country/festival/tour/song/q (partial), status, concert_status, from/to or year (all on the night of the gig), has_review, has_setlist; include_unenriched=true also returns pending/failed rows. Carries `total` and `next_cursor` (or legacy offset `page`). Use /gig-details for one gig's full record including its setlist.",
    schema: getGigsSchema,
    handler: getGigs,
    numbers: ['limit', 'page', 'year'],
    booleans: ['has_review', 'has_setlist', 'include_unenriched', 'include_hidden'],
    arrays: [],
  },
  {
    path: '/gig-details',
    name: 'get_gig_details',
    description: "Get one gig's full record, resolved by concert_url (exact) or a partial title. Returns everything /gigs returns plus the complete setlists array (per artist; each entry with position, setNumber, isEncore, songTitle, isCover, coverOfArtist, note), the venue's own catalogue record when fetched (aka, coordinates, capacity, timezone, wikidata_qid, is_placeholder), the `details` object, source_map (per-field 'samklang-ap'|'samklang-jsonld' provenance), and enrichment status. The gig sibling of /catalogue-details.",
    schema: getGigDetailsSchema,
    handler: getGigDetails,
    numbers: [],
    booleans: ['include_hidden'],
    arrays: [],
  },
  {
    path: '/gig-stats',
    name: 'get_gig_stats',
    description: "Aggregate the concert log: totals (gigs, distinct artists/venues/cities/countries, first and last gig, gigs with a setlist or a write-up, songs on record) plus breakdowns by_status, by_year, top_artists, top_venues, top_cities and top_songs. Bound with from/to or year, narrow with status, size the breakdowns with `top` (default 10). top_songs and songs_played count only what a setlist records — \"songs I have a record of\", not \"songs I heard\". The gig sibling of /reading-stats.",
    schema: getGigStatsSchema,
    handler: getGigStats,
    numbers: ['top', 'year'],
    booleans: ['include_hidden'],
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
  // LinkedIn. `publicOnly` here means LinkedIn's own visibility field, not the
  // ActivityPub addressing `scopeCondition` reads — same rule as ADR 0026, applied
  // to the vocabulary this source actually uses. A post whose visibility could not
  // be read is withheld rather than assumed public, so metric rows that arrived
  // before the poller ingested the post stay off this surface until it has.
  {
    path: '/linkedin-posts',
    name: 'get_linkedin_posts',
    description: "Markus' LinkedIn posts with their latest performance numbers attached. Post text comes from LinkedIn's DMA snapshot API, impressions/engagements from a monthly .xlsx export, joined on the post id. latest_metrics is the most recent export's figures, not a lifetime total. Filter with from/to on publish date (calendar days, Europe/Oslo), visibility, and has_metrics. Offset paging via page/limit. REST serves publicly-visible posts only.",
    schema: getLinkedinPostsSchema,
    handler: publicOnly(getLinkedinPosts),
    numbers: ['limit', 'page'],
    booleans: ['has_metrics'],
    arrays: [],
  },
  {
    path: '/linkedin-post',
    name: 'get_linkedin_post',
    description: "One LinkedIn post with its full metric history. Accepts either URL form (the /feed/update/urn:li:activity: permalink or the /posts/…-ugcPost-<id>-<hash> share link) or the bare numeric post_key. metrics_history is one row per monthly export, oldest first — a reach-decay series, since the export's impressions are a windowed accumulation rather than a running total. REST serves publicly-visible posts only.",
    schema: getLinkedinPostSchema,
    handler: publicOnly(getLinkedinPost),
    numbers: [],
    booleans: [],
    arrays: [],
  },
  {
    path: '/linkedin-stats',
    name: 'get_linkedin_stats',
    description: "Aggregate LinkedIn performance, including the median engagement rate per weekday (Europe/Oslo, over each post's latest observation). Every by_weekday bucket carries `n` so thin buckets are visible. totals carry p25/p75 for impressions and rate. source_health reports whether the DMA token is still working. REST aggregates publicly-visible posts only, so its figures can differ from MCP's.",
    schema: getLinkedinStatsSchema,
    handler: publicOnly(getLinkedinStats),
    numbers: [],
    booleans: [],
    arrays: [],
  },
]
