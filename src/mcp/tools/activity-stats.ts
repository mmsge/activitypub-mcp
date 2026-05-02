import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects, activities } from '../../db/schema.js'
import { and, eq, gt, count, isNull } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { sql } from 'drizzle-orm'

export const getActivityStatsSchema = z.object({
  actor_handle: z.string().optional(),
  since: z.string().optional(),
})

export async function getActivityStats(input: z.infer<typeof getActivityStatsSchema>) {
  const db = getDb()
  const conditions = [isNull(objects.deletedAt)]

  if (input.actor_handle) {
    const actor = input.actor_handle.startsWith('http')
      ? { apId: input.actor_handle }
      : await resolveActorByHandle(input.actor_handle)
    if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }
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

  const totalCount = byType.reduce((sum, r) => sum + Number(r.count), 0)

  const withAttachments = await db
    .select({ count: count() })
    .from(objects)
    .where(and(
      ...conditions,
      sql`jsonb_array_length(COALESCE(${objects.attachments}::jsonb, '[]'::jsonb)) > 0`,
    ))

  return {
    total: totalCount,
    by_type: byType,
    with_attachments: Number(withAttachments[0]?.count ?? 0),
    since: input.since ?? null,
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
