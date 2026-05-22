import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { and, eq, gt, lt, isNull, desc } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'

export const getActorPostsSchema = z.object({
  actor_handle: z.string().describe(
    'Actor handle (@user@domain), full ActivityPub actor URL, LinkedIn member URN (urn:li:person:…), or linkedin.com/in/<name> URL',
  ),
  limit: z.number().int().min(1).max(100).default(20),
  since: z.string().optional().describe('ISO 8601 datetime — only posts after this time'),
  until: z.string().optional().describe('ISO 8601 datetime — only posts before this time'),
  object_types: z.array(z.string()).optional().describe('Filter by object type, e.g. ["Note", "LinkedInPost"]'),
  source: z.enum(['activitypub', 'linkedin', 'all']).default('all').describe(
    'Limit to a specific source platform, or "all" for everything',
  ),
})

export async function getActorPosts(input: z.infer<typeof getActorPostsSchema>) {
  const actor = input.actor_handle.startsWith('http') && !input.actor_handle.includes('linkedin.com')
    ? { apId: input.actor_handle }
    : await resolveActorByHandle(input.actor_handle)

  if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }

  const db = getDb()
  const conditions = [
    eq(objects.actorApId, actor.apId),
    isNull(objects.deletedAt),
  ]
  if (input.source !== 'all') conditions.push(eq(objects.source, input.source))
  if (input.since) conditions.push(gt(objects.publishedAt, new Date(input.since)))
  if (input.until) conditions.push(lt(objects.publishedAt, new Date(input.until)))

  let rows = await db.select().from(objects)
    .where(and(...conditions))
    .orderBy(desc(objects.publishedAt))
    .limit(input.limit)

  if (input.object_types?.length) {
    rows = rows.filter(r => input.object_types!.includes(r.type))
  }

  return rows.map(r => ({
    ap_id: r.apId,
    source: r.source,
    type: r.type,
    content: r.contentText,
    summary: r.summary,
    url: r.url,
    in_reply_to: r.inReplyTo,
    published_at: r.publishedAt,
    attachments: r.attachments,
    tags: r.tags,
  }))
}
