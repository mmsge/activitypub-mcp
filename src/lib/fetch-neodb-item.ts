import { logger } from './logger.js'

type AnyObject = Record<string, unknown>

// NeoDB serves the full catalog record (with `imdb`, `external_resources`, etc.)
// when the item URL is requested with an ActivityStreams Accept header — the same
// URL that federated marks carry as their tag `href`.
const NEODB_AP_HEADERS = {
  Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
}

const FETCH_TIMEOUT_MS = 10_000

// Column-shaped metadata for one NeoDB film/TV catalog item, persisted to
// catalog_metadata.
export interface NeodbItemMetadata {
  itemUrl: string
  category: string | null
  itemType: string | null
  title: string | null
  displayTitle: string | null
  origTitle: string | null
  description: string | null
  coverUrl: string | null
  imdb: string | null // bare IMDb id, e.g. tt27579939
  imdbUrl: string | null
  tmdbUrl: string | null
  externalResources: { url: string }[] | null
  year: number | null
  seasonNumber: number | null
  episodeCount: number | null
  genre: string[] | null
  director: string[] | null
  actors: string[] | null
  language: string[] | null
  area: string[] | null
  rating: number | null
  parentUuid: string | null
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

// NeoDB serializes director/actor/genre/language/area as string arrays; guard
// against a bare string or an inline { name } object just in case.
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

/**
 * Pure mapping: a fetched NeoDB catalog JSON object → the column-shaped record.
 * Kept separate from the fetch so it can be unit-tested without network.
 */
export function mapNeodbItem(itemUrl: string, d: AnyObject): NeodbItemMetadata {
  const externalResources = extractResources(d.external_resources)
  const imdb = extractImdbId(d, externalResources)
  return {
    itemUrl,
    category: strOrNull(d.category),
    itemType: strOrNull(d.type),
    title: strOrNull(d.title),
    displayTitle: strOrNull(d.display_title),
    origTitle: strOrNull(d.orig_title),
    description: strOrNull(d.description) ?? strOrNull(d.brief),
    coverUrl: strOrNull(d.cover_image_url),
    imdb,
    imdbUrl: imdb ? `https://www.imdb.com/title/${imdb}/` : findResource(externalResources, 'imdb.com'),
    tmdbUrl: findResource(externalResources, 'themoviedb.org'),
    externalResources,
    year: intOrNull(d.year),
    seasonNumber: intOrNull(d.season_number),
    episodeCount: intOrNull(d.episode_count),
    genre: strArray(d.genre),
    director: strArray(d.director),
    actors: strArray(d.actor),
    language: strArray(d.language),
    area: strArray(d.area),
    rating: numOrNull(d.rating),
    parentUuid: strOrNull(d.parent_uuid),
    raw: d,
  }
}

/**
 * Dereference a NeoDB catalog item URL to its full metadata. Returns null on any
 * network/parse failure — enrichment is best-effort and retried by the periodic sync.
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
