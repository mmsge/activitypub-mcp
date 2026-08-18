import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { scrobbles, raceState } from '../db/schema.js'
import { entityCondition, type RaceEntity } from './race-entity.js'
import { type RaceDefinition } from './races-config.js'
import { type RacePlay, type RaceSnapshot, type RaceState } from './scrobble-race.js'

/**
 * Database access for the scrobble race: exact per-entity counts, the plays behind each
 * alert, and the watcher's persisted state.
 *
 * Matching lives in race-entity.ts and is EXACT, unlike the substring `ilike` the
 * get_scrobbles / get_scrobble_stats tools use for their filters. The reasons are there;
 * the short version is that a countdown reaching zero must not have its finish line
 * moved by a "feat. …" credit, and that `lower()` would seq-scan the whole table on
 * every sync tick.
 */

/**
 * Both sides' play counts in one round trip.
 *
 * Two aggregate FILTERs over one OR'd scan rather than a GROUP BY: a side is now an
 * entity, not a name, so there is nothing to group on. It also always returns exactly
 * one row — a side with no plays reads as 0 instead of being absent, which is what the
 * old `rows.find(...) ?? 0` dance existed to paper over.
 */
export function raceCountQuery(leader: RaceEntity, challenger: RaceEntity, since?: Date) {
  const l = entityCondition(leader)
  const c = entityCondition(challenger)
  const scope = or(l, c)!
  return getDb()
    .select({
      leaderPlays: sql<number>`count(*) filter (where ${l})::int`,
      challengerPlays: sql<number>`count(*) filter (where ${c})::int`,
    })
    .from(scrobbles)
    .where(since ? and(scope, gte(scrobbles.playedAt, since)) : scope)
}

async function counts(
  leader: RaceEntity,
  challenger: RaceEntity,
  since?: Date,
): Promise<{ leaderPlays: number; challengerPlays: number }> {
  const [row] = await raceCountQuery(leader, challenger, since)
  return {
    leaderPlays: Number(row?.leaderPlays ?? 0),
    challengerPlays: Number(row?.challengerPlays ?? 0),
  }
}

/** All-time play counts for both sides. */
export async function countRacePlays(leader: RaceEntity, challenger: RaceEntity) {
  return counts(leader, challenger)
}

/** Plays per side within a trailing window, for the pace estimate. */
export async function countRacePlaysSince(
  leader: RaceEntity,
  challenger: RaceEntity,
  since: Date,
) {
  return counts(leader, challenger, since)
}

/** The side's most recent matching scrobble — the track that moved the number. For an
 *  album race that is the last track played FROM that album, not the artist's last play. */
export async function latestPlay(entity: RaceEntity): Promise<RacePlay | null> {
  const db = getDb()
  const [row] = await db
    .select({ track: scrobbles.trackName, url: scrobbles.trackUrl, playedAt: scrobbles.playedAt })
    .from(scrobbles)
    .where(entityCondition(entity))
    .orderBy(desc(scrobbles.playedAt))
    .limit(1)
  return row ?? null
}

async function firstPlayedAt(entity: RaceEntity): Promise<Date | null> {
  const db = getDb()
  const [row] = await db
    .select({ first: sql<string | null>`min(${scrobbles.playedAt})` })
    .from(scrobbles)
    .where(entityCondition(entity))
  return row?.first ? new Date(row.first) : null
}

/**
 * Net closing rate in plays/day over a trailing window: how fast the challenger is
 * eating into the lead, after the leader's own plays are subtracted. Null when the
 * challenger isn't gaining, so an ETA is never quoted for a race going backwards.
 */
export async function netClosingRate(
  leader: RaceEntity,
  challenger: RaceEntity,
  days = 30,
): Promise<number | null> {
  const since = new Date(Date.now() - days * 86_400_000)
  const recent = await countRacePlaysSince(leader, challenger, since)
  const net = (recent.challengerPlays - recent.leaderPlays) / days
  return net > 0 ? net : null
}

export async function loadRaceSnapshot(race: RaceDefinition): Promise<RaceSnapshot> {
  const leader = race.leader.entity
  const challenger = race.challenger.entity
  const [totals, latestLeaderPlay, latestChallengerPlay, challengerFirstPlayedAt, netPerDay] =
    await Promise.all([
      countRacePlays(leader, challenger),
      latestPlay(leader),
      latestPlay(challenger),
      firstPlayedAt(challenger),
      netClosingRate(leader, challenger),
    ])

  return {
    leaderLabel: race.leader.label,
    challengerLabel: race.challenger.label,
    leaderPlays: totals.leaderPlays,
    challengerPlays: totals.challengerPlays,
    latestLeaderPlay,
    latestChallengerPlay,
    challengerFirstPlayedAt,
    netPerDay,
  }
}

