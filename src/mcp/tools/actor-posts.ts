import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { and, eq, gt, lt, isNull, inArray, type SQL } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { encodeCursor, decodeCursor, keysetCondition, keysetOrderBy } from './pagination.js'

export const getActorPostsSchema = z.object({
  actor_handle: z.string().describe('Actor handle (@user@domain) or full actor URL'),
  limit: z.number().int().min(1).max(100).default(20),
  since: z.string().optional().describe('ISO 8601 datetime — only posts after this time'),
  until: z.string().optional().describe('ISO 8601 datetime — only posts before this time'),
  object_types: z.array(z.string()).optional().describe('Filter by object type, e.g. ["Note", "Article"]'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Order by published_at. "desc" (default) is newest-first; "asc" is oldest-first — pair with limit:1 to fetch the actor\'s earliest post in one call.'),
  cursor: z.string().optional()
    .describe('Opaque pagination cursor from a previous response\'s next_cursor. When set, continues from where the last page ended (respecting sort_order and all filters).'),
})

export async function getActorPosts(input: z.infer<typeof getActorPostsSchema>) {
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
  if (input.cursor) {
    conditions.push(keysetCondition(objects.publishedAt, objects.id, decodeCursor(input.cursor), input.sort_order))
  }

  const rows = await db.select().from(objects)
    .where(and(...conditions))
    .orderBy(keysetOrderBy(objects.publishedAt, objects.id, input.sort_order))
    .limit(input.limit)

  const last = rows[rows.length - 1]
  const nextCursor = rows.length === input.limit && last
    ? encodeCursor(last.publishedAt, last.id)
    : null

  return {
    count: rows.length,
    next_cursor: nextCursor,
    sort_order: input.sort_order,
    filters: {
      actor_handle: input.actor_handle,
      since: input.since ?? null,
      until: input.until ?? null,
      object_types: input.object_types ?? null,
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
    })),
  }
}
