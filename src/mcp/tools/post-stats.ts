import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { and, eq, gt, lt, gte, isNull, like, or, sql, count, sum, avg, max, inArray } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { observedBoostCounts } from '../../lib/extract-engagement.js'

// When ranking by a derived (non-column) metric we pull a bounded candidate
// window, compute the metric, then sort/slice in memory.
const CANDIDATE_CAP = 500

async function resolveActorApId(handle: string): Promise<string | { error: string }> {
  if (handle.startsWith('http')) return handle
  const actor = await resolveActorByHandle(handle)
  if (!actor) return { error: `Could not resolve actor: ${handle}` }
  return actor.apId
}

function snippet(text: string | null, summary: string | null): string | null {
  const s = text ?? summary
  if (!s) return null
  return s.length > 280 ? `${s.slice(0, 280)}…` : s
}

export const searchPostsByStatsSchema = z.object({
  actor_handle: z.string().optional().describe('Scope to one actor; omit for all followed actors'),
  query: z.string().optional().describe('Optional text filter (ILIKE on content/summary)'),
  object_types: z.array(z.string()).optional().describe('Filter by object type, e.g. Note, Article'),
  since: z.string().optional().describe('Only posts published after this ISO 8601 timestamp'),
  until: z.string().optional().describe('Only posts published before this ISO 8601 timestamp'),
  min_likes: z.number().int().min(0).optional(),
  min_boosts: z.number().int().min(0).optional().describe('Minimum boost/share count (from source post)'),
  min_replies: z.number().int().min(0).optional(),
  sort_by: z.enum(['likes', 'boosts', 'replies', 'observed_boosts', 'published'])
    .default('likes')
    .describe('observed_boosts ranks by Announce activities this server actually received'),
  order: z.enum(['desc', 'asc']).default('desc'),
  limit: z.number().int().min(1).max(100).default(20),
})

export async function searchPostsByStats(input: z.infer<typeof searchPostsByStatsSchema>) {
  const db = getDb()
  const conditions = [isNull(objects.deletedAt)]

  if (input.actor_handle) {
    const resolved = await resolveActorApId(input.actor_handle)
    if (typeof resolved !== 'string') return resolved
    conditions.push(eq(objects.actorApId, resolved))
  }
  if (input.query) {
    const term = `%${input.query.toLowerCase()}%`
    conditions.push(or(like(objects.contentText, term), like(objects.summary, term))!)
  }
  if (input.object_types?.length) conditions.push(inArray(objects.type, input.object_types))
  if (input.since) conditions.push(gt(objects.publishedAt, new Date(input.since)))
  if (input.until) conditions.push(lt(objects.publishedAt, new Date(input.until)))
  if (input.min_likes != null) conditions.push(gte(objects.likesCount, input.min_likes))
  if (input.min_boosts != null) conditions.push(gte(objects.boostsCount, input.min_boosts))
  if (input.min_replies != null) conditions.push(gte(objects.repliesCount, input.min_replies))

  const cols = {
    apId: objects.apId,
    type: objects.type,
    actorApId: objects.actorApId,
    content: objects.contentText,
    summary: objects.summary,
    url: objects.url,
    publishedAt: objects.publishedAt,
    likesCount: objects.likesCount,
    boostsCount: objects.boostsCount,
    repliesCount: objects.repliesCount,
  }

  const dir = input.order
  const sortColumn = input.sort_by === 'likes' ? objects.likesCount
    : input.sort_by === 'boosts' ? objects.boostsCount
    : input.sort_by === 'replies' ? objects.repliesCount
    : input.sort_by === 'published' ? objects.publishedAt
    : null // observed_boosts → derived, handled below

  let rows: Array<Record<string, unknown>>

  if (sortColumn) {
    // Column-backed sort: push NULLs last regardless of direction.
    const orderExpr = dir === 'desc'
      ? sql`${sortColumn} DESC NULLS LAST`
      : sql`${sortColumn} ASC NULLS LAST`
    rows = await db.select(cols).from(objects)
      .where(and(...conditions))
      .orderBy(orderExpr)
      .limit(input.limit)
    const boosts = await observedBoostCounts(rows.map(r => r.apId as string))
    rows = rows.map(r => ({ ...r, observedBoosts: boosts.get(r.apId as string) ?? 0 }))
  } else {
    // observed_boosts: pull a candidate window, compute, then sort/slice.
    const candidates = await db.select(cols).from(objects)
      .where(and(...conditions))
      .orderBy(sql`${objects.publishedAt} DESC NULLS LAST`)
      .limit(CANDIDATE_CAP)
    const boosts = await observedBoostCounts(candidates.map(r => r.apId as string))
    const enriched = candidates.map(r => ({ ...r, observedBoosts: boosts.get(r.apId as string) ?? 0 }))
    enriched.sort((a, b) => dir === 'desc'
      ? b.observedBoosts - a.observedBoosts
      : a.observedBoosts - b.observedBoosts)
    rows = enriched.slice(0, input.limit)
  }

  return {
    count: rows.length,
    sort_by: input.sort_by,
    order: input.order,
    results: rows.map(r => ({
      apId: r.apId,
      type: r.type,
      actorApId: r.actorApId,
      content: snippet(r.content as string | null, r.summary as string | null),
      url: r.url,
      publishedAt: r.publishedAt,
      likes: r.likesCount ?? null,
      boosts: r.boostsCount ?? null,
      replies: r.repliesCount ?? null,
      observedBoosts: r.observedBoosts,
    })),
  }
}

