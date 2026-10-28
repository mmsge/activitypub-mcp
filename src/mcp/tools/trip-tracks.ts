import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { tripTrackMatchSql } from '../../jobs/import-trip-tracks.js'

/**
 * The line each train trip drew on the map, from viaduct.world's GPX export, as GeoJSON.
 * See ADR 0070.
 *
 * One Feature per leg, a MultiLineString because viaduct exports each leg in pieces and
 * not in travel order. Properties carry the joined CSV trip where there is one; a track
 * with no trip to join keeps its trip fields null rather than being dropped, so the map
 * and the trip list can be told apart.
 */

export const getTripTracksSchema = z.object({
  trip_id: z.string().uuid().optional()
    .describe('A train trip id (from get_train_trips); returns that trip\'s route'),
  viaduct_trip_id: z.string().optional()
    .describe('viaduct.world\'s own trip number, as in the GPX desc'),
  journey: z.string().optional()
    .describe('Filter by journey/trip name (case-insensitive, partial match), e.g. "interrail"'),
  station: z.string().optional()
    .describe('Filter to legs where this is the origin or destination (case-insensitive, partial)'),
  year: z.number().int().optional().describe('Filter to legs departing in this calendar year (local)'),
  matched: z.boolean().optional()
    .describe('true: only tracks joined to a stored trip. false: only tracks with no trip to join'),
  near_lat: z.number().min(-90).max(90).optional()
    .describe('With near_lon: only legs whose route passes within near_km of this point'),
  near_lon: z.number().min(-180).max(180).optional()
    .describe('With near_lat: only legs whose route passes within near_km of this point'),
  near_km: z.number().gt(0).max(200).default(5)
    .describe('Radius for near_lat/near_lon, in km (default 5). Route points are about 0.7 km apart, so below ~1 km a leg can slip between two of them.'),
  with_geometry: z.boolean().default(true)
    .describe('false returns properties only, with null geometry: a cheap way to list what has a route'),
  limit: z.number().int().min(1).max(200).default(20),
  page: z.number().int().min(1).default(1),
}).refine((v) => (v.near_lat == null) === (v.near_lon == null), {
  message: 'near_lat and near_lon go together',
  path: ['near_lat'],
})

/** Great-circle km between two points, in SQL; the same formula as `distanceKm`. */
export function haversineKmSql(lat1: SQL, lon1: SQL, lat2: SQL, lon2: SQL): SQL {
  return sql`(2 * 6371 * asin(least(1, sqrt(
    power(sin(radians(${lat2} - ${lat1}) / 2), 2)
    + cos(radians(${lat1})) * cos(radians(${lat2})) * power(sin(radians(${lon2} - ${lon1}) / 2), 2)
  ))))`
}

/**
 * The closest any point of the route comes to (lat, lon), restricted first to a bounding
 * box around it so the haversine only runs on the handful of points that could qualify.
 * NULL when no point is inside the box. Points, not the lines between them: at ~0.7 km
 * spacing that is accurate to well under the 5 km default.
 */
export function closestApproachSql(lat: number, lon: number, km: number): SQL {
  const dLat = km / 111.0
  // Widen the longitude band towards the poles; capped so a point near one never divides by ~0.
  const dLon = km / (111.0 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01))
  const pLat = sql`(p.pt->>1)::float8`
  const pLon = sql`(p.pt->>0)::float8`
  return sql`(
    SELECT min(${haversineKmSql(sql`${lat}::float8`, sql`${lon}::float8`, pLat, pLon)})
    FROM jsonb_array_elements(tt.segments) AS s(seg), jsonb_array_elements(s.seg) AS p(pt)
    WHERE ${pLat} BETWEEN ${lat - dLat} AND ${lat + dLat}
      AND ${pLon} BETWEEN ${lon - dLon} AND ${lon + dLon}
  )`
}

const num = (v: unknown): number | null => (v == null ? null : Number(v))

