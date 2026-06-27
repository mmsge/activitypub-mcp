import { getDb } from '../db/client.js'
import { bookMetadata, bookwyrmObjects } from '../db/schema.js'
import { fetchEditionMetadata } from '../lib/fetch-bookwyrm-edition.js'
import { fetchGardenBookReviews } from '../lib/fetch-garden.js'
import { logger } from '../lib/logger.js'
import { config } from '../config.js'
import { sql, and, gte, inArray, isNotNull } from 'drizzle-orm'

const MAX_PER_RUN = 200 // bound a single pass so a backfill doesn't hammer BookWyrm
const FETCH_DELAY_MS = 200
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000 // re-fetch metadata older than 30 days

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Collect every BookWyrm Edition URL referenced by stored reading data:
 *  - bookwyrm_objects.book_url (ReadThrough/Review/… that were ingested),
 *  - Edition tag hrefs on generic `objects` (started/finished generatednotes carry
 *    `{ type: "Edition", href: <book url> }` in their tags jsonb), and
 *  - inReplyToBook on comments/reviews (which reference the book that way, not via a tag).
 * Returns the distinct union. Raw SQL because the jsonb sources need a guarded
 * array unnest / field extraction that Drizzle's builder can't express cleanly.
 */
async function collectBookUrls(): Promise<string[]> {
  const db = getDb()
  const rows = await db.execute<{ book_url: string }>(sql`
    SELECT DISTINCT book_url FROM (
      SELECT book_url FROM bookwyrm_objects WHERE book_url IS NOT NULL
      UNION
      SELECT tag->>'href' AS book_url
      FROM objects, jsonb_array_elements(objects.tags) AS tag
      WHERE jsonb_typeof(objects.tags) = 'array'
        AND tag->>'type' = 'Edition'
        AND tag->>'href' IS NOT NULL
      UNION
      SELECT objects.raw->>'inReplyToBook' AS book_url
      FROM objects
      WHERE objects.raw->>'inReplyToBook' IS NOT NULL
    ) urls
    WHERE book_url <> ''
  `)
  return [...rows].map((r) => r.book_url)
}

/**
 * Map each book URL to an ISBN federated on its ingested BookWyrm objects. Used as
 * the 3rd-priority ISBN candidate (after the Edition's own and the markus.plus
 * review's) when resolving which ISBN to enrich by.
 */
async function collectObjectIsbns(): Promise<Map<string, string>> {
  const db = getDb()
  const rows = await db
    .select({ bookUrl: bookwyrmObjects.bookUrl, isbn: bookwyrmObjects.bookIsbn })
    .from(bookwyrmObjects)
    .where(and(isNotNull(bookwyrmObjects.bookUrl), isNotNull(bookwyrmObjects.bookIsbn)))
  const map = new Map<string, string>()
  for (const r of rows) if (r.bookUrl && r.isbn && !map.has(r.bookUrl)) map.set(r.bookUrl, r.isbn)
  return map
}

/**
 * Enrich the book_metadata cache: fetch the Edition AP object (plus the ISBN
 * page-count fallback) for any referenced book URL that is missing or stale, and
 * upsert it. Idempotent; bounded to MAX_PER_RUN URLs per pass.
 */
export async function syncBookMetadata(): Promise<void> {
  const db = getDb()

  const referenced = await collectBookUrls()
  if (referenced.length === 0) {
    logger.info('No book URLs referenced yet, skipping book metadata sync')
    return
  }

  // The markus.plus reviews (keyed by Edition URL) and ingested-object ISBNs feed the
  // ISBN resolution + gap-filling for each book; fetched once per run.
  const reviews = await fetchGardenBookReviews()
  const objectIsbns = await collectObjectIsbns()

  // Skip URLs already cached and still fresh; (re)fetch everything else. A one-time
  // BOOKMETA_BACKFILL bypasses the freshness filter so new fields backfill at once.
  const cutoff = new Date(Date.now() - STALE_AFTER_MS)
  const cachedFresh = config.BOOKMETA_BACKFILL
    ? new Set<string>()
    : new Set(
        (
          await db
            .select({ bookUrl: bookMetadata.bookUrl })
            .from(bookMetadata)
            .where(and(inArray(bookMetadata.bookUrl, referenced), gte(bookMetadata.fetchedAt, cutoff)))
        ).map((r) => r.bookUrl),
      )

  // Normal runs cap each pass so a backfill doesn't hammer BookWyrm; but a one-time
  // BOOKMETA_BACKFILL must reach every book in a single pass — with the cap on it
  // would reprocess the same first MAX_PER_RUN URLs each run and never advance.
  const cap = config.BOOKMETA_BACKFILL ? referenced.length : MAX_PER_RUN
  const todo = referenced.filter((u) => !cachedFresh.has(u)).slice(0, cap)

  logger.info(
    {
      referenced: referenced.length, stale_or_missing: todo.length, cap,
      reviews: reviews.size, backfill: config.BOOKMETA_BACKFILL,
    },
    'Starting book metadata sync',
  )

  let enriched = 0
  let withPages = 0
  let withCover = 0
  let withDescription = 0
  let isbnFromReview = 0
  for (const bookUrl of todo) {
    const meta = await fetchEditionMetadata(bookUrl, reviews.get(bookUrl) ?? null, objectIsbns.get(bookUrl) ?? null)
    if (!meta) continue
    const values = {
      bookUrl: meta.bookUrl,
      workUrl: meta.workUrl,
      title: meta.title,
      subtitle: meta.subtitle,
      pages: meta.pages,
      physicalFormat: meta.physicalFormat,
      isbn13: meta.isbn13,
      isbn10: meta.isbn10,
      pubYear: meta.pubYear,
      language: meta.language,
      originalLanguage: meta.originalLanguage,
      publisher: meta.publisher,
      series: meta.series,
      coverUrl: meta.coverUrl,
      description: meta.description,
      subjects: meta.subjects as unknown as Record<string, unknown>,
      pageSource: meta.pageSource,
      isbnSource: meta.isbnSource,
      sourceMap: meta.sourceMap as unknown as Record<string, unknown>,
      raw: meta as unknown as Record<string, unknown>,
      fetchedAt: new Date(),
    }
    await db
      .insert(bookMetadata)
      .values(values)
      .onConflictDoUpdate({ target: bookMetadata.bookUrl, set: values })
    enriched++
    if (meta.pages != null) withPages++
    if (meta.coverUrl != null) withCover++
    if (meta.description != null) withDescription++
    if (meta.isbnSource === 'review') isbnFromReview++
    await sleep(FETCH_DELAY_MS)
  }

  logger.info(
    { enriched, withPages, withCover, withDescription, isbnFromReview, withoutPages: enriched - withPages },
    'Book metadata sync complete',
  )
}
