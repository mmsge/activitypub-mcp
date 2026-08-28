import { config, getThreadSkipHosts } from '../config.js'
import { logger } from '../lib/logger.js'
import { buildThreadShape, handleFromActorApId } from '../lib/thread-context.js'
import { fetchThreadContext } from '../lib/thread-fetch.js'
import {
  loadRootsToWalk,
  recordWalkFailure,
  replaceThread,
  resolveThreadActorsDetailed,
  type RootToWalk,
  type ThreadActor,
  type WalkMode,
} from '../lib/thread-store.js'

/**
 * Walk the conversations rooted in the owner's own toots, and store their shape.
 *
 * One HTTP request per ROOT, not per node: Mastodon's context endpoint hands back the
 * whole descendant subtree at once. So the request budget below is also the number of
 * threads a run covers, and ~2,000 roots is a single backfill of about 35 minutes.
 *
 * Two modes. `incremental` (the daily timer) takes only unsettled threads — never walked,
 * or newest node under THREAD_SETTLED_DAYS old — which is the only reason a daily job is
 * not a nightly repeat of the backfill. `backfill` takes everything, and is therefore
 * also the only way a settled thread that quietly gained a reply is picked up again.
 *
 * The rate-limit posture is `classify-youtube-shorts`' stage 2, deliberately: space the
 * requests, back off exponentially on 429 honouring `Retry-After`, and walk away after
 * three consecutive refusals rather than spinning. A tight retry loop against an
 * instance that is already saying no just extends the block.
 *
 * See decision record 0057.
 */

/** Consecutive 429s after which the run gives up rather than spinning. */
const ABORT_AFTER_RATE_LIMITS = 3

export interface WalkThreadsOptions {
  mode?: WalkMode
  maxRequests?: number
  dryRun?: boolean
  onProgress?: (p: { done: number; total: number; walked: number; failed: number }) => void
}

