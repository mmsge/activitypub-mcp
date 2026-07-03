import { config, getOwnerInstanceHost } from '../config.js'
import { logger } from './logger.js'

/**
 * Live engagement reads for get_engagement: resolve a status reference to its
 * ORIGIN instance and read favourite/boost/reply counts there. Mastodon renders
 * these counts client-side, so scraping the permalink page yields nothing — the
 * clean sources are the origin's REST endpoint (GET /api/v1/statuses/:id, static
 * JSON, works unauthenticated for public posts) and, for non-Mastodon software,
 * the ActivityPub object's likes/shares/replies collection totals.
 */

const AP_ACCEPT =
  'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
const USER_AGENT = `activitypub-mcp/1.0 (+https://${config.APP_DOMAIN})`

export type StatusRef = {
  input: string
  origin: string // lowercase hostname of the origin instance
  statusId: string // origin-local id (Mastodon snowflake, GtS ULID, Misskey id, …)
  // Best-guess AP object URL for the fallback path. Null for bare ids (the
  // username is unknown, so only REST can resolve them).
  candidateApId: string | null
  restUrl: string // https://{origin}/api/v1/statuses/{statusId}
}

export type ItemErrorCode =
  | 'unresolved_origin'
  | 'not_found'
  | 'unauthorized'
  | 'unsupported_software'
  | 'rate_limited'
  | 'fetch_failed'

export type RefError = { error: 'unresolved_origin'; message: string }

export type EngagementCounts = {
  favourites: number
  reblogs: number
  replies: number
  quotes: number | null
}

export type FetchOutcome =
  | {
      ok: true
      counts: EngagementCounts
      source: 'rest' | 'ap'
      statusApId: string
      url: string | null
    }
  | { ok: false; code: Exclude<ItemErrorCode, 'unresolved_origin'>; message: string }

/**
 * Normalise one status reference to its origin + local id. Accepted forms:
 *   - Mastodon permalink   https://host/@user/123          (origin = host)
 *   - AP object id         https://host/users/u/statuses/123
 *   - any other status URL https://host/notes/abc          (Misskey, GtS, …)
 *   - bare id              123                              (needs OWNER_INSTANCE)
 * The origin is always taken from the reference's own host: the trailing id in a
 * status URL is that host's local id, so the counts must be read from that host.
 * Rejected: `/@user@otherhost/123` permalinks — that id is the viewing instance's
 * cache id for a remote post, and its counts there are not the origin's.
 */
export function parseStatusRef(raw: string, ownerInstanceHost: string): StatusRef | RefError {
  const input = raw.trim()
  if (!input) return { error: 'unresolved_origin', message: 'Empty status reference' }

  if (/^\d+$/.test(input)) {
    if (!ownerInstanceHost) {
      return {
        error: 'unresolved_origin',
        message: 'Bare status ids need OWNER_INSTANCE to be configured; pass a full URL instead',
      }
    }
    return {
      input,
      origin: ownerInstanceHost,
      statusId: input,
      candidateApId: null,
      restUrl: `https://${ownerInstanceHost}/api/v1/statuses/${input}`,
    }
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return {
      error: 'unresolved_origin',
      message: `Not a status URL or bare numeric id: ${input}`,
    }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'unresolved_origin', message: `Unsupported URL scheme: ${input}` }
  }

  const origin = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)
  const statusId = segments[segments.length - 1] ?? ''
  if (!statusId) {
    return { error: 'unresolved_origin', message: `No status id in URL path: ${input}` }
  }

  // Mastodon web permalink /@user/{id}. A second @ in the handle means the post
  // is being viewed on a non-origin instance and {id} is that instance's cache id.
  if (segments.length === 2 && segments[0].startsWith('@')) {
    const handle = segments[0].slice(1)
    if (handle.includes('@')) {
      return {
        error: 'unresolved_origin',
        message: `Remote-view permalink (${segments[0]}): its id is not the origin's — pass the post's original permalink instead`,
      }
    }
    return {
      input,
      origin,
      statusId,
      candidateApId: `https://${origin}/users/${handle}/statuses/${statusId}`,
      restUrl: `https://${origin}/api/v1/statuses/${statusId}`,
    }
  }

  // AP id form or any other status-URL shape: keep the URL itself (query/fragment
  // stripped) as the AP candidate and let REST → AP fallback sort out the rest.
  return {
    input,
    origin,
    statusId,
    candidateApId: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    restUrl: `https://${origin}/api/v1/statuses/${statusId}`,
  }
}

/** Map a REST /api/v1/statuses/:id HTTP status to a terminal error or the AP
 *  fallback. 404 may just mean "not Mastodon", so it falls through to AP. */
export function classifyRestStatus(
  status: number,
): 'unauthorized' | 'rate_limited' | 'try_ap' {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  return 'try_ap'
}

/**
 * Read collection totals from an AP Note-like object. Only inline `totalItems`
 * counts are used — collections given as bare URLs would need a second fetch per
 * collection, so they're treated as absent to keep one request per status.
 * Returns 'unsupported' when none of likes/shares/replies carries a total (e.g.
 * Misskey, which exposes no such collections).
 */
