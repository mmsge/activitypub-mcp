import { getDb } from '../db/client.js'
import { bookMetadata } from '../db/schema.js'
import { fetchEditionMetadata } from '../lib/fetch-bookwyrm-edition.js'
import { logger } from '../lib/logger.js'
import { sql, and, gte, inArray } from 'drizzle-orm'

const MAX_PER_RUN = 200 // bound a single pass so a backfill doesn't hammer BookWyrm
const FETCH_DELAY_MS = 200
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000 // re-fetch metadata older than 30 days

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Collect every BookWyrm Edition URL referenced by stored reading data:
 *  - bookwyrm_objects.book_url (ReadThrough/Review/… that were ingested), and
 *  - Edition tag hrefs on generic `objects` (the started/finished generatednotes
 *    carry `{ type: "Edition", href: <book url> }` in their tags jsonb).
 * Returns the distinct union. Raw SQL because the second source needs a guarded
 * jsonb array unnest that Drizzle's builder can't express cleanly.
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
    ) urls
    WHERE book_url <> ''
  `)
  return [...rows].map((r) => r.book_url)
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

  // Skip URLs already cached and still fresh; (re)fetch everything else.
  const cutoff = new Date(Date.now() - STALE_AFTER_MS)
  const cachedFresh = new Set(
    (
      await db
        .select({ bookUrl: bookMetadata.bookUrl })
        .from(bookMetadata)
        .where(and(inArray(bookMetadata.bookUrl, referenced), gte(bookMetadata.fetchedAt, cutoff)))
    ).map((r) => r.bookUrl),
  )

  const todo = referenced.filter((u) => !cachedFresh.has(u)).slice(0, MAX_PER_RUN)

  logger.info(
    { referenced: referenced.length, stale_or_missing: todo.length, cap: MAX_PER_RUN },
    'Starting book metadata sync',
  )

  let enriched = 0
  let withPages = 0
  for (const bookUrl of todo) {
    const meta = await fetchEditionMetadata(bookUrl)
    if (!meta) continue
    await db
      .insert(bookMetadata)
      .values({
        bookUrl: meta.bookUrl,
        workUrl: meta.workUrl,
        title: meta.title,
        pages: meta.pages,
        physicalFormat: meta.physicalFormat,
        isbn13: meta.isbn13,
        pubYear: meta.pubYear,
        language: meta.language,
        pageSource: meta.pageSource,
        raw: meta as unknown as Record<string, unknown>,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: bookMetadata.bookUrl,
        set: {
          workUrl: meta.workUrl,
          title: meta.title,
          pages: meta.pages,
          physicalFormat: meta.physicalFormat,
          isbn13: meta.isbn13,
          pubYear: meta.pubYear,
          language: meta.language,
          pageSource: meta.pageSource,
          raw: meta as unknown as Record<string, unknown>,
          fetchedAt: new Date(),
        },
      })
    enriched++
    if (meta.pages != null) withPages++
    await sleep(FETCH_DELAY_MS)
  }

  logger.info(
    { enriched, withPages, withoutPages: enriched - withPages },
    'Book metadata sync complete',
  )
}
