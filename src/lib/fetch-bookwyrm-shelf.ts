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
  // BookWyrm shelf orderedItems are Edition objects directly (not ShelfBook wrappers).
  // title, isbn*, and id are top-level; authors is an array of AP URL strings.
  const bookTitle = (obj.title as string) ?? (obj.name as string) ?? null
  const bookIsbn = (obj.isbn13 as string) ?? (obj.isbn10 as string) ?? null
  // The Edition's AP id is its canonical book URL
  const bookUrl = (obj.id as string) ?? (obj.url as string) ?? null
  // authors is a list of URL strings — names require dereferencing; leave null here
  // and let the caller enrich from the local DB if needed
  const bookAuthor: string | null = null
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
