import { logger } from './logger.js'
import { loadCrossoverRows, type CrossoverRow } from './race-store.js'
import { type RaceDefinition } from './races-config.js'

/**
 * Reconstruct when the challenger took the lead, from the plays already in the archive.
 *
 * The notifier only knows a race changed hands if it was watching at the time. A race
 * added to races.json after its crossover — which is the normal case, since a race is
 * usually noticed because it is close — would otherwise seed as "already run" with no
 * idea when, and `decideRaceAlert` would stamp the challenger's LATEST play, which is
 * not the crossover at all: it is wherever the archive happens to end.
 *
 * So walk the plays instead. The answer is in the data.
 */

export interface Crossover {
  at: Date
  track: string
  url: string | null
  leaderPlays: number
  challengerPlays: number
}

/**
 * The first play after which the challenger is strictly ahead, walking oldest first.
 *
 * STRICTLY ahead, matching `decideRaceAlert`'s `gap < 0`: a dead heat is not a win
 * (decision record 0016), and a backfill that disagreed with the live decision would
 * write a result the notifier would never have produced.
 *
 * Only a challenger play can push the count over, so the row returned is always a
 * challenger play. If the lead changes hands more than once, the FIRST crossing is the
 * answer — the same rule as `overtakenAt`, which latches and never re-arms.
 */
export function findCrossover(rows: CrossoverRow[]): Crossover | null {
  let leaderPlays = 0
  let challengerPlays = 0
  for (const row of rows) {
    if (row.side === 'leader') leaderPlays++
    else challengerPlays++
    if (challengerPlays > leaderPlays) {
      return { at: row.playedAt, track: row.track, url: row.url, leaderPlays, challengerPlays }
    }
  }
  return null
}

/** How many rows a single backfill will happily walk before it is worth saying so. */
const LOUD_ROW_COUNT = 200_000

/**
 * Load both sides' plays and find the crossover. Two index-ordered scans of a few
 * columns — about 20,000 rows for the artist race that motivated this — run once per
 * race, only when it is first seen and the challenger is already ahead. Cheap at that
 * bound; the warning below is what makes it visible if a future entity matches half the
 * archive instead.
 */
export async function backfillOvertake(race: RaceDefinition): Promise<Crossover | null> {
  const rows = await loadCrossoverRows(race)
  if (rows.length > LOUD_ROW_COUNT) {
    logger.warn(
      { race: race.id, rows: rows.length },
      'Crossover backfill walked an unexpectedly large number of plays',
    )
  }
  return findCrossover(rows)
}
