import { logger } from './logger.js'
import { BOOKWYRM_AP_HEADERS, resolveBookwyrmAuthorName } from './bookwyrm-fetch.js'

type AnyObject = Record<string, unknown>

/**
 * BookWyrm's reading shelves — all four of them.
 *
 * `stopped-reading` was missing here for a long time, and its absence was the
 * whole reason a book Markus put down was indistinguishable from one he finished:
 * nothing ever asked BookWyrm for that shelf. The four are mutually exclusive (a
 * book sits on exactly one), verified against @mvrkws@bookwyrm.social on
 * 2026-08-16 — union 451, pairwise overlap 0.
 *
 * Exported so the enums that used to spell this list out by hand can import it.
 * Callers that concatenate shelves and then truncate care about the ORDER here;
 * see LIVE_SHELF_ORDER in mcp/tools/actor-reading.ts.
 */
export const SHELVES = ['reading', 'read', 'to-read', 'stopped-reading'] as const
export type Shelf = (typeof SHELVES)[number]

const MAX_PAGES = 100 // safety bound on a shelf walk; `read` is ~28 pages at 15/page
const PAGE_DELAY_MS = 200

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ShelfItem {
  bookTitle: string | null
  bookAuthor: string | null
  bookCover: string | null
  bookIsbn: string | null
  bookUrl: string | null
  shelvedDate: string | null
  raw: AnyObject
}

const AP_HEADERS = BOOKWYRM_AP_HEADERS

function extractShelfItem(obj: AnyObject): ShelfItem {
  // BookWyrm shelf orderedItems are Edition objects directly (not ShelfBook wrappers).
  // title, isbn*, and id are top-level; authors is an array of AP URL strings.
  const bookTitle = (obj.title as string) ?? (obj.name as string) ?? null
  const bookIsbn = (obj.isbn13 as string) ?? (obj.isbn10 as string) ?? null
  // The Edition's AP id is its canonical book URL
  const bookUrl = (obj.id as string) ?? (obj.url as string) ?? null
  const cover = obj.cover as AnyObject | undefined
  const bookCover = (typeof cover?.url === 'string' ? cover.url : null) ?? null
  // The cover's `name` is "Author: Title (format, year, publisher)" — cheapest
  // author source (no extra fetch). The caller dereferences authors[] as fallback.
  let bookAuthor: string | null = null
  const coverName = typeof cover?.name === 'string' ? cover.name : null
  if (coverName) {
    const idx = coverName.indexOf(': ')
    if (idx > 0) bookAuthor = coverName.slice(0, idx).trim()
  }
  const shelvedDate = (obj.shelvedDate as string) ?? null

  return { bookTitle, bookAuthor, bookCover, bookIsbn, bookUrl, shelvedDate, raw: obj }
}

export interface ShelfFetch {
  items: ShelfItem[]
  /** The Shelf collection's own `totalItems`, or null when the root didn't say. */
  totalItems: number | null
  /**
   * False if ANY page failed, returned non-OK, or the page cap was hit.
   *
   * This flag is the whole point of the detailed variant. Before it existed a
   * half-fetched shelf came back as a short list and was indistinguishable from a
   * shelf that had genuinely shrunk — which is fine for gap-filling a title, and
   * catastrophic for anything that reconciles membership against what it saw. Any
   * caller that removes rows must gate on this AND on the count matching
   * `totalItems`.
   */
  complete: boolean
  pages: number
}

/**
 * Walk one shelf, reporting how the walk went.
 *
 * Paginated: BookWyrm serves 15 items a page, so `read` is roughly 28 requests.
 * Capped and delayed like the outbox walk in jobs/sync-reading-history.ts, and
 * iterative rather than recursive so a long shelf isn't a deep stack.
 */
export async function fetchBookwyrmShelfDetailed(
  actorApId: string,
  shelf: Shelf,
): Promise<ShelfFetch> {
  const shelfUrl = `${actorApId.replace(/\/$/, '')}/shelf/${shelf}`
  const items: ShelfItem[] = []
  let totalItems: number | null = null
  let complete = true
  let pages = 0

  let nextUrl: string | undefined = shelfUrl
  while (nextUrl) {
    if (pages >= MAX_PAGES) {
      logger.warn({ actorApId, shelf, pages }, 'BookWyrm shelf hit the page cap')
      complete = false
      break
    }
    if (pages > 0) await sleep(PAGE_DELAY_MS)

    const url: string = nextUrl
    let res: Response
    try {
      res = await fetch(url, { headers: AP_HEADERS })
    } catch (e) {
      logger.warn({ url, error: e }, 'Failed to fetch BookWyrm shelf page')
      complete = false
      break
    }
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'BookWyrm shelf returned non-OK status')
      complete = false
      break
    }

    const data = (await res.json()) as AnyObject
    pages++

    // Only the root collection carries the count; pages don't repeat it.
    if (totalItems == null && typeof data.totalItems === 'number') totalItems = data.totalItems

    const orderedItems = data.orderedItems as unknown[] | undefined
    const inlineItems = data.items as unknown[] | undefined
    const rawItems = orderedItems ?? inlineItems

    if (Array.isArray(rawItems)) {
      for (const item of rawItems) {
        items.push(extractShelfItem(item as AnyObject))
      }
    }

    // Follow `first` when the root collection has no inline items, `next` otherwise.
    nextUrl = undefined
    if (!rawItems) {
      const first = data.first
      if (typeof first === 'string') nextUrl = first
      else if (first && typeof (first as AnyObject).id === 'string')
        nextUrl = (first as AnyObject).id as string
    } else {
      const next = data.next
      if (typeof next === 'string') nextUrl = next
    }
  }

  // For any item whose author we couldn't read off the cover name, dereference
  // the first author URL (cached). Concurrent, so the whole shelf resolves once.
  await Promise.all(
    items.map(async (item) => {
      if (item.bookAuthor) return
      const authors = item.raw.authors
      const first = Array.isArray(authors) ? authors[0] : undefined
      if (typeof first === 'string') item.bookAuthor = await resolveBookwyrmAuthorName(first)
    }),
  )

  logger.info(
    { actorApId, shelf, count: items.length, totalItems, pages, complete },
    'BookWyrm shelf fetch complete',
  )
  return { items, totalItems, complete, pages }
}

/**
 * The lossy convenience wrapper: just the items, however the walk went.
 *
 * Fine for gap-filling (a missing title, a cover) where a short list costs
 * nothing. NOT fine for reconciling membership — use fetchBookwyrmShelfDetailed
 * and check `complete`.
 */
export async function fetchBookwyrmShelf(actorApId: string, shelf: Shelf): Promise<ShelfItem[]> {
  const { items } = await fetchBookwyrmShelfDetailed(actorApId, shelf)
  return items
}
