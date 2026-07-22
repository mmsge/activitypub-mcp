import { logger } from './logger.js'
import { BOOKWYRM_AP_HEADERS } from './bookwyrm-fetch.js'

type AnyObject = Record<string, unknown>

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

// Author AP objects are immutable for our purposes; cache resolved names for the
// process lifetime so a shelf with many books by the same author costs one fetch.
const authorNameCache = new Map<string, string | null>()

async function resolveAuthorName(url: string): Promise<string | null> {
  const cached = authorNameCache.get(url)
  if (cached !== undefined) return cached
  let name: string | null = null
  try {
    const res = await fetch(url, { headers: AP_HEADERS })
    if (res.ok) {
      const data = (await res.json()) as AnyObject
      name = typeof data.name === 'string' ? data.name : null
    }
  } catch (e) {
    logger.warn({ url, error: e }, 'Failed to resolve BookWyrm author')
  }
  authorNameCache.set(url, name)
  return name
}

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

export async function fetchBookwyrmShelf(
  actorApId: string,
  shelf: 'reading' | 'read' | 'to-read',
): Promise<ShelfItem[]> {
  const shelfUrl = `${actorApId.replace(/\/$/, '')}/shelf/${shelf}`
  const items: ShelfItem[] = []

  async function fetchPage(url: string): Promise<void> {
    let res: Response
    try {
      res = await fetch(url, { headers: AP_HEADERS })
    } catch (e) {
      logger.warn({ url, error: e }, 'Failed to fetch BookWyrm shelf page')
      return
    }
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'BookWyrm shelf returned non-OK status')
      return
    }

    const data = (await res.json()) as AnyObject

    const orderedItems = data.orderedItems as unknown[] | undefined
    const inlineItems = data.items as unknown[] | undefined
    const rawItems = orderedItems ?? inlineItems

    if (Array.isArray(rawItems)) {
      for (const item of rawItems) {
        items.push(extractShelfItem(item as AnyObject))
      }
    }

    // Follow first page if root collection has no inline items
    let nextUrl: string | undefined
    if (!rawItems) {
      const first = data.first
      if (typeof first === 'string') nextUrl = first
      else if (first && typeof (first as AnyObject).id === 'string')
        nextUrl = (first as AnyObject).id as string
    } else {
      const next = data.next
      if (typeof next === 'string') nextUrl = next
    }

    if (nextUrl) await fetchPage(nextUrl)
  }

  await fetchPage(shelfUrl)

  // For any item whose author we couldn't read off the cover name, dereference
  // the first author URL (cached). Concurrent, so the whole shelf resolves once.
  await Promise.all(
    items.map(async (item) => {
      if (item.bookAuthor) return
      const authors = item.raw.authors
      const first = Array.isArray(authors) ? authors[0] : undefined
      if (typeof first === 'string') item.bookAuthor = await resolveAuthorName(first)
    }),
  )

  logger.info({ actorApId, shelf, count: items.length }, 'BookWyrm shelf fetch complete')
  return items
}
