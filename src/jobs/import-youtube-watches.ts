import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { youtubeWatches } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { type WatchRow } from '../lib/parse-youtube-takeout.js'

/**
 * Insert parsed watch rows, idempotently.
 *
 * Mirrors importTrainTrips: dedupe within the file first, then a batched insert with
 * ON CONFLICT DO NOTHING against the natural key. Re-running over an overlapping file is
 * safe by construction, and the second run of the same file inserts zero.
 *
 * Nothing is ever updated. A second sighting of the same (account, video, minute) is the
 * same watch event seen twice, not a correction — the same argument importTrainTrips and
 * the LinkedIn importer make for their own stores.
 */

/** Rows per INSERT. The archive is ~96k rows; one statement per 1,000 keeps it modest. */
const DEFAULT_BATCH_SIZE = 1000

export interface WatchImportResult {
  /** Rows handed in. */
  total: number
  /** Dropped before the insert because the file repeated a natural key. */
  duplicatesInFile: number
  /** Rows the database actually accepted. */
  inserted: number
  /** Rows the database already had. */
  skipped: number
}

export interface ImportOptions {
  batchSize?: number
}

export async function importYoutubeWatches(
  rows: WatchRow[],
  opts: ImportOptions = {},
): Promise<WatchImportResult> {
  const total = rows.length
  if (total === 0) return { total: 0, duplicatesInFile: 0, inserted: 0, skipped: 0 }

  // Drop in-file duplicates so no single INSERT carries a repeated conflict target —
  // Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a second time" (and
  // for DO NOTHING, the row is simply ambiguous) when one statement hits the same target
  // twice. importTrainTrips does this for the same reason.
  const seen = new Set<string>()
  const unique = rows.filter((r) => (seen.has(r.dedupeKey) ? false : (seen.add(r.dedupeKey), true)))
  const duplicatesInFile = total - unique.length

  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE)
  const db = getDb()
  let inserted = 0

  for (let i = 0; i < unique.length; i += batchSize) {
    const chunk = unique.slice(i, i + batchSize)
    const values = chunk.map((r) => ({
      account: r.account,
      videoId: r.videoId,
      videoUrl: r.videoUrl,
      // The wall clock goes in verbatim, and the instant is derived from it BY POSTGRES,
      // naming the zone explicitly — the container's session TimeZone is UTC, so an
      // unqualified cast here would silently store the wrong instant. Same shape as
      // importTrainTrips' departure_local / departure_at pair. See ADR 0047.
      watchedAtLocal: sql`${r.watchedAtLocal}::timestamp`,
      watchedAt: sql`(${r.watchedAtLocal}::timestamp AT TIME ZONE 'Europe/Oslo')`,
      title: r.title,
      channelName: r.channelName,
      channelId: r.channelId,
      durationSeconds: r.durationSeconds,
      unresolved: r.unresolved,
      source: r.source,
      raw: r.raw,
    }))

    // .returning() is what makes "inserted" honest: onConflictDoNothing reports nothing
    // about how many rows it skipped, so the accepted ids are the only true count.
    const accepted = await db
      .insert(youtubeWatches)
      .values(values as never)
      .onConflictDoNothing({
        target: [youtubeWatches.account, youtubeWatches.videoId, youtubeWatches.watchedAtLocal],
      })
      .returning({ id: youtubeWatches.id })
    inserted += accepted.length
  }

  const result = { total, duplicatesInFile, inserted, skipped: unique.length - inserted }
  logger.info({ ...result }, 'YouTube watch import complete')
  return result
}
