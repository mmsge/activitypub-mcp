import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getActorPostsSchema, getActorPosts } from './tools/actor-posts.js'
import { getActorReadingStatusSchema, getActorReadingStatus } from './tools/actor-reading.js'
import { getActorMediaSchema, getActorMedia } from './tools/actor-media.js'
import { searchActorContentSchema, searchActorContent } from './tools/actor-search.js'
import { getFollowsSchema, getFollows } from './tools/follows.js'
import { getActivityStatsSchema, getActivityStats, getRecentActivitiesSchema, getRecentActivities } from './tools/activity-stats.js'
import { getReadingEventsSchema, getReadingEvents } from './tools/reading-events.js'
import { getReadingStatsSchema, getReadingStats } from './tools/reading-stats.js'
import { getReadingPaceSchema, getReadingPace } from './tools/reading-pace.js'
import { getScrobblesSchema, getScrobbles, getScrobbleStatsSchema, getScrobbleStats } from './tools/scrobbles.js'
import { getScrobbleRaceSchema, getScrobbleRace } from './tools/scrobble-race.js'
import { getPostBreakoutsSchema, getPostBreakouts } from './tools/post-breakouts.js'
import { getNowPlayingSchema, getNowPlaying } from './tools/now-playing.js'
import { getTrainTripsSchema, getTrainTrips, getTrainStatsSchema, getTrainStats } from './tools/train-trips.js'
import { getTripPostsSchema, getTripPosts } from './tools/trip-posts.js'
import { getTripWeatherSchema, getTripWeather } from './tools/trip-weather.js'
import {
  listRailwayLinesSchema, listRailwayLines,
  getLineStatsSchema, getLineStats,
  getLineTripsSchema, getLineTrips,
} from './tools/railway-lines.js'
import { getGardenPagesSchema, getGardenPages } from './tools/garden-pages.js'
import { getGardenPageSchema, getGardenPage } from './tools/garden-page.js'
import { getBookDetailsSchema, getBookDetails } from './tools/book-details.js'
import { getBooksSchema, getBooks } from './tools/books.js'
import { getWatchedSchema, getWatched, getCatalogueDetailsSchema, getCatalogueDetails } from './tools/watched.js'
import { getGigsSchema, getGigs, getGigDetailsSchema, getGigDetails, getGigStatsSchema, getGigStats } from './tools/gigs.js'
import { getHashtagStatsSchema, getHashtagStats, getHashtagTrendsSchema, getHashtagTrends } from './tools/hashtag-stats.js'
import { getEngagementSchema, getEngagement, getEngagementTrendsSchema, getEngagementTrends } from './tools/engagement.js'
import { getActorEngagementTrendsSchema, getActorEngagementTrends } from './tools/actor-engagement-trends.js'
import { getLinkedinPostsSchema, getLinkedinPosts, getLinkedinPostSchema, getLinkedinPost } from './tools/linkedin-posts.js'
import { getLinkedinStatsSchema, getLinkedinStats } from './tools/linkedin-stats.js'

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
    "Get BookWyrm reading status for an actor by querying the live shelf (use_live: true, default) or local DB. BookWyrm shelf collections are bare Edition objects, so BOTH modes derive started_date/finished_date/rating from the actor's stored public statuses (day granularity: the first \"reading\" status starts a book; a \"read\" status or a review finishes it) — the live mode merges those onto the authoritative shelf rows by Edition URL (title fallback) and adds shelved_date when the shelf carries it. Cover, pages and language are backfilled from the cached book_metadata where that book has been enriched (the live shelf is still ground truth for cover art). Returns title, authors, cover, shelf, started_date, finished_date, rating, bookwyrm_book_url, pages, language, and shelved_date per book.",
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
    "List the actors this server is following, with follow status. Each entry includes `software` (the origin's NodeInfo software name, e.g. 'mastodon', 'pixelfed', 'bookwyrm', 'loops') and a human-facing `service` label (e.g. \"BookWyrm\") so you can tell which followed account belongs to which service — handy for picking the right actor_handle to scope other tools. software/service are null until probed.",
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
    "Get BookWyrm reading events for an actor, derived from stored note posts with a normalized event_type field: started_reading, finished_reading, review, rating, comment, quotation, note, shelved. Every event carries the derived signal dates (started_date/finished_date when THIS event marks a start/finish — a \"read\"-status comment or a review counts as a finish) plus the book's overall derived window (book_started_date/book_finished_date, day granularity from public statuses). Reviews carry rating (inline, coalesced from the raw AP object) and review_title; quotations carry the quoted passage in `quote`; comments/quotations may carry progress/progress_mode when the reader logged a position. Useful for building a reading timeline or finding when a book was started vs finished. Defaults to newest-first; set sort_order='asc' with limit=1 to fetch the earliest reading event in one call, and follow the next_cursor token for deep traversal.",
    getReadingEventsSchema.shape,
    async (input) => {
      const result = await getReadingEvents(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_reading_stats',
    "Aggregate reading statistics for an actor's BookWyrm books: total/average/median page counts, reading span, ratings distribution, and a per-format breakdown, with a top-N breakdown by year, month, format, author, rating, series, or subject (subject is multi-valued: a book counts once per subject). Page/format/year/series/subject data — and each book's canonical title/author — comes from cached BookWyrm Edition metadata (with the parsed status and live shelf as fallbacks); finish dates are derived from the actor's public statuses (a \"read\" comment or a review marks the finish). Defaults to the \"read\" shelf and group_by=year; filter by year/from/to (on finish date), format, author, or rating. Page averages are reported over books with known page counts (see pages_coverage), and avg_pages_prose excludes comics/graphic novels and audiobooks so a comics-heavy span doesn't skew the prose number.",
    getReadingStatsSchema.shape,
    async (input) => {
      const result = await getReadingStats(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_reading_pace',
    "Reading pace and session analytics for an actor's BookWyrm books, computed over derived start→finish reading cycles (day granularity, from public statuses): per finished cycle days_to_finish and pages_per_day (needs a known start date and page count — coverage is reported in start_coverage), reread detection (a book with multiple cycles), overlap periods where 2+ books were being read at once, and summary aggregates (avg/median days to finish, avg pages/day, fastest/slowest, max concurrent books). Every cycle carries the book's title/author, resolved from cached Edition metadata (parsed status and live shelf as fallbacks), so series questions need no extra lookups. Filter by year/from/to on the cycle's finish date; sort by finished (default, most recent first), fastest, or slowest.",
    getReadingPaceSchema.shape,
    async (input) => {
      const result = await getReadingPace(input as any)
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
    'get_scrobble_race',
    "Head-to-head standings between two artists in the Last.fm scrobble history: exact all-time play counts, the gap, plays needed to level and to overtake, plays/day over a trailing window, and a projected crossover date. Defaults to the configured race (RACE_LEADER_ARTIST vs RACE_CHALLENGER_ARTIST) — pass leader/challenger to race any two artists. Artist names are matched EXACTLY here, unlike get_scrobble_stats, which does a substring match.",
    getScrobbleRaceSchema.shape,
    async (input) => {
      const result = await getScrobbleRace(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_post_breakouts',
    "The state of the post-breakout notifier: for each watched account, where its own engagement bar sits (median / p90 / p99 over a rolling window, plus the all-time record), the thresholds a post must actually reach, which posts are armed to fire an alert right now, and which have already been announced. A post's score is favourites*1 + reblogs*3 + replies*2 (configurable) and is always its PEAK across the whole snapshot history, never the latest reading — engagement counts go down, and a withdrawn favourite must not lower the bar or re-arm a spent rung. Baselines, thresholds and `armed` are computed live from the archive rather than read from the notifier's state, so this answers correctly even when notifications are unconfigured: `armed` non-empty with nothing arriving on the phone means the push is failing, not that nothing qualifies. `baseline.established` is false for an account with too few sampled posts for a percentile to mean anything — nothing fires there at all.",
    getPostBreakoutsSchema.shape,
    async (input) => {
      const result = await getPostBreakouts(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_now_playing',
    "Get the Last.fm user's currently-playing track as a live read (not a stored scrobble). Returns { nowPlaying: true, track, artist, album, image, url } when something is playing, { nowPlaying: false } when Last.fm answered and nothing is, and { nowPlaying: null, error } when the upstream read failed or Last.fm is not configured — an outage is never reported as silence. Note this stays false mid-song for a scrobbler that never sends track.updateNowPlaying, which is the common case here.",
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
    'get_trip_posts',
    "The posts Markus made on a given train trip, and the trip a given post was made on — a derived join between the viaduct.world trips and the archived posts, matched on time (see ADR 0023). Each row carries the post plus its trip's stations, operator, rolling stock, distance and delay, and how the post relates to the trip: boarding (the 30 min before departure), aboard, or alighting (the 30 min after arrival). Filter by journey, station, operator, relation, hashtag (e.g. tag=\"togselfie\"), year or time window; with_media_only=true narrows to photos. Answers \"what did I post on Sjælland rundt?\" and \"which train was I on when I posted this?\"",
    getTripPostsSchema.shape,
    async (input) => {
      const result = await getTripPosts(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_trip_weather',
    "The weather Markus travelled through: each train trip joined to the conditions at its origin on the departure date and its destination on the arrival date (local calendar days, from Open-Meteo's ERA5 archive). Answers \"what was the weather on the Bergensbanen that day\", \"how many trips did I take in snow\", \"the coldest journey\". Filter by journey, station, operator, year, time window, condition (Nynorsk: snø/regn/klårvêr…), or a temperature range; with_weather_only drops trips with nothing on record. Every response states coverage, so a thin result reads as not-yet-fetched rather than never-happened.",
    getTripWeatherSchema.shape,
    async (input) => {
      const result = await getTripWeather(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'list_railway_lines',
    "Every named railway line and fixed link the archive knows about: canonical name, aliases, countries, registry length, and whether Markus has travelled it — with his trip count, on-line kilometres, crossing count and first/last traversal for the ones he has. Filter by kind (line/crossing), country code, travelled true/false, or a free-text name search. The registry is curated by hand rather than derived from OpenStreetMap (ADR 0035), so this is also the list of what get_line_stats can answer for.",
    listRailwayLinesSchema.shape,
    async (input) => {
      const result = await listRailwayLines(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_line_stats',
    "Aggregates for one named railway line or crossing: trips, on-line kilometres, time aboard, first and last traversal, and a breakdown by year, operator or journey. Answers \"how many kilometres have I done on Bergensbanen?\" in one call, and for a bridge or tunnel returns a crossing count — each traversal counted once, in either direction, so an out-and-back day trip counts two. Names resolve through aliases, case and diacritics: \"Bergensbanen\", \"Bergen Line\" and \"bergensbana\" are one line, as are \"Öresundsbron\", \"Øresundsbroen\" and \"Öresundsbroa\"; an unknown name comes back with the closest matches. Accepts the usual journey/operator/station/mode/status/tag filters and a year scope. Trips that have not departed are excluded from the totals and listed separately under \"upcoming\", so the trip currently under way counts but next month's does not. Every response states coverage and names any pinned routing behind the numbers.",
    getLineStatsSchema.shape,
    async (input) => {
      const result = await getLineStats(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_line_trips',
    "The individual legs that touched a named line or crossing, each with its prorated on-line distance and duration, its share of the whole trip, and how the routing was decided — so the totals from get_line_stats can be audited leg by leg. Rows carry the unscaled registry kilometres and the scale factor applied to reach the trip's recorded distance, plus the reason for any pinned routing. Same filters as get_line_stats.",
    getLineTripsSchema.shape,
    async (input) => {
      const result = await getLineTrips(input as any)
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
    "Get full enriched metadata for one BookWyrm book from the local cache, resolved by book_url (the Edition AP id), isbn (13 or 10), or a partial title. Returns title, subtitle, author, series, pages, physical_format, isbn13/isbn10, pub_year, language and original_language, publisher, cover_url, description, and subjects — each matched to the edition's resolved ISBN. isbn_source/page_source/source_map record where each value came from (bookwyrm Edition, markus.plus review, OpenLibrary, or Google Books).",
    getBookDetailsSchema.shape,
    async (input) => {
      const result = await getBookDetails(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_books',
    "Browse all cached BookWyrm book metadata as a paginated catalogue. Returns compact rows (book_url, title, subtitle, author, series, pages, physical_format, isbn13/isbn10, pub_year, language, publisher, cover_url, subjects, fetched_at) — call get_book_details for the full record (description, provenance) of one book. Filter by title (partial match), author (partial match), format, language, series (partial match), or subject (partial match against any subject/genre). Most-recently-enriched first by default (sort_order='asc' for oldest first). Each response carries `total` (matching books across all pages) and a `next_cursor` token; pass it back as `cursor` for deep traversal, or use the legacy offset `page`.",
    getBooksSchema.shape,
    async (input) => {
      const result = await getBooks(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_watched',
    "Browse the cached NeoDB catalogue as a paginated table — every item behind this server's stored NeoDB marks (\"finished watching …\", \"played …\", \"listened to …\", \"read …\"), enriched from the catalog item the federated mark only links to. Covers ALL categories, filterable by `category`: tv, movie, book, music, game, podcast, performance (and any future one). COMMON fields on every row: item_url, category, item_type, title/display_title/orig_title, year, cover_url, description, genre, language, area, rating, external_resources, fetched_at. FILM/TV columns (null elsewhere): season_number, episode_count, imdb + imdb_url, tmdb_url, director, actors. CATEGORY-SPECIFIC fields live in the `details` object per row — book: author, isbn, pages, publisher (deduped to a BookWyrm Edition via bookwyrm_book_url when the ISBN matches); music: artist, release_date, track_count, barcode; game: developer, publisher, platform, release_date; podcast: host, feed_url; performance: playwright, director, troupe, venue, opening_date. Every row also carries mark_comments: the note(s) the mark(s) carried, verbatim and unparsed (e.g. \"Sett på kino.\" — where a film was seen), newest mark first, duplicates collapsed, [] when none. THE SHELF DATE — when the thing was actually watched/read/played/listened to — is watched_at (ISO timestamp, null when the mark carried none; for an item marked more than once it is the newest of watched_dates, which lists every distinct date, newest first). It is NOT the post timestamp: a 2016 film backfilled today has watched_at 2016 and a get_actor_posts published_at of today. Filter by title (partial), category, item_type, genre (partial), an exact imdb id, or mark_comment (partial match against those notes — \"kino\" finds every film seen at the cinema); narrow to a period with watched_from/watched_to (\"YYYY-MM-DD\" covers the whole day in UTC, or pass a full ISO timestamp) or the watched_year sugar (watched_year:2016 = everything watched in 2016) — an item matches if ANY of its marks falls in the window, so a re-watched film appears under both years; include_unenriched:true also returns pending/failed rows (with fetch_error/fetch_attempts). sort_by:'watched_at' orders by the shelf date, oldest or newest first via sort_order (items with no date sort last either way); the default sort_by:'fetched_at' is enrichment time, which for a backfilled import is only the order the import ran in. Carries `total` and a `next_cursor` (or legacy offset `page`). For one item's full record + per-field provenance use get_catalogue_details; for the mark itself (when/what) use get_actor_posts.",
    getWatchedSchema.shape,
    async (input) => {
      const result = await getWatched(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_catalogue_details',
    "Get one NeoDB catalogue item's full cached record, resolved by item_url (the NeoDB catalog URL, exact) or a partial title (most-recently-enriched wins; pass category to disambiguate). Returns the common fields, mark_comments (the note(s) the mark(s) carried, verbatim), watched_at and watched_dates (the shelf date(s) — when it was watched/read/played/listened to, not when the mark was posted; watched_at is the newest, null when unknown), the film/TV columns, and the category-specific `details` object (book: author/isbn/pages/publisher; music: artist/release_date/track_count/barcode; game: developer/publisher/platform/release_date; podcast: host/feed_url; performance: playwright/director/troupe/venue/opening_date), plus bookwyrm_book_url (set when a book deduped to a BookWyrm Edition), source_map (per-field provenance: 'neodb' or 'bookwyrm'), and enrichment status (fetched_at, fetch_error, fetch_attempts, last_attempt_at). The catalogue sibling of get_book_details.",
    getCatalogueDetailsSchema.shape,
    async (input) => {
      const result = await getCatalogueDetails(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_gigs',
    "Browse the concert log as a paginated table — every gig behind this server's stored Gigowl (samklang.msge.no) attendances, enriched from the concert record the federated Note only links to. Each row carries: concert_url, title, gig_date, start_at, doors_time, concert_status, tour_name, festival_name, notes, a venue object (url/name/city/country), lineup (artistUrl, name, role — headliner/opener/guest — and position), artist_names, rsvp_status + status_source, reviews (the write-up(s), verbatim, newest first, [] when none), photos (with alt text), song_count, logged_at and fetched_at. TWO DATES, NEVER INTERCHANGEABLE: gig_date is the night of the gig and is what you almost always want; logged_at is when the attendance was posted, which for an imported archive is the order the import ran in — a gig from 2022 entered in 2026 has gig_date 2022 and logged_at 2026. sort_by defaults to gig_date, newest first. RSVP STATE (interested/going/attended) comes from status_source: 'tag' or 'property' means the origin published it as data; 'template' means it was read off the generated Nynorsk opening sentence, which is all that attendances logged before the origin published it as data carry — treat those as derived, and note that a state the parser did not recognise is null rather than a guess. Filter by artist (partial, matches support acts too), venue, city, country (ISO alpha-2), festival, tour, song (a title in the setlist), q (free text over title, notes and write-ups), status (RSVP), concert_status (scheduled/cancelled/postponed/completed), a from/to window or the year sugar (all on the NIGHT of the gig), has_review, has_setlist; include_unenriched:true also returns pending/failed rows, include_hidden:true rows an admin hid. SETLISTS are only ever as complete as the origin serves them — song_count is null for a gig nobody recorded one for, which is not the same as a gig with no songs. Carries `total` and a `next_cursor` (or legacy offset `page`). For one gig in full, including the setlist and the venue's own record, use get_gig_details; for aggregates use get_gig_stats.",
    getGigsSchema.shape,
    async (input) => {
      const result = await getGigs(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_gig_details',
    "Get one gig's full record, resolved by concert_url (exact) or a partial title (the most recent match wins). Returns everything get_gigs returns plus: the complete setlists array (per artist, each entry with position, setNumber, isEncore, songTitle, isCover, coverOfArtist and note — encores and covers are the two things a setlist is read for), the venue's own catalogue record when it has been fetched (aka names, coordinates, capacity, timezone, wikidata_qid, is_placeholder — a placeholder venue means the venue was genuinely not announced, not that data is missing), the category-specific `details`, source_map (per-field provenance: 'samklang-ap' or 'samklang-jsonld' — the ActivityPub representation is the more complete of the two and wins wherever it spoke), and enrichment status (fetched_at, enriched_at, fetch_error, fetch_attempts). Returns an `error` field rather than throwing when nothing matches. The gig sibling of get_catalogue_details.",
    getGigDetailsSchema.shape,
    async (input) => {
      const result = await getGigDetails(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_gig_stats',
    "Aggregate the concert log: how many gigs, how many distinct artists, venues, cities and countries, the first and last gig, how many carry a setlist or a write-up, and how many songs are on record. Plus breakdowns — by_status (RSVP), by_year (gigs per calendar year, by the night of the gig), top_artists, top_venues, top_cities and top_songs (the songs heard most often across recorded setlists). Bound it with from/to or the year sugar, narrow to one RSVP state with status, and set `top` for how many entries each breakdown returns (default 10). CAVEAT on top_songs and songs_played: they count only what a setlist records, so they are \"songs I have a record of\", never \"songs I heard\" — a gig nobody wrote a setlist for contributes nothing. Artist and venue totals are keyed on NAME, so two artists sharing a name count once. The gig sibling of get_reading_stats.",
    getGigStatsSchema.shape,
    async (input) => {
      const result = await getGigStats(input as any)
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

  server.tool(
    'get_linkedin_posts',
    "List Markus' LinkedIn posts with their latest performance numbers attached. Two sources feed this and neither is a subset of the other: post text, visibility and attached link come from LinkedIn's DMA Member Snapshot API (polled weekly); impressions and engagements come from an .xlsx he exports by hand each month. So a post can have text but no numbers yet (posted since the last export, latest_metrics null) or numbers but no text (has_content false — the poller has not reached it); both are listed. latest_metrics carries the MOST RECENT export's figures, not a lifetime total: LinkedIn's impressions are a windowed accumulation, so use get_linkedin_post for the full observation series. engagement_rate is engagements/impressions, computed not stored, and null when impressions are 0 or engagements are unknown (the export's engagement block only covers the top ~14 posts, so lower-reach posts legitimately have impressions and no engagements). Filter with from/to on the publish date (calendar days, Europe/Oslo) and visibility. The archive is tens of posts, so page/limit offset paging is all there is — no cursor.",
    getLinkedinPostsSchema.shape,
    async (input) => {
      const result = await getLinkedinPosts(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_linkedin_post',
    "Fetch one LinkedIn post with its FULL metric history. Accepts either URL form LinkedIn uses — the /feed/update/urn:li:activity:<id> permalink or the /posts/<slug>-ugcPost-<id>-<hash> share link — or the bare numeric post_key; all reduce to the same post. metrics_history is one row per monthly export, oldest first. Because the export's impressions are a windowed accumulation rather than a lifetime total, successive rows are genuinely different observations and the series is a reach-decay curve, NOT a list of corrections to one number: a later row showing fewer impressions means the post stopped being served, not that the earlier figure was wrong. engagement_rate per row is engagements/impressions, null when either is missing.",
    getLinkedinPostSchema.shape,
    async (input) => {
      const result = await getLinkedinPost(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_linkedin_stats',
    "Aggregate LinkedIn performance, including the MEDIAN ENGAGEMENT RATE PER WEEKDAY — the number to use when advising on posting times, in place of any hardcoded weekday ranking. Medians rather than means, because one viral post otherwise decides the ranking; over each post's LATEST observation only, so a post that stayed in the top 50 for four months is counted once, not four times; bucketed by weekday in Europe/Oslo, so a post published at 00:30 CEST is not filed under the previous day. Every by_weekday bucket reports `n` (posts with a usable rate) beside its medians — with an archive this size a weekday can rest on one or two posts, so a ranking that ignores n will overstate what the data supports. totals also carry p25/p75 for impressions and rate, i.e. the middle half of his posts, which is what a single post's result should be judged against. source_health reports the state of the ingest, and the distinction matters before drawing any conclusion from a trend. `ok` — data is flowing. `stale` / `unauthorized` — the numbers STOPPED moving at last_success_at, so a recent dip is about the outage, not the audience. `awaiting_data` — the poller is working but LinkedIn has never yet handed over the posts (it collates the snapshot's activity domains after the profile ones, with no published timing), so the numbers never STARTED: an empty or thin result here means the ingest has not begun, not that he stopped posting. `never_run` — the poller has not been configured. `last_data_at` is when posts actually last arrived, which is a different question from when the job last ran.",
    getLinkedinStatsSchema.shape,
    async (input) => {
      const result = await getLinkedinStats(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  return server
}
