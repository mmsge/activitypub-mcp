import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { weatherLabel } from '../../lib/weather-code.js'

/**
 * The weather Markus travelled through.
 *
 * Each trip joined to the conditions at its origin on the departure date and at
 * its destination on the arrival date — both local calendar days, so a night train
 * reports the morning it arrived rather than the evening it left.
 *
 * Weather is null wherever the station has not been geocoded, the date is still
 * inside the ERA5 archive's lag, or the archive simply has no value. That is a
 * gap, not a zero, and the tool says so rather than filling it in.
 */

export const getTripWeatherSchema = z.object({
  journey: z.string().optional()
    .describe('Filter by journey/trip name (case-insensitive, partial match)'),
  station: z.string().optional()
    .describe('Filter to trips where this is the origin or destination (case-insensitive, partial)'),
  operator: z.string().optional().describe('Filter by operator name (case-insensitive, partial)'),
  year: z.number().int().optional().describe('Filter to trips departing in this calendar year'),
  from: z.string().optional().describe('Only trips departing at or after this ISO datetime'),
  to: z.string().optional().describe('Only trips departing at or before this ISO datetime'),
  condition: z.string().optional()
    .describe('Only trips whose departure weather matches this Nynorsk label, e.g. "snø", "regn", "klårvêr" (partial match)'),
  min_temp: z.number().optional()
    .describe('Only trips whose departure day reached at least this temperature (°C)'),
  max_temp: z.number().optional()
    .describe('Only trips whose departure day stayed at or below this temperature (°C)'),
  with_weather_only: z.boolean().default(false)
    .describe('Drop trips with no departure weather on record — the ungeocoded stations and the days still inside the archive lag'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Order by departure. "desc" (default) is newest-first.'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1),
})

const num = (v: unknown): number | null => (v == null ? null : Number(v))

function side(r: Record<string, unknown>, p: 'dep' | 'arr') {
  const code = num(r[`${p}_code`])
  const label = weatherLabel(code)
  const hasAny = code != null || r[`${p}_tmax`] != null || r[`${p}_precip`] != null
  if (!hasAny) return null
  return {
    date: r[`${p}_date`] ?? null,
    condition: label?.text ?? null,
    weather_code: code,
    temp_max_c: num(r[`${p}_tmax`]),
    temp_min_c: num(r[`${p}_tmin`]),
    precipitation_mm: num(r[`${p}_precip`]),
    snowfall_cm: num(r[`${p}_snow`]),
    wind_max_kmh: num(r[`${p}_wind`]),
  }
}

export async function getTripWeather(input: z.infer<typeof getTripWeatherSchema>) {
  const db = getDb()
  const conds: SQL[] = []

  if (input.journey) conds.push(sql`t.journey ILIKE ${`%${input.journey}%`}`)
  if (input.station) {
    conds.push(sql`(t.from_station ILIKE ${`%${input.station}%`} OR t.to_station ILIKE ${`%${input.station}%`})`)
  }
  if (input.operator) conds.push(sql`t.operator ILIKE ${`%${input.operator}%`}`)
  // ISO strings, never Date objects: db.execute hands its parameters straight to
  // postgres.js, which rejects a Date with ERR_INVALID_ARG_TYPE. Drizzle's query
  // builder serialises them, raw SQL does not — so year/from/to threw here.
  if (input.year != null) {
    conds.push(sql`t.departure_at >= ${new Date(`${input.year}-01-01T00:00:00Z`).toISOString()}`)
    conds.push(sql`t.departure_at < ${new Date(`${input.year + 1}-01-01T00:00:00Z`).toISOString()}`)
  }
  if (input.from) conds.push(sql`t.departure_at >= ${new Date(input.from).toISOString()}`)
  if (input.to) conds.push(sql`t.departure_at <= ${new Date(input.to).toISOString()}`)
  if (input.min_temp != null) conds.push(sql`dw.temp_max_c >= ${input.min_temp}`)
  if (input.max_temp != null) conds.push(sql`dw.temp_max_c <= ${input.max_temp}`)
  if (input.with_weather_only || input.condition) conds.push(sql`dw.id IS NOT NULL`)

  // The condition filter is applied in JS against the same label table the output
  // uses, so "snø" cannot mean one thing in the filter and another in the result.
  const wantCondition = input.condition?.trim().toLowerCase() || null

  const where = conds.length > 0 ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``
  const order = input.sort_order === 'asc' ? sql`ASC` : sql`DESC`
  // Over-fetch when filtering on condition, since that filter lands after SQL.
  const take = wantCondition ? input.limit * 5 : input.limit
  const offset = (input.page - 1) * input.limit

  const rows = (await db.execute(sql`
    SELECT
      t.from_station, t.to_station, t.journey, t.operator, t.mode,
      t.distance_km, t.night, t.departure_at, t.arrival_at,
      ds.display_name AS dep_station_matched,
      dw.id AS dep_id, dw.date::text AS dep_date, dw.weather_code AS dep_code,
      dw.temp_max_c AS dep_tmax, dw.temp_min_c AS dep_tmin,
      dw.precipitation_mm AS dep_precip, dw.snowfall_cm AS dep_snow, dw.wind_max_kmh AS dep_wind,
      aw.date::text AS arr_date, aw.weather_code AS arr_code,
      aw.temp_max_c AS arr_tmax, aw.temp_min_c AS arr_tmin,
      aw.precipitation_mm AS arr_precip, aw.snowfall_cm AS arr_snow, aw.wind_max_kmh AS arr_wind
    FROM train_trips t
    LEFT JOIN stations ds ON ds.name = t.from_station
    LEFT JOIN station_weather dw ON dw.station_id = ds.id AND dw.date = t.departure_local::date
    LEFT JOIN stations arrs ON arrs.name = t.to_station
    LEFT JOIN station_weather aw ON aw.station_id = arrs.id AND aw.date = t.arrival_local::date
    ${where}
    ORDER BY t.departure_at ${order}
    LIMIT ${take} OFFSET ${offset}`)) as unknown as Array<Record<string, unknown>>

  let trips = rows.map((r) => ({
    from: r.from_station,
    to: r.to_station,
    journey: r.journey,
    operator: r.operator,
    mode: r.mode,
    distance_km: num(r.distance_km),
    night: r.night,
    departure_at: r.departure_at,
    arrival_at: r.arrival_at,
    /** What the geocoder matched for the origin — so a wrong hit is visible here. */
    departure_station_matched: r.dep_station_matched ?? null,
    departure_weather: side(r, 'dep'),
    arrival_weather: side(r, 'arr'),
  }))

  if (wantCondition) {
    trips = trips
      .filter((t) => t.departure_weather?.condition?.toLowerCase().includes(wantCondition))
      .slice(0, input.limit)
  }

  const [coverage] = (await db.execute(sql`
    SELECT
      count(*)::int AS trips,
      count(dw.id)::int AS with_weather
    FROM train_trips t
    LEFT JOIN stations ds ON ds.name = t.from_station
    LEFT JOIN station_weather dw ON dw.station_id = ds.id AND dw.date = t.departure_local::date`)) as unknown as Array<{ trips: number; with_weather: number }>

  return {
    count: trips.length,
    page: input.page,
    sort_order: input.sort_order,
    // Stated up front so a thin result reads as "not fetched yet" rather than
    // "he never travelled in the rain".
    coverage: {
      trips: coverage?.trips ?? 0,
      with_departure_weather: coverage?.with_weather ?? 0,
    },
    filters: {
      journey: input.journey ?? null,
      station: input.station ?? null,
      operator: input.operator ?? null,
      year: input.year ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      condition: input.condition ?? null,
      min_temp: input.min_temp ?? null,
      max_temp: input.max_temp ?? null,
      with_weather_only: input.with_weather_only,
    },
    trips,
  }
}
