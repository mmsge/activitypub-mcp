import { config, convergenceEnabled } from '../config.js'
import { logger } from '../lib/logger.js'
import { publishNtfy, type Notifier, type NtfyTarget } from '../lib/ntfy.js'
import {
  composeMessage,
  findCrossings,
  type Crossing,
  type CrossingNote,
} from '../lib/convergence.js'
import {
  closeOpenEquality,
  currentTotals,
  loadEvents,
  loadState,
  loadUnannounced,
  markNotified,
  previousEqualityAt,
  recordCrossings,
  saveState,
} from '../lib/convergence-store.js'

/**
 * Watch the cumulative scrobble count against the cumulative train kilometres and push
 * an ntfy alert when they meet, or swap places.
 *
 * Chained to `syncScrobbles()` rather than given its own timer, for the reason the
 * scrobble race is: it reacts to rows the sync just wrote, so an independent interval
 * would only add a window in which it reads stale counts. The trip import and the trip
 * prune call it too, with `recompute`, because those are the only things that can
 * change the past.
 *
 * `notify` is injectable so the decisions can be tested without a broker.
 */

export type ConvergenceRunKind = 'disabled' | 'seeded' | 'quiet' | 'announced' | 'undelivered'

export interface ConvergenceRunOptions {
  /**
   * Walk the whole archive instead of resuming from the watermark.
   *
   * Required after anything that can touch a leg: an import inserts, corrects or
   * deletes rows anywhere in the past, and `d` after a changed leg is different for
   * every later event. The tick's shortcut is only sound because scrobbles cannot
   * arrive behind the watermark — `sync-scrobbles` cursors on `max(uts) + 1`.
   */
  recompute?: boolean
}

function target(): NtfyTarget {
  return {
    url: config.NTFY_URL,
    topic: config.NTFY_TOPIC_CONVERGENCE,
    user: config.NTFY_USER,
    password: config.NTFY_PASSWORD,
  }
}

export async function runConvergenceWatch(
  opts: ConvergenceRunOptions = {},
  notify: Notifier = publishNtfy,
): Promise<ConvergenceRunKind> {
  // Refuse to run a watcher that cannot notify. Recording a crossing while every push
  // 401s is worse here than a missed milestone: the row IS the "already announced"
  // mark, so a crossing written now can never be announced later.
  if (!convergenceEnabled()) {
    logger.info(
      { enabled: config.CONVERGENCE_ENABLED, hasPassword: config.NTFY_PASSWORD !== '' },
      'Convergence watcher is not armed, skipping',
    )
    return 'disabled'
  }

  const state = await loadState()
  // No state row means a first run, which walks the archive from zero. An import means
  // the past may have moved under us, so it does too. A state row with no watermark is
  // a seed that never folded an event in — resuming from it would apply the whole
  // archive on top of totals that already count it.
  const fromScratch = opts.recompute || state === null || state.watermarkAt === null
  const seed = fromScratch
    ? { scrobbles: 0, km: 0 }
    : { scrobbles: state.scrobbles, km: state.km }
  const after = fromScratch ? null : state.watermarkAt

  const events = await loadEvents(after)
  const walk = findCrossings(events, seed)
  const totals = { scrobbles: walk.scrobbles, km: walk.km }
  const watermarkAt = walk.watermarkAt ?? after

  // An equality window opened by an earlier walk and closed by this one: record the end
  // and say nothing. One crossing is one notification, and that one already went out.
  if (walk.seedWindowClosedAt) await closeOpenEquality(walk.seedWindowClosedAt)

  // A crossing is history when it predates what the watcher had already folded in. On a
  // first run there is no previous watermark, so the walk's own end is the threshold —
  // which makes the meeting the archive already holds read as the record it is, in the
  // past tense and with its duration, rather than as something happening right now.
  await recordCrossings(walk.crossings, {
    historicalBefore: state?.watermarkAt ?? walk.watermarkAt,
  })

  // The queue, not just what this walk found: a crossing stays owed until `notified_at`
  // says otherwise, so a push that failed last run is paid now instead of lost.
  const pending = await loadUnannounced()

  if (pending.length === 0) {
    await saveState({ ...totals, watermarkAt })
    logger.debug(
      { events: events.length, scrobbles: totals.scrobbles, km: totals.km },
      'Convergence watch: nothing crossed',
    )
    return state === null ? 'seeded' : 'quiet'
  }

  const notes: CrossingNote[] = []
  for (const { crossing, historical } of pending) {
    notes.push({
      crossing,
      historical,
      previousEqualityAt: await previousEqualityAt(crossing.occurredAt),
    })
  }

  const message = composeMessage(notes, totals)!

  const delivered = await notify(message, target())
  if (!delivered) {
    // The crossings stay recorded and stay unannounced, so the next run retries them.
    // The watermark deliberately does NOT advance either: a silent failure here is the
    // one thing this feature cannot afford, because the row is its own "already told
    // you" mark. naustet-server ADR 0011.
    logger.error(
      { crossings: pending.length, title: message.title },
      'CONVERGENCE PUSH FAILED — crossings recorded but not announced, will retry',
    )
    return 'undelivered'
  }

  await markNotified(pending.map(p => p.crossing))
  await saveState({ ...totals, watermarkAt })
  logger.info(
    {
      crossings: pending.length,
      kinds: pending.map(p => p.crossing.kind),
      scrobbles: totals.scrobbles,
      km: totals.km,
    },
    'Convergence crossing announced',
  )
  return 'announced'
}

/** The live standing, for the read surface. Kept here so the tool and the job agree on
 *  what "the totals" means. */
export async function convergenceStanding(): Promise<{
  scrobbles: number
  km: number
  gap: number
  leader: Crossing['leader']
}> {
  const totals = await currentTotals()
  const gap = totals.km - totals.scrobbles
  return {
    ...totals,
    gap,
    leader: gap === 0 ? 'tie' : gap > 0 ? 'km' : 'scrobbles',
  }
}
