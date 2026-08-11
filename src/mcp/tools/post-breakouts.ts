import { z } from 'zod'
import { config, getBreakoutWeights } from '../../config.js'
import {
  loadBreakoutBaseline, loadBreakoutCandidates, loadBreakoutStates,
  loadRecentBreakouts, resolveBreakoutActors, type RecentBreakout,
} from '../../lib/breakout-store.js'
import {
  breakoutThresholds, furthestRung, RUNG_ORDER,
  type BreakoutBaseline, type BreakoutPost, type BreakoutRung, type BreakoutState,
} from '../../lib/post-breakout.js'
import { breakoutBlockedReason } from '../../jobs/post-breakout.js'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import type { QueryScope } from './scope.js'

export const getPostBreakoutsSchema = z.object({
  actor_handle: z.string().optional()
    .describe('Narrow to one account (@user@domain or an actor URL). Omit to report every watched account.'),
  days: z.number().int().min(1).max(365).default(30)
    .describe('How far back the `recent` list of already-announced breakouts reaches.'),
  limit: z.number().int().min(1).max(200).default(20)
    .describe('Maximum rows in `recent` and in each account\'s `armed` list.'),
})

export interface ArmedPost {
  status_ap_id: string
  url: string | null
  published_at: Date | null
  visibility: string | null
  score: number
  peak_score: number
  favourites: number
  reblogs: number
  replies: number
  /** The rung this post clears right now. */
  would_fire: BreakoutRung
  /** The furthest rung already announced for it, if any. */
  spent_rung: BreakoutRung | null
  text: string | null
}

/**
 * Which of an actor's candidates would fire right now, and at what rung.
 *
 * Pure, so it is testable without a database — and separate from the job so the tool
 * can answer "why has nothing arrived?" without waiting for a tick. A post appears here
 * only if the rung it clears is further than the one already spent on it, which is
 * exactly the job's own predicate; deriving it a second way is how the two would drift.
 */
export function armedPosts(
  posts: BreakoutPost[],
  states: Map<string, BreakoutState>,
  baseline: BreakoutBaseline,
  opts: { minPosts: number; minScore: number },
  limit: number,
): ArmedPost[] {
  const out: ArmedPost[] = []

  for (const post of posts) {
    const t = breakoutThresholds(baseline, { ...opts, candidateApId: post.apId })
    if (!t.established) break

    const prev = states.get(post.apId) ?? null
    const peak = Math.max(post.peak, post.score, prev?.peakScore ?? 0)
    const crossed = furthestRung(peak, t)
    if (!crossed) continue

    // Already announced at this height or further: spent, not armed.
    if (prev?.rung && RUNG_ORDER[crossed] <= RUNG_ORDER[prev.rung]) continue

    // A post never seen before would SEED silently rather than fire, so listing it as
    // armed would promise a push that is never coming.
    if (!prev) continue

    out.push({
      status_ap_id: post.apId,
      url: post.url,
      published_at: post.publishedAt,
      visibility: post.visibility,
      score: post.score,
      peak_score: peak,
      favourites: post.favourites,
      reblogs: post.reblogs,
      replies: post.replies,
      would_fire: crossed,
      spent_rung: prev.rung,
      text: post.text,
    })
  }

  return out.sort((a, b) => b.peak_score - a.peak_score).slice(0, limit)
}

function recentRow(r: RecentBreakout) {
  return {
    status_ap_id: r.statusApId,
    actor: r.actor,
    url: r.url,
    rung: r.rung,
    fired_at: r.firedAt,
    score: r.score,
    peak_score: r.peakScore,
    /** What it is doing now. Lower than `peak_score` means engagement was withdrawn —
     *  real, and deliberately not hidden. */
    current_score: r.currentScore,
    visibility: r.visibility,
    text: r.text,
  }
}

/**
 * The state of the breakout notifier: where each account's bar sits, what is armed to
 * fire right now, and what has already been announced.
 *
 * Baselines, thresholds and `armed` are computed LIVE from `objects` +
 * `engagement_snapshots`, never from the state table — so this answers correctly even
 * when notifications are unconfigured, and `armed` is the difference between "nothing
 * qualifies" and "the push is failing". That is `get_scrobble_race`'s defining property
 * (record 0015) and it applies here for the same reason.
 *
 * See decision record 0036.
 */
export async function getPostBreakouts(
  input: z.infer<typeof getPostBreakoutsSchema>,
  scope?: QueryScope,
) {
  let watched = await resolveBreakoutActors()

  if (input.actor_handle) {
    const wanted = input.actor_handle.startsWith('http')
      ? input.actor_handle
      : (await resolveActorByHandle(input.actor_handle))?.apId
    if (!wanted) return { error: `Could not resolve actor: ${input.actor_handle}` }
    watched = watched.filter(a => a.apId === wanted)
    if (watched.length === 0) {
      return { error: `Not a watched account: ${input.actor_handle}` }
    }
  }

  const opts = {
    minPosts: config.BREAKOUT_MIN_POSTS,
    minScore: config.BREAKOUT_MIN_SCORE,
  }

  const accounts = await Promise.all(watched.map(async (a) => {
    const baseline = await loadBreakoutBaseline(a.apId, a.label)
    const t = breakoutThresholds(baseline, opts)

    // No point listing armed posts for an account whose bar we do not believe in —
    // nothing can fire there, and saying otherwise would be a promise.
    const candidates = t.established
      ? await loadBreakoutCandidates({
          actorApId: a.apId,
          days: config.BREAKOUT_CANDIDATE_DAYS,
          publicOnly: scope?.publicOnly,
        })
      : []
    const states = await loadBreakoutStates(candidates.map(c => c.apId))

    return {
      actor: a.label,
      actor_ap_id: a.apId,
      baseline: {
        established: t.established,
        reason: t.reason ?? null,
        posts_in_window: baseline.n,
        window_days: baseline.windowDays,
        median: baseline.median,
        p90: baseline.p90,
        p99: baseline.p99,
        best: baseline.best,
        best_status_ap_id: baseline.bestApId,
        second_best: baseline.secondBest,
      },
      // What a post must actually reach — the percentiles after the floor is applied
      // and the rungs are forced apart. These are the numbers the pushes quote.
      thresholds: { p90: t.p90, p99: t.p99, best: t.best },
      tracked_posts: candidates.length,
      armed: armedPosts(candidates, states, baseline, opts, input.limit),
    }
  }))

  const recent = await Promise.all(watched.map(a => loadRecentBreakouts({
    days: input.days,
    limit: input.limit,
    actorApId: a.apId,
    publicOnly: scope?.publicOnly,
  })))

  const w = getBreakoutWeights()

  return {
    enabled: config.BREAKOUT_ENABLED,
    blocked_reason: breakoutBlockedReason(),
    topic: config.NTFY_TOPIC_BREAKOUT,
    weights: { favourites: w.favourites, reblogs: w.reblogs, replies: w.replies },
    floor: config.BREAKOUT_MIN_SCORE,
    min_posts: config.BREAKOUT_MIN_POSTS,
    digest_hour: config.BREAKOUT_DIGEST_HOUR,
    fast_lane_minutes: config.BREAKOUT_FAST_LANE_MINUTES,
    actors: accounts,
    recent: recent
      .flat()
      .sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime())
      .slice(0, input.limit)
      .map(recentRow),
  }
}
