import { USER_AGENT } from './user-agent.js'
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
 * The hard part is not precision but *country*. "Bergen" is a Norwegian city, a
 * Dutch one and the Dutch name for Mons; "Malmö C" is a local abbreviation.
 *
 * The trip's timezone does NOT answer that, although this file once assumed it
 * did. viaduct.world's export writes one zone per UTC offset rule, not per
 * station: Oslo S, Bergen, Göteborgs central, Praha hl.n. and every other CET
 * station all arrive as `Europe/Paris`, and only the UK ones as `Europe/London`.
 * Used as a country filter, that put Bergen in Picardy and Oslo S in Strasbourg
 * (ADR 0065). So the zone is now only what it really is, an offset: a hit in a
 * country whose clock disagrees with the leg's is rejected, and so is a hit in a
 * country this file keeps no clock for, which it cannot vouch for at all (ADR 0066:
 * Bangor went to Maine and Tirano to Tirana through that gap). Among what is left,
 * a hit whose own name is the station's comes first: Faulquemont is "Falkenberg" in
 * German, and keeps the same clock as Sweden.
 *
 * Nominatim's usage policy allows one request a second and requires an
 * identifying User-Agent. Both are honoured here and in the job that drives it.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const FETCH_TIMEOUT_MS = 10_000

/** Nominatim asks for a real identifier with a way to make contact. */

/**
 * ISO 3166-1 alpha-2 → the IANA zone its clocks keep, for the countries a European
 * rail archive reaches.
 *
 * This runs one way only, from a geocoded country to a zone, never back. A zone
 * names a clock, and Viaduct uses one CET zone for all of central Europe, so
 * reading a country out of it is the mistake ADR 0065 records. A table rather than
 * a library: `Intl` will not map a country to a zone, and an unmapped country is
 * simply left without one rather than given a wrong one.
 *
 * Leaving a country out also means a geocoder hit there is never accepted for a leg
 * with a known zone (`offsetAgrees`). That is deliberate for Albania and the
 * Americas, where a European station's namesake lives. A station in a country the
 * trips have not reached yet misses until its country is added here, or until it
 * is pinned by hand with `source = 'manual'`.
 */
const COUNTRY_TZ: Record<string, string> = {
  no: 'Europe/Oslo',
  se: 'Europe/Stockholm',
  dk: 'Europe/Copenhagen',
  fi: 'Europe/Helsinki',
  gb: 'Europe/London',
  ie: 'Europe/Dublin',
  de: 'Europe/Berlin',
  nl: 'Europe/Amsterdam',
  be: 'Europe/Brussels',
  lu: 'Europe/Luxembourg',
  fr: 'Europe/Paris',
  es: 'Europe/Madrid',
  pt: 'Europe/Lisbon',
  it: 'Europe/Rome',
  ch: 'Europe/Zurich',
  li: 'Europe/Vaduz',
  at: 'Europe/Vienna',
  cz: 'Europe/Prague',
  pl: 'Europe/Warsaw',
  hu: 'Europe/Budapest',
  sk: 'Europe/Bratislava',
  si: 'Europe/Ljubljana',
  hr: 'Europe/Zagreb',
  rs: 'Europe/Belgrade',
  ee: 'Europe/Tallinn',
  lv: 'Europe/Riga',
  lt: 'Europe/Vilnius',
  ro: 'Europe/Bucharest',
  bg: 'Europe/Sofia',
  gr: 'Europe/Athens',
  // Micro-states on the lines through France and Italy (Monaco - Monte Carlo is in
  // the archive). Their own zones keep the same clock as their neighbours.
  mc: 'Europe/Monaco',
  ad: 'Europe/Andorra',
  sm: 'Europe/San_Marino',
  va: 'Europe/Vatican',
}

/** Every mapped (country, zone) pair, for SQL that needs the table as rows. */
export const COUNTRY_ZONES: ReadonlyArray<readonly [string, string]> = Object.entries(COUNTRY_TZ)

/** The zone a geocoded country keeps, or null when the country is not mapped. */
export function timezoneForCountry(countryCode: string | null | undefined): string | null {
  if (!countryCode) return null
  return COUNTRY_TZ[countryCode.toLowerCase()] ?? null
}

/** A winter and a summer instant: two zones that agree on both keep the same clock. */
const PROBE_INSTANTS = [new Date('2026-01-15T12:00:00Z'), new Date('2026-07-15T12:00:00Z')]

function utcOffsets(zone: string): string[] | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    return PROBE_INSTANTS.map((d) => fmt.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '')
  } catch {
    return null
  }
}

/**
 * Whether a hit in `countryCode` is plausible for a leg recorded in `legZone`.
 *
 * With no usable leg zone, anything goes. 'UTC' is the CSV parser's fallback for a
 * missing zone (parse-trips-csv.ts), so it means "unknown" here, never "the UK".
 *
 * With a leg zone, the hit's country must be one this file keeps a clock for, and
 * that clock must agree with the leg's, winter and summer. A country with no zone
 * here (the US, Albania) or a hit with no country at all is refused: it used to
 * pass, which put Bangor in Maine and Tirano in Tirana (ADR 0066). This is a sanity
 * check, not a country hint: `Europe/Paris` accepts Norway, Sweden and Czechia
 * alike, which is exactly right, and refuses London.
 */
export function offsetAgrees(legZone: string | null | undefined, countryCode: string | null): boolean {
  if (!legZone || legZone === 'UTC' || !utcOffsets(legZone)) return true
  const countryZone = timezoneForCountry(countryCode)
  if (!countryZone) return false
  const a = utcOffsets(legZone)
  const b = utcOffsets(countryZone)
  if (!a || !b) return true
  return a[0] === b[0] && a[1] === b[1]
}

