import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { distanceKm } from '../../lib/geo-distance.js'

/**
 * Where viaduct.world and the geocoder disagree about a station. See ADR 0072.
 *
 * Every station a trip names is compared with viaduct's own waypoint of the same name
 * (ADR 0070). Two waypoints for one name is normal (Milano Centrale, metres apart), so the
 * nearest one is the comparison: if either agrees, the station is fine.
 *
 * Read-only. Fixing a row is the admin's pin, which writes `source = 'manual'` so neither
 * the scheduler nor `regeocode-stations` moves it back (ADR 0065).
 */

export const DEFAULT_MIN_KM = 5

export const getStationDiscrepanciesSchema = z.object({
  min_km: z.number().min(0).default(DEFAULT_MIN_KM)
    .describe('Flag a station whose stored position is at least this far from viaduct\'s waypoint. Default 5 km: wrong towns, not wrong platforms.'),
  include_manual: z.boolean().default(true)
    .describe('Include stations pinned by hand (source = manual). They are never re-geocoded, so a manual row that disagrees was either pinned deliberately or pinned wrong.'),
})

export interface Waypoint {
  latitude: number
  longitude: number
}

export interface StoredStation {
  name: string
  latitude: number | null
  longitude: number | null
  display_name: string | null
  country_code: string | null
  source: string
}

export interface StationComparison extends StoredStation {
  viaduct_latitude: number
  viaduct_longitude: number
  /** null when the station has no stored coordinates yet. */
  distance_km: number | null
}

/** The waypoint nearest the stored position, or the first one when there is none. Pure. */
export function compareStation(station: StoredStation, waypoints: readonly Waypoint[]): StationComparison | null {
  if (waypoints.length === 0) return null
  if (station.latitude == null || station.longitude == null) {
    const w = waypoints[0]
    return { ...station, viaduct_latitude: w.latitude, viaduct_longitude: w.longitude, distance_km: null }
  }
  let best: { w: Waypoint; km: number } | null = null
  for (const w of waypoints) {
    const km = distanceKm(station.latitude, station.longitude, w.latitude, w.longitude)
    if (!best || km < best.km) best = { w, km }
  }
  return {
    ...station,
    viaduct_latitude: best!.w.latitude,
    viaduct_longitude: best!.w.longitude,
    distance_km: Math.round(best!.km * 10) / 10,
  }
}

export async function getStationDiscrepancies(input: z.infer<typeof getStationDiscrepanciesSchema>) {
  const db = getDb()
  const stations = (await db.execute(sql`
    SELECT name, latitude::float8 AS latitude, longitude::float8 AS longitude,
           display_name, country_code, source
    FROM stations
    ORDER BY name`)) as unknown as StoredStation[]
  const waypointRows = (await db.execute(sql`
    SELECT name, latitude, longitude FROM viaduct_waypoints`)) as unknown as Array<Waypoint & { name: string }>

  const byName = new Map<string, Waypoint[]>()
  for (const w of waypointRows) {
    const list = byName.get(w.name) ?? []
    list.push({ latitude: Number(w.latitude), longitude: Number(w.longitude) })
    byName.set(w.name, list)
  }

  const disagreeing: StationComparison[] = []
  const notGeocoded: StationComparison[] = []
  const noWaypoint: string[] = []
  let agreeing = 0
  for (const s of stations) {
    if (!input.include_manual && s.source === 'manual') continue
    const c = compareStation(s, byName.get(s.name) ?? [])
    if (!c) noWaypoint.push(s.name)
    else if (c.distance_km == null) notGeocoded.push(c)
    else if (c.distance_km >= input.min_km) disagreeing.push(c)
    else agreeing++
  }
  disagreeing.sort((a, b) => b.distance_km! - a.distance_km!)

  return {
    min_km: input.min_km,
    // Stated up front, so an empty list reads as "no GPX imported" when that is the reason.
    coverage: {
      stations: stations.length,
      viaduct_waypoints: waypointRows.length,
      agreeing,
    },
    disagreeing,
    /** Stations the geocoder never placed, which viaduct has a position for. */
    not_geocoded: notGeocoded,
    /** Stations viaduct has no waypoint for under that exact name. */
    no_waypoint: noWaypoint,
  }
}
