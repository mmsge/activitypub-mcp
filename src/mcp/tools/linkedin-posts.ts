import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { canonicalPostKey } from '../../lib/linkedin-url.js'
import type { QueryScope } from './scope.js'

/**
 * Reading the LinkedIn archive: the two sources joined, per post.
 *
 * Content comes from the DMA snapshot poller and performance from the monthly
 * .xlsx import, and neither is a subset of the other — a post can have content
 * with no numbers yet (posted since the last export) or numbers with no content
 * (the poller has not reached it). Both are real posts, so the row universe is the
 * union of the two key sets rather than either table alone. See ADR 0033.
 */

/**
 * Which LinkedIn visibility values may be republished over REST (ADR 0026).
 *
 * LinkedIn's own vocabulary is inconsistent between surfaces — the UGC API uses
 * ANYONE/CONNECTIONS/LOGGED_IN/CONTAINER, while the data export writes the field
 * name MEMBER_NETWORK for the widest setting — so the values below cover the forms
 * that mean "anyone can see this". Everything else, INCLUDING an unreadable or
 * absent value, is withheld: ADR 0017 fails closed for the same reason, and a
 * visibility we could not parse is not evidence that a post was public.
 *
 * If a future export uses a token not listed here the REST endpoints will return
 * fewer rows than MCP does; the raw value is visible through MCP's `visibility`
 * field, so the fix is one query away rather than a mystery.
 */
export const PUBLIC_VISIBILITIES = ['PUBLIC', 'ANYONE', 'MEMBER_NETWORK']

/**
 * `visibility IN (…)` over PUBLIC_VISIBILITIES, as bound parameters.
 *
 * Spelled as an IN list rather than `= ANY(${array})`: drizzle expands a JS array
 * in a raw `sql` template into a parenthesised parameter list, `($1, $2, $3)`,
 * which is a row constructor and not an array — Postgres rejects it with
 * "op ANY/ALL (array) requires array on right side". An IN list is what that
 * expansion is actually valid for.
 */
export function publicVisibilityCondition(): SQL {
  return sql`visibility IN (${sql.join(PUBLIC_VISIBILITIES.map((v) => sql`${v}`), sql`, `)})`
}

/**
 * Post universe + latest metrics, as a CTE prefix.
 *
 * `latest` is DISTINCT ON (post_key) ordered by export_date DESC: metrics are
 * append-only, so "the numbers for this post" means its most recent observation,
 * not a sum over every export it appeared in. Summing would multiply-count a post
 * once per month it stayed in the top 50.
 */
const MERGED = sql`
  WITH latest AS (
    SELECT DISTINCT ON (post_key)
      post_key, post_url, export_date, window_start, window_end,
      posted_on, impressions, engagements
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
      COALESCE(p.post_url, l.post_url)                     AS post_url,
      COALESCE(p.posted_at, l.posted_on::timestamptz)      AS posted_at,
      p.commentary, p.visibility, p.shared_url, p.is_reshare,
      (p.post_key IS NOT NULL)                             AS has_content,
      l.export_date, l.impressions, l.engagements,
      CASE WHEN l.impressions > 0 AND l.engagements IS NOT NULL
           THEN round(l.engagements::numeric / l.impressions, 6) END AS engagement_rate
    FROM universe u
    LEFT JOIN linkedin_posts p ON p.post_key = u.post_key
    LEFT JOIN latest l ON l.post_key = u.post_key
  )
`

/** Filters over the merged view. */
function mergedConditions(
  input: { from?: string; to?: string; since?: string; visibility?: string },
  scope?: QueryScope,
): SQL[] {
  const conditions: SQL[] = []
  const from = input.from ?? input.since
  // Compared as calendar days: the .xlsx carries a publish date with no time, so
  // day granularity is the honest common denominator between the two sources.
  if (from) conditions.push(sql`posted_at::date >= ${from}::date`)
  if (input.to) conditions.push(sql`posted_at::date <= ${input.to}::date`)
  if (input.visibility) conditions.push(sql`visibility = ${input.visibility}`)
  if (scope?.publicOnly) conditions.push(publicVisibilityCondition())
  return conditions
}

function whereClause(conditions: SQL[]): SQL {
  if (conditions.length === 0) return sql``
  return sql` WHERE ${sql.join(conditions, sql` AND `)}`
}

// ---- get_linkedin_posts ----------------------------------------------------

