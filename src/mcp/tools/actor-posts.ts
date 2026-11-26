import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { and, eq, gt, lt, isNull, inArray, getTableColumns, sql, type SQL } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { normalizeHashtag } from './hashtag-stats.js'
import {
  encodeCursor,
  decodeCursor,
  keysetCondition,
  keysetOrderBy,
  InvalidCursorError,
  type SortOrder,
} from './pagination.js'
import { scopeCondition, type QueryScope } from './scope.js'

/** The engagement counts a post can be sorted by. */
export const SORT_METRICS = ['views', 'likes', 'shares', 'replies'] as const
export type SortMetric = (typeof SORT_METRICS)[number]
export type SortBy = 'published' | SortMetric

export const getActorPostsSchema = z.object({
  actor_handle: z.string().describe('Actor handle (@user@domain) or full actor URL'),
  limit: z.number().int().min(1).max(100).default(20),
  since: z.string().optional().describe('ISO 8601 datetime — only posts after this time'),
  until: z.string().optional().describe('ISO 8601 datetime — only posts before this time'),
  object_types: z.array(z.string()).optional().describe('Filter by object type, e.g. ["Note", "Article"]'),
  tag: z.string().optional()
    .describe('Only posts carrying this hashtag (case-insensitive, leading # optional), e.g. "togselfie". Filtered in SQL so `limit` counts matching posts.'),
  sort_by: z.enum(['published', ...SORT_METRICS]).default('published')
    .describe('What to order by. "published" (default) is the post date. "views", "likes", "shares" or "replies" order by that engagement count as stored with the post (see `engagement` on each post); posts without the count come last in either direction, and ties fall back to the post date. Pair with since/until and limit:1 for "most viewed in 2025".'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Direction. "desc" (default) is newest-first, or highest count first with a sort_by count; "asc" is oldest-first or lowest first — pair with limit:1 to fetch the actor\'s earliest post in one call.'),
  cursor: z.string().optional()
    .describe('Opaque pagination cursor from a previous response\'s next_cursor. When set, continues from where the last page ended (respecting sort_by, sort_order and all filters). A cursor only works with the sort_by it came from.'),
})

/**
 * Where each count lives in the stored object, as a numeric, or NULL when the post does
 * not carry it. likes, shares and replies are AS2 Collections with `totalItems`, the way
 * Mastodon and the archive importers write them. Views have no AS2 property: only a TikTok
 * archive post has them, in `raw.tiktokArchive.post.views` (ADR 0078).
 *
 * Written table-qualified by hand: the expression goes into ORDER BY too, where drizzle
 * does not qualify a column (see keysetOrderBy). The `jsonb_typeof` guard makes a string
 * or an object in the same place read as "no count" instead of failing the cast.
 */
const METRIC_JSON: Record<SortMetric, [string, string]> = {
  views: [`"objects"."raw"->'tiktokArchive'->'post'->'views'`, `"objects"."raw"->'tiktokArchive'->'post'->>'views'`],
  likes: [`"objects"."raw"->'likes'->'totalItems'`, `"objects"."raw"->'likes'->>'totalItems'`],
  shares: [`"objects"."raw"->'shares'->'totalItems'`, `"objects"."raw"->'shares'->>'totalItems'`],
  replies: [`"objects"."raw"->'replies'->'totalItems'`, `"objects"."raw"->'replies'->>'totalItems'`],
}

export function metricExpr(metric: SortMetric): SQL {
  const [json, text] = METRIC_JSON[metric]
  return sql.raw(`(CASE WHEN jsonb_typeof(${json}) = 'number' THEN (${text})::numeric END)`)
}

export interface Engagement {
  views: number | null
  likes: number | null
  shares: number | null
  replies: number | null
}

/** The same four counts, read from a stored `raw` in JS, by the same rule as metricExpr. */
export function engagementOf(raw: unknown): Engagement {
  const o = (raw ?? {}) as Record<string, any>
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    views: n(o.tiktokArchive?.post?.views),
    likes: n(o.likes?.totalItems),
    shares: n(o.shares?.totalItems),
    replies: n(o.replies?.totalItems),
  }
}

type MetricCursor = { p: string | null; id: string; m: string | null }

/**
 * A cursor for a count sort carries the sort and the last row's count, so the next page
 * starts after (count, published_at, id). The date sort keeps the cursor it always had,
 * so a cursor issued before sort_by existed still works.
 */
