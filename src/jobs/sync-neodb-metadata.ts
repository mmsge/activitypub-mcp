import { getDb } from '../db/client.js'
import { catalogMetadata, bookMetadata } from '../db/schema.js'
import { fetchNeodbItem, type NeodbItemMetadata } from '../lib/fetch-neodb-item.js'
import { normalizeIsbn, isbn10to13 } from '../lib/isbn.js'
import { logger } from '../lib/logger.js'
import { config } from '../config.js'
import { sql, and, eq, or } from 'drizzle-orm'

const MAX_PER_RUN = 200 // bound a single pass so a backfill doesn't hammer NeoDB
const FETCH_DELAY_MS = 200
const STALE_AFTER_MS = config.NEODB_STALE_DAYS * 24 * 60 * 60 * 1000 // re-fetch older than this

// AP object types NeoDB uses in the single mark tag. The film/TV set is kept as its
// own export for the create-handler's existing call site; the media set adds the
// non-film categories. Books federate as `Edition` (shared with BookWyrm), so they're
// routed by URL shape (isNeodbBookUrl) rather than by type alone.
export const NEODB_SCREEN_TAG_TYPES = ['Movie', 'TVShow', 'TVSeason', 'TVEpisode']
export const NEODB_MEDIA_TAG_TYPES = [
  ...NEODB_SCREEN_TAG_TYPES,
  'Album', 'Game', 'Podcast', 'Performance', 'PerformanceProduction',
]

// A NeoDB `book` catalog URL (…/book/<base62 id>), as opposed to a BookWyrm Edition
// (…/book/<numeric id>). Used to route an ambiguous `Edition` tag to the right
// enrichment pipeline: NeoDB books here, BookWyrm editions to sync-book-metadata.
export function isNeodbBookUrl(href: string): boolean {
  try {
    const path = new URL(href).pathname
    const m = /^\/book\/([^/]+)/.exec(path)
    if (!m) return false
    return /[a-zA-Z]/.test(m[1]) // base62 NeoDB id has letters; BookWyrm ids are digits
  } catch {
    return false
  }
}

// Collect the NeoDB catalog hrefs a mark's tags reference: every media-type tag, plus
// `Edition` tags that are NeoDB book URLs. Used at ingest time.
export function collectNeodbTagHrefs(tags: unknown): string[] {
  const urls = new Set<string>()
  for (const t of Array.isArray(tags) ? tags : []) {
    const tag = t as Record<string, unknown>
    const type = typeof tag?.type === 'string' ? tag.type : ''
    const href = typeof tag?.href === 'string' ? tag.href : ''
    if (!href) continue
    if (NEODB_MEDIA_TAG_TYPES.includes(type)) urls.add(href)
    else if (type === 'Edition' && isNeodbBookUrl(href)) urls.add(href)
  }
  return [...urls]
}

// Distinct, non-empty mark tag `name`s that a single object attaches to `itemUrl` —
// the ActivityPub-supplied aliases for that catalog item. Restricted to NeoDB media
// tags (and `Edition`, for NeoDB books) so an unrelated hashtag that happens to share
// the href can't leak in. `itemUrl` is always a NeoDB catalog URL here (it's the
// catalog row's key), so the href match already scopes it to the right item. Pure so
// it's unit-testable; markTitlesForUrl unions it across every stored mark.
export function extractMarkTitles(tags: unknown, itemUrl: string): string[] {
  const names = new Set<string>()
  for (const t of Array.isArray(tags) ? tags : []) {
    const tag = t as Record<string, unknown>
    if (typeof tag?.href !== 'string' || tag.href !== itemUrl) continue
    const type = typeof tag.type === 'string' ? tag.type : ''
    if (!NEODB_MEDIA_TAG_TYPES.includes(type) && type !== 'Edition') continue
    const name = typeof tag.name === 'string' ? tag.name.trim() : ''
    if (name) names.add(name)
  }
  return [...names]
}

// The accumulated alias set for one catalog item: every distinct mark `name` across
// all stored marks referencing it. Local-only (no NeoDB fetch); the jsonb `@>`
// containment prunes to objects that actually tag this href before extractMarkTitles
// applies the type rule. Sorted for stable output.
export async function markTitlesForUrl(itemUrl: string): Promise<string[]> {
  const db = getDb()
  const rows = await db.execute<{ tags: unknown }>(sql`
    SELECT tags FROM objects
    WHERE jsonb_typeof(tags) = 'array'
      AND tags @> ${JSON.stringify([{ href: itemUrl }])}::jsonb
  `)
  const names = new Set<string>()
  for (const r of [...rows]) for (const n of extractMarkTitles(r.tags, itemUrl)) names.add(n)
  return [...names].sort()
}

