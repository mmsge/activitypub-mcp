import { sql } from 'drizzle-orm'
import { getScrobbleRacers } from '../config.js'
import { getDb } from '../db/client.js'
import { logger } from '../lib/logger.js'
import {
  summarise,
  DURATION_PERCENTILE,
  MIN_DURATION_OBSERVATIONS,
  MIN_TRUSTED_ESTIMATE_SECONDS,
  SESSION_CEILING_SECONDS,
  type AuditSummary,
  type GapGroup,
} from '../lib/scrobble-audit.js'

/**
 * Measure how much of the scrobble history is a play that was cut short — a track
 * started and then skipped or restarted, which a scrobbler that submits at track start
 * turns into a genuine Last.fm scrobble.
 *
 * **Read-only, and deliberately so.** It runs inside a READ ONLY transaction: nothing
 * here can write even by accident. It changes no count anywhere in the app; acting on
 * what it finds means changing the scrobbler, not this store. Decision record 0029.
 *
 *   npm run scrobble-audit
 */

export interface AuditEvidence {
  artist: string
  track: string
  playedAt: Date
  playSeconds: number
  /** True when the very next scrobble is the same track again — a restart, which only a
   *  scrobble submitted at track start can produce. The clearest single tell. */
  sameTrackNext: boolean
}

export interface ScrobbleAuditResult extends AuditSummary {
  params: {
    ceilingSeconds: number
    minDurationObservations: number
    percentile: number
    leader: string
    challenger: string
  }
  totalPlays: number
  /** Sub-60-second plays whose next scrobble repeats the same track. */
  sameTrackRestarts: number
  evidence: AuditEvidence[]
}

export interface ScrobbleAuditOptions {
  leader?: string
  challenger?: string
  ceilingSeconds?: number
  minDurationObservations?: number
  evidenceLimit?: number
}

/**
 * Every interpolated number is cast. `${x}` becomes an untyped bind parameter, and
 * postgres-js cannot infer a type for it inside `percentile_disc($1)` or a `BETWEEN`,
 * so an uncast version fails with "could not determine data type of parameter".
 */
const gapsCte = (ceiling: number) => sql`
  gaps AS (
    SELECT
      s.artist_name,
      s.track_name,
      s.played_at,
      lead(s.track_name)  OVER w AS next_track,
      lead(s.artist_name) OVER w AS next_artist,
      -- Clamped rather than raw: everything above the ceiling classifies identically
      -- (unbounded), and clamping collapses a long tail of distinct values that would
      -- otherwise defeat the GROUP BY keeping this result set small.
      least(
        extract(epoch FROM (lead(s.played_at) OVER w - s.played_at))::int,
        ${ceiling}::int + 1
      ) AS play_seconds
    FROM scrobbles s
    -- Tie-break on id: the dedupe key allows two different tracks on the same second,
    -- and without it lead() is nondeterministic — the same run could differ twice.
    WINDOW w AS (ORDER BY s.played_at, s.id)
  )`

export async function auditScrobbles(
  opts: ScrobbleAuditOptions = {},
): Promise<ScrobbleAuditResult> {
  const configured = getScrobbleRacers()
  const leader = opts.leader ?? configured?.leader
  const challenger = opts.challenger ?? configured?.challenger
  if (!leader || !challenger) {
    throw new Error(
      'No race configured — pass leader/challenger, or set RACE_LEADER_ARTIST and RACE_CHALLENGER_ARTIST.',
    )
  }

  const ceiling = opts.ceilingSeconds ?? SESSION_CEILING_SECONDS
  const minObs = opts.minDurationObservations ?? MIN_DURATION_OBSERVATIONS
  const evidenceLimit = opts.evidenceLimit ?? 25
  const db = getDb()

  return await db.transaction(async (tx) => {
    // Belt and braces. The audit must not be able to write, and one snapshot is what
    // lets the per-year series and the corrected gap be quoted in the same breath.
    await tx.execute(sql`SET TRANSACTION READ ONLY`)

    const groups = (await tx.execute(sql`
      WITH ${gapsCte(ceiling)},
      est AS (
        SELECT
          g.artist_name,
          g.track_name,
          count(*) FILTER (WHERE g.play_seconds BETWEEN 0 AND ${ceiling}::int)::int AS est_obs,
          percentile_disc(${DURATION_PERCENTILE}::float8) WITHIN GROUP (ORDER BY g.play_seconds)
            FILTER (WHERE g.play_seconds BETWEEN 0 AND ${ceiling}::int) AS est_seconds
        FROM gaps g
        GROUP BY g.artist_name, g.track_name
      )
      SELECT
        g.artist_name,
        extract(year FROM (g.played_at AT TIME ZONE 'Europe/Oslo'))::int AS year,
        g.play_seconds,
        CASE
          WHEN e.est_obs >= ${minObs}::int
           AND e.est_seconds BETWEEN ${MIN_TRUSTED_ESTIMATE_SECONDS}::int AND ${ceiling}::int
          THEN e.est_seconds::int
        END AS est_seconds,
        count(*)::int AS plays
      FROM gaps g
      JOIN est e ON e.artist_name = g.artist_name AND e.track_name = g.track_name
      GROUP BY 1, 2, 3, 4
      ORDER BY 1, 2, 3
    `)) as unknown as Array<{
      artist_name: string
      year: number
      play_seconds: number | null
      est_seconds: number | null
      plays: number
    }>

    const evidenceRows = (await tx.execute(sql`
      WITH ${gapsCte(ceiling)}
      SELECT g.artist_name, g.track_name, g.played_at, g.play_seconds,
             (g.next_artist = g.artist_name AND g.next_track = g.track_name) AS same_track_next
      FROM gaps g
      WHERE g.play_seconds BETWEEN 0 AND 60
      ORDER BY g.play_seconds ASC, g.played_at DESC
      LIMIT ${evidenceLimit}::int
    `)) as unknown as Array<{
      artist_name: string
      track_name: string
      // Raw SQL bypasses drizzle's column mapping, so timestamptz arrives as a string.
      played_at: string | Date
      play_seconds: number
      same_track_next: boolean
    }>

    const [restarts] = (await tx.execute(sql`
      WITH ${gapsCte(ceiling)}
      SELECT count(*)::int AS n
      FROM gaps g
      WHERE g.play_seconds BETWEEN 0 AND 60
        AND g.next_artist = g.artist_name
        AND g.next_track = g.track_name
    `)) as unknown as Array<{ n: number }>

    const gapGroups: GapGroup[] = groups.map(r => ({
      artistName: r.artist_name,
      year: r.year,
      playSeconds: r.play_seconds,
      estSeconds: r.est_seconds,
      plays: r.plays,
    }))

    const result: ScrobbleAuditResult = {
      ...summarise(gapGroups, { leader, challenger, ceilingSeconds: ceiling }),
      params: {
        ceilingSeconds: ceiling,
        minDurationObservations: minObs,
        percentile: DURATION_PERCENTILE,
        leader,
        challenger,
      },
      totalPlays: gapGroups.reduce((n, g) => n + g.plays, 0),
      sameTrackRestarts: restarts?.n ?? 0,
      evidence: evidenceRows.map(r => ({
        artist: r.artist_name,
        track: r.track_name,
        playedAt: new Date(r.played_at),
        playSeconds: r.play_seconds,
        sameTrackNext: r.same_track_next,
      })),
    }

    logger.info(
      { totalPlays: result.totalPlays, sameTrackRestarts: result.sameTrackRestarts },
      'Scrobble audit complete (read-only; nothing was changed)',
    )
    return result
  })
}
