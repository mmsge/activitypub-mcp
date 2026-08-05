import { config } from '../config.js'
import { logger } from './logger.js'

/**
 * Turning a station name into coordinates, via OpenStreetMap's Nominatim.
 *
 * The precision bar is much lower than it looks. The coordinates exist only to
 * pick a cell out of ERA5, which is a reanalysis on a ~25 km grid — so landing in
 * the right town is as good as landing on the right platform, and a kilometre of
 * error reads the same weather. That is what makes a bare name lookup adequate
 * and a station-by-station gazetteer unnecessary.
 *
 * The hard part is not precision but *country*. "Bergen" is a Norwegian city and
 * a Dutch one; "Næstved" is unambiguous and "Malmö C" is a local abbreviation.
 * The trips already carry the answer: viaduct.world records an IANA timezone per
 * station, so `Europe/Oslo` says Norway before any lookup happens.
 *
 * Nominatim's usage policy allows one request a second and requires an
 * identifying User-Agent. Both are honoured here and in the job that drives it.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const FETCH_TIMEOUT_MS = 10_000

/** Nominatim asks for a real identifier with a way to make contact. */
const USER_AGENT = `activitypub-mcp/1.0 (+https://${config.APP_DOMAIN})`

/**
 * IANA zone → ISO 3166-1 alpha-2, for the countries the trips actually reach.
 *
 * Deliberately a lookup table rather than a library. `Intl` will not map a zone to
 * a country, the full IANA set is thousands of entries of which these are the ones
 * a European rail archive sees, and an unknown zone falls back to an unqualified
 * search rather than a wrong country — which is the failure that matters.
 */
const TZ_COUNTRY: Record<string, string> = {
  'Europe/Oslo': 'no',
  'Europe/Stockholm': 'se',
  'Europe/Copenhagen': 'dk',
  'Europe/Helsinki': 'fi',
  'Europe/London': 'gb',
  'Europe/Dublin': 'ie',
  'Europe/Berlin': 'de',
  'Europe/Amsterdam': 'nl',
  'Europe/Brussels': 'be',
  'Europe/Luxembourg': 'lu',
  'Europe/Paris': 'fr',
  'Europe/Madrid': 'es',
  'Europe/Lisbon': 'pt',
  'Europe/Rome': 'it',
  'Europe/Zurich': 'ch',
  'Europe/Vienna': 'at',
  'Europe/Prague': 'cz',
  'Europe/Warsaw': 'pl',
  'Europe/Budapest': 'hu',
  'Europe/Bratislava': 'sk',
  'Europe/Ljubljana': 'si',
  'Europe/Zagreb': 'hr',
}

/**
 * The country a timezone implies, or null.
 *
 * 'UTC' is the parser's fallback when the CSV carried no zone (see
 * parse-trips-csv.ts), so it must not be treated as a country hint — it means
 * "unknown", and biasing a search on it would be inventing information.
 */
export function countryForTimezone(tz: string | null | undefined): string | null {
  if (!tz || tz === 'UTC') return null
  return TZ_COUNTRY[tz] ?? null
}

export interface GeocodeHit {
  latitude: number
  longitude: number
  /** Nominatim's full matched name, stored so a wrong hit is auditable. */
  displayName: string
  countryCode: string | null
}

/**
 * Parse a Nominatim `/search` response down to the first usable hit, or null.
 *
 * Pure, so the coordinate validation is testable without a network. Rejects
 * anything out of range, and — as elsewhere in this codebase — never lets an
 * absent value coerce to 0, which would silently tag Null Island.
 */
export function parseNominatim(json: unknown): GeocodeHit | null {
  const list = Array.isArray(json) ? json : []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const num = (v: unknown): number => {
      if (v === null || v === undefined) return NaN
      if (typeof v === 'string' && v.trim() === '') return NaN
      return Number(v)
    }
    const latitude = num(r.lat)
    const longitude = num(r.lon)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue
    const cc = typeof r.address === 'object' && r.address
      ? (r.address as Record<string, unknown>).country_code
      : undefined
    return {
      latitude,
      longitude,
      displayName: typeof r.display_name === 'string' ? r.display_name : '',
      countryCode: typeof cc === 'string' ? cc.toLowerCase() : null,
    }
  }
  return null
}

/** One Nominatim call, optionally restricted to a country. Never throws. */
async function search(name: string, countryCode: string | null): Promise<GeocodeHit | null> {
  const params = new URLSearchParams({
    q: name,
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
  })
  if (countryCode) params.set('countrycodes', countryCode)

  try {
    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      logger.warn({ name, countryCode, status: res.status }, 'Nominatim lookup failed')
      return null
    }
    return parseNominatim(await res.json())
  } catch (e) {
    logger.warn({ name, countryCode, err: (e as Error).message }, 'Nominatim lookup errored')
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Look one station up. Returns null on a miss or any failure — never throws.
 *
 * The country hint is a *bias*, not a filter, so a miss falls back to an
 * unqualified search. It has to: the timezone is the station's, not necessarily
 * its country's, and a leg recorded with the wrong zone — or with the parser's
 * 'UTC' fallback on one end only — would otherwise make a perfectly findable
 * station permanently unfindable. Verified against exactly that case: Åndalsnes
 * searched as Danish returns nothing, and is found on the retry.
 *
 * The second call only happens on a miss, and waits out Nominatim's one-a-second
 * rule first so the fallback cannot turn a slow backfill into an impolite one.
 */
export async function geocodeStation(
  name: string,
  timezone: string | null,
): Promise<GeocodeHit | null> {
  const countryCode = countryForTimezone(timezone)

  const biased = await search(name, countryCode)
  if (biased) return biased
  if (!countryCode) {
    logger.warn({ name }, 'Nominatim returned no usable result')
    return null
  }

  await sleep(RETRY_SPACING_MS)
  const unbiased = await search(name, null)
  if (!unbiased) {
    logger.warn({ name, countryCode }, 'Nominatim returned no usable result, biased or not')
  } else {
    logger.info(
      { name, countryCode, matched: unbiased.countryCode },
      'Station found only without its timezone country hint',
    )
  }
  return unbiased
}

/** Honours the one-request-a-second policy between the biased and unbiased tries. */
const RETRY_SPACING_MS = 1_100