export const getLinkedinPostsSchema = z.object({
  from: z.string().optional().describe('Only posts published on or after this date (YYYY-MM-DD)'),
  to: z.string().optional().describe('Only posts published on or before this date (YYYY-MM-DD)'),
  since: z.string().optional().describe('Alias for "from"'),
  visibility: z.string().optional().describe("Filter by LinkedIn's visibility string, e.g. PUBLIC or CONNECTIONS. Posts ingested before the poller reached them have no visibility recorded."),
  has_metrics: z.boolean().optional().describe('true → only posts with imported performance numbers; false → only posts still waiting for an export. Omit for both.'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Order by publish date. "desc" (default) is newest-first.'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1).describe('1-based page. This archive is small (tens of posts, not thousands), so plain offset paging is enough — there is no cursor to follow.'),
})

export async function getLinkedinPosts(
  input: z.infer<typeof getLinkedinPostsSchema>,
  scope?: QueryScope,
) {
  const db = getDb()
  const conditions = mergedConditions(input, scope)
  if (input.has_metrics === true) conditions.push(sql`export_date IS NOT NULL`)
  if (input.has_metrics === false) conditions.push(sql`export_date IS NULL`)

  const direction = input.sort_order === 'asc' ? sql`ASC` : sql`DESC`
  const offset = (input.page - 1) * input.limit

  const rows = [...await db.execute<{
    post_key: string
    post_url: string
    posted_at: string | null
    commentary: string | null
    visibility: string | null
    shared_url: string | null
    is_reshare: boolean | null
    has_content: boolean
    export_date: string | null
    impressions: number | null
    engagements: number | null
    engagement_rate: string | null
  }>(sql`
    ${MERGED}
    SELECT * FROM merged
    ${whereClause(conditions)}
    ORDER BY posted_at ${direction} NULLS LAST, post_key ${direction}
    LIMIT ${input.limit} OFFSET ${offset}
  `)]

  const [totals] = [...await db.execute<{ total: string }>(sql`
    ${MERGED}
    SELECT count(*) AS total FROM merged ${whereClause(conditions)}
  `)]

  return {
    count: rows.length,
    page: input.page,
    total: Number(totals?.total ?? 0),
    sort_order: input.sort_order,
    filters: {
      from: input.from ?? input.since ?? null,
      to: input.to ?? null,
      visibility: input.visibility ?? null,
      has_metrics: input.has_metrics ?? null,
    },
    posts: rows.map((r) => ({
      post_key: r.post_key,
      url: r.post_url,
      posted_at: r.posted_at,
      commentary: r.commentary,
      visibility: r.visibility,
      shared_url: r.shared_url,
      is_reshare: r.is_reshare ?? null,
      // False when the .xlsx has numbers for a post the poller has not ingested
      // yet — the row is real, the text is simply not here yet.
      has_content: r.has_content,
      latest_metrics: r.export_date
        ? {
            export_date: r.export_date,
            impressions: r.impressions,
            engagements: r.engagements,
            engagement_rate: r.engagement_rate === null ? null : Number(r.engagement_rate),
          }
        : null,
    })),
  }
}

// ---- get_linkedin_post -----------------------------------------------------

export const getLinkedinPostSchema = z.object({
  url: z.string().optional().describe('The post URL, in either form LinkedIn uses — the /feed/update/urn:li:activity: permalink or the /posts/<slug>-ugcPost-<id>-<hash> share link. Both reduce to the same post.'),
  post_key: z.string().optional().describe('The numeric activity id, as returned by get_linkedin_posts'),
})

export async function getLinkedinPost(
  input: z.infer<typeof getLinkedinPostSchema>,
  scope?: QueryScope,
) {
  if (!input.url && !input.post_key) {
    return { error: 'Provide either url or post_key' }
  }

  const key = canonicalPostKey(input.post_key ?? input.url)
  if (!key) {
    return { error: `Could not read a LinkedIn post id from: ${input.post_key ?? input.url}` }
  }

  const db = getDb()
  const conditions = [sql`post_key = ${key}`]
  if (scope?.publicOnly) conditions.push(publicVisibilityCondition())

  const [post] = [...await db.execute<{
    post_key: string
    post_url: string
    posted_at: string | null
    commentary: string | null
    visibility: string | null
    shared_url: string | null
    is_reshare: boolean | null
    has_content: boolean
  }>(sql`
    ${MERGED}
    SELECT * FROM merged ${whereClause(conditions)} LIMIT 1
  `)]

  if (!post) return { error: `No LinkedIn post found for: ${input.url ?? input.post_key}` }

  // Every observation, oldest first. Because the export's impressions are a
  // windowed accumulation rather than a lifetime total, this series is a reach
  // curve over successive exports — not a list of corrections to one number.
  const history = [...await db.execute<{
    export_date: string
    window_start: string | null
    window_end: string | null
    impressions: number | null
    engagements: number | null
    engagement_rate: string | null
  }>(sql`
    SELECT export_date, window_start, window_end, impressions, engagements,
           CASE WHEN impressions > 0 AND engagements IS NOT NULL
                THEN round(engagements::numeric / impressions, 6) END AS engagement_rate
    FROM linkedin_post_metrics
    WHERE post_key = ${key}
    ORDER BY export_date ASC
  `)]

  return {
    post_key: post.post_key,
    url: post.post_url,
    posted_at: post.posted_at,
    commentary: post.commentary,
    visibility: post.visibility,
    shared_url: post.shared_url,
    is_reshare: post.is_reshare ?? null,
    has_content: post.has_content,
    metrics_count: history.length,
    metrics_history: history.map((h) => ({
      export_date: h.export_date,
      window_start: h.window_start,
      window_end: h.window_end,
      impressions: h.impressions,
      engagements: h.engagements,
      engagement_rate: h.engagement_rate === null ? null : Number(h.engagement_rate),
    })),
  }
}
