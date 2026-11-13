/**
 * English metadata for film and TV, read from TMDB itself (ADR 0076).
 *
 * neodb.social's catalogue often takes credits and descriptions from Douban, so an item
 * marked there arrives with its director, actors and description in Chinese. Every film
 * and TV item NeoDB links to TMDB is therefore re-read from the TMDB API in `en-US`
 * after NeoDB enrichment, and TMDB's values win where it has them. NeoDB's stay as the
 * fallback for any field TMDB leaves empty.
 *
 * Rules not to "simplify" back:
 *
 * - **A failed TMDB call never blocks the mark.** The item is stored with NeoDB's values
 *   and `tmdb_error` set, and the periodic sync retries it, like `fetch_attempts`.
 * - **A season reads the season AND the show.** The season gives its own name, overview,
 *   air date, episodes and credits; the show gives genres and creators, which TMDB only
 *   keeps on the show.
 * - **Season number and episode count follow TMDB when it disagrees, and say so.** The
 *   disagreement is logged rather than silently resolved.
 * - **Only an item whose TMDB link names its own kind is refined.** The link is read
 *   through the same `tmdbKey` the work grouping uses, so a season carrying the show's
 *   link is left alone rather than given the show's metadata.
 */
import type { NeodbItemMetadata } from './fetch-neodb-item.js'
import { tmdbKey } from './work-key.js'
import { config } from '../config.js'
import { logger } from './logger.js'

/** How many top-billed actors are kept, in billing order. */
export const TMDB_TOP_ACTORS = 10
/** A TMDB failure stops being retried after this many attempts. */
export const TMDB_MAX_ATTEMPTS = 5
const TMDB_TIMEOUT_MS = 10_000

export type TmdbTarget =
  | { kind: 'movie'; id: string }
  | { kind: 'tv'; id: string }
  | { kind: 'season'; id: string; season: number }

/** What to fetch for this item, or null when it is not refinable. */
export function tmdbTargetOf(meta: Pick<NeodbItemMetadata, 'itemUrl' | 'category' | 'itemType' | 'tmdbUrl' | 'imdb'>): TmdbTarget | null {
  const key = tmdbKey({
    itemUrl: meta.itemUrl, category: meta.category, itemType: meta.itemType,
    tmdbUrl: meta.tmdbUrl, imdb: meta.imdb,
  })
  if (!key) return null
  const m = /^tmdb:(movie|tv)\/(\d+)(?:\/season\/(\d+))?$/.exec(key)
  if (!m) return null
  const [, type, id, season] = m
  if (type === 'movie') return { kind: 'movie', id }
  if (season != null) return { kind: 'season', id, season: Number(season) }
  return { kind: 'tv', id }
}

export type TmdbFetch = (path: string) => Promise<{ status: number; data: unknown }>

/**
 * The real transport. A v4 read access token is a JWT and goes in the Authorization
 * header; anything else is taken as a v3 API key and goes in the query string.
 */
export function tmdbFetch(token = config.TMDB_API_TOKEN, base = config.TMDB_API_URL): TmdbFetch {
  const isBearer = token.split('.').length === 3
  return async (path) => {
    const url = new URL(base.replace(/\/$/, '') + path)
    url.searchParams.set('language', 'en-US')
    if (!isBearer) url.searchParams.set('api_key', token)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (isBearer) headers.Authorization = `Bearer ${token}`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) })
    const data = res.ok ? await res.json() : null
    return { status: res.status, data }
  }
}

type Obj = Record<string, unknown>

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function yearOf(v: unknown): number | null {
  const s = str(v)
  const m = s ? /^(\d{4})/.exec(s) : null
  return m ? Number(m[1]) : null
}

function uniq(names: (string | null)[]): string[] {
  const out: string[] = []
  for (const n of names) if (n && !out.includes(n)) out.push(n)
  return out
}

function genresOf(v: unknown): string[] {
  return Array.isArray(v) ? uniq(v.map((g) => str(obj(g).name))) : []
}

