import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { publishNtfy, type Notifier } from '../lib/ntfy.js'
import { loadFastLaneTargets, resolveBreakoutActors } from '../lib/breakout-store.js'
import { getEngagement } from '../mcp/tools/engagement.js'
import { runPostBreakout } from './post-breakout.js'

/**
 * The fast lane: re-read engagement for posts published in the last
 * BREAKOUT_FAST_LANE_HOURS every BREAKOUT_FAST_LANE_MINUTES, then run the same ladder
 * over them. See decision record 0036.
 *
 * This exists because a post that takes off does so in its first hours, and the hourly
 * lane can be up to an hour late — long enough that "this is happening now" becomes
 * "this happened". It is the ONLY part of the feature that spends remote API calls.
 *
 * Cost is bounded by how much he posts, not by how much history there is: worst case
 * BREAKOUT_FAST_LANE_MAX_POSTS per actor per tick, and zero on a day he hasn't posted.
 * If it ever needs trimming, cut MAX_POSTS rather than lengthening the interval — the
 * value here is entirely in the first hours of a post's life.
 *
 * Posts already at the top rung are excluded by the store: the ladder is spent, so
 * re-reading them buys nothing.
 *
 * The two lanes deliberately overlap on young posts, and the overlap is harmless:
 * `skip_unchanged` writes no snapshot when counts haven't moved, and `decideBreakout`
 * returns 'none' for a rung already spent. Neither lane needs to know about the other.
 */
export async function runBreakoutFastLane(notify: Notifier = publishNtfy): Promise<void> {
  // Every gate is checked before a single query or fetch, so an unconfigured or
  // disabled deployment pays nothing for having the timer registered.
  if (!config.BREAKOUT_ENABLED) return
  if (!config.NTFY_PASSWORD) return
  if (config.BREAKOUT_FAST_LANE_MINUTES === 0) return

  const watched = await resolveBreakoutActors()
  if (watched.length === 0) return

  const apIds: string[] = []
  for (const actor of watched) {
    const targets = await loadFastLaneTargets({
      actorApId: actor.apId,
      hours: config.BREAKOUT_FAST_LANE_HOURS,
      limit: config.BREAKOUT_FAST_LANE_MAX_POSTS,
    })
    apIds.push(...targets)
  }
  if (apIds.length === 0) return

  // Refresh the counts. skip_unchanged keeps the snapshot table from bloating when a
  // post has gone quiet, which is most of them most of the time.
  let sampled = 0
  for (let i = 0; i < apIds.length; i += config.ENGAGEMENT_MAX_BATCH) {
    const result = await getEngagement({
      statuses: apIds.slice(i, i + config.ENGAGEMENT_MAX_BATCH),
      snapshot: true,
      skip_unchanged: true,
      prefer: 'rest',
    })
    sampled += result.ok
  }

  logger.debug({ posts: apIds.length, sampled }, 'Breakout fast lane sampled young posts')

  // Same ladder, same state, restricted to what we just re-read. The day window is
  // wide enough to cover the fast-lane hours whatever they are set to.
  await runPostBreakout(notify, {
    apIds,
    days: Math.max(1, Math.ceil(config.BREAKOUT_FAST_LANE_HOURS / 24)),
    lane: 'fast',
  })
}
