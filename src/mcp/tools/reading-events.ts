import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects, bookwyrmObjects } from '../../db/schema.js'
import { and, eq, isNull, gte, sql, type SQL } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import {
  classifyReadingEvent,
  readingEventBaseCondition,
  readingEventTypeCondition,
} from '../../lib/bookwyrm-reading.js'
import { encodeCursor, decodeCursor, keysetCondition, keysetOrderBy } from './pagination.js'

const eventTypeEnum = z.enum([
  'started_reading',
  'finished_reading',
  'review',
  'rating',
  'comment',
  'note',
  'shelved',
])

export const getReadingEventsSchema = z.object({
  actor_handle: z.string().describe('Actor handle (@user@domain) or full actor URL'),
  event_type: eventTypeEnum.optional().describe('Filter by event type'),
  limit: z.number().int().min(1).max(100).default(20),
  since: z.string().datetime().optional().describe('ISO 8601 datetime — only return events after this time'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Order by published_at. "desc" (default) is newest-first; "asc" is oldest-first — pair with limit:1 to fetch the earliest reading event in one call.'),
  cursor: z.string().optional()
    .describe('Opaque pagination cursor from a previous response\'s next_cursor. When set, continues from where the last page ended (respecting sort_order and all filters).'),
})

export async function getReadingEvents(input: z.infer<typeof getReadingEventsSchema>) {
  const actor = input.actor_handle.startsWith('http')
    ? { apId: input.actor_handle }
    : await resolveActorByHandle(input.actor_handle)

  if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }

  const db = getDb()
  // Derive reading events on the fly from the generic post store, classifying by
  // ap_id segment + content (see lib/bookwyrm-reading.ts). The base condition keeps
  // unrelated Notes out; event_type is filtered in SQL so `limit` and the keyset
  // cursor stay exact.
  const conditions: SQL[] = [
    eq(objects.actorApId, actor.apId),
    isNull(objects.deletedAt),
    readingEventBaseCondition(),
  ]
  if (input.since) conditions.push(gte(objects.publishedAt, new Date(input.since)))
  if (input.event_type) {
    const etCond = readingEventTypeCondition(input.event_type)
    if (etCond) conditions.push(etCond)
  }
  if (input.cursor) {
    conditions.push(keysetCondition(objects.publishedAt, objects.id, decodeCursor(input.cursor), input.sort_order))
  }

  const rows = await db
    .select({
      id: objects.id,
      apId: objects.apId,
      contentText: objects.contentText,
      tags: objects.tags,
      attachments: objects.attachments,
      publishedAt: objects.publishedAt,
      rating: bookwyrmObjects.rating,
      readingStatus: sql<string | null>`${objects.raw}->>'readingStatus'`,
      inReplyToBook: sql<string | null>`${objects.raw}->>'inReplyToBook'`,
    })
    .from(objects)
    .leftJoin(bookwyrmObjects, eq(bookwyrmObjects.objectApId, objects.apId))
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
      event_type: input.event_type ?? null,
      since: input.since ?? null,
    },
    events: rows.map((r) => {
      // Non-null: the base condition only selects classifiable reading events.
      const ev = classifyReadingEvent({
        apId: r.apId,
        content: r.contentText,
        tags: r.tags,
        attachments: r.attachments,
        readingStatus: r.readingStatus,
        inReplyToBook: r.inReplyToBook,
      })!
      const date = r.publishedAt?.toISOString().slice(0, 10) ?? null
      return {
        event_type: ev.event_type,
        // BookWyrm's shelf state at post time: a "read" comment/review marks a
        // finish on this date even without a standalone finished_reading note.
        reading_status: ev.reading_status,
        book_title: ev.book_title,
        book_author: ev.book_author,
        started_date: ev.event_type === 'started_reading' ? date : null,
        finished_date: ev.event_type === 'finished_reading' ? date : null,
        // Standalone `rating` events depend on BookWyrm federating `/rating/`
        // activities (classified via SEG_RATING). The numeric value isn't in the
        // Note payload, but a review/rating ingested into bookwyrm_objects surfaces
        // its inline rating here via the LEFT JOIN rather than being lost.
        rating: r.rating,
        comment: ev.comment,
        published_at: r.publishedAt?.toISOString() ?? null,
        ap_id: r.apId,
        bookwyrm_book_url: ev.bookwyrm_book_url,
      }
    }),
  }
}
