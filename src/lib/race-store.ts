import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { scrobbles, scrobbleRaceState } from '../db/schema.js'
import { type RacePlay, type RaceSnapshot, type RaceState } from './scrobble-race.js'

/**
 * Database access for the scrobble race: exact per-artist counts, the plays behind
 * each alert, and the watcher's persisted state.
 *
 * Artist matching here is EXACT, unlike the substring `ilike` the get_scrobbles /
 * get_scrobble_stats tools use for their filters. Two reasons, and both are easy to
 * "fix" back by accident:
 *
 *  - A countdown that reaches zero must not have its finish line moved by a stray
 *    "Taylor Swift feat. …" credit that a substring match would fold in.
 *  - `scrobbles_artist_idx` is a plain btree on artist_name, so plain equality is
 *    index-served. Wrapping it in `lower()` would seq-scan the whole table on every
 *    sync tick, forever.
 */

/** All-time play counts for both racers, in one index-served round trip. */
export async function countRacePlays(
  leaderArtist: string,
  challengerArtist: string,
): Promise<{ leaderPlays: number; challengerPlays: number }> {
  const db = getDb()
  const rows = await db
    .select({ artist: scrobbles.artistName, plays: sql<number>`count(*)::int` })
    .from(scrobbles)
    .where(inArray(scrobbles.artistName, [leaderArtist, challengerArtist]))
    .groupBy(scrobbles.artistName)

  // An artist with no plays yields no row at all — don't index into rows[0].
  const at = (name: string) => Number(rows.find(r => r.artist === name)?.plays ?? 0)
  return { leaderPlays: at(leaderArtist), challengerPlays: at(challengerArtist) }
}

/** The artist's most recent scrobble — the track that moved the number. */
export async function latestPlay(artist: string): Promise<RacePlay | null> {
  const db = getDb()
  const [row] = await db
    .select({ track: scrobbles.trackName, url: scrobbles.trackUrl, playedAt: scrobbles.playedAt })
    .from(scrobbles)
    .where(eq(scrobbles.artistName, artist))
    .orderBy(desc(scrobbles.playedAt))
    .limit(1)
  return row ?? null
}

async function firstPlayedAt(artist: string): Promise<Date | null> {
  const db = getDb()
  const [row] = await db
    .select({ first: sql<string | null>`min(${scrobbles.playedAt})` })
    .from(scrobbles)
    .where(eq(scrobbles.artistName, artist))
  return row?.first ? new Date(row.first) : null
}

/** Plays per artist within a trailing window, for the pace estimate. */
export async function countRacePlaysSince(
  leaderArtist: string,
  challengerArtist: string,
  since: Date,
): Promise<{ leaderPlays: number; challengerPlays: number }> {
  const db = getDb()
  const rows = await db
    .select({ artist: scrobbles.artistName, plays: sql<number>`count(*)::int` })
    .from(scrobbles)
    .where(and(
      inArray(scrobbles.artistName, [leaderArtist, challengerArtist]),
      gte(scrobbles.playedAt, since),
    ))
    .groupBy(scrobbles.artistName)

  const at = (name: string) => Number(rows.find(r => r.artist === name)?.plays ?? 0)
  return { leaderPlays: at(leaderArtist), challengerPlays: at(challengerArtist) }
}

/**
 * Net closing rate in plays/day over a trailing window: how fast the challenger is
 * eating into the lead, after the leader's own plays are subtracted. Null when the
 * challenger isn't gaining, so an ETA is never quoted for a race going backwards.
 */
export async function netClosingRate(
  leaderArtist: string,
  challengerArtist: string,
  days = 30,
): Promise<number | null> {
  const since = new Date(Date.now() - days * 86_400_000)
  const recent = await countRacePlaysSince(leaderArtist, challengerArtist, since)
  const net = (recent.challengerPlays - recent.leaderPlays) / days
  return net > 0 ? net : null
}

export async function loadRaceSnapshot(
  leaderArtist: string,
  challengerArtist: string,
): Promise<RaceSnapshot> {
  const [counts, latestLeaderPlay, latestChallengerPlay, challengerFirstPlayedAt, netPerDay] =
    await Promise.all([
      countRacePlays(leaderArtist, challengerArtist),
      latestPlay(leaderArtist),
      latestPlay(challengerArtist),
      firstPlayedAt(challengerArtist),
      netClosingRate(leaderArtist, challengerArtist),
    ])

  return {
    leaderArtist,
    challengerArtist,
    leaderPlays: counts.leaderPlays,
    challengerPlays: counts.challengerPlays,
    latestLeaderPlay,
    latestChallengerPlay,
    challengerFirstPlayedAt,
    netPerDay,
  }
}

export interface StoredRaceState extends RaceState {
  lastNowPlayingKey: string | null
  lastNowPlayingAt: Date | null
}

function pairCondition(leaderArtist: string, challengerArtist: string) {
  return and(
    eq(scrobbleRaceState.leaderArtist, leaderArtist),
    eq(scrobbleRaceState.challengerArtist, challengerArtist),
  )
}

export async function loadRaceState(
  leaderArtist: string,
  challengerArtist: string,
): Promise<StoredRaceState | null> {
  const db = getDb()
  const [row] = await db
    .select({
      leaderPlays: scrobbleRaceState.leaderPlays,
      challengerPlays: scrobbleRaceState.challengerPlays,
      lastMilestone: scrobbleRaceState.lastMilestone,
      lastAnnouncedGap: scrobbleRaceState.lastAnnouncedGap,
      overtakenAt: scrobbleRaceState.overtakenAt,
      lastNowPlayingKey: scrobbleRaceState.lastNowPlayingKey,
      lastNowPlayingAt: scrobbleRaceState.lastNowPlayingAt,
    })
    .from(scrobbleRaceState)
    .where(pairCondition(leaderArtist, challengerArtist))
    .limit(1)
  return row ?? null
}

/**
 * Write the watcher's race state for a pairing. Only the fields present in `values`
 * are written, so the race job and the now-playing job — which touch disjoint columns
 * — can never clobber each other's writes.
 */
export async function saveRaceState(
  leaderArtist: string,
  challengerArtist: string,
  values: Partial<{
    leaderPlays: number
    challengerPlays: number
    lastMilestone: number | null
    lastAnnouncedGap: number | null
    overtakenAt: Date | null
    lastNowPlayingKey: string | null
    lastNowPlayingAt: Date | null
  }>,
): Promise<void> {
  const db = getDb()
  await db
    .insert(scrobbleRaceState)
    .values({
      leaderArtist,
      challengerArtist,
      leaderPlays: values.leaderPlays ?? 0,
      challengerPlays: values.challengerPlays ?? 0,
      lastMilestone: values.lastMilestone ?? null,
      lastAnnouncedGap: values.lastAnnouncedGap ?? null,
      overtakenAt: values.overtakenAt ?? null,
      lastNowPlayingKey: values.lastNowPlayingKey ?? null,
      lastNowPlayingAt: values.lastNowPlayingAt ?? null,
    })
    .onConflictDoUpdate({
      target: [scrobbleRaceState.leaderArtist, scrobbleRaceState.challengerArtist],
      set: { ...values, updatedAt: new Date() },
    })
}
