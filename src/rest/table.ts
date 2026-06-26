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
    description: 'Get recent posts from a specific ActivityPub actor',
    schema: getActorPostsSchema,
    handler: getActorPosts,
    numbers: ['limit'],
    booleans: [],
    arrays: ['object_types'],
  },
  {
    path: '/actor-reading-status',
    name: 'get_actor_reading_status',
    description: 'Get BookWyrm reading status for an actor by querying the live shelf (use_live: true, default) or local DB. Returns title, authors, shelf, started_date, finished_date, rating, and bookwyrm_book_url per book.',
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
    description: 'Get BookWyrm reading events from locally stored activities with a normalized event_type field: started_reading, finished_reading, review, rating, comment, note, shelved.',
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
]
