import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { logger } from '../lib/logger.js'
import { fetchArchive, latestArchivedDate } from '../lib/fetch-weather.js'

/**
 * Fetch the weather at each station on the days Markus was actually there.
 *
 * The date is the station's *local* calendar day, not a UTC one: `departure_local`
 * is the wall clock at the origin and `arrival_local` at the destination, so a
 * night train arriving at 06:20 records the weather for the morning it arrived
 * rather than the evening it left.
 *
 * One request per station covers its whole span, because the archive returns a
 * date range in one response. That makes the backfill ~115 requests instead of one
 * per (station, date) — and the rows outside the dates he travelled are simply not
 * stored, so the table stays the size of the travel history rather than the size
 * of the calendar.
 */

/** Stations per run. The whole backfill is a handful of ticks. */
const PER_RUN = 25

/** Courtesy spacing between requests to a free, keyless API. */
const SPACING_MS = 400

export interface SyncStationWeatherResult {
  /** Stations queried this run. */
  stations: number
  /** (station, date) rows written or refreshed. */
  days: number
  /** Dates wanted but not yet in the archive — retried on a later run. */
  tooRecent: number
  /** (station, date) pairs still missing weather. */
  pending: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Every (station, local date) the trips imply — the exact set worth having weather
 * for. Both ends of every trip count: the origin on its departure date, the
 * destination on its arrival date.
 */
const WANTED = sql`
  SELECT s.id AS station_id, d.day::date AS day
  FROM (
    SELECT from_station AS name, departure_local::date AS day
    FROM train_trips WHERE from_station <> '' AND departure_local IS NOT NULL
    UNION
    SELECT to_station AS name, arrival_local::date AS day
    FROM train_trips WHERE to_station <> '' AND arrival_local IS NOT NULL
  ) d
  JOIN stations s ON s.name = d.name
  WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL`

export async function syncStationWeather(now: Date = new Date()): Promise<SyncStationWeatherResult> {
  const db = getDb()
  const cutoff = latestArchivedDate(now)

  // Stations that still want at least one date, with the span to ask for. The
  // range is trimmed to what the archive can answer; anything past the cutoff is
  // counted as pending rather than stored as a row of nulls.
  const targets = (await db.execute(sql`
    WITH wanted AS (${WANTED})
    SELECT s.id::text AS id, s.name,
           s.latitude::float8 AS latitude, s.longitude::float8 AS longitude,
           min(w.day)::text AS first_day,
           max(w.day)::text AS last_day
    FROM wanted w
    JOIN stations s ON s.id = w.station_id
    LEFT JOIN station_weather sw ON sw.station_id = w.station_id AND sw.date = w.day
    WHERE sw.id IS NULL AND w.day <= ${cutoff}::date
    GROUP BY s.id, s.name, s.latitude, s.longitude
    ORDER BY count(*) DESC
    LIMIT ${PER_RUN}`)) as unknown as Array<{
      id: string; name: string; latitude: number; longitude: number
      first_day: string; last_day: string
    }>

  let days = 0
  for (const [i, t] of targets.entries()) {
    if (i > 0) await sleep(SPACING_MS)

    // Trim the far end to the archive's horizon — asking beyond it wastes the call
    // and returns nulls.
    const endDate = t.last_day < cutoff ? t.last_day : cutoff
    const rows = await fetchArchive(t.latitude, t.longitude, t.first_day, endDate)
    if (rows.length === 0) continue

    // Only the dates he was actually there. The response covers the whole span, so
    // storing all of it would turn a 229-trip history into a decade of daily
    // weather for 115 places.
    for (const r of rows) {
      const written = await db.execute(sql`
        INSERT INTO station_weather (
          station_id, date, weather_code, temp_max_c, temp_min_c, temp_mean_c,
          precipitation_mm, snowfall_cm, wind_max_kmh)
        SELECT ${t.id}::uuid, ${r.date}::date, ${r.weatherCode}, ${r.tempMaxC},
               ${r.tempMinC}, ${r.tempMeanC}, ${r.precipitationMm}, ${r.snowfallCm},
               ${r.windMaxKmh}
        WHERE EXISTS (
          WITH wanted AS (${WANTED})
          SELECT 1 FROM wanted w
          WHERE w.station_id = ${t.id}::uuid AND w.day = ${r.date}::date
        )
        ON CONFLICT (station_id, date) DO UPDATE
          SET weather_code = EXCLUDED.weather_code,
              temp_max_c = EXCLUDED.temp_max_c,
              temp_min_c = EXCLUDED.temp_min_c,
              temp_mean_c = EXCLUDED.temp_mean_c,
              precipitation_mm = EXCLUDED.precipitation_mm,
              snowfall_cm = EXCLUDED.snowfall_cm,
              wind_max_kmh = EXCLUDED.wind_max_kmh,
              fetched_at = now()
        RETURNING id`)
      days += (written as unknown as unknown[]).length
    }
  }

  const [counts] = (await db.execute(sql`
    WITH wanted AS (${WANTED})
    SELECT
      count(*) FILTER (WHERE sw.id IS NULL AND w.day <= ${cutoff}::date)::int AS pending,
      count(*) FILTER (WHERE w.day > ${cutoff}::date)::int AS too_recent
    FROM wanted w
    LEFT JOIN station_weather sw ON sw.station_id = w.station_id AND sw.date = w.day`)) as unknown as
      Array<{ pending: number; too_recent: number }>

  const result: SyncStationWeatherResult = {
    stations: targets.length,
    days,
    tooRecent: counts?.too_recent ?? 0,
    pending: counts?.pending ?? 0,
  }
  logger.info(result, 'Station weather synced')
  return result
}