export function extractApCounts(obj: unknown): EngagementCounts | 'unsupported' {
  if (!obj || typeof obj !== 'object') return 'unsupported'
  const o = obj as Record<string, unknown>
  const total = (v: unknown): number | null => {
    if (!v || typeof v !== 'object') return null
    const t = (v as Record<string, unknown>).totalItems
    return typeof t === 'number' && Number.isFinite(t) ? t : null
  }
  const likes = total(o.likes)
  const shares = total(o.shares)
  const replies = total(o.replies)
  if (likes === null && shares === null && replies === null) return 'unsupported'
  return {
    favourites: likes ?? 0,
    reblogs: shares ?? 0,
    replies: replies ?? 0,
    quotes: null,
  }
}

/** Order-preserving concurrency-capped map — the per-origin politeness cap for
 *  batch fetches without pulling in a pool dependency. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

type RestStatusBody = {
  uri?: string
  url?: string
  favourites_count?: number
  reblogs_count?: number
  replies_count?: number
  quotes_count?: number | null
}

async function fetchRestLeg(ref: StatusRef, timeoutMs: number): Promise<FetchOutcome | 'try_ap'> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  }
  // A skvip.lol token is useless (and leaky) against remote instances — the
  // Authorization header is gated on exact origin equality with OWNER_INSTANCE.
  if (config.MASTODON_ACCESS_TOKEN && ref.origin === getOwnerInstanceHost()) {
    headers.Authorization = `Bearer ${config.MASTODON_ACCESS_TOKEN}`
  }

  let res: Response
  try {
    res = await fetch(ref.restUrl, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    logger.debug({ url: ref.restUrl, error: e }, 'Engagement REST fetch failed')
    return 'try_ap'
  }

  if (!res.ok) {
    const cls = classifyRestStatus(res.status)
    if (cls === 'unauthorized') {
      return { ok: false, code: 'unauthorized', message: `REST HTTP ${res.status} from ${ref.origin}` }
    }
    if (cls === 'rate_limited') {
      return { ok: false, code: 'rate_limited', message: `REST HTTP 429 from ${ref.origin}` }
    }
    return 'try_ap'
  }

  let body: RestStatusBody
  try {
    body = (await res.json()) as RestStatusBody
  } catch {
    return 'try_ap'
  }
  if (typeof body?.favourites_count !== 'number' || typeof body?.reblogs_count !== 'number') {
    return 'try_ap' // 200 but not a Mastodon-shaped status (SPA shell, other software)
  }

  return {
    ok: true,
    counts: {
      favourites: body.favourites_count,
      reblogs: body.reblogs_count,
      replies: typeof body.replies_count === 'number' ? body.replies_count : 0,
      quotes: typeof body.quotes_count === 'number' ? body.quotes_count : null,
    },
    source: 'rest',
    statusApId: body.uri ?? ref.candidateApId ?? ref.restUrl,
    url: body.url ?? null,
  }
}

async function fetchApLeg(ref: StatusRef, timeoutMs: number): Promise<FetchOutcome> {
  if (!ref.candidateApId) {
    return { ok: false, code: 'not_found', message: 'Bare id has no AP object URL to fall back to' }
  }

  let res: Response
  try {
    res = await fetch(ref.candidateApId, {
      headers: { Accept: AP_ACCEPT, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    return {
      ok: false,
      code: 'fetch_failed',
      message: `AP fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'unauthorized', message: `AP HTTP ${res.status} from ${ref.origin}` }
    }
    if (res.status === 404 || res.status === 410) {
      return { ok: false, code: 'not_found', message: `AP HTTP ${res.status} for ${ref.candidateApId}` }
    }
    if (res.status === 429) {
      return { ok: false, code: 'rate_limited', message: `AP HTTP 429 from ${ref.origin}` }
    }
    return { ok: false, code: 'fetch_failed', message: `AP HTTP ${res.status} from ${ref.origin}` }
  }

  let obj: unknown
  try {
    obj = await res.json()
  } catch {
    return { ok: false, code: 'fetch_failed', message: 'AP response was not JSON' }
  }

  const counts = extractApCounts(obj)
  if (counts === 'unsupported') {
    return {
      ok: false,
      code: 'unsupported_software',
      message: `${ref.origin} exposes no likes/shares/replies totals on the AP object`,
    }
  }

  const apId = (obj as Record<string, unknown>).id
  return {
    ok: true,
    counts,
    source: 'ap',
    statusApId: typeof apId === 'string' ? apId : ref.candidateApId,
    url: null,
  }
}

/**
 * Fetch live engagement counts for one resolved reference. REST is tried first
 * (authoritative counts), the AP object second — except with prefer:'ap', which
 * swaps the order (bare ids always go REST-first: they have no AP URL). A 429 on
 * either leg is terminal so a rate-limiting host isn't hit again immediately.
 */
export async function fetchEngagement(
  ref: StatusRef,
  opts: { prefer: 'rest' | 'ap'; timeoutMs: number },
): Promise<FetchOutcome> {
  if (opts.prefer === 'ap' && ref.candidateApId) {
    const ap = await fetchApLeg(ref, opts.timeoutMs)
    if (ap.ok || ap.code === 'rate_limited' || ap.code === 'unauthorized') return ap
    const rest = await fetchRestLeg(ref, opts.timeoutMs)
    return rest === 'try_ap' ? ap : rest
  }

  const rest = await fetchRestLeg(ref, opts.timeoutMs)
  if (rest !== 'try_ap') return rest
  return fetchApLeg(ref, opts.timeoutMs)
}
