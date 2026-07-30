import { getDb } from '../db/client.js'
import { catalogMetadata, serverConfig } from '../db/schema.js'
import { eq, sql } from 'drizzle-orm'
import { stripHtml } from '../lib/strip-html.js'
import { extractContent } from '../lib/object-content.js'
import { fetchApObject } from '../lib/fetch-ap-object.js'
import { objectApId, resolveRef } from '../lib/ap-object.js'
import { ingestObject } from '../activitypub/handlers/create.js'
import { reprocessStoredMarks } from './sync-neodb-marks.js'
import {
  NEODB_MEDIA_TAG_TYPES,
  enrichCatalogueItem,
  isNeodbBookUrl,
  syncMarkTitles,
} from './sync-neodb-metadata.js'
import { logger } from '../lib/logger.js'

type AnyObject = Record<string, unknown>

// Bump when the repair logic changes and existing installs need to run it again.
const MARKER_KEY = 'neodb_ingest_repair_v1'
const BATCH = 500
const MAX_REFETCH = 500
const FETCH_DELAY_MS = 200

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface RepairResult {
  /** Rows whose text was re-derived from the stored raw object. */
  postsRepaired: number
  /** Rows whose stored raw had no text either, so the object was fetched again. */
  postsRefetched: number
  /**
   * Marks reprocessed from stored objects into neodb_marks. Counts upserts attempted,
   * not rows changed — a re-run reprocesses every stored mark, and the `updated`-guarded
   * upsert makes the unchanged ones no-ops.
   */
  marksUpserted: number
  /** Catalogue items enriched, failed, and skipped as already-enriched. */
  itemsEnriched: number
  itemsFailed: number
  itemsSkipped: number
  /** Catalogue rows whose mark-supplied title aliases were reconciled. */
  aliasSynced: number
}

const MEDIA_TYPES_SQL = NEODB_MEDIA_TAG_TYPES.map((t) => `'${t}'`).join(', ')

// A stored post that looks like a NeoDB mark: it kept the `relatedWith` extension, or it
// carries a catalogue tag. Either is enough to know the row should have produced a
// catalogue entry, whichever delivery path stored it.
const MARK_SHAPED = sql`(
  o.raw ? 'relatedWith'
  OR (jsonb_typeof(o.tags) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(o.tags) AS tag
    WHERE tag->>'type' IN (${sql.raw(MEDIA_TYPES_SQL)}) OR tag->>'type' = 'Edition'
  ))
)`

/**
 * Re-derive the text of mark-shaped posts stored without any.
 *
 * The boost path used to write `content_text: null` unconditionally, so 27 film marks sat
 * in `objects` with their prose (the "blev færdig med at se …" line and the user's own
 * comment) unreachable. The original object is kept in `raw`, so the text is almost
 * always recoverable locally; a row whose raw is a stub too is fetched again from origin
 * and re-ingested in full, which also fixes its tags and mark.
 */
interface RepairCandidate extends Record<string, unknown> {
  id: string
  ap_id: string
  actor_ap_id: string
  content: string | null
  content_text: string | null
  raw: AnyObject
}

async function repairPostText(refetch: boolean): Promise<{ repaired: number; refetched: number }> {
  const db = getDb()
  let lastId: string | null = null
  let repaired = 0
  let refetched = 0

  for (;;) {
    const rows: Iterable<RepairCandidate> = await db.execute<RepairCandidate>(sql`
      SELECT o.id, o.ap_id, o.actor_ap_id, o.content, o.content_text, o.raw
      FROM objects o
      WHERE (o.content_text IS NULL OR o.content_text = '')
        AND ${MARK_SHAPED}
        ${lastId ? sql`AND o.id > ${lastId}::uuid` : sql``}
      ORDER BY o.id
      LIMIT ${BATCH}
    `)
    const batch = [...rows]
    if (batch.length === 0) break
    lastId = batch[batch.length - 1].id

    for (const row of batch) {
      const content = extractContent(row.raw ?? {}) ?? ''
      if (content) {
        const contentText = stripHtml(content)
        if (content !== (row.content ?? '') || contentText !== (row.content_text ?? '')) {
          await db.execute(sql`
            UPDATE objects SET content = ${content}, content_text = ${contentText}, updated_at = now()
            WHERE id = ${row.id}::uuid
          `)
          repaired++
        }
        continue
      }
      // No text in the stored raw either — the row was written from a stub. Fetch the
      // object from origin and re-ingest it properly.
      if (!refetch || refetched >= MAX_REFETCH) continue
      const fetched = await fetchApObject(row.ap_id)
      await sleep(FETCH_DELAY_MS)
      if (!fetched || !objectApId(fetched)) continue
      const actorApId = resolveRef(fetched.attributedTo) ?? row.actor_ap_id
      try {
        await ingestObject(fetched, actorApId, { source: 'create' })
        refetched++
      } catch (e) {
        logger.warn({ apId: row.ap_id, error: e }, 'Re-ingest of refetched mark failed')
      }
    }
  }

  return { repaired, refetched }
}

