import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { config } from '../../config.js'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'

/**
 * Actor-scoped engagement trends — the actor-level sibling of get_engagement_trends
 * (per-status) and get_hashtag_trends (usage over time). It joins an actor's stored
 * posts (`objects`) to their latest engagement snapshot (`engagement_snapshots`) and
 * aggregates favourite/reblog/reply counts into time buckets keyed by the post's
 * PUBLISHED date, so a caller can chart e.g. "mean favourites per day on originals".
 *
 * Each post contributes its LATEST observed count — the same snapshot model
 * get_engagement_trends uses. A post is only counted once it has been sampled at
 * least once by get_engagement; the `coverage` block reports how many in-window
 * posts actually carry a snapshot so the caller knows whether the aggregate is
 * complete. Counts are eventually-consistent and can go down (un-favourites), and
 * AP-collection totals can under-report vs the REST source.
 */

const METRICS = ['favourites', 'reblogs', 'replies'] as const
type Metric = (typeof METRICS)[number]

const num = (v: unknown): number => Number(v ?? 0)
const round2 = (v: number): number => Math.round(v * 100) / 100

// date_trunc buckets are labelled to match the trends family: day/week land on a
// date, month on YYYY-MM. Weeks start Monday (Postgres date_trunc convention).
const BUCKET_FORMATS: Record<string, string> = {
  day: 'YYYY-MM-DD',
  week: 'YYYY-MM-DD',
  month: 'YYYY-MM',
}

export const getActorEngagementTrendsSchema = z.object({
  actor_handle: z
    .string()
    .optional()
    .describe('Actor handle (@user@domain) or actor URL. Defaults to the configured OWNER_ACTOR.'),
  metric: z.enum(['favourites', 'reblogs', 'replies', 'all']).default('favourites'),
  aggregate: z.enum(['mean', 'sum', 'median', 'max']).default('mean')
    .describe("How each bucket's per-post counts are combined into `value`. 'mean' answers avg-per-post; 'sum' answers total reach."),
  group_by: z.enum(['day', 'week', 'month']).default('day'),
  object_types: z.array(z.string()).default(['Note', 'Question'])
    .describe('Post types to include; the default excludes boosts/announces.'),
  exclude_replies: z.boolean().default(true)
    .describe('Drop any post with a non-null in_reply_to (self-replies/threads included).'),
  from: z.string().optional().describe('ISO 8601 — only posts published at/after this time'),
  to: z.string().optional().describe('ISO 8601 — only posts published at/before this time'),
  since: z.string().optional().describe('ISO 8601 — only posts published strictly after this time'),
  limit: z.number().int().min(1).max(1000).default(120)
    .describe('Max buckets returned (newest kept, series ordered oldest → newest).'),
})

type StatCols = { sum: number; min: number; max: number; mean: number; median: number }

/** Pick the aggregate `value` for a metric, while always surfacing sum/min/max so the
 *  bucket is interpretable regardless of the chosen aggregate. */
export function metricStats(aggregate: 'mean' | 'sum' | 'median' | 'max', s: StatCols) {
  const value =
    aggregate === 'sum' ? s.sum
    : aggregate === 'max' ? s.max
    : aggregate === 'median' ? round2(s.median)
    : round2(s.mean)
  return { value, sum: s.sum, min: s.min, max: s.max }
}

// Raw bucket row as it comes back from SQL (one row per non-empty bucket), with the
// per-metric stat columns already computed server-side over the bucket's contributors.
export type ActorTrendBucketRow = {
  bucket: string
  post_count: number
  favourites: StatCols
  reblogs: StatCols
  replies: StatCols
}

/**
 * Shape the bucket rows + window totals into the output series and summary. Pure so
 * it can be unit-tested without a database. For a single metric each bucket is
 * {bucket, post_count, value, sum, min, max}; for `all` it nests one such stat object
 * per metric. `overall_mean`/`overall_sum` are computed over sampled posts (the
 * contributors), matching the per-bucket denominator.
 */
