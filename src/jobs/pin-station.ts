import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { distanceKm } from '../lib/geo-distance.js'
import { logger } from '../lib/logger.js'
import { SAME_PLACE_KM } from './regeocode-stations.js'

export type PinStationResult =
  | { ok: true; name: string; movedKm: number | null; countryCleared: boolean; weatherDropped: number }
  | { ok: false; reason: string }

/**
 * Pin a station to viaduct.world's waypoint for it. See ADR 0072.
 *
 * The coordinates must be a stored waypoint of exactly that name, so the form can only
 * ever choose between positions viaduct gave, never post an arbitrary one.
 *
 * `source = 'manual'` is the whole point: neither the scheduler nor `regeocode-stations`
 * touches a manual row again (ADR 0065). A move of `SAME_PLACE_KM` or more also clears the
 * country and its zone, which described the place the geocoder wrongly chose, and drops the
 * stored weather so it is fetched again at the new place.
 */
export async function pinStationToWaypoint(name: string, latitude: number, longitude: number): Promise<PinStationResult> {
  const db = getDb()
  const [waypoint] = (await db.execute(sql`
    SELECT 1 AS ok FROM viaduct_waypoints
    WHERE name = ${name} AND latitude = ${latitude} AND longitude = ${longitude}`)) as unknown as { ok: number }[]
  if (!waypoint) return { ok: false, reason: `viaduct has no waypoint named "${name}" at ${latitude}, ${longitude}` }

  const [station] = (await db.execute(sql`
    SELECT id::text AS id, latitude::float8 AS latitude, longitude::float8 AS longitude
    FROM stations WHERE name = ${name}`)) as unknown as { id: string; latitude: number | null; longitude: number | null }[]
  if (!station) return { ok: false, reason: `No trip names a station "${name}"` }

  const movedKm = station.latitude != null && station.longitude != null
    ? Math.round(distanceKm(station.latitude, station.longitude, latitude, longitude) * 10) / 10
    : null
  const elsewhere = movedKm === null || movedKm >= SAME_PLACE_KM

  let weatherDropped = 0
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE stations
      SET latitude = ${latitude}, longitude = ${longitude},
          display_name = 'viaduct.world waypoint',
          source = 'manual',
          country_code = CASE WHEN ${elsewhere} THEN NULL ELSE country_code END,
          timezone = CASE WHEN ${elsewhere} THEN NULL ELSE timezone END,
          geocoded_at = now(), updated_at = now()
      WHERE id = ${station.id}`)
    if (elsewhere) {
      const dropped = await tx.execute(sql`DELETE FROM station_weather WHERE station_id = ${station.id} RETURNING id`)
      weatherDropped = (dropped as unknown as unknown[]).length
    }
  })

  logger.info({ name, latitude, longitude, movedKm, countryCleared: elsewhere, weatherDropped }, 'Station pinned to viaduct waypoint')
  return { ok: true, name, movedKm, countryCleared: elsewhere, weatherDropped }
}
