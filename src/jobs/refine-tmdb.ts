import { getDb } from '../db/client.js'
import { catalogMetadata } from '../db/schema.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { enrichOne, hasCjk, tmdbOwed } from './sync-neodb-metadata.js'

export interface TmdbRefineResult {
  enabled: boolean
  owed: number
  refined: number
  failed: number
  dry_run: boolean
}

const DELAY_MS = 250

/**
 * Refine every stored film and TV item TMDB still owes English metadata (ADR 0076),
 * now rather than 200 a pass. Each item goes through `enrichOne`, the same path the
 * periodic sync takes, so NeoDB is re-read first and TMDB laid over it. Rows still
 * carrying CJK text (the neodb.social ones) go first.
 *
 * Safe to re-run: a refined row is no longer owed, and a row that keeps failing stops
 * being owed after TMDB_MAX_ATTEMPTS.
 *
 *   npm run refine-tmdb
 *   DRY_RUN=1 npm run refine-tmdb   # count only
 */
export async function refineOwedItems(opts: { dryRun?: boolean; limit?: number } = {}): Promise<TmdbRefineResult> {
  const enabled = Boolean(config.TMDB_API_TOKEN)
  const rows = await getDb()
    .select({
      itemUrl: catalogMetadata.itemUrl,
      category: catalogMetadata.category,
      itemType: catalogMetadata.itemType,
      tmdbUrl: catalogMetadata.tmdbUrl,
      imdb: catalogMetadata.imdb,
      tmdbRefinedAt: catalogMetadata.tmdbRefinedAt,
      tmdbAttempts: catalogMetadata.tmdbAttempts,
      title: catalogMetadata.title,
      description: catalogMetadata.description,
    })
    .from(catalogMetadata)

  const owed = rows
    .filter((r) => tmdbOwed(r, enabled))
    .sort((a, b) => Number(hasCjk(b.description) || hasCjk(b.title)) - Number(hasCjk(a.description) || hasCjk(a.title)))
    .slice(0, opts.limit ?? Infinity)

  const result: TmdbRefineResult = { enabled, owed: owed.length, refined: 0, failed: 0, dry_run: Boolean(opts.dryRun) }
  if (!enabled) {
    logger.warn('TMDB_API_TOKEN is blank: the refiner is off and owes nothing. Set it in /srv/bot/.env.')
    return result
  }
  if (opts.dryRun) return result

  for (const r of owed) {
    const meta = await enrichOne(r.itemUrl, { category: r.category, itemType: r.itemType })
    // enrichOne records the outcome on the row; a field marked 'tmdb' is a refinement.
    if (meta && Object.values(meta.sourceMap).includes('tmdb')) result.refined++
    else result.failed++
    await new Promise((res) => setTimeout(res, DELAY_MS))
  }
  return result
}
