import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { bookMetadata } from '../../db/schema.js'
import { inArray } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { fetchBookwyrmShelf, type ShelfItem } from '../../lib/fetch-bookwyrm-shelf.js'
import { normalizeTitle, indexCollapsedBooks, type CollapsedBook } from '../../lib/bookwyrm-reading.js'
import { loadCollapsedBooks } from '../../lib/reading-query.js'

export const getActorReadingStatusSchema = z.object({
  actor_handle: z.string().describe('Actor handle (@user@domain) or full actor URL'),
  status: z.enum(['reading', 'read', 'to-read']).optional().describe('Filter by reading status'),
  limit: z.number().int().min(1).max(50).default(10),
  use_live: z.boolean().default(true).describe(
    'Fetch live shelf data directly from the BookWyrm instance (ground truth). ' +
    'When false, falls back to locally stored activity data only.'
  ),
})

type Shelf = 'reading' | 'read' | 'to-read'

type ReadingResult = {
  title: string | null
  authors: string | null
  cover: string | null
  shelf: Shelf | null
  started_date: string | null
  finished_date: string | null
  rating: string | null
  bookwyrm_book_url: string | null
  pages: number | null
  language: string | null
  shelved_date: string | null
}

const isoDate = (d: Date | null): string | null => d?.toISOString().slice(0, 10) ?? null

// Fill pages/language (and, offline, the cover) from the enriched book_metadata
// cache, joined by Edition URL. Mutates the results in place.
async function enrichWithMetadata(results: ReadingResult[]): Promise<void> {
  const urls = [...new Set(results.map((r) => r.bookwyrm_book_url).filter((u): u is string => !!u))]
  if (urls.length === 0) return
  const db = getDb()
  const rows = await db
    .select({
      bookUrl: bookMetadata.bookUrl,
      title: bookMetadata.title,
      author: bookMetadata.author,
      pages: bookMetadata.pages,
      language: bookMetadata.language,
      coverUrl: bookMetadata.coverUrl,
    })
    .from(bookMetadata)
    .where(inArray(bookMetadata.bookUrl, urls))
  const byUrl = new Map(rows.map((m) => [m.bookUrl, m]))
  for (const r of results) {
    const m = r.bookwyrm_book_url ? byUrl.get(r.bookwyrm_book_url) : undefined
    if (!m) continue
    r.pages = m.pages ?? r.pages
    r.language = m.language ?? r.language
    r.cover = r.cover ?? m.coverUrl ?? null
    // Gap-fill only — live shelf / derived values stay authoritative here.
    r.title ??= m.title
    r.authors ??= m.author
  }
}

export async function getActorReadingStatus(input: z.infer<typeof getActorReadingStatusSchema>) {
  const actor = input.actor_handle.startsWith('http')
    ? { apId: input.actor_handle }
    : await resolveActorByHandle(input.actor_handle)

  if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }

  const results = input.use_live
    ? await fetchLiveShelf(actor.apId, input.status, input.limit)
    : await fetchFromDb(actor.apId, input.status, input.limit)

  if (Array.isArray(results)) await enrichWithMetadata(results)
  return results
}

/**
 * Merge live shelf rows (ground truth for shelf membership + cover art) with the
 * locally derived per-book reading state (dates, rating — BookWyrm's shelf
 * collections are bare Edition objects and carry neither). Matched by Edition
 * URL first, normalized title as fallback. Pure, exported for tests.
 */
export function mergeShelfWithDerived(
  items: (ShelfItem & { shelf: Shelf })[],
  collapsed: CollapsedBook[],
): ReadingResult[] {
  const index = indexCollapsedBooks(collapsed)
  return items.map((item) => {
    const byUrl = item.bookUrl ? index.get(item.bookUrl) : undefined
    const titleKey = normalizeTitle(item.bookTitle)
    const derived = byUrl ?? (titleKey ? index.get(titleKey) : undefined)
    return {
      title: item.bookTitle,
      authors: item.bookAuthor ?? derived?.author ?? null,
      cover: item.bookCover,
      shelf: item.shelf,
      started_date: isoDate(derived?.started ?? null),
      finished_date: isoDate(derived?.finished ?? null),
      rating: derived?.rating ?? null,
      bookwyrm_book_url: item.bookUrl,
      pages: null,
      language: null,
      shelved_date: item.shelvedDate?.slice(0, 10) ?? null,
    }
  })
}

async function fetchLiveShelf(
  actorApId: string,
  statusFilter: Shelf | undefined,
  limit: number,
): Promise<ReadingResult[] | { error: string }> {
  const shelves: Shelf[] = statusFilter ? [statusFilter] : ['reading', 'read', 'to-read']

  const allItems: (ShelfItem & { shelf: Shelf })[] = []
  for (const shelf of shelves) {
    const items = await fetchBookwyrmShelf(actorApId, shelf)
    for (const item of items) allItems.push({ ...item, shelf })
  }

  if (allItems.length === 0) return []

  // BookWyrm shelf collections are bare Edition objects — no readthrough dates,
  // no ratings. Derive those from the actor's stored reading posts (the same
  // collapse the offline path uses) and merge per book.
  const collapsed = await loadCollapsedBooks(actorApId)
  return mergeShelfWithDerived(allItems.slice(0, limit), collapsed)
}

// Offline shelf derivation. BookWyrm federates shelf changes as plain `Note`
// generatednote posts ("…wants to read X" / "…started reading X" / "…finished
// reading X"), so we derive each book's current shelf from those events in the
// generic post store (see lib/bookwyrm-reading.ts), collapsed to one row per
// book with derived start/finish dates and any inline review rating. Use
// use_live=true for live cover art and authoritative shelf membership.
async function fetchFromDb(
  actorApId: string,
  statusFilter: Shelf | undefined,
  limit: number,
): Promise<ReadingResult[]> {
  const books = await loadCollapsedBooks(actorApId)

  let results: ReadingResult[] = books
    .sort((a, b) => (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0))
    .map((a) => ({
      title: a.title,
      authors: a.author,
      cover: a.cover,
      shelf: a.shelf,
      started_date: isoDate(a.started),
      finished_date: isoDate(a.finished),
      rating: a.rating,
      bookwyrm_book_url: a.url,
      pages: null,
      language: null,
      shelved_date: null,
    }))
  if (statusFilter) results = results.filter((r) => r.shelf === statusFilter)
  return results.slice(0, limit)
}
