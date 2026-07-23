import { getDb } from '../db/client.js'
import { catalogMetadata, serverConfig } from '../db/schema.js'
import { syncMarkTitles } from './sync-neodb-metadata.js'
import { logger } from '../lib/logger.js'
import { asc, eq, gt } from 'drizzle-orm'

// Bump this key if the alias-extraction rule changes and existing rows need
// re-deriving from their marks.
const MARKER_KEY = 'mark_titles_backfill_v1'
const BATCH_SIZE = 500

/**
 * One-time seed of `catalog_metadata.mark_titles` for rows that predate the column.
 * NeoDB enrichment overwrites the title with the localized name (e.g. "Konflikt"),
 * discarding the name the mark federated with (e.g. "Conflict") — so a search for the
 * mark's name missed the row. This recomputes each row's accumulated aliases from the
 * stored marks in `objects` (local-only, no NeoDB fetch) via syncMarkTitles, which also
 * records the 'activitypub' source_map provenance.
 *
 * Idempotent and guarded by a server_config marker so it runs once. (The 0013 migration
 * seeds the same data at deploy; this is the belt-and-suspenders equivalent for any row
 * the migration didn't cover, and keeps the seeding logic in one place — syncMarkTitles.)
 */
export async function backfillMarkTitles(): Promise<void> {
  const db = getDb()
  const [marker] = await db.select().from(serverConfig).where(eq(serverConfig.key, MARKER_KEY))
  if (marker) return

  let updated = 0
  let lastId: string | null = null
  for (;;) {
    const rows = await db
      .select({ id: catalogMetadata.id, itemUrl: catalogMetadata.itemUrl })
      .from(catalogMetadata)
      .where(lastId ? gt(catalogMetadata.id, lastId) : undefined)
      .orderBy(asc(catalogMetadata.id))
      .limit(BATCH_SIZE)
    if (rows.length === 0) break
    lastId = rows[rows.length - 1].id

    for (const row of rows) {
      await syncMarkTitles(row.itemUrl)
      updated++
    }
  }

  await db
    .insert(serverConfig)
    .values({ key: MARKER_KEY, value: new Date().toISOString() })
    .onConflictDoNothing()
  logger.info({ processed: updated }, 'Mark-titles backfill complete')
}
