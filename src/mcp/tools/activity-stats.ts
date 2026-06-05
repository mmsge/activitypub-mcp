import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects, activities } from '../../db/schema.js'
import { and, eq, gt, count, sum, avg, max, isNull, inArray } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { sql } from 'drizzle-orm'

export const getActivityStatsSchema = z.object({
  actor_handle: z.string().optional(),
  since: z.string().optional(),
})

export async function getActivityStats(input: z.infer<typeof getActivityStatsSchema>) {
  const db = getDb()
  const conditions = [isNull(objects.deletedAt)]
  let actorApId: string | null = null

  if (input.actor_handle) {
    const actor = input.actor_handle.startsWith('http')
      ? { apId: input.actor_handle }
      : await resolveActorByHandle(input.actor_handle)
    if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }
    actorApId = actor.apId
    conditions.push(eq(objects.actorApId, actor.apId))
  }

  if (input.since) {
    conditions.push(gt(objects.publishedAt, new Date(input.since)))
  }

  const byType = await db
    .select({ type: objects.type, count: count() })
    .from(objects)
    .where(and(...conditions))
    .groupBy(objects.type)
    .orderBy(count())

  const totalCount = byType.reduce((acc, r) => acc + Number(r.count), 0)

  // Single aggregate pass: engagement + content metrics.
  const [agg] = await db
    .select({
      totalLikes: sum(objects.likesCount),
      avgLikes: avg(objects.likesCount),
      maxLikes: max(objects.likesCount),
      totalBoosts: sum(objects.boostsCount),
      avgBoosts: avg(objects.boostsCount),
      maxBoosts: max(objects.boostsCount),
      totalReplies: sum(objects.repliesCount),
      avgReplies: avg(objects.repliesCount),
      maxReplies: max(objects.repliesCount),
      avgContentLength: avg(sql`length(COALESCE(${objects.contentText}, ''))`),
      withAttachments: sql<number>`count(*) FILTER (WHERE jsonb_array_length(COALESCE(${objects.attachments}::jsonb, '[]'::jsonb)) > 0)`,
      totalAttachments: sql<number>`COALESCE(SUM(jsonb_array_length(COALESCE(${objects.attachments}::jsonb, '[]'::jsonb))), 0)`,
      replyPosts: sql<number>`count(*) FILTER (WHERE ${objects.inReplyTo} IS NOT NULL)`,
    })
    .from(objects)
    .where(and(...conditions))

  // Observed boosts: Announce activities this server actually received,
  // optionally scoped to the actor's stored objects.
  const announceConds = [eq(activities.type, 'Announce')]
  if (input.since) announceConds.push(gt(activities.receivedAt, new Date(input.since)) as any)
  if (actorApId) {
    announceConds.push(inArray(
      activities.objectApId,
      db.select({ apId: objects.apId }).from(objects).where(and(...conditions)),
    ) as any)
  }
  const [observed] = await db
    .select({ count: count() })
    .from(activities)
    .where(and(...announceConds))

  // Top hashtags from the tags jsonb array.
  const topHashtags = await db.execute(sql`
    SELECT tag->>'name' AS name, count(*)::int AS n
    FROM ${objects}, jsonb_array_elements(COALESCE(${objects.tags}::jsonb, '[]'::jsonb)) AS tag
    WHERE ${and(...conditions)} AND tag->>'type' = 'Hashtag'
    GROUP BY name
    ORDER BY n DESC
    LIMIT 10
  `)

  const n = (v: unknown) => v == null ? 0 : Number(v)
  const round = (v: unknown) => v == null ? 0 : Math.round(Number(v) * 100) / 100
  const replyPosts = n(agg?.replyPosts)

  return {
    total: totalCount,
    by_type: byType,
    with_attachments: n(agg?.withAttachments),
    since: input.since ?? null,
    engagement: {
      likes: { total: n(agg?.totalLikes), avg: round(agg?.avgLikes), max: n(agg?.maxLikes) },
      boosts: { total: n(agg?.totalBoosts), avg: round(agg?.avgBoosts), max: n(agg?.maxBoosts) },
      replies: { total: n(agg?.totalReplies), avg: round(agg?.avgReplies), max: n(agg?.maxReplies) },
      observed_boosts: n(observed?.count),
    },
    content: {
      avg_content_length: round(agg?.avgContentLength),
      total_attachments: n(agg?.totalAttachments),
      avg_attachments: totalCount > 0 ? round(n(agg?.totalAttachments) / totalCount) : 0,
      reply_posts: replyPosts,
      reply_ratio: totalCount > 0 ? round(replyPosts / totalCount) : 0,
      top_hashtags: (topHashtags as unknown as Array<{ name: string; n: number }>).map(r => ({
        name: r.name, count: Number(r.n),
      })),
    },
  }
}

export const getRecentActivitiesSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  types: z.array(z.string()).optional(),
  since: z.string().optional(),
})

export async function getRecentActivities(input: z.infer<typeof getRecentActivitiesSchema>) {
  const db = getDb()
  const conditions: ReturnType<typeof eq>[] = []
  if (input.since) conditions.push(gt(activities.receivedAt, new Date(input.since)) as any)

  const rows = await db.select({
    id: activities.id,
    type: activities.type,
    actorApId: activities.actorApId,
    objectType: activities.objectType,
    receivedAt: activities.receivedAt,
  }).from(activities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${activities.receivedAt} DESC`)
    .limit(input.limit)

  const filtered = input.types?.length
    ? rows.filter(r => input.types!.includes(r.type))
    : rows

  return filtered
}
