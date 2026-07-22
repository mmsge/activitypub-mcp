import { config } from '../config.js'
import { logger } from './logger.js'
import { stripHtml } from './strip-html.js'
import { BOOKWYRM_AP_HEADERS, resolveBookwyrmAuthorName } from './bookwyrm-fetch.js'
import { normalizeSubjects } from './subjects.js'
import {
  resolveBestIsbn, normalizeLanguage, isbn13to10, type IsbnSource,
} from './isbn.js'
import type { ReviewMeta } from './fetch-garden.js'

type AnyObject = Record<string, unknown>

// Where a given field's value ultimately came from. Doubles as `pageSource`.
export type FieldSource = 'bookwyrm' | 'review' | 'openlibrary' | 'googlebooks' | 'override'

// Metadata extracted from a BookWyrm Edition AP object (the authoritative source).
// Pure mapping output; language is left raw here and normalized during merge.
export interface EditionMetadata {
  bookUrl: string
  workUrl: string | null
  title: string | null
  subtitle: string | null
  // BookWyrm federates Edition authors as AP URLs; names only appear inline on
  // non-standard payloads. `authorUrls` is resolved to names by the (impure)
  // fetcher and appended to `authorNames` before the merge.
  authorUrls: string[]
  authorNames: string[]
  pages: number | null
  physicalFormat: string | null
  isbn13: string | null
  isbn10: string | null
  pubYear: number | null
  language: string | null
  publisher: string | null
  series: string | null
  coverUrl: string | null
  description: string | null
  subjects: string[] | null
  pageSource: FieldSource | null
}

// The fully merged, column-shaped record persisted to book_metadata.
export interface BookMetadata {
  bookUrl: string
  workUrl: string | null
  title: string | null
  subtitle: string | null
  author: string | null // all authors, joined with ", "
  pages: number | null
  physicalFormat: string | null
  isbn13: string | null
  isbn10: string | null
  pubYear: number | null
  language: string | null
  originalLanguage: string | null
  publisher: string | null
  series: string | null
  coverUrl: string | null
  description: string | null
  subjects: string[] | null
  pageSource: FieldSource | null
  isbnSource: IsbnSource | null
  sourceMap: Record<string, FieldSource>
}

// Partial metadata from an external ISBN service (OpenLibrary / Google Books),
// already normalized into our field shapes so the merge can treat them uniformly.
export interface ExternalBookData {
  pages: number | null
  coverUrl: string | null
  description: string | null
  publisher: string | null
  publishedDate: string | null
  language: string | null
  subjects: string[] | null
  authors: string[] | null
  isbn10: string | null
  isbn13: string | null
}

const AP_HEADERS = BOOKWYRM_AP_HEADERS

// Formats that legitimately have no page count, so we don't waste ISBN-fallback
// calls (and later, prose-average exclusions) on them.
export const PAGELESS_FORMATS = new Set(['AudiobookFormat', 'Audiobook', 'CD', 'eBook'])

// A leading 4-digit year from a (possibly partial) date string.
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

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out = v.map((x) => (typeof x === 'string' ? x.trim() : str((x as AnyObject)?.name))).filter(
    (x): x is string => !!x,
  )
  return out.length ? out : null
}

/**
 * Map a raw BookWyrm Edition AP object onto our metadata shape. Pure (no I/O).
 * `pageSource` is 'bookwyrm' when the Edition itself carried a page count, else null
 * (the caller may then run an ISBN fallback). Language is kept raw for the merge to
 * normalize alongside the other sources.
 */
