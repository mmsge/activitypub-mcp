import { config } from '../config.js'
import { logger } from './logger.js'

/**
 * One page of LinkedIn's DMA Member Snapshot API.
 *
 * Deliberately NOT shaped like fetch-lastfm.ts. That module collapses every
 * failure to an empty page, which is right for a fetcher whose caller stops when
 * a page comes back empty — but here "empty page" is also the signal that the
 * crawl is finished. Collapsing the two would turn an expired token into a
 * successful no-op run: the poller would stop at page 0, record a clean sync, and
 * the archive would quietly stop growing. Since the token is minted by hand, is
 * EEA-gated, and has an expiry nobody can predict, that is the failure mode most
 * likely to actually happen.
 *
 * So the result is three-way and the caller must handle each: data, a genuine end
 * of data, or an error that is not an end of data.
 *
 * Every one of the three now carries a `trace` — the URL, the HTTP status, the
 * response body and LinkedIn's own request id. ADR 0034 established that "the
 * domain is not collated yet" and "you have paged past the end" are the same 404
 * with the same body, so the classification cannot tell them apart; ADR 0039 is
 * about the fact that the *evidence* was then thrown away too, leaving
 * `last_status: null` and `last_error: null` against a source that had never
 * produced a row. The classification stays lossy because the API is; the trace is
 * what makes the loss inspectable afterwards rather than only under a debugger.
 *
 * See ADR 0033 and ADR 0039.
 */

const API_URL = 'https://api.linkedin.com/rest/memberSnapshotData'

/**
 * The ONLY version this endpoint accepts. Not configurable, and not to be bumped
 * in sympathy with the monthly DMA version numbers — those track product and
 * domain announcements, not the endpoint. LinkedIn's docs: "This endpoint only
 * supports 202312 … Requests using a version other than 202312 will fail with a
 * 426 NONEXISTENT_VERSION error."
 */
const LINKEDIN_VERSION = '202312'

const FETCH_TIMEOUT_MS = 20_000

/**
 * How much of a response body a classified page keeps.
 *
 * Bounded because it is persisted on `source_sync_state` for every attempt. The
 * bodies that matter are LinkedIn's error envelopes, which are a couple of hundred
 * bytes; a data page is truncated and that is fine, since the reason to store a
 * data page's body is to prove data arrived, not to re-parse it. `probeSnapshotDomain`
 * returns the untruncated body for the cases where the whole thing is the point.
 */
const MAX_TRACE_BODY = 2000

/**
 * The end-of-data signal. The docs instruct callers to "continue looping through
 * the pages until you receive an error message indicating 'No data found for this
 * memberId'", because `paging.total` under-reports when some of the data is
 * assembled offline. Matched loosely: the id is interpolated into the real
 * message, and the wording is not a documented contract.
 */
const NO_DATA_RE = /no data found/i

/**
 * Response headers worth keeping. `x-li-uuid` is LinkedIn's own request id and is
 * the first thing their DMA support form asks for, so a stuck collation can be
 * reported with evidence rather than with a description of it.
 */
const TRACE_HEADERS = ['x-li-uuid', 'x-li-fabric', 'x-li-pop', 'x-restli-protocol-version']

/** One DMA request's outcome, independent of which endpoint it was. */
export interface DmaTrace {
  url: string
  /** 0 when no response was received at all — timeout, DNS, TLS. */
  status: number
  /** The response body, verbatim. LinkedIn's error text *is* the diagnosis. */
  body: string
  headers: Record<string, string>
  durationMs: number
}

/** A snapshot request's outcome: a DMA trace plus which page of which domain it was. */
export interface SnapshotTrace extends DmaTrace {
  /** Null when the request asked for every domain at once. */
  domain: string | null
  start: number
}

export type SnapshotPage =
  /** A page of records. `nextStart` is the page index to ask for next. */
  | { kind: 'data'; items: Record<string, unknown>[]; nextStart: number; trace: SnapshotTrace }
  /** The member's data for this domain is exhausted. The crawl succeeded. */
  | { kind: 'end'; trace: SnapshotTrace }
  /** Anything else. The crawl did NOT succeed and must not be recorded as such. */
  | { kind: 'error'; status: number; message: string; trace: SnapshotTrace }

