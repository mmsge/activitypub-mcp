import { breakoutEnabled, config, getBreakoutWeights } from '../config.js'
import { logger } from '../lib/logger.js'
import { publishNtfy, type Notifier, type NtfyTarget } from '../lib/ntfy.js'
import {
  breakoutThresholds, breakoutWeightsKey, decideBreakout,
  type BreakoutBaseline,
} from '../lib/post-breakout.js'
import {
  loadBreakoutBaseline, loadBreakoutCandidates, loadBreakoutStates,
  resolveBreakoutActors, saveBreakoutState,
} from '../lib/breakout-store.js'

/**
 * Tell Markus when one of his posts is doing better than his usual — a three-rung
 * ladder (past his own p90, past p99, a personal best) over the engagement counts the
 * sampler already collects. See decision record 0036.
 *
 * This job spends ZERO remote API calls. It is chained to `sampleEngagement()` inside
 * the same timer and reads the rows that sync just wrote, for exactly the reason record
 * 0015 chains the scrobble race to `syncScrobbles()`: an independent interval would
 * only add a window in which it reads stale counts. The fast lane is the one part of
 * the feature that talks to remote instances.
 *
 * `notify` is injectable so the alert decisions can be tested without a broker.
 */

/** The breakout topic, not the race's. Built here and passed explicitly, which is what
 *  publishNtfy's second parameter is for — nothing has to mutate NTFY_TOPIC. */
export function breakoutTarget(): NtfyTarget {
  return {
    url: config.NTFY_URL,
    topic: config.NTFY_TOPIC_BREAKOUT,
    user: config.NTFY_USER,
    password: config.NTFY_PASSWORD,
  }
}

export interface BreakoutRunOptions {
  /** Restrict to these AP ids — the fast lane passes the set it has just re-sampled. */
  apIds?: string[]
  /** How far back to look for candidates. Defaults to BREAKOUT_CANDIDATE_DAYS. */
  days?: number
  /** Label for the log line, so the two lanes are distinguishable in production. */
  lane?: string
}

/**
 * Why the job is refusing to run, or null when it may.
 *
 * Split out so the fast lane and the digest share one answer, and so the admin panel
 * can say *which* switch is off rather than showing an inert feature with no
 * explanation.
 */
export function breakoutBlockedReason(): string | null {
  if (!config.BREAKOUT_ENABLED) return 'BREAKOUT_ENABLED is not set'
  if (!config.NTFY_PASSWORD) return 'NTFY_PASSWORD is empty'
  return null
}

export async function runPostBreakout(
  notify: Notifier = publishNtfy,
  opts: BreakoutRunOptions = {},
): Promise<void> {
  // Refuse to run a ladder that cannot notify. Advancing rungs while every push 401s
  // would spend milestones nobody was ever told about — the silent no-op naustet-server
  // ADR 0011 exists to forbid, and the same guard runScrobbleRace() carries.
  if (!config.BREAKOUT_ENABLED) return
  if (!config.NTFY_PASSWORD) {
    logger.error(
      'BREAKOUT_ENABLED is set but NTFY_PASSWORD is empty — refusing to run a ladder that cannot notify',
    )
    return
  }

  const watched = await resolveBreakoutActors()
  if (watched.length === 0) {
    logger.debug('No watched actors for breakout alerts')
    return
  }

  const weights = getBreakoutWeights()
  const weightsKey = breakoutWeightsKey(weights)
  const target = breakoutTarget()
  const days = opts.days ?? config.BREAKOUT_CANDIDATE_DAYS
  const lane = opts.lane ?? 'hourly'

  let announced = 0
  let seeded = 0
  let failed = 0

  for (const actor of watched) {
    const baseline = await loadBreakoutBaseline(actor.apId, actor.label)

    // Nothing about this account can meaningfully fire. Write nothing at all —
    // seeding here would spend the ladder on posts judged against a bar we don't
    // believe in, and they would then never announce once the account does establish.
    const gate = breakoutThresholds(baseline, {
      minPosts: config.BREAKOUT_MIN_POSTS,
      minScore: config.BREAKOUT_MIN_SCORE,
    })
    if (!gate.established) {
      // `needed` only when more posts would actually help. Reporting "19, needed 20"
      // for an origin that reports no counts at all reads as "nearly there" and sends
      // you looking for posts rather than for the counts — the same misdirection the
      // reason split exists to end, so the log must not reintroduce it.
      logger.debug(
        {
          actor: actor.label,
          reason: gate.reason,
          posts: baseline.n,
          ...(gate.reason === 'too_few_posts' ? { needed: config.BREAKOUT_MIN_POSTS } : {}),
        },
        'Breakout baseline not established, skipping actor',
      )
      continue
    }

    const candidates = await loadBreakoutCandidates({
      actorApId: actor.apId,
      days,
      apIds: opts.apIds,
    })
    if (candidates.length === 0) continue

    const states = await loadBreakoutStates(candidates.map(c => c.apId))

    for (const post of candidates) {
      // Thresholds are per candidate, not per actor: the record rung depends on
      // whether THIS post already holds the record (it must not have to beat itself).
      const t = breakoutThresholds(baseline, {
        minPosts: config.BREAKOUT_MIN_POSTS,
        minScore: config.BREAKOUT_MIN_SCORE,
        candidateApId: post.apId,
      })

      const decision = decideBreakout(post, states.get(post.apId) ?? null, t, baseline, weightsKey)

      if (!decision.message) {
        // 'seeded' / 'reseeded' / 'none' — nothing to say, but the state is worth
        // keeping: an unchanged score is what makes the next tick cheap, and a seeded
        // rung is what stops the whole archive announcing itself later.
        await saveBreakoutState(post.apId, post.actorApId, decision.state)
        if (decision.kind === 'seeded' || decision.kind === 'reseeded') seeded++
        continue
      }

      const delivered = await notify(decision.message, target)
      if (!delivered) {
        // Persist NOTHING for this post — not even the score. Leaving the row untouched
        // is what makes the next tick see the same peak, decide the same rung and retry,
        // so a drifted ntfy password costs a delayed alert rather than a lost one.
        //
        // Per post, deliberately: one failing push must not stall the rest of the run.
        failed++
        logger.warn(
          { post: post.apId, rung: decision.kind, title: decision.message.title },
          'Breakout alert not delivered — state left unchanged so it retries',
        )
        continue
      }

      await saveBreakoutState(post.apId, post.actorApId, decision.state)
      announced++
      logger.info(
        { post: post.apId, actor: actor.label, rung: decision.kind, score: decision.state.peakScore },
        'Breakout alert sent',
      )
    }
  }

  if (announced || seeded || failed) {
    logger.info({ lane, announced, seeded, failed }, 'Breakout check complete')
  }
}

/** Baselines for every watched actor, for the admin panel and the MCP tool. */
export async function loadAllBreakoutBaselines(): Promise<BreakoutBaseline[]> {
  const watched = await resolveBreakoutActors()
  return Promise.all(watched.map(a => loadBreakoutBaseline(a.apId, a.label)))
}
