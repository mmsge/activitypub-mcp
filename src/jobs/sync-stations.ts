import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { logger } from '../lib/logger.js'
import { geocodeStation, timezoneForCountry, type GeocodeHit } from '../lib/geocode-station.js'

/**
 * Give every station in the trip history a coordinate.
 *
 * Two steps, both idempotent: register any station name not seen before, then
 * geocode a bounded number of the ones still missing coordinates.
 *
 * Bounded on purpose. Nominatim's usage policy is one request a second from an
 * identified client, and the 115 stations are a one-off backfill with no deadline
 * — so this takes a small bite per run and is finished within a few hours of
 * scheduler ticks rather than making 115 requests in two minutes.
 */

/** Stations geocoded per run. 115 stations ⇒ finished in ~6 runs. */
const PER_RUN = 20

/** Nominatim asks for ≤1 request/second; a little over is the polite reading. */
const SPACING_MS = 1_100

/** After this many failures a name is left alone until someone looks at it. */
const MAX_ATTEMPTS = 3

export interface SyncStationsResult {
  /** Station names registered for the first time. */
  registered: number
  /** Stations that gained coordinates this run. */
  geocoded: number
  /** Lookups that came back with nothing usable. */
  missed: number
  /** Stations still without coordinates and still worth retrying. */
  pending: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The zone the trips recorded for station `s`, as a correlated subquery. Where the
 * two ends of the legs disagree, the most common one wins, then the alphabetically
 * first for stability.
 *
 * This is Viaduct's zone, which is an offset rule and not a place (ADR 0065): the
 * geocoder uses it only to refuse hits whose clock is wrong.
 */
export const LEG_ZONE = sql`(
  SELECT tz FROM (
    SELECT from_tz AS tz FROM train_trips WHERE from_station = s.name AND from_tz IS NOT NULL
    UNION ALL
    SELECT to_tz AS tz FROM train_trips WHERE to_station = s.name AND to_tz IS NOT NULL
  ) z
  GROUP BY tz
  ORDER BY count(*) DESC, tz ASC
  LIMIT 1
)`

/** Write a geocode hit onto a station, with the zone its country keeps. */
export async function storeHit(stationId: string, hit: GeocodeHit): Promise<void> {
  await getDb().execute(sql`
    UPDATE stations
    SET latitude = ${hit.latitude}, longitude = ${hit.longitude},
        display_name = ${hit.displayName}, country_code = ${hit.countryCode},
        timezone = ${timezoneForCountry(hit.countryCode)},
        geocoded_at = now(), last_attempt_at = now(),
        attempts = attempts + 1, updated_at = now()
    WHERE id = ${stationId}`)
}

export async function syncStations(): Promise<SyncStationsResult> {
  const db = getDb()

  // Every distinct station name across both ends of every trip. A station that
  // appears as both an origin and a destination yields one row.
  const registered = await db.execute(sql`
    INSERT INTO stations (name, country_code)
    SELECT s.name, NULL
    FROM (
      SELECT from_station AS name FROM train_trips WHERE from_station <> ''
      UNION
      SELECT to_station AS name FROM train_trips WHERE to_station <> ''
    ) s
    ON CONFLICT (name) DO NOTHING
    RETURNING id`)

  const pendingRows = (await db.execute(sql`
    SELECT s.id::text AS id, s.name, ${LEG_ZONE} AS timezone
    FROM stations s
    WHERE s.latitude IS NULL
      AND s.source <> 'manual'
      AND s.attempts < ${MAX_ATTEMPTS}
    ORDER BY s.attempts ASC, s.name ASC
    LIMIT ${PER_RUN}`)) as unknown as Array<{ id: string; name: string; timezone: string | null }>

  let geocoded = 0
  let missed = 0

  for (const [i, station] of pendingRows.entries()) {
    // Spacing between requests, not around them: the first needs no wait.
    if (i > 0) await sleep(SPACING_MS)

    const hit = await geocodeStation(station.name, station.timezone)
    if (hit) {
      await storeHit(station.id, hit)
      geocoded++
    } else {
      await db.execute(sql`
        UPDATE stations
        SET last_attempt_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id = ${station.id}`)
      missed++
    }
  }

  const [counts] = (await db.execute(sql`
    SELECT count(*)::int AS pending FROM stations
    WHERE latitude IS NULL AND source <> 'manual' AND attempts < ${MAX_ATTEMPTS}`)) as unknown as
      Array<{ pending: number }>

  const result: SyncStationsResult = {
    registered: (registered as unknown as unknown[]).length,
    geocoded,
    missed,
    pending: counts?.pending ?? 0,
  }
  logger.info(result, 'Stations synced')
  return result
}