export interface WalkThreadsResult {
  mode: WalkMode
  /** Roots the queue offered. `requested` is how many were actually asked about. */
  candidates: number
  requested: number
  walked: number
  failed: number
  nodesWritten: number
  /** Replies the shape builder refused, summed across the run. */
  dropped: { visibility: number; skippedHost: number; unparseable: number; orphaned: number }
  // 'not_configured' and 'no_match' were one value once. They mean completely different
  // things — an env var versus a handle spelled differently from the archive — and a
  // single 'no_actors' made the run say nothing about which (ADR 0039).
  stopped: null | 'disabled' | 'not_configured' | 'no_match' | 'bounded' | 'dry_run' | 'rate_limited'
  /** Filled in on 'not_configured' / 'no_match': what the archive actually holds, so the
   *  fix does not need a psql session. */
  storedHandles?: string[]
  /** The actors that WILL be walked, and where each came from. */
  actors?: ThreadActor[]
  /** On 'not_configured': the accepted follows the fallback considered and the software
   *  each reports, so "none of them said Mastodon" is distinguishable from "none exist". */
  followed?: Array<{ handle: string; software: string | null }>
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Why a scheduled run would do nothing, in words, so the admin page can say so instead
 *  of showing an empty table. Null when the walker is able to run. */
export function threadWalkBlockedReason(): string | null {
  if (config.THREAD_WALK_INTERVAL_HOURS === 0) return 'THREAD_WALK_INTERVAL_HOURS=0'
  if (config.THREAD_MAX_REQUESTS_PER_RUN === 0) return 'THREAD_MAX_REQUESTS_PER_RUN=0'
  return null
}

export async function walkThreads(options: WalkThreadsOptions = {}): Promise<WalkThreadsResult> {
  const mode: WalkMode = options.mode ?? 'incremental'
  const maxRequests = options.maxRequests ?? config.THREAD_MAX_REQUESTS_PER_RUN
  const dryRun = options.dryRun ?? false

  const result: WalkThreadsResult = {
    mode,
    candidates: 0,
    requested: 0,
    walked: 0,
    failed: 0,
    nodesWritten: 0,
    dropped: { visibility: 0, skippedHost: 0, unparseable: 0, orphaned: 0 },
    stopped: null,
  }

  if (maxRequests <= 0) return { ...result, stopped: 'bounded' }

  const resolution = await resolveThreadActorsDetailed()
  if (resolution.kind === 'unconfigured') {
    logger.warn(
      { storedHandles: resolution.stored, followed: resolution.followed },
      'Thread walk: no actor configured and no followed Mastodon account to fall back to',
    )
    return {
      ...result,
      stopped: 'not_configured',
      storedHandles: resolution.stored,
      followed: resolution.followed,
    }
  }
  if (resolution.kind === 'unmatched') {
    logger.warn(
      { configured: resolution.configured, storedHandles: resolution.stored },
      'Thread walk: the configured actor matched nothing in the archive',
    )
    return { ...result, stopped: 'no_match', storedHandles: resolution.stored }
  }
  const threadActors = resolution.actors
  result.actors = threadActors

  // Whose nodes count as "mine". Every configured actor, not just the root's author: he
  // replies to himself from the same account, and a second account of his in the same
  // thread is still not an external participant.
  const mine = new Set(threadActors.map(a => a.handle).filter(Boolean))
  const handleByActor = new Map(threadActors.map(a => [a.apId, a.handle]))
  const skipHosts = getThreadSkipHosts()

  const roots = await loadRootsToWalk({
    mode,
    actorApIds: threadActors.map(a => a.apId),
    limit: maxRequests,
  })
  result.candidates = roots.length
  if (roots.length === 0) return result
  if (dryRun) {
    for (const r of roots) logger.info({ root: r.apId, walkedAt: r.walkedAt }, 'Would walk thread')
    return { ...result, stopped: 'dry_run' }
  }

  let consecutiveRateLimits = 0
  let backoffMs = config.THREAD_REQUEST_SPACING_MS

  for (const root of roots) {
    const outcome = await fetchThreadContext(root.origin, root.statusId)
    result.requested += 1

    if (!outcome.ok && outcome.code === 'rate_limited') {
      consecutiveRateLimits += 1
      backoffMs = Math.max(backoffMs * 2, outcome.retryAfterMs ?? 0)
      if (consecutiveRateLimits >= ABORT_AFTER_RATE_LIMITS) {
        logger.warn({ origin: root.origin }, 'Thread walk stopping: rate limited three times running')
        return { ...result, stopped: 'rate_limited' }
      }
      await sleep(backoffMs)
      continue
    }

    consecutiveRateLimits = 0
    backoffMs = config.THREAD_REQUEST_SPACING_MS

    if (!outcome.ok) {
      // Never a reason to write an empty tree: the previous shape stays put.
      result.failed += 1
      await recordWalkFailure(root, `${outcome.code}: ${outcome.message}`)
      await sleep(config.THREAD_REQUEST_SPACING_MS)
      continue
    }

    // The root is his by definition — that is why it is a root at all. The handle comes
    // from the actor row, falling back to the identifier's own shape so an actor stored
    // without one still yields a node the schema will accept.
    const rootHandle = handleByActor.get(root.actorApId) || handleFromActorApId(root.actorApId)
    if (!rootHandle) {
      result.failed += 1
      await recordWalkFailure(root, `no handle for root author ${root.actorApId}`)
      await sleep(config.THREAD_REQUEST_SPACING_MS)
      continue
    }

    const shape = buildThreadShape({
      root: {
        statusApId: root.apId,
        statusId: root.statusId,
        origin: root.origin,
        url: root.url,
        publishedAt: root.publishedAt,
        handle: rootHandle,
      },
      descendants: outcome.descendants,
      queriedOrigin: root.origin,
      mine,
      skipHosts,
    })

    await replaceThread(root, shape.nodes, shape.stats)
    result.walked += 1
    result.nodesWritten += shape.nodes.length
    for (const key of ['visibility', 'skippedHost', 'unparseable', 'orphaned'] as const) {
      result.dropped[key] += shape.dropped[key]
    }

    options.onProgress?.({
      done: result.requested,
      total: roots.length,
      walked: result.walked,
      failed: result.failed,
    })

    await sleep(config.THREAD_REQUEST_SPACING_MS)
  }

  if (result.requested >= maxRequests) result.stopped = 'bounded'

  logger.info(
    {
      mode,
      walked: result.walked,
      failed: result.failed,
      nodes: result.nodesWritten,
      dropped: result.dropped,
      stopped: result.stopped,
    },
    'Thread walk complete',
  )
  return result
}