/**
 * The request URL. `domain` is omitted entirely when null — the docs make it
 * optional and say the response then "contains data from all domains", which is a
 * useful thing to be able to ask when one domain is answering 404 and the question
 * is whether the archive exists at all.
 */
export function snapshotUrl(domain: string | null, start: number): string {
  const params = new URLSearchParams({ q: 'criteria' })
  if (domain) params.set('domain', domain)
  params.set('start', String(start))
  // Spelled out rather than via URLSearchParams' own toString so the domain is not
  // percent-encoded past recognition in a log line; the values are enum tokens.
  return `${API_URL}?${params.toString()}`
}

/**
 * The `start` for the next page.
 *
 * `start` is a PAGE INDEX, not a record offset — the docs' own samples show
 * `{start: 0, count: 10}` linking to `start=1`, and `{start: 1}` linking to
 * `start=2`. Advancing by `count` (the reflex for every other paginated REST API)
 * would read page 0, then page 10, and skip nine pages of posts in between.
 *
 * Prefer the server's own `next` link; fall back to +1 when it is absent, since
 * the docs say to keep going until the no-data message rather than until the
 * links run out.
 */
function nextStartFrom(body: Record<string, any>, start: number): number {
  const links = body?.paging?.links
  if (Array.isArray(links)) {
    for (const link of links) {
      if (link?.rel !== 'next' || typeof link?.href !== 'string') continue
      const raw = new URL(link.href, 'https://api.linkedin.com').searchParams.get('start')
      const n = Number(raw)
      if (Number.isInteger(n) && n > start) return n
    }
  }
  return start + 1
}

function readHeaders(res: { headers?: { get(name: string): string | null } }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of TRACE_HEADERS) {
    const v = res.headers?.get(name)
    if (v) out[name] = v
  }
  return out
}

/**
 * One request, no interpretation — the raw trace, with the body untruncated.
 *
 * Separated from `fetchSnapshotPage` so a diagnostic can see exactly what came
 * back without the classifier standing in front of it. `scripts/probe-linkedin-snapshot.ts`
 * is the caller; it exists because establishing what this endpoint was actually
 * doing previously took a hand-written curl loop (ADR 0034), and a hand-written
 * curl loop is not a thing you can ask someone to run at 23:00.
 *
 * `domain` is case-sensitive (MEMBER_SHARE_INFO, ALL_COMMENTS, …) — LinkedIn says
 * so explicitly and returns nothing rather than erroring on the wrong case.
 */
export async function probeSnapshotDomain(
  token: string,
  domain: string | null,
  start = 0,
): Promise<SnapshotTrace> {
  const trace = await dmaRequest(token, snapshotUrl(domain, start))
  return { ...trace, domain, start }
}

/**
 * Any DMA endpoint, same headers, same timeout, same trace.
 *
 * `memberSnapshotData` is not the only one that matters. `memberAuthorizations`
 * answers a question nothing else can — whether LinkedIn has actually registered the
 * consent, and since when — and `memberChangeLogs` is the only other route to post
 * content this product offers. Both were unexercised while the snapshot was assumed
 * to be on its way. See ADR 0043.
 */
