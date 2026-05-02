import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects, bookwyrmObjects } from '../../db/schema.js'
import { and, eq, isNull } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'

export const getActorReadingStatusSchema = z.object({
  actor_handle: z.string().describe('Actor handle (@user@domain) or full actor URL'),
  status: z.enum(['reading', 'read', 'to-read']).optional().describe('Filter by reading status'),
  limit: z.number().int().min(1).max(50).default(10),
})

export async function getActorReadingStatus(input: z.infer<typeof getActorReadingStatusSchema>) {
  const actor = input.actor_handle.startsWith('http')
    ? { apId: input.actor_handle }
    : await resolveActorByHandle(input.actor_handle)

  if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }

  const db = getDb()
  const conditions = [eq(objects.actorApId, actor.apId), isNull(objects.deletedAt)]
  if (input.status) conditions.push(eq(bookwyrmObjects.readingStatus, input.status))

  const rows = await db
    .select({
      apId: objects.apId,
      bwType: bookwyrmObjects.bwType,
      bookTitle: bookwyrmObjects.bookTitle,
      bookAuthor: bookwyrmObjects.bookAuthor,
      bookIsbn: bookwyrmObjects.bookIsbn,
      rating: bookwyrmObjects.rating,
      readingStatus: bookwyrmObjects.readingStatus,
      startDate: bookwyrmObjects.startDate,
      finishDate: bookwyrmObjects.finishDate,
      progress: bookwyrmObjects.progress,
      progressMode: bookwyrmObjects.progressMode,
      reviewContent: bookwyrmObjects.reviewContent,
      publishedAt: objects.publishedAt,
    })
    .from(bookwyrmObjects)
    .innerJoin(objects, eq(bookwyrmObjects.objectApId, objects.apId))
    .where(and(...conditions))
    .orderBy(objects.publishedAt)
    .limit(input.limit)

  return rows
}
