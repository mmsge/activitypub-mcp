import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects, bookwyrmObjects } from '../../db/schema.js'
import { and, eq, isNull, desc, gte } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'

export const getReadingEventsSchema = z.object({
  actor_handle: z.string().describe('Actor handle (@user@domain) or full actor URL'),
  event_type: z.enum([
    'started_reading',
    'finished_reading',
    'review',
    'rating',
    'comment',
    'note',
    'shelved',
  ]).optional().describe('Filter by event type'),
  limit: z.number().int().min(1).max(100).default(20),
  since: z.string().datetime().optional().describe('ISO 8601 datetime — only return events after this time'),
})

function deriveEventType(bwType: string, finishDate: string | null): string {
  switch (bwType) {
    case 'ReadThrough': return finishDate ? 'finished_reading' : 'started_reading'
    case 'Review': return 'review'
    case 'Rating': return 'rating'
    case 'Comment': return 'comment'
    case 'GeneratedNote': return 'note'
    case 'ShelfBook': return 'shelved'
    default: return bwType.toLowerCase()
  }
}

export async function getReadingEvents(input: z.infer<typeof getReadingEventsSchema>) {
  const actor = input.actor_handle.startsWith('http')
    ? { apId: input.actor_handle }
    : await resolveActorByHandle(input.actor_handle)

  if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }

  const db = getDb()
  const conditions = [eq(objects.actorApId, actor.apId), isNull(objects.deletedAt)]
  if (input.since) conditions.push(gte(objects.publishedAt, new Date(input.since)))

  // When filtering by started_reading/finished_reading we need to filter on bwType=ReadThrough
  // and finishDate presence — fetch all ReadThrough rows and filter after
  const eventTypeFilter = input.event_type

  let rows = await db
    .select({
      apId: objects.apId,
      bwType: bookwyrmObjects.bwType,
      bookTitle: bookwyrmObjects.bookTitle,
      bookAuthor: bookwyrmObjects.bookAuthor,
      startDate: bookwyrmObjects.startDate,
      finishDate: bookwyrmObjects.finishDate,
      rating: bookwyrmObjects.rating,
      reviewContent: bookwyrmObjects.reviewContent,
      bookUrl: bookwyrmObjects.bookUrl,
      publishedAt: objects.publishedAt,
    })
    .from(bookwyrmObjects)
    .innerJoin(objects, eq(bookwyrmObjects.objectApId, objects.apId))
    .where(and(...conditions))
    .orderBy(desc(objects.publishedAt))
    .limit(eventTypeFilter ? input.limit * 4 : input.limit) // over-fetch when filtering

  if (eventTypeFilter) {
    rows = rows.filter((r) => {
      const et = deriveEventType(r.bwType, r.finishDate)
      return et === eventTypeFilter
    }).slice(0, input.limit)
  }

  return rows.map((r) => ({
    event_type: deriveEventType(r.bwType, r.finishDate),
    book_title: r.bookTitle,
    book_author: r.bookAuthor,
    started_date: r.startDate,
    finished_date: r.finishDate,
    rating: r.rating,
    comment: r.reviewContent,
    published_at: r.publishedAt?.toISOString() ?? null,
    ap_id: r.apId,
    bookwyrm_book_url: r.bookUrl,
  }))
}
