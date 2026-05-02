import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects, bookwyrmObjects } from '../../db/schema.js'
import { and, eq, isNull, desc, or } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { fetchBookwyrmShelf, type ShelfItem } from '../../lib/fetch-bookwyrm-shelf.js'

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
      shelf: item.shelf,
      started_date: dbRow?.startDate ?? null,
      finished_date: dbRow?.finishDate ?? null,
      rating: dbRow?.rating ?? null,
      bookwyrm_book_url: item.bookUrl,
    }
  })

  return results
}

async function fetchFromDb(
  actorApId: string,
  statusFilter: 'reading' | 'read' | 'to-read' | undefined,
  limit: number,
): Promise<ReadingResult[]> {
  const db = getDb()
  const conditions = [eq(objects.actorApId, actorApId), isNull(objects.deletedAt)]
  if (statusFilter) conditions.push(eq(bookwyrmObjects.readingStatus, statusFilter))

  const rows = await db
    .select({
      bookTitle: bookwyrmObjects.bookTitle,
      bookAuthor: bookwyrmObjects.bookAuthor,
      readingStatus: bookwyrmObjects.readingStatus,
      startDate: bookwyrmObjects.startDate,
      finishDate: bookwyrmObjects.finishDate,
      rating: bookwyrmObjects.rating,
      bookUrl: bookwyrmObjects.bookUrl,
    })
    .from(bookwyrmObjects)
    .innerJoin(objects, eq(bookwyrmObjects.objectApId, objects.apId))
    .where(and(...conditions))
    .orderBy(desc(objects.publishedAt))
    .limit(limit)

  return rows.map((r) => ({
    title: r.bookTitle,
    authors: r.bookAuthor,
    shelf: r.readingStatus as 'reading' | 'read' | 'to-read' | null,
    started_date: r.startDate,
    finished_date: r.finishDate,
    rating: r.rating,
    bookwyrm_book_url: r.bookUrl,
  }))
}
