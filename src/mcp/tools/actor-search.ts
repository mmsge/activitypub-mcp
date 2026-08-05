import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { and, eq, isNull, desc, ilike, inArray, or } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { scopeCondition, type QueryScope } from './scope.js'

export const searchActorContentSchema = z.object({
  query: z.string().min(1).describe('Search terms'),
  actor_handle: z.string().optional().describe('Scope to a specific actor; omit to search all followed actors'),
  limit: z.number().int().min(1).max(50).default(20),
  object_types: z.array(z.string()).optional()
    .describe('Filter by AP object type, e.g. ["Note", "Article"]. Omit to search every type — BookWyrm reading statuses federate as plain Notes, so they are included by default.'),
})

export async function searchActorContent(
  input: z.infer<typeof searchActorContentSchema>,
  scope?: QueryScope,
) {
  const db = getDb()
  const conditions = [isNull(objects.deletedAt)]
  // Public-only for REST callers — see ADR 0026. Full-text search over an archive
  // that holds followers-only posts is the sharpest way to surface one.
  const visible = scopeCondition(scope)
  if (visible) conditions.push(visible)

  if (input.actor_handle) {
    const actor = input.actor_handle.startsWith('http')
      ? { apId: input.actor_handle }
      : await resolveActorByHandle(input.actor_handle)
    if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }
    conditions.push(eq(objects.actorApId, actor.apId))
  }

  // Simple ILIKE search — works without tsvector for portability. Must be ILIKE:
  // Postgres LIKE is case-sensitive, so a lowercased term against mixed-case
  // content ("Dungeon Crawler Carl") would never match.
  const term = `%${input.query}%`
  conditions.push(
    or(
      ilike(objects.contentText, term),
      ilike(objects.summary, term),
    )!
  )

  // Filter in SQL so `limit` applies after the type filter — filtering the
  // limited page in memory silently dropped matches beyond the first `limit` rows.
  if (input.object_types?.length) {
    conditions.push(inArray(objects.type, input.object_types))
  }

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

  return { count: rows.length, results: rows }
}
