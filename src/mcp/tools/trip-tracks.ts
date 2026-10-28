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
  with_geometry: z.boolean().default(true)
    .describe('false returns properties only, with null geometry: a cheap way to list what has a route'),
  limit: z.number().int().min(1).max(200).default(20),
  page: z.number().int().min(1).default(1),
})

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
      tt.point_count, tt.segment_count, ${geometry} AS segments,
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
        status: r.status ?? null,
        departure_at: r.departure_at ?? null,
        arrival_at: r.arrival_at ?? null,
      },
    })),
  }
}
