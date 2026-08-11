import { desc, eq, and, isNull, inArray } from 'drizzle-orm'
import { config } from '../config.js'
import { getDb } from '../db/client.js'
import { objects, follows } from '../db/schema.js'
import { getEngagement } from '../mcp/tools/engagement.js'
import { logger } from '../lib/logger.js'

/**
 * Background engagement sampler. On-demand get_engagement calls alone produce a
 * spiky history, so this job snapshots the most recent posts of every FOLLOWED actor
 * on a fixed cadence — the auto-watchlist: a new post starts being tracked on the next
 * run without any manual enrolment. Every stored actor is a followed+accepted account
 * (the inbox rejects everyone else), so this covers the owner's own accounts across all
 * services, not just one. skip_unchanged keeps the snapshot table from bloating once a
 * post goes quiet.
 */

// Status-like object types worth sampling for engagement. Excludes BookWyrm
// bibliographic objects (Edition/Work/ShelfBook) and other non-post records, which
// carry no favourite/reblog/reply counts.
export const SAMPLED_TYPES = [
  'Note', 'Question', 'Article', 'Page', 'Image', 'Video',
  'Comment', 'GeneratedNote', 'Review',
]

export async function sampleEngagement(): Promise<void> {
  if (config.ENGAGEMENT_SAMPLE_RECENT_POSTS === 0) {
    logger.debug('ENGAGEMENT_SAMPLE_RECENT_POSTS=0, skipping engagement sampling')
    return
  }

  const db = getDb()
  const followed = await db
    .select({ apId: follows.actorApId })
    .from(follows)
    .where(eq(follows.status, 'accepted'))
  if (followed.length === 0) {
    logger.debug('No accepted follows, skipping engagement sampling')
    return
  }

  // Most recent N posts per followed actor (not N across all of them), so each account
  // stays covered regardless of how chatty the others are.
  const apIds: string[] = []
  for (const f of followed) {
    const recent = await db
      .select({ apId: objects.apId })
      .from(objects)
      .where(and(
        eq(objects.actorApId, f.apId),
        inArray(objects.type, SAMPLED_TYPES),
        isNull(objects.deletedAt),
      ))
      .orderBy(desc(objects.publishedAt))
      .limit(config.ENGAGEMENT_SAMPLE_RECENT_POSTS)
    apIds.push(...recent.map((r) => r.apId))
  }
  if (apIds.length === 0) return

  // get_engagement caps a batch at ENGAGEMENT_MAX_BATCH, so chunk across actors.
  let ok = 0
  let failed = 0
  let written = 0
  for (let i = 0; i < apIds.length; i += config.ENGAGEMENT_MAX_BATCH) {
    const result = await getEngagement({
      statuses: apIds.slice(i, i + config.ENGAGEMENT_MAX_BATCH),
      snapshot: true,
      skip_unchanged: true,
      prefer: 'rest',
    })
    ok += result.ok
    failed += result.failed
    written += result.results.filter((r) => 'snapshot' in r && r.snapshot === 'written').length
  }

  logger.info(
    { actors: followed.length, sampled: ok, failed, written },
    'Engagement sampling complete',
  )
}
