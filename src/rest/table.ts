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
    description: 'Get BookWyrm reading status for an actor by querying the live shelf (use_live: true, default) or local DB. With use_live: false, shelves (reading/read/to-read) are derived from the actor\'s stored reading note posts; ratings and cover art are only available via the live shelf. Returns title, authors, cover, shelf, started_date, finished_date, rating, and bookwyrm_book_url per book.',
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
    description: 'Get pages from the markus.plus "Tankehav" digital garden (an Obsidian Publish site): title, url, section, excerpt, image and an optional date per page, plus a section roll-up. Filter by section; dated pages sort by date, undated pages sort after alphabetically.',
    schema: getGardenPagesSchema,
    handler: getGardenPages,
    numbers: ['limit'],
    booleans: [],
    arrays: [],
  },
]
