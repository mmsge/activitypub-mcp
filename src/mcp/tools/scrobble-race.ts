import { z } from 'zod'
import { config, getRaceMilestones, getScrobbleRacers } from '../../config.js'
import {
  countRacePlays, countRacePlaysSince, latestPlay, loadRaceState,
} from '../../lib/race-store.js'
import { tightestCrossed } from '../../lib/scrobble-race.js'

export const getScrobbleRaceSchema = z.object({
  leader: z.string().optional()
    .describe('Exact artist name of the artist in front. Defaults to RACE_LEADER_ARTIST.'),
  challenger: z.string().optional()
    .describe('Exact artist name of the artist catching up. Defaults to RACE_CHALLENGER_ARTIST.'),
  pace_days: z.number().int().min(1).max(3650).default(90)
    .describe('Trailing window (days) used for the plays/day figures and the projected crossover date.'),
})

/**
 * When does the challenger catch up, at the observed net closing rate? Null when the
 * gap is not closing — a projection of Infinity, or a date in the past, is worse than
 * admitting there isn't one.
 */
export function projectCrossover(opts: {
  gap: number
  netPerDay: number
  now?: Date
}): { date: string; days: number } | null {
  const { gap, netPerDay } = opts
  const now = opts.now ?? new Date()
  if (gap < 0) return null // already crossed
  if (gap === 0) return { date: now.toISOString().slice(0, 10), days: 0 }
  if (netPerDay <= 0) return null
  // You can't cross on a fraction of a scrobble, so always round up.
  const days = Math.ceil(gap / netPerDay)
  return { date: new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10), days }
}

export async function getScrobbleRace(input: z.infer<typeof getScrobbleRaceSchema>) {
  const configured = getScrobbleRacers()
  const leader = input.leader ?? configured?.leader
  const challenger = input.challenger ?? configured?.challenger

  if (!leader || !challenger) {
    return { error: 'No race configured — pass leader and challenger, or set RACE_LEADER_ARTIST and RACE_CHALLENGER_ARTIST.' }
  }

  const since = new Date(Date.now() - input.pace_days * 86_400_000)
  const [totals, recent, leaderLast, challengerLast, state] = await Promise.all([
    countRacePlays(leader, challenger),
    countRacePlaysSince(leader, challenger, since),
    latestPlay(leader),
    latestPlay(challenger),
    // The stored state belongs to the configured pairing only; an ad-hoc race between
    // two other artists has no notification state of its own.
    configured && leader === configured.leader && challenger === configured.challenger
      ? loadRaceState(leader, challenger)
      : Promise.resolve(null),
  ])

  const gap = totals.leaderPlays - totals.challengerPlays
  const leaderPerDay = recent.leaderPlays / input.pace_days
  const challengerPerDay = recent.challengerPlays / input.pace_days
  const netPerDay = challengerPerDay - leaderPerDay
  const crossover = projectCrossover({ gap, netPerDay })

  const milestones = getRaceMilestones()
  const nextMilestone = milestones.filter(
    m => m < (state?.lastMilestone ?? Infinity) && m < gap,
  )[0] ?? null

  return {
    leader: {
      artist: leader,
      plays: totals.leaderPlays,
      last_played_at: leaderLast?.playedAt ?? null,
      last_track: leaderLast?.track ?? null,
    },
    challenger: {
      artist: challenger,
      plays: totals.challengerPlays,
      last_played_at: challengerLast?.playedAt ?? null,
      last_track: challengerLast?.track ?? null,
    },
    gap,
    leader_ahead: gap > 0,
    plays_to_level: Math.max(0, gap),
    plays_to_overtake: Math.max(0, gap + 1),
    pace: {
      window_days: input.pace_days,
      leader_plays_per_day: Number(leaderPerDay.toFixed(2)),
      challenger_plays_per_day: Number(challengerPerDay.toFixed(2)),
      net_closing_per_day: Number(netPerDay.toFixed(2)),
      projected_crossover_date: crossover?.date ?? null,
      projected_days: crossover?.days ?? null,
    },
    notifications: state
      ? {
          armed: Boolean(config.NTFY_PASSWORD),
          topic: config.NTFY_TOPIC,
          last_milestone: state.lastMilestone,
          next_milestone: nextMilestone,
          // The countdown band, and whether the race has ever been inside it. Armed is
          // read from the persisted latch rather than compared live against the gap:
          // the leader scrobbling twice must not report a race that reached its
          // endgame as no longer in one. See decision record 0022.
          endgame_gap: config.RACE_COUNTDOWN_GAP,
          endgame_armed: Boolean(state.endgameArmedAt),
          nowplaying_gap: config.RACE_NOWPLAYING_GAP,
          overtaken_at: state.overtakenAt,
        }
      : {
          armed: false,
          topic: null,
          last_milestone: tightestCrossed(gap, milestones),
          next_milestone: nextMilestone,
          endgame_gap: config.RACE_COUNTDOWN_GAP,
          // No stored state for this pairing, so nothing has ever observed it armed.
          endgame_armed: false,
          nowplaying_gap: config.RACE_NOWPLAYING_GAP,
          overtaken_at: null,
        },
  }
}
