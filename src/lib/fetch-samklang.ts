import { logger } from './logger.js'
import { normalizeSamklangUrl } from './gig-attendance.js'

type AnyObject = Record<string, unknown>

// Gigowl serves the concert, the artist and the venue as ActivityPub from the same URLs
// people share, under content negotiation.
//
// IMPORTANT: send a SINGLE media type, and never one containing `text/html`. Gigowl's
// `wantsActivityJson()` returns HTML for ANY Accept header mentioning text/html — a
// deliberate choice, so a crawler with a scattergun header gets the page — which means a
// browser-ish header silently yields `<!DOCTYPE html>` and looks exactly like "this origin
// has no ActivityPub representation". The same trap as NeoDB's, for a different reason.
const SAMKLANG_AP_HEADERS = {
  Accept: 'application/activity+json',
}

// The HTML page, for the schema.org fallback. Requested separately and only when the
// ActivityPub document is missing fields, so the common case is one request.
const SAMKLANG_HTML_HEADERS = {
  Accept: 'text/html',
}

const FETCH_TIMEOUT_MS = 10_000

/** Where a field came from. Mirrors catalog_metadata.source_map. */
export type GigSource = 'samklang-ap' | 'samklang-jsonld'

export interface GigLineupMember {
  artistUrl: string | null
  name: string | null
  role: string | null
  position: number | null
}

export interface GigSetlistEntry {
  position: number | null
  setNumber: number | null
  isEncore: boolean
  songTitle: string
  isCover: boolean
  coverOfArtist: string | null
  note: string | null
}

export interface GigSetlist {
  id: string | null
  artistUrl: string | null
  entries: GigSetlistEntry[]
}

export interface GigConcertMetadata {
  concertUrl: string
  title: string | null
  gigDate: string | null // YYYY-MM-DD
  startAt: Date | null
  doorsTime: string | null
  concertStatus: string | null
  tourName: string | null
  festivalName: string | null
  notes: string | null
  venueUrl: string | null
  venueName: string | null
  venueCity: string | null
  venueCountry: string | null
  lineup: GigLineupMember[]
  artistNames: string[]
  setlists: GigSetlist[]
  songCount: number | null
  details: Record<string, unknown>
  sourceMap: Record<string, GigSource>
  raw: unknown
}

export interface GigArtistMetadata {
  artistUrl: string
  name: string | null
  sortName: string | null
  disambiguation: string | null
  artistType: string | null
  country: string | null
  mbid: string | null
  wikidataQid: string | null
  beginYear: number | null
  endYear: number | null
  imageUrl: string | null
  imageAttribution: string | null
  sourceMap: Record<string, GigSource>
  raw: unknown
}