export async function getTripTracks(input: z.infer<typeof getTripTracksSchema>) {
  const db = getDb()
  const conds: SQL[] = []

  if (input.trip_id) conds.push(sql`t.id = ${input.trip_id}`)
  if (input.viaduct_trip_id) conds.push(sql`tt.viaduct_trip_id = ${input.viaduct_trip_id}`)
  if (input.journey) conds.push(sql`t.journey ILIKE ${`%${input.journey}%`}`)
  if (input.station) {
    conds.push(sql`(tt.from_station ILIKE ${`%${input.station}%`} OR tt.to_station ILIKE ${`%${input.station}%`})`)
  }
  // On the local wall clock, which is what the GPX carries and what a year means to him.
  if (input.year != null) {
    conds.push(sql`tt.departure_local >= ${`${input.year}-01-01`}::timestamp`)
    conds.push(sql`tt.departure_local < ${`${input.year + 1}-01-01`}::timestamp`)
  }
  // The MCP server hands the handler its raw shape, so the pair is checked here as well.
  if ((input.near_lat == null) !== (input.near_lon == null)) {
    return { error: 'near_lat and near_lon go together' }
  }
  const near = input.near_lat != null && input.near_lon != null
    ? closestApproachSql(input.near_lat, input.near_lon, input.near_km)
    : null
  if (near) conds.push(sql`${near} <= ${input.near_km}`)
  if (input.matched === true) conds.push(sql`t.id IS NOT NULL`)
  if (input.matched === false) conds.push(sql`t.id IS NULL`)

  const where = conds.length > 0 ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``
  const geometry = input.with_geometry ? sql`tt.segments` : sql`NULL::jsonb`
  const offset = (input.page - 1) * input.limit

  // LATERAL … LIMIT 1 so a trip stored twice under one identity (two zones spelling one
  // wall clock) cannot duplicate its track.
  const rows = (await db.execute(sql`
    SELECT
      tt.viaduct_trip_id, tt.from_station, tt.to_station,
      tt.departure_local::text AS departure_local,
      tt.point_count, tt.segment_count, tt.measured_km, ${geometry} AS segments,
      ${near ?? sql`NULL::float8`} AS closest_km,
      t.id AS trip_id, t.journey, t.operator, t.train_code, t.mode,
      t.distance_km, t.status, t.departure_at, t.arrival_at
    FROM trip_tracks tt
    LEFT JOIN LATERAL (
      SELECT * FROM train_trips t WHERE ${tripTrackMatchSql('tt', 't')} LIMIT 1
    ) t ON true
    ${where}
    ORDER BY tt.departure_local ASC, tt.viaduct_trip_id
    LIMIT ${input.limit} OFFSET ${offset}`)) as unknown as Array<Record<string, unknown>>

  const [coverage] = (await db.execute(sql`
    SELECT
      count(*)::int AS tracks,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM train_trips t WHERE ${tripTrackMatchSql('tt', 't')}))::int AS matched
    FROM trip_tracks tt`)) as unknown as Array<{ tracks: number; matched: number }>

  return {
    type: 'FeatureCollection' as const,
    count: rows.length,
    page: input.page,
    // Stated up front so an empty answer reads as "no GPX imported" rather than "no trip".
    coverage: {
      tracks: coverage?.tracks ?? 0,
      matched_to_trips: coverage?.matched ?? 0,
    },
    features: rows.map((r) => ({
      type: 'Feature' as const,
      geometry: r.segments == null ? null : { type: 'MultiLineString' as const, coordinates: r.segments },
      properties: {
        viaduct_trip_id: r.viaduct_trip_id,
        from: r.from_station,
        to: r.to_station,
        departure_local: r.departure_local,
        point_count: num(r.point_count),
        segment_count: num(r.segment_count),
        trip_id: r.trip_id ?? null,
        journey: r.journey ?? null,
        operator: r.operator ?? null,
        train_code: r.train_code ?? null,
        mode: r.mode ?? null,
        distance_km: num(r.distance_km),
        /** The drawn route's length; compare with distance_km, never a replacement for it. */
        measured_km: num(r.measured_km),
        /** Only with near_lat/near_lon: how close the route comes to that point, in km. */
        ...(near ? { closest_km: r.closest_km == null ? null : Math.round(Number(r.closest_km) * 10) / 10 } : {}),
        status: r.status ?? null,
        departure_at: r.departure_at ?? null,
        arrival_at: r.arrival_at ?? null,
      },
    })),
  }
}
