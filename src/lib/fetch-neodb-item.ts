import { logger } from './logger.js'

type AnyObject = Record<string, unknown>

// NeoDB serves the full catalog record (with `imdb`, `external_resources`, creators,
// category-specific fields, …) when the item URL is requested with an ActivityStreams
// Accept header — the same URL that federated marks carry as their tag `href`.
//
// IMPORTANT: send a SINGLE media type. minreol.dk's content negotiation returns the
// HTML page (not JSON) for the combined `application/activity+json, application/ld+json;
// profile="…"` header — the earlier value here — which made `res.json()` throw on
// `<!DOCTYPE html>` and left the cache empty (total: 0). See ADR 0006.
const NEODB_AP_HEADERS = {
  Accept: 'application/activity+json',
}

const FETCH_TIMEOUT_MS = 10_000

// Fields shared by every NeoDB category, always mapped to columns.
export interface NeodbCommonMetadata {
  itemUrl: string
  category: string | null
  itemType: string | null
  title: string | null
  displayTitle: string | null
  origTitle: string | null
  description: string | null
  coverUrl: string | null
  year: number | null
  genre: string[] | null
  language: string[] | null
  area: string[] | null
  rating: number | null
  externalResources: { url: string }[] | null
}

// Film/TV-only columns (kept as columns because get_watched surfaces them directly).
export interface NeodbScreenMetadata {
  imdb: string | null // bare IMDb id, e.g. tt27579939
  imdbUrl: string | null
  tmdbUrl: string | null
  seasonNumber: number | null
  episodeCount: number | null
  director: string[] | null
  actors: string[] | null
  parentUuid: string | null
}

// The full column-shaped record persisted to catalog_metadata.
export interface NeodbItemMetadata extends NeodbCommonMetadata, NeodbScreenMetadata {
  // Category-specific fields, normalized per category ({} for unknown categories).
  details: Record<string, unknown>
  // Pulled up from `details` for the book/BookWyrm dedup join; also present in details.
  isbn: string | null
  // Set by the impure enrichment step when a NeoDB book dedupes to a cached BookWyrm
  // Edition (the matched book_metadata.book_url); null for everything else.
  bookwyrmBookUrl: string | null
  // { outputField: 'neodb' } for every populated field. The impure enrichment step
  // may flip some book fields to 'bookwyrm' when deduped against the BookWyrm cache.
  sourceMap: Record<string, string>
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

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// NeoDB serializes creators/genre/language/area as string arrays; guard against a
// bare string or an inline { name } object just in case.
function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return typeof v === 'string' && v.trim() ? [v] : null
  const out = v
    .map((e) => (typeof e === 'string' ? e : (e as AnyObject)?.name))
    .filter((e): e is string => typeof e === 'string' && e.trim() !== '')
  return out.length ? out : null
}

function extractResources(v: unknown): { url: string }[] | null {
  if (!Array.isArray(v)) return null
  const out = v
    .map((e) => strOrNull((e as AnyObject)?.url))
    .filter((u): u is string => !!u)
    .map((url) => ({ url }))
  return out.length ? out : null
}

// The tt-prefixed IMDb id, whether NeoDB gives it directly (`imdb`) or only as a
// www.imdb.com/title/<id> external resource.
function extractImdbId(d: AnyObject, resources: { url: string }[] | null): string | null {
  const direct = strOrNull(d.imdb)
  if (direct) return direct
  for (const r of resources ?? []) {
    const m = r.url.match(/imdb\.com\/title\/(tt\d+)/i)
    if (m) return m[1]
  }
  return null
}

function findResource(resources: { url: string }[] | null, host: string): string | null {
  for (const r of resources ?? []) if (r.url.includes(host)) return r.url
  return null
}

// A leading 4-digit year from a (possibly partial) date string like "1969-09-26".
function yearOf(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v !== 'string') continue
    const m = /(\d{4})/.exec(v)
    if (m) return Number(m[1])
  }
  return null
}