export function mapEdition(obj: AnyObject): EditionMetadata {
  const bookUrl = ((obj.id as string) ?? (obj.url as string)) ?? ''
  const pages = posInt(obj.pages)
  const authorUrls: string[] = []
  const authorNames: string[] = []
  for (const a of Array.isArray(obj.authors) ? obj.authors : []) {
    if (typeof a === 'string') {
      if (/^https?:\/\//.test(a)) authorUrls.push(a)
      else if (a.trim()) authorNames.push(a.trim())
    } else {
      const name = str((a as AnyObject)?.name)
      if (name) authorNames.push(name)
    }
  }
  const physicalFormat = (typeof obj.physicalFormat === 'string' && obj.physicalFormat) || null
  const languages = Array.isArray(obj.languages) ? obj.languages : []
  const language = typeof languages[0] === 'string' ? (languages[0] as string) : null
  const cover = obj.cover as AnyObject | undefined
  const publishers = strArray(obj.publishers)
  const descRaw = str(obj.description)
  return {
    bookUrl,
    workUrl: (typeof obj.work === 'string' && obj.work) || null,
    title: ((obj.title as string) ?? (obj.name as string)) || null,
    subtitle: str(obj.subtitle),
    authorUrls,
    authorNames,
    pages,
    physicalFormat,
    isbn13: str(obj.isbn13),
    isbn10: str(obj.isbn10),
    pubYear: yearOf(obj.publishedDate, obj.firstPublishedDate),
    language,
    publisher: publishers?.[0] ?? null,
    series: str(obj.series),
    coverUrl: str(cover?.url),
    description: descRaw ? stripHtml(descRaw) : null,
    subjects: strArray(obj.subjects),
    pageSource: pages != null ? 'bookwyrm' : null,
  }
}

// --- External ISBN enrichment (full metadata, matched by the resolved ISBN) ----

/**
 * Map an OpenLibrary `jscmd=data` entry (the value under the `ISBN:<isbn>` key).
 * Pure. Covers, subjects, publishers, page count and publish date are all for the
 * queried edition because OpenLibrary keys the response by that exact ISBN.
 */
export function mapOpenLibrary(entry: AnyObject, isbn: string): ExternalBookData {
  const cover = entry.cover as AnyObject | undefined
  const publishers = strArray(entry.publishers)
  const ids = entry.identifiers as AnyObject | undefined
  const isbn13 = strArray(ids?.isbn_13)?.[0] ?? (isbn.length === 13 ? isbn : null)
  const isbn10 = strArray(ids?.isbn_10)?.[0] ?? (isbn.length === 10 ? isbn : null)
  return {
    pages: posInt(entry.number_of_pages),
    coverUrl: str(cover?.large) ?? str(cover?.medium) ?? str(cover?.small),
    description: null, // jscmd=data rarely carries a usable description
    publisher: publishers?.[0] ?? null,
    publishedDate: str(entry.publish_date),
    language: normalizeLanguage(entry.languages),
    subjects: strArray(entry.subjects),
    authors: strArray(entry.authors),
    isbn13,
    isbn10,
  }
}

// Does a Google Books volume's industryIdentifiers contain one of the expected
// ISBNs? Guards against Google returning a different edition for an isbn: query.
function googleIdsMatch(volumeInfo: AnyObject, expected: (string | null)[]): boolean {
  const ids = volumeInfo.industryIdentifiers
  if (!Array.isArray(ids) || ids.length === 0) return true // nothing to check against
  const want = new Set(expected.filter((x): x is string => !!x))
  if (want.size === 0) return true
  return ids.some((id) => want.has(str((id as AnyObject)?.identifier) ?? ''))
}

/**
 * Map a Google Books `volumeInfo`. Pure. Returns null when the volume's identifiers
 * are present but don't include any expected ISBN (wrong-edition guard), so the
 * caller can drop mismatched data rather than mixing it into the edition.
 */
export function mapGoogleBooks(
  volumeInfo: AnyObject,
  expected: { isbn13: string | null; isbn10: string | null },
): ExternalBookData | null {
  if (!googleIdsMatch(volumeInfo, [expected.isbn13, expected.isbn10])) return null
  const imageLinks = volumeInfo.imageLinks as AnyObject | undefined
  const descRaw = str(volumeInfo.description)
  return {
    pages: posInt(volumeInfo.pageCount),
    coverUrl: str(imageLinks?.thumbnail) ?? str(imageLinks?.smallThumbnail),
    description: descRaw ? stripHtml(descRaw) : null,
    publisher: str(volumeInfo.publisher),
    publishedDate: str(volumeInfo.publishedDate),
    language: normalizeLanguage(volumeInfo.language),
    subjects: strArray(volumeInfo.categories),
    authors: strArray(volumeInfo.authors),
    isbn13: expected.isbn13,
    isbn10: expected.isbn10,
  }
}

async function fetchOpenLibrary(isbn: string): Promise<ExternalBookData | null> {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&jscmd=data&format=json`
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const data = (await res.json()) as AnyObject
    const entry = data[`ISBN:${isbn}`] as AnyObject | undefined
    return entry ? mapOpenLibrary(entry, isbn) : null
  } catch (e) {
    logger.warn({ isbn, error: e }, 'OpenLibrary lookup failed')
    return null
  }
}

async function fetchGoogleBooks(
  expected: { isbn13: string | null; isbn10: string | null },
): Promise<ExternalBookData | null> {
  const isbn = expected.isbn13 ?? expected.isbn10
  if (!isbn) return null
  const url = new URL('https://www.googleapis.com/books/v1/volumes')
  url.searchParams.set('q', `isbn:${isbn}`)
  if (config.GOOGLE_BOOKS_API_KEY) url.searchParams.set('key', config.GOOGLE_BOOKS_API_KEY)
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const data = (await res.json()) as AnyObject
    const items = Array.isArray(data.items) ? data.items : []
    const info = (items[0] as AnyObject | undefined)?.volumeInfo as AnyObject | undefined
    return info ? mapGoogleBooks(info, expected) : null
  } catch (e) {
    logger.warn({ isbn, error: e }, 'Google Books lookup failed')
    return null
  }
}

// --- Merge ------------------------------------------------------------------

// Treat empty strings / empty arrays as absent so they don't win a precedence slot.
function present<T>(v: T | null | undefined): v is T {
  if (v == null) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  return true
}

export interface MergeInputs {
  edition: EditionMetadata
  review?: ReviewMeta | null
  openLibrary?: ExternalBookData | null
  googleBooks?: ExternalBookData | null
  resolvedIsbn?: { isbn13: string | null; isbn10: string | null; source: IsbnSource | null }
}

/**
 * Merge the BookWyrm Edition (authoritative), the markus.plus review (ISBN +
 * curated gap-fillers), and the external ISBN services into one record. Pure. The
 * first present value per field wins; `sourceMap` records which source that was, and
 * every value used is for the resolved ISBN/edition. Language values are normalized
 * across sources so they're comparable.
 */
export function mergeBookMetadata(inputs: MergeInputs): BookMetadata {
  const { edition, review, openLibrary: ol, googleBooks: gb, resolvedIsbn } = inputs
  const sourceMap: Record<string, FieldSource> = {}

  // Pick the first present candidate; record its source.
  const pick = <T>(field: string, candidates: [T | null | undefined, FieldSource][]): T | null => {
    for (const [value, source] of candidates) {
      if (present(value)) {
        sourceMap[field] = source
        return value as T
      }
    }
    return null
  }

  const resolved = resolvedIsbn ?? resolveBestIsbn([
    { value: edition.isbn13 ?? edition.isbn10, source: 'bookwyrm' },
    { value: review?.isbn, source: 'review' },
  ])
  if (resolved.source) sourceMap.isbn = resolved.source as FieldSource

  // ISBN-mismatch detection: Edition vs review disagree on the edition's ISBN.
  const editionResolved = resolveBestIsbn([{ value: edition.isbn13 ?? edition.isbn10, source: 'bookwyrm' }])
  const reviewResolved = resolveBestIsbn([{ value: review?.isbn, source: 'review' }])
  if (
    editionResolved.isbn13 && reviewResolved.isbn13 &&
    editionResolved.isbn13 !== reviewResolved.isbn13
  ) {
    logger.warn(
      { bookUrl: edition.bookUrl, editionIsbn: editionResolved.isbn13, reviewIsbn: reviewResolved.isbn13 },
      'ISBN mismatch between BookWyrm Edition and markus.plus review; trusting the Edition',
    )
    sourceMap.isbnMismatch = 'override'
  }

  const language = pick<string>('language', [
    [normalizeLanguage(edition.language), 'bookwyrm'],
    [normalizeLanguage(review?.language), 'review'],
    [ol?.language ?? null, 'openlibrary'],
    [gb?.language ?? null, 'googlebooks'],
  ])

  const pages = pick<number>('pages', [
    [edition.pages, 'bookwyrm'],
    [review?.pages ?? null, 'review'],
    [ol?.pages ?? null, 'openlibrary'],
    [gb?.pages ?? null, 'googlebooks'],
  ])

  const coverUrl = pick<string>('coverUrl', [
    [edition.coverUrl, 'bookwyrm'],
    [review?.cover ?? null, 'review'],
    [ol?.coverUrl ?? null, 'openlibrary'],
    [gb?.coverUrl ?? null, 'googlebooks'],
  ])

  const pubYear = pick<number>('pubYear', [
    [edition.pubYear, 'bookwyrm'],
    [yearOf(ol?.publishedDate), 'openlibrary'],
    [yearOf(gb?.publishedDate), 'googlebooks'],
  ])

  const description = pick<string>('description', [
    [edition.description, 'bookwyrm'],
    [gb?.description ?? null, 'googlebooks'],
    [ol?.description ?? null, 'openlibrary'],
  ])

  const publisher = pick<string>('publisher', [
    [edition.publisher, 'bookwyrm'],
    [ol?.publisher ?? null, 'openlibrary'],
    [gb?.publisher ?? null, 'googlebooks'],
  ])

  const subjects = pick<string[]>('subjects', [
    [edition.subjects, 'bookwyrm'],
    [ol?.subjects ?? null, 'openlibrary'],
    [gb?.subjects ?? null, 'googlebooks'],
  ])

  const subtitle = pick<string>('subtitle', [
    [edition.subtitle, 'bookwyrm'],
    [review?.subtitle ?? null, 'review'],
  ])

  const joined = (names: string[] | null | undefined): string | null =>
    names?.length ? [...new Set(names)].join(', ') : null
  const author = pick<string>('author', [
    [joined(edition.authorNames), 'bookwyrm'],
    [joined(review?.authors), 'review'],
    [joined(ol?.authors), 'openlibrary'],
    [joined(gb?.authors), 'googlebooks'],
  ])

  const series = pick<string>('series', [
    [edition.series, 'bookwyrm'],
    [review?.series ?? null, 'review'],
  ])

  const title = pick<string>('title', [[edition.title, 'bookwyrm']])
  if (present(edition.workUrl)) sourceMap.workUrl = 'bookwyrm'
  if (present(edition.physicalFormat)) sourceMap.physicalFormat = 'bookwyrm'

  const originalLanguage = pick<string>('originalLanguage', [
    [normalizeLanguage(review?.originalLanguage), 'review'],
  ])

  return {
    bookUrl: edition.bookUrl,
    workUrl: edition.workUrl,
    title,
    subtitle,
    author,
    pages,
    physicalFormat: edition.physicalFormat,
    isbn13: resolved.isbn13,
    isbn10: resolved.isbn10,
    pubYear,
    language,
    originalLanguage,
    publisher,
    series,
    coverUrl,
    description,
    subjects: normalizeSubjects(subjects),
    pageSource: sourceMap.pages ?? null,
    isbnSource: resolved.source,
    sourceMap,
  }
}

// Fields we'd still like to fill from Google Books if missing after Edition+review+OL.
function hasGaps(m: BookMetadata): boolean {
  return (
    m.pages == null || m.coverUrl == null || m.description == null || m.author == null ||
    m.publisher == null || m.subjects == null || m.language == null || m.pubYear == null
  )
}

/**
 * Fetch and fully enrich one Edition's metadata: the BookWyrm Edition AP object
 * (authoritative), then — keyed by the best resolved ISBN (Edition → review →
 * bookwyrm_object) — OpenLibrary and, only if gaps remain, Google Books, plus the
 * markus.plus review's curated fields. Returns null if the Edition can't be fetched.
 */
export async function fetchEditionMetadata(
  bookUrl: string,
  review?: ReviewMeta | null,
  objectIsbn?: string | null,
): Promise<BookMetadata | null> {
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
  const edition = mapEdition(obj)
  edition.bookUrl ||= bookUrl

  // Dereference the Edition's author AP objects to names (process-lifetime cached).
  for (const url of edition.authorUrls) {
    const name = await resolveBookwyrmAuthorName(url)
    if (name && !edition.authorNames.includes(name)) edition.authorNames.push(name)
  }

  const resolved = resolveBestIsbn([
    { value: edition.isbn13, source: 'bookwyrm' },
    { value: edition.isbn10, source: 'bookwyrm' },
    { value: review?.isbn, source: 'review' },
    { value: objectIsbn, source: 'bookwyrm_object' },
  ])

  let openLibrary: ExternalBookData | null = null
  let googleBooks: ExternalBookData | null = null
  if (resolved.isbn13 || resolved.isbn10) {
    const olKey = resolved.isbn13 ?? resolved.isbn10!
    openLibrary = await fetchOpenLibrary(olKey)
    // Gap-gate Google to limit calls: only when something is still missing.
    const interim = mergeBookMetadata({ edition, review, openLibrary, resolvedIsbn: resolved })
    if (hasGaps(interim)) {
      googleBooks = await fetchGoogleBooks({ isbn13: resolved.isbn13, isbn10: resolved.isbn10 })
    }
  }

  return mergeBookMetadata({ edition, review, openLibrary, googleBooks, resolvedIsbn: resolved })
}
