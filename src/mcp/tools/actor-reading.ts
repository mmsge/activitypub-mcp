import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects, bookwyrmObjects } from '../../db/schema.js'
import { and, eq, isNull, desc, or } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { fetchBookwyrmShelf, type ShelfItem } from '../../lib/fetch-bookwyrm-shelf.js'
import { classifyReadingEvent, readingEventBaseCondition } from '../../lib/bookwyrm-reading.js'

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
// bookwyrm_objects table. Note: ratings aren't carried in these Note payloads —
// use use_live=true for ratings and live cover art.
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
    })
    .from(objects)
    .where(and(eq(objects.actorApId, actorApId), isNull(objects.deletedAt), readingEventBaseCondition()))
    .orderBy(desc(objects.publishedAt))

  type Acc = {
    title: string | null
    author: string | null
    url: string | null
    shelf: 'reading' | 'read' | 'to-read' | null
    shelfAt: Date | null // published_at of the event that set `shelf`
    started: Date | null
    finished: Date | null
  }
  const byBook = new Map<string, Acc>()

  for (const r of rows) {
    const ev = classifyReadingEvent({
      apId: r.apId,
      content: r.contentText,
      tags: r.tags,
      attachments: r.attachments,
    })
    if (!ev || (!ev.book_title && !ev.bookwyrm_book_url)) continue // skip goal notes etc.

    const key = ev.bookwyrm_book_url ?? ev.book_title!.toLowerCase().trim()
    const acc = byBook.get(key) ?? {
      title: ev.book_title,
      author: ev.book_author,
      url: ev.bookwyrm_book_url,
      shelf: null,
      shelfAt: null,
      started: null,
      finished: null,
    }
    acc.title ??= ev.book_title
    acc.author ??= ev.book_author
    acc.url ??= ev.bookwyrm_book_url

    const at = r.publishedAt
    // The current shelf is whatever the most recent shelf-affecting event set it to.
    const shelfForEvent =
      ev.event_type === 'finished_reading' ? 'read'
        : ev.event_type === 'started_reading' ? 'reading'
          : ev.event_type === 'shelved' ? 'to-read'
            : null
    if (shelfForEvent && (!acc.shelfAt || (at && at > acc.shelfAt))) {
      acc.shelf = shelfForEvent
      acc.shelfAt = at ?? acc.shelfAt
    }
    if (ev.event_type === 'started_reading' && at && (!acc.started || at < acc.started)) acc.started = at
    if (ev.event_type === 'finished_reading' && at && (!acc.finished || at > acc.finished)) acc.finished = at

    byBook.set(key, acc)
  }

  let results: ReadingResult[] = [...byBook.values()].map((a) => ({
    title: a.title,
    authors: a.author,
    cover: null,
    shelf: a.shelf,
    started_date: a.started?.toISOString().slice(0, 10) ?? null,
    finished_date: a.finished?.toISOString().slice(0, 10) ?? null,
    rating: null,
    bookwyrm_book_url: a.url,
  }))
  if (statusFilter) results = results.filter((r) => r.shelf === statusFilter)
  return results.slice(0, limit)
}
