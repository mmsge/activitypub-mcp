import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { logger } from '../lib/logger.js'
import { haversineKm, excessKm, IMPLAUSIBLE_EXCESS_KM } from '../lib/geo-distance.js'

/**
 * Check every geocoded station against the trips that pass through it.
 *
 * Nominatim answers a station name with confidence whether or not it found the
 * right place. Nothing in the response says "this is a ridge above Nice, not a
 * suburb of Bergen" — so the archive checks the work itself, using the one thing
 * it already knows about every leg: how far it was.
 *
 * A straight line cannot be longer than the distance travelled along it. Where it
 * appears to be, one of the two endpoints is wrong. The worst such excess is
 * written to each station so a bad placement is a number rather than something
 * you would only notice by reading a weather report for the wrong country.
 *
 * This flags, it does not fix. Which of the two stations on an implausible leg is
 * the wrong one cannot be told from the leg alone — a station that appears on
 * several legs and disagrees with all of them is the obvious suspect, and that is
 * what a human reading the list will see. The correction is
 * `source = 'manual'`, which the geocoder then never overwrites.
 */

export interface CheckStationGeocodesResult {
  /** Legs with both endpoints geocoded and a recorded distance. */
  legsChecked: number
  /** Stations that got a score. */
  stationsScored: number
  /** Stations whose worst leg exceeds the tolerance — these want a human. */
  suspect: number
  /** The worst offenders, for the log. */
  worst: Array<{ name: string; errorKm: number; matched: string | null }>
}

export async function checkStationGeocodes(): Promise<CheckStationGeocodesResult> {
  const db = getDb()

  const legs = (await db.execute(sql`
    SELECT
      f.id::text AS from_id, f.latitude::float8 AS from_lat, f.longitude::float8 AS from_lon,
      t2.id::text AS to_id, t2.latitude::float8 AS to_lat, t2.longitude::float8 AS to_lon,
      t.distance_km::float8 AS recorded_km
    FROM train_trips t
    JOIN stations f ON f.name = t.from_station
    JOIN stations t2 ON t2.name = t.to_station
    WHERE t.distance_km IS NOT NULL AND t.distance_km > 0
      AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL
      AND t2.latitude IS NOT NULL AND t2.longitude IS NOT NULL
      -- A circular leg has no straight line to compare against.
      AND f.id <> t2.id`)) as unknown as Array<{
        from_id: string; from_lat: number; from_lon: number
        to_id: string; to_lat: number; to_lon: number; recorded_km: number
      }>

  // Worst excess per station. Both endpoints of an implausible leg carry the
  // score: the leg says one of them is wrong without saying which.
  const worstByStation = new Map<string, number>()
  for (const l of legs) {
    const straight = haversineKm(l.from_lat, l.from_lon, l.to_lat, l.to_lon)
    const excess = excessKm(straight, l.recorded_km)
    for (const id of [l.from_id, l.to_id]) {
      const prev = worstByStation.get(id)
      if (prev === undefined || excess > prev) worstByStation.set(id, excess)
    }
  }

  for (const [id, error] of worstByStation) {
    await db.execute(sql`
      UPDATE stations
      SET geocode_error_km = ${error}, geocode_checked_at = now(), updated_at = now()
      WHERE id = ${id}::uuid`)
  }

  const worst = (await db.execute(sql`
    SELECT name, geocode_error_km::float8 AS error_km, display_name
    FROM stations
    WHERE geocode_error_km > ${IMPLAUSIBLE_EXCESS_KM}
    ORDER BY geocode_error_km DESC
    LIMIT 20`)) as unknown as Array<{
      name: string; error_km: number; display_name: string | null
    }>

  const result: CheckStationGeocodesResult = {
    legsChecked: legs.length,
    stationsScored: worstByStation.size,
    suspect: worst.length,
    worst: worst.map((w) => ({
      name: w.name,
      errorKm: Math.round(w.error_km),
      matched: w.display_name,
    })),
  }

  if (result.suspect > 0) {
    logger.warn(result, 'Stations whose coordinates disagree with the distances travelled')
  } else {
    logger.info(
      { legsChecked: result.legsChecked, stationsScored: result.stationsScored },
      'Station geocodes checked; all plausible',
    )
  }
  return result
}