export const getActorEngagementSchema = z.object({
  since: z.string().optional().describe('Only count posts published after this ISO 8601 timestamp'),
  object_types: z.array(z.string()).optional(),
  sort_by: z.enum(['total_likes', 'total_boosts', 'total_replies', 'avg_likes', 'post_count'])
    .default('total_likes'),
  limit: z.number().int().min(1).max(100).default(20),
})

export async function getActorEngagement(input: z.infer<typeof getActorEngagementSchema>) {
  const db = getDb()
  const conditions = [isNull(objects.deletedAt)]
  if (input.since) conditions.push(gt(objects.publishedAt, new Date(input.since)))
  if (input.object_types?.length) conditions.push(inArray(objects.type, input.object_types))

  const grouped = await db.select({
    actorApId: objects.actorApId,
    postCount: count(),
    totalLikes: sum(objects.likesCount),
    totalBoosts: sum(objects.boostsCount),
    totalReplies: sum(objects.repliesCount),
    avgLikes: avg(objects.likesCount),
    avgBoosts: avg(objects.boostsCount),
    avgReplies: avg(objects.repliesCount),
    maxLikes: max(objects.likesCount),
    maxBoosts: max(objects.boostsCount),
    maxReplies: max(objects.repliesCount),
  }).from(objects)
    .where(and(...conditions))
    .groupBy(objects.actorApId)

  const num = (v: unknown) => v == null ? 0 : Number(v)
  const round = (v: unknown) => v == null ? 0 : Math.round(Number(v) * 100) / 100

  const ranked = grouped.map(g => ({
    actorApId: g.actorApId,
    postCount: num(g.postCount),
    totalLikes: num(g.totalLikes),
    totalBoosts: num(g.totalBoosts),
    totalReplies: num(g.totalReplies),
    avgLikes: round(g.avgLikes),
    avgBoosts: round(g.avgBoosts),
    avgReplies: round(g.avgReplies),
    maxLikes: num(g.maxLikes),
    maxBoosts: num(g.maxBoosts),
    maxReplies: num(g.maxReplies),
  }))

  const key = input.sort_by === 'total_boosts' ? 'totalBoosts'
    : input.sort_by === 'total_replies' ? 'totalReplies'
    : input.sort_by === 'avg_likes' ? 'avgLikes'
    : input.sort_by === 'post_count' ? 'postCount'
    : 'totalLikes'
  ranked.sort((a, b) => (b[key] as number) - (a[key] as number))

  return {
    actor_count: ranked.length,
    sort_by: input.sort_by,
    actors: ranked.slice(0, input.limit),
  }
}
