import { config } from '../config.js'
import { getDb } from '../db/client.js'
import { scrobbles } from '../db/schema.js'
import { fetchRecentScrobbles, type Scrobble } from '../lib/fetch-lastfm.js'
import { logger } from '../lib/logger.js'
import { sql } from 'drizzle-orm'

const PAGE_LIMIT = 200
const PAGE_DELAY_MS = 250
const MAX_PAGES = 5000 // safety bound on full backfill

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function toRows(items: Scrobble[]) {
  return items.map((s) => ({
    trackName: s.trackName,
    artistName: s.artistName,
    artistMbid: s.artistMbid,
    albumName: s.albumName,
    albumMbid: s.albumMbid,
    trackMbid: s.trackMbid,
    trackUrl: s.trackUrl,
    imageUrl: s.imageUrl,
    playedAt: s.playedAt,
    uts: s.uts,
    loved: s.loved,
    raw: s.raw,
  }))
}

/**
 * Ingest the configured Last.fm user's scrobbles into the local DB.
 * First run (empty table) backfills the full history; subsequent runs fetch
 * only scrobbles newer than the latest stored one. Inserts are idempotent via
 * the scrobbles_dedupe_idx unique index, so re-runs never duplicate rows.
 */
export async function syncScrobbles(): Promise<void> {
  const { LASTFM_API_KEY, LASTFM_USERNAME } = config
  if (!LASTFM_API_KEY || !LASTFM_USERNAME) {
    logger.info('LASTFM_API_KEY or LASTFM_USERNAME not set, skipping scrobble sync')
    return
  }

  const db = getDb()

  const [{ max }] = await db
    .select({ max: sql<number | null>`max(${scrobbles.uts})` })
    .from(scrobbles)
  const cursor = max != null ? Number(max) : null
  // Incremental syncs fetch strictly-newer scrobbles; full backfill omits `from`.
  const from = cursor != null ? cursor + 1 : undefined

  logger.info(
    { username: LASTFM_USERNAME, mode: cursor != null ? 'incremental' : 'backfill', from },
    'Starting scrobble sync',
  )

  let page = 1
  let totalPages = 1
  let fetched = 0
  let inserted = 0

  do {
    const result = await fetchRecentScrobbles(LASTFM_API_KEY, LASTFM_USERNAME, {
      from,
      page,
      limit: PAGE_LIMIT,
    })
    totalPages = result.totalPages || 1

    if (result.scrobbles.length > 0) {
      fetched += result.scrobbles.length
      const insertedRows = await db
        .insert(scrobbles)
        .values(toRows(result.scrobbles))
        .onConflictDoNothing()
        .returning({ id: scrobbles.id })
      inserted += insertedRows.length
    }

    if (page < totalPages && page < MAX_PAGES) await sleep(PAGE_DELAY_MS)
    page++
  } while (page <= totalPages && page <= MAX_PAGES)

  logger.info(
    { fetched, inserted, skipped: fetched - inserted, pages: Math.min(totalPages, MAX_PAGES) },
    'Scrobble sync complete',
  )
}
