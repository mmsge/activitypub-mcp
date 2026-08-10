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
 * See ADR 0033.
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
 * The end-of-data signal. The docs instruct callers to "continue looping through
 * the pages until you receive an error message indicating 'No data found for this
 * memberId'", because `paging.total` under-reports when some of the data is
 * assembled offline. Matched loosely: the id is interpolated into the real
 * message, and the wording is not a documented contract.
 */
const NO_DATA_RE = /no data found/i

export type SnapshotPage =
  /** A page of records. `nextStart` is the page index to ask for next. */
  | { kind: 'data'; items: Record<string, unknown>[]; nextStart: number }
  /** The member's data for this domain is exhausted. The crawl succeeded. */
  | { kind: 'end' }
  /** Anything else. The crawl did NOT succeed and must not be recorded as such. */
  | { kind: 'error'; status: number; message: string }

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

/**
 * Fetch one page of a snapshot domain.
 *
 * `domain` is case-sensitive (MEMBER_SHARE_INFO, ALL_COMMENTS, …) — LinkedIn says
 * so explicitly and returns nothing rather than erroring on the wrong case.
 */
export async function fetchSnapshotPage(
  token: string,
  domain: string,
  start: number,
): Promise<SnapshotPage> {
  const url = `${API_URL}?q=criteria&domain=${encodeURIComponent(domain)}&start=${start}`

  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Linkedin-Version': LINKEDIN_VERSION,
        Accept: 'application/json',
        'User-Agent': `activitypub-mcp/1.0 (+https://${config.APP_DOMAIN})`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (e) {
    const message = (e as Error).message
    logger.warn({ domain, start, err: message }, 'LinkedIn snapshot fetch errored')
    return { kind: 'error', status: 0, message }
  }

  const text = await res.text()

  // Checked before res.ok on purpose: the end-of-data signal arrives AS an error
  // response, so testing status first would report the natural end of every
  // successful crawl as a failure.
  if (NO_DATA_RE.test(text)) return { kind: 'end' }

  if (!res.ok) {
    // 426 means someone changed LINKEDIN_VERSION; 401/403 means the hand-minted
    // token has expired or been revoked. Both are surfaced by the caller rather
    // than logged and forgotten.
    logger.warn(
      { domain, start, status: res.status, body: text.slice(0, 300) },
      'LinkedIn snapshot returned non-OK status',
    )
    return { kind: 'error', status: res.status, message: text.slice(0, 500) || res.statusText }
  }

  let body: Record<string, any>
  try {
    body = JSON.parse(text)
  } catch {
    logger.warn({ domain, start }, 'LinkedIn snapshot returned unparseable JSON')
    return { kind: 'error', status: res.status, message: 'Unparseable JSON body' }
  }

  // `elements` always holds exactly one entry; the payload is its snapshotData.
  const items = body?.elements?.[0]?.snapshotData
  if (!Array.isArray(items) || items.length === 0) return { kind: 'end' }

  return { kind: 'data', items: items as Record<string, unknown>[], nextStart: nextStartFrom(body, start) }
}