// Recompute a catalog row's aliases from the stored marks and write them (with
// provenance) — updating the existing row only, never fetching NeoDB. A no-op when the
// row doesn't exist yet (enrichment creates it, seeding mark_titles itself). This is
// how a later mark under a new name accumulates onto an already-enriched row, which
// the enrichment paths' staleness guards would otherwise skip.
export async function syncMarkTitles(itemUrl: string): Promise<void> {
  const db = getDb()
  const names = await markTitlesForUrl(itemUrl)
  if (names.length === 0) {
    await db.execute(sql`
      UPDATE catalog_metadata
      SET mark_titles = NULL,
          source_map = (coalesce(source_map, '{}'::jsonb) - 'mark_titles')
      WHERE item_url = ${itemUrl}
    `)
    return
  }
  await db.execute(sql`
    UPDATE catalog_metadata
    SET mark_titles = ${JSON.stringify(names)}::jsonb,
        source_map = coalesce(source_map, '{}'::jsonb) || '{"mark_titles":"activitypub"}'::jsonb
    WHERE item_url = ${itemUrl}
  `)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- BookWyrm dedup ----------------------------------------------------------
//
// A NeoDB `book` mark and a BookWyrm shelving can be the same physical book. Rather
// than duplicate the record, a NeoDB book that matches a cached BookWyrm Edition by
// ISBN keeps its own catalog row but links to that Edition (bookwyrm_book_url) and
// mirrors BookWyrm's authoritative fields (marking them 'bookwyrm' in source_map).
// The two histories stay separate; the reference data is shared. See ADR 0006.

async function dedupeBookAgainstBookwyrm(meta: NeodbItemMetadata): Promise<void> {
  const norm = normalizeIsbn(meta.isbn)
  if (!norm) return
  const alt = norm.length === 10 ? isbn10to13(norm) : null
  const candidates = [eq(bookMetadata.isbn13, norm), eq(bookMetadata.isbn10, norm)]
  if (alt) candidates.push(eq(bookMetadata.isbn13, alt))

  const db = getDb()
  const rows = await db
    .select()
    .from(bookMetadata)
    .where(or(...candidates))
    .limit(1)
  const bw = rows[0]
  if (!bw) return

  meta.bookwyrmBookUrl = bw.bookUrl

  // Mirror BookWyrm's authoritative fields where it has them, marking provenance.
  if (bw.author) { meta.details.author = bw.author; meta.sourceMap.author = 'bookwyrm' }
  if (bw.pages != null) { meta.details.pages = bw.pages; meta.sourceMap.pages = 'bookwyrm' }
  if (bw.publisher) { meta.details.publisher = bw.publisher; meta.sourceMap.publisher = 'bookwyrm' }
  if (bw.coverUrl) { meta.coverUrl = bw.coverUrl; meta.sourceMap.cover_url = 'bookwyrm' }
  if (bw.description) { meta.description = bw.description; meta.sourceMap.description = 'bookwyrm' }
  if (bw.pubYear != null) { meta.year = bw.pubYear; meta.sourceMap.year = 'bookwyrm' }
  logger.info({ itemUrl: meta.itemUrl, bookwyrmBookUrl: bw.bookUrl }, 'Deduped NeoDB book against BookWyrm cache')
}

// --- Persistence -------------------------------------------------------------

async function upsertCatalogMetadata(meta: NeodbItemMetadata): Promise<void> {
  const db = getDb()
  const now = new Date()
  // Retain the name(s) the mark(s) federated with alongside NeoDB's (localized) title,
  // and record 'activitypub' provenance so source_map distinguishes them.
  const markTitles = await markTitlesForUrl(meta.itemUrl)
  const sourceMap = markTitles.length
    ? { ...meta.sourceMap, mark_titles: 'activitypub' }
    : meta.sourceMap
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
    details: meta.details as Record<string, unknown>,
    markTitles: (markTitles.length ? markTitles : null) as unknown as Record<string, unknown>,
    sourceMap: sourceMap as Record<string, unknown>,
    bookwyrmBookUrl: meta.bookwyrmBookUrl,
    raw: meta.raw as Record<string, unknown>,
    fetchedAt: now,
    enrichedAt: now,
    fetchError: null,
    fetchAttempts: 0,
    lastAttemptAt: now,
  }
  await db
    .insert(catalogMetadata)
    .values(values)
    .onConflictDoUpdate({ target: catalogMetadata.itemUrl, set: values })
}