export function encodeMetricCursor(metric: SortMetric, m: string | null, ts: Date | null, id: string): string {
  const payload = { p: ts ? ts.toISOString() : null, id, s: metric, m }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Decode a cursor for this sort, refusing one issued for another: its position means nothing here. */
export function decodePostsCursor(token: string, sortBy: SortBy): MetricCursor {
  const c = decodeCursor(token) as ReturnType<typeof decodeCursor> & { s?: unknown; m?: unknown }
  const issuedFor = typeof c.s === 'string' ? c.s : 'published'
  if (issuedFor !== sortBy) {
    throw new InvalidCursorError(`Invalid cursor: it belongs to sort_by=${issuedFor}, not sort_by=${sortBy}`)
  }
  if (sortBy === 'published') return { p: c.p, id: c.id, m: null }
  const m = c.m
  if (!(m === null || (typeof m === 'string' && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(m)))) {
    throw new InvalidCursorError('Invalid cursor: malformed payload')
  }
  return { p: c.p, id: c.id, m }
}

/**
 * Rows strictly past the cursor under ORDER BY count, published_at, id, every key NULLS
 * LAST. A row with a count is followed by every row without one; inside one count, the
 * date keyset decides.
 */
export function metricKeysetCondition(expr: SQL, cursor: MetricCursor, order: SortOrder): SQL {
  const rest = keysetCondition(objects.publishedAt, objects.id, { p: cursor.p, id: cursor.id }, order)
  if (cursor.m === null) return sql`(${expr} IS NULL AND ${rest})`
  const past = order === 'asc' ? sql`${expr} > ${cursor.m}::numeric` : sql`${expr} < ${cursor.m}::numeric`
  return sql`(${past} OR (${expr} = ${cursor.m}::numeric AND ${rest}) OR ${expr} IS NULL)`
}

export function metricOrderBy(expr: SQL, order: SortOrder): SQL {
  const dir = order === 'asc' ? sql`ASC` : sql`DESC`
  return sql`${expr} ${dir} NULLS LAST, ${keysetOrderBy(objects.publishedAt, objects.id, order)}`
}

/**
 * SQL predicate: the post's `objects.tags` JSONB array carries the given hashtag.
 * Mirrors the `EXISTS (jsonb_array_elements …)` filter in `hashtag-stats.ts`
 * (`type = 'hashtag'`, name compared with its leading `#` stripped and lowercased).
 * The `jsonb_typeof … = 'array'` guard keeps rows whose tags are null/non-array
 * from erroring `jsonb_array_elements`. Pure (takes a raw tag, normalizes it) so it
 * can be unit-tested without a database.
 */
export function hashtagCondition(tag: string): SQL {
  const normalized = normalizeHashtag(tag)
  return sql`jsonb_typeof(${objects.tags}) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(${objects.tags}) AS t
    WHERE lower(t->>'type') = 'hashtag'
      AND lower(ltrim(t->>'name', '#')) = ${normalized}
  )`
}

export async function getActorPosts(
  input: z.infer<typeof getActorPostsSchema>,
  scope?: QueryScope,
) {
  const actor = input.actor_handle.startsWith('http')
    ? { apId: input.actor_handle }
    : await resolveActorByHandle(input.actor_handle)

  if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }

  const db = getDb()
  const conditions: SQL[] = [
    eq(objects.actorApId, actor.apId),
    isNull(objects.deletedAt),
  ]
  if (input.since) conditions.push(gt(objects.publishedAt, new Date(input.since)))
  if (input.until) conditions.push(lt(objects.publishedAt, new Date(input.until)))
  // Filter by type in SQL so `limit` counts matching rows (not pre-filter rows).
  if (input.object_types?.length) conditions.push(inArray(objects.type, input.object_types))
  // Same reasoning for the hashtag filter — done in SQL so pagination stays correct.
  if (input.tag) conditions.push(hashtagCondition(input.tag))
  const sortBy: SortBy = input.sort_by ?? 'published'
  const metric = sortBy === 'published' ? null : metricExpr(sortBy)
  if (input.cursor) {
    const cursor = decodePostsCursor(input.cursor, sortBy)
    conditions.push(metric
      ? metricKeysetCondition(metric, cursor, input.sort_order)
      : keysetCondition(objects.publishedAt, objects.id, cursor, input.sort_order))
  }
  // Public-only when the caller is the outside world (ADR 0026). Added to the
  // conditions rather than filtered afterwards, so `limit` counts rows the caller
  // may actually see and pagination does not return short pages.
  const visible = scopeCondition(scope)
  if (visible) conditions.push(visible)

  const rows = await db.select({ ...getTableColumns(objects), sortValue: metric ?? sql<null>`NULL` })
    .from(objects)
    .where(and(...conditions))
    .orderBy(metric ? metricOrderBy(metric, input.sort_order) : keysetOrderBy(objects.publishedAt, objects.id, input.sort_order))
    .limit(input.limit)

  const last = rows[rows.length - 1]
  const nextCursor = rows.length === input.limit && last
    ? (sortBy === 'published'
      ? encodeCursor(last.publishedAt, last.id)
      : encodeMetricCursor(sortBy, last.sortValue == null ? null : String(last.sortValue), last.publishedAt, last.id))
    : null

  return {
    count: rows.length,
    next_cursor: nextCursor,
    sort_by: sortBy,
    sort_order: input.sort_order,
    filters: {
      actor_handle: input.actor_handle,
      since: input.since ?? null,
      until: input.until ?? null,
      object_types: input.object_types ?? null,
      tag: input.tag ? normalizeHashtag(input.tag) : null,
    },
    posts: rows.map(r => ({
      ap_id: r.apId,
      type: r.type,
      content: r.contentText,
      summary: r.summary,
      url: r.url,
      in_reply_to: r.inReplyTo,
      published_at: r.publishedAt,
      attachments: r.attachments,
      tags: r.tags,
      engagement: engagementOf(r.raw),
    })),
  }
}