/**
 * Every NeoDB catalogue URL a stored post points at, from `tags[].href`. `Edition` tags
 * are shared with BookWyrm, so only NeoDB-shaped book URLs are taken; the rest route to
 * the BookWyrm pipeline.
 */
async function collectTaggedItemUrls(): Promise<{ itemUrl: string; itemType: string | null }[]> {
  const db = getDb()
  const rows = await db.execute<{ item_url: string; item_type: string | null }>(sql`
    SELECT DISTINCT ON (tag->>'href') tag->>'href' AS item_url, tag->>'type' AS item_type
    FROM objects o, jsonb_array_elements(o.tags) AS tag
    WHERE jsonb_typeof(o.tags) = 'array'
      AND coalesce(tag->>'href', '') <> ''
      AND (tag->>'type' IN (${sql.raw(MEDIA_TYPES_SQL)}) OR tag->>'type' = 'Edition')
  `)
  return [...rows]
    .map((r) => ({ itemUrl: r.item_url, itemType: r.item_type }))
    .filter((r) => r.itemType !== 'Edition' || isNeodbBookUrl(r.itemUrl))
}

/**
 * Walk the stored posts and rebuild everything they should have produced (criterion 5):
 * their own text, their rows in the mark store, and the catalogue entries `get_watched`
 * reads. Local-first and idempotent — nothing is re-marked on NeoDB, no post is
 * re-federated, and re-running it is a no-op once everything is enriched.
 *
 * `force` re-runs it even when the one-time startup marker is set (the CLI and the admin
 * button both force). Enrichment fetches NeoDB once per missing item, rate-limited.
 */
export async function repairNeodbIngest(
  opts: { force?: boolean; refetch?: boolean } = {},
): Promise<RepairResult | null> {
  const db = getDb()
  const force = opts.force ?? false
  const refetch = opts.refetch ?? true

  if (!force) {
    const [marker] = await db.select().from(serverConfig).where(eq(serverConfig.key, MARKER_KEY))
    if (marker) return null
  }

  const { repaired, refetched } = await repairPostText(refetch)

  // Stored marks → neodb_marks. Picks up every mark whose raw kept `relatedWith`,
  // including the commented ones the array-shaped payload previously hid.
  const marksUpserted = await reprocessStoredMarks()

  // Tagged items → catalog_metadata. A row that already enriched cleanly is left alone
  // (staleness is the periodic sync's job) unless this run is forced.
  const referenced = await collectTaggedItemUrls()
  const existing = await db
    .select({ itemUrl: catalogMetadata.itemUrl, enrichedAt: catalogMetadata.enrichedAt, fetchError: catalogMetadata.fetchError })
    .from(catalogMetadata)
  const enrichedOk = new Set(
    existing.filter((r) => r.enrichedAt && !r.fetchError).map((r) => r.itemUrl),
  )

  let itemsEnriched = 0
  let itemsFailed = 0
  let itemsSkipped = 0
  for (const { itemUrl, itemType } of referenced) {
    if (enrichedOk.has(itemUrl)) { itemsSkipped++; continue }
    const meta = await enrichCatalogueItem(itemUrl, { itemType })
    if (meta) itemsEnriched++
    else itemsFailed++
    await sleep(FETCH_DELAY_MS)
  }

  // Reconcile the mark-supplied title aliases for everything referenced, including rows
  // the enrichment step skipped — local-only and cheap.
  let aliasSynced = 0
  for (const { itemUrl } of referenced) {
    try { await syncMarkTitles(itemUrl); aliasSynced++ } catch (e) {
      logger.warn({ itemUrl, error: e }, 'Mark-title alias sync failed (non-fatal)')
    }
  }

  await db
    .insert(serverConfig)
    .values({ key: MARKER_KEY, value: new Date().toISOString() })
    .onConflictDoUpdate({ target: serverConfig.key, set: { value: new Date().toISOString() } })

  const result: RepairResult = {
    postsRepaired: repaired,
    postsRefetched: refetched,
    marksUpserted,
    itemsEnriched,
    itemsFailed,
    itemsSkipped,
    aliasSynced,
  }
  logger.info({ ...result, referenced: referenced.length }, 'NeoDB ingest repair complete')
  return result
}
