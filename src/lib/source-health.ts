import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { sourceSyncState } from '../db/schema.js'
import { logger } from './logger.js'
import { publishNtfy } from './ntfy.js'

/**
 * Ingest health for a polled source, so "is this still working" is answerable
 * without reading logs.
 *
 * Every other source here answers that question as `max(data timestamp)`, which
 * cannot distinguish "the poller is broken" from "nothing happened". For Last.fm
 * that is fine — a dead key shows as silence within the hour, against a source
 * that produces rows daily. For LinkedIn it is not: the poller runs weekly, the
 * token is minted by hand through an EEA-gated flow with an expiry nobody can
 * predict, and Markus posts perhaps twice a week. A dead token and a quiet
 * fortnight look identical from the data alone, and the difference would surface
 * only when someone eventually asked why the numbers stopped moving.
 *
 * See ADR 0033.
 */

export const LINKEDIN_SOURCE = 'linkedin'

export type TokenStatus = 'ok' | 'stale' | 'unauthorized' | 'never_run' | 'awaiting_data'

export interface SourceHealth {
  source: string
  lastAttemptAt: Date | null
  lastSuccessAt: Date | null
  lastError: string | null
  lastStatus: number | null
  consecutiveFailures: number
  itemsLastRun: number | null
  lastDataAt: Date | null
  notifiedAt: Date | null
}

/**
 * Classify a source's ingest from its sync history.
 *
 * Pure, and separated from the query so the states can be tested without a
 * database. All five are meaningful and none collapses into another:
 *
 *  - a source can hold perfectly good data *and* a failing refresh, which is
 *    `stale`, not `unauthorized` — the stored snapshot stays valid long after the
 *    token that fetched it dies;
 *  - and a source can be succeeding perfectly while producing nothing, which is
 *    `awaiting_data`, not `ok`. LinkedIn collates the snapshot's activity domains
 *    after its profile ones, and signals "not collated yet" with the very same 404
 *    body it uses for "you have reached the end of the data". The crawl must treat
 *    that as the end, so a completed-and-empty run is indistinguishable from a
 *    healthy one at the HTTP layer. `lastDataAt` is what tells them apart, and it
 *    has to be stored because nothing in the response can carry it. See ADR 0034.
 *
 * `stale` is derived from how long it has been since a success, never from an
 * assumed token lifetime: LinkedIn documents no expiry for a self-serve DMA
 * token, so anything we assumed would be a guess presented as a fact.
 */
export function deriveTokenStatus(
  health: SourceHealth | null,
  staleAfterMs: number,
  now: Date = new Date(),
): TokenStatus {
  if (!health || (!health.lastAttemptAt && !health.lastSuccessAt)) return 'never_run'
  // 401/403 is the token itself being refused — the one state a human must act on.
  if (health.lastStatus === 401 || health.lastStatus === 403) return 'unauthorized'
  if (!health.lastSuccessAt) return 'unauthorized'
  // Checked before `awaiting_data`: if the job has stopped running as well, that is
  // the more actionable fact, and "waiting" would imply something is still trying.
  if (now.getTime() - health.lastSuccessAt.getTime() > staleAfterMs) return 'stale'
  if (!health.lastDataAt) return 'awaiting_data'
  return 'ok'
}

export async function getSourceHealth(source: string): Promise<SourceHealth | null> {
  const db = getDb()
  const rows = await db.select().from(sourceSyncState).where(eq(sourceSyncState.source, source))
  return (rows[0] as SourceHealth | undefined) ?? null
}

/** Stamp the start of a run. Leaves the success/failure fields alone. */
export async function recordAttempt(source: string): Promise<void> {
  const db = getDb()
  const now = new Date()
  await db
    .insert(sourceSyncState)
    .values({ source, lastAttemptAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: sourceSyncState.source,
      set: { lastAttemptAt: now, updatedAt: now },
    })
}

/**
 * The columns a successful run writes.
 *
 * `lastDataAt` is present ONLY when the run actually brought rows back. It must be
 * absent from the object rather than set to null on an empty run: the update does
 * `set: successSet(...)`, so any key present here is rewritten every time, and
 * including it unconditionally would erase the record that this source has ever
 * produced data — turning a working source into a permanent `awaiting_data` the
 * first time a run legitimately returned nothing. Same trap ADR 0013 records for
 * `hiddenAt`, and ADR 0033 for `firstSeenAt`. Extracted and exported so a test can
 * assert the absence.
 */
export function successSet(items: number, now: Date) {
  return {
    lastSuccessAt: now,
    lastError: null,
    lastStatus: null,
    consecutiveFailures: 0,
    itemsLastRun: items,
    // Cleared so a token that dies again later alerts again, rather than being
    // silenced forever by one push months ago.
    notifiedAt: null,
    updatedAt: now,
    ...(items > 0 ? { lastDataAt: now } : {}),
  }
}

/** A run that completed. Clears the error state and the notification latch. */
export async function recordSuccess(source: string, items: number): Promise<void> {
  const db = getDb()
  const now = new Date()
  const prior = await getSourceHealth(source)
  const set = successSet(items, now)

  await db
    .insert(sourceSyncState)
    .values({ source, lastAttemptAt: now, ...set })
    .onConflictDoUpdate({ target: sourceSyncState.source, set })

  // The inverse of `awaiting_data`, and the more worrying one. The snapshot is
  // historical and complete on every call — it is not a feed of changes — so a run
  // that returns nothing when we already hold rows means the upstream stopped
  // serving data we know it once had, not that nothing happened since last time.
  // Logged rather than alerted: it is rare, ambiguous, and the stored rows are
  // untouched either way, so it does not warrant waking anyone.
  if (items === 0 && prior?.lastDataAt) {
    logger.warn(
      { source, lastDataAt: prior.lastDataAt, itemsPreviously: prior.itemsLastRun },
      'Source sync returned no rows although it has returned data before',
    )
  }
}

/**
 * A run that failed. `lastSuccessAt` is deliberately untouched — it is what
 * separates "stale" from "never worked", and overwriting it on failure would
 * erase the only evidence that the source ever ran.
 */
export async function recordFailure(
  source: string,
  status: number,
  message: string,
): Promise<void> {
  const db = getDb()
  const now = new Date()
  const prior = await getSourceHealth(source)
  const failures = (prior?.consecutiveFailures ?? 0) + 1

  await db
    .insert(sourceSyncState)
    .values({
      source,
      lastAttemptAt: now,
      lastError: message,
      lastStatus: status,
      consecutiveFailures: failures,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sourceSyncState.source,
      set: {
        lastAttemptAt: now,
        lastError: message,
        lastStatus: status,
        consecutiveFailures: failures,
        updatedAt: now,
      },
    })

  logger.error({ source, status, failures, message }, 'Source sync failed')

  // One push per outage, on the transition into a refused credential. Latched on
  // `notifiedAt` because this poller runs weekly and an un-latched alert would
  // repeat until someone fixed it — which trains the recipient to ignore it, the
  // failure mode hetzner-server ADR 0011 is about. Cleared by the next success.
  if ((status === 401 || status === 403) && !prior?.notifiedAt) {
    const sent = await publishNtfy({
      title: `${source}: token refused (${status})`,
      body: `The ${source} sync is failing with HTTP ${status}. The access token has most likely expired and needs re-minting.`,
      tags: ['warning'],
      priority: 'high',
    })
    if (sent) {
      await db
        .update(sourceSyncState)
        .set({ notifiedAt: now })
        .where(eq(sourceSyncState.source, source))
    }
  }
}
