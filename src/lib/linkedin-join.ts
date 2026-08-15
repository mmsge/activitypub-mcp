import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'

/**
 * How well the two LinkedIn halves actually meet.
 *
 * ADR 0033 joins post content (the DMA snapshot) to post performance (the monthly
 * .xlsx) on a numeric id extracted from whichever URL form each source emitted.
 * That is string canonicalisation, not URN resolution — which is the right call,
 * but it means a *mismatch* is invisible: rows land on both sides, every query
 * still returns something, and `get_linkedin_posts` reports `has_content: false`
 * forever without anything having errored.
 *
 * The risk is real rather than theoretical. The export spells its permalinks two
 * ways, `-share-<id>-` and `-ugcPost-<id>-`, and LinkedIn's share, ugcPost and
 * activity URNs are not guaranteed to carry the same number for the same post. If
 * the snapshot emits an id from a different namespace than the export did, both
 * tables fill up and nothing ever joins.
 *
 * So the overlap is counted and surfaced. `orphan_posts` is the number that says
 * the join is broken; it should be small (posts published since the last export)
 * and is expected to be zero once an export has caught up. See ADR 0039.
 */
export interface LinkedinJoinHealth {
  /** Rows the snapshot poller has written. */
  posts: number
  /** Distinct posts the .xlsx imports know about. */
  metric_keys: number
  /** Keys present on both sides — the join actually working. */
  matched: number
  /** Content with no numbers: posted since the last export, or a key mismatch. */
  orphan_posts: number
  /** Numbers with no content: the poller has not reached them, or a key mismatch. */
  orphan_metrics: number
}

export async function linkedinJoinHealth(): Promise<LinkedinJoinHealth> {
  const db = getDb()
  const [row] = [...await db.execute<{
    posts: string
    metric_keys: string
    matched: string
  }>(sql`
    SELECT
      (SELECT count(*) FROM linkedin_posts)                     AS posts,
      (SELECT count(DISTINCT post_key) FROM linkedin_post_metrics) AS metric_keys,
      (SELECT count(*) FROM linkedin_posts p
         WHERE EXISTS (SELECT 1 FROM linkedin_post_metrics m WHERE m.post_key = p.post_key))
                                                                AS matched
  `)]

  const posts = Number(row?.posts ?? 0)
  const metricKeys = Number(row?.metric_keys ?? 0)
  const matched = Number(row?.matched ?? 0)

  return {
    posts,
    metric_keys: metricKeys,
    matched,
    orphan_posts: posts - matched,
    orphan_metrics: metricKeys - matched,
  }
}

/**
 * The join half of a run's note, or null when there is nothing worth saying.
 *
 * Only speaks up when the poller has written rows and *none* of them met a metric
 * key that exists — the shape a namespace mismatch would have. Silence otherwise:
 * a note that fires on every ordinary run is a note nobody reads.
 */
export function joinWarning(h: LinkedinJoinHealth): string | null {
  if (h.posts === 0 || h.metric_keys === 0) return null
  if (h.matched > 0) return null
  return (
    `JOIN BROKEN: ${h.posts} post(s) and ${h.metric_keys} metric key(s) stored, 0 in common — ` +
    'the two sources are emitting ids from different namespaces (share vs ugcPost vs activity). ' +
    'Compare a stored linkedin_posts.post_url against a linkedin_post_metrics.post_url for the same post.'
  )
}
