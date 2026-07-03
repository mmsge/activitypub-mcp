import { z } from 'zod'
import { sql, eq, desc, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { engagementSnapshots } from '../../db/schema.js'
import { config, getOwnerInstanceHost } from '../../config.js'
import {
  parseStatusRef,
  fetchEngagement,
  mapPool,
  type StatusRef,
  type EngagementCounts,
} from '../../lib/fetch-engagement.js'

/**
 * Live engagement counts, read from each status's ORIGIN instance and snapshotted
 * into `engagement_snapshots` so repeated reads build a per-status time series.
 * get_engagement is the write/read side (batch live fetch + snapshot); the
 * trends tool below reads the stored history back as bucketed series.
 */

const FETCH_CONCURRENCY = 5

const num = (v: unknown): number => Number(v ?? 0)
const iso = (v: unknown): string | null =>
  v == null ? null : new Date(v as string).toISOString()

// ── get_engagement ───────────────────────────────────────────────────────────

export const getEngagementSchema = z.object({
  statuses: z
    .array(z.string().min(1))
    .min(1)
    .max(config.ENGAGEMENT_MAX_BATCH)
    .describe(
      'Status references: Mastodon permalink (https://host/@user/id), AP object id ' +
        '(https://host/users/u/statuses/id), or bare numeric id (resolved against OWNER_INSTANCE).',
    ),
  snapshot: z.boolean().default(true),
  skip_unchanged: z.boolean().default(false),
  prefer: z.enum(['rest', 'ap']).default('rest'),
})

type EngagementResult =
  | {
      input: string
      status_ap_id: string
      status_id: string
      origin: string
      url: string | null
      favourites_count: number
      reblogs_count: number
      replies_count: number
      quotes_count: number | null
      source: 'rest' | 'ap'
      sampled_at: string
      snapshot_id: string | null
      snapshot: 'written' | 'skipped_unchanged' | 'disabled'
      snapshot_error?: string
    }
  | { input: string; error: string; message: string }

async function writeSnapshot(
  ref: StatusRef,
  statusApId: string,
  counts: EngagementCounts,
  source: 'rest' | 'ap',
  sampledAt: Date,
  skipUnchanged: boolean,
): Promise<{ snapshotId: string | null; state: 'written' | 'skipped_unchanged' }> {
  const db = getDb()
  if (skipUnchanged) {
    const [last] = await db
      .select()
      .from(engagementSnapshots)
      .where(eq(engagementSnapshots.statusApId, statusApId))
      .orderBy(desc(engagementSnapshots.sampledAt))
      .limit(1)
    if (
      last &&
      last.favourites === counts.favourites &&
      last.reblogs === counts.reblogs &&
      last.replies === counts.replies &&
      (last.quotes ?? null) === (counts.quotes ?? null)
    ) {
      return { snapshotId: null, state: 'skipped_unchanged' }
    }
  }
  const [row] = await db
    .insert(engagementSnapshots)
    .values({
      statusApId,
      statusId: ref.statusId,
      origin: ref.origin,
      favourites: counts.favourites,
      reblogs: counts.reblogs,
      replies: counts.replies,
      quotes: counts.quotes,
      source,
      sampledAt,
    })
    .returning({ id: engagementSnapshots.id })
  return { snapshotId: row.id, state: 'written' }
}

export async function getEngagement(input: z.infer<typeof getEngagementSchema>) {
  const ownerHost = getOwnerInstanceHost()
  const results = new Array<EngagementResult>(input.statuses.length)

  // Duplicate refs in one batch collapse to a single fetch + snapshot; every
  // input still gets its own result row (order preserved).
  const unique = new Map<string, { ref: StatusRef; indexes: number[] }>()
  input.statuses.forEach((raw, i) => {
    const parsed = parseStatusRef(raw, ownerHost)
    if ('error' in parsed) {
      results[i] = { input: raw, error: parsed.error, message: parsed.message }
      return
    }
    const key = `${parsed.origin} ${parsed.statusId}`
    const entry = unique.get(key)
    if (entry) entry.indexes.push(i)
    else unique.set(key, { ref: parsed, indexes: [i] })
  })

  await mapPool([...unique.values()], FETCH_CONCURRENCY, async ({ ref, indexes }) => {
    const outcome = await fetchEngagement(ref, {
      prefer: input.prefer,
      timeoutMs: config.ENGAGEMENT_HTTP_TIMEOUT_MS,
    })

    let item: Omit<EngagementResult, 'input'>
    if (!outcome.ok) {
      item = { error: outcome.code, message: outcome.message } as Omit<EngagementResult, 'input'>
    } else {
      const sampledAt = new Date()
      let snapshotId: string | null = null
      let snapshotState: 'written' | 'skipped_unchanged' | 'disabled' = 'disabled'
      let snapshotError: string | undefined
      if (input.snapshot) {
        // A failed write must not turn a successful live read into a batch
        // failure — the counts are still the answer; the row just didn't stick.
        try {
          const w = await writeSnapshot(
            ref, outcome.statusApId, outcome.counts, outcome.source, sampledAt, input.skip_unchanged,
          )
          snapshotId = w.snapshotId
          snapshotState = w.state
        } catch (e) {
          snapshotError = e instanceof Error ? e.message : String(e)
        }
      }
      item = {
        status_ap_id: outcome.statusApId,
        status_id: ref.statusId,
        origin: ref.origin,
        url: outcome.url,
        favourites_count: outcome.counts.favourites,
        reblogs_count: outcome.counts.reblogs,
        replies_count: outcome.counts.replies,
        quotes_count: outcome.counts.quotes,
        source: outcome.source,
        sampled_at: sampledAt.toISOString(),
        snapshot_id: snapshotId,
        snapshot: snapshotState,
        ...(snapshotError ? { snapshot_error: snapshotError } : {}),
      } as Omit<EngagementResult, 'input'>
    }
    for (const i of indexes) {
      results[i] = { ...item, input: input.statuses[i] } as EngagementResult
    }
  })

  const failed = results.filter((r) => 'error' in r).length
  return { ok: results.length - failed, failed, results }
}

// ── get_engagement_trends ────────────────────────────────────────────────────

export const getEngagementTrendsSchema = z.object({
  status: z
    .string()
    .min(1)
    .describe('One status reference: permalink, AP object id, or bare id (OWNER_INSTANCE).'),
  group_by: z.enum(['hour', 'day', 'week', 'month']).default('day'),
  metric: z.enum(['favourites', 'reblogs', 'replies', 'all']).default('all'),
  from: z.string().optional(),
  to: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(120),
})

export type TrendBucketRow = {
  bucket: string // bucket label, e.g. "2026-07-02" or "2026-07-02T09:00:00Z"
  favourites: number
  reblogs: number
  replies: number
  quotes: number | null
  sampled_at: string // when the bucket's winning (latest) snapshot was taken
}

/**
 * Turn latest-per-bucket snapshot rows (oldest → newest) into the output series.
 * Each bucket carries the latest observed counts plus the delta from the previous
 * PRESENT bucket (gaps are skipped over, not zero-filled). The first bucket's
 * deltas are null — there is nothing to diff against. Deltas can be negative:
 * favourites and boosts can be undone, and that's real signal, not an error.
 */
export function buildTrendSeries(rows: TrendBucketRow[], metric: 'favourites' | 'reblogs' | 'replies' | 'all') {
  return rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1] : null
    if (metric === 'all') {
      return {
        bucket: r.bucket,
        sampled_at: r.sampled_at,
        favourites: r.favourites,
        reblogs: r.reblogs,
        replies: r.replies,
        quotes: r.quotes,
        d_favourites: prev ? r.favourites - prev.favourites : null,
        d_reblogs: prev ? r.reblogs - prev.reblogs : null,
        d_replies: prev ? r.replies - prev.replies : null,
        d_quotes: prev && r.quotes != null && prev.quotes != null ? r.quotes - prev.quotes : null,
      }
    }
    const value = r[metric]
    const prevValue = prev?.[metric]
    return {
      bucket: r.bucket,
      sampled_at: r.sampled_at,
      value,
      delta: prev && prevValue != null ? value - prevValue : null,
    }
  })
}

