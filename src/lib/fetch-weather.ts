import { logger } from './logger.js'

/**
 * Daily weather from Open-Meteo's ERA5 archive — keyless, and complete back to 1940,
 * which comfortably covers a rail history starting in 2016.
 *
 * One request per station covers its whole span of travel dates, because the API
 * returns parallel daily arrays for a date range. 115 stations is therefore ~115
 * requests for the entire backfill rather than one per (station, date).
 *
 * ERA5 is a reanalysis, not a live feed: it lags real time by around five days.
 * Asking for yesterday returns nulls rather than an error, so the caller must skip
 * dates that are too recent and come back for them — see ARCHIVE_LAG_DAYS.
 */

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'
const FETCH_TIMEOUT_MS = 20_000

/**
 * How far behind real time the archive is assumed to be.
 *
 * Open-Meteo documents roughly five days for ERA5; seven is used here so a day at
 * the boundary is retried later rather than being stored as a row of nulls that
 * nothing would ever revisit.
 */
export const ARCHIVE_LAG_DAYS = 7

/** The daily fields requested, in the order the response arrays arrive. */
const DAILY_FIELDS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'temperature_2m_mean',
  'precipitation_sum',
  'snowfall_sum',
  'wind_speed_10m_max',
] as const

export interface DailyWeather {
  /** YYYY-MM-DD, as returned. */
  date: string
  weatherCode: number | null
  tempMaxC: number | null
  tempMinC: number | null
  tempMeanC: number | null
  precipitationMm: number | null
  snowfallCm: number | null
  windMaxKmh: number | null
}

/** `Date` → `YYYY-MM-DD` in UTC, the form the archive API takes and returns. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** The most recent date the archive can be expected to have. */
export function latestArchivedDate(now: Date): string {
  return isoDate(new Date(now.getTime() - ARCHIVE_LAG_DAYS * 86_400_000))
}

/**
 * Reshape the archive's parallel arrays into one record per day.
 *
 * Pure, and defensive about length: the arrays are supposed to be the same length
 * as `time`, but a short one must truncate rather than pair a date with another
 * day's temperature. A day the archive has no value for yields nulls, and the
 * caller drops it — an all-null row is not an observation.
 */
export function parseArchive(json: unknown): DailyWeather[] {
  if (!json || typeof json !== 'object') return []
  const daily = (json as Record<string, unknown>).daily
  if (!daily || typeof daily !== 'object') return []
  const d = daily as Record<string, unknown>
  const time = Array.isArray(d.time) ? d.time : []

  const col = (key: string): unknown[] => (Array.isArray(d[key]) ? (d[key] as unknown[]) : [])
  const num = (v: unknown): number | null =>
    v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)

  const cols = Object.fromEntries(DAILY_FIELDS.map((f) => [f, col(f)])) as Record<string, unknown[]>

  const out: DailyWeather[] = []
  for (let i = 0; i < time.length; i++) {
    const date = time[i]
    if (typeof date !== 'string') continue
    const row: DailyWeather = {
      date,
      weatherCode: num(cols.weather_code[i]),
      tempMaxC: num(cols.temperature_2m_max[i]),
      tempMinC: num(cols.temperature_2m_min[i]),
      tempMeanC: num(cols.temperature_2m_mean[i]),
      precipitationMm: num(cols.precipitation_sum[i]),
      snowfallCm: num(cols.snowfall_sum[i]),
      windMaxKmh: num(cols.wind_speed_10m_max[i]),
    }
    // A day with nothing in it at all is a gap in the archive, not an observation.
    const hasAny = row.weatherCode != null || row.tempMaxC != null || row.tempMinC != null
      || row.tempMeanC != null || row.precipitationMm != null || row.snowfallCm != null
      || row.windMaxKmh != null
    if (hasAny) out.push(row)
  }
  return out
}

/** Fetch a date range for one coordinate. Returns [] on any failure — never throws. */
export async function fetchArchive(
  latitude: number,
  longitude: number,
  startDate: string,
  endDate: string,
): Promise<DailyWeather[]> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    start_date: startDate,
    end_date: endDate,
    daily: DAILY_FIELDS.join(','),
    // The dates are the station's local calendar days; asking the API to bucket in
    // UTC would slide a Norwegian winter day by an hour and, at the edges, a date.
    timezone: 'auto',
  })
  try {
    const res = await fetch(`${ARCHIVE_URL}?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      logger.warn({ latitude, longitude, status: res.status }, 'Open-Meteo archive request failed')
      return []
    }
    return parseArchive(await res.json())
  } catch (e) {
    logger.warn({ latitude, longitude, err: (e as Error).message }, 'Open-Meteo archive errored')
    return []
  }
}