function creatorsOf(show: Obj): string[] {
  return Array.isArray(show.created_by) ? uniq(show.created_by.map((c) => str(obj(c).name))) : []
}

/** Cast in billing order (`order` ascending), top N. */
function topActors(credits: Obj): string[] {
  const cast = Array.isArray(credits.cast) ? credits.cast.map(obj) : []
  cast.sort((a, b) => Number(a.order ?? 1e9) - Number(b.order ?? 1e9))
  return uniq(cast.map((c) => str(c.name))).slice(0, TMDB_TOP_ACTORS)
}

/** Directors off a credits crew list: `job` (credits) or `jobs[].job` (aggregate_credits). */
function directorsOf(credits: Obj): string[] {
  const crew = Array.isArray(credits.crew) ? credits.crew.map(obj) : []
  const isDirector = (c: Obj) =>
    c.job === 'Director' ||
    (Array.isArray(c.jobs) && c.jobs.some((j) => obj(j).job === 'Director'))
  const directors = crew.filter(isDirector)
  // A season's directors each took some episodes: the busiest first.
  directors.sort((a, b) => Number(b.total_episode_count ?? 0) - Number(a.total_episode_count ?? 0))
  return uniq(directors.map((c) => str(c.name)))
}

/** "Vision Quest Season 1" for TMDB's stock "Season 1"; "Show: Book One" otherwise. */
function seasonTitle(show: string | null, seasonName: string | null, n: number): string | null {
  if (!show) return seasonName
  if (!seasonName || /^season \d+$/i.test(seasonName)) return `${show} Season ${n}`
  return `${show}: ${seasonName}`
}

/** TMDB's fields, read off its responses. Empty fields are null, never "". */
export interface TmdbFields {
  title: string | null
  origTitle: string | null
  year: number | null
  description: string | null
  genre: string[]
  director: string[]
  actors: string[]
  creators: string[]
  seasonNumber: number | null
  episodeCount: number | null
}

export function tmdbFieldsOf(target: TmdbTarget, primary: unknown, show?: unknown): TmdbFields {
  const p = obj(primary)
  if (target.kind === 'movie') {
    const credits = obj(p.credits)
    return {
      title: str(p.title), origTitle: str(p.original_title), year: yearOf(p.release_date),
      description: str(p.overview), genre: genresOf(p.genres),
      director: directorsOf(credits), actors: topActors(credits), creators: [],
      seasonNumber: null, episodeCount: null,
    }
  }
  if (target.kind === 'tv') {
    const credits = obj(p.aggregate_credits ?? p.credits)
    const creators = creatorsOf(p)
    return {
      title: str(p.name), origTitle: str(p.original_name), year: yearOf(p.first_air_date),
      description: str(p.overview), genre: genresOf(p.genres),
      // A show's "director" is who made it: TMDB keeps no show-level director.
      director: creators, actors: topActors(credits), creators,
      seasonNumber: null, episodeCount: null,
    }
  }
  const s = obj(show)
  const credits = obj(p.aggregate_credits ?? p.credits)
  const creators = creatorsOf(s)
  const n = typeof p.season_number === 'number' ? p.season_number : target.season
  const directors = directorsOf(credits)
  return {
    title: seasonTitle(str(s.name), str(p.name), n),
    origTitle: str(s.original_name) ? seasonTitle(str(s.original_name), str(p.name), n) : null,
    year: yearOf(p.air_date),
    description: str(p.overview) ?? str(s.overview),
    genre: genresOf(s.genres),
    director: directors.length ? directors : creators,
    actors: topActors(credits),
    creators,
    seasonNumber: typeof p.season_number === 'number' ? p.season_number : null,
    episodeCount: Array.isArray(p.episodes) ? p.episodes.length : null,
  }
}

/**
 * Lay TMDB's fields over NeoDB's, in place. A field TMDB leaves empty keeps NeoDB's
 * value and its 'neodb' provenance; every field taken from TMDB is marked 'tmdb' in
 * `sourceMap`. Returns the disagreements on season number and episode count.
 */
