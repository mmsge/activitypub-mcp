import { desc, eq, and, isNull, inArray } from 'drizzle-orm'
import { config, getEngagementSampleOrigins } from '../config.js'
import { getDb } from '../db/client.js'
import { objects, follows } from '../db/schema.js'
import { getEngagement } from '../mcp/tools/engagement.js'
import { logger } from '../lib/logger.js'
import { statusOrigin } from '../lib/fetch-engagement.js'

/**
 * Background engagement sampler. On-demand get_engagement calls alone produce a
 * spiky history, so this job snapshots the most recent posts of every FOLLOWED actor
 * on a fixed cadence — the auto-watchlist: a new post starts being tracked on the next
 * run without any manual enrolment. Every stored actor is a followed+accepted account
 * (the inbox rejects everyone else), so this covers the owner's own accounts across all
 * services, not just one. skip_unchanged keeps the snapshot table from bloating once a
 * post goes quiet.
 *
 * The auto-watchlist is bounded by ENGAGEMENT_SAMPLE_ORIGINS, and has to be. "An account
 * he owns" and "a server he runs" are different facts, and the follows table only knows
 * the first: minreol.dk and bookwyrm.social are somebody else's machines that he happens
 * to have an account on. Left ungated this job polled all of them, every hour, forever —
 * an admin of one of them noticed the hourly burst before we did (record 0058).
 *
 * skip_unchanged is about the snapshot TABLE, not the traffic: an unchanged count is
 * still a request. Nothing downstream of the fetch can make a poll cheap, so the only
 * lever that reduces outbound load is not asking.
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

  const origins = getEngagementSampleOrigins()
  if (origins.size === 0) {
    logger.warn(
      'Engagement sampling is configured to poll nothing: set ENGAGEMENT_SAMPLE_ORIGINS ' +
      '(or OWNER_INSTANCE) to the hosts you are entitled to poll',
    )
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

  // Split the watchlist before touching the database. The two halves are reported
  // separately because they have different fixes: a sampled origin that yields nothing
  // is a bug here, an excluded one is a line in .env — and neither should need a psql
  // session to tell apart.
  const sampledActors = followed.filter(f => origins.has(statusOrigin(f.apId)))
  const excluded = [...new Set(
    followed.filter(f => !origins.has(statusOrigin(f.apId))).map(f => statusOrigin(f.apId)),
  )].filter(Boolean).sort()
  if (sampledActors.length === 0) {
    logger.warn(
      { excluded, origins: [...origins].sort() },
      'No followed actor is on a sampled origin, skipping engagement sampling',
    )
    return
  }

  // Most recent N posts per followed actor (not N across all of them), so each account
  // stays covered regardless of how chatty the others are.
  const apIds: string[] = []
  for (const f of sampledActors) {
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
  // The actor filter above is the cheap one; this is the one that holds. What goes out
  // is a request to the POST's own host, and a post's host is not guaranteed to be its
  // actor's — so the gate belongs on the URL that is actually dialled.
  const targets = apIds.filter(id => origins.has(statusOrigin(id)))
  if (targets.length === 0) return

  // get_engagement caps a batch at ENGAGEMENT_MAX_BATCH, so chunk across actors.
  let ok = 0
  let failed = 0
  let written = 0
  for (let i = 0; i < targets.length; i += config.ENGAGEMENT_MAX_BATCH) {
    const result = await getEngagement({
      statuses: targets.slice(i, i + config.ENGAGEMENT_MAX_BATCH),
      snapshot: true,
      skip_unchanged: true,
      prefer: 'rest',
    })
    ok += result.ok
    failed += result.failed
    written += result.results.filter((r) => 'snapshot' in r && r.snapshot === 'written').length
  }

  logger.info(
    { actors: sampledActors.length, excluded, sampled: ok, failed, written },
    'Engagement sampling complete',
  )
}
