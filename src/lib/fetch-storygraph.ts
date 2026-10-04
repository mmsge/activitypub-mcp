import { logger } from './logger.js'

/**
 * sidetal's JSON API — the StoryGraph reading journal, scraped nightly on the same box.
 * See ADR 0062 here and ADR 0002 in mmsge/storygraph-leser.
 *
 * Shaped like `fetch-linkedin-snapshot.ts`, NOT like `fetch-lastfm.ts`, and for the same
 * reason: the caller stops paging when a page comes back without a `next_cursor`, so a
 * fetcher that collapsed a failure into an empty page would turn a refused token into a
 * clean, successful, zero-row run — and a reading journal is quiet often enough that
 * nobody would notice for weeks. So every result is either data or an error, each with a
 * trace (URL, status, body, timing) that the job records verbatim in source_sync_state.
 *
 * The token travels only in the Authorization header. The URL in a trace is safe to log.
 */

const FETCH_TIMEOUT_MS = 20_000

/** Bound on a stored body. sidetal's error bodies are tiny; a data page is clipped. */
const MAX_TRACE_BODY = 2000

export interface StorygraphTrace {
  url: string
  /** 0 when no response arrived at all — timeout, connection refused, DNS. */
  status: number
  body: string
  durationMs: number
}

export type StorygraphResult<T> =
  | { kind: 'data'; data: T; trace: StorygraphTrace }
  | { kind: 'error'; status: number; message: string; trace: StorygraphTrace }

export interface EntriesPage {
  entries: Record<string, unknown>[]
  nextCursor: string | null
}

export interface BooksList {
  books: Record<string, unknown>[]
}

/** `base` with any trailing slashes removed, joined to an API path and its query. */
export function storygraphUrl(base: string, path: string, params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, v)
  const qs = q.toString()
  return `${base.trim().replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`
}

function clip(trace: StorygraphTrace): StorygraphTrace {
  if (trace.body.length <= MAX_TRACE_BODY) return trace
  return { ...trace, body: `${trace.body.slice(0, MAX_TRACE_BODY)}… [${trace.body.length} bytes]` }
}

/** One GET, no interpretation. Never throws. */
export async function storygraphRequest(token: string, url: string): Promise<StorygraphTrace> {
  const startedAt = Date.now()
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'activitypub-mcp/1.0 (sync-storygraph)',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (e) {
    return { url, status: 0, body: (e as Error).message, durationMs: Date.now() - startedAt }
  }
  let body: string
  try {
    body = await res.text()
  } catch (e) {
    return { url, status: 0, body: `body read failed: ${(e as Error).message}`, durationMs: Date.now() - startedAt }
  }
  return { url, status: res.status, body, durationMs: Date.now() - startedAt }
}

/**
 * Classify a raw response. `parse` turns a decoded 2xx body into the payload, or returns
 * null when the body is not the shape the contract promises — which is an ERROR, never
 * an empty result: a proxy's HTML error page or a renamed field must not read as "no
 * new entries".
 */
export function classify<T>(
  raw: StorygraphTrace,
  parse: (body: unknown) => T | null,
): StorygraphResult<T> {
  const trace = clip(raw)
  if (raw.status === 0) {
    logger.warn({ url: raw.url, err: raw.body }, 'sidetal request errored')
    return { kind: 'error', status: 0, message: raw.body || 'No response', trace }
  }
  if (raw.status < 200 || raw.status >= 300) {
    // 401: the token is wrong. 503: sidetal has no token configured at its end. Both
    // are surfaced by the caller through recordFailure, which latches an ntfy on 401/403.
    logger.warn({ url: raw.url, status: raw.status, body: raw.body.slice(0, 300) }, 'sidetal returned non-OK status')
    return { kind: 'error', status: raw.status, message: raw.body.slice(0, 500) || `HTTP ${raw.status}`, trace }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw.body)
  } catch {
    return { kind: 'error', status: raw.status, message: 'Unparseable JSON body', trace }
  }
  const data = parse(decoded)
  if (data === null) {
    return { kind: 'error', status: raw.status, message: 'Body does not match the sidetal contract', trace }
  }
  return { kind: 'data', data, trace }
}

/** `{"entries": [...], "next_cursor": string|null}` or null. */
export function parseEntriesPage(body: unknown): EntriesPage | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.entries)) return null
  const next = b.next_cursor
  if (next !== null && next !== undefined && typeof next !== 'string') return null
  return {
    entries: b.entries.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object'),
    nextCursor: typeof next === 'string' && next !== '' ? next : null,
  }
}

/** `{"books": [...]}` or null. */
export function parseBooksList(body: unknown): BooksList | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.books)) return null
  return { books: b.books.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object') }
}

/** Max page size sidetal accepts. */
export const ENTRIES_PAGE_LIMIT = 1000

export async function fetchEntriesPage(
  base: string,
  token: string,
  opts: { sinceUpdated?: string; cursor?: string; limit?: number },
): Promise<StorygraphResult<EntriesPage>> {
  const url = storygraphUrl(base, '/api/v1/entries', {
    since_updated: opts.sinceUpdated,
    cursor: opts.cursor,
    limit: String(opts.limit ?? ENTRIES_PAGE_LIMIT),
  })
  return classify(await storygraphRequest(token, url), parseEntriesPage)
}

export async function fetchBooks(base: string, token: string): Promise<StorygraphResult<BooksList>> {
  return classify(await storygraphRequest(token, storygraphUrl(base, '/api/v1/books')), parseBooksList)
}
