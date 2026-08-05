import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { logger } from '../lib/logger.js'
import { resolveActorIds } from '../stream/query.js'
import { idArray } from '../stream/lanes.js'

/**
 * What the REST API stops serving once it is pinned to public-only (ADR 0026).
 *
 * The risk with that change is not that it breaks something — it is that it is
 * *invisible*. A consumer like msge.no simply receives fewer rows on its next
 * poll, with no error and nothing in a log to explain the gap. This counts the
 * difference up front, per visibility class and for the hashtags that actually
 * feed a public page, so the shrinkage is a number to approve rather than
 * something to notice weeks later.
 *
 * Read-only. Safe to run whenever.
 */

export interface VisibilityAuditRow {
  visibility: string
  posts: number
  withMedia: number
}

export interface VisibilityAuditResult {
  /** Counts across the owner's own accounts (STREAM_SOURCES). */
  byVisibility: VisibilityAuditRow[]
  /** Per-hashtag, for the tags a public site is built from. */
  byTag: Array<{ tag: string; total: number; public: number; withheld: number }>
  /** Posts bound to a trip, since `/trip-posts` is the newest public door. */
  tripPosts: { total: number; public: number; withheld: number }
  /** Total rows the REST API stops serving. Zero means the change is a no-op. */
  withheldTotal: number
}

/** The tags worth calling out by name — the ones a public page is built from. */
const WATCHED_TAGS = ['togselfie', 'togtut', 'kodetoget']

export async function auditVisibility(): Promise<VisibilityAuditResult> {
  const db = getDb()
  const actorIds = Object.values(await resolveActorIds()).flat()

  if (actorIds.length === 0) {
    logger.warn('No STREAM_SOURCES actors resolved; nothing to audit')
    return { byVisibility: [], byTag: [], tripPosts: { total: 0, public: 0, withheld: 0 }, withheldTotal: 0 }
  }
  const mine = idArray(actorIds)

  const byVisibility = (await db.execute(sql`
    SELECT o.visibility,
           count(*)::int AS posts,
           count(*) FILTER (
             WHERE jsonb_typeof(o.attachments) = 'array'
               AND jsonb_array_length(o.attachments) > 0)::int AS with_media
    FROM objects o
    WHERE o.deleted_at IS NULL AND o.actor_ap_id = ANY(${mine})
    GROUP BY o.visibility
    ORDER BY count(*) DESC`)) as unknown as Array<{
      visibility: string; posts: number; with_media: number
    }>

  const byTag = (await db.execute(sql`
    SELECT lower(ltrim(tag->>'name', '#')) AS tag,
           count(*)::int AS total,
           count(*) FILTER (WHERE o.visibility = 'public')::int AS public_count
    FROM objects o
    CROSS JOIN LATERAL jsonb_array_elements(o.tags) AS tag
    WHERE o.deleted_at IS NULL
      AND o.actor_ap_id = ANY(${mine})
      AND jsonb_typeof(o.tags) = 'array'
      AND lower(tag->>'type') = 'hashtag'
      AND lower(ltrim(tag->>'name', '#')) = ANY(${idArray(WATCHED_TAGS)})
    GROUP BY lower(ltrim(tag->>'name', '#'))
    ORDER BY count(*) DESC`)) as unknown as Array<{
      tag: string; total: number; public_count: number
    }>

  const [trip] = (await db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE o.visibility = 'public')::int AS public_count
    FROM trip_posts tp
    JOIN objects o ON o.ap_id = tp.object_ap_id
    WHERE o.deleted_at IS NULL`)) as unknown as Array<{ total: number; public_count: number }>

  const rows: VisibilityAuditRow[] = byVisibility.map((r) => ({
    visibility: r.visibility,
    posts: Number(r.posts),
    withMedia: Number(r.with_media),
  }))

  const result: VisibilityAuditResult = {
    byVisibility: rows,
    byTag: byTag.map((r) => ({
      tag: r.tag,
      total: Number(r.total),
      public: Number(r.public_count),
      withheld: Number(r.total) - Number(r.public_count),
    })),
    tripPosts: {
      total: Number(trip?.total ?? 0),
      public: Number(trip?.public_count ?? 0),
      withheld: Number(trip?.total ?? 0) - Number(trip?.public_count ?? 0),
    },
    withheldTotal: rows
      .filter((r) => r.visibility !== 'public')
      .reduce((n, r) => n + r.posts, 0),
  }

  logger.info(result, 'REST visibility audit')
  return result
}
