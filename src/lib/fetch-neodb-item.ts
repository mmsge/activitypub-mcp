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
  // True when NeoDB still served a URL where the title belongs. A freshly drafted item
  // carries its source URL as its title for a while; the row is written with the best
  // real title found, but flagged so the enrichment retry path fetches it again.
  titlePlaceholder: boolean
  raw: unknown
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

// A "title" that is really a URL. NeoDB fills an item drafted from a web page with that
// page's address until someone names it, and the mark federated in that window carries
// the same address as its tag `name`. It is never a title, in any category.
export function isUrlTitle(v: unknown): boolean {
  return typeof v === 'string' && /^\s*https?:\/\//i.test(v)
}

function realTitle(v: unknown): string | null {
  const s = strOrNull(v)
  return s && !isUrlTitle(s) ? s : null
}

function firstLocalizedTitle(v: unknown): string | null {
  if (!Array.isArray(v)) return null
  for (const e of v) {
    const t = realTitle((e as AnyObject)?.text)
    if (t) return t
  }
  return null
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

// NeoDB credit role → the performance `details` key it folds into. The flat arrays
// (`director`, `actor`, …) do not carry every role: a troupe exists ONLY as a credit, so
// reading the flat fields alone drops the one thing a theatre visit is most often known by.
const PERFORMANCE_CREDIT_KEYS: Record<string, string> = {
  troupe: 'troupe',
  playwright: 'playwright',
  director: 'director',
  original_creator: 'orig_creator',
  composer: 'composer',
  choreographer: 'choreographer',
  performer: 'performer',
  actor: 'actor',
  crew: 'crew',
}

// Names per details key from a NeoDB `credits` array, in credit order.
function creditsByKey(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!Array.isArray(v)) return out
  for (const c of v) {
    const role = strOrNull((c as AnyObject)?.role)
    const name = strOrNull((c as AnyObject)?.name)
    const key = role ? PERFORMANCE_CREDIT_KEYS[role] : undefined
    if (!key || !name) continue
    ;(out[key] ??= []).push(name.trim())
  }
  return out
}

// The union of two name lists, first-seen order, deduped. Null when both are empty.
function mergeNames(a: string[] | null, b: string[] | undefined): string[] | null {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of [...(a ?? []), ...(b ?? [])]) {
    const t = n.trim()
    if (t && !seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out.length ? out : null
}

// Actors with the part they played, when NeoDB knows it (`actor: [{name, role}]`, or a
// credit's `character_name`). Null when no actor has a part, so `details` stays lean.
function castOf(d: AnyObject): { name: string; role: string }[] | null {
  const out: { name: string; role: string }[] = []
  const seen = new Set<string>()
  const push = (name: unknown, role: unknown) => {
    const n = strOrNull(name)?.trim()
    const r = strOrNull(role)?.trim()
    if (!n || !r || seen.has(`${n}\u0000${r}`)) return
    seen.add(`${n}\u0000${r}`)
    out.push({ name: n, role: r })
  }
  if (Array.isArray(d.actor)) for (const a of d.actor) push((a as AnyObject)?.name, (a as AnyObject)?.role)
  if (Array.isArray(d.credits)) {
    for (const c of d.credits) {
      if ((c as AnyObject)?.role === 'actor') push((c as AnyObject)?.name, (c as AnyObject)?.character_name)
    }
  }
  return out.length ? out : null
}

// The play a NeoDB `PerformanceProduction` is a staging of, as a catalogue URL on the
// same instance. NeoDB links a production to its play by `parent_uuid` alone.
function playUrlOf(itemUrl: string, parentUuid: string | null): string | null {
  if (!parentUuid) return null
  try {
    return new URL(`/performance/${parentUuid}`, itemUrl).toString()
  } catch {
    return null
  }
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

  // The best real title NeoDB has: its display title, its title, a localized title, and
  // only then `orig_title` (which on a theatre production carries a "(Troupe)" suffix).
  const bestTitle = realTitle(d.display_title) ?? realTitle(d.title)
    ?? firstLocalizedTitle(d.localized_title) ?? realTitle(d.orig_title)
  const titlePlaceholder = isUrlTitle(d.title) || isUrlTitle(d.display_title)

  const common: NeodbCommonMetadata = {
    itemUrl,
    category,
    itemType,
    title: realTitle(d.title) ?? bestTitle,
    displayTitle: realTitle(d.display_title) ?? bestTitle,
    origTitle: realTitle(d.orig_title),
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
    const credits = creditsByKey(d.credits)
    screen.parentUuid = strOrNull(d.parent_uuid)
    details = compact({
      playwright: mergeNames(strArray(d.playwright), credits.playwright),
      director: mergeNames(strArray(d.director), credits.director),
      // A troupe is only ever a credit on NeoDB (`role: "troupe"`); `troupe` is read too
      // in case a future NeoDB grows the flat field.
      troupe: mergeNames(strArray(d.troupe), credits.troupe),
      // NeoDB names the venue `location`.
      venue: strArray(d.location),
      opening_date: strOrNull(d.opening_date),
      closing_date: strOrNull(d.closing_date),
      orig_creator: mergeNames(strArray(d.orig_creator), credits.orig_creator),
      composer: mergeNames(strArray(d.composer), credits.composer),
      choreographer: mergeNames(strArray(d.choreographer), credits.choreographer),
      performer: mergeNames(strArray(d.performer), credits.performer),
      actor: mergeNames(strArray(d.actor), credits.actor),
      cast: castOf(d),
      crew: mergeNames(strArray(d.crew), credits.crew),
      official_site: strOrNull(d.official_site),
      // A production (one staging) points at the play it stages.
      play_url: itemType === 'PerformanceProduction' ? playUrlOf(itemUrl, screen.parentUuid) : null,
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
    titlePlaceholder,
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
