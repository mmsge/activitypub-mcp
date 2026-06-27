import { config } from '../config.js'
import { logger } from './logger.js'

type AnyObject = Record<string, unknown>

// Resolved metadata for one BookWyrm Edition, shaped to the book_metadata columns.
export interface EditionMetadata {
  bookUrl: string
  workUrl: string | null
  title: string | null
  pages: number | null
  physicalFormat: string | null
  isbn13: string | null
  pubYear: number | null
  language: string | null
  pageSource: 'bookwyrm' | 'openlibrary' | 'googlebooks' | 'override' | null
}

const AP_HEADERS = {
  Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
}

// Formats that legitimately have no page count, so we don't waste ISBN-fallback
// calls (and later, prose-average exclusions) on them.
export const PAGELESS_FORMATS = new Set(['AudiobookFormat', 'Audiobook', 'CD', 'eBook'])

// A leading 4-digit year from a (possibly partial) BookWyrm date string.
function yearOf(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v !== 'string') continue
    const m = /^(\d{4})/.exec(v.trim())
    if (m) return Number(m[1])
  }
  return null
}

function posInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/**
 * Map a raw BookWyrm Edition AP object onto our metadata shape. Pure (no I/O) so
 * the field mapping is unit-testable. `pageSource` is 'bookwyrm' when the Edition
 * itself carried a page count, else null (the caller may then run an ISBN fallback).
 */
export function mapEdition(obj: AnyObject): EditionMetadata {
  const bookUrl = ((obj.id as string) ?? (obj.url as string)) ?? ''
  const pages = posInt(obj.pages)
  const physicalFormat = (typeof obj.physicalFormat === 'string' && obj.physicalFormat) || null
  const isbn13 = (typeof obj.isbn13 === 'string' && obj.isbn13) || null
  const languages = Array.isArray(obj.languages) ? obj.languages : []
  const language = typeof languages[0] === 'string' ? (languages[0] as string) : null
  return {
    bookUrl,
    workUrl: (typeof obj.work === 'string' && obj.work) || null,
    title: ((obj.title as string) ?? (obj.name as string)) || null,
    pages,
    physicalFormat,
    isbn13,
    pubYear: yearOf(obj.publishedDate, obj.firstPublishedDate),
    language,
    pageSource: pages != null ? 'bookwyrm' : null,
  }
}

// --- ISBN page-count fallbacks (used only when the Edition lacks `pages`) -----

async function pagesFromOpenLibrary(isbn13: string): Promise<number | null> {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn13}&jscmd=data&format=json`
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const data = (await res.json()) as AnyObject
    const entry = data[`ISBN:${isbn13}`] as AnyObject | undefined
    return posInt(entry?.number_of_pages)
  } catch (e) {
    logger.warn({ isbn13, error: e }, 'OpenLibrary page lookup failed')
    return null
  }
}

async function pagesFromGoogleBooks(isbn13: string): Promise<number | null> {
  const url = new URL('https://www.googleapis.com/books/v1/volumes')
  url.searchParams.set('q', `isbn:${isbn13}`)
  if (config.GOOGLE_BOOKS_API_KEY) url.searchParams.set('key', config.GOOGLE_BOOKS_API_KEY)
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const data = (await res.json()) as AnyObject
    const items = Array.isArray(data.items) ? data.items : []
    const info = (items[0] as AnyObject | undefined)?.volumeInfo as AnyObject | undefined
    return posInt(info?.pageCount)
  } catch (e) {
    logger.warn({ isbn13, error: e }, 'Google Books page lookup failed')
    return null
  }
}

/**
 * Fetch one Edition's metadata: BookWyrm Edition AP object first, then — only if it
 * has no page count and isn't an inherently page-less format — OpenLibrary and then
 * Google Books by ISBN-13. Returns null if the Edition itself can't be fetched.
 */
export async function fetchEditionMetadata(bookUrl: string): Promise<EditionMetadata | null> {
  let res: Response
  try {
    res = await fetch(bookUrl, { headers: AP_HEADERS })
  } catch (e) {
    logger.warn({ bookUrl, error: e }, 'Failed to fetch BookWyrm Edition')
    return null
  }
  if (!res.ok) {
    logger.warn({ bookUrl, status: res.status }, 'BookWyrm Edition returned non-OK status')
    return null
  }
  const obj = (await res.json()) as AnyObject
  const meta = mapEdition(obj)
  meta.bookUrl ||= bookUrl

  if (meta.pages == null && meta.isbn13 && !PAGELESS_FORMATS.has(meta.physicalFormat ?? '')) {
    const ol = await pagesFromOpenLibrary(meta.isbn13)
    if (ol != null) {
      meta.pages = ol
      meta.pageSource = 'openlibrary'
    } else {
      const gb = await pagesFromGoogleBooks(meta.isbn13)
      if (gb != null) {
        meta.pages = gb
        meta.pageSource = 'googlebooks'
      }
    }
  }

  return meta
}