export function buildActorTrendSeries(
  rows: ActorTrendBucketRow[],
  metric: Metric | 'all',
  aggregate: 'mean' | 'sum' | 'median' | 'max',
  overall: Record<Metric, { sum: number; mean: number }>,
  postsInWindow: number,
) {
  const series = rows.map((r) => {
    if (metric === 'all') {
      return {
        bucket: r.bucket,
        post_count: r.post_count,
        favourites: metricStats(aggregate, r.favourites),
        reblogs: metricStats(aggregate, r.reblogs),
        replies: metricStats(aggregate, r.replies),
      }
    }
    return { bucket: r.bucket, post_count: r.post_count, ...metricStats(aggregate, r[metric]) }
  })

  const summary =
    metric === 'all'
      ? {
          posts: postsInWindow,
          favourites: { overall_mean: round2(overall.favourites.mean), overall_sum: overall.favourites.sum },
          reblogs: { overall_mean: round2(overall.reblogs.mean), overall_sum: overall.reblogs.sum },
          replies: { overall_mean: round2(overall.replies.mean), overall_sum: overall.replies.sum },
        }
      : {
          posts: postsInWindow,
          overall_mean: round2(overall[metric].mean),
          overall_sum: overall[metric].sum,
        }

  return { series, summary }
}

async function resolveActor(
  actorHandle: string | undefined,
): Promise<{ apId: string; handle: string } | { error: string }> {
  const handle = actorHandle ?? (config.OWNER_ACTOR || undefined)
  if (!handle) return { error: 'No actor_handle given and OWNER_ACTOR is not configured' }
  if (handle.startsWith('http')) return { apId: handle, handle }
  const actor = await resolveActorByHandle(handle)
  if (!actor) return { error: `Could not resolve actor: ${handle}` }
  return { apId: actor.apId, handle }
}

