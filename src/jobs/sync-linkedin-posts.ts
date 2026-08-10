import { config } from '../config.js'
import { getDb } from '../db/client.js'
import { linkedinPosts } from '../db/schema.js'
import { fetchSnapshotPage } from '../lib/fetch-linkedin-snapshot.js'
import { normaliseRecord, pick, pickBoolean, pickDate } from '../lib/linkedin-keys.js'
import { canonicalPostKey } from '../lib/linkedin-url.js'
import { logger } from '../lib/logger.js'
import { LINKEDIN_SOURCE, recordAttempt, recordFailure, recordSuccess } from '../lib/source-health.js'

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
async function crawlDomain(token: string, domain: string): Promise<LinkedinPostRow[]> {
  const rows: LinkedinPostRow[] = []
  let start = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchSnapshotPage(token, domain, start)

    if (result.kind === 'error') {
      const err = new Error(result.message) as Error & { status?: number }
      err.status = result.status
      throw err
    }
    if (result.kind === 'end') return rows

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
  return rows
}

export async function syncLinkedinPosts(): Promise<void> {
  const token = config.LINKEDIN_DMA_TOKEN.trim()
  if (!token) {
    logger.info('LINKEDIN_DMA_TOKEN not set, skipping LinkedIn sync')
    return
  }

  await recordAttempt(LINKEDIN_SOURCE)
  logger.info({ domain: DOMAIN }, 'Starting LinkedIn snapshot sync')

  let rows: LinkedinPostRow[]
  try {
    rows = await crawlDomain(token, DOMAIN)
  } catch (e) {
    const err = e as Error & { status?: number }
    await recordFailure(LINKEDIN_SOURCE, err.status ?? 0, err.message)
    return
  }

  const written = await upsertPosts(rows)
  await recordSuccess(LINKEDIN_SOURCE, written)

  logger.info({ domain: DOMAIN, parsed: rows.length, upserted: written }, 'LinkedIn snapshot sync complete')
}
