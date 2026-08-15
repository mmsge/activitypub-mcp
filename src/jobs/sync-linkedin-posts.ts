import { config } from '../config.js'
import { getDb } from '../db/client.js'
import { linkedinPosts } from '../db/schema.js'
import { fetchSnapshotPage, type SnapshotTrace } from '../lib/fetch-linkedin-snapshot.js'
import { joinWarning, linkedinJoinHealth } from '../lib/linkedin-join.js'
import { normaliseRecord, pick, pickBoolean, pickDate } from '../lib/linkedin-keys.js'
import { canonicalPostKey } from '../lib/linkedin-url.js'
import { logger } from '../lib/logger.js'
import {
  LINKEDIN_SOURCE,
  recordAttempt,
  recordFailure,
  recordSuccess,
  type AttemptTrace,
} from '../lib/source-health.js'

/**
 * Ingest Markus' own LinkedIn posts from the DMA Member Snapshot API.
 *
 * The snapshot is historical and complete on every call — it is not a feed of
 * changes — so this job can be dumb and idempotent: fetch everything, upsert on
 * the post key, done. That is also why the Changelog API is not used despite
 * covering the same ground: its window is 28 days and it starts empty at consent,
 * so it can neither backfill nor survive a fortnight of downtime.
 *
 * Weekly is plenty. See ADR 0033.
 */

/** The domain carrying posts: date, URL, commentary, visibility, attached link, reshare flag. */
const DOMAIN = 'MEMBER_SHARE_INFO'

/**
 * The domain asked when the target one comes back empty, purely to find out
 * whether the token still works.
 *
 * An empty crawl of MEMBER_SHARE_INFO is ambiguous by construction — LinkedIn
 * spells "not collated yet" and "you have paged past the end" with the same 404
 * body (ADR 0034) — so on its own it was recorded as a plain success, and a source
 * that had never once produced a row reported `token_status: awaiting_data` with
 * `last_status: null` and `last_error: null`. That state was derived entirely from
 * `last_data_at IS NULL`; it said nothing whatsoever about auth, which is the
 * thing an operator most wants ruled out.
 *
 * PROFILE is the right control because it is the *earliest* domain LinkedIn
 * collates — the observed seam in ADR 0034 was profile-shaped domains answering
 * 200 while every activity-shaped one answered 404. So PROFILE returning records
 * is positive evidence that the token, the scope and the consent are all intact
 * and the archive exists; PROFILE returning 401/403 turns a silent "awaiting" into
 * the refused-token failure it actually is; and PROFILE *also* coming back empty
 * means the whole snapshot is missing, which is a different problem from one slow
 * domain and should not read as "nearly there".
 *
 * One extra request per run, and only on a run that found nothing. See ADR 0039.
 */
const CONTROL_DOMAIN = 'PROFILE'

/**
 * Hook for the adjacent domains (ALL_COMMENTS, ALL_LIKES, INSTANT_REPOSTS,
 * ALL_VOTES) — same endpoint, same quirks, different `domain=`. Deliberately not
 * wired up: those record activity Markus *performed* ("Comments you've made",
 * "the reaction type a member has made to a post"), not engagement received on
 * his posts, so they cannot supply the reaction/comment/reshare split the .xlsx
 * lacks. Adding one later is a table and a call to crawlDomain().
 */
const PAGE_DELAY_MS = 250
const MAX_PAGES = 200

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface LinkedinPostRow {
  postKey: string
  postUrl: string
  postedAt: Date | null
  commentary: string | null
  visibility: string | null
  sharedUrl: string | null
  isReshare: boolean
  raw: Record<string, unknown>
}

/**
 * One snapshotData entry as a row, or null when it carries no usable post URL.
 *
 * Every alias list is plural because LinkedIn documents the key names for exactly
 * one domain and this is not it — see src/lib/linkedin-keys.ts. The untouched
 * record goes into `raw` regardless, so a spelling nobody anticipated is a
 * re-parse rather than a re-fetch.
 */
export function toPostRow(entry: Record<string, unknown>): LinkedinPostRow | null {
  const r = normaliseRecord(entry)

  const postUrl = pick(r, 'ShareLink', 'Post URL', 'Share URL', 'Permalink')
  const postKey = canonicalPostKey(postUrl)
  if (!postUrl || !postKey) return null

  return {
    postKey,
    postUrl,
    postedAt: pickDate(r, 'Date', 'Share Date', 'Posted Date', 'Created Date'),
    commentary: pick(r, 'ShareCommentary', 'Commentary', 'Share Commentary Text'),
    visibility: pick(r, 'Visibility', 'Share Visibility'),
    // The link attached to the post, NOT the post's own permalink.
    sharedUrl: pick(r, 'SharedUrl', 'Media URL', 'Article Link', 'Content URL'),
    isReshare: pickBoolean(r, 'ReshareFlag', 'Is Reshare', 'Reshare'),
    raw: entry,
  }
}