/** One play, tagged with the side it belongs to, for the crossover walk. */
export interface CrossoverRow {
  side: 'leader' | 'challenger'
  playedAt: Date
  track: string
  url: string | null
}

/**
 * Every play by either side, oldest first, for `findCrossover`.
 *
 * The ordering is four columns deep on purpose. Ties on `played_at` are real here — the
 * same song three times inside a minute is ordinary listening, and `scrobbles_dedupe_idx`
 * is `(played_at, track_name, artist_name)` — so without a total order the reconstructed
 * crossover timestamp would differ between runs.
 */
export async function loadCrossoverRows(race: RaceDefinition): Promise<CrossoverRow[]> {
  const db = getDb()
  const c = entityCondition(race.challenger.entity)
  const rows = await db
    .select({
      side: sql<'leader' | 'challenger'>`case when ${c} then 'challenger' else 'leader' end`,
      playedAt: scrobbles.playedAt,
      track: scrobbles.trackName,
      url: scrobbles.trackUrl,
    })
    .from(scrobbles)
    .where(or(entityCondition(race.leader.entity), c))
    .orderBy(asc(scrobbles.playedAt), asc(scrobbles.uts), asc(scrobbles.artistName), asc(scrobbles.trackName))
  return rows
}

export interface StoredRaceState extends RaceState {
  lastNowPlayingKey: string | null
  lastNowPlayingAt: Date | null
}

const stateColumns = {
  leaderPlays: raceState.leaderPlays,
  challengerPlays: raceState.challengerPlays,
  lastMilestone: raceState.lastMilestone,
  lastAnnouncedGap: raceState.lastAnnouncedGap,
  endgameArmedAt: raceState.endgameArmedAt,
  overtakenAt: raceState.overtakenAt,
  lastNowPlayingKey: raceState.lastNowPlayingKey,
  lastNowPlayingAt: raceState.lastNowPlayingAt,
}

export async function loadRaceState(raceId: string): Promise<StoredRaceState | null> {
  if (!raceId) return null // ad-hoc race: no id, so no state of its own
  const db = getDb()
  const [row] = await db
    .select(stateColumns)
    .from(raceState)
    .where(eq(raceState.raceId, raceId))
    .limit(1)
  return row ?? null
}

/** State for several races in one read, so the jobs that loop don't do N round trips. */
export async function loadRaceStates(raceIds: string[]): Promise<Map<string, StoredRaceState>> {
  const ids = raceIds.filter(Boolean)
  if (!ids.length) return new Map()
  const db = getDb()
  const rows = await db
    .select({ raceId: raceState.raceId, ...stateColumns })
    .from(raceState)
    .where(inArray(raceState.raceId, ids))
  return new Map(rows.map(({ raceId: id, ...rest }) => [id, rest]))
}

/**
 * Write the watcher's state for a race. Only the fields present in `values` are written,
 * so the race job and the now-playing job — which touch disjoint columns — can never
 * clobber each other's writes. That mattered with one race and matters more with
 * several, because both jobs now loop.
 */
export async function saveRaceState(
  raceId: string,
  values: Partial<{
    leaderPlays: number
    challengerPlays: number
    lastMilestone: number | null
    lastAnnouncedGap: number | null
    endgameArmedAt: Date | null
    overtakenAt: Date | null
    lastNowPlayingKey: string | null
    lastNowPlayingAt: Date | null
  }>,
): Promise<void> {
  const db = getDb()
  await db
    .insert(raceState)
    .values({
      raceId,
      leaderPlays: values.leaderPlays ?? 0,
      challengerPlays: values.challengerPlays ?? 0,
      lastMilestone: values.lastMilestone ?? null,
      lastAnnouncedGap: values.lastAnnouncedGap ?? null,
      endgameArmedAt: values.endgameArmedAt ?? null,
      overtakenAt: values.overtakenAt ?? null,
      lastNowPlayingKey: values.lastNowPlayingKey ?? null,
      lastNowPlayingAt: values.lastNowPlayingAt ?? null,
    })
    .onConflictDoUpdate({
      target: [raceState.raceId],
      set: { ...values, updatedAt: new Date() },
    })
}
