import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getActorPostsSchema, getActorPosts } from './tools/actor-posts.js'
import { getActorReadingStatusSchema, getActorReadingStatus } from './tools/actor-reading.js'
import { getActorMediaSchema, getActorMedia } from './tools/actor-media.js'
import { searchActorContentSchema, searchActorContent } from './tools/actor-search.js'
import { getFollowsSchema, getFollows } from './tools/follows.js'
import { getActivityStatsSchema, getActivityStats, getRecentActivitiesSchema, getRecentActivities } from './tools/activity-stats.js'
import { getReadingEventsSchema, getReadingEvents } from './tools/reading-events.js'
import { getScrobblesSchema, getScrobbles, getScrobbleStatsSchema, getScrobbleStats } from './tools/scrobbles.js'

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'activitypub-mcp',
    version: '1.0.0',
  })

  server.tool(
    'get_actor_posts',
    'Get recent posts from a specific ActivityPub actor',
    getActorPostsSchema.shape,
    async (input) => {
      const result = await getActorPosts(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_actor_reading_status',
    'Get BookWyrm reading status for an actor by querying the live shelf (use_live: true, default) or local DB. Returns title, authors, shelf, started_date, finished_date, rating, and bookwyrm_book_url per book.',
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
    'Get BookWyrm reading events from locally stored activities with a normalized event_type field: started_reading, finished_reading, review, rating, comment, note, shelved. Useful for building a reading timeline or finding when a book was started vs finished.',
    getReadingEventsSchema.shape,
    async (input) => {
      const result = await getReadingEvents(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_scrobbles',
    "Query the locally-stored Last.fm scrobble history. Filter by artist, album, or track (case-insensitive partial match) and/or a played-at time window (from/to/since, ISO datetimes). Returns scrobbles newest-first with pagination.",
    getScrobblesSchema.shape,
    async (input) => {
      const result = await getScrobbles(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'get_scrobble_stats',
    "Aggregate metrics over the stored Last.fm scrobbles: total play count, listening span (first/last played), and top artists, albums, or tracks by play count. Optionally bounded by a from/to time window.",
    getScrobbleStatsSchema.shape,
    async (input) => {
      const result = await getScrobbleStats(input as any)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  return server
}
