import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { config } from '../../config.js'
import { getDb } from '../../db/client.js'
import {
  deriveTokenStatus,
  getSourceHealth,
  LINKEDIN_SOURCE,
} from '../../lib/source-health.js'
import { publicVisibilityCondition } from './linkedin-posts.js'
import type { QueryScope } from './scope.js'

/**
 * Aggregate LinkedIn performance — and specifically the median engagement rate per
 * weekday, which is the number that currently sits hardcoded in the
 * `linkedin-post-timing` skill and has to be re-derived by hand after every
 * export. This tool is what makes it self-updating.
 *
 * Three choices worth knowing about:
 *
 *  - **Median, not mean.** With ~30 posts and one viral outlier, a mean weekday
 *    score is mostly a report on which weekday the outlier fell.
 *  - **Latest observation per post, not every row.** Metrics are append-only, so a
 *    post that stayed in the top 50 for four months has four rows; counting each
 *    would weight long-lived posts four times.
 *  - **Europe/Oslo.** A bucket is computed in the timezone its label is rendered
 *    in — ADR 0019. On a UTC container, a post published at 00:30 CEST on a Monday
 *    is a Sunday post in UTC, which would move real posts into the wrong bucket.
 *
 * See ADR 0033.
 */

const WEEKDAY_NAMES = [
  '', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
]

/**
 * Post universe with one observation each, bucketed by local weekday.
 *
 * `posted_local` prefers the poller's timestamp converted to Oslo, and falls back
 * to the export's date-only publish day, which is already a local calendar date
 * and must NOT be shifted again.
 */
const MERGED_LOCAL = sql`
  WITH latest AS (
    SELECT DISTINCT ON (post_key) post_key, export_date, impressions, engagements, posted_on
    FROM linkedin_post_metrics
    ORDER BY post_key, export_date DESC
  ),
  universe AS (
    SELECT post_key FROM linkedin_posts
    UNION
    SELECT post_key FROM linkedin_post_metrics
  ),
  merged AS (
    SELECT
      u.post_key,
      COALESCE(p.posted_at AT TIME ZONE 'Europe/Oslo', l.posted_on::timestamp) AS posted_local,
      p.visibility,
      l.impressions,
      l.engagements,
      CASE WHEN l.impressions > 0 AND l.engagements IS NOT NULL
           THEN l.engagements::numeric / l.impressions END AS rate
    FROM universe u
    LEFT JOIN linkedin_posts p ON p.post_key = u.post_key
    LEFT JOIN latest l ON l.post_key = u.post_key
  )
`

function statsConditions(
  input: { from?: string; to?: string; since?: string },
  scope?: QueryScope,
): SQL[] {
  const conditions: SQL[] = [sql`posted_local IS NOT NULL`]
  const from = input.from ?? input.since
  if (from) conditions.push(sql`posted_local::date >= ${from}::date`)
  if (input.to) conditions.push(sql`posted_local::date <= ${input.to}::date`)
  if (scope?.publicOnly) conditions.push(publicVisibilityCondition())
  return conditions
}

export const getLinkedinStatsSchema = z.object({
  from: z.string().optional().describe('Only posts published on or after this date (YYYY-MM-DD)'),
  to: z.string().optional().describe('Only posts published on or before this date (YYYY-MM-DD)'),
  since: z.string().optional().describe('Alias for "from"'),
})

const num = (v: string | number | null): number | null =>
  v === null || v === undefined ? null : Number(v)

