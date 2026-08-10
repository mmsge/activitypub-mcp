import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { logger } from '../lib/logger.js'

/**
 * Clear the coordinates a bad country hint produced, so they are looked up again.
 *
 * ADR 0028 biased every lookup by the country the trip's timezone implied. That
 * premise was wrong — viaduct.world records the UTC offset zone, so Norway reads
 * as `Europe/Paris` — and the bias did not fail loudly: it made wrong searches
 * *succeed*. Six stations were placed in France, and their weather was fetched
 * from there. See ADR 0035.
 *
 * Nothing distinguishes a station geocoded under the old rule from one geocoded
 * under the new one, so this clears them all and lets the corrected geocoder redo
 * the work. Two things are deliberately preserved:
 *
 *  - **Manual rows are untouched.** `source = 'manual'` is the escape hatch for a
 *    placement a human fixed by hand; re-deriving over it would undo exactly the
 *    corrections this exists to make possible.
 *  - **Weather for cleared stations is deleted**, because it was measured at the
 *    wrong place. Keeping it would leave the Riviera's rain filed under Arna, and
 *    the weather job only fetches what is missing — so a stale row would never be
 *    revisited.
 */

export interface ResetGeocodesResult {
  /** Stations whose coordinates were cleared. */
  cleared: number
  /** Weather rows deleted because they were measured at the wrong place. */
  weatherDropped: number
  /** Hand-corrected stations left alone. */
  manualKept: number
}

export async function resetGeocodes(): Promise<ResetGeocodesResult> {
  const db = getDb()

  const dropped = await db.execute(sql`
    DELETE FROM station_weather sw
    USING stations s
    WHERE s.id = sw.station_id AND s.source <> 'manual' AND s.latitude IS NOT NULL
    RETURNING sw.id`)

  const cleared = await db.execute(sql`
    UPDATE stations
    SET latitude = NULL, longitude = NULL, display_name = NULL, country_code = NULL,
        geocoded_at = NULL, geocode_error_km = NULL, geocode_checked_at = NULL,
        attempts = 0, last_attempt_at = NULL, updated_at = now()
    WHERE source <> 'manual' AND latitude IS NOT NULL
    RETURNING id`)

  const [manual] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM stations WHERE source = 'manual'`)) as unknown as
      Array<{ n: number }>

  const result: ResetGeocodesResult = {
    cleared: (cleared as unknown as unknown[]).length,
    weatherDropped: (dropped as unknown as unknown[]).length,
    manualKept: manual?.n ?? 0,
  }
  logger.warn(result, 'Station geocodes cleared for re-lookup')
  return result
}