/**
 * The columns a re-poll overwrites.
 *
 * `firstSeenAt` is deliberately absent: the upsert does `set: linkedinPostUpdateSet(...)`,
 * so any key present here is rewritten every single poll, and including
 * `firstSeenAt` would reset "when did this post first appear" to "the last time
 * the poller ran" — making the column a slow clock rather than a record. This is
 * the same trap ADR 0013 documents for `bookUpsertValues` and `hiddenAt`;
 * extracted and exported purely so a test can assert the absence.
 */
export function linkedinPostUpdateSet(row: LinkedinPostRow, now: Date) {
  return {
    postUrl: row.postUrl,
    postedAt: row.postedAt,
    commentary: row.commentary,
    visibility: row.visibility,
    sharedUrl: row.sharedUrl,
    isReshare: row.isReshare,
    raw: row.raw,
    lastSeenAt: now,
  }
}

async function upsertPosts(rows: LinkedinPostRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const db = getDb()
  const now = new Date()

  // Drop in-page duplicates so a single INSERT has no repeated conflict targets,
  // which Postgres rejects outright.
  const seen = new Set<string>()
  const unique = rows.filter((r) => (seen.has(r.postKey) ? false : (seen.add(r.postKey), true)))

  let written = 0
  for (const row of unique) {
    await db
      .insert(linkedinPosts)
      .values({ ...row, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({
        target: linkedinPosts.postKey,
        set: linkedinPostUpdateSet(row, now),
      })
    written++
  }
  return written
}

/**
 * Crawl one snapshot domain to exhaustion.
 *
 * Termination is the no-data signal from the API, never `paging.total` — the docs
 * say that count under-reports because some data is assembled offline. An error
 * is NOT a termination: it aborts the run without recording a success, so a dead
 * token cannot masquerade as a completed crawl.
 */
export interface CrawlResult {
  rows: LinkedinPostRow[]
  /** How many pages were actually read before the terminator. */
  pages: number
  /** The response that ended the crawl — kept so a clean run leaves evidence too. */
  trace: SnapshotTrace
  /** True when MAX_PAGES stopped the crawl rather than the API did. */
  truncated: boolean
}

/** A crawl that failed, carrying the trace so the failure can be recorded verbatim. */
export class CrawlError extends Error {
  constructor(message: string, readonly status: number, readonly trace: SnapshotTrace) {
    super(message)
    this.name = 'CrawlError'
  }
}

async function crawlDomain(token: string, domain: string): Promise<CrawlResult> {
  const rows: LinkedinPostRow[] = []
  let start = 0
  let last: SnapshotTrace | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchSnapshotPage(token, domain, start)
    last = result.trace

    if (result.kind === 'error') throw new CrawlError(result.message, result.status, result.trace)
    if (result.kind === 'end') return { rows, pages: page, trace: result.trace, truncated: false }

    for (const entry of result.items) {
      const row = toPostRow(entry)
      if (row) rows.push(row)
    }

    start = result.nextStart
    await sleep(PAGE_DELAY_MS)
  }

  // Never truncate silently: a cap that is hit looks exactly like a complete crawl
  // from the row count alone.
  logger.warn({ domain, maxPages: MAX_PAGES }, 'LinkedIn crawl hit the page cap; data may be incomplete')
  return { rows, pages: MAX_PAGES, trace: last!, truncated: true }
}

/** A one-line summary of a response, for the stored note. */
function describe(trace: SnapshotTrace): string {
  const body = trace.body.replace(/\s+/g, ' ').trim().slice(0, 160)
  return trace.status === 0 ? `no response (${body})` : `HTTP ${trace.status} ${body}`
}

/**
 * What an empty crawl means, decided by asking a domain that should always answer.
 *
 * `auth` is the outcome that must not be swallowed: it is recorded as a failure, so
 * the badge turns red, `deriveTokenStatus` returns `unauthorized`, and the latched
 * ntfy push fires — none of which happened while a refused token could hide inside
 * a clean-looking `awaiting_data`.
 */
export type EmptyVerdict =
  | { kind: 'auth'; status: number; note: string; trace: AttemptTrace }
  | { kind: 'awaiting'; note: string; trace: AttemptTrace }
  | { kind: 'empty_archive'; note: string; trace: AttemptTrace }
  | { kind: 'inconclusive'; note: string; trace: AttemptTrace }

export async function classifyEmptyCrawl(
  token: string,
  target: SnapshotTrace,
): Promise<EmptyVerdict> {
  const control = await fetchSnapshotPage(token, CONTROL_DOMAIN, 0)
  const head = `${DOMAIN}: returned no records (${describe(target)}).`
  // The body kept is the TARGET's — that is the response being explained. The
  // control's verdict goes in the note beside it.
  const body = target.body

  if (control.kind === 'error') {
    const detail = `${CONTROL_DOMAIN}: ${describe(control.trace)}`
    if (control.status === 401 || control.status === 403) {
      const note = `${head} ${detail} → the token is refused. Re-mint it; this is not a collation delay.`
      return {
        kind: 'auth',
        status: control.status,
        note,
        trace: { status: control.status, body: control.trace.body, note },
      }
    }
    const note = `${head} ${detail} → control inconclusive, cannot tell a collation delay from an upstream fault.`
    return { kind: 'inconclusive', note, trace: { status: target.status, body, note } }
  }

  if (control.kind === 'data') {
    const note =
      `${head} ${CONTROL_DOMAIN}: HTTP ${control.trace.status} with ${control.items.length} record(s) ` +
      '→ token, scope and consent are all good; this domain is not collated yet. Do NOT re-mint the token.'
    return { kind: 'awaiting', note, trace: { status: target.status, body, note } }
  }

  const note =
    `${head} ${CONTROL_DOMAIN}: ${describe(control.trace)} — empty as well → the whole snapshot is missing, ` +
    'not just this domain. Past a day of this, it is a stuck collation job rather than a slow one (DMA support form).'
  return { kind: 'empty_archive', note, trace: { status: target.status, body, note } }
}

export async function syncLinkedinPosts(): Promise<void> {
  const token = config.LINKEDIN_DMA_TOKEN.trim()
  if (!token) {
    logger.info('LINKEDIN_DMA_TOKEN not set, skipping LinkedIn sync')
    return
  }

  await recordAttempt(LINKEDIN_SOURCE)
  logger.info({ domain: DOMAIN }, 'Starting LinkedIn snapshot sync')

  let crawl: CrawlResult
  try {
    crawl = await crawlDomain(token, DOMAIN)
  } catch (e) {
    if (e instanceof CrawlError) {
      const note = `${DOMAIN}: crawl aborted — ${describe(e.trace)}`
      logger.error({ domain: DOMAIN, status: e.status, url: e.trace.url }, note)
      await recordFailure(LINKEDIN_SOURCE, e.status, e.message, {
        status: e.status,
        body: e.trace.body,
        note,
      })
      return
    }
    const err = e as Error
    await recordFailure(LINKEDIN_SOURCE, 0, err.message, {
      status: 0,
      body: err.stack ?? err.message,
      note: `${DOMAIN}: crawl threw before any response could be classified — ${err.message}`,
    })
    return
  }

  // An empty crawl is the state this source has actually lived in, and on its own
  // it is indistinguishable from a healthy one. Ask the control domain rather than
  // recording a success that means nothing. See ADR 0039.
  if (crawl.rows.length === 0) {
    const verdict = await classifyEmptyCrawl(token, crawl.trace)
    if (verdict.kind === 'auth') {
      logger.error({ domain: DOMAIN, status: verdict.status }, verdict.note)
      await recordFailure(LINKEDIN_SOURCE, verdict.status, verdict.note, verdict.trace)
      return
    }
    logger.warn({ domain: DOMAIN, verdict: verdict.kind, url: crawl.trace.url }, verdict.note)
    await recordSuccess(LINKEDIN_SOURCE, 0, verdict.trace)
    return
  }

  const written = await upsertPosts(crawl.rows)
  const join = await linkedinJoinHealth()
  const warning = joinWarning(join)

  const note = [
    `${DOMAIN}: ${crawl.pages} page(s), ${crawl.rows.length} record(s) parsed, ${written} upserted.`,
    crawl.truncated ? `Stopped at the ${MAX_PAGES}-page cap — data may be incomplete.` : null,
    `Join: ${join.matched}/${join.posts} post(s) matched a metric key, ${join.orphan_metrics} metric key(s) still without content.`,
    warning,
  ]
    .filter(Boolean)
    .join(' ')

  if (warning) logger.error({ domain: DOMAIN, join }, warning)

  await recordSuccess(LINKEDIN_SOURCE, written, {
    status: crawl.trace.status,
    body: crawl.trace.body,
    note,
  })

  logger.info(
    { domain: DOMAIN, parsed: crawl.rows.length, upserted: written, join },
    'LinkedIn snapshot sync complete',
  )
}
