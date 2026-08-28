import { config, getOwnerInstanceHost } from '../config.js'
import { parseRetryAfter } from './probe-youtube-short.js'
import { logger } from './logger.js'
import type { ContextStatus } from './thread-context.js'

/**
 * One read of `GET /api/v1/statuses/:id/context` — the whole conversation below a root
 * in a single request.
 *
 * That is the reason the feature is affordable at all. Mastodon's context endpoint
 * returns the entire descendant subtree (bounded by the origin's own `MAX_DESCENDANTS`
 * and depth limits), not one level, so ~2,000 roots is ~2,000 requests rather than one
 * per reply. The tree-building is then arithmetic, done in `thread-context.ts`.
 *
 * **Unauthenticated first, and that is a privacy mechanism rather than an optimisation.**
 * An anonymous context can only ever contain public and unlisted statuses, so a
 * followers-only reply is never handed to this process in the first place — there is
 * nothing to filter, nothing to log by accident and nothing sitting in a response body.
 * MASTODON_ACCESS_TOKEN is used only when the instance refuses anonymous reads outright
 * (`DISALLOW_UNAUTHENTICATED_API_ACCESS`), and `buildThreadShape` applies the visibility
 * filter either way. Like `fetchRestLeg` in fetch-engagement.ts, the token is gated on
 * exact origin equality with OWNER_INSTANCE: it is useless against a remote host and
 * leaking it there would be worse than useless.
 */

const USER_AGENT = `activitypub-mcp/1.0 (+https://${config.APP_DOMAIN})`

export type ContextOutcome =
  | { ok: true; descendants: ContextStatus[]; authenticated: boolean }
  | { ok: false; code: 'rate_limited'; retryAfterMs: number | null; message: string }
  | { ok: false; code: 'not_found' | 'unauthorized' | 'fetch_failed'; message: string }

interface ContextBody {
  ancestors?: unknown
  descendants?: unknown
}

function contextUrl(origin: string, statusId: string): string {
  return `https://${origin}/api/v1/statuses/${encodeURIComponent(statusId)}/context`
}

async function readContext(
  url: string,
  origin: string,
  token: string | null,
  timeoutMs: number,
): Promise<ContextOutcome> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT }
  if (token) headers.Authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    return {
      ok: false,
      code: 'fetch_failed',
      message: `context fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  if (res.status === 429) {
    return {
      ok: false,
      code: 'rate_limited',
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), Date.now()),
      message: `HTTP 429 from ${origin}`,
    }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: 'unauthorized', message: `HTTP ${res.status} from ${origin}` }
  }
  if (res.status === 404 || res.status === 410) {
    // The root is gone from its own instance. Not an error to retry — a fact.
    return { ok: false, code: 'not_found', message: `HTTP ${res.status} for ${url}` }
  }
  if (!res.ok) {
    return { ok: false, code: 'fetch_failed', message: `HTTP ${res.status} from ${origin}` }
  }

  let body: ContextBody
  try {
    body = (await res.json()) as ContextBody
  } catch {
    return { ok: false, code: 'fetch_failed', message: 'context response was not JSON' }
  }
  if (!Array.isArray(body?.descendants)) {
    // A 200 that is not a Mastodon context: an SPA shell, or other software answering
    // the path. Never read as "this thread has no replies" — that would silently erase
    // a stored tree on the next walk.
    return { ok: false, code: 'fetch_failed', message: 'context response had no descendants array' }
  }

  return { ok: true, descendants: body.descendants as ContextStatus[], authenticated: token !== null }
}

/**
 * Read one thread's descendants. Anonymous, retried once with the owner's token only if
 * the instance refuses anonymous API access at all.
 */
export async function fetchThreadContext(
  origin: string,
  statusId: string,
  opts: { timeoutMs?: number } = {},
): Promise<ContextOutcome> {
  const timeoutMs = opts.timeoutMs ?? config.ENGAGEMENT_HTTP_TIMEOUT_MS
  const url = contextUrl(origin, statusId)

  const anonymous = await readContext(url, origin, null, timeoutMs)
  if (anonymous.ok || anonymous.code !== 'unauthorized') return anonymous

  const token = config.MASTODON_ACCESS_TOKEN
  if (!token || origin !== getOwnerInstanceHost()) return anonymous

  logger.debug({ origin, statusId }, 'Anonymous context refused; retrying with the owner token')
  return readContext(url, origin, token, timeoutMs)
}
