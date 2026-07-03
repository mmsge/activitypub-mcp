import { desc, eq, and, isNull } from 'drizzle-orm'
import { config } from '../config.js'
import { getDb } from '../db/client.js'
import { objects } from '../db/schema.js'
import { resolveActorByHandle } from '../lib/fetch-actor.js'
import { getEngagement } from '../mcp/tools/engagement.js'
import { logger } from '../lib/logger.js'

/**
 * Background engagement sampler. On-demand get_engagement calls alone produce a
 * spiky history, so this job snapshots the owner's most recent posts on a fixed
 * cadence — the auto-watchlist: a new toot starts being tracked on the next run
 * without any manual enrolment. skip_unchanged keeps the snapshot table from
 * bloating once a post goes quiet.
 */
export async function sampleEngagement(): Promise<void> {
  if (!config.OWNER_ACTOR || config.ENGAGEMENT_SAMPLE_RECENT_POSTS === 0) {
    logger.debug('OWNER_ACTOR unset or ENGAGEMENT_SAMPLE_RECENT_POSTS=0, skipping engagement sampling')
    return
  }

  const actorApId = config.OWNER_ACTOR.startsWith('http')
    ? config.OWNER_ACTOR
    : (await resolveActorByHandle(config.OWNER_ACTOR))?.apId
  if (!actorApId) {
    logger.warn({ owner: config.OWNER_ACTOR }, 'Could not resolve OWNER_ACTOR, skipping engagement sampling')
    return
  }

  const db = getDb()
  const recent = await db
    .select({ apId: objects.apId })
    .from(objects)
    .where(and(
      eq(objects.actorApId, actorApId),
      eq(objects.type, 'Note'),
      isNull(objects.deletedAt),
    ))
    .orderBy(desc(objects.publishedAt))
    .limit(config.ENGAGEMENT_SAMPLE_RECENT_POSTS)

  if (recent.length === 0) return

  const result = await getEngagement({
    statuses: recent.map((r) => r.apId),
    snapshot: true,
    skip_unchanged: true,
    prefer: 'rest',
  })

  const written = result.results.filter((r) => 'snapshot' in r && r.snapshot === 'written').length
  logger.info(
    { sampled: result.ok, failed: result.failed, written },
    'Engagement sampling complete',
  )
}