// Record a failed fetch instead of dropping it: an existing row keeps its good data
// (only the error/attempt bookkeeping updates); a never-seen URL gets a stub with the
// error so it's visible and retried. enrichedAt is left untouched (null until a fetch
// actually succeeds) so the staleness/retry logic re-attempts it.
async function recordFailure(itemUrl: string, hint: { category?: string | null; itemType?: string | null }, error: string): Promise<void> {
  const db = getDb()
  const now = new Date()
  await db
    .insert(catalogMetadata)
    .values({
      itemUrl,
      category: hint.category ?? null,
      itemType: hint.itemType ?? null,
      raw: {},
      fetchedAt: now,
      enrichedAt: null,
      fetchError: error,
      fetchAttempts: 1,
      lastAttemptAt: now,
    })
    .onConflictDoUpdate({
      target: catalogMetadata.itemUrl,
      set: {
        fetchError: error,
        fetchAttempts: sql`${catalogMetadata.fetchAttempts} + 1`,
        lastAttemptAt: now,
        fetchedAt: now,
      },
    })
  logger.warn({ itemUrl, error }, 'Recorded failed NeoDB enrichment (retryable)')
}

// Fetch, dedup (books), and persist one item — recording a failure row if the fetch
// yields nothing. Returns the mapped metadata on success, else null. Exported as
// `enrichCatalogueItem` for the repair job, which needs an awaited, per-item result
// rather than the fire-and-forget ingest queue.
export async function enrichOne(itemUrl: string, hint: { category?: string | null; itemType?: string | null }): Promise<NeodbItemMetadata | null> {
  const meta = await fetchNeodbItem(itemUrl)
  if (!meta) {
    await recordFailure(itemUrl, hint, 'fetch failed or returned no JSON')
    return null
  }
  if (meta.category === 'book' || meta.itemType === 'Edition') {
    try { await dedupeBookAgainstBookwyrm(meta) } catch (e) { logger.warn({ itemUrl, error: e }, 'Book dedup failed (non-fatal)') }
  }
  await upsertCatalogMetadata(meta)
  return meta
}

export { enrichOne as enrichCatalogueItem }

// --- On-ingest enrichment ----------------------------------------------------
//
// When a mark referencing a not-yet-enriched NeoDB catalog item is ingested (live
// federation or the outbox backfill — both funnel through handleCreate), its metadata
// is fetched right away instead of waiting for the next sync pass. `attempted` dedupes
// a burst of marks about the same title to one fetch; the promise chain serializes
// fetches so a large backfill can't stampede NeoDB. Failures are recorded and retried
// by the periodic sync.

const attempted = new Set<string>()
let ingestQueue: Promise<void> = Promise.resolve()

export function queueNeodbEnrichment(itemUrl: string): void {
  if (!itemUrl || attempted.has(itemUrl)) return
  attempted.add(itemUrl)
  ingestQueue = ingestQueue
    .then(() => enrichIfNeeded(itemUrl))
    .catch((e) => logger.warn({ itemUrl, error: e }, 'On-ingest NeoDB enrichment failed'))
}

async function enrichIfNeeded(itemUrl: string): Promise<void> {
  const db = getDb()
  const existing = await db
    .select({ enrichedAt: catalogMetadata.enrichedAt, fetchError: catalogMetadata.fetchError })
    .from(catalogMetadata)
    .where(eq(catalogMetadata.itemUrl, itemUrl))
    .limit(1)
  // Already enriched cleanly → leave staleness to the periodic sync.
  if (existing[0]?.enrichedAt && !existing[0].fetchError) return

  const meta = await enrichOne(itemUrl, {})
  if (meta) {
    logger.info(
      { itemUrl, category: meta.category, title: meta.displayTitle ?? meta.title },
      'Enriched NeoDB metadata on ingest',
    )
  }
  await sleep(FETCH_DELAY_MS)
}

// --- Periodic sync -----------------------------------------------------------