export interface GeocodeHit {
  latitude: number
  longitude: number
  /** The place's own name in OSM (`name` in jsonv2), or '' when Nominatim sent none. */
  name: string
  /** Nominatim's full matched name, stored so a wrong hit is auditable. */
  displayName: string
  countryCode: string | null
  /** OSM tags this as a railway station or halt, not a town, a stop sign or a tram stop. */
  isStation: boolean
}

/** The OSM `category`/`type` pairs that mean "a railway station", as jsonv2 reports them. */
function isStationTag(category: unknown, type: unknown): boolean {
  if (category === 'railway') return type === 'station' || type === 'halt' || type === 'stop'
  if (category === 'building') return type === 'train_station'
  if (category === 'public_transport') return type === 'station'
  return false
}

/**
 * Parse a Nominatim `/search` response into every usable hit, in Nominatim's order.
 *
 * Pure, so the coordinate validation is testable without a network. Rejects
 * anything out of range, and — as elsewhere in this codebase — never lets an
 * absent value coerce to 0, which would silently tag Null Island.
 */
export function parseNominatimHits(json: unknown): GeocodeHit[] {
  const list = Array.isArray(json) ? json : []
  const hits: GeocodeHit[] = []
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
    hits.push({
      latitude,
      longitude,
      name: typeof r.name === 'string' ? r.name : '',
      displayName: typeof r.display_name === 'string' ? r.display_name : '',
      countryCode: typeof cc === 'string' ? cc.toLowerCase() : null,
      isStation: isStationTag(r.category, r.type),
    })
  }
  return hits
}

function foldName(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

/**
 * The hits whose own name is `query` first, the rest after, each in Nominatim's
 * order. Nominatim also matches alternative names, so a bare "Falkenberg" ranks
 * Faulquemont (its German name) above Falkenberg itself. Pure.
 */
export function preferExactName(hits: GeocodeHit[], query: string): GeocodeHit[] {
  const want = foldName(query)
  const exact = hits.filter((h) => foldName(h.name) === want)
  return exact.length ? [...exact, ...hits.filter((h) => foldName(h.name) !== want)] : hits
}

/** The first usable hit, or null. */
export function parseNominatim(json: unknown): GeocodeHit | null {
  return parseNominatimHits(json)[0] ?? null
}

/**
 * Pick the station from the two searches. Pure; `geocodeStation` does the I/O.
 *
 * `plain` is the bare name, `station` the name with " station" appended, which
 * is only asked when the bare name did not land on a station. Both are already
 * filtered to hits whose clock agrees with the leg's.
 *
 * - The bare name's first hit, if it is a station, wins outright. Oslo S, Malmö C,
 *   Göteborgs central and Praha hl.n. all land here.
 * - Otherwise the bare name still says which *country* the place most likely is
 *   ("Bergen" → Norway), and the first station in that country wins. That is what
 *   stops "Bergen station" from resolving to Mons, whose Dutch name it is.
 * - Failing that, the bare name's own hit: the right town is as good as the right
 *   platform for weather (ADR 0028). "Paris Nord" is the case for the ordering —
 *   bare, it is a hamlet in Haute-Garonne; as a station, it is Gare du Nord.
 * - With no bare hit at all, the first station is the only lead left.
 */
export function chooseStationHit(plain: GeocodeHit[], station: GeocodeHit[]): GeocodeHit | null {
  const top = plain[0]
  if (top?.isStation) return top
  const stations = station.filter((h) => h.isStation)
  if (top) {
    if (top.countryCode) {
      const sameCountry = stations.find((h) => h.countryCode === top.countryCode)
      if (sameCountry) return sameCountry
    }
    return top
  }
  return stations[0] ?? null
}

/** One unrestricted Nominatim call. Never throws; a failure is an empty list. */
async function search(query: string): Promise<GeocodeHit[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(CANDIDATES),
    addressdetails: '1',
  })

  try {
    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      logger.warn({ query, status: res.status }, 'Nominatim lookup failed')
      return []
    }
    return parseNominatimHits(await res.json())
  } catch (e) {
    logger.warn({ query, err: (e as Error).message }, 'Nominatim lookup errored')
    return []
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Look one station up. Returns null on a miss or any failure — never throws.
 *
 * No country filter: the leg's zone is an offset, not a place (see the top of
 * this file). It only removes hits whose clock is wrong for the leg, which keeps
 * a CET leg out of London and a London leg out of Bergen.
 *
 * The second call only happens when the bare name did not land on a station, and
 * waits out Nominatim's one-a-second rule first so it cannot turn a slow backfill
 * into an impolite one.
 */
export async function geocodeStation(
  name: string,
  timezone: string | null,
): Promise<GeocodeHit | null> {
  const plausible = (hits: GeocodeHit[]) => hits.filter((h) => offsetAgrees(timezone, h.countryCode))

  const plain = preferExactName(plausible(await search(name)), name)
  let station: GeocodeHit[] = []
  if (!plain[0]?.isStation) {
    await sleep(RETRY_SPACING_MS)
    station = plausible(await search(`${name} station`))
  }

  const hit = chooseStationHit(plain, station)
  if (!hit) logger.warn({ name, timezone }, 'Nominatim returned no usable result')
  return hit
}

/** Candidates asked for per search: enough to find the station behind a town. */
const CANDIDATES = 5

/** Honours the one-request-a-second policy between the two searches. */
const RETRY_SPACING_MS = 1_100
