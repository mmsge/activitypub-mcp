import { config } from '../config.js'
import { logger } from './logger.js'

/**
 * Turning a station name into coordinates, via OpenStreetMap's Nominatim.
 *
 * The precision bar is low: the coordinates exist only to pick a cell out of
 * ERA5, a reanalysis on a ~25 km grid, so landing in the right town is as good
 * as landing on the right platform. The bar that matters is landing in the right
 * *country*, and that turns out to be the hard part.
 *
 * **There is deliberately no country hint.** ADR 0028 biased each search by the
 * country the trip's IANA timezone implied. That premise was wrong: viaduct.world
 * records the UTC *offset* zone, not the station's own — 197 of Markus' 229 trips
 * say `Europe/Paris` and none say `Europe/Oslo`, because Norway is CET. Biasing on
 * it did not merely waste a request; it made wrong searches *succeed*, so six
 * stations were silently placed in France: Arna above Nice, Bergen in the Somme,
 * Chur in Normandy. A hint that is confidently wrong is worse than none, because
 * a hit stops the fallback from ever running. See ADR 0035.
 *
 * Unqualified search is right for most names and wrong for a few — "Falkenberg"
 * fuzzy-matches Faulquemont in Moselle whatever you do, and adding "station" to
 * the query fixes that one while breaking "Bergen" (which then matches Mons).
 * There is no formulation that gets them all, so the residual errors are caught
 * afterwards instead, by checking the coordinates against the distances the trips
 * record — see lib/geo-distance.ts.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const FETCH_TIMEOUT_MS = 10_000

/** Nominatim asks for a real identifier with a way to make contact. */
const USER_AGENT = `activitypub-mcp/1.0 (+https://${config.APP_DOMAIN})`

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

/** Look one station up. Returns null on a miss or any failure — never throws. */
export async function geocodeStation(name: string): Promise<GeocodeHit | null> {
  const params = new URLSearchParams({
    q: name,
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
  })

  try {
    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      logger.warn({ name, status: res.status }, 'Nominatim lookup failed')
      return null
    }
    const hit = parseNominatim(await res.json())
    if (!hit) logger.warn({ name }, 'Nominatim returned no usable result')
    return hit
  } catch (e) {
    logger.warn({ name, err: (e as Error).message }, 'Nominatim lookup errored')
    return null
  }
}