// NeoDB serializes an album's tracks as a newline-delimited string
// ("1. Come Together\n2. Something\n…"). Count the numbered lines; fall back to
// non-empty line count for un-numbered lists.
function trackCount(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const lines = v.split('\n').map((l) => l.trim()).filter(Boolean)
  const numbered = lines.filter((l) => /^\d+\s*[.)]/.test(l)).length
  const n = numbered || lines.length
  return n > 0 ? n : null
}

// A podcast's RSS feed URL. NeoDB keys podcasts by their feed and exposes it as an
// external resource; prefer one that looks like a feed, else the first resource.
function feedUrlOf(resources: { url: string }[] | null): string | null {
  if (!resources?.length) return null
  const feedish = resources.find((r) => /rss|feed|\.xml|simplecast|libsyn|megaphone|buzzsprout|anchor\.fm|acast/i.test(r.url))
  return (feedish ?? resources[0]).url
}

// Screen (film/TV) item types — the ones whose creators/ids map to the dedicated
// columns rather than to `details`.
const SCREEN_TYPES = new Set(['Movie', 'TVShow', 'TVSeason', 'TVEpisode'])

// Drop null/empty values so `details` and `sourceMap` only carry populated fields.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

/**
 * Pure mapping: a fetched NeoDB catalog JSON object → the column-shaped record. Kept
 * separate from the fetch so it can be unit-tested without network. Handles every
 * NeoDB category; an unrecognised category still yields the common fields + raw and
 * never throws.
 */
export function mapNeodbItem(itemUrl: string, d: AnyObject): NeodbItemMetadata {
  const externalResources = extractResources(d.external_resources)
  const category = strOrNull(d.category)
  const itemType = strOrNull(d.type)

  const common: NeodbCommonMetadata = {
    itemUrl,
    category,
    itemType,
    title: strOrNull(d.title),
    displayTitle: strOrNull(d.display_title),
    origTitle: strOrNull(d.orig_title),
    description: strOrNull(d.description) ?? strOrNull(d.brief),
    coverUrl: strOrNull(d.cover_image_url),
    year: intOrNull(d.year),
    genre: strArray(d.genre),
    language: strArray(d.language),
    area: strArray(d.area),
    rating: numOrNull(d.rating),
    externalResources,
  }

  // Screen columns default to null; only film/TV fills them.
  const screen: NeodbScreenMetadata = {
    imdb: null,
    imdbUrl: null,
    tmdbUrl: null,
    seasonNumber: null,
    episodeCount: null,
    director: null,
    actors: null,
    parentUuid: null,
  }

  let details: Record<string, unknown> = {}
  let isbn: string | null = null

  if (itemType && SCREEN_TYPES.has(itemType)) {
    const imdb = extractImdbId(d, externalResources)
    screen.imdb = imdb
    screen.imdbUrl = imdb ? `https://www.imdb.com/title/${imdb}/` : findResource(externalResources, 'imdb.com')
    screen.tmdbUrl = findResource(externalResources, 'themoviedb.org')
    screen.seasonNumber = intOrNull(d.season_number)
    screen.episodeCount = intOrNull(d.episode_count)
    screen.director = strArray(d.director)
    screen.actors = strArray(d.actor)
    screen.parentUuid = strOrNull(d.parent_uuid)
  } else if (category === 'book' || itemType === 'Edition') {
    isbn = strOrNull(d.isbn)
    common.year = common.year ?? intOrNull(d.pub_year)
    details = compact({
      author: strArray(d.author),
      translator: strArray(d.translator),
      isbn,
      pages: intOrNull(d.pages),
      publisher: strOrNull(d.pub_house),
      pub_year: intOrNull(d.pub_year),
      pub_month: intOrNull(d.pub_month),
      binding: strOrNull(d.binding),
      price: strOrNull(d.price),
      series: strOrNull(d.series),
      subtitle: strOrNull(d.subtitle),
      imprint: strOrNull(d.imprint),
    })
  } else if (category === 'music' || itemType === 'Album') {
    common.year = common.year ?? yearOf(d.release_date)
    details = compact({
      artist: strArray(d.artist),
      release_date: strOrNull(d.release_date),
      track_count: trackCount(d.track_list),
      barcode: strOrNull(d.barcode),
      company: strArray(d.company),
      duration: intOrNull(d.duration),
    })
  } else if (category === 'game' || itemType === 'Game') {
    common.year = common.year ?? yearOf(d.release_date)
    details = compact({
      developer: strArray(d.developer),
      publisher: strArray(d.publisher),
      platform: strArray(d.platform),
      release_date: strOrNull(d.release_date),
      release_type: strOrNull(d.release_type),
      official_site: strOrNull(d.official_site),
    })
  } else if (category === 'podcast' || itemType === 'Podcast') {
    details = compact({
      host: strArray(d.host) ?? strArray(d.hosts),
      feed_url: feedUrlOf(externalResources),
      official_site: strOrNull(d.official_site),
    })
  } else if (category === 'performance' || itemType === 'Performance' || itemType === 'PerformanceProduction') {
    common.year = common.year ?? yearOf(d.opening_date)
    details = compact({
      playwright: strArray(d.playwright),
      director: strArray(d.director),
      // NeoDB names the venue `location`; `troupe` may or may not be present.
      troupe: strArray(d.troupe),
      venue: strArray(d.location),
      opening_date: strOrNull(d.opening_date),
      closing_date: strOrNull(d.closing_date),
      orig_creator: strArray(d.orig_creator),
      composer: strArray(d.composer),
      choreographer: strArray(d.choreographer),
      performer: strArray(d.performer),
      actor: strArray(d.actor),
      crew: strArray(d.crew),
    })
  }
  // else: unknown/new category → common fields + raw only (details stays {}).

  const record: NeodbItemMetadata = {
    ...common,
    ...screen,
    details,
    isbn,
    bookwyrmBookUrl: null,
    sourceMap: {},
    raw: d,
  }
  record.sourceMap = buildSourceMap(record)
  return record
}

