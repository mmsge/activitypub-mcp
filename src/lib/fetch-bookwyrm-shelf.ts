import { logger } from './logger.js'

type AnyObject = Record<string, unknown>

export interface ShelfItem {
  bookTitle: string | null
  bookAuthor: string | null
  bookIsbn: string | null
  bookUrl: string | null
  shelvedDate: string | null
  raw: AnyObject
}

const AP_HEADERS = {
  Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
}

function extractShelfItem(obj: AnyObject): ShelfItem {
  const book = (obj.book as AnyObject) ?? null
  const bookTitle = (book?.title as string) ?? (book?.name as string) ?? null
  const authors = book?.authors as AnyObject[] | string[] | null
  let bookAuthor: string | null = null
  if (Array.isArray(authors) && authors.length > 0) {
    const a = authors[0]
    bookAuthor = typeof a === 'string' ? a : (a as AnyObject).name as string ?? null
  }
  const bookIsbn = (book?.isbn13 as string) ?? (book?.isbn10 as string) ?? null
  const bookUrl = (book?.url as string) ?? null
  const shelvedDate = (obj.shelvedDate as string) ?? null

  return { bookTitle, bookAuthor, bookIsbn, bookUrl, shelvedDate, raw: obj }
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
  logger.info({ actorApId, shelf, count: items.length }, 'BookWyrm shelf fetch complete')
  return items
}
