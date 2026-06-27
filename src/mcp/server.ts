import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getActorPostsSchema, getActorPosts } from './tools/actor-posts.js'
import { getActorReadingStatusSchema, getActorReadingStatus } from './tools/actor-reading.js'
import { getActorMediaSchema, getActorMedia } from './tools/actor-media.js'
import { searchActorContentSchema, searchActorContent } from './tools/actor-search.js'
import { getFollowsSchema, getFollows } from './tools/follows.js'
import { getActivityStatsSchema, getActivityStats, getRecentActivitiesSchema, getRecentActivities } from './tools/activity-stats.js'
import { getReadingEventsSchema, getReadingEvents } from './tools/reading-events.js'
import { getScrobblesSchema, getScrobbles, getScrobbleStatsSchema, getScrobbleStats } from './tools/scrobbles.js'
import { getNowPlayingSchema, getNowPlaying } from './tools/now-playing.js'
import { getTrainTripsSchema, getTrainTrips, getTrainStatsSchema, getTrainStats } from './tools/train-trips.js'

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
    'Get BookWyrm reading status for an actor by querying the live shelf (use_live: true, default) or local DB. Returns title, authors, cover, shelf, started_date, finished_date, rating, and bookwyrm_book_url per book.',
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
    "Get BookWyrm reading events from locally stored activities with a normalized event_type field: started_reading, finished_reading, review, rating, comment, note, shelved. Useful for building a reading timeline or finding when a book was started vs finished. Defaults to newest-first; set sort_order='asc' with limit=1 to fetch the earliest reading event in one call, and follow the next_cursor token for deep traversal.",
    getReadingEventsSchema.shape,
    async (input) => {
      const result = await getReadingEvents(input as any)
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

  return server
}
