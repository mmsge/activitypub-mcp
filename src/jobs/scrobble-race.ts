import { config, getRaceMilestones, getScrobbleRacers } from '../config.js'
import { logger } from '../lib/logger.js'
import { publishNtfy } from '../lib/ntfy.js'
import { decideRaceAlert } from '../lib/scrobble-race.js'
import { loadRaceSnapshot, loadRaceState, saveRaceState } from '../lib/race-store.js'

export type Notifier = typeof publishNtfy

/**
 * Watch the configured head-to-head scrobble race and push an ntfy alert as the gap
 * closes. Chained to syncScrobbles() rather than given its own timer: it reacts to
 * rows the sync just wrote, so an independent interval would only add a window in
 * which it reads stale counts.
 *
 * `notify` is injectable so the alert decisions can be tested without a broker.
 */
export async function runScrobbleRace(notify: Notifier = publishNtfy): Promise<void> {
  const racers = getScrobbleRacers()
  if (!racers) return

  // Refuse to run a race that cannot notify. Tracking state while every push 401s
  // would advance the ladder past milestones nobody was ever told about — the exact
  // silent-failure mode hetzner-server ADR 0011 exists to forbid.
  if (!config.NTFY_PASSWORD) {
    logger.error(
      { leader: racers.leader, challenger: racers.challenger },
      'RACE_* is configured but NTFY_PASSWORD is empty — refusing to run a race that cannot notify',
    )
    return
  }

  const snap = await loadRaceSnapshot(racers.leader, racers.challenger)
  const prev = await loadRaceState(racers.leader, racers.challenger)
  const decision = decideRaceAlert(
    snap, prev, getRaceMilestones(), new Date(), config.RACE_COUNTDOWN_GAP,
  )

  if (decision.kind === 'seeded') {
    await saveRaceState(racers.leader, racers.challenger, decision.state)
    logger.info(
      {
        leader: racers.leader,
        challenger: racers.challenger,
        leaderPlays: snap.leaderPlays,
        challengerPlays: snap.challengerPlays,
        gap: snap.leaderPlays - snap.challengerPlays,
        lastMilestone: decision.state.lastMilestone,
      },
      'Scrobble race seeded, no alerts sent',
    )
    return
  }

  if (!decision.message) {
    // Still persist the counts so an unchanged tick short-circuits next time.
    await saveRaceState(racers.leader, racers.challenger, decision.state)
    return
  }

  const delivered = await notify(decision.message)
  if (!delivered) {
    // Persist NOTHING on a failed push — not even the counts. Leaving the row untouched
    // is what makes the next tick see the same movement and retry, so a password drift
    // costs a delayed alert rather than a lost one.
    logger.warn(
      { kind: decision.kind, title: decision.message.title },
      'Scrobble race alert not delivered — state left unchanged so it retries',
    )
    return
  }

  await saveRaceState(racers.leader, racers.challenger, decision.state)
  logger.info(
    { kind: decision.kind, gap: snap.leaderPlays - snap.challengerPlays },
    'Scrobble race alert sent',
  )
}