/**
 * Every NeoDB catalog URL referenced by a stored mark: the tag hrefs on `objects`
 * whose tag `type` is a NeoDB media type, plus `Edition` tags carried by a NeoDB
 * actor's marks (software = 'neodb') — the latter joined so a BookWyrm Edition never
 * leaks in. Returns each distinct URL with the tag type as a category hint. Raw SQL
 * because the jsonb tag array needs a guarded unnest Drizzle can't express cleanly.
 */
async function collectItemUrls(): Promise<{ itemUrl: string; itemType: string | null }[]> {
  const db = getDb()
  const mediaTypes = NEODB_MEDIA_TAG_TYPES.map((t) => `'${t}'`).join(', ')
  const rows = await db.execute<{ item_url: string; item_type: string | null }>(sql`
    SELECT DISTINCT ON (tag->>'href') tag->>'href' AS item_url, tag->>'type' AS item_type
    FROM objects
    JOIN actors ON actors.ap_id = objects.actor_ap_id
    , jsonb_array_elements(objects.tags) AS tag
    WHERE jsonb_typeof(objects.tags) = 'array'
      AND tag->>'href' IS NOT NULL
      AND tag->>'href' <> ''
      AND (
        tag->>'type' IN (${sql.raw(mediaTypes)})
        OR (tag->>'type' = 'Edition' AND actors.software = 'neodb')
      )
  `)
  return [...rows].map((r) => ({ itemUrl: r.item_url, itemType: r.item_type }))
}

/**
 * Enrich the catalog_metadata cache: fetch the NeoDB catalog item for any referenced
 * URL that is missing, stale (older than NEODB_STALE_DAYS), or previously errored, and
 * upsert it. Idempotent, rate-limited (FETCH_DELAY_MS between fetches), bounded to
 * MAX_PER_RUN per pass. `force` (or the one-time NEODB_BACKFILL switch) re-enriches
 * every referenced URL, so newly-added fields backfill after a deploy.
 */
export async function syncNeodbMetadata(force = config.NEODB_BACKFILL): Promise<void> {
  const db = getDb()

  const referenced = await collectItemUrls()
  if (referenced.length === 0) {
    logger.info('No NeoDB catalog URLs referenced yet, skipping NeoDB metadata sync')
    return
  }

  // Which referenced URLs are already enriched and still fresh (skip these unless
  // forced). A row counts as fresh only when it has a clean, recent successful fetch.
  const cutoff = new Date(Date.now() - STALE_AFTER_MS)
  const freshRows = force
    ? []
    : await db
        .select({ itemUrl: catalogMetadata.itemUrl, enrichedAt: catalogMetadata.enrichedAt, fetchError: catalogMetadata.fetchError })
        .from(catalogMetadata)
  const fresh = new Set(
    freshRows
      .filter((r) => r.enrichedAt && !r.fetchError && r.enrichedAt >= cutoff)
      .map((r) => r.itemUrl),
  )

  const todo = referenced.filter((r) => !fresh.has(r.itemUrl))
  const cap = force ? todo.length : MAX_PER_RUN
  const batch = todo.slice(0, cap)

  logger.info(
    { referenced: referenced.length, stale_or_missing: todo.length, batch: batch.length, force },
    'Starting NeoDB metadata sync',
  )

  let enriched = 0
  let failed = 0
  const byCategory: Record<string, number> = {}
  for (const { itemUrl, itemType } of batch) {
    const meta = await enrichOne(itemUrl, { itemType })
    if (meta) {
      enriched++
      const c = meta.category ?? 'unknown'
      byCategory[c] = (byCategory[c] ?? 0) + 1
    } else {
      failed++
    }
    await sleep(FETCH_DELAY_MS)
  }

  // Reconcile the mark-supplied aliases for every referenced item, independent of NeoDB
  // staleness — this catches a new alias on an already-enriched (fresh) row that the
  // enrichment batch above skipped. Local-only and idempotent, so it's cheap to run for
  // all referenced URLs, not just the enriched batch.
  let aliasSynced = 0
  for (const { itemUrl } of referenced) {
    try { await syncMarkTitles(itemUrl); aliasSynced++ } catch (e) {
      logger.warn({ itemUrl, error: e }, 'Mark-title alias sync failed (non-fatal)')
    }
  }

  logger.info({ enriched, failed, byCategory, aliasSynced }, 'NeoDB metadata sync complete')
}
