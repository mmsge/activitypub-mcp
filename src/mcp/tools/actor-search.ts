import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { and, eq, isNull, desc, like, or } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'

export const searchActorContentSchema = z.object({
  query: z.string().min(1).describe('Search terms'),
  actor_handle: z.string().optional().describe('Scope to a specific actor; omit to search all followed actors'),
  limit: z.number().int().min(1).max(50).default(20),
  object_types: z.array(z.string()).optional(),
})

export async function searchActorContent(input: z.infer<typeof searchActorContentSchema>) {
  const db = getDb()
  const conditions = [isNull(objects.deletedAt)]

  if (input.actor_handle) {
    const actor = input.actor_handle.startsWith('http')
      ? { apId: input.actor_handle }
      : await resolveActorByHandle(input.actor_handle)
    if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }
    conditions.push(eq(objects.actorApId, actor.apId))
  }

  // Simple ILIKE search — works without tsvector for portability
  const term = `%${input.query.toLowerCase()}%`
  conditions.push(
    or(
      like(objects.contentText, term),
      like(objects.summary, term),
    )!
  )

  const rows = await db.select({
    apId: objects.apId,
    type: objects.type,
    actorApId: objects.actorApId,
    content: objects.contentText,
    summary: objects.summary,
    url: objects.url,
    publishedAt: objects.publishedAt,
  }).from(objects)
    .where(and(...conditions))
    .orderBy(desc(objects.publishedAt))
    .limit(input.limit)

  const filtered = input.object_types?.length
    ? rows.filter(r => input.object_types!.includes(r.type))
    : rows

  return { count: filtered.length, results: filtered }
}
