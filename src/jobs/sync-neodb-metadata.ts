import { getDb } from '../db/client.js'
import { catalogMetadata } from '../db/schema.js'
import { fetchNeodbItem, type NeodbItemMetadata } from '../lib/fetch-neodb-item.js'
import { logger } from '../lib/logger.js'
import { sql, and, eq, gte, inArray } from 'drizzle-orm'

const MAX_PER_RUN = 200 // bound a single pass so a backfill doesn't hammer NeoDB
const FETCH_DELAY_MS = 200
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000 // re-fetch metadata older than 30 days

// AP object types NeoDB uses for film & TV catalog items. Books federate as
// `Edition` and are handled by the BookWyrm book-metadata pipeline, so they're
// deliberately excluded here.
export const NEODB_SCREEN_TAG_TYPES = ['Movie', 'TVShow', 'TVSeason', 'TVEpisode']

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function upsertCatalogMetadata(meta: NeodbItemMetadata): Promise<void> {
  const db = getDb()
  const values = {
    itemUrl: meta.itemUrl,
    category: meta.category,
    itemType: meta.itemType,
    title: meta.title,
    displayTitle: meta.displayTitle,
    origTitle: meta.origTitle,
    description: meta.description,
    coverUrl: meta.coverUrl,
    imdb: meta.imdb,
    imdbUrl: meta.imdbUrl,
    tmdbUrl: meta.tmdbUrl,
    externalResources: meta.externalResources as unknown as Record<string, unknown>,
    year: meta.year,
    seasonNumber: meta.seasonNumber,
    episodeCount: meta.episodeCount,
    genre: meta.genre as unknown as Record<string, unknown>,
    director: meta.director as unknown as Record<string, unknown>,
    actors: meta.actors as unknown as Record<string, unknown>,
    language: meta.language as unknown as Record<string, unknown>,
    area: meta.area as unknown as Record<string, unknown>,
    rating: meta.rating != null ? String(meta.rating) : null,
    parentUuid: meta.parentUuid,
    raw: meta.raw as Record<string, unknown>,
    fetchedAt: new Date(),
  }
  await db
    .insert(catalogMetadata)
    .values(values)
    .onConflictDoUpdate({ target: catalogMetadata.itemUrl, set: values })
}

// --- On-ingest enrichment ----------------------------------------------------
//
// When a mark referencing a not-yet-cached NeoDB catalog item is ingested (live
// federation or the outbox backfill — both funnel through handleCreate), its
// metadata is fetched right away instead of waiting for the next sync pass.
// `attempted` dedupes a burst of marks about the same title to one fetch; the
// promise chain serializes fetches so a large backfill can't stampede NeoDB.
// Failures are left to the periodic sync, which retries every referenced-but-
// uncached URL anyway.

const attempted = new Set<string>()
let ingestQueue: Promise<void> = Promise.resolve()

export function queueNeodbEnrichment(itemUrl: string): void {
  if (!itemUrl || attempted.has(itemUrl)) return
  attempted.add(itemUrl)
  ingestQueue = ingestQueue
    .then(() => enrichIfMissing(itemUrl))
    .catch((e) => logger.warn({ itemUrl, error: e }, 'On-ingest NeoDB enrichment failed'))
}

async function enrichIfMissing(itemUrl: string): Promise<void> {
  const db = getDb()
  const existing = await db
    .select({ itemUrl: catalogMetadata.itemUrl })
    .from(catalogMetadata)
    .where(eq(catalogMetadata.itemUrl, itemUrl))
    .limit(1)
  if (existing.length > 0) return

  const meta = await fetchNeodbItem(itemUrl)
  if (!meta) return
  await upsertCatalogMetadata(meta)
  logger.info({ itemUrl, imdb: meta.imdb, title: meta.displayTitle ?? meta.title }, 'Enriched NeoDB metadata on ingest')
  await sleep(FETCH_DELAY_MS)
}

/**
 * Every NeoDB film/TV catalog URL referenced by a stored mark: the tag hrefs on
 * `objects` whose tag `type` is one of NEODB_SCREEN_TAG_TYPES. Raw SQL because the
 * jsonb tag array needs a guarded unnest / field extraction Drizzle can't express
 * cleanly. Returns the distinct set.
 */
async function collectItemUrls(): Promise<string[]> {
  const db = getDb()
  const rows = await db.execute<{ item_url: string }>(sql`
    SELECT DISTINCT tag->>'href' AS item_url
    FROM objects, jsonb_array_elements(objects.tags) AS tag
    WHERE jsonb_typeof(objects.tags) = 'array'
      AND tag->>'type' IN ('Movie', 'TVShow', 'TVSeason', 'TVEpisode')
      AND tag->>'href' IS NOT NULL
      AND tag->>'href' <> ''
  `)
  return [...rows].map((r) => r.item_url)
}

/**
 * Enrich the catalog_metadata cache: fetch the NeoDB catalog item for any
 * referenced film/TV URL that is missing or stale, and upsert it. Idempotent;
 * bounded to MAX_PER_RUN URLs per pass.
 */
export async function syncNeodbMetadata(): Promise<void> {
  const db = getDb()

  const referenced = await collectItemUrls()
  if (referenced.length === 0) {
    logger.info('No NeoDB catalog URLs referenced yet, skipping NeoDB metadata sync')
    return
  }

  const cutoff = new Date(Date.now() - STALE_AFTER_MS)
  const cachedFresh = new Set(
    (
      await db
        .select({ itemUrl: catalogMetadata.itemUrl })
        .from(catalogMetadata)
        .where(and(inArray(catalogMetadata.itemUrl, referenced), gte(catalogMetadata.fetchedAt, cutoff)))
    ).map((r) => r.itemUrl),
  )

  const todo = referenced.filter((u) => !cachedFresh.has(u)).slice(0, MAX_PER_RUN)

  logger.info(
    { referenced: referenced.length, stale_or_missing: todo.length },
    'Starting NeoDB metadata sync',
  )

  let enriched = 0
  let withImdb = 0
  for (const itemUrl of todo) {
    const meta = await fetchNeodbItem(itemUrl)
    if (!meta) continue
    await upsertCatalogMetadata(meta)
    enriched++
    if (meta.imdb) withImdb++
    await sleep(FETCH_DELAY_MS)
  }

  logger.info({ enriched, withImdb, withoutImdb: enriched - withImdb }, 'NeoDB metadata sync complete')
}
