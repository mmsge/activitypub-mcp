import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { and, eq, isNull, desc } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { scopeCondition, type QueryScope } from './scope.js'

export const getActorMediaSchema = z.object({
  actor_handle: z.string().describe('Actor handle (@user@domain) or full actor URL'),
  media_type: z.enum(['image', 'video', 'any']).default('any'),
  limit: z.number().int().min(1).max(100).default(20),
  since: z.string().optional(),
})

export async function getActorMedia(
  input: z.infer<typeof getActorMediaSchema>,
  scope?: QueryScope,
) {
  const actor = input.actor_handle.startsWith('http')
    ? { apId: input.actor_handle }
    : await resolveActorByHandle(input.actor_handle)

  if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }

  const db = getDb()
  const visible = scopeCondition(scope)
  const rows = await db.select().from(objects)
    .where(and(
      eq(objects.actorApId, actor.apId),
      isNull(objects.deletedAt),
      // Public-only for REST callers — see ADR 0026.
      ...(visible ? [visible] : []),
    ))
    .orderBy(desc(objects.publishedAt))
    .limit(input.limit * 5) // over-fetch to filter

  const withMedia = rows.filter(r => {
    const att = r.attachments as Array<{ mediaType?: string }> | null
    if (!att?.length) return false
    if (input.media_type === 'any') return true
    return att.some(a =>
      input.media_type === 'image'
        ? a.mediaType?.startsWith('image/')
        : a.mediaType?.startsWith('video/')
    )
  }).slice(0, input.limit)

  return {
    count: withMedia.length,
    posts: withMedia.map(r => ({
      ap_id: r.apId,
      type: r.type,
      content: r.contentText,
      url: r.url,
      published_at: r.publishedAt,
      attachments: r.attachments,
    })),
  }
}