export function applyTmdbFields(meta: NeodbItemMetadata, f: TmdbFields): string[] {
  const set = <K extends keyof NeodbItemMetadata>(key: K, field: string, value: NeodbItemMetadata[K] | null) => {
    if (value == null) return
    if (Array.isArray(value) && value.length === 0) return
    meta[key] = value as NeodbItemMetadata[K]
    meta.sourceMap[field] = 'tmdb'
  }
  set('title', 'title', f.title)
  set('displayTitle', 'display_title', f.title)
  set('origTitle', 'orig_title', f.origTitle)
  set('year', 'year', f.year)
  set('description', 'description', f.description)
  set('genre', 'genre', f.genre)
  set('director', 'director', f.director)
  set('actors', 'actors', f.actors)
  if (f.creators.length) {
    meta.details = { ...meta.details, creators: f.creators }
    meta.sourceMap.creators = 'tmdb'
  }

  const disagreements: string[] = []
  const reconcile = (key: 'seasonNumber' | 'episodeCount', field: string, value: number | null) => {
    if (value == null) return
    const neodb = meta[key]
    if (neodb != null && neodb !== value) disagreements.push(`${field}: NeoDB ${neodb}, TMDB ${value}`)
    if (neodb !== value) {
      meta[key] = value
      meta.sourceMap[field] = 'tmdb'
    }
  }
  reconcile('seasonNumber', 'season_number', f.seasonNumber)
  reconcile('episodeCount', 'episode_count', f.episodeCount)
  return disagreements
}

/** What the refiner did to one item, for the upsert's bookkeeping columns. */
export type TmdbOutcome =
  /** Not a refinable item, or the refiner is off: the TMDB columns are cleared. */
  | { status: 'skipped' }
  | { status: 'refined'; raw: unknown }
  /** `retry: false` for a link TMDB does not know (404): asking again will not help. */
  | { status: 'failed'; error: string; retry: boolean }

/**
 * Refine one freshly fetched item in place. Never throws: every failure comes back as
 * `failed`, and the item keeps NeoDB's values.
 */
export async function refineWithTmdb(
  meta: NeodbItemMetadata,
  fetcher: TmdbFetch | null = config.TMDB_API_TOKEN ? tmdbFetch() : null,
): Promise<TmdbOutcome> {
  if (!fetcher) return { status: 'skipped' }
  const target = tmdbTargetOf(meta)
  if (!target) return { status: 'skipped' }

  const paths =
    target.kind === 'movie' ? [`/movie/${target.id}?append_to_response=credits`]
    : target.kind === 'tv' ? [`/tv/${target.id}?append_to_response=aggregate_credits`]
    : [`/tv/${target.id}/season/${target.season}?append_to_response=aggregate_credits`, `/tv/${target.id}`]

  try {
    const responses = []
    for (const path of paths) {
      const res = await fetcher(path)
      if (res.status === 404) return { status: 'failed', error: `TMDB has no ${path.split('?')[0]}`, retry: false }
      if (res.status < 200 || res.status >= 300 || res.data == null) {
        return { status: 'failed', error: `TMDB ${path.split('?')[0]} answered ${res.status}`, retry: true }
      }
      responses.push(res.data)
    }
    const fields = tmdbFieldsOf(target, responses[0], responses[1])
    const disagreements = applyTmdbFields(meta, fields)
    if (disagreements.length) {
      logger.warn({ itemUrl: meta.itemUrl, tmdbUrl: meta.tmdbUrl, disagreements }, 'TMDB disagrees with NeoDB; TMDB wins')
    }
    const raw = target.kind === 'season' ? { season: responses[0], show: responses[1] } : { [target.kind]: responses[0] }
    return { status: 'refined', raw }
  } catch (e) {
    return { status: 'failed', error: `TMDB request failed: ${e instanceof Error ? e.message : String(e)}`, retry: true }
  }
}
