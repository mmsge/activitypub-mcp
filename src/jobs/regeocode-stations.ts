import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { logger } from '../lib/logger.js'
import { COUNTRY_ZONES, geocodeStation, type GeocodeHit } from '../lib/geocode-station.js'
import { LEG_ZONE, storeHit } from './sync-stations.js'

/**
 * Geocode stations again that already have coordinates, and say what moved.
 *
 * `syncStations` only ever looks at stations *without* coordinates, so a wrong hit
 * stays wrong forever. This is the repair for the hits the old timezone-as-country
 * filter got wrong (ADR 0065): Bergen in Picardy, Oslo S in Strasbourg. It is a
 * one-off you run by hand, not a scheduled job.
 *
 * - `source = 'manual'` rows are never touched. Pinning a row by hand is the
 *   escape hatch for a station Nominatim cannot be talked into; this job only
 *   fills in a missing `timezone` for them, from the country already on the row.
 * - A miss keeps the old coordinates. Wrong-but-present is no worse than before,
 *   and the report names it so it can be pinned.
 * - A station that moves loses its stored weather, so `syncStationWeather` fetches
 *   it again for the new cell. A hit within `SAME_PLACE_KM` keeps it: that is the
 *   same ERA5 cell, and refetching would be traffic for nothing.
 * - `dryRun` makes the same requests and writes nothing.
 */

/** Nominatim asks for ≤1 request/second; a little over is the polite reading. */
const SPACING_MS = 1_100

/** Closer than this, the move is a different platform in the same town (ADR 0028). */
export const SAME_PLACE_KM = 5

export interface RegeocodeOptions {
  /** Look up and report, write nothing. */
  dryRun?: boolean
  /** Only these station names (exact). Empty or absent means every non-manual one. */
  names?: string[]
}

export interface RegeocodeChange {
  name: string
  before: { latitude: number | null; longitude: number | null; countryCode: string | null }
  after: GeocodeHit | null
  /** Great-circle distance moved, or null when either end has no coordinates. */
  movedKm: number | null
}

export interface RegeocodeResult {
  considered: number
  /** Stations whose coordinates moved by at least SAME_PLACE_KM, or gained them. */
  moved: number
  /** Stations that re-geocoded to the same place. */
  unchanged: number
  /** Lookups that found nothing; the old coordinates were kept. */
  missed: number
  /** Manual rows given a timezone from their country. */
  manualZoned: number
  /** station_weather rows dropped so the weather is fetched again at the new place. */
  weatherDropped: number
  changes: RegeocodeChange[]
  dryRun: boolean
}

/** Haversine distance in km. Pure. */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(bLat - aLat)
  const dLon = rad(bLon - aLon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function regeocodeStations(opts: RegeocodeOptions = {}): Promise<RegeocodeResult> {
  const db = getDb()
  const dryRun = opts.dryRun ?? false
  const names = opts.names?.filter(Boolean) ?? []
  const nameFilter = names.length
    ? sql`AND s.name IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`
    : sql``

  const rows = (await db.execute(sql`
    SELECT s.id::text AS id, s.name,
           s.latitude::float8 AS latitude, s.longitude::float8 AS longitude,
           s.country_code, ${LEG_ZONE} AS timezone
    FROM stations s
    WHERE s.source <> 'manual' ${nameFilter}
    ORDER BY s.name ASC`)) as unknown as Array<{
      id: string; name: string; latitude: number | null; longitude: number | null
      country_code: string | null; timezone: string | null
    }>

  const result: RegeocodeResult = {
    considered: rows.length, moved: 0, unchanged: 0, missed: 0,
    manualZoned: 0, weatherDropped: 0, changes: [], dryRun,
  }

  for (const [i, station] of rows.entries()) {
    if (i > 0) await sleep(SPACING_MS)

    const hit = await geocodeStation(station.name, station.timezone)
    const before = { latitude: station.latitude, longitude: station.longitude, countryCode: station.country_code }
    const movedKm = hit && station.latitude != null && station.longitude != null
      ? distanceKm(station.latitude, station.longitude, hit.latitude, hit.longitude)
      : null
    result.changes.push({ name: station.name, before, after: hit, movedKm })

    if (!hit) {
      result.missed++
      continue
    }
    const moved = movedKm === null || movedKm >= SAME_PLACE_KM
    if (moved) result.moved++
    else result.unchanged++
    if (dryRun) continue

    await storeHit(station.id, hit)
    if (moved) {
      const dropped = await db.execute(sql`
        DELETE FROM station_weather WHERE station_id = ${station.id} RETURNING id`)
      result.weatherDropped += (dropped as unknown as unknown[]).length
    }
  }

  // Manual rows keep their coordinates; they only gain the zone their country keeps.
  // The country list is small and fixed, so it goes in as a VALUES table rather than
  // a per-row round trip.
  if (!dryRun) {
    const zoned = await db.execute(sql`
      UPDATE stations s
      SET timezone = z.tz, updated_at = now()
      FROM (VALUES ${sql.join(
        COUNTRY_ZONES.map(([cc, tz]) => sql`(${cc}, ${tz})`),
        sql`, `,
      )}) AS z(cc, tz)
      WHERE s.source = 'manual' AND s.timezone IS NULL AND lower(s.country_code) = z.cc
        ${nameFilter}
      RETURNING s.id`)
    result.manualZoned = (zoned as unknown as unknown[]).length
  }

  logger.info({ ...result, changes: undefined }, 'Stations re-geocoded')
  return result
}
