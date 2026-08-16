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
  /** Rows the database REFUSED, isolated to the individual row. Never silently dropped. */
  failed: RowFailure[]
}

/** A row the database would not take, identified well enough to find in the source. */
export interface RowFailure {
  /** Position among the de-duplicated rows, so it can be located in the input. */
  index: number
  account: string
  videoId: string
  watchedAtLocal: string
  /** The database's own complaint, first line only — the rest is the query text. */
  reason: string
}

export interface ImportOptions {
  batchSize?: number
}

/**
 * The database's actual complaint, without the query dump.
 *
 * Drizzle wraps the driver error in a DrizzleQueryError whose own `message` is the entire
 * failed statement — for a 1,000-row insert, thousands of placeholders around no
 * explanation at all. The useful sentence ("invalid byte sequence for encoding UTF8:
 * 0x00") is on the PostgresError underneath, so walk `cause` to the innermost error and
 * report that. Getting this wrong is how a diagnostic ends up naming the query instead of
 * the fault.
 */
export function dbReason(e: unknown): string {
  let inner = e as { message?: string; detail?: string; code?: string; cause?: unknown }
  const seen = new Set<unknown>()
  while (inner?.cause && !seen.has(inner.cause)) {
    seen.add(inner)
    inner = inner.cause as typeof inner
  }
  const head = (inner?.message ?? String(e)).split('\n')[0]!.trim()
  const parts = [head]
  if (inner?.detail) parts.push(inner.detail.split('\n')[0]!.trim())
  if (inner?.code) parts.push(`[${inner.code}]`)
  return parts.join(' ')
}

export async function importYoutubeWatches(
  rows: WatchRow[],
  opts: ImportOptions = {},
): Promise<WatchImportResult> {
  const total = rows.length
  if (total === 0) return { total: 0, duplicatesInFile: 0, inserted: 0, skipped: 0, failed: [] }

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
  const failed: RowFailure[] = []

  const valuesFor = (r: WatchRow) => ({
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
  })

  // .returning() is what makes "inserted" honest: onConflictDoNothing reports nothing
  // about how many rows it skipped, so the accepted ids are the only true count.
  const insertRows = async (batch: WatchRow[]) =>
    (await db
      .insert(youtubeWatches)
      .values(batch.map(valuesFor) as never)
      .onConflictDoNothing({
        target: [youtubeWatches.account, youtubeWatches.videoId, youtubeWatches.watchedAtLocal],
      })
      .returning({ id: youtubeWatches.id })).length

  for (let i = 0; i < unique.length; i += batchSize) {
    const chunk = unique.slice(i, i + batchSize)
    try {
      inserted += await insertRows(chunk)
    } catch (batchError) {
      // One bad row must not cost the other 999, and must not abort a 96k-row import
      // thousands of rows in. A chunk is a single INSERT, so a failure rolled the whole
      // statement back and nothing from it landed — which makes retrying row by row safe,
      // and isolates the offender exactly. We are not inside a transaction, so the
      // connection is still usable after the error.
      //
      // Only the failing chunk pays the per-row cost, and only once.
      logger.warn(
        { batchStart: i, size: chunk.length, reason: dbReason(batchError) },
        'YouTube watch batch rejected; retrying row by row to isolate it',
      )
      for (const [offset, row] of chunk.entries()) {
        try {
          inserted += await insertRows([row])
        } catch (rowError) {
          failed.push({
            index: i + offset,
            account: row.account,
            videoId: row.videoId,
            watchedAtLocal: row.watchedAtLocal,
            reason: dbReason(rowError),
          })
        }
      }
    }
  }

  const result = {
    total,
    duplicatesInFile,
    inserted,
    skipped: unique.length - inserted - failed.length,
    failed,
  }
  logger.info({ ...result, failed: failed.length }, 'YouTube watch import complete')
  return result
}
