import { getDb } from '../db/client.js'
import { catalogMetadata } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { assignWorkKeys } from '../lib/work-key.js'
import { logger } from '../lib/logger.js'

export interface WorkKeyBackfillResult {
  rows: number
  works: number
  /** Works with more than one row: the duplicates this folds together. */
  merged_works: number
  /** Rows whose key changed on this run. Zero on a second run. */
  updated: number
  dry_run: boolean
}

/**
 * Group every catalogue row into works and write each row's `work_key` (ADR 0075).
 *
 * The whole table is read and grouped at once, because a merge can need a row that
 * arrived years apart from its twin, and a row that bridges two works (its TMDB link
 * matches one, its IMDb id the other) can only be seen from the full set. The grouping
 * is deterministic for a given set of rows, so a second run writes nothing.
 *
 *   npm run backfill-work-keys
 *   DRY_RUN=1 npm run backfill-work-keys   # count only, change nothing
 */
export async function backfillWorkKeys(opts: { dryRun?: boolean } = {}): Promise<WorkKeyBackfillResult> {
  const db = getDb()
  const rows = await db
    .select({
      itemUrl: catalogMetadata.itemUrl,
      category: catalogMetadata.category,
      itemType: catalogMetadata.itemType,
      tmdbUrl: catalogMetadata.tmdbUrl,
      imdb: catalogMetadata.imdb,
      workKey: catalogMetadata.workKey,
    })
    .from(catalogMetadata)

  const assigned = assignWorkKeys(rows)
  const sizes = new Map<string, number>()
  for (const key of assigned.values()) sizes.set(key, (sizes.get(key) ?? 0) + 1)

  const changes = rows.filter((r) => assigned.get(r.itemUrl) !== r.workKey)
  if (!opts.dryRun) {
    for (const r of changes) {
      await db
        .update(catalogMetadata)
        .set({ workKey: assigned.get(r.itemUrl)! })
        .where(eq(catalogMetadata.itemUrl, r.itemUrl))
    }
  }

  const merged = [...sizes.values()].filter((n) => n > 1).length
  for (const [key, n] of sizes) {
    if (n > 1) logger.debug({ workKey: key, rows: n }, 'Catalogue rows share one work')
  }
  return {
    rows: rows.length,
    works: sizes.size,
    merged_works: merged,
    updated: changes.length,
    dry_run: Boolean(opts.dryRun),
  }
}
