import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects, bookwyrmObjects } from '../../db/schema.js'
import { and, eq, isNull, desc, or, sql } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { fetchBookwyrmShelf, type ShelfItem } from '../../lib/fetch-bookwyrm-shelf.js'
import { classifyReadingEvent, collapseReadingEvents, readingEventBaseCondition } from '../../lib/bookwyrm-reading.js'

export const getActorReadingStatusSchema = z.object({
  actor_handle: z.string().describe('Actor handle (@user@domain) or full actor URL'),
  status: z.enum(['reading', 'read', 'to-read']).optional().describe('Filter by reading status'),
  limit: z.number().int().min(1).max(50).default(10),
  use_live: z.boolean().default(true).describe(
    'Fetch live shelf data directly from the BookWyrm instance (ground truth). ' +
    'When false, falls back to locally stored activity data only.'
  ),
})

type ReadingResult = {
  title: string | null
  authors: string | null
  cover: string | null
  shelf: 'reading' | 'read' | 'to-read' | null
  started_date: string | null
  finished_date: string | null
  rating: string | null
  bookwyrm_book_url: string | null
}

export async function getActorReadingStatus(input: z.infer<typeof getActorReadingStatusSchema>) {
  const actor = input.actor_handle.startsWith('http')
    ? { apId: input.actor_handle }
    : await resolveActorByHandle(input.actor_handle)

  if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }

  if (input.use_live) {
    return fetchLiveShelf(actor.apId, input.status, input.limit)
  }

  return fetchFromDb(actor.apId, input.status, input.limit)
}

async function fetchLiveShelf(
  actorApId: string,
  statusFilter: 'reading' | 'read' | 'to-read' | undefined,
  limit: number,
): Promise<ReadingResult[] | { error: string }> {
  const shelves: ('reading' | 'read' | 'to-read')[] = statusFilter
    ? [statusFilter]
    : ['reading', 'read', 'to-read']

  const allItems: (ShelfItem & { shelf: 'reading' | 'read' | 'to-read' })[] = []
  for (const shelf of shelves) {
    const items = await fetchBookwyrmShelf(actorApId, shelf)
    for (const item of items) allItems.push({ ...item, shelf })
  }

  if (allItems.length === 0) return []

  // Cross-reference DB for start/finish dates and ratings from stored ReadThrough/Rating activities
  const db = getDb()
  const dbRows = await db
    .select({
      bookTitle: bookwyrmObjects.bookTitle,
      bookAuthor: bookwyrmObjects.bookAuthor,
      startDate: bookwyrmObjects.startDate,
      finishDate: bookwyrmObjects.finishDate,
      rating: bookwyrmObjects.rating,
      bwType: bookwyrmObjects.bwType,
    })
    .from(bookwyrmObjects)
    .innerJoin(objects, eq(bookwyrmObjects.objectApId, objects.apId))
    .where(
      and(
        eq(objects.actorApId, actorApId),
        isNull(objects.deletedAt),
        or(eq(bookwyrmObjects.bwType, 'ReadThrough'), eq(bookwyrmObjects.bwType, 'Rating')),
      )
    )

  // Index DB rows by normalised title for quick lookup
  const dbByTitle = new Map<string, typeof dbRows[number]>()
  for (const row of dbRows) {
    if (row.bookTitle) {
      const key = row.bookTitle.toLowerCase().trim()
      const existing = dbByTitle.get(key)
      // Prefer ReadThrough over Rating; prefer rows with more data
      if (!existing || (row.bwType === 'ReadThrough' && existing.bwType !== 'ReadThrough')) {
        dbByTitle.set(key, row)
      }
    }
  }

  const results: ReadingResult[] = allItems.slice(0, limit).map((item) => {
    const key = item.bookTitle?.toLowerCase().trim() ?? ''
    const dbRow = dbByTitle.get(key)
    return {
      title: item.bookTitle,
      authors: item.bookAuthor ?? dbRow?.bookAuthor ?? null,
      cover: item.bookCover,
      shelf: item.shelf,
      started_date: dbRow?.startDate ?? null,
      finished_date: dbRow?.finishDate ?? null,
      rating: dbRow?.rating ?? null,
      bookwyrm_book_url: item.bookUrl,
    }
  })

  return results
}

// Offline shelf derivation. BookWyrm federates shelf changes as plain `Note`
// generatednote posts ("…wants to read X" / "…started reading X" / "…finished
// reading X"), so we derive each book's current shelf from those events in the
// generic post store (see lib/bookwyrm-reading.ts) rather than the rarely-populated
// bookwyrm_objects table. Every reading action is its own Note, so we collapse the
// event stream to one row per book (collapseReadingEvents). Ratings aren't carried
// in the Note payloads, but a review/rating that was ingested into bookwyrm_objects
// surfaces via the LEFT JOIN below; use use_live=true for live cover art.
async function fetchFromDb(
  actorApId: string,
  statusFilter: 'reading' | 'read' | 'to-read' | undefined,
  limit: number,
): Promise<ReadingResult[]> {
  const db = getDb()
  const rows = await db
    .select({
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
    .where(and(eq(objects.actorApId, actorApId), isNull(objects.deletedAt), readingEventBaseCondition()))
    .orderBy(desc(objects.publishedAt))

  const books = collapseReadingEvents(
    rows.flatMap((r) => {
      const event = classifyReadingEvent({
        apId: r.apId,
        content: r.contentText,
        tags: r.tags,
        attachments: r.attachments,
        readingStatus: r.readingStatus,
        inReplyToBook: r.inReplyToBook,
      })
      return event ? [{ event, publishedAt: r.publishedAt, rating: r.rating }] : []
    }),
  )

  let results: ReadingResult[] = books
    .sort((a, b) => (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0))
    .map((a) => ({
      title: a.title,
      authors: a.author,
      cover: a.cover,
      shelf: a.shelf,
      started_date: a.started?.toISOString().slice(0, 10) ?? null,
      finished_date: a.finished?.toISOString().slice(0, 10) ?? null,
      rating: a.rating,
      bookwyrm_book_url: a.url,
    }))
  if (statusFilter) results = results.filter((r) => r.shelf === statusFilter)
  return results.slice(0, limit)
}
