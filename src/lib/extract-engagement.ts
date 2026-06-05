import { getDb } from '../db/client.js'
import { activities } from '../db/schema.js'
import { and, eq, inArray, count } from 'drizzle-orm'

type AnyObject = Record<string, unknown>

export interface EngagementCounts {
  likes: number | null
  boosts: number | null
  replies: number | null
}

/**
 * Extract engagement counts from an ActivityPub/Mastodon object.
 *
 * Different servers embed counts differently:
 *   - AP Collections:   object.likes.totalItems, object.shares.totalItems, object.replies.totalItems
 *   - Mastodon fields:  favouritesCount / favourites_count, reblogsCount / sharesCount, repliesCount
 *   - Bare numbers:     likes / shares / replies as a plain integer
 *
 * Returns null for a metric when no usable value is present. Counts may be
 * stale or zero (e.g. Mastodon often delivers 0 at Create time).
 *
 * NOTE: the backfill SQL in drizzle/0002_engagement_counts.sql mirrors this
 * logic — keep them in sync.
 */
export function extractEngagementCounts(obj: AnyObject): EngagementCounts {
  return {
    likes: pickCount(obj, 'likes', ['favouritesCount', 'favourites_count']),
    boosts: pickCount(obj, 'shares', ['reblogsCount', 'sharesCount', 'shares_count']),
    replies: pickCount(obj, 'replies', ['repliesCount', 'replies_count']),
  }
}

/**
 * @param collectionKey  the AP collection / bare-number key (e.g. 'likes')
 * @param countKeys      Mastodon-style numeric count fields, in priority order
 */
function pickCount(obj: AnyObject, collectionKey: string, countKeys: string[]): number | null {
  // AP Collection { totalItems }
  const collection = obj[collectionKey]
  if (collection && typeof collection === 'object') {
    const total = (collection as AnyObject).totalItems
    const n = toInt(total)
    if (n !== null) return n
  }
  // Bare number on the collection key
  if (typeof collection === 'number' || typeof collection === 'string') {
    const n = toInt(collection)
    if (n !== null) return n
  }
  // Mastodon-style flat count fields
  for (const key of countKeys) {
    const n = toInt(obj[key])
    if (n !== null) return n
  }
  return null
}

function toInt(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

/**
 * Count observed boosts (Announce activities targeting each object) from the
 * activities table. This is the most reliable boost signal this server has —
 * it reflects boosts actually delivered here, independent of object.raw.
 *
 * Returns a Map keyed by object ap_id. Object ids absent from the map have 0
 * observed boosts.
 */
export async function observedBoostCounts(objectApIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (objectApIds.length === 0) return result

  const db = getDb()
  const rows = await db
    .select({ objectApId: activities.objectApId, n: count() })
    .from(activities)
    .where(and(eq(activities.type, 'Announce'), inArray(activities.objectApId, objectApIds)))
    .groupBy(activities.objectApId)

  for (const r of rows) {
    if (r.objectApId) result.set(r.objectApId, Number(r.n))
  }
  return result
}
