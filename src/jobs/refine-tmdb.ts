import { getDb } from '../db/client.js'
import { catalogMetadata } from '../db/schema.js'
import { config } from '../config.js'
import { eq, sql } from 'drizzle-orm'
import { logger } from '../lib/logger.js'
import type { NeodbItemMetadata } from '../lib/fetch-neodb-item.js'
import { refineWithTmdb, tmdbTargetOf, TMDB_MAX_ATTEMPTS, type TmdbFetch, type TmdbOutcome } from '../lib/tmdb-refine.js'

/**
 * True when the TMDB refiner owes this stored row English metadata: the refiner is on,
 * the row has a TMDB link naming its own kind, it has not been refined since its last
 * NeoDB pass, and it has attempts left. A 404 spends them all at once.
 */
export function tmdbOwed(r: {
  itemUrl: string; category: string | null; itemType: string | null
  tmdbUrl: string | null; imdb: string | null
  tmdbRefinedAt: Date | null; tmdbAttempts: number
}, enabled = Boolean(config.TMDB_API_TOKEN)): boolean {
  if (!enabled || r.tmdbRefinedAt) return false
  if (r.tmdbAttempts >= TMDB_MAX_ATTEMPTS) return false
  return tmdbTargetOf(r) != null
}

/** Chinese, Japanese or Korean script anywhere in the string. */
export function hasCjk(v: string | null | undefined): boolean {
  return typeof v === 'string' && /[぀-ヿ㐀-䶿一-鿿가-힯]/.test(v)
}

type CatalogRow = typeof catalogMetadata.$inferSelect

const arr = (v: unknown): string[] | null => (Array.isArray(v) ? (v as string[]) : null)
const objOf = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {}

/** A stored row in the shape the refiner works on. */
export function storedToMeta(r: CatalogRow): NeodbItemMetadata {
  return {
    itemUrl: r.itemUrl, category: r.category, itemType: r.itemType,
    title: r.title, displayTitle: r.displayTitle, origTitle: r.origTitle,
    description: r.description, coverUrl: r.coverUrl, year: r.year,
    genre: arr(r.genre), language: arr(r.language), area: arr(r.area),
    rating: r.rating != null ? Number(r.rating) : null,
    externalResources: (Array.isArray(r.externalResources) ? r.externalResources : null) as { url: string }[] | null,
    imdb: r.imdb, imdbUrl: r.imdbUrl, tmdbUrl: r.tmdbUrl,
    seasonNumber: r.seasonNumber, episodeCount: r.episodeCount,
    director: arr(r.director), actors: arr(r.actors), parentUuid: r.parentUuid,
    details: objOf(r.details), isbn: null, bookwyrmBookUrl: r.bookwyrmBookUrl,
    sourceMap: objOf(r.sourceMap) as Record<string, string>,
    titlePlaceholder: false, raw: r.raw,
  }
}

/**
 * Lay TMDB's English metadata over one stored row, without asking NeoDB again (ADR 0077).
 * The row already holds everything the refiner reads (its TMDB link and kind) and every
 * field it falls back to. Re-fetching NeoDB first cost a request per item to an instance
 * that may no longer have it: minreol.dk answers 404 for every item since the move.
 *
 * Only the fields the refiner owns and its bookkeeping are written. The next NeoDB pass
 * restores NeoDB's values and refines again inside `enrichOne`, as before.
 */
export async function refineStoredItem(row: CatalogRow, fetcher?: TmdbFetch | null): Promise<TmdbOutcome> {
  const meta = storedToMeta(row)
  const tmdb = await refineWithTmdb(meta, fetcher === undefined ? undefined : fetcher)
  const db = getDb()
  const where = eq(catalogMetadata.itemUrl, row.itemUrl)
  if (tmdb.status === 'refined') {
    await db.update(catalogMetadata).set({
      title: meta.title,
      displayTitle: meta.displayTitle,
      origTitle: meta.origTitle,
      year: meta.year,
      description: meta.description,
      genre: meta.genre as unknown as Record<string, unknown>,
      director: meta.director as unknown as Record<string, unknown>,
      actors: meta.actors as unknown as Record<string, unknown>,
      details: meta.details,
      seasonNumber: meta.seasonNumber,
      episodeCount: meta.episodeCount,
      sourceMap: meta.sourceMap,
      tmdbRefinedAt: new Date(),
      tmdbError: null,
      tmdbAttempts: 0,
      tmdbRaw: tmdb.raw as Record<string, unknown>,
    }).where(where)
  } else if (tmdb.status === 'failed') {
    await db.update(catalogMetadata).set({
      tmdbError: tmdb.error,
      tmdbAttempts: tmdb.retry ? sql`${catalogMetadata.tmdbAttempts} + 1` : TMDB_MAX_ATTEMPTS,
    }).where(where)
    logger.warn({ itemUrl: row.itemUrl, error: tmdb.error, retry: tmdb.retry }, 'TMDB refinement failed (non-fatal)')
  }
  return tmdb
}

export interface TmdbRefineResult {
  enabled: boolean
  owed: number
  refined: number
  failed: number
  dry_run: boolean
}

const DELAY_MS = 250

/**
 * Refine stored film and TV rows TMDB still owes English metadata (ADR 0076), from the
 * stored row (ADR 0077): TMDB is the only host asked. Rows still carrying CJK text (the
 * neodb.social ones) go first. Run at the end of every NeoDB sync pass with a limit, and
 * whole by `npm run refine-tmdb`.
 *
 * Safe to re-run: a refined row is no longer owed, and a row that keeps failing stops
 * being owed after TMDB_MAX_ATTEMPTS.
 *
 *   npm run refine-tmdb
 *   DRY_RUN=1 npm run refine-tmdb   # count only
 */
export async function refineOwedItems(opts: { dryRun?: boolean; limit?: number } = {}): Promise<TmdbRefineResult> {
  const enabled = Boolean(config.TMDB_API_TOKEN)
  const result: TmdbRefineResult = { enabled, owed: 0, refined: 0, failed: 0, dry_run: Boolean(opts.dryRun) }
  if (!enabled) return result

  const rows = await getDb().select().from(catalogMetadata)
  const owed = rows
    .filter((r) => r.enrichedAt != null && tmdbOwed(r, enabled))
    .sort((a, b) => Number(hasCjk(b.description) || hasCjk(b.title)) - Number(hasCjk(a.description) || hasCjk(a.title)))
  result.owed = owed.length
  if (opts.dryRun) return result

  for (const r of owed.slice(0, opts.limit ?? Infinity)) {
    const out = await refineStoredItem(r)
    if (out.status === 'refined') result.refined++
    else if (out.status === 'failed') result.failed++
    await new Promise((res) => setTimeout(res, DELAY_MS))
  }
  return result
}