const BUCKET_FORMATS: Record<string, string> = {
  hour: 'YYYY-MM-DD"T"HH24:00:00"Z"',
  day: 'YYYY-MM-DD',
  week: 'YYYY-MM-DD', // date_trunc weeks start Monday
  month: 'YYYY-MM',
}

export async function getEngagementTrends(input: z.infer<typeof getEngagementTrendsSchema>) {
  const ref = parseStatusRef(input.status, getOwnerInstanceHost())
  if ('error' in ref) return { error: ref.message }

  const db = getDb()

  // Any ref form normalises to (origin, status_id) offline; the stored canonical
  // AP id (the origin's own `uri`) may differ from a synthesized candidate, so
  // match on both and read the canonical id back from the table.
  const apIdCond = ref.candidateApId
    ? sql`(origin = ${ref.origin} AND status_id = ${ref.statusId}) OR status_ap_id = ${ref.candidateApId}`
    : sql`origin = ${ref.origin} AND status_id = ${ref.statusId}`
  const idRow = [...await db.execute<{ status_ap_id: string }>(sql`
    SELECT status_ap_id FROM engagement_snapshots
    WHERE ${apIdCond}
    ORDER BY sampled_at DESC
    LIMIT 1
  `)][0]
  if (!idRow) {
    return {
      error: `No engagement snapshots stored for ${input.status} — call get_engagement on it first`,
    }
  }
  const statusApId = idRow.status_ap_id

  const conds: SQL[] = [sql`status_ap_id = ${statusApId}`]
  if (input.from) conds.push(sql`sampled_at >= ${new Date(input.from)}`)
  if (input.to) conds.push(sql`sampled_at <= ${new Date(input.to)}`)
  if (input.since) conds.push(sql`sampled_at > ${new Date(input.since)}`)
  const where = sql.join(conds, sql` AND `)

  // Latest snapshot per bucket (last observation carried), newest buckets kept
  // under the limit, reversed below so the series reads oldest → newest. The
  // AT TIME ZONE 'UTC' pins bucket boundaries to UTC regardless of server TZ —
  // it matters once hour-granularity buckets exist.
  const bucketExpr = sql`date_trunc(${input.group_by}, sampled_at AT TIME ZONE 'UTC')`
  const rows = [...await db.execute<{
    bucket: string
    favourites: string | number
    reblogs: string | number
    replies: string | number
    quotes: string | number | null
    sampled_at: string
  }>(sql`
    SELECT DISTINCT ON (${bucketExpr})
           to_char(${bucketExpr}, ${BUCKET_FORMATS[input.group_by]}) AS bucket,
           favourites, reblogs, replies, quotes, sampled_at
    FROM engagement_snapshots
    WHERE ${where}
    ORDER BY ${bucketExpr} DESC, sampled_at DESC
    LIMIT ${input.limit}
  `)].reverse()

  const bucketRows: TrendBucketRow[] = rows.map((r) => ({
    bucket: r.bucket,
    favourites: num(r.favourites),
    reblogs: num(r.reblogs),
    replies: num(r.replies),
    quotes: r.quotes == null ? null : num(r.quotes),
    sampled_at: iso(r.sampled_at) as string,
  }))

  const [agg] = [...await db.execute<{
    snapshot_count: string
    first_sampled_at: string
    last_sampled_at: string
  }>(sql`
    SELECT count(*) AS snapshot_count,
           min(sampled_at) AS first_sampled_at,
           max(sampled_at) AS last_sampled_at
    FROM engagement_snapshots
    WHERE status_ap_id = ${statusApId}
  `)]

  return {
    status_ap_id: statusApId,
    group_by: input.group_by,
    metric: input.metric,
    series: buildTrendSeries(bucketRows, input.metric),
    first_sampled_at: iso(agg?.first_sampled_at),
    last_sampled_at: iso(agg?.last_sampled_at),
    snapshot_count: num(agg?.snapshot_count),
  }
}