export async function dmaRequest(
  token: string,
  url: string,
  init: { method?: string; body?: string } = {},
): Promise<DmaTrace> {
  const startedAt = Date.now()

  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Linkedin-Version': LINKEDIN_VERSION,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `activitypub-mcp/1.0 (+https://${config.APP_DOMAIN})`,
      },
      body: init.body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (e) {
    return {
      url,
      status: 0,
      body: (e as Error).message,
      headers: {},
      durationMs: Date.now() - startedAt,
    }
  }

  return {
    url,
    status: res.status,
    body: await res.text(),
    headers: readHeaders(res),
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Has LinkedIn actually registered the member's consent, and since when?
 *
 * `regulatedAt` is the timestamp from which this member's activity is monitored and
 * archived, and `memberComplianceScopes` should hold `DMA`. An empty `elements` array
 * means the authorisation never registered — which is the one remaining explanation
 * for a partially-generated archive that nothing we had built could see. Documented
 * under the Changelog API as the "member FINDER" call, but it describes the consent,
 * not the changelog.
 */
export const MEMBER_AUTHORIZATIONS_URL =
  'https://api.linkedin.com/rest/memberAuthorizations?q=memberAndApplication'

/**
 * Changelog events, newest first — the other route to post content.
 *
 * ADR 0033 ruled this out because its window is 28 days and it starts empty at
 * consent, so it can neither backfill nor survive downtime. That reasoning held
 * while the snapshot was expected to work. It does not hold now that the snapshot
 * provably has no `MEMBER_SHARE_INFO` to give: forward-only beats nothing.
 */
const CHANGELOG_URL = 'https://api.linkedin.com/rest/memberChangeLogs'

/**
 * One page of changelog events.
 *
 * `count` is capped at 50 by the API — anything outside [1,50] is a 400 carrying the
 * recommended value. Paged by `startTime` (epoch ms), not by index: the docs say to
 * pass the previous response's latest `processedAt`, and that the same event will
 * reappear on the next request, so the caller must expect one page of overlap rather
 * than treat a repeat as a loop.
 */
export function changelogUrl(startTime?: number | null, count = 50): string {
  const params = new URLSearchParams({ q: 'memberAndApplication', count: String(count) })
  if (startTime) params.set('startTime', String(startTime))
  return `${CHANGELOG_URL}?${params.toString()}`
}

/** The trace as stored: same fields, body clipped to a bounded excerpt. */
function clip(trace: SnapshotTrace): SnapshotTrace {
  if (trace.body.length <= MAX_TRACE_BODY) return trace
  return { ...trace, body: `${trace.body.slice(0, MAX_TRACE_BODY)}… [${trace.body.length} bytes]` }
}

/**
 * Fetch one page of a snapshot domain, classified.
 *
 * `domain` is case-sensitive (MEMBER_SHARE_INFO, ALL_COMMENTS, …) — LinkedIn says
 * so explicitly and returns nothing rather than erroring on the wrong case.
 */
export async function fetchSnapshotPage(
  token: string,
  domain: string | null,
  start: number,
): Promise<SnapshotPage> {
  const raw = await probeSnapshotDomain(token, domain, start)
  const trace = clip(raw)

  if (raw.status === 0) {
    logger.warn({ domain, start, err: raw.body }, 'LinkedIn snapshot fetch errored')
    return { kind: 'error', status: 0, message: raw.body, trace }
  }

  // Checked before the status check on purpose: the end-of-data signal arrives AS
  // an error response, so testing status first would report the natural end of
  // every successful crawl as a failure.
  if (NO_DATA_RE.test(raw.body)) return { kind: 'end', trace }

  const ok = raw.status >= 200 && raw.status < 300
  if (!ok) {
    // 426 means someone changed LINKEDIN_VERSION; 401/403 means the hand-minted
    // token has expired or been revoked. Both are surfaced by the caller rather
    // than logged and forgotten.
    logger.warn(
      { domain, start, status: raw.status, body: raw.body.slice(0, 300) },
      'LinkedIn snapshot returned non-OK status',
    )
    return {
      kind: 'error',
      status: raw.status,
      message: raw.body.slice(0, 500) || `HTTP ${raw.status}`,
      trace,
    }
  }

  let body: Record<string, any>
  try {
    body = JSON.parse(raw.body)
  } catch {
    logger.warn({ domain, start }, 'LinkedIn snapshot returned unparseable JSON')
    return { kind: 'error', status: raw.status, message: 'Unparseable JSON body', trace }
  }

  // `elements` always holds exactly one entry; the payload is its snapshotData.
  const items = body?.elements?.[0]?.snapshotData
  if (!Array.isArray(items) || items.length === 0) return { kind: 'end', trace }

  return {
    kind: 'data',
    items: items as Record<string, unknown>[],
    nextStart: nextStartFrom(body, start),
    trace,
  }
}