// Every populated field (common columns, screen columns, and detail keys) records
// 'neodb' as its origin, mirroring get_book_details' source_map. The enrichment step
// can later override individual book fields to 'bookwyrm' when deduped.
function buildSourceMap(m: NeodbItemMetadata): Record<string, string> {
  const map: Record<string, string> = {}
  const mark = (field: string, value: unknown) => {
    if (value == null) return
    if (typeof value === 'string' && value.trim() === '') return
    if (Array.isArray(value) && value.length === 0) return
    map[field] = 'neodb'
  }
  mark('title', m.title)
  mark('display_title', m.displayTitle)
  mark('orig_title', m.origTitle)
  mark('description', m.description)
  mark('cover_url', m.coverUrl)
  mark('year', m.year)
  mark('genre', m.genre)
  mark('language', m.language)
  mark('area', m.area)
  mark('rating', m.rating)
  mark('external_resources', m.externalResources)
  mark('imdb', m.imdb)
  mark('imdb_url', m.imdbUrl)
  mark('tmdb_url', m.tmdbUrl)
  mark('season_number', m.seasonNumber)
  mark('episode_count', m.episodeCount)
  mark('director', m.director)
  mark('actors', m.actors)
  for (const [k, v] of Object.entries(m.details)) mark(k, v)
  return map
}

/**
 * Dereference a NeoDB catalog item URL to its full metadata. Returns null on any
 * network/parse failure — the caller records the failure so it's retried, never
 * silently dropped.
 */
export async function fetchNeodbItem(itemUrl: string): Promise<NeodbItemMetadata | null> {
  let res: Response
  try {
    res = await fetch(itemUrl, { headers: NEODB_AP_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (e) {
    logger.warn({ itemUrl, error: String(e) }, 'NeoDB item fetch failed')
    return null
  }
  if (!res.ok) {
    logger.warn({ itemUrl, status: res.status }, 'NeoDB item fetch non-OK')
    return null
  }
  let data: AnyObject
  try {
    data = (await res.json()) as AnyObject
  } catch (e) {
    logger.warn({ itemUrl, error: String(e) }, 'NeoDB item JSON parse failed')
    return null
  }
  return mapNeodbItem(itemUrl, data)
}