export async function getActorEngagementTrends(
  input: z.infer<typeof getActorEngagementTrendsSchema>,
) {
  const actor = await resolveActor(input.actor_handle)
  if ('error' in actor) return actor

  const db = getDb()

  // Qualifying posts joined to their latest snapshot. A LEFT JOIN LATERAL keeps posts
  // with no snapshot (favourites IS NULL) so `coverage` can count them; the series and
  // window totals below then filter to snapshotted posts (the contributors).
  const conds: SQL[] = [
    sql`o.deleted_at IS NULL`,
    sql`o.actor_ap_id = ${actor.apId}`,
    sql`o.published_at IS NOT NULL`,
  ]
  if (input.object_types.length) {
    const types = sql.join(input.object_types.map((t) => sql`${t}`), sql`, `)
    conds.push(sql`o.type IN (${types})`)
  }
  if (input.exclude_replies) conds.push(sql`o.in_reply_to IS NULL`)
  // Bind the window bounds as ISO strings cast to timestamptz — the driver can't
  // bind a Date param inside this CTE/LATERAL shape.
  if (input.from) conds.push(sql`o.published_at >= ${new Date(input.from).toISOString()}::timestamptz`)
  if (input.to) conds.push(sql`o.published_at <= ${new Date(input.to).toISOString()}::timestamptz`)
  if (input.since) conds.push(sql`o.published_at > ${new Date(input.since).toISOString()}::timestamptz`)
  const where = sql.join(conds, sql` AND `)

  const latest = sql`
    SELECT o.published_at AS published_at, s.favourites, s.reblogs, s.replies
    FROM objects o
    LEFT JOIN LATERAL (
      SELECT favourites, reblogs, replies
      FROM engagement_snapshots es
      WHERE es.status_ap_id = o.ap_id
      ORDER BY es.sampled_at DESC
      LIMIT 1
    ) s ON true
    WHERE ${where}
  `

  const bucketExpr = sql`date_trunc(${input.group_by}, published_at AT TIME ZONE 'UTC')`

  // One row per non-empty bucket, over contributors only (favourites IS NOT NULL ⇒ a
  // snapshot exists; favourites/reblogs/replies share the row, so all are present).
  // Newest buckets kept under the limit, reversed to oldest → newest.
  const bucketRows = [...await db.execute<{
    bucket: string
    post_count: string | number
    fav_sum: string | number; fav_min: string | number; fav_max: string | number; fav_mean: string | number; fav_median: string | number
    reb_sum: string | number; reb_min: string | number; reb_max: string | number; reb_mean: string | number; reb_median: string | number
    rep_sum: string | number; rep_min: string | number; rep_max: string | number; rep_mean: string | number; rep_median: string | number
  }>(sql`
    WITH latest AS (${latest})
    SELECT * FROM (
      SELECT to_char(${bucketExpr}, ${BUCKET_FORMATS[input.group_by]}) AS bucket,
             count(*) AS post_count,
             sum(favourites) AS fav_sum, min(favourites) AS fav_min, max(favourites) AS fav_max,
             avg(favourites) AS fav_mean,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY favourites) AS fav_median,
             sum(reblogs) AS reb_sum, min(reblogs) AS reb_min, max(reblogs) AS reb_max,
             avg(reblogs) AS reb_mean,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY reblogs) AS reb_median,
             sum(replies) AS rep_sum, min(replies) AS rep_min, max(replies) AS rep_max,
             avg(replies) AS rep_mean,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY replies) AS rep_median
      FROM latest
      WHERE favourites IS NOT NULL
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT ${input.limit}
    ) b
    ORDER BY bucket ASC
  `)]

  // Window totals + coverage. sum()/avg() skip NULLs, so they run over contributors
  // even though posts_in_window counts every qualifying post.
  const [cov] = [...await db.execute<{
    posts_in_window: string | number
    posts_with_snapshot: string | number
    fav_sum: string | number; fav_mean: string | number | null
    reb_sum: string | number; reb_mean: string | number | null
    rep_sum: string | number; rep_mean: string | number | null
  }>(sql`
    WITH latest AS (${latest})
    SELECT count(*) AS posts_in_window,
           count(*) FILTER (WHERE favourites IS NOT NULL) AS posts_with_snapshot,
           coalesce(sum(favourites), 0) AS fav_sum, avg(favourites) AS fav_mean,
           coalesce(sum(reblogs), 0) AS reb_sum, avg(reblogs) AS reb_mean,
           coalesce(sum(replies), 0) AS rep_sum, avg(replies) AS rep_mean
    FROM latest
  `)]

  const stats = (r: typeof bucketRows[number], p: 'fav' | 'reb' | 'rep'): StatCols => ({
    sum: num(r[`${p}_sum`]),
    min: num(r[`${p}_min`]),
    max: num(r[`${p}_max`]),
    mean: num(r[`${p}_mean`]),
    median: num(r[`${p}_median`]),
  })

  const rows: ActorTrendBucketRow[] = bucketRows.map((r) => ({
    bucket: r.bucket,
    post_count: num(r.post_count),
    favourites: stats(r, 'fav'),
    reblogs: stats(r, 'reb'),
    replies: stats(r, 'rep'),
  }))

  const postsInWindow = num(cov?.posts_in_window)
  const postsWithSnapshot = num(cov?.posts_with_snapshot)
  const overall = {
    favourites: { sum: num(cov?.fav_sum), mean: num(cov?.fav_mean) },
    reblogs: { sum: num(cov?.reb_sum), mean: num(cov?.reb_mean) },
    replies: { sum: num(cov?.rep_sum), mean: num(cov?.rep_mean) },
  }

  const { series, summary } = buildActorTrendSeries(
    rows,
    input.metric,
    input.aggregate,
    overall,
    postsInWindow,
  )

  return {
    actor: actor.handle,
    actor_ap_id: actor.apId,
    metric: input.metric,
    aggregate: input.aggregate,
    group_by: input.group_by,
    coverage: {
      posts_in_window: postsInWindow,
      posts_with_snapshot: postsWithSnapshot,
      pct: postsInWindow > 0 ? round2((postsWithSnapshot / postsInWindow) * 100) : 0,
    },
    series,
    summary,
  }
}