export async function getLinkedinStats(
  input: z.infer<typeof getLinkedinStatsSchema>,
  scope?: QueryScope,
) {
  const db = getDb()
  const conditions = statsConditions(input, scope)
  const where = sql` WHERE ${sql.join(conditions, sql` AND `)}`

  const [totals] = [...await db.execute<{
    posts: string
    with_metrics: string
    first_posted: string | null
    last_posted: string | null
    total_impressions: string | null
    total_engagements: string | null
    median_impressions: string | null
    median_rate: string | null
    p25_impressions: string | null
    p75_impressions: string | null
    p25_rate: string | null
    p75_rate: string | null
  }>(sql`
    ${MERGED_LOCAL}
    SELECT
      count(*)                                                   AS posts,
      count(rate)                                                AS with_metrics,
      min(posted_local)::date                                    AS first_posted,
      max(posted_local)::date                                    AS last_posted,
      sum(impressions)                                           AS total_impressions,
      sum(engagements)                                           AS total_engagements,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY impressions)  AS median_impressions,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY rate)         AS median_rate,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY impressions)  AS p25_impressions,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY impressions)  AS p75_impressions,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY rate)         AS p25_rate,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY rate)         AS p75_rate
    FROM merged ${where}
  `)]

  const weekdayRows = [...await db.execute<{
    weekday: number
    posts: string
    with_metrics: string
    median_rate: string | null
    median_impressions: string | null
    median_engagements: string | null
  }>(sql`
    ${MERGED_LOCAL}
    SELECT
      EXTRACT(ISODOW FROM posted_local)::int                     AS weekday,
      count(*)                                                   AS posts,
      count(rate)                                                AS with_metrics,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY rate)          AS median_rate,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY impressions)   AS median_impressions,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY engagements)   AS median_engagements
    FROM merged ${where}
    GROUP BY 1
    ORDER BY 1
  `)]

  const health = await getSourceHealth(LINKEDIN_SOURCE)
  // Twice the poll interval: one missed run is a blip, two is a pattern. Derived
  // from the cadence rather than from an assumed token lifetime, because LinkedIn
  // documents no expiry for a self-serve DMA token.
  const staleAfterMs = config.LINKEDIN_SYNC_INTERVAL_HOURS * 2 * 60 * 60_000

  return {
    range: { from: input.from ?? input.since ?? null, to: input.to ?? null },
    timezone: 'Europe/Oslo',
    totals: {
      posts: Number(totals?.posts ?? 0),
      // Posts with a usable engagement rate. Every median below is over these,
      // not over `posts` — a post with no export yet contributes nothing.
      posts_with_metrics: Number(totals?.with_metrics ?? 0),
      first_posted: totals?.first_posted ?? null,
      last_posted: totals?.last_posted ?? null,
      total_impressions: num(totals?.total_impressions ?? null),
      total_engagements: num(totals?.total_engagements ?? null),
      median_impressions: num(totals?.median_impressions ?? null),
      median_engagement_rate: num(totals?.median_rate ?? null),
      impressions_p25: num(totals?.p25_impressions ?? null),
      impressions_p75: num(totals?.p75_impressions ?? null),
      engagement_rate_p25: num(totals?.p25_rate ?? null),
      engagement_rate_p75: num(totals?.p75_rate ?? null),
    },
    // `n` is deliberately returned beside every median: with tens of posts a
    // weekday can rest on one or two, and a ranking built on that is a hint, not
    // a verdict. A consumer that hides n will overstate what this data supports.
    by_weekday: weekdayRows.map((r) => ({
      weekday: Number(r.weekday),
      weekday_name: WEEKDAY_NAMES[Number(r.weekday)] ?? String(r.weekday),
      posts: Number(r.posts),
      n: Number(r.with_metrics),
      median_engagement_rate: num(r.median_rate),
      median_impressions: num(r.median_impressions),
      median_engagements: num(r.median_engagements),
    })),
    // Ingest health, so a consumer can tell "he stopped posting" from "the token
    // died three weeks ago and these numbers have been frozen since" — and from
    // "the poller works but LinkedIn has not handed over the posts yet", which
    // looks identical in the data and is not the same conclusion at all.
    source_health: {
      token_status: deriveTokenStatus(health, staleAfterMs),
      last_success_at: health?.lastSuccessAt?.toISOString() ?? null,
      // When posts last actually arrived, which is a different question from when
      // the job last ran — null means the poller has never once been given data.
      last_data_at: health?.lastDataAt?.toISOString() ?? null,
      last_attempt_at: health?.lastAttemptAt?.toISOString() ?? null,
      last_error: health?.lastError ?? null,
      last_status: health?.lastStatus ?? null,
      consecutive_failures: health?.consecutiveFailures ?? 0,
      poll_interval_hours: config.LINKEDIN_SYNC_INTERVAL_HOURS,
    },
  }
}