export interface GigVenueMetadata {
  venueUrl: string
  name: string | null
  aka: string[]
  city: string | null
  country: string | null
  latitude: string | null
  longitude: string | null
  capacity: number | null
  timezone: string | null
  wikidataQid: string | null
  isPlaceholder: boolean
  sourceMap: Record<string, GigSource>
  raw: unknown
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function intOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function numStrOrNull(v: unknown): string | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : null
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * A property that AP allows as either a single value or a list.
 *
 * The concert Event's `tag` is the live example: a bare string when the gig has one
 * artist, an array when it has several. Reading one shape passes every test written
 * against a solo show and fails on the first festival.
 */
function toArray(v: unknown): unknown[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

/** The calendar date out of an ISO-ish string, without going through a Date. */
function dateOnly(v: unknown): string | null {
  const s = strOrNull(v)
  if (!s) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return m ? m[1]! : null
}

function mapLineup(v: unknown): GigLineupMember[] {
  return toArray(v)
    .filter((m): m is AnyObject => !!m && typeof m === 'object')
    .map((m) => ({
      artistUrl: normalizeSamklangUrl(m.artist),
      name: strOrNull(m.name),
      role: strOrNull(m.role),
      position: intOrNull(m.position),
    }))
}

function mapSetlists(v: unknown): GigSetlist[] {
  return toArray(v)
    .filter((s): s is AnyObject => !!s && typeof s === 'object')
    .map((s) => ({
      id: normalizeSamklangUrl(s.id),
      artistUrl: normalizeSamklangUrl(s.artist),
      entries: toArray(s.entries)
        .filter((e): e is AnyObject => !!e && typeof e === 'object')
        .map((e) => ({
          position: intOrNull(e.position),
          setNumber: intOrNull(e.setNumber),
          isEncore: Boolean(e.isEncore),
          songTitle: strOrNull(e.songTitle) ?? '',
          isCover: Boolean(e.isCover),
          coverOfArtist: strOrNull(e.coverOfArtist),
          note: strOrNull(e.note),
        }))
        .filter((e) => e.songTitle !== ''),
    }))
}

/**
 * The schema.org `eventStatus` IRI back to the origin's own vocabulary.
 *
 * Lossy on purpose in one direction: the origin's `completed` has no schema.org
 * equivalent, so a gig that has happened comes back from the JSON-LD as `scheduled`.
 * That is why the ActivityPub `samklang:concertStatus` wins whenever it is present.
 */
function statusFromSchemaOrg(v: unknown): string | null {
  const s = strOrNull(v)
  if (!s) return null
  if (s.endsWith('EventCancelled')) return 'cancelled'
  if (s.endsWith('EventPostponed')) return 'postponed'
  if (s.endsWith('EventScheduled')) return 'scheduled'
  if (s.endsWith('EventMovedOnline')) return 'scheduled'
  return null
}

/**
 * Map the ActivityStreams `Event` plus Gigowl's `samklang:` extras into the column shape.
 *
 * Everything structural comes from the extras; the AS2 half supplies `name`, `startTime`
 * and the venue's identity. An origin that predates Gigowl's ADR 0026 serves the AS2 half
 * only, and `mergeJsonLd` below fills what it can from the page.
 */
export function mapConcertEvent(concertUrl: string, d: AnyObject): GigConcertMetadata {
  const sourceMap: Record<string, GigSource> = {}
  const mark = (field: string, value: unknown): void => {
    if (value != null && !(Array.isArray(value) && value.length === 0)) sourceMap[field] = 'samklang-ap'
  }

  const venue = (d['samklang:venue'] ?? null) as AnyObject | null
  const location = (d.location ?? null) as AnyObject | null

  const title = strOrNull(d.name)
  // The AS2 startTime is a real instant; the extras' date is the calendar day. Prefer the
  // day, and fall back to the instant's date only when the origin serves no extras.
  const startAt = parseDate(d.startTime)
  const gigDate = dateOnly(d['samklang:date']) ?? (startAt ? startAt.toISOString().slice(0, 10) : null)
  const concertStatus = strOrNull(d['samklang:concertStatus'])
  const tourName = strOrNull(d['samklang:tourName'])
  const festivalName = strOrNull(d['samklang:festivalName'])
  const notes = strOrNull(d['samklang:notes'])
  const doorsTime = strOrNull(d['samklang:doorsTime'])

  const venueUrl = normalizeSamklangUrl(venue?.id) ?? normalizeSamklangUrl(location?.id)
  const venueName = strOrNull(venue?.name) ?? strOrNull(location?.name)
  const venueCity = strOrNull(venue?.city)
  const venueCountry = strOrNull(venue?.country)

  const lineup = mapLineup(d['samklang:lineup'])
  const setlists = mapSetlists(d['samklang:setlist'])
  const songCount = setlists.length > 0
    ? setlists.reduce((total, list) => total + list.entries.length, 0)
    : null

  mark('title', title)
  mark('gigDate', gigDate)
  mark('startAt', startAt)
  mark('doorsTime', doorsTime)
  mark('concertStatus', concertStatus)
  mark('tourName', tourName)
  mark('festivalName', festivalName)
  mark('notes', notes)
  mark('venueUrl', venueUrl)
  mark('venueName', venueName)
  mark('venueCity', venueCity)
  mark('venueCountry', venueCountry)
  mark('lineup', lineup)
  mark('setlists', setlists)

  return {
    concertUrl,
    title,
    gigDate,
    startAt,
    doorsTime,
    concertStatus,
    tourName,
    festivalName,
    notes,
    venueUrl,
    venueName,
    venueCity,
    venueCountry,
    lineup,
    artistNames: lineup.map((m) => m.name).filter((n): n is string => n != null),
    setlists,
    songCount,
    details: {
      // The bare artist URIs from the AS2 `tag`, kept whether or not the extras
      // supplied a full lineup — for an origin serving the AS2 half only, this is the
      // only record of who played.
      artistUris: toArray(d.tag)
        .map((t) => normalizeSamklangUrl(typeof t === 'string' ? t : (t as AnyObject)?.href))
        .filter((u): u is string => u != null),
      // "Name (role), Name (role)". Kept verbatim as provenance, never parsed: the
      // structured lineup is the source, and this breaks on any name with a bracket.
      summary: strOrNull(d.summary),
    },
    sourceMap,
    raw: d,
  }
}

/**
 * Fill the gaps in an ActivityPub concert record from the page's schema.org MusicEvent.
 *
 * Only ever fills what is missing — the ActivityPub document is authoritative wherever it
 * spoke, because it is the only one of the two that can express `completed` and the only
 * one carrying setlists. This exists so the consumer degrades gracefully against an origin
 * that has not deployed Gigowl's ADR 0026 yet, and can be deleted once none remain.
 */
export function mergeJsonLd(concert: GigConcertMetadata, event: AnyObject | null): GigConcertMetadata {
  if (!event) return concert
  const merged = { ...concert, sourceMap: { ...concert.sourceMap } }
  const fill = <K extends keyof GigConcertMetadata>(field: K, value: GigConcertMetadata[K]): void => {
    const empty = merged[field] == null || (Array.isArray(merged[field]) && (merged[field] as unknown[]).length === 0)
    if (!empty || value == null || (Array.isArray(value) && value.length === 0)) return
    merged[field] = value
    merged.sourceMap[field as string] = 'samklang-jsonld'
  }

  const location = (event.location ?? null) as AnyObject | null
  const address = (location?.address ?? null) as AnyObject | null
  const superEvent = (event.superEvent ?? null) as AnyObject | null

  fill('title', strOrNull(event.name))
  fill('gigDate', dateOnly(event.startDate))
  fill('concertStatus', statusFromSchemaOrg(event.eventStatus))
  fill('notes', strOrNull(event.description))
  fill('tourName', strOrNull(superEvent?.name))
  fill('venueUrl', normalizeSamklangUrl(location?.['@id']))
  fill('venueName', strOrNull(location?.name))
  fill('venueCity', strOrNull(address?.addressLocality))
  fill('venueCountry', strOrNull(address?.addressCountry))

  const performers = toArray(event.performer)
    .filter((p): p is AnyObject => !!p && typeof p === 'object')
    .map((p, index) => ({
      artistUrl: normalizeSamklangUrl(p['@id']),
      name: strOrNull(p.name),
      // schema.org's `performer` carries no role, and inventing one would make an
      // opener look like a headliner. Unknown stays unknown.
      role: null,
      position: index,
    }))
  fill('lineup', performers)
  if (merged.artistNames.length === 0) {
    merged.artistNames = merged.lineup.map((m) => m.name).filter((n): n is string => n != null)
  }

  return merged
}

export function mapArtist(artistUrl: string, d: AnyObject): GigArtistMetadata {
  const sourceMap: Record<string, GigSource> = {}
  const mark = (field: string, value: unknown): void => {
    if (value != null) sourceMap[field] = 'samklang-ap'
  }

  const name = strOrNull(d.name)
  const artistType = strOrNull(d['samklang:artistType'])
  const mbid = strOrNull(d['samklang:mbid'])
  const wikidataQid = strOrNull(d['samklang:wikidataQid'])
  const country = strOrNull(d['samklang:country'])
  const sortName = strOrNull(d['samklang:sortName'])
  const disambiguation = strOrNull(d.summary)
  const beginYear = intOrNull(d['samklang:beginYear'])
  const endYear = intOrNull(d['samklang:endYear'])
  const imageUrl = strOrNull(d.image)
  const imageAttribution = strOrNull(d['samklang:imageAttribution'])

  for (const [field, value] of Object.entries({
    name, artistType, mbid, wikidataQid, country, sortName, disambiguation,
    beginYear, endYear, imageUrl, imageAttribution,
  })) mark(field, value)

  return {
    artistUrl,
    name,
    sortName,
    disambiguation,
    artistType,
    country,
    mbid,
    wikidataQid,
    beginYear,
    endYear,
    imageUrl,
    imageAttribution,
    sourceMap,
    raw: d,
  }
}

export function mapVenue(venueUrl: string, d: AnyObject): GigVenueMetadata {
  const sourceMap: Record<string, GigSource> = {}
  const mark = (field: string, value: unknown): void => {
    if (value != null) sourceMap[field] = 'samklang-ap'
  }

  const name = strOrNull(d.name)
  const city = strOrNull(d['samklang:city'])
  const country = strOrNull(d['samklang:country'])
  const latitude = numStrOrNull(d.latitude)
  const longitude = numStrOrNull(d.longitude)
  const capacity = intOrNull(d['samklang:capacity'])
  const timezone = strOrNull(d['samklang:timezone'])
  const wikidataQid = strOrNull(d['samklang:wikidataQid'])
  const aka = toArray(d['samklang:aka'])
    .map((v) => strOrNull(v))
    .filter((v): v is string => v != null)

  for (const [field, value] of Object.entries({
    name, city, country, latitude, longitude, capacity, timezone, wikidataQid,
  })) mark(field, value)
  if (aka.length > 0) sourceMap.aka = 'samklang-ap'

  return {
    venueUrl,
    name,
    aka,
    city,
    country,
    latitude,
    longitude,
    capacity,
    timezone,
    wikidataQid,
    isPlaceholder: Boolean(d['samklang:isPlaceholder']),
    sourceMap,
    raw: d,
  }
}

/** Fetch a URL as ActivityPub JSON. Null on any failure, never a throw. */
async function fetchApJson(url: string, what: string): Promise<AnyObject | null> {
  let res: Response
  try {
    res = await fetch(url, { headers: SAMKLANG_AP_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (e) {
    logger.warn({ url, error: String(e) }, `Samklang ${what} fetch failed`)
    return null
  }
  if (!res.ok) {
    logger.warn({ url, status: res.status }, `Samklang ${what} fetch non-OK`)
    return null
  }
  try {
    return (await res.json()) as AnyObject
  } catch (e) {
    // Nearly always the Accept-header trap: an HTML page parsed as JSON. Say so, rather
    // than reporting a generic parse error that sends the next reader to the wrong place.
    logger.warn(
      { url, error: String(e) },
      `Samklang ${what} did not return JSON — check the Accept header does not mention text/html`,
    )
    return null
  }
}

/** The `MusicEvent` node out of a concert page's schema.org blocks, or null. */
export function extractMusicEventJsonLd(html: string): AnyObject | null {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]!.trim()) as AnyObject
      const type = parsed['@type']
      if (type === 'MusicEvent' || type === 'Event') return parsed
    } catch {
      // A page carries several of these; one being unparseable is not a reason to
      // abandon the others.
      continue
    }
  }
  return null
}

/**
 * The concert record: the ActivityPub Event, topped up from the page's schema.org
 * MusicEvent only when the Event left something out.
 */
export async function fetchConcert(concertUrl: string): Promise<GigConcertMetadata | null> {
  const document = await fetchApJson(concertUrl, 'concert')
  if (!document) return null
  const concert = mapConcertEvent(concertUrl, document)

  // The extras carry everything the fallback could supply, so the page is fetched only
  // when they are absent — i.e. against an origin older than Gigowl's ADR 0026.
  if (concert.gigDate != null && concert.lineup.length > 0 && concert.concertStatus != null) {
    return concert
  }

  try {
    const res = await fetch(concertUrl, {
      headers: SAMKLANG_HTML_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return concert
    return mergeJsonLd(concert, extractMusicEventJsonLd(await res.text()))
  } catch (e) {
    logger.warn({ concertUrl, error: String(e) }, 'Samklang concert page fetch failed; keeping the AP record')
    return concert
  }
}

export async function fetchArtist(artistUrl: string): Promise<GigArtistMetadata | null> {
  const document = await fetchApJson(artistUrl, 'artist')
  return document ? mapArtist(artistUrl, document) : null
}

export async function fetchVenue(venueUrl: string): Promise<GigVenueMetadata | null> {
  const document = await fetchApJson(venueUrl, 'venue')
  return document ? mapVenue(venueUrl, document) : null
}
