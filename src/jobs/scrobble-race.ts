import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { backfillOvertake } from '../lib/race-backfill.js'
import { loadRaceSnapshot, loadRaceState, saveRaceState } from '../lib/race-store.js'
import { activeRaces, type RaceDefinition } from '../lib/races-config.js'
import { publishNtfy, type Notifier, type NtfyTarget } from '../lib/ntfy.js'
import { decideRaceAlert, type RaceAlertKind } from '../lib/scrobble-race.js'

// Moved to src/lib/ntfy.ts, beside the publisher it describes, now that the breakout
// notifier needs it too. Re-exported so existing importers keep working.
export type { Notifier } from '../lib/ntfy.js'

/**
 * Watch every unresolved race in races.json and push an ntfy alert as its gap closes.
 * Chained to syncScrobbles() rather than given its own timer: it reacts to rows the sync
 * just wrote, so an independent interval would only add a window in which it reads stale
 * counts.
 *
 * Each race has its own milestone ladder, its own countdown band, its own ntfy topic and
 * its own state row, and is run inside its own try/catch — a race whose artist was
 * renamed upstream must not stop the race that is in its endgame.
 *
 * `notify` is injectable so the alert decisions can be tested without a broker.
 */
export async function runScrobbleRace(notify: Notifier = publishNtfy): Promise<void> {
  const races = activeRaces()
  if (!races.length) return

  // Refuse to run a race that cannot notify. Tracking state while every push 401s
  // would advance the ladder past milestones nobody was ever told about — the exact
  // silent-failure mode naustet-server ADR 0011 exists to forbid.
  if (!config.NTFY_PASSWORD) {
    logger.error(
      { races: races.map(r => r.id) },
      'Races are configured but NTFY_PASSWORD is empty — refusing to run a race that cannot notify',
    )
    return
  }

  for (const race of races) {
    try {
      await runOneRace(race, notify)
    } catch (e) {
      logger.error({ error: e, race: race.id }, 'Scrobble race failed')
    }
  }
}

function targetFor(race: RaceDefinition): NtfyTarget {
  return {
    url: config.NTFY_URL,
    topic: race.topic,
    user: config.NTFY_USER,
    password: config.NTFY_PASSWORD,
  }
}

export async function runOneRace(
  race: RaceDefinition,
  notify: Notifier = publishNtfy,
): Promise<RaceAlertKind> {
  const snap = await loadRaceSnapshot(race)
  const prev = await loadRaceState(race.id)
  const decision = decideRaceAlert(snap, prev, race.milestones, new Date(), race.endgameGap)

  if (decision.kind === 'seeded') {
    // A race first seen after it was already won gets its result from the archive rather
    // than from where the archive happens to end. decideRaceAlert can only stamp the
    // challenger's LATEST play here; the crossover is usually much earlier.
    if (decision.state.overtakenAt) {
      const crossover = await backfillOvertake(race)
      if (crossover) decision.state.overtakenAt = crossover.at
      logger.info(
        { race: race.id, overtakenAt: decision.state.overtakenAt, track: crossover?.track },
        'Scrobble race seeded as already run; crossover reconstructed from the archive',
      )
    }
    await saveRaceState(race.id, decision.state)
    logger.info(
      {
        race: race.id,
        leaderPlays: snap.leaderPlays,
        challengerPlays: snap.challengerPlays,
        gap: snap.leaderPlays - snap.challengerPlays,
        lastMilestone: decision.state.lastMilestone,
      },
      'Scrobble race seeded, no alerts sent',
    )
    return decision.kind
  }

  if (!decision.message) {
    // Still persist the counts so an unchanged tick short-circuits next time.
    await saveRaceState(race.id, decision.state)
    return decision.kind
  }

  const delivered = await notify(decision.message, targetFor(race))
  if (!delivered) {
    // Persist NOTHING on a failed push — not even the counts. Leaving the row untouched
    // is what makes the next tick see the same movement and retry, so a password drift
    // costs a delayed alert rather than a lost one.
    logger.warn(
      { race: race.id, kind: decision.kind, title: decision.message.title },
      'Scrobble race alert not delivered — state left unchanged so it retries',
    )
    return decision.kind
  }

  await saveRaceState(race.id, decision.state)
  logger.info(
    { race: race.id, kind: decision.kind, gap: snap.leaderPlays - snap.challengerPlays },
    'Scrobble race alert sent',
  )
  return decision.kind
}
